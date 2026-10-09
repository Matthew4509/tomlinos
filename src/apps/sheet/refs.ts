// Cell addresses ("B7", "$B$7", "B7:D9") and a formula tokenizer that is shared by the formula parser and by the code
// that rewrites references when cells are copied, filled, inserted or deleted. Our own code.
export const MAX_ROWS = 5000;
export const MAX_COLS = 256;

export function colName(c: number): string {
  let s = '';
  let n = c + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function colIndex(name: string): number {
  let n = 0;
  for (const ch of name.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

export interface Ref {
  col: number;
  row: number;
  absC: boolean;
  absR: boolean;
}

const CELL = /^(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})$/;

export function parseCellRef(text: string): Ref | null {
  const m = CELL.exec(text);
  if (!m) return null;
  const col = colIndex(m[2]);
  const row = parseInt(m[4], 10) - 1;
  if (col < 0 || col >= MAX_COLS || row < 0 || row >= MAX_ROWS) return null;
  return { col, row, absC: m[1] === '$', absR: m[3] === '$' };
}

export function refText(r: Ref): string {
  return `${r.absC ? '$' : ''}${colName(r.col)}${r.absR ? '$' : ''}${r.row + 1}`;
}

export function addressOf(col: number, row: number): string {
  return `${colName(col)}${row + 1}`;
}

// ---- Tokens --------------------------------------------------------------------------------------------------------

export type TokType = 'num' | 'str' | 'ident' | 'sheetq' | 'op' | 'lp' | 'rp' | 'comma' | 'colon' | 'bang' | 'err';
export interface Tok {
  type: TokType;
  text: string;
  start: number;
  end: number;
}

export class SyntaxProblem extends Error {}

/** Splits a formula (without its leading "=") into tokens; throws SyntaxProblem on a character it cannot place. */
export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const push = (type: TokType, start: number, end: number) => out.push({ type, text: src.slice(start, end), start, end });
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n') {
      i++;
      continue;
    }
    const start = i;
    if (c === '"') {
      i++;
      let closed = false;
      while (i < src.length) {
        if (src[i] === '"') {
          if (src[i + 1] === '"') i += 2;
          else {
            i++;
            closed = true;
            break;
          }
        } else i++;
      }
      if (!closed) throw new SyntaxProblem('A quotation mark is not closed.');
      push('str', start, i);
    } else if (c === "'") {
      i++;
      while (i < src.length && !(src[i] === "'" && src[i + 1] !== "'")) i += src[i] === "'" ? 2 : 1;
      if (i >= src.length) throw new SyntaxProblem('A sheet name is not closed.');
      i++;
      push('sheetq', start, i);
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      while (i < src.length && /[0-9]/.test(src[i])) i++;
      if (src[i] === '.') {
        i++;
        while (i < src.length && /[0-9]/.test(src[i])) i++;
      }
      if (/[eE]/.test(src[i] ?? '') && /[0-9+-]/.test(src[i + 1] ?? '')) {
        i += 2;
        while (i < src.length && /[0-9]/.test(src[i])) i++;
      }
      push('num', start, i);
    } else if (/[A-Za-z_$]/.test(c)) {
      i++;
      while (i < src.length && /[A-Za-z0-9_.$]/.test(src[i])) i++;
      push('ident', start, i);
    } else if (c === '#') {
      i++;
      while (i < src.length && /[A-Za-z0-9/!?]/.test(src[i])) i++;
      push('err', start, i);
    } else if (c === '(') { i++; push('lp', start, i); }
    else if (c === ')') { i++; push('rp', start, i); }
    else if (c === ',' || c === ';') { i++; push('comma', start, i); }
    else if (c === ':') { i++; push('colon', start, i); }
    else if (c === '!') { i++; push('bang', start, i); }
    else if (c === '<' || c === '>') {
      i++;
      if (src[i] === '=' || (c === '<' && src[i] === '>')) i++;
      push('op', start, i);
    } else if ('+-*/^&=%'.includes(c)) { i++; push('op', start, i); }
    else throw new SyntaxProblem(`The character "${c}" cannot be used in a formula.`);
  }
  return out;
}

export function sheetNameOf(tok: Tok): string {
  return tok.type === 'sheetq' ? tok.text.slice(1, -1).replace(/''/g, "'") : tok.text;
}

export function quoteSheet(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !parseCellRef(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

/**
 * Rewrites every cell reference in a formula (text after "="). `fn` gets the reference (or both ends of a range) and the
 * sheet it points at (undefined = the formula's own sheet) and returns the new reference(s), or null for #REF!.
 */
export function mapRefs(
  formula: string,
  fn: (a: Ref, b: Ref | null, sheet: string | undefined) => [Ref, Ref | null] | null,
): string {
  const toks = tokenize(formula);
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.type !== 'ident') continue;
    const a = parseCellRef(t.text);
    if (!a || toks[k + 1]?.type === 'lp') continue;
    let sheet: string | undefined;
    let first = k;
    if (toks[k - 1]?.type === 'bang' && (toks[k - 2]?.type === 'ident' || toks[k - 2]?.type === 'sheetq')) {
      sheet = sheetNameOf(toks[k - 2]);
      first = k - 2;
    }
    let b: Ref | null = null;
    let last = k;
    if (toks[k + 1]?.type === 'colon' && toks[k + 2]?.type === 'ident') {
      const second = parseCellRef(toks[k + 2].text);
      if (second) {
        b = second;
        last = k + 2;
      }
    }
    const result = fn(a, b, sheet);
    const prefix = sheet !== undefined ? `${quoteSheet(sheet)}!` : '';
    let text: string;
    if (!result) text = "#REF!";
    else text = prefix + refText(result[0]) + (result[1] ? `:${refText(result[1])}` : '');
    edits.push({ start: toks[first].start, end: toks[last].end, text });
    k = last;
  }
  let out = formula;
  for (const e of edits.reverse()) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

/** The formula as it would read if copied `dc` columns and `dr` rows away. Absolute ($) parts stay put. */
export function shiftFormula(formula: string, dc: number, dr: number): string {
  return mapRefs(formula, (a, b) => {
    const move = (r: Ref): Ref | null => {
      const col = r.absC ? r.col : r.col + dc;
      const row = r.absR ? r.row : r.row + dr;
      return col < 0 || col >= MAX_COLS || row < 0 || row >= MAX_ROWS ? null : { ...r, col, row };
    };
    const na = move(a);
    const nb = b ? move(b) : null;
    if (!na || (b && !nb)) return null;
    return [na, nb];
  });
}

/** Rewrites the sheet name in every "Old!A1" so a renamed sheet keeps working. */
export function renameSheetInFormula(formula: string, from: string, to: string): string {
  const toks = tokenize(formula);
  let out = formula;
  for (let k = toks.length - 2; k >= 0; k--) {
    const t = toks[k];
    if ((t.type === 'ident' || t.type === 'sheetq') && toks[k + 1].type === 'bang' && sheetNameOf(t).toLowerCase() === from.toLowerCase()) {
      out = out.slice(0, t.start) + quoteSheet(to) + out.slice(t.end);
    }
  }
  return out;
}
