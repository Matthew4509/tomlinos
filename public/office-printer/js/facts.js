// What the printers know about the file you print: its name, kind and size, and for a picture its size in pixels,
// its main colour and whether it has a see-through background. Worked out in this browser; the file goes nowhere.
import { extOf, kindOf } from './engine.js';

const ALPHA_FORMATS = new Set(['.png', '.gif', '.webp', '.avif']);
const MAX_PICTURE_BYTES = 40 * 1024 * 1024;

/** The colour name of one pixel: transparent, black, white, grey, or a hue. */
export function colourOf(r, g, b, a = 255) {
  if (a < 128) return 'transparent';
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const v = max / 255;
  const s = max === 0 ? 0 : (max - min) / max;
  if (v < 0.2) return 'black';
  if (s < 0.16) return v > 0.85 ? 'white' : 'grey';
  let h;
  if (max === r) h = ((g - b) / (max - min)) % 6;
  else if (max === g) h = (b - r) / (max - min) + 2;
  else h = (r - g) / (max - min) + 4;
  h = (h * 60 + 360) % 360;
  if (h < 15 || h >= 330) return 'red';
  if (h < 40) return 'orange';
  if (h < 70) return 'yellow';
  if (h < 165) return 'green';
  if (h < 200) return 'cyan';
  if (h < 255) return 'blue';
  if (h < 290) return 'purple';
  return 'magenta';
}

/** The main colour of RGBA pixel data, and how much of it is see-through. */
export function paletteOf(data) {
  const counts = {};
  let seen = 0;
  let clear = 0;
  for (let i = 0; i < data.length; i += 4) {
    const name = colourOf(data[i], data[i + 1], data[i + 2], data[i + 3]);
    seen++;
    if (name === 'transparent') {
      clear++;
      continue;
    }
    counts[name] = (counts[name] ?? 0) + 1;
  }
  const solid = seen - clear;
  const [colour, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  return { colour, share: solid ? count / solid : 0, clear: seen ? clear / seen : 0 };
}

/**
 * The facts about a file. `file` is { name, size?, sample?, blob() }. A picture is opened (never uploaded) to measure
 * it; one that will not open is still printed, just without the colour remarks.
 */
export async function factsFor(script, file) {
  const name = String(file.name);
  const ext = extOf(name);
  const kind = kindOf(script, name);
  const facts = { name, ext, kind, size: Number.isFinite(file.size) ? file.size : null, sample: file.sample ?? null };
  if (kind === 'image' && typeof file.blob === 'function' && !(facts.size > MAX_PICTURE_BYTES)) {
    try {
      const blob = await file.blob();
      if (facts.size == null) facts.size = blob.size;
      const bitmap = await createImageBitmap(blob);
      facts.bitmap = bitmap;
      facts.width = bitmap.width;
      facts.height = bitmap.height;
      facts.pixels = bitmap.width * bitmap.height;
      const scale = Math.min(1, 96 / Math.max(bitmap.width, bitmap.height));
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const g = canvas.getContext('2d', { willReadFrequently: true });
      g.drawImage(bitmap, 0, 0, w, h);
      const palette = paletteOf(g.getImageData(0, 0, w, h).data);
      facts.colour = palette.colour;
      facts.share = palette.share;
      facts.alpha = ALPHA_FORMATS.has(ext) && palette.clear >= 0.05;
    } catch {
      facts.unreadable = true;
    }
  }
  return facts;
}

/** What the start screen says about a file, under its name. */
export function describe(facts) {
  const kinds = { pdf: 'PDF document', doc: 'Word document', sheet: 'Spreadsheet', text: 'Plain text', image: 'Picture', exe: 'Program', other: 'File' };
  const bits = [kinds[facts.kind] ?? 'File'];
  if (facts.width) bits.push(`${facts.width} × ${facts.height}`);
  if (facts.kind === 'pdf' && facts.sample) bits.push('1 page');
  if (Number.isFinite(facts.size)) {
    const b = facts.size;
    bits.push(b < 1024 ? `${b} bytes` : b < 1048576 ? `${Math.round(b / 1024)} KB` : `${(b / 1048576).toFixed(1)} MB`);
  }
  return bits.join(' · ');
}
