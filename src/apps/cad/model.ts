// A TOMLIN CAD drawing: its units, its layers and its items (lines, arcs, circles, ellipses, polylines, curves through
// points, points and construction lines), kept as the true shapes in millimetres or inches, never as pixels. Also
// the pieces each item is made of, its snap points, and the .tcad file (JSON) it is saved as.
import {
  P, TAU, add, angleOf, at, boxOf, bulgeArc, curveThrough, dist, domain, ellN, isFull, joinBoxes, mid, mul, normAngle, pieceBox, polar, sub,
  type Box, type Piece, type Pt,
} from './geom.ts';

export type Units = 'mm' | 'inch';

export type LineType = 'continuous' | 'dashed' | 'centre' | 'hidden' | 'dotted';

export const LINE_TYPES: Record<LineType, string> = {
  continuous: 'Continuous', dashed: 'Dashed', centre: 'Centre (long and short)', hidden: 'Hidden (short dashes)', dotted: 'Dotted',
};

export interface Layer {
  name: string;
  /** A colour as #rrggbb, drawn on the dark blue drawing area. */
  colour: string;
  on: boolean;
  locked: boolean;
  lineType: LineType;
}

export type Shape =
  | { type: 'line'; a: Pt; b: Pt }
  | { type: 'arc'; c: Pt; r: number; a0: number; a1: number }
  | { type: 'circle'; c: Pt; r: number }
  | { type: 'ellipse'; c: Pt; m: Pt; ratio: number; t0: number; t1: number }
  /** bulges[i] belongs to the span from pts[i] to the next point (0 straight; tan of a quarter of the turn). */
  | { type: 'poly'; pts: Pt[]; bulges: number[]; closed: boolean }
  /** A smooth curve through the fit points. */
  | { type: 'spline'; fit: Pt[]; closed: boolean }
  | { type: 'point'; p: Pt }
  /** An endless construction line through p along the unit direction d. */
  | { type: 'xline'; p: Pt; d: Pt };

export type Ent = Shape & { id: number; layer: string };

export interface Drawing {
  units: Units;
  layers: Layer[];
  /** New items go on this layer. */
  current: string;
  ents: Ent[];
}

export const GEOMETRY = 'Geometry';
export const CONSTRUCTION = 'Construction';
export const DIMENSIONS = 'Dimensions';
export const TEXT = 'Text';

export function newDrawing(units: Units = 'mm'): Drawing {
  return {
    units,
    layers: [
      { name: GEOMETRY, colour: '#ffffff', on: true, locked: false, lineType: 'continuous' },
      { name: CONSTRUCTION, colour: '#e040e0', on: true, locked: false, lineType: 'dashed' },
      { name: DIMENSIONS, colour: '#60ff60', on: true, locked: false, lineType: 'continuous' },
      { name: TEXT, colour: '#ffe040', on: true, locked: false, lineType: 'continuous' },
    ],
    current: GEOMETRY,
    ents: [],
  };
}

/** Colours given to new layers in turn: each clear on the dark blue. */
export const LAYER_COLOURS = ['#40e0ff', '#ff8040', '#ff6090', '#c0a0ff', '#a0ffd0', '#ffe040', '#60ff60', '#e040e0', '#ffffff'];

/** The colours a layer can have, each with the name it is listed by (colour alone never tells them apart). */
export const COLOUR_NAMES: Record<string, string> = {
  '#ffffff': 'White', '#e040e0': 'Magenta', '#40e0ff': 'Light blue', '#ffe040': 'Yellow', '#60ff60': 'Green',
  '#ff8040': 'Orange', '#ff6090': 'Pink', '#c0a0ff': 'Lilac', '#a0ffd0': 'Mint', '#ff4040': 'Red', '#4080ff': 'Blue', '#c0c0c0': 'Grey',
};
export const colourName = (c: string) => COLOUR_NAMES[c] ?? c;

export const TYPE_NAMES: Record<Shape['type'], string> = {
  line: 'Line', arc: 'Arc', circle: 'Circle', ellipse: 'Ellipse', poly: 'Polyline', spline: 'Curve through points', point: 'Point', xline: 'Construction line',
};

// ---- Pieces and snap points ----------------------------------------------------------------------------------------

export function polyPieces(pts: Pt[], bulges: number[], closed: boolean): Piece[] {
  const out: Piece[] = [];
  const n = pts.length;
  const spans = closed ? n : n - 1;
  for (let i = 0; i < spans; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    if (dist(a, b) < 1e-12) continue;
    const bulge = bulges[i] ?? 0;
    out.push(Math.abs(bulge) < 1e-12 ? { k: 'seg', a, b } : bulgeArc(a, b, bulge));
  }
  return out;
}

export function piecesOf(s: Shape): Piece[] {
  switch (s.type) {
    case 'line':
      return [{ k: 'seg', a: s.a, b: s.b }];
    case 'arc':
      return [{ k: 'arc', c: s.c, r: s.r, a0: s.a0, a1: s.a1 }];
    case 'circle':
      return [{ k: 'arc', c: s.c, r: s.r, a0: 0, a1: TAU }];
    case 'ellipse':
      return [{ k: 'ell', c: s.c, m: s.m, ratio: s.ratio, t0: s.t0, t1: s.t1 }];
    case 'poly':
      return polyPieces(s.pts, s.bulges, s.closed);
    case 'spline':
      return curveThrough(s.fit, s.closed);
    case 'point':
      return [];
    case 'xline':
      return [{ k: 'xline', p: s.p, d: s.d }];
  }
}

export type SnapKind = 'end' | 'mid' | 'centre' | 'quadrant' | 'point';

/** The fixed snap points of an item: ends, middles, centres, quadrants and points. */
export function snapPoints(s: Shape): Array<{ p: Pt; kind: SnapKind }> {
  const out: Array<{ p: Pt; kind: SnapKind }> = [];
  const quads = (c: Pt, r: number, a0: number, a1: number) => {
    for (let q = 0; q < 4; q++) {
      const a = (q * Math.PI) / 2;
      if (isFull(a0, a1) || normAngle(a - a0) <= a1 - a0 + 1e-12) out.push({ p: polar(c, r, a), kind: 'quadrant' });
    }
  };
  switch (s.type) {
    case 'line':
      out.push({ p: s.a, kind: 'end' }, { p: s.b, kind: 'end' }, { p: mid(s.a, s.b), kind: 'mid' });
      break;
    case 'arc':
      out.push({ p: polar(s.c, s.r, s.a0), kind: 'end' }, { p: polar(s.c, s.r, s.a1), kind: 'end' }, { p: polar(s.c, s.r, (s.a0 + s.a1) / 2), kind: 'mid' }, { p: s.c, kind: 'centre' });
      quads(s.c, s.r, s.a0, s.a1);
      break;
    case 'circle':
      out.push({ p: s.c, kind: 'centre' });
      quads(s.c, s.r, 0, TAU);
      break;
    case 'ellipse': {
      const piece: Piece = { k: 'ell', c: s.c, m: s.m, ratio: s.ratio, t0: s.t0, t1: s.t1 };
      out.push({ p: s.c, kind: 'centre' });
      if (!isFull(s.t0, s.t1)) out.push({ p: at(piece, s.t0), kind: 'end' }, { p: at(piece, s.t1), kind: 'end' }, { p: at(piece, (s.t0 + s.t1) / 2), kind: 'mid' });
      const n = ellN(s.m, s.ratio);
      [s.m, n, mul(s.m, -1), mul(n, -1)].forEach((v, q) => {
        if (isFull(s.t0, s.t1) || normAngle((q * Math.PI) / 2 - s.t0) <= s.t1 - s.t0 + 1e-12) out.push({ p: add(s.c, v), kind: 'quadrant' });
      });
      break;
    }
    case 'poly':
      for (const p of s.pts) out.push({ p, kind: 'end' });
      for (const piece of polyPieces(s.pts, s.bulges, s.closed)) {
        if (piece.k === 'seg') out.push({ p: mid(piece.a, piece.b), kind: 'mid' });
        else if (piece.k === 'arc') {
          out.push({ p: polar(piece.c, piece.r, (piece.a0 + piece.a1) / 2), kind: 'mid' }, { p: piece.c, kind: 'centre' });
          quads(piece.c, piece.r, piece.a0, piece.a1);
        }
      }
      break;
    case 'spline':
      for (const p of s.fit) out.push({ p, kind: 'end' });
      break;
    case 'point':
      out.push({ p: s.p, kind: 'point' });
      break;
    case 'xline':
      out.push({ p: s.p, kind: 'point' });
      break;
  }
  return out;
}

/** The box around an item (null for a construction line, which has no end). */
export function shapeBox(s: Shape): Box | null {
  if (s.type === 'point') return boxOf([s.p]);
  let box: Box | null = null;
  for (const p of piecesOf(s)) box = joinBoxes(box, pieceBox(p));
  return box;
}

/** The two ends of an open item (for following a chain), or null for closed or endless ones. */
export function endsOf(s: Shape): [Pt, Pt] | null {
  switch (s.type) {
    case 'line':
      return [s.a, s.b];
    case 'arc':
      return [polar(s.c, s.r, s.a0), polar(s.c, s.r, s.a1)];
    case 'ellipse': {
      if (isFull(s.t0, s.t1)) return null;
      const piece: Piece = { k: 'ell', c: s.c, m: s.m, ratio: s.ratio, t0: s.t0, t1: s.t1 };
      return [at(piece, s.t0), at(piece, s.t1)];
    }
    case 'poly':
      return s.closed || s.pts.length < 2 ? null : [s.pts[0], s.pts[s.pts.length - 1]];
    case 'spline':
      return s.closed || s.fit.length < 2 ? null : [s.fit[0], s.fit[s.fit.length - 1]];
    default:
      return null;
  }
}

// ---- Shapes the tools make -----------------------------------------------------------------------------------------

/** tan(22.5 degrees): the bulge of a quarter circle. */
export const QUARTER = Math.tan(Math.PI / 8);

/** A rectangle from two corners, with rounded corners of radius r (0 for square ones). Drawn anticlockwise. */
export function rectangle(c1: Pt, c2: Pt, r = 0): Shape | null {
  const x0 = Math.min(c1.x, c2.x);
  const x1 = Math.max(c1.x, c2.x);
  const y0 = Math.min(c1.y, c2.y);
  const y1 = Math.max(c1.y, c2.y);
  if (x1 - x0 < 1e-12 || y1 - y0 < 1e-12) return null;
  const rr = Math.max(0, Math.min(r, (x1 - x0) / 2, (y1 - y0) / 2));
  if (rr < 1e-12) return { type: 'poly', pts: [P(x0, y0), P(x1, y0), P(x1, y1), P(x0, y1)], bulges: [0, 0, 0, 0], closed: true };
  const raw: Array<[Pt, number]> = [
    [P(x0 + rr, y0), 0], [P(x1 - rr, y0), QUARTER], [P(x1, y0 + rr), 0], [P(x1, y1 - rr), QUARTER],
    [P(x1 - rr, y1), 0], [P(x0 + rr, y1), QUARTER], [P(x0, y1 - rr), 0], [P(x0, y0 + rr), QUARTER],
  ];
  // A radius of half a side leaves a straight span of no length: drop that point.
  const kept = raw.filter(([p], i) => dist(p, raw[(i + 1) % raw.length][0]) > 1e-12);
  return { type: 'poly', pts: kept.map(k => k[0]), bulges: kept.map(k => k[1]), closed: true };
}

/** A polygon with `sides` corners around c; `corners` puts the corners on the radius, otherwise the flats touch it. */
export function polygon(c: Pt, sides: number, r: number, toward: Pt, corners: boolean): Shape | null {
  if (!(sides >= 3) || !(r > 0)) return null;
  const R = corners ? r : r / Math.cos(Math.PI / sides);
  const start = angleOf(sub(toward, c)) + (corners ? 0 : Math.PI / sides);
  const pts: Pt[] = [];
  for (let i = 0; i < sides; i++) pts.push(polar(c, R, start + (i * TAU) / sides));
  return { type: 'poly', pts, bulges: pts.map(() => 0), closed: true };
}

/** A slot (two half circles joined by straight sides) between two centres, `width` across. */
export function slot(a: Pt, b: Pt, width: number): Shape | null {
  const r = width / 2;
  if (!(r > 0)) return null;
  if (dist(a, b) < 1e-12) return { type: 'circle', c: a, r };
  const u = mul(sub(b, a), 1 / dist(a, b));
  const n = P(-u.y * r, u.x * r);
  return { type: 'poly', pts: [sub(a, n), sub(b, n), add(b, n), add(a, n)], bulges: [0, 1, 0, 1], closed: true };
}

/** An ellipse from its centre, the end of one axis and the other half-axis (the longer one is kept as the main axis). */
export function ellipse(c: Pt, axisEnd: Pt, other: number): Shape | null {
  const m = sub(axisEnd, c);
  const a = Math.hypot(m.x, m.y);
  const b = Math.abs(other);
  if (a < 1e-12 || b < 1e-12) return null;
  if (b <= a) return { type: 'ellipse', c, m, ratio: b / a, t0: 0, t1: TAU };
  const n = P((-m.y / a) * b, (m.x / a) * b);
  return { type: 'ellipse', c, m: n, ratio: a / b, t0: 0, t1: TAU };
}

// ---- Describing an item (Utils > List) ----------------------------------------------------------------------------

export function fmt(v: number, units: Units): string {
  const d = units === 'mm' ? 3 : 4;
  const s = (Math.abs(v) < 0.5 * 10 ** -d ? 0 : v).toFixed(d);
  return s.replace(/\.?0+$/, '') || '0';
}

export const fmtPt = (p: Pt, u: Units): string => `${fmt(p.x, u)}, ${fmt(p.y, u)}`;
export const deg = (a: number): string => `${fmt((a * 180) / Math.PI, 'mm')}°`;

/** Arc length of a piece. */
export function pieceLength(p: Piece): number {
  if (p.k === 'seg') return dist(p.a, p.b);
  if (p.k === 'arc') return p.r * (p.a1 - p.a0);
  if (p.k === 'xline') return Infinity;
  const [lo, hi] = domain(p)!;
  let total = 0;
  let prev = at(p, lo);
  const n = 2048;
  for (let i = 1; i <= n; i++) {
    const q = at(p, lo + ((hi - lo) * i) / n);
    total += dist(prev, q);
    prev = q;
  }
  return total;
}

export function describe(e: Ent, u: Units): string[] {
  const unitName = u === 'mm' ? 'mm' : 'in';
  const lines = [`${TYPE_NAMES[e.type]} on layer ${e.layer}`];
  const length = () => piecesOf(e).reduce((t, p) => t + pieceLength(p), 0);
  switch (e.type) {
    case 'line':
      lines.push(`From ${fmtPt(e.a, u)} to ${fmtPt(e.b, u)}`, `Length ${fmt(dist(e.a, e.b), u)} ${unitName}, angle ${deg(normAngle(angleOf(sub(e.b, e.a))))}`);
      break;
    case 'arc':
      lines.push(`Centre ${fmtPt(e.c, u)}, radius ${fmt(e.r, u)} ${unitName}`, `From ${deg(normAngle(e.a0))} to ${deg(normAngle(e.a1))} anticlockwise (${deg(e.a1 - e.a0)})`, `Length ${fmt(length(), u)} ${unitName}`);
      break;
    case 'circle':
      lines.push(`Centre ${fmtPt(e.c, u)}`, `Radius ${fmt(e.r, u)}, diameter ${fmt(2 * e.r, u)} ${unitName}`, `Circumference ${fmt(TAU * e.r, u)} ${unitName}`);
      break;
    case 'ellipse':
      lines.push(`Centre ${fmtPt(e.c, u)}`, `Half-axes ${fmt(Math.hypot(e.m.x, e.m.y), u)} and ${fmt(Math.hypot(e.m.x, e.m.y) * e.ratio, u)} ${unitName}, turned ${deg(normAngle(angleOf(e.m)))}`);
      if (!isFull(e.t0, e.t1)) lines.push(`Part from ${deg(normAngle(e.t0))} to ${deg(normAngle(e.t1))}`);
      break;
    case 'poly':
      lines.push(`${e.pts.length} points, ${e.closed ? 'closed' : 'open'}`, `Length ${fmt(length(), u)} ${unitName}`);
      break;
    case 'spline':
      lines.push(`${e.fit.length} points, ${e.closed ? 'closed' : 'open'}`, `Length ${fmt(length(), u)} ${unitName}`);
      break;
    case 'point':
      lines.push(`At ${fmtPt(e.p, u)}`);
      break;
    case 'xline':
      lines.push(`Through ${fmtPt(e.p, u)} at ${deg(normAngle(angleOf(e.d)))}`);
      break;
  }
  return lines;
}

// ---- The .tcad file ------------------------------------------------------------------------------------------------

export class CadProblem extends Error {}

const MAX_ITEMS = 200_000;
const MAX_POINTS = 2_000_000;

/** The drawing as a .tcad file: plain JSON, numbers at full precision. */
export function writeTcad(d: Drawing): string {
  const items = d.ents.map(({ id: _id, ...rest }) => rest);
  return JSON.stringify({ tomlinCad: 1, units: d.units, current: d.current, layers: d.layers, items });
}

const num = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new CadProblem('a number in it is missing or not a number');
  return v;
};
const pt = (v: unknown): Pt => {
  if (!v || typeof v !== 'object') throw new CadProblem('a point in it is missing');
  const o = v as Record<string, unknown>;
  return P(num(o.x), num(o.y));
};

/** Reads a .tcad file: the drawing, and how many items were of a kind this version does not know (left out). */
export function readTcad(text: string): { drawing: Drawing; skipped: number } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new CadProblem('This file is not a TOMLIN CAD drawing (it is not the JSON a .tcad file holds).');
  }
  if (!data || typeof data !== 'object' || (data as Record<string, unknown>).tomlinCad !== 1) {
    throw new CadProblem('This file is not a TOMLIN CAD drawing, or it was saved by a newer version of TOMLIN CAD.');
  }
  const o = data as Record<string, unknown>;
  const units: Units = o.units === 'inch' ? 'inch' : 'mm';
  const layers: Layer[] = [];
  if (!Array.isArray(o.layers) || o.layers.length > 1000) throw new CadProblem('Its list of layers is missing or too long.');
  for (const l of o.layers) {
    const r = (l ?? {}) as Record<string, unknown>;
    const name = typeof r.name === 'string' ? r.name.trim().slice(0, 64) : '';
    if (!name || layers.some(x => x.name === name)) continue;
    const colour = typeof r.colour === 'string' && /^#[0-9a-f]{6}$/i.test(r.colour) ? r.colour.toLowerCase() : '#ffffff';
    const lineType = typeof r.lineType === 'string' && r.lineType in LINE_TYPES ? (r.lineType as LineType) : 'continuous';
    layers.push({ name, colour, on: r.on !== false, locked: r.locked === true, lineType });
  }
  if (!layers.length) layers.push(...newDrawing().layers);
  if (!Array.isArray(o.items) || o.items.length > MAX_ITEMS) throw new CadProblem(`Its list of items is missing or longer than ${MAX_ITEMS.toLocaleString('en-GB')}.`);
  const ents: Ent[] = [];
  let skipped = 0;
  let points = 0;
  let id = 1;
  const pts = (v: unknown, min: number): Pt[] => {
    if (!Array.isArray(v) || v.length < min) throw new CadProblem('a polyline or curve in it has too few points');
    points += v.length;
    if (points > MAX_POINTS) throw new CadProblem('it holds more points than TOMLIN CAD opens');
    return v.map(pt);
  };
  try {
    for (const raw of o.items) {
      const r = (raw ?? {}) as Record<string, unknown>;
      const layer = typeof r.layer === 'string' && layers.some(l => l.name === r.layer) ? r.layer : layers[0].name;
      let s: Shape | null = null;
      switch (r.type) {
        case 'line':
          s = { type: 'line', a: pt(r.a), b: pt(r.b) };
          break;
        case 'arc': {
          const a0 = num(r.a0);
          const a1 = num(r.a1);
          if (!(num(r.r) > 0) || !(a1 > a0) || a1 - a0 > TAU + 1e-9) throw new CadProblem('an arc in it has an impossible size');
          s = { type: 'arc', c: pt(r.c), r: num(r.r), a0, a1 };
          break;
        }
        case 'circle':
          if (!(num(r.r) > 0)) throw new CadProblem('a circle in it has no size');
          s = { type: 'circle', c: pt(r.c), r: num(r.r) };
          break;
        case 'ellipse': {
          const ratio = num(r.ratio);
          const t0 = num(r.t0);
          const t1 = num(r.t1);
          if (!(ratio > 0 && ratio <= 1) || !(t1 > t0) || t1 - t0 > TAU + 1e-9) throw new CadProblem('an ellipse in it has an impossible size');
          s = { type: 'ellipse', c: pt(r.c), m: pt(r.m), ratio, t0, t1 };
          break;
        }
        case 'poly': {
          const p = pts(r.pts, 2);
          const b = Array.isArray(r.bulges) ? r.bulges.map(num) : [];
          s = { type: 'poly', pts: p, bulges: p.map((_, i) => (Math.abs(b[i] ?? 0) <= 1e6 ? (b[i] ?? 0) : 0)), closed: r.closed === true };
          break;
        }
        case 'spline':
          s = { type: 'spline', fit: pts(r.fit, 2), closed: r.closed === true };
          break;
        case 'point':
          s = { type: 'point', p: pt(r.p) };
          break;
        case 'xline': {
          const d = pt(r.d);
          const l = Math.hypot(d.x, d.y);
          if (!(l > 0)) throw new CadProblem('a construction line in it has no direction');
          s = { type: 'xline', p: pt(r.p), d: P(d.x / l, d.y / l) };
          break;
        }
        default:
          skipped++;
      }
      if (s) ents.push({ ...s, id: id++, layer });
    }
  } catch (error) {
    if (error instanceof CadProblem) throw new CadProblem(`This drawing cannot be opened: ${error.message}.`);
    throw error;
  }
  const current = typeof o.current === 'string' && layers.some(l => l.name === o.current) ? o.current : layers[0].name;
  return { drawing: { units, layers, current, ents }, skipped };
}

export const centreOfBox = (b: Box): Pt => P((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2);
