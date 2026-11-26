// Text boxes in CAD Draft: words that fill a box, stretched to its width and height, and bent by an envelope (a top
// and a bottom curve, each a cubic Bezier with four control points kept as fractions of the box, so resizing the box
// keeps the bend). Each letter stroke is cut into short steps, then every point is carried through the envelope.
// Also the frame and handles a chosen box shows, and what dragging each handle does.
import { LINE_SPACING, lineWidth, textStrokes, type Align } from './font.ts';
import { P, add, angleOf, dist, normAngle, rotatePt, sub, type Pt } from './geom.ts';
import type { NoteText, TextShape } from './notes.ts';

export type WarpPreset = 'none' | 'arch' | 'arcUp' | 'arcDown' | 'bulge' | 'pinch' | 'wave' | 'flag' | 'rise' | 'perspective' | 'custom';

export const WARP_NAMES: Record<WarpPreset, string> = {
  none: 'None', arch: 'Arch', arcUp: 'Arc up', arcDown: 'Arc down', bulge: 'Bulge', pinch: 'Pinch', wave: 'Wave', flag: 'Flag', rise: 'Rise',
  perspective: 'Perspective', custom: 'Shaped by hand',
};

/** The presets in the order the Warp box lists them. */
export const WARP_PRESETS: WarpPreset[] = ['none', 'arch', 'arcUp', 'arcDown', 'bulge', 'pinch', 'wave', 'flag', 'rise', 'perspective'];

/**
 * How a box's words are bent: the bottom and top curves (four control points each, left to right), as fractions of the
 * box (0,0 its bottom-left corner, 1,1 its top-right). `preset` and `strength` (-100 to 100) say where they came from.
 */
export interface Warp {
  preset: WarpPreset;
  strength: number;
  top: Pt[];
  bottom: Pt[];
}

/** A text box: w across and h up from the text's p (its bottom-left corner), turned by the text's angle. */
export interface TextBox {
  w: number;
  h: number;
  warp?: Warp;
}

/** How far below the foot the box reaches (the tails of g, p, y), in heights of the capitals. */
const DESCENT = 0.33;

/** The box the words take at a capital height of 1, from the first line's foot (lined up as `align` says). */
export function naturalBox(text: string, align: Align): { x0: number; x1: number; y0: number; y1: number } {
  const lines = text.split('\n');
  const w = Math.max(1e-6, ...lines.map(l => lineWidth(l, 1)));
  const x0 = align === 'left' ? 0 : align === 'centre' ? -w / 2 : -w;
  return { x0, x1: x0 + w, y0: -(lines.length - 1) * LINE_SPACING - DESCENT, y1: 1 };
}

/** The capital height that makes the words fill a box `boxH` high. */
export function fitHeight(text: string, align: Align, boxH: number): number {
  const nb = naturalBox(text, align);
  return boxH / (nb.y1 - nb.y0);
}

/** The box a plain text takes (so it can become a text box with its letters where they are). */
export function boxOfPlain(t: TextShape): { p: Pt; box: TextBox } {
  const nb = naturalBox(t.text, t.align);
  return { p: add(t.p, rotatePt(P(nb.x0 * t.h, nb.y0 * t.h), P(0, 0), t.angle)), box: { w: (nb.x1 - nb.x0) * t.h, h: (nb.y1 - nb.y0) * t.h } };
}

const clampStrength = (s: number) => Math.max(-100, Math.min(100, Math.round(Number.isFinite(s) ? s : 0)));
const flat = (y: number): Pt[] => [P(0, y), P(1 / 3, y), P(2 / 3, y), P(1, y)];
/** The two inner control points raised by a and b (a cubic's middle rises 3/4 of what its inner points do). */
const lift = (pts: Pt[], a: number, b: number): Pt[] => pts.map((p, i) => (i === 1 ? P(p.x, p.y + a) : i === 2 ? P(p.x, p.y + b) : p));

/** The envelope a preset gives at a strength from -100 to 100 (0 leaves the box flat). */
export function presetWarp(preset: WarpPreset, strength: number): Warp {
  const st = clampStrength(strength);
  const s = st / 100;
  const k = 4 / 3;
  let bottom = flat(0);
  let top = flat(1);
  switch (preset) {
    case 'arch':
      top = lift(top, k * 0.6 * s, k * 0.6 * s);
      break;
    case 'arcUp':
      top = lift(top, k * 0.6 * s, k * 0.6 * s);
      bottom = lift(bottom, k * 0.6 * s, k * 0.6 * s);
      break;
    case 'arcDown':
      top = lift(top, -k * 0.6 * s, -k * 0.6 * s);
      bottom = lift(bottom, -k * 0.6 * s, -k * 0.6 * s);
      break;
    case 'bulge':
      top = lift(top, k * 0.35 * s, k * 0.35 * s);
      bottom = lift(bottom, -k * 0.35 * s, -k * 0.35 * s);
      break;
    case 'pinch':
      top = lift(top, -k * 0.3 * s, -k * 0.3 * s);
      bottom = lift(bottom, k * 0.3 * s, k * 0.3 * s);
      break;
    case 'wave':
      top = lift(top, 0.6 * s, -0.6 * s);
      bottom = lift(bottom, -0.6 * s, 0.6 * s);
      break;
    case 'flag':
      top = lift(top, 0.7 * s, -0.7 * s);
      bottom = lift(bottom, 0.7 * s, -0.7 * s);
      break;
    case 'rise': {
      const a = 0.6 * s;
      bottom = [P(0, 0), P(1 / 3, 0), P(2 / 3, a), P(1, a)];
      top = bottom.map(p => P(p.x, p.y + 1));
      break;
    }
    case 'perspective': {
      const a = 0.4 * s;
      top = [0, 1, 2, 3].map(i => P(i / 3, 1 + (a * i) / 3));
      bottom = [0, 1, 2, 3].map(i => P(i / 3, (-a * i) / 3));
      break;
    }
    case 'none':
    case 'custom':
      break;
  }
  return { preset: preset === 'custom' ? 'none' : preset, strength: preset === 'none' || preset === 'custom' ? 0 : st, top, bottom };
}

const near = (a: Pt[], b: Pt[]) => a.length === b.length && a.every((p, i) => dist(p, b[i]) < 1e-9);

/** Does the envelope leave the box flat (the words only stretched)? */
export function isFlat(w: Warp | undefined): boolean {
  return !w || (near(w.top, flat(1)) && near(w.bottom, flat(0)));
}

/** Names the envelope by its preset when it is still exactly one (else it was shaped by hand). */
export function recognise(w: Warp): Warp {
  if (isFlat(w)) return { ...w, preset: 'none', strength: 0 };
  // A strength above 0 is tried first (an arc up turned over is an arc down, not an arc up at minus).
  for (const s of [Math.abs(w.strength), -Math.abs(w.strength)]) {
    for (const preset of [w.preset, ...WARP_PRESETS]) {
      if (preset === 'custom' || preset === 'none') continue;
      const p = presetWarp(preset, s);
      if (near(p.top, w.top) && near(p.bottom, w.bottom)) return { ...w, preset, strength: p.strength };
    }
  }
  return { ...w, preset: 'custom' };
}

/** The envelope seen upside down in the box (top and bottom swap, each turned over). */
export function flipWarpUp(w: Warp): Warp {
  return recognise({ ...w, top: w.bottom.map(p => P(p.x, 1 - p.y)), bottom: w.top.map(p => P(p.x, 1 - p.y)) });
}

/** The envelope seen back to front in the box (each curve read right to left). */
export function flipWarpAcross(w: Warp): Warp {
  return recognise({ ...w, top: [...w.top].reverse().map(p => P(1 - p.x, p.y)), bottom: [...w.bottom].reverse().map(p => P(1 - p.x, p.y)) });
}

function bez(c: Pt[], u: number): Pt {
  const v = 1 - u;
  const a = v * v * v;
  const b = 3 * v * v * u;
  const d = 3 * v * u * u;
  const e = u * u * u;
  return P(a * c[0].x + b * c[1].x + d * c[2].x + e * c[3].x, a * c[0].y + b * c[1].y + d * c[2].y + e * c[3].y);
}

/** Where a point u across and v up the flat box (0 to 1 each) lands in the bent one (still as fractions of the box). */
export function envelopeAt(w: Warp | undefined, u: number, v: number): Pt {
  if (!w || isFlat(w)) return P(u, v);
  const b = bez(w.bottom, u);
  const t = bez(w.top, u);
  return P(b.x + (t.x - b.x) * v, b.y + (t.y - b.y) * v);
}

/** A point in the box (drawing units across and up from its corner) as a point of the drawing. */
export function boxToWorld(t: TextShape, q: Pt): Pt {
  return add(t.p, rotatePt(q, P(0, 0), t.angle));
}

/** A point of the drawing as a point in the box (across and up from its corner). */
export function worldToBox(t: TextShape, q: Pt): Pt {
  return rotatePt(sub(q, t.p), P(0, 0), -t.angle);
}

/** Cuts each span of a stroke into steps at most `step` long. */
function subdivide(s: Pt[], step: number): Pt[] {
  if (s.length < 2) return s;
  const out: Pt[] = [s[0]];
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1];
    const b = s[i];
    const n = Math.min(64, Math.max(1, Math.ceil(dist(a, b) / step)));
    for (let j = 1; j <= n; j++) out.push(P(a.x + ((b.x - a.x) * j) / n, a.y + ((b.y - a.y) * j) / n));
  }
  return out;
}

/** The strokes of a text box: its letters stretched to the box and carried through its envelope. */
export function boxStrokes(t: TextShape): Pt[][] {
  const box = t.box!;
  const nb = naturalBox(t.text, t.align);
  const nw = nb.x1 - nb.x0;
  const nh = nb.y1 - nb.y0;
  const warp = box.warp && !isFlat(box.warp) ? box.warp : undefined;
  return textStrokes(t.text, P(0, 0), 1, 0, t.align).map(s => (warp ? subdivide(s, 0.12) : s).map(q => {
    const e = envelopeAt(warp, (q.x - nb.x0) / nw, (q.y - nb.y0) / nh);
    return boxToWorld(t, P(e.x * box.w, e.y * box.h));
  }));
}

/** The edge of a box's envelope, all the way round (the bottom curve, the right side, the top curve back, the left side). */
export function envelopeOutline(t: TextShape, n = 24): Pt[] {
  const box = t.box!;
  const w = box.warp;
  const at = (u: number, v: number) => {
    const e = envelopeAt(w, u, v);
    return boxToWorld(t, P(e.x * box.w, e.y * box.h));
  };
  if (isFlat(w)) return [at(0, 0), at(1, 0), at(1, 1), at(0, 1)];
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) out.push(at(i / n, 0));
  out.push(at(1, 0.5));
  for (let i = n; i >= 0; i--) out.push(at(i / n, 1));
  out.push(at(0, 0.5));
  return out;
}

/** The box's own frame (its four corners, round from the bottom-left). */
export function boxFrame(t: TextShape): Pt[] {
  const b = t.box!;
  return [P(0, 0), P(b.w, 0), P(b.w, b.h), P(0, b.h)].map(q => boxToWorld(t, q));
}

function insidePolygon(poly: Pt[], q: Pt): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if ((a.y > q.y) !== (b.y > q.y) && q.x < ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function distToSeg(q: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const k = l2 > 0 ? Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(q.x - a.x - k * dx, q.y - a.y - k * dy);
}

/** How far q is from a text box (0 anywhere inside its envelope). */
export function distToBoxText(t: TextShape, q: Pt): number {
  const poly = envelopeOutline(t);
  if (insidePolygon(poly, q)) return 0;
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) best = Math.min(best, distToSeg(q, poly[i], poly[(i + 1) % poly.length]));
  return best;
}

/**
 * A text box that is only made bigger or smaller the same both ways (not bent, not stretched) as the plain text it
 * matches, so a DXF, SVG or DWG can keep it as text; null when it must go out as lines.
 */
export function boxAsText(t: TextShape): NoteText | null {
  const box = t.box;
  if (!box) return { text: t.text, p: t.p, h: t.h, angle: t.angle, align: t.align };
  if (!isFlat(box.warp)) return null;
  const nb = naturalBox(t.text, t.align);
  const kx = box.w / (nb.x1 - nb.x0);
  const ky = box.h / (nb.y1 - nb.y0);
  if (!(kx > 0 && ky > 0) || Math.abs(kx / ky - 1) > 0.005) return null;
  return { text: t.text, p: boxToWorld(t, P(-nb.x0 * kx, -nb.y0 * ky)), h: ky, angle: t.angle, align: t.align };
}

/** Is this a text box that an export writes as lines (it is stretched or bent)? */
export const boxGoesAsLines = (t: TextShape): boolean => !!t.box && !boxAsText(t);

// ---- Handles -------------------------------------------------------------------------------------------------------

/** A handle on a chosen box: a corner or side (sx, sy each -1, 0 or 1), the inside, the turn handle, or a bend point. */
export type Grip =
  | { kind: 'size'; sx: -1 | 0 | 1; sy: -1 | 0 | 1 }
  | { kind: 'move' }
  | { kind: 'turn' }
  | { kind: 'bend'; edge: 'top' | 'bottom'; i: number };

/** How far the turn handle stands above the box, in pixels. */
const TURN_GAP = 26;

/** The handles a chosen box shows (`px`: one pixel in drawing units). By hand: the envelope's eight control points. */
export function gripsOf(t: TextShape, byHand: boolean, px: number): Array<{ grip: Grip; p: Pt }> {
  const b = t.box!;
  if (byHand) {
    const w = b.warp ?? presetWarp('none', 0);
    return (['bottom', 'top'] as const).flatMap(edge => w[edge].map((c, i) => ({ grip: { kind: 'bend', edge, i } as Grip, p: boxToWorld(t, P(c.x * b.w, c.y * b.h)) })));
  }
  const out: Array<{ grip: Grip; p: Pt }> = [];
  for (const sy of [-1, 0, 1] as const) {
    for (const sx of [-1, 0, 1] as const) {
      if (!sx && !sy) continue;
      out.push({ grip: { kind: 'size', sx, sy }, p: boxToWorld(t, P(((sx + 1) / 2) * b.w, ((sy + 1) / 2) * b.h)) });
    }
  }
  out.push({ grip: { kind: 'turn' }, p: boxToWorld(t, P(b.w / 2, b.h + TURN_GAP * px)) });
  return out;
}

/** The handle under q (within `reach`), or 'move' inside the box; null elsewhere. */
export function gripAt(t: TextShape, byHand: boolean, q: Pt, px: number, reach: number): Grip | null {
  let best: Grip | null = null;
  let bestD = reach;
  for (const g of gripsOf(t, byHand, px)) {
    const d = dist(g.p, q);
    if (d <= bestD) {
      bestD = d;
      best = g.grip;
    }
  }
  if (best) return best;
  return distToBoxText(t, q) === 0 ? { kind: 'move' } : null;
}

/** The text box after dragging a handle from `from` to `to` (Shift keeps the box's proportions, or turns in 15° steps). */
export function dragGrip(t: TextShape, grip: Grip, from: Pt, to: Pt, shift: boolean): TextShape {
  const b = t.box!;
  switch (grip.kind) {
    case 'move':
      return { ...t, p: add(t.p, sub(to, from)) };
    case 'turn': {
      const c = boxToWorld(t, P(b.w / 2, b.h / 2));
      let angle = normAngle(t.angle + angleOf(sub(to, c)) - angleOf(sub(from, c)));
      if (shift) angle = normAngle(Math.round(angle / (Math.PI / 12)) * (Math.PI / 12));
      return { ...t, angle, p: rotatePt(t.p, c, angle - t.angle) };
    }
    case 'bend': {
      const q = worldToBox(t, to);
      const w = b.warp ?? presetWarp('none', 0);
      const pts = [...w[grip.edge]];
      // Kept within what a saved drawing reads back (under 1000 box widths), so a handle dragged far out is not lost on reopening.
      const keep = (v: number) => Math.max(-999, Math.min(999, v));
      pts[grip.i] = P(keep(q.x / b.w), keep(q.y / b.h));
      return { ...t, box: { ...b, warp: recognise({ ...w, [grip.edge]: pts }) } };
    }
    case 'size': {
      const q = worldToBox(t, to);
      const least = 1e-3 * Math.max(b.w, b.h);
      let x0 = 0;
      let x1 = b.w;
      let y0 = 0;
      let y1 = b.h;
      if (grip.sx > 0) x1 = Math.max(q.x, x0 + least);
      if (grip.sx < 0) x0 = Math.min(q.x, x1 - least);
      if (grip.sy > 0) y1 = Math.max(q.y, y0 + least);
      if (grip.sy < 0) y0 = Math.min(q.y, y1 - least);
      if (shift) {
        // Proportions kept: the bigger change wins (a side handle grows the box both ways from its middle).
        const kx = (x1 - x0) / b.w;
        const ky = (y1 - y0) / b.h;
        const k = grip.sx && grip.sy ? Math.max(kx, ky) : grip.sx ? kx : ky;
        const nw = b.w * k;
        const nh = b.h * k;
        if (grip.sx > 0) x1 = x0 + nw;
        else if (grip.sx < 0) x0 = x1 - nw;
        else {
          x0 = b.w / 2 - nw / 2;
          x1 = x0 + nw;
        }
        if (grip.sy > 0) y1 = y0 + nh;
        else if (grip.sy < 0) y0 = y1 - nh;
        else {
          y0 = b.h / 2 - nh / 2;
          y1 = y0 + nh;
        }
      }
      const h = y1 - y0;
      return { ...t, p: boxToWorld(t, P(x0, y0)), h: fitHeight(t.text, t.align, h), box: { ...b, w: x1 - x0, h } };
    }
  }
}

/** The envelope's control lines (each end to its inner neighbour) and its outline, for showing while bending by hand. */
export function bendGuides(t: TextShape): Pt[][] {
  const b = t.box!;
  const w = b.warp ?? presetWarp('none', 0);
  const at = (c: Pt) => boxToWorld(t, P(c.x * b.w, c.y * b.h));
  return [w.bottom, w.top].map(c => c.map(at));
}

/** The text box made from a plain text (letters where they were), or the text itself when it is a box already. */
export function asBox(t: TextShape): TextShape {
  if (t.box || t.arc) return t;
  const { p, box } = boxOfPlain(t);
  return { ...t, p, box };
}

/** The box text with new words: the same box, its capital height worked out again. */
export function withWords(t: TextShape, text: string, align: Align): TextShape {
  if (!t.box) return { ...t, text, align };
  return { ...t, text, align, h: fitHeight(text, align, t.box.h) };
}

/** Reads a text box from a .tcad file (null when it has none); throws a message for a damaged one. */
export function readBox(v: unknown): TextBox | null | string {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const pos = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x > 0;
  if (!pos(o.w) || !pos(o.h)) return 'a text box in it has no size';
  const box: TextBox = { w: o.w as number, h: o.h as number };
  if (o.warp && typeof o.warp === 'object') {
    const w = o.warp as Record<string, unknown>;
    const four = (x: unknown): Pt[] | null => {
      if (!Array.isArray(x) || x.length !== 4) return null;
      const pts = x.map(p => (p && typeof p === 'object' ? P((p as Pt).x, (p as Pt).y) : P(NaN, NaN)));
      return pts.every(p => Number.isFinite(p.x) && Number.isFinite(p.y) && Math.abs(p.x) < 1e3 && Math.abs(p.y) < 1e3) ? pts : null;
    };
    const top = four(w.top);
    const bottom = four(w.bottom);
    if (!top || !bottom) return 'a bent text box in it has damaged curves';
    const preset = typeof w.preset === 'string' && w.preset in WARP_NAMES ? (w.preset as WarpPreset) : 'custom';
    box.warp = { preset, strength: clampStrength(typeof w.strength === 'number' ? w.strength : 0), top, bottom };
  }
  return box;
}
