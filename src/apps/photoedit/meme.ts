// Meme: white bars at the top, the bottom or both (added to the picture, or laid over it), and text boxes whose words
// fit themselves to the box: white with a black outline on the picture, black on a bar. The boxes are ordinary text
// layers (their settings carry a box), so Undo, the Layers panel and .ora files keep working; the bars are one plain
// layer. The panel down the side holds the settings and a field for each box's words; on the picture a box is dragged
// to move it, its squares stretch it, the arrow keys nudge it and Delete takes it away.
import { h, on } from '../../core/dom.ts';
import { toolIcon } from '../../shell/toolicons.ts';
import { drawnText, makeLayer, paintText, textBounds, type Doc, type Layer } from './doc.ts';
import { unionRect, type Rect } from './history.ts';
import type { TextSpec } from './ora.ts';
import type { Point } from './selection.ts';

export type BarsWhere = 'none' | 'top' | 'bottom' | 'both';

export interface BarsSettings {
  where: BarsWhere;
  colour: string;
  /** Each bar's height as a share of the picture's height (1 to 100). */
  percent: number;
  /** True: the bars are added to the picture (it grows); false: laid over it (the picture keeps its size). */
  extend: boolean;
}

export const DEFAULT_BARS: BarsSettings = { where: 'none', colour: '#ffffff', percent: 18, extend: true };
/** The font of new boxes (text.ts): heavy and plain, on the computer already. */
export const MEME_FONT = 'Arial Black';

/** Settings kept from before, checked; anything odd gives the usual ones. */
export function readBars(raw: unknown): BarsSettings {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_BARS };
  const r = raw as Partial<BarsSettings>;
  return {
    where: r.where === 'top' || r.where === 'bottom' || r.where === 'both' || r.where === 'none' ? r.where : DEFAULT_BARS.where,
    colour: /^#[0-9a-f]{6}$/i.test(String(r.colour)) ? String(r.colour) : DEFAULT_BARS.colour,
    percent: Number.isFinite(Number(r.percent)) ? Math.min(100, Math.max(1, Math.round(Number(r.percent)))) : DEFAULT_BARS.percent,
    extend: typeof r.extend === 'boolean' ? r.extend : DEFAULT_BARS.extend,
  };
}

/** The two bars' heights in pixels for a picture `height` tall (without bars). */
export function barHeights(height: number, s: BarsSettings): { top: number; bottom: number } {
  const px = Math.max(1, Math.round((height * Math.min(100, Math.max(1, s.percent))) / 100));
  return { top: s.where === 'top' || s.where === 'both' ? px : 0, bottom: s.where === 'bottom' || s.where === 'both' ? px : 0 };
}

/** Where the bars are on a canvas `w` by `hgt` (the bars included when they extend it). */
export function barRects(w: number, hgt: number, bars: { top: number; bottom: number }): Rect[] {
  const out: Rect[] = [];
  if (bars.top) out.push({ x: 0, y: 0, w, h: bars.top });
  if (bars.bottom) out.push({ x: 0, y: hgt - bars.bottom, w, h: bars.bottom });
  return out;
}

/**
 * Where a box kept at the top or bottom goes on a canvas `w` by `hgt`: filling that bar (a small margin all round),
 * or without a bar there, a band across that edge of the picture.
 */
export function dockRect(dock: 'top' | 'bottom', w: number, hgt: number, bars: { top: number; bottom: number }): Rect {
  const m = Math.max(2, Math.round(Math.min(w, hgt) * 0.02));
  const bar = dock === 'top' ? bars.top : bars.bottom;
  if (bar) {
    const inner = Math.max(8, bar - m);
    return { x: m, y: dock === 'top' ? Math.round((bar - inner) / 2) : hgt - bar + Math.round((bar - inner) / 2), w: Math.max(8, w - 2 * m), h: inner };
  }
  const picTop = bars.top, picBottom = hgt - bars.bottom;
  const band = Math.max(12, Math.round((picBottom - picTop) * 0.2));
  return { x: m, y: dock === 'top' ? picTop + m : picBottom - m - band, w: Math.max(8, w - 2 * m), h: band };
}

/** The colours a box gets where it stands: black on a bar; white with a black outline on the picture. */
export function boxStyle(onBar: boolean): Pick<TextSpec, 'colour' | 'outline'> {
  return onBar ? { colour: '#000000' } : { colour: '#ffffff', outline: { colour: '#000000', width: 0 } };
}

/** A new box's settings: empty (its placeholder shows until something is typed), its words fitting the box. */
export function newBox(r: Rect, dock: 'top' | 'bottom' | undefined, onBar: boolean, text = ''): TextSpec {
  return {
    text, family: MEME_FONT, size: 48, bold: true, italic: false, align: 'center', x: Math.round(r.x), y: Math.round(r.y),
    ...boxStyle(onBar), box: { w: Math.round(r.w), h: Math.round(r.h), fit: true, ...(dock ? { dock } : {}), auto: true },
  };
}

/** The spec with its box moved and stretched to `r` (and its colours following the place, while they are automatic). */
export function placeBox(t: TextSpec, r: Rect, keepDock: boolean, onBar?: boolean): TextSpec {
  const box = { ...t.box!, w: Math.max(8, Math.round(r.w)), h: Math.max(8, Math.round(r.h)) };
  if (!keepDock) delete box.dock;
  const out: TextSpec = { ...t, x: Math.round(r.x), y: Math.round(r.y), box };
  if (onBar !== undefined && box.auto) {
    delete out.outline;
    Object.assign(out, boxStyle(onBar));
  }
  return out;
}

export const boxRect = (t: TextSpec): Rect => ({ x: t.x, y: t.y, w: t.box?.w ?? 1, h: t.box?.h ?? 1 });
/** What a box shows (faintly, on the screen only) before anything is typed in it. */
export const placeholderOf = (t: TextSpec) => (t.box?.dock === 'top' ? 'Top text' : t.box?.dock === 'bottom' ? 'Bottom text' : 'Text');

export type BoxHandle = 'move' | 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se';
export const BOX_HANDLES: Array<Exclude<BoxHandle, 'move'>> = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export function handlePoint(r: Rect, hnd: Exclude<BoxHandle, 'move'>): Point {
  const x = hnd.includes('w') ? r.x : hnd.includes('e') ? r.x + r.w : r.x + r.w / 2;
  const y = hnd.includes('n') ? r.y : hnd.includes('s') ? r.y + r.h : r.y + r.h / 2;
  return { x, y };
}

/** The handle (or the inside, 'move') of box `r` under point `p`, `tol` picture pixels round each handle. */
export function boxHandleAt(r: Rect, p: Point, tol: number): BoxHandle | null {
  for (const hnd of BOX_HANDLES) {
    const q = handlePoint(r, hnd);
    if (Math.abs(p.x - q.x) <= tol && Math.abs(p.y - q.y) <= tol) return hnd;
  }
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h ? 'move' : null;
}

/** Box `r` dragged by `handle` by (dx, dy): moved, or stretched by that edge or corner; never smaller than `min`. */
export function dragBoxRect(r: Rect, handle: BoxHandle, dx: number, dy: number, min = 16): Rect {
  if (handle === 'move') return { x: r.x + dx, y: r.y + dy, w: r.w, h: r.h };
  let { x, y, w, h: hh } = r;
  if (handle.includes('w')) {
    const nw = Math.max(min, w - dx);
    x += w - nw;
    w = nw;
  } else if (handle.includes('e')) w = Math.max(min, w + dx);
  if (handle.includes('n')) {
    const nh = Math.max(min, hh - dy);
    y += hh - nh;
    hh = nh;
  } else if (handle.includes('s')) hh = Math.max(min, hh + dy);
  return { x, y, w, h: hh };
}

// ---- The panel and what the picture does while it is open --------------------------------------------------------

export interface MemeContext {
  doc: Doc;
  signal: AbortSignal;
  /** Every layer moved by (ox, oy) on a canvas nw by nh, as one undo step (photoedit.ts's Canvas size). */
  resizeCanvas(label: string, nw: number, nh: number, ox: number, oy: number): void;
  /** Why another layer cannot be added (null: it can). */
  noRoom(extra: number): string | null;
  alert(title: string, text: string): void;
  /** Finishes what is half done elsewhere (a stroke, a move) before the panel changes the picture. */
  settle(): void;
  redraw(): void;
  refresh(): void;
  zoom(): number;
  /** The bars last chosen, and keeping a new choice. */
  bars: BarsSettings;
  keepBars(s: BarsSettings): void;
  onClose(): void;
}

interface BarsInfo {
  settings: BarsSettings;
  top: number;
  bottom: number;
}
/** The layer each set of bars was drawn on, with how (kept with the layer, so Undo brings both back together). */
const barsInfo = new WeakMap<Layer, BarsInfo>();

export function memePanel(ctx: MemeContext) {
  const { doc, signal } = ctx;
  let open = false;
  let selected: Layer | null = null;
  /** Words being typed into a box: the settings before, made one undo step when the field is left. */
  let typing: { layer: Layer; before: TextSpec } | null = null;
  let drag: { layer: Layer; handle: BoxHandle; at: Point; start: TextSpec; moved: boolean } | null = null;

  const isBox = (l: Layer) => !!l.text?.box;
  const boxes = () => doc.layers.filter(isBox);
  const barsLayer = () => doc.layers.find(l => barsInfo.has(l)) ?? null;
  const currentBars = (): BarsInfo => {
    const l = barsLayer();
    return l ? barsInfo.get(l)! : { settings: { ...ctx.bars, where: 'none' }, top: 0, bottom: 0 };
  };
  /** The bars as placed on the canvas now (laid-over bars count as well: a docked box goes inside them too). */
  const placed = () => {
    const b = currentBars();
    return { top: b.top, bottom: b.bottom };
  };

  // ---- The panel ----
  const where = h('select', { class: 'field', 'aria-label': 'Bars' },
    ...([['none', 'None'], ['top', 'Top'], ['bottom', 'Bottom'], ['both', 'Top and bottom']] as const).map(([v, l]) => h('option', { value: v }, l)));
  const barColour = h('input', { type: 'color', value: ctx.bars.colour, 'aria-label': 'Bar colour', title: 'Bar colour' });
  const barPercent = h('input', { type: 'number', class: 'field num', min: 1, max: 100, value: ctx.bars.percent, 'aria-label': 'Bar height (% of the picture height)' });
  const barHow = h('select', { class: 'field', 'aria-label': 'How the bars go on' },
    h('option', { value: 'extend' }, 'Add to the picture'), h('option', { value: 'overlay' }, 'Lay over the picture'));
  const addBtn = h('button', { type: 'button', class: 'tool wide' }, 'Add text box');
  const doneBtn = h('button', { type: 'button', class: 'tool wide pe-meme-done' }, 'Done');
  const list = h('div', { class: 'pe-meme-list', role: 'list', 'aria-label': 'Text boxes' });
  const el = h('div', { class: 'pe-meme', role: 'region', 'aria-label': 'Meme', hidden: true },
    h('div', { class: 'pe-layers-head' }, 'Meme'),
    h('div', { class: 'pe-meme-part' },
      h('label', { class: 'pe-opt' }, 'Bars ', where),
      h('div', { class: 'pe-row3' }, h('label', { class: 'pe-opt' }, 'Colour ', barColour), h('label', { class: 'pe-opt' }, 'Height ', barPercent, '%')),
      h('label', { class: 'pe-opt' }, barHow)),
    h('div', { class: 'pe-meme-part' }, h('div', { class: 'pe-meme-row' }, h('span', { class: 'pe-meme-title' }, 'Text boxes'), addBtn), list),
    h('div', { class: 'pe-meme-foot' }, doneBtn));

  function chosenBars(): BarsSettings {
    const pct = Number(barPercent.value);
    return { where: where.value as BarsWhere, colour: barColour.value, percent: Number.isFinite(pct) && pct >= 1 ? Math.min(100, Math.round(pct)) : ctx.bars.percent, extend: barHow.value === 'extend' };
  }
  const barsChanged = () => {
    const next = chosenBars();
    ctx.keepBars(next);
    applyBars(next);
  };
  on(where, 'change', barsChanged, signal);
  on(barColour, 'change', barsChanged, signal);
  on(barPercent, 'change', barsChanged, signal);
  on(barHow, 'change', barsChanged, signal);
  on(addBtn, 'click', () => {
    ctx.settle();
    commitTyping();
    const r = { x: Math.round(doc.width * 0.1), y: Math.round(doc.height * 0.4), w: Math.round(doc.width * 0.8), h: Math.round(doc.height * 0.2) };
    const layer = addBox(newBox(r, undefined, false), 'Add text box');
    if (layer) focusField(layer);
  }, signal);
  on(doneBtn, 'click', () => close(), signal);

  /** A box's row: its words, size (fitting the box, or chosen), colour, outline, and Delete. */
  const rows = new Map<Layer, { row: HTMLElement; words: HTMLInputElement; fit: HTMLInputElement; size: HTMLInputElement; colour: HTMLInputElement; outline: HTMLInputElement }>();
  function rowFor(layer: Layer) {
    const t = layer.text!;
    const words = h('input', { type: 'text', class: 'field', value: t.text, placeholder: placeholderOf(t), 'aria-label': `Words of the text box`, maxlength: 2000 });
    const fit = h('input', { type: 'checkbox', checked: !!t.box?.fit, 'aria-label': 'Fit the words to the box' });
    const size = h('input', { type: 'number', class: 'field num', min: 4, max: 2000, value: t.size, disabled: !!t.box?.fit, 'aria-label': 'Text size' });
    const colour = h('input', { type: 'color', value: t.colour, 'aria-label': 'Text colour' });
    const outline = h('input', { type: 'checkbox', checked: !!t.outline, 'aria-label': 'Black outline' });
    const del = h('button', { type: 'button', class: 'tool pe-layer-tool', title: 'Delete this text box', 'aria-label': 'Delete text box' }, toolIcon('recycle'));
    const row = h('div', { class: 'pe-meme-box', role: 'listitem' }, h('div', { class: 'pe-meme-row' }, words, del),
      h('div', { class: 'pe-row3' }, h('label', { class: 'pe-opt', title: 'The size that fills the box' }, fit, 'Fit'), size, colour, h('label', { class: 'pe-opt' }, outline, 'Outline')));
    const change = (label: string, f: (t: TextSpec) => TextSpec) => {
      ctx.settle();
      commitTyping();
      if (!layer.text || !doc.layers.includes(layer)) return;
      select(layer);
      doc.setMeta(label, layer, { text: f(layer.text) });
    };
    on(row, 'focusin', () => select(layer), signal);
    on(words, 'input', () => {
      if (!layer.text || !doc.layers.includes(layer)) return;
      if (!typing || typing.layer !== layer) {
        commitTyping();
        typing = { layer, before: layer.text };
      }
      const prev = textBounds(layer);
      layer.text = { ...layer.text, text: words.value.slice(0, 2000) };
      paintText(layer);
      doc.render(unionRect(prev, textBounds(layer)));
      ctx.redraw();
    }, signal);
    on(words, 'change', () => commitTyping(), signal);
    on(words, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitTyping();
      }
    }, signal);
    on(fit, 'change', () => change(fit.checked ? 'Fit the words to the box' : 'Text size', t => ({ ...t, size: fit.checked ? t.size : fittedSize(layer), box: { ...t.box!, fit: fit.checked } })), signal);
    on(size, 'change', () => {
      const v = Math.round(Number(size.value));
      if (v >= 4 && v <= 2000) change('Text size', t => ({ ...t, size: v }));
    }, signal);
    on(colour, 'change', () => change('Text colour', t => ({ ...t, colour: colour.value, box: { ...t.box!, auto: false } })), signal);
    on(outline, 'change', () => change(outline.checked ? 'Outline' : 'No outline', t => {
      const out: TextSpec = { ...t, box: { ...t.box!, auto: false } };
      if (outline.checked) out.outline = { colour: '#000000', width: 0 };
      else delete out.outline;
      return out;
    }), signal);
    on(del, 'click', () => removeBox(layer), signal);
    return { row, words, fit, size, colour, outline };
  }
  /** The size a fitting box draws at now (kept when Fit is turned off, so nothing jumps). */
  function fittedSize(layer: Layer): number {
    layer.ctx.save();
    const size = drawnText(layer.text!, layer.ctx).size;
    layer.ctx.restore();
    return Math.max(4, Math.round(size));
  }

  /** Brings the panel's settings and rows into line with the picture (after Undo, a change in the Layers panel...). */
  function sync(): void {
    if (!open) return;
    const b = currentBars();
    if (document.activeElement !== where) where.value = b.settings.where;
    if (b.settings.where !== 'none') {
      barColour.value = b.settings.colour;
      barPercent.value = String(b.settings.percent);
      barHow.value = b.settings.extend ? 'extend' : 'overlay';
    }
    const now = boxes().reverse();
    if (selected && !now.includes(selected)) selected = null;
    if (typing && !now.includes(typing.layer)) typing = null;
    for (const [layer, r] of rows) if (!now.includes(layer)) {
      r.row.remove();
      rows.delete(layer);
    }
    now.forEach((layer, i) => {
      let r = rows.get(layer);
      if (!r) {
        r = rowFor(layer);
        rows.set(layer, r);
      }
      if (list.children[i] !== r.row) list.insertBefore(r.row, list.children[i] ?? null);
      const t = layer.text!;
      if (document.activeElement !== r.words && r.words.value !== t.text) r.words.value = t.text;
      r.words.placeholder = placeholderOf(t);
      r.fit.checked = !!t.box?.fit;
      r.size.disabled = !!t.box?.fit;
      // A box that fits its words shows the size they have now.
      if (document.activeElement !== r.size) r.size.value = String(t.box?.fit ? fittedSize(layer) : t.size);
      r.colour.value = t.colour;
      r.outline.checked = !!t.outline;
      r.row.classList.toggle('on', layer === selected);
    });
    list.dataset.empty = String(!now.length);
  }

  function select(layer: Layer | null): void {
    if (selected === layer) return;
    selected = layer;
    if (layer && doc.layers.includes(layer) && doc.active !== layer) {
      doc.active = layer;
      ctx.refresh();
    }
    for (const [l, r] of rows) r.row.classList.toggle('on', l === layer);
    ctx.redraw();
  }
  function focusField(layer: Layer): void {
    sync();
    rows.get(layer)?.words.focus();
  }

  /** The words typed so far into a box become one undo step. */
  function commitTyping(): void {
    if (!typing) return;
    const { layer, before } = typing;
    typing = null;
    const now = layer.text;
    if (!now || !doc.layers.includes(layer) || now.text === before.text) return;
    layer.text = before;
    paintText(layer);
    doc.setMeta('Meme text', layer, { text: now, name: now.text.split('\n')[0].slice(0, 40) || placeholderOf(now) });
  }

  function addBox(spec: TextSpec, label: string): Layer | null {
    const why = ctx.noRoom(1);
    if (why) {
      ctx.alert('No room for another layer', why);
      return null;
    }
    const layer = makeLayer(doc.width, doc.height, spec.text.split('\n')[0].slice(0, 40) || placeholderOf(spec), { text: spec });
    paintText(layer);
    doc.setLayers(label, [...doc.layers, layer], layer);
    selected = layer;
    return layer;
  }
  function removeBox(layer: Layer): void {
    ctx.settle();
    commitTyping();
    if (!doc.layers.includes(layer)) return;
    if (doc.layers.length < 2) return;
    const rest = doc.layers.filter(l => l !== layer);
    if (selected === layer) selected = null;
    doc.setLayers('Delete text box', rest, doc.active === layer ? rest[rest.length - 1] : doc.active);
    ctx.redraw();
  }

  /**
   * The bars as chosen, as one undo step: the old bars (and the room they added) go, the new ones come, and the boxes
   * kept at the top or bottom move into them (or back onto the picture). A bar that comes with no box gets one.
   */
  function applyBars(next: BarsSettings, label = 'Meme bars', join = true): void {
    ctx.settle();
    commitTyping();
    const old = barsLayer();
    const was = currentBars();
    const added = (b: { top: number; bottom: number }, extend: boolean) => (extend ? b : { top: 0, bottom: 0 });
    const oldAdd = added(was, was.settings.extend);
    const baseH = doc.height - oldAdd.top - oldAdd.bottom;
    const want = barHeights(baseH, next);
    const newAdd = added(want, next.extend);
    const nothing = !old && next.where === 'none';
    if (nothing) return;
    if (next.where !== 'none' && !old) {
      const why = ctx.noRoom(1);
      if (why) {
        ctx.alert('No room for another layer', why);
        sync();
        return;
      }
    }
    const mark = doc.history.pushes;
    if (old) {
      const rest = doc.layers.filter(l => l !== old);
      doc.setLayers(label, rest, doc.active === old ? rest[rest.length - 1] : doc.active);
    }
    const nh = baseH + newAdd.top + newAdd.bottom;
    if (nh !== doc.height || newAdd.top !== oldAdd.top) ctx.resizeCanvas(label, doc.width, nh, 0, newAdd.top - oldAdd.top);
    if (next.where !== 'none') {
      const layer = makeLayer(doc.width, doc.height, 'Meme bars');
      layer.ctx.fillStyle = next.colour;
      for (const r of barRects(doc.width, doc.height, want)) layer.ctx.fillRect(r.x, r.y, r.w, r.h);
      barsInfo.set(layer, { settings: { ...next }, top: want.top, bottom: want.bottom });
      // Added bars go under everything (the picture does not cover them); laid-over bars go over the picture, under
      // the text boxes.
      const firstBox = doc.layers.findIndex(isBox);
      const at = next.extend ? 0 : firstBox < 0 ? doc.layers.length : firstBox;
      doc.setLayers(label, [...doc.layers.slice(0, at), layer, ...doc.layers.slice(at)], doc.active);
    }
    // Boxes kept at an edge follow it.
    const docked = boxes().filter(l => l.text!.box!.dock);
    for (const l of docked) {
      const dock = l.text!.box!.dock!;
      const onBar = dock === 'top' ? want.top > 0 : want.bottom > 0;
      doc.setMeta(label, l, { text: placeBox(l.text!, dockRect(dock, doc.width, doc.height, want), true, onBar) });
    }
    // A new bar with no box in it gets one.
    for (const dock of ['top', 'bottom'] as const) {
      const bar = dock === 'top' ? want.top : want.bottom;
      if (!bar || docked.some(l => l.text!.box!.dock === dock)) continue;
      addBox(newBox(dockRect(dock, doc.width, doc.height, want), dock, true), label);
    }
    // Joined into one step here, unless the caller joins it with more (a join inside a join would count wrongly).
    if (join) doc.history.squash(mark, label);
    ctx.refresh();
    sync();
    ctx.redraw();
  }

  // ---- Opening and closing ----
  function openPanel(): void {
    ctx.settle();
    open = true;
    el.hidden = false;
    rows.clear();
    list.replaceChildren();
    const b = currentBars();
    where.value = b.settings.where;
    barColour.value = b.settings.where !== 'none' ? b.settings.colour : ctx.bars.colour;
    barPercent.value = String(b.settings.where !== 'none' ? b.settings.percent : ctx.bars.percent);
    barHow.value = (b.settings.where !== 'none' ? b.settings.extend : ctx.bars.extend) ? 'extend' : 'overlay';
    // A quick start: with no boxes yet, the bars last chosen and a box at the top and the bottom (in the bars when
    // there are bars, on the picture when not), each waiting for its words.
    if (!boxes().length) {
      const mark = doc.history.pushes;
      if (!barsLayer() && ctx.bars.where !== 'none') {
        where.value = ctx.bars.where;
        applyBars({ ...ctx.bars }, 'Meme', false);
      }
      const placedNow = placed();
      for (const dock of ['top', 'bottom'] as const) {
        if (boxes().some(l => l.text!.box!.dock === dock)) continue;
        const onBar = dock === 'top' ? placedNow.top > 0 : placedNow.bottom > 0;
        if (!onBar && placedNow.top + placedNow.bottom > 0) continue;
        addBox(newBox(dockRect(dock, doc.width, doc.height, placedNow), dock, onBar), 'Meme');
      }
      doc.history.squash(mark, 'Meme');
    }
    const top = boxes()[boxes().length - 1] ?? null;
    selected = null;
    sync();
    select(top);
    ctx.refresh();
    ctx.redraw();
    if (top) rows.get(top)?.words.focus();
  }
  function close(): void {
    if (!open) return;
    ctx.settle();
    commitTyping();
    // Boxes left empty were never drawn: they go (one undo step).
    const empty = boxes().filter(l => !l.text!.text.trim());
    if (empty.length && doc.layers.length > empty.length) {
      const rest = doc.layers.filter(l => !empty.includes(l));
      doc.setLayers(empty.length === 1 ? 'Remove the empty text box' : 'Remove the empty text boxes', rest, rest.includes(doc.active) ? doc.active : rest[rest.length - 1]);
    }
    open = false;
    el.hidden = true;
    selected = null;
    drag = null;
    ctx.onClose();
    ctx.redraw();
    ctx.refresh();
  }

  // ---- On the picture ----
  const rectOf = (l: Layer) => boxRect(l.text!);
  function hitBox(p: Point): Layer | null {
    for (const l of [...boxes()].reverse()) {
      if (!l.visible) continue;
      const r = rectOf(l);
      if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) return l;
    }
    return null;
  }
  /** A press on the picture while the panel is open: on a box's square or inside it, that box is dragged. */
  function pointerDown(p: Point): void {
    commitTyping();
    const tol = 6 / ctx.zoom();
    const sel = selected && doc.layers.includes(selected) && selected.text?.box ? selected : null;
    let layer: Layer | null = null;
    let handle: BoxHandle | null = sel ? boxHandleAt(rectOf(sel), p, tol) : null;
    if (sel && handle) layer = sel;
    else {
      layer = hitBox(p);
      handle = layer ? 'move' : null;
    }
    select(layer);
    if (!layer || !handle || layer.locked) {
      drag = null;
      return;
    }
    drag = { layer, handle, at: p, start: layer.text!, moved: false };
  }
  function pointerMove(p: Point): string | null {
    if (drag) {
      const d = drag;
      const dx = p.x - d.at.x, dy = p.y - d.at.y;
      if (!d.moved && Math.hypot(dx, dy) * ctx.zoom() < 3) return null;
      d.moved = true;
      const prev = textBounds(d.layer);
      d.layer.text = placeBox(d.start, dragBoxRect(boxRect(d.start), d.handle, Math.round(dx), Math.round(dy)), false);
      paintText(d.layer);
      doc.render(unionRect(prev, textBounds(d.layer)));
      ctx.redraw();
      return null;
    }
    const tol = 6 / ctx.zoom();
    const hnd = selected && selected.text?.box ? boxHandleAt(rectOf(selected), p, tol) : null;
    const cursors: Record<BoxHandle, string> = { move: 'move', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' };
    return hnd ? cursors[hnd] : hitBox(p) ? 'move' : null;
  }
  function pointerUp(): void {
    const d = drag;
    drag = null;
    if (!d || !d.moved) return;
    const now = d.layer.text;
    d.layer.text = d.start;
    paintText(d.layer);
    if (now && doc.layers.includes(d.layer)) doc.setMeta(d.handle === 'move' ? 'Move text box' : 'Resize text box', d.layer, { text: now });
    else doc.render();
  }
  /** Keys on the picture (never in a field): the arrows nudge the chosen box, Delete takes it away. True: used. */
  function key(e: KeyboardEvent): boolean {
    if (!selected || !doc.layers.includes(selected) || !selected.text?.box) return false;
    const steps: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const s = steps[e.key];
    if (s && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (selected.locked) return true;
      const n = e.shiftKey ? 10 : 1;
      const t = selected.text;
      doc.setMeta('Nudge text box', selected, { text: placeBox(t, { ...boxRect(t), x: t.x + s[0] * n, y: t.y + s[1] * n }, false) });
      ctx.redraw();
      return true;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      removeBox(selected);
      return true;
    }
    if (e.key === 'Escape') {
      select(null);
      return true;
    }
    return false;
  }

  /** The boxes' outlines, the chosen one's squares, and an empty box's placeholder (on the screen only). */
  function drawOverlay(c: CanvasRenderingContext2D, px: number): void {
    if (!open) return;
    for (const l of boxes()) {
      if (!l.visible) continue;
      const t = l.text!;
      const r = boxRect(t);
      const on = l === selected;
      c.save();
      c.lineWidth = px;
      c.setLineDash(on ? [] : [4 * px, 3 * px]);
      c.strokeStyle = '#000000';
      c.strokeRect(r.x, r.y, r.w, r.h);
      c.setLineDash(on ? [] : [4 * px, 3 * px]);
      c.lineDashOffset = on ? 0 : 4 * px;
      c.strokeStyle = on ? '#2f6db8' : '#ffffff';
      c.lineWidth = on ? 2 * px : px;
      c.strokeRect(r.x, r.y, r.w, r.h);
      if (!t.text.trim()) {
        c.setLineDash([]);
        c.globalAlpha = 0.55;
        c.font = `bold ${Math.max(10, Math.min(r.h * 0.5, 48))}px "Arial Black", Arial, sans-serif`;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillStyle = t.colour;
        c.strokeStyle = t.colour === '#000000' ? '#ffffff' : '#000000';
        c.lineWidth = 2 * px;
        c.strokeText(placeholderOf(t), r.x + r.w / 2, r.y + r.h / 2, r.w);
        c.fillText(placeholderOf(t), r.x + r.w / 2, r.y + r.h / 2, r.w);
        c.globalAlpha = 1;
      }
      if (on) {
        c.setLineDash([]);
        const s = 7 * px;
        for (const hnd of BOX_HANDLES) {
          const q = handlePoint(r, hnd);
          c.fillStyle = '#ffffff';
          c.strokeStyle = '#2f6db8';
          c.lineWidth = px;
          c.fillRect(q.x - s / 2, q.y - s / 2, s, s);
          c.strokeRect(q.x - s / 2, q.y - s / 2, s, s);
        }
      }
      c.restore();
    }
  }

  return {
    el,
    get isOpen() {
      return open;
    },
    get selected() {
      return selected;
    },
    get dragging() {
      return !!drag;
    },
    open: openPanel,
    close,
    toggle: () => (open ? close() : openPanel()),
    sync,
    commitTyping,
    pointerDown,
    pointerMove,
    pointerUp,
    key,
    drawOverlay,
    /** Bars and boxes, for the tests: the bars layer's place on the canvas. */
    bars: () => ({ ...placed(), settings: currentBars().settings }),
  };
}
