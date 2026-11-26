// Round-2 audit of Quick Notes' text sums (src/apps/notepad/text.ts) and the Save as naming it uses. A failing test
// names a P0 still open; P1 and P2 faults are marked todo. Run: node --test test/audit2-quicknotes.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cannotHold, decodeFile, detectEol, encodedSize, encodeFile, fileBytes, fileSize, findNext, keptEndings, lineCol, lineEndings, replaceAll, sameMatch,
  toBox, toFile, withEndings, type Encoding, type Eol,
} from '../src/apps/notepad/text.ts';
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

test('QN-3: Find and Replace all agree on what a case-blind search matches', () => {
  for (const [hay, query] of [['i', 'İ'], ['𐐨', '𐐀'], ['ß', 'ẞ'], ['ς', 'Σ']]) {
    const found = findNext(hay, query, 0, { matchCase: false }) !== null;
    const replaced = replaceAll(hay, query, 'X', false).count > 0;
    assert.equal(replaced, found, `${JSON.stringify(query)} in ${JSON.stringify(hay)}: find ${found}, replace all ${replaced}`);
  }
});

test('QN-5: a case-blind Find next in a 4.9 MB text answers within 300 ms', () => {
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

test('QN-16: the status-bar column after an emoji counts it as one letter', () => {
  const text = '😀x';
  assert.equal(lineCol(text, text.length).col, 3);
});

test('QN-16: a joined emoji and a letter with an accent mark are one column each', () => {
  for (const s of ['👩‍👩‍👧', 'é', '🇬🇧']) assert.equal(lineCol(s + 'x', s.length).col, 2, JSON.stringify(s));
  assert.deepEqual(lineCol('ab\n😀😀', 7), { line: 2, col: 3 });
});

/** What Quick Notes writes for box text `box` of a file opened as `file` (editor.ts: lineEndings, keptEndings, withEndings). */
const saveMixed = (file: string, box: string) => {
  const ends = lineEndings(file);
  assert.ok(ends, 'mixed endings noticed');
  const eol = detectEol(file, '\n');
  return withEndings(box, keptEndings(box, toBox(file), ends, eol), eol);
};

test('QN-12: a file with mixed line endings saved unchanged keeps its bytes', () => {
  for (const file of ['a\r\nb\nc\r\n', 'a\nb\rc\r\nd', '\r\n\n\r\n\n']) assert.equal(saveMixed(file, toBox(file)), file, JSON.stringify(file));
  assert.equal(lineEndings('a\r\nb\r\n'), null, 'one kind is not mixed');
  assert.equal(lineEndings('none'), null);
});

test('QN-12: an edit keeps the endings of the lines it did not touch', () => {
  const file = 'one\r\ntwo\nthree\r\nfour\nfive\r\n';
  // A letter added on line 3: every line keeps its own ending.
  assert.equal(saveMixed(file, 'one\ntwo\nthree!\nfour\nfive\n'), 'one\r\ntwo\nthree!\r\nfour\nfive\r\n');
  // A line put in after line 1: the new line gets the main kind (CRLF), the rest keep their own.
  assert.equal(saveMixed(file, 'one\nnew\ntwo\nthree\nfour\nfive\n'), 'one\r\nnew\r\ntwo\nthree\r\nfour\nfive\r\n');
  // Line 2 deleted.
  assert.equal(saveMixed(file, 'one\nthree\nfour\nfive\n'), 'one\r\nthree\r\nfour\nfive\r\n');
});

test('QN-9: UTF-16 files (with their mark) open as text and save back byte for byte', () => {
  for (const [encoding, bytes] of [
    ['utf-16le', [0xff, 0xfe, ...Buffer.from('héllo 😀\r\nzwei\r\n', 'utf16le')]],
    ['utf-16be', [0xfe, 0xff, ...Buffer.from('héllo 😀\r\nzwei\r\n', 'utf16le').swap16()]],
  ] as [Encoding, number[]][]) {
    const file = decodeFile(Uint8Array.from(bytes));
    assert.ok(file, encoding);
    assert.equal(file.encoding, encoding);
    assert.equal(file.text, 'héllo 😀\r\nzwei\r\n');
    assert.deepEqual([...encodeFile(file.text, file.encoding, file.bom)], bytes);
    assert.equal(encodedSize(file.text, file.encoding, file.bom), bytes.length);
  }
});

test('QN-9: a Windows-1252 ("ANSI") file opens as Windows-1252 and saves back byte for byte; a letter it cannot hold is named', () => {
  const bytes = [0x43, 0x61, 0x66, 0xe9, 0x20, 0x80, 0x35, 0x0d, 0x0a, 0x93, 0x71, 0x94, 0xa0, 0xff];
  const file = decodeFile(Uint8Array.from(bytes));
  assert.ok(file);
  assert.equal(file.encoding, 'windows-1252');
  assert.equal(file.text, 'Café €5\r\n“q” ÿ');
  assert.deepEqual([...encodeFile(file.text, 'windows-1252', false)], bytes);
  assert.equal(cannotHold(file.text, 'windows-1252'), null);
  assert.equal(cannotHold(file.text + '😀', 'windows-1252'), '😀');
  assert.equal(cannotHold('😀', 'utf-8'), null);
});

test('QN-9: real binaries are still refused; UTF-8 (with or without its mark) is still UTF-8', () => {
  assert.equal(decodeFile(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x01])), null);
  assert.equal(decodeFile(Uint8Array.from([0xff, 0xfe, 0x00, 0xd8])), null, 'a lone half of a pair in UTF-16');
  assert.equal(decodeFile(Uint8Array.from([0xff, 0xfe, 0x01, 0x00])), null, 'a control letter in UTF-16');
  assert.equal(decodeFile(Uint8Array.from([0xef, 0xbb, 0xbf, 0xe9])), null, 'a UTF-8 mark then bytes that are not UTF-8');
  assert.deepEqual(decodeFile(Uint8Array.from([0xef, 0xbb, 0xbf, 0x68, 0x69])), { text: 'hi', encoding: 'utf-8', bom: true });
  assert.deepEqual(decodeFile(new TextEncoder().encode('a\0b é')), { text: 'a\0b é', encoding: 'utf-8', bom: false });
});

test('QN-3: Replace (one) takes the selection Find chose, whatever the letters', () => {
  for (const [hay, query] of [['i', 'İ'], ['İ', 'i'], ['𐐨', '𐐀'], ['ß', 'ẞ'], ['ς', 'Σ'], ['K', 'k']]) {
    const hit = findNext(hay, query, 0, { matchCase: false });
    assert.ok(hit, `${query} in ${hay}`);
    assert.ok(sameMatch(hay.slice(hit.start, hit.end), query, false), `${query} in ${hay}`);
  }
  assert.equal(sameMatch('Cat', 'cat', true), false);
});

test('QN-5: Find next pressed again on the same 4.9 MB text does not fold it again', () => {
  const text = 'The quick brown fox jumps over the lazy dog. '.repeat(108000);
  findNext(text, 'zzz', 0, { matchCase: false });
  const t = performance.now();
  for (let i = 0; i < 10; i++) findNext(text, 'zzz', 0, { matchCase: false });
  assert.ok(performance.now() - t < 100, `ten presses took ${Math.round(performance.now() - t)} ms`);
});
