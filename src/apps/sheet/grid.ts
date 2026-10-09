// The spreadsheet's grid: draws the visible cells on a canvas and handles selecting, typing into cells, the fill
// handle, resizing rows and columns, copy and paste, and the keyboard the way Excel does. Only what is on screen is
// drawn or worked out, so a big sheet stays fast on a small device.
import { css, h, on } from '../../core/dom.ts';
import { clamp } from '../../core/dom.ts';
import { bindContextMenu, type MenuItem } from '../../shell/menu.ts';
import type { Shell } from '../../shell/types.ts';
import { addressOf, colName, MAX_COLS, MAX_ROWS, SyntaxProblem } from './refs.ts';
import { CellError } from './values.ts';
import { keyOf, type Range, type Workbook } from './workbook.ts';

const HEAD_W = 46;
const HEAD_H = 24;
const COL_W = 64;
const ROW_H = 20;
const FONT = '13px "Segoe UI", Arial, Helvetica, sans-serif';
const GRID = '#d9d9d9';
const HEAD_BG = '#f0f0f0';
const HEAD_SEL = '#d3e3d8';
const ACCENT = '#1e7a45';
const EDGE = 5;

interface Clip {
  sheet: number;
  range: Range;
  cut: boolean;
  text: string;
}

export interface Grid {
  readonly el: HTMLElement;
  readonly formulaInput: HTMLInputElement;
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
  onChange: () => void;
  onSelect: () => void;
  onEdit: (editing: boolean) => void;
}

export function createGrid(shell: Shell, wb: Workbook, signal: AbortSignal): Grid {
  const scroller = h('div', { class: 'grid-scroll', tabindex: 0, role: 'application', 'aria-label': 'Spreadsheet grid' });
  const spacer = h('div', { class: 'grid-spacer' });
  scroller.append(spacer);
  const canvas = h('canvas', { class: 'grid-canvas', 'aria-hidden': 'true' });
  const cellInput = h('input', { type: 'text', class: 'grid-editor', 'aria-label': 'Cell contents', spellcheck: 'false', autocomplete: 'off' });
  css(cellInput, { display: 'none' });
  const live = h('div', { class: 'visually-hidden', role: 'status', 'aria-live': 'polite' });
  const root = h('div', { class: 'grid-wrap' }, canvas, scroller, cellInput, live);
  const formulaInput = h('input', { type: 'text', class: 'formula-input', 'aria-label': 'Formula bar', spellcheck: 'false', autocomplete: 'off' });
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
    for (let c = 0; c < MAX_COLS; c++) cols.push(cols[c] + (sheet.colW.get(c) ?? COL_W));
    const rows = [0];
    for (let r = 0; r < MAX_ROWS; r++) rows.push(rows[r] + (sheet.rowH.get(r) ?? ROW_H));
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

  /** Which cell (or header) is under a point given in pixels from the top-left of the grid area. */
  function hit(x: number, y: number): { col: number; row: number; where: 'cell' | 'colhead' | 'rowhead' | 'corner' } {
    geometry();
    const z = state.zoom;
    const lx = x / z;
    const ly = y / z;
    const cx = lx - HEAD_W + scroller.scrollLeft / z;
    const cy = ly - HEAD_H + scroller.scrollTop / z;
    const col = clamp(search(state.colPos, Math.max(0, cx)), 0, MAX_COLS - 1);
    const row = clamp(search(state.rowPos, Math.max(0, cy)), 0, MAX_ROWS - 1);
    if (lx < HEAD_W && ly < HEAD_H) return { col, row, where: 'corner' };
    if (ly < HEAD_H) return { col, row, where: 'colhead' };
    if (lx < HEAD_W) return { col, row, where: 'rowhead' };
    return { col, row, where: 'cell' };
  }

  /** Screen rectangle (unscaled pixels) of a cell block. */
  function rect(c0: number, r0: number, c1: number, r1: number): { x: number; y: number; w: number; h: number } {
    geometry();
    const z = state.zoom;
    return {
      x: (HEAD_W + state.colPos[c0]) * z - scroller.scrollLeft,
      y: (HEAD_H + state.rowPos[r0]) * z - scroller.scrollTop,
      w: (state.colPos[c1 + 1] - state.colPos[c0]) * z,
      h: (state.rowPos[r1 + 1] - state.rowPos[r0]) * z,
    };
  }

  function reveal(col: number, row: number): void {
    geometry();
    const z = state.zoom;
    const box = rect(col, row, col, row);
    const vw = scroller.clientWidth;
    const vh = scroller.clientHeight;
    if (box.x < HEAD_W * z) scroller.scrollLeft += box.x - HEAD_W * z;
    else if (box.x + box.w > vw) scroller.scrollLeft += Math.min(box.x + box.w - vw, box.x - HEAD_W * z);
    if (box.y < HEAD_H * z) scroller.scrollTop += box.y - HEAD_H * z;
    else if (box.y + box.h > vh) scroller.scrollTop += Math.min(box.y + box.h - vh, box.y - HEAD_H * z);
  }

  // ---- Selection -------------------------------------------------------------------------------------------------

  function sel(): Range {
    return {
      c0: Math.min(state.anchor.col, state.cursor.col),
      c1: Math.max(state.anchor.col, state.cursor.col),
      r0: Math.min(state.anchor.row, state.cursor.row),
      r1: Math.max(state.anchor.row, state.cursor.row),
    };
  }

  function select(r: Range, active?: { col: number; row: number }): void {
    const a = active ?? { col: r.c0, row: r.r0 };
    state.cursor = { ...a };
    // The anchor is the corner opposite the active cell.
    state.anchor = { col: a.col === r.c0 ? r.c1 : r.c0, row: a.row === r.r0 ? r.r1 : r.r0 };
    changed();
  }

  function moveCursor(col: number, row: number, extend: boolean): void {
    const c = clamp(col, 0, MAX_COLS - 1);
    const r = clamp(row, 0, MAX_ROWS - 1);
    state.cursor = { col: c, row: r };
    if (!extend) state.anchor = { col: c, row: r };
    reveal(c, r);
    changed();
  }

  function changed(): void {
    nameBox.value = sel().c0 === sel().c1 && sel().r0 === sel().r1 ? addressOf(state.cursor.col, state.cursor.row) : `${addressOf(sel().c0, sel().r0)}:${addressOf(sel().c1, sel().r1)}`;
    if (!state.editing) formulaInput.value = grid.wb.editText(grid.wb.active, state.cursor.col, state.cursor.row);
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
    const c0 = search(state.colPos, left);
    const r0 = search(state.rowPos, top);
    let c1 = c0;
    while (c1 < MAX_COLS - 1 && state.colPos[c1] - left < w / z - HEAD_W) c1++;
    let r1 = r0;
    while (r1 < MAX_ROWS - 1 && state.rowPos[r1] - top < vh / z - HEAD_H) r1++;
    const X = (c: number) => (HEAD_W + state.colPos[c] - left) * z;
    const Y = (r: number) => (HEAD_H + state.rowPos[r] - top) * z;

    ctx.save();
    ctx.beginPath();
    ctx.rect(HEAD_W * z, HEAD_H * z, w, vh);
    ctx.clip();

    // Cell fills.
    const s = sel();
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const style = wbk.styleOf(sheet.cells.get(keyOf(c, r)));
        if (!style?.fill) continue;
        ctx.fillStyle = style.fill;
        ctx.fillRect(X(c), Y(r), X(c + 1) - X(c), Y(r + 1) - Y(r));
      }
    }

    // Grid lines.
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let c = c0; c <= c1 + 1; c++) {
      const x = Math.round(X(c)) + 0.5;
      ctx.moveTo(x, HEAD_H * z);
      ctx.lineTo(x, vh);
    }
    for (let r = r0; r <= r1 + 1; r++) {
      const y = Math.round(Y(r)) + 0.5;
      ctx.moveTo(HEAD_W * z, y);
      ctx.lineTo(w, y);
    }
    ctx.stroke();

    // Cell borders.
    ctx.strokeStyle = '#000';
    ctx.beginPath();
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const style = wbk.styleOf(sheet.cells.get(keyOf(c, r)));
        if (!style || !(style.bt || style.bb || style.bl || style.br)) continue;
        const x = Math.round(X(c)) + 0.5;
        const y = Math.round(Y(r)) + 0.5;
        const x2 = Math.round(X(c + 1)) + 0.5;
        const y2 = Math.round(Y(r + 1)) + 0.5;
        if (style.bt) { ctx.moveTo(x, y); ctx.lineTo(x2, y); }
        if (style.bb) { ctx.moveTo(x, y2); ctx.lineTo(x2, y2); }
        if (style.bl) { ctx.moveTo(x, y); ctx.lineTo(x, y2); }
        if (style.br) { ctx.moveTo(x2, y); ctx.lineTo(x2, y2); }
      }
    }
    ctx.stroke();

    // Text.
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const cell = sheet.cells.get(keyOf(c, r));
        const style = wbk.styleOf(cell);
        const x = X(c);
        const y = Y(r);
        const cw = X(c + 1) - x;
        const ch = Y(r + 1) - y;
        if (!cell || (cell.v === undefined && cell.f === undefined)) continue;
        const shown = wbk.display(sheetIndex, c, r);
        if (shown === '') continue;
        const v = wbk.value(sheetIndex, c, r);
        ctx.font = `${style?.i ? 'italic ' : ''}${style?.b ? 'bold ' : ''}${13 * z}px "Segoe UI", Arial, Helvetica, sans-serif`;
        ctx.fillStyle = v instanceof CellError ? '#c0392b' : (style?.color ?? '#000');
        const isNum = typeof v === 'number';
        const align = style?.al ?? (isNum ? 'r' : v instanceof CellError || typeof v === 'boolean' ? 'c' : 'l');
        let text = shown;
        let tw = ctx.measureText(text).width;
        const pad = 3 * z;
        let clipX = x;
        let clipW = cw;
        if (tw > cw - pad * 2) {
          if (isNum && style?.fmt !== 'text') {
            text = '#'.repeat(Math.max(1, Math.floor((cw - pad * 2) / Math.max(1, ctx.measureText('#').width))));
            tw = ctx.measureText(text).width;
          } else if (align === 'l') {
            // Text spills into empty cells on its right.
            let end = c + 1;
            let room = cw;
            while (end <= c1 + 1 && end < MAX_COLS && !sheet.cells.get(keyOf(end, r))?.v && sheet.cells.get(keyOf(end, r))?.f === undefined && room < tw + pad * 2) {
              room += X(end + 1) - X(end);
              end++;
            }
            clipW = room;
            ctx.fillStyle = '#fff';
            ctx.fillRect(x + cw - 1, y + 1, room - cw, ch - 1);
            ctx.fillStyle = v instanceof CellError ? '#c0392b' : (style?.color ?? '#000');
          }
        }
        ctx.save();
        ctx.beginPath();
        ctx.rect(clipX, y, clipW, ch);
        ctx.clip();
        const tx = align === 'r' ? x + cw - pad - tw : align === 'c' ? x + (cw - tw) / 2 : x + pad;
        ctx.fillText(text, tx, y + ch / 2 + z);
        if (style?.u) ctx.fillRect(tx, y + ch / 2 + 7 * z, tw, Math.max(1, z));
        ctx.restore();
        clipX = x;
      }
    }

    // Selection.
    const box = rect(s.c0, s.r0, s.c1, s.r1);
    const many = s.c1 > s.c0 || s.r1 > s.r0;
    if (many) {
      ctx.fillStyle = 'rgba(30, 122, 69, 0.12)';
      ctx.fillRect(box.x, box.y, box.w, box.h);
      const a = rect(state.cursor.col, state.cursor.row, state.cursor.col, state.cursor.row);
      ctx.fillStyle = '#fff';
      ctx.fillRect(a.x + 1, a.y + 1, a.w - 2, a.h - 2);
      const v = wbk.display(sheetIndex, state.cursor.col, state.cursor.row);
      if (v) {
        ctx.fillStyle = '#000';
        ctx.font = FONT.replace('13px', `${13 * z}px`);
        ctx.fillText(v, a.x + 3 * z, a.y + a.h / 2 + z);
      }
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

    // Headers (drawn last so scrolled cells never show through).
    ctx.font = `${12 * z}px "Segoe UI", Arial, Helvetica, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = HEAD_BG;
    ctx.fillRect(0, 0, w, HEAD_H * z);
    ctx.fillRect(0, 0, HEAD_W * z, vh);
    ctx.strokeStyle = '#c6c6c6';
    ctx.lineWidth = 1;
    for (let c = c0; c <= c1; c++) {
      const x = X(c);
      const cw = X(c + 1) - x;
      const inSel = c >= s.c0 && c <= s.c1;
      if (inSel) {
        ctx.fillStyle = HEAD_SEL;
        ctx.fillRect(x, 0, cw, HEAD_H * z);
      }
      ctx.fillStyle = inSel ? ACCENT : '#333';
      ctx.textAlign = 'center';
      ctx.fillText(colName(c), x + cw / 2, HEAD_H * z / 2 + 1);
      ctx.beginPath();
      ctx.moveTo(Math.round(x + cw) + 0.5, 0);
      ctx.lineTo(Math.round(x + cw) + 0.5, HEAD_H * z);
      ctx.stroke();
    }
    for (let r = r0; r <= r1; r++) {
      const y = Y(r);
      const rh = Y(r + 1) - y;
      const inSel = r >= s.r0 && r <= s.r1;
      if (inSel) {
        ctx.fillStyle = HEAD_SEL;
        ctx.fillRect(0, y, HEAD_W * z, rh);
      }
      ctx.fillStyle = inSel ? ACCENT : '#333';
      ctx.textAlign = 'center';
      ctx.fillText(String(r + 1), HEAD_W * z / 2, y + rh / 2 + 1);
      ctx.beginPath();
      ctx.moveTo(0, Math.round(y + rh) + 0.5);
      ctx.lineTo(HEAD_W * z, Math.round(y + rh) + 0.5);
      ctx.stroke();
    }
    ctx.fillStyle = '#e4e4e4';
    ctx.fillRect(0, 0, HEAD_W * z, HEAD_H * z);
    ctx.strokeStyle = '#b5b5b5';
    ctx.strokeRect(0.5, 0.5, w - 1, HEAD_H * z - 1);
    ctx.textAlign = 'left';
    if (state.editing) placeEditor();
  }

  // ---- Editing ---------------------------------------------------------------------------------------------------

  function placeEditor(): void {
    const b = rect(state.cursor.col, state.cursor.row, state.cursor.col, state.cursor.row);
    const wide = Math.max(b.w, 160 * state.zoom);
    css(cellInput, { left: b.x, top: b.y, width: wide, height: b.h, display: 'block', 'font-size': `${13 * state.zoom}px` });
  }

  function beginEdit(initial: string | null, from: 'cell' | 'bar' = 'cell'): void {
    if (state.editing) return;
    state.editing = true;
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
    endEdit();
    grid.onChange();
    return true;
  }

  function cancelEdit(): void {
    if (!state.editing) return;
    endEdit();
    scroller.focus({ preventScroll: true });
  }

  const syncFrom = (src: HTMLInputElement, dst: HTMLInputElement) => () => {
    dst.value = src.value;
    state.pointAt = null;
    if (!state.editing) {
      // Typing in the formula bar starts an edit of the current cell.
      state.editing = true;
      placeEditor();
      grid.onEdit(true);
    }
  };
  on(cellInput, 'input', syncFrom(cellInput, formulaInput), signal);
  on(formulaInput, 'input', syncFrom(formulaInput, cellInput), signal);

  const editKeys = (event: KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (commit()) {
        moveCursor(state.tabCol ?? state.cursor.col, state.cursor.row + (event.shiftKey ? -1 : 1), false);
        state.tabCol = null;
        scroller.focus({ preventScroll: true });
      }
    } else if (event.key === 'Tab') {
      event.preventDefault();
      const began = state.tabCol ?? state.cursor.col;
      if (commit()) {
        state.tabCol = began;
        moveCursor(state.cursor.col + (event.shiftKey ? -1 : 1), state.cursor.row, false);
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
    scroller.setPointerCapture(event.pointerId);
    if (p.where === 'corner') {
      select({ c0: 0, r0: 0, c1: MAX_COLS - 1, r1: MAX_ROWS - 1 }, { col: 0, row: 0 });
      return;
    }
    const extend = event.shiftKey;
    const startAnchor = extend ? { ...state.anchor } : { col: p.col, row: p.row };
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
    apply({ col: p.col, row: p.row });
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

  function autoFit(axis: 'col' | 'row', index: number): void {
    if (axis === 'row') {
      grid.wb.setSize(grid.wb.active, 'row', index, null);
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
    if (arrow[key]) {
      const [dc, dr] = arrow[key];
      if (ctrl) {
        const to = jump(col, row, dc, dr);
        moveCursor(to.col, to.row, event.shiftKey);
      } else moveCursor(col + dc, row + dr, event.shiftKey);
    } else if (key === 'Tab') moveCursor(col + (event.shiftKey ? -1 : 1), row, false);
    else if (key === 'Enter') {
      moveCursor(state.tabCol ?? col, row + (event.shiftKey ? -1 : 1), false);
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
    const many = sel();
    let formula: string;
    if (many.r1 > many.r0 || many.c1 > many.c0) {
      // A block is selected: put the totals in the row below (or column to the right).
      const tall = many.r1 - many.r0 >= many.c1 - many.c0;
      try {
        if (tall) for (let c = many.c0; c <= many.c1; c++) grid.wb.setInput(s, c, many.r1 + 1, `=SUM(${addressOf(c, many.r0)}:${addressOf(c, many.r1)})`);
        else for (let r = many.r0; r <= many.r1; r++) grid.wb.setInput(s, many.c1 + 1, r, `=SUM(${addressOf(many.c0, r)}:${addressOf(many.c1, r)})`);
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
        else for (let ty = 0; ty < tilesY; ty++) for (let tx = 0; tx < tilesX; tx++) grid.wb.copyBlock(grid.wb.active, clip.range, { col: target.col + tx * width, row: target.row + ty * height }, { fromSheet: clip.sheet });
        if (clip.cut) state.clip = null;
        select({ c0: target.col, r0: target.row, c1: target.col + width * (clip.cut ? 1 : tilesX) - 1, r1: target.row + height * (clip.cut ? 1 : tilesY) - 1 }, target);
      } else if (text !== null && text !== '') {
        const rows = text.replace(/\r?\n$/, '').split(/\r?\n/);
        const cols = Math.max(...rows.map(r => r.split('\t').length));
        grid.wb.importText(grid.wb.active, target.col, target.row, text.replace(/\r?\n$/, ''));
        select({ c0: target.col, r0: target.row, c1: Math.min(MAX_COLS - 1, target.col + cols - 1), r1: Math.min(MAX_ROWS - 1, target.row + rows.length - 1) }, target);
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
