// Writing a drawing as an AutoCAD 2004 DWG (AC1018), the format AutoCAD 2004 to 2006 save and every later program
// opens. Written: the header variables, the tables AutoCAD expects (line types, layers, text style, dimension style,
// application id, the active viewport, the model and paper space blocks), the named object dictionary and the two
// layouts; then the drawing's items as LINE, ARC, CIRCLE, ELLIPSE, LWPOLYLINE (arcs as bulges), SPLINE (exact: CAD
// Draft's curves are chains of cubic Beziers, which a spline holds without change), POINT, XLINE and TEXT; dimensions
// as plain lines and text, as the DXF output does. The sections are packed with the format's own LZ77 compression.
import { BitWriter, DwgProblem, V, cp1252Bytes, crc16, crc32, magicBytes, pageChecksum } from './bits.ts';
import { compress18 } from './lz77.ts';
import { writeHeader, type HeaderValue } from './header.ts';
import { CLASS_END, CLASS_START } from './objects.ts';
import { DXF_LINE_TYPES, type DxfOptions } from '../dxf.ts';
import { textStrokes } from '../font.ts';
import { P, TAU, curveThrough, isFull, normAngle, rotatePt, type Box, type Pt } from '../geom.ts';
import { shapeBox, type Drawing, type LineType } from '../model.ts';
import { arcLetters, dimParts, textShapeStrokes, type NoteText } from '../notes.ts';
import { boxAsText, boxGoesAsLines } from '../textbox.ts';

/** AutoCAD's colour numbers for CAD Draft's named layer colours (as the DXF output uses). */
const ACI: Record<string, number> = {
  '#ff4040': 1, '#ffe040': 2, '#60ff60': 3, '#40e0ff': 4, '#4080ff': 5, '#e040e0': 6, '#ffffff': 7, '#c0c0c0': 9,
  '#ff8040': 30, '#ff6090': 241, '#c0a0ff': 181, '#a0ffd0': 111,
};

function aciOf(hex: string): number {
  if (ACI[hex]) return ACI[hex];
  const n = parseInt(hex.slice(1), 16);
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const basic: Array<[number, number[]]> = [[1, [255, 0, 0]], [2, [255, 255, 0]], [3, [0, 255, 0]], [4, [0, 255, 255]], [5, [0, 0, 255]], [6, [255, 0, 255]], [7, [255, 255, 255]], [8, [128, 128, 128]], [9, [192, 192, 192]]];
  let best = 7;
  let bestD = Infinity;
  for (const [i, c] of basic) {
    const dd = (c[0] - rgb[0]) ** 2 + (c[1] - rgb[1]) ** 2 + (c[2] - rgb[2]) ** 2;
    if (dd < bestD) {
      bestD = dd;
      best = i;
    }
  }
  return best;
}

/** Names AutoCAD accepts for layers: none of < > / \ " : ; ? * | , = ` and at most 255 long. */
export function dwgName(name: string): string {
  const n = name.replace(/[<>/\\":;?*|,=`\u0000-\u001f]/g, '_').trim().slice(0, 255);
  return n || 'Layer';
}

/** Text as a TEXT holds it: a %% typed in the words is kept as two % signs (AutoCAD reads %%%). */
const dwgText = (s: string) => s.replace(/\\(?=U\+[0-9a-fA-F]{4})/g, '\\U+005C').replace(/%%/g, '%%%%%%').replace(/[\r\n]+/g, ' ');

// ---- Objects -------------------------------------------------------------------------------------------------------

const T = {
  TEXT: 0x01, BLOCK: 0x04, ENDBLK: 0x05, ARC: 0x11, CIRCLE: 0x12, LINE: 0x13, POINT: 0x1b, ELLIPSE: 0x23, SPLINE: 0x24, XLINE: 0x29, DICTIONARY: 0x2a,
  BLOCK_CONTROL: 0x30, BLOCK_HEADER: 0x31, LAYER_CONTROL: 0x32, LAYER: 0x33, STYLE_CONTROL: 0x34, STYLE: 0x35, LTYPE_CONTROL: 0x38, LTYPE: 0x39,
  VIEW_CONTROL: 0x3c, UCS_CONTROL: 0x3e, VPORT_CONTROL: 0x40, VPORT: 0x41, APPID_CONTROL: 0x42, APPID: 0x43, DIMSTYLE_CONTROL: 0x44, DIMSTYLE: 0x45,
  MLINESTYLE: 0x49, LWPOLYLINE: 0x4d, LAYOUT: 500,
} as const;

type Build = (d: BitWriter, h: BitWriter) => void;

/** One object: its size, its data and handles, and its CRC. */
function object(type: number, handle: number, build: Build): Uint8Array {
  const d = new BitWriter(V.R2004);
  const h = new BitWriter(V.R2004);
  d.H(0, handle);
  d.BS(0);
  build(d, h);
  const all = new BitWriter(V.R2004);
  all.BS(type);
  all.RL(all.pos + 32 + d.pos);
  all.append(d);
  all.append(h);
  const data = all.done();
  const ms = new BitWriter(V.R2004);
  ms.MS(data.length);
  const head = ms.done();
  const out = new Uint8Array(head.length + data.length + 2);
  out.set(head);
  out.set(data, head.length);
  const crc = crc16(out, 0xc0c1, 0, head.length + data.length);
  out[out.length - 2] = crc & 0xff;
  out[out.length - 1] = crc >> 8;
  return out;
}

/** The common part of a table, dictionary or other non-graphic object. */
const plain = (owner: number, rest: Build): Build => (d, h) => {
  d.BL(0);
  d.B(1);
  h.H(4, owner);
  rest(d, h);
};

const entry = (d: BitWriter, name: string) => {
  d.TV(cp1252Bytes(name));
  d.B(0);
  d.BS(0);
  d.B(0);
};

/** The common part of an entity: by-layer colour, line type and line weight. */
const graphic = (layer: number, mode: number, owner: number, rest: Build): Build => (d, h) => {
  d.B(0);
  d.BB(mode);
  d.BL(0);
  d.B(1);
  d.BS(256);
  d.BD(1);
  d.BB(0);
  d.BB(0);
  d.BS(0);
  d.RC(29);
  if (mode === 0) h.H(4, owner);
  h.H(5, layer);
  rest(d, h);
};

// ---- Sections ------------------------------------------------------------------------------------------------------

function objectMap(entries: Array<[number, number]>): Uint8Array {
  const out: number[] = [];
  const sorted = [...entries].sort((a, b) => a[0] - b[0]);
  let i = 0;
  while (i < sorted.length) {
    const w = new BitWriter(V.R2004);
    let lastH = 0;
    let lastL = 0;
    while (i < sorted.length) {
      const before = w.pos;
      w.MCu(sorted[i][0] - lastH);
      w.MCs(sorted[i][1] - lastL);
      if (w.pos / 8 + 2 > 2032) {
        w.pos = before;
        break;
      }
      lastH = sorted[i][0];
      lastL = sorted[i][1];
      i++;
    }
    const body = w.done().subarray(0, w.pos >> 3);
    const sec = new Uint8Array(body.length + 2);
    sec[0] = (body.length + 2) >> 8;
    sec[1] = (body.length + 2) & 0xff;
    sec.set(body, 2);
    const crc = crc16(sec, 0xc0c1);
    out.push(...sec, crc >> 8, crc & 0xff);
  }
  const end = new Uint8Array([0, 2]);
  const crc = crc16(end, 0xc0c1);
  out.push(0, 2, crc >> 8, crc & 0xff);
  return new Uint8Array(out);
}

function classes(list: Array<{ num: number; app: string; cpp: string; dxf: string; entity: boolean; count: number }>): Uint8Array {
  const w = new BitWriter(V.R2004);
  w.BS(list.length ? list[list.length - 1].num : 499);
  w.RC(0);
  w.RC(0);
  w.B(1);
  for (const c of list) {
    w.BS(c.num);
    w.BS(0);
    w.TV(cp1252Bytes(c.app));
    w.TV(cp1252Bytes(c.cpp));
    w.TV(cp1252Bytes(c.dxf));
    w.B(0);
    w.BS(c.entity ? 0x1f2 : 0x1f3);
    w.BL(c.count);
    w.BS(0);
    w.BS(0);
    w.BL(0);
    w.BL(0);
  }
  const body = w.done();
  const out = new Uint8Array(16 + 4 + body.length + 2 + 16);
  out.set(CLASS_START);
  new DataView(out.buffer).setUint32(16, body.length, true);
  out.set(body, 20);
  new DataView(out.buffer).setUint16(20 + body.length, crc16(out, 0xc0c1, 16, 20 + body.length), true);
  out.set(CLASS_END, 22 + body.length);
  return out;
}

class Bytes {
  private parts: number[] = [];
  u8(v: number) {
    this.parts.push(v & 0xff);
    return this;
  }
  u16(v: number) {
    return this.u8(v).u8(v >> 8);
  }
  u32(v: number) {
    return this.u16(v & 0xffff).u16((v >>> 16) & 0xffff);
  }
  u64(v: number) {
    return this.u32(v % 2 ** 32).u32(Math.floor(v / 2 ** 32));
  }
  raw(b: ArrayLike<number>) {
    for (let i = 0; i < b.length; i++) this.parts.push(b[i]);
    return this;
  }
  done() {
    return new Uint8Array(this.parts);
  }
}

const julian = (ms: number): [number, number] => {
  const days = ms / 86400000 + 2440587.5;
  const day = Math.floor(days);
  return [day, Math.round((days - day) * 86400000)];
};

// ---- The file ------------------------------------------------------------------------------------------------------

export interface DwgWritten {
  bytes: Uint8Array;
  notes: string[];
  count: number;
}

export interface DwgWriteOptions extends DxfOptions {
  /** The time written as created and saved (tests give a fixed one). */
  now?: number;
  /** The drawing's two GUIDs (tests give fixed ones). */
  guids?: [string, string];
}

const guid = () => {
  const c = globalThis.crypto;
  const u = c && 'randomUUID' in c ? c.randomUUID() : '00000000-0000-4000-8000-000000000000';
  return `{${u.toUpperCase()}}`;
};

export function writeDwg(d: Drawing, o: DwgWriteOptions): DwgWritten {
  const now = o.now ?? Date.now();
  const [day, msOfDay] = julian(now);
  const k = d.units === 'mm' ? 1 : 1 / 25.4;
  const layerOn = new Map(d.layers.map(l => [l.name, l.on]));
  const ents = d.ents.filter(e => (o.hidden || layerOn.get(e.layer)) && (o.construction || e.type !== 'xline'));
  const leftHidden = d.ents.filter(e => !o.hidden && !layerOn.get(e.layer)).length;
  const leftXlines = d.ents.filter(e => (o.hidden || layerOn.get(e.layer)) && !o.construction && e.type === 'xline').length;

  let next = 0x10;
  const handle = () => next++;
  const H = {
    blockControl: 1, layerControl: 2, styleControl: 3, ltypeControl: 5, viewControl: 6, ucsControl: 7, vportControl: 8, appidControl: 9, dimstyleControl: 0x0a,
    named: 0x0c, group: 0x0d, mlineDict: 0x0e,
  };
  const dicts = { color: handle(), layout: handle(), material: handle(), plotSettings: handle(), plotStyle: handle() };
  const mlineStyle = handle();
  const lt = { byBlock: handle(), byLayer: handle(), continuous: handle() };
  const ltOf = new Map<LineType, number>([['continuous', lt.continuous]]);
  for (const t of ['dashed', 'centre', 'hidden', 'dotted'] as LineType[]) ltOf.set(t, handle());
  const style = handle();
  const appid = handle();
  const dimstyle = handle();
  const vport = handle();
  const model = { header: handle(), block: handle(), end: handle(), layout: handle() };
  const paper = { header: handle(), block: handle(), end: handle(), layout: handle() };

  // Layers: "0" first (AutoCAD's own), then the drawing's, with names AutoCAD accepts.
  const layerHandle = new Map<string, number>();
  const names = new Map<string, string>();
  const used = new Set<string>();
  const zero = handle();
  used.add('0');
  layerHandle.set('0', zero);
  const renamed: string[] = [];
  for (const l of d.layers) {
    if (l.name === '0') {
      names.set('0', '0');
      continue;
    }
    let n = dwgName(l.name);
    for (let i = 2; used.has(n.toUpperCase()); i++) n = `${dwgName(l.name).slice(0, 250)}_${i}`;
    used.add(n.toUpperCase());
    names.set(l.name, n);
    if (n !== l.name) renamed.push(`${l.name} → ${n}`);
    layerHandle.set(l.name, handle());
  }

  const objects: Array<[number, Uint8Array]> = [];
  const add = (type: number, h: number, build: Build) => objects.push([h, object(type, h, build)]);

  // The box round everything.
  let box: Box | null = null;
  for (const e of ents) {
    const b = e.type === 'xline' ? null : shapeBox(e);
    if (b) box = box ? { x0: Math.min(box.x0, b.x0), y0: Math.min(box.y0, b.y0), x1: Math.max(box.x1, b.x1), y1: Math.max(box.y1, b.y1) } : b;
  }
  const ext = box ?? { x0: 0, y0: 0, x1: 100 * k, y1: 100 * k };

  // ---- Entities ----
  const owned: number[] = [];
  let count = 0;
  let curves = 0;
  /** Texts of more than one line, written a TEXT a line. */
  let splitTexts = 0;
  const put = (type: number, layer: string, rest: Build) => {
    const h = handle();
    owned.push(h);
    add(type, h, graphic(layerHandle.get(layer) ?? zero, 2, 0, rest));
    count++;
  };
  const line = (layer: string, a: Pt, b: Pt) =>
    put(T.LINE, layer, d2 => {
      d2.B(1);
      d2.RD(a.x);
      d2.DD(b.x, a.x);
      d2.RD(a.y);
      d2.DD(b.y, a.y);
      d2.BT(0);
      d2.BEup();
    });
  const arc = (layer: string, c: Pt, r: number, a0: number, a1: number) => {
    if (isFull(a0, a1))
      put(T.CIRCLE, layer, d2 => {
        d2.BD3(c.x, c.y, 0);
        d2.BD(r);
        d2.BT(0);
        d2.BEup();
      });
    else
      put(T.ARC, layer, d2 => {
        d2.BD3(c.x, c.y, 0);
        d2.BD(r);
        d2.BT(0);
        d2.BEup();
        d2.BD(normAngle(a0));
        d2.BD(normAngle(a1));
      });
  };
  const poly = (layer: string, pts: Pt[], bulges: number[], closed: boolean) => {
    if (pts.length < 2) return;
    const anyBulge = bulges.some(b => Math.abs(b) > 1e-12);
    put(T.LWPOLYLINE, layer, d2 => {
      d2.BS((anyBulge ? 16 : 0) | (closed ? 512 : 0));
      d2.BL(pts.length);
      if (anyBulge) d2.BL(pts.length);
      pts.forEach((p, i) => {
        if (i === 0) d2.RD2(p.x, p.y);
        else {
          d2.DD(p.x, pts[i - 1].x);
          d2.DD(p.y, pts[i - 1].y);
        }
      });
      if (anyBulge) pts.forEach((_, i) => d2.BD(Math.abs(bulges[i] ?? 0) > 1e-12 ? bulges[i] : 0));
    });
  };
  const text = (layer: string, t: NoteText) => {
    if (o.textAsLines) {
      for (const s of textStrokes(t.text, t.p, t.h, t.angle, t.align)) {
        if (s.length === 2) line(layer, s[0], s[1]);
        else poly(layer, s, s.map(() => 0), false);
      }
      return;
    }
    const rows = t.text.split('\n');
    // A DWG from here has no paragraph text (MTEXT) yet: each line goes as a TEXT of its own, and is said in the notes.
    if (rows.filter(r => r.trim()).length > 1) splitTexts++;
    rows.forEach((row, i) => {
      if (!row.trim()) return;
      const foot = rotatePt(P(t.p.x, t.p.y - i * 1.6 * t.h), t.p, t.angle);
      const rot = Math.abs(t.angle) > 1e-12 ? normAngle(t.angle) : 0;
      const aligned = t.align !== 'left';
      put(T.TEXT, layer, (d2, h2) => {
        const flags = 1 | (aligned ? 0 : 2) | 4 | (rot ? 0 : 8) | 16 | 32 | (aligned ? 0 : 64) | 128;
        d2.RC(flags);
        d2.RD2(foot.x, foot.y);
        if (aligned) {
          d2.DD(foot.x, foot.x);
          d2.DD(foot.y, foot.y);
        }
        d2.BEup();
        d2.BT(0);
        if (rot) d2.RD(rot);
        d2.RD(t.h);
        d2.TV(cp1252Bytes(dwgText(row)));
        if (aligned) d2.BS(t.align === 'centre' ? 1 : 2);
        h2.H(5, style);
      });
    });
  };

  for (const e of ents) {
    const layer = e.layer;
    switch (e.type) {
      case 'line':
        line(layer, e.a, e.b);
        break;
      case 'arc':
        arc(layer, e.c, e.r, e.a0, e.a1);
        break;
      case 'circle':
        arc(layer, e.c, e.r, 0, TAU);
        break;
      case 'poly':
        poly(layer, e.pts, e.bulges, e.closed);
        break;
      case 'ellipse':
        put(T.ELLIPSE, layer, d2 => {
          d2.BD3(e.c.x, e.c.y, 0);
          d2.BD3(e.m.x, e.m.y, 0);
          d2.BD3(0, 0, 1);
          d2.BD(e.ratio);
          const full = isFull(e.t0, e.t1);
          d2.BD(full ? 0 : e.t0);
          d2.BD(full ? TAU : e.t1);
        });
        break;
      case 'spline': {
        const bez = curveThrough(e.fit, e.closed);
        if (!bez.length) break;
        const ctrl: Pt[] = [bez[0].p[0]];
        for (const b of bez) ctrl.push(b.p[1], b.p[2], b.p[3]);
        const knots = [0, 0, 0, 0];
        for (let i = 1; i < bez.length; i++) knots.push(i, i, i);
        knots.push(bez.length, bez.length, bez.length, bez.length);
        put(T.SPLINE, layer, d2 => {
          d2.BL(1);
          d2.BL(3);
          d2.B(0);
          d2.B(0);
          d2.B(0);
          d2.BD(1e-10);
          d2.BD(1e-10);
          d2.BL(knots.length);
          d2.BL(ctrl.length);
          d2.B(0);
          for (const v of knots) d2.BD(v);
          for (const p of ctrl) d2.BD3(p.x, p.y, 0);
        });
        curves++;
        break;
      }
      case 'point':
        put(T.POINT, layer, d2 => {
          d2.BD3(e.p.x, e.p.y, 0);
          d2.BT(0);
          d2.BEup();
          d2.BD(0);
        });
        break;
      case 'xline':
        put(T.XLINE, layer, d2 => {
          d2.BD3(e.p.x, e.p.y, 0);
          d2.BD3(e.d.x, e.d.y, 0);
        });
        break;
      case 'text':
        if (e.box && !e.arc) {
          // A box only made bigger stays text; stretched or bent, its letters go out as the lines they are drawn with.
          const plain = boxAsText(e);
          if (plain) text(layer, plain);
          else for (const s of textShapeStrokes(e)) {
            if (s.length === 2) line(layer, s[0], s[1]);
            else if (s.length > 2) poly(layer, s, s.map(() => 0), false);
          }
        } else if (!e.arc) text(layer, { text: e.text, p: e.p, h: e.h, angle: e.angle, align: e.align });
        else for (const l of arcLetters(e)) if (l.ch.trim()) text(layer, { text: l.ch, p: l.at, h: e.h, angle: l.angle, align: 'left' });
        break;
      case 'dim': {
        const parts = dimParts(e);
        for (const p of parts.pieces) {
          if (p.k === 'seg') line(layer, p.a, p.b);
          else if (p.k === 'arc') arc(layer, p.c, p.r, p.a0, p.a1);
        }
        for (const t of parts.texts) text(layer, t);
        break;
      }
    }
  }

  // ---- Tables ----
  const ownLtypes = (['dashed', 'centre', 'hidden', 'dotted'] as LineType[]).map(t => ({ t, h: ltOf.get(t)! }));
  add(T.BLOCK_CONTROL, H.blockControl, plain(0, (d2, h2) => {
    d2.BL(0);
    h2.H(3, model.header);
    h2.H(3, paper.header);
  }));
  add(T.LAYER_CONTROL, H.layerControl, plain(0, (d2, h2) => {
    d2.BL(layerHandle.size);
    for (const h of layerHandle.values()) h2.H(2, h);
  }));
  add(T.STYLE_CONTROL, H.styleControl, plain(0, (d2, h2) => {
    d2.BL(1);
    h2.H(2, style);
  }));
  add(T.LTYPE_CONTROL, H.ltypeControl, plain(0, (d2, h2) => {
    d2.BL(1 + ownLtypes.length);
    h2.H(2, lt.continuous);
    for (const x of ownLtypes) h2.H(2, x.h);
    h2.H(3, lt.byBlock);
    h2.H(3, lt.byLayer);
  }));
  for (const [type, h] of [[T.VIEW_CONTROL, H.viewControl], [T.UCS_CONTROL, H.ucsControl]] as const) add(type, h, plain(0, d2 => d2.BL(0)));
  add(T.VPORT_CONTROL, H.vportControl, plain(0, (d2, h2) => {
    d2.BL(1);
    h2.H(2, vport);
  }));
  add(T.APPID_CONTROL, H.appidControl, plain(0, (d2, h2) => {
    d2.BL(1);
    h2.H(2, appid);
  }));
  add(T.DIMSTYLE_CONTROL, H.dimstyleControl, plain(0, (d2, h2) => {
    d2.BL(1);
    d2.RC(0);
    h2.H(2, dimstyle);
  }));

  const ltype = (h: number, name: string, desc: string, dashes: number[]) =>
    add(T.LTYPE, h, plain(H.ltypeControl, (d2, h2) => {
      entry(d2, name);
      d2.TV(cp1252Bytes(desc));
      d2.BD(dashes.reduce((t, v) => t + Math.abs(v), 0));
      d2.RC(65);
      d2.RC(dashes.length);
      for (const v of dashes) {
        d2.BD(v);
        d2.BS(0);
        d2.RD(0);
        d2.RD(0);
        d2.BD(1);
        d2.BD(0);
        d2.BS(0);
      }
      for (let i = 0; i < 256; i++) d2.RC(0);
      h2.H(5, 0);
      for (let i = 0; i < dashes.length; i++) h2.H(5, 0);
    }));
  ltype(lt.byBlock, 'ByBlock', '', []);
  ltype(lt.byLayer, 'ByLayer', '', []);
  ltype(lt.continuous, 'Continuous', 'Solid line', []);
  for (const x of ownLtypes) {
    const def = DXF_LINE_TYPES[x.t];
    ltype(x.h, def.name, def.text, def.mm.map(v => v * k));
  }

  const layerRow = (h: number, name: string, colour: number, on: boolean, locked: boolean, ltHandle: number) =>
    add(T.LAYER, h, plain(H.layerControl, (d2, h2) => {
      entry(d2, name);
      d2.BS((on ? 0 : 2) | (locked ? 8 : 0) | 16 | (31 << 5));
      d2.CMC(colour);
      h2.H(5, 0);
      h2.H(5, 0);
      h2.H(5, ltHandle);
    }));
  const ownZero = d.layers.find(l => l.name === '0');
  layerRow(zero, '0', ownZero ? aciOf(ownZero.colour) : 7, ownZero ? ownZero.on : true, ownZero ? ownZero.locked : false, ownZero ? ltOf.get(ownZero.lineType)! : lt.continuous);
  for (const l of d.layers) if (l.name !== '0') layerRow(layerHandle.get(l.name)!, names.get(l.name)!, aciOf(l.colour), l.on, l.locked, ltOf.get(l.lineType)!);

  add(T.STYLE, style, plain(H.styleControl, (d2, h2) => {
    entry(d2, 'Standard');
    d2.B(0);
    d2.B(0);
    d2.BD(0);
    d2.BD(1);
    d2.BD(0);
    d2.RC(0);
    d2.BD(d.style.textH);
    d2.TV(cp1252Bytes('txt'));
    d2.TV(cp1252Bytes(''));
    h2.H(5, 0);
  }));
  add(T.APPID, appid, plain(H.appidControl, (d2, h2) => {
    entry(d2, 'ACAD');
    d2.RC(0);
    h2.H(5, 0);
  }));
  const metric = d.units === 'mm';
  add(T.DIMSTYLE, dimstyle, plain(H.dimstyleControl, (d2, h2) => {
    entry(d2, 'Standard');
    d2.TV(new Uint8Array(0));
    d2.TV(new Uint8Array(0));
    // DIMSCALE DIMASZ DIMEXO DIMDLI DIMEXE DIMRND DIMDLE DIMTP DIMTM
    for (const v of metric ? [1, 2.5, 0.625, 3.75, 1.25, 0, 0, 0, 0] : [1, 0.18, 0.0625, 0.38, 0.18, 0, 0, 0, 0]) d2.BD(v);
    // DIMTOL DIMLIM DIMTIH DIMTOH DIMSE1 DIMSE2
    for (const v of metric ? [0, 0, 0, 0, 0, 0] : [0, 0, 1, 1, 0, 0]) d2.B(v);
    // DIMTAD DIMZIN DIMAZIN
    for (const v of metric ? [1, 8, 0] : [0, 0, 0]) d2.BS(v);
    // DIMTXT DIMCEN DIMTSZ DIMALTF DIMLFAC DIMTVP DIMTFAC DIMGAP DIMALTRND
    for (const v of metric ? [2.5, 2.5, 0, 25.4, 1, 0, 1, 0.625, 0] : [0.18, 0.09, 0, 25.4, 1, 0, 1, 0.09, 0]) d2.BD(v);
    d2.B(0);
    d2.BS(metric ? 3 : 2);
    for (const v of metric ? [1, 0, 0, 0] : [0, 0, 0, 0]) d2.B(v);
    for (let i = 0; i < 3; i++) d2.CMC(0);
    // DIMADEC DIMDEC DIMTDEC DIMALTU DIMALTTD DIMAUNIT DIMFRAC DIMLUNIT DIMDSEP DIMTMOVE DIMJUST
    for (const v of [0, d.style.dp, d.style.dp, 2, 2, 0, 0, 2, 46, 0, 0]) d2.BS(v);
    d2.B(0);
    d2.B(0);
    // DIMTOLJ DIMTZIN DIMALTZ DIMALTTZ
    for (const v of [1, 0, 0, 0]) d2.BS(v);
    d2.B(0);
    d2.BS(3);
    d2.BS(-2);
    d2.BS(-2);
    d2.B(0);
    h2.H(5, 0);
    h2.H(5, style);
    for (let i = 0; i < 4; i++) h2.H(5, 0);
  }));
  const vh = Math.max(ext.y1 - ext.y0, (ext.x1 - ext.x0) / 1.6, 1e-6) * 1.1;
  add(T.VPORT, vport, plain(H.vportControl, (d2, h2) => {
    entry(d2, '*Active');
    d2.BD(vh);
    d2.BD(vh * 1.6);
    d2.RD2((ext.x0 + ext.x1) / 2, (ext.y0 + ext.y1) / 2);
    d2.BD3(0, 0, 0);
    d2.BD3(0, 0, 1);
    d2.BD(0);
    d2.BD(50);
    d2.BD(0);
    d2.BD(0);
    d2.bits(0, 4);
    d2.RC(0);
    d2.RD2(0, 0);
    d2.RD2(1, 1);
    d2.B(0);
    d2.BS(1000);
    d2.B(1);
    d2.BB(3);
    d2.B(0);
    d2.RD2(10 * k, 10 * k);
    d2.B(0);
    d2.B(0);
    d2.BS(0);
    d2.BD(0);
    d2.RD2(0, 0);
    d2.RD2(10 * k, 10 * k);
    d2.B(0);
    d2.B(1);
    d2.BD3(0, 0, 0);
    d2.BD3(1, 0, 0);
    d2.BD3(0, 1, 0);
    d2.BD(0);
    d2.BS(0);
    h2.H(5, 0);
    h2.H(5, 0);
    h2.H(5, 0);
  }));

  // ---- Dictionaries and layouts ----
  const dict = (h: number, owner: number, items: Array<[string, number]>) =>
    add(T.DICTIONARY, h, plain(owner, (d2, h2) => {
      d2.BL(items.length);
      d2.BS(1);
      d2.RC(0);
      for (const [n] of items) d2.TV(cp1252Bytes(n));
      for (const [, v] of items) h2.H(2, v);
    }));
  dict(H.named, 0, [['ACAD_COLOR', dicts.color], ['ACAD_GROUP', H.group], ['ACAD_LAYOUT', dicts.layout], ['ACAD_MATERIAL', dicts.material], ['ACAD_MLINESTYLE', H.mlineDict],
    ['ACAD_PLOTSETTINGS', dicts.plotSettings], ['ACAD_PLOTSTYLENAME', dicts.plotStyle]]);
  dict(dicts.color, H.named, []);
  dict(H.group, H.named, []);
  dict(dicts.layout, H.named, [['Model', model.layout], ['Layout1', paper.layout]]);
  dict(dicts.material, H.named, []);
  dict(H.mlineDict, H.named, [['Standard', mlineStyle]]);
  dict(dicts.plotSettings, H.named, []);
  dict(dicts.plotStyle, H.named, []);
  add(T.MLINESTYLE, mlineStyle, plain(H.mlineDict, d2 => {
    d2.TV(cp1252Bytes('Standard'));
    d2.TV(new Uint8Array(0));
    d2.BS(0);
    d2.CMC(256);
    d2.BD(Math.PI / 2);
    d2.BD(Math.PI / 2);
    d2.RC(2);
    for (const off of [0.5, -0.5]) {
      d2.BD(off);
      d2.CMC(256);
      d2.BS(0);
    }
  }));
  const layout = (h: number, name: string, tab: number, block: number) =>
    add(T.LAYOUT, h, plain(dicts.layout, (d2, h2) => {
      d2.TV(cp1252Bytes('none_device'));
      d2.TV(new Uint8Array(0));
      d2.BS(688);
      for (const v of [0, 0, 0, 0, 297, 210]) d2.BD(v);
      d2.TV(cp1252Bytes('ISO_A4_(210.00_x_297.00_MM)'));
      d2.BD2(0, 0);
      d2.BS(1);
      d2.BS(0);
      d2.BS(1);
      d2.BD2(0, 0);
      d2.BD2(0, 0);
      d2.BD(1);
      d2.BD(1);
      d2.TV(new Uint8Array(0));
      d2.BS(0);
      d2.BD(1);
      d2.BD2(0, 0);
      d2.BS(0);
      d2.BS(0);
      d2.BS(300);
      d2.TV(cp1252Bytes(name));
      d2.BS(tab);
      d2.BS(1);
      d2.BD3(0, 0, 0);
      d2.RD2(0, 0);
      d2.RD2(tab ? 297 : ext.x1, tab ? 210 : ext.y1);
      d2.BD3(0, 0, 0);
      d2.BD3(1, 0, 0);
      d2.BD3(0, 1, 0);
      d2.BD(0);
      d2.BS(0);
      d2.BD3(tab ? 0 : ext.x0, tab ? 0 : ext.y0, 0);
      d2.BD3(tab ? 297 : ext.x1, tab ? 210 : ext.y1, 0);
      d2.BL(0);
      h2.H(5, 0);
      h2.H(4, block);
      h2.H(4, 0);
      h2.H(5, 0);
      h2.H(5, 0);
    }));
  layout(model.layout, 'Model', 0, model.header);
  layout(paper.layout, 'Layout1', 1, paper.header);

  // ---- Blocks ----
  const blockRecord = (sp: typeof model, name: string, list: number[]) => {
    add(T.BLOCK_HEADER, sp.header, plain(H.blockControl, (d2, h2) => {
      entry(d2, name);
      for (let i = 0; i < 5; i++) d2.B(0);
      d2.BL(list.length);
      d2.BD3(0, 0, 0);
      d2.TV(new Uint8Array(0));
      d2.RC(0);
      d2.TV(new Uint8Array(0));
      d2.BL(0);
      h2.H(5, 0);
      h2.H(3, sp.block);
      for (const e of list) h2.H(3, e);
      h2.H(3, sp.end);
      h2.H(5, sp.layout);
    }));
    const mode = sp === model ? 2 : 1;
    add(T.BLOCK, sp.block, graphic(zero, mode, 0, d2 => d2.TV(cp1252Bytes(name))));
    add(T.ENDBLK, sp.end, graphic(zero, mode, 0, () => {}));
  };
  blockRecord(model, '*Model_Space', owned);
  blockRecord(paper, '*Paper_Space', []);

  // ---- Header variables ----
  const hv = new Map<string, HeaderValue>([
    ['HANDSEED', next], ['CLAYER', layerHandle.get(d.current) ?? zero], ['TEXTSTYLE', style], ['CELTYPE', lt.byLayer], ['DIMSTYLE', dimstyle], ['CMLSTYLE', mlineStyle],
    ['BLOCK_CONTROL', H.blockControl], ['LAYER_CONTROL', H.layerControl], ['STYLE_CONTROL', H.styleControl], ['LTYPE_CONTROL', H.ltypeControl], ['VIEW_CONTROL', H.viewControl],
    ['UCS_CONTROL', H.ucsControl], ['VPORT_CONTROL', H.vportControl], ['APPID_CONTROL', H.appidControl], ['DIMSTYLE_CONTROL', H.dimstyleControl],
    ['DICTIONARY_ACAD_GROUP', H.group], ['DICTIONARY_ACAD_MLINESTYLE', H.mlineDict], ['DICTIONARY_NAMED_OBJECTS', H.named], ['DICTIONARY_LAYOUTS', dicts.layout],
    ['DICTIONARY_PLOTSETTINGS', dicts.plotSettings], ['DICTIONARY_PLOTSTYLES', dicts.plotStyle], ['DICTIONARY_MATERIALS', dicts.material], ['DICTIONARY_COLORS', dicts.color],
    ['BLOCK_RECORD_PAPER_SPACE', paper.header], ['BLOCK_RECORD_MODEL_SPACE', model.header], ['LTYPE_BYLAYER', lt.byLayer], ['LTYPE_BYBLOCK', lt.byBlock], ['LTYPE_CONTINUOUS', lt.continuous],
    ['INSUNITS', metric ? 4 : 1], ['LUNITS', 2], ['LUPREC', 4], ['TEXTSIZE', d.style.textH], ['DIMTXT', d.style.dimH], ['DIMASZ', d.style.arrow], ['DIMDEC', d.style.dp],
    ['TDCREATE_DAY', day], ['TDCREATE_MS', msOfDay], ['TDUPDATE_DAY', day], ['TDUPDATE_MS', msOfDay],
    ['EXTMIN', [ext.x0, ext.y0, 0]], ['EXTMAX', [ext.x1, ext.y1, 0]], ['LIMMIN', [ext.x0, ext.y0]], ['LIMMAX', [ext.x1, ext.y1]],
    ['FINGERPRINTGUID', o.guids?.[0] ?? guid()], ['VERSIONGUID', o.guids?.[1] ?? guid()],
    ['CMLSCALE', metric ? 20 : 1], ['DIMGAP', metric ? 0.625 : 0.09],
  ]);
  if (!metric) for (const [n, v] of [['DIMASZ', d.style.arrow], ['DIMEXO', 0.0625], ['DIMDLI', 0.38], ['DIMEXE', 0.18], ['DIMCEN', 0.09], ['DIMTXT', d.style.dimH], ['TEXTSIZE', d.style.textH]] as const) hv.set(n, v);
  const header = writeHeader(hv);

  // ---- Sections ----
  objects.sort((a, b) => a[0] - b[0]);
  const ob = new Bytes().u32(0x0dca);
  const map: Array<[number, number]> = [];
  let at = 4;
  const parts: Uint8Array[] = [];
  for (const [h, bytes] of objects) {
    map.push([h, at]);
    parts.push(bytes);
    at += bytes.length;
  }
  const objData = new Uint8Array(at);
  objData.set(ob.done());
  let p = 4;
  for (const b of parts) {
    objData.set(b, p);
    p += b.length;
  }
  const classData = classes([{ num: 500, app: 'ObjectDBX Classes', cpp: 'AcDbLayout', dxf: 'LAYOUT', entity: false, count: 2 }]);
  const handles = objectMap(map);
  const seedLong = next < 0x7fffffff ? next : 0xffffffff;
  const aux = new Bytes().raw([0xff, 0x77, 0x01]).u16(0x19).u16(0x68).u32(1).u32(0xffffffff).u16(1).u16(0).u32(0).u16(0x19).u16(0x68).u16(0x19).u16(0x68)
    .u16(5).u16(0x893).u16(5).u16(0x893).u16(0).u16(1).u32(0).u32(0).u32(0).u32(0).u32(0).u32(day).u32(msOfDay).u32(day).u32(msOfDay).u32(seedLong).u32(0)
    .u16(0).u16(1).u32(0).u32(0).u32(0).u32(1).u32(0).u32(0).u32(0).u32(0).done();
  const empty = new Bytes().u16(1).u8(0).done();
  const summary = new Bytes().raw(Array.from({ length: 8 }, () => [...empty]).flat()).u32(0).u32(0).u32(day).u32(msOfDay).u32(day).u32(msOfDay).u16(0).u32(0).u32(0).done();
  const preview = new Bytes().raw([0x1f, 0x25, 0x6d, 0x07, 0xd4, 0x36, 0x28, 0x28, 0x9d, 0x57, 0xca, 0x3f, 0x9d, 0x44, 0x10, 0x2b]).u32(1).u8(0)
    .raw([0xe0, 0xda, 0x92, 0xf8, 0x2b, 0xc9, 0xd7, 0xd7, 0x62, 0xa8, 0x35, 0xc0, 0x62, 0xbb, 0xef, 0xd4]).done();
  const template = new Bytes().u16(0).u16(metric ? 1 : 0).done();
  const freeSpace = new Bytes().u32(0).u32(objects.length).u32(day).u32(msOfDay).u32(0).u8(4)
    .u32(0x32).u32(0).u32(0x64).u32(0).u32(0x200).u32(0).u32(0xffffffff).u32(0).done();
  const revHistory = new Bytes().u32(0).u32(0).u32(0).done();

  const bytes = assemble([
    { name: 'AcDb:Header', id: 1, data: header, compress: true },
    { name: 'AcDb:AuxHeader', id: 2, data: aux, compress: true },
    { name: 'AcDb:Classes', id: 3, data: classData, compress: true },
    { name: 'AcDb:Handles', id: 4, data: handles, compress: true },
    { name: 'AcDb:Template', id: 5, data: template, compress: true },
    { name: 'AcDb:ObjFreeSpace', id: 6, data: freeSpace, compress: true },
    { name: 'AcDb:AcDbObjects', id: 7, data: objData, compress: true },
    { name: 'AcDb:RevHistory', id: 8, data: revHistory, compress: true },
    { name: 'AcDb:SummaryInfo', id: 9, data: summary, compress: false },
    { name: 'AcDb:Preview', id: 10, data: preview, compress: false },
  ]);

  const notes: string[] = [`${count} item${count === 1 ? '' : 's'} written (AutoCAD 2004 DWG, ${d.units === 'mm' ? 'millimetres' : 'inches'}: 600 in the drawing is 600 in the file).`];
  if (curves) notes.push(`${curves} curve${curves === 1 ? '' : 's'} written as exact splines (CAD Draft opens ${curves === 1 ? 'it' : 'them'} again as curves through the same points).`);
  if (d.ents.some(e => e.type === 'ellipse')) notes.push('Ellipses are written as true ellipses.');
  if (d.ents.some(e => e.type === 'dim')) notes.push('Dimensions are written as plain lines and text.');
  if (d.ents.some(e => e.type === 'text') && !o.textAsLines) notes.push('Text is written as text: the other program draws it in its own letters, so its width may differ a little.');
  if (splitTexts) notes.push(`${splitTexts} text${splitTexts === 1 ? '' : 's'} of more than one line ${splitTexts === 1 ? 'is' : 'are'} written as one text a line (a DWG from CAD Draft has no paragraph text yet), so ${splitTexts === 1 ? 'it opens' : 'they open'} again as separate texts. A DXF 2000 or later keeps ${splitTexts === 1 ? 'it' : 'them'} whole.`);
  const bent = ents.filter(e => e.type === 'text' && boxGoesAsLines(e)).length;
  if (bent && !o.textAsLines) notes.push(`${bent} stretched or bent text box${bent === 1 ? ' is' : 'es are'} written as polylines in CAD Draft's own letters (the other program's letters could not follow a stretch or a bend).`);
  if (leftHidden) notes.push(`${leftHidden} item${leftHidden === 1 ? '' : 's'} on hidden layers left out.`);
  if (leftXlines) notes.push(`${leftXlines} construction line${leftXlines === 1 ? '' : 's'} left out.`);
  else if (o.construction && ents.some(e => e.type === 'xline')) notes.push('Construction lines are written as endless construction lines (XLINE).');
  if (renamed.length) notes.push(`Layer names AutoCAD cannot hold were changed: ${renamed.join(', ')}.`);
  return { bytes, notes, count };
}

// ---- Pages ---------------------------------------------------------------------------------------------------------

export interface SectionOut {
  name: string;
  id: number;
  data: Uint8Array;
  compress: boolean;
}

const align = (n: number, a: number) => Math.ceil(n / a) * a;
const PAGE = 0x7400;

/** Lays the sections out in pages, with the section map, the page map and the masked file header. */
export function assemble(sections: SectionOut[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  let addr = 0x100;
  const pageList: Array<[number, number]> = [];
  let pageNo = 0;
  const descs: Array<{ s: SectionOut; max: number; pages: Array<{ num: number; dataSize: number; start: number }> }> = [];
  // In the file, the summary and preview come first and the header last, as AutoCAD lays them out.
  const order = [...sections].sort((a, b) => (a.compress === b.compress ? b.id - a.id : a.compress ? 1 : -1));
  const placed = new Map<string, number>();
  for (const s of order) {
    const max = s.compress ? PAGE : Math.max(0x20, align(s.data.length, 0x20));
    const desc = { s, max, pages: [] as Array<{ num: number; dataSize: number; start: number }> };
    for (let start = 0; start < s.data.length || (start === 0 && !s.data.length); start += max) {
      const piece = s.data.subarray(start, Math.min(s.data.length, start + max));
      let data: Uint8Array;
      if (s.compress) data = compress18(piece);
      else {
        data = new Uint8Array(max);
        data.set(piece);
      }
      const num = ++pageNo;
      const size = 32 + align(data.length, 0x20);
      const page = new Uint8Array(size);
      const dataChk = pageChecksum(0, data);
      const plainHead = new Uint8Array(32);
      const hv = new DataView(plainHead.buffer);
      [0x4163043b, s.id, data.length, size, start, 0, 0, dataChk].forEach((v, i) => hv.setUint32(i * 4, v >>> 0, true));
      hv.setUint32(24, pageChecksum(dataChk, plainHead), true);
      const mask = (0x4164536b ^ addr) >>> 0;
      const pv = new DataView(page.buffer);
      for (let i = 0; i < 8; i++) pv.setUint32(i * 4, (hv.getUint32(i * 4, true) ^ mask) >>> 0, true);
      page.set(data, 32);
      if (!placed.has(s.name)) placed.set(s.name, addr);
      chunks.push(page);
      pageList.push([num, size]);
      desc.pages.push({ num, dataSize: data.length, start });
      addr += size;
      if (!s.data.length) break;
    }
    descs.push(desc);
  }
  // The section map, listed from the highest id down after an empty first entry, as AutoCAD does.
  descs.sort((a, b) => b.s.id - a.s.id);
  const sm = new Bytes().u32(descs.length + 1).u32(2).u32(PAGE).u32(0).u32(descs.length + 1);
  const nameBytes = (n: string) => {
    const b = new Uint8Array(64);
    for (let i = 0; i < n.length; i++) b[i] = n.charCodeAt(i);
    return b;
  };
  sm.u64(0).u32(0).u32(PAGE).u32(1).u32(2).u32(0).u32(0).raw(nameBytes(''));
  for (const ds of descs) {
    sm.u64(ds.s.data.length).u32(ds.pages.length).u32(ds.max).u32(1).u32(ds.s.compress ? 2 : 1).u32(ds.s.id).u32(0).raw(nameBytes(ds.s.name));
    for (const pg of ds.pages) sm.u32(pg.num).u32(pg.dataSize).u64(pg.start);
  }
  const systemPage = (type: number, data: Uint8Array) => {
    const comp = compress18(data);
    const head = new Uint8Array(20);
    const hv = new DataView(head.buffer);
    hv.setUint32(0, type, true);
    hv.setUint32(4, data.length, true);
    hv.setUint32(8, comp.length, true);
    hv.setUint32(12, 2, true);
    hv.setUint32(16, pageChecksum(pageChecksum(0, head), comp), true);
    const out = new Uint8Array(20 + comp.length);
    out.set(head);
    out.set(comp, 20);
    return out;
  };
  const smPage = systemPage(0x4163003b, sm.done());
  const smNum = ++pageNo;
  const smSize = align(smPage.length, 0x20);
  const smPadded = new Uint8Array(smSize);
  smPadded.set(smPage);
  chunks.push(smPadded);
  pageList.push([smNum, smSize]);
  addr += smSize;
  // The page map lists itself too: its size is known once packed, so it is packed twice if the size changes.
  const pmNum = ++pageNo;
  const pmAddr = addr;
  let pmSize = 0x40;
  let pmPage: Uint8Array;
  for (;;) {
    const pm = new Bytes();
    for (const [n, s] of [...pageList, [pmNum, pmSize] as [number, number]]) pm.u32(n).u32(s);
    pmPage = systemPage(0x41630e3b, pm.done());
    const need = align(pmPage.length, 0x20);
    if (need <= pmSize) break;
    pmSize = need;
  }
  chunks.push(pmPage);
  addr += pmPage.length;
  // AutoCAD ends the file with an empty page-map header and then a copy of the masked file header.
  const tail = new Bytes().u32(0x41630e3b).u32(0).u32(0).u32(2).u32(0).done();
  chunks.push(tail);
  addr += tail.length;
  const secondHeader = addr;

  const fh = new Uint8Array(0x6c);
  const fv = new DataView(fh.buffer);
  'AcFssFcAJMB'.split('').forEach((c, i) => (fh[i] = c.charCodeAt(0)));
  const set32 = (o: number, v: number) => fv.setUint32(o, v >>> 0, true);
  const set64 = (o: number, v: number) => fv.setBigUint64(o, BigInt(v), true);
  set32(0x0c, 0);
  set32(0x10, 0x6c);
  set32(0x14, 4);
  set32(0x24, 1);
  set32(0x28, pmNum);
  set64(0x2c, pmAddr - 0x100 + pmSize);
  set64(0x34, secondHeader);
  set32(0x3c, 0);
  set32(0x40, pageNo);
  set32(0x44, 0x20);
  set32(0x48, 0x80);
  set32(0x4c, 0x40);
  set32(0x50, pmNum);
  set64(0x54, pmAddr - 0x100);
  set32(0x5c, smNum);
  set32(0x60, pageNo);
  set32(0x64, 0);
  set32(0x68, crc32(fh));
  const magic = magicBytes(0x80);
  const masked = new Uint8Array(0x80);
  for (let i = 0; i < 0x80; i++) masked[i] = (i < 0x6c ? fh[i] : 0) ^ magic[i];

  const first = new Uint8Array(0x100);
  first.set([0x41, 0x43, 0x31, 0x30, 0x31, 0x38]);
  const v0 = new DataView(first.buffer);
  first[0x0b] = 0x68;
  first[0x0c] = 0x03;
  v0.setUint32(0x0d, (placed.get('AcDb:Preview') ?? 0) + 0x20, true);
  first[0x11] = 0x19;
  first[0x12] = 0x68;
  v0.setUint16(0x13, 30, true);
  v0.setUint32(0x20, (placed.get('AcDb:SummaryInfo') ?? 0) + 0x20, true);
  v0.setUint32(0x28, 0x80, true);
  first.set(masked, 0x80);

  const total = 0x100 + chunks.reduce((t, c) => t + c.length, 0) + 0x6c;
  if (total > 0x7fffffff) throw new DwgProblem('This drawing is too big for a DWG file.');
  const out = new Uint8Array(total);
  out.set(first);
  let q = 0x100;
  for (const c of chunks) {
    out.set(c, q);
    q += c.length;
  }
  out.set(masked.subarray(0, 0x6c), q);
  return out;
}
