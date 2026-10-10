// Saving over a file another window or device saved meanwhile: the save replaces only the copy that was opened, and the
// check is part of the commit itself (not a look beforehand that a save from elsewhere can slip past).
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileChanged, FileSystem } from '../src/fs/fs.ts';
import { MemoryStore } from '../src/store/memory-store.ts';
import { saveOver } from '../src/shell/savefile.ts';
import type { Store, StoreOp } from '../src/store/store.ts';
import type { Shell } from '../src/shell/types.ts';
import { EncryptedStore } from '../src/store/encrypted-store.ts';
import type { ServerStore } from '../src/store/server-store.ts';
import { isSealed, newFileKey, seal } from '../src/auth/vault.ts';

const bytes = (s: string) => new TextEncoder().encode(s);

/** A store that lets another device save once, between this window reading the folder and committing its own save. */
function slippedStore(inner: MemoryStore, other: () => Promise<unknown>): Store {
  let fired = false;
  return {
    label: 'test',
    get: k => inner.get(k),
    async commit(ops: StoreOp[]) {
      if (!fired) {
        fired = true;
        await other();
      }
      return inner.commit(ops);
    },
  };
}

const shellWith = (fs: FileSystem, answers: boolean[]) => {
  const asked: string[] = [];
  const shell = { fs, dialogs: { confirm: async (o: { text: string }) => (asked.push(o.text), answers.shift() ?? false) } } as unknown as Shell;
  return { shell, asked };
};

test('a save that replaces the opened copy is refused when another device saved in between (no prompt was skipped)', async () => {
  const inner = new MemoryStore();
  const setup = new FileSystem(inner);
  const opened = await setup.writeText('/Documents/a.txt', 'first');
  const b = new FileSystem(inner);
  const a = new FileSystem(slippedStore(inner, () => b.writeText('/Documents/a.txt', 'newer from B')));
  await a.list('/Documents');
  await assert.rejects(a.writeFile('/Documents/a.txt', bytes('stale from A'), { replacing: opened.id }), FileChanged);
  assert.equal(await setup.readText('/Documents/a.txt'), 'newer from B', "B's newer save must still be there");
});

test('saveOver asks when the copy changed, and "Do not save" leaves the newer copy alone', async () => {
  const inner = new MemoryStore();
  const fs = new FileSystem(inner);
  const opened = await fs.writeText('/Documents/a.txt', 'first');
  await new FileSystem(inner).writeText('/Documents/a.txt', 'newer from B');
  const { shell, asked } = shellWith(fs, [false]);
  assert.equal(await saveOver(shell, '/Documents/a.txt', bytes('mine'), opened.id), null);
  assert.equal(asked.length, 1);
  assert.equal(await fs.readText('/Documents/a.txt'), 'newer from B');
});

test('saveOver replaces after "Replace it", and an unchanged copy is saved without asking', async () => {
  const inner = new MemoryStore();
  const fs = new FileSystem(inner);
  const opened = await fs.writeText('/Documents/a.txt', 'first');
  const { shell, asked } = shellWith(fs, [true]);
  const saved = await saveOver(shell, '/Documents/a.txt', bytes('second'), opened.id);
  assert.ok(saved && saved.id !== opened.id, 'every save makes a new id');
  assert.equal(asked.length, 0);
  await new FileSystem(inner).writeText('/Documents/a.txt', 'newer from B');
  assert.ok(await saveOver(shell, '/Documents/a.txt', bytes('third'), saved.id));
  assert.equal(asked.length, 1);
  assert.equal(await fs.readText('/Documents/a.txt'), 'third');
});

test('a copy that changes again while the person decides is asked about again', async () => {
  const inner = new MemoryStore();
  const fs = new FileSystem(inner);
  const opened = await fs.writeText('/Documents/a.txt', 'first');
  const b = new FileSystem(inner);
  await b.writeText('/Documents/a.txt', 'B one');
  const asked: number[] = [];
  const shell = { fs } as unknown as Shell;
  const ask = async () => {
    asked.push(1);
    if (asked.length === 1) await b.writeText('/Documents/a.txt', 'B two'); // saved while the box was open
    return asked.length < 3;
  };
  assert.ok(await saveOver(shell, '/Documents/a.txt', bytes('mine'), opened.id, ask));
  assert.equal(asked.length, 2, 'the second change is asked about too');
  assert.equal(await fs.readText('/Documents/a.txt'), 'mine');
});

test('a failure reading the file is reported, never taken as leave to overwrite', async () => {
  const inner = new MemoryStore();
  const fs = new FileSystem(inner);
  const opened = await fs.writeText('/Documents/a.txt', 'first');
  const broken: Store = { label: 'test', get: async () => { throw new Error('offline'); }, commit: ops => inner.commit(ops) };
  const { shell } = shellWith(new FileSystem(broken), [true]);
  await assert.rejects(saveOver(shell, '/Documents/a.txt', bytes('mine'), opened.id), /offline/);
  assert.equal(await fs.readText('/Documents/a.txt'), 'first');
});

// ---- A page that missed an encryption switch made elsewhere catches up instead of crying tampering -------------------


/** An encrypting store over a fixed record, for reading only. */
function over(data: Uint8Array): EncryptedStore {
  const inner = { label: 'test', get: async () => ({ version: 'v', data }), commit: async () => ({}) } as unknown as ServerStore;
  return new EncryptedStore(inner);
}

test('a plain record on a page that thinks encryption is on: accepted once the server says it was turned off; refused as tampering if it still is on', async () => {
  const s = over(bytes('plain folder'));
  s.state = 'on';
  let asked = 0;
  s.recheck = async () => {
    asked++;
    s.state = 'off';
  };
  assert.equal(new TextDecoder().decode((await s.get('/'))!.data), 'plain folder');
  assert.equal(asked, 1);
  const t = over(bytes('planted'));
  t.state = 'on';
  t.recheck = async () => undefined; // the server still says on
  await assert.rejects(t.get('/'), /arrived from the server unencrypted/);
});

test('a sealed record on a page with no key (encryption turned on elsewhere): the page catches up, takes the kept key and opens it', async () => {
  const key = await newFileKey();
  const s = over(await seal(key, '/', bytes('secret folder')));
  s.state = 'off';
  s.recheck = async () => {
    s.state = 'on';
    s.fileKey = key;
  };
  assert.equal(new TextDecoder().decode((await s.get('/'))!.data), 'secret folder');
});

test('a save on a page that caught up to "encrypted" before its key arrived: it catches up once more and seals with the key', async () => {
  const key = await newFileKey();
  let sent: { sealed?: boolean; data?: Uint8Array } = {};
  const inner = {
    label: 'test',
    get: async () => null,
    commit: async (ops: Array<{ data?: Uint8Array }>, sealed?: boolean) => ((sent = { sealed, data: ops[0].data }), {}),
  } as unknown as ServerStore;
  const s = new EncryptedStore(inner);
  s.state = 'migrating-on'; // heard of the switch, but the key was not kept yet when it looked
  s.recheck = async () => {
    s.fileKey = key; // now it is
  };
  await s.commit([{ op: 'put', key: '/', expect: '*', data: bytes('folder') }]);
  assert.equal(sent.sealed, true);
  assert.ok(sent.data && isSealed(sent.data), 'what went to the server was sealed');
});
