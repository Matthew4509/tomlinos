// Markdown (.md) in Write: a .md file opens formatted (headings, bold, italic, strikethrough, code, lists inside
// lists, numbered lists that start part-way, quotes, tables, line breaks) and saves back as Markdown. What Markdown
// cannot hold (colours, sizes, typefaces, alignment, pictures, page breaks) is left out on saving, and the window asks
// first. Our own small reader and writer: common Markdown as people write it, not every corner of the standard.
// No browser needed.
import { linkHref, type MarkJSON, type NodeJSON } from './model.ts';

const CODE_FACE = 'Consolas';

/** While a file is being read: what opening it changes (said to the person, so Save asks before writing over it). */
let changing: Set<string> | undefined;

/** Where `token` next is in `s` from `from`, not counting one written with a backslash before it (\* is a star). */
function unescapedAt(s: string, token: string, from: number): number {
  for (let at = s.indexOf(token, from); at >= 0; at = s.indexOf(token, at + 1)) {
    let slashes = 0;
    while (s[at - 1 - slashes] === '\\') slashes++;
    if (slashes % 2 === 0) return at;
  }
  return -1;
}

/** Inline Markdown as text runs: **bold**, *italic* / _italic_, ~~struck~~, `code`, [words](address), \escapes. */
export function inlineMd(text: string, base: MarkJSON[] = []): NodeJSON[] {
  const out: NodeJSON[] = [];
  // A very long line is taken as it is: looking for the end of each * in it could take minutes.
  if (text.length > 20000) return [base.length ? { type: 'text', text, marks: base } : { type: 'text', text }];
  const push = (t: string, marks: MarkJSON[]) => {
    if (!t) return;
    const sorted = [...marks].sort((a, b) => a.type.localeCompare(b.type));
    const last = out[out.length - 1];
    if (last?.type === 'text' && JSON.stringify(last.marks ?? []) === JSON.stringify(sorted)) last.text += t;
    else out.push(sorted.length ? { type: 'text', text: t, marks: sorted } : { type: 'text', text: t });
  };
  const has = (marks: MarkJSON[], type: string) => marks.some(m => m.type === type);
  const walk = (s: string, marks: MarkJSON[]): void => {
    let i = 0;
    let plain = '';
    const flush = () => {
      push(plain, marks);
      plain = '';
    };
    while (i < s.length) {
      const ch = s[i];
      if (ch === '\\' && i + 1 < s.length && /[\\`*_{}[\]()#+\-.!~|>]/.test(s[i + 1])) {
        plain += s[i + 1];
        i += 2;
        continue;
      }
      if (ch === '`') {
        // Code between runs of backticks of the same length (``a`b`` holds a backtick); one space inside each end is
        // padding, not code.
        let n = 1;
        while (s[i + n] === '`') n++;
        const fence = '`'.repeat(n);
        let end = s.indexOf(fence, i + n);
        while (end > 0 && s[end + n] === '`') end = s.indexOf(fence, end + n + 1);
        if (end > i) {
          flush();
          let code = s.slice(i + n, end);
          if (code.length > 2 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
          push(code, [...marks, { type: 'font', attrs: { face: CODE_FACE } }]);
          i = end + n;
          continue;
        }
      }
      // A picture: its description stands in its place (Markdown pictures are links to other files).
      if (ch === '!' && s[i + 1] === '[') {
        const close = s.indexOf('](', i + 2);
        const end = close > 0 ? s.indexOf(')', close + 2) : -1;
        if (close > 0 && end > 0) {
          plain += s.slice(i + 2, close);
          changing?.add('pictures (each shows as its description)');
          i = end + 1;
          continue;
        }
      }
      if (ch === '[') {
        const close = s.indexOf('](', i + 1);
        const end = close > 0 ? s.indexOf(')', close + 2) : -1;
        if (close > 0 && end > 0) {
          flush();
          // A web or email address stays a link; anything else (a file next to it, a place in the page) is its words.
          const href = linkHref(s.slice(close + 2, end).trim().replace(/^<|>$/g, '').split(/\s+"/)[0]);
          walk(s.slice(i + 1, close), href && !has(marks, 'link') ? [...marks, { type: 'link', attrs: { href } }] : marks);
          i = end + 1;
          continue;
        }
      }
      const pair = s.startsWith('**', i) || s.startsWith('__', i) ? s.slice(i, i + 2) : s.startsWith('~~', i) ? '~~' : null;
      if (pair) {
        const end = unescapedAt(s, pair, i + 2);
        if (end > i + 2) {
          flush();
          const type = pair === '~~' ? 'strike' : 'strong';
          walk(s.slice(i + 2, end), has(marks, type) ? marks : [...marks, { type }]);
          i = end + 2;
          continue;
        }
      }
      if ((ch === '*' || ch === '_') && s[i + 1] !== ' ' && s[i + 1] !== ch) {
        // An underscore inside a word (snake_case) is just an underscore.
        const wordBefore = ch === '_' && i > 0 && /\w/.test(s[i - 1]);
        let end = unescapedAt(s, ch, i + 1);
        while (end > 0 && s[end + 1] === ch) end = unescapedAt(s, ch, end + 2);
        if (!wordBefore && end > i + 1 && s[end - 1] !== ' ' && !(ch === '_' && /\w/.test(s[end + 1] ?? ''))) {
          flush();
          walk(s.slice(i + 1, end), has(marks, 'em') ? marks : [...marks, { type: 'em' }]);
          i = end + 1;
          continue;
        }
      }
      plain += ch;
      i++;
    }
    flush();
  };
  walk(text, base);
  return out;
}

const para = (text: string, attrs: Record<string, unknown> = {}, base: MarkJSON[] = []): NodeJSON => {
  const content: NodeJSON[] = [];
  // Two spaces (or a backslash) at a line's end is a line break inside the paragraph.
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    // (Plain string checks, not patterns: a pattern over a line of thousands of spaces could take minutes.)
    const hard = i < lines.length - 1 && (line.length - line.trimEnd().length >= 2 || line.endsWith('\\'));
    content.push(...inlineMd((line.endsWith('\\') ? line.slice(0, -1) : line).trimEnd(), base));
    if (i < lines.length - 1) content.push(hard ? { type: 'hard_break' } : { type: 'text', text: ' ' });
  });
  const merged: NodeJSON[] = [];
  for (const c of content) {
    const last = merged[merged.length - 1];
    if (c.type === 'text' && last?.type === 'text' && JSON.stringify(last.marks ?? []) === JSON.stringify(c.marks ?? [])) last.text = (last.text ?? '') + (c.text ?? '');
    else if (c.type !== 'text' || c.text) merged.push(c);
  }
  return merged.length ? { type: 'paragraph', attrs: { style: 'normal', ...attrs }, content: merged } : { type: 'paragraph', attrs: { style: 'normal', ...attrs } };
};

const LIST = /^( *)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const MAX_MD_COLUMNS = 64;
const MAX_MD_CELLS = 20_000;

/** A .md file as a document. What reading it changes (pictures shown as words, quotes as italics...) is added to
 *  `changes`, if given. */
export function readMarkdown(source: string, changes?: Set<string>): NodeJSON {
  changing = changes;
  try {
    return readBlocks(source);
  } finally {
    changing = undefined;
  }
}

function readBlocks(source: string): NodeJSON {
  const lines = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const blocks: NodeJSON[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      i++;
      const code: string[] = [];
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) code.push(lines[i++]);
      i++;
      for (const c of code) blocks.push(c ? { type: 'paragraph', attrs: { style: 'normal', after: 0 }, content: [{ type: 'text', text: c, marks: [{ type: 'font', attrs: { face: CODE_FACE } }] }] } : { type: 'paragraph', attrs: { style: 'normal', after: 0 } });
      continue;
    }
    const heading = /^(#{1,6})\s/.exec(line);
    if (heading) {
      const level = heading[1].length;
      // The heading's words, without the #s some people also put at its end.
      let words = line.slice(level).trim();
      while (words.endsWith('#')) words = words.slice(0, -1);
      blocks.push(para(words.trim(), { style: `h${level}` }));
      i++;
      continue;
    }
    if (/^([-*_])\1{2,}$/.test(line.replace(/\s+/g, ''))) {
      // A line across the page: nothing to show in a document that has none; the paragraphs stay apart.
      changing?.add('lines across the page');
      i++;
      continue;
    }
    // Underlined headings (=== and --- on the next line).
    if (i + 1 < lines.length && lines[i + 1].trim() && /^(=+|-+)\s*$/.test(lines[i + 1]) && !LIST.test(line)) {
      blocks.push(para(line.trim(), { style: lines[i + 1].trim()[0] === '=' ? 'h1' : 'h2' }));
      i += 2;
      continue;
    }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const rows: string[][] = [];
      // A table this size is far past any page; a crafted one (thousands by thousands) would fill the memory. Cells
      // past the 64th go into the 64th, and rows past 20,000 cells in all stay as their lines of text.
      const cells = (l: string) => {
        const row = l.trim().replace(/^\||\|$/g, '');
        // Where the last kept cell starts (after the 63rd "|" not written as "\|"), found without splitting the rest.
        let bars = 0;
        let cut = -1;
        for (let k = 0; k < row.length && cut < 0; k++) if (row[k] === '|' && row[k - 1] !== '\\' && ++bars === MAX_MD_COLUMNS - 1) cut = k + 1;
        const split = (s: string) => s.split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
        if (cut < 0 || !/(?<!\\)\|/.test(row.slice(cut))) return split(row);
        changing?.add(`tables wider than ${MAX_MD_COLUMNS} columns (the rest of each row is in its last cell)`);
        return [...split(row.slice(0, cut - 1)), row.slice(cut).trim()];
      };
      rows.push(cells(line));
      i += 2;
      let count = rows[0].length;
      const rest: string[] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        if (rest.length) rest.push(lines[i++]);
        else {
          const row = cells(lines[i]);
          if (count + row.length > MAX_MD_CELLS) {
            changing?.add('the end of a very large table (shown as its lines of text)');
            rest.push(lines[i++]);
            continue;
          }
          count += row.length;
          rows.push(row);
          i++;
        }
      }
      const width = Math.max(...rows.map(r => r.length));
      blocks.push({
        type: 'table',
        attrs: { borders: true },
        content: rows.map(r => ({
          type: 'table_row',
          content: Array.from({ length: width }, (_, c) => ({ type: 'table_cell', attrs: { colspan: 1, rowspan: 1, colwidth: null, background: null }, content: [para(r[c] ?? '')] })),
        })),
      });
      // The rows past the limit, each as its line of text exactly as written.
      for (const l of rest) blocks.push({ type: 'paragraph', attrs: { style: 'normal' }, content: [{ type: 'text', text: l.trim() }] });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*> ?/, ''));
      blocks.push(para(quote.join('\n'), { indent: 36 }, [{ type: 'em' }]));
      changing?.add('quotes (shown as indented italics)');
      continue;
    }
    if (LIST.test(line)) {
      // Lists: an item's further lines are indented under it; a deeper marker starts a list inside it.
      const items: Array<{ indent: number; ordered: boolean; start: number; text: string }> = [];
      while (i < lines.length) {
        const m = LIST.exec(lines[i]);
        if (m) {
          items.push({ indent: m[1].length, ordered: /\d/.test(m[2]), start: Number.parseInt(m[2], 10) || 1, text: m[3] });
          i++;
        } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
          // Only the indent comes off: two spaces at the end are a line break, kept for the paragraph to read.
          items[items.length - 1].text += `\n${lines[i].trimStart()}`;
          i++;
        } else break;
      }
      const build = (from: number, indent: number): [NodeJSON, number] => {
        const first = items[from];
        const list: NodeJSON = first.ordered ? { type: 'ordered_list', attrs: { order: first.start }, content: [] } : { type: 'bullet_list', content: [] };
        let k = from;
        while (k < items.length && items[k].indent >= indent) {
          if (items[k].indent > indent + 1) {
            const last = list.content![list.content!.length - 1];
            const [inner, next] = build(k, items[k].indent);
            if (last) last.content!.push(inner);
            k = next;
            continue;
          }
          if (items[k].ordered !== first.ordered && k > from) break;
          list.content!.push({ type: 'list_item', content: [para(items[k].text)] });
          k++;
        }
        return [list, k];
      };
      let k = 0;
      while (k < items.length) {
        const [list, next] = build(k, items[k].indent);
        blocks.push(list);
        k = next === k ? k + 1 : next;
      }
      continue;
    }
    // A paragraph: lines until a blank line or something else starts.
    const text: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*```|\s*~~~|\s*>|\s*\|)/.test(lines[i]) && !(text.length && LIST.test(lines[i]))) text.push(lines[i++]);
    // A line that looks like the start of something else but is not one ("| a | b" with no "---" row under it): its
    // words, so reading always moves on (it once added empty paragraphs for ever, and the window froze).
    if (!text.length) text.push(lines[i++]);
    // "[1]: https://..." gives the address for [words][1] elsewhere; both stay as words here.
    if (text.some(l => /^ {0,3}\[[^\]]+\]:\s*\S/.test(l))) changing?.add('reference-style links (shown as their words)');
    blocks.push(para(text.join('\n').trim()));
  }
  return { type: 'doc', content: blocks.length ? blocks : [{ type: 'paragraph' }] };
}

/** Text with Markdown's own signs escaped where they would mean something. */
// A number that would start a list ("1. ") has its dot escaped ("1\. "): a backslash before a digit is not an escape
// Markdown reads, so "\1. " came back with its backslash.
const escapeMd = (s: string): string => s.replace(/([\\`*_[\]~|])/g, '\\$1').replace(/^(#{1,6}\s|>|[-+*]\s)/, '\\$1').replace(/^(\d+)([.)]\s)/, '$1\\$2');

/** Inline code: in single backticks, or in a longer run (with a space inside each end) when it holds backticks. */
function codeSpan(text: string): string {
  if (!text.includes('`')) return `\`${text}\``;
  const fence = '`'.repeat(Math.max(...(text.match(/`+/g) ?? []).map(r => r.length)) + 1);
  return `${fence} ${text} ${fence}`;
}

/** A paragraph that is a line of a code block as read: all in the code typeface (or empty), with no space after. */
const isCodeLine = (b: NodeJSON): boolean => b.type === 'paragraph' && (b.attrs?.style ?? 'normal') === 'normal' && b.attrs?.after === 0
  && (b.content ?? []).every(n => n.type === 'text' && n.marks?.length === 1 && n.marks[0].type === 'font' && n.marks[0].attrs?.face === CODE_FACE);

/** One run of text as Markdown; bold is written ** and italic *, or __ and _ where stars would run together. */
function runToMd(n: NodeJSON, bold: '**' | '__', italic: '*' | '_' = '*'): string {
  const types = new Set((n.marks ?? []).map(m => m.type));
  const code = (n.marks ?? []).some(m => m.type === 'font' && /consolas|courier|mono/i.test(String(m.attrs?.face)));
  let t = code ? codeSpan(n.text ?? '') : escapeMd(n.text ?? '');
  // Only spaces: as they are (taken as both leading and trailing spaces, they doubled at every save).
  if (!code && !t.trim()) return t;
  // Markers go inside the text's own spaces ("**bold** next", not "**bold **next").
  const lead = /^\s*/.exec(t)![0];
  const trail = /\s*$/.exec(t)![0];
  t = t.trim();
  if (t) {
    if (types.has('strike')) t = `~~${t}~~`;
    if (types.has('em')) t = `${italic}${t}${italic}`;
    if (types.has('strong')) t = `${bold}${t}${bold}`;
    const href = n.marks?.find(m => m.type === 'link')?.attrs?.href;
    if (typeof href === 'string' && linkHref(href)) t = `[${t}](${href.replace(/[()\s]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)})`;
  }
  return lead + t + trail;
}

function inlineToMd(nodes: NodeJSON[] | undefined): string {
  const runs = (nodes ?? []).filter(n => n.type === 'hard_break' || n.type === 'text');
  const strong = (n: NodeJSON) => n.type === 'text' && !!n.marks?.some(m => m.type === 'strong');
  // Bold and italic together is __*words*__ (***words*** reads back wrong); so is bold whose stars would touch the
  // stars of the run beside it (*a***b** for italic a, bold b), which then read as one run of stars.
  const bold = runs.map(n => (strong(n) && n.marks!.some(m => m.type === 'em') ? '__' : '**') as '**' | '__');
  const italic = runs.map(() => '*' as '*' | '_');
  const em = (n: NodeJSON) => n.type === 'text' && !!n.marks?.some(m => m.type === 'em');
  const render = (k: number) => (runs[k].type === 'hard_break' ? '  \n' : runToMd(runs[k], bold[k], italic[k]));
  const pieces = runs.map((_, k) => render(k));
  const word = (c: string | undefined) => !!c && /\w/.test(c);
  for (let k = 1; k < pieces.length; k++) {
    if (!pieces[k - 1].endsWith('*') || !pieces[k].startsWith('*')) continue;
    // A bold run beside it takes __. Otherwise an italic one takes _, where no letter touches its _ from outside (an _
    // inside a word, as in snake_case, is just an underscore).
    const which = strong(runs[k]) ? k : strong(runs[k - 1]) ? k - 1 : -1;
    if (which >= 0) {
      bold[which] = '__';
      pieces[which] = render(which);
      continue;
    }
    for (const j of [k, k - 1]) {
      const before = j > 0 ? pieces[j - 1].slice(-1) : '';
      const after = j + 1 < pieces.length ? pieces[j + 1][0] : '';
      if (!em(runs[j]) || word(before) || word(after)) continue;
      italic[j] = '_';
      pieces[j] = render(j);
      break;
    }
  }
  return pieces.join('');
}

/** What saving as Markdown leaves out of this document (in words), so the window can ask first; empty: nothing. */
export function markdownLoses(doc: NodeJSON): string[] {
  const lost = new Set<string>();
  const walk = (n: NodeJSON) => {
    if (n.type === 'image') lost.add('pictures');
    if (n.type === 'page_break') lost.add('page breaks');
    if (n.type === 'opaque_inline' || n.type === 'opaque_block') lost.add('the parts of a Word file shown as grey labels');
    if (n.type === 'footnote') lost.add('footnotes');
    if (n.type === 'field') lost.add('merge fields');
    if (n.type === 'toc') lost.add('the contents page');
    if (n.type === 'paragraph' && n.attrs?.style === 'title') lost.add('the Title style (saved as Heading 1)');
    if (n.type === 'paragraph' && (n.content?.[0]?.type === 'hard_break' || n.content?.at(-1)?.type === 'hard_break')) lost.add('line breaks at the start or end of a paragraph');
    if ((n.type === 'table_cell' || n.type === 'table_header' || (n.type === 'paragraph' && /^(title|h[1-6])$/.test(String(n.attrs?.style)))) && JSON.stringify(n).includes('"hard_break"')) lost.add('line breaks inside headings and table cells');
    if (n.type === 'paragraph' && (n.attrs?.align || n.attrs?.before !== undefined && n.attrs?.before !== null)) lost.add('alignment and spacing');
    for (const m of n.marks ?? []) {
      if (m.type === 'color' || m.type === 'highlight' || m.type === 'size' || m.type === 'underline' || m.type === 'vert') lost.add('colours, sizes, underlining and raised or lowered text');
      if (m.type === 'font' && !/consolas|courier|mono/i.test(String(m.attrs?.face))) lost.add('typefaces');
    }
    if (n.type === 'table_cell' && (Number(n.attrs?.colspan) > 1 || Number(n.attrs?.rowspan) > 1)) lost.add('joined table cells');
    if (n.type === 'ordered_list' && (n.attrs?.kind || n.attrs?.shape || n.attrs?.outline)) lost.add('list numbering such as A., (a) or 1.1 (Markdown numbers 1. 2. 3.)');
    for (const c of n.content ?? []) walk(c);
  };
  walk(doc);
  return [...lost];
}

/** The document as Markdown. */
export function writeMarkdown(doc: NodeJSON): string {
  const out: string[] = [];
  const blocks = (nodes: NodeJSON[], indent: string) => {
    for (let at = 0; at < nodes.length; at++) {
      const b = nodes[at];
      // Lines of a code block (as a code block reads) go back as one, word for word.
      if (isCodeLine(b) && b.content?.length) {
        let last = at;
        for (let k = at + 1; k < nodes.length && isCodeLine(nodes[k]); k++) if (nodes[k].content?.length) last = k;
        const code = nodes.slice(at, last + 1).map(p => (p.content ?? []).map(n => n.text ?? '').join(''));
        const fence = '`'.repeat(Math.max(3, ...code.map(l => Math.max(0, ...(l.match(/`+/g) ?? []).map(r => r.length + 1)))));
        out.push(indent + fence, ...code.map(l => (l ? indent + l : '')), indent + fence, '');
        at = last;
        continue;
      }
      if (b.type === 'paragraph') {
        const style = b.attrs?.style;
        const text = inlineToMd(b.content);
        if (style === 'title' || style === 'h1') out.push(`${indent}# ${text}`, '');
        else if (style === 'h2') out.push(`${indent}## ${text}`, '');
        else if (/^h[3-6]$/.test(String(style))) out.push(`${indent}${'#'.repeat(Number(String(style).slice(1)))} ${text}`, '');
        else out.push(text ? text.split('\n').map(l => indent + l).join('\n') : '', '');
      } else if (b.type === 'bullet_list' || b.type === 'ordered_list') {
        let n = Number(b.attrs?.order ?? 1) || 1;
        for (const item of b.content ?? []) {
          const marker = b.type === 'ordered_list' ? `${n++}. ` : '- ';
          const [first, ...rest] = item.content ?? [];
          const inner = indent + ' '.repeat(marker.length);
          // The lines after a line break sit under the item's words, or they would start a paragraph of their own.
          out.push(`${indent}${marker}${first?.type === 'paragraph' ? inlineToMd(first.content).replace(/\n/g, `\n${inner}`) : ''}`);
          for (const r of rest) {
            blocks([r], inner);
            // Lists inside lists sit tight under their item.
            if (out[out.length - 1] === '' && (r.type === 'bullet_list' || r.type === 'ordered_list')) out.pop();
          }
        }
        out.push('');
      } else if (b.type === 'table') {
        // A line break in a cell becomes one space (a row is one line); with the spaces around it, they grew each save.
        const rows = (b.content ?? []).map(r => (r.content ?? []).map(c => (c.content ?? []).map(p => inlineToMd(p.content)).join(' ').replace(/ *\n */g, ' ')));
        if (!rows.length) continue;
        const width = Math.max(...rows.map(r => r.length));
        const line = (r: string[]) => `${indent}| ${Array.from({ length: width }, (_, i) => r[i] ?? '').join(' | ')} |`;
        out.push(line(rows[0]), `${indent}|${' --- |'.repeat(width)}`, ...rows.slice(1).map(line), '');
      }
    }
  };
  blocks(doc.content ?? [], '');
  while (out.length && out[out.length - 1] === '') out.pop();
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}
