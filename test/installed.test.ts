// The store apps a person has added to their desktop (src/shell/installed.ts): only names that can be store apps are kept,
// a damaged list means none, and the list lives in that person's own files.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileSystem } from '../src/fs/fs.ts';
import { MemoryStore } from '../src/store/memory-store.ts';
import { cleanInstalled, INSTALLED_PATH, isStoreId, readInstalled, writeInstalled } from '../src/shell/installed.ts';

test('a store app name is lower-case letters and digits, as the server checks it', () => {
  assert.ok(isStoreId('officeprinter'));
  for (const bad of ['', 'a', 'Office', 'office-printer', '../x', '1game', 7, null]) assert.ok(!isStoreId(bad), String(bad));
});

test('only possible store app names are kept, once each; anything else in the file is ignored', () => {
  assert.deepEqual(cleanInstalled({ installed: ['officeprinter', 'officeprinter', '../etc', 'Bad', 7, null, 'chess2'] }), ['officeprinter', 'chess2']);
  assert.deepEqual(cleanInstalled({ installed: 'officeprinter' }), []);
  assert.deepEqual(cleanInstalled(null), []);
  assert.deepEqual(cleanInstalled([]), []);
});

test('the list is written to and read back from the person\'s files; a missing or damaged file means none', async () => {
  const fs = new FileSystem(new MemoryStore());
  assert.deepEqual(await readInstalled(fs), []);
  await writeInstalled(fs, ['officeprinter', 'no-good']);
  assert.deepEqual(JSON.parse(await fs.readText(INSTALLED_PATH)), { installed: ['officeprinter'] });
  assert.deepEqual(await readInstalled(fs), ['officeprinter']);
  await fs.writeText(INSTALLED_PATH, '{not json', { hidden: true });
  assert.deepEqual(await readInstalled(fs), []);
  await writeInstalled(fs, []);
  assert.deepEqual(await readInstalled(fs), []);
});
