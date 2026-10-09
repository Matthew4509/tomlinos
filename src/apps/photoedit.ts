// Photo Editor: open a picture, crop, rotate, flip, resize, adjust brightness / contrast / colour, filters (greyscale,
// sepia, invert, blur, sharpen), draw (brush, eraser, line, rectangle, ellipse, arrow, text, fill, colour picker),
// undo and redo, and save as PNG, JPEG or WebP. All our own code; the pixel sums are in photoedit/pixels.ts.
// A picture is only ever drawn into a canvas, so nothing inside a file (an SVG's script, say) can run.
import { h, on } from '../core/dom.ts';
import { formatSize } from '../core/format.ts';
import { baseName, parentPath, splitExtension } from '../fs/names.ts';
import { pickFile, pickSave } from '../shell/filepicker.ts';
import { extensionOf } from '../shell/filetypes.ts';
import type { AppDef, AppHandle } from '../shell/types.ts';
import { mediaTypeOf } from './media.ts';
import { pictureTooBig } from '../core/imagesize.ts';
import { APPS } from './catalog.ts';
import { okToReplace } from '../shell/savefile.ts';
import {
  BLUR, brightnessContrast, convolve3, crop, flip, floodFill, greyscale, hexToRgba, invert, keepShape, rgbToHex, rotate90,
  saturation, sepia, SHARPEN, type Pixels,
} from './photoedit/pixels.ts';

const MAX_FILE = 60 * 1024 * 1024;
/** Beyond this many pixels a picture is refused: one undo step alone would be over 200 MB. */
const MAX_PIXELS = 50_000_000;
/** Undo keeps steps until they add up to this. */
const HISTORY_BYTES = 400 * 1024 * 1024;
const SAVE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
const OPEN_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico'];
const ZOOMS = [0.05, 0.1, 0.17, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.5, 2, 3, 4, 6, 8];

type Tool = 'brush' | 'eraser' | 'line' | 'rect' | 'ellipse' | 'arrow' | 'text' | 'fill' | 'picker' | 'crop' | 'hand';
const TOOLS: Array<[Tool, string, string, string]> = [
  ['brush', '✎', 'Brush', 'B'], ['eraser', '⌫', 'Eraser (to see-through)', 'E'], ['line', '╱', 'Line', 'L'],
  ['arrow', '➔', 'Arrow', 'A'], ['rect', '▭', 'Rectangle', 'R'], ['ellipse', '◯', 'Ellipse', 'O'], ['text', 'T', 'Text', 'T'],
  ['fill', '▧', 'Fill (paint bucket)', 'G'], ['picker', '⊙', 'Pick a colour from the picture', 'I'], ['crop', '⛶', 'Crop', 'C'],
  ['hand', '✋', 'Move around (or hold Space)', 'H'],
];

export const photoEditApp: AppDef = {
  ...APPS.photoedit,
  launch: (app, arg) => run(app, arg),
};

async function run(app: AppHandle, arg: string | undefined): Promise<void> {
  const shell = app.shell;
  app.root.classList.add('pe');
  let path: string | null = null;
  let modified = 0;
  let dirty = false;
  let zoom = 1;
  let tool: Tool = 'brush';
  const undo: ImageData[] = [];
  const redo: ImageData[] = [];

  // ---- The picture: one canvas at full size, and one on top for previews (shapes, the crop box) ----
  const doc = h('canvas', { class: 'pe-doc', width: 800, height: 600 });
  const over = h('canvas', { class: 'pe-over', width: 800, height: 600, 'aria-hidden': 'true' });
  const ctx = doc.getContext('2d', { willReadFrequently: true })!;
  const octx = over.getContext('2d')!;
  const sheet = h('div', { class: 'pe-sheet' }, doc, over);
  const stage = h('div', { class: 'pe-stage', tabindex: '0', 'aria-label': 'Picture' }, sheet);

  // ---- Controls ----
  const tool$ = (label: string, title: string, extra: Record<string, string> = {}) => h('button', { type: 'button', class: 'tool wide', title, ...extra }, label);
  const newBtn = tool$('New...', 'A new blank picture');
  const openBtn = tool$('Open...', 'Open a picture (Ctrl+O)');
  const saveBtn = tool$('Save', 'Save (Ctrl+S)');
  const saveAsBtn = tool$('Save as...', 'Save as PNG, JPEG or WebP (Ctrl+Shift+S)');
  const undoBtn = tool$('↶', 'Undo (Ctrl+Z)', { 'aria-label': 'Undo' });
  const redoBtn = tool$('↷', 'Redo (Ctrl+Y)', { 'aria-label': 'Redo' });
  const rotL = tool$('⟲', 'Rotate left', { 'aria-label': 'Rotate left' });
  const rotR = tool$('⟳', 'Rotate right', { 'aria-label': 'Rotate right' });
  const flipH = tool$('⇋', 'Flip left to right', { 'aria-label': 'Flip left to right' });
  const flipV = tool$('⇵', 'Flip upside down', { 'aria-label': 'Flip upside down' });
  const resizeBtn = tool$('Resize...', 'Change the size in pixels');
  const adjustBtn = tool$('Adjust...', 'Brightness, contrast and colour');
  const filterBtn = tool$('Filters ▾', 'Greyscale, sepia, invert, blur, sharpen');
  const zoomOut = tool$('−', 'Zoom out (-)', { 'aria-label': 'Zoom out' });
  const zoomFit = tool$('Fit', 'Fit the window (0)');
  const zoom100 = tool$('100%', 'Actual size (1)');
  const zoomIn = tool$('+', 'Zoom in (+)', { 'aria-label': 'Zoom in' });

  const toolButtons = new Map<Tool, HTMLButtonElement>();
  const palette = h('div', { class: 'pe-tools', role: 'toolbar', 'aria-label': 'Tools', 'aria-orientation': 'vertical' },
    ...TOOLS.map(([id, glyph, name, key]) => {
      const b = h('button', { type: 'button', class: 'pe-tool', title: `${name} (${key})`, 'aria-label': name, 'aria-pressed': 'false' }, glyph);
      toolButtons.set(id, b);
      on(b, 'click', () => setTool(id), app.signal);
      return b;
    }));

  const colour = h('input', { type: 'color', value: '#d62828', 'aria-label': 'Colour', title: 'Colour' });
  const size = h('input', { type: 'range', min: 1, max: 120, value: 8, 'aria-label': 'Size', title: 'Brush and line size' });
  const sizeOut = h('span', { class: 'pe-num' }, '8 px');
  const fillBox = h('input', { type: 'checkbox', 'aria-label': 'Filled shape' });
  const fillLabel = h('label', { class: 'pe-opt' }, fillBox, 'Filled');
  const tolerance = h('input', { type: 'range', min: 0, max: 255, value: 32, 'aria-label': 'Fill tolerance', title: 'How different a colour may be and still be filled' });
  const tolLabel = h('label', { class: 'pe-opt' }, 'Tolerance', tolerance);
  const fontSize = h('input', { type: 'number', class: 'field num', min: 6, max: 400, value: 32, 'aria-label': 'Text size' });
  const fontLabel = h('label', { class: 'pe-opt' }, 'Text size', fontSize);
  const cropApply = tool$('Crop to the box', 'Crop (Enter)');
  const cropCancel = tool$('Cancel', 'Cancel (Escape)');
  const cropBar = h('span', { class: 'pe-opt pe-cropbar', hidden: true }, cropApply, cropCancel);
  const options = h('div', { class: 'toolbar pe-options' }, colour, size, sizeOut, fillLabel, tolLabel, fontLabel, cropBar);

  const status = h('div', { class: 'statusbar pe-status', role: 'status' });
  const where = h('span', { class: 'pe-where' });
  app.root.replaceChildren(
    h('div', { class: 'toolbar pe-top' }, newBtn, openBtn, saveBtn, saveAsBtn, h('span', { class: 'tool-gap' }), undoBtn, redoBtn,
      h('span', { class: 'tool-gap' }), rotL, rotR, flipH, flipV, resizeBtn, adjustBtn, filterBtn, h('span', { class: 'tool-gap' }), zoomOut, zoomFit, zoom100, zoomIn),
    options, h('div', { class: 'pe-body' }, palette, stage), h('div', { class: 'pe-foot' }, status, where));

  // ---- Showing ----
  function paintZoom() {
    const w = Math.max(1, Math.round(doc.width * zoom));
    const hgt = Math.max(1, Math.round(doc.height * zoom));
    for (const c of [doc, over]) {
      c.style.width = `${w}px`;
      c.style.height = `${hgt}px`;
    }
    sheet.style.width = `${w}px`;
    sheet.style.height = `${hgt}px`;
    // Big zoom shows the pixels; small zoom smooths them.
    doc.classList.toggle('pixelated', zoom >= 2);
    refresh();
  }
  /** True until the person zooms by hand: the picture then follows the window's size. */
  let autoFit = true;
  function fit() {
    autoFit = true;
    if (!stage.clientWidth) return void requestAnimationFrame(() => stage.clientWidth && fit());
    const w = stage.clientWidth - 24;
    const hgt = stage.clientHeight - 24;
    zoom = Math.max(0.02, Math.min(1, w / doc.width, hgt / doc.height));
    paintZoom();
  }
  function stepZoom(dir: 1 | -1) {
    const next = dir > 0 ? ZOOMS.find(z => z > zoom + 1e-6) : [...ZOOMS].reverse().find(z => z < zoom - 1e-6);
    if (next) {
      autoFit = false;
      zoom = next;
      paintZoom();
    }
  }
  function refresh() {
    undoBtn.disabled = undo.length === 0;
    redoBtn.disabled = redo.length === 0;
    const name = path ? baseName(path) : 'Untitled.png';
    app.setTitle(`${name}${dirty ? ' *' : ''} - Photo Editor`);
    app.setDirty(dirty);
    status.textContent = `${name}  ·  ${doc.width} × ${doc.height} pixels  ·  ${Math.round(zoom * 100)}%${dirty ? '  ·  not saved' : ''}`;
  }

  // ---- Undo ----
  const bytes = (list: ImageData[]) => list.reduce((n, d) => n + d.data.length, 0);
  function snapshot() {
    undo.push(ctx.getImageData(0, 0, doc.width, doc.height));
    redo.length = 0;
    while (undo.length > 1 && bytes(undo) > HISTORY_BYTES) undo.shift();
    dirty = true;
    refresh();
  }
  function restore(from: ImageData[], to: ImageData[]) {
    const img = from.pop();
    if (!img) return;
    to.push(ctx.getImageData(0, 0, doc.width, doc.height));
    setSize(img.width, img.height);
    ctx.putImageData(img, 0, 0);
    dirty = true;
    paintZoom();
  }
  function setSize(w: number, hgt: number) {
    if (doc.width !== w || doc.height !== hgt) {
      doc.width = over.width = w;
      doc.height = over.height = hgt;
    }
  }
  const pixels = (): Pixels => {
    const img = ctx.getImageData(0, 0, doc.width, doc.height);
    return { data: img.data, width: img.width, height: img.height };
  };
  const put = (p: Pixels) => {
    setSize(p.width, p.height);
    ctx.putImageData(new ImageData(p.data as Uint8ClampedArray<ArrayBuffer>, p.width, p.height), 0, 0);
    paintZoom();
  };
  /** One change to every pixel, as one undo step. */
  function change(fn: (p: Pixels) => Pixels | void) {
    snapshot();
    const p = pixels();
    put(fn(p) ?? p);
  }

  // ---- Opening and saving ----
  function blank(w: number, hgt: number, white: boolean) {
    setSize(w, hgt);
    ctx.clearRect(0, 0, w, hgt);
    if (white) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, hgt);
    }
    path = null;
    dirty = false;
    undo.length = redo.length = 0;
    fit();
  }

  async function decode(bytes: Uint8Array, name: string): Promise<CanvasImageSource & { width: number; height: number }> {
    const type = mediaTypeOf(name) ?? 'application/octet-stream';
    const blob = new Blob([bytes as BlobPart], { type });
    if (type !== 'image/svg+xml') {
      try {
        return await createImageBitmap(blob);
      } catch {
        // Fall through to an <img>, which knows a few more kinds.
      }
    }
    // An <img> never runs an SVG's scripts or loads what it links to.
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function openPath(p: string): Promise<boolean> {
    try {
      const entry = await shell.fs.stat(p);
      if (!entry || entry.kind !== 'file') throw new Error('gone');
      if (entry.size > MAX_FILE) {
        await shell.dialogs.alert('Too big to open', `“${entry.name}” is ${formatSize(entry.size)}. Photo Editor opens pictures up to ${formatSize(MAX_FILE)}. It is safe where it is.`);
        return false;
      }
      status.textContent = 'Opening...';
      const bytes = await shell.fs.readFile(p);
      // A small file can declare a huge picture: refused from its header, before any decoding.
      const tooBig = pictureTooBig(bytes);
      if (tooBig) {
        await shell.dialogs.alert('Too many pixels', tooBig);
        refresh();
        return false;
      }
      const img = await decode(bytes, entry.name);
      const w = img.width || 300;
      const hgt = img.height || 150;
      if (w * hgt > MAX_PIXELS) {
        await shell.dialogs.alert('Too many pixels', `This picture is ${w} × ${hgt} pixels. Photo Editor opens pictures up to ${MAX_PIXELS / 1e6} million pixels, so it does not run out of memory. It is safe where it is.`);
        return false;
      }
      setSize(w, hgt);
      ctx.clearRect(0, 0, w, hgt);
      ctx.drawImage(img, 0, 0, w, hgt);
      if ('close' in img && typeof img.close === 'function') img.close();
      path = p;
      modified = entry.modified;
      dirty = false;
      undo.length = redo.length = 0;
      fit();
      return true;
    } catch (error) {
      await shell.dialogs.alert('Could not open that', error instanceof Error && error.message === 'gone'
        ? 'That file is not there any more. It may have been moved or deleted.'
        : `“${baseName(p)}” could not be read as a picture. It may be damaged, or a kind this browser does not know. It is safe where it is.`);
      refresh();
      return false;
    }
  }

  async function encode(ext: string): Promise<Uint8Array> {
    const type = SAVE_TYPES[ext] ?? 'image/png';
    let source: HTMLCanvasElement = doc;
    if (type === 'image/jpeg') {
      // JPEG has no see-through parts: put the picture on white first, as other editors do.
      source = h('canvas', { width: doc.width, height: doc.height });
      const c = source.getContext('2d')!;
      c.fillStyle = '#ffffff';
      c.fillRect(0, 0, doc.width, doc.height);
      c.drawImage(doc, 0, 0);
    }
    const blob = await new Promise<Blob | null>(resolve => source.toBlob(resolve, type, 0.92));
    if (!blob) throw new Error('The picture could not be turned into a file (it may be too big for this browser).');
    return new Uint8Array(await blob.arrayBuffer());
  }

  async function saveAs(): Promise<boolean> {
    const [stem, ext] = splitExtension(path ? baseName(path) : 'Untitled.png');
    const keep = SAVE_TYPES[ext.slice(1).toLowerCase()] ? ext : '.png';
    const target = await pickSave(shell, { title: 'Save picture as (.png, .jpg or .webp)', folder: path ? parentPath(path) : '/Pictures', name: stem + keep, accept: OPEN_EXTS });
    if (!target) return false;
    let dest = target.path;
    let replace = target.replace;
    if (!SAVE_TYPES[extensionOf(dest)]) {
      dest += '.png';
      replace = !!(await shell.fs.stat(dest).catch(() => null));
      if (replace && !(await shell.dialogs.confirm({ title: 'Replace it?', text: `“${baseName(dest)}” already exists. Replace it?`, ok: 'Replace', danger: true }))) return false;
    }
    return write(dest, replace);
  }

  async function write(dest: string, replace: boolean): Promise<boolean> {
    try {
      const data = await encode(extensionOf(dest));
      const entry = await shell.fs.writeFile(dest, data, replace ? {} : { mustBeNew: true });
      path = dest;
      modified = entry.modified;
      dirty = false;
      refresh();
      shell.toast(`Saved “${entry.name}” (${formatSize(entry.size)}).`);
      return true;
    } catch (error) {
      await shell.report('Could not save the picture', error);
      return false;
    }
  }

  async function save(): Promise<boolean> {
    if (!path || !SAVE_TYPES[extensionOf(path)]) {
      if (path) await shell.dialogs.alert('Saved as a new file', `Photo Editor saves PNG, JPEG and WebP. “${baseName(path)}” stays as it is; choose a name for the edited copy.`);
      return saveAs();
    }
    if (!(await okToReplace(shell, path, modified))) return false;
    return write(path, true);
  }

  async function guard(): Promise<boolean> {
    if (!dirty) return true;
    return shell.dialogs.confirm({ title: 'Not saved', text: 'This picture has changes that are not saved. Carry on and lose them?', ok: 'Lose the changes', danger: true, cancel: 'Keep editing' });
  }

  // ---- Tools ----
  function setTool(t: Tool) {
    if (tool === 'crop' && t !== 'crop') endCrop();
    tool = t;
    for (const [id, b] of toolButtons) b.setAttribute('aria-pressed', String(id === t));
    stage.dataset.tool = t;
    fillLabel.hidden = !['rect', 'ellipse'].includes(t);
    tolLabel.hidden = t !== 'fill';
    fontLabel.hidden = t !== 'text';
    size.hidden = sizeOut.hidden = ['fill', 'picker', 'crop', 'hand', 'text'].includes(t);
    cropBar.hidden = true;
  }

  const toImage = (e: PointerEvent | MouseEvent) => {
    const r = doc.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * doc.width) / r.width, y: ((e.clientY - r.top) * doc.height) / r.height };
  };
  const lineWidth = () => Number(size.value);

  function drawShape(c: CanvasRenderingContext2D, kind: Tool, a: { x: number; y: number }, b: { x: number; y: number }) {
    c.save();
    c.strokeStyle = c.fillStyle = colour.value;
    c.lineWidth = lineWidth();
    c.lineCap = c.lineJoin = 'round';
    c.beginPath();
    if (kind === 'line' || kind === 'arrow') {
      c.moveTo(a.x, a.y);
      c.lineTo(b.x, b.y);
      c.stroke();
      if (kind === 'arrow') {
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        const head = Math.max(10, lineWidth() * 3);
        c.beginPath();
        c.moveTo(b.x, b.y);
        c.lineTo(b.x - head * Math.cos(ang - 0.45), b.y - head * Math.sin(ang - 0.45));
        c.lineTo(b.x - head * Math.cos(ang + 0.45), b.y - head * Math.sin(ang + 0.45));
        c.closePath();
        c.fill();
      }
    } else if (kind === 'rect') {
      c.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      fillBox.checked ? c.fill() : c.stroke();
    } else if (kind === 'ellipse') {
      c.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
      fillBox.checked ? c.fill() : c.stroke();
    }
    c.restore();
  }

  // Crop box, in picture pixels.
  let cropBox: { x: number; y: number; w: number; h: number } | null = null;
  function drawCrop() {
    octx.clearRect(0, 0, over.width, over.height);
    if (!cropBox) return;
    const { x, y, w, h: hh } = normal(cropBox);
    octx.fillStyle = 'rgba(0, 0, 0, 0.45)';
    octx.fillRect(0, 0, over.width, over.height);
    octx.clearRect(x, y, w, hh);
    octx.strokeStyle = '#ffffff';
    octx.lineWidth = Math.max(1, 1 / zoom);
    octx.setLineDash([6 / zoom, 4 / zoom]);
    octx.strokeRect(x, y, w, hh);
    octx.setLineDash([]);
    where.textContent = `Crop ${Math.round(w)} × ${Math.round(hh)}`;
  }
  const normal = (b: { x: number; y: number; w: number; h: number }) => ({
    x: Math.max(0, Math.min(b.x, b.x + b.w)), y: Math.max(0, Math.min(b.y, b.y + b.h)),
    w: Math.min(doc.width, Math.abs(b.w)), h: Math.min(doc.height, Math.abs(b.h)),
  });
  function endCrop() {
    cropBox = null;
    // The crop buttons hide, so keep the keyboard in this window (Ctrl+S, the tool keys).
    if (cropBar.contains(document.activeElement)) stage.focus({ preventScroll: true });
    cropBar.hidden = true;
    octx.clearRect(0, 0, over.width, over.height);
  }
  function applyCrop() {
    if (!cropBox) return;
    const b = normal(cropBox);
    if (b.w < 1 || b.h < 1) return endCrop();
    change(p => crop(p, b.x, b.y, b.w, b.h));
    endCrop();
    fit();
  }

  let drag: { start: { x: number; y: number }; last: { x: number; y: number }; scroll?: { x: number; y: number; cx: number; cy: number } } | null = null;
  let spaceHeld = false;

  on(over, 'pointerdown', async (e: PointerEvent) => {
    if (e.button !== 0) return;
    // A canvas cannot take the keyboard itself; the picture area does, so the tool keys work after a click.
    stage.focus({ preventScroll: true });
    const p = toImage(e);
    const t = spaceHeld ? 'hand' : tool;
    if (t === 'hand') {
      drag = { start: p, last: p, scroll: { x: stage.scrollLeft, y: stage.scrollTop, cx: e.clientX, cy: e.clientY } };
      over.setPointerCapture(e.pointerId);
      return;
    }
    if (t === 'picker') {
      const [r, g, b] = ctx.getImageData(Math.floor(p.x), Math.floor(p.y), 1, 1).data;
      colour.value = rgbToHex(r, g, b);
      return;
    }
    if (t === 'fill') {
      snapshot();
      const px = pixels();
      const n = floodFill(px, p.x, p.y, hexToRgba(colour.value), Number(tolerance.value));
      if (n === 0) undo.pop();
      else put(px);
      return;
    }
    if (t === 'text') {
      const text = await shell.dialogs.prompt({ title: 'Text', label: 'What to write on the picture', ok: 'Add', check: v => (v.trim() ? null : 'Type some text first.') });
      if (!text) return;
      snapshot();
      ctx.save();
      ctx.fillStyle = colour.value;
      ctx.font = `${Math.max(6, Number(fontSize.value) || 32)}px system-ui, sans-serif`;
      ctx.textBaseline = 'top';
      ctx.fillText(text, p.x, p.y);
      ctx.restore();
      return;
    }
    over.setPointerCapture(e.pointerId);
    drag = { start: p, last: p };
    if (t === 'crop') {
      cropBox = { x: p.x, y: p.y, w: 0, h: 0 };
      return;
    }
    if (t === 'brush' || t === 'eraser') {
      snapshot();
      ctx.save();
      ctx.globalCompositeOperation = t === 'eraser' ? 'destination-out' : 'source-over';
      ctx.fillStyle = colour.value;
      ctx.beginPath();
      ctx.arc(p.x, p.y, lineWidth() / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }, app.signal);

  on(over, 'pointermove', (e: PointerEvent) => {
    const p = toImage(e);
    where.textContent = `${Math.floor(p.x)}, ${Math.floor(p.y)}`;
    if (!drag) return;
    const t = drag.scroll ? 'hand' : tool;
    if (t === 'hand' && drag.scroll) {
      stage.scrollLeft = drag.scroll.x - (e.clientX - drag.scroll.cx);
      stage.scrollTop = drag.scroll.y - (e.clientY - drag.scroll.cy);
    } else if (t === 'brush' || t === 'eraser') {
      ctx.save();
      ctx.globalCompositeOperation = t === 'eraser' ? 'destination-out' : 'source-over';
      ctx.strokeStyle = colour.value;
      ctx.lineWidth = lineWidth();
      ctx.lineCap = ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(drag.last.x, drag.last.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      ctx.restore();
    } else if (t === 'crop' && cropBox) {
      cropBox.w = p.x - cropBox.x;
      cropBox.h = p.y - cropBox.y;
      drawCrop();
    } else if (['line', 'arrow', 'rect', 'ellipse'].includes(t)) {
      octx.clearRect(0, 0, over.width, over.height);
      drawShape(octx, t, drag.start, p);
    }
    drag.last = p;
  }, app.signal);

  const endDrag = (e: PointerEvent) => {
    if (!drag) return;
    const p = toImage(e);
    const t = drag.scroll ? 'hand' : tool;
    if (['line', 'arrow', 'rect', 'ellipse'].includes(t)) {
      octx.clearRect(0, 0, over.width, over.height);
      if (Math.hypot(p.x - drag.start.x, p.y - drag.start.y) > 1) {
        snapshot();
        drawShape(ctx, t, drag.start, p);
      }
    } else if (t === 'crop') {
      cropBar.hidden = !cropBox || Math.abs(cropBox.w) < 2 || Math.abs(cropBox.h) < 2;
      if (cropBar.hidden) endCrop();
    }
    drag = null;
    refresh();
  };
  on(over, 'pointerup', endDrag, app.signal);
  on(over, 'pointercancel', endDrag, app.signal);

  // ---- Dialogs: new, resize, adjust ----
  async function askNew() {
    if (!(await guard())) return;
    const w = h('input', { type: 'number', class: 'field num', min: 1, max: 10000, value: 800, 'aria-label': 'Width' });
    const hh = h('input', { type: 'number', class: 'field num', min: 1, max: 10000, value: 600, 'aria-label': 'Height' });
    const white = h('input', { type: 'checkbox', checked: true });
    const ok = await shell.dialogs.ask({
      title: 'New picture',
      body: h('div', { class: 'pe-form' }, h('label', {}, 'Width (pixels) ', w), h('label', {}, 'Height (pixels) ', hh), h('label', {}, white, ' White background (untick for see-through)')),
      buttons: [{ label: 'Create', value: true, primary: true }, { label: 'Cancel', value: false }],
      cancel: false,
      primaryEnabled: () => [w, hh].every(i => Number(i.value) >= 1 && Number(i.value) <= 10000),
    });
    if (ok) blank(Math.round(Number(w.value)), Math.round(Number(hh.value)), white.checked);
  }

  async function askResize() {
    const w = h('input', { type: 'number', class: 'field num', min: 1, max: 20000, value: doc.width, 'aria-label': 'Width' });
    const hh = h('input', { type: 'number', class: 'field num', min: 1, max: 20000, value: doc.height, 'aria-label': 'Height' });
    const lock = h('input', { type: 'checkbox', checked: true });
    const pct = h('span', { class: 'pe-num' });
    const sync = (from: 'w' | 'h') => {
      if (lock.checked) {
        const [nw, nh] = keepShape(doc.width, doc.height, from === 'w' ? Number(w.value) || null : null, from === 'h' ? Number(hh.value) || null : null);
        w.value = String(nw);
        hh.value = String(nh);
      }
      pct.textContent = `${Math.round((Number(w.value) / doc.width) * 100)}%`;
    };
    const ab = new AbortController();
    w.addEventListener('input', () => sync('w'), { signal: ab.signal });
    hh.addEventListener('input', () => sync('h'), { signal: ab.signal });
    sync('w');
    const ok = await shell.dialogs.ask({
      title: 'Resize picture',
      body: h('div', { class: 'pe-form' }, h('label', {}, 'Width ', w), h('label', {}, 'Height ', hh), h('label', {}, lock, ' Keep the shape'), pct),
      buttons: [{ label: 'Resize', value: true, primary: true }, { label: 'Cancel', value: false }],
      cancel: false,
      primaryEnabled: () => [w, hh].every(i => Number(i.value) >= 1 && Number(i.value) <= 20000) && Number(w.value) * Number(hh.value) <= MAX_PIXELS,
    });
    ab.abort();
    if (!ok) return;
    const nw = Math.round(Number(w.value));
    const nh = Math.round(Number(hh.value));
    snapshot();
    // Halving in steps keeps a big reduction smooth instead of grainy.
    let src: HTMLCanvasElement = h('canvas', { width: doc.width, height: doc.height });
    src.getContext('2d')!.drawImage(doc, 0, 0);
    while (src.width / 2 >= nw && src.height / 2 >= nh) {
      const half = h('canvas', { width: Math.round(src.width / 2), height: Math.round(src.height / 2) });
      const hc = half.getContext('2d')!;
      hc.imageSmoothingQuality = 'high';
      hc.drawImage(src, 0, 0, half.width, half.height);
      src = half;
    }
    setSize(nw, nh);
    ctx.clearRect(0, 0, nw, nh);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, nw, nh);
    fit();
  }

  async function askAdjust() {
    const original = ctx.getImageData(0, 0, doc.width, doc.height);
    const slider = (label: string) => {
      const input = h('input', { type: 'range', min: -100, max: 100, value: 0, 'aria-label': label });
      const out = h('span', { class: 'pe-num' }, '0');
      input.addEventListener('input', () => (out.textContent = input.value));
      return { input, row: h('label', { class: 'pe-slider' }, h('span', {}, label), input, out) };
    };
    const b = slider('Brightness');
    const c = slider('Contrast');
    const s = slider('Colour');
    let queued = false;
    const preview = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        const copy = new ImageData(new Uint8ClampedArray(original.data), original.width, original.height);
        const p = { data: copy.data, width: copy.width, height: copy.height };
        brightnessContrast(p, Number(b.input.value), Number(c.input.value));
        saturation(p, Number(s.input.value));
        ctx.putImageData(copy, 0, 0);
      });
    };
    const body = h('div', { class: 'pe-form' }, b.row, c.row, s.row);
    body.addEventListener('input', preview);
    const ok = await shell.dialogs.ask({
      title: 'Adjust',
      body,
      buttons: [{ label: 'Apply', value: true, primary: true }, { label: 'Cancel', value: false }],
      cancel: false,
    });
    await new Promise(r => requestAnimationFrame(r));
    ctx.putImageData(original, 0, 0);
    if (!ok || [b, c, s].every(x => x.input.value === '0')) return;
    change(p => {
      brightnessContrast(p, Number(b.input.value), Number(c.input.value));
      saturation(p, Number(s.input.value));
    });
  }

  // ---- Wiring ----
  on(newBtn, 'click', () => void askNew(), app.signal);
  const openPicked = async () => {
    if (!(await guard())) return;
    const p = await pickFile(shell, { title: 'Open picture', folder: path ? parentPath(path) : '/Pictures', accept: OPEN_EXTS });
    if (p) await openPath(p);
  };
  on(openBtn, 'click', () => void openPicked(), app.signal);
  on(saveBtn, 'click', () => void save(), app.signal);
  on(saveAsBtn, 'click', () => void saveAs(), app.signal);
  on(undoBtn, 'click', () => restore(undo, redo), app.signal);
  on(redoBtn, 'click', () => restore(redo, undo), app.signal);
  on(rotL, 'click', () => (change(p => rotate90(p, -1)), fit()), app.signal);
  on(rotR, 'click', () => (change(p => rotate90(p, 1)), fit()), app.signal);
  on(flipH, 'click', () => change(p => flip(p, true)), app.signal);
  on(flipV, 'click', () => change(p => flip(p, false)), app.signal);
  on(resizeBtn, 'click', () => void askResize(), app.signal);
  on(adjustBtn, 'click', () => void askAdjust(), app.signal);
  on(filterBtn, 'click', () => {
    const r = filterBtn.getBoundingClientRect();
    shell.menus.show([
      { label: 'Greyscale', action: () => change(greyscale) },
      { label: 'Sepia', action: () => change(sepia) },
      { label: 'Invert colours', action: () => change(invert) },
      { separator: true },
      { label: 'Blur', action: () => change(p => convolve3(p, BLUR)) },
      { label: 'Sharpen', action: () => change(p => convolve3(p, SHARPEN)) },
    ], r.left, r.bottom, { returnFocus: filterBtn });
  }, app.signal);
  on(zoomIn, 'click', () => stepZoom(1), app.signal);
  on(zoomOut, 'click', () => stepZoom(-1), app.signal);
  on(zoomFit, 'click', fit, app.signal);
  on(zoom100, 'click', () => ((autoFit = false), (zoom = 1), paintZoom()), app.signal);
  on(size, 'input', () => (sizeOut.textContent = `${size.value} px`), app.signal);
  on(cropApply, 'click', applyCrop, app.signal);
  on(cropCancel, 'click', endCrop, app.signal);
  on(stage, 'wheel', (e: WheelEvent) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    stepZoom(e.deltaY < 0 ? 1 : -1);
  }, app.signal, { passive: false });
  on(app.root, 'keydown', (e: KeyboardEvent) => {
    const typing = e.target instanceof HTMLInputElement && e.target.type !== 'range' && e.target.type !== 'checkbox' && e.target.type !== 'color';
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    const act = (fn: () => void) => {
      e.preventDefault();
      fn();
    };
    if (ctrl && k === 's') return act(() => void (e.shiftKey ? saveAs() : save()));
    if (ctrl && k === 'o') return act(() => void openPicked());
    if (ctrl && k === 'z') return act(() => (e.shiftKey ? restore(redo, undo) : restore(undo, redo)));
    if (ctrl && k === 'y') return act(() => restore(redo, undo));
    if (typing || ctrl || e.altKey) return;
    if (e.key === 'Enter' && cropBox) return act(applyCrop);
    if (e.key === 'Escape' && cropBox) return act(endCrop);
    if (e.key === ' ' && !spaceHeld) {
      spaceHeld = true;
      stage.dataset.tool = 'hand';
      return act(() => undefined);
    }
    if (e.key === '+' || e.key === '=') return act(() => stepZoom(1));
    if (e.key === '-') return act(() => stepZoom(-1));
    if (e.key === '0') return act(fit);
    if (e.key === '1') return act(() => ((autoFit = false), (zoom = 1), paintZoom()));
    const hit = TOOLS.find(t => t[3].toLowerCase() === k);
    if (hit) act(() => setTool(hit[0]));
  }, app.signal);
  on(app.root, 'keyup', (e: KeyboardEvent) => {
    if (e.key === ' ') {
      spaceHeld = false;
      stage.dataset.tool = tool;
    }
  }, app.signal);
  new ResizeObserver(() => autoFit && fit()).observe(stage);

  setTool('brush');
  blank(800, 600, true);
  if (arg) await openPath(arg);
  stage.focus();
}
