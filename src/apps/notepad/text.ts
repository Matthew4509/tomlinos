// Quick Notes' text sums, kept apart from the window so they can be tested: where the caret is, which line ending a file
// uses, finding and replacing. A text box always holds "\n" line ends, so the file's own ending is remembered and put
// back on save; before this, a Windows file (CRLF) was quietly saved with Linux endings.

export type Eol = '\r\n' | '\n' | '\r';

export const EOL_NAMES: Record<Eol, string> = { '\r\n': 'Windows (CRLF)', '\n': 'Unix (LF)', '\r': 'Old Mac (CR)' };

/** The ending most of the file's lines use; a file with none gets `fallback`. */
export function detectEol(text: string, fallback: Eol = '\r\n'): Eol {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  // A bare "\r" (no "\n" after it) is the old Mac ending; before this it was read as a Windows one and saved as LF.
  const cr = (text.match(/\r(?!\n)/g) ?? []).length;
  if (crlf === 0 && lf === 0 && cr === 0) return fallback;
  if (cr > crlf && cr > lf) return '\r';
  return crlf >= lf ? '\r\n' : '\n';
}

/** Text as the box holds it (every ending "\n"). */
export const toBox = (text: string) => text.replace(/\r\n?/g, '\n');
/** Text as the file is saved. */
export const toFile = (text: string, eol: Eol) => (eol === '\n' ? text : text.replace(/\n/g, eol));

/** Does the file start with the invisible mark (a BOM) some programs put at the start of UTF-8? */
export const hasBom = (bytes: Uint8Array) => bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
/** Text as the file's bytes, with that mark back if the file had it. */
export function fileBytes(text: string, eol: Eol, bom: boolean): Uint8Array {
  const body = new TextEncoder().encode(toFile(text, eol));
  if (!bom) return body;
  const bytes = new Uint8Array(body.length + 3);
  bytes.set([0xef, 0xbb, 0xbf]);
  bytes.set(body, 3);
  return bytes;
}

/** How many bytes fileBytes would give, counted without building them (a quick size for the status bar and the limit). */
export function fileSize(text: string, eol: Eol, bom: boolean): number {
  let n = bom ? 3 : 0;
  const crlf = eol === '\r\n';
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += crlf && c === 10 ? 2 : 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i++;
    } else n += 3; // a lone half of a pair is saved as the 3-byte replacement mark, as TextEncoder does
  }
  return n;
}

/**
 * Each line's own ending, in order (one per "\n" the box will hold), or null when every line ends the same way (or
 * there are none). A file with mixed endings keeps each line's own on save; before this it was made uniform.
 */
export function lineEndings(text: string): Eol[] | null {
  const ends: Eol[] = [];
  let kinds = 0;
  for (const m of text.matchAll(/\r\n|\r|\n/g)) {
    const e = m[0] as Eol;
    kinds |= e === '\r\n' ? 1 : e === '\n' ? 2 : 4;
    ends.push(e);
  }
  return kinds & (kinds - 1) ? ends : null;
}

/**
 * The ending for each "\n" of `box`, kept from the file it was opened from (`ref`, with endings `refEnds`): lines before
 * the first changed line and after the last one keep their own ending; lines in between get `eol`.
 */
export function keptEndings(box: string, ref: string, refEnds: Eol[], eol: Eol): Eol[] {
  const now = box.split('\n');
  const was = ref.split('\n');
  const room = Math.min(now.length, was.length);
  let p = 0;
  while (p < room && now[p] === was[p]) p++;
  let s = 0;
  while (s < room - p && now[now.length - 1 - s] === was[was.length - 1 - s]) s++;
  const ends: Eol[] = [];
  for (let j = 0; j < now.length - 1; j++) {
    if (j < p && j < refEnds.length) ends.push(refEnds[j]);
    else if (j + 1 >= now.length - s) ends.push(refEnds[j - now.length + was.length] ?? eol);
    else ends.push(eol);
  }
  return ends;
}

/** Box text with each "\n" put back as its own ending. */
export function withEndings(box: string, ends: Eol[], eol: Eol): string {
  let i = 0;
  return box.replace(/\n/g, () => ends[i++] ?? eol);
}

/** How a file's letters are stored. Windows Notepad's "Unicode" is UTF-16 LE with its mark; "ANSI" is Windows-1252. */
export type Encoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';
export const ENCODING_NAMES: Record<Encoding, string> = { 'utf-8': 'UTF-8', 'utf-16le': 'UTF-16 LE', 'utf-16be': 'UTF-16 BE', 'windows-1252': 'Windows-1252' };

/** A file read as text: the text as stored (endings not yet changed), how it was stored, and whether it had the mark. */
export interface DecodedFile {
  text: string;
  encoding: Encoding;
  bom: boolean;
}

/**
 * The bytes as text, or null when they are not text. UTF-8 first (with or without its mark); a UTF-16 mark means
 * UTF-16; bytes that are not UTF-8 but read as Western text with no NULs or stray control bytes are Windows-1252.
 */
export function decodeFile(bytes: Uint8Array): DecodedFile | null {
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    const encoding: Encoding = bytes[0] === 0xff ? 'utf-16le' : 'utf-16be';
    try {
      const text = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes.subarray(2));
      return /[\0-\x08\x0e-\x1a\x1c-\x1f]/.test(text) ? null : { text, encoding, bom: true };
    } catch {
      return null;
    }
  }
  const bom = hasBom(bytes);
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8', bom };
  } catch {
    if (bom) return null;
  }
  // Not UTF-8: Western text from an older program (accents and € as one byte each), unless it holds bytes text never has.
  for (const b of bytes) {
    if (b < 9 || (b >= 0x0e && b < 0x20 && b !== 0x1b) || b === 0x81 || b === 0x8d || b === 0x8f || b === 0x90 || b === 0x9d) return null;
  }
  return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252', bom: false };
}

let cp1252: Map<number, number> | null = null;
/** The Windows-1252 byte of each letter it holds above 0x7f. */
function cp1252Bytes(): Map<number, number> {
  if (cp1252) return cp1252;
  cp1252 = new Map();
  const all = new TextDecoder('windows-1252').decode(Uint8Array.from({ length: 128 }, (_, i) => 128 + i));
  for (let i = 0; i < 128; i++) cp1252.set(all.charCodeAt(i), 128 + i);
  return cp1252;
}

/** The first letter of `text` the encoding cannot hold, or null when it holds them all. */
export function cannotHold(text: string, encoding: Encoding): string | null {
  if (encoding === 'windows-1252') {
    const map = cp1252Bytes();
    for (const ch of text) if (ch.charCodeAt(0) >= 0x80 && !map.has(ch.charCodeAt(0))) return ch;
    return null;
  }
  return null; // UTF-8 and UTF-16 hold every letter
}

/** File text (endings already in place) as the bytes of the file, in its own encoding and with its mark if it had one. */
export function encodeFile(text: string, encoding: Encoding, bom: boolean): Uint8Array {
  if (encoding === 'utf-8') return fileBytes(text, '\n', bom);
  if (encoding === 'windows-1252') {
    const map = cp1252Bytes();
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      out[i] = c < 0x80 ? c : (map.get(c) ?? 0x3f);
    }
    return out;
  }
  const out = new Uint8Array(2 + text.length * 2);
  const le = encoding === 'utf-16le';
  out[0] = le ? 0xff : 0xfe;
  out[1] = le ? 0xfe : 0xff;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    out[2 + i * 2 + (le ? 0 : 1)] = c & 0xff;
    out[2 + i * 2 + (le ? 1 : 0)] = c >> 8;
  }
  return out;
}

/** How many bytes encodeFile would give, counted without building them. */
export function encodedSize(text: string, encoding: Encoding, bom: boolean): number {
  if (encoding === 'utf-8') return fileSize(text, '\n', bom);
  return encoding === 'windows-1252' ? text.length : 2 + text.length * 2;
}

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

/**
 * 1-based line and column of an offset. The column counts letters as a person sees them: an emoji (even one made of
 * several joined ones) or a letter with an accent mark is one. A very long line counts code points instead, to stay quick.
 */
export function lineCol(text: string, offset: number): { line: number; col: number } {
  const before = text.slice(0, offset);
  const nl = before.lastIndexOf('\n');
  const part = before.slice(nl + 1);
  let col = 1;
  if (segmenter && part.length <= 20_000) for (const _ of segmenter.segment(part)) col++;
  else for (let i = 0; i < part.length; i++) if ((part.charCodeAt(i) & 0xfc00) !== 0xdc00 || (part.charCodeAt(i - 1) & 0xfc00) !== 0xd800) col++;
  return { line: before.split('\n').length, col };
}

/** The offset where 1-based `line` starts; past the end means the last line. */
export function lineStart(text: string, line: number): number {
  let at = 0;
  for (let n = 1; n < line; n++) {
    const next = text.indexOf('\n', at);
    if (next < 0) break;
    at = next + 1;
  }
  return at;
}

export interface FindOptions {
  matchCase: boolean;
  backwards?: boolean;
}

/**
 * Small letters, one for one: the text keeps its length, so a place found in it is the same place in the box. Turkish
 * İ is the one letter whose small form is longer ("i" and a dot), so it becomes "i" first; the Greek final ς is the
 * same letter as σ. Find, Replace and Replace all all use this one fold, so they agree on what matches (before, Replace
 * all used a /gi search, which differed on İ, ẞ, ς and Deseret capitals). The same everywhere, not by the browser's language.
 */
export function fold(s: string): string {
  const small = (s.includes('İ') ? s.replace(/İ/g, 'i') : s).toLowerCase();
  return small.includes('ς') ? small.replace(/ς/g, 'σ') : small;
}

// The last text folded: Find next pressed again on the same text does not fold all of it again (a 5 MB file took a
// second a press).
let foldedFrom = '';
let foldedTo = '';
function foldText(text: string): string {
  if (text !== foldedFrom) {
    foldedTo = fold(text);
    foldedFrom = text;
  }
  return foldedTo;
}

/** Whether two pieces of text are the same match (the selection and the Find box, for Replace). */
export function sameMatch(a: string, b: string, matchCase: boolean): boolean {
  return matchCase ? a === b : a.length === b.length && fold(a) === fold(b);
}

/** The next match after `from` (or before it, backwards), wrapping round the end; null when there is none. */
export function findNext(text: string, query: string, from: number, options: FindOptions): { start: number; end: number; wrapped: boolean } | null {
  if (!query) return null;
  const hay = options.matchCase ? text : foldText(text);
  const needle = options.matchCase ? query : fold(query);
  let at: number;
  let wrapped = false;
  if (options.backwards) {
    // A match that ends at or before `from`, so the one just selected is skipped.
    at = from - needle.length >= 0 ? hay.lastIndexOf(needle, from - needle.length) : -1;
    if (at < 0) {
      at = hay.lastIndexOf(needle);
      wrapped = at >= 0;
    }
  } else {
    at = hay.indexOf(needle, from);
    if (at < 0) {
      at = hay.indexOf(needle);
      wrapped = at >= 0;
    }
  }
  return at < 0 ? null : { start: at, end: at + needle.length, wrapped };
}

/** Every match replaced; `count` says how many. */
export function replaceAll(text: string, query: string, replacement: string, matchCase: boolean): { text: string; count: number } {
  if (!query) return { text, count: 0 };
  // The same search as findNext, front to back, so it replaces exactly what Find next steps through.
  const hay = matchCase ? text : foldText(text);
  const needle = matchCase ? query : fold(query);
  const parts: string[] = [];
  let count = 0;
  let last = 0;
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) {
    parts.push(text.slice(last, at), replacement);
    last = at + needle.length;
    count++;
  }
  if (!count) return { text, count: 0 };
  parts.push(text.slice(last));
  return { text: parts.join(''), count };
}
