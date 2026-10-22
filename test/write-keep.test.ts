// Write keeps what it used to drop from a Word file: links (a w:hyperlink or a HYPERLINK field) with their
// addresses, Heading 4 to 6 (7 to 9 show as 6 and keep their name), the file's own paragraph styles by name, and list
// numbering such as (a), A., I) and 1.1. Each goes into the file Write saves and comes back when it is opened again.
// Markdown keeps links and Heading 4 to 6 too. No browser needed. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipDeflate } from '../src/core/zip.ts';
import { readZip } from '../src/apps/archive/read.ts';
import { readDocx, writeDocx } from '../src/apps/write/docx.ts';
import { readMarkdown, writeMarkdown, markdownLoses } from '../src/apps/write/markdown.ts';
import { defaultPage, linkHref, numberIn, shapeNumber, type NodeJSON } from '../src/apps/write/model.ts';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

async function wordFile(body: string, styles = '', numbering = ''): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const rels = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>'
    + '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/a?b=1&amp;c=2" TargetMode="External"/></Relationships>';
  return zipDeflate([
    { name: '[Content_Types].xml', data: enc.encode('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'), modified: 0 },
    { name: '_rels/.rels', data: enc.encode('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="/word/document.xml"/></Relationships>'), modified: 0 },
    { name: 'word/document.xml', data: enc.encode(`<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`), modified: 0 },
    { name: 'word/_rels/document.xml.rels', data: enc.encode(rels), modified: 0 },
    { name: 'word/styles.xml', data: enc.encode(`<?xml version="1.0"?><w:styles ${W}><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>${styles}</w:styles>`), modified: 0 },
    { name: 'word/numbering.xml', data: enc.encode(`<?xml version="1.0"?><w:numbering ${W}>${numbering}</w:numbering>`), modified: 0 },
  ]);
}

const wp = (text: string, ppr = '', rpr = '') => `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const p = (text: string, attrs: Record<string, unknown> = {}, marks?: NodeJSON['marks']): NodeJSON => ({ type: 'paragraph', attrs, content: [marks ? { type: 'text', text, marks } : { type: 'text', text }] });

async function part(bytes: Uint8Array, name: string): Promise<string> {
  const e = readZip(bytes).find(x => x.parts.join('/') === name);
  assert.ok(e, `${name} is in the file`);
  return new TextDecoder().decode(await e!.read());
}
const linksIn = (doc: NodeJSON): Array<{ text: string; href: string }> => {
  const out: Array<{ text: string; href: string }> = [];
  const walk = (n: NodeJSON) => {
    const l = n.marks?.find(m => m.type === 'link');
    if (n.type === 'text' && l) out.push({ text: n.text ?? '', href: String(l.attrs?.href) });
    for (const c of n.content ?? []) walk(c);
  };
  walk(doc);
  return out;
};

test('only web and email addresses are links Write keeps and opens', () => {
  assert.equal(linkHref('https://example.com/x'), 'https://example.com/x');
  assert.equal(linkHref('mailto:ann@example.com'), 'mailto:ann@example.com');
  for (const bad of ['javascript:alert(1)', 'file:///C:/x', 'data:text/html,x', 'ftp://x', 'https://a b', '#top']) assert.equal(linkHref(bad), null, bad);
});

test('a Word link and a HYPERLINK field come in as links; Word’s own blue underline is not added to the words', async () => {
  const styles = '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>';
  const body = '<w:p><w:r><w:t xml:space="preserve">See </w:t></w:r><w:hyperlink r:id="rId9"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/><w:b/></w:rPr><w:t>our site</w:t></w:r></w:hyperlink></w:p>'
    + '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> HYPERLINK "mailto:ann@example.com" </w:instrText></w:r>'
    + '<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>email Ann</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:t xml:space="preserve"> soon</w:t></w:r></w:p>';
  const read = await readDocx(await wordFile(body, styles));
  assert.deepEqual(read.dropped, []);
  assert.deepEqual(linksIn(read.doc), [{ text: 'our site', href: 'https://example.com/a?b=1&c=2' }, { text: 'email Ann', href: 'mailto:ann@example.com' }]);
  const run = read.doc.content![0].content![1];
  const types = run.marks!.map(m => m.type);
  assert.ok(types.includes('link') && types.includes('strong'), 'a bold link: ' + types);
  assert.ok(!types.includes('underline') && !run.marks!.some(m => m.type === 'color'), 'the blue underline is the link’s own: ' + types);
  assert.ok(!(read.doc.content![1].content![1].marks ?? []).some(m => m.type === 'link'), 'after the field ends, words are not a link');
});

test('a link written by Write is a w:hyperlink with an outside address, and comes back the same', async () => {
  const doc: NodeJSON = { type: 'doc', content: [{ type: 'paragraph', attrs: {}, content: [
    { type: 'text', text: 'Visit ' },
    { type: 'text', text: 'the ', marks: [{ type: 'link', attrs: { href: 'https://example.com/?a=1&b=2' } }] },
    { type: 'text', text: 'shop', marks: [{ type: 'link', attrs: { href: 'https://example.com/?a=1&b=2' } }, { type: 'strong' }] },
    { type: 'text', text: ' or ' },
    { type: 'text', text: 'write', marks: [{ type: 'link', attrs: { href: 'mailto:ann@example.com' } }] },
  ] }] };
  const bytes = await writeDocx(doc, defaultPage());
  const xml = await part(bytes, 'word/document.xml');
  assert.equal((xml.match(/<w:hyperlink /g) ?? []).length, 2, 'one w:hyperlink per link, round both runs');
  assert.match(xml, /<w:rStyle w:val="Hyperlink"\/>/);
  const rels = await part(bytes, 'word/_rels/document.xml.rels');
  assert.match(rels, /Type="[^"]+\/hyperlink" Target="https:\/\/example\.com\/\?a=1&amp;b=2" TargetMode="External"/);
  assert.match(await part(bytes, 'word/styles.xml'), /w:styleId="Hyperlink"/);
  const back = await readDocx(bytes);
  assert.deepEqual(back.dropped, []);
  assert.deepEqual(linksIn(back.doc), [
    { text: 'the shop', href: 'https://example.com/?a=1&b=2' },
    { text: 'write', href: 'mailto:ann@example.com' },
  ].flatMap(l => (l.text === 'the shop' ? [{ text: 'the ', href: l.href }, { text: 'shop', href: l.href }] : [l])));
});

test('Heading 4, 5 and 6 are kept; Heading 8 shows as 6 and keeps its name when saved over the file', async () => {
  const styles = [4, 5, 6, 8].map(n => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/></w:style>`).join('');
  const file = await wordFile(wp('Four', '<w:pStyle w:val="Heading4"/>') + wp('Five', '<w:pStyle w:val="Heading5"/>') + wp('Six', '<w:pStyle w:val="Heading6"/>') + wp('Eight', '<w:pStyle w:val="Heading8"/>'), styles);
  const read = await readDocx(file);
  assert.deepEqual(read.dropped, []);
  assert.deepEqual(read.doc.content!.map(b => b.attrs?.style), ['h4', 'h5', 'h6', 'h6']);
  assert.equal(read.doc.content![3].attrs?.word, 'Heading8');
  const over = await part(await writeDocx(read.doc, read.page, '', read.source), 'word/document.xml');
  for (const id of ['Heading4', 'Heading5', 'Heading6', 'Heading8']) assert.match(over, new RegExp(`<w:pStyle w:val="${id}"/>`), id);
  const fresh = await writeDocx({ type: 'doc', content: [p('Four', { style: 'h4' })] }, defaultPage());
  assert.match(await part(fresh, 'word/styles.xml'), /w:styleId="Heading4"><w:name w:val="heading 4"\/>.*?<w:i\/>/);
  assert.equal((await readDocx(fresh)).doc.content![0].attrs?.style, 'h4');
});

test('the file’s own paragraph styles are kept by name when saving over it; a new file without them says Normal', async () => {
  const styles = '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:rPr><w:i/></w:rPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/></w:style>';
  const read = await readDocx(await wordFile(wp('Said', '<w:pStyle w:val="Quote"/>') + wp('Plain'), styles));
  assert.equal(read.doc.content![0].attrs?.word, 'Quote');
  assert.equal(read.doc.content![1].attrs?.word, undefined);
  const over = await part(await writeDocx(read.doc, read.page, '', read.source), 'word/document.xml');
  assert.match(over, /<w:pStyle w:val="Quote"\/>/);
  const fresh = await part(await writeDocx(read.doc, read.page), 'word/document.xml');
  assert.doesNotMatch(fresh, /Quote/, 'a file without the style never names it');
  const chosen = await part(await writeDocx({ type: 'doc', content: [p('Now a heading', { style: 'h2', word: null })] }, read.page, '', read.source), 'word/document.xml');
  assert.match(chosen, /<w:pStyle w:val="Heading2"\/>/, 'another style chosen: that one');
});

test('list numbering (a), A., I) and 1.1 comes in, is written as Word numbers it, and comes back the same', async () => {
  const lvl = (i: number, fmt: string, text: string, start = 1) => `<w:lvl w:ilvl="${i}"><w:start w:val="${start}"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/></w:lvl>`;
  const numbering = `<w:abstractNum w:abstractNumId="1">${lvl(0, 'lowerLetter', '(%1)', 3)}</w:abstractNum><w:num w:numId="3"><w:abstractNumId w:val="1"/></w:num>`
    + `<w:abstractNum w:abstractNumId="2">${lvl(0, 'upperRoman', '%1)')}</w:abstractNum><w:num w:numId="4"><w:abstractNumId w:val="2"/></w:num>`
    + `<w:abstractNum w:abstractNumId="5">${lvl(0, 'decimal', '%1.')}${lvl(1, 'decimal', '%1.%2.')}</w:abstractNum><w:num w:numId="6"><w:abstractNumId w:val="5"/></w:num>`;
  const item = (text: string, id: number, l = 0) => wp(text, `<w:numPr><w:ilvl w:val="${l}"/><w:numId w:val="${id}"/></w:numPr>`);
  const read = await readDocx(await wordFile(item('c', 3) + item('d', 3) + wp('-') + item('one', 4) + wp('-') + item('Top', 6) + item('Under', 6, 1) + item('Under too', 6, 1), '', numbering));
  assert.deepEqual(read.dropped, []);
  const lists = read.doc.content!.filter(b => b.type === 'ordered_list');
  assert.deepEqual(lists[0].attrs, { order: 3, kind: 'lowerLetter', shape: 'both' });
  assert.deepEqual(lists[1].attrs, { order: 1, kind: 'upperRoman', shape: 'paren' });
  assert.deepEqual(lists[2].attrs, { order: 1 }, 'the top level is 1. as Write shows it anyway');
  const inner = lists[2].content![0].content![1];
  assert.deepEqual(inner.attrs, { order: 1, outline: true });

  const bytes = await writeDocx(read.doc, read.page);
  const num = await part(bytes, 'word/numbering.xml');
  assert.match(num, /<w:startOverride w:val="3"\/><w:lvl w:ilvl="0"><w:start w:val="3"\/><w:numFmt w:val="lowerLetter"\/><w:lvlText w:val="\(%1\)"\/>/);
  assert.match(num, /<w:numFmt w:val="upperRoman"\/><w:lvlText w:val="%1\)"\/>/);
  assert.match(num, /<w:lvl w:ilvl="1"><w:start w:val="1"\/><w:numFmt w:val="decimal"\/><w:lvlText w:val="%1\.%2\."\/>/);
  const doc = await part(bytes, 'word/document.xml');
  const ids = [...doc.matchAll(/<w:ilvl w:val="(\d)"\/><w:numId w:val="(\d+)"\/>/g)].map(m => [Number(m[1]), m[2]]);
  const top = ids.find(([l]) => l === 0 && ids.filter(([, id]) => id === ids[ids.length - 1][1]).length > 1);
  assert.ok(top, 'the 1.1 items share their parent’s Word list (so Word counts 1.1, 1.2)');
  const again = await readDocx(bytes);
  assert.deepEqual(again.dropped, []);
  const back = again.doc.content!.filter(b => b.type === 'ordered_list');
  assert.deepEqual(back.map(l => l.attrs), lists.map(l => l.attrs));
  assert.deepEqual(back[2].content![0].content![1].attrs, { order: 1, outline: true });
});

test('numbers in each kind and shape, as the page and the PDF show them', () => {
  assert.equal(shapeNumber(numberIn('lowerLetter', 3), 'both'), '(c)');
  assert.equal(shapeNumber(numberIn('upperRoman', 14), 'paren'), 'XIV)');
  assert.equal(shapeNumber(numberIn('upperLetter', 28), 'dot'), 'AB.');
  assert.equal(shapeNumber(numberIn('decimal', 7), 'plain'), '7');
});

test('Markdown keeps links and Heading 4 to 6, and says it cannot keep a list’s own numbering', () => {
  const doc = readMarkdown('#### Four\n\n###### Six\n\nSee [the shop](https://example.com/shop) or [a file](notes.txt).\n');
  assert.deepEqual(doc.content!.slice(0, 2).map(b => b.attrs?.style), ['h4', 'h6']);
  assert.deepEqual(linksIn(doc), [{ text: 'the shop', href: 'https://example.com/shop' }]);
  const md = writeMarkdown(doc);
  assert.match(md, /^#### Four$/m);
  assert.match(md, /^###### Six$/m);
  assert.match(md, /\[the shop\]\(https:\/\/example\.com\/shop\)/);
  assert.deepEqual(markdownLoses({ type: 'doc', content: [{ type: 'ordered_list', attrs: { order: 1, kind: 'upperLetter', shape: 'dot' }, content: [{ type: 'list_item', content: [p('A')] }] }] }), ['list numbering such as A., (a) or 1.1 (Markdown numbers 1. 2. 3.)']);
});
