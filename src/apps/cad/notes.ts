// Text and dimensions in KerfLine: what each is made of when drawn (the letters' strokes, a dimension's lines,
// arrowheads and number), the number a dimension shows, and the box round a text for picking it. They are notes on
// the drawing, not part of the shape: snaps, trim, extend and offset leave them alone.
import { lineWidth, letterAdvances, letterStrokes, textStrokes, LINE_SPACING, type Align } from './font.ts';
import { P, TAU, add, angleOf, dirOf, dist, dot, mid, mul, normAngle, perp, polar, rotatePt, sub, unit, type Piece, type Pt } from './geom.ts';

export type DimKind = 'linear' | 'aligned' | 'radius' | 'diameter' | 'angle' | 'leader';

/**
 * A text: its first line's foot at p (left end, middle or right end, by `align`), h high (the capitals), turned by
 * `angle`. With `arc`, its letters follow a circle round c instead: centred, started or ended at p, reading
 * clockwise along the outside (cw) or anticlockwise along the inside.
 */
export interface TextShape {
  type: 'text';
  p: Pt;
  text: string;
  h: number;
  angle: number;
  align: Align;
  arc?: { c: Pt; r: number; cw: boolean };
}

/**
 * A dimension. linear / aligned: pts = [first point, second point, where the dimension line goes], measured along
 * `dir` (0 across, a quarter turn up, or the slope of an aligned one). radius / diameter: [centre, a point on the
 * circle, where the number goes]. angle: [corner, a point on the first arm, a point on the second (anticlockwise
 * from the first), where the arc goes]. leader: [arrow tip, ..., where the words go]. `text`: empty for the measured
 * size; otherwise the words shown, with <> standing for the measured size.
 */
export interface DimShape {
  type: 'dim';
  kind: DimKind;
  pts: Pt[];
  dir: number;
  h: number;
  arrow: number;
  /** Decimal places for the measured size. */
  dp: number;
  text: string;
}

/** Sizes for new text and dimensions, kept with the drawing. */
export interface NoteStyle {
  textH: number;
  dimH: number;
  arrow: number;
  dp: number;
}

export const defaultStyle = (inch: boolean): NoteStyle => (inch ? { textH: 0.2, dimH: 0.125, arrow: 0.1, dp: 3 } : { textH: 5, dimH: 3.5, arrow: 2.5, dp: 2 });

/** A piece of text in a note: its words, foot point, height, turn and how it lines up on the foot point. */
export interface NoteText {
  text: string;
  p: Pt;
  h: number;
  angle: number;
  align: Align;
}

/** Turned half a turn when it would read upside down (so text is never upside down). */
export function readable(angle: number): number {
  const a = normAngle(angle);
  return a > Math.PI / 2 + 1e-9 && a <= (3 * Math.PI) / 2 + 1e-9 ? normAngle(a - Math.PI) : a;
}

// ---- Text --------------------------------------------------------------------------------------------------------

/** Each letter of a text that follows an arc: the letter, its foot-left corner and its turn. */
export function arcLetters(t: TextShape): Array<{ ch: string; at: Pt; angle: number }> {
  if (!t.arc) return [];
  const { c, r, cw } = t.arc;
  const line = t.text.replace(/\n/g, ' ');
  const adv = letterAdvances(line, t.h);
  const total = lineWidth(line, t.h);
  const start = t.align === 'left' ? 0 : t.align === 'centre' ? -total / 2 : -total;
  const a0 = angleOf(sub(t.p, c));
  const out: Array<{ ch: string; at: Pt; angle: number }> = [];
  let s = start;
  [...line].forEach((ch, i) => {
    // Each letter stands square to the circle at its own middle.
    const w = lineWidth(ch, t.h);
    const th = cw ? a0 - (s + w / 2) / r : a0 + (s + w / 2) / r;
    const angle = cw ? th - Math.PI / 2 : th + Math.PI / 2;
    out.push({ ch, at: sub(polar(c, r, th), mul(dirOf(angle), w / 2)), angle });
    s += adv[i];
  });
  return out;
}

function strokesToPieces(strokes: Pt[][]): Piece[] {
  const out: Piece[] = [];
  for (const s of strokes) {
    if (s.length === 2 && dist(s[0], s[1]) < 1e-12) {
      out.push({ k: 'seg', a: s[0], b: s[1] });
      continue;
    }
    for (let i = 1; i < s.length; i++) if (dist(s[i - 1], s[i]) > 1e-12) out.push({ k: 'seg', a: s[i - 1], b: s[i] });
  }
  return out;
}

/** The strokes of a text as lists of points (what a cutter would follow). */
export function textShapeStrokes(t: TextShape): Pt[][] {
  if (!t.arc) return textStrokes(t.text, t.p, t.h, t.angle, t.align);
  return arcLetters(t).flatMap(l => letterStrokes(l.ch, l.at, t.h, l.angle));
}

/** How far q is from a text's box (0 inside it): a text is picked anywhere over its letters, not only on a stroke. */
export function distToText(t: TextShape, q: Pt): number {
  if (t.arc) {
    let best = Infinity;
    for (const l of arcLetters(t)) best = Math.min(best, distToBox(rotatePt(q, l.at, -l.angle), l.at, 0, lineWidth(l.ch, t.h), -0.33 * t.h, t.h));
    return best;
  }
  const lines = t.text.split('\n');
  const w = Math.max(...lines.map(l => lineWidth(l, t.h)));
  const x0 = t.align === 'left' ? 0 : t.align === 'centre' ? -w / 2 : -w;
  return distToBox(rotatePt(q, t.p, -t.angle), t.p, x0, x0 + w, -(lines.length - 1) * LINE_SPACING * t.h - 0.33 * t.h, t.h);
}

function distToBox(q: Pt, o: Pt, x0: number, x1: number, y0: number, y1: number): number {
  const x = q.x - o.x;
  const y = q.y - o.y;
  const dx = Math.max(x0 - x, 0, x - x1);
  const dy = Math.max(y0 - y, 0, y - y1);
  return Math.hypot(dx, dy);
}

// ---- Dimensions --------------------------------------------------------------------------------------------------

/** The size a dimension measures: a length, a radius, a diameter, or an angle in degrees. */
export function dimValue(d: DimShape): number {
  const [a, b, c] = d.pts;
  switch (d.kind) {
    case 'linear':
    case 'aligned':
      return Math.abs(dot(sub(b, a), dirOf(d.dir)));
    case 'radius':
      return dist(a, b);
    case 'diameter':
      return 2 * dist(a, b);
    case 'angle':
      return (normAngle(angleOf(sub(c, a)) - angleOf(sub(b, a))) * 180) / Math.PI;
    case 'leader':
      return 0;
  }
}

/** A number to `dp` places, with no zeros left trailing (600, 12.5). */
export function dimNumber(v: number, dp: number): string {
  const s = (Math.abs(v) < 0.5 * 10 ** -dp ? 0 : v).toFixed(Math.max(0, Math.min(8, dp)));
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** The words a dimension shows. */
export function dimLabel(d: DimShape): string {
  if (d.kind === 'leader') return d.text;
  const n = dimNumber(dimValue(d), d.dp);
  const measured = d.kind === 'radius' ? `R${n}` : d.kind === 'diameter' ? `Ø${n}` : d.kind === 'angle' ? `${n}°` : n;
  return d.text ? d.text.replace(/<>/g, measured) : measured;
}

/** An arrowhead: a closed triangle with its tip at `tip`, pointing along `dir`. */
function arrowHead(tip: Pt, dir: Pt, size: number): Piece[] {
  const u = unit(dir);
  const n = perp(u);
  const base = sub(tip, mul(u, size));
  const l = add(base, mul(n, size / 6));
  const r = sub(base, mul(n, size / 6));
  return [{ k: 'seg', a: tip, b: l }, { k: 'seg', a: l, b: r }, { k: 'seg', a: r, b: tip }];
}

const seg = (a: Pt, b: Pt): Piece => ({ k: 'seg', a, b });

/** What a dimension is drawn with: its lines and arcs (arrowheads included) and its words. */
export function dimParts(d: DimShape): { pieces: Piece[]; texts: NoteText[] } {
  const pieces: Piece[] = [];
  const texts: NoteText[] = [];
  const label = dimLabel(d);
  const gap = d.arrow * 0.4;
  const over = d.arrow * 0.6;
  switch (d.kind) {
    case 'linear':
    case 'aligned': {
      const [a, b, at] = d.pts;
      const u = dirOf(d.dir);
      const n = perp(u);
      const a2 = add(a, mul(n, dot(sub(at, a), n)));
      const b2 = add(b, mul(n, dot(sub(at, b), n)));
      for (const [p, p2] of [[a, a2], [b, b2]] as const) {
        const v = sub(p2, p);
        const l = Math.hypot(v.x, v.y);
        if (l > gap) pieces.push(seg(add(p, mul(unit(v), gap)), add(p2, mul(unit(v), over))));
      }
      const span = dist(a2, b2);
      if (span < 1e-12) break;
      const out = unit(sub(a2, b2));
      if (span >= 2.2 * d.arrow) {
        pieces.push(seg(a2, b2), ...arrowHead(a2, out, d.arrow), ...arrowHead(b2, mul(out, -1), d.arrow));
      } else {
        // Too short for the arrows inside: they point in from outside.
        pieces.push(seg(add(a2, mul(out, 2 * d.arrow)), add(b2, mul(out, -2 * d.arrow))), ...arrowHead(a2, mul(out, -1), d.arrow), ...arrowHead(b2, out, d.arrow));
      }
      const angle = readable(d.dir);
      texts.push({ text: label, p: add(mid(a2, b2), mul(perp(dirOf(angle)), d.h * 0.5)), h: d.h, angle, align: 'centre' });
      break;
    }
    case 'radius':
    case 'diameter': {
      const [c, p, at] = d.pts;
      const r = dist(c, p);
      const toward = dist(at, c) > 1e-12 ? unit(sub(at, c)) : unit(sub(p, c));
      const q = add(c, mul(toward, r));
      const outside = dist(at, c) > r + 1e-9;
      if (d.kind === 'radius') {
        if (outside) pieces.push(seg(q, at), ...arrowHead(q, mul(toward, -1), d.arrow));
        else pieces.push(seg(c, q), ...arrowHead(q, toward, d.arrow));
      } else {
        const q2 = sub(c, mul(toward, r));
        pieces.push(seg(q2, q), ...arrowHead(q, toward, d.arrow), ...arrowHead(q2, mul(toward, -1), d.arrow));
        if (outside) pieces.push(seg(q, at));
      }
      const side = toward.x >= -1e-9 ? 1 : -1;
      texts.push({ text: label, p: add(at, P(side * d.h * 0.4, d.h * 0.3)), h: d.h, angle: 0, align: side > 0 ? 'left' : 'right' });
      break;
    }
    case 'angle': {
      const [v, A, B, at] = d.pts;
      const R = dist(at, v);
      if (R < 1e-12) break;
      const a0 = angleOf(sub(A, v));
      const a1 = a0 + normAngle(angleOf(sub(B, v)) - a0);
      pieces.push({ k: 'arc', c: v, r: R, a0, a1: a1 > a0 ? a1 : a0 + TAU });
      for (const [p, a] of [[A, a0], [B, a1]] as const) {
        const reach = dist(p, v);
        if (R > reach + gap) pieces.push(seg(polar(v, reach + gap, a), polar(v, R + over, a)));
      }
      pieces.push(...arrowHead(polar(v, R, a0), P(Math.sin(a0), -Math.cos(a0)), d.arrow), ...arrowHead(polar(v, R, a1), P(-Math.sin(a1), Math.cos(a1)), d.arrow));
      const am = (a0 + a1) / 2;
      const along = am - Math.PI / 2;
      const angle = readable(along);
      const flipped = Math.abs(normAngle(angle - along)) > 1e-6;
      texts.push({ text: label, p: polar(v, R + d.h * (flipped ? 1.5 : 0.5), am), h: d.h, angle, align: 'centre' });
      break;
    }
    case 'leader': {
      const pts = d.pts;
      if (pts.length < 2) break;
      for (let i = 1; i < pts.length; i++) pieces.push(seg(pts[i - 1], pts[i]));
      pieces.push(...arrowHead(pts[0], sub(pts[0], pts[1]), d.arrow));
      const last = pts[pts.length - 1];
      const side = last.x >= pts[pts.length - 2].x ? 1 : -1;
      texts.push({ text: label, p: add(last, P(side * d.h * 0.5, -d.h / 2)), h: d.h, angle: 0, align: side > 0 ? 'left' : 'right' });
      break;
    }
  }
  return { pieces, texts };
}

/** Everything a text or dimension is drawn with, as pieces (letters as short straight strokes). */
export function notePieces(s: TextShape | DimShape): Piece[] {
  if (s.type === 'text') return strokesToPieces(textShapeStrokes(s));
  const { pieces, texts } = dimParts(s);
  return [...pieces, ...texts.flatMap(t => strokesToPieces(textStrokes(t.text, t.p, t.h, t.angle, t.align)))];
}

/** The two arms of an angle between two lines, chosen by where the arc is put: [start arm, end arm] (anticlockwise). */
export function angleArms(v: Pt, d1: Pt, d2: Pt, at: Pt): [Pt, Pt] {
  const rays = [d1, d2, mul(d1, -1), mul(d2, -1)].map(d => ({ d, a: normAngle(angleOf(d)) })).sort((x, y) => x.a - y.a);
  const want = normAngle(angleOf(sub(at, v)));
  for (let i = 0; i < 4; i++) {
    const s = rays[i];
    const e = rays[(i + 1) % 4];
    const span = normAngle(e.a - s.a);
    if (normAngle(want - s.a) <= span) return [s.d, e.d];
  }
  return [rays[0].d, rays[1].d];
}
