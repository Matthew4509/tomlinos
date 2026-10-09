// Mail settings and the calls to the server. The settings (including the mailbox password when "remember" is ticked)
// live in the person's own files at /System/mail.json, which are sealed with their own key when file encryption is on.
// Without "remember", the password is kept in this page's memory only, until the page closes or the person signs out.
import { ServiceApi } from '../../net/service.ts';
import type { Shell } from '../../shell/types.ts';

export type Security = 'ssl' | 'starttls' | 'none';
export interface ServerSetting {
  host: string;
  port: number;
  security: Security;
}
export interface MailAccount {
  name: string;
  email: string;
  user: string;
  /** Empty when not remembered. */
  password: string;
  remember: boolean;
  imap: ServerSetting;
  smtp: ServerSetting;
  /** Gmail keeps its own copy of sent mail; others need one put in Sent. */
  providerSavesSent: boolean;
}

export interface Preset {
  id: string;
  label: string;
  imap: ServerSetting;
  smtp: ServerSetting;
  providerSavesSent?: boolean;
  note: string;
  /** Not possible with a password at all. */
  blocked?: boolean;
}

export const PRESETS: Preset[] = [
  {
    id: 'own', label: 'My own domain (cPanel or other host)', imap: { host: 'mail.', port: 993, security: 'ssl' }, smtp: { host: 'mail.', port: 465, security: 'ssl' },
    note: 'For an address on your own domain: the server is usually mail.yourdomain. Use the mailbox password from your host\'s control panel.',
  },
  {
    id: 'gmail', label: 'Gmail', imap: { host: 'imap.gmail.com', port: 993, security: 'ssl' }, smtp: { host: 'smtp.gmail.com', port: 465, security: 'ssl' }, providerSavesSent: true,
    note: 'Gmail needs an app password (Google Account > Security > 2-Step Verification > App passwords), not your normal password.',
  },
  {
    id: 'yahoo', label: 'Yahoo Mail', imap: { host: 'imap.mail.yahoo.com', port: 993, security: 'ssl' }, smtp: { host: 'smtp.mail.yahoo.com', port: 465, security: 'ssl' },
    note: 'Yahoo needs an app password (Account security > Generate app password).',
  },
  {
    id: 'icloud', label: 'iCloud Mail', imap: { host: 'imap.mail.me.com', port: 993, security: 'ssl' }, smtp: { host: 'smtp.mail.me.com', port: 587, security: 'starttls' },
    note: 'iCloud needs an app-specific password (appleid.apple.com > Sign-In and Security). The user name is your iCloud address.',
  },
  {
    id: 'outlook', label: 'Outlook.com / Hotmail', imap: { host: 'outlook.office365.com', port: 993, security: 'ssl' }, smtp: { host: 'smtp-mail.outlook.com', port: 587, security: 'starttls' },
    note: 'Microsoft no longer lets mail apps sign in to Outlook.com and Hotmail with a password; it needs its own sign-in page, which TOMLIN OS Mail does not have yet. Forwarding your Hotmail to another mailbox works meanwhile.',
    blocked: true,
  },
  {
    id: 'other', label: 'Other', imap: { host: '', port: 993, security: 'ssl' }, smtp: { host: '', port: 465, security: 'ssl' },
    note: 'Your provider\'s help pages list its IMAP (incoming) and SMTP (sending) servers.',
  },
];

const SETTINGS_PATH = '/System/mail.json';
/** Passwords not remembered, for this page only. */
const memoryPasswords = new Map<string, string>();

function clean(raw: unknown): MailAccount | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const server = (s: unknown): ServerSetting | null => {
    if (!s || typeof s !== 'object') return null;
    const o = s as Record<string, unknown>;
    const security = o.security === 'ssl' || o.security === 'starttls' || o.security === 'none' ? o.security : null;
    return typeof o.host === 'string' && typeof o.port === 'number' && security ? { host: o.host, port: o.port, security } : null;
  };
  const imap = server(r.imap);
  const smtp = server(r.smtp);
  if (!imap || !smtp || typeof r.email !== 'string' || typeof r.user !== 'string') return null;
  return {
    name: typeof r.name === 'string' ? r.name : '',
    email: r.email,
    user: r.user,
    password: typeof r.password === 'string' ? r.password : '',
    remember: r.remember !== false,
    imap,
    smtp,
    providerSavesSent: r.providerSavesSent === true,
  };
}

export async function loadAccount(shell: Shell): Promise<MailAccount | null> {
  try {
    const acct = clean(JSON.parse(await shell.fs.readText(SETTINGS_PATH)));
    if (acct && !acct.remember) acct.password = memoryPasswords.get(acct.email) ?? '';
    return acct;
  } catch {
    return null;
  }
}

export async function saveAccount(shell: Shell, acct: MailAccount): Promise<void> {
  if (!acct.remember) memoryPasswords.set(acct.email, acct.password);
  else memoryPasswords.delete(acct.email);
  await shell.fs.ensureFolder('/System', { hidden: true });
  await shell.fs.writeText(SETTINGS_PATH, JSON.stringify({ ...acct, password: acct.remember ? acct.password : '' }), { hidden: true });
}

export async function forgetAccount(shell: Shell, acct: MailAccount): Promise<void> {
  memoryPasswords.delete(acct.email);
  await shell.fs.writeText(SETTINGS_PATH, JSON.stringify({ ...acct, password: '', remember: false }), { hidden: true });
}

export function rememberForNow(acct: MailAccount, password: string): void {
  acct.password = password;
  memoryPasswords.set(acct.email, password);
}

export interface FolderRow {
  name: string;
  raw: string;
  delim: string;
  use: string | null;
  unread?: number;
  total?: number;
}
export interface HeadRow {
  uid: number;
  flags: string[];
  size: number;
  date: string;
  head: string;
}

/** Calls to api/mail.php; each carries the mailbox settings and password. */
export class MailClient {
  private api: ServiceApi;
  acct: MailAccount;

  constructor(shell: Shell, acct: MailAccount) {
    if (!shell.account) throw new Error('Mail needs the desktop to run on its server.');
    this.api = new ServiceApi(shell.account.api.base, 'mail');
    this.acct = acct;
  }

  private call<T>(op: string, body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const { user, password, imap, smtp } = this.acct;
    return this.api.call<T>(op, { body: { account: { user, password, imap, smtp }, ...body }, signal });
  }

  test = () => this.call<{ imap: { ok: boolean; error?: string; folders?: number }; smtp: { ok: boolean; error?: string } }>('test');
  folders = () => this.call<{ folders: FolderRow[] }>('folders');
  list = (folder: string, before = 0, q = '', signal?: AbortSignal) => this.call<{ total: number; more: boolean; rows: HeadRow[] }>('list', { folder, before, q }, signal);
  message = (folder: string, uid: number) => this.call<{ raw: string }>('message', { folder, uid });
  flag = (folder: string, uids: number[], flag: 'seen' | 'flagged', on: boolean) => this.call('flag', { folder, uids, flag, on });
  move = (folder: string, uids: number[], to: string) => this.call('move', { folder, uids, to });
  remove = (folder: string, uids: number[], trash: string) => this.call<{ forGood: boolean }>('delete', { folder, uids, trash });
  send = (m: Record<string, unknown>) => this.call<{ sent: boolean; recipients: number; copy: string }>('send', { from: this.acct.email, fromName: this.acct.name, providerSavesSent: this.acct.providerSavesSent, ...m });
}

/** base64 of bytes, in pieces (a big attachment would overflow a single String.fromCharCode call). */
export function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Signing out forgets every mailbox password that was kept in memory only. */
export function forgetMemoryPasswords(): void {
  memoryPasswords.clear();
}
