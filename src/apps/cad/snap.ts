// Snapping: the exact points near the pointer a click can land on (ends, middles, centres, crossings, quadrants,
// nearest, perpendicular and tangent from the last point, points, the grid), nearest first. Tab steps through them
// when several are close together.
import { P, dist, intersect, nearestOn, perpFeet, tangentPoints, type Box, type Piece, type Pt } from './geom.ts';
import { distToShape } from './edit.ts';
import { piecesOf, shapeBox, snapPoints, type Ent } from './model.ts';

export type SnapMode = 'end' | 'mid' | 'centre' | 'intersection' | 'quadrant' | 'nearest' | 'perpendicular' | 'tangent' | 'grid';

export const SNAP_ORDER: SnapMode[] = ['end', 'mid', 'centre', 'intersection', 'quadrant', 'nearest', 'perpendicular', 'tangent', 'grid'];

export const SNAP_NAMES: Record<SnapMode | 'point', string> = {
  end: 'End', mid: 'Middle', centre: 'Centre', intersection: 'Intersection', quadrant: 'Quadrant', nearest: 'Nearest',
  perpendicular: 'Perpendicular', tangent: 'Tangent', grid: 'Grid', point: 'Point',
};

export interface Snap {
  p: Pt;
  kind: SnapMode | 'point';
}

/** Lower comes first when two are about as close. */
const RANK: Record<Snap['kind'], number> = {
  end: 0, point: 0, intersection: 1, mid: 2, centre: 2, quadrant: 3, tangent: 4, perpendicular: 4, nearest: 6, grid: 7,
};

export interface SnapQuery {
  /** The pointer, in drawing units. */
  at: Pt;
  /** How far away a snap may be, in drawing units (a few pixels at this zoom). */
  reach: number;
  modes: ReadonlySet<SnapMode>;
  /** The point the tool is drawing from: perpendicular and tangent need it. */
  from: Pt | null;
  /** Grid spacing, when snapping to it. */
  grid: number;
  /**
   * With the pointer on an item (within `onItem`), that item's ends, middles, centres and quadrants catch from this
   * far (drawing units): point at a line anywhere near its middle and the middle is taken.
   */
  magnet?: number;
  onItem?: number;
}

const near = (b: Box | null, q: Pt, r: number) => !b || (q.x >= b.x0 - r && q.x <= b.x1 + r && q.y >= b.y0 - r && q.y <= b.y1 + r);

/** Every snap within reach, best first. */
export function findSnaps(ents: Ent[], q: SnapQuery): Snap[] {
  const out: Snap[] = [];
  const m = q.modes;
  const close: Array<{ e: Ent; pieces: Piece[] }> = [];
  const wide = Math.max(q.reach, q.magnet ?? 0);
  for (const e of ents) if (near(shapeBox(e), q.at, wide)) close.push({ e, pieces: piecesOf(e) });
  for (const { e, pieces } of close) {
    // On the item itself, its own snap points pull from further away.
    const pull = q.magnet && q.onItem && distToShape(e, q.at) <= q.onItem ? Math.max(q.reach, q.magnet) : q.reach;
    for (const s of snapPoints(e)) {
      const on = s.kind === 'point' || (s.kind === 'end' && m.has('end')) || (s.kind === 'mid' && m.has('mid')) || (s.kind === 'centre' && m.has('centre')) || (s.kind === 'quadrant' && m.has('quadrant'));
      if (on && dist(s.p, q.at) <= pull) out.push({ p: s.p, kind: s.kind });
    }
    for (const p of pieces) {
      if (m.has('nearest')) {
        const n = nearestOn(p, q.at);
        if (dist(n, q.at) <= q.reach) out.push({ p: n, kind: 'nearest' });
      }
      if (q.from && m.has('perpendicular')) for (const f of perpFeet(p, q.from)) if (dist(f, q.at) <= q.reach) out.push({ p: f, kind: 'perpendicular' });
      if (q.from && m.has('tangent')) for (const t of tangentPoints(p, q.from)) if (dist(t, q.at) <= q.reach) out.push({ p: t, kind: 'tangent' });
    }
  }
  if (m.has('intersection')) {
    // Only pieces passing within reach of the pointer can cross there.
    const pieces: Piece[] = [];
    for (const { pieces: ps } of close) for (const p of ps) if (dist(nearestOn(p, q.at), q.at) <= q.reach) pieces.push(p);
    for (let i = 0; i < pieces.length; i++) {
      for (let j = i + 1; j < pieces.length; j++) {
        for (const x of intersect(pieces[i], pieces[j])) if (dist(x, q.at) <= q.reach) out.push({ p: x, kind: 'intersection' });
      }
    }
  }
  if (m.has('grid') && q.grid > 0) {
    const g = P(Math.round(q.at.x / q.grid) * q.grid, Math.round(q.at.y / q.grid) * q.grid);
    if (dist(g, q.at) <= q.reach) out.push({ p: g, kind: 'grid' });
  }
  const score = (s: Snap) => dist(s.p, q.at) + RANK[s.kind] * 0.12 * q.reach;
  out.sort((a, b) => score(a) - score(b));
  // The same place found two ways is offered once (the better name kept).
  return out.filter((s, i) => !out.slice(0, i).some(o => dist(o.p, s.p) <= q.reach * 1e-6));
}
