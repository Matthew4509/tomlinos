// Charts on the grid: each chart is drawn (as SVG) in a frame over the cells, where it can be selected, dragged, resized
// from a corner, deleted, and changed in the Chart dialog (type, title, data, legend, axis titles, labels, colours).
// The frames follow the grid as it scrolls and zooms; the chart itself is redrawn only when the workbook changes.
import { css, h, on } from '../../core/dom.ts';
import type { MenuItem } from '../../shell/menu.ts';
import type { Shell } from '../../shell/types.ts';
import {
  CHART_LABEL, CHART_TYPES, chartData, chartFromRange, describeChart, drawChart, plainRef, refRange, refText, SERIES_COLOURS, switchRowCol,
  type Chart, type ChartType,
} from './chart.ts';
import type { Grid } from './grid.ts';
import { SvgPainter } from './paint.ts';
import { SyntaxProblem } from './refs.ts';
import type { Range, Workbook } from './workbook.ts';

export interface SheetContext {
  shell: Shell;
  wb: Workbook;
  grid: Grid;
  root: HTMLElement;
  signal: AbortSignal;
  /** After the workbook changed: redraw, mark the window as changed, update the toolbar. */
  onChange(): void;
  report(error: unknown): Promise<void>;
}

const COLOUR_NAMES: Array<[string, string]> = [
  ['Blue', '#4472c4'], ['Orange', '#ed7d31'], ['Grey', '#a5a5a5'], ['Gold', '#ffc000'], ['Light blue', '#5b9bd5'], ['Green', '#70ad47'],
  ['Dark blue', '#264478'], ['Brown', '#9e480e'], ['Dark grey', '#636363'], ['Red', '#d13438'], ['Purple', '#7a3fa0'], ['Black', '#000000'],
];

/** Small pictures of each kind of chart, for the Insert tab. */
export function chartIcon(type: ChartType): SVGElement {
  const p = new SvgPainter(20, 20, { class: 'chart-icon', 'aria-hidden': 'true' });
  const blue = '#4472c4';
  const orange = '#ed7d31';
  switch (type) {
    case 'column': p.rect(3, 9, 4, 9, blue); p.rect(8, 4, 4, 14, orange); p.rect(13, 11, 4, 7, blue); break;
    case 'bar': p.rect(2, 3, 9, 4, blue); p.rect(2, 8, 15, 4, orange); p.rect(2, 13, 7, 4, blue); break;
    case 'line': p.line([2, 15, 7, 8, 12, 11, 18, 3], blue, 2); break;
    case 'area': p.shape([2, 18, 2, 12, 8, 6, 13, 10, 18, 4, 18, 18], blue); break;
    case 'pie': p.circle(10, 10, 8, blue); p.shape([10, 10, 10, 2, 17.6, 7.5], orange); break;
    case 'doughnut': p.circle(10, 10, 8, blue); p.shape([10, 10, 10, 2, 17.6, 7.5], orange); p.circle(10, 10, 4, '#ffffff'); break;
    case 'scatter': for (const [x, y] of [[4, 14], [7, 9], [11, 11], [15, 5], [16, 9]]) p.circle(x, y, 1.8, blue); break;
  }
  return p.root;
}

export interface ChartLayer {
  /** A new chart of the selected cells. */
  insert(type: ChartType): void;
  /** The selected chart's number, if one is selected. */
  selected(): number | null;
  deselect(): void;
  /** Opens the Chart dialog for the selected chart. */
  editSelected(): void;
}

export function mountCharts(ctx: SheetContext): ChartLayer {
  const { shell, wb, grid, signal } = ctx;
  const clipBox = h('div', { class: 'chart-clip' });
  const layer = h('div', { class: 'chart-layer' }, clipBox);
  grid.el.append(layer);
  const frames = new Map<number, { el: HTMLElement; key: string }>();
  let selected: number | null = null;
  let sheetShown = -1;

  const sheet = () => wb.sheets[wb.active];
  const chartOf = (id: number) => sheet().charts.find(c => c.id === id) ?? null;

  /** Where a chart's top-left corner is on screen, inside the clip box. */
  const placeOf = (ch: Chart) => {
    const z = grid.zoom();
    const b = grid.cellBox(ch.at.col, ch.at.row);
    const edge = grid.scrollEdge();
    return { x: b.x + ch.at.dx * z - edge.x, y: b.y + ch.at.dy * z - edge.y, w: ch.w * z, h: ch.h * z };
  };

  function render(ch: Chart): SVGElement {
    const data = chartData(wb, wb.active, ch);
    const p = new SvgPainter(ch.w, ch.h, { class: 'chart-svg', role: 'img', 'aria-label': describeChart(ch, data) });
    drawChart(p, ch, data, ch.w, ch.h);
    return p.root;
  }

  /** Puts every frame where its chart is, redrawing the ones that changed. Called after each grid redraw. */
  function sync(): void {
    const edge = grid.scrollEdge();
    // Inside the cells: not over the headings, the frozen rows and columns, or the scroll bars.
    const view = grid.viewSize();
    css(clipBox, { left: edge.x, top: edge.y, width: Math.max(0, view.w - edge.x), height: Math.max(0, view.h - edge.y) });
    if (sheetShown !== wb.active) {
      for (const f of frames.values()) f.el.remove();
      frames.clear();
      selected = null;
      sheetShown = wb.active;
    }
    const charts = sheet().charts;
    const keep = new Set(charts.map(c => c.id));
    for (const [id, f] of frames) {
      if (!keep.has(id)) {
        f.el.remove();
        frames.delete(id);
        if (selected === id) selected = null;
      }
    }
    const z = grid.zoom();
    charts.forEach((ch, order) => {
      // Redrawn when the chart or anything in the workbook changed (its numbers may have).
      const key = `${wb.version}|${JSON.stringify(ch)}`;
      let f = frames.get(ch.id);
      if (!f) {
        f = { el: frame(ch.id), key: '' };
        frames.set(ch.id, f);
      }
      if (f.key !== key) {
        f.el.querySelector('.chart-svg')?.remove();
        f.el.prepend(render(ch));
        f.key = key;
      }
      const svgEl = f.el.querySelector('.chart-svg');
      svgEl?.setAttribute('width', String(Math.round(ch.w * z)));
      svgEl?.setAttribute('height', String(Math.round(ch.h * z)));
      const at = placeOf(ch);
      css(f.el, { left: Math.round(at.x), top: Math.round(at.y), width: Math.round(at.w), height: Math.round(at.h), 'z-index': order + 1 });
      f.el.classList.toggle('selected', ch.id === selected);
      if (f.el.parentElement !== clipBox) clipBox.append(f.el);
    });
  }

  function select(id: number | null, focus = true): void {
    selected = id;
    for (const [fid, f] of frames) f.el.classList.toggle('selected', fid === id);
    if (id !== null && focus) frames.get(id)?.el.focus({ preventScroll: true });
  }

  /** A chart's frame: the drawing, and four corner handles shown while it is selected. */
  function frame(id: number): HTMLElement {
    const el = h('div', { class: 'chart-frame', tabindex: 0, role: 'group', 'aria-roledescription': 'chart', 'aria-label': 'Chart: Enter to change it, Delete to delete it, arrow keys to move it' });
    const handles = (['nw', 'ne', 'sw', 'se'] as const).map(corner => {
      const handle = h('div', { class: `chart-handle ${corner}`, 'aria-hidden': 'true' });
      on(handle, 'pointerdown', (event: PointerEvent) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        drag(id, event, corner);
      }, signal);
      return handle;
    });
    el.append(...handles);
    on(el, 'pointerdown', (event: PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      if (!grid.commit()) return;
      select(id);
      drag(id, event, null);
    }, signal);
    on(el, 'dblclick', () => void edit(id), signal);
    on(el, 'wheel', (event: WheelEvent) => {
      // The grid scrolls under a chart, as it would anywhere else.
      if (event.ctrlKey) return;
      event.preventDefault();
      grid.scrollBy(event.deltaX, event.deltaY);
    }, signal, { passive: false });
    on(el, 'keydown', (event: KeyboardEvent) => {
      const ch = chartOf(id);
      if (!ch) return;
      const step = event.shiftKey ? 10 : 1;
      const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        remove(id);
      } else if (event.key === 'Enter' || event.key === 'F2') {
        event.preventDefault();
        void edit(id);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        select(null);
        grid.focus();
      } else if (moves[event.key]) {
        event.preventDefault();
        const at = placeOf(ch);
        moveTo(ch, at.x + moves[event.key][0] * grid.zoom(), at.y + moves[event.key][1] * grid.zoom());
      } else return;
      event.stopPropagation();
    }, signal);
    on(el, 'focus', () => select(id, false), signal);
    on(el, 'contextmenu', (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      select(id);
      shell.menus.show(menuFor(id), event.clientX, event.clientY, { returnFocus: el });
    }, signal);
    return el;
  }

  /** Moves a chart so its top-left corner is at (x, y) in the clip box: its cell and the offset into it are worked out. */
  function moveTo(ch: Chart, x: number, y: number, size?: { w: number; h: number }): void {
    const edge = grid.scrollEdge();
    const spot = grid.cellAt(Math.max(edge.x, x + edge.x), Math.max(edge.y, y + edge.y));
    const next: Chart = { ...ch, at: { col: spot.col, row: spot.row, dx: Math.round(spot.dx), dy: Math.round(spot.dy) }, ...(size ?? {}) };
    if (JSON.stringify(next) === JSON.stringify(ch)) return;
    try {
      wb.setChart(wb.active, ch.id, next);
      ctx.onChange();
      sync();
    } catch (error) {
      void ctx.report(error);
    }
  }

  /** Dragging a chart (corner null) or one of its corners: the frame follows the pointer; the chart changes on release. */
  function drag(id: number, event: PointerEvent, corner: 'nw' | 'ne' | 'sw' | 'se' | null): void {
    const ch = chartOf(id);
    const f = frames.get(id);
    if (!ch || !f) return;
    const start = placeOf(ch);
    const x0 = event.clientX;
    const y0 = event.clientY;
    const z = grid.zoom();
    let box = { ...start };
    const target = event.target as HTMLElement;
    target.setPointerCapture(event.pointerId);
    const done = new AbortController();
    on(target, 'pointermove', (e: PointerEvent) => {
      const dx = e.clientX - x0;
      const dy = e.clientY - y0;
      if (!corner) box = { ...start, x: start.x + dx, y: start.y + dy };
      else {
        const minW = 120 * z;
        const minH = 80 * z;
        let { x, y, w, h: hh } = start;
        if (corner.includes('e')) w = Math.max(minW, start.w + dx);
        if (corner.includes('s')) hh = Math.max(minH, start.h + dy);
        if (corner.includes('w')) {
          w = Math.max(minW, start.w - dx);
          x = start.x + start.w - w;
        }
        if (corner.includes('n')) {
          hh = Math.max(minH, start.h - dy);
          y = start.y + start.h - hh;
        }
        box = { x, y, w, h: hh };
      }
      css(f.el, { left: Math.round(box.x), top: Math.round(box.y), width: Math.round(box.w), height: Math.round(box.h) });
      const svgEl = f.el.querySelector('.chart-svg');
      svgEl?.setAttribute('width', String(Math.round(box.w)));
      svgEl?.setAttribute('height', String(Math.round(box.h)));
    }, done.signal);
    const end = () => {
      done.abort();
      if (Math.abs(box.x - start.x) < 1 && Math.abs(box.y - start.y) < 1 && Math.abs(box.w - start.w) < 1 && Math.abs(box.h - start.h) < 1) return;
      moveTo(ch, box.x, box.y, corner ? { w: Math.round(box.w / z), h: Math.round(box.h / z) } : undefined);
      f.el.focus({ preventScroll: true });
    };
    on(target, 'pointerup', end, done.signal);
    on(target, 'pointercancel', () => {
      done.abort();
      sync();
    }, done.signal);
  }

  function remove(id: number): void {
    wb.setChart(wb.active, id, null);
    selected = null;
    ctx.onChange();
    sync();
    grid.focus();
    shell.toast('Chart deleted. Ctrl+Z brings it back.');
  }

  function change(id: number, fn: (ch: Chart) => Chart | null): void {
    const ch = chartOf(id);
    if (!ch) return;
    try {
      const next = fn(ch);
      if (!next) return;
      wb.setChart(wb.active, id, next);
      ctx.onChange();
      sync();
    } catch (error) {
      void ctx.report(error);
    }
  }

  function menuFor(id: number): MenuItem[] {
    const ch = chartOf(id);
    if (!ch) return [];
    const round = ch.type === 'pie' || ch.type === 'doughnut';
    return [
      { label: 'Change chart...', hint: 'Enter', action: () => void edit(id) },
      { label: 'Chart type', submenu: CHART_TYPES.map(t => ({ label: CHART_LABEL[t], checked: ch.type === t, action: () => change(id, c => ({ ...c, type: t, legend: (t === 'pie' || t === 'doughnut') && c.legend === 'none' ? 'r' : c.legend })) })) },
      { label: 'Switch row/column', disabled: ch.type === 'scatter', action: () => change(id, c => switchRowCol(wb, wb.active, c) ?? (void shell.dialogs.alert('Switch row/column is not possible here', 'This chart\'s series are not one block of cells on one sheet. Change its data in Change chart.'), null)) },
      { label: 'Legend', submenu: (['r', 'b', 't', 'l', 'none'] as const).map(pos => ({ label: { r: 'Right', b: 'Bottom', t: 'Top', l: 'Left', none: 'None' }[pos], checked: ch.legend === pos, action: () => change(id, c => ({ ...c, legend: pos })) })) },
      { label: round ? 'Show values on the slices' : 'Show values (data labels)', checked: !!ch.labels, action: () => change(id, c => ({ ...c, labels: !c.labels || undefined })) },
      { separator: true },
      { label: 'Bring to front', action: () => { wb.orderChart(wb.active, id, true); ctx.onChange(); sync(); } },
      { label: 'Send to back', action: () => { wb.orderChart(wb.active, id, false); ctx.onChange(); sync(); } },
      { separator: true },
      { label: 'Delete chart', hint: 'Del', danger: true, action: () => remove(id) },
    ];
  }

  /** The one block of cells a chart reads, when it reads one (shown in the dialog as its data). */
  function dataBlock(ch: Chart): string {
    const parts = ch.series.flatMap(x => [x.val, x.cat, x.name.startsWith('=') ? x.name.slice(1) : ''].filter(Boolean).map(t => refRange(wb, wb.active, t)));
    if (!parts.length || parts.some(p => !p) || parts.some(p => p!.s !== parts[0]!.s)) return '';
    const r: Range = {
      c0: Math.min(...parts.map(p => p!.range.c0)), r0: Math.min(...parts.map(p => p!.range.r0)),
      c1: Math.max(...parts.map(p => p!.range.c1)), r1: Math.max(...parts.map(p => p!.range.r1)),
    };
    return plainRef(refText(wb.sheets[parts[0]!.s].name, r));
  }

  /** The Chart dialog: type, title, data, legend, axis titles, labels and colours, with a preview of the result. */
  async function edit(id: number): Promise<void> {
    const original = chartOf(id);
    if (!original) return;
    let draft: Chart = { ...original, series: original.series.map(s => ({ ...s })) };
    const done = new AbortController();
    const typeSel = h('select', { class: 'field', 'aria-label': 'Chart type' }, ...CHART_TYPES.map(t => h('option', { value: t }, CHART_LABEL[t])));
    typeSel.value = draft.type;
    const groupSel = h('select', { class: 'field', 'aria-label': 'Stacking' }, h('option', { value: '' }, 'Side by side'), h('option', { value: 'stacked' }, 'Stacked'), h('option', { value: 'percent' }, 'Stacked to 100%'));
    groupSel.value = draft.group ?? '';
    const title = h('input', { type: 'text', class: 'field', value: draft.title ?? '', placeholder: 'Automatic (the series name, for one series)', maxlength: 255, 'aria-label': 'Title' });
    const noTitle = h('input', { type: 'checkbox' });
    noTitle.checked = draft.title === '';
    const dataInput = h('input', { type: 'text', class: 'field', value: dataBlock(draft), spellcheck: false, autocomplete: 'off', 'aria-label': 'Data (cells)', placeholder: 'Sheet1!A1:C5' });
    const switchBtn = h('button', { type: 'button', class: 'btn' }, 'Switch row/column');
    const legendSel = h('select', { class: 'field', 'aria-label': 'Legend' }, ...(['r', 'b', 't', 'l', 'none'] as const).map(pos => h('option', { value: pos }, { r: 'Right', b: 'Bottom', t: 'Top', l: 'Left', none: 'None' }[pos])));
    legendSel.value = draft.legend;
    const xTitle = h('input', { type: 'text', class: 'field', value: draft.xTitle ?? '', maxlength: 255, 'aria-label': 'Horizontal axis title' });
    const yTitle = h('input', { type: 'text', class: 'field', value: draft.yTitle ?? '', maxlength: 255, 'aria-label': 'Vertical axis title' });
    const labels = h('input', { type: 'checkbox' });
    labels.checked = !!draft.labels;
    const problem = h('p', { class: 'dialog-problem', role: 'alert' });
    const seriesBox = h('div', { class: 'chart-series' });
    const preview = h('div', { class: 'chart-preview', 'aria-hidden': 'true' });
    const groupRow = h('label', { class: 'chart-row' }, h('span', {}, 'Columns or bars'), groupSel);
    const axisRows = [h('label', { class: 'chart-row' }, h('span', {}, 'Horizontal axis title'), xTitle), h('label', { class: 'chart-row' }, h('span', {}, 'Vertical axis title'), yTitle)];

    const drawSeries = () => {
      const data = chartData(wb, wb.active, draft);
      const round = draft.type === 'pie' || draft.type === 'doughnut';
      seriesBox.replaceChildren(h('p', { class: 'chart-series-head' }, round ? 'Slices take the standard colours in turn.' : 'Series colours'));
      if (round) return;
      draft.series.forEach((s, i) => {
        const sel = h('select', { class: 'field', 'aria-label': `Colour of ${data.series[i]?.name ?? `series ${i + 1}`}` }, h('option', { value: '' }, `Automatic (${COLOUR_NAMES.find(([, hex]) => hex === SERIES_COLOURS[i % SERIES_COLOURS.length])?.[0] ?? 'standard'})`), ...COLOUR_NAMES.map(([name, hex]) => h('option', { value: hex }, name)));
        sel.value = s.colour ?? '';
        on(sel, 'change', () => {
          draft.series[i] = { ...draft.series[i], colour: sel.value || undefined };
          update();
        }, done.signal);
        const swatch = h('span', { class: 'chart-swatch', 'aria-hidden': 'true' });
        css(swatch, { background: s.colour ?? SERIES_COLOURS[i % SERIES_COLOURS.length] });
        seriesBox.append(h('label', { class: 'chart-row' }, h('span', {}, swatch, ' ', data.series[i]?.name ?? `Series ${i + 1}`), sel));
      });
    };
    const update = () => {
      const t = typeSel.value as ChartType;
      const round = t === 'pie' || t === 'doughnut';
      draft = {
        ...draft, type: t, title: noTitle.checked ? '' : title.value.trim() ? title.value : null, legend: legendSel.value as Chart['legend'],
        xTitle: xTitle.value.trim() || undefined, yTitle: yTitle.value.trim() || undefined, labels: labels.checked || undefined,
        group: groupSel.value && (t === 'column' || t === 'bar' || t === 'area') ? (groupSel.value as 'stacked' | 'percent') : undefined,
      };
      title.disabled = noTitle.checked;
      groupRow.hidden = !(t === 'column' || t === 'bar' || t === 'area');
      for (const r of axisRows) r.hidden = round;
      switchBtn.disabled = t === 'scatter';
      const p = new SvgPainter(draft.w, draft.h, { class: 'chart-svg' });
      drawChart(p, draft, chartData(wb, wb.active, draft), draft.w, draft.h);
      preview.replaceChildren(p.root);
    };
    const readData = () => {
      problem.textContent = '';
      const text = dataInput.value.trim();
      if (!text || text === dataBlock(draft)) return;
      const got = refRange(wb, wb.active, text);
      if (!got) {
        problem.textContent = 'Type the cells as a block, such as A1:C5 or Sheet2!A1:C5.';
        return;
      }
      try {
        const made = chartFromRange(wb, got.s, got.range, draft.type);
        draft = { ...draft, series: made.series };
        drawSeries();
        update();
      } catch (error) {
        problem.textContent = error instanceof SyntaxProblem ? error.message : 'Those cells cannot be charted.';
      }
    };
    for (const el of [typeSel, groupSel, legendSel, labels, noTitle]) on(el, 'change', () => { update(); drawSeries(); }, done.signal);
    for (const el of [title, xTitle, yTitle]) on(el, 'input', update, done.signal);
    on(dataInput, 'change', readData, done.signal);
    on(switchBtn, 'click', () => {
      const sw = switchRowCol(wb, wb.active, draft);
      if (!sw) {
        problem.textContent = 'This chart\'s series are not one block of cells, so rows and columns cannot be switched.';
        return;
      }
      draft = { ...sw, legend: legendSel.value as Chart['legend'] };
      dataInput.value = dataBlock(draft);
      drawSeries();
      update();
    }, done.signal);
    drawSeries();
    update();
    const answer = await shell.dialogs.ask<'ok' | 'delete' | null>({
      title: 'Change chart',
      body: h('div', { class: 'chart-dialog' },
        h('div', { class: 'chart-form' },
          h('label', { class: 'chart-row' }, h('span', {}, 'Chart type'), typeSel),
          groupRow,
          h('label', { class: 'chart-row' }, h('span', {}, 'Title'), title),
          h('label', { class: 'chart-check' }, noTitle, ' No title'),
          h('label', { class: 'chart-row' }, h('span', {}, 'Data (cells)'), dataInput),
          h('div', { class: 'chart-row' }, h('span', {}, ''), switchBtn),
          h('label', { class: 'chart-row' }, h('span', {}, 'Legend'), legendSel),
          ...axisRows,
          h('label', { class: 'chart-check' }, labels, ' Show the values on the chart'),
          seriesBox,
          problem),
        preview),
      buttons: [{ label: 'OK', value: 'ok', primary: true }, { label: 'Delete chart', value: 'delete', danger: true }, { label: 'Cancel', value: null }],
      cancel: null,
      focus: () => typeSel,
    });
    done.abort();
    if (answer === 'delete') remove(id);
    else if (answer === 'ok') {
      readData();
      change(id, () => draft);
      frames.get(id)?.el.focus({ preventScroll: true });
    }
  }

  function insert(type: ChartType): void {
    if (!grid.commit()) return;
    let made;
    try {
      made = chartFromRange(wb, wb.active, grid.sel(), type);
    } catch (error) {
      void ctx.report(error);
      return;
    }
    // Excel's first size (5 by 3 inches), in the middle of what is in view.
    const z = grid.zoom();
    const w = 480;
    const hh = 288;
    const edge = grid.scrollEdge();
    const room = { w: grid.viewSize().w - edge.x, h: grid.viewSize().h - edge.y };
    const x = edge.x + Math.max(8, (room.w - w * z) / 2);
    const y = edge.y + Math.max(8, (room.h - hh * z) / 2);
    const spot = grid.cellAt(x, y);
    try {
      const id = wb.addChart(wb.active, { ...made, at: { col: spot.col, row: spot.row, dx: Math.round(spot.dx), dy: Math.round(spot.dy) }, w, h: hh });
      ctx.onChange();
      sync();
      select(id);
      shell.toast(`${CHART_LABEL[type]} chart added. Drag it to move it, drag a corner to resize it; double-click (or Enter) to change it.`);
    } catch (error) {
      void ctx.report(error);
    }
  }

  // A click on the cells deselects the chart.
  on(grid.el, 'pointerdown', (event: PointerEvent) => {
    if (selected !== null && event.target instanceof Element && !event.target.closest('.chart-frame')) select(null, false);
  }, signal, { capture: true });
  const before = grid.onPaint;
  grid.onPaint = () => {
    before();
    sync();
  };
  sync();

  return {
    insert,
    selected: () => selected,
    deselect: () => select(null, false),
    editSelected: () => {
      if (selected !== null) void edit(selected);
    },
  };
}
