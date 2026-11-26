// Reading a DWG's objects: the class list, the object map (handle to place), and each object's common data (its
// type, handle, owner, layer and line type), then the shapes CAD Draft draws, decoded from their own fields. Any
// version from AutoCAD 2000 to 2018 (texts as UTF-16 in a stream of their own from 2007; object types packed
// differently from 2010; a few more fields here and there in 2013 and 2018).
import { BitReader, DwgProblem, V, type Handle } from './bits.ts';
import { stringStream } from './header.ts';

export const CLASS_START = [0x8d, 0xa1, 0xc4, 0xb8, 0xc4, 0xa9, 0xf8, 0xc5, 0xc0, 0xdc, 0xf4, 0x5f, 0xe7, 0xcf, 0xb6, 0x8a];
export const CLASS_END = [0x72, 0x5e, 0x3b, 0x47, 0x3b, 0x56, 0x07, 0x3a, 0x3f, 0x23, 0x0b, 0xa0, 0x18, 0x30, 0x49, 0x75];

/** The most objects a drawing's object map may list. */
export const MAX_OBJECTS = 2_000_000;

export interface DwgClass {
  num: number;
  dxf: string;
  cpp: string;
  entity: boolean;
}

/** The fixed object type numbers, by the DXF name each is known by. */
export const TYPES: Record<number, string> = {
  0x01: 'TEXT', 0x02: 'ATTRIB', 0x03: 'ATTDEF', 0x04: 'BLOCK', 0x05: 'ENDBLK', 0x06: 'SEQEND', 0x07: 'INSERT', 0x08: 'MINSERT', 0x0a: 'VERTEX_2D', 0x0b: 'VERTEX_3D',
  0x0c: 'VERTEX_MESH', 0x0d: 'VERTEX_PFACE', 0x0e: 'VERTEX_PFACE_FACE', 0x0f: 'POLYLINE_2D', 0x10: 'POLYLINE_3D', 0x11: 'ARC', 0x12: 'CIRCLE', 0x13: 'LINE',
  0x14: 'DIMENSION', 0x15: 'DIMENSION', 0x16: 'DIMENSION', 0x17: 'DIMENSION', 0x18: 'DIMENSION', 0x19: 'DIMENSION', 0x1a: 'DIMENSION', 0x1b: 'POINT', 0x1c: '3DFACE',
  0x1d: 'POLYLINE_PFACE', 0x1e: 'POLYLINE_MESH', 0x1f: 'SOLID', 0x20: 'TRACE', 0x21: 'SHAPE', 0x22: 'VIEWPORT', 0x23: 'ELLIPSE', 0x24: 'SPLINE', 0x25: 'REGION',
  0x26: '3DSOLID', 0x27: 'BODY', 0x28: 'RAY', 0x29: 'XLINE', 0x2a: 'DICTIONARY', 0x2b: 'OLEFRAME', 0x2c: 'MTEXT', 0x2d: 'LEADER', 0x2e: 'TOLERANCE', 0x2f: 'MLINE',
  0x30: 'BLOCK_CONTROL', 0x31: 'BLOCK_HEADER', 0x32: 'LAYER_CONTROL', 0x33: 'LAYER', 0x34: 'STYLE_CONTROL', 0x35: 'STYLE', 0x38: 'LTYPE_CONTROL', 0x39: 'LTYPE',
  0x3c: 'VIEW_CONTROL', 0x3d: 'VIEW', 0x3e: 'UCS_CONTROL', 0x3f: 'UCS', 0x40: 'VPORT_CONTROL', 0x41: 'VPORT', 0x42: 'APPID_CONTROL', 0x43: 'APPID',
  0x44: 'DIMSTYLE_CONTROL', 0x45: 'DIMSTYLE', 0x46: 'VP_ENT_HDR_CONTROL', 0x47: 'VP_ENT_HDR', 0x48: 'GROUP', 0x49: 'MLINESTYLE', 0x4a: 'OLE2FRAME', 0x4c: 'LONG_TRANSACTION',
  0x4d: 'LWPOLYLINE', 0x4e: 'HATCH', 0x4f: 'XRECORD', 0x50: 'ACDBPLACEHOLDER', 0x51: 'VBA_PROJECT', 0x52: 'LAYOUT', 0x1f2: 'ACAD_PROXY_ENTITY', 0x1f3: 'ACAD_PROXY_OBJECT',
};

const ENTITY_TYPES = new Set([...Array.from({ length: 0x29 }, (_, i) => i + 1), 0x2b, 0x2c, 0x2d, 0x2e, 0x2f, 0x4a, 0x4d, 0x4e, 0x1f2]);

const tooMany = () => new DwgProblem('an object in it says it holds more than it can (damaged)');

/** Checks a count read from the file against the bits left, so a damaged count cannot ask for a huge allocation. */
export function countOf(r: BitReader, n: number, minBits: number, max = 10_000_000): number {
  if (!(n >= 0) || n > max || n * minBits > r.end - r.pos) throw tooMany();
  return n;
}

export function readClasses(data: Uint8Array, ver: V, maint: number, text: TextDecoder): Map<number, DwgClass> {
  for (let i = 0; i < 16; i++) if (data[i] !== CLASS_START[i]) throw new DwgProblem('its class list is damaged (it does not start the way it should)');
  const r = new BitReader(data, 128, data.length * 8, ver, text);
  const size = r.RL();
  if (ver >= V.R2018 || (ver >= V.R2010 && maint > 3)) r.RL();
  const start = r.pos;
  let end = start + size * 8;
  if (end > data.length * 8) throw new DwgProblem('its class list says it is longer than it is (damaged)');
  r.end = end;
  if (ver >= V.R2007) {
    const bits = r.RL();
    end = start + bits;
    if (end > r.end) throw new DwgProblem('its class list is damaged');
    r.strings = stringStream(r, end);
  }
  const out = new Map<number, DwgClass>();
  if (ver >= V.R2004) {
    r.BS();
    r.RC();
    r.RC();
    r.B();
  }
  while (r.pos < end - 8 && out.size < 10_000) {
    const num = r.BS();
    r.BS();
    r.TV();
    const cpp = r.TV();
    const dxf = r.TV();
    r.B();
    const id = r.BS();
    if (ver >= V.R2004) {
      r.BL();
      r.BS();
      r.BS();
      r.BL();
      r.BL();
    }
    out.set(num, { num, dxf: dxf.toUpperCase(), cpp, entity: id === 0x1f2 });
    if (ver >= V.R2007 && r.strings && r.strings.pos >= r.strings.end) break;
  }
  return out;
}

/** The object map: each object's handle and where it starts, in the order listed. */
export function readObjectMap(data: Uint8Array): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let p = 0;
  for (;;) {
    if (p + 2 > data.length) throw new DwgProblem('its object map is cut short (damaged)');
    const size = (data[p] << 8) | data[p + 1];
    if (size === 2 || size === 0) break;
    if (size > 2040 || p + size + 2 > data.length) throw new DwgProblem('its object map is damaged');
    const r = new BitReader(data, (p + 2) * 8, (p + size) * 8);
    let handle = 0;
    let loc = 0;
    while (r.pos < r.end) {
      handle += r.MC(false);
      loc += r.MC(true);
      out.push([handle, loc]);
      if (out.length > MAX_OBJECTS) throw new DwgProblem(`its object map lists more than ${MAX_OBJECTS.toLocaleString('en-GB')} objects, more than CAD Draft opens`);
    }
    p += size + 2;
  }
  return out;
}

/** An object's common data, with readers left at its own fields and at its handles. */
export interface DwgObject {
  type: number;
  /** The DXF name of its type ('LINE', 'LAYER', 'HATCH'...). */
  name: string;
  handle: number;
  entity: boolean;
  /** The data reader, left at the object's own fields. */
  r: BitReader;
  /** The handle reader, left at the object's own handles. */
  h: BitReader;
  /** Entities: 0 owned by a block (owner set), 1 paper space, 2 model space. */
  entmode: number;
  owner: number;
  layer: number;
  /** The colour index of its own (256 by layer; -1 a true colour). */
  colour: number;
  /** Its own line type (0 by layer or by block). */
  ltype: number;
  ltypeFlags: number;
  invisible: boolean;
  /** R2000 entities: whether its neighbours are listed (needed only to read their handles). */
  size: number;
}

export function readObject(objects: Uint8Array, offset: number, ver: V, text: TextDecoder, classes: Map<number, DwgClass>): DwgObject {
  if (offset < 0 || offset + 4 > objects.length) throw new DwgProblem('an object in it lies outside the file (damaged)');
  const pre = new BitReader(objects, offset * 8, objects.length * 8, ver, text);
  const size = pre.MS();
  let hsize = 0;
  if (ver >= V.R2010) hsize = pre.MC(false);
  const start = pre.pos;
  const end = start + size * 8;
  if (end > objects.length * 8 || size < 2) throw new DwgProblem('an object in it runs past the end of the file (damaged)');
  const r = new BitReader(objects, start, end, ver, text);
  const type = r.OT();
  let handleStart: number;
  if (ver < V.R2010) {
    const bits = r.RL();
    handleStart = start + bits;
  } else handleStart = end - hsize;
  if (handleStart > end || handleStart < r.pos) throw new DwgProblem('an object in it is damaged (its handles lie outside it)');
  r.end = handleStart;
  const handle = r.H().value;
  // Extended data (other programs' own data on the object): passed over.
  for (let guard = 0; ; guard++) {
    const n = r.BS();
    if (n === 0) break;
    if (n < 0 || guard > 4096) throw new DwgProblem('an object in it has damaged extended data');
    r.H();
    countOf(r, n, 8);
    r.pos += n * 8;
  }
  const cls = type >= 500 ? classes.get(type) : undefined;
  const name = cls ? cls.dxf : TYPES[type] ?? `TYPE ${type}`;
  const entity = cls ? cls.entity : ENTITY_TYPES.has(type);
  const h = new BitReader(objects, handleStart, end, ver, text);
  if (ver >= V.R2007) r.strings = stringStream(r, handleStart);
  const o: DwgObject = { type, name, handle, entity, r, h, entmode: 2, owner: 0, layer: 0, colour: 256, ltype: 0, ltypeFlags: 0, invisible: false, size };
  if (!entity) {
    const reactors = countOf(r, r.BL(), 1, 100_000);
    const noXdic = ver >= V.R2004 ? r.B() : 0;
    if (ver >= V.R2013) r.B();
    o.owner = h.ref(handle);
    for (let i = 0; i < reactors; i++) h.ref(handle);
    if (!noXdic) h.ref(handle);
    return o;
  }
  if (r.B()) {
    const n = ver >= V.R2010 ? r.BLL() : r.RL();
    countOf(r, n, 8, Infinity);
    r.pos += n * 8;
  }
  o.entmode = r.BB();
  const reactors = countOf(r, r.BL(), 1, 100_000);
  const noXdic = ver >= V.R2004 ? r.B() : 0;
  if (ver >= V.R2013) r.B();
  const noLinks = ver <= V.R2000 ? r.B() : 1;
  let book = false;
  if (ver >= V.R2004) {
    const c = r.BS();
    if (c & 0x8000) {
      r.BL();
      o.colour = -1;
    } else o.colour = c & 0x1ff;
    if (c & 0x4000) book = true;
    if (c & 0x2000) r.BL();
  } else o.colour = r.BS();
  r.BD();
  o.ltypeFlags = r.BB();
  const plotFlags = r.BB();
  let materialFlags = 0;
  if (ver >= V.R2007) {
    materialFlags = r.BB();
    r.RC();
  }
  let vs = 0;
  if (ver >= V.R2010) vs = r.B() + r.B() + r.B();
  o.invisible = (r.BS() & 1) === 1;
  r.RC();
  if (o.entmode === 0) o.owner = h.ref(handle);
  for (let i = 0; i < reactors; i++) h.ref(handle);
  if (!noXdic) h.ref(handle);
  if (!noLinks) {
    h.ref(handle);
    h.ref(handle);
  }
  if (book) h.ref(handle);
  o.layer = h.ref(handle);
  if (o.ltypeFlags === 3) o.ltype = h.ref(handle);
  if (materialFlags === 3) h.ref(handle);
  if (plotFlags === 3) h.ref(handle);
  for (let i = 0; i < vs; i++) h.ref(handle);
  return o;
}

// ---- Table entries -------------------------------------------------------------------------------------------------

export function entryName(o: DwgObject): string {
  const name = o.r.TV();
  if (o.r.ver >= V.R2007) o.r.BS();
  else {
    o.r.B();
    o.r.BS();
    o.r.B();
  }
  return name;
}

export interface LayerRec {
  name: string;
  /** The colour index, or -1 for a true colour (then rgb). */
  colour: number;
  rgb: number;
  off: boolean;
  frozen: boolean;
  locked: boolean;
  ltype: number;
}

export function readLayer(o: DwgObject): LayerRec {
  const name = entryName(o);
  const flags = o.r.BS();
  const colour = o.r.CMC();
  o.h.ref(o.handle);
  if (o.r.ver >= V.R2000) o.h.ref(o.handle);
  if (o.r.ver >= V.R2007) o.h.ref(o.handle);
  const ltype = o.h.ref(o.handle);
  // Before 2004 an off layer may also have its colour number made negative.
  const negative = o.r.ver < V.R2004 && colour < 0;
  return { name, colour: negative ? -colour : colour, rgb: o.r.rgb, off: (flags & 2) !== 0 || negative, frozen: (flags & 1) !== 0, locked: (flags & 8) !== 0, ltype };
}

export interface BlockRec {
  name: string;
  base: [number, number, number];
  xref: boolean;
  anonymous: boolean;
  /** R2004+: the entities it owns, in order. */
  owned: number[];
}

export function readBlockHeader(o: DwgObject): BlockRec {
  const r = o.r;
  const name = entryName(o);
  const anonymous = r.B() === 1;
  r.B();
  const xref = r.B() === 1;
  const overlaid = r.B() === 1;
  r.B();
  let count = 0;
  if (r.ver >= V.R2004 && !xref && !overlaid) count = countOf(r, r.BL(), 0, MAX_OBJECTS);
  const base = r.BD3();
  const owned: number[] = [];
  if (r.ver >= V.R2004 && count) {
    o.h.ref(o.handle);
    o.h.ref(o.handle);
    if (count * 8 > o.h.end - o.h.pos) throw tooMany();
    for (let i = 0; i < count; i++) owned.push(o.h.ref(o.handle));
  }
  return { name, base, xref: xref || overlaid, anonymous, owned };
}

// ---- Entities ------------------------------------------------------------------------------------------------------

export type P3 = [number, number, number];

export type DwgShape =
  | { k: 'LINE'; a: P3; b: P3; thick: number; ext: P3 }
  | { k: 'CIRCLE'; c: P3; r: number; thick: number; ext: P3 }
  | { k: 'ARC'; c: P3; r: number; a0: number; a1: number; thick: number; ext: P3 }
  | { k: 'POINT'; p: P3; thick: number; ext: P3 }
  | { k: 'ELLIPSE'; c: P3; m: P3; ext: P3; ratio: number; t0: number; t1: number }
  | { k: 'LWPOLYLINE'; closed: boolean; elevation: number; thick: number; ext: P3; pts: Array<[number, number]>; bulges: number[] }
  | { k: 'POLYLINE'; flags: number; thick: number; elevation: number; ext: P3; vertices: number[] }
  | { k: 'VERTEX'; flags: number; p: P3; bulge: number }
  | { k: 'SPLINE'; degree: number; closed: boolean; periodic: boolean; rational: boolean; knots: number[]; ctrl: P3[]; weights: number[]; fit: P3[] }
  | { k: 'TEXT'; attrib: boolean; p: P3; align: [number, number] | null; ext: P3; thick: number; rot: number; h: number; text: string; hAlign: number; vAlign: number; invisibleAttrib: boolean }
  | { k: 'MTEXT'; p: P3; ext: P3; xdir: P3; h: number; attach: number; text: string }
  | { k: 'INSERT'; p: P3; scale: P3; rot: number; ext: P3; block: number; cols: number; rows: number; colGap: number; rowGap: number; attribs: number[] }
  | { k: 'DIMENSION'; block: number }
  | { k: 'XLINE'; ray: boolean; p: P3; d: P3 };

/** Reads the shape of an entity CAD Draft draws, or null for a kind it does not. */
export function readShape(o: DwgObject): DwgShape | null {
  const r = o.r;
  const ver = r.ver;
  const h = () => o.h.ref(o.handle);
  switch (o.name) {
    case 'LINE': {
      const zero = r.B();
      const x0 = r.RD();
      const x1 = r.DD(x0);
      const y0 = r.RD();
      const y1 = r.DD(y0);
      let z0 = 0;
      let z1 = 0;
      if (!zero) {
        z0 = r.RD();
        z1 = r.DD(z0);
      }
      return { k: 'LINE', a: [x0, y0, z0], b: [x1, y1, z1], thick: r.BT(), ext: r.BE() };
    }
    case 'CIRCLE':
      return { k: 'CIRCLE', c: r.BD3(), r: r.BD(), thick: r.BT(), ext: r.BE() };
    case 'ARC':
      return { k: 'ARC', c: r.BD3(), r: r.BD(), thick: r.BT(), ext: r.BE(), a0: r.BD(), a1: r.BD() };
    case 'POINT':
      {
      const pt: DwgShape = { k: 'POINT', p: r.BD3(), thick: r.BT(), ext: r.BE() };
      r.BD();
      return pt;
    }
    case 'ELLIPSE':
      return { k: 'ELLIPSE', c: r.BD3(), m: r.BD3(), ext: r.BD3(), ratio: r.BD(), t0: r.BD(), t1: r.BD() };
    case 'XLINE':
    case 'RAY':
      return { k: 'XLINE', ray: o.name === 'RAY', p: r.BD3(), d: r.BD3() };
    case 'LWPOLYLINE': {
      const flags = r.BS();
      if (flags & 4) r.BD();
      const elevation = flags & 8 ? r.BD() : 0;
      const thick = flags & 2 ? r.BD() : 0;
      const ext: P3 = flags & 1 ? r.BD3() : [0, 0, 1];
      const n = countOf(r, r.BL(), 4);
      const nb = flags & 16 ? countOf(r, r.BL(), 2) : 0;
      const nid = ver >= V.R2010 && flags & 1024 ? countOf(r, r.BL(), 2) : 0;
      const nw = flags & 32 ? countOf(r, r.BL(), 4) : 0;
      const pts: Array<[number, number]> = [];
      for (let i = 0; i < n; i++) {
        if (i === 0) pts.push([r.RD(), r.RD()]);
        else pts.push([r.DD(pts[i - 1][0]), r.DD(pts[i - 1][1])]);
      }
      const bulges = Array.from({ length: n }, () => 0);
      for (let i = 0; i < nb; i++) {
        const b = r.BD();
        if (i < n) bulges[i] = b;
      }
      for (let i = 0; i < nid; i++) r.BL();
      for (let i = 0; i < nw; i++) {
        r.BD();
        r.BD();
      }
      return { k: 'LWPOLYLINE', closed: (flags & 512) !== 0, elevation, thick, ext, pts, bulges };
    }
    case 'POLYLINE_2D': {
      const flags = r.BS();
      r.BS();
      r.BD();
      r.BD();
      const thick = r.BT();
      const elevation = r.BD();
      const ext = r.BE();
      const vertices: number[] = [];
      if (ver >= V.R2004) {
        const n = countOf(r, r.BL(), 0, 2_000_000);
        if (n * 8 > o.h.end - o.h.pos) throw tooMany();
        for (let i = 0; i < n; i++) vertices.push(h());
      } else {
        vertices.push(h(), h());
      }
      return { k: 'POLYLINE', flags, thick, elevation, ext, vertices };
    }
    case 'VERTEX_2D': {
      const flags = r.RC();
      const p = r.BD3();
      const sw = r.BD();
      if (sw >= 0) r.BD();
      const bulge = r.BD();
      if (ver >= V.R2010) r.BL();
      r.BD();
      return { k: 'VERTEX', flags, p, bulge };
    }
    case 'SPLINE': {
      let scenario = r.BL();
      if (ver >= V.R2013) {
        const f1 = r.BL();
        r.BL();
        if (f1 & 1) scenario = 2;
      }
      const degree = r.BL();
      const knots: number[] = [];
      const ctrl: P3[] = [];
      const weights: number[] = [];
      const fit: P3[] = [];
      let closed = false;
      let periodic = false;
      let rational = false;
      if (scenario === 2) {
        r.BD();
        r.BD3();
        r.BD3();
        const nf = countOf(r, r.BL(), 6, 1_000_000);
        for (let i = 0; i < nf; i++) fit.push(r.BD3());
      } else if (scenario === 1) {
        rational = r.B() === 1;
        closed = r.B() === 1;
        periodic = r.B() === 1;
        r.BD();
        r.BD();
        const nk = countOf(r, r.BL(), 2, 1_000_000);
        const nc = countOf(r, r.BL(), 6, 1_000_000);
        const weighted = r.B();
        for (let i = 0; i < nk; i++) knots.push(r.BD());
        for (let i = 0; i < nc; i++) {
          ctrl.push(r.BD3());
          if (weighted) weights.push(r.BD());
        }
      } else return null;
      return { k: 'SPLINE', degree, closed, periodic, rational, knots, ctrl, weights, fit };
    }
    case 'TEXT':
    case 'ATTRIB': {
      const df = r.RC();
      const elevation = df & 1 ? 0 : r.RD();
      const ins = r.RD2();
      const align = df & 2 ? null : ([r.DD(ins[0]), r.DD(ins[1])] as [number, number]);
      const ext = r.BE();
      const thick = r.BT();
      if (!(df & 4)) r.RD();
      const rot = df & 8 ? 0 : r.RD();
      const height = r.RD();
      if (!(df & 16)) r.RD();
      const text = r.TV();
      if (!(df & 32)) r.BS();
      const hAlign = df & 64 ? 0 : r.BS();
      const vAlign = df & 128 ? 0 : r.BS();
      let invisibleAttrib = false;
      if (o.name === 'ATTRIB') {
        if (ver >= V.R2010) r.RC();
        if (ver >= V.R2018 && r.RC() > 1) return null;
        r.TV();
        r.BS();
        invisibleAttrib = (r.RC() & 1) === 1;
      }
      return { k: 'TEXT', attrib: o.name === 'ATTRIB', p: [ins[0], ins[1], elevation], align, ext, thick, rot, h: height, text, hAlign, vAlign, invisibleAttrib };
    }
    case 'MTEXT': {
      const p = r.BD3();
      const ext = r.BD3();
      const xdir = r.BD3();
      r.BD();
      if (ver >= V.R2007) r.BD();
      const height = r.BD();
      const attach = r.BS();
      r.BS();
      r.BD();
      r.BD();
      const text = r.TV();
      return { k: 'MTEXT', p, ext, xdir, h: height, attach, text };
    }
    case 'INSERT':
    case 'MINSERT': {
      const p = r.BD3();
      let scale: P3;
      switch (r.BB()) {
        case 3:
          scale = [1, 1, 1];
          break;
        case 1:
          scale = [1, r.DD(1), r.DD(1)];
          break;
        case 2: {
          const x = r.RD();
          scale = [x, x, x];
          break;
        }
        default: {
          const x = r.RD();
          scale = [x, r.DD(x), r.DD(x)];
        }
      }
      const rot = r.BD();
      const ext = r.BD3();
      const hasAttribs = r.B();
      let nAttribs = 0;
      if (ver >= V.R2004 && hasAttribs) nAttribs = countOf(r, r.BL(), 0, 100_000);
      let cols = 1;
      let rows = 1;
      let colGap = 0;
      let rowGap = 0;
      if (o.name === 'MINSERT') {
        cols = r.BS();
        rows = r.BS();
        colGap = r.BD();
        rowGap = r.BD();
      }
      const block = h();
      const attribs: number[] = [];
      if (hasAttribs) {
        if (ver >= V.R2004) {
          if (nAttribs * 8 > o.h.end - o.h.pos) throw tooMany();
          for (let i = 0; i < nAttribs; i++) attribs.push(h());
        } else attribs.push(h(), h());
      }
      return { k: 'INSERT', p, scale, rot, ext, block, cols, rows, colGap, rowGap, attribs };
    }
    case 'DIMENSION':
      // Its picture is an anonymous block: only the handles are needed (dimension style, then the block).
      h();
      return { k: 'DIMENSION', block: h() };
    default:
      return null;
  }
}

/** A handle as a plain number (for messages and maps). */
export const handleValue = (h: Handle) => h.value;
