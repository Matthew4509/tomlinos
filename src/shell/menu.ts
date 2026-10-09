// The one context menu. Only one can be open at a time. It opens from a right-click, the menu key, Shift+F10 or a
// long press on a touch screen, and works with the arrow keys, Home, End, Enter and Escape.
import { clamp, css, h, on } from '../core/dom.ts';

export interface MenuItem {
  label?: string;
  action?: () => void;
  disabled?: boolean;
  checked?: boolean;
  separator?: boolean;
  submenu?: MenuItem[];
  danger?: boolean;
  /** Shown at the right, e.g. "Ctrl+C". */
  hint?: string;
}

export class MenuLayer {
  /** When a menu last opened (performance.now()); the click that ends a long press is ignored for a moment. */
  openedAt = -10000;
  private host: HTMLElement;
  private open: { root: HTMLElement; levels: HTMLElement[]; abort: AbortController; returnFocus: HTMLElement | null } | null = null;

  constructor(host: HTMLElement) {
    this.host = host;
  }

  get isOpen(): boolean {
    return this.open !== null;
  }

  close(restoreFocus = true): void {
    if (!this.open) return;
    const { root, abort, returnFocus } = this.open;
    this.open = null;
    abort.abort();
    root.remove();
    if (restoreFocus && returnFocus && returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
  }

  show(items: MenuItem[], x: number, y: number, options: { returnFocus?: HTMLElement | null; fromKeyboard?: boolean; anchor?: Element | null } = {}): void {
    this.close(false);
    this.openedAt = performance.now();
    const usable = items.filter((item, i) => !(item.separator && (i === 0 || i === items.length - 1 || items[i - 1].separator)));
    if (!usable.some(item => !item.separator)) return;
    const abort = new AbortController();
    const root = h('div', { class: 'menu-root' });
    this.host.append(root);
    this.open = { root, levels: [], abort, returnFocus: options.returnFocus ?? null };
    const first = this.level(usable, x, y, 0);
    on(document, 'pointerdown', (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !root.contains(event.target)) this.close(false);
    }, abort.signal, { capture: true });
    on(window, 'blur', () => this.close(false), abort.signal);
    on(window, 'resize', () => this.close(false), abort.signal);
    // A scroll moves what the menu belongs to: the page, or the area it was opened on (otherwise a Terminal printing a
    // line in another window would close the desktop's menu before it could be used). Scrolls elsewhere leave it open.
    const anchor = options.anchor ?? null;
    on(document, 'scroll', (event: Event) => {
      const t = event.target;
      if (!anchor || !(t instanceof Element) || t === document.documentElement || t.contains(anchor) || anchor.contains(t)) this.close(false);
    }, abort.signal, { capture: true });
    first.focus({ preventScroll: true });
    if (options.fromKeyboard) this.move(first, 1);
  }

  private level(items: MenuItem[], x: number, y: number, depth: number): HTMLElement {
    const state = this.open!;
    while (state.levels.length > depth) state.levels.pop()!.remove();
    const menu = h('div', { class: 'menu', role: 'menu', tabindex: -1 });
    for (const item of items) {
      if (item.separator) {
        menu.append(h('div', { class: 'menu-sep', role: 'separator' }));
        continue;
      }
      const row = h(
        'div',
        {
          class: `menu-item${item.danger ? ' danger' : ''}`,
          role: item.checked === undefined ? 'menuitem' : 'menuitemcheckbox',
          'aria-checked': item.checked === undefined ? null : String(item.checked),
          'aria-disabled': item.disabled ? 'true' : null,
          'aria-haspopup': item.submenu ? 'menu' : null,
          tabindex: -1,
        },
        h('span', { class: 'menu-check', 'aria-hidden': 'true' }, item.checked ? '✓' : ''),
        h('span', { class: 'menu-label' }, item.label ?? ''),
        h('span', { class: 'menu-hint' }, item.submenu ? '▸' : (item.hint ?? '')),
      );
      const activate = () => {
        if (item.disabled) return;
        if (item.submenu) {
          const rect = row.getBoundingClientRect();
          const sub = this.level(item.submenu, rect.right - 2, rect.top - 4, depth + 1);
          sub.focus({ preventScroll: true });
          this.move(sub, 1);
          return;
        }
        const returnFocus = state.returnFocus;
        this.close(false);
        returnFocus?.focus({ preventScroll: true });
        item.action?.();
      };
      row.addEventListener('click', activate);
      row.addEventListener('pointerenter', () => {
        row.focus({ preventScroll: true });
        while (state.levels.length > depth + 1) state.levels.pop()!.remove();
        if (item.submenu && !item.disabled) {
          const rect = row.getBoundingClientRect();
          this.level(item.submenu, rect.right - 2, rect.top - 4, depth + 1);
        }
      });
      menu.append(row);
    }
    menu.addEventListener('keydown', event => this.key(event, menu, depth));
    state.root.append(menu);
    state.levels.push(menu);
    const { width, height } = menu.getBoundingClientRect();
    const left = x + width > innerWidth ? Math.max(4, (depth > 0 ? x - width - 200 : x - width)) : x;
    css(menu, { left: clamp(left, 4, Math.max(4, innerWidth - width - 4)), top: clamp(y, 4, Math.max(4, innerHeight - height - 4)) });
    return menu;
  }

  private rows(menu: HTMLElement): HTMLElement[] {
    return [...menu.querySelectorAll<HTMLElement>(':scope > .menu-item')];
  }

  private move(menu: HTMLElement, step: number): void {
    const rows = this.rows(menu).filter(r => r.getAttribute('aria-disabled') !== 'true');
    if (!rows.length) return;
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const next = at < 0 ? (step > 0 ? 0 : rows.length - 1) : (at + step + rows.length) % rows.length;
    rows[next].focus({ preventScroll: true });
  }

  private key(event: KeyboardEvent, menu: HTMLElement, depth: number): void {
    const stop = () => {
      event.preventDefault();
      event.stopPropagation();
    };
    const rows = this.rows(menu).filter(r => r.getAttribute('aria-disabled') !== 'true');
    switch (event.key) {
      case 'ArrowDown': stop(); this.move(menu, 1); break;
      case 'ArrowUp': stop(); this.move(menu, -1); break;
      case 'Home': stop(); rows[0]?.focus(); break;
      case 'End': stop(); rows[rows.length - 1]?.focus(); break;
      case 'Enter':
      case ' ':
      case 'ArrowRight':
        if (event.key === 'ArrowRight' && document.activeElement?.getAttribute('aria-haspopup') !== 'menu') break;
        stop();
        (document.activeElement as HTMLElement | null)?.click();
        break;
      case 'ArrowLeft':
        if (depth === 0) break;
        stop();
        this.open!.levels.pop()!.remove();
        this.rows(this.open!.levels[depth - 1]).find(r => r.getAttribute('aria-haspopup') === 'menu' && r.matches(':hover, :focus'))?.focus();
        this.open!.levels[depth - 1].focus();
        break;
      case 'Escape':
      case 'Tab':
        stop();
        this.close();
        break;
    }
  }
}

/**
 * Makes an element open a menu from every way a person can ask for one. `build` gets the thing that was pressed
 * and returns the items, or null for "no menu here".
 */
export function bindContextMenu(
  el: HTMLElement,
  signal: AbortSignal,
  menus: MenuLayer,
  build: (target: Element | null) => MenuItem[] | null,
): void {
  let lastLongPress = 0;
  let lastKeyMenu = 0;
  const openAt = (target: Element | null, x: number, y: number, fromKeyboard: boolean, returnFocus: HTMLElement | null) => {
    const items = build(target);
    if (!items) return false;
    menus.show(items, x, y, { returnFocus, fromKeyboard, anchor: el });
    return true;
  };
  on(el, 'contextmenu', (event: MouseEvent) => {
    // The menu key and a long press each also send a contextmenu event; the menu is already open, so ignore it.
    if (Date.now() - lastLongPress < 600 || Date.now() - lastKeyMenu < 600) {
      event.preventDefault();
      return;
    }
    const target = event.target instanceof Element ? event.target : null;
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (openAt(target, event.clientX, event.clientY, false, returnFocus)) event.preventDefault();
  }, signal);
  on(el, 'keydown', (event: KeyboardEvent) => {
    if (!(event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))) return;
    const focused = document.activeElement instanceof HTMLElement && el.contains(document.activeElement) ? document.activeElement : null;
    const rect = (focused ?? el).getBoundingClientRect();
    if (openAt(focused, rect.left + Math.min(rect.width, 40), rect.top + Math.min(rect.height, 30), true, focused)) {
      lastKeyMenu = Date.now();
      event.preventDefault();
    }
  }, signal);
  // A long press on a touch screen. (Some browsers also send a contextmenu event afterwards; lastLongPress makes us ignore it.)
  let press: { timer: number; x: number; y: number } | null = null;
  const cancelPress = () => {
    if (press) clearTimeout(press.timer);
    press = null;
  };
  on(el, 'pointerdown', (event: PointerEvent) => {
    if (event.pointerType !== 'touch' || !event.isPrimary) return;
    const target = event.target instanceof Element ? event.target : null;
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelPress();
    press = {
      x: event.clientX,
      y: event.clientY,
      timer: window.setTimeout(() => {
        press = null;
        lastLongPress = Date.now();
        openAt(target, event.clientX, event.clientY, false, returnFocus);
      }, 500),
    };
  }, signal);
  on(el, 'pointermove', (event: PointerEvent) => {
    if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10) cancelPress();
  }, signal);
  on(el, 'pointerup', cancelPress, signal);
  on(el, 'pointercancel', cancelPress, signal);
  signal.addEventListener('abort', cancelPress, { once: true });
}
