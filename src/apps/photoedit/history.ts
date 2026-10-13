// Photo Editor's undo. A step that changes pixels keeps only the 64 × 64 tiles it touched (as they were before), never
// a copy of the whole picture, so fifty brush strokes on a big photo with many layers still fit. Other steps (a layer
// added, moved, renamed, a selection changed) keep a few small values or a reference to a layer's own canvas.
// No browser needed: a surface is anything that can read and write a rectangle of RGBA pixels.

export const TILE = 64;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Surface {
  readonly width: number;
  readonly height: number;
  read(x: number, y: number, w: number, h: number): Uint8ClampedArray;
  write(x: number, y: number, w: number, h: number, data: Uint8ClampedArray): void;
}

export interface Step {
  label: string;
  /** Memory this step holds, counted against the history cap. */
  bytes: number;
  undo(): void;
  redo(): void;
}

/** The part of `r` inside a w × h picture, or null when nothing is left. Whole pixels only. */
export function clipRect(r: Rect, w: number, h: number): Rect | null {
  const x0 = Math.max(0, Math.floor(r.x));
  const y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(w, Math.ceil(r.x + r.w));
  const y1 = Math.min(h, Math.ceil(r.y + r.h));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

export function unionRect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/**
 * The tiles of one surface as they were before a change. Call touch() with every rectangle BEFORE drawing into it;
 * tiles already kept are not read again, so a stroke that crosses itself costs nothing extra.
 */
export class PixelPatch {
  surface: Surface;
  readonly tiles = new Map<number, Uint8ClampedArray>();
  private cols: number;

  constructor(surface: Surface) {
    this.surface = surface;
    this.cols = Math.ceil(surface.width / TILE);
  }

  get bytes(): number {
    let n = 0;
    for (const t of this.tiles.values()) n += t.length;
    return n;
  }

  private tileRect(index: number): Rect {
    const tx = index % this.cols;
    const ty = Math.floor(index / this.cols);
    const x = tx * TILE;
    const y = ty * TILE;
    return { x, y, w: Math.min(TILE, this.surface.width - x), h: Math.min(TILE, this.surface.height - y) };
  }

  touch(r: Rect): void {
    const c = clipRect(r, this.surface.width, this.surface.height);
    if (!c) return;
    const tx0 = Math.floor(c.x / TILE), tx1 = Math.floor((c.x + c.w - 1) / TILE);
    const ty0 = Math.floor(c.y / TILE), ty1 = Math.floor((c.y + c.h - 1) / TILE);
    const missing: number[] = [];
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
      const i = ty * this.cols + tx;
      if (!this.tiles.has(i)) missing.push(i);
    }
    if (!missing.length) return;
    // One read for the whole block (a canvas read is slow to start), then cut into tiles.
    const bx = tx0 * TILE, by = ty0 * TILE;
    const bw = Math.min(this.surface.width, (tx1 + 1) * TILE) - bx;
    const bh = Math.min(this.surface.height, (ty1 + 1) * TILE) - by;
    const block = this.surface.read(bx, by, bw, bh);
    for (const i of missing) {
      const t = this.tileRect(i);
      const out = new Uint8ClampedArray(t.w * t.h * 4);
      for (let row = 0; row < t.h; row++) {
        const from = ((t.y - by + row) * bw + (t.x - bx)) * 4;
        out.set(block.subarray(from, from + t.w * 4), row * t.w * 4);
      }
      this.tiles.set(i, out);
    }
  }

  /** Puts the kept tiles back and keeps what was there instead, so calling it again goes the other way. */
  swap(): void {
    for (const [i, data] of this.tiles) {
      const t = this.tileRect(i);
      const now = this.surface.read(t.x, t.y, t.w, t.h);
      this.surface.write(t.x, t.y, t.w, t.h, data);
      this.tiles.set(i, now);
    }
  }

  /** The rectangle covering every kept tile. */
  bounds(): Rect | null {
    let r: Rect | null = null;
    for (const i of this.tiles.keys()) r = unionRect(r, this.tileRect(i));
    return r;
  }
}

/** A list of steps for undo and redo, trimmed from the oldest end when it holds more than `cap` bytes. */
export class History {
  readonly undoList: Step[] = [];
  readonly redoList: Step[] = [];
  cap: number;

  constructor(cap: number) {
    this.cap = cap;
  }

  get bytes(): number {
    return [...this.undoList, ...this.redoList].reduce((n, s) => n + s.bytes, 0);
  }

  push(step: Step): void {
    this.undoList.push(step);
    this.redoList.length = 0;
    // The newest step is always kept, even alone over the cap: the person just did it.
    while (this.undoList.length > 1 && this.bytes > this.cap) this.undoList.shift();
  }

  undo(): Step | null {
    const s = this.undoList.pop();
    if (!s) return null;
    s.undo();
    this.redoList.push(s);
    return s;
  }

  redo(): Step | null {
    const s = this.redoList.pop();
    if (!s) return null;
    s.redo();
    this.undoList.push(s);
    return s;
  }

  clear(): void {
    this.undoList.length = 0;
    this.redoList.length = 0;
  }
}

/** Steps done together and undone together (newest first). */
export function group(label: string, steps: Step[]): Step {
  return {
    label,
    bytes: steps.reduce((n, s) => n + s.bytes, 0),
    undo: () => {
      for (let i = steps.length - 1; i >= 0; i--) steps[i].undo();
    },
    redo: () => {
      for (const s of steps) s.redo();
    },
  };
}
