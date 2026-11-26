// Excel's wildcards (* any run, ? one character, ~ before * ? or ~ means that character itself), matched without a
// regular expression. A pattern like "*a*a*a*b" turned into a regular expression could take minutes on a long cell
// (each * tried every split again); this walks the text once per piece of the pattern, so it takes text length times
// pattern length steps at most. Text is compared ignoring case, as the functions that use it do (Find can match case).

type Piece = { k: '*' } | { k: '?' } | { k: 'c'; c: string };

function pieces(pattern: string, matchCase = false): Piece[] {
  const out: Piece[] = [];
  const p = matchCase ? pattern : pattern.toLowerCase();
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
function startsAt(pattern: string, text: string, whole: boolean, matchCase = false): boolean[] {
  const ps = pieces(pattern, matchCase);
  const t = matchCase ? text : text.toLowerCase();
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

/** The pattern matches the whole text (`whole`), or some part of it. */
export function wildTest(pattern: string, text: string, matchCase = false, whole = false): boolean {
  const at = startsAt(pattern, text, whole, matchCase);
  return whole ? at[0] : at.includes(true);
}

/**
 * Where the pattern matches in the text, as Find and Replace read it: each match as [start, end), the leftmost first
 * and each as long as it can be, not overlapping; matches of nothing are left out. With `whole`, the whole text or
 * nothing. Takes about text length times pattern length steps: once a * is reached, no later match can start past
 * where the longest one ends, and without one a match is never longer than the pattern.
 */
export function wildSpans(pattern: string, text: string, matchCase = false, whole = false): Array<[number, number]> {
  const n = text.length;
  if (whole) return startsAt(pattern, text, true, matchCase)[0] ? (n ? [[0, n]] : []) : [];
  const ps = pieces(pattern, matchCase);
  const t = matchCase ? text : text.toLowerCase();
  const at = startsAt(pattern, text, false, matchCase);
  const m = ps.length;
  const out: Array<[number, number]> = [];
  let on = new Uint8Array(m + 1);
  let nextOn = new Uint8Array(m + 1);
  // Adds piece j and, past each *, the pieces after it (a * can match nothing).
  const add = (set: Uint8Array, j: number) => {
    while (j <= m && !set[j]) {
      set[j] = 1;
      if (j < m && ps[j].k === '*') j++;
      else break;
    }
  };
  let pos = 0;
  while (pos <= n) {
    let i = pos;
    while (i <= n && !at[i]) i++;
    if (i > n) break;
    on.fill(0);
    add(on, 0);
    let end = -1;
    for (let p = i; ; p++) {
      if (on[m]) end = p;
      if (p >= n) break;
      nextOn.fill(0);
      let any = false;
      for (let j = 0; j < m; j++) {
        if (!on[j]) continue;
        const piece = ps[j];
        if (piece.k === '*') add(nextOn, j);
        else if (piece.k === '?' || piece.c === t[p]) add(nextOn, j + 1);
        else continue;
        any = true;
      }
      if (!any) break;
      [on, nextOn] = [nextOn, on];
    }
    if (end > i) {
      out.push([i, end]);
      pos = end;
    } else pos = i + 1;
  }
  return out;
}
