// What a cell can hold, and how a value is shown as text (General, Number, Currency, Percent, Comma).
export class CellError {
  readonly code: string;
  constructor(code: string) {
    this.code = code;
  }
}
export const E = {
  DIV0: new CellError('#DIV/0!'),
  VALUE: new CellError('#VALUE!'),
  REF: new CellError('#REF!'),
  NAME: new CellError('#NAME?'),
  NUM: new CellError('#NUM!'),
  NA: new CellError('#N/A'),
  CIRC: new CellError('#CIRC!'),
};

/** null = an empty cell. */
export type Value = number | string | boolean | CellError | null;

export interface CellStyle {
  b?: boolean;
  i?: boolean;
  u?: boolean;
  al?: 'l' | 'c' | 'r';
  fmt?: 'number' | 'currency' | 'percent' | 'comma' | 'text';
  dec?: number;
  fill?: string;
  color?: string;
  bt?: boolean;
  bb?: boolean;
  bl?: boolean;
  br?: boolean;
}

/** Rounds away binary noise, so 0.1 + 0.2 is 0.3, the way a spreadsheet shows it. */
export const clean = (n: number): number => (Number.isFinite(n) ? parseFloat(n.toPrecision(15)) : n);

export function formatGeneral(n: number): string {
  if (!Number.isFinite(n)) return '#NUM!';
  const c = clean(n);
  if (c === 0) return '0';
  const abs = Math.abs(c);
  if (abs >= 1e11 || abs < 1e-9) {
    return c.toExponential(5).replace(/\.?0+e/, 'e').replace('e+', 'E+').replace('e-', 'E-');
  }
  const s = String(parseFloat(c.toPrecision(11)));
  return s.includes('e') ? c.toFixed(10).replace(/\.?0+$/, '') : s;
}

function group(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Fixed decimals, rounding half away from zero as a spreadsheet does. */
export function fixed(n: number, dec: number): string {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(clean(n));
  const rounded = Number(Math.round(Number(`${abs}e${dec}`)) + `e-${dec}`);
  const s = (Number.isFinite(rounded) ? rounded : abs).toFixed(dec);
  return (Number(s) === 0 ? '' : sign) + s;
}

export function formatNumber(n: number, style: CellStyle | undefined, symbol = '$'): string {
  const fmt = style?.fmt;
  const dec = style?.dec;
  if (!fmt || fmt === 'text') return formatGeneral(n);
  if (fmt === 'percent') return `${fixed(n * 100, dec ?? 0)}%`;
  const s = fixed(n, dec ?? 2);
  if (fmt === 'number') return s;
  const neg = s.startsWith('-');
  const [i, f] = (neg ? s.slice(1) : s).split('.');
  const body = group(i) + (f !== undefined ? `.${f}` : '');
  return `${neg ? '-' : ''}${fmt === 'currency' ? symbol : ''}${body}`;
}

export function valueText(v: Value, style: CellStyle | undefined, symbol = '$'): string {
  if (v === null) return '';
  if (v instanceof CellError) return v.code;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return formatNumber(v, style, symbol);
  return v;
}
