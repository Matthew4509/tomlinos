// Shows an HTML email safely. The HTML is parsed into an inert document (nothing in it runs or loads while parsed),
// then copied element by element into new elements, keeping only an allow-list of plain tags and no attributes except
// checked link addresses and table spans. Scripts, styles, forms, frames and event handlers never make it across.
// Pictures from the web are not loaded: they would tell the sender when and where the mail was read. Pictures sent
// inside the mail (cid:) are shown from the attachment itself.
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
}

/** `inline` maps a cid (without <>) to an address of that picture's bytes (a blob: URL the caller made). */
export function safeHtml(html: string, doc: Document, inline: Map<string, string> = new Map()): SafeResult {
  // Styles are removed before parsing: the page's policy would block them anyway, but each block is reported as an
  // error, which hides real ones. (The allow-list below is what makes the result safe, not this.)
  const unstyled = html.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '').replace(/\sstyle\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  const parsed = parseInert(unstyled);
  const frag = doc.createDocumentFragment();
  let blocked = 0;
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
        const url = cid ? inline.get(cid.replace(/^<|>$/g, '')) : undefined;
        if (url) {
          const img = doc.createElement('img');
          img.src = url;
          img.alt = el.getAttribute('alt') ?? '';
          img.className = 'mail-inline-pic';
          to.appendChild(img);
        } else if (src) {
          blocked++;
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
  return { fragment: frag, blocked };
}
