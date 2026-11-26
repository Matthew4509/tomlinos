// Player (music and video) audit (browser): faults found by trying to break it. Steps marked P0 fail now and pass once
// fixed; the other steps check things that already work, so a fix does not break them. "info" lines are P1 findings
// (reported, not failed). Test media is made in code: WAV written byte by byte, WebM recorded by the browser.
// Needs the dev server on a FRESH, EMPTY data folder (the first step sets up the owner), and out/ built.
//   node test/browser-audit-player.mjs [http://127.0.0.1:3125] [screenshot folder]
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3125';
const SHOTS = process.argv[3] ?? null;
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PASS = 'player-audit-passphrase-41';
let passed = 0;
const failures = [];
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
// Every media element that is ever played, so a detached one that keeps playing can still be seen.
await context.addInitScript(() => {
  window.__media = [];
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    if (!window.__media.includes(this)) window.__media.push(this);
    return play.call(this);
  };
});
const page = await context.newPage();
const problems = [];
page.on('pageerror', e => problems.push('pageerror: ' + e.message));
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
const info = (id, text) => console.log(`  info ${id} ${text}`);
const eq = (a, b, what) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const ok = (v, what) => {
  if (!v) throw new Error(what);
};

/** A mono 16-bit PCM WAV with a 440 Hz tone. */
function wav(seconds, rate = 8000) {
  const n = seconds * rate;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin((i * 2 * Math.PI * 440) / rate)), 44 + i * 2);
  return b;
}

// ---- desktop helpers ----
const P = () => page.locator('.win', { has: page.locator('.player') });
const media = () => page.evaluate(() => window.__media.map(m => ({ paused: m.paused, connected: m.isConnected })));
const sounding = async () => (await media()).filter(m => !m.paused).length;
async function upload(folder, files) {
  const dir = mkdtempSync(join(tmpdir(), 'mp-audit-'));
  try {
    for (const [name, data] of Object.entries(files)) writeFileSync(join(dir, name), data);
    await page.keyboard.press('Control+Alt+e');
    const x = page.locator('.win.active');
    await x.locator('.item', { hasText: folder }).first().dblclick();
    const chooser = page.waitForEvent('filechooser');
    await x.getByRole('button', { name: 'Upload' }).click();
    (await chooser).setFiles(Object.keys(files).map(n => join(dir, n)));
    for (const n of Object.keys(files)) await x.locator('.item', { hasText: n.replace(/\.[^.]+$/, '') }).first().waitFor({ timeout: 30000 });
    await x.getByRole('button', { name: 'Close', exact: true }).first().click();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
async function closePlayers() {
  for (let i = 0; i < 8 && (await P().count()); i++) {
    await P().last().locator('.win-close').dispatchEvent('click');
    await page.waitForTimeout(150);
  }
}
/** Opens <folder>/<name> by double-clicking it in File Explorer; returns the Player window. */
async function open(folder, name, { keep = false } = {}) {
  if (!keep) await closePlayers();
  const before = await P().count();
  await page.keyboard.press('Control+Alt+e');
  const x = page.locator('.win', { has: page.locator('.explorer') }).last();
  const item = x.locator('.item', { hasText: name.replace(/\.[^.]+$/, '') }).first();
  if (!(await item.waitFor({ timeout: 1500 }).then(() => true, () => false))) await x.locator('.item', { hasText: folder }).first().dblclick();
  await item.dblclick();
  for (let i = 0; i < 40 && (await P().count()) <= before && !keep; i++) await page.waitForTimeout(100);
  for (let k = 0; k < 4 && (await page.locator('.win', { has: page.locator('.explorer') }).count()); k++) {
    await page.locator('.win', { has: page.locator('.explorer') }).last().locator('.win-close').dispatchEvent('click');
  }
  const w = P().last();
  await w.locator('.statusbar, .app-message[role=alert]').first().waitFor({ timeout: 15000 });
  return w;
}
const mediaOf = w => w.locator('audio, video');
const playIn = async w => mediaOf(w).evaluate(m => m.play());

await page.goto(BASE);
let clip = null;
await step('set up a fresh desktop and put the test files in /Music and /Videos', async () => {
  await page.locator('.gate h1', { hasText: 'Set up this desktop' }).waitFor({ timeout: 20000 });
  await page.getByLabel('Your name').fill('Audit Tester');
  await page.locator('.gate input.gate-input').last().fill(PASS);
  await page.locator('.gate-encrypt').uncheck();
  await page.locator('.gate-go').click();
  await page.locator('.gate h1', { hasText: 'Your recovery key' }).waitFor({ timeout: 30000 });
  await page.locator('.gate .check-row input').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#desktop .item').first().waitFor({ timeout: 20000 });
  // A 2-second 64 x 48 WebM (VP8) recorded by the browser, checked playable here before it is uploaded.
  clip = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 48;
    const g = c.getContext('2d');
    const r = new MediaRecorder(c.captureStream(15), { mimeType: 'video/webm' });
    const parts = [];
    r.ondataavailable = e => parts.push(e.data);
    r.start(100);
    for (let i = 0; i < 30; i++) {
      g.fillStyle = `hsl(${i * 12},80%,50%)`;
      g.fillRect(0, 0, 64, 48);
      await new Promise(z => setTimeout(z, 60));
    }
    r.stop();
    await Promise.race([new Promise(z => (r.onstop = z)), new Promise(z => setTimeout(z, 3000))]);
    const blob = new Blob(parts, { type: 'video/webm' });
    const v = document.createElement('video');
    v.src = URL.createObjectURL(blob);
    const playable = await new Promise(z => {
      v.onloadedmetadata = () => z(v.videoWidth === 64);
      v.onerror = () => z(false);
      setTimeout(() => z(false), 5000);
    });
    return { playable, bytes: [...new Uint8Array(await blob.arrayBuffer())] };
  });
  ok(clip.playable, 'the recorded WebM plays in this browser on its own');
  await upload('Music', {
    'tone.wav': wav(30),
    'tone2.wav': wav(30),
    'broken.mp3': Buffer.from('this is not music at all'),
    'empty.wav': Buffer.alloc(0),
    'really-a-wav.ogg': wav(2),
  });
  await upload('Videos', { 'clip.webm': Buffer.from(clip.bytes) });
});

await step('a WAV opens with an audio player and the status "Music, <size>", and plays', async () => {
  const w = await open('Music', 'tone.wav');
  ok(await w.locator('audio').count(), 'an <audio> element is shown');
  ok(/^Music, \d/.test(await w.locator('.statusbar').innerText()), 'status: ' + (await w.locator('.statusbar').innerText()));
  await playIn(w);
  let t = 0;
  for (let i = 0; i < 30 && t <= 0.2; i++) {
    await page.waitForTimeout(100);
    t = await mediaOf(w).evaluate(m => m.currentTime);
  }
  ok(t > 0.2, 'time moves on: ' + t);
  await shot('wav');
});

await step('a file that is not music, and an empty one, say the browser cannot play them', async () => {
  for (const n of ['broken.mp3', 'empty.wav']) {
    const w = await open('Music', n);
    for (let i = 0; i < 30 && !/cannot play/.test(await w.locator('.statusbar').innerText()); i++) await page.waitForTimeout(100);
    ok(/cannot play/.test(await w.locator('.statusbar').innerText()), `${n}: ${await w.locator('.statusbar').innerText()}`);
  }
});

await step('closing the window while music plays stops the sound', async () => {
  const w = await open('Music', 'tone.wav');
  await playIn(w);
  await page.waitForTimeout(400);
  ok((await sounding()) >= 1, 'it was playing');
  await w.locator('.win-close').click();
  await page.waitForTimeout(1200);
  eq(await sounding(), 0, 'media elements still playing after close');
});

await step('opening the same file twice brings the open window forward, not a second player', async () => {
  await open('Music', 'tone.wav');
  await open('Music', 'tone.wav', { keep: true });
  await page.waitForTimeout(500);
  eq(await P().count(), 1, 'Player windows');
});

await step('a WebM video plays in the Player (picture size known, no "cannot play" message)', async () => {
  const w = await open('Videos', 'clip.webm');
  await page.waitForTimeout(1500);
  const v = await w.locator('video').evaluate(v => {
    return { width: v.videoWidth, error: v.error && v.error.code };
  });
  const status = await w.locator('.statusbar').innerText();
  console.log(`       video: ${JSON.stringify(v)}; uploaded ${clip.bytes.length} bytes; status "${status}"`);
  eq(v.error, null, 'media error code');
  eq(v.width, 64, 'video width');
  await shot('webm');
});

await step('minimising keeps the music going (as a music player should), and two players can play at once', async () => {
  await closePlayers();
  const a = await open('Music', 'tone.wav');
  await open('Music', 'tone2.wav', { keep: true });
  await page.waitForTimeout(500);
  eq(await P().count(), 2, 'Player windows');
  for (let i = 0; i < 2; i++) await playIn(P().nth(i));
  await page.waitForTimeout(400);
  eq(await sounding(), 2, 'both playing');
  await a.locator('.win-btn[aria-label=Minimise]').click().catch(() => a.locator('.win-btn').first().click());
  await page.waitForTimeout(500);
  eq(await sounding(), 2, 'still playing after minimise');
  info('MP-P1-two', 'two players play over each other; starting one does not pause the other');
});

// ---- P1 observations (no failure) ----
await step('report missing player features (info only)', async () => {
  await closePlayers();
  const w = await open('Music', 'tone.wav');
  await playIn(w);
  await page.waitForTimeout(300);
  await w.locator('.player-stage').click({ position: { x: 4, y: 4 } });
  const before = await mediaOf(w).evaluate(m => m.paused);
  await page.keyboard.press('Space');
  await page.waitForTimeout(200);
  if ((await mediaOf(w).evaluate(m => m.paused)) === before) info('MP-P1-keys', 'Space (and other keys) on the Player window does nothing unless the browser control itself has focus');
  if (!(await w.locator('.menubar, [role=menubar]').count())) info('MP-P1-menu', 'no menu bar: no File > Open, no Next/Previous, no Loop, no playlist');
  const loop = await mediaOf(w).evaluate(m => m.loop);
  if (!loop) info('MP-P1-loop', 'no way to loop (the browser audio control has no loop item)');
  // Shrink the window to its smallest: are the play controls still inside it?
  const box = await w.boundingBox();
  const se = w.locator('[data-edge=se]');
  const hb = await se.boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 20, box.y + 20, { steps: 5 });
  await page.mouse.up();
  const win = await w.boundingBox();
  const ctl = await w.locator('audio').boundingBox();
  if (ctl.y + ctl.height > win.y + win.height) info('MP-P1-small', `at the smallest window (${Math.round(win.width)} x ${Math.round(win.height)}) the play controls start ${Math.round(ctl.y - win.y)} px down, below the window edge, and cannot be reached`);
  await shot('small-window');
});


// Last: the lock screen here leads to the public Reader page, so nothing runs after it.
await step('locking the screen pauses the music', async () => {
  const w = await open('Music', 'tone.wav');
  await playIn(w);
  await page.waitForTimeout(300);
  await page.keyboard.press('Alt+l');
  await page.waitForTimeout(800);
  eq(await sounding(), 0, 'playing after lock');
});

if (problems.length) console.log('  page problems:\n   ' + problems.slice(0, 10).join('\n   '));
console.log(`\n${passed} passed, ${failures.length} failed${failures.length ? ': ' + failures.join('; ') : ''}`);
await browser.close();
process.exit(failures.length ? 1 : 0);
