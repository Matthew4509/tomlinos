// The screens for PivotTables: Insert > PivotTable (which data, and where the report goes), the PivotTable Fields pane
// beside the grid (tick fields; drag them, or use each one's menu, between Filters, Columns, Rows and Values), and the
// PivotTable Analyze tab (refresh, change the data, totals, delete). The reports themselves are worked out in pivot.ts.
import { h, on } from '../../core/dom.ts';
import type { MenuItem } from '../../shell/menu.ts';
import type { SheetContext } from './charts-ui.ts';
import { AGG_LABEL, AGGS, fieldItems, SHOW_LABEL, valueName, type Agg, type DateGroup, type Pivot, type PivotData, type PivotValue, type ShowAs } from './pivot.ts';
import { addressOf, colName, quoteSheet, SyntaxProblem } from './refs.ts';
import { readRanges } from './rules-ui.ts';
import { isDateStyle } from './workbook.ts';

type Area = 'filters' | 'cols' | 'rows' | 'values';
const AREA_LABEL: Record<Area, string> = { filters: 'Filters', cols: 'Columns', rows: 'Rows', values: 'Values' };

/** The PivotTable the active cell is in, if any. */
export function activePivot(ctx: SheetContext): Pivot | null {
  const a = ctx.grid.active();
  return ctx.wb.pivotAt(ctx.wb.active, a.col, a.row);
}

/** Insert > PivotTable: the data (a range or a table) and where the report goes (a new sheet, or a cell here). */
export async function insertPivotDialog(ctx: SheetContext, select: (s: number, col: number, row: number) => void): Promise<void> {
  const { shell, wb, grid } = ctx;
  if (!grid.commit()) return;
  const s = wb.active;
  const a = grid.active();
  const sel = grid.sel();
  const t = wb.tableAt(s, a.col, a.row);
  const region = sel.r1 > sel.r0 || sel.c1 > sel.c0 ? sel : wb.currentRegion(s, a.col, a.row);
  const abs = (c: number, r: number) => `$${colName(c)}$${r + 1}`;
  let values = {
    // A table: its header and data rows, as Excel reads a table (not its total row).
    source: t ? `${t.name}[[#Headers],[#Data]]` : `${quoteSheet(wb.sheets[s].name)}!${abs(region.c0, region.r0)}:${abs(region.c1, region.r1)}`,
    newSheet: true,
    where: addressOf(region.c1 + 2, region.r0),
  };
  for (;;) {
    const sourceIn = h('input', { type: 'text', class: 'field', value: values.source, 'aria-label': 'Table or range', autocomplete: 'off', spellcheck: false });
    const newIn = h('input', { type: 'radio', name: 'pv-where', checked: values.newSheet });
    const hereIn = h('input', { type: 'radio', name: 'pv-where', checked: !values.newSheet });
    const whereIn = h('input', { type: 'text', class: 'field', value: values.where, 'aria-label': 'Cell for the report', autocomplete: 'off', spellcheck: false });
    const ok = await shell.dialogs.ask<boolean>({
      title: 'Create PivotTable',
      body: h('div', { class: 'name-dialog' },
        h('label', { class: 'dialog-label' }, 'The data to sum up: a table, or cells with a header row (the column names)', sourceIn),
        h('p', { class: 'dialog-text' }, 'Where the report goes:'),
        h('label', {}, newIn, ' A new sheet'),
        h('label', {}, hereIn, ` This sheet (${wb.sheets[s].name}), from cell:`), whereIn),
      buttons: [{ label: 'OK', value: true, primary: true }, { label: 'Cancel', value: false }],
      cancel: false,
      focus: () => sourceIn,
    });
    if (!ok) {
      grid.focus();
      return;
    }
    values = { source: sourceIn.value.trim().replace(/^=/, ''), newSheet: newIn.checked, where: whereIn.value.trim() };
    try {
      wb.pivotData(s, values.source);
      let target = s;
      let at = { col: 0, row: 2 };
      if (!values.newSheet) {
        const r = readRanges(values.where);
        if (!r) throw new SyntaxProblem('The cell for the report is not an address. Type one such as F1.');
        at = { col: r[0].c0, row: r[0].r0 };
      } else target = wb.addSheet();
      // A source written without its sheet (A1:D9) means this sheet, wherever the report goes.
      const source = !values.newSheet || /!|\[/.test(values.source) || wb.names.some(n => n.name.toLowerCase() === values.source.toLowerCase()) ? values.source : `${quoteSheet(wb.sheets[s].name)}!${values.source}`;
      try {
        const p = wb.addPivot(target, source, at);
        select(target, p.at.col, p.at.row);
        ctx.onChange();
        shell.toast(`Made “${p.name}”. Tick fields in the PivotTable Fields pane to build the report.`);
      } catch (error) {
        if (values.newSheet) wb.undo();
        throw error;
      }
      return;
    } catch (error) {
      const why = error instanceof SyntaxProblem ? error.message : 'That could not be done.';
      await shell.dialogs.alert('The PivotTable could not be made', why, 'Fix it and press OK again.');
    }
  }
}

/** The PivotTable Fields pane: shown beside the grid while the active cell is in a PivotTable. */
export function mountPivotPane(ctx: SheetContext, host: HTMLElement): { sync(): void; toggle(): void } {
  const { wb, shell, signal } = ctx;
  const pane = h('aside', { class: 'pivot-pane', 'aria-label': 'PivotTable Fields', hidden: true });
  host.append(pane);
  let closed = false;
  let shownFor = '';

  const apply = (p: Pivot, patch: Partial<Pivot>) => {
    try {
      wb.setPivot(wb.active, p, patch);
      // The report's columns fit what is in them, as Excel fits them on each update.
      if (p.last) ctx.grid.fitColumns(p.last.c0, p.last.c1);
      ctx.onChange();
    } catch (error) {
      void ctx.report(error);
      draw(true);
    }
  };
  const areaOf = (p: Pivot, field: number): Area | null => (p.rows.includes(field) ? 'rows' : p.cols.includes(field) ? 'cols' : p.filters.some(f => f.field === field) ? 'filters' : p.values.some(v => v.field === field) ? 'values' : null);
  /**
   * The pivot's fields with one moved to an area (at a place, or last), taken from where it was (`from`), or added from
   * the field list. A field is in one of Rows, Columns and Filters at most; it may also be in Values. `to` null removes it.
   */
  const moved = (p: Pivot, field: number, to: Area | null, at?: number, from?: { area: Area; index: number }): Partial<Pivot> => {
    let rows = [...p.rows];
    let cols = [...p.cols];
    let filters = [...p.filters];
    let vals = [...p.values];
    let keptValue: PivotValue | undefined;
    if (from) {
      if (from.area === 'rows') rows.splice(from.index, 1);
      else if (from.area === 'cols') cols.splice(from.index, 1);
      else if (from.area === 'filters') filters.splice(from.index, 1);
      else keptValue = vals.splice(from.index, 1)[0];
    } else if (to === null) {
      rows = rows.filter(f => f !== field);
      cols = cols.filter(f => f !== field);
      filters = filters.filter(f => f.field !== field);
      vals = vals.filter(v => v.field !== field);
    }
    if (to === 'rows' || to === 'cols' || to === 'filters') {
      rows = rows.filter(f => f !== field);
      cols = cols.filter(f => f !== field);
      filters = filters.filter(f => f.field !== field);
    }
    const put = <T>(list: T[], item: T) => list.splice(at === undefined ? list.length : Math.max(0, Math.min(list.length, at)), 0, item);
    if (to === 'rows') put(rows, field);
    if (to === 'cols') put(cols, field);
    if (to === 'filters') put(filters, { field, keep: null });
    if (to === 'values') put(vals, keptValue ?? { field, agg: defaultAgg(p, field) });
    return { rows, cols, filters, values: vals };
  };
  let data: PivotData | null = null;
  const defaultAgg = (_p: Pivot, field: number): Agg => {
    // Numbers are summed, anything else counted, as Excel chooses.
    const nums = data ? data.rows.filter(r => typeof r[field] === 'number').length : 0;
    const filled = data ? data.rows.filter(r => r[field] !== null).length : 0;
    return filled && nums === filled ? 'sum' : 'count';
  };
  const isDateField = (field: number) => !!data?.formats[field] && isDateStyle(data.formats[field]);

  /** A field's chip in an area, with its menu (and dragged to move it). */
  const chip = (p: Pivot, area: Area, index: number, field: number): HTMLElement => {
    const label = area === 'values' ? valueName(p.values[index], data!.fields) : data!.fields[field];
    const b = h('button', { type: 'button', class: 'pv-chip', draggable: 'true', 'aria-haspopup': 'true', title: `${label}: move it, or change it` }, h('span', {}, label), h('span', { 'aria-hidden': 'true' }, ' ▾'));
    on(b, 'dragstart', (event: DragEvent) => event.dataTransfer?.setData('text/plain', JSON.stringify({ field, area, index })), signal);
    on(b, 'click', () => {
      const r = b.getBoundingClientRect();
      const list = area === 'values' ? p.values.map(v => v.field) : area === 'filters' ? p.filters.map(f => f.field) : area === 'rows' ? p.rows : p.cols;
      const items: MenuItem[] = [
        { label: 'Move up', disabled: index === 0, action: () => apply(p, area === 'values' ? { values: swap(p.values, index, -1) } : moved(p, field, area, index - 1, { area, index })) },
        { label: 'Move down', disabled: index >= list.length - 1, action: () => apply(p, area === 'values' ? { values: swap(p.values, index, 1) } : moved(p, field, area, index + 1, { area, index })) },
        { separator: true },
        ...(['filters', 'cols', 'rows', 'values'] as Area[]).filter(a2 => a2 !== area).map(a2 => ({ label: `Move to ${AREA_LABEL[a2]}`, action: () => apply(p, moved(p, field, a2, undefined, { area, index })) })),
        { separator: true },
      ];
      if (area === 'values') {
        const v = p.values[index];
        items.push(
          { label: 'Summarize values by', submenu: AGGS.map(agg => ({ label: AGG_LABEL[agg], checked: v.agg === agg, action: () => apply(p, { values: p.values.map((x, i) => (i === index ? { ...x, agg, name: undefined } : x)) }) })) },
          { label: 'Show values as', submenu: (Object.keys(SHOW_LABEL) as ShowAs[]).map(sh => ({ label: SHOW_LABEL[sh], checked: (v.show ?? 'normal') === sh, action: () => apply(p, { values: p.values.map((x, i) => (i === index ? { ...x, show: sh === 'normal' ? undefined : sh } : x)) }) })) },
          { label: 'Rename...', action: () => void renameValue(p, index) },
        );
      } else if (area === 'filters') items.push({ label: 'Choose items...', action: () => void chooseItems(p, field, 'filter') });
      else {
        items.push({ label: 'Leave items out...', action: () => void chooseItems(p, field, 'hidden') });
        if (isDateField(field)) {
          const g = p.groups[field];
          items.push({
            label: 'Group dates by',
            submenu: ([['', 'Each date'], ['years', 'Years'], ['quarters', 'Quarters'], ['months', 'Months']] as Array<[DateGroup | '', string]>).map(([k, text]) => ({
              label: text, checked: (g ?? '') === k, action: () => {
                const groups = { ...p.groups };
                if (k) groups[field] = k;
                else delete groups[field];
                apply(p, { groups, hidden: { ...p.hidden, [field]: [] } });
              },
            })),
          });
        }
      }
      items.push({ separator: true }, { label: 'Remove field', danger: true, action: () => apply(p, area === 'values' ? { values: p.values.filter((_, i) => i !== index) } : moved(p, field, null, undefined, { area, index })) });
      shell.menus.show(items, r.left, r.bottom, { returnFocus: b });
    }, signal);
    return b;
  };
  const swap = <T>(list: T[], i: number, d: number): T[] => {
    const copy = [...list];
    const j = i + d;
    if (j < 0 || j >= copy.length) return copy;
    [copy[i], copy[j]] = [copy[j], copy[i]];
    return copy;
  };

  async function renameValue(p: Pivot, index: number): Promise<void> {
    const name = await shell.dialogs.prompt({ title: 'Value field name', label: 'The heading over this value\'s column', value: valueName(p.values[index], data!.fields), ok: 'OK', check: v => (v.trim() ? null : 'Type a heading.') });
    if (name === null) return;
    apply(p, { values: p.values.map((x, i) => (i === index ? { ...x, name: name.trim() } : x)) });
  }

  /** The items of a field, ticked: kept by a report filter, or (rows and columns) left out when unticked. */
  async function chooseItems(p: Pivot, field: number, kind: 'filter' | 'hidden'): Promise<void> {
    const items = fieldItems(data!, field, p.groups[field]);
    const keepNow = kind === 'filter' ? p.filters.find(f => f.field === field)?.keep ?? null : null;
    const hiddenNow = new Set((p.hidden[field] ?? []).map(x => x.toLowerCase()));
    const ticks = items.map(item => {
      const box = h('input', { type: 'checkbox' });
      box.checked = kind === 'filter' ? !keepNow || keepNow.some(k => k.toLowerCase() === item.toLowerCase()) : !hiddenNow.has(item.toLowerCase());
      return { item, box, row: h('label', { class: 'filter-value' }, box, h('span', {}, item)) };
    });
    const ok = await shell.dialogs.ask<boolean>({
      title: `${kind === 'filter' ? 'Report filter' : 'Items shown'}: ${data!.fields[field]}`,
      body: h('div', { class: 'filter-list pv-items' }, ...ticks.map(t => t.row)),
      buttons: [{ label: 'OK', value: true, primary: true }, { label: 'Cancel', value: false }],
      cancel: false,
      primaryEnabled: () => ticks.some(t => t.box.checked),
    });
    if (!ok) return;
    const on1 = ticks.filter(t => t.box.checked).map(t => t.item);
    const off = ticks.filter(t => !t.box.checked).map(t => t.item);
    if (kind === 'filter') apply(p, { filters: p.filters.map(f => (f.field === field ? { field, keep: off.length ? on1 : null } : f)) });
    else apply(p, { hidden: { ...p.hidden, [field]: off } });
  }

  function draw(force = false): void {
    const p = activePivot(ctx);
    if (!p || closed) {
      pane.hidden = true;
      shownFor = '';
      return;
    }
    const key = JSON.stringify(p);
    if (!force && key === shownFor && !pane.hidden) return;
    shownFor = key;
    try {
      data = wb.pivotData(wb.active, p.source);
    } catch (error) {
      pane.hidden = false;
      pane.replaceChildren(h('h2', { class: 'pv-title' }, 'PivotTable Fields'), h('p', { class: 'pv-problem', role: 'alert' }, error instanceof Error ? error.message : 'The data cannot be read.'));
      return;
    }
    pane.hidden = false;
    const close = h('button', { type: 'button', class: 'pv-close', 'aria-label': 'Close the field list (PivotTable Analyze > Field list opens it again)' }, '×');
    on(close, 'click', () => {
      closed = true;
      draw();
      ctx.grid.focus();
    }, signal);
    const search = h('input', { type: 'search', class: 'field', placeholder: 'Search fields', 'aria-label': 'Search fields', autocomplete: 'off' });
    const list = h('div', { class: 'pv-fields', role: 'group', 'aria-label': 'Fields' });
    data.fields.forEach((name, field) => {
      const box = h('input', { type: 'checkbox' });
      box.checked = areaOf(p, field) !== null;
      on(box, 'change', () => {
        if (box.checked) apply(p, moved(p, field, defaultAgg(p, field) === 'sum' ? 'values' : 'rows'));
        else apply(p, moved(p, field, null));
      }, signal);
      const row = h('label', { class: 'pv-field', draggable: 'true' }, box, h('span', {}, name));
      on(row, 'dragstart', (event: DragEvent) => event.dataTransfer?.setData('text/plain', JSON.stringify({ field })), signal);
      list.append(row);
    });
    on(search, 'input', () => {
      const q = search.value.trim().toLowerCase();
      [...list.children].forEach((el, i) => {
        (el as HTMLElement).hidden = q !== '' && !data!.fields[i].toLowerCase().includes(q);
      });
    }, signal);
    const areaBox = (area: Area): HTMLElement => {
      const fields = area === 'rows' ? p.rows : area === 'cols' ? p.cols : area === 'filters' ? p.filters.map(f => f.field) : p.values.map(v => v.field);
      const box = h('div', { class: 'pv-area', role: 'group', 'aria-label': AREA_LABEL[area] }, h('div', { class: 'pv-area-name' }, AREA_LABEL[area]), ...fields.map((f, i) => chip(p, area, i, f)));
      on(box, 'dragover', (event: DragEvent) => {
        event.preventDefault();
        box.classList.add('pv-over');
      }, signal);
      on(box, 'dragleave', () => box.classList.remove('pv-over'), signal);
      on(box, 'drop', (event: DragEvent) => {
        event.preventDefault();
        box.classList.remove('pv-over');
        let got: { field: number; area?: Area; index?: number };
        try {
          got = JSON.parse(event.dataTransfer?.getData('text/plain') ?? '');
        } catch {
          return;
        }
        if (!Number.isInteger(got.field)) return;
        // Dropped on a chip: put before it; elsewhere in the box: at the end.
        const chips = [...box.querySelectorAll('.pv-chip')];
        const before = chips.findIndex(c => event.clientY < c.getBoundingClientRect().top + c.getBoundingClientRect().height / 2);
        apply(p, moved(p, got.field, area, before < 0 ? undefined : before, got.area !== undefined && got.index !== undefined ? { area: got.area, index: got.index } : undefined));
      }, signal);
      return box;
    };
    pane.replaceChildren(
      h('div', { class: 'pv-head' }, h('h2', { class: 'pv-title' }, 'PivotTable Fields'), close),
      h('p', { class: 'pv-hint' }, `${p.name}: tick fields to add them; numbers go to Values, others to Rows.`),
      search, list,
      h('p', { class: 'pv-hint' }, 'Drag fields between the boxes, or use each one\'s ▾.'),
      h('div', { class: 'pv-areas' }, areaBox('filters'), areaBox('cols'), areaBox('rows'), areaBox('values')),
    );
  }

  return {
    sync: () => draw(),
    toggle: () => {
      closed = !closed;
      draw(true);
    },
  };
}

/** The PivotTable Analyze tab. */
export function pivotAnalyze(ctx: SheetContext, p: Pivot, btn: (text: string, title: string, run: () => void, cls?: string) => HTMLButtonElement, group: (name: string, ...kids: Node[]) => HTMLElement, toggleList: () => void): HTMLElement[] {
  const { wb, shell } = ctx;
  const s = wb.active;
  const run = (fn: () => void) => () => {
    try {
      fn();
      ctx.onChange();
    } catch (error) {
      void ctx.report(error);
    }
  };
  const totalsBtn = btn('Grand totals ▾', 'Grand totals: for rows, columns, both, or none', () => {
    const r = totalsBtn.getBoundingClientRect();
    shell.menus.show([
      { label: 'On for rows and columns', checked: p.grandRows && p.grandCols, action: run(() => wb.setPivot(s, p, { grandRows: true, grandCols: true })) },
      { label: 'On for rows only', checked: p.grandRows && !p.grandCols, action: run(() => wb.setPivot(s, p, { grandRows: true, grandCols: false })) },
      { label: 'On for columns only', checked: !p.grandRows && p.grandCols, action: run(() => wb.setPivot(s, p, { grandRows: false, grandCols: true })) },
      { label: 'Off for rows and columns', checked: !p.grandRows && !p.grandCols, action: run(() => wb.setPivot(s, p, { grandRows: false, grandCols: false })) },
    ], r.left, r.bottom, { returnFocus: totalsBtn });
  }, 'text-rb');
  const subBtn = btn('Subtotals ▾', 'Subtotals: on each outer row item, or not', () => {
    const r = subBtn.getBoundingClientRect();
    shell.menus.show([
      { label: 'Show subtotals', checked: p.subtotals, action: run(() => wb.setPivot(s, p, { subtotals: true })) },
      { label: 'Do not show subtotals', checked: !p.subtotals, action: run(() => wb.setPivot(s, p, { subtotals: false })) },
    ], r.left, r.bottom, { returnFocus: subBtn });
  }, 'text-rb');
  const changeSource = async () => {
    const v = await shell.dialogs.prompt({ title: 'Change PivotTable data source', label: 'The data: a table, or cells with a header row', value: p.source, ok: 'OK', check: x => (x.trim() ? null : 'Type the data\'s cells or table.') });
    if (v === null) return;
    run(() => {
      wb.pivotData(s, v.trim().replace(/^=/, ''));
      wb.setPivot(s, p, { source: v.trim().replace(/^=/, '') });
    })();
  };
  return [
    group(p.name, btn('Field list', 'Show or hide the PivotTable Fields pane', toggleList, 'text-rb')),
    group('Data', btn('Refresh', 'Work the report out again from its data', run(() => wb.refreshPivot(s, p)), 'text-rb'),
      btn('Refresh all', 'Work every PivotTable of the workbook out again', () => {
        const failed = wb.refreshAll();
        ctx.onChange();
        if (failed.length) void shell.dialogs.alert('Some PivotTables could not be refreshed', failed.join('\n'));
      }, 'text-rb'),
      btn('Change data source', 'Change the data the PivotTable reads', () => void changeSource(), 'text-rb')),
    group('Layout', totalsBtn, subBtn),
    group('Actions', btn('Delete', 'Delete this PivotTable and its report', () => {
      void shell.dialogs.confirm({ title: `Delete “${p.name}”?`, text: 'Its report\'s cells are cleared. The data it read is not touched. Ctrl+Z takes this back.', ok: 'Delete', danger: true })
        .then(yes => {
          if (yes) run(() => wb.deletePivot(s, p))();
        });
    }, 'text-rb')),
  ];
}
