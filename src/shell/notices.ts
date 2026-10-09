// The notification centre: a bell in the taskbar tray with a count of unread notices, and a panel listing them
// (newest first) with the time each came in. Notices are things worth finding again later, such as calendar reminders.
// Short "Saved" messages stay as passing toasts only. Notices live for this visit; reloading the page clears them.
import { css, h, on } from '../core/dom.ts';

export interface Notice {
  id: number;
  title: string;
  text: string;
  at: number;
  read: boolean;
  action?: { label: string; run: () => void };
}

const MAX_NOTICES = 50;

export class NoticeCentre {
  private list: Notice[] = [];
  private next = 1;
  private bell: HTMLButtonElement;
  private count: HTMLElement;
  private host: HTMLElement;
  private panel: { el: HTMLElement; abort: AbortController } | null = null;

  constructor(tray: HTMLElement, host: HTMLElement, signal: AbortSignal) {
    this.host = host;
    this.count = h('span', { class: 'bell-count', hidden: true });
    this.bell = h('button', { type: 'button', class: 'tray-btn bell', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', title: 'Notifications (Ctrl+Alt+N)' },
      h('span', { class: 'glyph-bell', 'aria-hidden': 'true' }), this.count);
    tray.prepend(this.bell);
    on(this.bell, 'click', () => this.toggle(), signal);
    this.paint();
  }

  add(title: string, text: string, action?: Notice['action']): void {
    this.list.unshift({ id: this.next++, title, text, at: Date.now(), read: false, action });
    this.list.length = Math.min(this.list.length, MAX_NOTICES);
    this.paint();
    if (this.panel) this.drawPanel();
  }

  private unread(): number {
    return this.list.filter(n => !n.read).length;
  }

  private paint(): void {
    const n = this.unread();
    this.count.hidden = n === 0;
    this.count.textContent = n > 9 ? '9+' : String(n);
    this.bell.setAttribute('aria-label', n ? `Notifications, ${n} unread` : 'Notifications');
  }

  toggle(): void {
    if (this.panel) return this.close();
    const abort = new AbortController();
    const el = h('div', { class: 'notices', role: 'dialog', 'aria-label': 'Notifications', tabindex: -1 });
    this.panel = { el, abort };
    this.host.append(el);
    css(el, { right: 4, bottom: 4 });
    this.bell.setAttribute('aria-expanded', 'true');
    this.drawPanel();
    on(document, 'pointerdown', (event: PointerEvent) => {
      if (event.target instanceof Node && !el.contains(event.target) && !this.bell.contains(event.target)) this.close(false);
    }, abort.signal, { capture: true });
    on(el, 'keydown', (event: KeyboardEvent) => {
      if (event.key === 'Escape') this.close();
    }, abort.signal);
    // Tabbing out closes it, as clicking elsewhere does (focus going to the bell is left to the bell's own click).
    on(el, 'focusout', (event: FocusEvent) => {
      const to = event.relatedTarget;
      if (to instanceof Node && !el.contains(to) && !this.bell.contains(to)) this.close(false);
    }, abort.signal);
    el.focus();
  }

  close(restore = true): void {
    if (!this.panel) return;
    this.panel.abort.abort();
    this.panel.el.remove();
    this.panel = null;
    this.bell.setAttribute('aria-expanded', 'false');
    // Everything that was on show has now been seen.
    for (const n of this.list) n.read = true;
    this.paint();
    if (restore) this.bell.focus();
  }

  private drawPanel(): void {
    if (!this.panel) return;
    const clear = h('button', { type: 'button', class: 'btn', disabled: this.list.length === 0 }, 'Clear all');
    clear.addEventListener('click', () => {
      this.list = [];
      this.paint();
      this.drawPanel();
    }, { signal: this.panel.abort.signal });
    const rows = this.list.map(n => {
      const row = h('div', { class: `notice${n.read ? '' : ' unread'}` },
        h('div', { class: 'notice-head' }, h('strong', {}, n.title), h('span', { class: 'notice-time' }, new Date(n.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }))),
        n.text ? h('div', { class: 'notice-text' }, n.text) : null,
      );
      if (n.action) {
        const b = h('button', { type: 'button', class: 'btn' }, n.action.label);
        const run = n.action.run;
        b.addEventListener('click', () => {
          this.close(false);
          run();
        }, { signal: this.panel!.abort.signal });
        row.append(b);
      }
      return row;
    });
    this.panel.el.replaceChildren(
      h('div', { class: 'notices-head' }, h('strong', {}, 'Notifications'), clear),
      rows.length ? h('div', { class: 'notices-list' }, ...rows) : h('p', { class: 'hint' }, 'Nothing new. Calendar reminders and other notices collect here.'),
    );
  }
}
