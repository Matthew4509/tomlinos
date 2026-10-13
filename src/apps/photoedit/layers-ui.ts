// Photo Editor's Layers panel: the layers top first, each with an eye to show or hide it, a small picture and its
// name; the active layer's blend mode, see-through amount and lock; and buttons to add, copy, raise, lower, merge and
// delete. Drag a layer to move it (or use the arrows). Double-click a name to rename it.
import { h, on } from '../../core/dom.ts';
import type { Doc, Layer } from './doc.ts';
import { BLEND_MODES, type BlendMode } from './layers.ts';

export interface LayerCommands {
  activate(layer: Layer): void;
  add(): void;
  duplicate(): void;
  remove(): void;
  raise(): void;
  lower(): void;
  mergeDown(): void;
  rename(layer: Layer): void;
  setVisible(layer: Layer, visible: boolean): void;
  setOpacity(layer: Layer, opacity: number, from: number): void;
  setMode(layer: Layer, mode: BlendMode): void;
  setLocked(layer: Layer, locked: boolean): void;
  moveTo(layer: Layer, index: number): void;
}

export function layersPanel(doc: Doc, cmd: LayerCommands, signal: AbortSignal) {
  const list = h('div', { class: 'pe-layer-list', role: 'listbox', 'aria-label': 'Layers, top first' });
  const mode = h('select', { class: 'field', 'aria-label': 'Blend mode', title: 'How this layer mixes with the layers below' },
    ...BLEND_MODES.map(b => h('option', { value: b.id }, b.label)));
  const opacity = h('input', { type: 'range', min: 0, max: 100, value: 100, 'aria-label': 'Layer opacity', title: 'How solid the layer is (0 = see-through)' });
  const opacityOut = h('span', { class: 'pe-num' }, '100%');
  const lock = h('input', { type: 'checkbox', 'aria-label': 'Lock this layer' });
  const btn = (glyph: string, label: string, fn: () => void) => {
    const b = h('button', { type: 'button', class: 'tool', title: label, 'aria-label': label }, glyph);
    on(b, 'click', fn, signal);
    return b;
  };
  const addBtn = btn('+', 'New layer', () => cmd.add());
  const dupBtn = btn('⧉', 'Duplicate layer', () => cmd.duplicate());
  const upBtn = btn('▲', 'Raise layer', () => cmd.raise());
  const downBtn = btn('▼', 'Lower layer', () => cmd.lower());
  const mergeBtn = btn('⤓', 'Merge down', () => cmd.mergeDown());
  const delBtn = btn('🗑', 'Delete layer', () => cmd.remove());
  const el = h('div', { class: 'pe-layers', role: 'region', 'aria-label': 'Layers' },
    h('div', { class: 'pe-layers-head' }, 'Layers'),
    h('div', { class: 'pe-layer-props' },
      h('label', { class: 'pe-opt' }, 'Mode ', mode),
      h('label', { class: 'pe-opt' }, 'Opacity ', opacity, opacityOut),
      h('label', { class: 'pe-opt' }, lock, ' Locked')),
    list,
    h('div', { class: 'pe-layer-btns' }, addBtn, dupBtn, upBtn, downBtn, mergeBtn, delBtn));

  const thumbs = new Map<Layer, HTMLCanvasElement>();
  let opacityFrom = -1;

  function drawThumb(layer: Layer) {
    const c = thumbs.get(layer);
    if (!c) return;
    const x = c.getContext('2d')!;
    x.clearRect(0, 0, c.width, c.height);
    const k = Math.min(c.width / doc.width, c.height / doc.height);
    const w = Math.max(1, doc.width * k), hh = Math.max(1, doc.height * k);
    x.imageSmoothingQuality = 'medium';
    x.drawImage(layer.canvas, (c.width - w) / 2, (c.height - hh) / 2, w, hh);
  }

  function refresh() {
    // The rows are made again: a row that had the keyboard would take it away with it (to the page, where the
    // editor's keys no longer reach), so the new active row gets it instead.
    const hadFocus = list.contains(document.activeElement);
    thumbs.clear();
    const rows = [...doc.layers].reverse().map(layer => {
      const index = doc.indexOf(layer);
      const active = layer === doc.active;
      const eye = h('button', { type: 'button', class: 'pe-eye', 'aria-pressed': String(layer.visible), title: layer.visible ? 'Hide this layer' : 'Show this layer', 'aria-label': `${layer.visible ? 'Hide' : 'Show'} “${layer.name}”` }, layer.visible ? '●' : '○');
      const thumb = h('canvas', { class: 'pe-thumb', width: 48, height: 36, 'aria-hidden': 'true' });
      thumbs.set(layer, thumb);
      const name = h('span', { class: 'pe-layer-name' }, layer.name);
      const badges = h('span', { class: 'pe-badges' }, layer.text ? 'T' : null, layer.locked ? ' 🔒' : null, layer.mode !== 'normal' ? ` ${BLEND_MODES.find(b => b.id === layer.mode)?.label ?? ''}` : null, layer.opacity < 1 ? ` ${Math.round(layer.opacity * 100)}%` : null);
      const row = h('div', { class: `pe-layer${active ? ' on' : ''}${layer.visible ? '' : ' hidden-layer'}`, role: 'option', 'aria-selected': String(active), tabindex: active ? '0' : '-1', draggable: 'true', title: 'Click to work on this layer; double-click the name to rename; drag to move' }, eye, thumb, h('span', { class: 'pe-layer-text' }, name, badges));
      on(eye, 'click', e => {
        e.stopPropagation();
        cmd.setVisible(layer, !layer.visible);
      }, signal);
      on(row, 'click', () => cmd.activate(layer), signal);
      on(row, 'dblclick', e => {
        if (e.target === eye) return;
        cmd.rename(layer);
      }, signal);
      on(row, 'keydown', (e: KeyboardEvent) => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          const next = doc.layers[index + (e.key === 'ArrowUp' ? 1 : -1)];
          if (next) {
            cmd.activate(next);
            (list.querySelector('.pe-layer.on') as HTMLElement | null)?.focus();
          }
        } else if (e.key === 'F2' || e.key === 'Enter') {
          e.preventDefault();
          cmd.rename(layer);
        }
      }, signal);
      on(row, 'dragstart', (e: DragEvent) => {
        e.dataTransfer?.setData('text/x-tomlinos-layer', String(layer.id));
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
        row.classList.add('dragging');
      }, signal);
      on(row, 'dragend', () => row.classList.remove('dragging'), signal);
      on(row, 'dragover', (e: DragEvent) => {
        if (!e.dataTransfer?.types.includes('text/x-tomlinos-layer')) return;
        e.preventDefault();
        const b = row.getBoundingClientRect();
        row.classList.toggle('drop-above', e.clientY < b.top + b.height / 2);
        row.classList.toggle('drop-below', e.clientY >= b.top + b.height / 2);
      }, signal);
      on(row, 'dragleave', () => row.classList.remove('drop-above', 'drop-below'), signal);
      on(row, 'drop', (e: DragEvent) => {
        e.preventDefault();
        const above = row.classList.contains('drop-above');
        row.classList.remove('drop-above', 'drop-below');
        const id = Number(e.dataTransfer?.getData('text/x-tomlinos-layer'));
        const moving = doc.layers.find(l => l.id === id);
        if (!moving || moving === layer) return;
        // The list shows the top first: "above" in the list is a higher index.
        const without = doc.layers.filter(l => l !== moving);
        const at = without.indexOf(layer) + (above ? 1 : 0);
        cmd.moveTo(moving, at);
      }, signal);
      return row;
    });
    list.replaceChildren(...rows);
    if (hadFocus) (list.querySelector('.pe-layer.on') as HTMLElement | null)?.focus({ preventScroll: true });
    for (const layer of doc.layers) drawThumb(layer);
    const a = doc.active;
    mode.value = a.mode;
    opacity.value = String(Math.round(a.opacity * 100));
    opacityOut.textContent = `${opacity.value}%`;
    lock.checked = a.locked;
    const i = doc.indexOf(a);
    upBtn.disabled = i >= doc.layers.length - 1;
    downBtn.disabled = i <= 0;
    mergeBtn.disabled = i <= 0;
    delBtn.disabled = doc.layers.length <= 1;
  }

  on(mode, 'change', () => cmd.setMode(doc.active, mode.value as BlendMode), signal);
  on(opacity, 'input', () => {
    if (opacityFrom < 0) opacityFrom = doc.active.opacity;
    opacityOut.textContent = `${opacity.value}%`;
    doc.active.opacity = Number(opacity.value) / 100;
    doc.render();
  }, signal);
  on(opacity, 'change', () => {
    const from = opacityFrom < 0 ? doc.active.opacity : opacityFrom;
    opacityFrom = -1;
    cmd.setOpacity(doc.active, Number(opacity.value) / 100, from);
  }, signal);
  on(lock, 'change', () => cmd.setLocked(doc.active, lock.checked), signal);

  let thumbTimer = 0;
  /** Redraws the small pictures a moment after the last change (not on every brush dab). */
  function refreshThumbs() {
    clearTimeout(thumbTimer);
    thumbTimer = window.setTimeout(() => {
      for (const layer of doc.layers) drawThumb(layer);
    }, 250);
  }
  signal.addEventListener('abort', () => clearTimeout(thumbTimer));

  return { el, refresh, refreshThumbs };
}
