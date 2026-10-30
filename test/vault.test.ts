// Recovery key, "Forgot your password?", and file encryption: the browser-side crypto (src/auth/vault.ts) on its own,
// then the server's side of it (server/api/auth.php, store.php) on a throw-away data folder.
// Needs PHP: set PHP_BIN to its path, or have "php" on the PATH.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isSealed, newFileKey, newRecoveryKey, recoveryParts, seal, unseal, unwrapWithPassword, unwrapWithRecovery, wrapWithPassword, wrapWithRecovery,
} from '../src/auth/vault.ts';
import { PHP, portFree } from './php-bin.ts';
import { FileSystem } from '../src/fs/fs.ts';
import { EncryptedStore } from '../src/store/encrypted-store.ts';
import { ServerStore } from '../src/store/server-store.ts';
import { StoreError } from '../src/store/store.ts';

const PORT = 3096;
const BASE = `http://127.0.0.1:${PORT}`;
const data = mkdtempSync(join(tmpdir(), 'desktop-vault-'));
let php: ChildProcess;
const ROUNDS = 100_000; // the lowest the server takes: keeps the test quick; the page uses 600,000

class Client {
  cookie = '';
  async call(op: string, body?: unknown, solve = true): Promise<{ status: number; json: any }> {
    const res = await fetch(`${BASE}/api/auth.php?op=${op}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-Desktop-Store': '1', 'Content-Type': 'application/json', ...(this.cookie ? { Cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = /expires=Thu, 01 Jan 1970|Max-Age=0/i.test(set) ? '' : set.split(';')[0];
    // The picture check after wrong tries: the test server gives the answer (DESKTOP_TEST_CAPTCHA), so tests that are
    // not about it carry on as a person who types it would.
    if (op === 'login' && res.status === 428 && solve) {
      const c = await this.call('captcha');
      return this.call(op, { ...(body as object), captchaId: c.json.id, captcha: c.json.answer }, false);
    }
    return { status: res.status, json: await res.json().catch(() => null) };
  }
  async keys(): Promise<{ status: number; json: any }> {
    const res = await fetch(`${BASE}/api/store.php?op=keys`, { headers: { 'X-Desktop-Store': '1', Cookie: this.cookie } });
    return { status: res.status, json: await res.json().catch(() => null) };
  }
  async put(key: string, bytes: Uint8Array): Promise<number> {
    const k = new TextEncoder().encode(key);
    const head = new Uint8Array(1 + 2 + k.length + 1 + 1 + 4);
    const v = new DataView(head.buffer);
    v.setUint8(0, 1);
    v.setUint16(1, k.length, true);
    head.set(k, 3);
    v.setUint8(3 + k.length, 1);
    head[4 + k.length] = 42;
    v.setUint32(5 + k.length, bytes.length, true);
    const body = new Uint8Array(head.length + bytes.length);
    body.set(head);
    body.set(bytes, head.length);
    const res = await fetch(`${BASE}/api/store.php?op=commit`, { method: 'POST', headers: { 'X-Desktop-Store': '1', Cookie: this.cookie }, body });
    await res.arrayBuffer();
    return res.status;
  }
}

before(async () => {
  await portFree(PORT);
  php = spawn(PHP, ['-S', `127.0.0.1:${PORT}`, '-t', 'public', 'server/dev-router.php'], { env: { ...process.env, DESKTOP_DATA_DIR: data, DESKTOP_TEST_CAPTCHA: '1' }, stdio: 'ignore' });
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
});

test('crypto: a sealed record opens only with its key and under its own name; the recovery key and password each open the file key', async () => {
  const fileKey = await newFileKey();
  const sealed = await seal(fileKey, '/', new TextEncoder().encode('Budget.xlsx and its secrets'));
  assert.ok(isSealed(sealed));
  assert.ok(!new TextDecoder().decode(sealed).includes('secrets'));
  assert.equal(new TextDecoder().decode(await unseal(fileKey, '/', sealed)), 'Budget.xlsx and its secrets');
  await assert.rejects(unseal(fileKey, '00000000-0000-4000-8000-000000000000', sealed), 'moved to another key: refused');
  const tampered = sealed.slice();
  tampered[tampered.length - 1] ^= 1;
  await assert.rejects(unseal(fileKey, '/', tampered), 'changed: refused');
  await assert.rejects(unseal(await newFileKey(), '/', sealed), 'another key: refused');
  // Records start with "\0MYIENC\x01"; ones sealed by earlier versions start with an older marker and still open.
  assert.equal(Buffer.from(sealed.subarray(0, 8)).toString('latin1'), '\0MYIENC\x01');
  const older = sealed.slice();
  older.set([0x00, 0x41, 0x4c, 0x4e, 0x45, 0x4e, 0x43, 0x01]);
  assert.ok(isSealed(older), 'an older record is still seen as sealed');
  assert.equal(new TextDecoder().decode(await unseal(fileKey, '/', older)), 'Budget.xlsx and its secrets');
  assert.ok(!isSealed(new TextEncoder().encode('\0XXXENC\x01' + 'x'.repeat(40))), 'any other start is plain');

  const wrap = await wrapWithPassword(fileKey, 'river-stone-lantern-8', ROUNDS);
  const again = await unwrapWithPassword(wrap, 'river-stone-lantern-8');
  assert.equal(new TextDecoder().decode(await unseal(again, '/', sealed)), 'Budget.xlsx and its secrets');
  await assert.rejects(unwrapWithPassword(wrap, 'wrong password'));

  const rk = newRecoveryKey();
  assert.match(rk, /^([A-Z2-7]{4}-){7}[A-Z2-7]{4}$/);
  const parts = await recoveryParts(rk);
  const typedLoosely = await recoveryParts(rk.toLowerCase().replace(/-/g, ' '));
  assert.equal(typedLoosely.auth, parts.auth, 'case, spaces and dashes do not matter');
  const byRecovery = await unwrapWithRecovery(await wrapWithRecovery(fileKey, parts.kek), typedLoosely.kek);
  assert.equal(new TextDecoder().decode(await unseal(byRecovery, '/', sealed)), 'Budget.xlsx and its secrets');
  await assert.rejects(recoveryParts('not-a-key'));
  assert.ok(!(await unwrapWithPassword(wrap, 'river-stone-lantern-8')).extractable, 'the daily key cannot be read out');
});

const owner = new Client();
const PASS = 'lantern-orchard-47';
let recovery = '';

test('the owner makes a recovery key; "Forgot your password?" with it sets a new password and signs in', async () => {
  assert.equal((await owner.call('setup', { name: 'alex', password: PASS })).status, 200);
  recovery = newRecoveryKey();
  const parts = await recoveryParts(recovery);
  assert.equal((await owner.call('recovery-key', { password: 'wrong', rkAuth: parts.auth })).status, 403);
  const made = await owner.call('recovery-key', { password: PASS, rkAuth: parts.auth });
  assert.equal(made.status, 200, JSON.stringify(made.json));
  assert.equal(made.json.user.recoveryKey, true);
  const users = spawnSync(PHP, ['-r', 'echo file_get_contents(getenv("F"));'], { env: { ...process.env, F: join(data, 'accounts', 'users.json') }, encoding: 'utf8' }).stdout;
  assert.ok(!users.includes(parts.auth), 'the server keeps only a keyed hash of the proof');

  const c = new Client();
  const wrong = await c.call('recover-start', { name: 'alex', rkAuth: (await recoveryParts(newRecoveryKey())).auth });
  const noName = await c.call('recover-start', { name: 'nobody', rkAuth: parts.auth });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.json.error, noName.json.error, 'same answer whichever part was wrong');
  assert.equal((await c.call('recover-finish', { password: 'new-meadow-lantern-5' })).status, 401, 'no finishing without starting');
  const started = await c.call('recover-start', { name: 'ALEX', rkAuth: parts.auth });
  assert.equal(started.status, 200, JSON.stringify(started.json));
  assert.equal(started.json.vaultKeys, null);
  assert.equal((await c.call('status')).json.signedIn, false, 'the reset stage is not signed in');
  assert.equal((await c.call('recover-finish', { password: 'short' })).status, 400);
  const done = await c.call('recover-finish', { password: 'new-meadow-lantern-5' });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal(done.json.signedIn, true);
  assert.equal((await owner.call('status')).json.signedIn, false, 'the other device was signed out');
  assert.equal((await new Client().call('login', { name: 'alex', password: PASS })).status, 401);
  assert.equal((await owner.call('login', { name: 'alex', password: 'new-meadow-lantern-5' })).status, 200);
});

let fileKey: CryptoKey;
let pw = 'new-meadow-lantern-5';

test('encryption: turning on needs the password and a new recovery key; states only move in order; keys are listed for converting', async () => {
  fileKey = await newFileKey();
  recovery = newRecoveryKey();
  const parts = await recoveryParts(recovery);
  const body = { state: 'migrating-on', ...(await wrapWithPassword(fileKey, pw, ROUNDS)), wrapRk: await wrapWithRecovery(fileKey, parts.kek), rkAuth: parts.auth };
  assert.equal((await owner.call('vault', { ...body, password: 'wrong' })).status, 403);
  assert.equal((await owner.call('vault', { ...body, password: pw, iter: 10 })).status, 400, 'too few rounds refused');
  assert.equal((await owner.call('vault', { state: 'on' })).status, 409, 'cannot jump to on');
  const on = await owner.call('vault', { ...body, password: pw });
  assert.equal(on.status, 200, JSON.stringify(on.json));
  assert.equal(on.json.vaultKeys.state, 'migrating-on');
  assert.equal(on.json.user.vault, 'migrating-on');
  // The browser writes sealed records, then says it is done.
  assert.equal(await owner.put('/', await seal(fileKey, '/', new TextEncoder().encode('[]'))), 200);
  const keys = await owner.keys();
  assert.deepEqual(keys.json.keys, ['/']);
  assert.equal((await owner.call('vault', { state: 'on' })).json.vaultKeys.state, 'on');
  const login = await new Client().call('login', { name: 'alex', password: pw });
  assert.equal(login.json.vaultKeys?.state, 'on', 'signing in hands the page its wrapped file key');
  const status = (await owner.call('status')).json;
  assert.equal(status.vaultKeys.state, 'on');
  assert.equal(typeof status.vaultKeys.wrapPw, 'string');
  // Nobody else is told the wraps: the owner's list of people carries the state only.
  const list = (await owner.call('users')).json.users;
  assert.ok(!JSON.stringify(list).includes(status.vaultKeys.wrapPw));
});

test('a locked screen says the files are encrypted but hands out no wrapped key; unlocking does', async () => {
  const locked = await owner.call('lock', {});
  assert.equal(locked.json.locked, true);
  for (const answer of [locked.json, (await owner.call('status')).json]) {
    assert.deepEqual(answer.vaultKeys, { state: 'on', stale: false }, 'no salt, rounds or wraps to guess the password against');
  }
  const unlocked = await owner.call('unlock', { password: pw });
  assert.equal(unlocked.json.locked, false);
  assert.equal(typeof unlocked.json.vaultKeys.wrapPw, 'string');
  await unwrapWithPassword(unlocked.json.vaultKeys, pw);
});

test('a password change must carry the file key wrapped for the new password', async () => {
  assert.equal((await owner.call('password', { password: pw, next: 'harbour-kettle-maple-7' })).status, 400, 'no wrap: refused, nothing changed');
  const next = 'harbour-kettle-maple-7';
  const r = await owner.call('password', { password: pw, next, ...(await wrapWithPassword(fileKey, next, ROUNDS)) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  pw = next;
  const keys = (await owner.call('status')).json.vaultKeys;
  await unwrapWithPassword(keys, pw);
});

test('after the owner resets someone\'s password, their files are marked for re-opening with the recovery key', async () => {
  const jo = new Client();
  assert.equal((await owner.call('user-create', { name: 'jo', next: 'harbour-kettle-19', password: pw })).status, 200);
  assert.equal((await jo.call('login', { name: 'jo', password: 'harbour-kettle-19' })).status, 200);
  const joKey = await newFileKey();
  const joRecovery = await recoveryParts(newRecoveryKey());
  const joOn = await jo.call('vault', { state: 'migrating-on', password: 'harbour-kettle-19', ...(await wrapWithPassword(joKey, 'harbour-kettle-19', ROUNDS)), wrapRk: await wrapWithRecovery(joKey, joRecovery.kek), rkAuth: joRecovery.auth });
  assert.equal(joOn.status, 200, JSON.stringify(joOn.json));
  await jo.call('vault', { state: 'on' });
  const joId = (await jo.call('status')).json.user.id;

  assert.equal((await owner.call('user-password', { id: joId, next: 'owner-set-password-3', password: pw })).status, 200);
  assert.equal((await jo.call('login', { name: 'jo', password: 'owner-set-password-3' })).status, 200);
  const stale = (await jo.call('status')).json.vaultKeys;
  assert.equal(stale.stale, true);
  await assert.rejects(unwrapWithPassword(stale, 'owner-set-password-3'), 'the new password cannot open the old wrap');
  // Jo types the recovery key: the page opens the file key and wraps it for the new password.
  const opened = await unwrapWithRecovery(stale.wrapRk, joRecovery.kek, true);
  const wrongProof = await jo.call('vault-rewrap', { rkAuth: (await recoveryParts(newRecoveryKey())).auth, ...(await wrapWithPassword(opened, 'owner-set-password-3', ROUNDS)) });
  assert.equal(wrongProof.status, 403);
  const re = await jo.call('vault-rewrap', { rkAuth: joRecovery.auth, ...(await wrapWithPassword(opened, 'owner-set-password-3', ROUNDS)) });
  assert.equal(re.status, 200, JSON.stringify(re.json));
  assert.equal(re.json.vaultKeys.stale, false);
  await unwrapWithPassword(re.json.vaultKeys, 'owner-set-password-3');
});

test('forgot password with encryption on: the recovery key reopens the files under the new password', async () => {
  const c = new Client();
  const parts = await recoveryParts(recovery);
  const started = await c.call('recover-start', { name: 'alex', rkAuth: parts.auth });
  assert.equal(started.status, 200, JSON.stringify(started.json));
  const opened = await unwrapWithRecovery(started.json.vaultKeys.wrapRk, parts.kek, true);
  assert.equal((await c.call('recover-finish', { password: 'another-new-one-44' })).status, 400, 'no wrap: refused');
  const done = await c.call('recover-finish', { password: 'another-new-one-44', ...(await wrapWithPassword(opened, 'another-new-one-44', ROUNDS)) });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  const k = await unwrapWithPassword(done.json.vaultKeys, 'another-new-one-44');
  const rec = await fetch(`${BASE}/api/store.php?key=/`, { headers: { 'X-Desktop-Store': '1', Cookie: c.cookie } });
  assert.equal(new TextDecoder().decode(await unseal(k, '/', new Uint8Array(await rec.arrayBuffer()))), '[]');
  owner.cookie = c.cookie;
  pw = 'another-new-one-44';
});

test('turning encryption off moves back in order; starting again sets the locked files aside, never deletes them', async () => {
  assert.equal((await owner.call('vault', { state: 'migrating-off', password: 'wrong' })).status, 403);
  assert.equal((await owner.call('vault', { state: 'migrating-off', password: pw })).status, 200);
  // The top folder is still sealed: "off" is refused, and the key kept, until the browser has rewritten it plain.
  const early = await owner.call('vault', { state: 'off' });
  assert.equal(early.status, 409, JSON.stringify(early.json));
  assert.equal(early.json.redo, 1);
  assert.equal((await owner.call('status')).json.vaultKeys.state, 'migrating-off', 'the key is kept');
  assert.equal(await owner.put('/', new TextEncoder().encode('[]')), 200);
  assert.equal((await owner.call('vault', { state: 'off' })).json.vaultKeys, null);
  // Jo lost everything: start again.
  const jo = new Client();
  await jo.call('login', { name: 'jo', password: 'owner-set-password-3' });
  const joId = (await jo.call('status')).json.user.id;
  // Jo's encryption is on, so only a sealed record is taken (the server cannot open it, only see that it is sealed).
  assert.equal(await jo.put('/', new Uint8Array([1, 2, 3])), 409, 'nothing plain is taken while encryption is on');
  assert.equal(await jo.put('/', await seal(await newFileKey(), '/', new Uint8Array([1, 2, 3]))), 200);
  assert.equal((await jo.call('vault-abandon', { confirm: 'yes' })).status, 400);
  assert.equal((await jo.call('vault-abandon', { confirm: 'start again' })).status, 403, 'the password is needed');
  const fresh = await jo.call('vault-abandon', { confirm: 'start again', password: 'owner-set-password-3' });
  assert.equal(fresh.status, 200, JSON.stringify(fresh.json));
  assert.equal(fresh.json.user.vault, 'off');
  const store = join(data, 'users', joId);
  const aside = readdirSync(store).filter(n => n.startsWith('locked-'));
  assert.equal(aside.length, 1, 'the old files are kept aside');
  assert.ok(readdirSync(join(store, aside[0]), { recursive: true }).length > 0);
  assert.deepEqual((await jo.keys()).json.keys, [], 'and Jo starts with empty files');
});

test('the server tool resets a password and marks encrypted files for the recovery key', async () => {
  const jo = new Client();
  await jo.call('login', { name: 'jo', password: 'owner-set-password-3' });
  const k = await newFileKey();
  const r = await recoveryParts(newRecoveryKey());
  const on = await jo.call('vault', { state: 'migrating-on', password: 'owner-set-password-3', ...(await wrapWithPassword(k, 'owner-set-password-3', ROUNDS)), wrapRk: await wrapWithRecovery(k, r.kek), rkAuth: r.auth });
  assert.equal(on.status, 200, JSON.stringify(on.json));
  const out = spawnSync(PHP, ['server/tools/reset-password.php', 'jo'], { env: { ...process.env, DESKTOP_DATA_DIR: data }, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const newPass = /New password for jo: (\S+)/.exec(out.stdout)?.[1];
  assert.ok(newPass, out.stdout);
  assert.match(out.stdout, /recovery key/);
  const again = new Client();
  assert.equal((await again.call('login', { name: 'jo', password: newPass })).status, 200);
  assert.equal((await again.call('status')).json.vaultKeys.stale, true);
});

test('after an owner reset, the new password alone cannot start decryption, change the wrap or replace the recovery key', async () => {
  // Kim encrypts; the owner resets Kim's password. Whoever now holds that new password (the owner, or someone who
  // took it from them) must not be able to have Kim's files decrypted, swap the wrapped key, or replace the recovery
  // key: a stale account leaves "stale" only through the recovery key.
  const kim = new Client();
  assert.equal((await owner.call('user-create', { name: 'kim', next: 'copper-meadow-33', password: pw })).status, 200);
  assert.equal((await kim.call('login', { name: 'kim', password: 'copper-meadow-33' })).status, 200);
  const kimKey = await newFileKey();
  const kimRecovery = await recoveryParts(newRecoveryKey());
  const on = await kim.call('vault', { state: 'migrating-on', password: 'copper-meadow-33', ...(await wrapWithPassword(kimKey, 'copper-meadow-33', ROUNDS)), wrapRk: await wrapWithRecovery(kimKey, kimRecovery.kek), rkAuth: kimRecovery.auth });
  assert.equal(on.status, 200, JSON.stringify(on.json));
  assert.equal(await kim.put('/', await seal(kimKey, '/', new TextEncoder().encode('[]'))), 200);
  assert.equal((await kim.call('vault', { state: 'on' })).status, 200);
  const kimId = (await kim.call('status')).json.user.id;
  assert.equal((await owner.call('user-password', { id: kimId, next: 'owner-chose-this-9', password: pw })).status, 200);

  const taken = new Client();
  assert.equal((await taken.call('login', { name: 'kim', password: 'owner-chose-this-9' })).status, 200);
  const stale = (await taken.call('status')).json.vaultKeys;
  assert.equal(stale.stale, true);
  const off = await taken.call('vault', { state: 'migrating-off', password: 'owner-chose-this-9' });
  assert.equal(off.status, 409, `decryption started with the reset password alone: ${off.status} ${JSON.stringify(off.json)}`);
  const otherKey = await newFileKey();
  const swap = await taken.call('password', { password: 'owner-chose-this-9', next: 'and-then-this-one-10', ...(await wrapWithPassword(otherKey, 'and-then-this-one-10', ROUNDS)) });
  assert.equal(swap.status, 409, `the wrapped key was replaced with the reset password alone: ${swap.status} ${JSON.stringify(swap.json)}`);
  assert.equal((await taken.call('status')).json.vaultKeys.wrapPw, stale.wrapPw, 'the wrap is as it was');
  const rk = await taken.call('recovery-key', { password: 'owner-chose-this-9', rkAuth: (await recoveryParts(newRecoveryKey())).auth, wrapRk: await wrapWithRecovery(otherKey, (await recoveryParts(newRecoveryKey())).kek) });
  assert.equal(rk.status, 409, `the recovery key was replaced with the reset password alone: ${rk.status} ${JSON.stringify(rk.json)}`);

  // Kim, with the recovery key, re-opens the files; after that the new password works everywhere, decryption included.
  const opened = await unwrapWithRecovery(stale.wrapRk, kimRecovery.kek, true);
  const re = await taken.call('vault-rewrap', { rkAuth: kimRecovery.auth, ...(await wrapWithPassword(opened, 'owner-chose-this-9', ROUNDS)) });
  assert.equal(re.status, 200, JSON.stringify(re.json));
  assert.equal(re.json.vaultKeys.stale, false);
  const now = await taken.call('vault', { state: 'migrating-off', password: 'owner-chose-this-9' });
  assert.equal(now.status, 200, JSON.stringify(now.json));
});

// ---- Switching encryption while another page saves ---------------------------------

const sam = new Client();
const SAM_PW = 'quarry-bramble-61';
let samId = '';
/** Two tabs of Sam's (the same session), each with the browser's own store classes, talking to the test server. */
function page(): { fs: FileSystem; store: EncryptedStore } {
  const store = new EncryptedStore(new ServerStore(`${BASE}/api/store.php`));
  return { fs: new FileSystem(store), store };
}
const realFetch = globalThis.fetch;
function asSam(): () => void {
  globalThis.fetch = ((url: string | URL, init: RequestInit = {}) => realFetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), Cookie: sam.cookie } })) as typeof fetch;
  return () => (globalThis.fetch = realFetch);
}
async function rawRecords(): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  for (const key of (await sam.keys()).json.keys as string[]) {
    const res = await realFetch(`${BASE}/api/store.php?key=${encodeURIComponent(key)}`, { headers: { 'X-Desktop-Store': '1', Cookie: sam.cookie } });
    out.set(key, new Uint8Array(await res.arrayBuffer()));
  }
  return out;
}
/** A record put straight on the server's disk, as a save cut off part-way or a stale page could have left it. */
function plant(key: string, bytes: Uint8Array): void {
  const dir = join(data, 'users', samId, 'objects', key.slice(0, 2));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, key), Buffer.concat([Buffer.from('0'.repeat(32)), bytes]));
}
const PLANTED = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';

test('a page that missed encryption being turned on cannot leave a plain file behind: its save is refused, it catches up, and "on" is said only when every file is sealed', async () => {
  assert.equal((await owner.call('user-create', { name: 'sam', next: SAM_PW, password: pw })).status, 200);
  assert.equal((await sam.call('login', { name: 'sam', password: SAM_PW })).status, 200);
  samId = (await sam.call('status')).json.user.id;
  const restore = asSam();
  try {
    const a = page();
    const b = page();
    await a.fs.writeText('/Documents/old.txt', 'written before');
    await b.fs.list('/Documents');

    // Tab A turns encryption on and starts converting; tab B has not heard.
    const key = await newFileKey();
    const parts = await recoveryParts(newRecoveryKey());
    const on = await sam.call('vault', { state: 'migrating-on', password: SAM_PW, ...(await wrapWithPassword(key, SAM_PW, ROUNDS)), wrapRk: await wrapWithRecovery(key, parts.kek), rkAuth: parts.auth });
    assert.equal(on.status, 200, JSON.stringify(on.json));
    a.store.state = 'migrating-on';
    a.store.fileKey = key;
    let refused: unknown = null;
    const listKeys = a.store.inner.keys.bind(a.store.inner);
    a.store.inner.keys = async () => {
      const keys = await listKeys();
      // After A took its list of records: B saves a new file, still thinking encryption is off.
      refused = await b.fs.writeText('/Documents/new.txt', 'plaintext secret').then(() => null, e => e);
      return keys;
    };
    await a.store.migrate(() => undefined);
    assert.ok(refused instanceof StoreError && refused.status === 409 && /switched on or off/.test(refused.message), String(refused));

    // B catches up (the page does this itself on that refusal) and saves again: sealed this time.
    b.store.state = 'migrating-on';
    b.store.fileKey = key;
    await b.fs.writeText('/Documents/new.txt', 'plaintext secret');
    const done = await sam.call('vault', { state: 'on' });
    assert.equal(done.status, 200, JSON.stringify(done.json));
    a.store.state = 'on';
    for (const [k, bytes] of await rawRecords()) {
      assert.ok(isSealed(bytes), `record ${k} is sealed on the server`);
      assert.ok(!Buffer.from(bytes).toString('latin1').includes('plaintext secret'));
    }
    assert.equal(await a.fs.readText('/Documents/new.txt'), 'plaintext secret', 'and it opens in the encrypted desktop');
  } finally {
    restore();
  }
});

test('while encryption is on, nothing plain is taken even from a page that claims nothing; a plain record found at the end blocks "on" until converted', async () => {
  const restore = asSam();
  try {
    assert.equal(await sam.put(PLANTED, new TextEncoder().encode('plain, no header')), 409);
    // Back to migrating-on with a plain record on disk (as an interrupted save could leave): "on" is refused and says how many.
    assert.equal((await sam.call('vault', { state: 'migrating-off', password: SAM_PW })).status, 200);
    assert.equal((await sam.call('vault', { state: 'migrating-on', password: SAM_PW })).status, 200);
    plant(PLANTED, new TextEncoder().encode('left behind in plain'));
    const refused = await sam.call('vault', { state: 'on' });
    assert.equal(refused.status, 409, JSON.stringify(refused.json));
    assert.equal(refused.json.redo, 1);
    assert.equal((await sam.call('status')).json.vaultKeys.state, 'migrating-on');
  } finally {
    restore();
  }
});

test('turning off: a page that still seals is refused, a sealed record left on disk blocks "off", and the key stays until every file is plain', async () => {
  const restore = asSam();
  try {
    const status = (await sam.call('status')).json;
    const key = await unwrapWithPassword(status.vaultKeys, SAM_PW, true);
    // Finish turning on first (seal the planted record), then turn off.
    const p = page();
    p.store.state = 'migrating-on';
    p.store.fileKey = key;
    await p.store.migrate(() => undefined);
    assert.equal((await sam.call('vault', { state: 'on' })).status, 200);
    assert.equal((await sam.call('vault', { state: 'migrating-off', password: SAM_PW })).status, 200);
    const stale = page();
    stale.store.state = 'on';
    stale.store.fileKey = key;
    await assert.rejects(stale.fs.writeText('/Documents/late.txt', 'sealed by a stale page'), (e: unknown) => e instanceof StoreError && e.status === 409);
    p.store.state = 'migrating-off';
    await p.store.migrate(() => undefined);
    plant(PLANTED, await seal(key, PLANTED, new TextEncoder().encode('left behind sealed')));
    const refused = await sam.call('vault', { state: 'off' });
    assert.equal(refused.status, 409, JSON.stringify(refused.json));
    assert.ok((await sam.call('status')).json.vaultKeys?.wrapPw, 'the key is not thrown away while a file still needs it');
    await p.store.migrate(() => undefined);
    assert.equal((await sam.call('vault', { state: 'off' })).json.vaultKeys, null);
    for (const [k, bytes] of await rawRecords()) assert.ok(!isSealed(bytes), `record ${k} is plain again`);
    assert.equal(new TextDecoder().decode((await rawRecords()).get(PLANTED)), 'left behind sealed');
  } finally {
    restore();
  }
});
