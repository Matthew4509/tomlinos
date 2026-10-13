// Photo Editor's retouching brushes, one "dab" (a round touch of the brush) at a time: clone, heal, smudge,
// dodge / burn, blur / sharpen. Plain functions on RGBA arrays (no browser), tested in Node. Each one changes the
// pixels under the dab only, weighted by the brush's soft edge, its strength and the selection (when there is one).
import { BLUR, SHARPEN, type Pixels } from './pixels.ts';
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

/** Clone stamp: copies from `source` (the layer as it was when the stroke began) `dx`, `dy` away. */
export function cloneDab(p: Pixels, source: Pixels, dx: number, dy: number, d: Dab, mask: Mask | null): Rect | null {
  const s = source.data, t = p.data;
  return eachPixel(p, d, mask, (i, wgt, x, y) => {
    const sx = Math.floor(x + dx), sy = Math.floor(y + dy);
    if (sx < 0 || sy < 0 || sx >= source.width || sy >= source.height) return;
    const j = (sy * source.width + sx) * 4;
    for (let c = 0; c < 4; c++) t[i + c] = t[i + c] + (s[j + c] - t[i + c]) * wgt;
  });
}

/** Healing: as the clone stamp, but the copied pixels are shifted to the brightness and colour around the dab, so
 *  a patch of skin from the forehead does not show as a lighter blotch on the cheek. */
export function healDab(p: Pixels, source: Pixels, dx: number, dy: number, d: Dab, mask: Mask | null): Rect | null {
  const r = dabRect(d, p.width, p.height);
  if (!r) return null;
  const s = source.data, t = p.data;
  const here = [0, 0, 0], there = [0, 0, 0];
  let n = 0;
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      if (Math.hypot(x + 0.5 - d.x, y + 0.5 - d.y) >= d.radius) continue;
      const sx = Math.floor(x + dx), sy = Math.floor(y + dy);
      if (sx < 0 || sy < 0 || sx >= source.width || sy >= source.height) continue;
      const i = (y * p.width + x) * 4, j = (sy * source.width + sx) * 4;
      for (let c = 0; c < 3; c++) {
        here[c] += t[i + c];
        there[c] += s[j + c];
      }
      n++;
    }
  }
  if (!n) return null;
  const shift = here.map((v, c) => (v - there[c]) / n);
  return eachPixel(p, d, mask, (i, wgt, x, y) => {
    const sx = Math.floor(x + dx), sy = Math.floor(y + dy);
    if (sx < 0 || sy < 0 || sx >= source.width || sy >= source.height) return;
    const j = (sy * source.width + sx) * 4;
    for (let c = 0; c < 3; c++) t[i + c] = t[i + c] + (s[j + c] + shift[c] - t[i + c]) * wgt;
    t[i + 3] = t[i + 3] + (s[j + 3] - t[i + 3]) * wgt;
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
  return eachPixel(p, dab, mask, (i, wgt, x, y) => {
    const ci = x - cx + R, cj = y - cy + R;
    if (ci < 0 || cj < 0 || ci >= carry.size || cj >= carry.size) return;
    const k = (cj * carry.size + ci) * 4;
    for (let c = 0; c < 4; c++) {
      const before = t[i + c];
      t[i + c] = before + (carry.data[k + c] - before) * wgt;
      // The brush picks up a little of what it passes over.
      carry.data[k + c] += (before - carry.data[k + c]) * 0.25;
    }
  });
}

/** Dodge lightens, burn darkens. */
export function dodgeBurnDab(p: Pixels, d: Dab, mode: 'dodge' | 'burn', mask: Mask | null): Rect | null {
  const t = p.data;
  return eachPixel(p, d, mask, (i, wgt) => {
    for (let c = 0; c < 3; c++) {
      const v = t[i + c];
      t[i + c] = mode === 'dodge' ? v + (255 - v) * wgt * 0.5 : v - v * wgt * 0.5;
    }
  });
}

/** Blur or sharpen under the brush. */
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
    for (let c = 0; c < 3; c++) {
      let acc = 0;
      for (let ky = -1; ky <= 1; ky++) {
        const yy = Math.min(y1 - 1, Math.max(y0, y + ky)) - y0;
        for (let kx = -1; kx <= 1; kx++) {
          const xx = Math.min(x1 - 1, Math.max(x0, x + kx)) - x0;
          acc += src[(yy * bw + xx) * 4 + c] * k[(ky + 1) * 3 + kx + 1];
        }
      }
      const v = Math.min(255, Math.max(0, acc / sum));
      t[i + c] = t[i + c] + (v - t[i + c]) * wgt;
    }
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
