// TOMLIN CAD: a 2D drawing program for drawing a part out on a job and machining it at home in a CAM program. The
// window is laid out as classic CAD/CAM programs of the early 2000s were: a menu bar (File, Edit, View, Geometry,
// Utils, Help), two rows of small toolbar pictures, a column of tools down the left, the Layers panel, a dark blue
// drawing area with scale marks, the snaps down the right, a command line for typed points and numbers, and a status
// bar with the layer and the pointer's X and Y. No ribbon. Shapes are kept as exact lines, arcs, circles, ellipses
// and curves in millimetres or inches; the drawing is saved as a .tcad file (JSON).
import { css, h, on } from '../core/dom.ts';
import { baseName, parentPath, uniqueName } from '../fs/names.ts';
import type { MenuItem } from '../shell/menu.ts';
import { pickFile, pickSave } from '../shell/filepicker.ts';
import { saveOver } from '../shell/savefile.ts';
import type { AppDef } from '../shell/types.ts';
import { APPS } from './catalog.ts';
import { menuBar } from './sheet/classic-ui.ts';
import { boxOfShapes, chainFrom, distToShape, inWindow, moveShape, scaleShape, touchesBox } from './cad/edit.ts';
import { P, add, dist, mul, sub, unit, type Pt } from './cad/geom.ts';
import { cadIcon, type CadIcon } from './cad/icons.ts';
import { parseNumber, parsePoint, parseSize } from './cad/input.ts';
import {
  COLOUR_NAMES, CONSTRUCTION, CadProblem, LAYER_COLOURS, LINE_TYPES, TYPE_NAMES, colourName, describe, type LineType, fmt, newDrawing, readTcad, writeTcad, type Drawing, type Ent, type Layer, type Shape, type Units,
} from './cad/model.ts';
import { SNAP_NAMES, SNAP_ORDER, findSnaps, type Snap, type SnapMode } from './cad/snap.ts';
import { COMMAND_WORDS, TOOLS, type PolarAnswer, type Tool, type ToolCtx, type ToolId } from './cad/tools.ts';
import { explode, join } from './cad/modify.ts';
import { MAX_SCALE, MIN_SCALE, fitView, render, toWorld, type View } from './cad/view.ts';

const SETTINGS = '/System/cad.json';

interface Settings {
  snaps: SnapMode[];
  arrows: boolean;
  white: boolean;
  large: boolean;
  layersPanel: boolean;
  ortho: boolean;
  gridOn: boolean;
  gridSnap: boolean;
}

const DEFAULT_SNAPS: SnapMode[] = ['end', 'mid', 'centre', 'intersection', 'quadrant'];


interface Snapshot {
  ents: Ent[];
  layers: Layer[];
  current: string;
  version: number;
}

export const cadApp: AppDef = {
  ...APPS.cad,
  async launch(app, arg) {
    const shell = app.shell;
    const signal = app.signal;
    app.root.classList.add('cad');

    // ---- Settings kept between windows -----------------------------------------------------------------------------
    const settings: Settings = { snaps: [...DEFAULT_SNAPS], arrows: false, white: false, large: false, layersPanel: true, ortho: false, gridOn: false, gridSnap: false };
    try {
      const saved = JSON.parse(await shell.fs.readText(SETTINGS)) as Partial<Settings>;
      if (Array.isArray(saved.snaps)) settings.snaps = saved.snaps.filter((s): s is SnapMode => SNAP_ORDER.includes(s as SnapMode));
      for (const k of ['arrows', 'white', 'large', 'layersPanel', 'ortho', 'gridOn', 'gridSnap'] as const) if (typeof saved[k] === 'boolean') settings[k] = saved[k];
    } catch {
      // Nothing kept yet: the usual settings.
    }
    let settingsTimer = 0;
    function keepSettings(): void {
      clearTimeout(settingsTimer);
      settingsTimer = window.setTimeout(() => {
        void shell.fs.writeText(SETTINGS, JSON.stringify(settings), { hidden: true }).catch(() => {
          // Not kept this time; the window still works.
        });
      }, 400);
    }

    // ---- The drawing and its file -------------------------------------------------------------------------------
    let drawing: Drawing = newDrawing();
    let path: string | null = null;
    let label = 'Drawing';
    let loadedId = '';
    let folderHint: string | null = null;
    if (arg) {
      try {
        const entry = await shell.fs.stat(arg);
        if (!entry || entry.kind !== 'file') throw new CadProblem('That file is not there any more. It may have been moved or deleted.');
        const text = new TextDecoder().decode(await shell.fs.readFile(arg));
        const read = readTcad(text);
        drawing = read.drawing;
        path = arg;
        label = baseName(arg);
        loadedId = entry.id;
        if (read.skipped) shell.toast(`${read.skipped} item${read.skipped === 1 ? '' : 's'} of a kind this version does not know ${read.skipped === 1 ? 'was' : 'were'} left out.`);
      } catch (error) {
        const why = error instanceof CadProblem ? error.message : 'This drawing could not be read.';
        app.root.append(h('div', { class: 'app-message', role: 'alert' }, h('p', {}, why), h('p', { class: 'dialog-detail' }, 'The file was not changed.')));
        if (!(error instanceof CadProblem)) await shell.report('Could not open the drawing', error);
        return;
      }
    }
    let nextId = drawing.ents.reduce((m, e) => Math.max(m, e.id), 0) + 1;
    let version = 0;
    let savedVersion = 0;
    let undoStack: Snapshot[] = [];
    let redoStack: Snapshot[] = [];
    const selected = new Set<number>();

    // ---- What is showing -------------------------------------------------------------------------------------------
    let view: View = { cx: 150, cy: 100, scale: 2 };
    let viewBefore: View[] = [];
    let fitted = false;
    let gridSpacing = drawing.units === 'mm' ? 10 : 0.5;
    let snapsOff = false;
    let tool: Tool | null = null;
    let toolId: ToolId | null = null;
    let lastToolId: ToolId | null = null;
    let panMode = false;
    let cursor = P(0, 0);
    let pointerIn = false;
    let snaps: Snap[] = [];
    let snapAt = 0;
    let hover: number | null = null;
    let box: { a: Pt; b: Pt; crossing: boolean } | null = null;

    const layerMap = () => new Map(drawing.layers.map(l => [l.name, l]));
    const layerOf = (name: string) => drawing.layers.find(l => l.name === name);
    /** Items that can be picked and chosen: on layers that are on and not locked. */
    const live = () => {
      const m = layerMap();
      return drawing.ents.filter(e => {
        const l = m.get(e.layer);
        return !!l && l.on && !l.locked;
      });
    };
    /** Items on layers that are showing, locked or not: what snaps, trim and extend see. */
    const shown = () => {
      const m = layerMap();
      return drawing.ents.filter(e => m.get(e.layer)?.on);
    };
    const unitWord = () => (drawing.units === 'mm' ? 'mm' : 'in');
    const f = (v: number) => fmt(v, drawing.units);

    // ---- Changes and undo ------------------------------------------------------------------------------------------
    const snap = (): Snapshot => ({ ents: drawing.ents, layers: drawing.layers.map(l => ({ ...l })), current: drawing.current, version });
    function commit(apply: () => void): void {
      undoStack.push(snap());
      if (undoStack.length > 300) undoStack.shift();
      redoStack = [];
      apply();
      version++;
      afterChange();
    }
    function restore(s: Snapshot): void {
      // Which layers are showing is not taken back by Undo (it is a way of looking, not a change to the shapes).
      const showing = new Map(drawing.layers.map(l => [l.name, l.on]));
      drawing.ents = s.ents;
      drawing.layers = s.layers.map(l => ({ ...l, on: showing.get(l.name) ?? l.on }));
      drawing.current = s.current;
      version = s.version;
      for (const id of [...selected]) if (!drawing.ents.some(e => e.id === id)) selected.delete(id);
      afterChange();
    }
    function undo(): void {
      const s = undoStack.pop();
      if (!s) return say('Nothing to undo.');
      redoStack.push(snap());
      restore(s);
    }
    function redo(): void {
      const s = redoStack.pop();
      if (!s) return say('Nothing to redo.');
      undoStack.push(snap());
      restore(s);
    }
    /** Something that is kept in the file but not undone changed (a layer shown or hidden, the current layer). */
    function touched(): void {
      version++;
      afterChange();
    }
    function afterChange(): void {
      refreshTitle();
      drawLayers();
      refreshStatus();
      paint();
    }
    function refreshTitle(): void {
      app.setDirty(version !== savedVersion);
      app.setTitle(`${label} - TOMLIN CAD`);
    }

    function addShapes(shapes: Shape[], layerName = drawing.current): void {
      if (!shapes.length) return;
      commit(() => {
        if (!layerOf(layerName)) drawing.layers = [...drawing.layers, { name: layerName, colour: layerName === CONSTRUCTION ? '#e040e0' : '#ffffff', on: true, locked: false, lineType: layerName === CONSTRUCTION ? 'dashed' : 'continuous' }];
        drawing.ents = [...drawing.ents, ...shapes.map(s => ({ ...s, id: nextId++, layer: layerName }) as Ent)];
      });
    }

    // ---- Messages: the command history and the status bar ------------------------------------------------------
    const history = h('div', { class: 'cad-history', 'aria-live': 'polite' });
    function say(text: string, problem = false): void {
      history.append(h('div', { class: problem ? 'cad-said cad-problem' : 'cad-said' }, problem ? `Cannot: ${text}` : text));
      while (history.children.length > 30) history.firstElementChild!.remove();
      history.scrollTop = history.scrollHeight;
    }
    const problem = (text: string) => say(text, true);

    // ---- The tools' view of the window -----------------------------------------------------------------------------
    const ctx: ToolCtx = {
      units: () => drawing.units,
      ents: live,
      visible: shown,
      selection: () => drawing.ents.filter(e => selected.has(e.id)),
      select(ids) {
        selected.clear();
        for (const id of ids) selected.add(id);
        refreshStatus();
        paint();
      },
      add: (shapes, layer) => addShapes(shapes, layer),
      change(changed, added, removed = []) {
        if (!changed.length && !added.length && !removed.length) return;
        commit(() => {
          if (removed.length) {
            const gone = new Set(removed);
            drawing.ents = drawing.ents.filter(e => !gone.has(e.id));
            for (const id of removed) selected.delete(id);
          }
          const byId = new Map(changed.map(c => [c.id, c.shape]));
          drawing.ents = drawing.ents.map(e => {
            const s = byId.get(e.id);
            return s ? ({ ...s, id: e.id, layer: e.layer } as Ent) : e;
          });
          const made = added.map(a => ({ ...a.shape, id: nextId++, layer: a.layer }) as Ent);
          drawing.ents = [...drawing.ents, ...made];
        });
      },
      undoLast: undo,
      say: text => say(text),
      problem,
      fmt: f,
      list(e) {
        void shell.dialogs.alert(TYPE_NAMES[e.type], describe(e, drawing.units).join('\n'));
      },
      zoomTo(a, b) {
        setView(fitView({ x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) }, canvasW(), canvasH()));
      },
      askPolar,
      finished() {
        if (tool?.done) endTool(true);
      },
    };

    // ---- Tools -----------------------------------------------------------------------------------------------------
    function startTool(id: ToolId): void {
      if (tool) say(`${tool.title}: stopped.`);
      panMode = false;
      tool = TOOLS[id].make(ctx);
      toolId = id;
      lastToolId = id;
      say(`${tool.title}.`);
      syncToolButtons();
      refreshPrompt();
      updatePointer();
      keyboardBack();
    }
    function endTool(quiet = false): void {
      if (tool && !quiet && !tool.done) say(`${tool.title}: ended.`);
      tool = null;
      toolId = null;
      snaps = [];
      syncToolButtons();
      refreshPrompt();
      paint();
    }
    /** Enter, a right-click, or Space: finish the tool's step, or start the last tool again. */
    function enterKey(): void {
      if (!tool) {
        if (lastToolId) startTool(lastToolId);
        return;
      }
      const goOn = tool.enter();
      if (!goOn || tool.done) endTool(true);
      else afterInput();
    }
    function afterInput(): void {
      if (tool?.done) endTool(true);
      else {
        refreshPrompt();
        updatePointer();
      }
    }
    function cancel(): void {
      if (tool) endTool();
      else if (selected.size) {
        selected.clear();
        refreshStatus();
        paint();
      }
      panMode = false;
      syncToolButtons();
    }

    /** A clicked point after snaps, ortho and the grid. */
    function effectivePoint(): Pt {
      if (snaps.length) return snaps[snapAt % snaps.length].p;
      const base = tool?.base() ?? null;
      if (settings.ortho && base) {
        const d = sub(cursor, base);
        return Math.abs(d.x) >= Math.abs(d.y) ? P(cursor.x, base.y) : P(base.x, cursor.y);
      }
      if (settings.gridSnap && !snapsOff) return P(Math.round(cursor.x / gridSpacing) * gridSpacing, Math.round(cursor.y / gridSpacing) * gridSpacing);
      return cursor;
    }

    /** Hands typed text to the tool: a point, a size, a number, a word; or, with no tool, a command. */
    function submit(text: string): void {
      const t = text.trim();
      const lw = t.toLowerCase();
      if (!tool) {
        if (!t) return enterKey();
        const id = COMMAND_WORDS[lw];
        if (id) startTool(id);
        else problem(`“${t}” is not a command. Choose a tool from the menus or toolbars, or type one such as line, circle, rect, move.`);
        return;
      }
      if (!t) return enterKey();
      const want = tool.want();
      say(`${tool.title}: ${t}`);
      if (/^[a-z]+$/.test(lw) && tool.word?.(lw)) return afterInput();
      if (want.size && tool.size) {
        const sz = parseSize(t);
        if (sz) {
          tool.size(sz.w, sz.h);
          return afterInput();
        }
      }
      if (want.point && tool.point) {
        const r = parsePoint(t, tool.base());
        if (r && 'problem' in r) return problem(r.problem);
        if (r) {
          tool.point(r.p);
          return afterInput();
        }
      }
      const n = parseNumber(t);
      if (n !== null) {
        if (want.number && tool.number) {
          tool.number(n, cursor);
          return afterInput();
        }
        if (want.point && tool.point) {
          const b = tool.base();
          if (!b) return problem('Type a point as x,y (for example 0,0).');
          let d = sub(pointerIn ? cursor : add(b, P(1, 0)), b);
          if (settings.ortho) d = Math.abs(d.x) >= Math.abs(d.y) ? P(Math.sign(d.x) || 1, 0) : P(0, Math.sign(d.y) || 1);
          tool.point(add(b, mul(unit(d), n)));
          return afterInput();
        }
      }
      if (COMMAND_WORDS[lw]) {
        startTool(COMMAND_WORDS[lw]);
        return;
      }
      problem(`“${t}” does not answer “${tool.prompt()}”.`);
    }

    // ---- Selection -------------------------------------------------------------------------------------------------
    function hitAt(screen: Pt, filter?: (e: Ent) => boolean): Ent | null {
      const q = toWorld(view, canvasW(), canvasH(), screen);
      const reach = 6 / view.scale;
      let best: Ent | null = null;
      let bestD = Infinity;
      for (const e of live()) {
        if (filter && !filter(e)) continue;
        const d = distToShape(e, q);
        if (d <= reach && d < bestD) {
          bestD = d;
          best = e;
        }
      }
      return best;
    }
    function clickSelect(screen: Pt, add: boolean): void {
      const e = hitAt(screen);
      if (!add) selected.clear();
      if (e) {
        if (add && selected.has(e.id)) selected.delete(e.id);
        else selected.add(e.id);
      }
      refreshStatus();
      paint();
    }
    function boxSelect(a: Pt, b: Pt, crossing: boolean, add: boolean): void {
      const bx = { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
      if (!add) selected.clear();
      for (const e of live()) if (crossing ? touchesBox(e, bx) : inWindow(e, bx)) selected.add(e.id);
      refreshStatus();
      paint();
    }
    function deleteSelected(): void {
      if (!selected.size) return say('Nothing is chosen to delete.');
      const n = selected.size;
      commit(() => {
        drawing.ents = drawing.ents.filter(e => !selected.has(e.id));
      });
      selected.clear();
      say(`${n} item${n === 1 ? '' : 's'} deleted.`);
      refreshStatus();
    }
    function selectAll(): void {
      selected.clear();
      for (const e of live()) selected.add(e.id);
      refreshStatus();
      paint();
    }
    function invertSelection(): void {
      const now = new Set(selected);
      selected.clear();
      for (const e of live()) if (!now.has(e.id)) selected.add(e.id);
      refreshStatus();
      paint();
    }
    async function chooseLayer(title: string, text: string, ok: string): Promise<string | null> {
      const select = h('select', { class: 'field', 'aria-label': 'Layer' }, ...drawing.layers.map(l => h('option', { value: l.name }, `${l.name} (${colourName(l.colour)})`)));
      select.value = drawing.current;
      const body = h('div', { class: 'cad-dialog' }, h('p', {}, text), h('label', { class: 'cad-row' }, h('span', {}, 'Layer'), select));
      const yes = await shell.dialogs.ask<boolean>({ title, body, buttons: [{ label: ok, value: true, primary: true }, { label: 'Cancel', value: false }], cancel: false, focus: () => select });
      return yes ? select.value : null;
    }
    async function selectByLayer(): Promise<void> {
      const name = await chooseLayer('Select by layer', 'Choose every item on this layer.', 'Choose them');
      if (name === null) return;
      selected.clear();
      for (const e of live()) if (e.layer === name) selected.add(e.id);
      say(`${selected.size} item${selected.size === 1 ? '' : 's'} on ${name} chosen.`);
      refreshStatus();
      paint();
    }
    async function selectByColour(): Promise<void> {
      const colours = [...new Set(drawing.layers.map(l => l.colour))];
      const select = h('select', { class: 'field', 'aria-label': 'Colour' }, ...colours.map(c => h('option', { value: c }, colourName(c))));
      const body = h('div', { class: 'cad-dialog' }, h('p', {}, 'Choose every item drawn in this colour (the colour of its layer).'), h('label', { class: 'cad-row' }, h('span', {}, 'Colour'), select));
      const yes = await shell.dialogs.ask<boolean>({ title: 'Select by colour', body, buttons: [{ label: 'Choose them', value: true, primary: true }, { label: 'Cancel', value: false }], cancel: false, focus: () => select });
      if (!yes) return;
      const layers = new Set(drawing.layers.filter(l => l.colour === select.value).map(l => l.name));
      selected.clear();
      for (const e of live()) if (layers.has(e.layer)) selected.add(e.id);
      say(`${selected.size} item${selected.size === 1 ? '' : 's'} chosen.`);
      refreshStatus();
      paint();
    }
    async function deleteLayerItems(): Promise<void> {
      const name = await chooseLayer('Delete a layer’s items', 'Delete every item on this layer (the layer itself stays). Undo brings them back.', 'Delete them');
      if (name === null) return;
      const n = drawing.ents.filter(e => e.layer === name).length;
      if (!n) return say(`There is nothing on ${name}.`);
      commit(() => {
        drawing.ents = drawing.ents.filter(e => e.layer !== name);
      });
      for (const id of [...selected]) if (!drawing.ents.some(e => e.id === id)) selected.delete(id);
      say(`${n} item${n === 1 ? '' : 's'} on ${name} deleted.`);
    }

    // ---- CAD and layer actions on the chosen items ---------------------------------------------------------------
    const chosenEnts = () => drawing.ents.filter(e => selected.has(e.id));
    function joinChosen(): void {
      const sel = chosenEnts();
      if (!sel.length) return problem('Choose the lines and arcs to join first (a crossing box round them, or double-click one for its chain), then CAD > Join.');
      const { made, leftOut } = join(sel);
      if (!made.length) return problem(`Nothing joined: no two of the chosen lines or arcs meet end to end${leftOut ? ` (${leftOut} chosen item${leftOut === 1 ? ' is' : 's are'} of a kind that is not joined: ellipses, curves, circles, closed shapes)` : ''}.`);
      const removed = made.flatMap(m => m.from);
      ctx.change([], made.map(m => ({ shape: m.shape, layer: m.layer })), removed);
      const closed = made.filter(m => m.shape.type === 'poly' && m.shape.closed).length;
      ctx.select(drawing.ents.slice(-made.length).map(e => e.id));
      say(`${removed.length} items joined into ${made.length} geometr${made.length === 1 ? 'y' : 'ies'} (${closed} closed)${leftOut ? `; ${leftOut} left as they were (ellipses, curves, circles or closed shapes are not joined)` : ''}.`);
    }
    function explodeChosen(): void {
      const polys = chosenEnts().filter(e => e.type === 'poly');
      if (!polys.length) return problem('Choose the polylines to break into lines and arcs first.');
      const added: Array<{ shape: Shape; layer: string }> = [];
      for (const e of polys) {
        const parts = explode(e);
        if (typeof parts !== 'string') for (const shape of parts) added.push({ shape, layer: e.layer });
      }
      ctx.change([], added, polys.map(e => e.id));
      say(`${polys.length} polyline${polys.length === 1 ? '' : 's'} broken into ${added.length} lines and arcs.`);
    }
    async function moveToLayer(target?: string): Promise<void> {
      const sel = chosenEnts();
      if (!sel.length) return problem('Choose the items to move to another layer first.');
      const name = target ?? (await chooseLayer('Move to a layer', `Put the ${sel.length} chosen item${sel.length === 1 ? '' : 's'} on this layer.`, 'Move them'));
      if (name === null) return;
      if (layerOf(name)?.locked) return problem(`${name} is locked: unlock it first (its padlock in the Layers panel).`);
      ctx.change(sel.map(e => ({ id: e.id, shape: e })), []);
      commitLayerOf(sel.map(e => e.id), name);
      say(`${sel.length} item${sel.length === 1 ? '' : 's'} moved to ${name}.`);
    }
    /** Puts items on a layer (the shape change above was the undo step; this changes only which layer). */
    function commitLayerOf(ids: number[], name: string): void {
      const set = new Set(ids);
      drawing.ents = drawing.ents.map(e => (set.has(e.id) ? { ...e, layer: name } : e));
      afterChange();
    }
    function information(): void {
      const byType = new Map<string, number>();
      for (const e of drawing.ents) byType.set(TYPE_NAMES[e.type], (byType.get(TYPE_NAMES[e.type]) ?? 0) + 1);
      const box = boxOfShapes(drawing.ents);
      const lines = [
        `File: ${path ?? 'not saved yet'}`,
        `Units: ${drawing.units === 'mm' ? 'millimetres' : 'inches'}`,
        `Items: ${drawing.ents.length}${byType.size ? ` (${[...byType].map(([k, n]) => `${n} ${k.toLowerCase()}${n === 1 ? '' : 's'}`).join(', ')})` : ''}`,
        `Layers: ${drawing.layers.length} (${drawing.layers.map(l => `${l.name}: ${colourName(l.colour).toLowerCase()}, ${l.on ? 'showing' : 'hidden'}${l.locked ? ', locked' : ''}`).join('; ')})`,
        box ? `Extents: from ${f(box.x0)}, ${f(box.y0)} to ${f(box.x1)}, ${f(box.y1)} (${f(box.x1 - box.x0)} x ${f(box.y1 - box.y0)} ${unitWord()})` : 'Extents: nothing drawn yet (construction lines have no ends)',
        `Chosen now: ${selected.size}`,
      ];
      void shell.dialogs.alert('Information', lines.join('\n'));
    }

    // ---- Layer settings -----------------------------------------------------------------------------------------
    function layerProblem(v: string, except?: string): string | null {
      const t = v.trim();
      if (!t) return 'Give the layer a name.';
      if (t.length > 64) return 'At most 64 letters.';
      if (drawing.layers.some(l => l.name === t && l.name !== except)) return 'There is a layer with that name already.';
      return null;
    }
    async function renameLayer(l: Layer): Promise<void> {
      const name = await shell.dialogs.prompt({ title: 'Rename the layer', label: 'Name', value: l.name, ok: 'Rename', check: v => layerProblem(v, l.name) });
      if (name === null || name.trim() === l.name) return;
      const old = l.name;
      const now = name.trim();
      commit(() => {
        drawing.layers = drawing.layers.map(x => (x.name === old ? { ...x, name: now } : x));
        drawing.ents = drawing.ents.map(e => (e.layer === old ? { ...e, layer: now } : e));
        if (drawing.current === old) drawing.current = now;
      });
      say(`Layer ${old} is now ${now}.`);
    }
    async function colourLayer(l: Layer): Promise<void> {
      const list = h('div', { class: 'cad-colours', role: 'radiogroup', 'aria-label': 'Colour' }, ...Object.entries(COLOUR_NAMES).map(([hex, name]) => {
        const radio = h('input', { type: 'radio', name: 'cad-colour', value: hex, checked: hex === l.colour });
        const sw = h('span', { class: 'cad-swatch', 'aria-hidden': 'true' });
        css(sw, { background: hex });
        return h('label', { class: 'cad-check' }, radio, sw, ` ${name}`);
      }));
      const ok = await shell.dialogs.ask<boolean>({ title: `Colour of ${l.name}`, body: h('div', { class: 'cad-dialog' }, list), buttons: [{ label: 'OK', value: true, primary: true }, { label: 'Cancel', value: false }], cancel: false });
      const chosen = list.querySelector<HTMLInputElement>('input:checked')?.value;
      if (!ok || !chosen || chosen === l.colour) return;
      commit(() => {
        drawing.layers = drawing.layers.map(x => (x.name === l.name ? { ...x, colour: chosen } : x));
      });
    }
    function lineTypeOf(l: Layer, t: LineType): void {
      commit(() => {
        drawing.layers = drawing.layers.map(x => (x.name === l.name ? { ...x, lineType: t } : x));
      });
    }
    function lockLayer(l: Layer): void {
      l.locked = !l.locked;
      if (l.locked) for (const e of drawing.ents) if (e.layer === l.name) selected.delete(e.id);
      if (l.locked && drawing.current === l.name) say(`${l.name} is locked: its items cannot be chosen or changed (new items can still be drawn on it).`);
      else say(l.locked ? `${l.name} is locked: its items cannot be chosen or changed.` : `${l.name} is unlocked.`);
      touched();
    }
    async function deleteLayer(l: Layer): Promise<void> {
      if (drawing.layers.length === 1) return problem('A drawing keeps at least one layer.');
      const n = drawing.ents.filter(e => e.layer === l.name).length;
      const rest = drawing.layers.filter(x => x.name !== l.name);
      let moveTo: string | null = null;
      if (n) {
        const select = h('select', { class: 'field', 'aria-label': 'Layer' }, h('option', { value: '' }, 'Delete them too'), ...rest.map(x => h('option', { value: x.name }, `Move them to ${x.name}`)));
        const body = h('div', { class: 'cad-dialog' }, h('p', {}, `${l.name} has ${n} item${n === 1 ? '' : 's'} on it. Undo brings everything back.`), h('label', { class: 'cad-row' }, h('span', {}, 'Its items'), select));
        const yes = await shell.dialogs.ask<boolean>({ title: `Delete the layer ${l.name}?`, body, buttons: [{ label: 'Delete the layer', value: true, danger: true }, { label: 'Cancel', value: false }], cancel: false, focus: () => select });
        if (!yes) return;
        moveTo = select.value || null;
      } else if (!(await shell.dialogs.confirm({ title: `Delete the layer ${l.name}?`, text: 'Nothing is on it. Undo brings it back.', ok: 'Delete the layer', danger: true, cancel: 'Cancel' }))) return;
      commit(() => {
        drawing.layers = rest;
        drawing.ents = moveTo ? drawing.ents.map(e => (e.layer === l.name ? { ...e, layer: moveTo! } : e)) : drawing.ents.filter(e => e.layer !== l.name);
        if (drawing.current === l.name) drawing.current = rest[0].name;
      });
      for (const id of [...selected]) if (!drawing.ents.some(e => e.id === id)) selected.delete(id);
      say(moveTo ? `Layer ${l.name} deleted; its items are on ${moveTo}.` : `Layer ${l.name} deleted${n ? ` with its ${n} item${n === 1 ? '' : 's'}` : ''}.`);
    }
    function layerMenu(l: Layer): MenuItem[] {
      return [
        { label: 'Draw on this layer', checked: drawing.current === l.name, action: () => {
          drawing.current = l.name;
          l.on = true;
          touched();
        } },
        { label: l.on ? 'Hide' : 'Show', action: () => {
          l.on = !l.on;
          touched();
        } },
        { label: l.locked ? 'Unlock' : 'Lock', action: () => lockLayer(l) },
        { separator: true },
        { label: 'Rename...', action: () => void renameLayer(l) },
        { label: 'Colour...', action: () => void colourLayer(l) },
        { label: 'Line type', submenu: (Object.keys(LINE_TYPES) as LineType[]).map(t => ({ label: LINE_TYPES[t], checked: l.lineType === t, action: () => lineTypeOf(l, t) })) },
        { separator: true },
        { label: 'Move the chosen items here', disabled: !selected.size, action: () => void moveToLayer(l.name) },
        { label: 'Delete the layer...', danger: true, action: () => void deleteLayer(l) },
      ];
    }

    // ---- Small windows -------------------------------------------------------------------------------------------
    function numberRow(labelText: string, value: number): { input: HTMLInputElement; row: HTMLElement } {
      const input = h('input', { type: 'text', inputmode: 'decimal', class: 'field cad-num', value: String(value), 'aria-label': labelText });
      return { input, row: h('label', { class: 'cad-row' }, h('span', {}, labelText), input) };
    }
    async function askForm<T>(title: string, rows: HTMLElement[], read: () => T | string): Promise<T | null> {
      const problemEl = h('p', { class: 'dialog-problem', role: 'alert' });
      const body = h('div', { class: 'cad-dialog' }, ...rows, problemEl);
      try {
        for (;;) {
          const ok = await shell.dialogs.ask<boolean>({ title, body, buttons: [{ label: 'OK', value: true, primary: true }, { label: 'Cancel', value: false }], cancel: false, focus: () => body.querySelector('input') });
          if (!ok) return null;
          const out = read();
          if (typeof out !== 'string') return out;
          problemEl.textContent = out;
        }
      } finally {
        // Once the box has gone (and the desktop has put the keyboard back), it goes to the drawing or the boxes.
        setTimeout(keyboardBack, 0);
      }
    }
    async function askPolar(): Promise<PolarAnswer | null> {
      const count = numberRow('How many in all, the original included', 6);
      const angle = numberRow('Angle to fill (degrees; 360 = all the way round)', 360);
      const rotate = h('input', { type: 'checkbox', checked: true });
      const rotRow = h('label', { class: 'cad-check' }, rotate, ' Turn the copies as they go round');
      return askForm<PolarAnswer>('Copy round a centre', [count.row, angle.row, rotRow], () => {
        const n = parseNumber(count.input.value);
        const a = parseNumber(angle.input.value);
        if (n === null || !Number.isInteger(n) || n < 2 || n > 10000) return 'How many in all: a whole number from 2 to 10000.';
        if (a === null || a === 0 || Math.abs(a) > 360) return 'The angle: above 0 and at most 360 (minus for clockwise).';
        return { count: n, angle: a, rotate: rotate.checked };
      });
    }
    async function arrayRect(): Promise<void> {
      const sel = drawing.ents.filter(e => selected.has(e.id));
      if (!sel.length) return problem('Choose the items to copy first (click them or drag a box), then Edit > Arrays > Rectangular.');
      const b = boxOfShapes(sel);
      const across = b ? b.x1 - b.x0 : 0;
      const up = b ? b.y1 - b.y0 : 0;
      const rows = numberRow('Rows', 2);
      const cols = numberRow('Columns', 3);
      const rowGap = numberRow(`Distance between rows (${unitWord()}, centre to centre; minus goes down)`, Number(f(up * 1.5 || 10)));
      const colGap = numberRow(`Distance between columns (${unitWord()}, centre to centre; minus goes left)`, Number(f(across * 1.5 || 10)));
      const answer = await askForm('Rectangular array', [rows.row, cols.row, rowGap.row, colGap.row], () => {
        const r = parseNumber(rows.input.value);
        const c = parseNumber(cols.input.value);
        const dy = parseNumber(rowGap.input.value);
        const dx = parseNumber(colGap.input.value);
        if (r === null || c === null || !Number.isInteger(r) || !Number.isInteger(c) || r < 1 || c < 1) return 'Rows and columns: whole numbers, 1 or more.';
        if (r * c < 2) return 'With one row and one column there is nothing to copy.';
        if (r * c * sel.length > 100000) return 'That makes more than 100,000 items.';
        if (dy === null || dx === null) return 'The distances must be numbers.';
        return { r, c, dx, dy };
      });
      if (!answer) return;
      const added: Array<{ shape: Shape; layer: string }> = [];
      for (let i = 0; i < answer.r; i++) {
        for (let j = 0; j < answer.c; j++) {
          if (!i && !j) continue;
          for (const e of sel) {
            const { id: _id, layer, ...s } = e;
            added.push({ shape: moveShape(s as Shape, P(j * answer.dx, i * answer.dy)), layer });
          }
        }
      }
      ctx.change([], added);
      say(`${answer.r} x ${answer.c} array made (${added.length} new items).`);
    }
    async function gridDialog(): Promise<void> {
      const g = numberRow(`Grid spacing (${unitWord()})`, gridSpacing);
      const out = await askForm('Grid', [g.row], () => {
        const v = parseNumber(g.input.value);
        return v !== null && v > 0 ? v : 'The spacing must be a number above 0.';
      });
      if (out === null) return;
      gridSpacing = out;
      settings.gridOn = true;
      keepSettings();
      refreshStatus();
      paint();
    }
    async function unitsDialog(): Promise<void> {
      const mm = h('input', { type: 'radio', name: 'cad-units', value: 'mm', checked: drawing.units === 'mm' });
      const inch = h('input', { type: 'radio', name: 'cad-units', value: 'inch', checked: drawing.units === 'inch' });
      const convert = h('input', { type: 'checkbox', checked: true });
      const body = h('div', { class: 'cad-dialog' },
        h('label', { class: 'cad-check' }, mm, ' Millimetres'), h('label', { class: 'cad-check' }, inch, ' Inches'),
        h('label', { class: 'cad-check' }, convert, ' Change the sizes too (1 inch = 25.4 mm), so the part stays the same size'));
      const ok = await shell.dialogs.ask<boolean>({ title: 'Units', body, buttons: [{ label: 'OK', value: true, primary: true }, { label: 'Cancel', value: false }], cancel: false });
      const units: Units = inch.checked ? 'inch' : 'mm';
      if (!ok || units === drawing.units) return;
      const k = units === 'inch' ? 1 / 25.4 : 25.4;
      commit(() => {
        if (convert.checked) drawing.ents = drawing.ents.map(e => ({ ...scaleShape(e, P(0, 0), k), id: e.id, layer: e.layer }) as Ent);
        drawing.units = units;
      });
      if (convert.checked) setView({ cx: view.cx * k, cy: view.cy * k, scale: view.scale / k }, false);
      gridSpacing = units === 'mm' ? 10 : 0.5;
      say(convert.checked ? `Now in ${units === 'mm' ? 'millimetres' : 'inches'}; the sizes were changed to match.` : `Now in ${units === 'mm' ? 'millimetres' : 'inches'}; the numbers were kept as they were.`);
    }
    function showHelp(): void {
      void shell.dialogs.alert('What TOMLIN CAD does', [
        'Draws: lines, polylines, rectangles (two corners, centre and size, rounded corners), circles (centre and radius or diameter, two points, three points, touching two items with a radius, touching three items), arcs (three points; centre, start, end; start, end, radius; touching two items), ellipses, polygons, slots, curves through points, points, construction lines, and lines touching arcs and circles.',
        'Snaps: end, middle, centre, intersection, quadrant, nearest, perpendicular, tangent and the grid. Tab steps through the snaps under the pointer; F3 turns them all off and on.',
        'Edits (Edit menu): choose by clicking, by a window (drag to the right: wholly inside) or a crossing box (drag to the left: touching), a chain, a layer or a colour; move, copy, rotate, mirror, scale; arrays in rows and columns, round a centre, or along a line; delete.',
        'Typed points: X and Y in their boxes (an empty box is 0), or in the X box x,y   @dx,dy (from the last point)   @length<angle. Numbers may be sums, such as 600/2+15.',
        'CAD menu: trim, extend, break (at a point or between two), fillet and chamfer (two lines or arcs, one corner of a polyline, or every corner), offset (lines, arcs, circles and polylines of them; not ellipses or curves), join lines and arcs into closed geometries, close, set the start point, reverse, explode, and arrows showing which way each runs.',
        'Layers: show, hide, lock, rename, colour, line type, delete, move items onto a layer. Utils: measure a distance or an angle, area and perimeter, list an item, information about the drawing.',
        'Saves its own drawings (.tcad). Not here yet: text and dimensions; DXF out and in; printing. Never here: CAM (toolpaths, G-code), 3D.',
      ].join('\n\n'));
    }
    function showKeys(): void {
      void shell.dialogs.alert('Keys', [
        'Points: type X, Enter, Y, Enter (an empty box is 0). Or type a whole point in the X box: 600,400   @dx,dy (from the last point)   @length<angle.',
        'Done, a right-click, or Enter in the drawing: finish a tool (a polyline, a curve), or start the last tool again.   Escape: stop the tool, or clear the choice.',
        'F3 snaps on and off   F7 grid   F8 ortho (straight across or up)   F9 snap to the grid   Tab: the next snap under the pointer.',
        'Ctrl+Z undo   Ctrl+Y redo   Ctrl+A choose all   Delete: delete the chosen items   Ctrl+S save   Ctrl+Shift+S save as   Ctrl+O open.',
        'Mouse wheel: zoom at the pointer.   Middle button drag, or the Pan tool: move the view.   Double-click an item: choose its chain.',
        'Alt and the underlined letter, or F10: the menus.   Start typing anywhere in the drawing to use the command line.',
      ].join('\n\n'));
    }

    // ---- Files -------------------------------------------------------------------------------------------------
    const bytes = () => new TextEncoder().encode(writeTcad(drawing));
    async function save(): Promise<boolean> {
      if (!path) return saveAs();
      try {
        const v = version;
        const entry = await saveOver(shell, path, bytes(), loadedId);
        if (!entry) return false;
        loadedId = entry.id;
        savedVersion = v;
        refreshTitle();
        shell.toast(`Saved “${entry.name}”.`);
        return true;
      } catch (error) {
        await shell.report('Could not save', error);
        return false;
      }
    }
    async function saveAs(): Promise<boolean> {
      const folder = path ? parentPath(path) : folderHint ?? '/Documents';
      let taken: string[] = [];
      try {
        taken = (await shell.fs.list(folder, true)).map(e => e.name);
      } catch {
        // Saving will say the folder is gone.
      }
      const stem = label.replace(/\.tcad$/i, '');
      const chosen = await pickSave(shell, { title: 'Save as', folder, name: uniqueName(`${stem}.tcad`, taken), accept: ['tcad'], ok: 'Save' });
      if (!chosen) return false;
      let target = chosen.path;
      if (!/\.tcad$/i.test(target)) target += '.tcad';
      try {
        let replacing = chosen.replace;
        if (target !== chosen.path) {
          const existing = await shell.fs.stat(target).catch(() => null);
          if (existing && !(await shell.dialogs.confirm({ title: 'Replace it?', text: `“${baseName(target)}” already exists. Replace it with this one?`, ok: 'Replace', danger: true, cancel: 'Cancel' }))) return false;
          replacing = !!existing;
        }
        const v = version;
        const entry = await shell.fs.writeFile(target, bytes(), replacing ? {} : { mustBeNew: true });
        path = target;
        label = entry.name;
        loadedId = entry.id;
        folderHint = null;
        savedVersion = v;
        refreshTitle();
        shell.toast(`Saved “${entry.name}”.`);
        return true;
      } catch (error) {
        await shell.report('Could not save', error);
        return false;
      }
    }
    async function openDrawing(): Promise<void> {
      const chosen = await pickFile(shell, { title: 'Open a drawing', folder: path ? parentPath(path) : '/Documents', accept: ['tcad'], ok: 'Open' });
      if (!chosen) return;
      // A new window nothing was drawn in gives way to the drawing opened from it.
      const untouched = !path && !drawing.ents.length && !undoStack.length;
      await shell.openApp('cad', chosen);
      if (untouched) app.close();
    }

    // ---- The view --------------------------------------------------------------------------------------------------
    const canvas = h('canvas', { class: 'cad-canvas', tabindex: '0', 'aria-label': 'Drawing area. Type points and numbers to use the command line.' });
    const canvasWrap = h('div', { class: 'cad-canvas-wrap' }, canvas);
    const canvasW = () => canvasWrap.clientWidth || 800;
    const canvasH = () => canvasWrap.clientHeight || 500;
    function setView(v: View, remember = true): void {
      if (remember) {
        viewBefore.push(view);
        if (viewBefore.length > 50) viewBefore.shift();
      }
      view = { ...v, scale: Math.max(MIN_SCALE, Math.min(MAX_SCALE, v.scale)) };
      updatePointer();
      paint();
    }
    function zoomFit(): void {
      const shown = drawing.ents.filter(e => layerOf(e.layer)?.on);
      setView(fitView(boxOfShapes(shown), canvasW(), canvasH()));
    }
    function zoomBy(k: number, at?: Pt): void {
      const w = canvasW();
      const hgt = canvasH();
      const centre = at ?? P(w / 2, hgt / 2);
      const before = toWorld(view, w, hgt, centre);
      const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, view.scale * k));
      // Keep the drawing point under the pointer where it is.
      const next: View = { cx: before.x - (centre.x - w / 2) / scale, cy: before.y + (centre.y - hgt / 2) / scale, scale };
      setView(next, false);
    }
    function zoomPrevious(): void {
      const v = viewBefore.pop();
      if (!v) return say('There is no earlier view.');
      view = v;
      updatePointer();
      paint();
    }

    let frame = 0;
    function paint(): void {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const w = canvasW();
        const hgt = canvasH();
        const dpr = window.devicePixelRatio || 1;
        if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hgt * dpr)) {
          canvas.width = Math.round(w * dpr);
          canvas.height = Math.round(hgt * dpr);
          css(canvas, { width: w, height: hgt });
        }
        const c = canvas.getContext('2d');
        if (!c) return;
        c.setTransform(dpr, 0, 0, dpr, 0, 0);
        let preview: Shape[] = [];
        if (tool && pointerIn) {
          try {
            // A shape with a missing or impossible number is not drawn (JSON writes those as null).
            preview = tool.preview(effectivePoint()).filter(s => !JSON.stringify(s).includes('null'));
          } catch {
            preview = [];
          }
        }
        render(c, w, hgt, view, {
          ents: drawing.ents, layers: layerMap(), selected, hover, preview, snap: snaps.length && pointerIn ? snaps[snapAt % snaps.length] : null,
          box, grid: gridSpacing, gridOn: settings.gridOn, white: settings.white, units: drawing.units, arrows: settings.arrows,
        });
      });
    }

    /** Works out snaps and what is under the pointer, then shows the X and Y. */
    function updatePointer(): void {
      const want = tool?.want() ?? {};
      if (tool && want.point && pointerIn && !snapsOff && !panning) {
        const modes = new Set(settings.snaps);
        snaps = findSnaps(shown(), { at: cursor, reach: 14 / view.scale, modes, from: tool.base(), grid: 0, magnet: 40 / view.scale, onItem: 8 / view.scale });
        snapAt = 0;
      } else snaps = [];
      if (pointerIn && !panning && (!tool || want.pick || want.select)) {
        const e = hitAt(lastScreen, tool && want.pick ? tool.pickFilter : undefined);
        hover = e ? e.id : null;
      } else hover = null;
      refreshXY();
      paint();
    }

    // ---- Pointer --------------------------------------------------------------------------------------------------
    let lastScreen = P(0, 0);
    let panning: { x: number; y: number; view: View } | null = null;
    let down: { screen: Pt; world: Pt; shift: boolean } | null = null;
    let spaceDown = false;
    const screenOf = (e: MouseEvent) => {
      const r = canvas.getBoundingClientRect();
      return P(e.clientX - r.left, e.clientY - r.top);
    };
    on(canvas, 'pointerenter', () => {
      pointerIn = true;
    }, signal);
    on(canvas, 'pointerleave', () => {
      pointerIn = false;
      snaps = [];
      hover = null;
      paint();
    }, signal);
    on(canvas, 'pointerdown', (e: PointerEvent) => {
      canvas.focus({ preventScroll: true });
      const s = screenOf(e);
      if (e.button === 1 || (e.button === 0 && (panMode || spaceDown))) {
        e.preventDefault();
        panning = { x: s.x, y: s.y, view };
        canvas.setPointerCapture(e.pointerId);
        canvas.classList.add('panning');
        return;
      }
      if (e.button !== 0) return;
      canvas.setPointerCapture(e.pointerId);
      down = { screen: s, world: toWorld(view, canvasW(), canvasH(), s), shift: e.shiftKey || e.ctrlKey };
    }, signal);
    on(canvas, 'pointermove', (e: PointerEvent) => {
      pointerIn = true;
      const s = screenOf(e);
      lastScreen = s;
      cursor = toWorld(view, canvasW(), canvasH(), s);
      if (panning) {
        view = { ...panning.view, cx: panning.view.cx - (s.x - panning.x) / view.scale, cy: panning.view.cy + (s.y - panning.y) / view.scale };
        cursor = toWorld(view, canvasW(), canvasH(), s);
        refreshXY();
        paint();
        return;
      }
      if (down && (!tool || tool.want().select) && dist(down.screen, s) > 4) {
        box = { a: down.world, b: cursor, crossing: s.x < down.screen.x };
      }
      updatePointer();
    }, signal);
    on(canvas, 'pointerup', (e: PointerEvent) => {
      const s = screenOf(e);
      if (panning) {
        if (dist(P(panning.x, panning.y), s) > 2) viewBefore.push(panning.view);
        panning = null;
        canvas.classList.remove('panning');
        updatePointer();
        return;
      }
      if (!down || e.button !== 0) return;
      const d = down;
      down = null;
      if (box) {
        const b = box;
        box = null;
        boxSelect(b.a, b.b, b.crossing, d.shift);
        if (tool?.want().select) refreshPrompt();
        return;
      }
      if (!tool) return clickSelect(s, d.shift);
      const want = tool.want();
      if (want.pick && tool.pick) {
        const hit = hitAt(s, tool.pickFilter);
        if (!hit) return problem('There is nothing there that this tool can use. ' + tool.prompt() + '.');
        tool.pick(hit, toWorld(view, canvasW(), canvasH(), s));
        return afterInput();
      }
      if (want.point && tool.point) {
        tool.point(effectivePoint());
        return afterInput();
      }
      if (want.select) {
        clickSelect(s, true);
        refreshPrompt();
      }
    }, signal);
    on(canvas, 'dblclick', (e: MouseEvent) => {
      if (tool) return;
      const hit = hitAt(screenOf(e));
      if (!hit) return;
      const chain = chainFrom(live(), hit);
      selected.clear();
      for (const c of chain) selected.add(c.id);
      say(`${chain.length} item${chain.length === 1 ? '' : 's'} in the chain chosen.`);
      refreshStatus();
      paint();
    }, signal);
    on(canvas, 'contextmenu', (e: MouseEvent) => {
      e.preventDefault();
      if (tool) enterKey();
      else {
        shell.menus.show([
          { label: 'Repeat the last tool', disabled: !lastToolId, action: () => lastToolId && startTool(lastToolId) },
          { separator: true },
          { label: 'Zoom fit', action: zoomFit },
          { label: 'Zoom previous', action: zoomPrevious },
          { separator: true },
          { label: 'Delete the chosen items', disabled: !selected.size, action: deleteSelected },
          { label: 'Clear the choice', disabled: !selected.size, action: () => ctx.select([]) },
        ], e.clientX, e.clientY, { returnFocus: canvas });
      }
    }, signal);
    on(canvas, 'wheel', (e: WheelEvent) => {
      e.preventDefault();
      const s = screenOf(e);
      const steps = e.deltaMode === 1 ? e.deltaY / 3 : e.deltaY / 100;
      zoomBy(Math.pow(1.2, -Math.max(-5, Math.min(5, steps))), s);
      cursor = toWorld(view, canvasW(), canvasH(), s);
      updatePointer();
    }, signal, { passive: false });

    // ---- The parts of the window -------------------------------------------------------------------------------
    const toolButtons = new Map<string, HTMLButtonElement>();
    function btn(icon: CadIcon, title: string, run: () => void, key?: string): HTMLButtonElement {
      const b = h('button', { type: 'button', class: 'cad-btn', title, 'aria-label': title }, cadIcon(icon));
      on(b, 'mousedown', (e: MouseEvent) => e.preventDefault(), signal);
      on(b, 'click', () => {
        run();
        // A tool that asks for typing has put the keyboard in its boxes; otherwise it goes back to the drawing.
        if (!b.closest('.cad-snaps') && !commandRow.contains(document.activeElement)) canvas.focus({ preventScroll: true });
      }, signal);
      if (key) {
        b.setAttribute('aria-pressed', 'false');
        toolButtons.set(key, b);
      }
      return b;
    }
    const toolBtn = (icon: CadIcon, id: ToolId) => btn(icon, TOOLS[id].name, () => (toolId === id ? endTool() : startTool(id)), id);
    const sep = () => h('span', { class: 'cad-sep', 'aria-hidden': 'true' });
    function syncToolButtons(): void {
      for (const [key, b] of toolButtons) b.setAttribute('aria-pressed', String(key === 'pan' ? panMode : key === 'arrows' ? settings.arrows : key === toolId));
    }
    const panBtn = btn('pan', 'Pan: drag to move the view (the middle button does this too)', () => {
      endTool(true);
      panMode = !panMode;
      syncToolButtons();
      refreshPrompt();
    }, 'pan');
    const selectBtn = btn('select', 'Select: click items, or drag a box (to the right: wholly inside; to the left: touching)', () => {
      endTool(true);
      panMode = false;
      syncToolButtons();
      refreshPrompt();
    });

    const row1 = h('div', { class: 'cad-tb', role: 'toolbar', 'aria-label': 'Standard and drawing tools' },
      btn('new', 'New drawing', () => void shell.openApp('cad')), btn('open', 'Open... (Ctrl+O)', () => void openDrawing()), btn('save', 'Save (Ctrl+S)', () => void save()), sep(),
      btn('undo', 'Undo (Ctrl+Z)', undo), btn('redo', 'Redo (Ctrl+Y)', redo), sep(),
      toolBtn('line', 'line'), toolBtn('polyline', 'polyline'), toolBtn('rect', 'rect'), toolBtn('circle', 'circle-cr'), toolBtn('arc', 'arc-3p'), toolBtn('ellipse', 'ellipse'),
      toolBtn('polygon', 'polygon-in'), toolBtn('slot', 'slot'), toolBtn('spline', 'spline'), toolBtn('point', 'point'));
    const row2 = h('div', { class: 'cad-tb', role: 'toolbar', 'aria-label': 'Edit and construction tools' },
      toolBtn('move', 'move'), toolBtn('copy', 'copy'), toolBtn('rotate', 'rotate'), toolBtn('mirror', 'mirror'), toolBtn('scale', 'scale'),
      btn('arrayLine', 'Rectangular array: rows and columns of the chosen items', () => void arrayRect()), toolBtn('arrayPolar', 'array-polar'),
      btn('delete', 'Delete the chosen items (Delete)', deleteSelected), toolBtn('chain', 'chain'), sep(),
      toolBtn('xlineH', 'xline-h'), toolBtn('xlineV', 'xline-v'), toolBtn('xlineAngle', 'xline-angle'), toolBtn('xlineOffset', 'xline-offset'), sep(),
      toolBtn('tanLine', 'tan-point'), toolBtn('tanTwo', 'tan-two'), toolBtn('circleTtr', 'circle-ttr'), toolBtn('circleTtt', 'circle-ttt'), sep(),
      toolBtn('measure', 'measure'), toolBtn('list', 'list'));
    const row3 = h('div', { class: 'cad-tb', role: 'toolbar', 'aria-label': 'CAD tools' },
      toolBtn('trim', 'trim'), toolBtn('extend', 'extend'), toolBtn('breakPoint', 'break-point'), toolBtn('breakTwo', 'break-two'), sep(),
      toolBtn('fillet', 'fillet'), toolBtn('filletAll', 'fillet-all'), toolBtn('chamfer', 'chamfer'), toolBtn('offset', 'offset'), sep(),
      btn('join', 'Join the chosen lines and arcs into geometries', joinChosen), btn('explode', 'Explode the chosen polylines into lines and arcs', explodeChosen),
      toolBtn('closeGeo', 'close'), toolBtn('startPoint', 'start'), toolBtn('reverse', 'reverse'),
      btn('direction', 'Show which way lines and polylines run', () => setArrows(!settings.arrows), 'arrows'), sep(),
      toolBtn('angle', 'measure-angle'), toolBtn('area', 'area'), btn('info', 'Information about the drawing', information));
    // Each tool is on one bar only: the left column holds choosing and the view, the rows above everything else.
    const leftCol = h('div', { class: 'cad-col', role: 'toolbar', 'aria-orientation': 'vertical', 'aria-label': 'Choosing and the view' },
      selectBtn, panBtn, btn('zoomFit', 'Zoom fit: the whole drawing', zoomFit), toolBtn('zoomWindow', 'zoom-window'), btn('zoomPrev', 'Zoom previous', zoomPrevious),
      btn('zoomIn', 'Zoom in', () => zoomBy(1.5)), btn('zoomOut', 'Zoom out', () => zoomBy(1 / 1.5)));

    const SNAP_ICONS: Record<SnapMode, CadIcon> = {
      end: 'snapEnd', mid: 'snapMid', centre: 'snapCentre', intersection: 'snapIntersection', quadrant: 'snapQuadrant',
      nearest: 'snapNearest', perpendicular: 'snapPerpendicular', tangent: 'snapTangent', grid: 'snapGrid',
    };
    const snapButtons = new Map<SnapMode, HTMLButtonElement>();
    function toggleSnap(m: SnapMode): void {
      if (m === 'grid') {
        settings.gridSnap = !settings.gridSnap;
        if (settings.gridSnap) settings.gridOn = true;
      } else if (settings.snaps.includes(m)) settings.snaps = settings.snaps.filter(s => s !== m);
      else settings.snaps = [...settings.snaps, m];
      keepSettings();
      syncSnaps();
      updatePointer();
    }
    const rightCol = h('div', { class: 'cad-col cad-snaps', role: 'toolbar', 'aria-orientation': 'vertical', 'aria-label': 'Snaps' },
      ...SNAP_ORDER.map(m => {
        const b = btn(SNAP_ICONS[m], `Snap: ${SNAP_NAMES[m]}`, () => toggleSnap(m));
        b.setAttribute('aria-pressed', 'false');
        snapButtons.set(m, b);
        return b;
      }));
    function syncSnaps(): void {
      for (const [m, b] of snapButtons) b.setAttribute('aria-pressed', String(m === 'grid' ? settings.gridSnap : settings.snaps.includes(m)));
      rightCol.classList.toggle('all-off', snapsOff);
      refreshStatus();
    }

    // The Layers panel: a tick to show or hide each layer, its colour, its name (click: draw on it).
    const layerList = h('div', { class: 'cad-layer-list', role: 'list' });
    const newLayerBtn = h('button', { type: 'button', class: 'cad-mini', title: 'New layer' }, '+ New');
    const panelClose = h('button', { type: 'button', class: 'cad-x', 'aria-label': 'Close the Layers panel', title: 'Close (View > Layers panel opens it again)' }, '×');
    const panel = h('div', { class: 'cad-panel' },
      h('div', { class: 'cad-panel-hd' }, h('span', {}, 'Layers'), panelClose),
      h('div', { class: 'cad-panel-tools' }, newLayerBtn, h('span', { class: 'cad-panel-hint' }, 'Click a name to draw on it; ⋯ for more')),
      layerList);
    on(panelClose, 'click', () => setPanel(false), signal);
    on(newLayerBtn, 'click', () => void newLayer(), signal);
    function setPanel(show: boolean): void {
      settings.layersPanel = show;
      panel.hidden = !show;
      keepSettings();
      paint();
    }
    async function newLayer(): Promise<void> {
      const name = await shell.dialogs.prompt({
        title: 'New layer', label: 'Name', value: `Layer ${drawing.layers.length + 1}`, ok: 'Make it',
        check: v => (!v.trim() ? 'Give the layer a name.' : v.trim().length > 64 ? 'At most 64 letters.' : drawing.layers.some(l => l.name === v.trim()) ? 'There is a layer with that name already.' : null),
      });
      if (name === null) return;
      const used = new Set(drawing.layers.map(l => l.colour));
      const colour = LAYER_COLOURS.find(c => !used.has(c)) ?? LAYER_COLOURS[drawing.layers.length % LAYER_COLOURS.length];
      commit(() => {
        drawing.layers = [...drawing.layers, { name: name.trim(), colour, on: true, locked: false, lineType: 'continuous' }];
        drawing.current = name.trim();
      });
      say(`Layer ${name.trim()} made; new items go on it.`);
    }
    function drawLayers(): void {
      const counts = new Map<string, number>();
      for (const e of drawing.ents) counts.set(e.layer, (counts.get(e.layer) ?? 0) + 1);
      layerList.replaceChildren(...drawing.layers.map(l => {
        const tick = h('button', { type: 'button', class: 'cad-tick', role: 'checkbox', 'aria-checked': String(l.on), 'aria-label': `Show ${l.name}` }, l.on ? '✔' : '');
        const sw = h('span', { class: 'cad-swatch', title: colourName(l.colour), 'aria-hidden': 'true' });
        css(sw, { background: l.colour });
        const current = l.name === drawing.current;
        const name = h('button', { type: 'button', class: `cad-layer-name${current ? ' current' : ''}`, 'aria-current': current ? 'true' : null, title: current ? 'New items go on this layer' : `Draw on ${l.name}` },
          l.name, current ? h('span', { class: 'cad-pen' }, ' ✎') : null);
        const count = h('span', { class: 'cad-count' }, String(counts.get(l.name) ?? 0));
        const lock = h('button', { type: 'button', class: `cad-lock${l.locked ? ' on' : ''}`, 'aria-pressed': String(l.locked), 'aria-label': `Lock ${l.name}`, title: l.locked ? 'Locked: its items cannot be chosen or changed. Click to unlock.' : 'Lock: its items cannot be chosen or changed' }, l.locked ? '🔒' : '🔓');
        const more = h('button', { type: 'button', class: 'cad-more', 'aria-label': `More for ${l.name}`, 'aria-haspopup': 'menu', title: 'Rename, colour, line type, delete...' }, '⋯');
        on(lock, 'click', () => lockLayer(l), signal);
        on(more, 'click', () => {
          const r = more.getBoundingClientRect();
          shell.menus.show(layerMenu(l), r.left, r.bottom, { returnFocus: more });
        }, signal);
        on(tick, 'click', () => {
          l.on = !l.on;
          if (!l.on) for (const e of drawing.ents) if (e.layer === l.name) selected.delete(e.id);
          touched();
        }, signal);
        on(name, 'click', () => {
          drawing.current = l.name;
          if (!l.on) l.on = true;
          touched();
          say(`New items go on ${l.name}.`);
        }, signal);
        on(name, 'dblclick', () => void renameLayer(l), signal);
        const row = h('div', { class: `cad-layer${l.on ? '' : ' off'}${l.locked ? ' locked' : ''}`, role: 'listitem' }, tick, sw, name, count, lock, more);
        on(row, 'contextmenu', (e: MouseEvent) => {
          e.preventDefault();
          shell.menus.show(layerMenu(l), e.clientX, e.clientY, { returnFocus: name });
        }, signal);
        if (l.lineType !== 'continuous') sw.classList.add('cad-swatch-dashed');
        return row;
      }));
    }

    // The command line and the status bar.
    const promptEl = h('span', { class: 'cad-prompt' });
    const input = h('input', { type: 'text', class: 'cad-input', 'aria-label': 'Command line', autocomplete: 'off', spellcheck: 'false' });
    // A point is typed as X, Enter, Y, Enter (an empty box counts as 0); a size as width and height.
    const xIn = h('input', { type: 'text', class: 'cad-coord', 'aria-label': 'X', inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false' });
    const yIn = h('input', { type: 'text', class: 'cad-coord', 'aria-label': 'Y', inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false' });
    const xName = h('span', { class: 'cad-axis', 'aria-hidden': 'true' }, 'X');
    const yName = h('span', { class: 'cad-axis', 'aria-hidden': 'true' }, 'Y');
    const xyGroup = h('span', { class: 'cad-xyin', hidden: true }, xName, xIn, yName, yIn);
    const doneBtn = h('button', { type: 'button', class: 'cad-mini cad-done', hidden: true, title: 'Finish this tool (a right-click in the drawing does the same)' }, 'Done');
    const commandRow = h('div', { class: 'cad-command' }, history, h('div', { class: 'cad-command-line' }, promptEl, input, xyGroup, doneBtn));
    let entry: 'one' | 'xy' | 'wh' = 'one';
    const entryMode = (): 'one' | 'xy' | 'wh' => {
      if (!tool) return 'one';
      const w = tool.want();
      return w.size ? 'wh' : w.point && !w.number ? 'xy' : 'one';
    };
    /** Shows the boxes the question needs; a different kind of question starts with empty boxes. */
    function syncEntry(): void {
      const next = entryMode();
      if (next !== entry) {
        xIn.value = '';
        yIn.value = '';
      }
      entry = next;
      input.hidden = entry !== 'one';
      xyGroup.hidden = entry === 'one';
      xName.textContent = entry === 'wh' ? 'Width' : 'X';
      yName.textContent = entry === 'wh' ? 'Height' : 'Y';
      xIn.setAttribute('aria-label', entry === 'wh' ? 'Width' : 'X');
      yIn.setAttribute('aria-label', entry === 'wh' ? 'Height' : 'Y');
      doneBtn.hidden = !tool;
      // A box that had the keyboard and is now hidden hands it on (to the next box, or the drawing).
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && commandRow.contains(focused) && focused.closest('[hidden]')) keyboardBack();
    }
    const firstField = () => (entry === 'one' ? input : xIn);
    /** After typing: the keyboard stays in the boxes while the tool asks for something typed, else goes to the drawing. */
    function keyboardBack(): void {
      const w = tool?.want();
      if (w && (w.point || w.number || w.size)) firstField().focus({ preventScroll: true });
      else canvas.focus({ preventScroll: true });
    }
    on(doneBtn, 'mousedown', (e: MouseEvent) => e.preventDefault(), signal);
    on(doneBtn, 'click', () => {
      enterKey();
      keyboardBack();
    }, signal);
    const msgCell = h('span', { class: 'cad-cell cad-msg' });
    const layerCell = h('button', { type: 'button', class: 'cad-cell cad-cell-btn', title: 'The layer new items go on (click to change it)' });
    const unitsCell = h('button', { type: 'button', class: 'cad-cell cad-cell-btn', title: 'Units (click to change)' });
    const snapCell = h('button', { type: 'button', class: 'cad-cell cad-cell-btn cad-toggle', title: 'Snaps on or off (F3)' }, 'SNAP');
    const gridCell = h('button', { type: 'button', class: 'cad-cell cad-cell-btn cad-toggle', title: 'Grid on or off (F7)' }, 'GRID');
    const orthoCell = h('button', { type: 'button', class: 'cad-cell cad-cell-btn cad-toggle', title: 'Ortho: straight across or up only (F8)' }, 'ORTHO');
    const xCell = h('span', { class: 'cad-cell cad-xy' }, 'X 0');
    const yCell = h('span', { class: 'cad-cell cad-xy' }, 'Y 0');
    const status = h('div', { class: 'cad-status' }, msgCell, layerCell, unitsCell, snapCell, gridCell, orthoCell, xCell, yCell);
    on(snapCell, 'click', () => toggleAllSnaps(), signal);
    on(gridCell, 'click', () => toggleGrid(), signal);
    on(orthoCell, 'click', () => toggleOrtho(), signal);
    on(unitsCell, 'click', () => void unitsDialog(), signal);
    on(layerCell, 'click', () => {
      const r = layerCell.getBoundingClientRect();
      shell.menus.show(drawing.layers.map(l => ({ label: l.name, checked: l.name === drawing.current, action: () => {
        drawing.current = l.name;
        l.on = true;
        touched();
      } })), r.left, r.top - 4 - drawing.layers.length * 28, { returnFocus: layerCell });
    }, signal);

    function refreshPrompt(): void {
      const text = tool ? `${tool.title}: ${tool.prompt()}` : panMode ? 'Pan: drag the drawing. Escape stops.' : 'Command (choose a tool, or type one such as line or circle; click items to choose them)';
      promptEl.textContent = `${text}:`;
      syncEntry();
      msgCell.textContent = tool ? tool.title : panMode ? 'Pan' : selected.size ? `${selected.size} chosen` : 'Ready';
      canvas.classList.toggle('pan-mode', panMode);
    }
    function refreshStatus(): void {
      layerCell.textContent = `Layer: ${drawing.current}`;
      unitsCell.textContent = drawing.units === 'mm' ? 'mm' : 'inch';
      snapCell.setAttribute('aria-pressed', String(!snapsOff));
      gridCell.setAttribute('aria-pressed', String(settings.gridOn));
      orthoCell.setAttribute('aria-pressed', String(settings.ortho));
      refreshPrompt();
    }
    function refreshXY(): void {
      const p = tool?.want().point ? effectivePoint() : cursor;
      xCell.textContent = `X ${f(p.x)}`;
      yCell.textContent = `Y ${f(p.y)}`;
    }
    function toggleAllSnaps(): void {
      snapsOff = !snapsOff;
      say(snapsOff ? 'Snaps off (F3 turns them on again).' : 'Snaps on.');
      syncSnaps();
      updatePointer();
    }
    function toggleGrid(): void {
      settings.gridOn = !settings.gridOn;
      keepSettings();
      refreshStatus();
      paint();
    }
    function toggleOrtho(): void {
      settings.ortho = !settings.ortho;
      keepSettings();
      say(settings.ortho ? 'Ortho on: lines go straight across or up.' : 'Ortho off.');
      refreshStatus();
      updatePointer();
    }
    function setLarge(on: boolean): void {
      settings.large = on;
      app.root.classList.toggle('cad-large', on);
      keepSettings();
      paint();
    }
    function setArrows(on: boolean): void {
      settings.arrows = on;
      keepSettings();
      syncToolButtons();
      paint();
    }
    function setWhite(on: boolean): void {
      settings.white = on;
      keepSettings();
      paint();
    }

    // ---- Menus ----------------------------------------------------------------------------------------------------
    const item = (id: ToolId, hint?: string): MenuItem => ({ label: TOOLS[id].name, checked: toolId === id, hint, action: () => startTool(id) });
    const sub_ = (label: string, items: MenuItem[]): MenuItem => ({ label, submenu: items });
    const fileMenu = (): MenuItem[] => [
      { label: 'New', action: () => void shell.openApp('cad') },
      { label: 'Open...', hint: 'Ctrl+O', action: () => void openDrawing() },
      { separator: true },
      { label: 'Save', hint: 'Ctrl+S', action: () => void save() },
      { label: 'Save as...', hint: 'Ctrl+Shift+S', action: () => void saveAs() },
      { separator: true },
      { label: 'Close', action: () => app.close() },
    ];
    const editMenu = (): MenuItem[] => [
      { label: 'Undo', hint: 'Ctrl+Z', disabled: !undoStack.length, action: undo },
      { label: 'Redo', hint: 'Ctrl+Y', disabled: !redoStack.length, action: redo },
      { separator: true },
      { label: 'Select all', hint: 'Ctrl+A', action: selectAll },
      sub_('Select', [
        item('chain'),
        { label: 'By layer...', action: () => void selectByLayer() },
        { label: 'By colour...', action: () => void selectByColour() },
        { label: 'Invert the choice', action: invertSelection },
        { label: 'Clear the choice', hint: 'Esc', disabled: !selected.size, action: () => ctx.select([]) },
      ]),
      { separator: true },
      item('move'), item('copy'), item('rotate'), item('mirror'), item('scale'),
      sub_('Arrays', [
        { label: 'Rectangular (rows and columns)...', action: () => void arrayRect() },
        item('array-polar'),
        item('array-line'),
      ]),
      { separator: true },
      { label: 'Move to a layer...', disabled: !selected.size, action: () => void moveToLayer() },
      { separator: true },
      { label: 'Delete', hint: 'Del', disabled: !selected.size, action: deleteSelected },
      { label: 'Delete a layer’s items...', action: () => void deleteLayerItems() },
    ];
    const cadMenu = (): MenuItem[] => [
      item('trim'), item('extend'),
      sub_('Break', [item('break-point'), item('break-two')]),
      { separator: true },
      item('fillet'), item('fillet-all'), item('chamfer'), item('chamfer-all'),
      { separator: true },
      item('offset'),
      { separator: true },
      { label: 'Join into geometries', disabled: !selected.size, action: joinChosen },
      { label: 'Explode polylines', disabled: !selected.size, action: explodeChosen },
      item('close'), item('start'), item('reverse'),
      { label: 'Show direction', checked: settings.arrows, action: () => setArrows(!settings.arrows) },
    ];
    const viewMenu = (): MenuItem[] => [
      { label: 'Zoom fit', action: zoomFit },
      item('zoom-window'),
      { label: 'Zoom previous', action: zoomPrevious },
      { label: 'Zoom in', action: () => zoomBy(1.5) },
      { label: 'Zoom out', action: () => zoomBy(1 / 1.5) },
      { label: 'Pan', checked: panMode, action: () => panBtn.click() },
      { separator: true },
      { label: 'Grid', hint: 'F7', checked: settings.gridOn, action: toggleGrid },
      { label: 'Snap to the grid', hint: 'F9', checked: settings.gridSnap, action: () => toggleSnap('grid') },
      { label: 'Grid spacing...', action: () => void gridDialog() },
      { label: 'Ortho', hint: 'F8', checked: settings.ortho, action: toggleOrtho },
      { separator: true },
      { label: 'White background', checked: settings.white, action: () => setWhite(!settings.white) },
      { label: 'Large icons', checked: settings.large, action: () => setLarge(!settings.large) },
      { label: 'Layers panel', checked: settings.layersPanel, action: () => setPanel(!settings.layersPanel) },
      { label: 'Show direction', checked: settings.arrows, action: () => setArrows(!settings.arrows) },
    ];
    const geometryMenu = (): MenuItem[] => [
      item('line'), item('polyline'),
      { separator: true },
      sub_('Rectangle', [item('rect'), item('rect-centre'), item('rect-round')]),
      sub_('Circle', [item('circle-cr'), item('circle-cd'), item('circle-2p'), item('circle-3p'), item('circle-ttr'), item('circle-ttt')]),
      sub_('Arc', [item('arc-3p'), item('arc-cse'), item('arc-ser'), item('arc-ttr')]),
      item('ellipse'),
      sub_('Polygon', [item('polygon-in'), item('polygon-out')]),
      item('slot'), item('spline'), item('point'),
      { separator: true },
      sub_('Construction lines', [item('xline-h'), item('xline-v'), item('xline-angle'), item('xline-2p'), item('xline-offset')]),
      sub_('Tangent lines', [item('tan-point'), item('tan-two')]),
    ];
    const utilsMenu = (): MenuItem[] => [
      item('measure'), item('measure-angle'), item('area'), item('list'),
      { label: 'Information...', action: information },
      { separator: true },
      sub_('Snaps', [
        ...SNAP_ORDER.filter(m => m !== 'grid').map(m => ({ label: SNAP_NAMES[m], checked: settings.snaps.includes(m), action: () => toggleSnap(m) })),
        { separator: true },
        { label: snapsOff ? 'Turn snaps on' : 'All snaps off', hint: 'F3', action: toggleAllSnaps },
      ]),
      { label: 'Units...', action: () => void unitsDialog() },
    ];
    const helpMenu = (): MenuItem[] => [
      { label: 'What TOMLIN CAD does', action: showHelp },
      { label: 'Keys', action: showKeys },
      ...(shell.native ? [{ separator: true } as MenuItem, ...shell.native.help().flatMap(g => g.items.map(i => ({ label: i.label, action: i.run })))] : []),
    ];
    const bar = menuBar(shell, signal, [
      { label: 'File', key: 'f', items: fileMenu },
      { label: 'Edit', key: 'e', items: editMenu },
      { label: 'View', key: 'v', items: viewMenu },
      { label: 'Geometry', key: 'g', items: geometryMenu },
      { label: 'CAD', key: 'c', items: cadMenu },
      { label: 'Utils', key: 'u', items: utilsMenu },
      { label: 'Help', key: 'h', items: helpMenu },
    ], { before: () => true, returnFocus: () => canvas });

    const body = h('div', { class: 'cad-body' }, leftCol, panel, canvasWrap, rightCol);
    app.root.append(h('div', { class: 'cad-menubar' }, bar.el), row1, row2, row3, body, commandRow, status);
    panel.hidden = !settings.layersPanel;
    app.root.classList.toggle('cad-large', settings.large);

    // ---- Keys ------------------------------------------------------------------------------------------------------
    /** Escape in a box: rubs out what is typed, or (nothing typed) stops the tool. */
    function escapeEntry(e: KeyboardEvent): void {
      e.preventDefault();
      e.stopPropagation();
      if (input.value || xIn.value || yIn.value) {
        input.value = xIn.value = yIn.value = '';
        firstField().focus({ preventScroll: true });
        return;
      }
      cancel();
      canvas.focus({ preventScroll: true });
    }
    on(input, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        const text = input.value;
        input.value = '';
        submit(text);
        keyboardBack();
      } else if (e.key === 'Escape') escapeEntry(e);
    }, signal);
    on(xIn, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        const v = xIn.value.trim();
        // A whole point (600,400 or @600,0 or @100<45) or a word (C, U, a command) is taken as it is.
        if (/[,@<]/.test(v) || /^[a-z]+$/i.test(v)) {
          xIn.value = yIn.value = '';
          submit(v);
          return keyboardBack();
        }
        yIn.focus({ preventScroll: true });
        yIn.select();
      } else if (e.key === 'Escape') escapeEntry(e);
    }, signal);
    on(yIn, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        const x = xIn.value.trim() || '0';
        const y = yIn.value.trim() || '0';
        xIn.value = yIn.value = '';
        submit(`${x},${y}`);
        keyboardBack();
      } else if (e.key === 'Escape') escapeEntry(e);
    }, signal);
    on(app.root, 'keyup', (e: KeyboardEvent) => {
      if (e.key === ' ') spaceDown = false;
    }, signal);
    on(app.root, 'keydown', (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      // An empty box behaves as the drawing does (Delete, undo); typing in it does not.
      const isEntry = e.target === input || e.target === xIn || e.target === yIn;
      const inInput = isEntry && (e.target as HTMLInputElement).value !== '';
      const inField = e.target instanceof HTMLElement && !isEntry && e.target.closest('input, select, textarea, .dialog');
      if (inField) return;
      if (e.altKey && !ctrl && !e.shiftKey && /^[a-z]$/.test(k) && bar.openByKey(k)) return e.preventDefault();
      if (e.key === 'F10' && !e.altKey && !ctrl && !e.shiftKey) {
        e.preventDefault();
        return bar.openFirst();
      }
      if (ctrl && k === 's') {
        e.preventDefault();
        return void (e.shiftKey ? saveAs() : save());
      }
      if (ctrl && k === 'o') {
        e.preventDefault();
        return void openDrawing();
      }
      if (ctrl && !inInput && (k === 'z' || k === 'y')) {
        e.preventDefault();
        return k === 'y' || e.shiftKey ? redo() : undo();
      }
      if (ctrl && !inInput && k === 'a') {
        e.preventDefault();
        return selectAll();
      }
      if (e.key === 'F3') {
        e.preventDefault();
        return toggleAllSnaps();
      }
      if (e.key === 'F7') {
        e.preventDefault();
        return toggleGrid();
      }
      if (e.key === 'F8') {
        e.preventDefault();
        return toggleOrtho();
      }
      if (e.key === 'F9') {
        e.preventDefault();
        return toggleSnap('grid');
      }
      if (inInput) return;
      const onButton = e.target instanceof HTMLButtonElement;
      // Typing anywhere in the window (not only in the drawing) goes to the command line (the X box for a point).
      if (!isEntry && !ctrl && !e.altKey && e.key.length === 1 && e.key !== ' ') {
        firstField().focus({ preventScroll: true });
        return;
      }
      if (isEntry && e.key === ' ') return;
      // Enter and Space on a focused button press that button.
      if (onButton && (e.key === 'Enter' || e.key === ' ')) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        return cancel();
      }
      if (e.key === 'Enter' || (e.key === ' ' && !tool && !panMode)) {
        e.preventDefault();
        return enterKey();
      }
      if (e.key === ' ') {
        e.preventDefault();
        spaceDown = true;
        return;
      }
      // Backspace on the command line only ever rubs out typing, never the chosen items.
      if (e.key === 'Delete' || (e.key === 'Backspace' && !isEntry)) {
        e.preventDefault();
        return deleteSelected();
      }
      if (e.key === 'Tab' && snaps.length > 1 && e.target === canvas) {
        e.preventDefault();
        snapAt = (snapAt + 1) % snaps.length;
        refreshXY();
        return paint();
      }
    }, signal);

    // ---- Start ------------------------------------------------------------------------------------------------------
    const resize = new ResizeObserver(() => {
      if (!fitted && canvasWrap.clientWidth > 0) {
        fitted = true;
        view = fitView(drawing.ents.length ? boxOfShapes(drawing.ents) : null, canvasW(), canvasH());
      }
      paint();
    });
    resize.observe(canvasWrap);
    signal.addEventListener('abort', () => resize.disconnect());
    syncSnaps();
    syncToolButtons();
    drawLayers();
    refreshTitle();
    refreshStatus();
    say(path ? `Opened ${label}.` : 'A new drawing, in millimetres. Choose a tool, or type one such as line.');
    canvas.focus({ preventScroll: true });
    paint();
  },
};
