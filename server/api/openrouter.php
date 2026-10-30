<?php
// "Your own OpenRouter key" (see lib/openrouter.php for the rules).
//   GET  op=settings  whether a key is saved (its last four characters only), the model, the monthly cap, spent so far
//   GET  op=models    OpenRouter's models with their prices (read from OpenRouter at most once a day)
//   POST op=save      {key?, model, cap}  a new key is checked with OpenRouter before it is kept
//   POST op=forget    removes the key (the cost log stays)
//   GET  op=log       this month's cost log: time, model, tokens, cost (never what was said)
//   POST op=chat      {messages: [{role, content}]}  streams the answer back as lines of JSON:
//                     {"t": "text"} while it writes, then {"done": true, ...tokens and cost} or {"error": "..."}
// Signed-in people only; each person uses their OWN key and their own cap.
declare(strict_types=1);

require __DIR__ . '/../lib/http.php';
require __DIR__ . '/../lib/auth.php';
require __DIR__ . '/../lib/outbound.php';
require __DIR__ . '/../lib/openrouter.php';

api_headers();
api_guard();

$config = api_config();
$root = rtrim((string) $config['data_dir'], '/\\');
[, , $user] = require_full($root);
$uid = (string) $user['id'];
$op = (string) ($_GET['op'] ?? '');
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$dollars = static fn (int $micro): float => round($micro / 1e6, 4);
$letters = static fn (string $t): int => function_exists('mb_strlen') ? mb_strlen($t) : strlen($t);

if (!extension_loaded('openssl') || !extension_loaded('curl')) {
    api_fail(501, 'This server\'s PHP is missing "openssl" or "curl", which OpenRouter needs. The owner ticks both in cPanel > Select PHP Version > Extensions.');
}

switch ("$method $op") {
    case 'GET settings': {
        $s = or_settings($root, $uid);
        $l = ai_ledger_read($root, $uid, ai_month(), OR_BOOK);
        $model = $s['model'] !== '' ? or_model($root, $s['model']) : null;
        api_json([
            'hasKey' => $s['key'] !== null, 'hint' => $s['hint'], 'model' => $s['model'], 'modelName' => $model['name'] ?? $s['model'],
            'cap' => $s['cap'] / 100, 'spent' => $dollars(ai_ledger_total($l)), 'month' => ai_month(), 'maxOutput' => OR_MAX_OUTPUT,
        ]);
    }

    case 'GET models': {
        try {
            api_json(['models' => or_models($root)]);
        } catch (RuntimeException $e) {
            api_fail(502, $e->getMessage());
        }
    }

    case 'POST save': {
        $body = api_body();
        $wait = rate_take($root, $uid, 'or-save', 10, 3600);
        if ($wait > 0) {
            api_fail(429, 'That is 10 changes in an hour. Wait a while, then try again.', ['wait' => $wait]);
        }
        $s = or_settings($root, $uid);
        $model = body_str($body, 'model');
        if ($model !== '' && (!or_model_id_ok($model) || or_model($root, $model) === null)) {
            api_fail(400, 'Choose one of the models in the list.');
        }
        $cap = (float) body_str($body, 'cap');
        if (!is_finite($cap) || $cap < 0 || $cap > AI_MAX_CAP_CENTS / 100) {
            api_fail(400, 'The monthly limit must be between $0 and $' . (AI_MAX_CAP_CENTS / 100) . '.');
        }
        $key = trim(body_str($body, 'key'));
        $sealed = $s['key'];
        $hint = $s['hint'];
        if ($key !== '') {
            if (!or_key_shape_ok($key)) {
                api_fail(400, 'That does not look like an OpenRouter key: they start with "sk-or-". Copy it again from openrouter.ai > Keys.');
            }
            // OpenRouter's key check proves the key works before it is kept.
            try {
                $status = or_http()->get('key', ['headers' => ['Authorization' => 'Bearer ' . $key, 'Accept' => 'application/json']])->getStatusCode();
            } catch (Throwable) {
                $status = 0;
            }
            if ($status !== 200) {
                [$code, $words] = or_error_words($status);
                api_fail($code === 401 ? 400 : $code, $words);
            }
            $sealed = ai_seal($root, $uid, $key);
            $hint = substr($key, -4);
            auth_history_add($root, $uid, 'Saved an OpenRouter key (ending ' . $hint . ')');
        }
        or_save_settings($root, $uid, ['key' => $sealed, 'hint' => $hint, 'model' => $model, 'cap' => (int) round($cap * 100), 'saved' => time()]);
        api_json(['ok' => true, 'hasKey' => $sealed !== null, 'hint' => $hint]);
    }

    case 'POST forget': {
        $s = or_settings($root, $uid);
        if ($s['key'] !== null) {
            auth_history_add($root, $uid, 'Removed the OpenRouter key (ending ' . $s['hint'] . ')');
        }
        or_save_settings($root, $uid, ['key' => null, 'hint' => '', 'model' => $s['model'], 'cap' => $s['cap'], 'saved' => time()]);
        api_json(['ok' => true]);
    }

    case 'GET log': {
        $l = ai_ledger_read($root, $uid, ai_month(), OR_BOOK);
        $rows = array_map(static fn ($r) => [
            'at' => (int) ($r['at'] ?? 0), 'model' => (string) ($r['model'] ?? ''),
            'in' => (int) ($r['in'] ?? 0), 'out' => (int) ($r['out'] ?? 0), 'cost' => $dollars((int) ($r['cost'] ?? 0)),
            'note' => (string) ($r['note'] ?? ''),
        ], array_reverse(array_slice($l['log'], -300)));
        api_json(['month' => ai_month(), 'spent' => $dollars(ai_ledger_total($l)), 'cap' => or_settings($root, $uid)['cap'] / 100, 'rows' => $rows]);
    }

    case 'POST chat':
        break;

    default:
        api_fail(400, 'Unknown request.');
}

// ---- A conversation turn, streamed ----
$raw = (string) file_get_contents('php://input', false, null, 0, AI_MAX_INPUT_CHARS * 4 + 65536 + 1);
if (strlen($raw) > AI_MAX_INPUT_CHARS * 4 + 65536) {
    api_fail(413, 'That is more text than one request may carry (about 400,000 letters). Send a shorter part.');
}
$body = json_decode($raw, true);
unset($raw);
if (!is_array($body) || !is_array($body['messages'] ?? null)) {
    api_fail(400, 'The desktop sent a request the server could not read. Reload the page and try again.');
}
$messages = [];
$chars = 0;
$bytes = 0; // for the cost reserve: Chinese, Japanese or Korean run to a token a letter or more, 3 bytes each
foreach (array_values($body['messages']) as $i => $m) {
    $role = is_array($m) ? body_str($m, 'role') : '';
    $content = is_array($m) ? body_str($m, 'content') : '';
    // Turns alternate, starting and ending with the person.
    if ($role !== ($i % 2 === 0 ? 'user' : 'assistant') || $content === '') {
        api_fail(400, 'The conversation was not in the expected order. Start a new chat and try again.');
    }
    $chars += $letters($content);
    $bytes += strlen($content);
    $messages[] = ['role' => $role, 'content' => $content];
}
if (!$messages || count($messages) > 80 || count($messages) % 2 === 0) {
    api_fail(400, 'The conversation was not in the expected order. Start a new chat and try again.');
}
if ($chars > AI_MAX_INPUT_CHARS) {
    api_fail(413, 'That conversation is too long to send (about 400,000 letters). Start a new chat.');
}

$s = or_settings($root, $uid);
$key = $s['key'] !== null ? ai_open($root, $uid, $s['key']) : null;
if ($key === null) {
    api_fail(409, $s['key'] === null ? 'No OpenRouter key is saved. Add yours in Settings > AI.' : 'The saved key can no longer be read on this server (it was moved or restored from elsewhere). Save your key again.', ['setup' => true]);
}
$model = $s['model'] !== '' ? or_model($root, $s['model']) : null;
if ($model === null) {
    api_fail(409, 'Choose an OpenRouter model in Settings > AI first.', ['setup' => true]);
}
$wait = rate_take($root, $uid, 'or-chat', 120, 3600);
if ($wait > 0) {
    api_fail(429, 'That is 120 questions in an hour. Wait a few minutes, then carry on.', ['wait' => $wait]);
}
$worst = or_worst_micro($model, $bytes);
$reserve = ai_reserve($root, $uid, $s['cap'], $worst, null, OR_BOOK);
if ($reserve === null) {
    $spent = ai_ledger_total(ai_ledger_read($root, $uid, ai_month(), OR_BOOK));
    api_fail(402, sprintf('This could pass your monthly OpenRouter limit of $%.2f (spent $%.2f so far this month; one answer from %s can cost up to $%.2f). Raise the limit in Settings > AI, choose a cheaper model, or wait until next month.', $s['cap'] / 100, $spent / 1e6, $model['name'], $worst / 1e6), ['cap' => true]);
}

ignore_user_abort(true);
@ini_set('zlib.output_compression', '0');
@set_time_limit(300);
$started = false;
$emitted = 0;
$emit = static function (array $line) use (&$started): void {
    if (!$started) {
        $started = true;
        while (ob_get_level() > 0) {
            ob_end_clean();
        }
        header('Content-Type: application/x-ndjson; charset=utf-8');
        header('X-Accel-Buffering: no');
    }
    echo json_encode($line, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), "\n";
    flush();
};
$note = '';
$r = ['in' => 0, 'out' => 0, 'cost' => null, 'stop' => '', 'error' => null, 'aborted' => false];
try {
    $res = or_http()->post('chat/completions', [
        'headers' => ['Authorization' => 'Bearer ' . $key, 'Content-Type' => 'application/json', 'Accept' => 'text/event-stream'],
        'json' => [
            'model' => $model['id'],
            'max_tokens' => OR_MAX_OUTPUT,
            'stream' => true,
            // The tokens and OpenRouter's own cost in the last message, so what is booked is what was charged.
            'usage' => ['include' => true],
            'messages' => array_merge([['role' => 'system', 'content' => 'You are the AI inside TOMLIN OS, a person\'s own web desktop. Answer plainly and helpfully, like a person would. Keep answers short unless asked for more. When asked to summarise or rewrite, reply with only the result.']], $messages),
        ],
        'stream' => true,
    ]);
    unset($key);
    $status = $res->getStatusCode();
    if ($status !== 200) {
        // Refused before any work: nothing was charged.
        [$code, $words] = or_error_words($status);
        ai_book($root, $uid, $reserve, ['model' => $model['name'], 'in' => 0, 'out' => 0, 'cost' => 0, 'note' => 'refused (' . $status . ')'], null, OR_BOOK);
        api_fail($code, $words);
    }
    $r = or_read_stream($res->getBody(), static function (string $t) use ($emit, &$emitted, $letters): void {
        $emit(['t' => $t]);
        $emitted += $letters($t);
    }, static fn (): bool => (bool) connection_aborted());
    if ($r['aborted']) {
        $note = 'stopped';
    }
    if ($r['error'] !== null) {
        $note = 'broke off';
        $emit(['error' => or_error_words($r['error']['code'])[1]]);
    }
} catch (Throwable $e) {
    unset($key);
    error_log('TOMLIN OS OpenRouter: ' . get_class($e));
    if (!$started) {
        ai_book($root, $uid, $reserve, ['model' => $model['name'], 'in' => 0, 'out' => 0, 'cost' => 0, 'note' => 'could not reach OpenRouter'], null, OR_BOOK);
        api_fail(...or_error_words(0));
    }
    $note = 'broke off';
    $emit(['error' => or_error_words(0)[1]]);
}
if ($r['out'] === 0 && $emitted > 0) {
    // The final count never came: the words received stand in for it (about 4 letters a token).
    $r['out'] = intdiv($emitted, 4) + 1;
    $r['in'] = $r['in'] ?: intdiv($chars, 4) + 1;
    $note = trim($note . ', estimated', ', ');
}
// OpenRouter's own figure when it sent one; otherwise worked out from the list prices.
$cost = $r['cost'] !== null ? (int) ceil($r['cost'] * 1e6) : or_cost_micro($model, $r['in'], $r['out']);
if ($r['cost'] === null && $r['in'] === 0 && $r['out'] === 0 && !$r['aborted'] && $r['error'] === null && $r['stop'] !== '') {
    // Finished, but no count came and no words either (a model that only "thought"): booked at the most it could have
    // cost, never at nothing, so the monthly cap still holds.
    $cost = $worst;
    $note = trim($note . ', no count sent: booked at the most it could cost', ', ');
}
ai_book($root, $uid, $reserve, ['model' => $model['name'], 'in' => $r['in'], 'out' => $r['out'], 'cost' => $cost, 'note' => $note ?: ($r['stop'] === 'length' ? 'cut at the length limit' : '')], null, OR_BOOK);
$emit([
    'done' => true, 'model' => $model['name'], 'in' => $r['in'], 'out' => $r['out'], 'cost' => $dollars($cost),
    'stop' => $r['stop'] === 'length' ? 'max_tokens' : $r['stop'], 'spent' => $dollars(ai_ledger_total(ai_ledger_read($root, $uid, ai_month(), OR_BOOK))), 'cap' => $s['cap'] / 100,
]);
exit;
