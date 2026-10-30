// Fuzzing (feeding damaged, random, huge or hostile input) every file reader in the desktop, in-process, no browser.
// Each reader is given a small valid file ("seed"), then dozens of damaged copies of it made by a seeded random
// generator (the same every run; FUZZ_SEED=n changes it, FUZZ_ROUNDS=n fuzzes harder), plus the classics: empty,
// enormous, deeply nested, zip-bomb-like, and the wrong character encoding. What a reader must do: read the input, or
// throw its own named Problem with plain words in it. A raw TypeError or RangeError, a stack overflow, a hang (over
// 2 seconds), runaway memory or a Problem with no words is a finding, printed with the seed that makes it again.
// Each reader runs in its own thread (fuzz-worker.ts) with a memory cap, so one bad input fails one test by name
// instead of killing the run. FUZZ_TRACE=1 prints each input's label as it starts.
// Run: node --test test/fuzz-*.test.ts
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync, gzipSync } from 'node:zlib';
import { BASE_SEED, dec, enc, mutateBytes, mutateText, nested, newTame, Pool, randomText, report, Rng, ROUNDS, STRATEGIES, TEXT_STRATEGIES, type Tame } from './fuzz-helpers.ts';
import { parseXml } from '../src/core/xml.ts';
import { zipDeflate, zipStore } from '../src/core/zip.ts';
import { writeDocx } from '../src/apps/write/docx.ts';
import { writeMarkdown } from '../src/apps/write/markdown.ts';
import { defaultPage, type NodeJSON } from '../src/apps/write/model.ts';
import { Workbook } from '../src/apps/sheet/workbook.ts';
import { saveXlsx } from '../src/apps/sheet/xlsx.ts';
import { newDrawing, writeTcad, type Drawing } from '../src/apps/cad/model.ts';
import { writeDxf } from '../src/apps/cad/dxf.ts';
import { P } from '../src/apps/cad/geom.ts';
import { parseIcs } from '../src/core/ical.ts';
import { parseVcf } from '../src/core/vcard.ts';
import { readLines } from '../src/core/lines.ts';
import { buildOra } from '../src/apps/photoedit/ora.ts';

const pool = new Pool();
after(() => pool.close());

// A 1 x 1 pixel PNG.
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));

/** Damaged copies of a byte seed, every strategy, ROUNDS each; then the classics. */
async function fuzzBytes(what: string, runner: string, seed: Uint8Array, t: Tame = newTame()): Promise<Tame> {
  for (const strategy of STRATEGIES) {
    for (let i = 0; i < ROUNDS; i++) {
      const s = (BASE_SEED * 31 + i * 7 + STRATEGIES.indexOf(strategy) * 1000003) >>> 0;
      const input = mutateBytes(new Rng(s), seed, strategy);
      await pool.run(t, `${what} ${strategy} seed=${s} (${input.length} bytes)`, runner, input);
    }
  }
  await pool.run(t, `${what} empty`, runner, new Uint8Array(0));
  await pool.run(t, `${what} one byte`, runner, new Uint8Array([0x50]));
  await pool.run(t, `${what} 4 MB of random bytes seed=${BASE_SEED}`, runner, new Rng(BASE_SEED).bytes(4 * 1024 * 1024));
  await pool.run(t, `${what} 4 MB of the seed's first byte`, runner, new Uint8Array(4 * 1024 * 1024).fill(seed[0] ?? 0x41));
  await pool.run(t, `${what} seed as UTF-16`, runner, enc(mutateText(new Rng(BASE_SEED), dec(seed), 'utf16')));
  return t;
}

/** Damaged copies of a text seed (string in, as text readers take). */
async function fuzzText(what: string, runner: string, seed: string, t: Tame = newTame()): Promise<Tame> {
  for (const strategy of TEXT_STRATEGIES) {
    for (let i = 0; i < ROUNDS; i++) {
      const s = (BASE_SEED * 17 + i * 13 + TEXT_STRATEGIES.indexOf(strategy) * 1000033) >>> 0;
      const input = mutateText(new Rng(s), seed, strategy);
      await pool.run(t, `${what} ${strategy} seed=${s} (${input.length} chars)`, runner, input);
    }
  }
  for (let i = 0; i < ROUNDS; i++) {
    const s = (BASE_SEED + i * 101) >>> 0;
    await pool.run(t, `${what} random text seed=${s}`, runner, randomText(new Rng(s), 400));
  }
  await pool.run(t, `${what} empty`, runner, '');
  await pool.run(t, `${what} one line of 2 million letters`, runner, 'A'.repeat(2_000_000));
  await pool.run(t, `${what} 200,000 empty lines`, runner, '\n'.repeat(200_000));
  await pool.run(t, `${what} 2 MB of NUL`, runner, '\0'.repeat(2_000_000));
  return t;
}

// ---- Seeds --------------------------------------------------------------------------------------------------------------

const MAIN = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const SHEET_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet ${MAIN}><sheetViews><sheetView workbookViewId="0"><pane xSplit="1" ySplit="2" topLeftCell="B3" state="frozen"/></sheetView></sheetViews><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>a &lt; b &amp; &#x1F600;</t></is></c></row><row r="2"><c r="A2"><f>SUM(B1:B9)</f><v>3</v></c><c r="B2" s="2"><v>45000.5</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="A3:B4"/></mergeCells><!-- note --><![CDATA[x]]></worksheet>`;

const p = (text: string, attrs: Record<string, unknown> = {}, marks?: NodeJSON['marks']): NodeJSON =>
  ({ type: 'paragraph', attrs: { style: 'normal', ...attrs }, content: text ? [marks ? { type: 'text', text, marks } : { type: 'text', text }] : undefined });

function smallDoc(): NodeJSON {
  return {
    type: 'doc',
    content: [
      p('A title', { style: 'title' }),
      p('Heading', { style: 'h1' }),
      { type: 'paragraph', attrs: { style: 'normal', align: 'center' }, content: [{ type: 'text', text: 'Bold ', marks: [{ type: 'strong' }] }, { type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href: 'https://example.com/a?b=1' } }] }, { type: 'hard_break' }, { type: 'text', text: 'tab\tand émoji 😀 and עברית' }] },
      { type: 'bullet_list', content: [{ type: 'list_item', content: [p('one')] }, { type: 'list_item', content: [p('two'), { type: 'ordered_list', attrs: { order: 3 }, content: [{ type: 'list_item', content: [p('inner')] }] }] }] },
      { type: 'table', attrs: { borders: true }, content: [{ type: 'table_row', content: [{ type: 'table_cell', attrs: { colspan: 1, rowspan: 1, colwidth: null, background: '#ffff00' }, content: [p('c1')] }, { type: 'table_cell', attrs: { colspan: 1, rowspan: 1, colwidth: null, background: null }, content: [p('c2')] }] }] },
      { type: 'page_break' },
      p('End'),
    ],
  };
}

const ODT_NS = 'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"';
const zipOf = (parts: Record<string, string | Uint8Array>) => zipStore(Object.entries(parts).map(([name, data]) => ({ name, data: typeof data === 'string' ? enc(data) : data, modified: Date.UTC(2026, 9, 29) })));
function odtSeed(): Uint8Array {
  return zipOf({
    mimetype: 'application/vnd.oasis.opendocument.text',
    'content.xml': `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${ODT_NS}><office:automatic-styles><style:style style:name="P1" style:family="paragraph"><style:paragraph-properties fo:text-align="center"/></style:style><style:style style:name="T1" style:family="text"><style:text-properties fo:font-weight="bold" fo:color="#c00000"/></style:style></office:automatic-styles><office:body><office:text><text:h text:outline-level="1">Heading</text:h><text:p text:style-name="P1">Plain <text:span text:style-name="T1">bold red</text:span><text:line-break/>after<text:tab/>tab 😀</text:p><text:list><text:list-item><text:p>one</text:p></text:list-item></text:list><table:table><table:table-row><table:table-cell><text:p>c1</text:p></table:table-cell><table:table-cell><text:p>c2</text:p></table:table-cell></table:table-row></table:table></office:text></office:body></office:document-content>`,
    'styles.xml': `<?xml version="1.0" encoding="UTF-8"?><office:document-styles ${ODT_NS}><office:styles><style:style style:name="Standard" style:family="paragraph"><style:text-properties fo:font-size="12pt"/></style:style></office:styles><office:automatic-styles><style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="21cm" fo:page-height="29.7cm" fo:margin-top="2cm" fo:margin-bottom="2cm" fo:margin-left="2cm" fo:margin-right="2cm"/></style:page-layout></office:automatic-styles><office:master-styles><style:master-page style:name="Standard" style:page-layout-name="pm1"/></office:master-styles></office:document-styles>`,
  });
}
const odtOf = (over: Record<string, string>) => zipOf({ 'content.xml': `<office:document-content ${ODT_NS}><office:body><office:text><text:p>x</text:p></office:text></office:body></office:document-content>`, ...over });

const RTF_SEED = `{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\fswiss Arial;}{\\f1\\fmodern Courier New;}}{\\colortbl ;\\red255\\green0\\blue0;\\red0\\green0\\blue255;}\\pard\\qc\\b Bold centred\\b0\\par\\pard\\fi-360\\li720 {\\pntext\\f0 1.\\tab}{\\*\\pn\\pnlvlbody\\pndec}Item one\\par\\trowd\\cellx2000\\cellx4000\\intbl c1\\cell c2\\cell\\row\\pard\\cf1\\f1\\fs28 red courier \\'e9\\u233?\\u-10179?\\u-8701? end\\line next\\tab tab\\page after page\\par}`;

function xlsxSeed(): Promise<Uint8Array> {
  const wb = new Workbook();
  wb.setInput(0, 0, 0, 'Name');
  wb.setInput(0, 1, 0, 'Due');
  wb.setInput(0, 0, 1, 'Ann "Lee" 😀');
  wb.setInput(0, 1, 1, '12/03/2026');
  wb.setInput(0, 0, 2, '=SUM(B1:B9)+1');
  wb.setInput(0, 1, 2, '45000.5');
  wb.setInput(0, 2, 2, 'TRUE');
  wb.setStyle(0, { c0: 0, r0: 0, c1: 1, r1: 0 }, old => ({ ...old, b: true, fill: '#ffff00' }));
  wb.addSheet();
  wb.renameSheet(1, "It's \"odd\" sheet");
  wb.setInput(1, 0, 0, "='It''s \"odd\" sheet'!A1");
  return saveXlsx(wb);
}
const WB_RELS = (more = '') => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>${more}</Relationships>`;
const STYLES_REL = '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>';
const bookOf = (sheet: string, extra: Record<string, string> = {}) => zipOf({
  '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  'xl/workbook.xml': `<workbook ${MAIN}><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  'xl/_rels/workbook.xml.rels': WB_RELS('<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>'),
  'xl/worksheets/sheet1.xml': `<worksheet ${MAIN}><sheetData>${sheet}</sheetData></worksheet>`,
  ...extra,
});

function drawingSeed(): Drawing {
  const d = newDrawing('mm');
  const layer = d.current;
  d.ents.push(
    { id: 1, layer, type: 'line', a: P(0, 0), b: P(100, 50.5) },
    { id: 2, layer, type: 'circle', c: P(10, 10), r: 7.25 },
    { id: 3, layer, type: 'arc', c: P(0, 0), r: 20, a0: 0.1, a1: 2.5 },
    { id: 4, layer, type: 'poly', pts: [P(0, 0), P(10, 0), P(10, 10)], bulges: [0, 0.5, 0], closed: true },
    { id: 5, layer, type: 'spline', fit: [P(0, 0), P(5, 8), P(10, 0)], closed: false },
    { id: 6, layer, type: 'ellipse', c: P(50, 50), m: P(20, 0), ratio: 0.5, t0: 0, t1: 6.283185307179586 },
    { id: 7, layer, type: 'point', p: P(3, 4) },
    { id: 8, layer, type: 'xline', p: P(0, 0), d: P(1, 0) },
    { id: 9, layer: 'Text', type: 'text', p: P(1, 1), text: 'Hello ° Ø ± "quoted" 😀', h: 5, angle: 0.3, align: 'left' },
    { id: 10, layer: 'Dimensions', type: 'dim', kind: 'linear', pts: [P(0, 0), P(100, 0), P(50, 20)], dir: 0, h: 3.5, arrow: 2.5, dp: 2, text: '' },
  );
  return d;
}
const dxfOf = (entities: string[]) => enc(['0', 'SECTION', '2', 'ENTITIES', ...entities, '0', 'ENDSEC', '0', 'EOF', ''].join('\r\n'));
const tcadOf = (over: Record<string, unknown>) => JSON.stringify({ tomlinCad: 1, units: 'mm', layers: [{ name: 'L', colour: '#ffffff', on: true, locked: false, lineType: 'continuous' }], current: 'L', items: [], ...over });

const ICS_SEED = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Google Inc//Google Calendar 70.9054//EN', 'X-WR-CALNAME:Work',
  'BEGIN:VTIMEZONE', 'TZID:Australia/Sydney', 'BEGIN:STANDARD', 'TZOFFSETFROM:+1100', 'TZOFFSETTO:+1000', 'DTSTART:19700405T030000', 'END:STANDARD', 'END:VTIMEZONE',
  'BEGIN:VEVENT', 'DTSTART;TZID=Australia/Sydney:20261012T140000', 'DTEND:20261012T150000Z', 'RRULE:FREQ=WEEKLY;INTERVAL=2;UNTIL=20261231T000000Z;BYDAY=MO',
  'DTSTAMP:20261001T000000Z', 'UID:abc123@google.com', 'SUMMARY:Stand-up\\, with "quotes" 😀', 'DESCRIPTION:Line one\\nLine two\\; semi', 'LOCATION:Room 4\\, level 2',
  'X-TOMLINOS-REMIND:15', 'X-TOMLINOS-PROJECT:proj-1', 'ATTENDEE;CN="Ann; Lee":mailto:ann@example.com',
  'BEGIN:VALARM', 'ACTION:DISPLAY', 'TRIGGER:-PT10M', 'END:VALARM', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:allday', 'DTSTART;VALUE=DATE:20260229', 'SUMMARY:Leap day', 'RRULE:FREQ=YEARLY;COUNT=3', 'END:VEVENT',
  'END:VCALENDAR', '',
].join('\r\n');

const VCF_SEED = [
  'BEGIN:VCARD', 'VERSION:3.0', 'UID:u-1', 'FN:Ann "Lee" 😀', 'N:Lee;Ann;;;', 'ORG:Example\\, Inc;Sales', 'TEL;TYPE=CELL:+61 400 000 000', 'EMAIL;TYPE=INTERNET:ann@example.com',
  'ADR;TYPE=HOME:;;1 High St;Town;;2000;Australia', 'BDAY:1990-02-29', 'NOTE:Line one\\nLine two\\; and \\, commas', 'PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRg==', 'END:VCARD',
  'BEGIN:VCARD', 'VERSION:2.1', 'N:Müller;Jürgen', 'TEL;CELL:123', 'END:VCARD', '',
].join('\r\n');

const MAIL_SEED = [
  'From: "Ann; Lee" <ann@example.com>, =?UTF-8?B?SsO8cmdlbg==?= <j@example.com>', 'To: bob@example.com', 'Subject: =?iso-8859-1?Q?caf=E9?= and =?UTF-8?Q?=F0=9F=98=80?=',
  'Date: Thu, 29 Oct 2026 10:00:00 +1100', 'Message-ID: <m1@example.com>', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="b1"', '',
  '--b1', 'Content-Type: multipart/alternative; boundary="b2"', '', '--b2', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '',
  'Hello =F0=9F=98=80 line=', 'joined', '--b2', 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', 'PHA+SGk8L3A+', '--b2--',
  '--b1', 'Content-Type: image/png; name="pic.png"', 'Content-Disposition: inline; filename="pic.png"', 'Content-ID: <pic1>', 'Content-Transfer-Encoding: base64', '',
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', '--b1', 'Content-Type: message/rfc822', '', 'Subject: inner', '', 'inner body', '--b1--', '',
].join('\r\n');

const cat = (...parts: Array<string | Uint8Array>): Uint8Array => {
  const bytes = parts.map(x => (typeof x === 'string' ? enc(x) : x));
  const out = new Uint8Array(bytes.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of bytes) {
    out.set(b, at);
    at += b.length;
  }
  return out;
};

function pdfSeed(): Uint8Array {
  const content = deflateSync(Buffer.from('BT /F1 12 Tf 10 10 Td (Hi) Tj ET'));
  return cat(
    '%PDF-1.4\n', '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 /MediaBox [0 0 200 100] >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Rotate 90 /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n`, content, '\nendstream\nendobj\n',
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    'trailer\n<< /Root 1 0 R >>\n%%EOF\n',
  );
}
const pdfOf = (body: string) => enc(`%PDF-1.4\n${body}\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`);

function oraSeed(): Uint8Array {
  return buildOra({
    stack: { width: 1, height: 1, layers: [{ name: 'Layer "1" 😀', src: 'data/layer1.png', x: 0, y: 0, opacity: 0.5, visible: true, locked: false, mode: 'normal' as never }] },
    layerPngs: [PNG], merged: PNG, thumbnail: PNG,
  });
}
const oraOf = (stack: string, more: Record<string, Uint8Array> = {}) => zipOf({ mimetype: 'image/openraster', 'stack.xml': stack, 'data/l.png': PNG, ...more });

const PROJECTS_SEED = JSON.stringify([{ uid: 'p-1', name: 'Site "A" 😀', site: 'example.com', notes: 'n\nn', focus: true, finished: false, created: 1700000000000 }], null, 1);

// ---- XML ---------------------------------------------------------------------------------------------------------------

test('XML reader: damaged, nested and enormous input is read or refused by name', async () => {
  const t = await fuzzText('xml', 'parseXml', SHEET_XML);
  const T = (label: string, input: string) => pool.run(t, label, 'parseXml', input);
  await T('xml 300,000 nested tags', nested('<a>', '</a>', 300_000));
  await T('xml 300,000 nested open tags, never closed', '<a>'.repeat(300_000));
  await T('xml one tag with a 3 MB attribute list', `<a ${'x="1" '.repeat(500_000)}/>`);
  await T('xml one tag with a 3 MB name', `<${'a'.repeat(3_000_000)}/>`);
  await T('xml an attribute with a 3 MB value and no closing quote', `<a b="${'x'.repeat(3_000_000)}`);
  await T('xml 100,000 entities', `<a>${'&#x1F600;&amp;&lt;&unknown;&#0;&#xFFFFFFFF;'.repeat(100_000)}</a>`);
  await T('xml a DOCTYPE bomb', '<!DOCTYPE a [<!ENTITY x "xxxxxxxxxx"><!ENTITY y "&x;&x;&x;&x;&x;&x;&x;&x;&x;&x;">]><a>&y;</a>');
  await T('xml a 2 MB comment never closed', `<a><!--${'-'.repeat(2_000_000)}`);
  await T('xml 100,000 processing instructions', `<a>${'<?pi x?>'.repeat(100_000)}</a>`);
  await T('xml tag names of only punctuation', '<:/><a:b:c></a:b:c><x y=z></x>');
  report(t, 'parseXml');
});

test('XML reader: entities decode to what they say, never to something else', () => {
  const el = parseXml('<a b="&#65;&#x42;&amp;&lt;&gt;&quot;&apos;&#9;&#10;">&#x1F600;&#xD800;&#0;&zz;</a>');
  assert.equal(el.attrs.b, 'AB&<>"\'\t\n');
  // A lone surrogate (D800) is not a character: it must not come through as half of one (it becomes "?" or U+FFFD in
  // every file written later, and breaks string functions that count characters).
  assert.equal(el.text, '😀&zz;', 'a surrogate code (D800) or a NUL slipped into the text');
});

// ---- Zip and archives --------------------------------------------------------------------------------------------------

function zipSeed(): Uint8Array {
  return zipStore([
    { name: 'docs/', modified: Date.UTC(2026, 9, 29) },
    { name: 'docs/a.txt', data: enc('hello '.repeat(100)), modified: Date.UTC(2026, 9, 29) },
    { name: 'é 😀/b.bin', data: new Uint8Array([...Array(256).keys()]), modified: Date.UTC(2026, 9, 29) },
    { name: '../evil.txt', data: enc('x'), modified: Date.UTC(2026, 9, 29) },
  ]);
}

const u16 = (b: Uint8Array, at: number, v: number) => { b[at] = v & 255; b[at + 1] = (v >> 8) & 255; };
const u32 = (b: Uint8Array, at: number, v: number) => { b[at] = v & 255; b[at + 1] = (v >> 8) & 255; b[at + 2] = (v >> 16) & 255; b[at + 3] = (v >>> 24) & 255; };

/** The zip with one field of its end record or central directory set to a chosen value. */
function zipWith(zip: Uint8Array, patch: (b: Uint8Array, end: number, central: number) => void): Uint8Array {
  const b = zip.slice();
  let end = -1;
  for (let at = b.length - 22; at >= 0; at--) if (b[at] === 0x50 && b[at + 1] === 0x4b && b[at + 2] === 5 && b[at + 3] === 6) { end = at; break; }
  const central = b[end + 16] | (b[end + 17] << 8) | (b[end + 18] << 16) | (b[end + 19] << 24);
  patch(b, end, central);
  return b;
}

test('zip reader: damaged, zip-bomb-like and hostile archives are read or refused by name', async () => {
  const stored = zipSeed();
  const packed = await zipDeflate([{ name: 'a.txt', data: enc('hello '.repeat(5000)), modified: 0 }, { name: 'b/c.txt', data: enc('x'), modified: 0 }]);
  const t = await fuzzBytes('zip stored', 'readZipAll', stored);
  await fuzzBytes('zip deflated', 'readZipAll', packed, t);
  const T = (label: string, input: Uint8Array) => pool.run(t, label, 'readZipAll', input);
  await T('zip: 65,535 entries claimed, none there', zipWith(stored, (b, end) => u16(b, end + 10, 65534)));
  await T('zip: central directory offset past the end', zipWith(stored, (b, end) => u32(b, end + 16, 0x7fffffff)));
  await T('zip: central directory offset pointing at the end record itself', zipWith(stored, (b, end) => u32(b, end + 16, end)));
  await T('zip: an entry whose local header offset is past the end', zipWith(stored, (b, _end, c) => u32(b, c + 42, 0x7ffffff0)));
  await T('zip: an entry claiming a 4 GB unpacked size', zipWith(stored, (b, _end, c) => u32(b, c + 24, 0xfffffffe)));
  await T('zip: an entry claiming a 4 GB packed size', zipWith(stored, (b, _end, c) => u32(b, c + 20, 0xfffffffe)));
  await T('zip: a name length running past the directory', zipWith(stored, (b, _end, c) => u16(b, c + 28, 65535)));
  await T('zip: method 99', zipWith(stored, (b, _end, c) => u16(b, c + 10, 99)));
  await T('zip: encrypted flag', zipWith(stored, (b, _end, c) => u16(b, c + 8, 1)));
  await T('zip: only an end record', new Uint8Array([0x50, 0x4b, 5, 6, ...new Array(18).fill(0)]));
  // Deflate that claims to be tiny but holds 8 MB (a zip bomb with a lying size): the cap is the claimed size.
  const bomb = await zipDeflate([{ name: 'z', data: new Uint8Array(8 * 1024 * 1024), modified: 0 }]);
  await T('zip: a deflated entry of 8 MB whose claimed size is 10 bytes', zipWith(bomb, (b, _end, c) => u32(b, c + 24, 10)));
  await fuzzBytes('tar', 'readTarAll', tarSeed(), t);
  await fuzzBytes('gzip', 'readGzipAll', new Uint8Array(gzipSync(Buffer.from('plain text'))), t);
  report(t, 'readZip / readArchive');
});

function tarSeed(): Uint8Array {
  const head = new Uint8Array(512);
  const put = (at: number, s: string) => head.set(enc(s), at);
  put(0, 'dir/one.txt');
  put(100, '0000644');
  put(124, '0000000004');
  put(136, '00000000000');
  put(156, '0');
  put(257, 'ustar');
  put(263, '00');
  head.fill(32, 148, 156);
  let sum = 0;
  for (const b of head) sum += b;
  put(148, sum.toString(8).padStart(6, '0') + '\0 ');
  const out = new Uint8Array(512 * 4);
  out.set(head);
  out.set(enc('long'), 512);
  return out;
}

// ---- Word, OpenDocument, RTF, Markdown -----------------------------------------------------------------------------------

const DOC_RELS = '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
const docxOf = (over: Record<string, string>) => zipOf({ '_rels/.rels': DOC_RELS, 'word/document.xml': '<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>x</w:t></w:r></w:p></w:body></w:document>', ...over });

test('Word reader (.docx): damaged files are read or refused by name', async () => {
  const seed = await writeDocx(smallDoc(), defaultPage(), 'Fuzz');
  const t = await fuzzBytes('docx', 'readDocx', seed);
  const T = (label: string, input: Uint8Array) => pool.run(t, label, 'readDocx', input);
  await T('docx: main part named in .rels is missing', docxOf({ '_rels/.rels': DOC_RELS.replace('word/document.xml', '/nowhere.xml') }));
  await T('docx: a table nested 20,000 deep', docxOf({ 'word/document.xml': `<w:document xmlns:w="x"><w:body>${nested('<w:tbl><w:tr><w:tc>', '</w:tc></w:tr></w:tbl>', 20_000)}</w:body></w:document>` }));
  await T('docx: 50,000 paragraphs', docxOf({ 'word/document.xml': `<w:document xmlns:w="x"><w:body>${'<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>x</w:t></w:r></w:p>'.repeat(50_000)}</w:body></w:document>` }));
  await T('docx: a picture relationship pointing outside the package', docxOf({ 'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../../../../etc/passwd"/></Relationships>', 'word/document.xml': '<w:document xmlns:w="x" xmlns:r="y" xmlns:a="z"><w:body><w:p><w:r><w:drawing><wp:inline><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rId5"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p></w:body></w:document>' }));
  await T('docx: styles and numbering that refer to themselves', docxOf({ 'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>', 'word/numbering.xml': '<w:numbering xmlns:w="x"><w:abstractNum w:abstractNumId="1"><w:numStyleLink w:val="S1"/><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num></w:numbering>', 'word/styles.xml': '<w:styles xmlns:w="x"><w:style w:type="paragraph" w:styleId="A"><w:basedOn w:val="B"/></w:style><w:style w:type="paragraph" w:styleId="B"><w:basedOn w:val="A"/></w:style><w:style w:type="numbering" w:styleId="S1"><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style></w:styles>', 'word/document.xml': '<w:document xmlns:w="x"><w:body><w:p><w:pPr><w:pStyle w:val="A"/><w:numPr><w:numId w:val="1"/><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>x</w:t></w:r></w:p></w:body></w:document>' }));
  await T('docx: table cell with gridSpan 1e9 and vMerge', docxOf({ 'word/document.xml': '<w:document xmlns:w="x"><w:body><w:tbl><w:tr><w:tc><w:tcPr><w:gridSpan w:val="1000000000"/><w:vMerge w:val="restart"/></w:tcPr><w:p/></w:tc></w:tr><w:tr><w:tc><w:tcPr><w:gridSpan w:val="-5"/><w:vMerge/></w:tcPr><w:p/></w:tc></w:tr></w:tbl></w:body></w:document>' }));
  await T('docx: page size of NaN and negative margins', docxOf({ 'word/document.xml': '<w:document xmlns:w="x"><w:body><w:p/><w:sectPr><w:pgSz w:w="NaN" w:h="-1"/><w:pgMar w:top="-99999" w:left="1e308"/></w:sectPr></w:body></w:document>' }));
  await T('docx: a run of 10,000 nested smartTags and hyperlinks', docxOf({ 'word/document.xml': `<w:document xmlns:w="x"><w:body><w:p>${nested('<w:hyperlink><w:smartTag>', '</w:smartTag></w:hyperlink>', 10_000)}</w:p></w:body></w:document>` }));
  report(t, 'readDocx');
});

test('OpenDocument reader (.odt): damaged files are read or refused by name', async () => {
  const t = await fuzzBytes('odt', 'readOdt', odtSeed());
  const T = (label: string, input: Uint8Array) => pool.run(t, label, 'readOdt', input);
  await T('odt: styles that inherit from each other in a loop', odtOf({ 'styles.xml': `<office:document-styles ${ODT_NS}><office:styles><style:style style:name="A" style:family="paragraph" style:parent-style-name="B"/><style:style style:name="B" style:family="paragraph" style:parent-style-name="A"/></office:styles></office:document-styles>`, 'content.xml': `<office:document-content ${ODT_NS}><office:body><office:text><text:p text:style-name="A">x</text:p></office:text></office:body></office:document-content>` }));
  await T('odt: 20,000 nested lists', odtOf({ 'content.xml': `<office:document-content ${ODT_NS}><office:body><office:text>${nested('<text:list><text:list-item>', '</text:list-item></text:list>', 20_000)}</office:text></office:body></office:document-content>` }));
  await T('odt: 20,000 nested spans', odtOf({ 'content.xml': `<office:document-content ${ODT_NS}><office:body><office:text><text:p>${nested('<text:span>', '</text:span>', 20_000)}</text:p></office:text></office:body></office:document-content>` }));
  await T('odt: 20,000 nested tables', odtOf({ 'content.xml': `<office:document-content ${ODT_NS}><office:body><office:text>${nested('<table:table><table:table-row><table:table-cell>', '</table:table-cell></table:table-row></table:table>', 20_000)}</office:text></office:body></office:document-content>` }));
  await T('odt: a cell spanning 1e9 columns', odtOf({ 'content.xml': `<office:document-content ${ODT_NS}><office:body><office:text><table:table><table:table-row><table:table-cell table:number-columns-spanned="1000000000" table:number-rows-spanned="-3"><text:p>x</text:p></table:table-cell></table:table-row></table:table></office:text></office:body></office:document-content>` }));
  await T('odt: lengths that are not lengths', odtOf({ 'styles.xml': `<office:document-styles ${ODT_NS}><office:automatic-styles><style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="NaNcm" fo:page-height="-1in" fo:margin-top="1e400pt"/></style:page-layout></office:automatic-styles><office:master-styles><style:master-page style:name="Standard" style:page-layout-name="pm1"/></office:master-styles></office:document-styles>` }));
  report(t, 'readOdt');
});

test('RTF reader: damaged files are read or refused by name', async () => {
  const t = await fuzzBytes('rtf', 'readRtf', enc(RTF_SEED));
  const T = (label: string, input: string) => pool.run(t, label, 'readRtf', enc(input));
  await T('rtf: 200,000 nested groups', `{\\rtf1${'{'.repeat(200_000)}x${'}'.repeat(200_000)}}`);
  await T('rtf: 200,000 open groups never closed', `{\\rtf1${'{\\b '.repeat(200_000)}`);
  await T('rtf: a control word with a 1 MB number', `{\\rtf1\\fs${'9'.repeat(1_000_000)} x}`);
  await T('rtf: \\uc with a huge count then \\u', '{\\rtf1\\uc999999999\\u233?abc}');
  await T('rtf: font and colour numbers out of range', '{\\rtf1{\\fonttbl{\\f99999999 X;}}\\f-1\\f2147483647\\cf99999\\highlight-5\\fs-20\\fs0 x\\par}');
  await T('rtf: a picture of 2 MB of hex', `{\\rtf1{\\pict\\pngblip\\picw1\\pich1 ${'ab'.repeat(1_000_000)}}}`);
  await T('rtf: a table with 100,000 cells in one row', `{\\rtf1\\trowd${'\\cellx100'.repeat(100_000)}${'x\\cell'.repeat(100_000)}\\row}`);
  await T('rtf: cellx going backwards and negative', '{\\rtf1\\trowd\\cellx5000\\cellx-1000\\cellx0\\intbl a\\cell b\\cell c\\cell\\row}');
  await T('rtf: a code page that does not exist', "{\\rtf1\\ansicpg99999\\'e9\\'ff x}");
  report(t, 'readRtf');
});

test('Markdown reader: any text at all is read (it is only text)', async () => {
  const md = writeMarkdown(smallDoc());
  const t = await fuzzText('md', 'readMarkdown', md);
  const T = (label: string, input: string) => pool.run(t, label, 'readMarkdown', input);
  await T('md: a list nested 5,000 deep', Array.from({ length: 5000 }, (_, i) => `${' '.repeat(i * 2)}- item`).join('\n'));
  await T('md: a list of 100,000 items', '- item\n'.repeat(100_000));
  await T('md: a table 2,000 columns wide and 2,000 rows long', `|${' a |'.repeat(2000)}\n|${' --- |'.repeat(2000)}\n${(`|${' b |'.repeat(2000)}\n`).repeat(2000)}`);
  await T('md: 500,000 unclosed asterisks', '*'.repeat(500_000));
  await T('md: 500,000 unclosed brackets', '['.repeat(500_000));
  await T('md: 500,000 backticks', '`'.repeat(500_000));
  await T('md: a fence never closed over 100,000 lines', '```\n' + 'x\n'.repeat(100_000));
  await T('md: a line of 1 million spaces then text', ' '.repeat(1_000_000) + 'x\n' + ' '.repeat(1_000_000) + '\n');
  await T('md: a heading with 1 million #', '#'.repeat(1_000_000) + ' x');
  await T('md: a link with a 1 MB address', `[x](https://example.com/${'a'.repeat(1_000_000)})`);
  await T('md: a quote 10,000 deep', '> '.repeat(10_000) + 'x');
  report(t, 'readMarkdown');
});

test('Markdown reader: a line starting with | that is not a table does not hang the editor', async () => {
  // Found by the fuzzer (seed 344437519, strategy cut): the paragraph loop refuses a line that starts with "|" but
  // never steps past it, so it adds empty paragraphs for ever and the tab runs out of memory. A table pasted without
  // its ---|--- row, or any line that starts with a pipe, does this.
  const t = newTame();
  await pool.run(t, 'md: "| c1 | c" as the whole file', 'readMarkdown', '| c1 | c');
  await pool.run(t, 'md: a pipe line in the middle of a paragraph', 'readMarkdown', 'text\n| not a table\nmore');
  await pool.run(t, 'md: a pipe line after a heading', 'readMarkdown', '# h\n|\n');
  report(t, 'readMarkdown (pipe lines)');
});

// ---- Spreadsheet ------------------------------------------------------------------------------------------------------------

test('Excel reader (.xlsx): damaged files are read or refused by name', async () => {
  const t = await fuzzBytes('xlsx', 'openXlsx', await xlsxSeed());
  const T = (label: string, input: Uint8Array) => pool.run(t, label, 'openXlsx', input);
  await T('xlsx: cell addresses past the edge and nonsense', bookOf('<row r="1"><c r="XFD1048576"><v>1</v></c><c r="A0"><v>2</v></c><c r="ZZZZZ99999999"><v>3</v></c><c r=""><v>4</v></c><c r="A1" t="s"><v>-1</v></c><c r="B1" t="s"><v>999999</v></c><c r="C1" t="b"><v>maybe</v></c><c r="D1"><v>1e999</v></c><c r="E1"><v>NaN</v></c><c r="F1" s="99999"><v>1</v></c></row>'));
  await T('xlsx: a shared formula with no master; a formula 1 MB long', bookOf(`<row r="1"><c r="A1"><f t="shared" si="7"/></c><c r="B1"><f>${'A1+'.repeat(300_000)}1</f></c><c r="C1"><f t="array" ref="C1:C1048576">ROW()</f></c></row>`));
  await T('xlsx: merges that overlap, invert and leave the sheet', bookOf('', { 'xl/worksheets/sheet1.xml': `<worksheet ${MAIN}><sheetData/><mergeCells><mergeCell ref="B2:A1"/><mergeCell ref="A1:A1"/><mergeCell ref="A1:ZZZ999999"/><mergeCell ref="A1:B2"/><mergeCell ref="B2:C3"/><mergeCell ref="x"/></mergeCells><sheetViews><sheetView><pane xSplit="-1" ySplit="1e9" state="frozen"/></sheetView></sheetViews><cols><col min="0" max="99999" width="-5"/><col min="5" max="1" width="NaN"/></cols></worksheet>` }));
  await T('xlsx: shared strings with 100,000 rich runs; a string index past the end', bookOf('<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>', { 'xl/sharedStrings.xml': `<sst ${MAIN}><si>${'<r><rPr><b/></rPr><t>a</t></r>'.repeat(100_000)}</si></sst>` }));
  await T('xlsx: 60 sheets, two with the same name, one named with : and [ ] and 40 letters', bookOf('', { 'xl/workbook.xml': `<workbook ${MAIN}><sheets>${Array.from({ length: 60 }, (_, i) => `<sheet name="${i < 2 ? 'Same' : i === 3 ? 'a:b[c]/d\\e?f*g' : i === 4 ? 'x'.repeat(40) : `S${i}`}" sheetId="${i}" r:id="rId1"/>`).join('')}</sheets><definedNames><definedName name="A1">S!A1</definedName><definedName name="${'n'.repeat(10_000)}">S!A1:A2</definedName><definedName name="loop">loop</definedName></definedNames></workbook>` }));
  await T('xlsx: workbook rels pointing outside the package and at itself', bookOf('', { 'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="../../../../workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="_rels/workbook.xml.rels"/></Relationships>' }));
  await T('xlsx: styles with 100,000 fonts and an xf pointing past them', bookOf('<row r="1"><c r="A1" s="1"><v>1</v></c></row>', { 'xl/_rels/workbook.xml.rels': WB_RELS(STYLES_REL), 'xl/styles.xml': `<styleSheet ${MAIN}><numFmts><numFmt numFmtId="164" formatCode="${'0'.repeat(50_000)}"/><numFmt numFmtId="-1" formatCode="[Red][>1e999]0;[$-999999]0"/></numFmts><fonts>${'<font><sz val="1e308"/><color rgb="GGGGGG"/><color theme="99" tint="NaN"/></font>'.repeat(100_000)}</fonts><cellXfs><xf numFmtId="164" fontId="999999" fillId="-1" borderId="99999999"/><xf numFmtId="-1" fontId="0"/></cellXfs></styleSheet>` }));
  await T('xlsx: a date number far outside any calendar', bookOf('<row r="1"><c r="A1" s="1"><v>1e300</v></c><c r="B1" s="1"><v>-1e300</v></c><c r="C1" t="d"><v>9999-99-99T99:99:99</v></c></row>', { 'xl/_rels/workbook.xml.rels': WB_RELS(STYLES_REL), 'xl/styles.xml': `<styleSheet ${MAIN}><cellXfs><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>` }));
  report(t, 'openXlsx');
});

test('the .sheet file (Workbook.load): damaged JSON is loaded or refused by name', async () => {
  const wb = new Workbook();
  wb.setInput(0, 0, 0, 'x');
  wb.setInput(0, 1, 1, '=A1&"y"');
  wb.setInput(0, 2, 2, '12/03/2026');
  wb.setStyle(0, { c0: 0, r0: 0, c1: 0, r1: 0 }, old => ({ ...old, b: true, fill: '#ff0000' }));
  wb.addSheet();
  wb.renameSheet(1, "It's two");
  const seed = wb.serialize();
  const t = await fuzzText('sheet', 'loadSheet', seed);
  const T = (label: string, over: Record<string, unknown>) => pool.run(t, label, 'loadSheet', JSON.stringify({ ...JSON.parse(seed), ...over }));
  await T('sheet: cells with wrong types in every slot', { sheets: [{ name: 'S', cells: [[null, null, null, null, null], ['1', '2', 3, 4, 5], [1.5, 2.5, 'v', 'f', 's'], [0, 0, {}, [], 'x'], [0, 1, 1e308, null, 1e308], [0, 2, 'v', 'f'.repeat(4001), 0], [0, 3, null, null, 0, 'n'.repeat(40_000)], [-1, -1, 1, null, 0], [1e9, 1e9, 1, null, 0]] }] });
  await T('sheet: styles that are not styles; a style index that loops', { styles: [null, 'x', 7, { b: 'yes', fill: 'red', code: 'x'.repeat(100_000), fs: -1, ff: {} }], sheets: [{ name: 'S', cells: [[0, 0, 'x', null, 3], [0, 1, 'x', null, 2]] }] });
  await T('sheet: a sheet named with 31 emoji, and a name of only spaces', { sheets: [{ name: '😀'.repeat(31), cells: [] }, { name: '   ', cells: [] }] });
  await T('sheet: merges, freeze, filter, hidden rows and tables all wrong', { sheets: [{ name: 'S', cells: [], merges: [[0, 0, -1, -1], [1, 1, 0, 0], 'x', [0, 0, 99999, 99999]], freeze: [-1, 1e9], hiddenRows: [-1, 1e9, 'x', null], filter: { range: [0, 0, 1, 1], cols: { x: 'y', '-1': ['a'] }, rules: 7 }, tables: [{ name: '', range: [0, 0, 1, 1], columns: null }], charts: [{ type: 'pie', ranges: 'A1' }], cf: [{ ranges: [[0, 0, 0, 0]], rule: { kind: 'none' } }], dv: [null], pivots: [{}], page: { area: [1, 1, 0, 0] } }] });
  await T('sheet: names that refer to themselves and 5,000 of them', { names: Array.from({ length: 5000 }, (_, i) => ({ name: `n${i}`, ref: `n${(i + 1) % 5000}` })) });
  await T('sheet: a formula that refers to itself through 500 cells', { sheets: [{ name: 'S', cells: Array.from({ length: 500 }, (_, i) => [0, i, null, `=A${((i + 1) % 500) + 1}+1`, 0]) }] });
  await pool.run(t, 'sheet: 100,000-deep JSON nesting in a cell value', 'loadSheet', `{"format":"tomlinos-sheet","sheets":[{"name":"S","cells":[[0,0,${'['.repeat(100_000)}${']'.repeat(100_000)},null,0]]}]}`);
  report(t, 'Workbook.load');
});

test('CSV import: any text at all is split into rows', async () => {
  const seed = 'Name,Due,"Amount, in $"\r\n"Ann ""Lee""",12/03/2026,"1,000.50"\r\n"multi\nline",;,\t\r\n😀,é,עברית\r\n';
  const t = await fuzzText('csv', 'parseDelimited', seed);
  const T = (label: string, input: string) => pool.run(t, label, 'parseDelimited', input);
  await T('csv: a quote never closed over 2 MB', '"' + 'a,b\n'.repeat(500_000));
  await T('csv: 50,000 columns in one row', 'a,'.repeat(50_000) + '\n');
  await T('csv: 2 million quotes', '"'.repeat(2_000_000));
  report(t, 'parseDelimited');
});

// ---- CAD ----------------------------------------------------------------------------------------------------------------------

test('DXF reader: damaged files are read or refused by name', async () => {
  const seed = writeDxf(drawingSeed(), { textAsLines: false, construction: true, hidden: true }).bytes;
  const t = await fuzzBytes('dxf', 'readDxf', seed);
  const T = (label: string, input: Uint8Array) => pool.run(t, label, 'readDxf', input);
  await T('dxf: numbers that are not numbers, infinities and 1e308', dxfOf(['0', 'LINE', '8', 'A', '10', 'abc', '20', 'Infinity', '11', '1e308', '21', '-1e308', '0', 'CIRCLE', '10', '0', '20', '0', '40', '-1', '0', 'ARC', '10', '0', '20', '0', '40', '1', '50', '1e20', '51', '-1e20']));
  await T('dxf: a polyline with 3 million vertices claimed, 300,000 given', dxfOf(['0', 'LWPOLYLINE', '8', 'A', '90', '3000000', ...Array.from({ length: 300_000 }, (_, i) => ['10', String(i), '20', String(i)]).flat()]));
  await T('dxf: a block that inserts itself', enc(['0', 'SECTION', '2', 'BLOCKS', '0', 'BLOCK', '2', 'B', '0', 'INSERT', '2', 'B', '10', '1', '20', '1', '41', '2', '0', 'ENDBLK', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES', '0', 'INSERT', '2', 'B', '10', '0', '20', '0', '0', 'ENDSEC', '0', 'EOF', ''].join('\n')));
  await T('dxf: an insert with 1e6 rows and columns', enc(['0', 'SECTION', '2', 'BLOCKS', '0', 'BLOCK', '2', 'B', '0', 'LINE', '10', '0', '20', '0', '11', '1', '21', '1', '0', 'ENDBLK', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES', '0', 'INSERT', '2', 'B', '10', '0', '20', '0', '70', '1000000', '71', '1000000', '44', '1', '45', '1', '0', 'ENDSEC', '0', 'EOF', ''].join('\n')));
  await T('dxf: a TEXT of 1 MB', dxfOf(['0', 'TEXT', '8', 'A', '10', '0', '20', '0', '40', '5', '1', 'x'.repeat(1_000_000)]));
  await T('dxf: a layer name of 1 MB', dxfOf(['0', 'LINE', '8', 'L'.repeat(1_000_000), '10', '0', '20', '0', '11', '1', '21', '1']));
  await T('dxf: an MTEXT with 100,000 formatting codes', dxfOf(['0', 'MTEXT', '8', 'A', '10', '0', '20', '0', '40', '5', '3', '\\P\\A1;\\H2x;'.repeat(100_000), '1', 'end']));
  await T('dxf: a spline with no fit points and a degree of 1e9', dxfOf(['0', 'SPLINE', '8', 'A', '71', '1000000000', '72', '0', '73', '0', '74', '0']));
  await T('dxf: 100,000 empty sections', enc('0\nSECTION\n2\nX\n0\nENDSEC\n'.repeat(100_000) + '0\nEOF\n'));
  await T('dxf: an odd number of lines', enc('0\nSECTION\n2\nENTITIES\n0\nLINE\n10\n'));
  await T('dxf: $INSUNITS of 99 and $EXTMIN of NaN', enc(['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '99', '9', '$EXTMIN', '10', 'NaN', '20', 'NaN', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES', '0', 'ENDSEC', '0', 'EOF'].join('\n')));
  report(t, 'readDxf');
});

test('the .tcad file (readTcad): damaged JSON is read or refused by name', async () => {
  const seed = writeTcad(drawingSeed());
  const t = await fuzzText('tcad', 'readTcad', seed);
  const T = (label: string, over: Record<string, unknown>) => pool.run(t, label, 'readTcad', tcadOf(over));
  await T('tcad: items with every field the wrong type', { items: [{ type: 'line', a: 'x', b: null }, { type: 'circle', c: { x: '1', y: 1 }, r: '5' }, { type: 'arc', c: { x: 0, y: 0 }, r: 1, a0: 1, a1: 0 }, { type: 'poly', pts: 'x' }, { type: 'poly', pts: [{ x: 0, y: 0 }], bulges: null }, { type: 'poly', pts: [{ x: 0, y: 0 }, { x: 1, y: 1 }], bulges: [1e308, null, 'x'] }, { type: 'text', p: { x: 0, y: 0 }, text: 5, h: 1 }, { type: 'text', p: { x: 0, y: 0 }, text: 'x', h: 1, angle: 'y', arc: 7 }, { type: 'dim', kind: 'weird', pts: [] }, { type: 'dim', kind: 'linear', pts: [{ x: 0, y: 0 }], h: 1, arrow: 1, dp: 99, text: 'x' }, { type: 'xline', p: { x: 0, y: 0 }, d: { x: 0, y: 0 } }, { type: 'ellipse', c: { x: 0, y: 0 }, m: { x: 1, y: 0 }, ratio: 2, t0: 0, t1: 1 }, null, 7, 'line', []] });
  await T('tcad: layers that are not layers; 1,001 layers', { layers: [null, 7, { name: 5 }, { name: ' ', colour: 'red' }, { name: 'L', colour: '#GGGGGG', lineType: 'dashed-ish', on: 'no' }, ...Array.from({ length: 1001 }, (_, i) => ({ name: `L${i}` }))] });
  await T('tcad: a photo that is not a photo', { photo: { jpeg: 7, px: -1, py: 1e308, at: null, u: { x: 'x' }, opacity: 'full', on: 1 } });
  await T('tcad: style with impossible sizes', { style: { textH: -1, dimH: 1e308, arrow: null, dp: 99 } });
  await T('tcad: 200,001 items', { items: Array.from({ length: 200_001 }, () => ({ type: 'point', p: { x: 0, y: 0 } })) });
  await pool.run(t, 'tcad: a polyline of 2,000,001 points', 'readTcad', `{"tomlinCad":1,"layers":[{"name":"L"}],"items":[{"type":"poly","pts":[${'{"x":0,"y":0},'.repeat(2_000_000)}{"x":0,"y":0}]}]}`);
  await pool.run(t, 'tcad: 100,000-deep nesting', 'readTcad', `{"tomlinCad":1,"layers":[],"items":[${'['.repeat(100_000)}${']'.repeat(100_000)}]}`);
  report(t, 'readTcad');
});

// ---- Calendar, contacts, projects -------------------------------------------------------------------------------------------------

test('calendar reader (.ics): any text at all is read (lines that do not parse are skipped)', async () => {
  const t = await fuzzText('ics', 'parseIcs', ICS_SEED);
  const T = (label: string, input: string) => pool.run(t, label, 'parseIcs', input);
  await T('ics: 100,000 nested BEGINs', 'BEGIN:VCALENDAR\n' + 'BEGIN:X\n'.repeat(100_000));
  await T('ics: 50,000 events with no UID and the same text', 'BEGIN:VCALENDAR\n' + 'BEGIN:VEVENT\nDTSTART:20260101\nSUMMARY:x\nEND:VEVENT\n'.repeat(50_000) + 'END:VCALENDAR\n');
  await T('ics: a folded line 2 MB long', 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:a\nDTSTART:20260101\nSUMMARY:' + 'x\n y'.repeat(1_000_000) + '\nEND:VEVENT\nEND:VCALENDAR\n');
  await T('ics: dates at every edge', ['BEGIN:VCALENDAR', ...['00000000', '99991231', '20260230', '20260229', '20250229', '20261301', '20261232', '20261012T240000', '20261012T236000', '20261012T000000Z', '20261012T0000', '2026-10-12', '20261012T000000+1000', '1e9'].map((d, i) => `BEGIN:VEVENT\nUID:${i}\nDTSTART:${d}\nDTEND:${d}\nRRULE:FREQ=DAILY;COUNT=99999;UNTIL=${d}\nEND:VEVENT`), 'END:VCALENDAR'].join('\n'));
  await T('ics: TZID of 10,000 letters and of a zone that does not exist', `BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:z\nDTSTART;TZID=${'z'.repeat(10_000)}:20261012T140000\nDTEND;TZID=Mars/Olympus:20261012T150000\nEND:VEVENT\nEND:VCALENDAR\n`);
  await T('ics: X-TOMLINOS-REMIND and PROJECT with nonsense', 'BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:r\nDTSTART:20261012\nX-TOMLINOS-REMIND:1e400\nX-TOMLINOS-PROJECT:../../x\nRECURRENCE-ID:' + 'x'.repeat(100_000) + '\nEND:VEVENT\nEND:VCALENDAR\n');
  report(t, 'parseIcs');
});

test('contacts reader (.vcf): any text at all is read', async () => {
  const t = await fuzzText('vcf', 'parseVcf', VCF_SEED);
  const T = (label: string, input: string) => pool.run(t, label, 'parseVcf', input);
  await T('vcf: 100,000 TEL lines on one card', 'BEGIN:VCARD\n' + 'TEL:1\n'.repeat(100_000) + 'END:VCARD\n');
  await T('vcf: N with 100,000 parts and backslashes', 'BEGIN:VCARD\nN:' + 'a\\;b;'.repeat(100_000) + '\nEND:VCARD\n');
  await T('vcf: a card inside a card inside a card', 'BEGIN:VCARD\nFN:a\nBEGIN:VCARD\nFN:b\nEND:VCARD\nEND:VCARD\nEND:VCARD\n');
  await T('vcf: a parameter with an unclosed quote running to the end of the file', 'BEGIN:VCARD\nTEL;TYPE="cell:1\nFN:a\nEND:VCARD\n' + 'X:y\n'.repeat(100_000));
  await T('vcf: BDAY in every wrong shape', ['BEGIN:VCARD', 'FN:x', 'BDAY:--0229', 'BDAY:19900230', 'BDAY:1990-13-45', 'BDAY:19900101T000000Z', 'BDAY:1e9', 'BDAY:00000000', 'END:VCARD', ''].join('\n'));
  report(t, 'parseVcf');
});

test('calendar and contacts: what is read is never silently something else', () => {
  // A NOTE with a doubled backslash, a literal "\n" (backslash n) and a semicolon must come back as typed.
  const [c] = parseVcf('BEGIN:VCARD\nFN:x\nNOTE:back\\\\slash then \\\\n is not a break\\; semi\\, comma\nEND:VCARD\n');
  assert.equal(c.notes, 'back\\slash then \\n is not a break; semi, comma');
  const [e] = parseIcs('BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:a\nDTSTART:20260101\nSUMMARY:a\\\\b\\nc\\;d\\,e\\Nf\nEND:VEVENT\nEND:VCALENDAR\n');
  assert.equal(e.title, 'a\\b\nc;d,e\nf');
  // The content-line splitter: a quoted parameter holding a colon must not move the value's start.
  const [line] = readLines('ATTENDEE;CN="Ann: Lee";X=1:mailto:a@b.c');
  assert.equal(line.value, 'mailto:a@b.c');
  assert.equal(line.params.CN, 'Ann: Lee');
});

test('the Projects file (parseProjects): damaged JSON is read or refused by name', async () => {
  const t = await fuzzText('projects', 'parseProjects', PROJECTS_SEED);
  const T = (label: string, input: string) => pool.run(t, label, 'parseProjects', input);
  await T('projects: 100,000 records with the same uid', `[${'{"uid":"a","name":"x"},'.repeat(100_000)}{"uid":"a","name":"x"}]`);
  await T('projects: records with every wrong type', JSON.stringify([null, 7, 'x', [], { uid: 7 }, { uid: 'a'.repeat(65), name: 'x' }, { uid: '../x', name: 'x' }, { uid: 'ok', name: '   ' }, { uid: 'ok2', name: 'x'.repeat(10_000), site: 7, notes: null, focus: 'yes', finished: 1, created: '7' }, { uid: 'ok3', name: 'y', created: 1e400 }]));
  report(t, 'parseProjects');
});

// ---- Mail --------------------------------------------------------------------------------------------------------------------

const badAddress = (i: number) => ['"', '<', '>', '(', ')', ',', ';', ':', '@', '\\', '=?UTF-8?B?', '?=', 'a@b', 'Team: a@b;', '"a" <', '<a@b', 'a@', '@b', '"\\"', '😀'][i % 20].repeat(1 + (i % 7));

test('mail reader (MIME): damaged messages are read (there is nothing to refuse)', async () => {
  const t = await fuzzBytes('mail', 'parseMessage', enc(MAIL_SEED));
  const T = (label: string, input: string) => pool.run(t, label, 'parseMessage', enc(input));
  await T('mail: 13 nested multiparts and 1,000 parts', Array.from({ length: 13 }, (_, i) => `Content-Type: multipart/mixed; boundary="b${i}"\r\n\r\n--b${i}\r\n`).join('') + 'Content-Type: text/plain\r\n\r\nx\r\n' + Array.from({ length: 1000 }, () => '--b12\r\nContent-Type: text/plain\r\n\r\ny\r\n').join(''));
  await T('mail: a boundary of regex characters and a boundary 10,000 long', 'Content-Type: multipart/mixed; boundary="(.*)+$^[a-z]{1,9}\\"\r\n\r\n--(.*)+$^[a-z]{1,9}\\\r\nContent-Type: text/plain\r\n\r\nhi\r\n--(.*)+$^[a-z]{1,9}\\--\r\n' + `Content-Type: multipart/mixed; boundary="${'b'.repeat(10_000)}"\r\n\r\n`);
  await T('mail: an empty boundary and a boundary of spaces', 'Content-Type: multipart/mixed; boundary=""\r\n\r\n--\r\nx\r\n----\r\n' + 'Content-Type: multipart/mixed; boundary="   "\r\n\r\n--   \r\n');
  await T('mail: 2 MB of header continuation lines', 'Subject: x\r\n' + ' y\r\n'.repeat(700_000) + '\r\nbody');
  await T('mail: 100,000 encoded words in a subject', 'Subject: ' + '=?UTF-8?B?eA==?= '.repeat(100_000) + '\r\n\r\n');
  await T('mail: encoded words with charsets that do not exist and bad base64', 'Subject: =?x-nope?B?!!!!?= =?UTF-8?Q?=ZZ=?= =?utf-7?B?+AGE-?= =?UTF-8*en?Q?hi?= =??B??=\r\nFrom: =?UTF-8?B?PGE+?= <<<a@b>>, "unclosed <x@y\r\n\r\n');
  await T('mail: quoted-printable with every bad shape; base64 of 2 MB with no padding', 'Content-Type: text/plain\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n=\r\n=Z=ZZ==\r\n=F0=9F\r\n=\r\n' + 'Content-Transfer-Encoding: base64\r\n\r\n' + 'QUJD'.repeat(500_000) + 'Q');
  await T('mail: a charset of 10,000 letters', `Content-Type: text/plain; charset="${'x'.repeat(10_000)}"\r\n\r\nhi`);
  await pool.run(t, 'mail: 2,000 addresses with every bad shape', 'parseAddresses', Array.from({ length: 2000 }, (_, i) => badAddress(i)).join(', '));
  await pool.run(t, 'mail: a summary from 1 MB of header lines', 'mailSummary', 'X: y\r\n'.repeat(200_000));
  await pool.run(t, 'mail: decodeWords on 1 MB of =?', 'decodeWords', '=?'.repeat(500_000));
  report(t, 'parseMessage');
});

// ---- PDF ---------------------------------------------------------------------------------------------------------------------

test('PDF reader: damaged files are opened or refused by name', async () => {
  const t = await fuzzBytes('pdf', 'openPdf', pdfSeed());
  const T = (label: string, input: Uint8Array) => pool.run(t, label, 'openPdf', input);
  await T('pdf: pages tree that refers to itself', pdfOf('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [2 0 R 2 0 R] /Count 1 >>\nendobj'));
  await T('pdf: a chain of 1,000 references to references', pdfOf('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' + Array.from({ length: 1000 }, (_, i) => `${i + 2} 0 obj\n${i + 3} 0 R\nendobj`).join('\n')));
  await T('pdf: /Count of 1e9 and a Kids list of 100,000 missing pages', pdfOf(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [${'9 0 R '.repeat(100_000)}] /Count 1000000000 >>\nendobj`));
  await T('pdf: 10,000 nested arrays', pdfOf(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R /X ${nested('[', ']', 10_000)} >>\nendobj`));
  await T('pdf: a stream with /Length 1e9 and one with a negative length', pdfOf('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R /MediaBox [0 0 1e308 -1e308] >>\nendobj\n4 0 obj\n<< /Length 1000000000 /Filter /FlateDecode >>\nstream\nxxxx\nendstream\nendobj\n5 0 obj\n<< /Length -5 >>\nstream\nxxxx\nendstream\nendobj'));
  const z = deflateSync(Buffer.alloc(100 * 1024 * 1024));
  await T('pdf: a flate stream that unpacks to 100 MB of zeros', cat(`%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Length ${z.length} /Filter /FlateDecode >>\nstream\n`, z, '\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n'));
  await T('pdf: filters that chain 1,000 deep', pdfOf(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n4 0 obj\n<< /Length 4 /Filter [${'/FlateDecode '.repeat(1000)}] >>\nstream\nxxxx\nendstream\nendobj`));
  await T('pdf: a name of 1 MB and a string never closed', pdfOf(`1 0 obj\n<< /Type /Catalog /${'n'.repeat(1_000_000)} (never closed`));
  await T('pdf: a hex string of 2 MB of odd characters', pdfOf(`1 0 obj\n<< /Type /Catalog /X <${'zz '.repeat(700_000)}> >>\nendobj`));
  await T('pdf: object numbers of 10 digits and generation 99999', pdfOf('9999999999 99999 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n1 0 obj\n<< /Type /Catalog /Pages 9999999999 99999 R >>\nendobj'));
  await T('pdf: 400,001 tiny objects', pdfOf('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' + '7 0 obj 1 endobj\n'.repeat(400_001)));
  report(t, 'PdfDocument.open');
});

// ---- Photo Editor (.ora) ---------------------------------------------------------------------------------------------------------

test('OpenRaster reader (.ora): damaged files are opened or refused by name', async () => {
  const t = await fuzzBytes('ora', 'openOraAll', oraSeed());
  const T = (label: string, input: Uint8Array) => pool.run(t, label, 'openOraAll', input);
  await T('ora: a picture 1e9 by 1e9 with a layer at NaN', oraOf('<image w="1000000000" h="1e9"><stack><layer name="a" src="data/l.png" x="NaN" y="-1e308" opacity="7"/></stack></image>'));
  await T('ora: 200 layers; a layer whose src climbs out; a stack 10,000 deep', oraOf(`<image w="1" h="1"><stack>${'<layer name="a" src="data/l.png"/>'.repeat(200)}<layer name="b" src="../../../etc/passwd"/>${nested('<stack>', '</stack>', 10_000)}</stack></image>`));
  const bigPng = PNG.slice();
  bigPng.set([0, 1, 0x86, 0xa0], 16);
  bigPng.set([0, 1, 0x86, 0xa0], 20);
  await T('ora: a layer PNG that says it is 100,000 by 100,000', oraOf('<image w="1" h="1"><stack><layer name="a" src="data/big.png"/></stack></image>', { 'data/big.png': bigPng }));
  await T('ora: a text layer whose JSON is 1 MB and a mask pointing at the stack itself', oraOf(`<image w="1" h="1" xmlns:tomlinos="urn:tomlinos:openraster:1"><stack><layer name="a" src="data/l.png" tomlinos:text='${JSON.stringify({ text: 'x'.repeat(1_000_000), family: 'f', size: 1e308 }).replace(/'/g, '&apos;')}' tomlinos:mask="stack.xml" tomlinos:unmasked="mimetype"/></stack></image>`));
  await T('ora: stack.xml of 2 MB', oraOf(`<image w="1" h="1"><stack><layer name="${'n'.repeat(2_000_000)}" src="data/l.png"/></stack></image>`));
  await pool.run(t, 'ora: readStack with no size, a composite-op of nonsense, visibility of nonsense', 'readStack', '<image><stack><layer name="a" src="x" composite-op="svg:nope" visibility="maybe" opacity="x" edit-locked="7"/></stack></image>');
  report(t, 'openOra');
});

// ---- The harness itself -----------------------------------------------------------------------------------------------------------

test('the harness catches a hang and runaway memory (so the readers above are really being checked)', async () => {
  const t = newTame();
  await pool.run(t, 'a reader that sleeps past the budget', 'sleep', String(2500));
  await pool.run(t, 'a reader that fills memory', 'hog', '');
  assert.equal(t.bad.length, 2, t.bad.join('\n'));
  assert.match(t.bad[0], /took \d+ ms/);
  assert.match(t.bad[1], /thread (stopped|crashed)|still running/);
  // And the pool is still usable afterwards.
  await pool.run(t, 'xml after the crash', 'parseXml', '<a/>');
  assert.equal(t.ok, 1);
});
