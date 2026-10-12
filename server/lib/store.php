<?php
// The desktop's file store (phase 2; one per person since accounts arrived). The browser runs the desktop's own file-system logic (src/fs) and hands this server
// opaque records: a key (a random ID, or "/" for the root) and a blob. Directory listings, inodes and file
// contents are all such blobs; the server never sees a file name in the clear, which is what phase 4's
// encryption in the browser needs.
//
// Every record carries a version: 32 hex characters written in front of its blob. A commit names the version
// it last read for each key it changes, and the whole commit is refused if any of them has moved on, so two
// browsers can never silently overwrite each other's changes.
//
// All or nothing, for readers too: a commit moves its records into place holding the store's lock exclusively, and
// every read holds it shared, so a read sees a whole commit or none of it. A commit cut off part-way (a killed process)
// left a journal of the moves still to make; whoever comes next, reading or writing, finishes it first. The totals
// (.usage, .count) are in the journal too, so they never disagree with the records after a cut-off commit.
// tools/store-check.php compares them with the records, read-only unless asked to repair.
declare(strict_types=1);

const STORE_KEY_RE = '/^(\/|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/D';
const STORE_VERSION_LEN = 32;
const STORE_OP_PUT = 1;
const STORE_OP_DEL = 2;
// Writes nothing: the commit goes ahead only if that record is still at the version given (a folder a save went through).
const STORE_OP_CHECK = 3;
// Far above any real change (a folder copy of thousands of files), far below a flood of empty records meant to use up
// the disk's file slots, which the byte quota alone would not stop.
const STORE_MAX_OPS = 10000;

final class StoreConflict extends RuntimeException
{
    /** @param string[] $keys */
    public function __construct(public readonly array $keys)
    {
        parent::__construct('changed elsewhere: ' . implode(', ', $keys));
    }
}

/**
 * A save from a page that still thinks the files are not encrypted (or still are), after encryption was switched on or
 * off in another window or on another device. Nothing was written: the page catches up, then saves again.
 */
final class StoreVaultChanged extends RuntimeException
{
    public function __construct()
    {
        parent::__construct('encryption changed');
    }
}

/** A save that would take a person past the number of files (and folders) their account may hold. */
final class StoreFileLimit extends RuntimeException
{
    public function __construct(public readonly int $count, public readonly int $max)
    {
        parent::__construct('too many files');
    }
}

/** A save that would take a person past the storage their account allows. */
final class StoreQuota extends RuntimeException
{
    public function __construct(public readonly int $used, public readonly int $quota, public readonly int $adding)
    {
        parent::__construct('over quota');
    }
}

/**
 * What one record counts against the quota: its bytes, but at least STORE_MIN_CHARGE. Empty or tiny records would
 * otherwise cost nothing, and a flood of them fills the host's file slots (every hosting account has a file limit).
 */
const STORE_MIN_CHARGE = 16384;
function store_charge(int $bytes): int
{
    return $bytes <= 0 ? 0 : max(STORE_MIN_CHARGE, $bytes);
}

/** Bytes the store counts as held: kept in .usage, worked out once by adding up the records when that file is missing. */
function store_usage(string $dataDir): int
{
    $raw = @file_get_contents($dataDir . '/.usage');
    if ($raw !== false && preg_match('/^\d+$/', $raw)) {
        return (int) $raw;
    }
    $total = 0;
    if (is_dir($dataDir . '/objects')) {
        $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dataDir . '/objects', FilesystemIterator::SKIP_DOTS));
        foreach ($it as $file) {
            if ($file->isFile() && !str_ends_with($file->getFilename(), '.tmp')) {
                $total += store_charge($file->getSize());
            }
        }
    }

    return $total;
}

/**
 * How many records (files and folders) the store holds: kept in .count, worked out once by counting when that file is
 * missing. Every hosting account has a limit on files, so each person has one too (max_files in the config).
 */
function store_count(string $dataDir): int
{
    $raw = @file_get_contents($dataDir . '/.count');
    if ($raw !== false && preg_match('/^\d+$/D', $raw)) {
        return (int) $raw;
    }
    $total = 0;
    if (is_dir($dataDir . '/objects')) {
        $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dataDir . '/objects', FilesystemIterator::SKIP_DOTS));
        foreach ($it as $file) {
            if ($file->isFile() && !str_ends_with($file->getFilename(), '.tmp')) {
                $total++;
            }
        }
    }

    return $total;
}

// How the browser marks a sealed (encrypted) record: src/auth/vault.ts MAGIC, then a 12-byte nonce and at least the 16-byte
// tag. OLD is the marker earlier versions wrote. The server cannot open a record, but it can tell sealed from plain.
const STORE_SEAL_MAGIC = "\x00MYIENC\x01";
const STORE_SEAL_OLD = "\x00ALNENC\x01";
const STORE_SEAL_MIN = 8 + 12 + 16;

function store_is_sealed(string $data): bool
{
    return strlen($data) >= STORE_SEAL_MIN && (str_starts_with($data, STORE_SEAL_MAGIC) || str_starts_with($data, STORE_SEAL_OLD));
}

/** Whether records must be written sealed in this encryption state (while turning on, and once on). */
function store_sealing(string $state): bool
{
    return $state === 'on' || $state === 'migrating-on';
}

/**
 * How many records are not yet the kind wanted (sealed, or plain). Run under the store lock before encryption is said to
 * be on or off, so a file saved by another page during the change cannot be left behind in the wrong kind.
 */
function store_count_unconverted(string $dataDir, bool $sealed): int
{
    $wrong = 0;
    foreach (glob($dataDir . '/objects/*/*') ?: [] as $file) {
        if (str_ends_with($file, '.tmp') || !store_valid_key(($n = basename($file)) === 'root' ? '/' : $n)) {
            continue;
        }
        $fh = @fopen($file, 'rb');
        if ($fh === false) {
            throw new RuntimeException('a record could not be read while checking the encryption');
        }
        $head = (string) fread($fh, STORE_VERSION_LEN + STORE_SEAL_MIN);
        fclose($fh);
        if (store_is_sealed(substr($head, STORE_VERSION_LEN)) !== $sealed) {
            $wrong++;
        }
    }

    return $wrong;
}

/**
 * Runs $fn holding the store's lock shared: no commit is moving records into place meanwhile (any number of readers at
 * once). A commit cut off part-way is finished first. A store with no folder yet has nothing to wait for.
 */
function store_reading(string $dataDir, callable $fn, bool $finish = true): mixed
{
    if (!is_dir($dataDir)) {
        return $fn();
    }
    $lock = @fopen($dataDir . '/.lock', 'c');
    if ($lock === false || !flock($lock, LOCK_SH)) {
        throw new RuntimeException('the store lock cannot be taken');
    }
    try {
        // $finish false: look only (tools/store-check.php without --repair changes nothing, a cut-off commit included).
        if ($finish && is_file($dataDir . '/.journal')) {
            // Finishing it needs the lock to itself: let go, take it whole, finish, and go back to sharing it.
            flock($lock, LOCK_UN);
            flock($lock, LOCK_EX);
            store_apply_journal($dataDir);
            flock($lock, LOCK_UN);
            flock($lock, LOCK_SH);
        }

        return $fn();
    } finally {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
}

/** Runs $fn holding the store's lock, so no commit is part-way through while it runs. */
function store_locked(string $dataDir, callable $fn): mixed
{
    if (!is_dir($dataDir) && !@mkdir($dataDir, 0700, true) && !is_dir($dataDir)) {
        throw new RuntimeException('the data folder cannot be created');
    }
    $lock = fopen($dataDir . '/.lock', 'c');
    if ($lock === false || !flock($lock, LOCK_EX)) {
        throw new RuntimeException('the store lock cannot be taken');
    }
    try {
        store_apply_journal($dataDir);

        return $fn();
    } finally {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
}

/** Every key in a store (for the browser to rewrite each record when encryption is turned on or off). */
function store_list_keys(string $dataDir): array
{
    $keys = [];
    foreach (glob($dataDir . '/objects/*/*') ?: [] as $file) {
        $name = basename($file);
        if (str_ends_with($name, '.tmp')) {
            continue;
        }
        $key = $name === 'root' ? '/' : $name;
        if (store_valid_key($key)) {
            $keys[] = $key;
        }
    }
    sort($keys);

    return $keys;
}

function store_valid_key(string $key): bool
{
    return preg_match(STORE_KEY_RE, $key) === 1;
}

function store_path(string $dataDir, string $key): string
{
    if (!store_valid_key($key)) {
        throw new InvalidArgumentException('not a store key');
    }
    $name = $key === '/' ? 'root' : $key;

    return $dataDir . '/objects/' . substr($name, 0, 2) . '/' . $name;
}

/** @return array{0: string, 1: string}|null [version, data], or null when the key does not exist */
function store_get(string $dataDir, string $key): ?array
{
    $path = store_path($dataDir, $key);
    $raw = @file_get_contents($path);
    if ($raw === false) {
        return null;
    }
    if (strlen($raw) < STORE_VERSION_LEN) {
        throw new RuntimeException("record $key is damaged (shorter than its version stamp)");
    }

    return [substr($raw, 0, STORE_VERSION_LEN), substr($raw, STORE_VERSION_LEN)];
}

function store_version_of(string $dataDir, string $key): string
{
    $fh = @fopen(store_path($dataDir, $key), 'rb');
    if ($fh === false) {
        return '';
    }
    $version = (string) fread($fh, STORE_VERSION_LEN);
    fclose($fh);

    return $version;
}

/**
 * Parses a commit body: repeated [u8 op][u16 key length][key][u8 expected-version length][expected version]
 * and, for a put, [u32 data length][data]. Little-endian. An expected version of "*" means "whatever is there";
 * an empty one means "must not exist yet".
 *
 * @return list<array{op: int, key: string, expect: string, data: string}>
 */
function store_parse_commit(string $body): array
{
    $ops = [];
    $at = 0;
    $len = strlen($body);
    $take = static function (int $n) use ($body, $len, &$at): string {
        if ($n < 0 || $at + $n > $len) {
            throw new InvalidArgumentException('commit body is cut short');
        }
        $chunk = substr($body, $at, $n);
        $at += $n;

        return $chunk;
    };
    while ($at < $len) {
        $op = ord($take(1));
        $key = $take(unpack('v', $take(2))[1]);
        $expect = $take(ord($take(1)));
        if (!store_valid_key($key)) {
            throw new InvalidArgumentException('commit names something that is not a store key');
        }
        if ($expect !== '*' && $expect !== '' && !preg_match('/^[0-9a-f]{32}$/', $expect)) {
            throw new InvalidArgumentException('commit carries a malformed version');
        }
        if ($op === STORE_OP_PUT) {
            $data = $take(unpack('V', $take(4))[1]);
        } elseif ($op === STORE_OP_DEL || $op === STORE_OP_CHECK) {
            $data = '';
        } else {
            throw new InvalidArgumentException('commit has an unknown operation');
        }
        $ops[] = ['op' => $op, 'key' => $key, 'expect' => $expect, 'data' => $data];
        if (count($ops) > STORE_MAX_OPS) {
            throw new InvalidArgumentException('it changes more than ' . number_format(STORE_MAX_OPS) . ' files at once; do it in smaller parts, a few folders at a time');
        }
    }

    return $ops;
}

/**
 * Applies a commit all-or-nothing. Each new record is first written to a temporary file; then, under the store's lock,
 * every expected version is checked and the files are renamed into place, so a reader never sees half a record or half
 * a commit. $check (if given) sees the collapsed operations under the lock and may refuse them by throwing.
 *
 * @param list<array{op: int, key: string, expect: string, data: string}> $ops
 * @return array<string, string> the new version of every key the commit wrote ("" for a deleted key)
 */
function store_commit(string $dataDir, array $ops, int $quotaBytes = 0, int $maxFiles = 0, ?callable $check = null): array
{
    if (!is_dir($dataDir . '/objects') && !@mkdir($dataDir . '/objects', 0700, true) && !is_dir($dataDir . '/objects')) {
        throw new RuntimeException('the data folder cannot be created');
    }
    // The last operation on a key wins, as it would inside the browser's own transaction, checked against
    // the version the first one expected (the version the browser read before the transaction began).
    $final = [];
    foreach ($ops as $o) {
        $prev = $final[$o['key']] ?? null;
        if ($prev !== null && $o['op'] === STORE_OP_CHECK) {
            continue; // a check never takes the place of a write to the same key
        }
        $final[$o['key']] = $prev === null ? $o : array_merge($o, ['expect' => $prev['expect']]);
    }
    // Every new record is written to a temporary file before the lock is taken, so readers wait only for the moves.
    $versions = [];
    $renames = [];
    $temps = [];
    $journaled = false;
    try {
        foreach ($final as $key => $o) {
            $path = store_path($dataDir, $key);
            if ($o['op'] === STORE_OP_CHECK) {
                continue;
            }
            if ($o['op'] === STORE_OP_DEL) {
                $renames[] = [null, $path];
                $versions[$key] = '';
                continue;
            }
            $dir = dirname($path);
            if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) {
                throw new RuntimeException('a data sub-folder cannot be created');
            }
            $version = bin2hex(random_bytes(16));
            $tmp = $path . '.' . bin2hex(random_bytes(4)) . '.tmp';
            $temps[] = $tmp;
            if (@file_put_contents($tmp, $version . $o['data']) !== strlen($version . $o['data'])) {
                throw new RuntimeException('the disk refused a write (is it full?)');
            }
            $renames[] = [$tmp, $path];
            $versions[$key] = $version;
        }

        return store_locked($dataDir, static function () use ($dataDir, $final, $quotaBytes, $maxFiles, $check, $renames, $versions, &$journaled): array {
            return store_publish($dataDir, $final, $quotaBytes, $maxFiles, $check, $renames, $versions, $journaled);
        });
    } finally {
        // Refused or failed before the journal: these go now. Once in the journal, they are its to move (now or by
        // whoever comes next), and are gone already when the moves were made.
        if (!$journaled) {
            foreach ($temps as $tmp) {
                @unlink($tmp);
            }
        }
    }
}

/** The checks and moves of store_commit, under the store's lock. */
function store_publish(string $dataDir, array $final, int $quotaBytes, int $maxFiles, ?callable $check, array $renames, array $versions, bool &$journaled): array
{
    $conflicts = [];
    foreach ($final as $key => $o) {
        if ($o['expect'] === '*') {
            continue;
        }
        if (store_version_of($dataDir, $key) !== $o['expect']) {
            $conflicts[] = $key;
        }
    }
    if ($conflicts) {
        throw new StoreConflict($conflicts);
    }
    if ($check !== null) {
        $check($final);
    }
    // What the commit adds or frees. Only a commit that grows the store can be refused, so deleting always works.
    $delta = 0;
    $added = 0;
    foreach ($final as $key => $o) {
        if ($o['op'] === STORE_OP_CHECK) {
            continue;
        }
        $exists = is_file(store_path($dataDir, $key));
        $old = store_charge($exists ? (@filesize(store_path($dataDir, $key)) ?: 0) : 0);
        $delta += ($o['op'] === STORE_OP_DEL ? 0 : store_charge(STORE_VERSION_LEN + strlen($o['data']))) - $old;
        $added += $o['op'] === STORE_OP_DEL ? ($exists ? -1 : 0) : ($exists ? 0 : 1);
    }
    $used = store_usage($dataDir);
    if ($quotaBytes > 0 && $delta > 0 && $used + $delta > $quotaBytes) {
        throw new StoreQuota($used, $quotaBytes, $delta);
    }
    $count = store_count($dataDir);
    if ($maxFiles > 0 && $added > 0 && $count + $added > $maxFiles) {
        throw new StoreFileLimit($count, $maxFiles);
    }
    // Every new record is on disk. Write down the moves still to make, and the totals they lead to, before making
    // them: a commit cut off half-way (power loss, a killed process) is finished by whoever comes next, totals and all.
    $journal = $dataDir . '/.journal';
    $journalTmp = $journal . '.' . bin2hex(random_bytes(4)) . '.tmp';
    $record = (string) json_encode(['moves' => $renames, 'usage' => max(0, $used + $delta), 'count' => max(0, $count + $added)], JSON_UNESCAPED_SLASHES);
    if (@file_put_contents($journalTmp, $record) !== strlen($record) || !store_rename($journalTmp, $journal)) {
        @unlink($journalTmp);
        throw new RuntimeException('the disk refused a write (is it full?)');
    }
    $journaled = true;
    store_apply_journal($dataDir);

    return $versions;
}

/**
 * Finishes the moves a commit wrote down in its journal (see store_commit), then removes the journal. Run under the
 * store lock. Safe to repeat: a move already made has no temporary file left, and deleting twice is harmless.
 */
function store_apply_journal(string $dataDir): void
{
    $journal = $dataDir . '/.journal';
    if (!is_file($journal)) {
        return;
    }
    $record = json_decode((string) file_get_contents($journal), true);
    // Earlier versions wrote the moves alone (a list) and the totals beside it.
    $renames = is_array($record) && array_is_list($record) ? $record : ($record['moves'] ?? null);
    if (!is_array($renames)) {
        throw new RuntimeException('the store journal is damaged; the data folder needs checking before more changes (php tomlinos/tools/store-check.php)');
    }
    foreach (['usage', 'count'] as $total) {
        if (is_int($record[$total] ?? null) && !store_write_total($dataDir . '/.' . $total, $record[$total])) {
            throw new RuntimeException('the store\'s totals could not be written (is the disk full?)');
        }
    }
    $objects = realpath($dataDir . '/objects');
    foreach ($renames as $move) {
        [$tmp, $path] = $move;
        // Only ever touch files inside the objects folder, whatever the journal says.
        $dir = realpath(dirname((string) $path));
        if ($objects === false || $dir === false || !str_starts_with($dir, $objects)) {
            continue;
        }
        if ($tmp === null) {
            @unlink($path);
        } elseif (is_file($tmp) && !store_rename($tmp, $path)) {
            throw new RuntimeException('a record could not be moved into place');
        }
    }
    @unlink($journal);
}

/**
 * Checks one person's store against itself: a cut-off commit still to finish, the totals against the records, temporary
 * files left by cut-off saves, damaged records, and (for files that are not encrypted, whose folders the server can
 * read) folder entries whose record is missing and records no folder reaches. Read-only unless $repair: then the commit
 * is finished, the totals are written again and temporary files over an hour old are removed. Records are never deleted.
 *
 * @return array{journal: bool, usage: array{0: int, 1: int}, count: array{0: int, 1: int}, temps: int, damaged: list<string>, missing: list<string>, unreached: list<string>, encrypted: bool}
 */
function store_check(string $dataDir, bool $repair = false): array
{
    // Seen before any lock is taken: taking the lock to repair finishes a cut-off commit at once, so looking for its
    // journal afterwards would never find one to report.
    $journal = is_file($dataDir . '/.journal');
    $run = static function () use ($dataDir, $repair, $journal): array {
        $report = ['journal' => $journal, 'temps' => 0, 'damaged' => [], 'missing' => [], 'unreached' => [], 'encrypted' => false];
        if ($repair && is_file($dataDir . '/.journal')) {
            store_apply_journal($dataDir);
        }
        $usage = 0;
        $count = 0;
        $keys = [];
        if (is_dir($dataDir . '/objects')) {
            foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dataDir . '/objects', FilesystemIterator::SKIP_DOTS)) as $file) {
                if (!$file->isFile()) {
                    continue;
                }
                if (str_ends_with($file->getFilename(), '.tmp')) {
                    $report['temps']++;
                    if ($repair && $file->getMTime() < time() - 3600) {
                        @unlink($file->getPathname());
                    }
                    continue;
                }
                $usage += store_charge($file->getSize());
                $count++;
                $key = $file->getFilename() === 'root' ? '/' : $file->getFilename();
                if (store_valid_key($key)) {
                    $keys[$key] = true;
                    if ($file->getSize() < STORE_VERSION_LEN) {
                        $report['damaged'][] = $key;
                    }
                }
            }
        }
        $kept = static fn (string $name): int => preg_match('/^\d+$/D', (string) @file_get_contents($dataDir . '/' . $name)) ? (int) file_get_contents($dataDir . '/' . $name) : -1;
        $report['usage'] = [$kept('.usage'), $usage];
        $report['count'] = [$kept('.count'), $count];
        if ($repair && ($report['usage'][0] !== $usage || $report['count'][0] !== $count)) {
            store_write_total($dataDir . '/.usage', $usage);
            store_write_total($dataDir . '/.count', $count);
        }
        // Folders the server can read: walk them from the top folder.
        $reached = [];
        $walk = ['/'];
        while ($walk && isset($keys['/'])) {
            $key = array_pop($walk);
            if (isset($reached[$key])) {
                continue;
            }
            $reached[$key] = true;
            $record = store_get($dataDir, $key);
            $data = $record[1] ?? '';
            if (store_is_sealed($data)) {
                $report['encrypted'] = true;
                break;
            }
            $folder = json_decode($data, true);
            foreach (is_array($folder) && is_array($folder['entries'] ?? null) ? $folder['entries'] : [] as $e) {
                $id = (string) ($e['id'] ?? '');
                if (!isset($keys[$id])) {
                    $report['missing'][] = $id;
                } elseif (($e['kind'] ?? '') === 'folder') {
                    $walk[] = $id;
                } else {
                    $reached[$id] = true;
                }
            }
        }
        if (!$report['encrypted'] && isset($keys['/'])) {
            $report['unreached'] = array_values(array_diff(array_keys($keys), array_keys($reached)));
        }

        return $report;
    };

    return $repair ? store_locked($dataDir, $run) : store_reading($dataDir, $run, false);
}

/** Writes a total whole (a temporary file renamed into place), so a reader never sees half a number. */
function store_write_total(string $path, int $value): bool
{
    $tmp = $path . '.' . bin2hex(random_bytes(4)) . '.tmp';
    if (@file_put_contents($tmp, (string) $value) !== strlen((string) $value) || !store_rename($tmp, $path)) {
        @unlink($tmp);

        return false;
    }

    return true;
}

// Windows refuses to replace a file another request is reading at that moment; on Linux this succeeds first time.
function store_rename(string $from, string $to): bool
{
    for ($try = 0; $try < 10; $try++) {
        if (@rename($from, $to)) {
            return true;
        }
        usleep(20000);
    }

    return false;
}

/** "8M" / "1G" / "512K" from php.ini, in bytes; 0 when unset or unlimited. */
function store_ini_bytes(string $value): int
{
    $n = (int) $value;
    return match (strtolower(substr(trim($value), -1))) { 'g' => $n << 30, 'm' => $n << 20, 'k' => $n << 10, default => $n };
}
