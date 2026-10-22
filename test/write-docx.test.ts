// Write's Word files: a document written as .docx and read back is the same document (styles, spacing, every
// kind of text formatting, lists inside lists, numbered lists that start part-way, tables with merged and shaded cells,
// page breaks, pictures, the page setup and the header and footer); what is read always fits the editor's schema; a
// file made the way Word makes them (theme fonts, styles based on styles, lists that carry on counting, rows merged
// down, tracked changes) reads as Word shows it, and what Write cannot show is listed.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readZip } from '../src/apps/archive/read.ts';
import { zipDeflate } from '../src/core/zip.ts';
import { readDocx, writeDocx, DocxProblem } from '../src/apps/write/docx.ts';
import { picture, addPicture } from '../src/apps/write/images.ts';
import { defaultPage, plainText, countWords, docFromText, fillLine, type NodeJSON, type PageSetup } from '../src/apps/write/model.ts';
import { buildSchema } from '../src/apps/write/schema.ts';

// A 1 x 1 pixel PNG.
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));

const p = (text: string, attrs: Record<string, unknown> = {}, marks?: NodeJSON['marks']): NodeJSON =>
  ({ type: 'paragraph', attrs: { style: 'normal', ...attrs }, content: text ? [marks ? { type: 'text', text, marks } : { type: 'text', text }] : undefined });
const cell = (text: string, attrs: Record<string, unknown> = {}): NodeJSON =>
  ({ type: 'table_cell', attrs: { colspan: 1, rowspan: 1, colwidth: null, background: null, ...attrs }, content: [p(text)] });

/** The document with empty parts and default values taken out, and pictures as their bytes' length, to compare. */
function norm(n: NodeJSON): unknown {
  const attrs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(n.attrs ?? {})) {
    if (v === null || v === undefined) continue;
    if (k === 'style' && v === 'normal') continue;
    if (k === 'src') attrs.bytes = picture(String(v))?.bytes.length;
    else attrs[k] = v;
  }
  const out: Record<string, unknown> = { type: n.type };
  if (Object.keys(attrs).length) out.attrs = attrs;
  if (n.text !== undefined) out.text = n.text;
  if (n.marks?.length) out.marks = [...n.marks].map(m => JSON.stringify(m)).sort();
  if (n.content?.length) out.content = n.content.map(norm);
  return out;
}

const rich = (): { doc: NodeJSON; page: PageSetup } => {
  const pic = addPicture(PNG)!;
  const doc: NodeJSON = {
    type: 'doc',
    content: [
      p('A title', { style: 'title' }),
      p('Heading one', { style: 'h1' }),
      { type: 'paragraph', attrs: { style: 'normal', align: 'justify', before: 6, after: 12, line: 1.5, indent: 36, first: -18 }, content: [
        { type: 'text', text: 'Bold ', marks: [{ type: 'strong' }] },
        { type: 'text', text: 'italic ', marks: [{ type: 'em' }] },
        { type: 'text', text: 'under ', marks: [{ type: 'underline' }] },
        { type: 'text', text: 'struck ', marks: [{ type: 'strike' }] },
        { type: 'text', text: 'x2', marks: [{ type: 'vert', attrs: { pos: 'super' } }] },
        { type: 'text', text: 'H2O', marks: [{ type: 'vert', attrs: { pos: 'sub' } }] },
        { type: 'text', text: ' Georgia 14 red on yellow', marks: [{ type: 'font', attrs: { face: 'Georgia' } }, { type: 'size', attrs: { pt: 14 } }, { type: 'color', attrs: { value: '#c00000' } }, { type: 'highlight', attrs: { value: '#ffff00' } }] },
        { type: 'text', text: ' pale blue shade', marks: [{ type: 'highlight', attrs: { value: '#ddeeff' } }] },
        { type: 'hard_break' },
        { type: 'text', text: 'after a\tline break & <tags>' },
      ] },
      p('Centred', { align: 'center' }),
      { type: 'ordered_list', attrs: { order: 3 }, content: [
        { type: 'list_item', content: [p('Third'), p('Second paragraph of the third')] },
        { type: 'list_item', content: [p('Fourth'), { type: 'bullet_list', content: [
          { type: 'list_item', content: [p('Dot one')] },
          { type: 'list_item', content: [p('Dot two'), { type: 'ordered_list', attrs: { order: 1 }, content: [{ type: 'list_item', content: [p('Deep one')] }] }] },
        ] }] },
      ] },
      { type: 'bullet_list', content: [{ type: 'list_item', content: [p('A bullet after')] }] },
      { type: 'page_break' },
      { type: 'table', attrs: { borders: true }, content: [
        { type: 'table_row', content: [cell('Wide', { colspan: 2, colwidth: [120, 80] }), cell('Tall', { rowspan: 2, background: '#e2efda', colwidth: [100] })] },
        { type: 'table_row', content: [cell('A', { colwidth: [120] }), cell('B', { colwidth: [80] })] },
      ] },
      { type: 'table', attrs: { borders: false }, content: [{ type: 'table_row', content: [cell('No lines', { colwidth: [420] }), cell('', { colwidth: [420] })] }] },
      { type: 'paragraph', attrs: { style: 'normal', align: 'right' }, content: [{ type: 'image', attrs: { src: pic, width: 200, height: 100, alt: 'A dot' } }] },
      p(''),
    ],
  };
  const page: PageSetup = { ...defaultPage('en-US'), orient: 'landscape', margins: { t: 0.5, b: 0.75, l: 1.25, r: 1, header: 0.3, footer: 0.4 }, header: { l: 'Report', c: '', r: 'Page &P of &N' }, footer: { l: '', c: 'Smith && Sons', r: '' } };
  return { doc, page };
};

test('a document written as .docx reads back the same', async () => {
  const { doc, page } = rich();
  const bytes = await writeDocx(doc, page, 'My report');
  const back = await readDocx(bytes);
  assert.deepEqual(norm(back.doc), norm(doc));
  assert.deepEqual(back.page, page);
  assert.deepEqual(back.dropped, []);
});

test('what is read fits the editor (the schema checks every node)', async () => {
  const pm = await import('../public/vendor/prosemirror.js' as string);
  const schema = buildSchema(pm);
  const { doc, page } = rich();
  const back = await readDocx(await writeDocx(doc, page));
  const node = schema.nodeFromJSON(back.doc);
  node.check();
  assert.equal(node.textContent.includes('Deep one'), true);
});

test('the parts a .docx needs are there, and Word-only rules hold', async () => {
  const { doc, page } = rich();
  const files = new Map(readZip(await writeDocx(doc, page)).map(e => [e.parts.join('/'), e]));
  for (const part of ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/_rels/document.xml.rels', 'word/styles.xml', 'word/numbering.xml', 'word/header1.xml', 'word/footer1.xml', 'word/media/image1.png']) {
    assert.ok(files.has(part), part);
  }
  const xml = new TextDecoder().decode(await files.get('word/document.xml')!.read());
  // Every table cell ends with a paragraph; the merged cell continues in the row below; text is escaped.
  assert.equal((xml.match(/<w:tc>/g) ?? []).length, (xml.match(/<\/w:p><\/w:tc>|<w:p\/><\/w:tc>/g) ?? []).length);
  assert.match(xml, /<w:vMerge w:val="restart"\/>/);
  assert.match(xml, /<w:vMerge\/>/);
  assert.match(xml, /&amp; &lt;tags&gt;/);
  assert.match(xml, /<w:highlight w:val="yellow"\/>/);
  assert.match(xml, /<w:shd w:val="clear" w:color="auto" w:fill="DDEEFF"\/>/);
  const header = new TextDecoder().decode(await files.get('word/header1.xml')!.read());
  assert.match(header, /PAGE/);
  assert.match(header, /NUMPAGES/);
});

test('an empty document and a .txt file', async () => {
  const back = await readDocx(await writeDocx({ type: 'doc', content: [{ type: 'paragraph' }] }, defaultPage('en-GB')));
  assert.deepEqual(norm(back.doc), { type: 'doc', content: [{ type: 'paragraph' }] });
  assert.equal(back.page.paper, 'a4');
  const t = docFromText('one two\r\n\r\nthree\u0007');
  assert.equal(plainText(t), 'one two\n\nthree');
  assert.equal(countWords(plainText(t)), 3);
  assert.equal(countWords('— 12 apples, and… !'), 3);
  assert.equal(fillLine('Page &P of &N && more', 2, 9), 'Page 2 of 9 & more');
});

test('not a Word document: says why', async () => {
  await assert.rejects(readDocx(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2, 3])), (e: unknown) => e instanceof DocxProblem && /older Word file/.test(e.message));
  await assert.rejects(readDocx(new TextEncoder().encode('hello')), (e: unknown) => e instanceof DocxProblem);
  const noDoc = await zipDeflate([{ name: 'word/other.xml', data: new TextEncoder().encode('<x/>'), modified: 0 }]);
  await assert.rejects(readDocx(noDoc), (e: unknown) => e instanceof DocxProblem && /main document/.test(e.message));
});

/** A small .docx put together the way Word writes one. */
async function wordFile(body: string, extra: { styles?: string; numbering?: string; theme?: string } = {}): Promise<Uint8Array> {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const enc = new TextEncoder();
  const rels = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>'
    + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/></Relationships>';
  return zipDeflate([
    { name: '_rels/.rels', data: enc.encode('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="/word/document.xml"/></Relationships>'), modified: 0 },
    { name: 'word/document.xml', data: enc.encode(`<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`), modified: 0 },
    { name: 'word/_rels/document.xml.rels', data: enc.encode(rels), modified: 0 },
    { name: 'word/styles.xml', data: enc.encode(`<?xml version="1.0"?><w:styles ${W}>${extra.styles ?? ''}</w:styles>`), modified: 0 },
    { name: 'word/numbering.xml', data: enc.encode(`<?xml version="1.0"?><w:numbering ${W}>${extra.numbering ?? ''}</w:numbering>`), modified: 0 },
    { name: 'word/theme/theme1.xml', data: enc.encode(`<?xml version="1.0"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:fontScheme><a:majorFont><a:latin typeface="Aptos Display"/></a:majorFont><a:minorFont><a:latin typeface="${extra.theme ?? 'Calibri'}"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`), modified: 0 },
  ]);
}

const STYLES_XML = '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
  + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="240" w:after="0"/></w:pPr><w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi"/><w:color w:val="2F5496"/><w:sz w:val="32"/></w:rPr></w:style>'
  + '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:rPr><w:i/></w:rPr></w:style>'
  + '<w:style w:type="character" w:styleId="Strong"><w:name w:val="Strong"/><w:rPr><w:b/></w:rPr></w:style>'
  + '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4"/></w:tblBorders></w:tblPr></w:style>';

const NUMBERING_XML = '<w:abstractNum w:abstractNumId="7"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>'
  + '<w:num w:numId="5"><w:abstractNumId w:val="7"/></w:num>';

const wp = (text: string, ppr = '', rpr = '') => `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const li = (text: string, lvl = 0) => wp(text, `<w:numPr><w:ilvl w:val="${lvl}"/><w:numId w:val="5"/></w:numPr>`);

test('a file the way Word writes it reads as Word shows it', async () => {
  const body = wp('Theme heading', '<w:pStyle w:val="Heading1"/>')
    + wp('In the theme font, a character style, and a quote', '<w:pStyle w:val="Quote"/>', '<w:rStyle w:val="Strong"/>')
    + li('One') + li('Under one, a bullet', 1) + li('Two')
    + wp('Between the list')
    + li('Three (carries on)')
    + '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr><w:tblGrid><w:gridCol w:w="1500"/><w:gridCol w:w="3000"/></w:tblGrid>'
    + '<w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr>' + wp('Merged down') + '</w:tc><w:tc>' + wp('Right 1') + '</w:tc></w:tr>'
    + '<w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p/></w:tc><w:tc>' + wp('Right 2') + '</w:tc></w:tr></w:tbl>'
    + '<w:p><w:ins w:id="1" w:author="x"><w:r><w:t>Inserted</w:t></w:r></w:ins><w:del w:id="2" w:author="x"><w:r><w:delText>Deleted</w:delText></w:r></w:del></w:p>'
    + '<w:p><w:r><w:t>Before</w:t></w:r><w:r><w:br w:type="page"/></w:r><w:r><w:t>After</w:t></w:r></w:p>'
    + '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>PAGE</w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>7</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
    + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708"/></w:sectPr>';
  const read = await readDocx(await wordFile(body, { styles: STYLES_XML, numbering: NUMBERING_XML }));
  const blocks = read.doc.content!;
  // Heading 1 in the theme's heading font (Aptos Display), not our Calibri Light.
  assert.equal(blocks[0].attrs?.style, 'h1');
  assert.deepEqual(blocks[0].content?.[0].marks?.find(m => m.type === 'font')?.attrs, { face: 'Aptos Display' });
  assert.equal(blocks[0].attrs?.before, undefined, 'Word’s 12 pt before matches ours');
  // The Quote style is italic; the Strong character style is bold.
  const marks = (blocks[1].content?.[0].marks ?? []).map(m => m.type).sort();
  assert.deepEqual(marks, ['em', 'strong']);
  // The list: One, (bullet inside), Two; then a paragraph; then the same list carries on at 3.
  assert.equal(blocks[2].type, 'ordered_list');
  assert.equal(blocks[2].content?.length, 2);
  assert.equal(blocks[2].content?.[0].content?.[1].type, 'bullet_list');
  assert.equal(blocks[3].type, 'paragraph');
  assert.equal(blocks[4].type, 'ordered_list');
  assert.equal(blocks[4].attrs?.order, 3);
  // The table: the first cell spans two rows; the row below has one cell of its own.
  const table = blocks[5];
  assert.equal(table.attrs?.borders, true);
  assert.equal(table.content?.[0].content?.[0].attrs?.rowspan, 2);
  assert.deepEqual(table.content?.[0].content?.[0].attrs?.colwidth, [100]);
  assert.equal(table.content?.[1].content?.length, 1);
  // Tracked changes show accepted; the page break splits its paragraph; a field shows its result.
  assert.equal(plainText({ type: 'doc', content: [blocks[6]] }), 'Inserted');
  assert.deepEqual(blocks.slice(7, 10).map(b => b.type), ['paragraph', 'page_break', 'paragraph']);
  assert.equal(plainText({ type: 'doc', content: [blocks[10]] }), '7');
  assert.ok(read.dropped.some(d => /tracked changes/.test(d)));
  assert.equal(read.page.paper, 'a4');
  const pm = await import('../public/vendor/prosemirror.js' as string);
  buildSchema(pm).nodeFromJSON(read.doc).check();
});

test('a text box, a comment, a footnote: kept (as grey labels) and listed, never lost silently', async () => {
  const body = '<w:p><w:r><w:drawing><wp:anchor xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wps:txbx xmlns:wps="x"/></wp:anchor></w:drawing></w:r><w:r><w:commentReference w:id="1"/></w:r><w:r><w:footnoteReference w:id="2"/></w:r></w:p>';
  const read = await readDocx(await wordFile(body));
  assert.ok(read.kept.includes('text boxes'));
  assert.ok(read.kept.includes('comments'));
  assert.ok(read.kept.includes('footnotes and endnotes'));
});
