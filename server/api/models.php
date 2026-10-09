<?php
// On-device AI models kept on this TOMLIN OS (lib/models.php has the why and the rules).
//   GET  op=list    the built-in models: saved here or not, a save's progress, where a browser gets one that is not
//                   saved here (Hugging Face at the pinned commit), the program's SHA-256 (the page checks it before
//                   running it), and how long until a removed one can be saved again
//   POST op=piece   {id}  the owner: fetch the next piece (16 MB at most) of a model onto this TOMLIN OS. The page asks
//                   again until the answer says saved; a stopped save carries on where it stopped. A file Hugging Face
//                   or GitHub no longer has comes from the model mirror instead
//   POST op=remove  {id}  the owner: delete a saved model (and a save in progress) to free the space; also a retired
//                   one (MODEL_RETIRED) still saved here. It can be saved again a day later
// Signed-in people only; saving and removing are the owner's.
declare(strict_types=1);

require __DIR__ . '/../lib/http.php';
require __DIR__ . '/../lib/auth.php';
require __DIR__ . '/../lib/outbound.php';
require __DIR__ . '/../lib/models.php';

api_headers();
api_guard();

$config = api_config();
$root = rtrim((string) $config['data_dir'], '/\\');
[, , $user] = require_full($root);
$dir = models_dir($config);
$op = (string) ($_GET['op'] ?? '');
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

/** The plan of a save in progress, or null. A plan from before versions were pinned is dropped with its part files. */
$planOf = static function (string $id) use ($root, $dir): ?array {
    $path = models_plan_path($root, $id);
    $plan = is_file($path) ? json_decode((string) file_get_contents($path), true) : null;
    if (!is_array($plan) || !is_array($plan['files'] ?? null)) {
        return null;
    }
    if (($plan['rev'] ?? '') === '') {
        foreach ($plan['files'] as $f) {
            if (is_array($f) && models_safe_path((string) ($f['path'] ?? '')) && in_array($f['kind'] ?? '', ['model', 'lib'], true)) {
                @unlink(models_target($dir, $id, $f) . '.part');
            }
        }
        @unlink($path);

        return null;
    }

    return $plan;
};
/** In words: "3 hours", "40 minutes". */
$waitWords = static fn (int $s): string => $s >= 5400 ? ceil($s / 3600) . ' hours' : max(1, (int) ceil($s / 60)) . ' minutes';
/** The saved program's checksum (kept in the index; worked out once for a model saved before it was kept). */
$savedLibSha = static function (array $saved) use ($dir): string {
    $sha = (string) ($saved['libSha256'] ?? '');
    if ($sha === '' && is_file($dir . '/libs/' . basename((string) ($saved['lib'] ?? '')))) {
        $sha = (string) hash_file('sha256', $dir . '/libs/' . basename((string) $saved['lib']));
        $index = models_index_read($dir);
        foreach ($index['models'] as &$m) {
            if (($m['id'] ?? '') === ($saved['id'] ?? null)) {
                $m['libSha256'] = $sha;
            }
        }
        unset($m);
        try {
            models_index_write($dir, $index);
        } catch (RuntimeException) {
            // Worked out again next time.
        }
    }

    return $sha;
};
/** Bytes held and bytes in all, for a plan. */
$progress = static function (string $id, array $plan) use ($dir): array {
    $have = 0;
    $total = 0;
    foreach ($plan['files'] as $f) {
        $held = models_have(models_target($dir, $id, $f));
        $have += $f['size'] === null ? $held : min($held, (int) $f['size']);
        $total += $f['size'] ?? 0;
    }

    return ['have' => $have, 'total' => $total];
};
$idFrom = static function (array $body): string {
    $id = body_str($body, 'id');
    if (!isset(MODEL_CATALOG[$id])) {
        api_fail(400, 'That is not one of the built-in models.');
    }

    return $id;
};

switch ("$method $op") {
    case 'GET list': {
        $saved = [];
        foreach (models_index_read($dir)['models'] as $m) {
            $saved[(string) ($m['id'] ?? '')] = $m;
        }
        $out = [];
        foreach (MODEL_CATALOG as $id => $c) {
            $plan = isset($saved[$id]) ? null : $planOf($id);
            $out[] = [
                'id' => $id, 'name' => $c['name'], 'lib' => basename($c['lib']), 'bytes' => (int) ($saved[$id]['bytes'] ?? $c['bytes']),
                'vram' => $c['vram'], 'context' => $c['overrides']['context_window_size'] ?? null, 'overrides' => $c['overrides'],
                'saved' => isset($saved[$id]), 'saving' => $plan ? $progress($id, $plan) : null,
                // Where a browser fetches it when it is not saved here (the page's security policy allows these hosts).
                'from' => models_browser_from($id),
                'libSha256' => isset($saved[$id]) ? $savedLibSha($saved[$id]) : models_lib_sha($c['lib']),
                'resaveWait' => isset($saved[$id]) ? 0 : models_resave_wait($root, $id),
            ];
        }
        foreach (MODEL_RETIRED as $id => $name) {
            if (isset($saved[$id])) {
                $out[] = ['id' => $id, 'name' => $name, 'bytes' => (int) ($saved[$id]['bytes'] ?? 0), 'saved' => true, 'retired' => true];
            }
        }
        $free = @disk_free_space(is_dir($dir) ? $dir : dirname($dir));
        api_json(['models' => $out, 'owner' => !empty($user['admin']), 'free' => $free === false ? null : (int) $free]);
    }

    case 'POST piece': {
        require_admin($user);
        $id = $idFrom(api_body());
        if (!is_dir($root . '/models') && !mkdir($root . '/models', 0700, true) && !is_dir($root . '/models')) {
            api_fail(500, 'The server could not make its working folder for model saves.');
        }
        // One save at a time per model: two at once would write into the same file.
        $lock = fopen($root . '/models/' . $id . '.lock', 'c');
        if ($lock === false || !flock($lock, LOCK_EX | LOCK_NB)) {
            api_fail(409, 'This model is already being saved (in another window?). Wait for that to finish.');
        }
        @set_time_limit(180);
        try {
            if (in_array($id, array_column(models_index_read($dir)['models'], 'id'), true)) {
                api_json(['saved' => true]);
            }
            $plan = $planOf($id);
            if ($plan === null) {
                if (($wait = models_resave_wait($root, $id)) > 0) {
                    api_fail(429, sprintf('%s was removed from this TOMLIN OS less than a day ago, so it can be saved again in %s. Until then, browsers fetch it from Hugging Face.', MODEL_CATALOG[$id]['name'], $waitWords($wait)), ['wait' => $wait]);
                }
                $plan = models_make_plan($id);
                $need = 0;
                foreach ($plan['files'] as $f) {
                    $need += (int) ($f['size'] ?? 0);
                }
                $free = @disk_free_space(is_dir($dir) ? $dir : dirname($dir));
                if ($free !== false && $free < $need + 50 * 1024 * 1024) {
                    api_fail(507, sprintf('This server has %s free, and this model needs %s (and a little room to spare). Free some space, or leave it unsaved: browsers then fetch it from Hugging Face.', round($free / 1048576) . ' MB', round($need / 1048576) . ' MB'));
                }
                models_write_atomic(models_plan_path($root, $id), json_encode($plan));
                auth_history_add($root, (string) $user['id'], 'Started saving the AI model ' . MODEL_CATALOG[$id]['name'] . ' to this TOMLIN OS');
            }
            $step = models_save_step($dir, $id, $plan, models_mirror_url($config));
            if ($step['changed']) {
                models_write_atomic(models_plan_path($root, $id), json_encode($plan));
            }
            if ($step['mirror'] !== null) {
                auth_history_add($root, (string) $user['id'], 'Fetching part of ' . MODEL_CATALOG[$id]['name'] . ' from the model mirror (config.php): ' . $step['mirror']);
            }
            if (!$step['done']) {
                api_json(['saved' => false] + $progress($id, $plan));
            }
            models_ensure_htaccess($dir);
            models_index_add($dir, $id, $plan);
            @unlink(models_plan_path($root, $id));
            auth_history_add($root, (string) $user['id'], 'Saved the AI model ' . MODEL_CATALOG[$id]['name'] . ' to this TOMLIN OS');
            api_json(['saved' => true] + $progress($id, $plan));
        } catch (RuntimeException $e) {
            api_fail(502, $e->getMessage());
        } finally {
            flock($lock, LOCK_UN);
            fclose($lock);
        }
    }

    case 'POST remove': {
        require_admin($user);
        $body = api_body();
        $id = body_str($body, 'id');
        $name = MODEL_RETIRED[$id] ?? MODEL_CATALOG[$idFrom($body)]['name'];
        $lock = is_dir($root . '/models') ? fopen($root . '/models/' . $id . '.lock', 'c') : null;
        if ($lock === false || ($lock && !flock($lock, LOCK_EX | LOCK_NB))) {
            api_fail(409, 'This model is being saved right now. Stop the save first, then remove it.');
        }
        try {
            models_remove($dir, $id);
        } catch (Throwable) {
            api_fail(500, 'Some of the model\'s files could not be deleted. Try again; if it keeps failing, delete the folder models/' . $id . ' in the host\'s file manager.');
        }
        @unlink(models_plan_path($root, $id));
        if (isset(MODEL_CATALOG[$id])) {
            try {
                models_note_removed($root, $id);
            } catch (RuntimeException) {
                // Not remembered: it can then be saved again at once.
            }
        }
        auth_history_add($root, (string) $user['id'], 'Removed the AI model ' . $name . ' from this TOMLIN OS');
        api_json(['ok' => true]);
    }

    default:
        api_fail(400, 'Unknown request.');
}
