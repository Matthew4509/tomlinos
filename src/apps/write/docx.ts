// Word documents (.docx) for TOMLIN Write: a writer that turns the editor's document into the parts Word, LibreOffice
// and Google Docs read, and a reader that turns a .docx (ours or anyone's) back into the editor's document. A .docx is a
// zip of XML parts; zip.ts packs it and archive/read.ts unpacks it, xml.ts reads and writes the XML. Our own code; no
// browser needed except to keep the pictures (images.ts).
//
// Units: Word measures spacing, indents and the page in twentieths of a point ("twips"), type in half-points and
// pictures in EMU (914,400 to the inch). The editor measures spacing in points and pictures in screen pixels.
// The reader keeps what the editor can show and lists what it left out (text boxes, comments, footnotes...), so the
// window can say so and ask before saving over the file.
import { ArchiveError, readZip } from '../archive/read.ts';
import { child, children, escapeAttr, escapeXml, parseXml, XML_HEAD, XmlProblem, type XmlEl } from '../../core/xml.ts';
import { zipDeflate, type ZipEntry } from '../../core/zip.ts';
import { addPicture, EXTENSION, picture, type Picture } from './images.ts';
import {
  cleanPage, defaultPage, PAPERS, PX_PER_IN, STYLES, type HeaderLine, type MarkJSON, type NodeJSON, type PageSetup, type Paper, type StyleId,
} from './model.ts';

export class DocxProblem extends Error {}

/** A .docx bigger than this once unpacked is refused (a small zip can unpack to gigabytes). */
const MAX_UNPACKED = 200 * 1024 * 1024;

const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  rel: 'http://schemas.openxmlformats.org/package/2006/relationships',
  ct: 'http://schemas.openxmlformats.org/package/2006/content-types',
};
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const twips = (pt: number): number => Math.round(pt * 20);
const pxToTwips = (px: number): number => Math.round(px * 15);
const EMU_PER_PX = 9525;

/** Word's highlight colours by name (a highlight in any other colour is saved as shading). */
const HIGHLIGHTS: Record<string, string> = {
  yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff', magenta: '#ff00ff', blue: '#0000ff', red: '#ff0000', darkBlue: '#000080',
  darkCyan: '#008080', darkGreen: '#008000', darkMagenta: '#800080', darkRed: '#800000', darkYellow: '#808000', darkGray: '#808080',
  lightGray: '#c0c0c0', black: '#000000', white: '#ffffff',
};

/** Characters XML 1.0 cannot hold (controls other than tab and line breaks) are left out. */
const xmlSafe = (s: string): string => s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');

// ---- Writing ---------------------------------------------------------------------------------------------------------

const BULLETS = ['•', 'o', '▪'];
const ORDER_FORMATS = ['decimal', 'lowerLetter', 'lowerRoman'];

/** Our two list definitions (bullets, numbers) and one numbering per list, with ids from `abs` and `bulletNum` up. */
function numberingParts(ordered: Array<{ numId: number; start: number }>, abs: number, bulletNum: number): { abstracts: string; nums: string } {
  const lvl = (i: number, bullet: boolean) => {
    const left = 720 * (i + 1);
    const text = bullet ? BULLETS[i % 3] : `%${i + 1}.`;
    // The second level's "o" is Courier New's, as in Word's own bullets.
    const font = bullet && i % 3 === 1 ? '<w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New" w:hint="default"/></w:rPr>' : '';
    return `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${bullet ? 'bullet' : ORDER_FORMATS[i % 3]}"/><w:lvlText w:val="${escapeAttr(text)}"/><w:lvlJc w:val="${bullet || i % 3 !== 2 ? 'left' : 'right'}"/><w:pPr><w:ind w:left="${left}" w:hanging="360"/></w:pPr>${font}</w:lvl>`;
  };
  const levels = (bullet: boolean) => Array.from({ length: 9 }, (_, i) => lvl(i, bullet)).join('');
  const abstracts = `<w:abstractNum w:abstractNumId="${abs}"><w:multiLevelType w:val="hybridMultilevel"/>${levels(true)}</w:abstractNum>`
    + `<w:abstractNum w:abstractNumId="${abs + 1}"><w:multiLevelType w:val="hybridMultilevel"/>${levels(false)}</w:abstractNum>`;
  let out = `<w:num w:numId="${bulletNum}"><w:abstractNumId w:val="${abs}"/></w:num>`;
  for (const o of ordered) {
    out += `<w:num w:numId="${o.numId}"><w:abstractNumId w:val="${abs + 1}"/>`;
    // Each numbered list starts again from its own first number (9 levels, so a list inside it restarts too).
    for (let i = 0; i < 9; i++) out += `<w:lvlOverride w:ilvl="${i}"><w:startOverride w:val="${i === 0 ? o.start : 1}"/></w:lvlOverride>`;
    out += '</w:num>';
  }
  return { abstracts, nums: out };
}

function numberingXml(ordered: Array<{ numId: number; start: number }>): string {
  const parts = numberingParts(ordered, 0, 1);
  return `${XML_HEAD}<w:numbering xmlns:w="${NS.w}">${parts.abstracts}${parts.nums}</w:numbering>`;
}

/** The ids of the styles Write writes (and replaces in a file it opened, so the text looks as Write showed it). */
const OUR_STYLE_IDS = ['Normal', 'Title', 'Heading1', 'Heading2', 'Heading3', 'ListParagraph', 'Header', 'Footer', 'TableNormal', 'TableGrid', 'FootnoteText', 'FootnoteReference', 'TOCHeading', 'TOC1', 'TOC2', 'TOC3'];

function stylesXml(): string {
  return `${XML_HEAD}<w:styles xmlns:w="${NS.w}">` + docDefaults() + ourStyles() + '</w:styles>';
}

function docDefaults(): string {
  const n = STYLES.normal;
  return ''
    + `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${n.face}" w:eastAsia="${n.face}" w:hAnsi="${n.face}" w:cs="${n.face}"/><w:sz w:val="${n.size * 2}"/><w:szCs w:val="${n.size * 2}"/><w:lang w:val="en-GB" w:eastAsia="en-US" w:bidi="ar-SA"/></w:rPr></w:rPrDefault>`
    + `<w:pPrDefault><w:pPr><w:spacing w:after="${twips(n.after)}" w:line="${Math.round(n.line * 240)}" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>`;
}

function ourStyles(): string {
  const para = (id: StyleId, outline: number | null) => {
    const s = STYLES[id];
    const rpr = `<w:rPr><w:rFonts w:ascii="${s.face}" w:hAnsi="${s.face}" w:cs="${s.face}"/>${s.bold ? '<w:b/>' : ''}${s.colour ? `<w:color w:val="${s.colour.slice(1).toUpperCase()}"/>` : ''}<w:sz w:val="${s.size * 2}"/><w:szCs w:val="${s.size * 2}"/></w:rPr>`;
    const ppr = `<w:pPr>${outline !== null ? '<w:keepNext/><w:keepLines/>' : ''}<w:spacing w:before="${twips(s.before)}" w:after="${twips(s.after)}" w:line="${Math.round(s.line * 240)}" w:lineRule="auto"/>${outline !== null ? `<w:outlineLvl w:val="${outline}"/>` : ''}${id === 'title' ? '<w:contextualSpacing/>' : ''}</w:pPr>`;
    return `<w:style w:type="paragraph"${id === 'normal' ? ' w:default="1"' : ''} w:styleId="${s.wordId}"><w:name w:val="${s.wordName}"/>${id === 'normal' ? '' : '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/>'}<w:qFormat/>${ppr}${rpr}</w:style>`;
  };
  return ''
    + para('normal', null) + para('title', null) + para('h1', 0) + para('h2', 1) + para('h3', 2)
    + '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/><w:pPr><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Header"><w:name w:val="header"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Footer"><w:name w:val="footer"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr></w:style>'
    + '<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>'
    + '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:uiPriority w:val="39"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders>'
    + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(s => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`).join('')
    + '</w:tblBorders></w:tblPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="FootnoteText"><w:name w:val="footnote text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>'
    + '<w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>'
    + `<w:style w:type="paragraph" w:styleId="TOCHeading"><w:name w:val="TOC Heading"/><w:basedOn w:val="Heading1"/><w:next w:val="Normal"/><w:pPr><w:outlineLvl w:val="9"/></w:pPr></w:style>`
    + [1, 2, 3].map(n => `<w:style w:type="paragraph" w:styleId="TOC${n}"><w:name w:val="toc ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:spacing w:after="100"/>${n > 1 ? `<w:ind w:left="${(n - 1) * 220}"/>` : ''}</w:pPr></w:style>`).join('');
}


/** A merge field's name as Word takes it: letters, digits and _ - . (anything else becomes _). */
export const fieldName = (name: string): string => name.trim().replace(/[^\p{L}\p{N}_.\-]/gu, '_').slice(0, 40);

/** The document's headings (Heading 1 to 3, in order), for the contents page. */
export function headingsOf(doc: NodeJSON): Array<{ level: number; text: string }> {
  const out: Array<{ level: number; text: string }> = [];
  const walk = (n: NodeJSON) => {
    if (n.type === 'paragraph') {
      const style = n.attrs?.style;
      if (style === 'h1' || style === 'h2' || style === 'h3') {
        const text = (n.content ?? []).map(c => (c.type === 'text' ? c.text ?? '' : '')).join('').trim();
        if (text) out.push({ level: Number(String(style).slice(1)), text });
      }
      return;
    }
    if (n.type === 'table') return;
    for (const c of n.content ?? []) walk(c);
  };
  walk(doc);
  return out;
}

/** A contents page as Word writes one: a TOC field holding its last result (each heading, a dotted tab, its page). */
function tocXml(node: NodeJSON, ctx: WriteCtx): string {
  const heads = headingsOf({ type: 'doc', content: ctx.allBlocks });
  const right = Math.round(ctx.bodyPx * 15);
  const title = String(node.attrs?.title ?? 'Contents');
  let out = '<w:sdt><w:sdtPr><w:docPartObj><w:docPartGallery w:val="Table of Contents"/><w:docPartUnique/></w:docPartObj></w:sdtPr><w:sdtContent>';
  out += `<w:p><w:pPr><w:pStyle w:val="TOCHeading"/></w:pPr><w:r><w:t>${escapeXml(xmlSafe(title))}</w:t></w:r></w:p>`;
  const begin = '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>';
  if (!heads.length) out += `<w:p>${begin}<w:r><w:t>No headings yet: give some paragraphs the Heading 1, 2 or 3 style.</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`;
  heads.forEach((head, i) => {
    const pageNo = ctx.headingPages[i];
    out += `<w:p><w:pPr><w:pStyle w:val="TOC${head.level}"/><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="${right}"/></w:tabs></w:pPr>${i === 0 ? begin : ''}`
      + `<w:r><w:t xml:space="preserve">${escapeXml(xmlSafe(head.text))}</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>${pageNo ? pageNo : ''}</w:t></w:r>`
      + `${i === heads.length - 1 ? '<w:r><w:fldChar w:fldCharType="end"/></w:r>' : ''}</w:p>`;
  });
  return `${out}</w:sdtContent></w:sdt>`;
}

/** The footnotes part: Word's two separators, then each note. `kept` is a file's own footnotes part to add them to. */
function footnotesXml(notes: Array<{ id: number; text: string }>, kept: string | null): string {
  const one = (n: { id: number; text: string }) => `<w:footnote w:id="${n.id}"><w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> ${escapeXml(xmlSafe(n.text))}</w:t></w:r></w:p></w:footnote>`;
  if (kept && /<\/w:footnotes>\s*$/.test(kept)) return kept.replace(/<\/w:footnotes>\s*$/, `${notes.map(one).join('')}</w:footnotes>`);
  const sep = (type: string, id: number, mark: string) => `<w:footnote w:type="${type}" w:id="${id}"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:${mark}/></w:r></w:p></w:footnote>`;
  return `${XML_HEAD}<w:footnotes xmlns:w="${NS.w}" xmlns:r="${NS.r}">${sep('separator', -1, 'separator')}${sep('continuationSeparator', 0, 'continuationSeparator')}${notes.map(one).join('')}</w:footnotes>`;
}

interface WriteCtx {
  page: PageSetup;
  /** Picture id to its relationship id and file name, each picture kept once. */
  media: Map<string, { rid: string; name: string; pic: Picture }>;
  ordered: Array<{ numId: number; start: number }>;
  nextNum: number;
  /** The numbering every bulleted list uses. */
  bulletNum: number;
  /** How new pictures are named inside the file (a prefix of its own when the file already has pictures). */
  mediaPrefix: string;
  drawingId: number;
  /** Footnotes written so far: new ones get the next number; one read from the file and unchanged keeps its own. */
  notes: Array<{ id: number; text: string }>;
  nextNote: number;
  keptNotes: Map<number, string>;
  /** The page each heading is on (in the order of the headings), for the contents page. */
  headingPages: number[];
  /** The whole document's blocks (the contents page lists every heading in it). */
  allBlocks: NodeJSON[];
  /** Width of the writing area, in pixels (a picture or table is never made wider). */
  bodyPx: number;
}

function runProps(marks: MarkJSON[] | undefined): string {
  if (!marks?.length) return '';
  const has = (t: string) => marks.find(m => m.type === t);
  let out = '';
  const font = has('font')?.attrs?.face as string | undefined;
  if (font) out += `<w:rFonts w:ascii="${escapeAttr(font)}" w:hAnsi="${escapeAttr(font)}" w:cs="${escapeAttr(font)}"/>`;
  if (has('strong')) out += '<w:b/><w:bCs/>';
  if (has('em')) out += '<w:i/><w:iCs/>';
  if (has('strike')) out += '<w:strike/>';
  const colour = has('color')?.attrs?.value as string | undefined;
  if (colour && /^#[0-9a-f]{6}$/i.test(colour)) out += `<w:color w:val="${colour.slice(1).toUpperCase()}"/>`;
  const pt = has('size')?.attrs?.pt as number | undefined;
  if (typeof pt === 'number' && pt > 0) out += `<w:sz w:val="${Math.round(pt * 2)}"/><w:szCs w:val="${Math.round(pt * 2)}"/>`;
  const hl = has('highlight')?.attrs?.value as string | undefined;
  let shd = '';
  if (hl && /^#[0-9a-f]{6}$/i.test(hl)) {
    const name = Object.keys(HIGHLIGHTS).find(k => HIGHLIGHTS[k] === hl.toLowerCase());
    if (name) out += `<w:highlight w:val="${name}"/>`;
    else shd = `<w:shd w:val="clear" w:color="auto" w:fill="${hl.slice(1).toUpperCase()}"/>`;
  }
  if (has('underline')) out += '<w:u w:val="single"/>';
  out += shd;
  const vert = has('vert')?.attrs?.pos;
  if (vert) out += `<w:vertAlign w:val="${vert === 'sub' ? 'subscript' : 'superscript'}"/>`;
  return out ? `<w:rPr>${out}</w:rPr>` : '';
}

function pictureRun(node: NodeJSON, ctx: WriteCtx): string {
  const id = String(node.attrs?.src ?? '');
  const pic = picture(id);
  if (!pic) return '';
  let media = ctx.media.get(id);
  if (!media) {
    media = { rid: `rId${ctx.mediaPrefix}Img${ctx.media.size + 1}`, name: `${ctx.mediaPrefix.toLowerCase()}image${ctx.media.size + 1}.${EXTENSION[pic.type]}`, pic };
    ctx.media.set(id, media);
  }
  let w = Number(node.attrs?.width) || pic.w;
  let h = Number(node.attrs?.height) || (w * pic.h) / pic.w;
  if (w > ctx.bodyPx) {
    h = (h * ctx.bodyPx) / w;
    w = ctx.bodyPx;
  }
  const cx = Math.round(w * EMU_PER_PX);
  const cy = Math.round(h * EMU_PER_PX);
  const n = ++ctx.drawingId;
  const alt = escapeAttr(xmlSafe(String(node.attrs?.alt ?? '')));
  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>`
    + `<wp:docPr id="${n}" name="Picture ${n}" descr="${alt}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>`
    + `<a:graphic><a:graphicData uri="${NS.pic}"><pic:pic><pic:nvPicPr><pic:cNvPr id="${n}" name="${media.name}" descr="${alt}"/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill><a:blip r:embed="${media.rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}

function inlineXml(nodes: NodeJSON[] | undefined, ctx: WriteCtx): string {
  let out = '';
  for (const n of nodes ?? []) {
    if (n.type === 'text') {
      const rpr = runProps(n.marks);
      // A tab is a w:tab of its own; a line break inside text never happens (Shift+Enter makes a hard_break node).
      const parts = xmlSafe(n.text ?? '').split('\t');
      out += `<w:r>${rpr}${parts.map((p, i) => (i ? '<w:tab/>' : '') + (p ? `<w:t xml:space="preserve">${escapeXml(p)}</w:t>` : '')).join('')}</w:r>`;
    } else if (n.type === 'hard_break') {
      out += '<w:r><w:br/></w:r>';
    } else if (n.type === 'footnote') {
      const textNow = String(n.attrs?.text ?? '');
      const was = Number(n.attrs?.id) || 0;
      // A footnote from the file, unchanged, points at its own note there (with its own formatting); any other is new.
      let id = was && ctx.keptNotes.get(was) === textNow ? was : 0;
      if (!id) {
        id = ctx.nextNote++;
        ctx.notes.push({ id, text: textNow });
      }
      out += `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="${id}"/></w:r>`;
    } else if (n.type === 'field') {
      const name = fieldName(String(n.attrs?.name ?? ''));
      if (name) out += `<w:fldSimple w:instr=" MERGEFIELD ${name} "><w:r>${runProps(n.marks)}<w:t>${escapeXml(`«${name}»`)}</w:t></w:r></w:fldSimple>`;
    } else if (n.type === 'opaque_inline') {
      out += String(n.attrs?.xml ?? '');
    } else if (n.type === 'image') {
      out += pictureRun(n, ctx);
    }
  }
  return out;
}

/** A paragraph; `list` puts it in a list at a level (numId 0: inside a list item but not its first line). */
function paragraphXml(p: NodeJSON, ctx: WriteCtx, list?: { numId: number; level: number }): string {
  const a = p.attrs ?? {};
  const style = (STYLES[a.style as StyleId] ? a.style : 'normal') as StyleId;
  let ppr = '';
  const listStyle = list && style === 'normal';
  if (style !== 'normal') ppr += `<w:pStyle w:val="${STYLES[style].wordId}"/>`;
  else if (listStyle) ppr += '<w:pStyle w:val="ListParagraph"/>';
  if (list && list.numId) ppr += `<w:numPr><w:ilvl w:val="${list.level}"/><w:numId w:val="${list.numId}"/></w:numPr>`;
  const sp: string[] = [];
  if (typeof a.before === 'number') sp.push(`w:before="${twips(a.before)}"`);
  if (typeof a.after === 'number') sp.push(`w:after="${twips(a.after)}"`);
  if (typeof a.line === 'number') sp.push(`w:line="${Math.round(a.line * 240)}" w:lineRule="auto"`);
  if (sp.length) ppr += `<w:spacing ${sp.join(' ')}/>`;
  if (list && !list.numId) ppr += `<w:ind w:left="${720 * (list.level + 1)}"/>`;
  else if (!list && (typeof a.indent === 'number' || typeof a.first === 'number')) {
    const first = typeof a.first === 'number' ? a.first : 0;
    ppr += `<w:ind w:left="${twips(typeof a.indent === 'number' ? a.indent : 0)}"${first > 0 ? ` w:firstLine="${twips(first)}"` : first < 0 ? ` w:hanging="${twips(-first)}"` : ''}/>`;
  }
  if (a.align === 'center' || a.align === 'right' || a.align === 'justify') ppr += `<w:jc w:val="${a.align === 'justify' ? 'both' : a.align}"/>`;
  return `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}${inlineXml(p.content, ctx)}</w:p>`;
}

function listXml(list: NodeJSON, ctx: WriteCtx, level: number): string {
  let numId = ctx.bulletNum;
  if (list.type === 'ordered_list') {
    numId = ctx.nextNum++;
    ctx.ordered.push({ numId, start: Math.max(1, Number(list.attrs?.order) || 1) });
  }
  let out = '';
  for (const item of list.content ?? []) {
    let first = true;
    for (const block of item.content ?? []) {
      if (block.type === 'paragraph') {
        out += paragraphXml(block, ctx, { numId: first ? numId : 0, level });
        first = false;
      } else if (block.type === 'bullet_list' || block.type === 'ordered_list') out += listXml(block, ctx, Math.min(8, level + 1));
      else out += blocksXml([block], ctx);
    }
  }
  return out;
}

/** The grid of a table: for each row, each cell's first column (rows spanned from above taken into account). */
function tableGrid(table: NodeJSON): { cols: number; starts: number[][] } {
  const rows = table.content ?? [];
  const taken: number[][] = rows.map(() => []);
  const starts: number[][] = [];
  let cols = 0;
  rows.forEach((row, r) => {
    let c = 0;
    starts.push([]);
    for (const cell of row.content ?? []) {
      while (taken[r].includes(c)) c++;
      starts[r].push(c);
      const span = Math.max(1, Number(cell.attrs?.colspan) || 1);
      const down = Math.max(1, Number(cell.attrs?.rowspan) || 1);
      for (let rr = r; rr < Math.min(rows.length, r + down); rr++) for (let k = 0; k < span; k++) taken[rr].push(c + k);
      c += span;
    }
    cols = Math.max(cols, c, ...taken[r].map(x => x + 1));
  });
  return { cols, starts };
}

function tableXml(table: NodeJSON, ctx: WriteCtx): string {
  const rows = table.content ?? [];
  const { cols, starts } = tableGrid(table);
  if (!cols) return '';
  // Column widths: from the cells that have them, the rest sharing what is left of the writing area.
  const widths: Array<number | null> = Array(cols).fill(null);
  rows.forEach((row, r) => (row.content ?? []).forEach((cell, i) => {
    const cw = cell.attrs?.colwidth;
    if (Array.isArray(cw)) cw.forEach((w, k) => {
      if (typeof w === 'number' && w > 0 && widths[starts[r][i] + k] === null) widths[starts[r][i] + k] = w;
    });
  }));
  const known = widths.reduce<number>((s, w) => s + (w ?? 0), 0);
  const unknown = widths.filter(w => w === null).length;
  const share = unknown ? Math.max(40, (ctx.bodyPx - known) / unknown) : 0;
  const px = widths.map(w => w ?? share);
  const borders = table.attrs?.borders !== false;
  let out = `<w:tbl><w:tblPr>${borders ? '<w:tblStyle w:val="TableGrid"/>' : ''}<w:tblW w:w="0" w:type="auto"/><w:tblLayout w:type="fixed"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>`;
  out += `<w:tblGrid>${px.map(w => `<w:gridCol w:w="${pxToTwips(w)}"/>`).join('')}</w:tblGrid>`;
  // Cells spanning rows: Word writes the first and marks the cells below it as continuing it.
  const below = new Map<string, NodeJSON>();
  rows.forEach((row, r) => {
    out += '<w:tr>';
    const cells = row.content ?? [];
    const items: Array<{ col: number; xml: string }> = [];
    cells.forEach((cell, i) => {
      const col = starts[r][i];
      const span = Math.max(1, Number(cell.attrs?.colspan) || 1);
      const down = Math.max(1, Number(cell.attrs?.rowspan) || 1);
      for (let rr = r + 1; rr < Math.min(rows.length, r + down); rr++) below.set(`${rr}:${col}`, cell);
      items.push({ col, xml: cellXml(cell, ctx, px, col, span, down > 1 ? 'restart' : null) });
    });
    for (const [key, cell] of below) {
      const [rr, col] = key.split(':').map(Number);
      if (rr !== r) continue;
      const span = Math.max(1, Number(cell.attrs?.colspan) || 1);
      items.push({ col, xml: cellXml({ type: 'table_cell', attrs: cell.attrs, content: [{ type: 'paragraph' }] }, ctx, px, col, span, 'continue') });
    }
    items.sort((x, y) => x.col - y.col);
    out += items.map(x => x.xml).join('') + '</w:tr>';
  });
  return out + '</w:tbl>';
}

function cellXml(cell: NodeJSON, ctx: WriteCtx, px: number[], col: number, span: number, merge: 'restart' | 'continue' | null): string {
  const width = px.slice(col, col + span).reduce((s, w) => s + w, 0);
  let tcpr = `<w:tcW w:w="${pxToTwips(width)}" w:type="dxa"/>`;
  if (span > 1) tcpr += `<w:gridSpan w:val="${span}"/>`;
  if (merge === 'restart') tcpr += '<w:vMerge w:val="restart"/>';
  else if (merge === 'continue') tcpr += '<w:vMerge/>';
  const fill = cell.attrs?.background;
  if (typeof fill === 'string' && /^#[0-9a-f]{6}$/i.test(fill)) tcpr += `<w:shd w:val="clear" w:color="auto" w:fill="${fill.slice(1).toUpperCase()}"/>`;
  const inner = { ...ctx, bodyPx: Math.max(20, width - 14) };
  let body = blocksXml(cell.content ?? [], inner);
  ctx.drawingId = inner.drawingId;
  ctx.nextNum = inner.nextNum;
  ctx.nextNote = inner.nextNote;
  // A cell must end with a paragraph in Word.
  if (!body.endsWith('</w:p>')) body += '<w:p/>';
  return `<w:tc><w:tcPr>${tcpr}</w:tcPr>${body}</w:tc>`;
}

function blocksXml(blocks: NodeJSON[], ctx: WriteCtx): string {
  let out = '';
  for (const b of blocks) {
    if (b.type === 'paragraph') out += paragraphXml(b, ctx);
    else if (b.type === 'bullet_list' || b.type === 'ordered_list') out += listXml(b, ctx, 0);
    else if (b.type === 'table') out += tableXml(b, ctx);
    else if (b.type === 'page_break') out += '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
    else if (b.type === 'opaque_block') out += String(b.attrs?.xml ?? '');
    else if (b.type === 'toc') out += tocXml(b, ctx);
  }
  return out;
}

/** A header or footer part: left, then a tab to the centre, then a tab to the right edge; &P and &N become Word's fields. */
function headerXml(kind: 'hdr' | 'ftr', line: HeaderLine, bodyTwips: number): string {
  const field = (text: string) => {
    let out = '';
    const parts = text.split(/(&[PN&])/i);
    for (const part of parts) {
      if (!part) continue;
      if (/^&[PN]$/i.test(part)) {
        const name = part[1].toUpperCase() === 'P' ? 'PAGE' : 'NUMPAGES';
        out += `<w:fldSimple w:instr=" ${name} "><w:r><w:t>1</w:t></w:r></w:fldSimple>`;
      } else out += `<w:r><w:t xml:space="preserve">${escapeXml(xmlSafe(part === '&&' ? '&' : part))}</w:t></w:r>`;
    }
    return out;
  };
  const tabs = `<w:tabs><w:tab w:val="center" w:pos="${Math.round(bodyTwips / 2)}"/><w:tab w:val="right" w:pos="${bodyTwips}"/></w:tabs>`;
  const style = kind === 'hdr' ? 'Header' : 'Footer';
  let runs = field(line.l);
  if (line.c || line.r) runs += `<w:r><w:tab/></w:r>${field(line.c)}`;
  if (line.r) runs += `<w:r><w:tab/></w:r>${field(line.r)}`;
  return `${XML_HEAD}<w:${kind} xmlns:w="${NS.w}" xmlns:r="${NS.r}"><w:p><w:pPr><w:pStyle w:val="${style}"/>${tabs}</w:pPr>${runs}</w:p></w:${kind}>`;
}

const lineHas = (l: HeaderLine) => !!(l.l.trim() || l.c.trim() || l.r.trim());

/** The document as the bytes of a .docx file. */
export async function writeDocx(doc: NodeJSON, page: PageSetup, title = '', source?: DocxSource, extras: { headingPages?: number[] } = {}): Promise<Uint8Array<ArrayBuffer>> {
  const pt = PAPERS[page.paper];
  const wPt = page.orient === 'landscape' ? pt.h : pt.w;
  const hPt = page.orient === 'landscape' ? pt.w : pt.h;
  const m = page.margins;
  const bodyPx = ((wPt / 72) - m.l - m.r) * PX_PER_IN;
  // A file opened here keeps its own list definitions: ours are numbered after its highest ids.
  const keptNumbering = source?.numbering ? partText(source, source.numbering) : null;
  const most = (re: RegExp) => Math.max(0, ...[...(keptNumbering ?? '').matchAll(re)].map(m => Number(m[1])));
  const abs = source ? most(/w:abstractNumId="(\d+)"/g) + 1 : 0;
  const bulletNum = source ? most(/w:numId="(\d+)"/g) + 1 : 1;
  const ctx: WriteCtx = { page, media: new Map(), ordered: [], nextNum: bulletNum + 1, bulletNum, drawingId: 0, bodyPx, mediaPrefix: source ? 'Tw' : '', notes: [], nextNote: 1, keptNotes: source?.notes ?? new Map(), headingPages: extras.headingPages ?? [], allBlocks: doc.content ?? [] };
  if (source?.notes.size) ctx.nextNote = Math.max(...source.notes.keys()) + 1;
  const body = blocksXml(doc.content ?? [], ctx);
  const hasHeader = lineHas(page.header);
  const hasFooter = lineHas(page.footer);
  const inch = (v: number) => Math.round(v * 1440);
  const sect = `<w:sectPr>${hasHeader ? '<w:headerReference w:type="default" r:id="rIdHeader1"/>' : ''}${hasFooter ? '<w:footerReference w:type="default" r:id="rIdFooter1"/>' : ''}`
    + `<w:pgSz w:w="${twips(wPt)}" w:h="${twips(hPt)}"${page.orient === 'landscape' ? ' w:orient="landscape"' : ''}/>`
    + `<w:pgMar w:top="${inch(m.t)}" w:right="${inch(m.r)}" w:bottom="${inch(m.b)}" w:left="${inch(m.l)}" w:header="${inch(m.header)}" w:footer="${inch(m.footer)}" w:gutter="0"/>`
    + '<w:cols w:space="720"/><w:docGrid w:linePitch="360"/></w:sectPr>';
  const document = `${XML_HEAD}<w:document xmlns:w="${NS.w}" xmlns:r="${NS.r}" xmlns:wp="${NS.wp}" xmlns:a="${NS.a}" xmlns:pic="${NS.pic}"><w:body>${body}${sect}</w:body></w:document>`;
  const bodyTwips = inch((wPt / 72) - m.l - m.r);
  if (source) {
    const pageXml = `<w:pgSz w:w="${twips(wPt)}" w:h="${twips(hPt)}"${page.orient === 'landscape' ? ' w:orient="landscape"' : ''}/>`
      + `<w:pgMar w:top="${inch(m.t)}" w:right="${inch(m.r)}" w:bottom="${inch(m.b)}" w:left="${inch(m.l)}" w:header="${inch(m.header)}" w:footer="${inch(m.footer)}" w:gutter="0"/>`;
    return writeKept(source, ctx, body, pageXml, numberingParts(ctx.ordered, abs, bulletNum), bodyTwips);
  }

  let rels = `${XML_HEAD}<Relationships xmlns="${NS.rel}">`
    + `<Relationship Id="rIdStyles" Type="${REL}/styles" Target="styles.xml"/>`
    + `<Relationship Id="rIdNumbering" Type="${REL}/numbering" Target="numbering.xml"/>`
    + `<Relationship Id="rIdSettings" Type="${REL}/settings" Target="settings.xml"/>`;
  if (hasHeader) rels += `<Relationship Id="rIdHeader1" Type="${REL}/header" Target="header1.xml"/>`;
  if (hasFooter) rels += `<Relationship Id="rIdFooter1" Type="${REL}/footer" Target="footer1.xml"/>`;
  const hasNotes = ctx.notes.length > 0;
  if (hasNotes) rels += `<Relationship Id="rIdFootnotes" Type="${REL}/footnotes" Target="footnotes.xml"/>`;
  for (const media of ctx.media.values()) rels += `<Relationship Id="${media.rid}" Type="${REL}/image" Target="media/${media.name}"/>`;
  rels += '</Relationships>';

  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const types = `${XML_HEAD}<Types xmlns="${NS.ct}"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>`
    + '<Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'
    + '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>'
    + (hasHeader ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' : '')
    + (hasFooter ? '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' : '')
    + (hasNotes ? '<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>' : '')
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
    + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>';
  const rootRels = `${XML_HEAD}<Relationships xmlns="${NS.rel}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/>`
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
    + `<Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/></Relationships>`;
  const core = `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">`
    + `${title ? `<dc:title>${escapeXml(xmlSafe(title.slice(0, 200)))}</dc:title>` : ''}<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;
  const app = `${XML_HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>TOMLIN Write</Application></Properties>`;
  const settings = `${XML_HEAD}<w:settings xmlns:w="${NS.w}"><w:defaultTabStop w:val="720"/>${hasNotes ? '<w:footnotePr><w:footnote w:id="-1"/><w:footnote w:id="0"/></w:footnotePr>' : ''}<w:characterSpacingControl w:val="doNotCompress"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;

  const enc = new TextEncoder();
  const at = Date.now();
  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: enc.encode(types), modified: at },
    { name: '_rels/.rels', data: enc.encode(rootRels), modified: at },
    { name: 'docProps/core.xml', data: enc.encode(core), modified: at },
    { name: 'docProps/app.xml', data: enc.encode(app), modified: at },
    { name: 'word/document.xml', data: enc.encode(document), modified: at },
    { name: 'word/_rels/document.xml.rels', data: enc.encode(rels), modified: at },
    { name: 'word/styles.xml', data: enc.encode(stylesXml()), modified: at },
    { name: 'word/numbering.xml', data: enc.encode(numberingXml(ctx.ordered)), modified: at },
    { name: 'word/settings.xml', data: enc.encode(settings), modified: at },
  ];
  if (hasHeader) entries.push({ name: 'word/header1.xml', data: enc.encode(headerXml('hdr', page.header, bodyTwips)), modified: at });
  if (hasFooter) entries.push({ name: 'word/footer1.xml', data: enc.encode(headerXml('ftr', page.footer, bodyTwips)), modified: at });
  if (hasNotes) entries.push({ name: 'word/footnotes.xml', data: enc.encode(footnotesXml(ctx.notes, null)), modified: at });
  for (const media of ctx.media.values()) entries.push({ name: `word/media/${media.name}`, data: media.pic.bytes, modified: at });
  return zipDeflate(entries);
}

// ---- Saving over a Word file opened here ------------------------------------------------------------------------

/** A Word file as it was opened: every part, so saving over it keeps what Write did not change. */
export interface DocxSource {
  /** Every part, by its path in the zip. */
  parts: Map<string, Uint8Array>;
  /** The main part (word/document.xml almost always) and its relationships part. */
  main: string;
  rels: string;
  styles: string | null;
  numbering: string | null;
  /** The main part's opening tag, with every namespace the kept parts use. */
  rootTag: string;
  /** The last section's settings as written (headers, footers, columns, line numbers...), or ''. */
  sectPr: string;
  /** The header and footer as Write read them: changed in Write, they are written anew; otherwise the file's own stay. */
  header: HeaderLine;
  footer: HeaderLine;
  /** The file's footnotes part and the words of each note (by its number there). */
  footnotes: string | null;
  notes: Map<number, string>;
}

const partText = (source: DocxSource, path: string): string | null => {
  const b = source.parts.get(path);
  return b ? new TextDecoder('utf-8').decode(b).replace(/^﻿/, '') : null;
};

/** What comes after the paper size and margins in a section's settings (Word's file format fixes the order). */
const AFTER_PAGE = ['pgBorders', 'lnNumType', 'pgNumType', 'cols', 'formProt', 'vAlign', 'noEndnote', 'titlePg', 'textDirection', 'bidi', 'rtlGutter', 'docGrid', 'printerSettings', 'sectPrChange'];

/**
 * Saving over a Word file opened here: every part of the file stays (its theme, fonts, settings, comments, footnotes,
 * text boxes' pictures...), with the main text, Write's styles and lists, the page size and margins, and any new
 * pictures (or a header and footer changed in Write) put in. Text boxes, shapes and the like that Write kept as grey
 * labels go back exactly as they were, and the relationships they name are still there.
 */
function writeKept(source: DocxSource, ctx: WriteCtx, body: string, pageXml: string, numbering: { abstracts: string; nums: string }, bodyTwips: number): Promise<Uint8Array<ArrayBuffer>> {
  const enc = new TextEncoder();
  const dir = source.main.slice(0, source.main.lastIndexOf('/') + 1);
  const out = new Map(source.parts);
  const newRels: string[] = [];
  const newTypes: string[] = [];

  // The section: the file's own, with Write's paper and margins (and header and footer when changed in Write).
  let sect = source.sectPr || '<w:sectPr></w:sectPr>';
  sect = sect.replace(/^<w:sectPr([^>]*)\/>$/, '<w:sectPr$1></w:sectPr>');
  if (/<w:pgSz\b/.test(sect)) sect = sect.replace(/<w:pgMar\b[^>]*\/>/, '').replace(/<w:pgSz\b[^>]*\/>/, () => pageXml);
  else {
    sect = sect.replace(/<w:pgMar\b[^>]*\/>/, '');
    const m = new RegExp(`<w:(${AFTER_PAGE.join('|')})\\b|</w:sectPr>`).exec(sect);
    sect = m ? sect.slice(0, m.index) + pageXml + sect.slice(m.index) : sect + pageXml;
  }
  const refs: string[] = [];
  const page = ctx.page;
  for (const [key, tag, kind] of [['header', 'headerReference', 'hdr'], ['footer', 'footerReference', 'ftr']] as const) {
    if (JSON.stringify(page[key]) === JSON.stringify(source[key])) continue;
    sect = sect.replace(new RegExp(`<w:${tag}\\b[^>]*/>`, 'g'), '');
    if (!lineHas(page[key])) continue;
    const name = `tw-${key}1.xml`;
    out.set(dir + name, enc.encode(headerXml(kind, page[key], bodyTwips)));
    newRels.push(`<Relationship Id="rIdTw${key}" Type="${REL}/${key}" Target="${name}"/>`);
    newTypes.push(`<Override PartName="/${dir}${name}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${key}+xml"/>`);
    refs.push(`<w:${tag} w:type="default" r:id="rIdTw${key}"/>`);
  }
  sect = sect.replace(/^<w:sectPr[^>]*>/, open => open + refs.join(''));

  // The main part, under the file's own opening tag (with the namespaces Write's own parts need, added if missing).
  let root = source.rootTag;
  for (const [prefix, uri] of [['w', NS.w], ['r', NS.r], ['wp', NS.wp], ['a', NS.a], ['pic', NS.pic]]) {
    if (!root.includes(`xmlns:${prefix}=`)) root = root.replace(/>$/, ` xmlns:${prefix}="${uri}">`);
  }
  out.set(source.main, enc.encode(`${XML_HEAD}${root}<w:body>${body}${sect}</w:body></w:document>`));

  // Styles: the file's own, with Write's styles in place of the ones of the same ids.
  const stylesPath = source.styles ?? `${dir}styles.xml`;
  let styles = source.styles ? partText(source, source.styles) : null;
  if (styles) {
    try {
      const text = styles;
      const cut = children(parseXml(text), 'style').filter(st => OUR_STYLE_IDS.includes(at(st, 'styleId') ?? '')).sort((x, y) => (y.start ?? 0) - (x.start ?? 0));
      let kept = text;
      for (const st of cut) kept = kept.slice(0, st.start) + kept.slice(st.end);
      styles = /<\/w:styles>\s*$/.test(kept) ? kept.replace(/<\/w:styles>\s*$/, `${ourStyles()}</w:styles>`) : null;
    } catch {
      styles = null;
    }
  }
  if (!styles) {
    styles = stylesXml();
    if (!source.styles) {
      newRels.push(`<Relationship Id="rIdTwStyles" Type="${REL}/styles" Target="styles.xml"/>`);
      newTypes.push(`<Override PartName="/${stylesPath}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>`);
    }
  }
  out.set(stylesPath, enc.encode(styles));

  // Numbering: the file's own, with Write's list definitions after it.
  const numberingPath = source.numbering ?? `${dir}numbering.xml`;
  let numberingText = source.numbering ? partText(source, source.numbering) : null;
  if (numberingText && /<\/w:numbering>\s*$/.test(numberingText)) {
    const firstNum = numberingText.search(/<w:num\b/);
    numberingText = firstNum >= 0 ? numberingText.slice(0, firstNum) + numbering.abstracts + numberingText.slice(firstNum) : numberingText.replace(/<\/w:numbering>\s*$/, `${numbering.abstracts}</w:numbering>`);
    numberingText = numberingText.replace(/<\/w:numbering>\s*$/, `${numbering.nums}</w:numbering>`);
  } else {
    numberingText = `${XML_HEAD}<w:numbering xmlns:w="${NS.w}">${numbering.abstracts}${numbering.nums}</w:numbering>`;
    if (!source.numbering) {
      newRels.push(`<Relationship Id="rIdTwNumbering" Type="${REL}/numbering" Target="numbering.xml"/>`);
      newTypes.push(`<Override PartName="/${numberingPath}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>`);
    }
  }
  out.set(numberingPath, enc.encode(numberingText));

  // New footnotes: added to the file's own footnotes part, or a part of their own.
  if (ctx.notes.length) {
    const path = source.footnotes ?? `${dir}footnotes.xml`;
    out.set(path, enc.encode(footnotesXml(ctx.notes, source.footnotes ? partText(source, source.footnotes) : null)));
    if (!source.footnotes) {
      newRels.push(`<Relationship Id="rIdTwFootnotes" Type="${REL}/footnotes" Target="footnotes.xml"/>`);
      newTypes.push(`<Override PartName="/${path}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>`);
    }
  }

  // Pictures in the text, as files of their own.
  for (const media of ctx.media.values()) {
    out.set(`${dir}media/${media.name}`, media.pic.bytes);
    newRels.push(`<Relationship Id="${media.rid}" Type="${REL}/image" Target="media/${media.name}"/>`);
  }
  const relsText = partText(source, source.rels) ?? `${XML_HEAD}<Relationships xmlns="${NS.rel}"></Relationships>`;
  out.set(source.rels, enc.encode(relsText.replace(/<\/Relationships>\s*$/, `${newRels.join('')}</Relationships>`)));

  const typesText = partText(source, '[Content_Types].xml') ?? `${XML_HEAD}<Types xmlns="${NS.ct}"></Types>`;
  for (const [ext, type] of [['png', 'image/png'], ['jpeg', 'image/jpeg'], ['gif', 'image/gif']]) {
    if (!new RegExp(`Extension="${ext}"`, 'i').test(typesText)) newTypes.unshift(`<Default Extension="${ext}" ContentType="${type}"/>`);
  }
  out.set('[Content_Types].xml', enc.encode(typesText.replace(/<\/Types>\s*$/, `${newTypes.join('')}</Types>`)));

  const when = Date.now();
  const entries: ZipEntry[] = [{ name: '[Content_Types].xml', data: out.get('[Content_Types].xml')!, modified: when }];
  for (const [name, data] of out) if (name !== '[Content_Types].xml') entries.push({ name, data, modified: when });
  return zipDeflate(entries);
}

// ---- Reading ---------------------------------------------------------------------------------------------------------

export interface DocxRead {
  doc: NodeJSON;
  page: PageSetup;
  /** What the document has that Write leaves out (each said once, in words): saving over the file loses these. */
  dropped: string[];
  /** What Write keeps without showing it fully (grey labels in the text, written back unchanged). */
  kept: string[];
  /** The file as opened, to save over it without losing its other parts. */
  source: DocxSource;
}

const at = (el: XmlEl | undefined, name: string): string | undefined => (el ? el.attrs[`w:${name}`] ?? el.attrs[name] : undefined);
const num = (v: string | undefined): number | null => {
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
/** A on/off property: present means on, unless its value says off. */
const toggle = (el: XmlEl | undefined): boolean | undefined => {
  if (!el) return undefined;
  const v = at(el, 'val');
  return !(v === '0' || v === 'false' || v === 'off' || v === 'none');
};

/** Every element below `el` with this name, depth first (the reader never calls itself, so deep files are safe). */
function findAll(el: XmlEl, name: string): XmlEl[] {
  const out: XmlEl[] = [];
  const stack = [...el.kids].reverse();
  while (stack.length) {
    const e = stack.pop()!;
    if (e.name === name) out.push(e);
    for (let i = e.kids.length - 1; i >= 0; i--) stack.push(e.kids[i]);
  }
  return out;
}

interface RunLook {
  face?: string;
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  colour?: string | null;
  highlight?: string | null;
  vert?: 'super' | 'sub' | null;
}

interface ParaLook {
  align?: string | null;
  before?: number;
  after?: number;
  line?: number;
  indent?: number;
  first?: number;
  numId?: string;
  ilvl?: number;
  contextual?: boolean;
  pageBreakBefore?: boolean;
}

interface StyleDef {
  type: string;
  name: string;
  basedOn?: string;
  run: RunLook;
  para: ParaLook;
  tableBorders?: boolean;
}

interface Level {
  bullet: boolean;
  start: number;
}

class Reader {
  styles = new Map<string, StyleDef>();
  defaults: { run: RunLook; para: ParaLook } = { run: {}, para: {} };
  theme = { major: 'Calibri Light', minor: 'Calibri' };
  abstracts = new Map<string, Map<number, Level>>();
  nums = new Map<string, { abstract: string; starts: Map<number, number> }>();
  rels = new Map<string, string>();
  media = new Map<string, Uint8Array>();
  dropped = new Set<string>();
  defaultParaStyle = 'Normal';
  /** How far each list (numId) and level has counted, so a list that carries on after a break carries on counting. */
  counters = new Map<string, number[]>();

  runLook(rpr: XmlEl | undefined, into: RunLook = {}): RunLook {
    if (!rpr) return into;
    const out = { ...into };
    const fonts = child(rpr, 'rFonts');
    if (fonts) {
      const face = at(fonts, 'ascii') ?? at(fonts, 'hAnsi');
      const theme = at(fonts, 'asciiTheme') ?? at(fonts, 'hAnsiTheme');
      if (face) out.face = face;
      else if (theme) out.face = /major/i.test(theme) ? this.theme.major : this.theme.minor;
    }
    const sz = num(at(child(rpr, 'sz'), 'val'));
    if (sz !== null && sz > 0) out.size = sz / 2;
    const b = toggle(child(rpr, 'b'));
    if (b !== undefined) out.bold = b;
    const i = toggle(child(rpr, 'i'));
    if (i !== undefined) out.italic = i;
    const u = child(rpr, 'u');
    if (u) out.underline = (at(u, 'val') ?? 'single') !== 'none';
    const s = toggle(child(rpr, 'strike')) ?? toggle(child(rpr, 'dstrike'));
    if (s !== undefined) out.strike = s;
    const c = at(child(rpr, 'color'), 'val');
    if (c) out.colour = /^[0-9a-f]{6}$/i.test(c) ? `#${c.toLowerCase()}` : null;
    const hl = at(child(rpr, 'highlight'), 'val');
    if (hl) out.highlight = hl === 'none' ? null : HIGHLIGHTS[hl] ?? null;
    const shd = at(child(rpr, 'shd'), 'fill');
    if (shd && /^[0-9a-f]{6}$/i.test(shd) && !hl) out.highlight = `#${shd.toLowerCase()}`;
    const va = at(child(rpr, 'vertAlign'), 'val');
    if (va) out.vert = va === 'superscript' ? 'super' : va === 'subscript' ? 'sub' : null;
    return out;
  }

  paraLook(ppr: XmlEl | undefined, into: ParaLook = {}): ParaLook {
    if (!ppr) return into;
    const out = { ...into };
    const jc = at(child(ppr, 'jc'), 'val');
    if (jc) out.align = jc === 'center' ? 'center' : jc === 'right' || jc === 'end' ? 'right' : jc === 'both' || jc === 'distribute' ? 'justify' : null;
    const sp = child(ppr, 'spacing');
    if (sp) {
      const before = num(at(sp, 'before'));
      const after = num(at(sp, 'after'));
      const line = num(at(sp, 'line'));
      if (before !== null) out.before = before / 20;
      if (after !== null) out.after = after / 20;
      const rule = at(sp, 'lineRule') ?? 'auto';
      if (line !== null && rule === 'auto') out.line = line / 240;
      else if (line !== null) out.line = Math.max(0.5, line / 20 / 13.8);
    }
    const ind = child(ppr, 'ind');
    if (ind) {
      const left = num(at(ind, 'left') ?? at(ind, 'start'));
      const hanging = num(at(ind, 'hanging'));
      const first = num(at(ind, 'firstLine'));
      if (left !== null) out.indent = left / 20;
      if (hanging !== null) out.first = -hanging / 20;
      else if (first !== null) out.first = first / 20;
    }
    const numPr = child(ppr, 'numPr');
    if (numPr) {
      const id = at(child(numPr, 'numId'), 'val');
      if (id !== undefined) out.numId = id;
      const lvl = num(at(child(numPr, 'ilvl'), 'val'));
      if (lvl !== null) out.ilvl = lvl;
    }
    const cs = toggle(child(ppr, 'contextualSpacing'));
    if (cs !== undefined) out.contextual = cs;
    const pb = toggle(child(ppr, 'pageBreakBefore'));
    if (pb !== undefined) out.pageBreakBefore = pb;
    return out;
  }

  /** A style with everything it inherits (basedOn chains, at most 20 deep, never round in a circle). */
  resolved(id: string | undefined): StyleDef | undefined {
    const chain: StyleDef[] = [];
    const seen = new Set<string>();
    let cur = id;
    while (cur && !seen.has(cur) && chain.length < 20) {
      seen.add(cur);
      const s = this.styles.get(cur);
      if (!s) break;
      chain.unshift(s);
      cur = s.basedOn;
    }
    if (!chain.length) return undefined;
    const out: StyleDef = { type: chain[chain.length - 1].type, name: chain[chain.length - 1].name, run: {}, para: {} };
    for (const s of chain) {
      out.run = { ...out.run, ...s.run };
      out.para = { ...out.para, ...s.para };
      if (s.tableBorders !== undefined) out.tableBorders = s.tableBorders;
    }
    return out;
  }

  readStyles(root: XmlEl | null): void {
    if (!root) return;
    const dd = child(root, 'docDefaults');
    this.defaults.run = this.runLook(child(child(dd, 'rPrDefault'), 'rPr'));
    this.defaults.para = this.paraLook(child(child(dd, 'pPrDefault'), 'pPr'));
    for (const s of children(root, 'style')) {
      const id = at(s, 'styleId');
      if (!id) continue;
      const type = at(s, 'type') ?? 'paragraph';
      const tblBorders = child(child(s, 'tblPr'), 'tblBorders');
      const def: StyleDef = {
        type,
        name: (at(child(s, 'name'), 'val') ?? id).toLowerCase(),
        basedOn: at(child(s, 'basedOn'), 'val'),
        run: this.runLook(child(s, 'rPr')),
        para: this.paraLook(child(s, 'pPr')),
        tableBorders: tblBorders ? tblBorders.kids.some(b => !['nil', 'none'].includes(at(b, 'val') ?? 'nil')) : undefined,
      };
      this.styles.set(id, def);
      const isDefault = s.attrs['w:default'] ?? s.attrs.default;
      if (type === 'paragraph' && (isDefault === '1' || isDefault === 'true' || isDefault === 'on')) this.defaultParaStyle = id;
    }
  }

  readNumbering(root: XmlEl | null): void {
    if (!root) return;
    for (const an of children(root, 'abstractNum')) {
      const id = at(an, 'abstractNumId');
      if (id === undefined) continue;
      const levels = new Map<number, Level>();
      for (const lvl of children(an, 'lvl')) {
        const i = num(at(lvl, 'ilvl')) ?? 0;
        const fmt = at(child(lvl, 'numFmt'), 'val') ?? 'decimal';
        levels.set(i, { bullet: fmt === 'bullet' || fmt === 'none', start: num(at(child(lvl, 'start'), 'val')) ?? 1 });
      }
      this.abstracts.set(id, levels);
    }
    for (const n of children(root, 'num')) {
      const id = at(n, 'numId');
      const abstract = at(child(n, 'abstractNumId'), 'val');
      if (id === undefined || abstract === undefined) continue;
      const starts = new Map<number, number>();
      for (const o of children(n, 'lvlOverride')) {
        const s = num(at(child(o, 'startOverride'), 'val'));
        if (s !== null) starts.set(num(at(o, 'ilvl')) ?? 0, s);
      }
      this.nums.set(id, { abstract, starts });
    }
  }

  level(numId: string, ilvl: number): Level | null {
    const n = this.nums.get(numId);
    if (!n) return null;
    const lv = this.abstracts.get(n.abstract)?.get(ilvl) ?? { bullet: false, start: 1 };
    return { bullet: lv.bullet, start: n.starts.get(ilvl) ?? lv.start };
  }

  /** Our style for a Word paragraph style: Title, Heading 1, 2, 3 (4 to 9 show as 3), anything else Normal. */
  ourStyle(id: string | undefined): StyleId {
    const s = id ? this.styles.get(id) : undefined;
    const name = s?.name ?? (id ?? '').toLowerCase();
    if (name === 'title' || id === 'Title') return 'title';
    const m = /^heading\s*([1-9])$/.exec(name) ?? /^heading([1-9])$/i.exec(id ?? '');
    if (m) return m[1] === '1' ? 'h1' : m[1] === '2' ? 'h2' : 'h3';
    return 'normal';
  }
}

const near = (a: number | undefined, b: number) => a === undefined || Math.abs(a - b) < 0.05;

/** The editor's marks for a run that looks like `look` in a paragraph of `style`: only what differs from the style. */
function marksFor(look: RunLook, style: StyleId): MarkJSON[] {
  const s = STYLES[style];
  const marks: MarkJSON[] = [];
  // Where a Word file says nothing, Word draws Times New Roman 10 in black (its own built-in standard).
  const face = look.face ?? 'Times New Roman';
  if (face.toLowerCase() !== s.face.toLowerCase() && /^[A-Za-z0-9][A-Za-z0-9 \-]{0,30}$/.test(face)) marks.push({ type: 'font', attrs: { face } });
  const size = look.size ?? 10;
  if (!near(size, s.size)) marks.push({ type: 'size', attrs: { pt: Math.round(size * 2) / 2 } });
  const colour = look.colour ?? '#000000';
  if (colour !== (s.colour ?? '#000000')) marks.push({ type: 'color', attrs: { value: colour } });
  if (look.highlight) marks.push({ type: 'highlight', attrs: { value: look.highlight } });
  if (look.bold && !s.bold) marks.push({ type: 'strong' });
  if (look.italic) marks.push({ type: 'em' });
  if (look.underline) marks.push({ type: 'underline' });
  if (look.strike) marks.push({ type: 'strike' });
  if (look.vert) marks.push({ type: 'vert', attrs: { pos: look.vert } });
  return marks;
}

/** Reads a .docx into the editor's document. Throws DocxProblem with a plain reason. */
export async function readDocx(bytes: Uint8Array): Promise<DocxRead> {
  if (bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    throw new DocxProblem('This is an older Word file (.doc), or a Word file locked with a password. Neither can be opened here. In Word, use File > Save As > Word Document (.docx), without a password, and open that file.');
  }
  let entries;
  try {
    entries = readZip(bytes);
  } catch (error) {
    if (error instanceof ArchiveError) throw new DocxProblem(`This is not a Word document Write can open. ${error.message}`);
    throw error;
  }
  const byPath = new Map(entries.filter(e => !e.folder).map(e => [e.parts.join('/').toLowerCase(), e]));
  let unpacked = 0;
  const readBytes = async (path: string): Promise<Uint8Array | null> => {
    const entry = byPath.get(path.replace(/^\/+/, '').toLowerCase());
    if (!entry) return null;
    unpacked += entry.size;
    if (unpacked > MAX_UNPACKED) throw new DocxProblem('This document unpacks to more than 200 MB, which is more than Write opens.');
    try {
      return await entry.read();
    } catch (error) {
      if (error instanceof ArchiveError) throw new DocxProblem(`This Word file is damaged. ${error.message}`);
      throw error;
    }
  };
  /** Each part's text as read, so a part Write keeps can be copied out of it exactly. */
  const texts = new Map<string, string>();
  const readXml = async (path: string): Promise<XmlEl | null> => {
    const data = await readBytes(path);
    if (!data) return null;
    try {
      const text = new TextDecoder('utf-8').decode(data).replace(/^﻿/, '');
      texts.set(path, text);
      return parseXml(text);
    } catch (error) {
      if (error instanceof XmlProblem) throw new DocxProblem(`Part of this Word file (${path}) is damaged: ${error.message}`);
      throw error;
    }
  };

  // The main part is named in the package's own list (word/document.xml almost always).
  let main = 'word/document.xml';
  const rootRels = await readXml('_rels/.rels');
  for (const r of rootRels ? children(rootRels, 'Relationship') : []) {
    if (/officeDocument$/.test(r.attrs.Type ?? '') && r.attrs.Target) main = r.attrs.Target.replace(/^\/+/, '');
  }
  const docXml = await readXml(main);
  if (!docXml || docXml.name !== 'document') throw new DocxProblem('This is not a Word document Write can open (it has no main document part).');
  const dir = main.slice(0, main.lastIndexOf('/') + 1);
  const docSrc = texts.get(main) ?? '';
  /** What the document has that Write keeps without showing (written back unchanged): each kind said once. */
  const kept = new Set<string>();
  const raw = (el: XmlEl): string => (el.start !== undefined && el.end !== undefined ? docSrc.slice(el.start, el.end) : '');
  const words = (el: XmlEl): string => findAll(el, 't').map(t => t.text).join('').replace(/\s+/g, ' ').trim();
  /** A run Write cannot show, kept whole: a grey label in the text, written back as it was. */
  const keepRun = (run: XmlEl, k: XmlEl, label: string, what: string): NodeJSON => {
    kept.add(what);
    const rpr = child(run, 'rPr');
    return { type: 'opaque_inline', attrs: { xml: `<w:r>${rpr ? raw(rpr) : ''}${raw(k)}</w:r>`, label } };
  };
  const keepWhole = (el: XmlEl, label: string, what: string): NodeJSON => {
    kept.add(what);
    return { type: 'opaque_inline', attrs: { xml: raw(el), label } };
  };
  const shapeLabel = (k: XmlEl): [string, string] => {
    if (findAll(k, 'chart').length) return ['Chart', 'charts'];
    const box = findAll(k, 'txbxContent')[0] ?? findAll(k, 'txbx')[0] ?? findAll(k, 'textbox')[0];
    if (box) {
      const w = words(box);
      return [w ? `Text box: ${w.length > 40 ? `${w.slice(0, 40)}…` : w}` : 'Text box', 'text boxes'];
    }
    if (findAll(k, 'relIds').length) return ['SmartArt', 'SmartArt diagrams'];
    return ['Shape', 'drawings and shapes'];
  };
  const resolve = (target: string) => {
    if (target.startsWith('/')) return target.slice(1);
    const parts = (dir + target).split('/');
    const out: string[] = [];
    for (const p of parts) {
      if (p === '..') out.pop();
      else if (p !== '.') out.push(p);
    }
    return out.join('/');
  };
  const rd = new Reader();
  const relsXml = await readXml(`${dir}_rels/${main.slice(dir.length)}.rels`);
  const relTargets = new Map<string, { type: string; target: string; external: boolean }>();
  for (const r of relsXml ? children(relsXml, 'Relationship') : []) {
    if (r.attrs.Id && r.attrs.Target) relTargets.set(r.attrs.Id, { type: r.attrs.Type ?? '', target: r.attrs.Target, external: r.attrs.TargetMode === 'External' });
  }
  const partOf = (type: string) => [...relTargets.values()].find(r => r.type.endsWith(`/${type}`) && !r.external);
  const theme = partOf('theme');
  if (theme) {
    const t = await readXml(resolve(theme.target));
    const scheme = t ? findAll(t, 'fontScheme')[0] : undefined;
    const major = at(child(child(scheme, 'majorFont'), 'latin'), 'typeface');
    const minor = at(child(child(scheme, 'minorFont'), 'latin'), 'typeface');
    if (major) rd.theme.major = major;
    if (minor) rd.theme.minor = minor;
  }
  const stylesPart = partOf('styles');
  rd.readStyles(stylesPart ? await readXml(resolve(stylesPart.target)) : null);
  const numberingPart = partOf('numbering');
  rd.readNumbering(numberingPart ? await readXml(resolve(numberingPart.target)) : null);
  // The footnotes' words (by their numbers), so each reference becomes a footnote that shows them.
  const footnoteTexts = new Map<number, string>();
  const footnotesPart = partOf('footnotes');
  const footnotesXmlRead = footnotesPart ? await readXml(resolve(footnotesPart.target)) : null;
  for (const fn of footnotesXmlRead ? children(footnotesXmlRead, 'footnote') : []) {
    const id = Number(at(fn, 'id'));
    if (!Number.isFinite(id) || id <= 0 || at(fn, 'type')) continue;
    footnoteTexts.set(id, children(fn, 'p').map(p => findAll(p, 't').map(t => t.text).join('')).join(' ').replace(/\s+/g, ' ').trim());
  }

  /** A picture's bytes by relationship id, kept as a picture in the store; null when it is not one Write can show. */
  const pictureFor = async (rid: string): Promise<string | null> => {
    const rel = relTargets.get(rid);
    if (!rel || rel.external) {
      if (rel?.external) rd.dropped.add('pictures linked from outside the file');
      return null;
    }
    const data = await readBytes(resolve(rel.target));
    if (!data) return null;
    const id = addPicture(data);
    if (!id) rd.dropped.add('pictures in a kind Write cannot show (such as EMF or WMF drawings)');
    return id;
  };

  const body = child(docXml, 'body');
  if (!body) throw new DocxProblem('This Word document has no body.');
  // The last section's page settings are the document's (one page setup for the whole document here).
  const sections = findAll(body, 'sectPr');
  const lastSect = sections[sections.length - 1];
  const page = defaultPage();
  if (lastSect) {
    const sz = child(lastSect, 'pgSz');
    const w = num(at(sz, 'w'));
    const h = num(at(sz, 'h'));
    if (w && h) {
      const wPt = w / 20;
      const hPt = h / 20;
      const long = Math.max(wPt, hPt);
      const short = Math.min(wPt, hPt);
      let best: Paper = page.paper;
      let gap = Infinity;
      for (const k of Object.keys(PAPERS) as Paper[]) {
        const d = Math.abs(PAPERS[k].w - short) + Math.abs(PAPERS[k].h - long);
        if (d < gap) {
          gap = d;
          best = k;
        }
      }
      if (gap > 20) rd.dropped.add(`its own paper size (${Math.round((short / 72) * 25.4)} × ${Math.round((long / 72) * 25.4)} mm): it shows on ${PAPERS[best].label}`);
      page.paper = best;
      page.orient = wPt > hPt ? 'landscape' : 'portrait';
    }
    const mar = child(lastSect, 'pgMar');
    if (mar) {
      const inch = (name: string, d: number) => {
        const v = num(at(mar, name));
        return v === null ? d : Math.max(0, Math.abs(v) / 1440);
      };
      page.margins = {
        t: inch('top', page.margins.t), b: inch('bottom', page.margins.b), l: inch('left', page.margins.l), r: inch('right', page.margins.r),
        header: inch('header', page.margins.header), footer: inch('footer', page.margins.footer),
      };
    }
    const cols = num(at(child(lastSect, 'cols'), 'num'));
    if (cols && cols > 1) rd.dropped.add('text in columns (it shows in one column)');
    if (child(lastSect, 'titlePg')) rd.dropped.add('a different header or footer on the first page');
    for (const [kind, key] of [['headerReference', 'header'], ['footerReference', 'footer']] as const) {
      const refs = children(lastSect, kind);
      const ref = refs.find(r => (at(r, 'type') ?? 'default') === 'default');
      if (refs.some(r => at(r, 'type') === 'even')) rd.dropped.add('different headers or footers on left and right pages');
      const rid = ref ? ref.attrs['r:id'] ?? ref.attrs.id : undefined;
      const rel = rid ? relTargets.get(rid) : undefined;
      if (rel && !rel.external) {
        const part = await readXml(resolve(rel.target));
        if (part) page[key] = headerLineOf(part);
      }
    }
  }
  if (sections.length > 1) rd.dropped.add('more than one section (the whole document uses the last section’s page setup)');

  /** The inline content of a paragraph, split where it has page breaks. */
  const paragraphs = async (p: XmlEl, styleId: string, styleRun: RunLook): Promise<Array<NodeJSON[] | 'break'>> => {
    const style = rd.ourStyle(styleId);
    const parts: Array<NodeJSON[] | 'break'> = [[]];
    const cur = () => parts[parts.length - 1] as NodeJSON[];
    const pushText = (text: string, look: RunLook) => {
      if (!text) return;
      const marks = marksFor(look, style);
      // Word splits text into many runs that look the same (spell checks, edits): they join into one.
      const last = cur()[cur().length - 1];
      if (last?.type === 'text' && JSON.stringify(last.marks ?? []) === JSON.stringify(marks)) last.text += text;
      else cur().push(marks.length ? { type: 'text', text, marks } : { type: 'text', text });
    };
    // A field (a page number, a date, a contents list) shows as the text Word last put in it: its code is in
    // w:instrText, never in w:t, so only the shown result is read. A mail merge field becomes a field.
    let mergeSkip = false;
    const stack: Array<{ el: XmlEl; i: number }> = [{ el: p, i: 0 }];
    while (stack.length) {
      const top = stack[stack.length - 1];
      if (top.i >= top.el.kids.length) {
        stack.pop();
        continue;
      }
      const el = top.el.kids[top.i++];
      switch (el.name) {
        case 'r': {
          const rStyle = at(child(child(el, 'rPr'), 'rStyle'), 'val');
          const base = rStyle ? { ...styleRun, ...(rd.resolved(rStyle)?.run ?? {}) } : styleRun;
          const look = rd.runLook(child(el, 'rPr'), base);
          for (const k of el.kids) {
            if (k.name === 'instrText') {
              // A mail merge field written as a complex field: its shown result is skipped.
              const m = /MERGEFIELD\s+"?([^"\s\\]+)/i.exec(k.text);
              if (m) {
                const marks = marksFor(look, style);
                cur().push(marks.length ? { type: 'field', attrs: { name: m[1].slice(0, 40) }, marks } : { type: 'field', attrs: { name: m[1].slice(0, 40) } });
                mergeSkip = true;
              }
            } else if (k.name === 'fldChar' && at(k, 'fldCharType') === 'end') mergeSkip = false;
            else if (mergeSkip) continue;
            else if (k.name === 't') pushText(k.text, look);
            else if (k.name === 'tab' || k.name === 'ptab') pushText('\t', look);
            else if (k.name === 'noBreakHyphen') pushText('‑', look);
            else if (k.name === 'sym') cur().push(keepRun(el, k, 'Symbol', 'symbols from symbol fonts'));
            else if (k.name === 'br' || k.name === 'cr') {
              const type = at(k, 'type');
              if (type === 'page') parts.push('break', []);
              else if (type === 'column') parts.push('break', []);
              else cur().push({ type: 'hard_break' });
            } else if (k.name === 'drawing') {
              const blip = findAll(k, 'blip')[0];
              const rid = blip ? blip.attrs['r:embed'] ?? blip.attrs.embed : undefined;
              const extent = findAll(k, 'extent')[0];
              if (findAll(k, 'anchor').length) rd.dropped.add('text wrapping round pictures (they show in line with the text)');
              if (!rid) {
                const [label, what] = shapeLabel(k);
                cur().push(keepRun(el, k, label, what));
                continue;
              }
              const id = await pictureFor(rid);
              if (!id) continue;
              const cx = num(extent?.attrs.cx);
              const cy = num(extent?.attrs.cy);
              const descr = findAll(k, 'docPr')[0]?.attrs.descr ?? '';
              cur().push({ type: 'image', attrs: { src: id, width: cx ? Math.round(cx / EMU_PER_PX) : null, height: cy ? Math.round(cy / EMU_PER_PX) : null, alt: descr.slice(0, 300) } });
            } else if (k.name === 'pict') {
              const data = findAll(k, 'imagedata')[0];
              const rid = data ? data.attrs['r:id'] ?? data.attrs.id : undefined;
              if (!rid) {
                const box = findAll(k, 'textbox')[0];
                cur().push(keepRun(el, k, box ? `Text box: ${words(box).slice(0, 40)}` : 'Shape', box ? 'text boxes' : 'drawings and shapes'));
                continue;
              }
              const id = await pictureFor(rid);
              if (id) cur().push({ type: 'image', attrs: { src: id, width: null, height: null, alt: '' } });
            } else if (k.name === 'AlternateContent') {
              // Newer content (a shape, a text box) with an older stand-in: kept as it is.
              const [label, what] = shapeLabel(k);
              cur().push(keepRun(el, k, label, what));
            } else if (k.name === 'footnoteReference' && footnoteTexts.has(Number(at(k, 'id')))) {
              const id = Number(at(k, 'id'));
              cur().push({ type: 'footnote', attrs: { text: footnoteTexts.get(id) ?? '', id } });
            } else if (k.name === 'footnoteReference' || k.name === 'endnoteReference') {
              const n = at(k, 'id') ?? '';
              cur().push(keepRun(el, k, `${k.name === 'footnoteReference' ? 'Footnote' : 'Endnote'} ${n}`, 'footnotes and endnotes'));
            } else if (k.name === 'commentReference') cur().push(keepRun(el, k, 'Comment', 'comments'));
          }
          break;
        }
        case 'fldSimple': {
          const m = /MERGEFIELD\s+"?([^"\s\\]+)/i.exec(el.attrs['w:instr'] ?? el.attrs.instr ?? '');
          if (m) {
            const marks = marksFor(rd.runLook(child(child(el, 'r'), 'rPr'), styleRun), style);
            cur().push(marks.length ? { type: 'field', attrs: { name: m[1].slice(0, 40) }, marks } : { type: 'field', attrs: { name: m[1].slice(0, 40) } });
          } else stack.push({ el, i: 0 });
          break;
        }
        case 'hyperlink': case 'smartTag': case 'customXml': case 'ins': case 'moveTo': case 'sdtContent': case 'dir': case 'bdo':
          if (el.name === 'ins' || el.name === 'moveTo') rd.dropped.add('tracked changes (shown with the changes accepted)');
          stack.push({ el, i: 0 });
          break;
        case 'sdt':
          stack.push({ el: child(el, 'sdtContent') ?? { name: 'x', attrs: {}, kids: [], text: '' }, i: 0 });
          break;
        case 'del': case 'moveFrom':
          rd.dropped.add('tracked changes (shown with the changes accepted)');
          break;
        case 'oMath': case 'oMathPara':
          cur().push(keepWhole(el, `Equation${words(el) ? `: ${words(el).slice(0, 30)}` : ''}`, 'equations'));
          break;
        case 'AlternateContent': {
          const [label, what] = shapeLabel(el);
          cur().push(keepWhole(el, label, what));
          break;
        }
        default:
          break;
      }
    }
    return parts;
  };

  /** Paragraph settings that differ from our style's own (a list paragraph's indent comes from the list). */
  const paraAttrs = (look: ParaLook, style: StyleId, inList: boolean): Record<string, unknown> => {
    const s = STYLES[style];
    const attrs: Record<string, unknown> = { style };
    if (look.align) attrs.align = look.align;
    const contextual = inList && look.contextual;
    if (!contextual && look.before !== undefined && !near(look.before, s.before)) attrs.before = Math.max(0, Math.round(look.before * 10) / 10);
    if (!contextual && look.after !== undefined && !near(look.after, s.after)) attrs.after = Math.max(0, Math.round(look.after * 10) / 10);
    if (look.line !== undefined && !near(look.line, s.line) && look.line >= 0.5 && look.line <= 5) attrs.line = Math.round(look.line * 100) / 100;
    if (!inList) {
      if (look.indent && look.indent > 0) attrs.indent = Math.round(look.indent * 10) / 10;
      if (look.first && Math.abs(look.first) > 0.1) attrs.first = Math.round(look.first * 10) / 10;
    }
    return attrs;
  };

  /** Blocks of a body, a table cell or a header: paragraphs (gathered into lists), tables, page breaks. */
  const readBlocks = async (container: XmlEl, depth: number): Promise<NodeJSON[]> => {
    const out: NodeJSON[] = [];
    // Open lists, innermost last: the list node, its level, its Word list id and whether it is numbered.
    let open: Array<{ list: NodeJSON; level: number; numId: string; ordered: boolean }> = [];
    const closeLists = () => {
      open = [];
    };
    const items: XmlEl[] = [];
    // Content controls and inserted runs of whole paragraphs hold paragraphs too.
    const queue = [...container.kids];
    while (queue.length) {
      const el = queue.shift()!;
      const gallery = el.name === 'sdt' ? at(child(child(child(el, 'sdtPr'), 'docPartObj'), 'docPartGallery'), 'val') : undefined;
      if (gallery === 'Table of Contents') items.push(el);
      else if (el.name === 'sdt') queue.unshift(...(child(el, 'sdtContent')?.kids ?? []));
      else if (el.name === 'customXml' || el.name === 'ins') queue.unshift(...el.kids);
      else items.push(el);
    }
    for (const el of items) {
      if (el.name === 'p') {
        const ppr = child(el, 'pPr');
        const styleId = at(child(ppr, 'pStyle'), 'val') ?? rd.defaultParaStyle;
        const styleDef = rd.resolved(styleId);
        const style = rd.ourStyle(styleId);
        const look = rd.paraLook(ppr, { ...rd.defaults.para, ...(styleDef?.para ?? {}) });
        // Numbering set by a heading's style is the document's outline numbering: the heading shows without it.
        const direct = rd.paraLook(ppr);
        const numId = direct.numId ?? (style === 'normal' ? styleDef?.para.numId : undefined);
        const ilvl = Math.max(0, Math.min(8, direct.ilvl ?? styleDef?.para.ilvl ?? 0));
        const lvl = numId && numId !== '0' ? rd.level(numId, ilvl) : null;
        const runBase = { ...rd.defaults.run, ...(styleDef?.run ?? {}) };
        const parts = await paragraphs(el, styleId, runBase);
        if (look.pageBreakBefore && out.length) {
          closeLists();
          out.push({ type: 'page_break' });
        }
        const attrs = paraAttrs(look, style, !!lvl);
        const hasContent = (x: NodeJSON[] | 'break') => x !== 'break' && x.length > 0;
        const allEmpty = !parts.some(hasContent);
        for (const [i, part] of parts.entries()) {
          if (part === 'break') {
            closeLists();
            out.push({ type: 'page_break' });
            continue;
          }
          // A paragraph that only held a page break is not kept as an empty paragraph as well.
          if (!part.length && parts.length > 1 && (allEmpty || i > 0)) continue;
          const para: NodeJSON = part.length ? { type: 'paragraph', attrs, content: part } : { type: 'paragraph', attrs };
          // A paragraph with no number, indented as far as an open list's text, is a further paragraph of its last item.
          const host = !lvl ? [...open].reverse().find(o => (look.indent ?? 0) >= 36 * (o.level + 1) - 1) : undefined;
          if (lvl && numId && i === 0) {
            placeInList(out, open, para, numId, ilvl, lvl, rd);
            open = open.filter(o => o.level <= ilvl);
          } else if (host && i === 0) {
            const items = host.list.content!;
            items[items.length - 1].content!.push({ ...para, attrs: paraAttrs(look, style, true) });
            open = open.slice(0, open.indexOf(host) + 1);
          } else {
            closeLists();
            out.push(para);
          }
        }
        // A section break inside a paragraph starts the next section on a new page (unless it is a "continuous" one).
        const sect = child(ppr, 'sectPr');
        if (sect && (at(child(sect, 'type'), 'val') ?? 'nextPage') !== 'continuous') {
          closeLists();
          out.push({ type: 'page_break' });
        }
      } else if (el.name === 'tbl') {
        closeLists();
        if (depth > 6) {
          kept.add('tables inside tables more than six deep');
          out.push({ type: 'opaque_block', attrs: { xml: raw(el), label: 'Table (inside tables more than six deep)' } });
          continue;
        }
        out.push(await readTable(el, depth));
      } else if (el.name === 'sectPr') {
        // The body's own page settings: read above.
      } else if (el.name === 'bookmarkStart' || el.name === 'bookmarkEnd' || el.name === 'proofErr' || el.name === 'permStart' || el.name === 'permEnd') {
        // Nothing to show.
      } else if (el.name === 'sdt') {
        // A contents page: Write makes its own from the headings (the first line, if it is a title, is kept as its title).
        closeLists();
        const first = children(child(el, 'sdtContent'), 'p')[0];
        const firstStyle = at(child(child(first, 'pPr'), 'pStyle'), 'val') ?? '';
        const title = first && /toc ?heading/i.test(firstStyle) ? findAll(first, 't').map(t => t.text).join('').trim() : '';
        out.push({ type: 'toc', attrs: { title: title || 'Contents' } });
      } else if (el.name === 'altChunk') {
        kept.add('parts brought in from other files');
        out.push({ type: 'opaque_block', attrs: { xml: raw(el), label: 'Part brought in from another file' } });
      }
    }
    return out;
  };

  const readTable = async (tbl: XmlEl, depth: number): Promise<NodeJSON> => {
    const tblPr = child(tbl, 'tblPr');
    const styleId = at(child(tblPr, 'tblStyle'), 'val');
    const direct = child(tblPr, 'tblBorders');
    let borders = rd.resolved(styleId)?.tableBorders ?? false;
    if (direct) borders = direct.kids.some(b => !['nil', 'none'].includes(at(b, 'val') ?? 'nil'));
    const grid = children(child(tbl, 'tblGrid'), 'gridCol').map(g => (num(at(g, 'w')) ?? 0) / 15);
    const rows: NodeJSON[] = [];
    // For each grid column, the cell that started a run of merged rows there.
    const merging = new Map<number, NodeJSON>();
    for (const tr of children(tbl, 'tr')) {
      const cells: NodeJSON[] = [];
      let col = num(at(child(child(tr, 'trPr'), 'gridBefore'), 'val')) ?? 0;
      const trCells: XmlEl[] = [];
      for (const k of tr.kids) {
        if (k.name === 'tc') trCells.push(k);
        else if (k.name === 'sdt') trCells.push(...children(child(k, 'sdtContent'), 'tc'));
      }
      for (const tc of trCells) {
        const tcPr = child(tc, 'tcPr');
        const span = Math.max(1, Math.min(63, num(at(child(tcPr, 'gridSpan'), 'val')) ?? 1));
        const vm = child(tcPr, 'vMerge');
        const vmVal = vm ? at(vm, 'val') ?? 'continue' : null;
        if (vmVal === 'continue' && merging.has(col)) {
          const above = merging.get(col)!;
          above.attrs = { ...above.attrs, rowspan: Number(above.attrs?.rowspan ?? 1) + 1 };
          col += span;
          continue;
        }
        const widths = grid.length >= col + span ? grid.slice(col, col + span).map(w => Math.max(10, Math.round(w))) : null;
        const fill = at(child(tcPr, 'shd'), 'fill');
        const content = await readBlocks(tc, depth + 1);
        const cell: NodeJSON = {
          type: 'table_cell',
          attrs: { colspan: span, rowspan: 1, colwidth: widths && widths.every(w => w > 0) ? widths : null, background: fill && /^[0-9a-f]{6}$/i.test(fill) && fill.toLowerCase() !== 'ffffff' ? `#${fill.toLowerCase()}` : null },
          content: content.length ? content : [{ type: 'paragraph' }],
        };
        if (vmVal === 'restart') merging.set(col, cell);
        else merging.delete(col);
        cells.push(cell);
        col += span;
      }
      if (cells.length) rows.push({ type: 'table_row', content: cells });
    }
    // Rows shorter than the widest (cells missing at their end) are made up with empty cells, so the table is square.
    if (!rows.length) return { type: 'paragraph' };
    return fillTable({ type: 'table', attrs: { borders }, content: rows });
  };

  const blocks = await readBlocks(body, 0);
  const doc: NodeJSON = { type: 'doc', content: blocks.length ? blocks : [{ type: 'paragraph' }] };
  if (findAll(body, 'commentRangeStart').length) rd.dropped.add('where comments start and end (each comment stays, at its point)');
  // Every part of the file, kept for saving over it.
  const parts = new Map<string, Uint8Array>();
  for (const e of entries) {
    if (e.folder) continue;
    const data = await readBytes(e.parts.join('/'));
    if (data) parts.set(e.parts.join('/'), data);
  }
  const realPath = (path: string) => [...parts.keys()].find(k => k.toLowerCase() === path.toLowerCase()) ?? path;
  const bodySect = body.kids.filter(k => k.name === 'sectPr').pop();
  const stylesRel = partOf('styles');
  const numberingRel = partOf('numbering');
  const source: DocxSource = {
    parts,
    main: realPath(main),
    rels: realPath(`${dir}_rels/${main.slice(dir.length)}.rels`),
    styles: stylesRel ? realPath(resolve(stylesRel.target)) : null,
    numbering: numberingRel ? realPath(resolve(numberingRel.target)) : null,
    rootTag: docSrc.slice(docXml.start ?? 0, docSrc.indexOf('>', docXml.start ?? 0) + 1),
    sectPr: bodySect ? raw(bodySect) : '',
    header: { ...page.header },
    footer: { ...page.footer },
    footnotes: footnotesPart ? realPath(resolve(footnotesPart.target)) : null,
    notes: footnoteTexts,
  };
  return { doc, page: cleanPage(page), dropped: [...rd.dropped], kept: [...kept], source };
}

/** Puts a list paragraph into the right list (a new one, the open one, or one inside the last item). */
function placeInList(out: NodeJSON[], open: Array<{ list: NodeJSON; level: number; numId: string; ordered: boolean }>, para: NodeJSON, numId: string, ilvl: number, lvl: Level, rd: Reader): void {
  const ordered = !lvl.bullet;
  // How far this Word list has counted at this level (deeper levels start again under each new item).
  const counts = rd.counters.get(numId) ?? [];
  const n = (counts[ilvl] ?? lvl.start - 1) + 1;
  counts[ilvl] = n;
  counts.length = ilvl + 1;
  rd.counters.set(numId, counts);
  while (open.length && open[open.length - 1].level > ilvl) open.pop();
  const top = open[open.length - 1];
  const item: NodeJSON = { type: 'list_item', content: [para] };
  if (top && top.level === ilvl && top.ordered === ordered && (top.numId === numId || !ordered)) {
    top.list.content!.push(item);
    return;
  }
  if (top && top.level === ilvl) open.pop();
  const list: NodeJSON = ordered ? { type: 'ordered_list', attrs: { order: n }, content: [item] } : { type: 'bullet_list', content: [item] };
  const parent = open[open.length - 1];
  if (parent && parent.level < ilvl) {
    const items = parent.list.content!;
    items[items.length - 1].content!.push(list);
  } else out.push(list);
  open.push({ list, level: ilvl, numId, ordered });
}

/** Every row as wide as the widest (counting cells spanning down from rows above). */
function fillTable(table: NodeJSON): NodeJSON {
  const rows = table.content ?? [];
  const width = new Array(rows.length).fill(0);
  rows.forEach((row, r) => {
    for (const cell of row.content ?? []) {
      const span = Number(cell.attrs?.colspan ?? 1);
      const down = Math.min(rows.length - r, Number(cell.attrs?.rowspan ?? 1));
      for (let k = 0; k < down; k++) width[r + k] += span;
      if (down < Number(cell.attrs?.rowspan ?? 1)) cell.attrs = { ...cell.attrs, rowspan: down };
    }
  });
  const most = Math.max(...width);
  rows.forEach((row, r) => {
    for (let k = width[r]; k < most; k++) row.content!.push({ type: 'table_cell', attrs: { colspan: 1, rowspan: 1, colwidth: null, background: null }, content: [{ type: 'paragraph' }] });
  });
  return table;
}

/** A header or footer part as left / centre / right text (split at its tabs; &P and &N for the page fields). */
function headerLineOf(part: XmlEl): HeaderLine {
  const paras = findAll(part, 'p');
  for (const p of paras) {
    const segments: string[] = [''];
    let inCode = 0;
    let codeText = '';
    // Simple fields hold their shown result inside; complex fields are begin / code / separate / result / end.
    const order: Array<{ kind: 'run'; el: XmlEl } | { kind: 'field'; code: string }> = [];
    const walk = [...p.kids];
    while (walk.length) {
      const el = walk.shift()!;
      if (el.name === 'r') order.push({ kind: 'run', el });
      else if (el.name === 'fldSimple') order.push({ kind: 'field', code: el.attrs['w:instr'] ?? el.attrs.instr ?? '' });
      else walk.unshift(...el.kids);
    }
    const fieldText = (code: string) => (/\bNUMPAGES\b/i.test(code) ? '&N' : /\bPAGE\b/i.test(code) ? '&P' : '');
    for (const item of order) {
      if (item.kind === 'field') {
        segments[segments.length - 1] += fieldText(item.code);
        continue;
      }
      for (const k of item.el.kids) {
        if (k.name === 'fldChar') {
          const t = at(k, 'fldCharType');
          if (t === 'begin') {
            inCode = 1;
            codeText = '';
          } else if (t === 'separate') {
            inCode = 2;
            segments[segments.length - 1] += fieldText(codeText);
          } else if (t === 'end') {
            if (inCode === 1) segments[segments.length - 1] += fieldText(codeText);
            inCode = 0;
          }
        } else if (k.name === 'instrText' && inCode === 1) codeText += k.text;
        else if (inCode) continue;
        else if (k.name === 't') segments[segments.length - 1] += k.text.replace(/&/g, '&&');
        else if (k.name === 'tab' || k.name === 'ptab') segments.push('');
      }
    }
    if (!segments.join('').trim()) continue;
    const jc = at(child(child(p, 'pPr'), 'jc'), 'val');
    if (segments.length === 1) {
      if (jc === 'center') return { l: '', c: segments[0], r: '' };
      if (jc === 'right' || jc === 'end') return { l: '', c: '', r: segments[0] };
      return { l: segments[0], c: '', r: '' };
    }
    if (segments.length === 2) {
      const tabs = children(child(child(p, 'pPr'), 'tabs'), 'tab').map(t => at(t, 'val'));
      return tabs.includes('right') && !tabs.includes('center') ? { l: segments[0], c: '', r: segments[1] } : { l: segments[0], c: segments[1], r: '' };
    }
    return { l: segments[0], c: segments[1], r: segments.slice(2).join(' ') };
  }
  return { l: '', c: '', r: '' };
}
