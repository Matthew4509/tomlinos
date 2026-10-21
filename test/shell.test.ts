// The parts of the shell that need no browser: the Recycle Bin (over an in-memory store), the saved-session
// checks, the icon layout, and a scan of the source for the things the desktop must never do.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { FileSystem } from '../src/fs/fs.ts';
import { MemoryStore } from '../src/store/memory-store.ts';
import { protectedReason } from '../src/shell/actions.ts';
import { allocate, cellAt } from '../src/shell/layout.ts';
import { MAX_VIEWS, parseSession, DEFAULT_COLOUR } from '../src/shell/session.ts';
import { purgeCutoff, RecycleBin } from '../src/shell/trash.ts';
import { FileActions } from '../src/shell/actions.ts';
import { defaultSession } from '../src/shell/session.ts';

const names = async (fs: FileSystem, path: string) => (await fs.list(path)).map(e => e.name).sort();

test('deleting to the bin removes the item from its folder but keeps every byte', async () => {
  const store = new MemoryStore();
  const fs = new FileSystem(store);
  const bin = new RecycleBin(fs);
  await fs.writeText('/Documents/a.txt', 'precious');
  const { slots, failures } = await bin.put(['/Documents/a.txt']);
  assert.equal(failures.length, 0);
  assert.equal(slots.length, 1);
  assert.deepEqual(await names(fs, '/Documents'), []);
  const items = await bin.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'a.txt');
  assert.equal(items[0].from, '/Documents/a.txt');
  assert.equal(await fs.readText(`/System/Trash/${items[0].slot}/a.txt`), 'precious');
});

test('restore puts it back where it was; a taken name gets a number, never a replacement', async () => {
  const fs = new FileSystem(new MemoryStore());
  const bin = new RecycleBin(fs);
  await fs.writeText('/Documents/a.txt', 'old');
  const first = await bin.put(['/Documents/a.txt']);
  await fs.writeText('/Documents/a.txt', 'new');
  const { restored, failures } = await bin.restore(first.slots);
  assert.equal(failures.length, 0);
  assert.equal(restored[0].name, 'a (2).txt');
  assert.equal(await fs.readText('/Documents/a.txt'), 'new', 'the file that was there is untouched');
  assert.equal(await fs.readText('/Documents/a (2).txt'), 'old');
  assert.equal((await bin.list()).length, 0);
});

test('restore goes to Documents when the original folder is gone, and says so', async () => {
  const fs = new FileSystem(new MemoryStore());
  const bin = new RecycleBin(fs);
  await fs.mkdir('/Desktop/Gone');
  await fs.writeText('/Desktop/Gone/b.txt', 'b');
  const { slots } = await bin.put(['/Desktop/Gone/b.txt']);
  await fs.remove(['/Desktop/Gone']);
  const { restored } = await bin.restore(slots);
  assert.equal(restored[0].to, '/Documents');
  assert.equal(restored[0].fallback, true);
  assert.equal(await fs.readText('/Documents/b.txt'), 'b');
});

test('a whole folder goes to the bin and comes back with everything inside', async () => {
  const fs = new FileSystem(new MemoryStore());
  const bin = new RecycleBin(fs);
  await fs.mkdir('/Documents/Trip');
  await fs.writeText('/Documents/Trip/one.txt', '1');
  await fs.mkdir('/Documents/Trip/Deep');
  await fs.writeText('/Documents/Trip/Deep/two.txt', '2');
  const { slots } = await bin.put(['/Documents/Trip']);
  assert.deepEqual(await names(fs, '/Documents'), []);
  await bin.restore(slots);
  assert.equal(await fs.readText('/Documents/Trip/Deep/two.txt'), '2');
  assert.equal(await fs.readText('/Documents/Trip/one.txt'), '1');
});

test('destroying and emptying remove the bytes from the store; nothing else does', async () => {
  const store = new MemoryStore();
  const fs = new FileSystem(store);
  await fs.list('/');
  const baseline = store.size;
  const bin = new RecycleBin(fs);
  await fs.writeText('/Documents/x.txt', 'x');
  await fs.writeText('/Documents/y.txt', 'y');
  const { slots } = await bin.put(['/Documents/x.txt', '/Documents/y.txt']);
  assert.equal((await bin.list()).length, 2);
  await bin.destroy([slots[0]]);
  assert.equal((await bin.list()).length, 1);
  await bin.empty();
  assert.equal((await bin.list()).length, 0);
  // What remains is the bin's own folders and lists, not the deleted files.
  assert.ok(store.size - baseline <= 4, `left behind ${store.size - baseline} records`);
});

test('a lost list does not lose items: they show as "original location unknown"', async () => {
  const fs = new FileSystem(new MemoryStore());
  const bin = new RecycleBin(fs);
  await fs.writeText('/Documents/c.txt', 'c');
  const { slots } = await bin.put(['/Documents/c.txt']);
  await fs.remove(['/System/trash.json']);
  const items = await bin.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].from, '');
  const { restored } = await bin.restore(slots);
  assert.equal(restored[0].fallback, true);
  assert.equal(await fs.readText('/Documents/c.txt'), 'c');
});

test('one item failing does not stop the others being deleted', async () => {
  const fs = new FileSystem(new MemoryStore());
  const bin = new RecycleBin(fs);
  await fs.writeText('/Documents/ok.txt', 'ok');
  const { slots, failures } = await bin.put(['/Documents/missing.txt', '/Documents/ok.txt']);
  assert.equal(slots.length, 1);
  assert.equal(failures.length, 1);
  assert.equal(failures[0].name, 'missing.txt');
  assert.deepEqual(await names(fs, '/Documents'), []);
});

test('the standard folders and the System folder are protected; ordinary paths are not', () => {
  for (const p of ['/Desktop', '/documents', '/Music', '/System', '/System/Trash', '/']) assert.ok(protectedReason(p), p);
  for (const p of ['/Documents/a.txt', '/Desktop/Folder', '/Pictures/x/y']) assert.equal(protectedReason(p), null, p);
});

test('a saved session that is damaged, hand-edited or hostile falls back field by field', () => {
  assert.equal(parseSession(null).wallpaper.kind, 'colour');
  assert.equal(parseSession('nonsense').wallpaper.kind, 'colour');
  const s = parseSession({
    v: 1,
    wallpaper: { kind: 'colour', value: 'url(https://evil.example/x)' },
    icons: { a: [1, 2], b: [-1, 0], c: ['x', 1], d: [1e9, 1] },
    views: { '/Documents': { view: 'list', sort: 'size', desc: true }, '/x': { view: 'evil', sort: 'evil', desc: 'yes' }, '/y': 5 },
    windows: { explorer: { x: 10, y: 20, w: 300, h: 200 }, bad: { x: 'a', y: 0, w: 1, h: 1 } },
  });
  assert.deepEqual(s.wallpaper, { kind: 'colour', value: DEFAULT_COLOUR }, 'a colour that is not #rrggbb is refused');
  assert.deepEqual(Object.keys(s.icons), ['a']);
  assert.deepEqual(s.views['/Documents'], { view: 'list', sort: 'size', desc: true });
  assert.deepEqual(s.views['/x'], { view: 'icons', sort: 'name', desc: false });
  assert.ok(!('/y' in s.views));
  assert.deepEqual(Object.keys(s.windows), ['explorer']);
});

test('a wallpaper picture must be a path, and the list of folder views is capped', () => {
  assert.deepEqual(parseSession({ wallpaper: { kind: 'picture', path: '/Pictures/a.png' } }).wallpaper, { kind: 'picture', path: '/Pictures/a.png' });
  assert.equal(parseSession({ wallpaper: { kind: 'picture', path: 'https://evil.example/a.png' } }).wallpaper.kind, 'colour');
  const views: Record<string, unknown> = {};
  for (let i = 0; i < MAX_VIEWS + 50; i++) views[`/f${i}`] = { view: 'list', sort: 'name', desc: false };
  assert.equal(Object.keys(parseSession({ views }).views).length, MAX_VIEWS);
});

test('desktop icons keep saved cells, take the next free cell, and never share one', () => {
  const { cells, changed } = allocate(['a', 'b', 'c', 'd'], { a: [0, 0], b: [0, 0], c: [9, 9] }, 3, 2);
  assert.deepEqual(cells.get('a'), [0, 0]);
  const all = [...cells.values()].map(c => c.join(','));
  assert.equal(new Set(all).size, 4, 'four icons, four different cells');
  assert.ok(changed);
  for (const [c, r] of cells.values()) {
    assert.ok(c < 3 && r < 2);
  }
  assert.deepEqual(cellAt(150, 250, 96, 100, 3, 2), [1, 1]);
  assert.deepEqual(cellAt(-5, -5, 96, 100, 3, 2), [0, 0]);
  assert.deepEqual(cellAt(9999, 9999, 96, 100, 3, 2), [2, 1]);
});

test('a screen too small for every icon still shows them all', () => {
  const { cells } = allocate(['a', 'b', 'c', 'd', 'e'], {}, 1, 2);
  assert.equal(cells.size, 5);
});

test('the bin settings default to 30 days and 100 MB; anything outside 50 MB to 4 GB or 1 to 365 days is refused', () => {
  assert.deepEqual(defaultSession().bin, { clear: 'days', days: 30, limitMb: 100 });
  assert.equal(parseSession({ bin: { limitMb: 49 } }).bin.limitMb, 100);
  assert.equal(parseSession({ bin: { limitMb: 4097 } }).bin.limitMb, 100);
  assert.equal(parseSession({ bin: { limitMb: 50 } }).bin.limitMb, 50);
  assert.equal(parseSession({ bin: { limitMb: 4096 } }).bin.limitMb, 4096);
  assert.equal(parseSession({ bin: { days: 0 } }).bin.days, 30);
  assert.equal(parseSession({ bin: { days: 366 } }).bin.days, 30);
  assert.equal(parseSession({ bin: { days: 7, clear: 'daily' } }).bin.clear, 'daily');
  assert.equal(parseSession({ bin: { clear: 'whenever' } }).bin.clear, 'days');
});

test('auto-clear cutoffs: N days back, start of today, or never', () => {
  const now = new Date(2026, 8, 26, 15, 30);
  assert.equal(purgeCutoff('never', 30, now), null);
  assert.equal(purgeCutoff('daily', 30, now), new Date(2026, 8, 26).getTime());
  assert.equal(purgeCutoff('days', 30, now), now.getTime() - 30 * 86400000);
});

test('purgeBefore deletes only items deleted before the cutoff', async () => {
  const fs = new FileSystem(new MemoryStore());
  const bin = new RecycleBin(fs);
  await fs.writeText('/Documents/old.txt', 'o');
  await bin.put(['/Documents/old.txt']);
  const after = Date.now() + 1000;
  await fs.writeText('/Documents/new.txt', 'n');
  await bin.put(['/Documents/new.txt']);
  assert.equal(await bin.purgeBefore(Date.now() - 60000), 0, 'nothing is older than a minute');
  assert.equal((await bin.list()).length, 2);
  assert.equal(await bin.purgeBefore(after), 2);
  assert.equal((await bin.list()).length, 0);
});

test('items over the size limit (folders counted by everything inside) are set apart for a confirmation', async () => {
  const fs = new FileSystem(new MemoryStore());
  const session = defaultSession();
  session.bin.limitMb = 50;
  const actions = new FileActions({ fs, session: { data: session } } as never);
  await fs.mkdir('/Documents/Big');
  await fs.writeFile('/Documents/Big/a.bin', new Uint8Array(30 * 1024 * 1024));
  await fs.writeFile('/Documents/Big/b.bin', new Uint8Array(30 * 1024 * 1024));
  await fs.writeText('/Documents/small.txt', 'x');
  const { toBin, over } = await actions.splitByLimit(['/Documents/Big', '/Documents/small.txt']);
  assert.deepEqual(toBin, ['/Documents/small.txt']);
  assert.equal(over.length, 1);
  assert.equal(over[0].path, '/Documents/Big');
  assert.equal(over[0].size, 60 * 1024 * 1024);
});

// ---- Rules the whole source must keep ---------------------------------------------------------------------------

function sources(dir: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (path.endsWith('.ts')) out.push({ file: path.replace(/\\/g, '/'), text: readFileSync(path, 'utf8') });
  }
  return out;
}

const SRC = sources(join(import.meta.dirname, '..', 'src'));

test('no source file writes HTML, runs code from text, or leaves the site', () => {
  const banned: Array<[RegExp, string]> = [
    [/\binnerHTML\b/, 'innerHTML'],
    [/\bouterHTML\b/, 'outerHTML'],
    [/\binsertAdjacentHTML\b/, 'insertAdjacentHTML'],
    [/\bdocument\.write\b/, 'document.write'],
    [/\beval\s*\(/, 'eval'],
    [/\bnew\s+Function\b/, 'new Function'],
    [/\bsetTimeout\s*\(\s*['"`]/, 'setTimeout with a string'],
    [/\bsetAttribute\(\s*['"]style['"]/, 'a style attribute'],
    [/\.srcdoc\b/, 'srcdoc'],
    [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
    [/\bWebSocket\b/, 'WebSocket'],
    [/\bnavigator\.sendBeacon\b/, 'sendBeacon'],
    [/\blocalStorage\b/, 'localStorage (file data belongs in the store)'],
    [/\bserviceWorker\b/, 'a service worker'],
  ];
  for (const { file, text } of SRC) {
    const code = stripComments(text);
    for (const [pattern, label] of banned) assert.ok(!pattern.test(code), `${file} uses ${label}`);
  }
});

// Every outside address the source may mention (as the start of the address), the file allowed to mention it, and why.
// Anything else fails. Comments are removed first, but only real ones: "//" right after ":" is an address, not a
// comment (the first version of this test stripped every "https://..." as a comment, so it could never fail).
const OUTSIDE: Array<[string, RegExp, string]> = [
  ['http://www.w3.org/2000/svg', /./, 'the SVG namespace (not a request)'],
  ['http://schemas.openxmlformats.org/', /apps[\\/]sheet[\\/]xlsx(-parts)?\.ts$/, 'names written inside an Excel file (XML namespaces and part types, not requests)'],
  ['http://schemas.openxmlformats.org/', /apps[\\/]write[\\/]docx\.ts$/, 'names written inside a Word file (XML namespaces and part types, not requests)'],
  ['http://purl.org/dc/', /apps[\\/]write[\\/]docx\.ts$/, 'the names of a Word file\'s title and dates inside it (XML namespaces, not requests)'],
  ['http://www.w3.org/2001/XMLSchema-instance', /apps[\\/]write[\\/]docx\.ts$/, 'an XML namespace inside a Word file (not a request)'],
  ['http://schemas.microsoft.com/office/word', /apps[\\/]write[\\/]docx\.ts$/, 'the name Word gives its compatibility setting inside a file (not a request)'],
  ['http://schemas.microsoft.com/office/spreadsheetml/', /apps[\\/]sheet[\\/]xlsx\.ts$/, 'the name Excel 365 gives its "dynamic array" mark inside a file (not a request)'],
  ['http://ns.adobe.com/xap/1.0/', /apps[\\/]photoedit[\\/]fileinfo\.ts$/, 'the mark a JPEG\'s XMP details start with, looked for inside the file (not a request)'],
  ['https://${t}', /apps[\\/]write\.ts$/, 'a "www." address typed for a link (Ctrl+K) becomes https (then checked by linkHref)'],
  ['https://codemirror.net/', /apps[\\/]about\.ts$/, 'a link on the Credits page, opened only when clicked'],
  ['https://prosemirror.net/', /apps[\\/]about\.ts$/, 'a link on the Credits page, opened only when clicked'],
  ['https://github.com/mlc-ai/web-llm', /apps[\\/]about\.ts$/, 'a link on the Credits page, opened only when clicked'],
  ['https://github.com/anthropics/anthropic-sdk-php', /apps[\\/]about\.ts$/, 'a link on the Credits page, opened only when clicked'],
  ['https://${raw}', /notepadpro[\\/]markdown\.ts$/, 'a "www." autolink in a Markdown preview becomes https (then checked by safeHref)'],
  ['https://${s}', /apps[\\/]projects[\\/]data\.ts$/, 'a project\'s site typed without https:// becomes a link (http and https only; opened only when clicked)'],
  ['http://,', /apps[\\/]link\.ts$/, 'words in a message ("starts with https:// or http://"), not an address'],
  ['https://huggingface.co', /assistant[\\/]hfsearch\.ts$/, 'Find AI models: the search and each model\'s details (allowed in connect-src), and the "Model card" link'],
  ['https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/', /assistant[\\/]modellibs\.ts$/, 'the MLC team\'s WebGPU programs, fetched by WebLLM when an added model starts (allowed in connect-src)'],
];

/** The code with comments removed, leaving addresses alone. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

test('outside addresses appear only where declared, and fetch stays on this site', () => {
  let seen = 0;
  for (const { file, text } of SRC) {
    const code = stripComments(text);
    for (const match of code.matchAll(/https?:\/\/[^\s'"`)]+/g)) {
      seen++;
      const allowed = OUTSIDE.find(([url, where]) => match[0].startsWith(url) && where.test(file));
      assert.ok(allowed, `${file} mentions ${match[0]}; add it to OUTSIDE with a reason, or remove it`);
    }
    if (/\bfetch\s*\(/.test(code)) {
      // assistant/engine.ts: the model's program, fetched to check its pinned checksum before it runs (its address is
      // this TOMLIN OS's models/ or the pinned GitHub address from the server's list or modellibs.ts, allowed in connect-src).
      assert.ok(/main\.ts$|server-store\.ts$|auth[\\/]api\.ts$|core[\\/]local\.ts$|net[\\/]service\.ts$|assistant[\\/]engine\.ts$/.test(file), `${file} calls fetch; only main.ts, server-store.ts, auth/api.ts, net/service.ts (this site's API), core/local.ts (relative paths only) and assistant/engine.ts (the model's program, to check it) may`);
    }
  }
  assert.ok(seen >= 5, `the address check must actually see addresses (saw ${seen})`);
});

test('the address check catches an address nobody declared (the guard can fail)', () => {
  const planted = stripComments("const x = 'https://evil.example/steal'; // https://in.a.comment/");
  const found = [...planted.matchAll(/https?:\/\/[^\s'"`)]+/g)].map(m => m[0]);
  assert.deepEqual(found, ['https://evil.example/steal']);
  assert.ok(!OUTSIDE.some(([url]) => found[0].startsWith(url)));
});

test('core/local.ts refuses anything that is not a relative path', async () => {
  const { localPath } = await import('../src/core/local.ts');
  assert.equal(localPath('vendor/a.json'), 'vendor/a.json');
  for (const bad of ['https://x.y/a', '//x.y/a', '/etc/a', 'javascript:x', 'data:,x', 'vendor/../../a', '\\\\host\\a']) {
    assert.throws(() => localPath(bad), /Not a local path/, bad);
  }
});

test('listeners on the page itself always carry an abort signal (the window manager lives as long as the page)', () => {
  for (const { file, text } of SRC) {
    if (/core\/dom\.ts$|shell\/windows\.ts$/.test(file)) continue;
    const code = stripComments(text);
    for (const match of code.matchAll(/(window|document)\.addEventListener\(([^;]*?)\);/g)) {
      assert.ok(/signal/.test(match[2]), `${file}: ${match[0].slice(0, 80)}`);
    }
  }
});
