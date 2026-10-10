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
