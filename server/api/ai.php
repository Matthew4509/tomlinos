<?php
// "Your own Claude key", set in Settings > AI and used in Chat > Agents (see lib/claude.php for the rules).
//   GET  op=settings  whether a key is saved (its last four characters only), the model, the monthly cap, spent so far
//   POST op=save      {key?, model, cap}  a new key is tried with Anthropic (a free call) before it is kept
//   POST op=forget    removes the key (the cost log stays)
//   GET  op=log       this month's cost log: time, model, tokens, cost (never what was said)
//   POST op=chat      {messages: [{role, content}]}  streams the answer back as lines of JSON:
//                     {"t": "text"} while it writes, then {"done": true, ...tokens and cost} or {"error": "..."}
// Signed-in people only; each person uses their OWN key and their own cap.
declare(strict_types=1);

require __DIR__ . '/../lib/http.php';
require __DIR__ . '/../lib/auth.php';
require __DIR__ . '/../lib/outbound.php';
require __DIR__ . '/../lib/claude.php';

api_headers();
api_guard();

$config = api_config();
$root = rtrim((string) $config['data_dir'], '/\\');
[, , $user] = require_full($root);
$uid = (string) $user['id'];
$op = query_str('op');
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$dollars = static fn (int $micro): float => round($micro / 1e6, 4);
// Letters where mbstring is on; bytes otherwise (never fewer, so limits and estimates stay on the safe side).
$letters = static fn (string $t): int => function_exists('mb_strlen') ? mb_strlen($t) : strlen($t);

if (!extension_loaded('openssl')) {
    api_fail(501, 'This server has no secure-connection support (the PHP extension "openssl"), so it cannot keep a key or reach Anthropic. The owner ticks "openssl" in cPanel > Select PHP Version > Extensions.');
}

switch ("$method $op") {
    case 'GET settings': {
        $s = ai_settings($root, $uid);
        $l = ai_ledger_read($root, $uid, ai_month());
        $models = [];
        foreach (AI_MODELS as $id => $m) {
            $models[] = ['id' => $id, 'name' => $m['name'], 'in' => $m['in'], 'out' => $m['out'], 'note' => $m['note']];
        }
        api_json([
            'hasKey' => $s['key'] !== null, 'hint' => $s['hint'], 'model' => $s['model'], 'models' => $models,
            'cap' => $s['cap'] / 100, 'spent' => $dollars(ai_ledger_total($l)), 'month' => ai_month(), 'maxOutput' => AI_MAX_OUTPUT,
        ]);
    }

    case 'POST save': {
        $body = api_body();
        $wait = rate_take($root, $uid, 'ai-save', 10, 3600);
        if ($wait > 0) {
            api_fail(429, 'That is 10 changes in an hour. Wait a while, then try again.', ['wait' => $wait]);
        }
        $s = ai_settings($root, $uid);
        $model = body_str($body, 'model');
        if (!isset(AI_MODELS[$model])) {
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
            if (!ai_key_shape_ok($key)) {
                api_fail(400, 'That does not look like an Anthropic API key: they start with "sk-ant-". Copy it again from console.anthropic.com > API keys.');
            }
            // A free call proves the key works before it is kept (listing models costs nothing).
            try {
                ai_client($key)->models->list(limit: 1);
            } catch (Throwable $e) {
                [$status, $words] = ai_error_words($e);
                api_fail($status === 401 ? 400 : $status, $words);
            }
            $sealed = ai_seal($root, $uid, $key);
            $hint = substr($key, -4);
            auth_history_add($root, $uid, 'Saved a Claude API key (ending ' . $hint . ')');
        }
        ai_save_settings($root, $uid, ['key' => $sealed, 'hint' => $hint, 'model' => $model, 'cap' => (int) round($cap * 100), 'saved' => time()]);
        api_json(['ok' => true, 'hasKey' => $sealed !== null, 'hint' => $hint]);
    }

    case 'POST forget': {
        $s = ai_settings($root, $uid);
        if ($s['key'] !== null) {
            auth_history_add($root, $uid, 'Removed the Claude API key (ending ' . $s['hint'] . ')');
        }
        ai_save_settings($root, $uid, ['key' => null, 'hint' => '', 'model' => $s['model'], 'cap' => $s['cap'], 'saved' => time()]);
        api_json(['ok' => true]);
    }

    case 'GET log': {
        $l = ai_ledger_read($root, $uid, ai_month());
        $rows = array_map(static fn ($r) => [
            'at' => (int) ($r['at'] ?? 0), 'model' => (string) (AI_MODELS[$r['model'] ?? '']['name'] ?? ($r['model'] ?? '')),
            'in' => (int) ($r['in'] ?? 0), 'out' => (int) ($r['out'] ?? 0), 'cost' => $dollars((int) ($r['cost'] ?? 0)),
            'note' => (string) ($r['note'] ?? ''),
        ], array_reverse(array_slice($l['log'], -300)));
        api_json(['month' => ai_month(), 'spent' => $dollars(ai_ledger_total($l)), 'cap' => ai_settings($root, $uid)['cap'] / 100, 'rows' => $rows]);
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

$s = ai_settings($root, $uid);
$key = $s['key'] !== null ? ai_open($root, $uid, $s['key']) : null;
if ($key === null) {
    api_fail(409, $s['key'] === null ? 'No Claude API key is saved. Add yours in Settings > AI.' : 'The saved key can no longer be read on this server (it was moved or restored from elsewhere). Save your key again.', ['setup' => true]);
}
$wait = rate_take($root, $uid, 'ai-chat', 120, 3600);
if ($wait > 0) {
    api_fail(429, 'That is 120 questions in an hour. Wait a few minutes, then carry on.', ['wait' => $wait]);
}
$model = $s['model'];
$worst = ai_worst_micro($model, $bytes);
$reserve = ai_reserve($root, $uid, $s['cap'], $worst);
if ($reserve === null) {
    $spent = ai_ledger_total(ai_ledger_read($root, $uid, ai_month()));
    api_fail(402, sprintf('This could pass your monthly limit of $%.2f (spent $%.2f so far this month; one answer from %s can cost up to $%.2f). Raise the limit in the Claude settings, choose a cheaper model, or wait until next month.', $s['cap'] / 100, $spent / 1e6, AI_MODELS[$model]['name'], $worst / 1e6), ['cap' => true]);
}

// From here the answer streams: no buffering anywhere, and a closed tab stops the request (what it used is still booked).
ignore_user_abort(true);
@ini_set('zlib.output_compression', '0');
@set_time_limit(300);
$in = 0;
$out = 0;
$cacheWrite = 0;
$cacheRead = 0;
$stop = '';
$chunks = 0;
$emitted = 0;
$started = false;
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
try {
    $stream = ai_client($key)->messages->createStream(
        model: $model,
        maxTokens: AI_MAX_OUTPUT,
        system: 'You are the AI inside TOMLIN OS, a person\'s own web desktop. Answer plainly and helpfully. Keep answers short unless asked for more. When asked to summarise or rewrite, reply with only the result.',
        messages: $messages,
    );
    unset($key);
    foreach ($stream as $event) {
        if ($event instanceof Anthropic\Messages\RawMessageStartEvent) {
            $u = $event->message->usage;
            $in = (int) $u->inputTokens;
            $cacheWrite = (int) ($u->cacheCreationInputTokens ?? 0);
            $cacheRead = (int) ($u->cacheReadInputTokens ?? 0);
        } elseif ($event instanceof Anthropic\Messages\RawContentBlockDeltaEvent && $event->delta instanceof Anthropic\Messages\TextDelta) {
            $emit(['t' => $event->delta->text]);
            $emitted += $letters($event->delta->text);
            if (++$chunks % 8 === 0 && connection_aborted()) {
                $note = 'stopped';
                break;
            }
        } elseif ($event instanceof Anthropic\Messages\RawMessageDeltaEvent) {
            $out = (int) $event->usage->outputTokens;
            $in = (int) ($event->usage->inputTokens ?? $in);
            $stop = (string) ($event->delta->stopReason ?? '');
        }
    }
} catch (Throwable $e) {
    unset($key);
    [$status, $words] = ai_error_words($e);
    error_log('TOMLIN OS AI: ' . get_class($e) . ' status ' . $status);
    if (!$started && $in === 0) {
        // Refused before any work: Anthropic charges nothing for that.
        ai_book($root, $uid, $reserve, ['model' => $model, 'in' => 0, 'out' => 0, 'cost' => 0, 'note' => 'refused (' . $status . ')']);
        api_fail($status, $words);
    }
    $note = 'broke off';
    $emit(['error' => $words]);
}
if ($note !== '' && $out === 0) {
    // Stopped part-way: the final count never came, so the words received stand in for it (about 4 letters a token).
    $out = intdiv($emitted, 4) + 1;
    $note .= ', output estimated';
}
$cost = ai_cost_micro($model, $in, $out, $cacheWrite, $cacheRead);
ai_book($root, $uid, $reserve, ['model' => $model, 'in' => $in + $cacheWrite + $cacheRead, 'out' => $out, 'cost' => $cost, 'note' => $note ?: ($stop === 'max_tokens' ? 'cut at the length limit' : ($stop === 'refusal' ? 'declined' : ''))]);
$emit([
    'done' => true, 'model' => AI_MODELS[$model]['name'], 'in' => $in + $cacheWrite + $cacheRead, 'out' => $out, 'cost' => $dollars($cost),
    'stop' => $stop, 'spent' => $dollars(ai_ledger_total(ai_ledger_read($root, $uid, ai_month()))), 'cap' => $s['cap'] / 100,
]);
exit;
