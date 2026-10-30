// A second look at the smaller apps (October 2026 retest): the PDF reader, Terminal, Calculator, RISC-V Studio,
// Notepad, the desktop's own "put this in the page" helper and the built-in AI's files. Each test was written to catch
// a fault read in the code; one that fails points at that fault. No browser needed. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { PdfDocument } from '../src/apps/pdf/objects.ts';
import { FileSystem } from '../src/fs/fs.ts';
import { MemoryStore } from '../src/store/memory-store.ts';
import { protectedReason } from '../src/shell/actions.ts';
import { TerminalShell, type Machine } from '../src/apps/terminal/shell.ts';
import { makeTrainingMachine } from '../src/apps/terminal/training.ts';
import { Calculator, parseSheet, type Op } from '../src/apps/calculator/model.ts';
import { assemble, parseNumber, registerIndex } from '../src/apps/riscv/rv32i.ts';
import { Machine as RiscMachine, TEXT_ROWS } from '../src/apps/riscv/machine.ts';
import { detectEol, findNext, toBox, toFile } from '../src/apps/notepad/text.ts';
import { DEFAULT_MEMORY, MEMORY_PATH, PROFILE_PATH, STORY_PATH, personaTurns } from '../src/apps/assistant/persona.ts';

const enc = (s: string) => new TextEncoder().encode(s);

// ---- PDF -------------------------------------------------------------------------------------------------------------

test('a PDF whose object stream claims a trillion objects opens in milliseconds, not never', async () => {
  // Opened in a worker thread: the loop in question never yields, so a plain test timeout could not stop it.
  const pdf = '%PDF-1.5\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page >>\nendobj\n'
    + '10 0 obj\n<< /Type /ObjStm /N 1000000000000 /First 0 /Length 0 >>\nstream\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n';
  const mod = new URL('../src/apps/pdf/objects.ts', import.meta.url).href;
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    import(workerData.mod).then(async m => {
      const doc = await m.PdfDocument.open(new TextEncoder().encode(workerData.pdf));
      parentPort.postMessage({ pages: doc.pages.length });
    }, e => parentPort.postMessage({ error: String(e) }));`, { eval: true, workerData: { mod, pdf } });
  type Outcome = { pages?: number; error?: string };
  const result = await Promise.race<Outcome>([
    new Promise<Outcome>(resolve => worker.once('message', resolve)),
    new Promise<Outcome>(resolve => setTimeout(() => resolve({ error: 'still opening after 4 seconds (the viewer would hang the tab)' }), 4000)),
  ]);
  await worker.terminate();
  assert.equal(result.error, undefined, result.error);
  assert.equal(result.pages, 1);
});

test('an object stream holding a newer copy of a page (an incremental save) wins over the older plain copy', async () => {
  const body = '3 0 << /Type /Page /MediaBox [0 0 500 500] >>';
  const pdf = enc('%PDF-1.5\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n'
    + '3 0 obj\n<< /Type /Page /MediaBox [0 0 100 100] >>\nendobj\n'
    + `10 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Length ${body.length} >>\nstream\n${body}\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n`);
  const doc = await PdfDocument.open(pdf);
  assert.deepEqual(doc.pages[0].box, [0, 0, 500, 500], 'the file header comment promises "a later copy of an object wins"');
});

// ---- Terminal -----------------------------------------------------------------------------------------------------------

async function desktop() {
  const fs = new FileSystem(new MemoryStore());
  const binned: string[][] = [];
  const machine: Machine = {
    fs, user: 'alex', host: 'tomlinos', home: '/', pretend: false, protectedReason,
    virtual: {},
    async trash(paths) {
      binned.push(paths);
      await fs.remove(paths);
      return 'Moved to the Recycle Bin.';
    },
    async open() {},
  };
  const sh = new TerminalShell(machine, makeTrainingMachine);
  const run = async (line: string) => (await sh.run(line)).map(l => l.text);
  return { fs, sh, run, binned };
}

test('a quoted wildcard is not expanded: rm "Documents/*.txt" does not bin every text file', async () => {
  const { fs, run, binned } = await desktop();
  await fs.writeText('/Documents/a.txt', '1');
  await fs.writeText('/Documents/b.txt', '2');
  const out = await run('rm "Documents/*.txt"');
  assert.equal(binned.length, 0, `binned: ${JSON.stringify(binned)}; said: ${out.join(' | ')}`);
});

test('tail -n 0 prints nothing', async () => {
  const { fs, run } = await desktop();
  await fs.writeText('/Documents/n.txt', 'a\nb\nc\n');
  assert.deepEqual(await run('tail -n 0 Documents/n.txt'), []);
});

test('rm -r refuses the folder you are standing in, however its name is typed (letter case)', async () => {
  const { run, binned } = await desktop();
  await run('mkdir -p Documents/Work');
  await run('cd Documents/Work');
  const out = await run('rm -r /documents/work');
  assert.equal(binned.length, 0, `said: ${out.join(' | ')}`);
  assert.match(out[0] ?? '', /standing in it/);
});

test('wc counts an empty file as 0 lines, like every wc', async () => {
  const { fs, run } = await desktop();
  await fs.writeText('/Documents/e.txt', '');
  assert.match((await run('wc Documents/e.txt'))[0], /^\s*0\s/);
});

// ---- Calculator -----------------------------------------------------------------------------------------------------------

function press(keys: string): Calculator {
  const c = new Calculator();
  for (const k of keys.split(' ')) {
    if (/^[\d.]+$/.test(k)) for (const d of k) c.digit(d);
    else if (k === '=') c.equals();
    else if (k === '<') c.back();
    else if (k === '±') c.negate();
    else c.operator(k as Op);
  }
  return c;
}

test('a 15-digit number (the most the keypad takes) is shown and carried on in full, not rounded to 12 digits', () => {
  assert.equal(press('123456789012345 + 0 =').display, '123456789012345');
  assert.equal(press('123456789012345 + 0 = + 1 =').display, '123456789012346');
});

test('after ± on a result, the next digit starts a new number rather than being glued onto the result', () => {
  const c = press('100000000 × 10000000 = ± 5');
  assert.ok(Math.abs(c.value) < 1e20, `became ${c.display} (${c.value})`);
});

test('a calculator file holding "null" is reported as damaged, not as "not there any more"', () => {
  assert.throws(() => parseSheet('null'), SyntaxError);
});

// ---- RISC-V Studio ------------------------------------------------------------------------------------------------------------

test('"constructor" is not a register: it is refused as one and allowed as a label', () => {
  assert.equal(registerIndex('constructor'), null);
  assert.notEqual(assemble('add constructor, a0, a1\n').error, null, 'assembling "add constructor, ..." must fail');
  assert.equal(assemble('constructor: nop\n').error, null, 'a label called constructor is fine');
});

test('a number too big for 32 bits is an error, not silently wrapped', () => {
  assert.notEqual(assemble('li t0, 0x100000000\n').error, null);
  assert.equal(parseNumber('4294967296'), null);
});

test('a label written just before ".text" keeps its place in the data section', () => {
  const a = assemble('.data\nbuf:\n.text\nmain: la a0, buf\n ebreak\n.data\n.word 42\n');
  assert.equal(a.error, null);
  assert.equal(a.labels.buf, a.dataStart, `buf landed at ${a.labels.buf?.toString(16)}, main is at ${a.labels.main?.toString(16)}`);
});

test('.string writes UTF-8 bytes, so "€" and an emoji survive', () => {
  const a = assemble('.data\nmsg: .string "€"\n');
  assert.equal(a.error, null);
  assert.deepEqual([...a.image.slice(a.dataStart - a.base, a.dataStart - a.base + 4)], [0xe2, 0x82, 0xac, 0]);
});

test('the text screen never grows past its rows when a program sets the cursor far down', () => {
  const m = new RiscMachine();
  m.load('main: li t0, 0x80000014\n li t1, 0x0F00\n sw t1, 0(t0)\n li t0, 0x80000018\n li t1, 65\n sw t1, 0(t0)\n ebreak\n');
  m.start(0);
  m.frame(16);
  assert.ok(m.text.length <= TEXT_ROWS, `${m.text.length} rows of text for a ${TEXT_ROWS}-row screen`);
});

// ---- Notepad -------------------------------------------------------------------------------------------------------------------

test('Find ignoring case points at the right letters even after a Turkish İ', () => {
  assert.deepEqual(findNext('İcat', 'cat', 0, { matchCase: false }), { start: 1, end: 4, wrapped: false });
});

test('a file with old Mac line endings (CR only) is saved back with the same endings', () => {
  const t = 'a\rb\rc';
  assert.equal(toFile(toBox(t), detectEol(t, '\n')), t);
});

// ---- Putting things in the page -------------------------------------------------------------------------------------------------------

test('a link whose scheme hides a tab or newline ("java\\tscript:") is refused like a plain javascript: link', async () => {
  const g = globalThis as { document?: unknown };
  g.document = { createElement: () => ({ setAttribute() {}, append() {} }), createTextNode: (t: string) => t };
  try {
    const { h } = await import('../src/core/dom.ts');
    assert.throws(() => h('a', { href: 'javascript:alert(1)' }), 'the plain form is refused');
    assert.throws(() => h('a', { href: 'java\tscript:alert(1)' }), 'browsers drop the tab and run it');
    assert.throws(() => h('a', { href: 'java\nscript:alert(1)' }), 'browsers drop the newline and run it');
  } finally {
    delete g.document;
  }
});

// ---- The AI's files --------------------------------------------------------------------------------------------------------------

test("one failed read of the AI's memory file does not replace it with the defaults", async () => {
  const held = DEFAULT_MEMORY + '\n- their dog is called Rex\n';
  const files = new Map<string, string>([[MEMORY_PATH, held]]);
  let failOnce = true;
  const fs = {
    readText: async (p: string) => {
      if (p === MEMORY_PATH && failOnce) {
        failOnce = false;
        throw new Error('Failed to fetch');
      }
      const t = files.get(p);
      if (t === undefined) throw new Error('not there');
      return t;
    },
    writeText: async (p: string, t: string) => void files.set(p, t),
    ensureFolder: async () => {},
  } as unknown as FileSystem;
  await personaTurns(fs, 'Matt', [{ role: 'user', content: 'hi' }]).catch(() => {});
  assert.ok((files.get(MEMORY_PATH) ?? '').includes('Rex'), 'the remembered fact is still there');
  assert.ok(!files.has(PROFILE_PATH) || files.get(PROFILE_PATH) !== undefined, 'profile may be created afresh; that is fine');
  void STORY_PATH;
});

test('wc counts the line ends in a file, like every wc: a last line with no line end does not add one', async () => {
  const { fs, run } = await desktop();
  await fs.writeText('/Documents/a.txt', 'one\ntwo');
  await fs.writeText('/Documents/b.txt', 'one\ntwo\n');
  await fs.writeText('/Documents/c.txt', 'one');
  assert.match((await run('wc Documents/a.txt'))[0], /^\s*1\s/);
  assert.match((await run('wc Documents/b.txt'))[0], /^\s*2\s/);
  assert.match((await run('wc Documents/c.txt'))[0], /^\s*0\s/);
});
