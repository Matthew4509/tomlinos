// Mail's compose window: To, Cc, Bcc, subject, text, and files attached from your desktop. Sending waits for the
// sending server to accept the message before it says "Sent" (a message only handed over is not sent).
import { h, on } from '../../core/dom.ts';
import { formatSize, plural } from '../../core/format.ts';
import { baseName } from '../../fs/names.ts';
import { pickFile } from '../../shell/filepicker.ts';
import type { AppDef, Shell } from '../../shell/types.ts';
import { mediaTypeOf } from '../media.ts';
import { loadAccount, MailClient, toBase64, type MailAccount } from './account.ts';
import { APPS } from '../catalog.ts';

export interface Draft {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string;
  attachments: Array<{ name: string; type: string; data: Uint8Array }>;
}

/** The most attached in one message: mail servers limit the ENCODED message (Gmail: 25 MB), and encoding adds a third, so about 18 MB of files is the real ceiling. It also keeps the server within a 128 MB PHP memory limit while it builds the message. */
const MAX_ATTACH = 18 * 1024 * 1024;
const drafts = new Map<string, { acct: MailAccount; draft: Draft; sent: string }>();

export function openCompose(shell: Shell, acct: MailAccount, draft: Draft, sentFolder: string): void {
  void shell.openApp('mailcompose', stageDraft(acct, draft, sentFolder));
}

/** Hands a draft to the compose code, for a window (openCompose) or for Mail's ticket layout, which runs it inline. */
export function stageDraft(acct: MailAccount, draft: Draft, sentFolder: string): string {
  const id = crypto.randomUUID();
  drafts.set(id, { acct, draft, sent: sentFolder });
  return id;
}

/** "a@b.c, Ann <d@e.f>; g@h.i" -> the addresses alone (the server checks each again). */
export function splitAddresses(text: string): string[] {
  return text.split(/[,;\n]/).map(s => {
    const m = /<([^<>]+)>/.exec(s);
    return (m ? m[1] : s).trim();
  }).filter(Boolean);
}

export const composeApp: AppDef = {
  ...APPS.mailcompose,
  async launch(app, arg) {
    const shell = app.shell;
    app.root.classList.add('compose');
    let entry = arg ? drafts.get(arg) : undefined;
    if (arg) drafts.delete(arg);
    if (!entry) {
      const acct = await loadAccount(shell);
      if (!acct || !acct.password) {
        app.root.append(h('p', { class: 'app-message' }, 'Open Mail first, so it knows your mailbox.'));
        return;
      }
      entry = { acct, draft: { to: [], cc: [], bcc: [], subject: '', text: '', attachments: [] }, sent: '' };
    }
    const { acct, draft, sent } = entry;
    const client = new MailClient(shell, acct);

    const input = (label: string, value: string) => h('input', { type: 'text', class: 'field', value, 'aria-label': label, spellcheck: false, autocomplete: 'off' });
    const to = input('To', draft.to.join(', '));
    const cc = input('Cc', draft.cc.join(', '));
    const bcc = input('Bcc', draft.bcc.join(', '));
    const subject = h('input', { type: 'text', class: 'field', value: draft.subject, 'aria-label': 'Subject' });
    const text = h('textarea', { class: 'compose-text', 'aria-label': 'Message' });
    text.value = draft.text;
    const sendBtn = h('button', { type: 'button', class: 'btn primary' }, 'Send');
    const attachBtn = h('button', { type: 'button', class: 'tool wide' }, '📎 Attach from files...');
    const atts = h('div', { class: 'compose-atts' });
    const status = h('div', { class: 'statusbar', role: 'status' }, `From ${acct.name ? `${acct.name} <${acct.email}>` : acct.email}`);
    const row = (label: string, el: HTMLElement) => h('label', { class: 'compose-row' }, h('span', {}, label), el);
    app.root.append(
      h('div', { class: 'toolbar' }, sendBtn, attachBtn),
      h('div', { class: 'compose-fields' }, row('To', to), row('Cc', cc), row('Bcc', bcc), row('Subject', subject)),
      atts, text, status);

    const original = JSON.stringify([to.value, cc.value, bcc.value, subject.value, text.value, draft.attachments.length]);
    const changed = () => JSON.stringify([to.value, cc.value, bcc.value, subject.value, text.value, draft.attachments.length]) !== original;
    const title = () => {
      app.setTitle(subject.value.trim() || 'New message');
      app.setDirty(changed());
    };
    const total = () => draft.attachments.reduce((n, a) => n + a.data.length, 0);
    function paintAtts() {
      atts.replaceChildren(...draft.attachments.map((a, i) => {
        const x = h('button', { type: 'button', class: 'compose-x', 'aria-label': `Remove ${a.name}` }, '×');
        on(x, 'click', () => {
          draft.attachments.splice(i, 1);
          paintAtts();
          title();
        }, app.signal);
        return h('span', { class: 'mail-att' }, `📎 ${a.name} (${formatSize(a.data.length)})`, x);
      }));
    }

    async function attach() {
      const path = await pickFile(shell, { title: 'Attach a file', folder: '/Documents' });
      if (!path) return;
      try {
        const e = await shell.fs.stat(path);
        if (!e) return;
        if (total() + e.size > MAX_ATTACH) {
          await shell.dialogs.alert('Too much to attach', `Attachments can add up to ${formatSize(MAX_ATTACH)} in one message (mail servers such as Gmail refuse bigger messages once they are encoded for sending). This file is ${formatSize(e.size)}.`);
          return;
        }
        draft.attachments.push({ name: baseName(path), type: mediaTypeOf(path) ?? (/\.pdf$/i.test(path) ? 'application/pdf' : 'application/octet-stream'), data: await shell.fs.readFile(path) });
        paintAtts();
        title();
      } catch (error) {
        await shell.report('Could not attach the file', error);
      }
    }

    async function send() {
      const all = { to: splitAddresses(to.value), cc: splitAddresses(cc.value), bcc: splitAddresses(bcc.value) };
      if (!all.to.length && !all.cc.length && !all.bcc.length) {
        status.textContent = 'Add who it goes to.';
        to.focus();
        return;
      }
      if (!subject.value.trim() && !(await shell.dialogs.confirm({ title: 'No subject', text: 'Send without a subject?', ok: 'Send anyway' }))) return;
      sendBtn.disabled = true;
      status.textContent = `Sending${draft.attachments.length ? ` with ${plural(draft.attachments.length, 'attachment')}` : ''}...`;
      try {
        const res = await client.send({
          ...all, subject: subject.value, text: text.value, inReplyTo: draft.inReplyTo ?? '', references: draft.references ?? '', sentFolder: sent,
          attachments: draft.attachments.map(a => ({ name: a.name, type: a.type, data: toBase64(a.data) })),
        });
        shell.toast(`Sent to ${plural(res.recipients, 'address', 'addresses')}.${res.copy.startsWith('failed') ? ' (A copy could not be put in Sent.)' : ''}`);
        app.setDirty(false);
        app.close();
      } catch (error) {
        status.textContent = `Not sent: ${error instanceof Error ? error.message : 'something went wrong.'} Your message is still here.`;
        sendBtn.disabled = false;
      }
    }

    for (const el of [to, cc, bcc, subject, text]) on(el, 'input', title, app.signal);
    on(sendBtn, 'click', () => void send(), app.signal);
    on(attachBtn, 'click', () => void attach(), app.signal);
    on(app.root, 'keydown', (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        void send();
      }
    }, app.signal);
    paintAtts();
    title();
    if (!to.value) to.focus();
    else {
      text.focus();
      text.setSelectionRange(0, 0);
    }
  },
};
