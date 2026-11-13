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

test('two new pads saved at the same moment under one name both survive (F02)', async () => {
  const fs = new FileSystem(new MemoryStore());
  const [a, b] = await Promise.all([savePad(fs, 'same', 'one', null, day), savePad(fs, 'same', 'two', null, day)]);
  assert.notEqual(a, b);
  const texts = [await fs.readText(`${PAD_FOLDER}/${a}`), await fs.readText(`${PAD_FOLDER}/${b}`)].sort();
  assert.deepEqual(texts, ['one', 'two']);
});

test('a rename whose save fails leaves the old pad as it was (F03)', async () => {
  const fs = new FileSystem(new MemoryStore());
  const first = await savePad(fs, 'old', 'original', null, day);
  const write = fs.writeText.bind(fs);
  fs.writeText = async () => {
    throw new Error('disk full');
  };
  await assert.rejects(savePad(fs, 'renamed', 'edited', first, day), /disk full/);
  fs.writeText = write;
  assert.deepEqual((await listPads(fs)).map(p => p.name), ['old.txt']);
  assert.equal(await fs.readText(`${PAD_FOLDER}/old.txt`), 'original');
});
