// The sign-in screen. On the very first visit it sets up the owner; after that it signs people in, then asks for the
// two-step code when they have turned that on. It carries the sign-in and nothing else.
//
// Unless the owner chose otherwise, what a visitor sees first is not a sign-in at all but a book reader with Sherlock
// Holmes (public/reader/) and a small "Log in for more" in its corner, so someone who finds the site, or a bot, finds
// only old books. Log in opens the same sign-in in plain words, without the TOMLIN OS name.
import { h, on } from '../core/dom.ts';
import { icon, iconDefs } from '../shell/icons.ts';
import { AuthFailure, type AuthApi, type AuthStatus, type PublicUser } from './api.ts';
import type { FilesVault } from './files.ts';
import { passwordVerdict, suggestPassword } from './password.ts';
import { recoveryParts, unwrapWithRecovery, wrapWithPassword } from './vault.ts';

/** The icons' shared gradients: the desktop adds them when it starts, but these screens can come first. */
function brand(): HTMLElement {
  return h('div', { class: 'gate-brand' }, ...(document.querySelector('.icon-defs') ? [] : [iconDefs()]), icon('logo', 40), h('span', {}, 'TOMLIN OS'));
}

/** A password box with Show and, where a new password is chosen, Suggest one and a verdict line. */
export function passwordField(options: { label: string; autocomplete: string; signal: AbortSignal; choosing?: () => string }): { row: HTMLElement; input: HTMLInputElement } {
  const input = h('input', { type: 'password', class: 'field gate-input', autocomplete: options.autocomplete, spellcheck: 'false', autocapitalize: 'off', required: true });
  const show = h('button', { type: 'button', class: 'btn gate-show', 'aria-pressed': 'false' }, 'Show');
  on(show, 'click', () => {
    const shown = input.type === 'password';
    input.type = shown ? 'text' : 'password';
    show.textContent = shown ? 'Hide' : 'Show';
    show.setAttribute('aria-pressed', String(shown));
    input.focus();
  }, options.signal);
  const controls = h('span', { class: 'gate-pass' }, input, show);
  const row = h('label', { class: 'gate-row' }, h('span', { class: 'gate-label' }, options.label), controls);
  if (options.choosing) {
    const name = options.choosing;
    const verdict = h('span', { class: 'gate-verdict', 'aria-live': 'polite' });
    const suggest = h('button', { type: 'button', class: 'btn gate-suggest' }, 'Suggest one');
    const judge = () => {
      const v = passwordVerdict(input.value, name());
      verdict.textContent = v.text;
      verdict.dataset.level = String(v.level);
    };
    on(input, 'input', judge, options.signal);
    on(suggest, 'click', () => {
      input.value = suggestPassword();
      input.type = 'text';
      show.textContent = 'Hide';
      show.setAttribute('aria-pressed', 'true');
      judge();
      input.focus();
      input.select();
    }, options.signal);
    controls.append(suggest);
    row.append(verdict);
  }
  return { row, input };
}

/**
 * Shows the sign-in screen in `host` until someone is fully signed in, then removes it and resolves with their status.
 * `note` is shown above the form (why the person is being asked again, for instance).
 */
export function signIn(host: HTMLElement, api: AuthApi, start: AuthStatus, note = ''): Promise<AuthStatus> {
  return new Promise(resolve => {
    const abort = new AbortController();
    const signal = abort.signal;
    const panel = h('main', { class: 'gate-panel', 'aria-labelledby': 'gate-title' });
    const screen = h('div', { class: 'gate', role: 'dialog', 'aria-modal': 'true' }, panel);
    host.append(screen);
    const previousTitle = document.title;

    const done = (status: AuthStatus) => {
      abort.abort();
      screen.remove();
      document.title = previousTitle;
      resolve(status);
    };

    // Behind the reader front: no TOMLIN OS name, no brand, and a way back to the book.
    let plain = false;
    const frame = (title: string, intro: string[], form: HTMLFormElement) => {
      document.title = plain ? 'Reader' : `TOMLIN OS - ${title}`;
      const back = plain ? h('button', { type: 'button', class: 'gate-link front-back' }, 'Back to the book') : null;
      if (back) on(back, 'click', () => void api.logout().catch(() => undefined).finally(() => (panel.hidden = true)), signal);
      panel.replaceChildren(
        ...(plain ? [] : [brand()]),
        h('h1', { id: 'gate-title' }, title),
        ...(note ? [h('p', { class: 'gate-note', role: 'status' }, note)] : []),
        ...intro.map(t => h('p', { class: 'gate-intro' }, t)),
        form,
        ...(back ? [back] : []),
      );
      note = '';
      form.querySelector<HTMLInputElement>('input')?.focus();
    };

    const problemLine = () => h('p', { class: 'gate-problem', role: 'alert' });
    const busy = (form: HTMLFormElement, on: boolean) => {
      for (const el of form.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')) el.disabled = on;
    };
    const failed = (problem: HTMLElement, error: unknown) => {
      problem.textContent = error instanceof Error ? error.message : String(error);
    };

    // The password just typed, handed to the start-up so encrypted files open without asking again. Page memory only.
    let typed = '';

    const setup = () => {
      const display = h('input', { type: 'text', class: 'field gate-input', autocomplete: 'name', maxlength: 60 });
      const name = h('input', { type: 'text', class: 'field gate-input', autocomplete: 'username', spellcheck: 'false', autocapitalize: 'off', maxlength: 32, required: true });
      const pass = passwordField({ label: 'Password', autocomplete: 'new-password', signal, choosing: () => name.value.trim() });
      // Ticked: encrypted is the safer start, and the person can still untick it.
      const encrypt = h('input', { type: 'checkbox', class: 'gate-encrypt', checked: true });
      const setupCode = h('input', { type: 'text', class: 'field gate-input gate-rkey', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', maxlength: 20, placeholder: 'abcd-efgh-ijkl' });
      const problem = problemLine();
      const go = h('button', { type: 'submit', class: 'btn primary gate-go' }, 'Set up this desktop');
      const form = h('form', { class: 'gate-form', novalidate: true },
        ...(start.setupCode ? [
          h('label', { class: 'gate-row' }, h('span', { class: 'gate-label' }, 'Set-up code'), setupCode),
          h('p', { class: 'gate-small' }, 'So that nobody else can claim a new desktop first, set-up asks for a code kept on your server. Open cPanel File Manager and look in tomlinos/data/accounts/SETUP-CODE.txt.'),
        ] : []),
        h('label', { class: 'gate-row' }, h('span', { class: 'gate-label' }, 'Your name'), display),
        h('label', { class: 'gate-row' }, h('span', { class: 'gate-label' }, 'User name (for signing in)'), name),
        pass.row,
        h('label', { class: 'check-row' }, encrypt, ' Encrypt my files'),
        h('p', { class: 'gate-small' }, ENCRYPT_WHY),
        problem, go);
      on(display, 'input', () => {
        if (!name.dataset.touched) name.value = display.value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '').slice(0, 32);
      }, signal);
      on(name, 'input', () => (name.dataset.touched = '1'), signal);
      on(form, 'submit', (event: SubmitEvent) => {
        event.preventDefault();
        busy(form, true);
        api.setup(name.value.trim(), display.value.trim(), pass.input.value, setupCode.value.trim())
          .then(status => done({ ...status, password: pass.input.value, encrypt: encrypt.checked }))
          .catch(error => {
            busy(form, false);
            failed(problem, error);
          });
      }, signal);
      frame('Set up this desktop', [
        'Nobody has been set up here yet. You will be the owner: you can add other people later, from My account.',
        'Any files already on this desktop become yours.',
      ], form);
    };

    /** `link`: an emailed unlock link already opened (its name and tries), whose token goes with each try. */
    const password = (link?: { token: string; name: string; tries: number }) => {
      const name = h('input', { type: 'text', class: 'field gate-input', autocomplete: 'username', spellcheck: 'false', autocapitalize: 'off', maxlength: 32, required: true, value: link?.name });
      const pass = passwordField({ label: 'Password', autocomplete: 'current-password', signal });
      const problem = problemLine();
      // The picture check, shown once the server asks for it (after a wrong try). Drawn by the server as an SVG, shown
      // through an <img>, where nothing in it can run.
      const picture = h('img', { class: 'gate-captcha-img', alt: 'Five numbers to type', width: 200, height: 70 });
      const answer = h('input', { type: 'text', class: 'field gate-input gate-captcha', inputmode: 'numeric', autocomplete: 'off', spellcheck: 'false', maxlength: 8 });
      const another = h('button', { type: 'button', class: 'gate-link' }, 'Another picture');
      const captchaRow = h('div', { class: 'gate-row gate-captcha-row', hidden: true }, h('span', { class: 'gate-label' }, 'The numbers in the picture'), picture, h('span', { class: 'gate-captcha-line' }, answer, another));
      let captchaId = '';
      let pictureUrl = '';
      const loadPicture = async () => {
        try {
          const c = await api.captcha();
          captchaId = c.id;
          const url = URL.createObjectURL(new Blob([c.svg], { type: 'image/svg+xml' }));
          picture.src = url;
          if (pictureUrl) URL.revokeObjectURL(pictureUrl);
          pictureUrl = url;
          answer.value = '';
          captchaRow.hidden = false;
        } catch (error) {
          failed(problem, error);
        }
      };
      on(another, 'click', () => void loadPicture(), signal);
      // Held: the one-time emailed link (sent only if this account has an unlock email).
      const mail = h('button', { type: 'button', class: 'gate-link gate-unlock-mail', hidden: true }, 'Email me an unlock link');
      on(mail, 'click', () => {
        mail.disabled = true;
        api.unlockMail(name.value.trim()).then(r => (problem.textContent = r.message), error => failed(problem, error));
      }, signal);
      const go = h('button', { type: 'submit', class: 'btn primary gate-go' }, plain ? 'Log in' : 'Sign in');
      const forgot = h('button', { type: 'button', class: 'gate-link' }, 'Forgot your password?');
      const form = h('form', { class: 'gate-form', novalidate: true }, h('label', { class: 'gate-row' }, h('span', { class: 'gate-label' }, plain ? 'Username' : 'User name'), name), pass.row, captchaRow, problem, mail, h('div', { class: 'gate-buttons' }, forgot, go));
      on(forgot, 'click', () => recover(name.value.trim()), signal);
      on(form, 'submit', (event: SubmitEvent) => {
        event.preventDefault();
        if (!name.value.trim() || !pass.input.value) {
          problem.textContent = 'Type your user name and password.';
          return;
        }
        busy(form, true);
        typed = pass.input.value;
        const extra = { ...(captchaRow.hidden ? {} : { captchaId, captcha: answer.value.trim() }), ...(link ? { unlock: link.token } : {}) };
        api.login(name.value.trim(), pass.input.value, extra)
          .then(status => (status.signedIn ? done({ ...status, password: typed }) : code()))
          .catch(error => {
            busy(form, false);
            failed(problem, error);
            // Any picture shown is used up; after a wrong try (or when asked) a new one comes with the next one.
            if (error instanceof AuthFailure && (error.status === 401 || error.data.captcha)) void loadPicture();
            else captchaRow.hidden = true;
            if (error instanceof AuthFailure && error.data.held) mail.hidden = false;
            if (error instanceof AuthFailure && error.data.captcha) answer.focus();
            else pass.input.select();
          });
      }, signal);
      frame(plain ? 'Log in' : 'Sign in', link ? [`This unlock link gives you ${link.tries} more ${link.tries === 1 ? 'try' : 'tries'}. It does not change your password.`] : [], form);
      if (link) pass.input.focus();
    };

    /** An emailed unlock link opened (#unlock=... in the address): its tries, then the sign-in with the token. */
    const openLink = (token: string) => {
      panel.hidden = false;
      api.unlockLink(token).then(r => password({ token, name: r.name, tries: r.tries }), error => {
        note = error instanceof Error ? error.message : String(error);
        password();
      });
    };

    const code = () => {
      const input = h('input', { type: 'text', class: 'field gate-input gate-code', autocomplete: 'one-time-code', inputmode: 'text', spellcheck: 'false', autocapitalize: 'off', maxlength: 20, required: true });
      const problem = problemLine();
      const go = h('button', { type: 'submit', class: 'btn primary gate-go' }, 'Continue');
      const back = h('button', { type: 'button', class: 'btn gate-back' }, 'Back to sign in');
      const form = h('form', { class: 'gate-form', novalidate: true },
        h('label', { class: 'gate-row' }, h('span', { class: 'gate-label' }, 'Code'), input), problem, h('div', { class: 'gate-buttons' }, back, go));
      on(back, 'click', () => void api.logout().catch(() => undefined).then(() => password()), signal);
      on(form, 'submit', (event: SubmitEvent) => {
        event.preventDefault();
        busy(form, true);
        api.code(input.value.trim())
          .then(status => done({ ...status, password: typed || undefined }))
          .catch(error => {
            busy(form, false);
            failed(problem, error);
            if (error instanceof AuthFailure && error.signedOut) window.setTimeout(() => password(), 2500);
            else input.select();
          });
      }, signal);
      frame('Two-step code', ['Type the 6 numbers your authenticator app shows for TOMLIN OS now, or one of your recovery codes.'], form);
    };

    // "Forgot your password?": the recovery key (made in My account, or at set-up) lets you choose a new password
    // yourself, and keeps encrypted files open. Without it, the owner of the desktop sets a new password for you.
    const recover = (knownName: string) => {
      const name = h('input', { type: 'text', class: 'field gate-input', autocomplete: 'username', spellcheck: 'false', autocapitalize: 'off', maxlength: 32, value: knownName });
      const key = h('input', { type: 'text', class: 'field gate-input gate-rkey', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'characters', maxlength: 60, placeholder: 'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX' });
      const twoStep = h('input', { type: 'text', class: 'field gate-input', autocomplete: 'one-time-code', spellcheck: 'false', maxlength: 20 });
      const pass = passwordField({ label: 'New password', autocomplete: 'new-password', signal, choosing: () => name.value.trim() });
      const problem = problemLine();
      const back = h('button', { type: 'button', class: 'btn' }, 'Back to sign in');
      const go = h('button', { type: 'submit', class: 'btn primary gate-go' }, 'Set new password');
      const form = h('form', { class: 'gate-form', novalidate: true },
        h('label', { class: 'gate-row' }, h('span', { class: 'gate-label' }, 'User name'), name),
        h('label', { class: 'gate-row' }, h('span', { class: 'gate-label' }, 'Recovery key'), key),
        h('label', { class: 'gate-row' }, h('span', { class: 'gate-label' }, 'Two-step code (only if you use two-step sign-in)'), twoStep),
        pass.row, problem, h('div', { class: 'gate-buttons' }, back, go));
      on(back, 'click', () => void api.logout().catch(() => undefined).then(() => password()), signal);
      on(form, 'submit', (event: SubmitEvent) => {
        event.preventDefault();
        busy(form, true);
        (async () => {
          const parts = await recoveryParts(key.value);
          const started = await api.recoverStart(name.value.trim(), parts.auth, twoStep.value.trim());
          let wrap = null;
          if (started.vaultKeys) {
            const fileKey = await unwrapWithRecovery(started.vaultKeys.wrapRk, parts.kek, true).catch(() => {
              throw new Error('That recovery key proves who you are but does not open your files. Ask the owner of this desktop for help.');
            });
            wrap = await wrapWithPassword(fileKey, pass.input.value);
          }
          const status = await api.recoverFinish(pass.input.value, wrap);
          done({ ...status, password: pass.input.value });
        })().catch(error => {
          busy(form, false);
          failed(problem, error);
        });
      }, signal);
      frame('Forgot your password?', [
        'Type your recovery key (it was shown once, when it was made in My account or at set-up) and choose a new password.',
        'No recovery key? Ask the owner of this desktop to set you a new password. The owner, locked out, runs tools/reset-password.php on the server (tomlinos/tools/reset-password.php).',
      ], form);
    };

    /** The front: the reader fills the screen; Log in for more brings up the sign-in over it. */
    const readerFront = () => {
      plain = true;
      document.title = 'Reader';
      screen.classList.add('gate-front');
      const book = h('iframe', { class: 'front-reader', src: 'reader/index.html', title: 'Reader' });
      const login = h('button', { type: 'button', class: 'reader-login-link front-login' }, 'Log in for more');
      screen.prepend(book, login);
      panel.hidden = true;
      on(login, 'click', () => {
        panel.hidden = false;
        password();
      }, signal);
      // Signed out with a message ("You have signed out."): say it on the card, not over the book.
      if (note) {
        panel.hidden = false;
        password();
      }
    };

    // The token is taken out of the address at once, so it is not left in the history or on the screen.
    const linkToken = /^#unlock=([A-Za-z0-9_-]{43})$/.exec(location.hash)?.[1] ?? null;
    if (linkToken) history.replaceState(null, '', location.pathname + location.search);

    if (start.setup) setup();
    else if (start.stage === '2fa') code();
    else if (linkToken) {
      if (start.front !== 'signin') readerFront();
      openLink(linkToken);
    } else if (start.front !== 'signin') readerFront();
    else password();
  });
}

/**
 * The page was opened (or reloaded) while this session is locked: ask for the PIN or password before the desktop starts.
 * Resolves with the new status: unlocked, or signed out (five wrong tries, or Sign out) for the sign-in screen to take over.
 * With the Reader front (the default), a reload of a locked screen shows the book too: Log in for more asks for the PIN
 * or password without the person's name or the TOMLIN OS name.
 */
export function unlockFirst(host: HTMLElement, api: AuthApi, status: AuthStatus): Promise<AuthStatus> {
  return new Promise(resolve => {
    const abort = new AbortController();
    const signal = abort.signal;
    const user = status.user!;
    const panel = h('main', { class: 'gate-panel' });
    const screen = h('div', { class: 'gate lock-gate', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'gate-title' }, panel);
    host.append(screen);
    const plain = status.front !== 'signin';
    document.title = plain ? 'Reader' : 'TOMLIN OS - Locked';
    const finish = (next: AuthStatus) => {
      abort.abort();
      screen.remove();
      document.title = plain ? 'Reader' : 'TOMLIN OS';
      resolve(next);
    };
    const draw = (usePassword: boolean, message: string) => {
      const withPin = user.pin && !usePassword;
      const problem = h('p', { class: 'gate-problem', role: 'alert' }, message);
      const go = h('button', { type: 'submit', class: 'btn primary gate-go' }, plain ? 'Log in' : 'Unlock');
      const other = h('button', { type: 'button', class: 'btn' }, withPin ? 'Use my password' : 'Use my PIN');
      const out = h('button', { type: 'button', class: 'btn' }, 'Sign out');
      const form = h('form', { class: 'gate-form', novalidate: true });
      let attempt: () => Promise<AuthStatus>;
      if (withPin) {
        const pin = h('input', { type: 'password', class: 'field gate-input lock-pin', inputmode: 'numeric', autocomplete: 'off', maxlength: 4, 'aria-label': 'PIN' });
        form.append(h('label', { class: 'gate-row' }, h('span', { class: 'gate-label' }, 'PIN'), pin));
        on(pin, 'input', () => {
          pin.value = pin.value.replace(/\D/g, '').slice(0, 4);
          if (pin.value.length === 4) form.requestSubmit();
        }, signal);
        attempt = () => api.unlockPin(pin.value);
      } else {
        const pass = passwordField({ label: 'Password', autocomplete: 'current-password', signal });
        const code = h('input', { type: 'text', class: 'field gate-input', autocomplete: 'one-time-code', inputmode: 'numeric', maxlength: 6, 'aria-label': 'Two-step code' });
        form.append(pass.row);
        if (user.totp) form.append(h('label', { class: 'gate-row' }, h('span', { class: 'gate-label' }, 'Two-step code'), code));
        attempt = () => api.unlockPassword(pass.input.value, code.value.trim());
      }
      form.append(problem, h('div', { class: 'gate-buttons' }, ...(user.pin ? [other] : []), out, go));
      on(form, 'submit', (event: SubmitEvent) => {
        event.preventDefault();
        go.disabled = true;
        attempt().then(finish, error => {
          if (error instanceof AuthFailure && error.signedOut) finish({ signedIn: false });
          else draw(!withPin, error instanceof Error ? error.message : String(error));
        });
      }, signal);
      on(other, 'click', () => draw(!!withPin, ''), signal);
      on(out, 'click', () => void api.logout().catch(() => undefined).then(() => finish({ signedIn: false })), signal);
      panel.replaceChildren(
        ...(plain ? [] : [brand()]),
        h('h1', { id: 'gate-title' }, plain ? 'Log in' : 'Locked'),
        h('p', { class: 'gate-intro' }, plain ? (withPin ? 'Type your PIN.' : 'Type your password.') : `${user.display} is signed in. ${withPin ? 'Type your PIN to unlock.' : 'Type your password to unlock.'}`),
        form,
      );
      form.querySelector<HTMLInputElement>('input')?.focus();
    };
    if (plain) {
      screen.classList.add('gate-front');
      const book = h('iframe', { class: 'front-reader', src: 'reader/index.html', title: 'Reader' });
      const login = h('button', { type: 'button', class: 'reader-login-link front-login' }, 'Log in for more');
      screen.prepend(book, login);
      panel.hidden = true;
      on(login, 'click', () => {
        panel.hidden = false;
        draw(false, '');
      }, signal);
    } else draw(false, '');
  });
}

/** A plain screen in the sign-in style, for the steps between signing in and the desktop. */
function stepScreen(host: HTMLElement, title: string): { panel: HTMLElement; close: () => void; signal: AbortSignal } {
  const abort = new AbortController();
  const panel = h('main', { class: 'gate-panel' });
  const screen = h('div', { class: 'gate', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'gate-title' }, panel);
  host.append(screen);
  document.title = `TOMLIN OS - ${title}`;
  return {
    panel,
    signal: abort.signal,
    close: () => {
      abort.abort();
      screen.remove();
      document.title = 'TOMLIN OS';
    },
  };
}

const ENCRYPT_WHY = 'Encrypted: files are locked in your browser before they are stored, so the owner of this desktop, or anyone who copies the stored files, cannot read them. Your password or your recovery key opens them; lose both and they cannot be opened. (Whoever runs the server could change its code to catch your password, so use a server you trust.) You can change this later in My account.';

/**
 * The first sign-in of someone the owner added: the same choice the owner had at set-up, ticked unless they untick it.
 * Resolves true to encrypt.
 */
export function chooseEncryption(host: HTMLElement, display: string): Promise<boolean> {
  return new Promise(resolve => {
    const { panel, close, signal } = stepScreen(host, 'Your files');
    const encrypt = h('input', { type: 'checkbox', class: 'gate-encrypt', checked: true });
    const go = h('button', { type: 'button', class: 'btn primary gate-go' }, 'Continue');
    on(go, 'click', () => {
      close();
      resolve(encrypt.checked);
    }, signal);
    panel.append(
      brand(),
      h('h1', { id: 'gate-title' }, 'Your files'),
      h('p', { class: 'gate-intro' }, `Welcome, ${display}. Before your desktop opens, choose how your files are kept.`),
      h('label', { class: 'check-row' }, encrypt, ' Encrypt my files'),
      h('p', { class: 'gate-small' }, ENCRYPT_WHY),
      h('div', { class: 'gate-buttons' }, go),
    );
    go.focus();
  });
}

/**
 * Shows a recovery key once, with Copy, and waits until the person says they have kept it. The page keeps no copy.
 */
export function showRecoveryKey(host: HTMLElement, key: string, intro: string): Promise<void> {
  return new Promise(resolve => {
    const { panel, close, signal } = stepScreen(host, 'Your recovery key');
    const kept = h('input', { type: 'checkbox' });
    const go = h('button', { type: 'button', class: 'btn primary gate-go', disabled: true }, 'Continue');
    const copy = h('button', { type: 'button', class: 'btn' }, 'Copy');
    const note = h('p', { class: 'gate-small', role: 'status' });
    on(kept, 'change', () => (go.disabled = !kept.checked), signal);
    on(copy, 'click', () => void navigator.clipboard.writeText(key).then(() => (note.textContent = 'Copied. Paste it somewhere safe, then clear the clipboard.'), () => (note.textContent = 'The browser did not allow copying: write it down instead.')), signal);
    on(go, 'click', () => {
      close();
      resolve();
    }, signal);
    panel.append(
      brand(),
      h('h1', { id: 'gate-title' }, 'Your recovery key'),
      h('p', { class: 'gate-intro' }, intro),
      h('p', { class: 'gate-rkey-show' }, key),
      h('p', { class: 'gate-small' }, 'Write it down or print it, and keep it away from this computer (a password manager is fine). This is the only time it is shown. You can make a new one in My account; the old one then stops working.'),
      h('div', { class: 'gate-buttons' }, copy),
      note,
      h('label', { class: 'check-row' }, kept, ' I have kept my recovery key somewhere safe'),
      h('div', { class: 'gate-buttons' }, go),
    );
    copy.focus();
  });
}

/**
 * The files are encrypted and this page has no key for them yet: ask for the password (or, after a reset by the owner,
 * the recovery key). Resolves 'open' when opened, 'signout' when the person chose to sign out, 'fresh' when they chose to
 * start again with empty files (the locked ones are kept aside on the server).
 */
export function openFilesScreen(host: HTMLElement, vault: FilesVault, user: PublicUser, password: string | undefined): Promise<'open' | 'signout' | 'fresh'> {
  return new Promise(resolve => {
    const { panel, close, signal } = stepScreen(host, 'Open your files');
    const finish = (how: 'open' | 'signout' | 'fresh') => {
      close();
      resolve(how);
    };
    const stale = !!vault.keys?.stale;
    // The recovery key's box is shown after a reset by the owner (the server says the wrap is stale), and also as soon
    // as the password fails to open the files: a reset the server does not know of (an older copy of the account put
    // back from a backup, say) looks the same to the person, and they must not be stuck without the way out.
    let withKey = stale;
    const draw = (lost: boolean, said = '') => {
      const problem = h('p', { class: 'gate-problem', role: 'alert' }, said);
      const form = h('form', { class: 'gate-form', novalidate: true });
      const signOut = h('button', { type: 'button', class: 'btn' }, 'Sign out');
      on(signOut, 'click', () => finish('signout'), signal);
      if (lost) {
        const confirm = h('input', { type: 'text', class: 'field gate-input', autocomplete: 'off', spellcheck: 'false' });
        // The password you sign in with now (not the lost one): so nobody at an unattended screen can do this.
        const pass = passwordField({ label: 'Your password (the one you signed in with)', autocomplete: 'current-password', signal });
        if (password) pass.input.value = password;
        const code = h('input', { type: 'text', class: 'field gate-input', autocomplete: 'one-time-code', autocapitalize: 'off', spellcheck: 'false', maxlength: 14 });
        const go = h('button', { type: 'submit', class: 'btn danger gate-go' }, 'Start again with empty files');
        const back = h('button', { type: 'button', class: 'btn' }, 'Back');
        on(back, 'click', () => draw(false), signal);
        form.append(
          h('p', {}, 'Without your password or your recovery key, nobody can open your encrypted files, not even the owner of this desktop.'),
          h('p', {}, 'Starting again gives you empty files and turns encryption off. Your locked files are NOT deleted: they are set aside on the server, so if the recovery key turns up, the owner can bring them back.'),
          h('label', { class: 'gate-row' }, h('span', { class: 'gate-label' }, 'Type "start again" to confirm'), confirm),
          pass.row,
          ...(user.totp ? [h('label', { class: 'gate-row' }, h('span', { class: 'gate-label' }, 'Two-step code (or a recovery code)'), code)] : []),
          problem, h('div', { class: 'gate-buttons' }, back, go));
        on(form, 'submit', (event: SubmitEvent) => {
          event.preventDefault();
          if (confirm.value.trim().toLowerCase() !== 'start again') {
            problem.textContent = 'Type the words "start again" to confirm, or press Back.';
            return;
          }
          go.disabled = true;
          vault.abandon(pass.input.value, code.value.trim()).then(() => finish('fresh'), error => {
            go.disabled = false;
            problem.textContent = error instanceof Error ? error.message : String(error);
          });
        }, signal);
      } else {
        const key = h('input', { type: 'text', class: 'field gate-input gate-rkey', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'characters', maxlength: 60 });
        const pass = passwordField({ label: stale ? 'Your password (the new one)' : 'Your password', autocomplete: 'current-password', signal });
        if (password) pass.input.value = password;
        const go = h('button', { type: 'submit', class: 'btn primary gate-go' }, 'Open my files');
        const lostBtn = h('button', { type: 'button', class: 'gate-link' }, withKey ? 'I have lost my recovery key' : 'I cannot open them');
        on(lostBtn, 'click', () => draw(true), signal);
        if (withKey) form.append(h('label', { class: 'gate-row' }, h('span', { class: 'gate-label' }, stale ? 'Recovery key' : 'Recovery key (if your password was reset)'), key));
        form.append(pass.row, problem, h('div', { class: 'gate-buttons' }, lostBtn, signOut, go));
        on(form, 'submit', (event: SubmitEvent) => {
          event.preventDefault();
          go.disabled = true;
          const opening = withKey && key.value.trim() !== '' ? vault.openWithRecovery(key.value, pass.input.value) : vault.openWithPassword(pass.input.value);
          opening.then(() => finish('open'), error => {
            go.disabled = false;
            const words = error instanceof Error ? error.message : String(error);
            if (!withKey) {
              // The password did not open them: offer the recovery key as well from now on.
              withKey = true;
              draw(false, words);
              return;
            }
            problem.textContent = words;
          });
        }, signal);
      }
      panel.replaceChildren(
        brand(),
        h('h1', { id: 'gate-title' }, lost ? 'Start again?' : 'Open your files'),
        ...(lost ? [] : [h('p', { class: 'gate-intro' }, stale
          ? `${user.display}, your files are encrypted and your password was reset, so the new password cannot open them yet. Type your recovery key once; after that, your new password opens them everywhere.`
          : withKey
            ? `${user.display}, that password did not open your files. If your password was reset, type your recovery key as well; after that, the password you have now opens them everywhere.`
            : `${user.display}, your files are encrypted. Type your password to open them in this browser.`)]),
        form,
      );
      form.querySelector<HTMLInputElement>('input')?.focus();
    };
    draw(false);
  });
}
