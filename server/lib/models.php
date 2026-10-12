<?php
// On-device AI models kept on this TOMLIN OS. A model saved here is fetched by browsers from this TOMLIN OS, not from Hugging
// Face, so many people do not each download a 1 GB model from outside; a host's size limits may mean saving only some.
//
// The owner presses Save: the page asks the server for one piece at a time (16 MB, one request each, so no request runs
// into a host's time limit, and a stopped save carries on where it stopped). What is fetched is pinned: one commit of
// each model's Hugging Face repository and one commit of the MLC team's programs, with every file's size and SHA-256
// (model-pins.json, written by tools/pin-models.mjs). A file that differs is thrown away, so a model changed or swapped
// upstream is never used. The files land in the private models folder (models/ here; tomlinos/models live, beside data/,
// outside the web root), and reach browsers only through api/modelfile.php, for signed-in people.
//
// When Hugging Face or GitHub no longer has a pinned file (removed, or refused), the save can fetch it from a model
// mirror the owner names (config 'model_mirror'; none by default; a mirror's own door is mirror/index.php). Browsers never
// fetch from a mirror: only a TOMLIN OS server does, and the mirror limits how much each server takes a day.
//
// Only the models in MODEL_CATALOG can be saved (never an address from a request), and only from https addresses on
// Hugging Face, GitHub and the mirror, checked at every redirect.
declare(strict_types=1);

const MODEL_PIECE_BYTES = 16 * 1024 * 1024;
/** Where a TOMLIN OS server fetches a pinned file that Hugging Face or GitHub no longer has. */
const MODEL_MIRROR_DEFAULT = '';
/** After the owner removes a model, it can be saved again only after this long (a mirror's bandwidth is shared). */
const MODEL_RESAVE_WAIT = 86400;
const MODEL_LIBS_REPO = 'mlc-ai/binary-mlc-llm-libs';

/** The pinned file could not come from where it was asked for (gone, refused, or not the pinned bytes): try the mirror. */
class ModelSourceGone extends RuntimeException
{
    /** $refused: the source answered that it does not have it (or will not give it), rather than sending other bytes. */
    public function __construct(string $message, public readonly bool $refused = false)
    {
        parent::__construct($message);
    }
}

/**
 * The built-in models. Copied from the model list of the WebLLM this TOMLIN OS ships (test/models-server.test.ts checks
 * they still agree); 'lib' is WebLLM's address for the program, which is fetched at the pinned commit (models_lib_url).
 */
const MODEL_CATALOG = [
    'Qwen3.5-0.8B-q4f32_1-MLC' => [
        'name' => 'Qwen 3.5 0.8B',
        'bytes' => 447173765,
        'repo' => 'mlc-ai/Qwen3.5-0.8B-q4f32_1-MLC',
        'lib' => 'https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_84/base/Qwen3.5-0.8B-q4f32_1_cs1k-webgpu.wasm',
        'vram' => 1894,
        'overrides' => ['context_window_size' => 4096, 'max_history_size' => 1],
    ],
    'gemma-2-2b-it-q4f32_1-MLC' => [
        'name' => 'Gemma 2 2B',
        'bytes' => 1493114998,
        'repo' => 'mlc-ai/gemma-2-2b-it-q4f32_1-MLC',
        'lib' => 'https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_84/base/gemma-2-2b-it-q4f32_1_cs1k-webgpu.wasm',
        'vram' => 2509,
        'overrides' => ['context_window_size' => 4096],
    ],
    'Qwen3.5-4B-q4f32_1-MLC' => [
        'name' => 'Qwen 3.5 4B',
        'bytes' => 2390493525,
        'repo' => 'mlc-ai/Qwen3.5-4B-q4f32_1-MLC',
        'lib' => 'https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_84/base/Qwen3.5-4B-q4f32_1_cs1k-webgpu.wasm',
        'vram' => 4680,
        'overrides' => ['context_window_size' => 4096, 'max_history_size' => 1],
    ],
];

/**
 * Models this TOMLIN OS used to offer. One still saved here is listed (marked retired) so the owner can remove it and free
 * the space; it is never offered or saved again. Qwen 3.5 2B gave way to Gemma 2 2B on 30 Sep 2026.
 */
const MODEL_RETIRED = [
    'Qwen3.5-2B-q4f32_1-MLC' => 'Qwen 3.5 2B',
];

/**
 * Where requests for model files go. The tests point both at a stand-in on this computer: only an environment
 * variable can (never a setting or a request), and only a 127.0.0.1 address.
 */
function models_test_base(): ?string
{
    $test = (string) getenv('DESKTOP_MODELS_TEST_URL');

    return preg_match('#^http://127\.0\.0\.1:\d{2,5}$#', $test) ? $test : null;
}

function models_hf_base(): string
{
    return models_test_base() ?? 'https://huggingface.co';
}

/**
 * The pins: each built-in model's commit and files (size, SHA-256), and the programs' commit and checksums. The tests
 * give their own (DESKTOP_MODELS_TEST_PINS, read only together with the stand-in address).
 */
function models_pins(): array
{
    static $pins = null;
    if ($pins === null) {
        $test = models_test_base() !== null ? (string) getenv('DESKTOP_MODELS_TEST_PINS') : '';
        $pins = json_decode((string) @file_get_contents($test !== '' ? $test : __DIR__ . '/model-pins.json'), true);
        if (!is_array($pins) || !is_array($pins['models'] ?? null) || !is_array($pins['libs'] ?? null)) {
            throw new RuntimeException('This TOMLIN OS is missing its list of model versions (lib/model-pins.json). Upload the zip again.');
        }
    }

    return $pins;
}

/** The pinned checksum of a program, or '' when it is not pinned. */
function models_lib_sha(string $lib): string
{
    return (string) (models_pins()['libs'][basename($lib)]['sha256'] ?? '');
}

/** The WebGPU program's address, at the pinned commit (the stand-in serves it at /libs/<name> in the tests). */
function models_lib_url(string $id): string
{
    $name = basename(MODEL_CATALOG[$id]['lib']);
    $test = models_test_base();
    if ($test) {
        return $test . '/libs/' . $name;
    }
    $pins = models_pins();

    return 'https://raw.githubusercontent.com/' . MODEL_LIBS_REPO . '/' . $pins['libsCommit'] . '/web-llm-models/' . $pins['libsFolder'] . '/' . $name;
}

/** Where a browser fetches a model not saved here: its repository at the pinned commit, and its pinned program. */
function models_browser_from(string $id): array
{
    return ['model' => 'https://huggingface.co/' . MODEL_CATALOG[$id]['repo'] . '/resolve/' . models_pins()['models'][$id]['rev'] . '/', 'lib' => models_lib_url($id)];
}

/**
 * The mirror's address: config 'model_mirror' ('' switches it off), else MODEL_MIRROR_DEFAULT; https only. The tests
 * point it at a stand-in on this computer (DESKTOP_MODELS_TEST_MIRROR, an environment variable only).
 */
function models_mirror_url(array $config): string
{
    $test = (string) getenv('DESKTOP_MODELS_TEST_MIRROR');
    if (preg_match('#^http://127\.0\.0\.1:\d{2,5}/[A-Za-z0-9/._-]*$#D', $test)) {
        return $test;
    }
    $url = (string) ($config['model_mirror'] ?? MODEL_MIRROR_DEFAULT);
    $parts = parse_url($url);

    return is_array($parts) && ($parts['scheme'] ?? '') === 'https' && !empty($parts['host']) && !isset($parts['user']) && !isset($parts['port']) ? $url : '';
}

/**
 * A redirect may only lead to Hugging Face's or GitHub's file servers, over https (or back to the test stand-in); a
 * download from the mirror only to the mirror's own host.
 */
function models_host_allowed(string $url, string $mirror = ''): bool
{
    if ($mirror !== '') {
        $test = preg_match('#^(http://127\.0\.0\.1:\d+/)#', $mirror, $m) ? $m[1] : null;
        if ($test !== null) {
            return str_starts_with($url, $test);
        }
        $parts = parse_url($url);

        return ($parts['scheme'] ?? '') === 'https' && !isset($parts['port']) && !isset($parts['user'])
            && strtolower((string) ($parts['host'] ?? '')) === strtolower((string) parse_url($mirror, PHP_URL_HOST));
    }
    $test = models_test_base();
    if ($test !== null && str_starts_with($url, $test . '/')) {
        return true;
    }
    $parts = parse_url($url);
    if (($parts['scheme'] ?? '') !== 'https' || isset($parts['port']) || isset($parts['user'])) {
        return false;
    }
    $host = strtolower((string) ($parts['host'] ?? ''));

    return $host === 'huggingface.co' || $host === 'raw.githubusercontent.com' || (bool) preg_match('/^[a-z0-9-]+(\.[a-z0-9-]+)*\.hf\.co$/', $host);
}

/**
 * The folder api/modelfile.php reads for /models/ addresses: config 'models_dir' when set; otherwise tomlinos/models on a
 * live host (this code's folder, beside public_html/ and outside it), or models/ in the repository here. Never inside
 * the web root: a file there could be downloaded by anyone, signed in or not.
 */
function models_dir(array $config): string
{
    $set = (string) ($config['models_dir'] ?? '');
    if ($set !== '') {
        return rtrim($set, '/\\');
    }
    $home = dirname(__DIR__, 2);

    return is_dir($home . '/public_html') ? dirname(__DIR__) . '/models' : $home . '/models';
}

/** The plan of a save in progress is kept in the data folder, not among the model files. */
function models_plan_path(string $dataDir, string $id): string
{
    return $dataDir . '/models/' . $id . '.plan.json';
}

function models_index_read(string $modelsDir): array
{
    $data = is_file($modelsDir . '/models.json') ? json_decode((string) file_get_contents($modelsDir . '/models.json'), true) : null;

    return is_array($data['models'] ?? null) ? $data : ['models' => []];
}

function models_write_atomic(string $path, string $text): void
{
    if (!is_dir(dirname($path)) && !mkdir(dirname($path), 0775, true) && !is_dir(dirname($path))) {
        throw new RuntimeException('The folder for the model files could not be made. Check that the server may write to it.');
    }
    $tmp = $path . '.' . bin2hex(random_bytes(4)) . '.tmp';
    if (file_put_contents($tmp, $text) === false || !rename($tmp, $path)) {
        @unlink($tmp);
        throw new RuntimeException('A model file could not be written. The server may be out of space.');
    }
}

function models_index_write(string $modelsDir, array $index): void
{
    models_write_atomic($modelsDir . '/models.json', json_encode($index, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n");
}

/**
 * Reads models.json, lets $fn change it, writes it: one at a time for the whole folder (models.lock), so two models
 * finishing or being removed at the same moment never write over each other's line.
 */
function models_index_change(string $modelsDir, callable $fn): void
{
    if (!is_dir($modelsDir) && !@mkdir($modelsDir, 0775, true) && !is_dir($modelsDir)) {
        throw new RuntimeException('The folder for the model files could not be made. Check that the server may write to it.');
    }
    $lock = @fopen($modelsDir . '/models.lock', 'c');
    if ($lock === false || !flock($lock, LOCK_EX)) {
        throw new RuntimeException('The list of saved models is busy. Try again in a moment.');
    }
    try {
        models_index_write($modelsDir, $fn(models_index_read($modelsDir)));
    } finally {
        flock($lock, LOCK_UN);
        fclose($lock);
    }
}

/** A file path from Hugging Face's list, safe to use inside the model's folder. */
function models_safe_path(string $path): bool
{
    return (bool) preg_match('#^[A-Za-z0-9_][A-Za-z0-9._-]*(/[A-Za-z0-9_][A-Za-z0-9._-]*)*$#', $path) && !str_contains($path, '..');
}

/** Where a planned file goes: the model's files as <id>/resolve/main/<path> (the layout WebLLM asks for), the program in libs/. */
function models_target(string $modelsDir, string $id, array $file): string
{
    return $file['kind'] === 'lib' ? $modelsDir . '/libs/' . $file['path'] : $modelsDir . '/' . $id . '/resolve/main/' . $file['path'];
}

function models_have(string $target): int
{
    clearstatcache(true, $target);
    if (is_file($target)) {
        return (int) filesize($target);
    }

    return is_file($target . '.part') ? (int) filesize($target . '.part') : 0;
}

/**
 * The save plan: the model's pinned files and its pinned program, each with size and SHA-256, and where each comes
 * from ('upstream' until Hugging Face or GitHub fails it, then 'mirror'). Throws RuntimeException with words for the
 * owner.
 */
function models_make_plan(string $id): array
{
    $pin = models_pins()['models'][$id] ?? null;
    $lib = basename(MODEL_CATALOG[$id]['lib']);
    $libPin = models_pins()['libs'][$lib] ?? null;
    if (!is_array($pin) || !is_array($pin['files'] ?? null) || !is_array($libPin)) {
        throw new RuntimeException('This model has no pinned version in this TOMLIN OS, so it cannot be saved.');
    }
    $files = [];
    foreach ($pin['files'] as $f) {
        $path = (string) ($f['path'] ?? '');
        if (!models_safe_path($path) || !preg_match('/^[0-9a-f]{64}$/D', (string) ($f['sha256'] ?? ''))) {
            throw new RuntimeException('This TOMLIN OS\'s list of model versions is damaged (' . substr($path, 0, 60) . '). Upload the zip again.');
        }
        $files[] = ['kind' => 'model', 'path' => $path, 'size' => (int) $f['size'], 'sha256' => (string) $f['sha256'], 'from' => 'upstream'];
    }
    $files[] = ['kind' => 'lib', 'path' => $lib, 'size' => (int) $libPin['size'], 'sha256' => (string) $libPin['sha256'], 'from' => 'upstream'];

    return ['id' => $id, 'rev' => (string) $pin['rev'], 'made' => time(), 'files' => $files];
}

/** The address of one planned file: upstream (Hugging Face at the pinned commit, or GitHub), or the mirror's door. */
function models_file_url(string $id, array $file, string $mirror = ''): string
{
    if (($file['from'] ?? 'upstream') === 'mirror') {
        $pins = models_pins();
        $query = $file['kind'] === 'lib'
            ? ['lib' => $file['path'], 'rev' => (string) $pins['libsCommit']]
            : ['id' => $id, 'rev' => (string) $pins['models'][$id]['rev'], 'file' => $file['path']];

        return $mirror . (str_contains($mirror, '?') ? '&' : '?') . http_build_query($query);
    }
    if ($file['kind'] === 'lib') {
        return models_lib_url($id);
    }
    $rev = models_test_base() !== null ? 'main' : models_pins()['models'][$id]['rev'];

    return models_hf_base() . '/' . MODEL_CATALOG[$id]['repo'] . '/resolve/' . $rev . '/' . implode('/', array_map('rawurlencode', explode('/', $file['path'])));
}

/**
 * Fetches the next piece of one planned file into <target>.part (from byte $have on), following at most 5 redirects,
 * each checked. When the file is complete its size and SHA-256 are checked and it takes its real name. Returns the
 * bytes now held and whether the file is done.
 */
function models_fetch_piece(string $modelsDir, string $id, array $file, string $mirror = ''): array
{
    $target = models_target($modelsDir, $id, $file);
    if (is_file($target)) {
        return ['have' => (int) filesize($target), 'done' => true];
    }
    if (!is_dir(dirname($target)) && !mkdir(dirname($target), 0775, true) && !is_dir(dirname($target))) {
        throw new RuntimeException('The folder for the model files could not be made. Check that the server may write to it.');
    }
    if (!function_exists('curl_init')) {
        throw new RuntimeException('This server\'s PHP has no "curl" extension, which saving a model needs. The owner ticks "curl" in cPanel > Select PHP Version > Extensions.');
    }
    $part = $target . '.part';
    $size = (int) $file['size'];
    $fromMirror = ($file['from'] ?? 'upstream') === 'mirror';
    if (($have = models_have($target)) < $size) {
        models_download(models_file_url($id, $file, $mirror), $part, $have, min(MODEL_PIECE_BYTES, $size - $have), $fromMirror ? $mirror : '');
    }
    $have = models_have($target);
    if ($have < $size) {
        return ['have' => $have, 'done' => false];
    }
    $where = $fromMirror ? 'the model mirror' : ($file['kind'] === 'lib' ? 'GitHub' : 'Hugging Face');
    if ($have !== $size || !hash_equals((string) $file['sha256'], (string) hash_file('sha256', $part))) {
        // Not the pinned bytes: never kept. From upstream, the mirror is tried next (the caller decides).
        @unlink($part);
        $words = 'A model file from ' . $where . ' was not the pinned version (' . $file['path'] . '), so it was thrown away.';
        throw $fromMirror ? new RuntimeException($words . ' Try again later.') : new ModelSourceGone($words);
    }
    if (!rename($part, $target)) {
        throw new RuntimeException('A finished model file could not be given its name. The server may be out of space.');
    }

    return ['have' => (int) filesize($target), 'done' => true];
}

/**
 * One request's share of a save: fetches the next piece, or several small files, and says whether the model is
 * complete. A file Hugging Face or GitHub refuses goes to the mirror at once; one that arrived as other bytes than the
 * pinned version is tried upstream once more (a damaged download), then from the mirror. $plan is updated in place;
 * 'changed' says the caller must keep it, 'mirror' names a file just sent to the mirror (for the owner's history).
 */
function models_save_step(string $modelsDir, string $id, array &$plan, string $mirror): array
{
    foreach ($plan['files'] as $i => $f) {
        if (is_file(models_target($modelsDir, $id, $f))) {
            continue; // finished in an earlier request
        }
        try {
            $r = models_fetch_piece($modelsDir, $id, $f, $mirror);
        } catch (ModelSourceGone $gone) {
            $f['misses'] = (int) ($f['misses'] ?? 0) + 1;
            $toMirror = $gone->refused || $f['misses'] >= 2;
            if ($toMirror && $mirror === '') {
                throw new RuntimeException($gone->getMessage() . ' That version is no longer where it was published, and no model mirror is set (config.php, model_mirror), so it cannot be saved.');
            }
            if ($toMirror) {
                $f['from'] = 'mirror';
            }
            $plan['files'][$i] = $f;

            return ['done' => false, 'changed' => true, 'mirror' => $toMirror ? $f['path'] . ' (' . $gone->getMessage() . ')' : null];
        }
        if (!$r['done']) {
            return ['done' => false, 'changed' => false, 'mirror' => null];
        }
        // A finished file: carry on with the next in the same request only when it is small, else answer so the page
        // can show progress and no request runs long.
        if ((int) $f['size'] > 4 * 1024 * 1024 && array_filter($plan['files'], static fn ($g) => !is_file(models_target($modelsDir, $id, $g)))) {
            return ['done' => false, 'changed' => false, 'mirror' => null];
        }
    }

    return ['done' => true, 'changed' => false, 'mirror' => null];
}

/**
 * GETs $url (from byte $from for $length bytes when $from is not null), appending the body to $part. Redirects are
 * followed by hand so each address is checked. Returns the bytes written.
 */
function models_download(string $url, string $part, ?int $from, int $length, string $mirror = ''): int
{
    $cafile = (string) (ini_get('curl.cainfo') ?: ini_get('openssl.cafile'));
    $test = models_test_base() !== null || str_starts_with($mirror, 'http://127.0.0.1:');
    $who = $mirror !== '' ? 'The model mirror' : 'Hugging Face';
    for ($hop = 0; $hop <= 5; $hop++) {
        if (!models_host_allowed($url, $mirror)) {
            throw new RuntimeException($who . ' sent the download somewhere this server will not fetch from, so it stopped.');
        }
        $fh = fopen($part, 'ab');
        if ($fh === false) {
            throw new RuntimeException('A model file could not be written. The server may be out of space.');
        }
        $status = 0;
        $written = 0;
        $ch = curl_init($url);
        $options = [
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_PROTOCOLS => $test ? CURLPROTO_HTTP | CURLPROTO_HTTPS : CURLPROTO_HTTPS,
            CURLOPT_CONNECTTIMEOUT => 15,
            CURLOPT_TIMEOUT => 120,
            // The mirror serves only TOMLIN OS servers, which it tells from browsers by this name.
            CURLOPT_USERAGENT => 'TomlinOS',
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
            CURLOPT_HEADERFUNCTION => static function ($ch, string $line) use (&$status): int {
                if (preg_match('#^HTTP/\S+\s+(\d{3})#', $line, $m)) {
                    $status = (int) $m[1];
                }

                return strlen($line);
            },
            // Only a 206 (the part asked for) or, for a whole file, a 200 is written; anything else is thrown away,
            // so a server that ignores the range can never append the file's start a second time.
            CURLOPT_WRITEFUNCTION => static function ($ch, string $data) use (&$status, &$written, $fh, $from, $length): int {
                $ok = $from === null ? $status === 200 : $status === 206;
                if (!$ok) {
                    return strlen($data);
                }
                $room = $length - $written;
                if ($room <= 0) {
                    return 0; // more than asked for: stop
                }
                $chunk = strlen($data) > $room ? substr($data, 0, $room) : $data;
                $written += (int) fwrite($fh, $chunk);

                return strlen($chunk) === strlen($data) ? strlen($data) : 0;
            },
        ];
        if ($from !== null) {
            $options[CURLOPT_RANGE] = $from . '-' . ($from + $length - 1);
        }
        if ($cafile !== '' && is_file($cafile)) {
            $options[CURLOPT_CAINFO] = $cafile;
        }
        curl_setopt_array($ch, $options);
        $ran = curl_exec($ch);
        $error = curl_errno($ch);
        $next = (string) curl_getinfo($ch, CURLINFO_REDIRECT_URL);
        fclose($fh);
        if ($status >= 300 && $status < 400 && $next !== '') {
            $url = $next;
            continue;
        }
        // Part of the piece arrived before the line slowed or dropped (a 16 MB piece takes over 2 minutes below about
        // 140 KB/s): that part is kept and counted, and the next piece carries on from it, rather than "interrupted" each
        // time. The file's size and SHA-256 are still checked at the end.
        if ($written > 0 && ($ran !== false || in_array($error, [CURLE_WRITE_ERROR, CURLE_OPERATION_TIMEDOUT, CURLE_PARTIAL_FILE, CURLE_RECV_ERROR], true))) {
            return $written;
        }
        if ($error !== 0) {
            throw new RuntimeException('The download was interrupted (' . curl_strerror($error) . '). Press Save again: it carries on where it stopped.');
        }
        if ($mirror !== '' && $status > 0) {
            // The mirror explains itself (its daily share used, a version it does not hold): its own words, cut short.
            throw new RuntimeException('The model mirror answered ' . $status . ' for a model file' . ($status === 429 ? ': this server has used its share for today. Press Save again tomorrow.' : '. Try again later.'));
        }
        if ($mirror === '' && in_array($status, [401, 403, 404, 410, 451], true)) {
            // Gone or refused upstream (Hugging Face answers 401 for a repository that no longer exists).
            throw new ModelSourceGone('Hugging Face answered ' . $status . ' for a model file.', true);
        }
        throw new RuntimeException($status === 416 || $status === 200
            ? $who . ' did not send the piece asked for. Press Save again; if it keeps happening, remove the model and save it afresh.'
            : $who . ' answered ' . $status . ' for a model file. Try again in a few minutes.');
    }
    throw new RuntimeException('The download was sent from place to place too many times, so it stopped.');
}

/** Everything under the models folder that belongs to one model, removed (its program too, unless another model uses it). */
function models_remove(string $modelsDir, string $id): void
{
    $folder = $modelsDir . '/' . $id;
    if (is_dir($folder)) {
        $items = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($folder, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($items as $item) {
            $item->isDir() && !$item->isLink() ? rmdir($item->getPathname()) : unlink($item->getPathname());
        }
        rmdir($folder);
    }
    models_index_change($modelsDir, static function (array $index) use ($modelsDir, $id): array {
        // The program's name from the catalog, or (a retired model) from what the index kept when it was saved.
        $kept = array_values(array_filter($index['models'], static fn ($m) => ($m['id'] ?? '') === $id))[0] ?? [];
        $index['models'] = array_values(array_filter($index['models'], static fn ($m) => ($m['id'] ?? '') !== $id));
        $lib = basename((string) (MODEL_CATALOG[$id]['lib'] ?? $kept['lib'] ?? ''));
        $shared = array_filter($index['models'], static fn ($m) => ($m['lib'] ?? '') === $lib);
        if (!$shared && $lib !== '') {
            @unlink($modelsDir . '/libs/' . $lib);
            @unlink($modelsDir . '/libs/' . $lib . '.part');
        }

        return $index;
    });
}

/** When each model was last removed (data/models/removed.json), for the wait before it can be saved again. */
function models_removed_path(string $dataDir): string
{
    return $dataDir . '/models/removed.json';
}

function models_note_removed(string $dataDir, string $id): void
{
    $path = models_removed_path($dataDir);
    $list = is_file($path) ? json_decode((string) file_get_contents($path), true) : [];
    $list = is_array($list) ? array_filter($list, static fn ($t) => is_int($t) && $t > time() - MODEL_RESAVE_WAIT) : [];
    $list[$id] = time();
    models_write_atomic($path, json_encode($list));
}

/** Seconds until a removed model can be saved again (0: it can be now). */
function models_resave_wait(string $dataDir, string $id): int
{
    $path = models_removed_path($dataDir);
    $list = is_file($path) ? json_decode((string) file_get_contents($path), true) : [];
    $at = is_array($list) ? (int) ($list[$id] ?? 0) : 0;

    return max(0, $at + MODEL_RESAVE_WAIT - time());
}

/** The models folder's own web settings (the same file tools/fetch-model.mjs writes), put there when missing. */
function models_ensure_htaccess(string $modelsDir): void
{
    $text = implode("\n", [
        '# TOMLIN OS on-device AI models. This folder is outside the web root; if a host ever serves it, refuse.',
        '# Signed-in people get these files through api/modelfile.php.',
        'Require all denied',
        '',
    ]);
    if (@file_get_contents($modelsDir . '/.htaccess') === $text) {
        return;
    }
    models_write_atomic($modelsDir . '/.htaccess', $text);
}

/** The finished model's line in models.json (the same shape tools/fetch-model.mjs writes). */
function models_index_add(string $modelsDir, string $id, array $plan): void
{
    $bytes = 0;
    foreach ($plan['files'] as $f) {
        if ($f['kind'] === 'model') {
            $bytes += (int) $f['size'];
        }
    }
    $c = MODEL_CATALOG[$id];
    $lib = array_values(array_filter($plan['files'], static fn ($f) => $f['kind'] === 'lib'))[0] ?? [];
    $line = ['id' => $id, 'lib' => basename($c['lib']), 'bytes' => $bytes, 'vram' => $c['vram'], 'context' => $c['overrides']['context_window_size'] ?? null, 'overrides' => $c['overrides'],
        'rev' => (string) ($plan['rev'] ?? ''), 'libSha256' => (string) ($lib['sha256'] ?? '')];
    models_index_change($modelsDir, static function (array $index) use ($id, $line): array {
        $index['models'] = array_values(array_filter($index['models'], static fn ($m) => ($m['id'] ?? '') !== $id));
        $index['models'][] = $line;

        return $index;
    });
}
