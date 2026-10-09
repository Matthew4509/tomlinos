// The "content line" text shared by calendar (.ics) and contact (.vcf) files: NAME;PARAM=x:value, long lines folded
// onto the next line with a leading space, and \, \; \n escapes inside values. Only what our two apps need.

export interface ContentLine {
  name: string;
  params: Record<string, string>;
  value: string;
}

/** Joins folded lines and splits the text into content lines. Lines that do not parse are skipped, never fatal. */
export function readLines(text: string): ContentLine[] {
  const raw = text.replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const out: ContentLine[] = [];
  for (const line of raw) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const [name, ...params] = line.slice(0, colon).split(';');
    const map: Record<string, string> = {};
    for (const p of params) {
      const eq = p.indexOf('=');
      if (eq > 0) map[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
    }
    out.push({ name: name.toUpperCase(), params: map, value: line.slice(colon + 1) });
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

/** One line, folded at 74 characters so other programs read it. */
export function writeLine(name: string, value: string): string {
  const line = `${name}:${value}`;
  const parts: string[] = [];
  for (let i = 0; i < line.length; i += 74) parts.push((i ? ' ' : '') + line.slice(i, i + 74));
  return parts.join('\r\n');
}
