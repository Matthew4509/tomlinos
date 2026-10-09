// Reading a PDF file: the objects in it (numbers, names, strings, lists, dictionaries, streams), the page list, and
// unpacking streams. Our own code. It finds objects by scanning the file rather than trusting the index at the end,
// which also copes with damaged files and with files saved in several passes (a later copy of an object wins).
// Not supported, and said so to the person: encrypted files.
export class Name {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
}
export class Ref {
  readonly num: number;
  readonly gen: number;
  constructor(num: number, gen: number) {
    this.num = num;
    this.gen = gen;
  }
}
export class Cmd {
  readonly cmd: string;
  constructor(cmd: string) {
    this.cmd = cmd;
  }
}
export class PStr {
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }
}
export class Dict {
  readonly map = new Map<string, Obj>();
}
export class Stream {
  readonly dict: Dict;
  readonly raw: Uint8Array;
  constructor(dict: Dict, raw: Uint8Array) {
    this.dict = dict;
    this.raw = raw;
  }
}
export type Obj = number | boolean | null | Name | Ref | Cmd | PStr | Obj[] | Dict | Stream;

export class PdfError extends Error {}

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
const MAX_DEPTH = 40;

export class Lexer {
  pos: number;
  readonly data: Uint8Array;
  constructor(data: Uint8Array, pos = 0) {
    this.data = data;
    this.pos = pos;
  }

  private skipSpace(): void {
    const d = this.data;
    while (this.pos < d.length) {
      const c = d[this.pos];
      if (WS.has(c)) this.pos++;
      else if (c === 0x25) {
        while (this.pos < d.length && d[this.pos] !== 10 && d[this.pos] !== 13) this.pos++;
      } else break;
    }
  }

  atEnd(): boolean {
    this.skipSpace();
    return this.pos >= this.data.length;
  }

  private word(): string {
    const d = this.data;
    const start = this.pos;
    while (this.pos < d.length && !WS.has(d[this.pos]) && !DELIM.has(d[this.pos])) this.pos++;
    let s = '';
    for (let i = start; i < this.pos; i++) s += String.fromCharCode(d[i]);
    return s;
  }

  /** Reads one object. `refs` allows "12 0 R". Keywords come back as Cmd. Returns undefined at the end of the data. */
  read(refs: boolean, depth = 0): Obj | undefined {
    if (depth > MAX_DEPTH) throw new PdfError('The file nests too deeply.');
    this.skipSpace();
    const d = this.data;
    if (this.pos >= d.length) return undefined;
    const c = d[this.pos];
    if (c === 0x2f) {
      this.pos++;
      const w = this.word();
      return new Name(w.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))));
    }
    if (c === 0x28) return this.literalString();
    if (c === 0x3c && d[this.pos + 1] === 0x3c) {
      this.pos += 2;
      const dict = new Dict();
      for (;;) {
        this.skipSpace();
        if (this.pos >= d.length) break;
        if (d[this.pos] === 0x3e && d[this.pos + 1] === 0x3e) {
          this.pos += 2;
          break;
        }
        const key = this.read(false, depth + 1);
        if (!(key instanceof Name)) {
          if (key === undefined) break;
          continue;
        }
        const value = this.read(refs, depth + 1);
        if (value === undefined) break;
        if (!(value instanceof Cmd)) dict.map.set(key.name, value);
      }
      return dict;
    }
    if (c === 0x3c) return this.hexString();
    if (c === 0x5b) {
      this.pos++;
      const list: Obj[] = [];
      for (;;) {
        this.skipSpace();
        if (this.pos >= d.length) break;
        if (d[this.pos] === 0x5d) {
          this.pos++;
          break;
        }
        const item = this.read(refs, depth + 1);
        if (item === undefined) break;
        list.push(item);
      }
      return list;
    }
    if (c === 0x29 || c === 0x3e || c === 0x5d || c === 0x7d || c === 0x7b) {
      this.pos++;
      return new Cmd(String.fromCharCode(c));
    }
    const w = this.word();
    if (w === '') {
      this.pos++;
      return new Cmd('');
    }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) {
      const n = parseFloat(w);
      if (refs && /^\d+$/.test(w)) {
        const save = this.pos;
        this.skipSpace();
        const g = this.word();
        if (/^\d+$/.test(g)) {
          this.skipSpace();
          if (d[this.pos] === 0x52 && (this.pos + 1 >= d.length || WS.has(d[this.pos + 1]) || DELIM.has(d[this.pos + 1]))) {
            this.pos++;
            return new Ref(n, parseInt(g, 10));
          }
        }
        this.pos = save;
      }
      return n;
    }
    if (w === 'true') return true;
    if (w === 'false') return false;
    if (w === 'null') return null;
    return new Cmd(w);
  }

  private literalString(): PStr {
    const d = this.data;
    this.pos++;
    const out: number[] = [];
    let depth = 1;
    while (this.pos < d.length) {
      const c = d[this.pos++];
      if (c === 0x5c) {
        const n = d[this.pos++];
        if (n === 0x6e) out.push(10);
        else if (n === 0x72) out.push(13);
        else if (n === 0x74) out.push(9);
        else if (n === 0x62) out.push(8);
        else if (n === 0x66) out.push(12);
        else if (n >= 0x30 && n <= 0x37) {
          let v = n - 0x30;
          for (let i = 0; i < 2 && d[this.pos] >= 0x30 && d[this.pos] <= 0x37; i++) v = v * 8 + d[this.pos++] - 0x30;
          out.push(v & 255);
        } else if (n === 13) {
          if (d[this.pos] === 10) this.pos++;
        } else if (n !== 10) out.push(n);
      } else if (c === 0x28) {
        depth++;
        out.push(c);
      } else if (c === 0x29) {
        if (--depth === 0) break;
        out.push(c);
      } else out.push(c);
    }
    return new PStr(Uint8Array.from(out));
  }

  private hexString(): PStr {
    const d = this.data;
    this.pos++;
    let hex = '';
    while (this.pos < d.length && d[this.pos] !== 0x3e) {
      const ch = String.fromCharCode(d[this.pos++]);
      if (/[0-9a-fA-F]/.test(ch)) hex += ch;
    }
    this.pos++;
    if (hex.length % 2) hex += '0';
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return new PStr(out);
  }
}

function find(hay: Uint8Array, needle: string, from: number): number {
  const n = needle.length;
  outer: for (let i = from; i <= hay.length - n; i++) {
    for (let j = 0; j < n; j++) if (hay[i + j] !== needle.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}

// ---- Filters -------------------------------------------------------------------------------------------------------

const MAX_DECODED = 160 * 1024 * 1024;

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_DECODED) throw new PdfError('A part of this file unpacks to more than this viewer will hold.');
      parts.push(value);
    }
  } catch (error) {
    if (error instanceof PdfError) throw error;
    // A damaged tail is common; keep what was unpacked so far.
    if (!total) throw new PdfError('A compressed part of this file is damaged.');
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function ascii85(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let group: number[] = [];
  for (const c of data) {
    if (c === 0x7e) break;
    if (WS.has(c)) continue;
    if (c === 0x7a && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    group.push(c - 33);
    if (group.length === 5) {
      let v = 0;
      for (const g of group) v = v * 85 + g;
      out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
      group = [];
    }
  }
  if (group.length > 1) {
    const n = group.length;
    while (group.length < 5) group.push(84);
    let v = 0;
    for (const g of group) v = v * 85 + g;
    const bytes = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    out.push(...bytes.slice(0, n - 1));
  }
  return Uint8Array.from(out);
}

function asciiHex(data: Uint8Array): Uint8Array {
  let hex = '';
  for (const c of data) {
    if (c === 0x3e) break;
    const ch = String.fromCharCode(c);
    if (/[0-9a-fA-F]/.test(ch)) hex += ch;
  }
  if (hex.length % 2) hex += '0';
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function runLength(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < data.length; ) {
    const n = data[i++];
    if (n === 128) break;
    if (n < 128) for (let k = 0; k <= n && i < data.length; k++) out.push(data[i++]);
    else {
      const v = data[i++];
      for (let k = 0; k < 257 - n; k++) out.push(v);
    }
  }
  return Uint8Array.from(out);
}

function predictor(data: Uint8Array, parms: Dict | null, doc: PdfDocument): Uint8Array {
  const pred = parms ? Number(doc.resolve(parms.map.get('Predictor')) ?? 1) : 1;
  if (pred < 2) return data;
  const colors = Number(doc.resolve(parms!.map.get('Colors')) ?? 1);
  const bpc = Number(doc.resolve(parms!.map.get('BitsPerComponent')) ?? 8);
  const columns = Number(doc.resolve(parms!.map.get('Columns')) ?? 1);
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowBytes = Math.ceil((colors * bpc * columns) / 8);
  if (pred === 2) {
    if (bpc !== 8) return data;
    for (let r = 0; r + rowBytes <= data.length; r += rowBytes) {
      for (let i = bpp; i < rowBytes; i++) data[r + i] = (data[r + i] + data[r + i - bpp]) & 255;
    }
    return data;
  }
  const rows = Math.floor(data.length / (rowBytes + 1));
  const out = new Uint8Array(rows * rowBytes);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowBytes + 1)];
    const src = r * (rowBytes + 1) + 1;
    const dst = r * rowBytes;
    for (let i = 0; i < rowBytes; i++) {
      const x = data[src + i];
      const a = i >= bpp ? out[dst + i - bpp] : 0;
      const b = r > 0 ? out[dst - rowBytes + i] : 0;
      const c = r > 0 && i >= bpp ? out[dst - rowBytes + i - bpp] : 0;
      let v = x;
      if (type === 1) v = x + a;
      else if (type === 2) v = x + b;
      else if (type === 3) v = x + ((a + b) >> 1);
      else if (type === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      out[dst + i] = v & 255;
    }
  }
  return out;
}

// ---- The document --------------------------------------------------------------------------------------------------

export interface Page {
  dict: Dict;
  resources: Dict | null;
  box: [number, number, number, number];
  rotate: number;
}

export class PdfDocument {
  private objects = new Map<number, { obj: Obj }>();
  private decoded = new Map<Stream, Uint8Array>();
  pages: Page[] = [];

  static async open(data: Uint8Array): Promise<PdfDocument> {
    const doc = new PdfDocument(data);
    await doc.load();
    return doc;
  }

  private readonly data: Uint8Array;
  private constructor(data: Uint8Array) {
    this.data = data;
  }

  resolve(value: Obj | undefined): Obj {
    let v: Obj | undefined = value;
    for (let i = 0; i < 32 && v instanceof Ref; i++) v = this.objects.get(v.num)?.obj;
    return v === undefined || v instanceof Ref ? null : v;
  }

  dict(value: Obj | undefined): Dict | null {
    const v = this.resolve(value);
    if (v instanceof Dict) return v;
    if (v instanceof Stream) return v.dict;
    return null;
  }

  get(dict: Dict | null, key: string): Obj {
    return dict ? this.resolve(dict.map.get(key)) : null;
  }

  num(value: Obj | undefined, fallback: number): number {
    const v = this.resolve(value);
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  }

  private async load(): Promise<void> {
    const d = this.data;
    if (find(d, '%PDF-', 0) < 0 || find(d, '%PDF-', 0) > 1024) throw new PdfError('This does not look like a PDF file.');
    let text = '';
    const dec = new TextDecoder('latin1');
    // Decode in slices so a big file does not need one enormous string at once.
    for (let i = 0; i < d.length; i += 1 << 22) text += dec.decode(d.subarray(i, Math.min(d.length, i + (1 << 22))));
    const re = /(\d{1,10})\s+(\d{1,5})\s+obj\b/g;
    const trailers: Dict[] = [];
    let m: RegExpExecArray | null;
    let count = 0;
    while ((m = re.exec(text))) {
      if (++count > 400000) break;
      const lexer = new Lexer(d, m.index + m[0].length);
      try {
        let obj = lexer.read(true);
        if (obj === undefined || obj instanceof Cmd) continue;
        if (obj instanceof Dict) {
          const save = lexer.pos;
          const next = lexer.read(true);
          if (next instanceof Cmd && next.cmd === 'stream') {
            let p = lexer.pos;
            if (d[p] === 13) p++;
            if (d[p] === 10) p++;
            const declared = obj.map.get('Length');
            let end = -1;
            if (typeof declared === 'number' && p + declared <= d.length) {
              const after = new Lexer(d, p + declared);
              const kw = after.read(false);
              if (kw instanceof Cmd && kw.cmd === 'endstream') end = p + declared;
            }
            if (end < 0) {
              end = find(d, 'endstream', p);
              if (end < 0) end = d.length;
              if (d[end - 1] === 10) end--;
              if (d[end - 1] === 13) end--;
            }
            obj = new Stream(obj, d.subarray(p, end));
            re.lastIndex = end;
          } else lexer.pos = save;
        }
        this.objects.set(parseInt(m[1], 10), { obj });
        if (obj instanceof Stream && obj.dict.map.get('Type') instanceof Name && (obj.dict.map.get('Type') as Name).name === 'XRef') trailers.push(obj.dict);
      } catch (error) {
        if (error instanceof PdfError) throw error;
      }
    }
    // Trailers written as text.
    const tr = /trailer\s*/g;
    while ((m = tr.exec(text))) {
      try {
        const t = new Lexer(d, m.index + m[0].length).read(true);
        if (t instanceof Dict) trailers.push(t);
      } catch { /* a damaged trailer is skipped */ }
    }
    if (trailers.some(t => t.map.has('Encrypt'))) {
      throw new PdfError('This PDF is password-protected or encrypted. This viewer cannot open those yet.');
    }
    // Objects packed inside object streams.
    for (const [, entry] of [...this.objects]) {
      const o = entry.obj;
      if (!(o instanceof Stream) || !(o.dict.map.get('Type') instanceof Name) || (o.dict.map.get('Type') as Name).name !== 'ObjStm') continue;
      try {
        const bytes = await this.streamData(o);
        const n = this.num(o.dict.map.get('N'), 0);
        const first = this.num(o.dict.map.get('First'), 0);
        const head = new Lexer(bytes, 0);
        const pairs: Array<[number, number]> = [];
        for (let i = 0; i < n; i++) {
          const a = head.read(false);
          const b = head.read(false);
          if (typeof a === 'number' && typeof b === 'number') pairs.push([a, b]);
        }
        for (const [onum, off] of pairs) {
          if (this.objects.has(onum)) continue;
          const value = new Lexer(bytes, first + off).read(true);
          if (value !== undefined && !(value instanceof Cmd)) this.objects.set(onum, { obj: value });
        }
      } catch (error) {
        if (error instanceof PdfError && error.message.includes('more than')) throw error;
      }
    }
    let root: Dict | null = null;
    for (const t of trailers.reverse()) {
      const r = this.dict(t.map.get('Root'));
      if (r && this.get(r, 'Pages')) {
        root = r;
        break;
      }
    }
    if (!root) {
      for (const { obj } of this.objects.values()) {
        if (obj instanceof Dict && obj.map.get('Type') instanceof Name && (obj.map.get('Type') as Name).name === 'Catalog') root = obj;
      }
    }
    if (!root) throw new PdfError('This file has no pages that can be found. It may be damaged.');
    this.collectPages(this.get(root, 'Pages'), null, [0, 0, 612, 792], 0, new Set(), 0);
    if (!this.pages.length) throw new PdfError('This PDF has no pages.');
  }

  private collectPages(node: Obj, resources: Dict | null, box: [number, number, number, number], rotate: number, seen: Set<Obj>, depth: number): void {
    if (!(node instanceof Dict) || seen.has(node) || depth > 32 || this.pages.length >= 5000) return;
    seen.add(node);
    const res = this.dict(node.map.get('Resources')) ?? resources;
    const mb = this.resolve(node.map.get('MediaBox'));
    let b = box;
    if (Array.isArray(mb) && mb.length >= 4) {
      const v = mb.slice(0, 4).map(x => this.num(x, 0));
      b = [Math.min(v[0], v[2]), Math.min(v[1], v[3]), Math.max(v[0], v[2]), Math.max(v[1], v[3])];
    }
    const rot = this.num(node.map.get('Rotate'), rotate);
    const kids = this.resolve(node.map.get('Kids'));
    if (Array.isArray(kids)) {
      for (const kid of kids) this.collectPages(this.resolve(kid), res, b, rot, seen, depth + 1);
    } else {
      const width = b[2] - b[0];
      const height = b[3] - b[1];
      this.pages.push({ dict: node, resources: res, box: width > 0 && height > 0 ? b : [0, 0, 612, 792], rotate: ((rot % 360) + 360) % 360 });
    }
  }

  /** The bytes of a stream with its filters undone, except image filters (DCT, JPX) which are left for the browser. */
  async streamData(stream: Stream): Promise<Uint8Array> {
    const cached = this.decoded.get(stream);
    if (cached) return cached;
    const f = this.resolve(stream.dict.map.get('Filter') ?? stream.dict.map.get('F'));
    const filters = (Array.isArray(f) ? f : f ? [f] : []).map(x => this.resolve(x));
    const p = this.resolve(stream.dict.map.get('DecodeParms') ?? stream.dict.map.get('DP'));
    const parms = Array.isArray(p) ? p.map(x => this.dict(x)) : [this.dict(p)];
    let bytes = stream.raw;
    for (let i = 0; i < filters.length; i++) {
      const name = filters[i] instanceof Name ? (filters[i] as Name).name : '';
      if (name === 'FlateDecode' || name === 'Fl') bytes = predictor(await inflate(bytes), parms[i] ?? null, this);
      else if (name === 'ASCII85Decode' || name === 'A85') bytes = ascii85(bytes);
      else if (name === 'ASCIIHexDecode' || name === 'AHx') bytes = asciiHex(bytes);
      else if (name === 'RunLengthDecode' || name === 'RL') bytes = runLength(bytes);
      else if (name === 'DCTDecode' || name === 'DCT' || name === 'JPXDecode' || name === 'CCITTFaxDecode' || name === 'JBIG2Decode') break;
      else if (name === 'LZWDecode' || name === 'LZW') throw new PdfError('This part of the file uses a compression this viewer does not know (LZW).');
      else if (name) throw new PdfError(`This part of the file uses "${name}", which this viewer does not know.`);
    }
    this.decoded.set(stream, bytes);
    return bytes;
  }

  /** The last filter of an image stream, which tells the renderer whether the bytes are a JPEG. */
  imageFilter(stream: Stream): string {
    const f = this.resolve(stream.dict.map.get('Filter') ?? stream.dict.map.get('F'));
    const list = (Array.isArray(f) ? f : f ? [f] : []).map(x => this.resolve(x));
    const last = list[list.length - 1];
    return last instanceof Name ? last.name : '';
  }
}
