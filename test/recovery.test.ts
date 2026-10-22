// Recovery copies (src/shell/recovery.ts), shared by the spreadsheet, Write and Photo Editor: a copy and its
// note kept only while there are unsaved changes, not written again when nothing changed, gone once the work is
// saved or the window closed on purpose, and left behind by a page that stopped, to be offered by the next window
// (open or delete). The Windows program keeps none. A Write copy is a Word document that opens with its pictures.
// No browser needed. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecovery, type RecoveryOptions } from '../src/shell/recovery.ts';
import type { Shell } from '../src/shell/types.ts';
import { readDocx, writeDocx } from '../src/apps/write/docx.ts';
import { defaultPage, type NodeJSON } from '../src/apps/write/model.ts';
import { addPicture } from '../src/apps/write/images.ts';

/** A desktop's files in memory, with what the dialogs were asked and answered. */
function fakeShell(o: { answer?: 'open' | 'delete' | null; native?: boolean } = {}) {
  const files = new Map<string, { data: string | Uint8Array; modified: number }>();
  const folders = new Set<string>();
  const writes: string[] = [];
  const opened: string[] = [];
  const asked: string[] = [];
  const shell = {
    native: o.native ? { product: 'TOMLIN Sheets' } : undefined,
    fs: {
      ensureFolder: async (p: string) => void folders.add(p),
      writeText: async (p: string, text: string) => {
        writes.push(p);
        files.set(p, { data: text, modified: Date.now() });
      },
      writeFile: async (p: string, data: Uint8Array) => {
        writes.push(p);
        files.set(p, { data, modified: Date.now() });
      },
      readText: async (p: string) => {
        const f = files.get(p);
        if (!f) throw new Error('not there');
        return typeof f.data === 'string' ? f.data : new TextDecoder().decode(f.data);
      },
      list: async (folder: string) => {
        if (!folders.has(folder)) throw new Error('no folder');
        return [...files].filter(([p]) => p.startsWith(`${folder}/`) && !p.slice(folder.length + 1).includes('/'))
          .map(([p, f]) => ({ name: p.slice(folder.length + 1), kind: 'file', id: p, size: 1, modified: f.modified }));
      },
      remove: async (paths: string[]) => paths.forEach(p => files.delete(p)),
    },
    dialogs: {
      ask: async (q: { title: string; body?: unknown }) => {
        asked.push(q.title + ' | ' + textOf(q.body));
        return o.answer ?? null;
      },
      alert: async (title: string) => void asked.push(title),
    },
    openApp: async (_id: string, p: string) => void opened.push(p),
    report: async () => {},
  } as unknown as Shell;
  return { shell, files, folders, writes, opened, asked };
}

/** Just enough of a page for the offer's list: elements that keep their text. */
type FakeEl = { kids: unknown[]; setAttribute(): void; append(...k: unknown[]): void };
function textOf(n: unknown): string {
  if (typeof n === 'string') return n;
  if (n && typeof n === 'object' && 'kids' in n) return (n as FakeEl).kids.map(textOf).join(' ');
  return '';
}
function withPage<T>(run: () => Promise<T>): Promise<T> {
  const g = globalThis as { document?: unknown };
  g.document = {
    createElement: (): FakeEl => ({ kids: [], setAttribute() {}, append(...k: unknown[]) { this.kids.push(...k); } }),
    createTextNode: (t: string) => t,
  };
  return run().finally(() => delete g.document);
}

function app(over: Partial<RecoveryOptions> & { state: { unsaved: boolean; version: number; text: string } }): RecoveryOptions {
  const { state, ...rest } = over;
  return {
    appId: 'sheet', folder: '/System/sheet-recovery', ext: '.sheet',
    appName: 'The spreadsheet', one: 'spreadsheet', many: 'spreadsheets',
    unsaved: () => state.unsaved,
    token: () => state.version,
    snapshot: () => state.text,
    note: () => ({ label: 'Budget.xlsx', path: '/Documents/Budget.xlsx' }),
    ...rest,
  };
}

const copies = (files: Map<string, unknown>) => [...files.keys()].filter(p => p.endsWith('.sheet'));

test('a copy and its note are kept only while there are unsaved changes, and not written again when nothing changed', async () => {
  const { shell, files, writes } = fakeShell();
  const state = { unsaved: false, version: 1, text: '{"v":1}' };
  const life = new AbortController();
  const r = createRecovery(shell, life.signal, app({ state }));
  await r.keep();
  assert.equal(files.size, 0, 'nothing changed yet: nothing kept');
  state.unsaved = true;
  await r.keep();
  const [copy] = copies(files);
  assert.ok(copy?.startsWith('/System/sheet-recovery/'), 'kept in the app’s hidden folder');
  assert.equal(await shell.fs.readText(copy), '{"v":1}');
  assert.deepEqual(JSON.parse(await shell.fs.readText(copy.replace(/\.sheet$/, '.note.json'))), { label: 'Budget.xlsx', path: '/Documents/Budget.xlsx' });
  const n = writes.length;
  await r.keep();
  assert.equal(writes.length, n, 'unchanged: not written again');
  state.version = 2;
  state.text = '{"v":2}';
  await r.keep();
  assert.deepEqual(copies(files), [copy], 'the same copy, brought up to date');
  assert.equal(await shell.fs.readText(copy), '{"v":2}');
  life.abort();
});

test('saving drops the copy; so does closing the window on purpose', async () => {
  const { shell, files } = fakeShell();
  const state = { unsaved: true, version: 1, text: 'a' };
  const life = new AbortController();
  const r = createRecovery(shell, life.signal, app({ state }));
  await r.keep();
  assert.equal(files.size, 2);
  state.unsaved = false;
  await r.keep();
  assert.equal(files.size, 0, 'saved: the copy and its note are gone');
  state.unsaved = true;
  state.version = 2;
  await r.keep();
  assert.equal(files.size, 2);
  life.abort();
  await new Promise(done => setTimeout(done, 0));
  assert.equal(files.size, 0, 'closed on purpose: gone');
});

test('two keeps at once write one copy, one after the other', async () => {
  const { shell, files } = fakeShell();
  const state = { unsaved: true, version: 1, text: 'a' };
  const life = new AbortController();
  const r = createRecovery(shell, life.signal, app({ state }));
  await Promise.all([r.keep(), r.keep(), r.keep()]);
  assert.equal(copies(files).length, 1);
  life.abort();
});

test('a copy left behind by a page that stopped is offered by the next window; this window’s own is not', async () => {
  const { shell, files, folders, opened, asked } = fakeShell({ answer: 'open' });
  folders.add('/System/sheet-recovery');
  files.set('/System/sheet-recovery/old1.sheet', { data: '{}', modified: Date.UTC(2026, 9, 21, 9, 30) });
  files.set('/System/sheet-recovery/old1.note.json', { data: JSON.stringify({ label: 'Rota.sheet', path: null }), modified: 0 });
  const state = { unsaved: true, version: 1, text: 'mine' };
  const life = new AbortController();
  const r = createRecovery(shell, life.signal, app({ state }));
  await r.keep();
  let closed = false;
  await withPage(() => r.offer(false, { untouched: () => true, close: () => (closed = true) }));
  assert.equal(asked.length, 1);
  assert.match(asked[0], /^Spreadsheets not saved \| The spreadsheet stopped before this spreadsheet was saved/);
  assert.match(asked[0], /Rota\.sheet: kept/);
  assert.deepEqual(opened, ['/System/sheet-recovery/old1.sheet'], 'only the one left behind');
  assert.ok(closed, 'an untouched window makes way for it');
  life.abort();
});

test('Delete removes the copies and their notes; with none left, asking says so', async () => {
  const { shell, files, folders, asked } = fakeShell({ answer: 'delete' });
  folders.add('/System/sheet-recovery');
  files.set('/System/sheet-recovery/a.sheet', { data: '{}', modified: 1 });
  files.set('/System/sheet-recovery/a.note.json', { data: '{"label":"A"}', modified: 1 });
  const life = new AbortController();
  const r = createRecovery(shell, life.signal, app({ state: { unsaved: false, version: 0, text: '' } }));
  await withPage(() => r.offer(false));
  assert.equal(files.size, 0);
  await r.offer(true);
  assert.equal(asked.at(-1), 'Nothing to recover');
  life.abort();
});

test('a window that opens a copy takes it over: its note is read, and saving removes it', async () => {
  const { shell, files, folders } = fakeShell();
  folders.add('/System/sheet-recovery');
  files.set('/System/sheet-recovery/x.sheet', { data: '{}', modified: 1 });
  files.set('/System/sheet-recovery/x.note.json', { data: '{"label":"Rota.sheet","path":"/Documents/Rota.sheet"}', modified: 1 });
  const state = { unsaved: true, version: 1, text: 'later' };
  const life = new AbortController();
  const r = createRecovery(shell, life.signal, app({ state }));
  assert.ok(r.owns('/System/sheet-recovery/x.sheet'));
  assert.ok(!r.owns('/Documents/x.sheet'));
  assert.deepEqual(await r.adopt('/System/sheet-recovery/x.sheet'), { label: 'Rota.sheet', path: '/Documents/Rota.sheet' });
  await r.keep();
  assert.equal(await shell.fs.readText('/System/sheet-recovery/x.sheet'), 'later', 'kept into the copy it opened');
  r.drop();
  await new Promise(done => setTimeout(done, 0));
  assert.equal(files.size, 0);
  life.abort();
});

test('the Windows program keeps no copies, and says so when asked', async () => {
  const { shell, files, asked } = fakeShell({ native: true });
  const r = createRecovery(shell, new AbortController().signal, app({ state: { unsaved: true, version: 1, text: 'a' } }));
  await r.keep();
  assert.equal(files.size, 0);
  await r.offer(true);
  assert.deepEqual(asked, ['No recovery copies here']);
});

test('a Write copy is a Word document that opens again with its words, heading and picture', async () => {
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
  const id = addPicture(png)!;
  const doc: NodeJSON = {
    type: 'doc',
    content: [
      { type: 'paragraph', attrs: { style: 'h1' }, content: [{ type: 'text', text: 'Quote for Ann' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Two coats, ' }, { type: 'image', attrs: { src: id, width: 40, height: 40, alt: 'A dot' } }] },
    ],
  };
  const read = await readDocx(await writeDocx(doc, defaultPage(), 'Quote.docx'));
  assert.equal(read.doc.content?.[0].attrs?.style, 'h1');
  assert.equal(read.doc.content?.[0].content?.[0].text, 'Quote for Ann');
  assert.ok(JSON.stringify(read.doc).includes('"type":"image"'), 'the picture comes back');
  assert.deepEqual(read.dropped, []);
});
