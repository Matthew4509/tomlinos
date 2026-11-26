// Audit of Notepad's text sums (src/apps/notepad/text.ts): find and Replace all must agree on what a match is, and the
// column in the status bar counts letters, not UTF-16 halves. Each test here failed when it was written.
// Run: node --test test/audit-notepad.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findNext, lineCol, replaceAll } from '../src/apps/notepad/text.ts';

test('audit: Replace all (no match case) replaces exactly what Find (no match case) finds', { todo: 'P1, waiting on direction' }, () => {
  // Find folds with toLocaleLowerCase one letter at a time; Replace all uses a /gi regex. They disagree on letters
  // such as the Greek final sigma and the Kelvin sign, so Replace all says it replaced matches Find never shows.
  for (const [text, query] of [['ς', 'σ'], ['K', 'k'], ['İ', 'i']]) {
    const found = findNext(text, query, 0, { matchCase: false }) !== null;
    const { count } = replaceAll(text, query, 'x', false);
    assert.equal(count > 0, found, `"${text}" for "${query}": find ${found ? 'finds it' : 'does not'}, Replace all counted ${count}`);
  }
});

test('audit: the column after an emoji counts it as one letter', { todo: 'P1, waiting on direction' }, () => {
  const t = 'a😀b';
  // The caret after the emoji (offset 3 in UTF-16) is in column 3, not 4.
  assert.deepEqual(lineCol(t, 3), { line: 1, col: 3 });
});
