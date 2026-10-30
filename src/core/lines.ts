// The "content line" text shared by calendar (.ics) and contact (.vcf) files: NAME;PARAM=x:value, long lines folded
// onto the next line with a leading space, and \, \; \n escapes inside values. Only what our two apps need.

export interface ContentLine {
  name: string;
  params: Record<string, string>;
  value: string;
  /** The whole line as it was (unfolded), for writing back a property this app does not edit. */
  raw: string;
}

/** A line whose value is quoted-printable (old vCard 2.1, from phones): =C3=BC for ü, and "=" at the end for "goes on". */
export const isQuotedPrintable = (line: string): boolean => /^[^:]*QUOTED-PRINTABLE/i.test(line);

/** Joins folded lines and splits the text into content lines. Lines that do not parse are skipped, never fatal. */
export function readLines(text: string): ContentLine[] {
  const raw: string[] = [];
  // Whether each line is quoted-printable, worked out once when the line starts (looking again at a line that grows
  // with every piece joined on made a crafted file take minutes).
  const qp: boolean[] = [];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const last = raw.length - 1;
    // A quoted-printable value goes on after an "=" at the line's end; any other folded line starts with a space.
    if (last >= 0 && qp[last] && raw[last].endsWith('=')) raw[last] = raw[last].slice(0, -1) + line;
    else if (last >= 0 && (line.startsWith(' ') || line.startsWith('\t'))) raw[last] += line.slice(1);
    else {
      raw.push(line);
      qp.push(isQuotedPrintable(line));
    }
  }
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
  // A quoted-printable line (all plain letters) folds its own way: "=" at the end of each piece, never inside "=C3".
  if (isQuotedPrintable(line) && line.length > 75) {
    const pieces: string[] = [];
    let at = 0;
    while (line.length - at > 75) {
      let cut = at + 74;
      if (line[cut - 1] === '=') cut -= 1;
      else if (line[cut - 2] === '=') cut -= 2;
      pieces.push(`${line.slice(at, cut)}=`);
      at = cut;
    }
    pieces.push(line.slice(at));
    return pieces.join('\r\n');
  }
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

/**
 * Which copy of an id a record is, when a file uses one id on several records (it should not, but merged files do):
 * `of` is the id they share and `nth` the order they come in.
 */
export interface Copy {
  of: string;
  nth: number;
}

/**
 * Gives each record read from a file an id of its own: the first with an id keeps it, the next gets id-1, id-2. An
 * edit or delete then finds just the record it meant; the file's own id is written back as it was.
 */
export function uniqueIds(): (id: string) => { id: string; copy: Copy } {
  const used = new Set<string>();
  const copies = new Map<string, number>();
  return of => {
    let nth = copies.get(of) ?? 0;
    let id = nth ? `${of}-${nth}` : of;
    while (used.has(id)) id = `${of}-${++nth}`;
    used.add(id);
    copies.set(of, nth + 1);
    return { id, copy: { of, nth } };
  };
}

/**
 * The list to write, with records sharing an id back in the order they were read (the rest stay where they are), so
 * reading the file again gives each the same id even after the list was sorted or an edited one moved to its end.
 */
export function copiesInOrder<T extends { keep?: { copy?: Copy } }>(list: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const record of list) {
    const copy = record.keep?.copy;
    if (!copy) continue;
    const group = groups.get(copy.of);
    if (group) group.push(record);
    else groups.set(copy.of, [record]);
  }
  for (const group of groups.values()) group.sort((a, b) => a.keep!.copy!.nth - b.keep!.copy!.nth);
  return list.map(record => {
    const copy = record.keep?.copy;
    return copy ? groups.get(copy.of)!.shift()! : record;
  });
}
