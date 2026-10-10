// Files under real use, through the real server: three "tabs" of one person, each talking to its own PHP server
// process (one data folder, so their requests truly overlap), do random file work at the same time: save, new folder,
// rename, move, copy, delete, read. Afterwards everything must hang together: every folder entry has its file, no file
// is left outside a folder, the totals agree, and every file read held what some tab wrote (never garbage or another
// file's bytes). Run plain, encrypted, and while encryption is switched on in the middle of it all.
// Needs PHP (PHP_BIN, or php on the PATH). Run: npm test
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileSystem, FsError } from '../src/fs/fs.ts';
import { EncryptedStore } from '../src/store/encrypted-store.ts';
import { ServerStore } from '../src/store/server-store.ts';
import { StoreError } from '../src/store/store.ts';
import { isSealed, newFileKey, newRecoveryKey, recoveryParts, wrapWithPassword, wrapWithRecovery } from '../src/auth/vault.ts';
import { PHP, hasPhp, portFree } from './php-bin.ts';
import { tempDir } from './tmp.ts';

const root = join(import.meta.dirname, '..');
const PORTS = [3092, 3094, 3097];
const BASES = PORTS.map(p => `http://127.0.0.1:${p}`);
const PASS = 'harbour-quarry-lantern-38';
const ROUNDS = 100_000;
const data = tempDir('tomlinos-robust-files-');
const servers: ChildProcess[] = [];
let cookie = '';
let userId = '';
const realFetch = globalThis.fetch;
// ROBUST_SEED: another random run (the operations differ, the checks are the same).
const SEED = Number(process.env.ROBUST_SEED ?? 0) * 10000;

async function auth(op: string, body?: unknown): Promise<any> {
  const res = await realFetch(`${BASES[0]}/api/auth.php?op=${op}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-Desktop-Store': '1', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const json = await res.json().catch(() => null);
  return { status: res.status, ...json };
}

before(async () => {
  if (!hasPhp) return;
  for (const port of PORTS) await portFree(port);
  for (const port of PORTS) {
    servers.push(spawn(PHP, ['-d', 'opcache.enable=0', '-S', `127.0.0.1:${port}`, '-t', 'public', 'server/dev-router.php'], { cwd: root, env: { ...process.env, DESKTOP_DATA_DIR: data }, stdio: 'ignore' }));
  }
  for (const base of BASES) {
    for (let i = 0; ; i++) {
      try {
        await realFetch(`${base}/storage.json`);
        break;
      } catch {
        if (i > 60) throw new Error('a test server did not start');
        await new Promise(r => setTimeout(r, 100));
      }
    }
  }
  const s = await auth('setup', { name: 'robin', password: PASS });
  assert.equal(s.status, 200, JSON.stringify(s));
  userId = (await auth('status')).user.id;
  // Every request from the tabs carries the session cookie (one person, three tabs).
  globalThis.fetch = ((url: string | URL, init: RequestInit = {}) => realFetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), Cookie: cookie } })) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
  for (const s of servers) s.kill();
});

/** A small repeatable random source, so a failing run can be run again the same way. */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Tab { fs: FileSystem; store: EncryptedStore; name: string }
const tab = (i: number): Tab => {
  const store = new EncryptedStore(new ServerStore(`${BASES[i]}/api/store.php`));
  return { fs: new FileSystem(store), store, name: `t${i}` };
};

const DIRS = ['/Documents', '/Documents/F1', '/Documents/F2', '/Documents/F1/G'];
const NAMES = ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'];
const CONTENT = /^t\d-\d+ [a-z]+$/;

/**
 * One tab's random work: `count` operations. Refusals a person would see (FsError: a name taken, a file gone, a copy
 * changed elsewhere) are fine; anything else is a fault. `onVault` is called when a save was refused because encryption
 * moved on (the page then catches up, as main.ts does).
 */
async function work(t: Tab, seed: number, count: number, stats: Record<string, number>, onVault?: (t: Tab) => Promise<void>): Promise<string[]> {
  const rnd = random(seed);
  const pick = <T>(a: T[]): T => a[Math.floor(rnd() * a.length)];
  const faults: string[] = [];
  for (let i = 0; i < count; i++) {
    const dir = pick(DIRS);
    const path = `${dir}/${pick(NAMES)}`;
    const kind = pick(['write', 'write', 'write', 'read', 'read', 'mkdir', 'rename', 'move', 'copy', 'remove']);
    try {
      if (kind === 'write') await t.fs.writeText(path, `${t.name}-${i} ${pick(['apple', 'birch', 'cedar', 'delta'])}`);
      else if (kind === 'read') {
        const text = await t.fs.readText(path);
        if (!CONTENT.test(text)) faults.push(`read ${path}: "${text.slice(0, 40)}"`);
      } else if (kind === 'mkdir') await t.fs.mkdir(pick(DIRS.slice(1)));
      else if (kind === 'rename') await t.fs.rename(path, pick(NAMES));
      else if (kind === 'move') await t.fs.move([path], pick(DIRS));
      else if (kind === 'copy') await t.fs.copy([path], pick(DIRS));
      else await t.fs.remove([rnd() < 0.15 ? pick(DIRS.slice(1)) : path]);
      stats.done = (stats.done ?? 0) + 1;
    } catch (error) {
      if (error instanceof FsError) stats.refused = (stats.refused ?? 0) + 1;
      else if (onVault && error instanceof StoreError && error.status === 409) {
        stats.vault = (stats.vault ?? 0) + 1;
        await onVault(t);
      } else faults.push(`${kind} ${path}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
    }
  }
  return faults;
}

/** Walks every folder from the top through a tab's store: entries without a file, files outside every folder, and bad contents. */
async function audit(t: Tab): Promise<{ missing: string[]; unreached: string[]; bad: string[]; files: number }> {
  const keys = new Set(await t.store.inner.keys());
  const reached = new Set<string>();
  const missing: string[] = [];
  const bad: string[] = [];
  let files = 0;
  const dec = new TextDecoder();
  const walk = async (key: string, path: string): Promise<void> => {
    reached.add(key);
    const folder = JSON.parse(dec.decode((await t.store.get(key))!.data));
    for (const e of folder.entries) {
      if (!keys.has(e.id)) {
        missing.push(`${path}/${e.name}`);
        continue;
      }
      if (e.kind === 'folder') await walk(e.id, `${path}/${e.name}`);
      else {
        reached.add(e.id);
        files++;
        const text = dec.decode((await t.store.get(e.id))!.data);
        if (!CONTENT.test(text)) bad.push(`${path}/${e.name}: "${text.slice(0, 40)}"`);
      }
    }
  };
  await walk('/', '');
  return { missing, unreached: [...keys].filter(k => !reached.has(k)), bad, files };
}

/** The server's own check of this person's store (totals against files, a cut-off save left over). */
function serverCheck(): any {
  const r = spawnSync(PHP, ['-r', `require 'server/lib/store.php'; echo json_encode(store_check(getenv('D')));`], { cwd: root, env: { ...process.env, D: join(data, 'users', userId) }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

/** Every record on the server's disk, sealed or not. */
function onDisk(): { sealed: number; plain: number } {
  const dir = join(data, 'users', userId, 'objects');
  let sealed = 0;
  let plain = 0;
  for (const sub of readdirSync(dir)) {
    for (const f of readdirSync(join(dir, sub))) {
      if (f.endsWith('.tmp')) continue;
      if (isSealed(new Uint8Array(readFileSync(join(dir, sub, f))).subarray(32))) sealed++;
      else plain++;
    }
  }
  return { sealed, plain };
}

function assertWhole(a: { missing: string[]; unreached: string[]; bad: string[] }, c: any, label: string): void {
  assert.deepEqual(a.missing, [], `${label}: every folder entry has its file`);
  assert.deepEqual(a.unreached, [], `${label}: no file outside every folder`);
  assert.deepEqual(a.bad, [], `${label}: every file holds what a tab wrote`);
  assert.equal(c.journal, false, `${label}: no save left half-done`);
  assert.equal(c.count[0] < 0 || c.count[0] === c.count[1], true, `${label}: the count kept ${c.count[0]} = the files ${c.count[1]}`);
  assert.equal(c.usage[0] < 0 || c.usage[0] === c.usage[1], true, `${label}: the space kept ${c.usage[0]} = the files ${c.usage[1]}`);
}

test('three tabs doing random file work at once, files not encrypted: nothing lost, nothing stray, every file whole', { skip: !hasPhp && 'no PHP', timeout: 600000 }, async () => {
  const tabs = [0, 1, 2].map(tab);
  await tabs[0].fs.ensureFolder('/Documents/F1/G');
  await tabs[0].fs.ensureFolder('/Documents/F2');
  const stats: Record<string, number> = {};
  const faults = (await Promise.all(tabs.map((t, i) => work(t, SEED + 1000 + i, 120, stats)))).flat();
  assert.deepEqual(faults, [], 'no faults, only refusals a person would see');
  const a = await audit(tabs[0]);
  assertWhole(a, serverCheck(), 'plain');
  console.log(`      ${stats.done} done, ${stats.refused ?? 0} refused (name taken, gone, or changed elsewhere); ${a.files} files at the end`);
  assert.ok(stats.done > 360 * 0.4, `a good share went through (${stats.done} of 360; random work on files that may not be there gets refused)`);
});

let key: CryptoKey;

test('the same with encryption on: every record on the server is sealed, and every file opens whole', { skip: !hasPhp && 'no PHP', timeout: 600000 }, async () => {
  key = await newFileKey();
  const parts = await recoveryParts(newRecoveryKey());
  const on = await auth('vault', { state: 'migrating-on', password: PASS, ...(await wrapWithPassword(key, PASS, ROUNDS)), wrapRk: await wrapWithRecovery(key, parts.kek), rkAuth: parts.auth });
  assert.equal(on.status, 200, JSON.stringify(on));
  const tabs = [0, 1, 2].map(tab);
  for (const t of tabs) {
    t.store.state = 'migrating-on';
    t.store.fileKey = key;
  }
  await tabs[0].store.migrate(() => undefined);
  assert.equal((await auth('vault', { state: 'on' })).status, 200);
  for (const t of tabs) t.store.state = 'on';
  const stats: Record<string, number> = {};
  const faults = (await Promise.all(tabs.map((t, i) => work(t, SEED + 2000 + i, 120, stats)))).flat();
  assert.deepEqual(faults, []);
  const a = await audit(tabs[1]);
  assertWhole(a, serverCheck(), 'encrypted');
  const disk = onDisk();
  assert.equal(disk.plain, 0, `nothing readable on the server (${disk.sealed} sealed)`);
  console.log(`      ${stats.done} done, ${stats.refused ?? 0} refused; ${a.files} files, ${disk.sealed} sealed records`);
});

test('encryption switched off and back on while two other tabs keep working: no plain file is left, and nothing is lost', { skip: !hasPhp && 'no PHP', timeout: 900000 }, async () => {
  const tabs = [0, 1, 2].map(tab);
  for (const t of tabs) {
    t.store.state = 'on';
    t.store.fileKey = key;
  }
  // A tab that hears encryption moved on takes the server's word, as the page does (status, then the kept key).
  const catchUp = async (t: Tab) => {
    const s = await auth('status');
    t.store.state = s.vaultKeys?.state ?? 'off';
    t.store.fileKey = s.vaultKeys ? key : null;
  };
  const stats: Record<string, number> = {};
  /** Tab 0 switches: starts the move, converts, says it is done (again, if a file came in the old kind meanwhile). */
  const switchTo = async (to: 'on' | 'off') => {
    // Turning on from off sends the key wrapped for the password and a new recovery key, as My account does.
    const parts = await recoveryParts(newRecoveryKey());
    const wrap = to === 'on' ? { ...(await wrapWithPassword(key, PASS, ROUNDS)), wrapRk: await wrapWithRecovery(key, parts.kek), rkAuth: parts.auth } : {};
    const start = await auth('vault', { state: to === 'on' ? 'migrating-on' : 'migrating-off', password: PASS, ...wrap });
    assert.equal(start.status, 200, JSON.stringify(start));
    tabs[0].store.state = to === 'on' ? 'migrating-on' : 'migrating-off';
    tabs[0].store.fileKey = key;
    for (let pass = 1; ; pass++) {
      await tabs[0].store.migrate(() => undefined);
      const done = await auth('vault', { state: to });
      if (done.status === 200) {
        tabs[0].store.state = to;
        tabs[0].store.fileKey = to === 'on' ? key : null;
        stats[`passes-${to}`] = pass;
        return;
      }
      assert.equal(done.redo > 0, true, `refused for another reason: ${JSON.stringify(done)}`);
      assert.ok(pass < 8, 'kept finding files in the old kind');
    }
  };
  const busy = Promise.all([work(tabs[1], SEED + 3001, 160, stats, catchUp), work(tabs[2], SEED + 3002, 160, stats, catchUp)]);
  await new Promise(r => setTimeout(r, 1500));
  await switchTo('off');
  const plainNow = onDisk();
  assert.equal(plainNow.sealed, 0, `nothing left sealed once encryption was off (${plainNow.plain} plain)`);
  await switchTo('on');
  const faults = (await busy).flat();
  assert.deepEqual(faults, [], 'no faults while the switch happened');
  // The workers may have caught up to a state that has since moved on: one last catch-up, as a page would on its next save.
  for (const t of tabs) await catchUp(t);
  const a = await audit(tabs[2]);
  assertWhole(a, serverCheck(), 'after switching');
  const disk = onDisk();
  assert.equal(disk.plain, 0, `no plain record left on the server after turning encryption back on (${disk.sealed} sealed)`);
  console.log(`      while off: ${plainNow.plain} plain, ${plainNow.sealed} sealed; ${stats.done} done, ${stats.refused ?? 0} refused, ${stats.vault ?? 0} saves refused for a stale page (caught up); passes to off ${stats['passes-off']}, to on ${stats['passes-on']}; ${a.files} files`);
  assert.ok((stats.vault ?? 0) > 0, 'the other tabs did run into the switch (else this proved little)');
});
