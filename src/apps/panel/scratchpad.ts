// The Panel Overview's scratch pad: a notes pad above Recent files, the names of saved pads next to it, and quick
// Save, New and Open full, so notes can be jotted down fast.
//
// Each pad is a plain text file in Documents/Scratch pad, named by the person or, when they give no name, by the day
// (day-month-year, such as "27-09-2026"). Plain files: Files, Quick Notes and the Terminal all see them, and a backup copies them.
import { cleanName, joinPath, uniqueName } from '../../fs/names.ts';
import { FsError, type Entry, type FileSystem } from '../../fs/fs.ts';

export const PAD_FOLDER = '/Documents/Scratch pad';
export const PAD_EXTENSION = '.txt';

/** "27-09-2026": the name a pad gets when none is typed. */
export function dayName(d: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getDate())}-${two(d.getMonth() + 1)}-${d.getFullYear()}`;
}

/** The file name for a pad name: cleaned for the file store, ".txt" added; a blank name becomes the day. */
export function padFileName(name: string, now: Date): string {
  // cleanName turns an empty name into "Untitled", so the day is chosen before it is asked.
  const typed = name.trim().replace(/\.txt$/i, '').trim();
  const base = typed ? cleanName(typed) : dayName(now);
  return `${base}${PAD_EXTENSION}`;
}

/** The name shown in the list for a pad's file. */
export const padLabel = (fileName: string): string => fileName.replace(/\.txt$/i, '');

export interface Pad {
  name: string;
  modified: number;
}

/** Every pad, newest first. */
export async function listPads(fs: FileSystem): Promise<Pad[]> {
  try {
    const entries = await fs.list(PAD_FOLDER);
    return entries.filter(e => e.kind === 'file' && /\.txt$/i.test(e.name)).map(e => ({ name: e.name, modified: e.modified })).sort((a, b) => b.modified - a.modified);
  } catch {
    return [];
  }
}

/** What a pad was saved as: its file name and the id of the copy written (the next save replaces only that copy). */
export interface SavedPad {
  name: string;
  id: string;
}

/** Writes over a pad's own file; null when the person chose not to replace a copy changed elsewhere (nothing written). */
export type PadWrite = (path: string, text: string) => Promise<Entry | null>;

/** A pad's text and the id of the copy it came from; null when the file is not there. */
export async function readPad(fs: FileSystem, fileName: string): Promise<SavedPad & { text: string } | null> {
  const path = joinPath(PAD_FOLDER, fileName);
  // The id is looked at before and after the read, so the text and the id are of the same copy.
  for (let attempt = 0; attempt < 5; attempt++) {
    const before = await fs.stat(path);
    if (!before || before.kind !== 'file') return null;
    const text = await fs.readText(path);
    const after = await fs.stat(path);
    if (after && after.id === before.id) return { name: after.name, id: after.id, text };
  }
  throw new FsError(`"${fileName}" kept changing while it was read. Try again.`);
}

/**
 * Saves a pad. `was` is the file it was opened from (null for a new pad) and `wasId` the copy read or last saved: a
 * changed name renames that file, so the list does not keep the old one. A name another pad already has gets " (2)"
 * rather than overwriting it. Over its own file the pad is written with `write` (by default only over the copy `wasId`
 * names). Returns the file name and copy it was saved as, or null when nothing was written.
 */
export async function savePadFile(fs: FileSystem, name: string, text: string, was: string | null, wasId: string, now: Date, write?: PadWrite): Promise<SavedPad | null> {
  const writeOver: PadWrite = write ?? ((path, t) => fs.writeText(path, t, wasId ? { replacing: wasId } : {}));
  await fs.ensureFolder(PAD_FOLDER);
  const wanted = padFileName(name, now);
  const taken = (await listPads(fs)).map(p => p.name).filter(n => n !== was);
  // Saving over the pad's own file (same name): a replace of the copy it came from, asked about if that changed.
  if (was && wanted.toLowerCase() === was.toLowerCase() && (await fs.exists(joinPath(PAD_FOLDER, was)))) {
    const entry = await writeOver(joinPath(PAD_FOLDER, was), text);
    if (!entry) return null;
    if (wanted === was) return { name: was, id: entry.id };
    // Only the case of the name changed: a rename keeps the copy's id.
    await fs.rename(joinPath(PAD_FOLDER, was), wanted);
    return { name: wanted, id: entry.id };
  }
  // A new name: written only if nothing has it (create-only), trying " (2)", " (3)"... when another window or pad took it
  // first, so two saves never overwrite each other. The old file goes only after the new one is safely written, so a
  // failed write loses nothing.
  let target = uniqueName(wanted, taken);
  let entry: Entry;
  for (let attempt = 0; ; attempt++) {
    try {
      entry = await fs.writeText(joinPath(PAD_FOLDER, target), text, { mustBeNew: true });
      break;
    } catch (error) {
      if (!(error instanceof FsError) || attempt >= 20 || !(await fs.exists(joinPath(PAD_FOLDER, target)))) throw error;
      taken.push(target);
      target = uniqueName(wanted, taken);
    }
  }
  // The old file goes only if it is still the copy this pad came from: one changed elsewhere meanwhile is kept.
  if (was && was !== target) {
    const old = await fs.stat(joinPath(PAD_FOLDER, was));
    if (old && (!wasId || old.id === wasId)) await fs.remove([joinPath(PAD_FOLDER, was)]);
  }
  return { name: target, id: entry.id };
}

/** savePadFile, giving the file name only (a save that replaces whatever is there). */
export async function savePad(fs: FileSystem, name: string, text: string, was: string | null, now: Date): Promise<string> {
  const saved = await savePadFile(fs, name, text, was, '', now);
  return saved ? saved.name : (was ?? padFileName(name, now));
}
