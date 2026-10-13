// Charts: what a chart is (its kind, its series as references to cells, where it sits on the sheet), how one is made
// from the selected cells (the way Excel reads headings and decides between series in rows or in columns), and how it
// is drawn through a Painter (paint.ts): title, legend, axes with round-number steps, then columns, bars, lines, areas,
// pie slices, a doughnut or scatter points. No browser needed here, so it can be tested.
// Each line series gets its own marker shape and each pie slice its own label in the legend, so colour is never the only
// thing that tells the series apart.
import { fitText, textWidth, type Painter } from './paint.ts';
import { addressOf, colName, MAX_COLS, MAX_ROWS, parseCellRef, quoteSheet, sheetNameOf, SyntaxProblem, tokenize } from './refs.ts';
import { CellError, formatValue, type CellStyle, type Value } from './values.ts';
import type { Range, Workbook } from './workbook.ts';

export type ChartType = 'column' | 'bar' | 'line' | 'area' | 'pie' | 'doughnut' | 'scatter';
export const CHART_TYPES: ChartType[] = ['column', 'bar', 'line', 'area', 'pie', 'doughnut', 'scatter'];
export const CHART_LABEL: Record<ChartType, string> = {
  column: 'Column', bar: 'Bar', line: 'Line', area: 'Area', pie: 'Pie', doughnut: 'Doughnut', scatter: 'Scatter (X Y)',
};

export interface ChartSeries {
  /** "=Sheet1!$B$1" (a cell holding the name) or the name itself; '' for none. */
  name: string;
  /** Categories (or the X values of a scatter chart): a reference such as Sheet1!$A$2:$A$6, or ''. */
  cat: string;
  /** The values: a reference (or a list constant such as {1,2,3}). */
  val: string;
  /** A colour chosen for this series (#rrggbb); the standard order of colours when not set. */
  colour?: string;
}

export interface Chart {
  id: number;
  type: ChartType;
  /** Stacked columns, bars or areas (on top of one another), or stacked to 100%. */
  group?: 'stacked' | 'percent';
  /** null: automatic (a one-series chart is titled with the series name); '' for no title. */
  title: string | null;
  series: ChartSeries[];
  legend: 'r' | 'b' | 't' | 'l' | 'none';
  xTitle?: string;
  yTitle?: string;
  /** The values written on the bars, points or slices. */
  labels?: boolean;
  /** Where its top-left corner is: in this cell, this many pixels in. It moves with the cell, as in Excel. */
  at: { col: number; row: number; dx: number; dy: number };
  /** Its size in pixels (at 100% zoom). */
  w: number;
  h: number;
}

export const MAX_CHARTS = 50;
export const MAX_SERIES = 60;
/** The most points a series plots (a whole-column reference is read only as far as the cells in use). */
export const MAX_POINTS = 4000;

/** Excel's (Office theme) series colours, in order. */
export const SERIES_COLOURS = ['#4472c4', '#ed7d31', '#a5a5a5', '#ffc000', '#5b9bd5', '#70ad47', '#264478', '#9e480e', '#636363', '#997300', '#255e91', '#43682b'];
const INK = '#595959';
const GRIDLINE = '#d9d9d9';
const AXIS = '#bfbfbf';
export type Marker = 'circle' | 'square' | 'diamond' | 'triangle' | 'x' | 'plus' | 'star';
export const MARKERS: Marker[] = ['circle', 'square', 'diamond', 'triangle', 'x', 'plus', 'star'];

export const seriesColour = (chart: Chart, i: number): string => chart.series[i]?.colour ?? SERIES_COLOURS[i % SERIES_COLOURS.length];

// ---- References ----------------------------------------------------------------------------------------------------

/** A plain reference (Sheet1!$A$1:$B$5, or A1:B5 on the chart's own sheet) as a sheet and range; null for anything else. */
export function refRange(wb: Workbook, own: number, text: string): { s: number; range: Range } | null {
  let toks;
  try {
    toks = tokenize(text.replace(/^=/, ''));
  } catch {
    return null;
  }
  let k = 0;
  let s = own;
  if (toks[1]?.type === 'bang' && (toks[0].type === 'ident' || toks[0].type === 'sheetq')) {
    const name = sheetNameOf(toks[0]).toLowerCase();
    s = wb.sheets.findIndex(x => x.name.toLowerCase() === name);
    if (s < 0) return null;
    k = 2;
  }
  const a = toks[k]?.type === 'ident' ? parseCellRef(toks[k].text) : null;
  if (!a) return null;
  let b = a;
  if (toks[k + 1]?.type === 'colon') {
    const second = toks[k + 2]?.type === 'ident' ? parseCellRef(toks[k + 2].text) : null;
    if (!second) return null;
    b = second;
    k += 2;
  }
  if (k + 1 !== toks.length) return null;
  return { s, range: { c0: Math.min(a.col, b.col), r0: Math.min(a.row, b.row), c1: Math.max(a.col, b.col), r1: Math.max(a.row, b.row) } };
}

/** An absolute reference to a block on a sheet, as Excel writes a chart's: Sheet1!$B$2:$B$6. */
export function refText(sheetName: string, r: Range): string {
  const abs = (c: number, row: number) => `$${colName(c)}$${row + 1}`;
  return `${quoteSheet(sheetName)}!${abs(r.c0, r.r0)}${r.c1 !== r.c0 || r.r1 !== r.r0 ? `:${abs(r.c1, r.r1)}` : ''}`;
}

/**
 * Each cell of a plain reference, row by row, only as far as the cells in use (a whole column is 5,000 rows). With
 * `shown`, cells in hidden rows and columns are left out, as Excel leaves them out of a chart (a filter's hidden rows
 * too). Null when the text is not a plain reference.
 */
function eachCell<T>(wb: Workbook, own: number, text: string, shown: boolean, read: (s: number, col: number, row: number) => T): T[] | null {
  const plain = refRange(wb, own, text);
  if (!plain) return null;
  const sheet = wb.sheets[plain.s];
  const used = wb.usedBounds(plain.s);
  const r = plain.range;
  const out: T[] = [];
  for (let row = r.r0; row <= Math.min(r.r1, Math.max(r.r0, used.rows - 1)); row++) {
    if (shown && sheet.hiddenRows.has(row)) continue;
    for (let col = r.c0; col <= Math.min(r.c1, Math.max(r.c0, used.cols - 1)); col++) {
      if (shown && sheet.hiddenCols.has(col)) continue;
      out.push(read(plain.s, col, row));
      if (out.length >= MAX_POINTS) return out;
    }
  }
  return out;
}

/** The values a reference (or list constant) holds, row by row, as one list (hidden cells left out). */
function listOf(wb: Workbook, own: number, text: string): Value[] {
  if (!text) return [];
  const cells = eachCell(wb, own, text, true, (s, c, r) => wb.value(s, c, r));
  if (cells) return cells;
  const got = wb.evalFormula(own, text.replace(/^=/, ''));
  if (Array.isArray(got)) return got.flat().slice(0, MAX_POINTS);
  return [got];
}

/** What a reference shows, cell by cell (formatted as on the sheet: a date reads as a date); `shown` as for eachCell. */
function textsOf(wb: Workbook, own: number, text: string, shown = true): string[] {
  const cells = eachCell(wb, own, text, shown, (s, c, r) => wb.display(s, c, r));
  if (cells) return cells;
  return listOf(wb, own, text).map(v => (v === null ? '' : v instanceof CellError ? v.code : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v)));
}

/** Every reference in the chart rewritten by `fn` (rows inserted, a sheet renamed or deleted). */
export function mapChartRefs(chart: Chart, fn: (formula: string) => string): Chart {
  const one = (t: string) => {
    if (!t) return t;
    try {
      return fn(t);
    } catch {
      return t;
    }
  };
  return {
    ...chart,
    series: chart.series.map(s => ({ ...s, name: s.name.startsWith('=') ? `=${one(s.name.slice(1))}` : s.name, cat: one(s.cat), val: one(s.val) })),
  };
}

// ---- Making a chart from the selected cells ------------------------------------------------------------------------

/**
 * A chart of the selected block, read as Excel reads it: a top row of words is the series names, a left column of words
 * (or dates) is the categories; with more rows than columns each column is a series, otherwise each row is. A scatter
 * chart's first column is the X values. One cell selected: the block of data round it.
 */
export function chartFromRange(wb: Workbook, s: number, picked: Range, type: ChartType): Omit<Chart, 'id' | 'at' | 'w' | 'h'> {
  let range = picked;
  if (range.c0 === range.c1 && range.r0 === range.r1) range = wb.currentRegion(s, range.c0, range.r0);
  // A whole column or row selected: only as far as the cells in use.
  const used = wb.usedBounds(s);
  range = { ...range, c1: Math.min(range.c1, Math.max(range.c0, used.cols - 1)), r1: Math.min(range.r1, Math.max(range.r0, used.rows - 1)) };
  const { c0, r0, c1, r1 } = range;
  const v = (c: number, r: number) => wb.value(s, c, r);
  const isDate = (c: number, r: number) => {
    const code = wb.styleOf(wb.sheets[s].cells.get(r * MAX_COLS + c))?.code;
    return !!code && /[dmy]/i.test(code.replace(/"[^"]*"/g, '')) && !/^[#0.,%?\s]*$/.test(code);
  };
  const isNumber = (c: number, r: number) => typeof v(c, r) === 'number';
  let numbers = 0;
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (isNumber(c, r)) numbers++;
  if (!numbers) throw new SyntaxProblem('There are no numbers here to chart. Select the numbers (with their headings), then choose a chart.');

  const blankCorner = v(c0, r0) === null;
  const cornerText = typeof v(c0, r0) === 'string';
  // A left column of words or dates: the categories (for a scatter chart, numbers in it are the X values instead).
  let labelCol = false;
  if (c1 > c0 && type !== 'scatter') {
    labelCol = true;
    for (let r = r0 + 1; r <= r1; r++) if (isNumber(c0, r) && !isDate(c0, r)) labelCol = false;
    if (r1 === r0) labelCol = !isNumber(c0, r0);
  }
  // A top row with no numbers (words, or blanks) above the data: the series names.
  let headRow = false;
  if (r1 > r0) {
    headRow = true;
    let words = 0;
    for (let c = c0 + (labelCol ? 1 : 0); c <= c1; c++) {
      if (isNumber(c, r0) && !isDate(c, r0)) headRow = false;
      if (typeof v(c, r0) === 'string') words++;
    }
    if (!words && !blankCorner) headRow = false;
  }
  if (blankCorner && c1 > c0 && r1 > r0 && type !== 'scatter') {
    labelCol = true;
    headRow = true;
  }
  if (cornerText && labelCol && !headRow && r1 > r0) {
    // "Month | Sales" over "Jan | 10": the words in the corner belong to the heading row.
    let rest = true;
    for (let c = c0 + 1; c <= c1; c++) if (typeof v(c, r0) !== 'string') rest = false;
    headRow = rest;
  }
  const dc0 = c0 + (labelCol ? 1 : 0);
  const dr0 = r0 + (headRow ? 1 : 0);
  if (dc0 > c1 || dr0 > r1) throw new SyntaxProblem('There are only headings here. Select the numbers too, then choose a chart.');
  const name = wb.sheets[s].name;
  const series: ChartSeries[] = [];
  const byCols = type === 'scatter' || r1 - dr0 + 1 >= c1 - dc0 + 1;
  if (type === 'scatter') {
    // X values: the first column (of the data); each column after it is a series of Y values.
    const xCol = labelCol ? c0 : dc0;
    const first = labelCol ? dc0 : dc0 + 1;
    const xs = refText(name, { c0: xCol, r0: dr0, c1: xCol, r1 });
    if (first > c1) series.push({ name: headRow ? `=${refText(name, { c0: xCol, r0, c1: xCol, r1: r0 })}` : '', cat: '', val: xs });
    for (let c = first; c <= c1 && series.length < MAX_SERIES; c++) {
      series.push({ name: headRow ? `=${refText(name, { c0: c, r0, c1: c, r1: r0 })}` : '', cat: xs, val: refText(name, { c0: c, r0: dr0, c1: c, r1 }) });
    }
  } else if (byCols) {
    const cat = labelCol ? refText(name, { c0, r0: dr0, c1: c0, r1 }) : '';
    for (let c = dc0; c <= c1 && series.length < MAX_SERIES; c++) {
      series.push({ name: headRow ? `=${refText(name, { c0: c, r0, c1: c, r1: r0 })}` : '', cat, val: refText(name, { c0: c, r0: dr0, c1: c, r1 }) });
    }
  } else {
    const cat = headRow ? refText(name, { c0: dc0, r0, c1, r1: r0 }) : '';
    for (let r = dr0; r <= r1 && series.length < MAX_SERIES; r++) {
      series.push({ name: labelCol ? `=${refText(name, { c0, r0: r, c1: c0, r1: r })}` : '', cat, val: refText(name, { c0: dc0, r0: r, c1, r1: r }) });
    }
  }
  return { type, title: null, series, legend: type === 'pie' || type === 'doughnut' || series.length > 1 ? 'r' : 'none' };
}

/** Swaps series in rows and in columns (Excel's Switch Row/Column), when the chart is one block of cells. */
export function switchRowCol(wb: Workbook, s: number, chart: Chart): Chart | null {
  const parts = chart.series.map(x => ({ v: refRange(wb, s, x.val), c: x.cat ? refRange(wb, s, x.cat) : null, n: x.name.startsWith('=') ? refRange(wb, s, x.name) : null }));
  if (!parts.length || parts.some(p => !p.v) || chart.type === 'scatter') return null;
  const sheet = parts[0].v!.s;
  if (parts.some(p => p.v!.s !== sheet)) return null;
  const c0 = Math.min(...parts.map(p => p.v!.range.c0));
  const r0 = Math.min(...parts.map(p => p.v!.range.r0));
  const c1 = Math.max(...parts.map(p => p.v!.range.c1));
  const r1 = Math.max(...parts.map(p => p.v!.range.r1));
  const name = wb.sheets[sheet].name;
  const inCols = parts.every(p => p.v!.range.c0 === p.v!.range.c1);
  const cat = parts[0].c;
  const first = parts[0].n;
  const series: ChartSeries[] = [];
  if (inCols) {
    // Now a series per row: named by the category cells, categories from the series names.
    for (let r = r0; r <= r1 && series.length < MAX_SERIES; r++) {
      series.push({
        name: cat ? `=${refText(name, { c0: cat.range.c0, r0: r, c1: cat.range.c0, r1: r })}` : '',
        cat: first ? refText(name, { c0, r0: first.range.r0, c1, r1: first.range.r0 }) : '',
        val: refText(name, { c0, r0: r, c1, r1: r }),
      });
    }
  } else {
    for (let c = c0; c <= c1 && series.length < MAX_SERIES; c++) {
      series.push({
        name: cat ? `=${refText(name, { c0: c, r0: cat.range.r0, c1: c, r1: cat.range.r0 })}` : '',
        cat: first ? refText(name, { c0: first.range.c0, r0, c1: first.range.c0, r1 }) : '',
        val: refText(name, { c0: c, r0, c1: c, r1 }),
      });
    }
  }
  return { ...chart, series, legend: chart.legend === 'none' && series.length > 1 ? 'r' : chart.legend };
}

// ---- Reading the numbers -------------------------------------------------------------------------------------------

export interface SeriesData {
  name: string;
  values: Array<number | null>;
  /** A scatter chart's X values. */
  xs?: Array<number | null>;
  colour: string;
}

export interface ChartData {
  cats: string[];
  series: SeriesData[];
  /** The values as the first value cell shows them (its number format), for the axis and the labels. */
  fmt: (n: number) => string;
  /** A scatter chart's X values, as their first cell shows them. */
  xfmt: (n: number) => string;
}

function formatterFor(wb: Workbook, own: number, text: string): (n: number) => string {
  const plain = refRange(wb, own, text);
  let style: CellStyle | undefined;
  if (plain) {
    const sheet = wb.sheets[plain.s];
    for (let r = plain.range.r0; r <= Math.min(plain.range.r1, plain.range.r0 + 50) && !style; r++) {
      for (let c = plain.range.c0; c <= Math.min(plain.range.c1, plain.range.c0 + 50) && !style; c++) {
        if (typeof wb.value(plain.s, c, r) === 'number') style = wb.styleOf(sheet.cells.get(r * MAX_COLS + c)) ?? {};
      }
    }
  }
  const keep = style && (style.fmt || style.code) ? style : undefined;
  return n => formatValue(n, keep, wb.symbol).text;
}

/** The chart's series as numbers (anything else, such as text or an empty cell, is a gap), its categories and names. */
export function chartData(wb: Workbook, s: number, chart: Chart): ChartData {
  const series: SeriesData[] = chart.series.map((x, i) => {
    let name = x.name;
    if (name.startsWith('=')) name = textsOf(wb, s, name.slice(1), false).filter(t => t !== '').join(' ');
    const values = listOf(wb, s, x.val).map(v => (typeof v === 'number' && Number.isFinite(v) ? v : null));
    const out: SeriesData = { name: name || `Series${i + 1}`, values, colour: seriesColour(chart, i) };
    if (chart.type === 'scatter') {
      const xs = x.cat ? listOf(wb, s, x.cat).map(v => (typeof v === 'number' && Number.isFinite(v) ? v : null)) : values.map((_, k) => k + 1);
      out.xs = xs;
    }
    return out;
  });
  const longest = Math.max(0, ...series.map(x => x.values.length));
  const firstCat = chart.series.find(x => x.cat)?.cat ?? '';
  let cats = chart.type === 'scatter' || !firstCat ? [] : textsOf(wb, s, firstCat);
  if (!cats.length) cats = Array.from({ length: longest }, (_, i) => String(i + 1));
  while (cats.length < longest) cats.push(String(cats.length + 1));
  const fmt = formatterFor(wb, s, chart.series[0]?.val ?? '');
  const xfmt = chart.type === 'scatter' && chart.series[0]?.cat ? formatterFor(wb, s, chart.series[0].cat) : fmt;
  return { cats, series, fmt, xfmt };
}

// ---- Drawing -------------------------------------------------------------------------------------------------------

/** Round-number steps for an axis from lo to hi (Excel's 1, 2 or 5 times a power of ten). */
export function niceScale(min: number, max: number, most: number, zero: boolean): { lo: number; hi: number; step: number } {
  let lo = min;
  let hi = max;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = 0;
    hi = 1;
  }
  // Excel starts the axis at zero unless the values sit in a narrow band far from it.
  if (zero || (lo >= 0 && (hi - lo) / Math.max(Math.abs(hi), 1e-300) >= 1 / 6)) lo = Math.min(lo, 0);
  if (zero || (hi <= 0 && (hi - lo) / Math.max(Math.abs(lo), 1e-300) >= 1 / 6)) hi = Math.max(hi, 0);
  if (lo === hi) {
    if (lo === 0) hi = 1;
    else if (lo > 0) lo = 0;
    else hi = 0;
  }
  // A little room past the highest (and lowest) value, as Excel leaves, so a column never touches the top.
  const span = hi - lo;
  if (hi > 0) hi += span * 0.05;
  if (lo < 0) lo -= span * 0.05;
  const rough = (hi - lo) / Math.max(1, most);
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const outLo = Math.floor(lo / step + 1e-9) * step;
  let outHi = Math.ceil(hi / step - 1e-9) * step;
  if (outHi === outLo) outHi = outLo + step;
  return { lo: outLo, hi: outHi, step };
}

const ticks = (sc: { lo: number; hi: number; step: number }): number[] => {
  const out: number[] = [];
  for (let k = 0; ; k++) {
    const v = sc.lo + k * sc.step;
    if (v > sc.hi + sc.step / 1e6 || out.length > 200) break;
    out.push(Math.abs(v) < sc.step / 1e9 ? 0 : parseFloat(v.toPrecision(12)));
  }
  return out;
};

export function drawMarker(p: Painter, kind: Marker, x: number, y: number, r: number, colour: string): void {
  switch (kind) {
    case 'circle': return p.circle(x, y, r, colour, '#fff', 0.75);
    case 'square': return p.rect(x - r * 0.9, y - r * 0.9, r * 1.8, r * 1.8, colour, '#fff', 0.75);
    case 'diamond': return p.shape([x, y - r * 1.2, x + r * 1.2, y, x, y + r * 1.2, x - r * 1.2, y], colour, '#fff', 0.75);
    case 'triangle': return p.shape([x, y - r * 1.2, x + r * 1.1, y + r * 0.8, x - r * 1.1, y + r * 0.8], colour, '#fff', 0.75);
    case 'x':
      p.line([x - r, y - r, x + r, y + r], colour, 2);
      return p.line([x - r, y + r, x + r, y - r], colour, 2);
    case 'plus':
      p.line([x - r, y, x + r, y], colour, 2);
      return p.line([x, y - r, x, y + r], colour, 2);
    case 'star': {
      const pts: number[] = [];
      for (let k = 0; k < 10; k++) {
        const a = -Math.PI / 2 + (k * Math.PI) / 5;
        const rr = k % 2 ? r * 0.5 : r * 1.3;
        pts.push(x + rr * Math.cos(a), y + rr * Math.sin(a));
      }
      return p.shape(pts, colour, '#fff', 0.5);
    }
  }
}

/** A pie slice (or a doughnut's ring piece) as points, from angle a0 to a1 (radians, clockwise from twelve o'clock). */
function slice(cx: number, cy: number, r: number, inner: number, a0: number, a1: number): number[] {
  const steps = Math.max(2, Math.ceil(((a1 - a0) / (Math.PI * 2)) * 96));
  const at = (a: number, rr: number) => [cx + rr * Math.sin(a), cy - rr * Math.cos(a)];
  const pts: number[] = [];
  for (let k = 0; k <= steps; k++) pts.push(...at(a0 + ((a1 - a0) * k) / steps, r));
  if (inner > 0) for (let k = steps; k >= 0; k--) pts.push(...at(a0 + ((a1 - a0) * k) / steps, inner));
  else pts.push(cx, cy);
  return pts;
}

/** The title the chart shows: its own, or (automatic) the one series' name. */
export function shownTitle(chart: Chart, data: ChartData): string {
  if (chart.title !== null) return chart.title;
  if (data.series.length === 1 && chart.series[0]?.name) return data.series[0].name;
  return '';
}

/** Draws the whole chart into a box w by h (pixels, or points on paper). */
export function drawChart(p: Painter, chart: Chart, data: ChartData, w: number, h: number): void {
  const LABEL = 12;
  const pad = 10;
  p.rect(0.5, 0.5, w - 1, h - 1, '#ffffff', GRIDLINE, 1);
  p.clip(0, 0, w, h);
  let top = pad;
  let bottom = h - pad;
  let left = pad;
  let right = w - pad;

  const title = shownTitle(chart, data);
  if (title) {
    p.text(w / 2, top + 10, fitText(title, w - pad * 2, 16), { size: 16, colour: INK, align: 'c' });
    top += 28;
  }

  const round = chart.type === 'pie' || chart.type === 'doughnut';
  // Legend: the series (or, for a pie, the slices), each with its colour and, for lines, its marker shape.
  type Entry = { text: string; colour: string; marker?: Marker };
  const entries: Entry[] = chart.legend === 'none' ? [] : round
    ? data.cats.slice(0, 40).map((c, i) => ({ text: c, colour: SERIES_COLOURS[i % SERIES_COLOURS.length] }))
    : data.series.map((x, i) => ({ text: x.name, colour: x.colour, marker: chart.type === 'line' || chart.type === 'scatter' ? MARKERS[i % MARKERS.length] : undefined }));
  if (entries.length) {
    const key = (e: Entry, x: number, y: number) => {
      if (e.marker) {
        if (chart.type === 'line') p.line([x, y, x + 14, y], e.colour, 2);
        drawMarker(p, e.marker, x + 7, y, 3.5, e.colour);
      } else p.rect(x + 2, y - 5, 10, 10, e.colour);
    };
    if (chart.legend === 'r' || chart.legend === 'l') {
      const width = Math.min((right - left) * 0.4, Math.max(...entries.map(e => textWidth(e.text, LABEL))) + 24);
      const shown = entries.slice(0, Math.max(1, Math.floor((bottom - top) / 18)));
      let y = (top + bottom) / 2 - (shown.length * 18) / 2 + 9;
      const x = chart.legend === 'r' ? right - width : left;
      for (const e of shown) {
        key(e, x, y);
        p.text(x + 18, y, fitText(e.text, width - 20, LABEL), { size: LABEL, colour: INK });
        y += 18;
      }
      if (chart.legend === 'r') right -= width + 6;
      else left += width + 6;
    } else {
      // Along the top or bottom, in as many rows as it needs (at most three).
      const rows: Entry[][] = [[]];
      let used = 0;
      const room = right - left;
      for (const e of entries) {
        const ew = Math.min(room, textWidth(e.text, LABEL) + 30);
        if (used + ew > room && rows[rows.length - 1].length) {
          if (rows.length === 3) break;
          rows.push([]);
          used = 0;
        }
        rows[rows.length - 1].push(e);
        used += ew;
      }
      const height = rows.length * 18;
      let y = chart.legend === 't' ? top + 9 : bottom - height + 9;
      for (const row of rows) {
        const total = row.reduce((n, e) => n + Math.min(room, textWidth(e.text, LABEL) + 30), 0);
        let x = left + (room - total) / 2;
        for (const e of row) {
          const ew = Math.min(room, textWidth(e.text, LABEL) + 30);
          key(e, x, y);
          p.text(x + 18, y, fitText(e.text, ew - 22, LABEL), { size: LABEL, colour: INK });
          x += ew;
        }
        y += 18;
      }
      if (chart.legend === 't') top += height + 6;
      else bottom -= height + 6;
    }
  }

  if (round) drawRound(p, chart, data, left, top, right, bottom);
  else drawAxes(p, chart, data, left, top, right, bottom);
  p.unclip();
}

function drawRound(p: Painter, chart: Chart, data: ChartData, left: number, top: number, right: number, bottom: number): void {
  const values = (data.series[0]?.values ?? []).map(v => (v !== null && v > 0 ? v : 0));
  const total = values.reduce((a, b) => a + b, 0);
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  const r = Math.max(4, Math.min(right - left, bottom - top) / 2 - 4);
  const inner = chart.type === 'doughnut' ? r * 0.5 : 0;
  if (!total) {
    p.circle(cx, cy, r, null, GRIDLINE, 1);
    return;
  }
  let a = 0;
  const mids: Array<{ a: number; v: number; i: number }> = [];
  values.forEach((v, i) => {
    if (!v) return;
    const a1 = a + (v / total) * Math.PI * 2;
    // A white edge between slices, as Excel draws them.
    p.shape(slice(cx, cy, r, inner, a, a1), SERIES_COLOURS[i % SERIES_COLOURS.length], '#ffffff', 1);
    mids.push({ a: (a + a1) / 2, v, i });
    a = a1;
  });
  if (chart.labels) {
    const rr = inner ? (r + inner) / 2 : r * 0.62;
    for (const m of mids) {
      const label = data.fmt(m.v);
      p.text(cx + rr * Math.sin(m.a), cy - rr * Math.cos(m.a), label, { size: 12, colour: m.i % SERIES_COLOURS.length === 3 || m.i % SERIES_COLOURS.length === 2 ? '#000' : '#fff', align: 'c', bold: true });
    }
  }
}

function drawAxes(p: Painter, chart: Chart, data: ChartData, left: number, top: number, right: number, bottom: number): void {
  const LABEL = 12;
  const horizontal = chart.type === 'bar';
  const scatter = chart.type === 'scatter';
  const percent = chart.group === 'percent' && (chart.type === 'column' || chart.type === 'bar' || chart.type === 'area');
  const stacked = !!chart.group && (chart.type === 'column' || chart.type === 'bar' || chart.type === 'area');
  const n = scatter ? 0 : Math.max(1, data.cats.length);

  // What the value axis must reach: the values, or the stacks of them.
  let vmin = Infinity;
  let vmax = -Infinity;
  if (stacked) {
    for (let k = 0; k < n; k++) {
      let pos = 0;
      let neg = 0;
      for (const x of data.series) {
        const v = x.values[k] ?? 0;
        if (v >= 0) pos += v;
        else neg += v;
      }
      if (percent) {
        const sum = pos - neg;
        pos = sum ? pos / sum : 0;
        neg = sum ? neg / sum : 0;
      }
      vmin = Math.min(vmin, neg);
      vmax = Math.max(vmax, pos);
    }
  } else {
    for (const x of data.series) for (const v of x.values) if (v !== null) {
      vmin = Math.min(vmin, v);
      vmax = Math.max(vmax, v);
    }
  }
  if (vmin === Infinity) {
    vmin = 0;
    vmax = 1;
  }
  const fmt = percent ? (v: number) => `${Math.round(v * 100)}%` : data.fmt;

  // Axis titles take a line each.
  if (chart.yTitle) left += 20;
  if (chart.xTitle) bottom -= 20;
  const valueRoom = horizontal ? right - left : bottom - top;
  const scale = niceScale(vmin, vmax, Math.max(2, Math.floor(valueRoom / (horizontal ? 70 : 28))), chart.type !== 'line' && !scatter);
  if (percent) {
    scale.lo = Math.max(scale.lo, vmin < 0 ? -1 : 0);
    scale.hi = Math.min(scale.hi, 1);
  }
  const vt = ticks(scale);
  let xScale = scale;
  let xt: number[] = [];
  if (scatter) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const x of data.series) for (const v of x.xs ?? []) if (v !== null) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    if (lo === Infinity) {
      lo = 0;
      hi = 1;
    }
    xScale = niceScale(lo, hi, Math.max(2, Math.floor((right - left) / 70)), false);
    xt = ticks(xScale);
  }

  // Room for the labels: value labels beside the plot (or under it, for bars), categories under it (or beside it).
  const valueLabels = vt.map(fmt);
  const catLabels = scatter ? xt.map(data.xfmt) : data.cats;
  // The band beside the plot for labels: the categories (bars) or the values (everything else).
  const labelBand = horizontal
    ? Math.min((right - left) * 0.35, Math.max(...catLabels.slice(0, 200).map(c => textWidth(c, LABEL)), 10) + 8)
    : Math.max(...valueLabels.map(c => textWidth(c, LABEL)), 10) + 8;
  left += labelBand;
  bottom -= 18;
  right = Math.max(left + 10, right - 4);
  bottom = Math.max(top + 10, bottom);
  const pw = right - left;
  const ph = bottom - top;
  if (pw < 10 || ph < 10) return;

  // Where a value lands: up the plot (columns, lines, areas, scatter) or across it (bars).
  const vPos = (v: number) => (horizontal ? left + ((v - scale.lo) / (scale.hi - scale.lo)) * pw : bottom - ((v - scale.lo) / (scale.hi - scale.lo)) * ph);
  const xPos = (v: number) => left + ((v - xScale.lo) / (xScale.hi - xScale.lo)) * pw;
  // The middle of category k: across (columns) or up from the bottom (bars: the first category at the bottom, as Excel).
  const band = horizontal ? ph / n : pw / n;
  const catMid = (k: number) => (horizontal ? bottom - band * (k + 0.5) : left + band * (k + 0.5));

  // Gridlines and value labels.
  for (let k = 0; k < vt.length; k++) {
    const at = vPos(vt[k]);
    if (horizontal) {
      p.line([at, top, at, bottom], GRIDLINE, 1);
      p.text(at, bottom + 10, valueLabels[k], { size: LABEL, colour: INK, align: 'c' });
    } else {
      p.line([left, at, right, at], GRIDLINE, 1);
      p.text(left - 5, at, valueLabels[k], { size: LABEL, colour: INK, align: 'r' });
    }
  }
  if (scatter) {
    for (let k = 0; k < xt.length; k++) {
      const at = xPos(xt[k]);
      p.line([at, bottom, at, bottom + 4], AXIS, 1);
      p.text(at, bottom + 10, catLabels[k], { size: LABEL, colour: INK, align: 'c' });
    }
  } else {
    // Category labels: every one when they fit, else every second (third...) one, each cut to its room.
    const widest = Math.max(...catLabels.slice(0, 500).map(c => textWidth(c, LABEL)), 1);
    const every = horizontal ? Math.max(1, Math.ceil(16 / band)) : Math.max(1, Math.ceil((widest + 6) / band));
    const roomEach = horizontal ? labelBand - 8 : band * Math.min(every, 4) - 4;
    for (let k = 0; k < n; k += every) {
      const label = fitText(catLabels[k] ?? '', Math.max(10, roomEach), LABEL);
      if (horizontal) p.text(left - 5, catMid(k), label, { size: LABEL, colour: INK, align: 'r' });
      else p.text(catMid(k), bottom + 10, label, { size: LABEL, colour: INK, align: 'c' });
    }
  }
  // The axis line at zero (or along the edge).
  const zero = vPos(Math.max(scale.lo, Math.min(scale.hi, 0)));
  if (horizontal) p.line([zero, top, zero, bottom], AXIS, 1);
  else if (scatter) p.line([left, bottom, right, bottom], AXIS, 1);
  else p.line([left, zero, right, zero], AXIS, 1);

  if (chart.yTitle) p.text(left - labelBand - 10, (top + bottom) / 2, fitText(chart.yTitle, ph, LABEL), { size: LABEL, colour: INK, align: 'c', rotate: -90 });
  if (chart.xTitle) p.text((left + right) / 2, bottom + 30, fitText(chart.xTitle, pw, LABEL), { size: LABEL, colour: INK, align: 'c' });

  p.clip(left - 1, top - 1, pw + 2, ph + 2);
  const series = data.series;
  const labelAt: Array<{ x: number; y: number; text: string; side?: boolean }> = [];
  if (chart.type === 'column' || chart.type === 'bar') {
    // Excel's spacing: the gap between groups is 1.5 bars wide (gap width 150%); stacked bars share one place.
    const slots = stacked ? 1 : Math.max(1, series.length);
    const barW = band / (slots + 1.5);
    const base = vPos(Math.max(scale.lo, Math.min(scale.hi, 0)));
    for (let k = 0; k < n; k++) {
      let pos = 0;
      let neg = 0;
      let sum = 0;
      if (percent) for (const x of series) sum += Math.abs(x.values[k] ?? 0);
      series.forEach((x, i) => {
        let v = x.values[k];
        if (v === null || v === undefined) return;
        if (percent) v = sum ? v / sum : 0;
        let from = 0;
        let to = v;
        if (stacked) {
          if (v >= 0) {
            from = pos;
            pos += v;
            to = pos;
          } else {
            from = neg;
            neg += v;
            to = neg;
          }
        }
        const slot = stacked ? 0 : i;
        // Bars across a band: the first series nearest the axis start (the left, or for bars the bottom, as Excel).
        const offset = barW * 0.75 + slot * barW;
        const a = stacked ? vPos(from) : base;
        const b = vPos(to);
        if (horizontal) {
          const yy = bottom - band * k - offset - barW;
          p.rect(Math.min(a, b), yy, Math.abs(b - a), barW, x.colour);
          if (chart.labels) labelAt.push({ x: Math.max(a, b) + 4, y: yy + barW / 2, text: data.fmt(x.values[k]!) });
        } else {
          const xx = left + band * k + offset;
          p.rect(xx, Math.min(a, b), barW, Math.abs(b - a), x.colour);
          if (chart.labels) labelAt.push({ x: xx + barW / 2, y: Math.min(a, b) - 8, text: data.fmt(x.values[k]!) });
        }
      });
    }
  } else if (chart.type === 'area') {
    const below = new Array(n).fill(0);
    series.forEach(x => {
      const pts: number[] = [];
      const under: number[] = [];
      for (let k = 0; k < n; k++) {
        let v = x.values[k] ?? 0;
        if (percent) {
          const sum = series.reduce((t, y) => t + Math.abs(y.values[k] ?? 0), 0);
          v = sum ? v / sum : 0;
        }
        const from = stacked ? below[k] : 0;
        const to = from + v;
        if (stacked) below[k] = to;
        // An area's points sit on the category lines, from the first to the last (not in the middle of each).
        const xk = n > 1 ? left + (pw * k) / (n - 1) : left + pw / 2;
        pts.push(xk, vPos(to));
        under.unshift(xk, vPos(from));
      }
      p.shape([...pts, ...under], x.colour, null);
    });
  } else {
    // Lines and scatter points, each series with its own marker shape.
    series.forEach((x, i) => {
      const marker = MARKERS[i % MARKERS.length];
      const pts: Array<[number, number] | null> = x.values.map((v, k) => {
        if (v === null) return null;
        const xv = scatter ? x.xs?.[k] : k;
        if (xv === null || xv === undefined) return null;
        return [scatter ? xPos(xv) : catMid(k), vPos(v)];
      });
      if (chart.type === 'line') {
        let run: number[] = [];
        for (const pt of pts) {
          if (pt) run.push(pt[0], pt[1]);
          else {
            if (run.length >= 4) p.line(run, x.colour, 2.25);
            run = [];
          }
        }
        if (run.length >= 4) p.line(run, x.colour, 2.25);
      }
      pts.forEach((pt, k) => {
        if (!pt) return;
        drawMarker(p, marker, pt[0], pt[1], scatter ? 4 : 3.5, x.colour);
        // Beside the point, to its right (Excel's place for a line's labels), so it never sits on the line.
        if (chart.labels) labelAt.push({ x: pt[0] + 7, y: pt[1], text: data.fmt(x.values[k]!), side: true });
      });
    });
  }
  p.unclip();
  for (const l of labelAt) p.text(l.x, l.y, l.text, { size: LABEL, colour: INK, align: horizontal || l.side ? 'l' : 'c' });
}

// ---- Saving ---------------------------------------------------------------------------------------------------------

const SERIES_REF_MAX = 1000;

/** A chart from a saved file, every field checked; null when it is not one. */
export function cleanChart(raw: unknown): Chart | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!CHART_TYPES.includes(r.type as ChartType)) return null;
  const at = r.at as Record<string, unknown> | undefined;
  const int = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : lo);
  if (!at || typeof at !== 'object' || !Array.isArray(r.series)) return null;
  const str = (v: unknown, max = SERIES_REF_MAX) => (typeof v === 'string' ? v.slice(0, max) : '');
  const colour = (v: unknown) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : undefined);
  const series: ChartSeries[] = [];
  for (const s of r.series.slice(0, MAX_SERIES)) {
    if (!s || typeof s !== 'object') continue;
    const x = s as Record<string, unknown>;
    const val = str(x.val);
    if (!val) continue;
    const one: ChartSeries = { name: str(x.name, 255), cat: str(x.cat), val };
    const c = colour(x.colour);
    if (c) one.colour = c;
    series.push(one);
  }
  if (!series.length) return null;
  const chart: Chart = {
    id: int(r.id, 1, 1_000_000),
    type: r.type as ChartType,
    title: r.title === null ? null : str(r.title, 255),
    series,
    legend: ['r', 'b', 't', 'l', 'none'].includes(r.legend as string) ? (r.legend as Chart['legend']) : 'r',
    at: { col: int(at.col, 0, MAX_COLS - 1), row: int(at.row, 0, MAX_ROWS - 1), dx: int(at.dx, 0, 4000), dy: int(at.dy, 0, 4000) },
    w: int(r.w, 60, 4000),
    h: int(r.h, 40, 4000),
  };
  if (r.group === 'stacked' || r.group === 'percent') chart.group = r.group;
  if (typeof r.xTitle === 'string' && r.xTitle) chart.xTitle = r.xTitle.slice(0, 255);
  if (typeof r.yTitle === 'string' && r.yTitle) chart.yTitle = r.yTitle.slice(0, 255);
  if (r.labels === true) chart.labels = true;
  return chart;
}

/** A short description of a chart for a list or a screen reader ("Column chart: Sales, Costs"). */
export function describeChart(chart: Chart, data: ChartData): string {
  const title = shownTitle(chart, data);
  const names = data.series.map(s => s.name).slice(0, 6).join(', ');
  return `${CHART_LABEL[chart.type]} chart${title ? ` “${title}”` : ''}${names ? `: ${names}` : ''}`;
}

/** Cell address text for a series' values, for showing in a dialog ("Sheet1!B2:B6"). */
export const plainRef = (text: string): string => text.replace(/\$/g, '');
void addressOf;
