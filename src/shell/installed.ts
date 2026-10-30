// Which store apps (server/lib/appstore.php) this person has added to their desktop: a short list in their own files, so
// it follows them to every device and never changes anyone else's desktop. A missing or damaged list means none. An
// app on the list that is not on this server (deleted by the owner) is simply not shown.
import { FileChanged, FsError, type FileSystem } from '../fs/fs.ts';

export const INSTALLED_PATH = '/System/apps.json';

/**
 * The copy of the list each file system last read strictly (its id; '' when there was none), so the write that follows
 * replaces exactly that copy: a list another tab saved in between is not written over, but refused (FileChanged) and read
 * again. Never read strictly: the write replaces whatever is there.
 */
const readCopy = new WeakMap<FileSystem, string>();

/** A store app's id, as the server checks it: lower-case letters and digits. */
export const isStoreId = (id: unknown): id is string => typeof id === 'string' && /^[a-z][a-z0-9]{1,30}$/.test(id);

/** Only names that can be store apps, once each; anything else in the file is ignored. */
export function cleanInstalled(raw: unknown): string[] {
  const list = raw && typeof raw === 'object' ? (raw as { installed?: unknown }).installed : null;
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter(isStoreId))];
}

/**
 * `strict` (before changing the list): a list that is there but could not be read (the server out of reach, say) throws,
 * so the change is not saved over it. Otherwise it reads as none, for showing.
 */
export async function readInstalled(fs: FileSystem, strict = false): Promise<string[]> {
  let text: string;
  try {
    if (strict) {
      const entry = await fs.stat(INSTALLED_PATH);
      readCopy.set(fs, entry?.id ?? '');
      if (!entry) return [];
    }
    text = await fs.readText(INSTALLED_PATH);
  } catch (error) {
    if (strict && !(error instanceof FsError)) throw error;
    return [];
  }
  try {
    return cleanInstalled(JSON.parse(text));
  } catch {
    return [];
  }
}

/** Writes the list over the copy last read strictly (see above), or over whatever is there when none was. */
export async function writeInstalled(fs: FileSystem, ids: string[]): Promise<void> {
  await fs.ensureFolder('/System', { hidden: true });
  const id = readCopy.get(fs);
  const over = id === undefined ? {} : id ? { replacing: id } : { mustBeNew: true };
  const saved = await fs.writeText(INSTALLED_PATH, JSON.stringify({ installed: cleanInstalled({ installed: ids }) }), { hidden: true, ...over });
  if (id !== undefined) readCopy.set(fs, saved.id);
}

/**
 * Changes the list on top of the copy there now, so two tabs adding different apps keep both: a copy saved in between
 * is read again and the change redone.
 */
export async function changeInstalled(fs: FileSystem, apply: (ids: Set<string>) => void): Promise<string[]> {
  for (let attempt = 1; ; attempt++) {
    const ids = new Set(await readInstalled(fs, true));
    apply(ids);
    try {
      await writeInstalled(fs, [...ids]);
      return [...ids];
    } catch (error) {
      const raced = error instanceof FileChanged || (readCopy.get(fs) === '' && error instanceof FsError && (await fs.stat(INSTALLED_PATH)) !== null);
      if (!raced || attempt >= 5) throw error;
    }
  }
}
