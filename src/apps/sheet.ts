// Spreadsheet: the window around the grid. A File menu, a Home toolbar laid out like a familiar spreadsheet's (clipboard,
// font, alignment, number, editing), the formula bar, sheet tabs, and a status bar that shows the sum, average and
// count of whatever is selected. Opens .sheet files (our own format) and .csv/.tsv (as a new, unsaved workbook).
import { css, h, on } from '../core/dom.ts';
import { formatSize } from '../core/format.ts';
import { baseName, joinPath, nameProblem, parentPath, splitExtension, uniqueName } from '../fs/names.ts';
import type { MenuItem } from '../shell/menu.ts';
import type { AppDef } from '../shell/types.ts';
import { createGrid } from './sheet/grid.ts';
import { addressOf, SyntaxProblem } from './sheet/refs.ts';
import { formatNumber, type CellStyle } from './sheet/values.ts';
import { keyOf, MAX_FILE_BYTES, Workbook, type Range } from './sheet/workbook.ts';
import { APPS } from './catalog.ts';
import { saveOver } from '../shell/savefile.ts';

const PALETTE: Array<[string, string]> = [
  ['White', '#ffffff'], ['Light grey', '#d9d9d9'], ['Grey', '#7f7f7f'], ['Black', '#000000'],
  ['Light red', '#f4b6b0'], ['Red', '#d13438'], ['Dark red', '#7a1f1f'], ['Light orange', '#fbd5a8'],
  ['Orange', '#f2811d'], ['Light yellow', '#fff2a8'], ['Yellow', '#ffd400'], ['Light green', '#c4e6b5'],
  ['Green', '#1e7a45'], ['Dark green', '#124d2b'], ['Light blue', '#b9d7f5'], ['Blue', '#2f6fd0'],
  ['Dark blue', '#1b3f7a'], ['Light purple', '#dcc6ee'], ['Purple', '#7a3fa0'], ['Pink', '#f5b8d8'],
];

export const sheetApp: AppDef = {
  ...APPS.sheet,
  async launch(app, arg) {
    const shell = app.shell;
    app.root.classList.add('sheet');
    const wb = new Workbook();
    let path: string | null = null;
    let loadedModified = 0;
    let savedVersion = wb.version;
    let label = 'Untitled';

    if (arg) {
      try {
        const entry = await shell.fs.stat(arg);
        if (!entry || entry.kind !== 'file') throw new SyntaxProblem('That file is not there any more. It may have been moved or deleted.');
        if (entry.size > MAX_FILE_BYTES) throw new SyntaxProblem(`This file is ${formatSize(entry.size)}. The spreadsheet opens files up to ${formatSize(MAX_FILE_BYTES)}.`);
        const bytes = await shell.fs.readFile(arg);
        const name = baseName(arg);
        const ext = splitExtension(name)[1].toLowerCase();
        const text = new TextDecoder('utf-8').decode(bytes);
        if (ext === '.csv' || ext === '.tsv' || ext === '.txt') {
          wb.importText(0, 0, 0, text);
          label = name;
        } else {
          try {
            wb.load(JSON.parse(text));
          } catch (error) {
            if (error instanceof SyntaxProblem) throw error;
            throw new SyntaxProblem('This is not a spreadsheet this app can open (it is not a saved spreadsheet).');
          }
          path = arg;
          loadedModified = entry.modified;
          label = name;
        }
        // An opened file starts clean, with nothing to undo.
        wb.load(JSON.parse(wb.serialize()));
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
    const report = async (error: unknown) => {
      if (error instanceof SyntaxProblem) await shell.dialogs.alert('That could not be done', error.message);
      else await shell.report('The spreadsheet could not do that', error);
    };
    const doStyle = (patch: (old: CellStyle) => CellStyle) => {
      if (!grid.commit()) return;
      try {
        wb.setStyle(wb.active, grid.sel(), patch);
        grid.widen(grid.sel());
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
        ribbon.append(box);
        const r = b.getBoundingClientRect();
        const host = ribbon.getBoundingClientRect();
        css(box, { left: Math.min(r.left - host.left, host.width - 190), top: r.bottom - host.top });
        palette = box;
      }, app.signal);
      return b;
    };
    const fillBtn = paletteButton('A', 'Fill colour', 'fill', '#ffd400');
    const colorBtn = paletteButton('A', 'Text colour', 'color', '#d13438');

    const bordersBtn = h('button', { type: 'button', class: 'rb wide-rb', title: 'Borders', 'aria-label': 'Borders', 'aria-haspopup': 'true' }, h('span', { class: 'rb-a' }, '▦'), h('span', { class: 'rb-caret', 'aria-hidden': 'true' }, '▾'));
    on(bordersBtn, 'click', () => {
      const r = bordersBtn.getBoundingClientRect();
      const set = (fn: (s: CellStyle, edge: { t: boolean; b: boolean; l: boolean; r: boolean }) => CellStyle) => {
        if (!grid.commit()) return;
        const sel = grid.sel();
        try {
          for (let row = sel.r0; row <= sel.r1; row++) {
            for (let col = sel.c0; col <= sel.c1; col++) {
              wb.setStyle(wb.active, { c0: col, r0: row, c1: col, r1: row }, s => fn(s, { t: row === sel.r0, b: row === sel.r1, l: col === sel.c0, r: col === sel.c1 }));
            }
          }
          onChange();
        } catch (error) {
          void report(error);
        }
      };
      const items: MenuItem[] = [
        { label: 'All borders', action: () => set(s => ({ ...s, bt: true, bb: true, bl: true, br: true })) },
        { label: 'Outside borders', action: () => set((s, e) => ({ ...s, bt: s.bt || e.t, bb: s.bb || e.b, bl: s.bl || e.l, br: s.br || e.r })) },
        { label: 'Bottom border', action: () => set((s, e) => ({ ...s, bb: s.bb || e.b })) },
        { label: 'Top border', action: () => set((s, e) => ({ ...s, bt: s.bt || e.t })) },
        { separator: true },
        { label: 'No borders', action: () => set(s => ({ ...s, bt: false, bb: false, bl: false, br: false })) },
      ];
      shell.menus.show(items, r.left, r.bottom, { returnFocus: bordersBtn });
    }, app.signal);

    const fmtSelect = h('select', { class: 'rb-select', 'aria-label': 'Number format', title: 'Number format' },
      h('option', { value: '' }, 'General'), h('option', { value: 'number' }, 'Number'), h('option', { value: 'currency' }, 'Currency'),
      h('option', { value: 'comma' }, 'Comma'), h('option', { value: 'percent' }, 'Percent'), h('option', { value: 'text' }, 'Text'));
    on(fmtSelect, 'change', () => {
      const v = fmtSelect.value as CellStyle['fmt'] | '';
      doStyle(s => ({ ...s, fmt: v || undefined, dec: undefined }));
      grid.focus();
    }, app.signal);
    const decimals = (d: number) => doStyle(s => {
      const current = s.dec ?? (s.fmt === 'percent' ? 0 : s.fmt ? 2 : 0);
      const next = Math.max(0, Math.min(15, current + d));
      return { ...s, fmt: s.fmt ?? 'number', dec: next };
    });

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

    const ribbon = h('div', { class: 'ribbon' },
      group('Undo', undoBtn, redoBtn),
      group('Clipboard', btn('Paste', 'Paste (Ctrl+V)', () => grid.paste(), 'text-rb'), btn('Cut', 'Cut (Ctrl+X)', () => grid.copy(true), 'text-rb'), btn('Copy', 'Copy (Ctrl+C)', () => grid.copy(false), 'text-rb')),
      group('Font', boldBtn, italicBtn, underBtn, bordersBtn, fillBtn, colorBtn),
      group('Alignment', ...alignBtns),
      group('Number', fmtSelect, btn('$', 'Currency format', () => doStyle(s => ({ ...s, fmt: 'currency', dec: 2 }))), btn('%', 'Percent format', () => doStyle(s => ({ ...s, fmt: 'percent', dec: 0 }))), btn(',', 'Comma format', () => doStyle(s => ({ ...s, fmt: 'comma', dec: 2 }))), btn('.0→', 'More decimal places', () => decimals(1)), btn('←.0', 'Fewer decimal places', () => decimals(-1))),
      group('Editing', btn('Σ AutoSum', 'AutoSum (Alt+=)', () => grid.autoSum(), 'text-rb'), btn('A→Z', 'Sort A to Z (or smallest first)', () => sortRegion(true), 'text-rb'), btn('Z→A', 'Sort Z to A (or largest first)', () => sortRegion(false), 'text-rb')),
      group('Cells', insertBtn, deleteBtn),
    );

    // ---- File menu -------------------------------------------------------------------------------------------------

    async function save(): Promise<boolean> {
      if (!grid.commit()) return false;
      if (!path) return saveAs();
      try {
        const entry = await saveOver(shell, path, new TextEncoder().encode(wb.serialize()), loadedModified);
        if (!entry) return false;
        loadedModified = entry.modified;
        savedVersion = wb.version;
        refresh();
        shell.toast(`Saved “${entry.name}”.`);
        return true;
      } catch (error) {
        await shell.report('Could not save', error);
        return false;
      }
    }

    async function saveAs(): Promise<boolean> {
      if (!grid.commit()) return false;
      const folder = path ? parentPath(path) : '/Documents';
      let taken: string[] = [];
      try {
        taken = (await shell.fs.list(folder, true)).map(e => e.name);
      } catch {
        // Saving will say the folder is gone.
      }
      const base = label.replace(/\.(csv|tsv|txt|sheet)$/i, '') || 'Spreadsheet';
      const name = await shell.dialogs.prompt({
        title: 'Save as',
        label: `Name (saved in ${folder})`,
        value: uniqueName(`${base}.sheet`, taken),
        ok: 'Save',
        selectStem: true,
        check: v => nameProblem(v) ?? (taken.some(t => t.toLowerCase() === v.toLowerCase()) ? `There is already something called "${v}" here.` : null),
      });
      if (name === null) return false;
      const finalName = /\.sheet$/i.test(name) ? name : `${name}.sheet`;
      try {
        const entry = await shell.fs.writeFile(joinPath(folder, finalName), new TextEncoder().encode(wb.serialize()), { mustBeNew: true });
        path = joinPath(folder, entry.name);
        label = entry.name;
        loadedModified = entry.modified;
        savedVersion = wb.version;
        refresh();
        shell.toast(`Saved “${entry.name}”.`);
        return true;
      } catch (error) {
        await shell.report('Could not save', error);
        return false;
      }
    }

    function exportCsv(): void {
      if (!grid.commit()) return;
      const bytes = new TextEncoder().encode('﻿' + wb.exportText(wb.active, wb.usedRange(wb.active), ','));
      const base = label.replace(/\.(csv|tsv|txt|sheet)$/i, '') || 'Spreadsheet';
      shell.transfers.save(`${base}.csv`, bytes);
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
      shell.menus.show([
        { label: 'Save', hint: 'Ctrl+S', action: () => void save() },
        { label: 'Save as...', hint: 'Ctrl+Shift+S', action: () => void saveAs() },
        { separator: true },
        { label: 'Import CSV from your computer...', action: importFromComputer },
        { label: 'Download as CSV', action: exportCsv },
      ], r.left, r.bottom, { returnFocus: fileBtn });
    }, app.signal);
    const tabsRow = h('div', { class: 'ribbon-tabs' }, fileBtn, h('span', { class: 'home-tab', 'aria-current': 'true' }, 'Home'));

    // ---- Formula bar, sheet tabs, status ---------------------------------------------------------------------------

    const formulaBar = h('div', { class: 'formula-bar' }, grid.nameBox, h('span', { class: 'fx', 'aria-hidden': 'true' }, 'fx'), grid.formulaInput);
    const tabs = h('div', { class: 'sheet-tabs', role: 'tablist', 'aria-label': 'Sheets' });
    const stats = h('span', { class: 'sheet-stats' });
    const mode = h('span', { class: 'sheet-mode' }, 'Ready');
    const zoomOut = btn('−', 'Zoom out', () => grid.setZoom(grid.zoom() / 1.1), 'zoom-btn');
    const zoomIn = btn('+', 'Zoom in', () => grid.setZoom(grid.zoom() * 1.1), 'zoom-btn');
    const zoomLabel = h('span', { class: 'zoom-label' }, '100%');
    const status = h('div', { class: 'statusbar sheet-status', role: 'status' }, mode, stats, h('span', { class: 'spacer' }), zoomOut, zoomLabel, zoomIn);
    const tabsBar = h('div', { class: 'tabs-bar' }, tabs);

    function drawTabs(): void {
      const nodes: Node[] = [];
      wb.sheets.forEach((sh, i) => {
        const b = h('button', { type: 'button', class: `sheet-tab${i === wb.active ? ' active' : ''}`, role: 'tab', 'aria-selected': String(i === wb.active), title: 'Double-click to rename' }, sh.name);
        on(b, 'click', () => {
          grid.setActiveSheet(i);
          drawTabs();
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
      const s = activeStyle();
      const press = (b: HTMLElement, on: boolean | undefined) => b.setAttribute('aria-pressed', String(!!on));
      press(boldBtn, s.b);
      press(italicBtn, s.i);
      press(underBtn, s.u);
      (['l', 'c', 'r'] as const).forEach((al, i) => press(alignBtns[i], s.al === al));
      fmtSelect.value = s.fmt ?? '';
      undoBtn.disabled = !wb.canUndo;
      redoBtn.disabled = !wb.canRedo;
      zoomLabel.textContent = `${Math.round(grid.zoom() * 100)}%`;
      updateStats();
    }

    function onChange(): void {
      refresh();
      syncToolbar();
      drawTabs();
      grid.redraw();
    }
    grid.onChange = () => {
      refresh();
      syncToolbar();
      drawTabs();
    };
    grid.onSelect = syncToolbar;
    grid.onEdit = editing => {
      mode.textContent = editing ? 'Edit' : 'Ready';
    };

    app.root.append(tabsRow, ribbon, formulaBar, grid.el, tabsBar, status);
    drawTabs();
    syncToolbar();
    refresh();

    on(app.root, 'keydown', (event: KeyboardEvent) => {
      const ctrl = event.ctrlKey || event.metaKey;
      const k = event.key.toLowerCase();
      if (ctrl && k === 's') {
        event.preventDefault();
        void (event.shiftKey ? saveAs() : save());
      } else if (ctrl && !event.shiftKey && (k === 'b' || k === 'i' || k === 'u') && !(event.target instanceof HTMLInputElement && event.target.type === 'text' && grid.editing())) {
        event.preventDefault();
        if (k === 'b') boldBtn.click();
        else if (k === 'i') italicBtn.click();
        else underBtn.click();
      } else if (event.key === 'Escape' && palette) {
        closePalette();
      }
    }, app.signal);
    on(document, 'pointerdown', (event: PointerEvent) => {
      if (palette && event.target instanceof Node && !palette.contains(event.target) && !(event.target as Element).closest?.('.wide-rb')) closePalette();
    }, app.signal);
    void addressOf;
    grid.focus();
  },
};
