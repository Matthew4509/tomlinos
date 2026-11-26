// How a DWG file holds its parts. AutoCAD 2000 (AC1015) lists where each part starts; 2004 and later (AC1018,
// AC1024, AC1027, AC1032) cut them into compressed pages found through a page map and a section map; 2007 (AC1021)
// does the same with error-correcting codes over its pages and its own compression. This finds the four parts a
// drawing is read from: the header variables, the classes, the object map and the objects.
import { BitReader, DwgProblem, V, crc32, magicBytes } from './bits.ts';
import { decompress18, decompress21 } from './lz77.ts';

/** The most a section may unpack to (a drawing CAD Draft can open is far smaller). */
export const MAX_SECTION_BYTES = 256 * 1024 * 1024;
/** The most pages a section may be cut into. */
const MAX_PAGES = 100_000;

export const VERSION_NAMES: Record<string, string> = {
  AC1012: 'AutoCAD R13', AC1014: 'AutoCAD R14', AC1015: 'AutoCAD 2000', AC1018: 'AutoCAD 2004', AC1021: 'AutoCAD 2007', AC1024: 'AutoCAD 2010',
  AC1027: 'AutoCAD 2013', AC1032: 'AutoCAD 2018',
};

export interface DwgParts {
  /** The version number from the AC10xx name: 15, 18, 21, 24, 27 or 32. */
  ver: V;
  name: string;
  maint: number;
  codePage: number;
  header: Uint8Array;
  classes: Uint8Array;
  handles: Uint8Array;
  /** Object map offsets count from the start of this (for 2000, the whole file). */
  objects: Uint8Array;
  /** What the file's own check sums said (false when one did not match). */
  checks: string[];
}

const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

/** The version of a DWG file from its first six letters, or a clear refusal. */
export function dwgVersion(bytes: Uint8Array): { ver: V; name: string } {
  const name = String.fromCharCode(...bytes.subarray(0, 6));
  if (!/^AC10\d\d$/.test(name)) throw new DwgProblem('This file is not a DWG drawing (it does not start the way a DWG does).');
  const known: Record<string, V> = { AC1015: V.R2000, AC1018: V.R2004, AC1021: V.R2007, AC1024: V.R2010, AC1027: V.R2013, AC1032: V.R2018 };
  const ver = known[name];
  const label = VERSION_NAMES[name] ?? `an unknown version (${name})`;
  if (!ver) {
    if (name < 'AC1015') throw new DwgProblem(`This DWG is in the ${label} format (${name}), older than CAD Draft reads (AutoCAD 2000 and later). Save it as a newer DWG, or as DXF, in the program that made it.`);
    throw new DwgProblem(`This DWG is in ${label.startsWith('an') ? label : `the ${label} format (${name})`}, which CAD Draft does not read (it reads AutoCAD 2000 to 2018 DWG). Save it as a 2018 or older DWG, or as DXF, in the program that made it.`);
  }
  return { ver, name };
}

export function readParts(bytes: Uint8Array): DwgParts {
  if (bytes.length < 0x100) throw new DwgProblem('This file is too short to be a DWG drawing.');
  const { ver, name } = dwgVersion(bytes);
  if (ver === V.R2000) return readR2000(bytes, name);
  if (ver === V.R2007) return readR2007(bytes, name);
  return readR2004(bytes, ver, name);
}

// ---- 2000 ----------------------------------------------------------------------------------------------------------

function readR2000(bytes: Uint8Array, name: string): DwgParts {
  const v = dv(bytes);
  const count = v.getUint32(0x15, true);
  if (count > 16) throw new DwgProblem(`it lists ${count} parts in its header; a real one lists 6 (damaged)`);
  const parts = new Map<number, { at: number; size: number }>();
  for (let i = 0; i < count; i++) {
    const p = 0x19 + i * 9;
    parts.set(bytes[p], { at: v.getUint32(p + 1, true), size: v.getUint32(p + 5, true) });
  }
  const part = (n: number, what: string) => {
    const p = parts.get(n);
    if (!p || p.at + p.size > bytes.length || p.at < 0x19) throw new DwgProblem(`its ${what} is missing or runs past the end of the file (cut short or damaged)`);
    return bytes.subarray(p.at, p.at + p.size);
  };
  return {
    ver: V.R2000, name, maint: bytes[0x0b], codePage: v.getUint16(0x13, true),
    header: part(0, 'header'), classes: part(1, 'class list'), handles: part(2, 'object map'), objects: bytes, checks: [],
  };
}

// ---- 2004, 2010, 2013, 2018 ----------------------------------------------------------------------------------------

interface SectionInfo {
  name: string;
  size: number;
  maxSize: number;
  compressed: number;
  encrypted: number;
  pages: Array<{ number: number; dataSize: number; start: number }>;
}

/** The file header of a 2004-format file, unmasked (0x6C bytes from 0x80). */
export function unmaskHeader18(bytes: Uint8Array): Uint8Array {
  const magic = magicBytes(0x6c);
  const out = new Uint8Array(0x6c);
  for (let i = 0; i < 0x6c; i++) out[i] = bytes[0x80 + i] ^ magic[i];
  return out;
}

function readR2004(bytes: Uint8Array, ver: V, name: string): DwgParts {
  const fv = dv(bytes);
  const head = unmaskHeader18(bytes);
  const hv = dv(head);
  const checks: string[] = [];
  if (String.fromCharCode(...head.subarray(0, 11)) !== 'AcFssFcAJMB') throw new DwgProblem('its file header is damaged (its signature is wrong)');
  const stored = hv.getUint32(0x68, true);
  const copy = head.slice();
  dv(copy).setUint32(0x68, 0, true);
  if (crc32(copy) !== stored) checks.push('the file header check sum does not match');
  const pageMapAddr = Number(hv.getBigUint64(0x54, true)) + 0x100;
  const sectionMapId = hv.getUint32(0x5c, true);

  // The page map: each page's number and size, laid end to end from 0x100.
  const pageMap = systemPage(bytes, pageMapAddr, 0x41630e3b, 'page map');
  const pm = dv(pageMap);
  const pages = new Map<number, { at: number; size: number }>();
  let at = 0x100;
  for (let p = 0; p + 8 <= pageMap.length; ) {
    const num = pm.getInt32(p, true);
    const size = pm.getUint32(p + 4, true);
    p += 8;
    if (num < 0) p += 16;
    else {
      if (pages.has(num)) throw new DwgProblem('its page map lists one page twice (damaged)');
      pages.set(num, { at, size });
    }
    if (pages.size > MAX_PAGES) throw new DwgProblem('its page map lists more pages than a real drawing has (damaged)');
    at += size;
    if (at > bytes.length + 0x100000) break;
  }
  const smPage = pages.get(sectionMapId);
  if (!smPage) throw new DwgProblem('its section map is missing (damaged)');

  // The section map: each section's name, sizes and pages.
  const sm = systemPage(bytes, smPage.at, 0x4163003b, 'section map');
  const sv = dv(sm);
  if (sm.length < 20) throw new DwgProblem('its section map is empty (damaged)');
  const count = sv.getUint32(0, true);
  if (count > 256) throw new DwgProblem('its section map lists more sections than a real drawing has (damaged)');
  const sections = new Map<string, SectionInfo>();
  let p = 20;
  for (let i = 0; i < count; i++) {
    if (p + 96 > sm.length) throw new DwgProblem('its section map is cut short (damaged)');
    const size = Number(sv.getBigUint64(p, true));
    const pageCount = sv.getUint32(p + 8, true);
    const maxSize = sv.getUint32(p + 12, true);
    const compressed = sv.getUint32(p + 20, true);
    const encrypted = sv.getUint32(p + 28, true);
    let secName = '';
    for (let k = 0; k < 64 && sm[p + 32 + k]; k++) secName += String.fromCharCode(sm[p + 32 + k]);
    p += 96;
    if (pageCount > MAX_PAGES || p + pageCount * 16 > sm.length) throw new DwgProblem('its section map lists more pages than it holds (damaged)');
    const list: SectionInfo['pages'] = [];
    for (let k = 0; k < pageCount; k++) {
      list.push({ number: sv.getUint32(p, true), dataSize: sv.getUint32(p + 4, true), start: Number(sv.getBigUint64(p + 8, true)) });
      p += 16;
    }
    sections.set(secName, { name: secName, size, maxSize, compressed, encrypted, pages: list });
  }
  const used = new Set<number>();
  const section = (secName: string, required: boolean): Uint8Array => {
    const s = sections.get(secName);
    if (!s) {
      if (required) throw new DwgProblem(`it has no ${secName.replace('AcDb:', '')} section (damaged, or not made by a CAD program)`);
      return new Uint8Array(0);
    }
    if (s.encrypted === 1) throw new DwgProblem('This DWG is protected with a password; CAD Draft cannot open it. Save an unprotected copy in the program that made it.');
    if (s.size > MAX_SECTION_BYTES) throw new DwgProblem(`its ${secName.replace('AcDb:', '')} section says it holds ${s.size.toLocaleString('en-GB')} bytes, more than CAD Draft opens (damaged, or far too big)`);
    if (s.maxSize > 0x100000) throw new DwgProblem(`its ${secName.replace('AcDb:', '')} section has pages bigger than a real drawing's (damaged)`);
    const out = new Uint8Array(s.size);
    for (const pg of s.pages) {
      if (used.has(pg.number)) throw new DwgProblem('it uses one page in two places (damaged: its section map loops)');
      used.add(pg.number);
      const loc = pages.get(pg.number);
      if (!loc || loc.at + 32 > bytes.length) throw new DwgProblem(`a page of its ${secName.replace('AcDb:', '')} section is missing (cut short or damaged)`);
      const mask = (0x4164536b ^ loc.at) >>> 0;
      const h = (k: number) => (fv.getUint32(loc.at + k * 4, true) ^ mask) >>> 0;
      if (h(0) !== 0x4163043b) throw new DwgProblem(`a page of its ${secName.replace('AcDb:', '')} section is damaged (its header is wrong)`);
      const dataSize = h(2);
      if (loc.at + 32 + dataSize > bytes.length) throw new DwgProblem('it is cut short (a page runs past the end of the file)');
      if (pg.start >= s.size) throw new DwgProblem(`a page of its ${secName.replace('AcDb:', '')} section lies outside its section (damaged)`);
      const room = Math.min(s.maxSize, s.size - pg.start);
      const raw = bytes.subarray(loc.at + 32, loc.at + 32 + dataSize);
      const data = s.compressed === 2 ? decompress18(raw, s.maxSize) : raw;
      out.set(data.subarray(0, room), pg.start);
    }
    return out;
  };
  return {
    ver, name, maint: bytes[0x0b], codePage: fv.getUint16(0x13, true),
    header: section('AcDb:Header', true), classes: section('AcDb:Classes', true), handles: section('AcDb:Handles', true), objects: section('AcDb:AcDbObjects', true), checks,
  };
}

function systemPage(bytes: Uint8Array, at: number, type: number, what: string): Uint8Array {
  if (at < 0x100 || at + 20 > bytes.length) throw new DwgProblem(`its ${what} is missing (the file is cut short or damaged)`);
  const v = dv(bytes);
  if (v.getUint32(at, true) !== type) throw new DwgProblem(`its ${what} is damaged (its page header is wrong)`);
  const size = v.getUint32(at + 4, true);
  const comp = v.getUint32(at + 8, true);
  const kind = v.getUint32(at + 12, true);
  if (size > 0x1000000 || at + 20 + comp > bytes.length) throw new DwgProblem(`its ${what} is bigger than the file (damaged)`);
  const raw = bytes.subarray(at + 20, at + 20 + comp);
  return kind === 2 ? decompress18(raw, size) : raw.slice(0, size);
}

// ---- 2007 ----------------------------------------------------------------------------------------------------------

/** Takes the data bytes out of interleaved Reed-Solomon blocks (no errors corrected: the data is used as it is). */
function deinterleave(src: Uint8Array, factor: number, blockSize: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let index = 0;
  for (let i = 0; i < factor && index < length; i++) {
    const size = Math.min(length - index, blockSize);
    let c = i;
    for (let k = 0; k < size; k++, c += factor) {
      if (c >= src.length) throw new DwgProblem('it is cut short (a page runs past the end of the file)');
      out[index++] = src[c];
    }
  }
  return out;
}

function readR2007(bytes: Uint8Array, name: string): DwgParts {
  const fv = dv(bytes);
  const u64 = (b: DataView, at: number) => {
    const n = b.getBigUint64(at, true);
    return n > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(n);
  };
  const enc = bytes.subarray(0x80, 0x80 + 0x400);
  const decoded = deinterleave(enc, 3, 239, 3 * 239);
  const dd = dv(decoded);
  const comprLen = dd.getInt32(24, true);
  let fh: Uint8Array;
  if (comprLen < 0) fh = decoded.slice(32, 32 + Math.min(-comprLen, 0x110));
  else if (comprLen > 3 * 239 - 32) throw new DwgProblem('its file header is damaged');
  else fh = decompress21(decoded.subarray(32, 32 + comprLen), 0x110);
  if (fh.length < 0x110) {
    const f = new Uint8Array(0x110);
    f.set(fh);
    fh = f;
  }
  const h = dv(fh);
  const F = (i: number) => u64(h, i * 8);
  const pagesMapCorrection = F(3);
  const pagesMapOffset = F(7);
  const pagesMapSizeComp = F(10);
  const pagesMapSizeUncomp = F(11);
  const sectionsMapSizeComp = F(22);
  const sectionsMapId = F(24);
  const sectionsMapSizeUncomp = F(25);
  const sectionsMapCorrection = F(27);
  const sysPage = (offset: number, comp: number, uncomp: number, correction: number) => {
    if (comp > 0x1000000 || uncomp > 0x1000000 || correction > 16 || correction < 1) throw new DwgProblem('its page map is damaged');
    const total = ((comp + 7) & ~7) * correction;
    const factor = Math.ceil(total / 239);
    const at = 0x480 + offset;
    if (at + factor * 255 > bytes.length) throw new DwgProblem('it is cut short (its page map runs past the end of the file)');
    const data = deinterleave(bytes.subarray(at, at + factor * 255), factor, 239, total);
    return decompress21(data.subarray(0, comp), uncomp);
  };
  const pm = sysPage(pagesMapOffset, pagesMapSizeComp, pagesMapSizeUncomp, pagesMapCorrection);
  const pmv = dv(pm);
  const pages = new Map<number, { at: number; size: number }>();
  let off = 0;
  for (let p = 0; p + 16 <= pm.length; p += 16) {
    const size = u64(pmv, p);
    const id = Math.abs(Number(pmv.getBigInt64(p + 8, true)));
    pages.set(id, { at: off, size });
    off += size;
    if (pages.size > MAX_PAGES) throw new DwgProblem('its page map lists more pages than a real drawing has (damaged)');
  }
  const smLoc = pages.get(sectionsMapId);
  if (!smLoc) throw new DwgProblem('its section map is missing (damaged)');
  const sm = sysPage(smLoc.at, sectionsMapSizeComp, sectionsMapSizeUncomp, sectionsMapCorrection);
  const smv = dv(sm);
  const sections = new Map<string, { size: number; maxSize: number; encoding: number; encrypted: number; pages: Array<{ offset: number; size: number; id: number; uncomp: number; comp: number }> }>();
  let p = 0;
  while (p + 64 <= sm.length) {
    const size = u64(smv, p);
    const maxSize = u64(smv, p + 8);
    const encrypted = u64(smv, p + 16);
    const nameLen = u64(smv, p + 32);
    const encoding = u64(smv, p + 48);
    const nPages = u64(smv, p + 56);
    p += 64;
    if (nameLen > 512 || nPages > MAX_PAGES || p + nameLen + nPages * 56 > sm.length) throw new DwgProblem('its section map is damaged');
    let secName = '';
    for (let k = 0; k + 1 < nameLen; k += 2) {
      const c = smv.getUint16(p + k, true);
      if (!c) break;
      secName += String.fromCharCode(c);
    }
    p += nameLen;
    const list = [];
    for (let k = 0; k < nPages; k++) {
      list.push({ offset: u64(smv, p), size: u64(smv, p + 8), id: u64(smv, p + 16), uncomp: u64(smv, p + 24), comp: u64(smv, p + 32) });
      p += 56;
    }
    sections.set(secName, { size, maxSize, encoding, encrypted, pages: list });
  }
  const used = new Set<number>();
  const section = (secName: string): Uint8Array => {
    const s = sections.get(secName);
    if (!s) throw new DwgProblem(`it has no ${secName.replace('AcDb:', '')} section (damaged)`);
    if (s.encrypted === 1) throw new DwgProblem('This DWG is protected with a password; CAD Draft cannot open it. Save an unprotected copy in the program that made it.');
    if (s.size > MAX_SECTION_BYTES) throw new DwgProblem(`its ${secName.replace('AcDb:', '')} section is bigger than CAD Draft opens (damaged, or far too big)`);
    const out = new Uint8Array(s.size);
    for (const pg of s.pages) {
      if (used.has(pg.id)) throw new DwgProblem('it uses one page in two places (damaged: its section map loops)');
      used.add(pg.id);
      const loc = pages.get(pg.id);
      if (!loc) throw new DwgProblem(`a page of its ${secName.replace('AcDb:', '')} section is missing (damaged)`);
      if (pg.uncomp > s.maxSize || pg.offset + pg.uncomp > out.length || pg.comp > pg.uncomp + 0x10000) throw new DwgProblem('a page of it is bigger than its section (damaged)');
      const at = 0x480 + loc.at;
      const stored = (pg.comp + 7) & ~7;
      const factor = Math.max(1, Math.ceil(stored / 251));
      if (at + Math.min(loc.size, factor * 255) > bytes.length) throw new DwgProblem('it is cut short (a page runs past the end of the file)');
      const raw = bytes.subarray(at, Math.min(bytes.length, at + factor * 255));
      const data = s.encoding === 4 ? deinterleave(raw, factor, 251, factor * 251) : raw;
      out.set(pg.comp !== pg.uncomp ? decompress21(data.subarray(0, pg.comp), pg.uncomp) : data.subarray(0, pg.uncomp), pg.offset);
    }
    return out;
  };
  return {
    ver: V.R2007, name, maint: bytes[0x0b], codePage: fv.getUint16(0x13, true),
    header: section('AcDb:Header'), classes: section('AcDb:Classes'), handles: section('AcDb:Handles'), objects: section('AcDb:AcDbObjects'), checks: [],
  };
}

/** A section's data after its 16-byte start marker and size (as header and class sections hold it). */
export function afterSentinel(data: Uint8Array, sentinel: number[], what: string, ver: V, maint: number): { body: BitReader; size: number; start: number } {
  for (let i = 0; i < 16; i++) if (data[i] !== sentinel[i]) throw new DwgProblem(`its ${what} is damaged (it does not start the way it should)`);
  const r = new BitReader(data, 16 * 8, data.length * 8, ver);
  const size = r.RL();
  if (ver >= V.R2010 && maint > 3) r.RL();
  if (size > data.length) throw new DwgProblem(`its ${what} says it is longer than it is (damaged)`);
  return { body: r, size, start: r.pos };
}
