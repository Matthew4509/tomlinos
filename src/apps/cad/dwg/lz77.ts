// The two kinds of compression DWG uses: the LZ77 variant of the 2004 format (also 2010 and later), which CAD Draft
// both writes and reads, and the different one of the 2007 format, which it only reads. Every routine checks its
// bounds, so damaged or hostile data ends in a clear message, never a hang or a read past the end.
import { DwgProblem } from './bits.ts';

const damaged = () => new DwgProblem('a compressed part of the file is damaged');

// ---- 2004 format ---------------------------------------------------------------------------------------------------

/** Unpacks 2004-format compressed data into exactly `size` bytes (more is refused). */
export function decompress18(src: Uint8Array, size: number): Uint8Array {
  const dst = new Uint8Array(size);
  let s = 0;
  let d = 0;
  const byte = () => {
    if (s >= src.length) throw damaged();
    return src[s++];
  };
  const literal = (n: number) => {
    if (s + n > src.length || d + n > size) throw damaged();
    dst.set(src.subarray(s, s + n), d);
    s += n;
    d += n;
  };
  const literalLength = (op: number) => {
    let n = op & 0x0f;
    if (n === 0) {
      let b: number;
      while ((b = byte()) === 0) {
        n += 0xff;
        if (n > size) throw damaged();
      }
      n += 0x0f + b;
    }
    return n + 3;
  };
  const longLength = () => {
    let n = 0;
    let b: number;
    while ((b = byte()) === 0) {
      n += 0xff;
      if (n > size) throw damaged();
    }
    return n + b;
  };
  let op = byte();
  if ((op & 0xf0) === 0) {
    literal(literalLength(op));
    op = byte();
  }
  for (;;) {
    if (op === 0x11) break;
    let length: number;
    let offset: number;
    let lits: number;
    if (op >= 0x40) {
      length = (op >> 4) - 1;
      const op2 = byte();
      offset = ((op >> 2) & 3) | (op2 << 2);
      lits = op & 3;
    } else if (op >= 0x21) {
      length = op - 0x1e;
      const a = byte();
      offset = (a >> 2) | (byte() << 6);
      lits = a & 3;
    } else if (op === 0x20) {
      length = longLength() + 0x21;
      const a = byte();
      offset = (a >> 2) | (byte() << 6);
      lits = a & 3;
    } else if (op >= 0x12) {
      length = (op & 0x0f) + 2;
      const a = byte();
      offset = ((a >> 2) | (byte() << 6)) + 0x3fff;
      lits = a & 3;
    } else if (op === 0x10) {
      length = longLength() + 9;
      const a = byte();
      offset = ((a >> 2) | (byte() << 6)) + 0x3fff;
      lits = a & 3;
    } else throw damaged();
    const from = d - offset - 1;
    if (from < 0 || d + length > size) throw damaged();
    for (let i = 0; i < length; i++) dst[d++] = dst[from + i];
    if (lits) {
      literal(lits);
      op = byte();
    } else {
      op = byte();
      if ((op & 0xf0) === 0) {
        literal(literalLength(op));
        op = byte();
      }
    }
  }
  return dst;
}

/**
 * Packs data in the 2004 format. Matches are looked up through a hash of three bytes, only ones that do not overlap
 * what they copy, and only near ones (at most 0x4000 bytes back): every reader handles those the same way.
 */
export function compress18(src: Uint8Array): Uint8Array {
  const out: number[] = [];
  const n = src.length;
  const head = new Int32Array(1 << 15).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  const hash = (i: number) => ((src[i] << 10) ^ (src[i + 1] << 5) ^ src[i + 2]) & 0x7fff;
  const insert = (i: number) => {
    if (i + 2 >= n) return;
    const h = hash(i);
    prev[i] = head[h];
    head[h] = i;
  };
  let litStart = 0;
  let i = 0;
  /** Index in `out` of the byte whose low two bits hold a short literal run's length (-1 at the start). */
  let litSlot = -1;
  const writeLiterals = (end: number) => {
    const count = end - litStart;
    if (count === 0) return;
    if (litSlot >= 0 && count <= 3) out[litSlot] |= count;
    else {
      // At the start a run must be at least 4 long (a shorter one is never left, see below).
      if (count <= 0x12) out.push(count - 3);
      else {
        out.push(0);
        let rest = count - 0x12;
        while (rest > 0xff) {
          out.push(0);
          rest -= 0xff;
        }
        out.push(rest);
      }
    }
    for (let k = litStart; k < end; k++) out.push(src[k]);
  };
  while (i + 2 < n) {
    let bestLen = 0;
    let bestDist = 0;
    // The first literal run has to be 4 or more bytes long, so no match starts before byte 4.
    if (i >= 4 || litSlot >= 0) {
      let cand = head[hash(i)];
      let tries = 32;
      while (cand >= 0 && tries-- > 0) {
        const dist = i - cand;
        if (dist > 0x4000) break;
        let len = 0;
        const max = Math.min(dist, n - i, 0x1000);
        while (len < max && src[cand + len] === src[i + len]) len++;
        if (len > bestLen) {
          bestLen = len;
          bestDist = dist;
        }
        cand = prev[cand];
      }
      // A run (zeros, a repeated pattern) is held back by its own distance: try twice as far back while that grows it.
      while (bestLen >= 3 && bestLen === bestDist && bestDist * 2 <= 0x4000 && i - bestDist * 2 >= 0) {
        const dist = bestDist * 2;
        let len = 0;
        const max = Math.min(dist, n - i, 0x1000);
        while (len < max && src[i - dist + len] === src[i + len]) len++;
        if (len <= bestLen) break;
        bestLen = len;
        bestDist = dist;
      }
    }
    if (bestLen < 3 || (litSlot < 0 && i - litStart < 4)) {
      insert(i);
      i++;
      continue;
    }
    writeLiterals(i);
    const off = bestDist - 1;
    if (bestLen <= 14 && off <= 0x3ff) {
      out.push(((bestLen + 1) << 4) | ((off & 3) << 2));
      out.push(off >> 2);
      litSlot = out.length - 2;
    } else {
      if (bestLen <= 33) out.push(bestLen + 0x1e);
      else {
        out.push(0x20);
        let rest = bestLen - 0x21;
        while (rest > 0xff) {
          out.push(0);
          rest -= 0xff;
        }
        out.push(rest);
      }
      out.push((off & 0x3f) << 2);
      out.push(off >> 6);
      litSlot = out.length - 2;
    }
    for (let k = 0; k < bestLen; k++) insert(i + k);
    i += bestLen;
    litStart = i;
  }
  writeLiterals(n);
  out.push(0x11, 0, 0);
  return new Uint8Array(out);
}

// ---- 2007 format ---------------------------------------------------------------------------------------------------

/** How a literal run of 0 to 31 bytes is laid out in 2007-format data: [size, from, to] triples. */
const SHORT_RUNS: number[][] = [
  [], [1, 0, 0], [2, 0, 0], [3, 0, 0], [4, 0, 0], [1, 4, 0, 4, 0, 1], [1, 5, 0, 4, 1, 1, 1, 0, 5], [2, 5, 0, 4, 1, 2, 1, 0, 6],
  [8, 0, 0], [1, 8, 0, 8, 0, 1], [1, 9, 0, 8, 1, 1, 1, 0, 9], [2, 9, 0, 8, 1, 2, 1, 0, 10], [4, 8, 0, 8, 0, 4], [1, 12, 0, 4, 8, 1, 8, 0, 5],
  [1, 13, 0, 4, 9, 1, 8, 1, 5, 1, 0, 13], [2, 13, 0, 4, 9, 2, 8, 1, 6, 1, 0, 14], [16, 0, 0], [8, 9, 0, 1, 8, 8, 8, 0, 9],
  [1, 17, 0, 16, 1, 1, 1, 0, 17], [3, 16, 0, 16, 0, 3], [4, 16, 0, 16, 0, 4], [1, 20, 0, 4, 16, 1, 16, 0, 5], [2, 20, 0, 4, 16, 2, 16, 0, 6],
  [3, 20, 0, 4, 16, 3, 16, 0, 7], [8, 16, 0, 16, 0, 8], [8, 17, 0, 1, 16, 8, 16, 0, 9], [1, 25, 0, 8, 17, 1, 1, 16, 9, 16, 0, 10],
  [2, 25, 0, 8, 17, 2, 1, 16, 10, 16, 0, 11], [4, 24, 0, 8, 16, 4, 16, 0, 12], [1, 28, 0, 4, 24, 1, 8, 16, 5, 16, 0, 13],
  [2, 28, 0, 4, 24, 2, 8, 16, 6, 16, 0, 14], [1, 30, 0, 4, 26, 1, 8, 18, 5, 16, 2, 13, 2, 0, 29],
];

/**
 * Unpacks 2007-format compressed data. This follows the published description of the format; no 2007 file made by
 * another program was at hand to check it against, so a 2007 file that does not open says so plainly.
 */
export function decompress21(src: Uint8Array, size: number): Uint8Array {
  const dst = new Uint8Array(size);
  let s = 0;
  let d = 0;
  let length = 0;
  let offset = 0;
  const end = src.length;
  const byte = () => {
    if (s >= end) throw damaged();
    return src[s++];
  };
  let op = byte();
  if ((op & 0xf0) === 0x20) {
    s += 3;
    if (s > end) throw damaged();
    length = src[s - 1] & 7;
  }
  const literalLength = () => {
    length = op + 8;
    if (length === 0x17) {
      let n = byte();
      length += n;
      if (n === 0xff) {
        do {
          n = byte();
          n |= byte() << 8;
          length += n;
          if (length > size) throw damaged();
        } while (n === 0xffff);
      }
    }
  };
  const copyLiteral = (n: number) => {
    if (s + n > end || d + n > size) throw damaged();
    let si = s;
    let di = d;
    const c = (from: number, to: number, k: number) => {
      for (let q = 0; q < k; q++) dst[di + to + q] = src[si + from + q];
    };
    const r = (from: number, to: number, k: number) => {
      // k bytes, in reverse order
      for (let q = 0; q < k; q++) dst[di + to + q] = src[si + from + k - 1 - q];
    };
    let left = n;
    while (left >= 32) {
      c(24, 0, 4); c(28, 4, 4); c(16, 8, 4); c(20, 12, 4); c(8, 16, 4); c(12, 20, 4); c(0, 24, 4); c(4, 28, 4);
      si += 32;
      di += 32;
      left -= 32;
    }
    // A run shorter than 32 comes in pieces, last piece first: [size, from, to] for each (1 to 3 bytes reversed,
    // 4 and 8 straight, 16 as its two halves swapped).
    const pieces = SHORT_RUNS[left];
    for (let q = 0; q < pieces.length; q += 3) {
      const k = pieces[q];
      const from = pieces[q + 1];
      const to = pieces[q + 2];
      if (k <= 3) r(from, to, k);
      else if (k === 16) {
        c(from + 8, to, 8);
        c(from, to + 8, 8);
      } else c(from, to, k);
    }
    s += n;
    d += n;
  };
  const instruction = () => {
    switch (op >> 4) {
      case 0:
        length = (op & 0xf) + 0x13;
        offset = byte();
        op = byte();
        length += (op >> 3) & 0x10;
        offset += ((op & 0x78) << 5) + 1;
        break;
      case 1:
        length = (op & 0xf) + 3;
        offset = byte();
        op = byte();
        offset += ((op & 0xf8) << 5) + 1;
        break;
      case 2:
        offset = byte();
        offset |= byte() << 8;
        length = op & 7;
        if ((op & 8) === 0) {
          op = byte();
          length += op & 0xf8;
        } else {
          offset++;
          length += byte() << 3;
          op = byte();
          length += ((op & 0xf8) << 8) + 0x100;
        }
        break;
      default:
        length = op >> 4;
        offset = op & 15;
        op = byte();
        offset += ((op & 0xf8) << 1) + 1;
    }
  };
  let guard = 0;
  while (s < end) {
    if (++guard > size + end + 16) throw damaged();
    if (length === 0) literalLength();
    copyLiteral(length);
    if (s >= end) break;
    length = 0;
    op = byte();
    instruction();
    for (;;) {
      const from = d - offset;
      if (from < 0 || d + length > size) throw damaged();
      for (let q = 0; q < length; q++) dst[d + q] = dst[from + q];
      d += length;
      length = op & 7;
      if (length !== 0 || s >= end) break;
      op = byte();
      if (op >> 4 === 0) break;
      if (op >> 4 === 15) op &= 15;
      instruction();
    }
  }
  return dst;
}
