// Changing items in KerfLine: moving, rotating, mirroring and scaling them (each kept as its true shape), and
// finding them: the item under the pointer, the items inside a window or touching a crossing box, and a chain of
// items joined end to end.
import {
  P, add, angleOf, boxOf, dist, distTo, intersect, mirrorDir, mirrorPt, mul, normAngle, rotatePt, sample, stepsFor, sub,
  type Box, type Piece, type Pt,
} from './geom.ts';
import { endsOf, outlineOf, shapeBox, type Ent, type Shape } from './model.ts';
import { distToText, readable } from './notes.ts';

/** Applies a point change to every point of a shape that is a point (not a length or a direction). */
function mapPoints(s: Shape, f: (p: Pt) => Pt): Shape {
  switch (s.type) {
    case 'line':
      return { ...s, a: f(s.a), b: f(s.b) };
    case 'arc':
    case 'circle':
    case 'ellipse':
      return { ...s, c: f(s.c) };
    case 'poly':
      return { ...s, pts: s.pts.map(f) };
    case 'spline':
      return { ...s, fit: s.fit.map(f) };
    case 'point':
    case 'xline':
      return { ...s, p: f(s.p) };
    case 'text':
      return { ...s, p: f(s.p), ...(s.arc ? { arc: { ...s.arc, c: f(s.arc.c) } } : {}) };
    case 'dim':
      return { ...s, pts: s.pts.map(f) };
  }
}

export function moveShape<S extends Shape>(s: S, by: Pt): S {
  return mapPoints(s, p => add(p, by)) as S;
}

export function rotateShape<S extends Shape>(s: S, c: Pt, angle: number): S {
  const moved = mapPoints(s, p => rotatePt(p, c, angle));
  const turn = (v: Pt) => rotatePt(v, P(0, 0), angle);
  switch (moved.type) {
    case 'arc':
      return { ...moved, a0: normAngle(moved.a0 + angle), a1: normAngle(moved.a0 + angle) + (moved.a1 - moved.a0) } as S;
    case 'ellipse':
      return { ...moved, m: turn(moved.m) } as S;
    case 'xline':
      return { ...moved, d: turn(moved.d) } as S;
    case 'text':
      return { ...moved, angle: normAngle(moved.angle + angle) } as S;
    case 'dim':
      return { ...moved, dir: normAngle(moved.dir + angle) } as S;
    default:
      return moved as S;
  }
}

/** Seen in a mirror along the line through a and b: arcs and ellipses run the other way, so their ends swap. */
export function mirrorShape<S extends Shape>(s: S, a: Pt, b: Pt): S {
  const axis = angleOf(sub(b, a));
  const moved = mapPoints(s, p => mirrorPt(p, a, b));
  switch (moved.type) {
    case 'arc': {
      const a0 = normAngle(2 * axis - moved.a1);
      return { ...moved, a0, a1: a0 + (moved.a1 - moved.a0) } as S;
    }
    case 'ellipse': {
      const t0 = normAngle(-moved.t1);
      return { ...moved, m: mirrorDir(moved.m, axis), t0, t1: t0 + (moved.t1 - moved.t0) } as S;
    }
    case 'poly':
      return { ...moved, bulges: moved.bulges.map(v => -v) } as S;
    case 'xline':
      return { ...moved, d: mirrorDir(moved.d, axis) } as S;
    case 'text': {
      // Text is never seen backwards: it keeps reading left to right, lined up from its other end if it turned over.
      if (moved.arc) return moved as S;
      const a = normAngle(angleOf(mirrorDir(P(Math.cos(moved.angle), Math.sin(moved.angle)), axis)));
      const r = readable(a);
      const flip = Math.abs(r - a) > 1e-9;
      return { ...moved, angle: r, align: flip && moved.align !== 'centre' ? (moved.align === 'left' ? 'right' : 'left') : moved.align } as S;
    }
    case 'dim': {
      const dir = normAngle(angleOf(mirrorDir(P(Math.cos(moved.dir), Math.sin(moved.dir)), axis)));
      // An angle is measured anticlockwise from its first arm: in a mirror the arms swap.
      const pts = moved.kind === 'angle' ? [moved.pts[0], moved.pts[2], moved.pts[1], moved.pts[3]] : moved.pts;
      return { ...moved, dir, pts } as S;
    }
    default:
      return moved as S;
  }
}

export function scaleShape<S extends Shape>(s: S, c: Pt, k: number): S {
  const moved = mapPoints(s, p => add(c, mul(sub(p, c), k)));
  switch (moved.type) {
    case 'arc':
    case 'circle':
      return { ...moved, r: moved.r * k } as S;
    case 'ellipse':
      return { ...moved, m: mul(moved.m, k) } as S;
    case 'text':
      return { ...moved, h: moved.h * Math.abs(k), ...(moved.arc ? { arc: { ...moved.arc, r: moved.arc.r * Math.abs(k) } } : {}) } as S;
    case 'dim':
      return { ...moved, h: moved.h * Math.abs(k), arrow: moved.arrow * Math.abs(k) } as S;
    default:
      return moved as S;
  }
}

// ---- Finding items -------------------------------------------------------------------------------------------------

/** How far q is from the item. */
export function distToShape(s: Shape, q: Pt): number {
  if (s.type === 'point') return dist(s.p, q);
  if (s.type === 'text') return distToText(s, q);
  let best = Infinity;
  for (const p of outlineOf(s)) best = Math.min(best, distTo(p, q));
  return best;
}

/** The piece of an item nearest q (a polyline's span, a curve's span). */
export function pieceNear(s: Shape, q: Pt): Piece | null {
  let best: Piece | null = null;
  let bestD = Infinity;
  for (const p of outlineOf(s)) {
    const d = distTo(p, q);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

const inside = (b: Box, q: Pt) => q.x >= b.x0 && q.x <= b.x1 && q.y >= b.y0 && q.y <= b.y1;

/** Wholly inside the box (a construction line never is: it has no ends). */
export function inWindow(s: Shape, box: Box): boolean {
  const b = shapeBox(s);
  return !!b && b.x0 >= box.x0 && b.x1 <= box.x1 && b.y0 >= box.y0 && b.y1 <= box.y1;
}

/** Inside the box or crossing its edge. */
export function touchesBox(s: Shape, box: Box): boolean {
  if (s.type === 'point') return inside(box, s.p);
  const b = shapeBox(s);
  if (b && (b.x1 < box.x0 || b.x0 > box.x1 || b.y1 < box.y0 || b.y0 > box.y1)) return false;
  const corners = [P(box.x0, box.y0), P(box.x1, box.y0), P(box.x1, box.y1), P(box.x0, box.y1)];
  const edges: Piece[] = corners.map((c, i) => ({ k: 'seg', a: c, b: corners[(i + 1) % 4] }));
  for (const p of outlineOf(s)) {
    if (p.k !== 'xline' && sample(p, stepsFor(p)).some(q => inside(box, q))) return true;
    if (edges.some(e => intersect(p, e).length)) return true;
  }
  return false;
}

/** The items joined end to end with the first one (within a ten-thousandth of a unit), in no set order. */
export function chainFrom(ents: Ent[], start: Ent, tol = 1e-4): Ent[] {
  const ends = new Map<number, [Pt, Pt]>();
  for (const e of ents) {
    const pair = endsOf(e);
    if (pair) ends.set(e.id, pair);
  }
  const first = ends.get(start.id);
  if (!first) return [start];
  const found = new Set<number>([start.id]);
  const open: Pt[] = [...first];
  while (open.length) {
    const q = open.pop()!;
    for (const e of ents) {
      if (found.has(e.id)) continue;
      const pair = ends.get(e.id);
      if (!pair) continue;
      if (dist(pair[0], q) <= tol || dist(pair[1], q) <= tol) {
        found.add(e.id);
        open.push(pair[0], pair[1]);
      }
    }
  }
  return ents.filter(e => found.has(e.id));
}

/** The box around a set of items (construction lines left out). */
export function boxOfShapes(shapes: Shape[]): Box | null {
  const pts: Pt[] = [];
  for (const s of shapes) {
    const b = shapeBox(s);
    if (b) pts.push(P(b.x0, b.y0), P(b.x1, b.y1));
  }
  return boxOf(pts);
}
