// Write's page breaks: a known number of lines of a known height fill a page and the next line starts the next
// page exactly at its top margin; space already put in last time is taken back out first (so a second pass changes
// nothing); a page break sends what follows to a new page; a line already at the top of a page is never pushed on;
// and a document that shrinks loses its old spaces. Also the CSS and colour readers used when pasting.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bodyTop, paginate, type Geometry, type Unit } from '../src/apps/write/layout.ts';
import { lengthPt, lightness, paraAttrs, pastedHtml, readColour, readCss, readFace } from '../src/apps/write/schema.ts';
import { pageBox, defaultPage, cleanPage, marginProblem } from '../src/apps/write/model.ts';

// A4 at 96 pixels to the inch with 1 inch margins: 1123 tall, 96 top, 931 for the writing; 24 between sheets.
const g: Geometry = { pageH: 1123, top: 96, body: 931, gap: 24 };
const lines = (n: number, h = 20, from = 96): Unit[] => Array.from({ length: n }, (_, i) => ({ top: from + i * h, height: h, spacer: 0 }));

test('46 lines of 20 pixels fill an A4 page; the 47th starts page 2 at its top margin', () => {
  const units = lines(100);
  const r = paginate(units, g);
  assert.equal(r.pageOf[45], 0);
  assert.equal(r.pageOf[46], 1);
  // Line 47 was at 96 + 46 * 20 = 1016; page 2's writing starts at 1123 + 24 + 96 = 1243.
  assert.equal(r.spacers[46], 1243 - 1016);
  assert.equal(r.spacers.filter(s => s > 0).length, 2);
  assert.equal(r.pageOf[92], 2);
  assert.equal(r.count, 3);
  // Every page's first line is exactly at that page's top margin.
  let shift = 0;
  units.forEach((u, i) => {
    shift += r.spacers[i];
    if (r.spacers[i]) assert.equal(u.top + shift, bodyTop(g, r.pageOf[i]));
  });
});

test('a second pass over the laid-out lines changes nothing', () => {
  const units = lines(100);
  const first = paginate(units, g);
  // The lines as the screen now has them: each moved down by the spaces before it, with its own space recorded.
  let shift = 0;
  const after: Unit[] = units.map((u, i) => {
    const top = u.top + shift;
    shift += first.spacers[i];
    return { top, height: u.height, spacer: first.spacers[i] };
  });
  assert.deepEqual(paginate(after, g).spacers, first.spacers);
});

test('a page break sends the next line to a new page, and a line at the top of a page stays', () => {
  const units = lines(5);
  units[1].breakAfter = true;
  const r = paginate(units, g);
  assert.deepEqual(r.pageOf, [0, 0, 1, 1, 1]);
  assert.equal(r.spacers[2], bodyTop(g, 1) - units[2].top);
  // Taller than a whole page: it starts the page and runs over, rather than moving on forever.
  const tall: Unit[] = [{ top: 96, height: 2000, spacer: 0 }, { top: 2096, height: 20, spacer: 0 }];
  const t = paginate(tall, g);
  assert.equal(t.spacers[0], 0);
  assert.equal(t.pageOf[0], 0);
  assert.ok(t.pageOf[1] >= 1);
  // A page break as the last thing makes an empty page after it.
  assert.equal(paginate([{ top: 96, height: 20, spacer: 0, breakAfter: true }], g).count, 2);
});

test('when the document shrinks, old spaces are taken out', () => {
  // A line that had a space before it (page 2) now fits on page 1: no space, page 1.
  const units: Unit[] = [{ top: 96, height: 20, spacer: 0 }, { top: 116, height: 20, spacer: 300 }];
  const r = paginate(units, g);
  assert.deepEqual(r.spacers, [0, 0]);
  assert.deepEqual(r.pageOf, [0, 0]);
  assert.equal(r.count, 1);
});

test('the page box and page setup', () => {
  const a4 = pageBox(defaultPage('en-GB'));
  assert.equal(Math.round(a4.w), 794);
  assert.equal(Math.round(a4.h), 1123);
  assert.equal(a4.top, 96);
  const letter = defaultPage('en-US');
  assert.equal(letter.paper, 'letter');
  assert.equal(cleanPage({ paper: 'nonsense', orient: 'sideways', margins: { t: -1, l: 2 } }, letter).paper, 'letter');
  assert.equal(cleanPage({ margins: { t: -1, l: 2 } }, letter).margins.t, 1);
  assert.equal(cleanPage({ margins: { t: -1, l: 2 } }, letter).margins.l, 2);
  assert.match(marginProblem({ ...letter, margins: { ...letter.margins, l: 4, r: 4 } }) ?? '', /left and right/);
  assert.equal(marginProblem(letter), null);
});

test('pasted CSS: lengths, colours, typefaces and paragraph settings are read from the text', () => {
  assert.deepEqual(readCss('font-size: 14pt; COLOR: Red ; ;bad; mso-x:1 !important'), { 'font-size': '14pt', color: 'Red', 'mso-x': '1' });
  assert.equal(lengthPt('16px'), 12);
  assert.equal(lengthPt('0.5in'), 36);
  assert.equal(lengthPt('2.54cm'), 72);
  assert.equal(lengthPt('normal'), null);
  assert.equal(readColour('rgb(255, 0, 0)'), '#ff0000');
  assert.equal(readColour('#abc'), '#aabbcc');
  assert.equal(readColour('rgba(0,0,0,0)'), null);
  assert.equal(readColour('windowtext'), null);
  assert.ok(lightness('#ffffff') > 0.99 && lightness('#000000') < 0.01);
  assert.equal(readFace('"Segoe UI", system-ui, sans-serif'), 'Segoe UI');
  assert.equal(readFace('-apple-system, BlinkMacSystemFont'), null);
  assert.equal(readFace('"x</style><script>"'), null);
  assert.deepEqual(paraAttrs(readCss('text-align:center;margin-top:12pt;margin-bottom:0cm;line-height:150%;text-indent:-18pt;margin-left:36pt')), { align: 'center', before: 12, after: 0, line: 1.5, indent: 36, first: -18 });
});

test('pasted HTML: style blocks and comments go, style attributes are renamed (never applied), text is left alone', () => {
  const html = '<style>p{color:red}</style><!--[if gte mso 9]><xml>x</xml><![endif]--><p class=MsoNormal style="color:red" data-style="keep">a style=b <span STYLE = \'font-size:9pt\'>c</span></p>';
  const started = Date.now();
  pastedHtml('<style'.repeat(50000) + '<a '.repeat(100000) + '<!--'.repeat(50000));
  assert.ok(Date.now() - started < 1000, 'a crafted clipboard is cleaned quickly');
  assert.equal(pastedHtml(html), '<p class=MsoNormal data-wp-style="color:red" data-style="keep">a style=b <span data-wp-style = \'font-size:9pt\'>c</span></p>');
  // Event handlers are renamed too, so even the never-shown copy the paste is read from holds none (a browser may
  // report one there as a blocked script); "/" stands for a space between a tag's name and its attributes.
  assert.equal(pastedHtml('<img src=x onerror="go()"><img/ONLOAD=go()><p onclick = \'x\' data-on="keep">only=text</p>'),
    '<img src=x data-wp-onerror="go()"><img/data-wp-ONLOAD=go()><p data-wp-onclick = \'x\' data-on="keep">only=text</p>');
});

test('a kept part shown by Write has a token that brings it back on paste; a token Write never made brings nothing', async () => {
  const { keptToken, keptPart } = await import('../src/apps/write/schema.ts');
  const xml = '<w:r><mc:AlternateContent>a chart</mc:AlternateContent></w:r>';
  const token = keptToken(xml, 'Chart');
  assert.equal(keptToken(xml, 'Chart'), token, 'the same part, the same token');
  assert.notEqual(keptToken(xml, 'Chart 2'), token);
  assert.deepEqual(keptPart(token), { xml, label: 'Chart' });
  assert.equal(keptPart('made-up'), undefined);
  assert.equal(keptPart(null), undefined);
});
