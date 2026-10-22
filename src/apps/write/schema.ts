// What a Write document can hold, for the editor (ProseMirror): paragraphs with a style (Normal, Title, Heading
// 1-3) and their own alignment, spacing and indents; bulleted and numbered lists; tables; page breaks; line breaks;
// pictures; and runs of text in bold, italic, underline, strikethrough, raised or lowered, in a typeface, size, colour
// and highlight. Pasted HTML (from a web page or from Word) is read through the same rules, so only these things come
// in: everything else (scripts, event handlers, outside pictures, unknown tags) is dropped. Styles in pasted HTML are
// read from the style attribute's text, never applied to anything first: before pasted HTML is parsed, each style
// attribute is renamed data-wp-style (pastedHtml), so the page's security policy never sees an inline style to refuse.
import { cleanFace, cssFamily } from '../sheet/fonts.ts';
import { linkHref, NUMBER_KINDS, NUMBER_SHAPES, STYLE_IDS, type StyleId } from './model.ts';
import { imageByUrl, imageUrl } from './images.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type PM = Record<string, any>;

/**
 * Word's "single" line spacing is the typeface's own line height, about 1.15 times the type size for Calibri; CSS's
 * line-height 1 is the size itself. So a multiple of single is drawn as that multiple of this.
 */
export const LINE_CSS = 1.15;

/** Pasted HTML with every tag's style attribute renamed data-wp-style (read by the rules below, never applied). */
export function pastedHtml(html: string): string {
  // One pass over the text (patterns over thousands of unclosed tags could take minutes on a crafted clipboard).
  const lower = html.toLowerCase();
  let out = '';
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (lower.startsWith('<style', lt) && !/[a-z0-9-]/.test(lower[lt + 6] ?? '')) {
      const end = lower.indexOf('</style>', lt);
      i = end < 0 ? html.length : end + 8;
      continue;
    }
    const gt = html.indexOf('>', lt);
    if (gt < 0) {
      out += html.slice(lt);
      break;
    }
    const tag = html.slice(lt, gt + 1);
    out += /^<[a-zA-Z]/.test(tag) ? tag.replace(/(\s)style(\s*=)/gi, '$1data-wp-style$2') : tag;
    i = gt + 1;
  }
  return out;
}

/** An element's CSS: its renamed (pasted) style attribute, or its own. */
const styleOf = (el: HTMLElement): string | null => el.getAttribute('data-wp-style') ?? el.getAttribute('style');

/** "font-size: 12pt; color: red" as { 'font-size': '12pt', color: 'red' } (names in lower case, values trimmed). */
export function readCss(text: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!text) return out;
  for (const part of text.split(';')) {
    const i = part.indexOf(':');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim().toLowerCase();
    const value = part.slice(i + 1).trim().replace(/\s*!important$/i, '');
    if (name && value) out[name] = value;
  }
  return out;
}

/** A CSS length ("12pt", "16px", "0.5in", "1cm", "1.2em" at 11 points) in points; null when it does not read. */
export function lengthPt(value: string | undefined, em = 11): number | null {
  if (!value) return null;
  const m = /^(-?\d*\.?\d+)\s*(pt|px|in|cm|mm|em|rem|pc)?$/i.exec(value.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? 'px').toLowerCase();
  const k = { pt: 1, px: 0.75, in: 72, cm: 72 / 2.54, mm: 72 / 25.4, em, rem: 12, pc: 12 }[unit] ?? 0.75;
  const pt = Math.round(n * k * 100) / 100;
  return Number.isFinite(pt) ? pt : null;
}

const NAMED: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00', cyan: '#00ffff',
  aqua: '#00ffff', magenta: '#ff00ff', fuchsia: '#ff00ff', gray: '#808080', grey: '#808080', silver: '#c0c0c0', maroon: '#800000',
  navy: '#000080', olive: '#808000', purple: '#800080', teal: '#008080', lime: '#00ff00', orange: '#ffa500', darkblue: '#00008b',
  darkred: '#8b0000', darkgreen: '#006400', darkcyan: '#008b8b', darkmagenta: '#8b008b', darkgray: '#a9a9a9', darkgrey: '#a9a9a9',
  lightgray: '#d3d3d3', lightgrey: '#d3d3d3', darkyellow: '#808000',
};

/** A CSS colour (#rgb, #rrggbb, rgb(), a common name) as #rrggbb; null for anything else (transparent, inherit...). */
export function readColour(value: string | undefined): string | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (NAMED[v]) return NAMED[v];
  let m = /^#([0-9a-f]{6})$/.exec(v);
  if (m) return `#${m[1]}`;
  m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v);
  if (m) return `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`;
  m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(v);
  if (m) {
    if (m[4] !== undefined && parseFloat(m[4]) === 0) return null;
    return `#${[m[1], m[2], m[3]].map(x => Math.min(255, Number(x)).toString(16).padStart(2, '0')).join('')}`;
  }
  return null;
}

/** How light a #rrggbb colour is, 0 (black) to 1 (white). */
export function lightness(hex: string): number {
  const v = parseInt(hex.slice(1), 16);
  return (0.299 * (v >> 16) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255)) / 255;
}

const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', '-apple-system', 'blinkmacsystemfont', 'inherit', 'initial', 'unset', 'ui-sans-serif', 'ui-serif', 'ui-monospace']);

/** The first real typeface in a CSS font-family list ("Arial", sans-serif is Arial). */
export function readFace(value: string | undefined): string | null {
  if (!value) return null;
  for (const part of value.split(',')) {
    const name = part.trim().replace(/^["']|["']$/g, '').trim();
    if (!name || GENERIC.has(name.toLowerCase())) continue;
    return cleanFace(name) ?? null;
  }
  return null;
}

/** Paragraph settings from pasted CSS: alignment, space before and after (points), line spacing, indents (points). */
export function paraAttrs(css: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const align = css['text-align']?.toLowerCase();
  if (align === 'center' || align === 'right' || align === 'justify') out.align = align;
  else if (align === 'left' || align === 'start') out.align = null;
  const before = lengthPt(css['margin-top']);
  const after = lengthPt(css['margin-bottom']);
  if (before !== null && before >= 0 && before <= 200) out.before = before;
  if (after !== null && after >= 0 && after <= 200) out.after = after;
  const lh = css['line-height'];
  if (lh) {
    // A plain number is CSS's own (LINE_CSS times Word's); a percent is Word's own HTML, already a multiple of single.
    const n = Number(lh);
    const pct = /^(\d+(?:\.\d+)?)%$/.exec(lh);
    const line = Number.isFinite(n) && lh.trim() !== '' ? n / LINE_CSS : pct ? Number(pct[1]) / 100 : null;
    if (line !== null && line >= 0.5 && line <= 5) out.line = Math.round(line * 100) / 100;
  }
  const left = lengthPt(css['margin-left'] ?? css['padding-left']);
  if (left !== null && left > 0 && left <= 400) out.indent = left;
  const first = lengthPt(css['text-indent']);
  if (first !== null && first !== 0 && Math.abs(first) <= 200) out.first = first;
  return out;
}

const STYLE_CLASS: Record<string, StyleId> = { msotitle: 'title', msoheading1: 'h1', msoheading2: 'h2', msoheading3: 'h3', msoheading4: 'h4', msoheading5: 'h5', msoheading6: 'h6' };

/** The CSS a paragraph's own settings make (the style's own look comes from its class). */
function paraCss(attrs: Record<string, any>): string {
  const parts: string[] = [];
  if (attrs.align) parts.push(`text-align: ${attrs.align}`);
  if (attrs.before !== null) parts.push(`margin-top: ${attrs.before}pt`);
  if (attrs.after !== null) parts.push(`margin-bottom: ${attrs.after}pt`);
  if (attrs.line !== null) parts.push(`line-height: ${Math.round(attrs.line * LINE_CSS * 1000) / 1000}`);
  if (attrs.indent !== null) parts.push(`margin-left: ${attrs.indent}pt`);
  if (attrs.first !== null) parts.push(`text-indent: ${attrs.first}pt`);
  return parts.join('; ');
}

const markRule = (mark: string, read: (css: Record<string, string>, el: HTMLElement) => Record<string, unknown> | false | null): any => ({
  tag: '[style], [data-wp-style]',
  consuming: false,
  getAttrs: (el: HTMLElement) => read(readCss(styleOf(el)), el) || false,
  mark,
});

const isBlock = (el: HTMLElement) => /^(P|DIV|H[1-6]|LI|UL|OL|TD|TH|TABLE|TR|TBODY|BODY|BLOCKQUOTE|SECTION|ARTICLE)$/.test(el.nodeName);

/** Cell attributes shared by ordinary and heading cells: spans, column widths (pixels), shading. */
const cellAttrs = { colspan: { default: 1 }, rowspan: { default: 1 }, colwidth: { default: null }, background: { default: null } };

function cellFromDom(el: HTMLElement): Record<string, unknown> {
  const widthAttr = el.getAttribute('data-colwidth');
  const widths = widthAttr && /^\d+(,\d+)*$/.test(widthAttr) ? widthAttr.split(',').map(Number) : null;
  const colspan = Math.max(1, Math.min(50, Number(el.getAttribute('colspan')) || 1));
  const css = readCss(styleOf(el));
  const fill = readColour(css['background-color'] ?? css.background);
  return {
    colspan,
    rowspan: Math.max(1, Math.min(500, Number(el.getAttribute('rowspan')) || 1)),
    colwidth: widths && widths.length === colspan ? widths : null,
    background: fill && fill !== '#ffffff' ? fill : null,
  };
}

function cellToDom(tag: 'td' | 'th', node: any): any {
  const attrs: Record<string, string> = {};
  if (node.attrs.colspan !== 1) attrs.colspan = String(node.attrs.colspan);
  if (node.attrs.rowspan !== 1) attrs.rowspan = String(node.attrs.rowspan);
  if (node.attrs.colwidth) attrs['data-colwidth'] = node.attrs.colwidth.join(',');
  if (node.attrs.background) attrs.style = `background-color: ${node.attrs.background}`;
  return [tag, attrs, 0];
}

/** The editor's schema, built from the ProseMirror bundle (loaded when a Write window opens). */
export function buildSchema(pm: PM): any {
  // `word`: the Word style a paragraph had in the file it came from (its look is in the other settings); kept when it
  // is saved back, until another style is chosen.
  const pAttrs = { style: { default: 'normal' }, align: { default: null }, before: { default: null }, after: { default: null }, line: { default: null }, indent: { default: null }, first: { default: null }, word: { default: null } };
  const pRule = (tag: string, style: StyleId | null) => ({
    tag,
    getAttrs: (el: HTMLElement) => {
      const cls = [...el.classList].map(c => c.toLowerCase());
      const own = cls.find(c => c.startsWith('wp-') && STYLE_IDS.includes(c.slice(3) as StyleId));
      const word = cls.map(c => STYLE_CLASS[c]).find(Boolean);
      const kept = el.getAttribute('data-word');
      return { style: own ? own.slice(3) : (word ?? style ?? 'normal'), ...paraAttrs(readCss(styleOf(el))), word: kept && /^[\w .\-]{1,80}$/.test(kept) ? kept : null };
    },
  });
  return new pm.Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: {
        content: 'inline*',
        group: 'block',
        attrs: pAttrs,
        parseDOM: [pRule('p', null), pRule('h1', 'h1'), pRule('h2', 'h2'), pRule('h3', 'h3'), pRule('h4', 'h4'), pRule('h5', 'h5'), pRule('h6', 'h6')],
        toDOM: (node: any) => {
          const css = paraCss(node.attrs);
          const attrs: Record<string, string> = { class: `wp-${node.attrs.style}` };
          if (css) attrs.style = css;
          if (node.attrs.word) attrs['data-word'] = node.attrs.word;
          return ['p', attrs, 0];
        },
      },
      bullet_list: {
        content: 'list_item+',
        group: 'block',
        parseDOM: [{ tag: 'ul' }],
        toDOM: () => ['ul', 0],
      },
      ordered_list: {
        content: 'list_item+',
        group: 'block',
        // kind / shape: how it counts and what goes round the number (null: 1. a. i. by depth); outline: "1.1." with the
        // numbers of the lists it sits in.
        attrs: { order: { default: 1 }, kind: { default: null }, shape: { default: null }, outline: { default: false } },
        parseDOM: [{ tag: 'ol', getAttrs: (el: HTMLElement) => {
          const kind = el.getAttribute('data-kind');
          const shape = el.getAttribute('data-shape');
          return {
            order: Math.max(1, Math.min(10000, Number(el.getAttribute('start')) || 1)),
            kind: NUMBER_KINDS.includes(kind as never) ? kind : null,
            shape: NUMBER_SHAPES.includes(shape as never) ? shape : null,
            outline: el.hasAttribute('data-outline'),
          };
        } }],
        toDOM: (node: any) => {
          const attrs: Record<string, string> = {};
          if (node.attrs.order !== 1) attrs.start = String(node.attrs.order);
          if (node.attrs.kind) attrs['data-kind'] = node.attrs.kind;
          if (node.attrs.shape) attrs['data-shape'] = node.attrs.shape;
          if (node.attrs.outline) attrs['data-outline'] = '';
          return ['ol', attrs, 0];
        },
      },
      list_item: {
        content: 'paragraph block*',
        defining: true,
        parseDOM: [{ tag: 'li' }],
        toDOM: () => ['li', 0],
      },
      table: {
        content: 'table_row+',
        tableRole: 'table',
        isolating: true,
        group: 'block',
        attrs: { borders: { default: true } },
        parseDOM: [{ tag: 'table', getAttrs: (el: HTMLElement) => ({ borders: !el.classList.contains('wp-noborders') }) }],
        toDOM: (node: any) => ['table', { class: node.attrs.borders ? 'wp-table' : 'wp-table wp-noborders' }, ['tbody', 0]],
      },
      table_row: {
        content: '(table_cell | table_header)*',
        tableRole: 'row',
        parseDOM: [{ tag: 'tr' }],
        toDOM: () => ['tr', 0],
      },
      table_cell: {
        content: 'block+',
        attrs: cellAttrs,
        tableRole: 'cell',
        isolating: true,
        parseDOM: [{ tag: 'td', getAttrs: cellFromDom }],
        toDOM: (node: any) => cellToDom('td', node),
      },
      table_header: {
        content: 'block+',
        attrs: cellAttrs,
        tableRole: 'header_cell',
        isolating: true,
        parseDOM: [{ tag: 'th', getAttrs: cellFromDom }],
        toDOM: (node: any) => cellToDom('th', node),
      },
      page_break: {
        group: 'block',
        atom: true,
        selectable: true,
        parseDOM: [{ tag: 'div.wp-break' }, { tag: 'hr.wp-break' }],
        toDOM: () => ['div', { class: 'wp-break', 'aria-label': 'Page break' }],
      },
      // A footnote: its number in the text (worked out from the order), its words at the foot of the page. `id` is the
      // footnote's number in the Word file it came from (0: new), so an unchanged one is written back as it was.
      footnote: {
        inline: true,
        group: 'inline',
        atom: true,
        attrs: { text: { default: '' }, id: { default: 0 } },
        parseDOM: [{ tag: 'sup.wp-fn', getAttrs: (el: HTMLElement) => ({ text: (el.getAttribute('data-note') ?? '').slice(0, 4000), id: 0 }) }],
        toDOM: (node: any) => ['sup', { class: 'wp-fn', 'data-note': node.attrs.text, contenteditable: 'false' }, '#'],
      },
      // A mail merge field: «Name», filled in from a row of the list when letters are made.
      field: {
        inline: true,
        group: 'inline',
        atom: true,
        attrs: { name: { default: '' } },
        parseDOM: [{ tag: 'span.wp-field', getAttrs: (el: HTMLElement) => ({ name: (el.getAttribute('data-field') ?? '').slice(0, 80) }) }],
        toDOM: (node: any) => ['span', { class: 'wp-field', 'data-field': node.attrs.name, contenteditable: 'false' }, `«${node.attrs.name}»`],
      },
      // A contents page: the headings and the pages they are on, kept up to date by the window.
      toc: {
        group: 'block',
        atom: true,
        attrs: { title: { default: 'Contents' } },
        parseDOM: [{ tag: 'div.wp-toc' }],
        toDOM: () => ['div', { class: 'wp-toc', contenteditable: 'false' }],
      },
      // Parts of a Word file Write cannot show (a text box, a chart, a comment, an equation): a grey label in the text,
      // kept and written back exactly as they were. Never made from pasted HTML.
      opaque_inline: {
        inline: true,
        group: 'inline',
        atom: true,
        attrs: { xml: { default: '' }, label: { default: '' } },
        toDOM: (node: any) => ['span', { class: 'wp-opaque', contenteditable: 'false', title: `${node.attrs.label}: kept as it is in the Word file` }, node.attrs.label],
      },
      opaque_block: {
        group: 'block',
        atom: true,
        attrs: { xml: { default: '' }, label: { default: '' } },
        toDOM: (node: any) => ['div', { class: 'wp-opaque-block', contenteditable: 'false', title: 'Kept as it is in the Word file' }, node.attrs.label],
      },
      text: { group: 'inline' },
      hard_break: {
        inline: true,
        group: 'inline',
        selectable: false,
        parseDOM: [{ tag: 'br' }],
        toDOM: () => ['br'],
      },
      image: {
        inline: true,
        group: 'inline',
        atom: true,
        draggable: true,
        attrs: { src: {}, width: { default: null }, height: { default: null }, alt: { default: '' } },
        parseDOM: [{
          tag: 'img[src]',
          // Only pictures this document already holds (copied within Write); a picture from anywhere else is dropped.
          getAttrs: (el: HTMLElement) => {
            const id = el.getAttribute('data-img') ?? '';
            const known = imageUrl(id) ? id : imageByUrl(el.getAttribute('src') ?? '');
            if (!known) return false;
            const w = Number(el.getAttribute('width'));
            const hh = Number(el.getAttribute('height'));
            return { src: known, width: w > 0 ? w : null, height: hh > 0 ? hh : null, alt: (el.getAttribute('alt') ?? '').slice(0, 300) };
          },
        }],
        toDOM: (node: any) => {
          const attrs: Record<string, string> = { src: imageUrl(node.attrs.src) ?? '', alt: node.attrs.alt, class: 'wp-img', 'data-img': node.attrs.src, draggable: 'true' };
          if (node.attrs.width) attrs.width = String(Math.round(node.attrs.width));
          if (node.attrs.height) attrs.height = String(Math.round(node.attrs.height));
          return ['img', attrs];
        },
      },
    },
    marks: {
      // A link to a web page or an email address: the outermost mark, so it wraps the words' own look.
      link: {
        attrs: { href: {} },
        inclusive: false,
        parseDOM: [{ tag: 'a[href]', getAttrs: (el: HTMLElement) => {
          const href = linkHref(el.getAttribute('href') ?? '');
          return href ? { href } : false;
        } }],
        toDOM: (mark: any) => ['a', { href: mark.attrs.href, class: 'wp-link', title: `${mark.attrs.href} (Ctrl+click to open)`, rel: 'noopener noreferrer' }, 0],
      },
      // Typeface, size and colour wrap the others, as a run in Word has them.
      font: {
        attrs: { face: {} },
        parseDOM: [markRule('font', css => {
          const face = readFace(css['font-family']);
          return face ? { face } : false;
        }), { tag: 'font[face]', getAttrs: (el: HTMLElement) => { const face = readFace(el.getAttribute('face') ?? ''); return face ? { face } : false; } }],
        toDOM: (mark: any) => ['span', { style: `font-family: ${cssFamily(mark.attrs.face)}` }, 0],
      },
      size: {
        attrs: { pt: {} },
        parseDOM: [markRule('size', css => {
          const pt = lengthPt(css['font-size']);
          return pt !== null && pt >= 1 && pt <= 400 ? { pt } : false;
        })],
        toDOM: (mark: any) => ['span', { style: `font-size: ${mark.attrs.pt}pt` }, 0],
      },
      color: {
        attrs: { value: {} },
        parseDOM: [markRule('color', css => {
          const c = readColour(css.color);
          // Black is the standard; very light text would vanish on white paper (pasted from a dark page).
          return c && c !== '#000000' && lightness(c) < 0.9 ? { value: c } : false;
        }), { tag: 'font[color]', getAttrs: (el: HTMLElement) => { const c = readColour(el.getAttribute('color') ?? ''); return c && c !== '#000000' ? { value: c } : false; } }],
        toDOM: (mark: any) => ['span', { style: `color: ${mark.attrs.value}` }, 0],
      },
      highlight: {
        attrs: { value: { default: '#ffff00' } },
        parseDOM: [{ tag: 'mark', getAttrs: (el: HTMLElement) => ({ value: readColour(readCss(styleOf(el))['background-color']) ?? '#ffff00' }) },
          markRule('highlight', (css, el) => {
            if (isBlock(el)) return false;
            const c = readColour(css['background-color'] ?? css.background ?? css['mso-highlight']);
            return c && lightness(c) < 0.97 ? { value: c } : false;
          })],
        toDOM: (mark: any) => ['mark', { style: `background-color: ${mark.attrs.value}` }, 0],
      },
      strong: {
        parseDOM: [
          { tag: 'strong' },
          { tag: 'b', getAttrs: (el: HTMLElement) => readCss(styleOf(el))['font-weight'] !== 'normal' && null },
          markRule('strong', css => {
            const w = css['font-weight'];
            return w && (w === 'bold' || w === 'bolder' || Number(w) >= 600) ? {} : false;
          }),
        ],
        toDOM: () => ['strong', 0],
      },
      em: {
        parseDOM: [{ tag: 'i' }, { tag: 'em' }, markRule('em', css => (css['font-style'] === 'italic' || css['font-style'] === 'oblique' ? {} : false))],
        toDOM: () => ['em', 0],
      },
      underline: {
        parseDOM: [{ tag: 'u' }, markRule('underline', css => (/underline/.test(css['text-decoration'] ?? css['text-decoration-line'] ?? '') ? {} : false))],
        toDOM: () => ['u', 0],
      },
      strike: {
        parseDOM: [{ tag: 's' }, { tag: 'strike' }, { tag: 'del' }, markRule('strike', css => (/line-through/.test(css['text-decoration'] ?? css['text-decoration-line'] ?? '') ? {} : false))],
        toDOM: () => ['s', 0],
      },
      vert: {
        attrs: { pos: { default: 'super' } },
        excludes: 'vert',
        parseDOM: [{ tag: 'sup', attrs: { pos: 'super' } }, { tag: 'sub', attrs: { pos: 'sub' } },
          markRule('vert', css => (css['vertical-align'] === 'super' ? { pos: 'super' } : css['vertical-align'] === 'sub' ? { pos: 'sub' } : false))],
        toDOM: (mark: any) => [mark.attrs.pos === 'sub' ? 'sub' : 'sup', 0],
      },
    },
  });
}
