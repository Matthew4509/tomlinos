// Write tells what it cannot keep from a Word file, so "Save over?" asks before any of it is lost: links inside
// the document, list numbering it has no format for, tab stops, right indents, paragraph
// borders and shading, hidden text, capitals and letter spacing set as formatting, table styles, row heights and
// cell alignment. A file Write saved itself says none of them. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipDeflate } from '../src/core/zip.ts';
import { readZip } from '../src/apps/archive/read.ts';
import { readDocx, writeDocx } from '../src/apps/write/docx.ts';
import { defaultPage, plainText, textLoses, type NodeJSON } from '../src/apps/write/model.ts';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

/** A small .docx put together the way Word writes one. */
async function wordFile(body: string, styles = '', numbering = ''): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const rels = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>'
    + '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/" TargetMode="External"/></Relationships>';
  return zipDeflate([
    { name: '_rels/.rels', data: enc.encode('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="/word/document.xml"/></Relationships>'), modified: 0 },
    { name: 'word/document.xml', data: enc.encode(`<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`), modified: 0 },
    { name: 'word/_rels/document.xml.rels', data: enc.encode(rels), modified: 0 },
    { name: 'word/styles.xml', data: enc.encode(`<?xml version="1.0"?><w:styles ${W}><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>${styles}</w:styles>`), modified: 0 },
    { name: 'word/numbering.xml', data: enc.encode(`<?xml version="1.0"?><w:numbering ${W}>${numbering}</w:numbering>`), modified: 0 },
  ]);
}

const wp = (text: string, ppr = '', rpr = '') => `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const said = async (body: string, styles = '', numbering = '') => (await readDocx(await wordFile(body, styles, numbering))).dropped.join('\n');

test('a link to a place inside the document is said; a web link is kept, not said (write-keep.test.ts)', async () => {
  const inside = await said('<w:p><w:hyperlink w:anchor="_Toc1"><w:r><w:t>see below</w:t></w:r></w:hyperlink></w:p>');
  assert.match(inside, /links to places inside the document, or of a kind Write does not open/);
  assert.equal(await said('<w:p><w:hyperlink r:id="rId9"><w:r><w:t>our site</w:t></w:r></w:hyperlink></w:p>'), '');
});

test('Heading 4 to 9 and the document’s own styles are no longer said: they are kept (write-keep.test.ts)', async () => {
  const styles = '<w:style w:type="paragraph" w:styleId="Heading5"><w:name w:val="heading 5"/><w:basedOn w:val="Normal"/></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:rPr><w:i/></w:rPr></w:style>';
  assert.equal(await said(wp('Deep', '<w:pStyle w:val="Heading5"/>') + wp('Said', '<w:pStyle w:val="Quote"/>'), styles), '');
});

test('a style only defined, never used in the text, is not said', async () => {
  const styles = '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/></w:style>';
  assert.equal(await said(wp('Plain'), styles), '');
});

test('list numbering Write has no format for ("Step 1", none) is said; 1. a. i., (a) and 1.1 are not', async () => {
  const lvl = (i: number, fmt: string, text: string) => `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/></w:lvl>`;
  const numbering = `<w:abstractNum w:abstractNumId="1">${lvl(0, 'decimal', '%1.')}${lvl(1, 'decimal', '%1.%2.')}</w:abstractNum><w:num w:numId="3"><w:abstractNumId w:val="1"/></w:num>`
    + `<w:abstractNum w:abstractNumId="2">${lvl(0, 'lowerLetter', '(%1)')}</w:abstractNum><w:num w:numId="4"><w:abstractNumId w:val="2"/></w:num>`
    + `<w:abstractNum w:abstractNumId="5">${lvl(0, 'bullet', '')}${lvl(1, 'lowerLetter', '%2.')}</w:abstractNum><w:num w:numId="6"><w:abstractNumId w:val="5"/></w:num>`
    + `<w:abstractNum w:abstractNumId="7">${lvl(0, 'decimal', 'Step %1:')}</w:abstractNum><w:num w:numId="8"><w:abstractNumId w:val="7"/></w:num>`
    + `<w:abstractNum w:abstractNumId="9">${lvl(0, 'none', '')}</w:abstractNum><w:num w:numId="10"><w:abstractNumId w:val="9"/></w:num>`;
  const item = (id: number, lvlNo = 0) => wp('Item', `<w:numPr><w:ilvl w:val="${lvlNo}"/><w:numId w:val="${id}"/></w:numPr>`);
  assert.equal(await said(item(3) + item(6) + item(6, 1), '', numbering), '', 'decimal 1., a bullet and a. under it are what Write writes');
  assert.equal(await said(item(3) + item(3, 1), '', numbering), '', '1.1 is kept');
  assert.equal(await said(item(4), '', numbering), '', '(a) is kept');
  assert.match(await said(item(8), '', numbering), /list numbering Write has no format for/);
  assert.match(await said(item(10), '', numbering), /list numbering Write has no format for/);
});

test('paragraph tab stops, right indents, borders and shading are said', async () => {
  const text = await said(
    wp('Name\tPrice', '<w:tabs><w:tab w:val="right" w:pos="8000"/></w:tabs>')
    + wp('Narrow', '<w:ind w:left="0" w:right="1440"/>')
    + wp('Boxed', '<w:pBdr><w:top w:val="single" w:sz="4"/></w:pBdr>')
    + wp('Shaded', '<w:shd w:val="clear" w:color="auto" w:fill="DDEEFF"/>'),
  );
  assert.match(text, /tab stops set in paragraphs/);
  assert.match(text, /right indents/);
  assert.match(text, /lines and boxes round paragraphs/);
  assert.match(text, /shading behind whole paragraphs/);
});

test('hidden text, ALL CAPS, Small Caps and letter spacing are said; hidden text is not lost from view', async () => {
  const read = await readDocx(await wordFile(wp('Secret', '', '<w:vanish/>') + wp('Loud', '', '<w:caps/>') + wp('Wide', '', '<w:spacing w:val="40"/>')));
  const text = read.dropped.join('\n');
  assert.match(text, /hidden text \(it shows here, and is saved as ordinary text\)/);
  assert.match(text, /ALL CAPS and Small Caps/);
  assert.match(text, /letter spacing/);
  assert.equal(read.doc.content?.[0].content?.[0].text, 'Secret');
  assert.equal(await said(wp('Off', '', '<w:vanish w:val="0"/><w:caps w:val="false"/>')), '', 'switched off is not said');
});

test('table styles, set row heights and cells aligned to the middle are said; Table Grid is not', async () => {
  const styles = '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4"/></w:tblBorders></w:tblPr></w:style>'
    + '<w:style w:type="table" w:styleId="GridTable4-Accent1"><w:name w:val="Grid Table 4 Accent 1"/></w:style>';
  const table = (style: string, tr = '', tc = '') => `<w:tbl><w:tblPr><w:tblStyle w:val="${style}"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid><w:tr>${tr ? `<w:trPr>${tr}</w:trPr>` : ''}<w:tc>${tc ? `<w:tcPr>${tc}</w:tcPr>` : ''}${wp('Cell')}</w:tc></w:tr></w:tbl>`;
  assert.equal(await said(table('TableGrid'), styles), '');
  assert.match(await said(table('GridTable4-Accent1'), styles), /table styles/);
  assert.match(await said(table('TableGrid', '<w:trHeight w:val="800"/>'), styles), /set row heights in tables/);
  assert.match(await said(table('TableGrid', '', '<w:vAlign w:val="center"/>'), styles), /middle or bottom of table cells/);
});

test('a document Write saved itself (lists, a table, a contents page, a heading) says none of these on opening', async () => {
  const p = (text: string, attrs: Record<string, unknown> = {}): NodeJSON => ({ type: 'paragraph', attrs, content: [{ type: 'text', text }] });
  const doc: NodeJSON = {
    type: 'doc',
    content: [
      { type: 'toc', attrs: { title: 'Contents' } },
      p('Top', { style: 'h1' }),
      p('Third', { style: 'h3' }),
      { type: 'ordered_list', attrs: { order: 1 }, content: [{ type: 'list_item', content: [p('One'), { type: 'ordered_list', attrs: { order: 1 }, content: [{ type: 'list_item', content: [p('Under')] }] }] }] },
      { type: 'bullet_list', content: [{ type: 'list_item', content: [p('Dot')] }] },
      { type: 'table', attrs: { borders: true }, content: [{ type: 'table_row', content: [{ type: 'table_cell', attrs: { colspan: 1, rowspan: 1, colwidth: null, background: '#ddeeff' }, content: [p('Cell')] }] }] },
    ],
  };
  const read = await readDocx(await writeDocx(doc, defaultPage()));
  assert.deepEqual(read.dropped, []);
});

test('a list that uses a Word list style (numStyleLink) takes its levels from that style; one whose style is missing is said', async () => {
  const styles = '<w:style w:type="numbering" w:styleId="DotList"><w:name w:val="Dot List"/><w:pPr><w:numPr><w:numId w:val="2"/></w:numPr></w:pPr></w:style>';
  const numbering = '<w:abstractNum w:abstractNumId="0"><w:styleLink w:val="DotList"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum>'
    + '<w:abstractNum w:abstractNumId="1"><w:numStyleLink w:val="DotList"/></w:abstractNum>'
    + '<w:abstractNum w:abstractNumId="3"><w:numStyleLink w:val="GoneList"/></w:abstractNum>'
    + '<w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="4"><w:abstractNumId w:val="3"/></w:num>';
  const item = (id: number) => wp('Item', `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${id}"/></w:numPr>`);
  const read = await readDocx(await wordFile(item(1), styles, numbering));
  assert.equal(read.doc.content?.[0].type, 'bullet_list', 'the list style’s bullets, not 1.');
  assert.ok(!read.dropped.some(d => /list style/.test(d)), read.dropped.join('\n'));
  assert.match(await said(item(4), styles, numbering), /lists that use a list style Write could not find in the file \(“GoneList”\)/);
});

test('a heading numbered by its style (1, 1.1) is said; a plain heading is not', async () => {
  const styles = '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:numPr><w:numId w:val="6"/></w:numPr></w:pPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/></w:style>';
  const numbering = '<w:abstractNum w:abstractNumId="5"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1"/></w:lvl></w:abstractNum><w:num w:numId="6"><w:abstractNumId w:val="5"/></w:num>';
  assert.match(await said(wp('Scope', '<w:pStyle w:val="Heading1"/>'), styles, numbering), /numbered headings \(1, 1\.1 \.\.\.\): shown and saved without their numbers/);
  assert.equal(await said(wp('Plain', '<w:pStyle w:val="Heading2"/>'), styles, numbering), '');
});

test('a new file (a recovery copy, mail-merge letters) leaves out kept parts that point at the original file, keeping their label', async () => {
  const p = (text: string): NodeJSON => ({ type: 'paragraph', content: [{ type: 'text', text }] });
  const box = '<w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:blip r:embed="rId7"/></a:graphic></wp:inline></w:drawing></w:r>';
  const doc: NodeJSON = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'See ' }, { type: 'opaque_inline', attrs: { xml: box, label: 'Chart' } }] },
      { type: 'opaque_block', attrs: { xml: '<w:altChunk r:id="rId8"/>', label: 'Part brought in from another file' } },
      { type: 'opaque_block', attrs: { xml: '<w:p><w:r><w:t>Plain kept part</w:t></w:r></w:p>', label: 'Kept' } },
      p('End'),
    ],
  };
  const leftOut: string[] = [];
  const bytes = await writeDocx(doc, defaultPage(), '', undefined, { leftOut });
  const part = async (name: string) => new TextDecoder().decode(await readZip(bytes).find(e => e.parts.join('/') === name)!.read());
  const xml = await part('word/document.xml');
  const rels = await part('word/_rels/document.xml.rels');
  for (const [, id] of xml.matchAll(/\br:(?:id|embed|link)="([^"]*)"/g)) assert.ok(rels.includes(`Id="${id}"`), `${id} has a relationship`);
  assert.ok(!xml.includes('rId7') && !xml.includes('rId8'), 'no relationship the new file lacks');
  assert.match(xml, /\[Chart\]/);
  assert.match(xml, /\[Part brought in from another file\]/);
  assert.match(xml, /Plain kept part/, 'a kept part that points at nothing stays');
  assert.deepEqual(leftOut, ['Chart', 'Part brought in from another file']);
});

const FIELDS = /fields that update themselves/;
const CONTROLS = /content controls/;
const complexField = (code: string, shown: string) => '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>'
  + `<w:r><w:instrText xml:space="preserve">${code}</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>${shown}</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`;

test('a date, a cross-reference or a figure number becomes frozen words, and that is said; the words stay', async () => {
  const read = await readDocx(await wordFile(complexField(' DATE \\@ "d MMMM yyyy" ', '29 October 2026')));
  assert.match(read.dropped.join('\n'), FIELDS);
  assert.equal(plainText(read.doc), '29 October 2026');
  assert.match(await said('<w:p><w:fldSimple w:instr=" SEQ Figure \\* ARABIC "><w:r><w:t>3</w:t></w:r></w:fldSimple></w:p>'), FIELDS);
  assert.match(await said('<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> RE</w:instrText></w:r><w:r><w:instrText>F _Ref1 </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'), FIELDS, 'a code Word split over two runs');
  assert.match(await said(complexField(' FORMCHECKBOX ', '')), FIELDS, 'an older form tick box');
});

test('the fields Write does keep are not said: a mail merge field and a link', async () => {
  assert.doesNotMatch(await said(complexField(' MERGEFIELD Name ', '«Name»')), FIELDS);
  assert.doesNotMatch(await said('<w:p><w:fldSimple w:instr=" MERGEFIELD Name "><w:r><w:t>«Name»</w:t></w:r></w:fldSimple></w:p>'), FIELDS);
  assert.doesNotMatch(await said(complexField(' HYPERLINK "https://example.com/" ', 'our site')), FIELDS);
});

test('a content control (a tick box, a drop-down, a fill-in box) becomes plain words, and that is said; the words stay', async () => {
  const inline = '<w:p><w:sdt><w:sdtPr><w:dropDownList/></w:sdtPr><w:sdtContent><w:r><w:t>Choice</w:t></w:r></w:sdtContent></w:sdt></w:p>';
  const read = await readDocx(await wordFile(inline));
  assert.match(read.dropped.join('\n'), CONTROLS);
  assert.equal(plainText(read.doc), 'Choice');
  const block = await readDocx(await wordFile(`<w:sdt><w:sdtPr><w:text/></w:sdtPr><w:sdtContent>${wp('Filled in')}</w:sdtContent></w:sdt>`));
  assert.match(block.dropped.join('\n'), CONTROLS);
  assert.equal(plainText(block.doc), 'Filled in');
  const cell = `<w:tbl><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid><w:tr><w:sdt><w:sdtPr/><w:sdtContent><w:tc>${wp('In a cell')}</w:tc></w:sdtContent></w:sdt></w:tr></w:tbl>`;
  assert.match(await said(cell), CONTROLS, 'one round a table cell');
  const row = await readDocx(await wordFile(`<w:tbl><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid><w:sdt><w:sdtPr/><w:sdtContent><w:tr><w:tc>${wp('In a row')}</w:tc></w:tr></w:sdtContent></w:sdt></w:tbl>`));
  assert.match(row.dropped.join('\n'), CONTROLS, 'one round a whole table row');
  assert.equal(plainText(row.doc), 'In a row', 'and the row is still there');
  const toc = `<w:sdt><w:sdtPr><w:docPartObj><w:docPartGallery w:val="Table of Contents"/></w:docPartObj></w:sdtPr><w:sdtContent>${wp('Contents')}</w:sdtContent></w:sdt>`;
  assert.equal(await said(toc), '', 'a contents page is kept as one, so it is not said');
});

test('Save as .txt asks when anything but the words would go: footnotes, merge fields, grey kept parts, a contents page', () => {
  const para = (...content: NodeJSON[]): NodeJSON => ({ type: 'paragraph', attrs: { style: 'normal', align: null }, content });
  const words: NodeJSON = { type: 'text', text: 'Words' };
  const of = (...content: NodeJSON[]): NodeJSON => ({ type: 'doc', content });
  assert.equal(textLoses(of(para(words), para())), false, 'plain words lose nothing');
  assert.equal(textLoses(of(para(words, { type: 'hard_break' }, words))), false, 'a line break stays one in the text');
  assert.equal(textLoses(of(para(words, { type: 'footnote', attrs: { text: 'A note', id: 0 } }))), true, 'a footnote');
  assert.equal(textLoses(of(para({ type: 'field', attrs: { name: 'Name' } }))), true, 'a merge field');
  assert.equal(textLoses(of(para({ type: 'opaque_inline', attrs: { xml: '<w:r/>', label: 'Chart' } }))), true, 'a grey kept part in the text');
  assert.equal(textLoses(of({ type: 'opaque_block', attrs: { xml: '<w:p/>', label: 'Text box' } }, para(words))), true, 'a grey kept block');
  assert.equal(textLoses(of({ type: 'toc', attrs: { title: 'Contents' } }, para(words))), true, 'a contents page');
  assert.equal(textLoses(of(para(words), { type: 'page_break' }, para(words))), true, 'a page break');
  // As before: formatting, tables, pictures, lists and styles.
  assert.equal(textLoses(of(para({ type: 'text', text: 'Bold', marks: [{ type: 'strong' }] }))), true, 'bold');
  assert.equal(textLoses(of({ type: 'paragraph', attrs: { style: 'h1' }, content: [words] })), true, 'a heading');
  assert.equal(textLoses(of({ type: 'paragraph', attrs: { style: 'normal', align: 'center' }, content: [words] })), true, 'centred');
  assert.equal(textLoses(of({ type: 'bullet_list', content: [{ type: 'list_item', content: [para(words)] }] })), true, 'a list');
  assert.equal(textLoses(of(para({ type: 'image', attrs: { src: 'p1' } }))), true, 'a picture');
});
