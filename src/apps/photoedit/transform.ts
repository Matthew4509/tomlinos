// The sums behind Photo Editor's Move / transform tool: a box (centre, width, height, turn) with eight handles to
// stretch it and room around it to turn it. No browser needed.

export interface Pt {
  x: number;
  y: number;
}

export interface Box {
  cx: number;
  cy: number;
  w: number;
  h: number;
  /** Radians, clockwise on screen. */
  angle: number;
}

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'move' | 'rotate';

/** Where each handle sits, as (-1, 0, 1) across and down the box. */
const SIDES: Record<Exclude<Handle, 'move' | 'rotate'>, [number, number]> = {
  nw: [-1, -1], n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0],
};
export const HANDLES = Object.keys(SIDES) as Array<Exclude<Handle, 'move' | 'rotate'>>;

const rot = (p: Pt, a: number): Pt => ({ x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a) });

/** A point of the box, from its (-1..1, -1..1) place. */
export function boxPoint(b: Box, sx: number, sy: number): Pt {
  const v = rot({ x: (sx * b.w) / 2, y: (sy * b.h) / 2 }, b.angle);
  return { x: b.cx + v.x, y: b.cy + v.y };
}

export function handlePoint(b: Box, h: Exclude<Handle, 'move' | 'rotate'>): Pt {
  return boxPoint(b, SIDES[h][0], SIDES[h][1]);
}

export function corners(b: Box): Pt[] {
  return [boxPoint(b, -1, -1), boxPoint(b, 1, -1), boxPoint(b, 1, 1), boxPoint(b, -1, 1)];
}

/** The point in the box's own unturned frame, with (0, 0) at its centre. */
export function toLocal(b: Box, p: Pt): Pt {
  return rot({ x: p.x - b.cx, y: p.y - b.cy }, -b.angle);
}

/** Which handle is under the pointer: a handle within `reach`, else inside = move, outside = turn. */
export function hitHandle(b: Box, p: Pt, reach: number): Handle {
  for (const h of HANDLES) {
    const q = handlePoint(b, h);
    if (Math.hypot(q.x - p.x, q.y - p.y) <= reach) return h;
  }
  const l = toLocal(b, p);
  return Math.abs(l.x) <= b.w / 2 && Math.abs(l.y) <= b.h / 2 ? 'move' : 'rotate';
}

/**
 * The box after dragging `handle` from `start` to `p`; `start` is the box when the drag began. `keep` (Shift) keeps
 * the shape when a corner is dragged, and turns in 15 degree steps.
 */
export function dragBox(start: Box, handle: Handle, from: Pt, p: Pt, keep: boolean): Box {
  if (handle === 'move') return { ...start, cx: start.cx + p.x - from.x, cy: start.cy + p.y - from.y };
  if (handle === 'rotate') {
    let a = start.angle + Math.atan2(p.y - start.cy, p.x - start.cx) - Math.atan2(from.y - start.cy, from.x - start.cx);
    if (keep) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
    return { ...start, angle: a };
  }
  const [sx, sy] = SIDES[handle];
  // The opposite side stays where it is.
  const fixed = boxPoint(start, -sx, -sy);
  const v = rot({ x: p.x - fixed.x, y: p.y - fixed.y }, -start.angle);
  let w = sx ? Math.max(1, v.x * sx) : start.w;
  let h = sy ? Math.max(1, v.y * sy) : start.h;
  if (keep && sx && sy) {
    const k = Math.max(w / start.w, h / start.h);
    w = Math.max(1, start.w * k);
    h = Math.max(1, start.h * k);
  }
  const c = rot({ x: (sx * w) / 2, y: (sy * h) / 2 }, start.angle);
  return { cx: fixed.x + c.x, cy: fixed.y + c.y, w, h, angle: start.angle };
}

/** The smallest upright rectangle around the box (what it may cover once drawn). */
export function boxBounds(b: Box): { x: number; y: number; w: number; h: number } {
  const c = corners(b);
  // Rounded first, so a quarter turn (whose sine is not exactly 0 in floating point) does not grow by a pixel.
  const xs = c.map(p => Math.round(p.x * 1e6) / 1e6), ys = c.map(p => Math.round(p.y * 1e6) / 1e6);
  const x = Math.floor(Math.min(...xs)), y = Math.floor(Math.min(...ys));
  return { x, y, w: Math.ceil(Math.max(...xs)) - x, h: Math.ceil(Math.max(...ys)) - y };
}

export function isIdentity(a: Box, b: Box): boolean {
  return Math.abs(a.cx - b.cx) < 1e-6 && Math.abs(a.cy - b.cy) < 1e-6 && Math.abs(a.w - b.w) < 1e-6 && Math.abs(a.h - b.h) < 1e-6 && Math.abs(a.angle - b.angle) < 1e-9;
}
