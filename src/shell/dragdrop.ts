// Dragging items with a mouse or pen. The list of dragged paths is held in memory here, never put in the
// browser's own drag data, so nothing dragged in from another website can pretend to be one of our items.
// A drop lands on the nearest element marked data-drop-path (move into that folder) or data-drop-bin (delete
// to the Recycle Bin). Touch screens use Cut and Paste instead: a finger drag is a scroll.
import { css, h, on } from '../core/dom.ts';
import type { Shell } from './types.ts';

export interface DragOptions {
  shell: Shell;
  event: PointerEvent;
  paths: string[];
  label: string;
  layer: HTMLElement;
  /** Gets first go at a drop; return true if it handled it (the desktop moving an icon to another cell). */
  onDrop?: (target: Element | null, x: number, y: number) => boolean;
}

const START_DISTANCE = 5;
let lastDragEnd = -1000;

/** True for a moment after an item drag ended, so the click that follows it can be ignored. */
export function recentlyDragged(): boolean {
  return performance.now() - lastDragEnd < 150;
}

/** Call from pointerdown on an item. Nothing happens until the pointer has moved a few pixels. */
export function watchForDrag(options: DragOptions): void {
  const { event, shell, paths, layer } = options;
  const startX = event.clientX;
  const startY = event.clientY;
  const abort = new AbortController();
  let ghost: HTMLElement | null = null;
  let hover: Element | null = null;

  const targetAt = (x: number, y: number): Element | null => {
    const under = document.elementFromPoint(x, y);
    return under?.closest('[data-drop-path], [data-drop-bin]') ?? null;
  };
  const usable = (target: Element | null): boolean => {
    const dest = target?.getAttribute('data-drop-path');
    if (dest === null || dest === undefined) return target?.hasAttribute('data-drop-bin') ?? false;
    const prefix = dest.toLowerCase() + '/';
    // Not onto itself or into something inside itself.
    return !paths.some(p => (p + '/').toLowerCase() === prefix || prefix.startsWith(p.toLowerCase() + '/'));
  };
  const mark = (target: Element | null) => {
    if (hover === target) return;
    hover?.classList.remove('drop-target');
    hover = target && usable(target) ? target : null;
    hover?.classList.add('drop-target');
  };
  const end = () => {
    abort.abort();
    ghost?.remove();
    hover?.classList.remove('drop-target');
    document.body.classList.remove('is-item-dragging');
  };

  on(window, 'pointermove', (e: PointerEvent) => {
    if (e.pointerId !== event.pointerId) return;
    if (!ghost) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < START_DISTANCE) return;
      ghost = h('div', { class: 'drag-ghost', 'aria-hidden': 'true' }, options.label);
      layer.append(ghost);
      document.body.classList.add('is-item-dragging');
    }
    css(ghost, { left: e.clientX + 12, top: e.clientY + 8 });
    mark(targetAt(e.clientX, e.clientY));
  }, abort.signal);

  on(window, 'pointerup', (e: PointerEvent) => {
    if (e.pointerId !== event.pointerId) return;
    const dragged = ghost !== null;
    const target = dragged ? targetAt(e.clientX, e.clientY) : null;
    end();
    if (!dragged) return;
    // A click that follows a drag must not also open or select anything: views ask recentlyDragged().
    lastDragEnd = performance.now();
    if (options.onDrop?.(target, e.clientX, e.clientY)) return;
    if (!target || !usable(target)) return;
    if (target.hasAttribute('data-drop-bin')) void shell.actions.deleteToBin(paths);
    else void shell.actions.moveInto(paths, target.getAttribute('data-drop-path')!);
  }, abort.signal);

  on(window, 'pointercancel', end, abort.signal);
  on(window, 'keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') end();
  }, abort.signal);
}
