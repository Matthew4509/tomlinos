// Which store apps (server/lib/appstore.php) this person has added to their desktop: a short list in their own files, so
// it follows them to every device and never changes anyone else's desktop. A missing or damaged list means none. An
// app on the list that is not on this server (deleted by the owner) is simply not shown.
import type { FileSystem } from '../fs/fs.ts';

export const INSTALLED_PATH = '/System/apps.json';

/** A store app's id, as the server checks it: lower-case letters and digits. */
export const isStoreId = (id: unknown): id is string => typeof id === 'string' && /^[a-z][a-z0-9]{1,30}$/.test(id);

/** Only names that can be store apps, once each; anything else in the file is ignored. */
export function cleanInstalled(raw: unknown): string[] {
  const list = raw && typeof raw === 'object' ? (raw as { installed?: unknown }).installed : null;
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter(isStoreId))];
}

export async function readInstalled(fs: FileSystem): Promise<string[]> {
  try {
    return cleanInstalled(JSON.parse(await fs.readText(INSTALLED_PATH)));
  } catch {
    return [];
  }
}

export async function writeInstalled(fs: FileSystem, ids: string[]): Promise<void> {
  await fs.ensureFolder('/System', { hidden: true });
  await fs.writeText(INSTALLED_PATH, JSON.stringify({ installed: cleanInstalled({ installed: ids }) }), { hidden: true });
}
