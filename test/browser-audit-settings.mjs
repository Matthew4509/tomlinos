// Audit of Settings in a real Chrome: the colour scheme and wallpaper taking at once and after a reload, pictures
// that are odd or huge, two tabs on one desktop, a small window, keyboard use.
// Each step marked FAULT failed when it was written. Needs the dev server on a FRESH, EMPTY data folder (the first
// step sets up the owner), and `npm run build` done.
//   node test/browser-audit-settings.mjs [http://127.0.0.1:3135] [screenshot folder]
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { tempDir } from './tmp.ts';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3135';
const SHOTS = process.argv[3] ?? null;
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PASS = 'orchard-lantern-harbour-58';
let passed = 0;
const failures = [];

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
let page = await context.newPage();
const shot = async name => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png` });

async function step(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (error) {
    failures.push(name);
    await shot('fail-' + failures.length).catch(() => {});
    console.log('  FAIL ' + name + '\n       ' + String(error.message).split('\n')[0].slice(0, 600));
  }
  for (const p of context.pages()) await closeAll(p).catch(() => {});
}
const ok = (v, what) => {
  if (!v) throw new Error(what);
};

async function closeAll(p = page) {
  for (let i = 0; i < 40; i++) {
    const dialog = p.locator('.dialog');
    if (await dialog.count()) {
      await dialog.getByRole('button', { name: /Cancel|Keep|Close|OK/ }).first().click().catch(() => dialog.getByRole('button').last().click());
      continue;
    }
    const wins = p.locator('.win');
    if (!(await wins.count())) return;
    const top = (await p.locator('.win.active').count()) ? p.locator('.win.active') : wins.last();
    await top.locator('.win-close').first().click();
    await p.waitForTimeout(80);
  }
  throw new Error('windows would not close');
}
async function openApp(p, id, word) {
  await p.locator('.start-btn').click();
  await p.locator('.start-filter').fill(word);
  await p.locator(`.start-menu [data-label="${word}"]`).first().click();
}
async function openSettings(p = page) {
  await openApp(p, 'settings', 'settings');
  const w = p.locator('.win', { has: p.locator('.settings') }).last();
  await w.locator('.settings .swatch').first().waitFor({ timeout: 10000 });
  return w;
}
const wallpaperOf = p => p.evaluate(() => {
  const s = getComputedStyle(document.getElementById('wallpaper'));
  return { colour: s.backgroundColor, image: s.backgroundImage };
});
// The desktop writes its settings 800 ms after a change.
const settle = p => p.waitForTimeout(1500);
async function reload(p) {
  await p.reload();
  await p.locator('#desktop .item').first().waitFor({ timeout: 20000 });
  await p.waitForTimeout(300);
}

// A PNG of the given size, whole and valid.
function png(width, height, rgb = [200, 40, 40]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = buf => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function uploadToPictures(p, files) {
  await p.keyboard.press('Control+Alt+e');
  const w = p.locator('.win.active');
  await w.locator('.item', { hasText: 'Pictures' }).first().dblclick();
  await p.waitForTimeout(300);
  const chooser = p.waitForEvent('filechooser');
  await w.getByRole('button', { name: 'Upload' }).click();
  (await chooser).setFiles(files);
  const last = files[files.length - 1].split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
  await w.locator('.item', { hasText: last }).first().waitFor({ timeout: 15000 });
  await closeAll(p);
}

console.log('Settings audit, against ' + BASE);
await page.goto(BASE);

await step('set up the owner', async () => {
  await page.locator('.gate h1', { hasText: 'Set up this desktop' }).waitFor({ timeout: 20000 });
  await page.getByLabel('Your name').fill('Sample Owner');
  await page.locator('.gate input.gate-input').last().fill(PASS);
  await page.locator('.gate-encrypt').uncheck();
  await page.locator('.gate-go').click();
  await page.locator('.gate h1', { hasText: 'Your recovery key' }).waitFor({ timeout: 30000 });
  await page.locator('.gate .check-row input').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#desktop .item').first().waitFor({ timeout: 20000 });
});

const dir = tempDir('tomlinos-audit-settings-');
writeFileSync(join(dir, 'Sunset.png'), png(64, 40));
writeFileSync(join(dir, 'Broken.png'), Buffer.from('this is not a picture at all, only words'));
// 2 KB that says 60,000 x 60,000 pixels: decoding it would need 14 GB.
const bomb = png(1, 1);
bomb.writeUInt32BE(60000, 16);
bomb.writeUInt32BE(60000, 20);
writeFileSync(join(dir, 'Bomb.png'), bomb);

await step('upload pictures to Pictures', async () => {
  await uploadToPictures(page, [join(dir, 'Sunset.png'), join(dir, 'Broken.png'), join(dir, 'Bomb.png')]);
});

await step('the Dark colour scheme takes at once and after a reload', async () => {
  const w = await openSettings();
  await w.locator('.theme-swatch', { hasText: 'Dark' }).click();
  ok((await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark', 'not dark at once');
  await settle(page);
  await closeAll();
  await reload(page);
  ok((await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark', 'not dark after reload');
  const w2 = await openSettings();
  await shot('settings-dark');
  await w2.locator('.theme-swatch', { hasText: 'Standard' }).click();
  await settle(page);
});

await step('a colour swatch and your own colour take at once and after a reload', async () => {
  const w = await openSettings();
  await w.locator('.swatch:not(.theme-swatch)', { hasText: 'Plum' }).click();
  ok((await wallpaperOf(page)).colour === 'rgb(117, 80, 123)', 'plum not shown');
  await w.locator('input[type=color]').evaluate(el => {
    el.value = '#102030';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(200);
  ok((await wallpaperOf(page)).colour === 'rgb(16, 32, 48)', 'own colour not shown: ' + (await wallpaperOf(page)).colour);
  await settle(page);
  await closeAll();
  await reload(page);
  ok((await wallpaperOf(page)).colour === 'rgb(16, 32, 48)', 'own colour lost on reload: ' + (await wallpaperOf(page)).colour);
});

await step('a picture background takes and survives a reload', async () => {
  const w = await openSettings();
  await w.locator('.picture', { hasText: 'Sunset.png' }).click();
  await page.waitForTimeout(500);
  ok((await wallpaperOf(page)).image.startsWith('url("blob:'), 'no picture: ' + (await wallpaperOf(page)).image);
  await settle(page);
  await closeAll();
  await reload(page);
  ok((await wallpaperOf(page)).image.startsWith('url("blob:'), 'picture lost on reload');
});

await step('a picture that says 60,000 x 60,000 pixels is refused with a reason, desktop still works', async () => {
  const w = await openSettings();
  await w.locator('.picture', { hasText: 'Bomb.png' }).click();
  await page.locator('.toast', { hasText: /too many pixels/ }).waitFor({ timeout: 5000 });
  ok((await wallpaperOf(page)).image === 'none', 'bomb used');
});

await step('a file that is not a picture is refused with a reason (not a silent blank background marked chosen)', async () => {
  const w = await openSettings();
  await w.locator('.swatch:not(.theme-swatch)', { hasText: 'Teal' }).click();
  await w.locator('.picture', { hasText: 'Broken.png' }).click();
  await page.waitForTimeout(1200);
  const toast = await page.locator('.toast', { hasText: /could not be used|not a picture/ }).count();
  const checked = await w.locator('.picture.on', { hasText: 'Broken.png' }).count();
  ok(toast > 0 || checked === 0, 'Broken.png is marked chosen and nothing said; wallpaper ' + JSON.stringify(await wallpaperOf(page)));
  await w.locator('.swatch:not(.theme-swatch)', { hasText: 'Teal' }).click();
  await settle(page);
});

await step('FAULT SET-P0-1: two tabs: a colour chosen in a tab opened before another tab chose a picture is kept', async () => {
  // Both tabs show the Teal colour. Tab B picks a picture; tab A (opened before) then picks Green.
  const b = await context.newPage();
  await b.goto(BASE);
  await b.locator('#desktop .item').first().waitFor({ timeout: 20000 });
  const wb = await openSettings(b);
  await wb.locator('.picture', { hasText: 'Sunset.png' }).click();
  await settle(b);
  const wa = await openSettings(page);
  await wa.locator('.swatch:not(.theme-swatch)', { hasText: 'Green' }).click();
  ok((await wallpaperOf(page)).colour === 'rgb(75, 127, 79)', 'green not shown in tab A');
  await settle(page);
  await b.close();
  await closeAll();
  await reload(page);
  const wp = await wallpaperOf(page);
  ok(wp.image === 'none' && wp.colour === 'rgb(75, 127, 79)', 'after a reload the last choice (Green) is gone: ' + JSON.stringify(wp));
});

await step('FAULT SET-P0-2: a tab left open from before does not empty the Recycle Bin by the old setting', async () => {
  // Tab B is opened while the bin keeps items 30 days (the default). Tab A then sets "Never clear by itself" and a
  // file is deleted. Time passes (40 days, faked in tab B only) and tab B comes back to the front.
  // The screensaver is set to Never first, so the faked time does not start it.
  const w0 = await openSettings(page);
  await w0.locator('label', { hasText: 'Start the screensaver' }).locator('select').selectOption('0');
  await settle(page);
  await closeAll();
  const b = await context.newPage();
  await b.goto(BASE);
  await b.locator('#desktop .item').first().waitFor({ timeout: 20000 });
  const w = await openSettings(page);
  await w.getByLabel('Clear old items').selectOption('never');
  await settle(page);
  await closeAll();
  // A file deleted into the bin, from tab A.
  await page.keyboard.press('Control+Alt+e');
  const ex = page.locator('.win.active');
  await ex.locator('.item', { hasText: 'Pictures' }).first().dblclick();
  await ex.locator('.item', { hasText: 'Broken' }).first().click();
  await page.keyboard.press('Delete');
  if (await page.locator('.dialog').count()) await page.locator('.dialog').getByRole('button').first().click();
  await page.waitForTimeout(800);
  await closeAll();
  await page.locator('#desktop .item', { hasText: 'Recycle Bin' }).dblclick();
  await page.locator('.win.active', { hasText: 'Broken' }).waitFor({ timeout: 10000 });
  await closeAll();
  // 40 days on, in tab B only.
  await b.evaluate(() => {
    const D = Date;
    const off = 40 * 86400000;
    class Later extends D {
      constructor(...a) {
        if (a.length) super(...a);
        else super(D.now() + off);
      }
      static now() {
        return D.now() + off;
      }
    }
    window.Date = Later;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await b.waitForTimeout(2500);
  await b.close();
  await page.locator('#desktop .item', { hasText: 'Recycle Bin' }).dblclick();
  const bin = page.locator('.win.active');
  await page.waitForTimeout(1200);
  const text = await bin.innerText();
  ok(text.includes('Broken'), 'the deleted file was purged for good by the stale tab; bin shows: ' + JSON.stringify(text.slice(0, 200)));
});

await step('FAULT SET-P1-2: a picture put in Pictures while Settings is open shows in its list', async () => {
  const w = await openSettings();
  await w.locator('.picture').first().waitFor({ timeout: 5000 });
  writeFileSync(join(dir, 'Later.png'), png(32, 20, [20, 120, 220]));
  await page.keyboard.press('Control+Alt+e');
  const ex = page.locator('.win.active');
  await ex.locator('.item', { hasText: 'Pictures' }).first().dblclick();
  await page.waitForTimeout(300);
  const chooser = page.waitForEvent('filechooser');
  await ex.getByRole('button', { name: 'Upload' }).click();
  (await chooser).setFiles([join(dir, 'Later.png')]);
  await ex.locator('.item', { hasText: 'Later' }).first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(800);
  ok((await w.locator('.picture', { hasText: 'Later.png' }).count()) === 1, 'Later.png not listed until Settings is opened again');
});

await step('FAULT SET-P1-3: a colour scheme chosen in one tab shows in another open tab without a reload', async () => {
  const b = await context.newPage();
  await b.goto(BASE);
  await b.locator('#desktop .item').first().waitFor({ timeout: 20000 });
  const w = await openSettings(page);
  await w.locator('.theme-swatch', { hasText: 'Silver' }).click();
  await settle(page);
  await b.waitForTimeout(2000);
  const theme = await b.evaluate(() => document.documentElement.dataset.theme);
  await b.close();
  const w2 = await openSettings(page);
  await w2.locator('.theme-swatch', { hasText: 'Standard' }).click();
  await settle(page);
  ok(theme === 'silver', 'the other tab still shows ' + theme);
});

await step('a small window (320 x 300) has no sideways scrolling', async () => {
  const w = await openSettings();
  await w.locator('.settings').evaluate(el => {
    const win = el.closest('.win');
    win.style.width = '320px';
    win.style.height = '300px';
  });
  await page.waitForTimeout(300);
  await shot('settings-small');
  const over = await w.locator('.settings').evaluate(el => {
    const wide = [...el.querySelectorAll('*')].filter(c => c.getBoundingClientRect().right > el.getBoundingClientRect().right + 1 && c.offsetParent).map(c => c.tagName + '.' + c.className).slice(0, 6);
    return { scroll: el.scrollWidth - el.clientWidth, wide };
  });
  ok(over.scroll <= 1, 'sideways scroll ' + JSON.stringify(over));
});

await step('FAULT SET-P1-4: arrow keys move the choice in the Colour scheme radio group (role=radio)', async () => {
  const w = await openSettings();
  const first = w.locator('.theme-swatch').first();
  await first.focus();
  await page.keyboard.press('ArrowRight');
  const focused = await page.evaluate(() => document.activeElement?.textContent);
  ok(focused !== (await first.textContent()), 'ArrowRight did nothing in a radio group');
});

await step('a phone-sized page (375 x 700) shows Settings usable', async () => {
  await page.setViewportSize({ width: 375, height: 700 });
  const w = await openSettings();
  await page.waitForTimeout(300);
  await shot('settings-phone');
  const over = await w.locator('.settings').evaluate(el => el.scrollWidth - el.clientWidth);
  await page.setViewportSize({ width: 1280, height: 800 });
  ok(over <= 1, 'sideways scroll ' + over);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log('  - ' + f);
await browser.close();
process.exit(failures.length ? 1 : 0);
