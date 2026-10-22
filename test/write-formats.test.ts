// Write's other files and Word files from elsewhere: a Word file with a text box, a comment, a footnote, its own
// theme and styles is saved back with every part it had (the text box and the references exactly as written, the
// footnotes and comments parts untouched, its namespaces kept) and opens again the same; a WordPad .rtf (bold, colour,
// a font, bullets, numbers, a table, a picture, accented letters); a LibreOffice .odt (styles, headings, lists,
// a table, the page); Markdown both ways; find and replace.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readZip } from '../src/apps/archive/read.ts';
import { parseXml } from '../src/core/xml.ts';
import { zipDeflate } from '../src/core/zip.ts';
import { readDocx, writeDocx } from '../src/apps/write/docx.ts';
import { findAll, replaceAll } from '../src/apps/write/find.ts';
import { markdownLoses, readMarkdown, writeMarkdown } from '../src/apps/write/markdown.ts';
import { plainText, type NodeJSON } from '../src/apps/write/model.ts';
import { readOdt } from '../src/apps/write/odt.ts';
import { readRtf, RtfProblem } from '../src/apps/write/rtf.ts';
import { buildSchema } from '../src/apps/write/schema.ts';

const enc = new TextEncoder();
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" mc:Ignorable="w14"';
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
const schemaP = import('../public/vendor/prosemirror.js' as string).then(pm => ({ pm, schema: buildSchema(pm) }));
const files = async (bytes: Uint8Array) => new Map(await Promise.all(readZip(bytes).filter(e => !e.folder).map(async e => [e.parts.join('/'), await e.read()] as const)));
const text = (b: Uint8Array | undefined) => new TextDecoder().decode(b);

const TEXTBOX = '<mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wps:wsp><wps:txbx><w:txbxContent><w:p><w:r><w:t>Inside the box</w:t></w:r></w:p></w:txbxContent></wps:txbx></wps:wsp></wp:anchor></w:drawing></mc:Choice><mc:Fallback><w:pict/></mc:Fallback></mc:AlternateContent>';

async function wordFile(): Promise<Uint8Array> {
  const body = '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Report</w:t></w:r></w:p>'
    + `<w:p><w:r><w:t xml:space="preserve">Before the box </w:t></w:r><w:r><w:rPr><w:b/></w:rPr>${TEXTBOX}</w:r><w:r><w:t xml:space="preserve"> after.</w:t></w:r></w:p>`
    + '<w:p><w:commentRangeStart w:id="0"/><w:r><w:t>Noted</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r><w:r><w:t xml:space="preserve"> and a note</w:t></w:r><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="1"/></w:r></w:p>'
    + '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr></w:pPr><w:r><w:t>Their list</w:t></w:r></w:p>'
    + '<w:sectPr><w:headerReference w:type="default" r:id="rId9"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/><w:cols w:space="708"/><w:docGrid w:linePitch="360"/></w:sectPr>';
  const rels = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>'
    + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>'
    + '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>'
    + '<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/>'
    + '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/></Relationships>';
  return zipDeflate([
    { name: '[Content_Types].xml', data: enc.encode('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'), modified: 0 },
    { name: '_rels/.rels', data: enc.encode('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'), modified: 0 },
    { name: 'word/document.xml', data: enc.encode(`<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`), modified: 0 },
    { name: 'word/_rels/document.xml.rels', data: enc.encode(rels), modified: 0 },
    { name: 'word/styles.xml', data: enc.encode(`<?xml version="1.0"?><w:styles ${W}><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:sz w:val="22"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:sz w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/></w:style></w:styles>`), modified: 0 },
    { name: 'word/numbering.xml', data: enc.encode(`<?xml version="1.0"?><w:numbering ${W}><w:abstractNum w:abstractNumId="4"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:num w:numId="3"><w:abstractNumId w:val="4"/></w:num></w:numbering>`), modified: 0 },
    { name: 'word/theme/theme1.xml', data: enc.encode('<?xml version="1.0"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Their theme"><a:themeElements><a:fontScheme><a:majorFont><a:latin typeface="Calibri Light"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>'), modified: 0 },
    { name: 'word/comments.xml', data: enc.encode(`<?xml version="1.0"?><w:comments ${W}><w:comment w:id="0" w:author="Ann"><w:p><w:r><w:t>Check this</w:t></w:r></w:p></w:comment></w:comments>`), modified: 0 },
    { name: 'word/footnotes.xml', data: enc.encode(`<?xml version="1.0"?><w:footnotes ${W}><w:footnote w:id="1"><w:p><w:r><w:t>The note</w:t></w:r></w:p></w:footnote></w:footnotes>`), modified: 0 },
    { name: 'word/header1.xml', data: enc.encode(`<?xml version="1.0"?><w:hdr ${W}><w:p><w:pPr><w:jc w:val="right"/></w:pPr><w:r><w:t>Their header</w:t></w:r></w:p></w:hdr>`), modified: 0 },
  ]);
}

test('a Word file from elsewhere keeps every part through a save: text box, comment, footnote, theme, header', async () => {
  const original = await wordFile();
  const read = await readDocx(original);
  const { schema } = await schemaP;
  schema.nodeFromJSON(read.doc).check();
  assert.ok(read.kept.includes('text boxes') && read.kept.includes('comments'), read.kept.join(', '));
  const labels: string[] = [];
  const notes: unknown[] = [];
  const walk = (n: NodeJSON) => {
    if (n.type === 'opaque_inline') labels.push(String(n.attrs?.label));
    if (n.type === 'footnote') notes.push(n.attrs);
    n.content?.forEach(walk);
  };
  walk(read.doc);
  assert.deepEqual(labels, ['Text box: Inside the box', 'Comment']);
  // The footnote reads as a footnote, with its words; unchanged, it points at its own note again.
  assert.deepEqual(notes, [{ text: 'The note', id: 1 }]);
  assert.deepEqual(read.page.header, { l: '', c: '', r: 'Their header' });
  // An edit in Write: a new paragraph at the end.
  read.doc.content!.push({ type: 'paragraph', attrs: { style: 'normal' }, content: [{ type: 'text', text: 'Added in Write' }] });
  const saved = await writeDocx(read.doc, read.page, '', read.source);
  const before = await files(original);
  const after = await files(saved);
  for (const part of ['word/theme/theme1.xml', 'word/comments.xml', 'word/footnotes.xml', 'word/header1.xml']) assert.deepEqual(after.get(part), before.get(part), `${part} unchanged`);
  for (const [name, data] of after) if (name.endsWith('.xml') || name.endsWith('.rels')) parseXml(text(data));
  const doc = text(after.get('word/document.xml'));
  assert.ok(doc.includes(TEXTBOX), 'the text box exactly as written');
  assert.ok(doc.includes('<w:commentReference w:id="0"/>') && doc.includes('<w:footnoteReference w:id="1"/>'), 'references kept');
  assert.ok(doc.includes('mc:Ignorable="w14"') && doc.includes('xmlns:wps='), 'its own namespaces kept');
  assert.ok(doc.includes('<w:headerReference w:type="default" r:id="rId9"/>'), 'its header kept (not changed in Write)');
  assert.ok(doc.includes('Added in Write'));
  // Its list definitions stay; Write's own come after them with ids of their own.
  const numbering = text(after.get('word/numbering.xml'));
  assert.ok(numbering.includes('w:abstractNumId="4"') && numbering.includes('w:abstractNumId="5"') && numbering.includes('w:numId="4"'));
  assert.ok(doc.includes('<w:numId w:val="4"/>'), 'the list uses Write’s new numbering');
  // Write's styles replace those of the same ids; the file's other styles stay.
  const styles = text(after.get('word/styles.xml'));
  assert.equal((styles.match(/w:styleId="Normal"/g) ?? []).length, 1);
  assert.ok(styles.includes('w:styleId="Quote"'));
  // And it opens again the same.
  const again = await readDocx(saved);
  const labels2: string[] = [];
  const walk2 = (n: NodeJSON) => {
    if (n.type === 'opaque_inline') labels2.push(String(n.attrs?.label));
    n.content?.forEach(walk2);
  };
  walk2(again.doc);
  assert.deepEqual(labels2, labels);
  assert.ok(plainText(again.doc).includes('Added in Write'));
});

test('a header changed in Write replaces the file’s own; paper and margins follow Write', async () => {
  const read = await readDocx(await wordFile());
  const page = { ...read.page, orient: 'landscape' as const, header: { l: 'New', c: '', r: '&P' } };
  const after = await files(await writeDocx(read.doc, page, '', read.source));
  const doc = text(after.get('word/document.xml'));
  assert.ok(!doc.includes('r:id="rId9"') && doc.includes('r:id="rIdTwheader"'));
  assert.ok(/<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"\/>/.test(doc));
  assert.equal((doc.match(/<w:pgSz/g) ?? []).length, 1);
  assert.ok(/<w:pgMar[^>]*\/><w:cols/.test(doc), 'page settings before the columns, as Word requires');
  assert.ok(text(after.get('word/tw-header1.xml')).includes('PAGE'));
  assert.ok(text(after.get('[Content_Types].xml')).includes('/word/tw-header1.xml'));
});

test('a WordPad file: bold, colour, a font, bullets, numbers, a table, a picture, accents and Unicode', async () => {
  const hex = [...PNG].map(b => b.toString(16).padStart(2, '0')).join('');
  const rtf = '{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\fnil\\fcharset0 Calibri;}{\\f1\\fnil\\fcharset2 Symbol;}{\\f2\\froman Georgia;}}'
    + '{\\colortbl ;\\red255\\green0\\blue0;}{\\*\\generator Riched20}\\viewkind4\\uc1\\pard\\sa200\\sl276\\slmult1\\f0\\fs22 Plain \\b bold\\b0  \\cf1 red\\cf0  \\f2 Georgia\\f0  caf\\\'e9 \\u8364? end\\par'
    + '\\pard{\\pntext\\f1\\\'B7\\tab}{\\*\\pn\\pnlvlblt\\pnf1\\pnindent0{\\pntxtb\\\'B7}}\\fi-360\\li720 First\\par{\\pntext\\f1\\\'B7\\tab}Second\\par'
    + '\\pard{\\pntext\\f0 1.\\tab}{\\*\\pn\\pnlvlbody\\pnf0\\pnindent0\\pnstart1\\pndec{\\pntxta.}}\\fi-360\\li720 One\\par'
    + '\\pard\\qc Centred\\line next\\par'
    + '\\trowd\\cellx2000\\cellx4000\\pard\\intbl A\\cell B\\cell\\row\\pard After table\\par'
    + `{\\pict\\pngblip\\picwgoal1500\\pichgoal1500 ${hex}}\\par`
    + '{\\header Header text}{\\*\\unknown skipped}}';
  const read = readRtf(enc.encode(rtf));
  const blocks = read.doc.content!;
  const { schema } = await schemaP;
  schema.nodeFromJSON(read.doc).check();
  const first = blocks[0];
  assert.equal(plainText({ type: 'doc', content: [first] }), 'Plain bold red Georgia café € end');
  assert.ok(first.content!.some(n => n.text === 'bold' && n.marks?.some(m => m.type === 'strong')));
  assert.ok(first.content!.some(n => n.text === 'red' && n.marks?.some(m => m.type === 'color' && m.attrs?.value === '#ff0000')));
  assert.ok(first.content!.some(n => n.text === 'Georgia' && n.marks?.some(m => m.type === 'font' && m.attrs?.face === 'Georgia')));
  assert.equal(blocks[1].type, 'bullet_list');
  assert.equal(blocks[1].content!.length, 2);
  assert.equal(blocks[2].type, 'ordered_list');
  assert.equal(blocks[3].attrs?.align, 'center');
  assert.ok(blocks[3].content!.some(n => n.type === 'hard_break'));
  assert.equal(blocks[4].type, 'table');
  assert.deepEqual(blocks[4].content![0].content!.map(c => plainText({ type: 'doc', content: c.content })), ['A', 'B']);
  assert.equal(plainText({ type: 'doc', content: [blocks[5]] }), 'After table');
  const pic = blocks[6].content!.find(n => n.type === 'image');
  assert.equal(pic?.attrs?.width, 100, '1500 twips is 100 pixels');
  assert.ok(read.dropped.includes('headers and footers'));
  assert.ok(!plainText(read.doc).includes('skipped') && !plainText(read.doc).includes('Riched20'));
  assert.throws(() => readRtf(enc.encode('hello')), RtfProblem);
});

test('a LibreOffice file: styles, a heading, the Title, nested lists, a table with a joined cell, the page', async () => {
  const NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"';
  const content = `<?xml version="1.0"?><office:document-content ${NS}><office:automatic-styles>`
    + '<style:style style:name="P1" style:family="paragraph"><style:paragraph-properties fo:text-align="center"/></style:style>'
    + '<style:style style:name="T1" style:family="text"><style:text-properties fo:font-weight="bold" fo:color="#c00000"/></style:style>'
    + '<style:style style:name="C1" style:family="table-cell"><style:table-cell-properties fo:background-color="#e2efda"/></style:style>'
    + '<text:list-style style:name="L1"><text:list-level-style-number text:level="1"/><text:list-level-style-bullet text:level="2"/></text:list-style>'
    + '</office:automatic-styles><office:body><office:text>'
    + '<text:p text:style-name="Title">Annual &amp; plan</text:p><text:h text:outline-level="2">Part two</text:h>'
    + '<text:p text:style-name="P1">Hello <text:span text:style-name="T1">red bold</text:span><text:s text:c="2"/>end<text:tab/>x</text:p>'
    + '<text:list text:style-name="L1"><text:list-item><text:p>One</text:p><text:list><text:list-item><text:p>Dot</text:p></text:list-item></text:list></text:list-item><text:list-item><text:p>Two</text:p></text:list-item></text:list>'
    + '<table:table><table:table-column table:number-columns-repeated="2"/><table:table-row><table:table-cell table:number-columns-spanned="2" table:style-name="C1"><text:p>Wide</text:p></table:table-cell><table:covered-table-cell/></table:table-row>'
    + '<table:table-row><table:table-cell><text:p>a</text:p></table:table-cell><table:table-cell><text:p>b</text:p></table:table-cell></table:table-row></table:table>'
    + '</office:text></office:body></office:document-content>';
  const styles = `<?xml version="1.0"?><office:document-styles ${NS}><office:styles><style:default-style style:family="paragraph"><style:text-properties fo:font-size="11pt" style:font-name="Calibri"/></style:default-style>`
    + '<style:style style:name="Title" style:family="paragraph" style:display-name="Title"/></office:styles>'
    + '<office:automatic-styles><style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="29.7cm" fo:page-height="21cm" fo:margin-top="2cm" fo:margin-bottom="2cm" fo:margin-left="2.54cm" fo:margin-right="2.54cm"/></style:page-layout></office:automatic-styles>'
    + '<office:master-styles><style:master-page style:name="Standard" style:page-layout-name="pm1"><style:footer><text:p>Page <text:page-number>1</text:page-number></text:p></style:footer></style:master-page></office:master-styles></office:document-styles>';
  const read = await readOdt(await zipDeflate([
    { name: 'mimetype', data: enc.encode('application/vnd.oasis.opendocument.text'), modified: 0 },
    { name: 'content.xml', data: enc.encode(content), modified: 0 },
    { name: 'styles.xml', data: enc.encode(styles), modified: 0 },
  ]));
  const { schema } = await schemaP;
  schema.nodeFromJSON(read.doc).check();
  const b = read.doc.content!;
  assert.equal(b[0].attrs?.style, 'title');
  assert.equal(plainText({ type: 'doc', content: [b[0]] }), 'Annual & plan');
  assert.equal(b[1].attrs?.style, 'h2');
  assert.equal(b[2].attrs?.align, 'center');
  assert.equal(plainText({ type: 'doc', content: [b[2]] }), 'Hello red bold  end\tx');
  assert.ok(b[2].content!.some(n => n.text === 'red bold' && n.marks?.some(m => m.type === 'strong') && n.marks?.some(m => m.type === 'color')));
  assert.equal(b[3].type, 'ordered_list');
  assert.equal(b[3].content![0].content![1].type, 'bullet_list');
  assert.equal(b[4].type, 'table');
  assert.equal(b[4].content![0].content![0].attrs?.colspan, 2);
  assert.equal(b[4].content![0].content![0].attrs?.background, '#e2efda');
  assert.equal(read.page.paper, 'a4');
  assert.equal(read.page.orient, 'landscape');
  assert.deepEqual(read.page.footer, { l: '', c: 'Page &P', r: '' });
});

test('Markdown both ways: headings, bold, italic, code, lists in lists, numbered from 3, tables, quotes', async () => {
  const md = '# Plan\n\nSome **bold**, *italic*, ~~old~~ and `code` with a [link](https://example.invalid) and snake_case.\n'
    + 'Same paragraph.\n\n3. Third\n4. Fourth\n   - inside\n\n| Name | Qty |\n| --- | --- |\n| Apples | 4 |\n\n> A quote\n\n```\nfn()\n```\n';
  const doc = readMarkdown(md);
  const { schema } = await schemaP;
  schema.nodeFromJSON(doc).check();
  const b = doc.content!;
  assert.equal(b[0].attrs?.style, 'h1');
  assert.equal(plainText({ type: 'doc', content: [b[1]] }), 'Some bold, italic, old and code with a link and snake_case. Same paragraph.');
  assert.equal(b[2].type, 'ordered_list');
  assert.equal(b[2].attrs?.order, 3);
  assert.equal(b[2].content![1].content![1].type, 'bullet_list');
  assert.equal(b[3].type, 'table');
  const out = writeMarkdown(doc);
  assert.ok(out.startsWith('# Plan\n\nSome **bold**, *italic*, ~~old~~ and `code` with a [link](https://example.invalid) and snake\\_case. Same paragraph.'), out);
  assert.ok(out.includes('3. Third\n4. Fourth\n   - inside'), out);
  assert.ok(out.includes('| Name | Qty |\n| --- | --- |\n| Apples | 4 |'), out);
  // Read back, it is the same document.
  assert.deepEqual(JSON.stringify(readMarkdown(out).content!.slice(0, 4)), JSON.stringify(doc.content!.slice(0, 4)).replace('with a link', 'with a link'));
  assert.deepEqual(markdownLoses(doc), []);
  assert.deepEqual(markdownLoses({ type: 'doc', content: [{ type: 'paragraph', attrs: { align: 'center' }, content: [{ type: 'text', text: 'x', marks: [{ type: 'color', attrs: { value: '#ff0000' } }] }] }] }).length, 2);
});

test('a hostile Markdown file (very long lines of spaces, dashes and stars) opens quickly', () => {
  const started = Date.now();
  const doc = readMarkdown(`# ${' '.repeat(80000)}x\n${'- '.repeat(40000)}x\n${'*a '.repeat(40000)}\nline${' '.repeat(80000)}y\n## Head ##\n`);
  assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
  assert.equal(doc.content!.at(-1)?.attrs?.style, 'h2');
  assert.equal(plainText({ type: 'doc', content: [doc.content!.at(-1)!] }), 'Head');
});

test('find and replace: case, whole words, across formatting, never across paragraphs; replace keeps formatting', async () => {
  const { pm, schema } = await schemaP;
  const doc = schema.nodeFromJSON({ type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'The cat and the ' }, { type: 'text', text: 'Cat', marks: [{ type: 'strong' }] }, { type: 'text', text: 'alog of cats' }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'the end' }] },
  ] });
  assert.equal(findAll(doc, 'cat', { matchCase: false, wholeWord: false }).length, 3);
  assert.equal(findAll(doc, 'Cat', { matchCase: true, wholeWord: false }).length, 1);
  assert.equal(findAll(doc, 'cat', { matchCase: false, wholeWord: true }).length, 1);
  assert.equal(findAll(doc, 'the the', { matchCase: false, wholeWord: false }).length, 0, 'not across paragraphs');
  assert.equal(findAll(doc, 'the Catalog', { matchCase: false, wholeWord: false }).length, 1, 'across formatting');
  const state = pm.EditorState.create({ doc });
  const hits = findAll(doc, 'cat', { matchCase: false, wholeWord: false });
  const next = state.apply(replaceAll(state, hits, 'dog'));
  assert.equal(next.doc.textContent, 'The dog and the dogalog of dogsthe end');
  let boldDog = false;
  next.doc.descendants((n: { isText: boolean; text: string; marks: Array<{ type: { name: string } }> }) => {
    if (n.isText && n.text.startsWith('dog') && n.marks.some(m => m.type.name === 'strong')) boldDog = true;
  });
  assert.ok(boldDog, 'the bold Cat became a bold dog');
});
