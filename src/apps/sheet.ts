// Spreadsheet: the window around the grid. A File menu, a ribbon laid out like a familiar spreadsheet's (Home: clipboard,
// font, alignment, number, styles, editing, view; Insert: charts; Page Layout: printing; Data: sort, filter, validation),
// the formula bar, sheet tabs, and a status bar that shows the sum, average and count of whatever is selected. Opens
// .sheet files (our own format), Excel workbooks (.xlsx, saved back as .xlsx) and .csv/.tsv (as a new, unsaved workbook).
// Find and Replace is a panel over the grid; the filter's ▾ opens a list of values; charts float over the cells.
import { css, h, on } from '../core/dom.ts';
import { formatSize } from '../core/format.ts';
import { baseName, joinPath, nameProblem, parentPath, splitExtension, uniqueName } from '../fs/names.ts';
import type { MenuItem } from '../shell/menu.ts';
import type { AppDef } from '../shell/types.ts';
import type { NativeHost } from '../shell/native.ts';
import { longDateCode, shortDateCode, type DateOrder } from './sheet/dates.ts';
import { createGrid } from './sheet/grid.ts';
import { codeProblem, formatCode, isDateCode } from './sheet/numfmt.ts';
import { addressOf, colName, SyntaxProblem } from './sheet/refs.ts';
import { CellError, formatNumber, type CellStyle, type Line } from './sheet/values.ts';
import { keyOf, MAX_FILE_BYTES, Workbook, type FindOptions, type Found, type Range } from './sheet/workbook.ts';
import { openXlsx, saveXlsx, type XlsxReport } from './sheet/xlsx.ts';
import { CHART_LABEL, CHART_TYPES } from './sheet/chart.ts';
import { chartIcon, mountCharts } from './sheet/charts-ui.ts';
import { MARGINS, pageOf, PAPERS, planPages, type Paper } from './sheet/print.ts';
import { downloadPdf, marginName, pageSetupDialog, printPreview, savePdfInDocuments, setPage, type PrintContext } from './sheet/print-ui.ts';
import { conditionalMenu, validationDialog } from './sheet/rules-ui.ts';
import { autoSumMenu, createFromSelection, functionMenu, insertFunctionDialog, nameDialog, nameManager, useInFormulaMenu } from './sheet/formulas-ui.ts';
import { APPS } from './catalog.ts';
import { FONT_FACES, FONT_SIZES, STANDARD_SIZE, stepSize } from './sheet/fonts.ts';
import { activeTable, formatAsTableMenu, insertTableDialog, tableDesign, tableSummary, totalChoices } from './sheet/tables-ui.ts';
import { dataRows as tableData } from './sheet/tables.ts';
import { formatCellsDialog } from './sheet/format-ui.ts';
import { filterRuleMenu, removeDuplicatesDialog, sortDialog, textToColumnsDialog } from './sheet/data-ui.ts';
import { activePivot, insertPivotDialog, mountPivotPane, pivotAnalyze } from './sheet/pivot-ui.ts';

/** Excel's ready-made cell styles (Home > Cell styles): a look each, with its colours as Excel has them. */
const CELL_STYLES: Array<{ label: string; look: CellStyle }> = [
  { label: 'Good', look: { fill: '#c6efce', color: '#006100' } },
  { label: 'Bad', look: { fill: '#ffc7ce', color: '#9c0006' } },
  { label: 'Neutral', look: { fill: '#ffeb9c', color: '#9c5700' } },
  { label: 'Calculation', look: { fill: '#f2f2f2', color: '#fa7d00', b: true, bt: true, bb: true, bl: true, br: true, bc: '#7f7f7f' } },
  { label: 'Check cell', look: { fill: '#a5a5a5', color: '#ffffff', b: true, bt: 'double', bb: 'double', bl: 'double', br: 'double', bc: '#3f3f3f' } },
  { label: 'Explanatory text', look: { color: '#7f7f7f', i: true } },
  { label: 'Input', look: { fill: '#ffcc99', color: '#3f3f76', bt: true, bb: true, bl: true, br: true, bc: '#7f7f7f' } },
  { label: 'Linked cell', look: { color: '#fa7d00', bb: 'double', bc: '#ff8001' } },
  { label: 'Note', look: { fill: '#ffffcc', bt: true, bb: true, bl: true, br: true, bc: '#b2b2b2' } },
  { label: 'Output', look: { fill: '#f2f2f2', color: '#3f3f3f', b: true, bt: true, bb: true, bl: true, br: true, bc: '#3f3f3f' } },
  { label: 'Warning text', look: { color: '#ff0000' } },
  { label: 'Title', look: { fs: 18, color: '#44546a' } },
  { label: 'Heading 1', look: { fs: 15, b: true, color: '#44546a', bb: 'thick', bc: '#4472c4' } },
  { label: 'Heading 2', look: { fs: 13, b: true, color: '#44546a', bb: 'thick', bc: '#a2b8e1' } },
  { label: 'Heading 3', look: { b: true, color: '#44546a', bb: 'medium', bc: '#8ea9db' } },
  { label: 'Heading 4', look: { b: true, color: '#44546a' } },
  { label: 'Total', look: { b: true, bt: true, bb: 'double', bc: '#4472c4' } },
  { label: 'Accent 1 (blue)', look: { fill: '#4472c4', color: '#ffffff' } },
  { label: 'Accent 2 (orange)', look: { fill: '#ed7d31', color: '#ffffff' } },
  { label: 'Accent 3 (grey)', look: { fill: '#a5a5a5', color: '#ffffff' } },
  { label: 'Accent 4 (gold)', look: { fill: '#ffc000', color: '#ffffff' } },
  { label: 'Accent 5 (light blue)', look: { fill: '#5b9bd5', color: '#ffffff' } },
  { label: 'Accent 6 (green)', look: { fill: '#70ad47', color: '#ffffff' } },
  { label: '20% Accent 1 (pale blue)', look: { fill: '#d9e1f2' } },
  { label: '20% Accent 2 (pale orange)', look: { fill: '#fce4d6' } },
  { label: '20% Accent 6 (pale green)', look: { fill: '#e2efda' } },
];
import { saveOver } from '../shell/savefile.ts';

const PALETTE: Array<[string, string]> = [
  ['White', '#ffffff'], ['Light grey', '#d9d9d9'], ['Grey', '#7f7f7f'], ['Black', '#000000'],
  ['Light red', '#f4b6b0'], ['Red', '#d13438'], ['Dark red', '#7a1f1f'], ['Light orange', '#fbd5a8'],
  ['Orange', '#f2811d'], ['Light yellow', '#fff2a8'], ['Yellow', '#ffd400'], ['Light green', '#c4e6b5'],
  ['Green', '#1e7a45'], ['Dark green', '#124d2b'], ['Light blue', '#b9d7f5'], ['Blue', '#2f6fd0'],
  ['Dark blue', '#1b3f7a'], ['Light purple', '#dcc6ee'], ['Purple', '#7a3fa0'], ['Pink', '#f5b8d8'],
];

/** This person's spreadsheet settings: which way round typed dates are read. */
const SETTINGS_PATH = '/System/spreadsheet.json';
const ORDER_LABEL: Record<DateOrder, string> = { dmy: 'Day first (13/10/2026)', mdy: 'Month first (10/13/2026)', ymd: 'Year first (2026-10-13)' };

/** Format codes offered in More number formats, as Excel lists them. */
const COMMON_CODES = [
  '0', '0.00', '#,##0', '#,##0.00', '#,##0.00;[Red]-#,##0.00', '$#,##0.00', '0%', '0.00%', '0.00E+00', '# ?/?', '00000',
  'd/mm/yyyy', 'dd/mm/yyyy', 'm/d/yyyy', 'yyyy-mm-dd', 'd mmm yyyy', 'd-mmm-yy', 'dddd, d mmmm yyyy', 'mmm-yy', 'mmmm yyyy',
  'h:mm', 'h:mm AM/PM', 'h:mm:ss', '[h]:mm:ss', 'dd/mm/yyyy h:mm', '@',
];

/** Adds (+1) or takes away (-1) a decimal place in every number part of a format code ("0.00" to "0.000"). */
function shiftDecimals(code: string, d: number): string {
  return code.split(';').map(part => {
    if (!/[0#?]/.test(part.replace(/"[^"]*"/g, ''))) return part;
    const m = /\.([0#?]*)/.exec(part);
    if (m) {
      const run = d > 0 ? m[1] + '0' : m[1].slice(0, -1);
      return part.slice(0, m.index) + (run ? `.${run}` : '') + part.slice(m.index + m[0].length);
    }
    if (d < 0) return part;
    // No decimals yet: ".0" after the last placeholder.
    const last = Math.max(part.lastIndexOf('0'), part.lastIndexOf('#'), part.lastIndexOf('?'));
    return part.slice(0, last + 1) + '.0' + part.slice(last + 1);
  }).join(';');
}

export const sheetApp: AppDef = {
  ...APPS.sheet,
  async launch(app, arg) {
    const shell = app.shell;
    app.root.classList.add('sheet');
    const wb = new Workbook();
    // Read before any file is opened: a CSV's dates are read this way round.
    try {
      const saved = JSON.parse(await shell.fs.readText(SETTINGS_PATH)) as { dateOrder?: unknown };
      if (saved.dateOrder === 'dmy' || saved.dateOrder === 'mdy' || saved.dateOrder === 'ymd') wb.dateOrder = saved.dateOrder;
    } catch {
      // Nothing saved yet: the order this computer's browser writes dates in.
    }
    let path: string | null = null;
    let loadedId = '';
    let savedVersion = wb.version;
    let label = shell.native?.untitled ?? 'Untitled';
    /** How the file at `path` is saved: our own format, or as an Excel workbook. */
    let kind: 'sheet' | 'xlsx' = 'sheet';
    /** What opening an Excel file left out; saving over that file asks first while this is set. */
    let lost: XlsxReport | null = null;

    if (arg) {
      try {
        const entry = await shell.fs.stat(arg);
        if (!entry || entry.kind !== 'file') throw new SyntaxProblem('That file is not there any more. It may have been moved or deleted.');
        if (entry.size > MAX_FILE_BYTES) throw new SyntaxProblem(`This file is ${formatSize(entry.size)}. The spreadsheet opens files up to ${formatSize(MAX_FILE_BYTES)}.`);
        const bytes = await shell.fs.readFile(arg);
        const name = baseName(arg);
        const ext = splitExtension(name)[1].toLowerCase();
        const excel = ext === '.xlsx' || ext === '.xlsm' || ext === '.xls';
        const text = excel ? '' : new TextDecoder('utf-8').decode(bytes);
        if (ext === '.csv' || ext === '.tsv' || ext === '.txt') {
          wb.importText(0, 0, 0, text);
          label = name;
        } else if (excel) {
          const report = await openXlsx(wb, bytes);
          label = name;
          // An .xlsx is saved back as one. An .xlsm holds macros this spreadsheet never saves: it is saved as a new file.
          if (ext === '.xlsx') {
            path = arg;
            loadedId = entry.id;
            kind = 'xlsx';
          }
          if (report.dropped.length || report.asValues.count || report.differ.count) lost = report;
        } else {
          try {
            wb.load(JSON.parse(text));
          } catch (error) {
            if (error instanceof SyntaxProblem) throw error;
            throw new SyntaxProblem('This is not a spreadsheet this app can open (it is not a saved spreadsheet).');
          }
          path = arg;
          loadedId = entry.id;
          label = name;
        }
        // An opened file starts clean, with nothing to undo.
        wb.load(JSON.parse(wb.serialize()));
        shell.native?.remember(arg);
      } catch (error) {
        const why = error instanceof SyntaxProblem ? error.message : 'This file could not be opened.';
        if (!(error instanceof SyntaxProblem)) await shell.report('Could not open the spreadsheet', error);
        app.root.append(h('div', { class: 'app-message', role: 'alert' }, h('p', {}, why), h('p', { class: 'dialog-detail' }, 'The file was not changed.')));
        app.setTitle(baseName(arg));
        return;
      }
    }
    savedVersion = wb.version;

    const grid = createGrid(shell, wb, app.signal);
    if (lost) void showReport(label, lost);

    /** What opening an Excel file left out or could not work out, in a list the person can read before going on. */
    async function showReport(name: string, report: XlsxReport): Promise<void> {
      const items: Node[] = [];
      if (report.dropped.length) {
        items.push(h('p', { class: 'dialog-text' }, 'This spreadsheet does not have these yet, so they were left out:'), h('ul', { class: 'xlsx-list' }, ...report.dropped.map(d => h('li', {}, d))));
      }
      if (report.asValues.count) {
        const fns = report.asValues.names.length ? ` (${report.asValues.names.join(', ')})` : '';
        const many = report.asValues.count > 1;
        items.push(h('p', { class: 'dialog-text' }, `${report.asValues.count.toLocaleString()} ${many ? 'formulas use' : 'formula uses'} something this spreadsheet does not have${fns}. ${many ? 'They show' : 'It shows'} the answer Excel last saved, and will not update: ${report.asValues.examples.join(', ')}${report.asValues.count > report.asValues.examples.length ? ' and more' : ''}.`));
      }
      if (report.differ.count) {
        const many = report.differ.count > 1;
        items.push(h('p', { class: 'dialog-text' }, `${report.differ.count.toLocaleString()} ${many ? 'formulas give' : 'formula gives'} a different answer here from the one Excel saved. Worth checking: ${report.differ.examples.join(', ')}${report.differ.count > report.differ.examples.length ? ' and more' : ''}.`));
      }
      items.push(h('p', { class: 'dialog-detail' }, kind === 'xlsx' ? 'The file itself has not been changed. Saving over it would leave these out of it too, so Save asks first.' : 'The file itself has not been changed.'));
      await shell.dialogs.ask<true>({ title: `Opened “${name}”`, body: h('div', { class: 'xlsx-report' }, ...items), buttons: [{ label: 'OK', value: true, primary: true }], cancel: true });
      grid.focus();
    }
    const refresh = () => {
      const dirty = wb.version !== savedVersion;
      app.setDirty(dirty);
      app.setTitle(label);
    };

    // ---- Small helpers ---------------------------------------------------------------------------------------------

    const btn = (text: string, title: string, run: () => void, cls = ''): HTMLButtonElement => {
      const b = h('button', { type: 'button', class: `rb ${cls}`.trim(), title, 'aria-label': title }, text);
      on(b, 'click', () => {
        run();
        if (!grid.editing()) grid.focus();
      }, app.signal);
      return b;
    };
    const group = (name: string, ...kids: Node[]): HTMLElement => h('div', { class: 'rgroup', role: 'group', 'aria-label': name }, h('div', { class: 'rgroup-items' }, ...kids), h('div', { class: 'rgroup-name' }, name));
    /** A group whose buttons wrap at `width` pixels into rows, as Excel stacks small buttons (the ribbon stays low). */
    const sized = (width: number, g: HTMLElement): HTMLElement => {
      css(g.querySelector<HTMLElement>('.rgroup-items')!, { 'max-width': width });
      return g;
    };
    const report = async (error: unknown) => {
      if (error instanceof SyntaxProblem) await shell.dialogs.alert('That could not be done', error.message);
      else await shell.report('The spreadsheet could not do that', error);
    };
    // What the chart, rule and printing screens need from this window.
    const ctx: PrintContext = { shell, wb, grid, root: app.root, signal: app.signal, onChange: () => onChange(), report, fileLabel: () => label };
    const charts = mountCharts(ctx);
    // The grid, and beside it the PivotTable Fields pane (shown while the active cell is in a PivotTable).
    const main = h('div', { class: 'sheet-main' }, grid.el);
    const pivotPane = mountPivotPane(ctx, main);
    const doStyle = (patch: (old: CellStyle) => CellStyle) => {
      if (!grid.commit()) return;
      try {
        wb.setStyle(wb.active, grid.sel(), patch);
        grid.widen(grid.sel());
        // Bold or wrapping changes how tall wrapped text is.
        grid.fitRows();
        onChange();
      } catch (error) {
        void report(error);
      }
    };
    const activeStyle = (): CellStyle => {
      const a = grid.active();
      return wb.styleOf(wb.sheets[wb.active].cells.get(keyOf(a.col, a.row))) ?? {};
    };

    // ---- Toolbar ---------------------------------------------------------------------------------------------------

    const undoBtn = btn('↶', 'Undo (Ctrl+Z)', () => {
      if (grid.commit()) {
        wb.undo();
        onChange();
      }
    });
    const redoBtn = btn('↷', 'Redo (Ctrl+Y)', () => {
      if (grid.commit()) {
        wb.redo();
        onChange();
      }
    });
    const boldBtn = btn('B', 'Bold (Ctrl+B)', () => doStyle(s => ({ ...s, b: !activeStyle().b })), 'bold');
    const italicBtn = btn('I', 'Italic (Ctrl+I)', () => doStyle(s => ({ ...s, i: !activeStyle().i })), 'italic');
    const underBtn = btn('U', 'Underline (Ctrl+U)', () => doStyle(s => ({ ...s, u: !activeStyle().u })), 'under');
    const alignBtns = (['l', 'c', 'r'] as const).map(al => btn(al === 'l' ? '⇤' : al === 'c' ? '↔' : '⇥', `Align ${al === 'l' ? 'left' : al === 'c' ? 'centre' : 'right'}`, () => doStyle(s => ({ ...s, al: activeStyle().al === al ? undefined : al }))));
    const strikeBtn = btn('S', 'Strikethrough (Ctrl+5)', () => doStyle(s => ({ ...s, st: activeStyle().st ? undefined : true })), 'strike');
    // Typeface and size (Home > Font): Standard is this spreadsheet's own font, saved to Excel as Calibri 11.
    const otherFace = h('option', { value: '', hidden: true });
    const faceSelect = h('select', { class: 'rb-select font-face', 'aria-label': 'Font', title: 'Font (typeface)' },
      h('option', { value: '' }, 'Standard'), ...FONT_FACES.map(f => h('option', { value: f.name }, f.name)), otherFace);
    on(faceSelect, 'change', () => {
      const face = faceSelect.value || undefined;
      doStyle(s => ({ ...s, ff: face }));
      grid.focus();
    }, app.signal);
    const sizeList = h('datalist', { id: `fs-${Math.random().toString(36).slice(2)}` }, ...FONT_SIZES.map(n => h('option', { value: String(n) })));
    const sizeBox = h('input', { type: 'text', class: 'rb-size', 'aria-label': 'Font size', title: 'Font size in points (11 is the standard)', list: sizeList.id, inputmode: 'decimal', autocomplete: 'off', spellcheck: false });
    const setSize = (n: number) => {
      const v = Math.round(n * 2) / 2;
      doStyle(s => ({ ...s, fs: v === STANDARD_SIZE ? undefined : v }));
    };
    const applySize = () => {
      const n = Number(sizeBox.value.trim().replace(',', '.'));
      if (sizeBox.value.trim() === String(activeStyle().fs ?? STANDARD_SIZE)) return;
      if (!Number.isFinite(n) || n < 1 || n > 409) {
        void shell.dialogs.alert('That is not a font size', 'Type a size from 1 to 409 points. 11 is the standard size.');
        syncToolbar();
        return;
      }
      setSize(n);
    };
    on(sizeBox, 'change', applySize, app.signal);
    on(sizeBox, 'keydown', (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        applySize();
        grid.focus();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        syncToolbar();
        grid.focus();
      }
      event.stopPropagation();
    }, app.signal);
    const growBtn = btn('A+', 'Increase font size (Ctrl+Shift+>)', () => setSize(stepSize(activeStyle().fs, true)), 'grow');
    const shrinkBtn = btn('A-', 'Decrease font size (Ctrl+Shift+<)', () => setSize(stepSize(activeStyle().fs, false)), 'shrink');
    // Up and down the cell, and the indent.
    const vaBtns = (['t', 'm', 'b'] as const).map(va => btn(va === 't' ? '⤒' : va === 'm' ? '⇕' : '⤓', `${va === 't' ? 'Top' : va === 'm' ? 'Middle' : 'Bottom'} align`, () => doStyle(s => ({ ...s, va: va === 'b' ? undefined : va }))));
    const indentIn = btn('Indent +', 'Increase indent', () => doStyle(s => ({ ...s, ind: Math.min(15, (s.ind ?? 0) + 1), al: s.al === 'c' ? undefined : s.al })), 'text-rb');
    const indentOut = btn('Indent -', 'Decrease indent', () => doStyle(s => ({ ...s, ind: s.ind && s.ind > 1 ? s.ind - 1 : undefined })), 'text-rb');

    // Format Painter: the look of the selected cells, brushed onto the next cells selected (double-click: until Esc).
    let painter: { sheet: number; range: Range; sticky: boolean } | null = null;
    const painterBtn = h('button', { type: 'button', class: 'rb text-rb', title: 'Format painter: copy the look of these cells onto others. Double-click to keep painting; Esc stops.', 'aria-label': 'Format painter' }, 'Format painter');
    const stopPainting = () => {
      painter = null;
      grid.el.classList.remove('painting');
      painterBtn.setAttribute('aria-pressed', 'false');
    };
    on(painterBtn, 'click', () => {
      if (!grid.commit()) return;
      if (painter) {
        stopPainting();
        return;
      }
      painter = { sheet: wb.active, range: grid.sel(), sticky: false };
      grid.el.classList.add('painting');
      painterBtn.setAttribute('aria-pressed', 'true');
      grid.focus();
    }, app.signal);
    on(painterBtn, 'dblclick', () => {
      if (!grid.commit()) return;
      painter = { sheet: wb.active, range: painter?.range ?? grid.sel(), sticky: true };
      grid.el.classList.add('painting');
      painterBtn.setAttribute('aria-pressed', 'true');
      grid.focus();
    }, app.signal);
    on(grid.el, 'pointerup', () => {
      if (!painter) return;
      // After the selection is made: the next frame, when the grid has taken the click.
      requestAnimationFrame(() => {
        if (!painter) return;
        try {
          wb.paintFormats(painter.sheet, painter.range, wb.active, grid.sel());
          grid.fitRows();
          onChange();
        } catch (error) {
          void report(error);
        }
        if (!painter.sticky) stopPainting();
      });
    }, app.signal);

    const clearBtn = btn('Clear ▾', 'Clear: contents, formats, or both', () => {
      const r = clearBtn.getBoundingClientRect();
      const run = (fn: () => void) => () => {
        if (!grid.commit()) return;
        try {
          wb.batch(fn);
          grid.fitRows();
          onChange();
        } catch (error) {
          void report(error);
        }
      };
      shell.menus.show([
        { label: 'Clear all', action: run(() => {
          wb.clearContents(wb.active, grid.sel());
          wb.clearFormats(wb.active, grid.sel());
          wb.clearNotes(wb.active, grid.sel());
        }) },
        { label: 'Clear formats', action: run(() => wb.clearFormats(wb.active, grid.sel())) },
        { label: 'Clear contents', hint: 'Del', action: run(() => wb.clearContents(wb.active, grid.sel())) },
        { label: 'Clear notes', action: run(() => wb.clearNotes(wb.active, grid.sel())) },
      ], r.left, r.bottom, { returnFocus: clearBtn });
    }, 'text-rb');

    const pasteMenuBtn = btn('Paste special ▾', 'Paste special: values, formulas, formatting, or turned on its side', () => {
      const r = pasteMenuBtn.getBoundingClientRect();
      const none = !grid.hasClip();
      const p = (what: Parameters<typeof grid.pasteSpecial>[0], transpose = false) => () => {
        if (grid.commit()) grid.pasteSpecial(what, transpose);
        onChange();
      };
      shell.menus.show([
        { label: 'Paste', hint: 'Ctrl+V', disabled: none, action: p('all') },
        { label: 'Values', hint: 'Ctrl+Shift+V', disabled: none, action: p('values') },
        { label: 'Formulas', disabled: none, action: p('formulas') },
        { label: 'Formatting', disabled: none, action: p('formats') },
        { label: 'Values and formatting', disabled: none, action: p('valuesFormats') },
        { label: 'Transpose (rows become columns)', disabled: none, action: p('all', true) },
        { label: 'Column widths', disabled: none, action: () => {
          const c = grid.clip();
          if (!c || !grid.commit()) return;
          const at = grid.sel().c0;
          for (let i = 0; i <= c.range.c1 - c.range.c0; i++) {
            const w = wb.sheets[c.sheet].colW.get(c.range.c0 + i);
            wb.setSize(wb.active, 'col', at + i, w ?? null);
          }
          onChange();
        } },
      ], r.left, r.bottom, { returnFocus: pasteMenuBtn });
    }, 'text-rb');

    const cellStylesBtn = btn('Cell styles ▾', 'Cell styles: Good, Bad, Neutral, headings, totals, accents', () => {
      const r = cellStylesBtn.getBoundingClientRect();
      shell.menus.show([
        { label: 'Normal (no formatting)', action: () => {
          if (!grid.commit()) return;
          try {
            wb.clearFormats(wb.active, grid.sel());
            grid.fitRows();
            onChange();
          } catch (error) {
            void report(error);
          }
        } },
        { separator: true },
        ...CELL_STYLES.map(cs => ({
          label: cs.label,
          // The style's look over the cell's own, keeping its number format and alignment.
          action: () => doStyle(s => ({ fmt: s.fmt, code: s.code, dec: s.dec, al: s.al, va: s.va, wrap: s.wrap, ind: s.ind, ...cs.look })),
        })),
      ], r.left, r.bottom, { returnFocus: cellStylesBtn });
    }, 'text-rb');

    const wrapBtn = btn('Wrap Text', 'Wrap text: show long text and line breaks on several lines (Alt+Enter starts a new line while typing)', () => doStyle(s => ({ ...s, wrap: activeStyle().wrap ? undefined : true })), 'text-rb');

    let palette: HTMLElement | null = null;
    const closePalette = () => {
      palette?.remove();
      palette = null;
    };
    const paletteButton = (text: string, title: string, key: 'fill' | 'color', swatch: string): HTMLButtonElement => {
      const b = h('button', { type: 'button', class: 'rb wide-rb', title, 'aria-label': title, 'aria-haspopup': 'true' }, h('span', { class: 'rb-a' }, text), h('span', { class: 'rb-swatch', 'data-colour': swatch }), h('span', { class: 'rb-caret', 'aria-hidden': 'true' }, '▾'));
      css(b.querySelector<HTMLElement>('.rb-swatch')!, { background: swatch });
      on(b, 'click', () => {
        if (palette) {
          closePalette();
          return;
        }
        const box = h('div', { class: 'palette', role: 'menu', 'aria-label': title });
        const none = h('button', { type: 'button', class: 'palette-none', role: 'menuitem' }, key === 'fill' ? 'No fill' : 'Automatic (black)');
        on(none, 'click', () => {
          closePalette();
          doStyle(s => ({ ...s, [key]: undefined }));
          grid.focus();
        }, app.signal);
        box.append(none);
        const swatches = h('div', { class: 'palette-grid' });
        for (const [name, hex] of PALETTE) {
          const sw = h('button', { type: 'button', class: 'palette-sw', role: 'menuitem', title: name, 'aria-label': name });
          css(sw, { background: hex });
          on(sw, 'click', () => {
            closePalette();
            doStyle(s => ({ ...s, [key]: hex }));
            const marker = b.querySelector<HTMLElement>('.rb-swatch');
            if (marker) css(marker, { background: hex });
            grid.focus();
          }, app.signal);
          swatches.append(sw);
        }
        box.append(swatches);
        // On the window, not in the ribbon (the ribbon scrolls sideways when narrow, and would cut the box off).
        app.root.append(box);
        const r = b.getBoundingClientRect();
        const host = app.root.getBoundingClientRect();
        css(box, { left: Math.max(0, Math.min(r.left - host.left, host.width - 190)), top: r.bottom - host.top });
        palette = box;
      }, app.signal);
      return b;
    };
    const fillBtn = paletteButton('A', 'Fill colour', 'fill', '#ffd400');
    const colorBtn = paletteButton('A', 'Text colour', 'color', '#d13438');

    /** A style change that depends on where each cell is in the selection (its outer edges): borders. One Undo. */
    const edgeStyle = (fn: (s: CellStyle, edge: { t: boolean; b: boolean; l: boolean; r: boolean }) => CellStyle) => {
      if (!grid.commit()) return;
      const sel = grid.sel();
      try {
        // One step: a single Undo takes the whole border back.
        wb.batch(() => {
          for (let row = sel.r0; row <= sel.r1; row++) {
            for (let col = sel.c0; col <= sel.c1; col++) {
              wb.setStyle(wb.active, { c0: col, r0: row, c1: col, r1: row }, s => fn(s, { t: row === sel.r0, b: row === sel.r1, l: col === sel.c0, r: col === sel.c1 }));
            }
          }
        });
        onChange();
      } catch (error) {
        void report(error);
      }
    };
    const bordersBtn = h('button', { type: 'button', class: 'rb wide-rb', title: 'Borders', 'aria-label': 'Borders', 'aria-haspopup': 'true' }, h('span', { class: 'rb-a' }, '▦'), h('span', { class: 'rb-caret', 'aria-hidden': 'true' }, '▾'));
    on(bordersBtn, 'click', () => {
      const r = bordersBtn.getBoundingClientRect();
      const set = edgeStyle;
      // Every line drawn takes the border colour chosen below (black when Automatic).
      const pen = (s: CellStyle): CellStyle => ({ ...s, bc: penColour });
      const edges = (line: Line, which: Array<'t' | 'b' | 'l' | 'r'>) => set((s, e) => {
        const out = pen(s);
        if (which.includes('t') && e.t) out.bt = line;
        if (which.includes('b') && e.b) out.bb = line;
        if (which.includes('l') && e.l) out.bl = line;
        if (which.includes('r') && e.r) out.br = line;
        return out;
      });
      const items: MenuItem[] = [
        { label: 'Bottom border', action: () => edges(true, ['b']) },
        { label: 'Top border', action: () => edges(true, ['t']) },
        { label: 'Left border', action: () => edges(true, ['l']) },
        { label: 'Right border', action: () => edges(true, ['r']) },
        { separator: true },
        { label: 'No borders', action: () => set(s => ({ ...s, bt: undefined, bb: undefined, bl: undefined, br: undefined, bc: undefined })) },
        { label: 'All borders', action: () => set(s => ({ ...pen(s), bt: true, bb: true, bl: true, br: true })) },
        { label: 'Outside borders', action: () => edges(true, ['t', 'b', 'l', 'r']) },
        { label: 'Thick outside borders', action: () => edges('medium', ['t', 'b', 'l', 'r']) },
        { separator: true },
        { label: 'Double bottom border', action: () => edges('double', ['b']) },
        { label: 'Thick bottom border', action: () => edges('medium', ['b']) },
        { label: 'Top and bottom border', action: () => edges(true, ['t', 'b']) },
        { label: 'Top and thick bottom border', action: () => set((s, e) => ({ ...pen(s), bt: e.t ? true : s.bt, bb: e.b ? 'medium' : s.bb })) },
        { label: 'Top and double bottom border', action: () => set((s, e) => ({ ...pen(s), bt: e.t ? true : s.bt, bb: e.b ? 'double' : s.bb })) },
        { separator: true },
        {
          label: 'Line colour',
          submenu: [
            { label: 'Automatic (black)', checked: !penColour, action: () => { penColour = undefined; } },
            ...PALETTE.filter(([, hex]) => hex !== '#ffffff').map(([name, hex]) => ({ label: name, checked: penColour === hex, action: () => { penColour = hex; } })),
          ],
        },
      ];
      shell.menus.show(items, r.left, r.bottom, { returnFocus: bordersBtn });
    }, app.signal);
    let penColour: string | undefined;

    // Merge: one cell made of several. Only the top-left value is kept, so the person is asked when others would go.
    const mergeBtn = btn('Merge ▾', 'Merge cells into one (Merge & Center, Merge across, Unmerge)', () => {
      const r = mergeBtn.getBoundingClientRect();
      const doMerge = async (how: 'center' | 'all' | 'across') => {
        if (!grid.commit()) return;
        const range = grid.sel();
        if (range.c0 === range.c1 && (how === 'across' || range.r0 === range.r1)) {
          await shell.dialogs.alert('Select more than one cell', how === 'across' ? 'Merge across joins the cells of each selected row: select two or more columns.' : 'Select the cells to join into one, then choose Merge again.');
          return;
        }
        if (wb.mergeWouldLose(wb.active, range, how === 'across')) {
          const ok = await shell.dialogs.confirm({ title: 'Merge these cells?', text: 'Merging keeps only the value in the top-left cell; the others are cleared. You can undo this with Ctrl+Z.', ok: 'Merge' });
          if (!ok) return;
        }
        try {
          wb.merge(wb.active, range, how);
          grid.select(wb.growToMerges(wb.active, range), { col: range.c0, row: range.r0 });
          onChange();
        } catch (error) {
          void report(error);
        }
        grid.focus();
      };
      const s = grid.sel();
      const anyMerged = wb.sheets[wb.active].merges.some(m => m.c0 <= s.c1 && m.c1 >= s.c0 && m.r0 <= s.r1 && m.r1 >= s.r0);
      shell.menus.show([
        { label: 'Merge & Center', action: () => void doMerge('center') },
        { label: 'Merge across (each row)', action: () => void doMerge('across') },
        { label: 'Merge cells', action: () => void doMerge('all') },
        { label: 'Unmerge cells', disabled: !anyMerged, action: () => {
          wb.unmerge(wb.active, grid.sel());
          onChange();
        } },
      ], r.left, r.bottom, { returnFocus: mergeBtn });
    }, 'text-rb');

    // Freeze panes: rows above and columns left of the active cell stay in view while the rest scrolls.
    const freezeBtn = btn('Freeze ▾', 'Freeze panes: keep rows and columns in view while the rest scrolls', () => {
      const r = freezeBtn.getBoundingClientRect();
      const f = wb.sheets[wb.active].freeze;
      const set = (rows: number, cols: number) => {
        if (!grid.commit()) return;
        wb.setFreeze(wb.active, rows, cols);
        grid.goTo(grid.active().col, grid.active().row);
        onChange();
      };
      const a = grid.active();
      shell.menus.show([
        { label: a.row || a.col ? `Freeze panes (above row ${a.row + 1}${a.col ? `, left of column ${colName(a.col)}` : ''})` : 'Freeze panes (select the cell below and right of what to keep)', disabled: !a.row && !a.col, action: () => set(a.row, a.col) },
        { label: 'Freeze top row', action: () => set(1, 0) },
        { label: 'Freeze first column', action: () => set(0, 1) },
        { separator: true },
        { label: 'Unfreeze panes', disabled: !f.rows && !f.cols, action: () => set(0, 0) },
      ], r.left, r.bottom, { returnFocus: freezeBtn });
    }, 'text-rb');

    // Ready-made formats that are format codes underneath (the short and long date follow this computer's order).
    const presetCodes: Record<string, string> = {
      shortdate: shortDateCode(wb.dateOrder), longdate: longDateCode(wb.dateOrder), time: 'h:mm:ss AM/PM', scientific: '0.00E+00', fraction: '# ?/?',
    };
    const customOption = h('option', { value: 'custom', hidden: true }, 'Custom');
    const fmtSelect = h('select', { class: 'rb-select', 'aria-label': 'Number format', title: 'Number format' },
      h('option', { value: '' }, 'General'), h('option', { value: 'number' }, 'Number'), h('option', { value: 'currency' }, 'Currency'),
      h('option', { value: 'comma' }, 'Comma'), h('option', { value: 'percent' }, 'Percent'),
      h('option', { value: 'shortdate' }, 'Short date'), h('option', { value: 'longdate' }, 'Long date'), h('option', { value: 'time' }, 'Time'),
      h('option', { value: 'scientific' }, 'Scientific'), h('option', { value: 'fraction' }, 'Fraction'), h('option', { value: 'text' }, 'Text'),
      customOption, h('option', { value: 'more' }, 'More formats...'));
    on(fmtSelect, 'change', () => {
      const v = fmtSelect.value;
      if (v === 'more') {
        syncToolbar();
        void moreFormats();
        return;
      }
      if (v === 'custom') return;
      const code = presetCodes[v];
      doStyle(s => (code ? { ...s, fmt: 'custom', code, dec: undefined } : { ...s, fmt: (v || undefined) as CellStyle['fmt'], code: undefined, dec: undefined }));
      grid.focus();
    }, app.signal);
    const decimals = (d: number) => doStyle(s => {
      // A format code gets a place more or less in its number parts; a date or time is left as it is.
      if (s.fmt === 'custom' && s.code) return isDateCode(s.code) ? s : { ...s, code: shiftDecimals(s.code, d) };
      const current = s.dec ?? (s.fmt === 'percent' ? 0 : s.fmt ? 2 : 0);
      const next = Math.max(0, Math.min(15, current + d));
      return { ...s, fmt: s.fmt ?? 'number', dec: next };
    });

    /** More number formats: type any Excel format code (or pick one), with a sample of the selected cell. */
    async function moreFormats(): Promise<void> {
      if (!grid.commit()) return;
      const a = grid.active();
      const current = activeStyle();
      const v = wb.value(wb.active, a.col, a.row);
      const input = h('input', { type: 'text', class: 'field', value: current.fmt === 'custom' && current.code ? current.code : '0.00', autocomplete: 'off', spellcheck: false, 'aria-label': 'Format code' });
      const list = h('select', { class: 'field fmt-list', size: 8, 'aria-label': 'Common formats' }, ...COMMON_CODES.map(c => h('option', { value: c }, c)));
      const sample = h('output', { class: 'fmt-sample' });
      const problem = h('p', { class: 'dialog-problem', role: 'alert' });
      const check = () => {
        const why = codeProblem(input.value);
        problem.textContent = why ?? '';
        if (why) {
          sample.textContent = '';
          return false;
        }
        // The selected cell, or a sample number (a date's for a date format) when it is empty.
        const shownValue = v === null || v instanceof CellError ? (isDateCode(input.value) ? 46308.6041666667 : -1234.5678) : v;
        sample.textContent = formatCode(shownValue, input.value).text;
        return true;
      };
      const done = new AbortController();
      on(list, 'change', () => {
        input.value = list.value;
        check();
      }, done.signal);
      on(input, 'input', check, done.signal);
      check();
      const answer = await shell.dialogs.ask<boolean>({
        title: 'More number formats',
        body: h('div', { class: 'fmt-dialog' },
          h('label', { class: 'dialog-label' }, 'Format code (as Excel writes it)', input),
          h('p', { class: 'fmt-sample-row' }, 'Sample: ', sample),
          h('label', { class: 'dialog-label' }, 'Common formats', list),
          problem),
        buttons: [{ label: 'OK', value: true, primary: true }, { label: 'Cancel', value: false }],
        cancel: false,
        primaryEnabled: check,
        focus: () => input,
      });
      done.abort();
      if (answer && !codeProblem(input.value)) doStyle(s => ({ ...s, fmt: 'custom', code: input.value, dec: undefined }));
      grid.focus();
    }

    const insertBtn = btn('Insert ▾', 'Insert rows or columns', () => {
      const r = insertBtn.getBoundingClientRect();
      shell.menus.show([
        { label: 'Insert row above', action: () => grid.insert('row') },
        { label: 'Insert column left', action: () => grid.insert('col') },
      ], r.left, r.bottom, { returnFocus: insertBtn });
    }, 'text-rb');
    const deleteBtn = btn('Delete ▾', 'Delete rows or columns', () => {
      const r = deleteBtn.getBoundingClientRect();
      shell.menus.show([
        { label: 'Delete row', action: () => grid.remove('row') },
        { label: 'Delete column', action: () => grid.remove('col') },
        { separator: true },
        { label: 'Clear contents', hint: 'Del', action: () => grid.deleteContents() },
      ], r.left, r.bottom, { returnFocus: deleteBtn });
    }, 'text-rb');

    const sortRegion = (ascending: boolean) => {
      if (!grid.commit()) return;
      const s = grid.sel();
      const a = grid.active();
      let range: Range = s;
      const filled = (c: number, r: number) => wb.value(wb.active, c, r) !== null;
      const inTable = wb.tableAt(wb.active, a.col, a.row);
      if (inTable && s.c0 === s.c1 && s.r0 === s.r1) {
        // In a table: its data rows (the header and total rows stay where they are).
        const dr = tableData(inTable);
        try {
          if (dr.r1 > dr.r0) wb.sortRange(wb.active, { c0: inTable.range.c0, c1: inTable.range.c1, r0: dr.r0, r1: dr.r1 }, a.col, ascending);
          onChange();
        } catch (error) {
          void report(error);
        }
        return;
      }
      if (s.c0 === s.c1 && s.r0 === s.r1) {
        // One cell: sort the block of data around it.
        let { c0, r0, c1, r1 } = s;
        const rowFilled = (r: number) => { for (let c = c0; c <= c1; c++) if (filled(c, r)) return true; return false; };
        const colFilled = (c: number) => { for (let r = r0; r <= r1; r++) if (filled(c, r)) return true; return false; };
        for (let grew = true; grew; ) {
          grew = false;
          if (r0 > 0 && rowFilled(r0 - 1)) { r0--; grew = true; }
          if (r1 < 4999 && rowFilled(r1 + 1)) { r1++; grew = true; }
          if (c0 > 0 && colFilled(c0 - 1)) { c0--; grew = true; }
          if (c1 < 255 && colFilled(c1 + 1)) { c1++; grew = true; }
        }
        range = { c0, r0, c1, r1 };
      }
      // A first row of words above numbers is a heading: it stays where it is.
      const rowValues = (r: number) => { const v = []; for (let c = range.c0; c <= range.c1; c++) v.push(wb.value(wb.active, c, r)); return v; };
      const first = rowValues(range.r0);
      const second = range.r1 > range.r0 ? rowValues(range.r0 + 1) : [];
      const headerLike = first.some(v => typeof v === 'string') && first.every(v => v === null || typeof v === 'string') && second.some(v => typeof v === 'number');
      if (headerLike) range = { ...range, r0: range.r0 + 1 };
      if (range.r1 <= range.r0) return;
      try {
        wb.sortRange(wb.active, range, a.col, ascending);
        onChange();
      } catch (error) {
        void report(error);
      }
    };

    // ---- Filter ----------------------------------------------------------------------------------------------------

    /** Filter on or off (Ctrl+Shift+L). On: the table around the active cell (or the selected block) gets ▾ buttons. */
    function toggleFilter(): void {
      if (!grid.commit()) return;
      const sheet = wb.sheets[wb.active];
      try {
        if (sheet.filter) {
          wb.setFilter(wb.active, null);
          shell.toast('Filter off: every row shows again.');
        } else {
          const s = grid.sel();
          const a = grid.active();
          const range = s.r1 > s.r0 && s.r1 < 4999 ? s : wb.currentRegion(wb.active, a.col, a.row);
          if (wb.value(wb.active, a.col, a.row) === null && range.r0 === range.r1 && range.c0 === range.c1) {
            void shell.dialogs.alert('Nothing to filter here', 'Click a cell in a table (a header row with rows of data under it), then turn Filter on.');
            return;
          }
          wb.setFilter(wb.active, range);
          grid.goTo(range.c0, range.r0);
        }
        onChange();
      } catch (error) {
        void report(error);
      }
    }

    let filterBox: HTMLElement | null = null;
    const closeFilter = () => {
      filterBox?.remove();
      filterBox = null;
    };

    /** The ▾ list on a filter header: sort, a search box, and a tick for each value; OK keeps the ticked rows in view. */
    function openFilter(col: number, x: number, y: number): void {
      closeFilter();
      const f = wb.sheets[wb.active].filter;
      if (!f) return;
      const heading = wb.display(wb.active, col, f.range.r0) || `Column ${colName(col)}`;
      const values = wb.filterValues(wb.active, col);
      const kept = f.cols.get(col);
      const ruled = f.rules?.has(col) ?? false;
      const keptSet = kept ? new Set(kept.map(k => k.toLowerCase())) : null;
      const done = new AbortController();
      const close = () => {
        done.abort();
        closeFilter();
        grid.focus();
      };
      const sortBtn = (asc: boolean) => {
        const b = h('button', { type: 'button', class: 'filter-action' }, asc ? 'Sort A to Z (smallest first)' : 'Sort Z to A (largest first)');
        on(b, 'click', () => {
          try {
            wb.sortFilter(wb.active, col, asc);
            onChange();
          } catch (error) {
            void report(error);
          }
          close();
        }, done.signal);
        return b;
      };
      const clear = h('button', { type: 'button', class: 'filter-action', disabled: !kept && !ruled }, `Clear filter from “${heading.slice(0, 30)}”`);
      // Number filters or Text filters (by what the column mostly holds): a menu of conditions, each with its own screen.
      const ruleItems = filterRuleMenu(ctx, col);
      const numeric = ruleItems.some(it => 'label' in it && it.label === 'Top 10...');
      const rulesBtn = h('button', { type: 'button', class: 'filter-action', 'aria-haspopup': 'true' }, `${numeric ? 'Number' : 'Text'} filters ▸${ruled ? ' (on)' : ''}`);
      on(rulesBtn, 'click', () => {
        const r = rulesBtn.getBoundingClientRect();
        close();
        shell.menus.show(ruleItems, r.right, r.top);
      }, done.signal);
      on(clear, 'click', () => {
        wb.filterBy(wb.active, col, null);
        onChange();
        close();
      }, done.signal);
      const search = h('input', { type: 'search', class: 'field filter-search', placeholder: 'Search', 'aria-label': 'Search the values', autocomplete: 'off', spellcheck: false });
      const all = h('input', { type: 'checkbox' });
      const ticks = values.map(v => {
        const box = h('input', { type: 'checkbox' });
        box.checked = !keptSet || keptSet.has(v.toLowerCase());
        const row = h('label', { class: 'filter-value' }, box, h('span', {}, v === '' ? '(Blanks)' : v));
        return { v, box, row };
      });
      const list = h('div', { class: 'filter-list', role: 'group', 'aria-label': `Values in ${heading}` }, h('label', { class: 'filter-value filter-all' }, all, h('span', {}, '(Select all)')), ...ticks.map(t => t.row));
      const ok = h('button', { type: 'button', class: 'btn primary' }, 'OK');
      const cancel = h('button', { type: 'button', class: 'btn' }, 'Cancel');
      const shown = () => ticks.filter(t => !t.row.hidden);
      const sync = () => {
        const visible = shown();
        all.checked = visible.length > 0 && visible.every(t => t.box.checked);
        all.indeterminate = !all.checked && visible.some(t => t.box.checked);
        // As in Excel, OK needs at least one value ticked (none ticked would hide every row).
        ok.disabled = !ticks.some(t => t.box.checked && !t.row.hidden);
      };
      on(all, 'change', () => {
        for (const t of shown()) t.box.checked = all.checked;
        sync();
      }, done.signal);
      for (const t of ticks) on(t.box, 'change', sync, done.signal);
      on(search, 'input', () => {
        const q = search.value.trim().toLowerCase();
        for (const t of ticks) {
          t.row.hidden = q !== '' && !(t.v === '' ? '(blanks)' : t.v.toLowerCase()).includes(q);
          // Searching ticks what it finds, as Excel's search box does.
          if (q) t.box.checked = !t.row.hidden;
        }
        sync();
      }, done.signal);
      on(ok, 'click', () => {
        const keep = ticks.filter(t => t.box.checked && !t.row.hidden).map(t => t.v);
        try {
          wb.filterBy(wb.active, col, keep.length === values.length ? null : keep);
          const a = grid.active();
          if (wb.sheets[wb.active].hiddenRows.has(a.row)) grid.goTo(col, f.range.r0);
          onChange();
        } catch (error) {
          void report(error);
        }
        close();
      }, done.signal);
      on(cancel, 'click', close, done.signal);
      const box = h('div', { class: 'filter-box', role: 'dialog', 'aria-label': `Filter ${heading}` },
        sortBtn(true), sortBtn(false), clear, rulesBtn, search, list, h('div', { class: 'filter-buttons' }, ok, cancel));
      on(box, 'keydown', (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close();
        } else if (event.key === 'Enter' && event.target === search && !ok.disabled) {
          event.preventDefault();
          ok.click();
        }
      }, done.signal);
      // A click outside closes it: listened for from the next turn, or the click that opened it would close it at once.
      setTimeout(() => {
        if (done.signal.aborted) return;
        on(document, 'pointerdown', (event: PointerEvent) => {
          if (event.target instanceof Node && !box.contains(event.target)) close();
        }, done.signal);
      }, 0);
      app.root.append(box);
      const host = app.root.getBoundingClientRect();
      css(box, { left: Math.max(0, Math.min(x - host.left, host.width - 260)), top: Math.max(0, Math.min(y - host.top, host.height - 340)) });
      filterBox = box;
      sync();
      search.focus();
    }
    grid.onFilterButton = openFilter;

    // ---- Find and replace ------------------------------------------------------------------------------------------

    let findPanel: HTMLElement | null = null;

    /** Find (Ctrl+F) and Replace (Ctrl+H): a panel over the grid that stays open while the person works. */
    function openFind(replace: boolean): void {
      if (!grid.commit()) return;
      if (findPanel) {
        findPanel.dispatchEvent(new CustomEvent('find-mode', { detail: replace }));
        return;
      }
      const done = new AbortController();
      const what = h('input', { type: 'text', class: 'field', 'aria-label': 'Find what', autocomplete: 'off', spellcheck: false });
      const by = h('input', { type: 'text', class: 'field', 'aria-label': 'Replace with', autocomplete: 'off', spellcheck: false });
      const matchCase = h('input', { type: 'checkbox' });
      const whole = h('input', { type: 'checkbox' });
      const within = h('select', { class: 'field', 'aria-label': 'Within' }, h('option', { value: 'sheet' }, 'This sheet'), h('option', { value: 'book' }, 'Every sheet'));
      const lookIn = h('select', { class: 'field', 'aria-label': 'Look in' }, h('option', { value: 'values' }, 'Values (what cells show)'), h('option', { value: 'formulas' }, 'Formulas (what is typed)'));
      const status = h('p', { class: 'find-status', role: 'status', 'aria-live': 'polite' });
      const next = h('button', { type: 'button', class: 'btn primary' }, 'Find next');
      const one = h('button', { type: 'button', class: 'btn' }, 'Replace');
      const every = h('button', { type: 'button', class: 'btn' }, 'Replace all');
      const closeBtn = h('button', { type: 'button', class: 'btn' }, 'Close');
      const byRow = h('label', { class: 'find-row' }, h('span', {}, 'Replace with'), by);
      const lookRow = h('label', { class: 'find-row' }, h('span', {}, 'Look in'), lookIn);
      const panel = h('div', { class: 'find-panel', role: 'dialog', 'aria-label': 'Find and replace' },
        h('label', { class: 'find-row' }, h('span', {}, 'Find what'), what),
        byRow,
        h('div', { class: 'find-options' },
          h('label', {}, matchCase, ' Match case'),
          h('label', {}, whole, ' Match the whole cell'),
          h('label', { class: 'find-row' }, h('span', {}, 'Within'), within),
          lookRow),
        h('p', { class: 'find-hint' }, '* stands for any run of characters, ? for any one; ~* finds a star.'),
        status,
        h('div', { class: 'find-buttons' }, next, one, every, closeBtn));
      let replacing = replace;
      const mode = (r: boolean) => {
        replacing = r;
        byRow.hidden = !r;
        one.hidden = !r;
        every.hidden = !r;
        // Replace works on what is typed in cells (as in Excel), so it always looks in formulas.
        lookRow.hidden = r;
        status.textContent = '';
        (r && what.value ? by : what).focus();
        what.select();
      };
      const opts = (): FindOptions => ({
        text: what.value, matchCase: matchCase.checked, wholeCell: whole.checked,
        lookIn: replacing ? 'formulas' : (lookIn.value as 'values' | 'formulas'), allSheets: within.value === 'book',
      });
      /** Every match in view (cells in hidden rows and columns are skipped). */
      const matches = (): Found[] => wb.findAll(wb.active, opts()).filter(m => !wb.sheets[m.s].hiddenRows.has(m.row) && !wb.sheets[m.s].hiddenCols.has(m.col));
      const goTo = (m: Found) => {
        if (m.s !== wb.active) {
          grid.setActiveSheet(m.s);
          drawTabs();
        }
        grid.goTo(m.col, m.row);
      };
      const findNext = (): Found | null => {
        if (!what.value) {
          status.textContent = 'Type what to find.';
          return null;
        }
        const list = matches();
        if (!list.length) {
          status.textContent = `Nothing found for “${what.value}”.`;
          return null;
        }
        // The next match after the active cell (sheets in order from this one, then rows, then columns), round to the first.
        const a = grid.active();
        const order = (m: Found) => ((m.s - wb.active + wb.sheets.length) % wb.sheets.length) * 1e9 + m.row * 1000 + m.col;
        const here = a.row * 1000 + a.col;
        const hit = list.find(m => order(m) > here) ?? list[0];
        goTo(hit);
        status.textContent = `${list.indexOf(hit) + 1} of ${list.length.toLocaleString()} ${list.length === 1 ? 'match' : 'matches'}.`;
        return hit;
      };
      on(next, 'click', () => void findNext(), done.signal);
      on(one, 'click', () => {
        const a = grid.active();
        const isMatch = matches().some(m => m.s === wb.active && m.col === a.col && m.row === a.row);
        if (isMatch) {
          if (wb.replaceOne(wb.active, a.col, a.row, opts(), by.value)) onChange();
          else status.textContent = 'That would break the formula in this cell, so it was left as it is.';
        }
        findNext();
      }, done.signal);
      on(every, 'click', () => {
        if (!what.value) {
          status.textContent = 'Type what to find.';
          return;
        }
        try {
          const r = wb.replaceAll(wb.active, opts(), by.value);
          onChange();
          status.textContent = r.changed
            ? `Replaced in ${r.changed.toLocaleString()} ${r.changed === 1 ? 'cell' : 'cells'}${r.skipped ? `; ${r.skipped} left as they were (the formula would break)` : ''}. Ctrl+Z takes it back.`
            : r.skipped ? `Nothing replaced: in ${r.skipped} ${r.skipped === 1 ? 'cell' : 'cells'} the formula would break.` : `Nothing found for “${what.value}”.`;
        } catch (error) {
          void report(error);
        }
      }, done.signal);
      const close = () => {
        done.abort();
        panel.remove();
        findPanel = null;
        grid.focus();
      };
      on(closeBtn, 'click', close, done.signal);
      on(panel, 'keydown', (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close();
        } else if (event.key === 'Enter' && (event.target === what || event.target === by)) {
          event.preventDefault();
          void findNext();
        } else if ((event.ctrlKey || event.metaKey) && !event.shiftKey && (event.key.toLowerCase() === 'f' || event.key.toLowerCase() === 'h')) {
          event.preventDefault();
          mode(event.key.toLowerCase() === 'h');
        }
        // Keys typed here stay here (Ctrl+B is not bold for the grid).
        event.stopPropagation();
      }, done.signal);
      on(panel, 'find-mode', ((event: CustomEvent<boolean>) => mode(event.detail)) as EventListener, done.signal);
      on(what, 'input', () => {
        status.textContent = '';
      }, done.signal);
      app.signal.addEventListener('abort', () => done.abort());
      findPanel = panel;
      app.root.append(panel);
      mode(replace);
    }

    const filterBtn = btn('Filter', 'Filter (Ctrl+Shift+L): ▾ buttons on the table\'s header row, to show only some rows', toggleFilter, 'text-rb');
    const findBtn = btn('Find ▾', 'Find (Ctrl+F) and Replace (Ctrl+H)', () => {
      const r = findBtn.getBoundingClientRect();
      shell.menus.show([
        { label: 'Find...', hint: 'Ctrl+F', action: () => openFind(false) },
        { label: 'Replace...', hint: 'Ctrl+H', action: () => openFind(true) },
      ], r.left, r.bottom, { returnFocus: findBtn });
    }, 'text-rb');

    /** A button that opens a menu under itself. */
    const menuBtn = (text: string, title: string, items: () => MenuItem[]): HTMLButtonElement => {
      const b = h('button', { type: 'button', class: 'rb text-rb', title, 'aria-label': title, 'aria-haspopup': 'true' }, text);
      on(b, 'click', () => {
        if (!grid.commit()) return;
        const r = b.getBoundingClientRect();
        shell.menus.show(items(), r.left, r.bottom, { returnFocus: b });
      }, app.signal);
      return b;
    };

    // Home > Styles: conditional formatting.
    const cfBtn = menuBtn('Conditional formatting ▾', 'Conditional formatting: colour cells by their values (highlight rules, top 10, data bars, colour scales)', () => conditionalMenu(ctx));

    // Insert > Charts: one button per kind, each with a small picture of it.
    const chartButtons = CHART_TYPES.map(t => {
      const kind = CHART_LABEL[t].toLowerCase();
      const title = `Insert ${/^[aeiou]/.test(kind) ? 'an' : 'a'} ${kind} chart of the selected cells`;
      const b = h('button', { type: 'button', class: 'rb chart-rb', title, 'aria-label': title }, chartIcon(t), h('span', {}, CHART_LABEL[t].replace(' (X Y)', '')));
      on(b, 'click', () => charts.insert(t), app.signal);
      return b;
    });

    // Page Layout: how the sheet prints.
    const page = () => pageOf(wb, wb.active);
    const marginsBtn = menuBtn('Margins ▾', 'Margins', () => [
      ...(['normal', 'wide', 'narrow'] as const).map(k => ({ label: `${k[0].toUpperCase()}${k.slice(1)}`, checked: marginName(page().margins) === k, action: () => setPage(ctx, p => ({ ...p, margins: { ...MARGINS[k] } })) })),
      { label: 'Custom margins...', checked: marginName(page().margins) === 'custom', action: () => void pageSetupDialog(ctx) },
    ]);
    const orientBtn = menuBtn('Orientation ▾', 'Orientation: portrait (tall) or landscape (wide)', () => (['portrait', 'landscape'] as const).map(o => ({
      label: o === 'portrait' ? 'Portrait' : 'Landscape', checked: page().orient === o, action: () => setPage(ctx, p => ({ ...p, orient: o })),
    })));
    const sizeBtn = menuBtn('Size ▾', 'Paper size', () => (Object.keys(PAPERS) as Paper[]).map(k => ({ label: PAPERS[k].label, checked: page().paper === k, action: () => setPage(ctx, p => ({ ...p, paper: k })) })));
    const areaBtn = menuBtn('Print area ▾', 'Print area: print only some of the cells', () => [
      { label: 'Set print area (the selected cells)', action: () => setPage(ctx, p => ({ ...p, area: grid.sel() })) },
      { label: 'Clear print area', disabled: !page().area, action: () => setPage(ctx, p => ({ ...p, area: null })) },
    ]);
    const scaleBtn = menuBtn('Scale ▾', 'Scale to fit: print smaller, to fit fewer pages', () => {
      const f = page().fit;
      return [
        { label: 'Actual size', checked: !f && page().scale === 100, action: () => setPage(ctx, p => ({ ...p, fit: null, scale: 100 })) },
        { label: 'Fit all columns on one page', checked: !!f && f.w === 1 && f.h === 0, action: () => setPage(ctx, p => ({ ...p, fit: { w: 1, h: 0 } })) },
        { label: 'Fit all rows on one page', checked: !!f && f.w === 0 && f.h === 1, action: () => setPage(ctx, p => ({ ...p, fit: { w: 0, h: 1 } })) },
        { label: 'Fit the sheet on one page', checked: !!f && f.w === 1 && f.h === 1, action: () => setPage(ctx, p => ({ ...p, fit: { w: 1, h: 1 } })) },
        { label: 'Custom scaling...', action: () => void pageSetupDialog(ctx) },
      ];
    });
    const gridPrintBtn = btn('Gridlines', 'Print gridlines', () => setPage(ctx, p => ({ ...p, gridlines: !p.gridlines })), 'text-rb');
    const headPrintBtn = btn('Headings', 'Print row and column headings (A, B, C and 1, 2, 3)', () => setPage(ctx, p => ({ ...p, headings: !p.headings })), 'text-rb');

    // Data: sort and filter again (as Excel has them on both tabs), and data validation.
    const filterBtn2 = btn('Filter', 'Filter (Ctrl+Shift+L): ▾ buttons on the table\'s header row, to show only some rows', toggleFilter, 'text-rb');
    const dvBtn = menuBtn('Data validation ▾', 'Data validation: what may be typed in the selected cells (a drop-down list, numbers in a range...)', () => [
      { label: 'Data validation...', action: () => void validationDialog(ctx) },
      { label: 'Clear validation from the selected cells', action: () => { wb.setValidation(wb.active, grid.sel(), null); onChange(); } },
    ]);

    // Formulas: functions by kind, names, and showing formulas instead of their answers.
    const fnMenu = (label: string, cat: Parameters<typeof functionMenu>[1]) => menuBtn(`${label} ▾`, `${cat} functions`, () => functionMenu(ctx, cat));
    const showFormulasBtn = btn('Show formulas', 'Show formulas in the cells instead of their answers (Ctrl+`)', () => toggleFormulas(), 'text-rb');
    function toggleFormulas(): void {
      grid.showFormulas = !grid.showFormulas;
      syncToolbar();
      grid.redraw();
    }

    // Review: notes on cells.
    /** Adds or changes the note on a cell: a box to type it in; an empty box takes the note off. */
    async function editNote(col: number, row: number): Promise<void> {
      if (!grid.commit()) return;
      const old = wb.sheets[wb.active].cells.get(keyOf(col, row))?.n ?? '';
      const box = h('textarea', { class: 'field note-text', 'aria-label': 'Note', maxlength: 32000 });
      box.value = old;
      const done = new AbortController();
      const answer = await shell.dialogs.ask<boolean>({
        title: `${old ? 'Edit the note on' : 'New note on'} ${addressOf(col, row)}`,
        body: h('div', {}, box, h('p', { class: 'dialog-detail' }, 'The note shows when the pointer is over the cell; a red corner marks the cell. Leave it empty to take the note off.')),
        buttons: [{ label: 'OK', value: true, primary: true }, { label: 'Cancel', value: false }],
        cancel: false,
        focus: () => box,
      });
      done.abort();
      if (answer) {
        try {
          wb.setNote(wb.active, col, row, box.value.replace(/\s+$/, '') || null);
          onChange();
        } catch (error) {
          void report(error);
        }
      }
      grid.focus();
    }
    grid.onNote = (col, row) => void editNote(col, row);
    const goNote = (step: 1 | -1) => {
      const notes = wb.notesOf(wb.active);
      if (!notes.length) {
        shell.toast('There are no notes on this sheet.');
        return;
      }
      const a = grid.active();
      const at = (n: { row: number; col: number }) => n.row * 1000 + n.col;
      const here = a.row * 1000 + a.col;
      const next = step > 0 ? notes.find(n => at(n) > here) ?? notes[0] : [...notes].reverse().find(n => at(n) < here) ?? notes[notes.length - 1];
      grid.goTo(next.col, next.row);
    };
    const showNotesBtn = btn('Show all notes', 'Show every note beside its cell', () => {
      grid.showNotes = !grid.showNotes;
      syncToolbar();
      grid.redraw();
    }, 'text-rb');
    // Format Cells (Ctrl+1), and Home > Cells > Format: row height, column width, hiding, and Format Cells.
    const formatCells = (first?: Parameters<typeof formatCellsDialog>[2]) => void formatCellsDialog(ctx, { style: doStyle, edges: edgeStyle, palette: PALETTE }, first);
    grid.onFormatCells = () => formatCells();
    const sizeDialog = async (axis: 'row' | 'col') => {
      if (!grid.commit()) return;
      const sel = grid.sel();
      const sheet = wb.sheets[wb.active];
      const now = axis === 'row' ? (sheet.rowH.get(sel.r0) ?? 20) * 0.75 : ((sheet.colW.get(sel.c0) ?? 64) - 5) / 7;
      const v = await shell.dialogs.prompt({
        title: axis === 'row' ? 'Row height' : 'Column width',
        label: axis === 'row' ? 'Row height in points (15 is the standard)' : 'Column width in characters (8.43 is the standard)',
        value: String(Math.round(now * 100) / 100),
        ok: 'OK',
        check: x => {
          const n = Number(x);
          return Number.isFinite(n) && n >= 0 && n <= (axis === 'row' ? 409 : 255) ? null : axis === 'row' ? 'Type a height from 0 to 409 points.' : 'Type a width from 0 to 255 characters.';
        },
      });
      if (v === null) return;
      const n = Number(v);
      const [from, to] = axis === 'row' ? [sel.r0, Math.min(sel.r1, sel.r0 + 4999)] : [sel.c0, sel.c1];
      for (let i = from; i <= to; i++) {
        if (n === 0) continue;
        wb.setSize(wb.active, axis, i, axis === 'row' ? n / 0.75 : n * 7 + 5);
      }
      // 0 hides them, as in Excel.
      if (n === 0) wb.setHidden(wb.active, axis, from, to, true);
      grid.fitRows();
      onChange();
    };
    const formatBtn = menuBtn('Format ▾', 'Format: row height, column width, hide and unhide, Format cells', () => [
      { label: 'Row height...', action: () => void sizeDialog('row') },
      { label: 'AutoFit row height', action: () => {
        const sel = grid.sel();
        for (let r = sel.r0; r <= Math.min(sel.r1, sel.r0 + 4999); r++) wb.setSize(wb.active, 'row', r, null);
        grid.fitRows();
        onChange();
      } },
      { label: 'Column width...', action: () => void sizeDialog('col') },
      { label: 'AutoFit column width', action: () => {
        const sel = grid.sel();
        grid.fitColumns(sel.c0, sel.c1);
        onChange();
      } },
      { separator: true },
      { label: 'Hide and unhide', submenu: [
        { label: 'Hide rows', action: () => grid.hide('row', true) },
        { label: 'Hide columns', action: () => grid.hide('col', true) },
        { label: 'Unhide rows', action: () => grid.hide('row', false) },
        { label: 'Unhide columns', action: () => grid.hide('col', false) },
      ] },
      { separator: true },
      { label: 'Format cells...', hint: 'Ctrl+1', action: () => formatCells() },
    ]);

    // View: the same switches as on the Formulas and Review tabs, and the sheet's gridlines on screen.
    const viewNotesBtn = btn('Notes', 'Show every note beside its cell', () => showNotesBtn.click(), 'text-rb');
    const viewFormulasBtn = btn('Formulas', 'Show formulas in the cells instead of their answers (Ctrl+`)', () => toggleFormulas(), 'text-rb');
    const gridlinesBtn = btn('Gridlines', 'Show the lines between cells on this sheet', () => {
      wb.setGridlines(wb.active, !!wb.sheets[wb.active].noGrid);
      onChange();
    }, 'text-rb');

    const tabGroups = {
      home: [
        sized(36, group('Undo', undoBtn, redoBtn)),
        sized(190, group('Clipboard', btn('Paste', 'Paste (Ctrl+V)', () => grid.paste(), 'text-rb'), pasteMenuBtn, btn('Cut', 'Cut (Ctrl+X)', () => grid.copy(true), 'text-rb'), btn('Copy', 'Copy (Ctrl+C)', () => grid.copy(false), 'text-rb'), painterBtn)),
        sized(240, group('Font', faceSelect, sizeBox, sizeList, growBtn, shrinkBtn, boldBtn, italicBtn, underBtn, strikeBtn, bordersBtn, fillBtn, colorBtn)),
        sized(185, group('Alignment', ...vaBtns, wrapBtn, ...alignBtns, mergeBtn, indentOut, indentIn)),
        sized(150, group('Number', fmtSelect, btn('$', 'Currency format', () => doStyle(s => ({ ...s, fmt: 'currency', dec: 2 }))), btn('%', 'Percent format', () => doStyle(s => ({ ...s, fmt: 'percent', dec: 0 }))), btn(',', 'Comma format', () => doStyle(s => ({ ...s, fmt: 'comma', dec: 2 }))), btn('.0→', 'More decimal places', () => decimals(1)), btn('←.0', 'Fewer decimal places', () => decimals(-1)))),
        sized(200, group('Styles', cfBtn, menuBtn('Format as table ▾', 'Format as table: make the cells a table in a ready-made style', () => formatAsTableMenu(ctx)), cellStylesBtn)),
        sized(90, group('Cells', insertBtn, deleteBtn, formatBtn)),
        sized(180, group('Editing', btn('Σ AutoSum', 'AutoSum (Alt+=)', () => grid.autoSum(), 'text-rb'), clearBtn, btn('A→Z', 'Sort A to Z (or smallest first)', () => sortRegion(true), 'text-rb'), btn('Z→A', 'Sort Z to A (or largest first)', () => sortRegion(false), 'text-rb'), filterBtn, findBtn)),
      ],
      insert: [group('Tables',
        btn('PivotTable', 'Insert a PivotTable: sum up a table of data by its items', () => void insertPivotDialog(ctx, (s, col, row) => {
          grid.setActiveSheet(s);
          drawTabs();
          grid.goTo(col, row);
        }), 'text-rb'),
        btn('Table', 'Insert a table: column names, banded rows, filter buttons, a total row (Ctrl+T)', () => void insertTableDialog(ctx), 'text-rb')), group('Charts', ...chartButtons)],
      layout: [
        group('Page setup', marginsBtn, orientBtn, sizeBtn, areaBtn, btn('Print titles', 'Print titles: rows (or columns) printed again on every page', () => void pageSetupDialog(ctx), 'text-rb')),
        group('Scale to fit', scaleBtn),
        group('Sheet options', gridPrintBtn, headPrintBtn),
        group('Print', btn('Page setup...', 'Page setup: everything about how this sheet prints', () => void pageSetupDialog(ctx), 'text-rb'), btn('Print...', 'Print, with a preview of each page (Ctrl+P)', () => void printPreview(ctx), 'text-rb')),
      ],
      formulas: [
        sized(430, group('Function library',
          btn('fx Insert function', 'Insert function: find one by what it does (Shift+F3)', () => void insertFunctionDialog(ctx), 'text-rb'),
          menuBtn('Σ AutoSum ▾', 'AutoSum: sum, average, count, max or min of the figures above', () => autoSumMenu(ctx)),
          fnMenu('Financial', 'Financial'), fnMenu('Logical', 'Logical'), fnMenu('Text', 'Text'), fnMenu('Date and time', 'Date and time'),
          fnMenu('Lookup and reference', 'Lookup and reference'), fnMenu('Maths and trig', 'Maths and trig'),
          menuBtn('More ▾', 'More functions: statistical, information, engineering, lists', () => (['Statistical', 'Information', 'Engineering', 'Lists'] as const).map(c => ({ label: c, submenu: functionMenu(ctx, c) }))))),
        sized(250, group('Defined names',
          btn('Name manager', 'Name manager: every name, what it stands for (Ctrl+F3)', () => void nameManager(ctx), 'text-rb'),
          btn('Define name', 'Define name: a name for the selected cells, or for a value', () => void nameDialog(ctx), 'text-rb'),
          menuBtn('Use in formula ▾', 'Use a name in the formula you are typing', () => useInFormulaMenu(ctx)),
          btn('Create from selection', 'Create names from the labels in the selection\'s top row or left column', () => void createFromSelection(ctx), 'text-rb'))),
        group('Formula auditing', showFormulasBtn),
      ],
      data: [
        group('Queries', btn('Refresh all', 'Work every PivotTable of the workbook out again from its data', () => {
          if (!grid.commit()) return;
          const failed = wb.refreshAll();
          onChange();
          if (failed.length) void shell.dialogs.alert('Some PivotTables could not be refreshed', failed.join('\n'));
          else shell.toast('Every PivotTable is up to date.');
        }, 'text-rb')),
        group('Sort and filter',
          btn('A→Z', 'Sort A to Z (or smallest first)', () => sortRegion(true), 'text-rb'), btn('Z→A', 'Sort Z to A (or largest first)', () => sortRegion(false), 'text-rb'),
          btn('Sort...', 'Sort by several columns, each A to Z or Z to A', () => void sortDialog(ctx), 'text-rb'), filterBtn2,
          btn('Clear', 'Clear every column\'s filter (the ▾ buttons stay)', () => {
            if (!grid.commit()) return;
            wb.clearFilters(wb.active);
            onChange();
          }, 'text-rb')),
        group('Data tools',
          btn('Text to columns', 'Text to columns: split the text of one column at commas, tabs, spaces...', () => void textToColumnsDialog(ctx), 'text-rb'),
          btn('Remove duplicates', 'Remove duplicates: take out rows that repeat an earlier row', () => void removeDuplicatesDialog(ctx), 'text-rb'),
          dvBtn),
      ],
      review: [
        group('Notes',
          btn('New note', 'New note on the active cell, or edit its note (Shift+F2)', () => editNote(grid.active().col, grid.active().row), 'text-rb'),
          btn('Delete note', 'Delete the notes in the selected cells', () => {
            if (!grid.commit()) return;
            wb.clearNotes(wb.active, grid.sel());
            onChange();
          }, 'text-rb'),
          btn('Previous', 'Go to the previous note', () => goNote(-1), 'text-rb'),
          btn('Next', 'Go to the next note', () => goNote(1), 'text-rb'),
          showNotesBtn),
      ],
      view: [
        group('Show', gridlinesBtn, viewFormulasBtn, viewNotesBtn),
        group('Zoom', btn('100%', 'Zoom to 100%', () => grid.setZoom(1), 'text-rb'), btn('Zoom out', 'Zoom out', () => grid.setZoom(grid.zoom() / 1.1), 'text-rb'), btn('Zoom in', 'Zoom in', () => grid.setZoom(grid.zoom() * 1.1), 'text-rb')),
        group('Window', freezeBtn),
      ],
    };
    // Table Design: shown only while the active cell is in a table, as Excel's own tab for tables is.
    type Tab = keyof typeof tabGroups | 'table' | 'pivot';
    const TAB_ORDER: Tab[] = [...(Object.keys(tabGroups) as Tab[]), 'table', 'pivot'];
    const TAB_NAMES: Record<Tab, string> = { home: 'Home', insert: 'Insert', layout: 'Page Layout', formulas: 'Formulas', data: 'Data', review: 'Review', view: 'View', table: 'Table Design', pivot: 'PivotTable Analyze' };
    let tab: Tab = 'home';
    /** What the Table Design tab was last built for, so it is built again only when the table changes. */
    let tableKey = '';
    const groupsOf = (t: Tab): HTMLElement[] => {
      if (t === 'pivot') {
        const pv = activePivot(ctx);
        return pv ? pivotAnalyze(ctx, pv, btn, group, () => pivotPane.toggle()) : [];
      }
      if (t !== 'table') return tabGroups[t];
      const table = activeTable(ctx);
      return table ? tableDesign(ctx, table, btn, group, {
        pivot: () => void insertPivotDialog(ctx, (s, col, row) => {
          grid.setActiveSheet(s);
          drawTabs();
          grid.goTo(col, row);
        }),
        dups: () => void removeDuplicatesDialog(ctx),
      }) : [];
    };
    const ribbon = h('div', { class: 'ribbon', role: 'tabpanel', 'data-menus-stay': '' }, ...tabGroups.home);
    const tabButtons = TAB_ORDER.map(t => {
      const b = h('button', { type: 'button', class: `ribbon-tab${t === 'table' || t === 'pivot' ? ' context-tab' : ''}`, role: 'tab', 'aria-selected': String(t === 'home'), hidden: t === 'table' || t === 'pivot' }, TAB_NAMES[t]);
      on(b, 'click', () => showTab(t), app.signal);
      return b;
    });
    function showTab(t: Tab): void {
      tab = t;
      closePalette();
      tableKey = contextKey();
      ribbon.replaceChildren(...groupsOf(t));
      tabButtons.forEach((b, i) => b.setAttribute('aria-selected', String(TAB_ORDER[i] === t)));
      showBreaks();
      syncToolbar();
    }
    /** What the table or PivotTable tab shows, to know when to build it again. */
    function contextKey(): string {
      return tab === 'table' ? JSON.stringify(activeTable(ctx)) : tab === 'pivot' ? JSON.stringify(activePivot(ctx)) : '';
    }
    /**
     * The Table Design and PivotTable Analyze tabs follow the active cell: shown in a table (a PivotTable), rebuilt
     * when it changes, gone outside it. The PivotTable Fields pane does the same.
     */
    function syncTableTab(): void {
      const table = activeTable(ctx);
      const pv = activePivot(ctx);
      tabButtons[TAB_ORDER.indexOf('table')].hidden = !table;
      tabButtons[TAB_ORDER.indexOf('pivot')].hidden = !pv;
      if ((!table && tab === 'table') || (!pv && tab === 'pivot')) showTab('home');
      else if ((tab === 'table' || tab === 'pivot') && contextKey() !== tableKey) showTab(tab);
      pivotPane.sync();
    }
    grid.listFor = (col, row) => totalChoices(ctx, col, row);

    /** On the Page Layout tab, the grid shows where printed pages end (dashed lines), as Excel does. */
    function showBreaks(): void {
      if (tab !== 'layout') {
        if (grid.breaks) {
          grid.breaks = null;
          grid.redraw();
        }
        return;
      }
      const plan = planPages(wb, wb.active);
      const cols = new Set<number>();
      const rows = new Set<number>();
      for (const p of plan?.pages ?? []) {
        if (p.c0 > plan!.area.c0) cols.add(p.c0);
        if (p.r0 > plan!.area.r0) rows.add(p.r0);
        cols.add(p.c1 + 1);
        rows.add(p.r1 + 1);
      }
      grid.breaks = { cols: [...cols], rows: [...rows] };
      grid.redraw();
    }

    // ---- File menu -------------------------------------------------------------------------------------------------

    /** Which way round typed dates are read (3/4/2026 is 3 April day first, 4 March month first), kept for next time. */
    async function setDateOrder(order: DateOrder): Promise<void> {
      wb.dateOrder = order;
      presetCodes.shortdate = shortDateCode(order);
      presetCodes.longdate = longDateCode(order);
      syncToolbar();
      try {
        await shell.fs.writeText(SETTINGS_PATH, JSON.stringify({ dateOrder: order }), { hidden: true });
        shell.toast(`Dates you type are now read ${ORDER_LABEL[order].toLowerCase()}. Dates already in cells stay as they are.`);
      } catch (error) {
        await shell.report('This window reads dates that way now, but the choice could not be kept for next time', error);
      }
    }

    /** The workbook as the bytes of a file of this kind. */
    const fileBytes = async (as: 'sheet' | 'xlsx'): Promise<Uint8Array> => {
      if (as !== 'xlsx') return new TextEncoder().encode(wb.serialize());
      // Said each time: Excel gets a PivotTable's report as cells, not the PivotTable itself.
      if (wb.sheets.some(sh => sh.pivots.length)) shell.toast('PivotTables go into Excel files as the cells of their reports: Excel will not see them as PivotTables. A .sheet file keeps them working.');
      return saveXlsx(wb);
    };

    async function save(): Promise<boolean> {
      if (!grid.commit()) return false;
      if (!path) return saveAs();
      if (kind === 'xlsx' && lost) {
        // Saving over an Excel file would take out of it what this spreadsheet left out when opening it: asked first.
        const parts = lost.dropped.length ? lost.dropped.slice(0, 3).join('; ') + (lost.dropped.length > 3 ? '; and more' : '') : 'formulas kept as their last answer';
        const answer = await shell.dialogs.ask<'copy' | 'over' | null>({
          title: `Save over “${label}”?`,
          text: `When it was opened, some parts of this Excel file were left out (${parts}). Saving over the file takes them out of it for good.`,
          buttons: [{ label: 'Save a copy', value: 'copy', primary: true }, { label: 'Save over it', value: 'over', danger: true }, { label: 'Cancel', value: null }],
          cancel: null,
        });
        if (answer === null) return false;
        if (answer === 'copy') return saveAs();
      }
      try {
        // The version is taken with the bytes: a change made while the save is on its way stays unsaved.
        const version = wb.version;
        const entry = await saveOver(shell, path, await fileBytes(kind), loadedId);
        if (!entry) return false;
        loadedId = entry.id;
        savedVersion = version;
        lost = null;
        refresh();
        shell.native?.remember(path);
        shell.toast(`Saved “${entry.name}”.`);
        return true;
      } catch (error) {
        await shell.report('Could not save', error);
        return false;
      }
    }

    async function saveAs(): Promise<boolean> {
      if (!grid.commit()) return false;
      if (shell.native) return saveAsNative(shell.native);
      const folder = path ? parentPath(path) : '/Documents';
      let taken: string[] = [];
      try {
        taken = (await shell.fs.list(folder, true)).map(e => e.name);
      } catch {
        // Saving will say the folder is gone.
      }
      const asExcel = kind === 'xlsx' || /\.xls[xm]?$/i.test(label);
      // The ending chooses the kind: .xlsx is an Excel workbook, anything else this spreadsheet's own .sheet file.
      const final = (v: string) => (/\.(sheet|xlsx)$/i.test(v) ? v : `${v}.sheet`);
      const name = await shell.dialogs.prompt({
        title: 'Save as',
        label: `Name (saved in ${folder}). End it in .xlsx for an Excel workbook, or .sheet for this spreadsheet's own kind of file.`,
        value: uniqueName(`${baseLabel()}.${asExcel ? 'xlsx' : 'sheet'}`, taken),
        ok: 'Save',
        selectStem: true,
        check: v => nameProblem(final(v)) ?? (taken.some(t => t.toLowerCase() === final(v).toLowerCase()) ? `There is already something called "${final(v)}" here.` : null),
      });
      if (name === null) return false;
      const finalName = final(name);
      const as = /\.xlsx$/i.test(finalName) ? 'xlsx' : 'sheet';
      try {
        const version = wb.version;
        const entry = await shell.fs.writeFile(joinPath(folder, finalName), await fileBytes(as), { mustBeNew: true });
        path = joinPath(folder, entry.name);
        label = entry.name;
        loadedId = entry.id;
        savedVersion = version;
        kind = as;
        lost = null;
        refresh();
        shell.toast(`Saved “${entry.name}”.`);
        return true;
      } catch (error) {
        await shell.report('Could not save', error);
        return false;
      }
    }

    /** Save as through the computer's own Save box: it asks before replacing a file, so the write may replace one. */
    async function saveAsNative(native: NativeHost): Promise<boolean> {
      const asExcel = kind === 'xlsx' || /\.xls[xm]?$/i.test(label);
      const name = `${baseLabel()}.${asExcel ? 'xlsx' : 'sheet'}`;
      const chosen = await native.pickSave(path ? joinPath(parentPath(path), name) : name, asExcel ? 'xlsx' : 'sheet');
      if (chosen === null) return false;
      const as = /\.xlsx$/i.test(chosen) ? 'xlsx' : 'sheet';
      try {
        const version = wb.version;
        const entry = await shell.fs.writeFile(chosen, await fileBytes(as));
        path = chosen;
        label = entry.name;
        loadedId = entry.id;
        savedVersion = version;
        kind = as;
        lost = null;
        refresh();
        native.remember(chosen);
        shell.toast(`Saved “${entry.name}”.`);
        return true;
      } catch (error) {
        await shell.report('Could not save', error);
        return false;
      }
    }

    /** Any workbook from the computer (.xlsx, .xlsm, .sheet, .csv...), through its own Open box. */
    async function openNative(native: NativeHost): Promise<void> {
      const chosen = await native.pickOpen();
      if (chosen !== null) await shell.openPath(chosen);
    }

    function baseLabel(): string {
      return label.replace(/\.(csv|tsv|txt|sheet|xlsx|xlsm|xls)$/i, '') || 'Spreadsheet';
    }

    function exportCsv(): void {
      if (!grid.commit()) return;
      const bytes = new TextEncoder().encode('﻿' + wb.exportText(wb.active, wb.usedRange(wb.active), ','));
      shell.transfers.save(`${baseLabel()}.csv`, bytes);
    }

    async function exportXlsx(): Promise<void> {
      if (!grid.commit()) return;
      try {
        shell.transfers.save(`${baseLabel()}.xlsx`, await saveXlsx(wb));
      } catch (error) {
        await report(error);
      }
    }

    /** An Excel file from this computer: copied into Documents (so it can be saved), then opened in a window of its own. */
    function openExcelFromComputer(): void {
      const input = h('input', { type: 'file', accept: '.xlsx,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', class: 'visually-hidden', tabindex: -1, 'aria-hidden': 'true' });
      const done = new AbortController();
      on(input, 'change', async () => {
        const file = input.files?.[0];
        done.abort();
        input.remove();
        if (!file) return;
        if (file.size > MAX_FILE_BYTES) {
          await shell.dialogs.alert('That file is too big', `Excel files up to ${formatSize(MAX_FILE_BYTES)} can be opened.`);
          return;
        }
        try {
          let taken: string[] = [];
          try {
            taken = (await shell.fs.list('/Documents', true)).map(e => e.name);
          } catch {
            // Writing says so if Documents is not there.
          }
          const entry = await shell.fs.writeFile(joinPath('/Documents', uniqueName(file.name, taken)), new Uint8Array(await file.arrayBuffer()), { mustBeNew: true });
          shell.toast(`Copied “${file.name}” into Documents as “${entry.name}” and opened it.`);
          await shell.openPath(joinPath('/Documents', entry.name));
        } catch (error) {
          await shell.report('Could not open that Excel file', error);
        }
      }, done.signal);
      on(input, 'cancel', () => {
        done.abort();
        input.remove();
      }, done.signal);
      document.body.append(input);
      input.click();
    }

    function importFromComputer(): void {
      const input = h('input', { type: 'file', accept: '.csv,.tsv,.txt,text/csv,text/plain', class: 'visually-hidden', tabindex: -1, 'aria-hidden': 'true' });
      const done = new AbortController();
      on(input, 'change', async () => {
        const file = input.files?.[0];
        done.abort();
        input.remove();
        if (!file) return;
        if (file.size > MAX_FILE_BYTES) {
          await shell.dialogs.alert('That file is too big', `Files up to ${formatSize(MAX_FILE_BYTES)} can be imported.`);
          return;
        }
        try {
          const a = grid.active();
          const n = wb.importText(wb.active, a.col, a.row, await file.text());
          shell.toast(`Imported ${n.toLocaleString()} cells from “${file.name}”.`);
          onChange();
        } catch (error) {
          await report(error);
        }
      }, done.signal);
      on(input, 'cancel', () => {
        done.abort();
        input.remove();
      }, done.signal);
      document.body.append(input);
      input.click();
    }

    const fileBtn = h('button', { type: 'button', class: 'file-tab', 'aria-haspopup': 'true' }, 'File');
    on(fileBtn, 'click', () => {
      const r = fileBtn.getBoundingClientRect();
      const dates: MenuItem = { label: 'Read typed dates as', submenu: (['dmy', 'mdy', 'ymd'] as const).map(o => ({ label: ORDER_LABEL[o], checked: wb.dateOrder === o, action: () => void setDateOrder(o) })) };
      const native = shell.native;
      if (native) {
        // A program of its own: the computer's Open and Save boxes, and Export in place of Download.
        const extra = native.fileMenu();
        shell.menus.show([
          { label: 'New', hint: 'Ctrl+N', action: () => native.newWindow() },
          { label: 'Open...', hint: 'Ctrl+O', action: () => void openNative(native) },
          ...extra.top,
          { separator: true },
          { label: 'Save', hint: 'Ctrl+S', action: () => void save() },
          { label: 'Save as...', hint: 'F12', action: () => void saveAs() },
          { label: 'Import CSV into this sheet...', action: importFromComputer },
          { label: 'Export as CSV...', action: exportCsv },
          { label: 'Export as PDF...', action: () => void downloadPdf(ctx) },
          { separator: true },
          { label: 'Print...', hint: 'Ctrl+P', action: () => void printPreview(ctx) },
          { label: 'Page setup...', action: () => void pageSetupDialog(ctx) },
          { separator: true },
          dates,
          ...extra.bottom,
        ], r.left, r.bottom, { returnFocus: fileBtn });
        return;
      }
      shell.menus.show([
        { label: 'Save', hint: 'Ctrl+S', action: () => void save() },
        { label: 'Save as...', hint: 'Ctrl+Shift+S', action: () => void saveAs() },
        { separator: true },
        { label: 'Open an Excel file from your computer...', action: openExcelFromComputer },
        { label: 'Import CSV from your computer...', action: importFromComputer },
        { label: 'Download as Excel workbook (.xlsx)', action: () => void exportXlsx() },
        { label: 'Download as CSV', action: exportCsv },
        { separator: true },
        { label: 'Print...', hint: 'Ctrl+P', action: () => void printPreview(ctx) },
        { label: 'Page setup...', action: () => void pageSetupDialog(ctx) },
        { label: 'Download as PDF', action: () => void downloadPdf(ctx) },
        { label: 'Save as PDF in Documents', action: () => void savePdfInDocuments(ctx) },
        { separator: true },
        dates,
      ], r.left, r.bottom, { returnFocus: fileBtn });
    }, app.signal);
    const tabsRow = h('div', { class: 'ribbon-tabs', role: 'tablist', 'aria-label': 'Toolbar' }, fileBtn, ...tabButtons);

    // ---- Formula bar, sheet tabs, status ---------------------------------------------------------------------------

    const formulaBar = h('div', { class: 'formula-bar' }, grid.nameBox, h('span', { class: 'fx', 'aria-hidden': 'true' }, 'fx'), grid.formulaInput);
    const tabs = h('div', { class: 'sheet-tabs', role: 'tablist', 'aria-label': 'Sheets' });
    const stats = h('span', { class: 'sheet-stats' });
    const mode = h('span', { class: 'sheet-mode' }, 'Ready');
    const filterNote = h('span', { class: 'sheet-filter-note' });
    const zoomOut = btn('−', 'Zoom out', () => grid.setZoom(grid.zoom() / 1.1), 'zoom-btn');
    const zoomIn = btn('+', 'Zoom in', () => grid.setZoom(grid.zoom() * 1.1), 'zoom-btn');
    const zoomLabel = h('span', { class: 'zoom-label' }, '100%');
    const status = h('div', { class: 'statusbar sheet-status', role: 'status' }, mode, filterNote, stats, h('span', { class: 'spacer' }), zoomOut, zoomLabel, zoomIn);
    const tabsBar = h('div', { class: 'tabs-bar' }, tabs);

    function drawTabs(): void {
      const nodes: Node[] = [];
      wb.sheets.forEach((sh, i) => {
        const b = h('button', { type: 'button', class: `sheet-tab${i === wb.active ? ' active' : ''}`, role: 'tab', 'aria-selected': String(i === wb.active), title: 'Double-click to rename' }, sh.name);
        on(b, 'click', () => {
          grid.setActiveSheet(i);
          drawTabs();
          showBreaks();
          grid.focus();
        }, app.signal);
        on(b, 'dblclick', () => void rename(i), app.signal);
        on(b, 'contextmenu', (event: MouseEvent) => {
          event.preventDefault();
          event.stopPropagation();
          shell.menus.show([
            { label: 'Rename', action: () => void rename(i) },
            { label: 'Delete', disabled: wb.sheets.length <= 1, danger: true, action: () => void remove(i) },
          ], event.clientX, event.clientY, { returnFocus: b });
        }, app.signal);
        nodes.push(b);
      });
      const add = h('button', { type: 'button', class: 'sheet-add', title: 'New sheet', 'aria-label': 'New sheet' }, '+');
      on(add, 'click', () => {
        if (!grid.commit()) return;
        try {
          const i = wb.addSheet();
          grid.setActiveSheet(i);
          onChange();
        } catch (error) {
          void report(error);
        }
        grid.focus();
      }, app.signal);
      nodes.push(add);
      tabs.replaceChildren(...nodes);
    }

    async function rename(i: number): Promise<void> {
      const name = await shell.dialogs.prompt({ title: 'Rename sheet', label: 'Sheet name', value: wb.sheets[i].name, ok: 'Rename', check: v => (v === wb.sheets[i].name ? null : wb.sheetNameProblem(v, i)) });
      if (name === null || name === wb.sheets[i].name) return;
      try {
        wb.renameSheet(i, name);
        onChange();
      } catch (error) {
        await report(error);
      }
    }

    async function remove(i: number): Promise<void> {
      const ok = await shell.dialogs.confirm({ title: 'Delete this sheet?', text: `“${wb.sheets[i].name}” and everything on it will be deleted. You can undo this with Ctrl+Z until you close the window.`, ok: 'Delete sheet', danger: true });
      if (!ok) return;
      try {
        wb.deleteSheet(i);
        grid.setActiveSheet(wb.active);
        onChange();
      } catch (error) {
        await report(error);
      }
    }

    function updateStats(): void {
      const s = grid.sel();
      if (s.c0 === s.c1 && s.r0 === s.r1) {
        stats.textContent = '';
        return;
      }
      let sum = 0;
      let count = 0;
      let nonEmpty = 0;
      const used = wb.usedBounds(wb.active);
      for (let r = s.r0; r <= Math.min(s.r1, used.rows - 1); r++) {
        for (let c = s.c0; c <= Math.min(s.c1, used.cols - 1); c++) {
          const v = wb.value(wb.active, c, r);
          if (v !== null) nonEmpty++;
          if (typeof v === 'number') {
            sum += v;
            count++;
          }
        }
      }
      const shown = (n: number) => formatNumber(n, undefined);
      stats.textContent = count ? `Average: ${shown(sum / count)}    Count: ${nonEmpty}    Sum: ${shown(sum)}` : nonEmpty ? `Count: ${nonEmpty}` : '';
    }

    function syncToolbar(): void {
      syncTableTab();
      const s = activeStyle();
      const press = (b: HTMLElement, on: boolean | undefined) => b.setAttribute('aria-pressed', String(!!on));
      press(boldBtn, s.b);
      press(italicBtn, s.i);
      press(underBtn, s.u);
      press(strikeBtn, s.st);
      (['t', 'm', 'b'] as const).forEach((va, i) => press(vaBtns[i], (s.va ?? 'b') === va));
      // A typeface not in the list (from an Excel file) is shown as it is.
      const listed = !s.ff || FONT_FACES.some(f => f.name.toLowerCase() === s.ff!.toLowerCase());
      otherFace.hidden = listed;
      otherFace.value = listed ? '' : s.ff!;
      otherFace.textContent = listed ? '' : s.ff!;
      faceSelect.value = s.ff ? (FONT_FACES.find(f => f.name.toLowerCase() === s.ff!.toLowerCase())?.name ?? s.ff) : '';
      if (document.activeElement !== sizeBox) sizeBox.value = String(s.fs ?? STANDARD_SIZE);
      (['l', 'c', 'r'] as const).forEach((al, i) => press(alignBtns[i], s.al === al));
      press(wrapBtn, s.wrap);
      press(filterBtn, !!wb.sheets[wb.active].filter);
      press(filterBtn2, !!wb.sheets[wb.active].filter);
      press(gridPrintBtn, page().gridlines);
      press(headPrintBtn, page().headings);
      press(freezeBtn, !!(wb.sheets[wb.active].freeze.rows || wb.sheets[wb.active].freeze.cols));
      press(showFormulasBtn, grid.showFormulas);
      press(showNotesBtn, grid.showNotes);
      press(viewNotesBtn, grid.showNotes);
      press(viewFormulasBtn, grid.showFormulas);
      press(gridlinesBtn, !wb.sheets[wb.active].noGrid);
      const f = wb.sheets[wb.active].filter;
      if (f && (f.cols.size || f.rules?.size)) {
        let shown = 0;
        for (let r = f.range.r0 + 1; r <= f.range.r1; r++) if (!wb.sheets[wb.active].hiddenRows.has(r)) shown++;
        filterNote.textContent = `${shown.toLocaleString()} of ${(f.range.r1 - f.range.r0).toLocaleString()} rows shown (filter)`;
      } else {
        const t = activeTable(ctx);
        filterNote.textContent = t ? tableSummary(t) : '';
      }
      // A format code shows as the ready-made format it is, or as "Custom: <code>".
      let shownFmt: string = s.fmt ?? '';
      if (s.fmt === 'custom') shownFmt = Object.keys(presetCodes).find(k => presetCodes[k] === s.code) ?? 'custom';
      customOption.hidden = shownFmt !== 'custom';
      customOption.textContent = shownFmt === 'custom' ? `Custom: ${(s.code ?? '').slice(0, 24)}` : 'Custom';
      fmtSelect.value = shownFmt;
      undoBtn.disabled = !wb.canUndo;
      redoBtn.disabled = !wb.canRedo;
      zoomLabel.textContent = `${Math.round(grid.zoom() * 100)}%`;
      updateStats();
    }

    function onChange(): void {
      grid.sync();
      refresh();
      syncToolbar();
      drawTabs();
      showBreaks();
      grid.redraw();
    }
    grid.onChange = () => {
      refresh();
      syncToolbar();
      drawTabs();
      showBreaks();
    };
    grid.onSelect = syncToolbar;
    grid.onEdit = editing => {
      mode.textContent = editing ? 'Edit' : 'Ready';
    };

    app.root.append(tabsRow, ribbon, formulaBar, main, tabsBar, status);
    drawTabs();
    syncToolbar();
    refresh();

    on(app.root, 'keydown', (event: KeyboardEvent) => {
      const ctrl = event.ctrlKey || event.metaKey;
      const k = event.key.toLowerCase();
      if (ctrl && k === 's') {
        event.preventDefault();
        void (event.shiftKey ? saveAs() : save());
      } else if (shell.native && event.key === 'F12' && !ctrl && !event.shiftKey) {
        event.preventDefault();
        void saveAs();
      } else if (shell.native && ctrl && !event.shiftKey && k === 'n') {
        event.preventDefault();
        shell.native.newWindow();
      } else if (shell.native && ctrl && !event.shiftKey && k === 'o') {
        event.preventDefault();
        void openNative(shell.native);
      } else if (ctrl && !event.shiftKey && (k === 'f' || k === 'h')) {
        event.preventDefault();
        openFind(k === 'h');
      } else if (ctrl && event.shiftKey && k === 'l') {
        event.preventDefault();
        toggleFilter();
      } else if (ctrl && !event.shiftKey && k === 'p') {
        event.preventDefault();
        void printPreview(ctx);
      } else if (ctrl && (event.key === '`' || event.code === 'Backquote')) {
        event.preventDefault();
        toggleFormulas();
      } else if (event.key === 'F3' && event.shiftKey && !ctrl) {
        event.preventDefault();
        void insertFunctionDialog(ctx);
      } else if (event.key === 'F3' && ctrl) {
        event.preventDefault();
        void nameManager(ctx);
      } else if (ctrl && !event.shiftKey && (k === 't' || k === 'l') && !grid.editing()) {
        // Ctrl+T as in Excel (some browsers keep Ctrl+T for a new tab; Ctrl+L, Excel's other key for it, works there).
        event.preventDefault();
        void insertTableDialog(ctx);
      } else if (ctrl && !event.shiftKey && (k === '1' || event.code === 'Digit1') && !grid.editing()) {
        event.preventDefault();
        formatCells();
      } else if (ctrl && !event.shiftKey && k === '5' && !grid.editing()) {
        event.preventDefault();
        strikeBtn.click();
      } else if (ctrl && event.shiftKey && (event.key === '>' || event.key === '<' || event.code === 'Period' || event.code === 'Comma') && !grid.editing()) {
        event.preventDefault();
        (event.key === '>' || event.code === 'Period' ? growBtn : shrinkBtn).click();
      } else if (ctrl && event.shiftKey && k === 'v' && !grid.editing() && grid.hasClip()) {
        event.preventDefault();
        grid.pasteSpecial('values');
        onChange();
      } else if (event.key === 'Escape' && painter) {
        stopPainting();
      } else if (ctrl && !event.shiftKey && (k === 'b' || k === 'i' || k === 'u') && !(((event.target instanceof HTMLInputElement && event.target.type === 'text') || event.target instanceof HTMLTextAreaElement) && grid.editing())) {
        event.preventDefault();
        if (k === 'b') boldBtn.click();
        else if (k === 'i') italicBtn.click();
        else underBtn.click();
      } else if (event.key === 'Escape' && palette) {
        closePalette();
      } else if (event.key === 'Escape' && filterBox) {
        closeFilter();
        grid.focus();
      }
    }, app.signal);
    on(document, 'pointerdown', (event: PointerEvent) => {
      if (palette && event.target instanceof Node && !palette.contains(event.target) && !(event.target as Element).closest?.('.wide-rb')) closePalette();
    }, app.signal);
    // A program of its own asks as a desktop spreadsheet does when its window closes with unsaved changes.
    if (shell.native) {
      app.onClose(async () => {
        if (wb.version === savedVersion) return true;
        const answer = await shell.dialogs.ask<'save' | 'drop' | null>({
          title: shell.native!.product,
          text: `Do you want to save the changes you made to “${label}”?`,
          buttons: [{ label: 'Save', value: 'save', primary: true }, { label: 'Don’t save', value: 'drop' }, { label: 'Cancel', value: null }],
          cancel: null,
        });
        if (answer === 'save') return save();
        return answer === 'drop';
      });
    }
    void addressOf;
    grid.focus();
  },
};
