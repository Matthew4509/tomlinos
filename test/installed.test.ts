// The store apps a person has added to their desktop (src/shell/installed.ts): only names that can be store apps are kept,
// a damaged list means none, and the list lives in that person's own files.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileSystem } from '../src/fs/fs.ts';
import { MemoryStore } from '../src/store/memory-store.ts';
import { cleanInstalled, INSTALLED_PATH, isStoreId, readInstalled, writeInstalled } from '../src/shell/installed.ts';
import { NO_PREFS, readPrefs, writePrefs } from '../src/apps/assistant/prefs.ts';
import { Session, SESSION_PATH } from '../src/shell/session.ts';
import { StoreError, type Store } from '../src/store/store.ts';

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

// ---- A list that is there but cannot be read is never replaced --------------------------------

/** A file system whose server stops answering once `down` is set. */
function flaky(): { fs: FileSystem; down: () => void } {
  const inner = new MemoryStore();
  let off = false;
  const store: Store = { label: 'test', get: k => (off ? Promise.reject(new StoreError('The server could not be reached.')) : inner.get(k)), commit: ops => inner.commit(ops) };
  return { fs: new FileSystem(store), down: () => (off = true) };
}

test('reading strictly (before a change) throws when the list is there but cannot be read; for showing it reads as none', async () => {
  const { fs, down } = flaky();
  await writeInstalled(fs, ['officeprinter', 'chess2']);
  down();
  assert.deepEqual(await readInstalled(fs), [], 'shown as none for now');
  await assert.rejects(readInstalled(fs, true), StoreError);
  const fresh = new FileSystem(new MemoryStore());
  assert.deepEqual(await readInstalled(fresh, true), [], 'none yet is not an error');
  await fresh.writeText(INSTALLED_PATH, '{not json', { hidden: true });
  assert.deepEqual(await readInstalled(fresh, true), [], 'a damaged list may be replaced');
});

test('AI choices: a strict read throws when they cannot be read, so a change is not saved over them', async () => {
  const { fs, down } = flaky();
  await writePrefs(fs, { ...NO_PREFS, favourites: ['qwen'], hidden: [] });
  down();
  assert.deepEqual((await readPrefs(fs)).favourites, [], 'shown as the defaults for now');
  await assert.rejects(readPrefs(fs, true), StoreError);
});

test('desktop settings that could not be read are never saved over: the person is told instead', async () => {
  const inner = new MemoryStore();
  const fs = new FileSystem(inner);
  await fs.ensureFolder('/System', { hidden: true });
  await fs.writeText(SESSION_PATH, JSON.stringify({ theme: 'dark' }), { hidden: true });
  let off = true;
  const store: Store = { label: 'test', get: k => (off ? Promise.reject(new StoreError('The server could not be reached.')) : inner.get(k)), commit: ops => inner.commit(ops) };
  const session = new Session(new FileSystem(store));
  const told: string[] = [];
  session.onSaveError = e => told.push(String((e as Error).message));
  await session.load();
  off = false;
  session.data.theme = 'xfce';
  await session.flush();
  assert.equal(JSON.parse(await fs.readText(SESSION_PATH)).theme, 'dark', 'the real settings are untouched');
  assert.equal(told.length, 1);
  assert.match(told[0], /could not be read .*not kept/);
});
