// Two windows (or devices) working on the same files at once: each is a FileSystem of its own over one store, as two
// tabs are over one server. Nothing either does may be lost, undone by the other, or land somewhere it was not meant to.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileSystem, FsError } from '../src/fs/fs.ts';
import { MemoryStore } from '../src/store/memory-store.ts';
import { StoreConflict } from '../src/store/store.ts';
import { recordFile } from '../src/shell/recordfile.ts';
import { RecycleBin, TRASH_DIR } from '../src/shell/trash.ts';
import { Session, SESSION_PATH } from '../src/shell/session.ts';
import { cleanName } from '../src/fs/names.ts';

const twoTabs = () => {
  const store = new MemoryStore();
  return { store, a: new FileSystem(store), b: new FileSystem(store) };
};

test('a save into a folder another window has just put in the Recycle Bin does not land in the bin', async () => {
  const { a, b } = twoTabs();
  await a.ensureFolder('/Documents/X');
  await a.writeText('/Documents/X/note.txt', 'first');
  // Tab A has the note open (its folders are remembered); tab B deletes the folder.
  assert.equal(await a.readText('/Documents/X/note.txt'), 'first');
  await new RecycleBin(b).put(['/Documents/X']);
  await assert.rejects(a.writeText('/Documents/X/note.txt', 'edited in A'), FsError);
  const slot = (await b.list(TRASH_DIR, true))[0].name;
  assert.equal(await b.readText(`${TRASH_DIR}/${slot}/X/note.txt`), 'first', 'the binned copy is as it was');
});

test('a save into a folder another window moved is refused, not made in the new place unseen', async () => {
  const { a, b } = twoTabs();
  await a.ensureFolder('/Documents/X');
  await a.ensureFolder('/Documents/Archive');
  await a.writeText('/Documents/X/note.txt', 'first');
  await a.readText('/Documents/X/note.txt');
  await b.move(['/Documents/X'], '/Documents/Archive');
  await assert.rejects(a.writeText('/Documents/X/note.txt', 'edited in A'), FsError);
  assert.equal(await b.readText('/Documents/Archive/X/note.txt'), 'first');
});

test('a commit with a check goes ahead only while the checked record is unchanged', async () => {
  const store = new MemoryStore();
  const v = await store.commit([{ op: 'put', key: '/', expect: '', data: new Uint8Array([1]) }]);
  await store.commit([{ op: 'check', key: '/', expect: v['/'] }]);
  await store.commit([{ op: 'put', key: '/', expect: v['/'], data: new Uint8Array([2]) }]);
  await assert.rejects(store.commit([{ op: 'check', key: '/', expect: v['/'] }]), StoreConflict);
});

test('two windows changing the calendar at once both keep their change', async () => {
  const { a, b } = twoTabs();
  await a.ensureFolder('/Documents');
  const parse = (t: string) => t.split('\n').filter(Boolean);
  const write = (l: string[]) => l.join('\n') + '\n';
  await a.writeText('/Documents/list.txt', 'one\n');
  const fa = recordFile(a, '/Documents/list.txt', parse, write);
  const fb = recordFile(b, '/Documents/list.txt', parse, write);
  await Promise.all([fa.change(l => [...l, 'from window 1']), fb.change(l => [...l, 'from window 2'])]);
  assert.deepEqual((await fa.load()).sort(), ['from window 1', 'from window 2', 'one']);
  // And when neither had the file yet.
  const na = recordFile(a, '/Documents/new.txt', parse, write);
  const nb = recordFile(b, '/Documents/new.txt', parse, write);
  await Promise.all([na.change(l => [...l, 'x']), nb.change(l => [...l, 'y'])]);
  assert.deepEqual((await na.load()).sort(), ['x', 'y']);
});

test('two deletes close together keep where each item came from', async () => {
  // Five windows, each deleting its own file at the same moment.
  const store = new MemoryStore();
  const tabs = Array.from({ length: 5 }, () => new FileSystem(store));
  await tabs[0].ensureFolder('/Documents/Work');
  const paths = tabs.map((_, i) => (i % 2 ? `/Documents/Work/f${i}.txt` : `/Documents/f${i}.txt`));
  for (const p of paths) await tabs[0].writeText(p, p);
  await Promise.all(tabs.map((fs, i) => new RecycleBin(fs).put([paths[i]])));
  const items = await new RecycleBin(tabs[0]).list();
  assert.deepEqual(items.map(i => i.from).sort(), [...paths].sort());
  assert.equal(await new RecycleBin(tabs[1]).count(), 5);
});

test('a tab that changed nothing never writes its settings over another tab\'s', async () => {
  const { a, b } = twoTabs();
  const sa = new Session(a);
  const sb = new Session(b);
  await sa.load();
  await sb.load();
  sa.data.lock = { ...sa.data.lock, lock: true, idle: 10 };
  sa.data.theme = 'dark';
  await sa.flush();
  // Tab B is hidden (it flushes) with nothing changed of its own.
  await sb.flush();
  let saved = JSON.parse(await a.readText(SESSION_PATH));
  assert.equal(saved.lock.lock, true);
  assert.equal(saved.theme, 'dark');
  // Tab B changes something else: only that is written, on top of A's.
  sb.data.aiHistoryDays = 7;
  await sb.flush();
  saved = JSON.parse(await a.readText(SESSION_PATH));
  assert.deepEqual([saved.lock.lock, saved.lock.idle, saved.theme, saved.aiHistoryDays], [true, 10, 'dark', 7]);
  // Both at once.
  sa.data.remindedUntil = 123;
  sb.data.pinned = ['notepad'];
  await Promise.all([sa.flush(), sb.flush()]);
  saved = JSON.parse(await a.readText(SESSION_PATH));
  assert.deepEqual([saved.remindedUntil, saved.pinned, saved.aiHistoryDays], [123, ['notepad'], 7]);
});

test('a name cut to fit is cut between whole characters, and a huge one quickly', () => {
  const name = cleanName(`abcd${'😀'.repeat(62)}.txt`);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(name), 'no half emoji');
  assert.ok(name.endsWith('.txt'));
  assert.ok(new TextEncoder().encode(name).length <= 255);
  const started = Date.now();
  const huge = cleanName(`${'x'.repeat(65000)}.pdf`);
  assert.ok(Date.now() - started < 1000, 'a 64 KB name takes under a second');
  assert.ok(huge.endsWith('.pdf') && new TextEncoder().encode(huge).length <= 255);
});
