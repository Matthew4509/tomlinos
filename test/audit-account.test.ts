// Audit of accounts (server/api/auth.php, server/lib/auth.php, server/lib/captcha.php) against the real PHP server on a
// throw-away data folder. Each finding is a test that fails now and passes once fixed; tests marked todo are P1 findings.
// The last tests are checks that already hold (sessions ended by a password change, the server-held lock).
// Needs PHP: set PHP_BIN to its path, or have "php" on the PATH.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { base32Decode } from '../src/core/totp.ts';
import { PHP, hasPhp, portFree } from './php-bin.ts';

const PORT = 3146;
const BASE = `http://127.0.0.1:${PORT}`;
const data = mkdtempSync(join(tmpdir(), 'desktop-audit-account-'));
const noPhp = !hasPhp;
let php: ChildProcess | null = null;

class Client {
  cookie = '';
  async call(op: string, body?: unknown, solve = true): Promise<{ status: number; json: any }> {
    const res = await fetch(`${BASE}/api/auth.php?op=${op}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-Desktop-Store': '1', 'Content-Type': 'application/json', ...(this.cookie ? { Cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) {
      const [pair] = set.split(';');
      this.cookie = /=deleted$|=$/.test(pair) || /expires=Thu, 01 Jan 1970/i.test(set) || /Max-Age=0/i.test(set) ? '' : pair;
    }
    if (op === 'login' && res.status === 428 && solve) {
      const c = await this.call('captcha');
      return this.call(op, { ...(body as object), captchaId: c.json.id, captcha: c.json.answer }, false);
    }
    return { status: res.status, json: await res.json().catch(() => null) };
  }
  async store(): Promise<number> {
    const res = await fetch(`${BASE}/api/store.php?key=%2F`, { headers: { 'X-Desktop-Store': '1', ...(this.cookie ? { Cookie: this.cookie } : {}) } });
    await res.arrayBuffer();
    return res.status;
  }
}

function codeAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', Buffer.from(base32Decode(secret))).update(counter).digest();
  return String((mac.readUInt32BE(mac[19] & 15) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
let usedStep = 0;
async function nextCode(secret: string): Promise<string> {
  for (;;) {
    const now = Math.floor(Date.now() / 30000);
    for (const s of [now - 1, now, now + 1]) {
      if (s > usedStep) {
        usedStep = s;
        return codeAt(secret, s);
      }
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}
/** Stands in for the brakes' hold running out, so each test starts with none. */
const clearBrakes = () => rmSync(join(data, 'accounts', 'throttle.json'), { force: true });

const owner = new Client();
const PASS = 'lantern-orchard-harbour-47';
let secret = '';
let recovery: string[] = [];
let bobId = '';

before(async () => {
  if (noPhp) return;
  await portFree(PORT);
  php = spawn(PHP, ['-S', `127.0.0.1:${PORT}`, '-t', 'public', 'server/dev-router.php'], {
    env: { ...process.env, DESKTOP_DATA_DIR: data, DESKTOP_TEST_CAPTCHA: '1', DESKTOP_MAIL_LOG: join(data, 'mail.log') },
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
  const s = await owner.call('setup', { name: 'sampleowner', display: 'Sample Owner', password: PASS });
  assert.equal(s.status, 200, JSON.stringify(s.json));
  const bob = await owner.call('user-create', { name: 'bob', display: 'Bob', next: 'bobs-good-pass-99', password: PASS });
  assert.equal(bob.status, 200, JSON.stringify(bob.json));
  bobId = bob.json.user.id;
});

after(() => {
  php?.kill();
  rmSync(data, { recursive: true, force: true });
});

// ---- P0 ------------------------------------------------------------------------------------------------------------

// Held for a decision: this asks for the opposite of test/auth.test.ts, which wants a switched-off person told so (403),
// while test/retest-security.test.ts wants a right and a wrong password answered alike. No one answer meets all three.
test('ACC-P0-1 (edge, held for a decision): a switched-off account answers a wrong password like an unknown name (no account enumeration)',
  { skip: noPhp, todo: 'held: conflicts with the 403 "switched off" message auth.test.ts asks for' }, async () => {
    const off = await owner.call('user-disable', { id: bobId, disabled: true, password: PASS });
    assert.equal(off.status, 200, JSON.stringify(off.json));
    clearBrakes();
    const c = new Client();
    const offWrong = await c.call('login', { name: 'bob', password: 'a-wrong-guess-123' });
    const unknown = await c.call('login', { name: 'nobody-here', password: 'a-wrong-guess-123' });
    const offRecover = await c.call('recover-start', { name: 'bob', rkAuth: '0'.repeat(64) });
    const unknownRecover = await c.call('recover-start', { name: 'nobody-here', rkAuth: '0'.repeat(64) });
    clearBrakes();
    await owner.call('user-disable', { id: bobId, disabled: false, password: PASS });
    assert.deepEqual([offWrong.status, offWrong.json?.error], [unknown.status, unknown.json?.error],
      'login: a wrong password for a switched-off account tells that the account exists');
    assert.deepEqual([offRecover.status, offRecover.json?.error], [unknownRecover.status, unknownRecover.json?.error],
      'Forgot your password?: a wrong key for a switched-off account tells that the account exists');
  });

// ---- P1 ------------------------------------------------------------------------------------------------------------

test('ACC-P1-5: a password that is the user name is refused, also when the name ends in digits',
  { skip: noPhp, todo: 'P1' }, async () => {
    const r = await owner.call('user-create', { name: 'sampleuser1', display: 'S', next: 'sampleuser1', password: PASS });
    assert.equal(r.status, 400, 'the password "sampleuser1" for the user "sampleuser1" was taken: ' + JSON.stringify(r.json));
  });

test('setup for the two-step findings: two-step on for the owner', { skip: noPhp }, async () => {
  clearBrakes();
  const begin = await owner.call('totp-begin', { password: PASS });
  assert.equal(begin.status, 200);
  secret = begin.json.secret;
  const on = await owner.call('totp-enable', { code: await nextCode(secret) });
  assert.equal(on.status, 200, JSON.stringify(on.json));
  recovery = on.json.recovery;
});

test('ACC-P1-1: Change password refused for a weak new password does not use up the recovery code typed with it',
  { skip: noPhp, todo: 'P1' }, async () => {
    clearBrakes();
    const before = (await owner.call('status')).json.user.recoveryLeft;
    const r = await owner.call('password', { password: PASS, code: recovery[0], next: 'short' });
    assert.equal(r.status, 400);
    const left = (await owner.call('status')).json.user.recoveryLeft;
    assert.equal(left, before, 'nothing was changed, but a recovery code is gone');
  });

test('ACC-P1-3: "Forgot your password?" refused for a weak new password can be tried again with the same recovery code',
  { skip: noPhp, todo: 'P1' }, async () => {
    clearBrakes();
    const rkAuth = 'ab'.repeat(32);
    const made = await owner.call('recovery-key', { password: PASS, code: recovery[1], rkAuth });
    assert.equal(made.status, 200, JSON.stringify(made.json));
    const c = new Client();
    assert.equal((await c.call('recover-start', { name: 'sampleowner', rkAuth, code: recovery[2] })).status, 200);
    assert.equal((await c.call('recover-finish', { password: 'short' })).status, 400);
    const again = await c.call('recover-start', { name: 'sampleowner', rkAuth, code: recovery[2] });
    await c.call('logout', {});
    assert.equal(again.status, 200, 'the second try, with only the new password fixed, got: ' + again.json?.error);
  });

test('ACC-P1-4: a right password waiting for its two-step code is written in the sign-in history',
  { skip: noPhp, todo: 'P1' }, async () => {
    clearBrakes();
    const before = (await owner.call('history')).json.history.length;
    const thief = new Client();
    const l = await thief.call('login', { name: 'sampleowner', password: PASS });
    assert.equal(l.json?.stage, '2fa');
    // The thief simply closes the tab (no Back to sign in, which would write "Signed out").
    const after = (await owner.call('history')).json.history;
    assert.ok(after.length > before, 'someone with the password got as far as the code and left no line: ' + JSON.stringify(after[0]));
  });

test('ACC-P1-6: the picture check cannot be read off the SVG text by matching the fixed digit paths',
  { skip: noPhp, todo: 'P1' }, async () => {
    const src = readFileSync('server/lib/captcha.php', 'utf8');
    const glyphs = Object.fromEntries([...src.matchAll(/'(\d)' => '([^']+)'/g)].map(m => [m[2], m[1]]));
    const c = await new Client().call('captcha');
    const read = [...String(c.json.svg).matchAll(/<path d="([^"]+)"/g)].map(m => glyphs[m[1]]).filter(Boolean).join('');
    assert.notEqual(read, c.json.answer, 'a program read the answer from the picture without looking at it');
  });

test('ACC-P1-7: the owner can remove a person (and so free a place under max_users and the user name)',
  { skip: noPhp, todo: 'P1' }, async () => {
    clearBrakes();
    const r = await owner.call('user-delete', { id: bobId, password: PASS, code: recovery[3] });
    assert.notEqual(r.status, 404, 'there is no way to remove a person: ' + r.json?.error);
  });

test('ACC-P1-8: signing out one device, and signing out, end the session file under the accounts lock',
  { skip: noPhp, todo: 'P1' }, () => {
    // auth_sessions_end_all explains why: a "last seen" refresh part-way (read, then write back) would otherwise write a
    // just-ended session back. The single-device revoke and logout unlink without that lock.
    const api = readFileSync('server/api/auth.php', 'utf8');
    const revoke = api.slice(api.indexOf("case 'revoke'"), api.indexOf("case 'history'"));
    const logout = api.slice(api.indexOf("case 'logout'"), api.indexOf("case 'lock'"));
    assert.match(revoke.slice(revoke.indexOf('} else {')), /auth_locked|auth_session_update/, 'revoke of one device unlinks outside the lock');
    assert.match(logout, /auth_locked|auth_session_update/, 'logout unlinks outside the lock');
  });

// ---- Checks that hold now --------------------------------------------------------------------------------------------

test('holds: a password change ends the other signed-in devices and keeps this one', { skip: noPhp }, async () => {
  clearBrakes();
  const other = new Client();
  await other.call('login', { name: 'bob', password: 'bobs-good-pass-99' });
  const pending = new Client();
  await pending.call('login', { name: 'bob', password: 'bobs-good-pass-99' });
  const bob = new Client();
  assert.equal((await bob.call('login', { name: 'bob', password: 'bobs-good-pass-99' })).json.signedIn, true);
  const ch = await bob.call('password', { password: 'bobs-good-pass-99', next: 'bobs-second-pass-77' });
  assert.equal(ch.status, 200, JSON.stringify(ch.json));
  assert.equal(await other.store(), 401);
  assert.equal((await other.call('status')).json.signedIn, false);
  assert.notEqual(await bob.store(), 401, 'this device stays signed in');
});

test('holds: a locked session gets no files; re-locking keeps the count, and five wrong PINs sign it out', { skip: noPhp }, async () => {
  clearBrakes();
  const bob = new Client();
  await bob.call('login', { name: 'bob', password: 'bobs-second-pass-77' });
  assert.equal((await bob.call('pin', { password: 'bobs-second-pass-77', pin: '4821' })).status, 200);
  assert.equal((await bob.call('lock', {})).json.locked, true);
  assert.equal(await bob.store(), 423);
  for (let i = 0; i < 4; i++) assert.equal((await bob.call('unlock', { pin: String(1000 + i) })).status, 403);
  assert.equal((await bob.call('lock', {})).status, 200, 'locking again');
  assert.equal((await bob.call('unlock', { pin: '1111' })).status, 401, 'the fifth wrong PIN (after a re-lock) signs out');
  assert.equal((await bob.call('status')).json.signedIn, false);
});
