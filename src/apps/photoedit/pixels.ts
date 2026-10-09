// Photo Editor's pixel sums, on plain RGBA arrays (the same layout as a canvas ImageData), so they can be tested with
// no browser. Every function changes `data` in place, or returns a new array when the size changes.

export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

/** brightness and contrast from -100 to 100; 0 leaves the picture alone. */
export function brightnessContrast(p: Pixels, brightness: number, contrast: number): void {
  const b = (brightness / 100) * 255;
  const c = Math.max(-99.9, Math.min(100, contrast));
  const f = (259 * (c * 2.55 + 255)) / (255 * (259 - c * 2.55));
  const d = p.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = clamp(f * (d[i] + b - 128) + 128);
    d[i + 1] = clamp(f * (d[i + 1] + b - 128) + 128);
    d[i + 2] = clamp(f * (d[i + 2] + b - 128) + 128);
  }
}

/** amount from -100 (grey) to 100 (twice as colourful). */
export function saturation(p: Pixels, amount: number): void {
  const s = 1 + amount / 100;
  const d = p.data;
  for (let i = 0; i < d.length; i += 4) {
    const grey = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    d[i] = clamp(grey + (d[i] - grey) * s);
    d[i + 1] = clamp(grey + (d[i + 1] - grey) * s);
    d[i + 2] = clamp(grey + (d[i + 2] - grey) * s);
  }
}

export function greyscale(p: Pixels): void {
  saturation(p, -100);
}

export function sepia(p: Pixels): void {
  const d = p.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    d[i] = clamp(0.393 * r + 0.769 * g + 0.189 * b);
    d[i + 1] = clamp(0.349 * r + 0.686 * g + 0.168 * b);
    d[i + 2] = clamp(0.272 * r + 0.534 * g + 0.131 * b);
  }
}

export function invert(p: Pixels): void {
  const d = p.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = 255 - d[i];
    d[i + 1] = 255 - d[i + 1];
    d[i + 2] = 255 - d[i + 2];
  }
}

/** A 3 x 3 filter (blur, sharpen). Edge pixels use their nearest neighbour; transparency is kept. */
export function convolve3(p: Pixels, k: number[]): void {
  const { width: w, height: h } = p;
  const src = p.data.slice();
  const d = p.data;
  const sum = k.reduce((a, b) => a + b, 0) || 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let ky = -1; ky <= 1; ky++) {
        const yy = Math.min(h - 1, Math.max(0, y + ky));
        for (let kx = -1; kx <= 1; kx++) {
          const xx = Math.min(w - 1, Math.max(0, x + kx));
          const wgt = k[(ky + 1) * 3 + kx + 1];
          const j = (yy * w + xx) * 4;
          r += src[j] * wgt;
          g += src[j + 1] * wgt;
          b += src[j + 2] * wgt;
        }
      }
      const i = (y * w + x) * 4;
      d[i] = clamp(r / sum);
      d[i + 1] = clamp(g / sum);
      d[i + 2] = clamp(b / sum);
    }
  }
}

export const BLUR = [1, 2, 1, 2, 4, 2, 1, 2, 1];
export const SHARPEN = [0, -1, 0, -1, 5, -1, 0, -1, 0];

/** Paint-bucket fill: every pixel joined to (x, y) whose colour is within `tolerance` (0-255) becomes `rgba`. */
export function floodFill(p: Pixels, x: number, y: number, rgba: [number, number, number, number], tolerance = 32): number {
  const { width: w, height: h, data: d } = p;
  x = Math.floor(x);
  y = Math.floor(y);
  if (x < 0 || y < 0 || x >= w || y >= h) return 0;
  const at = (y * w + x) * 4;
  const target = [d[at], d[at + 1], d[at + 2], d[at + 3]];
  if (target.every((v, i) => v === rgba[i])) return 0;
  const near = (i: number) => Math.abs(d[i] - target[0]) <= tolerance && Math.abs(d[i + 1] - target[1]) <= tolerance
    && Math.abs(d[i + 2] - target[2]) <= tolerance && Math.abs(d[i + 3] - target[3]) <= tolerance;
  const seen = new Uint8Array(w * h);
  const stack = [x, y];
  let count = 0;
  while (stack.length) {
    const py = stack.pop()!;
    const px0 = stack.pop()!;
    // Walk left to the start of this run, then fill rightwards, queueing the rows above and below.
    let px = px0;
    while (px > 0 && !seen[py * w + px - 1] && near((py * w + px - 1) * 4)) px--;
    let up = false, down = false;
    for (; px < w; px++) {
      const n = py * w + px;
      if (seen[n] || !near(n * 4)) break;
      seen[n] = 1;
      d.set(rgba, n * 4);
      count++;
      if (py > 0) {
        const ok = !seen[n - w] && near((n - w) * 4);
        if (ok && !up) stack.push(px, py - 1);
        up = ok;
      }
      if (py < h - 1) {
        const ok = !seen[n + w] && near((n + w) * 4);
        if (ok && !down) stack.push(px, py + 1);
        down = ok;
      }
    }
  }
  return count;
}

/** Rotates a quarter turn: 1 = clockwise, -1 = anticlockwise. Returns the new pixels. */
export function rotate90(p: Pixels, dir: 1 | -1): Pixels {
  const { width: w, height: h, data: s } = p;
  const out = new Uint8ClampedArray(s.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = dir === 1 ? h - 1 - y : y;
      const ny = dir === 1 ? x : w - 1 - x;
      out.set(s.subarray((y * w + x) * 4, (y * w + x) * 4 + 4), (ny * h + nx) * 4);
    }
  }
  return { data: out, width: h, height: w };
}

export function flip(p: Pixels, horizontal: boolean): void {
  const { width: w, height: h, data: d } = p;
  const px = new Uint8ClampedArray(4);
  if (horizontal) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w >> 1; x++) {
        const a = (y * w + x) * 4, b = (y * w + (w - 1 - x)) * 4;
        px.set(d.subarray(a, a + 4));
        d.copyWithin(a, b, b + 4);
        d.set(px, b);
      }
    }
  } else {
    const row = new Uint8ClampedArray(w * 4);
    for (let y = 0; y < h >> 1; y++) {
      const a = y * w * 4, b = (h - 1 - y) * w * 4;
      row.set(d.subarray(a, a + w * 4));
      d.copyWithin(a, b, b + w * 4);
      d.set(row, b);
    }
  }
}

/** The part inside the rectangle (clipped to the picture). */
export function crop(p: Pixels, x: number, y: number, cw: number, ch: number): Pixels {
  x = Math.max(0, Math.floor(x));
  y = Math.max(0, Math.floor(y));
  cw = Math.max(1, Math.min(p.width - x, Math.floor(cw)));
  ch = Math.max(1, Math.min(p.height - y, Math.floor(ch)));
  const out = new Uint8ClampedArray(cw * ch * 4);
  for (let row = 0; row < ch; row++) out.set(p.data.subarray(((y + row) * p.width + x) * 4, ((y + row) * p.width + x + cw) * 4), row * cw * 4);
  return { data: out, width: cw, height: ch };
}

/** "#rrggbb" -> [r, g, b, 255]. */
export function hexToRgba(hex: string): [number, number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  const n = m ? parseInt(m[1], 16) : 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

/** Width and height that keep the shape when one side is typed. */
export function keepShape(w: number, h: number, newW: number | null, newH: number | null): [number, number] {
  if (newW && !newH) return [newW, Math.max(1, Math.round((h * newW) / w))];
  if (newH && !newW) return [Math.max(1, Math.round((w * newH) / h)), newH];
  return [newW ?? w, newH ?? h];
}
