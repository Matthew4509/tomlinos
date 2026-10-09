// The screensaver and the screen lock. After the idle time the person chose (or at once with Lock now, Alt+L, the
// taskbar's padlock, or Escape twice), a screensaver covers everything: blank, a clock, or a spreadsheet that looks like ordinary work. With the lock
// on, the SERVER is told first, so a reload or a second tab finds it locked too and the files stay shut until the PIN
// or password is given. The real windows are hidden (not just covered) and made unreachable while it shows.
//
// On the spreadsheet screensaver, typing the PIN and pressing Enter unlocks it without showing a lock screen at all;
// Escape, or the spreadsheet's own close button, brings up the ordinary lock screen (a cover with no visible way out
// looked like a crash).
//
// Disguise, so people passing by do not see TOMLIN OS: the lock screen has three looks, default (TOMLIN OS and
// the person's name), plain ("Session timed out", nothing else) and custom (the person's own words); the spreadsheet
// shows the kind of work and title they chose; and the reader screensaver is a book open at a page, whose only way back
// is "Log in for more" in its corner (a user name and password, like any reading site). Preview shows all of it with
// nothing locked, for the setup guide.
import { css, h, on } from '../core/dom.ts';
import { localStatus } from '../core/local.ts';
import { icon } from '../shell/icons.ts';
import { SHEET_KINDS, type LockSettings, type LockWords } from '../shell/session.ts';
import type { Shell } from '../shell/types.ts';
import { AuthFailure, type AuthApi, type PublicUser } from './api.ts';
import { passwordField } from './gate.ts';

type Phase = 'open' | 'saver' | 'prompt';

/** The Reader (a book, a page at a time), shown in a frame by the reader screensaver. */
export const READER_PATH = 'reader/index.html';
/** The reader's sign-in, when the look is not custom: what reading sites say. */
const READER_WORDS: LockWords = { title: 'Log in', user: 'Username', pass: 'Password', button: 'Log in' };

export interface LockOptions {
  root: HTMLElement;
  shell: Shell;
  /** null when files are kept in this browser: then there are no accounts and the screensaver cannot lock. */
  api: AuthApi | null;
  user: () => PublicUser | null;
  settings: () => LockSettings;
  /** Called when the server says this session has ended (5 wrong tries, signed out elsewhere). */
  signedOut: (message: string) => void;
}

export class LockScreen {
  private o: LockOptions;
  private layer: HTMLElement;
  private phase: Phase = 'open';
  private serverLocked = false;
  private lastActive = Date.now();
  private escAt = 0;
  private view: AbortController | null = null;
  private title = '';
  /** A preview from the setup guide: nothing is locked, and every way back only ends the preview. */
  private previewing = false;

  constructor(options: LockOptions) {
    this.o = options;
    this.layer = h('div', { id: 'layer-lock' });
    this.layer.hidden = true;
    options.root.append(this.layer);
  }

  get isShowing(): boolean {
    return this.phase !== 'open';
  }

  /** Can this desktop lock (a server with accounts), rather than only show a screensaver? */
  get canLock(): boolean {
    return this.o.api !== null && this.o.user() !== null;
  }

  start(signal: AbortSignal): void {
    const active = () => {
      if (this.phase === 'open') this.lastActive = Date.now();
    };
    for (const type of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart']) on(window, type, active, signal, { capture: true, passive: true });
    const timer = window.setInterval(() => {
      const { idle } = this.o.settings();
      if (this.phase === 'open' && idle > 0 && Date.now() - this.lastActive >= idle * 60000) void this.show(false);
    }, 5000);
    signal.addEventListener('abort', () => clearInterval(timer), { once: true });

    on(window, 'keydown', (event: KeyboardEvent) => {
      if (this.phase !== 'open') return;
      if (event.altKey && !event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'l') {
        event.preventDefault();
        // Alt+Shift+L signs out at once (the front page, the book, shows); Alt+L locks.
        if (event.shiftKey && this.o.shell.account) void this.o.shell.account.signOut();
        else void this.show(true);
        return;
      }
    }, signal, { capture: true });
    // The panic key: Escape twice within half a second. Only an Escape nothing else used counts (closing a menu, a
    // dialog or a rename uses it up), so tidying up with Escape does not lock the screen by surprise.
    on(window, 'keydown', (event: KeyboardEvent) => {
      if (this.phase !== 'open' || event.key !== 'Escape' || event.repeat || event.defaultPrevented || !this.o.settings().panic) return;
      if (this.o.shell.menus.isOpen || this.o.shell.dialogs.isOpen) return;
      const now = performance.now();
      if (now - this.escAt < 500) {
        this.escAt = 0;
        void this.show(true, 'sheet');
      } else this.escAt = now;
    }, signal);

    // Another tab (or device) may have locked or ended this session: check whenever this tab comes back.
    on(document, 'visibilitychange', () => {
      if (document.hidden || !this.o.api || this.phase !== 'open') return;
      this.o.api.status().then(status => {
        if (!status.signedIn) this.o.signedOut('You were signed out in another tab or on another device.');
        else if (status.locked) void this.show(true);
      }).catch(() => undefined);
    }, signal);
  }

  /**
   * Shows the screensaver. `lock` forces the lock on (Lock now, the panic key); otherwise the person's setting decides.
   * `saver` overrides the chosen screensaver (the panic key always shows the spreadsheet).
   */
  async show(lock: boolean, saver?: LockSettings['saver']): Promise<void> {
    if (this.phase !== 'open') return;
    const settings = this.o.settings();
    const locking = (lock || settings.lock) && this.canLock;
    this.phase = 'saver';
    this.serverLocked = false;
    this.hideDesktop(true);
    this.o.shell.lockChanged.emit(true);
    this.drawSaver(saver ?? settings.saver, locking);
    if (locking) {
      // A setting changed just before (the screensaver itself, often) is written first: once locked, the server refuses it.
      await this.o.shell.session.flushWaiting().catch(() => undefined);
      try {
        await this.o.api!.lock();
        this.serverLocked = true;
      } catch (error) {
        if (error instanceof AuthFailure && error.signedOut) {
          this.reset();
          this.o.signedOut(error.message);
        }
        // Server unreachable: the screen still covers everything, and the next file request asks the server anyway.
        this.serverLocked = true;
      }
    }
  }

  /**
   * The setup guide's Preview: the chosen screensaver, then (as the way out is used) the chosen lock screen, exactly as
   * they will look. Nothing is locked: the server is not told, and unlocking, from any of them, only ends the preview.
   */
  preview(): void {
    if (this.phase !== 'open') return;
    this.previewing = true;
    this.phase = 'saver';
    this.hideDesktop(true);
    this.o.shell.lockChanged.emit(true);
    this.drawSaver(this.o.settings().saver, true);
  }

  get isPreview(): boolean {
    return this.previewing;
  }

  /** The server said the session is locked (a request got 423): show the lock screen at once. */
  lockedByServer(): void {
    if (this.phase === 'prompt') return;
    if (this.phase === 'open') {
      this.phase = 'saver';
      this.hideDesktop(true);
      this.o.shell.lockChanged.emit(true);
    }
    this.serverLocked = true;
    this.drawPrompt('');
  }

  /** Hides the desktop for the sign-in screen, without a screensaver. reset() shows it again. */
  cover(): void {
    this.view?.abort();
    this.view = null;
    this.layer.replaceChildren();
    this.layer.hidden = true;
    if (this.phase === 'open') {
      this.hideDesktop(true);
      this.o.shell.lockChanged.emit(true);
    }
    this.phase = 'saver';
  }

  /** Takes the screensaver and lock away without unlocking anything (used when the session ends). */
  reset(): void {
    this.view?.abort();
    this.view = null;
    this.layer.replaceChildren();
    this.layer.hidden = true;
    if (this.phase !== 'open') {
      this.hideDesktop(false);
      this.o.shell.lockChanged.emit(false);
    }
    this.phase = 'open';
    this.serverLocked = false;
    this.previewing = false;
    this.lastActive = Date.now();
  }

  private hideDesktop(hidden: boolean): void {
    for (const el of [...this.o.root.children]) {
      if (el === this.layer || !(el instanceof HTMLElement || el instanceof SVGElement)) continue;
      el.toggleAttribute('inert', hidden);
      el.classList.toggle('lock-hidden', hidden);
    }
    if (hidden) {
      this.title = document.title;
      this.o.shell.menus.close(false);
      (document.activeElement as HTMLElement | null)?.blur?.();
    } else document.title = this.title || 'TOMLIN OS';
  }

  private newView(): AbortSignal {
    this.view?.abort();
    this.view = new AbortController();
    this.layer.replaceChildren();
    this.layer.hidden = false;
    if (this.previewing) {
      // In a preview there is always a plain way back, whatever is showing.
      const done = h('button', { type: 'button', class: 'btn primary' }, 'Close preview');
      on(done, 'click', () => this.reset(), this.view.signal);
      this.layer.append(h('div', { class: 'lock-preview-bar', role: 'status' }, 'Preview: nothing is locked. ', done));
    }
    return this.view.signal;
  }

  /** The words of the chosen look: the person's own for custom; otherwise `plain` (for the reader, a site's). */
  private lockWords(plain: LockWords): LockWords {
    const s = this.o.settings();
    return s.look === 'custom' ? s.words : plain;
  }

  private drawSaver(kind: LockSettings['saver'], locking: boolean): void {
    const signal = this.newView();
    const wake = () => {
      if (this.phase !== 'saver') return;
      if (locking) this.drawPrompt('');
      else this.reset();
    };

    if (kind === 'reader') {
      void this.drawReader(signal, locking);
      return;
    }

    if (kind === 'sheet') {
      const { kind: work, title } = this.o.settings().sheet;
      document.title = `${title || SHEET_KINDS.find(k => k.id === work)?.title || 'Workbook'} - Spreadsheet`;
      // The fake spreadsheet's code is most of the spreadsheet app, so it loads when first shown, not with the page
      // (it would slow every start). The key and pointer guards below are set up before it arrives, so nothing typed in the
      // meantime can reach the desktop underneath.
      let mode: HTMLElement | null = null;
      void import('./fakesheet.ts').then(({ createFakeSheet }) => {
        if (signal.aborted) return;
        const sheet = createFakeSheet(this.o.shell, signal, work, title);
        this.layer.append(h('div', { class: 'saver saver-sheet' }, sheet.el));
        sheet.grid.redraw();
        sheet.grid.focus();
        const drift = window.setInterval(() => sheet.drift(), 20000 + Math.random() * 20000);
        signal.addEventListener('abort', () => clearInterval(drift), { once: true });
        mode = sheet.el.querySelector<HTMLElement>('.fake-mode');
        on(sheet.close, 'click', () => (locking ? this.drawPrompt('') : this.reset()), signal);
      }, () => (locking ? this.drawPrompt('') : this.reset()));
      let typed = '';
      // Arrow keys and clicks move around the sheet like the real thing. Digits are kept (never shown); Enter tries them as
      // the PIN; Escape brings up the ordinary lock screen. Nothing typed ever changes a cell.
      on(this.layer, 'keydown', (event: KeyboardEvent) => {
        if (this.phase !== 'saver') return;
        const k = event.key;
        if (k.startsWith('Arrow') || k === 'Tab' || k === 'PageUp' || k === 'PageDown' || k === 'Home' || k === 'End') return;
        event.preventDefault();
        event.stopPropagation();
        if (!locking) {
          this.reset();
          return;
        }
        if (k === 'Escape') this.drawPrompt('');
        else if (/^[0-9]$/.test(k)) {
          typed = (typed + k).slice(-8);
          if (mode) mode.textContent = 'Enter';
        } else if (k === 'Backspace') typed = typed.slice(0, -1);
        else if (k === 'Enter') {
          const pin = typed;
          typed = '';
          if (mode) mode.textContent = 'Ready';
          if (pin.length === 4 && this.o.user()?.pin) void this.tryPin(pin);
          else this.drawPrompt('');
        }
      }, signal, { capture: true });
      on(this.layer, 'dblclick', (event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
      }, signal, { capture: true });
      if (!locking) on(this.layer, 'pointerdown', () => this.reset(), signal);
      return;
    }

    document.title = this.o.settings().look !== 'default' ? this.lockWords({ ...READER_WORDS, title: 'Sign in' }).title : locking ? 'TOMLIN OS - Locked' : 'TOMLIN OS';
    const face = h('div', { class: `saver saver-${kind}` });
    this.layer.append(face);
    if (kind === 'clock') {
      const time = h('div', { class: 'saver-time' });
      const date = h('div', { class: 'saver-date' });
      const box = h('div', { class: 'clock-box' }, time, date);
      face.append(box);
      const tick = () => {
        const now = new Date();
        time.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        date.textContent = now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
        // Moves a little each minute, so nothing is burnt into an old screen.
        css(box, { transform: `translate(${Math.round((Math.random() - 0.5) * 40)}vw, ${Math.round((Math.random() - 0.5) * 40)}vh)` });
      };
      tick();
      const timer = window.setInterval(tick, 60000);
      signal.addEventListener('abort', () => clearInterval(timer), { once: true });
    }
    let movedFrom: { x: number; y: number } | null = null;
    on(face, 'pointermove', (event: PointerEvent) => {
      movedFrom ??= { x: event.clientX, y: event.clientY };
      if (Math.abs(event.clientX - movedFrom.x) + Math.abs(event.clientY - movedFrom.y) > 30) wake();
    }, signal);
    on(face, 'pointerdown', wake, signal);
    on(window, 'keydown', (event: KeyboardEvent) => {
      event.preventDefault();
      wake();
    }, signal, { capture: true });
  }

  /**
   * The reader disguise: a book open at a page (the Reader in a frame) and, in its corner, "Log in for more", like any
   * reading site. That link is the only way back (Escape does nothing here), and it asks for the user name and the
   * password. Someone passing sees a person reading. A copy without the Reader shows the spreadsheet instead.
   */
  private async drawReader(signal: AbortSignal, locking: boolean): Promise<void> {
    const status = await localStatus(READER_PATH);
    if (signal.aborted) return;
    if (status !== 200) {
      this.drawSaver('sheet', locking);
      return;
    }
    document.title = 'Reader';
    const frame = h('iframe', { class: 'saver-reader-frame', src: READER_PATH, title: 'Reader' });
    const login = h('button', { type: 'button', class: 'reader-login-link' }, 'Log in for more');
    this.layer.append(h('div', { class: 'saver saver-reader' }, frame, login));
    on(login, 'click', () => (locking ? this.drawReaderLogin('') : this.reset()), signal);
    // The book, framed, may ask its page to close it: here nothing closes it but the log in.
    on(window, 'message', (event: MessageEvent) => {
      if (event.source === frame.contentWindow) event.stopImmediatePropagation();
    }, signal, { capture: true });
  }

  /** The reader's log in, over the book: a user name and a password (and the code, with two-step on). */
  private drawReaderLogin(message: string): void {
    if (!this.view) return;
    this.phase = 'prompt';
    this.layer.querySelector('.reader-login')?.remove();
    const signal = this.view.signal;
    const words = this.lockWords(READER_WORDS);
    const user = this.o.user();
    const name = h('input', { type: 'text', class: 'field', autocomplete: 'username', spellcheck: false });
    const pass = h('input', { type: 'password', class: 'field', autocomplete: 'current-password' });
    const code = user?.totp ? h('input', { type: 'text', class: 'field', autocomplete: 'one-time-code', inputmode: 'numeric', maxlength: 6 }) : null;
    const problem = h('p', { class: 'reader-login-problem', role: 'alert' }, message);
    const go = h('button', { type: 'submit', class: 'btn primary' }, words.button);
    const cancel = h('button', { type: 'button', class: 'btn' }, 'Cancel');
    const form = h('form', { class: 'reader-login', novalidate: true, role: 'dialog', 'aria-modal': 'true', 'aria-label': words.title },
      h('h2', {}, words.title),
      h('label', { class: 'reader-login-row' }, h('span', {}, words.user), name),
      h('label', { class: 'reader-login-row' }, h('span', {}, words.pass), pass),
      code ? h('label', { class: 'reader-login-row' }, h('span', {}, 'Code'), code) : null,
      problem,
      h('div', { class: 'reader-login-buttons' }, cancel, go));
    this.layer.append(form);
    on(cancel, 'click', () => {
      form.remove();
      this.phase = 'saver';
    }, signal);
    on(form, 'submit', (event: SubmitEvent) => {
      event.preventDefault();
      go.disabled = true;
      void this.tryReaderLogin(name.value, pass.value, code?.value.trim() ?? '').finally(() => (go.disabled = false));
    }, signal);
    name.focus();
  }

  /**
   * The session already knows who is signed in, so the user name is checked here: a wrong one gets the same answer as
   * a wrong password, after a pause, so the form never says which was wrong. The password goes to the server as ever
   * (its wrong tries are counted there).
   */
  private async tryReaderLogin(userName: string, password: string, code: string): Promise<void> {
    if (this.previewing) {
      this.reset();
      return;
    }
    const user = this.o.user();
    const wrong = (left?: unknown) => `That user name and password do not match.${typeof left === 'number' ? ` ${left} ${left === 1 ? 'try' : 'tries'} left.` : ''}`;
    if (!user || userName.trim().toLowerCase() !== user.name.toLowerCase()) {
      await new Promise(resolve => setTimeout(resolve, 900));
      this.drawReaderLogin(wrong());
      return;
    }
    try {
      await this.o.api!.unlockPassword(password, code);
      this.reset();
    } catch (error) {
      if (error instanceof AuthFailure && error.signedOut) {
        this.reset();
        this.o.signedOut(error.message);
        return;
      }
      this.drawReaderLogin(error instanceof AuthFailure && error.status === 403 ? wrong(error.data.triesLeft) : error instanceof Error ? error.message : String(error));
    }
  }

  /** The ordinary lock screen: who is signed in, the PIN (or the password, and the code if two-step is on). */
  private drawPrompt(message: string, usePassword = false): void {
    if (!this.serverLocked && !this.canLock && !this.previewing) {
      this.reset();
      return;
    }
    this.phase = 'prompt';
    const look = this.o.settings().look;
    // Plain and custom give nothing away: no TOMLIN OS, no name, and the tab keeps a neutral title.
    const words = look === 'custom' ? this.o.settings().words : null;
    document.title = look === 'default' ? 'TOMLIN OS - Locked' : words ? words.title : 'Sign in';
    const signal = this.newView();
    const user = this.o.user();
    const withPin = !!user?.pin && !usePassword;
    const problem = h('p', { class: 'gate-problem', role: 'alert' }, message);
    const go = h('button', { type: 'submit', class: 'btn primary gate-go' }, look === 'default' ? 'Unlock' : words ? words.button : 'Continue');
    const signOut = h('button', { type: 'button', class: 'btn' }, 'Sign out');
    const secret = look === 'default' ? { pin: 'PIN', pass: 'Password' } : { pin: words ? words.pass : 'Code', pass: words ? words.pass : 'Password' };
    const other = h('button', { type: 'button', class: 'btn' }, withPin ? `Use my ${look === 'default' ? 'password' : 'password instead'}` : `Use my ${secret.pin === 'PIN' ? 'PIN' : 'code'}`);
    const form = h('form', { class: 'gate-form', novalidate: true });
    let read: () => Promise<void>;
    if (withPin) {
      const pin = h('input', { type: 'password', class: 'field gate-input lock-pin', inputmode: 'numeric', autocomplete: 'off', maxlength: 4, pattern: '[0-9]*', 'aria-label': 'PIN' });
      form.append(h('label', { class: 'gate-row' }, h('span', { class: 'gate-label' }, secret.pin), pin));
      on(pin, 'input', () => {
        pin.value = pin.value.replace(/\D/g, '').slice(0, 4);
        if (pin.value.length === 4) form.requestSubmit();
      }, signal);
      read = () => this.tryPin(pin.value);
    } else {
      const pass = passwordField({ label: secret.pass, autocomplete: 'current-password', signal });
      const code = h('input', { type: 'text', class: 'field gate-input', autocomplete: 'one-time-code', inputmode: 'numeric', maxlength: 6, 'aria-label': 'Two-step code' });
      form.append(pass.row);
      if (user?.totp) form.append(h('label', { class: 'gate-row' }, h('span', { class: 'gate-label' }, 'Two-step code'), code));
      read = () => this.tryPassword(pass.input.value, code.value.trim());
    }
    form.append(problem, h('div', { class: 'gate-buttons' }, ...(user?.pin ? [other] : []), signOut, go));
    on(form, 'submit', (event: SubmitEvent) => {
      event.preventDefault();
      go.disabled = true;
      void read().finally(() => (go.disabled = false));
    }, signal);
    on(other, 'click', () => this.drawPrompt('', withPin), signal);
    on(signOut, 'click', () => {
      // In a preview, Sign out is only shown: it ends the preview, never the session.
      if (this.previewing) {
        this.reset();
        return;
      }
      void this.o.api?.logout().catch(() => undefined).then(() => {
        this.reset();
        this.o.signedOut('You signed out.');
      });
    }, signal);
    const intro = look === 'default'
      ? (user ? `${user.display} is signed in. ${withPin ? 'Type your PIN to unlock.' : 'Type your password to unlock.'}` : 'Type your password to unlock.')
      : look === 'plain' ? `Enter your ${withPin ? 'code' : 'password'} to continue.` : '';
    this.layer.append(
      h('div', { class: `gate lock-gate lock-look-${look}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'lock-title' },
        h('main', { class: 'gate-panel' },
          look === 'default' ? h('div', { class: 'gate-brand' }, icon('logo', 40), h('span', {}, 'TOMLIN OS')) : null,
          h('h1', { id: 'lock-title' }, look === 'default' ? 'Locked' : words ? words.title : 'Session timed out'),
          intro ? h('p', { class: 'gate-intro' }, intro) : null,
          form)),
    );
    form.querySelector<HTMLInputElement>('input')?.focus();
  }

  private async tryPin(pin: string): Promise<void> {
    if (this.previewing) {
      this.reset();
      return;
    }
    try {
      await this.o.api!.unlockPin(pin);
      this.reset();
    } catch (error) {
      this.failed(error);
    }
  }

  private async tryPassword(password: string, code: string): Promise<void> {
    if (this.previewing) {
      this.reset();
      return;
    }
    try {
      await this.o.api!.unlockPassword(password, code);
      this.reset();
    } catch (error) {
      this.failed(error);
    }
  }

  /** A wrong try: the lock screen says so (with the tries left), in the same mode it was in. */
  private failed(error: unknown): void {
    if (error instanceof AuthFailure && error.signedOut) {
      this.reset();
      this.o.signedOut(error.message);
      return;
    }
    const usePassword = this.phase === 'prompt' && !this.layer.querySelector('.lock-pin');
    this.drawPrompt(error instanceof Error ? error.message : String(error), usePassword);
  }
}
