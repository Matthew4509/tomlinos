// The one folder view, used by the desktop and by File Explorer: icons or a list, selection (click, Ctrl, Shift, a
// rubber band, the keyboard), rename in place, cut/copy/paste, drag to move, drop files in from the computer, and
// the right-click menu. Names only ever go into the page as text.
import { css, h, isPrecisePointer, on } from '../core/dom.ts';
import { formatDate, formatSize, plural } from '../core/format.ts';
import { type Entry } from '../fs/fs.ts';
import { joinPath, nameKey, splitPath } from '../fs/names.ts';
import { describeError } from './dialogs.ts';
import { collectDrop } from './transfer.ts';
import { recentlyDragged, watchForDrag } from './dragdrop.ts';
import { fileTypeOf } from './filetypes.ts';
import { isAppShortcut, shortcutIcon, shortcutLabel } from './appshortcut.ts';
import { icon, STANDARD_FOLDERS, type IconName } from './icons.ts';
import { allocate, cellAt, type Cell } from './layout.ts';
import { bindContextMenu, type MenuItem } from './menu.ts';
import type { SortKey } from './session.ts';
import type { Shell } from './types.ts';

export interface VirtualItem {
  key: string;
  name: string;
  icon: () => IconName;
  open: () => void;
  /** Dropping files on it deletes them to the Recycle Bin. */
  dropBin?: boolean;
  /** Extra right-click entries after Open. */
  menu?: () => MenuItem[];
}

export interface ViewOptions {
  shell: Shell;
  host: HTMLElement;
  signal: AbortSignal;
  mode: 'desktop' | 'explorer';
  path: () => string;
  label: string;
  virtual?: VirtualItem[];
  onOpenFolder: (path: string) => void;
  onUp?: () => void;
  onStatus?: (text: string) => void;
  /** Other folders whose changes should redraw this view too (the desktop watches the Recycle Bin's folder). */
  watch?: string[];
}

export interface FolderView {
  refresh(): Promise<void>;
  focus(): void;
  selectedPaths(): string[];
}

interface Item {
  key: string;
  name: string;
  kind: 'file' | 'folder' | 'virtual';
  path: string;
  entry?: Entry;
  virtual?: VirtualItem;
  typeLabel: string;
}

const CELL_W = 96;
const CELL_H = 100;
const PAD = 8;

export function createFolderView(o: ViewOptions): FolderView {
  const { shell, host, signal, mode } = o;
  const desktop = mode === 'desktop';
  let items: Item[] = [];
  let order: Item[] = [];
  let cells = new Map<string, Cell>();
  const selected = new Set<string>();
  let anchor: string | null = null;
  let focusKey: string | null = null;
  let failure: string | null = null;
  let generation = 0;
  let priority: string[] = [];
  let typeBuffer = '';
  let typeTimer = 0;
  const els = new Map<string, HTMLElement>();

  host.classList.add('fv', desktop ? 'fv-desktop' : 'fv-explorer');
  host.setAttribute('role', 'listbox');
  host.setAttribute('aria-multiselectable', 'true');
  host.setAttribute('aria-label', o.label);
  host.tabIndex = -1;

  const prefs = () => shell.session.viewFor(o.path());
  const listMode = () => !desktop && prefs().view === 'list';

  // ---- Loading and drawing -------------------------------------------------------------------------------------

  function compare(a: Item, b: Item): number {
    if (a.kind === 'virtual' || b.kind === 'virtual') return a.kind === 'virtual' ? (b.kind === 'virtual' ? 0 : -1) : 1;
    if ((a.kind === 'folder') !== (b.kind === 'folder')) return a.kind === 'folder' ? -1 : 1;
    const { sort, desc } = prefs();
    let result = 0;
    if (sort === 'size') result = (a.entry?.size ?? 0) - (b.entry?.size ?? 0);
    else if (sort === 'type') result = a.typeLabel.localeCompare(b.typeLabel);
    else if (sort === 'date') result = (a.entry?.modified ?? 0) - (b.entry?.modified ?? 0);
    if (result === 0) result = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    return desc ? -result : result;
  }

  async function refresh(): Promise<void> {
    const mine = ++generation;
    let next: Item[] = [];
    let problem: string | null = null;
    try {
      const path = o.path();
      const entries = await shell.fs.list(path);
      next = entries.map(entry => ({
        key: entry.id,
        name: entry.name,
        kind: entry.kind,
        path: joinPath(path, entry.name),
        entry,
        typeLabel: fileTypeOf(entry.name, entry.kind).label,
      }));
    } catch (error) {
      problem = describeError(error);
    }
    if (mine !== generation) return;
    next.push(...(o.virtual ?? []).map(v => ({ key: v.key, name: v.name, kind: 'virtual' as const, path: '', virtual: v, typeLabel: 'Shortcut' })));
    next.sort(compare);
    items = next;
    failure = problem;
    for (const key of [...selected]) if (!items.some(i => i.key === key)) selected.delete(key);
    if (anchor && !items.some(i => i.key === anchor)) anchor = null;
    if (focusKey && !items.some(i => i.key === focusKey)) focusKey = null;
    render();
  }

  /**
   * An item's element is kept while nothing it shows has changed: rebuilding every element on every
   * change notice (a move finishing, an upload, another tab) replaced the element under the pointer between the two
   * clicks of a double-click, so the double-click was lost, and it cancelled a rename in progress.
   */
  const built = new Map<string, { sig: string; el: HTMLElement }>();
  let renamingKey: string | null = null;
  let listHead: HTMLElement | null = null;
  // Only what changes the element's make-up rebuilds it; names, places and list columns are updated in place, so a
  // folder whose modified time changed (something was moved into it) keeps the element under the pointer.
  const signature = (item: Item) => JSON.stringify([item.kind, iconFor(item), listMode(), item.kind === 'virtual' && !!item.virtual!.dropBin]);

  function render(): void {
    const hadFocus = host.contains(document.activeElement);
    els.clear();
    host.classList.toggle('view-list', listMode());
    host.classList.toggle('view-icons', !listMode());
    if (!desktop) host.setAttribute('data-drop-path', o.path());

    if (desktop) placeIcons();
    order = desktop ? [...items].sort((a, b) => cellOrder(a) - cellOrder(b)) : items;

    const next: Node[] = [];
    if (listMode()) {
      listHead ??= h('div', { class: 'fv-head', 'aria-hidden': 'true' }, h('span', {}, 'Name'), h('span', {}, 'Size'), h('span', {}, 'Type'), h('span', {}, 'Modified'));
      next.push(listHead);
    }
    const live = new Set<string>();
    for (const item of items) {
      live.add(item.key);
      const sig = signature(item);
      let entry = built.get(item.key);
      if (!entry || (entry.sig !== sig && item.key !== renamingKey)) {
        entry = { sig, el: itemElement(item) };
        built.set(item.key, entry);
      } else if (item.key !== renamingKey) {
        updateElement(entry.el, item);
      }
      els.set(item.key, entry.el);
      next.push(entry.el);
      const cell = cells.get(item.key);
      if (desktop && cell) css(entry.el, { left: PAD + cell[0] * CELL_W, top: PAD + cell[1] * CELL_H });
    }
    for (const key of [...built.keys()]) if (!live.has(key)) built.delete(key);
    if (!focusKey || !els.has(focusKey)) focusKey = order[0]?.key ?? null;
    if (!desktop && !items.length) {
      next.push(h('p', { class: 'fv-empty', role: 'status' }, failure ?? 'This folder is empty.'));
    } else if (failure) {
      next.push(h('p', { class: 'fv-empty', role: 'status' }, failure));
    }
    // Only what changed is touched: gone elements are removed and new ones put in their place; a kept element is not
    // taken out and put back (replaceChildren did that to every icon whenever one disappeared).
    const keep = new Set(next);
    for (const n of [...host.childNodes]) if (!keep.has(n)) n.remove();
    next.forEach((n, i) => {
      const here = host.childNodes[i] ?? null;
      if (here !== n) host.insertBefore(n, here);
    });
    paintSelection();
    if (hadFocus && focusKey) els.get(focusKey)?.focus({ preventScroll: true });
    status();
  }

  function cellOrder(item: Item): number {
    const c = cells.get(item.key) ?? [0, 0];
    return c[0] * 1000 + c[1];
  }

  function gridSize(): { cols: number; rows: number } {
    return {
      cols: Math.max(1, Math.floor((host.clientWidth - PAD) / CELL_W)),
      rows: Math.max(1, Math.floor((host.clientHeight - PAD) / CELL_H)),
    };
  }

  /** Desktop only: each icon gets its saved cell, or the next free one (which is then saved). */
  function placeIcons(): void {
    const { cols, rows } = gridSize();
    const saved = shell.session.data.icons;
    const ids = [...priority, ...items.map(i => i.key).filter(k => !priority.includes(k))].filter(k => items.some(i => i.key === k));
    const result = allocate(ids, saved, cols, rows);
    cells = result.cells;
    priority = [];
    let dirty = result.changed;
    for (const [key, cell] of cells) {
      const was = saved[key];
      if (!was || was[0] !== cell[0] || was[1] !== cell[1]) {
        saved[key] = cell;
        dirty = true;
      }
    }
    // Forget cells of things that are gone.
    const known = new Set(items.map(i => i.key));
    for (const key of Object.keys(saved)) {
      if (!known.has(key) && !failure) {
        delete saved[key];
        dirty = true;
      }
    }
    if (dirty) shell.session.touch();
  }

  function iconFor(item: Item): IconName {
    const standard = item.kind === 'folder' && splitPath(item.path).length === 1 ? (`folder-${item.name.toLowerCase()}` as IconName) : null;
    if (item.kind === 'file' && isAppShortcut(item.name)) return shortcutIcon(item.name, shell.apps());
    return item.kind === 'virtual' ? item.virtual!.icon() : standard && STANDARD_FOLDERS.has(standard) ? standard : fileTypeOf(item.name, item.kind).icon;
  }

  function columnTexts(item: Item): string[] {
    const e = item.entry;
    return [e && e.kind === 'file' ? formatSize(e.size) : '', item.typeLabel, e ? formatDate(e.modified) : ''];
  }

  /** Brings a kept element up to date, touching only what differs (text inside it, never the element itself). */
  function updateElement(el: HTMLElement, item: Item): void {
    if (el.title !== item.name) el.title = item.name;
    const drop = item.kind === 'folder' ? item.path : null;
    if (el.getAttribute('data-drop-path') !== drop) {
      if (drop === null) el.removeAttribute('data-drop-path');
      else el.setAttribute('data-drop-path', drop);
    }
    const name = el.querySelector<HTMLElement>('.item-name');
    if (name && name.textContent !== item.name) name.textContent = item.name;
    if (listMode()) {
      const cols = el.querySelectorAll<HTMLElement>('.item-col');
      columnTexts(item).forEach((text, i) => {
        if (cols[i] && cols[i].textContent !== text) cols[i].textContent = text;
      });
    }
  }

  function itemElement(item: Item): HTMLElement {
    const iconName = iconFor(item);
    const el = h(
      'div',
      {
        class: `item${item.kind === 'virtual' ? ' item-virtual' : ''}`,
        role: 'option',
        'aria-selected': 'false',
        tabindex: -1,
        'data-key': item.key,
        'data-drop-path': item.kind === 'folder' ? item.path : null,
        'data-drop-bin': item.kind === 'virtual' && item.virtual!.dropBin ? '' : null,
        title: item.name,
      },
      h('span', { class: 'item-icon' }, icon(iconName, listMode() ? 20 : 40)),
      h('span', { class: 'item-name' }, item.kind === 'file' ? shortcutLabel(item.name) : item.name),
    );
    if (listMode()) el.append(...columnTexts(item).map(text => h('span', { class: 'item-col' }, text)));
    return el;
  }

  function paintSelection(): void {
    const cut = new Set(shell.clipboard?.mode === 'cut' ? shell.clipboard.paths.map(p => nameKey(p)) : []);
    for (const item of items) {
      const el = els.get(item.key);
      if (!el) continue;
      const on = selected.has(item.key);
      el.setAttribute('aria-selected', String(on));
      el.classList.toggle('selected', on);
      el.classList.toggle('cut', item.kind !== 'virtual' && cut.has(nameKey(item.path)));
      el.tabIndex = item.key === focusKey ? 0 : -1;
    }
    if (!items.length) host.tabIndex = 0;
    else host.tabIndex = -1;
  }

  function status(): void {
    const real = items.filter(i => i.kind !== 'virtual').length;
    const n = selected.size;
    o.onStatus?.(n ? `${plural(n, 'item')} selected` : plural(real, 'item'));
  }

  // ---- Selection -----------------------------------------------------------------------------------------------

  function setFocus(key: string | null, scroll = true): void {
    focusKey = key;
    for (const [k, el] of els) el.tabIndex = k === key ? 0 : -1;
    if (key) {
      const el = els.get(key);
      el?.focus({ preventScroll: !scroll });
      if (scroll) el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  function selectOnly(key: string | null): void {
    selected.clear();
    if (key) selected.add(key);
    anchor = key;
    paintSelection();
    status();
  }

  function selectRange(from: string, to: string): void {
    const a = order.findIndex(i => i.key === from);
    const b = order.findIndex(i => i.key === to);
    if (a < 0 || b < 0) return;
    selected.clear();
    for (const item of order.slice(Math.min(a, b), Math.max(a, b) + 1)) selected.add(item.key);
    paintSelection();
    status();
  }

  const selectedItems = () => items.filter(i => selected.has(i.key));
  const realSelected = () => selectedItems().filter(i => i.kind !== 'virtual');

  // ---- Opening, renaming, making -------------------------------------------------------------------------------

  function open(item: Item): void {
    if (item.kind === 'virtual') item.virtual!.open();
    else if (item.kind === 'folder') o.onOpenFolder(item.path);
    else void shell.openPath(item.path);
  }

  function startRename(key: string): void {
    const item = items.find(i => i.key === key);
    const el = els.get(key);
    if (!item || !el || item.kind === 'virtual') return;
    const nameEl = el.querySelector<HTMLElement>('.item-name');
    if (!nameEl) return;
    const input = h('input', { type: 'text', class: 'rename', value: item.name, 'aria-label': `New name for ${item.name}`, spellcheck: false, autocomplete: 'off' });
    const problem = h('span', { class: 'rename-problem', role: 'alert' });
    nameEl.replaceWith(input);
    el.append(problem);
    el.classList.add('renaming');
    renamingKey = key;
    input.focus();
    const dot = item.kind === 'file' ? item.name.lastIndexOf('.') : -1;
    input.setSelectionRange(0, dot > 0 ? dot : item.name.length);
    let done = false;
    const folder = o.path();
    const stop = () => {
      done = true;
      // The element was changed in place for the rename: the next drawing makes it afresh.
      if (renamingKey === key) renamingKey = null;
      built.delete(key);
      void refresh().then(() => {
        const again = els.get(key);
        if (again && host.contains(document.activeElement) === false) again.focus({ preventScroll: true });
      });
    };
    const check = async () => {
      const reason = await shell.actions.nameCheck(folder, item.name, input.value);
      problem.textContent = reason ?? '';
      input.setAttribute('aria-invalid', reason ? 'true' : 'false');
      return reason;
    };
    on(input, 'input', () => void check(), signal);
    on(input, 'keydown', (event: KeyboardEvent) => {
      event.stopPropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        stop();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        void commit(false);
      }
    }, signal);
    on(input, 'blur', () => void commit(true), signal);
    async function commit(fromBlur: boolean): Promise<void> {
      if (done) return;
      const value = input.value;
      if (value === item!.name) return stop();
      const reason = await check();
      if (done) return;
      if (reason) {
        if (!fromBlur) return;
        stop();
        await shell.dialogs.alert('Could not rename', reason);
        return;
      }
      done = true;
      if (renamingKey === key) renamingKey = null;
      built.delete(key);
      const renamed = await shell.actions.rename(item!.path, value);
      if (renamed) focusKey = renamed.id;
      void refresh();
    }
  }

  async function create(kind: 'folder' | 'text' | 'sheet' | 'link'): Promise<void> {
    const entry = await shell.actions.create(kind, o.path());
    if (!entry) return;
    await refresh();
    selectOnly(entry.id);
    setFocus(entry.id);
    startRename(entry.id);
  }

  // ---- Keyboard ------------------------------------------------------------------------------------------------

  function columns(): number {
    if (listMode() || desktop) return 1;
    const first = order[0] && els.get(order[0].key);
    if (!first) return 1;
    let n = 0;
    for (const item of order) if (els.get(item.key)?.offsetTop === first.offsetTop) n++;
    return Math.max(1, n);
  }

  function neighbour(from: number, key: string): number {
    if (!desktop) {
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns(), ArrowDown: columns() }[key] ?? 0;
      return Math.max(0, Math.min(order.length - 1, from + step));
    }
    // On the desktop, Up/Down walk a column and Left/Right jump to the nearest icon in the next column over.
    const here = cells.get(order[from].key) ?? [0, 0];
    if (key === 'ArrowUp') return Math.max(0, from - 1);
    if (key === 'ArrowDown') return Math.min(order.length - 1, from + 1);
    const dir = key === 'ArrowRight' ? 1 : -1;
    let best = -1;
    let bestScore = Infinity;
    order.forEach((item, i) => {
      const c = cells.get(item.key)!;
      if ((c[0] - here[0]) * dir <= 0) return;
      const score = Math.abs(c[0] - here[0]) * 1000 + Math.abs(c[1] - here[1]);
      if (score < bestScore) {
        best = i;
        bestScore = score;
      }
    });
    return best < 0 ? from : best;
  }

  on(host, 'keydown', (event: KeyboardEvent) => {
    if (event.target instanceof HTMLInputElement) return;
    const ctrl = event.ctrlKey || event.metaKey;
    const key = event.key;
    const from = Math.max(0, order.findIndex(i => i.key === focusKey));
    const go = (index: number) => {
      const target = order[index];
      if (!target) return;
      event.preventDefault();
      if (event.shiftKey && anchor) selectRange(anchor, target.key);
      else if (!ctrl) selectOnly(target.key);
      setFocus(target.key);
    };
    if (key.startsWith('Arrow') && order.length) {
      go(neighbour(from, key));
    } else if (key === 'Home') go(0);
    else if (key === 'End') go(order.length - 1);
    else if (key === 'Enter' && !event.altKey) {
      event.preventDefault();
      for (const item of selectedItems().slice(0, 10)) open(item);
    } else if (key === 'Enter' && event.altKey) {
      event.preventDefault();
      const only = realSelected();
      if (only.length === 1) void shell.actions.properties(only[0].path);
    } else if (key === 'F2') {
      event.preventDefault();
      if (selected.size === 1) startRename([...selected][0]);
    } else if (key === 'Delete') {
      event.preventDefault();
      const paths = realSelected().map(i => i.path);
      if (paths.length) void shell.actions.deleteToBin(paths);
    } else if (key === 'F5') {
      event.preventDefault();
      void refresh();
    } else if (key === 'Backspace' && !desktop) {
      event.preventDefault();
      o.onUp?.();
    } else if (key === ' ' && ctrl && focusKey) {
      event.preventDefault();
      if (!selected.delete(focusKey)) selected.add(focusKey);
      anchor = focusKey;
      paintSelection();
      status();
    } else if (ctrl && key.toLowerCase() === 'a') {
      event.preventDefault();
      for (const item of items) selected.add(item.key);
      paintSelection();
      status();
    } else if (ctrl && key.toLowerCase() === 'c') {
      event.preventDefault();
      shell.actions.setClipboard('copy', realSelected().map(i => i.path));
    } else if (ctrl && key.toLowerCase() === 'x') {
      event.preventDefault();
      shell.actions.setClipboard('cut', realSelected().map(i => i.path));
    } else if (ctrl && key.toLowerCase() === 'v') {
      event.preventDefault();
      void shell.actions.paste(o.path());
    } else if (key.length === 1 && !ctrl && !event.altKey && key !== ' ') {
      // Typing letters jumps to the next item whose name starts with them.
      typeBuffer += key.toLowerCase();
      clearTimeout(typeTimer);
      typeTimer = window.setTimeout(() => (typeBuffer = ''), 700);
      const start = typeBuffer.length === 1 ? from + 1 : from;
      const rotated = [...order.slice(start), ...order.slice(0, start)];
      const hit = rotated.find(i => nameKey(i.name).startsWith(typeBuffer));
      if (hit) go(order.indexOf(hit));
    }
  }, signal);

  on(host, 'focusin', (event: FocusEvent) => {
    const el = event.target instanceof Element ? event.target.closest<HTMLElement>('.item') : null;
    if (el?.dataset.key && el.dataset.key !== focusKey) {
      focusKey = el.dataset.key;
      for (const [k, e] of els) e.tabIndex = k === focusKey ? 0 : -1;
    }
  }, signal);

  // ---- Mouse, pen and touch ------------------------------------------------------------------------------------

  const itemOf = (target: EventTarget | null): Item | null => {
    const el = target instanceof Element ? target.closest<HTMLElement>('.item') : null;
    return (el?.dataset.key && items.find(i => i.key === el.dataset.key)) || null;
  };

  on(host, 'pointerdown', (event: PointerEvent) => {
    if (event.button !== 0 || !event.isPrimary) return;
    if (event.target instanceof HTMLInputElement) return;
    const item = itemOf(event.target);
    const ctrl = event.ctrlKey || event.metaKey;
    if (item) {
      focusKey = item.key;
      if (event.shiftKey && anchor) selectRange(anchor, item.key);
      else if (ctrl) {
        if (!selected.delete(item.key)) selected.add(item.key);
        anchor = item.key;
        paintSelection();
        status();
      } else if (!selected.has(item.key)) selectOnly(item.key);
      if (isPrecisePointer(event) && !ctrl && !event.shiftKey) {
        const paths = realSelected().map(i => i.path);
        if (desktop || paths.length) beginItemDrag(event, item, paths);
      }
    } else {
      if (!ctrl) selectOnly(null);
      host.focus({ preventScroll: true });
      if (isPrecisePointer(event)) beginBand(event, ctrl);
    }
  }, signal);

  on(host, 'click', (event: MouseEvent) => {
    if (recentlyDragged() || performance.now() - shell.menus.openedAt < 800) return;
    const item = itemOf(event.target);
    if (!item) return;
    const plain = !(event.ctrlKey || event.metaKey || event.shiftKey);
    if (plain && selected.size > 1 && selected.has(item.key)) selectOnly(item.key);
    // A tap on a touch screen opens the item; there is no double-tap.
    if ((event as PointerEvent).pointerType === 'touch' && plain) open(item);
  }, signal);

  on(host, 'dblclick', (event: MouseEvent) => {
    if (recentlyDragged()) return;
    const item = itemOf(event.target);
    if (item && (event as PointerEvent).pointerType !== 'touch') open(item);
  }, signal);

  function beginItemDrag(event: PointerEvent, item: Item, paths: string[]): void {
    const count = selected.size;
    watchForDrag({
      shell,
      event,
      paths,
      label: count > 1 ? plural(count, 'item') : item.name,
      layer: document.getElementById('layer-drag') ?? document.body,
      onDrop: desktop
        ? (target, x, y) => {
            if (target !== host) return false;
            const box = host.getBoundingClientRect();
            const { cols, rows } = gridSize();
            const to = cellAt(x - box.left - PAD, y - box.top - PAD, CELL_W, CELL_H, cols, rows);
            const from = cells.get(item.key);
            if (!from) return true;
            const moving = selectedItems();
            const saved = shell.session.data.icons;
            priority = moving.map(i => i.key);
            for (const m of moving) {
              const c = cells.get(m.key) ?? from;
              saved[m.key] = [Math.max(0, Math.min(cols - 1, c[0] + to[0] - from[0])), Math.max(0, Math.min(rows - 1, c[1] + to[1] - from[1]))];
            }
            shell.session.touch();
            render();
            return true;
          }
        : undefined,
    });
  }

  function beginBand(event: PointerEvent, additive: boolean): void {
    const base = additive ? new Set(selected) : new Set<string>();
    const start = { x: event.clientX, y: event.clientY };
    const box = host.getBoundingClientRect();
    const band = h('div', { class: 'band', 'aria-hidden': 'true' });
    let shown = false;
    const abort = new AbortController();
    host.setPointerCapture(event.pointerId);
    const finish = () => {
      abort.abort();
      band.remove();
      if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
    };
    on(host, 'pointermove', (e: PointerEvent) => {
      if (!shown && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 4) return;
      if (!shown) {
        host.append(band);
        shown = true;
      }
      const left = Math.min(start.x, e.clientX);
      const top = Math.min(start.y, e.clientY);
      const right = Math.max(start.x, e.clientX);
      const bottom = Math.max(start.y, e.clientY);
      css(band, { left: left - box.left + host.scrollLeft, top: top - box.top + host.scrollTop, width: right - left, height: bottom - top });
      selected.clear();
      for (const key of base) selected.add(key);
      for (const [key, el] of els) {
        const r = el.getBoundingClientRect();
        if (r.right > left && r.left < right && r.bottom > top && r.top < bottom) selected.add(key);
      }
      paintSelection();
      status();
    }, abort.signal);
    on(host, 'pointerup', finish, abort.signal);
    on(host, 'pointercancel', finish, abort.signal);
    on(host, 'lostpointercapture', finish, abort.signal);
  }

  // ---- Files dropped in from the computer ----------------------------------------------------------------------

  const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;
  on(host, 'dragover', (event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    host.classList.add('drop-files');
  }, signal);
  on(host, 'dragleave', (event: DragEvent) => {
    if (event.target === host) host.classList.remove('drop-files');
  }, signal);
  on(host, 'drop', (event: DragEvent) => {
    host.classList.remove('drop-files');
    if (!hasFiles(event)) return;
    event.preventDefault();
    // The entries must be read now, inside the event; collectDrop does that before its first await.
    if (!event.dataTransfer) return;
    const dest = o.path();
    void collectDrop(event.dataTransfer).then(({ picked, problems }) => shell.transfers.upload(picked, dest, problems));
  }, signal);

  // ---- Menus ---------------------------------------------------------------------------------------------------

  function sortMenu(): MenuItem[] {
    const p = prefs();
    const set = (sort: SortKey, desc: boolean) => () => {
      shell.session.setView(o.path(), { ...p, sort, desc });
      if (desktop) {
        // Sorting the desktop lays the icons out again in that order.
        for (const item of items) delete shell.session.data.icons[item.key];
      }
      void refresh();
    };
    const names: Array<[SortKey, string]> = [['name', 'Name'], ['size', 'Size'], ['type', 'Type'], ['date', 'Date modified']];
    return [
      ...names.map(([key, label]): MenuItem => ({ label, checked: p.sort === key, action: set(key, key === p.sort ? p.desc : false) })),
      { separator: true },
      { label: 'Descending', checked: p.desc, action: set(p.sort, !p.desc) },
    ];
  }

  function viewMenu(): MenuItem[] {
    const p = prefs();
    return (['icons', 'list'] as const).map((view): MenuItem => ({
      label: view === 'icons' ? 'Icons' : 'List',
      checked: p.view === view,
      action: () => {
        shell.session.setView(o.path(), { ...p, view });
        void refresh();
      },
    }));
  }

  bindContextMenu(host, signal, shell.menus, target => {
    const item = itemOf(target);
    if (item) {
      if (!selected.has(item.key)) selectOnly(item.key);
      setFocus(item.key, false);
      const chosen = selectedItems();
      const real = chosen.filter(i => i.kind !== 'virtual');
      if (chosen.length === 1 && chosen[0].kind === 'virtual') {
        return [{ label: 'Open', action: () => open(chosen[0]) }, ...(chosen[0].virtual!.menu?.() ?? [])];
      }
      const one = chosen.length === 1 ? chosen[0] : null;
      const paths = real.map(i => i.path);
      // Open with: the apps for this kind of file, then the two text editors (they refuse what is not text).
      const withApps = one && one.kind === 'file'
        ? [...new Set([...fileTypeOf(one.name).apps, 'editor', 'notepadpro'])].map(id => shell.apps().find(a => a.id === id)).filter(a => a !== undefined)
        : [];
      return [
        { label: 'Open', action: () => chosen.slice(0, 10).forEach(open) },
        ...(withApps.length > 1 ? [{ label: 'Open with', submenu: withApps.map(a => ({ label: a.title, action: () => void shell.openApp(a.id, one!.path) })) }] : []),
        { separator: true },
        { label: 'Cut', hint: 'Ctrl+X', action: () => shell.actions.setClipboard('cut', paths) },
        { label: 'Copy', hint: 'Ctrl+C', action: () => shell.actions.setClipboard('copy', paths) },
        ...(one?.kind === 'folder' && shell.clipboard ? [{ label: 'Paste into folder', action: () => void shell.actions.paste(one.path) }] : []),
        { label: 'Download', disabled: !paths.length, action: () => void shell.transfers.download(paths) },
        { separator: true },
        { label: 'Delete', hint: 'Del', danger: true, action: () => void shell.actions.deleteToBin(paths) },
        { label: 'Rename', hint: 'F2', disabled: !one, action: () => one && startRename(one.key) },
        { separator: true },
        { label: 'Properties', disabled: !one, action: () => one && void shell.actions.properties(one.path) },
      ];
    }
    selectOnly(null);
    return [
      ...(desktop ? [] : [{ label: 'View', submenu: viewMenu() }]),
      { label: desktop ? 'Arrange icons by' : 'Sort by', submenu: sortMenu() },
      { label: 'Refresh', hint: 'F5', action: () => void refresh() },
      { separator: true },
      { label: 'Paste', hint: 'Ctrl+V', disabled: !shell.clipboard, action: () => void shell.actions.paste(o.path()) },
      { separator: true },
      {
        label: 'Upload from your computer',
        submenu: [
          { label: 'Files...', action: () => shell.transfers.choose('files', o.path()) },
          { label: 'Folder...', action: () => shell.transfers.choose('folder', o.path()) },
        ],
      },
      { separator: true },
      {
        label: 'New',
        submenu: [
          { label: 'Folder', action: () => void create('folder') },
          { label: 'Text document', action: () => void create('text') },
          { label: 'Spreadsheet', action: () => void create('sheet') },
          { label: 'Web link...', action: () => void create('link') },
        ],
      },
      { separator: true },
      { label: 'Open Terminal here', action: () => void shell.openApp('terminal', o.path()) },
      ...(desktop ? [{ label: 'Desktop Settings...', action: () => void shell.openApp('settings') }] : []),
      { label: 'Properties', action: () => void shell.actions.properties(o.path()) },
    ];
  });

  // ---- Staying up to date --------------------------------------------------------------------------------------

  shell.changes.on(paths => {
    const mine = nameKey(joinPath(o.path()));
    const watched = (o.watch ?? []).map(w => nameKey(joinPath(w)));
    if (paths.some(p => nameKey(joinPath(p)) === mine || watched.includes(nameKey(joinPath(p))))) void refresh();
  }, signal);
  shell.clipboardChanged.on(paintSelection, signal);

  if (desktop) {
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => items.length && render());
    });
    observer.observe(host);
    signal.addEventListener('abort', () => observer.disconnect(), { once: true });
  }

  return {
    refresh,
    focus: () => (focusKey ? els.get(focusKey) : null)?.focus({ preventScroll: true }) ?? host.focus({ preventScroll: true }),
    selectedPaths: () => realSelected().map(i => i.path),
  };
}

