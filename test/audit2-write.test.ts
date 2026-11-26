// Round-2 audit of Write (app code WR): what a Word, RTF or Markdown file must keep through Write, and what a Word file
// Write saves must be for Word to open it (the file format's own rules are the oracle). P0 tests fail now and pass once
// fixed; P1 and P2 tests are marked todo.
// Run: node --test test/audit2-write.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readZip } from '../src/apps/archive/read.ts';
import { zipDeflate } from '../src/core/zip.ts';
import { parseXml } from '../src/core/xml.ts';
import { readDocx, writeDocx, DocxProblem } from '../src/apps/write/docx.ts';
import { readRtf } from '../src/apps/write/rtf.ts';
import { readMarkdown, writeMarkdown } from '../src/apps/write/markdown.ts';
import { plainText, defaultPage, type NodeJSON } from '../src/apps/write/model.ts';
import { fillFields } from '../src/apps/write/merge.ts';

const enc = new TextEncoder();
const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** A Word file as another program writes one: the main part with this body, and any other parts given. */
async function wordFile(body: string, parts: Record<string, string> = {}): Promise<Uint8Array> {
  const files: Record<string, string> = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': `<?xml version="1.0"?><Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Type="${OFFICE_REL}/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/document.xml': `<?xml version="1.0"?><w:document ${W_NS}><w:body>${body}</w:body></w:document>`,
    ...parts,
  };
  return zipDeflate(Object.entries(files).map(([name, s]) => ({ name, data: enc.encode(s), modified: 0 })));
}

async function partOf(file: Uint8Array, path: string): Promise<string> {
  for (const e of readZip(file)) if (e.parts.join('/') === path) return new TextDecoder().decode(await e.read());
  throw new Error(`no ${path} in the file`);
}

const para = (content: NodeJSON[]): NodeJSON => ({ type: 'paragraph', attrs: { style: 'normal' }, content });
const text = (t: string, marks?: NodeJSON['marks']): NodeJSON => (marks ? { type: 'text', text: t, marks } : { type: 'text', text: t });

// ---- P0 -------------------------------------------------------------------------------------------------------------

test('WR-1: a 2 KB Word file whose table has one long row and many short rows is refused or stays small (no padding to millions of cells)', async () => {
  const N = 1500;
  const wide = '<w:tr>' + '<w:tc><w:p/></w:tc>'.repeat(N) + '</w:tr>';
  const tall = '<w:tr><w:tc><w:p/></w:tc></w:tr>'.repeat(N);
  const file = await wordFile(`<w:tbl>${wide}${tall}</w:tbl>`);
  assert.ok(file.length < 4000, 'the file is tiny');
  let cells = 0;
  try {
    const read = await readDocx(file);
    const walk = (n: NodeJSON) => {
      if (n.type === 'table_cell') cells++;
      for (const c of n.content ?? []) walk(c);
    };
    walk(read.doc);
  } catch (error) {
    assert.ok(error instanceof DocxProblem, 'refused with a reason');
    return;
  }
  // Word itself holds at most 63 columns; the Markdown and LibreOffice readers cap their tables too.
  assert.ok(cells <= 100_000, `a ${file.length}-byte file became ${cells.toLocaleString()} table cells (the editor then hangs the page)`);
});

test('WR-1b: a 60 KB RTF file whose table has one long row and many short rows is not padded out to millions of cells', () => {
  const N = 1500;
  const src = '{\\rtf1\\ansi\\trowd\\cellx100\\intbl ' + 'a\\cell '.repeat(N) + '\\row ' + '\\trowd\\cellx100\\intbl b\\cell\\row '.repeat(N) + '\\pard after\\par}';
  let cells = 0;
  try {
    const walk = (n: NodeJSON) => {
      if (n.type === 'table_cell') cells++;
      for (const c of n.content ?? []) walk(c);
    };
    walk(readRtf(enc.encode(src)).doc);
  } catch {
    return; // Refused: fine.
  }
  assert.ok(cells <= 100_000, `${src.length.toLocaleString()} bytes of RTF became ${cells.toLocaleString()} table cells`);
});

test('WR-2: saving over a Word file whose list part ends with numIdMacAtCleanup keeps the list part in the order Word requires', async () => {
  // Word writes numIdMacAtCleanup as the list part's last element; the file format puts every w:num before it.
  const numbering = `<?xml version="1.0"?><w:numbering ${W_NS}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:numIdMacAtCleanup w:val="0"/></w:numbering>`;
  const rels = `<?xml version="1.0"?><Relationships xmlns="${PKG_REL}"><Relationship Id="rId5" Type="${OFFICE_REL}/numbering" Target="numbering.xml"/></Relationships>`;
  const read = await readDocx(await wordFile('<w:p><w:r><w:t>Some words</w:t></w:r></w:p>', { 'word/numbering.xml': numbering, 'word/_rels/document.xml.rels': rels }));
  // The person changes one word and saves over the file (no list added).
  const out = await writeDocx({ type: 'doc', content: [para([text('Some more words')])] }, read.page, 'x', read.source);
  const kids = parseXml(await partOf(out, 'word/numbering.xml')).kids.map(k => k.name);
  const order = ['numPicBullet', 'abstractNum', 'num', 'numIdMacAtCleanup'];
  for (let i = 1; i < kids.length; i++) {
    assert.ok(order.indexOf(kids[i - 1]) <= order.indexOf(kids[i]), `the list part's children are out of order: ${kids.join(', ')}`);
  }
});

test('WR-3: a new document with a footnote has its settings part in the order Word requires (footnotePr after characterSpacingControl)', async () => {
  const doc: NodeJSON = { type: 'doc', content: [para([text('Words'), { type: 'footnote', attrs: { text: 'A note', id: 0 } }])] };
  const out = await writeDocx(doc, defaultPage('en-GB'), 'Notes');
  const kids = parseXml(await partOf(out, 'word/settings.xml')).kids.map(k => k.name);
  // CT_Settings is a sequence: defaultTabStop ... characterSpacingControl ... footnotePr, endnotePr, compat ...
  const order = ['defaultTabStop', 'characterSpacingControl', 'footnotePr', 'endnotePr', 'compat'];
  const seen = kids.filter(k => order.includes(k));
  assert.deepEqual(seen, [...seen].sort((a, b) => order.indexOf(a) - order.indexOf(b)), `settings children: ${kids.join(', ')}`);
});

test('WR-18: letters from a CSV list show each value as written (a postcode keeps its leading 0, an amount its 2 decimals, a date its form)', async () => {
  // The path Write's "List from a spreadsheet" takes for a .csv (write.ts listFromSheet): split as text, then a list.
  const { parseDelimited } = await import('../src/apps/sheet/workbook.ts');
  const { rowsList } = await import('../src/apps/write/merge.ts');
  const list = rowsList(parseDelimited('Name,Postcode,Amount,Due,Ref\nAnn,02134,"1,234.50",2025-12-31,1e5\n'), 'people.csv');
  assert.deepEqual({ ...list.rows[0] }, { Name: 'Ann', Postcode: '02134', Amount: '1,234.50', Due: '2025-12-31', Ref: '1e5' });
});

// ---- P1 -------------------------------------------------------------------------------------------------------------

test('WR-4: a link added to a Word file whose relationships part is written empty (self-closing) is kept through a save', async () => {
  const rels = `<?xml version="1.0"?><Relationships xmlns="${PKG_REL}"/>`;
  const read = await readDocx(await wordFile('<w:p><w:r><w:t>x</w:t></w:r></w:p>', { 'word/_rels/document.xml.rels': rels }));
  const doc: NodeJSON = { type: 'doc', content: [para([text('a link', [{ type: 'link', attrs: { href: 'https://example.test/' } }])])] };
  const out = await writeDocx(doc, read.page, 'x', read.source);
  const relsOut = await partOf(out, 'word/_rels/document.xml.rels');
  assert.match(relsOut, /https:\/\/example\.test\//, 'the link has its relationship (the main part names an id that is not there)');
});

test('WR-5: a mail merge field whose name has a space (MERGEFIELD "First name") keeps its whole name', async () => {
  const read = await readDocx(await wordFile('<w:p><w:fldSimple w:instr=" MERGEFIELD &quot;First name&quot; "><w:r><w:t>«First name»</w:t></w:r></w:fldSimple></w:p>'));
  const field = read.doc.content![0].content![0];
  assert.equal(field.attrs?.name, 'First name');
  // So the letters are filled in, not left empty.
  const filled = fillFields(read.doc, { 'First name': 'Ann' });
  assert.equal(plainText(filled), 'Ann');
});

test('WR-6: a footnote from a Word file copied and pasted is two footnotes, not two references to one', async () => {
  const notes = `<?xml version="1.0"?><w:footnotes ${W_NS}><w:footnote w:type="separator" w:id="-1"><w:p/></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p/></w:footnote><w:footnote w:id="1"><w:p><w:r><w:t>The note</w:t></w:r></w:p></w:footnote></w:footnotes>`;
  const rels = `<?xml version="1.0"?><Relationships xmlns="${PKG_REL}"><Relationship Id="rId9" Type="${OFFICE_REL}/footnotes" Target="footnotes.xml"/></Relationships>`;
  const read = await readDocx(await wordFile('<w:p><w:r><w:t>a</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p>', { 'word/footnotes.xml': notes, 'word/_rels/document.xml.rels': rels }));
  const p = read.doc.content![0];
  const out = await writeDocx({ type: 'doc', content: [p, structuredClone(p)] }, read.page, 'x', read.source);
  const ids = [...(await partOf(out, 'word/document.xml')).matchAll(/footnoteReference w:id="(\d+)"/g)].map(m => m[1]);
  assert.equal(new Set(ids).size, ids.length, `footnote references: ${ids.join(', ')}`);
});

test('WR-9: words in a text box of an RTF file are kept, or said to be left out', () => {
  const rtf = String.raw`{\rtf1\ansi\deff0{\fonttbl{\f0 Calibri;}}\pard Before box\par{\shp{\*\shpinst\shpleft0\shptop0{\sp{\sn shapeType}{\sv 202}}{\shptxt \pard Words in the box\par}}{\shprslt{\*\do\dobxcolumn}}}\pard After box\par}`;
  const read = readRtf(enc.encode(rtf));
  const words = plainText(read.doc);
  assert.ok(words.includes('Words in the box') || read.dropped.length > 0, `shown: ${JSON.stringify(words)}, said: ${JSON.stringify(read.dropped)}`);
});

test('WR-10: a Markdown link whose address has brackets (a Wikipedia page) keeps its address and words', () => {
  const src = 'See [Foo](https://en.wikipedia.org/wiki/Foo_(bar)) here.\n';
  const doc = readMarkdown(src);
  assert.equal(plainText(doc), 'See Foo here.', 'no stray bracket in the words');
  const link = doc.content![0].content!.find(n => n.marks?.some(m => m.type === 'link'));
  assert.equal(link?.marks?.find(m => m.type === 'link')?.attrs?.href, 'https://en.wikipedia.org/wiki/Foo_(bar)');
});

test('WR-11: a Markdown list item with a second paragraph stays one list (numbering does not start again)', () => {
  const doc = readMarkdown('1. one\n2. two\n\n   more about two\n3. three\n');
  assert.equal(doc.content!.length, 1, `blocks: ${doc.content!.map(b => b.type).join(', ')}`);
});

test('WR-11b: a Markdown table written without outer pipes stays a table through Write', () => {
  const doc = readMarkdown('a | b\n--|--\n1 | 2\n');
  assert.equal(doc.content![0].type, 'table', `read as ${doc.content![0].type}; saved back as ${JSON.stringify(writeMarkdown(doc))}`);
});

test('WR-19: the words LibreOffice shows for its fields (file name, input field, variable, metadata) are kept', async () => {
  const { readOdt } = await import('../src/apps/write/odt.ts');
  const { zipStore } = await import('../src/core/zip.ts');
  const NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"';
  const body = '<text:p>File: <text:file-name>report.odt</text:file-name>; input: <text:text-input>typed answer</text:text-input>; var: <text:variable-get text:name="v">42</text:variable-get>; meta: <text:meta>tagged words</text:meta></text:p>';
  const content = `<?xml version="1.0"?><office:document-content ${NS}><office:body><office:text>${body}</office:text></office:body></office:document-content>`;
  const read = await readOdt(zipStore([{ name: 'mimetype', data: enc.encode('application/vnd.oasis.opendocument.text'), modified: 0 }, { name: 'content.xml', data: enc.encode(content), modified: 0 }]));
  assert.equal(plainText(read.doc), 'File: report.odt; input: typed answer; var: 42; meta: tagged words');
});

// ---- P2 -------------------------------------------------------------------------------------------------------------

test('WR-12: a field named with a space keeps its name through a save and reopen', async () => {
  const doc: NodeJSON = { type: 'doc', content: [para([{ type: 'field', attrs: { name: 'First name' } }])] };
  const back = await readDocx(await writeDocx(doc, defaultPage('en-GB'), 'x'));
  assert.equal(back.doc.content![0].content![0].attrs?.name, 'First name');
});

test('WR-15: an RTF link keeps its address', () => {
  const read = readRtf(enc.encode(String.raw`{\rtf1\ansi{\field{\*\fldinst HYPERLINK "https://a.test/"}{\fldrslt link words}}\par}`));
  const run = read.doc.content![0].content![0];
  assert.ok(run.marks?.some(m => m.type === 'link') || read.dropped.length > 0, 'the link is kept or said');
});

// ---- Round-2 fixes: more of the same paths --------------------------------------------------------------------------

test('WR-15b: the RTF link keeps its exact address, and an ODT link (text:a) keeps its address too', async () => {
  const read = readRtf(enc.encode(String.raw`{\rtf1\ansi Go {\field{\*\fldinst HYPERLINK "https://a.test/x"}{\fldrslt link words}} now\par}`));
  const run = read.doc.content![0].content!.find(n => n.text === 'link words');
  assert.equal(run?.marks?.find(m => m.type === 'link')?.attrs?.href, 'https://a.test/x');
  assert.equal(plainText(read.doc), 'Go link words now');
  const { readOdt } = await import('../src/apps/write/odt.ts');
  const { zipStore } = await import('../src/core/zip.ts');
  const NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:xlink="http://www.w3.org/1999/xlink"';
  const content = `<?xml version="1.0"?><office:document-content ${NS}><office:body><office:text><text:p>See <text:a xlink:href="https://b.test/">the page</text:a>.</text:p></office:text></office:body></office:document-content>`;
  const odt = await readOdt(zipStore([{ name: 'mimetype', data: enc.encode('application/vnd.oasis.opendocument.text'), modified: 0 }, { name: 'content.xml', data: enc.encode(content), modified: 0 }]));
  const linked = odt.doc.content![0].content!.find(n => n.text === 'the page');
  assert.equal(linked?.marks?.find(m => m.type === 'link')?.attrs?.href, 'https://b.test/');
});

test('WR-9b: the words of an RTF text box come through as their own paragraph, between the paragraphs around it', () => {
  const rtf = String.raw`{\rtf1\ansi\pard Before box\par{\shp{\*\shpinst\shpleft0{\sp{\sn shapeType}{\sv 202}}{\shptxt \pard Words in the box\par}}}\pard After box\par}`;
  assert.equal(plainText(readRtf(enc.encode(rtf)).doc), 'Before box\nWords in the box\nAfter box');
});

test('WR-11c: Markdown list items with second paragraphs, task boxes and indented code come back the same after a save', () => {
  const doc = readMarkdown('1. one\n2. two\n\n   more about two\n3. three\n');
  assert.equal(doc.content![0].content![1].content!.length, 2, 'item two has two paragraphs');
  assert.deepEqual(readMarkdown(writeMarkdown(doc)), doc, `saved as ${JSON.stringify(writeMarkdown(doc))}`);
  // Task boxes stay boxes, not escaped brackets.
  assert.equal(writeMarkdown(readMarkdown('- [ ] milk\n- [x] bread\n')), '- [ ] milk\n- [x] bread\n');
  // Code indented four spaces is code (in the code typeface, its own spaces kept) and saves as a code block.
  const code = readMarkdown('Text\n\n    let a = 1;\n      b();\n\nAfter\n');
  assert.equal(plainText(code), 'Text\nlet a = 1;\n  b();\nAfter');
  assert.ok(writeMarkdown(code).includes('```\nlet a = 1;\n  b();\n```'), writeMarkdown(code));
  // A table without outer pipes saves as a table, with its cells.
  assert.equal(writeMarkdown(readMarkdown('a | b\n--|--\n1 | 2\n')), '| a | b |\n| --- | --- |\n| 1 | 2 |\n');
});

test('WR-10b: an address with brackets saves and reads back whole', () => {
  const doc = readMarkdown('See [Foo](https://en.wikipedia.org/wiki/Foo_(bar)) here.\n');
  assert.deepEqual(readMarkdown(writeMarkdown(doc)), doc, writeMarkdown(doc));
});

test('Find: the stand-in for a picture is never found (so Replace never deletes one); whole words count letters outside the basic plane', async () => {
  const { findAll } = await import('../src/apps/write/find.ts');
  const { buildSchema } = await import('../src/apps/write/schema.ts');
  const pm = await import('../public/vendor/prosemirror.js' as string);
  const schema = buildSchema(pm);
  const doc = schema.nodeFromJSON({ type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'a ' }, { type: 'field', attrs: { name: 'Name' } }, { type: 'text', text: ' b ￼ typed' }] },
    { type: 'paragraph', content: [{ type: 'text', text: '\u{1D400}cat cat\u{1D400} cat' }] },
  ] });
  const hits = findAll(doc, '￼', { matchCase: false, wholeWord: false });
  assert.equal(hits.length, 1, 'only the character typed as text, not the field');
  assert.equal(doc.textBetween(hits[0].from, hits[0].to), '￼');
  // 𝐀 (a mathematical bold capital A) is a letter: "𝐀cat" and "cat𝐀" are not the whole word "cat".
  assert.equal(findAll(doc, 'cat', { matchCase: false, wholeWord: true }).length, 1);
});

test('A header typed in a LibreOffice file as "R&P Ltd" keeps its & (it is not the page number)', async () => {
  const { readOdt } = await import('../src/apps/write/odt.ts');
  const { fillLine } = await import('../src/apps/write/model.ts');
  const { zipStore } = await import('../src/core/zip.ts');
  const NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"';
  const styles = `<?xml version="1.0"?><office:document-styles ${NS}><office:master-styles><style:master-page style:name="Standard"><style:header><text:p>R&amp;P Ltd, page <text:page-number>1</text:page-number></text:p></style:header></style:master-page></office:master-styles></office:document-styles>`;
  const content = `<?xml version="1.0"?><office:document-content ${NS}><office:body><office:text><text:p>x</text:p></office:text></office:body></office:document-content>`;
  const read = await readOdt(zipStore([{ name: 'mimetype', data: enc.encode('application/vnd.oasis.opendocument.text'), modified: 0 }, { name: 'content.xml', data: enc.encode(content), modified: 0 }, { name: 'styles.xml', data: enc.encode(styles), modified: 0 }]));
  assert.equal(fillLine(read.page.header.c, 3, 9), 'R&P Ltd, page 3');
  // Typed in Write's own box: && is one & there, and &P stays the page number.
  assert.equal(fillLine('R&&P Ltd &P of &N', 2, 5), 'R&P Ltd 2 of 5');
});

test('CON-P1-11: letters from Contacts take the last word of a name as the family name ("Mary Ann Smith")', async () => {
  const { contactsList } = await import('../src/apps/write/merge.ts');
  const list = contactsList('BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Mary Ann Smith\r\nEND:VCARD\r\n');
  assert.equal(list.rows[0]['First name'], 'Mary Ann');
  assert.equal(list.rows[0]['Last name'], 'Smith');
});
