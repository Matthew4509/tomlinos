// Windows: drag, resize from all edges, minimise, maximise, snap to a half of the screen (drag the title bar to a side
// edge, or Ctrl+Alt+arrow), close, stacking. Each window has a generated id and
// its own AbortController; closing a window aborts it, which removes every listener the window or its app added.
import { Bus } from '../core/bus.ts';
import { clamp, css, h, isPrecisePointer, on } from '../core/dom.ts';
import { icon, type IconName } from './icons.ts';
import type { MenuItem } from './menu.ts';
import type { WindowPrefs } from './session.ts';

export interface WinOptions {
  key: string;
  appId: string;
  title: string;
  icon: IconName;
  size: readonly [number, number];
  minSize?: readonly [number, number];
  /** A dialog-style window: no minimise or maximise, and it cannot be resized. */
  fixed?: boolean;
}

type State = 'normal' | 'max' | 'min';
const EDGES = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const;

export class Win {
  readonly id = crypto.randomUUID();
  readonly key: string;
  readonly appId: string;
  readonly el: HTMLElement;
  readonly body: HTMLElement;
  readonly abort = new AbortController();
  title: string;
  iconName: IconName;
  state: State = 'normal';
  dirty = false;
  guard: (() => boolean | Promise<boolean>) | null = null;
  rect: WindowPrefs = { x: 0, y: 0, w: 400, h: 300 };
  /** The size and place before it was snapped to a half, so dragging it away or Ctrl+Alt+Down puts it back. */
  unsnapped: WindowPrefs | null = null;
  readonly minSize: readonly [number, number];
  readonly fixed: boolean;
  private titleText: HTMLElement;
  private iconHost: HTMLElement;
  maxBtn: HTMLButtonElement | null = null;

  constructor(options: WinOptions) {
    this.key = options.key;
    this.appId = options.appId;
    this.title = options.title;
    this.iconName = options.icon;
    this.minSize = options.minSize ?? [260, 160];
    this.fixed = options.fixed ?? false;
    this.titleText = h('span', { class: 'win-title-text' }, options.title);
    this.iconHost = h('span', { class: 'win-icon' }, icon(options.icon, 16));
    this.body = h('div', { class: 'win-body' });
    this.el = h('div', { class: 'win', role: 'dialog', 'aria-label': options.title, tabindex: -1 });
  }

  setTitle(title: string): void {
    this.title = title;
    this.titleText.textContent = title;
    this.el.setAttribute('aria-label', title);
  }

  setIcon(name: IconName): void {
    this.iconName = name;
    this.iconHost.replaceChildren(icon(name, 16));
  }

  parts(): { titleText: HTMLElement; iconHost: HTMLElement } {
    return { titleText: this.titleText, iconHost: this.iconHost };
  }
}

export class WindowManager {
  readonly changed = new Bus<void>();
  private host: HTMLElement;
  private wins = new Map<string, Win>();
  private order: Win[] = [];
  private savePrefs: (appId: string, prefs: WindowPrefs) => void;
  private savedPrefs: (appId: string) => WindowPrefs | undefined;
  private menu: (items: MenuItem[], x: number, y: number, returnFocus: HTMLElement | null) => void;
  private confirmDiscard: (title: string) => Promise<boolean>;
  /** Windows are drawn as full-screen panels on small screens. */
  private compact = window.matchMedia('(max-width: 720px)');

  constructor(
    host: HTMLElement,
    hooks: {
      savePrefs: (appId: string, prefs: WindowPrefs) => void;
      savedPrefs: (appId: string) => WindowPrefs | undefined;
      menu: (items: MenuItem[], x: number, y: number, returnFocus: HTMLElement | null) => void;
      confirmDiscard: (title: string) => Promise<boolean>;
    },
  ) {
    this.host = host;
    this.savePrefs = hooks.savePrefs;
    this.savedPrefs = hooks.savedPrefs;
    this.menu = hooks.menu;
    this.confirmDiscard = hooks.confirmDiscard;
    // The browser window was resized: pull every window back on screen.
    window.addEventListener('resize', () => {
      for (const win of this.wins.values()) this.applyRect(win);
    });
    this.compact.addEventListener('change', () => {
      for (const win of this.wins.values()) this.applyState(win);
    });
  }

  list(): Win[] {
    return [...this.wins.values()];
  }

  /** Windows in stacking order, front last. */
  stack(): Win[] {
    return [...this.order];
  }

  find(key: string): Win | undefined {
    return this.list().find(w => w.key === key);
  }

  front(): Win | undefined {
    return [...this.order].reverse().find(w => w.state !== 'min');
  }

  hasUnsaved(): boolean {
    return this.list().some(w => w.dirty);
  }

  private area(): DOMRect {
    return this.host.getBoundingClientRect();
  }

  create(options: WinOptions): Win {
    const win = new Win(options);
    const signal = win.abort.signal;
    const { titleText, iconHost } = win.parts();

    const buttons: HTMLElement[] = [];
    if (!win.fixed) {
      const min = h('button', { type: 'button', class: 'win-btn', 'aria-label': 'Minimise' }, h('span', { class: 'glyph-min', 'aria-hidden': 'true' }));
      const max = h('button', { type: 'button', class: 'win-btn', 'aria-label': 'Maximise' }, h('span', { class: 'glyph-max', 'aria-hidden': 'true' }));
      win.maxBtn = max;
      on(min, 'click', () => this.minimise(win), signal);
      on(max, 'click', () => this.toggleMax(win), signal);
      buttons.push(min, max);
    }
    const close = h('button', { type: 'button', class: 'win-btn win-close', 'aria-label': 'Close' }, h('span', { class: 'glyph-close', 'aria-hidden': 'true' }));
    on(close, 'click', () => void this.close(win), signal);
    buttons.push(close);

    const bar = h('div', { class: 'win-bar' }, iconHost, titleText, h('span', { class: 'win-buttons' }, ...buttons));
    win.el.append(bar, win.body);
    if (!win.fixed) for (const edge of EDGES) win.el.append(h('div', { class: `win-edge edge-${edge}`, 'data-edge': edge }));

    this.place(win, options.size);
    this.host.append(win.el);
    this.wins.set(win.id, win);
    this.order.push(win);
    this.applyState(win);
    this.focus(win);

    on(win.el, 'pointerdown', () => this.focus(win), signal, { capture: true });
    on(bar, 'dblclick', (event: MouseEvent) => {
      if (!win.fixed && !(event.target instanceof Element && event.target.closest('.win-btn'))) this.toggleMax(win);
    }, signal);
    on(bar, 'pointerdown', (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('.win-btn')) return;
      this.beginMove(win, event);
    }, signal);
    on(bar, 'contextmenu', (event: MouseEvent) => {
      event.preventDefault();
      this.menu(this.windowMenu(win), event.clientX, event.clientY, null);
    }, signal);
    on(win.el, 'keydown', (event: KeyboardEvent) => {
      // Alt+F4 does not reach a web page in most browsers, so Alt+Q closes the front window as well.
      if (event.altKey && (event.key === 'F4' || event.key.toLowerCase() === 'q')) {
        event.preventDefault();
        void this.close(win);
      }
    }, signal);
    for (const handle of win.el.querySelectorAll<HTMLElement>('.win-edge')) {
      on(handle, 'pointerdown', (event: PointerEvent) => this.beginResize(win, handle.dataset.edge!, event), signal);
    }
    this.changed.emit();
    return win;
  }

  private place(win: Win, size: readonly [number, number]): void {
    const area = this.area();
    const saved = this.savedPrefs(win.appId);
    const w = clamp(saved && !win.fixed ? saved.w : size[0], win.minSize[0], Math.max(win.minSize[0], area.width));
    const tall = clamp(saved && !win.fixed ? saved.h : size[1], win.minSize[1], Math.max(win.minSize[1], area.height));
    let x: number;
    let y: number;
    if (saved && !win.fixed && this.onScreen(saved.x, saved.y, w)) {
      x = saved.x;
      y = saved.y;
    } else {
      // Each new window steps down and right from the last, so a new one never hides another exactly.
      const same = this.list().filter(o => !o.fixed).length % 8;
      x = win.fixed ? (area.width - w) / 2 : 56 + same * 28;
      y = win.fixed ? (area.height - tall) / 3 : 36 + same * 28;
    }
    win.rect = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(tall) };
    this.applyRect(win);
  }

  private onScreen(x: number, y: number, w: number): boolean {
    const area = this.area();
    // A remembered spot is only reused if a good part of the window is visible there.
    return x + w > 160 && x < area.width - 160 && y >= 0 && y < area.height - 60;
  }

  /** Keeps a window reachable: its title bar can never be dragged fully out of sight. */
  private applyRect(win: Win): void {
    const area = this.area();
    const r = win.rect;
    r.w = clamp(r.w, win.minSize[0], Math.max(win.minSize[0], area.width));
    r.h = clamp(r.h, win.minSize[1], Math.max(win.minSize[1], area.height));
    r.x = clamp(r.x, 80 - r.w, Math.max(80 - r.w, area.width - 80));
    r.y = clamp(r.y, 0, Math.max(0, area.height - 32));
    css(win.el, { left: r.x, top: r.y, width: r.w, height: r.h });
  }

  private applyState(win: Win): void {
    const max = win.state === 'max' || (this.compact.matches && !win.fixed);
    win.el.classList.toggle('max', max);
    win.el.classList.toggle('min', win.state === 'min');
    win.maxBtn?.setAttribute('aria-label', win.state === 'max' ? 'Restore' : 'Maximise');
    win.maxBtn?.classList.toggle('is-max', win.state === 'max');
  }

  focus(win: Win): void {
    if (win.state === 'min') {
      win.state = 'normal';
      this.applyState(win);
    }
    this.order = this.order.filter(w => w !== win);
    this.order.push(win);
    this.order.forEach((w, i) => {
      css(w.el, { 'z-index': i + 1 });
      w.el.classList.toggle('active', w === win);
    });
    if (!win.el.contains(document.activeElement)) {
      const target = win.body.querySelector<HTMLElement>('[autofocus], [tabindex="0"], input, button, [role="listbox"]');
      (target ?? win.el).focus({ preventScroll: true });
    }
    this.changed.emit();
  }

  /** An app asks for a new width (the Calculator opening its sheet). Maximised or snapped windows keep their size. */
  setWidth(win: Win, width: number): void {
    if (win.state !== 'normal' || win.unsnapped) return;
    win.rect.w = width;
    this.applyRect(win);
  }

  minimise(win: Win): void {
    if (win.fixed) return;
    win.state = 'min';
    this.applyState(win);
    win.el.classList.remove('active');
    const next = this.front();
    if (next) this.focus(next);
    else this.changed.emit();
  }

  toggleMax(win: Win): void {
    if (win.fixed) return;
    win.state = win.state === 'max' ? 'normal' : 'max';
    this.applyState(win);
    this.changed.emit();
  }

  /** Taskbar button behaviour: bring it forward, or minimise it if it is already in front. */
  toggle(win: Win): void {
    if (win.state === 'min' || this.front() !== win) this.focus(win);
    else this.minimise(win);
  }

  showDesktop(): void {
    const open = this.list().filter(w => w.state !== 'min' && !w.fixed);
    if (open.length) {
      this.hidden = open;
      for (const w of open) {
        w.state = 'min';
        this.applyState(w);
      }
      this.changed.emit();
    } else if (this.hidden.length) {
      const back = this.hidden.filter(w => this.wins.has(w.id));
      this.hidden = [];
      for (const w of back) {
        w.state = 'normal';
        this.applyState(w);
      }
      if (back.length) this.focus(back[back.length - 1]);
    }
  }
  private hidden: Win[] = [];

  async close(win: Win): Promise<boolean> {
    if (!this.wins.has(win.id)) return true;
    if (win.guard) {
      if (!(await win.guard())) return false;
    } else if (win.dirty && !(await this.confirmDiscard(win.title))) {
      return false;
    }
    this.wins.delete(win.id);
    this.order = this.order.filter(w => w !== win);
    win.abort.abort();
    win.el.remove();
    const next = this.front();
    if (next) this.focus(next);
    else this.changed.emit();
    return true;
  }

  windowMenu(win: Win): MenuItem[] {
    return [
      { label: 'Restore', disabled: win.state === 'normal' || win.fixed, action: () => (win.state === 'min' ? this.focus(win) : this.toggleMax(win)) },
      { label: 'Minimise', disabled: win.state === 'min' || win.fixed, action: () => this.minimise(win) },
      { label: 'Maximise', disabled: win.state === 'max' || win.fixed, action: () => { win.state = 'max'; this.applyState(win); this.focus(win); } },
      { separator: true },
      { label: 'Close', action: () => void this.close(win) },
    ];
  }

  // ---- Pointer dragging ----------------------------------------------------------------------------------------

  private drag(event: PointerEvent, onMove: (dx: number, dy: number) => void, onDone: () => void): void {
    const surface = event.currentTarget as HTMLElement;
    const startX = event.clientX;
    const startY = event.clientY;
    surface.setPointerCapture(event.pointerId);
    // While dragging, frames and other windows must not swallow the pointer.
    document.body.classList.add('is-dragging');
    const abort = new AbortController();
    const finish = () => {
      abort.abort();
      document.body.classList.remove('is-dragging');
      if (surface.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId);
      onDone();
    };
    on(surface, 'pointermove', (e: PointerEvent) => onMove(e.clientX - startX, e.clientY - startY), abort.signal);
    on(surface, 'pointerup', finish, abort.signal);
    on(surface, 'pointercancel', finish, abort.signal);
    on(surface, 'lostpointercapture', finish, abort.signal);
  }

  /** Snaps the window to the left or right half, fills the screen ('max'), or puts it back as it was ('restore'). */
  snap(win: Win, where: 'left' | 'right' | 'max' | 'restore'): void {
    if (win.fixed || this.compact.matches) return;
    if (where === 'max') {
      if (win.state !== 'max') this.toggleMax(win);
      return;
    }
    if (win.state === 'max') {
      win.state = 'normal';
      this.applyState(win);
    }
    if (where === 'restore') {
      if (win.unsnapped) {
        win.rect = { ...win.unsnapped };
        win.unsnapped = null;
        this.applyRect(win);
      }
    } else {
      const area = this.area();
      win.unsnapped ??= { ...win.rect };
      const half = Math.round(area.width / 2);
      win.rect = { x: where === 'left' ? 0 : area.width - half, y: 0, w: half, h: Math.round(area.height) };
      this.applyRect(win);
    }
    this.focus(win);
  }

  /** Which snap a pointer at this spot would give: the side edges halve, the top edge fills. */
  private snapZone(clientX: number, clientY: number): 'left' | 'right' | 'max' | null {
    const area = this.area();
    if (clientX <= area.left + 6) return 'left';
    if (clientX >= area.right - 6) return 'right';
    if (clientY <= area.top + 4) return 'max';
    return null;
  }

  private ghost: HTMLElement | null = null;
  private showGhost(zone: 'left' | 'right' | 'max' | null): void {
    if (!zone) {
      this.ghost?.remove();
      this.ghost = null;
      return;
    }
    if (!this.ghost) {
      this.ghost = h('div', { class: 'snap-ghost', 'aria-hidden': 'true' });
      this.host.append(this.ghost);
    }
    const area = this.area();
    const half = area.width / 2;
    css(this.ghost, { left: zone === 'right' ? half : 0, top: 0, width: zone === 'max' ? area.width : half, height: area.height });
  }

  private beginMove(win: Win, event: PointerEvent): void {
    if (!event.isPrimary || event.button !== 0) return;
    if (win.el.classList.contains('max')) return;
    if (event.pointerType === 'touch') return;
    const origin = { ...win.rect };
    const startX = event.clientX;
    const startY = event.clientY;
    let zone: 'left' | 'right' | 'max' | null = null;
    let moved = false;
    event.preventDefault();
    this.drag(event, (dx, dy) => {
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      if (!moved && win.unsnapped) {
        // Dragging a snapped window away gives it back its old size, still under the pointer.
        const old = win.unsnapped;
        win.unsnapped = null;
        const grip = Math.min(startX - this.area().left - origin.x, old.w - 60);
        origin.x = startX - this.area().left - grip;
        origin.w = old.w;
        origin.h = old.h;
        win.rect.w = old.w;
        win.rect.h = old.h;
      }
      moved = true;
      win.rect.x = origin.x + dx;
      win.rect.y = origin.y + dy;
      this.applyRect(win);
      zone = this.snapZone(startX + dx, startY + dy);
      this.showGhost(zone);
    }, () => {
      this.showGhost(null);
      if (zone) {
        win.rect = { ...origin };
        this.snap(win, zone);
      } else {
        this.remember(win);
      }
    });
  }

  private beginResize(win: Win, edge: string, event: PointerEvent): void {
    if (!event.isPrimary || event.button !== 0 || win.el.classList.contains('max')) return;
    if (!isPrecisePointer(event) && event.pointerType !== 'touch') return;
    const origin = { ...win.rect };
    const area = this.area();
    event.preventDefault();
    this.drag(event, (dx, dy) => {
      const r = win.rect;
      if (edge.includes('e')) r.w = Math.max(win.minSize[0], origin.w + dx);
      if (edge.includes('s')) r.h = Math.max(win.minSize[1], origin.h + dy);
      if (edge.includes('w')) {
        r.w = Math.max(win.minSize[0], origin.w - dx);
        r.x = origin.x + origin.w - r.w;
      }
      if (edge.includes('n')) {
        r.h = Math.max(win.minSize[1], origin.h - dy);
        r.y = origin.y + origin.h - r.h;
      }
      r.w = Math.min(r.w, area.width * 2);
      this.applyRect(win);
    }, () => this.remember(win));
  }

  private remember(win: Win): void {
    if (!win.fixed && !win.unsnapped) this.savePrefs(win.appId, { ...win.rect });
  }
}
