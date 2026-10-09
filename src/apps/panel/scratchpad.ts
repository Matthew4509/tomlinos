// The Panel Overview's scratch pad: a notes pad above Recent files, the names of saved pads next to it, and quick
// Save, New and Open full, so notes can be jotted down fast.
//
// Each pad is a plain text file in Documents/Scratch pad, named by the person or, when they give no name, by the day
// (day-month-year, such as "27-09-2026"). Plain files: Files, Notepad and the Terminal all see them, and a backup copies them.
import { cleanName, joinPath, uniqueName } from '../../fs/names.ts';
import type { FileSystem } from '../../fs/fs.ts';

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

/**
 * Saves a pad. `was` is the file it was opened from (null for a new pad): a changed name renames that file, so the list
 * does not keep the old one. A name another pad already has gets " (2)" rather than overwriting it. Returns the file name
 * it was saved under.
 */
export async function savePad(fs: FileSystem, name: string, text: string, was: string | null, now: Date): Promise<string> {
  await fs.ensureFolder(PAD_FOLDER);
  let target = padFileName(name, now);
  const taken = (await listPads(fs)).map(p => p.name).filter(n => n !== was);
  if (taken.some(n => n.toLowerCase() === target.toLowerCase())) target = uniqueName(target, taken);
  if (was && was !== target && (await fs.exists(joinPath(PAD_FOLDER, was)))) await fs.rename(joinPath(PAD_FOLDER, was), target);
  await fs.writeText(joinPath(PAD_FOLDER, target), text);
  return target;
}
