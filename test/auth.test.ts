// Accounts against the real PHP server (server/api/auth.php and store.php) on a throw-away data folder: first-run owner,
// sign-in and its brakes, two-step codes (computed here with node:crypto, independently of the server and of
// src/core/totp.ts), recovery codes, the server-held lock and PIN, each person's own files, the quota, sessions.
// Needs PHP: set PHP_BIN to its path, or have "php" on the PATH.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { request } from 'node:http';
import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { base32Decode, base32Encode, parseOtpauth, totpAt } from '../src/core/totp.ts';
import { PHP } from './php-bin.ts';

const PORT = 3098;
const BASE = `http://127.0.0.1:${PORT}`;
const data = mkdtempSync(join(tmpdir(), 'desktop-auth-'));
const modelsDir = mkdtempSync(join(tmpdir(), 'desktop-auth-models-'));
let php: ChildProcess;

/** A browser stand-in: keeps the session cookie between requests, like a tab does. */
class Client {
  cookie = '';
  lastSetCookie = '';
  async call(op: string, body?: unknown, solve = true): Promise<{ status: number; json: any }> {
    const res = await fetch(`${BASE}/api/auth.php?op=${op}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-Desktop-Store': '1', 'Content-Type': 'application/json', ...(this.cookie ? { Cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.take(res);
    // The picture check after wrong tries: the test server gives the answer (DESKTOP_TEST_CAPTCHA), so tests that are
    // not about it carry on as a person who types it would.
    if (op === 'login' && res.status === 428 && solve) {
      const c = await this.call('captcha');
      return this.call(op, { ...(body as object), captchaId: c.json.id, captcha: c.json.answer }, false);
    }
    return { status: res.status, json: await res.json().catch(() => null) };
  }
  take(res: Response): void {
    const set = res.headers.get('set-cookie');
    if (!set) return;
    this.lastSetCookie = set;
    const [pair] = set.split(';');
    this.cookie = /=deleted$|=$/.test(pair) || /expires=Thu, 01 Jan 1970/i.test(set) || /Max-Age=0/i.test(set) ? '' : pair;
  }
  async store(key: string): Promise<number> {
    const res = await fetch(`${BASE}/api/store.php?key=${encodeURIComponent(key)}`, { headers: { 'X-Desktop-Store': '1', ...(this.cookie ? { Cookie: this.cookie } : {}) } });
    await res.arrayBuffer();
    return res.status;
  }
  async put(key: string, bytes: number): Promise<{ status: number; json: any }> {
    const k = new TextEncoder().encode(key);
    const head = new Uint8Array(1 + 2 + k.length + 1 + 1 + 4);
    const v = new DataView(head.buffer);
    v.setUint8(0, 1);
    v.setUint16(1, k.length, true);
    head.set(k, 3);
    v.setUint8(3 + k.length, 1);
    head[4 + k.length] = '*'.charCodeAt(0);
    v.setUint32(5 + k.length, bytes, true);
    const body = new Uint8Array(head.length + bytes);
    body.set(head);
    const res = await fetch(`${BASE}/api/store.php?op=commit`, { method: 'POST', headers: { 'X-Desktop-Store': '1', 'Content-Type': 'application/octet-stream', ...(this.cookie ? { Cookie: this.cookie } : {}) }, body });
    return { status: res.status, json: await res.json().catch(() => null) };
  }
}

/** RFC 6238 with node:crypto: the check does not trust the code under test. */
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
/** The next code the server will take: a step after the last one used, within its one-step-either-side window. */
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
const OWNER_PASS = 'lantern-orchard-47';
/** The owner's password after the password-change test. */
const OWNER_PASS_2 = 'river-stone-lantern-8';
let ownerSecret = '';
let recovery: string[] = [];

before(async () => {
  // Files from before accounts existed: the owner should take them over, not lose them.
  mkdirSync(join(data, 'objects', 'ro'), { recursive: true });
  writeFileSync(join(data, 'objects', 'ro', 'root'), '0'.repeat(32) + '[]');
  php = spawn(PHP, ['-S', `127.0.0.1:${PORT}`, '-t', 'public', 'server/dev-router.php'], {
    env: { ...process.env, DESKTOP_DATA_DIR: data, DESKTOP_MODELS_DIR: modelsDir, DESKTOP_QUOTA_MB: '1', DESKTOP_TEST_CAPTCHA: '1', DESKTOP_MAIL_LOG: join(data, 'mail.log') },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${BASE}/storage.json`);
      return;
    } catch {
      await new Promise(r => setTimeout(r, 100));
    }
  }
  throw new Error('PHP test server did not start');
});

after(() => {
  php.kill();
  rmSync(data, { recursive: true, force: true });
  rmSync(modelsDir, { recursive: true, force: true });
});

test('the browser-side codes match the RFC 6238 test values', async () => {
  const key = new TextEncoder().encode('12345678901234567890');
  assert.equal(await totpAt(key, Math.floor(59 / 30), 8), '94287082');
  assert.equal(await totpAt(key, Math.floor(1111111109 / 30), 8), '07081804');
  assert.equal(await totpAt(key, Math.floor(20000000000 / 30), 8), '65353130');
  assert.equal(base32Encode(key), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.deepEqual(parseOtpauth('otpauth://totp/TomlinOS:alex?secret=ABC&issuer=TomlinOS'), { secret: 'ABC', issuer: 'TomlinOS', account: 'alex' });
});

test('the server-side codes match the RFC 6238 test values', () => {
  const r = spawnSync(PHP, ['-r', `require 'server/lib/http.php'; require 'server/lib/auth.php'; echo auth_totp('12345678901234567890', intdiv(59, 30), 8), ' ', auth_totp('12345678901234567890', intdiv(1111111109, 30), 8), ' ', auth_base32_encode('12345678901234567890');`], { encoding: 'utf8' });
  assert.equal(r.stdout.trim(), '94287082 07081804 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', r.stderr);
});

test('before anyone is set up, the store refuses and status asks for the owner', async () => {
  const c = new Client();
  assert.deepEqual((await c.call('status')).json, { setup: true, setupCode: false, signedIn: false });
  assert.equal(await c.store('/'), 401);
});

test('setting up the owner: weak passwords are refused with a way out; a good one signs in and adopts the old files', async () => {
  const short = await owner.call('setup', { name: 'Alex', display: 'Alex', password: 'short' });
  assert.equal(short.status, 400);
  assert.match(short.json.error, /at least 8/);
  const common = await owner.call('setup', { name: 'alex', password: 'password123' });
  assert.equal(common.status, 400);
  assert.match(common.json.error, /Suggest one/);
  const sameAsName = await owner.call('setup', { name: 'alex', password: 'alex2024' });
  assert.equal(sameAsName.status, 400);
  // A name inside a longer password is fine; only the name itself (with digits after it) is refused.
  const ok = await owner.call('setup', { name: 'Alex', display: 'Alex T', password: OWNER_PASS });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.user.name, 'alex');
  assert.equal(ok.json.user.display, 'Alex T');
  assert.equal(ok.json.user.admin, true);
  assert.equal(ok.json.adopted, true);
  assert.match(owner.lastSetCookie, /HttpOnly/i);
  assert.match(owner.lastSetCookie, /SameSite=Strict/i);
  assert.equal(await owner.store('/'), 200, 'the files from before accounts are now the owner’s');
  assert.ok(existsSync(join(data, 'users', ok.json.user.id, 'objects', 'ro', 'root')));
  assert.ok(!existsSync(join(data, 'objects')));
  const again = await new Client().call('setup', { name: 'someone', password: 'another-good-one-9' });
  assert.equal(again.status, 409);
  // Nothing secret is in what the page is told, or in the accounts file in the clear.
  const users = readFileSync(join(data, 'accounts', 'users.json'), 'utf8');
  assert.ok(!users.includes(OWNER_PASS));
  assert.ok(!JSON.stringify(ok.json).includes('hash'));
});

test('a wrong name and a wrong password get the same answer; five wrong tries put on the brakes', async () => {
  const c = new Client();
  const noName = await c.call('login', { name: 'nobody', password: OWNER_PASS });
  const badPass = await c.call('login', { name: 'alex', password: 'not-the-password' });
  assert.equal(noName.status, 401);
  assert.equal(badPass.status, 401);
  assert.equal(noName.json.error, badPass.json.error);
  for (let i = 0; i < 4; i++) await c.call('login', { name: 'alex', password: 'still-wrong-' + i });
  const braked = await c.call('login', { name: 'alex', password: OWNER_PASS });
  assert.equal(braked.status, 429, 'even the right password waits once the brakes are on');
  assert.match(braked.json.error, /Wait/);
  // The brakes are lifted here by clearing the throttle file, standing in for the minute passing.
  rmSync(join(data, 'accounts', 'throttle.json'));
  const good = await c.call('login', { name: 'ALEX', password: OWNER_PASS });
  assert.equal(good.status, 200);
  assert.equal(good.json.signedIn, true);
});

test('two-step sign-in: set up with a real code, then needed at sign-in; codes cannot be reused; recovery codes work once', async () => {
  const noPass = await owner.call('totp-begin', { password: 'wrong' });
  assert.equal(noPass.status, 403);
  const begin = await owner.call('totp-begin', { password: OWNER_PASS });
  assert.equal(begin.status, 200);
  ownerSecret = begin.json.secret;
  assert.equal(parseOtpauth(begin.json.uri)?.secret, ownerSecret);
  assert.equal((await owner.call('totp-enable', { code: '000000' })).status, 403);
  const enable = await owner.call('totp-enable', { code: await nextCode(ownerSecret) });
  assert.equal(enable.status, 200, JSON.stringify(enable.json));
  recovery = enable.json.recovery;
  assert.equal(recovery.length, 10);
  assert.equal(enable.json.user.totp, true);

  const c = new Client();
  const first = await c.call('login', { name: 'alex', password: OWNER_PASS });
  assert.deepEqual(first.json, { signedIn: false, stage: '2fa' });
  assert.equal(await c.store('/'), 401, 'no files between the password and the code');
  const wrong = await c.call('code', { code: '123456' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.json.triesLeft, 4);
  // The code used to turn it on was spent; the next step's code is new.
  const reused = code(ownerSecret, usedStep - Math.floor(Date.now() / 30000));
  const right = await c.call('code', { code: await nextCode(ownerSecret) });
  assert.equal(right.status, 200, JSON.stringify(right.json));
  assert.equal(await c.store('/'), 200);

  const d = new Client();
  await d.call('login', { name: 'alex', password: OWNER_PASS });
  assert.equal((await d.call('code', { code: reused })).status, 401, 'a code already used is refused');
  const rec = await d.call('code', { code: recovery[0] });
  assert.equal(rec.status, 200, JSON.stringify(rec.json));
  assert.equal(rec.json.user.recoveryLeft, 9);
  const e = new Client();
  await e.call('login', { name: 'alex', password: OWNER_PASS });
  assert.equal((await e.call('code', { code: recovery[0] })).status, 401, 'a recovery code works once');
});

test('five wrong codes stop the sign-in', async () => {
  const c = new Client();
  await c.call('login', { name: 'alex', password: OWNER_PASS });
  let last;
  for (let i = 0; i < 5; i++) last = await c.call('code', { code: '11111' + i });
  assert.equal(last!.status, 401);
  assert.equal(last!.json.auth, 'signin');
  assert.equal((await c.call('status')).json.stage, undefined);
  // Wrong codes also count on the name's brake, so a known password cannot be used to keep guessing codes.
  const again = new Client();
  assert.equal((await again.call('login', { name: 'alex', password: OWNER_PASS })).status, 429, 'the name is braked after 5 wrong codes');
  // The brake is lifted by clearing the throttle file, standing in for the minute passing.
  rmSync(join(data, 'accounts', 'throttle.json'));
});

test('the lock is held by the server: a locked session gets no files; the PIN opens it; five wrong PINs sign out', async () => {
  assert.equal((await owner.call('pin', { password: OWNER_PASS, pin: '4821' })).status, 403, 'two-step is on, so the code is needed too');
  const set = await owner.call('pin', { password: OWNER_PASS, code: await nextCode(ownerSecret), pin: '4821' });
  assert.equal(set.status, 200, JSON.stringify(set.json));
  assert.equal(set.json.user.pin, true);
  assert.equal((await owner.call('pin', { password: OWNER_PASS, pin: '12a4' })).status, 403);

  assert.equal((await owner.call('lock', {})).json.locked, true);
  assert.equal(await owner.store('/'), 423);
  assert.equal((await owner.call('status')).json.locked, true, 'a reload still finds it locked');
  const wrong = await owner.call('unlock', { pin: '0000' });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.json.triesLeft, 4);
  assert.equal((await owner.call('unlock', { pin: '4821' })).json.locked, false);
  assert.equal(await owner.store('/'), 200);

  // Another device of the owner's: five wrong PINs and it is signed out.
  const c = new Client();
  await c.call('login', { name: 'alex', password: OWNER_PASS });
  await c.call('code', { code: recovery[1] });
  await c.call('lock', {});
  let last;
  for (let i = 0; i < 5; i++) last = await c.call('unlock', { pin: '000' + i });
  assert.equal(last!.status, 401);
  assert.equal(last!.json.signedOut, true);
  assert.equal(await c.store('/'), 401);
  assert.equal(await owner.store('/'), 200, 'the owner’s other session is untouched');

  // Locking again while locked must not give the guesser a fresh five tries.
  const g = new Client();
  await g.call('login', { name: 'alex', password: OWNER_PASS });
  await g.call('code', { code: recovery[4] });
  await g.call('lock', {});
  for (let i = 0; i < 4; i++) await g.call('unlock', { pin: '100' + i });
  const relock = await g.call('lock', {});
  assert.equal(relock.json.locked, true);
  const fifth = await g.call('unlock', { pin: '1009' });
  assert.equal(fifth.status, 401, 're-locking kept the count, so the fifth wrong PIN signs out');
  assert.equal(fifth.json.signedOut, true);
});

test('the owner adds a person; each person sees only their own files; only the owner manages people', async () => {
  assert.equal((await owner.call('user-create', { name: 'jo', display: 'Jo', next: 'harbour-kettle-19' })).status, 403, 'not without the owner\'s own password');
  assert.equal((await owner.call('user-create', { name: 'jo', display: 'Jo', next: 'harbour-kettle-19', password: 'not-the-owners' })).status, 403);
  const made = await owner.call('user-create', { name: 'jo', display: 'Jo', next: 'harbour-kettle-19', password: OWNER_PASS, code: await nextCode(ownerSecret) });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  assert.equal(made.json.user.display, 'Jo');
  assert.equal((await owner.call('user-create', { name: 'JO', next: 'harbour-kettle-19', password: OWNER_PASS, code: await nextCode(ownerSecret) })).status, 409);
  const jo = new Client();
  assert.equal((await jo.call('login', { name: 'jo', password: 'harbour-kettle-19' })).status, 200);
  assert.equal(await jo.store('/'), 404, 'Jo starts with an empty store, not the owner’s files');
  assert.equal((await jo.put('/', 10)).status, 200);
  assert.equal(await jo.store('/'), 200);
  assert.equal((await jo.call('users')).status, 403);
  assert.equal((await jo.call('user-create', { name: 'x2', next: 'harbour-kettle-19', password: 'harbour-kettle-19' })).status, 403);

  // The owner switches Jo off (with the owner's own password): Jo is signed out at once.
  assert.equal((await owner.call('user-disable', { id: made.json.user.id, disabled: true })).status, 403, 'not without the owner\'s own password');
  assert.equal(await jo.store('/'), 200, 'still signed in');
  assert.equal((await owner.call('user-disable', { id: made.json.user.id, disabled: true, password: OWNER_PASS, code: await nextCode(ownerSecret) })).status, 200);
  assert.equal(await jo.store('/'), 401);
  assert.equal((await jo.call('login', { name: 'jo', password: 'harbour-kettle-19' })).status, 403);
  assert.equal((await owner.call('user-disable', { id: made.json.user.id, disabled: false, password: OWNER_PASS, code: await nextCode(ownerSecret) })).status, 200);
  // The owner sets Jo a new password (Jo forgot it).
  assert.equal((await owner.call('user-password', { id: made.json.user.id, next: 'new-harbour-kettle-20' })).status, 403, 'not without the owner\'s own password');
  assert.equal((await owner.call('user-password', { id: made.json.user.id, next: 'new-harbour-kettle-20', password: OWNER_PASS, code: await nextCode(ownerSecret) })).status, 200);
  assert.equal((await jo.call('login', { name: 'jo', password: 'new-harbour-kettle-20' })).status, 200);
  assert.equal((await owner.call('users')).json.users.length, 2);
});

test('the quota refuses a save that would go over, and says what to do', async () => {
  const jo = new Client();
  await jo.call('login', { name: 'jo', password: 'new-harbour-kettle-20' });
  const big = await jo.put('/', 2 * 1024 * 1024);
  assert.equal(big.status, 507);
  assert.match(big.json.error, /storage is full.*Recycle Bin/);
  assert.equal((await jo.put('/', 100)).status, 200, 'a small save still fits');
});

test('sessions: listed, one or all others signed out; a new password signs out the other devices', async () => {
  const other = new Client();
  await other.call('login', { name: 'alex', password: OWNER_PASS });
  await other.call('code', { code: recovery[2] });
  const list = await owner.call('sessions');
  assert.ok(list.json.sessions.length >= 2);
  assert.equal(list.json.sessions.filter((s: any) => s.current).length, 1);
  const theirs = list.json.sessions.find((s: any) => !s.current);
  assert.equal((await owner.call('revoke', { id: theirs.id })).json.ended, 1);

  const third = new Client();
  await third.call('login', { name: 'alex', password: OWNER_PASS });
  await third.call('code', { code: recovery[3] });
  const changed = await owner.call('password', { password: OWNER_PASS, code: await nextCode(ownerSecret), next: OWNER_PASS_2 });
  assert.equal(changed.status, 200, JSON.stringify(changed.json));
  assert.ok(changed.json.endedOthers >= 1);
  assert.equal(await third.store('/'), 401);
  assert.equal(await owner.store('/'), 200, 'the device that changed it stays signed in');
  const history = (await owner.call('history')).json.history.map((h: any) => h.event);
  assert.ok(history.some((e: string) => e.startsWith('Password changed')));
  assert.ok(history.includes('Wrong password'));
});

test('requests from another site, or without the desktop header, are refused', async () => {
  const noHeader = await fetch(`${BASE}/api/auth.php?op=status`);
  assert.equal(noHeader.status, 400);
  const otherSite = await fetch(`${BASE}/api/auth.php?op=status`, { headers: { 'X-Desktop-Store': '1', Origin: 'https://evil.example' } });
  assert.equal(otherSite.status, 403);
  const wrongMethod = await fetch(`${BASE}/api/auth.php?op=logout`, { headers: { 'X-Desktop-Store': '1' } });
  assert.equal(wrongMethod.status, 405);
});

test('saved AI model files: only for the signed-in desktop page, never to a stranger, a typed address or another site', async () => {
  const shard = join(modelsDir, 'm', 'resolve', 'main');
  mkdirSync(shard, { recursive: true });
  writeFileSync(join(shard, 'params_shard_0.bin'), Buffer.alloc(1000, 7));
  writeFileSync(join(modelsDir, 'models.json'), '{"models":[]}');
  writeFileSync(join(modelsDir, 'secret.php'), '<?php echo 1;');
  const get = async (path: string, who: Client | null, headers: Record<string, string> = {}) => {
    const res = await fetch(`${BASE}${path}`, { headers: { ...(who?.cookie ? { Cookie: who.cookie } : {}), ...headers } });
    return { status: res.status, bytes: (await res.arrayBuffer()).byteLength, headers: res.headers };
  };
  const file = '/models/m/resolve/main/params_shard_0.bin';

  const signedIn = await get(file, owner, { 'Sec-Fetch-Site': 'same-origin' });
  assert.equal(signedIn.status, 200);
  assert.equal(signedIn.bytes, 1000);
  assert.equal(signedIn.headers.get('cache-control'), 'no-store', 'nothing left in a browser cache after signing out');
  const part = await get(file, owner, { Range: 'bytes=900-' });
  assert.equal(part.status, 206, 'a broken download carries on');
  assert.equal(part.bytes, 100);
  assert.equal((await get('/models/models.json', owner)).status, 200);

  const stranger = await get(file, null);
  assert.equal(stranger.status, 401, 'nobody signed in');
  assert.equal(stranger.bytes > 200, false, 'no file bytes to a stranger');
  assert.equal((await get('/models/models.json', null)).status, 401);
  assert.equal((await get(file, owner, { 'Sec-Fetch-Site': 'none' })).status, 403, 'an address typed into a tab');
  assert.equal((await get(file, owner, { 'Sec-Fetch-Site': 'cross-site' })).status, 403, 'another site');
  assert.equal((await get(file, owner, { Origin: 'https://evil.example' })).status, 403, 'another site, by Origin');
  // Sent as typed: fetch() would tidy the dots away before they reached the server.
  const raw = (path: string) => new Promise<number>((resolve, reject) => {
    request({ host: '127.0.0.1', port: PORT, path, headers: { Cookie: owner.cookie } }, res => {
      res.resume();
      resolve(res.statusCode ?? 0);
    }).on('error', reject).end();
  });
  for (const path of ['/models/secret.php', '/models/.htaccess', '/models/../server/config.example.php', '/models/%2e%2e/server/config.example.php', '/models/m/..%2f..%2fREADME.md', '/models/m/resolve/main/../../../models.json', '/models/'])
    assert.equal(await raw(path), 404, path);
  const post = await fetch(`${BASE}${file}`, { method: 'POST', headers: { Cookie: owner.cookie } });
  assert.equal(post.status, 405);

  assert.equal((await owner.call('lock', {})).json.locked, true);
  assert.equal((await get(file, owner)).status, 423, 'the screen is locked');
  assert.equal((await owner.call('unlock', { pin: '4821' })).json.locked, false);
  assert.equal((await get(file, owner)).status, 200);
});

test('the front page: the Reader until the owner chooses the sign-in; only the owner may choose', async () => {
  const stranger = new Client();
  assert.equal((await stranger.call('status')).json.front, 'reader', 'a visitor gets the Reader by default');
  const person = new Client();
  const made = await owner.call('user-create', { name: 'frontcheck', next: 'lantern-kettle-meadow-44', password: OWNER_PASS_2, code: await nextCode(ownerSecret) });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  assert.equal((await person.call('login', { name: 'frontcheck', password: 'lantern-kettle-meadow-44' })).status, 200);
  assert.equal((await person.call('site-front', { front: 'signin' })).status, 403, 'not the owner');
  assert.equal((await owner.call('site-front', { front: 'nonsense' })).status, 400);
  assert.equal((await owner.call('site-front', { front: 'signin' })).status, 200);
  assert.equal((await stranger.call('status')).json.front, 'signin');
  assert.equal((await owner.call('site-front', { front: 'reader' })).status, 200);
  assert.equal((await stranger.call('status')).json.front, 'reader');
});

test('the book library answers signed-in people only: a visitor or a locked screen gets nothing', async () => {
  const books = (path: string, who: Client | null) => fetch(`${BASE}/api/books.php?path=${encodeURIComponent(path)}`, { headers: { 'X-Desktop-Store': '1', ...(who?.cookie ? { Cookie: who.cookie } : {}) } });
  assert.equal((await books('ping', null)).status, 401, 'nobody signed in');
  assert.equal((await books('index', null)).status, 401);
  assert.equal((await books('book/1661', null)).status, 401);
  assert.equal((await books('ping', owner)).status, 204);
  const list = await books('index', owner);
  assert.equal(list.status, 200);
  assert.ok(((await list.json()) as { books: unknown[] }).books.length > 50000, 'the whole list, for the owner');
  assert.equal((await books('book/../../x', owner)).status, 404, 'only numbered books');
  assert.equal((await owner.call('lock', {})).json.locked, true);
  assert.equal((await books('ping', owner)).status, 423, 'a locked screen shows no library');
  assert.equal((await owner.call('unlock', { pin: '4821' })).json.locked, false);
});

test('the brakes: the picture after a wrong try, a 1-hour hold after five, then the emailed unlock link (sent once, 3 tries)', async () => {
  const P = 'kettle-harbour-lantern-61';
  assert.equal((await owner.call('user-create', { name: 'lockme', next: P, password: OWNER_PASS_2, code: await nextCode(ownerSecret) })).status, 200);
  const me = new Client();
  assert.equal((await me.call('login', { name: 'lockme', password: P })).status, 200);
  assert.equal((await me.call('unlock-email', { password: P, email: 'bad address' })).status, 400);
  const set = await me.call('unlock-email', { password: P, email: 'lockme@example.com' });
  assert.equal(set.status, 200);
  assert.match(set.json.user.unlockEmail, /^l\*+@example\.com$/, 'only masked, even to its owner');
  assert.equal((await me.call('logout', {})).status, 200);

  const guesser = new Client();
  assert.equal((await guesser.call('login', { name: 'lockme', password: 'wrong-1' })).status, 401);
  const asked = await guesser.call('login', { name: 'lockme', password: 'wrong-2' }, false);
  assert.equal(asked.status, 428, 'after a wrong try, the picture is needed');
  assert.equal(asked.json.captcha, true);
  const pic = await guesser.call('captcha');
  assert.match(pic.json.svg, /^<svg[^>]*>.*<path/s);
  assert.ok(!/<text|<script|<image/i.test(pic.json.svg), 'strokes only: no text, script or pictures inside');
  assert.equal((await guesser.call('login', { name: 'lockme', password: 'wrong-2', captchaId: pic.json.id, captcha: '00000' }, false)).status, 428, 'a wrong answer');
  assert.equal((await guesser.call('login', { name: 'lockme', password: 'wrong-2', captchaId: pic.json.id, captcha: pic.json.answer }, false)).status, 428, 'a picture answers once');
  for (const n of [2, 3, 4, 5]) assert.equal((await guesser.call('login', { name: 'lockme', password: 'wrong-' + n })).status, 401);
  const held = await guesser.call('login', { name: 'lockme', password: P });
  assert.equal(held.status, 429, 'five wrong: held, even with the right password');
  assert.equal(held.json.held, true);
  assert.match(held.json.error, /1 hours|60 minutes/);

  const mailLog = join(data, 'mail.log');
  const mails = () => (existsSync(mailLog) ? readFileSync(mailLog, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
  const before = mails().length;
  const asks = await guesser.call('unlock-mail', { name: 'lockme' });
  assert.equal(asks.status, 200);
  assert.equal((await guesser.call('unlock-mail', { name: 'nobody-here' })).json.message, asks.json.message, 'the same answer for a name that does not exist');
  assert.equal(mails().length, before + 1);
  await guesser.call('unlock-mail', { name: 'lockme' });
  assert.equal(mails().length, before + 1, 'sent once, until the next sign-in');
  const sent = mails().at(-1);
  assert.equal(sent.to, 'lockme@example.com');
  const token = /#unlock=([A-Za-z0-9_-]{43})/.exec(sent.text)?.[1] ?? '';
  assert.ok(token, 'the email carries the link');

  const clicker = new Client();
  const opened = await clicker.call('unlock-link', { token });
  assert.deepEqual([opened.status, opened.json.name, opened.json.tries], [200, 'lockme', 3]);
  assert.equal((await clicker.call('login', { name: 'lockme', password: 'wrong-6', unlock: token }, false)).status, 401, 'a link try skips the hold, not the password');
  assert.equal((await clicker.call('unlock-link', { token })).json.tries, 2);
  const inAgain = await clicker.call('login', { name: 'lockme', password: P, unlock: token }, false);
  assert.equal(inAgain.status, 200, JSON.stringify(inAgain.json));
  assert.equal(inAgain.json.signedIn, true);
  assert.equal((await clicker.call('unlock-link', { token })).status, 400, 'a sign-in ends the link');
  assert.equal((await clicker.call('unlock-link', { token: 'x'.repeat(43) })).status, 400);

  const out = spawnSync(PHP, ['server/tools/clear-brakes.php', 'lockme'], { env: { ...process.env, DESKTOP_DATA_DIR: data }, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /lifted/);
  assert.equal((await guesser.call('login', { name: 'lockme', password: P })).status, 200, 'the tool lifts the hold (the picture may still be asked: this address made wrong tries)');
});

test('the hold schedule: 1 hour after five wrong tries, then three tries between holds, doubling to 64 hours', () => {
  const out = spawnSync(PHP, ['-r', `require 'server/lib/http.php'; require 'server/lib/auth.php'; echo json_encode(array_map('auth_brake_hold', range(1, 29)));`], { encoding: 'utf8' });
  const hold = JSON.parse(out.stdout).map((s: number) => s / 3600);
  assert.deepEqual(hold.slice(0, 4), [0, 0, 0, 0]);
  assert.deepEqual([hold[4], hold[5], hold[6], hold[7]], [1, 0, 0, 2], 'count 5: 1 hour; then 3 tries; count 8: 2 hours');
  assert.deepEqual([hold[10], hold[13], hold[16], hold[19], hold[22], hold[25], hold[28]], [4, 8, 16, 32, 64, 64, 64]);
});
