<?php
// The on-device AI model files saved on this TOMLIN OS (api/models.php saves them), for signed-in people only. They sit
// in the private folder (tomlinos/models, beside data/), never in the web root: public_html/.htaccess hands every
// /models/<path> address to this file, and so does the dev router. The browser asks for the part it still needs
// (Range), so a broken download carries on instead of starting again.
// Signed out: 401. Screen locked: 423. Another site, or anything that is not a saved model file: refused.
declare(strict_types=1);

require __DIR__ . '/../lib/http.php';
require __DIR__ . '/../lib/auth.php';
require __DIR__ . '/../lib/models.php';

api_headers();
$config = api_config();
// The checks of api_guard() less the desktop's own header, which the AI library cannot add to the requests it makes.
if (!api_is_local() && empty($config['allow_remote'])) {
    api_fail(403, 'This desktop only answers the computer it runs on.');
}
if (!api_is_local() && !api_https()) {
    api_fail(403, 'This desktop only answers over a secure connection. Open it with https:// at the start of the address.');
}
// Only the desktop's own page: not another site, and not an address typed or pasted into a browser tab.
$site = (string) ($_SERVER['HTTP_SEC_FETCH_SITE'] ?? '');
if ($site !== '' && $site !== 'same-origin') {
    api_fail(403, 'The AI model files are only for the desktop itself.');
}
$origin = (string) ($_SERVER['HTTP_ORIGIN'] ?? '');
if ($origin !== '') {
    $host = parse_url($origin, PHP_URL_HOST) . (parse_url($origin, PHP_URL_PORT) ? ':' . parse_url($origin, PHP_URL_PORT) : '');
    if ($host !== ($_SERVER['HTTP_HOST'] ?? '')) {
        api_fail(403, 'Requests from other sites are refused.');
    }
}
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method !== 'GET' && $method !== 'HEAD') {
    header('Allow: GET, HEAD');
    api_fail(405, 'Model files can only be read.');
}

require_full(rtrim((string) $config['data_dir'], '/\\'));

$notFound = static function (): never {
    api_fail(404, 'There is no such model file on this TOMLIN OS.');
};
// The address the browser asked for: after the .htaccess rewrite, REQUEST_URI still holds it.
$path = (string) (parse_url((string) ($_SERVER['REQUEST_URI'] ?? ''), PHP_URL_PATH) ?: '');
if (!str_starts_with($path, '/models/')) {
    $notFound();
}
$rel = rawurldecode(substr($path, 8));
$types = ['json' => 'application/json', 'bin' => 'application/octet-stream', 'wasm' => 'application/wasm', 'txt' => 'text/plain; charset=utf-8', 'model' => 'application/octet-stream'];
$ext = strtolower(pathinfo($rel, PATHINFO_EXTENSION));
if (!models_safe_path($rel) || !isset($types[$ext])) {
    $notFound();
}
$base = realpath(models_dir($config));
$file = $base === false ? false : realpath($base . '/' . $rel);
if ($file === false || !is_file($file) || !str_starts_with($file, $base . DIRECTORY_SEPARATOR)) {
    $notFound();
}

$size = (int) filesize($file);
$from = 0;
$to = $size - 1;
header('Content-Type: ' . $types[$ext]);
header('Accept-Ranges: bytes');
// Cache-Control stays "no-store" (api_headers): nothing is left in the browser's own cache after signing out, where a
// typed address would still open it. The AI library keeps its own copy only when "Keep the model in this browser" is
// ticked.
if (preg_match('/^bytes=(\d*)-(\d*)$/', (string) ($_SERVER['HTTP_RANGE'] ?? ''), $r) && ($r[1] !== '' || $r[2] !== '')) {
    $from = $r[1] === '' ? max(0, $size - (int) $r[2]) : (int) $r[1];
    $to = $r[1] === '' || $r[2] === '' ? $size - 1 : min((int) $r[2], $size - 1);
    if ($from > $to || $from >= $size) {
        http_response_code(416);
        header("Content-Range: bytes */$size");
        exit;
    }
    http_response_code(206);
    header("Content-Range: bytes $from-$to/$size");
}
header('Content-Length: ' . ($to - $from + 1));
if ($method === 'HEAD') {
    exit;
}
// A model file can be hundreds of MB: send it as it is read, not gathered in memory, and not cut off by the time limit.
@set_time_limit(0);
@ini_set('zlib.output_compression', '0');
while (ob_get_level() > 0) {
    ob_end_clean();
}
$fh = fopen($file, 'rb');
fseek($fh, $from);
for ($left = $to - $from + 1; $left > 0 && !feof($fh) && !connection_aborted(); $left -= 1048576) {
    echo fread($fh, (int) min(1048576, $left));
    flush();
}
fclose($fh);
