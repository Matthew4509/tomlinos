// The small pictures on the Classic look's toolbars, 16 by 16, drawn here from plain shapes (pages, a folder, a
// disk, arrows, letters). Our own drawings: none is copied from another program's icons.
import { svg } from '../../core/dom.ts';

const INK = '#3b3b3b';
const EDGE = '#6b6b6b';
const BLUE = '#2f6fd0';
const GREEN = '#1e7a45';
const FONT = 'Segoe UI, Arial, Helvetica, sans-serif';

const rect = (x: number, y: number, w: number, h: number, fill: string, stroke = 'none', extra: Record<string, string | number> = {}) =>
  svg('rect', { x, y, width: w, height: h, fill, stroke, 'stroke-width': 1, ...extra });
const path = (d: string, fill = 'none', stroke = 'none', width = 1) =>
  svg('path', { d, fill, stroke, 'stroke-width': width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
const text = (t: string, x: number, y: number, size: number, extra: Record<string, string | number> = {}) =>
  svg('text', { x, y, 'font-size': size, 'font-family': FONT, 'text-anchor': 'middle', fill: INK, ...extra }, t);
const circle = (cx: number, cy: number, r: number, fill: string, stroke = 'none', width = 1) => svg('circle', { cx, cy, r, fill, stroke, 'stroke-width': width });

/** Three lines of text, lined up at the left, the middle or the right. */
const lines = (side: 'l' | 'c' | 'r') => [3.5, 6.5, 9.5, 12.5].map((y, i) => {
  const w = i % 2 ? 8 : 12;
  const x = side === 'l' ? 2 : side === 'r' ? 14 - w : 8 - w / 2;
  return path(`M${x} ${y}h${w}`, 'none', INK, 1.2);
});

const DRAW = {
  new: () => [path('M3.5 1.5h6l3 3v10h-9z', '#fff', EDGE), path('M9.5 1.5v3h3', 'none', EDGE)],
  open: () => [
    path('M1.5 13.5v-10h4l1.5 1.5h5v2.5', '#e2b33c', '#a77d12'),
    path('M1.5 13.5l2.5-6h11l-2.5 6z', '#f6cf5a', '#a77d12'),
  ],
  save: () => [
    rect(1.5, 1.5, 13, 13, BLUE, '#1b3f7a', { rx: 1 }),
    rect(4, 2, 8, 4.5, '#fff'),
    rect(9.5, 2.8, 1.5, 2.8, BLUE),
    rect(4.5, 9.5, 7, 5, '#dfe6f0'),
  ],
  print: () => [
    rect(4.5, 1.5, 7, 5, '#fff', EDGE),
    rect(1.5, 6.5, 13, 5.5, '#cfcfcf', EDGE, { rx: 1 }),
    rect(4.5, 10.5, 7, 4, '#fff', EDGE),
    circle(12.2, 8.2, 0.8, GREEN),
  ],
  cut: () => [
    path('M6 10.6L11 1.5M10 10.6L5 1.5', 'none', '#555', 1.3),
    circle(5, 12.5, 2, '#fff', '#c42b1c', 1.3),
    circle(11, 12.5, 2, '#fff', '#c42b1c', 1.3),
  ],
  copy: () => [
    rect(1.5, 1.5, 8, 10, '#fff', EDGE),
    path('M3.5 4.5h4M3.5 6.5h4', 'none', '#9a9a9a'),
    rect(6.5, 4.5, 8, 10, '#fff', EDGE),
    path('M8.5 7.5h4M8.5 9.5h4M8.5 11.5h4', 'none', '#9a9a9a'),
  ],
  paste: () => [
    rect(2.5, 2.5, 9, 12, '#c8a165', '#8a6a3a', { rx: 1 }),
    rect(5, 1.5, 4, 2.5, '#9e9e9e', '#6b6b6b'),
    rect(7.5, 6.5, 7, 8, '#fff', EDGE),
    path('M9 9h4M9 11h4', 'none', '#9a9a9a'),
  ],
  painter: () => [
    rect(2.5, 1.5, 11, 4.5, '#ffd400', '#a08000', { rx: 1 }),
    path('M8 6v3', 'none', '#888', 2),
    rect(7, 9, 2, 5.5, '#8a5a2b', '#5e3c1a', { rx: 0.6 }),
  ],
  undo: () => [path('M2.5 7.5h7a3.5 3.5 0 0 1 0 7H7', 'none', BLUE, 1.6), path('M5.5 4.5l-3 3 3 3', 'none', BLUE, 1.6)],
  redo: () => [path('M13.5 7.5h-7a3.5 3.5 0 0 0 0 7H9', 'none', BLUE, 1.6), path('M10.5 4.5l3 3-3 3', 'none', BLUE, 1.6)],
  sortAZ: () => [text('A', 5, 7, 7, { 'font-weight': 700 }), text('Z', 5, 15, 7, { 'font-weight': 700 }), path('M12 2.5v11M9.5 11l2.5 2.5 2.5-2.5', 'none', BLUE, 1.4)],
  sortZA: () => [text('Z', 5, 7, 7, { 'font-weight': 700 }), text('A', 5, 15, 7, { 'font-weight': 700 }), path('M12 2.5v11M9.5 11l2.5 2.5 2.5-2.5', 'none', BLUE, 1.4)],
  autoSum: () => [path('M12.5 4V2.5h-9l5 5.5-5 5.5h9V12', 'none', INK, 1.5)],
  chart: () => [
    path('M1.5 1.5v13h13', 'none', EDGE),
    rect(3, 8, 3, 6, BLUE),
    rect(7, 4, 3, 10, '#ed7d31'),
    rect(11, 10, 3, 4, '#70ad47'),
  ],
  bold: () => [text('B', 8, 12.5, 12, { 'font-weight': 700 })],
  italic: () => [text('I', 8, 12.5, 12, { 'font-style': 'italic', 'font-family': 'Times New Roman, Georgia, serif', 'font-weight': 700 })],
  underline: () => [text('U', 8, 11.5, 11), rect(3.5, 13, 9, 1.3, INK)],
  alignLeft: () => lines('l'),
  alignCentre: () => lines('c'),
  alignRight: () => lines('r'),
  merge: () => [
    rect(1.5, 3.5, 13, 9, '#fff', EDGE),
    path('M3.5 8h9M5.5 6l-2 2 2 2M10.5 6l2 2-2 2', 'none', BLUE, 1.2),
  ],
  currency: () => [rect(1.5, 3.5, 13, 9, '#dcefdc', GREEN, { rx: 1 }), text('$', 8, 11.6, 9, { 'font-weight': 700, fill: GREEN })],
  percent: () => [text('%', 8, 12.5, 12, { 'font-weight': 700 })],
  comma: () => [text(',', 8, 10.5, 16, { 'font-weight': 700 })],
  decimalsMore: () => [
    path('M2 4.5h4.5M3.8 2.7L2 4.5l1.8 1.8', 'none', BLUE, 1.2),
    text('.0', 12, 7, 6.5, { 'font-weight': 700 }),
    text('.00', 9.5, 14.5, 6.5, { 'font-weight': 700 }),
  ],
  decimalsFewer: () => [
    path('M9.5 4.5H14M12.2 2.7L14 4.5l-1.8 1.8', 'none', BLUE, 1.2),
    text('.00', 5.5, 7, 6.5, { 'font-weight': 700 }),
    text('.0', 6.5, 14.5, 6.5, { 'font-weight': 700 }),
  ],
  borders: () => [
    rect(1.5, 1.5, 13, 12, 'none', '#9a9a9a', { 'stroke-dasharray': '1 1' }),
    path('M8 1.5v12M1.5 7.5h13', 'none', '#9a9a9a', 1),
    path('M1 14.5h14', 'none', '#000', 1.8),
  ],
  fill: () => [
    path('M2.5 7l4.5-4.5 4.5 4.5-4 4z', '#fff', '#555', 1.1),
    path('M2.5 7h9', 'none', '#555', 1.1),
    path('M13 7.5c.9 1.3 1.5 2.2 1.5 3a1.5 1.5 0 0 1-3 0c0-.8.6-1.7 1.5-3z', '#2f6fd0'),
  ],
  fontColour: () => [text('A', 8, 11, 12, { 'font-weight': 700 })],
} satisfies Record<string, () => SVGElement[]>;

export type ClassicIcon = keyof typeof DRAW;

/** One toolbar picture, 16 by 16; screen readers skip it (its button carries the name). */
export function classicIcon(name: ClassicIcon): SVGElement {
  return svg('svg', { class: 'tb-icon', width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' }, ...DRAW[name]());
}
