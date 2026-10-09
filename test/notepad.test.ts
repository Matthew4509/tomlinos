// Notepad's text sums: line endings kept, caret position, go to line, find (both ways, wrapping) and replace all.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectEol, findNext, lineCol, lineStart, replaceAll, toBox, toFile } from '../src/apps/notepad/text.ts';

test('a Windows file keeps its CRLF endings through the text box', () => {
  const file = 'one\r\ntwo\r\nthree';
  const eol = detectEol(file);
  assert.equal(eol, '\r\n');
  assert.equal(toFile(toBox(file), eol), file);
  assert.equal(detectEol('a\nb\nc\r\nd'), '\n');
  assert.equal(detectEol('no endings', '\n'), '\n');
});

test('line and column, and where a line starts', () => {
  const t = 'ab\ncde\nf';
  assert.deepEqual(lineCol(t, 0), { line: 1, col: 1 });
  assert.deepEqual(lineCol(t, 5), { line: 2, col: 3 });
  assert.equal(lineStart(t, 1), 0);
  assert.equal(lineStart(t, 3), 7);
  assert.equal(lineStart(t, 99), 7);
});

test('find goes forward and back, skips the current match, and wraps round', () => {
  const t = 'cat Cat cat';
  assert.deepEqual(findNext(t, 'cat', 0, { matchCase: true }), { start: 0, end: 3, wrapped: false });
  assert.deepEqual(findNext(t, 'cat', 3, { matchCase: true }), { start: 8, end: 11, wrapped: false });
  assert.deepEqual(findNext(t, 'cat', 11, { matchCase: true }), { start: 0, end: 3, wrapped: true });
  assert.deepEqual(findNext(t, 'cat', 3, { matchCase: false }), { start: 4, end: 7, wrapped: false });
  assert.deepEqual(findNext(t, 'cat', 11, { matchCase: true, backwards: true }), { start: 8, end: 11, wrapped: false });
  assert.deepEqual(findNext(t, 'cat', 8, { matchCase: true, backwards: true }), { start: 0, end: 3, wrapped: false });
  assert.deepEqual(findNext(t, 'cat', 0, { matchCase: true, backwards: true }), { start: 8, end: 11, wrapped: true });
  assert.equal(findNext(t, 'dog', 0, { matchCase: true }), null);
});

test('replace all treats the search as plain text and counts', () => {
  assert.deepEqual(replaceAll('a.b a.b axb', 'a.b', '$1', true), { text: '$1 $1 axb', count: 2 });
  assert.deepEqual(replaceAll('Cat cat', 'cat', 'dog', false), { text: 'dog dog', count: 2 });
});
