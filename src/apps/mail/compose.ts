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
  /** The copy of this message in Drafts it was opened from: replaced when saved again, removed once sent. */
  draftUid?: number;
}

/** The most attached in one message: mail servers limit the ENCODED message (Gmail: 25 MB), and encoding adds a third, so about 18 MB of files is the real ceiling. It also keeps the server within a 128 MB PHP memory limit while it builds the message. */
const MAX_ATTACH = 18 * 1024 * 1024;
const drafts = new Map<string, { acct: MailAccount; draft: Draft; sent: string; draftsFolder: string }>();

/** `draftsFolder`: where Save draft keeps the message (the mailbox's Drafts folder); '' when it has none. */
export function openCompose(shell: Shell, acct: MailAccount, draft: Draft, sentFolder: string, draftsFolder = ''): void {
  void shell.openApp('mailcompose', stageDraft(acct, draft, sentFolder, draftsFolder));
}

/** Hands a draft to the compose code, for a window (openCompose) or for Mail's ticket layout, which runs it inline. */
export function stageDraft(acct: MailAccount, draft: Draft, sentFolder: string, draftsFolder = ''): string {
  const id = crypto.randomUUID();
  drafts.set(id, { acct, draft, sent: sentFolder, draftsFolder });
  return id;
}

/** "a@b.c, Ann <d@e.f>; "Lee, Bo" <g@h.i>" -> the addresses alone (the server checks each again). */
export function splitAddresses(text: string): string[] {
  return splitRecipients(text).map(r => r.email);
}

/**
 * The same, with the name typed before each address kept ("Dee Example <dee@example.org>" -> that name and address),
 * so the To line the other person sees still names them.
 */
export function splitRecipients(text: string): Array<{ name: string; email: string }> {
  // Split only on commas, semicolons and new lines outside a quoted name and outside <...>.
  const parts: string[] = [];
  let cur = '';
  let quoted = false;
  let angle = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted && c === '\\') {
      cur += c + (text[++i] ?? '');
      continue;
    }
    if (c === '"' && !angle) quoted = !quoted;
    else if (!quoted && c === '<') angle = true;
    else if (!quoted && c === '>') angle = false;
    if (!quoted && !angle && (c === ',' || c === ';' || c === '\n')) {
      parts.push(cur);
      cur = '';
    } else cur += c;
  }
  parts.push(cur);
  return parts.map(s => {
    const m = /^([\s\S]*?)<([^<>]+)>\s*$/.exec(s);
    if (!m) return { name: '', email: s.trim() };
    let name = m[1].trim();
    if (/^"[\s\S]*"$/.test(name)) name = name.slice(1, -1).replace(/\\(.)/g, '$1');
    return { name: name.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim(), email: m[2].trim() };
  }).filter(r => r.email);
}

/** The names typed with addresses, by address, for the server to write into the To and Cc lines. */
function namesOf(...lists: Array<Array<{ name: string; email: string }>>): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const list of lists) for (const r of list) if (r.name && !(r.email in out)) out[r.email] = r.name;
  return out;
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
      entry = { acct, draft: { to: [], cc: [], bcc: [], subject: '', text: '', attachments: [] }, sent: '', draftsFolder: '' };
    }
    const { acct, draft, sent, draftsFolder } = entry;
    const client = new MailClient(shell, acct);

    const input = (label: string, value: string) => h('input', { type: 'text', class: 'field', value, 'aria-label': label, spellcheck: false, autocomplete: 'off' });
    const to = input('To', draft.to.join(', '));
    const cc = input('Cc', draft.cc.join(', '));
    const bcc = input('Bcc', draft.bcc.join(', '));
    const subject = h('input', { type: 'text', class: 'field', value: draft.subject, 'aria-label': 'Subject' });
    const text = h('textarea', { class: 'compose-text', 'aria-label': 'Message' });
    text.value = draft.text;
    const sendBtn = h('button', { type: 'button', class: 'btn primary' }, 'Send');
    const draftBtn = h('button', { type: 'button', class: 'tool wide', title: draftsFolder ? 'Keep it in Drafts to finish later (Ctrl+S)' : 'This mailbox has no Drafts folder' }, '💾 Save draft');
    draftBtn.disabled = !draftsFolder;
    const attachBtn = h('button', { type: 'button', class: 'tool wide' }, '📎 Attach from files...');
    const atts = h('div', { class: 'compose-atts' });
    const status = h('div', { class: 'statusbar', role: 'status' }, `From ${acct.name ? `${acct.name} <${acct.email}>` : acct.email}`);
    const row = (label: string, el: HTMLElement) => h('label', { class: 'compose-row' }, h('span', {}, label), el);
    app.root.append(
      h('div', { class: 'toolbar' }, sendBtn, draftBtn, attachBtn),
      h('div', { class: 'compose-fields' }, row('To', to), row('Cc', cc), row('Bcc', bcc), row('Subject', subject)),
      atts, text, status);

    const snapshot = () => JSON.stringify([to.value, cc.value, bcc.value, subject.value, text.value, draft.attachments.length]);
    let original = snapshot();
    const changed = () => snapshot() !== original;
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
      const path = await pickFile(shell, { title: 'Attach a file', folder: '/Documents', types: [{ label: 'All files', ext: [] }] });
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

    // One send at a time: a second Ctrl+Enter (or Send) while one is being checked or sent does nothing, so a message
    // never goes twice.
    let sending = false;
    /** The fields as the server takes them, for sending or for Drafts. */
    const fields = () => {
      const r = { to: splitRecipients(to.value), cc: splitRecipients(cc.value), bcc: splitRecipients(bcc.value) };
      return {
        to: r.to.map(x => x.email), cc: r.cc.map(x => x.email), bcc: r.bcc.map(x => x.email), names: namesOf(r.to, r.cc, r.bcc),
        subject: subject.value, text: text.value, inReplyTo: draft.inReplyTo ?? '', references: draft.references ?? '',
        attachments: draft.attachments.map(a => ({ name: a.name, type: a.type, data: toBase64(a.data) })),
      };
    };
    async function saveDraft() {
      if (sending || !draftsFolder) return;
      sending = true;
      draftBtn.disabled = true;
      status.textContent = 'Saving in Drafts...';
      try {
        const res = await client.draft({ ...fields(), folder: draftsFolder, replace: draft.draftUid ?? 0 });
        if (res.uid > 0) draft.draftUid = res.uid;
        original = snapshot();
        title();
        status.textContent = `Saved in Drafts at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`;
      } catch (error) {
        status.textContent = `Not saved: ${error instanceof Error ? error.message : 'something went wrong.'}`;
      } finally {
        sending = false;
        draftBtn.disabled = false;
      }
    }
    async function send() {
      if (sending) return;
      sending = true;
      try {
        await sendOnce();
      } finally {
        sending = false;
      }
    }
    async function sendOnce() {
      const all = fields();
      if (!all.to.length && !all.cc.length && !all.bcc.length) {
        status.textContent = 'Add who it goes to.';
        to.focus();
        return;
      }
      if (!subject.value.trim() && !(await shell.dialogs.confirm({ title: 'No subject', text: 'Send without a subject?', ok: 'Send anyway' }))) return;
      sendBtn.disabled = true;
      status.textContent = `Sending${draft.attachments.length ? ` with ${plural(draft.attachments.length, 'attachment')}` : ''}...`;
      try {
        const res = await client.send({ ...all, sentFolder: sent });
        // Sent: its copy in Drafts has done its job. (If that fails, the draft stays; the message has gone either way.)
        if (draft.draftUid && draftsFolder) await client.remove(draftsFolder, [draft.draftUid], '').catch(() => undefined);
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
    on(draftBtn, 'click', () => void saveDraft(), app.signal);
    on(attachBtn, 'click', () => void attach(), app.signal);
    on(app.root, 'keydown', (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        void send();
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveDraft();
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
