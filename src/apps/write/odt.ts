// OpenDocument text (.odt), LibreOffice's and OpenOffice's own kind, opened into Write's document: headings and
// the Title, paragraphs with their alignment, spacing and indents, text formatting (from the file's styles and the
// text's own), bullets and numbers inside each other, tables with joined and shaded cells, pictures, page breaks,
// and the page's size, margins and header and footer. Read only: Write saves it as a Word document.
// An .odt is a zip of XML parts like a .docx; zip.ts / archive/read.ts and xml.ts read it. No browser needed except to
// keep the pictures (images.ts).
import { ArchiveError, readZip } from '../archive/read.ts';
import { child, children, parseXml, unescapeXml, XmlProblem, type XmlEl } from '../../core/xml.ts';
import { addPicture } from './images.ts';
import { cleanPage, defaultPage, PAPERS, STYLES, type HeaderLine, type MarkJSON, type NodeJSON, type PageSetup, type Paper, type StyleId } from './model.ts';
import { lengthPt, readColour } from './schema.ts';

export class OdtProblem extends Error {}

const MAX_UNPACKED = 200 * 1024 * 1024;

interface TextLook {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  colour?: string;
  size?: number;
  face?: string;
  highlight?: string;
  vert?: 'super' | 'sub';
}

interface ParaLook {
  align?: string | null;
  before?: number;
  after?: number;
  line?: number;
  indent?: number;
  first?: number;
  breakBefore?: boolean;
  breakAfter?: boolean;
}

interface Style {
  family: string;
  parent?: string;
  display?: string;
  text: TextLook;
  para: ParaLook;
  /** A table cell's shading; a column's width (points). */
  fill?: string;
  width?: number;
  /** The list style a paragraph style brings. */
  list?: string;
}

const attr = (el: XmlEl | undefined, name: string): string | undefined => {
  if (!el) return undefined;
  const local = name.slice(name.indexOf(':') + 1);
  return el.attrs[name] ?? el.attrs[local];
};

export interface OdtRead {
  doc: NodeJSON;
  page: PageSetup;
  dropped: string[];
}

export async function readOdt(bytes: Uint8Array): Promise<OdtRead> {
  let entries;
  try {
    entries = readZip(bytes);
  } catch (error) {
    if (error instanceof ArchiveError) throw new OdtProblem(`This is not an OpenDocument file Write can open. ${error.message}`);
    throw error;
  }
  const byPath = new Map(entries.filter(e => !e.folder).map(e => [e.parts.join('/'), e]));
  let unpacked = 0;
  const readBytes = async (path: string): Promise<Uint8Array | null> => {
    const e = byPath.get(path.replace(/^\.?\/+/, ''));
    if (!e) return null;
    unpacked += e.size;
    if (unpacked > MAX_UNPACKED) throw new OdtProblem('This document unpacks to more than 200 MB, which is more than Write opens.');
    return e.read();
  };
  const sources = new Map<XmlEl, string>();
  const readXml = async (path: string): Promise<XmlEl | null> => {
    const data = await readBytes(path);
    if (!data) return null;
    try {
      const text = new TextDecoder('utf-8').decode(data);
      const tree = parseXml(text);
      sources.set(tree, text);
      return tree;
    } catch (error) {
      if (error instanceof XmlProblem) throw new OdtProblem(`Part of this file (${path}) is damaged: ${error.message}`);
      throw error;
    }
  };
  const content = await readXml('content.xml');
  if (!content) throw new OdtProblem('This is not an OpenDocument text file (it has no content.xml).');
  const stylesPart = await readXml('styles.xml');
  const dropped = new Set<string>();

  // Styles: the file's named styles (styles.xml) and the ones written for the text (content.xml).
  const styles = new Map<string, Style>();
  const listStyles = new Map<string, Map<number, boolean>>();
  const readStyles = (root: XmlEl | null | undefined) => {
    if (!root) return;
    for (const st of children(root, 'style')) {
      const name = attr(st, 'style:name');
      if (!name) continue;
      const tp = child(st, 'text-properties');
      const pp = child(st, 'paragraph-properties');
      const text: TextLook = {};
      if (tp) {
        const w = attr(tp, 'fo:font-weight');
        if (w) text.bold = w === 'bold' || Number(w) >= 600;
        const s = attr(tp, 'fo:font-style');
        if (s) text.italic = s === 'italic' || s === 'oblique';
        const u = attr(tp, 'style:text-underline-style');
        if (u) text.underline = u !== 'none';
        const t = attr(tp, 'style:text-line-through-style');
        if (t) text.strike = t !== 'none';
        const c = readColour(attr(tp, 'fo:color'));
        if (c) text.colour = c;
        const size = lengthPt(attr(tp, 'fo:font-size'));
        if (size) text.size = size;
        const face = attr(tp, 'style:font-name') ?? attr(tp, 'fo:font-family');
        if (face) text.face = face.replace(/^["']|["']$/g, '');
        const bg = readColour(attr(tp, 'fo:background-color'));
        if (bg) text.highlight = bg;
        const pos = attr(tp, 'style:text-position');
        if (pos) text.vert = /^(super|\d)/.test(pos) && !pos.startsWith('0') ? 'super' : /^(sub|-)/.test(pos) ? 'sub' : undefined;
      }
      const para: ParaLook = {};
      if (pp) {
        const al = attr(pp, 'fo:text-align');
        if (al) para.align = al === 'center' ? 'center' : al === 'end' || al === 'right' ? 'right' : al === 'justify' ? 'justify' : null;
        const b = lengthPt(attr(pp, 'fo:margin-top'));
        if (b !== null) para.before = b;
        const a = lengthPt(attr(pp, 'fo:margin-bottom'));
        if (a !== null) para.after = a;
        const lh = attr(pp, 'fo:line-height');
        const pct = lh ? /^(\d+(?:\.\d+)?)%$/.exec(lh) : null;
        if (pct) para.line = Number(pct[1]) / 100;
        const l = lengthPt(attr(pp, 'fo:margin-left'));
        if (l !== null) para.indent = l;
        const f = lengthPt(attr(pp, 'fo:text-indent'));
        if (f !== null) para.first = f;
        if (attr(pp, 'fo:break-before') === 'page') para.breakBefore = true;
        if (attr(pp, 'fo:break-after') === 'page') para.breakAfter = true;
      }
      const cell = child(st, 'table-cell-properties');
      const col = child(st, 'table-column-properties');
      styles.set(name, {
        family: attr(st, 'style:family') ?? '',
        parent: attr(st, 'style:parent-style-name'),
        display: attr(st, 'style:display-name'),
        text,
        para,
        fill: readColour(attr(cell, 'fo:background-color')) ?? undefined,
        width: lengthPt(attr(col, 'style:column-width')) ?? undefined,
        list: attr(st, 'style:list-style-name'),
      });
    }
    for (const ls of children(root, 'list-style')) {
      const name = attr(ls, 'style:name');
      if (!name) continue;
      const levels = new Map<number, boolean>();
      for (const lv of ls.kids) {
        const level = Number(attr(lv, 'text:level') ?? 1);
        levels.set(level, lv.name === 'list-level-style-bullet');
      }
      listStyles.set(name, levels);
    }
  };
  readStyles(child(stylesPart ?? undefined, 'styles'));
  readStyles(child(stylesPart ?? undefined, 'automatic-styles'));
  readStyles(child(content, 'automatic-styles'));

  /** A style with what it inherits (at most 20 deep, never in a circle). */
  const resolved = (name: string | undefined): Style => {
    const chain: Style[] = [];
    const seen = new Set<string>();
    let cur = name;
    while (cur && !seen.has(cur) && chain.length < 20) {
      seen.add(cur);
      const s = styles.get(cur);
      if (!s) break;
      chain.unshift(s);
      cur = s.parent;
    }
    const out: Style = { family: '', text: {}, para: {} };
    for (const s of chain) {
      out.text = { ...out.text, ...s.text };
      out.para = { ...out.para, ...s.para };
      if (s.fill) out.fill = s.fill;
      if (s.width) out.width = s.width;
      if (s.list) out.list = s.list;
      out.display = s.display ?? out.display;
    }
    // The base for paragraph styles: the file's default paragraph style.
    return out;
  };
  const defaults = (() => {
    const d = children(child(stylesPart ?? undefined, 'styles'), 'default-style').find(s => attr(s, 'style:family') === 'paragraph');
    const tp = child(d, 'text-properties');
    return { size: lengthPt(attr(tp, 'fo:font-size')) ?? 12, face: (attr(tp, 'style:font-name') ?? 'Liberation Serif').replace(/^["']|["']$/g, '') };
  })();

  const ourStyle = (name: string | undefined, outline: number | null): StyleId => {
    const s = name ? styles.get(name) : undefined;
    const label = (s?.display ?? name ?? '').toLowerCase().replace(/_20_/g, ' ');
    if (label === 'title') return 'title';
    // Heading 1 to 6 as they are; 7 to 10 show as Heading 6.
    const level = (n: number): StyleId => `h${Math.max(1, Math.min(6, n))}` as StyleId;
    if (outline !== null) return level(outline);
    const m = /^heading\s*(\d+)$/.exec(label);
    if (m) return level(Number(m[1]));
    return 'normal';
  };

  const marksFor = (look: TextLook, style: StyleId): MarkJSON[] => {
    const s = STYLES[style];
    const out: MarkJSON[] = [];
    const face = look.face ?? defaults.face;
    if (face.toLowerCase() !== s.face.toLowerCase() && /^[A-Za-z0-9][A-Za-z0-9 \-]{0,30}$/.test(face)) out.push({ type: 'font', attrs: { face } });
    const size = look.size ?? defaults.size;
    if (Math.abs(size - s.size) > 0.05) out.push({ type: 'size', attrs: { pt: Math.round(size * 2) / 2 } });
    const colour = look.colour ?? '#000000';
    if (colour !== (s.colour ?? '#000000')) out.push({ type: 'color', attrs: { value: colour } });
    if (look.highlight && look.highlight !== '#ffffff') out.push({ type: 'highlight', attrs: { value: look.highlight } });
    if (look.bold) out.push({ type: 'strong' });
    if (look.italic) out.push({ type: 'em' });
    if (look.underline) out.push({ type: 'underline' });
    if (look.strike) out.push({ type: 'strike' });
    if (look.vert) out.push({ type: 'vert', attrs: { pos: look.vert } });
    return out;
  };

  const src = sources.get(content) ?? '';
  /** An element's children and the text between them, in order. */
  const mixed = (el: XmlEl): Array<string | XmlEl> => {
    const out: Array<string | XmlEl> = [];
    if (el.start === undefined || el.end === undefined) return el.kids;
    let at = src.indexOf('>', el.start) + 1;
    for (const k of el.kids) {
      if (k.start! > at) out.push(unescapeXml(src.slice(at, k.start)));
      out.push(k);
      at = k.end!;
    }
    const close = src.lastIndexOf('<', el.end - 1);
    if (close > at) out.push(unescapeXml(src.slice(at, close)));
    return out;
  };

  const inline = async (el: XmlEl, look: TextLook, style: StyleId, into: NodeJSON[]): Promise<void> => {
    const push = (text: string) => {
      if (!text) return;
      const marks = marksFor(look, style);
      const last = into[into.length - 1];
      if (last?.type === 'text' && JSON.stringify(last.marks ?? []) === JSON.stringify(marks)) last.text += text;
      else into.push(marks.length ? { type: 'text', text, marks } : { type: 'text', text });
    };
    for (const part of mixed(el)) {
      if (typeof part === 'string') {
        // Spaces and line breaks in the file's own layout collapse to one space, as in a browser.
        push(part.replace(/[ \t\r\n]+/g, ' '));
        continue;
      }
      switch (part.name) {
        case 'span': await inline(part, { ...look, ...resolved(attr(part, 'text:style-name')).text }, style, into); break;
        case 'a': case 'bookmark-ref': case 'reference-ref': case 'sequence': case 'date': case 'time': case 'page-number': case 'page-count': case 'chapter': case 'title': case 'author-name':
          await inline(part, look, style, into);
          break;
        case 's': push(' '.repeat(Math.min(200, Number(attr(part, 'text:c') ?? 1)))); break;
        case 'tab': push('\t'); break;
        case 'line-break': into.push({ type: 'hard_break' }); break;
        case 'note': dropped.add('footnotes and endnotes'); break;
        case 'annotation': dropped.add('comments'); break;
        case 'frame': {
          const img = child(part, 'image');
          const href = attr(img, 'xlink:href');
          if (!img || !href) {
            dropped.add(child(part, 'text-box') ? 'text boxes' : 'drawings and shapes');
            break;
          }
          const data = /^https?:/i.test(href) ? null : await readBytes(href);
          const id = data ? addPicture(data) : null;
          if (!id) {
            dropped.add('pictures in a kind Write cannot show (or linked from outside the file)');
            break;
          }
          const w = lengthPt(attr(part, 'svg:width'));
          const h = lengthPt(attr(part, 'svg:height'));
          into.push({ type: 'image', attrs: { src: id, width: w ? Math.round((w * 4) / 3) : null, height: h ? Math.round((h * 4) / 3) : null, alt: '' } });
          break;
        }
        case 'custom-shape': case 'rect': case 'ellipse': case 'line': case 'g': dropped.add('drawings and shapes'); break;
        default: break;
      }
    }
  };

  const paragraph = async (el: XmlEl, inList: boolean): Promise<{ node: NodeJSON; before: boolean; after: boolean }> => {
    const styleName = attr(el, 'text:style-name');
    const outline = el.name === 'h' ? Number(attr(el, 'text:outline-level') ?? 1) : null;
    const style = ourStyle(styleName, outline);
    const look = resolved(styleName);
    const s = STYLES[style];
    const attrs: Record<string, unknown> = { style };
    const p = look.para;
    if (p.align) attrs.align = p.align;
    if (p.before !== undefined && Math.abs(p.before - s.before) > 0.05) attrs.before = Math.round(p.before * 10) / 10;
    if (p.after !== undefined && Math.abs(p.after - s.after) > 0.05) attrs.after = Math.round(p.after * 10) / 10;
    if (p.line !== undefined && Math.abs(p.line - s.line) > 0.01 && p.line >= 0.5 && p.line <= 5) attrs.line = p.line;
    if (!inList && p.indent && p.indent > 0) attrs.indent = Math.round(p.indent * 10) / 10;
    if (!inList && p.first) attrs.first = Math.round(p.first * 10) / 10;
    const content: NodeJSON[] = [];
    await inline(el, look.text, style, content);
    // Leading and trailing spaces from the file's layout are not text.
    if (content[0]?.type === 'text') content[0].text = content[0].text!.replace(/^ +/, '');
    const last = content[content.length - 1];
    if (last?.type === 'text') last.text = last.text!.replace(/ +$/, '');
    const kept = content.filter(c => c.type !== 'text' || c.text);
    return { node: kept.length ? { type: 'paragraph', attrs, content: kept } : { type: 'paragraph', attrs }, before: !!p.breakBefore, after: !!p.breakAfter };
  };

  const list = async (el: XmlEl, styleName: string | undefined, level: number): Promise<NodeJSON> => {
    const name = attr(el, 'text:style-name') ?? styleName;
    const bullet = listStyles.get(name ?? '')?.get(level) ?? true;
    const items: NodeJSON[] = [];
    for (const item of el.kids) {
      if (item.name !== 'list-item' && item.name !== 'list-header') continue;
      const blocks: NodeJSON[] = [];
      for (const k of item.kids) {
        if (k.name === 'p' || k.name === 'h') blocks.push((await paragraph(k, true)).node);
        else if (k.name === 'list') blocks.push(await list(k, name, level + 1));
      }
      if (!blocks.length || blocks[0].type !== 'paragraph') blocks.unshift({ type: 'paragraph' });
      items.push({ type: 'list_item', content: blocks });
    }
    if (!items.length) items.push({ type: 'list_item', content: [{ type: 'paragraph' }] });
    return bullet ? { type: 'bullet_list', content: items } : { type: 'ordered_list', attrs: { order: 1 }, content: items };
  };

  const table = async (el: XmlEl, depth: number): Promise<NodeJSON> => {
    const widths: number[] = [];
    const rows: NodeJSON[] = [];
    const walkRows = (parent: XmlEl, out: XmlEl[]) => {
      for (const k of parent.kids) {
        if (k.name === 'table-row') out.push(k);
        else if (k.name === 'table-header-rows' || k.name === 'table-rows' || k.name === 'table-row-group') walkRows(k, out);
        else if (k.name === 'table-column') {
          const w = resolved(attr(k, 'table:style-name')).width;
          for (let r = 0; r < Math.min(100, Number(attr(k, 'table:number-columns-repeated') ?? 1)); r++) widths.push(w ? Math.round((w * 4) / 3) : 0);
        }
      }
    };
    const trs: XmlEl[] = [];
    walkRows(el, trs);
    for (const tr of trs.slice(0, 2000)) {
      const cells: NodeJSON[] = [];
      let col = 0;
      for (const tc of tr.kids) {
        if (tc.name === 'covered-table-cell') {
          col++;
          continue;
        }
        if (tc.name !== 'table-cell') continue;
        const span = Math.max(1, Math.min(63, Number(attr(tc, 'table:number-columns-spanned') ?? 1)));
        const down = Math.max(1, Math.min(500, Number(attr(tc, 'table:number-rows-spanned') ?? 1)));
        const blocks = await body(tc, depth + 1);
        const w = widths.slice(col, col + span);
        cells.push({
          type: 'table_cell',
          attrs: { colspan: span, rowspan: down, colwidth: w.length === span && w.every(x => x > 0) ? w : null, background: resolved(attr(tc, 'table:style-name')).fill ?? null },
          content: blocks.length ? blocks : [{ type: 'paragraph' }],
        });
        col += span;
      }
      if (cells.length) rows.push({ type: 'table_row', content: cells });
    }
    if (!rows.length) return { type: 'paragraph' };
    return { type: 'table', attrs: { borders: true }, content: rows };
  };

  async function body(el: XmlEl, depth: number): Promise<NodeJSON[]> {
    const out: NodeJSON[] = [];
    for (const k of el.kids) {
      if (k.name === 'p' || k.name === 'h') {
        const p = await paragraph(k, false);
        if (p.before && out.length) out.push({ type: 'page_break' });
        out.push(p.node);
        if (p.after) out.push({ type: 'page_break' });
      } else if (k.name === 'list') out.push(await list(k, undefined, 1));
      else if (k.name === 'table') {
        if (depth > 6) dropped.add('tables inside tables more than six deep');
        else out.push(await table(k, depth));
      } else if (k.name === 'section' || k.name === 'index-body' || k.name === 'table-of-content' || k.name === 'alphabetical-index' || k.name === 'illustration-index') {
        out.push(...(await body(k, depth)));
      } else if (k.name === 'soft-page-break' || k.name === 'sequence-decls' || k.name === 'variable-decls' || k.name === 'user-field-decls' || k.name === 'tracked-changes') {
        if (k.name === 'tracked-changes') dropped.add('tracked changes (shown as the text stands)');
      } else if (k.name === 'frame') {
        const holder: NodeJSON[] = [];
        await inline({ ...k, kids: [k], start: undefined, end: undefined }, {}, 'normal', holder);
        if (holder.length) out.push({ type: 'paragraph', content: holder });
      }
    }
    return out;
  }

  const text = child(child(content, 'body'), 'text');
  if (!text) throw new OdtProblem('This OpenDocument file has no text (it may be a spreadsheet or a presentation).');
  const blocks = await body(text, 0);

  // The page: the first master page's layout, header and footer.
  const page = defaultPage();
  const master = children(child(stylesPart ?? undefined, 'master-styles'), 'master-page')[0];
  const layouts = children(child(stylesPart ?? undefined, 'automatic-styles'), 'page-layout');
  const layout = layouts.find(l => attr(l, 'style:name') === attr(master, 'style:page-layout-name')) ?? layouts[0];
  const lp = child(layout, 'page-layout-properties');
  if (lp) {
    const w = lengthPt(attr(lp, 'fo:page-width'));
    const h = lengthPt(attr(lp, 'fo:page-height'));
    if (w && h) {
      const short = Math.min(w, h);
      const long = Math.max(w, h);
      let best: Paper = page.paper;
      let gap = Infinity;
      for (const k of Object.keys(PAPERS) as Paper[]) {
        const d = Math.abs(PAPERS[k].w - short) + Math.abs(PAPERS[k].h - long);
        if (d < gap) {
          gap = d;
          best = k;
        }
      }
      page.paper = best;
      page.orient = w > h ? 'landscape' : 'portrait';
    }
    const inch = (name: string, d: number) => {
      const v = lengthPt(attr(lp, name));
      return v === null ? d : v / 72;
    };
    page.margins = { ...page.margins, t: inch('fo:margin-top', page.margins.t), b: inch('fo:margin-bottom', page.margins.b), l: inch('fo:margin-left', page.margins.l), r: inch('fo:margin-right', page.margins.r) };
  }
  const line = (el: XmlEl | undefined): HeaderLine => {
    const words: string[] = [];
    const walk = (e: XmlEl) => {
      for (const part of mixedOf(e)) {
        if (typeof part === 'string') words.push(part);
        else if (part.name === 'page-number') words.push('&P');
        else if (part.name === 'page-count') words.push('&N');
        else if (part.name === 'tab') words.push('\t');
        else walk(part);
      }
    };
    const p = el ? (children(el, 'p')[0] ?? children(el, 'h')[0]) : undefined;
    if (!p) return { l: '', c: '', r: '' };
    walk(p);
    const segs = words.join('').split('\t').map(t => t.trim());
    return segs.length === 1 ? { l: '', c: segs[0], r: '' } : { l: segs[0], c: segs[1] ?? '', r: segs.slice(2).join(' ') };
  };
  const stylesSrc = stylesPart ? sources.get(stylesPart) ?? '' : '';
  const mixedOf = (el: XmlEl): Array<string | XmlEl> => {
    if (el.start === undefined || el.end === undefined) return el.kids;
    const out: Array<string | XmlEl> = [];
    let at = stylesSrc.indexOf('>', el.start) + 1;
    for (const k of el.kids) {
      if (k.start! > at) out.push(unescapeXml(stylesSrc.slice(at, k.start)));
      out.push(k);
      at = k.end!;
    }
    const close = stylesSrc.lastIndexOf('<', el.end - 1);
    if (close > at) out.push(unescapeXml(stylesSrc.slice(at, close)));
    return out;
  };
  page.header = line(child(master, 'header'));
  page.footer = line(child(master, 'footer'));
  return { doc: { type: 'doc', content: blocks.length ? blocks : [{ type: 'paragraph' }] }, page: cleanPage(page), dropped: [...dropped] };
}
