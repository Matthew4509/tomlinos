<?php
// Router for PHP's built-in web server, for trying the server-stored desktop on your own computer (from the repository folder):
//   php -d post_max_size=300M -S 127.0.0.1:3042 -t out server/dev-router.php
// It serves the built desktop from out/ with the security headers the live server sends (both from
// security-headers.json), the store API at /api/store.php, the accounts API at /api/auth.php, and /storage.json, which tells the desktop to keep its files on this
// server instead of in the browser. Going live on cPanel (phase 6) uploads the same pieces as plain files.
declare(strict_types=1);

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';

// Every file in server/api/ is an API, as on the live server (tools/package.mjs puts a door in public_html/api/ for each).
if (preg_match('#^/api/([a-z]+)\.php$#', $path, $m) && is_file(__DIR__ . '/api/' . $m[1] . '.php')) {
    require __DIR__ . '/api/' . $m[1] . '.php';

    return true;
}

/** The headers from security-headers.json, the one list (tools/package.mjs writes the same into the live .htaccess). */
function security_headers(): void
{
    static $spec = null;
    header_remove('X-Powered-By');
    $spec ??= json_decode((string) file_get_contents(__DIR__ . '/../security-headers.json'), true, 16, JSON_THROW_ON_ERROR);
    $csp = [];
    foreach ($spec['csp'] as $name => $sources) {
        $csp[] = $name . ' ' . implode(' ', $sources);
    }
    header('Content-Security-Policy: ' . implode('; ', $csp));
    foreach ($spec['headers'] as $name => $value) {
        header($name . ': ' . $value);
    }
}

if ($path === '/storage.json') {
    security_headers();
    header('Content-Type: application/json');
    header('Cache-Control: no-store');
    echo json_encode(['backend' => 'server', 'api' => '/api/store.php', 'auth' => '/api/auth.php']);

    return true;
}

// On-device AI models (tools/fetch-model.mjs puts them in models/ beside out/; live, in tomlinos/models beside data/):
// only for signed-in people, through api/modelfile.php, exactly as public_html/.htaccess does it live. The browser
// tests point the folder at a throw-away one (DESKTOP_MODELS_DIR), as the models API does.
if (str_starts_with($path, '/models/')) {
    require __DIR__ . '/api/modelfile.php';

    return true;
}

// Static files from the document root (out/), with the headers above and a fixed list of content types.
$root = realpath($_SERVER['DOCUMENT_ROOT']);
// A folder's own page, as the live server does (/reader/ is reader/index.html).
$rel = str_ends_with($path, '/') ? rawurldecode($path) . 'index.html' : rawurldecode($path);
// A null byte (/%00) makes realpath() throw, which would print the server's own folders: simply not found.
$file = $root === false || str_contains($rel, "\0") ? false : realpath($root . $rel);
$types = [
    'html' => 'text/html; charset=utf-8', 'js' => 'text/javascript; charset=utf-8', 'css' => 'text/css; charset=utf-8',
    'json' => 'application/json', 'png' => 'image/png', 'svg' => 'image/svg+xml', 'ico' => 'image/x-icon',
    'woff2' => 'font/woff2', 'txt' => 'text/plain; charset=utf-8',
    // Store apps (lib/appstore.php) may also carry these.
    'mjs' => 'text/javascript; charset=utf-8', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'gif' => 'image/gif', 'webp' => 'image/webp',
    'mp3' => 'audio/mpeg', 'ogg' => 'audio/ogg', 'wav' => 'audio/wav', 'mp4' => 'video/mp4', 'webm' => 'video/webm', 'wasm' => 'application/wasm',
];
$ext = $file === false ? '' : strtolower(pathinfo($file, PATHINFO_EXTENSION));
if ($file === false || !is_file($file) || strncmp($file, $root . DIRECTORY_SEPARATOR, strlen($root) + 1) !== 0 || !isset($types[$ext])) {
    security_headers();
    http_response_code(404);
    header('Content-Type: text/plain; charset=utf-8');
    echo 'Not found';

    return true;
}
security_headers();
// Store apps run in a sandboxed frame (an origin of their own), so their files and the Reader's they open are fetched
// across origins: allowed, as on the live server (tools/package.mjs). They are public files anyway.
if (preg_match('#^/(apps|reader)/#', $path)) {
    header('Access-Control-Allow-Origin: *');
}
// An app's page opened on its own is as sandboxed as in its frame (a second policy, as live: it only adds limits). By
// the file it reached, not the address: /%61pps/ and, on Windows, /APPS/ reach the same files.
$apps = $root . DIRECTORY_SEPARATOR . 'apps' . DIRECTORY_SEPARATOR;
if (strncasecmp($file, $apps, strlen($apps)) === 0) {
    header('Content-Security-Policy: sandbox allow-scripts', false);
}
header('Content-Type: ' . $types[$ext]);
header('Cache-Control: no-store');
readfile($file);

return true;
