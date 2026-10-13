// Photo Editor: a light GIMP. Layers (blend modes, see-through amount, lock, editable text layers), selections
// (rectangle, ellipse, lasso, magic wand, soft edges), painting (brush, eraser, shapes, fill, gradient, with size,
// hardness, opacity, spacing and pen pressure), retouching (clone, heal, smudge, dodge / burn, blur / sharpen), colour
// (levels, curves, hue / saturation, colour balance, threshold, posterise, desaturate), move / scale / turn, crop,
// resize, canvas size, filters, undo and redo; opens and saves PNG, JPEG, WebP and OpenRaster (.ora, layers kept).
// All our own code; the sums are in photoedit/*.ts. A picture is only ever drawn into a canvas, so nothing inside a
// file (an SVG's script, say) can run.
import { css, h, on } from '../core/dom.ts';
import { formatSize } from '../core/format.ts';
import { baseName, parentPath, splitExtension } from '../fs/names.ts';
import { pickFile, pickSave } from '../shell/filepicker.ts';
import { extensionOf } from '../shell/filetypes.ts';
import type { AppDef, AppHandle } from '../shell/types.ts';
import type { MenuItem } from '../shell/menu.ts';
import { mediaTypeOf } from './media.ts';
import { MAX_PICTURE_PIXELS, pictureTooBig } from '../core/imagesize.ts';
import { APPS } from './catalog.ts';
import { saveOver } from '../shell/savefile.ts';
import { BLUR, convolve3, floodFill, greyscale, hexToRgba, invert, keepShape, rgbToHex, sepia, SHARPEN } from './photoedit/pixels.ts';
import { Doc, makeCanvas, makeLayer, paintText, surfaceOf, textBounds, type Layer } from './photoedit/doc.ts';
import { clipRect, group, PixelPatch, TILE, unionRect, type Rect } from './photoedit/history.ts';
import { combine, cropMask, ellipseMask, feather, invertMask, polygonMask, rectMask, wandMask, type Combine, type Mask, type Point } from './photoedit/selection.ts';
import { blurSharpenDab, cloneDab, DabPath, dabRect, dodgeBurnDab, healDab, makeCarry, smudgeDab, type Carry, type Dab } from './photoedit/retouch.ts';
import { blendInfo, copyName, moveItem, nextName, noRoomForLayer } from './photoedit/layers.ts';
import { buildOra, openOra, OraProblem, thumbSize, type OraLayer, type TextSpec } from './photoedit/ora.ts';
import { boxBounds, corners, dragBox, HANDLES, handlePoint, hitHandle, isIdentity, type Box, type Handle } from './photoedit/transform.ts';
import { FONT_FAMILIES } from './photoedit/text.ts';
import { adjust, type AdjustKind } from './photoedit/adjust-ui.ts';
import { layersPanel } from './photoedit/layers-ui.ts';

const MAX_FILE = 60 * 1024 * 1024;
/** Beyond this many pixels a picture is refused (about 200 MB once decoded, for one layer). */
const MAX_PIXELS = MAX_PICTURE_PIXELS;
const SAVE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', ora: 'image/openraster' };
const OPEN_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico', 'ora'];
const ZOOMS = [0.05, 0.1, 0.17, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16];

type Tool =
  | 'move' | 'rselect' | 'eselect' | 'lasso' | 'wand' | 'crop' | 'brush' | 'eraser' | 'fill' | 'gradient' | 'line' | 'arrow'
  | 'rect' | 'ellipse' | 'text' | 'picker' | 'clone' | 'heal' | 'smudge' | 'dodge' | 'blur' | 'hand';
/** id, picture, name, key (a capital letter means with Shift). */
const TOOLS: Array<[Tool, string, string, string]> = [
  ['move', '✥', 'Move, stretch and turn', 'v'], ['rselect', '⬚', 'Select a rectangle', 'm'],
  ['eselect', '◌', 'Select an ellipse', 'M'], ['lasso', '➰', 'Lasso: drag freely, or click corner by corner', 'f'],
  ['wand', '✦', 'Magic wand: select by colour', 'w'], ['crop', '⛶', 'Crop', 'c'],
  ['brush', '✎', 'Brush', 'b'], ['eraser', '⌫', 'Eraser (to see-through)', 'e'],
  ['fill', '▧', 'Fill (paint bucket)', 'g'], ['gradient', '▤', 'Gradient', 'G'],
  ['line', '╱', 'Line', 'l'], ['arrow', '➔', 'Arrow', 'a'],
  ['rect', '▭', 'Rectangle', 'r'], ['ellipse', '◯', 'Ellipse', 'o'],
  ['text', 'T', 'Text', 't'], ['picker', '⊙', 'Pick a colour from the picture', 'i'],
  ['clone', '⎘', 'Clone stamp (Alt+click where to copy from)', 's'], ['heal', '✚', 'Heal (Alt+click where to copy from)', 'j'],
  ['smudge', '☝', 'Smudge', 'u'], ['dodge', '◐', 'Dodge / burn (lighten / darken)', 'n'],
  ['blur', '◍', 'Blur / sharpen brush', 'y'], ['hand', '✋', 'Move around (or hold Space)', 'h'],
];
const keyName = (k: string) => (k === k.toUpperCase() && k !== k.toLowerCase() ? `Shift+${k}` : k.toUpperCase());
const PAINT_TOOLS: Tool[] = ['brush', 'eraser', 'clone', 'heal', 'smudge', 'dodge', 'blur'];
const RETOUCH: Tool[] = ['clone', 'heal', 'smudge', 'dodge', 'blur'];
const SHAPES: Tool[] = ['line', 'arrow', 'rect', 'ellipse'];
const SELECTS: Tool[] = ['rselect', 'eselect', 'lasso', 'wand'];

export const photoEditApp: AppDef = {
  ...APPS.photoedit,
  launch: (app, arg) => run(app, arg),
};

/** What the clipboard holds when it was copied here (the system clipboard may also have it as a PNG). */
let internalClip: { canvas: HTMLCanvasElement; x: number; y: number; at: number } | null = null;

async function run(app: AppHandle, arg: string | undefined): Promise<void> {
  const shell = app.shell;
  app.root.classList.add('pe');
  let path: string | null = null;
  let loadedId = '';
  let dirty = false;
  /** Counts changes, so a change made while a save is on its way stays marked unsaved. */
  let edits = 0;
  let zoom = 1;
  let tool: Tool = 'brush';
  /** Paths for which the person agreed that a flat file (PNG, JPEG, WebP) drops the layers. */
  const flatAgreed = new Set<string>();

  // ---- The picture: layers drawn together into one canvas, and one on top for outlines and handles ----
  const display = h('canvas', { class: 'pe-doc', width: 800, height: 600 });
  const over = h('canvas', { class: 'pe-over', width: 800, height: 600, 'aria-hidden': 'true' });
  const octx = over.getContext('2d')!;
  const doc = new Doc(display, 800, 600);
  let [strokeCanvas, strokeCtx] = makeCanvas(800, 600);
  const sheet = h('div', { class: 'pe-sheet' }, display, over);
  const stage = h('div', { class: 'pe-stage', tabindex: '0', 'aria-label': 'Picture' }, sheet);

  // ---- Controls ----
  const tool$ = (label: string, title: string, extra: Record<string, string> = {}) => h('button', { type: 'button', class: 'tool wide', title, ...extra }, label);
  const newBtn = tool$('New...', 'A new blank picture');
  const openBtn = tool$('Open...', 'Open a picture (Ctrl+O)');
  const saveBtn = tool$('Save', 'Save (Ctrl+S)');
  const saveAsBtn = tool$('Save as...', 'Save as PNG, JPEG, WebP or OpenRaster (.ora, keeps the layers) (Ctrl+Shift+S)');
  const undoBtn = tool$('↶', 'Undo (Ctrl+Z)', { 'aria-label': 'Undo' });
  const redoBtn = tool$('↷', 'Redo (Ctrl+Y)', { 'aria-label': 'Redo' });
  const menuBtn = (label: string, title: string) => h('button', { type: 'button', class: 'tool wide', title, 'aria-haspopup': 'menu' }, `${label} ▾`);
  const editMenu = menuBtn('Edit', 'Cut, copy, paste, fill');
  const imageMenu = menuBtn('Image', 'Resize, canvas size, crop, turn, flip');
  const layerMenu = menuBtn('Layer', 'Add, copy, merge and change layers');
  const selectMenu = menuBtn('Select', 'Select all, none, invert, soften the edge');
  const colourMenu = menuBtn('Colours', 'Levels, curves, hue and saturation...');
  const filterBtn = menuBtn('Filters', 'Greyscale, sepia, invert, blur, sharpen');
  const helpMenu = menuBtn('Help', 'What Photo Editor does and leaves out');
  const rotL = tool$('⟲', 'Rotate the picture left', { 'aria-label': 'Rotate left' });
  const rotR = tool$('⟳', 'Rotate the picture right', { 'aria-label': 'Rotate right' });
  const flipH = tool$('⇋', 'Flip the picture left to right', { 'aria-label': 'Flip left to right' });
  const flipV = tool$('⇵', 'Flip the picture upside down', { 'aria-label': 'Flip upside down' });
  const zoomOut = tool$('−', 'Zoom out (-)', { 'aria-label': 'Zoom out' });
  const zoomFit = tool$('Fit', 'Fit the window (0)');
  const zoom100 = tool$('100%', 'Actual size (1)');
  const zoomIn = tool$('+', 'Zoom in (+)', { 'aria-label': 'Zoom in' });
  const layersToggle = tool$('Layers', 'Show or hide the Layers panel (F7)', { 'aria-pressed': 'true' });

  const toolButtons = new Map<Tool, HTMLButtonElement>();
  const palette = h('div', { class: 'pe-tools', role: 'toolbar', 'aria-label': 'Tools', 'aria-orientation': 'vertical' },
    ...TOOLS.map(([id, glyph, name, key]) => {
      const b = h('button', { type: 'button', class: 'pe-tool', title: `${name} (${keyName(key)})`, 'aria-label': name, 'aria-pressed': 'false' }, glyph);
      toolButtons.set(id, b);
      on(b, 'click', () => setTool(id), app.signal);
      return b;
    }));

  const colour = h('input', { type: 'color', value: '#d62828', 'aria-label': 'Colour', title: 'Colour' });
  const colour2 = h('input', { type: 'color', value: '#ffffff', 'aria-label': 'Second colour', title: 'Second colour (gradients, Edit > Fill with the second colour)' });
  const swapBtn = h('button', { type: 'button', class: 'tool', title: 'Swap the two colours (X)', 'aria-label': 'Swap colours' }, '⇄');
  const range = (label: string, min: number, max: number, value: number, unit: string, title: string) => {
    const input = h('input', { type: 'range', min, max, value, 'aria-label': label, title });
    const out = h('span', { class: 'pe-num' }, `${value}${unit}`);
    on(input, 'input', () => (out.textContent = `${input.value}${unit}`), app.signal);
    const wrap = h('label', { class: 'pe-opt', title }, label, input, out);
    return { input, out, wrap, unit, get value() {
      return Number(input.value);
    }, set(v: number) {
      input.value = String(v);
      out.textContent = `${input.value}${unit}`;
    } };
  };
  const size = range('Size', 1, 400, 8, ' px', 'Brush and line size ([ and ] change it)');
  const hardness = range('Hardness', 0, 100, 100, '%', 'How sharp the brush edge is (0 = soft all the way)');
  const opacity = range('Opacity', 1, 100, 100, '%', 'How strongly the tool paints');
  const spacing = range('Spacing', 1, 100, 10, '%', 'How far apart the brush touches along a stroke (as a share of its size)');
  const fillBox = h('input', { type: 'checkbox', 'aria-label': 'Filled shape' });
  const fillLabel = h('label', { class: 'pe-opt' }, fillBox, 'Filled');
  const tolerance = range('Tolerance', 0, 255, 32, '', 'How different a colour may be and still count');
  const joined = h('input', { type: 'checkbox', checked: true, 'aria-label': 'Joined areas only' });
  const joinedLabel = h('label', { class: 'pe-opt', title: 'Untick to pick every pixel of that colour, wherever it is' }, joined, 'Joined areas only');
  const featherBox = h('input', { type: 'number', class: 'field num', min: 0, max: 200, value: 0, 'aria-label': 'Soft edge (pixels)' });
  const featherLabel = h('label', { class: 'pe-opt', title: 'Softens the edge of each new selection by this many pixels' }, 'Soft edge', featherBox);
  const gradShape = h('select', { class: 'field', 'aria-label': 'Gradient shape' }, h('option', { value: 'linear' }, 'Straight'), h('option', { value: 'radial' }, 'Round'));
  const gradClear = h('input', { type: 'checkbox', 'aria-label': 'To see-through' });
  const gradLabel = h('span', { class: 'pe-opt' }, gradShape, h('label', { class: 'pe-opt' }, gradClear, 'To see-through'));
  const dodgeMode = h('select', { class: 'field', 'aria-label': 'Dodge or burn' }, h('option', { value: 'dodge' }, 'Dodge (lighten)'), h('option', { value: 'burn' }, 'Burn (darken)'));
  const blurMode = h('select', { class: 'field', 'aria-label': 'Blur or sharpen' }, h('option', { value: 'blur' }, 'Blur'), h('option', { value: 'sharpen' }, 'Sharpen'));
  const hint = h('span', { class: 'pe-hint' });
  const cropApply = tool$('Crop to the box', 'Crop (Enter)');
  const cropCancel = tool$('Cancel', 'Cancel (Escape)');
  const cropBar = h('span', { class: 'pe-opt pe-cropbar', hidden: true }, cropApply, cropCancel);
  const xfApply = tool$('Apply', 'Apply the move (Enter)');
  const xfCancel = tool$('Cancel', 'Put it back (Escape)');
  const xfBar = h('span', { class: 'pe-opt pe-cropbar', hidden: true }, xfApply, xfCancel);
  const options = h('div', { class: 'toolbar pe-options' }, colour, swapBtn, colour2, size.wrap, hardness.wrap, opacity.wrap, spacing.wrap, fillLabel,
    tolerance.wrap, joinedLabel, featherLabel, gradLabel, dodgeMode, blurMode, cropBar, xfBar, hint);

  const status = h('div', { class: 'statusbar pe-status', role: 'status' });
  const where = h('span', { class: 'pe-where' });

  // ---- Layers ----
  const panel = layersPanel(doc, {
    activate: layer => {
      settle();
      doc.active = layer;
      panel.refresh();
      refresh();
    },
    add: () => addLayer(),
    duplicate: () => duplicateLayer(),
    remove: () => deleteLayer(),
    raise: () => shiftLayer(1),
    lower: () => shiftLayer(-1),
    mergeDown: () => mergeDown(),
    rename: layer => void renameLayer(layer),
    setVisible: (layer, visible) => {
      settle();
      doc.setMeta(visible ? 'Show layer' : 'Hide layer', layer, { visible });
    },
    setOpacity: (layer, value, from) => {
      settle();
      layer.opacity = from;
      if (value !== from) doc.setMeta('Layer opacity', layer, { opacity: value });
      else doc.render();
    },
    setMode: (layer, mode) => {
      settle();
      doc.setMeta('Blend mode', layer, { mode });
    },
    setLocked: (layer, locked) => doc.setMeta(locked ? 'Lock layer' : 'Unlock layer', layer, { locked }),
    moveTo: (layer, index) => {
      settle();
      const from = doc.indexOf(layer);
      if (from === index) return;
      doc.setLayers('Move layer', moveItem(doc.layers, from, index), layer);
    },
  }, app.signal);

  app.root.replaceChildren(
    h('div', { class: 'toolbar pe-top' }, newBtn, openBtn, saveBtn, saveAsBtn, h('span', { class: 'tool-gap' }), undoBtn, redoBtn,
      h('span', { class: 'tool-gap' }), editMenu, imageMenu, layerMenu, selectMenu, colourMenu, filterBtn, helpMenu,
      h('span', { class: 'tool-gap' }), rotL, rotR, flipH, flipV, h('span', { class: 'tool-gap' }), zoomOut, zoomFit, zoom100, zoomIn, layersToggle),
    options, h('div', { class: 'pe-body' }, palette, stage, panel.el), h('div', { class: 'pe-foot' }, status, where));

  // ---- Showing ----
  function paintZoom() {
    const w = Math.max(1, Math.round(doc.width * zoom));
    const hgt = Math.max(1, Math.round(doc.height * zoom));
    for (const c of [display, over]) css(c, { width: w, height: hgt });
    css(sheet, { width: w, height: hgt });
    // Big zoom shows the pixels; small zoom smooths them.
    display.classList.toggle('pixelated', zoom >= 2);
    drawOverlay();
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
    undoBtn.disabled = doc.history.undoList.length === 0;
    redoBtn.disabled = doc.history.redoList.length === 0;
    undoBtn.title = doc.history.undoList.length ? `Undo ${doc.history.undoList[doc.history.undoList.length - 1].label} (Ctrl+Z)` : 'Undo (Ctrl+Z)';
    redoBtn.title = doc.history.redoList.length ? `Redo ${doc.history.redoList[doc.history.redoList.length - 1].label} (Ctrl+Y)` : 'Redo (Ctrl+Y)';
    const name = path ? baseName(path) : 'Untitled.png';
    app.setTitle(`${name}${dirty ? ' *' : ''} - Photo Editor`);
    app.setDirty(dirty);
    const layers = doc.layers.length > 1 ? `  ·  ${doc.layers.length} layers, on “${doc.active.name}”` : '';
    status.textContent = `${name}  ·  ${doc.width} × ${doc.height} pixels${layers}  ·  ${Math.round(zoom * 100)}%${dirty ? '  ·  not saved' : ''}`;
  }
  function note(text: string) {
    hint.textContent = text;
  }

  doc.onStep = () => {
    dirty = true;
    edits++;
    refresh();
  };
  doc.onChange = what => {
    if (what === 'size') {
      over.width = doc.width;
      over.height = doc.height;
      [strokeCanvas, strokeCtx] = makeCanvas(doc.width, doc.height);
      cropBox = null;
      cropBar.hidden = true;
      antsPath = null;
      fit();
      panel.refresh();
    } else if (what === 'layers') {
      panel.refresh();
      refresh();
    } else if (what === 'selection') {
      antsPath = null;
      drawOverlay();
    } else panel.refreshThumbs();
  };

  // ---- The outline layer: marching ants, boxes, handles ----
  let antsPath: Path2D | null = null;
  let antsPhase = 0;
  /** What the current tool draws over the picture (a box being dragged, a lasso, handles). */
  let preview: ((c: CanvasRenderingContext2D, px: number) => void) | null = null;
  function drawOverlay() {
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, over.width, over.height);
    const px = 1 / zoom;
    if (doc.edges.length) {
      if (!antsPath) {
        antsPath = new Path2D();
        const e = doc.edges;
        for (let i = 0; i < e.length; i += 4) {
          antsPath.moveTo(e[i], e[i + 1]);
          antsPath.lineTo(e[i + 2], e[i + 3]);
        }
      }
      octx.lineWidth = px;
      octx.strokeStyle = '#000000';
      octx.setLineDash([]);
      octx.stroke(antsPath);
      octx.strokeStyle = '#ffffff';
      octx.setLineDash([4 * px, 4 * px]);
      octx.lineDashOffset = -antsPhase * px;
      octx.stroke(antsPath);
      octx.setLineDash([]);
    }
    preview?.(octx, px);
  }
  const ants = window.setInterval(() => {
    // A selection with a huge outline (a magic wand on a noisy photo) is drawn once, not animated.
    if (!doc.edges.length || doc.edges.length > 400_000 || !app.root.isConnected) return;
    antsPhase = (antsPhase + 1) % 8;
    drawOverlay();
  }, 200);
  app.signal.addEventListener('abort', () => clearInterval(ants));

  // ---- Undo ----
  function undo() {
    if (xf) return cancelTransform();
    if (lasso) return endLasso();
    doc.cancelPending();
    if (doc.history.undo()) changed();
  }
  function redo() {
    settle();
    if (doc.history.redo()) changed();
  }
  function changed() {
    dirty = true;
    edits++;
    panel.refresh();
    refresh();
  }

  // ---- Opening and saving ----
  function blank(w: number, hgt: number, white: boolean) {
    const layer = makeLayer(w, hgt, 'Background');
    if (white) {
      layer.ctx.fillStyle = '#ffffff';
      layer.ctx.fillRect(0, 0, w, hgt);
    }
    xf = null;
    cropBox = null;
    lasso = null;
    preview = null;
    doc.reset(w, hgt, [layer]);
    path = null;
    loadedId = '';
    dirty = false;
    flatAgreed.clear();
    panel.refresh();
    fit();
  }

  async function decode(bytes: Uint8Array, name: string): Promise<CanvasImageSource & { width: number; height: number }> {
    const type = mediaTypeOf(name) ?? (name.toLowerCase().endsWith('.png') ? 'image/png' : 'application/octet-stream');
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
  const closeImage = (img: CanvasImageSource) => {
    if ('close' in img && typeof img.close === 'function') img.close();
  };

  async function openOraFile(bytes: Uint8Array): Promise<boolean> {
    const ora = await openOra(bytes);
    const { width: w, height: hgt } = ora.stack;
    const layers: Layer[] = [];
    // The file lists the top layer first; the editor keeps the bottom first.
    for (const l of [...ora.stack.layers].reverse()) {
      const layer = makeLayer(w, hgt, l.name, { visible: l.visible, opacity: l.opacity, mode: l.mode, locked: l.locked, text: l.text ?? null });
      const img = await decode(await ora.layerPng(l), 'layer.png');
      layer.ctx.drawImage(img, Math.round(l.x), Math.round(l.y));
      closeImage(img);
      layers.push(layer);
    }
    xf = null;
    doc.reset(w, hgt, layers);
    if (ora.notes.length) await shell.dialogs.alert('Opened, with changes', `Photo Editor opened this layered picture, but:\n\n• ${ora.notes.join('\n• ')}`);
    return true;
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
      if (extensionOf(entry.name) === 'ora') {
        await openOraFile(bytes);
      } else {
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
          closeImage(img);
          await shell.dialogs.alert('Too many pixels', `This picture is ${w} × ${hgt} pixels. Photo Editor opens pictures up to ${MAX_PIXELS / 1e6} million pixels, so it does not run out of memory. It is safe where it is.`);
          return false;
        }
        const layer = makeLayer(w, hgt, 'Background');
        layer.ctx.drawImage(img, 0, 0, w, hgt);
        closeImage(img);
        xf = null;
        doc.reset(w, hgt, [layer]);
      }
      path = p;
      loadedId = entry.id;
      dirty = false;
      flatAgreed.clear();
      panel.refresh();
      fit();
      return true;
    } catch (error) {
      await shell.dialogs.alert('Could not open that', error instanceof Error && error.message === 'gone'
        ? 'That file is not there any more. It may have been moved or deleted.'
        : error instanceof OraProblem
          ? `“${baseName(p)}” could not be opened as a layered picture. ${error.message} It is safe where it is.`
          : `“${baseName(p)}” could not be read as a picture. It may be damaged, or a kind this browser does not know. It is safe where it is.`);
      refresh();
      return false;
    }
  }

  const toPng = async (c: HTMLCanvasElement, type = 'image/png', quality?: number): Promise<Uint8Array> => {
    const blob = await new Promise<Blob | null>(resolve => c.toBlob(resolve, type, quality));
    if (!blob) throw new Error('The picture could not be turned into a file (it may be too big for this browser).');
    return new Uint8Array(await blob.arrayBuffer());
  };

  async function encode(ext: string): Promise<Uint8Array> {
    const type = SAVE_TYPES[ext] ?? 'image/png';
    if (type === 'image/openraster') {
      const top = [...doc.layers].reverse();
      const layers: OraLayer[] = top.map((l, i) => ({
        name: l.name, src: `data/layer${top.length - 1 - i}.png`, x: 0, y: 0, opacity: l.opacity, visible: l.visible, locked: l.locked, mode: l.mode,
        ...(l.text ? { text: l.text } : {}),
      }));
      const pngs: Uint8Array[] = [];
      for (const l of top) pngs.push(await toPng(l.canvas));
      const flat = doc.flatten();
      const [tw, th] = thumbSize(doc.width, doc.height);
      const [tc, tx] = makeCanvas(tw, th);
      tx.imageSmoothingQuality = 'high';
      tx.drawImage(flat, 0, 0, tw, th);
      return buildOra({ stack: { width: doc.width, height: doc.height, layers }, layerPngs: pngs, merged: await toPng(flat), thumbnail: await toPng(tc) });
    }
    let source = doc.flatten();
    if (type === 'image/jpeg') {
      // JPEG has no see-through parts: put the picture on white first, as other editors do.
      const [c, x] = makeCanvas(doc.width, doc.height);
      x.fillStyle = '#ffffff';
      x.fillRect(0, 0, doc.width, doc.height);
      x.drawImage(source, 0, 0);
      source = c;
    }
    return toPng(source, type, 0.92);
  }

  /** A flat file drops the layers: asked once per file name. False = do not save. */
  async function flatOk(dest: string): Promise<boolean | 'ora'> {
    if (extensionOf(dest) === 'ora' || flatAgreed.has(dest)) return true;
    const extra = doc.layers.length > 1 || doc.layers.some(l => l.text || l.mode !== 'normal' || !l.visible);
    if (!extra) return true;
    const answer = await shell.dialogs.ask<'flat' | 'ora' | 'no'>({
      title: 'Layers are not kept in this file',
      text: `A .${extensionOf(dest)} file holds one flat picture. “${baseName(dest)}” will have this picture as you see it, with its ${doc.layers.length} layer${doc.layers.length === 1 ? '' : 's'} joined, and text no longer editable. To keep the layers, save a copy as .ora (OpenRaster; GIMP and Krita open it too).`,
      buttons: [{ label: 'Save flat', value: 'flat', primary: true }, { label: 'Save as .ora instead...', value: 'ora' }, { label: 'Cancel', value: 'no' }],
      cancel: 'no',
    });
    if (answer === 'flat') flatAgreed.add(dest);
    return answer === 'flat' ? true : answer === 'ora' ? 'ora' : false;
  }

  async function saveAs(preferOra = false): Promise<boolean> {
    settle();
    const [stem, ext] = splitExtension(path ? baseName(path) : 'Untitled.png');
    const layered = doc.layers.length > 1 || doc.layers.some(l => l.text);
    const keep = preferOra || (layered && !path) ? '.ora' : SAVE_TYPES[ext.slice(1).toLowerCase()] ? ext : '.png';
    const target = await pickSave(shell, { title: 'Save picture as (.png, .jpg, .webp, or .ora to keep the layers)', folder: path ? parentPath(path) : '/Pictures', name: stem + keep, accept: OPEN_EXTS });
    if (!target) return false;
    let dest = target.path;
    let replace = target.replace;
    if (!SAVE_TYPES[extensionOf(dest)]) {
      dest += layered ? '.ora' : '.png';
      replace = !!(await shell.fs.stat(dest).catch(() => null));
      if (replace && !(await shell.dialogs.confirm({ title: 'Replace it?', text: `“${baseName(dest)}” already exists. Replace it?`, ok: 'Replace', danger: true }))) return false;
    }
    const flat = await flatOk(dest);
    if (flat === 'ora') return saveAs(true);
    if (!flat) return false;
    return write(dest, replace ? 'any' : 'new');
  }

  /** `how`: 'new' = the name must be free; 'any' = replace whatever is there; 'opened' = replace only the copy opened. */
  async function write(dest: string, how: 'new' | 'any' | 'opened'): Promise<boolean> {
    try {
      const before = edits;
      const data = await encode(extensionOf(dest));
      const entry = how === 'opened'
        ? await saveOver(shell, dest, data, loadedId)
        : await shell.fs.writeFile(dest, data, how === 'new' ? { mustBeNew: true } : {});
      if (!entry) return false;
      path = dest;
      loadedId = entry.id;
      if (edits === before) dirty = false;
      refresh();
      shell.toast(`Saved “${entry.name}” (${formatSize(entry.size)}).`);
      return true;
    } catch (error) {
      await shell.report('Could not save the picture', error);
      return false;
    }
  }

  async function save(): Promise<boolean> {
    settle();
    if (!path || !SAVE_TYPES[extensionOf(path)]) {
      if (path) await shell.dialogs.alert('Saved as a new file', `Photo Editor saves PNG, JPEG, WebP and OpenRaster (.ora). “${baseName(path)}” stays as it is; choose a name for the edited copy.`);
      return saveAs();
    }
    const flat = await flatOk(path);
    if (flat === 'ora') return saveAs(true);
    if (!flat) return false;
    return write(path, 'opened');
  }

  async function guard(): Promise<boolean> {
    if (!dirty) return true;
    return shell.dialogs.confirm({ title: 'Not saved', text: 'This picture has changes that are not saved. Carry on and lose them?', ok: 'Lose the changes', danger: true, cancel: 'Keep editing' });
  }

  // ---- Tools ----
  function setTool(t: Tool) {
    if (t !== tool) {
      settle();
      if (tool === 'crop') endCrop();
    }
    tool = t;
    for (const [id, b] of toolButtons) b.setAttribute('aria-pressed', String(id === t));
    stage.dataset.tool = t;
    const show = (el: HTMLElement, yes: boolean) => (el.hidden = !yes);
    const brushy = PAINT_TOOLS.includes(t);
    show(size.wrap, brushy || SHAPES.includes(t));
    show(hardness.wrap, brushy);
    show(spacing.wrap, brushy);
    show(opacity.wrap, brushy || SHAPES.includes(t) || t === 'gradient' || t === 'fill');
    opacity.wrap.firstChild!.textContent = RETOUCH.includes(t) ? 'Strength' : 'Opacity';
    show(fillLabel, t === 'rect' || t === 'ellipse');
    show(tolerance.wrap, t === 'fill' || t === 'wand');
    show(joinedLabel, t === 'wand');
    show(featherLabel, SELECTS.includes(t));
    show(gradLabel, t === 'gradient');
    show(dodgeMode, t === 'dodge');
    show(blurMode, t === 'blur');
    show(colour2, t === 'gradient' || brushy || SHAPES.includes(t) || t === 'fill' || t === 'text' || t === 'picker');
    show(swapBtn, !colour2.hidden);
    cropBar.hidden = true;
    if (!xf && !lasso && !cropBox) preview = (t === 'clone' || t === 'heal') && cloneSrc ? cloneMarker : null;
    note(t === 'clone' || t === 'heal' ? (cloneSrc ? 'Paint to copy. Alt+click to choose a new place to copy from.' : 'First Alt+click (or Ctrl+click) where to copy from.')
      : SELECTS.includes(t) ? (t === 'lasso' ? 'Drag freely, or click corner by corner and double-click to close. ' : '') + 'Shift adds, Alt takes away.'
        : t === 'move' ? (doc.active.text ? 'Drag to move the text. Layer > Text to pixels lets you stretch or turn it.' : 'Drag inside to move, the squares to stretch (Shift keeps the shape), outside to turn. Enter applies.')
          : t === 'text' ? 'Click to write; click on a text layer\'s words to change them.' : '');
    drawOverlay();
  }

  const toImage = (e: PointerEvent | MouseEvent): Point => {
    const r = display.getBoundingClientRect();
    return { x: ((e.clientX - r.left) * doc.width) / r.width, y: ((e.clientY - r.top) * doc.height) / r.height };
  };

  /** May the active layer be changed? A locked layer says no; a text layer becomes pixels first (said once). */
  function editable(layer = doc.active, keepText = false): boolean {
    if (layer.locked) {
      note(`“${layer.name}” is locked. Untick Locked in the Layers panel to change it.`);
      shell.toast(`“${layer.name}” is locked.`);
      return false;
    }
    if (layer.text && !keepText) {
      doc.setMeta('Text to pixels', layer, { text: null });
      shell.toast(`“${layer.name}” is now pixels: its words can no longer be edited (Undo brings that back).`);
    }
    return true;
  }

  // Brush tips: one small picture per size / hardness / colour, stamped along the stroke.
  let tipKey = '';
  let tip: HTMLCanvasElement | null = null;
  function brushTip(diameter: number, hard: number, rgb: string): HTMLCanvasElement {
    const key = `${diameter}|${hard}|${rgb}`;
    if (tip && key === tipKey) return tip;
    const s = Math.max(1, Math.ceil(diameter));
    const [c, x] = makeCanvas(s, s);
    const r = diameter / 2;
    if (hard >= 1) {
      x.fillStyle = rgb;
      x.beginPath();
      x.arc(s / 2, s / 2, Math.max(0.5, r), 0, Math.PI * 2);
      x.fill();
    } else {
      const [cr, cg, cb] = hexToRgba(rgb);
      const g = x.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, Math.max(0.5, r));
      g.addColorStop(0, `rgba(${cr},${cg},${cb},1)`);
      g.addColorStop(Math.max(0.01, hard), `rgba(${cr},${cg},${cb},1)`);
      g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      x.fillStyle = g;
      x.fillRect(0, 0, s, s);
    }
    tip = c;
    tipKey = key;
    return c;
  }

  const pressureOf = (e: PointerEvent) => (e.pointerType === 'pen' && e.pressure > 0 ? Math.max(0.1, e.pressure) : 1);

  /** The tiles a stroke has touched, so undo keeps only those. */
  let touched: Rect[] = [];
  const tileSet = new Set<number>();
  function markTouched(r: Rect) {
    const c = clipRect(r, doc.width, doc.height);
    if (!c) return;
    const cols = Math.ceil(doc.width / TILE);
    for (let ty = Math.floor(c.y / TILE); ty <= Math.floor((c.y + c.h - 1) / TILE); ty++) {
      for (let tx = Math.floor(c.x / TILE); tx <= Math.floor((c.x + c.w - 1) / TILE); tx++) {
        const i = ty * cols + tx;
        if (tileSet.has(i)) continue;
        tileSet.add(i);
        touched.push({ x: tx * TILE, y: ty * TILE, w: TILE, h: TILE });
      }
    }
  }

  let queuedRect: Rect | null = null;
  function queueRender(r: Rect | null) {
    if (!r) return;
    const first = !queuedRect;
    queuedRect = unionRect(queuedRect, r);
    if (first) requestAnimationFrame(() => {
      const q = queuedRect;
      queuedRect = null;
      doc.render(q);
    });
  }

  // ---- Brush and eraser (drawn into a stroke canvas, joined to the layer when the stroke ends) ----
  let stroke: { path: DabPath; diameter: number } | null = null;
  function strokeTo(p: Point, pressure: number) {
    const pend = doc.pending;
    if (!stroke || !pend) return;
    const d = stroke.diameter * pressure;
    const t = brushTip(stroke.diameter, hardness.value / 100, tool === 'eraser' ? '#000000' : colour.value);
    let dirty: Rect | null = null;
    for (const q of stroke.path.to(p.x, p.y)) {
      const r = { x: q.x - d / 2, y: q.y - d / 2, w: d, h: d };
      strokeCtx.drawImage(t, r.x, r.y, d, d);
      const box = { x: Math.floor(r.x) - 1, y: Math.floor(r.y) - 1, w: Math.ceil(d) + 3, h: Math.ceil(d) + 3 };
      markTouched(box);
      dirty = unionRect(dirty, box);
    }
    pend.bounds = unionRect(pend.bounds, dirty);
    queueRender(dirty);
  }

  // ---- Shapes and gradients (redrawn on every move into the stroke canvas) ----
  function constrain(kind: Tool, a: Point, b: Point, shift: boolean): Point {
    if (!shift) return b;
    if (kind === 'rect' || kind === 'ellipse') {
      const s = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
      return { x: a.x + Math.sign(b.x - a.x || 1) * s, y: a.y + Math.sign(b.y - a.y || 1) * s };
    }
    const ang = Math.round(Math.atan2(b.y - a.y, b.x - a.x) / (Math.PI / 12)) * (Math.PI / 12);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    return { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len };
  }
  function drawShape(c: CanvasRenderingContext2D, kind: Tool, a: Point, b: Point): Rect {
    const lw = size.value;
    c.save();
    c.strokeStyle = c.fillStyle = colour.value;
    c.lineWidth = lw;
    c.lineCap = c.lineJoin = 'round';
    c.beginPath();
    let pad = lw;
    if (kind === 'line' || kind === 'arrow') {
      c.moveTo(a.x, a.y);
      c.lineTo(b.x, b.y);
      c.stroke();
      if (kind === 'arrow') {
        const ang = Math.atan2(b.y - a.y, b.x - a.x);
        const head = Math.max(10, lw * 3);
        pad = head + lw;
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
    return { x: Math.floor(Math.min(a.x, b.x) - pad), y: Math.floor(Math.min(a.y, b.y) - pad), w: Math.ceil(Math.abs(b.x - a.x) + 2 * pad) + 1, h: Math.ceil(Math.abs(b.y - a.y) + 2 * pad) + 1 };
  }
  function drawGradient(c: CanvasRenderingContext2D, a: Point, b: Point) {
    const [r1, g1, b1] = hexToRgba(colour.value);
    const [r2, g2, b2] = hexToRgba(colour2.value);
    const end = gradClear.checked ? `rgba(${r1},${g1},${b1},0)` : `rgb(${r2},${g2},${b2})`;
    const g = gradShape.value === 'radial'
      ? c.createRadialGradient(a.x, a.y, 0, a.x, a.y, Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)))
      : c.createLinearGradient(a.x, a.y, b.x, b.y);
    g.addColorStop(0, `rgb(${r1},${g1},${b1})`);
    g.addColorStop(1, end);
    c.save();
    c.fillStyle = g;
    c.fillRect(0, 0, doc.width, doc.height);
    c.restore();
  }

  // ---- Retouching (works on the layer's pixels directly) ----
  let cloneSrc: Point | null = null;
  /** Where the clone stamp and healing copy from, shown while one of them is the tool. */
  const cloneMarker = (c: CanvasRenderingContext2D, px: number) => {
    if (!cloneSrc) return;
    c.strokeStyle = '#ffffff';
    c.lineWidth = 2 * px;
    c.beginPath();
    c.arc(cloneSrc.x, cloneSrc.y, Math.max(4 * px, size.value / 2), 0, Math.PI * 2);
    c.moveTo(cloneSrc.x - 6 * px, cloneSrc.y);
    c.lineTo(cloneSrc.x + 6 * px, cloneSrc.y);
    c.moveTo(cloneSrc.x, cloneSrc.y - 6 * px);
    c.lineTo(cloneSrc.x, cloneSrc.y + 6 * px);
    c.stroke();
  };
  let cloneOffset: Point | null = null;
  let retouch: { work: ImageData; source: { data: Uint8ClampedArray; width: number; height: number } | null; patch: PixelPatch; path: DabPath; carry: Carry | null; radius: number } | null = null;
  function retouchTo(p: Point, pressure: number) {
    if (!retouch) return;
    const rt = retouch;
    const pix = { data: rt.work.data, width: rt.work.width, height: rt.work.height };
    let dirty: Rect | null = null;
    const mask = doc.selection;
    for (const q of rt.path.to(p.x, p.y)) {
      const d: Dab = { x: q.x, y: q.y, radius: Math.max(0.5, rt.radius * pressure), hardness: hardness.value / 100, strength: opacity.value / 100 };
      const r = dabRect(d, doc.width, doc.height);
      if (!r) continue;
      rt.patch.touch(r);
      if (tool === 'clone' && rt.source && cloneOffset) cloneDab(pix, rt.source, cloneOffset.x, cloneOffset.y, d, mask);
      else if (tool === 'heal' && rt.source && cloneOffset) healDab(pix, rt.source, cloneOffset.x, cloneOffset.y, d, mask);
      else if (tool === 'smudge' && rt.carry) smudgeDab(pix, rt.carry, d, mask);
      else if (tool === 'dodge') dodgeBurnDab(pix, d, dodgeMode.value as 'dodge' | 'burn', mask);
      else if (tool === 'blur') blurSharpenDab(pix, d, blurMode.value as 'blur' | 'sharpen', mask);
      dirty = unionRect(dirty, r);
    }
    if (dirty) {
      doc.active.ctx.putImageData(rt.work, 0, 0, dirty.x, dirty.y, dirty.w, dirty.h);
      queueRender(dirty);
    }
    if (tool === 'clone' || tool === 'heal') drawOverlay();
  }

  // ---- Selections ----
  let selBox: { a: Point; b: Point; how: Combine } | null = null;
  /** `fresh`: the press that started it is still down (a drag then closes the shape when let go). */
  let lasso: { pts: Point[]; how: Combine; dragging: boolean; downAt: Point; fresh: boolean } | null = null;
  const howOf = (e: PointerEvent | MouseEvent): Combine => (e.shiftKey && e.altKey ? 'intersect' : e.shiftKey ? 'add' : e.altKey ? 'subtract' : 'replace');
  function finishSelection(shape: Mask, how: Combine, label: string) {
    const soft = Number(featherBox.value) || 0;
    const m = soft > 0 ? feather(shape, doc.width, doc.height, soft) : shape;
    doc.setSelection(label, combine(doc.selection, m, how));
  }
  function endLasso() {
    lasso = null;
    preview = null;
    drawOverlay();
  }
  function closeLasso() {
    if (!lasso) return;
    const l = lasso;
    endLasso();
    if (l.pts.length >= 3) finishSelection(polygonMask(doc.width, doc.height, l.pts), l.how, 'Lasso selection');
  }
  function showLasso(cursor: Point | null) {
    const l = lasso;
    preview = l ? (c, px) => {
      c.lineWidth = px;
      c.strokeStyle = '#000000';
      c.beginPath();
      l.pts.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
      if (cursor) c.lineTo(cursor.x, cursor.y);
      c.stroke();
      c.strokeStyle = '#ffffff';
      c.setLineDash([4 * px, 4 * px]);
      c.stroke();
      c.setLineDash([]);
      const s = l.pts[0];
      c.strokeRect(s.x - 4 * px, s.y - 4 * px, 8 * px, 8 * px);
    } : null;
    drawOverlay();
  }

  // ---- Crop (the whole picture, every layer) ----
  let cropBox: { x: number; y: number; w: number; h: number } | null = null;
  const normal = (b: { x: number; y: number; w: number; h: number }) => {
    const x = Math.max(0, Math.min(b.x, b.x + b.w)), y = Math.max(0, Math.min(b.y, b.y + b.h));
    return { x: Math.round(x), y: Math.round(y), w: Math.round(Math.min(doc.width - x, Math.abs(b.w))), h: Math.round(Math.min(doc.height - y, Math.abs(b.h))) };
  };
  function showCrop() {
    preview = cropBox ? (c, px) => {
      const { x, y, w, h: hh } = normal(cropBox!);
      c.fillStyle = 'rgba(0, 0, 0, 0.45)';
      c.fillRect(0, 0, over.width, y);
      c.fillRect(0, y + hh, over.width, over.height - y - hh);
      c.fillRect(0, y, x, hh);
      c.fillRect(x + w, y, over.width - x - w, hh);
      c.strokeStyle = '#ffffff';
      c.lineWidth = px;
      c.setLineDash([6 * px, 4 * px]);
      c.strokeRect(x, y, w, hh);
      c.setLineDash([]);
      where.textContent = `Crop ${w} × ${hh}`;
    } : null;
    drawOverlay();
  }
  function endCrop() {
    cropBox = null;
    // The crop buttons hide, so keep the keyboard in this window (Ctrl+S, the tool keys).
    if (cropBar.contains(document.activeElement)) stage.focus({ preventScroll: true });
    cropBar.hidden = true;
    if (tool === 'crop') preview = null;
    drawOverlay();
  }
  function applyCrop() {
    if (!cropBox) return;
    const b = normal(cropBox);
    endCrop();
    if (b.w < 1 || b.h < 1) return;
    cropTo(b, 'Crop');
  }
  function cropTo(b: Rect, label: string) {
    const canvases = new Map<Layer, HTMLCanvasElement>();
    const texts = new Map<Layer, TextSpec | null>();
    for (const l of doc.layers) {
      const [c, x] = makeCanvas(b.w, b.h);
      x.drawImage(l.canvas, -b.x, -b.y);
      canvases.set(l, c);
      texts.set(l, l.text ? { ...l.text, x: l.text.x - b.x, y: l.text.y - b.y } : null);
    }
    const sel = doc.selection ? cropMask(doc.selection, doc.width, b, b.w, b.h) : null;
    doc.replaceCanvases(label, b.w, b.h, canvases, sel, texts);
  }

  // ---- Move / stretch / turn ----
  let xf: { layer: Layer; orig: HTMLCanvasElement; base: HTMLCanvasElement; content: HTMLCanvasElement; box0: Box; box: Box; from: Rect; sel: Mask | null; drag: { handle: Handle; at: Point; start: Box } | null } | null = null;
  let textDrag: { layer: Layer; spec: TextSpec; at: Point } | null = null;

  function alphaBounds(c: HTMLCanvasElement): Rect | null {
    const d = c.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height).data;
    let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
    for (let y = 0; y < c.height; y++) {
      const row = y * c.width * 4;
      for (let x = 0; x < c.width; x++) if (d[row + x * 4 + 3]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
    return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  function startTransform(): boolean {
    const layer = doc.active;
    if (!editable(layer)) return false;
    const r = doc.selBounds ?? alphaBounds(layer.canvas);
    if (!r) {
      note('This layer is empty here: nothing to move.');
      return false;
    }
    const [orig, ox] = makeCanvas(doc.width, doc.height);
    ox.drawImage(layer.canvas, 0, 0);
    const [base, bx] = makeCanvas(doc.width, doc.height);
    const sel = doc.selectionCanvas();
    if (sel) {
      bx.drawImage(layer.canvas, 0, 0);
      bx.globalCompositeOperation = 'destination-out';
      bx.drawImage(sel, 0, 0);
    }
    const content = doc.selectedPixels(layer)!.canvas;
    if (!sel) {
      const [c, cx] = makeCanvas(r.w, r.h);
      cx.drawImage(layer.canvas, -r.x, -r.y);
      xf = { layer, orig, base, content: c, box0: { cx: r.x + r.w / 2, cy: r.y + r.h / 2, w: r.w, h: r.h, angle: 0 }, box: { cx: r.x + r.w / 2, cy: r.y + r.h / 2, w: r.w, h: r.h, angle: 0 }, from: r, sel: null, drag: null };
    } else {
      xf = { layer, orig, base, content, box0: { cx: r.x + r.w / 2, cy: r.y + r.h / 2, w: r.w, h: r.h, angle: 0 }, box: { cx: r.x + r.w / 2, cy: r.y + r.h / 2, w: r.w, h: r.h, angle: 0 }, from: r, sel: doc.selection, drag: null };
    }
    xfBar.hidden = false;
    showTransform();
    return true;
  }
  function drawTransformed(c: CanvasRenderingContext2D, src: HTMLCanvasElement, b: Box) {
    c.save();
    c.translate(b.cx, b.cy);
    c.rotate(b.angle);
    c.imageSmoothingQuality = 'high';
    c.drawImage(src, -b.w / 2, -b.h / 2, b.w, b.h);
    c.restore();
  }
  function paintTransform(prev: Box) {
    if (!xf) return;
    const c = xf.layer.ctx;
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = 'copy';
    c.drawImage(xf.base, 0, 0);
    c.restore();
    drawTransformed(c, xf.content, xf.box);
    doc.render(unionRect(unionRect(boxBounds(prev), boxBounds(xf.box)), xf.from));
  }
  function showTransform() {
    const x = xf;
    preview = x ? (c, px) => {
      const pts = corners(x.box);
      c.lineWidth = px;
      c.strokeStyle = '#1d4fb8';
      c.beginPath();
      pts.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
      c.closePath();
      c.stroke();
      c.fillStyle = '#ffffff';
      for (const hnd of HANDLES) {
        const p = handlePoint(x.box, hnd);
        c.fillRect(p.x - 4 * px, p.y - 4 * px, 8 * px, 8 * px);
        c.strokeRect(p.x - 4 * px, p.y - 4 * px, 8 * px, 8 * px);
      }
      const b = x.box;
      where.textContent = `${Math.round(b.w)} × ${Math.round(b.h)}  ·  ${Math.round(((b.angle * 180) / Math.PI) % 360)}°`;
    } : null;
    drawOverlay();
  }
  function commitTransform() {
    const x = xf;
    if (!x) return;
    xf = null;
    xfBar.hidden = true;
    preview = null;
    if (isIdentity(x.box, x.box0)) {
      // Nothing moved: put the exact pixels back (drawing at the same place could still smooth them).
      const c = x.layer.ctx;
      c.save();
      c.globalCompositeOperation = 'copy';
      c.drawImage(x.orig, 0, 0);
      c.restore();
      doc.render(x.from);
      drawOverlay();
      return;
    }
    const touchedRect = unionRect(x.from, boxBounds(x.box))!;
    const patch = new PixelPatch(surfaceOf(x.orig.getContext('2d', { willReadFrequently: true })!));
    patch.touch(touchedRect);
    patch.surface = surfaceOf(x.layer.ctx);
    const steps = [doc.pixelStep('Move', x.layer, patch)];
    if (x.sel) {
      // The selection follows what was moved.
      const sel = doc.selectionCanvas();
      if (sel) {
        const [mc, mx] = makeCanvas(x.from.w, x.from.h);
        mx.drawImage(sel, -x.from.x, -x.from.y);
        const [, tx] = makeCanvas(doc.width, doc.height);
        drawTransformed(tx, mc, x.box);
        const a = tx.getImageData(0, 0, doc.width, doc.height).data;
        const m = new Uint8Array(doc.width * doc.height);
        for (let i = 0; i < m.length; i++) m[i] = a[i * 4 + 3];
        steps.push(doc.selectionStep(m));
        steps[1].redo();
      }
    }
    doc.push(steps.length > 1 ? group('Move', steps) : steps[0]);
    doc.onChange('pixels', touchedRect);
    drawOverlay();
  }
  function cancelTransform() {
    const x = xf;
    if (!x) return;
    xf = null;
    xfBar.hidden = true;
    preview = null;
    const c = x.layer.ctx;
    c.save();
    c.globalCompositeOperation = 'copy';
    c.drawImage(x.orig, 0, 0);
    c.restore();
    doc.render();
    drawOverlay();
  }

  /** Finishes whatever is half done (a move, a lasso) before another command. */
  function settle() {
    if (xf) commitTransform();
    if (lasso) endLasso();
    if (doc.pending) doc.cancelPending();
  }

  // ---- Text ----
  async function askText(spec: TextSpec | null, at: Point): Promise<TextSpec | null> {
    const t: TextSpec = spec ?? { text: '', family: FONT_FAMILIES[0][0], size: 32, colour: colour.value, bold: false, italic: false, align: 'left', x: Math.round(at.x), y: Math.round(at.y) };
    const words = h('textarea', { class: 'field pe-textarea', rows: 4, 'aria-label': 'Words' }, t.text);
    const family = h('select', { class: 'field', 'aria-label': 'Font' }, ...FONT_FAMILIES.map(([name]) => h('option', { value: name, selected: name === t.family }, name)));
    const sizeIn = h('input', { type: 'number', class: 'field num', min: 4, max: 2000, value: t.size, 'aria-label': 'Text size' });
    const col = h('input', { type: 'color', value: t.colour, 'aria-label': 'Text colour' });
    const bold = h('input', { type: 'checkbox', checked: t.bold, 'aria-label': 'Bold' });
    const italic = h('input', { type: 'checkbox', checked: t.italic, 'aria-label': 'Italic' });
    const align = h('select', { class: 'field', 'aria-label': 'Line up' }, ...([['left', 'Left'], ['center', 'Centre'], ['right', 'Right']] as const).map(([v, l]) => h('option', { value: v, selected: v === t.align }, l)));
    const ok = await shell.dialogs.ask({
      title: spec ? 'Change the text' : 'Text',
      body: h('div', { class: 'pe-form' }, words,
        h('div', { class: 'pe-row3' }, h('label', {}, 'Font ', family), h('label', {}, 'Size ', sizeIn)),
        h('div', { class: 'pe-row3' }, h('label', {}, 'Colour ', col), h('label', {}, bold, ' Bold'), h('label', {}, italic, ' Italic'), h('label', {}, 'Line up ', align))),
      buttons: [{ label: spec ? 'Change' : 'Add', value: true, primary: true }, { label: 'Cancel', value: false }],
      cancel: false,
      primaryEnabled: () => words.value.trim() !== '' && Number(sizeIn.value) >= 4 && Number(sizeIn.value) <= 2000,
      focus: () => words,
    });
    if (!ok) return null;
    return { ...t, text: words.value.slice(0, 10000), family: family.value, size: Math.round(Number(sizeIn.value)), colour: col.value, bold: bold.checked, italic: italic.checked, align: align.value as TextSpec['align'] };
  }
  async function textAt(p: Point) {
    settle();
    // On the words of a text layer: change them. Else a new text layer.
    const hit = [...doc.layers].reverse().find(l => {
      const b = l.visible && l.text ? textBounds(l) : null;
      return b && p.x >= b.x - 4 && p.x <= b.x + b.w + 4 && p.y >= b.y - 4 && p.y <= b.y + b.h + 4;
    });
    if (hit) {
      if (hit.locked) return void editable(hit);
      const spec = await askText(hit.text, p);
      if (!spec) return;
      doc.active = hit;
      doc.setMeta('Change text', hit, { text: spec, name: spec.text.split('\n')[0].slice(0, 40) || hit.name });
      return;
    }
    const why = noRoomForLayer(doc.width, doc.height, doc.layers.length);
    if (why) return void (await shell.dialogs.alert('No room for another layer', why));
    const spec = await askText(null, p);
    if (!spec) return;
    const layer = makeLayer(doc.width, doc.height, spec.text.split('\n')[0].slice(0, 40) || 'Text', { text: spec });
    paintText(layer);
    const at = doc.indexOf(doc.active) + 1;
    doc.setLayers('Add text', [...doc.layers.slice(0, at), layer, ...doc.layers.slice(at)], layer);
  }

  // ---- Pointer ----
  let drag: { start: Point; last: Point; moved: boolean; scroll?: { x: number; y: number; cx: number; cy: number } } | null = null;
  let spaceHeld = false;

  on(over, 'pointerdown', async (e: PointerEvent) => {
    if (e.button !== 0) return;
    // A canvas cannot take the keyboard itself; the picture area does, so the tool keys work after a click.
    stage.focus({ preventScroll: true });
    const p = toImage(e);
    const t = spaceHeld ? 'hand' : tool;
    if (t === 'hand') {
      drag = { start: p, last: p, moved: false, scroll: { x: stage.scrollLeft, y: stage.scrollTop, cx: e.clientX, cy: e.clientY } };
      over.setPointerCapture(e.pointerId);
      return;
    }
    if (t === 'picker') {
      const [r, g, b, a] = doc.display.getContext('2d')!.getImageData(Math.floor(p.x), Math.floor(p.y), 1, 1).data;
      if (a) (e.altKey ? colour2 : colour).value = rgbToHex(r, g, b);
      return;
    }
    if (t === 'text') return void textAt(p);
    if (t === 'fill') {
      if (!editable()) return;
      const r = doc.selBounds ?? doc.full;
      const alpha = opacity.value / 100;
      const [fr, fg, fb] = hexToRgba(colour.value);
      doc.changePixels('Fill', px => {
        const before = alpha < 1 ? px.data.slice() : null;
        const n = floodFill(px, p.x - r.x, p.y - r.y, [fr, fg, fb, 255], tolerance.value);
        if (n && before) for (let i = 0; i < px.data.length; i++) px.data[i] = before[i] + (px.data[i] - before[i]) * alpha;
      }, r);
      return;
    }
    if (t === 'wand') {
      settle();
      const layer = doc.active.ctx.getImageData(0, 0, doc.width, doc.height);
      finishSelection(wandMask({ data: layer.data, width: doc.width, height: doc.height }, p.x, p.y, tolerance.value, joined.checked), howOf(e), 'Magic wand');
      return;
    }
    if ((t === 'clone' || t === 'heal') && (e.altKey || e.ctrlKey)) {
      cloneSrc = { x: p.x, y: p.y };
      cloneOffset = null;
      setTool(t);
      return;
    }
    if (t === 'lasso') {
      if (!lasso) lasso = { pts: [p], how: howOf(e), dragging: true, downAt: p, fresh: true };
      else {
        const s = lasso.pts[0];
        if (lasso.pts.length >= 3 && Math.hypot(s.x - p.x, s.y - p.y) * zoom < 8) return closeLasso();
        lasso.pts.push(p);
        lasso.dragging = true;
        lasso.downAt = p;
      }
      over.setPointerCapture(e.pointerId);
      showLasso(null);
      return;
    }
    if (t === 'move') {
      if (doc.active.text && !doc.active.locked) {
        textDrag = { layer: doc.active, spec: { ...doc.active.text }, at: p };
        over.setPointerCapture(e.pointerId);
        return;
      }
      if (!xf && !startTransform()) return;
      const hnd = hitHandle(xf!.box, p, 7 / zoom);
      xf!.drag = { handle: hnd, at: p, start: { ...xf!.box } };
      over.setPointerCapture(e.pointerId);
      return;
    }
    over.setPointerCapture(e.pointerId);
    drag = { start: p, last: p, moved: false };
    if (t === 'crop') {
      cropBox = { x: p.x, y: p.y, w: 0, h: 0 };
      cropBar.hidden = true;
      return;
    }
    if (t === 'rselect' || t === 'eselect') {
      settle();
      selBox = { a: p, b: p, how: howOf(e) };
      return;
    }
    if (t === 'brush' || t === 'eraser') {
      if (!editable()) return void (drag = null);
      touched = [];
      tileSet.clear();
      doc.beginPending(strokeCanvas, opacity.value / 100, t === 'eraser' ? 'destination-out' : 'source-over');
      stroke = { path: new DabPath(Math.max(0.5, (size.value * spacing.value) / 100)), diameter: size.value };
      strokeTo(p, pressureOf(e));
      return;
    }
    if (SHAPES.includes(t) || t === 'gradient') {
      if (!editable()) return void (drag = null);
      touched = [];
      tileSet.clear();
      doc.beginPending(strokeCanvas, opacity.value / 100, 'source-over');
      return;
    }
    if (RETOUCH.includes(t)) {
      if ((t === 'clone' || t === 'heal') && !cloneSrc) {
        note('First Alt+click (or Ctrl+click) where to copy from.');
        shell.toast('Alt+click (or Ctrl+click) where to copy from first.');
        return void (drag = null);
      }
      if (!editable()) return void (drag = null);
      if ((t === 'clone' || t === 'heal') && cloneSrc && !cloneOffset) cloneOffset = { x: cloneSrc.x - p.x, y: cloneSrc.y - p.y };
      const work = doc.active.ctx.getImageData(0, 0, doc.width, doc.height);
      const pix = { data: work.data, width: work.width, height: work.height };
      retouch = {
        work, patch: new PixelPatch(surfaceOf(doc.active.ctx)), path: new DabPath(Math.max(0.5, (size.value * spacing.value) / 100)),
        source: t === 'clone' || t === 'heal' ? { data: work.data.slice(), width: work.width, height: work.height } : null,
        carry: t === 'smudge' ? makeCarry(pix, p.x, p.y, size.value / 2) : null, radius: size.value / 2,
      };
      retouchTo(p, pressureOf(e));
    }
  }, app.signal);

  function hoverCursor(p: Point) {
    if (tool !== 'move' || !xf || xf.drag) return css(over, { cursor: null });
    const hnd = hitHandle(xf.box, p, 7 / zoom);
    const cursors: Record<Handle, string> = { move: 'move', rotate: 'alias', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' };
    css(over, { cursor: cursors[hnd] });
  }

  on(over, 'pointermove', (e: PointerEvent) => {
    const p = toImage(e);
    if (!xf?.drag) where.textContent = `${Math.floor(p.x)}, ${Math.floor(p.y)}`;
    hoverCursor(p);
    if (lasso) {
      const l = lasso;
      if (l.dragging && e.buttons & 1) {
        const last = l.pts[l.pts.length - 1];
        if (Math.hypot(last.x - p.x, last.y - p.y) * zoom >= 2) l.pts.push(p);
      }
      showLasso(l.dragging && e.buttons & 1 ? null : p);
      return;
    }
    if (textDrag) {
      const t = textDrag;
      const prev = textBounds(t.layer);
      t.layer.text = { ...t.spec, x: Math.round(t.spec.x + p.x - t.at.x), y: Math.round(t.spec.y + p.y - t.at.y) };
      paintText(t.layer);
      doc.render(unionRect(prev, textBounds(t.layer)));
      return;
    }
    if (xf?.drag) {
      const prev = { ...xf.box };
      xf.box = dragBox(xf.drag.start, xf.drag.handle, xf.drag.at, p, e.shiftKey);
      paintTransform(prev);
      showTransform();
      return;
    }
    if (!drag) return;
    if (Math.hypot(p.x - drag.start.x, p.y - drag.start.y) * zoom > 2) drag.moved = true;
    const t = drag.scroll ? 'hand' : tool;
    if (t === 'hand' && drag.scroll) {
      stage.scrollLeft = drag.scroll.x - (e.clientX - drag.scroll.cx);
      stage.scrollTop = drag.scroll.y - (e.clientY - drag.scroll.cy);
    } else if ((t === 'brush' || t === 'eraser') && stroke) {
      for (const ev of e.getCoalescedEvents?.() ?? [e]) strokeTo(toImage(ev), pressureOf(ev));
    } else if (RETOUCH.includes(t) && retouch) {
      for (const ev of e.getCoalescedEvents?.() ?? [e]) retouchTo(toImage(ev), pressureOf(ev));
    } else if (t === 'crop' && cropBox) {
      cropBox.w = p.x - cropBox.x;
      cropBox.h = p.y - cropBox.y;
      showCrop();
    } else if ((t === 'rselect' || t === 'eselect') && selBox) {
      selBox.b = constrain('rect', selBox.a, p, e.shiftKey && selBox.how === 'replace');
      const sb = selBox;
      preview = (c, px) => {
        c.lineWidth = px;
        c.strokeStyle = '#000000';
        c.setLineDash([4 * px, 4 * px]);
        c.beginPath();
        const x = Math.min(sb.a.x, sb.b.x), y = Math.min(sb.a.y, sb.b.y), w = Math.abs(sb.b.x - sb.a.x), hh = Math.abs(sb.b.y - sb.a.y);
        if (t === 'eselect') c.ellipse(x + w / 2, y + hh / 2, w / 2, hh / 2, 0, 0, Math.PI * 2);
        else c.rect(x, y, w, hh);
        c.stroke();
        c.setLineDash([]);
        where.textContent = `${Math.round(w)} × ${Math.round(hh)}`;
      };
      drawOverlay();
    } else if ((SHAPES.includes(t) || t === 'gradient') && doc.pending) {
      const pend = doc.pending;
      const prev = pend.bounds;
      if (prev) strokeCtx.clearRect(prev.x, prev.y, prev.w, prev.h);
      if (t === 'gradient') {
        drawGradient(strokeCtx, drag.start, p);
        pend.bounds = doc.full;
        preview = (c, px) => {
          c.strokeStyle = '#ffffff';
          c.lineWidth = 2 * px;
          c.beginPath();
          c.moveTo(drag!.start.x, drag!.start.y);
          c.lineTo(p.x, p.y);
          c.stroke();
        };
        drawOverlay();
      } else pend.bounds = clipRect(drawShape(strokeCtx, t, drag.start, constrain(t, drag.start, p, e.shiftKey)), doc.width, doc.height);
      queueRender(unionRect(prev, pend.bounds));
    }
    drag.last = p;
  }, app.signal);

  const endDrag = (e: PointerEvent) => {
    const p = toImage(e);
    if (lasso) {
      const l = lasso;
      // A press-drag-release draws a free shape and closes it; a click adds a corner and waits for the next
      // (double-click, Enter, or a click on the first corner closes it).
      if (l.fresh && e.type === 'pointerup' && l.pts.length > 3 && Math.hypot(l.downAt.x - p.x, l.downAt.y - p.y) * zoom > 4) closeLasso();
      else {
        l.dragging = false;
        l.fresh = false;
      }
      return;
    }
    if (textDrag) {
      const t = textDrag;
      textDrag = null;
      const moved = t.layer.text!;
      t.layer.text = t.spec;
      paintText(t.layer);
      if (moved.x !== t.spec.x || moved.y !== t.spec.y) doc.setMeta('Move text', t.layer, { text: moved });
      else doc.render();
      return;
    }
    if (xf?.drag) {
      xf.drag = null;
      return;
    }
    if (!drag) return;
    const t = drag.scroll ? 'hand' : tool;
    if ((t === 'brush' || t === 'eraser') && stroke) {
      stroke = null;
      doc.commitPending(t === 'eraser' ? 'Eraser' : 'Brush', touched);
    } else if (SHAPES.includes(t) && doc.pending) {
      if (drag.moved) {
        const b = doc.pending.bounds;
        if (b) markTouched(b);
        doc.commitPending(t === 'line' ? 'Line' : t === 'arrow' ? 'Arrow' : t === 'rect' ? 'Rectangle' : 'Ellipse', touched);
      } else doc.cancelPending();
    } else if (t === 'gradient' && doc.pending) {
      preview = null;
      if (drag.moved) {
        markTouched(doc.full);
        doc.commitPending('Gradient', touched);
      } else doc.cancelPending();
      drawOverlay();
    } else if (RETOUCH.includes(t) && retouch) {
      const rt = retouch;
      retouch = null;
      const names: Record<string, string> = { clone: 'Clone', heal: 'Heal', smudge: 'Smudge', dodge: dodgeMode.value === 'dodge' ? 'Dodge' : 'Burn', blur: blurMode.value === 'blur' ? 'Blur brush' : 'Sharpen brush' };
      doc.pushPixels(names[t], doc.active, rt.patch);
    } else if (t === 'crop') {
      cropBar.hidden = !cropBox || Math.abs(cropBox.w) < 2 || Math.abs(cropBox.h) < 2;
      if (cropBar.hidden) endCrop();
    } else if ((t === 'rselect' || t === 'eselect') && selBox) {
      const sb = selBox;
      selBox = null;
      preview = null;
      if (!drag.moved) {
        // A click without a drag lets go of the selection (as in GIMP).
        if (sb.how === 'replace') doc.setSelection('Select none', null);
        drawOverlay();
      } else {
        const r = { x: Math.min(sb.a.x, sb.b.x), y: Math.min(sb.a.y, sb.b.y), w: Math.abs(sb.b.x - sb.a.x), h: Math.abs(sb.b.y - sb.a.y) };
        finishSelection(t === 'eselect' ? ellipseMask(doc.width, doc.height, r) : rectMask(doc.width, doc.height, r), sb.how, t === 'eselect' ? 'Ellipse selection' : 'Rectangle selection');
      }
    }
    drag = null;
    refresh();
  };
  on(over, 'pointerup', endDrag, app.signal);
  on(over, 'pointercancel', endDrag, app.signal);
  on(over, 'dblclick', () => {
    if (lasso) closeLasso();
  }, app.signal);

  // ---- Whole-picture changes (every layer) ----
  function everyLayer(label: string, w: number, hgt: number, draw: (c: CanvasRenderingContext2D, src: HTMLCanvasElement) => void, sel: Mask | null = null) {
    settle();
    const canvases = new Map<Layer, HTMLCanvasElement>();
    const texts = new Map<Layer, TextSpec | null>();
    for (const l of doc.layers) {
      const [c, x] = makeCanvas(w, hgt);
      x.imageSmoothingQuality = 'high';
      draw(x, l.canvas);
      canvases.set(l, c);
      // Turned, flipped or resized words are pixels from now on.
      texts.set(l, null);
    }
    doc.replaceCanvases(label, w, hgt, canvases, sel, texts);
  }
  const rotate = (dir: 1 | -1) => everyLayer(dir > 0 ? 'Rotate right' : 'Rotate left', doc.height, doc.width, (c, src) => {
    c.translate(dir > 0 ? src.height : 0, dir > 0 ? 0 : src.width);
    c.rotate((dir * Math.PI) / 2);
    c.drawImage(src, 0, 0);
  });
  const flipAll = (horizontal: boolean) => everyLayer(horizontal ? 'Flip' : 'Flip upside down', doc.width, doc.height, (c, src) => {
    c.translate(horizontal ? src.width : 0, horizontal ? 0 : src.height);
    c.scale(horizontal ? -1 : 1, horizontal ? 1 : -1);
    c.drawImage(src, 0, 0);
  });

  // ---- Dialogs: new, resize, canvas size ----
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
    settle();
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
    const room = () => Number(w.value) * Number(hh.value) <= MAX_PIXELS && !noRoomForLayer(Number(w.value), Number(hh.value), doc.layers.length - 1);
    const ok = await shell.dialogs.ask({
      title: 'Resize picture',
      body: h('div', { class: 'pe-form' }, h('label', {}, 'Width ', w), h('label', {}, 'Height ', hh), h('label', {}, lock, ' Keep the shape'), pct,
        doc.layers.length > 1 ? h('p', { class: 'hint' }, `Every layer (${doc.layers.length}) is resized.`) : null),
      buttons: [{ label: 'Resize', value: true, primary: true }, { label: 'Cancel', value: false }],
      cancel: false,
      primaryEnabled: () => [w, hh].every(i => Number(i.value) >= 1 && Number(i.value) <= 20000) && room(),
    });
    ab.abort();
    if (!ok) return;
    const nw = Math.round(Number(w.value));
    const nh = Math.round(Number(hh.value));
    everyLayer('Resize', nw, nh, (c, src) => {
      // Halving in steps keeps a big reduction smooth instead of grainy.
      let from: HTMLCanvasElement = src;
      while (from.width / 2 >= nw && from.height / 2 >= nh) {
        const [half, hc] = makeCanvas(Math.round(from.width / 2), Math.round(from.height / 2));
        hc.imageSmoothingQuality = 'high';
        hc.drawImage(from, 0, 0, half.width, half.height);
        from = half;
      }
      c.drawImage(from, 0, 0, nw, nh);
    });
  }

  async function askCanvasSize() {
    settle();
    const w = h('input', { type: 'number', class: 'field num', min: 1, max: 20000, value: doc.width, 'aria-label': 'New width' });
    const hh = h('input', { type: 'number', class: 'field num', min: 1, max: 20000, value: doc.height, 'aria-label': 'New height' });
    let anchor = 4;
    const grid = h('div', { class: 'pe-anchor', role: 'radiogroup', 'aria-label': 'Where the picture stays' });
    const cells = Array.from({ length: 9 }, (_, i) => {
      const b = h('button', { type: 'button', role: 'radio', 'aria-checked': String(i === anchor), 'aria-label': ['Top left', 'Top', 'Top right', 'Left', 'Middle', 'Right', 'Bottom left', 'Bottom', 'Bottom right'][i] }, i === anchor ? '●' : '');
      b.addEventListener('click', () => {
        anchor = i;
        cells.forEach((c, j) => {
          c.setAttribute('aria-checked', String(j === i));
          c.textContent = j === i ? '●' : '';
        });
      });
      return b;
    });
    grid.append(...cells);
    const ok = await shell.dialogs.ask({
      title: 'Canvas size',
      body: h('div', { class: 'pe-form' }, h('label', {}, 'Width ', w), h('label', {}, 'Height ', hh), h('div', {}, 'Where the picture stays:'), grid,
        h('p', { class: 'hint' }, 'Adds see-through space round the picture, or cuts its edges, without stretching it.')),
      buttons: [{ label: 'Change', value: true, primary: true }, { label: 'Cancel', value: false }],
      cancel: false,
      primaryEnabled: () => [w, hh].every(i => Number(i.value) >= 1 && Number(i.value) <= 20000) && Number(w.value) * Number(hh.value) <= MAX_PIXELS && !noRoomForLayer(Number(w.value), Number(hh.value), doc.layers.length - 1),
    });
    if (!ok) return;
    const nw = Math.round(Number(w.value)), nh = Math.round(Number(hh.value));
    const ax = anchor % 3, ay = Math.floor(anchor / 3);
    const ox = Math.round(((nw - doc.width) * ax) / 2), oy = Math.round(((nh - doc.height) * ay) / 2);
    resizeCanvas('Canvas size', nw, nh, ox, oy);
  }
  function resizeCanvas(label: string, nw: number, nh: number, ox: number, oy: number) {
    const canvases = new Map<Layer, HTMLCanvasElement>();
    const texts = new Map<Layer, TextSpec | null>();
    for (const l of doc.layers) {
      const [c, x] = makeCanvas(nw, nh);
      x.drawImage(l.canvas, ox, oy);
      canvases.set(l, c);
      texts.set(l, l.text ? { ...l.text, x: l.text.x + ox, y: l.text.y + oy } : null);
    }
    const sel = doc.selection ? cropMask(doc.selection, doc.width, doc.full, nw, nh, ox, oy) : null;
    doc.replaceCanvases(label, nw, nh, canvases, sel, texts);
  }

  // ---- Layers ----
  function addLayer(name?: string): Layer | null {
    settle();
    const why = noRoomForLayer(doc.width, doc.height, doc.layers.length);
    if (why) {
      void shell.dialogs.alert('No room for another layer', why);
      return null;
    }
    const layer = makeLayer(doc.width, doc.height, name ?? nextName(doc.layers.map(l => l.name)));
    const at = doc.indexOf(doc.active) + 1;
    doc.setLayers('New layer', [...doc.layers.slice(0, at), layer, ...doc.layers.slice(at)], layer);
    return layer;
  }
  function duplicateLayer() {
    settle();
    const why = noRoomForLayer(doc.width, doc.height, doc.layers.length);
    if (why) return void shell.dialogs.alert('No room for another layer', why);
    const a = doc.active;
    const layer = makeLayer(doc.width, doc.height, copyName(doc.layers.map(l => l.name), a.name), { visible: a.visible, opacity: a.opacity, mode: a.mode, text: a.text ? { ...a.text } : null });
    layer.ctx.drawImage(a.canvas, 0, 0);
    const at = doc.indexOf(a) + 1;
    doc.setLayers('Duplicate layer', [...doc.layers.slice(0, at), layer, ...doc.layers.slice(at)], layer);
  }
  function deleteLayer() {
    settle();
    if (doc.layers.length <= 1) return void shell.toast('A picture needs at least one layer.');
    const i = doc.indexOf(doc.active);
    const rest = doc.layers.filter(l => l !== doc.active);
    doc.setLayers('Delete layer', rest, rest[Math.max(0, i - 1)]);
  }
  function shiftLayer(dir: 1 | -1) {
    settle();
    const i = doc.indexOf(doc.active);
    if (i + dir < 0 || i + dir >= doc.layers.length) return;
    doc.setLayers(dir > 0 ? 'Raise layer' : 'Lower layer', moveItem(doc.layers, i, i + dir), doc.active);
  }
  function mergeDown() {
    settle();
    const i = doc.indexOf(doc.active);
    if (i <= 0) return void shell.toast('There is no layer below this one to merge into.');
    const top = doc.active, below = doc.layers[i - 1];
    if (below.locked) return void editable(below);
    // The merged layer keeps the lower layer's settings, as in GIMP.
    const merged = makeLayer(doc.width, doc.height, below.name, { visible: below.visible, opacity: below.opacity, mode: below.mode });
    merged.ctx.drawImage(below.canvas, 0, 0);
    if (top.visible) {
      merged.ctx.globalAlpha = top.opacity;
      merged.ctx.globalCompositeOperation = blendInfo(top.mode).canvas;
      merged.ctx.drawImage(top.canvas, 0, 0);
      merged.ctx.globalAlpha = 1;
      merged.ctx.globalCompositeOperation = 'source-over';
    }
    doc.setLayers('Merge down', [...doc.layers.slice(0, i - 1), merged, ...doc.layers.slice(i + 1)], merged);
  }
  function flattenAll() {
    settle();
    if (doc.layers.length === 1 && !doc.layers[0].text && doc.layers[0].visible && doc.layers[0].opacity === 1) return;
    const flat = makeLayer(doc.width, doc.height, 'Background');
    flat.ctx.drawImage(doc.flatten(), 0, 0);
    doc.setLayers('Flatten picture', [flat], flat);
  }
  async function renameLayer(layer: Layer) {
    const name = await shell.dialogs.prompt({ title: 'Rename layer', label: 'Layer name', value: layer.name, ok: 'Rename', check: v => (v.trim() ? (v.length > 200 ? 'Keep it under 200 letters.' : null) : 'Type a name first.') });
    if (name && name.trim() !== layer.name) doc.setMeta('Rename layer', layer, { name: name.trim() });
  }
  function flipLayer(horizontal: boolean) {
    settle();
    if (!editable()) return;
    const l = doc.active;
    const [, x] = makeCanvas(doc.width, doc.height);
    x.translate(horizontal ? doc.width : 0, horizontal ? 0 : doc.height);
    x.scale(horizontal ? -1 : 1, horizontal ? 1 : -1);
    x.drawImage(l.canvas, 0, 0);
    doc.changePixels(horizontal ? 'Flip layer' : 'Flip layer upside down', p => {
      p.data.set(x.getImageData(0, 0, doc.width, doc.height).data);
    }, doc.full);
  }

  // ---- Edit: clipboard, delete, fill ----
  function copy(cut: boolean) {
    settle();
    const got = doc.selectedPixels();
    if (!got) return;
    internalClip = { ...got, at: Date.now() };
    void (async () => {
      try {
        const blob = await new Promise<Blob | null>(res => got.canvas.toBlob(res, 'image/png'));
        if (blob && navigator.clipboard && 'ClipboardItem' in window) await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      } catch {
        // The system clipboard said no (no permission, or not focused): pasting here still works from our own copy.
      }
    })();
    if (cut) {
      if (!editable()) return;
      doc.changePixels('Cut', p => p.data.fill(0));
    }
    shell.toast(cut ? 'Cut.' : `Copied${doc.selection ? ' the selection' : ` “${doc.active.name}”`}.`);
  }
  function clearSelected() {
    settle();
    if (!editable()) return;
    doc.changePixels(doc.selection ? 'Delete' : 'Clear layer', p => p.data.fill(0));
  }
  function fillSelected(hex: string) {
    settle();
    if (!editable()) return;
    const [r, g, b] = hexToRgba(hex);
    doc.changePixels('Fill with colour', p => {
      for (let i = 0; i < p.data.length; i += 4) p.data.set([r, g, b, 255], i);
    });
  }
  async function pasteImage(source: CanvasImageSource & { width: number; height: number }, at: Point | null, asNew: boolean) {
    settle();
    const w = source.width, hgt = source.height;
    if (asNew) {
      if (!(await guard())) return;
      if (w * hgt > MAX_PIXELS) return void shell.dialogs.alert('Too many pixels', `The pasted picture is ${w} × ${hgt} pixels, more than Photo Editor holds.`);
      const layer = makeLayer(w, hgt, 'Background');
      layer.ctx.drawImage(source, 0, 0);
      xf = null;
      doc.reset(w, hgt, [layer]);
      path = null;
      loadedId = '';
      dirty = true;
      panel.refresh();
      fit();
      return;
    }
    if (w > doc.width || hgt > doc.height) {
      const nw = Math.max(w, doc.width), nh = Math.max(hgt, doc.height);
      const grow = nw * nh <= MAX_PIXELS && !noRoomForLayer(nw, nh, doc.layers.length) && await shell.dialogs.ask({
        title: 'The pasted picture is bigger',
        text: `It is ${w} × ${hgt} pixels; this picture is ${doc.width} × ${doc.height}. Make this picture ${nw} × ${nh} so all of it fits?`,
        buttons: [{ label: 'Make it bigger', value: true, primary: true }, { label: 'Keep the size', value: false }],
        cancel: false,
      });
      if (grow) resizeCanvas('Make room to paste', nw, nh, 0, 0);
    }
    const layer = addLayer('Pasted');
    if (!layer) return;
    const x = at ? at.x : Math.round((doc.width - w) / 2), y = at ? at.y : Math.round((doc.height - hgt) / 2);
    layer.ctx.drawImage(source, Math.max(Math.min(x, doc.width - 1), 1 - w), Math.max(Math.min(y, doc.height - 1), 1 - hgt));
    doc.render();
    panel.refresh();
    if (doc.selection) doc.setSelection('Select none', null);
    setTool('move');
    shell.toast('Pasted as a new layer. Drag to place it; Enter when done.');
  }
  async function pasteFromSystem(asNew: boolean) {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find(t => t.startsWith('image/'));
        if (!type) continue;
        const blob = await item.getType(type);
        const img = await createImageBitmap(blob);
        await pasteImage(img, null, asNew);
        img.close();
        return;
      }
    } catch {
      // No permission to read the clipboard, or nothing there: fall back to our own copy.
    }
    if (internalClip) return pasteImage(internalClip.canvas, asNew ? null : { x: internalClip.x, y: internalClip.y }, asNew);
    await shell.dialogs.alert('Nothing to paste', 'There is no picture on the clipboard. Copy a picture first (in Photo Editor, or a screenshot or a picture in another program), then paste. If the browser asked about the clipboard and you said no, Ctrl+V still works.');
  }
  on(app.root, 'paste', async (e: ClipboardEvent) => {
    const target = e.target as HTMLElement;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    const file = [...(e.clipboardData?.items ?? [])].find(i => i.kind === 'file' && i.type.startsWith('image/'))?.getAsFile();
    e.preventDefault();
    if (file) {
      if (file.size > MAX_FILE) return void shell.dialogs.alert('Too big to paste', `The picture on the clipboard is ${formatSize(file.size)}; Photo Editor takes up to ${formatSize(MAX_FILE)}.`);
      const bytes = new Uint8Array(await file.arrayBuffer());
      const tooBig = pictureTooBig(bytes);
      if (tooBig) return void shell.dialogs.alert('Too many pixels', tooBig);
      try {
        const img = await createImageBitmap(file);
        await pasteImage(img, null, false);
        img.close();
      } catch {
        await shell.dialogs.alert('Could not paste that', 'The picture on the clipboard could not be read. Try copying it again, or save it as a file and open it.');
      }
      return;
    }
    if (internalClip) await pasteImage(internalClip.canvas, { x: internalClip.x, y: internalClip.y }, false);
    else await shell.dialogs.alert('Nothing to paste', 'There is no picture on the clipboard. Copy a picture first, then press Ctrl+V here.');
  }, app.signal);

  // ---- Selections from the menu ----
  const selectAll = () => {
    settle();
    doc.setSelection('Select all', rectMask(doc.width, doc.height, doc.full));
  };
  const selectNone = () => {
    settle();
    doc.setSelection('Select none', null);
  };
  const selectInvert = () => {
    settle();
    doc.setSelection('Invert selection', invertMask(doc.selection, doc.width * doc.height));
  };
  async function askFeather() {
    settle();
    if (!doc.selection) return void shell.toast('Select something first.');
    const n = await shell.dialogs.prompt({ title: 'Soften the edge', label: 'Soft edge (pixels)', value: '10', ok: 'Soften', check: v => (Number(v) >= 1 && Number(v) <= 500 ? null : 'Type a number from 1 to 500.') });
    if (!n) return;
    doc.setSelection('Soften selection', feather(doc.selection, doc.width, doc.height, Number(n)));
  }
  const cropToSelection = () => {
    settle();
    if (!doc.selBounds) return void shell.toast('Select something first.');
    cropTo(doc.selBounds, 'Crop to selection');
  };

  // ---- Menus ----
  const applyFilter = (label: string, fn: Parameters<Doc['changePixels']>[1]) => {
    settle();
    if (editable()) doc.changePixels(label, fn);
  };
  const runAdjust = async (kind: AdjustKind) => {
    settle();
    if (!editable()) return;
    await adjust(shell, doc, kind);
    refresh();
  };
  const showMenu = (btn: HTMLElement, items: MenuItem[]) => {
    const r = btn.getBoundingClientRect();
    shell.menus.show(items, r.left, r.bottom, { returnFocus: btn });
  };
  on(editMenu, 'click', () => showMenu(editMenu, [
    { label: 'Undo', hint: 'Ctrl+Z', disabled: !doc.history.undoList.length, action: undo },
    { label: 'Redo', hint: 'Ctrl+Y', disabled: !doc.history.redoList.length, action: redo },
    { separator: true },
    { label: 'Cut', hint: 'Ctrl+X', action: () => copy(true) },
    { label: 'Copy', hint: 'Ctrl+C', action: () => copy(false) },
    { label: 'Paste as a new layer', hint: 'Ctrl+V', action: () => void pasteFromSystem(false) },
    { label: 'Paste as a new picture', action: () => void pasteFromSystem(true) },
    { separator: true },
    { label: doc.selection ? 'Delete the selected part' : 'Clear the layer', hint: 'Delete', action: clearSelected },
    { label: 'Fill with the colour', action: () => fillSelected(colour.value) },
    { label: 'Fill with the second colour', action: () => fillSelected(colour2.value) },
  ]), app.signal);
  on(imageMenu, 'click', () => showMenu(imageMenu, [
    { label: 'Resize picture...', action: () => void askResize() },
    { label: 'Canvas size...', action: () => void askCanvasSize() },
    { label: 'Crop to selection', disabled: !doc.selection, action: cropToSelection },
    { separator: true },
    { label: 'Rotate left', action: () => rotate(-1) },
    { label: 'Rotate right', action: () => rotate(1) },
    { label: 'Flip left to right', action: () => flipAll(true) },
    { label: 'Flip upside down', action: () => flipAll(false) },
    { separator: true },
    { label: 'Flatten picture (join all layers)', disabled: doc.layers.length < 2, action: flattenAll },
  ]), app.signal);
  on(layerMenu, 'click', () => showMenu(layerMenu, [
    { label: 'New layer', action: () => void addLayer() },
    { label: 'Duplicate layer', action: duplicateLayer },
    { label: 'Delete layer', disabled: doc.layers.length < 2, action: deleteLayer },
    { separator: true },
    { label: 'Raise layer', disabled: doc.indexOf(doc.active) >= doc.layers.length - 1, action: () => shiftLayer(1) },
    { label: 'Lower layer', disabled: doc.indexOf(doc.active) <= 0, action: () => shiftLayer(-1) },
    { label: 'Merge down', hint: 'Ctrl+E', disabled: doc.indexOf(doc.active) <= 0, action: mergeDown },
    { label: 'Flatten picture', disabled: doc.layers.length < 2, action: flattenAll },
    { separator: true },
    { label: 'Rename layer...', action: () => void renameLayer(doc.active) },
    { label: 'Change the text...', disabled: !doc.active.text, action: () => void textAt({ x: doc.active.text!.x, y: doc.active.text!.y }) },
    { label: 'Text to pixels', disabled: !doc.active.text, action: () => doc.setMeta('Text to pixels', doc.active, { text: null }) },
    { separator: true },
    { label: 'Flip layer left to right', action: () => flipLayer(true) },
    { label: 'Flip layer upside down', action: () => flipLayer(false) },
  ]), app.signal);
  on(selectMenu, 'click', () => showMenu(selectMenu, [
    { label: 'All', hint: 'Ctrl+A', action: selectAll },
    { label: 'None', hint: 'Ctrl+Shift+A', disabled: !doc.selection, action: selectNone },
    { label: 'Invert', hint: 'Ctrl+I', action: selectInvert },
    { separator: true },
    { label: 'Soften the edge...', disabled: !doc.selection, action: () => void askFeather() },
    { label: 'Crop to selection', disabled: !doc.selection, action: cropToSelection },
  ]), app.signal);
  on(colourMenu, 'click', () => showMenu(colourMenu, [
    { label: 'Brightness and contrast...', action: () => void runAdjust('brightness') },
    { label: 'Levels...', hint: 'Ctrl+L', action: () => void runAdjust('levels') },
    { label: 'Curves...', hint: 'Ctrl+M', action: () => void runAdjust('curves') },
    { label: 'Hue and saturation...', hint: 'Ctrl+U', action: () => void runAdjust('hue') },
    { label: 'Colour balance...', action: () => void runAdjust('balance') },
    { separator: true },
    { label: 'Threshold...', action: () => void runAdjust('threshold') },
    { label: 'Posterise...', action: () => void runAdjust('posterise') },
    { label: 'Desaturate...', action: () => void runAdjust('desaturate') },
    { label: 'Invert colours', action: () => applyFilter('Invert colours', invert) },
  ]), app.signal);
  on(filterBtn, 'click', () => showMenu(filterBtn, [
    { label: 'Greyscale', action: () => applyFilter('Greyscale', greyscale) },
    { label: 'Sepia', action: () => applyFilter('Sepia', sepia) },
    { label: 'Invert colours', action: () => applyFilter('Invert colours', invert) },
    { separator: true },
    { label: 'Blur', action: () => applyFilter('Blur', p => convolve3(p, BLUR)) },
    { label: 'Sharpen', action: () => applyFilter('Sharpen', p => convolve3(p, SHARPEN)) },
  ]), app.signal);
  on(helpMenu, 'click', () => showMenu(helpMenu, [
    { label: 'What Photo Editor does and leaves out', action: () => void showHelp() },
    { label: 'Keys', action: () => void showKeys() },
  ]), app.signal);

  async function showHelp() {
    await shell.dialogs.alert('Photo Editor', [
      'Layers: add, copy, delete, rename, drag to reorder, hide, see-through amount, 16 blend modes, lock, merge down, flatten. Text layers stay editable until merged or turned into pixels.',
      'Selections: rectangle, ellipse, lasso, magic wand; add (Shift), take away (Alt); invert; soft edges. Painting, fills, filters and colour changes stay inside the selection.',
      'Painting: brush and eraser (size, hardness, opacity, spacing, pen pressure), line, arrow, rectangle, ellipse, fill, gradient. Retouching: clone, heal, smudge, dodge / burn, blur / sharpen.',
      'Colour: brightness and contrast, levels, curves, hue and saturation, colour balance, threshold, posterise, desaturate. Filters: greyscale, sepia, invert, blur, sharpen.',
      'Move, stretch and turn a layer or a selection; crop, resize, canvas size, rotate, flip.',
      'Files: opens PNG, JPEG, GIF (first frame), WebP, AVIF, BMP, SVG, ICO and OpenRaster (.ora). Saves PNG, JPEG and WebP as one flat picture, and .ora with the layers (GIMP and Krita open it).',
      'Left out: opening GIMP .xcf or Photoshop .psd files with their layers (flatten them elsewhere first, or save as .ora in GIMP); layer masks; layer groups (an .ora with groups opens as one list); paths and Bézier curves; perspective and warp; camera RAW, CMYK, 16-bit colour and colour profiles; most of GIMP\'s filters; scripts, plug-ins and batch work; animation.',
      `Limits: pictures up to ${MAX_PIXELS / 1e6} million pixels; all layers together up to about 150 million pixels (for example 12 layers of 12 megapixels), and 100 layers at most. Undo keeps the most recent steps up to about 256 MB.`,
    ].join('\n\n'));
  }
  async function showKeys() {
    await shell.dialogs.alert('Photo Editor keys', [
      'Tools: ' + TOOLS.map(([, , name, key]) => `${keyName(key)} ${name.split(' (')[0].split(':')[0]}`).join(' · '),
      'Space (held): move around · + and - zoom · 0 fit · 1 actual size · [ and ] brush size · X swap colours',
      'Ctrl+Z undo · Ctrl+Y redo · Ctrl+X / C / V cut, copy, paste · Delete clear · Ctrl+A select all · Ctrl+Shift+A select none · Ctrl+I invert · Ctrl+E merge down · Ctrl+L levels · Ctrl+M curves · Ctrl+U hue and saturation · F7 Layers panel',
      'Enter applies a crop or a move, closes a lasso · Escape cancels them',
    ].join('\n\n'));
  }

  // ---- Wiring ----
  on(newBtn, 'click', () => void askNew(), app.signal);
  const openPicked = async () => {
    settle();
    if (!(await guard())) return;
    const p = await pickFile(shell, { title: 'Open picture', folder: path ? parentPath(path) : '/Pictures', accept: OPEN_EXTS });
    if (p) await openPath(p);
  };
  on(openBtn, 'click', () => void openPicked(), app.signal);
  on(saveBtn, 'click', () => void save(), app.signal);
  on(saveAsBtn, 'click', () => void saveAs(), app.signal);
  on(undoBtn, 'click', undo, app.signal);
  on(redoBtn, 'click', redo, app.signal);
  on(rotL, 'click', () => rotate(-1), app.signal);
  on(rotR, 'click', () => rotate(1), app.signal);
  on(flipH, 'click', () => flipAll(true), app.signal);
  on(flipV, 'click', () => flipAll(false), app.signal);
  on(zoomIn, 'click', () => stepZoom(1), app.signal);
  on(zoomOut, 'click', () => stepZoom(-1), app.signal);
  on(zoomFit, 'click', fit, app.signal);
  on(zoom100, 'click', () => ((autoFit = false), (zoom = 1), paintZoom()), app.signal);
  on(cropApply, 'click', applyCrop, app.signal);
  on(cropCancel, 'click', endCrop, app.signal);
  on(xfApply, 'click', () => {
    commitTransform();
    stage.focus({ preventScroll: true });
  }, app.signal);
  on(xfCancel, 'click', () => {
    cancelTransform();
    stage.focus({ preventScroll: true });
  }, app.signal);
  on(swapBtn, 'click', () => ([colour.value, colour2.value] = [colour2.value, colour.value]), app.signal);
  const showPanel = (yes: boolean) => {
    panel.el.hidden = !yes;
    layersToggle.setAttribute('aria-pressed', String(yes));
    if (autoFit) requestAnimationFrame(fit);
  };
  on(layersToggle, 'click', () => showPanel(panel.el.hidden === true), app.signal);
  on(stage, 'wheel', (e: WheelEvent) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    stepZoom(e.deltaY < 0 ? 1 : -1);
  }, app.signal, { passive: false });
  on(app.root, 'keydown', (e: KeyboardEvent) => {
    const t = e.target;
    const typing = (t instanceof HTMLInputElement && !['range', 'checkbox', 'color', 'radio'].includes(t.type)) || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    const act = (fn: () => void) => {
      e.preventDefault();
      fn();
    };
    if (ctrl && k === 's') return act(() => void (e.shiftKey ? saveAs() : save()));
    if (ctrl && k === 'o') return act(() => void openPicked());
    if (ctrl && k === 'z') return act(() => (e.shiftKey ? redo() : undo()));
    if (ctrl && k === 'y') return act(redo);
    if (typing) return;
    if (ctrl && k === 'a') return act(e.shiftKey ? selectNone : selectAll);
    if (ctrl && k === 'd') return act(selectNone);
    if (ctrl && k === 'i') return act(selectInvert);
    if (ctrl && k === 'c') return act(() => copy(false));
    if (ctrl && k === 'x') return act(() => copy(true));
    if (ctrl && k === 'e') return act(mergeDown);
    if (ctrl && k === 'l') return act(() => void runAdjust('levels'));
    if (ctrl && k === 'm') return act(() => void runAdjust('curves'));
    if (ctrl && k === 'u') return act(() => void runAdjust('hue'));
    if (e.key === 'F7') return act(() => showPanel(panel.el.hidden === true));
    if (ctrl || e.altKey) return;
    if (e.key === 'Enter') {
      if (cropBox) return act(applyCrop);
      if (xf) return act(commitTransform);
      if (lasso) return act(closeLasso);
    }
    if (e.key === 'Escape') {
      if (cropBox) return act(endCrop);
      if (xf) return act(cancelTransform);
      if (lasso) return act(endLasso);
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && !(t instanceof HTMLButtonElement)) return act(clearSelected);
    if (e.key === ' ' && !spaceHeld) {
      spaceHeld = true;
      stage.dataset.tool = 'hand';
      return act(() => undefined);
    }
    if (e.key === '+' || e.key === '=') return act(() => stepZoom(1));
    if (e.key === '-') return act(() => stepZoom(-1));
    if (e.key === '0') return act(fit);
    if (e.key === '1') return act(() => ((autoFit = false), (zoom = 1), paintZoom()));
    if (e.key === '[' || e.key === ']') return act(() => size.set(Math.max(1, Math.min(400, Math.round(size.value * (e.key === ']' ? 1.25 : 0.8)) + (e.key === ']' ? 1 : 0)))));
    if (k === 'x' && !e.shiftKey) return act(() => swapBtn.click());
    const hit = TOOLS.find(([, , , key]) => key === (e.shiftKey ? e.key.toUpperCase() : e.key.toLowerCase()) && (e.shiftKey === (key !== key.toLowerCase())));
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
  // A narrow window starts with the Layers panel hidden (the toolbar button brings it back).
  if (app.root.clientWidth && app.root.clientWidth < 700) showPanel(false);
  if (arg) await openPath(arg);
  stage.focus();
}
