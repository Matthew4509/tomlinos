// Opening a DWG (AutoCAD 2000 to 2018) into a CAD Draft drawing. Its objects are decoded here; what they hold is then
// handed, as the plain records a DXF would hold, to the DXF reader, so a DWG opens exactly as the same drawing saved as
// DXF would: blocks and dimensions taken apart, splines as polylines of arcs, units, layers and line types, and the
// same report of what was changed or left out ("12 hatch fills, 3 pictures"). A file that cannot be read says why,
// with the version it is.
import { DwgProblem, V, crc16, decoderFor } from './bits.ts';
import { VERSION_NAMES, readParts, type DwgParts } from './container.ts';
import { readHeader } from './header.ts';
import { MAX_OBJECTS, entryName, readBlockHeader, readClasses, readLayer, readObject, readObjectMap, readShape, type BlockRec, type DwgObject, type DwgShape, type LayerRec, type P3 } from './objects.ts';
import { readDxf, type DxfRead } from '../dxf.ts';
import { curveThrough, dist, P, type Pt } from '../geom.ts';
import { CadProblem, MAX_ITEMS, MAX_POINTS } from '../model.ts';

/** Kinds of item CAD Draft does not draw, by the words the report uses for them (the DXF reader adds an s for more). */
const LEFT_OUT: Record<string, string> = {
  POLYLINE_3D: '3D POLYLINE', POLYLINE_PFACE: 'POLYFACE MESH', POLYLINE_MESH: 'MESH', ACAD_PROXY_ENTITY: 'PROXY ITEM', LEADER: 'LEADER LINE', ARC_DIMENSION: 'ARC DIMENSION',
  LARGE_RADIAL_DIMENSION: 'JOGGED DIMENSION', SHAPE: 'SHAPE', OLEFRAME: 'OLE2FRAME', ATTDEF: 'ATTDEF',
};

interface Item {
  o: DwgObject;
  shape: DwgShape | null;
}

/** A number as a DXF line holds it (full precision; the DXF reader reads exponents too). */
const num = (v: number) => (Number.isFinite(v) ? String(v) : '0');
const clean = (s: string) => s.replace(/[\r\n\u0000]+/g, ' ');

export interface DwgRead extends DxfRead {
  version: string;
}

/** Reads a DWG file into a drawing, with the report the DXF reader gives (and what is DWG's own). */
export function readDwg(bytes: Uint8Array): DwgRead {
  const name = String.fromCharCode(...bytes.subarray(0, 6));
  const label = VERSION_NAMES[name] ? `${VERSION_NAMES[name]} DWG (${name})` : 'DWG';
  let parts: DwgParts;
  try {
    parts = readParts(bytes);
  } catch (error) {
    throw explain(error, label);
  }
  try {
    return readFrom(parts, label);
  } catch (error) {
    throw explain(error, label, parts.ver === V.R2007);
  }
}

function explain(error: unknown, label: string, r2007 = false): CadProblem {
  if (error instanceof CadProblem && /^This /.test(error.message)) {
    if (error.message.startsWith('This DXF cannot be opened')) return new DwgProblem(error.message.replace('This DXF', `This ${label}`));
    return error;
  }
  const why = error instanceof DwgProblem ? error.message : 'it is damaged, or holds something CAD Draft does not understand';
  const hint = r2007
    ? ' CAD Draft reads 2007 files from their published description, which could not be checked against a file from AutoCAD: if the file opens elsewhere, save it there as 2004 or 2010 DWG (or DXF) and open that.'
    : ' If it opens in the program that made it, save it again there (as DWG 2004 to 2018, or as DXF) and open that.';
  return new DwgProblem(`This ${label} cannot be opened: ${why}.${hint}`);
}

function readFrom(parts: DwgParts, label: string): DwgRead {
  const ver = parts.ver;
  const text = decoderFor(parts.codePage);
  const extra: string[] = [];
  let header = new Map<string, unknown>();
  try {
    header = readHeader(parts.header, ver, parts.maint, text);
  } catch {
    extra.push('Its header could not be read, so its units are not known.');
  }
  let classes = new Map();
  try {
    classes = readClasses(parts.classes, ver, parts.maint, text);
  } catch {
    extra.push('Its list of classes could not be read: items of the newer kinds were left out.');
  }
  const map = readObjectMap(parts.handles);
  if (map.length > MAX_OBJECTS) throw new DwgProblem('it holds more objects than CAD Draft opens');

  const layers = new Map<number, LayerRec>();
  const ltypes = new Map<number, string>();
  const blocks = new Map<number, BlockRec & { handle: number }>();
  const items = new Map<number, Item>();
  const order: number[] = [];
  const seen = new Set<number>();
  let badCrc = 0;
  let damaged = 0;
  let entities = 0;
  let points = 0;
  for (const [, offset] of map) {
    if (seen.has(offset)) throw new DwgProblem('its object map points two objects at one place (damaged)');
    seen.add(offset);
    let o: DwgObject;
    try {
      o = readObject(parts.objects, offset, ver, text, classes);
      const end = o.h.end >> 3;
      const stored = parts.objects[end] | (parts.objects[end + 1] << 8);
      if (end + 2 > parts.objects.length || crc16(parts.objects, 0xc0c1, offset, end) !== stored) {
        badCrc++;
        continue;
      }
    } catch {
      damaged++;
      continue;
    }
    try {
      if (o.name === 'LAYER') layers.set(o.handle, readLayer(o));
      else if (o.name === 'LTYPE') ltypes.set(o.handle, entryName(o));
      else if (o.name === 'BLOCK_HEADER') blocks.set(o.handle, { ...readBlockHeader(o), handle: o.handle });
      else if (o.entity) {
        if (++entities > MAX_ITEMS) throw new CadProblem(`This ${label} holds more than ${MAX_ITEMS.toLocaleString('en-GB')} items, more than CAD Draft opens.`);
        const shape = readShape(o);
        if (shape?.k === 'LWPOLYLINE') points += shape.pts.length;
        else if (shape?.k === 'SPLINE') points += shape.ctrl.length + shape.fit.length;
        else if (shape?.k === 'VERTEX') points++;
        if (points > MAX_POINTS) throw new CadProblem(`This ${label}'s polylines and curves hold more than ${MAX_POINTS.toLocaleString('en-GB')} points, more than CAD Draft opens.`);
        items.set(o.handle, { o, shape });
        order.push(o.handle);
      }
    } catch (error) {
      if (error instanceof CadProblem && !(error instanceof DwgProblem)) throw error;
      damaged++;
    }
  }
  const total = map.length;
  if (total && badCrc + damaged > total / 2) throw new DwgProblem(`${badCrc + damaged} of its ${total.toLocaleString('en-GB')} objects are damaged (their check sums are wrong or they cannot be read)`);

  // Which block each entity belongs to: model space, a paper layout, or a block of its own.
  const blockList = [...blocks.values()];
  const modelHandle = (header.get('BLOCK_RECORD_MODEL_SPACE') as number | undefined) ?? 0;
  const model = blocks.get(modelHandle) ?? blockList.find(b => b.name.toUpperCase() === '*MODEL_SPACE');
  if (!model) throw new DwgProblem('it has no model space (damaged)');
  const isPaper = (b: BlockRec | undefined) => !!b && /^\*PAPER_SPACE/i.test(b.name);
  const byOwner = new Map<number, number[]>();
  for (const h of order) {
    const it = items.get(h)!;
    const owner = it.o.entmode === 2 ? model.handle : it.o.entmode === 1 ? -1 : it.o.owner;
    let list = byOwner.get(owner);
    if (!list) byOwner.set(owner, (list = []));
    list.push(h);
  }
  /** A block's entities in order: its own list (2004 and later), else in the order of the object map. */
  const contents = (b: BlockRec & { handle: number }) => (b.owned.length ? b.owned.filter(h => items.has(h)) : byOwner.get(b.handle) ?? []);

  const out: string[] = [];
  const tag = (code: number, value: string | number) => out.push(String(code), typeof value === 'number' ? num(value) : value);
  tag(0, 'SECTION');
  tag(2, 'HEADER');
  const units = header.get('INSUNITS');
  if (typeof units === 'number') {
    tag(9, '$INSUNITS');
    tag(70, String(units));
  }
  tag(0, 'ENDSEC');
  tag(0, 'SECTION');
  tag(2, 'TABLES');
  for (const l of layers.values()) {
    tag(0, 'LAYER');
    tag(2, clean(l.name));
    tag(70, String((l.frozen ? 1 : 0) | (l.locked ? 4 : 0)));
    const c = l.colour === -1 ? 7 : Math.max(1, Math.min(255, l.colour || 7));
    tag(62, String(l.off ? -c : c));
    if (l.colour === -1) tag(420, String(l.rgb));
    tag(6, clean(ltypes.get(l.ltype) ?? 'CONTINUOUS'));
  }
  tag(0, 'ENDSEC');

  const layerName = (h: number) => clean(layers.get(h)?.name ?? '0');
  let ours = 0;
  let foreignFit = 0;
  let paper = 0;
  let xrefs = 0;
  const vertexOwners = new Map<number, number[]>();
  for (const h of order) {
    const it = items.get(h)!;
    if (it.shape?.k === 'VERTEX' || it.o.name === 'ATTRIB') {
      let list = vertexOwners.get(it.o.owner);
      if (!list) vertexOwners.set(it.o.owner, (list = []));
      list.push(h);
    }
  }
  const emit = (h: number) => {
    const it = items.get(h);
    if (!it) return;
    const { o, shape: s } = it;
    if (['BLOCK', 'ENDBLK', 'SEQEND', 'VERTEX_2D', 'VERTEX_3D', 'VERTEX_MESH', 'VERTEX_PFACE', 'VERTEX_PFACE_FACE', 'ATTRIB'].includes(o.name)) return;
    const common = () => {
      tag(8, layerName(o.layer));
      if (o.colour !== 256) tag(62, String(o.colour === -1 ? 7 : o.colour));
      if (o.colour === -1) tag(420, '0');
      const lt = o.ltypeFlags === 3 ? ltypes.get(o.ltype) : o.ltypeFlags === 2 ? 'Continuous' : undefined;
      if (lt && !/^(BYLAYER|BYBLOCK)$/i.test(lt)) tag(6, clean(lt));
    };
    const ext = (e: P3) => {
      if (e[0] !== 0 || e[1] !== 0 || e[2] !== 1) {
        tag(210, e[0]);
        tag(220, e[1]);
        tag(230, e[2]);
      }
    };
    const thick = (t: number) => {
      if (t) tag(39, t);
    };
    const pt = (code: number, p: ArrayLike<number>) => {
      tag(code, p[0]);
      tag(code + 10, p[1]);
      if (p.length > 2) tag(code + 20, p[2]);
    };
    if (!s) {
      if (o.name === 'VIEWPORT') return;
      tag(0, LEFT_OUT[o.name] ?? (o.name.startsWith('TYPE ') ? 'UNKNOWN ITEM' : o.name));
      common();
      return;
    }
    switch (s.k) {
      case 'LINE':
        tag(0, 'LINE');
        common();
        pt(10, s.a);
        pt(11, s.b);
        thick(s.thick);
        ext(s.ext);
        break;
      case 'CIRCLE':
      case 'ARC':
        tag(0, s.k);
        common();
        pt(10, s.c);
        tag(40, s.r);
        if (s.k === 'ARC') {
          tag(50, (s.a0 * 180) / Math.PI);
          tag(51, (s.a1 * 180) / Math.PI);
        }
        thick(s.thick);
        ext(s.ext);
        break;
      case 'POINT':
        tag(0, 'POINT');
        common();
        pt(10, s.p);
        thick(s.thick);
        break;
      case 'ELLIPSE':
        tag(0, 'ELLIPSE');
        common();
        pt(10, s.c);
        pt(11, s.m);
        tag(40, s.ratio);
        tag(41, s.t0);
        tag(42, s.t1);
        ext(s.ext);
        break;
      case 'XLINE':
        tag(0, s.ray ? 'RAY' : 'XLINE');
        common();
        pt(10, s.p);
        pt(11, s.d);
        break;
      case 'LWPOLYLINE':
        tag(0, 'LWPOLYLINE');
        common();
        tag(90, String(s.pts.length));
        tag(70, s.closed ? '1' : '0');
        if (s.elevation) tag(38, s.elevation);
        thick(s.thick);
        s.pts.forEach((p, i) => {
          tag(10, p[0]);
          tag(20, p[1]);
          if (s.bulges[i]) tag(42, s.bulges[i]);
        });
        ext(s.ext);
        break;
      case 'POLYLINE': {
        // Its vertices: listed in it (2004 and later), else every vertex it owns, in the order of the object map.
        const listed = s.vertices.length > 2 || (s.vertices.length && ver >= V.R2004) ? s.vertices.filter(v => items.has(v)) : vertexOwners.get(o.handle) ?? [];
        tag(0, 'POLYLINE');
        common();
        tag(66, '1');
        pt(10, [0, 0, s.elevation]);
        tag(70, String(s.flags));
        thick(s.thick);
        ext(s.ext);
        for (const v of listed) {
          const vs = items.get(v)?.shape;
          if (vs?.k !== 'VERTEX') continue;
          tag(0, 'VERTEX');
          tag(8, layerName(o.layer));
          pt(10, [vs.p[0], vs.p[1], vs.p[2]]);
          if (vs.bulge) tag(42, vs.bulge);
          tag(70, String(vs.flags));
        }
        tag(0, 'SEQEND');
        tag(8, layerName(o.layer));
        break;
      }
      case 'SPLINE': {
        tag(0, 'SPLINE');
        common();
        const fit = oursFit(s);
        if (fit) {
          ours++;
          tag(70, fit.closed ? '1' : '0');
          tag(71, '3');
          for (const p of fit.pts) pt(11, [p.x, p.y]);
          break;
        }
        if (!s.ctrl.length && s.fit.length) foreignFit++;
        tag(70, String((s.closed ? 1 : 0) | (s.periodic ? 2 : 0) | (s.rational ? 4 : 0)));
        tag(71, String(s.degree));
        for (const k of s.knots) tag(40, k);
        if (s.rational) for (const w of s.weights) tag(41, w);
        for (const p of s.ctrl) pt(10, p);
        for (const p of s.fit) pt(11, p);
        break;
      }
      case 'TEXT':
        if (s.attrib && s.invisibleAttrib) break;
        tag(0, 'TEXT');
        common();
        pt(10, s.p);
        tag(40, s.h);
        tag(1, clean(s.text));
        if (s.rot) tag(50, (s.rot * 180) / Math.PI);
        if (s.hAlign) tag(72, String(s.hAlign));
        if (s.vAlign) tag(73, String(s.vAlign));
        if (s.align) pt(11, [s.align[0], s.align[1], s.p[2]]);
        thick(s.thick);
        ext(s.ext);
        break;
      case 'MTEXT':
        tag(0, 'MTEXT');
        common();
        pt(10, s.p);
        tag(40, s.h);
        tag(71, String(s.attach));
        pt(11, s.xdir);
        tag(1, s.text.replace(/\r\n|\r|\n/g, '\\P').replace(/\u0000/g, ''));
        ext(s.ext);
        break;
      case 'INSERT': {
        const b = blocks.get(s.block);
        if (b?.xref) {
          xrefs++;
          tag(0, 'XREF INSERT');
          common();
          break;
        }
        tag(0, 'INSERT');
        common();
        tag(2, clean(b?.name ?? `*missing ${s.block}`));
        pt(10, s.p);
        tag(41, s.scale[0]);
        tag(42, s.scale[1]);
        tag(43, s.scale[2]);
        if (s.rot) tag(50, (s.rot * 180) / Math.PI);
        if (s.cols > 1 || s.rows > 1) {
          tag(70, String(s.cols));
          tag(71, String(s.rows));
          tag(44, s.colGap);
          tag(45, s.rowGap);
        }
        ext(s.ext);
        const attribs = s.attribs.length > 2 || (s.attribs.length && ver >= V.R2004) ? s.attribs : (vertexOwners.get(o.handle) ?? []);
        for (const a of attribs) {
          const at = items.get(a);
          if (at?.shape?.k !== 'TEXT' || at.shape.invisibleAttrib) continue;
          const t = at.shape;
          tag(0, 'ATTRIB');
          tag(8, layerName(at.o.layer));
          pt(10, t.p);
          tag(40, t.h);
          tag(1, clean(t.text));
          if (t.rot) tag(50, (t.rot * 180) / Math.PI);
          if (t.hAlign) tag(72, String(t.hAlign));
          if (t.vAlign) tag(73, String(t.vAlign));
          if (t.align) pt(11, [t.align[0], t.align[1], t.p[2]]);
          tag(70, '0');
        }
        break;
      }
      case 'DIMENSION': {
        tag(0, 'DIMENSION');
        common();
        const b = blocks.get(s.block);
        if (b) tag(2, clean(b.name));
        break;
      }
      case 'VERTEX':
        break;
    }
  };

  tag(0, 'SECTION');
  tag(2, 'BLOCKS');
  for (const b of blockList) {
    if (b === model || isPaper(b) || b.xref) continue;
    tag(0, 'BLOCK');
    tag(8, '0');
    tag(2, clean(b.name));
    tag(70, '0');
    pt3(tag, 10, b.base);
    for (const h of contents(b)) emit(h);
    tag(0, 'ENDBLK');
    tag(8, '0');
  }
  tag(0, 'ENDSEC');
  tag(0, 'SECTION');
  tag(2, 'ENTITIES');
  for (const h of contents(model)) emit(h);
  tag(0, 'ENDSEC');
  tag(0, 'EOF');
  const onPaper = new Set<number>(byOwner.get(-1) ?? []);
  for (const b of blockList) if (isPaper(b)) for (const h of contents(b)) onPaper.add(h);
  for (const h of onPaper) if (!/^(VIEWPORT|BLOCK|ENDBLK|SEQEND|ATTRIB|VERTEX)/.test(items.get(h)?.o.name ?? 'VIEWPORT')) paper++;

  const read = readDxf(new TextEncoder().encode(out.join('\r\n') + '\r\n'));
  // CAD Draft's own curves come back exactly as drawn: not "may differ slightly".
  if (ours && !foreignFit) read.report = read.report.filter(l => !l.startsWith('Curves saved with only their fit points'));
  read.changed -= Math.min(ours, read.changed);
  const notes: string[] = [];
  if (paper) notes.push(`${paper} item${paper === 1 ? ' is' : 's are'} on paper layouts (sheets) and ${paper === 1 ? 'was' : 'were'} left out: CAD Draft opens the drawing's model.`);
  if (xrefs) notes.push(`${xrefs} insert${xrefs === 1 ? '' : 's'} of other drawings (external references) left out.`);
  if (badCrc) notes.push(`${badCrc} damaged object${badCrc === 1 ? '' : 's'} (${badCrc === 1 ? 'its' : 'their'} check sum is wrong) left out.`);
  if (damaged) notes.push(`${damaged} object${damaged === 1 ? '' : 's'} CAD Draft could not decode left out.`);
  for (const c of parts.checks) notes.push(`The file's own check: ${c}.`);
  const lost = paper + xrefs + badCrc + damaged;
  read.report = [`Read from an ${label}.`, ...read.report.filter(l => l !== 'Nothing in the file could be drawn.'), ...notes, ...extra];
  if (!read.drawing.ents.length) read.report.push('Nothing in the file could be drawn.');
  return { ...read, leftOut: read.leftOut + lost, version: label };
}

function pt3(tag: (c: number, v: number) => void, code: number, p: P3) {
  tag(code, p[0]);
  tag(code + 10, p[1]);
  tag(code + 20, p[2]);
}

/** A spline CAD Draft wrote (Bezier spans through points, as it draws curves): its points, else null. */
function oursFit(s: Extract<DwgShape, { k: 'SPLINE' }>): { pts: Pt[]; closed: boolean } | null {
  const m = (s.ctrl.length - 1) / 3;
  if (s.degree !== 3 || s.rational || s.fit.length || !Number.isInteger(m) || m < 1 || s.knots.length !== s.ctrl.length + 4) return null;
  for (let i = 0; i < 4; i++) if (s.knots[i] !== 0 || s.knots[s.knots.length - 1 - i] !== m) return null;
  for (let i = 1; i < m; i++) for (let k = 0; k < 3; k++) if (s.knots[4 + (i - 1) * 3 + k] !== i) return null;
  const pts = Array.from({ length: m + 1 }, (_, i) => P(s.ctrl[i * 3][0], s.ctrl[i * 3][1]));
  const size = Math.max(1, ...pts.map(p => Math.max(Math.abs(p.x), Math.abs(p.y))));
  const closed = m > 2 && dist(pts[0], pts[m]) <= 1e-9 * size;
  const fit = closed ? pts.slice(0, -1) : pts;
  const bez = curveThrough(fit, closed);
  if (bez.length !== m) return null;
  for (let i = 0; i < m; i++) {
    for (let k = 1; k < 3; k++) {
      const c = s.ctrl[i * 3 + k];
      if (dist(bez[i].p[k], P(c[0], c[1])) > 1e-9 * size) return null;
    }
  }
  return { pts: fit, closed };
}
