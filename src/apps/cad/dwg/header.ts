// The header variables of a DWG (the drawing's settings: units, limits, the current layer, the tables' handles), as
// one list in the order the format keeps them, with the versions each is in. The same list reads them from any
// version and writes them for AutoCAD 2004, so the two cannot drift apart.
import { BitReader, BitWriter, DwgProblem, V, crc16, cp1252Bytes } from './bits.ts';

type Kind = 'B' | 'BS' | 'BL' | 'BLL' | 'BD' | 'RD2' | 'BD3' | 'TV' | 'H' | 'HSEED' | 'CMC' | 'RC';

/** [kind, name, first version it is in, last version it is in]. */
type Entry = [Kind, string, number?, number?];

const all = (kind: Kind, ...names: string[]): Entry[] => names.map(n => [kind, n]);
const from = (v: number, kind: Kind, ...names: string[]): Entry[] => names.map(n => [kind, n, v]);
const upTo = (v: number, kind: Kind, ...names: string[]): Entry[] => names.map(n => [kind, n, 0, v]);
const space = (p: string): Entry[] => [
  ...all('BD3', `${p}INSBASE`, `${p}EXTMIN`, `${p}EXTMAX`), ...all('RD2', `${p}LIMMIN`, `${p}LIMMAX`), ['BD', `${p}ELEVATION`],
  ...all('BD3', `${p}UCSORG`, `${p}UCSXDIR`, `${p}UCSYDIR`), ...all('H', `${p}UCSNAME`, `${p}UCSORTHOREF`), ['BS', `${p}UCSORTHOVIEW`], ['H', `${p}UCSBASE`],
  ...all('BD3', `${p}UCSORGTOP`, `${p}UCSORGBOTTOM`, `${p}UCSORGLEFT`, `${p}UCSORGRIGHT`, `${p}UCSORGFRONT`, `${p}UCSORGBACK`),
];

export const HEADER_VARS: Entry[] = [
  ...from(V.R2013, 'BLL', 'REQUIREDVERSIONS'),
  ...all('BD', 'UNKNOWN1', 'UNKNOWN2', 'UNKNOWN3', 'UNKNOWN4'), ...all('TV', 'UNKNOWN5', 'UNKNOWN6', 'UNKNOWN7', 'UNKNOWN8'), ...all('BL', 'UNKNOWN9', 'UNKNOWN10'),
  ...upTo(V.R2000, 'H', 'VIEWPORT_ENTITY_HEADER'),
  ...all('B', 'DIMASO', 'DIMSHO', 'PLINEGEN', 'ORTHOMODE', 'REGENMODE', 'FILLMODE', 'QTEXTMODE', 'PSLTSCALE', 'LIMCHECK'),
  ...from(V.R2004, 'B', 'UNDOCUMENTED'),
  ...all('B', 'USRTIMER', 'SKPOLY', 'ANGDIR', 'SPLFRAME', 'MIRRTEXT', 'WORLDVIEW', 'TILEMODE', 'PLIMCHECK', 'VISRETAIN', 'DISPSILH', 'PELLIPSE'),
  ...all('BS', 'PROXYGRAPHICS', 'TREEDEPTH', 'LUNITS', 'LUPREC', 'AUNITS', 'AUPREC', 'ATTMODE', 'PDMODE'),
  ...from(V.R2004, 'BL', 'UNKNOWN11', 'UNKNOWN12', 'UNKNOWN13'),
  ...all('BS', 'USERI1', 'USERI2', 'USERI3', 'USERI4', 'USERI5', 'SPLINESEGS', 'SURFU', 'SURFV', 'SURFTYPE', 'SURFTAB1', 'SURFTAB2', 'SPLINETYPE', 'SHADEDGE', 'SHADEDIF', 'UNITMODE', 'MAXACTVP', 'ISOLINES', 'CMLJUST', 'TEXTQLTY'),
  ...all('BD', 'LTSCALE', 'TEXTSIZE', 'TRACEWID', 'SKETCHINC', 'FILLETRAD', 'THICKNESS', 'ANGBASE', 'PDSIZE', 'PLINEWID', 'USERR1', 'USERR2', 'USERR3', 'USERR4', 'USERR5',
    'CHAMFERA', 'CHAMFERB', 'CHAMFERC', 'CHAMFERD', 'FACETRES', 'CMLSCALE', 'CELTSCALE'),
  ['TV', 'MENUNAME'],
  ...all('BL', 'TDCREATE_DAY', 'TDCREATE_MS', 'TDUPDATE_DAY', 'TDUPDATE_MS'),
  ...from(V.R2004, 'BL', 'UNKNOWN14', 'UNKNOWN15', 'UNKNOWN16'),
  ...all('BL', 'TDINDWG_DAY', 'TDINDWG_MS', 'TDUSRTIMER_DAY', 'TDUSRTIMER_MS'),
  ['CMC', 'CECOLOR'], ['HSEED', 'HANDSEED'], ...all('H', 'CLAYER', 'TEXTSTYLE', 'CELTYPE'), ...from(V.R2007, 'H', 'CMATERIAL'), ...all('H', 'DIMSTYLE', 'CMLSTYLE'),
  ['BD', 'PSVPSCALE'], ...space('P'), ...space(''),
  ...all('TV', 'DIMPOST', 'DIMAPOST'),
  ...all('BD', 'DIMSCALE', 'DIMASZ', 'DIMEXO', 'DIMDLI', 'DIMEXE', 'DIMRND', 'DIMDLE', 'DIMTP', 'DIMTM'),
  ...from(V.R2007, 'BD', 'DIMFXL', 'DIMJOGANG'), ...from(V.R2007, 'BS', 'DIMTFILL'), ...from(V.R2007, 'CMC', 'DIMTFILLCLR'),
  ...all('B', 'DIMTOL', 'DIMLIM', 'DIMTIH', 'DIMTOH', 'DIMSE1', 'DIMSE2'), ...all('BS', 'DIMTAD', 'DIMZIN', 'DIMAZIN'),
  ...from(V.R2007, 'BS', 'DIMARCSYM'),
  ...all('BD', 'DIMTXT', 'DIMCEN', 'DIMTSZ', 'DIMALTF', 'DIMLFAC', 'DIMTVP', 'DIMTFAC', 'DIMGAP', 'DIMALTRND'),
  ['B', 'DIMALT'], ['BS', 'DIMALTD'], ...all('B', 'DIMTOFL', 'DIMSAH', 'DIMTIX', 'DIMSOXD'),
  ...all('CMC', 'DIMCLRD', 'DIMCLRE', 'DIMCLRT'),
  ...all('BS', 'DIMADEC', 'DIMDEC', 'DIMTDEC', 'DIMALTU', 'DIMALTTD', 'DIMAUNIT', 'DIMFRAC', 'DIMLUNIT', 'DIMDSEP', 'DIMTMOVE', 'DIMJUST'),
  ...all('B', 'DIMSD1', 'DIMSD2'), ...all('BS', 'DIMTOLJ', 'DIMTZIN', 'DIMALTZ', 'DIMALTTZ'), ['B', 'DIMUPT'], ['BS', 'DIMATFIT'],
  ...from(V.R2007, 'B', 'DIMFXLON'),
  ...from(V.R2010, 'B', 'DIMTXTDIRECTION'), ...from(V.R2010, 'BD', 'DIMALTMZF'), ...from(V.R2010, 'TV', 'DIMALTMZS'), ...from(V.R2010, 'BD', 'DIMMZF'), ...from(V.R2010, 'TV', 'DIMMZS'),
  ...all('H', 'DIMTXSTY', 'DIMLDRBLK', 'DIMBLK', 'DIMBLK1', 'DIMBLK2'), ...from(V.R2007, 'H', 'DIMLTYPE', 'DIMLTEX1', 'DIMLTEX2'),
  ...all('BS', 'DIMLWD', 'DIMLWE'),
  ...all('H', 'BLOCK_CONTROL', 'LAYER_CONTROL', 'STYLE_CONTROL', 'LTYPE_CONTROL', 'VIEW_CONTROL', 'UCS_CONTROL', 'VPORT_CONTROL', 'APPID_CONTROL', 'DIMSTYLE_CONTROL'),
  ...upTo(V.R2000, 'H', 'VIEWPORT_ENTITY_HEADER_CONTROL'),
  ...all('H', 'DICTIONARY_ACAD_GROUP', 'DICTIONARY_ACAD_MLINESTYLE', 'DICTIONARY_NAMED_OBJECTS'),
  ...all('BS', 'TSTACKALIGN', 'TSTACKSIZE'), ...all('TV', 'HYPERLINKBASE', 'STYLESHEET'),
  ...all('H', 'DICTIONARY_LAYOUTS', 'DICTIONARY_PLOTSETTINGS', 'DICTIONARY_PLOTSTYLES'), ...from(V.R2004, 'H', 'DICTIONARY_MATERIALS', 'DICTIONARY_COLORS'),
  ...from(V.R2007, 'H', 'DICTIONARY_VISUALSTYLE'), ...from(V.R2013, 'H', 'UNKNOWN_HANDLE'),
  ['BL', 'FLAGS'], ['BS', 'INSUNITS'], ['BS', 'CEPSNTYPE'], ['H', 'CPSNID'], ...all('TV', 'FINGERPRINTGUID', 'VERSIONGUID'),
  ...from(V.R2004, 'RC', 'SORTENTS', 'INDEXCTL', 'HIDETEXT', 'XCLIPFRAME', 'DIMASSOC', 'HALOGAP'), ...from(V.R2004, 'BS', 'OBSCUREDCOLOR', 'INTERSECTIONCOLOR'),
  ...from(V.R2004, 'RC', 'OBSCUREDLTYPE', 'INTERSECTIONDISPLAY'), ...from(V.R2004, 'TV', 'PROJECTNAME'),
  ...all('H', 'BLOCK_RECORD_PAPER_SPACE', 'BLOCK_RECORD_MODEL_SPACE', 'LTYPE_BYLAYER', 'LTYPE_BYBLOCK', 'LTYPE_CONTINUOUS'),
  ...from(V.R2007, 'B', 'CAMERADISPLAY'), ...from(V.R2007, 'BL', 'UNKNOWN21', 'UNKNOWN22'), ...from(V.R2007, 'BD', 'UNKNOWN23', 'STEPSPERSEC', 'STEPSIZE', '3DDWFPREC', 'LENSLENGTH', 'CAMERAHEIGHT'),
  ...from(V.R2007, 'RC', 'SOLIDHIST', 'SHOWHIST'), ...from(V.R2007, 'BD', 'PSOLWIDTH', 'PSOLHEIGHT', 'LOFTANG1', 'LOFTANG2', 'LOFTMAG1', 'LOFTMAG2'), ...from(V.R2007, 'BS', 'LOFTPARAM'),
  ...from(V.R2007, 'RC', 'LOFTNORMALS'), ...from(V.R2007, 'BD', 'LATITUDE', 'LONGITUDE', 'NORTHDIRECTION'), ...from(V.R2007, 'BL', 'TIMEZONE'),
  ...from(V.R2007, 'RC', 'LIGHTGLYPHDISPLAY', 'TILEMODELIGHTSYNCH', 'DWFFRAME', 'DGNFRAME'), ...from(V.R2007, 'B', 'UNKNOWN24'), ...from(V.R2007, 'CMC', 'INTERFERECOLOR'),
  ...from(V.R2007, 'H', 'INTERFEREOBJVS', 'INTERFEREVPVS', 'DRAGVS'), ...from(V.R2007, 'RC', 'CSHADOW'), ...from(V.R2007, 'BD', 'UNKNOWN25'),
  ...all('BS', 'UNKNOWN26', 'UNKNOWN27', 'UNKNOWN28', 'UNKNOWN29'),
];

export const HEADER_START = [0xcf, 0x7b, 0x1f, 0x23, 0xfd, 0xde, 0x38, 0xa9, 0x5f, 0x7c, 0x68, 0xb8, 0x4e, 0x6d, 0x33, 0x5f];
export const HEADER_END = [0x30, 0x84, 0xe0, 0xdc, 0x02, 0x21, 0xc7, 0x56, 0xa0, 0x83, 0x97, 0x47, 0xb1, 0x92, 0xcc, 0xa0];

export type HeaderValue = number | string | number[];

const has = (e: Entry, ver: number) => ver >= (e[2] ?? 0) && ver <= (e[3] ?? 99);

/** Sets up the string stream of an R2007+ part that ends (before its handles) at `endBit`. */
export function stringStream(main: BitReader, endBit: number): BitReader {
  const empty = new BitReader(new Uint8Array(0), 0, 0, main.ver, main.text);
  if (main.ver < V.R2007) return main;
  const r = new BitReader(main.data, endBit - 1, endBit, main.ver, main.text);
  if (!r.B()) return empty;
  let p = endBit - 1 - 16;
  r.pos = p;
  r.end = p + 16;
  let size = r.RS();
  if (size & 0x8000) {
    p -= 16;
    r.pos = p;
    r.end = p + 16;
    size = (size & 0x7fff) | (r.RS() << 15);
  }
  if (size > p) throw new DwgProblem('the text of an object in it runs outside the object (damaged)');
  return new BitReader(main.data, p - size, p, main.ver, main.text);
}

/** Reads the header variables (the named ones a drawing needs; the rest are passed over). */
export function readHeader(data: Uint8Array, ver: V, maint: number, text: TextDecoder): Map<string, HeaderValue> {
  for (let i = 0; i < 16; i++) if (data[i] !== HEADER_START[i]) throw new DwgProblem('its header is damaged (it does not start the way it should)');
  const r = new BitReader(data, 128, data.length * 8, ver, text);
  const size = r.RL();
  if (ver >= V.R2018 || (ver >= V.R2010 && maint > 3)) r.RL();
  const start = r.pos;
  if (size * 8 + start > data.length * 8) throw new DwgProblem('its header says it is longer than it is (damaged)');
  r.end = start + size * 8;
  let handles = r;
  if (ver >= V.R2007) {
    const bits = r.RL();
    const end = start + bits;
    if (end > r.end + 32) throw new DwgProblem('its header is damaged');
    r.strings = stringStream(r, end);
    handles = new BitReader(data, end, start + size * 8 + 32, ver, text);
  }
  const out = new Map<string, HeaderValue>();
  for (const e of HEADER_VARS) {
    if (!has(e, ver)) continue;
    const [kind, name] = e;
    if (name === 'CPSNID' && out.get('CEPSNTYPE') !== 3) continue;
    switch (kind) {
      case 'B':
        out.set(name, r.B());
        break;
      case 'BS':
        out.set(name, r.BS());
        break;
      case 'BL':
        out.set(name, r.BL());
        break;
      case 'BLL':
        out.set(name, r.BLL());
        break;
      case 'BD':
        out.set(name, r.BD());
        break;
      case 'RC':
        out.set(name, r.RC());
        break;
      case 'RD2':
        out.set(name, r.RD2());
        break;
      case 'BD3':
        out.set(name, r.BD3());
        break;
      case 'TV':
        out.set(name, r.TV());
        break;
      case 'CMC':
        out.set(name, r.CMC());
        break;
      case 'HSEED':
        out.set(name, r.H().value);
        break;
      case 'H':
        out.set(name, handles.H().value);
        break;
    }
  }
  return out;
}

/** The header variables for an AutoCAD 2004 file: `values` over the usual defaults. */
export function writeHeader(values: Map<string, HeaderValue>): Uint8Array {
  const w = new BitWriter(V.R2004);
  const owners = /_CONTROL$|^DICTIONARY_NAMED_OBJECTS$/;
  for (const e of HEADER_VARS) {
    if (!has(e, V.R2004)) continue;
    const [kind, name] = e;
    const v = values.get(name) ?? DEFAULTS[name] ?? (kind === 'TV' ? '' : kind === 'BD3' ? [0, 0, 0] : kind === 'RD2' ? [0, 0] : 0);
    if (name === 'CPSNID' && values.get('CEPSNTYPE') !== 3) continue;
    switch (kind) {
      case 'B':
        w.B(v as number);
        break;
      case 'BS':
        w.BS(v as number);
        break;
      case 'BL':
        w.BL(v as number);
        break;
      case 'BLL':
        w.bits(0, 3);
        break;
      case 'BD':
        w.BD(v as number);
        break;
      case 'RC':
        w.RC(v as number);
        break;
      case 'RD2':
        w.RD2(...(v as [number, number]));
        break;
      case 'BD3':
        w.BD3(...(v as [number, number, number]));
        break;
      case 'TV':
        w.TV(cp1252Bytes(v as string));
        break;
      case 'CMC':
        w.CMC(v as number);
        break;
      case 'HSEED':
        w.H(0, v as number);
        break;
      case 'H':
        w.H(v ? (owners.test(name) ? 3 : 5) : 5, v as number);
        break;
    }
  }
  const body = w.done();
  const out = new Uint8Array(16 + 4 + body.length + 2 + 16);
  out.set(HEADER_START, 0);
  new DataView(out.buffer).setUint32(16, body.length, true);
  out.set(body, 20);
  new DataView(out.buffer).setUint16(20 + body.length, crc16(out, 0xc0c1, 16, 20 + body.length), true);
  out.set(HEADER_END, 22 + body.length);
  return out;
}

/** The values AutoCAD gives a new metric drawing (the ones not 0). */
const DEFAULTS: Record<string, HeaderValue> = {
  UNKNOWN1: 412148564080.0, UNKNOWN2: 1, UNKNOWN3: 1, UNKNOWN4: 1, UNKNOWN9: 24,
  REGENMODE: 1, FILLMODE: 1, PSLTSCALE: 1, USRTIMER: 1, WORLDVIEW: 1, TILEMODE: 1, VISRETAIN: 1,
  PROXYGRAPHICS: 1, TREEDEPTH: 3020, LUNITS: 2, LUPREC: 4, AUPREC: 0, ATTMODE: 1,
  SPLINESEGS: 8, SURFU: 6, SURFV: 6, SURFTYPE: 6, SURFTAB1: 6, SURFTAB2: 6, SPLINETYPE: 6, SHADEDGE: 3, SHADEDIF: 70, MAXACTVP: 64, ISOLINES: 4, TEXTQLTY: 50,
  LTSCALE: 1, TEXTSIZE: 2.5, TRACEWID: 1, SKETCHINC: 1, FACETRES: 0.5, CMLSCALE: 20, CELTSCALE: 1, MENUNAME: 'acad',
  CECOLOR: 256, UCSXDIR: [1, 0, 0], UCSYDIR: [0, 1, 0], PUCSXDIR: [1, 0, 0], PUCSYDIR: [0, 1, 0], LIMMAX: [420, 297], PLIMMAX: [420, 297],
  EXTMIN: [1e20, 1e20, 1e20], EXTMAX: [-1e20, -1e20, -1e20], PEXTMIN: [1e20, 1e20, 1e20], PEXTMAX: [-1e20, -1e20, -1e20],
  DIMSCALE: 1, DIMASZ: 2.5, DIMEXO: 0.625, DIMDLI: 3.75, DIMEXE: 1.25, DIMTXT: 2.5, DIMCEN: 2.5, DIMALTF: 25.4, DIMLFAC: 1, DIMTFAC: 1, DIMGAP: 0.625,
  DIMTAD: 1, DIMZIN: 8, DIMTOFL: 1, DIMALTD: 2, DIMCLRD: 0, DIMCLRE: 0, DIMCLRT: 0, DIMADEC: 0, DIMDEC: 2, DIMTDEC: 2, DIMALTU: 2, DIMALTTD: 2, DIMFRAC: 0, DIMLUNIT: 2,
  DIMDSEP: 44, DIMTZIN: 8, DIMATFIT: 3, DIMLWD: -2, DIMLWE: -2, DIMTOLJ: 1, DIMAUNIT: 0,
  TSTACKALIGN: 1, TSTACKSIZE: 70, INSUNITS: 4,
  // Line weight by layer (0x1F), lineweight shown off, XEDIT on: AutoCAD's own new drawing.
  FLAGS: 0x1f | 0x200,
  SORTENTS: 127, INDEXCTL: 0, HIDETEXT: 1, XCLIPFRAME: 0, DIMASSOC: 2, HALOGAP: 0, OBSCUREDCOLOR: 257, INTERSECTIONCOLOR: 257, OBSCUREDLTYPE: 0, INTERSECTIONDISPLAY: 0,
};
