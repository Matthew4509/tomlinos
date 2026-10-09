<?php
// The desktop's file store (phase 2; one per person since accounts arrived). The browser runs the desktop's own file-system logic (src/fs) and hands this server
// opaque records: a key (a random ID, or "/" for the root) and a blob. Directory listings, inodes and file
// contents are all such blobs; the server never sees a file name in the clear, which is what phase 4's
// encryption in the browser needs.
//
// Every record carries a version: 32 hex characters written in front of its blob. A commit names the version
// it last read for each key it changes, and the whole commit is refused if any of them has moved on, so two
// browsers can never silently overwrite each other's changes.
declare(strict_types=1);

const STORE_KEY_RE = '/^(\/|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/D';
const STORE_VERSION_LEN = 32;
const STORE_OP_PUT = 1;
const STORE_OP_DEL = 2;
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
        } elseif ($op === STORE_OP_DEL) {
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
 * Applies a commit all-or-nothing. Every expected version is checked under one lock before anything is written;
 * each record is written to a temporary file and renamed into place, so a reader never sees half a record.
 *
 * @param list<array{op: int, key: string, expect: string, data: string}> $ops
 * @return array<string, string> the new version of every key the commit wrote ("" for a deleted key)
 */
function store_commit(string $dataDir, array $ops, int $quotaBytes = 0, int $maxFiles = 0): array
{
    if (!is_dir($dataDir . '/objects') && !@mkdir($dataDir . '/objects', 0700, true) && !is_dir($dataDir . '/objects')) {
        throw new RuntimeException('the data folder cannot be created');
    }
    $lock = fopen($dataDir . '/.lock', 'c');
    if ($lock === false || !flock($lock, LOCK_EX)) {
        throw new RuntimeException('the store lock cannot be taken');
    }
    try {
        store_apply_journal($dataDir);
        // The last operation on a key wins, as it would inside the browser's own transaction, checked against
        // the version the first one expected (the version the browser read before the transaction began).
        $final = [];
        foreach ($ops as $o) {
            $prev = $final[$o['key']] ?? null;
            $final[$o['key']] = $prev === null ? $o : array_merge($o, ['expect' => $prev['expect']]);
        }
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
        // What the commit adds or frees. Only a commit that grows the store can be refused, so deleting always works.
        $delta = 0;
        $added = 0;
        foreach ($final as $key => $o) {
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
        $versions = [];
        $renames = [];
        foreach ($final as $key => $o) {
            $path = store_path($dataDir, $key);
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
            if (file_put_contents($tmp, $version . $o['data'], LOCK_EX) !== strlen($version . $o['data'])) {
                @unlink($tmp);
                throw new RuntimeException('the disk refused a write (is it full?)');
            }
            $renames[] = [$tmp, $path];
            $versions[$key] = $version;
        }
        // Every new record is on disk. Write down the moves still to make before making them, so a commit cut off
        // half-way (power loss, a killed process) is finished by the next commit instead of left half-applied.
        $journal = $dataDir . '/.journal';
        $journalTmp = $journal . '.' . bin2hex(random_bytes(4)) . '.tmp';
        $record = json_encode($renames, JSON_UNESCAPED_SLASHES);
        if (file_put_contents($journalTmp, $record) !== strlen($record) || !store_rename($journalTmp, $journal)) {
            @unlink($journalTmp);
            foreach ($renames as [$tmp]) {
                if ($tmp !== null) {
                    @unlink($tmp);
                }
            }
            throw new RuntimeException('the disk refused a write (is it full?)');
        }
        // The new total is written before the moves, so a request stopped part-way (a host's time limit) cannot leave
        // records on disk that the quota never counted; the next commit finishes the moves from the journal.
        @file_put_contents($dataDir . '/.usage', (string) max(0, $used + $delta));
        @file_put_contents($dataDir . '/.count', (string) max(0, $count + $added));
        store_apply_journal($dataDir);

        return $versions;
    } finally {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
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
    $renames = json_decode((string) file_get_contents($journal), true);
    if (!is_array($renames)) {
        throw new RuntimeException('the store journal is damaged; the data folder needs checking before more changes');
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
