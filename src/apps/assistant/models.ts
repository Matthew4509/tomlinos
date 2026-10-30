// Which built-in models this TOMLIN OS offers, whether each is saved here (browsers then get it from this TOMLIN OS) or not
// (browsers fetch it from Hugging Face, where its makers publish it), and the owner's Save / Remove
// (server/api/models.php). Without the server (the browser-only copy) only models/models.json is read.
import type { Identity } from '../../auth/identity.ts';
import { readLocalJson } from '../../core/local.ts';
import type { ServiceApi } from '../../net/service.ts';
import type { FileSystem } from '../../fs/fs.ts';
import { BUILT_IN_MODELS, modelName, type InstalledModel } from './engine.ts';
import { loadableFor, readMyModels } from './hfsearch.ts';

export interface ModelInfo extends InstalledModel {
  name: string;
  /** Kept on this TOMLIN OS. */
  saved: boolean;
  /** A save in progress (or stopped part-way): bytes held and in all. */
  saving: { have: number; total: number } | null;
  /** Seconds until it can be saved here again (a removed model waits a day), or 0. */
  resaveWait?: number;
  /** Where a browser fetches it when it is not saved here. */
  from: { model: string; lib: string } | null;
  /** One the person added from Hugging Face themselves (Find AI models): never saved on the server. */
  mine?: boolean;
}

/** A model this TOMLIN OS no longer offers but still holds (the owner can remove it). */
export interface RetiredModel {
  id: string;
  name: string;
  bytes: number;
}

export interface ModelList {
  models: ModelInfo[];
  retired: RetiredModel[];
  /** The owner may save and remove models. */
  owner: boolean;
  /** Bytes free on the server, when it says. */
  free: number | null;
}

export async function listModels(api: ServiceApi | null): Promise<ModelList> {
  if (api) {
    try {
      const r = await api.call<{ models: Array<ModelInfo & { retired?: boolean }>; owner: boolean; free: number | null }>('list');
      return {
        ...r,
        models: r.models.filter(m => !m.retired && BUILT_IN_MODELS.some(b => b.id === m.id)),
        retired: r.models.filter(m => m.retired).map(m => ({ id: m.id, name: m.name, bytes: m.bytes })),
      };
    } catch {
      // An older server without models.php, or none reachable: what the models folder says.
    }
  }
  try {
    const installed = (await readLocalJson<{ models: InstalledModel[] }>('models/models.json')).models ?? [];
    const models = BUILT_IN_MODELS.map(b => installed.find(m => m.id === b.id)).filter((m): m is InstalledModel => !!m);
    return { models: models.map(m => ({ ...m, name: modelName(m.id), saved: true, saving: null, from: null })), retired: [], owner: false, free: null };
  } catch {
    return { models: [], retired: [], owner: false, free: null };
  }
}

/**
 * The owner's Save: asks the server for one piece after another until the model is saved, or `stop()` returns true,
 * or the server refuses (its words are thrown). `onProgress` gets bytes held and in all after each piece. `who` (the
 * owner's password and code) goes with the first piece only: the server asks for it to start a save, not to carry one on.
 */
export async function saveModel(api: ServiceApi, id: string, onProgress: (have: number, total: number) => void, stop: () => boolean, who: Identity | null = null): Promise<boolean> {
  for (let first = true; ; first = false) {
    const r = await api.call<{ saved: boolean; have?: number; total?: number }>('piece', { body: { id, ...(first ? who : null) } });
    if (typeof r.have === 'number' && typeof r.total === 'number') onProgress(r.have, r.total);
    if (r.saved) return true;
    if (stop()) return false;
  }
}

export async function removeModel(api: ServiceApi, id: string, who: Identity): Promise<void> {
  await api.call('remove', { body: { id, ...who } });
}

/** Where a model comes from, in words for the person. */
export function sourceWords(m: ModelInfo, mb: (bytes: number) => string): string {
  if (m.saved) return `Saved on this TOMLIN OS (${mb(m.bytes)}): browsers get it from here.`;
  const part = m.saving && m.saving.total ? ` A save to this TOMLIN OS stopped at ${Math.round((m.saving.have / m.saving.total) * 100)}%.` : '';
  return m.from
    ? `Not saved on this TOMLIN OS: this browser fetches it from Hugging Face (${mb(m.bytes)}) the first time it starts, then keeps a copy.${part}`
    : 'Not saved on this TOMLIN OS.';
}

/** The built-in models followed by the ones this person added from Hugging Face (Find AI models). */
export async function withMyModels(list: ModelInfo[], fs: FileSystem): Promise<ModelInfo[]> {
  const mine = await readMyModels(fs);
  return [...list, ...mine.map(m => ({ ...loadableFor(m), name: m.name, saving: null, mine: true }))];
}
