// A file that holds a list of records (Calendar.ics, Contacts.vcf), shared by the apps that edit it and by the
// reminders. Every change reads the file again first and applies just that one change, so two windows or devices
// never undo each other's other records. Reads are capped, so a huge or wrong file is refused in words, not loaded.
import type { Bus } from '../core/bus.ts';
import { formatSize } from '../core/format.ts';
import type { FileSystem } from '../fs/fs.ts';
import { FileChanged, FsError } from '../fs/fs.ts';
import { nameKey, parentPath } from '../fs/names.ts';

export const MAX_RECORD_FILE = 4 * 1024 * 1024;

export interface RecordFile<T> {
  readonly path: string;
  /** The records, or [] when the file does not exist yet. Throws (in words) for a file too big or unreadable. */
  load(): Promise<T[]>;
  /** Reads again, applies one change, writes. Returns the new list. */
  change(apply: (list: T[]) => T[]): Promise<T[]>;
  /** Calls back with the fresh list whenever the file's folder changes (another window, another tab). */
  watch(changes: Bus<string[]>, signal: AbortSignal, onList: (list: T[]) => void): void;
}

export function recordFile<T>(fs: FileSystem, path: string, parse: (text: string) => T[], write: (list: T[]) => string): RecordFile<T> {
  /** The records and the id of the copy they came from ('' when there is no file yet). */
  const read = async (): Promise<{ list: T[]; id: string }> => {
    const entry = await fs.stat(path);
    if (!entry) return { list: [], id: '' };
    if (entry.kind !== 'file') throw new FsError(`“${entry.name}” is a folder, not a file.`);
    if (entry.size > MAX_RECORD_FILE) {
      throw new FsError(`“${entry.name}” is ${formatSize(entry.size)}; this app opens files up to ${formatSize(MAX_RECORD_FILE)}. It is safe where it is.`);
    }
    return { list: parse(await fs.readText(path)), id: entry.id };
  };
  const load = async (): Promise<T[]> => (await read()).list;
  return {
    path,
    load,
    async change(apply) {
      // Written only over the copy the change was made from: if another window or device saved in between, its
      // version is read and the change made again on top of it, so neither undoes the other.
      for (let attempt = 1; ; attempt++) {
        const { list, id } = await read();
        const next = apply(list);
        try {
          await fs.writeText(path, write(next), id ? { replacing: id } : { mustBeNew: true });
          return next;
        } catch (error) {
          const raced = error instanceof FileChanged || (!id && error instanceof FsError && (await fs.stat(path)) !== null);
          if (!raced || attempt >= 5) throw error;
        }
      }
    },
    watch(changes, signal, onList) {
      const folder = nameKey(parentPath(path));
      changes.on(paths => {
        if (paths.some(p => nameKey(p) === folder)) void load().then(onList, () => {});
      }, signal);
    },
  };
}
