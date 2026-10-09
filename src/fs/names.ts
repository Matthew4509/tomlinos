// Rules for file and folder names. Names are compared the way Windows and macOS do by default: letter case and
// Unicode spelling ("é" typed two ways) do not make two names different, so a folder can never hold "Report.txt"
// and "report.txt" side by side and confuse whoever downloads them.

import { FsError } from './errors.ts';

const MAX_NAME_BYTES = 255;
const CONTROL = /[\u0000-\u001f\u007f]/;
// Characters that flip text direction can disguise "photo\u202egnp.exe" as "photoexe.png".
const DIRECTION = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const WINDOWS_BANNED = /[<>:"|?*]/;
const SLASH = /[\/\\]/;

/** Why a typed name cannot be used, written for the person; null when it is fine. */
export function nameProblem(name: string): string | null {
  if (name.trim() === '') return 'A name cannot be empty.';
  if (name !== name.trim()) return 'A name cannot start or end with a space.';
  if (name === '.' || name === '..') return 'A name cannot be just dots.';
  if (name.endsWith('.')) return 'A name cannot end with a dot.';
  if (SLASH.test(name)) return 'A name cannot contain / or \\, because those separate folders.';
  if (WINDOWS_BANNED.test(name)) return 'A name cannot contain any of < > : " | ? * (Windows refuses them when you download).';
  if (CONTROL.test(name) || DIRECTION.test(name)) return 'A name cannot contain invisible control characters.';
  if (new TextEncoder().encode(name).length > MAX_NAME_BYTES) return 'That name is too long. Keep it under 255 letters.';
  return null;
}

/** Makes any name usable (for uploads, whose names come from another computer): bad characters become "_". */
export function cleanName(name: string): string {
  let clean = name
    .normalize('NFC')
    .replace(DIRECTION, '')
    .replace(new RegExp(`${CONTROL.source}|${SLASH.source}|${WINDOWS_BANNED.source}`, 'g'), '_')
    .trim()
    .replace(/\.+$/, '');
  const bytes = new TextEncoder();
  while (bytes.encode(clean).length > MAX_NAME_BYTES) {
    const dot = clean.lastIndexOf('.');
    const ext = dot > 0 && clean.length - dot <= 10 ? clean.slice(dot) : '';
    clean = clean.slice(0, clean.length - ext.length - 1) + ext;
  }
  if (clean === '' || clean === '.' || clean === '..') clean = 'Untitled';
  return clean;
}

/** The form two names are compared in. */
export function nameKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

/** "Report.txt" -> ["Report", ".txt"]; a leading dot is part of the name, not an extension. */
export function splitExtension(name: string): [string, string] {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
}

/** The first of "name", "name (2)", "name (3)"... not already taken. */
export function uniqueName(name: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map(nameKey));
  if (!used.has(nameKey(name))) return name;
  const [base, ext] = splitExtension(name);
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!used.has(nameKey(candidate))) return candidate;
  }
}

/** "/Documents/Letters/" -> ["Documents", "Letters"]. Empty parts are dropped; "." and ".." are refused. */
export function splitPath(path: string): string[] {
  const parts = path.split('/').filter(p => p !== '');
  if (parts.some(p => p === '.' || p === '..')) throw new FsError('A path cannot contain "." or "..".');
  return parts;
}

export function joinPath(...parts: string[]): string {
  return '/' + parts.flatMap(p => p.split('/')).filter(p => p !== '').join('/');
}

export function parentPath(path: string): string {
  const parts = splitPath(path);
  return joinPath(...parts.slice(0, -1));
}

export function baseName(path: string): string {
  const parts = splitPath(path);
  return parts[parts.length - 1] ?? '';
}
