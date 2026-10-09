// Mail: read and send email from your own mailbox (IMAP and SMTP, through the desktop's server). Folders on the left,
// messages in the middle, the open message on the right. HTML mail is shown through safehtml.ts (no scripts, no styles,
// no pictures from the web); attachments save into your files. Settings and the password: see mail/account.ts.
//
// Inside the Panel (launched with "panel") Mail takes the shape of a help-desk ticket screen: folder tabs over the
// list, the open message
// under the list, a new message written in that same place, and a column on the right with your Contacts (click one
// to write to them) and what you sent last. It is your real mailbox: nothing of a help desk's make-believe comes across
// (no invented priorities, nothing answers on your behalf).
import { AuthFailure } from '../auth/api.ts';
import { h, on } from '../core/dom.ts';
import { formatSize, plural } from '../core/format.ts';
import { pickSave } from '../shell/filepicker.ts';
import type { AppDef, AppHandle } from '../shell/types.ts';
import { fromBase64, loadAccount, MailClient, PRESETS, rememberForNow, saveAccount, forgetAccount, type FolderRow, type MailAccount, type Security } from './mail/account.ts';
import { composeApp, openCompose, stageDraft, type Draft } from './mail/compose.ts';
import { parseMessage, quoteForReply, replySubject, showAddress, summary, type Message } from './mail/mime.ts';
import { safeHtml } from './mail/safehtml.ts';
import { APPS } from './catalog.ts';
import { CONTACTS_PATH } from './contacts.ts';
import { parseVcf } from '../core/vcard.ts';
import { parseInert } from '../core/inert.ts';

interface Row {
  uid: number;
  seen: boolean;
  flagged: boolean;
  size: number;
  from: string;
  to: string;
  subject: string;
  date: Date | null;
  attachment: boolean;
}

const USE_ORDER = ['inbox', 'drafts', 'sent', 'archive', 'junk', 'trash'];
const USE_NAMES: Record<string, string> = { inbox: 'Inbox', drafts: 'Drafts', sent: 'Sent', archive: 'Archive', junk: 'Junk', trash: 'Deleted' };
/** Mail windows showing the ticket layout (opened inside the Panel). */
const TICKET = new WeakSet<AppHandle>();
/** How many of the last sent messages the ticket layout lists on the right. */
const SENT_PEEK = 5;

export const mailApp: AppDef = {
  ...APPS.mail,
  async launch(app, arg) {
    app.root.classList.add('mail');
    if (arg === 'panel') {
      TICKET.add(app);
      app.root.classList.add('ticket');
    }
    if (!app.shell.account) {
      app.root.append(h('p', { class: 'app-message' }, 'Mail works when the desktop runs on its server (it fetches your mail there). This copy keeps its files in the browser only.'));
      return;
    }
    const acct = await loadAccount(app.shell);
    if (!acct) return setup(app, null);
    if (!acct.password && !(await askPassword(app, acct))) return setup(app, acct);
    await run(app, acct);
  },
};

/** Asks for a password that is not remembered. False when cancelled. */
async function askPassword(app: AppHandle, acct: MailAccount): Promise<boolean> {
  const input = h('input', { type: 'password', class: 'field', autocomplete: 'current-password', 'aria-label': 'Mailbox password' });
  const ok = await app.shell.dialogs.ask({
    title: 'Mailbox password',
    body: h('div', {}, h('p', { class: 'dialog-text' }, `The password for ${acct.email}. It is kept in this page's memory until you sign out.`), h('label', { class: 'dialog-label' }, 'Password', input)),
    buttons: [{ label: 'Open mail', value: true, primary: true }, { label: 'Mail settings', value: false }],
    cancel: false,
    primaryEnabled: () => input.value !== '',
    focus: () => input,
  });
  if (ok) rememberForNow(acct, input.value);
  return ok;
}

// ---- Setting up a mailbox ------------------------------------------------------------------------------------------

function setup(app: AppHandle, existing: MailAccount | null): void {
  const shell = app.shell;
  app.setTitle('Mail - set up');
  const field = (label: string, input: HTMLElement, hint?: string) => h('label', { class: 'mail-field' }, h('span', {}, label), input, hint ? h('small', {}, hint) : null);
  const preset = h('select', { class: 'field', 'aria-label': 'Provider' }, ...PRESETS.map(p => h('option', { value: p.id }, p.label)));
  const name = h('input', { type: 'text', class: 'field', value: existing?.name ?? '', autocomplete: 'name' });
  const email = h('input', { type: 'email', class: 'field', value: existing?.email ?? '', autocomplete: 'email' });
  const user = h('input', { type: 'text', class: 'field', value: existing?.user ?? '', autocomplete: 'username', spellcheck: false });
  const password = h('input', { type: 'password', class: 'field', value: existing?.password ?? '', autocomplete: 'current-password' });
  const remember = h('input', { type: 'checkbox', checked: existing?.remember ?? true });
  const sec = (v: Security) => h('select', { class: 'field' }, h('option', { value: 'ssl', selected: v === 'ssl' }, 'SSL/TLS'), h('option', { value: 'starttls', selected: v === 'starttls' }, 'STARTTLS'), h('option', { value: 'none', selected: v === 'none' }, 'None (own network only)'));
  const iHost = h('input', { type: 'text', class: 'field', value: existing?.imap.host ?? '', spellcheck: false });
  const iPort = h('input', { type: 'number', class: 'field num', value: existing?.imap.port ?? 993 });
  const iSec = sec(existing?.imap.security ?? 'ssl');
  const sHost = h('input', { type: 'text', class: 'field', value: existing?.smtp.host ?? '', spellcheck: false });
  const sPort = h('input', { type: 'number', class: 'field num', value: existing?.smtp.port ?? 465 });
  const sSec = sec(existing?.smtp.security ?? 'ssl');
  const note = h('p', { class: 'mail-note' });
  const result = h('div', { class: 'mail-test', role: 'status' });
  const testBtn = h('button', { type: 'button', class: 'btn primary' }, 'Test and save');
  const cancelBtn = existing ? h('button', { type: 'button', class: 'btn' }, 'Back to mail') : null;
  let savesSent = existing?.providerSavesSent ?? false;
  let userTouched = !!existing;

  const applyPreset = () => {
    const p = PRESETS.find(x => x.id === preset.value)!;
    const domain = email.value.split('@')[1] ?? '';
    iHost.value = p.imap.host === 'mail.' ? `mail.${domain}` : p.imap.host;
    sHost.value = p.smtp.host === 'mail.' ? `mail.${domain}` : p.smtp.host;
    iPort.value = String(p.imap.port);
    sPort.value = String(p.smtp.port);
    iSec.value = p.imap.security;
    sSec.value = p.smtp.security;
    savesSent = !!p.providerSavesSent;
    note.textContent = p.note;
    note.classList.toggle('warn', !!p.blocked);
    testBtn.disabled = !!p.blocked;
  };
  const guessPreset = () => {
    const d = (email.value.split('@')[1] ?? '').toLowerCase();
    const id = /gmail|googlemail/.test(d) ? 'gmail' : /yahoo|ymail/.test(d) ? 'yahoo' : /icloud|me\.com|mac\.com/.test(d) ? 'icloud' : /outlook|hotmail|live\.|msn\./.test(d) ? 'outlook' : 'own';
    if (preset.value !== id) {
      preset.value = id;
    }
    applyPreset();
  };

  const form = h('div', { class: 'mail-setup' },
    h('h2', {}, existing ? 'Mail settings' : 'Set up your mailbox'),
    h('p', { class: 'hint' }, 'TOMLIN OS Mail reads your existing mailbox (IMAP) and sends through it (SMTP). Your mail stays with your provider; nothing is copied into your files.'),
    field('Your name (shown to people you write to)', name),
    field('Email address', email),
    field('Provider', preset),
    note,
    field('User name (usually the whole email address)', user),
    field('Password', password),
    h('label', { class: 'check-row' }, remember, ' Remember the password in my files (sealed with my key when file encryption is on). Untick to type it each time you open Mail.'),
    h('details', { class: 'mail-adv', open: !!existing },
      h('summary', {}, 'Server settings'),
      h('div', { class: 'mail-servers' },
        h('strong', {}, 'Incoming (IMAP)'), field('Server', iHost), field('Port', iPort), field('Security', iSec),
        h('strong', {}, 'Sending (SMTP)'), field('Server', sHost), field('Port', sPort), field('Security', sSec))),
    h('div', { class: 'row-buttons' }, testBtn, cancelBtn),
    result);
  app.root.replaceChildren(form);
  if (!existing) applyPreset();
  else note.textContent = '';

  on(email, 'input', () => {
    if (!userTouched) user.value = email.value;
    guessPreset();
  }, app.signal);
  on(user, 'input', () => (userTouched = true), app.signal);
  on(preset, 'change', applyPreset, app.signal);
  if (cancelBtn) on(cancelBtn, 'click', () => void run(app, existing!), app.signal);
  on(testBtn, 'click', async () => {
    const acct: MailAccount = {
      name: name.value.trim(), email: email.value.trim(), user: user.value.trim() || email.value.trim(), password: password.value, remember: remember.checked,
      imap: { host: iHost.value.trim().toLowerCase(), port: Number(iPort.value), security: iSec.value as Security },
      smtp: { host: sHost.value.trim().toLowerCase(), port: Number(sPort.value), security: sSec.value as Security },
      providerSavesSent: savesSent,
    };
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(acct.email)) return void (result.textContent = 'Type your whole email address.');
    if (!acct.password) return void (result.textContent = 'Type the mailbox password.');
    if (!acct.imap.host || !acct.smtp.host) return void (result.textContent = 'Fill in both servers under Server settings.');
    testBtn.disabled = true;
    result.textContent = 'Signing in to both servers...';
    try {
      const t = await new MailClient(shell, acct).test();
      const line = (what: string, r: { ok: boolean; error?: string }) => h('p', { class: r.ok ? 'ok' : 'bad' }, `${r.ok ? '✓' : '✗'} ${what}: ${r.ok ? 'signed in' : r.error}`);
      result.replaceChildren(line('Reading mail (IMAP)', t.imap), line('Sending mail (SMTP)', t.smtp));
      if (t.imap.ok) {
        await saveAccount(shell, acct);
        if (!t.smtp.ok) result.append(h('p', {}, 'Saved. Reading works; sending will not until the sending server is fixed here.'));
        await run(app, acct);
      }
    } catch (error) {
      result.textContent = error instanceof Error ? error.message : 'The test did not finish.';
    } finally {
      testBtn.disabled = false;
    }
  }, app.signal);
  (existing ? password : email).focus();
}

// ---- Reading -------------------------------------------------------------------------------------------------------

async function run(app: AppHandle, acct: MailAccount): Promise<void> {
  const shell = app.shell;
  const client = new MailClient(shell, acct);
  let folders: FolderRow[] = [];
  let folder: FolderRow | null = null;
  let rows: Row[] = [];
  let more = false;
  let selected: number | null = null;
  let open: { uid: number; msg: Message; folder: string } | null = null;
  let query = '';
  /** Messages in the folder (or matching the search), as the server counted them; -1 before the first answer. */
  let total = -1;
  let listing: AbortController | null = null;
  const urls: string[] = [];
  app.signal.addEventListener('abort', () => urls.forEach(u => URL.revokeObjectURL(u)), { once: true });

  const tool = (label: string, title: string) => h('button', { type: 'button', class: 'tool wide', title }, label);
  const newBtn = tool('✉ New', 'Write a new message (Ctrl+N)');
  const replyBtn = tool('Reply', 'Reply to the sender (Ctrl+R)');
  const replyAllBtn = tool('Reply all', 'Reply to everyone (Ctrl+Shift+R)');
  const fwdBtn = tool('Forward', 'Forward (Ctrl+F)');
  const delBtn = tool('Delete', 'Move to Deleted (Delete)');
  const readBtn = tool('Mark unread', 'Mark read or unread (Ctrl+U)');
  const flagBtn = tool('☆ Flag', 'Flag for follow-up');
  const moveBtn = tool('Move to ▾', 'Move to another folder');
  const refreshBtn = tool('⟳', 'Check for new mail (F5)');
  refreshBtn.setAttribute('aria-label', 'Check for new mail');
  const search = h('input', { type: 'search', class: 'field mail-search', placeholder: 'Search this folder', 'aria-label': 'Search this folder' });
  const settingsBtn = tool('Settings', 'Mailbox settings');
  const ticket = TICKET.has(app);
  const folderList = ticket ? h('div', { class: 'mail-tabs', role: 'tablist', 'aria-label': 'Folders' }) : h('div', { class: 'mail-folders', role: 'tree', 'aria-label': 'Folders' });
  const list = h('div', { class: 'mail-list', role: 'listbox', 'aria-label': 'Messages', tabindex: '0' });
  const reader = h('div', { class: 'mail-reader', tabindex: '0', 'aria-label': 'Message' });
  const status = h('div', { class: 'statusbar', role: 'status' });
  const bar = h('div', { class: 'toolbar mail-bar' }, newBtn, replyBtn, replyAllBtn, fwdBtn, delBtn, readBtn, flagBtn, moveBtn, refreshBtn, search, settingsBtn);
  // The ticket layout's parts: the open message (or a message being written) sits under the list; Contacts and Sent
  // are on the right, where a help desk keeps its phone directory and sent messages.
  const readerWrap = h('div', { class: 'mail-open' }, reader);
  const contactsBox = h('div', { class: 'mail-side-list' });
  const sentBox = h('div', { class: 'mail-side-list' });
  if (ticket) {
    app.root.replaceChildren(bar,
      h('div', { class: 'mail-ticket' },
        h('div', { class: 'mail-ticket-main' }, folderList, list, readerWrap),
        h('aside', { class: 'mail-ticket-side', 'aria-label': 'Contacts and sent messages' },
          h('section', { class: 'mail-card' }, h('header', {}, h('h3', {}, 'Contacts')), contactsBox),
          h('section', { class: 'mail-card' }, h('header', {}, h('h3', {}, 'Sent')), sentBox))),
      status);
  } else {
    app.root.replaceChildren(bar, h('div', { class: 'mail-body' }, folderList, list, reader), status);
  }
  app.setTitle(`Mail - ${acct.email}`);

  const fail = async (error: unknown, what: string) => {
    if (error instanceof AuthFailure && (error.signedOut || error.locked)) return void shell.account?.signOut(error.message);
    const text = error instanceof Error ? error.message : 'Something went wrong.';
    status.textContent = `${what}: ${text}`;
    if (error instanceof AuthFailure && /refused the name or password/.test(text)) {
      if (await shell.dialogs.confirm({ title: 'Mailbox password', text: `${text}\n\nOpen the mail settings to fix it?`, ok: 'Mail settings' })) setup(app, acct);
    }
  };

  // ---- Folders ----
  const folderLabel = (f: FolderRow) => (f.use && USE_NAMES[f.use] ? USE_NAMES[f.use] : f.name.split(f.delim || '/').pop() || f.name);
  function paintFolders() {
    const sorted = [...folders].sort((a, b) => {
      const ra = a.use ? USE_ORDER.indexOf(a.use) : -1;
      const rb = b.use ? USE_ORDER.indexOf(b.use) : -1;
      return (ra < 0 ? 99 : ra) - (rb < 0 ? 99 : rb) || a.name.localeCompare(b.name);
    });
    if (ticket) {
      // The usual folders as tabs, in the usual order; any others under More (and the one open, if it is one of them).
      const main = sorted.filter(f => f.use && USE_ORDER.includes(f.use));
      const others = sorted.filter(f => !main.includes(f));
      const tab = (f: FolderRow) => {
        const b = h('button', { type: 'button', class: `mail-tab${f === folder ? ' on' : ''}`, role: 'tab', 'aria-selected': String(f === folder), title: f.name },
          folderLabel(f), f.unread ? h('span', { class: 'mail-count' }, String(f.unread)) : null);
        on(b, 'click', () => void choose(f), app.signal);
        return b;
      };
      const tabs = main.map(tab);
      if (folder && others.includes(folder)) tabs.push(tab(folder));
      if (others.length) {
        const more = h('button', { type: 'button', class: 'mail-tab more', 'aria-haspopup': 'menu' }, 'More ▾');
        on(more, 'click', () => {
          const r = more.getBoundingClientRect();
          shell.menus.show(others.map(f => ({ label: f.name, action: () => void choose(f) })), r.left, r.bottom, { returnFocus: more });
        }, app.signal);
        tabs.push(more);
      }
      folderList.replaceChildren(...tabs);
      return;
    }
    folderList.replaceChildren(...sorted.map(f => {
      const depth = f.use ? 0 : Math.max(0, f.name.split(f.delim || '/').length - 1);
      const b = h('button', { type: 'button', class: `mail-folder${f === folder ? ' on' : ''}`, role: 'treeitem', 'aria-selected': String(f === folder), title: f.name },
        h('span', { class: 'mail-folder-name' }, folderLabel(f)), f.unread ? h('span', { class: 'mail-count' }, String(f.unread)) : null);
      b.style.paddingLeft = `${8 + depth * 12}px`;
      on(b, 'click', () => void choose(f), app.signal);
      return b;
    }));
  }
  const byUse = (use: string) => folders.find(f => f.use === use) ?? folders.find(f => new RegExp(`^(${use === 'trash' ? 'trash|deleted( items| messages)?|bin' : use === 'sent' ? 'sent( items| messages| mail)?' : use === 'junk' ? 'junk|spam' : use})$`, 'i').test(f.name.split(f.delim || '/').pop() ?? ''));

  async function loadFolders() {
    try {
      folders = (await client.folders()).folders;
      // Special folders a server does not mark are found by their usual names.
      for (const use of ['sent', 'trash', 'junk', 'drafts']) {
        const f = byUse(use);
        if (f && !f.use) f.use = use;
      }
      paintFolders();
    } catch (error) {
      await fail(error, 'The folders could not be read');
    }
  }

  // ---- Messages ----
  const toRow = (r: { uid: number; flags: string[]; size: number; date: string; head: string }): Row => {
    const s = summary(r.head);
    return {
      uid: r.uid, seen: r.flags.includes('\\Seen'), flagged: r.flags.includes('\\Flagged'), size: r.size,
      from: s.from.map(a => a.name || a.email).join(', ') || '(no sender)', to: s.to.map(a => a.name || a.email).join(', '),
      subject: s.subject || '(no subject)', date: s.date ?? (r.date ? new Date(r.date) : null), attachment: s.attachment,
    };
  };
  const when = (d: Date | null) => {
    if (!d || Number.isNaN(d.getTime())) return '';
    const now = new Date();
    return d.toDateString() === now.toDateString() ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.getFullYear() === now.getFullYear() ? d.toLocaleDateString([], { day: 'numeric', month: 'short' }) : d.toLocaleDateString();
  };

  function paintList() {
    const sent = folder?.use === 'sent' || folder?.use === 'drafts';
    list.replaceChildren(...rows.map(r => {
      const el = h('div', { class: `mail-row${r.seen ? '' : ' unread'}${r.uid === selected ? ' on' : ''}`, role: 'option', 'aria-selected': String(r.uid === selected), tabindex: '-1', 'data-uid': String(r.uid) },
        h('div', { class: 'mail-row-top' }, h('span', { class: 'mail-who' }, sent ? `To: ${r.to}` : r.from), h('span', { class: 'mail-when' }, when(r.date))),
        h('div', { class: 'mail-row-sub' }, r.flagged ? h('span', { class: 'mail-flag', title: 'Flagged' }, '★') : null, r.attachment ? h('span', { title: 'Has attachments' }, '📎') : null, h('span', { class: 'mail-subj' }, r.subject)));
      on(el, 'click', () => void openMessage(r.uid), app.signal);
      return el;
    }));
    if (more) {
      const older = h('button', { type: 'button', class: 'btn mail-more' }, 'Show older messages');
      on(older, 'click', () => void loadList(true), app.signal);
      list.append(older);
    }
    if (!rows.length) list.append(h('p', { class: 'mail-empty' }, query ? `Nothing matches “${query}”.` : 'No messages here.'));
    refreshTools();
  }

  /** The folder's counts in the status line (after loading, and when a message is read or marked unread). */
  function showCounts() {
    if (folder && total >= 0) status.textContent = `${folderLabel(folder)}: ${plural(total, 'message')}${folder.unread ? `, ${folder.unread} unread` : ''}${query ? ` matching “${query}”` : ''}.`;
  }

  async function loadList(older = false) {
    if (!folder) return;
    listing?.abort();
    const ctl = new AbortController();
    listing = ctl;
    status.textContent = older ? 'Loading older messages...' : `Opening ${folderLabel(folder)}...`;
    try {
      const before = older && rows.length ? Math.min(...rows.map(r => r.uid)) : 0;
      const res = await client.list(folder.raw, before, query, ctl.signal);
      if (ctl.signal.aborted) return;
      const got = res.rows.map(toRow);
      rows = older ? [...rows, ...got] : got;
      more = res.more;
      total = res.total;
      paintList();
      showCounts();
    } catch (error) {
      if ((error as Error).name !== 'AbortError') await fail(error, 'The messages could not be read');
    }
  }

  async function choose(f: FolderRow) {
    if (!(await leaveCompose())) return;
    folder = f;
    selected = null;
    open = null;
    rows = [];
    total = -1;
    query = '';
    search.value = '';
    paintFolders();
    paintList();
    paintReader();
    await loadList();
  }

  // ---- The open message ----
  function paintReader() {
    if (!open) {
      reader.replaceChildren(h('p', { class: 'mail-empty' }, rows.length ? 'Choose a message to read it.' : ''));
      return;
    }
    const m = open.msg;
    const line = (label: string, value: string) => (value ? h('div', { class: 'mail-hline' }, h('span', {}, label), h('span', {}, value)) : null);
    const pics = new Map<string, string>();
    for (const a of m.attachments) {
      if (a.cid && a.type.startsWith('image/') && /^image\/(png|jpeg|gif|webp)$/.test(a.type)) {
        const u = URL.createObjectURL(new Blob([a.data as BlobPart], { type: a.type }));
        urls.push(u);
        pics.set(a.cid, u);
      }
    }
    const body = h('div', { class: 'mail-text' });
    let blockedNote: HTMLElement | null = null;
    const showText = () => body.replaceChildren(...linkify(m.text ?? '(This message has no text.)'));
    if (m.html) {
      const safe = safeHtml(m.html, document, pics);
      body.classList.add('html');
      body.replaceChildren(safe.fragment);
      if (safe.blocked) blockedNote = h('p', { class: 'mail-blocked' }, `${plural(safe.blocked, 'picture')} from the web ${safe.blocked === 1 ? 'was' : 'were'} not loaded (they can tell the sender when you read this).`);
    } else showText();
    const toggle = m.html && m.text ? h('button', { type: 'button', class: 'tool wide' }, 'Show plain text') : null;
    if (toggle) {
      on(toggle, 'click', () => {
        const plain = toggle.textContent === 'Show plain text';
        body.classList.toggle('html', !plain);
        if (plain) showText();
        else body.replaceChildren(safeHtml(m.html!, document, pics).fragment);
        toggle.textContent = plain ? 'Show formatted' : 'Show plain text';
      }, app.signal);
    }
    const files = m.attachments.filter(a => !(a.inline && pics.has(a.cid ?? '')));
    const chips = files.map(a => {
      const b = h('button', { type: 'button', class: 'mail-att', title: `Save “${a.name}” to your files` }, `📎 ${a.name} (${formatSize(a.data.length)})`);
      on(b, 'click', () => void saveAttachment(a.name, a.data), app.signal);
      return b;
    });
    reader.replaceChildren(
      h('div', { class: 'mail-head' },
        h('h2', {}, m.subject || '(no subject)'),
        line('From', m.from.map(showAddress).join(', ')),
        line('To', m.to.map(showAddress).join(', ')),
        line('Cc', m.cc.map(showAddress).join(', ')),
        line('Date', m.date ? m.date.toLocaleString() : ''),
        toggle),
      ...(chips.length ? [h('div', { class: 'mail-atts' }, ...chips)] : []),
      ...(blockedNote ? [blockedNote] : []),
      body);
    reader.scrollTop = 0;
  }

  async function saveAttachment(name: string, data: Uint8Array) {
    const target = await pickSave(shell, { title: 'Save attachment', folder: '/Documents', name });
    if (!target) return;
    try {
      const entry = await shell.fs.writeFile(target.path, data, target.replace ? {} : { mustBeNew: true });
      shell.toast(`Saved “${entry.name}”.`, { label: 'Open', run: () => void shell.openPath(target.path) });
    } catch (error) {
      await shell.report('Could not save the attachment', error);
    }
  }

  async function openMessage(uid: number) {
    if (!folder || !(await leaveCompose())) return;
    selected = uid;
    paintList();
    reader.replaceChildren(h('p', { class: 'mail-empty' }, 'Opening...'));
    try {
      const f = folder.raw;
      const res = await client.message(f, uid);
      if (selected !== uid) return;
      open = { uid, msg: parseMessage(fromBase64(res.raw)), folder: f };
      const row = rows.find(r => r.uid === uid);
      if (row && !row.seen) {
        row.seen = true;
        if (folder.unread) folder.unread--;
        paintFolders();
        paintList();
        showCounts();
      }
      paintReader();
      // Reply and Forward follow the open message; a message already read changes no row, so nothing else asks.
      refreshTools();
    } catch (error) {
      await fail(error, 'The message could not be opened');
      reader.replaceChildren(h('p', { class: 'mail-empty' }, 'This message could not be opened.'));
    }
  }

  // ---- Actions ----
  function refreshTools() {
    const has = selected !== null;
    for (const b of [replyBtn, replyAllBtn, fwdBtn]) b.disabled = !open || open.uid !== selected;
    for (const b of [delBtn, readBtn, flagBtn, moveBtn]) b.disabled = !has;
    const row = rows.find(r => r.uid === selected);
    readBtn.textContent = row && !row.seen ? 'Mark read' : 'Mark unread';
    flagBtn.textContent = row?.flagged ? '★ Unflag' : '☆ Flag';
  }

  function compose(kind: 'new' | 'reply' | 'all' | 'forward') {
    const draft: Draft = { to: [], cc: [], bcc: [], subject: '', text: '', attachments: [] };
    if (kind !== 'new' && open) {
      const m = open.msg;
      const plain = m.text ?? (m.html ? parseInert(m.html).body.textContent ?? '' : '');
      if (kind === 'forward') {
        draft.subject = replySubject(m.subject, true);
        draft.text = `\n\n---------- Forwarded message ----------\nFrom: ${m.from.map(showAddress).join(', ')}\nDate: ${m.date?.toLocaleString() ?? ''}\nSubject: ${m.subject}\nTo: ${m.to.map(showAddress).join(', ')}\n\n${plain}`;
        draft.attachments = m.attachments.filter(a => !a.inline).map(a => ({ name: a.name, type: a.type, data: a.data }));
      } else {
        const me = acct.email.toLowerCase();
        const replyTo = m.replyTo.length ? m.replyTo : m.from;
        draft.to = replyTo.map(showAddress);
        if (kind === 'all') {
          const seen = new Set(replyTo.map(a => a.email.toLowerCase()));
          draft.cc = [...m.to, ...m.cc].filter(a => a.email.toLowerCase() !== me && !seen.has(a.email.toLowerCase())).map(showAddress);
        }
        draft.subject = replySubject(m.subject);
        draft.text = quoteForReply(m, plain);
        draft.inReplyTo = m.messageId;
        draft.references = m.references;
      }
    }
    if (ticket) void composeInline(draft);
    else openCompose(shell, acct, draft, folders.find(f => f.use === 'sent')?.raw ?? '');
  }

  // ---- Writing in place (ticket layout) ----
  // The compose code is the same as the New message window's; it is given this spot instead of a window.
  let composing: { ctl: AbortController; area: HTMLElement; dirty: boolean } | null = null;
  function endCompose() {
    if (!composing) return;
    composing.ctl.abort();
    composing.area.remove();
    composing = null;
    reader.hidden = false;
    app.setDirty(false);
  }
  /** Leaves the message being written, asking first if anything was typed. False: they chose to keep writing. */
  async function leaveCompose(): Promise<boolean> {
    if (!composing) return true;
    if (composing.dirty && !(await shell.dialogs.confirm({ title: 'Discard this message?', text: 'The message you are writing has not been sent. If you leave it, it is lost.', ok: 'Discard it', danger: true, cancel: 'Keep writing' }))) return false;
    endCompose();
    return true;
  }
  async function composeInline(draft: Draft) {
    if (!(await leaveCompose())) return;
    const ctl = new AbortController();
    app.signal.addEventListener('abort', () => ctl.abort(), { once: true, signal: ctl.signal });
    const heading = h('b', {}, 'New message');
    const discard = h('button', { type: 'button', class: 'tool wide' }, 'Discard');
    const body = h('div', { class: 'mail-compose-body' });
    const area = h('div', { class: 'mail-compose' }, h('div', { class: 'mail-compose-head' }, heading, discard), body);
    const mine = { ctl, area, dirty: false };
    composing = mine;
    on(discard, 'click', () => void leaveCompose(), ctl.signal);
    reader.hidden = true;
    readerWrap.append(area);
    const handle: AppHandle = {
      id: `${app.id}-compose`,
      root: body,
      signal: ctl.signal,
      shell,
      setTitle: t => (heading.textContent = t),
      setIcon: () => undefined,
      setWidth: () => undefined,
      // Sent: back to the message that was open, and the Sent column shows it.
      close: () => {
        if (composing === mine) endCompose();
        void loadSent();
      },
      setDirty: d => {
        mine.dirty = d;
        app.setDirty(d);
      },
      onClose: () => undefined,
    };
    await composeApp.launch(handle, stageDraft(acct, draft, folders.find(f => f.use === 'sent')?.raw ?? ''));
  }

  // ---- The right-hand column (ticket layout) ----
  async function loadContacts() {
    let people: ReturnType<typeof parseVcf> = [];
    try {
      people = parseVcf(await shell.fs.readText(CONTACTS_PATH));
    } catch {
      people = [];
    }
    const withMail = people.filter(p => p.emails.length).sort((a, b) => (a.name || a.emails[0]).localeCompare(b.name || b.emails[0], undefined, { sensitivity: 'base' }));
    contactsBox.replaceChildren(...withMail.map(p => {
      const address = p.emails[0];
      const b = h('button', { type: 'button', class: 'mail-side-row', title: `Write to ${address}` }, h('b', {}, p.name || address), h('span', { class: 'mail-side-sub' }, address));
      on(b, 'click', () => void composeInline({ to: [p.name ? `${p.name} <${address}>` : address], cc: [], bcc: [], subject: '', text: '', attachments: [] }), app.signal);
      return b;
    }));
    if (!withMail.length) contactsBox.append(h('p', { class: 'mail-empty' }, people.length ? 'None of your contacts has an email address yet.' : 'No contacts yet. People you add in Contacts with an email address appear here.'));
  }

  async function loadSent() {
    if (!ticket) return;
    const sentFolder = folders.find(f => f.use === 'sent');
    if (!sentFolder) {
      sentBox.replaceChildren(h('p', { class: 'mail-empty' }, 'This mailbox has no Sent folder.'));
      return;
    }
    try {
      const got = (await client.list(sentFolder.raw, 0, '')).rows.slice(0, SENT_PEEK).map(toRow);
      sentBox.replaceChildren(...got.map(r => {
        const b = h('button', { type: 'button', class: 'mail-side-row' }, h('b', {}, r.subject), h('span', { class: 'mail-side-sub' }, `To ${r.to || '(nobody)'} · ${when(r.date)}`));
        on(b, 'click', async () => {
          if (folder !== sentFolder) await choose(sentFolder);
          if (folder === sentFolder) await openMessage(r.uid);
        }, app.signal);
        return b;
      }));
      if (!got.length) sentBox.append(h('p', { class: 'mail-empty' }, 'Nothing sent yet.'));
    } catch {
      sentBox.replaceChildren(h('p', { class: 'mail-empty' }, 'Sent could not be read just now. It is tried again with ⟳.'));
    }
  }

  async function del() {
    if (!folder || selected === null) return;
    const uid = selected;
    const trash = folders.find(f => f.use === 'trash');
    const forGood = !trash || trash === folder;
    if (forGood && !(await shell.dialogs.confirm({ title: 'Delete for good?', text: trash ? 'This message is already in Deleted. Delete it for good? It cannot be brought back.' : 'This mailbox has no Deleted folder, so the message would be deleted for good. It cannot be brought back.', ok: 'Delete for good', danger: true }))) return;
    try {
      await client.remove(folder.raw, [uid], forGood ? '' : trash!.raw);
      const i = rows.findIndex(r => r.uid === uid);
      rows.splice(i, 1);
      selected = rows[Math.min(i, rows.length - 1)]?.uid ?? null;
      open = null;
      paintList();
      paintReader();
      status.textContent = forGood ? 'Deleted for good.' : 'Moved to Deleted.';
      if (selected !== null) void openMessage(selected);
    } catch (error) {
      await fail(error, 'Could not delete');
    }
  }

  async function toggleRead() {
    const row = rows.find(r => r.uid === selected);
    if (!row || !folder) return;
    try {
      await client.flag(folder.raw, [row.uid], 'seen', !row.seen);
      row.seen = !row.seen;
      folder.unread = Math.max(0, (folder.unread ?? 0) + (row.seen ? -1 : 1));
      paintFolders();
      paintList();
      showCounts();
    } catch (error) {
      await fail(error, 'Could not change it');
    }
  }

  async function toggleFlag() {
    const row = rows.find(r => r.uid === selected);
    if (!row || !folder) return;
    try {
      await client.flag(folder.raw, [row.uid], 'flagged', !row.flagged);
      row.flagged = !row.flagged;
      paintList();
    } catch (error) {
      await fail(error, 'Could not change it');
    }
  }

  function moveMenu() {
    if (!folder || selected === null) return;
    const r = moveBtn.getBoundingClientRect();
    shell.menus.show(folders.filter(f => f !== folder).map(f => ({
      label: folderLabel(f),
      action: async () => {
        try {
          await client.move(folder!.raw, [selected!], f.raw);
          rows = rows.filter(x => x.uid !== selected);
          selected = null;
          open = null;
          paintList();
          paintReader();
          status.textContent = `Moved to ${folderLabel(f)}.`;
        } catch (error) {
          await fail(error, 'Could not move it');
        }
      },
    })), r.left, r.bottom, { returnFocus: moveBtn });
  }

  async function refresh() {
    const before = folder?.unread ?? 0;
    await loadFolders();
    if (folder) folder = folders.find(f => f.raw === folder!.raw) ?? folder;
    paintFolders();
    await loadList();
    void loadSent();
    const now = folder?.unread ?? 0;
    if (folder?.use === 'inbox' && now > before) shell.notify('New mail', `${plural(now - before, 'new message')} in ${acct.email}.`, { label: 'Open Mail', run: () => void shell.openApp('mail') });
  }

  on(newBtn, 'click', () => compose('new'), app.signal);
  on(replyBtn, 'click', () => compose('reply'), app.signal);
  on(replyAllBtn, 'click', () => compose('all'), app.signal);
  on(fwdBtn, 'click', () => compose('forward'), app.signal);
  on(delBtn, 'click', () => void del(), app.signal);
  on(readBtn, 'click', () => void toggleRead(), app.signal);
  on(flagBtn, 'click', () => void toggleFlag(), app.signal);
  on(moveBtn, 'click', moveMenu, app.signal);
  on(refreshBtn, 'click', () => void refresh(), app.signal);
  on(settingsBtn, 'click', () => {
    const r = settingsBtn.getBoundingClientRect();
    shell.menus.show([
      { label: 'Mailbox settings...', action: () => setup(app, acct) },
      { label: acct.remember ? 'Forget the saved password' : 'Password is not saved', disabled: !acct.remember, action: async () => {
        await forgetAccount(shell, acct);
        shell.toast('The mailbox password is no longer saved. Mail will ask for it next time.');
      } },
    ], r.left, r.bottom, { returnFocus: settingsBtn });
  }, app.signal);
  on(search, 'keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      query = search.value.trim();
      void loadList();
    }
  }, app.signal);
  on(search, 'search', () => {
    if (search.value === '' && query) {
      query = '';
      void loadList();
    }
  }, app.signal);
  on(app.root, 'keydown', (e: KeyboardEvent) => {
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    const act = (fn: () => void) => {
      e.preventDefault();
      fn();
    };
    if (ctrl && k === 'n') return act(() => compose('new'));
    if (ctrl && k === 'r' && !replyBtn.disabled) return act(() => compose(e.shiftKey ? 'all' : 'reply'));
    if (e.key === 'F5') return act(() => void refresh());
    if (typing) return;
    if (ctrl && k === 'f' && !fwdBtn.disabled) return act(() => compose('forward'));
    if (ctrl && k === 'u') return act(() => void toggleRead());
    if (e.key === 'Delete' && selected !== null) return act(() => void del());
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && rows.length) {
      const i = rows.findIndex(r => r.uid === selected);
      const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) act(() => void openMessage(next.uid).then(() => list.querySelector<HTMLElement>(`[data-uid="${next.uid}"]`)?.scrollIntoView({ block: 'nearest' })));
    }
  }, app.signal);

  // New mail is checked every two minutes while Mail is open (not while the screen is locked).
  let locked = false;
  shell.lockChanged.on(l => (locked = l), app.signal);
  const timer = window.setInterval(() => !locked && folder?.use === 'inbox' && void refresh(), 120_000);
  app.signal.addEventListener('abort', () => clearInterval(timer), { once: true });

  paintReader();
  await loadFolders();
  const inbox = folders.find(f => f.use === 'inbox') ?? folders[0];
  if (inbox) await choose(inbox);
  if (ticket) {
    void loadContacts();
    void loadSent();
    shell.changes.on(paths => paths.includes('/Documents') && void loadContacts(), app.signal);
  }
  list.focus();
}

/** Plain text with its web addresses made into links (built as elements; nothing is read as HTML). */
function linkify(text: string): Node[] {
  const out: Node[] = [];
  const re = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
  let at = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > at) out.push(document.createTextNode(text.slice(at, m.index)));
    const a = h('a', { href: m[0], target: '_blank', rel: 'noopener noreferrer' }, m[0]);
    out.push(a);
    at = m.index! + m[0].length;
  }
  if (at < text.length) out.push(document.createTextNode(text.slice(at)));
  return out;
}
