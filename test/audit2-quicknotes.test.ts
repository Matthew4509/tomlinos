// Round-2 audit of Quick Notes' text sums (src/apps/notepad/text.ts) and the Save as naming it uses. A failing test
// names a P0 still open; P1 and P2 faults are marked todo. Run: node --test test/audit2-quicknotes.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectEol, fileBytes, fileSize, findNext, lineCol, replaceAll, toBox, toFile, type Eol } from '../src/apps/notepad/text.ts';
import { finalSaveName, startingType, typeChoices } from '../src/shell/picktypes.ts';

// The same list editor.ts passes to the Save as window.
const SAVE_TYPES = typeChoices([
  { label: 'Text document', ext: ['txt'] },
  { label: 'Markdown', ext: ['md'] },
  { label: 'Log file', ext: ['log'] },
  { label: 'CSV', ext: ['csv'] },
  { label: 'All files', ext: [] },
], undefined, true);

test('QN-r1: a file with one kind of line ending comes back byte for byte (box and back)', () => {
  for (const [file, eol] of [['a\r\nb\r\n', '\r\n'], ['a\nb\n', '\n'], ['a\rb\r', '\r'], ['no ending', '\n']] as [string, Eol][]) {
    const found = detectEol(file, '\n');
    assert.equal(found, eol, JSON.stringify(file));
    assert.equal(toFile(toBox(file), found), file);
  }
});

test('QN-r1: the status-bar size equals the bytes written, for BOM, CRLF, astral and lone surrogates', () => {
  for (const s of ['', 'a\nb', 'Zoë 👩‍👩‍👧 שלום', 'half \ud800 pair', 'x\udc00', ' \n\n']) {
    for (const eol of ['\r\n', '\n', '\r'] as Eol[]) {
      for (const bom of [true, false]) assert.equal(fileSize(s, eol, bom), fileBytes(s, eol, bom).length, `${JSON.stringify(s)} ${JSON.stringify(eol)} ${bom}`);
    }
  }
});

test('QN-3: Find and Replace all agree on what a case-blind search matches', { todo: 'P1' }, () => {
  for (const [hay, query] of [['i', 'İ'], ['𐐨', '𐐀'], ['ß', 'ẞ'], ['ς', 'Σ']]) {
    const found = findNext(hay, query, 0, { matchCase: false }) !== null;
    const replaced = replaceAll(hay, query, 'X', false).count > 0;
    assert.equal(replaced, found, `${JSON.stringify(query)} in ${JSON.stringify(hay)}: find ${found}, replace all ${replaced}`);
  }
});

test('QN-5: a case-blind Find next in a 4.9 MB text answers within 300 ms', { todo: 'P1' }, () => {
  const line = 'The quick brown fox jumps over the lazy dog. ';
  const text = line.repeat(Math.floor(4.9e6 / line.length));
  const t = performance.now();
  findNext(text, 'zzz', 0, { matchCase: false });
  const ms = performance.now() - t;
  assert.ok(ms < 300, `took ${Math.round(ms)} ms`);
});

test('QN-4: Save as of a file Quick Notes opened keeps its name (conf.json, README), no ".txt" added', { todo: 'P1' }, () => {
  for (const name of ['conf.json', 'README', 'notes.ini']) {
    const index = startingType(SAVE_TYPES, name);
    assert.equal(finalSaveName(name, SAVE_TYPES, index).name, name);
  }
});

test('QN-16: the status-bar column after an emoji counts it as one letter', { todo: 'P2' }, () => {
  const text = '😀x';
  assert.equal(lineCol(text, text.length).col, 3);
});

test('QN-12: a file with mixed line endings saved unchanged keeps its bytes', { todo: 'P2' }, () => {
  const file = 'a\r\nb\nc\r\n';
  assert.equal(toFile(toBox(file), detectEol(file, '\n')), file);
});
