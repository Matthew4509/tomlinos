// Second audit (November 2026) of the server endpoints outside Account that ask for the owner's password and two-step
// code: a change that is refused must keep the code (L11). Against the real PHP server on a throw-away data folder.
// Needs PHP: set PHP_BIN to its path, or have "php" on the PATH.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PHP, hasPhp, portFree } from './php-bin.ts';

const noPhp = !hasPhp && 'no PHP';
// 3757: not used by any other test.
const PORT = 3757;
const BASE = `http://127.0.0.1:${PORT}`;
const data = mkdtempSync(join(tmpdir(), 'desktop-audit2-server-'));
const PASS = 'copper-meadow-82';
const MODEL = 'Qwen3.5-0.8B-q4f32_1-MLC';
let php: ChildProcess;
let cookie = '';
let recovery: string[] = [];

async function call(path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${BASE}/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-Desktop-Store': '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** Holds the model's save lock (as a save running in another window would) until the PHP it starts is killed. */
async function holdModelLock(): Promise<ChildProcess> {
  const dir = join(data, 'models').replace(/\\/g, '/');
  const holder = spawn(PHP, ['-r', `@mkdir('${dir}', 0700, true); $f = fopen('${dir}/${MODEL}.lock', 'c'); flock($f, LOCK_EX); echo "held\\n"; sleep(30);`], { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise<void>((resolve, reject) => {
    holder.stdout!.on('data', d => String(d).includes('held') && resolve());
    holder.once('exit', () => reject(new Error('the lock holder stopped early')));
  });
  return holder;
}

before(async () => {
  if (noPhp) return;
  await portFree(PORT);
  php = spawn(PHP, ['-S', `127.0.0.1:${PORT}`, '-t', 'public', 'server/dev-router.php'], {
    env: { ...process.env, DESKTOP_DATA_DIR: data, DESKTOP_TEST_CAPTCHA: '1' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${BASE}/storage.json`);
      break;
    } catch {
      await new Promise(r => setTimeout(r, 100));
    }
  }
  assert.equal((await call('auth.php?op=setup', { name: 'robin', password: PASS })).status, 200);
  const begin = await call('auth.php?op=totp-begin', { password: PASS });
  assert.equal(begin.status, 200, JSON.stringify(begin.json));
  // Any current code turns two-step on; the tests below use the recovery codes it gives (no clock involved).
  const { createHmac } = await import('node:crypto');
  const { base32Decode } = await import('../src/core/totp.ts');
  const key = Buffer.from(base32Decode(begin.json.secret));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const mac = createHmac('sha1', key).update(counter).digest();
  const code = String((mac.readUInt32BE(mac[19] & 15) & 0x7fffffff) % 1_000_000).padStart(6, '0');
  const enable = await call('auth.php?op=totp-enable', { code });
  assert.equal(enable.status, 200, JSON.stringify(enable.json));
  recovery = enable.json.recovery;
  assert.ok(recovery.length >= 3);
});

after(() => {
  php?.kill();
  rmSync(data, { recursive: true, force: true });
});

test('L11: removing an AI model that is being saved is refused, and the recovery code typed is kept for the retry', { skip: noPhp }, async () => {
  const body = { id: MODEL, password: PASS, code: recovery[0] };
  const holder = await holdModelLock();
  try {
    const refused = await call('models.php?op=remove', body);
    assert.equal(refused.status, 409, JSON.stringify(refused.json));
  } finally {
    holder.kill();
    await new Promise(r => holder.once('exit', r));
  }
  const retry = await call('models.php?op=remove', body);
  assert.equal(retry.status, 200, `the refused remove used up the recovery code: ${retry.status} ${JSON.stringify(retry.json)}`);
  const again = await call('models.php?op=remove', body);
  assert.equal(again.status, 403, 'a change that went ahead still uses the code up');
});

test('L11: the owner-only Chat changes still use the code up once they go ahead', { skip: noPhp }, async () => {
  const body = { password: PASS, code: recovery[1] };
  const reset = await call('chat.php?op=reset', body);
  assert.equal(reset.status, 200, JSON.stringify(reset.json));
  assert.equal((await call('chat.php?op=reset', body)).status, 403, 'the same recovery code twice');
  const wrong = await call('chat.php?op=settings', { vanishDays: 5, password: PASS, code: recovery[2] });
  assert.equal(wrong.status, 400, 'a refused setting');
  const ok = await call('chat.php?op=settings', { vanishDays: 7, password: PASS, code: recovery[2] });
  assert.equal(ok.status, 200, `the refused setting used up the code: ${JSON.stringify(ok.json)}`);
  assert.equal((await call('chat.php?op=settings', { vanishDays: 0, password: PASS, code: recovery[2] })).status, 403);
});

test('L11: a store app delete and a Go back use the code up only at their point of no return (run by PHP directly)', { skip: noPhp }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-audit2-spend-')).replace(/\\/g, '/');
  try {
    const out = execFileSync(PHP, ['-r', `
require 'server/lib/http.php'; require 'server/lib/auth.php'; require 'server/lib/outbound.php';
require 'server/lib/appstore.php'; require 'server/lib/updater.php';
$web = '${dir}/web'; $data = '${dir}/data'; @mkdir("$web/apps/tetris", 0755, true); @mkdir($data, 0700, true);
file_put_contents("$web/apps/tetris/index.html", 'x');
$calls = 0;
$refuse = static function () use (&$calls): void { $calls++; throw new RuntimeException('used', 403); };
try { appstore_delete('tetris', $data, $web, $refuse); } catch (RuntimeException $e) { echo 'code:', $e->getCode(), ' '; }
echo is_file("$web/apps/tetris/index.html") ? 'kept ' : 'gone ';
$count = static function () use (&$calls): void { $calls++; };
appstore_delete('tetris', $data, $web, $count);
echo is_dir("$web/apps/tetris") ? 'still ' : 'deleted ';
@mkdir('${dir}/priv', 0700, true);
echo update_rollback('${dir}/priv', $count) === null ? 'noback ' : 'back ';
echo 'calls:', $calls;`], { encoding: 'utf8', cwd: join(import.meta.dirname, '..') });
    assert.equal(out.trim(), 'code:403 kept deleted noback calls:2', 'a refused spend leaves the app; Go back with nothing kept never spends');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('L11: a wrong or missing code is still refused before anything (store app, model)', { skip: noPhp }, async () => {
  for (const code of ['', 'not-a-code']) {
    assert.equal((await call('apps.php?op=delete', { id: 'nosuchapp', password: PASS, code })).status, 403);
    assert.equal((await call('models.php?op=remove', { id: MODEL, password: PASS, code })).status, 403);
  }
});
