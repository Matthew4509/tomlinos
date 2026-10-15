// TOMLIN CAD's CAD menu, as plain shape changes: trim (cut away the part between crossings), extend (to the next item
// in the way), break (at a point, or between two points), fillet and chamfer (two items, or the corners of a
// polyline), offset (lines, arcs, circles and polylines of them), join into closed shapes ("geometries", a polyline of
// lines and arcs with a start and a direction, as a CAM program machines them), close, set the start point, reverse,
// explode; and the area and length of a shape. Each returns the new shapes, or a sentence saying why it cannot.
import {
  TAU, add, angleOf, bulgeArc, ccwArc, circleTTR, cross, dist, dot, ellN, intersect, isFull, lerp, len, mul, normAngle, perp, polar, sub, unit,
  type Piece, type Pt,
} from './geom.ts';
import { endsOf, piecesOf, type Ent, type Shape } from './model.ts';

const EPS = 1e-9;
/** Ends closer than this are joined (a ten-thousandth of a unit). */
export const JOIN_TOL = 1e-4;

// ---- Walking along a shape -----------------------------------------------------------------------------------------

/** One span of a polyline: straight, or an arc (its anticlockwise piece) with the bulge it was given. */
interface Span {
  a: Pt;
  b: Pt;
  bulge: number;
  arc: Extract<Piece, { k: 'arc' }> | null;
}

function spansOf(pts: Pt[], bulges: number[], closed: boolean): Span[] {
  const n = pts.length;
  const out: Span[] = [];
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const bulge = bulges[i] ?? 0;
    out.push({ a, b, bulge, arc: Math.abs(bulge) > 1e-12 && dist(a, b) > 1e-12 ? bulgeArc(a, b, bulge) : null });
  }
  return out;
}

/** The point a fraction f of the way along a span, in the direction it is travelled. */
function spanAt(s: Span, f: number): Pt {
  if (!s.arc) return lerp(s.a, s.b, f);
  const span = s.arc.a1 - s.arc.a0;
  return polar(s.arc.c, s.arc.r, s.bulge > 0 ? s.arc.a0 + f * span : s.arc.a1 - f * span);
}

/** How far along a span (0 to 1) the point nearest q is. */
function spanParam(s: Span, q: Pt): number {
  if (!s.arc) {
    const d = sub(s.b, s.a);
    const l2 = dot(d, d);
    return l2 ? Math.max(0, Math.min(1, dot(sub(q, s.a), d) / l2)) : 0;
  }
  const span = s.arc.a1 - s.arc.a0;
  let off = normAngle(angleOf(sub(q, s.arc.c)) - s.arc.a0);
  if (off > span) off = off - span > TAU - off ? 0 : span;
  const f = off / span;
  return s.bulge > 0 ? f : 1 - f;
}

/** The bulge of the part of a span from f0 to f1. */
function partBulge(s: Span, f0: number, f1: number): number {
  if (!s.arc) return 0;
  const th = 4 * Math.atan(Math.abs(s.bulge)) * (f1 - f0);
  return Math.sign(s.bulge) * Math.tan(th / 4);
}

/**
 * A shape walked along one number: lo to hi (an open shape), or round and round with the given period (a closed one).
 * sub() makes the part between two of those numbers.
 */
export interface Path {
  lo: number;
  hi: number;
  closed: boolean;
  period: number;
  at(s: number): Pt;
  paramOf(q: Pt): number;
  sub(s0: number, s1: number): Shape | null;
}

export function pathOf(s: Shape): Path | null {
  switch (s.type) {
    case 'line':
      return {
        lo: 0, hi: 1, closed: false, period: 0,
        at: t => lerp(s.a, s.b, t),
        paramOf(q) {
          const d = sub(s.b, s.a);
          return dot(sub(q, s.a), d) / dot(d, d);
        },
        sub: (t0, t1) => (Math.abs(t1 - t0) * len(sub(s.b, s.a)) > EPS ? { type: 'line', a: lerp(s.a, s.b, t0), b: lerp(s.a, s.b, t1) } : null),
      };
    case 'arc':
    case 'circle': {
      const full = s.type === 'circle' || isFull(s.a0, s.a1);
      const a0 = s.type === 'arc' && !full ? s.a0 : 0;
      const a1 = s.type === 'arc' && !full ? s.a1 : TAU;
      return {
        lo: a0, hi: a1, closed: full, period: TAU,
        at: a => polar(s.c, s.r, a),
        paramOf(q) {
          const ang = angleOf(sub(q, s.c));
          if (full) return normAngle(ang);
          const off = normAngle(ang - a0);
          return a0 + (off > a1 - a0 ? (off - (a1 - a0) > TAU - off ? off - TAU : off) : off);
        },
        sub: (t0, t1) => (t1 - t0 <= 1e-12 ? null : t1 - t0 >= TAU - 1e-12 ? { type: 'circle', c: s.c, r: s.r } : { type: 'arc', ...ccwArc(s.c, s.r, t0, t1) }),
      };
    }
    case 'ellipse': {
      const full = isFull(s.t0, s.t1);
      const n = ellN(s.m, s.ratio);
      const a = len(s.m);
      const mu = unit(s.m);
      return {
        lo: full ? 0 : s.t0, hi: full ? TAU : s.t1, closed: full, period: TAU,
        at: t => add(s.c, add(mul(s.m, Math.cos(t)), mul(n, Math.sin(t)))),
        paramOf(q) {
          const v = sub(q, s.c);
          const t = Math.atan2(dot(v, perp(mu)) / (a * s.ratio), dot(v, mu) / a);
          if (full) return normAngle(t);
          const off = normAngle(t - s.t0);
          return s.t0 + (off > s.t1 - s.t0 ? (off - (s.t1 - s.t0) > TAU - off ? off - TAU : off) : off);
        },
        sub: (t0, t1) => (t1 - t0 > 1e-12 ? { type: 'ellipse', c: s.c, m: s.m, ratio: s.ratio, t0: normAngle(t0), t1: normAngle(t0) + Math.min(TAU, t1 - t0) } : null),
      };
    }
    case 'poly': {
      const spans = spansOf(s.pts, s.bulges, s.closed);
      const n = spans.length;
      if (!n) return null;
      const split = (t: number): [number, number] => {
        let i = Math.floor(t + 1e-12);
        let f = t - i;
        if (s.closed) i = ((i % n) + n) % n;
        else if (i >= n) {
          i = n - 1;
          f = 1;
        } else if (i < 0) {
          i = 0;
          f = 0;
        }
        return [i, Math.max(0, Math.min(1, f))];
      };
      return {
        lo: 0, hi: n, closed: s.closed, period: n,
        at(t) {
          const [i, f] = split(t);
          return spanAt(spans[i], f);
        },
        paramOf(q) {
          let best = 0;
          let bestD = Infinity;
          spans.forEach((sp, i) => {
            const f = spanParam(sp, q);
            const d = dist(spanAt(sp, f), q);
            if (d < bestD - 1e-12) {
              bestD = d;
              best = i + f;
            }
          });
          return best;
        },
        sub(t0, t1) {
          if (t1 - t0 < 1e-12) return null;
          const [i0, f0] = split(t0);
          const pts: Pt[] = [spanAt(spans[i0], f0)];
          const bulges: number[] = [];
          let t = t0;
          while (t < t1 - 1e-12) {
            const base = Math.floor(t + 1e-12);
            const e = Math.min(base + 1, t1);
            const [i] = split(base);
            const next = e === base + 1 ? spans[i].b : spanAt(spans[i], e - base);
            // A span of no length (two points on top of each other) is dropped.
            if (dist(next, pts[pts.length - 1]) > EPS) {
              bulges.push(partBulge(spans[i], t - base, e - base));
              pts.push(next);
            }
            t = e;
          }
          if (pts.length < 2) return null;
          bulges.push(0);
          return { type: 'poly', pts, bulges, closed: false };
        },
      };
    }
    default:
      return null;
  }
}

const CANNOT_WALK: Partial<Record<Shape['type'], string>> = {
  spline: 'A curve through points cannot be cut or stretched yet: draw it as arcs and lines (or a polyline) instead.',
  xline: 'A construction line has no ends to cut or stretch: draw a line along it instead.',
  point: 'A point has nothing to cut.',
};

/** The places along `s` (its own numbers) where other items cross it. */
function cutsOn(s: Shape, path: Path, others: Shape[]): number[] {
  const mine = piecesOf(s);
  const ts: number[] = [];
  for (const o of others) {
    for (const op of piecesOf(o)) {
      for (const p of mine) for (const x of intersect(p, op)) ts.push(path.paramOf(x));
    }
  }
  return ts.sort((a, b) => a - b).filter((t, i, all) => i === 0 || t - all[i - 1] > 1e-9);
}

// ---- Trim, break, extend ---------------------------------------------------------------------------------------------

/** Cuts away the part of `s` around q, between the nearest crossings with the other items. */
export function trim(s: Shape, q: Pt, others: Shape[]): Shape[] | string {
  const path = pathOf(s);
  if (!path) return CANNOT_WALK[s.type] ?? 'That cannot be trimmed.';
  const p = path.paramOf(q);
  if (!path.closed) {
    const cuts = cutsOn(s, path, others).filter(t => t > path.lo + 1e-9 && t < path.hi - 1e-9);
    if (!cuts.length) return 'Nothing crosses it, so there is nothing to cut back to. Delete removes it whole.';
    const bounds = [path.lo, ...cuts, path.hi];
    let i = 0;
    while (i < bounds.length - 2 && p > bounds[i + 1]) i++;
    const out: Shape[] = [];
    if (i > 0) out.push(path.sub(path.lo, bounds[i])!);
    if (i + 1 < bounds.length - 1) out.push(path.sub(bounds[i + 1], path.hi)!);
    return out.filter(Boolean);
  }
  const cuts = cutsOn(s, path, others).map(t => ((t % path.period) + path.period) % path.period).sort((a, b) => a - b);
  if (cuts.length < 2) return 'A closed shape needs two crossings to cut between (it is crossed fewer than twice).';
  const pp = ((p % path.period) + path.period) % path.period;
  let k = cuts.findIndex((c, i) => pp >= c && pp < (cuts[i + 1] ?? Infinity));
  if (k < 0) k = cuts.length - 1;
  const from = cuts[(k + 1) % cuts.length];
  let to = cuts[k];
  while (to <= from) to += path.period;
  return [path.sub(from, to)!].filter(Boolean);
}

/** Splits an open shape in two at q. */
export function breakAt(s: Shape, q: Pt): Shape[] | string {
  const path = pathOf(s);
  if (!path) return CANNOT_WALK[s.type] ?? 'That cannot be broken.';
  if (path.closed) return 'A closed shape needs two points to break it: use Break between two points.';
  const p = path.paramOf(q);
  if (p <= path.lo + 1e-9 || p >= path.hi - 1e-9) return 'That point is at an end: there is nothing to break.';
  return [path.sub(path.lo, p), path.sub(p, path.hi)].filter((x): x is Shape => !!x);
}

/** Takes out the part between two points (on a circle or closed shape: going anticlockwise, or along, from the first). */
export function breakBetween(s: Shape, q1: Pt, q2: Pt): Shape[] | string {
  const path = pathOf(s);
  if (!path) return CANNOT_WALK[s.type] ?? 'That cannot be broken.';
  const p1 = path.paramOf(q1);
  const p2 = path.paramOf(q2);
  if (Math.abs(p1 - p2) < 1e-9) return 'The two points are the same.';
  if (!path.closed) {
    const [a, b] = p1 < p2 ? [p1, p2] : [p2, p1];
    return [path.sub(path.lo, a), path.sub(b, path.hi)].filter((x): x is Shape => !!x);
  }
  let to = p1;
  while (to <= p2) to += path.period;
  return [path.sub(p2, to)].filter((x): x is Shape => !!x);
}

/** The end of an arc piece reached by turning from `from` the way given (+1 anticlockwise). */
function nextOnCircle(c: Pt, r: number, from: number, way: 1 | -1, others: Shape[], skip: number): number | null {
  const full: Piece = { k: 'arc', c, r, a0: 0, a1: TAU };
  let best: number | null = null;
  for (const o of others) {
    for (const op of piecesOf(o)) {
      for (const x of intersect(full, op)) {
        const d = way > 0 ? normAngle(angleOf(sub(x, c)) - from) : normAngle(from - angleOf(sub(x, c)));
        if (d > 1e-9 && d < TAU - skip - 1e-9 && (best === null || d < best)) best = d;
      }
    }
  }
  return best;
}

/** How far along the endless line from `from` in direction d (unit) the next item is met. */
function nextOnLine(from: Pt, d: Pt, others: Shape[]): number | null {
  const line: Piece = { k: 'xline', p: from, d };
  let best: number | null = null;
  for (const o of others) {
    for (const op of piecesOf(o)) {
      for (const x of intersect(line, op)) {
        const t = dot(sub(x, from), d);
        if (t > 1e-9 && (best === null || t < best)) best = t;
      }
    }
  }
  return best;
}

/** Stretches the end of `s` nearest q until it meets the next item in the way. */
export function extend(s: Shape, q: Pt, others: Shape[]): Shape | string {
  const none = 'Nothing is in the way of that end, so there is nothing to extend it to.';
  switch (s.type) {
    case 'line': {
      const atB = dist(q, s.b) <= dist(q, s.a);
      const from = atB ? s.b : s.a;
      const d = unit(atB ? sub(s.b, s.a) : sub(s.a, s.b));
      const t = nextOnLine(from, d, others);
      if (t === null) return none;
      const to = add(from, mul(d, t));
      return atB ? { ...s, b: to } : { ...s, a: to };
    }
    case 'arc': {
      const atEnd = dist(q, polar(s.c, s.r, s.a1)) <= dist(q, polar(s.c, s.r, s.a0));
      const d = nextOnCircle(s.c, s.r, atEnd ? s.a1 : s.a0, atEnd ? 1 : -1, others, s.a1 - s.a0);
      if (d === null) return none;
      return atEnd ? { ...s, a1: s.a1 + d } : { ...s, a0: normAngle(s.a0 - d), a1: normAngle(s.a0 - d) + (s.a1 - s.a0) + d };
    }
    case 'ellipse': {
      if (isFull(s.t0, s.t1)) return 'A whole ellipse has no ends to extend.';
      const path = pathOf(s)!;
      const atEnd = dist(q, path.at(s.t1)) <= dist(q, path.at(s.t0));
      const full: Shape = { ...s, t0: 0, t1: TAU };
      const fullPath = pathOf(full)!;
      let best: number | null = null;
      for (const o of others) {
        for (const op of piecesOf(o)) {
          for (const x of intersect(piecesOf(full)[0], op)) {
            const t = fullPath.paramOf(x);
            const d = atEnd ? normAngle(t - s.t1) : normAngle(s.t0 - t);
            if (d > 1e-9 && d < TAU - (s.t1 - s.t0) - 1e-9 && (best === null || d < best)) best = d;
          }
        }
      }
      if (best === null) return none;
      return atEnd ? { ...s, t1: s.t1 + best } : { ...s, t0: normAngle(s.t0 - best), t1: normAngle(s.t0 - best) + (s.t1 - s.t0) + best };
    }
    case 'poly': {
      if (s.closed) return 'A closed polyline has no ends to extend.';
      const last = s.pts.length - 1;
      const atEnd = dist(q, s.pts[last]) <= dist(q, s.pts[0]);
      const i = atEnd ? last - 1 : 0;
      const sp = spansOf(s.pts, s.bulges, false)[i];
      // The rest of the polyline counts as in the way too.
      const rest: Shape[] = [...others];
      const restPts = atEnd ? s.pts.slice(0, -1) : s.pts.slice(1);
      if (restPts.length >= 2) rest.push({ type: 'poly', pts: restPts, bulges: atEnd ? s.bulges.slice(0, -2).concat([0]) : s.bulges.slice(1), closed: false });
      const pts = [...s.pts];
      const bulges = [...s.bulges];
      if (!sp.arc) {
        const grown = extend({ type: 'line', a: sp.a, b: sp.b }, atEnd ? sp.b : sp.a, rest);
        if (typeof grown === 'string') return grown;
        if (grown.type !== 'line') return none;
        if (atEnd) pts[last] = grown.b;
        else pts[0] = grown.a;
        return { ...s, pts, bulges };
      }
      // The arc span's end at the polyline's end is a0 or a1 of its anticlockwise piece.
      const endIsA1 = (atEnd && sp.bulge > 0) || (!atEnd && sp.bulge < 0);
      const grown = extend({ type: 'arc', c: sp.arc.c, r: sp.arc.r, a0: sp.arc.a0, a1: sp.arc.a1 }, polar(sp.arc.c, sp.arc.r, endIsA1 ? sp.arc.a1 : sp.arc.a0), rest);
      if (typeof grown === 'string') return grown;
      if (grown.type !== 'arc') return none;
      const newEnd = polar(grown.c, grown.r, endIsA1 ? grown.a1 : grown.a0);
      const b = Math.sign(sp.bulge) * Math.tan((grown.a1 - grown.a0) / 4);
      if (atEnd) pts[last] = newEnd;
      else pts[0] = newEnd;
      bulges[i] = b;
      return { ...s, pts, bulges };
    }
    default:
      return CANNOT_WALK[s.type] ?? 'That cannot be extended.';
  }
}

// ---- Fillet and chamfer --------------------------------------------------------------------------------------------

const lineDir = (s: Extract<Shape, { type: 'line' }>) => unit(sub(s.b, s.a));
const sideOf = (a: Pt, d: Pt, q: Pt) => Math.sign(cross(d, sub(q, a)));

/** Cuts or stretches a line so it runs from `to` towards the end on the q side. */
function lineTo(s: Extract<Shape, { type: 'line' }>, to: Pt, q: Pt): Shape | null {
  const d = sub(s.b, s.a);
  const tq = dot(sub(q, s.a), d) / dot(d, d);
  const tt = dot(sub(to, s.a), d) / dot(d, d);
  const keep = tq >= tt ? s.b : s.a;
  return dist(keep, to) > EPS ? { type: 'line', a: to, b: keep } : null;
}

/** Cuts or stretches an arc so its end nearer `to` is at `to` (a point on its circle). */
function arcTo(s: Extract<Shape, { type: 'arc' }>, to: Pt): Shape | null {
  const ang = angleOf(sub(to, s.c));
  const nearEnd = dist(polar(s.c, s.r, s.a1), to) <= dist(polar(s.c, s.r, s.a0), to);
  const arc = nearEnd ? ccwArc(s.c, s.r, s.a0, ang) : ccwArc(s.c, s.r, ang, s.a1);
  return arc.a1 - arc.a0 > 1e-9 && arc.a1 - arc.a0 < TAU - 1e-9 ? { type: 'arc', ...arc } : null;
}

export interface TwoItemChange {
  /** The two items as they become (null: used up entirely). */
  first: Shape | null;
  second: Shape | null;
  /** The fillet arc or chamfer line between them (none for a sharp corner). */
  added: Shape | null;
}

/**
 * Fillets two items (lines or arcs) with radius r, the round on the side of the places picked; r = 0 makes a sharp
 * corner (lines only). Each item is cut or stretched to where the round touches it.
 */
export function fillet(A: Shape, qa: Pt, B: Shape, qb: Pt, r: number): TwoItemChange | string {
  const ok = (s: Shape) => s.type === 'line' || s.type === 'arc';
  if (!ok(A) || !ok(B)) return 'Fillet joins two lines or arcs (for a polyline, pick two of its straight sides, or use Fillet every corner).';
  if (r < 0) return 'The radius must be 0 or more.';
  if (A.type === 'line' && B.type === 'line') {
    const da = lineDir(A);
    const db = lineDir(B);
    if (Math.abs(cross(da, db)) < 1e-12) return 'The two lines are parallel, so they make no corner.';
    const t = cross(sub(B.a, A.a), db) / cross(da, db);
    const corner = add(A.a, mul(da, t));
    if (r === 0) return { first: lineTo(A, corner, qa), second: lineTo(B, corner, qb), added: null };
    // The round sits in the angle between the two kept arms: on qb's side of A and on qa's side of B.
    const ua = mul(da, Math.sign(dot(sub(qa, corner), da)) || 1);
    const ub = mul(db, Math.sign(dot(sub(qb, corner), db)) || 1);
    const half = Math.acos(Math.max(-1, Math.min(1, dot(ua, ub)))) / 2;
    if (half < 1e-9 || Math.PI / 2 - half < 1e-9) return 'Those lines make no corner to round.';
    const back = r / Math.tan(half);
    const ta = add(corner, mul(ua, back));
    const tb = add(corner, mul(ub, back));
    const c = add(corner, mul(unit(add(ua, ub)), r / Math.sin(half)));
    const s = angleOf(sub(ta, c));
    const e = angleOf(sub(tb, c));
    const arc = normAngle(e - s) <= Math.PI ? ccwArc(c, r, s, e) : ccwArc(c, r, e, s);
    const first = lineTo(A, ta, add(corner, mul(ua, back + 1)));
    const second = lineTo(B, tb, add(corner, mul(ub, back + 1)));
    return { first, second, added: { type: 'arc', ...arc } };
  }
  if (r === 0) return 'A sharp corner (radius 0) is made between two lines only.';
  const pa = piecesOf(A)[0];
  const pb = piecesOf(B)[0];
  const found = circleTTR(pa, pb, r, qa, qb);
  if (found === 'shape' || !found) return `No round of radius ${r} fits between those two.`;
  const [ta, tb] = found.touch;
  const first = A.type === 'line' ? lineTo(A, ta, qa) : arcTo(A as Extract<Shape, { type: 'arc' }>, ta);
  const second = B.type === 'line' ? lineTo(B, tb, qb) : arcTo(B as Extract<Shape, { type: 'arc' }>, tb);
  const s = angleOf(sub(ta, found.c));
  const e = angleOf(sub(tb, found.c));
  const arc = normAngle(e - s) <= Math.PI ? ccwArc(found.c, r, s, e) : ccwArc(found.c, r, e, s);
  return { first, second, added: { type: 'arc', ...arc } };
}

/** Chamfers two lines: d1 back along the first from the corner, d2 along the second, joined by a straight line. */
export function chamfer(A: Shape, qa: Pt, B: Shape, qb: Pt, d1: number, d2: number): TwoItemChange | string {
  if (A.type !== 'line' || B.type !== 'line') return 'Chamfer cuts the corner between two lines (for a polyline, pick two of its straight sides, or use Chamfer every corner).';
  if (!(d1 > 0) || !(d2 > 0)) return 'The chamfer distances must be above 0.';
  const da = lineDir(A);
  const db = lineDir(B);
  if (Math.abs(cross(da, db)) < 1e-12) return 'The two lines are parallel, so they make no corner.';
  const t = cross(sub(B.a, A.a), db) / cross(da, db);
  const corner = add(A.a, mul(da, t));
  const ua = mul(da, Math.sign(dot(sub(qa, corner), da)) || 1);
  const ub = mul(db, Math.sign(dot(sub(qb, corner), db)) || 1);
  const pa = add(corner, mul(ua, d1));
  const pb = add(corner, mul(ub, d2));
  return { first: lineTo(A, pa, add(corner, mul(ua, d1 + 1))), second: lineTo(B, pb, add(corner, mul(ub, d2 + 1))), added: { type: 'line', a: pa, b: pb } };
}

/**
 * Rounds (r) or cuts (d1, d2) a polyline's corners between two straight sides: every corner, or only `only`. A corner
 * whose sides are too short, or next to an arc, is left as it is and counted.
 */
export function polyCorners(s: Extract<Shape, { type: 'poly' }>, how: { round: number } | { cut: [number, number] }, only?: number): { shape: Shape; done: number; skipped: number } {
  const n = s.pts.length;
  const spans = spansOf(s.pts, s.bulges, s.closed);
  const used = spans.map(() => 0);
  type Plan = { i: number; din: number; dout: number; bulge: number };
  const plans: Plan[] = [];
  let skipped = 0;
  for (let i = 0; i < n; i++) {
    if (only !== undefined && i !== only) continue;
    if (!s.closed && (i === 0 || i === n - 1)) continue;
    const inSpan = (i - 1 + n) % n;
    const outSpan = i;
    const si = spans[inSpan];
    const so = spans[outSpan];
    if (!si || !so || si.arc || so.arc) {
      skipped++;
      continue;
    }
    const u = unit(sub(si.a, s.pts[i]));
    const v = unit(sub(so.b, s.pts[i]));
    const theta = Math.acos(Math.max(-1, Math.min(1, dot(u, v))));
    if (theta < 1e-9 || Math.PI - theta < 1e-9) {
      skipped++;
      continue;
    }
    const turn = Math.sign(cross(sub(s.pts[i], si.a), sub(so.b, s.pts[i])));
    let din: number;
    let dout: number;
    let bulge = 0;
    if ('round' in how) {
      din = dout = how.round / Math.tan(theta / 2);
      bulge = turn * Math.tan((Math.PI - theta) / 4);
    } else [din, dout] = how.cut;
    if (used[inSpan] + din > dist(si.a, si.b) + 1e-9 || used[outSpan] + dout > dist(so.a, so.b) + 1e-9) {
      skipped++;
      continue;
    }
    used[inSpan] += din;
    used[outSpan] += dout;
    plans.push({ i, din, dout, bulge });
  }
  if (!plans.length) return { shape: s, done: 0, skipped };
  const pts: Pt[] = [];
  const bulges: number[] = [];
  for (let i = 0; i < n; i++) {
    const plan = plans.find(p => p.i === i);
    if (!plan) {
      pts.push(s.pts[i]);
      bulges.push(s.bulges[i] ?? 0);
      continue;
    }
    const p = s.pts[i];
    pts.push(add(p, mul(unit(sub(s.pts[(i - 1 + n) % n], p)), plan.din)));
    bulges.push(plan.bulge);
    pts.push(add(p, mul(unit(sub(s.pts[(i + 1) % n], p)), plan.dout)));
    bulges.push(s.bulges[i] ?? 0);
  }
  // A side used up entirely leaves two points on top of each other: keep one.
  const keptPts: Pt[] = [];
  const keptBulges: number[] = [];
  for (let k = 0; k < pts.length; k++) {
    if (keptPts.length && dist(keptPts[keptPts.length - 1], pts[k]) < EPS) {
      keptBulges[keptBulges.length - 1] = bulges[k];
      continue;
    }
    keptPts.push(pts[k]);
    keptBulges.push(bulges[k]);
  }
  if (s.closed && keptPts.length > 1 && dist(keptPts[0], keptPts[keptPts.length - 1]) < EPS) {
    keptPts.pop();
    keptBulges.pop();
  }
  return { shape: { ...s, pts: keptPts, bulges: keptBulges }, done: plans.length, skipped };
}

/** Which corner of a polyline lies between the sides picked at qa and qb (they must be next to each other). */
export function cornerBetween(s: Extract<Shape, { type: 'poly' }>, qa: Pt, qb: Pt): number | null {
  const path = pathOf(s)!;
  const ia = Math.min(Math.floor(path.paramOf(qa)), path.hi - 1);
  const ib = Math.min(Math.floor(path.paramOf(qb)), path.hi - 1);
  const n = s.pts.length;
  if (ib === ia + 1) return ib;
  if (ia === ib + 1) return ia;
  if (s.closed && ((ia === n - 1 && ib === 0) || (ib === n - 1 && ia === 0))) return 0;
  return null;
}

// ---- Offset ---------------------------------------------------------------------------------------------------------

/** A copy of `s` d away on the side of `side`. Lines, arcs, circles, and polylines of lines and arcs. */
export function offset(s: Shape, d: number, side: Pt): Shape | string {
  if (!(d > 0)) return 'The offset distance must be above 0.';
  switch (s.type) {
    case 'line': {
      const n = perp(lineDir(s));
      const k = sideOf(s.a, lineDir(s), side) >= 0 ? d : -d;
      return { type: 'line', a: add(s.a, mul(n, k)), b: add(s.b, mul(n, k)) };
    }
    case 'xline': {
      const n = perp(s.d);
      return { ...s, p: add(s.p, mul(n, sideOf(s.p, s.d, side) >= 0 ? d : -d)) };
    }
    case 'arc':
    case 'circle': {
      const r = dist(side, s.c) > s.r ? s.r + d : s.r - d;
      if (r <= EPS) return `The radius is ${s.r}: an offset of ${d} inside it leaves nothing.`;
      return { ...s, r };
    }
    case 'ellipse':
      return 'An ellipse cannot be offset exactly (the result is not an ellipse). Offset the shape it will be cut from instead, or draw the second ellipse with its own sizes.';
    case 'spline':
      return 'A curve through points cannot be offset yet.';
    case 'point':
      return 'A point cannot be offset.';
    case 'text':
    case 'dim':
      return 'Text and dimensions are not offset.';
    case 'poly':
      return offsetPoly(s, d, side);
  }
}

function offsetPoly(s: Extract<Shape, { type: 'poly' }>, d: number, side: Pt): Shape | string {
  const spans = spansOf(s.pts, s.bulges, s.closed).filter(sp => dist(sp.a, sp.b) > EPS);
  if (!spans.length) return 'That polyline has no length.';
  // Which side: left of the direction of travel at the nearest place.
  const path = pathOf(s)!;
  const t = path.paramOf(side);
  const near = path.at(t);
  const ahead = path.at(Math.min(path.hi, t + 1e-6));
  const behind = path.at(Math.max(path.lo, t - 1e-6));
  const left = cross(sub(ahead, behind), sub(side, near)) >= 0;
  const k = left ? d : -d;
  // Each span moved k to its left: a straight span along its normal, an arc to a smaller or larger radius.
  type Moved = { line: { a: Pt; b: Pt } } | { circle: { c: Pt; r: number; ccw: boolean; a: Pt; b: Pt } };
  const moved: Moved[] = [];
  for (const sp of spans) {
    if (!sp.arc) {
      const n = mul(perp(unit(sub(sp.b, sp.a))), k);
      moved.push({ line: { a: add(sp.a, n), b: add(sp.b, n) } });
    } else {
      const ccw = sp.bulge > 0;
      const r = sp.arc.r + (ccw ? -k : k);
      if (r <= EPS) return `At ${d} the round part of radius ${Math.round(sp.arc.r * 1000) / 1000} would vanish; offset less, or to the other side.`;
      const toA = unit(sub(sp.a, sp.arc.c));
      const toB = unit(sub(sp.b, sp.arc.c));
      moved.push({ circle: { c: sp.arc.c, r, ccw, a: add(sp.arc.c, mul(toA, r)), b: add(sp.arc.c, mul(toB, r)) } });
    }
  }
  const startOf = (m: Moved) => ('line' in m ? m.line.a : m.circle.a);
  const endOf = (m: Moved) => ('line' in m ? m.line.b : m.circle.b);
  const whole = (m: Moved): Piece => ('line' in m ? { k: 'xline', p: m.line.a, d: unit(sub(m.line.b, m.line.a)) } : { k: 'arc', c: m.circle.c, r: m.circle.r, a0: 0, a1: TAU });
  /** Where two moved spans meet: their crossing nearest where they were, or the end itself if they already meet. */
  const meet = (m1: Moved, m2: Moved): Pt => {
    const e = endOf(m1);
    const st = startOf(m2);
    if (dist(e, st) < 1e-9) return e;
    const xs = intersect(whole(m1), whole(m2));
    if (!xs.length) return lerp(e, st, 0.5);
    return xs.sort((a, b) => dist(a, e) + dist(a, st) - dist(b, e) - dist(b, st))[0];
  };
  const m = moved.length;
  const pts: Pt[] = [];
  for (let i = 0; i < m; i++) {
    if (i === 0) pts.push(s.closed ? meet(moved[m - 1], moved[0]) : startOf(moved[0]));
    else pts.push(meet(moved[i - 1], moved[i]));
  }
  if (!s.closed) pts.push(endOf(moved[m - 1]));
  const bulges: number[] = [];
  for (let i = 0; i < m; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const mv = moved[i];
    const orig = spans[i];
    if ('line' in mv) {
      // A side that turned round has been used up by the corners on either side of it.
      if (dot(sub(b, a), sub(orig.b, orig.a)) <= 0) return `At ${d} the polyline folds over itself (a side is too short). Offset less, or offset its parts one by one.`;
      bulges.push(0);
    } else {
      const c = mv.circle;
      const sweep = c.ccw ? normAngle(angleOf(sub(b, c.c)) - angleOf(sub(a, c.c))) : normAngle(angleOf(sub(a, c.c)) - angleOf(sub(b, c.c)));
      const origSweep = 4 * Math.atan(Math.abs(orig.bulge));
      if (Math.abs(sweep - origSweep) > Math.PI) return `At ${d} the polyline folds over itself (a round part is too short). Offset less, or offset its parts one by one.`;
      bulges.push((c.ccw ? 1 : -1) * Math.tan(sweep / 4));
    }
  }
  if (!s.closed) bulges.push(0);
  return { type: 'poly', pts, bulges, closed: s.closed };
}

// ---- Geometries: join, close, start, reverse, explode -----------------------------------------------------------------

/** A line or arc (or an open polyline) as polyline points and bulges, run the given way. */
function asRun(s: Shape, reversed: boolean): { pts: Pt[]; bulges: number[] } | null {
  let pts: Pt[];
  let bulges: number[];
  if (s.type === 'line') {
    pts = [s.a, s.b];
    bulges = [0];
  } else if (s.type === 'arc') {
    pts = [polar(s.c, s.r, s.a0), polar(s.c, s.r, s.a1)];
    bulges = [Math.tan((s.a1 - s.a0) / 4)];
  } else if (s.type === 'poly' && !s.closed) {
    pts = [...s.pts];
    bulges = s.bulges.slice(0, s.pts.length - 1);
  } else return null;
  if (!reversed) return { pts, bulges };
  return { pts: [...pts].reverse(), bulges: [...bulges].reverse().map(b => -b) };
}

/**
 * Joins the chosen lines, arcs and open polylines that meet end to end into polylines ("geometries"), closed where a
 * chain comes back to its start. Ellipses, curves, circles, closed polylines, points and construction lines are not
 * joined and are counted as left out.
 */
export function join(ents: Ent[], tol = JOIN_TOL): { made: Array<{ shape: Shape; from: number[]; layer: string }>; leftOut: number } {
  const usable = ents.filter(e => asRun(e, false));
  const leftOut = ents.length - usable.length;
  const done = new Set<number>();
  const made: Array<{ shape: Shape; from: number[]; layer: string }> = [];
  for (const start of usable) {
    if (done.has(start.id)) continue;
    done.add(start.id);
    let run = asRun(start, false)!;
    const from = [start.id];
    // Grow forwards from the end, then backwards from the start.
    for (const forward of [true, false]) {
      for (;;) {
        const tip = forward ? run.pts[run.pts.length - 1] : run.pts[0];
        let found = false;
        for (const e of usable) {
          if (done.has(e.id)) continue;
          const ends = endsOf(e)!;
          let add: { pts: Pt[]; bulges: number[] } | null = null;
          if (dist(ends[0], tip) <= tol) add = asRun(e, !forward);
          else if (dist(ends[1], tip) <= tol) add = asRun(e, forward);
          if (!add) continue;
          done.add(e.id);
          from.push(e.id);
          run = forward
            ? { pts: [...run.pts, ...add.pts.slice(1)], bulges: [...run.bulges, ...add.bulges] }
            : { pts: [...add.pts.slice(0, -1), ...run.pts], bulges: [...add.bulges, ...run.bulges] };
          found = true;
          break;
        }
        if (!found) break;
      }
    }
    const closed = run.pts.length > 2 && dist(run.pts[0], run.pts[run.pts.length - 1]) <= tol;
    const pts = closed ? run.pts.slice(0, -1) : run.pts;
    const bulges = closed ? run.bulges : [...run.bulges, 0];
    if (from.length === 1 && !closed) continue;
    made.push({ shape: { type: 'poly', pts, bulges, closed }, from, layer: start.layer });
  }
  return { made, leftOut };
}

/** Closes an open polyline (a straight side back to the start, or joins ends that already meet). */
export function closeShape(s: Shape): Shape | string {
  if (s.type !== 'poly') return 'Close works on a polyline (join lines and arcs into one first).';
  if (s.closed) return 'That polyline is already closed.';
  if (s.pts.length < 3 && dist(s.pts[0], s.pts[s.pts.length - 1]) > JOIN_TOL) return 'A polyline needs three points or more to close.';
  if (dist(s.pts[0], s.pts[s.pts.length - 1]) <= JOIN_TOL) {
    return { ...s, pts: s.pts.slice(0, -1), bulges: s.bulges.slice(0, s.pts.length - 2).concat([s.bulges[s.pts.length - 2] ?? 0]), closed: true };
  }
  return { ...s, bulges: s.bulges.slice(0, s.pts.length - 1).concat([0]), closed: true };
}

/** Makes the point of a closed polyline nearest q its start (a new corner is added there if it is along a side). */
export function setStart(s: Shape, q: Pt): Shape | string {
  if (s.type !== 'poly' || !s.closed) return 'The start point is set on a closed polyline (a geometry).';
  const path = pathOf(s)!;
  let t = path.paramOf(q);
  const n = s.pts.length;
  const vertex = Math.round(t);
  if (dist(path.at(vertex), path.at(t)) < 1e-6) t = vertex % n;
  if (Number.isInteger(t)) {
    const i = t % n;
    return { ...s, pts: [...s.pts.slice(i), ...s.pts.slice(0, i)], bulges: [...s.bulges.slice(i), ...s.bulges.slice(0, i)] };
  }
  const part = path.sub(t, t + n);
  if (!part || part.type !== 'poly') return 'That point could not be made the start.';
  return { ...s, pts: part.pts.slice(0, -1), bulges: part.bulges.slice(0, -1), closed: true };
}

/** Runs a polyline (or a line) the other way round. */
export function reverse(s: Shape): Shape | string {
  if (s.type === 'line') return { ...s, a: s.b, b: s.a };
  if (s.type !== 'poly') return 'Direction belongs to lines and polylines (arcs and circles are drawn anticlockwise).';
  const n = s.pts.length;
  if (!s.closed) return { ...s, pts: [...s.pts].reverse(), bulges: [...s.bulges.slice(0, n - 1).reverse().map(b => -b), 0] };
  // Closed: keep the same start, run the other way.
  const pts = [s.pts[0], ...s.pts.slice(1).reverse()];
  const bulges = [...s.bulges].reverse().map(b => -b);
  return { ...s, pts, bulges };
}

/** A polyline as its separate lines and arcs. */
export function explode(s: Shape): Shape[] | string {
  if (s.type !== 'poly') return 'Explode breaks a polyline into its lines and arcs.';
  return spansOf(s.pts, s.bulges, s.closed)
    .filter(sp => dist(sp.a, sp.b) > EPS)
    .map(sp => (sp.arc ? ({ type: 'arc', c: sp.arc.c, r: sp.arc.r, a0: sp.arc.a0, a1: sp.arc.a1 } as Shape) : ({ type: 'line', a: sp.a, b: sp.b } as Shape)));
}

// ---- Area and length --------------------------------------------------------------------------------------------------

/** The area inside a closed shape (polyline, circle, whole ellipse), or null for an open one. */
export function areaOf(s: Shape): number | null {
  if (s.type === 'circle') return Math.PI * s.r * s.r;
  if (s.type === 'ellipse') return isFull(s.t0, s.t1) ? Math.PI * len(s.m) * len(s.m) * s.ratio : null;
  if (s.type !== 'poly' || !s.closed) return null;
  let a = 0;
  for (const sp of spansOf(s.pts, s.bulges, true)) {
    a += cross(sp.a, sp.b) / 2;
    if (sp.arc) {
      const th = 4 * Math.atan(Math.abs(sp.bulge));
      // A bulge above 0 swings to the right of the way travelled: outside an anticlockwise shape, so it adds.
      a += Math.sign(sp.bulge) * ((sp.arc.r * sp.arc.r) / 2) * (th - Math.sin(th));
    }
  }
  return Math.abs(a);
}

/** Which way a closed polyline runs: 1 anticlockwise, -1 clockwise. */
export function turnOf(s: Extract<Shape, { type: 'poly' }>): number {
  let a = 0;
  for (const sp of spansOf(s.pts, s.bulges, s.closed)) {
    a += cross(sp.a, sp.b);
    if (sp.arc) {
      const th = 4 * Math.atan(Math.abs(sp.bulge));
      a += Math.sign(sp.bulge) * (sp.arc.r * sp.arc.r) * (th - Math.sin(th));
    }
  }
  return a >= 0 ? 1 : -1;
}

/** The direction marks for a polyline or line: where each span's middle is and which way it runs. */
export function directionMarks(s: Shape): Array<{ at: Pt; dir: Pt }> {
  if (s.type === 'line') return [{ at: lerp(s.a, s.b, 0.3), dir: lineDir(s) }];
  if (s.type !== 'poly') return [];
  return spansOf(s.pts, s.bulges, s.closed)
    .filter(sp => dist(sp.a, sp.b) > EPS)
    .map(sp => {
      // A third of the way along, so the arrow never covers the middle a snap is aimed at.
      const m = spanAt(sp, 0.3);
      const ahead = spanAt(sp, 0.3001);
      return { at: m, dir: unit(sub(ahead, m)) };
    });
}
