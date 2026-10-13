// Photo Editor's retouching brushes, one "dab" (a round touch of the brush) at a time: clone, heal, smudge,
// dodge / burn, blur / sharpen. Plain functions on RGBA arrays (no browser), tested in Node. Each one changes the
// pixels under the dab only, weighted by the brush's soft edge, its strength and the selection (when there is one).
// Colours are mixed by how solid each pixel is, so painting onto see-through parts does not darken them.
import { BLUR, mixPixel, SHARPEN, type Pixels } from './pixels.ts';
import type { Rect } from './history.ts';
import type { Mask } from './selection.ts';

export interface Dab {
  x: number;
  y: number;
  radius: number;
  /** 0 = soft all the way from the middle, 1 = a hard edge. */
  hardness: number;
  /** 0 to 1. */
  strength: number;
}

/**
 * What a clone, heal or dodge / burn stroke remembers so it never goes past its strength however many dabs overlap
 * (as in GIMP): the layer as it was when the stroke began, and how strongly each pixel has been touched so far.
 */
export interface StrokeState {
  base: Uint8ClampedArray;
  /** 0-255 per pixel. */
  cover: Uint8Array;
}

export function makeStroke(p: Pixels): StrokeState {
  return { base: p.data.slice(), cover: new Uint8Array(p.width * p.height) };
}

/** How strongly the brush touches a pixel `dist` from its middle (1 inside the hard part, fading to 0 at the rim). */
export function falloff(dist: number, radius: number, hardness: number): number {
  if (dist >= radius) return 0;
  const inner = radius * Math.min(1, Math.max(0, hardness));
  if (dist <= inner || radius - inner < 1e-6) return 1;
  const t = 1 - (dist - inner) / (radius - inner);
  return t * t * (3 - 2 * t);
}

/** The square of pixels a dab can touch, clipped to the picture. */
export function dabRect(d: Dab, w: number, h: number): Rect | null {
  const x0 = Math.max(0, Math.floor(d.x - d.radius)), y0 = Math.max(0, Math.floor(d.y - d.radius));
  const x1 = Math.min(w, Math.ceil(d.x + d.radius)), y1 = Math.min(h, Math.ceil(d.y + d.radius));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/** Calls fn(index, weight) for each pixel the dab touches. */
function eachPixel(p: Pixels, d: Dab, mask: Mask | null, fn: (i: number, wgt: number, x: number, y: number) => void): Rect | null {
  const r = dabRect(d, p.width, p.height);
  if (!r) return null;
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      let wgt = falloff(Math.hypot(x + 0.5 - d.x, y + 0.5 - d.y), d.radius, d.hardness) * d.strength;
      if (mask) wgt *= mask[y * p.width + x] / 255;
      if (wgt > 0) fn((y * p.width + x) * 4, wgt, x, y);
    }
  }
  return r;
}

/**
 * Puts colour (r, g, b, a) into pixel i by `wgt`. With a stroke, the pixel is worked out from the stroke's start at
 * the strongest weight it has had so far, so overlapping dabs never add up past the strength.
 */
function put(t: Uint8ClampedArray, i: number, wgt: number, s: StrokeState | undefined, r: number, g: number, b: number, a: number): void {
  if (!s) return mixPixel(t, i, r, g, b, a, wgt);
  const n = i >> 2;
  const c = Math.max(s.cover[n], Math.round(wgt * 255));
  if (c <= s.cover[n]) return;
  s.cover[n] = c;
  t[i] = s.base[i];
  t[i + 1] = s.base[i + 1];
  t[i + 2] = s.base[i + 2];
  t[i + 3] = s.base[i + 3];
  mixPixel(t, i, r, g, b, a, c / 255);
}

/** The source pixel for pixel (x, y): its middle moved by (dx, dy). Null when that falls outside. */
const sourceAt = (source: Pixels, x: number, y: number, dx: number, dy: number): number | null => {
  const sx = Math.floor(x + 0.5 + dx), sy = Math.floor(y + 0.5 + dy);
  return sx < 0 || sy < 0 || sx >= source.width || sy >= source.height ? null : (sy * source.width + sx) * 4;
};

/** Clone stamp: copies from `source` (the layer as it was when the stroke began) `dx`, `dy` away. */
export function cloneDab(p: Pixels, source: Pixels, dx: number, dy: number, d: Dab, mask: Mask | null, stroke?: StrokeState): Rect | null {
  const s = source.data, t = p.data;
  return eachPixel(p, d, mask, (i, wgt, x, y) => {
    const j = sourceAt(source, x, y, dx, dy);
    if (j !== null) put(t, i, wgt, stroke, s[j], s[j + 1], s[j + 2], s[j + 3]);
  });
}

/** Healing: as the clone stamp, but the copied pixels are shifted to the brightness and colour AROUND the dab (a ring
 *  just outside it, at both ends), so a patch of skin from the forehead does not show as a blotch on the cheek, and the
 *  blemish being covered does not tint the patch. */
export function healDab(p: Pixels, source: Pixels, dx: number, dy: number, d: Dab, mask: Mask | null, stroke?: StrokeState): Rect | null {
  if (!dabRect(d, p.width, p.height)) return null;
  const s = source.data, t = stroke ? stroke.base : p.data;
  const ring = (inner: number, outer: number) => {
    const here = [0, 0, 0], there = [0, 0, 0];
    let n = 0;
    const x0 = Math.max(0, Math.floor(d.x - outer)), x1 = Math.min(p.width, Math.ceil(d.x + outer));
    const y0 = Math.max(0, Math.floor(d.y - outer)), y1 = Math.min(p.height, Math.ceil(d.y + outer));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const dist = Math.hypot(x + 0.5 - d.x, y + 0.5 - d.y);
        if (dist < inner || dist >= outer) continue;
        const j = sourceAt(source, x, y, dx, dy);
        if (j === null) continue;
        const i = (y * p.width + x) * 4;
        if (!t[i + 3] || !s[j + 3]) continue;
        for (let c = 0; c < 3; c++) {
          here[c] += t[i + c];
          there[c] += s[j + c];
        }
        n++;
      }
    }
    return n ? here.map((v, c) => (v - there[c]) / n) : null;
  };
  const shift = ring(d.radius, d.radius + Math.max(2, d.radius * 0.5)) ?? ring(0, d.radius);
  if (!shift) return null;
  const out = p.data;
  return eachPixel(p, d, mask, (i, wgt, x, y) => {
    const j = sourceAt(source, x, y, dx, dy);
    if (j !== null) put(out, i, wgt, stroke, s[j] + shift[0], s[j + 1] + shift[1], s[j + 2] + shift[2], s[j + 3]);
  });
}

/**
 * Smudge: the brush carries the colour it picked up and smears it along. `carry` is the paint on the brush, a
 * square (2R+1) wide for the stroke's first radius R; makeCarry() fills it from the first dab.
 */
export interface Carry {
  size: number;
  data: Float32Array;
}

export function makeCarry(p: Pixels, x: number, y: number, radius: number): Carry {
  const R = Math.ceil(radius);
  const size = 2 * R + 1;
  const data = new Float32Array(size * size * 4);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const px = Math.min(p.width - 1, Math.max(0, Math.floor(x) - R + i));
    const py = Math.min(p.height - 1, Math.max(0, Math.floor(y) - R + j));
    const k = (py * p.width + px) * 4;
    for (let c = 0; c < 4; c++) data[(j * size + i) * 4 + c] = p.data[k + c];
  }
  return { size, data };
}

export function smudgeDab(p: Pixels, carry: Carry, d: Dab, mask: Mask | null): Rect | null {
  const R = (carry.size - 1) / 2;
  const cx = Math.floor(d.x), cy = Math.floor(d.y);
  const t = p.data;
  const dab = { ...d, radius: Math.min(d.radius, R + 0.5) };
  const before = [0, 0, 0, 0];
  return eachPixel(p, dab, mask, (i, wgt, x, y) => {
    const ci = x - cx + R, cj = y - cy + R;
    if (ci < 0 || cj < 0 || ci >= carry.size || cj >= carry.size) return;
    const k = (cj * carry.size + ci) * 4;
    for (let c = 0; c < 4; c++) before[c] = t[i + c];
    const cd = carry.data;
    mixPixel(t, i, cd[k], cd[k + 1], cd[k + 2], cd[k + 3], wgt);
    // The brush picks up a little of what it passes over (colour counted by how solid each side is).
    const ka = cd[k + 3], kb = before[3];
    const na = ka + (kb - ka) * 0.25;
    for (let c = 0; c < 3; c++) cd[k + c] = na > 0 ? (cd[k + c] * ka * 0.75 + before[c] * kb * 0.25) / na : cd[k + c];
    cd[k + 3] = na;
  });
}

/** Dodge lightens, burn darkens, the middle tones most (as GIMP's default): black stays black under dodge and white
 *  stays white under burn. */
export function dodgeBurnDab(p: Pixels, d: Dab, mode: 'dodge' | 'burn', mask: Mask | null, stroke?: StrokeState): Rect | null {
  const t = p.data;
  const from = stroke ? stroke.base : t;
  const curve = (v: number, k: number) => 255 * Math.pow(v / 255, mode === 'dodge' ? 1 / (1 + k) : 1 + k);
  return eachPixel(p, d, mask, (i, wgt) => {
    if (!stroke) {
      for (let c = 0; c < 3; c++) t[i + c] = curve(t[i + c], wgt);
      return;
    }
    const n = i >> 2;
    const c = Math.max(stroke.cover[n], Math.round(wgt * 255));
    if (c <= stroke.cover[n]) return;
    stroke.cover[n] = c;
    for (let ch = 0; ch < 3; ch++) t[i + ch] = curve(from[i + ch], c / 255);
  });
}

/** Blur or sharpen under the brush (colours weighted by how solid they are; the see-through amount is filtered too). */
export function blurSharpenDab(p: Pixels, d: Dab, mode: 'blur' | 'sharpen', mask: Mask | null): Rect | null {
  const r = dabRect(d, p.width, p.height);
  if (!r) return null;
  const k = mode === 'blur' ? BLUR : SHARPEN;
  const sum = k.reduce((a, b) => a + b, 0) || 1;
  // The 3 x 3 sums read the pixels as they were before this dab.
  const x0 = Math.max(0, r.x - 1), y0 = Math.max(0, r.y - 1);
  const x1 = Math.min(p.width, r.x + r.w + 1), y1 = Math.min(p.height, r.y + r.h + 1);
  const bw = x1 - x0;
  const src = new Uint8ClampedArray(bw * (y1 - y0) * 4);
  for (let y = y0; y < y1; y++) src.set(p.data.subarray((y * p.width + x0) * 4, (y * p.width + x1) * 4), (y - y0) * bw * 4);
  const t = p.data;
  return eachPixel(p, d, mask, (i, wgt, x, y) => {
    let cr = 0, cg = 0, cb = 0, ca = 0;
    for (let ky = -1; ky <= 1; ky++) {
      const yy = Math.min(y1 - 1, Math.max(y0, y + ky)) - y0;
      for (let kx = -1; kx <= 1; kx++) {
        const xx = Math.min(x1 - 1, Math.max(x0, x + kx)) - x0;
        const j = (yy * bw + xx) * 4;
        const wa = k[(ky + 1) * 3 + kx + 1] * src[j + 3];
        cr += src[j] * wa;
        cg += src[j + 1] * wa;
        cb += src[j + 2] * wa;
        ca += wa;
      }
    }
    if (ca <= 0) return mixPixel(t, i, 0, 0, 0, 0, wgt);
    const clamp = (v: number) => Math.min(255, Math.max(0, v));
    mixPixel(t, i, clamp(cr / ca), clamp(cg / ca), clamp(cb / ca), clamp(ca / sum), wgt);
  });
}

/**
 * Where to put dabs along a stroke: every `spacing` pixels, carrying the left-over distance from one pointer move
 * to the next so a slow and a fast stroke put dabs equally far apart.
 */
export class DabPath {
  spacing: number;
  private last: { x: number; y: number } | null = null;
  private left = 0;

  constructor(spacing: number) {
    this.spacing = Math.max(0.5, spacing);
  }

  /** The dab points from the last point to this one (the very first call gives the point itself). */
  to(x: number, y: number): Array<{ x: number; y: number }> {
    if (!this.last) {
      this.last = { x, y };
      this.left = 0;
      return [{ x, y }];
    }
    const out: Array<{ x: number; y: number }> = [];
    const a = this.last;
    const len = Math.hypot(x - a.x, y - a.y);
    let at = this.spacing - this.left;
    while (at <= len) {
      out.push({ x: a.x + ((x - a.x) * at) / len, y: a.y + ((y - a.y) * at) / len });
      at += this.spacing;
    }
    this.left = len - (at - this.spacing);
    this.last = { x, y };
    return out;
  }
}
