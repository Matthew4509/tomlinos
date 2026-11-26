// Small toolbar and menu pictures, 16 by 16, drawn for this desktop from plain lines, boxes and circles. One house
// style throughout: 1 px outlines in the text colour (currentColor) laid on the half pixel so they land on whole screen
// pixels at 1x and 2x, round joins, and one spot of the theme's accent colour (class "ti-acc", coloured by the
// stylesheet) for the part that says what the button does. Without the stylesheet the accent falls back to the text
// colour, so a picture is never lost. The big desktop icons are in icons.ts; these are only for bars and menus.
import { svg } from '../core/dom.ts';

export const TOOL_ICON_IDS = [
  'new', 'open', 'save', 'save-as', 'print', 'print-preview', 'close',
  'undo', 'redo', 'cut', 'copy', 'paste', 'delete', 'find', 'replace', 'select-all',
  'bold', 'italic', 'underline', 'strikethrough', 'font-colour', 'highlight',
  'align-left', 'align-centre', 'align-right', 'justify', 'bullets', 'numbering', 'indent', 'outdent',
  'insert-picture', 'insert-table', 'insert-link', 'page-setup',
  'zoom-in', 'zoom-out', 'zoom-fit', 'refresh', 'properties', 'help',
  'new-folder', 'up-folder', 'back', 'forward', 'recycle', 'restore',
  'sort', 'filter', 'sum', 'chart', 'play', 'pause', 'stop', 'rename', 'settings',
] as const;

export type ToolIconId = (typeof TOOL_ICON_IDS)[number];

/** One drawn part: a tag (path, rect, circle) and its attributes. `acc` marks the accent part; `fill` fills it. */
export interface Part {
  tag: 'path' | 'rect' | 'circle';
  attrs: Record<string, string>;
  /** Filled rather than outlined. */
  fill?: boolean;
  /** Drawn in the accent colour. */
  acc?: boolean;
  /** Line width other than 1. */
  w?: number;
}

const p = (d: string, more: Partial<Part> = {}): Part => ({ tag: 'path', attrs: { d }, ...more });
const r = (x: number, y: number, width: number, height: number, more: Partial<Part> = {}, rx = 0): Part => ({
  tag: 'rect',
  attrs: { x: String(x), y: String(y), width: String(width), height: String(height), ...(rx ? { rx: String(rx) } : {}) },
  ...more,
});
const c = (cx: number, cy: number, radius: number, more: Partial<Part> = {}): Part => ({ tag: 'circle', attrs: { cx: String(cx), cy: String(cy), r: String(radius) }, ...more });
const A = { acc: true };
const AF = { acc: true, fill: true };
const F = { fill: true };

/** A cog: eight square-shouldered teeth round a ring, worked out once (rounded to a tenth of a pixel). */
function cog(): string {
  const parts: string[] = [];
  const teeth = 8;
  const outer = 6.8;
  const inner = 4.9;
  const step = (Math.PI * 2) / teeth;
  const half = step * 0.22;
  const at = (radius: number, angle: number) => `${(8 + radius * Math.cos(angle)).toFixed(1)} ${(8 + radius * Math.sin(angle)).toFixed(1)}`;
  for (let i = 0; i < teeth; i++) {
    const mid = i * step - Math.PI / 2;
    parts.push(`${i ? 'L' : 'M'}${at(inner, mid - step / 2 + half * 0.4)}`, `L${at(inner, mid - half)}`, `L${at(outer, mid - half * 0.75)}`, `L${at(outer, mid + half * 0.75)}`, `L${at(inner, mid + half)}`);
  }
  return parts.join(' ') + 'Z';
}

/** A page with its top right corner folded over, at x..x+w, y..y+h. */
const page = (x: number, y: number, w: number, h: number, fold = 3): Part[] => [
  p(`M${x} ${y}h${w - fold}l${fold} ${fold}v${h - fold}h${-w}z`),
  p(`M${x + w - fold} ${y}v${fold}h${fold}`),
];

const SHAPES: Record<ToolIconId, Part[]> = {
  // Files
  new: [...page(2.5, 2.5, 8, 12), p('M13.5 0.5v5M11 3h5', A)],
  open: [p('M1.5 13.5v-10h4l1.5 1.5h5.5v2.5'), p('M1.5 13.5l2.5-6h11l-2.5 6z', AF), p('M1.5 13.5l2.5-6h11l-2.5 6z')],
  save: [p('M2.5 2.5h9l2 2v9h-11z'), r(5.5, 2.5, 5, 3), r(4.5, 8.5, 7, 5, AF), p('M4.5 8.5h7v5h-7z')],
  'save-as': [p('M1.5 1.5h8l2 2v4M1.5 1.5v10h5'), r(4.5, 1.5, 4, 2.5), p('M8 14.5l1-3 4.5-4.5 2 2-4.5 4.5z', AF), p('M8 14.5l1-3 4.5-4.5 2 2-4.5 4.5z')],
  print: [r(4.5, 1.5, 7, 4), p('M4.5 11.5h-3v-6h13v6h-3'), r(4.5, 9.5, 7, 5), p('M6.5 11.5h3M6.5 12.5h2'), r(12, 7, 1, 1, AF)],
  'print-preview': [p('M7.5 14.5h-5v-13h6l3 3v1.5'), p('M8.5 1.5v3h3'), c(10, 10, 2.75, A), p('M12 12l2.5 2.5', { acc: true, w: 1.5 })],
  close: [r(2.5, 2.5, 11, 11, {}, 1), p('M5.5 5.5l5 5M10.5 5.5l-5 5', { acc: true, w: 1.5 })],
  // Edit
  undo: [p('M4.5 6.5h5.5a3.5 3.5 0 0 1 0 7h-3.5'), p('M1 6.5l4-4v8z', AF)],
  redo: [p('M11.5 6.5h-5.5a3.5 3.5 0 0 0 0 7h3.5'), p('M15 6.5l-4-4v8z', AF)],
  cut: [c(4.5, 12, 2.25, A), c(11.5, 12, 2.25, A), p('M6 10.3l6-8.8M10 10.3l-6-8.8')],
  copy: [p('M5.5 5.5v-4h8v9h-3'), r(2.5, 5.5, 8, 9), p('M4.5 8.5h4M4.5 10.5h4M4.5 12.5h3', A)],
  paste: [p('M5 2.5h-2.5v12h5M9 2.5h2.5v4'), r(5, 1, 4, 3, {}, 0.5), r(7.5, 6.5, 7, 8), p('M9.5 9.5h3M9.5 11.5h3', A)],
  delete: [p('M3.5 3.5l9 9M12.5 3.5l-9 9', { acc: true, w: 2 })],
  find: [c(6.5, 6.5, 4.5), p('M10 10l4.5 4.5', { acc: true, w: 2 })],
  replace: [r(1.5, 1.5, 5, 5), r(9.5, 9.5, 5, 5, AF), p('M8.5 3.5h3.5v3'), p('M10.5 6.5l1.5 2 1.5-2z', F), p('M7.5 12.5h-3.5v-3'), p('M2.5 9.5l1.5-2 1.5 2z', F)],
  'select-all': [r(1.5, 1.5, 13, 13, {}), r(4, 4, 8, 8, AF)],
  // Format
  bold: [p('M5 3h3.5a2.5 2.5 0 0 1 0 5H5M5 8h4a2.5 2.5 0 0 1 0 5H5V3', { w: 2 })],
  italic: [p('M7 2.5h5M4 13.5h5M9.5 2.5l-3 11', { w: 1.5 })],
  underline: [p('M4.5 2v6a3.5 3.5 0 0 0 7 0v-6'), p('M3 14.5h10', A)],
  strikethrough: [p('M11.5 4.5c-.5-1.5-2-2-3.5-2-2 0-3.5 1-3.5 2.6M4.5 11c.6 1.5 2 2.1 3.6 2.1 2 0 3.5-1.2 3.5-2.8 0-.7-.3-1.3-.8-1.8'), p('M2 8.5h12', A)],
  'font-colour': [p('M3.5 11l4.5-9.5 4.5 9.5M5.2 7.5h5.6'), r(2, 13, 12, 2, AF)],
  highlight: [p('M6 10l6-7 2 2-7 6zM6 10l-2 2 1 1 2-2'), r(1, 13.5, 14, 2, AF)],
  'align-left': [p('M2 3.5h12M2 6.5h8M2 9.5h12M2 12.5h8')],
  'align-centre': [p('M2 3.5h12M4 6.5h8M2 9.5h12M4 12.5h8')],
  'align-right': [p('M2 3.5h12M6 6.5h8M2 9.5h12M6 12.5h8')],
  justify: [p('M2 3.5h12M2 6.5h12M2 9.5h12M2 12.5h12')],
  bullets: [c(3.5, 3.5, 1.5, AF), c(3.5, 8.5, 1.5, AF), c(3.5, 13.5, 1.5, AF), p('M6.5 3.5h7.5M6.5 8.5h7.5M6.5 13.5h7.5')],
  numbering: [p('M2.5 3.5l1.5-1.5v5', A), p('M2 10.5c0-1.4 3-1.4 3 0 0 1-3 2-3 3.5h3', A), p('M7.5 3.5h6.5M7.5 5.5h4.5M7.5 10.5h6.5M7.5 12.5h4.5')],
  indent: [p('M7 3.5h7M7 6.5h7M7 9.5h7M2 12.5h12'), p('M2 3.5l3.5 3-3.5 3z', AF)],
  outdent: [p('M7 3.5h7M7 6.5h7M7 9.5h7M2 12.5h12'), p('M5.5 3.5l-3.5 3 3.5 3z', AF)],
  // Insert
  'insert-picture': [r(1.5, 2.5, 13, 11), p('M2.5 12.5l3.5-4 3 3 2-2 3 3'), c(11, 5.5, 1.5, AF)],
  'insert-table': [r(1.5, 2.5, 13, 11), r(2, 3, 12, 3, AF), p('M1.5 6.5h13M1.5 10h13M6 6.5v7M10 6.5v7')],
  'insert-link': [r(1.5, 5.5, 7, 5, {}, 2.5), r(7.5, 5.5, 7, 5, A, 2.5)],
  'page-setup': [r(3.5, 1.5, 9, 13), r(5.5, 3.5, 5, 9, A), p('M7.5 6h1M7.5 8h1M7.5 10h1')],
  // View
  'zoom-in': [c(6.5, 6.5, 4.5), p('M10 10l4.5 4.5', { w: 2 }), p('M4.5 6.5h4M6.5 4.5v4', A)],
  'zoom-out': [c(6.5, 6.5, 4.5), p('M10 10l4.5 4.5', { w: 2 }), p('M4.5 6.5h4', A)],
  'zoom-fit': [p('M1.5 5V1.5H5M11 1.5h3.5V5M14.5 11v3.5H11M5 14.5H1.5V11'), r(5.5, 5.5, 5, 5, A)],
  refresh: [p('M13.5 8.5a5.5 5.5 0 1 1-1.6-3.9'), p('M14.5 1.5v5h-5z', AF)],
  properties: [r(2.5, 1.5, 11, 13), r(4.5, 4, 2, 2, AF), r(4.5, 8, 2, 2, AF), p('M8 5h3.5M8 9h3.5M4.5 12.5h7')],
  help: [c(8, 8, 6.5), p('M6 6.2a2 2 0 1 1 2.8 1.8c-.6.3-.8.7-.8 1.3v.7', { acc: true, w: 1.5 }), r(7.25, 11, 1.5, 1.5, AF)],
  // Folders and going about
  'new-folder': [p('M9.5 6H7L5.5 4.5h-4v9h12V8.5'), p('M13 0.5v6M10 3.5h6', A)],
  'up-folder': [p('M1.5 13.5v-10h4l1.5 1.5h7.5v8.5z'), p('M8 12V7.5M5.5 10L8 7.5l2.5 2.5', { acc: true, w: 1.5 })],
  back: [p('M13.5 8h-10M7.5 3.5L3 8l4.5 4.5', { acc: true, w: 2 })],
  forward: [p('M2.5 8h10M8.5 3.5L13 8l-4.5 4.5', { acc: true, w: 2 })],
  recycle: [p('M2 4.5h12M6 4.5v-2h4v2'), p('M3.5 4.5l1 10h7l1-10'), p('M6.5 7v5.5M9.5 7v5.5', A)],
  restore: [p('M3.5 9.5h9M4.5 9.5l.7 5h5.6l.7-5'), p('M8 8V1.5M5.5 4L8 1.5 10.5 4', { acc: true, w: 1.5 })],
  // Data
  sort: [p('M4 2v11M1.5 10.5L4 13l2.5-2.5', A), p('M8 3.5h6M8 6.5h4.5M8 9.5h3M8 12.5h1.5')],
  filter: [p('M1.5 2.5h13l-5 6v5l-3 1.5v-6.5z', AF), p('M1.5 2.5h13l-5 6v5l-3 1.5v-6.5z')],
  sum: [p('M12 4V2.5H3.5L8 8l-4.5 5.5H12V12', { w: 1.5 })],
  chart: [p('M1.5 1.5v13h13'), r(4, 8, 2, 5, F), r(7.5, 4, 2, 9, AF), r(11, 6, 2, 7, F)],
  // Media
  play: [p('M4.5 2.5v11l9-5.5z', AF), p('M4.5 2.5v11l9-5.5z')],
  pause: [r(3.5, 2.5, 3, 11, AF), r(3.5, 2.5, 3, 11), r(9.5, 2.5, 3, 11, AF), r(9.5, 2.5, 3, 11)],
  stop: [r(3.5, 3.5, 9, 9, AF), r(3.5, 3.5, 9, 9)],
  // Other
  rename: [p('M8.5 4.5h-7v7h7M12.5 4.5h2v7h-2'), p('M3.5 8h3'), p('M10.5 2.5v11M9 2.5h3M9 13.5h3', A)],
  settings: [p(cog()), c(8, 8, 2, A)],
};

/** The parts of a picture, for the tests and anything else that wants to read the drawing. */
export function toolIconParts(id: ToolIconId): readonly Part[] {
  return SHAPES[id];
}

export function isToolIconId(id: string): id is ToolIconId {
  return Object.hasOwn(SHAPES, id);
}

function partAttrs(part: Part): Record<string, string> {
  const paint = 'currentColor';
  const out: Record<string, string> = { ...part.attrs };
  if (part.fill) {
    out.fill = paint;
    out.stroke = 'none';
  } else {
    out.fill = 'none';
    out.stroke = paint;
    if (part.w && part.w !== 1) out['stroke-width'] = String(part.w);
  }
  if (part.acc) out.class = part.fill ? 'ti-acc' : 'ti-acc-line';
  return out;
}

/** The picture as SVG text (for a sheet of them, or a test that parses it). */
export function toolIconMarkup(id: ToolIconId, size = 16): string {
  const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const body = SHAPES[id]
    .map(part => `<${part.tag} ${Object.entries(partAttrs(part)).map(([k, v]) => `${k}="${esc(v)}"`).join(' ')}/>`)
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="${size}" height="${size}" class="ti ti-${id}" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

/** The picture as an element, 16 px unless asked otherwise. It is decoration: the button or menu item carries the name. */
export function toolIcon(id: ToolIconId, size = 16): SVGElement {
  return svg(
    'svg',
    { viewBox: '0 0 16 16', width: size, height: size, class: `ti ti-${id}`, 'stroke-width': '1', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' },
    ...SHAPES[id].map(part => svg(part.tag, partAttrs(part))),
  );
}
