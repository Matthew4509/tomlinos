// Draws the program's artwork from the SVGs below with a headless browser: the 1024px app icon (cargo tauri icon
// makes every size and the .ico from it) and the installer's header (150x57) and side picture (164x314) as the
// 24-bit BMP files NSIS wants. Run from the repository folder:  node sheets/tools/make-art.mjs
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sheets = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';

/** A green tile with a white page on it; the page holds a small grid with a green header row and one cell picked out. */
const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2fa765"/><stop offset="1" stop-color="#136036"/></linearGradient>
    <linearGradient id="page" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#eef3f0"/></linearGradient>
    <filter id="drop" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="4" stdDeviation="5" flood-color="#06301a" flood-opacity=".35"/></filter>
  </defs>
  <rect x="12" y="12" width="232" height="232" rx="52" fill="url(#tile)"/>
  <rect x="12" y="12" width="232" height="116" rx="52" fill="#ffffff" opacity=".08"/>
  <g filter="url(#drop)">
    <rect x="56" y="58" width="144" height="140" rx="14" fill="url(#page)"/>
  </g>
  <path d="M56 72a14 14 0 0 1 14-14h116a14 14 0 0 1 14 14v18H56z" fill="#1e7a45"/>
  <g stroke="#9cc7ae" stroke-width="4" fill="none">
    <path d="M56 126h144M56 162h144"/>
    <path d="M104 90v108M152 90v108"/>
  </g>
  <rect x="106" y="128" width="44" height="32" fill="#cfe9d9" stroke="#1e7a45" stroke-width="5"/>
</svg>`;

const header = `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="57" viewBox="0 0 150 57">
  <rect width="150" height="57" fill="#ffffff"/>
  <g transform="translate(98 6) scale(.176)">${ICON.replace(/^<svg[^>]*>|<\/svg>$/g, '')}</g>
</svg>`;

const sidebar = `<svg xmlns="http://www.w3.org/2000/svg" width="164" height="314" viewBox="0 0 164 314">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1f8a4f"/><stop offset="1" stop-color="#0f4d2b"/></linearGradient></defs>
  <rect width="164" height="314" fill="url(#bg)"/>
  <g stroke="#ffffff" stroke-opacity=".07" stroke-width="1">${Array.from({ length: 14 }, (_, i) => `<path d="M0 ${i * 24 + 8}h164"/>`).join('')}${Array.from({ length: 4 }, (_, i) => `<path d="M${i * 48 + 20} 0v314"/>`).join('')}</g>
  <g transform="translate(34 40) scale(.375)">${ICON.replace(/^<svg[^>]*>|<\/svg>$/g, '')}</g>
  <text x="82" y="176" text-anchor="middle" font-family="Segoe UI, sans-serif" font-size="21" font-weight="600" fill="#ffffff">TOMLIN Sheets</text>
  <text x="82" y="198" text-anchor="middle" font-family="Segoe UI, sans-serif" font-size="12" fill="#d6efe0">Spreadsheets for Windows</text>
</svg>`;

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();

/** The SVG drawn at `w` x `h`, as PNG bytes or as a bottom-up 24-bit BMP. */
async function render(svg, w, h, kind) {
  const b64 = await page.evaluate(async ({ svg, w, h, kind }) => {
    const img = new Image();
    img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext('2d');
    g.drawImage(img, 0, 0, w, h);
    if (kind === 'png') return canvas.toDataURL('image/png').split(',')[1];
    const data = g.getImageData(0, 0, w, h).data;
    const row = Math.ceil((w * 3) / 4) * 4;
    const size = 54 + row * h;
    const buf = new DataView(new ArrayBuffer(size));
    buf.setUint16(0, 0x4d42, true); buf.setUint32(2, size, true); buf.setUint32(10, 54, true);
    buf.setUint32(14, 40, true); buf.setInt32(18, w, true); buf.setInt32(22, h, true);
    buf.setUint16(26, 1, true); buf.setUint16(28, 24, true); buf.setUint32(34, row * h, true);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const s = ((h - 1 - y) * w + x) * 4;
        const d = 54 + y * row + x * 3;
        buf.setUint8(d, data[s + 2]); buf.setUint8(d + 1, data[s + 1]); buf.setUint8(d + 2, data[s]);
      }
    }
    let text = '';
    const bytes = new Uint8Array(buf.buffer);
    for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(text);
  }, { svg, w, h, kind });
  return Buffer.from(b64, 'base64');
}

const art = join(sheets, 'art');
const installer = join(sheets, 'src-tauri', 'installer');
mkdirSync(art, { recursive: true });
mkdirSync(installer, { recursive: true });
writeFileSync(join(art, 'icon.svg'), ICON);
writeFileSync(join(art, 'icon-1024.png'), await render(ICON, 1024, 1024, 'png'));
writeFileSync(join(installer, 'header.bmp'), await render(header, 150, 57, 'bmp'));
writeFileSync(join(installer, 'sidebar.bmp'), await render(sidebar, 164, 314, 'bmp'));
await browser.close();
console.log('Drew art/icon-1024.png, src-tauri/installer/header.bmp and sidebar.bmp');
