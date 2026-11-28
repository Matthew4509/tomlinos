// Photo Editor's filters with settings: Gaussian blur, unsharp mask, high pass, motion blur, noise reduction (median),
// add noise, pixelate, emboss, find edges and vignette. Plain functions on RGBA arrays (no browser), tested in Node.
// Each changes `data` in place. Pixels past the edge count as the nearest edge pixel. Blurs weight each colour by how
// solid its pixel is, so a see-through neighbour does not count as black (no dark fringe), and blur the see-through
// amount too; the other filters keep each pixel's see-through amount as it was.
// Every pass reads memory in order, row by row (a 12-megapixel photo is 48 MB; jumping about in it is what makes a
// filter slow), and keeps only a few rows aside, not a second copy of the picture.
import type { Pixels } from './pixels.ts';
import { boxWidths } from './selection.ts';

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

// ---- Blurs, on the colours times their solidness, held as whole numbers 256 times the 0-255 value ----

/** The taps of a blur along one direction: `boxes` (radii of box blurs run one after another) or `kernel` (weights
 *  from -R to R adding up to 1). */
type Blur1D = { boxes: number[] } | { kernel: Float64Array };

function blurPlan(sigma: number): Blur1D {
  if (sigma < 2) {
    // Boxes are too coarse for a small blur: a true gaussian.
    const R = Math.max(1, Math.ceil(sigma * 3));
    const k = new Float64Array(2 * R + 1);
    let total = 0;
    for (let i = 0; i <= 2 * R; i++) total += k[i] = Math.exp(-((i - R) ** 2) / (2 * sigma * sigma));
    for (let i = 0; i <= 2 * R; i++) k[i] /= total;
    return { kernel: k };
  }
  // Three box blurs in a row look like a gaussian, and take as long whatever the size.
  return { boxes: boxWidths(sigma).map(wd => (wd - 1) / 2).filter(r => r > 0) };
}

/** One box blur of radius `r` along a line of `len` four-value pixels, from `src` into `dst`. */
function boxLine(src: Float64Array, dst: Float64Array, len: number, r: number): void {
  const span = 2 * r + 1;
  let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
  for (let i = -r; i <= r; i++) {
    const k = (i < 0 ? 0 : i >= len ? len - 1 : i) * 4;
    s0 += src[k];
    s1 += src[k + 1];
    s2 += src[k + 2];
    s3 += src[k + 3];
  }
  for (let x = 0; x < len; x++) {
    const t = x * 4;
    dst[t] = s0 / span;
    dst[t + 1] = s1 / span;
    dst[t + 2] = s2 / span;
    dst[t + 3] = s3 / span;
    const a = (x + r + 1 >= len ? len - 1 : x + r + 1) * 4, b = (x - r < 0 ? 0 : x - r) * 4;
    s0 += src[a] - src[b];
    s1 += src[a + 1] - src[b + 1];
    s2 += src[a + 2] - src[b + 2];
    s3 += src[a + 3] - src[b + 3];
  }
}

/** Runs every box blur in `radii` along each row of `work`, in place (a row is read and written once). */
function boxRows(work: Uint16Array, w: number, h: number, radii: number[]): void {
  let a = new Float64Array(w * 4), b = new Float64Array(w * 4);
  for (let y = 0; y < h; y++) {
    const o = y * w * 4;
    for (let i = 0; i < w * 4; i++) a[i] = work[o + i];
    for (const r of radii) {
      boxLine(a, b, w, r);
      [a, b] = [b, a];
    }
    // Storing cuts off the fraction, so a half is added to round.
    for (let i = 0; i < w * 4; i++) work[o + i] = a[i] + 0.5;
  }
}

/** Blurs each row of `work` with a small kernel, in place. */
function kernelRows(work: Uint16Array, w: number, h: number, k: Float64Array): void {
  const R = (k.length - 1) / 2;
  const row = new Float64Array(w * 4);
  for (let y = 0; y < h; y++) {
    const o = y * w * 4;
    for (let i = 0; i < w * 4; i++) row[i] = work[o + i];
    for (let x = 0; x < w; x++) {
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
      for (let j = -R; j <= R; j++) {
        const q = (x + j < 0 ? 0 : x + j >= w ? w - 1 : x + j) * 4, wt = k[j + R];
        s0 += row[q] * wt;
        s1 += row[q + 1] * wt;
        s2 += row[q + 2] * wt;
        s3 += row[q + 3] * wt;
      }
      const t = o + x * 4;
      work[t] = s0 + 0.5;
      work[t + 1] = s1 + 0.5;
      work[t + 2] = s2 + 0.5;
      work[t + 3] = s3 + 0.5;
    }
  }
}

/**
 * Runs `fn(y, orig)` down the rows, where orig(k) gives row k as it was before this pass (clamped to the picture),
 * for k from y - keep to the bottom. Rows already written are read back from a ring of the last `keep` + 1 rows.
 */
function downRows(work: Uint16Array, w: number, h: number, keep: number, fn: (y: number, orig: (k: number) => { buf: Uint16Array; at: number }) => void): void {
  const len = w * 4;
  const ring = new Uint16Array((keep + 1) * len);
  let y = 0;
  const orig = (k: number) => {
    const c = k < 0 ? 0 : k >= h ? h - 1 : k;
    // Rows up to y are in the ring (row y is copied in before it is written).
    return c <= y ? { buf: ring, at: (c % (keep + 1)) * len } : { buf: work, at: c * len };
  };
  for (; y < h; y++) {
    ring.set(work.subarray(y * len, (y + 1) * len), (y % (keep + 1)) * len);
    fn(y, orig);
  }
}

/** Box blurs each column of `work` in place: one running sum per column, carried down the rows. */
function boxColumns(work: Uint16Array, w: number, h: number, r: number): void {
  const len = w * 4, span = 2 * r + 1;
  const sum = new Float64Array(len);
  for (let i = -r; i <= r; i++) {
    const o = (i < 0 ? 0 : i >= h ? h - 1 : i) * len;
    for (let q = 0; q < len; q++) sum[q] += work[o + q];
  }
  downRows(work, w, h, r, (y, orig) => {
    const o = y * len;
    for (let q = 0; q < len; q++) work[o + q] = sum[q] / span + 0.5;
    const add = orig(y + r + 1), sub = orig(y - r);
    for (let q = 0; q < len; q++) sum[q] += add.buf[add.at + q] - sub.buf[sub.at + q];
  });
}

/** Blurs each column of `work` with a small kernel, in place. */
function kernelColumns(work: Uint16Array, w: number, h: number, k: Float64Array): void {
  const R = (k.length - 1) / 2, len = w * 4;
  const acc = new Float64Array(len);
  downRows(work, w, h, R, (y, orig) => {
    acc.fill(0);
    for (let j = -R; j <= R; j++) {
      const s = orig(y + j), wt = k[j + R];
      for (let q = 0; q < len; q++) acc[q] += s.buf[s.at + q] * wt;
    }
    const o = y * len;
    for (let q = 0; q < len; q++) work[o + q] = acc[q] + 0.5;
  });
}

/** Blurs `p` by a gaussian of spread `sigma`, colours weighted by how solid they are. */
function blurPixels(p: Pixels, sigma: number): void {
  const { data: d, width: w, height: h } = p;
  if (!w || !h) return;
  const work = new Uint16Array(d.length);
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3], f = (a * 256) / 255;
    work[i] = d[i] * f + 0.5;
    work[i + 1] = d[i + 1] * f + 0.5;
    work[i + 2] = d[i + 2] * f + 0.5;
    work[i + 3] = a * 256;
  }
  const plan = blurPlan(sigma);
  if ('kernel' in plan) {
    kernelRows(work, w, h, plan.kernel);
    kernelColumns(work, w, h, plan.kernel);
  } else {
    boxRows(work, w, h, plan.boxes);
    for (const r of plan.boxes) boxColumns(work, w, h, r);
  }
  for (let i = 0; i < d.length; i += 4) {
    const A = work[i + 3];
    if (A < 128) {
      d[i + 3] = 0;
      continue;
    }
    const f = 255 / A;
    d[i] = work[i] * f;
    d[i + 1] = work[i + 1] * f;
    d[i + 2] = work[i + 2] * f;
    d[i + 3] = A / 256;
  }
}

/** Gaussian blur; `radius` (0.1 to 250 pixels) is the spread, as Photoshop's. */
export function gaussianBlur(p: Pixels, radius: number): void {
  if (!(radius > 0)) return;
  blurPixels(p, Math.min(250, radius));
}

/** How far a Gaussian blur of `radius` reads past the part it changes. */
export const blurReach = (radius: number) => Math.ceil(Math.max(0, radius) * 3) + 1;

/**
 * Unsharp mask, the usual sharpen: each colour is pushed away from its blurred self by `amount` (1 = 100%), where
 * it differs from it by at least `threshold` (0 to 255; above 0 leaves smooth skin and sky alone).
 */
export function unsharpMask(p: Pixels, radius: number, amount: number, threshold = 0): void {
  if (!(radius > 0) || !(amount > 0)) return;
  const blurred = new Uint8ClampedArray(p.data);
  gaussianBlur({ data: blurred, width: p.width, height: p.height }, radius);
  const d = p.data;
  for (let i = 0; i < d.length; i += 4) {
    for (let c = i; c < i + 3; c++) {
      const diff = d[c] - blurred[c];
      if (diff && (diff >= threshold || -diff >= threshold)) d[c] = d[c] + diff * amount;
    }
  }
}

/** High pass: only the fine detail is kept, on middle grey (lay it over the photo with Overlay to sharpen). */
export function highPass(p: Pixels, radius: number): void {
  const blurred = new Uint8ClampedArray(p.data);
  gaussianBlur({ data: blurred, width: p.width, height: p.height }, Math.max(0.1, radius));
  const d = p.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = d[i] - blurred[i] + 128;
    d[i + 1] = d[i + 1] - blurred[i + 1] + 128;
    d[i + 2] = d[i + 2] - blurred[i + 2] + 128;
  }
}

// ---- Motion blur ----

/** The most samples a motion blur takes along its line (more would be slow on a big photo and look the same). */
export const MOTION_SAMPLES = 25;
/** Rows worked on together by the motion blur (their sums are kept while each sample adds its shifted rows). */
const BAND = 32;

/** Motion blur: each pixel becomes the average along a line `length` pixels long through it, at `angle` degrees
 *  (0 = left to right, 90 = up and down). */
export function motionBlur(p: Pixels, length: number, angle: number): void {
  const { data: d, width: w, height: h } = p;
  if (length < 2 || !w || !h) return;
  const n = Math.min(MOTION_SAMPLES, Math.max(2, Math.round(length)));
  const rad = (angle * Math.PI) / 180;
  const ux = Math.cos(rad), uy = -Math.sin(rad);
  // The offsets of the samples, from one end of the line to the other.
  const ox: number[] = [], oy: number[] = [];
  for (let k = 0; k < n; k++) {
    const t = (k / (n - 1) - 0.5) * (length - 1);
    ox.push(Math.round(t * ux));
    oy.push(Math.round(t * uy));
  }
  const reach = Math.max(...oy.map(Math.abs));
  // The source rows a band can read are kept aside before the band is written (rows above it are already changed).
  const len = w * 4;
  const keep = new Uint8ClampedArray(Math.min(h, BAND + 2 * reach) * len);
  const acc = new Uint32Array(BAND * len);
  for (let y0 = 0; y0 < h; y0 += BAND) {
    const y1 = Math.min(h, y0 + BAND), from = Math.max(0, y0 - reach), to = Math.min(h, y1 + reach);
    keep.set(d.subarray(from * len, to * len));
    acc.fill(0);
    for (let k = 0; k < n; k++) {
      const dx = ox[k], dy = oy[k];
      for (let y = y0; y < y1; y++) {
        const sy = y + dy < 0 ? 0 : y + dy >= h ? h - 1 : y + dy;
        const so = (sy - from) * len, ao = (y - y0) * len;
        for (let x = 0; x < w; x++) {
          const sx = x + dx < 0 ? 0 : x + dx >= w ? w - 1 : x + dx;
          const s = so + sx * 4, a = ao + x * 4, sa = keep[s + 3];
          acc[a] += keep[s] * sa;
          acc[a + 1] += keep[s + 1] * sa;
          acc[a + 2] += keep[s + 2] * sa;
          acc[a + 3] += sa;
        }
      }
    }
    for (let y = y0; y < y1; y++) {
      const ao = (y - y0) * len, o = y * len;
      for (let x = 0; x < len; x += 4) {
        const A = acc[ao + x + 3];
        if (A) {
          d[o + x] = acc[ao + x] / A;
          d[o + x + 1] = acc[ao + x + 1] / A;
          d[o + x + 2] = acc[ao + x + 2] / A;
        }
        d[o + x + 3] = A / n;
      }
    }
  }
}

/** How far a motion blur reads past the part it changes. */
export const motionReach = (length: number) => Math.ceil(length / 2) + 1;

// ---- Noise ----

/** Noise reduction: each channel becomes the middle value (median) of the square `radius` pixels round it, which
 *  takes out specks and grain but keeps edges sharp. Radius 1 to 10. */
export function median(p: Pixels, radius: number): void {
  const { data: d, width: w, height: h } = p;
  const r = Math.max(1, Math.min(10, Math.round(radius)));
  if (!w || !h) return;
  const src = new Uint8ClampedArray(d);
  // The see-through amount is worked on only when it varies (a photo is solid all over).
  let solid = true;
  for (let i = 3; i < src.length; i += 4) if (src[i] !== src[3]) {
    solid = false;
    break;
  }
  const half = Math.floor(((2 * r + 1) * (2 * r + 1)) / 2);
  const hist = new Int32Array(256);
  const rows = new Int32Array(2 * r + 1);
  const colAt = new Int32Array(w + 2 * r + 2);
  for (let i = 0; i < colAt.length; i++) {
    const x = i - r - 1;
    colAt[i] = (x < 0 ? 0 : x >= w ? w - 1 : x) * 4;
  }
  for (let y = 0; y < h; y++) {
    for (let j = -r; j <= r; j++) rows[j + r] = (y + j < 0 ? 0 : y + j >= h ? h - 1 : y + j) * w * 4;
    for (let c = 0; c < (solid ? 3 : 4); c++) {
      hist.fill(0);
      for (let j = 0; j <= 2 * r; j++) for (let i = -r; i <= r; i++) hist[src[rows[j] + colAt[i + r + 1] + c]]++;
      // The median and how many values lie below it, kept as the window slides along the row (Huang's way).
      let med = 0, below = 0;
      while (below + hist[med] <= half) below += hist[med++];
      const o = y * w * 4 + c;
      d[o] = med;
      for (let x = 1; x < w; x++) {
        // Column x - r - 1 leaves the window and column x + r comes in.
        const out = colAt[x] + c, into = colAt[x + 2 * r + 1] + c;
        if (out !== into) {
          for (let j = 0; j <= 2 * r; j++) {
            const vo = src[rows[j] + out], vi = src[rows[j] + into];
            hist[vo]--;
            hist[vi]++;
            below += (vi < med ? 1 : 0) - (vo < med ? 1 : 0);
          }
          while (below > half) below -= hist[--med];
          while (below + hist[med] <= half) below += hist[med++];
        }
        d[o + x * 4] = med;
      }
    }
  }
}

/** A repeatable run of numbers from 0 to 1 (mulberry32), so the preview and the change applied are the same noise. */
export function randomFrom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Film-like grain: `amount` 0 to 100 (how strong), `mono` = the same for red, green and blue (no coloured specks).
 *  See-through pixels are left alone. */
export function addNoise(p: Pixels, amount: number, mono: boolean, seed = 1): void {
  if (!(amount > 0)) return;
  const d = p.data;
  const rnd = randomFrom(seed);
  // A table of bell-shaped values (three numbers added together), picked from by a fast run of numbers; 100 gives a
  // spread of about 64 levels.
  const table = new Float32Array(4096);
  for (let i = 0; i < table.length; i++) table[i] = (rnd() + rnd() + rnd() - 1.5) * 2 * amount * 0.64;
  let s = (Math.floor(rnd() * 4294967296) | 1) >>> 0;
  const next = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return table[(s >>> 20) & 4095];
  };
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    if (mono) {
      const n = next();
      d[i] = d[i] + n;
      d[i + 1] = d[i + 1] + n;
      d[i + 2] = d[i + 2] + n;
    } else {
      d[i] = d[i] + next();
      d[i + 1] = d[i + 1] + next();
      d[i + 2] = d[i + 2] + next();
    }
  }
}

// ---- Others ----

/** Pixelate: squares `size` pixels wide, each the average colour of its part (from the top left of the part). */
export function pixelate(p: Pixels, size: number): void {
  const { data: d, width: w, height: h } = p;
  const s = Math.max(1, Math.round(size));
  if (s < 2) return;
  for (let by = 0; by < h; by += s) {
    for (let bx = 0; bx < w; bx += s) {
      const x1 = Math.min(w, bx + s), y1 = Math.min(h, by + s);
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let y = by; y < y1; y++) for (let x = bx; x < x1; x++) {
        const o = (y * w + x) * 4, pa = d[o + 3];
        r += d[o] * pa;
        g += d[o + 1] * pa;
        b += d[o + 2] * pa;
        a += pa;
        n++;
      }
      const cr = a ? r / a : 0, cg = a ? g / a : 0, cb = a ? b / a : 0, ca = a / n;
      for (let y = by; y < y1; y++) for (let x = bx; x < x1; x++) {
        const o = (y * w + x) * 4;
        d[o] = cr;
        d[o + 1] = cg;
        d[o + 2] = cb;
        d[o + 3] = ca;
      }
    }
  }
}

/**
 * Calls fn(i, gx, gy) for every pixel with how much `v` (one value per pixel) changes across and down there (a Sobel
 * sum), pixels past the edge counting as the nearest one.
 */
function sobel(v: Uint8ClampedArray, w: number, h: number, fn: (i: number, gx: number, gy: number) => void): void {
  for (let y = 0; y < h; y++) {
    const up = (y > 0 ? y - 1 : 0) * w, mid = y * w, dn = (y < h - 1 ? y + 1 : h - 1) * w;
    for (let x = 0; x < w; x++) {
      const l = x > 0 ? x - 1 : 0, r = x < w - 1 ? x + 1 : w - 1;
      const a = v[up + l], b = v[up + x], c = v[up + r];
      const e = v[mid + l], f = v[mid + r];
      const g = v[dn + l], hh = v[dn + x], k = v[dn + r];
      fn(mid + x, c + 2 * f + k - a - 2 * e - g, g + 2 * hh + k - a - 2 * b - c);
    }
  }
}

/** One channel of a picture as its own array (3 = brightness). */
function channel(d: Uint8ClampedArray, n: number, c: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(n);
  if (c === 3) for (let i = 0; i < n; i++) out[i] = (d[i * 4] * 77 + d[i * 4 + 1] * 150 + d[i * 4 + 2] * 29) >> 8;
  else for (let i = 0; i < n; i++) out[i] = d[i * 4 + c];
  return out;
}

/** Emboss: the picture as if pressed into metal, lit from `angle` degrees (0 = from the right, 90 = from above);
 *  `depth` 1 to 10. With `keepColour` the relief is laid over the colours instead of on grey. */
export function emboss(p: Pixels, angle: number, depth: number, keepColour = false): void {
  const { data: d, width: w, height: h } = p;
  if (!w || !h) return;
  const rad = (angle * Math.PI) / 180, k = Math.max(0, depth) / 4;
  const lx = Math.cos(rad) * k, ly = -Math.sin(rad) * k;
  sobel(channel(d, w * h, 3), w, h, (i, gx, gy) => {
    const bump = gx * lx + gy * ly, o = i * 4;
    if (keepColour) {
      d[o] = d[o] + bump;
      d[o + 1] = d[o + 1] + bump;
      d[o + 2] = d[o + 2] + bump;
    } else d[o] = d[o + 1] = d[o + 2] = 128 + bump;
  });
}

/** Find edges: bright lines where the colour changes, black where it is flat (`invert`: dark lines on white, like a
 *  pencil sketch). `strength` 1 to 10. */
export function findEdges(p: Pixels, strength: number, invert = false): void {
  const { data: d, width: w, height: h } = p;
  if (!w || !h) return;
  const k = Math.max(0, strength) / 4;
  for (let c = 0; c < 3; c++) {
    sobel(channel(d, w * h, c), w, h, (i, gx, gy) => {
      const e = clamp255(Math.sqrt(gx * gx + gy * gy) * k);
      d[i * 4 + c] = invert ? 255 - e : e;
    });
  }
}

/** Reach of a filter that reads only the pixels next to each one. */
export const NEXT_REACH = 1;

/**
 * Vignette: the corners darkened (`amount` above 0) or lightened towards white (below 0), -100 to 100. `size` 0 to
 * 100 is how far out from the middle the fade starts (as a share of the way to the edge), and `softness` 1 to 100
 * how long it takes to reach full strength. Centred on the part changed.
 */
export function vignette(p: Pixels, amount: number, size = 60, softness = 60): void {
  const { data: d, width: w, height: h } = p;
  if (!amount || !w || !h) return;
  const start = Math.max(0, size) / 100, span = Math.max(1, softness) / 100;
  const cx = w / 2, cy = h / 2, f = Math.max(-1, Math.min(1, amount / 100));
  for (let y = 0; y < h; y++) {
    const dy = (y + 0.5 - cy) / cy;
    for (let x = 0; x < w; x++) {
      const dx = (x + 0.5 - cx) / cx;
      const t0 = (Math.sqrt(dx * dx + dy * dy) - start) / span;
      if (t0 <= 0) continue;
      const t = t0 >= 1 ? 1 : t0 * t0 * (3 - 2 * t0);
      const i = (y * w + x) * 4;
      for (let c = i; c < i + 3; c++) d[c] = f > 0 ? d[c] * (1 - f * t) : d[c] + (255 - d[c]) * -f * t;
    }
  }
}
