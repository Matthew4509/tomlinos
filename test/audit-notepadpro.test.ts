// Audit of Notepad Pro's helpers: find in files with patterns that can match nothing, the Markdown preview's code
// blocks and reference links, and which files find in files reads. Each test here failed when it was written.
// Run: node --test test/audit-notepadpro.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { renderMarkdown, type MarkdownParser, type MdNode } from '../src/apps/notepadpro/markdown.ts';
import { isTextName } from '../src/apps/notepadpro/findfiles.ts';
import { LANGS } from '../src/apps/notepadpro/languages.ts';

const bundle = new URL('../public/vendor/codemirror.js', import.meta.url).href;
const cm = await import(bundle);
const parser = (cm.markdownParser as { configure(x: unknown): MarkdownParser }).configure(cm.GFM);
const md = (text: string) => renderMarkdown(text, parser);

/** The text inside every <code> of a tree. */
function codes(nodes: MdNode[]): string[] {
  const out: string[] = [];
  const walk = (ns: MdNode[]) => ns.forEach(n => {
    if (typeof n === 'string') return;
    if (n.tag === 'code') out.push(n.kids.filter(k => typeof k === 'string').join(''));
    else walk(n.kids);
  });
  walk(nodes);
  return out;
}

/** Runs searchText in a worker, so a search that never ends fails the test instead of hanging it. */
function searchInWorker(text: string, query: string, ms = 3000): Promise<number | 'hung'> {
  const url = new URL('../src/apps/notepadpro/findfiles.ts', import.meta.url).href;
  const code = `const { parentPort, workerData } = require('node:worker_threads');
    import(workerData.url).then(m => parentPort.postMessage(m.searchText(workerData.text, workerData.query, { matchCase: false, regex: true }).length));`;
  return new Promise((resolve, reject) => {
    const w = new Worker(code, { eval: true, workerData: { url, text, query } });
    const timer = setTimeout(() => void w.terminate().then(() => resolve('hung')), ms);
    w.once('message', n => (clearTimeout(timer), void w.terminate(), resolve(n as number)));
    w.once('error', e => (clearTimeout(timer), reject(e)));
  });
}

test('find in files: a pattern that can match nothing ends on text with an emoji (it looped for ever)', async () => {
  assert.equal(await searchInWorker('hi 😀 there', 'x*'), 0);
  assert.equal(await searchInWorker('😀', '\\d*'), 0);
  // The real matches around the emoji are still found.
  assert.equal(await searchInWorker('ab 😀 cd', '\\w*'), 2);
});

test('Markdown preview: an indented code block keeps single line breaks (each line came out doubled)', () => {
  assert.deepEqual(codes(md('    one\n    two\n    three')), ['one\ntwo\nthree']);
  assert.deepEqual(codes(md('    a\n\n    b')), ['a\n\nb']);
});

test('Markdown preview: a fenced code block in a quote or a list keeps single line breaks', () => {
  assert.deepEqual(codes(md('> ```\n> a\n> b\n> ```')), ['a\nb']);
  assert.deepEqual(codes(md('- ```\n  a\n  b\n  ```')), ['a\nb']);
});

test('Markdown preview: reference links ([text][name] with a [name]: address line) become links', { todo: 'P1, waiting on direction' }, () => {
  const tree = md('See [the site][s].\n\n[s]: https://example.com');
  const links: string[] = [];
  const walk = (ns: MdNode[]) => ns.forEach(n => typeof n !== 'string' && (n.tag === 'a' && links.push(n.attrs?.href ?? ''), walk(n.kids)));
  walk(tree);
  assert.deepEqual(links, ['https://example.com']);
});

test('find in files reads every kind of file Notepad Pro colours by its extension', { todo: 'P1, waiting on direction' }, () => {
  const missing = LANGS.flatMap(l => l.exts).filter(ext => !isTextName(`file.${ext}`));
  assert.deepEqual(missing, [], 'extensions Notepad Pro opens and colours, but find in files skips');
});
