import { crc32, deflateRawSync } from 'node:zlib';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// The zip, written here (no outside tool): deflated entries, forward-slash names (Windows' own zipper writes
// backslashes, which cPanel extracts as flat names), empty folders kept.
export function writeZip(from, to) {
  const local = [];
  const central = [];
  let offset = 0;
  // Every file is dated with the moment of packing (a zero date reads as 1980, or as no date at all). Unzipped, each
  // release's files are then newer than the last's, so the web server's "has it changed?" answer is right even for a
  // file whose size did not change.
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const add = (name, data) => {
    const nameBytes = Buffer.from(name, 'utf8');
    const packed = data.length ? deflateRawSync(data) : Buffer.alloc(0);
    const method = data.length ? 8 : 0;
    const body = method ? packed : data;
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(method, 8);
    head.writeUInt16LE(dosTime, 10); head.writeUInt16LE(dosDate, 12);
    head.writeUInt32LE(crc, 14); head.writeUInt32LE(body.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(nameBytes.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0x0800, 8); dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(dosTime, 12); dir.writeUInt16LE(dosDate, 14);
    dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(body.length, 20); dir.writeUInt32LE(data.length, 24); dir.writeUInt16LE(nameBytes.length, 28);
    dir.writeUInt32LE(name.endsWith('/') ? 0x10 : 0, 38); dir.writeUInt32LE(offset, 42);
    local.push(head, nameBytes, body);
    central.push(dir, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  };
  const visit = dir => {
    const names = readdirSync(dir).sort();
    const rel = relative(from, dir).replaceAll(sep, '/');
    if (!names.length && rel) add(rel + '/', Buffer.alloc(0));
    for (const n of names) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) visit(p);
      else add(relative(from, p).replaceAll(sep, '/'), readFileSync(p));
    }
  };
  visit(from);
  const size = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
  writeFileSync(to, Buffer.concat([...local, ...central, end]));
}
