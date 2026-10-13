// The spreadsheet's grid: draws the visible cells on a canvas and handles selecting, typing into cells, the fill
// handle, resizing rows and columns, copy and paste, and the keyboard the way Excel does. Only what is on screen is
// drawn or worked out, so a big sheet stays fast on a small device.
import { css, h, on } from '../../core/dom.ts';
import { clamp } from '../../core/dom.ts';
import { bindContextMenu, type MenuItem } from '../../shell/menu.ts';
import type { Shell } from '../../shell/types.ts';
import { addressOf, colName, MAX_COLS, MAX_ROWS, SyntaxProblem } from './refs.ts';
import { cfLook, type CfLook } from './condfmt.ts';
import { CellError, type CellStyle } from './values.ts';
import { describeValidation, listItems, passes, validationAt, type Validation } from './validate.ts';
import { colOfKey, keyOf, parseDelimited, rowOfKey, type Range, type Workbook } from './workbook.ts';

const HEAD_W = 46;
const HEAD_H = 24;
const COL_W = 64;
const ROW_H = 20;
/** One line of wrapped text, and the most lines a wrapped cell is laid out to (a row is at most 400 high anyway). */
const LINE_H = 17;
const MAX_LINES = 60;
/** How many wrapped cells are measured to size their rows after a change (beyond that, rows keep their heights). */
const MAX_FIT_CELLS = 5000;

const fontFor = (style: CellStyle | undefined, z: number): string =>
  `${style?.i ? 'italic ' : ''}${style?.b ? 'bold ' : ''}${13 * z}px "Segoe UI", Arial, Helvetica, sans-serif`;

/** Text laid out in lines no wider than `width`: at its own line breaks, then between words (a long word is cut). */
function wrapLines(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    let line = '';
    for (const word of para.split(/(?<= )/)) {
      if (ctx.measureText(line + word).width <= width || line === '') {
        line += word;
        // A word wider than the cell on its own is cut into pieces that fit.
        while (ctx.measureText(line).width > width && line.length > 1) {
          let cut = line.length - 1;
          while (cut > 1 && ctx.measureText(line.slice(0, cut)).width > width) cut--;
          out.push(line.slice(0, cut));
          line = line.slice(cut);
          if (out.length >= MAX_LINES) return out;
        }
      } else {
        out.push(line.trimEnd());
        line = word;
      }
      if (out.length >= MAX_LINES) return out;
    }
    out.push(line.trimEnd());
    if (out.length >= MAX_LINES) return out;
  }
  return out;
}
const FONT = '13px "Segoe UI", Arial, Helvetica, sans-serif';
const GRID = '#d9d9d9';
const HEAD_BG = '#f0f0f0';
const HEAD_SEL = '#d3e3d8';
const ACCENT = '#1e7a45';
/** The thin line round the cells a list formula fills, while one of them is selected (blue, as in Excel). */
const SPILL_EDGE = '#2f6fd0';
/** The line along frozen rows and columns, and the mark of a filtered column. */
const FREEZE_EDGE = '#8c8c8c';
const FILTERED = '#2f6fd0';
const EDGE = 5;

interface Clip {
  sheet: number;
  range: Range;
  cut: boolean;
  text: string;
}

export interface Grid {
  readonly el: HTMLElement;
  readonly formulaInput: HTMLTextAreaElement;
  readonly nameBox: HTMLInputElement;
  wb: Workbook;
  sel(): Range;
  active(): { col: number; row: number };
  editing(): boolean;
  focus(): void;
  redraw(): void;
  select(r: Range, active?: { col: number; row: number }): void;
  goTo(col: number, row: number): void;
  setZoom(z: number): void;
  zoom(): number;
  commit(): boolean;
  autoSum(): void;
  copy(cut: boolean): void;
  paste(): void;
  deleteContents(): void;
  insert(axis: 'row' | 'col'): void;
  remove(axis: 'row' | 'col'): void;
  setActiveSheet(i: number): void;
  widen(r: Range): void;
  /** Sizes rows to their wrapped text (rows sized by hand are left alone). */
  fitRows(): void;
  /** Hides (or shows again) the selected rows or columns. */
  hide(axis: 'row' | 'col', hidden: boolean): void;
  /** Called when a filter header's ▾ button is pressed (column, and the screen point under the button). */
  onFilterButton: (col: number, x: number, y: number) => void;
  /** Where a cell is drawn, in pixels from the top-left of the grid (its merged block's box for a merged cell). */
  cellBox(col: number, row: number): { x: number; y: number; w: number; h: number };
  /** The cell under a point (pixels from the top-left of the grid), and how far into it the point is (unzoomed pixels). */
  cellAt(x: number, y: number): { col: number; row: number; dx: number; dy: number };
  /** Where the part that scrolls begins (the frozen rows and columns, and the headings, are above and left of it). */
  scrollEdge(): { x: number; y: number };
  scrollBy(dx: number, dy: number): void;
  /** The size of the part the cells are drawn in (without its scroll bars). */
  viewSize(): { w: number; h: number };
  /** Called after every redraw (scrolling, zooming, a change). */
  onPaint: () => void;
  /** Opens the drop-down list of the active cell's validation rule, if it has one. */
  openList(): void;
  /** Where printed pages end, drawn as dashed lines (the first column and row of each new page); null for none. */
  breaks: { cols: number[]; rows: number[] } | null;
  onChange: () => void;
  onSelect: () => void;
  onEdit: (editing: boolean) => void;
}

export function createGrid(shell: Shell, wb: Workbook, signal: AbortSignal): Grid {
  const scroller = h('div', { class: 'grid-scroll', tabindex: 0, role: 'application', 'aria-label': 'Spreadsheet grid' });
  const spacer = h('div', { class: 'grid-spacer' });
  scroller.append(spacer);
  const canvas = h('canvas', { class: 'grid-canvas', 'aria-hidden': 'true' });
  // Text areas, not one-line boxes: a cell can hold several lines (Alt+Enter, or pasted text keeps its line breaks).
  const cellInput = h('textarea', { class: 'grid-editor', 'aria-label': 'Cell contents', spellcheck: 'false', autocomplete: 'off', rows: 1, wrap: 'off' });
  css(cellInput, { display: 'none' });
  const live = h('div', { class: 'visually-hidden', role: 'status', 'aria-live': 'polite' });
  // A validation rule's input message, shown beside the active cell.
  const prompt = h('div', { class: 'dv-prompt', role: 'note', hidden: true });
  const root = h('div', { class: 'grid-wrap' }, canvas, scroller, cellInput, prompt, live);
  let listBox: HTMLElement | null = null;
  const formulaInput = h('textarea', { class: 'formula-input', 'aria-label': 'Formula bar', spellcheck: 'false', autocomplete: 'off', rows: 1, wrap: 'off' });
  const nameBox = h('input', { type: 'text', class: 'name-box', 'aria-label': 'Cell address', spellcheck: 'false', autocomplete: 'off', value: 'A1' });

  const state = {
    zoom: 1,
    anchor: { col: 0, row: 0 },
    cursor: { col: 0, row: 0 },
    editing: false,
    formulaMode: false,
    clip: null as Clip | null,
    colPos: [0] as number[],
    rowPos: [0] as number[],
    geomVersion: -1,
    frame: 0,
    fillTo: null as Range | null,
    /** Where Tab-ing along a row began: Enter returns there, as it does in Excel. */
    tabCol: null as number | null,
    pointAt: null as { start: number; end: number } | null,
    /** The person said "Yes, keep it" to a validation warning: the next commit is not checked again. */
    allowOnce: false,
    perSheet: new Map<number, { anchor: { col: number; row: number }; cursor: { col: number; row: number } }>(),
  };

  const grid: Grid = {
    el: root,
    formulaInput,
    nameBox,
    wb,
    sel,
    active: () => ({ ...state.cursor }),
    editing: () => state.editing,
    focus: () => scroller.focus({ preventScroll: true }),
    redraw,
    select,
    goTo: (col, row) => {
      select({ c0: col, r0: row, c1: col, r1: row });
      reveal(col, row);
    },
    setZoom,
    zoom: () => state.zoom,
    commit,
    autoSum,
    copy,
    paste,
    deleteContents,
    insert: axis => shift(axis, 1),
    remove: axis => shift(axis, -1),
    setActiveSheet,
    widen: () => {},
    fitRows: () => fitRows(),
    hide: (axis, hidden) => hide(axis, hidden),
    onFilterButton: () => {},
    cellBox: (col, row) => cellRect(col, row),
    cellAt: (x, y) => {
      const p = hit(x, y);
      const b = rect(p.col, p.row, p.col, p.row);
      return { col: p.col, row: p.row, dx: Math.max(0, (x - b.x) / state.zoom), dy: Math.max(0, (y - b.y) / state.zoom) };
    },
    scrollEdge: () => {
      geometry();
      const f = frozen();
      return { x: (HEAD_W + f.fw) * state.zoom, y: (HEAD_H + f.fh) * state.zoom };
    },
    scrollBy: (dx, dy) => {
      scroller.scrollLeft += dx;
      scroller.scrollTop += dy;
    },
    viewSize: () => ({ w: scroller.clientWidth, h: scroller.clientHeight }),
    onPaint: () => {},
    openList: () => openList(),
    breaks: null,
    onChange: () => {},
    onSelect: () => {},
    onEdit: () => {},
  };

  // ---- Geometry --------------------------------------------------------------------------------------------------

  function geometry(): void {
    if (state.geomVersion === grid.wb.version && state.colPos.length === MAX_COLS + 1) return;
    state.geomVersion = grid.wb.version;
    const sheet = grid.wb.sheets[grid.wb.active];
    const cols = [0];
    // A hidden row or column takes no room.
    for (let c = 0; c < MAX_COLS; c++) cols.push(cols[c] + (sheet.hiddenCols.has(c) ? 0 : sheet.colW.get(c) ?? COL_W));
    const rows = [0];
    for (let r = 0; r < MAX_ROWS; r++) rows.push(rows[r] + (sheet.hiddenRows.has(r) ? 0 : sheet.rowH.get(r) ?? ROW_H));
    state.colPos = cols;
    state.rowPos = rows;
    const z = state.zoom;
    css(spacer, { width: HEAD_W * z + cols[MAX_COLS] * z, height: HEAD_H * z + rows[MAX_ROWS] * z });
  }

  const search = (pos: number[], v: number): number => {
    let lo = 0;
    let hi = pos.length - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (pos[mid] <= v) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  /** The frozen part: how many columns and rows, and how wide and tall it is (unscaled). */
  function frozen(): { fc: number; fr: number; fw: number; fh: number } {
    const f = grid.wb.sheets[grid.wb.active].freeze;
    return { fc: f.cols, fr: f.rows, fw: state.colPos[f.cols] ?? 0, fh: state.rowPos[f.rows] ?? 0 };
  }

  // Where a column or row starts and ends on screen (scaled pixels): frozen ones never scroll.
  const colLeft = (c: number): number => (HEAD_W + state.colPos[c] - (c < frozen().fc ? 0 : scroller.scrollLeft / state.zoom)) * state.zoom;
  const colRight = (c: number): number => (HEAD_W + state.colPos[c + 1] - (c < frozen().fc ? 0 : scroller.scrollLeft / state.zoom)) * state.zoom;
  const rowTop = (r: number): number => (HEAD_H + state.rowPos[r] - (r < frozen().fr ? 0 : scroller.scrollTop / state.zoom)) * state.zoom;
  const rowBottom = (r: number): number => (HEAD_H + state.rowPos[r + 1] - (r < frozen().fr ? 0 : scroller.scrollTop / state.zoom)) * state.zoom;

  /** Which cell (or header) is under a point given in pixels from the top-left of the grid area. */
  function hit(x: number, y: number): { col: number; row: number; where: 'cell' | 'colhead' | 'rowhead' | 'corner' } {
    geometry();
    const z = state.zoom;
    const lx = x / z;
    const ly = y / z;
    const { fc, fr, fw, fh } = frozen();
    const cx = Math.max(0, lx - HEAD_W);
    const cy = Math.max(0, ly - HEAD_H);
    const col = clamp(fc && cx < fw ? Math.min(fc - 1, search(state.colPos, cx)) : search(state.colPos, cx + scroller.scrollLeft / z), 0, MAX_COLS - 1);
    const row = clamp(fr && cy < fh ? Math.min(fr - 1, search(state.rowPos, cy)) : search(state.rowPos, cy + scroller.scrollTop / z), 0, MAX_ROWS - 1);
    if (lx < HEAD_W && ly < HEAD_H) return { col, row, where: 'corner' };
    if (ly < HEAD_H) return { col, row, where: 'colhead' };
    if (lx < HEAD_W) return { col, row, where: 'rowhead' };
    return { col, row, where: 'cell' };
  }

  /** Screen rectangle (scaled pixels) of a cell block. */
  function rect(c0: number, r0: number, c1: number, r1: number): { x: number; y: number; w: number; h: number } {
    geometry();
    const x = colLeft(c0);
    const y = rowTop(r0);
    return { x, y, w: colRight(c1) - x, h: rowBottom(r1) - y };
  }

  /** The cell's rectangle, or its merged block's. */
  function cellRect(col: number, row: number): { x: number; y: number; w: number; h: number } {
    const m = grid.wb.mergeAt(grid.wb.active, col, row);
    return m ? rect(m.c0, m.r0, m.c1, m.r1) : rect(col, row, col, row);
  }

  function reveal(col: number, row: number): void {
    geometry();
    const z = state.zoom;
    const { fc, fr, fw, fh } = frozen();
    const vw = scroller.clientWidth;
    const vh = scroller.clientHeight;
    // Frozen cells are always in view; the others are brought out from under the frozen part as well as from the edges.
    if (col >= fc) {
      const edge = (HEAD_W + fw) * z;
      const x = colLeft(col);
      const x2 = colRight(col);
      if (x < edge) scroller.scrollLeft += x - edge;
      else if (x2 > vw) scroller.scrollLeft += Math.min(x2 - vw, x - edge);
    }
    if (row >= fr) {
      const edge = (HEAD_H + fh) * z;
      const y = rowTop(row);
      const y2 = rowBottom(row);
      if (y < edge) scroller.scrollTop += y - edge;
      else if (y2 > vh) scroller.scrollTop += Math.min(y2 - vh, y - edge);
    }
  }

  // ---- Selection -------------------------------------------------------------------------------------------------

  function sel(): Range {
    // A selection that touches merged cells takes in the whole of each block, as in Excel.
    return grid.wb.growToMerges(grid.wb.active, {
      c0: Math.min(state.anchor.col, state.cursor.col),
      c1: Math.max(state.anchor.col, state.cursor.col),
      r0: Math.min(state.anchor.row, state.cursor.row),
      r1: Math.max(state.anchor.row, state.cursor.row),
    });
  }

  /** A cell inside a merged block stands for the block: its top-left cell. */
  function topLeft(col: number, row: number): { col: number; row: number } {
    const m = grid.wb.mergeAt(grid.wb.active, col, row);
    return m ? { col: m.c0, row: m.r0 } : { col, row };
  }

  function select(r: Range, active?: { col: number; row: number }): void {
    const a = active ?? { col: r.c0, row: r.r0 };
    state.cursor = { ...a };
    // The anchor is the corner opposite the active cell.
    state.anchor = { col: a.col === r.c0 ? r.c1 : r.c0, row: a.row === r.r0 ? r.r1 : r.r0 };
    changed();
  }

  function moveCursor(col: number, row: number, extend: boolean): void {
    let c = clamp(col, 0, MAX_COLS - 1);
    let r = clamp(row, 0, MAX_ROWS - 1);
    if (!extend) ({ col: c, row: r } = topLeft(c, r));
    state.cursor = { col: c, row: r };
    if (!extend) state.anchor = { col: c, row: r };
    reveal(c, r);
    changed();
  }

  /**
   * One step from the active cell (an arrow key, Enter, Tab): past the far side of a merged block, and over hidden rows
   * and columns. Stays put at the edge of the sheet.
   */
  function step(dc: number, dr: number, from = state.cursor): { col: number; row: number } {
    const sheet = grid.wb.sheets[grid.wb.active];
    const m = grid.wb.mergeAt(grid.wb.active, from.col, from.row);
    let col = dc > 0 ? (m ? m.c1 : from.col) + 1 : dc < 0 ? (m ? m.c0 : from.col) - 1 : from.col;
    let row = dr > 0 ? (m ? m.r1 : from.row) + 1 : dr < 0 ? (m ? m.r0 : from.row) - 1 : from.row;
    while (dc && col >= 0 && col < MAX_COLS && sheet.hiddenCols.has(col)) col += dc;
    while (dr && row >= 0 && row < MAX_ROWS && sheet.hiddenRows.has(row)) row += dr;
    if (col < 0 || col >= MAX_COLS || row < 0 || row >= MAX_ROWS) return { ...from };
    return { col, row };
  }

  function changed(): void {
    nameBox.value = sel().c0 === sel().c1 && sel().r0 === sel().r1 ? addressOf(state.cursor.col, state.cursor.row) : `${addressOf(sel().c0, sel().r0)}:${addressOf(sel().c1, sel().r1)}`;
    if (!state.editing) {
      formulaInput.value = grid.wb.editText(grid.wb.active, state.cursor.col, state.cursor.row);
      // A cell a list fills shows the list's formula, greyed (it is the formula's cell that holds it).
      formulaInput.placeholder = formulaInput.value === '' ? grid.wb.spillFormula(grid.wb.active, state.cursor.col, state.cursor.row) ?? '' : '';
      sizeBar();
    }
    const v = grid.wb.value(grid.wb.active, state.cursor.col, state.cursor.row);
    live.textContent = `${addressOf(state.cursor.col, state.cursor.row)}: ${v === null ? 'empty' : grid.wb.display(grid.wb.active, state.cursor.col, state.cursor.row)}`;
    grid.onSelect();
    redraw();
  }

  function setActiveSheet(i: number): void {
    commit();
    state.perSheet.set(grid.wb.active, { anchor: { ...state.anchor }, cursor: { ...state.cursor } });
    grid.wb.active = i;
    const saved = state.perSheet.get(i);
    state.anchor = saved ? { ...saved.anchor } : { col: 0, row: 0 };
    state.cursor = saved ? { ...saved.cursor } : { col: 0, row: 0 };
    state.geomVersion = -1;
    scroller.scrollLeft = 0;
    scroller.scrollTop = 0;
    changed();
    grid.onChange();
  }

  // ---- Drawing ---------------------------------------------------------------------------------------------------

  function redraw(): void {
    if (state.frame) return;
    state.frame = requestAnimationFrame(() => {
      state.frame = 0;
      paint();
    });
  }

  function resizeCanvas(): { w: number; h: number; dpr: number } {
    const dpr = window.devicePixelRatio || 1;
    const w = scroller.clientWidth;
    const hh = scroller.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hh * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(hh * dpr);
      css(canvas, { width: w, height: hh });
    }
    return { w, h: hh, dpr };
  }

  function paint(): void {
    const ctx = canvas.getContext('2d');
    if (!ctx || !root.isConnected) return;
    geometry();
    const { w, h: vh, dpr } = resizeCanvas();
    const z = state.zoom;
    const wbk = grid.wb;
    const sheetIndex = wbk.active;
    const sheet = wbk.sheets[sheetIndex];
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, vh);
    ctx.font = FONT.replace('13px', `${13 * z}px`);
    ctx.textBaseline = 'middle';

    const left = scroller.scrollLeft / z;
    const top = scroller.scrollTop / z;
    const { fc, fr, fw, fh } = frozen();
    const X = colLeft;
    const XR = colRight;
    const Y = rowTop;
    const YB = rowBottom;
    // The scrolling part starts after the frozen columns and rows.
    let cs0 = Math.max(fc, search(state.colPos, fw + left));
    let cs1 = cs0;
    while (cs1 < MAX_COLS - 1 && X(cs1 + 1) < w) cs1++;
    let rs0 = Math.max(fr, search(state.rowPos, fh + top));
    let rs1 = rs0;
    while (rs1 < MAX_ROWS - 1 && Y(rs1 + 1) < vh) rs1++;
    cs0 = Math.min(cs0, MAX_COLS - 1);
    rs0 = Math.min(rs0, MAX_ROWS - 1);
    const fx = (HEAD_W + fw) * z;
    const fy = (HEAD_H + fh) * z;
    type Pane = { c0: number; c1: number; r0: number; r1: number; x: number; y: number; x2: number; y2: number };
    const panes: Pane[] = [];
    const colParts: Array<[number, number, number, number]> = [];
    const rowParts: Array<[number, number, number, number]> = [];
    if (fc > 0) colParts.push([0, fc - 1, HEAD_W * z, fx]);
    colParts.push([cs0, cs1, fx, w]);
    if (fr > 0) rowParts.push([0, fr - 1, HEAD_H * z, fy]);
    rowParts.push([rs0, rs1, fy, vh]);
    for (const [r0, r1, y, y2] of rowParts) for (const [c0, c1, x, x2] of colParts) panes.push({ c0, c1, r0, r1, x, y, x2, y2 });

    const s = sel();
    const filter = sheet.filter;
    const merged = (c: number, r: number) => (sheet.merges.length ? wbk.mergeAt(sheetIndex, c, r) : null);
    // Conditional formatting: worked out once per cell drawn.
    const looks = new Map<number, CfLook | null>();
    const lookAt = (c: number, r: number): CfLook | null => {
      if (!sheet.cf.length) return null;
      const k = keyOf(c, r);
      let got = looks.get(k);
      if (got === undefined) {
        got = cfLook(wbk, sheetIndex, c, r);
        looks.set(k, got);
      }
      return got;
    };
    const visible = (p: Pane) => sheet.merges.filter(m => m.c0 <= p.c1 && m.c1 >= p.c0 && m.r0 <= p.r1 && m.r1 >= p.r0);

    /** One cell's text (or a merged block's, drawn over the whole block). */
    const drawText = (c: number, r: number, box: { x: number; y: number; w: number; h: number }, p: Pane, mergedBlock: boolean) => {
      const cell = sheet.cells.get(keyOf(c, r));
      const own = wbk.styleOf(cell);
      const cf = lookAt(c, r);
      const style: CellStyle | undefined = cf ? { ...own, b: cf.b ?? own?.b, i: cf.i ?? own?.i, u: cf.u ?? own?.u } : own;
      // An empty cell may show a value from a list formula above or to the left of it.
      if ((!cell || (cell.v === undefined && cell.f === undefined)) && !wbk.isSpilled(sheetIndex, c, r)) return;
      const look = wbk.shown(sheetIndex, c, r);
      const shown = look.text;
      if (shown === '') return;
      const { x, y, w: cw, h: ch } = box;
      const v = wbk.value(sheetIndex, c, r);
      // A colour from the number format ([Red] for minus amounts) wins over the cell's text colour, as in Excel.
      const ink = v instanceof CellError ? '#c0392b' : (cf?.color ?? look.color ?? style?.color ?? '#000');
      ctx.font = fontFor(style, z);
      ctx.fillStyle = ink;
      const isNum = typeof v === 'number';
      const align = style?.al ?? (isNum ? 'r' : v instanceof CellError || typeof v === 'boolean' ? 'c' : 'l');
      const pad = 3 * z;
      // Room for the filter button on a header cell.
      const button = filter && r === filter.range.r0 && c >= filter.range.c0 && c <= filter.range.c1 ? 17 * z : 0;
      if (style?.wrap && !isNum) {
        // Wrapped: line after line inside the cell, the last line where one line of text would sit.
        const lines = wrapLines(ctx, shown, cw - pad * 2 - button);
        const lh = LINE_H * z;
        let ly = y + ch - (ROW_H * z) / 2 - lh * (lines.length - 1);
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, y, cw - button, ch);
        ctx.clip();
        for (const line of lines) {
          const lw = ctx.measureText(line).width;
          const lx = align === 'r' ? x + cw - pad - button - lw : align === 'c' ? x + (cw - button - lw) / 2 : x + pad;
          ctx.fillText(line, lx, ly + z);
          if (style.u) ctx.fillRect(lx, ly + 7 * z, lw, Math.max(1, z));
          ly += lh;
        }
        ctx.restore();
        return;
      }
      // Not wrapped: line breaks show as spaces, on one line.
      let text = shown.replace(/\r?\n/g, ' ');
      let tw = ctx.measureText(text).width;
      let clipW = cw - button;
      if (tw > cw - pad * 2 - button) {
        if (isNum && style?.fmt !== 'text') {
          text = '#'.repeat(Math.max(1, Math.floor((cw - pad * 2 - button) / Math.max(1, ctx.measureText('#').width))));
          tw = ctx.measureText(text).width;
        } else if (align === 'l' && !mergedBlock && !button) {
          // Text runs on into empty cells on its right (not into merged ones, and not past this pane).
          let end = c + 1;
          let room = cw;
          const empty = (k: number) => !sheet.cells.get(keyOf(k, r))?.v && sheet.cells.get(keyOf(k, r))?.f === undefined && !wbk.isSpilled(sheetIndex, k, r) && !merged(k, r);
          while (end <= p.c1 + 1 && end < MAX_COLS && empty(end) && room < tw + pad * 2) {
            room += XR(end) - X(end);
            end++;
          }
          clipW = room;
          ctx.fillStyle = '#fff';
          ctx.fillRect(x + cw - 1, y + 1, room - cw, ch - 1);
          ctx.fillStyle = ink;
        }
      }
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, clipW, ch);
      ctx.clip();
      const tx = align === 'r' ? x + cw - pad - button - tw : align === 'c' ? x + (cw - button - tw) / 2 : x + pad;
      // At the bottom of a tall row (one grown for wrapped text beside it), as Excel places it.
      const ty = y + ch - (ROW_H * z) / 2;
      ctx.fillText(text, tx, ty + z);
      if (style?.u) ctx.fillRect(tx, ty + 7 * z, tw, Math.max(1, z));
      ctx.restore();
    };

    /** A border side: thin, medium or thick (wider lines), or double (two thin lines). */
    const side = (line: CellStyle['bt'], x1: number, y1: number, x2: number, y2: number, colour: string) => {
      if (!line) return;
      ctx.strokeStyle = colour;
      if (line === 'double') {
        ctx.lineWidth = 1;
        const dx = y1 === y2 ? 0 : 1.5;
        const dy = y1 === y2 ? 1.5 : 0;
        ctx.beginPath();
        ctx.moveTo(x1 - dx, y1 - dy); ctx.lineTo(x2 - dx, y2 - dy);
        ctx.moveTo(x1 + dx, y1 + dy); ctx.lineTo(x2 + dx, y2 + dy);
        ctx.stroke();
        return;
      }
      ctx.lineWidth = line === 'thick' ? 3 : line === 'medium' ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    };

    for (const p of panes) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(p.x, p.y, p.x2 - p.x, p.y2 - p.y);
      ctx.clip();
      const blocks = visible(p);

      // Cell fills (a merged block is filled as one, below).
      for (let r = p.r0; r <= p.r1; r++) {
        if (sheet.hiddenRows.has(r)) continue;
        for (let c = p.c0; c <= p.c1; c++) {
          const fill = lookAt(c, r)?.fill ?? wbk.styleOf(sheet.cells.get(keyOf(c, r)))?.fill;
          if (!fill || (blocks.length && merged(c, r))) continue;
          ctx.fillStyle = fill;
          ctx.fillRect(X(c), Y(r), XR(c) - X(c), YB(r) - Y(r));
        }
      }

      // Grid lines.
      ctx.strokeStyle = GRID;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let c = p.c0; c <= p.c1 + 1 && c <= MAX_COLS; c++) {
        const x = Math.round(c > p.c1 ? XR(p.c1) : X(c)) + 0.5;
        ctx.moveTo(x, p.y);
        ctx.lineTo(x, p.y2);
      }
      for (let r = p.r0; r <= p.r1 + 1 && r <= MAX_ROWS; r++) {
        const y = Math.round(r > p.r1 ? YB(p.r1) : Y(r)) + 0.5;
        ctx.moveTo(p.x, y);
        ctx.lineTo(p.x2, y);
      }
      ctx.stroke();

      // A merged block is one cell: its inside lines are covered with its fill (or white).
      for (const m of blocks) {
        const b = rect(m.c0, m.r0, m.c1, m.r1);
        ctx.fillStyle = lookAt(m.c0, m.r0)?.fill ?? wbk.styleOf(sheet.cells.get(keyOf(m.c0, m.r0)))?.fill ?? '#fff';
        ctx.fillRect(Math.round(b.x) + 1, Math.round(b.y) + 1, Math.round(b.x + b.w) - Math.round(b.x) - 1, Math.round(b.y + b.h) - Math.round(b.y) - 1);
      }

      // Data bars (conditional formatting): a bar from the left, as long as the value is high, under the text.
      if (sheet.cf.length) {
        for (let r = p.r0; r <= p.r1; r++) {
          if (sheet.hiddenRows.has(r)) continue;
          for (let c = p.c0; c <= p.c1; c++) {
            const bar = lookAt(c, r)?.bar;
            if (!bar || bar.len <= 0) continue;
            const x = X(c);
            const y = Y(r);
            const bw = (XR(c) - x - 4) * bar.len;
            ctx.fillStyle = bar.colour;
            ctx.globalAlpha = 0.75;
            ctx.fillRect(x + 2, y + 2, bw, YB(r) - y - 4);
            ctx.globalAlpha = 1;
          }
        }
      }

      // Cell borders (inside a merged block only its outside edges show).
      for (let r = p.r0; r <= p.r1; r++) {
        if (sheet.hiddenRows.has(r)) continue;
        for (let c = p.c0; c <= p.c1; c++) {
          const style = wbk.styleOf(sheet.cells.get(keyOf(c, r)));
          if (!style || !(style.bt || style.bb || style.bl || style.br)) continue;
          const m = blocks.length ? merged(c, r) : null;
          const x = Math.round(X(c)) + 0.5;
          const y = Math.round(Y(r)) + 0.5;
          const x2 = Math.round(XR(c)) + 0.5;
          const y2 = Math.round(YB(r)) + 0.5;
          const colour = style.bc ?? '#000';
          if (!m || r === m.r0) side(style.bt, x, y, x2, y, colour);
          if (!m || r === m.r1) side(style.bb, x, y2, x2, y2, colour);
          if (!m || c === m.c0) side(style.bl, x, y, x, y2, colour);
          if (!m || c === m.c1) side(style.br, x2, y, x2, y2, colour);
        }
      }

      // Text.
      for (let r = p.r0; r <= p.r1; r++) {
        if (sheet.hiddenRows.has(r)) continue;
        for (let c = p.c0; c <= p.c1; c++) {
          if (sheet.hiddenCols.has(c) || (blocks.length && merged(c, r))) continue;
          drawText(c, r, { x: X(c), y: Y(r), w: XR(c) - X(c), h: YB(r) - Y(r) }, p, false);
        }
      }
      // A merged block's text, centred over the whole block, even when its top-left cell is scrolled out of view.
      for (const m of blocks) drawText(m.c0, m.r0, rect(m.c0, m.r0, m.c1, m.r1), p, true);

      // The filter's buttons on its header row: an arrow, or a funnel on a column that is filtered (shape, not colour).
      if (filter && filter.range.r0 >= p.r0 && filter.range.r0 <= p.r1 && !sheet.hiddenRows.has(filter.range.r0)) {
        for (let c = Math.max(filter.range.c0, p.c0); c <= Math.min(filter.range.c1, p.c1); c++) {
          if (sheet.hiddenCols.has(c)) continue;
          const b = filterButton(c);
          ctx.fillStyle = '#fff';
          ctx.fillRect(b.x, b.y, b.w, b.h);
          ctx.strokeStyle = '#8a8a8a';
          ctx.lineWidth = 1;
          ctx.strokeRect(Math.round(b.x) + 0.5, Math.round(b.y) + 0.5, Math.round(b.w) - 1, Math.round(b.h) - 1);
          ctx.fillStyle = filter.cols.has(c) ? FILTERED : '#444';
          const cx = b.x + b.w / 2;
          const cy = b.y + b.h / 2;
          const u = z;
          ctx.beginPath();
          if (filter.cols.has(c)) {
            ctx.moveTo(cx - 5 * u, cy - 4 * u); ctx.lineTo(cx + 5 * u, cy - 4 * u); ctx.lineTo(cx + 1 * u, cy);
            ctx.lineTo(cx + 1 * u, cy + 5 * u); ctx.lineTo(cx - 1 * u, cy + 4 * u); ctx.lineTo(cx - 1 * u, cy);
          } else {
            ctx.moveTo(cx - 4 * u, cy - 2 * u); ctx.lineTo(cx + 4 * u, cy - 2 * u); ctx.lineTo(cx, cy + 3 * u);
          }
          ctx.closePath();
          ctx.fill();
        }
      }
      ctx.restore();
    }

    // Page breaks (Page Layout): a dashed line before the first column and row of each printed page.
    if (grid.breaks) {
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = '#5a5a5a';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const c of grid.breaks.cols) {
        const x = Math.round(X(c)) + 0.5;
        if (x > HEAD_W * z && x < w) { ctx.moveTo(x, HEAD_H * z); ctx.lineTo(x, vh); }
      }
      for (const r of grid.breaks.rows) {
        const y = Math.round(Y(r)) + 0.5;
        if (y > HEAD_H * z && y < vh) { ctx.moveTo(HEAD_W * z, y); ctx.lineTo(w, y); }
      }
      ctx.stroke();
      ctx.restore();
    }

    // Lines along the frozen edges.
    ctx.strokeStyle = FREEZE_EDGE;
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (fc > 0) { ctx.moveTo(Math.round(fx) + 0.5, 0); ctx.lineTo(Math.round(fx) + 0.5, vh); }
    if (fr > 0) { ctx.moveTo(0, Math.round(fy) + 0.5); ctx.lineTo(w, Math.round(fy) + 0.5); }
    ctx.stroke();

    // Over the cells, in each pane: the list outline, the selection, the fill-handle drag and the copy marquee.
    const spill = wbk.spillArea(sheetIndex, state.cursor.col, state.cursor.row);
    for (const p of panes) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(p.x, p.y, p.x2 - p.x, p.y2 - p.y);
      ctx.clip();
      if (spill) {
        const sb = rect(spill.c0, spill.r0, spill.c1, spill.r1);
        ctx.strokeStyle = SPILL_EDGE;
        ctx.lineWidth = 1;
        ctx.strokeRect(sb.x + 0.5, sb.y + 0.5, sb.w - 1, sb.h - 1);
      }
      const box = rect(s.c0, s.r0, s.c1, s.r1);
      const a = cellRect(state.cursor.col, state.cursor.row);
      const many = box.w > a.w + 0.5 || box.h > a.h + 0.5;
      if (many) {
        ctx.fillStyle = 'rgba(30, 122, 69, 0.12)';
        ctx.fillRect(box.x, box.y, box.w, box.h);
        ctx.fillStyle = lookAt(state.cursor.col, state.cursor.row)?.fill ?? wbk.styleOf(sheet.cells.get(keyOf(state.cursor.col, state.cursor.row)))?.fill ?? '#fff';
        ctx.fillRect(a.x + 1, a.y + 1, a.w - 2, a.h - 2);
        // The active cell is drawn again on its own fill, as it looks anywhere else (its alignment, font and colour).
        ctx.save();
        ctx.beginPath();
        ctx.rect(a.x, a.y, a.w, a.h);
        ctx.clip();
        const block = merged(state.cursor.col, state.cursor.row);
        drawText(state.cursor.col, state.cursor.row, a, { ...p, c1: state.cursor.col }, !!block);
        ctx.restore();
      }
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 2;
      ctx.strokeRect(box.x + 1, box.y + 1, box.w - 2, box.h - 2);
      ctx.fillStyle = ACCENT;
      ctx.fillRect(box.x + box.w - 4, box.y + box.h - 4, 7, 7);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1;
      ctx.strokeRect(box.x + box.w - 3.5, box.y + box.h - 3.5, 6, 6);
      if (state.fillTo) {
        const f = rect(state.fillTo.c0, state.fillTo.r0, state.fillTo.c1, state.fillTo.r1);
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1;
        ctx.strokeRect(f.x + 0.5, f.y + 0.5, f.w - 1, f.h - 1);
        ctx.setLineDash([]);
      }
      if (state.clip && state.clip.sheet === sheetIndex) {
        const cb = rect(state.clip.range.c0, state.clip.range.r0, state.clip.range.c1, state.clip.range.r1);
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = ACCENT;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(cb.x + 0.5, cb.y + 0.5, cb.w - 1, cb.h - 1);
        ctx.setLineDash([]);
      }
      ctx.restore();
    }

    // Headers (drawn last so scrolled cells never show through). A hidden row or column shows as a double line.
    ctx.font = `${12 * z}px "Segoe UI", Arial, Helvetica, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = HEAD_BG;
    ctx.fillRect(0, 0, w, HEAD_H * z);
    ctx.fillRect(0, 0, HEAD_W * z, vh);
    for (const [c0, c1, x0, x1] of colParts) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, 0, x1 - x0, HEAD_H * z);
      ctx.clip();
      for (let c = c0; c <= c1; c++) {
        if (sheet.hiddenCols.has(c)) continue;
        const x = X(c);
        const cw = XR(c) - x;
        const inSel = c >= s.c0 && c <= s.c1;
        if (inSel) {
          ctx.fillStyle = HEAD_SEL;
          ctx.fillRect(x, 0, cw, HEAD_H * z);
        }
        ctx.fillStyle = inSel ? ACCENT : '#333';
        ctx.textAlign = 'center';
        ctx.fillText(colName(c), x + cw / 2, HEAD_H * z / 2 + 1);
        ctx.strokeStyle = '#c6c6c6';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(x + cw) + 0.5, 0);
        ctx.lineTo(Math.round(x + cw) + 0.5, HEAD_H * z);
        ctx.stroke();
        if (c > 0 && sheet.hiddenCols.has(c - 1)) {
          ctx.strokeStyle = '#555';
          ctx.beginPath();
          ctx.moveTo(Math.round(x) - 0.5, 0); ctx.lineTo(Math.round(x) - 0.5, HEAD_H * z);
          ctx.moveTo(Math.round(x) + 1.5, 0); ctx.lineTo(Math.round(x) + 1.5, HEAD_H * z);
          ctx.stroke();
        }
      }
      ctx.restore();
    }
    for (const [r0, r1, y0, y1] of rowParts) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, y0, HEAD_W * z, y1 - y0);
      ctx.clip();
      for (let r = r0; r <= r1; r++) {
        if (sheet.hiddenRows.has(r)) continue;
        const y = Y(r);
        const rh = YB(r) - y;
        const inSel = r >= s.r0 && r <= s.r1;
        if (inSel) {
          ctx.fillStyle = HEAD_SEL;
          ctx.fillRect(0, y, HEAD_W * z, rh);
        }
        // Row numbers of rows a filter keeps in view are blue, as in Excel (the hidden ones are what tell).
        ctx.fillStyle = inSel ? ACCENT : filter && r > filter.range.r0 && r <= filter.range.r1 && filter.cols.size ? FILTERED : '#333';
        ctx.textAlign = 'center';
        ctx.fillText(String(r + 1), HEAD_W * z / 2, y + rh / 2 + 1);
        ctx.strokeStyle = '#c6c6c6';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, Math.round(y + rh) + 0.5);
        ctx.lineTo(HEAD_W * z, Math.round(y + rh) + 0.5);
        ctx.stroke();
        if (r > 0 && sheet.hiddenRows.has(r - 1)) {
          ctx.strokeStyle = '#555';
          ctx.beginPath();
          ctx.moveTo(0, Math.round(y) - 0.5); ctx.lineTo(HEAD_W * z, Math.round(y) - 0.5);
          ctx.moveTo(0, Math.round(y) + 1.5); ctx.lineTo(HEAD_W * z, Math.round(y) + 1.5);
          ctx.stroke();
        }
      }
      ctx.restore();
    }
    ctx.fillStyle = '#e4e4e4';
    ctx.fillRect(0, 0, HEAD_W * z, HEAD_H * z);
    ctx.strokeStyle = '#b5b5b5';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, w - 1, HEAD_H * z - 1);
    ctx.textAlign = 'left';
    // The active cell's drop-down list button (data validation), just right of the cell, as Excel draws it.
    const lb = listButton();
    if (lb && lb.x < w && lb.y < vh) {
      ctx.fillStyle = '#f3f3f3';
      ctx.fillRect(lb.x, lb.y, lb.w, lb.h);
      ctx.strokeStyle = '#8a8a8a';
      ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(lb.x) + 0.5, Math.round(lb.y) + 0.5, Math.round(lb.w) - 1, Math.round(lb.h) - 1);
      ctx.fillStyle = '#333';
      const cx = lb.x + lb.w / 2;
      const cy = lb.y + lb.h / 2;
      ctx.beginPath();
      ctx.moveTo(cx - 4 * z, cy - 2 * z); ctx.lineTo(cx + 4 * z, cy - 2 * z); ctx.lineTo(cx, cy + 3 * z);
      ctx.closePath();
      ctx.fill();
    }
    placePrompt();
    if (state.editing) placeEditor();
    grid.onPaint();
  }

  /** The active cell's validation rule, when it has a list with a drop-down button. */
  function activeList(): Validation | null {
    const v = validationAt(grid.wb, grid.wb.active, state.cursor.col, state.cursor.row);
    return v && v.type === 'list' && v.dropdown ? v : null;
  }

  /** Where the drop-down list button of the active cell is drawn (scaled pixels), or null when it has none. */
  function listButton(): { x: number; y: number; w: number; h: number } | null {
    if (!activeList()) return null;
    const b = cellRect(state.cursor.col, state.cursor.row);
    const size = Math.min(18 * state.zoom, b.h);
    return { x: b.x + b.w + 1, y: b.y + b.h - size, w: size, h: size };
  }

  /** The input message of the active cell's validation rule, in a box beside the cell while it is selected. */
  function placePrompt(): void {
    const v = validationAt(grid.wb, grid.wb.active, state.cursor.col, state.cursor.row);
    const p = v?.prompt;
    if (!p || !p.show || (!p.title && !p.text) || listBox) {
      prompt.hidden = true;
      return;
    }
    const key = `${state.cursor.col}:${state.cursor.row}:${p.title}:${p.text}`;
    if (prompt.dataset.for !== key) {
      prompt.dataset.for = key;
      prompt.replaceChildren(...(p.title ? [h('strong', {}, p.title)] : []), ...(p.text ? [h('span', {}, p.text)] : []));
    }
    const b = cellRect(state.cursor.col, state.cursor.row);
    prompt.hidden = false;
    css(prompt, { left: Math.max(0, b.x + Math.min(b.w, 40)), top: b.y + b.h + 4 });
  }

  /** Where a filter header cell's ▾ button is (scaled pixels). */
  function filterButton(col: number): { x: number; y: number; w: number; h: number } {
    const f = grid.wb.sheets[grid.wb.active].filter!;
    const z = state.zoom;
    const b = rect(col, f.range.r0, col, f.range.r0);
    const size = Math.min(16 * z, b.h - 2, b.w - 2);
    return { x: b.x + b.w - size - 1, y: b.y + b.h - size - 1, w: size, h: size };
  }

  // ---- Editing ---------------------------------------------------------------------------------------------------

  function placeEditor(): void {
    const b = cellRect(state.cursor.col, state.cursor.row);
    const wide = Math.max(b.w, 160 * state.zoom);
    // Taller for every line typed or pasted, as Excel's in-cell editor grows.
    const lines = Math.min(12, cellInput.value.split('\n').length);
    const tall = Math.max(b.h, (lines * LINE_H + 6) * state.zoom);
    css(cellInput, { left: b.x, top: b.y, width: wide, height: tall, display: 'block', 'font-size': `${13 * state.zoom}px`, 'line-height': `${LINE_H * state.zoom}px` });
    sizeBar();
  }

  /** The formula bar shows up to four lines of a cell that has several. */
  function sizeBar(): void {
    const lines = Math.min(4, formulaInput.value.split('\n').length);
    css(formulaInput, { height: lines * LINE_H + 8 });
  }

  /** Alt+Enter: a new line inside the cell (Enter alone puts the text in the cell). */
  function newLine(input: HTMLTextAreaElement): void {
    if (!state.editing) beginEdit(null, input === formulaInput ? 'bar' : 'cell');
    input.setRangeText('\n', input.selectionStart, input.selectionEnd, 'end');
    (input === cellInput ? formulaInput : cellInput).value = input.value;
    state.pointAt = null;
    placeEditor();
  }

  function beginEdit(initial: string | null, from: 'cell' | 'bar' = 'cell'): void {
    if (state.editing) return;
    state.editing = true;
    formulaInput.placeholder = '';
    const text = initial ?? grid.wb.editText(grid.wb.active, state.cursor.col, state.cursor.row);
    cellInput.value = text;
    formulaInput.value = text;
    placeEditor();
    grid.onEdit(true);
    if (from === 'cell') {
      cellInput.focus();
      if (initial === null) cellInput.setSelectionRange(text.length, text.length);
    }
  }

  function endEdit(): void {
    state.editing = false;
    state.pointAt = null;
    css(cellInput, { display: 'none' });
    grid.onEdit(false);
    changed();
  }

  /** Puts the typed text in the cell. Returns false (and says why) if it is a formula that cannot be read. */
  function commit(): boolean {
    if (!state.editing) return true;
    const text = cellInput.value;
    if (!state.allowOnce && !allowed(text)) return false;
    state.allowOnce = false;
    try {
      grid.wb.setInput(grid.wb.active, state.cursor.col, state.cursor.row, text);
    } catch (error) {
      if (error instanceof SyntaxProblem) {
        void shell.dialogs.alert('There is a problem with this formula', error.message, 'Fix it and press Enter again, or press Esc to cancel.').then(() => (state.editing ? (document.activeElement === formulaInput ? formulaInput : cellInput).focus() : undefined));
        return false;
      }
      throw error;
    }
    grid.widen({ c0: state.cursor.col, r0: state.cursor.row, c1: state.cursor.col, r1: state.cursor.row });
    fitRows();
    endEdit();
    grid.onChange();
    return true;
  }

  /**
   * Checks typed text against the cell's validation rule. False (and the rule's message is shown) when it breaks it:
   * Stop offers Retry or Cancel; Warning asks whether to keep it; Information says so and keeps it on OK.
   */
  function allowed(text: string): boolean {
    const s = grid.wb.active;
    const { col, row } = state.cursor;
    const v = validationAt(grid.wb, s, col, row);
    // Clearing a cell is not checked (as in Excel), nor is anything when the rule shows no error.
    if (!v || v.type === 'any' || !v.error.show || text === '') return true;
    let ok = true;
    try {
      ok = grid.wb.withInput(s, col, row, text, () => passes(grid.wb, s, v, grid.wb.value(s, col, row), col, row));
    } catch {
      // A formula that does not read: putting it in the cell says what is wrong with it.
      return true;
    }
    if (ok) return true;
    void refuse(v);
    return false;
  }

  async function refuse(v: Validation): Promise<void> {
    const title = v.error.title || 'That value is not allowed here';
    const why = v.error.text || `This cell has a rule: it takes ${describeValidation(v)}.`;
    const back = () => {
      if (!state.editing) return;
      cellInput.focus();
      cellInput.select();
    };
    if (v.error.style === 'stop') {
      const again = await shell.dialogs.ask<boolean>({ title, text: why, buttons: [{ label: 'Retry', value: true, primary: true }, { label: 'Cancel', value: false }], cancel: false });
      if (again) back();
      else cancelEdit();
      return;
    }
    if (v.error.style === 'warning') {
      const answer = await shell.dialogs.ask<'yes' | 'no' | null>({
        title, text: `${why} Keep it anyway?`,
        buttons: [{ label: 'Yes, keep it', value: 'yes' }, { label: 'No, change it', value: 'no', primary: true }, { label: 'Cancel', value: null }],
        cancel: null,
      });
      if (answer === 'yes') {
        state.allowOnce = true;
        if (commit()) scroller.focus({ preventScroll: true });
      } else if (answer === 'no') back();
      else cancelEdit();
      return;
    }
    const keep = await shell.dialogs.ask<boolean>({ title, text: why, buttons: [{ label: 'OK', value: true, primary: true }, { label: 'Cancel', value: false }], cancel: false });
    if (keep) {
      state.allowOnce = true;
      if (commit()) scroller.focus({ preventScroll: true });
    } else cancelEdit();
  }

  /** The drop-down list of the active cell's validation rule: pick a value to put in the cell. */
  function openList(): void {
    closeList();
    const v = activeList();
    if (!v || !commit()) return;
    const s = grid.wb.active;
    const { col, row } = state.cursor;
    const items = listItems(grid.wb, s, v, col, row);
    const box = h('div', { class: 'dv-list', role: 'listbox', 'aria-label': 'Choose a value' });
    const current = grid.wb.display(s, col, row).toLowerCase();
    const done = new AbortController();
    const close = () => {
      done.abort();
      closeList();
      scroller.focus({ preventScroll: true });
      redraw();
    };
    const pick = (item: string) => {
      try {
        // A value from the list goes in as text where it would otherwise read as something else (a formula).
        grid.wb.setInput(s, col, row, /^[='"]/.test(item) ? `'${item}` : item);
        afterEdit();
      } catch (error) {
        void report(error);
      }
      close();
    };
    const buttons = items.map(item => {
      const b = h('button', { type: 'button', class: 'dv-item', role: 'option', 'aria-selected': String(item.toLowerCase() === current) }, item);
      on(b, 'click', () => pick(item), done.signal);
      return b;
    });
    if (!buttons.length) box.append(h('p', { class: 'dv-empty' }, 'The list is empty.'));
    box.append(...buttons);
    on(box, 'keydown', (event: KeyboardEvent) => {
      const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        buttons[Math.max(0, Math.min(buttons.length - 1, i + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
      } else if (event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault();
        close();
      }
      event.stopPropagation();
    }, done.signal);
    setTimeout(() => {
      if (done.signal.aborted) return;
      on(document, 'pointerdown', (event: PointerEvent) => {
        if (event.target instanceof Node && !box.contains(event.target)) close();
      }, done.signal);
    }, 0);
    signal.addEventListener('abort', () => done.abort());
    const b = cellRect(col, row);
    root.append(box);
    css(box, { left: Math.max(0, Math.min(b.x, root.clientWidth - 200)), top: b.y + b.h + 1, 'min-width': Math.max(b.w, 120) });
    listBox = box;
    prompt.hidden = true;
    (buttons.find(x => x.getAttribute('aria-selected') === 'true') ?? buttons[0])?.focus();
  }

  function closeList(): void {
    listBox?.remove();
    listBox = null;
  }

  function cancelEdit(): void {
    if (!state.editing) return;
    endEdit();
    scroller.focus({ preventScroll: true });
  }

  const syncFrom = (src: HTMLTextAreaElement, dst: HTMLTextAreaElement) => () => {
    dst.value = src.value;
    state.pointAt = null;
    if (!state.editing) {
      // Typing in the formula bar starts an edit of the current cell.
      state.editing = true;
      grid.onEdit(true);
    }
    placeEditor();
  };
  on(cellInput, 'input', syncFrom(cellInput, formulaInput), signal);
  on(formulaInput, 'input', syncFrom(formulaInput, cellInput), signal);

  const editKeys = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      newLine(event.target as HTMLTextAreaElement);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (commit()) {
        const to = step(0, event.shiftKey ? -1 : 1, { col: state.tabCol ?? state.cursor.col, row: state.cursor.row });
        moveCursor(to.col, to.row, false);
        state.tabCol = null;
        scroller.focus({ preventScroll: true });
      }
    } else if (event.key === 'Tab') {
      event.preventDefault();
      const began = state.tabCol ?? state.cursor.col;
      if (commit()) {
        state.tabCol = began;
        const to = step(event.shiftKey ? -1 : 1, 0);
        moveCursor(to.col, to.row, false);
        scroller.focus({ preventScroll: true });
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancelEdit();
    }
  };
  on(cellInput, 'keydown', editKeys, signal);
  on(formulaInput, 'keydown', editKeys, signal);
  on(formulaInput, 'focus', () => {
    if (!state.editing) beginEdit(null, 'bar');
  }, signal);

  on(nameBox, 'keydown', (event: KeyboardEvent) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const m = /^\$?([A-Za-z]{1,3})\$?(\d+)(?::\$?([A-Za-z]{1,3})\$?(\d+))?$/.exec(nameBox.value.trim());
    if (!m) {
      void shell.dialogs.alert('That is not a cell address', 'Type something like B7 or A1:C10.');
      return;
    }
    const idx = (s: string) => [...s.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
    const c0 = idx(m[1]);
    const r0 = parseInt(m[2], 10) - 1;
    const c1 = m[3] ? idx(m[3]) : c0;
    const r1 = m[4] ? parseInt(m[4], 10) - 1 : r0;
    if (c0 >= MAX_COLS || c1 >= MAX_COLS || r0 >= MAX_ROWS || r1 >= MAX_ROWS || r0 < 0 || r1 < 0) {
      void shell.dialogs.alert('That cell is off the sheet', `Sheets have ${MAX_ROWS.toLocaleString()} rows and columns up to ${colName(MAX_COLS - 1)}.`);
      return;
    }
    select({ c0: Math.min(c0, c1), r0: Math.min(r0, r1), c1: Math.max(c0, c1), r1: Math.max(r0, r1) }, { col: Math.min(c0, c1), row: Math.min(r0, r1) });
    reveal(Math.min(c0, c1), Math.min(r0, r1));
    scroller.focus({ preventScroll: true });
  }, signal);
  on(nameBox, 'focus', () => nameBox.select(), signal);

  /** While typing a formula, a click on a cell adds its address (after "=", an operator, "(" or ","). */
  function pointing(): boolean {
    if (!state.editing) return false;
    const input = document.activeElement === formulaInput ? formulaInput : cellInput;
    const v = input.value;
    if (!v.startsWith('=')) return false;
    const caret = input.selectionStart ?? v.length;
    if (state.pointAt) return true;
    return /[=+\-*/^&<>(,;:]$/.test(v.slice(0, caret));
  }

  function insertRef(text: string): void {
    const input = document.activeElement === formulaInput ? formulaInput : cellInput;
    const v = input.value;
    const caret = input.selectionStart ?? v.length;
    const start = state.pointAt ? state.pointAt.start : caret;
    const end = state.pointAt ? state.pointAt.end : caret;
    input.value = v.slice(0, start) + text + v.slice(end);
    state.pointAt = { start, end: start + text.length };
    const other = input === cellInput ? formulaInput : cellInput;
    other.value = input.value;
    input.setSelectionRange(start + text.length, start + text.length);
  }

  // ---- Mouse -----------------------------------------------------------------------------------------------------

  function posOf(event: MouseEvent): { x: number; y: number } {
    const b = scroller.getBoundingClientRect();
    return { x: event.clientX - b.left, y: event.clientY - b.top };
  }

  function onScrollbar(event: MouseEvent): boolean {
    const b = scroller.getBoundingClientRect();
    return event.clientX - b.left > scroller.clientWidth || event.clientY - b.top > scroller.clientHeight;
  }

  /** The header edge the pointer is on, for resizing: which column or row and its current size. */
  function edgeAt(x: number, y: number): { axis: 'col' | 'row'; index: number } | null {
    const z = state.zoom;
    if (y < HEAD_H * z && x > HEAD_W * z) {
      const p = hit(x, y);
      const b = rect(p.col, 0, p.col, 0);
      if (Math.abs(x - (b.x + b.w)) <= EDGE) return { axis: 'col', index: p.col };
      if (p.col > 0 && Math.abs(x - b.x) <= EDGE) return { axis: 'col', index: p.col - 1 };
    } else if (x < HEAD_W * z && y > HEAD_H * z) {
      const p = hit(x, y);
      const b = rect(0, p.row, 0, p.row);
      if (Math.abs(y - (b.y + b.h)) <= EDGE) return { axis: 'row', index: p.row };
      if (p.row > 0 && Math.abs(y - b.y) <= EDGE) return { axis: 'row', index: p.row - 1 };
    }
    return null;
  }

  function onFillHandle(x: number, y: number): boolean {
    const s = sel();
    const b = rect(s.c1, s.r1, s.c1, s.r1);
    return Math.abs(x - (b.x + b.w)) <= 6 && Math.abs(y - (b.y + b.h)) <= 6;
  }

  on(scroller, 'pointermove', (event: PointerEvent) => {
    if (event.buttons || onScrollbar(event)) return;
    const { x, y } = posOf(event);
    const edge = edgeAt(x, y);
    scroller.style.cursor = edge ? (edge.axis === 'col' ? 'col-resize' : 'row-resize') : onFillHandle(x, y) ? 'crosshair' : 'cell';
  }, signal);

  on(scroller, 'pointerdown', (event: PointerEvent) => {
    if (event.button !== 0 || onScrollbar(event)) return;
    const { x, y } = posOf(event);
    const p = hit(x, y);
    // Cells clicked while typing a formula are pointed at, not selected.
    if (pointing() && p.where === 'cell') {
      event.preventDefault();
      const start = { col: p.col, row: p.row };
      insertRef(addressOf(start.col, start.row));
      scroller.setPointerCapture(event.pointerId);
      const abort = new AbortController();
      on(scroller, 'pointermove', (e: PointerEvent) => {
        const q = hit(posOf(e).x, posOf(e).y);
        insertRef(q.col === start.col && q.row === start.row ? addressOf(start.col, start.row) : `${addressOf(Math.min(start.col, q.col), Math.min(start.row, q.row))}:${addressOf(Math.max(start.col, q.col), Math.max(start.row, q.row))}`);
      }, abort.signal);
      const done = () => abort.abort();
      on(scroller, 'pointerup', done, abort.signal);
      on(scroller, 'pointercancel', done, abort.signal);
      return;
    }
    if (!commit()) return;
    state.tabCol = null;
    scroller.focus({ preventScroll: true });
    const edge = edgeAt(x, y);
    if (edge) {
      event.preventDefault();
      beginResize(event, edge);
      return;
    }
    if (p.where === 'cell' && onFillHandle(x, y)) {
      event.preventDefault();
      beginFill(event);
      return;
    }
    const lb = listButton();
    if (lb && x >= lb.x && x <= lb.x + lb.w && y >= lb.y && y <= lb.y + lb.h) {
      event.preventDefault();
      openList();
      return;
    }
    const f = grid.wb.sheets[grid.wb.active].filter;
    if (p.where === 'cell' && f && p.row === f.range.r0 && p.col >= f.range.c0 && p.col <= f.range.c1) {
      const b = filterButton(p.col);
      if (x >= b.x - 1 && x <= b.x + b.w + 1 && y >= b.y - 1 && y <= b.y + b.h + 1) {
        event.preventDefault();
        select({ c0: p.col, r0: p.row, c1: p.col, r1: p.row });
        const box = scroller.getBoundingClientRect();
        grid.onFilterButton(p.col, box.left + b.x, box.top + b.y + b.h);
        return;
      }
    }
    scroller.setPointerCapture(event.pointerId);
    if (p.where === 'corner') {
      select({ c0: 0, r0: 0, c1: MAX_COLS - 1, r1: MAX_ROWS - 1 }, { col: 0, row: 0 });
      return;
    }
    const extend = event.shiftKey;
    // A click in a merged block selects the block (its top-left cell is the active one).
    const startAnchor = extend ? { ...state.anchor } : p.where === 'cell' ? topLeft(p.col, p.row) : { col: p.col, row: p.row };
    const mk = (q: { col: number; row: number }) => {
      if (p.where === 'colhead') return { c0: Math.min(startAnchor.col, q.col), c1: Math.max(startAnchor.col, q.col), r0: 0, r1: MAX_ROWS - 1 };
      if (p.where === 'rowhead') return { r0: Math.min(startAnchor.row, q.row), r1: Math.max(startAnchor.row, q.row), c0: 0, c1: MAX_COLS - 1 };
      return { c0: Math.min(startAnchor.col, q.col), c1: Math.max(startAnchor.col, q.col), r0: Math.min(startAnchor.row, q.row), r1: Math.max(startAnchor.row, q.row) };
    };
    const apply = (q: { col: number; row: number }) => {
      const r = mk(q);
      state.anchor = p.where === 'colhead' ? { col: startAnchor.col, row: 0 } : p.where === 'rowhead' ? { col: 0, row: startAnchor.row } : startAnchor;
      state.cursor = p.where === 'colhead' ? { col: q.col, row: 0 } : p.where === 'rowhead' ? { col: 0, row: q.row } : q;
      void r;
      changed();
    };
    apply(p.where === 'cell' && !extend ? topLeft(p.col, p.row) : { col: p.col, row: p.row });
    const abort = new AbortController();
    on(scroller, 'pointermove', (e: PointerEvent) => {
      const q = posOf(e);
      const cell = hit(Math.max(HEAD_W * state.zoom + 1, q.x), Math.max(HEAD_H * state.zoom + 1, q.y));
      apply({ col: cell.col, row: cell.row });
      // Drag past an edge to scroll.
      const b = scroller.getBoundingClientRect();
      if (e.clientY > b.bottom - 20) scroller.scrollTop += 20;
      else if (e.clientY < b.top + HEAD_H * state.zoom + 10) scroller.scrollTop -= 20;
      if (e.clientX > b.right - 20) scroller.scrollLeft += 20;
      else if (e.clientX < b.left + HEAD_W * state.zoom + 10) scroller.scrollLeft -= 20;
    }, abort.signal);
    const end = () => abort.abort();
    on(scroller, 'pointerup', end, abort.signal);
    on(scroller, 'pointercancel', end, abort.signal);
  }, signal);

  on(scroller, 'dblclick', (event: MouseEvent) => {
    if (onScrollbar(event)) return;
    const { x, y } = posOf(event);
    const edge = edgeAt(x, y);
    if (edge) {
      autoFit(edge.axis, edge.index);
      return;
    }
    if (hit(x, y).where === 'cell') beginEdit(null);
  }, signal);

  function beginResize(event: PointerEvent, edge: { axis: 'col' | 'row'; index: number }): void {
    scroller.setPointerCapture(event.pointerId);
    const sheet = grid.wb.sheets[grid.wb.active];
    const start = edge.axis === 'col' ? event.clientX : event.clientY;
    const original = edge.axis === 'col' ? (sheet.colW.get(edge.index) ?? COL_W) : (sheet.rowH.get(edge.index) ?? ROW_H);
    const abort = new AbortController();
    on(scroller, 'pointermove', (e: PointerEvent) => {
      const delta = ((edge.axis === 'col' ? e.clientX : e.clientY) - start) / state.zoom;
      grid.wb.setSize(grid.wb.active, edge.axis, edge.index, original + delta);
      redraw();
    }, abort.signal);
    const end = () => {
      abort.abort();
      // A wider or narrower column changes how many lines its wrapped text needs.
      if (edge.axis === 'col') fitRows();
      grid.onChange();
    };
    on(scroller, 'pointerup', end, abort.signal);
    on(scroller, 'pointercancel', end, abort.signal);
  }

  /** Widens columns that still have their standard width when a number would not fit ("#####"), as a spreadsheet does. */
  function widen(r: Range): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const sheet = grid.wb.sheets[grid.wb.active];
    let any = false;
    for (let c = r.c0; c <= r.c1; c++) {
      if (sheet.colW.has(c)) continue;
      let need = 0;
      for (let row = r.r0; row <= Math.min(r.r1, r.r0 + 400); row++) {
        const cell = sheet.cells.get(keyOf(c, row));
        if (!cell || typeof grid.wb.value(grid.wb.active, c, row) !== 'number') continue;
        const style = grid.wb.styleOf(cell);
        ctx.font = `${style?.i ? 'italic ' : ''}${style?.b ? 'bold ' : ''}13px "Segoe UI", Arial, Helvetica, sans-serif`;
        need = Math.max(need, ctx.measureText(grid.wb.display(grid.wb.active, c, row)).width + 10);
      }
      if (need > COL_W) {
        grid.wb.setSize(grid.wb.active, 'col', c, Math.min(need, 300));
        any = true;
      }
    }
    if (any) redraw();
  }
  grid.widen = widen;

  /**
   * Sizes every row that holds wrapped text to fit it, and puts rows that no longer need it back to the standard height.
   * Rows sized by hand are left alone (Workbook.fitRow).
   */
  function fitRows(): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const s = grid.wb.active;
    const sheet = grid.wb.sheets[s];
    const need = new Map<number, number>();
    let measured = 0;
    for (const [k, cell] of sheet.cells) {
      const style = grid.wb.styleOf(cell);
      if (!style?.wrap || (cell.v === undefined && cell.f === undefined)) continue;
      if (++measured > MAX_FIT_CELLS) break;
      const col = colOfKey(k);
      const row = rowOfKey(k);
      const shown = grid.wb.display(s, col, row);
      if (!shown || typeof grid.wb.value(s, col, row) === 'number') continue;
      ctx.font = fontFor(style, 1);
      const lines = wrapLines(ctx, shown, (sheet.colW.get(col) ?? COL_W) - 6).length;
      need.set(row, Math.max(need.get(row) ?? 0, lines * LINE_H + 5));
    }
    for (const row of [...sheet.rowFit]) if (!need.has(row)) grid.wb.fitRow(s, row, null);
    for (const [row, height] of need) grid.wb.fitRow(s, row, height > ROW_H ? height : null);
    redraw();
  }

  function autoFit(axis: 'col' | 'row', index: number): void {
    if (axis === 'row') {
      // Double-clicking a row's edge: back to fitting its text (or the standard height).
      grid.wb.setSize(grid.wb.active, 'row', index, null);
      fitRows();
    } else {
      const ctx = canvas.getContext('2d')!;
      ctx.font = FONT;
      let widest = 40;
      for (const [k, cell] of grid.wb.sheets[grid.wb.active].cells) {
        if (k % MAX_COLS !== index || (cell.v === undefined && cell.f === undefined)) continue;
        widest = Math.max(widest, ctx.measureText(grid.wb.display(grid.wb.active, index, Math.floor(k / MAX_COLS))).width + 12);
      }
      grid.wb.setSize(grid.wb.active, 'col', index, Math.min(widest, 600));
    }
    redraw();
    grid.onChange();
  }

  function beginFill(event: PointerEvent): void {
    scroller.setPointerCapture(event.pointerId);
    const src = sel();
    const abort = new AbortController();
    on(scroller, 'pointermove', (e: PointerEvent) => {
      const q = posOf(e);
      const cell = hit(Math.max(HEAD_W * state.zoom + 1, q.x), Math.max(HEAD_H * state.zoom + 1, q.y));
      const dRow = cell.row > src.r1 ? cell.row - src.r1 : cell.row < src.r0 ? src.r0 - cell.row : 0;
      const dCol = cell.col > src.c1 ? cell.col - src.c1 : cell.col < src.c0 ? src.c0 - cell.col : 0;
      if (dRow === 0 && dCol === 0) state.fillTo = null;
      else if (dRow >= dCol) state.fillTo = { c0: src.c0, c1: src.c1, r0: cell.row < src.r0 ? cell.row : src.r0, r1: cell.row > src.r1 ? cell.row : src.r1 };
      else state.fillTo = { r0: src.r0, r1: src.r1, c0: cell.col < src.c0 ? cell.col : src.c0, c1: cell.col > src.c1 ? cell.col : src.c1 };
      redraw();
    }, abort.signal);
    const end = () => {
      abort.abort();
      const target = state.fillTo;
      state.fillTo = null;
      if (target) {
        try {
          grid.wb.fill(grid.wb.active, src, target);
          select(target, { col: src.c0, row: src.r0 });
          grid.onChange();
        } catch (error) {
          void report(error);
        }
      }
      redraw();
    };
    on(scroller, 'pointerup', end, abort.signal);
    on(scroller, 'pointercancel', () => {
      abort.abort();
      state.fillTo = null;
      redraw();
    }, abort.signal);
  }

  on(scroller, 'wheel', (event: WheelEvent) => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    setZoom(state.zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1));
  }, signal, { passive: false });
  on(scroller, 'scroll', () => {
    if (state.editing) placeEditor();
    redraw();
  }, signal);
  new ResizeObserver(() => redraw()).observe(scroller);

  function setZoom(z: number): void {
    const next = clamp(Math.round(z * 100) / 100, 0.5, 2);
    if (next === state.zoom) return;
    const cx = scroller.scrollLeft / state.zoom;
    const cy = scroller.scrollTop / state.zoom;
    state.zoom = next;
    state.geomVersion = -1;
    geometry();
    scroller.scrollLeft = cx * next;
    scroller.scrollTop = cy * next;
    grid.onSelect();
    redraw();
  }

  // ---- Keyboard --------------------------------------------------------------------------------------------------

  const jump = (col: number, row: number, dc: number, dr: number): { col: number; row: number } => {
    const s = grid.wb.active;
    const filled = (c: number, r: number) => grid.wb.value(s, c, r) !== null;
    const inside = (c: number, r: number) => c >= 0 && c < MAX_COLS && r >= 0 && r < MAX_ROWS;
    let c = col + dc;
    let r = row + dr;
    if (!inside(c, r)) return { col, row };
    if (filled(col, row) && filled(c, r)) {
      while (inside(c + dc, r + dr) && filled(c + dc, r + dr)) {
        c += dc;
        r += dr;
      }
      return { col: c, row: r };
    }
    while (inside(c, r) && !filled(c, r)) {
      if (!inside(c + dc, r + dr)) return { col: c, row: r };
      c += dc;
      r += dr;
    }
    return { col: c, row: r };
  };

  on(scroller, 'keydown', (event: KeyboardEvent) => {
    if (state.editing) return;
    const ctrl = event.ctrlKey || event.metaKey;
    const key = event.key;
    const { col, row } = state.cursor;
    const arrow: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const page = Math.max(1, Math.floor(scroller.clientHeight / (ROW_H * state.zoom)) - 1);
    let handled = true;
    const typing = key.length === 1 && !ctrl && !event.altKey;
    if (key === 'Tab') state.tabCol = state.tabCol ?? col;
    else if (key !== 'Enter' && !typing && key !== 'Shift' && key !== 'Control' && key !== 'Alt') state.tabCol = null;
    if (key === 'ArrowDown' && event.altKey && activeList()) {
      openList();
    } else if (arrow[key]) {
      const [dc, dr] = arrow[key];
      if (ctrl) {
        const to = jump(col, row, dc, dr);
        moveCursor(to.col, to.row, event.shiftKey);
      } else if (event.shiftKey) moveCursor(col + dc, row + dr, true);
      else {
        const to = step(dc, dr);
        moveCursor(to.col, to.row, false);
      }
    } else if (key === 'Tab') {
      const to = step(event.shiftKey ? -1 : 1, 0);
      moveCursor(to.col, to.row, false);
    } else if (key === 'Enter') {
      const to = step(0, event.shiftKey ? -1 : 1, { col: state.tabCol ?? col, row });
      moveCursor(to.col, to.row, false);
      state.tabCol = null;
    }
    else if (key === 'Home') moveCursor(ctrl ? 0 : 0, ctrl ? 0 : row, event.shiftKey);
    else if (key === 'End' && ctrl) {
      const b = grid.wb.usedBounds(grid.wb.active);
      moveCursor(Math.max(0, b.cols - 1), Math.max(0, b.rows - 1), event.shiftKey);
    } else if (key === 'PageDown') moveCursor(col, row + page, event.shiftKey);
    else if (key === 'PageUp') moveCursor(col, row - page, event.shiftKey);
    else if (key === 'F2') beginEdit(null);
    else if (key === 'Delete') deleteContents();
    else if (key === 'Backspace') beginEdit('');
    else if (ctrl && key.toLowerCase() === 'a') select({ c0: 0, r0: 0, c1: MAX_COLS - 1, r1: MAX_ROWS - 1 }, { col: 0, row: 0 });
    else if (ctrl && key.toLowerCase() === 'z') {
      grid.wb.undo();
      afterEdit();
    } else if (ctrl && key.toLowerCase() === 'y') {
      grid.wb.redo();
      afterEdit();
    } else if (ctrl && key.toLowerCase() === 'd') fillFromEdge('down');
    else if (ctrl && key.toLowerCase() === 'r') fillFromEdge('right');
    else if (event.altKey && key === '=') autoSum();
    else if (ctrl && key === ' ') select({ ...sel(), r0: 0, r1: MAX_ROWS - 1 }, { col: sel().c0, row: 0 });
    else if (event.shiftKey && key === ' ' && !ctrl) select({ ...sel(), c0: 0, c1: MAX_COLS - 1 }, { col: 0, row: sel().r0 });
    else if (key === 'Escape') {
      if (state.clip) {
        state.clip = null;
        redraw();
      }
    } else if (key.length === 1 && !ctrl && !event.altKey) {
      // Typing starts editing and replaces the cell; the character itself lands in the editor.
      beginEdit('');
      handled = false;
    } else handled = false;
    if (handled) event.preventDefault();
  }, signal);

  function afterEdit(): void {
    fitRows();
    state.geomVersion = -1;
    changed();
    grid.onChange();
  }

  function fillFromEdge(dir: 'down' | 'right'): void {
    const s = sel();
    try {
      if (dir === 'down' && s.r1 > s.r0) grid.wb.fill(grid.wb.active, { ...s, r1: s.r0 }, s);
      else if (dir === 'right' && s.c1 > s.c0) grid.wb.fill(grid.wb.active, { ...s, c1: s.c0 }, s);
      afterEdit();
    } catch (error) {
      void report(error);
    }
  }

  async function report(error: unknown): Promise<void> {
    if (error instanceof SyntaxProblem) await shell.dialogs.alert('That could not be done', error.message);
    else await shell.report('The spreadsheet could not do that', error);
  }

  // ---- Actions the toolbar and menus use -------------------------------------------------------------------------

  function deleteContents(): void {
    try {
      grid.wb.clearContents(grid.wb.active, sel());
      afterEdit();
    } catch (error) {
      void report(error);
    }
  }

  function shift(axis: 'row' | 'col', n: 1 | -1): void {
    const s = sel();
    const at = axis === 'row' ? s.r0 : s.c0;
    const count = axis === 'row' ? s.r1 - s.r0 + 1 : s.c1 - s.c0 + 1;
    try {
      grid.wb.shiftAxis(grid.wb.active, axis, at, n * count);
      state.clip = null;
      afterEdit();
    } catch (error) {
      void report(error);
    }
  }

  function hide(axis: 'row' | 'col', hidden: boolean): void {
    const s = sel();
    try {
      if (axis === 'row') grid.wb.setHidden(grid.wb.active, 'row', s.r0, s.r1, hidden);
      else grid.wb.setHidden(grid.wb.active, 'col', s.c0, s.c1, hidden);
      // The active cell leaves hidden rows and columns for the nearest one in view.
      const sheet = grid.wb.sheets[grid.wb.active];
      if (hidden && (sheet.hiddenRows.has(state.cursor.row) || sheet.hiddenCols.has(state.cursor.col))) {
        const to = axis === 'row' ? step(0, 1, { col: state.cursor.col, row: s.r1 }) : step(1, 0, { col: s.c1, row: state.cursor.row });
        const back = axis === 'row' ? step(0, -1, { col: state.cursor.col, row: s.r0 }) : step(-1, 0, { col: s.c0, row: state.cursor.row });
        const ok = (q: { col: number; row: number }) => !sheet.hiddenRows.has(q.row) && !sheet.hiddenCols.has(q.col);
        const dest = ok(to) ? to : back;
        state.anchor = { ...dest };
        state.cursor = { ...dest };
      }
      afterEdit();
    } catch (error) {
      void report(error);
    }
  }

  function autoSum(): void {
    const { col, row } = state.cursor;
    const s = grid.wb.active;
    const numeric = (c: number, r: number) => {
      const v = grid.wb.value(s, c, r);
      return typeof v === 'number';
    };
    let above = 0;
    while (row - above - 1 >= 0 && numeric(col, row - above - 1)) above++;
    let leftN = 0;
    while (col - leftN - 1 >= 0 && numeric(col - leftN - 1, row)) leftN++;
    const picked = sel();
    let formula: string;
    if (picked.r1 > picked.r0 || picked.c1 > picked.c0) {
      // A block is selected: put the totals in the row below (or column to the right). A whole row or column (or the
      // whole sheet) is cut to the cells in use, so the totals land beside the figures, not past the sheet's edge.
      const used = grid.wb.usedBounds(s);
      const many = { ...picked, r1: Math.min(picked.r1, Math.max(picked.r0, used.rows - 1)), c1: Math.min(picked.c1, Math.max(picked.c0, used.cols - 1)) };
      const tall = many.r1 - many.r0 >= many.c1 - many.c0;
      try {
        // One step: a single Undo takes every total back.
        grid.wb.batch(() => {
          if (tall) for (let c = many.c0; c <= many.c1; c++) grid.wb.setInput(s, c, many.r1 + 1, `=SUM(${addressOf(c, many.r0)}:${addressOf(c, many.r1)})`);
          else for (let r = many.r0; r <= many.r1; r++) grid.wb.setInput(s, many.c1 + 1, r, `=SUM(${addressOf(many.c0, r)}:${addressOf(many.c1, r)})`);
        });
        afterEdit();
      } catch (error) {
        void report(error);
      }
      return;
    }
    if (above > 0) formula = `=SUM(${addressOf(col, row - above)}:${addressOf(col, row - 1)})`;
    else if (leftN > 0) formula = `=SUM(${addressOf(col - leftN, row)}:${addressOf(col - 1, row)})`;
    else formula = '=SUM()';
    beginEdit(formula);
    if (formula === '=SUM()') cellInput.setSelectionRange(5, 5);
  }

  function tsv(r: Range): string {
    return grid.wb.exportText(grid.wb.active, r, '\t');
  }

  function copy(cut: boolean): void {
    const r = sel();
    state.clip = { sheet: grid.wb.active, range: r, cut, text: tsv(r) };
    redraw();
  }

  function paste(): void {
    // Toolbar Paste: works from the copy made inside this window.
    pasteText(state.clip?.text ?? null);
  }

  function pasteText(text: string | null): void {
    const target = { col: sel().c0, row: sel().r0 };
    try {
      const clip = state.clip;
      if (clip && (text === null || text === clip.text)) {
        const s = sel();
        const width = clip.range.c1 - clip.range.c0 + 1;
        const height = clip.range.r1 - clip.range.r0 + 1;
        // A selection larger than the copied block repeats it.
        const tilesX = Math.max(1, Math.floor((s.c1 - s.c0 + 1) / width));
        const tilesY = Math.max(1, Math.floor((s.r1 - s.r0 + 1) / height));
        if (tilesX * tilesY <= 1 || clip.cut) grid.wb.copyBlock(grid.wb.active, clip.range, target, { cut: clip.cut, fromSheet: clip.sheet });
        else grid.wb.batch(() => {
          for (let ty = 0; ty < tilesY; ty++) for (let tx = 0; tx < tilesX; tx++) grid.wb.copyBlock(grid.wb.active, clip.range, { col: target.col + tx * width, row: target.row + ty * height }, { fromSheet: clip.sheet });
        });
        if (clip.cut) state.clip = null;
        select({ c0: target.col, r0: target.row, c1: target.col + width * (clip.cut ? 1 : tilesX) - 1, r1: target.row + height * (clip.cut ? 1 : tilesY) - 1 }, target);
      } else if (text !== null && text !== '') {
        // Text from another program: a line per row, split into columns at tabs only (as Excel pastes it); a cell
        // copied with its line breaks comes in quotes and stays one cell.
        const body = text.replace(/\r?\n$/, '');
        const table = parseDelimited(body, '\t');
        const cols = table.reduce((most, r) => Math.max(most, r.length), 1);
        grid.wb.importText(grid.wb.active, target.col, target.row, body, '\t');
        select({ c0: target.col, r0: target.row, c1: Math.min(MAX_COLS - 1, target.col + cols - 1), r1: Math.min(MAX_ROWS - 1, target.row + Math.max(1, table.length) - 1) }, target);
      }
      afterEdit();
    } catch (error) {
      void report(error);
    }
  }

  on(scroller, 'copy', (event: ClipboardEvent) => {
    if (state.editing) return;
    event.preventDefault();
    copy(false);
    event.clipboardData?.setData('text/plain', state.clip?.text ?? '');
  }, signal);
  on(scroller, 'cut', (event: ClipboardEvent) => {
    if (state.editing) return;
    event.preventDefault();
    copy(true);
    event.clipboardData?.setData('text/plain', state.clip?.text ?? '');
  }, signal);
  on(scroller, 'paste', (event: ClipboardEvent) => {
    if (state.editing) return;
    event.preventDefault();
    pasteText(event.clipboardData?.getData('text/plain') ?? null);
  }, signal);

  // ---- Right-click menus -----------------------------------------------------------------------------------------

  bindContextMenu(scroller, signal, shell.menus, () => {
    const s = sel();
    const menu: MenuItem[] = [
      { label: 'Cut', hint: 'Ctrl+X', action: () => copy(true) },
      { label: 'Copy', hint: 'Ctrl+C', action: () => copy(false) },
      { label: 'Paste', hint: 'Ctrl+V', disabled: !state.clip, action: () => paste() },
      { separator: true },
      { label: 'Insert row', action: () => shift('row', 1) },
      { label: 'Insert column', action: () => shift('col', 1) },
      { label: s.r1 > s.r0 ? 'Delete rows' : 'Delete row', action: () => shift('row', -1) },
      { label: s.c1 > s.c0 ? 'Delete columns' : 'Delete column', action: () => shift('col', -1) },
      { separator: true },
      { label: s.r1 > s.r0 ? 'Hide rows' : 'Hide row', action: () => hide('row', true) },
      { label: s.c1 > s.c0 ? 'Hide columns' : 'Hide column', action: () => hide('col', true) },
      { label: 'Unhide rows', action: () => hide('row', false) },
      { label: 'Unhide columns', action: () => hide('col', false) },
      { separator: true },
      { label: 'Clear contents', hint: 'Del', action: () => deleteContents() },
    ];
    return menu;
  });
  on(scroller, 'contextmenu', (event: MouseEvent) => {
    if (onScrollbar(event)) return;
    const { x, y } = posOf(event);
    const p = hit(x, y);
    const s = sel();
    const inside = p.col >= s.c0 && p.col <= s.c1 && p.row >= s.r0 && p.row <= s.r1;
    if (!inside || p.where !== 'cell') {
      if (p.where === 'colhead') select({ c0: p.col, c1: p.col, r0: 0, r1: MAX_ROWS - 1 }, { col: p.col, row: 0 });
      else if (p.where === 'rowhead') select({ r0: p.row, r1: p.row, c0: 0, c1: MAX_COLS - 1 }, { col: 0, row: p.row });
      else if (p.where === 'cell') select({ c0: p.col, c1: p.col, r0: p.row, r1: p.row });
    }
  }, signal, { capture: true });

  geometry();
  changed();
  return grid;
}
