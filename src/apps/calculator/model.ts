// The Calculator's sums, kept apart from the window so they can be tested.
//
// × and ÷ are worked out before + and − (2 + 3 × 4 = 14): advanced enough and simple
// enough; the full spreadsheet is there for more. Sheet sums ("=" cells) use the same rule. The rule is one function:
// `run`.
//
// The sheet: rows of Label | A | B | =, then two foot rows whose A, B and = are all sum cells. A cell's id never
// changes when the window grows more rows: body rows are numbered, the foot rows are "f1" and "f2".

export type Op = '+' | '−' | '×' | '÷';
export const OPS: Op[] = ['+', '−', '×', '÷'];

export class CalcError extends Error {}
export const DIV_ZERO = "Can't divide by 0";
const LOOP = 'Goes round in a loop';

export function apply(a: number, op: Op, b: number): number {
  switch (op) {
    case '+': return a + b;
    case '−': return a - b;
    case '×': return a * b;
    case '÷':
      if (b === 0) throw new CalcError(DIV_ZERO);
      return a / b;
  }
}

/** × and ÷ before + and −: 2 + 3 × 4 = 14. Otherwise left to right. */
export function run(values: number[], ops: Op[]): number {
  const terms = [values[0] ?? 0];
  const signs: Op[] = [];
  for (let i = 0; i < ops.length && i + 1 < values.length; i++) {
    const op = ops[i];
    if (op === '×' || op === '÷') terms[terms.length - 1] = apply(terms[terms.length - 1], op, values[i + 1]);
    else {
      signs.push(op);
      terms.push(values[i + 1]);
    }
  }
  return terms.reduce((total, t, i) => (i === 0 ? t : apply(total, signs[i - 1], t)), 0);
}

/** Up to 12 significant digits, no trailing zeros, no "-0"; very large or small numbers in e-notation. */
export function show(n: number): string {
  if (!Number.isFinite(n)) return 'Too big';
  if (Object.is(n, -0) || n === 0) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e15 || abs < 1e-9) return n.toExponential(8).replace(/\.?0+e/, 'e');
  return String(parseFloat(n.toPrecision(12)));
}

// ---- The calculator ------------------------------------------------------------------------------------------------

export class Calculator {
  entry = '0';
  /** Numbers and operators pressed so far (the entry is not in them until an operator or = is pressed). */
  values: number[] = [];
  ops: Op[] = [];
  /** The next digit starts a new number (after an operator, =, or → cell). */
  fresh = true;
  error: string | null = null;

  get display(): string {
    return this.error ?? this.entry;
  }
  get value(): number {
    return Number(this.entry);
  }
  /** The operator waiting for its next number, lit on the keypad. */
  get op(): Op | null {
    return this.ops.length === this.values.length && this.ops.length > 0 ? this.ops[this.ops.length - 1] : null;
  }
  /** What was pressed, shown small above the number: "12 + 3 ×". */
  get history(): string {
    return this.values.map((v, i) => `${show(v)}${this.ops[i] ? ' ' + this.ops[i] : ''}`).join(' ');
  }

  digit(d: string): void {
    if (this.error) this.clear();
    if (this.fresh) {
      this.entry = d === '.' ? '0.' : d;
      this.fresh = false;
      return;
    }
    if (d === '.' && this.entry.includes('.')) return;
    if (this.entry.replace(/[-.]/g, '').length >= 15) return;
    this.entry = this.entry === '0' && d !== '.' ? d : this.entry + d;
  }

  back(): void {
    if (this.error) return this.clear();
    if (this.fresh) return;
    this.entry = this.entry.length > 1 && this.entry !== '-0' ? this.entry.slice(0, -1) : '0';
    if (this.entry === '-') this.entry = '0';
  }

  negate(): void {
    if (this.error) return;
    if (this.entry === '0') return;
    this.entry = this.entry.startsWith('-') ? this.entry.slice(1) : '-' + this.entry;
    this.fresh = false;
  }

  private fail(error: unknown): void {
    this.error = error instanceof CalcError ? error.message : 'Error';
    this.values = [];
    this.ops = [];
    this.fresh = true;
  }

  operator(op: Op): void {
    if (this.error) return;
    if (this.op !== null && this.fresh) {
      this.ops[this.ops.length - 1] = op; // pressed twice: the second one counts
      return;
    }
    this.values.push(this.value);
    this.ops.push(op);
    try {
      // The running result: everything so far for + and −; for × and ÷ only the product being built.
      const lastPlus = this.ops.slice(0, -1).map(o => o === '+' || o === '−').lastIndexOf(true);
      this.entry = show(op === '+' || op === '−' ? run(this.values, this.ops.slice(0, -1)) : run(this.values.slice(lastPlus + 1), this.ops.slice(lastPlus + 1, -1)));
    } catch (error) {
      this.fail(error);
    }
    this.fresh = true;
  }

  equals(): void {
    if (this.error || this.op === null) return;
    this.values.push(this.value);
    try {
      this.entry = show(run(this.values, this.ops));
      this.values = [];
      this.ops = [];
    } catch (error) {
      this.fail(error);
    }
    this.fresh = true;
  }

  clearEntry(): void {
    if (this.error) return this.clear();
    this.entry = '0';
    this.fresh = false;
  }

  clear(): void {
    this.entry = '0';
    this.values = [];
    this.ops = [];
    this.error = null;
    this.fresh = true;
  }

  /** Puts a number in the display as if typed (used when a sheet cell is sent back). */
  load(n: number): void {
    this.error = null;
    this.entry = show(n);
    this.fresh = true;
  }
}

// ---- The sheet -----------------------------------------------------------------------------------------------------

export type Col = 'L' | 'A' | 'B' | 'R';
export type RowId = number | 'f1' | 'f2';
export const COLS: Col[] = ['L', 'A', 'B', 'R'];

export interface Sum {
  refs: string[];
  ops: Op[];
}

export interface SheetData {
  version: 1;
  rows: number;
  /** Typed values: labels (text) and numbers in A and B, keyed by cell id. */
  values: Record<string, string>;
  /** "=" cells, keyed by cell id. */
  sums: Record<string, Sum>;
}

export const cellId = (col: Col, row: RowId) => `${col}${row}`;
export function parseId(id: string): { col: Col; row: RowId } {
  const col = id[0] as Col;
  const rest = id.slice(1);
  return { col, row: rest === 'f1' || rest === 'f2' ? rest : Number(rest) };
}

/** Sum cells: the whole = column, and A, B, = in the two foot rows. */
export function isSumCell(id: string): boolean {
  const { col, row } = parseId(id);
  return col === 'R' || (typeof row === 'string' && col !== 'L');
}

/** How a cell is named on screen: "A3", "=3"; foot rows count on after the body rows. */
export function cellName(id: string, rows: number): string {
  const { col, row } = parseId(id);
  const n = row === 'f1' ? rows + 1 : row === 'f2' ? rows + 2 : row;
  return `${col === 'R' ? '=' : col}${n}`;
}

export function describe(sum: Sum, rows: number, pendingOp: Op | null = null): string {
  const parts: string[] = [];
  sum.refs.forEach((r, i) => {
    parts.push(cellName(r, rows));
    if (i < sum.ops.length) parts.push(sum.ops[i]);
  });
  if (pendingOp && sum.ops.length < sum.refs.length) parts.push(pendingOp);
  return parts.join(' ');
}

export function emptySheet(rows = 10): SheetData {
  return { version: 1, rows, values: {}, sums: {} };
}

/** A number cell's value: empty is 0; anything that is not a number is refused by the input, but read safely here. */
function typed(data: SheetData, id: string): number {
  const raw = (data.values[id] ?? '').trim();
  if (raw === '') return 0;
  const n = Number(raw.replace(/,/g, ''));
  if (!Number.isFinite(n)) throw new CalcError(`${cellName(id, data.rows)} is not a number`);
  return n;
}

/** Every cell's value, worked out live. A cell that cannot be worked out holds its reason instead. */
export function evaluate(data: SheetData): Map<string, number | string> {
  const out = new Map<string, number | string>();
  const visiting = new Set<string>();
  const value = (id: string): number => {
    const known = out.get(id);
    if (typeof known === 'number') return known;
    if (typeof known === 'string') throw new CalcError(known);
    const sum = data.sums[id];
    if (!sum) return typed(data, id);
    if (visiting.has(id)) throw new CalcError(LOOP);
    visiting.add(id);
    try {
      const values = sum.refs.map(ref => {
        try {
          return value(ref);
        } catch (error) {
          const reason = error instanceof CalcError ? error.message : 'Error';
          throw new CalcError(reason === LOOP ? LOOP : `Uses ${cellName(ref, data.rows)}, which has a problem`);
        }
      });
      const n = run(values, sum.ops);
      out.set(id, n);
      return n;
    } catch (error) {
      const reason = error instanceof CalcError ? error.message : 'Error';
      out.set(id, reason);
      throw new CalcError(reason);
    } finally {
      visiting.delete(id);
    }
  };
  for (const id of Object.keys(data.sums)) {
    try {
      value(id);
    } catch {
      // Stored in `out` already.
    }
  }
  return out;
}

/** Why `sum` cannot be saved into `target`, or null. Loops are refused before they are saved. */
export function sumProblem(data: SheetData, target: string, sum: Sum): string | null {
  if (sum.refs.length === 0) return 'Click at least one cell before pressing =.';
  const reaches = (from: string, seen = new Set<string>()): boolean => {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (data.sums[from]?.refs ?? []).some(r => reaches(r, seen));
  };
  const loop = sum.refs.find(r => reaches(r));
  if (loop) {
    return loop === target
      ? `${cellName(target, data.rows)} cannot use itself: it would never finish adding up.`
      : `${cellName(loop, data.rows)} already uses ${cellName(target, data.rows)}, so this would go round in a loop.`;
  }
  return null;
}

/** Reads a saved sheet file; anything unexpected is dropped, not trusted. */
export function parseSheet(text: string): SheetData {
  const raw = JSON.parse(text) as Partial<SheetData>;
  const data = emptySheet(Math.min(200, Math.max(1, Math.floor(Number(raw.rows) || 10))));
  const okId = (id: string) => /^[LABR](\d{1,3}|f1|f2)$/.test(id);
  for (const [id, v] of Object.entries(raw.values ?? {})) if (okId(id) && typeof v === 'string') data.values[id] = v.slice(0, 200);
  for (const [id, s] of Object.entries(raw.sums ?? {})) {
    if (!okId(id) || !isSumCell(id) || !s || !Array.isArray(s.refs) || !Array.isArray(s.ops)) continue;
    // A sum with any part that is not right is dropped whole: half a sum would give a wrong number.
    const refs = s.refs.filter((r): r is string => typeof r === 'string' && okId(r) && r[0] !== 'L');
    const ops = s.ops.filter((o): o is Op => OPS.includes(o as Op));
    if (refs.length !== s.refs.length || ops.length !== s.ops.length) continue;
    if (refs.length && refs.length <= 100 && ops.length === refs.length - 1) data.sums[id] = { refs, ops };
  }
  return data;
}
