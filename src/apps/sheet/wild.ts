// Excel's wildcards (* any run, ? one character, ~ before * ? or ~ means that character itself), matched without a
// regular expression. A pattern like "*a*a*a*b" turned into a regular expression could take minutes on a long cell
// (each * tried every split again); this walks the text once per piece of the pattern, so it takes text length times
// pattern length steps at most. Text is compared ignoring case, as the functions that use it do.

type Piece = { k: '*' } | { k: '?' } | { k: 'c'; c: string };

function pieces(pattern: string): Piece[] {
  const out: Piece[] = [];
  const p = pattern.toLowerCase();
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '~' && i + 1 < p.length && '*?~'.includes(p[i + 1])) out.push({ k: 'c', c: p[++i] });
    else if (c === '*') {
      if (out.length === 0 || out[out.length - 1].k !== '*') out.push({ k: '*' });
    } else if (c === '?') out.push({ k: '?' });
    else out.push({ k: 'c', c });
  }
  return out;
}

/**
 * For each place `i` in the text: whether the pattern matches starting there. With `whole`, the match must run to the
 * end of the text; without, any start of what follows will do (as SEARCH reads it).
 */
function startsAt(pattern: string, text: string, whole: boolean): boolean[] {
  const ps = pieces(pattern);
  const t = text.toLowerCase();
  const n = t.length;
  // `next[i]`: the rest of the pattern (after the piece being worked on) matches from i.
  let next: boolean[] = new Array(n + 1);
  for (let i = 0; i <= n; i++) next[i] = whole ? i === n : true;
  for (let j = ps.length - 1; j >= 0; j--) {
    const piece = ps[j];
    const here: boolean[] = new Array(n + 1).fill(false);
    if (piece.k === '*') {
      here[n] = next[n];
      for (let i = n - 1; i >= 0; i--) here[i] = next[i] || here[i + 1];
    } else {
      for (let i = 0; i < n; i++) here[i] = next[i + 1] && (piece.k === '?' || t[i] === piece.c);
    }
    next = here;
  }
  return next;
}

/** The whole text matches the pattern (COUNTIF, MATCH, the lookups). */
export function wildMatch(pattern: string, text: string): boolean {
  return startsAt(pattern, text, true)[0];
}

/** Where the pattern first matches in the text (0 based), or -1 (SEARCH). */
export function wildFind(pattern: string, text: string): number {
  const at = startsAt(pattern, text, false);
  for (let i = 0; i <= text.length; i++) if (at[i]) return i;
  return -1;
}
