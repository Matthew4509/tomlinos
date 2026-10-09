// Markdown preview for Notepad Pro. The text is parsed by Lezer's CommonMark + GFM parser (from the CodeMirror
// bundle) and the tree is turned into plain element descriptions here, then into page elements with createElement and
// textContent. No HTML string is ever built, so a file cannot put script, styles or frames into the page: HTML written
// inside the markdown is shown as the letters it is. Links go only to http, https and mailto addresses; pictures are
// shown as their description (nothing is fetched).

/** One element to make: a tag with attributes and children, or a piece of text. */
export type MdNode = string | { tag: string; attrs?: Record<string, string>; kids: MdNode[] };

/** The small part of a Lezer tree this needs. */
interface SyntaxNode {
  name: string;
  from: number;
  to: number;
  firstChild: SyntaxNode | null;
  nextSibling: SyntaxNode | null;
}
interface Tree {
  topNode: SyntaxNode;
}
export interface MarkdownParser {
  parse(text: string): Tree;
}

const MARKS = new Set(['HeaderMark', 'EmphasisMark', 'CodeMark', 'LinkMark', 'QuoteMark', 'ListMark', 'StrikethroughMark', 'TableDelimiter', 'CodeInfo', 'LinkTitle', 'LinkLabel']);
const SIMPLE: Record<string, string> = {
  Paragraph: 'p', Emphasis: 'em', StrongEmphasis: 'strong', Strikethrough: 'del', Blockquote: 'blockquote',
  BulletList: 'ul', OrderedList: 'ol', ListItem: 'li', ATXHeading1: 'h1', ATXHeading2: 'h2', ATXHeading3: 'h3',
  ATXHeading4: 'h4', ATXHeading5: 'h5', ATXHeading6: 'h6', SetextHeading1: 'h1', SetextHeading2: 'h2',
};
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', mdash: '—', ndash: '–', hellip: '…' };

/** Only these kinds of address become links. */
export function safeHref(url: string): string | null {
  const u = url.trim().replace(/^<|>$/g, '');
  return /^(https?:\/\/|mailto:)[^\s]*$/i.test(u) ? u : null;
}

function decodeEntity(raw: string): string {
  const m = /^&(#x[0-9a-f]+|#\d+|\w+);$/i.exec(raw);
  if (!m) return raw;
  const body = m[1];
  if (body[0] === '#') {
    const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '�';
  }
  return ENTITIES[body.toLowerCase()] ?? raw;
}

function children(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let c = node.firstChild; c; c = c.nextSibling) out.push(c);
  return out;
}

export function renderMarkdown(text: string, parser: MarkdownParser): MdNode[] {
  const src = text;
  const slice = (from: number, to: number) => src.slice(from, to);

  /** Children of `node` between `from` and `to`, with the plain text between them. */
  function inline(node: SyntaxNode, from = node.from, to = node.to): MdNode[] {
    const out: MdNode[] = [];
    let at = from;
    for (const c of children(node)) {
      if (c.to <= from || c.from >= to) continue;
      if (c.from > at) out.push(slice(at, c.from));
      out.push(...one(c));
      at = Math.max(at, c.to);
    }
    if (at < to) out.push(slice(at, to));
    return out;
  }

  /** Block content: only child nodes count (the gaps are line breaks and indentation). */
  function blocks(node: SyntaxNode): MdNode[] {
    return children(node).flatMap(one);
  }

  function one(node: SyntaxNode): MdNode[] {
    const name = node.name;
    if (MARKS.has(name)) return [];
    switch (name) {
      case 'Document':
        return blocks(node);
      case 'Paragraph':
        return [{ tag: 'p', kids: trimEnds(inline(node)) }];
      case 'Blockquote':
      case 'BulletList':
      case 'ListItem':
        return [{ tag: SIMPLE[name], kids: blocks(node) }];
      case 'OrderedList': {
        const first = children(node)[0];
        const mark = first ? children(first).find(c => c.name === 'ListMark') : undefined;
        const start = mark ? parseInt(slice(mark.from, mark.to), 10) : 1;
        return [{ tag: 'ol', attrs: start !== 1 && Number.isFinite(start) ? { start: String(start) } : {}, kids: blocks(node) }];
      }
      case 'FencedCode':
      case 'CodeBlock': {
        const code = children(node).filter(c => c.name === 'CodeText').map(c => slice(c.from, c.to)).join('\n');
        return [{ tag: 'pre', kids: [{ tag: 'code', kids: [code] }] }];
      }
      case 'InlineCode': {
        const marks = children(node).filter(c => c.name === 'CodeMark');
        const from = marks[0]?.to ?? node.from;
        const to = marks[1]?.from ?? node.to;
        return [{ tag: 'code', kids: [slice(from, to)] }];
      }
      case 'HorizontalRule':
        return [{ tag: 'hr', kids: [] }];
      case 'HardBreak':
        return [{ tag: 'br', kids: [] }];
      case 'Escape':
        return [slice(node.from + 1, node.to)];
      case 'Entity':
        return [decodeEntity(slice(node.from, node.to))];
      case 'Link': {
        const marks = children(node).filter(c => c.name === 'LinkMark');
        const url = children(node).find(c => c.name === 'URL');
        const textFrom = marks[0]?.to ?? node.from;
        const textTo = marks[1]?.from ?? node.to;
        const kids = inline(node, textFrom, textTo);
        const href = url ? safeHref(slice(url.from, url.to)) : null;
        return href ? [{ tag: 'a', attrs: { href, target: '_blank', rel: 'noopener noreferrer' }, kids }] : kids;
      }
      case 'Autolink':
      case 'URL': {
        const raw = slice(node.from, node.to).replace(/^<|>$/g, '');
        const href = safeHref(/^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(raw) ? `mailto:${raw}` : /^www\./i.test(raw) ? `https://${raw}` : raw);
        return href ? [{ tag: 'a', attrs: { href, target: '_blank', rel: 'noopener noreferrer' }, kids: [raw] }] : [raw];
      }
      case 'Image': {
        const marks = children(node).filter(c => c.name === 'LinkMark');
        const alt = slice(marks[0]?.to ?? node.from, marks[1]?.from ?? node.to);
        return [{ tag: 'span', attrs: { class: 'md-image' }, kids: [`[picture: ${alt || 'no description'}]`] }];
      }
      case 'Task': {
        const marker = children(node).find(c => c.name === 'TaskMarker');
        const done = marker ? /x/i.test(slice(marker.from, marker.to)) : false;
        const box: MdNode = { tag: 'input', attrs: { type: 'checkbox', disabled: '', ...(done ? { checked: '' } : {}) }, kids: [] };
        return [box, ' ', ...trimEnds(inline(node, marker ? marker.to : node.from))];
      }
      case 'Table': {
        const rows = children(node).filter(c => c.name === 'TableHeader' || c.name === 'TableRow');
        const head = rows.filter(r => r.name === 'TableHeader').map(r => row(r, 'th'));
        const body = rows.filter(r => r.name === 'TableRow').map(r => row(r, 'td'));
        return [{ tag: 'table', kids: [{ tag: 'thead', kids: head }, { tag: 'tbody', kids: body }] }];
      }
      case 'HTMLBlock':
        return [{ tag: 'pre', attrs: { class: 'md-html' }, kids: [slice(node.from, node.to)] }];
      case 'HTMLTag':
      case 'Comment':
      case 'ProcessingInstruction':
        return [slice(node.from, node.to)];
      case 'LinkReference':
        return [];
      default: {
        const tag = SIMPLE[name];
        if (tag) return [{ tag, kids: tag.startsWith('h') ? trimEnds(inline(node)) : inline(node) }];
        // Anything unknown shows as its text, never dropped silently.
        return children(node).length ? inline(node) : [slice(node.from, node.to)];
      }
    }
  }

  function row(r: SyntaxNode, cell: 'th' | 'td'): MdNode {
    return { tag: 'tr', kids: children(r).filter(c => c.name === 'TableCell').map(c => ({ tag: cell, kids: trimEnds(inline(c)) })) };
  }

  return one(parser.parse(src).topNode);
}

/** Leading and trailing spaces in a heading or paragraph are layout, not content. */
function trimEnds(kids: MdNode[]): MdNode[] {
  const out = [...kids];
  if (typeof out[0] === 'string') out[0] = out[0].replace(/^\s+/, '');
  const last = out.length - 1;
  if (typeof out[last] === 'string') out[last] = (out[last] as string).replace(/\s+$/, '');
  return out.filter(k => k !== '');
}

const ALLOWED_TAGS = new Set(['p', 'em', 'strong', 'del', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'code', 'hr', 'br', 'a', 'span', 'input', 'table', 'thead', 'tbody', 'tr', 'th', 'td']);
const ALLOWED_ATTRS = new Set(['href', 'target', 'rel', 'start', 'class', 'type', 'disabled', 'checked']);

/** Makes page elements from the descriptions. Tags and attributes outside the lists above are refused. */
export function toDom(nodes: MdNode[], doc: Document): DocumentFragment {
  const frag = doc.createDocumentFragment();
  const add = (parent: Node, node: MdNode) => {
    if (typeof node === 'string') {
      parent.appendChild(doc.createTextNode(node));
      return;
    }
    if (!ALLOWED_TAGS.has(node.tag)) {
      node.kids.forEach(k => add(parent, k));
      return;
    }
    const el = doc.createElement(node.tag);
    for (const [k, v] of Object.entries(node.attrs ?? {})) {
      if (!ALLOWED_ATTRS.has(k)) continue;
      if (k === 'href' && safeHref(v) === null) continue;
      el.setAttribute(k, v);
    }
    node.kids.forEach(k => add(el, k));
    parent.appendChild(el);
  };
  nodes.forEach(n => add(frag, n));
  return frag;
}
