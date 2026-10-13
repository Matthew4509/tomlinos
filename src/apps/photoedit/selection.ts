// Photo Editor's selections, as masks: one byte per pixel of the picture, 0 = not selected, 255 = selected, and the
// values between for soft edges. Plain functions with no browser, so they are tested in Node.
import type { Pixels } from './pixels.ts';
import type { Rect } from './history.ts';

export type Mask = Uint8Array;
export type Combine = 'replace' | 'add' | 'subtract' | 'intersect';

export interface Point {
  x: number;
  y: number;
}

export function rectMask(w: number, h: number, r: Rect): Mask {
  const m = new Uint8Array(w * h);
  const x0 = Math.max(0, Math.round(Math.min(r.x, r.x + r.w)));
  const x1 = Math.min(w, Math.round(Math.max(r.x, r.x + r.w)));
  const y0 = Math.max(0, Math.round(Math.min(r.y, r.y + r.h)));
  const y1 = Math.min(h, Math.round(Math.max(r.y, r.y + r.h)));
  for (let y = y0; y < y1; y++) m.fill(255, y * w + x0, y * w + x1);
  return m;
}

/** The ellipse inside the rectangle, with a one-pixel soft rim so it is not jagged. */
export function ellipseMask(w: number, h: number, r: Rect): Mask {
  const m = new Uint8Array(w * h);
  const left = Math.min(r.x, r.x + r.w), top = Math.min(r.y, r.y + r.h);
  const rx = Math.abs(r.w) / 2, ry = Math.abs(r.h) / 2;
  if (rx < 0.5 || ry < 0.5) return m;
  const cx = left + rx, cy = top + ry;
  const y0 = Math.max(0, Math.floor(top)), y1 = Math.min(h, Math.ceil(top + 2 * ry));
  const x0 = Math.max(0, Math.floor(left)), x1 = Math.min(w, Math.ceil(left + 2 * rx));
  for (let y = y0; y < y1; y++) {
    const dy = (y + 0.5 - cy) / ry;
    for (let x = x0; x < x1; x++) {
      const dx = (x + 0.5 - cx) / rx;
      // Distance outside the edge in pixels, negative inside: how far past 1 the ellipse's sum is, divided by how fast
      // that sum grows here (so a long thin ellipse gets a one-pixel rim at its ends too, not a long fade).
      const f = Math.sqrt(dx * dx + dy * dy);
      const grow = f > 1e-9 ? Math.sqrt((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry)) / f : 1 / Math.min(rx, ry);
      const out = (f - 1) / grow;
      const v = out <= -0.5 ? 255 : out >= 0.5 ? 0 : Math.round((0.5 - out) * 255);
      if (v) m[y * w + x] = v;
    }
  }
  return m;
}

/** Everything inside the closed outline (pixel centres; a shape that crosses itself uses the even-odd rule). */
export function polygonMask(w: number, h: number, pts: Point[]): Mask {
  const m = new Uint8Array(w * h);
  if (pts.length < 3) return m;
  const ys = pts.map(p => p.y);
  const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(h, Math.ceil(Math.max(...ys)));
  const xs: number[] = [];
  for (let y = y0; y < y1; y++) {
    const sy = y + 0.5;
    xs.length = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      if ((a.y <= sy && b.y > sy) || (b.y <= sy && a.y > sy)) xs.push(a.x + ((sy - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const from = Math.max(0, Math.ceil(xs[i] - 0.5)), to = Math.min(w, Math.ceil(xs[i + 1] - 0.5));
      if (to > from) m.fill(255, y * w + from, y * w + to);
    }
  }
  return m;
}

/** Magic wand: pixels whose colour is within `tolerance` (0-255) of the clicked one; `joined` = only those touching it. */
export function wandMask(p: Pixels, x: number, y: number, tolerance: number, joined = true): Mask {
  const { width: w, height: h, data: d } = p;
  const m = new Uint8Array(w * h);
  x = Math.floor(x);
  y = Math.floor(y);
  if (x < 0 || y < 0 || x >= w || y >= h) return m;
  const at = (y * w + x) * 4;
  const t0 = d[at], t1 = d[at + 1], t2 = d[at + 2], t3 = d[at + 3];
  const near = (n: number) => {
    const i = n * 4;
    return Math.abs(d[i] - t0) <= tolerance && Math.abs(d[i + 1] - t1) <= tolerance && Math.abs(d[i + 2] - t2) <= tolerance && Math.abs(d[i + 3] - t3) <= tolerance;
  };
  if (!joined) {
    for (let n = 0; n < w * h; n++) if (near(n)) m[n] = 255;
    return m;
  }
  const stack = [x, y];
  while (stack.length) {
    const py = stack.pop()!;
    let px = stack.pop()!;
    while (px > 0 && !m[py * w + px - 1] && near(py * w + px - 1)) px--;
    let up = false, down = false;
    for (; px < w; px++) {
      const n = py * w + px;
      if (m[n] || !near(n)) break;
      m[n] = 255;
      if (py > 0) {
        const ok = !m[n - w] && near(n - w);
        if (ok && !up) stack.push(px, py - 1);
        up = ok;
      }
      if (py < h - 1) {
        const ok = !m[n + w] && near(n + w);
        if (ok && !down) stack.push(px, py + 1);
        down = ok;
      }
    }
  }
  return m;
}

/** A new shape joined to the selection there already (null = nothing selected). Returns null when nothing is left. */
export function combine(base: Mask | null, shape: Mask, how: Combine): Mask | null {
  let out: Mask;
  if (how === 'replace' || (!base && how !== 'intersect')) out = how === 'subtract' ? new Uint8Array(shape.length) : shape;
  else if (!base) return null;
  else {
    out = new Uint8Array(shape.length);
    for (let i = 0; i < shape.length; i++) {
      const a = base[i], b = shape[i];
      out[i] = how === 'add' ? Math.max(a, b) : how === 'subtract' ? Math.round((a * (255 - b)) / 255) : Math.min(a, b);
    }
  }
  return isEmpty(out) ? null : out;
}

export function isEmpty(m: Mask): boolean {
  for (let i = 0; i < m.length; i++) if (m[i]) return false;
  return true;
}

export function invertMask(m: Mask | null, size: number): Mask | null {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = 255 - (m ? m[i] : 0);
  return isEmpty(out) ? null : out;
}

/** The widths of three box blurs that together look like a gaussian of this spread (odd widths, 1 = no blur). */
export function boxWidths(sigma: number): [number, number, number] {
  const ideal = Math.sqrt((12 * sigma * sigma) / 3 + 1);
  let lo = Math.floor(ideal);
  if (lo % 2 === 0) lo--;
  lo = Math.max(1, lo);
  const m = Math.round((12 * sigma * sigma - 3 * lo * lo - 12 * lo - 9) / (-4 * lo - 4));
  const out = [0, 1, 2].map(i => (i < m ? lo : lo + 2)) as [number, number, number];
  if (out.every(v => v === 1)) out[2] = 3;
  return out;
}

/** Softens the edge over about `radius` pixels (three box blurs in a row look like a gaussian; a small radius uses a
 *  true gaussian, as boxes are too coarse there and sizes 1 to 4 came out the same). */
export function feather(m: Mask, w: number, h: number, radius: number): Mask {
  if (radius < 1) return m;
  const sigma = radius / 2.5;
  const a = Float32Array.from(m);
  const b = new Float32Array(a.length);
  if (sigma < 2) {
    const R = Math.ceil(sigma * 3);
    const k = Array.from({ length: 2 * R + 1 }, (_, i) => Math.exp(-((i - R) ** 2) / (2 * sigma * sigma)));
    const total = k.reduce((s, v) => s + v, 0);
    const blur = (src: Float32Array, dst: Float32Array, horizontal: boolean) => {
      const len = horizontal ? w : h, lines = horizontal ? h : w;
      const step = horizontal ? 1 : w, lineStep = horizontal ? w : 1;
      for (let l = 0; l < lines; l++) {
        const base = l * lineStep;
        for (let i = 0; i < len; i++) {
          let sum = 0;
          for (let j = -R; j <= R; j++) sum += src[base + Math.min(len - 1, Math.max(0, i + j)) * step] * k[j + R];
          dst[base + i * step] = sum / total;
        }
      }
    };
    blur(a, b, true);
    blur(b, a, false);
    const out = new Uint8Array(m.length);
    for (let i = 0; i < out.length; i++) out[i] = Math.round(a[i]);
    return out;
  }
  const widths = boxWidths(sigma);
  let r = 1;
  const pass = (src: Float32Array, dst: Float32Array, horizontal: boolean) => {
    const len = horizontal ? w : h, lines = horizontal ? h : w;
    const step = horizontal ? 1 : w, lineStep = horizontal ? w : 1;
    const span = 2 * r + 1;
    for (let l = 0; l < lines; l++) {
      const base = l * lineStep;
      const at = (i: number) => src[base + Math.min(len - 1, Math.max(0, i)) * step];
      let sum = 0;
      for (let i = -r; i <= r; i++) sum += at(i);
      for (let i = 0; i < len; i++) {
        dst[base + i * step] = sum / span;
        sum += at(i + r + 1) - at(i - r);
      }
    }
  };
  for (let k = 0; k < 3; k++) {
    r = (widths[k] - 1) / 2;
    if (!r) continue;
    pass(a, b, true);
    pass(b, a, false);
  }
  const out = new Uint8Array(m.length);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(a[i]);
  return out;
}

/** The smallest rectangle holding every selected (non-zero) pixel. */
export function maskBounds(m: Mask, w: number, h: number): Rect | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let first = -1, last = -1;
    for (let x = 0; x < w; x++) if (m[row + x]) {
      if (first < 0) first = x;
      last = x;
    }
    if (first < 0) continue;
    if (y < y0) y0 = y;
    y1 = y;
    if (first < x0) x0 = first;
    if (last > x1) x1 = last;
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * The outline of the selection (where it crosses half way), as line segments x0, y0, x1, y1 on pixel edges, with
 * runs along a row or column joined. This is what the "marching ants" draw.
 */
export function maskEdges(m: Mask, w: number, h: number): number[] {
  const out: number[] = [];
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && m[y * w + x] >= 128;
  for (let y = 0; y <= h; y++) {
    let start = -1;
    for (let x = 0; x <= w; x++) {
      const edge = x < w && on(x, y) !== on(x, y - 1);
      if (edge && start < 0) start = x;
      if (!edge && start >= 0) {
        out.push(start, y, x, y);
        start = -1;
      }
    }
  }
  for (let x = 0; x <= w; x++) {
    let start = -1;
    for (let y = 0; y <= h; y++) {
      const edge = y < h && on(x, y) !== on(x - 1, y);
      if (edge && start < 0) start = y;
      if (!edge && start >= 0) {
        out.push(x, start, x, y);
        start = -1;
      }
    }
  }
  return out;
}

/**
 * Keeps a change only inside the selection: `after` (the changed pixels of `rect`) is pulled back towards `before`
 * wherever the mask is below 255. `mask` covers the whole picture, `maskWidth` pixels wide.
 */
export function maskMix(before: Uint8ClampedArray, after: Uint8ClampedArray, mask: Mask, rect: Rect, maskWidth: number): void {
  for (let row = 0; row < rect.h; row++) {
    const mrow = (rect.y + row) * maskWidth + rect.x;
    for (let col = 0; col < rect.w; col++) {
      const k = mask[mrow + col];
      if (k === 255) continue;
      const i = (row * rect.w + col) * 4;
      if (k === 0) {
        after[i] = before[i];
        after[i + 1] = before[i + 1];
        after[i + 2] = before[i + 2];
        after[i + 3] = before[i + 3];
        continue;
      }
      const f = k / 255;
      for (let c = 0; c < 4; c++) after[i + c] = before[i + c] + (after[i + c] - before[i + c]) * f;
    }
  }
}

/** Moves a mask by whole pixels (what falls off the edge is lost). */
export function shiftMask(m: Mask, w: number, h: number, dx: number, dy: number): Mask | null {
  const out = new Uint8Array(m.length);
  dx = Math.round(dx);
  dy = Math.round(dy);
  for (let y = 0; y < h; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= h) continue;
    for (let x = 0; x < w; x++) {
      const sx = x - dx;
      if (sx >= 0 && sx < w) out[y * w + x] = m[sy * w + sx];
    }
  }
  return isEmpty(out) ? null : out;
}

/** The mask with the part inside `r` mirrored within `r` (Layer > Flip with a selection: the selection follows). */
export function flipMaskIn(m: Mask, w: number, r: Rect, horizontal: boolean): Mask {
  const out = m.slice();
  for (let y = 0; y < r.h; y++) {
    for (let x = 0; x < r.w; x++) {
      const sx = horizontal ? r.w - 1 - x : x, sy = horizontal ? y : r.h - 1 - y;
      out[(r.y + y) * w + r.x + x] = m[(r.y + sy) * w + r.x + sx];
    }
  }
  return out;
}

/** Only the selected pixels' colours (a mask 128 or more), as one row: what a histogram of a shaped selection counts. */
export function selectedOnly(p: Pixels, m: Mask, r: Rect, maskWidth: number): Pixels {
  let n = 0;
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) if (m[(r.y + y) * maskWidth + r.x + x] >= 128) n++;
  const out = new Uint8ClampedArray(n * 4);
  let k = 0;
  for (let y = 0; y < r.h; y++) {
    for (let x = 0; x < r.w; x++) {
      if (m[(r.y + y) * maskWidth + r.x + x] < 128) continue;
      const i = (y * r.w + x) * 4;
      out[k++] = p.data[i];
      out[k++] = p.data[i + 1];
      out[k++] = p.data[i + 2];
      out[k++] = p.data[i + 3];
    }
  }
  return { data: out, width: n, height: 1 };
}

/** The part of a mask inside a rectangle, as a new smaller mask (for crop to selection, canvas size). */
export function cropMask(m: Mask, w: number, r: Rect, nw: number, nh: number, ox = 0, oy = 0): Mask | null {
  const out = new Uint8Array(nw * nh);
  for (let y = 0; y < r.h; y++) {
    const ty = y + oy;
    if (ty < 0 || ty >= nh) continue;
    for (let x = 0; x < r.w; x++) {
      const tx = x + ox;
      if (tx >= 0 && tx < nw) out[ty * nw + tx] = m[(r.y + y) * w + r.x + x];
    }
  }
  return isEmpty(out) ? null : out;
}
