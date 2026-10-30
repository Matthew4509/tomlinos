// A second look at accounts and security (October 2026 retest), against the real PHP server on a throw-away data
// folder, plus two checks run by PHP directly. Each test was written to catch a fault read in the code; one that fails
// points at that fault. Needs PHP: set PHP_BIN to its path, or have "php" on the PATH.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { base32Decode } from '../src/core/totp.ts';
import { newFileKey, newRecoveryKey, recoveryParts, seal, wrapWithPassword, wrapWithRecovery } from '../src/auth/vault.ts';
import { PHP, hasPhp, portFree } from './php-bin.ts';
import { tempDir } from './tmp.ts';

const root = join(import.meta.dirname, '..');
const noPhp = !hasPhp && 'no PHP';

// ---- Run by PHP directly -----------------------------------------------------------------------------------------------

function phpScript(dir: string, code: string): string {
  const file = join(dir, `t-${Math.random().toString(16).slice(2)}.php`);
  writeFileSync(file, `<?php
require ${JSON.stringify(join(root, 'server/lib/http.php'))};
require ${JSON.stringify(join(root, 'server/lib/auth.php'))};
$d = ${JSON.stringify(dir)};
${code}`);
  return file;
}

test('IPv4 visitors seen through IPv6 ("::ffff:1.2.3.4") are braked one address at a time, not all together', { skip: noPhp }, () => {
  const dir = tempDir('tomlinos-brake-');
  const r = JSON.parse(execFileSync(PHP, [phpScript(dir, `
for ($i = 0; $i < 5; $i++) auth_throttle_take($d, '::ffff:203.0.113.9', 'alex');
echo json_encode(['distinct' => auth_throttle_ip('::ffff:1.2.3.4') !== auth_throttle_ip('::ffff:5.6.7.8'), 'owner_elsewhere' => auth_throttle_wait($d, '::ffff:198.51.100.7', 'alex')]);`)], { encoding: 'utf8', env: { ...process.env, DESKTOP_DATA_DIR: dir } }));
  assert.ok(r.distinct, 'two different IPv4 addresses must not share one brake bucket');
  assert.equal(r.owner_elsewhere, 0, 'five wrong tries from one address must not hold the owner out from another');
});

test('"sign out everywhere" ends a session even while that session is refreshing its "last seen" time', { skip: noPhp }, async () => {
  const dir = tempDir('tomlinos-endall-');
  const env = { ...process.env, DESKTOP_DATA_DIR: dir };
  const token = execFileSync(PHP, [phpScript(dir, `echo auth_session_create($d, 'u1', 'full');`)], { encoding: 'utf8', env }).trim();
  // Session 1 is in the middle of its update (read, then a slow step, then write back).
  const slow = new Promise<string>((resolve, reject) => execFile(PHP, [phpScript(dir, `
auth_session_update($d, ${JSON.stringify(token)}, function ($s) { sleep(2); return $s; });
echo 'done';`)], { encoding: 'utf8', env, timeout: 20000 }, (e, out, err) => (e ? reject(new Error(err || e.message)) : resolve(out))));
  await new Promise(r => setTimeout(r, 600));
  const ended = execFileSync(PHP, [phpScript(dir, `echo auth_sessions_end_all($d, 'u1');`)], { encoding: 'utf8', env }).trim();
  await slow;
  const still = execFileSync(PHP, [phpScript(dir, `echo json_encode(auth_session_load($d, ${JSON.stringify(token)}) !== null);`)], { encoding: 'utf8', env }).trim();
  assert.equal(still, 'false', `the session came back after "sign out everywhere" (ended ${ended} first)`);
});

// ---- Against the server ----------------------------------------------------------------------------------------------

// 3061: every other test's port (3092-3099, the mail stand-ins, the browser runner) is taken.
const PORT = 3061;
const BASE = `http://127.0.0.1:${PORT}`;
const data = mkdtempSync(join(tmpdir(), 'desktop-retest-auth-'));
let php: ChildProcess;

class Client {
  cookie = '';
  async call(op: string, body?: unknown, solve = true): Promise<{ status: number; json: any }> {
    const res = await fetch(`${BASE}/api/auth.php?op=${op}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-Desktop-Store': '1', 'Content-Type': 'application/json', ...(this.cookie ? { Cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.take(res);
    if (op === 'login' && res.status === 428 && solve) {
      const c = await this.call('captcha');
      return this.call(op, { ...(body as object), captchaId: c.json.id, captcha: c.json.answer }, false);
    }
    return { status: res.status, json: await res.json().catch(() => null) };
  }
  async api(file: string, op: string, body: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${BASE}/api/${file}?op=${op}`, {
      method: 'POST',
      headers: { 'X-Desktop-Store': '1', 'Content-Type': 'application/json', ...(this.cookie ? { Cookie: this.cookie } : {}) },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  }
  async store(key: string): Promise<number> {
    const res = await fetch(`${BASE}/api/store.php?key=${encodeURIComponent(key)}`, { headers: { 'X-Desktop-Store': '1', ...(this.cookie ? { Cookie: this.cookie } : {}) } });
    await res.arrayBuffer();
    return res.status;
  }
  async put(key: string, bytes: Uint8Array): Promise<number> {
    const k = new TextEncoder().encode(key);
    const head = new Uint8Array(1 + 2 + k.length + 1 + 1 + 4);
    const v = new DataView(head.buffer);
    v.setUint8(0, 1);
    v.setUint16(1, k.length, true);
    head.set(k, 3);
    v.setUint8(3 + k.length, 1);
    head[4 + k.length] = '*'.charCodeAt(0);
    v.setUint32(5 + k.length, bytes.length, true);
    const body = new Uint8Array(head.length + bytes.length);
    body.set(head);
    body.set(bytes, head.length);
    const res = await fetch(`${BASE}/api/store.php?op=commit`, { method: 'POST', headers: { 'X-Desktop-Store': '1', 'Content-Type': 'application/octet-stream', ...(this.cookie ? { Cookie: this.cookie } : {}) }, body });
    await res.arrayBuffer();
    return res.status;
  }
  take(res: Response): void {
    const set = res.headers.get('set-cookie');
    if (!set) return;
    const [pair] = set.split(';');
    this.cookie = /=deleted$|=$/.test(pair) || /Max-Age=0/i.test(set) ? '' : pair;
  }
  get token(): string {
    return this.cookie.split('=')[1] ?? '';
  }
}

/** RFC 6238 with node:crypto, independent of the server's code. */
function code(secret: string, offsetSteps = 0): string {
  const key = Buffer.from(base32Decode(secret));
  const step = Math.floor(Date.now() / 30000) + offsetSteps;
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', key).update(counter).digest();
  const at = mac[19] & 15;
  return String((mac.readUInt32BE(at) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
let usedStep = 0;
async function nextCode(secret: string): Promise<string> {
  for (;;) {
    const now = Math.floor(Date.now() / 30000);
    for (const s of [now - 1, now, now + 1]) {
      if (s > usedStep) {
        usedStep = s;
        return code(secret, s - now);
      }
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}

const owner = new Client();
const PASS = 'lantern-orchard-47';
const ROUNDS = 600000;

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
  const setup = await owner.call('setup', { name: 'alex', password: PASS });
  assert.equal(setup.status, 200, JSON.stringify(setup.json));
});

after(() => {
  php?.kill();
  rmSync(data, { recursive: true, force: true });
});

test('a switched-off account answers a right and a wrong password the same way (no password oracle)', { skip: noPhp }, async () => {
  const made = await owner.call('user-create', { name: 'bob', display: 'Bob', next: 'harbour-kettle-19', password: PASS });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  assert.equal((await owner.call('user-disable', { id: made.json.user.id, disabled: true, password: PASS })).status, 200);
  const wrong = await new Client().call('login', { name: 'bob', password: 'not-it-at-all' });
  const right = await new Client().call('login', { name: 'bob', password: 'harbour-kettle-19' });
  assert.equal(right.status, wrong.status, `right password: ${right.status} ${JSON.stringify(right.json)}; wrong: ${wrong.status}`);
});

test('a locked screen does not count the refused requests behind it as activity (idle sign-out still comes)', { skip: noPhp }, async () => {
  assert.equal((await owner.call('lock', {})).json.locked, true);
  try {
    const path = join(data, 'accounts', 'sessions', `${createHash('sha256').update(owner.token).digest('hex')}.json`);
    const before = JSON.parse(readFileSync(path, 'utf8'));
    before.seen = Math.floor(Date.now() / 1000) - 11 * 3600;
    writeFileSync(path, JSON.stringify(before));
    assert.equal(await owner.store('/'), 423, 'locked: refused');
    const after = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(after.seen, before.seen, 'a refused request must not refresh "last seen"');
  } finally {
    assert.equal((await owner.call('unlock', { password: PASS })).json.locked, false);
  }
});

test('owner-only actions outside the people list (deleting a store app; the same code shape guards System update) ask for the owner\'s password', { skip: noPhp }, async () => {
  // Adding a person or switching one off re-asks the owner's password "so someone at the owner's unlocked, unattended
  // desktop cannot do it" (server/api/auth.php). Deleting a store app, and installing or rolling back the site
  // (server/api/update.php, not called here because it writes beside server/lib), only check the role.
  const del = await owner.api('apps.php', 'delete', { id: 'nosuchapp' });
  assert.equal(del.status, 403, `delete without a password answered ${del.status}: ${JSON.stringify(del.json)}`);
  assert.match(String(del.json?.error ?? ''), /password/i);
});

test('encryption: "turn on" sent while it is being turned off keeps the new key material, or is refused', { skip: noPhp }, async () => {
  const fileKey = await newFileKey();
  const parts = await recoveryParts(newRecoveryKey());
  const on = await owner.call('vault', { state: 'migrating-on', ...(await wrapWithPassword(fileKey, PASS, ROUNDS)), wrapRk: await wrapWithRecovery(fileKey, parts.kek), rkAuth: parts.auth, password: PASS });
  assert.equal(on.status, 200, JSON.stringify(on.json));
  assert.equal(await owner.put('/', await seal(fileKey, '/', new TextEncoder().encode('[]'))), 200);
  assert.equal((await owner.call('vault', { state: 'on' })).json.vaultKeys.state, 'on');
  assert.equal((await owner.call('vault', { state: 'migrating-off', password: PASS })).json.vaultKeys.state, 'migrating-off');
  // A stale tab (still showing "off") sends "turn on" with a NEW key, wrapped for the password and a new recovery key.
  const key2 = await newFileKey();
  const parts2 = await recoveryParts(newRecoveryKey());
  const wraps2 = await wrapWithPassword(key2, PASS, ROUNDS);
  const again = await owner.call('vault', { state: 'migrating-on', ...wraps2, wrapRk: await wrapWithRecovery(key2, parts2.kek), rkAuth: parts2.auth, password: PASS });
  if (again.status === 200) {
    assert.equal(again.json.vaultKeys.wrapPw, wraps2.wrapPw, 'answered 200 but kept the OLD wrapped key: the page now seals files with a key the server never stored');
  } else {
    assert.equal(again.status, 409);
  }
  // Tidy: back to off so the rest of the tests see plain files.
  await owner.call('vault', { state: 'migrating-off', password: PASS });
  await owner.put('/', new TextEncoder().encode('[]'));
  await owner.call('vault', { state: 'off' });
});

let secret = '';
let recovery: string[] = [];

test('turning two-step sign-in on signs the other devices out', { skip: noPhp }, async () => {
  const other = new Client();
  assert.equal((await other.call('login', { name: 'alex', password: PASS })).status, 200);
  const begin = await owner.call('totp-begin', { password: PASS });
  assert.equal(begin.status, 200, JSON.stringify(begin.json));
  secret = begin.json.secret;
  const enable = await owner.call('totp-enable', { code: await nextCode(secret) });
  assert.equal(enable.status, 200, JSON.stringify(enable.json));
  recovery = enable.json.recovery;
  assert.equal((await other.call('status')).json.signedIn, false, 'the device that only knew the password is signed out');
});

test('someone who signed in with a recovery code (phone lost) can turn two-step off with another recovery code', { skip: noPhp }, async () => {
  const c = new Client();
  const login = await c.call('login', { name: 'alex', password: PASS });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  const signedIn = await c.call('code', { code: recovery[0] });
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.json));
  const off = await c.call('totp-disable', { password: PASS, code: recovery[1] });
  assert.equal(off.status, 200, `turning two-step off with a recovery code answered ${off.status}: ${JSON.stringify(off.json)}`);
});

test('someone at the owner\'s unlocked desktop cannot start saving an AI model, or remove one, without the password (a re-check, F31)', { skip: noPhp }, async () => {
  const id = 'Qwen3.5-0.8B-q4f32_1-MLC';
  for (const body of [{ id }, { id, password: 'not-the-password-at-all' }]) {
    assert.equal((await owner.api('models.php', 'piece', body)).status, 403, 'starting a save needs the password');
    assert.equal((await owner.api('models.php', 'remove', body)).status, 403, 'removing needs the password');
  }
  assert.equal((await owner.api('models.php', 'remove', { id: 'made-up', password: PASS })).status, 400, 'a made-up model is still only a bad request');
  assert.equal((await owner.api('models.php', 'remove', { id, password: PASS })).status, 200, 'with the password it goes ahead');
});
