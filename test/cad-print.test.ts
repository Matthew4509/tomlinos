// KerfLine session 9: the photo traced over (placed, scaled by two points and a known length, lined up, moved,
// kept in the .tcad), printing to scale (pages, scale, tiling, title block, what lands where on the paper) and the
// PDF it makes. Answers worked out by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { P, dist, nearestOn, type Pt } from '../src/apps/cad/geom.ts';
import { newDrawing, readTcad, rectangle, writeTcad, type Ent, type Shape } from '../src/apps/cad/model.ts';
import {
  photoBox, photoCorners, photoOnPage, pixelMatrix, placePhoto, readPhoto, scaleFromTwo, straightenTurn, turnPhoto, type Photo,
} from '../src/apps/cad/photo.ts';
import { CAD_PAPERS, DEFAULT_SETUP, MAX_PAGES, PT, drawCadPage, planPrint, samplePiece, scaleText, type PrintPlan, type PrintSetup } from '../src/apps/cad/print.ts';
import type { Painter, TextLook } from '../src/apps/sheet/paint.ts';
import { PdfDocument } from '../src/apps/sheet/pdf.ts';

const near = (a: Pt, b: Pt, what: string, tol = 1e-6) => assert.ok(dist(a, b) <= tol, `${what}: expected ${b.x},${b.y}, got ${a.x},${a.y}`);
const close = (a: number, b: number, what: string, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${what}: expected ${b}, got ${a}`);

const photo = (o: Partial<Photo> = {}): Photo => ({ jpeg: 'AAAA', px: 400, py: 300, at: P(0, 0), u: P(400, 0), opacity: 0.5, on: true, name: 'bench.jpg', ...o });

function drawingOf(shapes: Shape[], units: 'mm' | 'inch' = 'mm') {
  const d = newDrawing(units);
  d.ents = shapes.map((s, i) => ({ ...s, id: i + 1, layer: 'Geometry' }) as Ent);
  return d;
}
const setup = (o: Partial<PrintSetup> = {}): PrintSetup => ({ ...DEFAULT_SETUP, ...o });
const plan = (d: ReturnType<typeof drawingOf>, o: Partial<PrintSetup> = {}): PrintPlan => {
  const p = planPrint(d, setup(o), null);
  if (typeof p === 'string') throw new Error(p);
  return p;
};

/** A painter that keeps what it was told to draw. */
class Recorder implements Painter {
  lines: number[][] = [];
  texts: string[] = [];
  rects: number[][] = [];
  clips = 0;
  rect(x: number, y: number, w: number, h: number): void {
    this.rects.push([x, y, w, h]);
  }
  line(points: number[]): void {
    this.lines.push(points);
  }
  shape(): void {}
  circle(): void {}
  text(_x: number, _y: number, text: string, _look: TextLook): void {
    this.texts.push(text);
  }
  clip(): void {
    this.clips++;
  }
  unclip(): void {}
}
const extras = { fileLabel: 'panel', date: '15 Oct 2026', units: 'mm' as const };

test('the photo: laid across the view, its corners, and where its pixels land', () => {
  const place = placePhoto(400, 300, { x0: 0, y0: 0, x1: 1000, y1: 500 });
  // 80% of the height limits it: 400 high, so 533.33 across, centred on 500, 250.
  close(place.u.x, (400 * 400) / 300, 'width');
  near(place.at, P(500 - 400 * 400 / 300 / 2, 50), 'bottom-left corner');
  const ph = photo({ at: P(10, 20), u: P(400, 0) });
  const c = photoCorners(ph);
  near(c.tr, P(410, 320), 'top-right');
  near(c.tl, P(10, 320), 'top-left');
  const m = pixelMatrix(ph, photoOnPage(ph, q => P(q.x, -q.y)));
  const px = (i: number, j: number) => P(m[0] * i + m[2] * j + m[4], m[1] * i + m[3] * j + m[5]);
  near(px(0, 0), P(10, -320), 'pixel 0,0 is the top-left');
  near(px(400, 0), P(410, -320), 'the last pixel across is the top-right');
  near(px(0, 300), P(10, -20), 'the last pixel down is the bottom-left');
  // Turned a quarter, the matrix turns with it.
  const t = turnPhoto(ph, P(10, 20), Math.PI / 2);
  near(photoCorners(t).br, P(10, 420), 'turned: the bottom-right is above the bottom-left');
  const b = photoBox(t);
  close(b.x0, -290, 'box after turning');
});

test('the photo: scaled by two points and a length, lined up with an edge', () => {
  const ph = photo();
  // Two tape marks 100 pixels-worth apart are really 600 mm: everything 6 times bigger, the first mark staying put.
  const big = scaleFromTwo(ph, P(50, 50), P(150, 50), 600)!;
  close(Math.hypot(big.u.x, big.u.y), 2400, 'the picture is now 2400 across');
  near(big.at, P(50 - 50 * 6, 50 - 50 * 6), 'scaled about the first mark');
  assert.equal(scaleFromTwo(ph, P(1, 1), P(1, 1), 600), null, 'the same point twice');
  assert.equal(scaleFromTwo(ph, P(0, 0), P(1, 0), 0), null, 'a length of 0');
  // An edge 3 degrees off straight across is turned back 3 degrees; one 88 degrees up is turned on 2.
  close(straightenTurn(P(0, 0), P(Math.cos(0.0524), Math.sin(0.0524))), -0.0524, 'across');
  close(straightenTurn(P(0, 0), P(Math.cos(1.5359), Math.sin(1.5359))), Math.PI / 2 - 1.5359, 'up');
  close(straightenTurn(P(0, 0), P(-1, -0.01)), -Math.atan(0.01), 'right to left, dipping: turned clockwise', 1e-9);
});

test('the photo is kept in the .tcad, and a damaged one is left out', () => {
  const d = newDrawing();
  d.photo = photo({ at: P(-5, 7.5), u: P(300, 40), opacity: 0.75 });
  const back = readTcad(writeTcad(d)).drawing;
  assert.deepEqual(back.photo, d.photo);
  assert.equal(readTcad(writeTcad(newDrawing())).drawing.photo, null, 'no photo, none back');
  assert.equal(readPhoto({ ...d.photo, px: -3 }), null, 'impossible size');
  assert.equal(readPhoto({ ...d.photo, jpeg: '<svg onload=x>' }), null, 'not base64');
  assert.equal(readPhoto({ ...d.photo, u: { x: 0, y: 0 } }), null, 'no width');
  assert.equal(readPhoto({ ...d.photo, opacity: 7 })!.opacity, 1, 'too strong becomes 100%');
  // Notes of the window's own (a recovery copy's) ride along and do not stop it opening.
  const kept = writeTcad(d, { recovery: { label: 'Bench.tcad', path: '/Documents/Bench.tcad' } });
  assert.equal(JSON.parse(kept).recovery.label, 'Bench.tcad');
  assert.equal(readTcad(kept).drawing.ents.length, 0);
});

test('print plan: 600 x 400 at 1:1 on A4 takes 9 pages, at 1:5 one, and Fit works out its own scale', () => {
  const d = drawingOf([rectangle(P(0, 0), P(600, 400))!]);
  // A4 across: 297 x 210, less 10 mm margins and the 19 mm title strip: 277 x 171 for the drawing.
  const one = plan(d, { scale: 1 });
  assert.deepEqual([one.area.w, one.area.h], [277, 171]);
  assert.deepEqual([one.cols, one.rows, one.pages.length], [3, 3, 9]);
  // The pages together are centred on the part, top row first.
  close((one.pages[0].box.x0 + one.pages[8].box.x1) / 2, 300, 'centred across');
  close((one.pages[0].box.y1 + one.pages[8].box.y0) / 2, 200, 'centred up');
  assert.deepEqual([one.pages[1].row, one.pages[1].col], [1, 2]);
  const five = plan(d, { scale: 5 });
  assert.equal(five.pages.length, 1);
  const fit = plan(d, { scale: 'fit' });
  close(fit.n, 400 / 171, 'Fit: the height decides');
  assert.equal(scaleText(fit.n), '1:2.34');
  assert.equal(scaleText(0.5), '2:1');
  // Portrait A3, no title block: 277 x 400. At 1:2 the part is 300 across (two pages); at 1:3 it fits on one.
  assert.equal(plan(d, { scale: 2, paper: 'a3', landscape: false, titleBlock: false }).pages.length, 2);
  const a3 = plan(d, { scale: 3, paper: 'a3', landscape: false, titleBlock: false });
  assert.deepEqual([a3.area.w, a3.area.h, a3.pages.length], [277, 400, 1]);
  // Inches: a 10 inch part at 1:1 is 254 mm, a page across.
  const inch = plan(drawingOf([{ type: 'line', a: P(0, 0), b: P(10, 0) }], 'inch'), { scale: 1 });
  close(inch.perMm, 1 / 25.4, 'an inch drawing: 1/25.4 inch to a millimetre');
  assert.equal(inch.cols, 1);
  // Too many pages, and nothing at all, are refused with the reason.
  const huge = planPrint(drawingOf([rectangle(P(0, 0), P(60000, 40000))!]), setup({ scale: 1 }), null);
  assert.ok(typeof huge === 'string' && /needs \d+ pages/.test(huge) && Number(/needs (\d+)/.exec(huge)![1]) > MAX_PAGES, String(huge));
  assert.match(String(planPrint(newDrawing(), setup(), null)), /nothing to print/);
  // Hidden layers and construction lines stay off the paper unless asked.
  const withX = drawingOf([rectangle(P(0, 0), P(600, 400))!, { type: 'xline', p: P(0, 0), d: P(1, 0) }]);
  assert.equal(plan(withX).ents.length, 1);
  assert.equal(plan(withX, { construction: true }).ents.length, 2);
  withX.layers[0].on = false;
  assert.match(String(planPrint(withX, setup(), null)), /nothing to print/);
});

test('on the paper: a 100 mm line is 100 mm at 1:1 and 20 mm at 1:5; the check bar is 50 mm', () => {
  const d = drawingOf([{ type: 'line', a: P(0, 0), b: P(100, 0) }, { type: 'circle', c: P(50, 30), r: 10 }]);
  for (const n of [1, 5]) {
    const pl = plan(d, { scale: n });
    const r = new Recorder();
    drawCadPage(r, d, pl, 0, extras);
    const [x0, y0, x1, y1] = r.lines[0];
    close(Math.hypot(x1 - x0, y1 - y0), (100 / n) * PT, `1:${n}: the line on paper`, 1e-6);
    close(y0, y1, 'still level');
    assert.ok(r.texts.includes(`1:${n}`), `the title block says 1:${n}: ${r.texts.join(' | ')}`);
    // The 50 mm bar: the first line after the title-block box that is level and 50 mm long.
    const bar = r.lines.find(l => l.length === 4 && Math.abs(l[1] - l[3]) < 1e-9 && Math.abs(Math.abs(l[2] - l[0]) - 50 * PT) < 1e-6);
    assert.ok(bar, 'a 50 mm bar');
  }
  // The circle's steps stay within 0.02 mm of it on paper (at 1:1, 0.02 drawing mm).
  const pl = plan(d, { scale: 1 });
  const r = new Recorder();
  drawCadPage(r, d, pl, 0, extras);
  const ring = r.lines[1];
  const page = pl.pages[0];
  const toWorld = (x: number, y: number) => P(x / PT - pl.area.x + page.box.x0, page.box.y1 - (y / PT - pl.area.y));
  let worst = 0;
  for (let i = 0; i + 3 < ring.length; i += 2) {
    const a = toWorld(ring[i], ring[i + 1]);
    const b = toWorld(ring[i + 2], ring[i + 3]);
    worst = Math.max(worst, Math.abs(dist(P((a.x + b.x) / 2, (a.y + b.y) / 2), P(50, 30)) - 10), Math.abs(dist(a, P(50, 30)) - 10));
  }
  assert.ok(worst <= 0.0201, `circle within 0.02 mm (worst ${worst})`);
  assert.ok(r.clips >= 1, 'the drawing is kept inside the frame');
  assert.ok(r.texts.includes('panel'), 'no title given: the file name');
});

test('several pages: each says its row and column, and the parts meet edge to edge', () => {
  const d = drawingOf([{ type: 'line', a: P(0, 0), b: P(500, 0) }]);
  const pl = plan(d, { scale: 1, landscape: false });
  // A4 tall: 190 across, so 500 mm needs 3 pages across, 1 down.
  assert.deepEqual([pl.cols, pl.rows], [3, 1]);
  close(pl.pages[0].box.x1, pl.pages[1].box.x0, 'page 1 ends where page 2 starts');
  const r = new Recorder();
  drawCadPage(r, d, pl, 1, extras);
  assert.ok(r.texts.some(t => t === '2/3: row 1, col 2'), r.texts.join(' | '));
  // The line runs right across the middle page (it is clipped by the frame, not cut short).
  const [x0, , x1] = r.lines[0];
  assert.ok(x0 < pl.area.x * PT && x1 > (pl.area.x + pl.area.w) * PT, 'drawn past both edges, the frame cuts it');
});

test('curves are stepped finely enough: an ellipse within the tolerance asked', () => {
  const piece = { k: 'ell' as const, c: P(0, 0), m: P(100, 0), ratio: 0.3, t0: 0, t1: 2 * Math.PI };
  const pts = samplePiece(piece, 0.01);
  let worst = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const m = P((pts[i].x + pts[i + 1].x) / 2, (pts[i].y + pts[i + 1].y) / 2);
    worst = Math.max(worst, dist(m, nearestOn(piece, m)));
  }
  assert.ok(worst <= 0.0101, `worst ${worst}`);
  near(pts[pts.length - 1], P(100, 0), 'closes where it started');
});

test('the PDF: pages at paper size, the photo laid where it belongs', async () => {
  const d = drawingOf([rectangle(P(0, 0), P(600, 400))!]);
  d.photo = photo({ at: P(0, 0), u: P(600, 0) });
  const pl = plan(d, { scale: 5, photo: true });
  assert.ok(pl.photo, 'the photo is printed when asked');
  assert.equal(plan(d, { scale: 5 }).photo, null, 'and not otherwise');
  const doc = new PdfDocument();
  const name = doc.addJpeg(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), 400, 300);
  const page = doc.addPage(pl.paperW * PT, pl.paperH * PT);
  drawCadPage(page, d, pl, 0, { ...extras, photo: (_p, on, frame) => page.imageAt(on.tl, on.tr, on.bl, name, frame) });
  const ops = page.content();
  // The picture's unit square: across 600 mm / 5 = 120 mm, up 450 / 5 = 90 mm, from its bottom-left corner.
  const m = /re W n (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) cm \/(\w+) Do Q/.exec(ops);
  assert.ok(m, ops.slice(0, 400));
  close(Number(m[1]), 120 * PT, 'width on paper', 0.01);
  close(Number(m[4]), 90 * PT, 'height on paper', 0.01);
  close(Number(m[2]), 0, 'not turned');
  const bytes = await doc.bytes();
  assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), '%PDF-');
  const text = new TextDecoder('latin1').decode(bytes);
  close(Number(/MediaBox \[0 0 (\S+) (\S+)\]/.exec(text)![1]), CAD_PAPERS.a4.h * PT, 'A4 across in points', 0.01);
});

test('photo tools through their steps', async () => {
  // The tools are tested with the window's view of them (cad.test.ts has the full stand-in; this is the photo part).
  const { TOOLS } = await import('../src/apps/cad/tools.ts');
  let ph: Photo | null = null;
  const said: string[] = [];
  const problems: string[] = [];
  const ctx = {
    units: () => 'mm' as const, ents: () => [], visible: () => [], selection: () => [], select() {}, add() {}, change() {},
    say: (t: string) => void said.push(t), problem: (t: string) => void problems.push(t), fmt: (v: number) => String(Math.round(v * 1000) / 1000),
    list() {}, zoomTo() {}, askPolar: async () => null, askText: async () => null, askDim: async () => null,
    style: () => ({ textH: 5, dimH: 3.5, arrow: 3, dp: 1 }), noteLayer: () => 'Text', finished() {},
    photo: () => ph, setPhoto(p: Photo, t: string) {
      ph = p;
      said.push(t);
    },
    straightenPhoto() {},
    placePart() {},
    savePart() {},
  };
  const none = TOOLS['photo-scale'].make(ctx);
  none.point!(P(0, 0));
  none.point!(P(10, 0));
  none.number!(100, P(0, 0));
  assert.match(problems.at(-1)!, /no photo/);
  ph = photo();
  const s = TOOLS['photo-scale'].make(ctx);
  s.point!(P(100, 100));
  s.point!(P(200, 100));
  s.number!(650, P(0, 0));
  assert.ok(s.done);
  close(Math.hypot(ph!.u.x, ph!.u.y), 400 * 6.5, 'scaled 6.5 times');
  assert.match(said.at(-1)!, /650 apart/);
  const t = TOOLS['photo-turn'].make(ctx);
  t.point!(P(0, 0));
  t.point!(P(100, 5));
  close(Math.atan2(ph!.u.y, ph!.u.x), -Math.atan2(5, 100), 'turned back by the edge’s slope', 1e-12);
  assert.match(said.at(-1)!, /clockwise: that edge now runs straight across/);
  const before = ph!.at;
  const mv = TOOLS['photo-move'].make(ctx);
  mv.point!(P(10, 10));
  mv.point!(P(0, 0));
  near(ph!.at, P(before.x - 10, before.y - 10), 'moved');
});
