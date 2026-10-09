// Finding more on-device models on Hugging Face, and the person's own list of the ones they added (kept in their files,
// /System/ai-models.json). Only models in MLC's format (the one WebLLM runs; Hugging Face tags them "mlc-llm") are
// searched, and a result can be added only when it is the same kind of model as one of the MLC team's own WebGPU
// programs (modellibs.ts): that program runs it, never code from the model's own repository. The search itself is
// what the person asks for: words, then drop-down filters (size, kind of compression, order). It does not guess what
// a computer can run.
//
// Everything here talks to huggingface.co from the browser (the page's security policy allows it); the text helpers
// are plain functions, tested in Node with a stand-in for fetch.
import type { FileSystem } from '../../fs/fs.ts';
import { MODEL_LIBS, type ModelLib } from './modellibs.ts';
import { BUILT_IN_MODELS, nameAddedModels, type InstalledModel } from './engine.ts';

export const HF = 'https://huggingface.co';
/** A repository name as Hugging Face makes them: owner/name, each starting with a letter or digit (never ".."). */
const REPO = /^[A-Za-z0-9][\w.-]{0,95}\/[A-Za-z0-9][\w.-]{0,95}$/;
const GB = 1024 ** 3;

export const SIZE_FILTERS = [
  { id: 'any', label: 'Any size', max: Infinity },
  { id: '1', label: 'Under 1 GB', max: 1 * GB },
  { id: '2', label: 'Under 2 GB', max: 2 * GB },
  { id: '4', label: 'Under 4 GB', max: 4 * GB },
  { id: '8', label: 'Under 8 GB', max: 8 * GB },
] as const;

export const KIND_FILTERS = [
  { id: 'any', label: 'Any kind' },
  { id: 'q4f32', label: 'q4f32 (runs on older graphics chips too)' },
  { id: 'q4f16', label: 'q4f16 (newer graphics chips only)' },
] as const;

export const SORTS = [
  { id: 'downloads', label: 'Most downloaded' },
  { id: 'likes', label: 'Most liked' },
  { id: 'lastModified', label: 'Newest' },
] as const;

export interface Filters {
  size: (typeof SIZE_FILTERS)[number]['id'];
  kind: (typeof KIND_FILTERS)[number]['id'];
  sort: (typeof SORTS)[number]['id'];
}

/** One repository the search found (before its details are read). */
export interface Listed {
  repo: string;
  downloads: number;
  likes: number;
  updated: string;
}

/** A found model with its details read. */
export interface Found extends Listed {
  name: string;
  uploader: string;
  bytes: number;
  quant: string;
  type: string;
  context: number | null;
  /** The MLC program that runs it; null when none does (it cannot start in TOMLIN OS). */
  lib: ModelLib | null;
}

type Fetch = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * The search's addresses on Hugging Face, in the order chosen: MLC-tagged models with the words typed, and (as not every
 * uploader tags them) models with the words and "mlc" in their names.
 */
export function searchUrls(query: string, sort: Filters['sort'], limit = 100): string[] {
  const words = query.trim().slice(0, 100);
  const make = (tagged: boolean) => {
    const q = new URLSearchParams({ sort, direction: '-1', limit: String(limit) });
    if (tagged) q.set('filter', 'mlc-llm');
    // Hugging Face matches every word: "mlc" added finds the untagged uploads named for MLC.
    if (words) q.set('search', tagged ? words : `${words} mlc`);
    return `${HF}/api/models?${q}`;
  };
  return words ? [make(true), make(false)] : [make(true)];
}

const rowsOf = (rows: unknown): Listed[] => (Array.isArray(rows) ? rows : []).flatMap((r: Record<string, unknown>) => {
  const repo = typeof r.id === 'string' ? r.id : typeof r.modelId === 'string' ? r.modelId : '';
  if (!REPO.test(repo)) return [];
  return [{ repo, downloads: Number(r.downloads) || 0, likes: Number(r.likes) || 0, updated: String(r.lastModified ?? r.createdAt ?? '') }];
});

/** The repositories matching the words, in the order chosen, each once (Hugging Face gives at most `limit` a search). */
export async function searchHF(query: string, sort: Filters['sort'], fetchFn: Fetch = fetch): Promise<Listed[]> {
  const [tagged, named] = searchUrls(query, sort);
  const res = await fetchFn(tagged);
  if (!res.ok) throw new Error(`Hugging Face did not answer the search (${res.status}). Try again in a minute.`);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error('Hugging Face answered the search with something unexpected.');
  const found = rowsOf(rows);
  if (named) {
    try {
      const more = await fetchFn(named);
      if (more.ok) found.push(...rowsOf(await more.json()).filter(r => /mlc/i.test(r.repo)));
    } catch {
      // The tagged ones are enough to show.
    }
  }
  const seen = new Set<string>();
  const key = sort === 'likes' ? 'likes' : sort === 'lastModified' ? 'updated' : 'downloads';
  return found.filter(r => !seen.has(r.repo) && seen.add(r.repo)).sort((a, b) => (key === 'updated' ? b.updated.localeCompare(a.updated) : b[key] - a[key]));
}

/** The sizes a program is compiled for (the same rule as tools/model-libs.mjs). */
export function libKey(config: { model_type?: unknown; quantization?: unknown; model_config?: Record<string, unknown> }): string {
  const c = config.model_config ?? {};
  const pick = ['hidden_size', 'intermediate_size', 'num_hidden_layers', 'num_attention_heads', 'num_key_value_heads', 'head_dim', 'vocab_size'];
  return [config.model_type, config.quantization, ...pick.map(k => c[k] ?? '')].join('|');
}

/** The MLC program that runs a model with this config, or null. */
export function libFor(config: Parameters<typeof libKey>[0]): ModelLib | null {
  const key = libKey(config);
  return MODEL_LIBS.find(l => l.key === key) ?? null;
}

/** A readable name from a repository's ("Qwen3.5-2B-q4f32_1-MLC" -> "Qwen3.5 2B"). */
export function niceName(repo: string): string {
  const base = repo.split('/').pop() ?? repo;
  return base.replace(/[-_]MLC$/i, '').replace(/[-_]q\d+f\d+(_\d+)?$/i, '').replace(/-(\d+(\.\d+)?[BM])\b/g, ' $1').replace(/[-_]+/g, ' ').trim() || base;
}

/** Reads a found repository's config and size. A repository that cannot be read comes back with no program. */
export async function describe(item: Listed, fetchFn: Fetch = fetch): Promise<Found> {
  const [uploader] = item.repo.split('/');
  const found: Found = { ...item, name: niceName(item.repo), uploader, bytes: 0, quant: '', type: '', context: null, lib: null };
  try {
    const [cfgRes, treeRes] = await Promise.all([
      fetchFn(`${HF}/${item.repo}/resolve/main/mlc-chat-config.json`),
      fetchFn(`${HF}/api/models/${item.repo}/tree/main`),
    ]);
    if (cfgRes.ok) {
      const config = (await cfgRes.json()) as Parameters<typeof libKey>[0] & { context_window_size?: unknown };
      found.quant = String(config.quantization ?? '');
      found.type = String(config.model_type ?? '');
      found.context = Number(config.context_window_size) || null;
      found.lib = libFor(config);
    }
    if (treeRes.ok) {
      const files = await treeRes.json();
      if (Array.isArray(files)) {
        found.bytes = files.reduce((sum: number, f: { type?: string; path?: string; size?: number; lfs?: { size?: number } }) =>
          f.type === 'file' && /\.(bin|json|txt|model)$/.test(f.path ?? '') && !String(f.path).startsWith('.') ? sum + (Number(f.lfs?.size ?? f.size) || 0) : sum, 0);
      }
    }
  } catch {
    // Unreadable: shown as one that cannot start.
  }
  return found;
}

/** Whether a described model passes the size and kind filters. */
export function passes(m: Found, f: Pick<Filters, 'size' | 'kind'>): boolean {
  const max = SIZE_FILTERS.find(s => s.id === f.size)?.max ?? Infinity;
  // A size limit needs a known size: one Hugging Face did not list is left out rather than guessed.
  if (max !== Infinity && !(m.bytes > 0 && m.bytes <= max)) return false;
  if (f.kind !== 'any' && !m.quant.startsWith(f.kind)) return false;
  return true;
}

// ---- The person's own models ----------------------------------------------------------------------------------------

export const MY_MODELS_PATH = '/System/ai-models.json';

/** A model a person added from Hugging Face: fetched from there by their browser, never saved on the server. */
export interface MyModel {
  id: string;
  repo: string;
  name: string;
  uploader: string;
  bytes: number;
  vram: number;
  quant: string;
  context: number | null;
  lib: string;
  added: number;
}

/** The id WebLLM keeps it under: the repository with "--" for "/" (never the same as a built-in model's). */
export const myModelId = (repo: string): string => `hf--${repo.replace('/', '--')}`;

export function toMyModel(m: Found, now = Date.now()): MyModel | null {
  if (!m.lib) return null;
  return { id: myModelId(m.repo), repo: m.repo, name: m.name, uploader: m.uploader, bytes: m.bytes, vram: m.lib.vram, quant: m.quant, context: m.context, lib: m.lib.lib, added: now };
}

/** The MLC program a saved address names, by its file name (addresses saved before programs were pinned still match). */
const libNamed = (url: string): ModelLib | undefined => {
  const name = url.split('/').pop();
  return MODEL_LIBS.find(l => l.lib.split('/').pop() === name);
};

/** Only rows that still make sense: a known MLC program (at its pinned address), a plain repository name. */
export function cleanMyModels(raw: unknown): MyModel[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r: Partial<MyModel>) => {
    const repo = String(r?.repo ?? '');
    const lib = /^https:\/\/raw\.githubusercontent\.com\/mlc-ai\/binary-mlc-llm-libs\//.test(String(r?.lib)) ? libNamed(String(r.lib)) : undefined;
    if (!REPO.test(repo) || !lib) return [];
    return [{
      id: myModelId(repo), repo, name: String(r.name ?? niceName(repo)).slice(0, 80), uploader: repo.split('/')[0],
      bytes: Number(r.bytes) || 0, vram: Number(r.vram) || 0, quant: String(r.quant ?? '').slice(0, 20),
      context: Number(r.context) || null, lib: lib.lib, added: Number(r.added) || 0,
    }];
  }).slice(0, 50);
}

export async function readMyModels(fs: FileSystem): Promise<MyModel[]> {
  let list: MyModel[] = [];
  try {
    list = cleanMyModels(JSON.parse(await fs.readText(MY_MODELS_PATH)));
  } catch {
    list = [];
  }
  nameAddedModels(list.map(m => ({ id: m.id, name: m.name, maker: `${m.uploader} on Hugging Face` })));
  return list;
}

export async function writeMyModels(fs: FileSystem, list: MyModel[]): Promise<void> {
  await fs.ensureFolder('/System', { hidden: true });
  await fs.writeText(MY_MODELS_PATH, JSON.stringify(list, null, 1), { hidden: true });
  nameAddedModels(list.map(m => ({ id: m.id, name: m.name, maker: `${m.uploader} on Hugging Face` })));
}

/** One of the person's models as the engine starts it: always fetched from Hugging Face by this browser. */
export function loadableFor(m: MyModel): InstalledModel & { saved: false; from: { model: string; lib: string } } {
  const context = Math.min(m.context ?? 4096, 4096);
  return {
    id: m.id, lib: m.lib.split('/').pop() ?? m.lib, bytes: m.bytes, vram: m.vram, context,
    overrides: { context_window_size: context }, libSha256: libNamed(m.lib)?.sha256,
    saved: false, from: { model: `${HF}/${m.repo}`, lib: m.lib },
  };
}

/** True when a repository is one of the built-in models (it is offered already). */
export const isBuiltIn = (repo: string): boolean => BUILT_IN_MODELS.some(b => repo === `mlc-ai/${b.id}`);
