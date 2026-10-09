// Modal dialogs: a message, a question, a name to type, an error. Each one is a promise that settles when the
// person answers. Focus is kept inside the dialog while it is open and goes back to where it was afterwards.
import { h, on } from '../core/dom.ts';
import { FsError } from '../fs/errors.ts';
import { StoreConflict, StoreError } from '../store/store.ts';

export interface DialogButton<T> {
  label: string;
  value: T;
  primary?: boolean;
  danger?: boolean;
}

export interface AskOptions<T> {
  title: string;
  text?: string;
  body?: Node;
  buttons: DialogButton<T>[];
  /** What Escape and clicking outside answer. */
  cancel: T;
  /** Called on every keystroke or change to decide whether the primary button may be pressed. */
  primaryEnabled?: () => boolean;
  focus?: () => HTMLElement | null;
}

/** Turns anything thrown into words for the person: the fault and its reason, never a stack trace. */
export function describeError(error: unknown): string {
  if (error instanceof FsError || error instanceof StoreError || error instanceof StoreConflict) return error.message;
  console.error(error);
  return 'Something unexpected went wrong inside the desktop. Your files were not changed by it. Reload the page and try again.';
}

/** The server turned the request down because the screen is locked (423). The lock screen already says so, and after
 *  unlocking the message is out of date, so no error box is shown for it. */
export function isLockRefusal(error: unknown): boolean {
  return error instanceof Error && (error as { status?: unknown }).status === 423;
}

export class DialogLayer {
  private host: HTMLElement;
  private depth = 0;

  constructor(host: HTMLElement) {
    this.host = host;
  }

  get isOpen(): boolean {
    return this.depth > 0;
  }

  ask<T>(options: AskOptions<T>): Promise<T> {
    return new Promise(resolve => {
      const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const abort = new AbortController();
      const titleId = `dlg-${crypto.randomUUID()}`;
      const buttons = options.buttons.map(b =>
        h('button', { type: 'button', class: `btn${b.primary ? ' primary' : ''}${b.danger ? ' danger' : ''}` }, b.label),
      );
      const dialog = h(
        'div',
        { class: 'dialog', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: -1 },
        h('div', { class: 'dialog-title', id: titleId }, options.title),
        h('div', { class: 'dialog-body' }, options.text ? h('p', { class: 'dialog-text' }, options.text) : null, options.body ?? null),
        h('div', { class: 'dialog-buttons' }, ...buttons),
      );
      const backdrop = h('div', { class: 'backdrop' }, dialog);
      this.host.append(backdrop);
      this.depth++;
      const finish = (value: T) => {
        abort.abort();
        backdrop.remove();
        this.depth--;
        if (previous?.isConnected) previous.focus({ preventScroll: true });
        resolve(value);
      };
      const refresh = () => {
        if (!options.primaryEnabled) return;
        options.buttons.forEach((b, i) => {
          if (b.primary) buttons[i].disabled = !options.primaryEnabled!();
        });
      };
      options.buttons.forEach((b, i) => buttons[i].addEventListener('click', () => finish(b.value), { signal: abort.signal }));
      on(dialog, 'input', refresh, abort.signal);
      on(dialog, 'change', refresh, abort.signal);
      on(dialog, 'keydown', (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          finish(options.cancel);
        } else if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
          const primary = options.buttons.findIndex(b => b.primary);
          if (primary >= 0 && !buttons[primary].disabled) {
            event.preventDefault();
            finish(options.buttons[primary].value);
          }
        } else if (event.key === 'Tab') {
          const focusable = [...dialog.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex="0"]')].filter(e => !(e as HTMLButtonElement).disabled);
          if (!focusable.length) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }
      }, abort.signal);
      // A click outside the dialog is a cancel, but only for dialogs that can be cancelled safely.
      on(backdrop, 'pointerdown', (event: PointerEvent) => {
        if (event.target === backdrop && options.buttons.some(b => b.value === options.cancel)) finish(options.cancel);
      }, abort.signal);
      refresh();
      const target = options.focus?.() ?? buttons[options.buttons.findIndex(b => b.primary && !b.danger)] ?? buttons[buttons.length - 1];
      (target ?? dialog).focus();
      if (!options.focus && target instanceof HTMLInputElement) target.select();
    });
  }

  async alert(title: string, text: string, detail?: string): Promise<void> {
    await this.ask<true>({
      title,
      text,
      body: detail ? h('p', { class: 'dialog-detail' }, detail) : undefined,
      buttons: [{ label: 'OK', value: true, primary: true }],
      cancel: true,
    });
  }

  /** A failure: what went wrong and why (the message), with a way out (Retry when there is one). */
  async error(title: string, error: unknown, retry?: boolean): Promise<boolean> {
    if (isLockRefusal(error)) return false;
    return this.ask<boolean>({
      title,
      text: describeError(error),
      buttons: retry
        ? [{ label: 'Try again', value: true, primary: true }, { label: 'Close', value: false }]
        : [{ label: 'OK', value: false, primary: true }],
      cancel: false,
    });
  }

  async confirm(options: { title: string; text: string; ok: string; danger?: boolean; cancel?: string }): Promise<boolean> {
    return this.ask<boolean>({
      title: options.title,
      text: options.text,
      buttons: [
        { label: options.ok, value: true, primary: !options.danger, danger: options.danger },
        { label: options.cancel ?? 'Cancel', value: false, primary: options.danger },
      ],
      cancel: false,
    });
  }

  /** A single line of text. `check` returns the reason a value is not allowed, or null. */
  async prompt(options: { title: string; label: string; value?: string; ok?: string; check?: (value: string) => string | null; selectStem?: boolean }): Promise<string | null> {
    const input = h('input', { type: 'text', class: 'field', value: options.value ?? '', autocomplete: 'off', spellcheck: false, 'aria-label': options.label });
    const problem = h('p', { class: 'dialog-problem', role: 'alert' });
    const valid = () => {
      const reason = options.check ? options.check(input.value) : null;
      problem.textContent = reason ?? '';
      return reason === null;
    };
    const answer = await this.ask<string | null>({
      title: options.title,
      body: h('div', {}, h('label', { class: 'dialog-label' }, options.label, input), problem),
      buttons: [
        { label: options.ok ?? 'OK', value: '\0ok', primary: true },
        { label: 'Cancel', value: null },
      ],
      cancel: null,
      primaryEnabled: valid,
      focus: () => {
        if (options.selectStem) {
          const dot = input.value.lastIndexOf('.');
          input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
        }
        return input;
      },
    });
    return answer === null ? null : input.value;
  }
}
