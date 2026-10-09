<?php
// "Your own OpenRouter key": one key for hundreds of AI models from many makers (openrouter.ai), paid from the
// person's own OpenRouter credit. The same rules as the Claude key (lib/claude.php, whose sealing and cost book this
// uses): the key is kept sealed on this server and never sent back; a monthly limit the person sets is checked before
// each answer (the most it could cost is set aside, then what it did cost is booked); the cost log keeps numbers, never
// what was said. OpenRouter reports each answer's cost itself, so that is what is booked.
declare(strict_types=1);

require_once __DIR__ . '/claude.php';

const OR_BASE = 'https://openrouter.ai/api/v1';
const OR_BOOK = 'or-cost';
/** The longest answer asked for (tokens), and what the limit check assumes an answer could use. */
const OR_MAX_OUTPUT = 8000;
const OR_MODELS_TTL = 86400;
const OR_MODELS_MAX_BYTES = 12 * 1024 * 1024;

/** What an OpenRouter key looks like ("sk-or-v1-..."). Checked before it is ever sent anywhere. */
function or_key_shape_ok(string $key): bool
{
    return (bool) preg_match('/^sk-or-[A-Za-z0-9_-]{20,300}$/', $key);
}

/** A model id as OpenRouter writes them ("maker/model", sometimes with ":free" and the like). */
function or_model_id_ok(string $id): bool
{
    return (bool) preg_match('#^[a-z0-9][a-z0-9._-]{0,60}/[A-Za-z0-9._:-]{1,100}$#', $id);
}

/** @return array{key: ?string, hint: string, model: string, cap: int, saved: int} (cap in cents; key still sealed) */
function or_settings(string $dataDir, string $userId): array
{
    $s = auth_read_json(ai_user_file($dataDir, $userId, 'openrouter'), []);
    $model = (string) ($s['model'] ?? '');

    return [
        'key' => is_string($s['key'] ?? null) ? $s['key'] : null,
        'hint' => (string) ($s['hint'] ?? ''),
        'model' => or_model_id_ok($model) ? $model : '',
        'cap' => max(0, min(AI_MAX_CAP_CENTS, (int) ($s['cap'] ?? AI_DEFAULT_CAP_CENTS))),
        'saved' => (int) ($s['saved'] ?? 0),
    ];
}

function or_save_settings(string $dataDir, string $userId, array $s): void
{
    auth_write_json(ai_user_file($dataDir, $userId, 'openrouter'), $s);
    @chmod(ai_user_file($dataDir, $userId, 'openrouter'), 0600);
}

/**
 * The HTTP client: the address is fixed, HTTPS only, no redirects, firm time limits. The tests may point it at a
 * stand-in on this computer, through an environment variable only, and only at a 127.0.0.1 address.
 */
function or_http(): GuzzleHttp\Client
{
    $test = (string) getenv('DESKTOP_OR_TEST_URL');
    $local = (bool) preg_match('#^http://127\.0\.0\.1:\d{2,5}$#', $test);
    $cafile = (string) ini_get('openssl.cafile');

    return new GuzzleHttp\Client([
        'base_uri' => ($local ? $test . '/api/v1' : OR_BASE) . '/',
        'connect_timeout' => 10,
        'timeout' => 240,
        'read_timeout' => 120,
        'allow_redirects' => false,
        'http_errors' => false,
        'verify' => $cafile !== '' && is_file($cafile) ? $cafile : true,
        'curl' => defined('CURLOPT_PROTOCOLS') ? [CURLOPT_PROTOCOLS => $local ? CURLPROTO_HTTP : CURLPROTO_HTTPS] : [],
    ]);
}

/** Price per million tokens, from OpenRouter's price per token (a string); null when it is not a fixed price. */
function or_per_million(mixed $perToken): ?float
{
    if (!is_numeric($perToken)) {
        return null;
    }
    $v = (float) $perToken;

    return $v < 0 ? null : round($v * 1e6, 4);
}

/**
 * The models OpenRouter offers, with their prices (US dollars per million tokens), read from its public list at most
 * once a day and kept beside the settings. Models without a fixed price (the automatic router) are left out, as the
 * limit check needs to know the most an answer could cost.
 * @return list<array{id: string, name: string, in: float, out: float, context: int}>
 */
function or_models(string $dataDir, bool $fresh = false): array
{
    $cache = ai_dir($dataDir) . '/openrouter-models.json';
    $kept = auth_read_json($cache, []);
    if (!$fresh && is_array($kept['models'] ?? null) && time() - (int) ($kept['at'] ?? 0) < OR_MODELS_TTL) {
        return $kept['models'];
    }
    try {
        $res = or_http()->get('models', ['headers' => ['Accept' => 'application/json']]);
        $body = (string) $res->getBody()->read(OR_MODELS_MAX_BYTES);
        $data = $res->getStatusCode() === 200 ? json_decode($body, true) : null;
    } catch (Throwable) {
        $data = null;
    }
    if (!is_array($data['data'] ?? null)) {
        if (is_array($kept['models'] ?? null)) {
            return $kept['models'];
        }
        throw new RuntimeException('OpenRouter\'s list of models could not be read just now. Try again in a minute.');
    }
    $models = [];
    foreach ($data['data'] as $m) {
        $id = is_array($m) ? (string) ($m['id'] ?? '') : '';
        $in = or_per_million($m['pricing']['prompt'] ?? null);
        $out = or_per_million($m['pricing']['completion'] ?? null);
        if (!or_model_id_ok($id) || $in === null || $out === null) {
            continue;
        }
        $name = trim(preg_replace('/\s+/', ' ', (string) ($m['name'] ?? $id)) ?? $id);
        $models[] = ['id' => $id, 'name' => (function_exists('mb_substr') ? mb_substr($name !== '' ? $name : $id, 0, 120) : substr($name !== '' ? $name : $id, 0, 120)), 'in' => $in, 'out' => $out, 'context' => max(0, (int) ($m['context_length'] ?? 0))];
    }
    usort($models, static fn ($a, $b) => strcasecmp($a['name'], $b['name']));
    auth_write_json($cache, ['at' => time(), 'models' => $models]);

    return $models;
}

/** One model's prices, or null when it is not in the list. */
function or_model(string $dataDir, string $id): ?array
{
    foreach (or_models($dataDir) as $m) {
        if ($m['id'] === $id) {
            return $m;
        }
    }

    return null;
}

/** Cost in millionths of a dollar from token counts and prices per million tokens. */
function or_cost_micro(array $model, int $in, int $out): int
{
    return (int) ceil($in * $model['in'] + $out * $model['out']);
}

/** The most a request could cost: input counted generously (3 letters a token) plus a full answer. */
function or_worst_micro(array $model, int $inputChars): int
{
    return or_cost_micro($model, intdiv($inputChars, 3) + 200, OR_MAX_OUTPUT);
}

/** Plain words for an OpenRouter refusal. Never includes the key or the raw reply. */
function or_error_words(int $status, string $message = ''): array
{
    return match (true) {
        $status === 401 => [401, 'OpenRouter refused the key. It may have been deleted or mistyped: make a new one at openrouter.ai > Keys and save it here again.'],
        $status === 402 => [402, 'OpenRouter says the account behind this key has no credit left. Add credit at openrouter.ai > Credits.'],
        $status === 403 => [403, 'OpenRouter or the model\'s maker declined that request.'],
        $status === 404 => [404, 'OpenRouter does not have that model (any more). Choose another in Settings > AI.'],
        $status === 408, $status === 504 => [504, 'The model took too long to answer. Try again, or ask for a shorter answer.'],
        $status === 429 => [429, 'OpenRouter is limiting how fast this key can be used. Wait a minute, then try again.'],
        $status === 400 => [400, 'OpenRouter could not take that request (it may be too long for this model). Try shorter text.'],
        $status === 502, $status === 503 => [503, 'The model is not answering just now. Try again in a minute, or choose another model.'],
        $status === 0 => [502, 'This server could not reach OpenRouter. Check the server\'s internet connection, then try again.'],
        default => [502, 'Talking to OpenRouter went wrong (answer ' . $status . '). Try again in a minute.'],
    };
}

/**
 * Reads an OpenRouter stream (server-sent events), calling $onText for each piece of the answer. Returns what the
 * last message said: token counts, OpenRouter's own cost (US dollars), why it stopped, and any error it reported.
 * @return array{in: int, out: int, cost: ?float, stop: string, error: ?array{code: int, message: string}, aborted: bool}
 */
function or_read_stream(Psr\Http\Message\StreamInterface $body, callable $onText, callable $shouldStop): array
{
    $r = ['in' => 0, 'out' => 0, 'cost' => null, 'stop' => '', 'error' => null, 'aborted' => false];
    $buffer = '';
    $pieces = 0;
    while (!$body->eof()) {
        $buffer .= $body->read(8192);
        while (($nl = strpos($buffer, "\n")) !== false) {
            $line = rtrim(substr($buffer, 0, $nl), "\r");
            $buffer = substr($buffer, $nl + 1);
            // ": OPENROUTER PROCESSING" and other comments keep the connection open; they carry nothing.
            if (!str_starts_with($line, 'data:')) {
                continue;
            }
            $data = trim(substr($line, 5));
            if ($data === '[DONE]') {
                return $r;
            }
            $j = json_decode($data, true);
            if (!is_array($j)) {
                continue;
            }
            if (is_array($j['error'] ?? null)) {
                $r['error'] = ['code' => (int) ($j['error']['code'] ?? 0), 'message' => (string) ($j['error']['message'] ?? '')];
            }
            $text = $j['choices'][0]['delta']['content'] ?? null;
            if (is_string($text) && $text !== '') {
                $onText($text);
                if (++$pieces % 8 === 0 && $shouldStop()) {
                    $r['aborted'] = true;

                    return $r;
                }
            }
            $stop = $j['choices'][0]['finish_reason'] ?? null;
            if (is_string($stop)) {
                $r['stop'] = $stop;
            }
            if (is_array($j['usage'] ?? null)) {
                $r['in'] = (int) ($j['usage']['prompt_tokens'] ?? 0);
                $r['out'] = (int) ($j['usage']['completion_tokens'] ?? 0);
                $r['cost'] = is_numeric($j['usage']['cost'] ?? null) ? (float) $j['usage']['cost'] : null;
            }
        }
    }

    return $r;
}
