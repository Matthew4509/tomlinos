// Notepad Pro's markdown preview (with the real Lezer parser from the CodeMirror bundle) and find in files.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, safeHref, type MarkdownParser, type MdNode } from '../src/apps/notepadpro/markdown.ts';
import { searchText } from '../src/apps/notepadpro/findfiles.ts';

// Loaded by address, as the app does (the bundle has no type file).
const bundle = new URL('../public/vendor/codemirror.js', import.meta.url).href;
const cm = await import(bundle);
const parser = (cm.markdownParser as { configure(x: unknown): MarkdownParser }).configure(cm.GFM);
const md = (text: string) => renderMarkdown(text, parser);

/** A compact text form of the tree, for comparing. */
function show(nodes: MdNode[]): string {
  return nodes.map(n => (typeof n === 'string' ? n : `<${n.tag}${Object.entries(n.attrs ?? {}).map(([k, v]) => ` ${k}="${v}"`).join('')}>${show(n.kids)}</${n.tag}>`)).join('');
}

test('headings, emphasis, code, lists', () => {
  assert.equal(show(md('# Title\n\nSome *soft* and **bold** `x < y`.')), '<h1>Title</h1><p>Some <em>soft</em> and <strong>bold</strong> <code>x < y</code>.</p>');
  assert.equal(show(md('- one\n- two')), '<ul><li><p>one</p></li><li><p>two</p></li></ul>');
  assert.equal(show(md('3. three\n4. four')), '<ol start="3"><li><p>three</p></li><li><p>four</p></li></ol>');
  assert.equal(show(md('```js\nlet a = 1;\n```')), '<pre><code>let a = 1;</code></pre>');
});

test('HTML inside markdown is shown as letters, never made into elements', () => {
  const tree = md('Hi <script>alert(1)</script> there <img src=x onerror=alert(1)>\n\n<iframe src="x"></iframe>\n\n<style>body{}</style>');
  const tags: string[] = [];
  const walk = (ns: MdNode[]) => ns.forEach(n => typeof n !== 'string' && (tags.push(n.tag), walk(n.kids)));
  walk(tree);
  assert.deepEqual([...new Set(tags)].sort(), ['p', 'pre'], 'only a paragraph and the shown-as-text blocks');
  const out = show(tree);
  assert.ok(out.includes('<pre class="md-html"><iframe src="x"></iframe></pre>'), out);
  assert.ok(out.includes('Hi <script>alert(1)</script> there'), out);
});

test('links only to http, https and mailto; javascript: stays text', () => {
  assert.equal(show(md('[ok](https://example.com)')), '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer">ok</a></p>');
  assert.equal(show(md('[bad](javascript:alert(1))')), '<p>bad</p>');
  assert.equal(safeHref('JAVASCRIPT:x'), null);
  assert.equal(safeHref('data:text/html,x'), null);
  assert.equal(safeHref('mailto:a@b.c'), 'mailto:a@b.c');
});

test('pictures are described, not fetched; tables and task lists', () => {
  assert.equal(show(md('![a cat](http://x/cat.png)')), '<p><span class="md-image">[picture: a cat]</span></p>');
  assert.equal(show(md('| a | b |\n|---|---|\n| 1 | 2 |')), '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>');
  assert.equal(show(md('- [x] done')), '<ul><li><input type="checkbox" disabled="" checked=""></input> done</li></ul>');
});

test('entities and escapes', () => {
  assert.equal(show(md('a &amp; b \\* c &#65;')), '<p>a & b * c A</p>');
});

test('find in files: plain, match case, regex; bad regex explained', () => {
  const text = 'alpha\nBeta beta\ngamma';
  assert.deepEqual(searchText(text, 'beta', { matchCase: false, regex: false }).map(h => [h.line, h.col]), [[2, 1], [2, 6]]);
  assert.deepEqual(searchText(text, 'beta', { matchCase: true, regex: false }).map(h => [h.line, h.col]), [[2, 6]]);
  assert.deepEqual(searchText(text, '^g\\w+', { matchCase: true, regex: true }).map(h => h.text), ['gamma']);
  assert.throws(() => searchText(text, '(', { matchCase: true, regex: true }), /pattern/);
  assert.equal(searchText('aaaa', 'a*', { matchCase: true, regex: true }).length <= 5, true, 'empty matches do not loop');
});
