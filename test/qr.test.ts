// The QR code maker: checks the fixed patterns, then draws real images and has OpenCV read them back.
// Run: npm test   (the read-back tests need Python with cv2; they skip with a message if it is missing)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { qrMatrix, qrSvgPath } from '../src/core/qr.ts';

const OTPAUTH =
  'otpauth://totp/TomlinOS:alex?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=TomlinOS&algorithm=SHA1&digits=6&period=30';
const LONG = 'The quick brown fox jumps over the lazy dog. '.repeat(5).slice(0, 200);
const MID = 'x'.repeat(115); // needs version 7 at level M
const UNICODE = 'Grüße aus Zürich — café, naïve, Ελληνικά, Кириллица';

const versionOf = (m: boolean[][]) => (m.length - 17) / 4;

function python(args: string[], input?: string): { ok: boolean; out: string; err: string } {
  const r = spawnSync('python', args, { input, encoding: 'utf8', timeout: 60000 });
  return { ok: r.status === 0, out: r.stdout ?? '', err: (r.stderr ?? '') + (r.error ? String(r.error) : '') };
}

const hasCv2 = python(['-c', 'import cv2']).ok;
const hasQrcode = python(['-c', 'import qrcode']).ok;
const workDir = mkdtempSync(join(tmpdir(), 'tomlinos-qr-'));
process.on('exit', () => rmSync(workDir, { recursive: true, force: true }));

/** Writes the code as a binary PGM (P5), 8 px per module, with the 4-module quiet zone. */
function writePgm(matrix: boolean[][], name: string): string {
  const scale = 8;
  const n = matrix.length + 8;
  const px = n * scale;
  const header = Buffer.from(`P5\n${px} ${px}\n255\n`, 'ascii');
  const body = Buffer.alloc(px * px, 255);
  for (let y = 0; y < matrix.length; y++) {
    for (let x = 0; x < matrix.length; x++) {
      if (!matrix[y][x]) continue;
      for (let dy = 0; dy < scale; dy++) {
        const row = ((y + 4) * scale + dy) * px;
        body.fill(0, row + (x + 4) * scale, row + (x + 5) * scale);
      }
    }
  }
  const file = join(workDir, name + '.pgm');
  writeFileSync(file, Buffer.concat([header, body]));
  return file;
}

const DECODE =
  'import cv2,sys\n' +
  'd=cv2.QRCodeDetector()\n' +
  'img=cv2.imread(sys.argv[1])\n' +
  't,_,_=d.detectAndDecode(img)\n' +
  'sys.stdout.buffer.write(t.encode("utf-8"))\n';

function decode(file: string): string {
  const r = python(['-c', DECODE, file]);
  assert.ok(r.ok, 'the Python decoder failed: ' + r.err);
  return r.out;
}

function assertFinder(m: boolean[][], left: number, top: number): void {
  for (let dy = 0; dy < 7; dy++) {
    for (let dx = 0; dx < 7; dx++) {
      const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
      assert.equal(m[top + dy][left + dx], ring !== 2, `finder at ${left},${top} module ${dx},${dy}`);
    }
  }
}

test('size is 17 + 4v and grows with the text, smallest version chosen', () => {
  const cases: Array<[string, number]> = [
    ['HELLO', 1],
    ['a'.repeat(14), 1],
    ['a'.repeat(15), 2],
    [OTPAUTH, 7], // 114 bytes: version 6-M holds 106
    [MID, 7],
    [LONG, 10],
  ];
  for (const [text, version] of cases) {
    const m = qrMatrix(text);
    assert.equal(m.length, 17 + 4 * version, `length ${text.length}`);
    for (const row of m) assert.equal(row.length, m.length);
  }
});

test('finder patterns, separators, timing lines and the dark module are in place', () => {
  for (const text of ['HELLO', OTPAUTH, MID, LONG]) {
    const m = qrMatrix(text);
    const n = m.length;
    assertFinder(m, 0, 0);
    assertFinder(m, n - 7, 0);
    assertFinder(m, 0, n - 7);
    for (let i = 0; i < 8; i++) {
      assert.equal(m[7][i], false, 'separator');
      assert.equal(m[i][7], false, 'separator');
      assert.equal(m[7][n - 1 - i], false, 'separator');
      assert.equal(m[n - 8][i], false, 'separator');
    }
    for (let i = 8; i < n - 8; i++) {
      assert.equal(m[6][i], i % 2 === 0, `row timing at ${i}`);
      assert.equal(m[i][6], i % 2 === 0, `column timing at ${i}`);
    }
    assert.equal(m[n - 8][8], true, 'dark module');
  }
});

test('an alignment pattern sits at the expected place from version 2', () => {
  const m = qrMatrix('a'.repeat(100)); // version 6: centre at 34,34
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      assert.equal(m[34 + dy][34 + dx], Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
});

test('the same text always gives the same code', () => {
  assert.deepEqual(qrMatrix(OTPAUTH), qrMatrix(OTPAUTH));
});

test('too long for version 10 is refused with a plain message', () => {
  assert.throws(() => qrMatrix('a'.repeat(214)), /too long.*213/);
  assert.equal(qrMatrix('a'.repeat(213)).length, 57);
});

test('the SVG path draws one square per dark module, shifted by the quiet zone', () => {
  const m = qrMatrix('HELLO');
  const d = qrSvgPath(m);
  const darkCount = m.flat().filter(Boolean).length;
  assert.equal(d.match(/M/g)?.length, darkCount);
  assert.ok(d.startsWith('M4 4h1v1h-1z'), 'top-left finder corner is at 4,4');
  assert.ok(!/[^Mhvz0-9 -]/.test(d));
});

for (const [label, text] of [
  ['short text', 'HELLO'],
  ['2FA setup link', OTPAUTH],
  ['version 7 text', MID],
  ['200 characters (version 10)', LONG],
  ['UTF-8 with non-ASCII letters', UNICODE],
] as const) {
  test(`OpenCV reads back: ${label}`, t => {
    if (!hasCv2) {
      t.skip('Python with OpenCV (cv2) is not available, so the image read-back was not run');
      return;
    }
    const m = qrMatrix(text);
    const file = writePgm(m, label.replace(/[^a-z0-9]+/gi, '-'));
    assert.equal(decode(file), text, `version ${versionOf(m)}`);
  });
}

// A check that does not depend on any decoder: the Python "qrcode" package, told to use the same
// version, level M, byte mode and mask, must draw exactly the same grid.
const SAME_GRID =
  'import sys,json,qrcode\n' +
  'from qrcode.util import QRData,MODE_8BIT_BYTE\n' +
  'data=bytes.fromhex(sys.stdin.read().strip())\n' +
  'v=int(sys.argv[1])\n' +
  'out=[]\n' +
  'for mask in range(8):\n' +
  '  q=qrcode.QRCode(version=v,error_correction=qrcode.constants.ERROR_CORRECT_M,border=0,mask_pattern=mask)\n' +
  '  q.add_data(QRData(data,mode=MODE_8BIT_BYTE))\n' +
  '  q.make(fit=False)\n' +
  '  out.append(["".join("1" if c else "0" for c in row) for row in q.get_matrix()])\n' +
  'print(json.dumps(out))\n';

test('matches the Python qrcode package module for module (one of its 8 masks)', t => {
  if (!hasQrcode) {
    t.skip('the Python qrcode package is not available, so the grid comparison was not run');
    return;
  }
  for (const text of ['HELLO', OTPAUTH, MID, LONG, UNICODE]) {
    const m = qrMatrix(text);
    const hex = Buffer.from(text, 'utf8').toString('hex');
    const r = python(['-c', SAME_GRID, String(versionOf(m))], hex);
    assert.ok(r.ok, 'qrcode failed: ' + r.err);
    const theirs = JSON.parse(r.out) as string[][];
    const ours = m.map(row => row.map(c => (c ? '1' : '0')).join(''));
    const mask = theirs.findIndex(grid => grid.join('\n') === ours.join('\n'));
    assert.ok(mask >= 0, `no qrcode mask gives our grid for ${text.slice(0, 20)}...`);
  }
});
