// Each person's own choices about the AI models, kept in their files (/System/ai-prefs.json): favourites (listed first
// in Chat › Agents, the first one chosen when nothing else is), models hidden from the list, and whether the built-in
// AI disconnects by itself when it has not been used for a while (freeing its graphics memory).
import type { FileSystem } from '../../fs/fs.ts';

export const PREFS_PATH = '/System/ai-prefs.json';
/** Minutes without a question before "Disconnect when idle" stops the built-in AI. */
export const IDLE_MINUTES = 10;

export interface AiPrefs {
  /** Model ids, in the order they were starred. */
  favourites: string[];
  /** Model ids left out of the list in Chat › Agents. */
  hidden: string[];
  idleDisconnect: boolean;
}

export const NO_PREFS: AiPrefs = { favourites: [], hidden: [], idleDisconnect: false };

const ID = /^[\w.-]{1,200}$/;
const ids = (raw: unknown): string[] => (Array.isArray(raw) ? [...new Set(raw.filter((x): x is string => typeof x === 'string' && ID.test(x)))].slice(0, 100) : []);

/** Only what makes sense: model ids, each once, and a yes/no. */
export function cleanPrefs(raw: unknown): AiPrefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const favourites = ids(r.favourites);
  return { favourites, hidden: ids(r.hidden).filter(id => !favourites.includes(id)), idleDisconnect: r.idleDisconnect === true };
}

export async function readPrefs(fs: FileSystem): Promise<AiPrefs> {
  try {
    return cleanPrefs(JSON.parse(await fs.readText(PREFS_PATH)));
  } catch {
    return { ...NO_PREFS, favourites: [], hidden: [] };
  }
}

export async function writePrefs(fs: FileSystem, prefs: AiPrefs): Promise<void> {
  await fs.ensureFolder('/System', { hidden: true });
  await fs.writeText(PREFS_PATH, JSON.stringify(cleanPrefs(prefs), null, 1), { hidden: true });
}

/** Starred or not; a starred model is never hidden. */
export function withFavourite(prefs: AiPrefs, id: string, on: boolean): AiPrefs {
  const favourites = prefs.favourites.filter(x => x !== id);
  if (on) favourites.push(id);
  return { ...prefs, favourites, hidden: on ? prefs.hidden.filter(x => x !== id) : prefs.hidden };
}

/** Hidden or shown; hiding a model takes its star off. */
export function withHidden(prefs: AiPrefs, id: string, on: boolean): AiPrefs {
  const hidden = prefs.hidden.filter(x => x !== id);
  if (on) hidden.push(id);
  return { ...prefs, hidden, favourites: on ? prefs.favourites.filter(x => x !== id) : prefs.favourites };
}

/**
 * The models as the list shows them: favourites first (in the order starred), then the rest in their usual order;
 * hidden ones left out, except `keep` (the one running or chosen, which must stay visible). When every model would be
 * hidden, all are shown, so the list is never empty by mistake.
 */
export function orderModels<T extends { id: string }>(models: T[], prefs: AiPrefs, keep: string | null = null): T[] {
  const shown = models.filter(m => !prefs.hidden.includes(m.id) || m.id === keep);
  const list = shown.length ? shown : models;
  const fav = prefs.favourites.map(id => list.find(m => m.id === id)).filter((m): m is T => !!m);
  return [...fav, ...list.filter(m => !prefs.favourites.includes(m.id))];
}
