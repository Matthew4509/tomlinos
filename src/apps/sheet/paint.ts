// Drawing that does not care where it lands: charts and printed pages are drawn through a Painter, which the screen
// (SVG), the PDF writer (pdf.ts) and the tests (a recorder) each implement. Text is measured with Helvetica's own
// widths (Arial has the same), so a chart lays out the same in the window, on paper and in a PDF.
// No browser needed here; the SVG painter is the only part that makes elements.
import { svg } from '../../core/dom.ts';
import type { FontKind } from './fonts.ts';

export interface TextLook {
  size: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  colour?: string;
  /** Where x is: the left end (default), the middle or the right end of the text. */
  align?: 'l' | 'c' | 'r';
  /** Turned this many degrees (-90 reads upwards, as a value axis title does). */
  rotate?: number;
  /** Plain (Helvetica, the default), with serifs (Times) or fixed-width (Courier). */
  kind?: FontKind;
  strike?: boolean;
}

/** y for text is the middle of the line (where a capital letter's middle sits). */
export interface Painter {
  rect(x: number, y: number, w: number, h: number, fill: string | null, stroke?: string | null, width?: number): void;
  /** An open line through the points [x0, y0, x1, y1, ...]. */
  line(points: number[], stroke: string, width?: number, dash?: number[]): void;
  /** A closed shape through the points. */
  shape(points: number[], fill: string | null, stroke?: string | null, width?: number): void;
  circle(cx: number, cy: number, r: number, fill: string | null, stroke?: string | null, width?: number): void;
  text(x: number, y: number, text: string, look: TextLook): void;
  /** Everything drawn until the matching unclip() stays inside this box. */
  clip(x: number, y: number, w: number, h: number): void;
  unclip(): void;
}

// Helvetica's widths (thousandths of the type size) for the characters 32 to 126; the same in Arial.
const REGULAR = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667,
  611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833,
  556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667,
  611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889,
  611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/** A letter with an accent is as wide as the letter without it; anything else unknown counts as a digit. */
function widthOf(ch: string, table: number[]): number {
  const code = ch.charCodeAt(0);
  if (code >= 32 && code <= 126) return table[code - 32];
  const bare = ch.normalize('NFD')[0];
  if (bare && bare !== ch && bare.charCodeAt(0) >= 32 && bare.charCodeAt(0) <= 126) return table[bare.charCodeAt(0) - 32];
  if (code === 0x20ac) return 556;
  if (code === 0xa0) return 278;
  return code > 0x2e80 ? 1000 : 556;
}

/** How wide the text is at this size, in the same units as the size (Courier is 600 a character; Times a little narrower than Helvetica). */
export function textWidth(text: string, size: number, bold = false, kind: FontKind = 'sans'): number {
  if (kind === 'mono') return ([...text].length * 600 * size) / 1000;
  const table = bold ? BOLD : REGULAR;
  let w = 0;
  for (const ch of text) w += widthOf(ch, table);
  return ((kind === 'serif' ? 0.9 : 1) * w * size) / 1000;
}

/** The text cut to fit `width`, ending in "…" when it was cut. */
export function fitText(text: string, width: number, size: number, bold = false): string {
  if (textWidth(text, size, bold) <= width) return text;
  const chars = [...text];
  while (chars.length && textWidth(chars.join('') + '…', size, bold) > width) chars.pop();
  return chars.length ? chars.join('') + '…' : '';
}

/** Text laid out in lines no wider than `width`, broken between words (a word too long for a line is cut). */
export function wrapText(text: string, width: number, size: number, bold = false, most = 60, kind: FontKind = 'sans'): string[] {
  const out: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    let line = '';
    for (const word of para.split(/(?<= )/)) {
      if (line === '' || textWidth(line + word, size, bold, kind) <= width) line += word;
      else {
        out.push(line.trimEnd());
        line = word;
      }
      while (textWidth(line, size, bold, kind) > width && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && textWidth(line.slice(0, cut), size, bold, kind) > width) cut--;
        out.push(line.slice(0, cut));
        line = line.slice(cut);
        if (out.length >= most) return out;
      }
      if (out.length >= most) return out;
    }
    out.push(line.trimEnd());
    if (out.length >= most) return out;
  }
  return out;
}

const FONT = 'Helvetica, Arial, "Liberation Sans", sans-serif';
const FAMILY: Record<FontKind, string> = { sans: FONT, serif: '"Times New Roman", Times, "Liberation Serif", serif', mono: '"Courier New", Courier, "Liberation Mono", monospace' };
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Draws into an <svg> (the chart on the grid, a page in print preview and on paper). */
export class SvgPainter implements Painter {
  readonly root: SVGElement;
  private stack: SVGElement[];
  private clips = 0;
  private static next = 0;
  private readonly prefix: string;

  constructor(width: number, height: number, attrs: Record<string, string> = {}) {
    this.root = svg('svg', { viewBox: `0 0 ${r2(width)} ${r2(height)}`, width: r2(width), height: r2(height), ...attrs });
    this.stack = [this.root];
    this.prefix = `pc${++SvgPainter.next}`;
  }

  private add(el: SVGElement): void {
    this.stack[this.stack.length - 1].append(el);
  }

  private paint(fill: string | null, stroke?: string | null, width?: number): Record<string, string | number> {
    return { fill: fill ?? 'none', stroke: stroke ?? 'none', 'stroke-width': stroke ? (width ?? 1) : 0 };
  }

  rect(x: number, y: number, w: number, h: number, fill: string | null, stroke?: string | null, width?: number): void {
    this.add(svg('rect', { x: r2(x), y: r2(y), width: r2(Math.max(0, w)), height: r2(Math.max(0, h)), ...this.paint(fill, stroke, width) }));
  }

  line(points: number[], stroke: string, width = 1, dash?: number[]): void {
    this.add(svg('polyline', { points: points.map(r2).join(' '), fill: 'none', stroke, 'stroke-width': width, 'stroke-dasharray': dash?.join(' '), 'stroke-linejoin': 'round' }));
  }

  shape(points: number[], fill: string | null, stroke?: string | null, width?: number): void {
    this.add(svg('polygon', { points: points.map(r2).join(' '), ...this.paint(fill, stroke, width), 'stroke-linejoin': 'round' }));
  }

  circle(cx: number, cy: number, r: number, fill: string | null, stroke?: string | null, width?: number): void {
    this.add(svg('circle', { cx: r2(cx), cy: r2(cy), r: r2(r), ...this.paint(fill, stroke, width) }));
  }

  text(x: number, y: number, text: string, look: TextLook): void {
    const t = svg('text', {
      x: r2(x), y: r2(y), 'font-family': FAMILY[look.kind ?? 'sans'], 'font-size': r2(look.size), 'font-weight': look.bold ? 'bold' : undefined,
      'font-style': look.italic ? 'italic' : undefined,
      'text-decoration': look.underline || look.strike ? [look.underline ? 'underline' : '', look.strike ? 'line-through' : ''].filter(Boolean).join(' ') : undefined,
      fill: look.colour ?? '#000', 'text-anchor': look.align === 'c' ? 'middle' : look.align === 'r' ? 'end' : 'start',
      'dominant-baseline': 'central', transform: look.rotate ? `rotate(${look.rotate} ${r2(x)} ${r2(y)})` : undefined,
    }, text);
    this.add(t);
  }

  clip(x: number, y: number, w: number, h: number): void {
    const id = `${this.prefix}c${++this.clips}`;
    const cp = svg('clipPath', { id }, svg('rect', { x: r2(x), y: r2(y), width: r2(Math.max(0, w)), height: r2(Math.max(0, h)) }));
    this.add(cp);
    const g = svg('g', { 'clip-path': `url(#${id})` });
    this.add(g);
    this.stack.push(g);
  }

  unclip(): void {
    if (this.stack.length > 1) this.stack.pop();
  }
}

/** Keeps every call, for tests: what was drawn, in order. */
export class RecordPainter implements Painter {
  ops: Array<{ op: string; args: unknown[] }> = [];
  rect(...args: unknown[]): void { this.ops.push({ op: 'rect', args }); }
  line(...args: unknown[]): void { this.ops.push({ op: 'line', args }); }
  shape(...args: unknown[]): void { this.ops.push({ op: 'shape', args }); }
  circle(...args: unknown[]): void { this.ops.push({ op: 'circle', args }); }
  text(...args: unknown[]): void { this.ops.push({ op: 'text', args }); }
  clip(...args: unknown[]): void { this.ops.push({ op: 'clip', args }); }
  unclip(): void { this.ops.push({ op: 'unclip', args: [] }); }
  /** Every text drawn. */
  texts(): string[] {
    return this.ops.filter(o => o.op === 'text').map(o => String(o.args[2]));
  }
}

/** A colour part way between two (#rrggbb), t from 0 to 1. */
export function mixColour(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map(i => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map(i => parseInt(b.slice(i, i + 2), 16));
  return `#${pa.map((v, i) => Math.round(v + (pb[i] - v) * Math.max(0, Math.min(1, t))).toString(16).padStart(2, '0')).join('')}`;
}

/** Draws through another painter, moved to (ox, oy) and made k times the size: a chart placed on a printed page. */
export class OffsetPainter implements Painter {
  private inner: Painter;
  private ox: number;
  private oy: number;
  private k: number;
  constructor(inner: Painter, ox: number, oy: number, k: number) {
    this.inner = inner;
    this.ox = ox;
    this.oy = oy;
    this.k = k;
  }
  private pts(points: number[]): number[] {
    return points.map((v, i) => (i % 2 ? this.oy + v * this.k : this.ox + v * this.k));
  }
  rect(x: number, y: number, w: number, h: number, fill: string | null, stroke?: string | null, width = 1): void {
    this.inner.rect(this.ox + x * this.k, this.oy + y * this.k, w * this.k, h * this.k, fill, stroke, width * this.k);
  }
  line(points: number[], stroke: string, width = 1, dash?: number[]): void {
    this.inner.line(this.pts(points), stroke, width * this.k, dash?.map(d => d * this.k));
  }
  shape(points: number[], fill: string | null, stroke?: string | null, width = 1): void {
    this.inner.shape(this.pts(points), fill, stroke, width * this.k);
  }
  circle(cx: number, cy: number, r: number, fill: string | null, stroke?: string | null, width = 1): void {
    this.inner.circle(this.ox + cx * this.k, this.oy + cy * this.k, r * this.k, fill, stroke, width * this.k);
  }
  text(x: number, y: number, text: string, look: TextLook): void {
    this.inner.text(this.ox + x * this.k, this.oy + y * this.k, text, { ...look, size: look.size * this.k });
  }
  clip(x: number, y: number, w: number, h: number): void {
    this.inner.clip(this.ox + x * this.k, this.oy + y * this.k, w * this.k, h * this.k);
  }
  unclip(): void {
    this.inner.unclip();
  }
}
