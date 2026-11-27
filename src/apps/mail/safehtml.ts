// Shows an HTML email safely. The HTML is parsed into an inert document (nothing in it runs or loads while parsed),
// then copied element by element into new elements, keeping only an allow-list of plain tags and no attributes except
// checked link addresses and table spans. Scripts, styles, forms, frames and event handlers never make it across.
// Pictures from the web are not loaded: they would tell the sender when and where the mail was read. Pictures sent
// inside the mail (cid:, or written into the message itself as data:) are shown from their own bytes, through a blob:
// address the caller makes; nothing is fetched.
import { parseInert } from '../../core/inert.ts';

const KEEP = new Set([
  'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'cite', 'code', 'dd', 'del', 'div', 'dl', 'dt', 'em', 'font', 'h1', 'h2',
  'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'ins', 'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'small', 'span', 'strike', 'strong',
  'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul', 'center', 'section', 'article', 'header',
  'footer', 'main', 'figure', 'figcaption',
]);
/** Dropped with everything inside them. */
const DROP = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'input', 'button', 'select', 'textarea', 'svg', 'math', 'head', 'title', 'meta', 'link', 'base', 'video', 'audio', 'canvas', 'dialog']);

export function safeLink(href: string | null): string | null {
  const h = (href ?? '').trim();
  return /^(https?:\/\/|mailto:)[^\s"'<>]*$/i.test(h) ? h : null;
}

export interface SafeResult {
  fragment: DocumentFragment;
  /** Pictures from the web that were left out. */
  blocked: number;
  /** Pictures inside the mail (data:) that could not be shown. They load nothing from the web. */
  unshown: number;
}

/** The picture kinds shown from a mail's own bytes. */
const PICTURE = /^image\/(png|jpeg|gif|webp)$/;
/** A data: picture bigger than this (as base64) is not shown. */
const MAX_DATA_PIC = 8 * 1024 * 1024;

/** "data:image/png;base64,..." -> its type and bytes; null for anything else (an SVG, which can carry script, say). */
export function dataPicture(src: string): { type: string; data: Uint8Array } | null {
  if (src.length > MAX_DATA_PIC) return null;
  const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]*)$/i.exec(src.trim());
  if (!m || !PICTURE.test(m[1].toLowerCase())) return null;
  try {
    const bin = atob(m[2].replace(/\s+/g, ''));
    const data = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
    return { type: m[1].toLowerCase(), data };
  } catch {
    return null;
  }
}

/**
 * The HTML as it is handed to the parser: styles and on...= handlers (onclick, onerror) taken out first. The page's
 * policy would block them anyway, but the browser reports each one as a security error while parsing, which hides
 * real errors. (The allow-list in safeHtml is what makes the result safe, not this.)
 */
export function preStrip(html: string): string {
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/\s(?:style|on[a-z]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    // A slash counts as a space inside a tag (<img/onerror=...), but only right after the tag's name or a closing quote:
    // anywhere else it is part of an address (href="https://example.com/online=1").
    .replace(/(?<=<[a-z][^\s/>]*|["'])\/(?:style|on[a-z]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, ' ');
}

/**
 * `inline` maps a cid (without <>) to an address of that picture's bytes (a blob: URL the caller made); `embed` turns
 * a picture written into the mail (data:) into such an address, or gives null to leave it out.
 */
export function safeHtml(html: string, doc: Document, inline: Map<string, string> = new Map(), embed?: (type: string, data: Uint8Array) => string | null): SafeResult {
  const parsed = parseInert(preStrip(html));
  const frag = doc.createDocumentFragment();
  let blocked = 0;
  let unshown = 0;
  let count = 0;

  const copy = (from: Node, to: Node, depth: number) => {
    for (const child of Array.from(from.childNodes)) {
      if (++count > 20000 || depth > 60) return;
      if (child.nodeType === Node.TEXT_NODE) {
        to.appendChild(doc.createTextNode(child.textContent ?? ''));
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const el = child as Element;
      const tag = el.tagName.toLowerCase();
      if (DROP.has(tag)) continue;
      if (tag === 'img') {
        const src = el.getAttribute('src') ?? '';
        const cid = /^cid:(.+)$/i.exec(src)?.[1];
        const isData = /^\s*data:/i.test(src);
        const pic = isData ? dataPicture(src) : null;
        const url = cid ? inline.get(cid.replace(/^<|>$/g, '')) : pic && embed ? embed(pic.type, pic.data) ?? undefined : undefined;
        if (url) {
          const img = doc.createElement('img');
          img.src = url;
          img.alt = el.getAttribute('alt') ?? '';
          img.className = 'mail-inline-pic';
          to.appendChild(img);
        } else if (src) {
          if (isData || cid) unshown++;
          else blocked++;
          const alt = (el.getAttribute('alt') ?? '').trim();
          if (alt) to.appendChild(doc.createTextNode(`[${alt}]`));
        }
        continue;
      }
      if (!KEEP.has(tag)) {
        // Unknown wrappers keep their text.
        copy(el, to, depth + 1);
        continue;
      }
      const href = tag === 'a' ? safeLink(el.getAttribute('href')) : null;
      // A link to anything but a web or mail address is shown as its words only.
      const out = doc.createElement(tag === 'font' || tag === 'center' || (tag === 'a' && !href) ? 'span' : tag);
      if (tag === 'a') {
        if (href) {
          out.setAttribute('href', href);
          out.setAttribute('target', '_blank');
          out.setAttribute('rel', 'noopener noreferrer');
          out.setAttribute('title', href);
        }
      }
      if (tag === 'td' || tag === 'th') {
        for (const a of ['colspan', 'rowspan']) {
          const v = el.getAttribute(a);
          if (v && /^\d{1,2}$/.test(v)) out.setAttribute(a, v);
        }
      }
      copy(el, out, depth + 1);
      to.appendChild(out);
    }
  };
  copy(parsed.body, frag, 0);
  return { fragment: frag, blocked, unshown };
}

/** Tags that start a new line of their own in the words of an HTML mail. */
const BLOCK = new Set(['address', 'article', 'aside', 'blockquote', 'center', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'ol', 'p', 'pre', 'section', 'table', 'tr', 'ul']);
/** Of those, the ones with a blank line around them. */
const PARA = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'table', 'ul', 'ol', 'pre']);

/**
 * The words of an HTML mail as plain text, for quoting in a reply or a forward: a line for each paragraph and line
 * break, and nothing from style sheets, scripts or anything else safeHtml drops. Read from an inert document, as
 * safeHtml is; nothing runs or loads.
 */
export function htmlToText(html: string): string {
  const parsed = parseInert(preStrip(html));
  let out = '';
  let count = 0;
  const atLineStart = () => out === '' || out.endsWith('\n');
  const trimEnd = () => (out = out.replace(/ +$/, ''));
  const brk = (n: number) => {
    const have = /\n*$/.exec(out)?.[0].length ?? 0;
    if (out.length && have < n) out += '\n'.repeat(n - have);
  };
  const walk = (node: Node, depth: number, pre: boolean) => {
    for (const child of Array.from(node.childNodes)) {
      if (++count > 20000 || depth > 60) return;
      if (child.nodeType === Node.TEXT_NODE) {
        const t = child.textContent ?? '';
        if (pre) out += t;
        else {
          const squeezed = t.replace(/\s+/g, ' ');
          out += atLineStart() ? squeezed.replace(/^ /, '') : squeezed;
        }
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const el = child as Element;
      const tag = el.tagName.toLowerCase();
      if (DROP.has(tag)) continue;
      if (tag === 'br') {
        trimEnd();
        out += '\n';
        continue;
      }
      if (tag === 'img') {
        const alt = (el.getAttribute('alt') ?? '').trim();
        if (alt) out += `[${alt}]`;
        continue;
      }
      const block = BLOCK.has(tag);
      if (block) {
        trimEnd();
        brk(PARA.has(tag) ? 2 : 1);
      }
      if ((tag === 'td' || tag === 'th') && !atLineStart()) out += ' ';
      walk(el, depth + 1, pre || tag === 'pre');
      if (block) {
        trimEnd();
        brk(PARA.has(tag) ? 2 : 1);
      }
    }
  };
  walk(parsed.body, 0, false);
  return out.replace(/\n{3,}/g, '\n\n').trim();
}
