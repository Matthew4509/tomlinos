// The built-in, on-device AI: WebLLM (public/vendor/webllm.js, Apache-2.0) running a small model on this device's
// graphics chip. The model's files come from this TOMLIN OS when the owner saved it here (models/), otherwise from Hugging
// Face, where its makers publish it, at the version TOMLIN OS is pinned to; nothing typed leaves the device. The model's
// program (the part that runs as code) is checked against its pinned SHA-256 before it runs (checkedLib). The text helpers below are plain functions,
// tested in Node.
import { localStatus } from '../../core/local.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface InstalledModel {
  id: string;
  lib: string;
  bytes: number;
  vram: number;
  context: number | null;
  overrides: Record<string, unknown>;
  /** The SHA-256 of the model's program, checked before it runs. */
  libSha256?: string;
}

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * The built-in models, smallest first: Qwen 3.5 0.8B (about 430 MB, 1.9 GB of graphics memory), Gemma 2 2B (about
 * 1.4 GB, 2.5 GB of graphics memory; replaced Qwen 3.5 2B on 30 Sep 2026) and
 * Qwen 3.5 4B (about 2.2 GB, 4.7 GB of graphics memory). All are q4f32 builds, the kind an older graphics chip (no
 * half-precision) can run. Only these are offered by the server, even if other files were fetched onto it; a person can
 * add others from Hugging Face for themselves (assistant/hfsearch.ts).
 */
export const BUILT_IN_MODELS = [
  { id: 'Qwen3.5-0.8B-q4f32_1-MLC', name: 'Qwen 3.5 0.8B', maker: 'Qwen team, Alibaba Cloud', licence: 'Apache-2.0', note: 'the quickest and smallest; fine for short jobs' },
  { id: 'gemma-2-2b-it-q4f32_1-MLC', name: 'Gemma 2 2B', maker: 'Google', licence: 'Gemma Terms of Use', note: 'the middle size; slower, needs more graphics memory' },
  { id: 'Qwen3.5-4B-q4f32_1-MLC', name: 'Qwen 3.5 4B', maker: 'Qwen team, Alibaba Cloud', licence: 'Apache-2.0', note: 'the best answers of the three and the slowest; needs the most graphics memory' },
] as const;
export const DEFAULT_MODEL = BUILT_IN_MODELS[0].id;
export const MODEL_NAME = BUILT_IN_MODELS[0].name;

/** Names of models a person added from Hugging Face (assistant/mymodels.ts tells this list as it reads theirs). */
const addedNames = new Map<string, { name: string; maker: string }>();
export function nameAddedModels(list: Array<{ id: string; name: string; maker: string }>): void {
  addedNames.clear();
  for (const m of list) addedNames.set(m.id, { name: m.name, maker: m.maker });
}

/** A model's name for people ("Gemma 2 2B"), or its id when it is not one we know. */
export function modelName(id: string): string {
  return BUILT_IN_MODELS.find(m => m.id === id)?.name ?? addedNames.get(id)?.name ?? id;
}

/** Who made a model ("Google"), or '' when not known. */
export function modelMaker(id: string): string {
  return BUILT_IN_MODELS.find(m => m.id === id)?.maker ?? addedNames.get(id)?.maker ?? '';
}

/** The name with its maker, for lists ("Gemma 2 2B by Google"). */
export function modelLabel(id: string): string {
  const maker = modelMaker(id);
  return maker ? `${modelName(id)} by ${maker}` : modelName(id);
}

/**
 * How each family of model is asked, from its id (added models are named after the model they are built on).
 * - Qwen 3 and 3.5: thinking off (it otherwise writes its reasoning first, hidden from the person, and on a small chip
 *   that ate the whole allowance: one test waited 91 s and got "No answer"); sampling as the Qwen team advise for
 *   answers without thinking (temperature 0.7, top_p 0.8, presence penalty 1.5 "to reduce endless repetitions": one test
 *   got the same paragraph eight times over).
 * - Gemma: it was trained with no system role, so the instructions go at the top of the first message (WebLLM would
 *   otherwise put them loose before the first turn); Google's sampling (top_p 0.95) a little cooler, and a light
 *   presence penalty against loops.
 * - Anything else: plain, middle-of-the-road settings.
 */
export interface ChatStyle {
  sampling: Record<string, unknown>;
  systemInFirstMessage: boolean;
}
export function chatStyle(id: string): ChatStyle {
  if (/qwen3/i.test(id)) return { sampling: { temperature: 0.7, top_p: 0.8, presence_penalty: 1.5, extra_body: { enable_thinking: false } }, systemInFirstMessage: false };
  if (/gemma/i.test(id)) return { sampling: { temperature: 0.8, top_p: 0.95, presence_penalty: 0.5 }, systemInFirstMessage: true };
  return { sampling: { temperature: 0.7, top_p: 0.9, presence_penalty: 0.5 }, systemInFirstMessage: false };
}

/** The turns as `style` needs them: for a model with no system role, the system text leads the first message. */
export function turnsFor(turns: ChatTurn[], style: ChatStyle): ChatTurn[] {
  if (!style.systemInFirstMessage || turns[0]?.role !== 'system') return turns;
  const [system, ...rest] = turns;
  const first = rest.findIndex(t => t.role === 'user');
  if (first < 0) return rest;
  return rest.map((t, i) => (i === first ? { role: 'user' as const, content: `${system.content}\n\n${t.content}` } : t));
}

/** The built-in model last started on this page (the Panel's rail names it); back to the smaller one on a reload. */
let chosen: string = DEFAULT_MODEL;
export function chosenModel(): string {
  return chosen;
}
export function rememberModel(id: string): void {
  chosen = id;
}
/** The longest answer, in word-pieces (about 600 words; on an older integrated GPU, up to 3-4 minutes). */
export const MAX_ANSWER = 800;

/** What this device offers, for choosing whether (and which) model to offer. */
export interface DeviceCheck {
  webgpu: boolean;
  chip: string;
  memoryGb: number | null;
  phone: boolean;
  /** Plain words for the person. */
  advice: string;
  /** How much text the AI is given at once on this device (letters). */
  maxInput: number;
}

/**
 * Older graphics chips (no half-precision support, so only q4f32 builds run) are reset by Windows when one piece of AI
 * work runs too long. Measured on such a chip: prompts of a few sentences worked; an email-length prompt
 * (about 160 tokens) stopped Qwen 3.5 0.8B every time (and two other models tried).
 */
export const OLD_CHIP_MAX_INPUT = 600;

export async function checkDevice(): Promise<DeviceCheck> {
  const nav = navigator as Navigator & { gpu?: any; deviceMemory?: number };
  const phone = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  const memoryGb = typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null;
  let adapter: any = null;
  try {
    adapter = nav.gpu ? await nav.gpu.requestAdapter() : null;
  } catch {
    adapter = null;
  }
  if (!adapter) {
    return { webgpu: false, chip: '', memoryGb, phone, maxInput: 0, advice: 'This browser cannot use the graphics chip for AI (it has no WebGPU). Chrome or Edge on a computer usually can; the built-in AI is switched off here.' };
  }
  const chip = [adapter.info?.vendor, adapter.info?.architecture, adapter.info?.description].filter(Boolean).join(' ') || 'graphics chip';
  const oldChip = !adapter.features.has('shader-f16');
  const weak = phone || oldChip || (memoryGb !== null && memoryGb < 8);
  return {
    webgpu: true, chip, memoryGb, phone, maxInput: oldChip ? OLD_CHIP_MAX_INPUT : MAX_INPUT_CHARS,
    advice: oldChip
      ? `This device's graphics chip (${chip}) is an older kind: the built-in AI runs, slowly, and only on short text (a few sentences); longer text can make the chip stop.`
      : weak ? `This device can run the built-in AI, but it is small (${memoryGb ?? '?'} GB, ${phone ? 'a phone or tablet' : chip}): it may be slow, or may not start. On a phone, Claude or ChatGPT in the browser does more; save the result into TOMLIN OS.` : `This device can run the built-in AI on its ${chip}.`,
  };
}

/**
 * Older graphics chips (no half-precision support) are reset by Windows when one step of work runs too long, and the
 * AI then stops with "device lost". Reading the prompt 32 tokens at a time keeps every step short. Measured on an
 * older integrated GPU: the default and 128 crashed, 32 worked (SmolLM2 360M read 10.5 and wrote 6.2 tokens/s).
 */
async function chunkOverride(): Promise<Record<string, number>> {
  try {
    const adapter = await (navigator as Navigator & { gpu?: any }).gpu?.requestAdapter();
    return adapter && !adapter.features.has('shader-f16') ? { prefill_chunk_size: 16 } : {};
  } catch {
    return {};
  }
}

let loading: Promise<any> | null = null;
function webllm(): Promise<any> {
  loading ??= import(new URL('../../../vendor/webllm.js', import.meta.url).href);
  return loading;
}

/** A model as the apps hand it over to start: where its files come from, and whether it is saved on this TOMLIN OS. */
export type LoadableModel = InstalledModel & { saved?: boolean; from?: { model: string; lib: string } | null };

/**
 * How an engine is made, and a model's copy taken out of this browser: WebLLM on the graphics chip. The unit tests
 * put a stand-in here with setEngineParts (Node has no graphics chip).
 */
export interface EngineParts {
  make(model: LoadableModel, onProgress: (fraction: number, text: string) => void): Promise<any>;
  forget(id: string): Promise<void>;
  /**
   * Claims the built-in AI for this page against every other TOMLIN OS tab or window of this browser: a function that
   * gives the claim back, or null when another one holds it.
   */
  claim(): Promise<(() => void) | null>;
}

/**
 * One model in the whole browser, not just in this page: two TOMLIN OS tabs each running a model would ask the graphics
 * chip for both at once.
 */
/** A model file that did not arrive (a dropped connection, a server that failed one request), not the graphics chip. */
export const isDownloadProblem = (words: string): boolean => /on 'Cache'|Failed to fetch|NetworkError|network error|Load failed/i.test(words);
/** Tries at downloading before giving up: files already downloaded are kept, so each try carries on where the last stopped. */
const DOWNLOAD_TRIES = 3;

/**
 * After a model saved on this TOMLIN OS did not download: asks the server for its first files again and says which one it
 * refuses and how (the status names the fault: 404 missing, 401/403 refused, 5xx the server), or '' when all answer.
 */
export async function probeSavedModel(model: Pick<LoadableModel, 'id' | 'lib'>): Promise<string> {
  const files: Array<[string, string]> = [
    ['mlc-chat-config.json', `models/${model.id}/resolve/main/mlc-chat-config.json`],
    ['tensor-cache.json', `models/${model.id}/resolve/main/tensor-cache.json`],
    [model.lib, `models/libs/${model.lib}`],
  ];
  for (const [name, path] of files) {
    const status = await localStatus(path);
    if (status === 0) return `this TOMLIN OS did not answer for ${name}`;
    if (status < 200 || status > 299) return `this TOMLIN OS answered ${status} for ${name}`;
  }
  return '';
}

/**
 * Why a start failed, in words for the person: `button` is what they press to try again ("Start", "Connect");
 * `detail` is what probeSavedModel found, if anything.
 */
export function startProblem(words: string, button: string, fromServer: boolean, detail = ''): string {
  if (words === IN_ANOTHER_TAB) return words;
  if (words === LIB_MISMATCH || words === NO_CHECKSUM) return `It could not start: ${words}.`;
  if (isDownloadProblem(words)) {
    return `It could not start: a file of the model did not download from ${fromServer ? 'this TOMLIN OS' : 'Hugging Face'} (${detail || words}), even after ${DOWNLOAD_TRIES} tries. The parts already downloaded are kept: ${fromServer ? `the owner can remove the model from this TOMLIN OS (the browser then fetches it from Hugging Face), or check the connection and press ${button} again.` : `check the internet connection, then press ${button} again. If it keeps failing, Hugging Face may no longer have this version: the owner can name a model mirror in config.php ('model_mirror'), then press "Save to this TOMLIN OS" for a built-in model.`}`;
  }
  return `It could not start: ${words}. This device may not have enough graphics memory for it: close other tabs and programs, then try again.`;
}

/** WebLLM keeps each model's program in this cache under its address, and runs a copy found there without fetching. */
const LIB_CACHE = 'webllm/wasm';
export const LIB_MISMATCH = 'the model\'s program did not match its pinned checksum, so it was not run (it may have been changed where it is published)';
const hexOf = (buf: ArrayBuffer): string => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');

/**
 * The model's program (WebGPU code that runs in this page) checked against its pinned SHA-256 before WebLLM runs it: a
 * copy already in this browser is checked, and thrown away if it differs; otherwise it is fetched, checked, and put where
 * WebLLM looks first. A program that does not match is never run. (Weights are data, fetched at the pinned commit.)
 */
export async function checkedLib(url: string, sha256: string): Promise<void> {
  const cache = await caches.open(LIB_CACHE);
  const kept = await cache.match(url);
  if (kept) {
    if (hexOf(await crypto.subtle.digest('SHA-256', await kept.arrayBuffer())) === sha256) return;
    await cache.delete(url);
  }
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`the model's program did not download (${res.status}): Failed to fetch`);
  const body = await res.arrayBuffer();
  if (hexOf(await crypto.subtle.digest('SHA-256', body)) !== sha256) throw new Error(LIB_MISMATCH);
  await cache.put(url, new Response(body, { headers: { 'Content-Type': 'application/wasm' } }));
}

export const IN_ANOTHER_TAB ='The built-in AI is already running in another TOMLIN OS tab or window, and only one can run at a time (two would need twice the graphics memory). Disconnect it there, or close that tab, then start it here.';
const NO_CHECKSUM = 'this model\'s program has no checksum to check it against, so it was not run';
const LOCK = 'tomlinos-built-in-ai';
const webllmParts: EngineParts = {
  async make(model, onProgress) {
    const lib = await webllm();
    const origin = location.origin;
    const overrides = { ...model.overrides, ...(await chunkOverride()) };
    const away = model.saved === false && model.from ? model.from : null;
    const libUrl = away ? away.lib : `${origin}/models/libs/${model.lib}`;
    // From outside, only a program with a checksum runs; from this TOMLIN OS, the server's own checksum is used when given.
    if (model.libSha256) await checkedLib(libUrl, model.libSha256);
    else if (away) throw new Error(NO_CHECKSUM);
    const appConfig = {
      model_list: [{ model: away ? away.model : `${origin}/models/${model.id}/`, model_id: model.id, model_lib: libUrl, overrides }],
    };
    return lib.CreateMLCEngine(model.id, { appConfig, initProgressCallback: (r: { progress: number; text: string }) => onProgress(r.progress, r.text) }, overrides);
  },
  async forget(id) {
    const lib = await webllm();
    await lib.deleteModelAllInfoInCache(id, {}).catch(() => undefined);
  },
  // Web Locks are shared by every tab and window of this site in this browser, and let go by themselves when a tab
  // closes or crashes. The lock is held for as long as the model runs.
  claim() {
    const locks = (globalThis.navigator as Navigator & { locks?: any } | undefined)?.locks;
    if (!locks?.request) return Promise.resolve(() => undefined);
    return new Promise(resolve => {
      locks.request(LOCK, { ifAvailable: true }, (lock: unknown) => {
        if (!lock) {
          resolve(null);
          return undefined;
        }
        return new Promise<void>(giveBack => resolve(() => giveBack()));
      }).catch(() => resolve(() => undefined));
    });
  },
};
let parts: EngineParts = webllmParts;
/** Tests only: a stand-in engine (null puts WebLLM back). */
export function setEngineParts(p: EngineParts | null): void {
  parts = p ?? webllmParts;
}

/**
 * The built-in AI running in this page: one model at a time, shared by every app that uses it. Moving from one view
 * to another shows "Already connected" and the chat so far, never a second download. So Chat › Agents (on the Panel's Overview or in a Chat window) and the Assistant no
 * longer each start their own copy (a second wait, and twice the graphics memory): a model started in one is running
 * for all of them, and another model chosen in any of them replaces it for all. It keeps running while any app that
 * uses it is open. Answers are written one at a time.
 */
interface PageAI {
  model: LoadableModel | null;
  engine: any;
  /** The model being started (by any app), and what ends when it has (or has failed). */
  starting: { model: LoadableModel; done: Promise<void>; progress: Set<(fraction: number, text: string) => void> } | null;
  /** Apps open that use it (one OnDevice each). */
  users: number;
  /** An app's "don't keep the model in this browser": the copy is deleted when the model stops. */
  forget: boolean;
  /** Answers are written one after another. */
  queue: Promise<unknown>;
  /** The app whose answer is being written (Stop stops only your own). */
  writer: OnDevice | null;
  /** Gives back the claim on the built-in AI that other tabs see. */
  release: (() => void) | null;
  /** Why the model last stopped, for the words the apps show. */
  stopped: StopReason | null;
  /** The model that stopped last, so it can be started again by itself (after "Disconnect when idle"). */
  lastModel: LoadableModel | null;
  /** When a question was last asked or answered (or the model started), in milliseconds. */
  lastUsed: number;
  /** Questions asked and not yet answered (waiting or being written). */
  asking: number;
}
/**
 * disconnect: someone pressed Disconnect; lost: the graphics chip was reset; closed: the last app using it closed;
 * idle: "Disconnect when idle" stopped it after a while without a question.
 */
export type StopReason = 'disconnect' | 'lost' | 'closed' | 'replaced' | 'idle';
const page: PageAI = { model: null, engine: null, starting: null, users: 0, forget: false, queue: Promise.resolve(), writer: null, release: null, stopped: null, lastModel: null, lastUsed: 0, asking: 0 };
const watchers = new Set<() => void>();
function changed(): void {
  for (const fn of [...watchers]) fn();
}

// "Disconnect when idle": one timer for the whole page, set by whichever app changes the setting.
let idleMs: number | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
function used(): void {
  page.lastUsed = Date.now();
  armIdle();
}
function armIdle(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (idleMs === null || !page.engine) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    void idleCheck();
  }, Math.max(250, page.lastUsed + idleMs - Date.now()));
  (idleTimer as { unref?: () => void }).unref?.();
}
async function idleCheck(): Promise<void> {
  if (idleMs === null || !page.engine) return;
  if (page.asking > 0 || page.starting || Date.now() - page.lastUsed < idleMs) return armIdle();
  await stopEngine('idle');
}

async function stopEngine(why: StopReason): Promise<void> {
  const { engine, model, forget, release } = page;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  page.lastModel = model ?? page.lastModel;
  page.engine = null;
  page.model = null;
  page.forget = false;
  page.release = null;
  page.stopped = why;
  release?.();
  changed();
  await engine?.unload?.().catch(() => undefined);
  if (forget && model) await parts.forget(model.id);
}

export class OnDevice {
  private done = false;

  constructor() {
    page.users++;
  }

  /** The model running in this page, whichever app started it; null when none is. */
  static running(): LoadableModel | null {
    return page.engine ? page.model : null;
  }

  /**
   * "Disconnect when idle": after `minutes` without a question the model stops for the whole page and its graphics
   * memory is freed (its files stay in this browser, so it starts again quickly). null: it keeps running.
   */
  static idleAfter(minutes: number | null): void {
    idleMs = minutes === null ? null : Math.max(0.01, minutes) * 60_000;
    armIdle();
  }

  /** The model that last stopped (any reason), to start the same one again; null before any has. */
  static lastModel(): LoadableModel | null {
    return page.lastModel;
  }

  /** `fn` is called whenever a model starts or stops in this page, until `signal` ends. */
  static watch(fn: () => void, signal: AbortSignal): void {
    watchers.add(fn);
    signal.addEventListener('abort', () => watchers.delete(fn), { once: true });
  }

  /** The model running in this page (the same for every app). */
  get model(): LoadableModel | null {
    return OnDevice.running();
  }

  get ready(): boolean {
    return page.engine !== null;
  }

  /**
   * Starts a model for this page. The one already running is picked up at once; one another app is starting is
   * waited for; a different one replaces it for every app (with `forgetOld`, the old one's copy also leaves this
   * browser). The first time, its files come from this TOMLIN OS when saved here, otherwise from `from` (Hugging Face);
   * later, from this browser's copy.
   */
  async load(model: LoadableModel, onProgress: (fraction: number, text: string) => void, forgetOld = false): Promise<void> {
    if (page.engine && page.model?.id === model.id) return;
    if (page.starting?.model.id === model.id) {
      page.starting.progress.add(onProgress);
      return page.starting.done;
    }
    if (page.starting) await page.starting.done.catch(() => undefined);
    if (page.engine && page.model?.id === model.id) return;
    if (page.engine) {
      page.forget ||= forgetOld;
      await stopEngine('replaced');
    }
    const progress = new Set([onProgress]);
    const done = (async () => {
      const release = await parts.claim();
      if (!release) {
        page.starting = null;
        changed();
        throw new Error(IN_ANOTHER_TAB);
      }
      try {
        const report = (fraction: number, text: string) => progress.forEach(fn => fn(fraction, text));
        // A model from Hugging Face is hundreds of MB over the internet: one failed file must not end the start.
        for (let attempt = 1; ; attempt++) {
          try {
            page.engine = await parts.make(model, report);
            break;
          } catch (error) {
            const words = error instanceof Error ? error.message : String(error);
            if (attempt >= DOWNLOAD_TRIES || !isDownloadProblem(words)) throw error;
            report(0, `A file of the model did not download; trying again (${attempt + 1} of ${DOWNLOAD_TRIES}), carrying on from what arrived...`);
            await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
          }
        }
        page.model = model;
        page.release = release;
        page.stopped = null;
        used();
      } catch (error) {
        release();
        throw error;
      } finally {
        page.starting = null;
        changed();
      }
    })();
    page.starting = { model, done, progress };
    changed();
    return done;
  }

  /**
   * Streams an answer. `onText` gets the whole answer so far (thinking removed). Returns the finished answer;
   * `looped` when it was stopped for repeating itself. Waits while another app's answer is being written.
   */
  ask(turns: ChatTurn[], onText: (text: string) => void, maxTokens = MAX_ANSWER): Promise<{ text: string; tokens: number; perSecond: number; looped: boolean }> {
    page.asking++;
    used();
    const run = page.queue.then(() => this.write(turns, onText, maxTokens)).finally(() => {
      page.asking = Math.max(0, page.asking - 1);
      used();
    });
    page.queue = run.catch(() => undefined);
    return run;
  }

  private async write(turns: ChatTurn[], onText: (text: string) => void, maxTokens: number): Promise<{ text: string; tokens: number; perSecond: number; looped: boolean }> {
    const engine = page.engine;
    if (!engine) throw new Error('The built-in AI is not started.');
    page.writer = this;
    try {
      const style = chatStyle(page.model?.id ?? '');
      const stream = await engine.chat.completions.create({
        messages: turnsFor(turns, style), stream: true, max_tokens: maxTokens, stream_options: { include_usage: true },
        ...style.sampling,
      } as any);
      let raw = '';
      let usage: any = null;
      let kept: string | null = null;
      for await (const chunk of stream) {
        raw += chunk.choices?.[0]?.delta?.content ?? '';
        if (chunk.usage) usage = chunk.usage;
        if (kept !== null) continue; // stopped for repeating: the rest of the stream is only the engine winding down
        const visible = visibleText(raw);
        kept = repeatCut(visible);
        if (kept !== null) {
          engine.interruptGenerate?.();
          onText(kept);
        } else onText(visible);
      }
      return { text: kept ?? visibleText(raw), tokens: usage?.completion_tokens ?? 0, perSecond: usage?.extra?.decode_tokens_per_s ?? 0, looped: kept !== null };
    } finally {
      if (page.writer === this) page.writer = null;
    }
  }

  /** Stops the answer this app is waiting for; another app's answer carries on. */
  stop(): void {
    if (page.writer === this) page.engine?.interruptGenerate?.();
  }

  /**
   * This app is done with the built-in AI (it is closing). The model keeps running while another app uses it; the
   * last one out stops it, and with `forget` (this app's or an earlier one's) its copy leaves this browser too.
   */
  async unload(forget = false): Promise<void> {
    if (this.done) return;
    this.done = true;
    page.users = Math.max(0, page.users - 1);
    page.forget ||= forget;
    if (page.users > 0) return;
    if (page.starting) await page.starting.done.catch(() => undefined);
    if (page.users > 0) return; // another app opened while it was starting
    if (page.engine) await stopEngine('closed');
    else page.forget = false;
  }

  /**
   * The graphics chip was reset (Windows resets older chips when one piece of work runs too long): the model is gone
   * for every app, and is started again from any of them.
   */
  async lost(): Promise<void> {
    if (page.engine) await stopEngine('lost');
  }

  /**
   * Disconnect: the model stops for every app on this desktop
   * and its graphics memory is freed; the conversation stays. Its files stay in this browser for a quick start next
   * time, unless `forget`.
   */
  async disconnect(forget = false): Promise<void> {
    if (page.starting) await page.starting.done.catch(() => undefined);
    if (!page.engine) return;
    page.forget ||= forget;
    await stopEngine('disconnect');
  }

  /** Why the model last stopped (null while one runs, or before any has). */
  static lastStop(): StopReason | null {
    return page.engine ? null : page.stopped;
  }
}

// ---- Text helpers --------------------------------------------------------------------------------------------------

/** Some models write their reasoning between <think> tags first; people see only the answer. */
export function visibleText(raw: string): string {
  return raw.replace(/<think>[\s\S]*?<\/think>\s*/g, '').replace(/<think>[\s\S]*$/, '').trimStart();
}

/**
 * A small model can fall into a loop, writing the same paragraph again and again until its allowance runs out (one
 * test: the same paragraph, eight times). Returns the answer cut before the repeat once a finished
 * paragraph comes round a second time, or a sentence a third time; null while it is not repeating.
 */
export function repeatCut(text: string): string | null {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  // Paragraphs: all but the last are finished.
  const paras = text.split(/\n\s*\n/);
  const seen = new Set<string>();
  for (let i = 0; i < paras.length - 1; i++) {
    const p = norm(paras[i]);
    if (p.length < 30) continue;
    if (seen.has(p)) return paras.slice(0, i).join('\n\n').trimEnd();
    seen.add(p);
  }
  // Sentences (a loop inside one paragraph).
  const counts = new Map<string, number>();
  const secondAt = new Map<string, number>();
  for (const m of text.matchAll(/[^.!?\n]+[.!?]/g)) {
    const s = norm(m[0]);
    if (s.length < 25) continue;
    const n = (counts.get(s) ?? 0) + 1;
    counts.set(s, n);
    if (n === 2) secondAt.set(s, m.index);
    // A third time shows the loop; the answer is kept up to where the second began.
    if (n === 3) return text.slice(0, secondAt.get(s)).trimEnd();
  }
  return null;
}

/** A small model reads about 4,000 tokens at once (roughly 12,000 letters with the question and answer). */
export const MAX_INPUT_CHARS = 9000;

/** Cuts long text to what the model can read, and says so. */
export function fitText(text: string, max = MAX_INPUT_CHARS): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  const head = text.slice(0, max);
  const at = Math.max(head.lastIndexOf('\n\n'), head.lastIndexOf('. '));
  return { text: head.slice(0, at > max * 0.7 ? at + 1 : max), cut: true };
}

export const SYSTEM_PROMPT = 'You are a friendly helper inside TOMLIN OS, a desktop in the browser. Talk like a person, not a help desk: when someone just says hello, say hello back and ask how their day is going or what they are up to, in one short line. Otherwise answer clearly and briefly in plain language. If you are not sure, say so.';

/** The prompt for each quick button. */
export function jobPrompt(job: 'summarise' | 'rewrite' | 'ask', text: string, question = ''): string {
  if (job === 'summarise') return `Summarise the following in a few short bullet points:\n\n${text}`;
  if (job === 'rewrite') return `Rewrite the following so it is clear, polite and complete. Keep the meaning and keep it short. Reply with the rewritten text only.\n\n${text}`;
  return `Here is a file:\n\n${text}\n\nQuestion about the file: ${question}\nAnswer from the file only. If the file does not say, say so.`;
}

/** The system prompt with today's date: the model knows only the date its training ended, and guessed a year-old one. */
export function systemPrompt(now = new Date()): string {
  // Small models repeat whatever comes last in their instructions, so the date is marked as background.
  return `${SYSTEM_PROMPT} Mention the date only when asked. Today is ${now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}.`;
}

/** The conversation to send: the system prompt, then as many recent turns as fit. */
export function trimHistory(turns: ChatTurn[], maxChars = 10000, now = new Date()): ChatTurn[] {
  const out: ChatTurn[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    used += turns[i].content.length;
    if (used > maxChars && out.length) break;
    out.unshift(turns[i]);
  }
  return [{ role: 'system', content: systemPrompt(now) }, ...out];
}
