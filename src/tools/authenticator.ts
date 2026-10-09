// The 2FA emulator: a stand-in for an authenticator app, for trying two-step sign-in without a phone. Paste the key (or
// the otpauth:// link) that My account shows, and it shows the same 6-digit codes a phone would, changing every 30 s.
// Keys are kept in this page's memory only and are gone when it closes: nothing is written to the browser's storage,
// because this page shares the desktop's site. It is a testing tool: codes made on the same computer that holds the
// password are not a second factor, so real accounts belong in an app on a phone.
import { h, on } from '../core/dom.ts';
import { base32Decode, parseOtpauth, totpNow } from '../core/totp.ts';

interface Entry {
  label: string;
  secret: string;
}

function start(root: HTMLElement): void {
  const signal = new AbortController().signal;
  let entries: Entry[] = [];
  const keyIn = h('input', { type: 'text', class: 'em-field', spellcheck: 'false', autocomplete: 'off', placeholder: 'JBSW Y3DP EHPK 3PXP... or otpauth://totp/...' });
  const labelIn = h('input', { type: 'text', class: 'em-field', maxlength: 60, placeholder: 'TOMLIN OS (alex)' });
  const problem = h('p', { class: 'em-problem', role: 'alert' });
  const add = h('button', { type: 'submit', class: 'em-btn primary' }, 'Add');
  const list = h('ul', { class: 'em-list', 'aria-live': 'off' });
  const empty = h('p', { class: 'em-empty' }, 'No keys yet. In TOMLIN OS, open My account, choose Turn on under Two-step sign-in, and paste the key it shows (or the link) here.');
  const form = h('form', { class: 'em-add' },
    h('label', {}, h('span', {}, 'Key or setup link'), keyIn),
    h('label', {}, h('span', {}, 'Name (optional)'), labelIn),
    problem, add);

  on(form, 'submit', (event: SubmitEvent) => {
    event.preventDefault();
    const text = keyIn.value.trim();
    const link = parseOtpauth(text);
    const secret = (link?.secret ?? text).replace(/[\s-]/g, '').toUpperCase();
    try {
      if (base32Decode(secret).length < 10) throw new Error('That key is too short. A two-step key is usually 16 or 32 letters and numbers.');
    } catch (error) {
      problem.textContent = error instanceof Error ? error.message : String(error);
      return;
    }
    const label = labelIn.value.trim() || (link ? `${link.issuer || 'Account'}${link.account ? ` (${link.account})` : ''}` : 'Account');
    entries = [...entries.filter(e => e.secret !== secret), { label, secret }].slice(-50);
    problem.textContent = '';
    keyIn.value = '';
    labelIn.value = '';
    draw();
  }, signal);

  const rows = new Map<string, { code: HTMLElement; bar: HTMLElement }>();
  function draw(): void {
    rows.clear();
    list.replaceChildren(...entries.map(e => {
      const code = h('div', { class: 'em-code' }, '------');
      const bar = h('div', { class: 'em-bar' });
      const copy = h('button', { type: 'button', class: 'em-btn' }, 'Copy');
      const remove = h('button', { type: 'button', class: 'em-btn' }, 'Remove');
      on(copy, 'click', () => void navigator.clipboard.writeText(code.textContent?.replace(/\s/g, '') ?? '').then(() => (copy.textContent = 'Copied'), () => (copy.textContent = 'Select it'))
        .finally(() => window.setTimeout(() => (copy.textContent = 'Copy'), 1500)), signal);
      on(remove, 'click', () => {
        entries = entries.filter(x => x !== e);
        draw();
      }, signal);
      rows.set(e.secret, { code, bar });
      return h('li', { class: 'em-item' }, h('div', { class: 'em-label' }, e.label), code, h('div', { class: 'em-track' }, bar), h('div', { class: 'em-actions' }, copy, remove));
    }));
    empty.hidden = entries.length > 0;
    void tick();
  }

  async function tick(): Promise<void> {
    for (const e of entries) {
      const row = rows.get(e.secret);
      if (!row) continue;
      try {
        const { code, left } = await totpNow(e.secret);
        row.code.textContent = `${code.slice(0, 3)} ${code.slice(3)}`;
        row.bar.style.setProperty('width', `${(left / 30) * 100}%`);
        row.bar.classList.toggle('low', left <= 5);
      } catch {
        row.code.textContent = 'bad key';
      }
    }
  }
  window.setInterval(() => void tick(), 1000);

  root.replaceChildren(
    h('main', { class: 'em-phone' },
      h('h1', {}, '2FA Emulator'),
      h('p', { class: 'em-warn' }, 'For testing TOMLIN OS two-step sign-in without a phone. Keys are forgotten when this page closes (nothing is saved). For real use, add the key to an authenticator app on your phone instead: codes made on the same computer as your password do not protect it.'),
      list, empty, form));
  draw();
}

const root = document.getElementById('root');
if (root) start(root);
