// The screens for Excel tables: Insert > Table (Ctrl+T), Home > Format as Table (the style gallery), the Table Design
// tab shown while the active cell is in a table (name, resize, convert to range, header and total rows, banding,
// filter buttons, style), and the drop-down of each total row cell (Sum, Average, Count...).
import { h, on } from '../../core/dom.ts';
import type { MenuItem } from '../../shell/menu.ts';
import type { SheetContext } from './charts-ui.ts';
import { readRanges } from './rules-ui.ts';
import { addressOf, SyntaxProblem } from './refs.ts';
import { dataRows, styleLabel, TABLE_STYLES, TOTAL_LABEL, type Table, type TotalFn } from './tables.ts';
import type { Range } from './workbook.ts';

const rangeText = (r: Range) => `${addressOf(r.c0, r.r0)}:${addressOf(r.c1, r.r1)}`;

/** The table the active cell is in, if any. */
export function activeTable(ctx: SheetContext): Table | null {
  const a = ctx.grid.active();
  return ctx.wb.tableAt(ctx.wb.active, a.col, a.row);
}

/** Insert > Table (Ctrl+T): which cells, and whether their first row holds the column names. */
export async function insertTableDialog(ctx: SheetContext, style?: string): Promise<void> {
  const { shell, wb, grid } = ctx;
  if (!grid.commit()) return;
  const s = wb.active;
  const sel = grid.sel();
  const a = grid.active();
  const guess = sel.r1 > sel.r0 || sel.c1 > sel.c0 ? sel : wb.currentRegion(s, a.col, a.row);
  // Ticked as Excel guesses it: a first row of words over rows holding numbers or dates.
  const first = Array.from({ length: guess.c1 - guess.c0 + 1 }, (_, i) => wb.value(s, guess.c0 + i, guess.r0));
  const second = guess.r1 > guess.r0 ? Array.from({ length: guess.c1 - guess.c0 + 1 }, (_, i) => wb.value(s, guess.c0 + i, guess.r0 + 1)) : [];
  let values = { where: rangeText(guess), header: first.some(v => typeof v === 'string') && first.every(v => v === null || typeof v === 'string') && (second.some(v => typeof v !== 'string' && v !== null) || guess.r1 > guess.r0) };
  for (;;) {
    const whereIn = h('input', { type: 'text', class: 'field', value: values.where, 'aria-label': 'Where is the data for the table?', autocomplete: 'off', spellcheck: false });
    const headIn = h('input', { type: 'checkbox' });
    headIn.checked = values.header;
    const ok = await shell.dialogs.ask<boolean>({
      title: 'Create table',
      body: h('div', { class: 'name-dialog' },
        h('label', { class: 'dialog-label' }, 'Where is the data for your table?', whereIn),
        h('label', {}, headIn, ' My table has headers'),
        h('p', { class: 'dialog-detail' }, 'The first row becomes the column names. Without headers, the empty row above the data takes them (Column1, Column2...).')),
      buttons: [{ label: 'OK', value: true, primary: true }, { label: 'Cancel', value: false }],
      cancel: false,
      focus: () => whereIn,
    });
    if (!ok) {
      grid.focus();
      return;
    }
    values = { where: whereIn.value.trim(), header: headIn.checked };
    const ranges = readRanges(values.where);
    try {
      if (!ranges || ranges.length !== 1) throw new SyntaxProblem('Type one block of cells, such as A1:D20.');
      const t = wb.addTable(s, ranges[0], { header: values.header, style });
      grid.select(t.range, { col: t.range.c0, row: t.range.r0 });
      ctx.onChange();
      shell.toast(`Made the table “${t.name}”. Table Design changes its look; formulas can use ${t.name}[${t.columns[0].name}].`);
      grid.focus();
      return;
    } catch (error) {
      const why = error instanceof SyntaxProblem ? error.message : 'That could not be done.';
      await shell.dialogs.alert('The table could not be made', why, 'Fix it and press OK again.');
    }
  }
}

/** Home > Format as Table: Excel's styles in three groups; the active table changes, or a new one is made with it. */
export function formatAsTableMenu(ctx: SheetContext): MenuItem[] {
  const group = (family: string) => TABLE_STYLES.filter(st => st.name.includes(family)).map(st => ({
    label: styleLabel(st.name),
    checked: activeTable(ctx)?.style === st.name,
    action: () => applyStyle(ctx, st.name),
  }));
  return [
    { label: 'Light', submenu: group('Light') },
    { label: 'Medium', submenu: group('Medium') },
    { label: 'Dark', submenu: group('Dark') },
    { separator: true },
    { label: 'No style (keep the table)', disabled: !activeTable(ctx), action: () => applyStyle(ctx, '') },
  ];
}

function applyStyle(ctx: SheetContext, style: string): void {
  const t = activeTable(ctx);
  if (!t) {
    void insertTableDialog(ctx, style || undefined);
    return;
  }
  try {
    ctx.wb.setTableOptions(ctx.wb.active, t, { style });
    ctx.onChange();
  } catch (error) {
    void ctx.report(error);
  }
}

/** The choices of a total row cell, for the grid's drop-down button. */
export function totalChoices(ctx: SheetContext, col: number, row: number): { items: string[]; current: string; pick(item: string): void } | null {
  const t = ctx.wb.tableAt(ctx.wb.active, col, row);
  if (!t || !t.totals || row !== t.range.r1) return null;
  const i = col - t.range.c0;
  const fns: TotalFn[] = ['none', 'average', 'count', 'countNums', 'max', 'min', 'sum', 'stdDev', 'var'];
  const current = TOTAL_LABEL[t.columns[i].total ?? 'none'];
  return {
    items: fns.map(f => TOTAL_LABEL[f]),
    current,
    pick: item => {
      const fn = fns.find(f => TOTAL_LABEL[f] === item) ?? 'none';
      ctx.wb.setTotalFn(ctx.wb.active, t, i, fn);
    },
  };
}

/** The Table Design tab's buttons (rebuilt each time the active table changes). */
export function tableDesign(ctx: SheetContext, t: Table, btn: (text: string, title: string, run: () => void, cls?: string) => HTMLButtonElement, group: (name: string, ...kids: Node[]) => HTMLElement, tools: { pivot(): void; dups(): void }): HTMLElement[] {
  const { wb, shell, grid } = ctx;
  const s = wb.active;
  const run = (fn: () => void) => () => {
    try {
      fn();
      ctx.onChange();
    } catch (error) {
      void ctx.report(error);
    }
  };
  const nameIn = h('input', { type: 'text', class: 'rb-name', value: t.name, 'aria-label': 'Table name', title: 'Table name (formulas use it, such as SUM(Table1[Amount]))', autocomplete: 'off', spellcheck: false });
  const rename = () => {
    if (nameIn.value.trim() === t.name) return;
    try {
      wb.renameTable(t, nameIn.value);
      ctx.onChange();
    } catch (error) {
      nameIn.value = t.name;
      void ctx.report(error);
    }
  };
  on(nameIn, 'change', rename, ctx.signal);
  on(nameIn, 'keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      rename();
      grid.focus();
    } else if (event.key === 'Escape') {
      nameIn.value = t.name;
      grid.focus();
    }
    event.stopPropagation();
  }, ctx.signal);
  const resize = async () => {
    const answer = await shell.dialogs.prompt({
      title: 'Resize table',
      label: `The new range for the table (it starts at ${addressOf(t.range.c0, t.range.r0)}, its top-left cell)`,
      value: rangeText(t.range),
      ok: 'OK',
      check: v => (readRanges(v)?.length === 1 ? null : 'Type one block of cells, such as A1:D40.'),
    });
    if (answer === null) return;
    run(() => wb.resizeTable(s, t, readRanges(answer)![0]))();
  };
  const toggle = (label: string, title: string, on: boolean, flip: () => void) => {
    const b = btn(label, title, run(flip), 'text-rb');
    b.setAttribute('aria-pressed', String(on));
    return b;
  };
  const styleBtn = btn(`Style: ${styleLabel(t.style)} ▾`, 'Table styles', () => {
    const r = styleBtn.getBoundingClientRect();
    shell.menus.show(formatAsTableMenu(ctx), r.left, r.bottom, { returnFocus: styleBtn });
  }, 'text-rb');
  return [
    group('Properties', nameIn, btn('Resize table', 'Resize table: take in more rows or columns, or fewer', () => void resize(), 'text-rb')),
    group('Tools',
      btn('Summarize with PivotTable', 'Summarize the table in a PivotTable', tools.pivot, 'text-rb'),
      btn('Remove duplicates', 'Take out rows that repeat an earlier row of the table', tools.dups, 'text-rb'),
      btn('Convert to range', 'Convert to range: the table becomes plain cells, keeping its look', () => {
      void shell.dialogs.confirm({ title: `Convert “${t.name}” to a range?`, text: 'The cells keep their look, but are no longer a table: no banding as rows are added, no filter buttons, and formulas that used the table\'s name use cell addresses instead. Ctrl+Z takes this back.', ok: 'Convert' })
        .then(yes => {
          if (yes) run(() => wb.convertTable(s, t))();
        });
    }, 'text-rb')),
    group('Style options',
      toggle('Header row', 'Show the header row (the column names)', t.header, () => wb.setHeader(s, t, !t.header)),
      toggle('Total row', 'Show a total row under the table', t.totals, () => wb.setTotals(s, t, !t.totals)),
      toggle('Banded rows', 'Every other row shaded', t.bandRows, () => wb.setTableOptions(s, t, { bandRows: !t.bandRows })),
      toggle('First column', 'The first column in bold', t.firstCol, () => wb.setTableOptions(s, t, { firstCol: !t.firstCol })),
      toggle('Last column', 'The last column in bold', t.lastCol, () => wb.setTableOptions(s, t, { lastCol: !t.lastCol })),
      toggle('Banded columns', 'Every other column shaded', t.bandCols, () => wb.setTableOptions(s, t, { bandCols: !t.bandCols })),
      toggle('Filter button', 'Filter buttons on the header row', t.filter && wb.isTableFilter(s, t), () => wb.setTableOptions(s, t, { filter: !(t.filter && wb.isTableFilter(s, t)) }))),
    group('Table styles', styleBtn),
  ];
}

/** A sentence about the table, for the status bar: "Table1: 4 columns, 12 rows of data". */
export function tableSummary(t: Table): string {
  const dr = dataRows(t);
  return `${t.name}: ${t.columns.length} ${t.columns.length === 1 ? 'column' : 'columns'}, ${dr.r1 - dr.r0 + 1} rows of data`;
}
