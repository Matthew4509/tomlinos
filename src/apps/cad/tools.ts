// TOMLIN CAD's tools: each asks for what it needs one step at a time (a point, a number, an item to pick, or items
// to select), shows the shape it would make as the pointer moves, and makes it. Points come from clicks (snapped) or
// the command line; a lone number where a point is asked means that far from the last point towards the pointer.
import {
  P, add, angleOf, arcThrough, ccwArc, circleTTR, circleTTT, circumcircle, dist, dot, mid, mul, normAngle, rotatePt, sub,
  tangentLines, tangentPoints, unit, type Piece, type Pt,
} from './geom.ts';
import { boxOfShapes, chainFrom, mirrorShape, moveShape, pieceNear, rotateShape, scaleShape } from './edit.ts';
import { CONSTRUCTION, ellipse, pieceLength, piecesOf, polygon, rectangle, slot, type Ent, type Shape, type Units } from './model.ts';
import { areaOf, breakAt, breakBetween, chamfer, closeShape, cornerBetween, extend, fillet, offset, polyCorners, reverse, setStart, trim } from './modify.ts';

export interface Want {
  point?: boolean;
  number?: boolean;
  pick?: boolean;
  /** Width,height typed for a rectangle round its centre. */
  size?: boolean;
  /** Clicks and boxes choose items; Enter goes on. */
  select?: boolean;
}

export interface PolarAnswer {
  count: number;
  /** Degrees, anticlockwise; 360 spreads the copies all the way round. */
  angle: number;
  rotate: boolean;
}

export interface ToolCtx {
  units(): Units;
  /** The items that may be picked (on layers that are on and not locked). */
  ents(): Ent[];
  selection(): Ent[];
  select(ids: number[]): void;
  /** Adds shapes as one step of undo; on the current layer unless one is named. */
  add(shapes: Shape[], layer?: string): void;
  /** The items that are showing (locked ones too): what snaps, trim and extend see. */
  visible(): Ent[];
  /** Changes items, adds new ones (on the layers given) and takes some away, as one step of undo. */
  change(changed: Array<{ id: number; shape: Shape }>, added: Array<{ shape: Shape; layer: string }>, removed?: number[]): void;
  /** Takes back the last step of undo (the line tool's U). */
  undoLast(): void;
  say(text: string): void;
  problem(text: string): void;
  fmt(v: number): string;
  list(e: Ent): void;
  zoomTo(a: Pt, b: Pt): void;
  askPolar(): Promise<PolarAnswer | null>;
  /** A tool that finished on its own (after a box was answered) tells the window here. */
  finished(): void;
}

export interface Tool {
  title: string;
  prompt(): string;
  want(): Want;
  /** Where @ counts from, ortho works from, and the rubber band starts. */
  base(): Pt | null;
  pickFilter?(e: Ent): boolean;
  point?(p: Pt): void;
  number?(v: number, cursor: Pt): void;
  size?(w: number, h: number): void;
  pick?(e: Ent, at: Pt): void;
  /** A word typed on the command line (C to close, U to take back); false when the tool has no such word. */
  word?(w: string): boolean;
  /** Enter (or a right-click): true when the tool carries on. */
  enter(): boolean;
  preview(cursor: Pt): Shape[];
  /** Set when the tool has finished. */
  done: boolean;
}

const deg = (v: number) => (v * Math.PI) / 180;
const line = (a: Pt, b: Pt): Shape => ({ type: 'line', a, b });
const circle = (c: Pt, r: number): Shape => ({ type: 'circle', c, r });

/** Pieces that are straight or round (what tangent circles can touch). */
const lineOrRound = (e: Ent) => e.type === 'line' || e.type === 'arc' || e.type === 'circle' || e.type === 'poly' || e.type === 'xline';
const round = (e: Ent) => e.type === 'arc' || e.type === 'circle' || (e.type === 'poly' && e.bulges.some(b => b !== 0));
const curved = (e: Ent) => round(e) || e.type === 'ellipse' || e.type === 'spline';

function arcPieceOf(e: Ent, at: Pt): Extract<Piece, { k: 'arc' }> | null {
  const p = pieceNear(e, at);
  return p && p.k === 'arc' ? p : null;
}

// ---- Geometry: lines -----------------------------------------------------------------------------------------------

function lineTool(ctx: ToolCtx): Tool {
  const pts: Pt[] = [];
  const t: Tool = {
    title: 'Line',
    done: false,
    prompt: () => (pts.length ? 'Next point (C closes back to the first, U takes back the last; Done ends)' : 'First point'),
    want: () => ({ point: true }),
    base: () => pts[pts.length - 1] ?? null,
    point(p) {
      const last = pts[pts.length - 1];
      if (last && dist(last, p) < 1e-12) return ctx.problem('That is the same point as the last one.');
      if (last) ctx.add([line(last, p)]);
      pts.push(p);
    },
    word(w) {
      if (w === 'c') {
        if (pts.length < 3) {
          ctx.problem('Close needs two lines drawn first.');
          return true;
        }
        ctx.add([line(pts[pts.length - 1], pts[0])]);
        t.done = true;
        return true;
      }
      if (w === 'u') {
        if (pts.length > 1) ctx.undoLast();
        pts.pop();
        return true;
      }
      return false;
    },
    enter: () => false,
    preview: c => (pts.length ? [line(pts[pts.length - 1], c)] : []),
  };
  return t;
}

function polylineTool(ctx: ToolCtx): Tool {
  const pts: Pt[] = [];
  const finish = (closed: boolean) => {
    if (pts.length >= (closed ? 3 : 2)) ctx.add([{ type: 'poly', pts: [...pts], bulges: pts.map(() => 0), closed }]);
    else ctx.problem(closed ? 'A closed polyline needs three points or more.' : 'A polyline needs two points or more.');
  };
  const t: Tool = {
    title: 'Polyline',
    done: false,
    prompt: () => (pts.length ? 'Next point (C closes it, U takes back the last point; Done ends)' : 'First point'),
    want: () => ({ point: true }),
    base: () => pts[pts.length - 1] ?? null,
    point(p) {
      if (pts.length && dist(pts[pts.length - 1], p) < 1e-12) return ctx.problem('That is the same point as the last one.');
      pts.push(p);
    },
    word(w) {
      if (w === 'c') {
        finish(true);
        t.done = true;
        return true;
      }
      if (w === 'u') {
        pts.pop();
        return true;
      }
      return false;
    },
    enter() {
      finish(false);
      return false;
    },
    preview: c => (pts.length ? [{ type: 'poly', pts: [...pts, c], bulges: [...pts, c].map(() => 0), closed: false }] : []),
  };
  return t;
}

/** Steps through a fixed list of questions, then makes the shape (and starts again when `again`). */
function stepTool(ctx: ToolCtx, o: {
  title: string;
  /** dflt: what Enter answers for a number (the last radius, the same distance again). */
  steps: Array<{ prompt: string; want: Want; filter?: (e: Ent) => boolean; dflt?: () => number | null }>;
  /** The base point for each step (from what has been given so far). */
  base?: (got: Given[]) => Pt | null;
  preview?: (got: Given[], cursor: Pt) => Shape[];
  /** How many answers the preview needs before it shows (1 unless set). */
  previewFrom?: number;
  /** Makes the shapes (or says why it cannot): true when done. */
  make: (got: Given[]) => boolean;
  again?: boolean;
  /** After making it, keep this many answers and ask the rest again (a construction line's angle kept for the next). */
  keep?: number;
  /** The words a step understands (C for keep the original...), and the prompt's extra words. */
  word?: (w: string) => boolean;
  promptExtra?: () => string;
}): Tool {
  let got: Given[] = [];
  // While the shape is being made every answer is in, and the window may ask again: the last step answers.
  const step = () => o.steps[Math.min(got.length, o.steps.length - 1)];
  const t: Tool = {
    title: o.title,
    done: false,
    prompt: () => step().prompt + (o.promptExtra ? o.promptExtra() : ''),
    want: () => step().want,
    base: () => (o.base ? o.base(got) : (got.filter(g => g.kind === 'point').pop() as { p: Pt } | undefined)?.p ?? null),
    pickFilter: e => (step().filter ? step().filter!(e) : true),
    point: p => give({ kind: 'point', p }),
    number: v => give({ kind: 'number', v }),
    size: (w, h) => give({ kind: 'size', w, h }),
    pick: (e, at) => give({ kind: 'pick', e, at }),
    word: o.word,
    enter() {
      const dflt = o.steps[got.length]?.dflt?.();
      if (dflt !== undefined && dflt !== null) {
        give({ kind: 'number', v: dflt });
        return !t.done;
      }
      // Answers kept from the last round (a radius) do not make the tool unfinished.
      if (got.length > (o.keep ?? 0)) ctx.problem(`${o.title} was not finished: nothing was made.`);
      return false;
    },
    preview: c => (o.preview && got.length >= (o.previewFrom ?? 1) ? o.preview(got, c) : []),
  };
  function give(g: Given): void {
    const asked = o.steps[got.length];
    const want = asked.want;
    const kindOk = (g.kind === 'point' && want.point) || (g.kind === 'number' && want.number) || (g.kind === 'size' && want.size) || (g.kind === 'pick' && want.pick);
    if (!kindOk) return ctx.problem(asked.prompt);
    got.push(g);
    if (got.length < o.steps.length) return;
    const ok = o.make(got);
    if (!ok) {
      got.pop();
      return;
    }
    if (o.keep !== undefined) got = got.slice(0, o.keep);
    else if (o.again) got = [];
    else t.done = true;
  }
  return t;
}

type Given = { kind: 'point'; p: Pt } | { kind: 'number'; v: number } | { kind: 'size'; w: number; h: number } | { kind: 'pick'; e: Ent; at: Pt };

const ptOf = (g: Given | undefined): Pt | null => (g && g.kind === 'point' ? g.p : null);
/** A distance given as a number, or as a point (its distance from `from`). */
const distOf = (g: Given, from: Pt): number => (g.kind === 'number' ? g.v : g.kind === 'point' ? dist(from, g.p) : NaN);

// ---- Geometry: rectangles, circles, arcs, ellipses, polygons, slots ----------------------------------------------

function rectTool(ctx: ToolCtx): Tool {
  return stepTool(ctx, {
    title: 'Rectangle',
    steps: [{ prompt: 'First corner', want: { point: true } }, { prompt: 'Other corner (or @width,height)', want: { point: true } }],
    preview: (g, c) => [rectangle(ptOf(g[0])!, c)].filter(Boolean) as Shape[],
    make(g) {
      const s = rectangle(ptOf(g[0])!, ptOf(g[1])!);
      if (!s) return fail(ctx, 'A rectangle needs some width and some height.');
      ctx.add([s]);
      return true;
    },
    again: true,
  });
}

function rectCentreTool(ctx: ToolCtx): Tool {
  const around = (c: Pt, w: number, h: number) => rectangle(P(c.x - w / 2, c.y - h / 2), P(c.x + w / 2, c.y + h / 2));
  return stepTool(ctx, {
    title: 'Rectangle round a centre',
    steps: [{ prompt: 'Centre', want: { point: true } }, { prompt: 'Width and height (or click a corner)', want: { point: true, size: true } }],
    preview: (g, c) => {
      const centre = ptOf(g[0])!;
      return [around(centre, 2 * Math.abs(c.x - centre.x), 2 * Math.abs(c.y - centre.y))].filter(Boolean) as Shape[];
    },
    make(g) {
      const c = ptOf(g[0])!;
      const second = g[1];
      const s = second.kind === 'size' ? around(c, Math.abs(second.w), Math.abs(second.h)) : around(c, 2 * Math.abs(ptOf(second)!.x - c.x), 2 * Math.abs(ptOf(second)!.y - c.y));
      if (!s) return fail(ctx, 'A rectangle needs some width and some height.');
      ctx.add([s]);
      return true;
    },
    again: true,
  });
}

function rectRoundTool(ctx: ToolCtx): Tool {
  return stepTool(ctx, {
    title: 'Rectangle with rounded corners',
    steps: [{ prompt: 'First corner', want: { point: true } }, { prompt: 'Other corner (or @width,height)', want: { point: true } }, { prompt: 'Corner radius', want: { number: true } }],
    preview: (g, c) => [rectangle(ptOf(g[0])!, ptOf(g[1]) ?? c)].filter(Boolean) as Shape[],
    make(g) {
      const r = (g[2] as { v: number }).v;
      if (!(r >= 0)) return fail(ctx, 'The corner radius must be 0 or more.');
      const a = ptOf(g[0])!;
      const b = ptOf(g[1])!;
      if (r > Math.min(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) / 2 + 1e-12) return fail(ctx, `The radius can be at most half the shorter side (${ctx.fmt(Math.min(Math.abs(b.x - a.x), Math.abs(b.y - a.y)) / 2)}).`);
      const s = rectangle(a, b, r);
      if (!s) return fail(ctx, 'A rectangle needs some width and some height.');
      ctx.add([s]);
      return true;
    },
  });
}

function fail(ctx: ToolCtx, why: string): false {
  ctx.problem(why);
  return false;
}

function circleCentreTool(ctx: ToolCtx, diameter: boolean): Tool {
  const size = (g: Given, c: Pt) => (g.kind === 'number' ? (diameter ? g.v / 2 : g.v) : dist(c, ptOf(g)!));
  return stepTool(ctx, {
    title: diameter ? 'Circle: centre and diameter' : 'Circle: centre and radius',
    steps: [{ prompt: 'Centre', want: { point: true } }, { prompt: diameter ? 'Diameter (or click a point on the circle)' : 'Radius (or click a point on the circle)', want: { point: true, number: true } }],
    preview: (g, c) => [circle(ptOf(g[0])!, dist(ptOf(g[0])!, c))],
    make(g) {
      const c = ptOf(g[0])!;
      const r = size(g[1], c);
      if (!(r > 0)) return fail(ctx, 'A circle needs a size above 0.');
      ctx.add([circle(c, r)]);
      return true;
    },
    again: true,
  });
}

function circle2Tool(ctx: ToolCtx): Tool {
  return stepTool(ctx, {
    title: 'Circle: two points across',
    steps: [{ prompt: 'One end of a diameter', want: { point: true } }, { prompt: 'The other end', want: { point: true } }],
    preview: (g, c) => [circle(mid(ptOf(g[0])!, c), dist(ptOf(g[0])!, c) / 2)],
    make(g) {
      const a = ptOf(g[0])!;
      const b = ptOf(g[1])!;
      if (dist(a, b) < 1e-12) return fail(ctx, 'The two points are the same.');
      ctx.add([circle(mid(a, b), dist(a, b) / 2)]);
      return true;
    },
    again: true,
  });
}

function circle3Tool(ctx: ToolCtx): Tool {
  return stepTool(ctx, {
    title: 'Circle: three points',
    steps: [{ prompt: 'First point on the circle', want: { point: true } }, { prompt: 'Second point', want: { point: true } }, { prompt: 'Third point', want: { point: true } }],
    preview: (g, c) => {
      if (g.length < 2) return g.length ? [line(ptOf(g[0])!, c)] : [];
      const cc = circumcircle(ptOf(g[0])!, ptOf(g[1])!, c);
      return cc ? [circle(cc.c, cc.r)] : [];
    },
    make(g) {
      const cc = circumcircle(ptOf(g[0])!, ptOf(g[1])!, ptOf(g[2])!);
      if (!cc) return fail(ctx, 'The three points are in a straight line, so no circle goes through them.');
      ctx.add([circle(cc.c, cc.r)]);
      return true;
    },
    again: true,
  });
}

function ttrTool(ctx: ToolCtx, asArc: boolean): Tool {
  const pickStep = (prompt: string) => ({ prompt, want: { pick: true }, filter: lineOrRound });
  return stepTool(ctx, {
    title: asArc ? 'Arc: touching two items, radius' : 'Circle: touching two items, radius',
    steps: [pickStep('Pick the first line, arc or circle it touches'), pickStep('Pick the second'), { prompt: 'Radius', want: { number: true } }],
    base: () => null,
    make(g) {
      const a = g[0] as { e: Ent; at: Pt };
      const b = g[1] as { e: Ent; at: Pt };
      const r = (g[2] as { v: number }).v;
      if (!(r > 0)) return fail(ctx, 'The radius must be above 0.');
      const pa = pieceNear(a.e, a.at);
      const pb = pieceNear(b.e, b.at);
      const found = pa && pb ? circleTTR(pa, pb, r, a.at, b.at) : null;
      if (found === 'shape') return fail(ctx, 'Touching circles work with lines, arcs and circles, not with ellipses or curves.');
      if (!found) return fail(ctx, `No circle of radius ${ctx.fmt(r)} touches both.`);
      if (!asArc) ctx.add([circle(found.c, found.r)]);
      else {
        const s = angleOf(sub(found.touch[0], found.c));
        const e = angleOf(sub(found.touch[1], found.c));
        // The shorter way round, as a fillet would be.
        const arc = normAngle(e - s) <= Math.PI ? ccwArc(found.c, found.r, s, e) : ccwArc(found.c, found.r, e, s);
        ctx.add([{ type: 'arc', ...arc }]);
      }
      return true;
    },
    again: true,
  });
}

function tttTool(ctx: ToolCtx): Tool {
  const pickStep = (prompt: string) => ({ prompt, want: { pick: true }, filter: lineOrRound });
  return stepTool(ctx, {
    title: 'Circle: touching three items',
    steps: [pickStep('Pick the first line, arc or circle it touches'), pickStep('Pick the second'), pickStep('Pick the third')],
    base: () => null,
    make(g) {
      const picks = g as Array<{ e: Ent; at: Pt }>;
      const pieces = picks.map(p => pieceNear(p.e, p.at));
      if (pieces.some(p => !p)) return fail(ctx, 'One of those has nothing to touch.');
      const found = circleTTT(pieces as Piece[], picks.map(p => p.at));
      if (found === 'shape') return fail(ctx, 'Touching circles work with lines, arcs and circles, not with ellipses or curves.');
      if (!found) return fail(ctx, 'No circle touching all three was found near the places picked. Pick closer to where it should touch.');
      ctx.add([circle(found.c, found.r)]);
      return true;
    },
    again: true,
  });
}

function arc3Tool(ctx: ToolCtx): Tool {
  return stepTool(ctx, {
    title: 'Arc: three points',
    steps: [{ prompt: 'Start of the arc', want: { point: true } }, { prompt: 'A point on the arc', want: { point: true } }, { prompt: 'End of the arc', want: { point: true } }],
    preview: (g, c) => {
      if (g.length < 2) return g.length ? [line(ptOf(g[0])!, c)] : [];
      const a = arcThrough(ptOf(g[0])!, ptOf(g[1])!, c);
      return a ? [{ type: 'arc', ...a }] : [];
    },
    make(g) {
      const a = arcThrough(ptOf(g[0])!, ptOf(g[1])!, ptOf(g[2])!);
      if (!a) return fail(ctx, 'The three points are in a straight line, so no arc goes through them.');
      ctx.add([{ type: 'arc', ...a }]);
      return true;
    },
    again: true,
  });
}

function arcCseTool(ctx: ToolCtx): Tool {
  const make = (c: Pt, s: Pt, end: Given): Shape | null => {
    const r = dist(c, s);
    if (r < 1e-12) return null;
    const a = angleOf(sub(s, c));
    if (end.kind === 'number') {
      if (Math.abs(end.v) < 1e-12) return null;
      const span = Math.max(-360, Math.min(360, end.v));
      return { type: 'arc', ...(span > 0 ? ccwArc(c, r, a, a + deg(span)) : ccwArc(c, r, a + deg(span), a)) };
    }
    const e = ptOf(end)!;
    if (dist(e, c) < 1e-12) return null;
    return { type: 'arc', ...ccwArc(c, r, a, angleOf(sub(e, c))) };
  };
  return stepTool(ctx, {
    title: 'Arc: centre, start, end',
    steps: [{ prompt: 'Centre', want: { point: true } }, { prompt: 'Start (sets the radius)', want: { point: true } }, { prompt: 'End (anticlockwise from the start), or the angle it turns in degrees (minus for clockwise)', want: { point: true, number: true } }],
    base: g => ptOf(g[0]),
    preview: (g, c) => {
      if (g.length < 2) return g.length ? [line(ptOf(g[0])!, c)] : [];
      const s = make(ptOf(g[0])!, ptOf(g[1])!, { kind: 'point', p: c });
      return s ? [s] : [];
    },
    make(g) {
      const s = make(ptOf(g[0])!, ptOf(g[1])!, g[2]);
      if (!s) return fail(ctx, 'That arc has no size.');
      ctx.add([s]);
      return true;
    },
    again: true,
  });
}

function arcSerTool(ctx: ToolCtx): Tool {
  /** The arc from s to e of radius r on the side of the chord the pointer is (a radius below 0 takes the long way). */
  const make = (s: Pt, e: Pt, r: number, side: Pt): Shape | null => {
    const d = dist(s, e);
    const R = Math.abs(r);
    if (d < 1e-12 || R < d / 2 - 1e-12) return null;
    const h = Math.sqrt(Math.max(0, R * R - (d * d) / 4));
    const u = unit(sub(e, s));
    const n = P(-u.y, u.x);
    const left = dot(sub(side, s), n) >= 0;
    // The arc bulges to the pointer's side: its centre is on the other side for the short way, the same side for the long.
    const toCentre = (left ? -1 : 1) * (r < 0 ? -1 : 1);
    const c = add(mid(s, e), mul(n, toCentre * h));
    const as = angleOf(sub(s, c));
    const ae = angleOf(sub(e, c));
    const viaSide = left ? ccwArc(c, R, ae, as) : ccwArc(c, R, as, ae);
    return { type: 'arc', ...viaSide };
  };
  let cursor = P(0, 0);
  return stepTool(ctx, {
    title: 'Arc: start, end, radius',
    steps: [{ prompt: 'Start of the arc', want: { point: true } }, { prompt: 'End of the arc', want: { point: true } }, { prompt: 'Radius (the arc bulges towards the pointer; minus for the long way round), or click a point on it', want: { number: true, point: true } }],
    preview: (g, c) => {
      cursor = c;
      if (g.length < 2) return g.length ? [line(ptOf(g[0])!, c)] : [];
      const a = arcThrough(ptOf(g[0])!, c, ptOf(g[1])!);
      return a ? [{ type: 'arc', ...a }] : [];
    },
    make(g) {
      const s = ptOf(g[0])!;
      const e = ptOf(g[1])!;
      let shape: Shape | null;
      if (g[2].kind === 'point') {
        const a = arcThrough(s, g[2].p, e);
        shape = a ? { type: 'arc', ...a } : null;
      } else shape = make(s, e, (g[2] as { v: number }).v, cursor);
      if (!shape) return fail(ctx, 'No arc of that radius joins those two points (the radius must be at least half the distance between them).');
      ctx.add([shape]);
      return true;
    },
    again: true,
  });
}

function ellipseTool(ctx: ToolCtx): Tool {
  const other = (g: Given, c: Pt, axisEnd: Pt) => {
    if (g.kind === 'number') return g.v;
    const u = unit(sub(axisEnd, c));
    return Math.abs(dot(sub(ptOf(g)!, c), P(-u.y, u.x)));
  };
  return stepTool(ctx, {
    title: 'Ellipse',
    steps: [{ prompt: 'Centre', want: { point: true } }, { prompt: 'End of one axis (sets its length and angle)', want: { point: true } }, { prompt: 'The other half-axis (a length, or click)', want: { point: true, number: true } }],
    base: g => ptOf(g[0]),
    preview: (g, c) => {
      if (g.length < 2) return g.length ? [line(ptOf(g[0])!, c)] : [];
      const e = ellipse(ptOf(g[0])!, ptOf(g[1])!, other({ kind: 'point', p: c }, ptOf(g[0])!, ptOf(g[1])!));
      return e ? [e] : [line(ptOf(g[0])!, ptOf(g[1])!)];
    },
    make(g) {
      const e = ellipse(ptOf(g[0])!, ptOf(g[1])!, other(g[2], ptOf(g[0])!, ptOf(g[1])!));
      if (!e) return fail(ctx, 'An ellipse needs both axes longer than 0.');
      ctx.add([e]);
      return true;
    },
    again: true,
  });
}

function polygonTool(ctx: ToolCtx, corners: boolean): Tool {
  let sides = 6;
  return stepTool(ctx, {
    title: corners ? 'Polygon: corners on a circle' : 'Polygon: sides touching a circle',
    steps: [{ prompt: 'Centre', want: { point: true } }, { prompt: 'Number of sides', want: { number: true } }, { prompt: 'Radius (or click: sets the size and the turn)', want: { point: true, number: true } }],
    base: g => ptOf(g[0]),
    promptExtra: () => ` (now ${sides} sides)`,
    preview: (g, c) => {
      if (g.length < 2) return [];
      const p = polygon(ptOf(g[0])!, sides, dist(ptOf(g[0])!, c), c, corners);
      return p ? [p] : [];
    },
    make(g) {
      const n = (g[1] as { v: number }).v;
      if (!Number.isInteger(n) || n < 3 || n > 1000) return fail(ctx, 'A polygon has a whole number of sides, from 3 to 1000.');
      sides = n;
      const c = ptOf(g[0])!;
      const r = distOf(g[2], c);
      const toward = g[2].kind === 'point' ? g[2].p : add(c, P(0, 1));
      const p = polygon(c, sides, r, toward, corners);
      if (!p) return fail(ctx, 'The radius must be above 0.');
      ctx.add([p]);
      return true;
    },
    again: true,
  });
}

function slotTool(ctx: ToolCtx): Tool {
  const width = (g: Given, a: Pt, b: Pt) => {
    if (g.kind === 'number') return g.v;
    const p = ptOf(g)!;
    if (dist(a, b) < 1e-12) return 2 * dist(a, p);
    const u = unit(sub(b, a));
    return 2 * Math.abs(dot(sub(p, a), P(-u.y, u.x)));
  };
  return stepTool(ctx, {
    title: 'Slot',
    steps: [{ prompt: 'Centre of one end', want: { point: true } }, { prompt: 'Centre of the other end', want: { point: true } }, { prompt: 'Width (or click a side)', want: { point: true, number: true } }],
    preview: (g, c) => {
      if (g.length < 2) return g.length ? [line(ptOf(g[0])!, c)] : [];
      const s = slot(ptOf(g[0])!, ptOf(g[1])!, width({ kind: 'point', p: c }, ptOf(g[0])!, ptOf(g[1])!));
      return s ? [s] : [];
    },
    make(g) {
      const s = slot(ptOf(g[0])!, ptOf(g[1])!, width(g[2], ptOf(g[0])!, ptOf(g[1])!));
      if (!s) return fail(ctx, 'A slot needs a width above 0.');
      ctx.add([s]);
      return true;
    },
    again: true,
  });
}

function splineTool(ctx: ToolCtx): Tool {
  const pts: Pt[] = [];
  const t: Tool = {
    title: 'Curve through points',
    done: false,
    prompt: () => (pts.length ? 'Next point (C closes the curve, U takes back the last point; Done ends)' : 'First point'),
    want: () => ({ point: true }),
    base: () => pts[pts.length - 1] ?? null,
    point(p) {
      if (pts.length && dist(pts[pts.length - 1], p) < 1e-12) return ctx.problem('That is the same point as the last one.');
      pts.push(p);
    },
    word(w) {
      if (w === 'c') {
        if (pts.length < 3) ctx.problem('A closed curve needs three points or more.');
        else ctx.add([{ type: 'spline', fit: [...pts], closed: true }]);
        t.done = true;
        return true;
      }
      if (w === 'u') {
        pts.pop();
        return true;
      }
      return false;
    },
    enter() {
      if (pts.length >= 2) ctx.add([{ type: 'spline', fit: [...pts], closed: false }]);
      else ctx.problem('A curve needs two points or more.');
      return false;
    },
    preview: c => (pts.length ? [{ type: 'spline', fit: [...pts, c], closed: false }] : []),
  };
  return t;
}

function pointTool(ctx: ToolCtx): Tool {
  return stepTool(ctx, {
    title: 'Point',
    steps: [{ prompt: 'Where (Done ends)', want: { point: true } }],
    base: () => null,
    make(g) {
      ctx.add([{ type: 'point', p: ptOf(g[0])! }]);
      return true;
    },
    again: true,
  });
}

// ---- Construction lines and tangent lines -------------------------------------------------------------------------

function xlineTool(ctx: ToolCtx, kind: 'h' | 'v' | 'angle' | '2p'): Tool {
  const xl = (p: Pt, a: number): Shape => ({ type: 'xline', p, d: P(Math.cos(a), Math.sin(a)) });
  if (kind === '2p') {
    return stepTool(ctx, {
      title: 'Construction line through two points',
      steps: [{ prompt: 'First point', want: { point: true } }, { prompt: 'Second point', want: { point: true } }],
      preview: (g, c) => (dist(ptOf(g[0])!, c) > 1e-12 ? [xl(ptOf(g[0])!, angleOf(sub(c, ptOf(g[0])!)))] : []),
      make(g) {
        const a = ptOf(g[0])!;
        const b = ptOf(g[1])!;
        if (dist(a, b) < 1e-12) return fail(ctx, 'The two points are the same.');
        ctx.add([xl(a, angleOf(sub(b, a)))], CONSTRUCTION);
        return true;
      },
      again: true,
    });
  }
  if (kind === 'angle') {
    let angle = 45;
    return stepTool(ctx, {
      title: 'Construction line at an angle',
      steps: [{ prompt: 'Angle in degrees (anticlockwise from the right)', want: { number: true } }, { prompt: 'A point it goes through (Done ends)', want: { point: true } }],
      base: () => null,
      promptExtra: () => ` (now ${angle}°)`,
      preview: (g, c) => [xl(c, deg((g[0] as { v: number }).v))],
      make(g) {
        angle = (g[0] as { v: number }).v;
        ctx.add([xl(ptOf(g[1])!, deg(angle))], CONSTRUCTION);
        return true;
      },
      keep: 1,
    });
  }
  const a = kind === 'h' ? 0 : Math.PI / 2;
  return stepTool(ctx, {
    title: kind === 'h' ? 'Horizontal construction line' : 'Vertical construction line',
    steps: [{ prompt: 'A point it goes through (Done ends)', want: { point: true } }],
    base: () => null,
    preview: (_g, c) => [xl(c, a)],
    previewFrom: 0,
    make(g) {
      ctx.add([xl(ptOf(g[0])!, a)], CONSTRUCTION);
      return true;
    },
    again: true,
  });
}

function xlineOffsetTool(ctx: ToolCtx): Tool {
  let distance = 0;
  const along = (e: Ent, at: Pt): { p: Pt; d: Pt } | null => {
    const piece = pieceNear(e, at);
    if (piece?.k === 'seg') return { p: piece.a, d: unit(sub(piece.b, piece.a)) };
    if (piece?.k === 'xline') return { p: piece.p, d: piece.d };
    return null;
  };
  const make = (base: { p: Pt; d: Pt }, side: Pt, by: number): Shape => {
    const n = P(-base.d.y, base.d.x);
    const s = dot(sub(side, base.p), n) >= 0 ? 1 : -1;
    return { type: 'xline', p: add(base.p, mul(n, s * by)), d: base.d };
  };
  return stepTool(ctx, {
    title: 'Construction line at a distance from a line',
    steps: [{ prompt: 'Distance', want: { number: true } }, { prompt: 'Pick the line to measure from', want: { pick: true }, filter: e => e.type === 'line' || e.type === 'xline' || e.type === 'poly' }, { prompt: 'Click the side it goes on', want: { point: true } }],
    base: () => null,
    preview: (g, c) => {
      if (g.length < 2) return [];
      const b = along((g[1] as { e: Ent }).e, (g[1] as { at: Pt }).at);
      return b ? [make(b, c, (g[0] as { v: number }).v)] : [];
    },
    make(g) {
      distance = (g[0] as { v: number }).v;
      if (!(distance > 0)) return fail(ctx, 'The distance must be above 0.');
      const b = along((g[1] as { e: Ent }).e, (g[1] as { at: Pt }).at);
      if (!b) return fail(ctx, 'Pick a straight line (or a straight part of a polyline).');
      ctx.add([make(b, ptOf(g[2])!, distance)], CONSTRUCTION);
      return true;
    },
    // The same distance again, from another line.
    keep: 1,
  });
}

function tangentFromPointTool(ctx: ToolCtx): Tool {
  return stepTool(ctx, {
    title: 'Line from a point, touching a curve',
    steps: [{ prompt: 'Start point', want: { point: true } }, { prompt: 'Pick the arc, circle, ellipse or curve it touches, near where it should touch', want: { pick: true }, filter: curved }],
    make(g) {
      const from = ptOf(g[0])!;
      const pick = g[1] as { e: Ent; at: Pt };
      const piece = pieceNear(pick.e, pick.at);
      const touches = piece ? tangentPoints(piece, from) : [];
      if (!touches.length) return fail(ctx, 'No line from that point touches it (the point may be inside it).');
      const best = touches.sort((a, b) => dist(a, pick.at) - dist(b, pick.at))[0];
      ctx.add([line(from, best)]);
      return true;
    },
    again: true,
  });
}

function tangentTwoTool(ctx: ToolCtx): Tool {
  return stepTool(ctx, {
    title: 'Line touching two arcs or circles',
    steps: [{ prompt: 'Pick the first arc or circle, near where the line should touch', want: { pick: true }, filter: round }, { prompt: 'Pick the second, near where the line should touch', want: { pick: true }, filter: round }],
    base: () => null,
    make(g) {
      const a = g[0] as { e: Ent; at: Pt };
      const b = g[1] as { e: Ent; at: Pt };
      const pa = arcPieceOf(a.e, a.at);
      const pb = arcPieceOf(b.e, b.at);
      if (!pa || !pb) return fail(ctx, 'Pick arcs or circles (or the round parts of a polyline).');
      const lines = tangentLines(pa.c, pa.r, pb.c, pb.r);
      if (!lines.length) return fail(ctx, 'No line touches both (one is inside the other).');
      const best = lines.sort((x, y) => dist(x[0], a.at) + dist(x[1], b.at) - dist(y[0], a.at) - dist(y[1], b.at))[0];
      ctx.add([line(best[0], best[1])]);
      return true;
    },
    again: true,
  });
}

// ---- Edit: move, copy, rotate, mirror, scale, arrays --------------------------------------------------------------

/** Wraps an edit tool: if nothing is selected yet, it first asks for items to be chosen. */
function needsSelection(ctx: ToolCtx, title: string, inner: () => Tool): Tool {
  let tool: Tool | null = ctx.selection().length ? inner() : null;
  const t: Tool = {
    title,
    done: false,
    prompt: () => (tool ? tool.prompt() : `Choose the items to ${title.toLowerCase()} (click them, or drag a box), then press Enter`),
    want: () => (tool ? tool.want() : { select: true }),
    base: () => (tool ? tool.base() : null),
    pickFilter: e => (tool?.pickFilter ? tool.pickFilter(e) : true),
    point: p => tool?.point?.(p),
    number: (v, c) => tool?.number?.(v, c),
    size: (w, h) => tool?.size?.(w, h),
    pick: (e, at) => tool?.pick?.(e, at),
    word: w => (tool?.word ? tool.word(w) : false),
    enter() {
      if (tool) return tool.enter();
      if (!ctx.selection().length) {
        ctx.problem('Nothing is chosen yet.');
        return true;
      }
      tool = inner();
      return true;
    },
    preview: c => (tool ? tool.preview(c) : []),
  };
  // The finished state comes from the wrapped tool.
  Object.defineProperty(t, 'done', { get: () => !!tool?.done, set: () => {} });
  return t;
}

function shiftedSelection(ctx: ToolCtx, f: (s: Shape) => Shape): Shape[] {
  return ctx.selection().map(e => f(e));
}

/** Applies f to the chosen items: changing them, or (keep) adding the changed copies beside them. */
function applyToSelection(ctx: ToolCtx, f: (s: Shape) => Shape, keep: boolean): void {
  const sel = ctx.selection();
  if (keep) ctx.change([], sel.map(e => ({ shape: f(e), layer: e.layer })));
  else ctx.change(sel.map(e => ({ id: e.id, shape: f(e) })), []);
}

const strip = (e: Ent): Shape => {
  const { id: _id, layer: _layer, ...s } = e;
  return s as Shape;
};

function moveTool(ctx: ToolCtx, copy: boolean): Tool {
  return needsSelection(ctx, copy ? 'Copy' : 'Move', () => {
    let base: Pt | null = null;
    let made = 0;
    const t: Tool = {
      title: copy ? 'Copy' : 'Move',
      done: false,
      prompt: () => (!base ? 'Base point (the point you move by)' : copy ? `Where the base point goes (or @dx,dy); each click makes another copy${made ? `, ${made} so far` : ''}; Done ends` : 'Where the base point goes (or @dx,dy)'),
      want: () => ({ point: true }),
      base: () => base,
      point(p) {
        if (!base) {
          base = p;
          return;
        }
        const by = sub(p, base);
        if (copy) {
          applyToSelection(ctx, s => moveShape(strip(s as Ent), by), true);
          made++;
        } else {
          applyToSelection(ctx, s => moveShape(strip(s as Ent), by), false);
          t.done = true;
        }
      },
      enter: () => false,
      preview: c => (base ? shiftedSelection(ctx, s => moveShape(strip(s as Ent), sub(c, base!))) : []),
    };
    return t;
  });
}

function keepWord(state: { keep: boolean }): (w: string) => boolean {
  return w => {
    if (w !== 'c') return false;
    state.keep = !state.keep;
    return true;
  };
}
const keepText = (state: { keep: boolean }) => ` (C: keep the original, now ${state.keep ? 'on' : 'off'})`;

function rotateTool(ctx: ToolCtx): Tool {
  return needsSelection(ctx, 'Rotate', () => {
    const state = { keep: false };
    const angleOfGiven = (g: Given, c: Pt) => (g.kind === 'number' ? deg(g.v) : angleOf(sub(ptOf(g)!, c)));
    return stepTool(ctx, {
      title: 'Rotate',
      steps: [{ prompt: 'Centre of rotation', want: { point: true } }, { prompt: 'Angle in degrees (anticlockwise; minus for clockwise), or click to set it', want: { number: true, point: true } }],
      word: keepWord(state),
      promptExtra: () => keepText(state),
      preview: (g, c) => (g.length ? shiftedSelection(ctx, s => rotateShape(strip(s as Ent), ptOf(g[0])!, angleOfGiven({ kind: 'point', p: c }, ptOf(g[0])!))) : []),
      make(g) {
        const c = ptOf(g[0])!;
        const a = angleOfGiven(g[1], c);
        applyToSelection(ctx, s => rotateShape(strip(s as Ent), c, a), state.keep);
        return true;
      },
    });
  });
}

function mirrorTool(ctx: ToolCtx): Tool {
  return needsSelection(ctx, 'Mirror', () => {
    const state = { keep: true };
    return stepTool(ctx, {
      title: 'Mirror',
      steps: [{ prompt: 'First point on the mirror line', want: { point: true } }, { prompt: 'Second point on the mirror line', want: { point: true } }],
      word: keepWord(state),
      promptExtra: () => keepText(state),
      preview: (g, c) => (g.length && dist(ptOf(g[0])!, c) > 1e-12 ? shiftedSelection(ctx, s => mirrorShape(strip(s as Ent), ptOf(g[0])!, c)) : []),
      make(g) {
        const a = ptOf(g[0])!;
        const b = ptOf(g[1])!;
        if (dist(a, b) < 1e-12) return fail(ctx, 'The two points of the mirror line are the same.');
        applyToSelection(ctx, s => mirrorShape(strip(s as Ent), a, b), state.keep);
        return true;
      },
    });
  });
}

function scaleTool(ctx: ToolCtx): Tool {
  return needsSelection(ctx, 'Scale', () => {
    const state = { keep: false };
    return stepTool(ctx, {
      title: 'Scale',
      steps: [{ prompt: 'Base point (stays where it is)', want: { point: true } }, { prompt: 'Scale factor (2 doubles the size, 0.5 halves it)', want: { number: true } }],
      word: keepWord(state),
      promptExtra: () => keepText(state),
      make(g) {
        const c = ptOf(g[0])!;
        const k = (g[1] as { v: number }).v;
        if (!(k > 0)) return fail(ctx, 'The scale factor must be above 0.');
        applyToSelection(ctx, s => scaleShape(strip(s as Ent), c, k), state.keep);
        return true;
      },
    });
  });
}

function arrayLineTool(ctx: ToolCtx): Tool {
  return needsSelection(ctx, 'Copy along a line', () => stepTool(ctx, {
    title: 'Copy along a line',
    steps: [{ prompt: 'Base point', want: { point: true } }, { prompt: 'Where the first copy goes (sets the spacing and direction)', want: { point: true } }, { prompt: 'How many in all, the original included', want: { number: true } }],
    preview: (g, c) => (g.length === 1 ? shiftedSelection(ctx, s => moveShape(strip(s as Ent), sub(c, ptOf(g[0])!))) : []),
    make(g) {
      const n = (g[2] as { v: number }).v;
      if (!Number.isInteger(n) || n < 2 || n > 10000) return fail(ctx, 'How many in all: a whole number from 2 to 10000.');
      const step = sub(ptOf(g[1])!, ptOf(g[0])!);
      const added: Array<{ shape: Shape; layer: string }> = [];
      for (let i = 1; i < n; i++) for (const e of ctx.selection()) added.push({ shape: moveShape(strip(e), mul(step, i)), layer: e.layer });
      ctx.change([], added);
      return true;
    },
  }));
}

function arrayPolarTool(ctx: ToolCtx): Tool {
  return needsSelection(ctx, 'Copy round a centre', () => {
    let waiting = false;
    const t: Tool = {
      title: 'Copy round a centre',
      done: false,
      prompt: () => (waiting ? 'Fill in the box' : 'Centre to copy round'),
      want: () => (waiting ? {} : { point: true }),
      base: () => null,
      point(c) {
        waiting = true;
        void ctx.askPolar().then(answer => {
          waiting = false;
          t.done = true;
          if (!answer) return ctx.finished();
          const sel = ctx.selection();
          const full = Math.abs(Math.abs(answer.angle) - 360) < 1e-9;
          const stepAngle = deg(answer.angle) / (full ? answer.count : answer.count - 1);
          const added: Array<{ shape: Shape; layer: string }> = [];
          for (let i = 1; i < answer.count; i++) {
            for (const e of sel) {
              const s = strip(e);
              const a = stepAngle * i;
              added.push({ shape: answer.rotate ? rotateShape(s, c, a) : moveShape(s, sub(rotatePt(centreOfShape(s), c, a), centreOfShape(s))), layer: e.layer });
            }
          }
          ctx.change([], added);
          ctx.finished();
        });
      },
      enter: () => false,
      preview: () => [],
    };
    return t;
  });
}

function centreOfShape(s: Shape): Pt {
  const b = boxOfShapes([s]);
  if (b) return P((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2);
  return s.type === 'xline' || s.type === 'point' ? s.p : P(0, 0);
}

// ---- CAD: trim, extend, break, fillet, chamfer, offset, geometries ------------------------------------------------

/** The fillet radius, chamfer distances and offset last used, kept while the program is open. */
export const SIZES = { r: 10, d1: 5, d2: 5, off: 5 };

const othersOf = (ctx: ToolCtx, e: Ent) => ctx.visible().filter(o => o.id !== e.id);
const picked = (g: Given) => g as { kind: 'pick'; e: Ent; at: Pt };
/** Replaces one item by what an edit made of it (nothing: it goes), as one step of undo. */
function replaceWith(ctx: ToolCtx, e: Ent, shapes: Shape[]): void {
  if (!shapes.length) ctx.change([], [], [e.id]);
  else ctx.change([{ id: e.id, shape: shapes[0] }], shapes.slice(1).map(shape => ({ shape, layer: e.layer })));
}
const notPoint = (e: Ent) => e.type !== 'point';
const lineArcPoly = (e: Ent) => e.type === 'line' || e.type === 'arc' || e.type === 'poly';

function trimTool(ctx: ToolCtx): Tool {
  return stepTool(ctx, {
    title: 'Trim',
    steps: [{ prompt: 'Click the part to cut away (it is cut back to the items crossing it; Done ends)', want: { pick: true }, filter: notPoint }],
    base: () => null,
    make(g) {
      const { e, at } = picked(g[0]);
      const r = trim(e, at, othersOf(ctx, e));
      if (typeof r === 'string') return fail(ctx, r);
      replaceWith(ctx, e, r);
      return true;
    },
    again: true,
  });
}

function extendTool(ctx: ToolCtx): Tool {
  return stepTool(ctx, {
    title: 'Extend',
    steps: [{ prompt: 'Click near the end to stretch (to the next item in its way; Done ends)', want: { pick: true }, filter: notPoint }],
    base: () => null,
    make(g) {
      const { e, at } = picked(g[0]);
      const r = extend(e, at, othersOf(ctx, e));
      if (typeof r === 'string') return fail(ctx, r);
      replaceWith(ctx, e, [r]);
      return true;
    },
    again: true,
  });
}

function breakTool(ctx: ToolCtx, between: boolean): Tool {
  const steps: Array<{ prompt: string; want: Want; filter?: (e: Ent) => boolean }> = [
    { prompt: 'Pick the item to break', want: { pick: true }, filter: notPoint },
    { prompt: between ? 'First break point' : 'Where to break it', want: { point: true } },
  ];
  if (between) steps.push({ prompt: 'Second break point (on a closed shape, the part anticlockwise or along from the first goes)', want: { point: true } });
  return stepTool(ctx, {
    title: between ? 'Break between two points' : 'Break at a point',
    steps,
    base: g => ptOf(g[1]),
    make(g) {
      const { e } = picked(g[0]);
      const r = between ? breakBetween(e, ptOf(g[1])!, ptOf(g[2])!) : breakAt(e, ptOf(g[1])!);
      if (typeof r === 'string') return fail(ctx, r);
      replaceWith(ctx, e, r);
      return true;
    },
    again: true,
  });
}

/** Fillet or chamfer between two picks: two lines or arcs, or two sides of one polyline. */
function cornerTool(ctx: ToolCtx, kind: 'fillet' | 'chamfer'): Tool {
  const isFillet = kind === 'fillet';
  const sizeSteps = isFillet
    ? [{ prompt: `Radius (Enter: ${SIZES.r}; 0 makes a sharp corner)`, want: { number: true }, dflt: () => SIZES.r }]
    : [{ prompt: `Distance along the first line (Enter: ${SIZES.d1})`, want: { number: true }, dflt: () => SIZES.d1 },
      { prompt: 'Distance along the second (Enter: the same)', want: { number: true }, dflt: () => SIZES.d1 }];
  const k = sizeSteps.length;
  return stepTool(ctx, {
    title: isFillet ? 'Fillet' : 'Chamfer',
    steps: [...sizeSteps,
      { prompt: 'Pick the first line or arc (or a side of a polyline), on the part to keep', want: { pick: true }, filter: lineArcPoly },
      { prompt: 'Pick the second, on the part to keep (Done ends)', want: { pick: true }, filter: lineArcPoly }],
    base: () => null,
    make(g) {
      if (isFillet) {
        if (!((g[0] as { v: number }).v >= 0)) return fail(ctx, 'The radius must be 0 or more.');
        SIZES.r = (g[0] as { v: number }).v;
      } else {
        SIZES.d1 = (g[0] as { v: number }).v;
        SIZES.d2 = (g[1] as { v: number }).v;
      }
      const a = picked(g[k]);
      const b = picked(g[k + 1]);
      if (a.e.id === b.e.id) {
        if (a.e.type !== 'poly') return fail(ctx, 'Pick two different items (or two sides of one polyline).');
        const corner = cornerBetween(a.e, a.at, b.at);
        if (corner === null) return fail(ctx, 'Pick two sides of the polyline that meet at a corner.');
        const r = polyCorners(a.e, isFillet ? { round: SIZES.r } : { cut: [SIZES.d1, SIZES.d2] }, corner);
        if (!r.done) return fail(ctx, isFillet ? 'That corner cannot be rounded: its sides are too short for the radius, or one is round.' : 'That corner cannot be cut: its sides are too short, or one is round.');
        replaceWith(ctx, a.e, [r.shape]);
        return true;
      }
      if (a.e.type === 'poly' || b.e.type === 'poly') return fail(ctx, 'Between two separate items, pick lines or arcs. For a polyline, pick two of its own sides (or explode it first).');
      const r = isFillet ? fillet(a.e, a.at, b.e, b.at, SIZES.r) : chamfer(a.e, a.at, b.e, b.at, SIZES.d1, SIZES.d2);
      if (typeof r === 'string') return fail(ctx, r);
      const changed: Array<{ id: number; shape: Shape }> = [];
      const removed: number[] = [];
      for (const [e, s] of [[a.e, r.first], [b.e, r.second]] as Array<[Ent, Shape | null]>) {
        if (s) changed.push({ id: e.id, shape: s });
        else removed.push(e.id);
      }
      ctx.change(changed, r.added ? [{ shape: r.added, layer: a.e.layer }] : [], removed);
      return true;
    },
    keep: k,
  });
}

function allCornersTool(ctx: ToolCtx, kind: 'fillet' | 'chamfer'): Tool {
  const isFillet = kind === 'fillet';
  const sizeSteps = isFillet
    ? [{ prompt: `Radius (Enter: ${SIZES.r})`, want: { number: true }, dflt: () => SIZES.r }]
    : [{ prompt: `Distance along the side coming in (Enter: ${SIZES.d1})`, want: { number: true }, dflt: () => SIZES.d1 },
      { prompt: 'Distance along the side going out (Enter: the same)', want: { number: true }, dflt: () => SIZES.d1 }];
  const k = sizeSteps.length;
  return stepTool(ctx, {
    title: isFillet ? 'Fillet every corner of a polyline' : 'Chamfer every corner of a polyline',
    steps: [...sizeSteps, { prompt: 'Pick the polyline (Done ends)', want: { pick: true }, filter: e => e.type === 'poly' }],
    base: () => null,
    make(g) {
      const a = (g[0] as { v: number }).v;
      const b = isFillet ? a : (g[1] as { v: number }).v;
      if (!(a > 0) || !(b > 0)) return fail(ctx, 'The size must be above 0.');
      if (isFillet) SIZES.r = a;
      else {
        SIZES.d1 = a;
        SIZES.d2 = b;
      }
      const e = picked(g[k]).e as Extract<Ent, { type: 'poly' }>;
      const r = polyCorners(e, isFillet ? { round: a } : { cut: [a, b] });
      if (!r.done) return fail(ctx, 'No corner could be done: the sides are too short, or are round.');
      replaceWith(ctx, e, [r.shape]);
      ctx.say(`${r.done} corner${r.done === 1 ? '' : 's'} done${r.skipped ? `; ${r.skipped} left as they were (too short, or next to a round side)` : ''}.`);
      return true;
    },
    keep: k,
  });
}

function offsetTool(ctx: ToolCtx): Tool {
  return stepTool(ctx, {
    title: 'Offset',
    steps: [
      { prompt: `Distance (Enter: ${SIZES.off})`, want: { number: true }, dflt: () => SIZES.off },
      { prompt: 'Pick the item to offset (Done ends)', want: { pick: true }, filter: notPoint },
      { prompt: 'Click the side the copy goes on', want: { point: true } },
    ],
    base: () => null,
    preview: (g, c) => {
      if (g.length < 2) return [];
      const r = offset(picked(g[1]).e, (g[0] as { v: number }).v, c);
      return typeof r === 'string' ? [] : [r];
    },
    previewFrom: 2,
    make(g) {
      SIZES.off = (g[0] as { v: number }).v;
      const { e } = picked(g[1]);
      const r = offset(e, SIZES.off, ptOf(g[2])!);
      if (typeof r === 'string') return fail(ctx, r);
      ctx.change([], [{ shape: r, layer: e.layer }]);
      return true;
    },
    keep: 1,
  });
}

/** A one-pick change to a polyline (close, reverse), or a pick and a point (the start point). */
function geometryTool(ctx: ToolCtx, kind: 'close' | 'reverse' | 'start'): Tool {
  const titles = { close: 'Close a geometry', reverse: 'Reverse the direction', start: 'Set the start point' };
  const steps: Array<{ prompt: string; want: Want; filter?: (e: Ent) => boolean }> = [
    { prompt: kind === 'start' ? 'Pick the closed polyline' : 'Pick the polyline (or a line)', want: { pick: true }, filter: e => e.type === 'poly' || (kind === 'reverse' && e.type === 'line') },
  ];
  if (kind === 'start') steps.push({ prompt: 'Click where it should start (a corner, or a point along a side)', want: { point: true } });
  return stepTool(ctx, {
    title: titles[kind],
    steps,
    base: () => null,
    make(g) {
      const { e } = picked(g[0]);
      const r = kind === 'close' ? closeShape(e) : kind === 'reverse' ? reverse(e) : setStart(e, ptOf(g[1])!);
      if (typeof r === 'string') return fail(ctx, r);
      replaceWith(ctx, e, [r]);
      return true;
    },
    again: true,
  });
}

function angleTool(ctx: ToolCtx): Tool {
  return stepTool(ctx, {
    title: 'Measure an angle',
    steps: [{ prompt: 'The corner (where the two arms meet)', want: { point: true } }, { prompt: 'A point on the first arm', want: { point: true } }, { prompt: 'A point on the second arm', want: { point: true } }],
    preview: (g, c) => (g.length === 1 ? [line(ptOf(g[0])!, c)] : [line(ptOf(g[0])!, ptOf(g[1])!), line(ptOf(g[0])!, c)]),
    make(g) {
      const v = ptOf(g[0])!;
      const a = sub(ptOf(g[1])!, v);
      const b = sub(ptOf(g[2])!, v);
      if (Math.hypot(a.x, a.y) < 1e-12 || Math.hypot(b.x, b.y) < 1e-12) return fail(ctx, 'An arm has no length.');
      const inside = Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y)))));
      const ccw = normAngle(angleOf(b) - angleOf(a));
      ctx.say(`Angle ${ctx.fmt((inside * 180) / Math.PI)}° (anticlockwise from the first arm: ${ctx.fmt((ccw * 180) / Math.PI)}°)`);
      return true;
    },
    again: true,
  });
}

function areaTool(ctx: ToolCtx): Tool {
  return stepTool(ctx, {
    title: 'Area and perimeter',
    steps: [{ prompt: 'Pick a closed shape (a closed polyline, a circle, an ellipse)', want: { pick: true } }],
    base: () => null,
    make(g) {
      const { e } = picked(g[0]);
      const a = areaOf(e);
      if (a === null) return fail(ctx, 'That shape is not closed, so it has no area. Join its parts into one closed geometry first (CAD > Join).');
      const perimeter = piecesOf(e).reduce((t, p) => t + pieceLength(p), 0);
      ctx.say(`Area ${ctx.fmt(a)}   perimeter ${ctx.fmt(perimeter)}`);
      return true;
    },
    again: true,
  });
}

// ---- Utils and View -----------------------------------------------------------------------------------------------

function measureTool(ctx: ToolCtx): Tool {
  return stepTool(ctx, {
    title: 'Measure',
    steps: [{ prompt: 'First point', want: { point: true } }, { prompt: 'Second point', want: { point: true } }],
    preview: (g, c) => [line(ptOf(g[0])!, c)],
    make(g) {
      const a = ptOf(g[0])!;
      const b = ptOf(g[1])!;
      const d = sub(b, a);
      ctx.say(`Distance ${ctx.fmt(dist(a, b))}   across ${ctx.fmt(d.x)}   up ${ctx.fmt(d.y)}   angle ${ctx.fmt((normAngle(angleOf(d)) * 180) / Math.PI)}°`);
      return true;
    },
    again: true,
  });
}

function listTool(ctx: ToolCtx): Tool {
  return stepTool(ctx, {
    title: 'List an item',
    steps: [{ prompt: 'Pick an item to see its numbers', want: { pick: true } }],
    base: () => null,
    make(g) {
      ctx.list((g[0] as { e: Ent }).e);
      return true;
    },
    again: true,
  });
}

function chainTool(ctx: ToolCtx): Tool {
  return stepTool(ctx, {
    title: 'Select a chain',
    steps: [{ prompt: 'Pick one item of the chain (items joined end to end)', want: { pick: true } }],
    base: () => null,
    make(g) {
      const chain = chainFrom(ctx.ents(), (g[0] as { e: Ent }).e);
      ctx.select(chain.map(e => e.id));
      ctx.say(`${chain.length} item${chain.length === 1 ? '' : 's'} in the chain chosen.`);
      return true;
    },
  });
}

function zoomWindowTool(ctx: ToolCtx): Tool {
  return stepTool(ctx, {
    title: 'Zoom to a window',
    steps: [{ prompt: 'First corner of the area to show', want: { point: true } }, { prompt: 'Other corner', want: { point: true } }],
    preview: (g, c) => [rectangle(ptOf(g[0])!, c)].filter(Boolean) as Shape[],
    make(g) {
      const a = ptOf(g[0])!;
      const b = ptOf(g[1])!;
      if (Math.abs(a.x - b.x) < 1e-12 && Math.abs(a.y - b.y) < 1e-12) return fail(ctx, 'Drag out an area, not a point.');
      ctx.zoomTo(a, b);
      return true;
    },
  });
}

export const TOOLS = {
  line: { name: 'Line', make: lineTool },
  polyline: { name: 'Polyline', make: polylineTool },
  rect: { name: 'Rectangle: two corners', make: rectTool },
  'rect-centre': { name: 'Rectangle: centre and size', make: rectCentreTool },
  'rect-round': { name: 'Rectangle: rounded corners', make: rectRoundTool },
  'circle-cr': { name: 'Circle: centre and radius', make: (c: ToolCtx) => circleCentreTool(c, false) },
  'circle-cd': { name: 'Circle: centre and diameter', make: (c: ToolCtx) => circleCentreTool(c, true) },
  'circle-2p': { name: 'Circle: two points across', make: circle2Tool },
  'circle-3p': { name: 'Circle: three points', make: circle3Tool },
  'circle-ttr': { name: 'Circle: touching two items, radius', make: (c: ToolCtx) => ttrTool(c, false) },
  'circle-ttt': { name: 'Circle: touching three items', make: tttTool },
  'arc-3p': { name: 'Arc: three points', make: arc3Tool },
  'arc-cse': { name: 'Arc: centre, start, end', make: arcCseTool },
  'arc-ser': { name: 'Arc: start, end, radius', make: arcSerTool },
  'arc-ttr': { name: 'Arc: touching two items, radius', make: (c: ToolCtx) => ttrTool(c, true) },
  ellipse: { name: 'Ellipse', make: ellipseTool },
  'polygon-in': { name: 'Polygon: corners on a circle', make: (c: ToolCtx) => polygonTool(c, true) },
  'polygon-out': { name: 'Polygon: sides touching a circle', make: (c: ToolCtx) => polygonTool(c, false) },
  slot: { name: 'Slot', make: slotTool },
  spline: { name: 'Curve through points', make: splineTool },
  point: { name: 'Point', make: pointTool },
  'xline-h': { name: 'Construction line: horizontal', make: (c: ToolCtx) => xlineTool(c, 'h') },
  'xline-v': { name: 'Construction line: vertical', make: (c: ToolCtx) => xlineTool(c, 'v') },
  'xline-angle': { name: 'Construction line: at an angle', make: (c: ToolCtx) => xlineTool(c, 'angle') },
  'xline-2p': { name: 'Construction line: through two points', make: (c: ToolCtx) => xlineTool(c, '2p') },
  'xline-offset': { name: 'Construction line: at a distance from a line', make: xlineOffsetTool },
  'tan-point': { name: 'Line from a point, touching a curve', make: tangentFromPointTool },
  'tan-two': { name: 'Line touching two arcs or circles', make: tangentTwoTool },
  move: { name: 'Move', make: (c: ToolCtx) => moveTool(c, false) },
  copy: { name: 'Copy', make: (c: ToolCtx) => moveTool(c, true) },
  rotate: { name: 'Rotate', make: rotateTool },
  mirror: { name: 'Mirror', make: mirrorTool },
  scale: { name: 'Scale', make: scaleTool },
  'array-line': { name: 'Copy along a line', make: arrayLineTool },
  'array-polar': { name: 'Copy round a centre', make: arrayPolarTool },
  measure: { name: 'Measure', make: measureTool },
  list: { name: 'List an item', make: listTool },
  chain: { name: 'Select a chain', make: chainTool },
  trim: { name: 'Trim', make: trimTool },
  extend: { name: 'Extend', make: extendTool },
  'break-point': { name: 'Break at a point', make: (c: ToolCtx) => breakTool(c, false) },
  'break-two': { name: 'Break between two points', make: (c: ToolCtx) => breakTool(c, true) },
  fillet: { name: 'Fillet', make: (c: ToolCtx) => cornerTool(c, 'fillet') },
  'fillet-all': { name: 'Fillet every corner of a polyline', make: (c: ToolCtx) => allCornersTool(c, 'fillet') },
  chamfer: { name: 'Chamfer', make: (c: ToolCtx) => cornerTool(c, 'chamfer') },
  'chamfer-all': { name: 'Chamfer every corner of a polyline', make: (c: ToolCtx) => allCornersTool(c, 'chamfer') },
  offset: { name: 'Offset', make: offsetTool },
  close: { name: 'Close a geometry', make: (c: ToolCtx) => geometryTool(c, 'close') },
  reverse: { name: 'Reverse the direction', make: (c: ToolCtx) => geometryTool(c, 'reverse') },
  start: { name: 'Set the start point', make: (c: ToolCtx) => geometryTool(c, 'start') },
  'measure-angle': { name: 'Measure an angle', make: angleTool },
  area: { name: 'Area and perimeter', make: areaTool },
  'zoom-window': { name: 'Zoom to a window', make: zoomWindowTool },
} satisfies Record<string, { name: string; make: (ctx: ToolCtx) => Tool }>;

export type ToolId = keyof typeof TOOLS;

/** Words that start a tool from the command line (the tool's name, or a short form). */
export const COMMAND_WORDS: Record<string, ToolId> = {
  line: 'line', l: 'line', pline: 'polyline', polyline: 'polyline', pl: 'polyline', rect: 'rect', rectangle: 'rect', rec: 'rect',
  circle: 'circle-cr', c: 'circle-cr', arc: 'arc-3p', a: 'arc-3p', ellipse: 'ellipse', el: 'ellipse', polygon: 'polygon-in', pol: 'polygon-in',
  slot: 'slot', spline: 'spline', spl: 'spline', curve: 'spline', point: 'point', po: 'point', xline: 'xline-2p', xl: 'xline-2p',
  move: 'move', m: 'move', copy: 'copy', co: 'copy', cp: 'copy', rotate: 'rotate', ro: 'rotate', mirror: 'mirror', mi: 'mirror',
  scale: 'scale', sc: 'scale', measure: 'measure', dist: 'measure', di: 'measure', list: 'list', li: 'list', zoom: 'zoom-window', z: 'zoom-window',
  trim: 'trim', tr: 'trim', extend: 'extend', ex: 'extend', break: 'break-point', br: 'break-point', fillet: 'fillet', f: 'fillet',
  chamfer: 'chamfer', cha: 'chamfer', offset: 'offset', o: 'offset', area: 'area', angle: 'measure-angle',
};
