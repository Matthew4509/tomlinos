// Named toolbars for the classic bar (menubar.ts): each can be shown or hidden, moved to another place in the rows
// across the top, or docked down the left or right edge of the app's work area, and the places are kept per person.
//
// - A toolbar starts with a grip, three dots on its left (on top when it stands up). Drag the grip: a guide shows where
//   the toolbar will land (between two toolbars in the rows, or as a column on the left or right); let go to put it
//   there, or press Escape to leave it where it was. Pointer events, so a finger works too.
// - With the grip focused (Tab), the arrow keys move it: Up to the row before (or up to the top from a side), Down to
//   the row after, Left and Right dock it on that side (pressed again, one column further out).
// - Across the top, a toolbar too long for the window wraps onto more rows; down a side, buttons that do not fit the
//   height go into a » menu at its end.
// - Down a side a toolbar takes room from the work area. When that would leave the work area narrower than
//   MIN_WORK_WIDTH, the side toolbars go back up to the top (the last placed first) until the window is wide enough
//   again; their kept place does not change.
// - View > Toolbars (menuItem()): a tick for each toolbar, Position > (toolbar) > Top, Left or Right, and Reset
//   toolbars.
// - What is kept: { v: 1, bars: [{ id, side, shown }] } in the toolbars' order. readLayout() checks it: a toolbar it
//   does not name gets its usual place, a name it does not know is dropped, and anything broken gives the usual layout.
import { h, on } from '../core/dom.ts';
import type { MenuItem, MenuLayer } from './menu.ts';
import { fitCount, syncToolButton, toolButtonEl, type BarItem, type ToolButton, type ToolEntry } from './menubar.ts';

export type Side = 'top' | 'left' | 'right';
export const SIDES: readonly Side[] = ['top', 'left', 'right'];
const SIDE_NAMES: Record<Side, string> = { top: 'Top', left: 'Left', right: 'Right' };

/** The narrowest the work area is left by toolbars docked at its sides; narrower, they go to the top. */
export const MIN_WORK_WIDTH = 400;
/** How near the work area's left or right edge (px) a dragged toolbar docks on that side. */
const EDGE = 48;

export interface ToolbarSpec {
  /** Kept in the saved layout and on the element (data-toolbar). */
  id: string;
  /** Shown in View > Toolbars and read out ("Draw toolbar"). */
  name: string;
  tools: ToolEntry[];
  /** Where it starts (the top unless said). */
  side?: Side;
  /** Starts hidden. */
  hidden?: boolean;
}

export interface ToolbarPlace {
  id: string;
  side: Side;
  shown: boolean;
}

export interface SavedToolbars {
  v: 1;
  bars: ToolbarPlace[];
}

/** Where the places are kept: what was saved last time (any shape; it is checked) and how to keep a change. */
export interface ToolbarStore {
  saved?: unknown;
  save?(layout: SavedToolbars): void;
}

// ---- The layout: plain functions, no page needed (test/toolbars.test.ts) -------------------------------------------

export function defaultLayout(specs: ToolbarSpec[]): ToolbarPlace[] {
  return specs.map(s => ({ id: s.id, side: s.side ?? 'top', shown: !s.hidden }));
}

/** The saved layout checked against the toolbars there are; anything that is not a layout gives the usual one. */
export function readLayout(saved: unknown, specs: ToolbarSpec[]): ToolbarPlace[] {
  const usual = defaultLayout(specs);
  if (!saved || typeof saved !== 'object' || !Array.isArray((saved as { bars?: unknown }).bars)) return usual;
  const known = new Set(specs.map(s => s.id));
  const out: ToolbarPlace[] = [];
  for (const raw of (saved as { bars: unknown[] }).bars) {
    if (!raw || typeof raw !== 'object') continue;
    const { id, side, shown } = raw as Record<string, unknown>;
    if (typeof id !== 'string' || !known.has(id) || out.some(p => p.id === id)) continue;
    if (typeof side !== 'string' || !SIDES.includes(side as Side) || typeof shown !== 'boolean') continue;
    out.push({ id, side: side as Side, shown });
  }
  if (!out.length) return usual;
  // A toolbar the saved layout does not name (new since, or a broken entry) goes after the others on its usual side.
  for (const p of usual) if (!out.some(q => q.id === p.id)) out.splice(lastIndexOn(out, p.side) + 1, 0, { ...p });
  return out;
}

function lastIndexOn(layout: ToolbarPlace[], side: Side): number {
  for (let i = layout.length - 1; i >= 0; i--) if (layout[i].side === side) return i;
  return layout.length - 1;
}

/** The layout with toolbar `id` docked on `side`, just before toolbar `before` (null: after the last one there). */
export function moveBar(layout: ToolbarPlace[], id: string, side: Side, before: string | null): ToolbarPlace[] {
  const me = layout.find(p => p.id === id);
  if (!me) return layout;
  const rest = layout.filter(p => p.id !== id);
  const moved = { ...me, side };
  const at = before ? rest.findIndex(p => p.id === before) : -1;
  if (at >= 0) rest.splice(at, 0, moved);
  else {
    const hasSide = rest.some(p => p.side === side);
    rest.splice(hasSide ? lastIndexOn(rest, side) + 1 : rest.length, 0, moved);
  }
  return rest;
}

export type MoveKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';

/**
 * An arrow key on a toolbar's grip: Up to the row before (from a side: up to the top, at the end), Down to the row
 * after, Left or Right docks it on that side (beside the work area; pressed again, one column further out). Null when
 * it cannot go that way.
 */
export function keyMove(layout: ToolbarPlace[], id: string, key: MoveKey): ToolbarPlace[] | null {
  const me = layout.find(p => p.id === id);
  if (!me) return null;
  const peers = layout.filter(p => p.side === me.side && (p.shown || p.id === id));
  const at = peers.findIndex(p => p.id === id);
  const firstOn = (side: Side) => layout.find(p => p.side === side && p.id !== id)?.id ?? null;
  if (key === 'ArrowUp') {
    if (me.side !== 'top') return moveBar(layout, id, 'top', null);
    return at > 0 ? moveBar(layout, id, 'top', peers[at - 1].id) : null;
  }
  if (key === 'ArrowDown') {
    if (me.side !== 'top' || at >= peers.length - 1) return null;
    return moveBar(layout, id, 'top', peers[at + 2]?.id ?? null);
  }
  const want: Side = key === 'ArrowLeft' ? 'left' : 'right';
  // Onto a side: next to the work area (the last column on the left, the first on the right).
  if (me.side !== want) return moveBar(layout, id, want, want === 'left' ? null : firstOn('right'));
  // Already there: one column further out.
  if (want === 'left') return at > 0 ? moveBar(layout, id, 'left', peers[at - 1].id) : null;
  return at < peers.length - 1 ? moveBar(layout, id, 'right', peers[at + 2]?.id ?? null) : null;
}

/**
 * The side toolbars drawn at the top for now: while the frame is `width` wide and the shown side toolbars (each
 * `widthOf` wide standing up) would leave the work area narrower than `min`, the last placed goes up first.
 */
export function fallbackIds(layout: ToolbarPlace[], widthOf: (id: string) => number, width: number, min = MIN_WORK_WIDTH): Set<string> {
  const out = new Set<string>();
  const side = layout.filter(p => p.shown && p.side !== 'top');
  let used = side.reduce((sum, p) => sum + widthOf(p.id), 0);
  for (let i = side.length - 1; i >= 0 && width - used < min; i--) {
    out.add(side[i].id);
    used -= widthOf(side[i].id);
  }
  return out;
}

export function sameLayout(a: ToolbarPlace[], b: ToolbarPlace[]): boolean {
  return a.length === b.length && a.every((p, i) => p.id === b[i].id && p.side === b[i].side && p.shown === b[i].shown);
}

// ---- On the page --------------------------------------------------------------------------------------------------

export interface Docking {
  /** The rows across the top (the bar puts it under the menus). */
  topDock: HTMLElement;
  /** Puts the side docks round the work area; put the frame where the work area was. */
  frame(work: HTMLElement): HTMLElement;
  band(id: string): HTMLElement | null;
  /** View > Toolbars. */
  menuItem(): BarItem;
  /** Asks the buttons' getters again. */
  refresh(): void;
  layout(): ToolbarPlace[];
  show(id: string, shown: boolean): void;
  place(id: string, side: Side): void;
  reset(): void;
}

interface DockContext {
  signal: AbortSignal;
  layer: MenuLayer;
  wrap: (action: () => void) => () => void;
  /** Where the keyboard goes when it leaves a toolbar. */
  home: () => HTMLElement | null;
  store?: ToolbarStore;
}

interface Band {
  spec: ToolbarSpec;
  el: HTMLElement;
  grip: HTMLButtonElement;
  more: HTMLButtonElement;
  items: Array<{ entry: ToolEntry; el: HTMLElement }>;
  /** Items in the » menu for want of height. */
  spill: Set<number>;
  stop: HTMLElement | null;
}

interface Target {
  side: Side;
  before: string | null;
  guide: { x: number; y: number; w: number; h: number; area?: boolean };
}

const isButton = (t: ToolEntry): t is ToolButton => typeof t === 'object' && 'action' in t;
const isOn = (getter: (() => boolean) | undefined) => (getter ? getter() : true);

export function docking(specs: ToolbarSpec[], ctx: DockContext): Docking {
  const { signal, layer, wrap } = ctx;
  const topDock = h('div', { class: 'cbar-dock cbar-dock-top', 'data-side': 'top' });
  const leftDock = h('div', { class: 'cbar-dock cbar-dock-side', 'data-side': 'left' });
  const rightDock = h('div', { class: 'cbar-dock cbar-dock-side', 'data-side': 'right' });
  const docks: Record<Side, HTMLElement> = { top: topDock, left: leftDock, right: rightDock };
  let frameEl: HTMLElement | null = null;
  let workEl: HTMLElement | null = null;
  let layout = readLayout(ctx.store?.saved, specs);
  /** Each toolbar's width when last drawn standing up (for deciding whether a side has room). */
  const upright = new Map<string, number>();
  const bands = new Map<string, Band>();
  const placeOf = (id: string) => layout.find(p => p.id === id)!;

  // ---- The toolbars ----
  for (const spec of specs) {
    const name = `Move ${spec.name} toolbar`;
    const grip = h('button', { type: 'button', class: 'cbar-grip', 'aria-label': name, title: name, tabindex: 0, 'data-grip': spec.id }, h('span', { class: 'cbar-grip-dots', 'aria-hidden': 'true' }, '⋮'));
    const items = spec.tools.map(entry => {
      if (entry === '|') return { entry, el: h('span', { class: 'cbar-tsep', role: 'separator' }) };
      if (!isButton(entry)) return { entry, el: h('span', { class: 'cbar-widget' }, entry.widget) };
      return { entry, el: toolButtonEl(entry, signal, wrap) as HTMLElement };
    });
    const more = h('button', { type: 'button', class: 'cbar-tool cbar-more', tabindex: -1, 'aria-label': 'More buttons', title: 'More buttons', 'aria-haspopup': 'menu', hidden: true }, '»');
    const el = h('div', { class: 'cbar-band', role: 'toolbar', 'aria-label': spec.name, 'data-toolbar': spec.id }, grip, ...items.map(i => i.el), more);
    const band: Band = { spec, el, grip, more, items, spill: new Set(), stop: null };
    bands.set(spec.id, band);
    wireBand(band);
    wireGrip(band);
  }

  /** The buttons the arrow keys go between, in order. */
  function roving(b: Band): HTMLElement[] {
    const list = b.items.filter(t => isButton(t.entry) && !t.el.hidden && t.el.getAttribute('aria-disabled') !== 'true').map(t => t.el);
    return b.more.hidden ? list : [...list, b.more];
  }
  function setStop(b: Band, el: HTMLElement | null): void {
    for (const t of b.items) if (isButton(t.entry)) t.el.tabIndex = -1;
    b.more.tabIndex = -1;
    b.stop = el ?? roving(b)[0] ?? null;
    if (b.stop) b.stop.tabIndex = 0;
  }

  function wireBand(b: Band): void {
    on(b.el, 'keydown', (event: KeyboardEvent) => {
      if (event.target === b.grip) return;
      const all = roving(b);
      const at = all.indexOf(document.activeElement as HTMLElement);
      if (at < 0) return;
      let to = -1;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') to = (at + 1) % all.length;
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') to = (at - 1 + all.length) % all.length;
      else if (event.key === 'Home') to = 0;
      else if (event.key === 'End') to = all.length - 1;
      else if (event.key === 'Escape') {
        event.preventDefault();
        ctx.home()?.focus({ preventScroll: true });
        return;
      }
      if (to < 0) return;
      event.preventDefault();
      setStop(b, all[to]);
      all[to].focus({ preventScroll: true });
    }, signal);
    on(b.el, 'focusin', (event: FocusEvent) => {
      if (event.target instanceof HTMLElement && roving(b).includes(event.target)) setStop(b, event.target);
    }, signal);
    on(b.more, 'pointerdown', (event: PointerEvent) => {
      if (event.pointerType === 'mouse') event.preventDefault();
    }, signal);
    on(b.more, 'click', () => {
      const r = b.more.getBoundingClientRect();
      const items: MenuItem[] = [];
      for (const i of [...b.spill].sort((x, y) => x - y)) {
        const entry = b.items[i].entry;
        if (entry === '|') items.push({ separator: true });
        else if (isButton(entry)) items.push({ label: entry.label, hint: entry.shortcut, disabled: !isOn(entry.enabled), checked: entry.pressed ? entry.pressed() : undefined, action: wrap(entry.action) });
      }
      const clean = items.filter((it, k) => !(it.separator && (k === 0 || k === items.length - 1 || items[k - 1].separator)));
      const fromKeyboard = document.activeElement === b.more;
      if (clean.length) layer.show(clean, r.left, r.bottom, { returnFocus: fromKeyboard ? b.more : ctx.home(), fromKeyboard, anchor: b.el });
    }, signal);
  }

  // ---- Moving a toolbar by its grip ----
  let drag: { band: Band; pointer: number; x: number; y: number; moving: boolean; target: Target | null } | null = null;
  const guide = h('div', { class: 'cbar-guide', 'aria-hidden': 'true' });
  function endDrag(): void {
    if (!drag) return;
    const { band, pointer } = drag;
    drag = null;
    band.el.classList.remove('cbar-dragging');
    guide.remove();
    try {
      if (band.grip.hasPointerCapture(pointer)) band.grip.releasePointerCapture(pointer);
    } catch {
      // That pointer is gone already.
    }
  }
  function wireGrip(b: Band): void {
    const { grip } = b;
    on(grip, 'pointerdown', (event: PointerEvent) => {
      if (event.button !== 0) return;
      // The keyboard stays where it was; the press is only for dragging.
      event.preventDefault();
      if (layer.isOpen) layer.close();
      drag = { band: b, pointer: event.pointerId, x: event.clientX, y: event.clientY, moving: false, target: null };
      try {
        grip.setPointerCapture(event.pointerId);
      } catch {
        // A pointer the browser no longer knows: the moves still come to the grip while it is over it.
      }
    }, signal);
    on(grip, 'pointermove', (event: PointerEvent) => {
      if (!drag || drag.band !== b || event.pointerId !== drag.pointer) return;
      if (!drag.moving) {
        if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 4) return;
        drag.moving = true;
        b.el.classList.add('cbar-dragging');
        document.body.append(guide);
      }
      drag.target = dropAt(event.clientX, event.clientY, b.spec.id);
      showGuide(drag.target);
    }, signal);
    on(grip, 'pointerup', (event: PointerEvent) => {
      if (!drag || drag.band !== b || event.pointerId !== drag.pointer) return;
      const { moving, target } = drag;
      endDrag();
      if (moving && target) apply(moveBar(layout, b.spec.id, target.side, target.before));
    }, signal);
    on(grip, 'pointercancel', () => endDrag(), signal);
    on(grip, 'lostpointercapture', () => endDrag(), signal);
    on(grip, 'keydown', (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (drag) endDrag();
        else ctx.home()?.focus({ preventScroll: true });
        return;
      }
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown' && event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      event.stopPropagation();
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const next = keyMove(layout, b.spec.id, event.key);
      if (next) apply(next);
      grip.focus({ preventScroll: true });
    }, signal);
  }
  // Escape stops a drag wherever the keyboard is.
  on(document, 'keydown', (event: KeyboardEvent) => {
    if (!drag || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    endDrag();
  }, signal, { capture: true });

  const shownIn = (side: Side, except: string) => [...docks[side].children].filter((el): el is HTMLElement => el instanceof HTMLElement && !el.hidden && el.dataset.toolbar !== except);

  function dropAt(x: number, y: number, id: string): Target | null {
    const top = topDock.getBoundingClientRect();
    const across = (frameEl ?? topDock).getBoundingClientRect();
    if (x < across.left - EDGE || x > across.right + EDGE) return null;
    const work = frameEl && workEl ? workEl.getBoundingClientRect() : null;
    if (work && y >= top.bottom && y <= work.bottom + EDGE) {
      if (x < work.left + EDGE) return sideTarget('left', x, id, work);
      if (x > work.right - EDGE) return sideTarget('right', x, id, work);
    }
    const reach = work ? work.top + EDGE : top.bottom + EDGE;
    if (y >= top.top - 40 && y < reach) return topTarget(x, y, id, top);
    return null;
  }
  function topTarget(x: number, y: number, id: string, top: DOMRect): Target {
    const others = shownIn('top', id);
    let prev: DOMRect | null = null;
    for (const el of others) {
      const r = el.getBoundingClientRect();
      if (y < r.top || (y <= r.bottom && x < r.left + r.width / 2)) {
        // Past the end of the row above: the guide shows at that row's end.
        const g = prev && y <= prev.bottom && r.top > prev.top ? { x: prev.right - 1, y: prev.top, w: 3, h: prev.height } : { x: r.left - 2, y: r.top, w: 3, h: r.height };
        return { side: 'top', before: el.dataset.toolbar ?? null, guide: g };
      }
      prev = r;
    }
    if (prev) return { side: 'top', before: null, guide: { x: prev.right - 1, y: prev.top, w: 3, h: prev.height } };
    return { side: 'top', before: null, guide: { x: top.left, y: top.bottom - 2, w: top.width, h: 3 } };
  }
  function sideTarget(side: Side, x: number, id: string, work: DOMRect): Target {
    const others = shownIn(side, id);
    let prev: DOMRect | null = null;
    for (const el of others) {
      const r = el.getBoundingClientRect();
      if (x < r.left + r.width / 2) return { side, before: el.dataset.toolbar ?? null, guide: { x: r.left - 1, y: work.top, w: 3, h: work.height } };
      prev = r;
    }
    if (prev) return { side, before: null, guide: { x: prev.right - 2, y: work.top, w: 3, h: work.height } };
    // A side with no toolbar yet: the column it will take.
    const w = 30;
    return { side, before: null, guide: { x: side === 'left' ? work.left : work.right - w, y: work.top, w, h: work.height, area: true } };
  }
  function showGuide(t: Target | null): void {
    guide.hidden = !t;
    if (!t) return;
    guide.classList.toggle('cbar-guide-area', !!t.guide.area);
    guide.dataset.side = t.side;
    Object.assign(guide.style, { left: `${Math.round(t.guide.x)}px`, top: `${Math.round(t.guide.y)}px`, width: `${Math.round(t.guide.w)}px`, height: `${Math.round(t.guide.h)}px` });
  }

  // ---- Placing them ----
  function apply(next: ToolbarPlace[]): void {
    layout = next;
    ctx.store?.save?.({ v: 1, bars: layout.map(p => ({ ...p })) });
    render();
  }

  function render(): void {
    const width = frameEl?.isConnected ? frameEl.clientWidth : 0;
    // Without a frame (dock() not used) there are no sides: everything is drawn at the top.
    const up = frameEl ? fallbackIds(layout, id => upright.get(id) ?? 34, width || Infinity) : new Set(layout.filter(p => p.side !== 'top').map(p => p.id));
    const want: Record<Side, HTMLElement[]> = { top: [], left: [], right: [] };
    const had = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    for (const p of layout) {
      const b = bands.get(p.id)!;
      const side = up.has(p.id) ? 'top' : p.side;
      want[side].push(b.el);
      b.el.hidden = !p.shown;
      b.el.dataset.side = side;
      b.el.setAttribute('aria-orientation', side === 'top' ? 'horizontal' : 'vertical');
      b.el.classList.toggle('cbar-fallback', up.has(p.id));
    }
    for (const side of SIDES) {
      const dock = docks[side];
      const now = [...dock.children];
      if (now.length !== want[side].length || now.some((el, i) => el !== want[side][i])) dock.append(...want[side]);
      dock.hidden = !want[side].some(el => !el.hidden);
    }
    // Moving an element takes the keyboard from it; give it back.
    if (had && had !== document.activeElement && had.isConnected) had.focus({ preventScroll: true });
    fitAll();
  }

  /** Down a side, the buttons that do not fit the height go into » (across the top they wrap instead). */
  const heightOf = new WeakMap<HTMLElement, number>();
  function measure(el: HTMLElement): number {
    if (el.hidden && heightOf.has(el)) return heightOf.get(el)!;
    const was = el.hidden;
    el.hidden = false;
    const cs = getComputedStyle(el);
    const v = el.getBoundingClientRect().height + (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
    el.hidden = was;
    if (v > 0) heightOf.set(el, v);
    return v;
  }
  function fitAll(): void {
    for (const b of bands.values()) {
      const wanted = (i: number) => {
        const e = b.items[i].entry;
        return !(isButton(e) && !isOn(e.shown));
      };
      b.spill.clear();
      const standing = b.el.dataset.side !== 'top';
      if (!standing || b.el.hidden || !b.el.isConnected) {
        b.items.forEach((t, i) => {
          if (t.el.hidden === wanted(i)) t.el.hidden = !wanted(i);
        });
        if (!b.more.hidden) b.more.hidden = true;
      } else {
        const cs = getComputedStyle(b.el);
        const room = b.el.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0) - measure(b.grip);
        if (room > 0) {
          const gap = parseFloat(cs.rowGap) || 0;
          const heights = b.items.map((t, i) => (wanted(i) ? measure(t.el) + gap : 0));
          const n = fitCount(heights, room - gap - 1, measure(b.more) + gap + 2);
          b.items.forEach((t, i) => {
            const show = wanted(i) && i < n;
            if (wanted(i) && !show) b.spill.add(i);
            if (t.el.hidden === show) t.el.hidden = !show;
          });
          const needMore = [...b.spill].some(i => b.items[i].entry !== '|');
          if (b.more.hidden === needMore) b.more.hidden = !needMore;
        }
        if (b.el.offsetWidth > 0) upright.set(b.spec.id, b.el.offsetWidth);
      }
      // A separator at the end, or just before », is not drawn.
      const shown = b.items.filter(t => !t.el.hidden);
      const last = shown[shown.length - 1];
      if (last && last.entry === '|') last.el.hidden = true;
      if (!b.stop || b.stop.hidden || b.stop.getAttribute('aria-disabled') === 'true') setStop(b, null);
    }
  }

  function refresh(): void {
    for (const b of bands.values()) for (const t of b.items) if (isButton(t.entry)) syncToolButton(t.entry, t.el);
    fitAll();
  }

  // Sizes change with the window (and the large-button look): placed again on the next frame, so a change made here
  // is never measured in the same pass.
  let queued = false;
  const soon = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (!signal.aborted) render();
    });
  };
  const watch = new ResizeObserver(soon);
  watch.observe(topDock);
  watch.observe(leftDock);
  watch.observe(rightDock);
  signal.addEventListener('abort', () => {
    watch.disconnect();
    guide.remove();
  }, { once: true });

  function show(id: string, shown: boolean): void {
    const b = bands.get(id);
    if (!b) return;
    if (!shown && b.el.contains(document.activeElement)) ctx.home()?.focus({ preventScroll: true });
    apply(layout.map(p => (p.id === id ? { ...p, shown } : p)));
  }
  function place(id: string, side: Side): void {
    if (!bands.has(id)) return;
    const moved = placeOf(id).side === side ? layout : moveBar(layout, id, side, side === 'right' ? (layout.find(p => p.side === 'right' && p.id !== id)?.id ?? null) : null);
    apply(moved.map(p => (p.id === id ? { ...p, shown: true } : p)));
  }

  render();

  return {
    topDock,
    frame(work) {
      workEl = work;
      work.classList.add('cbar-work');
      frameEl = h('div', { class: 'cbar-frame' }, leftDock, work, rightDock);
      watch.observe(frameEl);
      render();
      return frameEl;
    },
    band: id => bands.get(id)?.el ?? null,
    menuItem: () => ({
      label: 'Toolbars',
      submenu: () => [
        ...specs.map(s => ({ label: s.name, checked: () => placeOf(s.id).shown, action: () => show(s.id, !placeOf(s.id).shown) })),
        { separator: true },
        {
          label: 'Position',
          submenu: () => specs.map(s => ({
            label: s.name,
            submenu: () => SIDES.map(side => ({ label: SIDE_NAMES[side], checked: () => placeOf(s.id).side === side, action: () => place(s.id, side) })),
          })),
        },
        { separator: true },
        { label: 'Reset toolbars', action: () => apply(defaultLayout(specs)) },
      ],
    }),
    refresh,
    layout: () => layout.map(p => ({ ...p })),
    show,
    place,
    reset: () => apply(defaultLayout(specs)),
  };
}
