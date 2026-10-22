// DXF, the hand-over format: CAD Draft writes AutoCAD Release 12 DXF (the oldest, plainest kind, which CAM programs
// of every age read) and reads DXF of any release saved as text. Written: layers with their colours and line types,
// lines, arcs, circles, polylines with their arcs as bulges, points, and text; ellipses and curves become polylines
// of arcs within a few thousandths of a millimetre (R12 has no ellipse or spline); dimensions become plain lines and
// text. Read: lines, arcs, circles, polylines (old and light), ellipses, splines (as arcs), points, text and
// paragraph text, construction lines, and blocks and dimensions taken apart into their pieces; anything else is
// counted in a "left out" list, never dropped silently.
import { moveShape, mirrorShape, rotateShape, scaleShape } from './edit.ts';
import { textStrokes, type Align } from './font.ts';
import {
  P, TAU, add, angleOf, at, circumcircle, cross, dirOf, dist, domain, isFull, mul, normAngle, perp, rotatePt, sub, unit,
  type Box, type Piece, type Pt,
} from './geom.ts';
import {
  COLOUR_NAMES, CONSTRUCTION, CadProblem, DIMENSIONS, GEOMETRY, MAX_TEXT_LENGTH, TEXT, TYPE_NAMES, newDrawing, outlineOf, piecesOf, shapeBox,
  type Drawing, type Ent, type Layer, type LineType, type Shape, type Units,
} from './model.ts';
import { arcLetters, dimParts, defaultStyle, type NoteText, type TextShape } from './notes.ts';

// ---- Arcs for curves -----------------------------------------------------------------------------------------------

/** How far a polyline of arcs may stray from the ellipse or curve it stands for. */
export const arcTolerance = (u: Units): number => (u === 'mm' ? 0.005 : 0.0002);

/**
 * A curve (any point for a parameter from t0 to t1) as a polyline of arcs: each span an arc through its two ends
 * and the curve's point half way, split until no point of the curve is further than `tol` from it.
 */
export function curveToBulges(f: (t: number) => Pt, t0: number, t1: number, tol: number, minParts = 1): { pts: Pt[]; bulges: number[] } {
  const pts: Pt[] = [f(t0)];
  const bulges: number[] = [];
  const fit = (a: number, b: number, depth: number): void => {
    const p0 = f(a);
    const p1 = f(b);
    const pm = f((a + b) / 2);
    const cc = circumcircle(p0, pm, p1);
    let bulge = 0;
    let dev = 0;
    const chord = dist(p0, p1);
    if (!cc || cc.r > 1e4 * Math.max(chord, 1e-9)) {
      for (let k = 1; k < 8; k++) dev = Math.max(dev, distToSeg(f(a + ((b - a) * k) / 8), p0, p1));
    } else {
      const a0 = angleOf(sub(p0, cc.c));
      const a1 = angleOf(sub(p1, cc.c));
      const left = cross(sub(pm, p0), sub(p1, pm)) > 0;
      const sweep = left ? normAngle(a1 - a0) : -normAngle(a0 - a1);
      bulge = Math.tan(sweep / 4);
      for (let k = 1; k < 8; k++) if (k !== 4) dev = Math.max(dev, Math.abs(dist(f(a + ((b - a) * k) / 8), cc.c) - cc.r));
    }
    if (dev > tol && depth < 24 && b - a > 1e-12) {
      fit(a, (a + b) / 2, depth + 1);
      fit((a + b) / 2, b, depth + 1);
      return;
    }
    pts.push(p1);
    bulges.push(bulge);
  };
  for (let i = 0; i < minParts; i++) fit(t0 + ((t1 - t0) * i) / minParts, t0 + ((t1 - t0) * (i + 1)) / minParts, 0);
  return { pts, bulges };
}

function distToSeg(q: Pt, a: Pt, b: Pt): number {
  const d = sub(b, a);
  const l2 = d.x * d.x + d.y * d.y;
  if (l2 < 1e-24) return dist(q, a);
  const t = Math.max(0, Math.min(1, ((q.x - a.x) * d.x + (q.y - a.y) * d.y) / l2));
  return dist(q, add(a, mul(d, t)));
}

/** Pieces joined end to end as one polyline of lines and arcs (ellipse and curve pieces turned into arcs). */
function piecesToPoly(pieces: Piece[], closed: boolean, tol: number): { pts: Pt[]; bulges: number[]; closed: boolean } {
  const pts: Pt[] = [];
  const bulges: number[] = [];
  for (const p of pieces) {
    let part: { pts: Pt[]; bulges: number[] };
    if (p.k === 'seg') part = { pts: [p.a, p.b], bulges: [0] };
    else if (p.k === 'arc') part = { pts: [at(p, p.a0), at(p, p.a1)], bulges: [Math.tan((p.a1 - p.a0) / 4)] };
    else {
      const [lo, hi] = domain(p)!;
      part = curveToBulges(t => at(p, t), lo, hi, tol, p.k === 'ell' ? Math.max(1, Math.ceil(((hi - lo) / TAU) * 8)) : 2);
    }
    if (!pts.length) pts.push(part.pts[0]);
    for (let i = 1; i < part.pts.length; i++) {
      pts.push(part.pts[i]);
      bulges.push(part.bulges[i - 1]);
    }
  }
  if (closed && pts.length > 2 && dist(pts[0], pts[pts.length - 1]) < 1e-9) pts.pop();
  else if (closed) bulges.push(0);
  if (!closed) bulges.push(0);
  return { pts, bulges, closed };
}

// ---- Colours ---------------------------------------------------------------------------------------------------------

/** The AutoCAD colour number for each named layer colour. */
const ACI_OF: Record<string, number> = {
  '#ff4040': 1, '#ffe040': 2, '#60ff60': 3, '#40e0ff': 4, '#4080ff': 5, '#e040e0': 6, '#ffffff': 7, '#c0c0c0': 9,
  '#ff8040': 30, '#ff6090': 241, '#c0a0ff': 181, '#a0ffd0': 111,
};

function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The colour of an AutoCAD colour number (1 to 255), near enough to name it. */
export function aciRgb(i: number): [number, number, number] {
  const basic: Record<number, [number, number, number]> = {
    1: [255, 0, 0], 2: [255, 255, 0], 3: [0, 255, 0], 4: [0, 255, 255], 5: [0, 0, 255], 6: [255, 0, 255], 7: [255, 255, 255], 8: [128, 128, 128], 9: [192, 192, 192],
  };
  if (basic[i]) return basic[i];
  if (i >= 250 && i <= 255) {
    const g = [51, 91, 132, 173, 214, 255][i - 250];
    return [g, g, g];
  }
  if (i < 10 || i > 249) return [255, 255, 255];
  const hue = (Math.floor(i / 10) - 1) * 15;
  const shade = i % 10;
  const v = [1, 1, 0.65, 0.65, 0.5, 0.5, 0.3, 0.3, 0.15, 0.15][shade];
  const s = shade % 2 ? 0.5 : 1;
  const c = v * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x] : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** The nearest of CAD Draft's named colours. */
export function nearestNamed(rgb: [number, number, number]): string {
  let best = '#ffffff';
  let bestD = Infinity;
  for (const hex of Object.keys(COLOUR_NAMES)) {
    const [r, g, b] = hexRgb(hex);
    const d = (r - rgb[0]) ** 2 + (g - rgb[1]) ** 2 + (b - rgb[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = hex;
    }
  }
  return best;
}

function aciOf(hex: string): number {
  if (ACI_OF[hex]) return ACI_OF[hex];
  const rgb = hexRgb(hex);
  let best = 7;
  let bestD = Infinity;
  for (let i = 1; i <= 9; i++) {
    const [r, g, b] = aciRgb(i);
    const d = (r - rgb[0]) ** 2 + (g - rgb[1]) ** 2 + (b - rgb[2]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

// ---- Writing ---------------------------------------------------------------------------------------------------------

export interface DxfOptions {
  /** Text as TEXT items (the CAM program's own letters), or as lines in CAD Draft's letters. */
  textAsLines: boolean;
  /** Construction lines as long lines across the drawing (R12 has no endless line). */
  construction: boolean;
  /** Items on hidden layers too. */
  hidden: boolean;
}

export const DXF_LINE_TYPES: Record<LineType, { name: string; text: string; mm: number[] }> = {
  continuous: { name: 'CONTINUOUS', text: 'Solid line', mm: [] },
  dashed: { name: 'DASHED', text: '__ __ __ __', mm: [12.7, -6.35] },
  centre: { name: 'CENTER', text: '____ _ ____ _', mm: [31.75, -6.35, 6.35, -6.35] },
  hidden: { name: 'HIDDEN', text: '_ _ _ _ _ _', mm: [6.35, -3.175] },
  dotted: { name: 'DOT', text: '. . . . . .', mm: [0, -6.35] },
};

/** A number as DXF writes it: no exponent, at most ten decimal places. */
export function dxfNum(v: number): string {
  if (!Number.isFinite(v)) return '0.0';
  // Above this, JavaScript writes an exponent, which an R12 reader refuses.
  if (Math.abs(v) >= 1e15) throw new CadProblem('A number in the drawing is too big for a DXF (more than 1,000,000,000,000,000). Something drawn very far away, or scaled hugely, is the likely cause: Zoom fit shows it.');
  if (Math.abs(v) < 5e-11) return '0.0';
  const s = v.toFixed(10).replace(/0+$/, '');
  return s.endsWith('.') ? `${s}0` : s;
}

/** A layer name R12 accepts: capitals, figures, $ _ and -, at most 31 long. */
export function r12Name(name: string): string {
  const n = name.toUpperCase().replace(/[^A-Z0-9$_-]/g, '_').slice(0, 31);
  return n || 'LAYER';
}

/** Text with the signs R12 writes as codes (degree, diameter, plus-minus); a letter outside Windows' Western set becomes ?. */
export function r12Text(s: string): string {
  return s
    // %%% is one % sign, so a %% typed in the words is written as two of them.
    .replace(/%%/g, '%%%%%%')
    .replace(/°/g, '%%d')
    .replace(/[Øø⌀]/g, '%%c')
    .replace(/±/g, '%%p')
    .replace(/[\r\n]+/g, ' ');
}

/** Windows' Western letters (cp1252): what an R12 file is read as. */
function cp1252(s: string): Uint8Array {
  const extra: Record<string, number> = {
    '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e,
    '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f,
  };
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80 || (c >= 0xa0 && c <= 0xff)) out.push(c);
    else out.push(extra[ch] ?? 0x3f);
  }
  return new Uint8Array(out);
}

export interface DxfWritten {
  text: string;
  bytes: Uint8Array;
  /** What the reader should know: how many items went in, what became arcs, what was left out. */
  notes: string[];
  count: number;
}

/** The drawing as an R12 DXF file. */
export function writeDxf(d: Drawing, o: DxfOptions): DxfWritten {
  const out: string[] = [];
  const tag = (code: number, value: string | number) => {
    out.push(String(code), typeof value === 'number' ? (Number.isInteger(value) && code >= 60 && code < 100 ? String(value) : dxfNum(value)) : value);
  };
  const tol = arcTolerance(d.units);
  const k = d.units === 'mm' ? 1 : 1 / 25.4;
  const layerOn = new Map(d.layers.map(l => [l.name, l.on]));
  const ents = d.ents.filter(e => (o.hidden || layerOn.get(e.layer)) && (o.construction || e.type !== 'xline'));
  const leftHidden = d.ents.filter(e => !o.hidden && !layerOn.get(e.layer)).length;
  const leftXlines = d.ents.filter(e => (o.hidden || layerOn.get(e.layer)) && !o.construction && e.type === 'xline').length;

  // Layer names R12 accepts, kept apart if two come out the same.
  const names = new Map<string, string>();
  const used = new Set<string>(['0']);
  for (const l of d.layers) {
    if (l.name === '0') {
      names.set('0', '0');
      continue;
    }
    let n = r12Name(l.name);
    for (let i = 2; used.has(n); i++) n = `${r12Name(l.name).slice(0, 28)}_${i}`;
    used.add(n);
    names.set(l.name, n);
  }
  // Beyond capitals, a name R12 cannot hold (a space, a bracket, too long) is changed: those are listed.
  const renamed = d.layers.filter(l => names.get(l.name) !== l.name.toUpperCase()).map(l => `${l.name} → ${names.get(l.name)}`);

  // The box round everything (construction lines are drawn across it).
  let box: Box | null = null;
  for (const e of ents) {
    const b = shapeBox(e);
    if (b) box = box ? { x0: Math.min(box.x0, b.x0), y0: Math.min(box.y0, b.y0), x1: Math.max(box.x1, b.x1), y1: Math.max(box.y1, b.y1) } : b;
  }
  const ext = box ?? { x0: 0, y0: 0, x1: 0, y1: 0 };

  tag(0, 'SECTION');
  tag(2, 'HEADER');
  tag(9, '$ACADVER');
  tag(1, 'AC1009');
  // R12 has no units of its own. An inch drawing says so the way later DXFs do ($INSUNITS 1), so it opens again in
  // inches here and in programs that read it; a millimetre drawing writes nothing extra (millimetres is what a DXF
  // that does not say is read as).
  if (d.units === 'inch') {
    tag(9, '$INSUNITS');
    tag(70, 1);
  }
  tag(9, '$INSBASE');
  tag(10, 0);
  tag(20, 0);
  tag(30, 0);
  tag(9, '$EXTMIN');
  tag(10, ext.x0);
  tag(20, ext.y0);
  tag(30, 0);
  tag(9, '$EXTMAX');
  tag(10, ext.x1);
  tag(20, ext.y1);
  tag(30, 0);
  tag(9, '$LIMMIN');
  tag(10, ext.x0);
  tag(20, ext.y0);
  tag(9, '$LIMMAX');
  tag(10, ext.x1);
  tag(20, ext.y1);
  tag(9, '$TEXTSTYLE');
  tag(7, 'STANDARD');
  tag(9, '$CLAYER');
  tag(8, names.get(d.current) ?? '0');
  tag(0, 'ENDSEC');

  tag(0, 'SECTION');
  tag(2, 'TABLES');
  tag(0, 'TABLE');
  tag(2, 'LTYPE');
  tag(70, Object.keys(DXF_LINE_TYPES).length);
  for (const lt of Object.values(DXF_LINE_TYPES)) {
    tag(0, 'LTYPE');
    tag(2, lt.name);
    tag(70, 0);
    tag(3, lt.text);
    tag(72, 65);
    tag(73, lt.mm.length);
    tag(40, lt.mm.reduce((t, v) => t + Math.abs(v), 0) * k);
    for (const v of lt.mm) tag(49, v * k);
  }
  tag(0, 'ENDTAB');
  tag(0, 'TABLE');
  tag(2, 'LAYER');
  const ownZero = d.layers.find(l => l.name === '0');
  tag(70, d.layers.length + (ownZero ? 0 : 1));
  const layerRow = (name: string, colour: number, on: boolean, locked: boolean, lt: string) => {
    tag(0, 'LAYER');
    tag(2, name);
    tag(70, locked ? 4 : 0);
    tag(62, on ? colour : -colour);
    tag(6, lt);
  };
  if (!ownZero) layerRow('0', 7, true, false, 'CONTINUOUS');
  for (const l of d.layers) layerRow(names.get(l.name)!, aciOf(l.colour), l.on, l.locked, DXF_LINE_TYPES[l.lineType].name);
  tag(0, 'ENDTAB');
  tag(0, 'TABLE');
  tag(2, 'STYLE');
  tag(70, 1);
  tag(0, 'STYLE');
  tag(2, 'STANDARD');
  tag(70, 0);
  tag(40, 0);
  tag(41, 1);
  tag(50, 0);
  tag(71, 0);
  tag(42, d.style.textH);
  tag(3, 'txt');
  tag(4, '');
  tag(0, 'ENDTAB');
  tag(0, 'ENDSEC');

  tag(0, 'SECTION');
  tag(2, 'BLOCKS');
  tag(0, 'ENDSEC');

  tag(0, 'SECTION');
  tag(2, 'ENTITIES');
  let count = 0;
  let curves = 0;
  const line = (layer: string, a: Pt, b: Pt) => {
    tag(0, 'LINE');
    tag(8, layer);
    tag(10, a.x);
    tag(20, a.y);
    tag(30, 0);
    tag(11, b.x);
    tag(21, b.y);
    tag(31, 0);
    count++;
  };
  const poly = (layer: string, pts: Pt[], bulges: number[], closed: boolean) => {
    if (pts.length < 2) return;
    tag(0, 'POLYLINE');
    tag(8, layer);
    tag(66, 1);
    tag(10, 0);
    tag(20, 0);
    tag(30, 0);
    tag(70, closed ? 1 : 0);
    pts.forEach((p, i) => {
      tag(0, 'VERTEX');
      tag(8, layer);
      tag(10, p.x);
      tag(20, p.y);
      tag(30, 0);
      if (Math.abs(bulges[i] ?? 0) > 1e-12) tag(42, bulges[i]);
    });
    tag(0, 'SEQEND');
    tag(8, layer);
    count++;
  };
  const arc = (layer: string, c: Pt, r: number, a0: number, a1: number) => {
    if (isFull(a0, a1)) {
      tag(0, 'CIRCLE');
      tag(8, layer);
      tag(10, c.x);
      tag(20, c.y);
      tag(30, 0);
      tag(40, r);
    } else {
      tag(0, 'ARC');
      tag(8, layer);
      tag(10, c.x);
      tag(20, c.y);
      tag(30, 0);
      tag(40, r);
      tag(50, (normAngle(a0) * 180) / Math.PI);
      tag(51, (normAngle(a1) * 180) / Math.PI);
    }
    count++;
  };
  const strokes = (layer: string, list: Pt[][]) => {
    for (const s of list) {
      if (s.length === 2) line(layer, s[0], s[1]);
      else poly(layer, s, s.map(() => 0), false);
    }
  };
  const text = (layer: string, t: NoteText) => {
    if (o.textAsLines) return strokes(layer, textStrokes(t.text, t.p, t.h, t.angle, t.align));
    t.text.split('\n').forEach((row, i) => {
      if (!row.trim()) return;
      const foot = rotatePt(P(t.p.x, t.p.y - i * 1.6 * t.h), t.p, t.angle);
      tag(0, 'TEXT');
      tag(8, layer);
      tag(10, foot.x);
      tag(20, foot.y);
      tag(30, 0);
      tag(40, t.h);
      tag(1, r12Text(row));
      if (Math.abs(t.angle) > 1e-12) tag(50, (normAngle(t.angle) * 180) / Math.PI);
      if (t.align !== 'left') {
        tag(72, t.align === 'centre' ? 1 : 2);
        tag(11, foot.x);
        tag(21, foot.y);
        tag(31, 0);
      }
      count++;
    });
  };
  const textShape = (layer: string, t: TextShape) => {
    if (!t.arc) return text(layer, { text: t.text, p: t.p, h: t.h, angle: t.angle, align: t.align });
    for (const l of arcLetters(t)) if (l.ch.trim()) text(layer, { text: l.ch, p: l.at, h: t.h, angle: l.angle, align: 'left' as Align });
  };

  for (const e of ents) {
    const layer = names.get(e.layer) ?? '0';
    switch (e.type) {
      case 'line':
        line(layer, e.a, e.b);
        break;
      case 'arc':
      case 'circle': {
        const [p] = piecesOf(e) as Array<Extract<Piece, { k: 'arc' }>>;
        arc(layer, p.c, p.r, p.a0, p.a1);
        break;
      }
      case 'poly':
        poly(layer, e.pts, e.bulges, e.closed);
        break;
      case 'ellipse':
      case 'spline': {
        const closed = e.type === 'ellipse' ? isFull(e.t0, e.t1) : e.closed;
        const pl = piecesToPoly(piecesOf(e), closed, tol);
        poly(layer, pl.pts, pl.bulges, pl.closed);
        curves++;
        break;
      }
      case 'point':
        tag(0, 'POINT');
        tag(8, layer);
        tag(10, e.p.x);
        tag(20, e.p.y);
        tag(30, 0);
        count++;
        break;
      case 'xline': {
        const reach = Math.max(ext.x1 - ext.x0, ext.y1 - ext.y0, 100 * k) * 1.5 + dist(e.p, P((ext.x0 + ext.x1) / 2, (ext.y0 + ext.y1) / 2));
        line(layer, sub(e.p, mul(e.d, reach)), add(e.p, mul(e.d, reach)));
        break;
      }
      case 'text':
        textShape(layer, e);
        break;
      case 'dim': {
        const parts = dimParts(e);
        for (const p of parts.pieces) {
          if (p.k === 'seg') line(layer, p.a, p.b);
          else if (p.k === 'arc') arc(layer, p.c, p.r, p.a0, p.a1);
        }
        for (const t of parts.texts) text(layer, t);
        break;
      }
    }
  }
  tag(0, 'ENDSEC');
  tag(0, 'EOF');

  const notes: string[] = [`${count} item${count === 1 ? '' : 's'} written (AutoCAD R12 DXF, ${d.units === 'mm' ? 'millimetres' : 'inches'}: 600 in the drawing is 600 in the file).`];
  if (curves) notes.push(`${curves} ellipse${curves === 1 ? '' : 's'} or curve${curves === 1 ? '' : 's'} written as polylines of arcs, each within ${tol} ${d.units === 'mm' ? 'mm' : 'in'} of the true shape.`);
  if (d.ents.some(e => e.type === 'dim')) notes.push('Dimensions are written as plain lines and text.');
  if (d.ents.some(e => e.type === 'text') && !o.textAsLines) notes.push('Text is written as text: the other program draws it in its own letters, so its width may differ a little.');
  if (leftHidden) notes.push(`${leftHidden} item${leftHidden === 1 ? '' : 's'} on hidden layers left out.`);
  if (leftXlines) notes.push(`${leftXlines} construction line${leftXlines === 1 ? '' : 's'} left out.`);
  if (d.layers.some(l => /[a-z]/.test(l.name))) notes.push('Layer names are written in capitals (R12 has no small letters).');
  if (renamed.length) notes.push(`Layer names R12 cannot hold were changed: ${renamed.join(', ')}.`);
  const textOut = out.join('\r\n') + '\r\n';
  return { text: textOut, bytes: cp1252(textOut), notes, count };
}

// ---- Reading ---------------------------------------------------------------------------------------------------------

type Tags = Array<[number, string]>;

interface Rec {
  type: string;
  tags: Tags;
}

const get = (r: Rec, code: number): string | undefined => r.tags.find(t => t[0] === code)?.[1];
const num = (r: Rec, code: number, dflt = 0): number => {
  const v = get(r, code);
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : dflt;
};
const nums = (r: Rec, code: number): number[] => r.tags.filter(t => t[0] === code).map(t => Number(t[1])).filter(Number.isFinite);
const ptOf = (r: Rec, x: number, dflt = P(0, 0)): Pt => (get(r, x) === undefined ? dflt : P(num(r, x), num(r, x + 10)));

/** The words in a TEXT, with AutoCAD's codes turned back into the signs they stand for. */
export function decodeText(s: string): string {
  return s
    .replace(/\\U\+([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/%%([dDcCpP%]|[uUoOkK]|\d{3})/g, (_, c: string) => {
      const l = c.toLowerCase();
      if (l === 'd') return '°';
      if (l === 'c') return 'Ø';
      if (l === 'p') return '±';
      if (l === '%') return '%';
      if (/^\d{3}$/.test(c)) return String.fromCharCode(Number(c));
      return '';
    });
}

/** The words in a paragraph text (MTEXT) with its formatting codes taken out; \P is a new line. */
export function decodeMtext(s: string): string {
  let t = s.replace(/\\[ACcFfHhpQqTtWw][^;\\]*;/g, '');
  t = t.replace(/\\S([^;^#/]*)[\^#/]([^;]*);/g, '$1/$2');
  t = t.replace(/\\[LlOoKk]/g, '');
  t = t.replace(/\\P/g, '\n').replace(/\\~/g, ' ').replace(/\\N/g, '\n');
  t = t.replace(/\\\\/g, '\u0000').replace(/\\\{/g, '\u0001').replace(/\\\}/g, '\u0002');
  t = t.replace(/[{}]/g, '');
  t = t.replace(/\u0000/g, '\\').replace(/\u0001/g, '{').replace(/\u0002/g, '}');
  return decodeText(t);
}

const LEFT_OUT_NAMES: Record<string, string> = {
  HATCH: 'hatch fill', SOLID: 'filled triangle or square (SOLID)', TRACE: 'thick line (TRACE)', '3DFACE': '3D face', IMAGE: 'picture', WIPEOUT: 'wipeout',
  VIEWPORT: 'viewport', REGION: 'region', '3DSOLID': '3D solid', BODY: '3D body', MLINE: 'multiline', TOLERANCE: 'tolerance frame', OLE2FRAME: 'embedded object',
  ACAD_TABLE: 'table', ATTDEF: 'attribute definition', MESH: 'mesh', SURFACE: 'surface', HELIX: 'helix', MULTILEADER: 'multileader', MLEADER: 'multileader',
  SHAPE: 'shape symbol', ARCALIGNEDTEXT: 'text on an arc (AutoCAD Express)', UNDERLAY: 'underlay', PDFUNDERLAY: 'PDF underlay', DWFUNDERLAY: 'DWF underlay', DGNUNDERLAY: 'DGN underlay',
};

export interface DxfRead {
  drawing: Drawing;
  /** Lines for the report shown after opening. */
  report: string[];
  leftOut: number;
  /** Items whose height, thickness, own colour or own line type the drawing does not keep (all said in `report`). */
  changed: number;
}

interface Placed {
  shape: Shape;
  /** null: on the layer of the block's insert (an item on layer 0 inside a block). */
  layer: string | null;
}

const LINE_TYPE_OF = (name: string | undefined): LineType => {
  const n = (name ?? '').toUpperCase();
  if (n.startsWith('DASHED') || n.startsWith('DASH') || n.startsWith('PHANTOM') || n.startsWith('DIVIDE')) return 'dashed';
  if (n.startsWith('CENTER') || n.startsWith('CENTRE')) return 'centre';
  if (n.startsWith('HIDDEN')) return 'hidden';
  if (n.startsWith('DOT')) return 'dotted';
  return 'continuous';
};

const MAX_ITEMS = 200_000;

/** Reads a DXF file saved as text (any release). */
export function readDxf(bytes: Uint8Array): DxfRead {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 32));
  if (head.startsWith('AutoCAD Binary DXF')) throw new CadProblem('This is a binary DXF. Save it again as an ASCII (text) DXF in the program that made it, then open that.');
  if (/^AC10\d\d/.test(head)) throw new CadProblem('This is a DWG drawing, not a DXF. Save it as DXF in the program that made it (R12 or 2000 DXF is best), then open that.');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder('windows-1252').decode(bytes);
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r\n|\r|\n/);
  const tags: Tags = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i].trim());
    if (!Number.isInteger(code)) throw new CadProblem(`This file is not a DXF drawing (line ${i + 1} should be a group code number).`);
    const raw = lines[i + 1];
    tags.push([code, code === 1 || code === 3 ? raw.replace(/\s+$/, '') : raw.trim()]);
  }
  if (!tags.some(t => t[0] === 0 && t[1] === 'SECTION')) throw new CadProblem('This file is not a DXF drawing (it has no sections).');

  // Sections, each a list of records starting at a 0 tag.
  const sections = new Map<string, Rec[]>();
  let i = 0;
  while (i < tags.length) {
    if (tags[i][0] === 0 && tags[i][1] === 'SECTION' && tags[i + 1]?.[0] === 2) {
      const name = tags[i + 1][1].toUpperCase();
      i += 2;
      const recs: Rec[] = [];
      let cur: Rec | null = null;
      while (i < tags.length && !(tags[i][0] === 0 && tags[i][1] === 'ENDSEC')) {
        if (tags[i][0] === 0) {
          cur = { type: tags[i][1].toUpperCase(), tags: [] };
          recs.push(cur);
        } else if (cur) cur.tags.push(tags[i]);
        else recs.push({ type: '', tags: [tags[i]] });
        i++;
      }
      sections.set(name, recs);
    }
    i++;
  }

  // Units from the header.
  const header = sections.get('HEADER') ?? [];
  const headerTags = header.flatMap(r => r.tags);
  const hv = (name: string): string | undefined => {
    const at = headerTags.findIndex(t => t[0] === 9 && t[1] === name);
    return at >= 0 ? headerTags[at + 1]?.[1] : undefined;
  };
  const insUnits = Number(hv('$INSUNITS') ?? 0) || 0;
  let units: Units = 'mm';
  let k = 1;
  let unitsNote: string;
  switch (insUnits) {
    case 1:
      units = 'inch';
      unitsNote = 'Units: inches (as the file says).';
      break;
    case 2:
      units = 'inch';
      k = 12;
      unitsNote = 'Units: the file is in feet; read as inches (each size times 12).';
      break;
    case 4:
      unitsNote = 'Units: millimetres (as the file says).';
      break;
    case 5:
      k = 10;
      unitsNote = 'Units: the file is in centimetres; read as millimetres (each size times 10).';
      break;
    case 6:
      k = 1000;
      unitsNote = 'Units: the file is in metres; read as millimetres (each size times 1000).';
      break;
    case 14:
      k = 100;
      unitsNote = 'Units: the file is in decimetres; read as millimetres (each size times 100).';
      break;
    case 7:
      k = 1e6;
      unitsNote = 'Units: the file is in kilometres; read as millimetres (each size times 1,000,000).';
      break;
    case 9:
      units = 'inch';
      k = 0.001;
      unitsNote = 'Units: the file is in mils (thousandths of an inch); read as inches (each size divided by 1000).';
      break;
    case 10:
      units = 'inch';
      k = 36;
      unitsNote = 'Units: the file is in yards; read as inches (each size times 36).';
      break;
    case 3:
      units = 'inch';
      k = 63360;
      unitsNote = 'Units: the file is in miles; read as inches (each size times 63,360).';
      break;
    case 0:
      unitsNote = 'Units: the file does not say, so its numbers were read as millimetres (600 is 600 mm). If it was drawn in inches, Utils > Units > Inches with "Change the sizes too" off keeps the numbers.';
      break;
    default:
      unitsNote = `Units: the file gives unit number ${insUnits}, which CAD Draft does not know, so its numbers were read as millimetres. If they were not, Utils > Units with "Change the sizes too" off keeps the numbers.`;
  }

  // Layers.
  const layers: Layer[] = [];
  const tables = sections.get('TABLES') ?? [];
  for (const r of tables) {
    if (r.type !== 'LAYER') continue;
    const name = (get(r, 2) ?? '').trim().slice(0, 64);
    if (!name || layers.some(l => l.name === name)) continue;
    const colour = num(r, 62, 7);
    const flags = num(r, 70, 0);
    const trueColour = get(r, 420);
    const rgb: [number, number, number] = trueColour !== undefined ? [(Number(trueColour) >> 16) & 255, (Number(trueColour) >> 8) & 255, Number(trueColour) & 255] : aciRgb(Math.abs(colour) || 7);
    layers.push({ name, colour: nearestNamed(rgb), on: colour >= 0 && !(flags & 1), locked: !!(flags & 4), lineType: LINE_TYPE_OF(get(r, 6)) });
  }

  // Blocks: their base point and records.
  const blocks = new Map<string, { base: Pt; recs: Rec[] }>();
  let block: { name: string; base: Pt; recs: Rec[] } | null = null;
  for (const r of sections.get('BLOCKS') ?? []) {
    if (r.type === 'BLOCK') {
      block = { name: (get(r, 2) ?? '').toUpperCase(), base: ptOf(r, 10), recs: [] };
    } else if (r.type === 'ENDBLK') {
      if (block) blocks.set(block.name, { base: block.base, recs: block.recs });
      block = null;
    } else if (block) block.recs.push(r);
  }

  const leftOut = new Map<string, number>();
  const notes = new Set<string>();
  let total = 0;
  let curves = 0;
  let exploded = 0;
  let ownColours = 0;
  // Kept nowhere in a CAD Draft drawing, so said: a height off 0, a thickness, a line type of the item's own.
  let raised = 0;
  let thick = 0;
  let ownLineTypes = 0;
  const tol = arcTolerance(units);
  const expanded = new Map<string, Placed[]>();
  const counted = (map: Map<string, number>, key: string) => map.set(key, (map.get(key) ?? 0) + 1);
  const leave = (type: string) => counted(leftOut, LEFT_OUT_NAMES[type] ?? `${type.toLowerCase()}`);

  /** The extrusion of an item: 1 for the usual (looking down), -1 for one seen from below, 0 for anything tilted. */
  const facing = (r: Rec): number => {
    const z = num(r, 230, 1);
    if (Math.abs(num(r, 210)) > 1e-6 || Math.abs(num(r, 220)) > 1e-6) return 0;
    return z < 0 ? -1 : 1;
  };
  const flipX = (p: Pt, f: number) => (f < 0 ? P(-p.x, p.y) : p);

  /** The records of one section or block as shapes (blocks inside taken apart). */
  function convert(recs: Rec[], depth: number): Placed[] {
    const out: Placed[] = [];
    let n = 0;
    while (n < recs.length) {
      const r = recs[n++];
      if (total > MAX_ITEMS) throw new CadProblem(`it holds more than ${MAX_ITEMS.toLocaleString('en-GB')} items`);
      // Cut and trimmed as the layer names are, so every item stays on its layer when the drawing is saved and opened.
      const layer = (get(r, 8) ?? '0').trim().slice(0, 64) || '0';
      const own = num(r, 62, 256);
      if (r.type !== 'SEQEND' && r.type !== 'VERTEX') {
        if ((own !== 256 && own !== 0) || get(r, 420) !== undefined) ownColours++;
        if ([30, 31, 38].some(code => Math.abs(num(r, code)) > 1e-9)) raised++;
        if (Math.abs(num(r, 39)) > 1e-9) thick++;
        const lt = get(r, 6);
        if (lt && !/^(BYLAYER|BYBLOCK)$/i.test(lt.trim())) ownLineTypes++;
      }
      const put = (shape: Shape) => {
        out.push({ shape, layer });
        total++;
      };
      const f = facing(r);
      if (!f && ['ARC', 'CIRCLE', 'LWPOLYLINE', 'POLYLINE', 'TEXT', 'MTEXT', 'INSERT', 'ELLIPSE'].includes(r.type)) {
        counted(leftOut, 'item tilted out of the flat drawing plane');
        if (r.type === 'POLYLINE') {
          while (n < recs.length && recs[n].type === 'VERTEX') n++;
          if (recs[n]?.type === 'SEQEND') n++;
        }
        continue;
      }
      switch (r.type) {
        case 'LINE': {
          const a = ptOf(r, 10);
          const b = ptOf(r, 11);
          if (dist(a, b) > 1e-12) put({ type: 'line', a, b });
          else counted(leftOut, 'line of no length');
          break;
        }
        case 'POINT':
          put({ type: 'point', p: ptOf(r, 10) });
          break;
        case 'CIRCLE': {
          const rad = num(r, 40);
          if (rad > 0) put({ type: 'circle', c: flipX(ptOf(r, 10), f), r: rad });
          else counted(leftOut, 'circle of no size');
          break;
        }
        case 'ARC': {
          const rad = num(r, 40);
          if (!(rad > 0)) {
            counted(leftOut, 'arc of no size');
            break;
          }
          let a0 = (num(r, 50) * Math.PI) / 180;
          let a1 = (num(r, 51) * Math.PI) / 180;
          if (f < 0) [a0, a1] = [Math.PI - a1, Math.PI - a0];
          a0 = normAngle(a0);
          let span = normAngle(a1 - a0);
          if (span < 1e-12) span = TAU;
          put({ type: 'arc', c: flipX(ptOf(r, 10), f), r: rad, a0, a1: a0 + span });
          break;
        }
        case 'ELLIPSE': {
          const c = ptOf(r, 10);
          const m = ptOf(r, 11);
          // Other programs' rounding can make a circle-like ellipse's ratio a hair over 1.
          let ratio = num(r, 40, 1);
          if (ratio > 1 && ratio < 1 + 1e-6) ratio = 1;
          if (!(ratio > 0 && ratio <= 1) || Math.hypot(m.x, m.y) < 1e-12) {
            counted(leftOut, 'ellipse of impossible size');
            break;
          }
          let t0 = num(r, 41, 0);
          let t1 = num(r, 42, TAU);
          let span = normAngle(t1 - t0);
          if (span < 1e-9 || Math.abs(t1 - t0 - TAU) < 1e-9) span = TAU;
          if (f < 0) [t0, t1] = [-t0 - span, -t0];
          t0 = span >= TAU ? 0 : normAngle(t0);
          put({ type: 'ellipse', c, m, ratio, t0, t1: t0 + span });
          break;
        }
        case 'LWPOLYLINE': {
          const pts: Pt[] = [];
          const bulges: number[] = [];
          for (const [code, v] of r.tags) {
            if (code === 10) {
              pts.push(P(Number(v), 0));
              bulges.push(0);
            } else if (code === 20 && pts.length) pts[pts.length - 1] = P(pts[pts.length - 1].x, Number(v));
            else if (code === 42 && bulges.length) bulges[bulges.length - 1] = Number(v) || 0;
          }
          const closed = !!(num(r, 70) & 1);
          if (pts.length >= 2 && pts.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))) {
            put({ type: 'poly', pts: pts.map(p => flipX(p, f)), bulges: bulges.map(b => (f < 0 ? -b : b)), closed });
          } else counted(leftOut, 'polyline with fewer than two points');
          break;
        }
        case 'POLYLINE': {
          const flags = num(r, 70);
          const pts: Pt[] = [];
          const bulges: number[] = [];
          while (n < recs.length && recs[n].type === 'VERTEX') {
            const v = recs[n++];
            const vf = num(v, 70);
            if (vf & 16 || vf & 128) continue;
            pts.push(flipX(ptOf(v, 10), f));
            bulges.push((f < 0 ? -1 : 1) * num(v, 42));
          }
          if (recs[n]?.type === 'SEQEND') n++;
          if (flags & 16 || flags & 64) {
            leave(flags & 64 ? '3DFACE' : 'MESH');
            break;
          }
          if (flags & 8) notes.add('3D polylines were laid flat (their heights dropped).');
          if (pts.length >= 2) put({ type: 'poly', pts, bulges, closed: !!(flags & 1) });
          else counted(leftOut, 'polyline with fewer than two points');
          break;
        }
        case 'SPLINE': {
          const shape = splineOf(r, tol);
          if (shape === 'fit') {
            const fy = r.tags.filter(x => x[0] === 21);
            const fit = r.tags.filter(t => t[0] === 11).map((t, j) => P(Number(t[1]), Number(fy[j]?.[1] ?? 0)));
            if (fit.length >= 2) {
              put({ type: 'spline', fit, closed: !!(num(r, 70) & 1) });
              notes.add('Curves saved with only their fit points were drawn as smooth curves through those points (the shape may differ very slightly).');
            } else leave('SPLINE');
          } else if (shape) {
            put(shape);
            curves++;
          } else leave('SPLINE');
          break;
        }
        case 'XLINE':
        case 'RAY': {
          const d = ptOf(r, 11, P(1, 0));
          if (Math.hypot(d.x, d.y) < 1e-12) break;
          put({ type: 'xline', p: ptOf(r, 10), d: unit(d) });
          if (r.type === 'RAY') notes.add('Rays (lines endless one way) were read as construction lines running both ways.');
          break;
        }
        case 'TEXT':
        case 'ATTRIB': {
          if (r.type === 'ATTRIB' && num(r, 70) & 1) break;
          const t = textOf(r, f);
          if (t) put(t);
          break;
        }
        case 'MTEXT': {
          const t = mtextOf(r);
          if (t) put(t);
          break;
        }
        case 'LEADER': {
          const ly = r.tags.filter(x => x[0] === 20);
          const pts = r.tags.filter(t => t[0] === 10).map((t, j) => P(Number(t[1]), Number(ly[j]?.[1] ?? 0)));
          if (pts.length >= 2) put({ type: 'dim', kind: 'leader', pts, dir: 0, h: defaultStyle(units === 'inch').dimH, arrow: defaultStyle(units === 'inch').arrow, dp: 2, text: '' });
          break;
        }
        case 'INSERT':
        case 'DIMENSION': {
          const name = (get(r, 2) ?? '').toUpperCase();
          const b = blocks.get(name);
          if (!b) {
            if (r.type === 'DIMENSION') counted(leftOut, 'dimension saved without its picture');
            else counted(leftOut, 'block insert whose block is missing');
            break;
          }
          if (depth > 16) {
            counted(leftOut, 'block nested too deep');
            break;
          }
          let inner = expanded.get(name);
          if (!inner) {
            inner = convert(b.recs, depth + 1);
            expanded.set(name, inner);
          }
          if (r.type === 'DIMENSION') inner = inner.filter(p => p.shape.type !== 'point');
          total += inner.length;
          if (r.type === 'DIMENSION') {
            for (const p of inner) {
              out.push({ shape: p.shape, layer: p.layer === null || p.layer === '0' ? layer : p.layer });
            }
            exploded++;
            break;
          }
          const sx = num(r, 41, 1) || 1;
          // A missing y scale is 1 (the DXF default), not the x scale: a block mirrored with x -1 stays mirrored.
          const sy = num(r, 42, 1) || 1;
          const rot = (num(r, 50) * Math.PI) / 180;
          const cols = Math.max(1, Math.min(1000, Math.round(num(r, 70, 1)) || 1));
          const rows = Math.max(1, Math.min(1000, Math.round(num(r, 71, 1)) || 1));
          // Each copy of a repeated insert counts against the limit before any is made (a tiny file can ask for millions).
          total += inner.length * (rows * cols - 1);
          if (total > MAX_ITEMS) throw new CadProblem(`it holds more than ${MAX_ITEMS.toLocaleString('en-GB')} items`);
          const colGap = num(r, 44);
          const rowGap = num(r, 45);
          const pos = flipX(ptOf(r, 10), f);
          for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) {
              const off = rotatePt(P(col * colGap, row * rowGap), P(0, 0), rot);
              for (const p of inner) {
                // Seen from below, x is mirrored: the scale across turns over, and so does the turn.
                const placed = placeShape(p.shape, b.base, f < 0 ? -sx : sx, sy, f < 0 ? -rot : rot, add(pos, f < 0 ? P(-off.x, off.y) : off), tol);
                for (const s of placed.shapes) out.push({ shape: s, layer: p.layer === null || p.layer === '0' ? layer : p.layer });
                if (placed.approximated) notes.add('Blocks stretched more one way than the other had their arcs redrawn as polylines of arcs within the arc tolerance.');
              }
            }
          }
          exploded++;
          break;
        }
        case 'VERTEX':
        case 'SEQEND':
        case '':
          break;
        default:
          leave(r.type);
      }
    }
    // Inside a block, an item on layer 0 takes the layer of whatever inserts the block.
    return depth > 0 ? out.map(p => ({ shape: p.shape, layer: p.layer === '0' ? null : p.layer })) : out;
  }

  function textOf(r: Rec, f: number): TextShape | null {
    const words = decodeText(get(r, 1) ?? '');
    if (!words.trim()) return null;
    const h = num(r, 40, 0);
    if (!(h > 0)) return null;
    let angle = (num(r, 50) * Math.PI) / 180;
    const hj = num(r, 72);
    const vj = num(r, 73);
    let p = flipX(ptOf(r, 10), f);
    const second = get(r, 11) !== undefined ? flipX(ptOf(r, 11), f) : null;
    if (f < 0) angle = Math.PI - angle;
    let align: Align = 'left';
    if (second && (hj === 1 || hj === 2 || hj === 4)) {
      p = second;
      align = hj === 2 ? 'right' : 'centre';
    } else if (second && (hj === 3 || hj === 5)) {
      angle = angleOf(sub(second, p));
    } else if (second && vj > 0) p = second;
    const up = perp(dirOf(angle));
    const drop = hj === 4 || vj === 2 ? h / 2 : vj === 3 ? h : 0;
    if (drop) p = sub(p, mul(up, drop));
    return { type: 'text', p, text: words, h, angle: normAngle(angle), align };
  }

  function mtextOf(r: Rec): TextShape | null {
    const raw = r.tags.filter(t => t[0] === 3).map(t => t[1]).join('') + (get(r, 1) ?? '');
    const words = decodeMtext(raw).replace(/\s+$/, '');
    if (!words.trim()) return null;
    const h = num(r, 40, 0);
    if (!(h > 0)) return null;
    const dir = get(r, 11) !== undefined ? ptOf(r, 11) : null;
    // Code 50 is written in degrees by AutoCAD and others (the DXF reference's "radians" is a known slip).
    const angle = dir && Math.hypot(dir.x, dir.y) > 1e-12 ? angleOf(dir) : (num(r, 50) * Math.PI) / 180;
    const attach = Math.max(1, Math.min(9, num(r, 71, 1)));
    const row = Math.ceil(attach / 3);
    const col = (attach - 1) % 3;
    const count = words.split('\n').length;
    const height = h + (count - 1) * 1.6 * h;
    // The first line's foot, measured up from the insertion point: below it for text hung from the top.
    const rise = row === 1 ? -h : row === 2 ? height / 2 - h : height - h;
    const foot = add(ptOf(r, 10), mul(perp(dirOf(angle)), rise));
    return { type: 'text', p: foot, text: words, h, angle: normAngle(angle), align: col === 0 ? 'left' : col === 1 ? 'centre' : 'right' };
  }

  let placed: Placed[];
  try {
    placed = convert(sections.get('ENTITIES') ?? [], 0);
  } catch (error) {
    if (error instanceof CadProblem) throw new CadProblem(`This DXF cannot be opened: ${error.message}.`);
    throw error;
  }

  // Our own layers come back from R12 in capitals (GEOMETRY, DIMENSIONS): they open under our spelling, so the
  // text and dimension tools, and the Construction layer added below, find them rather than making a second one.
  const ours = new Map([GEOMETRY, CONSTRUCTION, DIMENSIONS, TEXT].map(n => [n.toUpperCase(), n]));
  const given = new Set(layers.map(l => l.name));
  const spelt = (name: string | null) => {
    const own = name === null ? undefined : ours.get(name.toUpperCase());
    return own && !given.has(own) ? own : name;
  };
  for (const l of layers) l.name = spelt(l.name)!;
  // Sizes in feet, centimetres or metres are brought to inches or millimetres.
  const scaled = (k === 1 ? placed : placed.map(p => ({ shape: scaleShape(p.shape, P(0, 0), k), layer: p.layer }))).map(p => ({ shape: p.shape, layer: spelt(p.layer) }));
  // A size so far out it is no longer a number (1e306 metres, a block scaled 1e300 times) would make the drawing
  // impossible to save and open again: such items are left out and counted.
  const shapes = scaled.filter(p => {
    if (allFinite(p.shape)) return true;
    counted(leftOut, 'item too far out to keep (a size beyond any number)');
    return false;
  });

  const d = newDrawing(units);
  const known = new Set(layers.map(l => l.name));
  for (const p of shapes) {
    const name = p.layer ?? '0';
    if (!known.has(name)) {
      known.add(name);
      layers.push({ name, colour: '#ffffff', on: true, locked: false, lineType: 'continuous' });
    }
  }
  // Layers with nothing on them (and not one of ours) are kept: the drawing may want them.
  d.layers = layers.length ? layers : d.layers;
  let id = 1;
  d.ents = shapes.map(p => ({ ...p.shape, id: id++, layer: p.layer ?? '0' }) as Ent);
  const busy = d.layers.find(l => d.ents.some(e => e.layer === l.name) && l.name !== '0');
  d.current = busy?.name ?? d.layers.find(l => l.name === GEOMETRY)?.name ?? d.layers[0].name;
  if (!d.layers.some(l => l.name === CONSTRUCTION)) d.layers.push({ name: CONSTRUCTION, colour: '#e040e0', on: true, locked: false, lineType: 'dashed' });

  const report: string[] = [];
  const byName = new Map<string, number>();
  for (const e of d.ents) {
    const kName = (e.type === 'dim' ? 'leader' : TYPE_NAMES[e.type]).toLowerCase();
    byName.set(kName, (byName.get(kName) ?? 0) + 1);
  }
  report.push(`Read ${d.ents.length} item${d.ents.length === 1 ? '' : 's'}${byName.size ? `: ${[...byName].map(([kName, c]) => `${c} ${kName}${c === 1 ? '' : 's'}`).join(', ')}` : ''}, on ${d.layers.length} layer${d.layers.length === 1 ? '' : 's'}.`);
  report.push(unitsNote);
  if (exploded) report.push(`${exploded} block${exploded === 1 ? '' : 's'} and dimension${exploded === 1 ? '' : 's'} taken apart into their lines, arcs and text.`);
  if (curves) report.push(`${curves} curve${curves === 1 ? '' : 's'} (splines) drawn as polylines of arcs, each within ${tol} ${units === 'mm' ? 'mm' : 'in'} of the true shape.`);
  for (const note of notes) report.push(note);
  if (ownColours) report.push(`${ownColours} item${ownColours === 1 ? ' has' : 's have'} a colour of its own in the file: CAD Draft draws every item in its layer's colour.`);
  if (ownLineTypes) report.push(`${ownLineTypes} item${ownLineTypes === 1 ? ' has' : 's have'} a line type of its own in the file (dashed, centre...): CAD Draft draws every item in its layer's line type.`);
  if (raised) report.push(`${raised} item${raised === 1 ? ' sits' : 's sit'} at a height (Z) other than 0: drawn flat, and a DXF output from here puts ${raised === 1 ? 'it' : 'them'} at 0. If the CAM program reads depth from Z, set it again there.`);
  if (thick) report.push(`${thick} item${thick === 1 ? ' has' : 's have'} a thickness (raised walls in 3D): drawn flat, and not kept.`);
  const left = [...leftOut].reduce((t, [, c]) => t + c, 0);
  if (left) report.push(`Left out (CAD Draft does not draw these): ${[...leftOut].map(([kName, c]) => `${c} ${kName}${c === 1 ? '' : 's'}`).join(', ')}.`);
  if (!d.ents.length) report.push('Nothing in the file could be drawn.');
  // Text longer than a drawing keeps is cut to that length, and said, so the drawing opens again once saved.
  let longText = 0;
  for (const e of d.ents) if ((e.type === 'text' || e.type === 'dim') && typeof e.text === 'string' && e.text.length > MAX_TEXT_LENGTH) {
    e.text = e.text.slice(0, MAX_TEXT_LENGTH);
    longText++;
  }
  if (longText) report.push(`${longText} text item${longText === 1 ? ' was' : 's were'} longer than ${MAX_TEXT_LENGTH.toLocaleString('en-GB')} letters: cut to that length.`);
  return { drawing: d, report, leftOut: left, changed: ownColours + ownLineTypes + raised + thick + longText };
}

/** Every number in a shape is a real number (not Infinity or NaN). */
export function allFinite(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every(allFinite);
  if (v && typeof v === 'object') return Object.values(v).every(allFinite);
  return true;
}

/** A SPLINE as a polyline of arcs from its control points; 'fit' when it has only fit points; null when unreadable. */
function splineOf(r: Rec, tol: number): Shape | 'fit' | null {
  const degree = num(r, 71, 3);
  const knots = nums(r, 40);
  const weights = nums(r, 41);
  const xs = r.tags.filter(t => t[0] === 10).map(t => Number(t[1]));
  const ys = r.tags.filter(t => t[0] === 20).map(t => Number(t[1]));
  const ctrl = xs.map((x, j) => P(x, ys[j] ?? 0));
  if (ctrl.length < 2) return r.tags.some(t => t[0] === 11) ? 'fit' : null;
  if (!(degree >= 1 && degree <= 10) || ctrl.length <= degree || knots.length !== ctrl.length + degree + 1) return null;
  for (let j = 1; j < knots.length; j++) if (!(knots[j] >= knots[j - 1])) return null;
  const w = weights.length === ctrl.length ? weights : ctrl.map(() => 1);
  const lo = knots[degree];
  const hi = knots[ctrl.length];
  if (!(hi > lo)) return null;
  const evalAt = (t: number): Pt => {
    // The last knot span starting at or before t (found by halving: a curve can have thousands of points).
    let lo2 = degree;
    let hi2 = ctrl.length - 1;
    while (lo2 < hi2) {
      const m = (lo2 + hi2 + 1) >> 1;
      if (t >= knots[m]) lo2 = m;
      else hi2 = m - 1;
    }
    const span = lo2;
    const d: Array<[number, number, number]> = [];
    for (let j = 0; j <= degree; j++) {
      const c = ctrl[span - degree + j];
      const wj = w[span - degree + j];
      d.push([c.x * wj, c.y * wj, wj]);
    }
    for (let rr = 1; rr <= degree; rr++) {
      for (let j = degree; j >= rr; j--) {
        const ii = span - degree + j;
        const den = knots[ii + degree - rr + 1] - knots[ii];
        const a = den > 0 ? (t - knots[ii]) / den : 0;
        d[j] = [(1 - a) * d[j - 1][0] + a * d[j][0], (1 - a) * d[j - 1][1] + a * d[j][1], (1 - a) * d[j - 1][2] + a * d[j][2]];
      }
    }
    const [x, y, ww] = d[degree];
    return ww ? P(x / ww, y / ww) : P(x, y);
  };
  // Split at every distinct knot inside the range: the curve can bend sharply there.
  const inner = [...new Set(knots.filter(t => t > lo && t < hi))];
  const cuts = [lo, ...inner, hi];
  const pts: Pt[] = [];
  const bulges: number[] = [];
  for (let j = 0; j + 1 < cuts.length; j++) {
    const part = curveToBulges(evalAt, cuts[j], cuts[j + 1], tol, 2);
    if (!pts.length) pts.push(part.pts[0]);
    for (let q = 1; q < part.pts.length; q++) {
      pts.push(part.pts[q]);
      bulges.push(part.bulges[q - 1]);
    }
  }
  const closed = !!(num(r, 70) & 1) && dist(pts[0], pts[pts.length - 1]) < 1e-6;
  if (closed) pts.pop();
  else bulges.push(0);
  if (!pts.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))) return null;
  return { type: 'poly', pts, bulges, closed };
}

/**
 * A block's item placed where its insert puts it: the block's base point to `pos`, stretched sx across and sy up,
 * turned by rot. Stretched the same both ways, every shape stays exact; stretched more one way, round shapes are
 * redrawn as polylines of arcs within `tol`.
 */
export function placeShape(s: Shape, base: Pt, sx: number, sy: number, rot: number, pos: Pt, tol: number): { shapes: Shape[]; approximated: boolean } {
  const toPlace = (q: Pt) => add(pos, rotatePt(P((q.x - base.x) * sx, (q.y - base.y) * sy), P(0, 0), rot));
  if (Math.abs(Math.abs(sx) - Math.abs(sy)) < 1e-12 * Math.max(Math.abs(sx), 1)) {
    let t = moveShape(s, P(-base.x, -base.y));
    if (sx < 0 && sy > 0) t = mirrorShape(t, P(0, 0), P(0, 1));
    else if (sy < 0 && sx > 0) t = mirrorShape(t, P(0, 0), P(1, 0));
    else if (sx < 0 && sy < 0) t = rotateShape(t, P(0, 0), Math.PI);
    t = scaleShape(t, P(0, 0), Math.abs(sx));
    t = rotateShape(t, P(0, 0), rot);
    return { shapes: [moveShape(t, pos)], approximated: false };
  }
  switch (s.type) {
    case 'line':
      return { shapes: [{ type: 'line', a: toPlace(s.a), b: toPlace(s.b) }], approximated: false };
    case 'point':
      return { shapes: [{ type: 'point', p: toPlace(s.p) }], approximated: false };
    case 'xline':
      return { shapes: [{ type: 'xline', p: toPlace(s.p), d: unit(sub(toPlace(add(s.p, s.d)), toPlace(s.p))) }], approximated: false };
    case 'text':
      return { shapes: [{ ...s, p: toPlace(s.p), h: s.h * Math.abs(sy), angle: normAngle(s.angle + rot), arc: undefined }], approximated: false };
    case 'dim':
      return { shapes: [{ ...s, pts: s.pts.map(toPlace), dir: normAngle(s.dir + rot) }], approximated: false };
    case 'poly':
      if (s.bulges.every(b => Math.abs(b) < 1e-12)) return { shapes: [{ ...s, pts: s.pts.map(toPlace) }], approximated: false };
      break;
  }
  const pieces = outlineOf(s);
  const mapped: Piece[] = [];
  const out = { pts: [] as Pt[], bulges: [] as number[] };
  for (const p of pieces) {
    if (p.k === 'seg') {
      mapped.push({ k: 'seg', a: toPlace(p.a), b: toPlace(p.b) });
      continue;
    }
    const dm = domain(p);
    if (!dm) continue;
    const part = curveToBulges(t => toPlace(at(p, t)), dm[0], dm[1], tol, Math.max(2, Math.ceil(((dm[1] - dm[0]) / TAU) * 8)));
    if (!out.pts.length) out.pts.push(part.pts[0]);
    out.pts.push(...part.pts.slice(1));
    out.bulges.push(...part.bulges);
  }
  const closed = (s.type === 'circle') || (s.type === 'ellipse' && isFull(s.t0, s.t1)) || (s.type === 'poly' && s.closed) || (s.type === 'spline' && s.closed);
  if (mapped.length && !out.pts.length) return { shapes: mapped.map(m => ({ type: 'line', a: (m as { a: Pt }).a, b: (m as { b: Pt }).b }) as Shape), approximated: false };
  // A polyline of lines and arcs: rebuilt span by span in order.
  if (s.type === 'poly') {
    const pts: Pt[] = [];
    const bulges: number[] = [];
    for (const p of pieces) {
      if (p.k === 'seg') {
        if (!pts.length) pts.push(toPlace(p.a));
        pts.push(toPlace(p.b));
        bulges.push(0);
      } else {
        const dm = domain(p)!;
        const part = curveToBulges(t => toPlace(at(p, t)), dm[0], dm[1], tol, 2);
        if (!pts.length) pts.push(part.pts[0]);
        pts.push(...part.pts.slice(1));
        bulges.push(...part.bulges);
      }
    }
    if (s.closed && pts.length > 2 && dist(pts[0], pts[pts.length - 1]) < 1e-9) pts.pop();
    else bulges.push(0);
    return { shapes: [{ type: 'poly', pts, bulges, closed: s.closed }], approximated: true };
  }
  if (closed && out.pts.length > 2 && dist(out.pts[0], out.pts[out.pts.length - 1]) < 1e-9) out.pts.pop();
  else out.bulges.push(0);
  return { shapes: [{ type: 'poly', pts: out.pts, bulges: out.bulges, closed }], approximated: true };
}

