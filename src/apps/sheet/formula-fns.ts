// More of Excel's functions, with Excel's rules: conditional sums and counts with several conditions (SUMIFS...),
// maths, statistics, money (loans, savings, returns), information, logic, text, dates, lookups and references (HLOOKUP,
// LOOKUP, OFFSET, INDIRECT, ROW, ADDRESS, SUBTOTAL, AGGREGATE) and the Excel 365 functions that reshape lists (TAKE,
// DROP, VSTACK, TOCOL...). formula.ts joins them to its own and hands over the helpers they share (see Helpers there).
// Our own code; the normal distribution uses Hart's (1968) and Acklam's published approximations.
import type { Ev, Grid, Helpers, Node } from './formula.ts';
import { daysInMonth, partsOf, serialOf } from './dates.ts';
import { quoteSheet, colName } from './refs.ts';
import { CellError, clean, E, type Value } from './values.ts';

type Fn = (ev: Ev, a: Node[], d: number) => Value;
type ListFn = (ev: Ev, a: Node[], d: number) => Grid | CellError;
const ALL = 'all';

/** Every second argument from `from` on, up to Excel's 255 (where SUMIFS-style conditions are). */
const everyOther = (from: number): number[] => Array.from({ length: 128 }, (_, i) => from + i * 2);

export function moreFunctions(h: Helpers): { fns: Record<string, Fn>; lists: Record<string, ListFn>; lift: Record<string, typeof ALL | number[]> } {
  const { toNumber, toBool, text, numbers, collect, grid, str, makeMatcher, roundTo, capped, serialArg, compare, rank, wildcard } = h;

  /** An optional number argument: missing or left empty is `fallback`. */
  const opt = (ev: Ev, a: Node[], i: number, d: number, fallback: number): number | CellError => {
    const n = a[i];
    if (n === undefined || n.t === 'blank') return fallback;
    return toNumber(ev.scalar(n, d + 1));
  };
  /** A required number argument. */
  const req = (ev: Ev, a: Node[], i: number, d: number): number | CellError => (a[i] === undefined || a[i].t === 'blank' ? E.VALUE : toNumber(ev.scalar(a[i], d + 1)));
  /** Several number arguments at once; the first error wins. */
  const nums = (...xs: Array<number | CellError>): number[] | CellError => {
    for (const x of xs) if (x instanceof CellError) return x;
    return xs as number[];
  };
  const optBool = (ev: Ev, a: Node[], i: number, d: number, fallback: boolean): boolean | CellError => {
    const n = a[i];
    if (n === undefined || n.t === 'blank') return fallback;
    return toBool(ev.scalar(n, d + 1));
  };
  const fin = (x: number): Value => (Number.isFinite(x) ? clean(x) : E.NUM);
  const one = (ev: Ev, a: Node[], i: number, d: number): Value => (a[i] === undefined ? E.VALUE : ev.scalar(a[i], d + 1));
  /** Every value of a list argument, row by row. */
  const flat = (g: Grid): Value[] => {
    const out: Value[] = [];
    for (const row of g) for (const v of row) out.push(v);
    return out;
  };
  /** The numbers of one list argument (text and blanks skipped; an error stops it). */
  const listNumbers = (ev: Ev, n: Node | undefined, d: number): number[] | CellError => (n ? numbers(ev, [n], d) : E.VALUE);

  // ---- Conditions (SUMIFS, COUNTIFS, AVERAGEIFS, MAXIFS, MINIFS) -----------------------------------------------------

  /** The rows (as flat positions) that meet every condition: pairs of a range and its condition, from `from` on. */
  function meeting(ev: Ev, a: Node[], from: number, d: number, size: { rows: number; cols: number } | null): { keep: boolean[]; rows: number; cols: number } | CellError {
    if (a.length - from < 2 || (a.length - from) % 2) return E.VALUE;
    let rows = size?.rows ?? -1;
    let cols = size?.cols ?? -1;
    let keep: boolean[] | null = null;
    for (let i = from; i < a.length; i += 2) {
      const g = grid(ev, a[i], d);
      if (g instanceof CellError) return g;
      if (rows < 0) {
        rows = g.length;
        cols = g[0]?.length ?? 0;
      }
      // Every range must be the same size, as in Excel.
      if (g.length !== rows || (g[0]?.length ?? 0) !== cols) return E.VALUE;
      const match = makeMatcher(ev.scalar(a[i + 1], d + 1));
      if (match instanceof CellError) return match;
      const vals = flat(g);
      keep ??= vals.map(() => true);
      vals.forEach((v, k) => {
        if (keep![k] && !match(v)) keep![k] = false;
      });
    }
    return { keep: keep ?? [], rows, cols };
  }

  function ifs(ev: Ev, a: Node[], d: number, kind: 'sum' | 'avg' | 'max' | 'min'): Value {
    const target = grid(ev, a[0], d);
    if (target instanceof CellError) return target;
    const m = meeting(ev, a, 1, d, { rows: target.length, cols: target[0]?.length ?? 0 });
    if (m instanceof CellError) return m;
    const vals = flat(target);
    let total = 0;
    let count = 0;
    let best: number | null = null;
    for (let k = 0; k < vals.length; k++) {
      if (!m.keep[k]) continue;
      const v = vals[k];
      if (v instanceof CellError) return v;
      if (typeof v !== 'number') continue;
      total += v;
      count++;
      if (best === null || (kind === 'max' ? v > best : v < best)) best = v;
    }
    if (kind === 'sum') return clean(total);
    if (kind === 'avg') return count ? clean(total / count) : E.DIV0;
    return best ?? 0;
  }

  // ---- Statistics helpers ------------------------------------------------------------------------------------------

  const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
  const mean = (xs: number[]) => sum(xs) / xs.length;
  const devsq = (xs: number[]) => {
    const m = mean(xs);
    return xs.reduce((s, x) => s + (x - m) * (x - m), 0);
  };
  const sorted = (xs: number[]) => [...xs].sort((x, y) => x - y);

  /** Values as AVERAGEA and friends read them: TRUE is 1, FALSE and text in a range 0; text typed in must be a number. */
  function valuesA(ev: Ev, a: Node[], d: number): number[] | CellError {
    const all = collect(ev, a, d);
    if (all instanceof CellError) return all;
    const out: number[] = [];
    for (const { v, fromRange } of all) {
      if (v instanceof CellError) return v;
      if (v === null) continue;
      if (typeof v === 'number') out.push(v);
      else if (typeof v === 'boolean') out.push(v ? 1 : 0);
      else if (fromRange) out.push(0);
      else {
        const n = toNumber(v);
        if (n instanceof CellError) return n;
        out.push(n);
      }
    }
    return out;
  }

  /** Two lists read as pairs of numbers (a pair with text or a blank in it is left out); #N/A when they differ in size. */
  function pairs(ev: Ev, x: Node | undefined, y: Node | undefined, d: number): { xs: number[]; ys: number[] } | CellError {
    const gx = grid(ev, x, d);
    const gy = grid(ev, y, d);
    if (gx instanceof CellError) return gx;
    if (gy instanceof CellError) return gy;
    const fx = flat(gx);
    const fy = flat(gy);
    if (fx.length !== fy.length) return E.NA;
    const xs: number[] = [];
    const ys: number[] = [];
    for (let i = 0; i < fx.length; i++) {
      if (fx[i] instanceof CellError) return fx[i] as CellError;
      if (fy[i] instanceof CellError) return fy[i] as CellError;
      if (typeof fx[i] === 'number' && typeof fy[i] === 'number') {
        xs.push(fx[i] as number);
        ys.push(fy[i] as number);
      }
    }
    return { xs, ys };
  }

  /** PERCENTILE.INC: k from 0 to 1, between the values in order. */
  function percentileInc(xs: number[], k: number): Value {
    if (!xs.length || k < 0 || k > 1) return E.NUM;
    const s = sorted(xs);
    const pos = k * (s.length - 1);
    const i = Math.floor(pos);
    return clean(i + 1 < s.length ? s[i] + (pos - i) * (s[i + 1] - s[i]) : s[i]);
  }
  /** PERCENTILE.EXC: k strictly inside, as Excel counts it ((n+1) places). */
  function percentileExc(xs: number[], k: number): Value {
    const n = xs.length;
    if (!n || k <= 0 || k >= 1) return E.NUM;
    const pos = k * (n + 1);
    if (pos < 1 || pos > n) return E.NUM;
    const s = sorted(xs);
    const i = Math.floor(pos);
    return clean(i < n ? s[i - 1] + (pos - i) * (s[i] - s[i - 1]) : s[n - 1]);
  }
  /** Where x sits in the list, 0 to 1 (inc) or strictly between (exc), cut (not rounded) to `sig` digits, as in Excel. */
  function percentRank(xs: number[], x: number, sig: number, exc: boolean): Value {
    const s = sorted(xs);
    const n = s.length;
    if (!n || sig < 1) return E.NUM;
    if (x < s[0] || x > s[n - 1]) return E.NA;
    let pos: number;
    const at = s.indexOf(x);
    if (at >= 0) pos = at;
    else {
      let i = 0;
      while (i + 1 < n && s[i + 1] < x) i++;
      pos = i + (x - s[i]) / (s[i + 1] - s[i]);
    }
    const r = exc ? (pos + 1) / (n + 1) : n === 1 ? 1 : pos / (n - 1);
    const f = Math.pow(10, Math.trunc(sig));
    return Math.floor(clean(r * f)) / f;
  }
  function rankOf(x: number, xs: number[], ascending: boolean, avg: boolean): Value {
    if (!xs.includes(x)) return E.NA;
    const before = xs.filter(v => (ascending ? v < x : v > x)).length;
    if (!avg) return before + 1;
    const same = xs.filter(v => v === x).length;
    return clean(before + (same + 1) / 2);
  }
  function modes(xs: number[]): number[] {
    const counts = new Map<number, number>();
    for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
    let most = 1;
    for (const c of counts.values()) most = Math.max(most, c);
    if (most < 2) return [];
    // In the order each first appears, as Excel lists them.
    return [...counts].filter(([, c]) => c === most).map(([x]) => x);
  }

  // ---- Normal distribution -------------------------------------------------------------------------------------------

  /** The standard normal cumulative distribution (Hart 1968, as given by West 2005): full double precision. */
  function normCdf(x: number): number {
    const z = Math.abs(x);
    let c: number;
    if (z > 37) c = 0;
    else {
      const e = Math.exp((-z * z) / 2);
      if (z < 7.07106781186547) {
        let b = 3.52624965998911e-2 * z + 0.700383064443688;
        b = b * z + 6.37396220353165;
        b = b * z + 33.912866078383;
        b = b * z + 112.079291497871;
        b = b * z + 221.213596169931;
        b = b * z + 220.206867912376;
        c = e * b;
        b = 8.83883476483184e-2 * z + 1.75566716318264;
        b = b * z + 16.064177579207;
        b = b * z + 86.7807322029461;
        b = b * z + 296.564248779674;
        b = b * z + 637.333633378831;
        b = b * z + 793.826512519948;
        b = b * z + 440.413735824752;
        c /= b;
      } else {
        let b = z + 0.65;
        b = z + 4 / b;
        b = z + 3 / b;
        b = z + 2 / b;
        b = z + 1 / b;
        c = e / b / 2.506628274631;
      }
    }
    return x > 0 ? 1 - c : c;
  }
  const normPdf = (x: number) => Math.exp((-x * x) / 2) / Math.sqrt(2 * Math.PI);
  /** The z for a probability (Acklam's approximation, made exact with one Halley step). */
  function normInv(p: number): number {
    const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
    const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
    const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const dd = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
    const low = 0.02425;
    let x: number;
    if (p < low) {
      const q = Math.sqrt(-2 * Math.log(p));
      x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((dd[0] * q + dd[1]) * q + dd[2]) * q + dd[3]) * q + 1);
    } else if (p <= 1 - low) {
      const q = p - 0.5;
      const r = q * q;
      x = ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
    } else {
      const q = Math.sqrt(-2 * Math.log(1 - p));
      x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((dd[0] * q + dd[1]) * q + dd[2]) * q + dd[3]) * q + 1);
    }
    const e = normCdf(x) - p;
    const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
    return x - u / (1 + (x * u) / 2);
  }

  // ---- Money ---------------------------------------------------------------------------------------------------------

  /** What a loan or saving is worth at the end (Excel's FV), and the payment that clears it (PMT). */
  const fv = (r: number, n: number, pmt: number, pv: number, type: number): number =>
    r === 0 ? -(pv + pmt * n) : -(pv * Math.pow(1 + r, n) + (pmt * (1 + r * type) * (Math.pow(1 + r, n) - 1)) / r);
  const pmtOf = (r: number, n: number, pv: number, f: number, type: number): number =>
    r === 0 ? -(pv + f) / n : -(r * (f + pv * Math.pow(1 + r, n))) / ((1 + r * type) * (Math.pow(1 + r, n) - 1));
  /** The interest part of one payment (Excel's IPMT). */
  function ipmtOf(r: number, per: number, n: number, pv: number, f: number, type: number): number {
    const p = pmtOf(r, n, pv, f, type);
    if (type === 1) return per === 1 ? 0 : (fv(r, per - 2, p, pv, 1) - p) * r;
    return fv(r, per - 1, p, pv, 0) * r;
  }
  /** Solves f(r) = 0 near `guess` (Newton's method with a numeric slope); null when it does not settle. */
  function solve(f: (r: number) => number, guess: number): number | null {
    let r = guess;
    for (let i = 0; i < 200; i++) {
      const y = f(r);
      if (!Number.isFinite(y)) return null;
      if (Math.abs(y) < 1e-10) return r;
      const step = Math.max(1e-7, Math.abs(r) * 1e-7);
      const slope = (f(r + step) - y) / step;
      if (!slope || !Number.isFinite(slope)) return null;
      const next = r - y / slope;
      if (next <= -1) r = (r - 1) / 2;
      else if (Math.abs(next - r) < 1e-12) return next;
      else r = next;
    }
    return null;
  }

  /** NETWORKDAYS.INTL / WORKDAY.INTL weekends: a number (1 Saturday and Sunday... 11 Sunday only...) or "0000011". */
  function weekendDays(ev: Ev, n: Node | undefined, d: number): boolean[] | CellError {
    const off = [false, false, false, false, false, false, false];
    if (n === undefined || n.t === 'blank') {
      off[0] = off[6] = true;
      return off;
    }
    const v = ev.scalar(n, d + 1);
    if (v instanceof CellError) return v;
    if (typeof v === 'string') {
      if (!/^[01]{7}$/.test(v) || v === '1111111') return E.VALUE;
      // Monday first.
      for (let i = 0; i < 7; i++) if (v[i] === '1') off[(i + 1) % 7] = true;
      return off;
    }
    const k = toNumber(v);
    if (k instanceof CellError) return k;
    if (k >= 1 && k <= 7) {
      off[(k + 5) % 7] = true;
      off[(k + 6) % 7] = true;
    } else if (k >= 11 && k <= 17) off[k - 11] = true;
    else return E.NUM;
    return off;
  }
  function holidaySet(ev: Ev, n: Node | undefined, d: number): Set<number> | CellError {
    const out = new Set<number>();
    if (n === undefined || n.t === 'blank') return out;
    const g = grid(ev, n, d);
    if (g instanceof CellError) return g;
    for (const v of flat(g)) {
      if (v === null) continue;
      const x = toNumber(v);
      if (x instanceof CellError) return x;
      out.add(Math.floor(x));
    }
    return out;
  }

  /** 30/360 day counts: the US way (NASD) or the European one. */
  function days360(s: number, e: number, european: boolean, febEnds: boolean): number {
    const a = partsOf(Math.floor(s));
    const b = partsOf(Math.floor(e));
    let d1 = a.d;
    let d2 = b.d;
    let m2 = b.m;
    let y2 = b.y;
    if (european) {
      if (d1 === 31) d1 = 30;
      if (d2 === 31) d2 = 30;
    } else {
      const lastFeb = (p: { y: number; m: number; d: number }) => p.m === 2 && p.d === daysInMonth(p.y, 2);
      if (febEnds && lastFeb(a)) {
        if (lastFeb(b)) d2 = 30;
        d1 = 30;
      }
      if (d1 === 31) d1 = 30;
      if (d2 === 31) {
        if (d1 < 30 && !febEnds) {
          d2 = 1;
          m2++;
          if (m2 > 12) {
            m2 = 1;
            y2++;
          }
        } else d2 = 30;
      }
    }
    return (y2 - a.y) * 360 + (m2 - a.m) * 30 + (d2 - d1);
  }
  const leap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

  // ---- Reshaping lists -------------------------------------------------------------------------------------------------

  const pad = (ev: Ev, a: Node[], i: number, d: number): Value => (a[i] === undefined || a[i].t === 'blank' ? E.NA : ev.scalar(a[i], d + 1));
  const transpose = (g: Grid): Grid => (g[0] ?? []).map((_, c) => g.map(row => row[c] ?? null));
  /** CHOOSECOLS / CHOOSEROWS: the numbered lines, a minus number counting from the end. */
  function choose(ev: Ev, a: Node[], d: number, cols: boolean): Grid | CellError {
    const g = grid(ev, a[0], d);
    if (g instanceof CellError) return g;
    const lines = cols ? transpose(g) : g;
    if (a.length < 2) return E.VALUE;
    const out: Value[][] = [];
    for (let i = 1; i < a.length; i++) {
      const picks = grid(ev, a[i], d);
      if (picks instanceof CellError) return picks;
      for (const v of flat(picks)) {
        const k = toNumber(v);
        if (k instanceof CellError) return k;
        const at = Math.trunc(k);
        const idx = at > 0 ? at - 1 : lines.length + at;
        if (at === 0 || idx < 0 || idx >= lines.length) return E.VALUE;
        out.push(lines[idx]);
      }
    }
    return cols ? transpose(out) : out;
  }
  function takeDrop(ev: Ev, a: Node[], d: number, take: boolean): Grid | CellError {
    const g = grid(ev, a[0], d);
    if (g instanceof CellError) return g;
    const rows = g.length;
    const cols = g[0]?.length ?? 0;
    const r = opt(ev, a, 1, d, take ? rows : 0);
    const c = opt(ev, a, 2, d, take ? cols : 0);
    if (r instanceof CellError) return r;
    if (c instanceof CellError) return c;
    const span = (n: number, size: number): [number, number] => {
      const k = Math.trunc(n);
      if (take) return k >= 0 ? [0, Math.min(k, size)] : [Math.max(0, size + k), size];
      return k >= 0 ? [Math.min(k, size), size] : [0, Math.max(0, size + k)];
    };
    const [r0, r1] = span(r, rows);
    const [c0, c1] = span(c, cols);
    if (r1 <= r0 || c1 <= c0) return E.CALC;
    return g.slice(r0, r1).map(row => row.slice(c0, c1));
  }
  function stack(ev: Ev, a: Node[], d: number, down: boolean): Grid | CellError {
    const parts: Grid[] = [];
    for (const n of a) {
      const g = grid(ev, n, d);
      if (g instanceof CellError) return g;
      parts.push(down ? g : transpose(g));
    }
    if (!parts.length) return E.VALUE;
    const width = Math.max(...parts.map(p => p[0]?.length ?? 0));
    const out: Grid = [];
    for (const p of parts) for (const row of p) out.push([...row, ...Array<Value>(width - row.length).fill(E.NA)]);
    if (out.length * width > 1_000_000) return E.NUM;
    return down ? out : transpose(out);
  }
  function toLine(ev: Ev, a: Node[], d: number, column: boolean): Grid | CellError {
    const g = grid(ev, a[0], d);
    if (g instanceof CellError) return g;
    const ignore = opt(ev, a, 1, d, 0);
    const byCol = optBool(ev, a, 2, d, false);
    if (ignore instanceof CellError) return ignore;
    if (byCol instanceof CellError) return byCol;
    if (![0, 1, 2, 3].includes(ignore)) return E.VALUE;
    const vals = flat(byCol ? transpose(g) : g).filter(v => !((ignore & 1) && v === null) && !((ignore & 2) && v instanceof CellError));
    if (!vals.length) return E.CALC;
    return column ? vals.map(v => [v]) : [vals];
  }
  function wrap(ev: Ev, a: Node[], d: number, rowsFirst: boolean): Grid | CellError {
    const g = grid(ev, a[0], d);
    if (g instanceof CellError) return g;
    if (g.length > 1 && (g[0]?.length ?? 0) > 1) return E.VALUE;
    const vals = flat(g);
    const n = req(ev, a, 1, d);
    if (n instanceof CellError) return n;
    const k = Math.trunc(n);
    if (k < 1) return E.NUM;
    const fill = pad(ev, a, 2, d);
    const lines: Grid = [];
    for (let i = 0; i < vals.length; i += k) {
      const line = vals.slice(i, i + k);
      while (line.length < k) line.push(fill);
      lines.push(line);
    }
    return rowsFirst ? lines : transpose(lines);
  }

  // ---- SUBTOTAL and AGGREGATE ----------------------------------------------------------------------------------------

  /**
   * The values SUBTOTAL and AGGREGATE work on: each reference read cell by cell, leaving out rows hidden by a filter
   * (and, when `hand`, rows hidden by hand), cells holding SUBTOTAL or AGGREGATE themselves, and errors when asked.
   */
  function subtotalValues(ev: Ev, args: Node[], d: number, hand: boolean, skipErrors: boolean, skipNested: boolean): Array<{ v: Value; fromRange: boolean }> | CellError {
    const out: Array<{ v: Value; fromRange: boolean }> = [];
    for (const n of args) {
      const box = ev.refOf(n, d + 1);
      if (box instanceof CellError) return box;
      if (!box) {
        const all = collect(ev, [n], d);
        if (all instanceof CellError) return all;
        out.push(...all);
        continue;
      }
      const g = ev.read(box);
      if (g instanceof CellError) return g;
      for (let r = 0; r < g.length; r++) {
        const why = ev.ctx.rowHidden?.(box.s, box.r0 + r) ?? null;
        if (why === 'filter' || (why === 'hand' && hand)) continue;
        for (let c = 0; c < g[r].length; c++) {
          if (skipNested && ev.ctx.isSubtotal?.(box.s, box.c0 + c, box.r0 + r)) continue;
          const v = g[r][c];
          if (skipErrors && v instanceof CellError) continue;
          out.push({ v, fromRange: true });
        }
      }
    }
    return out;
  }
  /** One of SUBTOTAL's eleven sums over the values (1 AVERAGE ... 9 SUM, 10 VAR, 11 VARP). */
  function summarise(fn: number, all: Array<{ v: Value; fromRange: boolean }>): Value {
    if (fn === 3) {
      for (const x of all) if (x.v instanceof CellError) return x.v;
      return all.filter(x => x.v !== null).length;
    }
    const xs: number[] = [];
    for (const { v, fromRange } of all) {
      if (v instanceof CellError) return v;
      if (typeof v === 'number') xs.push(v);
      else if (!fromRange && v !== null) {
        const n = toNumber(v);
        if (n instanceof CellError) return n;
        xs.push(n);
      }
    }
    switch (fn) {
      case 1: return xs.length ? clean(mean(xs)) : E.DIV0;
      case 2: return xs.length;
      case 4: return xs.length ? xs.reduce((m, x) => (x > m ? x : m)) : 0;
      case 5: return xs.length ? xs.reduce((m, x) => (x < m ? x : m)) : 0;
      case 6: return clean(xs.reduce((p, x) => p * x, 1));
      case 7: return xs.length > 1 ? clean(Math.sqrt(devsq(xs) / (xs.length - 1))) : E.DIV0;
      case 8: return xs.length ? clean(Math.sqrt(devsq(xs) / xs.length)) : E.DIV0;
      case 9: return clean(sum(xs));
      case 10: return xs.length > 1 ? clean(devsq(xs) / (xs.length - 1)) : E.DIV0;
      case 11: return xs.length ? clean(devsq(xs) / xs.length) : E.DIV0;
    }
    return E.VALUE;
  }

  // ---- Lookups -----------------------------------------------------------------------------------------------------

  /** An exact match as VLOOKUP, HLOOKUP and MATCH read it: text ignores case, and * ? ~ are wildcards in text. */
  function same(v: Value, key: Value): boolean {
    if (v === null || key === null) return false;
    if (typeof key === 'string' && typeof v === 'string' && /[*?~]/.test(key)) return new RegExp(`^${wildcard(key)}$`, 'i').test(v);
    return rank(v) === rank(key) && compare('=', v, key);
  }

  const fns: Record<string, Fn> = {
    // ---- Conditions ----
    SUMIFS: (ev, a, d) => ifs(ev, a, d, 'sum'),
    AVERAGEIFS: (ev, a, d) => ifs(ev, a, d, 'avg'),
    MAXIFS: (ev, a, d) => ifs(ev, a, d, 'max'),
    MINIFS: (ev, a, d) => ifs(ev, a, d, 'min'),
    COUNTIFS: (ev, a, d) => {
      const m = meeting(ev, a, 0, d, null);
      return m instanceof CellError ? m : m.keep.filter(Boolean).length;
    },

    // ---- Maths ----
    CEILING: (ev, a, d) => {
      const x = nums(req(ev, a, 0, d), opt(ev, a, 1, d, 1));
      if (x instanceof CellError) return x;
      const [n, s] = x;
      if (s === 0) return 0;
      if (n > 0 && s < 0) return E.NUM;
      return fin(Math.ceil(clean(n / s)) * s);
    },
    'CEILING.MATH': (ev, a, d) => {
      const x = nums(req(ev, a, 0, d), opt(ev, a, 1, d, 1), opt(ev, a, 2, d, 0));
      if (x instanceof CellError) return x;
      const [n, s0, mode] = x;
      const s = Math.abs(s0);
      if (s === 0) return 0;
      return fin((n < 0 && mode !== 0 ? Math.floor(clean(n / s)) : Math.ceil(clean(n / s))) * s);
    },
    'CEILING.PRECISE': (ev, a, d) => {
      const x = nums(req(ev, a, 0, d), opt(ev, a, 1, d, 1));
      if (x instanceof CellError) return x;
      const s = Math.abs(x[1]);
      return s === 0 ? 0 : fin(Math.ceil(clean(x[0] / s)) * s);
    },
    FLOOR: (ev, a, d) => {
      const x = nums(req(ev, a, 0, d), opt(ev, a, 1, d, 1));
      if (x instanceof CellError) return x;
      const [n, s] = x;
      if (s === 0) return n === 0 ? 0 : E.DIV0;
      if (n > 0 && s < 0) return E.NUM;
      return fin(Math.floor(clean(n / s)) * s);
    },
    'FLOOR.MATH': (ev, a, d) => {
      const x = nums(req(ev, a, 0, d), opt(ev, a, 1, d, 1), opt(ev, a, 2, d, 0));
      if (x instanceof CellError) return x;
      const [n, s0, mode] = x;
      const s = Math.abs(s0);
      if (s === 0) return 0;
      return fin((n < 0 && mode !== 0 ? Math.ceil(clean(n / s)) : Math.floor(clean(n / s))) * s);
    },
    'FLOOR.PRECISE': (ev, a, d) => {
      const x = nums(req(ev, a, 0, d), opt(ev, a, 1, d, 1));
      if (x instanceof CellError) return x;
      const s = Math.abs(x[1]);
      return s === 0 ? 0 : fin(Math.floor(clean(x[0] / s)) * s);
    },
    MROUND: (ev, a, d) => {
      const x = nums(req(ev, a, 0, d), req(ev, a, 1, d));
      if (x instanceof CellError) return x;
      const [n, m] = x;
      if (m === 0) return 0;
      if (n * m < 0) return E.NUM;
      return fin(roundTo(n / m, 0, 'round') * m);
    },
    EVEN: (ev, a, d) => {
      const n = req(ev, a, 0, d);
      if (n instanceof CellError) return n;
      let v = Math.ceil(clean(Math.abs(n)));
      if (v % 2) v++;
      return Math.sign(n) * v || 0;
    },
    ODD: (ev, a, d) => {
      const n = req(ev, a, 0, d);
      if (n instanceof CellError) return n;
      let v = Math.ceil(clean(Math.abs(n)));
      if (v % 2 === 0) v++;
      return n < 0 ? -v : v;
    },
    TRUNC: (ev, a, d) => {
      const x = nums(req(ev, a, 0, d), opt(ev, a, 1, d, 0));
      return x instanceof CellError ? x : roundTo(x[0], Math.trunc(x[1]), 'down');
    },
    QUOTIENT: (ev, a, d) => {
      const x = nums(req(ev, a, 0, d), req(ev, a, 1, d));
      if (x instanceof CellError) return x;
      return x[1] === 0 ? E.DIV0 : Math.trunc(clean(x[0] / x[1]));
    },
    GCD: (ev, a, d) => {
      const xs = numbers(ev, a, d);
      if (xs instanceof CellError) return xs;
      if (xs.some(x => x < 0)) return E.NUM;
      const g = (p: number, q: number): number => (q ? g(q, p % q) : p);
      return xs.map(Math.trunc).reduce((p, q) => g(p, q), 0);
    },
    LCM: (ev, a, d) => {
      const xs = numbers(ev, a, d);
      if (xs instanceof CellError) return xs;
      if (xs.some(x => x < 0)) return E.NUM;
      const g = (p: number, q: number): number => (q ? g(q, p % q) : p);
      let l = 1;
      for (const x of xs.map(Math.trunc)) {
        if (x === 0) return 0;
        l = (l * x) / g(l, x);
      }
      return fin(l);
    },
    FACT: (ev, a, d) => {
      const n = req(ev, a, 0, d);
      if (n instanceof CellError) return n;
      if (n < 0) return E.NUM;
      let p = 1;
      for (let i = 2; i <= Math.trunc(n); i++) p *= i;
      return fin(p);
    },
    COMBIN: (ev, a, d) => {
      const x = nums(req(ev, a, 0, d), req(ev, a, 1, d));
      if (x instanceof CellError) return x;
      const n = Math.trunc(x[0]);
      const k = Math.trunc(x[1]);
      if (n < 0 || k < 0 || k > n) return E.NUM;
      let c = 1;
      for (let i = 1; i <= Math.min(k, n - k); i++) c = (c * (n - Math.min(k, n - k) + i)) / i;
      return fin(Math.round(c));
    },
    PERMUT: (ev, a, d) => {
      const x = nums(req(ev, a, 0, d), req(ev, a, 1, d));
      if (x instanceof CellError) return x;
      const n = Math.trunc(x[0]);
      const k = Math.trunc(x[1]);
      if (n < 0 || k < 0 || k > n) return E.NUM;
      let p = 1;
      for (let i = 0; i < k; i++) p *= n - i;
      return fin(p);
    },
    LOG: (ev, a, d) => {
      const x = nums(req(ev, a, 0, d), opt(ev, a, 1, d, 10));
      if (x instanceof CellError) return x;
      const [n, b] = x;
      if (n <= 0 || b <= 0) return E.NUM;
      if (b === 1) return E.DIV0;
      return fin(Math.log(n) / Math.log(b));
    },
    RADIANS: (ev, a, d) => { const n = req(ev, a, 0, d); return n instanceof CellError ? n : fin((n * Math.PI) / 180); },
    DEGREES: (ev, a, d) => { const n = req(ev, a, 0, d); return n instanceof CellError ? n : fin((n * 180) / Math.PI); },
    SIN: (ev, a, d) => { const n = req(ev, a, 0, d); return n instanceof CellError ? n : fin(Math.sin(n)); },
    COS: (ev, a, d) => { const n = req(ev, a, 0, d); return n instanceof CellError ? n : fin(Math.cos(n)); },
    TAN: (ev, a, d) => { const n = req(ev, a, 0, d); return n instanceof CellError ? n : fin(Math.tan(n)); },
    ASIN: (ev, a, d) => { const n = req(ev, a, 0, d); return n instanceof CellError ? n : Math.abs(n) > 1 ? E.NUM : fin(Math.asin(n)); },
    ACOS: (ev, a, d) => { const n = req(ev, a, 0, d); return n instanceof CellError ? n : Math.abs(n) > 1 ? E.NUM : fin(Math.acos(n)); },
    ATAN: (ev, a, d) => { const n = req(ev, a, 0, d); return n instanceof CellError ? n : fin(Math.atan(n)); },
    // Excel's ATAN2 takes x first, then y.
    ATAN2: (ev, a, d) => {
      const x = nums(req(ev, a, 0, d), req(ev, a, 1, d));
      if (x instanceof CellError) return x;
      return x[0] === 0 && x[1] === 0 ? E.DIV0 : fin(Math.atan2(x[1], x[0]));
    },
    SINH: (ev, a, d) => { const n = req(ev, a, 0, d); return n instanceof CellError ? n : fin(Math.sinh(n)); },
    COSH: (ev, a, d) => { const n = req(ev, a, 0, d); return n instanceof CellError ? n : fin(Math.cosh(n)); },
    TANH: (ev, a, d) => { const n = req(ev, a, 0, d); return n instanceof CellError ? n : fin(Math.tanh(n)); },
    SQRTPI: (ev, a, d) => { const n = req(ev, a, 0, d); return n instanceof CellError ? n : n < 0 ? E.NUM : fin(Math.sqrt(n * Math.PI)); },
    RAND: () => Math.random(),
    RANDBETWEEN: (ev, a, d) => {
      const x = nums(req(ev, a, 0, d), req(ev, a, 1, d));
      if (x instanceof CellError) return x;
      const lo = Math.ceil(x[0]);
      const hi = Math.floor(x[1]);
      if (lo > hi) return E.NUM;
      return lo + Math.floor(Math.random() * (hi - lo + 1));
    },
    SUMSQ: (ev, a, d) => { const xs = numbers(ev, a, d); return xs instanceof CellError ? xs : fin(xs.reduce((s, x) => s + x * x, 0)); },
    MDETERM: (ev, a, d) => {
      const g = grid(ev, a[0], d);
      if (g instanceof CellError) return g;
      const n = g.length;
      if (!n || g.some(r => r.length !== n)) return E.VALUE;
      const m: number[][] = [];
      for (const row of g) {
        const out: number[] = [];
        for (const v of row) {
          if (typeof v !== 'number') return E.VALUE;
          out.push(v);
        }
        m.push(out);
      }
      let det = 1;
      for (let i = 0; i < n; i++) {
        let p = i;
        for (let r = i + 1; r < n; r++) if (Math.abs(m[r][i]) > Math.abs(m[p][i])) p = r;
        if (m[p][i] === 0) return 0;
        if (p !== i) {
          [m[p], m[i]] = [m[i], m[p]];
          det = -det;
        }
        det *= m[i][i];
        for (let r = i + 1; r < n; r++) {
          const f = m[r][i] / m[i][i];
          for (let c = i; c < n; c++) m[r][c] -= f * m[i][c];
        }
      }
      return fin(det);
    },
    // Numbers in other bases (two's complement in ten digits for minus numbers, as Excel writes them).
    DEC2BIN: (ev, a, d) => toBase(ev, a, d, 2, 512),
    DEC2OCT: (ev, a, d) => toBase(ev, a, d, 8, 536870912),
    DEC2HEX: (ev, a, d) => toBase(ev, a, d, 16, 549755813888),
    BIN2DEC: (ev, a, d) => fromBase(ev, a, d, 2),
    OCT2DEC: (ev, a, d) => fromBase(ev, a, d, 8),
    HEX2DEC: (ev, a, d) => fromBase(ev, a, d, 16),
    BASE: (ev, a, d) => {
      const x = nums(req(ev, a, 0, d), req(ev, a, 1, d), opt(ev, a, 2, d, 0));
      if (x instanceof CellError) return x;
      const [n, radix, len] = x.map(Math.trunc);
      if (n < 0 || n >= 2 ** 53 || radix < 2 || radix > 36 || len < 0 || len > 255) return E.NUM;
      return n.toString(radix).toUpperCase().padStart(len, '0');
    },
    DECIMAL: (ev, a, d) => {
      const s = str(ev, a, 0, d);
      const r = req(ev, a, 1, d);
      if (s instanceof CellError) return s;
      if (r instanceof CellError) return r;
      const radix = Math.trunc(r);
      if (radix < 2 || radix > 36 || s.length > 255) return E.NUM;
      const digits = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'.slice(0, radix);
      let v = 0;
      for (const ch of s.toUpperCase()) {
        const k = digits.indexOf(ch);
        if (k < 0) return E.NUM;
        v = v * radix + k;
      }
      return fin(v);
    },

    // ---- Statistics ----
    AVERAGEA: (ev, a, d) => { const xs = valuesA(ev, a, d); return xs instanceof CellError ? xs : xs.length ? clean(mean(xs)) : E.DIV0; },
    MAXA: (ev, a, d) => { const xs = valuesA(ev, a, d); return xs instanceof CellError ? xs : xs.length ? xs.reduce((m, x) => (x > m ? x : m)) : 0; },
    MINA: (ev, a, d) => { const xs = valuesA(ev, a, d); return xs instanceof CellError ? xs : xs.length ? xs.reduce((m, x) => (x < m ? x : m)) : 0; },
    LARGE: (ev, a, d) => {
      const xs = listNumbers(ev, a[0], d);
      const k = req(ev, a, 1, d);
      if (xs instanceof CellError) return xs;
      if (k instanceof CellError) return k;
      const i = Math.ceil(k);
      if (i < 1 || i > xs.length) return E.NUM;
      return sorted(xs)[xs.length - i];
    },
    SMALL: (ev, a, d) => {
      const xs = listNumbers(ev, a[0], d);
      const k = req(ev, a, 1, d);
      if (xs instanceof CellError) return xs;
      if (k instanceof CellError) return k;
      const i = Math.ceil(k);
      if (i < 1 || i > xs.length) return E.NUM;
      return sorted(xs)[i - 1];
    },
    RANK: (ev, a, d) => FNS_RANK(ev, a, d, false),
    'RANK.EQ': (ev, a, d) => FNS_RANK(ev, a, d, false),
    'RANK.AVG': (ev, a, d) => FNS_RANK(ev, a, d, true),
    PERCENTILE: (ev, a, d) => { const xs = listNumbers(ev, a[0], d); const k = req(ev, a, 1, d); return xs instanceof CellError ? xs : k instanceof CellError ? k : percentileInc(xs, k); },
    'PERCENTILE.INC': (ev, a, d) => { const xs = listNumbers(ev, a[0], d); const k = req(ev, a, 1, d); return xs instanceof CellError ? xs : k instanceof CellError ? k : percentileInc(xs, k); },
    'PERCENTILE.EXC': (ev, a, d) => { const xs = listNumbers(ev, a[0], d); const k = req(ev, a, 1, d); return xs instanceof CellError ? xs : k instanceof CellError ? k : percentileExc(xs, k); },
    QUARTILE: (ev, a, d) => quartile(ev, a, d, false),
    'QUARTILE.INC': (ev, a, d) => quartile(ev, a, d, false),
    'QUARTILE.EXC': (ev, a, d) => quartile(ev, a, d, true),
    PERCENTRANK: (ev, a, d) => pRank(ev, a, d, false),
    'PERCENTRANK.INC': (ev, a, d) => pRank(ev, a, d, false),
    'PERCENTRANK.EXC': (ev, a, d) => pRank(ev, a, d, true),
    MODE: (ev, a, d) => { const xs = numbers(ev, a, d); if (xs instanceof CellError) return xs; const m = modes(xs); return m.length ? m[0] : E.NA; },
    'MODE.SNGL': (ev, a, d) => { const xs = numbers(ev, a, d); if (xs instanceof CellError) return xs; const m = modes(xs); return m.length ? m[0] : E.NA; },
    STDEV: (ev, a, d) => spread(ev, a, d, true, true),
    'STDEV.S': (ev, a, d) => spread(ev, a, d, true, true),
    STDEVP: (ev, a, d) => spread(ev, a, d, true, false),
    'STDEV.P': (ev, a, d) => spread(ev, a, d, true, false),
    VAR: (ev, a, d) => spread(ev, a, d, false, true),
    'VAR.S': (ev, a, d) => spread(ev, a, d, false, true),
    VARP: (ev, a, d) => spread(ev, a, d, false, false),
    'VAR.P': (ev, a, d) => spread(ev, a, d, false, false),
    AVEDEV: (ev, a, d) => {
      const xs = numbers(ev, a, d);
      if (xs instanceof CellError) return xs;
      if (!xs.length) return E.NUM;
      const m = mean(xs);
      return clean(xs.reduce((s, x) => s + Math.abs(x - m), 0) / xs.length);
    },
    DEVSQ: (ev, a, d) => { const xs = numbers(ev, a, d); return xs instanceof CellError ? xs : xs.length ? clean(devsq(xs)) : E.NUM; },
    GEOMEAN: (ev, a, d) => {
      const xs = numbers(ev, a, d);
      if (xs instanceof CellError) return xs;
      if (!xs.length || xs.some(x => x <= 0)) return E.NUM;
      return fin(Math.exp(xs.reduce((s, x) => s + Math.log(x), 0) / xs.length));
    },
    HARMEAN: (ev, a, d) => {
      const xs = numbers(ev, a, d);
      if (xs instanceof CellError) return xs;
      if (!xs.length || xs.some(x => x <= 0)) return E.NUM;
      return fin(xs.length / xs.reduce((s, x) => s + 1 / x, 0));
    },
    TRIMMEAN: (ev, a, d) => {
      const xs = listNumbers(ev, a[0], d);
      const p = req(ev, a, 1, d);
      if (xs instanceof CellError) return xs;
      if (p instanceof CellError) return p;
      if (p < 0 || p >= 1 || !xs.length) return E.NUM;
      const k = Math.floor((xs.length * p) / 2);
      const s = sorted(xs).slice(k, xs.length - k);
      return clean(mean(s));
    },
    CORREL: (ev, a, d) => correl(ev, a, d),
    PEARSON: (ev, a, d) => correl(ev, a, d),
    RSQ: (ev, a, d) => { const r = correl(ev, a, d); return typeof r === 'number' ? clean(r * r) : r; },
    SLOPE: (ev, a, d) => line(ev, a[0], a[1], d, 'slope'),
    INTERCEPT: (ev, a, d) => line(ev, a[0], a[1], d, 'intercept'),
    FORECAST: (ev, a, d) => forecast(ev, a, d),
    'FORECAST.LINEAR': (ev, a, d) => forecast(ev, a, d),
    COVAR: (ev, a, d) => covar(ev, a, d, false),
    'COVARIANCE.P': (ev, a, d) => covar(ev, a, d, false),
    'COVARIANCE.S': (ev, a, d) => covar(ev, a, d, true),
    STANDARDIZE: (ev, a, d) => {
      const x = nums(req(ev, a, 0, d), req(ev, a, 1, d), req(ev, a, 2, d));
      if (x instanceof CellError) return x;
      return x[2] <= 0 ? E.NUM : fin((x[0] - x[1]) / x[2]);
    },
    'NORM.DIST': (ev, a, d) => normDist(ev, a, d),
    NORMDIST: (ev, a, d) => normDist(ev, a, d),
    'NORM.S.DIST': (ev, a, d) => {
      const z = req(ev, a, 0, d);
      const cum = optBool(ev, a, 1, d, true);
      if (z instanceof CellError) return z;
      if (cum instanceof CellError) return cum;
      return fin(cum ? normCdf(z) : normPdf(z));
    },
    NORMSDIST: (ev, a, d) => { const z = req(ev, a, 0, d); return z instanceof CellError ? z : fin(normCdf(z)); },
    'NORM.INV': (ev, a, d) => normInvFn(ev, a, d),
    NORMINV: (ev, a, d) => normInvFn(ev, a, d),
    'NORM.S.INV': (ev, a, d) => { const p = req(ev, a, 0, d); return p instanceof CellError ? p : p <= 0 || p >= 1 ? E.NUM : fin(normInv(p)); },
    NORMSINV: (ev, a, d) => { const p = req(ev, a, 0, d); return p instanceof CellError ? p : p <= 0 || p >= 1 ? E.NUM : fin(normInv(p)); },

    // ---- Money ----
    PMT: (ev, a, d) => {
      const x = nums(req(ev, a, 0, d), req(ev, a, 1, d), req(ev, a, 2, d), opt(ev, a, 3, d, 0), opt(ev, a, 4, d, 0));
      if (x instanceof CellError) return x;
      const [r, n, pv, f, t] = x;
      if (n === 0) return E.NUM;
      return fin(pmtOf(r, n, pv, f, t ? 1 : 0));
    },
    FV: (ev, a, d) => {
      const x = nums(req(ev, a, 0, d), req(ev, a, 1, d), opt(ev, a, 2, d, 0), opt(ev, a, 3, d, 0), opt(ev, a, 4, d, 0));
      if (x instanceof CellError) return x;
      return fin(fv(x[0], x[1], x[2], x[3], x[4] ? 1 : 0));
    },
    PV: (ev, a, d) => {
      const x = nums(req(ev, a, 0, d), req(ev, a, 1, d), opt(ev, a, 2, d, 0), opt(ev, a, 3, d, 0), opt(ev, a, 4, d, 0));
      if (x instanceof CellError) return x;
      const [r, n, pmt, f, t0] = x;
      const t = t0 ? 1 : 0;
      if (r === 0) return fin(-(f + pmt * n));
      return fin(-(f + (pmt * (1 + r * t) * (Math.pow(1 + r, n) - 1)) / r) / Math.pow(1 + r, n));
    },
    NPER: (ev, a, d) => {
      const x = nums(req(ev, a, 0, d), req(ev, a, 1, d), req(ev, a, 2, d), opt(ev, a, 3, d, 0), opt(ev, a, 4, d, 0));
      if (x instanceof CellError) return x;
      const [r, pmt, pv, f, t0] = x;
      const t = t0 ? 1 : 0;
      if (r === 0) return pmt === 0 ? E.NUM : fin(-(pv + f) / pmt);
      const num = pmt * (1 + r * t) - f * r;
      const den = pv * r + pmt * (1 + r * t);
      if (den === 0 || num / den <= 0) return E.NUM;
      return fin(Math.log(num / den) / Math.log(1 + r));
    },
    RATE: (ev, a, d) => {
      const x = nums(req(ev, a, 0, d), req(ev, a, 1, d), req(ev, a, 2, d), opt(ev, a, 3, d, 0), opt(ev, a, 4, d, 0), opt(ev, a, 5, d, 0.1));
      if (x instanceof CellError) return x;
      const [n, pmt, pv, f, t0, guess] = x;
      const t = t0 ? 1 : 0;
      if (n <= 0) return E.NUM;
      const r = solve(rate => (Math.abs(rate) < 1e-12 ? pv + pmt * n + f : pv * Math.pow(1 + rate, n) + (pmt * (1 + rate * t) * (Math.pow(1 + rate, n) - 1)) / rate + f), guess);
      return r === null ? E.NUM : fin(r);
    },
    IPMT: (ev, a, d) => {
      const x = nums(req(ev, a, 0, d), req(ev, a, 1, d), req(ev, a, 2, d), req(ev, a, 3, d), opt(ev, a, 4, d, 0), opt(ev, a, 5, d, 0));
      if (x instanceof CellError) return x;
      const [r, per, n, pv, f, t] = x;
      if (per < 1 || per > n) return E.NUM;
      return fin(ipmtOf(r, per, n, pv, f, t ? 1 : 0));
    },
    PPMT: (ev, a, d) => {
      const x = nums(req(ev, a, 0, d), req(ev, a, 1, d), req(ev, a, 2, d), req(ev, a, 3, d), opt(ev, a, 4, d, 0), opt(ev, a, 5, d, 0));
      if (x instanceof CellError) return x;
      const [r, per, n, pv, f, t] = x;
      if (per < 1 || per > n) return E.NUM;
      return fin(pmtOf(r, n, pv, f, t ? 1 : 0) - ipmtOf(r, per, n, pv, f, t ? 1 : 0));
    },
    CUMIPMT: (ev, a, d) => cumulative(ev, a, d, true),
    CUMPRINC: (ev, a, d) => cumulative(ev, a, d, false),
    NPV: (ev, a, d) => {
      const r = req(ev, a, 0, d);
      if (r instanceof CellError) return r;
      const xs = numbers(ev, a.slice(1), d);
      if (xs instanceof CellError) return xs;
      if (r === -1) return E.DIV0;
      return fin(xs.reduce((s, x, i) => s + x / Math.pow(1 + r, i + 1), 0));
    },
    IRR: (ev, a, d) => {
      const xs = listNumbers(ev, a[0], d);
      const guess = opt(ev, a, 1, d, 0.1);
      if (xs instanceof CellError) return xs;
      if (guess instanceof CellError) return guess;
      if (!xs.some(x => x > 0) || !xs.some(x => x < 0)) return E.NUM;
      const r = solve(rate => xs.reduce((s, x, i) => s + x / Math.pow(1 + rate, i), 0), guess);
      return r === null ? E.NUM : fin(r);
    },
    XNPV: (ev, a, d) => {
      const r = req(ev, a, 0, d);
      if (r instanceof CellError) return r;
      const p = cashflows(ev, a[1], a[2], d);
      if (p instanceof CellError) return p;
      if (r <= -1) return E.NUM;
      return fin(p.v.reduce((s, x, i) => s + x / Math.pow(1 + r, (p.t[i] - p.t[0]) / 365), 0));
    },
    XIRR: (ev, a, d) => {
      const p = cashflows(ev, a[0], a[1], d);
      const guess = opt(ev, a, 2, d, 0.1);
      if (p instanceof CellError) return p;
      if (guess instanceof CellError) return guess;
      if (!p.v.some(x => x > 0) || !p.v.some(x => x < 0)) return E.NUM;
      const r = solve(rate => p.v.reduce((s, x, i) => s + x / Math.pow(1 + rate, (p.t[i] - p.t[0]) / 365), 0), guess);
      return r === null ? E.NUM : fin(r);
    },
    SLN: (ev, a, d) => {
      const x = nums(req(ev, a, 0, d), req(ev, a, 1, d), req(ev, a, 2, d));
      if (x instanceof CellError) return x;
      return x[2] === 0 ? E.DIV0 : fin((x[0] - x[1]) / x[2]);
    },
    SYD: (ev, a, d) => {
      const x = nums(req(ev, a, 0, d), req(ev, a, 1, d), req(ev, a, 2, d), req(ev, a, 3, d));
      if (x instanceof CellError) return x;
      const [cost, salvage, life, per] = x;
      if (life <= 0 || per < 1 || per > life) return E.NUM;
      return fin(((cost - salvage) * (life - per + 1) * 2) / (life * (life + 1)));
    },
    DDB: (ev, a, d) => {
      const x = nums(req(ev, a, 0, d), req(ev, a, 1, d), req(ev, a, 2, d), req(ev, a, 3, d), opt(ev, a, 4, d, 2));
      if (x instanceof CellError) return x;
      const [cost, salvage, life, per, factor] = x;
      if (cost < 0 || salvage < 0 || life <= 0 || per <= 0 || per > life || factor <= 0) return E.NUM;
      let value = cost;
      let dep = 0;
      for (let i = 1; i <= Math.ceil(per); i++) {
        dep = Math.min(value * (factor / life), Math.max(0, value - salvage));
        value -= dep;
      }
      return fin(dep);
    },
    EFFECT: (ev, a, d) => {
      const x = nums(req(ev, a, 0, d), req(ev, a, 1, d));
      if (x instanceof CellError) return x;
      const n = Math.trunc(x[1]);
      if (x[0] <= 0 || n < 1) return E.NUM;
      return fin(Math.pow(1 + x[0] / n, n) - 1);
    },
    NOMINAL: (ev, a, d) => {
      const x = nums(req(ev, a, 0, d), req(ev, a, 1, d));
      if (x instanceof CellError) return x;
      const n = Math.trunc(x[1]);
      if (x[0] <= 0 || n < 1) return E.NUM;
      return fin(n * (Math.pow(1 + x[0], 1 / n) - 1));
    },

    // ---- Information and logic ----
    ISEVEN: (ev, a, d) => { const n = toNumber(one(ev, a, 0, d)); return n instanceof CellError ? n : Math.trunc(n) % 2 === 0; },
    ISODD: (ev, a, d) => { const n = toNumber(one(ev, a, 0, d)); return n instanceof CellError ? n : Math.abs(Math.trunc(n) % 2) === 1; },
    ISNONTEXT: (ev, a, d) => typeof one(ev, a, 0, d) !== 'string',
    ISREF: (ev, a, d) => {
      const b = a[0] ? ev.refOf(a[0], d + 1) : null;
      return !!b && !(b instanceof CellError);
    },
    ISFORMULA: (ev, a, d) => {
      const b = a[0] ? ev.refOf(a[0], d + 1) : null;
      if (b instanceof CellError) return b;
      if (!b) return E.VALUE;
      return (ev.ctx.formulaAt?.(b.s, b.c0, b.r0) ?? null) !== null;
    },
    FORMULATEXT: (ev, a, d) => {
      const b = a[0] ? ev.refOf(a[0], d + 1) : null;
      if (b instanceof CellError) return b;
      if (!b) return E.VALUE;
      return ev.ctx.formulaAt?.(b.s, b.c0, b.r0) ?? E.NA;
    },
    N: (ev, a, d) => {
      const v = one(ev, a, 0, d);
      if (v instanceof CellError) return v;
      return typeof v === 'number' ? v : v === true ? 1 : 0;
    },
    T: (ev, a, d) => {
      const v = one(ev, a, 0, d);
      return v instanceof CellError ? v : typeof v === 'string' ? v : '';
    },
    TYPE: (ev, a, d) => {
      if (!a[0]) return E.VALUE;
      if (a[0].t !== 'ref' && h.isList(a[0])) return 64;
      const v = ev.scalar(a[0], d + 1);
      return v instanceof CellError ? 16 : typeof v === 'string' ? 2 : typeof v === 'boolean' ? 4 : 1;
    },
    NA: () => E.NA,
    'ERROR.TYPE': (ev, a, d) => {
      const v = one(ev, a, 0, d);
      if (!(v instanceof CellError)) return E.NA;
      const order = ['#NULL!', '#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#N/A'];
      const i = order.indexOf(v.code);
      return i >= 0 ? i + 1 : v.code === '#SPILL!' ? 9 : v.code === '#CALC!' ? 14 : E.NA;
    },
    XOR: (ev, a, d) => {
      const all = collect(ev, a, d);
      if (all instanceof CellError) return all;
      let n = 0;
      let any = false;
      for (const { v } of all) {
        if (v === null || v === '') continue;
        const b = toBool(v);
        if (b instanceof CellError) return b;
        any = true;
        if (b) n++;
      }
      return any ? n % 2 === 1 : E.VALUE;
    },

    // ---- Text ----
    FIXED: (ev, a, d) => {
      const x = nums(req(ev, a, 0, d), opt(ev, a, 1, d, 2));
      const plain = optBool(ev, a, 2, d, false);
      if (x instanceof CellError) return x;
      if (plain instanceof CellError) return plain;
      return fixedText(x[0], Math.trunc(x[1]), !plain, '');
    },
    DOLLAR: (ev, a, d) => {
      const x = nums(req(ev, a, 0, d), opt(ev, a, 1, d, 2));
      if (x instanceof CellError) return x;
      return fixedText(x[0], Math.trunc(x[1]), true, '$');
    },
    VALUETOTEXT: (ev, a, d) => {
      const v = one(ev, a, 0, d);
      const strict = opt(ev, a, 1, d, 0);
      if (strict instanceof CellError) return strict;
      return typeof v === 'string' && strict === 1 ? `"${v.replace(/"/g, '""')}"` : text(v);
    },
    ARRAYTOTEXT: (ev, a, d) => {
      const g = grid(ev, a[0], d);
      const strict = opt(ev, a, 1, d, 0);
      if (g instanceof CellError) return g;
      if (strict instanceof CellError) return strict;
      const show = (v: Value) => (typeof v === 'string' && strict === 1 ? `"${v.replace(/"/g, '""')}"` : text(v));
      if (strict !== 1) return capped(flat(g).map(show).join(', '));
      return capped(`{${g.map(row => row.map(show).join(',')).join(';')}}`);
    },
    HYPERLINK: (ev, a, d) => (a[1] && a[1].t !== 'blank' ? ev.scalar(a[1], d + 1) : ev.scalar(a[0] ?? { t: 'blank' }, d + 1)),

    // ---- Dates ----
    YEARFRAC: (ev, a, d) => {
      const s0 = serialArg(ev, a, 0, d);
      const e0 = serialArg(ev, a, 1, d);
      const basis = opt(ev, a, 2, d, 0);
      if (s0 instanceof CellError) return s0;
      if (e0 instanceof CellError) return e0;
      if (basis instanceof CellError) return basis;
      const b = Math.trunc(basis);
      if (b < 0 || b > 4) return E.NUM;
      let s = Math.floor(s0);
      let e = Math.floor(e0);
      if (s > e) [s, e] = [e, s];
      if (b === 0) return clean(days360(s, e, false, true) / 360);
      if (b === 4) return clean(days360(s, e, true, false) / 360);
      if (b === 2) return clean((e - s) / 360);
      if (b === 3) return clean((e - s) / 365);
      const ps = partsOf(s);
      const pe = partsOf(e);
      if (ps.y === pe.y) return clean((e - s) / (leap(ps.y) ? 366 : 365));
      const yearLater = serialOf(ps.y + 1, ps.m, 1) + Math.min(ps.d, daysInMonth(ps.y + 1, ps.m)) - 1;
      if (e <= yearLater) {
        // Up to a year apart: 366 days if a 29 February falls between them.
        let feb29 = false;
        for (let y = ps.y; y <= pe.y; y++) {
          if (!leap(y)) continue;
          const f = serialOf(y, 2, 29);
          if (f >= s && f <= e) feb29 = true;
        }
        return clean((e - s) / (feb29 ? 366 : 365));
      }
      let days = 0;
      for (let y = ps.y; y <= pe.y; y++) days += leap(y) ? 366 : 365;
      return clean((e - s) / (days / (pe.y - ps.y + 1)));
    },
    DAYS360: (ev, a, d) => {
      const s = serialArg(ev, a, 0, d);
      const e = serialArg(ev, a, 1, d);
      const eu = optBool(ev, a, 2, d, false);
      if (s instanceof CellError) return s;
      if (e instanceof CellError) return e;
      if (eu instanceof CellError) return eu;
      return days360(s, e, eu, false);
    },
    'NETWORKDAYS.INTL': (ev, a, d) => {
      const s0 = serialArg(ev, a, 0, d);
      const e0 = serialArg(ev, a, 1, d);
      if (s0 instanceof CellError) return s0;
      if (e0 instanceof CellError) return e0;
      const off = weekendDays(ev, a[2], d);
      if (off instanceof CellError) return off;
      const hol = holidaySet(ev, a[3], d);
      if (hol instanceof CellError) return hol;
      const s = Math.floor(s0);
      const e = Math.floor(e0);
      const step = s <= e ? 1 : -1;
      let n = 0;
      for (let day = s; step > 0 ? day <= e : day >= e; day += step) if (!off[partsOf(day).wd] && !hol.has(day)) n++;
      return step * n;
    },
    'WORKDAY.INTL': (ev, a, d) => {
      const s0 = serialArg(ev, a, 0, d);
      const n = req(ev, a, 1, d);
      if (s0 instanceof CellError) return s0;
      if (n instanceof CellError) return n;
      const off = weekendDays(ev, a[2], d);
      if (off instanceof CellError) return off;
      const hol = holidaySet(ev, a[3], d);
      if (hol instanceof CellError) return hol;
      const k = Math.trunc(n);
      if (Math.abs(k) > 1_000_000) return E.NUM;
      let day = Math.floor(s0);
      const step = k >= 0 ? 1 : -1;
      for (let left = Math.abs(k); left > 0;) {
        day += step;
        if (day < 0 || day > 2_958_465) return E.NUM;
        if (!off[partsOf(day).wd] && !hol.has(day)) left--;
      }
      return day;
    },

    // ---- Lookups and references ----
    HLOOKUP: (ev, a, d) => {
      const key = one(ev, a, 0, d);
      const table = grid(ev, a[1], d);
      const row = req(ev, a, 2, d);
      const approx = optBool(ev, a, 3, d, true);
      if (key instanceof CellError) return key;
      if (table instanceof CellError) return table;
      if (row instanceof CellError) return row;
      if (approx instanceof CellError) return approx;
      const r = Math.trunc(row);
      if (r < 1 || r > table.length) return E.REF;
      const first = table[0] ?? [];
      let best = -1;
      for (let c = 0; c < first.length; c++) {
        const v = first[c];
        if (approx) {
          if (v !== null && rank(v) === rank(key) && compare('<=', v, key)) best = c;
          else if (v !== null && rank(v) === rank(key)) break;
        } else if (same(v, key)) {
          best = c;
          break;
        }
      }
      return best < 0 ? E.NA : table[r - 1][best];
    },
    LOOKUP: (ev, a, d) => {
      const key = one(ev, a, 0, d);
      const look = grid(ev, a[1], d);
      if (key instanceof CellError) return key;
      if (look instanceof CellError) return look;
      let line: Value[];
      let result: Value[];
      if (a[2] && a[2].t !== 'blank') {
        const res = grid(ev, a[2], d);
        if (res instanceof CellError) return res;
        line = flat(look);
        result = flat(res);
      } else {
        // The array form: a wide block is searched along its top row and answers from its bottom row; a tall one
        // down its first column, answering from its last.
        const wide = (look[0]?.length ?? 0) > look.length;
        line = wide ? look[0] : look.map(r => r[0]);
        result = wide ? look[look.length - 1] : look.map(r => r[r.length - 1]);
      }
      let best = -1;
      for (let i = 0; i < line.length; i++) {
        const v = line[i];
        if (v === null || v instanceof CellError || rank(v) !== rank(key)) continue;
        if (compare('<=', v, key)) best = i;
      }
      if (best < 0) return E.NA;
      return best < result.length ? result[best] : E.NA;
    },
    ROW: (ev, a, d) => {
      if (!a.length || a[0].t === 'blank') return ev.ctx.here ? ev.ctx.here.row + 1 : E.VALUE;
      const b = ev.refOf(a[0], d + 1);
      if (b instanceof CellError) return b;
      return b ? b.r0 + 1 : E.VALUE;
    },
    COLUMN: (ev, a, d) => {
      if (!a.length || a[0].t === 'blank') return ev.ctx.here ? ev.ctx.here.col + 1 : E.VALUE;
      const b = ev.refOf(a[0], d + 1);
      if (b instanceof CellError) return b;
      return b ? b.c0 + 1 : E.VALUE;
    },
    ADDRESS: (ev, a, d) => {
      const x = nums(req(ev, a, 0, d), req(ev, a, 1, d), opt(ev, a, 2, d, 1));
      const a1 = optBool(ev, a, 3, d, true);
      const sheet = a[4] && a[4].t !== 'blank' ? str(ev, a, 4, d) : '';
      if (x instanceof CellError) return x;
      if (a1 instanceof CellError) return a1;
      if (sheet instanceof CellError) return sheet;
      const [row, col, abs] = x.map(Math.trunc);
      if (row < 1 || col < 1 || row > 1_048_576 || col > 16_384 || abs < 1 || abs > 4) return E.VALUE;
      const absR = abs === 1 || abs === 2;
      const absC = abs === 1 || abs === 3;
      const where = a1
        ? `${absC ? '$' : ''}${colName(col - 1)}${absR ? '$' : ''}${row}`
        : `R${absR ? row : `[${row}]`}C${absC ? col : `[${col}]`}`;
      return sheet ? `${quoteSheet(sheet)}!${where}` : where;
    },
    SUBTOTAL: (ev, a, d) => {
      const f = req(ev, a, 0, d);
      if (f instanceof CellError) return f;
      const fn = Math.trunc(f);
      const base = fn > 100 ? fn - 100 : fn;
      if (base < 1 || base > 11 || (fn > 11 && fn < 101) || fn > 111) return E.VALUE;
      if (a.length < 2) return E.VALUE;
      const all = subtotalValues(ev, a.slice(1), d, fn > 100, false, true);
      return all instanceof CellError ? all : summarise(base, all);
    },
    AGGREGATE: (ev, a, d) => {
      const x = nums(req(ev, a, 0, d), opt(ev, a, 1, d, 0));
      if (x instanceof CellError) return x;
      const [fn, o] = x.map(Math.trunc);
      if (fn < 1 || fn > 19 || o < 0 || o > 7) return E.VALUE;
      const hand = o === 1 || o === 3 || o === 5 || o === 7;
      const errors = o === 2 || o === 3 || o === 6 || o === 7;
      const nested = o <= 3;
      if (fn <= 13) {
        const all = subtotalValues(ev, a.slice(2), d, hand, errors, nested);
        if (all instanceof CellError) return all;
        if (fn <= 11) return summarise(fn, all);
        const xs = all.map(v => v.v).filter((v): v is number => typeof v === 'number');
        for (const v of all) if (v.v instanceof CellError) return v.v;
        if (!xs.length) return E.NUM;
        const s = sorted(xs);
        if (fn === 12) return clean(s.length % 2 ? s[s.length >> 1] : (s[(s.length >> 1) - 1] + s[s.length >> 1]) / 2);
        const m = modes(xs);
        return m.length ? m[0] : E.NA;
      }
      // 14 LARGE, 15 SMALL, 16 PERCENTILE.INC, 17 QUARTILE.INC, 18 PERCENTILE.EXC, 19 QUARTILE.EXC: the last argument is k.
      const k = req(ev, a, a.length - 1, d);
      if (k instanceof CellError) return k;
      const all = subtotalValues(ev, a.slice(2, -1), d, hand, errors, nested);
      if (all instanceof CellError) return all;
      for (const v of all) if (v.v instanceof CellError) return v.v;
      const xs = all.map(v => v.v).filter((v): v is number => typeof v === 'number');
      const s = sorted(xs);
      switch (fn) {
        case 14: { const i = Math.ceil(k); return i < 1 || i > s.length ? E.NUM : s[s.length - i]; }
        case 15: { const i = Math.ceil(k); return i < 1 || i > s.length ? E.NUM : s[i - 1]; }
        case 16: return percentileInc(xs, k);
        case 17: return Math.trunc(k) < 0 || Math.trunc(k) > 4 ? E.NUM : percentileInc(xs, Math.trunc(k) / 4);
        case 18: return percentileExc(xs, k);
        default: return Math.trunc(k) < 1 || Math.trunc(k) > 3 ? E.NUM : percentileExc(xs, Math.trunc(k) / 4);
      }
    },
  };

  // ---- Helpers that use the table above ------------------------------------------------------------------------------

  function FNS_RANK(ev: Ev, a: Node[], d: number, avg: boolean): Value {
    const x = req(ev, a, 0, d);
    const xs = listNumbers(ev, a[1], d);
    const order = opt(ev, a, 2, d, 0);
    if (x instanceof CellError) return x;
    if (xs instanceof CellError) return xs;
    if (order instanceof CellError) return order;
    return rankOf(x, xs, order !== 0, avg);
  }
  function quartile(ev: Ev, a: Node[], d: number, exc: boolean): Value {
    const xs = listNumbers(ev, a[0], d);
    const q = req(ev, a, 1, d);
    if (xs instanceof CellError) return xs;
    if (q instanceof CellError) return q;
    const k = Math.trunc(q);
    if (exc) return k < 1 || k > 3 ? E.NUM : percentileExc(xs, k / 4);
    return k < 0 || k > 4 ? E.NUM : percentileInc(xs, k / 4);
  }
  function pRank(ev: Ev, a: Node[], d: number, exc: boolean): Value {
    const xs = listNumbers(ev, a[0], d);
    const x = req(ev, a, 1, d);
    const sig = opt(ev, a, 2, d, 3);
    if (xs instanceof CellError) return xs;
    if (x instanceof CellError) return x;
    if (sig instanceof CellError) return sig;
    return percentRank(xs, x, sig, exc);
  }
  function spread(ev: Ev, a: Node[], d: number, root: boolean, sample: boolean): Value {
    const xs = numbers(ev, a, d);
    if (xs instanceof CellError) return xs;
    const n = sample ? xs.length - 1 : xs.length;
    if (n < 1) return E.DIV0;
    const v = devsq(xs) / n;
    return clean(root ? Math.sqrt(v) : v);
  }
  function correl(ev: Ev, a: Node[], d: number): Value {
    const p = pairs(ev, a[0], a[1], d);
    if (p instanceof CellError) return p;
    if (p.xs.length < 2) return E.DIV0;
    const mx = mean(p.xs);
    const my = mean(p.ys);
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    p.xs.forEach((x, i) => {
      sxy += (x - mx) * (p.ys[i] - my);
      sxx += (x - mx) ** 2;
      syy += (p.ys[i] - my) ** 2;
    });
    return sxx === 0 || syy === 0 ? E.DIV0 : clean(sxy / Math.sqrt(sxx * syy));
  }
  /** The best straight line through the points (y on x): its slope or where it meets the y axis. */
  function line(ev: Ev, ys: Node | undefined, xs: Node | undefined, d: number, what: 'slope' | 'intercept'): Value {
    const p = pairs(ev, xs, ys, d);
    if (p instanceof CellError) return p;
    if (!p.xs.length) return E.DIV0;
    const mx = mean(p.xs);
    const my = mean(p.ys);
    let sxy = 0;
    let sxx = 0;
    p.xs.forEach((x, i) => {
      sxy += (x - mx) * (p.ys[i] - my);
      sxx += (x - mx) ** 2;
    });
    if (sxx === 0) return E.DIV0;
    const slope = sxy / sxx;
    return clean(what === 'slope' ? slope : my - slope * mx);
  }
  function forecast(ev: Ev, a: Node[], d: number): Value {
    const x = req(ev, a, 0, d);
    if (x instanceof CellError) return x;
    const slope = line(ev, a[1], a[2], d, 'slope');
    const icpt = line(ev, a[1], a[2], d, 'intercept');
    if (typeof slope !== 'number') return slope;
    if (typeof icpt !== 'number') return icpt;
    return clean(icpt + slope * x);
  }
  function covar(ev: Ev, a: Node[], d: number, sample: boolean): Value {
    const p = pairs(ev, a[0], a[1], d);
    if (p instanceof CellError) return p;
    const n = p.xs.length;
    if (!n || (sample && n < 2)) return E.DIV0;
    const mx = mean(p.xs);
    const my = mean(p.ys);
    const s = p.xs.reduce((t, x, i) => t + (x - mx) * (p.ys[i] - my), 0);
    return clean(s / (sample ? n - 1 : n));
  }
  function normDist(ev: Ev, a: Node[], d: number): Value {
    const x = nums(req(ev, a, 0, d), req(ev, a, 1, d), req(ev, a, 2, d));
    const cum = optBool(ev, a, 3, d, true);
    if (x instanceof CellError) return x;
    if (cum instanceof CellError) return cum;
    const [v, m, sd] = x;
    if (sd <= 0) return E.NUM;
    const z = (v - m) / sd;
    return fin(cum ? normCdf(z) : normPdf(z) / sd);
  }
  function normInvFn(ev: Ev, a: Node[], d: number): Value {
    const x = nums(req(ev, a, 0, d), req(ev, a, 1, d), req(ev, a, 2, d));
    if (x instanceof CellError) return x;
    const [p, m, sd] = x;
    if (p <= 0 || p >= 1 || sd <= 0) return E.NUM;
    return fin(m + sd * normInv(p));
  }
  function cumulative(ev: Ev, a: Node[], d: number, interest: boolean): Value {
    const x = nums(req(ev, a, 0, d), req(ev, a, 1, d), req(ev, a, 2, d), req(ev, a, 3, d), req(ev, a, 4, d), req(ev, a, 5, d));
    if (x instanceof CellError) return x;
    const [r, n, pv, s0, e0, t] = x;
    const s = Math.trunc(s0);
    const e = Math.trunc(e0);
    if (r <= 0 || n <= 0 || pv <= 0 || s < 1 || e < s || e > n || (t !== 0 && t !== 1)) return E.NUM;
    let total = 0;
    for (let per = s; per <= e; per++) {
      const ip = ipmtOf(r, per, n, pv, 0, t);
      total += interest ? ip : pmtOf(r, n, pv, 0, t) - ip;
    }
    return fin(total);
  }
  function cashflows(ev: Ev, vn: Node | undefined, tn: Node | undefined, d: number): { v: number[]; t: number[] } | CellError {
    const gv = grid(ev, vn, d);
    const gt = grid(ev, tn, d);
    if (gv instanceof CellError) return gv;
    if (gt instanceof CellError) return gt;
    const fv2 = flat(gv);
    const ft = flat(gt);
    if (fv2.length !== ft.length || !fv2.length) return E.NUM;
    const v: number[] = [];
    const t: number[] = [];
    for (let i = 0; i < fv2.length; i++) {
      const x = toNumber(fv2[i]);
      const y = toNumber(ft[i]);
      if (x instanceof CellError) return x;
      if (y instanceof CellError) return y;
      if (i > 0 && Math.floor(y) < Math.floor(t[0])) return E.NUM;
      v.push(x);
      t.push(Math.floor(y));
    }
    return { v, t };
  }
  function toBase(ev: Ev, a: Node[], d: number, base: number, half: number): Value {
    const n = req(ev, a, 0, d);
    const places = opt(ev, a, 1, d, 0);
    if (n instanceof CellError) return n;
    if (places instanceof CellError) return places;
    const k = Math.trunc(n);
    if (k < -half || k >= half) return E.NUM;
    if (k < 0) return (Math.pow(base, 10) + k).toString(base).toUpperCase();
    const s = k.toString(base).toUpperCase();
    if (a[1] && a[1].t !== 'blank') {
      const p = Math.trunc(places);
      if (p < s.length || p > 10) return E.NUM;
      return s.padStart(p, '0');
    }
    return s;
  }
  function fromBase(ev: Ev, a: Node[], d: number, base: number): Value {
    const s = str(ev, a, 0, d);
    if (s instanceof CellError) return s;
    const digits = '0123456789ABCDEF'.slice(0, base);
    const t = s.trim().toUpperCase();
    if (t.length > 10 || [...t].some(ch => !digits.includes(ch))) return E.NUM;
    if (t === '') return 0;
    const v = parseInt(t, base);
    // Ten digits with the top bit set is a minus number.
    return t.length === 10 && v >= Math.pow(base, 10) / 2 ? v - Math.pow(base, 10) : v;
  }
  function fixedText(n: number, dec: number, commas: boolean, symbol: string): Value {
    if (dec > 127) return E.VALUE;
    const r = roundTo(n, dec, 'round');
    const abs = Math.abs(r);
    let body = dec > 0 ? abs.toFixed(Math.min(dec, 100)) : String(Math.round(abs));
    if (commas) {
      const [i, f] = body.split('.');
      body = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (f !== undefined ? `.${f}` : '');
    }
    return r < 0 ? (symbol ? `(${symbol}${body})` : `-${body}`) : `${symbol}${body}`;
  }

  // ---- Functions that give lists -------------------------------------------------------------------------------------

  const lists: Record<string, ListFn> = {
    OFFSET: (ev, a, d) => ev.readRef({ t: 'call', name: 'OFFSET', args: a }, d + 1),
    INDIRECT: (ev, a, d) => ev.readRef({ t: 'call', name: 'INDIRECT', args: a }, d + 1),
    RANDARRAY: (ev, a, d) => {
      const x = nums(opt(ev, a, 0, d, 1), opt(ev, a, 1, d, 1), opt(ev, a, 2, d, 0), opt(ev, a, 3, d, 1));
      const whole = optBool(ev, a, 4, d, false);
      if (x instanceof CellError) return x;
      if (whole instanceof CellError) return whole;
      const [rows, cols, lo, hi] = x;
      if (rows < 1 || cols < 1 || lo > hi) return E.VALUE;
      if (rows * cols > 1_000_000) return E.NUM;
      const out: Grid = [];
      for (let r = 0; r < Math.trunc(rows); r++) {
        const row: Value[] = [];
        for (let c = 0; c < Math.trunc(cols); c++) {
          row.push(whole ? Math.ceil(lo) + Math.floor(Math.random() * (Math.floor(hi) - Math.ceil(lo) + 1)) : lo + Math.random() * (hi - lo));
        }
        out.push(row);
      }
      return out;
    },
    'MODE.MULT': (ev, a, d) => {
      const xs = numbers(ev, a, d);
      if (xs instanceof CellError) return xs;
      const m = modes(xs);
      return m.length ? m.map(x => [x]) : E.NA;
    },
    FREQUENCY: (ev, a, d) => {
      const data = listNumbers(ev, a[0], d);
      const binsIn = listNumbers(ev, a[1], d);
      if (data instanceof CellError) return data;
      if (binsIn instanceof CellError) return binsIn;
      // Each bin counts the values above the next smaller bin, up to it; one more count for those above every bin.
      const order = binsIn.map((b, i) => ({ b, i })).sort((x, y) => x.b - y.b);
      const counts = Array<number>(binsIn.length + 1).fill(0);
      for (const v of data) {
        const k = order.findIndex(o => v <= o.b);
        counts[k < 0 ? binsIn.length : order[k].i]++;
      }
      return counts.map(c => [c]);
    },
    MMULT: (ev, a, d) => {
      const x = grid(ev, a[0], d);
      const y = grid(ev, a[1], d);
      if (x instanceof CellError) return x;
      if (y instanceof CellError) return y;
      const n = x[0]?.length ?? 0;
      if (n !== y.length) return E.VALUE;
      for (const v of [...flat(x), ...flat(y)]) if (typeof v !== 'number') return E.VALUE;
      return x.map(row => (y[0] ?? []).map((_, c) => clean(row.reduce<number>((s, v, k) => s + (v as number) * (y[k][c] as number), 0))));
    },
    CHOOSECOLS: (ev, a, d) => choose(ev, a, d, true),
    CHOOSEROWS: (ev, a, d) => choose(ev, a, d, false),
    TAKE: (ev, a, d) => takeDrop(ev, a, d, true),
    DROP: (ev, a, d) => takeDrop(ev, a, d, false),
    VSTACK: (ev, a, d) => stack(ev, a, d, true),
    HSTACK: (ev, a, d) => stack(ev, a, d, false),
    TOCOL: (ev, a, d) => toLine(ev, a, d, true),
    TOROW: (ev, a, d) => toLine(ev, a, d, false),
    WRAPROWS: (ev, a, d) => wrap(ev, a, d, true),
    WRAPCOLS: (ev, a, d) => wrap(ev, a, d, false),
    EXPAND: (ev, a, d) => {
      const g = grid(ev, a[0], d);
      if (g instanceof CellError) return g;
      const rows0 = g.length;
      const cols0 = g[0]?.length ?? 0;
      const x = nums(opt(ev, a, 1, d, rows0), opt(ev, a, 2, d, cols0));
      if (x instanceof CellError) return x;
      const [rows, cols] = x.map(Math.trunc);
      if (rows < rows0 || cols < cols0) return E.VALUE;
      if (rows * cols > 1_000_000) return E.NUM;
      const fill = pad(ev, a, 3, d);
      const out: Grid = [];
      for (let r = 0; r < rows; r++) {
        const row: Value[] = [];
        for (let c = 0; c < cols; c++) row.push(r < rows0 && c < cols0 ? g[r][c] : fill);
        out.push(row);
      }
      return out;
    },
  };

  const lift: Record<string, typeof ALL | number[]> = {
    SUMIFS: everyOther(2), AVERAGEIFS: everyOther(2), MAXIFS: everyOther(2), MINIFS: everyOther(2), COUNTIFS: everyOther(1),
    LARGE: [1], SMALL: [1], PERCENTILE: [1], 'PERCENTILE.INC': [1], 'PERCENTILE.EXC': [1], QUARTILE: [1], 'QUARTILE.INC': [1], 'QUARTILE.EXC': [1],
    RANK: [0], 'RANK.EQ': [0], 'RANK.AVG': [0], PERCENTRANK: [1], 'PERCENTRANK.INC': [1], 'PERCENTRANK.EXC': [1],
    HLOOKUP: [0, 2], LOOKUP: [0], FORECAST: [0], 'FORECAST.LINEAR': [0],
    'NETWORKDAYS.INTL': [0, 1], 'WORKDAY.INTL': [0, 1],
  };
  for (const name of ['CEILING', 'CEILING.MATH', 'CEILING.PRECISE', 'FLOOR', 'FLOOR.MATH', 'FLOOR.PRECISE', 'MROUND', 'EVEN', 'ODD', 'TRUNC',
    'QUOTIENT', 'FACT', 'COMBIN', 'PERMUT', 'LOG', 'RADIANS', 'DEGREES', 'SIN', 'COS', 'TAN', 'ASIN', 'ACOS', 'ATAN', 'ATAN2', 'SINH', 'COSH',
    'TANH', 'SQRTPI', 'RANDBETWEEN', 'DEC2BIN', 'DEC2OCT', 'DEC2HEX', 'BIN2DEC', 'OCT2DEC', 'HEX2DEC', 'BASE', 'DECIMAL', 'STANDARDIZE',
    'NORM.DIST', 'NORMDIST', 'NORM.S.DIST', 'NORMSDIST', 'NORM.INV', 'NORMINV', 'NORM.S.INV', 'NORMSINV', 'PMT', 'FV', 'PV', 'NPER', 'RATE',
    'IPMT', 'PPMT', 'SLN', 'SYD', 'DDB', 'EFFECT', 'NOMINAL', 'ISEVEN', 'ISODD', 'ISNONTEXT', 'N', 'T', 'ERROR.TYPE', 'FIXED', 'DOLLAR',
    'VALUETOTEXT', 'HYPERLINK', 'YEARFRAC', 'DAYS360', 'ADDRESS']) lift[name] = ALL;

  return { fns, lists, lift };
}
