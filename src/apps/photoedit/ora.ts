// OpenRaster (.ora): the layered picture file GIMP, Krita and MyPaint open. It is a zip holding "mimetype" first and
// unpacked (the words "image/openraster"), "stack.xml" (the layers, top first), one PNG per layer in data/, the
// whole picture as "mergedimage.png" and a small "Thumbnails/thumbnail.png" (256 pixels at most).
// A file from outside is untrusted: entries, sizes and pixels are capped BEFORE anything is decoded.
import { zipStore } from '../../core/zip.ts';
import { child, escapeXml, parseXml, XmlProblem, type XmlEl } from '../../core/xml.ts';
import { ArchiveError, readZip, type ArchiveEntry } from '../archive/read.ts';
import { imageSize, MAX_PICTURE_PIXELS } from '../../core/imagesize.ts';
import { blendFromOra, blendInfo, LAYER_BUDGET, MAX_LAYERS, type BlendMode } from './layers.ts';

export const ORA_TYPE = 'image/openraster';
/** stack.xml bigger than this is refused (a real one is a few kilobytes). */
const MAX_STACK_XML = 1024 * 1024;
const MAX_ENTRIES = 1000;
/** One packed layer PNG may be at most this big. */
const MAX_LAYER_FILE = 100 * 1024 * 1024;

export class OraProblem extends Error {}

/** Settings an editable text layer keeps (saved inside stack.xml as one attribute this editor reads back). */
export interface TextSpec {
  text: string;
  family: string;
  size: number;
  colour: string;
  bold: boolean;
  italic: boolean;
  align: 'left' | 'center' | 'right';
  x: number;
  y: number;
}

export interface OraLayer {
  name: string;
  /** Path inside the zip, e.g. "data/layer1.png". */
  src: string;
  x: number;
  y: number;
  opacity: number;
  visible: boolean;
  locked: boolean;
  mode: BlendMode;
  text?: TextSpec;
}

export interface OraStack {
  width: number;
  height: number;
  /** Top layer first, as in the file. */
  layers: OraLayer[];
}

const NS = 'urn:tomlinos:openraster:1';

export function writeStack(s: OraStack): string {
  const layers = s.layers.map(l => {
    const attrs: Array<[string, string]> = [
      ['name', l.name], ['src', l.src], ['x', String(Math.round(l.x))], ['y', String(Math.round(l.y))],
      ['opacity', String(Math.round(l.opacity * 1000) / 1000)], ['visibility', l.visible ? 'visible' : 'hidden'],
      ['composite-op', blendInfo(l.mode).ora],
    ];
    if (l.locked) attrs.push(['edit-locked', 'true']);
    if (l.text) attrs.push(['tomlinos:text', JSON.stringify(l.text)]);
    return `  <layer ${attrs.map(([k, v]) => `${k}="${escapeXml(v)}"`).join(' ')}/>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<image version="0.0.5" w="${s.width}" h="${s.height}" xmlns:tomlinos="${NS}">\n <stack>\n${layers.join('\n')}\n </stack>\n</image>\n`;
}

/** What reading a stack turned up that this editor could not keep exactly. */
export interface StackRead {
  stack: OraStack;
  notes: string[];
}

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return v !== undefined && Number.isFinite(n) ? n : fallback;
}

function readText(raw: string | undefined): TextSpec | undefined {
  if (!raw) return undefined;
  try {
    const t = JSON.parse(raw) as Partial<TextSpec>;
    if (typeof t.text !== 'string' || typeof t.family !== 'string') return undefined;
    return {
      text: t.text.slice(0, 10000), family: t.family.slice(0, 100), size: Math.min(2000, Math.max(1, num(String(t.size), 32))),
      colour: /^#[0-9a-f]{6}$/i.test(String(t.colour)) ? String(t.colour) : '#000000', bold: !!t.bold, italic: !!t.italic,
      align: t.align === 'center' || t.align === 'right' ? t.align : 'left', x: num(String(t.x), 0), y: num(String(t.y), 0),
    };
  } catch {
    return undefined;
  }
}

export function readStack(xml: string): StackRead {
  let root: XmlEl;
  try {
    root = parseXml(xml);
  } catch (error) {
    if (error instanceof XmlProblem) throw new OraProblem(`Its list of layers (stack.xml) is damaged: ${error.message}`);
    throw error;
  }
  if (root.name !== 'image') throw new OraProblem('Its list of layers (stack.xml) does not start with <image>.');
  const width = Math.round(num(root.attrs.w, 0));
  const height = Math.round(num(root.attrs.h, 0));
  if (!(width >= 1 && height >= 1)) throw new OraProblem('It does not say how big the picture is.');
  const notes = new Set<string>();
  const layers: OraLayer[] = [];
  // Groups are opened out into one list (this editor has no groups); a group's own opacity and mode are not kept.
  const walk = (stack: XmlEl, ox: number, oy: number, hidden: boolean, depth: number) => {
    for (const el of stack.kids) {
      if (layers.length > MAX_LAYERS) return;
      if (el.name === 'stack') {
        if (depth > 0 || el.attrs.name) notes.add('Layer groups were opened out into one list of layers; a group\'s own see-through amount and blend mode were not kept.');
        if (depth > 20) continue;
        walk(el, ox + num(el.attrs.x, 0), oy + num(el.attrs.y, 0), hidden || el.attrs.visibility === 'hidden', depth + 1);
      } else if (el.name === 'layer') {
        const src = el.attrs.src ?? '';
        if (!src) continue;
        let mode = blendFromOra(el.attrs['composite-op']);
        if (!mode) {
          notes.add(`A blend mode this editor does not have (${String(el.attrs['composite-op']).slice(0, 40)}) was read as Normal.`);
          mode = 'normal';
        }
        const layer: OraLayer = {
          name: (el.attrs.name ?? '').slice(0, 200) || `Layer ${layers.length + 1}`,
          src, x: ox + num(el.attrs.x, 0), y: oy + num(el.attrs.y, 0),
          opacity: Math.min(1, Math.max(0, num(el.attrs.opacity, 1))),
          visible: !hidden && el.attrs.visibility !== 'hidden',
          locked: el.attrs['edit-locked'] === 'true',
          mode,
        };
        const text = readText(el.attrs['tomlinos:text']);
        if (text) layer.text = text;
        layers.push(layer);
      } else if (el.name === 'text' || el.name === 'filter') {
        notes.add('A text or filter element in the stack was left out (only picture layers are read).');
      }
    }
  };
  const top = child(root, 'stack');
  if (!top) throw new OraProblem('Its list of layers (stack.xml) has no <stack>.');
  walk(top, 0, 0, false, 0);
  if (layers.length > MAX_LAYERS) throw new OraProblem(`It has more than ${MAX_LAYERS} layers, the most Photo Editor holds.`);
  if (!layers.length) throw new OraProblem('It has no layers.');
  return { stack: { width, height, layers }, notes: [...notes] };
}

export interface OraParts {
  stack: OraStack;
  /** PNG bytes for each layer, in the same order as stack.layers. */
  layerPngs: Uint8Array[];
  merged: Uint8Array;
  thumbnail: Uint8Array;
}

/** The .ora file. mimetype goes first and unpacked (readers check it at a fixed place); PNGs are already packed, so
 *  everything is stored as it is. */
export function buildOra(p: OraParts): Uint8Array<ArrayBuffer> {
  const now = Date.now();
  const enc = new TextEncoder();
  return zipStore([
    { name: 'mimetype', data: enc.encode(ORA_TYPE), modified: now },
    { name: 'stack.xml', data: enc.encode(writeStack(p.stack)), modified: now },
    ...p.stack.layers.map((l, i) => ({ name: l.src, data: p.layerPngs[i], modified: now })),
    { name: 'mergedimage.png', data: p.merged, modified: now },
    { name: 'Thumbnails/thumbnail.png', data: p.thumbnail, modified: now },
  ]);
}

/** The size of the thumbnail: the picture's shape, 256 pixels at most on the long side. */
export function thumbSize(w: number, h: number): [number, number] {
  const k = Math.min(1, 256 / Math.max(w, h));
  return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k))];
}

export interface OraOpened {
  stack: OraStack;
  notes: string[];
  /** The PNG bytes of a layer, checked for size first. */
  layerPng(layer: OraLayer): Promise<Uint8Array>;
}

/** Opens the zip and reads stack.xml; every layer's PNG is checked (packed size, declared pixels) before decoding. */
export async function openOra(bytes: Uint8Array): Promise<OraOpened> {
  let entries: ArchiveEntry[];
  try {
    entries = readZip(bytes);
  } catch (error) {
    if (error instanceof ArchiveError) throw new OraProblem(error.message);
    throw error;
  }
  if (entries.length > MAX_ENTRIES) throw new OraProblem(`It holds more than ${MAX_ENTRIES} parts, far more than a layered picture needs.`);
  const byPath = new Map(entries.filter(e => !e.folder).map(e => [e.parts.join('/'), e]));
  const read = async (path: string, max: number): Promise<Uint8Array> => {
    const e = byPath.get(path.replace(/^\/+/, '').replace(/\\/g, '/'));
    if (!e) throw new OraProblem(`A part it lists (${path.slice(0, 80)}) is missing from the file.`);
    if (e.size > max) throw new OraProblem(`A part (${path.slice(0, 80)}) unpacks to more than ${Math.round(max / 1024 / 1024)} MB, which is not opened.`);
    try {
      return await e.read();
    } catch (error) {
      if (error instanceof ArchiveError) throw new OraProblem(error.message);
      throw error;
    }
  };
  const mime = byPath.get('mimetype');
  if (mime && new TextDecoder().decode(await read('mimetype', 100)).trim() !== ORA_TYPE) throw new OraProblem('It says it is not an OpenRaster picture.');
  const { stack, notes } = readStack(new TextDecoder('utf-8').decode(await read('stack.xml', MAX_STACK_XML)));
  if (stack.width * stack.height > MAX_PICTURE_PIXELS) {
    throw new OraProblem(`It says it is ${stack.width.toLocaleString()} × ${stack.height.toLocaleString()} pixels, more than the ${MAX_PICTURE_PIXELS / 1e6} million Photo Editor opens.`);
  }
  if (stack.layers.length * stack.width * stack.height > LAYER_BUDGET) {
    throw new OraProblem(`It has ${stack.layers.length} layers at ${stack.width.toLocaleString()} × ${stack.height.toLocaleString()}, more than this browser can hold safely.`);
  }
  return {
    stack,
    notes,
    layerPng: async l => {
      const png = await read(l.src, MAX_LAYER_FILE);
      const size = imageSize(png);
      if (!size) throw new OraProblem(`The layer “${l.name}” is not a PNG picture.`);
      if (size.width * size.height > MAX_PICTURE_PIXELS || size.width > stack.width * 4 + 16384 || size.height > stack.height * 4 + 16384) {
        throw new OraProblem(`The layer “${l.name}” says it is ${size.width.toLocaleString()} × ${size.height.toLocaleString()} pixels, far more than the picture; it was not opened.`);
      }
      return png;
    },
  };
}
