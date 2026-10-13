// A small zip writer, so a folder can be downloaded as one file (stored, not packed) and a spreadsheet saved as .xlsx
// (packed with the browser's own "deflate"). Our own code.
// A folder is an entry whose name ends in "/" and has no data. Names are written as UTF-8 (flag bit 11).
export interface ZipEntry {
  /** Path inside the zip with "/" between parts; a trailing "/" makes it a folder. */
  name: string;
  data?: Uint8Array;
  modified: number;
}

const encoder = new TextEncoder();
let table: Uint32Array | null = null;

export function crc32(data: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTime(ms: number): { time: number; date: number } {
  const d = new Date(Math.max(ms, Date.UTC(1980, 0, 2)));
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Builds the zip. Throws if it would need the 64-bit zip format (4 GB, or 65,535 entries). */
export function zipStore(entries: ZipEntry[]): Uint8Array<ArrayBuffer> {
  return build(entries.map(e => {
    const data = e.data ?? new Uint8Array(0);
    return { name: e.name, modified: e.modified, data, size: data.length, crc: crc32(data), method: 0 };
  }));
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** As zipStore, but each file is packed ("deflate", as an .xlsx made by Excel is), so text-heavy files come out small. */
export async function zipDeflate(entries: ZipEntry[]): Promise<Uint8Array<ArrayBuffer>> {
  const packed: Packed[] = [];
  for (const e of entries) {
    const data = e.data ?? new Uint8Array(0);
    if (!data.length || e.name.endsWith('/')) {
      packed.push({ name: e.name, modified: e.modified, data, size: data.length, crc: crc32(data), method: 0 });
      continue;
    }
    packed.push({ name: e.name, modified: e.modified, data: await deflate(data), size: data.length, crc: crc32(data), method: 8 });
  }
  return build(packed);
}

interface Packed {
  name: string;
  modified: number;
  /** The bytes as stored (packed when method is 8). */
  data: Uint8Array;
  /** The unpacked size and checksum. */
  size: number;
  crc: number;
  method: 0 | 8;
}

function build(entries: Packed[]): Uint8Array<ArrayBuffer> {
  if (entries.length > 0xfffe) throw new RangeError('Too many items for one zip file.');
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const data = entry.data;
    if (offset + data.length + name.length + 100 > 0xffffffff || entry.size > 0xfffffffe) throw new RangeError('Too big for one zip file.');
    const { time, date } = dosTime(entry.modified);
    const crc = entry.crc;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(8, entry.method, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, entry.size, true);
    local.setUint16(26, name.length, true);
    const head = new Uint8Array(local.buffer);
    parts.push(head, name, data);
    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(4, 20, true);
    dir.setUint16(6, 20, true);
    dir.setUint16(8, 0x0800, true);
    dir.setUint16(10, entry.method, true);
    dir.setUint16(12, time, true);
    dir.setUint16(14, date, true);
    dir.setUint32(16, crc, true);
    dir.setUint32(20, data.length, true);
    dir.setUint32(24, entry.size, true);
    dir.setUint16(28, name.length, true);
    if (entry.name.endsWith('/')) dir.setUint32(38, 0x10, true);
    dir.setUint32(42, offset, true);
    central.push(new Uint8Array(dir.buffer), name);
    offset += head.length + name.length + data.length;
  }
  const centralSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(new ArrayBuffer(all.reduce((n, p) => n + p.length, 0)));
  let at = 0;
  for (const p of all) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
