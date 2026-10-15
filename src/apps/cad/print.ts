// Printing a drawing to scale: the paper, 1:1, 1:2, 1:5, 1:10 (or any 1:n) or fitted to the page, and a plain title
// block with a 50 mm check bar to measure with a ruler. A drawing too big for one sheet at that scale is printed
// across several, each with its row and column, to be trimmed on the frame and taped together. Every page is drawn
// through the Painter (sheet/paint.ts), so the preview (SVG), the browser's print and the PDF are the same drawing.
// No browser needed here.
import type { Painter } from '../sheet/paint.ts';
import { textWidth } from '../sheet/paint.ts';
import { boxOfShapes } from './edit.ts';
import { P, at, domain, type Box, type Piece, type Pt } from './geom.ts';
import { outlineOf, type Drawing, type Ent, type LineType } from './model.ts';
import { photoBox, photoOnPage, type Photo } from './photo.ts';

export type CadPaper = 'a4' | 'a3' | 'a2' | 'a1' | 'letter' | 'tabloid';
/** Sizes in millimetres, short side first. */
export const CAD_PAPERS: Record<CadPaper, { label: string; w: number; h: number }> = {
  a4: { label: 'A4 (210 x 297 mm)', w: 210, h: 297 },
  a3: { label: 'A3 (297 x 420 mm)', w: 297, h: 420 },
  a2: { label: 'A2 (420 x 594 mm)', w: 420, h: 594 },
  a1: { label: 'A1 (594 x 841 mm)', w: 594, h: 841 },
  letter: { label: 'Letter (8.5 x 11 in)', w: 215.9, h: 279.4 },
  tabloid: { label: 'Tabloid (11 x 17 in)', w: 279.4, h: 431.8 },
};

/** The usual scales offered, as n in 1:n (a part drawn 1:2 is half size on paper). */
export const CAD_SCALES = [1, 2, 5, 10, 20, 50, 100];

export interface PrintSetup {
  paper: CadPaper;
  landscape: boolean;
  /** n in 1:n (above 0), or fitted to one page. */
  scale: number | 'fit';
  /** The whole drawing, or only what the window shows. */
  what: 'all' | 'view';
  /** Each layer in its own colour (light colours darkened); off: all in black. */
  colour: boolean;
  titleBlock: boolean;
  title: string;
  drawnBy: string;
  /** The photo under the drawing printed too. */
  photo: boolean;
  /** Construction lines printed too (across the frame). */
  construction: boolean;
}

export const DEFAULT_SETUP: PrintSetup = {
  paper: 'a4', landscape: true, scale: 'fit', what: 'all', colour: false, titleBlock: true, title: '', drawnBy: '', photo: false, construction: false,
};

/** Paper edges no printer reaches, and the strip the title block takes at the bottom (mm). */
export const MARGIN = 10;
export const TITLE_H = 19;
/** Pages a print may need before it is refused (a scale too big for the paper). */
export const MAX_PAGES = 100;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PrintPlan {
  setup: PrintSetup;
  /** The paper the way round it prints (mm). */
  paperW: number;
  paperH: number;
  /** Where the drawing goes on each page (mm from the top-left). */
  area: Rect;
  /** Drawing units across one millimetre of paper. */
  perMm: number;
  /** The scale as n in 1:n (for Fit, what it came to). */
  n: number;
  rows: number;
  cols: number;
  /** The part of the drawing on each page, in reading order (top row first). */
  pages: Array<{ row: number; col: number; box: Box }>;
  /** The items printed (on showing layers; construction lines only if asked). */
  ents: Ent[];
  photo: Photo | null;
}

/** "1:5", "1:3.47", "2:1". */
export function scaleText(n: number): string {
  if (n >= 1) return `1:${Number(n.toPrecision(n < 10 ? 3 : 4))}`;
  return `${Number((1 / n).toPrecision(3))}:1`;
}

/** Plans the pages; a sentence saying why when there is nothing to print or it would take too many pages. */
export function planPrint(d: Drawing, setup: PrintSetup, view: Box | null): PrintPlan | string {
  const paper = CAD_PAPERS[setup.paper];
  const paperW = setup.landscape ? paper.h : paper.w;
  const paperH = setup.landscape ? paper.w : paper.h;
  const area: Rect = { x: MARGIN, y: MARGIN, w: paperW - 2 * MARGIN, h: paperH - 2 * MARGIN - (setup.titleBlock ? TITLE_H : 0) };
  const shownLayers = new Set(d.layers.filter(l => l.on).map(l => l.name));
  const ents = d.ents.filter(e => shownLayers.has(e.layer) && (setup.construction || e.type !== 'xline'));
  const photo = setup.photo && d.photo?.on ? d.photo : null;
  let box: Box | null;
  if (setup.what === 'view' && view) box = view;
  else {
    box = boxOfShapes(ents);
    if (photo) {
      const pb = photoBox(photo);
      box = box ? { x0: Math.min(box.x0, pb.x0), y0: Math.min(box.y0, pb.y0), x1: Math.max(box.x1, pb.x1), y1: Math.max(box.y1, pb.y1) } : pb;
    }
  }
  if (!box && ents.length) return 'Construction lines go on for ever, so they cannot set what is printed: draw something, or print What the window shows.';
  if (!box || (!ents.length && !photo)) return 'There is nothing to print: draw something first (items on hidden layers are not printed).';
  const unitMm = d.units === 'inch' ? 25.4 : 1;
  const bw = Math.max(box.x1 - box.x0, 1e-9);
  const bh = Math.max(box.y1 - box.y0, 1e-9);
  let n: number;
  // Fit enlarges a small part at most 100 times (a single point would otherwise come out at 171000000000:1).
  if (setup.scale === 'fit') n = Math.max((bw * unitMm) / area.w, (bh * unitMm) / area.h, 0.01);
  else {
    n = setup.scale;
    if (!(n > 0) || !Number.isFinite(n)) return 'The scale must be a number above 0 (5 for 1:5).';
  }
  const perMm = n / unitMm;
  const cols = setup.scale === 'fit' ? 1 : Math.max(1, Math.ceil(bw / (area.w * perMm) - 1e-9));
  const rows = setup.scale === 'fit' ? 1 : Math.max(1, Math.ceil(bh / (area.h * perMm) - 1e-9));
  if (rows * cols > MAX_PAGES) {
    return `At ${scaleText(n)} this drawing needs ${rows * cols} pages (${cols} across, ${rows} down). Choose a smaller scale (a bigger number after the 1:), bigger paper, or Fit to the page.`;
  }
  // The pages together are centred on the drawing.
  const totalW = cols * area.w * perMm;
  const totalH = rows * area.h * perMm;
  const x0 = (box.x0 + box.x1) / 2 - totalW / 2;
  const y1 = (box.y0 + box.y1) / 2 + totalH / 2;
  const pages: PrintPlan['pages'] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const px0 = x0 + c * area.w * perMm;
      const py1 = y1 - r * area.h * perMm;
      pages.push({ row: r + 1, col: c + 1, box: { x0: px0, x1: px0 + area.w * perMm, y0: py1 - area.h * perMm, y1: py1 } });
    }
  }
  return { setup, paperW, paperH, area, perMm, n, rows, cols, pages, ents, photo };
}

/** Line types on paper, in millimetres (the same at every scale, as a printed drawing has them). */
const PAPER_DASHES: Record<LineType, number[] | undefined> = { continuous: undefined, dashed: [3, 1.5], centre: [6, 1.5, 1, 1.5], hidden: [1.5, 1], dotted: [0.3, 1] };

/** A colour dark enough to read on white paper (white becomes black; very light colours are darkened). */
export function paperInk(colour: string): string {
  const v = parseInt(colour.slice(1), 16);
  const r = (v >> 16) & 255;
  const g = (v >> 8) & 255;
  const b = v & 255;
  const light = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  if (light < 0.6) return colour;
  const k = light > 0.95 ? 0 : 0.55;
  const hex = (x: number) => Math.round(x * k).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** Points along a piece close enough that no straight step strays more than `tol` (drawing units) from it. */
export function samplePiece(p: Piece, tol: number): Pt[] {
  if (p.k === 'seg') return [p.a, p.b];
  const dom = domain(p);
  if (!dom) return [];
  if (p.k === 'arc') {
    const step = p.r > tol ? 2 * Math.acos(1 - tol / p.r) : Math.PI / 2;
    const steps = Math.max(2, Math.min(4000, Math.ceil((dom[1] - dom[0]) / step)));
    const out: Pt[] = [];
    for (let i = 0; i <= steps; i++) out.push(at(p, dom[0] + ((dom[1] - dom[0]) * i) / steps));
    return out;
  }
  // Ellipses and curves: eight steps to start with, each halved while its middle strays from the straight step.
  const out: Pt[] = [at(p, dom[0])];
  const off = (m: Pt, a: Pt, b: Pt) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((m.x - a.x) * dx + (m.y - a.y) * dy) / len2)) : 0;
    return Math.hypot(m.x - a.x - dx * t, m.y - a.y - dy * t);
  };
  const span = (t0: number, a: Pt, t1: number, b: Pt, depth: number): void => {
    const tm = (t0 + t1) / 2;
    const m = at(p, tm);
    if (depth < 14 && off(m, a, b) > tol) {
      span(t0, a, tm, m, depth + 1);
      span(tm, m, t1, b, depth + 1);
    } else out.push(b);
  };
  for (let i = 0; i < 8; i++) {
    const t0 = dom[0] + ((dom[1] - dom[0]) * i) / 8;
    const t1 = dom[0] + ((dom[1] - dom[0]) * (i + 1)) / 8;
    span(t0, out[out.length - 1], t1, at(p, t1), 0);
  }
  return out;
}

/** The part of an endless line inside a box, or null when it misses it. */
function clipXline(p: Pt, d: Pt, b: Box): [Pt, Pt] | null {
  let t0 = -Infinity;
  let t1 = Infinity;
  for (const [o, dv, lo, hi] of [[p.x, d.x, b.x0, b.x1], [p.y, d.y, b.y0, b.y1]] as const) {
    if (Math.abs(dv) < 1e-15) {
      if (o < lo || o > hi) return null;
      continue;
    }
    const a = (lo - o) / dv;
    const c = (hi - o) / dv;
    t0 = Math.max(t0, Math.min(a, c));
    t1 = Math.min(t1, Math.max(a, c));
  }
  return t1 > t0 ? [P(p.x + d.x * t0, p.y + d.y * t0), P(p.x + d.x * t1, p.y + d.y * t1)] : null;
}

/** Painter units (points) per millimetre. */
export const PT = 72 / 25.4;

export interface PageExtras {
  /** Draws the photo: its three corners on the page (points) and the frame it is kept inside. */
  photo?: (p: Painter, on: { tl: Pt; tr: Pt; bl: Pt }, frame: Rect) => void;
  /** The file's name, for the title block when no title is given. */
  fileLabel: string;
  /** Today's date as the title block shows it. */
  date: string;
  units: 'mm' | 'inch';
}

/** One page of the plan, in points (the painter's units), its top-left at 0,0. */
export function drawCadPage(p: Painter, d: Drawing, plan: PrintPlan, index: number, extras: PageExtras): void {
  const page = plan.pages[index];
  const { area, perMm } = plan;
  const toPage = (q: Pt): Pt => P((area.x + (q.x - page.box.x0) / perMm) * PT, (area.y + (page.box.y1 - q.y) / perMm) * PT);
  p.rect(0, 0, plan.paperW * PT, plan.paperH * PT, '#ffffff');
  const frame: Rect = { x: area.x * PT, y: area.y * PT, w: area.w * PT, h: area.h * PT };
  if (plan.photo && extras.photo) extras.photo(p, photoOnPage(plan.photo, toPage), frame);
  p.clip(frame.x, frame.y, frame.w, frame.h);
  const layers = new Map(d.layers.map(l => [l.name, l]));
  // Steps no further than 0.02 mm from the true curve on the paper.
  const tol = 0.02 * perMm;
  const width = 0.25 * PT;
  // A margin round the page's part, so a curve crossing its edge is drawn to the edge.
  const reach = { x0: page.box.x0 - perMm, y0: page.box.y0 - perMm, x1: page.box.x1 + perMm, y1: page.box.y1 + perMm };
  for (const e of plan.ents) {
    const layer = layers.get(e.layer);
    if (!layer) continue;
    const ink = plan.setup.colour ? paperInk(layer.colour) : '#000000';
    const dash = PAPER_DASHES[layer.lineType]?.map(v => v * PT);
    if (e.type === 'point') {
      const c = toPage(e.p);
      const r = 0.8 * PT;
      p.line([c.x - r, c.y - r, c.x + r, c.y + r], ink, width);
      p.line([c.x - r, c.y + r, c.x + r, c.y - r], ink, width);
      continue;
    }
    for (const piece of outlineOf(e)) {
      let pts: Pt[];
      if (piece.k === 'xline') {
        const seg = clipXline(piece.p, piece.d, reach);
        if (!seg) continue;
        pts = seg;
      } else pts = samplePiece(piece, tol);
      if (pts.length < 2) continue;
      const flat: number[] = [];
      for (const q of pts) {
        const s = toPage(q);
        flat.push(s.x, s.y);
      }
      p.line(flat, ink, width, dash);
    }
  }
  p.unclip();
  // The frame: where several pages are trimmed and taped edge to edge.
  p.rect(frame.x, frame.y, frame.w, frame.h, null, '#000000', 0.35 * PT);
  if (plan.setup.titleBlock) titleBlock(p, plan, index, extras);
}

/** The title block along the bottom: title (and who drew it), the scale, the units, the date, the page, and the check bar. */
function titleBlock(p: Painter, plan: PrintPlan, index: number, extras: PageExtras): void {
  const { area } = plan;
  const y = (area.y + area.h + 2) * PT;
  const h = (TITLE_H - 2) * PT;
  const x = area.x * PT;
  const w = area.w * PT;
  const page = plan.pages[index];
  const many = plan.pages.length > 1;
  const title = plan.setup.title.trim() || extras.fileLabel;
  const barMm = 50;
  // Cells: title (what is left), the check bar, scale, units, date, page.
  const fixed = [(barMm + 8) * PT, 22 * PT, 16 * PT, 26 * PT, (many ? 42 : 20) * PT];
  const titleW = Math.max(30 * PT, w - fixed.reduce((a, b) => a + b, 0));
  const widths = [titleW, ...fixed];
  const scale = w / widths.reduce((a, b) => a + b, 0);
  const cells = widths.map(v => v * Math.min(1, scale));
  const line = 0.3 * PT;
  p.rect(x, y, cells.reduce((a, b) => a + b, 0), h, null, '#000000', line);
  let cx = x;
  // No words on the paper below 9 points.
  const label = (text: string, at0: number) => p.text(at0 + 1.2 * PT, y + 3 * PT, text, { size: 9, colour: '#505050' });
  const value = (text: string, at0: number, cw: number, size = 9, at1 = y + 8.6 * PT, colour = '#000000') => {
    let t = text;
    while (t.length > 1 && textWidth(t, size) > cw - 2.4 * PT) t = t.slice(0, -2) + '…';
    p.text(at0 + 1.2 * PT, at1, t, { size, colour });
  };
  const parts: Array<[string, string]> = [
    ['Title', title],
    ['', ''],
    ['Scale', scaleText(plan.n) + (plan.setup.scale === 'fit' ? ' (fit)' : '')],
    ['Units', extras.units === 'mm' ? 'mm' : 'inch'],
    ['Date', extras.date],
    ['Page', many ? `${index + 1}/${plan.pages.length}: row ${page.row}, col ${page.col}` : '1 of 1'],
  ];
  parts.forEach(([name, text], i) => {
    if (i) p.line([cx, y, cx, y + h], '#000000', line);
    if (i === 1) checkBar(p, cx, y, cells[i], barMm);
    else {
      label(name, cx);
      value(text, cx, cells[i], i === 0 ? 11 : 9);
      if (i === 0 && plan.setup.drawnBy.trim()) value(`Drawn by ${plan.setup.drawnBy.trim()}`, cx, cells[i], 9, y + 13.6 * PT, '#303030');
    }
    cx += cells[i];
  });
}

/** A bar exactly 50 mm long on the paper, marked every 10 mm: measured with a ruler, it shows the print came out to size. */
function checkBar(p: Painter, x: number, y: number, w: number, mm: number): void {
  const left = x + (w - mm * PT) / 2;
  const base = y + 6 * PT;
  p.line([left, base, left + mm * PT, base], '#000000', 0.3 * PT);
  for (let i = 0; i <= mm; i += 10) {
    const tx = left + i * PT;
    p.line([tx, base - (i % 50 ? 1.2 : 2) * PT, tx, base + (i % 50 ? 1.2 : 2) * PT], '#000000', 0.25 * PT);
  }
  p.text(x + w / 2, y + 12.6 * PT, `${mm} mm: check with a ruler`, { size: 9, colour: '#303030', align: 'c' });
}
