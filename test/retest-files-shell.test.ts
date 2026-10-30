// A second look at files and the shell (October 2026 retest): names, the file layer, the Recycle Bin, settings shared
// between tabs, recovery copies, reminders, search, app shortcuts, the encrypted store and the zip reader. Each test
// here was written to catch a fault read in the code; one that fails points at that fault (see the test's words).
// No browser needed. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FileSystem, FsError } from '../src/fs/fs.ts';
import { cleanName, nameProblem, uniqueName } from '../src/fs/names.ts';
import { MemoryStore } from '../src/store/memory-store.ts';
import { StoreError } from '../src/store/store.ts';
import { EncryptedStore } from '../src/store/encrypted-store.ts';
import type { ServerStore } from '../src/store/server-store.ts';
import { RecycleBin } from '../src/shell/trash.ts';
import { FileActions } from '../src/shell/actions.ts';
import { Session, SESSION_PATH } from '../src/shell/session.ts';
import { dueReminders } from '../src/shell/reminders.ts';
import { readInstalled, writeInstalled } from '../src/shell/installed.ts';
import { matchesAll, searchWords, snippetOf } from '../src/shell/search.ts';
import { addToDesktop } from '../src/shell/appshortcut.ts';
import { planUpload } from '../src/shell/transfer.ts';
import { bookFileName } from '../src/apps/reader.ts';
import { readZip, ArchiveError } from '../src/apps/archive/read.ts';
import { zipStore } from '../src/core/zip.ts';
import type { Shell } from '../src/shell/types.ts';
import type { CalEvent } from '../src/core/ical.ts';

const names = async (fs: FileSystem, path: string) => (await fs.list(path, true)).map(e => e.name).sort();

// ---- Names ----------------------------------------------------------------------------------------------------------

test('cleanName ("makes any name usable") always gives a name nameProblem accepts', () => {
  // Two direction-flipping marks (only the first was removed), a name ending " ." (trim, then the dot, uncovers the
  // space), and long names whose cut lands on a space or a dot.
  for (const raw of ['a‮b‮c.txt', 'notes .', 'x'.repeat(254) + ' ' + 'y'.repeat(10), 'x'.repeat(254) + '.' + 'y'.repeat(12)]) {
    const clean = cleanName(raw);
    assert.equal(nameProblem(clean), null, `cleanName(${JSON.stringify(raw.slice(0, 20))}…) gave ${JSON.stringify(clean.slice(-10))}`);
  }
});

test('an uploaded file called "notes ." gets a usable name', () => {
  const plan = planUpload([], [{ kind: 'file', parts: ['notes .'] }]);
  const parts = plan.files[0].parts;
  assert.equal(nameProblem(parts[parts.length - 1]), null, `planned as ${JSON.stringify(parts)}`);
});

test('uniqueName never makes a name longer than the 255-byte limit', () => {
  const long = 'a'.repeat(251) + '.txt';
  assert.equal(nameProblem(long), null, 'the name itself is fine');
  const next = uniqueName(long, [long]);
  assert.equal(nameProblem(next), null, `"${next.slice(-12)}" is ${new TextEncoder().encode(next).length} bytes`);
});

test('copying a file with the longest allowed name into its own folder gives a copy that can still be saved over', async () => {
  const fs = new FileSystem(new MemoryStore());
  const long = 'a'.repeat(251) + '.txt';
  await fs.writeText(`/Documents/${long}`, 'x');
  const [copy] = await fs.copy([`/Documents/${long}`], '/Documents');
  assert.equal(nameProblem(copy.name), null, 'the copy has a name the file layer accepts');
  await fs.writeText(`/Documents/${copy.name}`, 'changed');
});

test('names Windows refuses (CON, nul.txt) and invisible names are refused here too', () => {
  for (const bad of ['CON', 'nul.txt', 'COM1.log', '​', 'a\u0085b', 'a b']) {
    assert.notEqual(nameProblem(bad), null, `${JSON.stringify(bad)} should be refused`);
  }
});

test("the Reader's book file name is always one the file layer accepts", () => {
  for (const [title, author] of [['漢'.repeat(120), 'X'], ['a‏b', 'c'], ['Tale‮end', 'Z']]) {
    const name = bookFileName(title, author);
    assert.equal(nameProblem(name), null, `${JSON.stringify(title.slice(0, 10))}: ${JSON.stringify(name.slice(0, 20))}`);
  }
});

// ---- The file layer ---------------------------------------------------------------------------------------------------

test('deleting the same file named twice in different letter case deletes it (not nothing)', async () => {
  const fs = new FileSystem(new MemoryStore());
  await fs.writeText('/Documents/x.txt', '1');
  await fs.remove(['/Documents/x.txt', '/documents/X.txt']);
  assert.equal(await fs.exists('/Documents/x.txt'), false);
});

test('moving the same file named twice (NFC and NFD spelling) moves it', async () => {
  const fs = new FileSystem(new MemoryStore());
  await fs.mkdir('/Documents/Out');
  await fs.writeText('/Documents/café.txt', '1');
  const moved = await fs.move(['/Documents/café.txt', '/Documents/café.txt'], '/Documents/Out');
  assert.equal(moved.length, 1);
  assert.deepEqual(await names(fs, '/Documents/Out'), ['café.txt']);
});

test('a save into a folder another window deleted and made again goes through (fresh copies, not "not there any more")', async () => {
  const store = new MemoryStore();
  const a = new FileSystem(store);
  const b = new FileSystem(store);
  await a.list('/');
  await b.remove(['/Documents']);
  await b.mkdir('/Documents');
  await a.writeText('/Documents/a.txt', 'x');
  assert.equal(await b.readText('/Documents/a.txt'), 'x');
});

test('a folder whose record went missing (what store-check calls "missing") can still be deleted', async () => {
  const store = new MemoryStore();
  const fs = new FileSystem(store);
  await fs.mkdir('/Documents/X');
  const id = (await fs.stat('/Documents/X'))!.id;
  await store.commit([{ op: 'del', key: id, expect: '*' }]);
  const fs2 = new FileSystem(store);
  await fs2.remove(['/Documents/X']);
  assert.equal(await fs2.exists('/Documents/X'), false);
});

test('ensureFolder refuses a path where a file already stands', async () => {
  const fs = new FileSystem(new MemoryStore());
  await fs.writeText('/Documents/f', 'x');
  await assert.rejects(fs.ensureFolder('/Documents/f'), FsError);
});

// ---- The Recycle Bin ---------------------------------------------------------------------------------------------------

/** A store whose next read of one key fails once, as a network blip does. */
class Flaky extends MemoryStore {
  failOnce = '';
  override async get(key: string) {
    if (key === this.failOnce) {
      this.failOnce = '';
      throw new StoreError('The server could not be reached.');
    }
    return super.get(key);
  }
}

test('one failed read of the bin\'s list does not wipe where every other item came from', async () => {
  const store = new Flaky();
  const fs = new FileSystem(store);
  const bin = new RecycleBin(fs);
  await fs.writeText('/Documents/a.txt', '1');
  await fs.writeText('/Documents/b.txt', '2');
  await bin.put(['/Documents/a.txt']);
  store.failOnce = (await fs.stat('/System/trash.json'))!.id;
  await bin.put(['/Documents/b.txt']).catch(() => {});
  const a = (await bin.list()).find(i => i.name === 'a.txt');
  assert.equal(a?.from, '/Documents/a.txt', 'a.txt still knows where it was deleted from');
});

test('restoring a file and the folder it was in together puts the file back inside the folder', async () => {
  const fs = new FileSystem(new MemoryStore());
  const bin = new RecycleBin(fs);
  await fs.mkdir('/Documents/A');
  await fs.writeText('/Documents/A/b.txt', '1');
  const s1 = (await bin.put(['/Documents/A/b.txt'])).slots[0];
  const s2 = (await bin.put(['/Documents/A'])).slots[0];
  const { restored, failures } = await bin.restore([s1, s2]);
  assert.equal(failures.length, 0);
  assert.ok(restored.every(r => !r.fallback), `nothing went to Documents instead: ${JSON.stringify(restored)}`);
  assert.equal(await fs.exists('/Documents/A/b.txt'), true);
});

test('restoring a file with the longest allowed name over a new one with the same name works', async () => {
  const fs = new FileSystem(new MemoryStore());
  const bin = new RecycleBin(fs);
  const long = 'a'.repeat(251) + '.txt';
  await fs.writeText(`/Documents/${long}`, 'old');
  const { slots } = await bin.put([`/Documents/${long}`]);
  await fs.writeText(`/Documents/${long}`, 'new');
  const { failures } = await bin.restore(slots);
  assert.deepEqual(failures, []);
  assert.equal((await names(fs, '/Documents')).length, 2);
});

test('moving a file onto a folder that has its name works even when the source folder already has "name (2)"', async () => {
  const fs = new FileSystem(new MemoryStore());
  const alerts: string[] = [];
  const shell = { fs, dialogs: { alert: async (_t: string, text: string) => void alerts.push(text) } } as unknown as Shell;
  await fs.mkdir('/Documents/A');
  await fs.mkdir('/Documents/B');
  await fs.writeText('/Documents/A/a.txt', '1');
  await fs.writeText('/Documents/A/a (2).txt', '2');
  await fs.writeText('/Documents/B/a.txt', '3');
  await new FileActions(shell).moveInto(['/Documents/A/a.txt'], '/Documents/B');
  assert.deepEqual(alerts, []);
  assert.deepEqual(await names(fs, '/Documents/B'), ['a (2).txt', 'a.txt']);
});

// ---- Settings shared between tabs ---------------------------------------------------------------------------------------

test('two tabs changing different lock settings keep both changes', async () => {
  const store = new MemoryStore();
  const a = new FileSystem(store);
  const b = new FileSystem(store);
  const sa = new Session(a);
  const sb = new Session(b);
  await sa.load();
  await sb.load();
  sa.data.lock.panic = true;
  await sa.flush();
  sb.data.lock.idle = 5;
  await sb.flush();
  const saved = JSON.parse(await a.readText(SESSION_PATH));
  assert.equal(saved.lock.idle, 5);
  assert.equal(saved.lock.panic, true, 'tab A\'s "Escape twice: panic" survived tab B\'s change of the idle minutes');
});

test('two tabs adding different store apps keep both', async () => {
  const store = new MemoryStore();
  const a = new FileSystem(store);
  const b = new FileSystem(store);
  const ra = await readInstalled(a, true);
  const rb = await readInstalled(b, true);
  await writeInstalled(a, [...ra, 'foo']);
  let second: unknown = null;
  try {
    await writeInstalled(b, [...rb, 'bar']);
  } catch (error) {
    second = error;
  }
  const now = await readInstalled(a);
  assert.ok(now.includes('foo') || second !== null, `foo was lost silently: ${JSON.stringify(now)}`);
});

// ---- Reminders --------------------------------------------------------------------------------------------------------

test('a reminder set two days ahead (as a calendar file may say) fires', () => {
  const now = new Date(2026, 9, 29, 10, 0).getTime();
  const event: CalEvent = { uid: 'x', title: 'Dentist', date: '2026-10-31', start: '10:00', end: '11:00', notes: '', repeat: 'none', remind: 2880 };
  const due = dueReminders([event], now, now - 60000);
  assert.equal(due.length, 1, 'due two days before, at the same time of day');
});

// ---- Search ----------------------------------------------------------------------------------------------------------

test('search finds a name typed in the other Unicode spelling, and shows a snippet after a Turkish İ', () => {
  assert.ok(matchesAll('Café.txt', searchWords('café')), 'é typed two ways is the same name (names.ts says so)');
  const snippet = snippetOf('İ'.repeat(60) + '\nfoo bar', ['bar']);
  assert.ok(snippet.includes('bar'), `snippet was ${JSON.stringify(snippet)}`);
});

// ---- App shortcuts -------------------------------------------------------------------------------------------------------

test('"Add to desktop" works for a store app whose title holds a character a file name cannot', async () => {
  const fs = new FileSystem(new MemoryStore());
  const reports: unknown[] = [];
  const shell = {
    apps: () => [{ id: 'qa', title: 'Q&A: Notes', icon: 'app' }],
    fs,
    toast() {},
    report: async (_t: string, e: unknown) => void reports.push(e),
  } as unknown as Shell;
  await addToDesktop(shell, 'qa');
  assert.deepEqual(reports, []);
  assert.ok((await names(fs, '/Desktop')).some(n => n.endsWith('.desktop')), 'a shortcut file was made');
});

// ---- Recovery copies in two tabs ------------------------------------------------------------------------------------------

test('a recovery copy another tab is still keeping is not offered as left behind, so Delete cannot destroy it', async () => {
  // Two copies of the module stand in for two tabs: each has its own "copies this page keeps" list.
  const tabA = await import('../src/shell/recovery.ts');
  const tabB = (await import(('../src/shell/recovery.ts' + '?tab=2') as string)) as typeof tabA;
  const fs = new FileSystem(new MemoryStore());
  const asked: string[] = [];
  const shell = {
    fs,
    dialogs: { ask: async (q: { title: string }) => (asked.push(q.title), 'delete'), alert: async () => {} },
    openApp: async () => {},
    report: async () => {},
  } as unknown as Shell;
  const g = globalThis as { document?: unknown };
  g.document = {
    createElement: () => ({ kids: [] as unknown[], setAttribute() {}, append(...k: unknown[]) { (this as any).kids.push(...k); } }),
    createTextNode: (t: string) => t,
    addEventListener() {},
    visibilityState: 'visible',
  };
  const stopA = new AbortController();
  const stopB = new AbortController();
  try {
    const opts = {
      appId: 'sheet', folder: '/System/sheet-recovery', ext: '.sheet', appName: 'The spreadsheet', one: 'spreadsheet', many: 'spreadsheets',
      unsaved: () => true, token: () => 1, snapshot: () => 'work', note: () => ({ label: 'Budget', path: null }),
    };
    const a = tabA.createRecovery(shell, stopA.signal, opts);
    await a.keep();
    const kept = (await fs.list('/System/sheet-recovery', true)).filter(e => e.name.endsWith('.sheet'));
    assert.equal(kept.length, 1, 'tab A kept a copy');
    const b = tabB.createRecovery(shell, stopB.signal, opts);
    await b.offer(false);
    const after = (await fs.list('/System/sheet-recovery', true)).filter(e => e.name.endsWith('.sheet'));
    assert.equal(after.length, 1, `tab A's live copy must survive tab B's offer (asked: ${asked.join('; ') || 'nothing'})`);
  } finally {
    // Tab B's window closing drops only its own copy; aborting A last would drop A's copy on purpose, so B first.
    stopB.abort();
    delete g.document;
    // A's timer must not keep the test process alive; its drop() then removes the copy it kept, which is fine here.
    stopA.abort();
  }
});

// ---- The encrypted store --------------------------------------------------------------------------------------------------

test('with encryption off, a plain file that happens to start with the seal marker still opens', async () => {
  const inner = new MemoryStore();
  const key = crypto.randomUUID();
  const data = new Uint8Array(48);
  data.set([0x00, 0x4d, 0x59, 0x49, 0x45, 0x4e, 0x43, 0x01]);
  await inner.commit([{ op: 'put', key, expect: '', data }]);
  const es = new EncryptedStore(inner as unknown as ServerStore);
  const got = await es.get(key);
  assert.deepEqual(got?.data, data);
});

// ---- The zip reader ---------------------------------------------------------------------------------------------------------

test('a zip entry whose bytes were damaged (CRC wrong) is refused, not extracted silently', async () => {
  const z = zipStore([{ name: 'a.txt', data: new TextEncoder().encode('hello'), modified: 0 }]);
  z[30 + 5] ^= 0xff; // the data starts after the 30-byte local header and the 5-byte name
  const [entry] = readZip(z);
  await assert.rejects(entry.read(), ArchiveError);
});

test('a zip from an older Windows tool names its files in the old code page (CP437), and "Köln" comes out as Köln', () => {
  const z = zipStore([{ name: 'K_ln.txt', data: new TextEncoder().encode('x'), modified: 0 }]);
  const idx = (from: number) => z.indexOf('_'.charCodeAt(0), from);
  const local = idx(0);
  z[local] = 0x94; // ö in CP437
  z[idx(local + 1)] = 0x94;
  // Clear the "names are UTF-8" flag (bit 11) in both headers.
  z[6] &= ~0x08;
  const cd = z.findIndex((_, i) => z[i] === 0x50 && z[i + 1] === 0x4b && z[i + 2] === 1 && z[i + 3] === 2);
  z[cd + 9] &= ~0x08;
  const [entry] = readZip(z);
  assert.equal(entry.parts[0], 'Köln.txt');
});

test('a file made before names were checked ("nul.txt") can still be saved in place, but no new file can take that name', async () => {
  const store = new MemoryStore();
  const fs = new FileSystem(store);
  await fs.writeText('/Documents/old.txt', 'first');
  // As it was left by an earlier version: the name is already in the folder's own list.
  const folder = (await fs.stat('/Documents'))!;
  const record = (await store.get(folder.id))!;
  const list = JSON.parse(new TextDecoder().decode(record.data));
  list.entries[0].name = 'nul.txt';
  await store.commit([{ op: 'put', key: folder.id, expect: record.version, data: new TextEncoder().encode(JSON.stringify(list)) }]);
  const fresh = new FileSystem(store);
  assert.equal(await fresh.readText('/Documents/nul.txt'), 'first');
  await fresh.writeText('/Documents/nul.txt', 'second');
  assert.equal(await fresh.readText('/Documents/nul.txt'), 'second');
  await assert.rejects(fresh.writeText('/Documents/con.txt', 'x'), 'a new file cannot have a name Windows refuses');
  await assert.rejects(fresh.writeText('/Pictures/nul.txt', 'x'), 'nor can that name be used in another folder');
});
