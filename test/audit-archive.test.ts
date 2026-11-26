// Audit of the Archive Opener's reader and the zip writer (November 2026). Zips are made here in code. Tests marked
// todo: 'P1' report a lesser fault without failing the suite; the rest pin behaviour that already works.
// The P0 faults (names that clash once cleaned are written over each other; a deeply nested name all but hangs the
// extract) are in archive.ts's extract(), which needs a browser: see test/browser-audit-archive.mjs.
// Run: node --test test/audit-archive.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateRawSync, gzipSync } from 'node:zlib';
import { ArchiveError, readArchive } from '../src/apps/archive/read.ts';
import { zipDeflate, zipStore } from '../src/core/zip.ts';

interface Spec {
  name: string | Buffer;
  data?: string;
  method?: 0 | 8;
  flags?: number;
  descriptor?: boolean;
  cdSize?: number;
  cdPacked?: number;
  centralExtra?: Buffer;
}

function makeZip(files: Spec[], opts: { comment?: string; prefix?: Buffer } = {}): Uint8Array {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = opts.prefix ? opts.prefix.length : 0;
  if (opts.prefix) locals.push(opts.prefix);
  for (const f of files) {
    const nameBuf = Buffer.isBuffer(f.name) ? f.name : Buffer.from(f.name);
    const raw = Buffer.from(f.data ?? '');
    const method = f.method ?? 0;
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const crc = crc32(raw);
    const flags = (f.flags ?? 0x800) | (f.descriptor ? 8 : 0);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(flags, 6);
    head.writeUInt16LE(method, 8);
    if (!f.descriptor) {
      head.writeUInt32LE(crc, 14);
      head.writeUInt32LE(data.length, 18);
      head.writeUInt32LE(raw.length, 22);
    }
    head.writeUInt16LE(nameBuf.length, 26);
    locals.push(head, nameBuf, data);
    let localLen = 30 + nameBuf.length + data.length;
    if (f.descriptor) {
      const dd = Buffer.alloc(16);
      dd.writeUInt32LE(0x08074b50, 0);
      dd.writeUInt32LE(crc, 4);
      dd.writeUInt32LE(data.length, 8);
      dd.writeUInt32LE(raw.length, 12);
      locals.push(dd);
      localLen += 16;
    }
    const extra = f.centralExtra ?? Buffer.alloc(0);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(45, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(flags, 8);
    c.writeUInt16LE(method, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(f.cdPacked ?? data.length, 20);
    c.writeUInt32LE(f.cdSize ?? raw.length, 24);
    c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt16LE(extra.length, 30);
    c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf, extra);
    offset += localLen;
  }
  const cd = Buffer.concat(central);
  const comment = Buffer.from(opts.comment ?? '', 'latin1');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.length, 20);
  return new Uint8Array(Buffer.concat([...locals, cd, end, comment]));
}

/** A ZIP64 extra field (id 1) holding the real sizes, as streaming zippers write even for small files. */
function zip64Extra(size: number, packed: number): Buffer {
  const b = Buffer.alloc(20);
  b.writeUInt16LE(1, 0);
  b.writeUInt16LE(16, 2);
  b.writeBigUInt64LE(BigInt(size), 4);
  b.writeBigUInt64LE(BigInt(packed), 12);
  return b;
}

const text = (b: Uint8Array) => new TextDecoder().decode(b);
async function contents(zip: Uint8Array, name = 'x.zip'): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const e of await readArchive(zip, name)) out[e.parts.join('/') + (e.folder ? '/' : '')] = e.folder ? '' : text(await e.read());
  return out;
}

// ---- What works (kept so a fix does not break it) ---------------------------------------------------------------

test('round trip: zipStore and zipDeflate read back byte for byte, Unicode names, empty file and folder kept', async () => {
  const now = Date.now();
  const big = 'abc'.repeat(100000);
  const stored = zipStore([
    { name: 'Földer/', modified: now },
    { name: 'Földer/日本語 🎉.txt', data: new TextEncoder().encode('unicode'), modified: now },
    { name: 'empty.txt', data: new Uint8Array(), modified: 0 },
  ]);
  assert.deepEqual(await contents(stored), { 'Földer/': '', 'Földer/日本語 🎉.txt': 'unicode', 'empty.txt': '' });
  const packed = await zipDeflate([{ name: 'big.txt', data: new TextEncoder().encode(big), modified: now }]);
  assert.ok(packed.length < 2000);
  assert.equal((await contents(packed))['big.txt'], big);
});

test('data descriptors (sizes after the data), CP437 names, a comment, and an empty zip all read', async () => {
  assert.deepEqual(await contents(makeZip([{ name: 'a.txt', data: 'hello hello', method: 8, descriptor: true }])), { 'a.txt': 'hello hello' });
  assert.deepEqual(await contents(makeZip([{ name: Buffer.from([0x4b, 0x94, 0x6c, 0x6e]), flags: 0, data: 'k' }])), { 'Köln': 'k' });
  assert.deepEqual(await contents(makeZip([{ name: 'a.txt', data: 'hi' }], { comment: 'a plain comment' })), { 'a.txt': 'hi' });
  assert.deepEqual(await readArchive(makeZip([]), 'e.zip'), []);
});

test('a locked (encrypted) entry is listed and refused with a plain reason when read', async () => {
  const [e] = await readArchive(makeZip([{ name: 'p.txt', flags: 0x801, data: 'zzz' }]), 'p.zip');
  await assert.rejects(e.read(), /locked with a password/);
});

test('names that clash once cleaned are all listed by the reader (the loss happens later, in extract)', async () => {
  const entries = await readArchive(makeZip([
    { name: 'a.txt', data: '1' }, { name: 'A.TXT', data: '2' }, { name: 'q?.txt', data: '3' }, { name: 'q_.txt', data: '4' },
  ]), 'd.zip');
  assert.equal(entries.length, 4);
});

// ---- P1 faults ----------------------------------------------------------------------------------------------------

test('AR-P1-7: a small ZIP64 zip (sizes 0xFFFFFFFF with the real ones in the ZIP64 extra) opens', { todo: 'P1' }, async () => {
  const zip = makeZip([{ name: 'a.txt', data: 'hello', cdSize: 0xffffffff, cdPacked: 0xffffffff, centralExtra: zip64Extra(5, 5) }]);
  // Now refused with "says it unpacks to more than 500 MB": a 5-byte file.
  assert.deepEqual(await contents(zip), { 'a.txt': 'hello' });
});

test('AR-P1-8: a zip whose comment holds the end-record bytes "PK\\x05\\x06" still opens', { todo: 'P1' }, async () => {
  const zip = makeZip([{ name: 'a.txt', data: 'hello' }], { comment: 'see PK\x05\x06 and more text after it here ok' });
  // Now the backwards scan stops inside the comment and says "holds more than 20000 items".
  assert.deepEqual(await contents(zip), { 'a.txt': 'hello' });
});

test('AR-P1-9: a zip with bytes in front (a self-extracting .exe renamed .zip) opens', { todo: 'P1' }, async () => {
  const zip = makeZip([{ name: 'a.txt', data: 'hello' }], { prefix: Buffer.from('MZ' + 'x'.repeat(200)) });
  // Now: "This is not a .zip, .gz or .tar file": isZip only looks at the first four bytes.
  assert.deepEqual(await contents(zip), { 'a.txt': 'hello' });
});

test('AR-P1-10: an entry whose whole name is ".." or "/" is not dropped without a word', { todo: 'P1' }, async () => {
  const entries = await readArchive(makeZip([{ name: '..', data: 'lost' }, { name: 'ok.txt', data: 'ok' }]), 'x.zip');
  assert.equal(entries.length, 2, 'the ".." file vanished from the list; nothing says one was left out');
});

test('AR-P1-11: a .gz of several members (cat a.gz b.gz, pigz, bgzip) unpacks whole', { todo: 'P1' }, async () => {
  const two = Buffer.concat([gzipSync('part one, '), gzipSync('part two')]);
  const [only] = await readArchive(new Uint8Array(two), 'log.txt.gz');
  assert.equal(text(await only.read()), 'part one, part two');
});

test('AR-P1-12: files keep the date stored in the zip (the reader gives none, so extracted files get today)', { todo: 'P1' }, async () => {
  const when = new Date(2020, 5, 15, 10, 30, 0).getTime();
  const [e] = await readArchive(zipStore([{ name: 'old.txt', data: new Uint8Array([1]), modified: when }]), 'x.zip');
  assert.equal((e as unknown as { modified?: number }).modified, when);
});

test('AR-P1-13: the zip writer does not wrap a date after 2107 round to 1982', { todo: 'P1' }, () => {
  const zip = zipStore([{ name: 'f.txt', data: new Uint8Array([1]), modified: Date.UTC(2110, 5, 1) }]);
  const year = 1980 + (new DataView(zip.buffer).getUint16(12, true) >> 9);
  assert.ok(year >= 2107, `stored year ${year}`);
});

test('a damaged or unread entry is an ArchiveError (not a crash)', async () => {
  const [bad] = await readArchive(makeZip([{ name: 'a.txt', data: 'x', method: 8, cdSize: 1, cdPacked: 0 }]), 'x.zip');
  await assert.rejects(bad.read(), ArchiveError);
});
