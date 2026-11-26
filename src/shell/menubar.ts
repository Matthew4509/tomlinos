// The classic menu bar and small-picture toolbar any app window can put across its top: File, Edit, View... with
// their drop-down menus, and under them a row of 16 px buttons. No ribbon.
//
// How an app takes it up:
//   const bar = classicBar({
//     menus: [
//       { label: 'File', items: [
//         { label: 'Save', icon: 'save', shortcut: 'Ctrl+S', enabled: () => dirty, action: save },
//         { separator: true },
//         { label: 'Recent', submenu: () => recent.map(f => ({ label: f.name, action: () => open(f) })) },
//       ] },
//       { label: 'View', items: [{ label: 'Status bar', checked: () => showStatus, action: toggleStatus }] },
//     ],
//     tools: [{ id: 'save', label: 'Save', icon: 'save', shortcut: 'Ctrl+S', action: save }, '|', ...],
//   }, { layer: shell.menus, signal, scope: app.root, doc: () => editor });
//   app.root.prepend(bar.el);
//   ...after anything that changes what is enabled or ticked: bar.refresh();
//
// - Menus are described, not built: labels, an optional picture (toolicons.ts), the shortcut shown at the right,
//   getters for enabled, ticked and shown (asked each time a menu opens), submenus (a list or a function), separators
//   and the action. The drop-downs are the desktop's own menus (MenuLayer in menu.ts), so they look and work like every
//   context menu.
// - The bar answers Alt and F10 (focus the bar), Alt+letter (open that menu; the letter is underlined), the arrows,
//   Enter and Escape, anywhere in `scope`. Alt+Q (close the window) and Alt+L (lock) belong to the desktop and are never
//   given to a menu. When the bar or a menu is left, the keyboard goes back to `doc()` (or to whatever had it before).
// - Shortcut text is shown only; the app keeps handling its own keys. Pass bindShortcuts: true to have the bar run an
//   item's action for its shortcut instead. Keys the browser keeps (Ctrl+N, Ctrl+W, Ctrl+T...) are listed in
//   BROWSER_KEYS; checkShortcuts() names any menu item that uses one, for a test to fail on.
// - The toolbar is one Tab stop; the arrow keys move inside it. A press with the mouse does not take the keyboard from
//   the document, so a selection stays selected. A button with `pressed` is a toggle (Bold) and shows as pressed.
// - In a narrow window the menus and buttons that do not fit move into a » menu at the end of their row. On a touch
//   screen the titles and buttons grow to finger size. Colours come from the theme, so the dark theme works.
// - Several named toolbars instead of the one row: pass `toolbars` (and leave out `tools`), and wrap the app's work
//   area in bar.dock(work) so toolbars can be docked to its left and right as well as across the top:
//     const bar = classicBar({ menus, toolbars: [
//       { id: 'standard', name: 'Standard', tools: [...] },
//       { id: 'snaps', name: 'Snaps', side: 'right', tools: [...] },
//     ] }, { ..., layout: { saved: settings.toolbars, save: v => { settings.toolbars = v; keep(); } } });
//     app.root.append(bar.el, bar.dock(workArea), statusBar);
//   Each toolbar has a grip (the three dots at its start): drag it to another place in the rows, or to the left or
//   right edge of the work area; with the grip focused the arrow keys move it. View > Toolbars (put at the top of the
//   app's View menu by the bar) shows or hides each one, docks it Top, Left or Right, and resets them. Keep
//   `layout.saved` per person where the app keeps its other settings (/System/<app>.json); what was saved is checked,
//   and anything broken gives the usual layout. See toolbars.ts.
import { h, on } from '../core/dom.ts';
import type { MenuItem, MenuLayer } from './menu.ts';
import { toolIcon, type ToolIconId } from './toolicons.ts';
import { docking, type Docking, type ToolbarSpec, type ToolbarStore } from './toolbars.ts';

export interface BarItem {
  label?: string;
  icon?: ToolIconId;
  /** Shown at the right of the item, e.g. "Ctrl+S". */
  shortcut?: string;
  enabled?: () => boolean;
  /** An item that is ticked or not (a menuitemcheckbox). */
  checked?: () => boolean;
  /** Left out of the menu while this says false. */
  shown?: () => boolean;
  danger?: boolean;
  separator?: boolean;
  submenu?: BarItem[] | (() => BarItem[]);
  action?: () => void;
}

export interface BarMenu {
  label: string;
  /** The letter that opens it with Alt. Picked from the label when left out. */
  key?: string;
  items: BarItem[] | (() => BarItem[]);
  shown?: () => boolean;
}

export interface ToolButton {
  /** For finding the button later (data-tool on the element). */
  id?: string;
  label: string;
  /** Its picture from toolicons.ts; or `picture`, an app's own 16 px picture, when none of those fits. */
  icon?: ToolIconId;
  picture?: () => Element;
  shortcut?: string;
  enabled?: () => boolean;
  /** Makes it a toggle button showing whether the thing is on. */
  pressed?: () => boolean;
  shown?: () => boolean;
  action: () => void;
}

/** A control of the app's own on the toolbar (a font box). It keeps its own Tab stop and is hidden when it does not fit. */
export interface ToolWidget {
  widget: HTMLElement;
}

/** '|' draws a separator line. */
export type ToolEntry = ToolButton | ToolWidget | '|';

export interface BarSpec {
  menus: BarMenu[];
  tools?: ToolEntry[];
  /** Named toolbars that can be moved, docked and hidden (toolbars.ts); used instead of `tools`. */
  toolbars?: ToolbarSpec[];
}

export interface BarOptions {
  /** The desktop's menu layer (shell.menus). */
  layer: MenuLayer;
  signal: AbortSignal;
  /** Where Alt, F10 and Alt+letter are heard: the app's root. */
  scope: HTMLElement;
  /** Where the keyboard goes when the bar is left. Without it, back to what had it before. */
  doc?: () => HTMLElement | null;
  /** Asked before a menu opens; false keeps it shut (an edit that must be finished first). */
  before?: () => boolean;
  /** Names the bar for screen readers. */
  label?: string;
  /** Run an item's action when its shortcut is pressed in `scope`. */
  bindShortcuts?: boolean;
  /** Where the toolbars' places are kept per person (with `toolbars`). */
  layout?: ToolbarStore;
}

export interface ClassicBar {
  el: HTMLElement;
  menubar: HTMLElement;
  toolbar: HTMLElement | null;
  /** Asks the getters again: enabled and pressed buttons, menus that come and go, what fits. */
  refresh(): void;
  /** Opens a menu by its label or position, as from the keyboard. */
  open(menu: string | number): void;
  /** Puts the keyboard on the bar's first menu title (as Alt or F10 does). */
  focusBar(): void;
  /** Closes any open menu and gives the keyboard back. */
  close(): void;
  readonly isOpen: boolean;
  /**
   * With `toolbars`: puts the left and right docks round the app's work area and returns the frame to put in its place
   * (without toolbars, the work area itself).
   */
  dock(work: HTMLElement): HTMLElement;
  /** The named toolbar's element (null when there is no such toolbar). */
  toolbarEl(id: string): HTMLElement | null;
  /** The toolbars' docking (null without `toolbars`). */
  readonly toolbars: Docking | null;
}

// ---- The model: plain functions, no page needed (test/menubar.test.ts) --------------------------------------------

/** Alt with these is the desktop's (Alt+Q closes the window, Alt+L locks), so no menu is given them. */
export const RESERVED_ALT_KEYS = ['q', 'l'];

/** Keys a web page is not given (or not reliably): the browser opens, closes or switches tabs and windows with them. */
export const BROWSER_KEYS = ['Ctrl+N', 'Ctrl+W', 'Ctrl+T', 'Ctrl+Shift+N', 'Ctrl+Shift+T', 'Ctrl+Shift+W', 'Ctrl+Tab', 'Ctrl+Shift+Tab', 'Ctrl+PageUp', 'Ctrl+PageDown', 'Alt+F4', 'F11', 'F12', 'Ctrl+Shift+I', 'Ctrl+Shift+J', 'Ctrl+Shift+Q'];

/** The Alt letter of each menu: its own `key`, or the first letter of its label free of the others and of the desktop. */
export function pickAccessKeys(menus: Array<{ label: string; key?: string }>, reserved: readonly string[] = RESERVED_ALT_KEYS): string[] {
  const taken = new Set(reserved.map(k => k.toLowerCase()));
  const out: string[] = menus.map(m => {
    const k = m.key?.toLowerCase() ?? '';
    if (k && !taken.has(k)) {
      taken.add(k);
      return k;
    }
    return '';
  });
  menus.forEach((m, i) => {
    if (out[i]) return;
    const letters = [...m.label.toLowerCase()].filter(ch => /[a-z0-9]/.test(ch));
    const pick = letters.find(ch => !taken.has(ch)) ?? '';
    if (pick) taken.add(pick);
    out[i] = pick;
  });
  return out;
}

/** The label cut round its access letter, for underlining: [before, letter, after]; letter is '' when absent. */
export function splitLabel(label: string, key: string): [string, string, string] {
  const at = key ? label.toLowerCase().indexOf(key.toLowerCase()) : -1;
  return at < 0 ? [label, '', ''] : [label.slice(0, at), label[at], label.slice(at + 1)];
}

/** "Ctrl+Shift+S" as aria-keyshortcuts wants it: "Control+Shift+S". */
export function ariaShortcut(text: string): string {
  return text
    .split(/\s*\+\s*/)
    .map(k => ({ ctrl: 'Control', cmd: 'Meta', del: 'Delete', esc: 'Escape' })[k.toLowerCase()] ?? k)
    .join('+');
}

/** A button's tooltip: "Save (Ctrl+S)". */
export function toolTip(label: string, shortcut?: string): string {
  return shortcut ? `${label} (${shortcut})` : label;
}

/** True when the key event is the shortcut written as "Ctrl+Shift+S", "F5", "Delete", "Alt+Enter". */
export function shortcutMatches(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>, text: string): boolean {
  const parts = text.split('+').map(s => s.trim().toLowerCase()).filter(Boolean);
  const key = parts.pop();
  if (!key) return false;
  const want = { ctrl: parts.includes('ctrl') || parts.includes('cmd'), alt: parts.includes('alt'), shift: parts.includes('shift') };
  if ((event.ctrlKey || event.metaKey) !== want.ctrl || event.altKey !== want.alt) return false;
  const named: Record<string, string> = { del: 'delete', esc: 'escape', space: ' ', plus: '+', minus: '-' };
  const k = event.key.toLowerCase();
  const wantKey = named[key] ?? key;
  // Shift changes what a symbol key types (Ctrl+Shift+= arrives as "+"), so it counts only for letters and named keys.
  if (wantKey.length > 1 || /[a-z]/.test(wantKey)) {
    if (event.shiftKey !== want.shift) return false;
  }
  return k === wantKey;
}

/** Items whose shortcut the browser keeps for itself, as "File > New window (Ctrl+N)". */
export function checkShortcuts(menus: BarMenu[]): string[] {
  const bad = new Set(BROWSER_KEYS.map(k => k.toLowerCase()));
  const found: string[] = [];
  const walk = (items: BarItem[], path: string) => {
    for (const item of items) {
      if (item.shortcut && bad.has(item.shortcut.replace(/\s+/g, '').toLowerCase())) found.push(`${path} > ${item.label} (${item.shortcut})`);
      if (item.submenu) walk(typeof item.submenu === 'function' ? item.submenu() : item.submenu, `${path} > ${item.label}`);
    }
  };
  for (const m of menus) walk(typeof m.items === 'function' ? m.items() : m.items, m.label);
  return found;
}

const isOn = (getter: (() => boolean) | undefined, fallback = true) => (getter ? getter() : fallback);

/** The description each bar on the page was made from, so a test can run checkShortcuts() over an app's real menus. */
const specs = new WeakMap<Element, BarSpec>();
export function barSpecOf(el: Element): BarSpec | undefined {
  return specs.get(el);
}

/**
 * The described items as the menu layer's items, with every getter asked now: hidden items dropped, separators at the
 * ends or side by side dropped, a submenu with nothing in it shown disabled. `wrap` wraps each action (the bar uses it
 * to refresh after the action has run).
 */
export function toMenuItems(items: BarItem[], wrap: (action: () => void) => () => void = a => a, icons?: Map<string, ToolIconId>): MenuItem[] {
  const out: MenuItem[] = [];
  for (const item of items) {
    if (!isOn(item.shown)) continue;
    if (icons && item.icon && item.label) icons.set(item.label, item.icon);
    if (item.separator) {
      if (out.length && !out[out.length - 1].separator) out.push({ separator: true });
      continue;
    }
    const sub = item.submenu ? toMenuItems(typeof item.submenu === 'function' ? item.submenu() : item.submenu, wrap, icons) : null;
    const enabled = isOn(item.enabled) && (!sub || sub.some(s => !s.separator));
    out.push({
      label: item.label ?? '',
      hint: item.shortcut,
      disabled: !enabled,
      checked: item.checked ? item.checked() : undefined,
      danger: item.danger,
      submenu: sub && sub.length ? sub : undefined,
      action: item.action && !sub ? wrap(item.action) : undefined,
    });
  }
  while (out.length && out[out.length - 1].separator) out.pop();
  return out;
}

/** How many of the items (left to right, these widths) fit in `room`, keeping `more` free for the » button when not all do. */
export function fitCount(widths: number[], room: number, more: number): number {
  const total = widths.reduce((a, b) => a + b, 0);
  if (total <= room) return widths.length;
  let used = more;
  let n = 0;
  while (n < widths.length && used + widths[n] <= room) used += widths[n++];
  return n;
}

/** The next usable position from `from` going `step` (1 or -1), wrapping round; -1 when none is usable. */
export function nextUsable(usable: boolean[], from: number, step: 1 | -1): number {
  const n = usable.length;
  for (let i = 1; i <= n; i++) {
    const j = (((from + step * i) % n) + n) % n;
    if (usable[j]) return j;
  }
  return -1;
}

// ---- The bar on the page ----------------------------------------------------------------------------------------

const isButton = (t: ToolEntry): t is ToolButton => typeof t === 'object' && 'action' in t;
const isWidget = (t: ToolEntry): t is ToolWidget => typeof t === 'object' && 'widget' in t;
const list = (items: BarItem[] | (() => BarItem[])) => (typeof items === 'function' ? items() : items);

export function classicBar(spec: BarSpec, opts: BarOptions): ClassicBar {
  const { layer, signal, scope } = opts;
  const keys = pickAccessKeys(spec.menus);
  let openAt = -1;
  /** A press on the title whose menu is open: the menu layer closes the menu for it, and the click must not reopen it. */
  let pressClosed = -2;
  /** What had the keyboard before the bar took it. */
  let cameFrom: HTMLElement | null = null;
  let altAlone = false;

  const home = (): HTMLElement | null => {
    const d = opts.doc?.();
    if (d && d.isConnected) return d;
    if (cameFrom && cameFrom.isConnected) return cameFrom;
    return scope;
  };
  const giveBack = () => {
    const target = home();
    if (target && target.tabIndex < 0 && !target.hasAttribute('tabindex') && !target.isContentEditable && !(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
      // Something that cannot take the keyboard (a plain div): give it a way to, so the keys stay in this window.
      target.tabIndex = -1;
    }
    target?.focus({ preventScroll: true });
    cameFrom = null;
    roveTitles(-1);
  };
  const remember = () => {
    const a = document.activeElement;
    if (a instanceof HTMLElement && !bar.contains(a) && !a.closest('.menu-root')) cameFrom = a;
  };
  /** Runs an item's action and then asks the getters again. */
  const wrap = (action: () => void) => () => {
    try {
      action();
    } finally {
      requestAnimationFrame(() => refresh());
    }
  };

  // ---- Menu titles ----
  const titles = spec.menus.map((m, i) => {
    const [a, u, b] = splitLabel(m.label, keys[i]);
    const t = h(
      'button',
      { type: 'button', class: 'cbar-title', role: 'menuitem', 'aria-haspopup': 'menu', 'aria-expanded': 'false', tabindex: -1, 'aria-keyshortcuts': keys[i] ? `Alt+${keys[i].toUpperCase()}` : null, 'data-menu': m.label },
      a,
      u ? h('u', {}, u) : null,
      b,
    );
    return t;
  });
  const moreMenus = h('button', { type: 'button', class: 'cbar-title cbar-more', role: 'menuitem', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': 'More menus', title: 'More menus', tabindex: -1, hidden: true }, '»');
  const allTitles = [...titles, moreMenus];
  const menubar = h('div', { class: 'cbar-menus', role: 'menubar', 'aria-label': opts.label ?? 'Menu bar' }, ...allTitles);
  /** Menus that are not shown at all right now (shown() says false). */
  const absent = new Set<number>();
  /** Menus pushed into » for want of room. */
  const overflowMenus = new Set<number>();
  const titleUsable = (i: number) => !allTitles[i].hidden;

  function roveTitles(at: number): void {
    allTitles.forEach((t, i) => (t.tabIndex = i === at ? 0 : -1));
  }

  function menuItemsFor(i: number, icons: Map<string, ToolIconId>): MenuItem[] {
    if (i < titles.length) return toMenuItems(list(spec.menus[i].items), wrap, icons);
    // The » title: each menu that did not fit, as a submenu.
    return [...overflowMenus].sort((x, y) => x - y).map(j => {
      const sub = toMenuItems(list(spec.menus[j].items), wrap, icons);
      return { label: spec.menus[j].label, submenu: sub.length ? sub : undefined, disabled: !sub.length };
    });
  }

  function openMenu(i: number, fromKeyboard: boolean): void {
    if (opts.before && !opts.before()) return;
    if (!bar.contains(document.activeElement) && !document.activeElement?.closest('.menu-root')) remember();
    const title = allTitles[i];
    const r = title.getBoundingClientRect();
    const icons = new Map<string, ToolIconId>();
    const items = menuItemsFor(i, icons);
    if (!items.length) return;
    layer.show(items, r.left, r.bottom, {
      returnFocus: home(),
      fromKeyboard,
      anchor: bar,
      onSide: step => {
        const j = nextUsable(allTitles.map((_, k) => titleUsable(k)), i, step);
        if (j >= 0) openMenu(j, true);
      },
      onClose: () => {
        stopDecorating();
        if (openAt !== i) return;
        openAt = -1;
        title.setAttribute('aria-expanded', 'false');
        title.classList.remove('on');
        roveTitles(-1);
        bar.classList.remove('cbar-active');
      },
    });
    if (!layer.isOpen) return;
    decorate(icons);
    openAt = i;
    title.setAttribute('aria-expanded', 'true');
    title.classList.add('on');
    roveTitles(i);
    bar.classList.add('cbar-active');
  }

  // Heard before the menu layer's own listener (added later, when a menu opens), which closes the menu on this press.
  on(document, 'pointerdown', (event: PointerEvent) => {
    const at = event.target instanceof Node ? allTitles.findIndex(t => t.contains(event.target as Node)) : -1;
    pressClosed = at >= 0 && at === openAt && layer.isOpen ? at : -2;
  }, signal, { capture: true });
  allTitles.forEach((t, i) => {
    on(t, 'pointerdown', (event: PointerEvent) => {
      // Keep the keyboard where it is: a mouse press on a title is not a move to the bar.
      if (event.pointerType === 'mouse') event.preventDefault();
    }, signal);
    on(t, 'click', () => {
      if (openAt === i && layer.isOpen) {
        layer.close();
        return;
      }
      if (pressClosed === i) {
        pressClosed = -2;
        giveBack();
        return;
      }
      openMenu(i, false);
    }, signal);
    on(t, 'pointerenter', () => {
      if (openAt >= 0 && openAt !== i && layer.isOpen) openMenu(i, false);
    }, signal);
    on(t, 'keydown', (event: KeyboardEvent) => {
      const usable = allTitles.map((_, k) => titleUsable(k));
      const stop = () => {
        event.preventDefault();
        event.stopPropagation();
      };
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        stop();
        const j = nextUsable(usable, i, event.key === 'ArrowRight' ? 1 : -1);
        if (j >= 0) {
          roveTitles(j);
          allTitles[j].focus({ preventScroll: true });
        }
      } else if (event.key === 'Home' || event.key === 'End') {
        stop();
        const j = event.key === 'Home' ? nextUsable(usable, -1, 1) : nextUsable(usable, usable.length, -1);
        if (j >= 0) {
          roveTitles(j);
          allTitles[j].focus({ preventScroll: true });
        }
      } else if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        stop();
        openMenu(i, true);
      } else if (event.key === 'Escape' || event.key === 'Tab' || (event.key === 'F10' && !event.shiftKey)) {
        stop();
        giveBack();
      } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const j = keys.findIndex((k, n) => k === event.key.toLowerCase() && titleUsable(n));
        if (j >= 0) {
          stop();
          openMenu(j, true);
        }
      }
    }, signal);
  });

  // ---- Toolbar ----
  const tools = spec.tools ?? [];
  const toolEls: Array<{ entry: ToolEntry; el: HTMLElement }> = tools.map(entry => {
    if (entry === '|') return { entry, el: h('span', { class: 'cbar-tsep', role: 'separator', 'aria-orientation': 'vertical' }) };
    if (isWidget(entry)) return { entry, el: h('span', { class: 'cbar-widget' }, entry.widget) };
    return { entry, el: toolButtonEl(entry, signal, wrap) };
  });
  const moreTools = h('button', { type: 'button', class: 'cbar-tool cbar-more', tabindex: -1, 'aria-label': 'More buttons', title: 'More buttons', 'aria-haspopup': 'menu', hidden: true }, '»');
  const toolbar = tools.length ? h('div', { class: 'cbar-tools', role: 'toolbar', 'aria-label': 'Toolbar' }, ...toolEls.map(t => t.el), moreTools) : null;
  const overflowTools = new Set<number>();
  /** The buttons the arrow keys go between, in order. */
  const roving = (): HTMLElement[] => [...toolEls.filter(t => isButton(t.entry) && !t.el.hidden && t.el.getAttribute('aria-disabled') !== 'true').map(t => t.el), ...(moreTools.hidden ? [] : [moreTools])];
  let toolStop: HTMLElement | null = null;
  const setToolStop = (el: HTMLElement | null) => {
    for (const t of toolEls) if (isButton(t.entry)) t.el.tabIndex = -1;
    moreTools.tabIndex = -1;
    toolStop = el ?? roving()[0] ?? null;
    if (toolStop) toolStop.tabIndex = 0;
  };
  if (toolbar) {
    on(toolbar, 'keydown', (event: KeyboardEvent) => {
      const all = roving();
      const at = all.indexOf(document.activeElement as HTMLElement);
      if (at < 0) return;
      let to = -1;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') to = (at + 1) % all.length;
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') to = (at - 1 + all.length) % all.length;
      else if (event.key === 'Home') to = 0;
      else if (event.key === 'End') to = all.length - 1;
      else if (event.key === 'Escape') {
        event.preventDefault();
        giveBack();
        return;
      }
      if (to < 0) return;
      event.preventDefault();
      setToolStop(all[to]);
      all[to].focus({ preventScroll: true });
    }, signal);
    on(toolbar, 'focusin', (event: FocusEvent) => {
      if (event.target instanceof HTMLElement && roving().includes(event.target)) setToolStop(event.target);
      const from = event.relatedTarget;
      if (from instanceof HTMLElement && !bar.contains(from)) cameFrom = from;
    }, signal);
    on(moreTools, 'pointerdown', (event: PointerEvent) => {
      if (event.pointerType === 'mouse') event.preventDefault();
    }, signal);
    on(moreTools, 'click', () => {
      const r = moreTools.getBoundingClientRect();
      const items: MenuItem[] = [];
      const icons = new Map<string, ToolIconId>();
      for (const i of [...overflowTools].sort((a, b) => a - b)) {
        const entry = toolEls[i].entry;
        if (entry === '|') {
          items.push({ separator: true });
        } else if (isButton(entry)) {
          if (entry.icon) icons.set(entry.label, entry.icon);
          items.push({ label: entry.label, hint: entry.shortcut, disabled: !isOn(entry.enabled), checked: entry.pressed ? entry.pressed() : undefined, action: wrap(entry.action) });
        }
      }
      const clean = items.filter((it, k) => !(it.separator && (k === 0 || k === items.length - 1 || items[k - 1].separator)));
      if (clean.length) layer.show(clean, r.left, r.bottom, { returnFocus: document.activeElement === moreTools ? moreTools : home(), fromKeyboard: document.activeElement === moreTools, anchor: bar, onClose: stopDecorating });
      decorate(icons);
    }, signal);
  }

  const docks: Docking | null = spec.toolbars?.length
    ? docking(spec.toolbars, { signal, layer, wrap, home: () => home(), store: opts.layout })
    : null;
  if (docks) {
    // View > Toolbars, at the top of the app's View menu.
    const view = spec.menus.find(m => m.label === 'View');
    if (view) {
      const own = view.items;
      view.items = () => [docks.menuItem(), { separator: true }, ...list(own)];
    }
  }
  const bar = h('div', { class: 'cbar' }, menubar, toolbar, docks?.topDock ?? null);
  specs.set(bar, spec);

  // ---- Pictures in the open menu ----
  // The menu layer draws a tick column at the left of each item; an item with a picture shows it there (a ticked item
  // keeps its tick). Submenus are drawn as they open, so they are watched for.
  let decorator: MutationObserver | null = null;
  function stopDecorating(): void {
    decorator?.disconnect();
    decorator = null;
  }
  function decorate(icons: Map<string, ToolIconId>): void {
    stopDecorating();
    if (!icons.size) return;
    const root = document.activeElement instanceof Element ? document.activeElement.closest('.menu-root') : null;
    if (!root) return;
    const paint = (menu: Element) => {
      for (const row of menu.querySelectorAll(':scope > .menu-item')) {
        const id = icons.get(row.querySelector('.menu-label')?.textContent ?? '');
        const slot = row.querySelector('.menu-check');
        if (!id || !slot || slot.textContent || slot.querySelector('svg')) continue;
        slot.replaceChildren(toolIcon(id));
        row.classList.add('cbar-has-icon');
      }
    };
    root.querySelectorAll(':scope > .menu').forEach(paint);
    decorator = new MutationObserver(changes => {
      for (const change of changes) for (const node of change.addedNodes) if (node instanceof Element && node.classList.contains('menu')) paint(node);
    });
    decorator.observe(root, { childList: true });
  }

  // ---- Fitting a narrow window ----
  /** Each title's and button's width when last drawn, so a fit never has to hide (and so unfocus) one to measure it. */
  const widthOf = new WeakMap<HTMLElement, number>();
  const measure = (el: HTMLElement, gap: number): number => {
    if (el.hidden && widthOf.has(el)) return widthOf.get(el)!;
    const was = el.hidden;
    // Only a hidden element never yet drawn is shown for a moment, and a hidden element never has the keyboard.
    el.hidden = false;
    const cs = getComputedStyle(el);
    const w = el.getBoundingClientRect().width + (parseFloat(cs.marginLeft) || 0) + (parseFloat(cs.marginRight) || 0) + gap;
    el.hidden = was;
    if (w > gap) widthOf.set(el, w);
    return w;
  };
  function fitRow(row: HTMLElement, els: HTMLElement[], more: HTMLElement, wanted: (i: number) => boolean, spill: Set<number>): void {
    const cs = getComputedStyle(row);
    const room = row.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    if (room <= 0) return;
    const gap = parseFloat(cs.columnGap) || 0;
    const widths = els.map((el, i) => (wanted(i) ? measure(el, gap) : 0));
    const n = fitCount(widths, room - 1, measure(more, gap) + 2);
    spill.clear();
    els.forEach((el, i) => {
      const show = wanted(i) && i < n;
      if (wanted(i) && !show) spill.add(i);
      if (el.hidden === show) el.hidden = !show;
    });
    const needMore = [...spill].some(i => !(row === toolbar && toolEls[i].entry === '|'));
    if (more.hidden === needMore) more.hidden = !needMore;
  }
  function fit(): void {
    if (!bar.isConnected) return;
    fitRow(menubar, titles, moreMenus, i => !absent.has(i), overflowMenus);
    if (toolbar) {
      fitRow(toolbar, toolEls.map(t => t.el), moreTools, i => {
        const e = toolEls[i].entry;
        return !(isButton(e) && !isOn(e.shown));
      }, overflowTools);
      // A separator left at the end of the row, or just before », is not drawn.
      const shownEls = toolEls.filter(t => !t.el.hidden);
      const last = shownEls[shownEls.length - 1];
      if (last && last.entry === '|') last.el.hidden = true;
      if (toolStop && toolStop.hidden) setToolStop(null);
    }
  }

  function refresh(): void {
    spec.menus.forEach((m, i) => {
      if (m.shown && !m.shown()) absent.add(i);
      else absent.delete(i);
    });
    for (const { entry, el } of toolEls) if (isButton(entry)) syncToolButton(entry, el);
    fit();
    if (toolbar && (!toolStop || toolStop.hidden || toolStop.getAttribute('aria-disabled') === 'true')) setToolStop(null);
    docks?.refresh();
  }

  // ---- Keys heard anywhere in the app ----
  on(scope, 'keydown', (event: KeyboardEvent) => {
    if (event.key === 'Alt') {
      altAlone = !event.ctrlKey && !event.shiftKey && !event.metaKey && !event.repeat;
      if (altAlone) event.preventDefault();
      return;
    }
    altAlone = false;
    if (event.defaultPrevented) return;
    if (event.key === 'F10' && !event.altKey && !event.ctrlKey && !event.shiftKey && !event.metaKey) {
      event.preventDefault();
      if (bar.contains(document.activeElement)) giveBack();
      else focusBar();
      return;
    }
    // Alt with a letter (not Ctrl+Alt, which is AltGr on many keyboards and types characters).
    if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key.length === 1) {
      const k = event.key.toLowerCase();
      if (RESERVED_ALT_KEYS.includes(k)) return;
      const i = keys.findIndex((key, n) => key === k && !absent.has(n));
      if (i < 0) return;
      event.preventDefault();
      // A menu in » opens » with that menu's submenu reached from there.
      openMenu(overflowMenus.has(i) ? titles.length : i, true);
      return;
    }
    if (opts.bindShortcuts && (event.ctrlKey || event.metaKey || event.altKey || /^F\d+$/.test(event.key) || event.key === 'Delete')) {
      if (bar.contains(document.activeElement)) return;
      const hit = findShortcut(spec.menus.flatMap(m => list(m.items)), event);
      if (hit) {
        event.preventDefault();
        wrap(hit)();
      }
    }
  }, signal);
  on(scope, 'keyup', (event: KeyboardEvent) => {
    if (event.key !== 'Alt') return;
    const was = altAlone;
    altAlone = false;
    if (!was) return;
    event.preventDefault();
    if (layer.isOpen && openAt >= 0) layer.close();
    else if (bar.contains(document.activeElement)) giveBack();
    else focusBar();
  }, signal);
  on(scope, 'pointerdown', () => (altAlone = false), signal, { capture: true });
  // The getters are asked again after a key or a press in the app (the selection may have moved).
  let queued = false;
  const soon = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      refresh();
    });
  };
  on(scope, 'keyup', soon, signal);
  on(scope, 'pointerup', soon, signal);
  const watch = new ResizeObserver(() => fit());
  watch.observe(menubar);
  if (toolbar) watch.observe(toolbar);
  signal.addEventListener('abort', () => {
    watch.disconnect();
    stopDecorating();
  }, { once: true });

  function focusBar(): void {
    remember();
    const j = nextUsable(allTitles.map((_, k) => titleUsable(k)), -1, 1);
    if (j < 0) return;
    roveTitles(j);
    allTitles[j].focus({ preventScroll: true });
  }

  // Leaving the bar (a click elsewhere, Tab) takes its titles back out of the Tab order.
  on(menubar, 'focusout', (event: FocusEvent) => {
    const to = event.relatedTarget;
    if (to instanceof Node && menubar.contains(to)) return;
    if (openAt < 0) roveTitles(-1);
  }, signal);

  refresh();
  queueMicrotask(fit);

  return {
    el: bar,
    menubar,
    toolbar,
    refresh,
    open(menu) {
      const i = typeof menu === 'number' ? menu : spec.menus.findIndex(m => m.label === menu);
      if (i >= 0 && i < titles.length && !absent.has(i)) openMenu(overflowMenus.has(i) ? titles.length : i, true);
    },
    focusBar,
    close() {
      if (layer.isOpen && openAt >= 0) layer.close();
      else giveBack();
    },
    get isOpen() {
      return openAt >= 0 && layer.isOpen;
    },
    dock(work) {
      return docks ? docks.frame(work) : work;
    },
    toolbarEl(id) {
      return docks?.band(id) ?? null;
    },
    toolbars: docks,
  };
}

/** A toolbar button: a press with the mouse leaves the keyboard where it is; a disabled one does nothing. */
export function toolButtonEl(entry: ToolButton, signal: AbortSignal, wrap: (action: () => void) => () => void): HTMLButtonElement {
  const b = h(
    'button',
    {
      type: 'button',
      class: 'cbar-tool',
      tabindex: -1,
      'aria-label': entry.label,
      title: toolTip(entry.label, entry.shortcut),
      'aria-keyshortcuts': entry.shortcut ? ariaShortcut(entry.shortcut) : null,
      'aria-pressed': entry.pressed ? 'false' : null,
      'data-tool': entry.id ?? entry.icon ?? null,
    },
    entry.picture ? entry.picture() : entry.icon ? toolIcon(entry.icon) : null,
  );
  on(b, 'pointerdown', (event: PointerEvent) => {
    if (event.pointerType === 'mouse') event.preventDefault();
  }, signal);
  on(b, 'click', () => {
    if (b.getAttribute('aria-disabled') === 'true') return;
    wrap(entry.action)();
  }, signal);
  return b;
}

/** Sets a button's disabled look and pressed state from its getters. */
export function syncToolButton(entry: ToolButton, el: HTMLElement): void {
  const enabled = isOn(entry.enabled);
  el.setAttribute('aria-disabled', enabled ? 'false' : 'true');
  el.classList.toggle('off', !enabled);
  if (entry.pressed) el.setAttribute('aria-pressed', String(entry.pressed()));
}

/** The enabled, shown item whose shortcut this key is, searched through submenus. */
function findShortcut(items: BarItem[], event: KeyboardEvent): (() => void) | null {
  for (const item of items) {
    if (!isOn(item.shown) || !isOn(item.enabled)) continue;
    if (item.shortcut && item.action && shortcutMatches(event, item.shortcut)) return item.action;
    if (item.submenu) {
      const hit = findShortcut(list(item.submenu), event);
      if (hit) return hit;
    }
  }
  return null;
}
