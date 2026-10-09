// Chat's connection to the server, one per page: the Chat window and the Panel's chat share it, so opening both does
// not poll twice. It keeps this person's key pair, the General key, each conversation's messages (opened), and asks
// the server what is new every few seconds while something is showing chat and the screen is not locked.
import { AuthFailure } from '../../auth/api.ts';
import { Bus } from '../../core/bus.ts';
import { ServiceApi } from '../../net/service.ts';
import type { Shell } from '../../shell/types.ts';
import {
  directKey, generalCode, keysFromJwk, newGeneralKey, newKeys, openMessage, safetyCode, sealMessage, unwrapGeneral, wrapGeneral,
  type ChatKeys, type Wrap,
} from './crypto.ts';

export const KEY_PATH = '/System/chat-key.json';
export const MAX_TEXT = 4000;
const POLL_MS = 4000;

export interface Person {
  id: string;
  name: string;
  display: string;
  me: boolean;
  pub: string | null;
  online: boolean;
  encrypted: boolean;
  disabled: boolean;
  hasGeneral: boolean;
}
export interface ConvInfo {
  last: number;
  lastAt: number;
  unread: number;
  /** Goes up with every message deleted there: an open thread then fetches which ones. */
  deletes: number;
}
interface StateAnswer {
  me: string;
  people: Person[];
  convs: Record<string, ConvInfo>;
  /** Messages older than this many days are gone from the server (the owner's setting); 0 = kept until deleted. */
  vanishDays: number;
  general: { epoch: number; wrap: (Wrap & { from: string }) | null; started: boolean };
}
interface RawMessage {
  id: number;
  from: string;
  at: number;
  iv: string;
  ct: string;
  epoch?: number;
}
export interface Message {
  id: number;
  from: string;
  at: number;
  /** null: it has not opened here (no key for it yet, sent under an earlier key, or changed on the way). */
  text: string | null;
  /** The scrambled form, kept so a message that arrived before its key can be opened once the key does. */
  sealed: { iv: string; ct: string; epoch: number };
}
interface Thread {
  messages: Message[];
  last: number;
  /** The conversation's delete count when this thread last learned which messages were deleted. */
  deletes: number;
  loading: Promise<void> | null;
  /** Goes up whenever a message is added or opened, so a screen knows to draw the thread again. */
  version: number;
}

/** The name of the Direct conversation between two people (the same sum the server does). */
export const dmId = (a: string, b: string): string => (a < b ? `dm-${a}-${b}` : `dm-${b}-${a}`);

const sessions = new WeakMap<Shell, ChatSession>();

export class ChatSession {
  readonly changed = new Bus<void>();
  /** A message from someone else arrived in `conv` (for a notice when that conversation is not on screen). */
  readonly arrived = new Bus<{ conv: string; from: string }>();
  state: StateAnswer | null = null;
  /** Why chat is not working just now, in words for the person; null when it is. */
  problem: string | null = null;
  keys: ChatKeys | null = null;
  generalKey: CryptoKey | null = null;
  generalEpoch = 0;
  generalDigits = '';
  private readonly shell: Shell;
  private readonly api: ServiceApi;
  private readonly direct = new Map<string, CryptoKey>();
  private readonly threads = new Map<string, Thread>();
  private starting: Promise<void> | null = null;
  private users = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private locked = false;
  private refreshing: Promise<void> | null = null;

  static for(shell: Shell): ChatSession {
    let s = sessions.get(shell);
    if (!s) sessions.set(shell, (s = new ChatSession(shell)));
    return s;
  }

  private constructor(shell: Shell) {
    if (!shell.account) throw new Error('Chat needs the desktop to run on its server.');
    this.shell = shell;
    this.api = new ServiceApi(shell.account.api.base, 'chat');
    shell.lockChanged.on(locked => {
      this.locked = locked;
      if (!locked) this.kick();
    });
  }

  /** Something is showing chat until `signal` aborts: poll while anything is. */
  use(signal: AbortSignal): void {
    this.users++;
    signal.addEventListener('abort', () => {
      this.users--;
      if (this.users === 0 && this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
    }, { once: true });
    this.kick();
  }

  private kick(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    void this.tick();
  }

  private async tick(): Promise<void> {
    if (this.users === 0) return;
    if (!this.locked && document.visibilityState !== 'hidden') await this.refresh();
    if (this.users > 0 && !this.timer) this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, POLL_MS);
  }

  me(): Person | null {
    return this.state?.people.find(p => p.me) ?? null;
  }

  person(id: string): Person | null {
    return this.state?.people.find(p => p.id === id) ?? null;
  }

  /** The other person of a Direct conversation. */
  other(conv: string): Person | null {
    const me = this.state?.me ?? '';
    const m = /^dm-([0-9a-f]{16})-([0-9a-f]{16})$/.exec(conv);
    return m ? this.person(m[1] === me ? m[2] : m[1]) : null;
  }

  unread(conv?: string): number {
    const convs = this.state?.convs ?? {};
    if (conv) return convs[conv]?.unread ?? 0;
    return Object.values(convs).reduce((n, c) => n + c.unread, 0);
  }

  /** Makes or reads this person's key pair and tells the server its public half. Once per page. */
  start(): Promise<void> {
    this.starting ??= this.loadKeys().catch(error => {
      this.starting = null;
      throw error;
    });
    return this.starting;
  }

  private async loadKeys(): Promise<void> {
    const fs = this.shell.fs;
    let jwk: JsonWebKey | null = null;
    try {
      jwk = JSON.parse(await fs.readText(KEY_PATH)) as JsonWebKey;
    } catch {
      jwk = null;
    }
    let keys: ChatKeys;
    if (jwk) {
      keys = await keysFromJwk(jwk);
    } else {
      const made = await newKeys();
      await fs.ensureFolder('/System', { hidden: true });
      await fs.writeText(KEY_PATH, JSON.stringify(made.jwk), { hidden: true });
      keys = made.keys;
    }
    try {
      await this.api.call('key', { body: { pub: keys.pub } });
    } catch (error) {
      if (!(error instanceof AuthFailure) || error.status !== 409 || !error.data.exists) throw error;
      const replace = await this.shell.dialogs.confirm({
        title: 'Replace your chat key?',
        text: 'TOMLIN OS already has a different chat key for you, made on another device, or before the key kept in your files (System/chat-key.json) was removed. Replacing it lets you chat here, but messages sent to the old key can no longer be opened.',
        ok: 'Replace the key',
        cancel: 'Not now',
      });
      if (!replace) {
        this.problem = 'Chat is paused: your chat key here does not match the one TOMLIN OS has for you. Close Chat and open it again to replace it.';
        this.changed.emit();
        throw new Error(this.problem);
      }
      await this.api.call('key', { body: { pub: keys.pub, replace: true } });
    }
    this.keys = keys;
  }

  /** Asks the server what is new, hands the General key on to anyone who needs it, and tells the screens. */
  refresh(): Promise<void> {
    this.refreshing ??= this.doRefresh().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    try {
      await this.start();
      const before = this.state?.convs ?? null;
      const state = await this.api.call<StateAnswer>('state');
      this.state = state;
      await this.syncGeneral();
      if (before) {
        for (const [conv, info] of Object.entries(state.convs)) {
          if (info.unread > (before[conv]?.unread ?? 0)) this.arrived.emit({ conv, from: '' });
        }
      }
      // Deleted by someone, or vanished with age: gone from open threads too.
      for (const [conv, thread] of this.threads) {
        if ((state.convs[conv]?.deletes ?? 0) !== thread.deletes) void this.load(conv).catch(() => undefined);
      }
      this.dropVanished();
      this.problem = null;
    } catch (error) {
      // Signed out or locked: the desktop's own screens say so; chat just waits.
      if (error instanceof AuthFailure && (error.status === 401 || error.status === 423)) return;
      if (!this.problem) this.problem = error instanceof Error ? error.message : 'Chat could not reach the server.';
    }
    this.changed.emit();
  }

  private async syncGeneral(): Promise<void> {
    const state = this.state;
    const keys = this.keys;
    if (!state || !keys) return;
    const g = state.general;
    if (g.epoch !== this.generalEpoch) {
      this.generalKey = null;
      this.generalEpoch = g.epoch;
      this.generalDigits = '';
    }
    if (!this.generalKey && g.wrap) {
      try {
        this.generalKey = await unwrapGeneral(keys, state.me, g.wrap, g.epoch);
        await this.reopen('general');
      } catch {
        this.generalKey = null;
      }
    }
    if (!this.generalKey && !g.started) {
      // Nobody holds a General key yet: this person makes the first one.
      const key = await newGeneralKey();
      const wrap = await wrapGeneral(keys, state.me, keys.pub, key, g.epoch);
      try {
        await this.api.call('wrap', { body: { user: state.me, epoch: g.epoch, genesis: true, ...wrap } });
        this.generalKey = key;
        g.started = true;
        const me = this.me();
        if (me) me.hasGeneral = true;
      } catch (error) {
        if (!(error instanceof AuthFailure && error.status === 409)) throw error;
      }
    }
    if (!this.generalKey) return;
    this.generalDigits ||= await generalCode(this.generalKey);
    // Hand the key on to everyone with a chat key who has not got it (new people, or someone who replaced their key).
    for (const p of state.people) {
      if (p.me || !p.pub || p.hasGeneral || p.disabled) continue;
      const wrap = await wrapGeneral(keys, p.id, p.pub, this.generalKey, g.epoch);
      try {
        await this.api.call('wrap', { body: { user: p.id, epoch: g.epoch, ...wrap } });
        p.hasGeneral = true;
      } catch (error) {
        if (!(error instanceof AuthFailure && (error.status === 409 || error.status === 403))) throw error;
      }
    }
  }

  /** The key and epoch a conversation's messages are sealed with, or null when there is none yet. */
  private async keyFor(conv: string): Promise<{ key: CryptoKey; epoch: number } | null> {
    if (conv === 'general') return this.generalKey ? { key: this.generalKey, epoch: this.generalEpoch } : null;
    const other = this.other(conv);
    if (!other?.pub || !this.keys) return null;
    const cacheKey = `${conv}|${other.pub}|${this.keys.pub}`;
    let key = this.direct.get(cacheKey);
    if (!key) {
      key = await directKey(this.keys, other.pub, conv);
      this.direct.set(cacheKey, key);
    }
    return { key, epoch: 0 };
  }

  /** Why a conversation cannot be written in yet, or null when it can. */
  blocked(conv: string): string | null {
    if (!this.keys || !this.state) return 'Chat is still starting.';
    if (conv === 'general') {
      return this.generalKey ? null : 'Waiting for the General key: someone who already has it hands it to you the next time they open Chat.';
    }
    const other = this.other(conv);
    if (!other) return 'That person is no longer on this desktop.';
    if (other.disabled) return `${other.display}'s account is switched off.`;
    if (!other.pub) return `${other.display} has not opened Chat yet. You can write once they have.`;
    return null;
  }

  thread(conv: string): Message[] {
    return this.threads.get(conv)?.messages ?? [];
  }

  threadVersion(conv: string): number {
    return this.threads.get(conv)?.version ?? 0;
  }

  /** Takes out of every open thread the messages older than the owner's "vanish after" setting. */
  private dropVanished(): void {
    const days = this.state?.vanishDays ?? 0;
    if (!days) return;
    const cutoff = Date.now() / 1000 - days * 86400;
    for (const thread of this.threads.values()) {
      const kept = thread.messages.filter(m => m.at >= cutoff);
      if (kept.length !== thread.messages.length) {
        thread.messages = kept;
        thread.version++;
      }
    }
  }

  /** Takes messages out of a thread on this page (already deleted on the server). */
  private drop(conv: string, ids: number[]): void {
    const thread = this.threads.get(conv);
    if (!thread || !ids.length) return;
    const gone = new Set(ids);
    const kept = thread.messages.filter(m => !gone.has(m.id));
    if (kept.length !== thread.messages.length) {
      thread.messages = kept;
      thread.version++;
    }
  }

  /**
   * Deletes from the server, for everyone: one message (`id`), all of mine in the conversation (`mine`), or, the owner
   * in General, every message (`all`).
   */
  async remove(conv: string, what: { id: number } | { mine: true } | { all: true }): Promise<number> {
    const r = await this.api.call<{ deleted: number }>('delete', { body: { conv, ...what } });
    const me = this.state?.me;
    const thread = this.threads.get(conv);
    if (thread) {
      const ids = 'id' in what ? [what.id] : thread.messages.filter(m => 'all' in what || m.from === me).map(m => m.id);
      this.drop(conv, ids);
    }
    this.changed.emit();
    return r.deleted;
  }

  /** Opens the messages of a conversation that arrived before there was a key for them. */
  private async reopen(conv: string): Promise<void> {
    const thread = this.threads.get(conv);
    const k = await this.keyFor(conv);
    if (!thread || !k) return;
    for (const m of thread.messages) {
      if (m.text !== null || m.sealed.epoch !== k.epoch) continue;
      m.text = await openMessage(k.key, conv, m.from, k.epoch, m.sealed.iv, m.sealed.ct);
      if (m.text !== null) thread.version++;
    }
  }

  /** Fetches and opens everything newer than what this page already has. */
  load(conv: string): Promise<void> {
    let t = this.threads.get(conv);
    if (!t) this.threads.set(conv, (t = { messages: [], last: 0, deletes: 0, loading: null, version: 0 }));
    const thread = t;
    thread.loading ??= (async () => {
      try {
        for (;;) {
          const answer = await this.api.call<{ messages: RawMessage[]; more: boolean; gone?: number[]; deletes?: number }>('messages', { query: { conv, after: String(thread.last) } });
          this.drop(conv, answer.gone ?? []);
          thread.deletes = answer.deletes ?? 0;
          const k = await this.keyFor(conv);
          for (const m of answer.messages) {
            const epoch = conv === 'general' ? m.epoch ?? 0 : 0;
            const text = k && epoch === k.epoch ? await openMessage(k.key, conv, m.from, epoch, m.iv, m.ct) : null;
            thread.messages.push({ id: m.id, from: m.from, at: m.at, text, sealed: { iv: m.iv, ct: m.ct, epoch } });
            thread.last = Math.max(thread.last, m.id);
            thread.version++;
          }
          if (!answer.more) break;
        }
        this.dropVanished();
      } finally {
        thread.loading = null;
      }
    })();
    return thread.loading;
  }

  async send(conv: string, text: string): Promise<void> {
    const k = await this.keyFor(conv);
    const me = this.state?.me;
    if (!k || !me) throw new Error(this.blocked(conv) ?? 'Chat is still starting.');
    const sealed = await sealMessage(k.key, conv, me, k.epoch, text);
    await this.api.call('send', { body: { conv, epoch: k.epoch, ...sealed } });
    await this.load(conv);
    const info = this.state?.convs[conv];
    if (info) info.unread = 0;
    this.changed.emit();
  }

  /** Everything up to the newest message on screen counts as read. */
  async markRead(conv: string): Promise<void> {
    const info = this.state?.convs[conv];
    const last = this.threads.get(conv)?.last ?? 0;
    if (!info || info.unread === 0 || last === 0) return;
    info.unread = 0;
    this.changed.emit();
    try {
      await this.api.call('read', { body: { conv, id: last } });
    } catch {
      // The next look at the server puts the count back; nothing else depends on it.
    }
  }

  /**
   * Who in a conversation keeps their chat key readable on the server (their files are not encrypted). Empty means
   * the conversation is end to end: only the people in it can open it.
   */
  notEndToEnd(conv: string): Person[] {
    const people = this.state?.people ?? [];
    const members = conv === 'general' ? people.filter(p => !p.disabled && (p.me || p.hasGeneral)) : [this.me(), this.other(conv)].filter((p): p is Person => p !== null);
    return members.filter(p => !p.encrypted);
  }

  /** The Direct conversation's safety code, or '' when the other person has no key yet. */
  async safety(conv: string): Promise<string> {
    const other = this.other(conv);
    return other?.pub && this.keys ? safetyCode(this.keys.pub, other.pub) : '';
  }
}
