<?php
// The app store: add-on apps (games and the like) that are not part of TOMLIN OS itself. Each is a zip of plain web files
// (a page, its scripts, pictures, sounds), published by TOMLIN OS with tools/store-publish.mjs and listed in a signed
// catalogue. The catalogue = {"catalogue": base64 of a JSON payload, "sig": base64 Ed25519 signature of those bytes},
// signed with the same key as System update (lib/release-key.txt has its public half), so a changed copy anywhere is
// refused. The payload: {made, apps: [{id, title, icon, kind, version, date, notes, bytes, sha256, zips: [https...]}]}.
//
// Where it is read from: each address in 'app_sources' (tomlinos/config.php) in turn, the first signed one wins. By default
// the TOMLIN OS repository on GitHub. Each app's zip is tried at each of its addresses
// the same way (a GitHub release first). Only the owner of this TOMLIN OS downloads an app onto the server; each person
// then adds it to their own Start menu or not (the desktop keeps that choice in their files).
//
// An app lands in public_html/apps/<id>/ and is served as plain files: only file types a page uses are unpacked, never
// PHP or settings files, and apps/.htaccess refuses any script there besides. What is on this server is kept in the data
// folder (appstore.json); an app whose folder has gone (deleted by hand) counts as not here.
declare(strict_types=1);

require_once __DIR__ . '/download.php';

const APPSTORE_SOURCES = [
    'https://raw.githubusercontent.com/Matthew4509/tomlinos/main/appstore/catalogue.json',
];
const APPSTORE_MAX_ZIP = 48 * 1024 * 1024;
const APPSTORE_MAX_UNPACKED = 96 * 1024 * 1024;
const APPSTORE_MAX_FILES = 3000;
const APPSTORE_TYPES = ['html', 'js', 'mjs', 'css', 'json', 'txt', 'md', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico',
    'woff', 'woff2', 'ttf', 'otf', 'mp3', 'ogg', 'oga', 'wav', 'm4a', 'mp4', 'webm', 'wasm', 'csv', 'xml', 'pdf'];
const APPSTORE_KINDS = ['games', 'office', 'system'];

/** The first $n characters of a text, without needing the mbstring extension (it is optional on a host). */
function appstore_cut(string $text, int $n): string
{
    $chars = preg_split('//u', $text, -1, PREG_SPLIT_NO_EMPTY);

    return $chars === false ? '' : implode('', array_slice($chars, 0, $n));
}

/** A store app's id: lower-case letters and digits, as it appears in the address (apps/<id>/). */
function appstore_valid_id(string $id): bool
{
    return (bool) preg_match('/^[a-z][a-z0-9]{1,30}$/', $id);
}

/** The public half of the signing key. The tests point it elsewhere (an environment variable only, never config). */
function appstore_public_key(): string
{
    $test = (string) getenv('DESKTOP_APPSTORE_KEY');
    $key = base64_decode($test !== '' ? $test : trim((string) @file_get_contents(__DIR__ . '/release-key.txt')), true);

    return $key === false ? '' : $key;
}

/** One catalogue entry made safe to use, or null when it is not one. */
function appstore_clean_app(mixed $a): ?array
{
    if (!is_array($a) || !appstore_valid_id((string) ($a['id'] ?? '')) || !preg_match('/^\d+\.\d+(\.\d+)?$/', (string) ($a['version'] ?? ''))
        || !preg_match('/^[0-9a-f]{64}$/', (string) ($a['sha256'] ?? '')) || !is_array($a['zips'] ?? null)) {
        return null;
    }
    $zips = array_values(array_filter(array_map('strval', $a['zips']), fn ($u) => str_starts_with($u, 'https://')));
    if (!$zips) {
        return null;
    }
    $size = is_array($a['size'] ?? null) && count($a['size']) === 2 ? [max(320, min(1600, (int) $a['size'][0])), max(240, min(1200, (int) $a['size'][1]))] : [960, 640];

    return [
        'id' => (string) $a['id'],
        'title' => appstore_cut(trim((string) ($a['title'] ?? $a['id'])), 60),
        'icon' => preg_match('/^[a-z][a-z0-9-]{0,30}$/', (string) ($a['icon'] ?? '')) ? (string) $a['icon'] : 'app',
        'kind' => in_array($a['kind'] ?? '', APPSTORE_KINDS, true) ? (string) $a['kind'] : 'office',
        'version' => (string) $a['version'],
        'date' => appstore_cut((string) ($a['date'] ?? ''), 20),
        'notes' => appstore_cut((string) ($a['notes'] ?? ''), 2000),
        'bytes' => max(0, (int) ($a['bytes'] ?? 0)),
        'sha256' => (string) $a['sha256'],
        'zips' => $zips,
        'size' => $size,
    ];
}

/** Checks a signed catalogue's signature and reads its apps. Throws RuntimeException with words for the owner. */
function appstore_read_signed(array $signed): array
{
    if (!extension_loaded('sodium')) {
        throw new RuntimeException('This server\'s PHP has no sodium extension, so the app store\'s signature cannot be checked. The owner can switch it on in the host\'s PHP settings.');
    }
    $payload = base64_decode((string) ($signed['catalogue'] ?? ''), true);
    $sig = base64_decode((string) ($signed['sig'] ?? ''), true);
    $key = appstore_public_key();
    if ($payload === false || $sig === false || strlen($sig) !== SODIUM_CRYPTO_SIGN_BYTES || strlen($key) !== SODIUM_CRYPTO_SIGN_PUBLICKEYBYTES
        || !sodium_crypto_sign_verify_detached($sig, $payload, $key)) {
        throw new RuntimeException('The app list is not signed by TOMLIN OS, so it was ignored.');
    }
    $data = json_decode($payload, true);
    if (!is_array($data) || !is_array($data['apps'] ?? null)) {
        throw new RuntimeException('The app list could not be read.');
    }
    $apps = [];
    foreach ($data['apps'] as $a) {
        $clean = appstore_clean_app($a);
        if ($clean !== null) {
            $apps[$clean['id']] = $clean;
        }
    }

    return array_values($apps);
}

/** The catalogue, from the first source that gives a signed one. Throws RuntimeException naming why none did. */
function appstore_catalogue(array $config): array
{
    // The tests serve the store from a folder (an environment variable only, never config).
    $local = (string) getenv('DESKTOP_APPSTORE_DIR');
    if ($local !== '') {
        $signed = json_decode((string) @file_get_contents($local . '/catalogue.json'), true);

        return appstore_read_signed(is_array($signed) ? $signed : []);
    }
    $sources = array_values(array_filter(array_map('strval', (array) ($config['app_sources'] ?? APPSTORE_SOURCES)), fn ($u) => str_starts_with($u, 'https://')));
    if (!$sources) {
        throw new RuntimeException('No app store is set for this TOMLIN OS (app_sources in tomlinos/config.php is empty).');
    }
    $why = '';
    foreach ($sources as $url) {
        try {
            $signed = outbound_get_json($url);
            if (isset($signed['_status'])) {
                throw new RuntimeException('it answered ' . (int) $signed['_status']);
            }

            return appstore_read_signed($signed);
        } catch (RuntimeException $e) {
            $why = $e->getMessage();
        }
    }
    throw new RuntimeException('The app store could not be read (' . rtrim($why, '.') . '). Try again later.');
}

/** What is on this server now: id => {id, title, icon, kind, version, size}. Apps whose folder has gone are left out. */
function appstore_here(string $dataDir, string $webRoot): array
{
    $list = json_decode((string) @file_get_contents($dataDir . '/appstore.json'), true);
    $out = [];
    foreach (is_array($list) ? $list : [] as $id => $a) {
        if (is_string($id) && appstore_valid_id($id) && is_array($a) && is_file("$webRoot/apps/$id/index.html")) {
            $out[$id] = ['id' => $id, 'title' => (string) ($a['title'] ?? $id), 'icon' => (string) ($a['icon'] ?? 'app'),
                'kind' => (string) ($a['kind'] ?? 'office'), 'version' => (string) ($a['version'] ?? ''), 'size' => $a['size'] ?? [960, 640]];
        }
    }

    return $out;
}

function appstore_save_here(string $dataDir, array $here): void
{
    $file = $dataDir . '/appstore.json';
    $tmp = $file . '.' . bin2hex(random_bytes(4)) . '.tmp';
    $text = (string) json_encode($here, JSON_PRETTY_PRINT);
    if (@file_put_contents($tmp, $text) !== strlen($text) || !@rename($tmp, $file)) {
        @unlink($tmp);
        throw new RuntimeException('The list of apps on this server could not be saved.');
    }
}

/**
 * Runs $fn holding the app store's lock: one download or delete at a time (a second waits its turn), so two never share a
 * folder or lose each other's line in the list of apps on this server.
 */
function appstore_locked(string $dataDir, callable $fn): mixed
{
    $lock = @fopen($dataDir . '/appstore.lock', 'c');
    if ($lock === false || !flock($lock, LOCK_EX)) {
        throw new RuntimeException('The app store could not start (its lock file cannot be written in the data folder).');
    }
    try {
        return $fn();
    } finally {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
}

/** A path inside an app's zip that may be unpacked: plain web files only, no hidden files, nothing outside. */
function appstore_allowed_name(string $name): bool
{
    if (!preg_match('#^[A-Za-z0-9_-][A-Za-z0-9._-]*(/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$#', $name) || str_contains($name, '..')) {
        return false;
    }
    // Apache on some hosts (cPanel's EA4) runs "game.php8.js" as PHP: its handler matches ".php8" anywhere in the name,
    // not only at the end. So no part of a file's name after the first dot may be a script type (the zips are pinned by
    // their fingerprint, so this is a second line of defence).
    foreach (array_slice(explode('.', basename($name)), 1) as $part) {
        if (preg_match('/^(php\d*|phtml|phar|cgi|pl|py|sh|shtml|htaccess|htpasswd)$/i', $part)) {
            return false;
        }
    }

    return in_array(strtolower(pathinfo($name, PATHINFO_EXTENSION)), APPSTORE_TYPES, true);
}

/** Downloads the app's zip into $to, trying each of its addresses. Throws RuntimeException. */
function appstore_fetch_zip(array $app, string $to): void
{
    $local = (string) getenv('DESKTOP_APPSTORE_DIR');
    $urls = $local !== '' ? array_map(fn ($u) => $local . '/' . basename(parse_url($u, PHP_URL_PATH) ?: ''), $app['zips']) : $app['zips'];
    foreach ($urls as $url) {
        // A GitHub release file answers with a redirect to GitHub's file host: followed (on https only), and the signed
        // fingerprint below decides whether what arrived is the app.
        try {
            $in = download_open((string) $url);
        } catch (RuntimeException) {
            $in = false; // sent to plain http: the next address is tried
        }
        if ($in === false) {
            continue;
        }
        $out = fopen($to, 'wb');
        $n = stream_copy_to_stream($in, $out, APPSTORE_MAX_ZIP + 1);
        fclose($in);
        fclose($out);
        if ($n !== false && $n <= APPSTORE_MAX_ZIP && hash_equals($app['sha256'], (string) hash_file('sha256', $to))) {
            return;
        }
        @unlink($to);
    }
    throw new RuntimeException('"' . $app['title'] . '" could not be downloaded, or what arrived did not match its signed fingerprint. Nothing was changed. Try again later.');
}

/** Downloads, checks and unpacks one app onto this server (new, or a newer version). Returns its record. */
function appstore_download(array $app, string $dataDir, string $webRoot): array
{
    return appstore_locked($dataDir, static fn (): array => appstore_download_locked($app, $dataDir, $webRoot));
}

function appstore_download_locked(array $app, string $dataDir, string $webRoot): array
{
    foreach (['zip' => 'zip (opens the app)', 'openssl' => 'openssl (secure downloads)'] as $ext => $why) {
        if (!extension_loaded($ext)) {
            throw new RuntimeException("The PHP extension $why is off on this server. The owner can switch it on in the host's PHP settings.");
        }
    }
    $apps = $webRoot . '/apps';
    if (!is_dir($apps) && !@mkdir($apps, 0755, true)) {
        throw new RuntimeException("PHP may not make the folder $apps.");
    }
    // Belt and braces: whatever is in apps/, no script runs there, nothing hidden is served, and an app's page opened on
    // its own is as sandboxed as in its frame (public_html/.htaccess says the same; this covers sites set up before it).
    @file_put_contents($apps . '/.htaccess', "Options -Indexes -ExecCGI\nRemoveHandler .php .phtml .phar .cgi .pl .py\n<FilesMatch \"(?i)(\\.(php\\d*|phtml|phar|cgi|pl|py|sh)$|^\\.)\">\n  Require all denied\n</FilesMatch>\n<IfModule mod_headers.c>\n  Header always add Content-Security-Policy \"sandbox allow-scripts\"\n</IfModule>\n");
    $zipPath = $dataDir . '/appstore-download-' . bin2hex(random_bytes(4)) . '.zip';
    $final = "$apps/{$app['id']}";
    $fresh = "$final.new";
    $old = "$final.old";
    try {
        appstore_fetch_zip($app, $zipPath);
        appstore_unpack($app, $zipPath, $fresh);
    } finally {
        @unlink($zipPath);
    }
    // Into place: the old copy is moved aside, not deleted, until the list of apps on this server is saved too.
    appstore_rmdir($old);
    if (is_dir($final) && !@rename($final, $old)) {
        appstore_rmdir($fresh);
        throw new RuntimeException('The old copy of "' . $app['title'] . '" could not be moved aside. Nothing was changed.');
    }
    if (!@rename($fresh, $final)) {
        appstore_rmdir($fresh);
        if (is_dir($old)) {
            @rename($old, $final);
        }
        throw new RuntimeException('"' . $app['title'] . '" could not be put in place. Nothing was changed.');
    }
    $here = appstore_here($dataDir, $webRoot);
    $here[$app['id']] = ['id' => $app['id'], 'title' => $app['title'], 'icon' => $app['icon'], 'kind' => $app['kind'], 'version' => $app['version'], 'size' => $app['size']];
    try {
        appstore_save_here($dataDir, $here);
    } catch (RuntimeException $e) {
        // The list still names the old copy (or none): the folders go back to match it.
        @rename($final, $fresh);
        if (is_dir($old)) {
            @rename($old, $final);
        }
        appstore_rmdir($fresh);
        throw new RuntimeException('"' . $app['title'] . '" could not be added to the list of apps on this server, so the copy that was there before was kept. Nothing was changed.');
    }
    appstore_rmdir($old);

    return $here[$app['id']];
}

/**
 * Checks an app's zip from its own list of files (names, how many, how big), then unpacks it into $to a piece at a time,
 * each file checked against the size the zip states, so a zip that claims little and holds a lot cannot fill memory or
 * disk. A zip that fails part way leaves nothing behind.
 */
function appstore_unpack(array $app, string $zipPath, string $to): void
{
    $zip = new ZipArchive();
    if ($zip->open($zipPath) !== true) {
        throw new RuntimeException('"' . $app['title'] . '" could not be opened. Nothing was changed.');
    }
    try {
        $plan = [];
        $total = 0;
        for ($i = 0; $i < $zip->numFiles; $i++) {
            $stat = $zip->statIndex($i);
            $name = $stat === false ? '' : (string) $stat['name'];
            if ($stat !== false && str_ends_with($name, '/')) {
                continue;
            }
            if (!appstore_allowed_name($name)) {
                throw new RuntimeException('"' . $app['title'] . '" holds a file that is not allowed in an app (' . appstore_cut($name, 80) . '). Nothing was changed.');
            }
            $total += (int) $stat['size'];
            $plan[$name] = ['index' => $i, 'size' => (int) $stat['size']];
            if (count($plan) > APPSTORE_MAX_FILES || $total > APPSTORE_MAX_UNPACKED) {
                throw new RuntimeException('"' . $app['title'] . '" is far bigger than an app may be. Nothing was changed.');
            }
        }
        if (!isset($plan['index.html'])) {
            throw new RuntimeException('"' . $app['title'] . '" has no index.html, so it cannot open. Nothing was changed.');
        }
        appstore_rmdir($to);
        foreach ($plan as $name => $p) {
            $target = "$to/$name";
            $in = (!is_dir(dirname($target)) && !@mkdir(dirname($target), 0755, true)) ? false
                : (method_exists($zip, 'getStreamIndex') ? $zip->getStreamIndex($p['index']) : $zip->getStream($name));
            $out = $in === false ? false : @fopen($target, 'wb');
            $n = $out === false ? false : stream_copy_to_stream($in, $out, $p['size'] + 1);
            if (is_resource($in)) {
                fclose($in);
            }
            if ($out !== false) {
                fclose($out);
            }
            if ($n !== $p['size']) {
                appstore_rmdir($to);
                throw new RuntimeException('"' . $app['title'] . '" could not be read, or written on this server. Nothing was changed.');
            }
        }
    } finally {
        $zip->close();
    }
}

/** Deletes an app from this server. People who had added it simply no longer see it. */
function appstore_delete(string $id, string $dataDir, string $webRoot): void
{
    appstore_locked($dataDir, static function () use ($id, $dataDir, $webRoot): void {
        $here = appstore_here($dataDir, $webRoot);
        $folder = "$webRoot/apps/$id";
        $going = "$folder.deleting";
        appstore_rmdir($going);
        if (is_dir($folder) && !@rename($folder, $going)) {
            throw new RuntimeException('The app could not be deleted (its folder is in use). Nothing was changed. Try again.');
        }
        unset($here[$id]);
        try {
            appstore_save_here($dataDir, $here);
        } catch (RuntimeException $e) {
            @rename($going, $folder);
            throw $e;
        }
        appstore_rmdir($going);
    });
}

function appstore_rmdir(string $dir): void
{
    if (!is_dir($dir)) {
        return;
    }
    foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST) as $f) {
        $f->isDir() ? @rmdir($f->getPathname()) : @unlink($f->getPathname());
    }
    @rmdir($dir);
}
