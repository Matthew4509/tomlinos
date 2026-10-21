// Photo Editor's layers, the parts that need no browser: blend modes (and their names in a canvas and in an
// OpenRaster file), how many layers fit in memory, layer names, and order.

export type BlendMode =
  | 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten' | 'color-dodge' | 'color-burn' | 'hard-light'
  | 'soft-light' | 'difference' | 'exclusion' | 'hue' | 'saturation' | 'color' | 'luminosity';

export interface BlendInfo {
  id: BlendMode;
  label: string;
  /** The canvas's own name for it (globalCompositeOperation). */
  canvas: GlobalCompositeOperation;
  /** OpenRaster's name (composite-op). Exclusion is not in the OpenRaster list; readers that do not know it use Normal. */
  ora: string;
}

export const BLEND_MODES: BlendInfo[] = [
  { id: 'normal', label: 'Normal', canvas: 'source-over', ora: 'svg:src-over' },
  { id: 'multiply', label: 'Multiply', canvas: 'multiply', ora: 'svg:multiply' },
  { id: 'screen', label: 'Screen', canvas: 'screen', ora: 'svg:screen' },
  { id: 'overlay', label: 'Overlay', canvas: 'overlay', ora: 'svg:overlay' },
  { id: 'darken', label: 'Darken only', canvas: 'darken', ora: 'svg:darken' },
  { id: 'lighten', label: 'Lighten only', canvas: 'lighten', ora: 'svg:lighten' },
  { id: 'color-dodge', label: 'Colour dodge', canvas: 'color-dodge', ora: 'svg:color-dodge' },
  { id: 'color-burn', label: 'Colour burn', canvas: 'color-burn', ora: 'svg:color-burn' },
  { id: 'hard-light', label: 'Hard light', canvas: 'hard-light', ora: 'svg:hard-light' },
  { id: 'soft-light', label: 'Soft light', canvas: 'soft-light', ora: 'svg:soft-light' },
  { id: 'difference', label: 'Difference', canvas: 'difference', ora: 'svg:difference' },
  { id: 'exclusion', label: 'Exclusion', canvas: 'exclusion', ora: 'svg:exclusion' },
  { id: 'hue', label: 'Hue', canvas: 'hue', ora: 'svg:hue' },
  { id: 'saturation', label: 'Saturation', canvas: 'saturation', ora: 'svg:saturation' },
  { id: 'color', label: 'Colour', canvas: 'color', ora: 'svg:color' },
  { id: 'luminosity', label: 'Luminosity', canvas: 'luminosity', ora: 'svg:luminosity' },
];

export function blendInfo(id: BlendMode): BlendInfo {
  return BLEND_MODES.find(b => b.id === id) ?? BLEND_MODES[0];
}

/** The mode for an OpenRaster composite-op, or null when this editor does not have it. */
export function blendFromOra(op: string | undefined): BlendMode | null {
  if (!op) return 'normal';
  return BLEND_MODES.find(b => b.ora === op.trim())?.id ?? null;
}

/** All layers together may hold at most this many pixels (4 bytes each: about 600 MB). */
export const LAYER_BUDGET = 150_000_000;
export const MAX_LAYERS = 100;

/** Why one more layer (or mask) of this size cannot be added (null = it can). `count` = layers and masks there now,
 *  `masks` = how many of them are masks (each holds as much as a layer). */
export function noRoomForLayer(w: number, h: number, count: number, masks = 0): string | null {
  const has = `${count - masks} layer${count - masks === 1 ? '' : 's'}${masks ? ` and ${masks} mask${masks === 1 ? '' : 's'}` : ''}`;
  const way = masks ? 'Merge or delete a layer, or apply or delete a mask, to add another.' : 'Merge or delete a layer to add another.';
  if (count >= MAX_LAYERS) return `This picture has ${has}, the most Photo Editor holds. ${way}`;
  if ((count + 1) * w * h > LAYER_BUDGET) {
    return `This picture has ${has} at ${w.toLocaleString()} × ${h.toLocaleString()}, which is as much as this browser can hold safely. ${way}`;
  }
  return null;
}

/** The most layers a picture of this size may have. */
export function layerLimit(w: number, h: number): number {
  return Math.max(1, Math.min(MAX_LAYERS, Math.floor(LAYER_BUDGET / Math.max(1, w * h))));
}

/** "Layer 3": the first number not taken by a name of the form "<base> <n>". */
export function nextName(names: string[], base = 'Layer'): string {
  const taken = new Set(names);
  for (let n = names.length + 1; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
}

/** A copy's name: "Sky copy", then "Sky copy 2"... */
export function copyName(names: string[], name: string): string {
  const taken = new Set(names);
  const base = `${name} copy`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
}

/** The list with one item moved from `from` to `to` (both indexes in the list before the move). */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  const out = list.slice();
  if (from < 0 || from >= out.length) return out;
  const [item] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, item);
  return out;
}
