// CAD Draft: a 2D drawing program for drawing a part out on a job and machining it at home in a CAM program. The
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
import { P, add, dist, mul, normAngle, sub, unit, type Pt } from './cad/geom.ts';
import { cadIcon, type CadIcon } from './cad/icons.ts';
import { parseNumber, parsePoint, parseSize } from './cad/input.ts';
import {
  COLOUR_NAMES, CONSTRUCTION, DIMENSIONS, TEXT, isNote, CadProblem, LAYER_COLOURS, LINE_TYPES, TYPE_NAMES, colourName, describe, type LineType, fmt, newDrawing, readTcad, tooBigToSave, writeTcad, type Drawing, type Ent, type Layer, type Shape, type Units,
} from './cad/model.ts';
import { SNAP_NAMES, SNAP_ORDER, findSnaps, type Snap, type SnapMode } from './cad/snap.ts';
import { PARTS_FOLDER, PART_EXT, layerFor, partList, partNameProblem, placePart, readPart, unitFactor, writePart, type Part } from './cad/parts.ts';
import { COMMAND_WORDS, TOOLS, partPlaceTool, type PolarAnswer, type TextAnswer, type TextAsk, type Tool, type ToolCtx, type ToolId } from './cad/tools.ts';
import { explode, join } from './cad/modify.ts';
import { allFinite, decodeText, readDxf, writeDxf } from './cad/dxf.ts';
import type { Align } from './cad/font.ts';
import { defaultStyle, dimParts, textShapeStrokes, type DimShape } from './cad/notes.ts';
import { MAX_SCALE, MIN_SCALE, fitView, render, toWorld, type View } from './cad/view.ts';
import { OPACITIES, PHOTO_SIDE, photoBox, photoScale, pixelMatrix, placePhoto, planStraighten, warpPixels, type Photo } from './cad/photo.ts';
import { CAD_PAPERS, CAD_SCALES, DEFAULT_SETUP, PT, drawCadPage, planPrint, scaleText, type CadPaper, type PageExtras, type PrintPlan, type PrintSetup } from './cad/print.ts';
import { svg } from '../core/dom.ts';
import type { Entry } from '../fs/fs.ts';
import { SvgPainter, type Painter } from './sheet/paint.ts';
import { PdfDocument, type PdfPage } from './sheet/pdf.ts';

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
  /** DXF output: text as lines in CAD Draft's letters, construction lines in, hidden layers in. */
  dxfTextAsLines: boolean;
  dxfConstruction: boolean;
  dxfHidden: boolean;
  /** Drawings opened or saved lately, newest first. */
  recent: string[];
  /** How the last print was set up (the title is each drawing's own). */
  print: Omit<PrintSetup, 'title'>;
  /** A recovery copy of an unsaved drawing kept every two minutes. */
  autosave: boolean;
}

const DEFAULT_SNAPS: SnapMode[] = ['end', 'mid', 'centre', 'intersection', 'quadrant'];
const RECENT_MAX = 8;
/** Recovery copies of unsaved drawings: kept while a window works, removed once it is saved or closed. */
const RECOVERY = '/System/cad-recovery';
const AUTOSAVE_MS = 2 * 60 * 1000;
/** A copy's note written more recently than this belongs to a window still open somewhere (as shell/recovery.ts has it). */
const RECOVERY_IN_USE_MS = 5 * 60 * 1000;
/** The recovery copies windows open now are keeping (in this page), which are not offered as left behind. */
const liveRecovery = new Set<string>();
/** The note beside a copy ("<id>.note.json" for "<id>.tcad"), refreshed while the copy is in use. */
const recoveryNoteOf = (p: string) => p.replace(/\.tcad$/i, '') + '.note.json';
/** The photo made ready for paper: its JPEG (for a PDF) and an address for it (for the preview and printing). */
interface PaperPhoto {
  jpeg: string;
  url: string;
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
/** The print settings kept between windows, checked (anything odd goes back to the usual). */
function readPrintSettings(v: unknown): Omit<PrintSetup, 'title'> {
  const { title: _t, ...out } = DEFAULT_SETUP;
  if (!v || typeof v !== 'object') return out;
  const o = v as Record<string, unknown>;
  if (typeof o.paper === 'string' && o.paper in CAD_PAPERS) out.paper = o.paper as CadPaper;
  if (o.scale === 'fit' || (typeof o.scale === 'number' && Number.isFinite(o.scale) && o.scale > 0)) out.scale = o.scale as number | 'fit';
  if (o.what === 'all' || o.what === 'view') out.what = o.what;
  if (typeof o.drawnBy === 'string') out.drawnBy = o.drawnBy.slice(0, 80);
  for (const k of ['landscape', 'colour', 'titleBlock', 'photo', 'construction'] as const) if (typeof o[k] === 'boolean') out[k] = o[k] as boolean;
  return out;
}


interface Snapshot {
  ents: Ent[];
  layers: Layer[];
  current: string;
  photo: Photo | null;
  units: Units;
  style: Drawing['style'];
  version: number;
}

export const cadApp: AppDef = {
  ...APPS.cad,
  async launch(app, arg) {
    const shell = app.shell;
    const signal = app.signal;
    app.root.classList.add('cad');

    // ---- Settings kept between windows -----------------------------------------------------------------------------
    const settings: Settings = { snaps: [...DEFAULT_SNAPS], arrows: false, white: false, large: false, layersPanel: true, ortho: false, gridOn: false, gridSnap: false, dxfTextAsLines: false, dxfConstruction: false, dxfHidden: false, recent: [], print: readPrintSettings(null), autosave: true };
    try {
      const saved = JSON.parse(await shell.fs.readText(SETTINGS)) as Partial<Settings>;
      if (Array.isArray(saved.snaps)) settings.snaps = saved.snaps.filter((s): s is SnapMode => SNAP_ORDER.includes(s as SnapMode));
      for (const k of ['arrows', 'white', 'large', 'layersPanel', 'ortho', 'gridOn', 'gridSnap', 'dxfTextAsLines', 'dxfConstruction', 'dxfHidden', 'autosave'] as const) if (typeof saved[k] === 'boolean') settings[k] = saved[k];
      if (Array.isArray(saved.recent)) settings.recent = saved.recent.filter((r): r is string => typeof r === 'string').slice(0, RECENT_MAX);
      settings.print = readPrintSettings(saved.print);
    } catch {
      // Nothing kept yet: the usual settings.
    }
    let settingsTimer = 0;
    /** Each setting as this window last read or wrote it: only what changed here is written over another window's. */
    const settingsSeen = new Map(Object.entries(settings).map(([k, v]) => [k, JSON.stringify(v)]));
    function keepSettings(): void {
      clearTimeout(settingsTimer);
      settingsTimer = window.setTimeout(() => {
        void (async () => {
          let kept: Record<string, unknown> = {};
          try {
            kept = JSON.parse(await shell.fs.readText(SETTINGS)) as Record<string, unknown>;
          } catch {
            // Nothing kept yet.
          }
          for (const [k, v] of Object.entries(settings)) {
            const now = JSON.stringify(v);
            if (now !== settingsSeen.get(k) || !(k in kept)) kept[k] = v;
            settingsSeen.set(k, now);
          }
          await shell.fs.writeText(SETTINGS, JSON.stringify(kept), { hidden: true });
        })().catch(() => {
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
    let dxfReport: { lines: string[]; leftOut: number; changed: number } | null = null;
    /** The DXF this drawing was opened from, if what it holds was not all kept (so outputting over it asks first). */
    let lossyDxf: string | null = null;
    /** This window's recovery copy (set once it has kept one, or when it opened one). */
    let recoveryPath: string | null = null;
    let recovered = false;
    /** What was left out when the drawing opened (it then opens as a copy). */
    let leftOutOnOpen = '';
    if (arg) {
      try {
        const entry = await shell.fs.stat(arg);
        if (!entry || entry.kind !== 'file') throw new CadProblem('That file is not there any more. It may have been moved or deleted.');
        const raw = await shell.fs.readFile(arg);
        if (/\.dxf$/i.test(arg)) {
          // A DXF is read into a new drawing: saving it makes a .tcad beside it (the DXF is never written over by Save).
          const read = readDxf(raw);
          drawing = read.drawing;
          label = baseName(arg);
          folderHint = parentPath(arg);
          dxfReport = { lines: read.report, leftOut: read.leftOut, changed: read.changed };
          if (read.leftOut || read.changed) lossyDxf = arg;
        } else if (parentPath(arg) === RECOVERY) {
          // A drawing kept before it was saved: it opens unsaved, and Save asks where (it never writes over the file it
          // came from without asking).
          const text = new TextDecoder().decode(raw);
          const read = readTcad(text);
          drawing = read.drawing;
          let from: { path?: unknown; label?: unknown } = {};
          try {
            from = ((JSON.parse(text) as Record<string, unknown>).recovery ?? {}) as typeof from;
          } catch {
            // readTcad has read it already.
          }
          label = typeof from.label === 'string' && from.label ? from.label : 'Drawing';
          folderHint = typeof from.path === 'string' ? parentPath(from.path) : null;
          recoveryPath = arg;
          liveRecovery.add(arg);
          recovered = true;
          // Said to be in use from now on, so another window offered the same copy a moment later does not open it too.
          void shell.fs.writeText(recoveryNoteOf(arg), JSON.stringify({ label, path: typeof from.path === 'string' ? from.path : null }), { hidden: true }).catch(() => {});
        } else {
        const read = readTcad(new TextDecoder().decode(raw));
        drawing = read.drawing;
        path = arg;
        label = baseName(arg);
        loadedId = entry.id;
        if (read.skipped || read.damaged) {
          // Saving over it would lose what was left out: it opens as a copy, and Save asks where.
          path = null;
          loadedId = '';
          folderHint = parentPath(arg);
          leftOutOnOpen = [
            read.skipped ? `${read.skipped} item${read.skipped === 1 ? ' is' : 's are'} of a kind this version of CAD Draft does not know` : '',
            read.damaged ? `${read.damaged} item${read.damaged === 1 ? ' is' : 's are'} damaged (${read.why})` : '',
          ].filter(Boolean).join('; ');
        }
        }
      } catch (error) {
        const why = error instanceof CadProblem ? error.message : 'This drawing could not be read.';
        app.root.append(h('div', { class: 'app-message', role: 'alert' }, h('p', {}, why), h('p', { class: 'dialog-detail' }, 'The file was not changed.')));
        if (!(error instanceof CadProblem)) await shell.report('Could not open the drawing', error);
        return;
      }
    }
    let nextId = drawing.ents.reduce((m, e) => Math.max(m, e.id), 0) + 1;
    // A recovered drawing has changes that are not saved yet.
    let version = recovered || leftOutOnOpen ? 1 : 0;
    /** Version numbers only go up: a state reached after an Undo never takes the number of the saved one. */
    let stamp = version;
    let savedVersion = 0;
    let autosavedVersion = recovered ? 1 : -1;
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
    /** The last press anywhere in the window was a finger (not a mouse or pen). */
    let lastTouch = false;
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
    const snap = (): Snapshot => ({ ents: drawing.ents, layers: drawing.layers.map(l => ({ ...l })), current: drawing.current, photo: drawing.photo, units: drawing.units, style: drawing.style, version });
    /** What Undo leaves as it is: layers shown and locked, the layer drawn on, how the photo shows. */
    const lookOf = (layers: Layer[], current: string, photo: Photo | null) => JSON.stringify([layers.map(l => [l.name, l.on, l.locked]), current, photo ? [photo.on, photo.opacity] : null]);
    function commit(apply: () => void): void {
      undoStack.push(snap());
      if (undoStack.length > 300) undoStack.shift();
      redoStack = [];
      apply();
      version = ++stamp;
      afterChange();
    }
    function restore(s: Snapshot): void {
      // Which layers are showing or locked, the layer drawn on, and how the photo shows are not taken back by Undo
      // (they are ways of looking and working, not changes to the shapes).
      const now = new Map(drawing.layers.map(l => [l.name, l]));
      const photoNow = drawing.photo;
      drawing.ents = s.ents;
      drawing.layers = s.layers.map(l => ({ ...l, on: now.get(l.name)?.on ?? l.on, locked: now.get(l.name)?.locked ?? l.locked }));
      drawing.current = drawing.layers.some(l => l.name === drawing.current) ? drawing.current : s.current;
      drawing.photo = s.photo && photoNow ? { ...s.photo, on: photoNow.on, opacity: photoNow.opacity } : s.photo;
      drawing.units = s.units;
      drawing.style = s.style;
      gridSpacing = drawing.units === 'mm' ? 10 : 0.5;
      // Back to the saved shapes with a different look kept is still a change from the file.
      version = lookOf(drawing.layers, drawing.current, drawing.photo) === lookOf(s.layers, s.current, s.photo) ? s.version : ++stamp;
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
      version = ++stamp;
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
      app.setTitle(`${label} - CAD Draft`);
    }

    const TOO_BIG = 'That would put a size beyond any number into the drawing (it could not be saved and opened again), so nothing was changed. Check the numbers typed: a scale or a distance may be far too big.';
    /** The ids given to the shapes added (empty when nothing was added). */
    function addShapes(shapes: Shape[], layerName = drawing.current): number[] {
      if (!shapes.length) return [];
      if (!shapes.every(allFinite)) {
        problem(TOO_BIG);
        return [];
      }
      const first = nextId;
      commit(() => {
        if (!layerOf(layerName)) drawing.layers = [...drawing.layers, { name: layerName, colour: layerName === CONSTRUCTION ? '#e040e0' : '#ffffff', on: true, locked: false, lineType: layerName === CONSTRUCTION ? 'dashed' : 'continuous' }];
        drawing.ents = [...drawing.ents, ...shapes.map(s => ({ ...s, id: nextId++, layer: layerName }) as Ent)];
      });
      return shapes.map((_, i) => first + i);
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
        if (!changed.every(c => allFinite(c.shape)) || !added.every(a => allFinite(a.shape))) return problem(TOO_BIG);
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
      askText,
      askDim,
      style: () => drawing.style,
      noteLayer(kind) {
        const name = kind === 'text' ? TEXT : DIMENSIONS;
        const l = layerOf(name);
        return l && l.on && !l.locked ? name : drawing.current;
      },
      finished() {
        if (tool?.done) endTool(true);
      },
      photo: () => drawing.photo,
      setPhoto(ph, said) {
        commit(() => {
          drawing.photo = { ...ph, on: true };
        });
        say(said);
        // Scaled a long way, the photo may now run off the area: show all of it.
        const b = photoBox(ph);
        const v = viewBox();
        if (b.x0 < v.x0 || b.y0 < v.y0 || b.x1 > v.x1 || b.y1 > v.y1) zoomFit();
      },
      straightenPhoto(corners, w, hgt) {
        void straightenPhoto(corners, w, hgt);
      },
      placePart(part, at, angle) {
        const shapes = placePart(part, drawing.units, at, angle);
        const names = drawing.layers.map(l => l.name);
        const first = nextId;
        ctx.change([], shapes.map((shape, i) => ({ shape, layer: layerFor(part.items[i].layer, names, drawing.current) })));
        if (nextId === first) return;
        ctx.select(Array.from({ length: nextId - first }, (_, i) => first + i));
        const k = unitFactor(part.units, drawing.units);
        say(`${part.name}: ${shapes.length} item${shapes.length === 1 ? '' : 's'} placed and chosen (Move or Rotate takes them together)${k === 1 ? '' : `, made in ${part.units === 'mm' ? 'millimetres' : 'inches'} and sized to this drawing’s ${unitWord()}`}. Next: another place, or Done.`);
      },
      savePart(base) {
        void savePart(base);
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
        if (lw === 'part' || lw === 'insert') return void insertPart();
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
      const reach = (lastTouch ? 14 : 6) / view.scale;
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
      const picks = chosenEnts().filter(e => e.type === 'poly' || isNote(e));
      if (!picks.length) return problem('Choose the polylines, text or dimensions to break into lines and arcs first.');
      const added: Array<{ shape: Shape; layer: string }> = [];
      for (const e of picks) {
        if (e.type === 'text') {
          // Text becomes the strokes of its letters: lines and open polylines a cutter can follow.
          for (const s of textShapeStrokes(e)) {
            if (s.length === 2) {
              if (dist(s[0], s[1]) > 1e-12) added.push({ shape: { type: 'line', a: s[0], b: s[1] }, layer: e.layer });
            } else added.push({ shape: { type: 'poly', pts: s, bulges: s.map(() => 0), closed: false }, layer: e.layer });
          }
        } else if (e.type === 'dim') {
          // A dimension becomes its lines, arcs and text (it no longer measures again when moved).
          const parts = dimParts(e);
          for (const p of parts.pieces) {
            if (p.k === 'seg') added.push({ shape: { type: 'line', a: p.a, b: p.b }, layer: e.layer });
            else if (p.k === 'arc') added.push({ shape: { type: 'arc', c: p.c, r: p.r, a0: p.a0, a1: p.a1 }, layer: e.layer });
          }
          for (const t of parts.texts) added.push({ shape: { type: 'text', p: t.p, text: t.text, h: t.h, angle: t.angle, align: t.align }, layer: e.layer });
        } else {
          const parts = explode(e);
          if (typeof parts !== 'string') for (const shape of parts) added.push({ shape, layer: e.layer });
        }
      }
      ctx.change([], added, picks.map(e => e.id));
      say(`${picks.length} item${picks.length === 1 ? '' : 's'} broken into ${added.length} pieces.`);
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
        drawing.photo
          ? `Photo: ${drawing.photo.name}, ${drawing.photo.px} x ${drawing.photo.py} pixels; bottom-left corner at ${f(drawing.photo.at.x)}, ${f(drawing.photo.at.y)}; ${Number(photoScale(drawing.photo).toPrecision(6))} ${unitWord()} a pixel; turned ${f((Math.atan2(drawing.photo.u.y, drawing.photo.u.x) * 180) / Math.PI)}°; ${drawing.photo.clip ? 'straightened; ' : ''}${drawing.photo.on ? `showing at ${Math.round(drawing.photo.opacity * 100)}%` : 'hidden'}`
          : 'Photo: none',
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
          if (!l.on) for (const e of drawing.ents) if (e.layer === l.name) selected.delete(e.id);
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
          const ok = await shell.dialogs.ask<boolean>({ title, body, buttons: [{ label: 'OK', value: true, primary: true }, { label: 'Cancel', value: false }], cancel: false, focus: () => body.querySelector('textarea, input') });
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
    async function askText(o: TextAsk): Promise<TextAnswer | null> {
      const words = o.arc
        ? h('input', { type: 'text', class: 'field', value: o.text, 'aria-label': 'Words', autocomplete: 'off' })
        : h('textarea', { class: 'field cad-words', rows: '3', 'aria-label': 'Words', spellcheck: 'false' });
      if (!o.arc) words.value = o.text;
      const height = numberRow(`Height of the capitals (${unitWord()})`, Number(f(o.h)));
      const rows: HTMLElement[] = [h('label', { class: 'cad-row cad-row-top' }, h('span', {}, 'Words'), words), height.row];
      let angle: { input: HTMLInputElement; row: HTMLElement } | null = null;
      const alignSel = h('select', { class: 'field', 'aria-label': 'Line up' },
        h('option', { value: 'left' }, o.arc ? 'Starts at the point' : 'Left end at the point'),
        h('option', { value: 'centre' }, 'Middle at the point'),
        h('option', { value: 'right' }, o.arc ? 'Ends at the point' : 'Right end at the point'));
      alignSel.value = o.align ?? 'left';
      const readSel = h('select', { class: 'field', 'aria-label': 'Reads' },
        h('option', { value: 'cw' }, 'Clockwise, round the outside (over the top)'),
        h('option', { value: 'ccw' }, 'Anticlockwise, along the inside (under the bottom)'));
      readSel.value = o.cw === false ? 'ccw' : 'cw';
      if (!o.plain) {
        if (!o.arc) {
          angle = numberRow('Angle (degrees, anticlockwise)', Number(f(((o.angle ?? 0) * 180) / Math.PI)));
          rows.push(angle.row);
        }
        rows.push(h('label', { class: 'cad-row' }, h('span', {}, 'Line up'), alignSel));
        if (o.arc) rows.push(h('label', { class: 'cad-row' }, h('span', {}, 'Reads'), readSel));
      }
      rows.push(h('p', { class: 'dialog-detail' }, 'Drawn in CAD Draft’s own single-line letters (each letter one stroke wide, as an engraving cutter follows it). Type %%d for °, %%c for Ø, %%p for ±.'));
      return askForm<TextAnswer>(o.title, rows, () => {
        const t = decodeText(words.value.replace(/\r/g, '').replace(/\s+$/, ''));
        if (!t.trim()) return 'Type some words.';
        if (t.length > 10000) return 'At most 10,000 letters.';
        const hv = parseNumber(height.input.value);
        if (hv === null || !(hv > 0)) return 'The height must be a number above 0.';
        const av = angle ? parseNumber(angle.input.value) : 0;
        if (av === null) return 'The angle must be a number of degrees.';
        return { text: t, h: hv, angle: angle ? normAngle((av * Math.PI) / 180) : o.angle ?? 0, align: (o.plain ? 'left' : alignSel.value) as Align, cw: readSel.value === 'cw' };
      });
    }
    async function askDim(d: DimShape): Promise<{ text: string; h: number; dp: number } | null> {
      const leader = d.kind === 'leader';
      const words = h('input', { type: 'text', class: 'field', value: d.text, 'aria-label': 'Words', autocomplete: 'off' });
      const height = numberRow(`Height of the words (${unitWord()})`, Number(f(d.h)));
      const places = numberRow('Decimal places', d.dp);
      const rows: HTMLElement[] = [h('label', { class: 'cad-row' }, h('span', {}, leader ? 'Words' : 'Words (empty: the measured size; <> stands for it)'), words), height.row];
      if (!leader) rows.push(places.row);
      return askForm(leader ? 'Change the leader note' : 'Change the dimension', rows, () => {
        const hv = parseNumber(height.input.value);
        if (hv === null || !(hv > 0)) return 'The height must be a number above 0.';
        const dp = leader ? d.dp : parseNumber(places.input.value);
        if (dp === null || !Number.isInteger(dp) || dp < 0 || dp > 8) return 'Decimal places: a whole number from 0 to 8.';
        const t = decodeText(words.value.trim());
        if (leader && !t) return 'Type the note.';
        return { text: t, h: hv, dp };
      });
    }
    async function noteStyleDialog(): Promise<void> {
      const st = drawing.style;
      const textH = numberRow(`Text height (${unitWord()})`, Number(f(st.textH)));
      const dimH = numberRow(`Dimension number height (${unitWord()})`, Number(f(st.dimH)));
      const arrow = numberRow(`Arrow length (${unitWord()})`, Number(f(st.arrow)));
      const dp = numberRow('Decimal places in dimensions', st.dp);
      const note = h('p', { class: 'dialog-detail' }, 'For new text and dimensions in this drawing (kept in its file). To change one already drawn: Utils > Dimensions > Change text or a dimension, or double-click it.');
      const out = await askForm('Sizes for text and dimensions', [textH.row, dimH.row, arrow.row, dp.row, note], () => {
        const v = [textH, dimH, arrow].map(r => parseNumber(r.input.value));
        if (v.some(x => x === null || !(x > 0))) return 'Each size must be a number above 0.';
        const places = parseNumber(dp.input.value);
        if (places === null || !Number.isInteger(places) || places < 0 || places > 8) return 'Decimal places: a whole number from 0 to 8.';
        return { textH: v[0]!, dimH: v[1]!, arrow: v[2]!, dp: places };
      });
      if (!out) return;
      drawing.style = out;
      touched();
      say('New text and dimensions take these sizes.');
    }
    async function outputDxf(): Promise<void> {
      const asLines = h('input', { type: 'checkbox', checked: settings.dxfTextAsLines });
      const xlines = h('input', { type: 'checkbox', checked: settings.dxfConstruction });
      const hidden = h('input', { type: 'checkbox', checked: settings.dxfHidden });
      const body = h('div', { class: 'cad-dialog' },
        h('p', {}, 'Writes an AutoCAD R12 DXF: the plainest kind, which CAM programs old and new read. Ellipses and curves go as polylines of arcs; dimensions as plain lines and text. Your drawing is not changed (Save keeps everything as .tcad).'),
        h('label', { class: 'cad-check' }, asLines, ' Text as lines in CAD Draft’s letters (exactly as on screen; for engraving). Off: as text the other program draws in its own letters.'),
        h('label', { class: 'cad-check' }, xlines, ' Construction lines (as long lines across the drawing)'),
        h('label', { class: 'cad-check' }, hidden, ' Items on hidden layers'));
      const ok = await shell.dialogs.ask<boolean>({ title: 'Output a DXF', body, buttons: [{ label: 'Choose where...', value: true, primary: true }, { label: 'Cancel', value: false }], cancel: false });
      setTimeout(keyboardBack, 0);
      if (!ok) return;
      settings.dxfTextAsLines = asLines.checked;
      settings.dxfConstruction = xlines.checked;
      settings.dxfHidden = hidden.checked;
      keepSettings();
      let out: ReturnType<typeof writeDxf>;
      try {
        out = writeDxf(drawing, { textAsLines: asLines.checked, construction: xlines.checked, hidden: hidden.checked });
      } catch (error) {
        if (error instanceof CadProblem) return problem(error.message);
        throw error;
      }
      if (!out.count) return problem('There is nothing to write: draw something first (or tick hidden layers or construction lines if that is all there is).');
      const folder = path ? parentPath(path) : folderHint ?? '/Documents';
      let taken: string[] = [];
      try {
        taken = (await shell.fs.list(folder, true)).map(e => e.name);
      } catch {
        // Saving will say the folder is gone.
      }
      const stem = label.replace(/\.(tcad|dxf)$/i, '');
      const chosen = await pickSave(shell, { title: 'Output a DXF', folder, name: uniqueName(`${stem}.dxf`, taken), accept: ['dxf'], ok: 'Save' });
      setTimeout(keyboardBack, 0);
      if (!chosen) return;
      let target = chosen.path;
      if (!/\.dxf$/i.test(target)) target += '.dxf';
      try {
        let replacing = chosen.replace;
        if (target !== chosen.path) {
          const existing = await shell.fs.stat(target).catch(() => null);
          if (existing && !(await shell.dialogs.confirm({ title: 'Replace it?', text: `“${baseName(target)}” already exists. Replace it with this one?`, ok: 'Replace', danger: true, cancel: 'Cancel' }))) return;
          replacing = !!existing;
        }
        if (lossyDxf && target.toLowerCase() === lossyDxf.toLowerCase() && !(await shell.dialogs.confirm({
          title: 'Write over the DXF this came from?',
          text: `“${baseName(target)}” is the DXF this drawing was opened from. What CAD Draft did not keep when it opened (listed then: heights, thicknesses, colours or line types of items’ own, or items left out) would be gone from it for good.`,
          ok: 'Write over it',
          danger: true,
          cancel: 'Cancel',
        }))) return;
        const entry = await shell.fs.writeFile(target, out.bytes, replacing ? {} : { mustBeNew: true });
        for (const n of out.notes) say(n);
        shell.toast(`Saved “${entry.name}”.`);
      } catch (error) {
        await shell.report('Could not save the DXF', error);
      }
    }
    // ---- The photo to trace -----------------------------------------------------------------------------------------
    const PHOTO_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'heic', 'heif'];
    const NO_PHOTO = 'There is no photo under this drawing: View > Photo to trace > Open a photo first.';
    /** A JPEG as an address pictures can load from (the desktop's rules allow blob: pictures, not data: ones). */
    const jpegUrl = (b64: string) => URL.createObjectURL(new Blob([fromBase64(b64)], { type: 'image/jpeg' }));
    let photoPicture: { jpeg: string; url: string; img: HTMLImageElement | null } | null = null;
    signal.addEventListener('abort', () => {
      if (photoPicture) URL.revokeObjectURL(photoPicture.url);
    });
    /** The photo for the drawing area once its pixels are ready (made from its JPEG the first time it is shown). */
    function photoScene(): { ph: Photo; img: CanvasImageSource } | null {
      const ph = drawing.photo;
      if (!ph || !ph.on) return null;
      if (photoPicture?.jpeg !== ph.jpeg) {
        if (photoPicture) URL.revokeObjectURL(photoPicture.url);
        const entry: { jpeg: string; url: string; img: HTMLImageElement | null } = { jpeg: ph.jpeg, url: jpegUrl(ph.jpeg), img: null };
        photoPicture = entry;
        const img = new Image();
        img.onload = () => {
          entry.img = img;
          paint();
        };
        img.onerror = () => problem('The photo in this drawing cannot be shown: its picture is damaged. View > Photo to trace > Open a photo puts another in its place.');
        img.src = entry.url;
      }
      return photoPicture.img ? { ph, img: photoPicture.img } : null;
    }
    /** A picture file as the JPEG kept in the drawing: its longer side at most PHOTO_SIDE pixels. */
    async function photoFrom(raw: Uint8Array): Promise<{ jpeg: string; px: number; py: number }> {
      let bitmap: ImageBitmap;
      try {
        bitmap = await createImageBitmap(new Blob([raw as Uint8Array<ArrayBuffer>]));
      } catch {
        throw new CadProblem('It is not a picture this browser can read (JPEG, PNG, WebP, GIF or BMP), or the file is damaged.');
      }
      const k = Math.min(1, PHOTO_SIDE / Math.max(bitmap.width, bitmap.height));
      const px = Math.max(1, Math.round(bitmap.width * k));
      const py = Math.max(1, Math.round(bitmap.height * k));
      const cv = h('canvas', { width: String(px), height: String(py) });
      const g = cv.getContext('2d');
      if (!g) throw new CadProblem('The computer would not make room for the photo (it may be short of memory).');
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, px, py);
      g.imageSmoothingQuality = 'high';
      g.drawImage(bitmap, 0, 0, px, py);
      bitmap.close();
      const blob = await new Promise<Blob | null>(done => cv.toBlob(done, 'image/jpeg', 0.85));
      if (!blob) throw new CadProblem('The photo could not be made into a JPEG (the computer may be short of memory).');
      return { jpeg: toBase64(new Uint8Array(await blob.arrayBuffer())), px, py };
    }
    async function openPhoto(): Promise<void> {
      if (drawing.photo && !(await shell.dialogs.confirm({ title: 'Replace the photo?', text: 'This drawing has a photo under it already. The new one takes its place (Undo brings the old one back).', ok: 'Replace it', cancel: 'Cancel' }))) return;
      const chosen = await pickFile(shell, { title: 'Open a photo to trace over', folder: path ? parentPath(path) : folderHint ?? '/Pictures', accept: PHOTO_EXTS, ok: 'Open' });
      setTimeout(keyboardBack, 0);
      if (!chosen) return;
      if (/\.(heic|heif)$/i.test(chosen)) {
        await shell.dialogs.alert('This photo cannot be read here', 'It is an iPhone HEIC photo, which a web browser cannot open. On the iPhone, share it as a JPEG (or set Settings > Camera > Formats to Most Compatible), then open that.');
        return;
      }
      let picture: { jpeg: string; px: number; py: number };
      try {
        picture = await photoFrom(await shell.fs.readFile(chosen));
      } catch (error) {
        if (error instanceof CadProblem) await shell.dialogs.alert('This photo cannot be read', error.message);
        else await shell.report('Could not open the photo', error);
        return;
      }
      const place = placePhoto(picture.px, picture.py, viewBox());
      commit(() => {
        drawing.photo = { ...picture, ...place, opacity: 0.5, on: true, name: baseName(chosen) };
      });
      say(`The photo ${baseName(chosen)} is under the drawing. Next: View > Photo to trace > Scale by a length you know (click two marks a known distance apart, then type that distance).`);
    }
    /** Shown or hidden, and how strongly: kept in the file, not undone (a way of looking, as a layer's tick is). */
    function setPhotoLook(patch: Partial<Photo>, said: string): void {
      if (!drawing.photo) return problem(NO_PHOTO);
      drawing.photo = { ...drawing.photo, ...patch };
      touched();
      say(said);
    }
    function removePhoto(): void {
      if (!drawing.photo) return problem(NO_PHOTO);
      commit(() => {
        drawing.photo = null;
      });
      say('Photo removed (Undo brings it back).');
    }
    // ---- The parts library ---------------------------------------------------------------------------------------
    /** The person's own parts (each a .tcad in the parts folder), and how many there could not be read. */
    async function ownParts(): Promise<{ parts: Part[]; unread: string[] }> {
      const parts: Part[] = [];
      const unread: string[] = [];
      if (!(await shell.fs.exists(PARTS_FOLDER))) return { parts, unread };
      for (const e of await shell.fs.list(PARTS_FOLDER, true)) {
        if (e.kind !== 'file' || !e.name.toLowerCase().endsWith(PART_EXT)) continue;
        try {
          parts.push(readPart(e.name.slice(0, -PART_EXT.length), await shell.fs.readText(`${PARTS_FOLDER}/${e.name}`)));
        } catch {
          unread.push(e.name);
        }
      }
      return { parts, unread };
    }
    /** A part drawn small, on the drawing area's colours. */
    function drawPartPreview(cv: HTMLCanvasElement, part: Part): void {
      const w = 280;
      const hgt = 180;
      const dpr = window.devicePixelRatio || 1;
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(hgt * dpr);
      css(cv, { width: w, height: hgt });
      const g = cv.getContext('2d');
      if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const shapes = placePart(part, part.units, P(0, 0), 0);
      const ents = shapes.map((s, i) => ({ ...s, id: i + 1, layer: part.items[i].layer }) as Ent);
      const layers = new Map(drawing.layers.map(l => [l.name, { ...l, on: true }]));
      for (const e of ents) if (!layers.has(e.layer)) layers.set(e.layer, { name: e.layer, colour: '#ffffff', on: true, locked: false, lineType: 'continuous' });
      const b = boxOfShapes(shapes);
      const v = fitView(b && { x0: Math.min(b.x0, 0), y0: Math.min(b.y0, 0), x1: Math.max(b.x1, 0), y1: Math.max(b.y1, 0) }, w, hgt);
      // The base point is marked as the snap mark would show it.
      render(g, w, hgt, v, {
        ents, layers, selected: new Set(), hover: null, preview: [], snap: { p: P(0, 0), kind: 'end' }, box: null, grid: 0, gridOn: false,
        white: settings.white, units: part.units, arrows: false, photo: null,
      });
    }
    async function insertPart(): Promise<void> {
      let own: { parts: Part[]; unread: string[] };
      try {
        own = await ownParts();
      } catch (error) {
        return void (await shell.report('Could not read the parts folder', error));
      }
      const parts = partList(own.parts);
      const list = h('select', { class: 'field cad-part-list', size: '9', 'aria-label': 'Parts' },
        ...parts.map((p, i) => h('option', { value: String(i) }, p.starter ? `${p.name}  (comes with CAD Draft)` : p.name)));
      list.value = '0';
      const pv = h('canvas', { class: 'cad-part-preview', 'aria-hidden': 'true' });
      const about = h('p', { class: 'dialog-detail cad-part-about' });
      const show = () => {
        const p = parts[Number(list.value)];
        if (!p) return;
        drawPartPreview(pv, p);
        const b = boxOfShapes(p.items.map(i => i.shape));
        const size = b ? `${fmt(b.x1 - b.x0, p.units)} x ${fmt(b.y1 - b.y0, p.units)} ${p.units === 'mm' ? 'mm' : 'in'}` : '';
        about.textContent = `${p.note ? p.note + ' ' : ''}${p.items.length} item${p.items.length === 1 ? '' : 's'}, ${size}. The yellow mark is its base point.`;
      };
      on(list, 'change', show, signal);
      show();
      const where = h('p', { class: 'dialog-detail' },
        `Your own parts are drawings in ${PARTS_FOLDER}: make one with Geometry > Parts > Save the chosen items as a part; open one with File > Open to change it; delete one in My Files.${own.unread.length ? ` Not readable, left out: ${own.unread.join(', ')}.` : ''}`);
      const chosen = await askForm<number>('Insert a part', [list, h('div', { class: 'cad-part-show' }, pv, about), where], () => {
        const i = Number(list.value);
        return parts[i] ? i : 'Choose a part from the list.';
      });
      if (chosen === null) return;
      if (tool) say(`${tool.title}: stopped.`);
      panMode = false;
      tool = partPlaceTool(ctx, parts[chosen]);
      toolId = null;
      say(`${tool.title}.`);
      syncToolButtons();
      refreshPrompt();
      updatePointer();
      keyboardBack();
    }
    function saveChosenAsPart(): void {
      if (!selected.size) return problem('Choose the items for the part first (click them, or drag a box round them), then Geometry > Parts > Save the chosen items as a part.');
      startTool('part-save');
    }
    async function savePart(base: Pt): Promise<void> {
      const items = drawing.ents.filter(e => selected.has(e.id));
      if (!items.length) return problem('Choose the items for the part first (click them, or drag a box round them).');
      const name = h('input', { type: 'text', class: 'field', 'aria-label': 'Name of the part', autocomplete: 'off', value: '' });
      // The form's answer is an object: a bare string from it would be read as a problem to show.
      const answer = await askForm<{ name: string }>('Save as a part', [
        h('label', { class: 'cad-row' }, h('span', {}, 'Name of the part'), name),
        h('p', { class: 'dialog-detail' }, `${items.length} item${items.length === 1 ? '' : 's'}, kept in ${PARTS_FOLDER} as a drawing of ${unitWord()}. Geometry > Parts > Insert a part places it again.`),
      ], () => partNameProblem(name.value) ?? { name: name.value.trim() });
      if (answer === null) return;
      const named = answer.name;
      const target = `${PARTS_FOLDER}/${named}${PART_EXT}`;
      try {
        await shell.fs.ensureFolder(PARTS_FOLDER);
        const there = await shell.fs.exists(target);
        if (there && !(await shell.dialogs.confirm({ title: 'Replace the part?', text: `There is a part called “${named}” already. Replace it with these items?`, ok: 'Replace', danger: true, cancel: 'Cancel' }))) return;
        await shell.fs.writeText(target, writePart(drawing, items, base));
        say(`Part “${named}” saved: ${items.length} item${items.length === 1 ? '' : 's'}, placed by the point ${f(base.x)}, ${f(base.y)}.`);
        shell.toast(`Saved the part “${named}”.`);
      } catch (error) {
        await shell.report('Could not save the part', error);
      }
    }

    let straightening = false;
    /** Redraws the photo's pixels so the clicked corners make a true w x h rectangle (see photo.ts). */
    async function straightenPhoto(corners: Pt[], w: number, hgt: number): Promise<void> {
      const ph = drawing.photo;
      if (!ph) return problem(NO_PHOTO);
      if (straightening) return problem('The photo is being straightened already: wait for it to finish.');
      const plan = planStraighten(ph, corners, w, hgt);
      if (typeof plan === 'string') return problem(plan);
      straightening = true;
      say('Straightening the photo...');
      try {
        let bitmap: ImageBitmap;
        try {
          bitmap = await createImageBitmap(new Blob([fromBase64(ph.jpeg) as Uint8Array<ArrayBuffer>], { type: 'image/jpeg' }));
        } catch {
          throw new CadProblem('The photo in this drawing cannot be read: its picture is damaged. View > Photo to trace > Open a photo puts another in its place.');
        }
        const from = h('canvas', { width: String(ph.px), height: String(ph.py) });
        const fg = from.getContext('2d', { willReadFrequently: true });
        const to = h('canvas', { width: String(plan.px), height: String(plan.py) });
        const tg = to.getContext('2d');
        if (!fg || !tg) throw new CadProblem('The computer would not make room to straighten the photo (it may be short of memory).');
        fg.drawImage(bitmap, 0, 0, ph.px, ph.py);
        bitmap.close();
        const src = fg.getImageData(0, 0, ph.px, ph.py).data;
        tg.putImageData(new ImageData(warpPixels(src, ph.px, ph.py, plan.back, plan.px, plan.py) as Uint8ClampedArray<ArrayBuffer>, plan.px, plan.py), 0, 0);
        const blob = await new Promise<Blob | null>(done => to.toBlob(done, 'image/jpeg', 0.85));
        if (!blob) throw new CadProblem('The straightened photo could not be made into a JPEG (the computer may be short of memory).');
        const jpeg = toBase64(new Uint8Array(await blob.arrayBuffer()));
        if (drawing.photo !== ph) return problem('The photo was changed while it was being straightened, so it was left as it is. Straighten it again.');
        const { clip, at, u, px, py } = plan;
        const next: Photo = { jpeg, px, py, at, u, opacity: ph.opacity, on: true, name: ph.name, ...(clip ? { clip } : {}) };
        commit(() => {
          drawing.photo = next;
        });
        say(`Photo straightened: those four corners are now a ${f(w)} x ${f(hgt)} rectangle, square to the drawing. Only what lies flat on that surface is true to size. Undo puts the photo back as it was.`);
        const b = photoBox(next);
        const v = viewBox();
        if (b.x0 < v.x0 || b.y0 < v.y0 || b.x1 > v.x1 || b.y1 > v.y1) zoomFit();
      } catch (error) {
        if (error instanceof CadProblem) problem(error.message);
        else await shell.report('Could not straighten the photo', error);
      } finally {
        straightening = false;
      }
    }
    function photoTool(id: ToolId): void {
      if (!drawing.photo) return problem(NO_PHOTO);
      if (!drawing.photo.on) setPhotoLook({ on: true }, 'The photo is showing again.');
      startTool(id);
    }

    // ---- Printing to scale -------------------------------------------------------------------------------------------
    let printTitle: string | null = null;
    const stemOf = (name: string) => name.replace(/\.(tcad|dxf)$/i, '');
    const today = () => new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    const pageExtras = (photo?: PageExtras['photo']): PageExtras => ({ photo, fileLabel: stemOf(label), date: today(), units: drawing.units });
    /** The photo as it shows on screen over white (faint as it is set), for paper: as a JPEG and as an address. */
    async function photoForPaper(ph: Photo): Promise<PaperPhoto> {
      const url = jpegUrl(ph.jpeg);
      let jpeg = ph.jpeg;
      try {
        const img = new Image();
        img.src = url;
        await img.decode();
        const cv = h('canvas', { width: String(ph.px), height: String(ph.py) });
        const g = cv.getContext('2d');
        if (g) {
          g.fillStyle = '#ffffff';
          g.fillRect(0, 0, ph.px, ph.py);
          g.globalAlpha = ph.opacity;
          g.drawImage(img, 0, 0);
          const blob = await new Promise<Blob | null>(done => cv.toBlob(done, 'image/jpeg', 0.85));
          if (blob) jpeg = toBase64(new Uint8Array(await blob.arrayBuffer()));
        }
      } finally {
        URL.revokeObjectURL(url);
      }
      return { jpeg, url: jpegUrl(jpeg) };
    }
    /** One page as an SVG at paper size: the preview, and what the browser prints. */
    function svgPage(plan: PrintPlan, i: number, paperPhoto: PaperPhoto | null): SVGElement {
      const painter = new SvgPainter(plan.paperW * PT, plan.paperH * PT, { class: 'cad-print-svg' });
      const photo = paperPhoto && plan.photo
        ? (_p: Painter, on: { tl: Pt; tr: Pt; bl: Pt }, frame: { x: number; y: number; w: number; h: number }) => {
          const ph = plan.photo!;
          // A picture kept inside the frame: an inner SVG cuts off what is outside it.
          painter.root.append(svg('svg', { x: frame.x, y: frame.y, width: frame.w, height: frame.h, viewBox: `${frame.x} ${frame.y} ${frame.w} ${frame.h}`, overflow: 'hidden' },
            svg('image', { href: paperPhoto.url, width: ph.px, height: ph.py, preserveAspectRatio: 'none', transform: `matrix(${pixelMatrix(ph, on).join(' ')})` })));
        }
        : undefined;
      drawCadPage(painter, drawing, plan, i, pageExtras(photo));
      return painter.root;
    }
    /** Prints through the browser: each page as a picture at paper size, everything else hidden while it prints. */
    async function printPages(plan: PrintPlan, paperPhoto: PaperPhoto | null): Promise<void> {
      const holder = h('div', { class: 'sheet-print', 'aria-hidden': 'true' });
      plan.pages.forEach((_, i) => {
        const el = svgPage(plan, i, paperPhoto);
        el.setAttribute('width', `${plan.paperW}mm`);
        el.setAttribute('height', `${plan.paperH}mm`);
        holder.append(h('div', { class: `print-sheet-page cad-paper-${plan.setup.paper}-${plan.setup.landscape ? 'landscape' : 'portrait'}` }, el));
      });
      document.body.append(holder);
      // The photo loads from its address a moment later: printing waits for it (four seconds at most).
      await Promise.all([...holder.querySelectorAll('image')].map(im => new Promise<void>(done => {
        im.addEventListener('load', () => done(), { once: true });
        im.addEventListener('error', () => done(), { once: true });
        setTimeout(done, 4000);
      })));
      document.body.classList.add('printing-sheet');
      const cleanup = () => {
        holder.remove();
        document.body.classList.remove('printing-sheet');
      };
      window.addEventListener('afterprint', cleanup, { once: true });
      try {
        window.print();
      } finally {
        setTimeout(() => {
          if (holder.isConnected) cleanup();
        }, 1000);
      }
    }
    async function savePdf(plan: PrintPlan, paperPhoto: PaperPhoto | null): Promise<void> {
      try {
        const doc = new PdfDocument();
        doc.title = plan.setup.title.trim() || stemOf(label);
        const photoName = paperPhoto && plan.photo ? doc.addJpeg(fromBase64(paperPhoto.jpeg), plan.photo.px, plan.photo.py) : null;
        plan.pages.forEach((_, i) => {
          const page: PdfPage = doc.addPage(plan.paperW * PT, plan.paperH * PT);
          drawCadPage(page, drawing, plan, i, pageExtras(photoName ? (_p, on, frame) => page.imageAt(on.tl, on.tr, on.bl, photoName, frame) : undefined));
        });
        const bytes = await doc.bytes();
        const folder = path ? parentPath(path) : folderHint ?? '/Documents';
        let taken: string[] = [];
        try {
          taken = (await shell.fs.list(folder, true)).map(e => e.name);
        } catch {
          // Saving will say the folder is gone.
        }
        const chosen = await pickSave(shell, { title: 'Save a PDF to scale', folder, name: uniqueName(`${stemOf(label)}.pdf`, taken), accept: ['pdf'], ok: 'Save' });
        setTimeout(keyboardBack, 0);
        if (!chosen) return;
        let target = chosen.path;
        let replacing = chosen.replace;
        if (!/\.pdf$/i.test(target)) {
          target += '.pdf';
          const existing = await shell.fs.stat(target).catch(() => null);
          if (existing && !(await shell.dialogs.confirm({ title: 'Replace it?', text: `“${baseName(target)}” already exists. Replace it with this one?`, ok: 'Replace', danger: true, cancel: 'Cancel' }))) return;
          replacing = !!existing;
        }
        const entry = await shell.fs.writeFile(target, bytes, replacing ? {} : { mustBeNew: true });
        say(`PDF of ${plan.pages.length} page${plan.pages.length === 1 ? '' : 's'} at ${scaleText(plan.n)} saved. Print it at actual size (100%), then measure the 50 mm bar.`);
        shell.toast(`Saved “${entry.name}”.`, { label: 'Open', run: () => void shell.openPath(target) });
      } catch (error) {
        await shell.report('Could not make the PDF', error);
      }
    }
    /** File > Print: the paper, the scale and a title, with a preview of each page; then print, or save a PDF. */
    async function printDialog(): Promise<void> {
      const st: PrintSetup = { ...settings.print, title: printTitle ?? stemOf(label) };
      const paperSel = h('select', { class: 'field', 'aria-label': 'Paper' }, ...(Object.keys(CAD_PAPERS) as CadPaper[]).map(k => h('option', { value: k }, CAD_PAPERS[k].label)));
      paperSel.value = st.paper;
      const orientSel = h('select', { class: 'field', 'aria-label': 'Which way round' }, h('option', { value: 'landscape' }, 'Landscape (wide)'), h('option', { value: 'portrait' }, 'Portrait (tall)'));
      orientSel.value = st.landscape ? 'landscape' : 'portrait';
      const scaleSel = h('select', { class: 'field', 'aria-label': 'Scale' }, h('option', { value: 'fit' }, 'Fit to one page'),
        ...CAD_SCALES.map(n => h('option', { value: String(n) }, n === 1 ? '1:1 (full size)' : `1:${n}`)), h('option', { value: 'other' }, 'Other (1:n)'));
      const otherIn = h('input', { type: 'text', inputmode: 'decimal', class: 'field cad-num', 'aria-label': 'Scale: the number after 1:', autocomplete: 'off' });
      const otherRow = h('label', { class: 'cad-row' }, h('span', {}, 'Scale 1:'), otherIn);
      if (st.scale === 'fit') scaleSel.value = 'fit';
      else if (CAD_SCALES.includes(st.scale)) scaleSel.value = String(st.scale);
      else {
        scaleSel.value = 'other';
        otherIn.value = String(st.scale);
      }
      const whatSel = h('select', { class: 'field', 'aria-label': 'What to print' }, h('option', { value: 'all' }, 'The whole drawing'), h('option', { value: 'view' }, 'What the window shows'));
      whatSel.value = st.what;
      const tick = (text: string, on1: boolean) => {
        const box = h('input', { type: 'checkbox', checked: on1 });
        return { box, row: h('label', { class: 'cad-check' }, box, ` ${text}`) };
      };
      const colour = tick('Each layer in its own colour (off: everything in black)', st.colour);
      const titleBlock = tick('Title block along the bottom (with a 50 mm bar to check the scale)', st.titleBlock);
      const photoTick = tick(drawing.photo?.on === false ? 'The photo under the drawing (hidden now: show it first, View > Photo to trace > Show the photo)' : 'The photo under the drawing', st.photo && drawing.photo?.on !== false);
      photoTick.box.disabled = drawing.photo?.on === false;
      const xlineTick = tick('Construction lines', st.construction);
      const titleIn = h('input', { type: 'text', class: 'field', value: st.title, 'aria-label': 'Title', autocomplete: 'off', maxlength: '120' });
      const drawnIn = h('input', { type: 'text', class: 'field', value: st.drawnBy, 'aria-label': 'Drawn by', autocomplete: 'off', maxlength: '80' });
      const preview = h('div', { class: 'cad-print-preview' });
      const pageLabel = h('span', { class: 'cad-print-page' });
      const prevBtn = h('button', { type: 'button', class: 'cad-mini' }, '◀ Page');
      const nextBtn = h('button', { type: 'button', class: 'cad-mini' }, 'Page ▶');
      const summary = h('p', { class: 'dialog-detail cad-print-summary', role: 'status' });
      const problemEl = h('p', { class: 'dialog-problem', role: 'alert' });
      const hasXlines = drawing.ents.some(e => e.type === 'xline');
      const form = h('div', { class: 'cad-print-form' },
        h('label', { class: 'cad-row' }, h('span', {}, 'Paper'), paperSel),
        h('label', { class: 'cad-row' }, h('span', {}, 'Which way round'), orientSel),
        h('label', { class: 'cad-row' }, h('span', {}, 'Scale'), scaleSel), otherRow,
        h('label', { class: 'cad-row' }, h('span', {}, 'Print'), whatSel),
        h('label', { class: 'cad-row' }, h('span', {}, 'Title'), titleIn),
        h('label', { class: 'cad-row' }, h('span', {}, 'Drawn by'), drawnIn),
        titleBlock.row, colour.row, drawing.photo ? photoTick.row : null, hasXlines ? xlineTick.row : null,
        h('p', { class: 'dialog-detail' }, 'To come out to size: in the print box choose Actual size or Scale 100% (not Fit to page), and print a PDF the same way. Then measure the 50 mm bar with a ruler.'));
      const body = h('div', { class: 'cad-dialog cad-print' }, form, h('div', { class: 'cad-print-side' }, preview, h('div', { class: 'cad-print-nav' }, prevBtn, pageLabel, nextBtn), summary), problemEl);
      const paperPhoto = drawing.photo ? await photoForPaper(drawing.photo).catch(() => null) : null;
      let pageAt = 0;
      let plan: PrintPlan | string = '';
      // Read through a call: the plan is set inside refresh(), which a plain read here would not see.
      const planNow = (): PrintPlan | string => plan;
      const read = (): PrintSetup | string => {
        let scale: number | 'fit';
        if (scaleSel.value === 'fit') scale = 'fit';
        else if (scaleSel.value === 'other') {
          const v = parseNumber(otherIn.value);
          if (v === null || !(v > 0) || v > 1e6) return 'Type the scale as the number after 1: (25 for 1:25; 0.5 for twice full size).';
          scale = v;
        } else scale = Number(scaleSel.value);
        return {
          paper: paperSel.value as CadPaper, landscape: orientSel.value === 'landscape', scale, what: whatSel.value === 'view' ? 'view' : 'all',
          colour: colour.box.checked, titleBlock: titleBlock.box.checked, title: titleIn.value.trim().slice(0, 120), drawnBy: drawnIn.value.trim().slice(0, 80),
          photo: !!drawing.photo && photoTick.box.checked, construction: hasXlines && xlineTick.box.checked,
        };
      };
      const refresh = () => {
        otherRow.hidden = scaleSel.value !== 'other';
        problemEl.textContent = '';
        const setup = read();
        plan = typeof setup === 'string' ? setup : planPrint(drawing, setup, viewBox());
        if (typeof plan === 'string') {
          preview.replaceChildren(h('p', { class: 'cad-print-none' }, plan));
          summary.textContent = '';
          pageLabel.textContent = '';
          prevBtn.disabled = nextBtn.disabled = true;
          return;
        }
        pageAt = Math.max(0, Math.min(pageAt, plan.pages.length - 1));
        preview.replaceChildren(svgPage(plan, pageAt, paperPhoto));
        const paperName = CAD_PAPERS[plan.setup.paper].label.replace(/ \(.*/, '');
        summary.textContent = plan.pages.length > 1
          ? `At ${scaleText(plan.n)} the drawing takes ${plan.pages.length} pages of ${paperName} (${plan.cols} across, ${plan.rows} down). Trim each page on its frame and tape them edge to edge.`
          : `At ${scaleText(plan.n)} the drawing fits on one page of ${paperName}.${plan.setup.scale === 'fit' ? ' Fit is not a standard scale: measure the drawing’s own dimensions, not the paper.' : ''}`;
        pageLabel.textContent = `Page ${pageAt + 1} of ${plan.pages.length}`;
        prevBtn.disabled = pageAt === 0;
        nextBtn.disabled = pageAt >= plan.pages.length - 1;
      };
      const done = new AbortController();
      on(body, 'input', refresh, done.signal);
      on(body, 'change', refresh, done.signal);
      on(prevBtn, 'click', () => {
        pageAt--;
        refresh();
      }, done.signal);
      on(nextBtn, 'click', () => {
        pageAt++;
        refresh();
      }, done.signal);
      refresh();
      try {
        for (;;) {
          const answer = await shell.dialogs.ask<'print' | 'pdf' | null>({
            title: 'Print to scale', body,
            buttons: [{ label: 'Print...', value: 'print', primary: true }, { label: 'Save as PDF...', value: 'pdf' }, { label: 'Cancel', value: null }],
            cancel: null, focus: () => scaleSel,
          });
          if (!answer) return;
          refresh();
          const got = planNow();
          if (typeof got === 'string') {
            problemEl.textContent = got;
            continue;
          }
          const { title, ...keep } = got.setup;
          settings.print = keep;
          printTitle = title;
          keepSettings();
          if (answer === 'print') await printPages(got, paperPhoto);
          else await savePdf(got, paperPhoto);
          return;
        }
      } finally {
        done.abort();
        if (paperPhoto) URL.revokeObjectURL(paperPhoto.url);
        setTimeout(keyboardBack, 0);
      }
    }

    // ---- Recent drawings, and recovery copies ---------------------------------------------------------------------
    /** Puts a drawing at the top of File > Recent drawings (merged with what other windows added meanwhile). */
    async function remember(p: string): Promise<void> {
      shell.native?.remember(p);
      let recent = settings.recent;
      try {
        const saved = JSON.parse(await shell.fs.readText(SETTINGS)) as Partial<Settings>;
        if (Array.isArray(saved.recent)) recent = saved.recent.filter((r): r is string => typeof r === 'string');
      } catch {
        // Nothing kept yet.
      }
      settings.recent = [p, ...recent.filter(r => r !== p)].slice(0, RECENT_MAX);
      keepSettings();
    }
    async function openRecent(p: string): Promise<void> {
      const entry = await shell.fs.stat(p).catch(() => null);
      if (!entry || entry.kind !== 'file') {
        settings.recent = settings.recent.filter(r => r !== p);
        keepSettings();
        return problem(`${baseName(p)} is not in ${parentPath(p) || 'its folder'} any more (moved, renamed or deleted), so it was taken off the list.`);
      }
      const untouched = !path && !drawing.ents.length && !undoStack.length && !drawing.photo;
      await shell.openApp('cad', p);
      if (untouched) app.close();
    }
    /** When this window last wrote its copy's note (below). */
    let recoveryNoted = 0;
    /**
     * The note beside a copy, written every two minutes while the window is open, as shell/recovery.ts writes it: a fresh
     * one tells another window (a second tab, another device) the copy is still in use, so it is not offered as left behind.
     */
    async function writeRecoveryNote(p: string): Promise<void> {
      await shell.fs.writeText(recoveryNoteOf(p), JSON.stringify({ label, path }), { hidden: true });
      recoveryNoted = Date.now();
    }
    /** Keeps a copy of a drawing with unsaved changes, so a flat battery or a closed page loses two minutes at most. */
    async function autosave(): Promise<void> {
      if (!settings.autosave || version === savedVersion || tooBigToSave(drawing)) return;
      const v = version;
      try {
        if (version === autosavedVersion) {
          // Nothing new to keep: the note is written again instead (not more than every minute), to say the copy is in use.
          if (recoveryPath && Date.now() - recoveryNoted >= AUTOSAVE_MS / 2) await writeRecoveryNote(recoveryPath);
          return;
        }
        await shell.fs.ensureFolder(RECOVERY, { hidden: true });
        recoveryPath ??= `${RECOVERY}/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.tcad`;
        const p = recoveryPath;
        liveRecovery.add(p);
        await writeRecoveryNote(p);
        await shell.fs.writeText(p, writeTcad(drawing, { recovery: { label, path } }), { hidden: true });
        // Saved (or closed) while the copy was being written: the copy is not needed after all.
        if (recoveryPath !== p || version === savedVersion) {
          liveRecovery.delete(p);
          if (recoveryPath === p) recoveryPath = null;
          await shell.fs.remove([p, recoveryNoteOf(p)]).catch(() => {});
          return;
        }
        autosavedVersion = v;
      } catch {
        // Not kept this time: it is tried again in two minutes.
      }
    }
    /** The drawing was saved, or closed on purpose: its recovery copy is no longer needed. */
    function dropRecovery(): void {
      const p = recoveryPath;
      recoveryPath = null;
      autosavedVersion = -1;
      if (!p) return;
      liveRecovery.delete(p);
      void shell.fs.remove([p, recoveryNoteOf(p)]).catch(() => {
        // Left behind: it is offered the next time CAD Draft opens, and can be deleted there.
      });
    }
    /** Copies kept by windows that stopped before their drawing was saved: offered to open (or delete). */
    async function offerRecovery(asked: boolean): Promise<void> {
      let left: Entry[] = [];
      let elsewhere = 0;
      try {
        const entries = await shell.fs.list(RECOVERY, true);
        // A copy whose note was written lately is being kept by a window open elsewhere: not left behind, so not offered
        // (opening it would make two windows write over each other; Delete would destroy it).
        const noteWritten = new Map(entries.filter(e => e.name.endsWith('.note.json')).map(e => [e.name, e.modified]));
        const inUse = (e: Entry) => Date.now() - (noteWritten.get(recoveryNoteOf(e.name)) ?? 0) < RECOVERY_IN_USE_MS;
        const copies = entries.filter(e => e.kind === 'file' && /\.tcad$/i.test(e.name) && !liveRecovery.has(`${RECOVERY}/${e.name}`));
        left = copies.filter(e => !inUse(e));
        elsewhere = copies.length - left.length;
      } catch {
        // No recovery folder yet: nothing was left behind.
      }
      if (!left.length) {
        if (asked && elsewhere) {
          await shell.dialogs.alert('Open in another window', `${elsewhere === 1 ? 'A drawing with unsaved changes is' : `${elsewhere} drawings with unsaved changes are`} open in another window or tab (or on another device). Save there, or close that window, and the copy goes.`);
        } else if (asked) {
          await shell.dialogs.alert('Nothing to recover', 'Every drawing was saved or closed on purpose: there is no unsaved copy left behind.');
        }
        return;
      }
      left.sort((a, b) => b.modified - a.modified);
      const lines: string[] = [];
      for (const e of left) {
        let name = 'Drawing';
        try {
          const r = (JSON.parse(await shell.fs.readText(`${RECOVERY}/${e.name}`)) as { recovery?: { label?: unknown } }).recovery;
          if (typeof r?.label === 'string' && r.label) name = r.label;
        } catch {
          // Shown as "Drawing"; opening it says what is wrong.
        }
        lines.push(`${name}: kept ${new Date(e.modified).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`);
      }
      const one = left.length === 1;
      const body = h('div', { class: 'cad-dialog' },
        h('p', {}, `CAD Draft stopped before ${one ? 'this drawing was' : 'these drawings were'} saved (a flat battery, or the page was closed). The last copy kept of ${one ? 'it' : 'each'}:`),
        h('ul', { class: 'cad-recover-list' }, ...lines.map(t => h('li', {}, t))),
        h('p', { class: 'dialog-detail' }, `${one ? 'It opens' : 'Each opens'} as a drawing not saved yet: Save asks where to keep it.`));
      const answer = await shell.dialogs.ask<'open' | 'delete' | null>({
        title: 'Drawings not saved', body,
        buttons: [{ label: one ? 'Open it' : 'Open them', value: 'open', primary: true }, { label: one ? 'Delete it' : 'Delete them', value: 'delete', danger: true }, { label: 'Later', value: null }],
        cancel: null,
      });
      if (answer === 'open') {
        const untouched = !path && !drawing.ents.length && !undoStack.length && !drawing.photo;
        for (const e of left) await shell.openApp('cad', `${RECOVERY}/${e.name}`);
        if (untouched) app.close();
      } else if (answer === 'delete') {
        await shell.fs.remove(left.flatMap(e => [`${RECOVERY}/${e.name}`, recoveryNoteOf(`${RECOVERY}/${e.name}`)])).catch(error => shell.report('Could not delete them', error));
      }
    }
    function setAutosave(on1: boolean): void {
      settings.autosave = on1;
      keepSettings();
      say(on1 ? 'A recovery copy of unsaved changes is kept every two minutes.' : 'No recovery copies: only Save keeps your drawing.');
      if (!on1) dropRecovery();
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
        if (convert.checked && drawing.photo) drawing.photo = { ...drawing.photo, at: mul(drawing.photo.at, k), u: mul(drawing.photo.u, k) };
        drawing.style = convert.checked ? { ...drawing.style, textH: drawing.style.textH * k, dimH: drawing.style.dimH * k, arrow: drawing.style.arrow * k } : defaultStyle(units === 'inch');
        drawing.units = units;
      });
      if (convert.checked) setView({ cx: view.cx * k, cy: view.cy * k, scale: view.scale / k }, false);
      gridSpacing = units === 'mm' ? 10 : 0.5;
      say(convert.checked ? `Now in ${units === 'mm' ? 'millimetres' : 'inches'}; the sizes were changed to match.` : `Now in ${units === 'mm' ? 'millimetres' : 'inches'}; the numbers were kept as they were.`);
    }
    function showHelp(): void {
      void shell.dialogs.alert('What CAD Draft does', [
        'Draws: lines, polylines, rectangles (two corners, centre and size, rounded corners), circles (centre and radius or diameter, two points, three points, touching two items with a radius, touching three items), arcs (three points; centre, start, end; start, end, radius; touching two items), ellipses, polygons, slots, curves through points, points, construction lines, and lines touching arcs and circles.',
        'Snaps: end, middle, centre, intersection, quadrant, nearest, perpendicular, tangent and the grid. Tab steps through the snaps under the pointer; F3 turns them all off and on.',
        'Edits (Edit menu): choose by clicking, by a window (drag to the right: wholly inside) or a crossing box (drag to the left: touching), a chain, a layer or a colour; move, copy, rotate, mirror, scale; arrays in rows and columns, round a centre, or along a line; delete.',
        'Typed points: X and Y in their boxes (an empty box is 0), or in the X box x,y   @dx,dy (from the last point)   @length<angle. Numbers may be sums, such as 600/2+15.',
        'CAD menu: trim, extend, break (at a point or between two), fillet and chamfer (two lines or arcs, one corner of a polyline, or every corner), offset (lines, arcs, circles and polylines of them; not ellipses or curves), join lines and arcs into closed geometries, close, set the start point, reverse, explode, and arrows showing which way each runs.',
        'Layers: show, hide, lock, rename, colour, line type, delete, move items onto a layer. Utils: measure a distance or an angle, area and perimeter, list an item, information about the drawing.',
        'Text (Geometry > Text): words in CAD Draft’s own single-line letters, any height and angle, lined up left, middle or right, several lines, or round an arc or circle. CAD > Explode turns text into lines a cutter can follow.',
        'Dimensions (Utils > Dimensions): linear (across or up), horizontal, vertical, aligned, radius, diameter, angle and leader notes, on the Dimensions layer. They measure their own points: move or scale one and its number follows (they are not tied to the shapes they measure). Double-click text or a dimension to change it.',
        'DXF: File > Open reads DXF of any release saved as text (from CAM programs, AutoCAD and others); File > Output > CAD > DXF writes AutoCAD R12 DXF for the CAM program. What a DXF holds that CAD Draft does not draw (hatches, pictures, 3D) is listed when it opens.',
        'Photo to trace (View > Photo to trace, or the photo button): open a phone photo under the drawing, scale it by clicking two marks a known distance apart (a tape measure in the photo) and typing that distance, line up an edge that should run straight, move it, and draw over it. It stays in the .tcad, can be hidden or made fainter, and never goes into a DXF. A photo taken at a slant: Straighten a slanted photo, then click the four corners of something rectangular lying flat in it (a benchtop, a door, a sheet of A4 at 297 x 210 mm) in order round its edge and type its real width and height; it is redrawn square and to scale. Only what lies flat on that surface comes out true: anything standing up from it (a splashback, a tap) leans.',
        'Parts (Geometry > Parts): choose items and save them as a named part with a base point (a hinge-hole pattern, a sink cut-out); insert a part at a point and a turn, as many times as needed. A few common ones come with CAD Draft (a 35 mm hinge cup, a 32 mm shelf-pin row, handle holes): their sizes are the usual ones, and the hardware maker’s drilling sheet decides. Placed parts are plain items, so the DXF needs nothing new. Your parts are drawings in /Documents/CAD parts.',
        'Print to scale (File > Print to scale, Ctrl+P): A4 to A1, Letter and Tabloid; Fit, 1:1, 1:2, 1:5, 1:10 and more, or any 1:n; too big for one sheet, it prints across several to tape together. A title block carries the title, scale, date, page and a 50 mm bar to check with a ruler. Print at actual size (100%). The same pages save as a PDF.',
        'Saves its own drawings (.tcad), with File > Recent drawings, and keeps a recovery copy of unsaved changes every two minutes (if a flat battery or a closed page stopped it, the next CAD Draft window offers it back; File > Drawings not saved lists them). Not here yet: a CAM program’s own drawing files (open their DXF instead) and outline (hollow) letters. Never here: CAM (toolpaths, G-code), 3D.',
      ].join('\n\n'));
    }
    function showKeys(): void {
      void shell.dialogs.alert('Keys', [
        'Points: type X, Enter, Y, Enter (an empty box is 0). Or type a whole point in the X box: 600,400   @dx,dy (from the last point)   @length<angle.',
        'Done, a right-click, or Enter in the drawing: finish a tool (a polyline, a curve), or start the last tool again.   Escape: stop the tool, or clear the choice.',
        'F3 snaps on and off   F7 grid   F8 ortho (straight across or up)   F9 snap to the grid   Tab: the next snap under the pointer.',
        'Ctrl+Z undo   Ctrl+Y redo   Ctrl+A choose all   Delete: delete the chosen items   Ctrl+S save   Ctrl+Shift+S save as   Ctrl+O open   Ctrl+P print to scale.',
        'Mouse wheel: zoom at the pointer.   Middle button drag, or the Pan tool: move the view.   Double-click an item: choose its chain.',
        'Touch screen or tablet: tap to place a point (the snap shows where your finger lands; slide to another snap before lifting, as it catches from twice as far as the mouse). Two fingers move the view; pinch to zoom. Hold a finger still for half a second for the right-click (Enter while a tool runs, else the menu). A pen works as a mouse. View > Large icons makes the buttons easier to tap.',
        'Alt and the underlined letter, or F10: the menus.   Start typing anywhere in the drawing to use the command line.',
      ].join('\n\n'));
    }

    // ---- Files -------------------------------------------------------------------------------------------------
    const bytes = () => new TextEncoder().encode(writeTcad(drawing));
    /** False (and says why) when the drawing would not open again once saved. */
    async function fitsTheFile(): Promise<boolean> {
      const big = tooBigToSave(drawing);
      if (big) await shell.dialogs.alert('Too big to open again', big);
      return !big;
    }
    async function save(): Promise<boolean> {
      if (!(await fitsTheFile())) return false;
      if (!path) return saveAs();
      try {
        const v = version;
        const entry = await saveOver(shell, path, bytes(), loadedId);
        if (!entry) return false;
        loadedId = entry.id;
        savedVersion = v;
        refreshTitle();
        if (version === savedVersion) dropRecovery();
        void remember(path);
        shell.toast(`Saved “${entry.name}”.`);
        return true;
      } catch (error) {
        await shell.report('Could not save', error);
        return false;
      }
    }
    async function saveAs(): Promise<boolean> {
      if (!(await fitsTheFile())) return false;
      const folder = path ? parentPath(path) : folderHint ?? '/Documents';
      let taken: string[] = [];
      try {
        taken = (await shell.fs.list(folder, true)).map(e => e.name);
      } catch {
        // Saving will say the folder is gone.
      }
      const stem = label.replace(/\.(tcad|dxf)$/i, '');
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
        if (version === savedVersion) dropRecovery();
        void remember(target);
        shell.toast(`Saved “${entry.name}”.`);
        return true;
      } catch (error) {
        await shell.report('Could not save', error);
        return false;
      }
    }
    async function openDrawing(): Promise<void> {
      const chosen = await pickFile(shell, { title: 'Open a drawing (CAD Draft or DXF)', folder: path ? parentPath(path) : folderHint ?? '/Documents', accept: ['tcad', 'dxf'], ok: 'Open' });
      if (!chosen) return;
      // A new window nothing was drawn in gives way to the drawing opened from it.
      const untouched = !path && !drawing.ents.length && !undoStack.length && !drawing.photo;
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
      let b = boxOfShapes(shown);
      if (drawing.photo?.on) {
        const pb = photoBox(drawing.photo);
        b = b ? { x0: Math.min(b.x0, pb.x0), y0: Math.min(b.y0, pb.y0), x1: Math.max(b.x1, pb.x1), y1: Math.max(b.y1, pb.y1) } : pb;
      }
      setView(fitView(b, canvasW(), canvasH()));
    }
    /** The part of the drawing the window shows. */
    function viewBox(): { x0: number; y0: number; x1: number; y1: number } {
      const a = toWorld(view, canvasW(), canvasH(), P(0, 0));
      const b = toWorld(view, canvasW(), canvasH(), P(canvasW(), canvasH()));
      return { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
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
          box, grid: gridSpacing, gridOn: settings.gridOn, white: settings.white, units: drawing.units, arrows: settings.arrows, photo: photoScene(),
        });
      });
    }

    /** Works out snaps and what is under the pointer, then shows the X and Y. */
    function updatePointer(): void {
      const want = tool?.want() ?? {};
      if (tool && want.point && pointerIn && !snapsOff && !panning) {
        const modes = new Set(settings.snaps);
        // A fingertip covers far more than a mouse's tip: it catches from twice as far.
        const k = lastTouch ? 2 : 1;
        snaps = findSnaps(shown(), { at: cursor, reach: (14 * k) / view.scale, modes, from: tool.base(), grid: 0, magnet: (40 * Math.min(k, 1.5)) / view.scale, onItem: (8 * k) / view.scale });
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
    on(app.root, 'pointerdown', (e: PointerEvent) => {
      lastTouch = e.pointerType === 'touch';
    }, signal, { capture: true });
    // Touch: one finger works as the mouse's left button (the snap shows where it lands, and lifting it gives the
    // point); two fingers move the view and pinch to zoom; a finger held still is a right-click. A pen works as a mouse.
    const fingers = new Map<number, Pt>();
    let pinch: { mid: Pt; gap: number; view: View; world: Pt; moved: boolean } | null = null;
    let held: { timer: number; at: Pt } | null = null;
    /** When a finger last touched (the browser's own right-click from a held finger is then left to ours). */
    let touchedAt = -Infinity;
    const HOLD_MS = 550;
    const fingerPair = () => [...fingers.values()].slice(0, 2);
    function letGo(): void {
      if (held) clearTimeout(held.timer);
      held = null;
    }
    function startPinch(): void {
      letGo();
      down = null;
      box = null;
      panning = null;
      canvas.classList.remove('panning');
      const [a, b] = fingerPair();
      const midPt = P((a.x + b.x) / 2, (a.y + b.y) / 2);
      pinch = { mid: midPt, gap: Math.max(1, dist(a, b)), view, world: toWorld(view, canvasW(), canvasH(), midPt), moved: false };
      snaps = [];
      hover = null;
      paint();
    }
    function movePinch(): void {
      if (!pinch) return;
      const [a, b] = fingerPair();
      const midPt = P((a.x + b.x) / 2, (a.y + b.y) / 2);
      const scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, (pinch.view.scale * Math.max(1, dist(a, b))) / pinch.gap));
      // The drawing point first between the fingers stays between them.
      view = { cx: pinch.world.x - (midPt.x - canvasW() / 2) / scale, cy: pinch.world.y + (midPt.y - canvasH() / 2) / scale, scale };
      if (dist(midPt, pinch.mid) > 2 || Math.abs(scale / pinch.view.scale - 1) > 0.01) pinch.moved = true;
      cursor = toWorld(view, canvasW(), canvasH(), midPt);
      refreshXY();
      paint();
    }
    function endPinch(): void {
      if (pinch?.moved) {
        viewBefore.push(pinch.view);
        if (viewBefore.length > 50) viewBefore.shift();
      }
      pinch = null;
    }
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
      if (e.pointerType === 'touch') {
        touchedAt = performance.now();
        fingers.set(e.pointerId, s);
        if (fingers.size === 2) return startPinch();
        if (fingers.size > 2 || pinch) return;
        // No hover with a finger: the snap is worked out where it lands, and shown while it slides.
        pointerIn = true;
        lastScreen = s;
        cursor = toWorld(view, canvasW(), canvasH(), s);
        letGo();
        held = {
          at: s,
          timer: window.setTimeout(() => {
            held = null;
            down = null;
            box = null;
            panning = null;
            canvas.classList.remove('panning');
            const r = canvas.getBoundingClientRect();
            rightClick(r.left + s.x, r.top + s.y);
          }, HOLD_MS),
        };
        updatePointer();
      }
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
      const s = screenOf(e);
      if (e.pointerType === 'touch') {
        if (!fingers.has(e.pointerId)) return;
        fingers.set(e.pointerId, s);
        if (pinch) return movePinch();
        // A finger that slides is aiming, not holding.
        if (held && dist(held.at, s) > 10) letGo();
      }
      pointerIn = true;
      lastScreen = s;
      cursor = toWorld(view, canvasW(), canvasH(), s);
      if (panning) {
        view = { ...panning.view, cx: panning.view.cx - (s.x - panning.x) / view.scale, cy: panning.view.cy + (s.y - panning.y) / view.scale };
        cursor = toWorld(view, canvasW(), canvasH(), s);
        refreshXY();
        paint();
        return;
      }
      // A finger wobbles more than a mouse before it counts as a drag.
      if (down && (!tool || tool.want().select) && dist(down.screen, s) > (e.pointerType === 'touch' ? 10 : 4)) {
        box = { a: down.world, b: cursor, crossing: s.x < down.screen.x };
      }
      updatePointer();
    }, signal);
    on(canvas, 'pointerup', (e: PointerEvent) => {
      const s = screenOf(e);
      if (e.pointerType === 'touch') {
        touchedAt = performance.now();
        fingers.delete(e.pointerId);
        letGo();
        if (pinch) {
          // The rest of a pinch is no click: the next finger down starts afresh.
          if (fingers.size < 2) endPinch();
          return;
        }
        if (fingers.size) return;
      }
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
    on(canvas, 'pointercancel', (e: PointerEvent) => {
      // The system took the finger or pen back (a swipe from the screen's edge): nothing it began is finished.
      fingers.delete(e.pointerId);
      letGo();
      if (pinch && fingers.size < 2) endPinch();
      down = null;
      box = null;
      if (panning) {
        panning = null;
        canvas.classList.remove('panning');
      }
      paint();
    }, signal);
    on(canvas, 'dblclick', (e: MouseEvent) => {
      if (tool) return;
      const hit = hitAt(screenOf(e));
      if (!hit) return;
      if (isNote(hit)) {
        startTool('text-edit');
        (tool as Tool | null)?.pick?.(hit, toWorld(view, canvasW(), canvasH(), screenOf(e)));
        return afterInput();
      }
      const chain = chainFrom(live(), hit);
      selected.clear();
      for (const c of chain) selected.add(c.id);
      say(`${chain.length} item${chain.length === 1 ? '' : 's'} in the chain chosen.`);
      refreshStatus();
      paint();
    }, signal);
    on(canvas, 'contextmenu', (e: MouseEvent) => {
      e.preventDefault();
      // A held finger is answered by our own timer (the same everywhere); the browser's would be a second one.
      const kind = (e as PointerEvent).pointerType;
      if (kind === 'touch' || (!kind && (fingers.size || performance.now() - touchedAt < 1500))) return;
      rightClick(e.clientX, e.clientY);
    }, signal);
    /** A right-click (or a finger held still): Enter while a tool runs, else the drawing's menu. */
    function rightClick(clientX: number, clientY: number): void {
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
        ], clientX, clientY, { returnFocus: canvas });
      }
    }
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
      // A tool part-way through stays: Pan moves the view, then the tool carries on.
      panMode = !panMode;
      syncToolButtons();
      refreshPrompt();
    }, 'pan');
    const selectBtn = btn('select', 'Select: click items, or drag a box (to the right: wholly inside; to the left: touching)', () => {
      // A polyline or curve part-way through is finished as it is (as Done would), not thrown away.
      if (tool) enterKey();
      if (tool) endTool();
      panMode = false;
      syncToolButtons();
      refreshPrompt();
    });

    // The photo button opens the photo's menu (open, scale, line up, move, show).
    const photoBtn = h('button', { type: 'button', class: 'cad-btn', title: 'Photo to trace: open, scale, line up, move', 'aria-label': 'Photo to trace', 'aria-haspopup': 'menu' }, cadIcon('photo'));
    on(photoBtn, 'mousedown', (e: MouseEvent) => e.preventDefault(), signal);
    on(photoBtn, 'click', () => {
      const r = photoBtn.getBoundingClientRect();
      shell.menus.show(photoMenu(), r.left, r.bottom, { returnFocus: canvas });
    }, signal);
    const row1 = h('div', { class: 'cad-tb', role: 'toolbar', 'aria-label': 'Standard and drawing tools' },
      btn('new', 'New drawing', () => void shell.openApp('cad')), btn('open', 'Open... (Ctrl+O)', () => void openDrawing()), btn('save', 'Save (Ctrl+S)', () => void save()), btn('dxfOut', 'Output a DXF for the CAM program (File > Output > CAD > DXF)', () => void outputDxf()),
      btn('print', 'Print or save a PDF to scale (Ctrl+P)', () => void printDialog()), photoBtn, sep(),
      btn('undo', 'Undo (Ctrl+Z)', undo), btn('redo', 'Redo (Ctrl+Y)', redo), sep(),
      toolBtn('line', 'line'), toolBtn('polyline', 'polyline'), toolBtn('rect', 'rect'), toolBtn('circle', 'circle-cr'), toolBtn('arc', 'arc-3p'), toolBtn('ellipse', 'ellipse'),
      toolBtn('polygon', 'polygon-in'), toolBtn('slot', 'slot'), toolBtn('spline', 'spline'), toolBtn('point', 'point'), sep(),
      toolBtn('text', 'text'), toolBtn('textArc', 'text-arc'), toolBtn('dimLinear', 'dim-linear'), toolBtn('dimAligned', 'dim-aligned'), toolBtn('dimRadius', 'dim-radius'),
      toolBtn('dimDiameter', 'dim-diameter'), toolBtn('dimAngle', 'dim-angle'), toolBtn('leader', 'leader'), toolBtn('textEdit', 'text-edit'));
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
      btn('join', 'Join the chosen lines and arcs into geometries', joinChosen), btn('explode', 'Explode the chosen polylines, text or dimensions into lines and arcs', explodeChosen),
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
      // With a finger, points are tapped: the boxes take the keyboard only when a number must be typed, or the
      // on-screen keyboard would cover half the drawing at every step.
      if (w && (lastTouch ? (w.number || w.size) && !w.point : w.point || w.number || w.size)) firstField().focus({ preventScroll: true });
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
      sub_('Recent drawings', settings.recent.length
        ? settings.recent.map(r => ({ label: `${baseName(r)}   (${parentPath(r) || '/'})`, action: () => void openRecent(r) }))
        : [{ label: 'None yet', disabled: true }]),
      { separator: true },
      { label: 'Save', hint: 'Ctrl+S', action: () => void save() },
      { label: 'Save as...', hint: 'Ctrl+Shift+S', action: () => void saveAs() },
      { separator: true },
      { label: 'Print to scale...', hint: 'Ctrl+P', action: () => void printDialog() },
      sub_('Output', [sub_('CAD', [{ label: 'DXF...', action: () => void outputDxf() }]), { label: 'PDF to scale...', action: () => void printDialog() }]),
      { separator: true },
      { label: 'Keep a recovery copy every 2 minutes', checked: settings.autosave, action: () => setAutosave(!settings.autosave) },
      { label: 'Drawings not saved...', action: () => void offerRecovery(true) },
      { separator: true },
      { label: 'Close', action: () => app.close() },
    ];
    const photoMenu = (): MenuItem[] => [
      { label: 'Open a photo...', action: () => void openPhoto() },
      { separator: true },
      { label: 'Scale by a length you know', disabled: !drawing.photo, action: () => photoTool('photo-scale') },
      { label: 'Line up an edge (straight across or up)', disabled: !drawing.photo, action: () => photoTool('photo-turn') },
      { label: 'Straighten a slanted photo (four corners)', disabled: !drawing.photo, action: () => photoTool('photo-square') },
      { label: 'Move', disabled: !drawing.photo, action: () => photoTool('photo-move') },
      { separator: true },
      { label: 'Show the photo', checked: !!drawing.photo?.on, disabled: !drawing.photo, action: () => setPhotoLook({ on: !drawing.photo?.on }, drawing.photo?.on ? 'The photo is hidden (it stays in the drawing).' : 'The photo is showing.') },
      sub_('How strongly it shows', OPACITIES.map(o => ({ label: `${Math.round(o * 100)}%`, checked: drawing.photo?.opacity === o, disabled: !drawing.photo, action: () => setPhotoLook({ opacity: o, on: true }, `The photo shows at ${Math.round(o * 100)}%.`) }))),
      { separator: true },
      { label: 'Remove the photo', disabled: !drawing.photo, danger: true, action: removePhoto },
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
      { label: 'Explode (polylines, text, dimensions)', disabled: !selected.size, action: explodeChosen },
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
      { separator: true },
      sub_('Photo to trace', photoMenu()),
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
      sub_('Text', [item('text'), item('text-arc'), item('text-edit')]),
      { separator: true },
      sub_('Construction lines', [item('xline-h'), item('xline-v'), item('xline-angle'), item('xline-2p'), item('xline-offset')]),
      sub_('Tangent lines', [item('tan-point'), item('tan-two')]),
      { separator: true },
      sub_('Parts', [
        { label: 'Insert a part...', action: () => void insertPart() },
        { label: 'Save the chosen items as a part...', action: saveChosenAsPart },
      ]),
    ];
    const utilsMenu = (): MenuItem[] => [
      item('measure'), item('measure-angle'), item('area'), item('list'),
      { label: 'Information...', action: information },
      { separator: true },
      sub_('Dimensions', [
        item('dim-linear'), item('dim-horizontal'), item('dim-vertical'), item('dim-aligned'),
        item('dim-radius'), item('dim-diameter'), item('dim-angle'), item('leader'),
        { separator: true },
        item('text-edit'),
        { label: 'Sizes for text and dimensions...', action: () => void noteStyleDialog() },
      ]),
      { separator: true },
      sub_('Snaps', [
        ...SNAP_ORDER.filter(m => m !== 'grid').map(m => ({ label: SNAP_NAMES[m], checked: settings.snaps.includes(m), action: () => toggleSnap(m) })),
        { separator: true },
        { label: snapsOff ? 'Turn snaps on' : 'All snaps off', hint: 'F3', action: toggleAllSnaps },
      ]),
      { label: 'Units...', action: () => void unitsDialog() },
    ];
    const helpMenu = (): MenuItem[] => [
      { label: 'What CAD Draft does', action: showHelp },
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
    on(window, 'blur', () => {
      spaceDown = false;
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
      if (ctrl && k === 'p') {
        e.preventDefault();
        return void printDialog();
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
      if (e.key === 'Tab' && snaps.length > 1 && (e.target === canvas || (isEntry && pointerIn))) {
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
    if (arg && !recovered) void remember(arg);
    const autosaveTimer = window.setInterval(() => void autosave(), AUTOSAVE_MS);
    signal.addEventListener('abort', () => clearInterval(autosaveTimer));
    // The lid closing or the page going to the background keeps a copy at once.
    on(document, 'visibilitychange', () => {
      if (document.visibilityState === 'hidden') void autosave();
    }, signal);
    app.onClose(async () => {
      if (version === savedVersion) {
        dropRecovery();
        return true;
      }
      const ok = await shell.dialogs.confirm({ title: 'Close without saving?', text: `“${label}” has changes that are not saved. If you close it they will be lost.`, ok: 'Close without saving', danger: true, cancel: 'Keep it open' });
      if (ok) dropRecovery();
      return ok;
    });
    if (recovered) say(`Recovered ${label}: a copy kept before it was saved. Save it to keep it (Save asks where).`);
    else if (leftOutOnOpen) {
      say(`Opened ${label} as a copy: ${leftOutOnOpen}; those were left out. Save asks where, so the file keeps them.`);
      void shell.dialogs.alert(`Opened ${label} as a copy`, `Some items could not be opened: ${leftOutOnOpen}. They were left out. Saving this copy over the file would lose them, so Save asks for a name (the file itself is not changed).`);
    }
    else if (dxfReport) {
      say(`Opened ${label} (a DXF; Save makes a CAD Draft drawing beside it).`);
      for (const line of dxfReport.lines) say(line);
      if (dxfReport.leftOut || dxfReport.changed) void shell.dialogs.alert(`Opened ${label}`, dxfReport.lines.join('\n\n'));
    } else say(path ? `Opened ${label}.` : 'A new drawing, in millimetres. Choose a tool, or type one such as line.');
    canvas.focus({ preventScroll: true });
    paint();
    if (!recovered) void offerRecovery(false);
  },
};
