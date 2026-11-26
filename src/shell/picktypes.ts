// The file-type drop-down of the Open and Save as windows: which entries it lists, which one starts selected, how a
// choice filters the list, and how a typed name gets (or keeps) its ending when saving.
import { splitExtension } from '../fs/names.ts';
import type { FileTypeChoice } from './filepicker.ts';
import { extensionOf, fileTypeOf } from './filetypes.ts';

/** Kinds whose label says nothing about the ending, so the ending goes in front ("PNG picture"). */
const GENERIC = new Set(['Text document', 'Picture', 'Layered picture', 'Video', 'Music', 'Spreadsheet', 'Code or data file', 'Compressed folder', 'Calculator sheet']);

function cleanExt(ext: string): string {
  return ext.trim().replace(/^\*?\./, '').toLowerCase();
}

/** "PNG picture (*.png)", "Word document (*.docx)". */
export function typeLabel(ext: string): string {
  const label = fileTypeOf(`x.${ext}`).label;
  const kind = GENERIC.has(label) ? `${ext.toUpperCase()} ${label.toLowerCase()}` : label;
  return `${kind} (*.${ext})`;
}

/**
 * A label that shows its endings the same way in every app: "Markdown (*.md)", "All files (*.*)". A label that already
 * names its endings ("Spreadsheet (.sheet)") gets the same "(*.sheet)" form; a label with other words in brackets is kept.
 */
export function withEndings(label: string, ext: string[]): string {
  const endings = ext.length ? ext.map(e => `*.${e}`).join(', ') : '*.*';
  const named = /\s*\((\.[a-z0-9]+(?:,\s*\.[a-z0-9]+)*)\)\s*$/i.exec(label);
  if (named) return `${label.slice(0, named.index)} (${endings})`;
  if (/\(\*\./.test(label)) return label;
  return `${label} (${endings})`;
}

/** The drop-down's entries: the ones asked for, else made from `accept`, else "All files". */
export function typeChoices(types: FileTypeChoice[] | undefined, accept: string[] | undefined, saving: boolean): FileTypeChoice[] {
  const given = (types ?? [])
    .filter(t => t && typeof t.label === 'string' && t.label !== '')
    .map(t => {
      const ext = [...new Set((t.ext ?? []).map(cleanExt).filter(e => e !== ''))];
      return { label: withEndings(t.label, ext), ext };
    });
  if (given.length) return given;
  const exts = [...new Set((accept ?? []).map(cleanExt).filter(e => e !== ''))];
  if (!exts.length) return [{ label: 'All files (*.*)', ext: [] }];
  if (!saving) return [{ label: `Supported files (${exts.map(e => `*.${e}`).join(', ')})`, ext: exts }];
  return exts.map(e => ({ label: typeLabel(e), ext: [e] }));
}

/** The entry selected at the start: the first, unless the suggested name's ending belongs to a later one. */
export function startingType(choices: FileTypeChoice[], name: string | null): number {
  if (name === null) return 0;
  const ext = extensionOf(name);
  if (!ext || choices[0].ext.includes(ext)) return 0;
  const i = choices.findIndex(t => t.ext.includes(ext));
  return i >= 0 ? i : 0;
}

/** Whether a file of this name is listed under the choice. */
export function allows(choice: FileTypeChoice, name: string): boolean {
  return choice.ext.length === 0 || choice.ext.includes(extensionOf(name));
}

/** The name with its ending swapped for the new choice's first one. An ending none of the entries knows is kept as part of the name. */
export function swapExtension(name: string, choices: FileTypeChoice[], to: FileTypeChoice): string {
  if (!to.ext.length || name === '') return name;
  const [stem, dot] = splitExtension(name);
  const ext = dot.slice(1).toLowerCase();
  const known = ext !== '' && choices.some(t => t.ext.includes(ext));
  return `${known ? stem : name}.${to.ext[0]}`;
}

/**
 * The name to save under. A name already ending in one of the chosen entry's endings is kept; one ending in another
 * entry's ending switches to that entry; anything else gets the chosen entry's first ending (unless it takes any file).
 */
export function finalSaveName(typed: string, choices: FileTypeChoice[], index: number): { name: string; index: number } {
  const current = choices[index] ?? choices[0];
  const ext = extensionOf(typed);
  if (!current.ext.length || current.ext.includes(ext)) return { name: typed, index };
  if (ext) {
    const other = choices.findIndex(t => t.ext.includes(ext));
    if (other >= 0) return { name: typed, index: other };
  }
  return { name: `${typed}.${current.ext[0]}`, index };
}
