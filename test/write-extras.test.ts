// Write's footnotes, contents page, mail merge and templates: footnotes written to Word's footnotes part and
// read back (one from a Word file, unchanged, keeps its own note); a page keeps room at its foot for the footnotes
// of its lines; a contents page written as Word's TOC field and read back; merge fields both ways; letters made from
// Contacts and from a spreadsheet's rows; every template fits the editor.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readZip } from '../src/apps/archive/read.ts';
import { readDocx, writeDocx, headingsOf } from '../src/apps/write/docx.ts';
import { bodyBottom, NOTE_RULE, paginate, type Geometry, type Unit } from '../src/apps/write/layout.ts';
import { contactsList, fieldsIn, fillFields, mergeAll, tableList, TEMPLATES } from '../src/apps/write/merge.ts';
import { defaultPage, plainText, type NodeJSON } from '../src/apps/write/model.ts';
import { buildSchema } from '../src/apps/write/schema.ts';

const page = defaultPage('en-GB');
const p = (...content: NodeJSON[]): NodeJSON => ({ type: 'paragraph', attrs: { style: 'normal' }, content });
const t = (text: string): NodeJSON => ({ type: 'text', text });
const files = async (bytes: Uint8Array) => new Map(await Promise.all(readZip(bytes).filter(e => !e.folder).map(async e => [e.parts.join('/'), new TextDecoder().decode(await e.read())] as const)));
const schemaP = import('../public/vendor/prosemirror.js' as string).then(pm => buildSchema(pm));
const find = (n: NodeJSON, type: string, out: NodeJSON[] = []): NodeJSON[] => {
  if (n.type === type) out.push(n);
  n.content?.forEach(c => find(c, type, out));
  return out;
};

test('footnotes: written to Word’s footnotes part, read back as footnotes with their words', async () => {
  const doc: NodeJSON = { type: 'doc', content: [p(t('A claim'), { type: 'footnote', attrs: { text: 'The source & a page', id: 0 } }, t(' and another'), { type: 'footnote', attrs: { text: 'Second note', id: 0 } })] };
  const bytes = await writeDocx(doc, page);
  const parts = await files(bytes);
  assert.ok(parts.get('word/footnotes.xml')?.includes('w:type="separator" w:id="-1"'));
  assert.ok(parts.get('word/footnotes.xml')?.includes('The source &amp; a page'));
  assert.ok(parts.get('word/document.xml')?.includes('<w:footnoteReference w:id="1"/>') && parts.get('word/document.xml')?.includes('<w:footnoteReference w:id="2"/>'));
  assert.ok(parts.get('word/_rels/document.xml.rels')?.includes('footnotes.xml'));
  assert.ok(parts.get('[Content_Types].xml')?.includes('/word/footnotes.xml'));
  const back = await readDocx(bytes);
  assert.deepEqual(find(back.doc, 'footnote').map(n => n.attrs), [{ text: 'The source & a page', id: 1 }, { text: 'Second note', id: 2 }]);
  // Saving over it: the unchanged first note keeps its number; the changed second one is written as a new note.
  find(back.doc, 'footnote')[1].attrs!.text = 'Second note, changed';
  const again = await files(await writeDocx(back.doc, back.page, '', back.source));
  assert.ok(again.get('word/document.xml')?.includes('<w:footnoteReference w:id="1"/>'));
  assert.ok(again.get('word/document.xml')?.includes('<w:footnoteReference w:id="3"/>'));
  assert.ok(again.get('word/footnotes.xml')?.includes('Second note, changed'));
  (await schemaP).nodeFromJSON(back.doc).check();
});

test('a page keeps room at its foot for its lines’ footnotes; a line whose note does not fit moves on', () => {
  const g: Geometry = { pageH: 1123, top: 96, body: 931, gap: 24 };
  const lines: Unit[] = Array.from({ length: 46 }, (_, i) => ({ top: 96 + i * 20, height: 20, spacer: 0 }));
  // Without notes all 46 fit; a 60-pixel note on line 40 takes the last lines' room.
  lines[39].notes = 60;
  const r = paginate(lines, g);
  const onFirst = r.pageOf.filter(x => x === 0).length;
  assert.ok(onFirst < 46 && onFirst >= 40, `lines on page 1: ${onFirst}`);
  assert.equal(r.notes[0], 60 + NOTE_RULE);
  // The last line on page 1 ends above the notes.
  assert.ok(96 + onFirst * 20 <= bodyBottom(g, 0) - r.notes[0]);
  // A note on the very line that no longer fits goes with it to page 2.
  const late: Unit[] = Array.from({ length: 47 }, (_, i) => ({ top: 96 + i * 20, height: 20, spacer: 0 }));
  late[45].notes = 40;
  const r2 = paginate(late, g);
  assert.equal(r2.pageOf[45], 1);
  assert.equal(r2.notes[0], 0);
  assert.equal(r2.notes[1], 40 + NOTE_RULE);
});

test('a contents page: Word’s TOC field with each heading and its page, read back as a contents page', async () => {
  const doc: NodeJSON = { type: 'doc', content: [
    { type: 'toc', attrs: { title: 'Contents' } },
    { type: 'paragraph', attrs: { style: 'h1' }, content: [t('Introduction')] },
    p(t('text')),
    { type: 'paragraph', attrs: { style: 'h2' }, content: [t('Detail')] },
    { type: 'paragraph', attrs: { style: 'h3' }, content: [] },
  ] };
  assert.deepEqual(headingsOf(doc), [{ level: 1, text: 'Introduction' }, { level: 2, text: 'Detail' }]);
  const bytes = await writeDocx(doc, page, '', undefined, { headingPages: [2, 3] });
  const xml = (await files(bytes)).get('word/document.xml')!;
  assert.ok(xml.includes('w:docPartGallery w:val="Table of Contents"'));
  assert.ok(/TOC \\o "1-3"/.test(xml));
  assert.ok(/Introduction<\/w:t><\/w:r><w:r><w:tab\/><\/w:r><w:r><w:t>2<\/w:t>/.test(xml));
  assert.ok(xml.includes('w:pStyle w:val="TOC2"'));
  const back = await readDocx(bytes);
  assert.equal(back.doc.content![0].type, 'toc');
  assert.equal(back.doc.content![0].attrs?.title, 'Contents');
  assert.equal(back.doc.content![1].attrs?.style, 'h1');
});

test('merge fields both ways, and letters from Contacts and from a spreadsheet', async () => {
  const letter: NodeJSON = { type: 'doc', content: [p(t('Dear '), { type: 'field', attrs: { name: 'First name' } }, t(',')), p(t('We will call '), { type: 'field', attrs: { name: 'Phone' }, marks: [{ type: 'strong' }] })] };
  assert.deepEqual(fieldsIn(letter), ['First name', 'Phone']);
  // Word's MERGEFIELD (names with spaces become _), read back as fields.
  const bytes = await writeDocx(letter, page);
  assert.ok((await files(bytes)).get('word/document.xml')?.includes('<w:fldSimple w:instr=" MERGEFIELD First_name ">'));
  const back = await readDocx(bytes);
  assert.deepEqual(fieldsIn(back.doc), ['First_name', 'Phone']);
  const vcf = 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Ann Lee\r\nTEL:0400 111 222\r\nEND:VCARD\r\nBEGIN:VCARD\r\nVERSION:3.0\r\nFN:Bob\r\nEND:VCARD\r\n';
  const people = contactsList(vcf);
  assert.equal(people.rows.length, 2);
  assert.equal(people.rows[0]['First name'], 'Ann');
  const one = fillFields(back.doc, people.rows[0]);
  assert.equal(plainText(one), 'Dear Ann,\nWe will call 0400 111 222');
  // A field in bold stays bold once filled; a field with no value in the row is left out.
  assert.ok(find(one, 'text').some(n => n.text === '0400 111 222' && n.marks?.[0]?.type === 'strong'));
  assert.equal(plainText(fillFields(back.doc, people.rows[1])), 'Dear Bob,\nWe will call ');
  const all = mergeAll(letter, people.rows);
  assert.deepEqual(all.content!.map(b => b.type), ['paragraph', 'paragraph', 'page_break', 'paragraph', 'paragraph']);
  (await schemaP).nodeFromJSON(all).check();
  // A spreadsheet: the first row names the columns; blank rows go; unnamed and repeated names are made unique.
  const sheet = tableList('Name\tCity\t\tName\nAnn\tPerth\tx\tA2\n\t\t\t\nBob\tHobart', 'Members.xlsx');
  assert.deepEqual(sheet.columns, ['Name', 'City', 'Column 3', 'Name 2']);
  assert.equal(sheet.rows.length, 2);
  assert.equal(sheet.rows[1].City, 'Hobart');
});

test('every template fits the editor, and the report’s contents page lists its headings', async () => {
  const schema = await schemaP;
  for (const tpl of Object.values(TEMPLATES)) schema.nodeFromJSON(tpl.doc).check();
  assert.ok(headingsOf(TEMPLATES.report.doc).length >= 4);
  const bytes = await writeDocx(TEMPLATES.cv.doc, page, 'CV');
  assert.equal((await readDocx(bytes)).doc.content![0].attrs?.style, 'title');
});

test('a spreadsheet cell with a line break (a two-line address) stays one person, not two letters', async () => {
  const { Workbook } = await import('../src/apps/sheet/workbook.ts');
  const wb = new Workbook();
  wb.importText(0, 0, 0, 'Name,Address\nAnn,"12 High St\nLeeds"\nBob,"He said ""hi"""\n');
  const list = tableList(wb.exportText(0, wb.usedRange(0), '\t'), 'People.csv');
  assert.deepEqual(list.rows, [{ Name: 'Ann', Address: '12 High St\nLeeds' }, { Name: 'Bob', Address: 'He said "hi"' }]);
  // Text that only looks quoted keeps its quotes, and one stray quote does not swallow the rows after it.
  assert.deepEqual(tableList('A\tB\n"half\tx\ny\tz', 'x').rows, [{ A: '"half', B: 'x' }, { A: 'y', B: 'z' }]);
  assert.deepEqual(tableList('A\n"said" twice', 'x').rows, [{ A: '"said" twice' }]);
  // Windows line ends inside a quoted cell, a tab inside one.
  assert.deepEqual(tableList('A\tB\r\n"1\r\n2"\t"x\ty"\r\n', 'x').rows, [{ A: '1\n2', B: 'x\ty' }]);
});

test('a value with a line break goes into the letter as a line break the editor and Word both keep', async () => {
  const doc: NodeJSON = { type: 'doc', content: [p(t('To: '), { type: 'field', attrs: { name: 'Address' }, marks: [{ type: 'strong' }] }, t(' today'))] };
  const filled = fillFields(doc, { Address: '12 High St\nLeeds' });
  assert.deepEqual(filled.content?.[0].content, [
    t('To: '), { type: 'text', text: '12 High St', marks: [{ type: 'strong' }] }, { type: 'hard_break', marks: [{ type: 'strong' }] }, { type: 'text', text: 'Leeds', marks: [{ type: 'strong' }] }, t(' today'),
  ]);
  (await schemaP).nodeFromJSON(filled).check();
  assert.match((await files(await writeDocx(filled, page))).get('word/document.xml') ?? '', /12 High St<\/w:t><\/w:r><w:r>(<w:rPr>.*?<\/w:rPr>)?<w:br\/>/);
});
