// Photo Editor's colour windows: brightness and contrast, levels (with a histogram), curves, hue / saturation /
// lightness, colour balance, threshold, posterise and desaturate. Each one shows its change on the picture while the
// window is open (inside the selection, on the active layer) and becomes one undo step when applied.
import { h } from '../../core/dom.ts';
import type { Shell } from '../../shell/types.ts';
import type { Doc } from './doc.ts';
import { clipRect } from './history.ts';
import { brightnessContrast, saturation, type Pixels } from './pixels.ts';
import { maskMix, selectedOnly } from './selection.ts';
import {
  applyTable, autoLevels, colourBalance, curveTable, desaturate, histogram, hueSaturation, levelsTable, LEVELS_NONE, posterise, threshold,
  type Balance, type Channel, type GreyMode, type Histogram, type Levels,
} from './colour.ts';

export type AdjustKind = 'brightness' | 'levels' | 'curves' | 'hue' | 'balance' | 'threshold' | 'posterise' | 'desaturate';

export const ADJUST_TITLES: Record<AdjustKind, string> = {
  brightness: 'Brightness and contrast', levels: 'Levels', curves: 'Curves', hue: 'Hue and saturation', balance: 'Colour balance',
  threshold: 'Threshold', posterise: 'Posterise', desaturate: 'Desaturate',
};

function slider(label: string, min: number, max: number, value: number, step = 1) {
  const input = h('input', { type: 'range', min, max, step, value, 'aria-label': label });
  const out = h('span', { class: 'pe-num' }, String(value));
  input.addEventListener('input', () => (out.textContent = input.value));
  const set = (v: number) => {
    input.value = String(v);
    out.textContent = input.value;
  };
  return { input, set, row: h('label', { class: 'pe-slider' }, h('span', {}, label), input, out), get value() {
    return Number(input.value);
  } };
}

function numberBox(label: string, min: number, max: number, value: number, step = 1) {
  return h('input', { type: 'number', class: 'field num', min, max, step, value, 'aria-label': label });
}

const plainLevels = (l: Levels) => l.inLow === 0 && l.inHigh === 255 && l.gamma === 1 && l.outLow === 0 && l.outHigh === 255;

const CHANNELS: Array<[Channel, string]> = [['rgb', 'All (brightness)'], ['r', 'Red'], ['g', 'Green'], ['b', 'Blue']];
const APPLY_ORDER: Channel[] = ['r', 'g', 'b', 'rgb'];

function drawHistogram(c: HTMLCanvasElement, hist: Histogram, ch: Channel, marks: number[] = []) {
  const x = c.getContext('2d')!;
  const counts = ch === 'r' ? hist.r : ch === 'g' ? hist.g : ch === 'b' ? hist.b : hist.lum;
  x.clearRect(0, 0, c.width, c.height);
  x.fillStyle = '#ffffff';
  x.fillRect(0, 0, c.width, c.height);
  // A square root scale, so one big spike does not flatten everything else.
  const top = Math.sqrt(Math.max(1, ...counts));
  x.fillStyle = ch === 'r' ? '#b3261e' : ch === 'g' ? '#1e7a34' : ch === 'b' ? '#1d4fb8' : '#333a44';
  for (let i = 0; i < 256; i++) {
    const v = (Math.sqrt(counts[i]) / top) * c.height;
    x.fillRect((i / 256) * c.width, c.height - v, Math.max(1, c.width / 256), v);
  }
  x.strokeStyle = '#d62828';
  for (const m of marks) {
    const px = Math.round((m / 255) * (c.width - 1)) + 0.5;
    x.beginPath();
    x.moveTo(px, 0);
    x.lineTo(px, c.height);
    x.stroke();
  }
}

/** Opens one colour window. Resolves when it closes (applied or not). */
/** `beforeApply` runs just before the change is made (a text layer becomes pixels only then, not on Cancel). */
export async function adjust(shell: Shell, doc: Doc, kind: AdjustKind, beforeApply: () => void = () => undefined): Promise<boolean> {
  const layer = doc.paint;
  const r = clipRect(doc.selBounds ?? doc.full, doc.width, doc.height);
  if (!r) return false;
  const original = layer.ctx.getImageData(r.x, r.y, r.w, r.h);
  // What the histograms count: only the selected pixels when the selection is not a plain rectangle.
  const sample = doc.selection ? selectedOnly({ data: original.data, width: r.w, height: r.h }, doc.selection, r, doc.width) : { data: original.data, width: r.w, height: r.h };
  let fn: (p: Pixels) => void = () => undefined;
  let body: HTMLElement;
  /** True when the settings change nothing (Apply then does nothing). */
  let isNone = () => true;

  if (kind === 'brightness') {
    const b = slider('Brightness', -100, 100, 0), c = slider('Contrast', -100, 100, 0), s = slider('Colour', -100, 100, 0);
    body = h('div', { class: 'pe-form' }, b.row, c.row, s.row);
    fn = p => {
      brightnessContrast(p, b.value, c.value);
      saturation(p, s.value);
    };
    isNone = () => !b.value && !c.value && !s.value;
  } else if (kind === 'levels') {
    const hist = histogram(sample);
    const levels: Record<Channel, Levels> = { rgb: { ...LEVELS_NONE }, r: { ...LEVELS_NONE }, g: { ...LEVELS_NONE }, b: { ...LEVELS_NONE } };
    const chSel = h('select', { class: 'field', 'aria-label': 'Channel' }, ...CHANNELS.map(([v, l]) => h('option', { value: v }, l)));
    const graph = h('canvas', { class: 'pe-hist', width: 256, height: 100, 'aria-label': 'Histogram' });
    const inLow = numberBox('Input dark', 0, 254, 0), gamma = numberBox('Middle (gamma)', 0.1, 10, 1, 0.05), inHigh = numberBox('Input light', 1, 255, 255);
    const outLow = numberBox('Output dark', 0, 255, 0), outHigh = numberBox('Output light', 0, 255, 255);
    const auto = h('button', { type: 'button', class: 'btn' }, 'Auto');
    const reset = h('button', { type: 'button', class: 'btn' }, 'Reset');
    const ch = () => chSel.value as Channel;
    const show = () => {
      const l = levels[ch()];
      inLow.value = String(l.inLow);
      gamma.value = String(l.gamma);
      inHigh.value = String(l.inHigh);
      outLow.value = String(l.outLow);
      outHigh.value = String(l.outHigh);
      drawHistogram(graph, hist, ch(), [l.inLow, l.inHigh]);
    };
    const read = () => {
      const num = (i: HTMLInputElement, lo: number, hi: number, d: number) => {
        const v = i.value.trim() === '' ? NaN : Number(i.value);
        return Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : d));
      };
      const l: Levels = { inLow: num(inLow, 0, 254, 0), gamma: num(gamma, 0.1, 10, 1), inHigh: num(inHigh, 1, 255, 255), outLow: num(outLow, 0, 255, 0), outHigh: num(outHigh, 0, 255, 255) };
      if (l.inHigh <= l.inLow) l.inHigh = l.inLow + 1;
      levels[ch()] = l;
      drawHistogram(graph, hist, ch(), [l.inLow, l.inHigh]);
    };
    chSel.addEventListener('change', show);
    for (const i of [inLow, gamma, inHigh, outLow, outHigh]) i.addEventListener('input', read);
    auto.addEventListener('click', () => {
      const c = ch();
      const counts = c === 'r' ? hist.r : c === 'g' ? hist.g : c === 'b' ? hist.b : hist.lum;
      levels[c] = autoLevels(counts, hist.count);
      show();
      body.dispatchEvent(new Event('input'));
    });
    reset.addEventListener('click', () => {
      levels[ch()] = { ...LEVELS_NONE };
      show();
      body.dispatchEvent(new Event('input'));
    });
    body = h('div', { class: 'pe-form' },
      h('label', {}, 'Channel ', chSel), graph,
      h('div', { class: 'pe-row3' }, h('label', {}, 'Dark ', inLow), h('label', {}, 'Middle ', gamma), h('label', {}, 'Light ', inHigh)),
      h('div', { class: 'pe-row3' }, h('label', {}, 'Output from ', outLow), h('label', {}, 'to ', outHigh)),
      h('div', { class: 'pe-row3' }, auto, reset));
    show();
    fn = p => {
      // One colour first, then All (as GIMP does).
      for (const c of APPLY_ORDER) {
        const l = levels[c];
        if (!plainLevels(l)) applyTable(p, levelsTable(l), c);
      }
    };
    isNone = () => CHANNELS.every(([c]) => plainLevels(levels[c]));
  } else if (kind === 'curves') {
    const pts: Record<Channel, Array<[number, number]>> = { rgb: [[0, 0], [255, 255]], r: [[0, 0], [255, 255]], g: [[0, 0], [255, 255]], b: [[0, 0], [255, 255]] };
    const chSel = h('select', { class: 'field', 'aria-label': 'Channel' }, ...CHANNELS.map(([v, l]) => h('option', { value: v }, l)));
    const graph = h('canvas', { class: 'pe-curve', width: 256, height: 256, 'aria-label': 'Curve: click to add a point, drag to move it, drag it off the box or double-click it to remove it' });
    const hist = histogram(sample);
    const ch = () => chSel.value as Channel;
    const draw = () => {
      const x = graph.getContext('2d')!;
      drawHistogram(graph, hist, ch());
      x.globalAlpha = 0.25;
      x.fillStyle = '#ffffff';
      x.fillRect(0, 0, 256, 256);
      x.globalAlpha = 1;
      x.strokeStyle = '#c8c8c8';
      for (let i = 64; i < 256; i += 64) {
        x.beginPath();
        x.moveTo(i + 0.5, 0);
        x.lineTo(i + 0.5, 256);
        x.moveTo(0, i + 0.5);
        x.lineTo(256, i + 0.5);
        x.stroke();
      }
      const t = curveTable(pts[ch()]);
      x.strokeStyle = '#111111';
      x.lineWidth = 2;
      x.beginPath();
      for (let i = 0; i < 256; i++) i ? x.lineTo(i, 255 - t[i]) : x.moveTo(i, 255 - t[i]);
      x.stroke();
      x.lineWidth = 1;
      for (const [px, py] of pts[ch()]) {
        x.fillStyle = '#ffffff';
        x.fillRect(px - 4, 255 - py - 4, 8, 8);
        x.strokeRect(px - 4 + 0.5, 255 - py - 4 + 0.5, 7, 7);
      }
    };
    let dragging = -1;
    const at = (e: PointerEvent) => {
      const b = graph.getBoundingClientRect();
      return [Math.round(((e.clientX - b.left) / b.width) * 255), Math.round(255 - ((e.clientY - b.top) / b.height) * 255)];
    };
    graph.addEventListener('pointerdown', e => {
      const [x, y] = at(e);
      const list = pts[ch()];
      dragging = list.findIndex(([px, py]) => Math.abs(px - x) <= 8 && Math.abs(py - y) <= 8);
      if (dragging < 0) {
        const px = Math.min(255, Math.max(0, x)), py = Math.min(255, Math.max(0, y));
        // A click straight above or below a point moves that point (two points cannot share a place across).
        const same = list.findIndex(p => p[0] === px);
        if (same >= 0) {
          list[same] = [px, py];
          dragging = same;
        } else {
          list.push([px, py]);
          list.sort((a, b) => a[0] - b[0]);
          dragging = list.findIndex(p => p[0] === px);
        }
      }
      graph.setPointerCapture(e.pointerId);
      draw();
      body.dispatchEvent(new Event('input'));
    });
    graph.addEventListener('pointermove', e => {
      if (dragging < 0) return;
      const [x, y] = at(e);
      const list = pts[ch()];
      const lo = dragging > 0 ? list[dragging - 1][0] + 1 : 0, hi = dragging < list.length - 1 ? list[dragging + 1][0] - 1 : 255;
      list[dragging] = [Math.min(hi, Math.max(lo, x)), Math.min(255, Math.max(0, y))];
      draw();
      body.dispatchEvent(new Event('input'));
    });
    const drop = (e: PointerEvent) => {
      if (dragging < 0) return;
      const [x, y] = at(e);
      const list = pts[ch()];
      // Dragged well off the box: the point goes (two must stay).
      if (list.length > 2 && (x < -20 || x > 275 || y < -20 || y > 275)) list.splice(dragging, 1);
      dragging = -1;
      draw();
      body.dispatchEvent(new Event('input'));
    };
    graph.addEventListener('pointerup', drop);
    graph.addEventListener('pointercancel', drop);
    graph.addEventListener('dblclick', e => {
      const [x, y] = at(e as PointerEvent);
      const list = pts[ch()];
      const i = list.findIndex(([px, py]) => Math.abs(px - x) <= 8 && Math.abs(py - y) <= 8);
      if (i >= 0 && list.length > 2) list.splice(i, 1);
      draw();
      body.dispatchEvent(new Event('input'));
    });
    const reset = h('button', { type: 'button', class: 'btn' }, 'Reset');
    reset.addEventListener('click', () => {
      pts[ch()] = [[0, 0], [255, 255]];
      draw();
      body.dispatchEvent(new Event('input'));
    });
    chSel.addEventListener('change', draw);
    body = h('div', { class: 'pe-form' }, h('label', {}, 'Channel ', chSel), graph, h('p', { class: 'hint' }, 'Click to add a point; drag it; double-click a point to remove it.'), h('div', { class: 'pe-row3' }, reset));
    draw();
    const plain = (l: Array<[number, number]>) => l.length === 2 && l[0][0] === 0 && l[0][1] === 0 && l[1][0] === 255 && l[1][1] === 255;
      fn = p => {
      for (const c of APPLY_ORDER) if (!plain(pts[c])) applyTable(p, curveTable(pts[c]), c);
    };
    isNone = () => CHANNELS.every(([c]) => plain(pts[c]));
  } else if (kind === 'hue') {
    const hue = slider('Hue', -180, 180, 0), sat = slider('Saturation', -100, 100, 0), light = slider('Lightness', -100, 100, 0);
    body = h('div', { class: 'pe-form' }, hue.row, sat.row, light.row);
    fn = p => hueSaturation(p, hue.value, sat.value, light.value);
    isNone = () => !hue.value && !sat.value && !light.value;
  } else if (kind === 'balance') {
    const bal: Balance = { shadows: [0, 0, 0], midtones: [0, 0, 0], highlights: [0, 0, 0] };
    const range = h('select', { class: 'field', 'aria-label': 'Tones' }, h('option', { value: 'shadows' }, 'Shadows'), h('option', { value: 'midtones', selected: true }, 'Middle tones'), h('option', { value: 'highlights' }, 'Highlights'));
    const sl = [slider('Cyan - Red', -100, 100, 0), slider('Magenta - Green', -100, 100, 0), slider('Yellow - Blue', -100, 100, 0)];
    const key = () => range.value as keyof Balance;
    const show = () => sl.forEach((s, i) => s.set(bal[key()][i]));
    range.addEventListener('change', show);
    sl.forEach((s, i) => s.input.addEventListener('input', () => (bal[key()][i] = s.value)));
    body = h('div', { class: 'pe-form' }, h('label', {}, 'Tones ', range), ...sl.map(s => s.row));
    fn = p => colourBalance(p, bal);
    isNone = () => [...bal.shadows, ...bal.midtones, ...bal.highlights].every(v => !v);
  } else if (kind === 'threshold') {
    const hist = histogram(sample);
    const graph = h('canvas', { class: 'pe-hist', width: 256, height: 100, 'aria-label': 'Histogram' });
    const low = slider('From', 0, 255, 128), high = slider('To', 0, 255, 255);
    const draw = () => drawHistogram(graph, hist, 'rgb', [low.value, high.value]);
    body = h('div', { class: 'pe-form' }, graph, low.row, high.row, h('p', { class: 'hint' }, 'Pixels whose brightness is from “From” to “To” turn white; the rest black.'));
    body.addEventListener('input', draw);
    draw();
    fn = p => threshold(p, low.value, high.value);
    isNone = () => false;
  } else if (kind === 'posterise') {
    const n = slider('Steps', 2, 32, 4);
    body = h('div', { class: 'pe-form' }, n.row, h('p', { class: 'hint' }, 'How many shades each of red, green and blue keeps.'));
    fn = p => posterise(p, n.value);
    isNone = () => false;
  } else {
    const mode = h('select', { class: 'field', 'aria-label': 'Grey by' },
      h('option', { value: 'luminance' }, 'Luminance (as the eye sees)'), h('option', { value: 'lightness' }, 'Lightness'), h('option', { value: 'average' }, 'Average'));
    body = h('div', { class: 'pe-form' }, h('label', {}, 'Grey by ', mode));
    mode.addEventListener('change', () => body.dispatchEvent(new Event('input')));
    fn = p => desaturate(p, mode.value as GreyMode);
    isNone = () => false;
  }

  // ---- Live preview on the layer (put back when the window closes; Apply then makes it one undo step) ----
  let queued = false;
  // One work copy for the whole window (a new 48 MB copy per slider move on a big photo was slow).
  const copy = new Uint8ClampedArray(original.data.length);
  const preview = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      copy.set(original.data);
      fn({ data: copy, width: r.w, height: r.h });
      if (doc.selection) maskMix(original.data, copy, doc.selection, r, doc.width);
      layer.ctx.putImageData(new ImageData(copy, r.w, r.h), r.x, r.y);
      doc.render(r);
    });
  };
  body.addEventListener('input', preview);
  body.addEventListener('change', preview);
  if (kind === 'threshold' || kind === 'posterise' || kind === 'desaturate') preview();
  const ok = await shell.dialogs.ask({
    title: ADJUST_TITLES[kind],
    body,
    buttons: [{ label: 'Apply', value: true, primary: true }, { label: 'Cancel', value: false }],
    cancel: false,
  });
  await new Promise(res => requestAnimationFrame(res));
  layer.ctx.putImageData(original, r.x, r.y);
  doc.render(r);
  if (!ok || isNone()) return false;
  // Settings that change no pixel here (gamma on pure colours, say) do nothing, and leave a text layer as text.
  copy.set(original.data);
  fn({ data: copy, width: r.w, height: r.h });
  if (doc.selection) maskMix(original.data, copy, doc.selection, r, doc.width);
  if (copy.every((v, i) => v === original.data[i])) return false;
  beforeApply();
  return doc.changePixels(ADJUST_TITLES[kind], fn, r, layer);
}
