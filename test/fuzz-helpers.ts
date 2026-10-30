// Shared by the fuzz tests (test/fuzz-*.test.ts): a seeded random generator (the same "random" bytes every run, so a
// failure can be run again), ways of damaging a valid file (cutting it short, flipping bits, dropping or doubling a
// piece, writing it in the wrong character encoding), random text, and the one check every reader must pass: it reads
// the input, or it throws its own named "Problem" with words in it. A raw TypeError or RangeError, a hang, or a
// problem with no words is a fault, reported with the seed that made it.
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { ALLOWED, type Input } from './fuzz-worker.ts';

/** mulberry32: a small, fast generator with a 32-bit seed. */
export class Rng {
  readonly seed: number;
  private s: number;
  constructor(seed: number) {
    this.seed = seed;
    this.s = seed >>> 0;
  }
  /** [0, 1) */
  next(): number {
    let t = (this.s += 0x6d2b79f5) >>> 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** An integer in [lo, hi] (both ends in). */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  pick<T>(list: readonly T[]): T {
    return list[this.int(0, list.length - 1)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  bytes(n: number): Uint8Array {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = this.int(0, 255);
    return out;
  }
}

export const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
export const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

// ---- Damaging bytes -------------------------------------------------------------------------------------------------

export type Strategy = 'truncate' | 'bitflip' | 'delete' | 'insert' | 'duplicate' | 'overwrite' | 'swapchunks' | 'zero';
export const STRATEGIES: Strategy[] = ['truncate', 'bitflip', 'delete', 'insert', 'duplicate', 'overwrite', 'swapchunks', 'zero'];

/** One damaged copy of `seed` bytes, decided by the generator. */
export function mutateBytes(rng: Rng, seed: Uint8Array, strategy: Strategy): Uint8Array {
  const n = seed.length;
  if (n === 0) return rng.bytes(rng.int(0, 64));
  switch (strategy) {
    case 'truncate':
      return seed.slice(0, rng.int(0, n - 1));
    case 'bitflip': {
      const out = seed.slice();
      const flips = rng.int(1, Math.max(1, Math.min(32, Math.ceil(n / 50))));
      for (let i = 0; i < flips; i++) out[rng.int(0, n - 1)] ^= 1 << rng.int(0, 7);
      return out;
    }
    case 'delete': {
      const a = rng.int(0, n - 1);
      const len = rng.int(1, Math.max(1, Math.min(n - a, rng.chance(0.5) ? 8 : 512)));
      const out = new Uint8Array(n - len);
      out.set(seed.subarray(0, a));
      out.set(seed.subarray(a + len), a);
      return out;
    }
    case 'insert': {
      const a = rng.int(0, n);
      const junk = rng.bytes(rng.int(1, rng.chance(0.5) ? 8 : 300));
      const out = new Uint8Array(n + junk.length);
      out.set(seed.subarray(0, a));
      out.set(junk, a);
      out.set(seed.subarray(a), a + junk.length);
      return out;
    }
    case 'duplicate': {
      const a = rng.int(0, n - 1);
      const len = rng.int(1, Math.max(1, Math.min(n - a, 600)));
      const piece = seed.subarray(a, a + len);
      const at = rng.int(0, n);
      const out = new Uint8Array(n + len);
      out.set(seed.subarray(0, at));
      out.set(piece, at);
      out.set(seed.subarray(at), at + len);
      return out;
    }
    case 'overwrite': {
      const out = seed.slice();
      const a = rng.int(0, n - 1);
      const len = rng.int(1, Math.max(1, Math.min(n - a, 64)));
      for (let i = 0; i < len; i++) out[a + i] = rng.int(0, 255);
      return out;
    }
    case 'swapchunks': {
      const out = seed.slice();
      const len = rng.int(1, Math.max(1, Math.min(256, Math.floor(n / 2))));
      const a = rng.int(0, n - len);
      const b = rng.int(0, n - len);
      const ca = seed.slice(a, a + len);
      const cb = seed.slice(b, b + len);
      out.set(cb, a);
      out.set(ca, b);
      return out;
    }
    case 'zero': {
      const out = seed.slice();
      const a = rng.int(0, n - 1);
      const len = rng.int(1, Math.max(1, Math.min(n - a, 128)));
      out.fill(rng.chance(0.5) ? 0 : 0xff, a, a + len);
      return out;
    }
  }
}

// ---- Damaging text --------------------------------------------------------------------------------------------------

/** Characters that trip readers up: control codes, bidi marks, lone surrogates, zero width, NUL, line separators. */
const NASTY = ['\u0000', '\u0001', '\u001f', '\u007f', ' ', '​', '‎', '‏', '‮', ' ', ' ', '﻿', '￾', '￿', '\ud800', '\udc00', '\u{1f600}', '\u{1f468}‍\u{1f469}‍\u{1f467}', 'é', 'é', 'İ', 'ß', 'ﬁ', 'א', 'ع', '\t', '\r', '\n', '\\', '"', "'", '<', '>', '&', ';', ',', ':', '=', '%', '{', '}', '[', ']', '|', '`', '*', '_', '#', '$'];

/** Random text in the shape readers see: words, punctuation, nasty characters, sometimes very long. */
export function randomText(rng: Rng, maxLen = 200): string {
  const len = rng.chance(0.05) ? rng.int(maxLen, maxLen * 20) : rng.int(0, maxLen);
  let out = '';
  while (out.length < len) {
    const r = rng.next();
    if (r < 0.5) out += String.fromCharCode(rng.int(97, 122));
    else if (r < 0.65) out += ' ';
    else if (r < 0.8) out += rng.pick(NASTY);
    else if (r < 0.9) out += String.fromCharCode(rng.int(32, 126));
    else out += String.fromCodePoint(rng.int(0x80, 0x2fff));
  }
  return out;
}

export type TextStrategy = 'cut' | 'splice' | 'nasty' | 'lines' | 'utf16' | 'latin1' | 'bom' | 'crlf' | 'repeat';
export const TEXT_STRATEGIES: TextStrategy[] = ['cut', 'splice', 'nasty', 'lines', 'utf16', 'latin1', 'bom', 'crlf', 'repeat'];

/** One damaged copy of a text file, as a string (what a text reader is given) — or bytes for encoding tricks. */
export function mutateText(rng: Rng, seed: string, strategy: TextStrategy): string {
  const n = seed.length;
  switch (strategy) {
    case 'cut':
      return seed.slice(0, rng.int(0, Math.max(0, n - 1)));
    case 'splice': {
      const a = rng.int(0, n);
      const b = Math.min(n, a + rng.int(0, 40));
      return seed.slice(0, a) + randomText(rng, 30) + seed.slice(b);
    }
    case 'nasty': {
      let out = seed;
      for (let i = rng.int(1, 6); i > 0; i--) {
        const at = rng.int(0, out.length);
        out = out.slice(0, at) + rng.pick(NASTY) + out.slice(at);
      }
      return out;
    }
    case 'lines': {
      const lines = seed.split(/\r?\n/);
      const k = rng.int(0, Math.max(0, lines.length - 1));
      const m = rng.int(0, Math.max(0, lines.length - 1));
      const r = rng.next();
      if (r < 0.33) lines.splice(k, 1);
      else if (r < 0.66) [lines[k], lines[m]] = [lines[m], lines[k]];
      else lines.splice(k, 0, lines[m]);
      return lines.join('\n');
    }
    case 'utf16': {
      // A file saved as UTF-16 (Windows Notepad's "Unicode") and read as UTF-8.
      const bytes = new Uint8Array(2 + n * 2);
      bytes[0] = 0xff;
      bytes[1] = 0xfe;
      for (let i = 0; i < n; i++) {
        const c = seed.charCodeAt(i);
        bytes[2 + i * 2] = c & 255;
        bytes[3 + i * 2] = c >> 8;
      }
      return dec(bytes);
    }
    case 'latin1':
      // UTF-8 bytes read as Latin-1 (each byte its own character), as a wrong-encoding reader would.
      return Array.from(enc(seed), b => String.fromCharCode(b)).join('');
    case 'bom':
      return '﻿' + seed;
    case 'crlf':
      return rng.chance(0.5) ? seed.replace(/\r?\n/g, '\r') : seed.replace(/\r?\n/g, '\n\n');
    case 'repeat':
      return seed.repeat(rng.int(2, 6));
  }
}

// ---- The check --------------------------------------------------------------------------------------------------------

export type ErrorClass = new (...args: never[]) => Error;

/** Up to this long per input: longer is a hang, as far as a person waiting on a click is concerned. */
export const TIME_BUDGET_MS = 2000;

export interface Tame {
  /** Every failure, in words, with the seed that makes it again. Empty when all is well. */
  bad: string[];
  /** How many inputs were read without a problem, and how many were refused with a named one. */
  ok: number;
  refused: number;
}

/**
 * Runs the reader on one input. A result or an allowed Problem (with words in it) is fine; anything else — a raw
 * TypeError or RangeError, a stack-overflow, a Problem with no words, or more than the time budget — goes into `bad`.
 */
export async function tame(t: Tame, label: string, run: () => unknown, allowed: ErrorClass[]): Promise<void> {
  const t0 = performance.now();
  let outcome: 'ok' | 'refused' = 'ok';
  // FUZZ_TRACE=1 names each input before it runs, so a crash that kills the process (out of memory) can be placed.
  if (process.env.FUZZ_TRACE) process.stderr.write(`[fuzz] ${label}
`);
  try {
    await run();
  } catch (error) {
    const e = error as Error;
    const name = e?.constructor?.name ?? typeof error;
    if (!allowed.some(A => error instanceof A)) {
      t.bad.push(`${label}: threw ${name}: ${String(e?.message ?? error).slice(0, 160)}`);
      return;
    }
    if (!(typeof e.message === 'string' && e.message.trim().length >= 8)) t.bad.push(`${label}: ${name} with no words in it: "${e.message}"`);
    outcome = 'refused';
  }
  const ms = performance.now() - t0;
  if (ms > TIME_BUDGET_MS) t.bad.push(`${label}: took ${Math.round(ms)} ms (budget ${TIME_BUDGET_MS} ms)`);
  if (outcome === 'ok') t.ok++;
  else t.refused++;
}

export const newTame = (): Tame => ({ bad: [], ok: 0, refused: 0 });

/** Fails the test with every finding (the first dozen), each carrying its seed. */
export function report(t: Tame, what: string): void {
  assert.ok(t.bad.length === 0, `${what}: ${t.bad.length} input(s) not handled (${t.ok} read, ${t.refused} refused by name):\n  ${t.bad.slice(0, 12).join('\n  ')}`);
}

/** The seed the whole run uses: FUZZ_SEED to repeat a run, else a fixed one (every run the same by default). */
export const BASE_SEED = Number(process.env.FUZZ_SEED ?? 20261029);
/** How many damaged copies per reader per strategy (FUZZ_ROUNDS to fuzz harder). */
export const ROUNDS = Number(process.env.FUZZ_ROUNDS ?? 12);

/** A deep tree: `open` repeated `depth` times, then `close` the same number of times. */
export const nested = (open: string, close: string, depth: number): string => open.repeat(depth) + close.repeat(depth);

// ---- Running readers in their own thread ------------------------------------------------------------------------------------

/** A reader that is still running after this long is a hang: its thread is stopped and a fresh one started. */
export const HARD_LIMIT_MS = 20_000;
/** The most memory one reader call may take (a small file needing more is runaway memory). */
export const MAX_HEAP_MB = 1024;

/**
 * One worker thread (fuzz-worker.ts) that runs reader calls one at a time. A call that runs out of memory kills only
 * the thread; a call past HARD_LIMIT_MS is stopped. Either is a finding, and the next call gets a new thread.
 */
export class Pool {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending: { id: number; resolve: (r: Reply) => void } | null = null;

  private spawn(): Worker {
    const w = new Worker(new URL('./fuzz-worker.ts', import.meta.url), { resourceLimits: { maxOldGenerationSizeMb: MAX_HEAP_MB } });
    w.on('message', (r: Reply) => {
      if (this.pending && r.id === this.pending.id) {
        const { resolve } = this.pending;
        this.pending = null;
        resolve(r);
      }
    });
    const died = (why: string) => {
      if (this.worker === w) this.worker = null;
      if (this.pending) {
        const { id, resolve } = this.pending;
        this.pending = null;
        resolve({ id, ok: false, name: 'ThreadDied', message: why, ms: 0 });
      }
    };
    w.on('error', e => died(`the thread crashed: ${String((e as Error)?.message ?? e).slice(0, 160)}`));
    w.on('exit', code => died(`the thread stopped (code ${code}) — out of memory past ${MAX_HEAP_MB} MB, most likely`));
    return w;
  }

  /** Runs one reader on one input; never throws. */
  async call(runner: string, input: Input): Promise<Reply> {
    this.worker ??= this.spawn();
    const w = this.worker;
    const id = this.nextId++;
    const reply = new Promise<Reply>(resolve => {
      this.pending = { id, resolve };
    });
    w.postMessage({ id, runner, input });
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<Reply>(resolve => {
      timer = setTimeout(() => {
        this.pending = null;
        this.worker = null;
        void w.terminate();
        resolve({ id, ok: false, name: 'Hang', message: `still running after ${HARD_LIMIT_MS} ms`, ms: HARD_LIMIT_MS });
      }, HARD_LIMIT_MS);
    });
    const r = await Promise.race([reply, late]);
    clearTimeout(timer);
    return r;
  }

  /** As `tame`, in the thread: a result or the reader's own named Problem is fine; anything else goes into `t.bad`. */
  async run(t: Tame, label: string, runner: string, input: Input): Promise<void> {
    if (process.env.FUZZ_TRACE) process.stderr.write(`[fuzz] ${label}
`);
    const allowed = ALLOWED[runner];
    assert.ok(allowed, `no such runner: ${runner}`);
    const r = await this.call(runner, input);
    if (r.ok) {
      if (r.ms > TIME_BUDGET_MS) t.bad.push(`${label}: took ${Math.round(r.ms)} ms (budget ${TIME_BUDGET_MS} ms)`);
      else t.ok++;
      return;
    }
    if (r.name === 'Hang' || r.name === 'ThreadDied') {
      t.bad.push(`${label}: ${r.message}`);
      return;
    }
    if (!allowed.includes(r.name ?? '')) {
      t.bad.push(`${label}: threw ${r.name}: ${(r.message ?? '').slice(0, 160)}`);
      return;
    }
    if ((r.message ?? '').trim().length < 8) t.bad.push(`${label}: ${r.name} with no words in it: "${r.message}"`);
    else if (r.ms > TIME_BUDGET_MS) t.bad.push(`${label}: took ${Math.round(r.ms)} ms to refuse (budget ${TIME_BUDGET_MS} ms)`);
    else t.refused++;
  }

  async close(): Promise<void> {
    const w = this.worker;
    this.worker = null;
    if (w) await w.terminate();
  }
}

export interface Reply {
  id: number;
  ok: boolean;
  name?: string;
  message?: string;
  ms: number;
}
