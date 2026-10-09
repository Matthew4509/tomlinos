// The file layer over an in-memory store: names, every change, clashes between two windows, nothing left behind.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileSystem, FsError } from '../src/fs/fs.ts';
import { MemoryStore } from '../src/store/memory-store.ts';
import { cleanName, nameProblem, uniqueName } from '../src/fs/names.ts';
import { encodeCommit } from '../src/store/server-store.ts';
import { StoreConflict, type Store, type StoreOp } from '../src/store/store.ts';

const bytes = (s: string) => new TextEncoder().encode(s);
const names = async (fs: FileSystem, path: string) => (await fs.list(path)).map(e => e.name).sort();

test('a new store gets the standard folders, with System hidden', async () => {
  const fs = new FileSystem(new MemoryStore());
  assert.deepEqual(await names(fs, '/'), ['Desktop', 'Documents', 'Music', 'Pictures', 'Videos']);
  assert.ok((await fs.list('/', true)).some(e => e.name === 'System' && e.hidden));
});

test('write, read, overwrite and list a file', async () => {
  const store = new MemoryStore();
  const fs = new FileSystem(store);
  await fs.writeText('/Documents/a.txt', 'one');
  const before = store.size;
  await fs.writeText('/Documents/a.txt', 'two, longer');
  assert.equal(await fs.readText('/Documents/a.txt'), 'two, longer');
  assert.equal(store.size, before, 'overwriting must not leave the old bytes behind');
  const [entry] = await fs.list('/Documents');
  assert.equal(entry.size, 11);
});

test('names differing only in letter case clash', async () => {
  const fs = new FileSystem(new MemoryStore());
  await fs.mkdir('/Documents/Letters');
  await assert.rejects(fs.mkdir('/Documents/letters'), FsError);
  await fs.writeText('/Documents/Letters/x.txt', '1');
  await fs.writeText('/Documents/letters/X.TXT', '2');
  assert.deepEqual(await names(fs, '/Documents/Letters'), ['x.txt'], 'saving under another case replaces, keeping the name');
});

test('bad names are refused with a reason; uploaded names are cleaned', async () => {
  for (const bad of ['', ' a', 'a ', '..', 'a/b', 'a\\b', 'a:b', 'x.', 'a\u0000b', 'photo\u202egnp.exe', 'x'.repeat(256)]) {
    assert.ok(nameProblem(bad), `"${bad}" should be refused`);
  }
  assert.equal(nameProblem('Report (final) — été.txt'), null);
  assert.equal(cleanName('a/b:c?.txt'), 'a_b_c_.txt');
  assert.equal(cleanName('photo\u202egnp.exe'), 'photognp.exe');
  assert.equal(cleanName('..'), 'Untitled');
  assert.ok(new TextEncoder().encode(cleanName('é'.repeat(300) + '.txt')).length <= 255);
  assert.ok(cleanName('é'.repeat(300) + '.txt').endsWith('.txt'));
  assert.equal(uniqueName('a.txt', ['A.txt', 'a (2).txt']), 'a (3).txt');
});

test('paths with . or .. are refused', async () => {
  const fs = new FileSystem(new MemoryStore());
  await assert.rejects(fs.writeText('/Documents/../x.txt', 'x'));
  await assert.rejects(fs.list('/Documents/..'));
});

test('rename, move, copy and delete', async () => {
  const store = new MemoryStore();
  const fs = new FileSystem(store);
  const empty = (await fs.list('/'), store.size);
  await fs.mkdir('/Documents/A');
  await fs.writeText('/Documents/A/one.txt', '1');
  await fs.mkdir('/Documents/A/Inner');
  await fs.writeText('/Documents/A/Inner/two.txt', '2');
  await fs.rename('/Documents/A', 'B');
  assert.deepEqual(await names(fs, '/Documents'), ['B']);
  await fs.move(['/Documents/B'], '/Pictures');
  assert.deepEqual(await names(fs, '/Documents'), []);
  assert.equal(await fs.readText('/Pictures/B/Inner/two.txt'), '2');
  await fs.copy(['/Pictures/B'], '/Pictures');
  assert.deepEqual(await names(fs, '/Pictures'), ['B', 'B (2)']);
  await fs.writeText('/Pictures/B (2)/Inner/two.txt', 'changed');
  assert.equal(await fs.readText('/Pictures/B/Inner/two.txt'), '2', 'a copy must not share records with the original');
  await assert.rejects(fs.move(['/Pictures/B'], '/Pictures/B/Inner'), /into itself/);
  await fs.remove(['/Pictures/B', '/Pictures/B/Inner', '/Pictures/B (2)']);
  assert.deepEqual(await names(fs, '/Pictures'), []);
  assert.equal(store.size, empty, 'deleting must remove every record inside');
});

test('a move that would clash moves nothing', async () => {
  const fs = new FileSystem(new MemoryStore());
  await fs.writeText('/Documents/a.txt', 'doc');
  await fs.writeText('/Documents/b.txt', 'doc');
  await fs.writeText('/Pictures/b.txt', 'pic');
  await assert.rejects(fs.move(['/Documents/a.txt', '/Documents/b.txt'], '/Pictures'), /Nothing was moved/);
  assert.deepEqual(await names(fs, '/Documents'), ['a.txt', 'b.txt']);
  assert.deepEqual(await names(fs, '/Pictures'), ['b.txt']);
});

test('two windows changing the same folder both keep their changes', async () => {
  const store = new MemoryStore();
  const one = new FileSystem(store);
  const two = new FileSystem(store);
  await one.list('/Documents');
  await two.list('/Documents');
  await one.writeText('/Documents/from-one.txt', '1');
  await two.writeText('/Documents/from-two.txt', '2'); // two's copy of Documents is stale: must retry, not overwrite
  assert.deepEqual(await names(one, '/Documents'), ['from-one.txt', 'from-two.txt']);
});

test('a second window that renames to a name the first just took is refused, not merged', async () => {
  const store = new MemoryStore();
  const one = new FileSystem(store);
  const two = new FileSystem(store);
  await one.writeText('/Documents/a.txt', 'a');
  await two.list('/Documents');
  await one.writeText('/Documents/b.txt', 'b');
  await assert.rejects(two.rename('/Documents/a.txt', 'b.txt'), /already something called/);
});

test('a store that always clashes gives up after three tries with a clear message', async () => {
  const inner = new MemoryStore();
  let commits = 0;
  const store: Store = {
    label: 'test',
    get: k => inner.get(k),
    async commit(ops: StoreOp[]) {
      if (ops.some(o => o.key !== '/' && o.op === 'put' && o.expect !== '')) {
        commits++;
        throw new StoreConflict([]);
      }
      return inner.commit(ops);
    },
  };
  const fs = new FileSystem(store);
  await assert.rejects(fs.writeText('/Documents/a.txt', 'x'), /kept changing/);
  assert.equal(commits, 3);
});

test('the commit body matches what server/lib/store.php parses', () => {
  const body = encodeCommit([
    { op: 'put', key: '/', expect: '', data: bytes('hi') },
    { op: 'del', key: '12345678-1234-4234-8234-123456789012', expect: '*' },
  ]);
  const expected = [1, 1, 0, 47, 0, 2, 0, 0, 0, 104, 105, 2, 36, 0, ...bytes('12345678-1234-4234-8234-123456789012'), 1, 42];
  assert.deepEqual([...body], expected);
});
