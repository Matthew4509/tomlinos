<?php
// The app store (lib/appstore.php has the why and the rules).
//   GET  op=here      the apps on this server (no outside request: the desktop asks this as it starts)
//   GET  op=list      the store's signed catalogue, what is on this server, and whether you may change that
//   POST op=download  the owner: {id} download (or update) that app onto this server
//   POST op=delete    the owner: {id} delete that app from this server
// Signed-in people may look; putting apps on the server and taking them off are the owner's.
declare(strict_types=1);

require __DIR__ . '/../lib/http.php';
require __DIR__ . '/../lib/auth.php';
require __DIR__ . '/../lib/outbound.php';
require __DIR__ . '/../lib/appstore.php';

api_headers();
api_guard();

$config = api_config();
$root = rtrim((string) $config['data_dir'], '/\\');
[, , $user] = require_full($root);
$owner = !empty($user['admin']);
$op = (string) ($_GET['op'] ?? '');
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
// The web root: public_html live, the built page (out/) on the dev server.
$webRoot = rtrim((string) ($_SERVER['DOCUMENT_ROOT'] ?? ''), '/\\');
if ($webRoot === '' || !is_dir($webRoot)) {
    api_fail(500, 'The server\'s web folder could not be found.');
}

if ($method === 'GET' && $op === 'here') {
    api_json(['apps' => array_values(appstore_here($root, $webRoot))]);
}
if ($method === 'GET' && $op === 'list') {
    $out = ['owner' => $owner, 'here' => array_values(appstore_here($root, $webRoot)), 'apps' => [], 'error' => null];
    try {
        $out['apps'] = array_map(fn ($a) => array_diff_key($a, ['zips' => 1, 'sha256' => 1]), appstore_catalogue($config));
    } catch (RuntimeException $e) {
        $out['error'] = $e->getMessage();
    }
    api_json($out);
}

if ($method !== 'POST' || !in_array($op, ['download', 'delete'], true)) {
    api_fail(404, 'Unknown request.');
}
$body = api_body();
require_admin($user);
$id = (string) ($body['id'] ?? '');
if (!appstore_valid_id($id)) {
    api_fail(400, 'That is not an app\'s name.');
}
@set_time_limit(300);
try {
    if ($op === 'delete') {
        appstore_delete($id, $root, $webRoot);
        api_json(['apps' => array_values(appstore_here($root, $webRoot))]);
    }
    $app = null;
    foreach (appstore_catalogue($config) as $a) {
        if ($a['id'] === $id) {
            $app = $a;
        }
    }
    if ($app === null) {
        api_fail(404, 'The app store has no app by that name (any more).');
    }
    appstore_download($app, $root, $webRoot);
    api_json(['apps' => array_values(appstore_here($root, $webRoot))]);
} catch (RuntimeException $e) {
    api_fail(502, $e->getMessage());
}
