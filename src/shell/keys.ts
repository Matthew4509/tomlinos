// Shortcuts that work anywhere on the desktop, and the window switcher. Browsers and the computer keep some keys for
// themselves (Alt+Tab, the Windows key, Ctrl+W, Alt+F4 in most), so the desktop uses ones a web page is given.
import { printFront } from '../apps/printer/entry.ts';
import { HIDDEN_APPS } from '../release.ts';
import { h, on } from '../core/dom.ts';
import { icon } from './icons.ts';
import type { Shell } from './types.ts';
import type { Win } from './windows.ts';

/** The list shown in the Keyboard shortcuts window. Kept here, beside the code that does them. */
export const SHORTCUTS: Array<[string, Array<[string, string]>]> = [
  ['Windows', [
    ['Alt+` (the key above Tab)', 'Switch windows: keep Alt held and press ` again to move on; let go to switch. Shift goes back.'],
    ['Ctrl+Alt+←  /  Ctrl+Alt+→', 'Snap the front window to the left or right half'],
    ['Ctrl+Alt+↑', 'Fill the screen with the front window'],
    ['Ctrl+Alt+↓', 'Put a snapped or full-screen window back as it was'],
    ['Drag a title bar to a side or the top', 'Snap to that half, or fill the screen'],
    ['Alt+Q', 'Close the front window'],
    ['Ctrl+Alt+D', 'Show the desktop (again to bring the windows back)'],
  ]],
  ['Desktop', [
    ['Ctrl+Alt+E', 'Open File Explorer'],
    ['Ctrl+Alt+T', 'Open a Terminal (as on Debian and Ubuntu)'],
    ['Ctrl+Alt+F', 'Search your files'],
    ['Ctrl+Alt+N', 'Open the notifications'],
    // Ctrl+P is the Office Printer's; the browser keeps it while that app is hidden (src/release.ts).
    ...(HIDDEN_APPS.includes('printer') ? [] : [['Ctrl+P', 'Print'] as [string, string]]),
    ['Alt+L', 'Lock the screen'],
    ['Escape twice, quickly', 'Panic: cover the screen and lock (when turned on in My account)'],
  ]],
  ['Files (Explorer and desktop)', [
    ['Ctrl+C  /  Ctrl+X  /  Ctrl+V', 'Copy, cut, paste'],
    ['Delete', 'Move to the Recycle Bin'],
    ['F2', 'Rename'],
    ['Enter  /  Alt+Enter', 'Open  /  Properties'],
    ['Ctrl+A', 'Select everything'],
    ['Ctrl+F', 'Search this folder and the folders inside it'],
    ['Ctrl+L', 'Type a folder path'],
    ['Alt+←  /  Alt+→  /  Alt+↑  /  Backspace', 'Back, forward, up one folder'],
    ['F5', 'Refresh'],
  ]],
];

export function bindDesktopKeys(shell: Shell, signal: AbortSignal, notices: () => void): void {
  let switcher: { el: HTMLElement; list: Win[]; at: number; abort: AbortController } | null = null;
  const announce = h('div', { class: 'sr-only', 'aria-live': 'assertive' });
  document.body.append(announce);
  signal.addEventListener('abort', () => announce.remove(), { once: true });

  const drawSwitcher = () => {
    if (!switcher) return;
    const s = switcher;
    s.el.replaceChildren(
      ...s.list.map((w, i) => h('div', { class: `switch-item${i === s.at ? ' on' : ''}`, 'aria-selected': String(i === s.at), role: 'option' }, icon(w.iconName, 32), h('span', {}, w.title))),
    );
    // Read out by screen readers each time the choice moves (the list itself never has focus).
    announce.textContent = `${s.list[s.at]?.title ?? ''}, ${s.at + 1} of ${s.list.length}`;
  };
  const finishSwitch = (go: boolean) => {
    if (!switcher) return;
    const target = switcher.list[switcher.at];
    switcher.abort.abort();
    switcher.el.remove();
    switcher = null;
    announce.textContent = '';
    if (go && target) shell.windows.focus(target);
  };

  on(document, 'keydown', (event: KeyboardEvent) => {
    if (shell.lock.isShowing) return;
    if (event.altKey && !event.ctrlKey && event.code === 'Backquote') {
      event.preventDefault();
      const list = shell.windows.stack().filter(w => !w.fixed).reverse();
      if (!list.length) return;
      if (!switcher) {
        const abort = new AbortController();
        const el = h('div', { class: 'switcher', role: 'listbox', 'aria-label': 'Open windows' });
        document.body.append(el);
        switcher = { el, list, at: 0, abort };
        on(document, 'keyup', (e: KeyboardEvent) => {
          if (e.key === 'Alt') finishSwitch(true);
        }, abort.signal);
        on(window, 'blur', () => finishSwitch(false), abort.signal);
      }
      const n = switcher.list.length;
      switcher.at = (switcher.at + (event.shiftKey ? -1 : 1) + n) % n;
      drawSwitcher();
      return;
    }
    if (switcher && event.key === 'Escape') {
      event.preventDefault();
      finishSwitch(false);
      return;
    }
    // Ctrl+P (Cmd+P on a Mac) would print this page of the browser. The office printers answer instead.
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'p' && shell.hasApp('printer')) {
      event.preventDefault();
      void printFront(shell);
      return;
    }
    if (!(event.ctrlKey && event.altKey) || event.shiftKey || event.metaKey) return;
    // AltGr arrives as Ctrl+Alt on Windows: on many keyboards it types €, @, { and more. Never take those.
    if (event.getModifierState('AltGraph') && event.key.length === 1) return;
    const front = shell.windows.front();
    const snaps: Record<string, 'left' | 'right' | 'max' | 'restore'> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'max', ArrowDown: 'restore' };
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (snaps[key]) {
      if (!front) return;
      event.preventDefault();
      shell.windows.snap(front, snaps[key]);
    } else if (key === 'd') {
      event.preventDefault();
      shell.windows.showDesktop();
    } else if (key === 'e') {
      event.preventDefault();
      void shell.openApp('explorer', '/');
    } else if (key === 'f') {
      event.preventDefault();
      void shell.openApp('explorer', '/').then(() => {
        const box = shell.windows.front()?.body.querySelector<HTMLInputElement>('input.search');
        box?.focus();
      });
    } else if (key === 't') {
      event.preventDefault();
      void shell.openApp('terminal');
    } else if (key === 'n') {
      event.preventDefault();
      notices();
    }
  }, signal);
}
