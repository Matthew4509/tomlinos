// The photo traced over: a picture laid under the drawing, sized and turned by points the person clicks on it (the
// two ends of a length they measured with a tape, an edge that should run straight across). It is kept in the .tcad
// as a JPEG and is never written to a DXF; printing leaves it out unless asked.
// No browser needed here: reading the picture's pixels is the window's job (cad.ts).
import { P, add, angleOf, cross, dist, mul, perp, rotatePt, sub, type Box, type Pt } from './geom.ts';

export interface Photo {
  /** The picture as a JPEG, in base64 (no "data:" in front). */
  jpeg: string;
  /** Its size in pixels. */
  px: number;
  py: number;
  /** Where its bottom-left corner is on the drawing. */
  at: Pt;
  /** Its bottom edge, left to right: its length is the picture's width in drawing units, its direction its turn. */
  u: Pt;
  /** How strongly it shows, from 0.1 (faint) to 1. */
  opacity: number;
  /** Shown or hidden (hidden: nothing of it shows or prints, but it stays in the file). */
  on: boolean;
  /** The file it came from, for the Information box. */
  name: string;
  /** A straightened photo only: the part of the picture the photo filled (corners in pixels, y down); the rest is blank. */
  clip?: Pt[];
}

/** A longer side is made this many pixels on opening: plenty to trace by, and the .tcad stays a few MB at most. */
export const PHOTO_SIDE = 3000;
export const OPACITIES = [0.25, 0.5, 0.75, 1];

/** The picture's four corners on the drawing. */
export function photoCorners(ph: Photo): { bl: Pt; br: Pt; tr: Pt; tl: Pt } {
  const v = mul(perp(ph.u), ph.py / ph.px);
  return { bl: ph.at, br: add(ph.at, ph.u), tl: add(ph.at, v), tr: add(add(ph.at, ph.u), v) };
}

export function photoBox(ph: Photo): Box {
  const c = Object.values(photoCorners(ph));
  return { x0: Math.min(...c.map(p => p.x)), y0: Math.min(...c.map(p => p.y)), x1: Math.max(...c.map(p => p.x)), y1: Math.max(...c.map(p => p.y)) };
}

/** Drawing units per pixel of the picture. */
export const photoScale = (ph: Photo): number => Math.hypot(ph.u.x, ph.u.y) / ph.px;

/** A new picture laid across most of what is showing, straight, its middle at the middle of the view. */
export function placePhoto(px: number, py: number, view: Box): { at: Pt; u: Pt } {
  const w = view.x1 - view.x0;
  const h = view.y1 - view.y0;
  const k = Math.min((0.8 * w) / px, (0.8 * h) / py);
  const cx = (view.x0 + view.x1) / 2;
  const cy = (view.y0 + view.y1) / 2;
  return { at: P(cx - (px * k) / 2, cy - (py * k) / 2), u: P(px * k, 0) };
}

/** The picture made bigger or smaller about a point that stays where it is. */
export function scalePhoto(ph: Photo, about: Pt, k: number): Photo {
  return { ...ph, at: add(about, mul(sub(ph.at, about), k)), u: mul(ph.u, k) };
}

/** The picture turned about a point (radians, anticlockwise). */
export function turnPhoto(ph: Photo, about: Pt, angle: number): Photo {
  return { ...ph, at: rotatePt(ph.at, about, angle), u: rotatePt(ph.u, P(0, 0), angle) };
}

export function movePhoto(ph: Photo, by: Pt): Photo {
  return { ...ph, at: add(ph.at, by) };
}

/**
 * Two points the person says are a known length apart: the scale that makes them so (about the first point).
 * Null when the points are the same or the length is not above 0.
 */
export function scaleFromTwo(ph: Photo, a: Pt, b: Pt, length: number): Photo | null {
  const d = dist(a, b);
  if (!(d > 1e-12) || !(length > 0) || !Number.isFinite(length)) return null;
  return scalePhoto(ph, a, length / d);
}

/**
 * The turn that makes the edge from a to b run straight across or straight up (whichever is nearer), so a photo taken
 * a little crooked lines up with the drawing. Radians, anticlockwise; at most a quarter turn either way.
 */
export function straightenTurn(a: Pt, b: Pt): number {
  const angle = angleOf(sub(b, a));
  const quarter = Math.PI / 2;
  return Math.round(angle / quarter) * quarter - angle;
}

// ---- Straightening a photo taken at a slant -------------------------------------------------------------------------
// Four corners of something rectangular lying flat in the photo, and its real width and height, fix how every point of
// that flat surface sits on the drawing (a perspective map). The picture is redrawn through that map, so the rectangle
// comes out square and to scale. Only the flat surface is true: anything standing up from it (a splashback, a tap)
// leans in the result.

/** A 3 x 3 matrix, row by row: (x, y) goes to ((m0 x + m1 y + m2) / w, (m3 x + m4 y + m5) / w), w = m6 x + m7 y + m8. */
export type M3 = [number, number, number, number, number, number, number, number, number];

function m3mul(a: M3, b: M3): M3 {
  const r = new Array(9).fill(0) as M3;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r;
}

function m3inv(m: M3): M3 | null {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = f * g - d * i;
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-300) return null;
  const k = 1 / det;
  return [A * k, (c * h - b * i) * k, (b * f - c * e) * k, B * k, (a * i - c * g) * k, (c * d - a * f) * k, C * k, (b * g - a * h) * k, (a * e - b * d) * k];
}

/** Where a matrix takes a point; null when it goes off to infinity. */
export function m3apply(m: M3, p: Pt): Pt | null {
  const w = m[6] * p.x + m[7] * p.y + m[8];
  if (!(Math.abs(w) > 1e-300)) return null;
  return P((m[0] * p.x + m[1] * p.y + m[2]) / w, (m[3] * p.x + m[4] * p.y + m[5]) / w);
}

/** The map taking the square (0,0) (1,0) (1,1) (0,1) to the four corners q in that order (Heckbert's closed form). */
function squareToQuad(q: Pt[]): M3 {
  const [p0, p1, p2, p3] = q;
  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;
  const size = Math.max(...q.map(p => Math.max(Math.abs(p.x), Math.abs(p.y))), 1);
  if (Math.abs(sx) < 1e-12 * size && Math.abs(sy) < 1e-12 * size) return [p1.x - p0.x, p3.x - p0.x, p0.x, p1.y - p0.y, p3.y - p0.y, p0.y, 0, 0, 1];
  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = (sx * dy2 - dx2 * sy) / den;
  const h = (dx1 * sy - sx * dy1) / den;
  return [p1.x - p0.x + g * p1.x, p3.x - p0.x + h * p3.x, p0.x, p1.y - p0.y + g * p1.y, p3.y - p0.y + h * p3.y, p0.y, g, h, 1];
}

/** Twice the signed area (anticlockwise above 0 when y runs up). */
function area2(poly: Pt[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) s += cross(poly[i], poly[(i + 1) % poly.length]);
  return s;
}

/** The part of a convex polygon where f is at least 0 (f must be linear, so the cut lands between two corners). */
function cutPoly(poly: Pt[], f: (p: Pt) => number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const fa = f(a);
    const fb = f(b);
    if (fa >= 0) out.push(a);
    if ((fa >= 0) !== (fb >= 0)) out.push(add(a, mul(sub(b, a), fa / (fa - fb))));
  }
  return out;
}

const cutToBox = (poly: Pt[], b: Box): Pt[] =>
  [(p: Pt) => p.x - b.x0, (p: Pt) => b.x1 - p.x, (p: Pt) => p.y - b.y0, (p: Pt) => b.y1 - p.y].reduce((acc, f) => (acc.length ? cutPoly(acc, f) : acc), poly);

/** The picture's pixels (j down) to the drawing, as the photo sits now. */
export function pixelToDrawing(ph: Photo): M3 {
  const [a, b, c, d, e, f] = pixelMatrix(ph, photoOnPage(ph, p => p));
  return [a, c, e, b, d, f, 0, 0, 1];
}

/** How far round the straightened result reaches past the rectangle, in its larger side: room for the part being traced
 * when the rectangle is a sheet of A4 laid on it, without the far distance (near the horizon) taking every pixel. */
export const STRAIGHTEN_REACH = 8;

export interface StraightenPlan {
  /** Each pixel of the new picture (its middle at i + 0.5, j + 0.5, j down) to the old picture's pixels. */
  back: M3;
  px: number;
  py: number;
  at: Pt;
  u: Pt;
  /** The part of the new picture the old one fills, when it does not fill all of it. */
  clip?: Pt[];
}

/**
 * The straightened picture's size and place: the four corners (clicked on the drawing, in order round the shape) go
 * to a w x h rectangle starting at the first corner, its first side turned to run straight across or up (whichever is
 * nearer). The words of why it cannot be done, instead, when the corners or sizes make no rectangle.
 */
export function planStraighten(ph: Photo, corners: Pt[], w: number, h: number, side = PHOTO_SIDE): StraightenPlan | string {
  if (!(w > 0) || !(h > 0) || !Number.isFinite(w) || !Number.isFinite(h)) return 'The width and the height must be numbers above 0.';
  if (corners.length !== 4 || !corners.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))) return 'Click the four corners of the rectangle.';
  const toPixel = m3inv(pixelToDrawing(ph));
  if (!toPixel) return 'The photo is too small to straighten: scale it up first.';
  const q = corners.map(p => m3apply(toPixel, p)!);
  // Round the shape in order, not across it, and not three in a line: every corner turns the same way.
  const a2 = area2(q);
  const turns = q.map((p, i) => cross(sub(p, q[(i + 3) % 4]), sub(q[(i + 1) % 4], p)));
  const sides = q.map((p, i) => dist(p, q[(i + 1) % 4]));
  const sharp = turns.every((t, i) => Math.abs(t) > 0.02 * sides[i] * sides[(i + 3) % 4] && Math.sign(t) === Math.sign(a2));
  if (Math.abs(a2) < 200 || !sharp) return 'Those corners do not make a rectangle: click its four corners in order round its edge (not across it), each one a clear corner.';

  const ang = Math.atan2(corners[1].y - corners[0].y, corners[1].x - corners[0].x);
  const dir = [P(1, 0), P(0, 1), P(-1, 0), P(0, -1)][(((Math.round(ang / (Math.PI / 2)) % 4) + 4) % 4)];
  // The rectangle goes round the same way as the clicks, so the picture is not turned over.
  const norm = mul(perp(dir), Math.sign(area2(corners)));
  const c0 = corners[0];
  const target: M3 = [w * dir.x, h * norm.x, c0.x, w * dir.y, h * norm.y, c0.y, 0, 0, 1];
  const square = squareToQuad(q);
  const fromSquare = m3inv(square);
  const fromTarget = m3inv(target);
  if (!fromSquare || !fromTarget) return 'Those corners do not make a rectangle: click its four corners in order round its edge.';
  let fwd = m3mul(target, fromSquare);
  const middle = P((q[0].x + q[1].x + q[2].x + q[3].x) / 4, (q[0].y + q[1].y + q[2].y + q[3].y) / 4);
  const wOf = (m: M3, p: Pt) => m[6] * p.x + m[7] * p.y + m[8];
  if (wOf(fwd, middle) < 0) fwd = fwd.map(v => -v) as M3;
  const wMid = wOf(fwd, middle);

  // The photo's outline on the drawing: the part in front of the camera's horizon, kept within reach of the rectangle.
  const outline = ph.clip ?? [P(0, 0), P(ph.px, 0), P(ph.px, ph.py), P(0, ph.py)];
  const front = cutPoly(outline, p => wOf(fwd, p) - 1e-6 * wMid).map(p => m3apply(fwd, p)!);
  const tc = [P(0, 0), P(1, 0), P(1, 1), P(0, 1)].map(p => m3apply(target, p)!);
  const reach = STRAIGHTEN_REACH * Math.max(w, h);
  const limit: Box = {
    x0: Math.min(...tc.map(p => p.x)) - reach, y0: Math.min(...tc.map(p => p.y)) - reach,
    x1: Math.max(...tc.map(p => p.x)) + reach, y1: Math.max(...tc.map(p => p.y)) + reach,
  };
  const kept = cutToBox(front, limit);
  if (kept.length < 3) return 'Nothing of the photo is left once straightened: check the corners.';
  const x0 = Math.min(...kept.map(p => p.x));
  const y0 = Math.min(...kept.map(p => p.y));
  const bw = Math.max(...kept.map(p => p.x)) - x0;
  const bh = Math.max(...kept.map(p => p.y)) - y0;

  // Pixels: as fine as the photo was at the rectangle (half again, for the near side), at most `side` across.
  const fine = Math.sqrt(Math.abs(a2) / 2 / (w * h));
  const r = Math.min(1.5 * fine, side / Math.max(bw, bh));
  const px = Math.max(1, Math.min(side, Math.ceil(bw * r)));
  const py = Math.max(1, Math.min(side, Math.ceil(bh * r)));
  const top = y0 + py / r;
  const fromNew: M3 = [1 / r, 0, x0, 0, -1 / r, top, 0, 0, 1];
  const back = m3mul(m3mul(square, fromTarget), fromNew);
  const clipPx = kept.map(p => P(Math.round((p.x - x0) * r * 100) / 100, Math.round((top - p.y) * r * 100) / 100));
  const full = Math.abs(area2(clipPx)) / 2 >= 0.999 * px * py;
  return { back, px, py, at: P(x0, y0), u: P(px / r, 0), ...(full ? {} : { clip: clipPx }) };
}

/** The new picture's pixels (RGBA), each read from the old one through `back`; blank (white) where the photo does not reach. */
export function warpPixels(src: Uint8ClampedArray, sw: number, sh: number, back: M3, ow: number, oh: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(ow * oh * 4).fill(255);
  const [a, b, c, d, e, f, g, h, k] = back;
  for (let j = 0; j < oh; j++) {
    const y = j + 0.5;
    for (let i = 0; i < ow; i++) {
      const x = i + 0.5;
      const w = g * x + h * y + k;
      if (!(w > 0)) continue;
      // Pixel middles sit at n + 0.5.
      const u = (a * x + b * y + c) / w - 0.5;
      const v = (d * x + e * y + f) / w - 0.5;
      if (!(u >= -0.5 && v >= -0.5 && u <= sw - 0.5 && v <= sh - 0.5)) continue;
      const uc = Math.min(sw - 1, Math.max(0, u));
      const vc = Math.min(sh - 1, Math.max(0, v));
      const u0 = Math.min(sw - 2, Math.floor(uc));
      const v0 = Math.min(sh - 2, Math.floor(vc));
      const fu = sw > 1 ? uc - Math.max(0, u0) : 0;
      const fv = sh > 1 ? vc - Math.max(0, v0) : 0;
      const i00 = (Math.max(0, v0) * sw + Math.max(0, u0)) * 4;
      const i01 = sw > 1 ? i00 + 4 : i00;
      const i10 = sh > 1 ? i00 + sw * 4 : i00;
      const i11 = sh > 1 ? i01 + sw * 4 : i01;
      const o = (j * ow + i) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const top = src[i00 + ch] + (src[i01 + ch] - src[i00 + ch]) * fu;
        const bot = src[i10 + ch] + (src[i11 + ch] - src[i10 + ch]) * fu;
        out[o + ch] = top + (bot - top) * fv;
      }
    }
  }
  return out;
}

/**
 * Where the picture's pixels land on a page or screen: `to` maps a drawing point to that page (y down). The three
 * corners are enough for any painter (the fourth follows).
 */
export function photoOnPage(ph: Photo, to: (p: Pt) => Pt): { tl: Pt; tr: Pt; bl: Pt } {
  const c = photoCorners(ph);
  return { tl: to(c.tl), tr: to(c.tr), bl: to(c.bl) };
}

/** The canvas or SVG matrix [a, b, c, d, e, f] taking pixel (i, j) (j down from the top) to that page. */
export function pixelMatrix(ph: Photo, on: { tl: Pt; tr: Pt; bl: Pt }): [number, number, number, number, number, number] {
  return [(on.tr.x - on.tl.x) / ph.px, (on.tr.y - on.tl.y) / ph.px, (on.bl.x - on.tl.x) / ph.py, (on.bl.y - on.tl.y) / ph.py, on.tl.x, on.tl.y];
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPt = (v: unknown): v is Pt => !!v && typeof v === 'object' && finite((v as Pt).x) && finite((v as Pt).y);

/** The photo in a .tcad file, checked; null (left out) when anything in it is missing or impossible. */
export function readPhoto(v: unknown): Photo | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  // All of it is checked: one wrong character would stop the picture loading (and the drawing area with it).
  if (typeof o.jpeg !== 'string' || o.jpeg.length > 40_000_000 || o.jpeg.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(o.jpeg)) return null;
  if (!finite(o.px) || !finite(o.py) || o.px < 1 || o.py < 1 || o.px > 20000 || o.py > 20000) return null;
  if (!isPt(o.at) || !isPt(o.u) || Math.hypot(o.u.x, o.u.y) < 1e-12) return null;
  const opacity = finite(o.opacity) ? Math.min(1, Math.max(0.1, o.opacity)) : 0.5;
  // A damaged outline only loses the outline (the whole picture shows), not the photo.
  const clip = Array.isArray(o.clip) && o.clip.length >= 3 && o.clip.length <= 64 && o.clip.every(isPt) ? o.clip.map((p: Pt) => P(p.x, p.y)) : null;
  return {
    jpeg: o.jpeg, px: Math.round(o.px), py: Math.round(o.py), at: P(o.at.x, o.at.y), u: P(o.u.x, o.u.y), opacity, on: o.on !== false,
    name: typeof o.name === 'string' ? o.name.slice(0, 255) : 'photo', ...(clip ? { clip } : {}),
  };
}
