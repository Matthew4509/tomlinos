// Audit of the Recycle Bin (November 2026). A test without `todo` is a P0: it fails now and passes once fixed.
// Run: node --test test/audit-recyclebin.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileSystem } from '../src/fs/fs.ts';
import { MemoryStore } from '../src/store/memory-store.ts';
import type { Store, StoreOp } from '../src/store/store.ts';
import { RecycleBin, TRASH_DIR } from '../src/shell/trash.ts';

/**
 * The moment that loses the file, made certain rather than left to timing: the move's save waits until the window's
 * listing has looked inside the new (still empty) slot. On a server a save takes longer than a read, so this order is
 * the likely one, not a contrived one.
 */
test('RB-P0-1: a file deleted while the Recycle Bin window is listing the bin is not destroyed', async () => {
  const mem = new MemoryStore();
  let hold: Promise<void> | null = null;
  let release = () => {};
  const store: Store = {
    label: 'held',
    get: key => mem.get(key),
    commit: async (ops: StoreOp[]) => {
      if (hold) await hold;
      return mem.commit(ops);
    },
  };
  const fs = new FileSystem(store);
  const bin = new RecycleBin(fs);
  await fs.ensureFolder('/Documents');
  await fs.writeText('/Documents/precious.txt', 'a year of notes');
  const list = fs.list.bind(fs);
  fs.list = async (path: string, withHidden?: boolean) => {
    const entries = await list(path, withHidden);
    if (path.startsWith(TRASH_DIR + '/')) release();
    return entries;
  };
  // The open Recycle Bin window lists the bin on every change to it (recyclebin.ts, shell.changes).
  const refreshes: Array<Promise<unknown>> = [];
  let first = true;
  fs.onChange(paths => {
    if (!paths.includes(TRASH_DIR) || !first) return;
    first = false;
    hold = new Promise<void>(resolve => (release = () => { hold = null; resolve(); }));
    refreshes.push(bin.list());
  });
  const { slots, failures } = await bin.put(['/Documents/precious.txt']);
  await Promise.all(refreshes);
  assert.deepEqual(failures, []);
  assert.equal(slots.length, 1, 'put says it went to the bin');
  const items = await bin.list();
  const inDocuments = await fs.exists('/Documents/precious.txt');
  assert.ok(items.some(i => i.name === 'precious.txt') || inDocuments, 'the file is in neither the bin nor Documents: list() removed its slot as "empty" just as it was moved in');
});

test('RB-P1-3: a restore that fails names the item, not its slot id', async () => {
  const fs = new FileSystem(new MemoryStore());
  const bin = new RecycleBin(fs);
  await fs.ensureFolder('/Documents');
  await fs.writeText('/Documents/a.txt', 'a');
  const { slots } = await bin.put(['/Documents/a.txt']);
  await bin.destroy(slots);
  // The toast's Undo after the item was deleted for good (or restored in another window).
  const { failures } = await bin.restore(slots);
  assert.equal(failures.length, 1);
  assert.ok(!failures[0].name.includes(slots[0]), `shown to the person as "${failures[0].name}: ${failures[0].reason}"`);
});

test('RB-P1-4: Empty deletes only what the person was told it would (not items binned after the question)', { todo: 'P1' }, async () => {
  const fs = new FileSystem(new MemoryStore());
  const bin = new RecycleBin(fs);
  await fs.ensureFolder('/Documents');
  await fs.writeText('/Documents/old.txt', 'old');
  await bin.put(['/Documents/old.txt']);
  const shown = await bin.list(); // "All 1 item in it will be deleted for good"
  await fs.writeText('/Documents/new.txt', 'new');
  await bin.put(['/Documents/new.txt']); // deleted in another window while the question is up
  await bin.empty();
  const left = (await bin.list()).map(i => i.name);
  assert.equal(shown.length, 1);
  assert.deepEqual(left, ['new.txt'], 'empty() lists the bin again and deletes the item the person was never asked about');
});

test('RB-P1-5: a restore whose origin is unknown is not reported as "the original folder is gone"', { todo: 'P1' }, async () => {
  const fs = new FileSystem(new MemoryStore());
  const bin = new RecycleBin(fs);
  await fs.ensureFolder('/Pictures');
  await fs.writeText('/Pictures/cat.png', 'png');
  const { slots } = await bin.put(['/Pictures/cat.png']);
  await fs.remove(['/System/trash.json']); // the list of origins lost: the slot remains
  const { restored } = await bin.restore(slots);
  // actions.ts says "The original folder of “cat.png” is gone"; /Pictures is still there, the origin was just not known.
  assert.equal(restored[0].fallback, true);
  assert.ok(await fs.exists('/Pictures'));
  assert.fail('restoreFromBin (actions.ts) tells the person the folder is gone; it should say the original place is not known');
});
