// A file that holds a list of records (Calendar.ics, Contacts.vcf), shared by the apps that edit it and by the
// reminders. Every change reads the file again first and applies just that one change, so two windows or devices
// never undo each other's other records. Reads are capped, so a huge or wrong file is refused in words, not loaded.
import type { Bus } from '../core/bus.ts';
import { formatSize } from '../core/format.ts';
import type { FileSystem } from '../fs/fs.ts';
import { FileChanged, FsError } from '../fs/fs.ts';
import { nameKey, parentPath } from '../fs/names.ts';

export const MAX_RECORD_FILE = 4 * 1024 * 1024;

/**
 * A file's text: UTF-8, or UTF-16 (as some programs on Windows save a .vcf), told by its byte-order mark or, without
 * one, by the zero bytes every plain letter has in UTF-16. A byte-order mark is not part of the text.
 */
export function decodeText(bytes: Uint8Array): string {
  let encoding = 'utf-8';
  let from = 0;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) [encoding, from] = ['utf-16le', 2];
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) [encoding, from] = ['utf-16be', 2];
  else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) from = 3;
  else if (bytes.length >= 4 && bytes.length % 2 === 0) {
    // No mark: UTF-16 when the first letters are all plain ones with their zero byte on the same side.
    const n = Math.min(bytes.length, 200);
    let even = 0;
    let odd = 0;
    for (let i = 0; i < n; i++) if (!bytes[i]) i % 2 ? odd++ : even++;
    if (odd === n / 2 && !even) encoding = 'utf-16le';
    else if (even === n / 2 && !odd) encoding = 'utf-16be';
  }
  return new TextDecoder(encoding).decode(bytes.subarray(from));
}

export interface RecordFile<T> {
  readonly path: string;
  /** The records, or [] when the file does not exist yet. Throws (in words) for a file too big or unreadable. */
  load(): Promise<T[]>;
  /** Reads again, applies one change, writes. Returns the new list, as reading the file again would give it. */
  change(apply: (list: T[]) => T[]): Promise<T[]>;
  /** Calls back with the fresh list whenever the file's folder changes (another window, another tab). */
  watch(changes: Bus<string[]>, signal: AbortSignal, onList: (list: T[]) => void): void;
}

/**
 * `write` is given the file's text as it was just read (null when there is no file yet), so it can keep what the file
 * holds outside its records (a calendar's name and to-dos, an event it could not read).
 */
export function recordFile<T>(fs: FileSystem, path: string, parse: (text: string) => T[], write: (list: T[], previous: string | null) => string): RecordFile<T> {
  /** The records, the text they came from and the id of that copy ('' and null when there is no file yet). */
  const read = async (): Promise<{ list: T[]; text: string | null; id: string; name: string }> => {
    const entry = await fs.stat(path);
    if (!entry) return { list: [], text: null, id: '', name: '' };
    if (entry.kind !== 'file') throw new FsError(`“${entry.name}” is a folder, not a file.`);
    if (entry.size > MAX_RECORD_FILE) {
      throw new FsError(`“${entry.name}” is ${formatSize(entry.size)}; this app opens files up to ${formatSize(MAX_RECORD_FILE)}. It is safe where it is.`);
    }
    const text = decodeText(await fs.readFile(path));
    return { list: parse(text), text, id: entry.id, name: entry.name };
  };
  const load = async (): Promise<T[]> => (await read()).list;
  return {
    path,
    load,
    async change(apply) {
      // Written only over the copy the change was made from: if another window or device saved in between, its
      // version is read and the change made again on top of it, so neither undoes the other.
      for (let attempt = 1; ; attempt++) {
        const { list, text, id, name } = await read();
        // A file with text in it from which nothing at all was read (another encoding, another kind of file) is not
        // saved over: the save would hold only this change, and everything the file held would be lost.
        if (text !== null && text.trim() && !list.length && !write([], text).trim()) {
          throw new FsError(`No records could be read from “${name}”, so it was not saved over. It is safe where it is; it may be in a form this app does not read.`);
        }
        const written = write(apply(list), text);
        try {
          await fs.writeText(path, written, id ? { replacing: id } : { mustBeNew: true });
          // Read from what was written, so what the app holds has the ids the next read will give.
          return parse(written);
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
