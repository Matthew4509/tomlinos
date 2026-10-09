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

const APPSTORE_SOURCES = [
    'https://raw.githubusercontent.com/Matthew4509/Tomlinos/main/appstore/catalogue.json',
];
const APPSTORE_MAX_ZIP = 48 * 1024 * 1024;
const APPSTORE_MAX_UNPACKED = 96 * 1024 * 1024;
const APPSTORE_MAX_FILES = 3000;
const APPSTORE_TYPES = ['html', 'js', 'mjs', 'css', 'json', 'txt', 'md', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico',
    'woff', 'woff2', 'ttf', 'otf', 'mp3', 'ogg', 'oga', 'wav', 'm4a', 'mp4', 'webm', 'wasm', 'csv', 'xml', 'pdf'];
const APPSTORE_KINDS = ['games', 'office', 'system'];

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
        'title' => mb_substr(trim((string) ($a['title'] ?? $a['id'])), 0, 60),
        'icon' => preg_match('/^[a-z][a-z0-9-]{0,30}$/', (string) ($a['icon'] ?? '')) ? (string) $a['icon'] : 'app',
        'kind' => in_array($a['kind'] ?? '', APPSTORE_KINDS, true) ? (string) $a['kind'] : 'office',
        'version' => (string) $a['version'],
        'date' => mb_substr((string) ($a['date'] ?? ''), 0, 20),
        'notes' => mb_substr((string) ($a['notes'] ?? ''), 0, 2000),
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
    if (file_put_contents($file . '.new', json_encode($here, JSON_PRETTY_PRINT)) === false || !rename($file . '.new', $file)) {
        throw new RuntimeException('The list of apps on this server could not be saved.');
    }
}

/** A path inside an app's zip that may be unpacked: plain web files only, no hidden files, nothing outside. */
function appstore_allowed_name(string $name): bool
{
    if (!preg_match('#^[A-Za-z0-9_-][A-Za-z0-9._-]*(/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$#', $name) || str_contains($name, '..')) {
        return false;
    }

    return in_array(strtolower(pathinfo($name, PATHINFO_EXTENSION)), APPSTORE_TYPES, true);
}

/** Downloads the app's zip into $to, trying each of its addresses. Throws RuntimeException. */
function appstore_fetch_zip(array $app, string $to): void
{
    $local = (string) getenv('DESKTOP_APPSTORE_DIR');
    $urls = $local !== '' ? array_map(fn ($u) => $local . '/' . basename(parse_url($u, PHP_URL_PATH) ?: ''), $app['zips']) : $app['zips'];
    foreach ($urls as $url) {
        // A GitHub release file answers with a redirect to GitHub's file host: followed, and the signed fingerprint
        // below decides whether what arrived is the app.
        $ctx = stream_context_create(['http' => ['timeout' => 60, 'follow_location' => 1, 'max_redirects' => 5, 'header' => "User-Agent: TomlinOS\r\n"],
            'ssl' => ['verify_peer' => true, 'verify_peer_name' => true]]);
        $in = @fopen($url, 'rb', false, $ctx);
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
    foreach (['zip' => 'zip (opens the app)', 'openssl' => 'openssl (secure downloads)'] as $ext => $why) {
        if (!extension_loaded($ext)) {
            throw new RuntimeException("The PHP extension $why is off on this server. The owner can switch it on in the host's PHP settings.");
        }
    }
    $apps = $webRoot . '/apps';
    if (!is_dir($apps) && !@mkdir($apps, 0755, true)) {
        throw new RuntimeException("PHP may not make the folder $apps.");
    }
    // Belt and braces: whatever is in apps/, no script runs there and nothing hidden is served.
    @file_put_contents($apps . '/.htaccess', "Options -Indexes -ExecCGI\nRemoveHandler .php .phtml .phar .cgi .pl .py\n<FilesMatch \"(?i)(\\.(php\\d*|phtml|phar|cgi|pl|py|sh)$|^\\.)\">\n  Require all denied\n</FilesMatch>\n");
    $zipPath = $dataDir . '/appstore-download.zip';
    appstore_fetch_zip($app, $zipPath);
    $zip = new ZipArchive();
    if ($zip->open($zipPath) !== true) {
        @unlink($zipPath);
        throw new RuntimeException('"' . $app['title'] . '" could not be opened. Nothing was changed.');
    }
    // Read and check everything first: a zip that fails part way changes nothing.
    $files = [];
    $total = 0;
    for ($i = 0; $i < $zip->numFiles; $i++) {
        $name = (string) $zip->getNameIndex($i);
        if (str_ends_with($name, '/')) {
            continue;
        }
        if (!appstore_allowed_name($name)) {
            $zip->close();
            @unlink($zipPath);
            throw new RuntimeException('"' . $app['title'] . '" holds a file that is not allowed in an app (' . mb_substr($name, 0, 80) . '). Nothing was changed.');
        }
        $bytes = $zip->getFromIndex($i);
        $total += $bytes === false ? 0 : strlen($bytes);
        if ($bytes === false || count($files) >= APPSTORE_MAX_FILES || $total > APPSTORE_MAX_UNPACKED) {
            $zip->close();
            @unlink($zipPath);
            throw new RuntimeException('"' . $app['title'] . '" could not be read, or is far bigger than an app may be. Nothing was changed.');
        }
        $files[$name] = $bytes;
    }
    $zip->close();
    @unlink($zipPath);
    if (!isset($files['index.html'])) {
        throw new RuntimeException('"' . $app['title'] . '" has no index.html, so it cannot open. Nothing was changed.');
    }
    $final = "$apps/{$app['id']}";
    $fresh = "$final.new";
    $old = "$final.old";
    appstore_rmdir($fresh);
    foreach ($files as $name => $bytes) {
        $target = "$fresh/$name";
        if ((!is_dir(dirname($target)) && !@mkdir(dirname($target), 0755, true)) || file_put_contents($target, $bytes) === false) {
            appstore_rmdir($fresh);
            throw new RuntimeException('"' . $app['title'] . '" could not be written on this server. Nothing was changed.');
        }
    }
    appstore_rmdir($old);
    if (is_dir($final) && !rename($final, $old)) {
        appstore_rmdir($fresh);
        throw new RuntimeException('The old copy of "' . $app['title'] . '" could not be moved aside. Nothing was changed.');
    }
    if (!rename($fresh, $final)) {
        if (is_dir($old)) {
            rename($old, $final);
        }
        throw new RuntimeException('"' . $app['title'] . '" could not be put in place. Nothing was changed.');
    }
    appstore_rmdir($old);
    $here = appstore_here($dataDir, $webRoot);
    $here[$app['id']] = ['id' => $app['id'], 'title' => $app['title'], 'icon' => $app['icon'], 'kind' => $app['kind'], 'version' => $app['version'], 'size' => $app['size']];
    appstore_save_here($dataDir, $here);

    return $here[$app['id']];
}

/** Deletes an app from this server. People who had added it simply no longer see it. */
function appstore_delete(string $id, string $dataDir, string $webRoot): void
{
    $here = appstore_here($dataDir, $webRoot);
    appstore_rmdir("$webRoot/apps/$id");
    unset($here[$id]);
    appstore_save_here($dataDir, $here);
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
