<?php
// System update: a newer TOMLIN OS from the release site, installed by the owner with one press.
// The release site serves latest.json = {"release": base64 of a JSON payload, "sig": base64 Ed25519 signature of those
// payload bytes}. The payload: {version, date, notes, zip (https address), sha256, bytes}. Only a payload signed with
// the TOMLIN OS release key (its public half is lib/release-key.txt) is believed, so a hacked release site cannot hand out
// a zip that installs. The zip is the same one cPanel unzips: public_html/... and tomlinos/...; people's things
// (tomlinos/config.php, data/, models/, apps/) are never written. Every file it replaces is copied to a backup first;
// Go back (or tools/rollback-update.php from the cPanel Terminal) puts the backup back.
declare(strict_types=1);

const UPDATE_DEFAULT_SOURCE = 'https://raw.githubusercontent.com/Matthew4509/Tomlinos/main/releases/latest.json';
const UPDATE_MAX_ZIP = 96 * 1024 * 1024;

/** The private folder (tomlinos/ on a live host, server/ here). */
function update_private_dir(): string
{
    return dirname(__DIR__);
}

/** The version running now: tomlinos/VERSION (written by tools/package.mjs), or package.json beside it here. */
function update_current_version(): string
{
    $file = update_private_dir() . '/VERSION';
    if (is_file($file)) {
        return trim((string) file_get_contents($file));
    }
    $pkg = json_decode((string) @file_get_contents(dirname(update_private_dir()) . '/package.json'), true);

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
        throw new RuntimeException('The release site has no update note (it answered ' . (int) $signed['_status'] . ').');
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
function update_target(string $name, string $webRoot): ?string
{
    if ($name === '' || str_contains($name, '..') || str_contains($name, '\\') || str_contains($name, "\0") || str_ends_with($name, '/')) {
        return null;
    }
    if (str_starts_with($name, 'public_html/')) {
        return $webRoot . '/' . substr($name, 12);
    }
    if (str_starts_with($name, 'tomlinos/')) {
        $rest = substr($name, 7);
        if ($rest === 'config.php' || preg_match('#^(data|models|apps|update)/#', $rest)) {
            return null;
        }

        return update_private_dir() . '/' . $rest;
    }

    return null;
}

/** Where updates are downloaded and backups kept (tomlinos/update/, outside the web root). */
function update_dir(): string
{
    $dir = update_private_dir() . '/update';
    if (!is_dir($dir)) {
        @mkdir($dir, 0700, true);
        @file_put_contents($dir . '/.htaccess', "Require all denied\n");
    }

    return $dir;
}

/** Downloads, checks and installs the release. Returns the version now running. Throws RuntimeException. */
function update_install(array $release, string $webRoot): string
{
    if ($missing = update_missing($webRoot)) {
        throw new RuntimeException(implode(' ', $missing) . ' Update by unzipping in cPanel instead.');
    }
    $dir = update_dir();
    $zipPath = $dir . '/download.zip';
    // A GitHub release file answers with a redirect to GitHub's file host: followed, and the signed fingerprint below
    // decides what is kept, wherever the bytes came from.
    $ctx = stream_context_create(['http' => ['timeout' => 60, 'follow_location' => 1, 'max_redirects' => 5, 'header' => "User-Agent: TomlinOS\r\n"], 'ssl' => ['verify_peer' => true, 'verify_peer_name' => true]]);
    $in = @fopen($release['zip'], 'rb', false, $ctx);
    if ($in === false) {
        throw new RuntimeException('The update could not be downloaded. Try again in a minute.');
    }
    $out = fopen($zipPath, 'wb');
    $n = stream_copy_to_stream($in, $out, UPDATE_MAX_ZIP + 1);
    fclose($in);
    fclose($out);
    if ($n === false || $n > UPDATE_MAX_ZIP || !hash_equals($release['sha256'], (string) hash_file('sha256', $zipPath))) {
        @unlink($zipPath);
        throw new RuntimeException('The downloaded update did not match its signed fingerprint, so it was thrown away. Nothing was changed.');
    }
    $zip = new ZipArchive();
    if ($zip->open($zipPath) !== true) {
        throw new RuntimeException('The update could not be opened. Nothing was changed.');
    }
    // Read everything first: a zip that fails part way leaves the site as it was.
    $files = [];
    for ($i = 0; $i < $zip->numFiles; $i++) {
        $name = (string) $zip->getNameIndex($i);
        $target = update_target($name, $webRoot);
        if ($target === null) {
            continue;
        }
        $bytes = $zip->getFromIndex($i);
        if ($bytes === false) {
            $zip->close();
            throw new RuntimeException('Part of the update could not be read. Nothing was changed.');
        }
        $files[$target] = $bytes;
    }
    $zip->close();
    if (!isset($files[update_private_dir() . '/VERSION'])) {
        throw new RuntimeException('The update is missing its version file. Nothing was changed.');
    }
    $old = update_current_version();
    $backup = $dir . '/backup';
    update_rmdir($backup);
    mkdir($backup, 0700, true);
    $manifest = ['version' => $old, 'files' => []];
    foreach (array_keys($files) as $target) {
        $saved = is_file($target) ? 'f' . count($manifest['files']) : null;
        if ($saved !== null && !copy($target, $backup . '/' . $saved)) {
            throw new RuntimeException('A backup copy could not be made. Nothing was changed.');
        }
        $manifest['files'][] = ['path' => $target, 'saved' => $saved];
    }
    file_put_contents($backup . '/manifest.json', json_encode($manifest));
    foreach ($files as $target => $bytes) {
        if (!is_dir(dirname($target))) {
            mkdir(dirname($target), 0755, true);
        }
        if (file_put_contents($target . '.new', $bytes) === false || !rename($target . '.new', $target)) {
            update_rollback();
            throw new RuntimeException('A file could not be written, so the old version was put back.');
        }
    }
    @unlink($zipPath);
    if (function_exists('opcache_reset')) {
        @opcache_reset();
    }

    return update_current_version();
}

/** Puts the last backup back. Returns the version restored, or null when there is no backup. */
function update_rollback(): ?string
{
    $backup = update_private_dir() . '/update/backup';
    $manifest = json_decode((string) @file_get_contents($backup . '/manifest.json'), true);
    if (!is_array($manifest) || !is_array($manifest['files'] ?? null)) {
        return null;
    }
    foreach ($manifest['files'] as $f) {
        $path = (string) ($f['path'] ?? '');
        if ($path === '') {
            continue;
        }
        if ($f['saved'] === null) {
            @unlink($path);
        } else {
            copy($backup . '/' . $f['saved'], $path);
        }
    }
    update_rmdir($backup);
    if (function_exists('opcache_reset')) {
        @opcache_reset();
    }

    return (string) $manifest['version'];
}

function update_backup_version(): ?string
{
    $m = json_decode((string) @file_get_contents(update_private_dir() . '/update/backup/manifest.json'), true);

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
