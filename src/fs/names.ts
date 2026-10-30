// Rules for file and folder names. Names are compared the way Windows and macOS do by default: letter case and
// Unicode spelling ("é" typed two ways) do not make two names different, so a folder can never hold "Report.txt"
// and "report.txt" side by side and confuse whoever downloads them.

import { FsError } from './errors.ts';

const MAX_NAME_BYTES = 255;
const CONTROL = /[\u0000-\u001f\u007f]/;
// Characters that flip text direction can disguise "photo\u202egnp.exe" as "photoexe.png"; ones that show nothing at all
// (a zero-width space, the old C1 controls, a line separator) make two names look the same. Joiners (U+200C, U+200D)
// are not here: Persian and Indic words and emoji families need them.
const INVISIBLE = /[\u0080-\u009f\u00ad\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2060\u2066-\u2069\ufeff]/;
const WINDOWS_BANNED = /[<>:"|?*]/;
const SLASH = /[\/\\]/;
// Names Windows keeps for devices, whatever comes after the dot ("nul.txt" too): a download of one fails there.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;

/** Why a typed name cannot be used, written for the person; null when it is fine. */
export function nameProblem(name: string): string | null {
  if (name.trim() === '') return 'A name cannot be empty.';
  if (name !== name.trim()) return 'A name cannot start or end with a space.';
  if (name === '.' || name === '..') return 'A name cannot be just dots.';
  if (name.endsWith('.')) return 'A name cannot end with a dot.';
  if (SLASH.test(name)) return 'A name cannot contain / or \\, because those separate folders.';
  if (WINDOWS_BANNED.test(name)) return 'A name cannot contain any of < > : " | ? * (Windows refuses them when you download).';
  if (CONTROL.test(name) || INVISIBLE.test(name)) return 'A name cannot contain invisible control characters.';
  if (WINDOWS_RESERVED.test(name)) return 'A name cannot be CON, PRN, AUX, NUL, COM1-9 or LPT1-9, with or without an ending (Windows keeps those for devices).';
  if (new TextEncoder().encode(name).length > MAX_NAME_BYTES) return 'That name is too long. Keep it under 255 letters.';
  return null;
}

/** The ending of a name ("" when it has none, or one too long to be one), for keeping it when the name is shortened. */
function endingOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 && name.length - dot <= 10 ? name.slice(dot) : '';
}

/** Takes whole characters off the end of a stem until the name fits in `room` bytes (cutting an emoji in half leaves a broken "?"). */
function fitBytes(stem: string, room: number): string {
  const bytes = new TextEncoder();
  const chars = Array.from(stem);
  while (chars.length && bytes.encode(chars.join('')).length > room) chars.pop();
  return chars.join('');
}

/** Makes any name usable (for uploads, whose names come from another computer): bad characters become "_". */
export function cleanName(name: string): string {
  // Trailing spaces and dots come off together: "notes ." trimmed and then without its dot would end in a space.
  const tidy = (s: string) => s.trim().replace(/[\s.]+$/, '');
  let clean = tidy(name
    .normalize('NFC')
    .replace(new RegExp(INVISIBLE.source, 'g'), '')
    .replace(new RegExp(`${CONTROL.source}|${SLASH.source}|${WINDOWS_BANNED.source}`, 'g'), '_'))
    .replace(WINDOWS_RESERVED, (_, device: string, after: string) => `${device}_${after}`);
  // A very long name (one inside a zip can be 64 KB) is first cut to a length near the limit in one go, keeping its ending.
  if (clean.length > MAX_NAME_BYTES * 2) {
    const ext = endingOf(clean);
    clean = Array.from(clean.slice(0, clean.length - ext.length)).slice(0, MAX_NAME_BYTES).join('') + ext;
  }
  if (new TextEncoder().encode(clean).length > MAX_NAME_BYTES) {
    const ext = endingOf(clean);
    clean = tidy(fitBytes(clean.slice(0, clean.length - ext.length), MAX_NAME_BYTES - new TextEncoder().encode(ext).length)) + ext;
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

/** The first of "name", "name (2)", "name (3)"... not already taken. A name near the 255-byte limit is shortened to make room. */
export function uniqueName(name: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map(nameKey));
  if (!used.has(nameKey(name))) return name;
  const [base, ext] = splitExtension(name);
  const bytes = new TextEncoder();
  for (let n = 2; ; n++) {
    const tail = ` (${n})${ext}`;
    const candidate = fitBytes(base, MAX_NAME_BYTES - bytes.encode(tail).length) + tail;
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
