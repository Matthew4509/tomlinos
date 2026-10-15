// What can be typed on TOMLIN CAD's command line: points as x,y (absolute), @dx,dy (from the last point), @length<angle
// and length<angle (angles in degrees, anticlockwise from the right), a lone @ for the last point itself, sizes as
// width,height, and numbers, which may be sums such as 600/2+15 or (35+5)*2. Nothing typed is ever run as code.
import { P, add, polar, type Pt } from './geom.ts';

/** A number or a small sum (+ - * / and brackets); null when it does not read as one. */
export function parseNumber(text: string): number | null {
  // "600 400" is two numbers, not 600400: a space between figures is refused, not squeezed out.
  if (/[\d.]\s+[\d.]/.test(text)) return null;
  const s = text.replace(/\s+/g, '');
  if (!s || s.length > 200) return null;
  let i = 0;
  const peek = () => s[i];
  function expr(): number | null {
    let v = term();
    while (v !== null && (peek() === '+' || peek() === '-')) {
      const op = s[i++];
      const r = term();
      if (r === null) return null;
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }
  function term(): number | null {
    let v = factor();
    while (v !== null && (peek() === '*' || peek() === '/')) {
      const op = s[i++];
      const r = factor();
      if (r === null) return null;
      v = op === '*' ? v * r : v / r;
    }
    return v;
  }
  function factor(): number | null {
    if (peek() === '-') {
      i++;
      const v = factor();
      return v === null ? null : -v;
    }
    if (peek() === '+') {
      i++;
      return factor();
    }
    if (peek() === '(') {
      i++;
      const v = expr();
      if (v === null || peek() !== ')') return null;
      i++;
      return v;
    }
    const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s.slice(i));
    if (!m) return null;
    i += m[0].length;
    return Number(m[0]);
  }
  const v = expr();
  return v !== null && i === s.length && Number.isFinite(v) ? v : null;
}

/** Splits "a,b" (or "a<b") into its two halves only at the top level, never inside brackets. */
function split(s: string, sep: string): [string, string] | null {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
    else if (s[i] === sep && depth === 0) return [s.slice(0, i), s.slice(i + 1)];
  }
  return null;
}

export type PointRead = { p: Pt } | { problem: string } | null;

/**
 * A typed point; `last` is the point the @ forms count from. Null when the text is not written as a point at all
 * (so it may be a number or a word); a problem when it is, but cannot be used.
 */
export function parsePoint(text: string, last: Pt | null): PointRead {
  const s = text.trim();
  if (!s) return null;
  const relative = s.startsWith('@');
  const body = relative ? s.slice(1).trim() : s;
  if (relative && !last) return { problem: 'There is no last point yet for @ to count from. Click or type the first point as x,y.' };
  const from = relative ? last! : P(0, 0);
  if (relative && !body) return { p: from };
  const angled = split(body, '<');
  if (angled) {
    const l = parseNumber(angled[0]);
    const a = parseNumber(angled[1]);
    if (l === null || a === null) return { problem: `“${s}” is not a length<angle (for example @600<90).` };
    // A quarter turn (90, 180, -90...) gives exactly 0 across or up, not 6e-17.
    const q = ((a % 360) + 360) % 360;
    const exact: Record<number, Pt> = { 0: P(l, 0), 90: P(0, l), 180: P(-l, 0), 270: P(0, -l) };
    return { p: q in exact ? add(from, exact[q]) : polar(from, l, (a * Math.PI) / 180) };
  }
  const xy = split(body, ',');
  if (!xy) return null;
  const x = parseNumber(xy[0]);
  const y = parseNumber(xy[1]);
  if (x === null || y === null) return { problem: `“${s}” is not a point (for example 600,400 or @600,0).` };
  return { p: add(from, P(x, y)) };
}

/** Width,height for a rectangle round its centre: two numbers with a comma, no @. */
export function parseSize(text: string): { w: number; h: number } | null {
  const s = text.trim();
  if (s.startsWith('@')) return null;
  const xy = split(s, ',');
  if (!xy) return null;
  const w = parseNumber(xy[0]);
  const h = parseNumber(xy[1]);
  return w !== null && h !== null ? { w, h } : null;
}
