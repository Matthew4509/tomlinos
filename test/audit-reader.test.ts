// Audit of the Reader's book parser (public/reader/library.js, parseGutenberg) and how book files are routed
// (src/shell/filetypes.ts), without a browser. The browser half is test/browser-audit-reader.mjs. Tests marked todo
// are P1 findings.
// Run: node --test test/audit-reader.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileTypeOf } from '../src/shell/filetypes.ts';

// library.js is a browser module: it reads a meta tag and listens for messages when it loads.
const g = globalThis as Record<string, unknown>;
g.document ??= { querySelector: () => null };
if (!g.window) {
  const win: Record<string, unknown> = { addEventListener() {} };
  win.parent = win;
  g.window = win;
}
// @ts-expect-error plain JavaScript module with no types
const { parseGutenberg } = await import('../public/reader/library.js');

const START = '*** START OF THE PROJECT GUTENBERG EBOOK TEST ***\n\n';
const END = '\n*** END OF THE PROJECT GUTENBERG EBOOK TEST ***\n';
const PARA = 'Some words of text here in a line of the book.\n'.repeat(7);

// RD-P0-1: the contents-list check compares every heading with every later one (and cleans both each time), so a
// book with a few thousand headings (letters, a dictionary, verses) freezes the Reader, and the whole desktop with
// it, for seconds: 3000 headings take about 7 s, 5000 about 24 s.
test('a book with 3000 chapter headings is cut into chapters in well under a second', () => {
  let text = START;
  for (let i = 1; i <= 3000; i++) text += `\nLETTER ${i}. To my sister\n\n${PARA}`;
  const t0 = performance.now();
  const { chapters } = parseGutenberg(text + END);
  const ms = performance.now() - t0;
  assert.equal(chapters.length, 3000);
  assert.ok(ms < 1000, `took ${Math.round(ms)} ms`);
});

// RD-P0-2: a text with no blank lines (one paragraph a line, as some Gutenberg files are) is never cut into parts,
// since a part may start only after a blank line. The whole book becomes one "Part 1": in the browser a 3.8 MB book
// took 22 s to open with the desktop frozen, and is 3390 pages in one chapter.
test('a book with no blank lines is still cut into parts', () => {
  let text = START;
  for (let i = 0; i < 20000; i++) text += `A line of prose with no blank line after it, number ${i}.\n`;
  const { chapters } = parseGutenberg(text + END);
  assert.ok(chapters.length > 10, `${chapters.length} part(s)`);
});

// Works now: an ordinary book is cut at its headings and the contents list is not taken for chapters.
test('an ordinary book: headings found, contents list skipped', () => {
  let text = `${START}CONTENTS\n\nCHAPTER I. The Start\n\nCHAPTER II. The End\n\n`;
  text += `\nCHAPTER I. The Start\n\n${PARA}\nCHAPTER II. The End\n\n${PARA}`;
  const { chapters } = parseGutenberg(text + END);
  assert.deepEqual(chapters.map((c: { title: string }) => c.title).slice(-2), ['Chapter I. The Start', 'Chapter II. The End']);
});

// RD-P1-1: up to three lines before the first heading (a dedication, an epigraph, "Transcriber's note") are dropped
// without a word: there is no "Opening pages" for them and no chapter starts at line 0.
test('the lines before the first chapter heading are not lost', { todo: 'P1' }, () => {
  const text = `${START}To my dear wife.\n\nCHAPTER I.\n\n${PARA}\nCHAPTER II.\n\n${PARA}${END}`;
  const { chapters } = parseGutenberg(text);
  assert.equal(chapters[0].line, 0, 'the first chapter starts at the top of the book');
});

// RD-P1-2: a stray END marker above the START marker (seen in hand-made and badly joined files) leaves no book at all.
test('an END marker above the START marker does not empty the book', { todo: 'P1' }, () => {
  const text = '*** END OF THE PROJECT GUTENBERG EBOOK OLD ***\nnotes\n*** START OF THE PROJECT GUTENBERG EBOOK X ***\nThe whole book.\n';
  const { lines } = parseGutenberg(text);
  assert.ok(lines.some((l: string) => l.includes('The whole book')));
});

// RD-P1-3: there is no EPUB support anywhere: an .epub in the person's files is "EPUB file" with no app, and the
// Reader cannot open a file from the files at all (it reads only its own library and Gutenberg).
test('an .epub opens in the Reader', { todo: 'P1' }, () => {
  assert.ok(fileTypeOf('Book.epub').apps.includes('reader'));
});

// RD-P1-4: a book saved from the Reader is a .txt in Documents > Books, but double-clicking it opens Notepad: the Reader
// is not even offered for it.
test('a saved book in Documents > Books can be opened in the Reader', { todo: 'P1' }, () => {
  assert.ok(fileTypeOf('Pride and Prejudice - Jane Austen.txt').apps.includes('reader'));
});
