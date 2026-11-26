// Text layers: where each line goes, from the text's settings and a way to measure a line. No browser needed (the
// app passes the canvas's own measureText).
import type { TextSpec } from './ora.ts';

export const FONT_FAMILIES: Array<[string, string]> = [
  ['Sans serif', 'system-ui, "Segoe UI", Arial, sans-serif'],
  ['Serif', 'Georgia, "Times New Roman", serif'],
  ['Monospace', 'Consolas, "Courier New", monospace'],
  ['Arial', 'Arial, Helvetica, sans-serif'],
  ['Georgia', 'Georgia, serif'],
  ['Times New Roman', '"Times New Roman", Times, serif'],
  ['Verdana', 'Verdana, Geneva, sans-serif'],
  ['Trebuchet MS', '"Trebuchet MS", sans-serif'],
  ['Courier New', '"Courier New", monospace'],
  ['Impact', 'Impact, "Arial Black", sans-serif'],
  ['Comic Sans MS', '"Comic Sans MS", "Comic Sans", cursive'],
  // A heavy sans that Windows and macOS have; elsewhere the system's own bold sans-serif. Nothing is downloaded.
  ['Arial Black', '"Arial Black", "Arial Bold", Gadget, "Helvetica Neue", Arial, "Liberation Sans", "DejaVu Sans", sans-serif'],
];

/** The font for a canvas, from the settings (the family is one of the names above, or a stack of names). */
export function fontOf(t: TextSpec): string {
  const stack = FONT_FAMILIES.find(f => f[0] === t.family)?.[1] ?? FONT_FAMILIES[0][1];
  return `${t.italic ? 'italic ' : ''}${t.bold ? 'bold ' : ''}${Math.round(t.size)}px ${stack}`;
}

export const lineHeight = (t: TextSpec) => Math.round(t.size * 1.25);

/** The outline width that suits a text size when none is chosen: a twelfth of it, 1 to 20 pixels. */
export const autoOutline = (size: number) => Math.min(20, Math.max(1, Math.round(size / 12)));

/** How far the outline reaches outside the letters (0: no outline). */
export function outlineWidth(t: TextSpec): number {
  if (!t.outline) return 0;
  return t.outline.width > 0 ? Math.min(20, Math.max(1, Math.round(t.outline.width))) : autoOutline(t.size);
}

export interface Placed {
  text: string;
  x: number;
  y: number;
  width: number;
}

/**
 * The words broken into lines no wider than `room` (a word too long for a line keeps a line of its own). Lines the
 * person broke with Enter stay broken.
 */
export function wrapWords(text: string, room: number, measure: (line: string) => number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\r\n|\r|\n/)) {
    const words = para.split(/ +/).filter(w => w !== '');
    if (!words.length) {
      out.push('');
      continue;
    }
    let line = words[0];
    for (const word of words.slice(1)) {
      const next = `${line} ${word}`;
      if (measure(next) <= room) line = next;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

/** The smallest and largest size a text box fits its words to. */
export const FIT_MIN = 6;
export const FIT_MAX = 400;

/**
 * The largest whole size (FIT_MIN to FIT_MAX) at which the words, wrapped, fit inside the box with their outline.
 * `measure100` gives a line's width at size 100 (widths grow in step with the size).
 */
export function fitSize(t: TextSpec, measure100: (line: string) => number): number {
  const box = t.box;
  if (!box) return t.size;
  const fits = (s: number) => {
    const ow = t.outline ? (t.outline.width > 0 ? Math.min(20, t.outline.width) : autoOutline(s)) : 0;
    const room = box.w - 2 * ow;
    if (room <= 0) return false;
    const m = (line: string) => (measure100(line) * s) / 100;
    const lines = wrapWords(t.text, room, m);
    return lines.every(l => m(l) <= room) && lines.length * Math.round(s * 1.25) + 2 * ow <= box.h;
  };
  let lo = FIT_MIN;
  let hi = Math.max(FIT_MIN, Math.min(FIT_MAX, Math.floor(box.h / 1.25)));
  if (!t.text.trim() || fits(hi)) return hi;
  if (!fits(lo)) return lo;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** The settings as drawn: a box whose words fit themselves gets the size that fits. */
export function sizedText(t: TextSpec, measure100: (line: string) => number): TextSpec {
  return t.box?.fit ? { ...t, size: fitSize(t, measure100) } : t;
}

/**
 * Each line's left edge and top. Plain text lines up left, centre or right around x. Text in a box (a meme's) is
 * wrapped to the box's width and stands in the middle of the box from top to bottom, lined up inside it.
 */
export function layoutText(t: TextSpec, measure: (line: string) => number): { lines: Placed[]; bounds: { x: number; y: number; w: number; h: number } } {
  const lh = lineHeight(t);
  if (t.box) {
    const box = t.box;
    const ow = outlineWidth(t);
    const words = wrapWords(t.text, box.w - 2 * ow, measure);
    const top = t.y + (box.h - words.length * lh) / 2;
    const lines = words.map((text, i) => {
      const width = measure(text);
      const x = t.align === 'left' ? t.x + ow : t.align === 'right' ? t.x + box.w - ow - width : t.x + (box.w - width) / 2;
      return { text, x, y: top + i * lh, width };
    });
    // The box itself, and anything that spills out of it (words too long for a size chosen by hand).
    const x0 = Math.min(t.x, ...lines.map(l => l.x - ow)), x1 = Math.max(t.x + box.w, ...lines.map(l => l.x + l.width + ow));
    const y0 = Math.min(t.y, top - ow), y1 = Math.max(t.y + box.h, top + lines.length * lh + ow);
    return { lines, bounds: { x: Math.floor(x0), y: Math.floor(y0), w: Math.ceil(x1 - x0) || 1, h: Math.ceil(y1 - y0) || 1 } };
  }
  const lines = t.text.split(/\r\n|\r|\n/).map((text, i) => {
    const width = measure(text);
    const x = t.align === 'center' ? t.x - width / 2 : t.align === 'right' ? t.x - width : t.x;
    return { text, x, y: t.y + i * lh, width };
  });
  const x0 = Math.min(...lines.map(l => l.x)), x1 = Math.max(...lines.map(l => l.x + l.width));
  return { lines, bounds: { x: Math.floor(x0), y: Math.floor(t.y), w: Math.ceil(x1 - x0) || 1, h: lines.length * lh } };
}
