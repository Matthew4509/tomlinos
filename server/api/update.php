<?php
// System update (lib/updater.php has the why and the rules).
//   GET  op=check     the version running, the newest signed release and its notes, whether a Go back is kept
//   POST op=install   the owner: download, check and install the newest release
//   POST op=rollback  the owner: put the version before the last update back
// Signed-in people may look; installing and going back are the owner's.
declare(strict_types=1);

require __DIR__ . '/../lib/http.php';
require __DIR__ . '/../lib/auth.php';
require __DIR__ . '/../lib/outbound.php';
require __DIR__ . '/../lib/updater.php';

api_headers();
api_guard(true);

$config = api_config();
$root = rtrim((string) $config['data_dir'], '/\\');
[, , $user] = require_full($root);
$owner = !empty($user['admin']);
$op = query_str('op');
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
// The web root: the site's document root (public_html on the host, out/ on the local test server, whose script is the
// router in server/, so the folder above the script would be the source folder itself).
$webRoot = rtrim((string) ($_SERVER['DOCUMENT_ROOT'] ?? ''), '/\\');
if ($webRoot === '' || !is_dir($webRoot)) {
    $webRoot = dirname((string) ($_SERVER['SCRIPT_FILENAME'] ?? ''), 2);
}

if ($op === 'check' && $method === 'GET') {
    // An install or Go back cut off part-way is put right before the versions are read (otherwise "Up to date" could be
    // said over a half-installed site). One running now holds the lock: then nothing is touched.
    if (update_operation(update_dir()) !== null) {
        try {
            update_locked(static fn (string $dir) => update_recover($dir));
        } catch (RuntimeException) {
            // Running now, or could not be put right: the install and Go back buttons say which.
        }
    }
    $current = update_current_version();
    $out = ['current' => $current, 'owner' => $owner, 'back' => update_backup_version(), 'latest' => null, 'newer' => false, 'error' => null];
    try {
        $r = update_fetch_release($config);
        $out['latest'] = ['version' => $r['version'], 'date' => $r['date'], 'notes' => $r['notes'], 'bytes' => $r['bytes']];
        $out['newer'] = update_newer($r['version'], $current);
    } catch (RuntimeException $e) {
        $out['error'] = $e->getMessage();
    }
    if ($owner) {
        $out['missing'] = update_missing($webRoot);
    }
    api_json($out);
}

if ($method !== 'POST' || !in_array($op, ['install', 'rollback'], true)) {
    api_fail(404, 'Unknown request.');
}
$body = api_body();
require_admin($user);
// Replacing the site's own code, or putting an earlier version back, is as far-reaching as it gets: the owner's own
// password (and code) first, as adding a person does, so someone at the owner's unlocked, unattended desktop cannot.
confirm_identity($root, $user, $body);
@set_time_limit(300);
try {
    if ($op === 'install') {
        $r = update_fetch_release($config);
        if (!update_newer($r['version'], update_current_version())) {
            api_fail(409, 'This TOMLIN OS is already up to date.');
        }
        api_json(['version' => update_install($r, $webRoot)]);
    }
    $v = update_rollback();
    if ($v === null) {
        api_fail(409, 'There is no earlier version kept to go back to.');
    }
    api_json(['version' => $v]);
} catch (RuntimeException $e) {
    api_fail(502, $e->getMessage());
}
