// The queue that keeps two Saves from overlapping: the older one may not finish after the newer one.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serialQueue } from '../src/core/serial.ts';
import { FileSystem } from '../src/fs/fs.ts';
import { MemoryStore } from '../src/store/memory-store.ts';

test('a slow first job finishes before a quick second one starts', async () => {
  const queue = serialQueue();
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(r => (release = r));
  const first = queue(async () => { order.push('first start'); await gate; order.push('first end'); });
  const second = queue(async () => { order.push('second start'); order.push('second end'); });
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(order, ['first start'], 'the second waits');
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first start', 'first end', 'second start', 'second end']);
});

test('a failed job does not stop the next, and still reports its own error', async () => {
  const queue = serialQueue();
  const a = queue(async () => { throw new Error('boom'); });
  const b = queue(async () => 'fine');
  await assert.rejects(a, /boom/);
  assert.equal(await b, 'fine');
});

test('two overlapping saves of one file end with the newer text on disk', async () => {
  const fs = new FileSystem(new MemoryStore());
  await fs.ensureFolder('/Documents');
  const queue = serialQueue();
  const save = (text: string, delay: number) => queue(async () => { await new Promise(r => setTimeout(r, delay)); await fs.writeText('/Documents/a.txt', text); });
  await Promise.all([save('older', 40), save('newer', 0)]);
  assert.equal(await fs.readText('/Documents/a.txt'), 'newer');
});
