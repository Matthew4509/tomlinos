// Letters from a list (mail merge) and ready-made documents (templates) for Write. A letter has fields
// («Name», «Address»...) that are filled in from each row of a list: the people in Contacts, or a spreadsheet (its
// first row names the columns). One letter per row, each starting on a new page. No browser needed.
import { parseVcf } from '../../core/vcard.ts';
import type { NodeJSON } from './model.ts';

export type Row = Record<string, string>;

export interface MergeList {
  /** Where the list came from, in words ("Contacts", "Members.xlsx"). */
  from: string;
  columns: string[];
  rows: Row[];
}

/** The columns a Contacts list offers. */
export const CONTACT_COLUMNS = ['Name', 'First name', 'Last name', 'Organisation', 'Email', 'Phone', 'Address', 'Birthday', 'Notes'];

/** The people in a contacts file (.vcf) as rows. */
export function contactsList(vcf: string): MergeList {
  const rows = parseVcf(vcf).map(c => {
    const words = c.name.trim().split(/\s+/);
    return {
      Name: c.name, 'First name': words[0] ?? '', 'Last name': words.slice(1).join(' '), Organisation: c.org, Email: c.emails[0] ?? '',
      Phone: c.phones[0] ?? '', Address: c.address, Birthday: c.birthday, Notes: c.notes,
    };
  });
  return { from: 'Contacts', columns: CONTACT_COLUMNS, rows };
}

/** A table of text (tab between columns, a line a row; the first row names the columns) as a list. Empty rows go. */
export function tableList(tsv: string, from: string): MergeList {
  const lines = tsv.replace(/\r\n?/g, '\n').split('\n');
  const head = (lines.shift() ?? '').split('\t').map(h => h.trim());
  // Columns with no name get one ("Column 3"); a name used twice gets a number.
  const seen = new Map<string, number>();
  const columns = head.map((h, i) => {
    let name = h || `Column ${i + 1}`;
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    if (n > 1) name = `${name} ${n}`;
    return name;
  });
  while (columns.length && !head[columns.length - 1]) columns.pop();
  const rows: Row[] = [];
  for (const line of lines) {
    const cells = line.split('\t');
    if (!cells.some(c => c.trim())) continue;
    const row: Row = {};
    columns.forEach((c, i) => {
      row[c] = (cells[i] ?? '').trim();
    });
    rows.push(row);
  }
  return { from, columns, rows };
}

/** The fields a document uses (their names, in the order they first appear). */
export function fieldsIn(doc: NodeJSON): string[] {
  const out: string[] = [];
  const walk = (n: NodeJSON) => {
    if (n.type === 'field') {
      const name = String(n.attrs?.name ?? '');
      if (name && !out.includes(name)) out.push(name);
    }
    for (const c of n.content ?? []) walk(c);
  };
  walk(doc);
  return out;
}

/** A column for a field: the same name, ignoring case and spaces ("first name" finds "First Name"). */
const columnFor = (row: Row, name: string): string | undefined => {
  if (name in row) return row[name];
  const key = name.toLowerCase().replace(/[\s_.-]/g, '');
  const found = Object.keys(row).find(k => k.toLowerCase().replace(/[\s_.-]/g, '') === key);
  return found === undefined ? undefined : row[found];
};

/** The document with its fields filled in from one row (a field the row lacks is left empty). */
export function fillFields(doc: NodeJSON, row: Row): NodeJSON {
  const fill = (n: NodeJSON): NodeJSON | null => {
    if (n.type === 'field') {
      const text = columnFor(row, String(n.attrs?.name ?? '')) ?? '';
      return text ? (n.marks?.length ? { type: 'text', text, marks: n.marks } : { type: 'text', text }) : null;
    }
    if (!n.content) return n;
    const content: NodeJSON[] = [];
    for (const c of n.content) {
      const f = fill(c);
      if (!f) continue;
      // Text next to text with the same look joins (as the editor keeps it).
      const last = content[content.length - 1];
      if (f.type === 'text' && last?.type === 'text' && JSON.stringify(last.marks ?? []) === JSON.stringify(f.marks ?? [])) content[content.length - 1] = { ...last, text: (last.text ?? '') + f.text };
      else content.push(f);
    }
    return content.length ? { ...n, content } : { ...n, content: undefined };
  };
  return fill(doc) ?? { type: 'doc', content: [{ type: 'paragraph' }] };
}

/** One letter per row, each on a new page, in one document. */
export function mergeAll(doc: NodeJSON, rows: Row[]): NodeJSON {
  const content: NodeJSON[] = [];
  rows.forEach((row, i) => {
    if (i) content.push({ type: 'page_break' });
    content.push(...(fillFields(doc, row).content ?? []));
  });
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}

// ---- Templates ----------------------------------------------------------------------------------------------------

const p = (text: string, attrs: Record<string, unknown> = {}): NodeJSON => (text ? { type: 'paragraph', attrs: { style: 'normal', ...attrs }, content: [{ type: 'text', text }] } : { type: 'paragraph', attrs: { style: 'normal', ...attrs } });
const bullets = (...items: string[]): NodeJSON => ({ type: 'bullet_list', content: items.map(t => ({ type: 'list_item', content: [p(t)] })) });

export const TEMPLATES: Record<'letter' | 'cv' | 'report', { label: string; name: string; doc: NodeJSON }> = {
  letter: {
    label: 'Letter',
    name: 'Letter',
    doc: {
      type: 'doc',
      content: [
        p('Your name', { align: 'right', after: 0 }), p('Your street address', { align: 'right', after: 0 }), p('Town and postcode', { align: 'right' }),
        p('Date'),
        p('Their name', { after: 0 }), p('Their street address', { after: 0 }), p('Town and postcode'),
        p('Dear Their name,'),
        p('Write the first paragraph here: why you are writing.'),
        p('A second paragraph with the details.'),
        p('Yours sincerely,', { before: 12 }),
        p('', { after: 24 }),
        p('Your name'),
      ],
    },
  },
  cv: {
    label: 'CV (curriculum vitae)',
    name: 'CV',
    doc: {
      type: 'doc',
      content: [
        p('Your Name', { style: 'title' }),
        p('Town · phone · email · website', { after: 12 }),
        p('Profile', { style: 'h1' }),
        p('Two or three lines about who you are, what you are good at and the kind of work you are looking for.'),
        p('Experience', { style: 'h1' }),
        p('Job title, Employer', { style: 'h2' }),
        p('Month year to month year', { after: 4 }),
        bullets('What you did, and what came of it.', 'Another thing you are proud of.'),
        p('Job title, Employer', { style: 'h2' }),
        p('Month year to month year', { after: 4 }),
        bullets('What you did, and what came of it.'),
        p('Education', { style: 'h1' }),
        p('Course or qualification, School or college, year'),
        p('Skills', { style: 'h1' }),
        bullets('A skill', 'Another skill', 'Languages you speak'),
      ],
    },
  },
  report: {
    label: 'Report (with a contents page)',
    name: 'Report',
    doc: {
      type: 'doc',
      content: [
        p('Report title', { style: 'title' }),
        p('A line saying what it is about · your name · date', { after: 24 }),
        { type: 'toc', attrs: { title: 'Contents' } },
        { type: 'page_break' },
        p('Introduction', { style: 'h1' }),
        p('What this report covers, and why.'),
        p('Findings', { style: 'h1' }),
        p('First finding', { style: 'h2' }),
        p('The details.'),
        {
          type: 'table',
          attrs: { borders: true },
          content: [['Item', 'Figure'], ['First', ''], ['Second', '']].map(r => ({ type: 'table_row', content: r.map(t => ({ type: 'table_cell', attrs: { colspan: 1, rowspan: 1, colwidth: null, background: null }, content: [p(t)] })) })),
        },
        p('Second finding', { style: 'h2' }),
        p('The details.'),
        p('Conclusion', { style: 'h1' }),
        p('What should happen next.'),
      ],
    },
  },
};
