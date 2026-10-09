// The conversation with the AI that is open on this desktop, shared by every view of it: Chat › Agents (on the Panel's
// Overview or in a Chat window): moving between them shows "Already connected" and
// the chat so far. One object per
// signed-in desktop, so a message added in one view shows in the others, and the thread's file is written from this
// one copy only (two copies saving in turn would each overwrite the other's newest messages).
import type { FileSystem } from '../../fs/fs.ts';
import { listThreads, openThread, saveThread, type AgentThread, type AgentTurn } from './agents.ts';

/** What changed: the thread (another one opened, or a message added), the answer being written, or who is busy. */
export type LiveChange = 'thread' | 'pending' | 'busy';

/** An answer being written: by whom, the text so far, and how it is going (for the line under it). */
export interface Pending {
  by: string;
  text: string;
  /** When the question was sent, and when the first piece of the answer came (null until it has), in milliseconds. */
  started: number;
  first: number | null;
  /** Pieces received so far (for the built-in AI, one per word-piece). */
  pieces: number;
  /** The built-in AI on this device (its speed is shown); false for Claude and OpenRouter. */
  device: boolean;
}

/** A word-piece is what the model writes one at a time: about four make three words. */
export const PIECE_HINT = 'A piece is part of a word: about four pieces make three words.';

const secs = (ms: number): number => Math.max(0, Math.round(ms / 1000));

/** The line under an answer being written: "Reading your question... 6 s", then "Writing: 4.8 pieces a second · 21 s". */
export function writingWords(p: Pending, now = Date.now()): string {
  const total = secs(now - p.started);
  if (p.first === null) return p.device ? `Reading your question... ${total} s` : `Waiting for ${p.by}... ${total} s`;
  const span = (now - p.first) / 1000;
  if (!p.device || span < 1 || p.pieces < 2) return `Writing... ${total} s`;
  return `Writing: ${((p.pieces - 1) / span).toFixed(1)} pieces a second · ${total} s`;
}

/**
 * The line under a finished answer (this session only; the name of the AI is already above it): how long it took,
 * and for the built-in AI where it ran and how fast it wrote. `perSecond` is the engine's own measure, when it gives one.
 */
export function footWords(p: Pending, now = Date.now(), perSecond = 0): string {
  const total = secs(now - p.started);
  if (!p.device) return `Answered in ${total} s`;
  const span = p.first === null ? 0 : (now - p.first) / 1000;
  const rate = perSecond > 0 ? perSecond : span >= 1 && p.pieces > 1 ? (p.pieces - 1) / span : 0;
  return `Answered in ${total} s on this device${rate ? ` · ${rate.toFixed(1)} pieces a second` : ''}`;
}

const chats = new WeakMap<object, LiveChat>();

export class LiveChat {
  thread: AgentThread = { title: '', turns: [] };
  /** The answer being written, as far as it has got, so every view can show it; null when none is. */
  pending: Pending | null = null;
  /** A question is being answered: the other views wait (the AI writes one answer at a time). */
  busy = false;
  /** The line under an answer written this session (who wrote it, that nothing left the device, how long it took). */
  readonly feet = new WeakMap<AgentTurn, string>();
  /** What a question showed as when it was asked (Summarise “notes.txt”); its kept text is the whole prompt. */
  readonly labels = new WeakMap<AgentTurn, string>();
  private files = new WeakMap<AgentThread, string>();
  private watchers = new Set<(change: LiveChange) => void>();
  private saving: Promise<unknown> = Promise.resolve();
  /** Nothing has been opened on this desktop yet, not even an empty New chat. */
  private fresh = true;
  private starting: Promise<void> | null = null;

  /** The AI conversation of this signed-in desktop (`shell`), the same object for every view. */
  static for(shell: object): LiveChat {
    let chat = chats.get(shell);
    if (!chat) chats.set(shell, (chat = new LiveChat()));
    return chat;
  }

  /** The thread's file in Documents › AI chats; null until it is first kept. */
  get file(): string | null {
    return this.files.get(this.thread) ?? null;
  }

  /** `fn` hears every change until `signal` ends. */
  watch(fn: (change: LiveChange) => void, signal: AbortSignal): void {
    this.watchers.add(fn);
    signal.addEventListener('abort', () => this.watchers.delete(fn), { once: true });
  }

  tell(change: LiveChange): void {
    for (const fn of [...this.watchers]) fn(change);
  }

  /**
   * A view opening brings back the newest kept conversation while none has been opened on this desktop yet, so
   * closing the Panel or reloading the page loses nothing: the chats, and the downloaded model, are still there. A
   * conversation already chosen (even an
   * empty New chat) or already begun is never replaced.
   */
  start(fs: FileSystem): Promise<void> {
    if (!this.fresh) return Promise.resolve();
    this.starting ??= (async () => {
      try {
        if (this.thread.turns.length || this.file) {
          this.fresh = false;
          return;
        }
        const newest = (await listThreads(fs))[0];
        if (!newest || !this.fresh || this.thread.turns.length || this.file) return;
        this.open(await openThread(fs, newest.name), newest.name);
      } catch {
        // A thread that cannot be read stays in its folder; the conversation starts empty.
      } finally {
        this.starting = null;
      }
    })();
    return this.starting;
  }

  /** Shows another thread (a kept one with its file, or a new empty one) in every view. */
  open(thread: AgentThread, file: string | null = null): void {
    this.fresh = false;
    this.thread = thread;
    if (file) this.files.set(thread, file);
    this.pending = null;
    this.tell('thread');
  }

  /**
   * Keeps `thread` (the open one unless another is given) in its file. Saves run one after another, so a thread's
   * second save writes the file its first save named instead of starting a second file.
   */
  keep(fs: FileSystem, thread: AgentThread = this.thread): Promise<string> {
    const run = this.saving.then(async () => {
      const name = await saveThread(fs, thread, this.files.get(thread) ?? null);
      this.files.set(thread, name);
      return name;
    });
    this.saving = run.catch(() => undefined);
    return run;
  }
}
