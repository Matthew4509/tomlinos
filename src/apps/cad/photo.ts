// The photo traced over: a picture laid under the drawing, sized and turned by points the person clicks on it (the
// two ends of a length they measured with a tape, an edge that should run straight across). It is kept in the .tcad
// as a JPEG and is never written to a DXF; printing leaves it out unless asked.
// No browser needed here: reading the picture's pixels is the window's job (cad.ts).
import { P, add, angleOf, dist, mul, perp, rotatePt, sub, type Box, type Pt } from './geom.ts';

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
  if (typeof o.jpeg !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(o.jpeg.slice(0, 64)) || o.jpeg.length > 40_000_000) return null;
  if (!finite(o.px) || !finite(o.py) || o.px < 1 || o.py < 1 || o.px > 20000 || o.py > 20000) return null;
  if (!isPt(o.at) || !isPt(o.u) || Math.hypot(o.u.x, o.u.y) < 1e-12) return null;
  const opacity = finite(o.opacity) ? Math.min(1, Math.max(0.1, o.opacity)) : 0.5;
  return { jpeg: o.jpeg, px: Math.round(o.px), py: Math.round(o.py), at: P(o.at.x, o.at.y), u: P(o.u.x, o.u.y), opacity, on: o.on !== false, name: typeof o.name === 'string' ? o.name.slice(0, 255) : 'photo' };
}
