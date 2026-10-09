// The lock screen's disguise settings: kept with the person's files, read back safely (unknown looks and kinds are
// ignored, words are trimmed and held to a short length, an empty word keeps the default), and the spreadsheet's title
// is the person's own or its kind's usual one. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultLock, LOCK_WORDS_MAX, parseSession } from '../src/shell/session.ts';
import { sheetTitle } from '../src/auth/fakesheet.ts';

test('a new desktop: TOMLIN OS look, the budget spreadsheet, the usual words', () => {
  const l = defaultLock();
  assert.equal(l.look, 'default');
  assert.deepEqual(l.sheet, { kind: 'budget', title: '' });
  assert.deepEqual(l.words, { title: 'Sign in', user: 'Username', pass: 'Password', button: 'Continue' });
});

test('the disguise settings read back, and damaged ones are ignored', () => {
  const l = parseSession({ lock: { saver: 'reader', look: 'custom', words: { title: '  Budget   Portal ', user: 'Staff ID', pass: 'Access code', button: '' }, sheet: { kind: 'stock', title: 'Warehouse count' } } }).lock;
  assert.equal(l.saver, 'reader');
  assert.equal(l.look, 'custom');
  assert.deepEqual(l.words, { title: 'Budget Portal', user: 'Staff ID', pass: 'Access code', button: 'Continue' }, 'an empty word keeps the default');
  assert.deepEqual(l.sheet, { kind: 'stock', title: 'Warehouse count' });
  const bad = parseSession({ lock: { saver: 'movie', look: 'invisible', words: { title: 'x'.repeat(500), user: 7 }, sheet: { kind: 'secrets', title: 42 } } }).lock;
  assert.equal(bad.saver, 'reader', 'a damaged choice falls back to the default, the Reader');
  assert.equal(parseSession({ lock: { saver: 'sheet' } }).lock.saver, 'reader', 'the old default, never chosen, becomes the Reader');
  assert.equal(parseSession({ lock: { saver: 'sheet', chosen: true } }).lock.saver, 'sheet', 'a spreadsheet the person chose stays');
  assert.equal(bad.look, 'default');
  assert.equal(bad.words.title.length, LOCK_WORDS_MAX, 'a heading, not a paragraph');
  assert.equal(bad.words.user, 'Username');
  assert.deepEqual(bad.sheet, { kind: 'budget', title: '' });
});

test('the spreadsheet is called what the person chose, or its kind\'s usual title', () => {
  assert.equal(sheetTitle('budget', ''), 'Q3 Budget');
  assert.equal(sheetTitle('timesheet', '   '), 'Timesheet');
  assert.equal(sheetTitle('sales', 'Board pack'), 'Board pack');
});
