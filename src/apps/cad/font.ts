// CAD Draft's own letters: a single-line font (each letter drawn as strokes, as an engraving cutter would follow
// them), so text looks the same on screen, in a print and when it is turned into lines for machining. Letters are
// drawn on a grid where capitals are 6 high (small letters 4, tails down to -2); a text's height is its capitals'
// height, as in DXF. Each stroke is a list of points; "@cx,cy,rx,ry,a0,a1" adds the points of an elliptical arc
// from angle a0 to a1 (degrees; a1 below a0 runs clockwise).
import { P, add, mul, rotatePt, type Pt } from './geom.ts';

const CAP = 6;
/** The gap after each letter, in grid units. */
const GAP = 1.4;
/** The distance from one line's foot to the next one's, in text heights. */
export const LINE_SPACING = 1.6;

const SOURCE: Record<string, [number, string]> = {
  ' ': [2.4, ''],
  A: [4, '0,0 2,6 4,0; 0.7,2 3.3,2'],
  B: [4, '0,0 0,6 2.6,6 @2.6,4.5,1.4,1.5,90,-90 0,3; 2.7,3 @2.7,1.5,1.3,1.5,90,-90 0,0'],
  C: [4, '@2,3,2,3,45,315'],
  D: [4, '0,0 0,6 1.5,6 @1.5,3,2.5,3,90,-90 0,0'],
  E: [4, '4,6 0,6 0,0 4,0; 0,3 3,3'],
  F: [4, '4,6 0,6 0,0; 0,3 3,3'],
  G: [4, '@2,3,2,3,45,360 2.2,3'],
  H: [4, '0,0 0,6; 4,0 4,6; 0,3 4,3'],
  I: [0, '0,0 0,6'],
  J: [4, '4,6 4,1.5 @2,1.5,2,1.5,0,-180'],
  K: [4, '0,0 0,6; 4,6 0,2; 1.4,3.4 4,0'],
  L: [4, '0,6 0,0 4,0'],
  M: [5, '0,0 0,6 2.5,2 5,6 5,0'],
  N: [4, '0,0 0,6 4,0 4,6'],
  O: [4, '@2,3,2,3,0,360'],
  P: [4, '0,0 0,6 2.5,6 @2.5,4.5,1.5,1.5,90,-90 0,3'],
  Q: [4, '@2,3,2,3,0,360; 2.6,1.2 4.2,-0.4'],
  R: [4, '0,0 0,6 2.5,6 @2.5,4.5,1.5,1.5,90,-90 0,3; 2,3 4,0'],
  S: [4, '@2,4.5,2,1.5,20,270 @2,1.5,2,1.5,90,-160'],
  T: [4, '0,6 4,6; 2,6 2,0'],
  U: [4, '0,6 0,2 @2,2,2,2,180,360 4,6'],
  V: [4, '0,6 2,0 4,6'],
  W: [6, '0,6 1.5,0 3,4 4.5,0 6,6'],
  X: [4, '0,0 4,6; 0,6 4,0'],
  Y: [4, '0,6 2,3 4,6; 2,3 2,0'],
  Z: [4, '0,6 4,6 0,0 4,0'],
  a: [4, '@2,2,2,2,0,360; 4,4 4,0'],
  b: [4, '0,6 0,0; @2,2,2,2,0,360'],
  c: [4, '@2,2,2,2,45,315'],
  d: [4, '4,6 4,0; @2,2,2,2,0,360'],
  e: [4, '0,2 4,2 @2,2,2,2,0,310'],
  f: [3, '3,5.8 @2.2,5,0.8,1,70,180 1.4,0; 0.2,4 2.8,4'],
  g: [4, '@2,2,2,2,0,360; 4,4 4,-0.5 @2,-0.5,2,1.5,0,-160'],
  h: [4, '0,6 0,0; 0,2 @2,2,2,2,180,0 4,0'],
  i: [0, '0,0 0,4; 0,5.2 0,5.6'],
  j: [2, '2,4 2,-1 @1,-1,1,1,0,-180; 2,5.2 2,5.6'],
  k: [4, '0,0 0,6; 3.6,4 0,1.4; 1.2,2.2 3.8,0'],
  l: [0, '0,6 0,0'],
  m: [6, '0,0 0,4; 0,3 @1.5,3,1.5,1,180,0 3,0; 3,3 @4.5,3,1.5,1,180,0 6,0'],
  n: [4, '0,0 0,4; 0,2.5 @2,2.5,2,1.5,180,0 4,0'],
  o: [4, '@2,2,2,2,0,360'],
  p: [4, '0,4 0,-2; @2,2,2,2,0,360'],
  q: [4, '4,4 4,-2; @2,2,2,2,0,360'],
  r: [3, '0,0 0,4; 0,2.5 @2,2.5,2,1.5,180,60'],
  s: [4, '@2,3,1.8,1,15,270 @2,1,1.8,1,90,-165'],
  t: [3, '1,6 1,0.8 @2,0.8,1,0.8,180,300; 0,4 3,4'],
  u: [4, '0,4 0,2 @2,2,2,2,180,360; 4,4 4,0'],
  v: [4, '0,4 2,0 4,4'],
  w: [6, '0,4 1.5,0 3,3 4.5,0 6,4'],
  x: [4, '0,0 4,4; 0,4 4,0'],
  y: [4, '0,4 2,0; 4,4 1,-2'],
  z: [4, '0,4 4,4 0,0 4,0'],
  0: [4, '@2,3,2,3,0,360'],
  1: [2, '0,5 2,6 2,0'],
  2: [4, '@2,4.3,2,1.7,160,-30 0,0 4,0'],
  3: [4, '@2,4.6,1.8,1.4,150,-90 @2,1.6,2,1.6,90,-150'],
  4: [4, '3,0 3,6 0,1.6 4,1.6'],
  5: [4, '3.8,6 0.4,6 0.2,3.2 @2,1.9,2,1.9,130,-150'],
  6: [4, '@2,3,2,3,70,200; @2,1.9,2,1.9,0,360'],
  7: [4, '0,6 4,6 1.5,0'],
  8: [4, '@2,4.6,1.7,1.4,0,360; @2,1.6,2,1.6,0,360'],
  9: [4, '@2,4.1,2,1.9,0,360; 4,4.1 @2,3,2,3,0,-110'],
  '.': [0, '0,0 0,0.4'],
  ',': [0.6, '0.6,0.4 0.6,0 0,-1'],
  ':': [0, '0,0 0,0.4; 0,3 0,3.4'],
  ';': [0.6, '0.6,3 0.6,3.4; 0.6,0.4 0.6,0 0,-1'],
  '-': [3, '0,2.5 3,2.5'],
  '+': [4, '0,2.5 4,2.5; 2,0.5 2,4.5'],
  '=': [4, '0,1.8 4,1.8; 0,3.4 4,3.4'],
  '/': [3, '0,-0.5 3,6.5'],
  '\\': [3, '0,6.5 3,-0.5'],
  '(': [0.8, '@2.5,3,2.5,4,135,225'],
  ')': [0.8, '@-1.77,3,2.5,4,45,-45'],
  '[': [1.5, '1.5,6.5 0,6.5 0,-0.5 1.5,-0.5'],
  ']': [1.5, '0,6.5 1.5,6.5 1.5,-0.5 0,-0.5'],
  '{': [2, '2,6.5 1,6 1,3.5 0,3 1,2.5 1,0 2,-0.5'],
  '}': [2, '0,6.5 1,6 1,3.5 2,3 1,2.5 1,0 0,-0.5'],
  _: [4, '0,-1 4,-1'],
  "'": [0, '0,6 0,4.6'],
  '"': [1.2, '0,6 0,4.6; 1.2,6 1.2,4.6'],
  '`': [0.8, '0,6 0.8,5'],
  '!': [0, '0,6 0,1.6; 0,0 0,0.4'],
  '?': [4, '@2,4.5,2,1.5,160,-60 2,1.6; 2,0 2,0.4'],
  '#': [4, '1.2,0 1.8,6; 2.6,0 3.2,6; 0,2 4,2; 0,4 4,4'],
  '%': [4, '0,0 4,6; @0.8,5.2,0.8,0.8,0,360; @3.2,0.8,0.8,0.8,0,360'],
  '&': [4, '4,0 1,4.4 @1.8,5,0.9,1,210,-30 0.6,1.8 @1.8,1.2,1.3,1.2,150,330 4,2.6'],
  '*': [3, '1.5,2 1.5,5; 0.2,2.75 2.8,4.25; 0.2,4.25 2.8,2.75'],
  '<': [3, '3,5 0,2.5 3,0'],
  '>': [3, '0,5 3,2.5 0,0'],
  '^': [3, '0,4 1.5,6 3,4'],
  '~': [4, '@1,3,1,0.6,180,0 @3,3,1,0.6,180,360'],
  '|': [0, '0,-1 0,7'],
  '@': [5, '@2.6,3,1,1.2,0,360; 3.6,4.2 3.6,2.2 @4.3,2.2,0.7,0.8,180,360 @2.5,3,2.5,3,0,330'],
  $: [4, '@2,4.5,2,1.5,20,270 @2,1.5,2,1.5,90,-160; 2,6.6 2,-0.6'],
  '°': [1.8, '@0.9,5.1,0.9,0.9,0,360'],
  'Ø': [5, '@2.5,3,2.5,3,0,360; 0,-0.5 5,6.5'],
  'ø': [4, '@2,2,2,2,0,360; 0,-0.4 4,4.4'],
  '±': [4, '0,3.5 4,3.5; 2,1.5 2,5.5; 0,0.5 4,0.5'],
  '×': [3, '0,1 3,4; 0,4 3,1'],
  '²': [2, '@1,5.3,1,0.7,160,-30 0,3.6 2,3.6'],
  '³': [2, '@1,5.4,0.9,0.6,150,-90 @1,4.2,1,0.6,90,-150'],
  'µ': [4, '0,4 0,-2; 0,2 @2,2,2,2,180,360; 4,4 4,0'],
  '£': [4, '3.6,5.4 @2.4,4.8,1.2,1.2,30,180 1.2,0; 0,0 4,0; 0,3 2.8,3'],
  '€': [4, '@2.4,3,1.6,3,45,315; 0,3.6 2.8,3.6; 0,2.4 2.8,2.4'],
};

/** A letter's strokes on the grid, and how far on the pen moves after it. */
interface Glyph {
  strokes: Pt[][];
  advance: number;
}

function parse([w, src]: [number, string]): Glyph {
  const strokes: Pt[][] = [];
  for (const part of src.split(';')) {
    const pts: Pt[] = [];
    for (const tok of part.trim().split(/\s+/)) {
      if (!tok) continue;
      if (tok.startsWith('@')) {
        const [cx, cy, rx, ry, a0, a1] = tok.slice(1).split(',').map(Number);
        const steps = Math.max(4, Math.ceil(Math.abs(a1 - a0) / 15));
        for (let i = 0; i <= steps; i++) {
          const a = ((a0 + ((a1 - a0) * i) / steps) * Math.PI) / 180;
          pts.push(P(cx + rx * Math.cos(a), cy + ry * Math.sin(a)));
        }
      } else {
        const [x, y] = tok.split(',').map(Number);
        pts.push(P(x, y));
      }
    }
    if (pts.length) strokes.push(pts.length === 1 ? [pts[0], pts[0]] : pts);
  }
  return { strokes, advance: w + GAP };
}

const GLYPHS = new Map<string, Glyph>();
/** A letter the font does not have is drawn as a box, so it is never silently dropped. */
const MISSING: Glyph = parse([3, '0,0 3,0 3,6 0,6 0,0']);

function glyph(ch: string): Glyph {
  let g = GLYPHS.get(ch);
  if (!g) {
    const src = SOURCE[ch];
    g = src ? parse(src) : MISSING;
    GLYPHS.set(ch, g);
  }
  return g;
}

/** Does the font have this letter (else it is drawn as a box)? */
export const hasLetter = (ch: string): boolean => ch in SOURCE;

/** How long one line of text is at height h (from the start of the first letter to the end of the last). */
export function lineWidth(line: string, h: number): number {
  const chars = [...line];
  if (!chars.length) return 0;
  let w = 0;
  for (const ch of chars) w += glyph(ch).advance;
  return ((w - GAP) * h) / CAP;
}

/** Each letter's own width (for spacing letters round an arc). */
export function letterAdvances(line: string, h: number): number[] {
  return [...line].map(ch => (glyph(ch).advance * h) / CAP);
}

/** The strokes of one letter, its foot-left corner at `at`, turned by `angle` (radians), h high. */
export function letterStrokes(ch: string, at: Pt, h: number, angle: number): Pt[][] {
  const k = h / CAP;
  return glyph(ch).strokes.map(s => s.map(q => rotatePt(add(at, mul(q, k)), at, angle)));
}

export type Align = 'left' | 'centre' | 'right';

/**
 * The strokes of a text, its lines' foot at p (the first line's), lined up left, centre or right of p, turned by
 * `angle`: each stroke a list of points in drawing units.
 */
export function textStrokes(text: string, p: Pt, h: number, angle: number, align: Align): Pt[][] {
  const out: Pt[][] = [];
  const k = h / CAP;
  text.split('\n').forEach((line, row) => {
    const w = lineWidth(line, h);
    let x = align === 'left' ? 0 : align === 'centre' ? -w / 2 : -w;
    const y = -row * LINE_SPACING * h;
    for (const ch of line) {
      const g = glyph(ch);
      for (const s of g.strokes) out.push(s.map(q => rotatePt(P(p.x + x + q.x * k, p.y + y + q.y * k), p, angle)));
      x += g.advance * k;
    }
  });
  return out;
}
