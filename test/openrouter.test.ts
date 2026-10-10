// "Your own OpenRouter key" (server/lib/openrouter.php), run by PHP directly: only OpenRouter-shaped keys and model ids
// are accepted; prices come from OpenRouter's per-token strings; the stream reader takes the answer and OpenRouter's own
// cost from the last message; and OpenRouter's spending has its own book and cap, apart from Claude's. No request
// reaches OpenRouter here. Skipped without PHP. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PHP, extFlags, hasPhp } from './php-bin.ts';
import { filterModels } from '../src/apps/assistant/openrouter.ts';
import { tempDir } from './tmp.ts';

const root = join(import.meta.dirname, '..');
const ext = extFlags('openssl', 'curl');

function php(body: string): Record<string, any> {
  const dir = tempDir('tomlinos-or-');
  const file = join(dir, 't.php');
  writeFileSync(file, `<?php
require ${JSON.stringify(join(root, 'server/lib/http.php'))};
require ${JSON.stringify(join(root, 'server/lib/auth.php'))};
require ${JSON.stringify(join(root, 'server/lib/openrouter.php'))};
$d = ${JSON.stringify(dir)};
${body}`);
  return JSON.parse(execFileSync(PHP, [...ext, file], { encoding: 'utf8' }));
}

test('only OpenRouter-shaped keys and model ids are accepted', { skip: !hasPhp && 'no PHP' }, () => {
  const r = php(`echo json_encode([
  'good' => or_key_shape_ok('sk-or-v1-' . str_repeat('a1', 32)),
  'anthropic' => or_key_shape_ok('sk-ant-api03-' . str_repeat('A', 80)),
  'spaces' => or_key_shape_ok('sk-or-v1-abc def ghi jkl mno pqr'),
  'models' => [or_model_id_ok('anthropic/claude-sonnet-4.5'), or_model_id_ok('meta-llama/llama-3.3-70b-instruct:free'), or_model_id_ok('../etc/passwd'), or_model_id_ok('openrouter/auto extra')],
]);`);
  assert.equal(r.good, true);
  assert.equal(r.anthropic, false, 'a Claude key is not taken for an OpenRouter one');
  assert.equal(r.spaces, false);
  assert.deepEqual(r.models, [true, true, false, false]);
});

test('prices: per-token strings become dollars per million; variable prices are left out; costs are whole millionths', { skip: !hasPhp && 'no PHP' }, () => {
  const r = php(`$m = ['in' => or_per_million('0.000003'), 'out' => or_per_million('0.000015')];
echo json_encode([
  'in' => $m['in'], 'out' => $m['out'], 'free' => or_per_million('0'), 'variable' => or_per_million('-1'), 'junk' => or_per_million('abc'),
  'cost' => or_cost_micro($m, 1000, 500), 'worst' => or_worst_micro($m, 3000),
]);`);
  assert.equal(r.in, 3);
  assert.equal(r.out, 15);
  assert.equal(r.free, 0);
  assert.equal(r.variable, null, 'the automatic router has no fixed price');
  assert.equal(r.junk, null);
  assert.equal(r.cost, 10500, '1000 x $3 + 500 x $15 per million = $0.0105');
  assert.equal(r.worst, (1000 + 200) * 3 + 8000 * 15, 'input at 3 letters a token, plus a full answer');
});

test('the stream: the answer piece by piece, then the tokens and OpenRouter\'s own cost from the last message', { skip: !hasPhp && 'no PHP' }, () => {
  const sse = [
    ': OPENROUTER PROCESSING', '',
    'data: {"choices":[{"delta":{"content":"Hey"}}]}', '',
    'data: {"choices":[{"delta":{"content":"! What are you up to?"},"finish_reason":"stop"}]}', '',
    'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":194,"completion_tokens":9,"cost":0.00012}}', '',
    'data: [DONE]', '',
  ].join('\n');
  const r = php(`$text = '';
$body = GuzzleHttp\\Psr7\\Utils::streamFor(${JSON.stringify(sse)});
$got = or_read_stream($body, static function (string $t) use (&$text): void { $text .= $t; }, static fn (): bool => false);
echo json_encode(['text' => $text] + $got);`);
  assert.equal(r.text, 'Hey! What are you up to?');
  assert.equal(r.in, 194);
  assert.equal(r.out, 9);
  assert.equal(r.cost, 0.00012);
  assert.equal(r.stop, 'stop');
  assert.equal(r.error, null);
});

test('an error sent mid-stream is reported, in plain words, never the raw reply', { skip: !hasPhp && 'no PHP' }, () => {
  const r = php(`$body = GuzzleHttp\\Psr7\\Utils::streamFor("data: {\\"error\\":{\\"code\\":402,\\"message\\":\\"Insufficient credits\\"}}\\n\\ndata: [DONE]\\n");
$got = or_read_stream($body, static function (string $t): void {}, static fn (): bool => false);
echo json_encode(['got' => $got, 'words' => or_error_words($got['error']['code'])]);`);
  assert.equal(r.got.error.code, 402);
  assert.match(r.words[1], /no credit left/);
});

test('OpenRouter spending has its own book and cap, apart from Claude\'s', { skip: !hasPhp && 'no PHP' }, () => {
  const r = php(`$now = 1790000000;
$claude = ai_reserve($d, 'u1', 1, 9000, $now);
$or1 = ai_reserve($d, 'u1', 1, 9000, $now, OR_BOOK);
$or2 = ai_reserve($d, 'u1', 1, 9000, $now, OR_BOOK);
ai_book($d, 'u1', $or1, ['model' => 'x', 'in' => 1, 'out' => 1, 'cost' => 250, 'note' => ''], $now, OR_BOOK);
echo json_encode([
  'claude' => $claude !== null, 'or1' => $or1 !== null, 'or2' => $or2,
  'orSpent' => ai_ledger_read($d, 'u1', ai_month($now), OR_BOOK)['spent'],
  'claudeSpent' => ai_ledger_read($d, 'u1', ai_month($now))['spent'],
]);`);
  assert.equal(r.claude, true);
  assert.equal(r.or1, true, 'a Claude set-aside does not use up the OpenRouter cap');
  assert.equal(r.or2, null, 'two set-asides at once cannot both pass a 1-cent cap');
  assert.equal(r.orSpent, 250);
  assert.equal(r.claudeSpent, 0);
});

test('finding a model: every word typed, in its name or id', () => {
  const models = [
    { id: 'anthropic/claude-sonnet-4.5', name: 'Anthropic: Claude Sonnet 4.5', in: 3, out: 15, context: 200000 },
    { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Meta: Llama 3.3 70B Instruct (free)', in: 0, out: 0, context: 131072 },
  ];
  assert.deepEqual(filterModels(models, 'llama free').map(m => m.id), ['meta-llama/llama-3.3-70b-instruct:free']);
  assert.equal(filterModels(models, '').length, 2);
  assert.equal(filterModels(models, 'gpt').length, 0);
});
