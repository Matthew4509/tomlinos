// Server faults found in the October stability check, each run against the real server/lib code with PHP (PHP_BIN, or
// php on the PATH): the sign-in brake, the accounts pepper, recovery codes, the store's "check" step and its read-only
// check tool, an IMAP reply with a stray NUL, mail headers, and the update's protected paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PHP, hasPhp } from './php-bin.ts';
import { tempDir } from './tmp.ts';

const root = join(import.meta.dirname, '..');
const noPhp = !hasPhp && 'no PHP';

function php(libs: string[], code: string, env: Record<string, string> = {}): any {
  const head = libs.map(l => `require 'server/lib/${l}.php';`).join(' ');
  const r = spawnSync(PHP, ['-d', 'opcache.enable=0', '-r', `${head} ${code}`], { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  return JSON.parse(r.stdout);
}

test('the brake on two-step codes holds: a wrong code after the hold begins never ends it', { skip: noPhp }, () => {
  const D = tempDir('tomlinos-brake-');
  const r = php(['http', 'auth'], `
    $d = getenv('D'); $ip = '203.0.113.9'; $n = 'ann';
    auth_throttle_fail($d, $ip, $n);                        // a right password with two-step on is charged, not cleared
    $tries = 0;
    while (auth_throttle_wait($d, $ip, $n) === 0 && $tries < 20) { auth_throttle_fail($d, $ip, $n); $tries++; }
    $held = auth_throttle_wait($d, $ip, $n);
    auth_throttle_fail($d, $ip, $n);                        // one more wrong try lands anyway (a request already under way)
    echo json_encode(['tries' => $tries, 'held' => $held, 'still' => auth_throttle_wait($d, $ip, $n)]);`, { D });
  assert.equal(r.tries, 4, 'held after the fifth wrong try in all');
  assert.ok(r.held > 3500, `held for an hour, got ${r.held} s`);
  assert.ok(r.still > 3500, `a later wrong try does not end the hold (got ${r.still} s)`);
});

test('a right password takes nothing off the earlier wrong tries, and adds none, nor a hold of its own', { skip: noPhp }, () => {
  const D = tempDir('tomlinos-refund-');
  const r = php(['http', 'auth'], `
    $d = getenv('D'); $ip = '203.0.113.7'; $n = 'bo';
    for ($i = 0; $i < 4; $i++) auth_throttle_fail($d, $ip, $n);   // four wrong passwords
    auth_throttle_take($d, $ip, $n, $before);                      // the fifth try is charged first (a hold starts)...
    $charged = auth_throttle_wait($d, $ip, $n);
    auth_throttle_refund($d, $ip, $before);                        // ...and turns out right: put back as it was
    $t = auth_read_json(auth_dir($d) . '/throttle.json', []);
    echo json_encode(['charged' => $charged, 'after' => auth_throttle_wait($d, $ip, $n), 'count' => $t['name'][auth_throttle_key($n, auth_throttle_ip($ip))]['count'] ?? 0]);`, { D });
  assert.ok(r.charged > 3500, 'while being checked, the try counts');
  assert.equal(r.after, 0, 'a right password leaves no hold');
  assert.equal(r.count, 4, 'and the four wrong tries before it still count');
});

test('the accounts pepper is read with a line ending added, and never replaced when damaged', { skip: noPhp }, () => {
  const D = tempDir('tomlinos-pepper-');
  const first = php(['http', 'auth'], `echo json_encode(bin2hex(auth_pepper(getenv('D'))));`, { D });
  const file = join(D, 'accounts', 'pepper');
  writeFileSync(file, readFileSync(file, 'utf8') + '\r\n');
  assert.equal(php(['http', 'auth'], `echo json_encode(bin2hex(auth_pepper(getenv('D'))));`, { D }), first, 'same pepper after an editor added a line ending');
  writeFileSync(file, 'not a pepper');
  const r = php(['http', 'auth'], `try { auth_pepper(getenv('D')); echo json_encode('made'); } catch (RuntimeException $e) { echo json_encode($e->getMessage()); }`, { D });
  assert.match(r, /damaged/);
  assert.equal(readFileSync(file, 'utf8'), 'not a pepper', 'the damaged file is left for the owner to put back');
});

test('a recovery code typed without dashes, in capitals or with spaces is the same code', { skip: noPhp }, () => {
  const r = php(['http', 'auth'], `echo json_encode(array_map('auth_recovery_form', ['K7M2-9XQ4-BD', 'k7m29xq4bd', ' k7m2 9xq4 bd ', 'k7m2-9xq4-bd', 'short']));`);
  assert.deepEqual(r, ['k7m2-9xq4-bd', 'k7m2-9xq4-bd', 'k7m2-9xq4-bd', 'k7m2-9xq4-bd', 'short']);
});

test('no new person gets an id of digits only', { skip: noPhp }, () => {
  const r = php(['http', 'auth'], `$bad = 0; for ($i = 0; $i < 20000; $i++) { if (ctype_digit(auth_new_user_id())) $bad++; } echo json_encode($bad);`);
  assert.equal(r, 0);
});

test('the store: a commit with a check is refused once the checked record has changed, and writes nothing', { skip: noPhp }, () => {
  const D = tempDir('tomlinos-check-');
  const r = php(['store'], `
    $d = getenv('D');
    $v = store_commit($d, [['op' => STORE_OP_PUT, 'key' => '/', 'expect' => '', 'data' => 'root']]);
    $ok = store_commit($d, [['op' => STORE_OP_CHECK, 'key' => '/', 'expect' => $v['/'], 'data' => '']]);
    store_commit($d, [['op' => STORE_OP_PUT, 'key' => '/', 'expect' => $v['/'], 'data' => 'root2']]);
    $k = '11111111-1111-4111-8111-111111111111';
    try { store_commit($d, [['op' => STORE_OP_PUT, 'key' => $k, 'expect' => '', 'data' => 'x'], ['op' => STORE_OP_CHECK, 'key' => '/', 'expect' => $v['/'], 'data' => '']]); $refused = false; }
    catch (StoreConflict $c) { $refused = $c->keys; }
    // A check never takes the place of a write to the same key.
    $w = store_commit($d, [['op' => STORE_OP_PUT, 'key' => $k, 'expect' => '', 'data' => 'y'], ['op' => STORE_OP_CHECK, 'key' => $k, 'expect' => 'ffffffffffffffffffffffffffffffff', 'data' => '']]);
    $parsed = store_parse_commit(chr(3) . pack('v', 1) . '/' . chr(0));
    echo json_encode(['ok' => $ok, 'refused' => $refused, 'written' => store_get($d, $k)[1] ?? null, 'parsedOp' => $parsed[0]['op']]);`, { D });
  assert.deepEqual(r.ok, [], 'a check alone writes nothing');
  assert.deepEqual(r.refused, ['/']);
  assert.equal(r.written, 'y', 'the refused commit wrote nothing; the put beside a check on its own key went in');
  assert.equal(r.parsedOp, 3);
});

test('store-check without --repair changes nothing and reports a cut-off save', { skip: noPhp }, () => {
  const D = tempDir('tomlinos-storecheck-');
  const r = php(['store'], `
    $d = getenv('D');
    store_commit($d, [['op' => STORE_OP_PUT, 'key' => '/', 'expect' => '', 'data' => '{"v":1,"entries":[]}']]);
    file_put_contents("$d/.journal", json_encode(['moves' => [], 'usage' => 999, 'count' => 99]));
    $look = store_check($d, false);
    $still = is_file("$d/.journal");
    $fix = store_check($d, true);
    echo json_encode(['look' => $look['journal'], 'still' => $still, 'fix' => $fix['journal'], 'gone' => !is_file("$d/.journal")]);`, { D });
  assert.deepEqual(r, { look: true, still: true, fix: true, gone: true });
});

test('an IMAP reply with a stray NUL ends the parse instead of looping for ever', { skip: noPhp }, () => {
  const r = php(['http', 'outbound', 'mailnet'], `echo json_encode(Imap::parse('(FLAGS (\\\\Seen) X ' . chr(0) . 'abc)', []));`);
  assert.ok(Array.isArray(r));
});

test('mail headers: a name with a comma is quoted, encoded words stay short, long address lists are folded', { skip: noPhp }, () => {
  const r = php(['http', 'outbound', 'mailnet'], `
    $msg = mail_build(['from' => 'a@b.co', 'fromName' => 'Smith, John', 'to' => array_map(fn ($i) => "person$i@example.com", range(1, 60)), 'cc' => [],
      'subject' => str_repeat('é', 40), 'text' => 'hi', 'attachments' => [], 'inReplyTo' => '<x@y>', 'references' => str_repeat('<ref@example.com> ', 40)]);
    [$head] = explode("\\r\\n\\r\\n", $msg, 2);
    $longest = max(array_map('strlen', explode("\\r\\n", $head)));
    preg_match_all('/=\\?UTF-8\\?B\\?[^?]*\\?=/', $head, $words);
    echo json_encode(['from' => preg_match('/^From: (.*)$/m', $head, $m) ? $m[1] : '', 'longest' => $longest, 'words' => count($words[0]), 'widest' => max(array_map('strlen', $words[0]))]);`);
  assert.equal(r.from.trimEnd(), '"Smith, John" <a@b.co>');
  assert.ok(r.longest <= 998, `every header line within 998 characters (longest ${r.longest})`);
  assert.ok(r.widest <= 75, `every encoded word within 75 characters (widest ${r.widest})`);
  assert.ok(r.words <= 5, `40 letters in a few words, not one a letter (${r.words})`);
});

test('the update never reaches the protected files by another spelling of their path', { skip: noPhp }, () => {
  const r = php(['updater'], `echo json_encode(array_map(fn ($n) => update_target($n, '/web', '/priv'), ['tomlinos//config.php', 'tomlinos/./data/x', 'tomlinos/Data/x', 'tomlinos/CONFIG.php', 'public_html/a:b', 'tomlinos/lib/x.php']));`);
  assert.deepEqual(r, [null, null, null, null, null, '/priv/lib/x.php']);
});

test('a relative redirect is read against the address it came from', { skip: noPhp }, () => {
  const r = php(['download'], `echo json_encode([download_resolve('https://x.com/a/b/c?q', '../d'), download_resolve('https://x.com/a', '//y.org/z'), download_resolve('https://x.com/a/b', '/r/./s/../t')]);`);
  assert.deepEqual(r, ['https://x.com/a/d', 'https://y.org/z', 'https://x.com/r/t']);
});

test('the dev router answers 404 to a null byte, without a PHP error page', { skip: noPhp }, () => {
  const out = tempDir('tomlinos-router-');
  const r = spawnSync(PHP, ['-d', 'opcache.enable=0', '-r', `$_SERVER['REQUEST_URI'] = '/%00'; $_SERVER['DOCUMENT_ROOT'] = getenv('OUT'); $_SERVER['REMOTE_ADDR'] = '127.0.0.1'; ob_start(); require 'server/dev-router.php'; echo json_encode(['code' => http_response_code(), 'body' => ob_get_clean()]);`],
    { cwd: root, env: { ...process.env, OUT: out }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const last = JSON.parse(r.stdout.slice(r.stdout.lastIndexOf('{"code"')));
  assert.equal(last.body, 'Not found');
  assert.ok(existsSync(out));
});
