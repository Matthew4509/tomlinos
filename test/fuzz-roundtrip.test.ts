// Round-trip (property) tests: random valid documents, workbooks, calendars, contacts, drawings and archives are
// written in each file format and read back, and must come back the same; writing again must give the same bytes or
// text (stable). Where a format cannot hold something (Markdown and colours), the app's own "what this loses" list must
// name it: anything lost without being named is a fault. Random means seeded random (fuzz-helpers.ts): the same
// documents every run, and every failure names the seed that makes it again (FUZZ_SEED / FUZZ_ROUNDS change the run).
// Run: node --test test/fuzz-*.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASE_SEED, enc, Rng, ROUNDS } from './fuzz-helpers.ts';
import { readDocx, writeDocx } from '../src/apps/write/docx.ts';
import { markdownLoses, readMarkdown, writeMarkdown } from '../src/apps/write/markdown.ts';
import { defaultPage, plainText, STYLES as WRITE_STYLES, type MarkJSON, type NodeJSON } from '../src/apps/write/model.ts';
import { Workbook } from '../src/apps/sheet/workbook.ts';
import { openXlsx, saveOverLosses, saveXlsx } from '../src/apps/sheet/xlsx.ts';
import { newDrawing, readTcad, writeTcad, type Drawing, type Ent } from '../src/apps/cad/model.ts';
import { readDxf, writeDxf } from '../src/apps/cad/dxf.ts';
import { P } from '../src/apps/cad/geom.ts';
import { parseIcs, writeIcs, type CalEvent, type Repeat } from '../src/core/ical.ts';
import { parseVcf, writeVcf, type Contact } from '../src/core/vcard.ts';
import { zipDeflate, zipStore } from '../src/core/zip.ts';
import { readZip } from '../src/apps/archive/read.ts';

// ---- Random content ---------------------------------------------------------------------------------------------------------

const WORDS = ['the', 'quick', 'brown', 'fox', 'café', 'naïve', 'Zürich', 'İstanbul', 'straße', 'ﬁne', 'שלום', 'مرحبا', 'नमस्ते', '日本語', '😀', '👨‍👩‍👧', '🇦🇺', 'a—b', '“quoted”', "it's", 'x<y', 'a&b', 'c>d', '"dq"', '50%', '#1', '*star*', '_under_', '[brack]', '|pipe|', '`tick`', '\\back', 'tab\there', '1.', '-', '+'];

/** A line of text people really type: words, a few from the list above, now and then a very long word. */
function text(rng: Rng, max = 8): string {
  const n = rng.int(1, max);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = rng.next();
    if (r < 0.6) parts.push(rng.pick(WORDS));
    else if (r < 0.95) parts.push(String.fromCharCode(...Array.from({ length: rng.int(1, 9) }, () => rng.int(97, 122))));
    else parts.push('w'.repeat(rng.int(60, 300)));
  }
  return parts.join(' ');
}

const MARK_KINDS = ['strong', 'em', 'underline', 'strike', 'link', 'color', 'highlight', 'size', 'font', 'vert'] as const;
const FACES = ['Georgia', 'Arial', 'Courier New', 'Times New Roman'];
const COLOURS = ['#c00000', '#0000ff', '#00a000', '#ffff00', '#ddeeff'];

function marks(rng: Rng): MarkJSON[] | undefined {
  if (rng.chance(0.5)) return undefined;
  const out: MarkJSON[] = [];
  for (const kind of MARK_KINDS) {
    if (!rng.chance(0.2)) continue;
    if (kind === 'link') out.push({ type: 'link', attrs: { href: rng.pick(['https://example.com/a?b=1&c=2', 'mailto:ann@example.com', 'https://example.com/with%20space#frag', 'http://xn--caf-dma.com/é', 'https://example.com/a(b)_c*d']) } });
    else if (kind === 'color') out.push({ type: 'color', attrs: { value: rng.pick(COLOURS) } });
    else if (kind === 'highlight') out.push({ type: 'highlight', attrs: { value: rng.pick(COLOURS) } });
    else if (kind === 'size') out.push({ type: 'size', attrs: { pt: rng.pick([8, 9.5, 14, 24, 72]) } });
    else if (kind === 'font') out.push({ type: 'font', attrs: { face: rng.pick(FACES) } });
    else if (kind === 'vert') out.push({ type: 'vert', attrs: { pos: rng.pick(['super', 'sub']) } });
    else out.push({ type: kind });
  }
  return out.length ? out : undefined;
}

function inline(rng: Rng): NodeJSON[] {
  const out: NodeJSON[] = [];
  const n = rng.int(1, 4);
  for (let i = 0; i < n; i++) {
    const m = marks(rng);
    out.push(m ? { type: 'text', text: text(rng), marks: m } : { type: 'text', text: text(rng) });
    if (rng.chance(0.15)) out.push({ type: 'hard_break' });
  }
  // Two text nodes with the same marks would merge in any editor: keep the sample canonical by giving neighbours different marks.
  return out.filter((node, i) => node.type !== 'text' || i === 0 || out[i - 1].type !== 'text' || JSON.stringify(out[i - 1].marks ?? null) !== JSON.stringify(node.marks ?? null));
}

const STYLES = ['normal', 'normal', 'normal', 'title', 'h1', 'h2', 'h3', 'h4'];
function paragraph(rng: Rng, allowLook = true): NodeJSON {
  const attrs: Record<string, unknown> = { style: rng.pick(STYLES) };
  if (allowLook) {
    if (rng.chance(0.3)) attrs.align = rng.pick(['left', 'center', 'right', 'justify']);
    if (rng.chance(0.2)) {
      attrs.before = rng.pick([0, 6, 12]);
      attrs.after = rng.pick([0, 8, 12]);
      attrs.line = rng.pick([1, 1.15, 1.5, 2]);
    }
    if (rng.chance(0.15)) {
      attrs.indent = rng.pick([18, 36, 72]);
      attrs.first = rng.pick([0, 18, -18]);
    }
  }
  return { type: 'paragraph', attrs, content: inline(rng) };
}

function list(rng: Rng, depth = 0): NodeJSON {
  const ordered = rng.chance(0.5);
  const items: NodeJSON[] = [];
  for (let i = rng.int(1, 4); i > 0; i--) {
    const content: NodeJSON[] = [{ type: 'paragraph', attrs: { style: 'normal' }, content: inline(rng) }];
    if (depth < 2 && rng.chance(0.3)) content.push(list(rng, depth + 1));
    items.push({ type: 'list_item', content });
  }
  return ordered ? { type: 'ordered_list', attrs: { order: rng.pick([1, 1, 3, 10]) }, content: items } : { type: 'bullet_list', content: items };
}

function table(rng: Rng): NodeJSON {
  const cols = rng.int(1, 4);
  const rows: NodeJSON[] = [];
  for (let r = rng.int(1, 4); r > 0; r--) {
    rows.push({ type: 'table_row', content: Array.from({ length: cols }, () => ({ type: 'table_cell', attrs: { colspan: 1, rowspan: 1, colwidth: null, background: rng.chance(0.2) ? rng.pick(COLOURS) : null }, content: [{ type: 'paragraph', attrs: { style: 'normal' }, content: inline(rng) }] })) });
  }
  return { type: 'table', attrs: { borders: true }, content: rows };
}

/** A random document: paragraphs with formatting, lists inside lists, tables, page breaks. */
function randomDoc(rng: Rng, allowLook = true): NodeJSON {
  const blocks: NodeJSON[] = [];
  for (let i = rng.int(1, 8); i > 0; i--) {
    const r = rng.next();
    if (r < 0.6) blocks.push(paragraph(rng, allowLook));
    else if (r < 0.8) blocks.push(list(rng));
    else if (r < 0.95) blocks.push(table(rng));
    else if (allowLook) blocks.push({ type: 'page_break' });
    else blocks.push(paragraph(rng, allowLook));
  }
  return { type: 'doc', content: blocks };
}

/**
 * The document with empty parts and default values taken out, to compare (as test/write-docx.test.ts does). What a
 * trip through Word's format is allowed to normalise, because it shows the same: "left" alignment (the default), a
 * paragraph's spacing when it equals its style's own, a table column width Write filled in where none was set, and an
 * underline on a link (links are drawn underlined anyway), italics on a heading style that is italic already (Heading 4),
 * and a first-line indent of 0.
 */
function norm(n: NodeJSON, parentStyle: keyof typeof WRITE_STYLES = 'normal'): unknown {
  const attrs: Record<string, unknown> = {};
  const style = String(n.attrs?.style ?? 'normal') as keyof typeof WRITE_STYLES;
  for (const [k, v] of Object.entries(n.attrs ?? {})) {
    if (v === null || v === undefined) continue;
    if (k === 'style' && v === 'normal') continue;
    if (k === 'align' && v === 'left') continue;
    if (k === 'colwidth') continue;
    if ((k === 'before' || k === 'after' || k === 'line') && WRITE_STYLES[style] && v === WRITE_STYLES[style][k]) continue;
    if (k === 'first' && v === 0) continue;
    attrs[k] = v;
  }
  const out: Record<string, unknown> = { type: n.type };
  if (Object.keys(attrs).length) out.attrs = attrs;
  if (n.text !== undefined) out.text = n.text;
  const marks = (n.marks ?? []).filter(m => !(m.type === 'underline' && n.marks!.some(o => o.type === 'link')) && !(m.type === 'em' && WRITE_STYLES[parentStyle]?.italic));
  if (marks.length) out.marks = marks.map(m => JSON.stringify(m)).sort();
  if (n.content?.length) out.content = n.content.map(c => norm(c, n.type === 'paragraph' ? style : parentStyle));
  return out;
}

const seeds = (salt: number) => Array.from({ length: ROUNDS }, (_, i) => (BASE_SEED + salt * 7919 + i * 104729) >>> 0);

// ---- Word (.docx) ---------------------------------------------------------------------------------------------------------------

test('Word (.docx): a random document written and read back is the same document, and writing again is stable', async () => {
  const bad: string[] = [];
  for (const seed of seeds(1)) {
    const doc = randomDoc(new Rng(seed));
    const bytes = await writeDocx(doc, defaultPage(), 'Round trip');
    const back = await readDocx(bytes);
    if (back.dropped.length) bad.push(`seed=${seed}: Write's own file reports losses: ${back.dropped.join('; ')}`);
    try {
      assert.deepEqual(norm(back.doc), norm(doc));
    } catch (e) {
      bad.push(`seed=${seed}: the document read back differs:\n${String((e as Error).message).split('\n').slice(0, 30).join('\n')}`);
      continue;
    }
    const again = await readDocx(await writeDocx(back.doc, back.page, 'Round trip', back.source));
    try {
      assert.deepEqual(norm(again.doc), norm(back.doc));
    } catch (e) {
      bad.push(`seed=${seed}: the second trip changed the document:\n${String((e as Error).message).split('\n').slice(0, 20).join('\n')}`);
    }
  }
  assert.ok(bad.length === 0, `${bad.length} of ${ROUNDS} documents did not round-trip:\n${bad.slice(0, 4).join('\n\n')}`);
});

test('Word (.docx): the words of a document survive, character for character', async () => {
  // Plain words only (no formatting), so any change is the text itself turning into something else.
  for (const seed of seeds(2)) {
    const rng = new Rng(seed);
    const doc: NodeJSON = { type: 'doc', content: Array.from({ length: rng.int(1, 6) }, () => ({ type: 'paragraph', attrs: { style: 'normal' }, content: [{ type: 'text', text: text(rng, 20) }] })) };
    const back = await readDocx(await writeDocx(doc, defaultPage()));
    assert.equal(plainText(back.doc), plainText(doc), `seed=${seed}: the text changed`);
  }
});

// ---- Markdown (.md) -----------------------------------------------------------------------------------------------------------------

/** What a document holds that Markdown's writer here does not keep, found by comparing: each kind named once. */
function featuresLost(before: NodeJSON, after: NodeJSON): string[] {
  const lost = new Set<string>();
  const count = (n: NodeJSON, into: Map<string, number>) => {
    const key = (k: string) => into.set(k, (into.get(k) ?? 0) + 1);
    if (n.type === 'image') key('pictures');
    if (n.type === 'page_break') key('page breaks');
    if (n.type === 'hard_break') key('line breaks');
    if (n.type === 'paragraph' && n.attrs?.align) key('alignment');
    if (n.type === 'paragraph' && (n.attrs?.before !== undefined || n.attrs?.indent !== undefined)) key('spacing');
    if (n.type === 'paragraph' && n.attrs?.style === 'title') key('title style');
    if (n.type === 'table_cell' && n.attrs?.background) key('cell shading');
    for (const m of n.marks ?? []) key(`mark:${m.type}`);
    for (const c of n.content ?? []) count(c, into);
  };
  const a = new Map<string, number>();
  const b = new Map<string, number>();
  count(before, a);
  count(after, b);
  for (const [k, n] of a) if ((b.get(k) ?? 0) < n) lost.add(k);
  return [...lost];
}

/** Does the "what this loses" list speak of this kind of thing? Matched on words, since the list is for people. */
function named(losses: string[], kind: string): boolean {
  const words: Record<string, RegExp> = {
    pictures: /picture/i, 'page breaks': /page break/i, 'line breaks': /line break/i, alignment: /alignment/i, spacing: /spacing|indent/i, 'title style': /title/i, 'cell shading': /shading|colour|color|cell/i,
    'mark:color': /colour|color/i, 'mark:highlight': /colour|color|highlight/i, 'mark:size': /size/i, 'mark:underline': /underlin/i, 'mark:vert': /raised|lowered|super|sub/i, 'mark:font': /typeface|font/i,
    'mark:strong': /bold/i, 'mark:em': /italic/i, 'mark:strike': /strike/i, 'mark:link': /link/i,
  };
  return losses.some(l => words[kind]?.test(l));
}

test('Markdown (.md): what the round trip loses is named by markdownLoses, and the words survive', () => {
  // Already known (HANDOFF-2026-10-29, W5, being fixed on fix/office-data-loss): code blocks, quotes, pictures, rules
  // and reference links. This test is about everything else a random document holds.
  const bad: string[] = [];
  for (const seed of seeds(3)) {
    const doc = randomDoc(new Rng(seed));
    const md = writeMarkdown(doc);
    const back = readMarkdown(md);
    const said = markdownLoses(doc);
    for (const kind of featuresLost(doc, back)) {
      if (!named(said, kind)) bad.push(`seed=${seed}: ${kind} lost but markdownLoses says only [${said.join('; ')}]`);
    }
    const before = plainText(doc).replace(/\s+/g, ' ').trim();
    const after = plainText(back).replace(/\s+/g, ' ').trim();
    if (before !== after) bad.push(`seed=${seed}: the words changed\n  before: ${before.slice(0, 200)}\n  after:  ${after.slice(0, 200)}`);
    if (writeMarkdown(back) !== writeMarkdown(readMarkdown(writeMarkdown(back)))) bad.push(`seed=${seed}: a second save changes the Markdown again`);
  }
  assert.ok(bad.length === 0, `${bad.length} finding(s):\n${[...new Set(bad.map(b => b.replace(/seed=\d+: /, '')))].slice(0, 12).join('\n')}\nfirst seeds: ${bad.slice(0, 5).map(b => b.split(':')[0]).join(', ')}`);
});

test('Markdown (.md): a document of only what Markdown holds comes back the same', () => {
  const bad: string[] = [];
  for (const seed of seeds(4)) {
    const rng = new Rng(seed);
    // Headings, plain paragraphs, bold, italic, strike, links, lists and tables: all things Markdown has.
    const safeInline = (): NodeJSON[] => {
      const out: NodeJSON[] = [];
      for (let i = rng.int(1, 3); i > 0; i--) {
        const kinds = (['strong', 'em', 'strike'] as const).filter(() => rng.chance(0.25));
        const m: MarkJSON[] = kinds.map(type => ({ type }));
        if (rng.chance(0.15)) m.push({ type: 'link', attrs: { href: 'https://example.com/a' } });
        // Markdown's own signs inside words are escaped by the writer; plain letters, accents and emoji only here.
        const t = text(rng).replace(/[\\`*_[\]~|#>+-]/g, 'x');
        out.push(m.length ? { type: 'text', text: t, marks: m } : { type: 'text', text: t });
      }
      return out.filter((n, i) => i === 0 || JSON.stringify(out[i - 1].marks ?? null) !== JSON.stringify(n.marks ?? null));
    };
    const para = (style = 'normal'): NodeJSON => ({ type: 'paragraph', attrs: { style }, content: safeInline() });
    const blocks: NodeJSON[] = [];
    for (let i = rng.int(1, 6); i > 0; i--) {
      const r = rng.next();
      if (r < 0.5) blocks.push(para());
      else if (r < 0.7) blocks.push(para(rng.pick(['h1', 'h2', 'h3'])));
      else if (r < 0.85) blocks.push({ type: 'bullet_list', content: Array.from({ length: rng.int(1, 3) }, () => ({ type: 'list_item', content: [para()] })) });
      else blocks.push({ type: 'table', attrs: { borders: true }, content: Array.from({ length: rng.int(2, 3) }, () => ({ type: 'table_row', content: Array.from({ length: 2 }, () => ({ type: 'table_cell', attrs: { colspan: 1, rowspan: 1, colwidth: null, background: null }, content: [para()] })) })) });
    }
    const doc: NodeJSON = { type: 'doc', content: blocks };
    const back = readMarkdown(writeMarkdown(doc));
    try {
      assert.deepEqual(norm(back), norm(doc));
    } catch (e) {
      bad.push(`seed=${seed}:\n${String((e as Error).message).split('\n').slice(0, 24).join('\n')}`);
    }
  }
  assert.ok(bad.length === 0, `${bad.length} of ${ROUNDS} Markdown-only documents did not round-trip:\n${bad.slice(0, 3).join('\n\n')}`);
});

// ---- Spreadsheet (.xlsx and .sheet) -----------------------------------------------------------------------------------------------------

const SHEET_NAMES = ['Sheet1', 'Orders 2026', "It's", 'Notes & more', 'a"b', 'Ünïcödé 😀', 'x'.repeat(31), ' lead', 'trail '];

/** A random workbook: numbers, text, booleans, dates, formulas across sheets, styles, column widths, merges, a frozen pane. */
function randomWorkbook(rng: Rng): Workbook {
  const wb = new Workbook();
  const nSheets = rng.int(1, 3);
  const names: string[] = [];
  for (let s = 0; s < nSheets; s++) {
    if (s > 0) wb.addSheet();
    let name = rng.pick(SHEET_NAMES);
    while (names.includes(name)) name += '2';
    try {
      wb.renameSheet(s, name);
      names.push(wb.sheets[s].name);
    } catch {
      names.push(wb.sheets[s].name);
    }
  }
  for (let s = 0; s < nSheets; s++) {
    for (let i = rng.int(1, 25); i > 0; i--) {
      const col = rng.int(0, 6);
      const row = rng.int(0, 12);
      const r = rng.next();
      let input: string;
      if (r < 0.3) input = rng.pick(['0', '1', '-1', '3.14159', '1e-7', '1e15', '123456789012', '0.1', '-0.000001', '42']);
      else if (r < 0.55) input = text(rng, 4);
      else if (r < 0.6) input = rng.pick(['TRUE', 'FALSE']);
      else if (r < 0.7) input = rng.pick(['12/03/2026', '1/1/2000', '31/12/1999', '29/02/2024', '14:30', '12/03/2026 09:15']);
      else if (r < 0.8) input = rng.pick(['=A1+B2', '=SUM(A1:C3)', '=IF(A1>1,"big","small")', '=LEN("a""b")', '=A1&" x"', '=ROUND(B2/3,2)', '=COUNTA(A:A)', '=MAX(A1:A5)-MIN(A1:A5)']);
      else if (r < 0.9 && nSheets > 1) input = `='${names[(s + 1) % nSheets].replace(/'/g, "''")}'!A1`;
      else input = rng.pick(["'007", '  spaced  ', 'multi\nline', '="quoted"', '=1/0', '#N/A', '50%', '$1,000']);
      try {
        wb.setInput(s, col, row, input);
      } catch {
        // A formula the parser refuses is left out of the sample.
      }
      if (rng.chance(0.3)) {
        wb.setStyle(s, { c0: col, r0: row, c1: col, r1: row }, old => ({
          ...old,
          ...(rng.chance(0.5) ? { b: true } : {}), ...(rng.chance(0.3) ? { i: true } : {}), ...(rng.chance(0.2) ? { u: true } : {}),
          ...(rng.chance(0.3) ? { al: rng.pick(['l', 'c', 'r'] as const) } : {}), ...(rng.chance(0.3) ? { fill: rng.pick(COLOURS) } : {}),
          ...(rng.chance(0.3) ? { color: rng.pick(COLOURS) } : {}), ...(rng.chance(0.2) ? { wrap: true } : {}),
          ...(rng.chance(0.3) ? { fmt: rng.pick(['number', 'currency', 'percent', 'comma'] as const), dec: rng.int(0, 4) } : {}),
          ...(rng.chance(0.2) ? { fs: rng.pick([8, 14, 20]), ff: rng.pick(FACES) } : {}),
        }));
      }
    }
    if (rng.chance(0.4)) wb.sheets[s].colW.set(rng.int(0, 6), rng.pick([40, 120, 250]));
    if (rng.chance(0.3)) wb.sheets[s].freeze = { rows: rng.int(1, 2), cols: rng.int(0, 1) };
  }
  return wb;
}

/** Every cell's input text, shown text and style, by sheet name and address, to compare two workbooks. */
function snapshot(wb: Workbook): Record<string, unknown> {
  const out: Record<string, unknown> = { names: wb.sheets.map(s => s.name) };
  wb.sheets.forEach((sh, s) => {
    for (const [k] of sh.cells) {
      const col = k % 256;
      const row = Math.floor(k / 256);
      const cell = sh.cells.get(k)!;
      const style = { ...wb.styles[cell.s ?? 0] };
      // A format code is only used when the format is "custom"; one left behind a named format says nothing.
      if (style.fmt && style.fmt !== 'custom') delete style.code;
      out[`${sh.name}!${col},${row}`] = { input: wb.editText(s, col, row), shown: wb.display(s, col, row), style };
    }
    out[`${sh.name} colW`] = Object.fromEntries(sh.colW);
    out[`${sh.name} freeze`] = sh.freeze;
  });
  return out;
}

test('Excel (.xlsx): a random workbook saved and opened again shows the same cells, styles and sheet names', async () => {
  const bad: string[] = [];
  for (const seed of seeds(5)) {
    const wb = randomWorkbook(new Rng(seed));
    const bytes = await saveXlsx(wb);
    const back = new Workbook();
    const report = await openXlsx(back, bytes);
    const losses = saveOverLosses(report);
    if (losses) bad.push(`seed=${seed}: opening the file this app just saved reports losses: ${losses}`);
    try {
      assert.deepEqual(snapshot(back), snapshot(wb));
    } catch (e) {
      bad.push(`seed=${seed}: differs after one trip:\n${String((e as Error).message).split('\n').slice(0, 24).join('\n')}`);
      continue;
    }
    const again = new Workbook();
    await openXlsx(again, await saveXlsx(back));
    try {
      assert.deepEqual(snapshot(again), snapshot(back));
    } catch (e) {
      bad.push(`seed=${seed}: the second trip changed the workbook:\n${String((e as Error).message).split('\n').slice(0, 16).join('\n')}`);
    }
  }
  assert.ok(bad.length === 0, `${bad.length} of ${ROUNDS} workbooks did not round-trip through .xlsx:\n${bad.slice(0, 4).join('\n\n')}`);
});

test('the .sheet file: serialize, load and serialize again gives the same text', () => {
  for (const seed of seeds(6)) {
    const wb = randomWorkbook(new Rng(seed));
    const text1 = wb.serialize();
    const back = new Workbook();
    back.load(JSON.parse(text1));
    // Compared as data: the order of keys inside a style object is not content, and a format code left behind a named
    // format (fmt "comma" with a date code from an earlier entry) says nothing, so load() may drop it.
    const tidy = (text: string) => {
      const d = JSON.parse(text) as { styles: Array<Record<string, unknown>> };
      for (const st of d.styles) if (st.fmt && st.fmt !== 'custom') delete st.code;
      return d;
    };
    assert.deepEqual(tidy(back.serialize()), tidy(text1), `seed=${seed}: the .sheet file changes on a round trip`);
    assert.deepEqual(snapshot(back), snapshot(wb), `seed=${seed}: the cells differ after a .sheet round trip`);
  }
});

test('Excel (.xlsx): cell text survives character for character (quotes, apostrophes, line breaks, emoji, spaces)', async () => {
  const samples = ["'007", '  two  spaces  ', 'a\nb\r\nc', '😀 👨‍👩‍👧', 'x<y&z>"q"', '\t tab', "it's", 'ﬁ', 'İ', 'a'.repeat(5000), '=not a formula', '+1', '-', 'TRUE ', 'true', '1e5', '00123', '12/03/2026 ', '٣٤٥'];
  const wb = new Workbook();
  samples.forEach((s, i) => wb.setInput(0, 0, i, s.startsWith('=') ? `'${s}` : s));
  const back = new Workbook();
  await openXlsx(back, await saveXlsx(wb));
  samples.forEach((_, i) => {
    assert.equal(back.editText(0, 0, i), wb.editText(0, 0, i), `row ${i + 1}: the typed text changed`);
    assert.equal(back.display(0, 0, i), wb.display(0, 0, i), `row ${i + 1}: the shown text changed`);
  });
});

// ---- Calendar (.ics) and contacts (.vcf) -----------------------------------------------------------------------------------------------------

const FREE_TEXT = ['Stand-up, with "quotes"', 'semi; colon', 'line one\nline two', 'back\\slash', 'a:b', 'tab\tin', 'é 😀 שלום', 'x'.repeat(400), ' lead and trail ', 'ends with \\', 'BEGIN:VEVENT', 'DTSTART:20260101'];
const day = (rng: Rng) => `${rng.int(1900, 2100)}-${String(rng.int(1, 12)).padStart(2, '0')}-${String(rng.int(1, 28)).padStart(2, '0')}`;
const clock = (rng: Rng) => `${String(rng.int(0, 23)).padStart(2, '0')}:${String(rng.int(0, 59)).padStart(2, '0')}`;

function randomEvent(rng: Rng, i: number): CalEvent {
  const timed = rng.chance(0.7);
  const repeat = rng.pick<Repeat>(['none', 'none', 'daily', 'weekly', 'monthly', 'yearly']);
  const e: CalEvent = {
    uid: rng.chance(0.8) ? `ev-${i}-${rng.int(0, 1e9)}@tomlinos` : rng.pick(['a b', 'x;y', 'z,w', 'é😀', 'x'.repeat(200)]),
    // The Calendar's own What and Where boxes hold up to 500 letters (maxlength), and Where is trimmed on saving.
    title: (rng.chance(0.3) ? rng.pick(FREE_TEXT) : text(rng, 5)).slice(0, 500),
    date: day(rng),
    start: timed ? clock(rng) : '',
    end: timed && rng.chance(0.7) ? clock(rng) : '',
    notes: rng.chance(0.5) ? rng.pick(FREE_TEXT) : '',
    repeat,
    remind: rng.pick([-1, 0, 5, 15, 30, 60, 1440, 10080]),
  };
  if (repeat !== 'none') {
    if (rng.chance(0.4)) e.count = rng.int(1, 366);
    else if (rng.chance(0.5)) e.until = day(rng);
  }
  if (rng.chance(0.4)) e.where = rng.pick(FREE_TEXT).trim().slice(0, 500);
  if (rng.chance(0.3)) e.project = `proj-${rng.int(1, 99)}`;
  return e;
}

/** The fields a person sees (the keep block is the file's own business). */
const seen = (e: CalEvent) => ({ uid: e.uid, title: e.title, date: e.date, start: e.start, end: e.end, notes: e.notes, repeat: e.repeat, count: e.count ?? 0, until: e.until ?? '', where: e.where ?? '', remind: e.remind, project: e.project ?? '' });

test('calendar (.ics): random events written and read back are the same events, and writing again gives the same text', () => {
  const bad: string[] = [];
  for (const seed of seeds(7)) {
    const rng = new Rng(seed);
    const events = Array.from({ length: rng.int(1, 6) }, (_, i) => randomEvent(rng, i));
    const text1 = writeIcs(events);
    const back = parseIcs(text1);
    try {
      assert.deepEqual(back.map(seen), events.map(seen));
    } catch (e) {
      bad.push(`seed=${seed}: the events read back differ:\n${String((e as Error).message).split('\n').slice(0, 24).join('\n')}`);
      continue;
    }
    const text2 = writeIcs(back);
    if (text2 !== text1) bad.push(`seed=${seed}: writing the events read back gives a different file:\n${diffLines(text1, text2)}`);
  }
  assert.ok(bad.length === 0, `${bad.length} of ${ROUNDS} calendars did not round-trip:\n${bad.slice(0, 3).join('\n\n')}`);
});

function diffLines(a: string, b: string): string {
  const la = a.split('\r\n');
  const lb = b.split('\r\n');
  const out: string[] = [];
  for (let i = 0; i < Math.max(la.length, lb.length) && out.length < 8; i++) if (la[i] !== lb[i]) out.push(`  line ${i + 1}:\n    was: ${la[i]}\n    now: ${lb[i]}`);
  return out.join('\n');
}

function randomContact(rng: Rng, i: number): Contact {
  return {
    uid: `c-${i}-${rng.int(0, 1e9)}`,
    name: rng.chance(0.3) ? rng.pick(FREE_TEXT) : text(rng, 3),
    org: rng.chance(0.5) ? rng.pick(['Example, Inc', 'A;B', 'Ünïcödé 😀', text(rng, 3)]) : '',
    phones: Array.from({ length: rng.int(0, 3) }, () => rng.pick(['+61 400 000 000', '(02) 1234 5678', '123;456', 'ext, 9', '☎ 1'])),
    emails: Array.from({ length: rng.int(0, 3) }, () => rng.pick(['ann@example.com', 'a;b@example.com', 'x,y@example.com', 'ünï@exämple.com'])),
    address: rng.chance(0.5) ? rng.pick(['1 High St, Town 2000', 'Flat 2;3 Road', 'line one\nline two', 'x'.repeat(300)]) : '',
    birthday: rng.chance(0.5) ? day(rng) : '',
    notes: rng.chance(0.5) ? rng.pick(FREE_TEXT) : '',
  };
}

const seenContact = (c: Contact) => ({ uid: c.uid, name: c.name, org: c.org, phones: c.phones, emails: c.emails, address: c.address, birthday: c.birthday, notes: c.notes });

test('contacts (.vcf): random cards written and read back are the same cards, and writing again gives the same text', () => {
  // The Contacts form puts no limit on what is typed (src/apps/contacts.ts:103), so whatever it saves must read back whole.
  const bad: string[] = [];
  for (const seed of seeds(8)) {
    const rng = new Rng(seed);
    const cards = Array.from({ length: rng.int(1, 6) }, (_, i) => randomContact(rng, i));
    const text1 = writeVcf(cards);
    const back = parseVcf(text1);
    try {
      assert.deepEqual(back.map(seenContact), cards.map(seenContact));
    } catch (e) {
      bad.push(`seed=${seed}: the cards read back differ:\n${String((e as Error).message).split('\n').slice(0, 24).join('\n')}`);
      continue;
    }
    const text2 = writeVcf(back);
    if (text2 !== text1) bad.push(`seed=${seed}: writing the cards read back gives a different file:\n${diffLines(text1, text2)}`);
  }
  assert.ok(bad.length === 0, `${bad.length} of ${ROUNDS} contact files did not round-trip:\n${bad.slice(0, 3).join('\n\n')}`);
});

// ---- CAD (.tcad and .dxf) ---------------------------------------------------------------------------------------------------------------

const num = (rng: Rng) => rng.pick([0, 1, -1, 0.5, 12.345678901, -987.654321, 1e-6, 1e6, 3.14159265358979, 100, 7.25]) * (rng.chance(0.3) ? rng.next() : 1);
const pt = (rng: Rng) => P(num(rng), num(rng));

function randomDrawing(rng: Rng): Drawing {
  const d = newDrawing(rng.chance(0.5) ? 'mm' : 'inch');
  const layerNames = d.layers.map(l => l.name);
  if (rng.chance(0.5)) {
    d.layers.push({ name: rng.pick(['Walls', 'a b', 'Ünï 😀', 'x'.repeat(64), 'lower']), colour: '#ff8040', on: rng.chance(0.8), locked: rng.chance(0.2), lineType: rng.pick(['continuous', 'dashed', 'centre', 'hidden', 'dotted']) });
    layerNames.push(d.layers[d.layers.length - 1].name);
  }
  let id = 1;
  for (let i = rng.int(1, 12); i > 0; i--) {
    const layer = rng.pick(layerNames);
    const r = rng.next();
    let s: Ent;
    if (r < 0.2) s = { id: id++, layer, type: 'line', a: pt(rng), b: pt(rng) };
    else if (r < 0.35) s = { id: id++, layer, type: 'circle', c: pt(rng), r: Math.abs(num(rng)) + 0.001 };
    else if (r < 0.5) {
      const a0 = rng.next() * 6.28;
      s = { id: id++, layer, type: 'arc', c: pt(rng), r: Math.abs(num(rng)) + 0.001, a0, a1: a0 + 0.01 + rng.next() * 6.2 };
    } else if (r < 0.65) {
      const n = rng.int(2, 8);
      s = { id: id++, layer, type: 'poly', pts: Array.from({ length: n }, () => pt(rng)), bulges: Array.from({ length: n }, () => (rng.chance(0.5) ? 0 : rng.next() * 2 - 1)), closed: rng.chance(0.5) };
    } else if (r < 0.75) s = { id: id++, layer, type: 'spline', fit: Array.from({ length: rng.int(2, 6) }, () => pt(rng)), closed: rng.chance(0.3) };
    else if (r < 0.8) s = { id: id++, layer, type: 'ellipse', c: pt(rng), m: P(Math.abs(num(rng)) + 0.01, 0), ratio: 0.1 + rng.next() * 0.9, t0: 0, t1: rng.chance(0.5) ? 6.283185307179586 : 1 + rng.next() * 4 };
    else if (r < 0.85) s = { id: id++, layer, type: 'point', p: pt(rng) };
    else if (r < 0.9) s = { id: id++, layer, type: 'xline', p: pt(rng), d: P(0.6, 0.8) };
    else if (r < 0.95) s = { id: id++, layer, type: 'text', p: pt(rng), text: rng.pick(['Hello', 'Ø12 ±0.1 90°', 'a "quoted" b', 'é 😀', '%%d literal', 'x'.repeat(500), 'two\nlines']), h: Math.abs(num(rng)) + 0.1, angle: rng.next() * 6.28, align: rng.pick(['left', 'centre', 'right']) };
    else s = { id: id++, layer, type: 'dim', kind: 'linear', pts: [pt(rng), pt(rng), pt(rng)], dir: 0, h: 3.5, arrow: 2.5, dp: rng.int(0, 4), text: rng.chance(0.5) ? '' : 'override' };
    d.ents.push(s);
  }
  return d;
}

const sansIds = (d: Drawing) => d.ents.map(({ id: _id, ...rest }) => rest);

test('CAD Draft (.tcad): a random drawing written and read back is the same drawing, and writing again is stable', () => {
  for (const seed of seeds(9)) {
    const d = randomDrawing(new Rng(seed));
    const text1 = writeTcad(d);
    const back = readTcad(text1);
    assert.equal(back.damaged, 0, `seed=${seed}: the file CAD Draft just wrote reads back damaged: ${back.why}`);
    assert.equal(back.skipped, 0, `seed=${seed}: items skipped from the file CAD Draft just wrote`);
    assert.deepEqual(sansIds(back.drawing), sansIds(d), `seed=${seed}: the items differ after a round trip`);
    assert.deepEqual(back.drawing.layers, d.layers, `seed=${seed}: the layers differ after a round trip`);
    assert.equal(back.drawing.units, d.units);
    // Compared as data: the order of an item's keys is not content.
    assert.deepEqual(JSON.parse(writeTcad(back.drawing)), JSON.parse(text1), `seed=${seed}: writing the drawing read back gives a different file`);
  }
});

const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

test('DXF: lines, circles, arcs, polylines, points and text written to DXF and read back are the same within tolerance', () => {
  const bad: string[] = [];
  for (const seed of seeds(10)) {
    const d = randomDrawing(new Rng(seed));
    // Only shapes DXF R12 holds exactly; everything else (ellipses, splines, dimensions, construction lines) the writer
    // itself says it changes or leaves out, which cad-dxf-losses.test.ts covers.
    d.ents = d.ents.filter(e => ['line', 'circle', 'arc', 'poly', 'point', 'text'].includes(e.type));
    for (const l of d.layers) l.on = true;
    if (!d.ents.length) continue;
    const written = writeDxf(d, { textAsLines: false, construction: false, hidden: true });
    const back = readDxf(written.bytes);
    if (back.drawing.ents.length !== d.ents.length) {
      bad.push(`seed=${seed}: ${d.ents.length} items written, ${back.drawing.ents.length} read back (${back.report.join(' | ')})`);
      continue;
    }
    const tol = d.units === 'mm' ? 1e-6 : 1e-7;
    d.ents.forEach((e, i) => {
      const r = back.drawing.ents[i];
      if (r.type !== e.type) return bad.push(`seed=${seed}: item ${i} was a ${e.type}, came back a ${r.type}`);
      if (e.type === 'line' && r.type === 'line' && !(near(e.a.x, r.a.x, tol) && near(e.a.y, r.a.y, tol) && near(e.b.x, r.b.x, tol) && near(e.b.y, r.b.y, tol))) bad.push(`seed=${seed}: line ${i} moved`);
      if (e.type === 'circle' && r.type === 'circle' && !(near(e.c.x, r.c.x, tol) && near(e.c.y, r.c.y, tol) && near(e.r, r.r, tol))) bad.push(`seed=${seed}: circle ${i} moved or resized (${e.r} -> ${r.r})`);
      if (e.type === 'arc' && r.type === 'arc' && !(near(e.r, r.r, tol) && near(e.c.x, r.c.x, tol))) bad.push(`seed=${seed}: arc ${i} moved or resized`);
      if (e.type === 'poly' && r.type === 'poly') {
        if (r.pts.length !== e.pts.length || r.closed !== e.closed) bad.push(`seed=${seed}: polyline ${i} has ${r.pts.length} points (was ${e.pts.length}), closed ${r.closed} (was ${e.closed})`);
        else e.pts.forEach((p, k) => { if (!near(p.x, r.pts[k].x, tol) || !near(p.y, r.pts[k].y, tol)) bad.push(`seed=${seed}: polyline ${i} point ${k} moved`); });
        e.bulges.forEach((b, k) => { if (k < e.pts.length - (e.closed ? 0 : 1) && !near(b, r.bulges[k] ?? 0, 1e-6)) bad.push(`seed=${seed}: polyline ${i} bulge ${k} changed (${b} -> ${r.bulges[k]})`); });
      }
      if (e.type === 'text' && r.type === 'text') {
        const expect = e.text.replace(/[\r\n]+/g, ' ');
        // Letters R12 cannot hold (emoji) become "?": allowed only if the writer's notes say so.
        const lossy = /[^\u0000-ÿ€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]/.test(expect);
        if (r.text !== expect && !(lossy && written.notes.some(n => /letter|character|\?/.test(n)))) bad.push(`seed=${seed}: text ${i} changed: ${JSON.stringify(expect).slice(0, 60)} -> ${JSON.stringify(r.text).slice(0, 60)}${lossy ? ` (notes: ${written.notes.join(' | ')})` : ''}`);
        if (!near(e.h, r.h, tol)) bad.push(`seed=${seed}: text ${i} height ${e.h} -> ${r.h}`);
      }
    });
    // Layers: every used layer must come back (R12 writes names in capitals, which the writer says).
    const usedLayers = new Set(d.ents.map(e => e.layer.toUpperCase().replace(/[^A-Z0-9$_-]/g, '_').slice(0, 31)));
    for (const name of usedLayers) if (!back.drawing.layers.some(l => l.name.toUpperCase() === name) && !written.notes.some(n => /layer/i.test(n))) bad.push(`seed=${seed}: layer ${name} missing after the trip`);
  }
  assert.ok(bad.length === 0, `${bad.length} finding(s) in ${ROUNDS} drawings:\n${bad.slice(0, 10).join('\n')}`);
});

// ---- Zip -------------------------------------------------------------------------------------------------------------------------------

test('zip: files with every kind of name and content, stored and packed, come back byte for byte', async () => {
  for (const seed of seeds(11)) {
    const rng = new Rng(seed);
    const names = new Set<string>();
    const entries = Array.from({ length: rng.int(1, 12) }, () => {
      let name = rng.pick(['a.txt', 'docs/b.bin', 'Ünï 😀/c.md', 'deep/er/still/d', 'spaces in name.txt', "quote's.txt", 'x'.repeat(200) + '.txt', 'dot.', 'UPPER.TXT', 'é.txt']);
      while (names.has(name)) name = `${rng.int(0, 999)}-${name}`;
      names.add(name);
      return { name, data: rng.chance(0.2) ? new Uint8Array(0) : rng.bytes(rng.int(1, 5000)), modified: Date.UTC(rng.int(1980, 2100), rng.int(0, 11), rng.int(1, 28)) };
    });
    for (const zip of [zipStore(entries), await zipDeflate(entries)]) {
      const back = readZip(zip);
      assert.equal(back.length, entries.length, `seed=${seed}: ${entries.length} files in, ${back.length} out`);
      for (let i = 0; i < entries.length; i++) {
        const want = entries[i];
        const got = back[i];
        // Names come back cleaned (safeParts): the same cleaning applied to what went in must match.
        assert.equal(got.parts.join('/'), want.name.normalize('NFC').split('/').map(p => p.replace(/\.+$/, '')).join('/'), `seed=${seed}: name ${i} changed`);
        assert.deepEqual(await got.read(), want.data, `seed=${seed}: the bytes of ${want.name} changed`);
      }
    }
  }
});

test('zip: text inside an archive is not re-encoded (bytes are bytes)', async () => {
  const data = enc('é 😀 שלום \u0000\u0001 \r\n');
  const [e] = readZip(zipStore([{ name: 'x.txt', data, modified: 0 }]));
  assert.deepEqual(await e.read(), data);
});
