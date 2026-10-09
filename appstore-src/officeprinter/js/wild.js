// The printers after the Canon, each one stranger than the last: the Photo Printer, the Receipt Printer, the Fax
// Machine, the 3D Printer, the Fridge, the printers' picket line and, at the very end, the LaserJet working perfectly.
// Every drawing uses the same fixed 320 x 190 canvas as machines.js. Each returns a small controller: the flow in
// more.js tells it what to do and when, and the drawing keeps animating until the screen closes.
import { setup, wait } from './machines.js';

const UI = '"Segoe UI", system-ui, sans-serif';
const MONO = '"Courier New", monospace';
const font = (px, weight = 600, family = UI) => `${weight} ${px}px ${family}`;
const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Calls draw(g, t) every frame until the screen's signal aborts. t is in seconds. */
function animate(canvas, signal, draw) {
  const { g, w, h } = setup(canvas);
  const t0 = performance.now();
  const frame = now => {
    if (signal?.aborted) return;
    g.clearRect(0, 0, w, h);
    draw(g, (now - t0) / 1000, w, h);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function text(g, s, x, y, size, color, align = 'left', weight = 600, family = UI) {
  g.font = font(size, weight, family);
  g.fillStyle = color;
  g.textAlign = align;
  g.fillText(s, x, y);
  g.textAlign = 'left';
}

function roundRect(g, x, y, w, h, r, fill, stroke) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
  if (fill) { g.fillStyle = fill; g.fill(); }
  if (stroke) { g.strokeStyle = stroke; g.lineWidth = 1; g.stroke(); }
}

/** One page of the report, drawn small: a title bar, lines of text, and a chart on some pages. */
export function drawPage(g, x, y, w, h, n) {
  g.fillStyle = '#ffffff';
  g.fillRect(x, y, w, h);
  const m = w * 0.1;
  g.fillStyle = '#1f3b73';
  g.fillRect(x + m, y + m, w * (n === 0 ? 0.8 : 0.5), Math.max(1, h * 0.04));
  g.fillStyle = '#9a9a9a';
  const lh = Math.max(1, h * 0.035);
  let yy = y + m + h * 0.09;
  const chart = n % 4 === 2;
  const chartAt = y + h * 0.45;
  while (yy < y + h - m) {
    if (chart && yy > chartAt && yy < chartAt + h * 0.25) {
      const colours = ['#1f3b73', '#2f8f5b', '#d9822b', '#c23b3b'];
      for (let b = 0; b < 4; b++) {
        const bh = h * (0.08 + ((n * 3 + b * 5) % 7) * 0.025);
        g.fillStyle = colours[b];
        g.fillRect(x + m + b * w * 0.2, chartAt + h * 0.24 - bh, w * 0.14, bh);
      }
      g.fillStyle = '#9a9a9a';
      yy = chartAt + h * 0.28;
      continue;
    }
    const len = 0.55 + (((n * 7 + Math.round(yy * 3)) % 9) / 9) * 0.25;
    g.fillRect(x + m, yy, (w - 2 * m) * len, lh * 0.6);
    yy += lh * 1.6;
  }
}

// ---------- The Photo Printer: 14 pages on one 6 x 4 photo, in four passes (yellow, magenta, cyan, gloss) ----------

/** How much smaller each page is on the photo (mm on the photo per mm of A4), when `layout` fits them on a 6 x 4 in
 * print with a small margin round each. The drawing and the "text is 1.2 pt" line both use it. */
export const photoFit = layout => Math.min(152.4 / layout.cols / 210, 101.6 / layout.rows / 297) * 0.92;

/** The finished photo, off screen: every page of the report fitted onto one 6 x 4 print, with the Vivid filter. */
function photoImage(pages, layout) {
  const W = 300;
  const H = 200;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#e9e4da';
  g.fillRect(0, 0, W, H);
  const cw = W / layout.cols;
  const ch = H / layout.rows;
  const s = photoFit(layout) * (W / 152.4);
  for (let i = 0; i < pages; i++) {
    const x = (i % layout.cols) * cw + (cw - 210 * s) / 2;
    const y = Math.floor(i / layout.cols) * ch + (ch - 297 * s) / 2;
    drawPage(g, x, y, 210 * s, 297 * s, i);
  }
  // "Vivid": a warm wash and a dark corner vignette, as every photo app does it.
  g.globalCompositeOperation = 'soft-light';
  const wash = g.createLinearGradient(0, 0, W, H);
  wash.addColorStop(0, '#ff9a3c');
  wash.addColorStop(1, '#d6389b');
  g.fillStyle = wash;
  g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = 'multiply';
  const vig = g.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, W * 0.62);
  vig.addColorStop(0, '#ffffff');
  vig.addColorStop(1, '#5a4a5a');
  g.fillStyle = vig;
  g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = 'source-over';
  return c;
}

/** The photo as it is after pass n: 1 = yellow only, 2 = yellow and magenta, 3 and 4 = all of it. */
function photoAfterPass(photo, pass) {
  if (pass >= 3) return photo;
  const c = document.createElement('canvas');
  c.width = photo.width;
  c.height = photo.height;
  const g = c.getContext('2d');
  g.drawImage(photo, 0, 0);
  // With no cyan dye yet, red is never absorbed; with no magenta, green is not either.
  g.globalCompositeOperation = 'lighten';
  g.fillStyle = pass === 1 ? 'rgb(255,255,0)' : 'rgb(255,0,0)';
  g.fillRect(0, 0, c.width, c.height);
  return c;
}

export function photoPrinter(canvas, { pages, layout, speed, signal }) {
  const photo = photoImage(pages, layout);
  const st = { pass: 0, out: 0, done: false, zoom: 0, shown: null, sheen: -1 };
  const PW = 132;
  const PH = 88;
  animate(canvas, signal, (g, t, w, h) => {
    g.fillStyle = '#dcdcdc';
    g.fillRect(0, 0, w, h);
    const px = st.zoom ? 18 : (w - PW) / 2;
    const slot = 118;
    // The photo: only the part that has come out of the slot shows.
    if (st.shown) {
      const y = st.done ? 16 : slot - st.out * PH;
      g.save();
      g.beginPath();
      g.rect(0, 0, w, slot);
      g.clip();
      g.fillStyle = 'rgba(0,0,0,0.18)';
      g.fillRect(px + 2, y + 2, PW, PH);
      g.drawImage(st.shown, px, y, PW, PH);
      if (st.sheen >= 0) {
        const sx = px + st.sheen * (PW + 60) - 30;
        const gl = g.createLinearGradient(sx - 20, 0, sx + 20, 0);
        gl.addColorStop(0, 'rgba(255,255,255,0)');
        gl.addColorStop(0.5, 'rgba(255,255,255,0.55)');
        gl.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = gl;
        g.fillRect(px, y, PW, PH);
      }
      g.restore();
    }
    // The printer: a small white box with a slot and a lit button.
    const bx = (w - 170) / 2;
    roundRect(g, bx, slot - 4, 170, 64, 10, '#f7f7f5', '#b9b9b4');
    g.fillStyle = '#2b2b2b';
    g.fillRect(bx + 18, slot - 2, 134, 4);
    text(g, 'PHOTO', bx + 16, slot + 34, 9, '#9a9a94', 'left', 700);
    g.fillStyle = st.done ? '#3aa845' : (Math.floor(t * 2) % 2 && !still() ? '#3aa845' : '#9fd8a6');
    g.beginPath();
    g.arc(bx + 150, slot + 30, 4, 0, Math.PI * 2);
    g.fill();
    // Enhance: a magnified corner of page 1, from the photo's own pixels, so it only gets blockier.
    if (st.zoom) {
      const zx = 172;
      const zy = 14;
      const zs = 132;
      const src = 60 / 2 ** (st.zoom - 1);
      g.fillStyle = '#111';
      g.fillRect(zx - 3, zy - 3, zs + 6, zs + 6);
      g.imageSmoothingEnabled = false;
      g.drawImage(photo, 6, 8, src, src, zx, zy, zs, zs);
      g.imageSmoothingEnabled = true;
      text(g, `ENHANCE ×${2 ** st.zoom}`, zx + 6, zy + zs - 6, 10, '#ffffff', 'left', 700);
      g.strokeStyle = '#ffffff';
      g.strokeRect(px + (6 / 300) * PW, 16 + (8 / 200) * PH, (src / 300) * PW, (src / 200) * PH);
    }
  });
  return {
    /** Four passes, the paper going out and back in each time; the last one ejects the photo. */
    async print(onPass) {
      for (let pass = 1; pass <= 4; pass++) {
        onPass(pass);
        st.pass = pass;
        st.shown = photoAfterPass(photo, pass);
        for (let i = 0; i <= 20; i++) { st.out = i / 20; if (pass === 4) st.sheen = i / 20; await wait(55, speed, signal); }
        if (pass < 4) for (let i = 20; i >= 0; i--) { st.out = i / 20; await wait(30, speed, signal); }
      }
      st.sheen = -1;
      st.done = true;
    },
    enhance(level) { st.zoom = level; },
  };
}

// ---------- The Receipt Printer: the whole report on a 58 mm till roll ----------

export function receiptPrinter(canvas, { signal }) {
  const lines = [];
  const st = { printed: 0, cuts: [] };
  const pitch = 10;
  animate(canvas, signal, (g, t, w, h) => {
    g.fillStyle = '#d9d6cf';
    g.fillRect(0, 0, w, h);
    const slot = 142;
    const pw = 168;
    const px = (w - pw) / 2;
    // The paper: line i sits (printed - i) lines above the slot, so it all rises as more is printed.
    g.save();
    g.beginPath();
    g.rect(0, 0, w, slot);
    g.clip();
    const first = Math.max(0, Math.floor(st.printed - slot / pitch) - 1);
    g.fillStyle = '#fdfcf8';
    g.fillRect(px, Math.max(0, slot - (st.printed - first) * pitch - pitch), pw, slot);
    g.font = font(7.6, 400, MONO);
    for (let i = first; i < Math.min(lines.length, Math.ceil(st.printed)); i++) {
      const y = slot - (st.printed - i) * pitch;
      if (y < -pitch) continue;
      g.fillStyle = '#2a2a2a';
      g.fillText(lines[i], px + 6, y + 8);
    }
    // Where the cutter has been: a row of dashes across the roll.
    for (const at of st.cuts) {
      const y = slot - (st.printed - at) * pitch;
      if (y < 0 || y > slot) continue;
      g.strokeStyle = '#8a8a8a';
      g.setLineDash([4, 3]);
      g.beginPath();
      g.moveTo(px, y);
      g.lineTo(px + pw, y);
      g.stroke();
      g.setLineDash([]);
    }
    g.restore();
    // The printer: a squat black box with the roll's slot on top.
    roundRect(g, px - 26, slot - 4, pw + 52, 56, 8, '#26282b', '#111');
    g.fillStyle = '#0d0d0d';
    g.fillRect(px - 4, slot - 3, pw + 8, 4);
    text(g, 'TM-58', px - 14, slot + 26, 9, '#8f949b', 'left', 700);
    g.fillStyle = st.printed < lines.length ? '#3aa845' : '#2f6f38';
    g.beginPath();
    g.arc(px + pw + 12, slot + 22, 3.5, 0, Math.PI * 2);
    g.fill();
  });
  return {
    /** Prints `more` at `perSecond` lines a second. Resolves true when done, false if stopWhen() said stop. */
    async print(more, perSecond, speed, onLine, stopWhen) {
      lines.push(...more);
      let last = performance.now();
      while (st.printed < lines.length) {
        if (stopWhen?.()) { lines.length = Math.ceil(st.printed); return false; }
        await wait(40, speed, signal);
        const now = performance.now();
        st.printed = Math.min(lines.length, st.printed + ((now - last) / 1000) * perSecond * speed);
        last = now;
        onLine(st.printed);
      }
      return true;
    },
    cut() { st.cuts.push(st.printed); },
  };
}

// ---------- The Fax Machine: the document goes IN; the only thing that comes out is the report on why it failed ----------

export function faxMachine(canvas, { signal }) {
  const st = { lcd: 'READY', wave: false, docIn: 0, reportOut: 0, report: [] };
  animate(canvas, signal, (g, t, w, h) => {
    g.fillStyle = '#d4d2cb';
    g.fillRect(0, 0, w, h);
    const top = 96;
    // The document being sent, sinking into the feeder at the back.
    const dx = 40;
    const dy = top - 70 + st.docIn * 70;
    g.save();
    g.beginPath();
    g.rect(0, 0, w, top + 4);
    g.clip();
    drawPage(g, dx, dy, 74, 104, 0);
    g.strokeStyle = '#b8b8b8';
    g.strokeRect(dx, dy, 74, 104);
    g.restore();
    // The transmission report, coming out of the front slot.
    if (st.reportOut > 0) {
      const rh = 86 * st.reportOut;
      g.fillStyle = '#fbfaf5';
      g.fillRect(168, top - rh, 120, rh);
      g.strokeStyle = '#c8c8c0';
      g.strokeRect(168, top - rh, 120, rh);
      g.save();
      g.beginPath();
      g.rect(168, top - rh, 120, rh);
      g.clip();
      st.report.forEach((line, i) => text(g, line, 174, top - 86 + 13 + i * 12, 7.5, '#222', 'left', i === 0 ? 700 : 400, MONO));
      g.restore();
    }
    // The machine: beige, a handset on its cradle, a green screen and a keypad.
    roundRect(g, 18, top - 4, 284, 88, 8, '#e8e2cf', '#a9a28c');
    g.fillStyle = '#2d2b27';
    g.fillRect(34, top - 2, 90, 5);
    g.fillRect(166, top - 2, 124, 5);
    roundRect(g, 30, top + 14, 42, 60, 12, '#cfc7ae', '#a9a28c');
    roundRect(g, 36, top + 8, 30, 72, 12, '#3a3833');
    roundRect(g, 150, top + 14, 128, 24, 3, '#8fa37a', '#5d6b4f');
    if (st.wave && !still()) {
      g.strokeStyle = '#1d2a16';
      g.beginPath();
      for (let x = 0; x <= 120; x += 2) {
        const y = top + 26 + Math.sin(x * 0.35 + t * 18) * 5 * Math.sin(x * 0.05 + t * 3) + Math.sin(x * 1.3 + t * 40) * 2;
        if (x) g.lineTo(154 + x, y); else g.moveTo(154, y);
      }
      g.stroke();
    } else {
      text(g, st.lcd, 156, top + 30, 10, '#1d2a16', 'left', 700, MONO);
    }
    for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) roundRect(g, 150 + c * 18, top + 46 + r * 11, 14, 8, 2, '#f4efe0', '#a9a28c');
    roundRect(g, 232, top + 46, 46, 30, 4, '#3a7a3a');
    text(g, 'START', 255, top + 64, 8, '#fff', 'center', 700);
  });
  return st;
}

// ---------- The 3D Printer: your report as an object, in cyan, until the cyan runs out ----------

export function printer3d(canvas, { layers, signal }) {
  const st = { heat: 0, layer: 0, nozzle: 0.5, printing: false, screen: 'IDLE', spool: 1, runout: false };
  const layerPx = 2.2;
  animate(canvas, signal, (g, t, w, h) => {
    g.fillStyle = '#e1e3e6';
    g.fillRect(0, 0, w, h);
    const bedY = 162;
    const left = 70;
    const right = 250;
    // Frame: two uprights and a top bar.
    g.fillStyle = '#2b2e33';
    g.fillRect(56, 12, 10, 170);
    g.fillRect(254, 12, 10, 170);
    g.fillRect(56, 12, 208, 8);
    g.fillRect(40, 178, 240, 10);
    // The bed.
    g.fillStyle = '#3c4148';
    g.fillRect(left - 6, bedY, right - left + 12, 6);
    // The object so far: one cyan band a layer; the top one grows as the nozzle goes along it.
    const done = Math.floor(st.layer);
    for (let i = 0; i < done; i++) {
      g.fillStyle = i % 2 ? '#00a3d9' : '#0b95c6';
      g.fillRect(left + 20, bedY - (i + 1) * layerPx, right - left - 40, layerPx);
    }
    if (st.printing && !st.runout) {
      g.fillStyle = '#00a3d9';
      const x = left + 20 + (right - left - 40) * st.nozzle;
      g.fillRect(left + 20, bedY - (done + 1) * layerPx, x - (left + 20), layerPx);
    }
    // The gantry and nozzle, at the height of the layer being printed.
    const gy = bedY - (done + 1) * layerPx - 22;
    g.fillStyle = '#6d737b';
    g.fillRect(66, gy, 188, 6);
    const nx = left + 20 + (right - left - 40) * st.nozzle;
    roundRect(g, nx - 12, gy - 8, 24, 20, 3, '#1f2226');
    g.fillStyle = st.heat > 0.1 ? `rgb(${140 + 115 * st.heat}, ${90 - 40 * st.heat}, 40)` : '#8a8f96';
    g.beginPath();
    g.moveTo(nx - 5, gy + 12);
    g.lineTo(nx + 5, gy + 12);
    g.lineTo(nx, gy + 20);
    g.fill();
    if (st.runout) {
      g.strokeStyle = '#00a3d9';
      g.beginPath();
      g.moveTo(nx, gy + 20);
      g.quadraticCurveTo(nx + 14, gy + 30 + Math.sin(t * 2) * 2, nx + 4, bedY - done * layerPx);
      g.stroke();
    }
    // The spool, hanging on the right: it shrinks as the cyan is used.
    g.fillStyle = '#4a4f57';
    g.fillRect(272, 40, 4, 40);
    g.fillStyle = '#c7ccd2';
    g.beginPath();
    g.arc(292, 60, 22, 0, Math.PI * 2);
    g.fill();
    if (st.spool > 0) {
      g.fillStyle = '#00a3d9';
      g.beginPath();
      g.arc(292, 60, 8 + 13 * st.spool, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#e1e3e6';
    g.beginPath();
    g.arc(292, 60, 7, 0, Math.PI * 2);
    g.fill();
    // Its little screen.
    roundRect(g, 8, 28, 44, 26, 3, '#101418', '#2b2e33');
    const blink = st.runout && Math.floor(t * 2) % 2 && !still();
    text(g, st.screen, 30, 45, 7, blink ? '#101418' : (st.runout ? '#ff6b5a' : '#7fe0ff'), 'center', 700, MONO);
  });
  return st;
}

// ---------- The Fridge: the report on its door, and in ice, one character a cube ----------

export function fridge(canvas, { signal }) {
  const st = { screen: 'door', list: [], cubes: [], made: 0, full: false };
  animate(canvas, signal, (g, t, w, h) => {
    g.fillStyle = '#e7e1d6';
    g.fillRect(0, 0, w, h);
    // Two doors, handles, and a floor line.
    g.fillStyle = '#cfcac0';
    g.fillRect(0, 182, w, 8);
    roundRect(g, 60, 4, 100, 182, 6, '#dfe3e7', '#a6adb4');
    roundRect(g, 162, 4, 100, 182, 6, '#dfe3e7', '#a6adb4');
    g.fillStyle = '#9aa2aa';
    g.fillRect(150, 30, 5, 70);
    g.fillRect(167, 30, 5, 70);
    // The door screen.
    roundRect(g, 70, 16, 70, 96, 4, '#0f1720', '#39424c');
    text(g, '4°C', 76, 28, 8, '#9fd7ff', 'left', 700);
    text(g, 'KitchenHub', 134, 28, 6, '#6b7c8c', 'right', 600);
    if (st.screen === 'door') {
      drawPage(g, 84, 34, 42, 58, 0);
    } else {
      text(g, 'Shopping list', 76, 42, 7, '#e7eef5', 'left', 700);
      st.list.slice(-7).forEach((item, i) => text(g, `• ${item}`, 76, 54 + i * 8.5, 6, '#c8d4df', 'left', 500));
    }
    // A sticky note on the door, as fridges have.
    g.save();
    g.translate(92, 132);
    g.rotate(-0.08);
    g.fillStyle = '#ffe97a';
    g.fillRect(0, 0, 44, 30);
    text(g, "DAVE'S.", 5, 12, 7, '#4a3b00', 'left', 700);
    text(g, 'DO NOT EAT', 5, 23, 6, '#4a3b00', 'left', 700);
    g.restore();
    // The ice dispenser, with a glass.
    roundRect(g, 184, 30, 58, 84, 6, '#2a3038', '#15191e');
    g.fillStyle = '#4a525c';
    g.fillRect(206, 30, 14, 10);
    g.strokeStyle = 'rgba(210,235,255,0.9)';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(196, 70);
    g.lineTo(199, 112);
    g.lineTo(227, 112);
    g.lineTo(230, 70);
    g.stroke();
    g.lineWidth = 1;
    for (const cube of st.cubes) {
      const age = Math.min(1, (performance.now() - cube.at) / 450);
      const y = 40 + (cube.y - 40) * (still() ? 1 : age * age);
      roundRect(g, cube.x, y, 9, 9, 2, 'rgba(225,244,255,0.95)', 'rgba(150,200,230,0.9)');
      text(g, cube.ch, cube.x + 4.5, y + 7, 6.5, '#1f4d6b', 'center', 700, MONO);
    }
    text(g, `ICE ${st.made.toLocaleString('en-GB')}`, 213, 126, 7, '#3f4a55', 'center', 700);
    if (st.full) text(g, 'BIN FULL', 213, 136, 7, '#c23b3b', 'center', 700);
  });
  return {
    st,
    /** One cube out of the chute, with a character of the report in it. */
    drop(ch) {
      const n = st.cubes.length;
      st.cubes.push({ ch: ch === ' ' ? '·' : ch, x: 201 + (n % 3) * 8, y: 102 - Math.floor(n / 3) * 8, at: performance.now() });
      st.made += 1;
    },
  };
}

// ---------- The strike: every printer on the picket line, going round ----------

const PICKETS = [
  { body: '#6b7280', h: 22 }, { body: '#d6cfbd', h: 16 }, { body: '#e9eaec', h: 18 }, { body: '#2f3237', h: 20 },
  { body: '#f7f7f5', h: 14 }, { body: '#26282b', h: 12 }, { body: '#e8e2cf', h: 16 }, { body: '#2b2e33', h: 24 },
];

export function picket(canvas, { signs, signal }) {
  animate(canvas, signal, (g, t, w, h) => {
    g.fillStyle = '#cdd3da';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#9aa3ad';
    g.fillRect(0, 150, w, 40);
    // The office door they are standing outside.
    g.fillStyle = '#7b6a55';
    g.fillRect(130, 40, 60, 110);
    g.fillStyle = '#5a4c3c';
    g.fillRect(178, 94, 6, 6);
    text(g, 'OFFICE', 160, 58, 8, '#f0e6d6', 'center', 700);
    // Evenly round the loop (the canvas plus 60 off screen), so no two placards ever overlap.
    const step = (w + 60) / PICKETS.length;
    PICKETS.forEach((p, i) => {
      const x = ((i * step - (still() ? 0 : t * 22)) % (w + 60) + w + 60) % (w + 60) - 30;
      const bob = still() ? 0 : Math.abs(Math.sin(t * 5 + i)) * 3;
      const base = 160 - bob;
      g.fillStyle = '#4a4a4a';
      g.fillRect(x + 12, base - p.h - 34, 2, 30);
      roundRect(g, x - 2, base - p.h - 50, 32, 18, 2, '#ffffff', '#555');
      const sign = signs[i % signs.length];
      text(g, sign, x + 14, base - p.h - 38, sign.length > 7 ? 5 : 6.5, '#b3261e', 'center', 800);
      roundRect(g, x, base - p.h, 28, p.h, 3, p.body, '#333');
      g.fillStyle = '#fff';
      g.fillRect(x + 6, base - p.h - 4, 16, 5);
      g.fillStyle = '#222';
      g.fillRect(x + 4, base, 4, 4);
      g.fillRect(x + 20, base, 4, 4);
    });
  });
}

// ---------- The LaserJet: working perfectly, 14 pages onto the tray ----------

export function laserjet(canvas, { signal }) {
  const st = { page: 0, moving: 0, screen: 'READY' };
  animate(canvas, signal, (g, t, w, h) => {
    g.fillStyle = '#dcdfe3';
    g.fillRect(0, 0, w, h);
    const trayY = 86;
    // The stack on the output tray: one sheet thicker for every page.
    for (let i = 0; i < st.page; i++) {
      g.fillStyle = i % 2 ? '#ffffff' : '#f4f4f4';
      g.fillRect(96, trayY - 2 - i * 1.4, 128, 2);
    }
    if (st.page) drawPage(g, 110, trayY - 2 - st.page * 1.4 - 1 - 60, 100, 60, st.page - 1);
    // The sheet coming out now, sliding from the slot onto the stack.
    if (st.moving > 0) {
      const y = trayY + 10 - st.moving * 70;
      g.save();
      g.beginPath();
      g.rect(0, 0, w, trayY + 12);
      g.clip();
      drawPage(g, 110, y, 100, 60, st.page);
      g.restore();
    }
    // The printer.
    roundRect(g, 60, trayY + 8, 200, 86, 8, '#f1f2f4', '#9ca3ab');
    g.fillStyle = '#2b2e33';
    g.fillRect(84, trayY + 10, 152, 4);
    roundRect(g, 176, trayY + 26, 70, 22, 3, '#162028', '#3b4550');
    text(g, st.screen, 211, trayY + 41, 7.5, '#8fe3a1', 'center', 700, MONO);
    text(g, 'LaserJet', 74, trayY + 42, 10, '#6b7280', 'left', 700);
    g.fillStyle = '#3aa845';
    g.beginPath();
    g.arc(250, trayY + 62, 4, 0, Math.PI * 2);
    g.fill();
  });
  return {
    st,
    async print(pages, speed, onPage) {
      for (let p = 0; p < pages; p++) {
        st.screen = `PRINTING ${p + 1}/${pages}`;
        for (let i = 0; i <= 12; i++) { st.moving = i / 12; await wait(60, speed, signal); }
        st.moving = 0;
        st.page = p + 1;
        onPage(p + 1);
        await wait(260, speed, signal);
      }
      st.screen = 'READY';
    },
  };
}
