// Small pictures of the screensavers and lock screens for the setup guide (saverform.ts): each is the real thing's
// markup, with the real classes (so its colours, the theme and the dark look all come along), drawn on a 640 x 400 screen
// and scaled down into a tile. Nothing in them can be focused or clicked: inputs and buttons are drawn as spans, and the
// whole picture is inert and hidden from screen readers (the tile's caption names it).
//
// Also the tile row itself: a radio group (one Tab stop; arrow keys move, Space or Enter picks) whose pick is only a
// choice until the guide's Save button keeps it.
import { css, h, on } from '../core/dom.ts';
import type { PublicUser } from '../auth/api.ts';
import { KINDS, sheetTitle } from '../auth/sheetkinds.ts';
import { icon } from './icons.ts';
import type { LockSettings, LockWords, SheetKind } from './session.ts';

/** The size of the screen each picture is drawn on, before it is scaled into its tile. */
export const MINI_W = 640;
export const MINI_H = 400;

const fake = (cls: string, text = '') => h('span', { class: cls }, text);

/** The lock screen of one look, as drawPrompt in auth/lock.ts draws it at first (before any wrong try). */
export function lockMini(look: LockSettings['look'], words: LockWords, user: PublicUser | null): HTMLElement {
  const w = look === 'custom' ? words : null;
  const withPin = !!user?.pin;
  const secret = look === 'default' ? { pin: 'PIN', pass: 'Password' } : { pin: w ? w.pass : 'Code', pass: w ? w.pass : 'Password' };
  const form = h('div', { class: 'gate-form' });
  if (withPin) form.append(h('span', { class: 'gate-row' }, fake('gate-label', secret.pin), fake('field gate-input lock-pin mini-field')));
  else {
    form.append(h('span', { class: 'gate-row' }, fake('gate-label', secret.pass), h('span', { class: 'gate-pass' }, fake('field gate-input mini-field'), fake('btn gate-show', 'Show'))));
    if (user?.totp) form.append(h('span', { class: 'gate-row' }, fake('gate-label', 'Two-step code (or a recovery code)'), fake('field gate-input mini-field')));
  }
  const go = look === 'default' ? 'Unlock' : w ? w.button : 'Continue';
  const other = withPin ? `Use my ${look === 'default' ? 'password' : 'password instead'}` : '';
  form.append(h('div', { class: 'gate-buttons' }, other ? fake('btn', other) : null, fake('btn', 'Sign out'), fake('btn primary gate-go', go)));
  const intro = look === 'default'
    ? (user ? `${user.display} is signed in. ${withPin ? 'Type your PIN to unlock.' : 'Type your password to unlock.'}` : 'Type your password to unlock.')
    : look === 'plain' ? `Enter your ${withPin ? 'code' : 'password'} to continue.` : '';
  return h('div', { class: `gate lock-gate lock-look-${look}` },
    h('div', { class: 'gate-panel' },
      look === 'default' ? h('div', { class: 'gate-brand' }, icon('logo', 40), h('span', {}, 'TOMLIN OS')) : null,
      h('h1', {}, look === 'default' ? 'Locked' : w ? w.title : 'Session timed out'),
      intro ? h('p', { class: 'gate-intro' }, intro) : null,
      form));
}

/** The workbooks the spreadsheet picture shows, one per kind, made once (their numbers are made up, like the real one). */
const books = new Map<SheetKind, Promise<import('../apps/sheet/workbook.ts').Workbook>>();

/** The spreadsheet screensaver: title bar, Home toolbar, formula bar, the grid's first rows, sheet tabs, status bar. */
export function sheetMini(kind: SheetKind, title: string): HTMLElement {
  const name = sheetTitle(kind, title);
  const group = (gname: string, ...labels: string[]) =>
    h('div', { class: 'rgroup' }, h('div', { class: 'rgroup-items' }, ...labels.map(l => fake('rb text-rb', l))), h('div', { class: 'rgroup-name' }, gname));
  const grid = h('div', { class: 'mini-grid' });
  const tabs = h('div', { class: 'sheet-tabs' }, ...[name, ...(KINDS[kind] ?? KINDS.budget).tabs].map((t, i) => h('span', { class: `sheet-tab${i === 0 ? ' active' : ''}` }, t)));
  // The grid's numbers and sums come from the same workbook code as the real screensaver, loaded when first drawn (it is
  // most of the spreadsheet's model, so it is not part of every start).
  let book = books.get(kind);
  if (!book) {
    book = import('../auth/fakebook.ts').then(({ fakeWorkbook }) => fakeWorkbook(kind, ''));
    books.set(kind, book);
  }
  void book.then(wb => {
    const widths = [46, 170, 96, 96, 96, 96, 96, 96, 96];
    const cells: Node[] = [h('span', { class: 'mini-head' })];
    for (let c = 0; c < 8; c++) cells.push(h('span', { class: 'mini-head' }, String.fromCharCode(65 + c)));
    for (let r = 0; r < 18; r++) {
      cells.push(h('span', { class: 'mini-head' }, String(r + 1)));
      for (let c = 0; c < 8; c++) {
        const st = wb.lookOf(0, c, r);
        const v = wb.value(0, c, r);
        const cell = h('span', { class: 'mini-cell' }, wb.display(0, c, r));
        cell.classList.toggle('mini-num', typeof v === 'number' || st?.al === 'r');
        cell.classList.toggle('mini-b', !!st?.b);
        cell.classList.toggle('mini-bb', !!st?.bb);
        if (r === 0 && c === 0) cell.classList.add('mini-spill');
        if (st?.fill) css(cell, { background: st.fill });
        cells.push(cell);
      }
    }
    css(grid, { 'grid-template-columns': widths.map(x => `${x}px`).join(' ') });
    grid.replaceChildren(...cells);
  });
  return h('div', { class: 'saver saver-sheet' },
    h('div', { class: 'sheet fake-sheet' },
      h('div', { class: 'fake-titlebar' }, icon('sheet', 16), h('span', { class: 'mini-sheet-title' }, `${name} - Spreadsheet`), fake('fake-close', '✕')),
      h('div', { class: 'ribbon-tabs' }, fake('file-tab', 'File'), fake('home-tab', 'Home')),
      h('div', { class: 'ribbon' },
        group('Clipboard', 'Paste', 'Cut', 'Copy'), group('Font', 'B', 'I', 'U'), group('Number', '$', '%', ','), group('Editing', 'Σ AutoSum', 'A→Z', 'Z→A')),
      h('div', { class: 'formula-bar' }, fake('name-box mini-box', 'A1'), fake('fx', 'fx'), fake('formula-input mini-box')),
      h('div', { class: 'mini-grid-wrap' }, grid),
      h('div', { class: 'tabs-bar' }, tabs),
      h('div', { class: 'statusbar sheet-status' }, fake('fake-mode', 'Ready'), fake('spacer'), fake('', '100%'))));
}

/** The reader screensaver: a book open at a page (its column, the page), and "Log in for more" in the corner. */
export function readerMini(): HTMLElement {
  const lines = (n: number, cls: string) => Array.from({ length: n }, (_, i) => h('span', { class: `${cls}${i % 5 === 4 ? ' mini-short' : ''}` }));
  return h('div', { class: 'saver saver-reader' },
    h('div', { class: 'mini-reader' },
      h('div', { class: 'mini-r-column' },
        h('span', { class: 'mini-r-ribbon' }),
        h('span', { class: 'mini-r-book' }), h('span', { class: 'mini-r-author' }),
        ...lines(8, 'mini-r-chapter')),
      h('div', { class: 'mini-r-paper' },
        h('span', { class: 'mini-r-heading' }),
        h('div', { class: 'mini-r-flow' }, ...lines(13, 'mini-r-line')),
        h('div', { class: 'mini-r-bottom' }, h('span', { class: 'mini-r-btn' }), h('span', { class: 'mini-r-btn' })))),
    fake('reader-login-link', 'Log in for more'));
}

/** The clock screensaver; it keeps time while it shows. */
export function clockMini(signal: AbortSignal): HTMLElement {
  const time = h('div', { class: 'saver-time' });
  const date = h('div', { class: 'saver-date' });
  const tick = () => {
    const now = new Date();
    time.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    date.textContent = now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
  };
  tick();
  const timer = window.setInterval(tick, 15000);
  signal.addEventListener('abort', () => clearInterval(timer), { once: true });
  return h('div', { class: 'saver saver-clock' }, h('div', { class: 'clock-box' }, time, date));
}

export const blankMini = (): HTMLElement => h('div', { class: 'saver saver-blank' });

export interface Tile<T extends string> {
  value: T;
  name: string;
  draw: () => HTMLElement;
}

export interface TileGroup<T extends string> {
  el: HTMLElement;
  /** The tile picked (not yet saved, perhaps). */
  readonly value: T;
  pick(value: T): void;
  /** Marks the saved one "In use". */
  inUse(value: T): void;
  /** Draws the pictures again (the words or the sheet changed): all of them, or the one given. */
  redraw(only?: T): void;
}

/** A row of picture tiles that works as one radio group. `picked` is told whenever the pick changes. */
export function tileGroup<T extends string>(label: string, tiles: Array<Tile<T>>, start: T, signal: AbortSignal, picked: () => void): TileGroup<T> {
  let value = start;
  let used = start;
  const el = h('div', { class: 'mini-tiles', role: 'radiogroup', 'aria-label': label });
  const parts = tiles.map(t => {
    const screen = h('div', { class: 'mini-screen' });
    css(screen, { width: MINI_W, height: MINI_H });
    const view = h('div', { class: 'mini-view', 'aria-hidden': 'true', inert: true }, screen);
    const use = h('span', { class: 'mini-use' }, 'In use');
    const tile = h('div', { class: 'mini-tile', role: 'radio', tabindex: -1, 'data-value': t.value }, view, h('span', { class: 'mini-name' }, h('span', {}, t.name), use));
    el.append(tile);
    return { t, tile, screen, use };
  });
  const paint = () => {
    for (const p of parts) {
      const on = p.t.value === value;
      p.tile.setAttribute('aria-checked', String(on));
      p.tile.tabIndex = on ? 0 : -1;
      p.use.hidden = p.t.value !== used;
    }
  };
  const choose = (v: T) => {
    if (v === value) return;
    value = v;
    paint();
    picked();
  };
  for (const p of parts) {
    on(p.tile, 'click', () => {
      choose(p.t.value);
      p.tile.focus();
    }, signal);
    on(p.tile, 'keydown', (event: KeyboardEvent) => {
      const i = parts.indexOf(p);
      const k = event.key;
      let to = -1;
      if (k === 'ArrowRight' || k === 'ArrowDown') to = (i + 1) % parts.length;
      else if (k === 'ArrowLeft' || k === 'ArrowUp') to = (i - 1 + parts.length) % parts.length;
      else if (k === 'Home') to = 0;
      else if (k === 'End') to = parts.length - 1;
      else if (k === ' ' || k === 'Enter') {
        event.preventDefault();
        choose(p.t.value);
        return;
      } else return;
      event.preventDefault();
      // The arrows move the focus; Space or Enter picks. The tile with the focus holds the one Tab stop meanwhile.
      for (const q of parts) q.tile.tabIndex = -1;
      parts[to].tile.tabIndex = 0;
      parts[to].tile.focus();
    }, signal);
  }
  // Leaving the row hands its Tab stop back to the picked tile.
  on(el, 'focusout', (event: FocusEvent) => {
    if (!el.contains(event.relatedTarget as Node | null)) paint();
  }, signal);
  const redraw = (only?: T) => {
    for (const p of parts) if (only === undefined || p.t.value === only) p.screen.replaceChildren(p.t.draw());
  };
  redraw();
  paint();
  return {
    el,
    get value() {
      return value;
    },
    pick(v: T) {
      value = v;
      paint();
    },
    inUse(v: T) {
      used = v;
      paint();
    },
    redraw,
  };
}
