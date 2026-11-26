// CAD Draft's SVG output: true size, a group per layer, exact arcs, circles, ellipses and Bézier curves, escaped
// text, hidden layers left out, nothing that runs or points outside the file. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { P, at, bulgeArc, curveThrough, type Pt } from '../src/apps/cad/geom.ts';
import { newDrawing, type Ent } from '../src/apps/cad/model.ts';
import { paperInk } from '../src/apps/cad/print.ts';
import { CAP_SHARE, svgNum, writeSvg, xmlEscape } from '../src/apps/cad/svg.ts';
import { sampleDrawing } from './cad-sample-drawing.ts';

const ALL = { white: false, textAsLines: false, construction: true };

interface El { name: string; attrs: Record<string, string>; text: string; children: El[] }

/** A strict little XML reader: throws on anything not well formed (unclosed or crossed tags, bad entities, unquoted values). */
function parseXml(src: string): El {
  let i = 0;
  const fail = (why: string): never => {
    throw new Error(`${why} at ${i}: ${src.slice(i, i + 40)}`);
  };
  const entity = (s: string) => {
    if (/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(s)) fail('a bare &');
    return s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[e]!);
  };
  if (src.startsWith('<?xml')) i = src.indexOf('?>') + 2;
  const root: El = { name: '#root', attrs: {}, text: '', children: [] };
  const stack = [root];
  while (i < src.length) {
    if (src[i] !== '<') {
      const end = src.indexOf('<', i);
      const t = src.slice(i, end < 0 ? src.length : end);
      if (t.includes('>')) fail('a bare >');
      stack.at(-1)!.text += entity(t);
      i = end < 0 ? src.length : end;
      continue;
    }
    if (src.startsWith('<!--', i)) {
      i = src.indexOf('-->', i) + 3;
      continue;
    }
    if (src[i + 1] === '/') {
      const m = /^<\/([\w:.-]+)\s*>/.exec(src.slice(i)) ?? fail('a bad end tag');
      const open = stack.pop()!;
      if (open.name !== m[1]) fail(`</${m[1]}> closes <${open.name}>`);
      i += m[0].length;
      continue;
    }
    const m = /^<([\w:.-]+)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>/.exec(src.slice(i)) ?? fail('a bad start tag');
    const attrs: Record<string, string> = {};
    for (const a of m[2].matchAll(/([\w:.-]+)="([^"]*)"/g)) {
      if (a[1] in attrs) fail(`${a[1]} twice`);
      attrs[a[1]] = entity(a[2]);
    }
    const el: El = { name: m[1], attrs, text: '', children: [] };
    stack.at(-1)!.children.push(el);
    if (!m[3]) stack.push(el);
    i += m[0].length;
  }
  if (stack.length !== 1) fail(`<${stack.at(-1)!.name}> is never closed`);
  if (root.children.length !== 1) fail('one root element');
  return root.children[0];
}

const all = (el: El): El[] => [el, ...el.children.flatMap(all)];
const numbers = (d: string) => (d.match(/-?\d+(\.\d+)?/g) ?? []).map(Number);
const near = (a: number, b: number, tol = 2e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} is ${b}`);
const nearPt = (x: number, y: number, p: Pt) => {
  near(x, p.x);
  near(y, -p.y);
};

test('well formed, true size, view box in drawing units, nothing that runs or reaches outside', () => {
  for (const units of ['mm', 'inch'] as const) {
    const w = writeSvg(sampleDrawing(units), { ...ALL, title: 'Kitchen <A&B>' });
    const svg = parseXml(w.text);
    assert.equal(svg.name, 'svg');
    const unit = units === 'mm' ? 'mm' : 'in';
    const [vx, vy, vw, vh] = svg.attrs.viewBox.split(' ').map(Number);
    assert.equal(svg.attrs.width, `${svgNum(vw)}${unit}`);
    assert.equal(svg.attrs.height, `${svgNum(vh)}${unit}`);
    // The drawing runs from x 0 to 600 and y -41.8 to 746 (text tops), with a 5 mm margin.
    const m = units === 'mm' ? 5 : 5 / 25.4;
    near(vx, -m);
    near(vw, 600 + 2 * m);
    near(vy, -(746 + m));
    near(vh, 746 + 41.8 + 2 * m);
    assert.equal(svg.children.find(c => c.name === 'title')!.text, 'Kitchen <A&B>');
    for (const bad of ['<script', 'href', 'url[(]', '<image', '<foreignObject', ' on[a-z]+=', '<style', '@import']) assert.doesNotMatch(w.text, new RegExp(bad, 'i'));
    // The only addresses are the two namespace names.
    assert.deepEqual([...w.text.matchAll(/https?:\/\/[^"]+/g)].map(x => x[0]), ['http://www.w3.org/2000/svg', 'http://www.inkscape.org/namespaces/inkscape']);
  }
});

test('each layer shown is a labelled group in its colour and line type; hidden layers are left out', () => {
  const d = sampleDrawing();
  const svg = parseXml(writeSvg(d, ALL).text);
  const groups = svg.children.filter(c => c.name === 'g');
  assert.deepEqual(groups.map(g => g.attrs['inkscape:label']), ['Geometry', 'Construction', 'Dimensions', 'Text', 'Cut outs']);
  assert.ok(groups.every(g => g.attrs['inkscape:groupmode'] === 'layer' && /^layer-[\w.-]+$/.test(g.attrs.id)));
  assert.equal(groups[4].attrs.id, 'layer-Cut-outs');
  assert.equal(groups[0].attrs.stroke, '#000000', 'white prints as black');
  assert.equal(groups[4].attrs.stroke, paperInk('#ff4040'));
  assert.equal(groups[0].attrs['stroke-dasharray'], undefined, 'continuous: no dashes');
  assert.equal(groups[1].attrs['stroke-dasharray'], '12.7 6.35', 'dashed, at the DXF line type sizes');
  assert.equal(groups[4].attrs['stroke-dasharray'], '31.75 6.35 6.35 6.35', 'centre');
  assert.doesNotMatch(writeSvg(d, ALL).text, /Hidden notes|y1="-800"/);
  assert.match(writeSvg(d, ALL).notes.join('\n'), /1 item on hidden layers left out/);
  // Inches: the dashes in inches too.
  const inch = parseXml(writeSvg(sampleDrawing('inch'), ALL).text).children.filter(c => c.name === 'g');
  assert.equal(inch[1].attrs['stroke-dasharray'], '0.5 0.25');
});

test('shapes are exact: lines, SVG arcs (not segments), native circles and ellipses, Bézier curves', () => {
  const d = sampleDrawing();
  const svg = parseXml(writeSvg(d, ALL).text);
  const geo = svg.children.find(g => g.attrs['inkscape:label'] === 'Geometry')!.children;
  const cut = svg.children.find(g => g.attrs['inkscape:label'] === 'Cut outs')!.children;
  // Line 0,0 to 600,0.
  assert.deepEqual(geo[0].attrs, { x1: '0', y1: '0', x2: '600', y2: '0' });
  // Arc: centre 300,200, r 50 from 0.25 to 2.5 radians anticlockwise: one A command, small, sweep 0.
  const arc = numbers(geo[1].attrs.d);
  assert.match(geo[1].attrs.d, /^M \S+ \S+ A 50 50 0 0 0 \S+ \S+$/);
  nearPt(arc[0], arc[1], P(300 + 50 * Math.cos(0.25), 200 + 50 * Math.sin(0.25)));
  nearPt(arc[7], arc[8], P(300 + 50 * Math.cos(2.5), 200 + 50 * Math.sin(2.5)));
  assert.deepEqual(geo[2].attrs, { cx: '100', cy: '-100', r: '35' });
  // Whole ellipse: native, turned the other way (the file's y runs down).
  const e = cut[0].attrs;
  assert.equal(cut[0].name, 'ellipse');
  near(Number(e.rx), Math.hypot(80, 30));
  near(Number(e.ry), Math.hypot(80, 30) * 0.5);
  assert.equal(e.transform, `rotate(${svgNum((-Math.atan2(30, 80) * 180) / Math.PI)} 400 -300)`);
  // Part ellipse: an elliptical arc from t0 to t1.
  const part = d.ents[4];
  assert.equal(part.type, 'ellipse');
  if (part.type === 'ellipse') {
    const pe = numbers(cut[1].attrs.d);
    const piece = { k: 'ell', c: part.c, m: part.m, ratio: part.ratio, t0: part.t0, t1: part.t1 } as const;
    nearPt(pe[0], pe[1], at(piece, part.t0));
    assert.deepEqual(pe.slice(2, 7), [40, 10, -90, 0, 0]);
    nearPt(pe[7], pe[8], at(piece, part.t1));
  }
  // Closed polyline with bulges: arcs for the bulged spans, Z to close.
  assert.match(geo[3].attrs.d, /^M 0 -400 L 200 -400 A \S+ \S+ 0 0 0 200 -500 L 0 -500 A \S+ \S+ 0 0 1 0 -400 Z$/);
  const r = numbers(geo[3].attrs.d)[4];
  near(r, 100 / (2 * Math.sin(2 * Math.atan(0.5))));
  // Each SVG arc's centre (worked out from its ends and flags, as the SVG rules do) is the drawing's, turned over.
  const centre = (x1: number, y1: number, rr: number, large: number, sweep: number, x2: number, y2: number) => {
    const hx = (x1 - x2) / 2;
    const hy = (y1 - y2) / 2;
    const k = (large !== sweep ? 1 : -1) * Math.sqrt(Math.max(0, (rr * rr - hx * hx - hy * hy) / (hx * hx + hy * hy)));
    return { x: k * hy + (x1 + x2) / 2, y: -k * hx + (y1 + y2) / 2 };
  };
  const c1 = centre(arc[0], arc[1], 50, arc[5], arc[6], arc[7], arc[8]);
  nearPt(c1.x, c1.y, P(300, 200));
  const poly = d.ents[5];
  assert.equal(poly.type, 'poly');
  if (poly.type === 'poly') {
    let arcs = 0;
    poly.pts.forEach((a, i) => {
      const b = poly.pts[(i + 1) % poly.pts.length];
      if (!poly.bulges[i]) return;
      const m = geo[3].attrs.d.match(new RegExp(`A (\\S+) \\S+ 0 (\\d) (\\d) ${svgNum(b.x)} ${svgNum(-b.y)}`))!;
      const c = centre(a.x, -a.y, Number(m[1]), Number(m[2]), Number(m[3]), b.x, -b.y);
      nearPt(c.x, c.y, bulgeArc(a, b, poly.bulges[i]).c);
      arcs++;
    });
    assert.equal(arcs, 2, 'both bulged spans, one bulging each way');
  }
  // Curves: one C per piece, the control points CAD Draft draws with.
  for (const [i, ent] of [[2, d.ents[7]], [3, d.ents[8]]] as const) {
    assert.equal(ent.type, 'spline');
    if (ent.type !== 'spline') continue;
    const bez = curveThrough(ent.fit, ent.closed);
    const path = cut[i].attrs.d;
    assert.equal((path.match(/C/g) ?? []).length, bez.length);
    const v = numbers(path);
    bez.forEach((b, j) => [b.p[1], b.p[2], b.p[3]].forEach((p, q) => nearPt(v[2 + j * 6 + q * 2], v[3 + j * 6 + q * 2], p)));
    assert.equal(path.endsWith('Z'), ent.closed);
  }
});

test('text: escaped, sized by its capitals, turned, aligned; as lines when asked; a white sheet when asked', () => {
  const d = sampleDrawing();
  const w = writeSvg(d, ALL);
  const texts = all(parseXml(w.text).children.find(g => g.attrs['inkscape:label'] === 'Text')!).filter(el => el.name === 'text');
  const first = texts[0];
  assert.equal(first.text, 'Worktop 600 ±0.5 Ø35 at 20°, 50% & <A> "B"');
  assert.match(w.text, /&amp; &lt;A&gt; &quot;B&quot;/);
  near(Number(first.attrs['font-size']), 10 / CAP_SHARE);
  assert.equal(first.attrs['text-anchor'], 'start');
  assert.equal(texts[1].attrs['text-anchor'], 'middle');
  assert.equal(texts[1].attrs.transform, `rotate(${svgNum((-0.3 * 180) / Math.PI)} 300 -720)`);
  assert.equal(texts[2].text, 'second {row} \\ here', 'a second row is its own text, below the first');
  assert.equal(texts[3].text, 'Ελληνικά € ⌀ 日本');
  assert.equal(texts[3].attrs['text-anchor'], 'end');
  assert.match(w.notes.join('\n'), /single-stroke/);
  // As lines: no text at all, paths instead.
  const lines = writeSvg(d, { ...ALL, textAsLines: true });
  assert.ok(!all(parseXml(lines.text)).some(el => el.name === 'text'));
  assert.ok(lines.count > w.count);
  // The sheet.
  assert.doesNotMatch(w.text, /id="sheet"/);
  const sheet = all(parseXml(writeSvg(d, { ...ALL, white: true }).text)).find(el => el.attrs.id === 'sheet')!;
  assert.equal(sheet.attrs.fill, '#ffffff');
});

test('words that could break the file are escaped, and signs XML cannot hold are left out', () => {
  assert.equal(xmlEscape(`<script>&'"`), '&lt;script&gt;&amp;&apos;&quot;');
  assert.equal(xmlEscape('a\u0001b\u0000c\ud800'), 'abc');
  const d = newDrawing();
  d.layers[0].name = 'Layer "x" <y> & z';
  d.ents = [
    { id: 1, layer: d.layers[0].name, type: 'text', p: P(0, 0), text: '</text><script>alert(1)</script>\u0007', h: 5, angle: 0, align: 'left' },
    { id: 2, layer: d.layers[0].name, type: 'line', a: P(0, 0), b: P(1, 1) },
  ] as Ent[];
  const w = writeSvg(d, ALL);
  const svg = parseXml(w.text);
  assert.equal(svg.children.find(c => c.name === 'g')!.attrs['inkscape:label'], 'Layer "x" <y> & z');
  assert.equal(all(svg).find(el => el.name === 'text')!.text, '</text><script>alert(1)</script>');
  assert.doesNotMatch(w.text, /<script/);
});

test('construction lines only when asked; an empty drawing is still a good file', () => {
  const d = sampleDrawing();
  assert.match(writeSvg(d, { ...ALL, construction: false }).notes.join('\n'), /1 construction line left out/);
  const g = parseXml(writeSvg(d, ALL).text).children.find(c => c.attrs['inkscape:label'] === 'Construction')!;
  assert.equal(g.children.length, 1);
  const empty = writeSvg(newDrawing(), ALL);
  assert.equal(empty.count, 0);
  assert.equal(parseXml(empty.text).name, 'svg');
});
