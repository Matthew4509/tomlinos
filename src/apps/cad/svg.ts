// SVG, for laser cutters, vinyl cutters, Inkscape and the web: the drawing at its true size (width and height in
// millimetres or inches, the view box in the drawing's own units, so 1 in the file is 1 mm or 1 inch), each layer a
// group Inkscape lists as a layer, in the colour it prints in (white as black), its line type as dashes of the sizes
// the DXF line types have. Every shape is exact: arcs and polyline bulges as SVG arcs, circles and ellipses as
// themselves (part ellipses as elliptical arcs), curves through points as the cubic Béziers they are. Text is SVG
// text in the viewer's sans-serif letters (CAD Draft's own single-stroke letters only when written as lines), sized
// so its capitals stand as tall as in the drawing. Hidden layers are left out. The file holds no scripts and points
// at nothing outside itself.
import { textStrokes, type Align } from './font.ts';
import { P, TAU, add, at, curveThrough, dist, isFull, mul, normAngle, rotatePt, sub, type Box, type Pt } from './geom.ts';
import { STRAIGHT_BULGE, shapeBox, type Drawing, type Ent, type Shape } from './model.ts';
import { arcLetters, dimParts, type NoteText, type TextShape } from './notes.ts';
import { paperInk } from './print.ts';
import { DXF_LINE_TYPES } from './dxf.ts';

export interface SvgOptions {
  /** A white sheet behind the drawing (off: see-through). */
  white: boolean;
  /** Text as lines in CAD Draft's single-stroke letters, exactly as on screen (off: SVG text). */
  textAsLines: boolean;
  /** Construction lines, as long lines across the drawing. */
  construction: boolean;
  /** The file's title (the drawing's name). */
  title?: string;
}

export interface SvgWritten {
  text: string;
  bytes: Uint8Array;
  notes: string[];
  count: number;
}

/** The capital height of a sans-serif letter, as a share of its font size (Arial, Helvetica and the like). */
export const CAP_SHARE = 0.716;

/** A number for the file: at most six decimals (a millionth of a millimetre), no exponent, no "-0". */
export function svgNum(v: number): string {
  if (!Number.isFinite(v)) return '0';
  const s = (Math.round(v * 1e6) / 1e6).toFixed(6).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
}

/** Words or a name made safe for XML: & < > " ' as entities, and signs XML 1.0 cannot hold left out. */
export function xmlEscape(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** An id XML accepts, made from a layer name. */
function idOf(name: string, taken: Set<string>): string {
  const base = `layer-${name.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'unnamed'}`;
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  taken.add(id);
  return id;
}

/** The drawing as an SVG file at its true size. */
export function writeSvg(d: Drawing, o: SvgOptions): SvgWritten {
  const n = svgNum;
  const unit = d.units === 'mm' ? 'mm' : 'in';
  const k = d.units === 'mm' ? 1 : 1 / 25.4;
  const layers = d.layers.filter(l => l.on);
  const onNames = new Set(layers.map(l => l.name));
  const ents = d.ents.filter(e => onNames.has(e.layer) && (o.construction || e.type !== 'xline'));
  const leftHidden = d.ents.filter(e => !onNames.has(e.layer)).length;
  const leftXlines = d.ents.filter(e => onNames.has(e.layer) && !o.construction && e.type === 'xline').length;

  let box: Box | null = null;
  for (const e of ents) {
    const b = shapeBox(e);
    if (b) box = box ? { x0: Math.min(box.x0, b.x0), y0: Math.min(box.y0, b.y0), x1: Math.max(box.x1, b.x1), y1: Math.max(box.y1, b.y1) } : b;
  }
  const ext = box ?? { x0: 0, y0: 0, x1: 100 * k, y1: 100 * k };
  // A margin all round, so a line on the edge is not cut in half.
  const margin = 5 * k;
  const x0 = ext.x0 - margin;
  const x1 = ext.x1 + margin;
  const y0 = ext.y0 - margin;
  const y1 = ext.y1 + margin;
  const w = x1 - x0;
  const h = y1 - y0;
  // The file's y runs down the page, the drawing's up it: every y is turned over (no transform, so text stays upright).
  const X = (p: Pt) => n(p.x);
  const Y = (p: Pt) => n(-p.y);
  const xy = (p: Pt) => `${X(p)} ${Y(p)}`;
  const stroke = 0.25 * k;

  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8" standalone="no"?>');
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" version="1.1" width="${n(w)}${unit}" height="${n(h)}${unit}" viewBox="${n(x0)} ${n(-y1)} ${n(w)} ${n(h)}">`);
  out.push(`<title>${xmlEscape(o.title ?? 'Drawing')}</title>`);
  out.push(`<desc>${xmlEscape(`Drawn in CAD Draft, at full size: 1 unit is 1 ${d.units === 'mm' ? 'millimetre' : 'inch'}.${o.textAsLines ? '' : ' Text is in the viewer\'s sans-serif letters, not CAD Draft\'s single-stroke ones.'}`)}</desc>`);
  if (o.white) out.push(`<rect id="sheet" x="${n(x0)}" y="${n(-y1)}" width="${n(w)}" height="${n(h)}" fill="#ffffff" stroke="none"/>`);

  let count = 0;
  const ids = new Set<string>(['sheet']);
  for (const layer of layers) {
    const mine = ents.filter(e => e.layer === layer.name);
    const ink = paperInk(layer.colour);
    const lt = DXF_LINE_TYPES[layer.lineType];
    const dashes = lt.mm.map(v => Math.abs(v) * k);
    const attrs = [
      `id="${idOf(layer.name, ids)}"`, 'inkscape:groupmode="layer"', `inkscape:label="${xmlEscape(layer.name)}"`,
      `stroke="${ink}"`, 'fill="none"', `stroke-width="${n(stroke)}"`, 'stroke-linecap="round"', 'stroke-linejoin="round"',
    ];
    if (dashes.length) attrs.push(`stroke-dasharray="${dashes.map(n).join(' ')}"`);
    out.push(`<g ${attrs.join(' ')}>`);
    for (const e of mine) count += shape(e, ink);
    out.push('</g>');
  }
  out.push('</svg>');

  /** One item as SVG; how many items it became. */
  function shape(e: Ent | Shape, ink: string): number {
    switch (e.type) {
      case 'line':
        out.push(`<line x1="${X(e.a)}" y1="${Y(e.a)}" x2="${X(e.b)}" y2="${Y(e.b)}"/>`);
        return 1;
      case 'circle':
        out.push(`<circle cx="${X(e.c)}" cy="${Y(e.c)}" r="${n(e.r)}"/>`);
        return 1;
      case 'arc':
        out.push(`<path d="${arcPath(e.c, e.r, e.a0, e.a1)}"/>`);
        return 1;
      case 'ellipse': {
        const rx = Math.hypot(e.m.x, e.m.y);
        const ry = rx * e.ratio;
        // Turned the other way: the file's y runs down.
        const turn = n((-Math.atan2(e.m.y, e.m.x) * 180) / Math.PI);
        if (isFull(e.t0, e.t1)) {
          out.push(`<ellipse cx="${X(e.c)}" cy="${Y(e.c)}" rx="${n(rx)}" ry="${n(ry)}" transform="rotate(${turn} ${X(e.c)} ${Y(e.c)})"/>`);
          return 1;
        }
        const piece = { k: 'ell', c: e.c, m: e.m, ratio: e.ratio, t0: e.t0, t1: e.t1 } as const;
        const large = e.t1 - e.t0 > Math.PI ? 1 : 0;
        out.push(`<path d="M ${xy(at(piece, e.t0))} A ${n(rx)} ${n(ry)} ${turn} ${large} 0 ${xy(at(piece, e.t1))}"/>`);
        return 1;
      }
      case 'poly': {
        if (e.pts.length < 2) return 0;
        const parts = [`M ${xy(e.pts[0])}`];
        const spans = e.closed ? e.pts.length : e.pts.length - 1;
        for (let i = 0; i < spans; i++) {
          const a = e.pts[i];
          const b = e.pts[(i + 1) % e.pts.length];
          parts.push(spanPath(a, b, e.bulges[i] ?? 0));
        }
        if (e.closed) parts.push('Z');
        out.push(`<path d="${parts.join(' ')}"/>`);
        return 1;
      }
      case 'spline': {
        const bez = curveThrough(e.fit, e.closed);
        if (!bez.length) return 0;
        const parts = [`M ${xy(bez[0].p[0])}`, ...bez.map(b => `C ${xy(b.p[1])} ${xy(b.p[2])} ${xy(b.p[3])}`)];
        if (e.closed) parts.push('Z');
        out.push(`<path d="${parts.join(' ')}"/>`);
        return 1;
      }
      case 'point': {
        const r = 1 * k;
        out.push(`<path d="M ${xy(sub(e.p, P(r, r)))} L ${xy(add(e.p, P(r, r)))} M ${xy(add(e.p, P(-r, r)))} L ${xy(add(e.p, P(r, -r)))}" stroke-dasharray="none"/>`);
        return 1;
      }
      case 'xline': {
        const reach = Math.max(ext.x1 - ext.x0, ext.y1 - ext.y0, 100 * k) * 1.5 + dist(e.p, P((ext.x0 + ext.x1) / 2, (ext.y0 + ext.y1) / 2));
        const a = sub(e.p, mul(e.d, reach));
        const b = add(e.p, mul(e.d, reach));
        out.push(`<line x1="${X(a)}" y1="${Y(a)}" x2="${X(b)}" y2="${Y(b)}"/>`);
        return 1;
      }
      case 'text':
        return textShape(e, ink);
      case 'dim': {
        const parts = dimParts(e);
        let c = 0;
        for (const p of parts.pieces) {
          if (p.k === 'seg') {
            out.push(`<line x1="${X(p.a)}" y1="${Y(p.a)}" x2="${X(p.b)}" y2="${Y(p.b)}"/>`);
            c++;
          } else if (p.k === 'arc') {
            out.push(isFull(p.a0, p.a1) ? `<circle cx="${X(p.c)}" cy="${Y(p.c)}" r="${n(p.r)}"/>` : `<path d="${arcPath(p.c, p.r, p.a0, p.a1)}"/>`);
            c++;
          }
        }
        for (const t of parts.texts) c += text(t, ink);
        return c;
      }
    }
  }

  /** An arc anticlockwise from a0 to a1 as a path (a whole turn as two halves: one SVG arc cannot close on itself). */
  function arcPath(c: Pt, r: number, a0: number, a1: number): string {
    const pt = (a: number) => P(c.x + r * Math.cos(a), c.y + r * Math.sin(a));
    if (isFull(a0, a1)) return `M ${xy(pt(a0))} A ${n(r)} ${n(r)} 0 0 0 ${xy(pt(a0 + Math.PI))} A ${n(r)} ${n(r)} 0 0 0 ${xy(pt(a0))}`;
    // Anticlockwise in the drawing is anticlockwise on the page too: in the file's turned-over y that is sweep 0.
    return `M ${xy(pt(a0))} A ${n(r)} ${n(r)} 0 ${a1 - a0 > Math.PI ? 1 : 0} 0 ${xy(pt(a1))}`;
  }

  /** One polyline span to b: straight, or the arc its bulge gives. */
  function spanPath(a: Pt, b: Pt, bulge: number): string {
    if (Math.abs(bulge) <= STRAIGHT_BULGE || dist(a, b) < 1e-12) return `L ${xy(b)}`;
    const turn = 4 * Math.atan(Math.abs(bulge));
    const r = dist(a, b) / (2 * Math.sin(turn / 2));
    return `A ${n(r)} ${n(r)} 0 ${turn > Math.PI ? 1 : 0} ${bulge > 0 ? 0 : 1} ${xy(b)}`;
  }

  function text(t: NoteText, ink: string): number {
    if (o.textAsLines) {
      let c = 0;
      for (const s of textStrokes(t.text, t.p, t.h, t.angle, t.align)) {
        if (s.length < 2) continue;
        out.push(`<path d="M ${s.map(xy).join(' L ')}" stroke-dasharray="none"/>`);
        c++;
      }
      return c;
    }
    let c = 0;
    const anchor = t.align === 'left' ? 'start' : t.align === 'centre' ? 'middle' : 'end';
    const turn = n((-normAngle(t.angle) * 180) / Math.PI);
    t.text.split('\n').forEach((row, i) => {
      if (!row.trim()) return;
      const foot = rotatePt(P(t.p.x, t.p.y - i * 1.6 * t.h), t.p, t.angle);
      const spin = Math.abs(normAngle(t.angle)) > 1e-12 && Math.abs(normAngle(t.angle) - TAU) > 1e-12 ? ` transform="rotate(${turn} ${X(foot)} ${Y(foot)})"` : '';
      out.push(`<text x="${X(foot)}" y="${Y(foot)}" font-family="Arial, Helvetica, sans-serif" font-size="${n(t.h / CAP_SHARE)}" text-anchor="${anchor}" fill="${ink}" stroke="none" xml:space="preserve"${spin}>${xmlEscape(row)}</text>`);
      c++;
    });
    return c;
  }

  function textShape(t: TextShape, ink: string): number {
    if (!t.arc) return text({ text: t.text, p: t.p, h: t.h, angle: t.angle, align: t.align }, ink);
    let c = 0;
    for (const l of arcLetters(t)) if (l.ch.trim()) c += text({ text: l.ch, p: l.at, h: t.h, angle: l.angle, align: 'left' as Align }, ink);
    return c;
  }

  const notes = [`${count} item${count === 1 ? '' : 's'} written (SVG at full size, ${d.units === 'mm' ? 'millimetres' : 'inches'}: ${n(w)} x ${n(h)} ${unit} with a ${n(margin)} ${unit} margin).`];
  notes.push('Each layer is a group (an Inkscape layer) in the colour it prints in; white is written as black.');
  if (ents.some(e => e.type === 'text' || e.type === 'dim') && !o.textAsLines) notes.push('Text is SVG text: the viewer draws it in its own sans-serif letters (CAD Draft\'s single-stroke letters are written only with "Text as lines").');
  if (d.ents.some(e => e.type === 'dim')) notes.push('Dimensions are written as plain lines and text.');
  if (leftHidden) notes.push(`${leftHidden} item${leftHidden === 1 ? '' : 's'} on hidden layers left out.`);
  if (leftXlines) notes.push(`${leftXlines} construction line${leftXlines === 1 ? '' : 's'} left out.`);
  const textOut = out.join('\n') + '\n';
  return { text: textOut, bytes: new TextEncoder().encode(textOut), notes, count };
}
