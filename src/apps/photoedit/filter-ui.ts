// Photo Editor's filter windows: Gaussian blur, unsharp mask, high pass, motion blur, noise reduction, add noise,
// pixelate, emboss, find edges and vignette (the sums are in filters.ts). Each one shows its change on the picture
// while the window is open (inside the selection, on the active layer) and becomes one undo step when applied.
// A filter that reads its neighbours (a blur) reads the pixels just outside the selection too, so its edge matches.
import { h } from '../../core/dom.ts';
import type { Shell } from '../../shell/types.ts';
import type { Doc } from './doc.ts';
import { clipRect, type Rect } from './history.ts';
import type { Pixels } from './pixels.ts';
import { maskMix } from './selection.ts';
import {
  addNoise, blurReach, emboss, findEdges, gaussianBlur, highPass, median, motionBlur, motionReach, NEXT_REACH, pixelate, unsharpMask, vignette,
} from './filters.ts';

export type FilterKind = 'gaussian' | 'unsharp' | 'highpass' | 'motion' | 'median' | 'noise' | 'pixelate' | 'emboss' | 'edges' | 'vignette';

export const FILTER_TITLES: Record<FilterKind, string> = {
  gaussian: 'Gaussian blur', unsharp: 'Sharpen (unsharp mask)', highpass: 'High pass', motion: 'Motion blur', median: 'Reduce noise',
  noise: 'Add noise', pixelate: 'Pixelate', emboss: 'Emboss', edges: 'Find edges', vignette: 'Vignette',
};

/** Above this many pixels the preview waits until a slider is let go (each run then takes a moment). */
export const LIVE_PIXELS = 3_000_000;

type Control =
  | { kind: 'slider'; id: string; label: string; min: number; max: number; value: number; step?: number; unit?: string }
  | { kind: 'check'; id: string; label: string; value: boolean };
type Values = Record<string, number>;

interface FilterDef {
  controls: Control[];
  hint?: string;
  /** How far past the part changed the filter reads, for these settings. */
  reach: (v: Values) => number;
  run: (p: Pixels, v: Values) => void;
}

const slider = (id: string, label: string, min: number, max: number, value: number, step = 1, unit = ''): Control => ({ kind: 'slider', id, label, min, max, value, step, unit });
const check = (id: string, label: string, value = false): Control => ({ kind: 'check', id, label, value });

/** The settings of each filter. A fresh one per window (Add noise keeps its own pattern while the window is open). */
function defOf(kind: FilterKind): FilterDef {
  switch (kind) {
    case 'gaussian':
      return { controls: [slider('radius', 'Radius', 0.5, 100, 3, 0.5, ' px')], reach: v => blurReach(v.radius), run: (p, v) => gaussianBlur(p, v.radius) };
    case 'unsharp':
      return {
        controls: [slider('amount', 'Amount', 1, 500, 100, 1, '%'), slider('radius', 'Radius', 0.5, 50, 2, 0.5, ' px'), slider('threshold', 'Threshold', 0, 255, 0)],
        hint: 'Threshold above 0 leaves smooth parts (skin, sky) alone.',
        reach: v => blurReach(v.radius),
        run: (p, v) => unsharpMask(p, v.radius, v.amount / 100, v.threshold),
      };
    case 'highpass':
      return {
        controls: [slider('radius', 'Radius', 0.5, 100, 4, 0.5, ' px')],
        hint: 'Keeps only the fine detail, on grey. On a copy of a layer set to Overlay, it sharpens the layer below.',
        reach: v => blurReach(v.radius),
        run: (p, v) => highPass(p, v.radius),
      };
    case 'motion':
      return {
        controls: [slider('length', 'Length', 2, 200, 20, 1, ' px'), slider('angle', 'Angle', -180, 180, 0, 1, '°')],
        reach: v => motionReach(v.length),
        run: (p, v) => motionBlur(p, v.length, v.angle),
      };
    case 'median':
      return {
        controls: [slider('radius', 'Radius', 1, 5, 1, 1, ' px')],
        hint: 'Each pixel takes the middle value of those round it: specks and grain go, edges stay sharp.',
        reach: v => v.radius,
        run: (p, v) => median(p, v.radius),
      };
    case 'noise': {
      const seed = Math.floor(Math.random() * 2 ** 31);
      return { controls: [slider('amount', 'Amount', 1, 100, 15), check('mono', 'Grey grain only (no coloured specks)', true)], reach: () => 0, run: (p, v) => addNoise(p, v.amount, !!v.mono, seed) };
    }
    case 'pixelate':
      return { controls: [slider('size', 'Square size', 2, 200, 10, 1, ' px')], reach: () => 0, run: (p, v) => pixelate(p, v.size) };
    case 'emboss':
      return {
        controls: [slider('angle', 'Light from', -180, 180, 135, 1, '°'), slider('depth', 'Depth', 1, 10, 3), check('colour', 'Keep the colours')],
        reach: () => NEXT_REACH,
        run: (p, v) => emboss(p, v.angle, v.depth, !!v.colour),
      };
    case 'edges':
      return {
        controls: [slider('strength', 'Strength', 1, 10, 2), check('invert', 'Dark lines on white (like a sketch)')],
        reach: () => NEXT_REACH,
        run: (p, v) => findEdges(p, v.strength, !!v.invert),
      };
    case 'vignette':
      return {
        controls: [slider('amount', 'Amount', -100, 100, 50, 1, '%'), slider('size', 'Starts at', 0, 100, 60, 1, '%'), slider('softness', 'Softness', 1, 100, 60, 1, '%')],
        hint: 'Above 0 darkens the corners; below 0 lightens them. Centred on the selection, or the picture.',
        reach: () => 0,
        run: (p, v) => vignette(p, v.amount, v.size, v.softness),
      };
  }
}

/** The settings each control starts at (for the tests, and the first preview). */
export function defaultValues(kind: FilterKind): Values {
  return Object.fromEntries(defOf(kind).controls.map(c => [c.id, c.kind === 'check' ? (c.value ? 1 : 0) : c.value]));
}

/** The part a filter works on: the selection's box (or the picture) with `reach` pixels round it to read. */
export function filterRect(sel: Rect | null, w: number, hgt: number, reach: number): Rect | null {
  const b = sel ?? { x: 0, y: 0, w, h: hgt };
  return clipRect(reach ? { x: b.x - reach, y: b.y - reach, w: b.w + 2 * reach, h: b.h + 2 * reach } : b, w, hgt);
}

/** True when `after` differs from `before` (both the part `r` of a picture `maskWidth` wide) at a selected pixel. */
export function changesInside(before: Uint8ClampedArray, after: Uint8ClampedArray, sel: Uint8Array | null, r: Rect, maskWidth: number): boolean {
  for (let i = 0; i < before.length; i++) {
    if (before[i] === after[i]) continue;
    if (!sel) return true;
    const p = i >> 2;
    if (sel[(r.y + Math.floor(p / r.w)) * maskWidth + r.x + (p % r.w)]) return true;
    // Skip the rest of this pixel.
    i |= 3;
  }
  return false;
}

/** Opens one filter window. Resolves when it closes (true when the filter was applied). `beforeApply` runs just
 *  before the change is made (a text layer becomes pixels only then, not on Cancel). */
export async function runFilterWindow(shell: Shell, doc: Doc, kind: FilterKind, beforeApply: () => void = () => undefined): Promise<boolean> {
  const layer = doc.paint;
  const def = defOf(kind);
  const values: Values = defaultValues(kind);
  // Read once, at the widest reach the sliders allow, so moving a slider never needs pixels it has not got.
  const most: Values = Object.fromEntries(def.controls.map(c => [c.id, c.kind === 'slider' ? c.max : 1]));
  const r = filterRect(doc.selBounds, doc.width, doc.height, def.reach(most));
  if (!r) return false;
  const original = layer.ctx.getImageData(r.x, r.y, r.w, r.h);
  const live = r.w * r.h <= LIVE_PIXELS;
  const working = h('p', { class: 'hint', 'aria-live': 'polite' }, '');

  const rows = def.controls.map(c => {
    if (c.kind === 'check') {
      const input = h('input', { type: 'checkbox', checked: c.value, 'aria-label': c.label });
      input.addEventListener('change', () => {
        values[c.id] = input.checked ? 1 : 0;
        schedule(true);
      });
      return h('label', {}, input, ' ' + c.label);
    }
    const input = h('input', { type: 'range', min: c.min, max: c.max, step: c.step ?? 1, value: c.value, 'aria-label': c.label });
    const out = h('span', { class: 'pe-num' }, `${c.value}${c.unit ?? ''}`);
    input.addEventListener('input', () => {
      values[c.id] = Number(input.value);
      out.textContent = `${input.value}${c.unit ?? ''}`;
      schedule(false);
    });
    input.addEventListener('change', () => schedule(true));
    return h('label', { class: 'pe-slider' }, h('span', {}, c.label), input, out);
  });
  const body = h('div', { class: 'pe-form' }, ...rows, def.hint ? h('p', { class: 'hint' }, def.hint) : null,
    live ? null : h('p', { class: 'hint' }, 'This is a big picture, so the preview shows when you let go of a slider.'), working);

  // ---- Live preview on the layer (put back when the window closes; Apply then makes it one undo step) ----
  const copy = new Uint8ClampedArray(original.data.length);
  const apply = (into: Uint8ClampedArray) => {
    into.set(original.data);
    def.run({ data: into, width: r.w, height: r.h }, values);
    if (doc.selection) maskMix(original.data, into, doc.selection, r, doc.width);
  };
  let timer = 0;
  let closed = false;
  const schedule = (settled: boolean) => {
    if (!live && !settled) return;
    clearTimeout(timer);
    working.textContent = live ? '' : 'Working...';
    // Waits for the slider to rest a moment, and lets "Working..." show before the sums start.
    timer = window.setTimeout(() => {
      if (closed) return;
      apply(copy);
      layer.ctx.putImageData(new ImageData(copy, r.w, r.h), r.x, r.y);
      doc.render(r);
      working.textContent = '';
    }, live ? 60 : 30);
  };
  schedule(true);
  const ok = await shell.dialogs.ask({
    title: FILTER_TITLES[kind],
    body,
    buttons: [{ label: 'Apply', value: true, primary: true }, { label: 'Cancel', value: false }],
    cancel: false,
  });
  closed = true;
  clearTimeout(timer);
  layer.ctx.putImageData(original, r.x, r.y);
  doc.render(r);
  if (!ok) return false;
  // The change itself, not yet kept inside the selection (changePixels does that, once).
  copy.set(original.data);
  def.run({ data: copy, width: r.w, height: r.h }, values);
  // Settings that change no selected pixel here do nothing (and leave a text layer as text).
  if (!changesInside(original.data, copy, doc.selection, r, doc.width)) return false;
  beforeApply();
  return doc.changePixels(FILTER_TITLES[kind], p => p.data.set(copy), r, layer);
}
