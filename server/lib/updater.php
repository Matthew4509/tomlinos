<?php
// System update: a newer TOMLIN OS from this project's GitHub repository, installed by the owner with one press.
// The repository holds releases/latest.json = {"release": base64 of a JSON payload, "sig": base64 Ed25519 signature of those
// payload bytes}. The payload: {version, date, notes, zip (https address), sha256, bytes}. Only a payload signed with
// the TOMLIN OS release key (its public half is lib/release-key.txt) is believed, so a changed copy anywhere cannot hand out
// a zip that installs. The zip is the same one cPanel unzips: public_html/... and tomlinos/...; people's things
// (tomlinos/config.php, data/, models/, apps/) are never written. Every file it replaces is copied to a backup first;
// Go back (or tools/rollback-update.php from the cPanel Terminal) puts the backup back.
//
// One install or Go back at a time (update/.lock). While one runs, update/operation.json says which, so one cut off
// part-way (a host's time limit, a restart) is undone by the next request instead of leaving two versions mixed; the other
// pages of the desktop wait meanwhile (api_guard). The site's files are replaced one by one in place: a cPanel host serves
// public_html directly, so there is no second folder to switch to in one step.
declare(strict_types=1);

const UPDATE_DEFAULT_SOURCE = 'https://raw.githubusercontent.com/Matthew4509/tomlinos/main/releases/latest.json';
const UPDATE_MAX_ZIP = 96 * 1024 * 1024;

/** The private folder (tomlinos/ on a live host, server/ here). */
function update_private_dir(): string
{
    return dirname(__DIR__);
}

/** The version running now: tomlinos/VERSION (written by tools/package.mjs), or package.json beside it here. */
function update_current_version(?string $priv = null): string
{
    $priv ??= update_private_dir();
    $file = $priv . '/VERSION';
    clearstatcache(true, $file);
    if (is_file($file)) {
        return trim((string) file_get_contents($file));
    }
    $pkg = json_decode((string) @file_get_contents(dirname($priv) . '/package.json'), true);

    return is_array($pkg) ? (string) ($pkg['version'] ?? '0') : '0';
}

/** What this host lacks for updating itself, in words for the owner (empty = nothing). */
function update_missing(string $webRoot): array
{
    $missing = [];
    foreach (['sodium' => 'sodium (checks the release signature)', 'zip' => 'zip (opens the update)', 'openssl' => 'openssl (secure downloads)'] as $ext => $why) {
        if (!extension_loaded($ext)) {
            $missing[] = "The PHP extension $why is off.";
        }
    }
    foreach ([$webRoot, update_private_dir()] as $dir) {
        if (!is_writable($dir)) {
            $missing[] = "PHP may not write to $dir.";
        }
    }

    return $missing;
}

/** Reads and checks the signed release note. Throws RuntimeException with words for the owner. */
function update_fetch_release(array $config): array
{
    $source = (string) ($config['update_source'] ?? UPDATE_DEFAULT_SOURCE);
    $signed = outbound_get_json($source);
    if (isset($signed['_status'])) {
        throw new RuntimeException('The update address has no update note yet (it answered ' . (int) $signed['_status'] . '). Nothing was changed.');
    }
    $payload = base64_decode((string) ($signed['release'] ?? ''), true);
    $sig = base64_decode((string) ($signed['sig'] ?? ''), true);
    $key = base64_decode(trim((string) @file_get_contents(__DIR__ . '/release-key.txt')), true);
    if (!extension_loaded('sodium')) {
        throw new RuntimeException('This server\'s PHP has no sodium extension, so the update\'s signature cannot be checked. Switch it on in the host\'s PHP settings, or update by unzipping in cPanel.');
    }
    if ($payload === false || $sig === false || $key === false || strlen($sig) !== SODIUM_CRYPTO_SIGN_BYTES || strlen($key) !== SODIUM_CRYPTO_SIGN_PUBLICKEYBYTES
        || !sodium_crypto_sign_verify_detached($sig, $payload, $key)) {
        throw new RuntimeException('The update note is not signed by TOMLIN OS, so it was ignored. Nothing was changed.');
    }
    $r = json_decode($payload, true);
    if (!is_array($r) || !preg_match('/^\d+\.\d+\.\d+$/', (string) ($r['version'] ?? '')) || !str_starts_with((string) ($r['zip'] ?? ''), 'https://')
        || !preg_match('/^[0-9a-f]{64}$/', (string) ($r['sha256'] ?? ''))) {
        throw new RuntimeException('The update note could not be read.');
    }

    return ['version' => (string) $r['version'], 'date' => (string) ($r['date'] ?? ''), 'notes' => (string) ($r['notes'] ?? ''),
        'zip' => (string) $r['zip'], 'sha256' => (string) $r['sha256'], 'bytes' => (int) ($r['bytes'] ?? 0)];
}

function update_newer(string $a, string $b): bool
{
    return version_compare($a, $b, '>');
}

/** A path inside the zip that may be written, mapped to its place on disk; null = left alone. */
function update_target(string $name, string $webRoot, ?string $priv = null): ?string
{
    if ($name === '' || str_contains($name, '..') || str_contains($name, '\\') || str_contains($name, "\0") || str_ends_with($name, '/')) {
        return null;
    }
    if (str_starts_with($name, 'public_html/')) {
        return $webRoot . '/' . substr($name, strlen('public_html/'));
    }
    if (str_starts_with($name, 'tomlinos/')) {
        $rest = substr($name, strlen('tomlinos/'));
        if ($rest === 'config.php' || preg_match('#^(data|models|apps|update)/#', $rest)) {
            return null;
        }

        return ($priv ?? update_private_dir()) . '/' . $rest;
    }

    return null;
}

/** Where updates are downloaded and backups kept (tomlinos/update/, outside the web root). */
function update_dir(?string $priv = null): string
{
    $dir = ($priv ?? update_private_dir()) . '/update';
    if (!is_dir($dir)) {
        @mkdir($dir, 0700, true);
        @file_put_contents($dir . '/.htaccess', "Require all denied\n");
    }

    return $dir;
}

// What an install may unpack: far above a real release (about 3,000 files and 30 MB unpacked), far below what would run a
// shared host out of disk. Each file is copied to disk in pieces, never held whole in memory.
const UPDATE_MAX_FILES = 20000;
const UPDATE_MAX_UNPACKED = 384 * 1024 * 1024;

/**
 * Runs $fn(update folder) holding the update lock, so an install and a Go back (or two of either) never run at once; a
 * second one is refused at once rather than queued. First, one cut off part-way (a host's time limit, a restart) is
 * finished: its backup is put back, so the site is one whole version again.
 */
function update_locked(callable $fn, ?string $priv = null): mixed
{
    $dir = update_dir($priv);
    $lock = @fopen($dir . '/.lock', 'c');
    if ($lock === false) {
        throw new RuntimeException("PHP may not write to $dir, so nothing was changed.");
    }
    if (!flock($lock, LOCK_EX | LOCK_NB)) {
        fclose($lock);
        throw new RuntimeException('An update or a Go back is running now. Wait a minute, then look again.');
    }
    try {
        return $fn($dir);
    } finally {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
}

/** The install or Go back under way, or cut off: update/operation.json, or null when there is none. */
function update_operation(string $dir): ?array
{
    $op = json_decode((string) @file_get_contents($dir . '/operation.json'), true);

    return is_array($op) && in_array($op['op'] ?? '', ['install', 'rollback', 'finish'], true) ? $op : null;
}

/** Writes a small file whole or not at all (a temporary copy renamed into place), and says whether it worked. */
function update_write_file(string $path, string $bytes): bool
{
    $tmp = $path . '.' . bin2hex(random_bytes(4)) . '.tmp';
    if (@file_put_contents($tmp, $bytes) !== strlen($bytes) || !@rename($tmp, $path)) {
        @unlink($tmp);

        return false;
    }

    return true;
}

function update_set_operation(string $dir, array $op): void
{
    if (!update_write_file($dir . '/operation.json', (string) json_encode($op + ['started' => time()]))) {
        throw new RuntimeException('The update folder could not be written (is the disk full?). Nothing was changed.');
    }
}

/** Copies one file into place: a temporary copy beside it, renamed over it, then checked. */
function update_place(string $from, string $to): bool
{
    if (!is_dir(dirname($to)) && !@mkdir(dirname($to), 0755, true) && !is_dir(dirname($to))) {
        return false;
    }
    $tmp = $to . '.new';
    if (!@copy($from, $tmp) || !@rename($tmp, $to)) {
        @unlink($tmp);

        return false;
    }
    clearstatcache(true, $to);

    return @filesize($to) === @filesize($from) && hash_file('sha256', $to) === hash_file('sha256', $from);
}

/**
 * Puts a backup back, checking every file and then the version. Throws RuntimeException naming what failed, and the backup
 * is left as it is, so Go back (or tools/rollback-update.php) can be tried again. Returns the version put back.
 */
function update_restore(string $backup, ?string $priv = null): string
{
    $manifest = json_decode((string) @file_get_contents($backup . '/manifest.json'), true);
    if (!is_array($manifest) || !is_array($manifest['files'] ?? null)) {
        throw new RuntimeException('The kept copy of the earlier version is damaged (its list of files cannot be read), so it was not used. Put the earlier version back by unzipping it in cPanel.');
    }
    $failed = [];
    foreach ($manifest['files'] as $f) {
        $path = (string) ($f['path'] ?? '');
        if ($path === '') {
            continue;
        }
        // A copy cut off between written and renamed (update_place) is removed: in public_html it would be served as it is.
        if (is_file($path . '.new')) {
            @unlink($path . '.new');
        }
        if (($f['saved'] ?? null) === null) {
            // A file the update added: removed again (only a file: a folder standing there was never the update's).
            @unlink($path);
            clearstatcache(true, $path);
            if (is_file($path)) {
                $failed[] = $path;
            }
        } elseif (!update_place($backup . '/' . $f['saved'], $path)) {
            $failed[] = $path;
        }
    }
    $version = (string) ($manifest['version'] ?? '');
    if (!$failed && update_current_version($priv) !== $version) {
        $failed[] = ($priv ?? update_private_dir()) . '/VERSION';
    }
    if ($failed) {
        throw new RuntimeException(sprintf('%d %s could not be put back (the first: %s). The kept copy of %s is still there: check that PHP may write to that folder, then press Go back again, or run php tomlinos/tools/rollback-update.php from the cPanel Terminal.',
            count($failed), count($failed) === 1 ? 'file' : 'files', $failed[0], $version));
    }

    return $version;
}

/**
 * Finishes an install or Go back that was cut off part-way. An install that had not finished is undone from its own
 * backup; one that had finished only has its backup moved into place. Returns the version put back, or null when there
 * was nothing to put back.
 */
function update_recover(string $dir, ?string $priv = null): ?string
{
    $op = update_operation($dir);
    if ($op === null) {
        update_rmdir($dir . '/backup.next');

        return null;
    }
    $put = null;
    if ($op['op'] === 'install') {
        $put = update_restore($dir . '/backup.next', $priv);
        update_rmdir($dir . '/backup.next');
    } elseif ($op['op'] === 'rollback') {
        $put = update_restore($dir . '/backup', $priv);
        update_rmdir($dir . '/backup');
    } elseif (is_dir($dir . '/backup.next')) {
        update_rmdir($dir . '/backup');
        if (!@rename($dir . '/backup.next', $dir . '/backup')) {
            throw new RuntimeException('The kept copy of the earlier version could not be moved into place. Check that PHP may write to ' . $dir . '.');
        }
    }
    @unlink($dir . '/operation.json');
    // What a cut-off run left in the update folder: its unpacked files and its download.
    foreach (glob($dir . '/stage-*', GLOB_ONLYDIR) ?: [] as $stage) {
        update_rmdir($stage);
    }
    foreach (glob($dir . '/download-*.zip') ?: [] as $zip) {
        @unlink($zip);
    }
    update_reset_cache();

    return $put;
}

function update_reset_cache(): void
{
    if (function_exists('opcache_reset')) {
        @opcache_reset();
    }
}

/** Downloads, checks and installs the release. Returns the version now running. Throws RuntimeException. */
function update_install(array $release, string $webRoot): string
{
    if ($missing = update_missing($webRoot)) {
        throw new RuntimeException(implode(' ', $missing) . ' Update by unzipping in cPanel instead.');
    }

    return update_locked(static function (string $dir) use ($release, $webRoot): string {
        if (($back = update_recover($dir)) !== null) {
            throw new RuntimeException("An earlier update was cut off part-way, so $back was put back first. Press Install again.");
        }
        $zipPath = $dir . '/download-' . bin2hex(random_bytes(4)) . '.zip';
        // A GitHub release file answers with a redirect to GitHub's file host: followed, and the signed fingerprint below
        // decides what is kept, wherever the bytes came from.
        $ctx = stream_context_create(['http' => ['timeout' => 60, 'follow_location' => 1, 'max_redirects' => 5, 'header' => "User-Agent: TomlinOS\r\n"], 'ssl' => ['verify_peer' => true, 'verify_peer_name' => true]]);
        $in = @fopen($release['zip'], 'rb', false, $ctx);
        if ($in === false) {
            throw new RuntimeException('The update could not be downloaded. Try again in a minute.');
        }
        try {
            $out = @fopen($zipPath, 'wb');
            $n = $out === false ? false : stream_copy_to_stream($in, $out, UPDATE_MAX_ZIP + 1);
            fclose($in);
            if ($out !== false) {
                fclose($out);
            }
            if ($n === false || $n > UPDATE_MAX_ZIP || !hash_equals($release['sha256'], (string) @hash_file('sha256', $zipPath))) {
                throw new RuntimeException('The downloaded update did not match its signed fingerprint, so it was thrown away. Nothing was changed.');
            }

            return update_apply_zip($zipPath, $webRoot, $dir);
        } finally {
            @unlink($zipPath);
        }
    });
}

/**
 * Installs a checked release zip (run under update_locked). Every file is unpacked to a staging folder first, the files it
 * replaces are copied to a new backup (the last one is kept until this install is done), each replacement is checked,
 * and then the version. Any failure puts the backup back. Returns the version now running.
 */
function update_apply_zip(string $zipPath, string $webRoot, string $dir, ?string $priv = null): string
{
    $priv ??= update_private_dir();
    $zip = new ZipArchive();
    if ($zip->open($zipPath) !== true) {
        throw new RuntimeException('The update could not be opened. Nothing was changed.');
    }
    $stage = $dir . '/stage-' . bin2hex(random_bytes(4));
    try {
        // What it holds, from the zip's own list, before anything is unpacked.
        $plan = [];
        $total = 0;
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $stat = $zip->statIndex($i);
            $target = $stat === false ? null : update_target((string) $stat['name'], $webRoot, $priv);
            if ($target === null) {
                continue;
            }
            $total += (int) $stat['size'];
            $plan[] = ['index' => $i, 'target' => $target, 'size' => (int) $stat['size']];
            if (count($plan) > UPDATE_MAX_FILES || $total > UPDATE_MAX_UNPACKED) {
                throw new RuntimeException('The update holds far more than a TOMLIN OS release does, so it was not unpacked. Nothing was changed.');
            }
        }
        if (!in_array($priv . '/VERSION', array_column($plan, 'target'), true)) {
            throw new RuntimeException('The update is missing its version file. Nothing was changed.');
        }
        $replacing = 0;
        foreach ($plan as $p) {
            $replacing += is_file($p['target']) ? (int) @filesize($p['target']) : 0;
        }
        $free = @disk_free_space($dir);
        if ($free !== false && $free < $total + $replacing + 16 * 1024 * 1024) {
            throw new RuntimeException(sprintf('The server has %.0f MB free, and this update needs about %.0f MB while it installs. Free some space, then try again. Nothing was changed.', $free / 1048576, ($total + $replacing) / 1048576 + 16));
        }

        // Unpacked to the staging folder, in pieces, each checked against the size the zip states.
        if (!@mkdir($stage, 0700, true)) {
            throw new RuntimeException("PHP may not write to $dir. Nothing was changed.");
        }
        foreach ($plan as $k => $p) {
            $in = method_exists($zip, 'getStreamIndex') ? $zip->getStreamIndex($p['index']) : $zip->getStream((string) $zip->getNameIndex($p['index']));
            $out = @fopen("$stage/f$k", 'wb');
            $n = ($in === false || $out === false) ? false : stream_copy_to_stream($in, $out, $p['size'] + 1);
            if (is_resource($in)) {
                fclose($in);
            }
            if ($out !== false) {
                fclose($out);
            }
            if ($n !== $p['size']) {
                throw new RuntimeException('Part of the update could not be read. Nothing was changed.');
            }
        }
        $zip->close();
        $zip = null;
        $next = trim((string) file_get_contents($stage . '/f' . array_search($priv . '/VERSION', array_column($plan, 'target'), true)));

        // The new backup, beside the last one (kept until this install has finished).
        $backup = $dir . '/backup.next';
        update_rmdir($backup);
        if (!@mkdir($backup, 0700, true)) {
            throw new RuntimeException("PHP may not write to $dir. Nothing was changed.");
        }
        $manifest = ['version' => update_current_version($priv), 'to' => $next, 'files' => []];
        foreach ($plan as $k => $p) {
            $saved = is_file($p['target']) ? "f$k" : null;
            if ($saved !== null && !update_place($p['target'], "$backup/$saved")) {
                update_rmdir($backup);
                throw new RuntimeException('A backup copy could not be made (is the disk full?). Nothing was changed.');
            }
            $manifest['files'][] = ['path' => $p['target'], 'saved' => $saved];
        }
        if (!update_write_file($backup . '/manifest.json', (string) json_encode($manifest, JSON_UNESCAPED_SLASHES))) {
            update_rmdir($backup);
            throw new RuntimeException('The backup\'s list of files could not be written (is the disk full?). Nothing was changed.');
        }

        // From here a cut-off install is undone by the next update request, Go back, or tools/rollback-update.php.
        update_set_operation($dir, ['op' => 'install', 'from' => $manifest['version'], 'to' => $next]);
        $failed = null;
        foreach ($plan as $k => $p) {
            if (!update_place("$stage/f$k", $p['target'])) {
                $failed = $p['target'];
                break;
            }
        }
        if ($failed === null && update_current_version($priv) !== $next) {
            $failed = $priv . '/VERSION';
        }
        if ($failed !== null) {
            $back = update_recover($dir, $priv);
            throw new RuntimeException("A file could not be written ($failed), so $back was put back. Nothing else was changed.");
        }

        // Done: the new backup replaces the last one.
        update_set_operation($dir, ['op' => 'finish']);
        update_recover($dir, $priv);

        return update_current_version($priv);
    } finally {
        if ($zip instanceof ZipArchive) {
            $zip->close();
        }
        update_rmdir($stage);
        update_reset_cache();
    }
}

/**
 * Puts the last backup back (or finishes an install or Go back that was cut off). Returns the version restored, or null
 * when there is no backup. Throws RuntimeException when a file could not be put back; the backup is then kept.
 */
function update_rollback(?string $priv = null): ?string
{
    return update_locked(static function (string $dir) use ($priv): ?string {
        $op = update_operation($dir);
        if ($op !== null && $op['op'] !== 'finish') {
            return update_recover($dir, $priv);
        }
        update_recover($dir, $priv);
        if (!is_file($dir . '/backup/manifest.json')) {
            return null;
        }
        update_set_operation($dir, ['op' => 'rollback']);

        return update_recover($dir, $priv);
    }, $priv);
}

/** The version Go back would put back, or null when none is kept. */
function update_backup_version(?string $priv = null): ?string
{
    $dir = ($priv ?? update_private_dir()) . '/update';
    $op = update_operation($dir);
    $from = $op !== null && $op['op'] === 'install' ? 'backup.next' : 'backup';
    $m = json_decode((string) @file_get_contents("$dir/$from/manifest.json"), true);

    return is_array($m) ? (string) ($m['version'] ?? '') : null;
}

function update_rmdir(string $dir): void
{
    if (!is_dir($dir)) {
        return;
    }
    foreach (scandir($dir) ?: [] as $n) {
        if ($n === '.' || $n === '..') {
            continue;
        }
        $p = $dir . '/' . $n;
        is_dir($p) ? update_rmdir($p) : @unlink($p);
    }
    @rmdir($dir);
}
