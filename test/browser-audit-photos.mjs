// Pictures (photo viewer) audit (browser): faults found by trying to break it. Steps marked P0 fail now and pass once
// fixed; the other steps check things that already work, so a fix does not break them.
// Needs the dev server on a FRESH, EMPTY data folder (the first step sets up the owner), and out/ built.
//   node test/browser-audit-photos.mjs [http://127.0.0.1:3121] [screenshot folder]
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3121';
const SHOTS = process.argv[3] ?? null;
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PASS = 'photos-audit-passphrase-73';
let passed = 0;
const failures = [];
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await context.newPage();
const problems = [];
const requests = [];
page.on('console', m => m.type() === 'error' && problems.push('console: ' + m.text()));
page.on('pageerror', e => problems.push('pageerror: ' + e.message));
page.on('request', r => requests.push(r.url()));
const shot = async name => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });
async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (error) {
    failures.push(name);
    await shot('fail-' + failures.length).catch(() => {});
    console.log('  FAIL ' + name + '\n       ' + String(error.message).slice(0, 1500));
  }
}
const eq = (a, b, what) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const ok = (v, what) => {
  if (!v) throw new Error(what);
};

// ---- pictures made in code ----
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = buf => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
/** A solid-colour RGB PNG. */
function png(w, hh, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(hh, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: hh }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
/** A 24-bit BMP with the old 12-byte OS/2 (BITMAPCOREHEADER) header: 16-bit width and height. */
function bmpCore(w, hh) {
  const stride = Math.ceil((w * 3) / 4) * 4;
  const b = Buffer.alloc(14 + 12 + stride * hh);
  b.write('BM', 0, 'latin1');
  b.writeUInt32LE(b.length, 2);
  b.writeUInt32LE(26, 10);
  b.writeUInt32LE(12, 14);
  b.writeUInt16LE(w, 18);
  b.writeUInt16LE(hh, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt16LE(24, 24);
  for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) b.set([255, 0, 0], 26 + y * stride + x * 3); // blue
  return b;
}
/** A 24-bit BMP with the usual 40-byte header. */
function bmp(w, hh) {
  const stride = Math.ceil((w * 3) / 4) * 4;
  const b = Buffer.alloc(54 + stride * hh);
  b.write('BM', 0, 'latin1');
  b.writeUInt32LE(b.length, 2);
  b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14);
  b.writeInt32LE(w, 18);
  b.writeInt32LE(hh, 22);
  b.writeUInt16LE(1, 26);
  b.writeUInt16LE(24, 28);
  return b;
}
/** An ICO holding one PNG. */
function ico(p, w, hh) {
  const head = Buffer.alloc(22);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(1, 4);
  head[6] = w & 0xff;
  head[7] = hh & 0xff;
  head.writeUInt16LE(1, 10);
  head.writeUInt16LE(32, 12);
  head.writeUInt32LE(p.length, 14);
  head.writeUInt32LE(22, 18);
  return Buffer.concat([head, p]);
}
/** A 2-frame 2 × 2 animated GIF (red, then green). */
function gifAnim() {
  // LZW with min code size 2: a clear code before every pixel keeps every code 3 bits wide.
  const lzw = idx => {
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push(4, idx);
    codes.push(5);
    const out = [];
    let acc = 0, n = 0;
    for (const c of codes) {
      acc |= c << n;
      n += 3;
      while (n >= 8) {
        out.push(acc & 0xff);
        acc >>= 8;
        n -= 8;
      }
    }
    if (n) out.push(acc & 0xff);
    return [2, out.length, ...out, 0];
  };
  const frame = idx => [0x21, 0xf9, 4, 0, 50, 0, 0, 0, 0x2c, 0, 0, 0, 0, 2, 0, 2, 0, 0, ...lzw(idx)];
  return Buffer.from([
    ...Buffer.from('GIF89a', 'latin1'), 2, 0, 2, 0, 0x80, 0, 0,
    255, 0, 0, 0, 255, 0,
    0x21, 0xff, 11, ...Buffer.from('NETSCAPE2.0', 'latin1'), 3, 1, 0, 0, 0,
    ...frame(0), ...frame(1), 0x3b,
  ]);
}
const svgSafe = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="lime"/></svg>';
const svgEvil = `<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50" onload="parent.__pwned=1;fetch('/svg-onload-ran')">
<script>parent.__pwned=1;top.__pwned=1;fetch('/svg-script-ran');</script>
<image href="${BASE}/svg-external-image.png" width="10" height="10"/>
<rect width="50" height="50" fill="red"/></svg>`;
const svgPortrait = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 200"><rect width="100" height="200" fill="navy"/></svg>';
// A big SVG that takes a while to draw: Pictures turns it into a 4096 × 4096 PNG before showing it.
const svgSlow = '<svg xmlns="http://www.w3.org/2000/svg" width="4096" height="4096"><defs><filter id="b"><feTurbulence baseFrequency="0.02" numOctaves="8"/><feGaussianBlur stdDeviation="40"/></filter></defs>' +
  Array.from({ length: 12 }, (_, i) => `<rect x="${i * 300}" y="${i * 300}" width="1200" height="1200" filter="url(#b)"/>`).join('') + '</svg>';
const svgForeign = '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><foreignObject width="80" height="40"><div xmlns="http://www.w3.org/1999/xhtml" style="background:teal;width:80px;height:40px">hi</div></foreignObject></svg>';
/** A 60,000 × 60,000 PNG header: refused before decoding. */
function hugePng() {
  const p = png(1, 1, [0, 0, 0]);
  p.writeUInt32BE(60000, 16);
  p.writeUInt32BE(60000, 20);
  p.writeUInt32BE(crc32(p.subarray(12, 29)), 29);
  return p;
}

// ---- desktop helpers ----
const V = () => page.locator('.win', { has: page.locator('.photos') }).last();
const status = () => V().locator('.statusbar').innerText();
const imgState = () => V().locator('.photo-img').evaluate(i => ({ w: i.naturalWidth, h: i.naturalHeight, shown: getComputedStyle(i).display !== 'none' }));
async function upload(files) {
  const dir = mkdtempSync(join(tmpdir(), 'ph-audit-'));
  try {
    for (const [name, data] of Object.entries(files)) writeFileSync(join(dir, name), data);
    await page.keyboard.press('Control+Alt+e');
    const x = page.locator('.win.active');
    await x.locator('.item', { hasText: 'Pictures' }).first().dblclick();
    const chooser = page.waitForEvent('filechooser');
    await x.getByRole('button', { name: 'Upload' }).click();
    (await chooser).setFiles(Object.keys(files).map(n => join(dir, n)));
    for (const n of Object.keys(files)) await x.locator('.item', { hasText: n.replace(/\.[^.]+$/, '') }).first().waitFor({ timeout: 15000 });
    await x.getByRole('button', { name: 'Close', exact: true }).first().click();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
async function closeViewers() {
  for (let i = 0; i < 8 && (await page.locator('.win', { has: page.locator('.photos') }).count()); i++) {
    await V().getByRole('button', { name: 'Close', exact: true }).first().click();
    await page.waitForTimeout(150);
  }
}
/** Opens /Pictures/<name> in Pictures by double-clicking it in File Explorer. */
async function openPic(name) {
  await closeViewers();
  await page.keyboard.press('Control+Alt+e');
  const x = page.locator('.win', { has: page.locator('.explorer') }).last();
  const item = x.locator('.item', { hasText: name.replace(/\.[^.]+$/, '') }).first();
  if (!(await item.waitFor({ timeout: 1500 }).then(() => true, () => false))) await x.locator('.item', { hasText: 'Pictures' }).first().dblclick();
  await item.dblclick();
  await V().locator('.statusbar:not(:has-text("Loading"))').waitFor({ timeout: 15000 });
  for (let k = 0; k < 4 && (await page.locator('.win', { has: page.locator('.explorer') }).count()); k++) {
    await page.locator('.win', { has: page.locator('.explorer') }).last().getByRole('button', { name: 'Close', exact: true }).first().click();
  }
  await V().locator('.photo-view').focus();
}
const waitStatus = async (re, what) => {
  for (let i = 0; i < 60; i++) {
    if (re.test(await status())) return;
    await page.waitForTimeout(150);
  }
  throw new Error(`${what}: status is "${await status()}"`);
};

await page.goto(BASE);
await step('set up a fresh desktop and put the test pictures in /Pictures', async () => {
  await page.locator('.gate h1', { hasText: 'Set up this desktop' }).waitFor({ timeout: 20000 });
  await page.getByLabel('Your name').fill('Audit Tester');
  await page.locator('.gate input.gate-input').last().fill(PASS);
  await page.locator('.gate-encrypt').uncheck();
  await page.locator('.gate-go').click();
  await page.locator('.gate h1', { hasText: 'Your recovery key' }).waitFor({ timeout: 30000 });
  await page.locator('.gate .check-row input').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#desktop .item').first().waitFor({ timeout: 20000 });
  // JPEG (with an EXIF "rotate 90°" tag) and WebP made by the browser's own encoder.
  const made = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 40;
    c.height = 20;
    const g = c.getContext('2d');
    g.fillStyle = 'orange';
    g.fillRect(0, 0, 40, 20);
    const bytes = async t => [...new Uint8Array(await (await new Promise(r => c.toBlob(r, t, 0.9))).arrayBuffer())];
    return { jpg: await bytes('image/jpeg'), webp: await bytes('image/webp') };
  });
  const jpg = Buffer.from(made.jpg);
  // APP1 Exif, big-endian TIFF, one IFD entry: Orientation (0x0112) = 6 (turn 90° clockwise to show).
  const tiff = Buffer.from([0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0]);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body]);
  const exifJpg = Buffer.concat([jpg.subarray(0, 2), app1, jpg.subarray(2)]);
  await upload({
    'a-red.png': png(40, 30, [255, 0, 0]),
    'b-anim.gif': gifAnim(),
    'c-exif.jpg': exifJpg,
    'd-pic.webp': Buffer.from(made.webp),
    'e-safe.svg': svgSafe,
    'f-normal.bmp': bmp(30, 20),
    'g-os2.bmp': bmpCore(100, 100),
    'h-icon.ico': ico(png(16, 16, [0, 0, 255]), 16, 16),
    'i-evil.svg': svgEvil,
    'j-portrait.svg': svgPortrait,
    'k-broken.png': Buffer.from('this is not a picture at all'),
    'l-empty.png': Buffer.alloc(0),
    'm-huge.png': hugePng(),
    'n-tiny.png': png(1, 1, [0, 255, 0]),
    'o-big.png': png(3000, 2000, [200, 200, 0]),
    'p-slow.svg': svgSlow,
    'q-small.png': png(40, 30, [0, 0, 0]),
    'r-foreign.svg': svgForeign,
  });
});

await step('PNG, animated GIF, WebP, safe SVG, normal BMP and ICO open with their sizes', async () => {
  for (const [name, re] of [['a-red.png', /^40 × 30 pixels/], ['b-anim.gif', /^2 × 2 pixels/], ['d-pic.webp', /^40 × 20 pixels/], ['e-safe.svg', /^120 × 60 pixels/], ['f-normal.bmp', /^30 × 20 pixels/], ['h-icon.ico', /^16 × 16 pixels/]]) {
    await openPic(name);
    await waitStatus(re, name);
    ok((await imgState()).shown, `${name} is shown`);
  }
});

await step('a JPEG with EXIF orientation 6 is shown turned (20 × 40)', async () => {
  await openPic('c-exif.jpg');
  await waitStatus(/^20 × 40 pixels/, 'EXIF JPEG');
});

await step('an SVG with script, onload and an outside image: nothing runs, nothing is fetched', async () => {
  await openPic('i-evil.svg');
  await waitStatus(/^50 × 50 pixels/, 'evil svg shown');
  await page.waitForTimeout(500);
  eq(await page.evaluate(() => window.__pwned ?? null), null, 'script ran');
  eq(requests.filter(u => /svg-(onload|script|external)/.test(u)), [], 'requests made by the SVG');
});

await step('broken, empty and huge-declared files say why, with no picture', async () => {
  for (const [name, re] of [['k-broken.png', /damaged/], ['l-empty.png', /damaged/], ['m-huge.png', /60,000 × 60,000/]]) {
    await openPic(name);
    await waitStatus(re, name);
    ok(!(await imgState()).shown, `${name}: no picture`);
  }
});

// PH-P0-1: an OS/2 BMP (12-byte header, 16-bit width and height) is read as 32-bit fields, so a 100 × 100 picture
// "says it is 6,553,700 × 1,572,865 pixels" and is refused (src/core/imagesize.ts:48-49). Chrome draws it fine.
await step('PH-P0-1 a 100 × 100 OS/2 (core header) BMP opens instead of being refused as enormous', async () => {
  await openPic('g-os2.bmp');
  await waitStatus(/^100 × 100 pixels|damaged|says it is/, 'os2 bmp');
  const s = await status();
  ok(s.startsWith('100 × 100 pixels'), `status is "${s}"`);
  ok((await imgState()).shown, 'the picture is shown');
});

await step('Chrome itself draws that OS/2 BMP (so the refusal is the only thing in the way)', async () => {
  const size = await page.evaluate(async b => {
    const bm = await createImageBitmap(new Blob([new Uint8Array(b)], { type: 'image/bmp' }));
    return [bm.width, bm.height];
  }, [...bmpCore(100, 100)]);
  eq(size, [100, 100], 'decoded size');
});

await step('info: how odd pictures come out (prints only)', async () => {
  for (const name of ['j-portrait.svg', 'n-tiny.png', 'p-slow.svg']) {
    const t0 = Date.now();
    await openPic(name);
    await waitStatus(/pixels|damaged|cannot|could not|Tainted|Failed/i, name).catch(() => {});
    const r = await V().locator('.photo-img').evaluate(i => [i.getBoundingClientRect().width, i.getBoundingClientRect().height]);
    console.log(`       ${name}: "${await status()}" drawn ${r.map(Math.round).join(' x ')} in ${Date.now() - t0} ms`);
  }
});

// PH-P0-2: Next/Previous while an SVG is still being turned into a PNG: the slow SVG finishes after the next picture
// was shown and overwrites it (src/apps/photos.ts:88-93: no "is this still the picture wanted" check after
// svgAsPng), so the label says one picture and the window shows another (or an error).
await step('PH-P0-2 pressing → while a big SVG is still drawing shows the next picture, not the SVG', async () => {
  await openPic('o-big.png');
  await V().locator('.photo-view').focus();
  await page.keyboard.press('ArrowRight'); // p-slow.svg
  await page.waitForTimeout(700); // the file is read; the SVG is still being drawn
  await page.keyboard.press('ArrowRight'); // q-small.png
  await page.waitForTimeout(6000);
  ok((await V().locator('.photo-label').innerText()).startsWith('q-small.png'), 'label is q-small.png');
  const s = await imgState();
  eq([s.w, s.h, s.shown, (await status()).slice(0, 15)], [40, 30, true, '40 × 30 pixels,'], 'picture shown and status');
});

// PH-P0-3: an SVG with a <foreignObject> (HTML text inside, as diagram tools export) is drawn into a canvas, which
// the browser then marks unsafe, so toBlob throws (src/apps/photos.ts:26-27) and the status shows the raw browser
// error "Failed to execute 'toBlob' ... Tainted canvases may not be exported." with no picture.
await step('PH-P0-3 an SVG with a foreignObject (HTML inside) is shown, 80 × 40', async () => {
  await openPic('r-foreign.svg');
  await waitStatus(/pixels|Tainted|could not|damaged/, 'foreign svg');
  const s = await status();
  ok(s.startsWith('80 × 40 pixels'), `status is "${s}"`);
  ok((await imgState()).shown, 'the picture is shown');
});

await step('fit: a 3000 × 2000 picture fits inside the window; Full size scrolls to every corner', async () => {
  await openPic('o-big.png');
  await waitStatus(/^3000 × 2000/, 'big');
  const fit = await V().evaluate(w => {
    const v = w.querySelector('.photo-view').getBoundingClientRect();
    const i = w.querySelector('.photo-img').getBoundingClientRect();
    return i.width <= v.width + 1 && i.height <= v.height + 1 && i.left >= v.left - 1 && i.top >= v.top - 1;
  });
  ok(fit, 'fitted picture inside the view');
  await V().getByRole('button', { name: 'Full size' }).click();
  const full = await V().locator('.photo-view').evaluate(v => {
    v.scrollTo(0, 0);
    const i = v.querySelector('.photo-img').getBoundingClientRect();
    const r = v.getBoundingClientRect();
    return { w: v.scrollWidth, left: Math.round(i.left - r.left), top: Math.round(i.top - r.top) };
  });
  eq([full.w >= 3000, full.left, full.top], [true, 0, 0], 'full size starts at the top-left corner');
});

await step('keyboard: → and ← step through the folder, Home/End are not needed to pass', async () => {
  await openPic('a-red.png');
  await page.keyboard.press('ArrowRight');
  await waitStatus(/^2 × 2 pixels/, 'next is the GIF');
  await page.keyboard.press('ArrowLeft');
  await waitStatus(/^40 × 30 pixels/, 'back to the PNG');
});

await step('Edit opens Photo Editor on the same picture', async () => {
  await openPic('a-red.png');
  await V().getByRole('button', { name: 'Edit' }).click();
  const pe = page.locator('.win', { has: page.locator('.pe') }).last();
  await pe.locator('.pe-status', { hasText: 'a-red.png' }).waitFor({ timeout: 10000 });
  await pe.getByRole('button', { name: 'Close', exact: true }).first().click();
});

await step('a 260 × 160 window (the smallest it allows) keeps ←, →, Full size and Edit clickable', async () => {
  await openPic('a-red.png');
  await V().evaluate(el => {
    el.style.width = '260px';
    el.style.height = '160px';
  });
  await page.waitForTimeout(300);
  await shot('small-window');
  const bad = await V().evaluate(el => [...el.querySelectorAll('.photos .toolbar button')].filter(b => {
    const q = b.getBoundingClientRect();
    const hit = document.elementFromPoint(q.x + q.width / 2, q.y + q.height / 2);
    return !(hit === b || b.contains(hit));
  }).map(b => b.textContent));
  eq(bad, [], 'buttons that cannot be clicked');
});

await step('no errors in the page', async () => {
  eq(problems.filter(p => !/status of 404/.test(p)), [], 'problems');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
await Promise.race([browser.close(), new Promise(res => setTimeout(res, 5000))]);
process.exit(failures.length ? 1 : 0);
