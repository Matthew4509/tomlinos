// My account: the signed-in person's password, two-step sign-in (with a QR code for the phone and recovery codes), the
// screen PIN, the screensaver and lock, the devices signed in, and the sign-in history. The owner also manages the
// people on this desktop here. Every change is made by the server; changes to the account ask for the password first
// (and the two-step code when that is on), so an unlocked desktop left alone cannot be taken over. The recovery key and
// encryption are made in the browser (src/auth/files.ts); the server only ever sees wraps and proofs.
import { h, on, svg } from '../core/dom.ts';
import { qrMatrix, qrSvgPath } from '../core/qr.ts';
import { AuthFailure, type PublicUser } from '../auth/api.ts';
import { passwordField } from '../auth/gate.ts';
import { saverControls } from '../shell/saverform.ts';
import type { AppDef, AppHandle } from '../shell/types.ts';
import { APPS } from './catalog.ts';

const when = (seconds: number) => new Date(seconds * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

/** "Chrome on Windows" from a browser's user-agent line; enough to tell devices apart. */
function deviceName(agent: string): string {
  const browser = /Edg\//.test(agent) ? 'Edge' : /Firefox\//.test(agent) ? 'Firefox' : /Chrome\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : 'A browser';
  const system = /Android/.test(agent) ? 'Android' : /iPhone|iPad/.test(agent) ? 'iPhone or iPad' : /Windows/.test(agent) ? 'Windows' : /Mac OS/.test(agent) ? 'Mac' : /Linux/.test(agent) ? 'Linux' : 'an unknown system';
  return `${browser} on ${system}`;
}

type AccountPage = 'signin' | 'files' | 'lock' | 'devices' | 'people';

export const accountApp: AppDef = {
  ...APPS.account,
  launch(app, arg) {
    app.root.classList.add('settings', 'account');
    // Opened on a page when asked (Chat's "Add people..." opens People on this desktop).
    const view = new AccountView(app, arg === 'people' ? 'people' : 'signin');
    view.draw();
  },
};

class AccountView {
  private app: AppHandle;
  /** Ends the listeners of the last drawing when the view is drawn again. */
  private drawn: AbortController | null = null;

  constructor(app: AppHandle, page: AccountPage) {
    this.app = app;
    this.page = page;
  }

  private get account() {
    return this.app.shell.account;
  }

  draw(): void {
    this.drawn?.abort();
    this.drawn = new AbortController();
    this.app.signal.addEventListener('abort', () => this.drawn?.abort(), { once: true });
    const root = this.app.root;
    root.replaceChildren();
    const account = this.account;
    if (!account) {
      root.append(
        h('h2', { class: 'set-h' }, 'No accounts here'),
        h('p', {}, 'This copy of the desktop keeps its files in this browser, so there are no accounts, passwords or lock.'),
        h('p', { class: 'hint' }, 'Accounts, two-step sign-in and the screen lock work when the desktop runs on its server. The screensaver below still works.'),
        this.saverSection(),
      );
      return;
    }
    const user = account.user();
    const signOut = h('button', { type: 'button', class: 'btn' }, 'Sign out');
    on(signOut, 'click', () => void account.signOut(), this.app.signal);
    // Laid out the way Windows lays out Accounts: pages listed on the left, one page shown on the right.
    const pages: Array<[AccountPage, string, () => Node[]]> = [
      ['signin', 'Sign-in options', () => [this.passwordSection(user), this.pinSection(user), this.twoStepSection(user), this.recoverySection(user), this.unlockEmailSection(user)]],
      ['files', 'Your files', () => [this.encryptionSection(user)]],
      ['lock', 'Screensaver and lock', () => [this.saverSection()]],
      ['devices', 'Devices and history', () => [this.devicesSection(), this.historySection()]],
      ...(user.admin ? [['people', 'People on this desktop', () => [this.peopleSection(user)]] as [AccountPage, string, () => Node[]]] : []),
    ];
    if (!pages.some(p => p[0] === this.page)) this.page = 'signin';
    const nav = h('nav', { class: 'acct-nav', 'aria-label': 'Account pages' },
      ...pages.map(([id, label]) => {
        const b = h('button', { type: 'button', class: `acct-tab${id === this.page ? ' on' : ''}`, 'aria-current': id === this.page ? 'page' : 'false' }, label);
        on(b, 'click', () => { this.page = id; this.draw(); root.querySelector<HTMLElement>('.acct-tab.on')?.focus(); }, this.drawn!.signal);
        return b;
      }));
    const shown = pages.find(p => p[0] === this.page)!;
    root.append(h('div', { class: 'acct-layout' },
      h('div', { class: 'acct-side' },
        h('div', { class: 'acct-head' },
          h('div', {}, h('div', { class: 'acct-name' }, user.display), h('div', { class: 'hint' }, `Signed in as ${user.name}${user.admin ? ' · owner' : ''}`))),
        nav,
        signOut),
      h('div', { class: 'acct-page' }, h('h2', { class: 'acct-title' }, shown[1]), ...shown[2]()),
    ));
  }

  /** The page on the right; kept while the window is open, so a redraw after a change stays on it. */
  private page: AccountPage = 'signin';

  // ---- Small parts ---------------------------------------------------------------------------------------------------

  private section(title: string, ...kids: Node[]): HTMLElement {
    return h('section', { class: 'acct-section' }, h('h2', { class: 'set-h' }, title), ...kids);
  }

  private button(label: string, run: () => void, cls = 'btn'): HTMLButtonElement {
    const b = h('button', { type: 'button', class: cls }, label);
    on(b, 'click', run, this.app.signal);
    return b;
  }

  /**
   * A form that opens under a section: its fields, a problem line, and OK / Cancel. `submit` returns true when done (the
   * form closes and the section is drawn again); a thrown refusal is shown on the problem line.
   */
  private inlineForm(host: HTMLElement, fields: Node[], ok: string, submit: () => Promise<boolean | void>, danger = false): void {
    host.querySelector('.acct-form')?.remove();
    const problem = h('p', { class: 'dialog-problem', role: 'alert' });
    const go = h('button', { type: 'submit', class: `btn ${danger ? 'danger' : 'primary'}` }, ok);
    const cancel = h('button', { type: 'button', class: 'btn' }, 'Cancel');
    const form = h('form', { class: 'acct-form', novalidate: true }, ...fields, problem, h('div', { class: 'acct-buttons' }, cancel, go));
    on(cancel, 'click', () => form.remove(), this.app.signal);
    on(form, 'submit', (event: SubmitEvent) => {
      event.preventDefault();
      go.disabled = true;
      problem.textContent = '';
      submit()
        .then(done => {
          if (done !== false) this.draw();
        })
        .catch(error => {
          if (error instanceof AuthFailure && error.signedOut) {
            void this.account?.signOut(error.message);
            return;
          }
          problem.textContent = error instanceof Error ? error.message : String(error);
        })
        .finally(() => (go.disabled = false));
    }, this.app.signal);
    host.append(form);
    form.querySelector<HTMLInputElement>('input')?.focus();
  }

  /** Password (and the two-step code when it is on): what the server asks for before changing the account. */
  private identity(user: PublicUser): { nodes: Node[]; password: () => string; code: () => string } {
    const pass = passwordField({ label: 'Your current password', autocomplete: 'current-password', signal: this.app.signal });
    const code = h('input', { type: 'text', class: 'field', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6 });
    const nodes: Node[] = [pass.row];
    if (user.totp) nodes.push(h('label', { class: 'gate-row' }, h('span', { class: 'gate-label' }, 'Two-step code from your authenticator'), code));
    return { nodes, password: () => pass.input.value, code: () => code.value.trim() };
  }

  // ---- Unlock email ----------------------------------------------------------------------------------------------------

  /** Where "Email me an unlock link" sends its one-time link, when wrong passwords have held this account. */
  private unlockEmailSection(user: PublicUser): HTMLElement {
    const account = this.account!;
    const state = h('p', { class: 'hint' }, user.unlockEmail ? `Set: ${user.unlockEmail}.` : 'Not set.');
    const box = this.section('Unlock email',
      h('p', { class: 'hint' }, 'If wrong passwords ever hold your account, the sign-in screen offers "Email me an unlock link". The link gives 3 more tries for one hour and does not change your password. One is sent until you next sign in, so nobody can flood your inbox.'),
      state);
    box.append(this.button(user.unlockEmail ? 'Change unlock email...' : 'Set unlock email...', () => {
      const id = this.identity(user);
      const email = h('input', { type: 'email', class: 'field', autocomplete: 'email', maxlength: 254, spellcheck: 'false' });
      this.inlineForm(box, [h('label', { class: 'gate-row' }, h('span', { class: 'gate-label' }, 'Email address (leave empty to remove it)'), email), ...id.nodes], 'Save', async () => {
        const r = await account.api.setUnlockEmail(id.password(), id.code(), email.value.trim());
        state.textContent = r.user.unlockEmail ? `Set: ${r.user.unlockEmail}.` : 'Not set.';
        this.app.shell.toast(r.user.unlockEmail ? 'Unlock email saved.' : 'Unlock email removed.');
      });
    }));
    return box;
  }

  // ---- Password ------------------------------------------------------------------------------------------------------

  private passwordSection(user: PublicUser): HTMLElement {
    const account = this.account!;
    const box = this.section('Password', h('p', { class: 'hint' }, 'Changing it signs you out of every other device. Forgot it? "Forgot your password?" on the sign-in screen takes your recovery key.'));
    box.append(this.button('Change password...', () => {
      const id = this.identity(user);
      const next = passwordField({ label: 'New password', autocomplete: 'new-password', signal: this.app.signal, choosing: () => user.name });
      this.inlineForm(box, [...id.nodes, next.row], 'Change password', async () => {
        // With encryption on, the file key is wrapped again for the new password here, before the server is asked.
        const wrap = await account.files.wrapForNewPassword(id.password(), next.input.value);
        const r = await account.api.changePassword(id.password(), id.code(), next.input.value, wrap);
        if (wrap && account.files.keys) account.files.apply({ ...account.files.keys, ...wrap, stale: false });
        this.app.shell.toast(r.endedOthers ? `Password changed. ${r.endedOthers} other device${r.endedOthers === 1 ? ' was' : 's were'} signed out.` : 'Password changed.');
      });
    }));
    return box;
  }

  // ---- Recovery key and encryption -----------------------------------------------------------------------------------

  private recoverySection(user: PublicUser): HTMLElement {
    const account = this.account!;
    const box = this.section('Recovery key',
      h('p', {}, user.recoveryKey
        ? `Made ${when(user.recoveryKeyMade)}. If you forget your password, it lets you choose a new one yourself${user.vault !== 'off' ? ', and it opens your encrypted files' : ''}.`
        : 'Not made yet. Make one now: without it, a forgotten password can only be reset by the owner of this desktop' + (user.admin ? ' (you: from the server itself).' : '.')),
      h('p', { class: 'hint' }, 'It is shown once. Keep it away from this computer: written down, printed, or in a password manager.'));
    const show = h('div', { class: 'acct-rkey' });
    box.append(this.button(user.recoveryKey ? 'Make a new recovery key...' : 'Make my recovery key...', () => {
      const id = this.identity(user);
      this.inlineForm(box, [...(user.recoveryKey ? [h('p', { class: 'hint' }, 'The old key stops working.')] : []), ...id.nodes], 'Make recovery key', async () => {
        const key = await account.files.makeRecoveryKey(id.password(), id.code());
        this.showKeyOnce(box, show, key);
        return false;
      });
    }), show);
    return box;
  }

  /** A recovery key on screen once, with Copy and "I have kept it". */
  private showKeyOnce(box: HTMLElement, host: HTMLElement, key: string): void {
    box.querySelector('.acct-form')?.remove();
    const copy = this.button('Copy', () => void navigator.clipboard.writeText(key).then(() => this.app.shell.toast('Recovery key copied. Paste it somewhere safe.'), () => this.app.shell.toast('The browser did not allow copying: write it down.')));
    const done = this.button('I have kept it somewhere safe', () => this.draw(), 'btn primary');
    host.replaceChildren(h('div', { class: 'acct-form' },
      h('p', {}, h('strong', {}, 'Your recovery key. '), 'This is the only time it is shown.'),
      h('p', { class: 'acct-secret' }, key),
      h('div', { class: 'acct-buttons' }, copy, done)));
  }

  private encryptionSection(user: PublicUser): HTMLElement {
    const account = this.account!;
    const files = account.files;
    const state = files.keys?.state ?? 'off';
    const status = h('p', {});
    const bar = h('div', { class: 'acct-progress', hidden: true }, h('div', { class: 'acct-progress-fill' }));
    const box = this.section('Encryption', status, bar);
    const drawStatus = () => {
      const p = files.progress;
      bar.hidden = !p;
      if (p) (bar.firstElementChild as HTMLElement).style.setProperty('width', `${p.total ? Math.round((p.done / p.total) * 100) : 100}%`);
      const st = files.keys?.state ?? 'off';
      status.textContent = st === 'on' ? 'On. Your files and their names are encrypted in your browser before they are stored; what the server keeps cannot be read without your password or recovery key.'
        : st === 'off' ? 'Off. Your files are kept as they are on the server: whoever runs the server could read them.'
        : p ? `${st === 'migrating-on' ? 'Encrypting' : 'Decrypting'} your files: ${p.done} of ${p.total} records. You can keep working.`
        : `${st === 'migrating-on' ? 'Encrypting' : 'Decrypting'} your files was interrupted. Both kinds open; carry on to finish.`;
    };
    files.changed.on(drawStatus, this.drawn!.signal);
    drawStatus();
    if (files.keys?.stale) {
      box.append(h('p', { class: 'dialog-problem' }, 'Your password was reset, so on other devices your files need your recovery key. Type it once here and your new password opens them everywhere again.'),
        this.button('Use my recovery key...', () => {
          const key = h('input', { type: 'text', class: 'field gate-rkey', autocomplete: 'off', spellcheck: 'false', maxlength: 60 });
          const pass = passwordField({ label: 'Your current password', autocomplete: 'current-password', signal: this.app.signal });
          this.inlineForm(box, [h('label', { class: 'gate-row' }, h('span', { class: 'gate-label' }, 'Recovery key'), key), pass.row], 'Re-open my files', async () => {
            await files.openWithRecovery(key.value, pass.input.value);
            this.app.shell.toast('Done: your password opens your files everywhere again.');
          });
        }));
    }
    box.append(h('p', { class: 'hint' }, 'Your choice, and you can change it any time. Encrypted: your password or your recovery key opens your files; lose both and nobody can open them, not even the owner. Not encrypted: the owner can always reset your password and your files stay readable.'));
    if (state === 'off') {
      box.append(this.button('Encrypt my files...', () => {
        const id = this.identity(user);
        const agree = h('input', { type: 'checkbox' });
        this.inlineForm(box, [
          ...id.nodes,
          h('label', { class: 'check-row' }, agree, ' I understand: if I lose both my password and my recovery key, my files cannot be opened.'),
          h('p', { class: 'hint' }, 'A new recovery key is made (your old one stops working) and shown once. Then every file is encrypted in the background.'),
        ], 'Encrypt my files', async () => {
          if (!agree.checked) throw new Error('Tick the box to say you understand, or press Cancel.');
          const key = await files.turnOn(id.password(), id.code());
          const host = h('div', {});
          box.append(host);
          this.showKeyOnce(box, host, key);
          void files.move().then(() => this.app.shell.toast('All your files are encrypted.'), error => void this.app.shell.report('Encrypting stopped', error));
          return false;
        });
      }, 'btn primary'));
    } else if (state === 'on') {
      box.append(this.button('Turn off encryption...', () => {
        const id = this.identity(user);
        this.inlineForm(box, [...id.nodes, h('p', { class: 'hint' }, 'Every file is decrypted in the background and stored readable on the server again.')], 'Turn off encryption', async () => {
          await files.turnOff(id.password(), id.code());
          void files.move().then(() => this.app.shell.toast('Your files are no longer encrypted.'), error => void this.app.shell.report('Decrypting stopped', error));
        }, true);
      }));
    } else if (!files.progress) {
      box.append(this.button(state === 'migrating-on' ? 'Finish encrypting' : 'Finish decrypting', () => {
        void files.move().then(() => this.draw(), error => void this.app.shell.report('Converting your files stopped', error));
      }, 'btn primary'));
    }
    return box;
  }

  // ---- Two-step sign-in ----------------------------------------------------------------------------------------------

  private twoStepSection(user: PublicUser): HTMLElement {
    const api = this.account!.api;
    if (user.totp) {
      const box = this.section('Two-step sign-in',
        h('p', {}, 'On. Signing in needs your password and the 6-digit code from your authenticator app.'),
        h('p', { class: 'hint' }, `${user.recoveryLeft} of 10 recovery codes left. Each works once, if your phone is lost.`));
      box.append(h('div', { class: 'acct-buttons' },
        this.button('Make new recovery codes...', () => {
          const id = this.identity(user);
          this.inlineForm(box, [h('p', { class: 'hint' }, 'The old codes stop working.'), ...id.nodes], 'Make new codes', async () => {
            const r = await api.recoveryNew(id.password(), id.code());
            this.account!.setUser(r.user);
            this.showRecovery(box, r.recovery);
            return false;
          });
        }),
        this.button('Turn off...', () => {
          const id = this.identity(user);
          this.inlineForm(box, [h('p', { class: 'hint' }, 'Signing in will need only your password.'), ...id.nodes], 'Turn off two-step sign-in', async () => {
            const r = await api.totpDisable(id.password(), id.code());
            this.account!.setUser(r.user);
            this.app.shell.toast('Two-step sign-in is off.');
          }, true);
        })));
      return box;
    }
    const box = this.section('Two-step sign-in',
      h('p', {}, 'Off. Turn it on so that a stolen password is not enough: signing in will also need a 6-digit code from an authenticator app on your phone.'));
    box.append(this.button('Turn on...', () => {
      const id = this.identity(user);
      this.inlineForm(box, [...id.nodes], 'Next', async () => {
        const begun = await api.totpBegin(id.password(), id.code());
        this.showSetup(box, begun.secret, begun.uri);
        return false;
      });
    }));
    return box;
  }

  private showSetup(box: HTMLElement, secret: string, uri: string): void {
    box.querySelector('.acct-form')?.remove();
    const size = qrMatrix(uri).length + 8;
    const qr = svg('svg', { class: 'acct-qr', viewBox: `0 0 ${size} ${size}`, role: 'img', 'aria-label': 'QR code for your authenticator app' },
      svg('rect', { width: size, height: size, fill: '#fff' }),
      svg('path', { d: qrSvgPath(qrMatrix(uri)), fill: '#000' }));
    const grouped = secret.replace(/(.{4})/g, '$1 ').trim();
    const code = h('input', { type: 'text', class: 'field', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6 });
    this.inlineForm(box, [
      h('p', {}, '1. In an authenticator app (Google Authenticator, Microsoft Authenticator, 2FAS, Aegis and others), add an account by scanning this code:'),
      qr,
      h('p', { class: 'hint' }, 'Cannot scan? Type this key into the app instead (time-based):'),
      h('p', { class: 'acct-secret' }, grouped),
      h('label', { class: 'gate-row' }, h('span', { class: 'gate-label' }, '2. Type the 6 numbers the app now shows for TOMLIN OS'), code),
    ], 'Turn on', async () => {
      const r = await this.account!.api.totpEnable(code.value.trim());
      this.account!.setUser(r.user);
      this.showRecovery(box, r.recovery);
      return false;
    });
  }

  /** Recovery codes, shown once. The page keeps no copy after this. */
  private showRecovery(box: HTMLElement, codes: string[]): void {
    box.querySelector('.acct-form')?.remove();
    const list = h('ol', { class: 'acct-codes' }, ...codes.map(c => h('li', {}, c)));
    const copy = this.button('Copy them', () => {
      void navigator.clipboard.writeText(codes.join('\n')).then(() => this.app.shell.toast('Recovery codes copied.'), () => this.app.shell.toast('The browser did not allow copying. Select them and press Ctrl+C.'));
    });
    const done = this.button('I have kept them somewhere safe', () => this.draw(), 'btn primary');
    box.append(h('div', { class: 'acct-form acct-recovery' },
      h('p', {}, h('strong', {}, 'Two-step sign-in is on.'), ' Keep these recovery codes somewhere safe (printed, or in a password manager). If your phone is lost, each one signs you in once. This is the only time they are shown.'),
      list, h('div', { class: 'acct-buttons' }, copy, done)));
  }

  // ---- PIN -----------------------------------------------------------------------------------------------------------

  private pinSection(user: PublicUser): HTMLElement {
    const api = this.account!.api;
    const box = this.section('Screen PIN',
      h('p', {}, user.pin ? 'Set. The locked screen opens with your 4-digit PIN.' : 'Not set. The locked screen opens with your password.'),
      h('p', { class: 'hint' }, 'A 4-digit PIN is a convenience, not strong security: there are only 10,000 of them. The server checks it, and 5 wrong tries sign you out, so the password (and two-step code) is needed again. The PIN only unlocks the screen; signing in always needs the password.'));
    const pinForm = (remove: boolean) => () => {
      const id = this.identity(user);
      const pin = h('input', { type: 'password', class: 'field', inputmode: 'numeric', autocomplete: 'off', maxlength: 4, pattern: '[0-9]*' });
      on(pin, 'input', () => (pin.value = pin.value.replace(/\D/g, '').slice(0, 4)), this.app.signal);
      const fields: Node[] = [...id.nodes];
      if (!remove) fields.push(h('label', { class: 'gate-row' }, h('span', { class: 'gate-label' }, 'New PIN (4 numbers)'), pin));
      this.inlineForm(box, fields, remove ? 'Remove PIN' : 'Save PIN', async () => {
        if (!remove && !/^\d{4}$/.test(pin.value)) throw new Error('A PIN is exactly 4 numbers.');
        const r = await api.setPin(id.password(), id.code(), remove ? null : pin.value);
        this.account!.setUser(r.user);
        this.app.shell.toast(remove ? 'PIN removed.' : 'PIN saved.');
      }, remove);
    };
    box.append(h('div', { class: 'acct-buttons' }, this.button(user.pin ? 'Change PIN...' : 'Set a PIN...', pinForm(false)), ...(user.pin ? [this.button('Remove PIN...', pinForm(true))] : [])));
    return box;
  }

  // ---- Screensaver and lock ------------------------------------------------------------------------------------------

  private saverSection(): HTMLElement {
    return this.section('Screensaver and lock', ...saverControls(this.app.shell, this.app.signal));
  }

  // ---- Devices and history -------------------------------------------------------------------------------------------

  private devicesSection(): HTMLElement {
    const api = this.account!.api;
    const list = h('div', { class: 'acct-list' }, h('p', { class: 'hint' }, 'Loading...'));
    const box = this.section('Signed-in devices', list);
    const fill = async () => {
      try {
        const { sessions } = await api.sessions();
        list.replaceChildren(...sessions.map(s => {
          const row = h('div', { class: 'acct-row' },
            h('div', {}, h('div', {}, deviceName(s.agent), s.current ? h('strong', {}, '  (this one)') : ''), h('div', { class: 'hint' }, `Last used ${when(s.seen)} · ${s.ip || 'unknown address'}${s.locked ? ' · locked' : ''}`)));
          if (!s.current) row.append(this.button('Sign out', () => void api.revoke(s.id).then(fill, error => this.app.shell.report('Could not sign that device out', error))));
          return row;
        }));
        if (sessions.length > 1) list.append(this.button('Sign out all other devices', () => void api.revoke('others').then(r => {
          this.app.shell.toast(`${r.ended} other device${r.ended === 1 ? '' : 's'} signed out.`);
          return fill();
        })));
      } catch (error) {
        list.replaceChildren(h('p', { class: 'dialog-problem' }, error instanceof Error ? error.message : String(error)));
      }
    };
    void fill();
    return box;
  }

  private historySection(): HTMLElement {
    const list = h('div', { class: 'acct-history' }, h('p', { class: 'hint' }, 'Loading...'));
    const box = this.section('Sign-in history', h('p', { class: 'hint' }, 'The last 50 sign-ins and account changes. Anything you do not recognise: change your password and sign out the other devices.'), list);
    this.account!.api.history().then(({ history }) => {
      list.replaceChildren(...(history.length ? history.map(e => h('div', { class: 'acct-row' }, h('div', {}, h('div', {}, (e.times ?? 1) > 1 ? `${e.event} (${e.times} times; the latest below)` : e.event), h('div', { class: 'hint' }, `${when(e.at)} · ${deviceName(e.agent)} · ${e.ip || 'unknown address'}`)))) : [h('p', { class: 'hint' }, 'Nothing yet.')]));
    }, error => list.replaceChildren(h('p', { class: 'dialog-problem' }, error instanceof Error ? error.message : String(error))));
    return box;
  }

  // ---- People (owner only) -------------------------------------------------------------------------------------------

  private peopleSection(me: PublicUser): HTMLElement {
    const api = this.account!.api;
    const list = h('div', { class: 'acct-list' }, h('p', { class: 'hint' }, 'Loading...'));
    const box = this.section('People on this desktop',
      h('p', { class: 'hint' }, 'There is no open sign-up: only you add people. Each person has their own private files; nobody, including you, sees another person\'s files from the desktop.'),
      list);
    const fill = async () => {
      const { users } = await api.users();
      list.replaceChildren(...users.map(u => {
        const row = h('div', { class: 'acct-row' }, h('div', {},
          h('div', {}, `${u.display} (${u.name})`, u.admin ? h('strong', {}, '  owner') : ''),
          h('div', { class: 'hint' }, [u.disabled ? 'switched off' : 'active', u.totp ? 'two-step on' : 'two-step off', `since ${new Date(u.created * 1000).toLocaleDateString()}`].join(' · '))));
        if (u.id !== me.id) {
          row.append(h('div', { class: 'acct-buttons' },
            this.button('Set password...', () => {
              const pass = passwordField({ label: `New password for ${u.display}`, autocomplete: 'new-password', signal: this.app.signal, choosing: () => u.name });
              const id = this.identity(me);
              this.inlineForm(box, [h('p', { class: 'hint' }, 'They are signed out everywhere and use this password next time. Tell it to them in person.'), pass.row, ...id.nodes], 'Set password', async () => {
                await api.userPassword(u.id, pass.input.value, id.password(), id.code());
                this.app.shell.toast(`New password set for ${u.display}.`);
              });
            }),
            this.button(u.disabled ? 'Switch on...' : 'Switch off...', () => {
              const id = this.identity(me);
              const words = u.disabled ? `${u.display} can sign in again.` : `${u.display} is signed out everywhere and cannot sign in until you switch the account on. Their files are kept.`;
              this.inlineForm(box, [h('p', { class: 'hint' }, words), ...id.nodes], u.disabled ? 'Switch on' : 'Switch off', async () => {
                await api.userDisable(u.id, !u.disabled, id.password(), id.code());
                await fill();
              });
            }),
            ...(u.totp ? [this.button('Turn off two-step...', () => {
              const id = this.identity(me);
              this.inlineForm(box, [h('p', { class: 'hint' }, `${u.display} can then sign in with the password alone, and is signed out everywhere now.`), ...id.nodes], 'Turn off two-step', async () => {
                await api.userTwoStepOff(u.id, id.password(), id.code());
                await fill();
              });
            })] : [])));
        }
        return row;
      }));
    };
    void fill().catch(error => list.replaceChildren(h('p', { class: 'dialog-problem' }, error instanceof Error ? error.message : String(error))));
    box.append(this.button('Add a person...', () => {
      const display = h('input', { type: 'text', class: 'field', maxlength: 60 });
      const name = h('input', { type: 'text', class: 'field', maxlength: 32, autocapitalize: 'off', spellcheck: 'false' });
      const pass = passwordField({ label: 'Their first password', autocomplete: 'new-password', signal: this.app.signal, choosing: () => name.value.trim() });
      const id = this.identity(me);
      on(display, 'input', () => {
        if (!name.dataset.touched) name.value = display.value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '').slice(0, 32);
      }, this.app.signal);
      on(name, 'input', () => (name.dataset.touched = '1'), this.app.signal);
      this.inlineForm(box, [
        h('label', { class: 'gate-row' }, h('span', { class: 'gate-label' }, 'Their name'), display),
        h('label', { class: 'gate-row' }, h('span', { class: 'gate-label' }, 'User name (for signing in)'), name),
        pass.row,
        ...id.nodes,
      ], 'Add person', async () => {
        const r = await api.userCreate(name.value.trim(), display.value.trim(), pass.input.value, id.password(), id.code());
        this.app.shell.toast(`${r.user.display} can now sign in as "${r.user.name}".`);
      });
    }));
    return box;
  }
}
