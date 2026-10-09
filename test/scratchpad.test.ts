// The Panel's scratch pad (src/apps/panel/scratchpad.ts): names, saving, renaming, and never overwriting another pad.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileSystem } from '../src/fs/fs.ts';
import { MemoryStore } from '../src/store/memory-store.ts';
import { dayName, listPads, padFileName, padLabel, PAD_FOLDER, savePad } from '../src/apps/panel/scratchpad.ts';

const day = new Date(2026, 8, 27, 14, 30);

test('an unnamed pad is called by the day, day-month-year', () => {
  assert.equal(dayName(day), '27-09-2026');
  assert.equal(dayName(new Date(2026, 0, 5)), '05-01-2026');
  assert.equal(padFileName('', day), '27-09-2026.txt');
  assert.equal(padFileName('   ', day), '27-09-2026.txt');
  assert.equal(padFileName('Shopping list', day), 'Shopping list.txt');
  assert.equal(padFileName('ideas.txt', day), 'ideas.txt', 'no double .txt');
  assert.equal(padLabel('Shopping list.txt'), 'Shopping list');
});

test('saving writes a text file in Documents/Scratch pad; a new name renames it; another pad is never overwritten', async () => {
  const fs = new FileSystem(new MemoryStore());
  const first = await savePad(fs, '', 'first notes', null, day);
  assert.equal(first, '27-09-2026.txt');
  assert.equal(await fs.readText(`${PAD_FOLDER}/27-09-2026.txt`), 'first notes');

  // Same pad, renamed: the old file goes, not left behind.
  const renamed = await savePad(fs, 'Garden jobs', 'first notes, edited', first, day);
  assert.equal(renamed, 'Garden jobs.txt');
  assert.deepEqual((await listPads(fs)).map(p => p.name), ['Garden jobs.txt']);

  // A second new pad on the same day does not overwrite the first one of that name.
  await savePad(fs, '', 'second', null, day);
  const third = await savePad(fs, '', 'third', null, day);
  assert.equal(third, '27-09-2026 (2).txt');
  assert.equal(await fs.readText(`${PAD_FOLDER}/27-09-2026.txt`), 'second');
  assert.equal((await listPads(fs)).length, 3);
});

test('no folder yet: no pads, and no error', async () => {
  assert.deepEqual(await listPads(new FileSystem(new MemoryStore())), []);
});
