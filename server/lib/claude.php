<?php
// "Your own Claude key" (Settings > AI, used in Chat > Agents). Claude only, through Anthropic's official PHP library: no custom or
// community code between a person's key and the AI.
//
// - Each person's key is kept on this server, sealed (AES-256-GCM with a key of its own in the accounts folder, bound
//   to the person's id), and never sent back to a browser: only its last four characters are shown.
// - Spending: a monthly cap each person sets. Before a request, the MOST it could cost is set aside against the cap;
//   when it ends, what it did cost is booked instead. Two requests at once cannot both slip under the cap.
// - The cost log keeps the time, model, tokens and cost of each request; never what was said.
declare(strict_types=1);

require_once __DIR__ . '/../vendor/autoload.php';

/**
 * The models offered, with Anthropic's list prices in US dollars per million tokens (checked September 2026 on
 * platform.claude.com/docs/en/about-claude/pricing). Cache reads cost 0.1x input and 5-minute cache writes 1.25x.
 */
const AI_MODELS = [
    'claude-opus-5' => ['name' => 'Claude Opus 5', 'in' => 5.0, 'out' => 25.0, 'note' => 'the most capable'],
    'claude-sonnet-5' => ['name' => 'Claude Sonnet 5', 'in' => 2.0, 'out' => 10.0, 'note' => 'fast and capable, lower cost'],
    'claude-haiku-4-5' => ['name' => 'Claude Haiku 4.5', 'in' => 1.0, 'out' => 5.0, 'note' => 'quickest and cheapest, for simple jobs'],
];
const AI_DEFAULT_MODEL = 'claude-opus-5';
/** The longest answer asked for (tokens). Also what the cap check assumes an answer could use. */
const AI_MAX_OUTPUT = 8000;
/** The most text one request may carry (letters, all messages together): about 100,000 tokens. */
const AI_MAX_INPUT_CHARS = 400000;
const AI_DEFAULT_CAP_CENTS = 500;
const AI_MAX_CAP_CENTS = 100000;
/** A set-aside older than this belongs to a request that died without booking; it is released. */
const AI_RESERVE_TTL = 900;

/** The folder for the people's AI settings and cost logs. */
function ai_dir(string $dataDir): string
{
    $dir = auth_dir($dataDir) . '/ai';
    if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) {
        throw new RuntimeException('the AI settings folder cannot be created');
    }

    return $dir;
}

function ai_user_file(string $dataDir, string $userId, string $what): string
{
    if (!preg_match('/^[A-Za-z0-9_-]{1,64}$/', $userId)) {
        throw new RuntimeException('a person id is not in the expected form');
    }

    return ai_dir($dataDir) . '/' . $userId . '-' . $what . '.json';
}

/** The server's own sealing key for API keys, made once (like the accounts pepper). */
function ai_seal_key(string $dataDir): string
{
    $path = auth_dir($dataDir) . '/ai-seal.key';
    $read = static function () use ($path): ?string {
        $hex = @file_get_contents($path);

        return $hex !== false && strlen($hex) === 64 && ctype_xdigit($hex) ? (string) hex2bin($hex) : null;
    };

    return $read() ?? auth_locked($dataDir, static function () use ($path, $read): string {
        $again = $read();
        if ($again !== null) {
            return $again;
        }
        $fresh = random_bytes(32);
        if (file_put_contents($path, bin2hex($fresh), LOCK_EX) !== 64) {
            throw new RuntimeException('the AI sealing key cannot be written');
        }
        @chmod($path, 0600);

        return $fresh;
    });
}

function ai_seal(string $dataDir, string $userId, string $plain): string
{
    $iv = random_bytes(12);
    $tag = '';
    $sealed = openssl_encrypt($plain, 'aes-256-gcm', ai_seal_key($dataDir), OPENSSL_RAW_DATA, $iv, $tag, 'tomlinos-ai:' . $userId, 16);
    if ($sealed === false) {
        throw new RuntimeException('the key could not be sealed');
    }

    return base64_encode($iv . $tag . $sealed);
}

/** The key, or null when the sealed text is damaged, belongs to someone else, or the sealing key changed. */
function ai_open(string $dataDir, string $userId, string $sealed): ?string
{
    $raw = base64_decode($sealed, true);
    if ($raw === false || strlen($raw) < 29) {
        return null;
    }
    $plain = openssl_decrypt(substr($raw, 28), 'aes-256-gcm', ai_seal_key($dataDir), OPENSSL_RAW_DATA, substr($raw, 0, 12), substr($raw, 12, 16), 'tomlinos-ai:' . $userId);

    return $plain === false ? null : $plain;
}

/** What an Anthropic API key looks like. Checked before it is ever sent anywhere. */
function ai_key_shape_ok(string $key): bool
{
    return (bool) preg_match('/^sk-ant-[A-Za-z0-9_-]{20,300}$/', $key);
}

/** @return array{key: ?string, hint: string, model: string, cap: int, saved: int} (cap in cents; key still sealed) */
function ai_settings(string $dataDir, string $userId): array
{
    $s = auth_read_json(ai_user_file($dataDir, $userId, 'settings'), []);
    $model = (string) ($s['model'] ?? '');

    return [
        'key' => is_string($s['key'] ?? null) ? $s['key'] : null,
        'hint' => (string) ($s['hint'] ?? ''),
        'model' => isset(AI_MODELS[$model]) ? $model : AI_DEFAULT_MODEL,
        'cap' => max(0, min(AI_MAX_CAP_CENTS, (int) ($s['cap'] ?? AI_DEFAULT_CAP_CENTS))),
        'saved' => (int) ($s['saved'] ?? 0),
    ];
}

function ai_save_settings(string $dataDir, string $userId, array $s): void
{
    auth_write_json(ai_user_file($dataDir, $userId, 'settings'), $s);
    @chmod(ai_user_file($dataDir, $userId, 'settings'), 0600);
}

/** Cost in millionths of a dollar (whole numbers: no rounding drift in the totals). */
function ai_cost_micro(string $model, int $in, int $out, int $cacheWrite = 0, int $cacheRead = 0): int
{
    $p = AI_MODELS[$model] ?? AI_MODELS[AI_DEFAULT_MODEL];

    return (int) ceil($in * $p['in'] + $out * $p['out'] + $cacheWrite * $p['in'] * 1.25 + $cacheRead * $p['in'] * 0.1);
}

/**
 * The most a request could cost: input counted generously, a token for every 2 bytes (English runs about 4 letters a
 * token; Chinese, Japanese and Korean about one letter, 3 bytes, a token), plus a full answer.
 */
function ai_worst_micro(string $model, int $inputBytes): int
{
    return ai_cost_micro($model, intdiv($inputBytes, 2) + 200, AI_MAX_OUTPUT);
}

function ai_month(?int $now = null): string
{
    return gmdate('Y-m', $now ?? time());
}

/**
 * One service's cost book for a month (`$book`: "cost" for Claude, "or-cost" for OpenRouter; each has its own cap).
 * @return array{spent: int, reserved: array<string, array{m: int, at: int}>, log: list<array>}
 */
function ai_ledger_read(string $dataDir, string $userId, string $month, string $book = 'cost'): array
{
    $l = auth_read_json(ai_user_file($dataDir, $userId, $book . '-' . $month), []);

    return ['spent' => (int) ($l['spent'] ?? 0), 'reserved' => is_array($l['reserved'] ?? null) ? $l['reserved'] : [], 'log' => is_array($l['log'] ?? null) ? $l['log'] : []];
}

/** Sets aside the most this request could cost. Returns the set-aside id, or null when that would pass the cap. */
function ai_reserve(string $dataDir, string $userId, int $capCents, int $worstMicro, ?int $now = null, string $book = 'cost'): ?string
{
    $now ??= time();

    return auth_locked($dataDir, static function () use ($dataDir, $userId, $capCents, $worstMicro, $now, $book): ?string {
        $month = ai_month($now);
        $l = ai_ledger_read($dataDir, $userId, $month, $book);
        $l['reserved'] = array_filter($l['reserved'], static fn ($r) => is_array($r) && $now - (int) ($r['at'] ?? 0) < AI_RESERVE_TTL);
        $held = array_sum(array_map(static fn ($r) => (int) $r['m'], $l['reserved']));
        if ($l['spent'] + $held + $worstMicro > $capCents * 10000) {
            return null;
        }
        $id = bin2hex(random_bytes(8));
        $l['reserved'][$id] = ['m' => $worstMicro, 'at' => $now];
        auth_write_json(ai_user_file($dataDir, $userId, $book . '-' . $month), $l);

        return $id;
    });
}

/** Replaces a set-aside with what the request did cost, and logs it (no words, only numbers). */
function ai_book(string $dataDir, string $userId, string $reserveId, array $entry, ?int $now = null, string $book = 'cost'): void
{
    $now ??= time();
    auth_locked($dataDir, static function () use ($dataDir, $userId, $reserveId, $entry, $now, $book): void {
        $month = ai_month($now);
        $l = ai_ledger_read($dataDir, $userId, $month, $book);
        unset($l['reserved'][$reserveId]);
        $l['spent'] += (int) $entry['cost'];
        $l['log'][] = ['at' => $now] + $entry;
        if (count($l['log']) > 3000) {
            $l['log'] = array_slice($l['log'], -3000);
        }
        auth_write_json(ai_user_file($dataDir, $userId, $book . '-' . $month), $l);
    });
}

/**
 * The official client for one person's key. The address is fixed (never read from the environment), no other
 * credentials are picked up, and the HTTP client has firm time limits and HTTPS only.
 */
function ai_client(string $key): Anthropic\Client
{
    // The browser tests point this at a stand-in on this computer (test/fake-anthropic.mjs). Only an environment
    // variable can do that (never a setting or a request), and only a 127.0.0.1 address is accepted.
    $test = (string) getenv('DESKTOP_AI_TEST_URL');
    $local = (bool) preg_match('#^http://127\.0\.0\.1:\d{2,5}$#', $test);
    $cafile = (string) ini_get('openssl.cafile');
    $http = new GuzzleHttp\Client([
        'connect_timeout' => 10,
        // An answer streams; this is the longest one request may take in all.
        'timeout' => 240,
        'read_timeout' => 120,
        'allow_redirects' => false,
        'verify' => $cafile !== '' && is_file($cafile) ? $cafile : true,
        'curl' => defined('CURLOPT_PROTOCOLS') ? [CURLOPT_PROTOCOLS => $local ? CURLPROTO_HTTP : CURLPROTO_HTTPS] : [],
    ]);

    return new Anthropic\Client(
        apiKey: $key,
        authToken: '',
        webhookKey: '',
        baseUrl: $local ? $test : 'https://api.anthropic.com',
        requestOptions: Anthropic\RequestOptions::with(maxRetries: 1, transporter: $http),
    );
}

/** Plain words for what went wrong talking to Anthropic. Never includes the key or the raw reply. */
function ai_error_words(Throwable $e): array
{
    $status = $e instanceof Anthropic\Core\Exceptions\APIStatusException ? (int) $e->status : 0;

    return match (true) {
        $e instanceof Anthropic\Core\Exceptions\AuthenticationException, $status === 401 => [401, 'Anthropic refused the API key. It may have been deleted or mistyped: make a new one at console.anthropic.com and save it here again.'],
        $e instanceof Anthropic\Core\Exceptions\PermissionDeniedException, $status === 403 => [403, 'Anthropic says this key may not use that model. Choose another model, or check the key\'s workspace at console.anthropic.com.'],
        $status === 402 => [402, 'Anthropic says the account behind this key has no credit left. Add credit at console.anthropic.com.'],
        $e instanceof Anthropic\Core\Exceptions\RateLimitException, $status === 429 => [429, 'Anthropic is limiting how fast this key can be used. Wait a minute, then try again.'],
        $status === 529, $status === 503 => [503, 'Anthropic is very busy just now. Try again in a minute.'],
        $e instanceof Anthropic\Core\Exceptions\BadRequestException, $status === 400 => [400, 'Anthropic could not take that request (it may be too long). Try shorter text.'],
        $e instanceof Anthropic\Core\Exceptions\APITimeoutException => [504, 'Anthropic took too long to answer. Try again, or ask for a shorter answer.'],
        $e instanceof Anthropic\Core\Exceptions\APIConnectionException => [502, 'This server could not reach Anthropic. Check the server\'s internet connection, then try again.'],
        default => [502, 'Talking to Anthropic went wrong' . ($status ? " (answer $status)" : '') . '. Try again in a minute.'],
    };
}
