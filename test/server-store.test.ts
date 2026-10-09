// The file layer against the real PHP store (server/), on a throw-away data folder.
// Needs PHP: set PHP_BIN to its path, or have "php" on the PATH.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSystem } from '../src/fs/fs.ts';
import { ServerStore } from '../src/store/server-store.ts';
import { PHP } from './php-bin.ts';

const PORT = 3099;
const BASE = `http://127.0.0.1:${PORT}`;
const API = `${BASE}/api/store.php`;
const root = mkdtempSync(join(tmpdir(), 'desktop-store-'));
let data = root;
let php: ChildProcess;

function objectCount(): number {
  const dir = join(data, 'objects');
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { recursive: true, withFileTypes: true }).filter(d => d.isFile()).length;
}

before(async () => {
  php = spawn(PHP, ['-S', `127.0.0.1:${PORT}`, '-t', 'public', 'server/dev-router.php'], {
    env: { ...process.env, DESKTOP_DATA_DIR: root },
    stdio: 'ignore',
  });
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    try {
      await fetch(`${BASE}/storage.json`);
      up = true;
    } catch {
      await new Promise(r => setTimeout(r, 100));
    }
  }
  if (!up) throw new Error('PHP test server did not start');
  // The store answers a signed-in person only: set up the owner, then send the session cookie with every request to
  // this server, as the browser would.
  const res = await fetch(`${BASE}/api/auth.php?op=setup`, {
    method: 'POST',
    headers: { 'X-Desktop-Store': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'tester', password: 'store-test-passphrase' }),
  });
  assert.equal(res.status, 200);
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
  const plain = globalThis.fetch;
  globalThis.fetch = (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    if (!url.startsWith(BASE) || url.includes('/storage.json')) return plain(input, init);
    return plain(input, { ...init, headers: { ...(init.headers as Record<string, string>), Cookie: cookie } });
  };
  data = join(root, 'users', (await res.json()).user.id);
});

after(() => {
  php.kill();
  rmSync(root, { recursive: true, force: true });
});

test('the server tells the desktop to keep files on it', async () => {
  assert.deepEqual(await (await fetch(`${BASE}/storage.json`)).json(), { backend: 'server', api: '/api/store.php', auth: '/api/auth.php' });
});

test('the store refuses requests without its header, and from other sites', async () => {
  assert.equal((await fetch(`${API}?key=/`)).status, 400);
  const other = await fetch(`${API}?key=/`, { headers: { 'X-Desktop-Store': '1', Origin: 'https://evil.example' } });
  assert.equal(other.status, 403);
});

test('files round-trip through the server, and clashes between two windows are merged, not lost', async () => {
  const one = new FileSystem(new ServerStore(API));
  const two = new FileSystem(new ServerStore(API));
  await one.list('/Documents');
  await two.list('/Documents');
  const big = new Uint8Array(3 * 1024 * 1024).map((_, i) => i % 251);
  await one.writeFile('/Documents/big.bin', big);
  await two.writeText('/Documents/note.txt', 'from two'); // stale copy: the server says 409, the layer retries
  assert.deepEqual((await one.list('/Documents')).map(e => e.name).sort(), ['big.bin', 'note.txt']);
  assert.deepEqual(await two.readFile('/Documents/big.bin'), big);
});

test('deleting leaves no records behind on the server', async () => {
  const fs = new FileSystem(new ServerStore(API));
  await fs.list('/');
  const start = objectCount();
  await fs.mkdir('/Pictures/Trip');
  await fs.writeText('/Pictures/Trip/a.txt', 'a');
  await fs.writeText('/Pictures/Trip/a.txt', 'a again');
  await fs.remove(['/Pictures/Trip']);
  assert.equal(objectCount(), start);
});

test('a commit cut off half-way is finished by the next one', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const key = 'abcdef12-3456-4789-8abc-def012345678';
  const dir = join(data, 'objects', 'ab');
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `${key}.dead.tmp`);
  writeFileSync(tmp, 'f'.repeat(32) + 'recovered');
  writeFileSync(join(data, '.journal'), JSON.stringify([[tmp, join(dir, key)]]));
  const store = new ServerStore(API);
  assert.equal(await store.get(key), null, 'not visible until the journal is replayed');
  await new FileSystem(store).writeText('/Documents/trigger.txt', 'x');
  assert.equal(new TextDecoder().decode((await store.get(key))!.data), 'recovered');
  assert.equal(existsSync(join(data, '.journal')), false);
});
