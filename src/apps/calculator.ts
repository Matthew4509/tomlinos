// Calculator: a simple calculator on the left; Extend opens a sheet beside it (Label | A | B | =, then two rows of
// sum cells at the bottom). The sums, the left-to-right rule and the loop check are in calculator/model.ts.
//
// Making an "=" cell: click it, press = on the calculator, click a cell, press + − × ÷, click the next cell... and
// = saves it. The cells chosen light up and the display reads "A1 + B3 − A5". Escape stops without saving.
// → cell puts the number on the display into the chosen A or B cell. Sheets save as small .calc files.
import { h, on } from '../core/dom.ts';
import { baseName, joinPath, nameProblem, parentPath, uniqueName } from '../fs/names.ts';
import type { AppDef } from '../shell/types.ts';
import { APPS } from './catalog.ts';
import { saveOver } from '../shell/savefile.ts';
import {
  Calculator, cellId, cellName, describe, emptySheet, evaluate, isSumCell, OPS, parseSheet, show, sumProblem,
  type Col, type Op, type RowId, type SheetData, type Sum,
} from './calculator/model.ts';

const ROW_HEIGHT = 28;
const PAD_WIDTH = 280;
const WIDE_WIDTH = 820;
const MAX_FILE = 256 * 1024;

export const calculatorApp: AppDef = {
  ...APPS.calculator,
  async launch(app, arg) {
    const shell = app.shell;
    app.root.classList.add('calc');
    const calc = new Calculator();
    let data: SheetData = emptySheet();
    let savedJson = JSON.stringify(data);
    let path: string | null = null;
    let loadedModified = 0;
    let selected: string | null = null;
    let building: { target: string; sum: Sum; op: Op | null } | null = null;
    let open = false;

    // ---- The calculator (left) ----
    const history = h('div', { class: 'calc-history', 'aria-hidden': 'true' });
    const display = h('output', { class: 'calc-display', 'aria-live': 'polite', 'aria-label': 'Display' });
    const key = (label: string, cls: string, title = label) => h('button', { type: 'button', class: `calc-key ${cls}`, title, 'aria-label': title, 'data-key': label }, label);
    const keys = h('div', { class: 'calc-keys' },
      key('CE', 'fn', 'Clear entry'), key('C', 'fn', 'Clear all (Escape)'), key('⌫', 'fn', 'Back one digit'), key('÷', 'op', 'Divide'),
      key('7', 'num'), key('8', 'num'), key('9', 'num'), key('×', 'op', 'Times'),
      key('4', 'num'), key('5', 'num'), key('6', 'num'), key('−', 'op', 'Minus'),
      key('1', 'num'), key('2', 'num'), key('3', 'num'), key('+', 'op', 'Plus'),
      key('±', 'fn', 'Change sign'), key('0', 'num'), key('.', 'num', 'Decimal point'), key('=', 'eq', 'Equals'));
    const extendBtn = h('button', { type: 'button', class: 'tool wide', 'aria-expanded': 'false', title: 'Open a sheet beside the calculator' }, 'Extend ▸');
    const toCellBtn = h('button', { type: 'button', class: 'tool wide', hidden: true, title: 'Put the number on the display into the chosen A or B cell' }, '→ cell');
    const pad = h('div', { class: 'calc-pad', tabindex: '0' }, h('div', { class: 'calc-screen' }, history, display), keys,
      h('div', { class: 'calc-actions' }, extendBtn, toCellBtn));

    // ---- The sheet (right) ----
    const saveBtn = h('button', { type: 'button', class: 'tool wide', title: 'Save the sheet (Ctrl+S)' }, 'Save');
    const saveAsBtn = h('button', { type: 'button', class: 'tool wide', title: 'Save a copy under another name' }, 'Save as...');
    const clearBtn = h('button', { type: 'button', class: 'tool wide', title: 'Empty the chosen cell (Delete)' }, 'Clear cell');
    const note = h('div', { class: 'calc-note', role: 'status' });
    const grid = h('div', { class: 'calc-grid', role: 'grid', 'aria-label': 'Sheet' });
    const sheet = h('div', { class: 'calc-sheet', hidden: true }, h('div', { class: 'toolbar' }, saveBtn, saveAsBtn, clearBtn), note, grid);
    app.root.append(pad, sheet);

    const cells = new Map<string, HTMLElement>();
    const dirty = () => JSON.stringify(data) !== savedJson;
    const title = () => {
      app.setTitle(path ? `${baseName(path)} - Calculator` : 'Calculator');
      app.setDirty(dirty());
    };

    function paint() {
      display.textContent = building ? describe(building.sum, data.rows, building.op) || 'Click a cell' : calc.display;
      history.textContent = building ? `Making ${cellName(building.target, data.rows)}:  = saves, Esc stops` : calc.history;
      display.classList.toggle('building', !!building);
      for (const b of keys.querySelectorAll<HTMLElement>('.calc-key.op')) b.classList.toggle('on', !building && calc.op === b.dataset.key && calc.fresh);
      toCellBtn.hidden = !open;
      // Show which key comes next: = after choosing an "=" cell; + − × ÷ after clicking a cell for a sum.
      const wantsEquals = !building && open && selected !== null && isSumCell(selected);
      const wantsOp = !!building && building.sum.refs.length > 0 && building.op === null;
      keys.querySelector('.calc-key.eq')!.classList.toggle('gleam', wantsEquals);
      for (const b of keys.querySelectorAll<HTMLElement>('.calc-key.op')) b.classList.toggle('gleam', wantsOp);
    }

    function recalc() {
      const values = evaluate(data);
      for (const [id, el] of cells) {
        if (!isSumCell(id)) continue;
        const v = values.get(id);
        const box = el.querySelector('.calc-sum')!;
        if (typeof v === 'string') {
          box.textContent = v;
          el.title = v;
          el.classList.add('problem');
        } else {
          box.textContent = v === undefined ? '' : show(v);
          el.title = data.sums[id] ? `${cellName(id, data.rows)} = ${describe(data.sums[id], data.rows)}` : `${cellName(id, data.rows)}: click, then press = on the calculator to make a sum`;
          el.classList.remove('problem');
        }
      }
      for (const [id, el] of cells) {
        el.classList.toggle('chosen', id === selected);
        el.classList.toggle('lit', !!building && (building.sum.refs.includes(id) || building.target === id));
        el.classList.toggle('target', !!building && building.target === id);
      }
      title();
    }

    /** Rows fixed height, as many as fit, never fewer than the rows that hold something. */
    function fitRows() {
      const room = Math.floor((grid.clientHeight || 360) / ROW_HEIGHT) - 3;
      let used = 1;
      for (const id of [...Object.keys(data.values), ...Object.keys(data.sums), ...Object.values(data.sums).flatMap(s => s.refs)]) {
        const n = Number(id.slice(1));
        if (Number.isInteger(n)) used = Math.max(used, n);
      }
      const rows = Math.max(5, used, room);
      if (rows !== data.rows || cells.size === 0) {
        data.rows = rows;
        build();
      }
    }

    function build() {
      cells.clear();
      const head = h('div', { class: 'calc-row head', role: 'row' },
        h('span', { class: 'calc-no', role: 'columnheader' }, ''),
        ...['Label', 'A', 'B', '='].map(t => h('span', { class: 'calc-h', role: 'columnheader' }, t)));
      const rowIds: RowId[] = [...Array.from({ length: data.rows }, (_, i) => i + 1), 'f1', 'f2'];
      const rows = rowIds.map((row, i) => {
        const foot = typeof row === 'string';
        return h('div', { class: `calc-row${foot ? ' foot' : ''}${row === 'f1' ? ' first-foot' : ''}`, role: 'row' },
          h('span', { class: 'calc-no', role: 'rowheader' }, String(i + 1)),
          ...(['L', 'A', 'B', 'R'] as Col[]).map(col => cell(cellId(col, row))));
      });
      grid.replaceChildren(head, ...rows);
      recalc();
    }

    function cell(id: string): HTMLElement {
      const col = id[0] as Col;
      let el: HTMLElement;
      if (isSumCell(id)) {
        el = h('div', { class: 'calc-cell sum', role: 'gridcell', tabindex: '-1', 'data-id': id }, h('span', { class: 'calc-sum' }));
      } else if (col === 'L' && id.includes('f')) {
        el = h('div', { class: 'calc-cell blank', role: 'gridcell', 'data-id': id });
      } else {
        const input = h('input', {
          type: 'text', class: `calc-input${col === 'L' ? '' : ' num'}`, value: data.values[id] ?? '', spellcheck: false, autocomplete: 'off',
          inputmode: col === 'L' ? 'text' : 'decimal', maxlength: col === 'L' ? 60 : 20, 'aria-label': cellName(id, data.rows),
        });
        el = h('div', { class: `calc-cell${col === 'L' ? ' label' : ''}`, role: 'gridcell', 'data-id': id }, input);
        on(input, 'input', () => {
          if (col !== 'L') input.classList.toggle('bad', input.value.trim() !== '' && !Number.isFinite(Number(input.value.replace(/,/g, ''))));
          if (input.value === '') delete data.values[id];
          else data.values[id] = input.value;
          recalc();
        }, app.signal);
        on(input, 'focus', () => choose(id), app.signal);
      }
      // While making a sum, a click picks the cell instead of typing in it.
      on(el, 'mousedown', (event: MouseEvent) => {
        if (building) {
          event.preventDefault();
          pick(id);
        }
      }, app.signal);
      on(el, 'click', () => !building && choose(id), app.signal);
      cells.set(id, el);
      return el;
    }

    function choose(id: string) {
      selected = id;
      if (isSumCell(id)) {
        cells.get(id)?.focus();
        note.textContent = data.sums[id]
          ? `${cellName(id, data.rows)} = ${describe(data.sums[id], data.rows)}. Press = on the calculator to make it again, or Delete to empty it.`
          : `${cellName(id, data.rows)} is a sum cell. Press = on the calculator, then click cells and press + − × ÷ between them.`;
      } else note.textContent = id[0] === 'L' ? 'Labels are text only.' : '→ cell puts the calculator\'s number here.';
      paint();
      recalc();
    }

    function pick(id: string) {
      if (!building) return;
      if (id[0] === 'L') {
        note.textContent = 'Labels are text, so a sum cannot use them. Click an A, B or = cell.';
        return;
      }
      const { sum } = building;
      const wantsCell = sum.refs.length === 0 || building.op !== null;
      if (wantsCell) {
        if (building.op) sum.ops.push(building.op);
        sum.refs.push(id);
        building.op = null;
      } else {
        // Clicking again before an operator swaps the last cell.
        sum.refs[sum.refs.length - 1] = id;
      }
      note.textContent = 'Press + − × ÷ for the next cell, or = to save.';
      paint();
      recalc();
    }

    function startSum(target: string) {
      building = { target, sum: { refs: [], ops: [] }, op: null };
      note.textContent = `Making ${cellName(target, data.rows)}: click a cell.`;
      paint();
      recalc();
    }

    function finishSum() {
      if (!building) return;
      const { target, sum } = building;
      const problem = sumProblem(data, target, sum);
      if (problem) {
        note.textContent = problem;
        return;
      }
      data.sums[target] = { refs: [...sum.refs], ops: [...sum.ops] };
      building = null;
      selected = null; // the next = is the calculator's own again
      note.textContent = `Saved ${cellName(target, data.rows)} = ${describe(data.sums[target], data.rows)}.`;
      paint();
      recalc();
    }

    function stopSum() {
      if (!building) return;
      building = null;
      selected = null;
      note.textContent = 'Stopped. Nothing was changed.';
      paint();
      recalc();
    }

    function press(k: string) {
      if (building) {
        if (k === '=') return finishSum();
        if (k === 'C') return stopSum();
        if (OPS.includes(k as Op)) {
          if (building.sum.refs.length === 0) note.textContent = 'Click a cell first.';
          else building.op = k as Op;
          return paint();
        }
        if (k === '⌫' && building.op) {
          building.op = null;
          return paint();
        }
        note.textContent = 'While making a sum: click cells, press + − × ÷ between them, = to save, Esc to stop.';
        return;
      }
      if (k === '=' && open && selected && isSumCell(selected)) return startSum(selected);
      if (/^[\d.]$/.test(k)) calc.digit(k);
      else if (OPS.includes(k as Op)) calc.operator(k as Op);
      else if (k === '=') calc.equals();
      else if (k === 'C') calc.clear();
      else if (k === 'CE') calc.clearEntry();
      else if (k === '⌫') calc.back();
      else if (k === '±') calc.negate();
      paint();
    }

    function toCell() {
      if (!selected || isSumCell(selected) || selected[0] === 'L') {
        note.textContent = 'Click an A or B cell first; → cell puts the calculator\'s number there.';
        return;
      }
      if (calc.error) return;
      data.values[selected] = show(calc.value);
      const input = cells.get(selected)?.querySelector('input');
      if (input) {
        input.value = data.values[selected];
        input.classList.remove('bad');
      }
      note.textContent = `Put ${data.values[selected]} in ${cellName(selected, data.rows)}.`;
      recalc();
    }

    function clearCell() {
      if (!selected) return;
      if (data.sums[selected]) delete data.sums[selected];
      delete data.values[selected];
      const input = cells.get(selected)?.querySelector('input');
      if (input) input.value = '';
      note.textContent = `Emptied ${cellName(selected, data.rows)}.`;
      recalc();
    }

    function setOpen(value: boolean) {
      open = value;
      sheet.hidden = !value;
      app.root.classList.toggle('wide', value);
      extendBtn.textContent = value ? '◂ Fold' : 'Extend ▸';
      extendBtn.setAttribute('aria-expanded', String(value));
      app.setWidth(value ? WIDE_WIDTH : PAD_WIDTH + 16);
      if (value) requestAnimationFrame(() => fitRows());
      else stopSum();
      paint();
      title();
    }

    // ---- Files ----
    const encoded = () => new TextEncoder().encode(JSON.stringify(data, null, 1));
    const markSaved = (modified: number) => {
      loadedModified = modified;
      savedJson = JSON.stringify(data);
      title();
    };

    async function saveAs(): Promise<boolean> {
      const folder = path ? parentPath(path) : '/Documents';
      let taken: string[] = [];
      try {
        taken = (await shell.fs.list(folder, true)).map(e => e.name);
      } catch {
        // Saving will say what is wrong.
      }
      const name = await shell.dialogs.prompt({
        title: 'Save sheet',
        label: `Name (saved in ${folder})`,
        value: uniqueName(path ? baseName(path) : 'Sums.calc', taken),
        ok: 'Save',
        selectStem: true,
        check: v => nameProblem(v) ?? (taken.some(t => t.toLowerCase() === v.toLowerCase()) ? `There is already something called "${v}" here.` : null),
      });
      if (name === null) return false;
      const finalName = /\.calc$/i.test(name) ? name : `${name}.calc`;
      try {
        const entry = await shell.fs.writeFile(joinPath(folder, finalName), encoded(), { mustBeNew: true });
        path = joinPath(folder, entry.name);
        markSaved(entry.modified);
        shell.toast(`Saved “${entry.name}”.`);
        return true;
      } catch (error) {
        await shell.report('Could not save', error);
        return false;
      }
    }

    async function save(): Promise<boolean> {
      if (!path) return saveAs();
      try {
        const entry = await saveOver(shell, path, encoded(), loadedModified);
        if (!entry) return false;
        markSaved(entry.modified);
        shell.toast(`Saved “${entry.name}”.`);
        return true;
      } catch (error) {
        await shell.report('Could not save', error);
        return false;
      }
    }

    if (arg) {
      try {
        const entry = await shell.fs.stat(arg);
        if (!entry || entry.kind !== 'file') throw new Error('gone');
        if (entry.size > MAX_FILE) throw new SyntaxError('too big');
        data = parseSheet(new TextDecoder().decode(await shell.fs.readFile(arg)));
        path = arg;
        loadedModified = entry.modified;
        savedJson = JSON.stringify(data);
      } catch (error) {
        await shell.dialogs.alert('Could not open the sheet', error instanceof SyntaxError
          ? 'This file is not a Calculator sheet, or it is damaged. It is safe where it is; a new sheet was started instead.'
          : 'That file is not there any more. It may have been moved or deleted. A new sheet was started instead.');
      }
    }

    // ---- Wiring ----
    on(keys, 'click', (event: MouseEvent) => {
      const k = (event.target as HTMLElement).closest<HTMLElement>('.calc-key')?.dataset.key;
      if (k) press(k);
    }, app.signal);
    on(extendBtn, 'click', () => setOpen(!open), app.signal);
    on(toCellBtn, 'click', toCell, app.signal);
    on(clearBtn, 'click', clearCell, app.signal);
    on(saveBtn, 'click', () => void save(), app.signal);
    on(saveAsBtn, 'click', () => void saveAs(), app.signal);
    new ResizeObserver(() => open && fitRows()).observe(grid);
    on(app.root, 'keydown', (event: KeyboardEvent) => {
      const typing = (event.target as HTMLElement).tagName === 'INPUT';
      const ctrl = event.ctrlKey || event.metaKey;
      if (ctrl && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (open) void (event.shiftKey ? saveAs() : save());
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        if (building) stopSum();
        else press('C');
        return;
      }
      if (typing || ctrl || event.altKey) return;
      const map: Record<string, string> = { '*': '×', 'x': '×', '/': '÷', '-': '−', '+': '+', 'Enter': '=', '=': '=', 'Backspace': '⌫', ',': '.', 'Delete': 'Delete' };
      const k = /^[\d.]$/.test(event.key) ? event.key : map[event.key];
      if (!k) return;
      event.preventDefault();
      if (k === 'Delete') {
        if (open && selected && !building) clearCell();
        else press('CE');
      } else press(k);
    }, app.signal);

    paint();
    if (arg) setOpen(true);
    pad.focus();
  },
};
