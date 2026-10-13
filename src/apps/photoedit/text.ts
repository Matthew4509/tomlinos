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
];

/** The font for a canvas, from the settings (the family is one of the names above, or a stack of names). */
export function fontOf(t: TextSpec): string {
  const stack = FONT_FAMILIES.find(f => f[0] === t.family)?.[1] ?? FONT_FAMILIES[0][1];
  return `${t.italic ? 'italic ' : ''}${t.bold ? 'bold ' : ''}${Math.round(t.size)}px ${stack}`;
}

export const lineHeight = (t: TextSpec) => Math.round(t.size * 1.25);

export interface Placed {
  text: string;
  x: number;
  y: number;
  width: number;
}

/** Each line's left edge and top, for left / centre / right alignment around x. */
export function layoutText(t: TextSpec, measure: (line: string) => number): { lines: Placed[]; bounds: { x: number; y: number; w: number; h: number } } {
  const lh = lineHeight(t);
  const lines = t.text.split(/\r\n|\r|\n/).map((text, i) => {
    const width = measure(text);
    const x = t.align === 'center' ? t.x - width / 2 : t.align === 'right' ? t.x - width : t.x;
    return { text, x, y: t.y + i * lh, width };
  });
  const x0 = Math.min(...lines.map(l => l.x)), x1 = Math.max(...lines.map(l => l.x + l.width));
  return { lines, bounds: { x: Math.floor(x0), y: Math.floor(t.y), w: Math.ceil(x1 - x0) || 1, h: lines.length * lh } };
}
