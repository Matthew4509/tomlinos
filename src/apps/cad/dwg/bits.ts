// The bit-level pieces of a DWG file: a reader and a writer for its packed bit codes (bit shorts, bit doubles,
// handles, modular numbers, texts), and its check sums (the 16-bit CRC every object and section carries, the 32-bit
// CRC of the 2004 file header, and the checksum of a 2004 page).
import { CadProblem } from '../model.ts';

/** A DWG that cannot be read: the message says why, for the person opening it. */
export class DwgProblem extends CadProblem {}

/** A DWG version, by the number in its AC10xx name. */
export const V = { R2000: 15, R2004: 18, R2007: 21, R2010: 24, R2013: 27, R2018: 32 } as const;
export type V = number;

export interface Handle {
  code: number;
  value: number;
}

// ---- Check sums ----------------------------------------------------------------------------------------------------

const CRC16 = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xa001 : c >>> 1;
    t[i] = c;
  }
  return t;
})();

/** The 16-bit CRC DWG puts after objects and sections (seed 0xC0C1 for most). */
export function crc16(data: Uint8Array, seed: number, start = 0, end = data.length): number {
  let crc = seed & 0xffff;
  for (let i = start; i < end; i++) crc = (crc >>> 8) ^ CRC16[(crc ^ data[i]) & 0xff];
  return crc;
}

const CRC32 = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array, seed = 0, start = 0, end = data.length): number {
  let crc = ~seed >>> 0;
  for (let i = start; i < end; i++) crc = (crc >>> 8) ^ CRC32[(crc ^ data[i]) & 0xff];
  return ~crc >>> 0;
}

/** The checksum of a 2004-format page (an Adler-style sum). */
export function pageChecksum(seed: number, data: Uint8Array, start = 0, length = data.length - start): number {
  let sum1 = seed & 0xffff;
  let sum2 = (seed >>> 16) & 0xffff;
  let i = start;
  while (length > 0) {
    const chunk = Math.min(0x15b0, length);
    length -= chunk;
    for (let k = 0; k < chunk; k++) {
      sum1 += data[i++];
      sum2 += sum1;
    }
    sum1 %= 0xfff1;
    sum2 %= 0xfff1;
  }
  return ((sum2 << 16) | (sum1 & 0xffff)) >>> 0;
}

/** The pseudo-random bytes the 2004 format masks its file header with (and pads with). */
export function magicBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  let seed = 1;
  for (let i = 0; i < n; i++) {
    seed = (Math.imul(seed, 0x343fd) + 0x269ec3) >>> 0;
    out[i] = (seed >>> 16) & 0xff;
  }
  return out;
}

// ---- Code pages ----------------------------------------------------------------------------------------------------

/** The DWG code page numbers and the names a TextDecoder knows them by. */
const CODE_PAGES: Record<number, string> = {
  28: 'windows-1250', 29: 'windows-1251', 30: 'windows-1252', 31: 'windows-1253', 32: 'windows-1254', 33: 'windows-1255', 34: 'windows-1256',
  35: 'windows-1257', 36: 'windows-874', 37: 'shift_jis', 38: 'gbk', 39: 'euc-kr', 40: 'big5', 43: 'windows-1258', 44: 'utf-8',
};

export function decoderFor(codePage: number): TextDecoder {
  try {
    return new TextDecoder(CODE_PAGES[codePage] ?? 'windows-1252');
  } catch {
    return new TextDecoder('windows-1252');
  }
}

// ---- Reading -------------------------------------------------------------------------------------------------------

const f64 = new Float64Array(1);
const f64b = new Uint8Array(f64.buffer);

export class BitReader {
  pos: number;
  /** One past the last bit this reader may read. */
  end: number;
  readonly data: Uint8Array;
  readonly ver: V;
  text: TextDecoder;
  /** R2007+: where an object's texts are kept (a stream of their own at the end of its data). */
  strings: BitReader | null = null;
  constructor(data: Uint8Array, startBit = 0, endBit = data.length * 8, ver: V = V.R2004, text: TextDecoder = decoderFor(30)) {
    this.data = data;
    this.ver = ver;
    this.text = text;
    this.pos = startBit;
    this.end = Math.min(endBit, data.length * 8);
  }

  private need(bits: number): void {
    if (this.pos + bits > this.end || this.pos < 0) throw new DwgProblem('the file ends in the middle of an object (it is cut short or damaged)');
  }

  B(): number {
    this.need(1);
    const v = (this.data[this.pos >> 3] >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return v;
  }

  bits(n: number): number {
    this.need(n);
    let v = 0;
    for (let i = 0; i < n; i++) {
      v = (v << 1) | ((this.data[this.pos >> 3] >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return v >>> 0;
  }

  BB(): number {
    return this.bits(2);
  }

  /** Up to three bits, stopping at the first 0 (R2007+ only). */
  B3(): number {
    let v = 0;
    for (let i = 0; i < 3; i++) {
      const b = this.B();
      v = (v << 1) | b;
      if (!b) break;
    }
    return v;
  }

  RC(): number {
    this.need(8);
    const shift = this.pos & 7;
    const i = this.pos >> 3;
    this.pos += 8;
    if (!shift) return this.data[i];
    return ((this.data[i] << shift) | (this.data[i + 1] >> (8 - shift))) & 0xff;
  }

  bytes(n: number): Uint8Array {
    this.need(n * 8);
    if (!(this.pos & 7)) {
      const out = this.data.slice(this.pos >> 3, (this.pos >> 3) + n);
      this.pos += n * 8;
      return out;
    }
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = this.RC();
    return out;
  }

  RS(): number {
    const a = this.RC();
    return a | (this.RC() << 8);
  }

  RSs(): number {
    const v = this.RS();
    return v & 0x8000 ? v - 0x10000 : v;
  }

  RL(): number {
    const a = this.RS();
    return (a | (this.RS() << 16)) >>> 0;
  }

  RLs(): number {
    return this.RL() | 0;
  }

  RD(): number {
    for (let i = 0; i < 8; i++) f64b[i] = this.RC();
    return f64[0];
  }

  BS(): number {
    switch (this.BB()) {
      case 0:
        return this.RSs();
      case 1:
        return this.RC();
      case 2:
        return 0;
      default:
        return 256;
    }
  }

  BL(): number {
    switch (this.BB()) {
      case 0:
        return this.RLs();
      case 1:
        return this.RC();
      case 2:
        return 0;
      default:
        throw new DwgProblem('a number in it is written in a way DWG does not use (damaged)');
    }
  }

  BLu(): number {
    return this.BL() >>> 0;
  }

  BLL(): number {
    const n = this.bits(3);
    let v = 0;
    for (let i = 0; i < n; i++) v += this.RC() * 2 ** (8 * i);
    return v;
  }

  BD(): number {
    switch (this.BB()) {
      case 0:
        return this.RD();
      case 1:
        return 1;
      case 2:
        return 0;
      default:
        throw new DwgProblem('a number in it is written in a way DWG does not use (damaged)');
    }
  }

  /** A bit double that may only change some bytes of a default. */
  DD(dflt: number): number {
    switch (this.BB()) {
      case 0:
        return dflt;
      case 1: {
        f64[0] = dflt;
        for (let i = 0; i < 4; i++) f64b[i] = this.RC();
        return f64[0];
      }
      case 2: {
        f64[0] = dflt;
        f64b[4] = this.RC();
        f64b[5] = this.RC();
        for (let i = 0; i < 4; i++) f64b[i] = this.RC();
        return f64[0];
      }
      default:
        return this.RD();
    }
  }

  RD2(): [number, number] {
    return [this.RD(), this.RD()];
  }

  BD2(): [number, number] {
    return [this.BD(), this.BD()];
  }

  BD3(): [number, number, number] {
    return [this.BD(), this.BD(), this.BD()];
  }

  /** Thickness: R2000+ one bit for none. */
  BT(): number {
    return this.ver >= V.R2000 && this.B() ? 0 : this.BD();
  }

  /** Extrusion: R2000+ one bit for straight up. */
  BE(): [number, number, number] {
    if (this.ver >= V.R2000 && this.B()) return [0, 0, 1];
    return this.BD3();
  }

  /** A modular char (byte aligned or not): 7 bits a byte; the last byte's 0x40 is the sign when `signed`. */
  MC(signed: boolean): number {
    let v = 0;
    let shift = 0;
    for (let i = 0; i < 9; i++) {
      const b = this.RC();
      if (b & 0x80) {
        v += (b & 0x7f) * 2 ** shift;
        shift += 7;
        continue;
      }
      if (signed) {
        v += (b & 0x3f) * 2 ** shift;
        return b & 0x40 ? -v : v;
      }
      return v + (b & 0x7f) * 2 ** shift;
    }
    throw new DwgProblem('a size in it is too long to be real (damaged)');
  }

  /** A modular short: 15 bits a word. */
  MS(): number {
    let v = 0;
    let shift = 0;
    for (let i = 0; i < 4; i++) {
      const w = this.RS();
      v += (w & 0x7fff) * 2 ** shift;
      if (!(w & 0x8000)) return v;
      shift += 15;
    }
    throw new DwgProblem('an object size in it is too long to be real (damaged)');
  }

  H(): Handle {
    const b = this.RC();
    const code = b >> 4;
    const n = b & 15;
    if (n > 8) throw new DwgProblem('a handle in it is too long (damaged)');
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + this.RC();
    return { code, value: v };
  }

  /** A handle made absolute against the object that holds it. */
  ref(own: number): number {
    const h = this.H();
    switch (h.code) {
      case 6:
        return own + 1;
      case 8:
        return own - 1;
      case 0xa:
        return own + h.value;
      case 0xc:
        return own - h.value;
      default:
        return h.value;
    }
  }

  /** Text: R2007+ as UTF-16 (from the string stream), earlier in the file's code page. */
  TV(): string {
    if (this.ver >= V.R2007) return (this.strings ?? this).TU();
    const n = this.BS();
    if (n < 0 || n * 8 > this.end - this.pos) throw new DwgProblem('a text in it is longer than the file (damaged)');
    return this.text.decode(this.bytes(n)).replace(/\0+$/, '');
  }

  TU(): string {
    const n = this.BS();
    if (n < 0 || n * 16 > this.end - this.pos) throw new DwgProblem('a text in it is longer than the file (damaged)');
    const units = new Uint16Array(n);
    for (let i = 0; i < n; i++) units[i] = this.RS();
    let s = '';
    for (let i = 0; i < n; i += 4096) s += String.fromCharCode(...units.subarray(i, i + 4096));
    return s.replace(/\0+$/, '');
  }

  /** A colour (R2004+: index, RGB, name flags); returns the colour index, or -1 for a true colour. */
  CMC(): number {
    const index = this.BS();
    if (this.ver < V.R2004) return index;
    const rgb = this.BLu();
    const flags = this.RC();
    if (flags & 1) this.TV();
    if (flags & 2) this.TV();
    const kind = rgb >>> 24;
    if (kind === 0xc3) return rgb & 0xff;
    if (kind === 0xc2) return -1;
    if (kind === 0xc0) return 256;
    if (kind === 0xc1) return 0;
    return index;
  }

  /** Object type: R2010+ packed in a 2-bit code. */
  OT(): number {
    if (this.ver < V.R2010) return this.BS();
    switch (this.BB()) {
      case 0:
        return this.RC();
      case 1:
        return this.RC() + 0x1f0;
      default:
        return this.RS();
    }
  }

  align(): void {
    this.pos = (this.pos + 7) & ~7;
  }
}

// ---- Writing -------------------------------------------------------------------------------------------------------

export class BitWriter {
  private buf = new Uint8Array(1024);
  pos = 0;
  readonly ver: V;
  constructor(ver: V = V.R2004) {
    this.ver = ver;
  }

  private grow(bits: number): void {
    const need = (this.pos + bits + 7) >> 3;
    if (need <= this.buf.length) return;
    let n = this.buf.length * 2;
    while (n < need) n *= 2;
    const b = new Uint8Array(n);
    b.set(this.buf);
    this.buf = b;
  }

  B(v: number | boolean): void {
    this.grow(1);
    if (v) this.buf[this.pos >> 3] |= 0x80 >> (this.pos & 7);
    this.pos++;
  }

  bits(v: number, n: number): void {
    for (let i = n - 1; i >= 0; i--) this.B((v >>> i) & 1);
  }

  BB(v: number): void {
    this.bits(v, 2);
  }

  RC(v: number): void {
    this.grow(8);
    v &= 0xff;
    const shift = this.pos & 7;
    const i = this.pos >> 3;
    if (!shift) this.buf[i] = v;
    else {
      this.buf[i] |= v >> shift;
      this.buf[i + 1] |= (v << (8 - shift)) & 0xff;
    }
    this.pos += 8;
  }

  bytes(b: Uint8Array): void {
    for (const v of b) this.RC(v);
  }

  RS(v: number): void {
    this.RC(v & 0xff);
    this.RC((v >> 8) & 0xff);
  }

  RL(v: number): void {
    this.RS(v & 0xffff);
    this.RS((v >>> 16) & 0xffff);
  }

  RD(v: number): void {
    f64[0] = v;
    const b = f64b.slice();
    for (let i = 0; i < 8; i++) this.RC(b[i]);
  }

  BS(v: number): void {
    if (v === 0) this.BB(2);
    else if (v === 256) this.BB(3);
    else if (v > 0 && v < 256) {
      this.BB(1);
      this.RC(v);
    } else {
      this.BB(0);
      this.RS(v & 0xffff);
    }
  }

  BL(v: number): void {
    if (v === 0) this.BB(2);
    else if (v > 0 && v < 256) {
      this.BB(1);
      this.RC(v);
    } else {
      this.BB(0);
      this.RL(v >>> 0);
    }
  }

  BD(v: number): void {
    if (v === 0 && !Object.is(v, -0)) this.BB(2);
    else if (v === 1) this.BB(1);
    else {
      this.BB(0);
      this.RD(v);
    }
  }

  DD(v: number, dflt: number): void {
    if (v === dflt) this.BB(0);
    else {
      this.BB(3);
      this.RD(v);
    }
  }

  RD2(x: number, y: number): void {
    this.RD(x);
    this.RD(y);
  }

  BD2(x: number, y: number): void {
    this.BD(x);
    this.BD(y);
  }

  BD3(x: number, y: number, z: number): void {
    this.BD(x);
    this.BD(y);
    this.BD(z);
  }

  BT(v: number): void {
    if (v === 0) this.B(1);
    else {
      this.B(0);
      this.BD(v);
    }
  }

  /** Extrusion straight up (all CAD Draft writes). */
  BEup(): void {
    this.B(1);
  }

  MCu(v: number): void {
    do {
      let b = v % 128;
      v = Math.floor(v / 128);
      if (v) b |= 0x80;
      this.RC(b);
    } while (v);
  }

  MCs(v: number): void {
    const neg = v < 0;
    v = Math.abs(v);
    const groups: number[] = [];
    while (v >= 64) {
      groups.push(v % 128);
      v = Math.floor(v / 128);
    }
    groups.push(v | (neg ? 0x40 : 0));
    groups.forEach((g, i) => this.RC(i < groups.length - 1 ? g | 0x80 : g));
  }

  MS(v: number): void {
    do {
      let w = v % 0x8000;
      v = Math.floor(v / 0x8000);
      if (v) w |= 0x8000;
      this.RS(w);
    } while (v);
  }

  H(code: number, value: number): void {
    const bytes: number[] = [];
    while (value > 0) {
      bytes.unshift(value % 256);
      value = Math.floor(value / 256);
    }
    this.RC((code << 4) | bytes.length);
    for (const b of bytes) this.RC(b);
  }

  /** Text in the file's code page (R2004 and before): BS length, then the bytes. */
  TV(bytes: Uint8Array): void {
    this.BS(bytes.length);
    this.bytes(bytes);
  }

  /** A colour by index (R2004+ form): 256 is by layer, 0 by block. */
  CMC(index: number): void {
    this.BS(0);
    this.BB(0);
    this.RL((index === 256 ? 0xc0000000 : index === 0 ? 0xc1000000 : 0xc3000000 | index) >>> 0);
    this.RC(0);
  }

  align(): void {
    this.pos = (this.pos + 7) & ~7;
    this.grow(0);
  }

  /** The bytes so far (the last byte padded with 0 bits). */
  done(): Uint8Array {
    return this.buf.slice(0, (this.pos + 7) >> 3);
  }

  /** Copies another writer's bits on the end of this one. */
  append(other: BitWriter): void {
    const b = other.done();
    const full = other.pos >> 3;
    for (let i = 0; i < full; i++) this.RC(b[i]);
    for (let i = full * 8; i < other.pos; i++) this.B((b[i >> 3] >> (7 - (i & 7))) & 1);
  }
}

/** Text as DWG 2004 holds it: Windows' Western letters, anything else as \U+XXXX (which AutoCAD reads back). */
export function cp1252Bytes(s: string): Uint8Array {
  const extra: Record<string, number> = {
    '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e,
    '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f,
  };
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80 || (c >= 0xa0 && c <= 0xff)) out.push(c);
    else if (extra[ch] !== undefined) out.push(extra[ch]);
    else {
      // Letters beyond the basic plane are written as their two UTF-16 halves.
      for (let i = 0; i < ch.length; i++) for (const k of `\\U+${ch.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')}`) out.push(k.charCodeAt(0));
    }
  }
  return new Uint8Array(out);
}
