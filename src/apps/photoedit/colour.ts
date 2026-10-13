// Photo Editor's colour tools: levels, curves, hue / saturation / lightness, colour balance, threshold, posterise,
// desaturate, and the histogram the Levels window draws. Plain functions on RGBA arrays (no browser), tested in Node.
// Transparency is never changed.
import type { Pixels } from './pixels.ts';

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** Which channels a table applies to: all three, or one of them. */
export type Channel = 'rgb' | 'r' | 'g' | 'b';

export interface Histogram {
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  /** Brightness as people see it (luminance). */
  lum: Uint32Array;
  count: number;
}

/** Counts of each value 0-255. Fully see-through pixels are not counted (they have no colour to see). */
export function histogram(p: Pixels): Histogram {
  const out = { r: new Uint32Array(256), g: new Uint32Array(256), b: new Uint32Array(256), lum: new Uint32Array(256), count: 0 };
  const d = p.data;
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    out.r[d[i]]++;
    out.g[d[i + 1]]++;
    out.b[d[i + 2]]++;
    out.lum[Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2])]++;
    out.count++;
  }
  return out;
}

export interface Levels {
  inLow: number;
  inHigh: number;
  /** 0.1 to 10; above 1 lightens the middle tones. */
  gamma: number;
  outLow: number;
  outHigh: number;
}

export const LEVELS_NONE: Levels = { inLow: 0, inHigh: 255, gamma: 1, outLow: 0, outHigh: 255 };

export function levelsTable(l: Levels): Uint8ClampedArray {
  const t = new Uint8ClampedArray(256);
  const span = Math.max(1, l.inHigh - l.inLow);
  const g = Math.min(10, Math.max(0.1, l.gamma));
  for (let x = 0; x < 256; x++) {
    let v = Math.min(1, Math.max(0, (x - l.inLow) / span));
    v = Math.pow(v, 1 / g);
    t[x] = Math.round(l.outLow + v * (l.outHigh - l.outLow));
  }
  return t;
}

/** Levels' "Auto": stretches so the darkest and lightest 0.5% of pixels reach black and white. */
export function autoLevels(hist: Uint32Array, count: number): Levels {
  const cut = count * 0.005;
  let lo = 0, hi = 255, n = 0;
  for (; lo < 255; lo++) if ((n += hist[lo]) > cut) break;
  n = 0;
  for (; hi > 0; hi--) if ((n += hist[hi]) > cut) break;
  if (hi <= lo) return { ...LEVELS_NONE };
  return { ...LEVELS_NONE, inLow: lo, inHigh: hi };
}

/**
 * The curve through the points (x and y from 0 to 255, sorted by x), as a table. Between points it bends smoothly
 * without overshooting (monotone cubic), so a curve made of rising points never dips.
 */
export function curveTable(points: Array<[number, number]>): Uint8ClampedArray {
  const pts = [...points].sort((a, b) => a[0] - b[0]).filter((p, i, all) => i === 0 || p[0] !== all[i - 1][0]);
  const t = new Uint8ClampedArray(256);
  if (pts.length === 0) {
    for (let x = 0; x < 256; x++) t[x] = x;
    return t;
  }
  if (pts.length === 1) return t.fill(clamp(Math.round(pts[0][1])));
  const n = pts.length;
  const dx: number[] = [], m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1][0] - pts[i][0]);
    m.push((pts[i + 1][1] - pts[i][1]) / dx[i]);
  }
  const tan: number[] = [m[0]];
  for (let i = 1; i < n - 1; i++) tan.push(m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2);
  tan.push(m[n - 2]);
  // Fritsch-Carlson: shorten tangents that would overshoot.
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      tan[i] = tan[i + 1] = 0;
      continue;
    }
    const a = tan[i] / m[i], b = tan[i + 1] / m[i];
    const s = a * a + b * b;
    if (s > 9) {
      const k = 3 / Math.sqrt(s);
      tan[i] = k * a * m[i];
      tan[i + 1] = k * b * m[i];
    }
  }
  for (let x = 0; x < 256; x++) {
    if (x <= pts[0][0]) t[x] = clamp(Math.round(pts[0][1]));
    else if (x >= pts[n - 1][0]) t[x] = clamp(Math.round(pts[n - 1][1]));
    else {
      let i = 0;
      while (x > pts[i + 1][0]) i++;
      const h = dx[i], s = (x - pts[i][0]) / h;
      const h00 = 2 * s ** 3 - 3 * s ** 2 + 1, h10 = s ** 3 - 2 * s ** 2 + s, h01 = -2 * s ** 3 + 3 * s ** 2, h11 = s ** 3 - s ** 2;
      t[x] = clamp(Math.round(h00 * pts[i][1] + h10 * h * tan[i] + h01 * pts[i + 1][1] + h11 * h * tan[i + 1]));
    }
  }
  return t;
}

/** Runs every pixel's channels through a table (from levelsTable or curveTable). */
export function applyTable(p: Pixels, table: Uint8ClampedArray, channel: Channel = 'rgb'): void {
  const d = p.data;
  const only = channel === 'r' ? 0 : channel === 'g' ? 1 : channel === 'b' ? 2 : -1;
  for (let i = 0; i < d.length; i += 4) {
    if (only >= 0) d[i + only] = table[d[i + only]];
    else {
      d[i] = table[d[i]];
      d[i + 1] = table[d[i + 1]];
      d[i + 2] = table[d[i + 2]];
    }
  }
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const hue = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [hue * 60, s, l];
}

function hslToRgb(hue: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    t = ((t % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const h = hue / 360;
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}

/** hue -180 to 180 degrees, saturation and lightness -100 to 100; all 0 changes nothing. */
export function hueSaturation(p: Pixels, hue: number, sat: number, light: number): void {
  const d = p.data;
  const sf = 1 + sat / 100;
  for (let i = 0; i < d.length; i += 4) {
    let [hh, s, l] = rgbToHsl(d[i], d[i + 1], d[i + 2]);
    hh += hue;
    s = Math.min(1, Math.max(0, s * sf));
    let [r, g, b] = hslToRgb(hh, s, l);
    if (light > 0) {
      const k = light / 100;
      r += (255 - r) * k;
      g += (255 - g) * k;
      b += (255 - b) * k;
    } else if (light < 0) {
      const k = 1 + light / 100;
      r *= k;
      g *= k;
      b *= k;
    }
    d[i] = clamp(Math.round(r));
    d[i + 1] = clamp(Math.round(g));
    d[i + 2] = clamp(Math.round(b));
  }
}

/** Three pushes per range (each -100 to 100): towards red (from cyan), green (from magenta), blue (from yellow). */
export interface Balance {
  shadows: [number, number, number];
  midtones: [number, number, number];
  highlights: [number, number, number];
}

export function colourBalance(p: Pixels, bal: Balance): void {
  const d = p.data;
  // How much each range applies at each brightness: shadows fade out by the middle, highlights fade in from it.
  const ws = new Float32Array(256), wm = new Float32Array(256), wh = new Float32Array(256);
  for (let v = 0; v < 256; v++) {
    const l = v / 255;
    ws[v] = (1 - l) * (1 - l);
    wh[v] = l * l;
    wm[v] = 1 - ws[v] - wh[v];
  }
  const k = 64 / 100;
  for (let i = 0; i < d.length; i += 4) {
    const lum = Math.round(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
    for (let c = 0; c < 3; c++) {
      const push = ws[lum] * bal.shadows[c] + wm[lum] * bal.midtones[c] + wh[lum] * bal.highlights[c];
      d[i + c] = clamp(Math.round(d[i + c] + push * k));
    }
  }
}

/** White where the brightness is from `low` to `high`, black elsewhere. */
export function threshold(p: Pixels, low: number, high = 255): void {
  const d = p.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    const out = v >= low && v <= high ? 255 : 0;
    d[i] = d[i + 1] = d[i + 2] = out;
  }
}

/** Only `levels` steps per channel (2 to 256). */
export function posterise(p: Pixels, levels: number): void {
  const n = Math.min(256, Math.max(2, Math.round(levels)));
  const t = new Uint8ClampedArray(256);
  for (let x = 0; x < 256; x++) t[x] = Math.round((Math.round((x / 255) * (n - 1)) / (n - 1)) * 255);
  applyTable(p, t);
}

export type GreyMode = 'luminance' | 'lightness' | 'average';

/** Grey by one of three rules: luminance (as the eye sees), lightness (half way between the brightest and darkest
 *  channel), average (the three channels added and divided by three). */
export function desaturate(p: Pixels, mode: GreyMode): void {
  const d = p.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const v = mode === 'lightness' ? (Math.max(r, g, b) + Math.min(r, g, b)) / 2 : mode === 'average' ? (r + g + b) / 3 : 0.2126 * r + 0.7152 * g + 0.0722 * b;
    d[i] = d[i + 1] = d[i + 2] = Math.round(v);
  }
}
