// Contacts read from and written to a .vcf file (vCard 3.0), so the address book can be downloaded into a phone or
// another program, and a .vcf from elsewhere can be opened here.
import { escapeValue, readLines, splitParts, unescapeValue, writeLine } from './lines.ts';

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
}

export const emptyContact = (): Contact => ({ uid: crypto.randomUUID(), name: '', org: '', phones: [], emails: [], address: '', birthday: '', notes: '' });

export function parseVcf(text: string): Contact[] {
  const out: Contact[] = [];
  let cur: Contact | null = null;
  let nameFromN = '';
  for (const line of readLines(text)) {
    if (line.name === 'BEGIN' && line.value.toUpperCase() === 'VCARD') {
      cur = emptyContact();
      nameFromN = '';
    } else if (line.name === 'END' && line.value.toUpperCase() === 'VCARD') {
      if (cur) {
        if (!cur.name) cur.name = nameFromN || cur.org || cur.emails[0] || cur.phones[0] || '(no name)';
        out.push(cur);
      }
      cur = null;
    } else if (cur) {
      const v = unescapeValue(line.value);
      if (line.name === 'UID') cur.uid = line.value.slice(0, 200);
      else if (line.name === 'FN') cur.name = v.slice(0, 300);
      else if (line.name === 'N') {
        const [family, given, middle] = splitParts(line.value);
        nameFromN = [given, middle, family].filter(Boolean).join(' ');
      } else if (line.name === 'ORG') cur.org = splitParts(line.value).filter(Boolean).join(', ').slice(0, 300);
      else if (line.name === 'TEL' && v.trim() && cur.phones.length < 20) cur.phones.push(v.trim().slice(0, 60));
      else if (line.name === 'EMAIL' && v.trim() && cur.emails.length < 20) cur.emails.push(v.trim().slice(0, 200));
      else if (line.name === 'ADR' && !cur.address) cur.address = splitParts(line.value).filter(Boolean).join(', ').slice(0, 500);
      else if (line.name === 'BDAY') {
        const m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(line.value);
        if (m) cur.birthday = `${m[1]}-${m[2]}-${m[3]}`;
      } else if (line.name === 'NOTE') cur.notes = v.slice(0, 20000);
    }
  }
  return out;
}

export function writeVcf(contacts: Contact[]): string {
  const out: string[] = [];
  for (const c of contacts) {
    out.push('BEGIN:VCARD', 'VERSION:3.0', writeLine('UID', c.uid), writeLine('FN', escapeValue(c.name)));
    // N is required by the format; the whole name goes in the family-name part rather than guessing where it splits.
    out.push(writeLine('N', `${escapeValue(c.name)};;;;`));
    if (c.org) out.push(writeLine('ORG', escapeValue(c.org)));
    for (const p of c.phones) out.push(writeLine('TEL', escapeValue(p)));
    for (const e of c.emails) out.push(writeLine('EMAIL', escapeValue(e)));
    if (c.address) out.push(writeLine('ADR', `;;${escapeValue(c.address)};;;;`));
    if (c.birthday) out.push(`BDAY:${c.birthday}`);
    if (c.notes) out.push(writeLine('NOTE', escapeValue(c.notes)));
    out.push('END:VCARD');
  }
  return out.join('\r\n') + (out.length ? '\r\n' : '');
}
