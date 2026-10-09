// Reads .zip, .gz, .tar and .tar.gz/.tgz files (no browser needed except DecompressionStream, which Node has too).
// Nothing inside an archive is trusted: every stored name is split into parts and each part made safe, so "../x",
// "/etc/x" or "C:\x" can only ever land inside the folder being extracted to. Unpacking stops at a size cap, so a
// small file that claims to hold gigabytes ("zip bomb") is refused part-way instead of filling the store.
import { cleanName } from '../../fs/names.ts';

export class ArchiveError extends Error {}

export interface ArchiveEntry {
  /** Safe parts, e.g. ["docs", "a.txt"]; never "", ".", "..". */
  parts: string[];
  folder: boolean;
  /** The unpacked size the archive claims (checked while unpacking). */
  size: number;
  read(): Promise<Uint8Array>;
}

/** The most one file may unpack to, and the most a whole archive may. */
export const MAX_ENTRY = 200 * 1024 * 1024;
export const MAX_TOTAL = 500 * 1024 * 1024;
export const MAX_ENTRIES = 20000;

const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const u32 = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

/** "a/../b\\c" -> ["a", "b", "c"]: separators split, empty/dot parts dropped, each part cleaned. */
export function safeParts(raw: string): string[] {
  return raw
    .split(/[\/\\]+/)
    .filter(p => p !== '' && p !== '.' && p !== '..' && !/^[a-zA-Z]:$/.test(p))
    .map(cleanName);
}

async function unpack(data: Uint8Array, format: 'gzip' | 'deflate-raw', limit: number): Promise<Uint8Array> {
  const reader = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream(format)).getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) throw new ArchiveError('A file inside unpacks to far more than it says. It was not opened (this is how "zip bombs" fill a disk).');
      parts.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof ArchiveError) throw error;
    throw new ArchiveError('Part of this archive is damaged and cannot be unpacked.');
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function isZip(b: Uint8Array): boolean {
  return b.length >= 4 && u32(b, 0) === 0x04034b50 || (b.length >= 22 && u32(b, 0) === 0x06054b50);
}
export function isGzip(b: Uint8Array): boolean {
  return b.length >= 18 && b[0] === 0x1f && b[1] === 0x8b;
}
export function isTar(b: Uint8Array): boolean {
  return b.length >= 512 && String.fromCharCode(...b.subarray(257, 262)) === 'ustar' || (b.length >= 512 && tarChecksumOk(b.subarray(0, 512)));
}

// ---- zip -----------------------------------------------------------------------------------------------------------

export function readZip(b: Uint8Array): ArchiveEntry[] {
  let end = -1;
  for (let at = b.length - 22; at >= Math.max(0, b.length - 22 - 65535); at--) {
    if (u32(b, at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new ArchiveError('This does not look like a complete .zip file (its table of contents is missing). It may be cut short.');
  const count = u16(b, end + 10);
  let at = u32(b, end + 16);
  if (count === 0xffff || at === 0xffffffff) throw new ArchiveError('This .zip uses the "ZIP64" format for very large archives, which this opener does not read.');
  if (count > MAX_ENTRIES) throw new ArchiveError(`This archive holds more than ${MAX_ENTRIES} items, which is more than this opener will list.`);
  const entries: ArchiveEntry[] = [];
  let claimed = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > b.length || u32(b, at) !== 0x02014b50) throw new ArchiveError('The table of contents of this .zip is damaged.');
    const flags = u16(b, at + 8);
    const method = u16(b, at + 10);
    const packed = u32(b, at + 20);
    const size = u32(b, at + 24);
    const nameLen = u16(b, at + 28);
    const extraLen = u16(b, at + 30);
    const commentLen = u16(b, at + 32);
    const local = u32(b, at + 42);
    const rawName = new TextDecoder('utf-8').decode(b.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;
    const parts = safeParts(rawName);
    if (parts.length === 0) continue;
    const folder = /[\/\\]$/.test(rawName);
    if (folder) {
      entries.push({ parts, folder, size: 0, read: async () => new Uint8Array() });
      continue;
    }
    claimed += size;
    const read = async (): Promise<Uint8Array> => {
      if (flags & 1) throw new ArchiveError(`“${parts.join('/')}” is locked with a password. This opener does not unlock zip passwords.`);
      if (local + 30 > b.length || u32(b, local) !== 0x04034b50) throw new ArchiveError(`“${parts.join('/')}” is damaged in this .zip.`);
      const start = local + 30 + u16(b, local + 26) + u16(b, local + 28);
      const data = b.subarray(start, start + packed);
      if (data.length < packed) throw new ArchiveError(`“${parts.join('/')}” is cut short in this .zip.`);
      if (method === 0) return data.slice();
      if (method === 8) {
        const out = await unpack(data, 'deflate-raw', Math.min(MAX_ENTRY, size));
        if (out.length !== size) throw new ArchiveError(`“${parts.join('/')}” did not unpack to the size the .zip says. It may be damaged.`);
        return out;
      }
      throw new ArchiveError(`“${parts.join('/')}” is packed a way this opener does not read (method ${method}). Only the usual "deflate" and "stored" are read.`);
    };
    entries.push({ parts, folder, size, read });
  }
  if (claimed > MAX_TOTAL) throw new ArchiveError('This archive says it unpacks to more than 500 MB, which is more than this opener will unpack.');
  return entries;
}

// ---- tar -----------------------------------------------------------------------------------------------------------

function tarChecksumOk(head: Uint8Array): boolean {
  const stored = parseInt(new TextDecoder().decode(head.subarray(148, 156)).replace(/\0.*$/s, '').trim(), 8);
  if (!Number.isFinite(stored)) return false;
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : head[i];
  return sum === stored;
}

const text = (b: Uint8Array) => new TextDecoder('utf-8').decode(b).replace(/\0.*$/s, '');

export function readTar(b: Uint8Array): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  let at = 0;
  let longName: string | null = null;
  let total = 0;
  while (at + 512 <= b.length) {
    const head = b.subarray(at, at + 512);
    if (head.every(x => x === 0)) break;
    if (!tarChecksumOk(head)) throw new ArchiveError('This .tar is damaged (a header does not add up).');
    const size = parseInt(text(head.subarray(124, 136)).trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0) throw new ArchiveError('This .tar is damaged (a size cannot be read).');
    const type = String.fromCharCode(head[156] || 48);
    const dataAt = at + 512;
    const data = b.subarray(dataAt, dataAt + size);
    if (data.length < size) throw new ArchiveError('This .tar is cut short.');
    at = dataAt + Math.ceil(size / 512) * 512;
    if (type === 'L') {
      longName = text(data);
      continue;
    }
    if (type === 'x') {
      const m = /\d+ path=([^\n]*)\n/.exec(new TextDecoder().decode(data));
      if (m) longName = m[1];
      continue;
    }
    if (type === 'g') continue;
    let raw = longName ?? text(head.subarray(0, 100));
    if (longName === null && text(head.subarray(257, 262)) === 'ustar') {
      const prefix = text(head.subarray(345, 500));
      if (prefix) raw = prefix + '/' + raw;
    }
    longName = null;
    const parts = safeParts(raw);
    if (parts.length === 0) continue;
    if (type === '5') entries.push({ parts, folder: true, size: 0, read: async () => new Uint8Array() });
    else if (type === '0' || type === '7') {
      total += size;
      if (total > MAX_TOTAL) throw new ArchiveError('This archive unpacks to more than 500 MB, which is more than this opener will unpack.');
      entries.push({ parts, folder: false, size, read: async () => data.slice() });
    }
    // Links, devices and the like are skipped: they are not files, and a link could point outside the folder.
    if (entries.length > MAX_ENTRIES) throw new ArchiveError(`This archive holds more than ${MAX_ENTRIES} items, which is more than this opener will list.`);
  }
  return entries;
}

// ---- gzip ----------------------------------------------------------------------------------------------------------

/** The file name stored in a .gz header, if any. */
export function gzipName(b: Uint8Array): string | null {
  if (!isGzip(b) || !(b[3] & 8)) return null;
  let at = 10;
  if (b[3] & 4) at += 2 + u16(b, 10);
  const end = b.indexOf(0, at);
  if (end < 0) return null;
  const parts = safeParts(new TextDecoder('latin1').decode(b.subarray(at, end)));
  return parts[parts.length - 1] ?? null;
}

/** Any of the three; `name` is the archive's own file name (used to name what a plain .gz holds). */
export async function readArchive(bytes: Uint8Array, name: string): Promise<ArchiveEntry[]> {
  if (isZip(bytes)) return readZip(bytes);
  if (isGzip(bytes)) {
    const inner = await unpack(bytes, 'gzip', MAX_TOTAL);
    if (isTar(inner)) return readTar(inner);
    const plain = gzipName(bytes) ?? (cleanName(name.replace(/\.(gz|tgz)$/i, '')) || 'file');
    return [{ parts: [plain], folder: false, size: inner.length, read: async () => inner }];
  }
  if (isTar(bytes)) return readTar(bytes);
  if (bytes[0] === 0x37 && bytes[1] === 0x7a) throw new ArchiveError('This is a .7z archive. This opener reads .zip, .gz and .tar only.');
  if (bytes[0] === 0x52 && bytes[1] === 0x61 && bytes[2] === 0x72) throw new ArchiveError('This is a .rar archive. This opener reads .zip, .gz and .tar only.');
  throw new ArchiveError('This is not a .zip, .gz or .tar file this opener can read. It may be damaged, or another kind of file with the wrong name.');
}
