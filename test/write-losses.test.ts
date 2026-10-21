// TOMLIN Write tells what it cannot keep from a Word file, so "Save over?" asks before any of it is lost: links,
// Heading 4 to 9, the document's own paragraph styles, other list numbering, tab stops, right indents, paragraph
// borders and shading, hidden text, capitals and letter spacing set as formatting, table styles, row heights and
// cell alignment. A file Write saved itself says none of them. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipDeflate } from '../src/core/zip.ts';
import { readDocx, writeDocx } from '../src/apps/write/docx.ts';
import { defaultPage, type NodeJSON } from '../src/apps/write/model.ts';

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

test('a link keeps its words and says its address is not kept, as a link or as a HYPERLINK field', async () => {
  const read = await readDocx(await wordFile('<w:p><w:hyperlink r:id="rId9"><w:r><w:t>our site</w:t></w:r></w:hyperlink></w:p>'));
  assert.match(read.dropped.join('\n'), /links \(the words stay; where they lead is not kept\)/);
  assert.equal(read.doc.content?.[0].content?.[0].text, 'our site');
  const field = '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> HYPERLINK "https://example.com/" </w:instrText></w:r>'
    + '<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>there</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>';
  assert.match(await said(field), /links \(the words stay/);
});

test('Heading 4 to 9 and the document’s own styles are said, by name', async () => {
  const styles = '<w:style w:type="paragraph" w:styleId="Heading5"><w:name w:val="heading 5"/><w:basedOn w:val="Normal"/></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:rPr><w:i/></w:rPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/></w:style>';
  const text = await said(wp('Deep', '<w:pStyle w:val="Heading5"/>') + wp('Said', '<w:pStyle w:val="Quote"/>') + wp('In a list', '<w:pStyle w:val="ListParagraph"/>'), styles);
  assert.match(text, /Heading 4 to Heading 9 \(they show and are saved as Heading 3\)/);
  assert.match(text, /own paragraph styles \(“Quote”\): their look stays, but they are saved as Normal/);
  assert.doesNotMatch(text, /List Paragraph/);
});

test('a style only defined, never used in the text, is not said', async () => {
  const styles = '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/></w:style>';
  assert.equal(await said(wp('Plain'), styles), '');
});

test('list numbering Write does not write (1.1, (a), none) is said; its own 1. a. i. and bullets are not', async () => {
  const lvl = (i: number, fmt: string, text: string) => `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/></w:lvl>`;
  const numbering = `<w:abstractNum w:abstractNumId="1">${lvl(0, 'decimal', '%1.')}${lvl(1, 'decimal', '%1.%2.')}</w:abstractNum><w:num w:numId="3"><w:abstractNumId w:val="1"/></w:num>`
    + `<w:abstractNum w:abstractNumId="2">${lvl(0, 'lowerLetter', '(%1)')}</w:abstractNum><w:num w:numId="4"><w:abstractNumId w:val="2"/></w:num>`
    + `<w:abstractNum w:abstractNumId="5">${lvl(0, 'bullet', '')}${lvl(1, 'lowerLetter', '%2.')}</w:abstractNum><w:num w:numId="6"><w:abstractNumId w:val="5"/></w:num>`;
  const item = (id: number, lvlNo = 0) => wp('Item', `<w:numPr><w:ilvl w:val="${lvlNo}"/><w:numId w:val="${id}"/></w:numPr>`);
  assert.equal(await said(item(3) + item(6) + item(6, 1), '', numbering), '', 'decimal 1., a bullet and a. under it are what Write writes');
  assert.match(await said(item(3) + item(3, 1), '', numbering), /list numbering in other styles/);
  assert.match(await said(item(4), '', numbering), /list numbering in other styles/);
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
