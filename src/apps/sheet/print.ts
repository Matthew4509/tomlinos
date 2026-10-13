// Printing a sheet: its page setup (paper, which way round, margins, scaling or fit to pages, gridlines, row and column
// headings, a print area, rows to repeat, header and footer), how the cells are cut into pages ("down, then over" as in
// Excel), and drawing one page through a Painter: on screen for print preview and printing, or into a PDF (pdf.ts).
// Sizes on paper are in points (72 to the inch); a column 64 pixels wide is 48 points, as in Excel. No browser needed.
import { chartData, drawChart } from './chart.ts';
import { cfLook } from './condfmt.ts';
import { fitText, OffsetPainter, textWidth, wrapText, type Painter } from './paint.ts';
import { fontKind } from './fonts.ts';
import { colName, MAX_COLS, MAX_ROWS } from './refs.ts';
import { CellError, type CellStyle, type Line } from './values.ts';
import type { Range, Workbook } from './workbook.ts';

const keyOf = (col: number, row: number): number => row * MAX_COLS + col;

export type Paper = 'a4' | 'letter' | 'legal' | 'a3';
export const PAPERS: Record<Paper, { label: string; w: number; h: number; code: number }> = {
  a4: { label: 'A4 (210 × 297 mm)', w: 595.28, h: 841.89, code: 9 },
  letter: { label: 'Letter (8.5 × 11 in)', w: 612, h: 792, code: 1 },
  legal: { label: 'Legal (8.5 × 14 in)', w: 612, h: 1008, code: 5 },
  a3: { label: 'A3 (297 × 420 mm)', w: 841.89, h: 1190.55, code: 8 },
};

export interface Margins {
  t: number;
  b: number;
  l: number;
  r: number;
  header: number;
  footer: number;
}

/** Excel's three ready-made margins, in inches. */
export const MARGINS: Record<'normal' | 'wide' | 'narrow', Margins> = {
  normal: { t: 0.75, b: 0.75, l: 0.7, r: 0.7, header: 0.3, footer: 0.3 },
  wide: { t: 1, b: 1, l: 1, r: 1, header: 0.5, footer: 0.5 },
  narrow: { t: 0.75, b: 0.75, l: 0.25, r: 0.25, header: 0.3, footer: 0.3 },
};

export interface PageSetup {
  paper: Paper;
  orient: 'portrait' | 'landscape';
  margins: Margins;
  /** Percent of normal size, 10 to 400 (used when not fitting to pages). */
  scale: number;
  /** Fit to this many pages wide and tall (0: as many as it takes that way); null: print at `scale`. */
  fit: { w: number; h: number } | null;
  gridlines: boolean;
  headings: boolean;
  centerH: boolean;
  centerV: boolean;
  /** Only this block is printed (Excel's print area). */
  area: Range | null;
  /** Rows (and columns) printed again at the top (left) of every page. */
  titleRows: [number, number] | null;
  titleCols: [number, number] | null;
  /** Excel header and footer codes: &L left, &C centre, &R right; &P page, &N pages, &A sheet, &F file, &D date, &T time. */
  header: string;
  footer: string;
  /** Down, then over (Excel's usual), or over, then down. */
  order: 'down' | 'over';
}

/** Letter paper where it is the usual size (the Americas' letter countries), A4 everywhere else. */
export function defaultPaper(): Paper {
  try {
    const locale = new Intl.DateTimeFormat().resolvedOptions().locale;
    const region = /-([A-Z]{2})\b/.exec(locale)?.[1] ?? (locale === 'en' ? 'US' : '');
    return ['US', 'CA', 'MX', 'PH', 'CL', 'CO', 'VE', 'GT', 'PR', 'CR', 'PA', 'SV', 'DO', 'NI', 'HN'].includes(region) ? 'letter' : 'a4';
  } catch {
    return 'a4';
  }
}

export function defaultPage(paper: Paper = defaultPaper()): PageSetup {
  return {
    paper, orient: 'portrait', margins: { ...MARGINS.normal }, scale: 100, fit: null, gridlines: false, headings: false,
    centerH: false, centerV: false, area: null, titleRows: null, titleCols: null, header: '', footer: '', order: 'down',
  };
}

export const pageOf = (wb: Workbook, s: number): PageSetup => wb.sheets[s].page ?? defaultPage();

/** The paper's size in points, turned for landscape. */
export function paperSize(setup: PageSetup): { w: number; h: number } {
  const p = PAPERS[setup.paper];
  return setup.orient === 'landscape' ? { w: p.h, h: p.w } : { w: p.w, h: p.h };
}

const COL_W = 64;
const ROW_H = 20;
/** Pixels on screen to points on paper. */
const PT = 0.75;
const FONT = 10;
const HEAD_H = 15;

/** What is printed when there is no print area: every cell with something in it or a format, and every chart. */
export function printRange(wb: Workbook, s: number, setup = pageOf(wb, s)): Range | null {
  if (setup.area) return setup.area;
  const sheet = wb.sheets[s];
  const used = wb.usedBounds(s);
  let c1 = used.cols - 1;
  let r1 = used.rows - 1;
  for (const ch of sheet.charts) {
    // A chart reaches as far as the cell under its bottom-right corner.
    let x = ch.at.dx + ch.w;
    let c = ch.at.col;
    while (c < MAX_COLS - 1 && x > colPx(wb, s, c)) x -= colPx(wb, s, c++);
    let y = ch.at.dy + ch.h;
    let r = ch.at.row;
    while (r < MAX_ROWS - 1 && y > rowPx(wb, s, r)) y -= rowPx(wb, s, r++);
    c1 = Math.max(c1, c);
    r1 = Math.max(r1, r);
  }
  if (c1 < 0 || r1 < 0) return null;
  return { c0: 0, r0: 0, c1, r1 };
}

const colPx = (wb: Workbook, s: number, c: number): number => (wb.sheets[s].hiddenCols.has(c) ? 0 : wb.sheets[s].colW.get(c) ?? COL_W);
const rowPx = (wb: Workbook, s: number, r: number): number => (wb.sheets[s].hiddenRows.has(r) ? 0 : wb.sheets[s].rowH.get(r) ?? ROW_H);

export interface PagePart {
  c0: number;
  c1: number;
  r0: number;
  r1: number;
}

export interface PrintPlan {
  pages: PagePart[];
  /** The size everything is printed at, 0.1 to 4 (1 is 100%). */
  k: number;
  area: Range;
  setup: PageSetup;
}

/** Where the page's printable box is (points): inside the margins, less room for headings. */
function box(setup: PageSetup): { x: number; y: number; w: number; h: number } {
  const { w, h } = paperSize(setup);
  const m = setup.margins;
  return { x: m.l * 72, y: m.t * 72, w: Math.max(36, w - (m.l + m.r) * 72), h: Math.max(36, h - (m.t + m.b) * 72) };
}

const headingWidth = (lastRow: number): number => 8 + String(lastRow + 1).length * 6;

/** Cuts a run of sizes (points) into pages no longer than `room`; a part too big for one page gets one to itself. */
function cut(from: number, to: number, size: (i: number) => number, room: number, repeat: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = from;
  let used = repeat;
  for (let i = from; i <= to; i++) {
    const s = size(i);
    if (used + s > room + 0.01 && i > start) {
      out.push([start, i - 1]);
      start = i;
      used = repeat;
    }
    used += s;
  }
  out.push([start, to]);
  return out;
}

/** The pages a sheet prints on, and the size it prints at. Null when there is nothing to print. */
export function planPages(wb: Workbook, s: number, setup = pageOf(wb, s)): PrintPlan | null {
  const area = printRange(wb, s, setup);
  if (!area) return null;
  const b = box(setup);
  const tr = setup.titleRows;
  const tc = setup.titleCols;
  const layout = (k: number) => {
    const hw = setup.headings ? headingWidth(area.r1) : 0;
    const hh = setup.headings ? HEAD_H : 0;
    // Rows repeated at the top take room on pages that do not hold them already (counted on every page, to be safe).
    let repeatH = 0;
    if (tr) for (let r = tr[0]; r <= tr[1]; r++) if (r < area.r0) repeatH += rowPx(wb, s, r) * PT * k;
    let repeatW = 0;
    if (tc) for (let c = tc[0]; c <= tc[1]; c++) if (c < area.c0) repeatW += colPx(wb, s, c) * PT * k;
    const cols = cut(area.c0, area.c1, c => colPx(wb, s, c) * PT * k, b.w - hw * k, repeatW);
    const rows = cut(area.r0, area.r1, r => rowPx(wb, s, r) * PT * k, b.h - hh * k, repeatH);
    return { cols, rows };
  };
  let k = Math.max(0.1, Math.min(4, setup.scale / 100));
  let got = layout(k);
  if (setup.fit) {
    // Fit to pages: the largest size up to 100% that needs no more pages than asked, each way (as Excel does).
    k = 1;
    for (let pct = 100; pct >= 10; pct--) {
      k = pct / 100;
      got = layout(k);
      if ((!setup.fit.w || got.cols.length <= setup.fit.w) && (!setup.fit.h || got.rows.length <= setup.fit.h)) break;
    }
  }
  const pages: PagePart[] = [];
  if (setup.order === 'over') {
    for (const [r0, r1] of got.rows) for (const [c0, c1] of got.cols) pages.push({ c0, c1, r0, r1 });
  } else {
    for (const [c0, c1] of got.cols) for (const [r0, r1] of got.rows) pages.push({ c0, c1, r0, r1 });
  }
  return { pages, k, area, setup };
}

// ---- Header and footer ----------------------------------------------------------------------------------------------

/** An Excel header or footer code cut into its left, centre and right parts, with the page number and such filled in. */
export function headerParts(code: string, fill: { page: number; pages: number; sheet: string; file: string; when?: Date }): { l: string; c: string; r: string } {
  const out = { l: '', c: '', r: '' };
  let part: 'l' | 'c' | 'r' = 'c';
  const when = fill.when ?? new Date();
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch !== '&') {
      out[part] += ch;
      continue;
    }
    const next = code[i + 1] ?? '';
    i++;
    switch (next.toUpperCase()) {
      case 'L': part = 'l'; break;
      case 'C': part = 'c'; break;
      case 'R': part = 'r'; break;
      case 'P': out[part] += String(fill.page); break;
      case 'N': out[part] += String(fill.pages); break;
      case 'A': out[part] += fill.sheet; break;
      case 'F': out[part] += fill.file; break;
      case 'D': out[part] += when.toLocaleDateString(); break;
      case 'T': out[part] += when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); break;
      case '&': out[part] += '&'; break;
      case '"': {
        // &"Arial,Bold": a typeface, not printed.
        const end = code.indexOf('"', i + 1);
        i = end < 0 ? code.length : end;
        break;
      }
      case 'K': i += 6; break;
      default:
        // A size (&12) or a style switch (&B, &I, &U...): not printed.
        while (/\d/.test(code[i + 1] ?? '')) i++;
    }
  }
  return out;
}

/** Excel's ready-made headers and footers. */
export const HEADER_PRESETS: Array<{ label: string; code: string }> = [
  { label: '(none)', code: '' },
  { label: 'Page 1', code: '&CPage &P' },
  { label: 'Page 1 of 3', code: '&CPage &P of &N' },
  { label: 'Sheet name', code: '&C&A' },
  { label: 'File name', code: '&C&F' },
  { label: 'Sheet name, page 1', code: '&L&A&RPage &P' },
  { label: 'Date printed', code: '&R&D' },
];

// ---- Drawing a page -------------------------------------------------------------------------------------------------

const GRID = '#a6a6a6';

/** Draws one printed page (points, from the top-left of the paper). */
export function drawPage(p: Painter, wb: Workbook, s: number, plan: PrintPlan, index: number, file = ''): void {
  const setup = plan.setup;
  const page = plan.pages[index];
  const sheet = wb.sheets[s];
  const k = plan.k;
  const paper = paperSize(setup);
  const b = box(setup);
  p.rect(0, 0, paper.w, paper.h, '#ffffff');

  // Header and footer, in the margins, at their own size (not scaled).
  const fill = { page: index + 1, pages: plan.pages.length, sheet: sheet.name, file };
  const hf = (code: string, y: number) => {
    if (!code) return;
    const parts = headerParts(code, fill);
    const left = setup.margins.l * 72;
    const right = paper.w - setup.margins.r * 72;
    if (parts.l) p.text(left, y, fitText(parts.l, (right - left) / 3, FONT), { size: FONT });
    if (parts.c) p.text(paper.w / 2, y, fitText(parts.c, (right - left) / 2, FONT), { size: FONT, align: 'c' });
    if (parts.r) p.text(right, y, fitText(parts.r, (right - left) / 3, FONT), { size: FONT, align: 'r' });
  };
  hf(setup.header, setup.margins.header * 72 + FONT / 2);
  hf(setup.footer, paper.h - setup.margins.footer * 72 - FONT / 2);

  // The rows and columns on this page, with the repeated title rows and columns first.
  const rows: number[] = [];
  const cols: number[] = [];
  if (setup.titleRows) for (let r = setup.titleRows[0]; r <= setup.titleRows[1]; r++) if (r < page.r0) rows.push(r);
  for (let r = page.r0; r <= page.r1; r++) rows.push(r);
  if (setup.titleCols) for (let c = setup.titleCols[0]; c <= setup.titleCols[1]; c++) if (c < page.c0) cols.push(c);
  for (let c = page.c0; c <= page.c1; c++) cols.push(c);
  const cw = (c: number) => colPx(wb, s, c) * PT * k;
  const rh = (r: number) => rowPx(wb, s, r) * PT * k;
  const hw = setup.headings ? headingWidth(plan.area.r1) * k : 0;
  const hh = setup.headings ? HEAD_H * k : 0;
  const totalW = hw + cols.reduce((n, c) => n + cw(c), 0);
  const totalH = hh + rows.reduce((n, r) => n + rh(r), 0);
  const ox = b.x + (setup.centerH ? Math.max(0, (b.w - totalW) / 2) : 0);
  const oy = b.y + (setup.centerV ? Math.max(0, (b.h - totalH) / 2) : 0);
  const x0 = ox + hw;
  const y0 = oy + hh;
  const xs = new Map<number, number>();
  const ys = new Map<number, number>();
  let at = x0;
  for (const c of cols) {
    xs.set(c, at);
    at += cw(c);
  }
  const x1 = at;
  at = y0;
  for (const r of rows) {
    ys.set(r, at);
    at += rh(r);
  }
  const y1 = at;
  const size = FONT * k;
  p.clip(b.x, b.y, b.w, b.h);

  // Fills (a merged block is filled as one, with its top-left cell's look).
  const merges = sheet.merges.filter(m => cols.some(c => c >= m.c0 && c <= m.c1) && rows.some(r => r >= m.r0 && r <= m.r1));
  const inMerge = (c: number, r: number) => merges.find(m => c >= m.c0 && c <= m.c1 && r >= m.r0 && r <= m.r1);
  const blockBox = (m: Range) => {
    // The part of the block on this page.
    const bc = cols.filter(c => c >= m.c0 && c <= m.c1);
    const br = rows.filter(r => r >= m.r0 && r <= m.r1);
    const x = xs.get(bc[0])!;
    const y = ys.get(br[0])!;
    return { x, y, w: xs.get(bc[bc.length - 1])! + cw(bc[bc.length - 1]) - x, h: ys.get(br[br.length - 1])! + rh(br[br.length - 1]) - y };
  };
  const looks = new Map<number, ReturnType<typeof cfLook>>();
  const look = (c: number, r: number) => {
    const key = keyOf(c, r);
    if (!looks.has(key)) looks.set(key, sheet.cf.length ? cfLook(wb, s, c, r) : null);
    return looks.get(key) ?? null;
  };
  const styleAt = (c: number, r: number): CellStyle | undefined => wb.lookOf(s, c, r);
  for (const r of rows) {
    if (!rh(r)) continue;
    for (const c of cols) {
      if (!cw(c) || inMerge(c, r)) continue;
      const fillColour = look(c, r)?.fill ?? styleAt(c, r)?.fill;
      if (fillColour) p.rect(xs.get(c)!, ys.get(r)!, cw(c), rh(r), fillColour);
    }
  }
  for (const m of merges) {
    const fillColour = look(m.c0, m.r0)?.fill ?? styleAt(m.c0, m.r0)?.fill;
    const bb = blockBox(m);
    p.rect(bb.x, bb.y, bb.w, bb.h, fillColour ?? '#ffffff');
  }
  // Data bars.
  for (const r of rows) for (const c of cols) {
    const bar = look(c, r)?.bar;
    if (bar && bar.len > 0 && cw(c) && rh(r)) p.rect(xs.get(c)! + 1, ys.get(r)! + 1.5, (cw(c) - 2) * bar.len, rh(r) - 3, bar.colour);
  }

  // Gridlines: between every cell (not inside merged blocks).
  if (setup.gridlines) {
    for (const c of cols) {
      if (!cw(c)) continue;
      p.line([xs.get(c)!, y0, xs.get(c)!, y1], GRID, 0.5);
    }
    p.line([x1, y0, x1, y1], GRID, 0.5);
    for (const r of rows) {
      if (!rh(r)) continue;
      p.line([x0, ys.get(r)!, x1, ys.get(r)!], GRID, 0.5);
    }
    p.line([x0, y1, x1, y1], GRID, 0.5);
    for (const m of merges) {
      const bb = blockBox(m);
      p.rect(bb.x + 0.3, bb.y + 0.3, bb.w - 0.6, bb.h - 0.6, look(m.c0, m.r0)?.fill ?? styleAt(m.c0, m.r0)?.fill ?? '#ffffff');
    }
  }

  // Borders.
  const side = (line: Line | undefined, pts: number[], colour: string) => {
    if (!line) return;
    if (line === 'double') {
      const vertical = pts[0] === pts[2];
      const d = 1;
      p.line(vertical ? [pts[0] - d, pts[1], pts[2] - d, pts[3]] : [pts[0], pts[1] - d, pts[2], pts[3] - d], colour, 0.5);
      p.line(vertical ? [pts[0] + d, pts[1], pts[2] + d, pts[3]] : [pts[0], pts[1] + d, pts[2], pts[3] + d], colour, 0.5);
      return;
    }
    p.line(pts, colour, line === 'thick' ? 2.25 : line === 'medium' ? 1.5 : 0.75);
  };
  for (const r of rows) {
    if (!rh(r)) continue;
    for (const c of cols) {
      const st = styleAt(c, r);
      if (!cw(c) || !st || !(st.bt || st.bb || st.bl || st.br)) continue;
      const m = inMerge(c, r);
      const x = xs.get(c)!;
      const y = ys.get(r)!;
      const colour = st.bc ?? '#000000';
      if (!m || r === m.r0) side(st.bt, [x, y, x + cw(c), y], colour);
      if (!m || r === m.r1) side(st.bb, [x, y + rh(r), x + cw(c), y + rh(r)], colour);
      if (!m || c === m.c0) side(st.bl, [x, y, x, y + rh(r)], colour);
      if (!m || c === m.c1) side(st.br, [x + cw(c), y, x + cw(c), y + rh(r)], colour);
    }
  }

  // Text.
  const drawText = (c: number, r: number, bx: number, by: number, bw: number, bh: number, merged: boolean) => {
    const cell = sheet.cells.get(keyOf(c, r));
    if ((!cell || (cell.v === undefined && cell.f === undefined)) && !wb.isSpilled(s, c, r)) return;
    const shown = wb.shown(s, c, r);
    if (shown.text === '') return;
    const st = wb.lookOf(s, c, r);
    const cf = look(c, r);
    const v = wb.value(s, c, r);
    const bold = !!(cf?.b ?? st?.b);
    const italic = !!(cf?.i ?? st?.i);
    const underline = !!(cf?.u ?? st?.u);
    const strike = !!st?.st;
    // The cell's own size (11 points is the standard, printed at `size`) and kind of typeface.
    const fsize = (size * (st?.fs ?? 11)) / 11;
    const kind = fontKind(st?.ff);
    const indent = st?.ind && (st.al ?? 'l') !== 'c' ? st.ind * 6.75 * k : 0;
    const half = Math.max((ROW_H * PT * k) / 2, fsize * 0.75);
    const lineY = (count: number, lh: number) => (st?.va === 't' ? by + half : st?.va === 'm' ? by + bh / 2 - (lh * (count - 1)) / 2 : by + bh - half - lh * (count - 1));
    const colour = v instanceof CellError ? '#c0392b' : shown.color ?? cf?.color ?? st?.color ?? '#000000';
    const isNum = typeof v === 'number';
    const align = st?.al ?? (isNum ? 'r' : v instanceof CellError || typeof v === 'boolean' ? 'c' : 'l');
    const pad = 2 * k;
    if (st?.wrap && !isNum) {
      const lines = wrapText(shown.text, bw - pad * 2 - indent, fsize, bold, 60, kind);
      const lh = fsize * 1.25;
      let ly = lineY(lines.length, lh);
      p.clip(bx, by, bw, bh);
      for (const line of lines) {
        const lx = align === 'r' ? bx + bw - pad - indent : align === 'c' ? bx + bw / 2 : bx + pad + indent;
        p.text(lx, ly, line, { size: fsize, bold, italic, underline, strike, colour, align, kind });
        ly += lh;
      }
      p.unclip();
      return;
    }
    let text = shown.text.replace(/\r?\n/g, ' ');
    let room = bw;
    const tw = textWidth(text, fsize, bold, kind);
    if (tw > bw - pad * 2 - indent) {
      if (isNum && st?.fmt !== 'text') text = '#'.repeat(Math.max(1, Math.floor((bw - pad * 2 - indent) / textWidth('#', fsize, false, kind))));
      else if (align === 'l' && !merged) {
        // Text runs on into empty cells to its right, on this page.
        const i = cols.indexOf(c);
        for (let j = i + 1; j < cols.length && room < tw + pad * 2; j++) {
          const n = cols[j];
          const other = sheet.cells.get(keyOf(n, r));
          if ((other && (other.v !== undefined || other.f !== undefined)) || wb.isSpilled(s, n, r) || inMerge(n, r)) break;
          room += cw(n);
        }
      }
    }
    const ty = lineY(1, 0);
    const tx = align === 'r' ? bx + bw - pad - indent : align === 'c' ? bx + bw / 2 : bx + pad + indent;
    p.clip(bx, by, room, bh);
    p.text(tx, ty, text, { size: fsize, bold, italic, underline, strike, colour, align, kind });
    p.unclip();
  };
  for (const r of rows) {
    if (!rh(r)) continue;
    for (const c of cols) {
      if (!cw(c) || inMerge(c, r)) continue;
      drawText(c, r, xs.get(c)!, ys.get(r)!, cw(c), rh(r), false);
    }
  }
  for (const m of merges) {
    const bb = blockBox(m);
    drawText(m.c0, m.r0, bb.x, bb.y, bb.w, bb.h, true);
  }

  // Row and column headings.
  if (setup.headings) {
    const hs = 8 * k;
    p.rect(ox, oy, hw, hh, '#f2f2f2', GRID, 0.5);
    for (const c of cols) {
      if (!cw(c)) continue;
      p.rect(xs.get(c)!, oy, cw(c), hh, '#f2f2f2', GRID, 0.5);
      p.text(xs.get(c)! + cw(c) / 2, oy + hh / 2, colName(c), { size: hs, align: 'c', colour: '#333333' });
    }
    for (const r of rows) {
      if (!rh(r)) continue;
      p.rect(ox, ys.get(r)!, hw, rh(r), '#f2f2f2', GRID, 0.5);
      p.text(ox + hw / 2, ys.get(r)! + rh(r) / 2, String(r + 1), { size: hs, align: 'c', colour: '#333333' });
    }
  }
  p.unclip();

  // Charts that sit on this page's cells, cut to the cells it prints.
  if (sheet.charts.length) {
    p.clip(x0, y0, x1 - x0, y1 - y0);
    const xOf = (c: number) => {
      // Where column c starts on this page (it may be off to the left or right).
      let x = xs.get(page.c0) ?? x0;
      if (c >= page.c0) for (let i = page.c0; i < c; i++) x += cw(i);
      else for (let i = c; i < page.c0; i++) x -= cw(i);
      return x;
    };
    const yOf = (r: number) => {
      let y = ys.get(page.r0) ?? y0;
      if (r >= page.r0) for (let i = page.r0; i < r; i++) y += rh(i);
      else for (let i = r; i < page.r0; i++) y -= rh(i);
      return y;
    };
    for (const ch of sheet.charts) {
      const cx = xOf(ch.at.col) + ch.at.dx * PT * k;
      const cy = yOf(ch.at.row) + ch.at.dy * PT * k;
      const w = ch.w * PT * k;
      const h = ch.h * PT * k;
      if (cx > x1 || cy > y1 || cx + w < x0 || cy + h < y0) continue;
      drawChart(new OffsetPainter(p, cx, cy, PT * k), ch, chartData(wb, s, ch), ch.w, ch.h);
    }
    p.unclip();
  }
}

// ---- Saving ---------------------------------------------------------------------------------------------------------

/** A page setup from a saved file, every field checked; null when it is not one. */
export function cleanPage(raw: unknown, range: (raw: unknown) => Range | null): PageSetup | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const out = defaultPage(r.paper && (r.paper as string) in PAPERS ? (r.paper as Paper) : defaultPaper());
  if (r.orient === 'landscape') out.orient = 'landscape';
  const m = r.margins as Record<string, unknown> | undefined;
  if (m && typeof m === 'object') {
    for (const key of ['t', 'b', 'l', 'r', 'header', 'footer'] as const) {
      const v = m[key];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 5) out.margins[key] = v;
    }
  }
  if (typeof r.scale === 'number' && Number.isFinite(r.scale)) out.scale = Math.max(10, Math.min(400, Math.round(r.scale)));
  const f = r.fit as Record<string, unknown> | null | undefined;
  if (f && typeof f === 'object') {
    const n = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? Math.max(0, Math.min(999, v)) : 0);
    out.fit = { w: n(f.w), h: n(f.h) };
  }
  out.gridlines = r.gridlines === true;
  out.headings = r.headings === true;
  out.centerH = r.centerH === true;
  out.centerV = r.centerV === true;
  out.area = range(r.area);
  const pair = (v: unknown, max: number): [number, number] | null => {
    if (!Array.isArray(v) || v.length !== 2 || !v.every(x => Number.isInteger(x))) return null;
    const [a, b] = v as number[];
    return a >= 0 && b >= a && b < max ? [a, b] : null;
  };
  out.titleRows = pair(r.titleRows, MAX_ROWS);
  out.titleCols = pair(r.titleCols, MAX_COLS);
  out.header = typeof r.header === 'string' ? r.header.slice(0, 255) : '';
  out.footer = typeof r.footer === 'string' ? r.footer.slice(0, 255) : '';
  if (r.order === 'over') out.order = 'over';
  return out;
}
