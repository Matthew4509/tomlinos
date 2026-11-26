// "Open apps" in the taskbar tray: a small panel above the button listing every open window (minimised ones too), to
// switch to one with a click or close it with one. Closing goes through the window's normal close, so unsaved work is
// still asked about, one question per window at a time. The list is a listbox: each row is one choice (switch to that
// window); the close cross on a row is for the pointer, and Delete does the same from the keyboard. Windows hosted
// inside the Panel app are part of the Panel's window, so they are not listed on their own.
import { h, on } from '../core/dom.ts';
import { icon } from './icons.ts';
import { toolIcon } from './toolicons.ts';
import type { Win, WindowManager } from './windows.ts';

export function buildOpenApps(windows: WindowManager, host: HTMLElement, signal: AbortSignal): HTMLButtonElement {
  const count = h('span', { class: 'apps-count', 'aria-hidden': 'true', hidden: true });
  const button = h('button', { type: 'button', class: 'tray-btn tray-apps', 'aria-label': 'Open apps', title: 'Open apps', 'aria-haspopup': 'dialog', 'aria-expanded': 'false' }, toolIcon('open-apps', 16), count);
  // The same windows as the taskbar buttons: dialog-style windows have no button there and are left out here too.
  const listed = (): Win[] => windows.list().filter(w => !w.fixed);

  const paintCount = () => {
    const n = listed().length;
    count.hidden = n === 0;
    count.textContent = n > 9 ? '9+' : String(n);
    button.title = n ? `Open apps (${n})` : 'Open apps';
  };
  windows.changed.on(paintCount, signal);
  paintCount();

  let panel: { el: HTMLElement; abort: AbortController } | null = null;
  // The row last focused, so focus finds its way back after the list is drawn again or a window closes.
  let currentId: string | null = null;
  let currentIndex = 0;

  const close = (restore: boolean) => {
    if (!panel) return;
    panel.abort.abort();
    panel.el.remove();
    panel = null;
    button.setAttribute('aria-expanded', 'false');
    if (restore) button.focus();
  };

  on(button, 'click', () => {
    if (panel) return close(false);
    open();
  }, signal);

  function open(): void {
    const abort = new AbortController();
    const list = h('div', { class: 'apps-list', role: 'listbox', 'aria-label': 'Open apps', 'aria-orientation': 'vertical' });
    const closeAll = h('button', { type: 'button', class: 'btn apps-close-all' }, 'Close all');
    const empty = h('p', { class: 'apps-empty' }, 'No apps are open.');
    const el = h('div', { class: 'open-apps', role: 'dialog', 'aria-label': 'Open apps', tabindex: -1 },
      h('div', { class: 'apps-head' }, 'Open apps'), list, empty, h('div', { class: 'apps-foot' }, closeAll));
    panel = { el, abort };
    currentId = null;
    currentIndex = 0;

    const rows = () => [...list.querySelectorAll<HTMLElement>('[role="option"]')];
    const winOf = (row: Element | null) => (row instanceof HTMLElement ? listed().find(w => w.id === row.dataset.win) : undefined);
    const focusRow = (row: HTMLElement | undefined) => {
      if (!row) {
        (closeAll.disabled ? el : closeAll).focus({ preventScroll: true });
        return;
      }
      for (const r of rows()) {
        r.tabIndex = r === row ? 0 : -1;
        r.setAttribute('aria-selected', String(r === row));
      }
      row.focus({ preventScroll: true });
      row.scrollIntoView({ block: 'nearest' });
    };
    /** Puts focus back on the row it was on, or the one now in its place when that window has closed. */
    const refocus = () => {
      const all = rows();
      focusRow(all.find(r => r.dataset.win === currentId) ?? all[Math.min(currentIndex, all.length - 1)]);
    };

    const draw = () => {
      const hadFocus = el.contains(document.activeElement);
      const front = windows.front();
      const wins = listed();
      list.replaceChildren(...wins.map(win => {
        const notes = [win.dirty ? 'Not saved' : '', win.state === 'min' ? 'minimised' : ''].filter(Boolean).join(', ');
        return h('div', { class: `apps-row${win === front ? ' front' : ''}${win.dirty ? ' dirty' : ''}`, role: 'option', 'aria-selected': 'false', tabindex: -1, 'data-win': win.id },
          icon(win.iconName, 16),
          h('span', { class: 'apps-text' },
            h('span', { class: 'apps-title' }, win.title),
            notes ? h('span', { class: 'apps-note' }, notes) : null),
          h('span', { class: 'apps-x', 'aria-hidden': 'true', title: `Close ${win.title}` }, '×'));
      }));
      list.hidden = wins.length === 0;
      empty.hidden = wins.length > 0;
      closeAll.disabled = wins.length === 0;
      const all = rows();
      const at = all.find(r => r.dataset.win === currentId) ?? all[Math.min(currentIndex, all.length - 1)];
      if (at) at.tabIndex = 0;
      if (hadFocus && !el.contains(document.activeElement)) refocus();
    };

    const switchTo = (win: Win | undefined) => {
      if (!win) return;
      close(false);
      windows.focus(win);
    };
    const closeOne = async (win: Win | undefined) => {
      if (!win) return;
      await windows.close(win);
      if (panel?.abort === abort) refocus();
    };

    on(list, 'focusin', (event: FocusEvent) => {
      const row = event.target instanceof Element ? event.target.closest<HTMLElement>('[role="option"]') : null;
      if (!row) return;
      currentId = row.dataset.win ?? null;
      currentIndex = Math.max(0, rows().indexOf(row));
      if (row.getAttribute('aria-selected') !== 'true') focusRow(row);
    }, abort.signal);
    on(list, 'click', (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const row = target?.closest<HTMLElement>('[role="option"]') ?? null;
      if (!row) return;
      if (target?.closest('.apps-x')) void closeOne(winOf(row));
      else switchTo(winOf(row));
    }, abort.signal);
    on(list, 'keydown', (event: KeyboardEvent) => {
      const row = event.target instanceof Element ? event.target.closest<HTMLElement>('[role="option"]') : null;
      const all = rows();
      const i = row ? all.indexOf(row) : -1;
      let to: HTMLElement | undefined;
      if (event.key === 'ArrowDown') to = all[Math.min(i + 1, all.length - 1)];
      else if (event.key === 'ArrowUp') to = all[Math.max(i - 1, 0)];
      else if (event.key === 'Home') to = all[0];
      else if (event.key === 'End') to = all[all.length - 1];
      else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        switchTo(winOf(row));
        return;
      } else if (event.key === 'Delete') {
        event.preventDefault();
        if (!event.repeat) void closeOne(winOf(row));
        return;
      } else return;
      event.preventDefault();
      focusRow(to);
    }, abort.signal);

    // Each window in turn, through the same close; a window kept open stops the rest.
    on(closeAll, 'click', async () => {
      for (const win of listed()) {
        if (!(await windows.close(win))) break;
      }
      if (panel?.abort === abort) refocus();
    }, abort.signal);

    on(el, 'keydown', (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close(true);
      }
    }, abort.signal);
    // Tabbing out closes it, as clicking elsewhere does. Focus moved away by something else (a window closing and the
    // next one coming forward) is brought back, since the panel is still on show; a question about unsaved work keeps it.
    let tabbing = false;
    on(el, 'keydown', (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      // Focus moves as the key's own action, before this timer runs.
      tabbing = true;
      setTimeout(() => (tabbing = false));
    }, abort.signal, { capture: true });
    on(el, 'focusout', (event: FocusEvent) => {
      const to = event.relatedTarget;
      if (to instanceof Node && (el.contains(to) || button.contains(to))) return;
      if (tabbing) return close(false);
      if (to instanceof Element && to.closest('#layer-modal')) return;
      queueMicrotask(() => {
        if (panel?.abort !== abort || el.contains(document.activeElement)) return;
        if (document.activeElement instanceof Element && document.activeElement.closest('#layer-modal')) return;
        refocus();
      });
    }, abort.signal);
    on(document, 'pointerdown', (event: PointerEvent) => {
      const t = event.target;
      if (!(t instanceof Node) || el.contains(t) || button.contains(t)) return;
      // The Save / Close without saving / Keep it open question belongs to a close started here.
      if (t instanceof Element && t.closest('#layer-modal')) return;
      close(false);
    }, abort.signal, { capture: true });

    windows.changed.on(draw, abort.signal);
    host.append(el);
    button.setAttribute('aria-expanded', 'true');
    draw();
    refocus();
  }

  return button;
}
