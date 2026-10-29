// Find and replace in Write: every place the words are found (match case and whole words as asked), shown in
// yellow with the current one in orange, and a replace that keeps the formatting where it happens. Searching is done
// paragraph by paragraph on the document itself (a match never runs from one paragraph into the next); a picture or a
// kept part counts as one character that no word matches.
import type { PM } from './schema.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface FindOptions {
  matchCase: boolean;
  wholeWord: boolean;
}

export interface Hit {
  from: number;
  to: number;
}

/** Most places found (more are not marked: a search for "e" in a long book stays quick). */
export const MOST_HITS = 5000;

const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}_]/u.test(c);

/**
 * Small letters, one for one: the text keeps its length, so a place found in it is the same place in the document.
 * (A letter whose small form is longer, such as Turkish İ, which is "i" and a dot, becomes its first letter.)
 */
function fold(s: string): string {
  let out = '';
  for (const ch of s) {
    const small = ch.toLocaleLowerCase();
    if (small.length === ch.length) out += small;
    else if (ch.length === 1 && (small.codePointAt(0) ?? 0) <= 0xffff) out += small[0];
    else out += ch;
  }
  return out;
}

/** Every place `query` is found in the document. */
export function findAll(doc: any, query: string, opts: FindOptions): Hit[] {
  const hits: Hit[] = [];
  if (!query) return hits;
  const needle = opts.matchCase ? query : fold(query);
  doc.descendants((node: any, pos: number) => {
    if (hits.length >= MOST_HITS) return false;
    if (!node.isTextblock) return true;
    // The paragraph's text, one character per position (anything not text stands as one character no word matches).
    let text = '';
    node.forEach((child: any) => {
      text += child.isText ? child.text : '￼'.repeat(child.nodeSize);
    });
    const hay = opts.matchCase ? text : fold(text);
    let at = hay.indexOf(needle);
    while (at >= 0 && hits.length < MOST_HITS) {
      const end = at + needle.length;
      if (!opts.wholeWord || (!isWordChar(text[at - 1]) && !isWordChar(text[end]))) hits.push({ from: pos + 1 + at, to: pos + 1 + end });
      at = hay.indexOf(needle, at + Math.max(1, needle.length));
    }
    return false;
  });
  return hits;
}

/** The plugin that marks what is found: its state is the search, set by the window with a transaction meta. */
export function findPlugin(pm: PM): { plugin: any; key: any } {
  const key = new pm.PluginKey('wp-find');
  const plugin = new pm.Plugin({
    key,
    state: {
      init: () => ({ query: '', opts: { matchCase: false, wholeWord: false }, hits: [] as Hit[], current: -1 }),
      apply(tr: any, value: any) {
        const meta = tr.getMeta(key);
        if (meta) return meta;
        if (!tr.docChanged || !value.query) return value;
        const hits = findAll(tr.doc, value.query, value.opts);
        return { ...value, hits, current: Math.min(value.current, hits.length - 1) };
      },
    },
    props: {
      decorations(state: any) {
        const s = key.getState(state);
        if (!s?.hits.length) return null;
        return pm.DecorationSet.create(state.doc, s.hits.map((h: Hit, i: number) => pm.Decoration.inline(h.from, h.to, { class: i === s.current ? 'wp-found wp-found-now' : 'wp-found' })));
      },
    },
  });
  return { plugin, key };
}

/** Replaces every hit (from the end, so the places before stay right), keeping each hit's own formatting. */
export function replaceAll(state: any, hits: Hit[], text: string): any {
  const tr = state.tr;
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i];
    const marks = state.doc.resolve(h.from + 1 <= h.to ? h.from + 1 : h.from).marks();
    if (text) tr.replaceWith(h.from, h.to, state.schema.text(text, marks));
    else tr.delete(h.from, h.to);
  }
  return tr;
}
