// The taskbar: the Start button, one button per window, a padlock (lock at once; right-click to sign out), the clock
// (which opens a small calendar) and a "show desktop" button. The clock reads this device's own time; nothing is
// fetched.
import { css, h, on } from '../core/dom.ts';
import { addMonths, dateKey, monthCells, weekdayNames } from '../core/ical.ts';
import { icon } from './icons.ts';
import type { MenuLayer } from './menu.ts';
import type { WindowManager } from './windows.ts';

export interface TaskbarParts {
  bar: HTMLElement;
  startButton: HTMLButtonElement;
}

/** What the padlock does. signOut is null without accounts (the browser-only copy), where there is nothing to lock. */
export interface QuickLock {
  canLock(): boolean;
  lock(): void;
  signOut: (() => void) | null;
}

export function buildTaskbar(host: HTMLElement, windows: WindowManager, menus: MenuLayer, signal: AbortSignal, calendarHost: HTMLElement, quick?: QuickLock): TaskbarParts {
  const startButton = h('button', { type: 'button', class: 'start-btn', 'aria-label': document.documentElement.dataset.theme === 'xfce' ? 'Menu' : 'Start', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': 'start-menu' }, h('span', { class: 'start-orb', 'aria-hidden': 'true' }), h('span', { class: 'start-label' }, document.documentElement.dataset.theme === 'xfce' ? 'Menu' : 'Start'));
  const tasks = h('div', { class: 'tasks', role: 'toolbar', 'aria-label': 'Open windows' });
  const showDesktop = h('button', { type: 'button', class: 'tray-btn', 'aria-label': 'Show the desktop', title: 'Show the desktop' }, h('span', { class: 'glyph-desk', 'aria-hidden': 'true' }));
  const clock = h('button', { type: 'button', class: 'clock', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' });
  const padlock = h('button', { type: 'button', class: 'tray-btn tray-lock', 'aria-label': 'Lock the screen', title: 'Lock the screen (Alt+L). Right-click to sign out (Alt+Shift+L).', hidden: !quick?.signOut }, icon('lock', 16));
  if (quick) {
    on(padlock, 'click', () => (quick.canLock() ? quick.lock() : quick.signOut?.()), signal);
    on(padlock, 'contextmenu', (event: MouseEvent) => {
      event.preventDefault();
      const r = padlock.getBoundingClientRect();
      menus.show([
        { label: 'Lock the screen (Alt+L)', action: () => quick.lock(), disabled: !quick.canLock() },
        { label: 'Sign out (Alt+Shift+L)', action: () => quick.signOut?.(), disabled: !quick.signOut },
      ], event.clientX || r.left, event.clientY || r.top, { returnFocus: padlock, fromKeyboard: event.detail === 0, anchor: padlock });
    }, signal);
  }
  const tray = h('div', { class: 'tray' }, padlock, clock, showDesktop);
  host.append(startButton, tasks, tray);

  function drawTasks(): void {
    const front = windows.front();
    tasks.replaceChildren(
      ...windows.list().filter(w => !w.fixed).map(win => {
        const active = win === front;
        const b = h(
          'button',
          { type: 'button', class: `task${active ? ' active' : ''}${win.state === 'min' ? ' minimised' : ''}`, 'aria-pressed': String(active), title: win.title, 'data-win': win.id },
          icon(win.iconName, 16),
          h('span', { class: 'task-label' }, win.dirty ? `${win.title} *` : win.title),
        );
        return b;
      }),
    );
  }
  // One listener pair for all task buttons (they are redrawn on every window change; per-button listeners would pile up).
  const taskOf = (event: Event) => {
    const b = event.target instanceof Element ? event.target.closest<HTMLElement>('.task') : null;
    const win = b && windows.list().find(w => w.id === b.dataset.win);
    return win && b ? { win, b } : null;
  };
  on(tasks, 'click', (event: MouseEvent) => {
    const hit = taskOf(event);
    if (hit) windows.toggle(hit.win);
  }, signal);
  on(tasks, 'contextmenu', (event: MouseEvent) => {
    const hit = taskOf(event);
    if (!hit) return;
    event.preventDefault();
    menus.show(windows.windowMenu(hit.win), event.clientX, event.clientY, { returnFocus: hit.b });
  }, signal);
  windows.changed.on(drawTasks, signal);
  on(showDesktop, 'click', () => windows.showDesktop(), signal);

  // ---- Clock and calendar --------------------------------------------------------------------------------------

  const tick = () => {
    const now = new Date();
    clock.textContent = now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    clock.title = now.toLocaleDateString(undefined, { dateStyle: 'full' });
  };
  tick();
  const timer = window.setInterval(() => {
    if (!document.hidden) tick();
  }, 15000);
  signal.addEventListener('abort', () => clearInterval(timer), { once: true });

  let calendar: { el: HTMLElement; abort: AbortController } | null = null;
  const closeCalendar = () => {
    if (!calendar) return;
    calendar.abort.abort();
    calendar.el.remove();
    calendar = null;
    clock.setAttribute('aria-expanded', 'false');
  };
  on(clock, 'click', () => {
    if (calendar) return closeCalendar();
    const abort = new AbortController();
    const today = new Date();
    let year = today.getFullYear();
    let month = today.getMonth();
    const title = h('div', { class: 'cal-title', 'aria-live': 'polite' });
    const grid = h('div', { class: 'cal-grid', role: 'grid', 'aria-label': 'Month' });
    const prev = h('button', { type: 'button', class: 'tool', 'aria-label': 'Previous month' }, '‹');
    const next = h('button', { type: 'button', class: 'tool', 'aria-label': 'Next month' }, '›');
    const el = h('div', { class: 'calendar', role: 'dialog', 'aria-label': 'Calendar', tabindex: -1 }, h('div', { class: 'cal-head' }, prev, title, next), grid);
    const draw = () => {
      title.textContent = new Date(year, month, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
      const todayKey = dateKey(today);
      const days = monthCells(year, month);
      const rows: Node[] = [h('div', { class: 'cal-row', role: 'row' }, ...weekdayNames('narrow').map(n => h('span', { class: 'cal-dow', role: 'columnheader' }, n)))];
      for (let w = 0; w < 6; w++) {
        const week = days.slice(w * 7, w * 7 + 7);
        if (w > 0 && week[0].getMonth() !== month) break; // a sixth row wholly in the next month is left off
        rows.push(h('div', { class: 'cal-row', role: 'row' }, ...week.map(d => {
          const isToday = dateKey(d) === todayKey;
          return d.getMonth() !== month
            ? h('span', { class: 'cal-blank', role: 'gridcell' })
            : h('span', { class: `cal-day${isToday ? ' today' : ''}`, role: 'gridcell', 'aria-current': isToday ? 'date' : null }, d.getDate());
        })));
      }
      grid.replaceChildren(...rows);
    };
    on(prev, 'click', () => {
      [year, month] = addMonths(year, month, -1);
      draw();
    }, abort.signal);
    on(next, 'click', () => {
      [year, month] = addMonths(year, month, 1);
      draw();
    }, abort.signal);
    // Tabbing out of the pop-up closes it, as clicking elsewhere does.
    on(el, 'focusout', (event: FocusEvent) => {
      // Focus going to the clock itself is left to the clock's own click (which closes it), or it would reopen at once.
      const to = event.relatedTarget;
      if (to instanceof Node && (el.contains(to) || clock.contains(to))) return;
      if (to !== null) closeCalendar();
    }, abort.signal);
    on(document, 'pointerdown', (event: PointerEvent) => {
      if (event.target instanceof Node && !el.contains(event.target) && !clock.contains(event.target)) closeCalendar();
    }, abort.signal, { capture: true });
    on(el, 'keydown', (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeCalendar();
        clock.focus();
      }
    }, abort.signal);
    draw();
    calendarHost.append(el);
    calendar = { el, abort };
    clock.setAttribute('aria-expanded', 'true');
    css(el, { right: 4, bottom: 4 });
    prev.focus();
  }, signal);

  drawTasks();
  return { bar: host, startButton };
}
