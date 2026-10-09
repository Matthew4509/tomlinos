// The RISC-V Studio's own menu bar and dialog boxes, drawn to match the desktop (Xfce-style menus and dialogs).
// Keyboard first: F10 or Alt opens the
// bar, Alt+letter opens a menu, the arrows move, Enter chooses, Escape goes back to the code.
import { h, on } from '../../core/dom.ts';

export interface DosItem {
  label?: string;
  /** The letter underlined and used to pick the item from the keyboard. */
  key?: string;
  hint?: string;
  action?: () => void;
  disabled?: () => boolean;
  checked?: () => boolean;
  separator?: boolean;
}
export interface DosMenu {
  label: string;
  key: string;
  items: DosItem[] | (() => DosItem[]);
}

/** A label as plain text. The hot letter still works from the keyboard (Alt+letter) but is not shown highlighted:
    the Studio follows the desktop's menus, which have none. */
function withKey(label: string, _key: string | undefined): Node[] {
  return [document.createTextNode(label)];
}

export class DosMenuBar {
  readonly el: HTMLElement;
  private menus: DosMenu[];
  private titles: HTMLButtonElement[];
  private drop: HTMLElement | null = null;
  private openIndex = -1;
  private host: HTMLElement;
  private back: () => void;
  private dropAbort: AbortController | null = null;

  /** `back` puts the focus where it belongs when the bar is left (the code, usually). */
  constructor(host: HTMLElement, menus: DosMenu[], back: () => void, signal: AbortSignal) {
    this.host = host;
    this.menus = menus;
    this.back = back;
    this.titles = menus.map((m, i) => {
      const b = h('button', { type: 'button', class: 'dos-title', role: 'menuitem', 'aria-haspopup': 'menu', 'aria-expanded': 'false', tabindex: -1 }, ...withKey(m.label, m.key));
      on(b, 'pointerdown', (event: PointerEvent) => {
        event.preventDefault();
        if (this.openIndex === i) this.close();
        else this.open(i, false);
      }, signal);
      on(b, 'pointerenter', () => {
        if (this.drop && this.openIndex !== i) this.open(i, false);
      }, signal);
      on(b, 'keydown', (event: KeyboardEvent) => this.titleKey(event, i), signal);
      return b;
    });
    this.el = h('div', { class: 'dos-menubar', role: 'menubar', 'aria-label': 'Studio menu' }, ...this.titles);
    signal.addEventListener('abort', () => this.close(false), { once: true });
  }

  get isOpen(): boolean {
    return this.drop !== null;
  }

  /** Puts the keyboard on the bar with the first (or given) title lit, as F10 did. */
  focusBar(index = 0): void {
    this.close(false);
    this.titles[index].tabIndex = 0;
    this.titles[index].focus();
  }

  openByKey(letter: string): boolean {
    const i = this.menus.findIndex(m => m.key.toLowerCase() === letter.toLowerCase());
    if (i < 0) return false;
    this.open(i, true);
    return true;
  }

  close(returnFocus = true): void {
    this.dropAbort?.abort();
    this.dropAbort = null;
    this.drop?.remove();
    this.drop = null;
    for (const t of this.titles) {
      t.setAttribute('aria-expanded', 'false');
      t.classList.remove('on');
      t.tabIndex = -1;
    }
    this.openIndex = -1;
    if (returnFocus) this.back();
  }

  private titleKey(event: KeyboardEvent, i: number): void {
    const n = this.titles.length;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      this.focusBar((i + (event.key === 'ArrowRight' ? 1 : n - 1)) % n);
    } else if (event.key === 'Enter' || event.key === 'ArrowDown' || event.key === ' ') {
      event.preventDefault();
      this.open(i, true);
    } else if (event.key === 'Escape' || event.key === 'F10') {
      event.preventDefault();
      this.close();
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
      if (this.openByKey(event.key)) event.preventDefault();
    }
  }

  private open(i: number, fromKeyboard: boolean): void {
    this.close(false);
    const menu = this.menus[i];
    const items = typeof menu.items === 'function' ? menu.items() : menu.items;
    const abort = new AbortController();
    this.dropAbort = abort;
    const buttons: HTMLButtonElement[] = [];
    const rows = items.map(item => {
      if (item.separator) return h('div', { class: 'dos-sep', role: 'separator' });
      const disabled = item.disabled?.() ?? false;
      const checked = item.checked?.();
      const b = h(
        'button',
        { type: 'button', class: 'dos-item', role: checked === undefined ? 'menuitem' : 'menuitemcheckbox', 'aria-checked': checked === undefined ? null : String(checked), disabled, 'data-key': (item.key ?? '').toLowerCase() },
        h('span', { class: 'dos-check', 'aria-hidden': 'true' }, checked ? '•' : ''),
        h('span', { class: 'dos-label' }, ...withKey(item.label ?? '', item.key)),
        h('span', { class: 'dos-hint' }, item.hint ?? ''),
      );
      on(b, 'click', () => {
        this.close();
        item.action?.();
      }, abort.signal);
      on(b, 'pointerenter', () => b.focus({ preventScroll: true }), abort.signal);
      if (!disabled) buttons.push(b);
      return b;
    });
    const drop = h('div', { class: 'dos-drop', role: 'menu', 'aria-label': menu.label }, ...rows);
    const title = this.titles[i];
    this.host.append(drop);
    const hostBox = this.host.getBoundingClientRect();
    const box = title.getBoundingClientRect();
    drop.style.setProperty('left', `${Math.max(0, Math.min(box.left - hostBox.left, hostBox.width - drop.offsetWidth))}px`);
    drop.style.setProperty('top', `${box.bottom - hostBox.top}px`);
    this.drop = drop;
    this.openIndex = i;
    title.classList.add('on');
    title.setAttribute('aria-expanded', 'true');

    on(drop, 'keydown', (event: KeyboardEvent) => {
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const n = this.titles.length;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (buttons.length) buttons[(at + (event.key === 'ArrowDown' ? 1 : buttons.length - 1) + buttons.length) % buttons.length].focus();
      } else if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault();
        this.open((i + (event.key === 'ArrowRight' ? 1 : n - 1)) % n, true);
      } else if (event.key === 'Escape' || event.key === 'F10') {
        event.preventDefault();
        this.close();
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        buttons[event.key === 'Home' ? 0 : buttons.length - 1]?.focus();
      } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const hit = buttons.find(b => b.dataset.key === event.key.toLowerCase());
        if (hit) {
          event.preventDefault();
          hit.click();
        }
      }
    }, abort.signal);
    on(document, 'pointerdown', (event: PointerEvent) => {
      if (event.target instanceof Node && !drop.contains(event.target) && !this.el.contains(event.target)) this.close(false);
    }, abort.signal, { capture: true });
    if (fromKeyboard || buttons.length) (buttons[0] ?? drop).focus({ preventScroll: true });
  }
}

export interface DosButton<T> {
  label: string;
  value: T;
  /** Chosen by Enter when focus is not on another button. */
  primary?: boolean;
}

/**
 * A DOS-style box over the Studio window (not the whole desktop), so the rest of the desktop stays usable. Resolves with
 * the chosen button's value, or null for Escape. `ready` runs once it is on screen (to focus a field, say).
 */
export function dosBox<T>(host: HTMLElement, options: { title: string; body: Node[]; buttons: DosButton<T>[]; wide?: boolean; ready?: (close: (value: T | null) => void) => void }): Promise<T | null> {
  return new Promise(resolve => {
    const abort = new AbortController();
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const buttons = options.buttons.map(b => {
      const el = h('button', { type: 'button', class: `dos-btn${b.primary ? ' primary' : ''}` }, b.label);
      on(el, 'click', () => close(b.value), abort.signal);
      return el;
    });
    const box = h(
      'div',
      { class: `dos-box${options.wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': options.title },
      h('div', { class: 'dos-box-title' }, h('span', {}, ` ${options.title} `)),
      h('div', { class: 'dos-box-body' }, ...options.body),
      h('div', { class: 'dos-box-buttons' }, ...buttons),
    );
    const veil = h('div', { class: 'dos-veil' }, box);
    host.append(veil);

    function close(value: T | null): void {
      abort.abort();
      veil.remove();
      if (before?.isConnected) before.focus({ preventScroll: true });
      resolve(value);
    }

    on(veil, 'keydown', (event: KeyboardEvent) => {
      event.stopPropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        close(null);
      } else if (event.key === 'Enter' && !(document.activeElement instanceof HTMLButtonElement) && !(document.activeElement instanceof HTMLTextAreaElement) && !(document.activeElement instanceof HTMLSelectElement)) {
        const primary = options.buttons.findIndex(b => b.primary);
        if (primary >= 0) {
          event.preventDefault();
          buttons[primary].click();
        }
      } else if (event.key === 'Tab') {
        const focusable = [...box.querySelectorAll<HTMLElement>('input, select, textarea, button, [tabindex="0"]')].filter(el => !(el as HTMLButtonElement).disabled);
        const at = focusable.indexOf(document.activeElement as HTMLElement);
        const next = event.shiftKey ? (at <= 0 ? focusable.length - 1 : at - 1) : (at + 1) % focusable.length;
        event.preventDefault();
        focusable[next]?.focus();
      }
    }, abort.signal);
    // Keys typed in the box never reach the code or the running program behind it.
    on(veil, 'keyup', (event: KeyboardEvent) => event.stopPropagation(), abort.signal);
    if (options.ready) options.ready(close);
    else (buttons.find((_, i) => options.buttons[i].primary) ?? buttons[0])?.focus();
  });
}

/** A one-line message with an OK button (assembler errors, faults, notes). */
export function dosAlert(host: HTMLElement, title: string, lines: string[]): Promise<void> {
  return dosBox(host, { title, body: lines.map(l => h('p', {}, l)), buttons: [{ label: 'OK', value: true, primary: true }] }).then(() => undefined);
}

/** Asks for one line of text. Returns null for Cancel. `check` returns a problem to show, or null. */
export function dosPrompt(host: HTMLElement, options: { title: string; label: string; value?: string; ok?: string; check?: (value: string) => string | null }): Promise<string | null> {
  const input = h('input', { type: 'text', class: 'dos-field', spellcheck: 'false', autocomplete: 'off', value: options.value ?? '' });
  const problem = h('p', { class: 'dos-problem', role: 'alert' });
  let result: string | null = null;
  return dosBox<'ok'>(host, {
    title: options.title,
    body: [h('label', { class: 'dos-row' }, h('span', {}, options.label), input), problem],
    buttons: [
      { label: options.ok ?? 'OK', value: 'ok', primary: true },
      { label: 'Cancel', value: null as unknown as 'ok' },
    ],
    ready: () => {
      input.focus();
      input.select();
      // Enter in the field presses OK (the box does that); OK checks the value first and stays open on a problem.
      const okButton = input.closest('.dos-box')?.querySelector<HTMLButtonElement>('.dos-btn.primary');
      okButton?.addEventListener('click', event => {
        const issue = options.check?.(input.value) ?? null;
        problem.textContent = issue ?? '';
        if (issue) {
          event.stopImmediatePropagation();
          input.focus();
        } else result = input.value;
      }, { capture: true });
    },
  }).then(v => (v === 'ok' ? result : null));
}
