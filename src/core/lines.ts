// The "content line" text shared by calendar (.ics) and contact (.vcf) files: NAME;PARAM=x:value, long lines folded
// onto the next line with a leading space, and \, \; \n escapes inside values. Only what our two apps need.

export interface ContentLine {
  name: string;
  params: Record<string, string>;
  value: string;
  /** The whole line as it was (unfolded), for writing back a property this app does not edit. */
  raw: string;
}

/** Joins folded lines and splits the text into content lines. Lines that do not parse are skipped, never fatal. */
export function readLines(text: string): ContentLine[] {
  const raw = text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const out: ContentLine[] = [];
  for (const line of raw) {
    // The name and its parameters end at the first colon outside quotes (a quoted parameter may hold one).
    let colon = -1;
    let quoted = false;
    const cuts: number[] = [];
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') quoted = !quoted;
      else if (!quoted && c === ';') cuts.push(i);
      else if (!quoted && c === ':') {
        colon = i;
        break;
      }
    }
    if (colon <= 0) continue;
    const pieces = [0, ...cuts.map(c => c + 1)].map((from, k) => line.slice(from, k < cuts.length ? cuts[k] : colon));
    const [name, ...params] = pieces;
    const map: Record<string, string> = {};
    for (const p of params) {
      const eq = p.indexOf('=');
      if (eq > 0) map[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
    }
    out.push({ name: name.toUpperCase(), params: map, value: line.slice(colon + 1), raw: line });
  }
  return out;
}

export function unescapeValue(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

export function escapeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** Splits a structured value (N, ADR) on unescaped semicolons. */
export function splitParts(value: string): string[] {
  return value.split(/(?<!\\);/).map(unescapeValue);
}

const utf8Length = (ch: string): number => {
  const cp = ch.codePointAt(0) ?? 0;
  return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
};

/**
 * Folds a line so no piece is longer than 75 bytes, as the formats ask, cutting only between whole characters: a cut
 * through an emoji would leave two halves that are saved as two "?" marks.
 */
export function foldLine(line: string): string {
  const parts: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const n = utf8Length(ch);
    if (bytes + n > 75) {
      parts.push(cur);
      cur = ' ';
      bytes = 1;
    }
    cur += ch;
    bytes += n;
  }
  parts.push(cur);
  return parts.join('\r\n');
}

/** One line, folded so other programs read it. */
export function writeLine(name: string, value: string): string {
  return foldLine(`${name}:${value}`);
}

/**
 * An id for a record its file gave none: worked out from the record's own text (and how many identical records came
 * before it), so reading the file again gives the same id and an edit or delete finds the record it meant.
 */
export function idFromText(text: string, seen: Map<string, number>): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  const base = `noid-${(h >>> 0).toString(16).padStart(8, '0')}`;
  const n = seen.get(base) ?? 0;
  seen.set(base, n + 1);
  return n ? `${base}-${n}` : base;
}
