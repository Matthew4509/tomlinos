// Notepad's text sums, kept apart from the window so they can be tested: where the caret is, which line ending a file
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

/** 1-based line and column of an offset. */
export function lineCol(text: string, offset: number): { line: number; col: number } {
  const before = text.slice(0, offset);
  const nl = before.lastIndexOf('\n');
  return { line: before.split('\n').length, col: offset - nl };
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
 * Small letters, one for one: the text keeps its length, so a place found in it is the same place in the box. (A letter
 * whose small form is longer, such as Turkish İ, which is "i" and a dot, becomes its first letter.) Plain toLowerCase()
 * made the folded text longer, so every match after such a letter pointed one place too far. Same as Write's find.ts.
 */
function fold(s: string): string {
  let out = '';
  for (const ch of s) {
    const small = ch.toLocaleLowerCase();
    if (small.length === ch.length) out += small;
    else if (ch.length === 1 && (small.codePointAt(0) ?? 0) <= 0xffff) out += small[0];
    else out += ch;
  }
  return out;
}

/** The next match after `from` (or before it, backwards), wrapping round the end; null when there is none. */
export function findNext(text: string, query: string, from: number, options: FindOptions): { start: number; end: number; wrapped: boolean } | null {
  if (!query) return null;
  const hay = options.matchCase ? text : fold(text);
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
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let count = 0;
  const out = text.replace(new RegExp(escaped, matchCase ? 'g' : 'gi'), () => {
    count++;
    return replacement;
  });
  return { text: out, count };
}
