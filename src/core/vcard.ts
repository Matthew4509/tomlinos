// Contacts read from and written to a .vcf file (vCard 3.0), so the address book can be downloaded into a phone or
// another program, and a .vcf from elsewhere can be opened here. What a card from elsewhere holds that this app does
// not edit (a photo, web addresses, phone types) is kept and written back as it was; a field changed here is written
// fresh, except that a phone or email still in the list keeps its own line.
import { copiesInOrder, escapeValue, foldLine, idFromText, isQuotedPrintable, readLines, splitParts, unescapeValue, uniqueIds, writeLine, type ContentLine, type Copy } from './lines.ts';

/** A line's value as text: a quoted-printable one (old phones: =C3=BC for ü) decoded in its CHARSET (UTF-8 if none). */
function valueText(line: ContentLine): string {
  if (!isQuotedPrintable(line.raw)) return line.value;
  const bytes: number[] = [];
  for (let i = 0; i < line.value.length; i++) {
    const hex = line.value[i] === '=' ? /^[0-9A-Fa-f]{2}/.exec(line.value.slice(i + 1, i + 3)) : null;
    if (hex) {
      bytes.push(Number.parseInt(hex[0], 16));
      i += 2;
    } else bytes.push(line.value.charCodeAt(i) & 0xff);
  }
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(line.params.CHARSET || 'utf-8');
  } catch {
    decoder = new TextDecoder('utf-8');
  }
  return decoder.decode(new Uint8Array(bytes)).replace(/\r\n?/g, '\n');
}

export interface Contact {
  uid: string;
  name: string;
  org: string;
  phones: string[];
  emails: string[];
  address: string;
  /** YYYY-MM-DD or '' */
  birthday: string;
  notes: string;
  /** The card's own first and family names (its N line), when it says which is which; otherwise absent. */
  given?: string;
  family?: string;
  /** What the file held for this card beyond the fields above (absent for a card made here). */
  keep?: CardKeep;
}

type Field = 'name' | 'org' | 'phones' | 'emails' | 'address' | 'birthday' | 'notes';
type ListField = 'phones' | 'emails';

interface CardKeep {
  /** The file's own UID ('' when it gave none). */
  uid: string;
  version: string;
  /** Lines this app does not edit, as they were. */
  lines: string[];
  /** Each edited field's own lines, written back while the field is unchanged here; and its value as read. */
  raw: Partial<Record<Field, string[]>>;
  was: Record<Field, string>;
  /** Each phone and email shown here, with its own line (which holds its type: mobile, work, home). */
  listed: Record<ListField, Array<{ value: string; raw: string }>>;
  /** Phone and email lines not shown here (past the 20 a card shows): always written back. */
  unlisted: Record<ListField, string[]>;
  /** Which copy this is, when the file gives several cards the same UID. */
  copy?: Copy;
}

const FIELD_OF: Record<string, Field> = { FN: 'name', N: 'name', ORG: 'org', TEL: 'phones', EMAIL: 'emails', ADR: 'address', BDAY: 'birthday', NOTE: 'notes' };

export const emptyContact = (): Contact => ({ uid: crypto.randomUUID(), name: '', org: '', phones: [], emails: [], address: '', birthday: '', notes: '' });

const valueOf = (c: Contact, f: Field): string => JSON.stringify(c[f]);

/** One phone or email line: shown if there is room, and either way its line is not lost. */
function addTo(c: Contact, keep: CardKeep, field: ListField, value: string, raw: string): void {
  if (value && c[field].length < 20) {
    c[field].push(value);
    keep.listed[field].push({ value, raw });
  } else if (value) keep.unlisted[field].push(raw);
}

/** A list's lines: an unchanged number or address on its own line (keeping its type), a new one written fresh. */
function listLines(c: Contact, field: ListField, name: string): string[] {
  const left = [...(c.keep?.listed[field] ?? [])];
  const lines = c[field].map(value => {
    const at = left.findIndex(l => l.value === value);
    return at < 0 ? writeLine(name, escapeValue(value)) : foldLine(left.splice(at, 1)[0].raw);
  });
  return [...lines, ...(c.keep?.unlisted[field].map(foldLine) ?? [])];
}

export function parseVcf(text: string): Contact[] {
  const out: Contact[] = [];
  const seen = new Map<string, number>();
  const ids = uniqueIds();
  let cur: Contact | null = null;
  let keep: CardKeep | null = null;
  let raw: string[] = [];
  let nameFromN = '';
  for (const line of readLines(text)) {
    if (line.name === 'BEGIN' && line.value.toUpperCase() === 'VCARD') {
      cur = emptyContact();
      keep = { uid: '', version: '', lines: [], raw: {}, was: {} as Record<Field, string>, listed: { phones: [], emails: [] }, unlisted: { phones: [], emails: [] } };
      raw = [];
      nameFromN = '';
    } else if (line.name === 'END' && line.value.toUpperCase() === 'VCARD') {
      if (cur && keep) {
        if (!cur.name) cur.name = nameFromN || cur.org || cur.emails[0] || cur.phones[0] || '(no name)';
        // No UID in the file: one worked out from the card itself, the same each time the file is read.
        keep.uid ||= idFromText(raw.join('\n'), seen);
        // Two cards with one UID each get an id of their own here; the file's UID is what is written back.
        const unique = ids(keep.uid);
        cur.uid = unique.id;
        keep.copy = unique.copy;
        for (const f of Object.values(FIELD_OF)) keep.was[f] = valueOf(cur, f);
        cur.keep = keep;
        out.push(cur);
      }
      cur = null;
      keep = null;
    } else if (cur && keep) {
      raw.push(line.raw);
      const value = valueText(line);
      const v = unescapeValue(value);
      const field = FIELD_OF[line.name];
      if (field) (keep.raw[field] ??= []).push(line.raw);
      if (line.name === 'UID') keep.uid = value.slice(0, 200);
      else if (line.name === 'VERSION') keep.version = value.trim().slice(0, 10);
      else if (line.name === 'FN') cur.name = v.slice(0, 500);
      else if (line.name === 'N') {
        const [family, given, middle] = splitParts(value);
        nameFromN = [given, middle, family].filter(Boolean).join(' ');
        // A card made here has the whole name as "family" and nothing as "given": that says nothing about which is which.
        if (given) [cur.given, cur.family] = [given.slice(0, 500), (family ?? '').slice(0, 500)];
      } else if (line.name === 'ORG') cur.org = splitParts(value).filter(Boolean).join(', ').slice(0, 500);
      else if (line.name === 'TEL') addTo(cur, keep, 'phones', v.trim().slice(0, 60), line.raw);
      else if (line.name === 'EMAIL') addTo(cur, keep, 'emails', v.trim().slice(0, 200), line.raw);
      else if (line.name === 'ADR' && !cur.address) cur.address = splitParts(value).filter(Boolean).join(', ').slice(0, 500);
      else if (line.name === 'BDAY') {
        const m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(value);
        if (m) cur.birthday = `${m[1]}-${m[2]}-${m[3]}`;
      } else if (line.name === 'NOTE') cur.notes = v.slice(0, 20000);
      else if (!field) keep.lines.push(line.raw);
    }
  }
  return out;
}

export function writeVcf(contacts: Contact[]): string {
  const out: string[] = [];
  for (const c of copiesInOrder(contacts)) {
    const k = c.keep;
    // Unchanged here: the file's own lines for that field. Changed (or a card made here): written fresh.
    const kept = (f: Field): string[] | null => (k && k.raw[f]?.length && k.was[f] === valueOf(c, f) ? k.raw[f]!.map(foldLine) : null);
    out.push('BEGIN:VCARD', `VERSION:${k?.version || '3.0'}`, writeLine('UID', k?.uid || c.uid));
    // N is required by the format; the whole name goes in the family-name part rather than guessing where it splits.
    out.push(...(kept('name') ?? [writeLine('FN', escapeValue(c.name)), writeLine('N', `${escapeValue(c.name)};;;;`)]));
    out.push(...(kept('org') ?? (c.org ? [writeLine('ORG', escapeValue(c.org))] : [])));
    out.push(...(kept('phones') ?? listLines(c, 'phones', 'TEL')));
    out.push(...(kept('emails') ?? listLines(c, 'emails', 'EMAIL')));
    // Only the first address is shown here: a changed one replaces it, and any others stay.
    out.push(...(kept('address') ?? [...(c.address ? [writeLine('ADR', `;;${escapeValue(c.address)};;;;`)] : []), ...(k?.raw.address?.slice(1).map(foldLine) ?? [])]));
    out.push(...(kept('birthday') ?? (c.birthday ? [`BDAY:${c.birthday}`] : [])));
    out.push(...(kept('notes') ?? (c.notes ? [writeLine('NOTE', escapeValue(c.notes))] : [])));
    for (const raw of k?.lines ?? []) out.push(foldLine(raw));
    out.push('END:VCARD');
  }
  return out.join('\r\n') + (out.length ? '\r\n' : '');
}
