// Plane geometry for TOMLIN CAD: points, the simple pieces every drawn item is made of (straight segments, endless
// construction lines, arcs, ellipse arcs and cubic curves), and what the drawing tools and snaps ask of them: where
// two pieces cross, the nearest point on a piece, the foot of a perpendicular, the points where a line from outside
// touches a piece, tangent lines between circles, and circles touching two or three items. Lines, circles and arcs
// against each other, and lines against ellipses, are solved exactly; anything with an ellipse or a curve is solved
// by stepping along it and narrowing in until the answer is good to far below a thousandth of a millimetre.

export interface Pt {
  x: number;
  y: number;
}

export const TAU = Math.PI * 2;
export const P = (x: number, y: number): Pt => ({ x, y });
export const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: Pt, k: number): Pt => ({ x: a.x * k, y: a.y * k });
export const dot = (a: Pt, b: Pt): number => a.x * b.x + a.y * b.y;
export const cross = (a: Pt, b: Pt): number => a.x * b.y - a.y * b.x;
export const len = (a: Pt): number => Math.hypot(a.x, a.y);
export const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y);
export const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
/** A quarter turn anticlockwise. */
export const perp = (a: Pt): Pt => ({ x: -a.y, y: a.x });
export const angleOf = (a: Pt): number => Math.atan2(a.y, a.x);
export const dirOf = (angle: number): Pt => ({ x: Math.cos(angle), y: Math.sin(angle) });
export const polar = (c: Pt, r: number, angle: number): Pt => ({ x: c.x + r * Math.cos(angle), y: c.y + r * Math.sin(angle) });
export const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

export function unit(a: Pt): Pt {
  const l = len(a);
  return l > 0 ? { x: a.x / l, y: a.y / l } : { x: 1, y: 0 };
}

/** An angle brought into 0 to one full turn. */
export function normAngle(a: number): number {
  const r = a % TAU;
  return r < 0 ? r + TAU : r;
}

export function rotatePt(p: Pt, c: Pt, angle: number): Pt {
  const s = Math.sin(angle);
  const k = Math.cos(angle);
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  return { x: c.x + dx * k - dy * s, y: c.y + dx * s + dy * k };
}

/** The point seen in a mirror along the line through a and b. */
export function mirrorPt(p: Pt, a: Pt, b: Pt): Pt {
  const d = unit(sub(b, a));
  const v = sub(p, a);
  const along = mul(d, dot(v, d));
  return add(a, sub(mul(along, 2), v));
}

/** A direction seen in a mirror along a line at `axis` (an angle): only the turn changes, not the place. */
export function mirrorDir(v: Pt, axis: number): Pt {
  const k = Math.cos(2 * axis);
  const s = Math.sin(2 * axis);
  return { x: v.x * k + v.y * s, y: v.x * s - v.y * k };
}

// ---- Pieces --------------------------------------------------------------------------------------------------------

/**
 * seg: a straight piece from a to b. xline: an endless construction line through p along the unit direction d.
 * arc: anticlockwise from angle a0 to a1 (a1 > a0, at most one turn more; a whole circle is a0 = 0, a1 = TAU).
 * ell: centre c, half the long axis as the vector m, the short half-axis = |m| x ratio, from parameter t0 to t1
 * anticlockwise (point at t: c + m cos t + n sin t, where n is m turned a quarter anticlockwise times ratio).
 * bez: a cubic curve through p[0] and p[3] pulled towards p[1] and p[2].
 */
export type Piece =
  | { k: 'seg'; a: Pt; b: Pt }
  | { k: 'xline'; p: Pt; d: Pt }
  | { k: 'arc'; c: Pt; r: number; a0: number; a1: number }
  | { k: 'ell'; c: Pt; m: Pt; ratio: number; t0: number; t1: number }
  | { k: 'bez'; p: [Pt, Pt, Pt, Pt] };

export const isFull = (a0: number, a1: number): boolean => a1 - a0 >= TAU - 1e-12;

/** Is the angle on the anticlockwise sweep from a0 to a1 (with a little room at both ends)? */
export function angleIn(a: number, a0: number, a1: number, tol = 1e-9): boolean {
  if (isFull(a0, a1)) return true;
  const span = a1 - a0;
  const off = normAngle(a - a0);
  return off <= span + tol || off >= TAU - tol;
}

export const ellN = (m: Pt, ratio: number): Pt => mul(perp(m), ratio);

/** The parameter range a piece is walked along (an endless line has none). */
export function domain(p: Piece): [number, number] | null {
  switch (p.k) {
    case 'seg':
    case 'bez':
      return [0, 1];
    case 'arc':
      return [p.a0, p.a1];
    case 'ell':
      return [p.t0, p.t1];
    default:
      return null;
  }
}

export function at(p: Piece, t: number): Pt {
  switch (p.k) {
    case 'seg':
      return lerp(p.a, p.b, t);
    case 'xline':
      return add(p.p, mul(p.d, t));
    case 'arc':
      return polar(p.c, p.r, t);
    case 'ell': {
      const n = ellN(p.m, p.ratio);
      const k = Math.cos(t);
      const s = Math.sin(t);
      return { x: p.c.x + p.m.x * k + n.x * s, y: p.c.y + p.m.y * k + n.y * s };
    }
    case 'bez': {
      const [a, b, c, d] = p.p;
      const u = 1 - t;
      const w0 = u * u * u;
      const w1 = 3 * u * u * t;
      const w2 = 3 * u * t * t;
      const w3 = t * t * t;
      return { x: a.x * w0 + b.x * w1 + c.x * w2 + d.x * w3, y: a.y * w0 + b.y * w1 + c.y * w2 + d.y * w3 };
    }
  }
}

/** Which way the piece runs at t (not made unit length). */
export function deriv(p: Piece, t: number): Pt {
  switch (p.k) {
    case 'seg':
      return sub(p.b, p.a);
    case 'xline':
      return p.d;
    case 'arc':
      return { x: -p.r * Math.sin(t), y: p.r * Math.cos(t) };
    case 'ell': {
      const n = ellN(p.m, p.ratio);
      const k = Math.cos(t);
      const s = Math.sin(t);
      return { x: -p.m.x * s + n.x * k, y: -p.m.y * s + n.y * k };
    }
    case 'bez': {
      const [a, b, c, d] = p.p;
      const u = 1 - t;
      const w0 = 3 * u * u;
      const w1 = 6 * u * t;
      const w2 = 3 * t * t;
      return {
        x: w0 * (b.x - a.x) + w1 * (c.x - b.x) + w2 * (d.x - c.x),
        y: w0 * (b.y - a.y) + w1 * (c.y - b.y) + w2 * (d.y - c.y),
      };
    }
  }
}

export function startOf(p: Piece): Pt | null {
  const d = domain(p);
  return d ? at(p, d[0]) : null;
}

export function endOf(p: Piece): Pt | null {
  const d = domain(p);
  return d ? at(p, d[1]) : null;
}

/** Points along a piece, ends included; an endless line gives none. */
export function sample(p: Piece, n: number): Pt[] {
  const d = domain(p);
  if (!d) return [];
  if (p.k === 'seg') return [p.a, p.b];
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) out.push(at(p, d[0] + ((d[1] - d[0]) * i) / n));
  return out;
}

/** How many steps a curve needs to look smooth (and to be searched closely enough). */
export function stepsFor(p: Piece): number {
  if (p.k === 'seg' || p.k === 'xline') return 1;
  if (p.k === 'bez') return 48;
  const span = p.k === 'arc' ? p.a1 - p.a0 : p.t1 - p.t0;
  return Math.max(8, Math.ceil((span / TAU) * 128));
}

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function boxOf(points: Pt[]): Box | null {
  if (!points.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const q of points) {
    if (q.x < x0) x0 = q.x;
    if (q.y < y0) y0 = q.y;
    if (q.x > x1) x1 = q.x;
    if (q.y > y1) y1 = q.y;
  }
  return { x0, y0, x1, y1 };
}

export function joinBoxes(a: Box | null, b: Box | null): Box | null {
  if (!a) return b;
  if (!b) return a;
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

/** The exact box around a piece (an endless line has none). */
export function pieceBox(p: Piece): Box | null {
  switch (p.k) {
    case 'seg':
      return boxOf([p.a, p.b]);
    case 'xline':
      return null;
    case 'arc': {
      const pts = [at(p, p.a0), at(p, p.a1)];
      for (let q = 0; q < 4; q++) if (angleIn((q * Math.PI) / 2, p.a0, p.a1, 0)) pts.push(polar(p.c, p.r, (q * Math.PI) / 2));
      return boxOf(pts);
    }
    case 'ell': {
      const n = ellN(p.m, p.ratio);
      const pts = [at(p, p.t0), at(p, p.t1)];
      // x is widest where -m.x sin t + n.x cos t = 0, y likewise.
      for (const base of [Math.atan2(n.x, p.m.x), Math.atan2(n.y, p.m.y)]) {
        for (const t of [base, base + Math.PI]) if (angleIn(t, p.t0, p.t1, 0)) pts.push(at(p, t));
      }
      return boxOf(pts);
    }
    case 'bez':
      return boxOf(sample(p, 48));
  }
}

// ---- Distances, nearest points ------------------------------------------------------------------------------------

/** The parameter of the point on an ellipse in the direction of q from its centre (not the nearest point). */
function ellParamOf(p: Extract<Piece, { k: 'ell' }>, q: Pt): number {
  const a = len(p.m);
  const mu = unit(p.m);
  const v = sub(q, p.c);
  return Math.atan2(dot(v, perp(mu)) / (a * p.ratio), dot(v, mu) / a);
}

/** Is q (a point on the piece's whole line, circle or ellipse) on the drawn part? */
export function inRange(p: Piece, q: Pt, tol = 1e-7): boolean {
  switch (p.k) {
    case 'seg': {
      const d = sub(p.b, p.a);
      const l2 = dot(d, d);
      if (l2 === 0) return dist(q, p.a) <= tol;
      const t = dot(sub(q, p.a), d) / l2;
      const slack = tol / Math.sqrt(l2);
      return t >= -slack && t <= 1 + slack;
    }
    case 'xline':
      return true;
    case 'arc':
      return angleIn(angleOf(sub(q, p.c)), p.a0, p.a1, tol / Math.max(p.r, 1e-12));
    case 'ell':
      return angleIn(ellParamOf(p, q), p.t0, p.t1, tol / Math.max(len(p.m) * p.ratio, 1e-12));
    case 'bez':
      return true;
  }
}

/**
 * A value that is 0 on the piece's whole line, circle or ellipse, and changes sign across it (about the distance near
 * it). A cubic curve has none.
 */
function implicit(p: Piece): ((q: Pt) => number) | null {
  switch (p.k) {
    case 'seg': {
      const d = unit(sub(p.b, p.a));
      return q => cross(d, sub(q, p.a));
    }
    case 'xline':
      return q => cross(p.d, sub(q, p.p));
    case 'arc':
      return q => dist(q, p.c) - p.r;
    case 'ell': {
      const a = len(p.m);
      const b = a * p.ratio;
      const mu = unit(p.m);
      const nu = perp(mu);
      return q => {
        const v = sub(q, p.c);
        const u = dot(v, mu) / a;
        const w = dot(v, nu) / b;
        return (Math.hypot(u, w) - 1) * b;
      };
    }
    case 'bez':
      return null;
  }
}

/** Searches t in [lo, hi] for where f changes sign, and for touching points (f comes down to 0 and goes back). */
export function rootsOf(f: (t: number) => number, lo: number, hi: number, n: number, touchTol = 1e-9): number[] {
  const ts: number[] = [];
  const vs: number[] = [];
  for (let i = 0; i <= n; i++) {
    const t = lo + ((hi - lo) * i) / n;
    ts.push(t);
    vs.push(f(t));
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const v0 = vs[i];
    const v1 = vs[i + 1];
    if (v0 === 0) out.push(ts[i]);
    else if (v0 * v1 < 0) {
      let a = ts[i];
      let b = ts[i + 1];
      let fa = v0;
      for (let k = 0; k < 100 && b - a > 1e-15 * Math.max(1, Math.abs(a)); k++) {
        const m = (a + b) / 2;
        const fm = f(m);
        if (fm === 0) {
          a = b = m;
          break;
        }
        if (fa * fm < 0) b = m;
        else {
          a = m;
          fa = fm;
        }
      }
      out.push((a + b) / 2);
    }
  }
  if (vs[n] === 0) out.push(ts[n]);
  // Touching: |f| smallest at a sample between two larger ones, with no sign change around it.
  for (let i = 1; i < n; i++) {
    const a = Math.abs(vs[i - 1]);
    const b = Math.abs(vs[i]);
    const c = Math.abs(vs[i + 1]);
    if (!(b <= a && b <= c) || vs[i - 1] * vs[i] < 0 || vs[i] * vs[i + 1] < 0 || vs[i] === 0) continue;
    const t = goldenMin(t => Math.abs(f(t)), ts[i - 1], ts[i + 1]);
    if (Math.abs(f(t)) <= touchTol) out.push(t);
  }
  return out.sort((a, b) => a - b).filter((t, i, all) => i === 0 || t - all[i - 1] > 1e-12);
}

/** The t in [a, b] where f is smallest (f having one low point there). */
export function goldenMin(f: (t: number) => number, a: number, b: number, iterations = 90): number {
  const g = (Math.sqrt(5) - 1) / 2;
  let c = b - g * (b - a);
  let d = a + g * (b - a);
  let fc = f(c);
  let fd = f(d);
  for (let i = 0; i < iterations; i++) {
    if (fc < fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - g * (b - a);
      fc = f(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + g * (b - a);
      fd = f(d);
    }
  }
  return (a + b) / 2;
}

/** The nearest point on a piece to q. */
export function nearestOn(p: Piece, q: Pt): Pt {
  switch (p.k) {
    case 'seg': {
      const d = sub(p.b, p.a);
      const l2 = dot(d, d);
      if (l2 === 0) return p.a;
      const t = Math.max(0, Math.min(1, dot(sub(q, p.a), d) / l2));
      return lerp(p.a, p.b, t);
    }
    case 'xline':
      return add(p.p, mul(p.d, dot(sub(q, p.p), p.d)));
    case 'arc': {
      const a = angleOf(sub(q, p.c));
      if (dist(q, p.c) > 0 && angleIn(a, p.a0, p.a1, 0)) return polar(p.c, p.r, a);
      const s = polar(p.c, p.r, p.a0);
      const e = polar(p.c, p.r, p.a1);
      return dist(q, s) <= dist(q, e) ? s : e;
    }
    default: {
      const [lo, hi] = domain(p)!;
      const n = stepsFor(p) * 2;
      let best = lo;
      let bestD = Infinity;
      for (let i = 0; i <= n; i++) {
        const t = lo + ((hi - lo) * i) / n;
        const dd = dist(at(p, t), q);
        if (dd < bestD) {
          bestD = dd;
          best = t;
        }
      }
      const step = (hi - lo) / n;
      const t = goldenMin(t => dist(at(p, t), q), Math.max(lo, best - step), Math.min(hi, best + step));
      return at(p, t);
    }
  }
}

export const distTo = (p: Piece, q: Pt): number => dist(nearestOn(p, q), q);

/** Feet of perpendiculars from q onto the piece (on its drawn part). */
export function perpFeet(p: Piece, q: Pt): Pt[] {
  switch (p.k) {
    case 'seg': {
      const d = sub(p.b, p.a);
      const l2 = dot(d, d);
      if (l2 === 0) return [];
      const t = dot(sub(q, p.a), d) / l2;
      return t >= -1e-12 && t <= 1 + 1e-12 ? [lerp(p.a, p.b, t)] : [];
    }
    case 'xline':
      return [nearestOn(p, q)];
    case 'arc': {
      if (dist(q, p.c) < 1e-12) return [];
      const a = angleOf(sub(q, p.c));
      return [a, a + Math.PI].filter(t => angleIn(t, p.a0, p.a1)).map(t => polar(p.c, p.r, t));
    }
    default: {
      const [lo, hi] = domain(p)!;
      return rootsOf(t => dot(sub(at(p, t), q), deriv(p, t)), lo, hi, stepsFor(p) * 2).map(t => at(p, t));
    }
  }
}

/** Points on the piece where a line from q just touches it. */
export function tangentPoints(p: Piece, q: Pt): Pt[] {
  switch (p.k) {
    case 'seg':
    case 'xline':
      return [];
    case 'arc': {
      const d = dist(q, p.c);
      if (d <= p.r * (1 + 1e-12)) return [];
      const base = angleOf(sub(q, p.c));
      const off = Math.acos(p.r / d);
      return [base + off, base - off].filter(t => angleIn(t, p.a0, p.a1)).map(t => polar(p.c, p.r, t));
    }
    default: {
      const [lo, hi] = domain(p)!;
      return rootsOf(t => cross(sub(at(p, t), q), deriv(p, t)), lo, hi, stepsFor(p) * 2).map(t => at(p, t));
    }
  }
}

// ---- Crossings ------------------------------------------------------------------------------------------------------

/** Where the endless lines through (p1 along d1) and (p2 along d2) cross, as parameters along each; null if parallel. */
export function lineLine(p1: Pt, d1: Pt, p2: Pt, d2: Pt): [number, number] | null {
  const den = cross(d1, d2);
  if (Math.abs(den) <= 1e-14 * len(d1) * len(d2)) return null;
  const w = sub(p2, p1);
  return [cross(w, d2) / den, cross(w, d1) / den];
}

/** Where the endless line through p along d meets the circle (c, r). */
export function lineCircle(p: Pt, d: Pt, c: Pt, r: number): Pt[] {
  const dd = dot(d, d);
  if (dd === 0) return [];
  const foot = add(p, mul(d, dot(sub(c, p), d) / dd));
  const h = dist(c, foot);
  const tol = 1e-10 * Math.max(1, r);
  if (h > r + tol) return [];
  const k = Math.sqrt(Math.max(0, r * r - h * h));
  if (k <= tol) return [foot];
  const u = mul(d, k / Math.sqrt(dd));
  return [sub(foot, u), add(foot, u)];
}

export function circleCircle(c1: Pt, r1: number, c2: Pt, r2: number): Pt[] {
  const d = dist(c1, c2);
  if (d < 1e-12) return [];
  const tol = 1e-10 * Math.max(1, r1, r2);
  if (d > r1 + r2 + tol || d < Math.abs(r1 - r2) - tol) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const u = unit(sub(c2, c1));
  const base = add(c1, mul(u, a));
  if (h <= tol) return [base];
  const n = mul(perp(u), h);
  return [add(base, n), sub(base, n)];
}

/** Where the endless line through p along d meets the whole ellipse (exact: the ellipse is made a circle first). */
function lineEllipse(p: Pt, d: Pt, e: Extract<Piece, { k: 'ell' }>): Pt[] {
  const a = len(e.m);
  const b = a * e.ratio;
  const mu = unit(e.m);
  const nu = perp(mu);
  const toLocal = (v: Pt): Pt => ({ x: dot(v, mu) / a, y: dot(v, nu) / b });
  const lp = toLocal(sub(p, e.c));
  const ld = toLocal(d);
  return lineCircle(lp, ld, P(0, 0), 1).map(q => add(e.c, add(mul(mu, q.x * a), mul(nu, q.y * b))));
}

const lineOf = (p: Piece): { p: Pt; d: Pt } | null => (p.k === 'seg' ? { p: p.a, d: sub(p.b, p.a) } : p.k === 'xline' ? { p: p.p, d: p.d } : null);

/** Where two pieces cross (and where they just touch), on the drawn parts of both. */
export function intersect(A: Piece, B: Piece): Pt[] {
  const la = lineOf(A);
  const lb = lineOf(B);
  let pts: Pt[];
  if (la && lb) {
    const st = lineLine(la.p, la.d, lb.p, lb.d);
    pts = st ? [add(la.p, mul(la.d, st[0]))] : [];
  } else if (la && B.k === 'arc') pts = lineCircle(la.p, la.d, B.c, B.r);
  else if (lb && A.k === 'arc') pts = lineCircle(lb.p, lb.d, A.c, A.r);
  else if (A.k === 'arc' && B.k === 'arc') pts = circleCircle(A.c, A.r, B.c, B.r);
  else if (la && B.k === 'ell') pts = lineEllipse(la.p, la.d, B);
  else if (lb && A.k === 'ell') pts = lineEllipse(lb.p, lb.d, A);
  else if (A.k === 'bez' && B.k === 'bez') return dedupe(bezBez(A, B));
  else {
    // Walk along one piece and watch the other's sign; the curve is walked if there is one, else the ellipse.
    const walk = A.k === 'bez' || (A.k === 'ell' && B.k !== 'bez') ? A : B;
    const other = walk === A ? B : A;
    const f = implicit(other)!;
    const [lo, hi] = domain(walk)!;
    const scale = Math.max(1, boxSize(walk));
    pts = rootsOf(t => f(at(walk, t)), lo, hi, Math.max(stepsFor(walk), stepsFor(other)) * 4, 1e-9 * scale).map(t => at(walk, t));
    return dedupe(pts.filter(q => inRange(other, q)));
  }
  return dedupe(pts.filter(q => inRange(A, q) && inRange(B, q)));
}

function boxSize(p: Piece): number {
  const b = pieceBox(p);
  return b ? Math.max(b.x1 - b.x0, b.y1 - b.y0) : 1;
}

function bezBez(A: Extract<Piece, { k: 'bez' }>, B: Extract<Piece, { k: 'bez' }>): Pt[] {
  const n = 48;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a0 = at(A, i / n);
    const a1 = at(A, (i + 1) / n);
    for (let j = 0; j < n; j++) {
      const b0 = at(B, j / n);
      const b1 = at(B, (j + 1) / n);
      const st = lineLine(a0, sub(a1, a0), b0, sub(b1, b0));
      if (!st || st[0] < -1e-9 || st[0] > 1 + 1e-9 || st[1] < -1e-9 || st[1] > 1 + 1e-9) continue;
      // Newton steps on A(s) - B(t) = 0 from the crossing of the two short chords.
      let s = (i + st[0]) / n;
      let t = (j + st[1]) / n;
      for (let k = 0; k < 30; k++) {
        const r = sub(at(A, s), at(B, t));
        const da = deriv(A, s);
        const db = mul(deriv(B, t), -1);
        const den = cross(da, db);
        if (Math.abs(den) < 1e-18) break;
        const ds = cross(r, db) / den;
        const dt = cross(da, r) / den;
        s = Math.max(0, Math.min(1, s - ds));
        t = Math.max(0, Math.min(1, t - dt));
        if (Math.abs(ds) + Math.abs(dt) < 1e-15) break;
      }
      out.push(at(A, s));
    }
  }
  return out;
}

export function dedupe(pts: Pt[], tol = 1e-7): Pt[] {
  const out: Pt[] = [];
  for (const q of pts) if (!out.some(o => dist(o, q) <= tol)) out.push(q);
  return out;
}

// ---- Circles and arcs from points ----------------------------------------------------------------------------------

/** The circle through three points; null when they are in a straight line. */
export function circumcircle(a: Pt, b: Pt, c: Pt): { c: Pt; r: number } | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  const scale = Math.max(dist(a, b), dist(b, c), dist(a, c));
  if (Math.abs(d) <= 1e-12 * scale * scale) return null;
  const a2 = a.x * a.x + a.y * a.y;
  const b2 = b.x * b.x + b.y * b.y;
  const c2 = c.x * c.x + c.y * c.y;
  const centre = P((a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d, (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d);
  return { c: centre, r: dist(centre, a) };
}

/** An anticlockwise arc around c from angle `from` to angle `to` (going the anticlockwise way round). */
export function ccwArc(c: Pt, r: number, from: number, to: number): { c: Pt; r: number; a0: number; a1: number } {
  const a0 = normAngle(from);
  let span = normAngle(to - from);
  if (span < 1e-12) span = TAU;
  return { c, r, a0, a1: a0 + span };
}

/** The arc from s through m to e (stored anticlockwise); null when the three are in a line. */
export function arcThrough(s: Pt, m: Pt, e: Pt): { c: Pt; r: number; a0: number; a1: number } | null {
  const cc = circumcircle(s, m, e);
  if (!cc) return null;
  const as = angleOf(sub(s, cc.c));
  const am = angleOf(sub(m, cc.c));
  const ae = angleOf(sub(e, cc.c));
  return normAngle(am - as) <= normAngle(ae - as) ? ccwArc(cc.c, cc.r, as, ae) : ccwArc(cc.c, cc.r, ae, as);
}

/** The arc in a polyline from p0 to p1 with bulge b (tan of a quarter of the angle it turns; above 0 = anticlockwise). */
export function bulgeArc(p0: Pt, p1: Pt, b: number): Extract<Piece, { k: 'arc' }> {
  const th = 4 * Math.atan(Math.abs(b));
  const chord = sub(p1, p0);
  const d = len(chord);
  const r = d / (2 * Math.sin(th / 2));
  const off = d / 2 / Math.tan(th / 2);
  const n = perp(unit(chord));
  const c = add(mid(p0, p1), mul(n, b > 0 ? off : -off));
  const a = b > 0 ? ccwArc(c, r, angleOf(sub(p0, c)), angleOf(sub(p1, c))) : ccwArc(c, r, angleOf(sub(p1, c)), angleOf(sub(p0, c)));
  return { k: 'arc', ...a };
}

// ---- Tangent lines and tangent circles -----------------------------------------------------------------------------

/** The lines touching two circles: up to four, each as its two touching points [on the first, on the second]. */
export function tangentLines(c1: Pt, r1: number, c2: Pt, r2: number): Array<[Pt, Pt]> {
  const d = dist(c1, c2);
  if (d < 1e-12) return [];
  const v = mul(sub(c2, c1), 1 / d);
  const out: Array<[Pt, Pt]> = [];
  for (const s1 of [1, -1]) {
    const R2 = s1 * r2;
    const c = (r1 - R2) / d;
    if (c * c > 1 + 1e-12) continue;
    const h = Math.sqrt(Math.max(0, 1 - c * c));
    for (const s2 of [1, -1]) {
      const n = P(v.x * c - s2 * h * v.y, v.y * c + s2 * h * v.x);
      out.push([add(c1, mul(n, r1)), add(c2, mul(n, R2))]);
      if (h < 1e-12) break;
    }
  }
  return out;
}

/** The lines and circles a circle of radius R must have its centre on, to touch a piece. */
function offsetsOf(p: Piece, R: number): Piece[] | null {
  if (p.k === 'seg' || p.k === 'xline') {
    const l = lineOf(p)!;
    const n = mul(perp(unit(l.d)), R);
    const d = unit(l.d);
    return [{ k: 'xline', p: add(l.p, n), d }, { k: 'xline', p: sub(l.p, n), d }];
  }
  if (p.k === 'arc') {
    const out: Piece[] = [{ k: 'arc', c: p.c, r: p.r + R, a0: 0, a1: TAU }];
    if (Math.abs(p.r - R) > 1e-12) out.push({ k: 'arc', c: p.c, r: Math.abs(p.r - R), a0: 0, a1: TAU });
    return out;
  }
  return null;
}

/** The point where a circle centred at c touches the piece (its whole line or circle). */
function touchPoint(p: Piece, c: Pt): Pt {
  if (p.k === 'arc') {
    const u = unit(sub(c, p.c));
    return add(p.c, mul(u, p.r));
  }
  const l = lineOf(p)!;
  return add(l.p, mul(l.d, dot(sub(c, l.p), l.d) / dot(l.d, l.d)));
}

export interface TouchCircle {
  c: Pt;
  r: number;
  /** Where it touches each item, in the order they were given. */
  touch: Pt[];
}

/**
 * Circles of radius R touching two pieces (lines, arcs, circles), the one whose touching points are nearest the
 * places the person clicked first. Null when there is none; 'shape' when a piece is an ellipse or a curve.
 */
export function circleTTR(A: Piece, B: Piece, R: number, nearA: Pt, nearB: Pt): TouchCircle | null | 'shape' {
  const oa = offsetsOf(A, R);
  const ob = offsetsOf(B, R);
  if (!oa || !ob) return 'shape';
  const found: TouchCircle[] = [];
  for (const x of oa) {
    for (const y of ob) {
      for (const c of intersect(x, y)) found.push({ c, r: R, touch: [touchPoint(A, c), touchPoint(B, c)] });
    }
  }
  if (!found.length) return null;
  const score = (t: TouchCircle) => (inRange(A, t.touch[0], 1e-6) ? 0 : 1e9) + (inRange(B, t.touch[1], 1e-6) ? 0 : 1e9) + dist(t.touch[0], nearA) + dist(t.touch[1], nearB);
  return found.sort((a, b) => score(a) - score(b))[0];
}

/**
 * The circle touching three pieces (lines, arcs, circles), found by narrowing in from the circle through the three
 * places clicked. Null when it does not settle on one; 'shape' when a piece is an ellipse or a curve.
 */
export function circleTTT(items: Piece[], picks: Pt[]): TouchCircle | null | 'shape' {
  if (items.some(p => p.k !== 'seg' && p.k !== 'xline' && p.k !== 'arc')) return 'shape';
  const guess = circumcircle(picks[0], picks[1], picks[2]);
  let c = guess ? guess.c : mul(add(add(picks[0], picks[1]), picks[2]), 1 / 3);
  let r = guess ? guess.r : (dist(c, picks[0]) + dist(c, picks[1]) + dist(c, picks[2])) / 3;
  // For each item, which way round the circle touches it (outside or inside it, which side of a line).
  type Way = (q: Pt) => number;
  const ways: Way[] = items.map(p => {
    let options: Way[];
    if (p.k === 'arc') options = [q => dist(q, p.c) - p.r, q => p.r - dist(q, p.c), q => dist(q, p.c) + p.r];
    else {
      const l = lineOf(p)!;
      const d = unit(l.d);
      options = [q => cross(d, sub(q, l.p)), q => -cross(d, sub(q, l.p))];
    }
    return options.reduce((best, w) => (Math.abs(w(c) - r) < Math.abs(best(c) - r) ? w : best));
  });
  const F = (x: number, y: number, rr: number) => ways.map(w => w(P(x, y)) - rr);
  for (let it = 0; it < 100; it++) {
    const f = F(c.x, c.y, r);
    if (Math.max(...f.map(Math.abs)) < 1e-11 * Math.max(1, r)) break;
    const h = 1e-7 * Math.max(1, r);
    const fx = F(c.x + h, c.y, r);
    const fy = F(c.x, c.y + h, r);
    const fr = F(c.x, c.y, r + h);
    const J = f.map((v, i) => [(fx[i] - v) / h, (fy[i] - v) / h, (fr[i] - v) / h]);
    const step = solve3(J, f.map(v => -v));
    if (!step) return null;
    c = P(c.x + step[0], c.y + step[1]);
    r += step[2];
  }
  const res = F(c.x, c.y, r);
  if (!(r > 0) || Math.max(...res.map(Math.abs)) > 1e-8 * Math.max(1, r)) return null;
  return { c, r, touch: items.map(p => touchPoint(p, c)) };
}

function solve3(A: number[][], b: number[]): number[] | null {
  const det = (m: number[][]) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(A);
  if (!Number.isFinite(D) || Math.abs(D) < 1e-300) return null;
  return [0, 1, 2].map(k => det(A.map((row, i) => row.map((v, j) => (j === k ? b[i] : v)))) / D);
}

// ---- Curves through points -----------------------------------------------------------------------------------------

/**
 * A smooth curve through the points, as cubic pieces (each span's pull set by the spans either side of it, scaled
 * to its own length so uneven spacing does not make loops).
 */
export function curveThrough(fit: Pt[], closed: boolean): Array<Extract<Piece, { k: 'bez' }>> {
  const pts = closed && fit.length > 2 && dist(fit[0], fit[fit.length - 1]) < 1e-12 ? fit.slice(0, -1) : fit;
  const n = pts.length;
  if (n < 2) return [];
  if (n === 2 && !closed) return [{ k: 'bez', p: [pts[0], lerp(pts[0], pts[1], 1 / 3), lerp(pts[0], pts[1], 2 / 3), pts[1]] }];
  const get = (i: number) => pts[closed ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i))];
  /** The direction at point i, per unit of length. */
  const slope = (i: number): Pt => {
    if (!closed && i === 0) return unit(sub(get(1), get(0)));
    if (!closed && i === n - 1) return unit(sub(get(n - 1), get(n - 2)));
    const before = dist(get(i - 1), get(i));
    const after = dist(get(i), get(i + 1));
    const total = before + after;
    return total > 0 ? mul(sub(get(i + 1), get(i - 1)), 1 / total) : P(0, 0);
  };
  const spans = closed ? n : n - 1;
  const out: Array<Extract<Piece, { k: 'bez' }>> = [];
  for (let i = 0; i < spans; i++) {
    const a = get(i);
    const b = get(i + 1);
    const l = dist(a, b) / 3;
    out.push({ k: 'bez', p: [a, add(a, mul(slope(i), l)), sub(b, mul(slope(i + 1), l)), b] });
  }
  return out;
}
