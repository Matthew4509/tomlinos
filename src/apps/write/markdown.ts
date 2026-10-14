// Markdown (.md) in TOMLIN Write: a .md file opens formatted (headings, bold, italic, strikethrough, code, lists inside
// lists, numbered lists that start part-way, quotes, tables, line breaks) and saves back as Markdown. What Markdown
// cannot hold (colours, sizes, typefaces, alignment, pictures, page breaks) is left out on saving, and the window asks
// first. Our own small reader and writer: common Markdown as people write it, not every corner of the standard.
// No browser needed.
import type { MarkJSON, NodeJSON } from './model.ts';

const CODE_FACE = 'Consolas';

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
        const end = s.indexOf('`', i + 1);
        if (end > i) {
          flush();
          push(s.slice(i + 1, end), [...marks, { type: 'font', attrs: { face: CODE_FACE } }]);
          i = end + 1;
          continue;
        }
      }
      // A picture: its description stands in its place (Markdown pictures are links to other files).
      if (ch === '!' && s[i + 1] === '[') {
        const close = s.indexOf('](', i + 2);
        const end = close > 0 ? s.indexOf(')', close + 2) : -1;
        if (close > 0 && end > 0) {
          plain += s.slice(i + 2, close);
          i = end + 1;
          continue;
        }
      }
      if (ch === '[') {
        const close = s.indexOf('](', i + 1);
        const end = close > 0 ? s.indexOf(')', close + 2) : -1;
        if (close > 0 && end > 0) {
          flush();
          walk(s.slice(i + 1, close), marks);
          i = end + 1;
          continue;
        }
      }
      const pair = s.startsWith('**', i) || s.startsWith('__', i) ? s.slice(i, i + 2) : s.startsWith('~~', i) ? '~~' : null;
      if (pair) {
        const end = s.indexOf(pair, i + 2);
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
        let end = s.indexOf(ch, i + 1);
        while (end > 0 && s[end + 1] === ch) end = s.indexOf(ch, end + 2);
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

/** A .md file as a document. */
export function readMarkdown(source: string): NodeJSON {
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
      blocks.push(para(words.trim(), { style: level === 1 ? 'h1' : level === 2 ? 'h2' : 'h3' }));
      i++;
      continue;
    }
    if (/^([-*_])\1{2,}$/.test(line.replace(/\s+/g, ''))) {
      // A line across the page: nothing to show in a document that has none; the paragraphs stay apart.
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
      const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
      rows.push(cells(line));
      i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
      const width = Math.max(...rows.map(r => r.length));
      blocks.push({
        type: 'table',
        attrs: { borders: true },
        content: rows.map(r => ({
          type: 'table_row',
          content: Array.from({ length: width }, (_, c) => ({ type: 'table_cell', attrs: { colspan: 1, rowspan: 1, colwidth: null, background: null }, content: [para(r[c] ?? '')] })),
        })),
      });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*> ?/, ''));
      blocks.push(para(quote.join('\n'), { indent: 36 }, [{ type: 'em' }]));
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
          items[items.length - 1].text += `\n${lines[i].trim()}`;
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
    blocks.push(para(text.join('\n').trim()));
  }
  return { type: 'doc', content: blocks.length ? blocks : [{ type: 'paragraph' }] };
}

/** Text with Markdown's own signs escaped where they would mean something. */
const escapeMd = (s: string): string => s.replace(/([\\`*_[\]~|])/g, '\\$1').replace(/^(#{1,6}\s|>|\d+[.)]\s|[-+*]\s)/, '\\$1');

function inlineToMd(nodes: NodeJSON[] | undefined): string {
  let out = '';
  for (const n of nodes ?? []) {
    if (n.type === 'hard_break') out += '  \n';
    else if (n.type === 'text') {
      const types = new Set((n.marks ?? []).map(m => m.type));
      const code = (n.marks ?? []).some(m => m.type === 'font' && /consolas|courier|mono/i.test(String(m.attrs?.face)));
      let t = code ? `\`${(n.text ?? '').replace(/`/g, '')}\`` : escapeMd(n.text ?? '');
      // Markers go inside the text's own spaces ("**bold** next", not "**bold **next").
      const lead = /^\s*/.exec(t)![0];
      const trail = /\s*$/.exec(t)![0];
      t = t.trim();
      if (t) {
        if (types.has('strike')) t = `~~${t}~~`;
        if (types.has('em')) t = `*${t}*`;
        if (types.has('strong')) t = `**${t}**`;
      }
      out += lead + t + trail;
    }
  }
  return out;
}

/** What saving as Markdown leaves out of this document (in words), so the window can ask first; empty: nothing. */
export function markdownLoses(doc: NodeJSON): string[] {
  const lost = new Set<string>();
  const walk = (n: NodeJSON) => {
    if (n.type === 'image') lost.add('pictures');
    if (n.type === 'page_break') lost.add('page breaks');
    if (n.type === 'opaque_inline' || n.type === 'opaque_block') lost.add('the parts of a Word file shown as grey labels');
    if (n.type === 'paragraph' && (n.attrs?.align || n.attrs?.before !== undefined && n.attrs?.before !== null)) lost.add('alignment and spacing');
    for (const m of n.marks ?? []) {
      if (m.type === 'color' || m.type === 'highlight' || m.type === 'size' || m.type === 'underline' || m.type === 'vert') lost.add('colours, sizes, underlining and raised or lowered text');
      if (m.type === 'font' && !/consolas|courier|mono/i.test(String(m.attrs?.face))) lost.add('typefaces');
    }
    if (n.type === 'table_cell' && (Number(n.attrs?.colspan) > 1 || Number(n.attrs?.rowspan) > 1)) lost.add('joined table cells');
    for (const c of n.content ?? []) walk(c);
  };
  walk(doc);
  return [...lost];
}

/** The document as Markdown. */
export function writeMarkdown(doc: NodeJSON): string {
  const out: string[] = [];
  const blocks = (nodes: NodeJSON[], indent: string) => {
    for (const b of nodes) {
      if (b.type === 'paragraph') {
        const style = b.attrs?.style;
        const text = inlineToMd(b.content);
        if (style === 'title' || style === 'h1') out.push(`${indent}# ${text}`, '');
        else if (style === 'h2') out.push(`${indent}## ${text}`, '');
        else if (style === 'h3') out.push(`${indent}### ${text}`, '');
        else out.push(text ? text.split('\n').map(l => indent + l).join('\n') : '', '');
      } else if (b.type === 'bullet_list' || b.type === 'ordered_list') {
        let n = Number(b.attrs?.order ?? 1) || 1;
        for (const item of b.content ?? []) {
          const marker = b.type === 'ordered_list' ? `${n++}. ` : '- ';
          const [first, ...rest] = item.content ?? [];
          out.push(`${indent}${marker}${first?.type === 'paragraph' ? inlineToMd(first.content) : ''}`);
          const inner = indent + ' '.repeat(marker.length);
          for (const r of rest) {
            blocks([r], inner);
            // Lists inside lists sit tight under their item.
            if (out[out.length - 1] === '' && (r.type === 'bullet_list' || r.type === 'ordered_list')) out.pop();
          }
        }
        out.push('');
      } else if (b.type === 'table') {
        const rows = (b.content ?? []).map(r => (r.content ?? []).map(c => (c.content ?? []).map(p => inlineToMd(p.content)).join(' ').replace(/\n/g, ' ')));
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
