// The two printers you watch work: the Dot Matrix (one character at a time, left to right, on tractor-feed paper) and
// the Home Inkjet (a calibration page, in cyan, until there is no cyan). Only the part of the page that has come out
// of the printer is visible, about the top third; the rest is inside the printer body.
import { CELL_H, CELL_W, drawChar } from './dotfont.js';

// Every wait checks the abort signal, so leaving a screen stops its printer mid-line.
export const wait = (ms, speed, signal) => new Promise((resolve, reject) => {
  setTimeout(() => (signal?.aborted ? reject(new DOMException('Stopped', 'AbortError')) : resolve()), ms / speed);
});

/** Every printer is drawn at one fixed size, 320 x 190, twice over for sharp edges; CSS scales the canvas to fit.
 * Nothing is measured, so a resized window (or a tab that was hidden) cannot leave the drawing the wrong size. */
export const PAPER_W = 320;
export const PAPER_H = 190;
const SHARP = 2;
export function setup(canvas) {
  canvas.width = PAPER_W * SHARP;
  canvas.height = PAPER_H * SHARP;
  const g = canvas.getContext('2d');
  g.setTransform(SHARP, 0, 0, SHARP, 0, 0);
  return { g, w: PAPER_W, h: PAPER_H, dpr: SHARP };
}

function offscreen(w, h, dpr) {
  const c = document.createElement('canvas');
  c.width = Math.round(w * dpr);
  c.height = Math.round(h * dpr);
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { c, g };
}

/** The paper's journey: a sheet drawn once off screen, shown sliding up out of the printer. */
function paperView(canvas, { bodyH, lineH, lines, draw, signal }) {
  const { g, w, h, dpr } = setup(canvas);
  const bodyTop = h - bodyH;
  const top = lineH * 2;
  const paperH = top + lineH * (lines + 12);
  const paper = offscreen(w, paperH, dpr);
  const state = { line: 0, offset: 0, target: 0, head: -1, headX: 0, running: true };
  const lineY = n => top + n * lineH;
  // The line being printed sits right at the printer's mouth.
  const aim = n => bodyTop - 6 - lineY(n) - lineH;
  state.offset = state.target = aim(0);
  const frame = () => {
    if (!state.running || signal?.aborted) return;
    state.offset += (state.target - state.offset) * 0.25;
    g.clearRect(0, 0, w, h);
    g.save();
    g.beginPath();
    g.rect(0, 0, w, bodyTop);
    g.clip();
    g.drawImage(paper.c, 0, state.offset, w, paperH);
    g.restore();
    draw(g, { w, h, bodyTop, state });
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  return { g: paper.g, w, h, bodyTop, lineY, state, feed: n => { state.line = n; state.target = aim(n); }, stop: () => { state.running = false; } };
}

/**
 * The Dot Matrix prints `lines` at `cps` characters a second. reason: 'filetype' prints them all then stops;
 * 'ribbon' fades line by line to nothing; 'jam' stops feeding after `jamAfter` lines, so the rest overprint.
 * Resolves when it stops.
 */
export async function dotMatrix(canvas, { lines, reason, jamAfter = 4, cps, speed, signal }) {
  const cols = 26;
  // Long lines wrap onto the next line, as the printer's own buffer does.
  lines = lines.flatMap(l => (l.length <= cols ? [l] : l.match(new RegExp(`.{1,${cols}}`, 'g'))));
  const probe = setup(canvas);
  const margin = 16;
  const strip = 16;
  const textX = margin + strip + 8;
  const dot = Math.max(1, (probe.w - 2 * textX) / (cols * CELL_W));
  const lineH = CELL_H * dot + dot;
  const view = paperView(canvas, {
    bodyH: 72,
    signal,
    lineH,
    lines: lines.length,
    draw(g, { w, h, bodyTop, state }) {
      // The printer: a beige case, the paper bail with its two rollers, and the print head riding along it.
      g.fillStyle = '#d6cfbd';
      g.fillRect(0, bodyTop, w, h - bodyTop);
      g.fillStyle = '#bfb7a2';
      g.fillRect(0, bodyTop, w, 5);
      g.fillStyle = '#8d8676';
      g.fillRect(margin, bodyTop - 3, w - 2 * margin, 4);
      g.fillStyle = '#3c3a35';
      for (const x of [w * 0.3, w * 0.7]) g.fillRect(x - 9, bodyTop - 5, 18, 7);
      for (let i = 0; i < 6; i++) {
        g.fillStyle = '#b4ac97';
        g.fillRect(w - 110 + i * 12, bodyTop + 26, 6, 26);
      }
      g.fillStyle = '#6f695c';
      g.font = '600 12px "Segoe UI", system-ui, sans-serif';
      g.fillText('DM-800', margin + 4, bodyTop + 30);
      g.fillStyle = state.head >= 0 ? '#3aa845' : '#8d8676';
      g.beginPath();
      g.arc(margin + 8, bodyTop + 50, 4, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#58544b';
      g.fillText('ONLINE', margin + 18, bodyTop + 54);
      const hx = state.head >= 0 ? state.headX : textX - 14;
      g.fillStyle = '#2f2d29';
      g.fillRect(hx - 2, bodyTop - 16, 16, 18);
      g.fillStyle = '#55524a';
      g.fillRect(hx, bodyTop - 12, 12, 3);
    },
  });

  // Continuous green-bar paper: pale green bands every three lines, and the sprocket holes down both edges.
  const pg = view.g;
  const paperW = view.w - 2 * margin;
  pg.fillStyle = '#fbfbf7';
  pg.fillRect(margin, 0, paperW, 99999);
  for (let n = 0; n < lines.length + 12; n += 6) {
    pg.fillStyle = '#e4f1e1';
    pg.fillRect(margin + strip, view.lineY(n), paperW - 2 * strip, lineH * 3);
  }
  pg.strokeStyle = '#d0d0c8';
  pg.setLineDash([2, 3]);
  for (const x of [margin + strip, margin + paperW - strip]) {
    pg.beginPath();
    pg.moveTo(x, 0);
    pg.lineTo(x, 99999);
    pg.stroke();
  }
  pg.setLineDash([]);
  for (let y = lineH; y < view.lineY(lines.length + 12); y += lineH * 1.6) {
    for (const x of [margin + strip / 2, margin + paperW - strip / 2]) {
      pg.fillStyle = '#c9c9c0';
      pg.beginPath();
      pg.arc(x, y, 3.2, 0, Math.PI * 2);
      pg.fill();
    }
  }

  let row = 0;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    const alpha = reason === 'ribbon' ? Math.max(0, 1 - i * 0.14) : 1;
    pg.fillStyle = `rgba(40, 40, 46, ${alpha})`;
    view.state.head = 0;
    for (let c = 0; c < text.length; c++) {
      view.state.headX = textX + c * CELL_W * dot;
      if (text[c] !== ' ') drawChar(pg, text[c], view.state.headX, view.lineY(row) + dot / 2, dot, 0.35 * dot);
      await wait(1000 / cps, speed, signal);
    }
    // The carriage returns; the paper moves up one line (unless it has jammed).
    view.state.headX = textX - 14;
    await wait(220, speed, signal);
    if (!(reason === 'jam' && i + 1 >= jamAfter)) view.feed(++row);
  }
  view.state.head = -1;
  await wait(400, speed, signal);
  return { stop: view.stop };
}

/**
 * The Home Inkjet. It prints the top of the document, finds a print quality problem, and waits for `startCalibration()`
 * (the player's "Start now"). Then it feeds a fresh sheet and prints a proper diagnostic page: title, printer line,
 * nozzle check, head alignment, colour blocks and cyan ramps. Every cyan part costs cyan; once the cartridge runs dry
 * the cyan comes out streaky, then not at all, and the printer stops.
 * onPhase('problem' | 'calibrating' | 'empty'), onStep(0-3) and onCyan(level) report as it goes.
 */
export async function inkjet(canvas, { cyan, speed, signal, printer, onPhase, onStep, onCyan, startCalibration }) {
  const lineH = 11;
  const view = paperView(canvas, {
    bodyH: 64,
    signal,
    lineH,
    lines: 34,
    draw(g, { w, h, bodyTop, state }) {
      g.fillStyle = '#e9eaec';
      g.fillRect(0, bodyTop, w, h - bodyTop);
      g.fillStyle = '#c9ccd1';
      g.fillRect(0, bodyTop, w, 6);
      g.fillStyle = '#2b2d31';
      g.fillRect(24, bodyTop - 2, w - 48, 4);
      if (state.head >= 0) {
        g.fillStyle = '#44474d';
        g.fillRect(state.headX - 10, bodyTop - 14, 22, 14);
        g.fillStyle = '#00a3d9';
        g.fillRect(state.headX - 7, bodyTop - 11, 5, 5);
      }
      g.fillStyle = '#6b6f76';
      g.font = '600 12px "Segoe UI", system-ui, sans-serif';
      g.fillText('Home Inkjet', 28, bodyTop + 36);
    },
  });
  const pg = view.g;
  const left = 34;
  const right = view.w - 34;
  const span = right - left;
  pg.fillStyle = '#ffffff';
  pg.fillRect(22, 0, view.w - 44, 99999);

  let row = 0;
  /** One pass of the print head, then the paper moves on `rows` lines. */
  const sweep = async (paint, rows = 1) => {
    view.state.head = 0;
    const steps = 14;
    for (let s = 0; s <= steps; s++) {
      view.state.headX = left + (span * s) / steps;
      await wait(28, speed, signal);
    }
    paint(view.lineY(row));
    view.state.head = -1;
    row += rows;
    view.feed(row);
    await wait(120, speed, signal);
  };

  // The top of the report, in black: it really is printing.
  for (const len of [0.55, 0, 0.92, 0.88, 0.95, 0.4]) {
    await sweep(y => {
      if (!len) return;
      pg.fillStyle = '#3a3a3a';
      for (let x = left; x < left + span * len; x += 26 + ((x * 7) % 19)) pg.fillRect(x, y + 3, 20 + ((x * 3) % 14), 4);
    });
  }
  onPhase('problem');
  await startCalibration();
  if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
  onPhase('calibrating');

  // A fresh sheet: the report page goes out, and a page edge passes the print head.
  for (let i = 0; i < 3; i++) await sweep(y => { if (i === 1) { pg.fillStyle = '#d7d7d7'; pg.fillRect(22, y + 5, view.w - 44, 1); } });

  // The diagnostic page. `level` is the cyan left; each cyan part asks for its share and gets what is there.
  let level = cyan;
  // The page asks for 11 units of cyan; the cartridge holds 8: it always runs dry in the colour calibration.
  const perUnit = cyan / 8;
  const take = units => {
    const want = units * perUnit;
    const got = Math.min(level, want);
    level = Math.max(0, level - want);
    onCyan(Math.round(level));
    return want ? got / want : 1;
  };
  const text = (s, x, y, size, weight = 600, color = '#1f1f1f', align = 'left') => {
    pg.font = `${weight} ${size}px "Segoe UI", system-ui, sans-serif`;
    pg.fillStyle = color;
    pg.textAlign = align;
    pg.fillText(s, x, y);
    pg.textAlign = 'left';
  };
  const cross = (x, y) => {
    pg.strokeStyle = '#1f1f1f';
    pg.lineWidth = 0.6;
    pg.beginPath();
    pg.arc(x, y, 3, 0, Math.PI * 2);
    pg.moveTo(x - 5, y); pg.lineTo(x + 5, y);
    pg.moveTo(x, y - 5); pg.lineTo(x, y + 5);
    pg.stroke();
  };
  /** Cyan at the strength the cartridge could give: gaps (dropped nozzles) where it could not. */
  const cyanRect = (x, y, wdt, hgt, strength, alpha = 1, seed = 0) => {
    if (strength <= 0) return;
    pg.fillStyle = `rgba(0, 163, 217, ${alpha * Math.max(0.35, strength)})`;
    if (strength >= 1) { pg.fillRect(x, y, wdt, hgt); return; }
    for (let yy = 0; yy < hgt; yy += 1) if (((yy * 7 + seed * 13) % 10) / 10 < strength) pg.fillRect(x, y + yy, wdt, 0.8);
  };
  const colour = { k: '#1b1b1b', m: '#d6007e', y: '#f2c500' };
  const now = new Date();
  const stamp = `${now.toLocaleDateString('en-GB')} ${now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
  let out = false;

  const bands = [
    [0, 2, 0, y => {
      cross(left + 4, y + 8);
      cross(right - 4, y + 8);
      text('PRINT QUALITY DIAGNOSTIC PAGE', view.w / 2, y + 11, 8.5, 700, '#1f1f1f', 'center');
    }],
    [0, 1, 0, y => text(`${printer}   ·   ${stamp}   ·   Firmware 3.1.4   ·   Page 1 of 1`, view.w / 2, y + 8, 5.5, 500, '#555', 'center')],
    [0, 1, 0, y => { pg.fillStyle = '#1f1f1f'; pg.fillRect(left, y + 5, span, 0.8); }],
    [1, 1, 0, y => text('1   Nozzle check', left, y + 8, 6.5, 700)],
    [1, 2, 1, (y, s) => {
      const groups = ['k', 'c', 'm', 'y'];
      const gw = span / 4;
      groups.forEach((cName, gi) => {
        for (let n = 0; n < 14; n++) {
          const x = left + gi * gw + n * (gw - 8) / 14;
          const yy = y + 2 + (n % 7) * 2;
          if (cName === 'c') cyanRect(x, yy, 3.2, 1.2, s, 1, n);
          else { pg.fillStyle = colour[cName]; pg.fillRect(x, yy, 3.2, 1.2); }
        }
        text(cName.toUpperCase(), left + gi * gw + (gw - 8) / 2, y + 21, 5.5, 700, '#555', 'center');
      });
    }],
    [2, 1, 0, y => text('2   Print head alignment', left, y + 8, 6.5, 700)],
    [2, 2, 1, (y, s) => {
      const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
      const gw = span / letters.length;
      letters.forEach((l, i) => {
        const x = left + i * gw + gw / 2;
        for (let j = -3; j <= 3; j++) {
          pg.fillStyle = '#1b1b1b';
          pg.fillRect(x + j * 4 - 3, y + 1, 0.8, 12);
          cyanRect(x + j * 4 - 3 + (i - 2.5) * 0.35, y + 1, 0.8, 12, s, 1, i + j);
        }
        text(l, x - 3, y + 21, 5.5, 700, '#555', 'center');
      });
    }],
    [3, 1, 0, y => text('3   Colour calibration', left, y + 8, 6.5, 700)],
    [3, 2, 2, (y, s) => {
      const bw = (span - 9) / 4;
      ['c', 'm', 'y', 'k'].forEach((cName, i) => {
        const x = left + i * (bw + 3);
        if (cName === 'c') cyanRect(x, y + 1, bw, 13, s, 1, i);
        else { pg.fillStyle = colour[cName]; pg.fillRect(x, y + 1, bw, 13); }
        text(cName.toUpperCase(), x + bw / 2, y + 21, 5.5, 700, '#555', 'center');
      });
    }],
    [3, 1, 2, (y, s) => {
      for (let i = 0; i < 10; i++) cyanRect(left + (i * span) / 10, y + 1, span / 10 - 1.5, 8, s, 0.1 + (0.9 * i) / 9, i);
    }],
    [3, 1, 2.5, (y, s) => cyanRect(left, y + 1, span, 8, s, 1, 3)],
    [3, 1, 2.5, (y, s) => {
      cyanRect(left, y + 1, span / 2 - 2, 8, s, 1, 5);
      pg.globalAlpha = 0.85;
      pg.fillStyle = colour.m;
      pg.fillRect(left, y + 1, span / 2 - 2, 8);
      pg.fillStyle = colour.y;
      pg.fillRect(left + span / 2 + 2, y + 1, span / 2 - 2, 8);
      pg.globalAlpha = 1;
      cyanRect(left + span / 2 + 2, y + 1, span / 2 - 2, 8, s, 0.8, 6);
    }],
    [3, 1, 0, y => text('Calibration complete. Keep this page for your records.', left, y + 8, 5.5, 500, '#555')],
  ];

  let step = -1;
  for (const [st, rows, units, paint] of bands) {
    if (st !== step) { step = st; onStep(step); }
    const strength = units ? take(units) : 1;
    await sweep(y => paint(y, strength), rows);
    // Out of cyan: a real printer stops right there, mid-page.
    if (units && level <= 0) { out = true; break; }
  }
  if (!out) onCyan(Math.round(level));
  onPhase('empty');
  return { stop: view.stop, used: cyan - level };
}
