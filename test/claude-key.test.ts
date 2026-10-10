// "Your own Claude key" (server/lib/claude.php), run by PHP directly: the key is sealed and only its owner's id opens
// it; a key must look like an Anthropic key before it is sent anywhere; costs are whole millionths of a dollar at
// Anthropic's list prices; and the monthly cap is checked with the MOST a request could cost, set aside so that two
// requests at once cannot both slip under it. No request reaches Anthropic here. Skipped without PHP.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PHP, extFlags, hasPhp } from './php-bin.ts';
import { tempDir } from './tmp.ts';

const root = join(import.meta.dirname, '..');
const ext = extFlags('openssl');

function php(body: string): Record<string, any> {
  const dir = tempDir('tomlinos-ai-');
  const file = join(dir, 't.php');
  writeFileSync(file, `<?php
require ${JSON.stringify(join(root, 'server/lib/http.php'))};
require ${JSON.stringify(join(root, 'server/lib/auth.php'))};
require ${JSON.stringify(join(root, 'server/lib/claude.php'))};
$d = ${JSON.stringify(dir)};
${body}`);
  const out = JSON.parse(execFileSync(PHP, [...ext, file], { encoding: 'utf8' }));
  return { ...out, dir };
}

test('a saved key is sealed, opens only for its owner, and the plain key is nowhere in the files', { skip: !hasPhp && 'no PHP' }, () => {
  const key = 'sk-ant-api03-' + 'A'.repeat(80) + 'wxyz';
  const r = php(`
$sealed = ai_seal($d, 'u1', ${JSON.stringify(key)});
ai_save_settings($d, 'u1', ['key' => $sealed, 'hint' => 'wxyz', 'model' => 'claude-sonnet-5', 'cap' => 300, 'saved' => 1]);
$again = ai_seal($d, 'u1', ${JSON.stringify(key)});
echo json_encode([
  'opens' => ai_open($d, 'u1', $sealed),
  'other_person' => ai_open($d, 'u2', $sealed),
  'tampered' => ai_open($d, 'u1', substr($sealed, 0, -4) . 'AAAA'),
  'fresh_each_time' => $again !== $sealed,
  'settings' => ai_settings($d, 'u1'),
]);`);
  assert.equal(r.opens, key);
  assert.equal(r.other_person, null, 'bound to the person');
  assert.equal(r.tampered, null, 'a changed file is refused, not misread');
  assert.ok(r.fresh_each_time, 'a new random start each time');
  assert.equal(r.settings.model, 'claude-sonnet-5');
  assert.equal(r.settings.cap, 300);
  const accounts = join(r.dir, 'accounts');
  const all = [...readdirSync(accounts), ...readdirSync(join(accounts, 'ai')).map(f => join('ai', f))];
  for (const f of all) {
    if (f === 'ai' || f === 'sessions' || f === 'history') continue;
    assert.ok(!readFileSync(join(accounts, f), 'utf8').includes('sk-ant-'), `${f} holds no plain key`);
  }
});

test('only Anthropic-shaped keys are accepted; bad settings fall back to safe values', { skip: !hasPhp && 'no PHP' }, () => {
  const r = php(`
ai_save_settings($d, 'u1', ['key' => null, 'model' => 'gpt-5', 'cap' => 99999999]);
echo json_encode([
  'good' => ai_key_shape_ok('sk-ant-api03-' . str_repeat('x', 40)),
  'openai' => ai_key_shape_ok('sk-proj-' . str_repeat('x', 40)),
  'short' => ai_key_shape_ok('sk-ant-abc'),
  'newline' => ai_key_shape_ok("sk-ant-api03-" . str_repeat('x', 40) . "\\nX-Evil: 1"),
  'settings' => ai_settings($d, 'u1'),
  'bad_id' => (function () use ($d) { try { ai_user_file($d, '../x', 'settings'); return 'allowed'; } catch (RuntimeException) { return 'refused'; } })(),
]);`);
  assert.equal(r.good, true);
  assert.equal(r.openai, false);
  assert.equal(r.short, false);
  assert.equal(r.newline, false, 'no header can ride in on a key');
  assert.equal(r.settings.model, 'claude-opus-5', 'an unknown model falls back to the default');
  assert.equal(r.settings.cap, 100000, 'the cap is held to its most ($1,000)');
  assert.equal(r.bad_id, 'refused', 'a person id cannot climb out of the folder');
});

test('costs are Anthropic list prices in whole millionths of a dollar', { skip: !hasPhp && 'no PHP' }, () => {
  const r = php(`echo json_encode([
  'opus' => ai_cost_micro('claude-opus-5', 1000000, 1000000),
  'sonnet' => ai_cost_micro('claude-sonnet-5', 2000, 500),
  'haiku_cache' => ai_cost_micro('claude-haiku-4-5', 0, 0, 1000000, 1000000),
  'worst_opus_1000_letters' => ai_worst_micro('claude-opus-5', 1000),
]);`);
  assert.equal(r.opus, 30_000_000, '$5 + $25');
  assert.equal(r.sonnet, 9_000, '2,000 in at $2/M + 500 out at $10/M = $0.009');
  assert.equal(r.haiku_cache, 1_350_000, 'cache write 1.25x + cache read 0.1x of $1');
  assert.equal(r.worst_opus_1000_letters, (333 + 200) * 5 + 8000 * 25, 'generous input + a full answer');
});

test('the cap: the most a request could cost is set aside; over the cap is refused; booking releases the rest', { skip: !hasPhp && 'no PHP' }, () => {
  const r = php(`
$worst = 210000; // $0.21
$a = ai_reserve($d, 'u1', 50, $worst, 1000);          // cap $0.50
$b = ai_reserve($d, 'u1', 50, $worst, 1000);          // two at once: $0.42 held
$c = ai_reserve($d, 'u1', 50, $worst, 1000);          // a third would pass $0.50
ai_book($d, 'u1', $a, ['model' => 'claude-opus-5', 'in' => 10, 'out' => 10, 'cost' => 1000], 1000);
$d2 = ai_reserve($d, 'u1', 50, $worst, 1000);         // $0.001 spent + $0.21 + $0.21 held: fits
$e = ai_reserve($d, 'u1', 50, $worst, 1000 + 901);    // b and d2 went stale (their requests died): released
$l = ai_ledger_read($d, 'u1', ai_month(1000));
echo json_encode(['a' => $a !== null, 'b' => $b !== null, 'c' => $c, 'd' => $d2 !== null, 'e' => $e !== null,
  'spent' => $l['spent'], 'log' => $l['log'], 'zero_cap' => ai_reserve($d, 'u9', 0, 1, 1000)]);`);
  assert.ok(r.a && r.b, 'two requests fit under the cap together');
  assert.equal(r.c, null, 'a third that could pass the cap is refused before anything is sent');
  assert.ok(r.d, 'booking the real cost frees the rest of what was set aside');
  assert.ok(r.e, 'set-asides of requests that died are released after 15 minutes');
  assert.equal(r.spent, 1000);
  assert.deepEqual(Object.keys(r.log[0]).sort(), ['at', 'cost', 'in', 'model', 'out'], 'the log keeps numbers, never words');
  assert.equal(r.zero_cap, null, 'a $0 cap stops everything');
});
