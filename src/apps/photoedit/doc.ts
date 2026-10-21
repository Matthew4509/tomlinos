// Photo Editor's picture: a list of layers (each its own canvas, all the size of the picture), the selection, undo,
// and drawing them together into the canvas on screen. The sums are in history.ts, selection.ts and layers.ts.
import { h } from '../../core/dom.ts';
import { clipRect, group, History, PixelPatch, type Rect, type Step, type Surface } from './history.ts';
import { blendInfo, type BlendMode } from './layers.ts';
import { maskBounds, maskEdges, maskMix, type Mask } from './selection.ts';
import type { TextSpec } from './ora.ts';
import type { Pixels } from './pixels.ts';
import { fontOf, layoutText } from './text.ts';

/** Undo keeps steps until they add up to this. */
export const HISTORY_BYTES = 256 * 1024 * 1024;

export interface Layer {
  id: number;
  name: string;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  visible: boolean;
  /** 0 to 1. */
  opacity: number;
  mode: BlendMode;
  locked: boolean;
  /** Set while the layer is an editable text layer. */
  text: TextSpec | null;
  /** A layer mask: a grey picture the size of the layer, white where the layer shows and black where it is hidden
   *  (grey in between). It is a layer of its own kind, so every drawing tool can paint on it. */
  mask: Layer | null;
}

export type LayerMeta = Pick<Layer, 'name' | 'visible' | 'opacity' | 'mode' | 'locked' | 'text'>;

/** A drawing in progress on one layer (a brush stroke, a shape, a gradient), shown on screen but not yet in the layer. */
export interface Pending {
  layer: Layer;
  canvas: HTMLCanvasElement;
  alpha: number;
  op: GlobalCompositeOperation;
  /** What it covers so far. */
  bounds: Rect | null;
}

let nextId = 1;

export function makeCanvas(w: number, hgt: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = h('canvas', { width: w, height: hgt });
  return [c, c.getContext('2d', { willReadFrequently: true })!];
}

export function makeLayer(w: number, hgt: number, name: string, meta: Partial<LayerMeta> = {}): Layer {
  const [canvas, ctx] = makeCanvas(w, hgt);
  return { id: nextId++, name, canvas, ctx, visible: true, opacity: 1, mode: 'normal', locked: false, text: null, mask: null, ...meta };
}

/** A new mask: all white (the whole layer shows), all black (all hidden), or from a selection (shows inside it). */
export function makeMask(w: number, hgt: number, from: 'white' | 'black' | Mask): Layer {
  const mask = makeLayer(w, hgt, 'Mask');
  if (typeof from === 'string') {
    mask.ctx.fillStyle = from === 'white' ? '#ffffff' : '#000000';
    mask.ctx.fillRect(0, 0, w, hgt);
  } else {
    const img = mask.ctx.createImageData(w, hgt);
    for (let i = 0; i < from.length; i++) {
      const o = i * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = from[i];
      img.data[o + 3] = 255;
    }
    mask.ctx.putImageData(img, 0, 0);
  }
  return mask;
}

/** How much a mask's pixels show their layer (0 to 255), written into the alpha of `d` in place: the grey's
 *  brightness, times its own alpha (a part rubbed out of a mask hides the layer, as black does). */
export function maskToAlpha(d: Uint8ClampedArray): void {
  for (let i = 0; i < d.length; i += 4) d[i + 3] = ((d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) * d[i + 3] + 32640) / 65280 | 0;
}

export function surfaceOf(ctx: CanvasRenderingContext2D): Surface {
  return {
    get width() {
      return ctx.canvas.width;
    },
    get height() {
      return ctx.canvas.height;
    },
    read: (x, y, w, hgt) => ctx.getImageData(x, y, w, hgt).data,
    write: (x, y, w, hgt, data) => ctx.putImageData(new ImageData(data as Uint8ClampedArray<ArrayBuffer>, w, hgt), x, y),
  };
}

/** Draws a text layer's words into its canvas (cleared first). */
export function paintText(layer: Layer): void {
  const t = layer.text;
  const c = layer.ctx;
  c.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
  if (!t) return;
  c.save();
  c.font = fontOf(t);
  c.fillStyle = t.colour;
  c.textBaseline = 'top';
  for (const line of layoutText(t, s => c.measureText(s).width).lines) c.fillText(line.text, line.x, line.y);
  c.restore();
}

export function textBounds(layer: Layer): Rect | null {
  const t = layer.text;
  if (!t) return null;
  const c = layer.ctx;
  c.save();
  c.font = fontOf(t);
  const b = layoutText(t, s => c.measureText(s).width).bounds;
  c.restore();
  return b;
}

export class Doc {
  width: number;
  height: number;
  /** Bottom first. */
  layers: Layer[] = [];
  private current!: Layer;
  /** The layer worked on. Choosing another stops painting on a mask. */
  get active(): Layer {
    return this.current;
  }
  set active(layer: Layer) {
    if (layer !== this.current) this.maskEdit = false;
    this.current = layer;
  }
  selection: Mask | null = null;
  readonly history = new History(HISTORY_BYTES);
  readonly display: HTMLCanvasElement;
  private dctx: CanvasRenderingContext2D;
  pending: Pending | null = null;
  /** Called after anything changes: 'pixels' (with the rectangle), 'layers', 'selection', 'size'. */
  onChange: (what: 'pixels' | 'layers' | 'selection' | 'size', rect?: Rect) => void = () => undefined;
  private selCanvas: HTMLCanvasElement | null = null;
  private scratch: [HTMLCanvasElement, CanvasRenderingContext2D] = makeCanvas(1, 1);
  private scratch2: [HTMLCanvasElement, CanvasRenderingContext2D] = makeCanvas(1, 1);
  private scratch3: [HTMLCanvasElement, CanvasRenderingContext2D] = makeCanvas(1, 1);
  private scratch4: [HTMLCanvasElement, CanvasRenderingContext2D] = makeCanvas(1, 1);
  /** True while the tools paint into the active layer's mask instead of its pixels. */
  maskEdit = false;
  /** The selection's outline (for the marching ants) and its box, worked out once per change. */
  edges: number[] = [];
  selBounds: Rect | null = null;

  constructor(display: HTMLCanvasElement, w: number, hgt: number) {
    this.display = display;
    this.dctx = display.getContext('2d')!;
    this.width = w;
    this.height = hgt;
    display.width = w;
    display.height = hgt;
  }

  /** Starts again with these layers (opening a file, a new picture): undo and the selection are cleared. */
  reset(w: number, hgt: number, layers: Layer[]): void {
    this.width = w;
    this.height = hgt;
    this.display.width = w;
    this.display.height = hgt;
    this.layers = layers;
    this.active = layers[layers.length - 1];
    this.maskEdit = false;
    this.pending = null;
    this.setSelectionQuiet(null);
    this.history.clear();
    this.render();
    this.onChange('size');
  }

  get full(): Rect {
    return { x: 0, y: 0, w: this.width, h: this.height };
  }

  indexOf(layer: Layer): number {
    return this.layers.indexOf(layer);
  }

  /** What the drawing tools change: the active layer, or its mask while that is being edited. */
  get paint(): Layer {
    return this.onMask ? this.active.mask! : this.active;
  }

  /** True while the tools really paint on a mask (the active layer has one, and it was chosen). */
  get onMask(): boolean {
    return this.maskEdit && !!this.active.mask;
  }

  /** Every canvas the picture holds: each layer, and after it its mask. */
  withMasks(): Layer[] {
    return this.layers.flatMap(l => (l.mask ? [l, l.mask] : [l]));
  }

  /** A mask's part `r` as a canvas whose alpha is how much the layer shows there (a stroke being drawn on it too). */
  private maskAlpha(mask: Layer, r: Rect, into: [HTMLCanvasElement, CanvasRenderingContext2D]): HTMLCanvasElement {
    let img: ImageData;
    if (this.pending && this.pending.layer === mask && this.pending.bounds) {
      const [, tx] = this.sized(into, r.w, r.h);
      tx.globalCompositeOperation = 'copy';
      tx.drawImage(mask.canvas, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
      tx.globalCompositeOperation = 'source-over';
      this.applyPending(tx, r, 0, 0);
      img = tx.getImageData(0, 0, r.w, r.h);
    } else img = mask.ctx.getImageData(r.x, r.y, r.w, r.h);
    maskToAlpha(img.data);
    const [c, x] = this.sized(into, r.w, r.h);
    x.putImageData(img, 0, 0);
    return c;
  }

  /** A layer's pixels with its mask applied (the layer's own canvas when it has none). */
  maskedCanvas(layer: Layer): HTMLCanvasElement {
    if (!layer.mask) return layer.canvas;
    const [c, x] = makeCanvas(this.width, this.height);
    x.drawImage(layer.canvas, 0, 0);
    const img = layer.mask.ctx.getImageData(0, 0, this.width, this.height);
    maskToAlpha(img.data);
    const [a, ax] = makeCanvas(this.width, this.height);
    ax.putImageData(img, 0, 0);
    x.globalCompositeOperation = 'destination-in';
    x.drawImage(a, 0, 0);
    return c;
  }

  // ---- Showing ----

  /** Draws the layers together into the screen canvas, for one rectangle or the whole picture. */
  render(rect?: Rect | null): void {
    const r = clipRect(rect ?? this.full, this.width, this.height);
    if (!r) return;
    const d = this.dctx;
    d.save();
    d.clearRect(r.x, r.y, r.w, r.h);
    for (const layer of this.layers) {
      if (!layer.visible || layer.opacity <= 0) continue;
      let src: HTMLCanvasElement = layer.canvas;
      let sx = r.x, sy = r.y;
      if (this.pending && this.pending.layer === layer && this.pending.bounds) {
        const [tc, tx] = this.sized(this.scratch, r.w, r.h);
        tx.globalCompositeOperation = 'copy';
        tx.globalAlpha = 1;
        tx.drawImage(layer.canvas, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
        this.applyPending(tx, r, 0, 0);
        src = tc;
        sx = sy = 0;
      }
      if (layer.mask) {
        const alpha = this.maskAlpha(layer.mask, r, this.scratch4);
        const [mc, mx] = this.sized(this.scratch3, r.w, r.h);
        mx.drawImage(src, sx, sy, r.w, r.h, 0, 0, r.w, r.h);
        mx.globalCompositeOperation = 'destination-in';
        mx.drawImage(alpha, 0, 0, r.w, r.h, 0, 0, r.w, r.h);
        src = mc;
        sx = sy = 0;
      }
      d.globalAlpha = layer.opacity;
      d.globalCompositeOperation = blendInfo(layer.mode).canvas;
      d.drawImage(src, sx, sy, r.w, r.h, r.x, r.y, r.w, r.h);
    }
    d.restore();
  }

  private sized(s: [HTMLCanvasElement, CanvasRenderingContext2D], w: number, hgt: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
    if (s[0].width < w || s[0].height < hgt) {
      s[0].width = Math.max(s[0].width, w);
      s[0].height = Math.max(s[0].height, hgt);
    }
    s[1].setTransform(1, 0, 0, 1, 0, 0);
    s[1].globalAlpha = 1;
    s[1].globalCompositeOperation = 'source-over';
    s[1].clearRect(0, 0, w, hgt);
    return s;
  }

  /** Draws the pending drawing's part `r` into `ctx` at (dx, dy), kept inside the selection. */
  private applyPending(ctx: CanvasRenderingContext2D, r: Rect, dx: number, dy: number): void {
    const p = this.pending!;
    let src: HTMLCanvasElement = p.canvas;
    let sx = r.x, sy = r.y;
    const sel = this.selectionCanvas();
    if (sel) {
      const [mc, mx] = this.sized(this.scratch2, r.w, r.h);
      mx.drawImage(p.canvas, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
      mx.globalCompositeOperation = 'destination-in';
      mx.drawImage(sel, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
      src = mc;
      sx = sy = 0;
    }
    ctx.save();
    ctx.globalAlpha = p.alpha;
    ctx.globalCompositeOperation = p.op;
    ctx.drawImage(src, sx, sy, r.w, r.h, dx, dy, r.w, r.h);
    ctx.restore();
  }

  /** The selection as a canvas whose see-through amount is the mask (for drawing through it). */
  selectionCanvas(): HTMLCanvasElement | null {
    if (!this.selection) return null;
    if (!this.selCanvas) {
      const [c, x] = makeCanvas(this.width, this.height);
      const img = x.createImageData(this.width, this.height);
      const m = this.selection;
      for (let i = 0; i < m.length; i++) img.data[i * 4 + 3] = m[i];
      x.putImageData(img, 0, 0);
      this.selCanvas = c;
    }
    return this.selCanvas;
  }

  // ---- Pending drawings (strokes) ----

  /** Starts a drawing on the active layer; `canvas` is a picture-sized canvas the tool draws into. */
  beginPending(canvas: HTMLCanvasElement, alpha: number, op: GlobalCompositeOperation): Pending {
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    this.pending = { layer: this.paint, canvas, alpha, op, bounds: null };
    return this.pending;
  }

  /** Puts the pending drawing into its layer as one undo step. `tiles` are the rectangles it touched (so undo keeps
   *  only those, not the whole box around a long stroke). */
  commitPending(label: string, touched: Rect[]): boolean {
    const p = this.pending;
    if (!p || !p.bounds) {
      this.pending = null;
      return false;
    }
    const r = clipRect(p.bounds, this.width, this.height);
    if (!r) {
      this.pending = null;
      return false;
    }
    const patch = new PixelPatch(surfaceOf(p.layer.ctx));
    for (const t of touched) patch.touch(t);
    this.applyPending(p.layer.ctx, r, r.x, r.y);
    this.pending = null;
    this.pushPixels(label, p.layer, patch);
    this.render(r);
    return true;
  }

  cancelPending(): void {
    const r = this.pending?.bounds;
    this.pending = null;
    if (r) this.render(r);
  }

  // ---- Undo steps ----

  pushPixels(label: string, layer: Layer, patch: PixelPatch): void {
    if (!patch.tiles.size) return;
    this.push(this.pixelStep(label, layer, patch));
    this.onChange('pixels', patch.bounds() ?? undefined);
  }

  /** The undo step for a patch, not yet pushed (for steps grouped with others). */
  pixelStep(label: string, layer: Layer, patch: PixelPatch): Step {
    return { label, bytes: patch.bytes, undo: () => this.swapPatch(layer, patch), redo: () => this.swapPatch(layer, patch) };
  }

  private swapPatch(layer: Layer, patch: PixelPatch): void {
    patch.surface = surfaceOf(layer.ctx);
    patch.swap();
    const b = patch.bounds();
    this.render(b);
    this.onChange('pixels', b ?? undefined);
  }

  /** Called after every new undo step (the picture now differs from the saved file). */
  onStep: () => void = () => undefined;

  push(step: Step): void {
    this.history.push(step);
    this.onStep();
  }

  /**
   * Changes the active layer's pixels inside `rect` (default: the selection's box, or the whole layer) with a plain
   * function, kept inside the selection, as one undo step. False when nothing changed.
   */
  changePixels(label: string, fn: (p: Pixels) => void, rect?: Rect | null, layer = this.paint): boolean {
    const r = clipRect(rect ?? this.selBounds ?? this.full, this.width, this.height);
    if (!r) return false;
    const before = layer.ctx.getImageData(r.x, r.y, r.w, r.h);
    const after = new Uint8ClampedArray(before.data);
    fn({ data: after, width: r.w, height: r.h });
    if (this.selection) maskMix(before.data, after, this.selection, r, this.width);
    const changed = diffBounds(before.data, after, r);
    if (!changed) return false;
    const patch = new PixelPatch(surfaceOf(layer.ctx));
    patch.touch(changed);
    layer.ctx.putImageData(new ImageData(after as Uint8ClampedArray<ArrayBuffer>, r.w, r.h), r.x, r.y, changed.x - r.x, changed.y - r.y, changed.w, changed.h);
    this.pushPixels(label, layer, patch);
    this.render(changed);
    return true;
  }

  /** A change to one layer's settings (name, visible, opacity, mode, lock, text) as an undo step. */
  setMeta(label: string, layer: Layer, change: Partial<LayerMeta>): void {
    const before: Partial<LayerMeta> = {};
    for (const k of Object.keys(change) as Array<keyof LayerMeta>) (before as Record<string, unknown>)[k] = layer[k];
    const apply = (m: Partial<LayerMeta>) => {
      const textChanged = 'text' in m && JSON.stringify(m.text) !== JSON.stringify(layer.text);
      Object.assign(layer, m);
      // Turning a text layer into pixels keeps its pixels; changing its words draws them again.
      if (textChanged && layer.text) paintText(layer);
      this.render();
      this.onChange('layers');
    };
    apply(change);
    this.push({ label, bytes: 64 + JSON.stringify(change).length * 2, undo: () => apply(before), redo: () => apply(change) });
  }

  /** A layer's mask added, changed for another, or taken away (null), as an undo step (with `extra` steps done first,
   *  undone after). With no mask, the tools paint on the layer again. */
  setMask(label: string, layer: Layer, mask: Layer | null, extra: Step[] = []): void {
    const before = layer.mask;
    const apply = (m: Layer | null) => {
      layer.mask = m;
      if (!m && this.active === layer) this.maskEdit = false;
      this.render();
      this.onChange('layers');
    };
    apply(mask);
    const step: Step = { label, bytes: ((before ? 1 : 0) + (mask ? 1 : 0)) * this.width * this.height * 4 + 64, undo: () => apply(before), redo: () => apply(mask) };
    this.push(extra.length ? group(label, [...extra, step]) : step);
  }

  /** A new order or set of layers (add, delete, move, merge) as an undo step. Removed layers stay in memory with the
   *  step, so undo brings them back as they were. */
  setLayers(label: string, layers: Layer[], active: Layer, extra: Step[] = []): void {
    const before = { layers: this.layers, active: this.active };
    const after = { layers, active };
    const apply = (s: { layers: Layer[]; active: Layer }) => {
      this.layers = s.layers;
      this.active = s.active;
      this.render();
      this.onChange('layers');
    };
    apply(after);
    const kept = new Set(before.layers);
    const added = layers.filter(l => !kept.has(l));
    const removed = before.layers.filter(l => !layers.includes(l));
    // A masked layer holds two canvases.
    const bytes = [...added, ...removed].reduce((n, l) => n + (l.mask ? 2 : 1), 0) * this.width * this.height * 4 + 64;
    const step: Step = { label, bytes, undo: () => apply(before), redo: () => apply(after) };
    this.push(extra.length ? group(label, [...extra, step]) : step);
  }

  /** Every layer gets a new canvas (resize, rotate, crop, canvas size): the old canvases are kept for undo. */
  replaceCanvases(label: string, w: number, hgt: number, canvases: Map<Layer, HTMLCanvasElement>, selection: Mask | null, texts?: Map<Layer, TextSpec | null>): void {
    // Masks are in `canvases` too (whole-picture changes change them the same way as their layers).
    const before = { w: this.width, h: this.height, sel: this.selection, canvases: new Map(this.withMasks().map(l => [l, l.canvas])), texts: new Map(this.layers.map(l => [l, l.text])) };
    const after = { w, h: hgt, sel: selection, canvases, texts: texts ?? new Map(this.layers.map(l => [l, l.text])) };
    const apply = (s: typeof after) => {
      this.width = s.w;
      this.height = s.h;
      this.display.width = s.w;
      this.display.height = s.h;
      for (const [layer, canvas] of s.canvases) {
        layer.canvas = canvas;
        layer.ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      }
      for (const [layer, text] of s.texts) layer.text = text;
      this.setSelectionQuiet(s.sel);
      this.render();
      this.onChange('size');
    };
    apply(after);
    this.push({ label, bytes: before.w * before.h * 4 * before.canvases.size + w * hgt * 4 * canvases.size, undo: () => apply(before), redo: () => apply(after) });
  }

  // ---- The selection ----

  private setSelectionQuiet(m: Mask | null): void {
    this.selection = m;
    this.selCanvas = null;
    this.selBounds = m ? maskBounds(m, this.width, this.height) : null;
    if (!this.selBounds) this.selection = null;
    this.edges = this.selection ? maskEdges(this.selection, this.width, this.height) : [];
  }

  /** A new selection (null = none) as an undo step. */
  setSelection(label: string, m: Mask | null, record = true): void {
    const before = this.selection;
    if (!before && !m) return;
    const apply = (s: Mask | null) => {
      this.setSelectionQuiet(s);
      this.onChange('selection');
    };
    apply(m);
    if (record) this.push({ label, bytes: (before?.length ?? 0) + (m?.length ?? 0) + 64, undo: () => apply(before), redo: () => apply(m) });
  }

  /** The step that puts the selection back to what it is now (for groups that also change it). */
  selectionStep(after: Mask | null): Step {
    const before = this.selection;
    const apply = (s: Mask | null) => {
      this.setSelectionQuiet(s);
      this.onChange('selection');
    };
    return { label: 'Selection', bytes: (before?.length ?? 0) + (after?.length ?? 0), undo: () => apply(before), redo: () => apply(after) };
  }

  /** The picture as one flat canvas (what saving to PNG or JPEG writes). */
  flatten(): HTMLCanvasElement {
    // From the layers, not the screen: the screen can show a drawing that is not in its layer yet.
    const [c, x] = makeCanvas(this.width, this.height);
    for (const layer of this.layers) {
      if (!layer.visible) continue;
      x.globalAlpha = layer.opacity;
      x.globalCompositeOperation = blendInfo(layer.mode).canvas;
      x.drawImage(this.maskedCanvas(layer), 0, 0);
    }
    return c;
  }

  /** A layer's pixels inside the selection (or the whole layer), cut to the selection's box. `asSeen`: with its mask
   *  applied (a copy shows what was seen, not what the mask hides). */
  selectedPixels(layer = this.paint, asSeen = false): { canvas: HTMLCanvasElement; x: number; y: number } | null {
    const r = this.selBounds ?? this.full;
    const [c, x] = makeCanvas(r.w, r.h);
    x.drawImage(asSeen ? this.maskedCanvas(layer) : layer.canvas, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    const sel = this.selectionCanvas();
    if (sel) {
      x.globalCompositeOperation = 'destination-in';
      x.drawImage(sel, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    }
    return { canvas: c, x: r.x, y: r.y };
  }
}

/** The smallest rectangle (in picture pixels) where two copies of rectangle `r` differ, or null. */
export function diffBounds(a: Uint8ClampedArray, b: Uint8ClampedArray, r: Rect): Rect | null {
  let x0 = r.w, y0 = r.h, x1 = -1, y1 = -1;
  // Compared four bytes at a time.
  const A = new Uint32Array(a.buffer, a.byteOffset, a.length >> 2);
  const B = new Uint32Array(b.buffer, b.byteOffset, b.length >> 2);
  for (let y = 0; y < r.h; y++) {
    const row = y * r.w;
    let first = -1, last = -1;
    for (let x = 0; x < r.w; x++) if (A[row + x] !== B[row + x]) {
      if (first < 0) first = x;
      last = x;
    }
    if (first < 0) continue;
    if (y < y0) y0 = y;
    y1 = y;
    if (first < x0) x0 = first;
    if (last > x1) x1 = last;
  }
  return x1 < 0 ? null : { x: r.x + x0, y: r.y + y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
