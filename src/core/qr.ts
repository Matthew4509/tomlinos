// A QR code maker, written from the QR standard (ISO/IEC 18004). Our own code.
// It turns text into a grid of dark and light squares: byte mode (UTF-8), error correction level M,
// the smallest size from version 1 to 10 that fits. Used to show 2FA setup links as a picture.

// Level M block layout per version (index = version): EC bytes per block, then [block count, data bytes] groups.
const M_BLOCKS: ReadonlyArray<readonly [number, ReadonlyArray<readonly [number, number]>]> = [
  [0, []],
  [10, [[1, 16]]],
  [16, [[1, 28]]],
  [26, [[1, 44]]],
  [18, [[2, 32]]],
  [24, [[2, 43]]],
  [16, [[4, 27]]],
  [18, [[4, 31]]],
  [22, [[2, 38], [2, 39]]],
  [22, [[3, 36], [2, 37]]],
  [26, [[4, 43], [1, 44]]],
];

// Centre rows/columns of the alignment patterns per version.
const ALIGN: ReadonlyArray<readonly number[]> = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

const MAX_VERSION = 10;

// ---- GF(256) arithmetic with the polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11D) ----

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/** Generator polynomial (x - a^0)(x - a^1)...(x - a^(degree-1)), highest power first, leading 1 dropped. */
function generator(degree: number): Uint8Array {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return Uint8Array.from(poly.slice(1));
}

/** Reed-Solomon error-correction bytes: the remainder of data * x^n divided by the generator. */
function reedSolomon(data: Uint8Array, ecCount: number): Uint8Array {
  const gen = generator(ecCount);
  const rem = new Uint8Array(ecCount);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.copyWithin(0, 1);
    rem[ecCount - 1] = 0;
    for (let i = 0; i < ecCount; i++) rem[i] ^= gfMul(gen[i], factor);
  }
  return rem;
}

// ---- Sizes ----

function dataBytesFor(version: number): number {
  let n = 0;
  for (const [count, size] of M_BLOCKS[version][1]) n += count * size;
  return n;
}

function countBitsFor(version: number): number {
  return version <= 9 ? 8 : 16;
}

// ---- Bit stream ----

function buildCodewords(bytes: Uint8Array, version: number): Uint8Array {
  const capacity = dataBytesFor(version);
  const bits: number[] = [];
  const put = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4); // byte mode
  put(bytes.length, countBitsFor(version));
  for (const b of bytes) put(b, 8);
  const room = capacity * 8;
  put(0, Math.min(4, room - bits.length)); // terminator
  while (bits.length % 8 !== 0) bits.push(0);
  const out = new Uint8Array(capacity);
  let at = 0;
  for (; at < bits.length / 8; at++) {
    let v = 0;
    for (let i = 0; i < 8; i++) v = (v << 1) | bits[at * 8 + i];
    out[at] = v;
  }
  for (let pad = 0; at < capacity; at++, pad++) out[at] = pad % 2 === 0 ? 0xec : 0x11;
  return out;
}

/** Splits the data into blocks, adds error correction to each, and interleaves them. */
function interleave(data: Uint8Array, version: number): Uint8Array {
  const [ecCount, groups] = M_BLOCKS[version];
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let at = 0;
  for (const [count, size] of groups) {
    for (let i = 0; i < count; i++) {
      const block = data.subarray(at, at + size);
      at += size;
      dataBlocks.push(block);
      ecBlocks.push(reedSolomon(block, ecCount));
    }
  }
  const out: number[] = [];
  const longest = Math.max(...dataBlocks.map(b => b.length));
  for (let i = 0; i < longest; i++) {
    for (const block of dataBlocks) if (i < block.length) out.push(block[i]);
  }
  for (let i = 0; i < ecCount; i++) {
    for (const block of ecBlocks) out.push(block[i]);
  }
  return Uint8Array.from(out);
}

// ---- The grid ----

interface Grid {
  size: number;
  dark: boolean[][];
  reserved: boolean[][];
}

function newGrid(size: number): Grid {
  const make = () => Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  return { size, dark: make(), reserved: make() };
}

function setFixed(g: Grid, x: number, y: number, dark: boolean): void {
  g.dark[y][x] = dark;
  g.reserved[y][x] = true;
}

function drawFinder(g: Grid, cx: number, cy: number): void {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= g.size || y >= g.size) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      setFixed(g, x, y, d !== 2 && d !== 4);
    }
  }
}

function drawAlignment(g: Grid, cx: number, cy: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      setFixed(g, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

/** Remainder of value * 2^(degree) divided by poly (both as bit polynomials). */
function bchRemainder(value: number, poly: number, degree: number): number {
  let r = value << degree;
  for (let bit = 30; bit >= degree; bit--) {
    if ((r >>> bit) & 1) r ^= poly << (bit - degree);
  }
  return r;
}

function drawFormat(g: Grid, mask: number): void {
  const data = (0b00 << 3) | mask; // level M is 00
  const bits = ((data << 10) | bchRemainder(data, 0x537, 10)) ^ 0x5412;
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  const n = g.size;
  // Copy beside the top-left finder.
  for (let i = 0; i <= 5; i++) setFixed(g, 8, i, bit(i));
  setFixed(g, 8, 7, bit(6));
  setFixed(g, 8, 8, bit(7));
  setFixed(g, 7, 8, bit(8));
  for (let i = 9; i < 15; i++) setFixed(g, 14 - i, 8, bit(i));
  // Copy split between the top-right and bottom-left finders.
  for (let i = 0; i < 8; i++) setFixed(g, n - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) setFixed(g, 8, n - 15 + i, bit(i));
  setFixed(g, 8, n - 8, true); // the dark module
}

function drawVersion(g: Grid, version: number): void {
  if (version < 7) return;
  const bits = (version << 12) | bchRemainder(version, 0x1f25, 12);
  const n = g.size;
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) === 1;
    const a = n - 11 + (i % 3);
    const b = Math.floor(i / 3);
    setFixed(g, a, b, dark);
    setFixed(g, b, a, dark);
  }
}

function drawFunctionPatterns(g: Grid, version: number): void {
  const n = g.size;
  for (let i = 0; i < n; i++) {
    setFixed(g, 6, i, i % 2 === 0);
    setFixed(g, i, 6, i % 2 === 0);
  }
  drawFinder(g, 3, 3);
  drawFinder(g, n - 4, 3);
  drawFinder(g, 3, n - 4);
  const centres = ALIGN[version];
  const last = centres.length - 1;
  for (let i = 0; i < centres.length; i++) {
    for (let j = 0; j < centres.length; j++) {
      // Skip the three corners that hold finder patterns.
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      drawAlignment(g, centres[i], centres[j]);
    }
  }
  drawFormat(g, 0); // reserve the format areas; redrawn once the mask is chosen
  drawVersion(g, version);
}

/** Lays the codeword bits in the two-column zigzag, bottom-right upward, skipping column 6. */
function placeData(g: Grid, codewords: Uint8Array): void {
  const n = g.size;
  const total = codewords.length * 8;
  let i = 0;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((n - 1 - right) >> 1) % 2 === 0;
    for (let step = 0; step < n; step++) {
      const y = upward ? n - 1 - step : step;
      for (let k = 0; k < 2; k++) {
        const x = right - k;
        if (g.reserved[y][x]) continue;
        if (i < total) g.dark[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
        i++;
      }
    }
  }
}

function maskHit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function applyMask(g: Grid, mask: number): void {
  for (let y = 0; y < g.size; y++) {
    for (let x = 0; x < g.size; x++) {
      if (!g.reserved[y][x] && maskHit(mask, x, y)) g.dark[y][x] = !g.dark[y][x];
    }
  }
}

// ---- Penalty score (lower is better) ----

function lineScore(line: boolean[]): number {
  let score = 0;
  // Rule 1: five or more of the same colour in a row.
  let run = 1;
  for (let i = 1; i <= line.length; i++) {
    if (i < line.length && line[i] === line[i - 1]) {
      run++;
    } else {
      if (run >= 5) score += 3 + (run - 5);
      run = 1;
    }
  }
  // Rule 3: dark-light-dark-dark-dark-light-dark with four light on one side (outside the grid counts as light).
  const at = (i: number) => i >= 0 && i < line.length && line[i];
  const core = [true, false, true, true, true, false, true];
  for (let s = 0; s + 7 <= line.length; s++) {
    let match = true;
    for (let k = 0; k < 7; k++) {
      if (line[s + k] !== core[k]) {
        match = false;
        break;
      }
    }
    if (!match) continue;
    const lightBefore = !at(s - 1) && !at(s - 2) && !at(s - 3) && !at(s - 4);
    const lightAfter = !at(s + 7) && !at(s + 8) && !at(s + 9) && !at(s + 10);
    if (lightBefore) score += 40;
    if (lightAfter) score += 40;
  }
  return score;
}

function penalty(dark: boolean[][]): number {
  const n = dark.length;
  let score = 0;
  for (let y = 0; y < n; y++) score += lineScore(dark[y]);
  for (let x = 0; x < n; x++) score += lineScore(dark.map(row => row[x]));
  // Rule 2: each 2x2 block of one colour.
  for (let y = 0; y + 1 < n; y++) {
    for (let x = 0; x + 1 < n; x++) {
      const c = dark[y][x];
      if (dark[y][x + 1] === c && dark[y + 1][x] === c && dark[y + 1][x + 1] === c) score += 3;
    }
  }
  // Rule 4: how far the share of dark modules is from half, in steps of 5%.
  let darkCount = 0;
  for (const row of dark) for (const d of row) if (d) darkCount++;
  const percent = (darkCount * 100) / (n * n);
  score += 10 * Math.floor(Math.abs(percent - 50) / 5);
  return score;
}

// ---- Public ----

/** The QR code for `text` as rows of modules (true = dark), without the quiet zone. */
export function qrMatrix(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  let version = 0;
  for (let v = 1; v <= MAX_VERSION; v++) {
    if (4 + countBitsFor(v) + bytes.length * 8 <= dataBytesFor(v) * 8) {
      version = v;
      break;
    }
  }
  if (version === 0) {
    const most = dataBytesFor(MAX_VERSION) - 3;
    throw new Error(
      `This text is too long for a QR code here: it is ${bytes.length} bytes and the most that fits is ${most}. Use shorter text.`,
    );
  }
  const codewords = interleave(buildCodewords(bytes, version), version);
  const size = 17 + 4 * version;
  let best: boolean[][] = [];
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const g = newGrid(size);
    drawFunctionPatterns(g, version);
    placeData(g, codewords);
    applyMask(g, mask);
    drawFormat(g, mask);
    const score = penalty(g.dark);
    if (score < bestScore) {
      bestScore = score;
      best = g.dark;
    }
  }
  return best;
}

/** An SVG path `d` for the dark modules, shifted by a 4-module quiet zone; draw it in a viewBox of size n + 8. */
export function qrSvgPath(matrix: boolean[][]): string {
  const parts: string[] = [];
  for (let y = 0; y < matrix.length; y++) {
    for (let x = 0; x < matrix[y].length; x++) {
      if (matrix[y][x]) parts.push(`M${x + 4} ${y + 4}h1v1h-1z`);
    }
  }
  return parts.join('');
}
