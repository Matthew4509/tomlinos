<?php
// The TOMLIN OS model mirror (put in a site's aimodels/ folder): copies of the built-in AI models' files, at exactly the versions
// TOMLIN OS is pinned to, for TOMLIN OS servers whose owner presses Save after Hugging Face or GitHub has removed or changed
// that version. Every file is checked against the pinned SHA-256 when it is put here and again by the server that
// fetches it.
//
// It serves TOMLIN OS servers only, never browsers: a request that carries a browser's own headers is refused, so a page
// cannot stream a model from here (browsers get models from Hugging Face or from their own TOMLIN OS). Each server address
// may take a daily share (per_address_gb), and all of them together a daily total (total_gb): past it, "come back
// tomorrow". Nothing here is secret (the files are the models' public releases); the limits keep the bandwidth bill down.
//
//   GET ?id=<model>&rev=<commit>&file=<path>     one model file (a Range asks for a piece, answered 206)
//   GET ?lib=<program>&rev=<commit>              one WebGPU program
// From the host's Terminal (never the web):
//   php index.php fill             fetches every built-in model from Hugging Face (about 4.3 GB) into the files folder
//   php index.php fill <model id>  just that one; a stopped fill carries on where it stopped
//   php index.php status           what is here, and today's use
// Settings: config.php beside this file may return ['files' => folder, 'per_address_gb' => 8, 'total_gb' => 100]. The
// files folder defaults to aimodels-files beside the web root (outside it, so it is only reached through this door).
declare(strict_types=1);

require is_file(__DIR__ . '/lib/models.php') ? __DIR__ . '/lib/models.php' : __DIR__ . '/../server/lib/models.php';

function mirror_config(): array
{
    $set = is_file(__DIR__ . '/config.php') ? require __DIR__ . '/config.php' : [];
    $config = (is_array($set) ? $set : []) + ['files' => dirname(__DIR__, 2) . '/aimodels-files', 'per_address_gb' => 8, 'total_gb' => 100];
    // The tests point the files folder elsewhere (an environment variable only).
    if ((string) getenv('DESKTOP_MIRROR_FILES') !== '') {
        $config['files'] = (string) getenv('DESKTOP_MIRROR_FILES');
    }

    return $config;
}

/** The address a daily share is counted against: an IPv6 address by its /64 (one home or server gets a whole /64). */
function mirror_address(): string
{
    $ip = (string) ($_SERVER['REMOTE_ADDR'] ?? '');
    if (str_contains($ip, ':') && ($bin = @inet_pton($ip)) !== false) {
        return bin2hex(substr($bin, 0, 8)) . '::/64';
    }

    return $ip;
}

function mirror_refuse(int $status, string $words): never
{
    http_response_code($status);
    header('Content-Type: text/plain; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    echo $words, "\n";
    exit;
}

/**
 * Counts $bytes against today's shares, or refuses when they would go past one. The count is kept in the files folder,
 * under a lock, and starts again each day (UTC).
 */
function mirror_take(array $config, int $bytes): void
{
    $path = rtrim((string) $config['files'], '/\\') . '/.usage.json';
    $fh = fopen($path, 'c+');
    if ($fh === false || !flock($fh, LOCK_EX)) {
        mirror_refuse(503, 'The mirror is busy. Try again in a minute.');
    }
    $day = gmdate('Y-m-d');
    $use = json_decode((string) stream_get_contents($fh), true);
    if (!is_array($use) || ($use['day'] ?? '') !== $day) {
        $use = ['day' => $day, 'total' => 0, 'by' => []];
    }
    $who = mirror_address();
    $mine = (int) ($use['by'][$who] ?? 0);
    $gb = 1024 * 1024 * 1024;
    if ($mine + $bytes > (float) $config['per_address_gb'] * $gb) {
        flock($fh, LOCK_UN);
        mirror_refuse(429, 'This server has taken its share from this model mirror today (' . $config['per_address_gb'] . ' GB). Press Save again tomorrow.');
    }
    if ((int) $use['total'] + $bytes > (float) $config['total_gb'] * $gb) {
        flock($fh, LOCK_UN);
        mirror_refuse(429, 'This model mirror has sent all it can today. Press Save again tomorrow.');
    }
    $use['by'][$who] = $mine + $bytes;
    $use['total'] = (int) $use['total'] + $bytes;
    ftruncate($fh, 0);
    rewind($fh);
    fwrite($fh, json_encode($use));
    fflush($fh);
    flock($fh, LOCK_UN);
    fclose($fh);
}

/** The file asked for, as a planned file (models_target finds it), or a refusal. */
function mirror_wanted(): array
{
    $pins = models_pins();
    $rev = (string) ($_GET['rev'] ?? '');
    if (isset($_GET['lib'])) {
        $name = (string) $_GET['lib'];
        if (!isset($pins['libs'][$name]) || !models_safe_path($name)) {
            mirror_refuse(404, 'The mirror has no such program.');
        }
        if ($rev !== $pins['libsCommit']) {
            mirror_refuse(404, 'The mirror holds another version of the programs. This TOMLIN OS may need updating.');
        }

        return ['', ['kind' => 'lib', 'path' => $name]];
    }
    $id = (string) ($_GET['id'] ?? '');
    $file = (string) ($_GET['file'] ?? '');
    $pin = isset(MODEL_CATALOG[$id]) ? ($pins['models'][$id] ?? null) : null;
    if (!is_array($pin) || !in_array($file, array_column($pin['files'], 'path'), true) || !models_safe_path($file)) {
        mirror_refuse(404, 'The mirror has no such model file.');
    }
    if ($rev !== $pin['rev']) {
        mirror_refuse(404, 'The mirror holds another version of this model. This TOMLIN OS may need updating.');
    }

    return [$id, ['kind' => 'model', 'path' => $file]];
}

function mirror_serve(array $config): never
{
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if ($method !== 'GET' && $method !== 'HEAD') {
        header('Allow: GET, HEAD');
        mirror_refuse(405, 'Only GET.');
    }
    // A browser sends these on every request it makes (and an Origin when a page fetches): browsers are not served.
    foreach (['HTTP_SEC_FETCH_MODE', 'HTTP_SEC_FETCH_SITE', 'HTTP_SEC_FETCH_DEST', 'HTTP_ORIGIN'] as $h) {
        if (isset($_SERVER[$h])) {
            mirror_refuse(403, 'This folder holds AI model copies for TOMLIN OS servers. Browsers get models from Hugging Face or from their own TOMLIN OS.');
        }
    }
    if (!str_starts_with((string) ($_SERVER['HTTP_USER_AGENT'] ?? ''), 'TomlinOS')) {
        mirror_refuse(403, 'This folder holds AI model copies for TOMLIN OS servers only.');
    }
    [$id, $want] = mirror_wanted();
    $path = models_target(rtrim((string) $config['files'], '/\\'), $id, $want);
    if (!is_file($path)) {
        mirror_refuse(404, 'The mirror does not hold that file yet.');
    }
    $size = (int) filesize($path);
    $from = 0;
    $to = $size - 1;
    $range = (string) ($_SERVER['HTTP_RANGE'] ?? '');
    if ($range !== '') {
        if (!preg_match('/^bytes=(\d+)-(\d*)$/D', $range, $m) || (int) $m[1] >= $size) {
            header('Content-Range: bytes */' . $size);
            mirror_refuse(416, 'That part of the file does not exist.');
        }
        $from = (int) $m[1];
        $to = $m[2] === '' ? $size - 1 : min((int) $m[2], $size - 1);
        if ($to < $from) {
            header('Content-Range: bytes */' . $size);
            mirror_refuse(416, 'That part of the file does not exist.');
        }
    }
    $length = $to - $from + 1;
    if ($method === 'GET') {
        mirror_take($config, $length);
    }
    http_response_code($range !== '' ? 206 : 200);
    header('Content-Type: application/octet-stream');
    header('Content-Length: ' . $length);
    header('Accept-Ranges: bytes');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    if ($range !== '') {
        header('Content-Range: bytes ' . $from . '-' . $to . '/' . $size);
    }
    if ($method === 'HEAD') {
        exit;
    }
    @set_time_limit(300);
    $fh = fopen($path, 'rb');
    fseek($fh, $from);
    $left = $length;
    while ($left > 0 && !feof($fh) && !connection_aborted()) {
        $chunk = (string) fread($fh, min(1048576, $left));
        echo $chunk;
        flush();
        $left -= strlen($chunk);
    }
    fclose($fh);
    exit;
}

/** Terminal only: fetches the pinned files from Hugging Face and GitHub, each checked, into the files folder. */
function mirror_fill(array $config, array $ids): void
{
    $dir = rtrim((string) $config['files'], '/\\');
    foreach ($ids ?: array_keys(MODEL_CATALOG) as $id) {
        if (!isset(MODEL_CATALOG[$id])) {
            fwrite(STDERR, "$id is not one of the built-in models: " . implode(', ', array_keys(MODEL_CATALOG)) . "\n");
            exit(1);
        }
        $plan = models_make_plan($id);
        $total = array_sum(array_column($plan['files'], 'size'));
        foreach ($plan['files'] as $f) {
            do {
                $r = models_fetch_piece($dir, $id, $f);
                $have = 0;
                foreach ($plan['files'] as $g) {
                    $have += min(models_have(models_target($dir, $id, $g)), (int) $g['size']);
                }
                printf("\r%s: %d of %d MB", MODEL_CATALOG[$id]['name'], $have / 1048576, $total / 1048576);
            } while (!$r['done']);
        }
        models_ensure_htaccess($dir);
        models_index_add($dir, $id, $plan);
        echo "  checked and kept\n";
    }
}

function mirror_status(array $config): void
{
    $dir = rtrim((string) $config['files'], '/\\');
    echo "Files folder: $dir\n";
    foreach (MODEL_CATALOG as $id => $c) {
        $plan = models_make_plan($id);
        $done = count(array_filter($plan['files'], static fn ($f) => is_file(models_target($dir, $id, $f))));
        printf("%-30s %s (%d of %d files)\n", $c['name'], $done === count($plan['files']) ? 'held' : 'NOT complete: run  php index.php fill ' . $id, $done, count($plan['files']));
    }
    $use = json_decode((string) @file_get_contents($dir . '/.usage.json'), true);
    printf("Sent today: %.2f GB of %s GB (%d servers)\n", (is_array($use) && ($use['day'] ?? '') === gmdate('Y-m-d') ? (int) $use['total'] : 0) / 1073741824, $config['total_gb'], is_array($use) && ($use['day'] ?? '') === gmdate('Y-m-d') ? count($use['by']) : 0);
}

$config = mirror_config();
if (PHP_SAPI === 'cli') {
    $args = array_slice($argv, 1);
    try {
        if (($args[0] ?? '') === 'fill') {
            if (!is_dir($config['files']) && !mkdir($config['files'], 0755, true) && !is_dir($config['files'])) {
                fwrite(STDERR, 'Could not make the files folder ' . $config['files'] . "\n");
                exit(1);
            }
            mirror_fill($config, array_slice($args, 1));
        } elseif (($args[0] ?? '') === 'status') {
            mirror_status($config);
        } else {
            echo "Use:  php index.php fill [model id]   or   php index.php status\n";
        }
    } catch (RuntimeException $e) {
        fwrite(STDERR, "\n" . $e->getMessage() . "\n");
        exit(1);
    }
    exit(0);
}
mirror_serve($config);
