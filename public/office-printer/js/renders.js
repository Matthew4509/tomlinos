// Everything the printers print or show: each entry draws into the chat (or over it) and returns when the chat may
// carry on. Some keep moving after they return (the queue, the pixel-by-pixel print); they stop when the beat or the
// run they belong to ends. The words on them come from script.json ("props"), so the jokes stay editable.
import { binaryLines } from './binary.js';
import { C, COMIC, FONT, MONO, docPage, drawFace, fileIcon, fitText, paper, reportPage, roundRect, scribbles, wrap } from './draw.js';
import { CELL_H, CELL_W, drawText, textWidth } from './dotfont.js';
import { colourOf } from './facts.js';
import { formatNumber, formatSeconds, workFor } from './engine.js';
import { buildTos, countWords } from './tos.js';

const TAU = Math.PI * 2;
const ease = t => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/** Runs `draw(t)` for t from 0 to 1 over `ms` (scaled by the game speed). False if the beat ended first. */
async function animate(r, ms, draw, signal = r.signal) {
  const total = Math.max(1, ms / r.speed);
  const start = performance.now();
  for (;;) {
    const now = await r.frame(signal);
    if (signal.aborted) return false;
    const t = Math.min(1, (now - start) / total);
    draw(t);
    if (t >= 1) return true;
  }
}

/** Calls `draw(seconds)` every frame until the signal aborts. Does not wait for it. */
function loop(r, draw, signal = r.signal, fps = 30) {
  const start = performance.now();
  let last = 0;
  void (async () => {
    while (!signal.aborted) {
      const now = await r.frame(signal);
      if (signal.aborted) return;
      if (now - last < 1000 / fps) continue;
      last = now;
      if (draw((now - start) / 1000) === false) return;
    }
  })();
}

/** A sheet of paper coming out of a slot: returns how far out it is (0 to 1) as the animation runs. */
async function slideOut(r, ms, draw) {
  r.sound.play('feed');
  return animate(r, r.reduced ? 1 : ms, t => draw(ease(t)));
}

function lcdPanel(g, x, y, w, h) {
  const body = g.createLinearGradient(0, y, 0, y + h);
  body.addColorStop(0, '#e4e6e9');
  body.addColorStop(1, '#bfc3c9');
  g.fillStyle = body;
  roundRect(g, x, y, w, h, 10);
  g.fill();
  g.strokeStyle = '#9ba1a9';
  g.lineWidth = 1;
  g.stroke();
}

function lcdScreen(g, x, y, w, h, on = true) {
  g.fillStyle = '#5f6b52';
  roundRect(g, x - 3, y - 3, w + 6, h + 6, 5);
  g.fill();
  g.fillStyle = on ? C.lcd : '#8fa376';
  roundRect(g, x, y, w, h, 3);
  g.fill();
}

/** One line of dot text on an LCD, scrolling sideways when it is too long to fit. */
function lcdLine(g, text, x, y, w, dot, shift = 0) {
  const width = textWidth(text, dot);
  g.save();
  g.beginPath();
  g.rect(x, y - 1, w, CELL_H * dot + 2);
  g.clip();
  g.fillStyle = C.lcdInk;
  const offset = width <= w ? (w - width) / 2 : -((shift * 30) % (width + 40)) + 10;
  drawText(g, text, x + offset, y, dot);
  if (width > w) drawText(g, text, x + offset + width + 40, y, dot);
  g.restore();
}

function stamp(g, text, x, y, colour, angle = -0.12, size = 18) {
  g.save();
  g.translate(x, y);
  g.rotate(angle);
  g.font = `800 ${size}px ${FONT}`;
  const w = g.measureText(text).width + 16;
  g.strokeStyle = colour;
  g.lineWidth = 2.5;
  roundRect(g, -w / 2, -size * 0.85, w, size * 1.5, 5);
  g.stroke();
  g.fillStyle = colour;
  g.textAlign = 'center';
  g.fillText(text, 0, size * 0.25);
  g.restore();
}

/** Draws the file being printed into a box: the picture itself, or its first page. */
function printedItem(g, r, x, y, w, h, family) {
  const facts = r.facts;
  if (facts.bitmap) {
    const scale = Math.min(w / facts.width, h / facts.height);
    const dw = facts.width * scale;
    const dh = facts.height * scale;
    g.drawImage(facts.bitmap, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  } else if (facts.kind === 'doc') {
    const doc = r.script.props.doc;
    const own = facts.sample !== 'minutes';
    docPage(g, x, y, w, h, own ? facts.name : doc.title, own ? ['(Reformatted by Home Inkjet.)'] : doc.lines, family ?? COMIC);
  } else if (facts.kind === 'pdf' && facts.sample === 'report') {
    reportPage(g, x, y + (h - w * 0.75) / 2, w, w * 0.75, r.script.props.report);
  } else {
    g.fillStyle = '#ffffff';
    g.fillRect(x, y, w, h);
    g.fillStyle = C.text;
    const size = fitText(g, facts.name, w * 0.84, Math.round(w * 0.08), '700');
    g.fillText(facts.name, x + w * 0.08, y + w * 0.08 + size);
    scribbles(g, x + w * 0.08, y + w * 0.2, w * 0.84, h * 0.7, 9);
  }
}

// ---- The LaserJet's screen --------------------------------------------------------------------------------------

function laserjetScreen(p, r) {
  const { canvas, g, w, h } = r.sheet(340, 132);
  const vars = r.vars();
  const copy = p.done ? String(r.script.linda.of) : p.later ? vars.copyLater : vars.copy;
  const job = vars.job.toUpperCase();
  const top = p.done ? 'DONE' : 'PRINTING';
  const bottom = `COPY ${copy} OF ${r.script.linda.of}`;
  r.figure(canvas, `The LaserJet's screen: ${top} ${job}, ${bottom}.`);
  const draw = s => {
    g.clearRect(0, 0, w, h);
    lcdPanel(g, 4, 4, w - 8, h - 8);
    lcdScreen(g, 22, 18, w - 44, 76);
    const blink = p.done || Math.floor(s * 2) % 2 === 0;
    if (blink) lcdLine(g, top, 26, 24, w - 52, 2);
    lcdLine(g, job, 26, 46, w - 52, 2, s);
    lcdLine(g, bottom, 26, 68, w - 52, 2);
    g.fillStyle = '#9aa0a8';
    roundRect(g, 22, 104, w - 110, 10, 5);
    g.fill();
    g.fillStyle = C.green;
    roundRect(g, 22, 104, (w - 110) * (p.done ? 1 : (s * 0.35) % 1), 10, 5);
    g.fill();
    g.fillStyle = p.done ? C.green : Math.floor(s * 3) % 2 ? '#f59e0b' : '#7a5a1a';
    g.beginPath();
    g.arc(w - 70, 109, 5, 0, TAU);
    g.fill();
    g.fillStyle = '#7a8089';
    g.beginPath();
    g.arc(w - 44, 109, 8, 0, TAU);
    g.fill();
  };
  draw(0);
  if (!r.reduced) loop(r, draw, r.signal, 20);
}

function lcd(p, r) {
  const { canvas, g, w, h } = r.sheet(320, 104);
  const text = r.fill(p.text);
  r.figure(canvas, `The printer's screen says: ${text}.`);
  const draw = s => {
    g.clearRect(0, 0, w, h);
    lcdPanel(g, 4, 4, w - 8, h - 8);
    lcdScreen(g, 22, 22, w - 44, 50);
    if (r.reduced || Math.floor(s * 1.6) % 2 === 0) lcdLine(g, text, 26, 38, w - 52, 2);
  };
  draw(0);
  if (!r.reduced) loop(r, draw, r.signal, 12);
}

// ---- The Inkjet's test page -----------------------------------------------------------------------------------

async function testPage(p, r) {
  const props = r.script.props.testPage;
  const { canvas, g, w, h } = r.sheet(320, 380);
  r.figure(canvas, `A test page: a cyan gradient, printed with the words "${props.caption}"`);
  const pageX = 60;
  const pageY = 78;
  const pageW = 200;
  const pageH = 282;
  const pageArt = () => {
    const grad = g.createLinearGradient(pageX, pageY, pageX + pageW, pageY + pageH);
    grad.addColorStop(0, '#e6fbff');
    grad.addColorStop(0.35, '#7fdcf5');
    grad.addColorStop(0.7, '#1ab4e3');
    grad.addColorStop(1, '#0077a8');
    g.fillStyle = grad;
    g.fillRect(pageX + 10, pageY + 10, pageW - 20, pageH - 60);
    g.save();
    g.beginPath();
    g.rect(pageX + 10, pageY + 10, pageW - 20, pageH - 60);
    g.clip();
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    g.lineWidth = 2;
    for (let i = 0; i < 6; i++) {
      g.beginPath();
      g.arc(pageX + pageW * 0.7, pageY + pageH * 0.2, 30 + i * 22, 0.4, 2.6);
      g.stroke();
    }
    g.restore();
    g.strokeStyle = C.black;
    g.lineWidth = 1;
    for (const [cx, cy] of [[pageX + 8, pageY + 8], [pageX + pageW - 8, pageY + 8]]) {
      g.beginPath();
      g.arc(cx, cy, 4, 0, TAU);
      g.moveTo(cx - 7, cy);
      g.lineTo(cx + 7, cy);
      g.moveTo(cx, cy - 7);
      g.lineTo(cx, cy + 7);
      g.stroke();
    }
    g.fillStyle = C.text;
    g.font = `600 12px ${FONT}`;
    const lines = wrap(g, props.caption, pageW - 24);
    lines.forEach((line, i) => g.fillText(line, pageX + 12, pageY + pageH - 34 + i * 15));
  };
  const draw = (pct, out) => {
    g.clearRect(0, 0, w, h);
    g.fillStyle = C.text;
    g.font = `600 13px ${FONT}`;
    g.fillText(`Printing test page... ${Math.floor(pct)}%`, 20, 26);
    g.fillStyle = C.lightGrey;
    roundRect(g, 20, 36, w - 40, 12, 6);
    g.fill();
    g.fillStyle = C.cyan;
    roundRect(g, 20, 36, (w - 40) * (pct / 100), 12, 6);
    g.fill();
    g.fillStyle = '#6b7280';
    g.fillRect(pageX - 14, pageY - 6, pageW + 28, 8);
    const shown = pageH * out;
    if (shown > 1) {
      g.save();
      g.beginPath();
      g.rect(pageX - 10, pageY, pageW + 20, shown + 10);
      g.clip();
      paper(g, pageX, pageY, pageW, pageH);
      pageArt();
      g.restore();
    }
  };
  draw(0, 0);
  r.sound.play('whir');
  let pct = 0;
  const to = async (target, ms) => {
    const from = pct;
    return animate(r, ms, t => {
      pct = from + (target - from) * t;
      draw(pct, (pct / 100) * 0.92);
    });
  };
  const [a, b, c] = props.steps;
  if (!(await to(a, 700))) return;
  await r.wait(350);
  if (!(await to(b, 900))) return;
  await r.wait(300);
  if (!(await to(c, 900))) return;
  r.worstMoment();
  await r.wait(props.freezeMs);
  if (r.signal.aborted) return;
  await to(100, 300);
  await animate(r, 500, t => draw(100, 0.92 + 0.08 * t));
}

function blankPage(p, r) {
  const { canvas, g, w, h } = r.sheet(220, 250);
  r.figure(canvas, 'One blank page, printed as an apology.');
  return slideOut(r, 800, t => {
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#6b7280';
    g.fillRect(20, 14, w - 40, 8);
    g.save();
    g.beginPath();
    g.rect(0, 20, w, h);
    g.clip();
    paper(g, 40, 20 - 210 + 210 * t, w - 80, 210);
    g.restore();
  });
}

// ---- The Photo Printer, one pixel at a time -----------------------------------------------------------------------

const COLS = 40;
const ROWS = 10;
const PX = 8;

/** The colours of a strip of the page being printed: the picture itself, or the report drawn at 4000 x 3000. */
function pixelSource(r) {
  const facts = r.facts;
  const [pw, ph] = r.script.props.pixels.report;
  const width = facts.bitmap ? facts.width : pw;
  const height = facts.bitmap ? facts.height : ph;
  const chunk = document.createElement('canvas');
  chunk.width = 256;
  chunk.height = ROWS;
  const cg = chunk.getContext('2d', { willReadFrequently: true });
  const cache = new Map();
  const strip = x0 => {
    if (!cache.has(x0)) {
      cg.clearRect(0, 0, 256, ROWS);
      if (facts.bitmap) {
        cg.drawImage(facts.bitmap, x0, 0, 256, ROWS, 0, 0, 256, ROWS);
      } else {
        cg.save();
        cg.translate(-x0, 0);
        reportPage(cg, 0, 0, pw, ph, r.script.props.report);
        cg.restore();
      }
      cache.set(x0, cg.getImageData(0, 0, 256, ROWS).data);
    }
    return cache.get(x0);
  };
  return {
    width,
    total: width * height,
    at(x, y) {
      if (x >= width || y >= height) return [255, 255, 255, 0];
      const x0 = Math.floor(x / 256) * 256;
      const d = strip(x0);
      const i = (y * 256 + (x - x0)) * 4;
      return [d[i], d[i + 1], d[i + 2], d[i + 3]];
    },
  };
}

function pixelPrint(p, r) {
  const props = r.script.props.pixels;
  const src = pixelSource(r);
  const { canvas, g, w, h } = r.sheet(340, 196);
  r.figure(canvas, `The Photo Printer prints ${r.facts.name} one pixel at a time: ${formatNumber(src.total)} pixels in all.`);
  let printed = 0;
  let stopped = null;
  const eta = r.vars().eta;
  const viewX = (w - COLS * PX) / 2;
  const viewY = 44;
  const draw = () => {
    g.clearRect(0, 0, w, h);
    g.fillStyle = C.text;
    g.font = `600 12px ${FONT}`;
    g.fillText(`Printing pixel ${formatNumber(Math.max(1, printed))} of ${formatNumber(src.total)}, page 1 of 1`, viewX, 18);
    g.fillStyle = C.grey;
    g.fillText(`Estimated completion: ${eta}`, viewX, 34);
    const head = Math.max(0, printed - 1);
    const hx = head % src.width;
    const hy = Math.floor(head / src.width);
    const x0 = Math.floor(hx / COLS) * COLS;
    g.fillStyle = '#ffffff';
    g.fillRect(viewX, viewY, COLS * PX, ROWS * PX);
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const x = x0 + col;
        const y = row;
        const index = y * src.width + x;
        if (index < printed) {
          const [cr, cgc, cb, ca] = src.at(x, y);
          g.fillStyle = ca < 128 ? '#ffffff' : `rgb(${cr},${cgc},${cb})`;
          g.fillRect(viewX + col * PX, viewY + row * PX, PX, PX);
        } else {
          g.fillStyle = '#e9ecf1';
          g.fillRect(viewX + col * PX + 0.5, viewY + row * PX + 0.5, PX - 1, PX - 1);
        }
      }
    }
    if (hy < ROWS) {
      const col = hx - x0;
      g.strokeStyle = stopped ? C.red : C.navy;
      g.lineWidth = 2;
      if (stopped) {
        g.beginPath();
        g.arc(viewX + col * PX + PX / 2, viewY + hy * PX + PX / 2, PX * 1.4, 0, TAU);
        g.stroke();
      } else {
        g.strokeRect(viewX + col * PX - 1, viewY + hy * PX - 1, PX + 2, PX + 2);
      }
    }
    g.fillStyle = C.lightGrey;
    roundRect(g, viewX, viewY + ROWS * PX + 16, COLS * PX, 8, 4);
    g.fill();
    g.fillStyle = C.navy;
    roundRect(g, viewX, viewY + ROWS * PX + 16, Math.max(3, COLS * PX * (printed / src.total)), 8, 4);
    g.fill();
    g.fillStyle = C.grey;
    g.font = `500 12px ${FONT}`;
    g.fillText(`${((printed / src.total) * 100).toFixed(4)}% done`, viewX, viewY + ROWS * PX + 44);
    if (stopped) {
      g.fillStyle = C.red;
      g.font = `700 12px ${FONT}`;
      g.fillText(`Stopped at pixel ${formatNumber(printed)}: cyan.`, viewX + 150, viewY + ROWS * PX + 44);
    }
  };
  draw();
  const rateAt = t => {
    const slow = props.slowUntil / 3;
    if (t < slow) return 3;
    return Math.min(45, 3 + (42 * (t - slow)) / 8);
  };
  void (async () => {
    await r.stepsDone;
    if (r.signal.aborted) return;
    let t = 0;
    let last = performance.now();
    let target = 0;
    let pepped = false;
    while (!r.signal.aborted && !stopped) {
      const now = await r.frame();
      if (r.signal.aborted) return;
      const dt = Math.min(0.25, (now - last) / 1000) * r.speed;
      last = now;
      t += dt;
      target = Math.min(src.total, target + rateAt(t) * dt);
      while (printed < Math.floor(target) && printed < src.total) {
        const x = printed % src.width;
        const y = Math.floor(printed / src.width);
        printed++;
        r.run.pixel = printed;
        const [cr, cgc, cb, ca] = src.at(x, y);
        if (colourOf(cr, cgc, cb, ca) === 'cyan') {
          stopped = { x, y };
          break;
        }
      }
      draw();
      if (stopped) {
        r.sound.play('glug');
        await r.say(p.cyan);
        return;
      }
      if (!pepped && printed >= props.pepAt) {
        pepped = true;
        r.worstMoment();
        void r.say(p.pep);
      }
    }
  })();
}

async function pixelFast(p, r) {
  const total = r.facts.pixels ?? r.script.props.pixels.report[0] * r.script.props.pixels.report[1];
  const from = r.run.pixel ?? 1;
  const { canvas, g, w, h } = r.sheet(340, 96);
  r.figure(canvas, `The print speeds up: pixel ${formatNumber(total)} of ${formatNumber(total)}, page 1 of 1.`);
  r.sound.play('whir');
  await animate(r, 2600, t => {
    const n = Math.round(from + (total - from) * t ** 3);
    g.clearRect(0, 0, w, h);
    g.fillStyle = C.text;
    g.font = `600 13px ${FONT}`;
    g.fillText(t < 1 ? 'Speeding up...' : 'Done.', 16, 24);
    g.font = `700 16px ${MONO}`;
    g.fillText(`Pixel ${formatNumber(n)} of ${formatNumber(total)}`, 16, 50);
    g.fillStyle = C.lightGrey;
    roundRect(g, 16, 64, w - 32, 10, 5);
    g.fill();
    g.fillStyle = C.navy;
    roundRect(g, 16, 64, (w - 32) * (n / total), 10, 5);
    g.fill();
  });
}

function iconPrintout(p, r) {
  const { canvas, g, w, h } = r.sheet(300, 370);
  r.figure(canvas, `A glossy photo print of the file icon and the name "${r.facts.name}". Nothing else.`);
  const pageW = 210;
  const pageH = 290;
  return slideOut(r, 1000, t => {
    g.clearRect(0, 0, w, h);
    g.save();
    g.translate(w / 2, 30 + pageH / 2 + (1 - t) * -pageH);
    g.rotate(-0.035);
    paper(g, -pageW / 2, -pageH / 2, pageW, pageH, '#ffffff');
    const sheen = g.createLinearGradient(-pageW / 2, -pageH / 2, pageW / 2, pageH / 2);
    sheen.addColorStop(0, 'rgba(255,255,255,0)');
    sheen.addColorStop(0.45, 'rgba(210,225,245,0.35)');
    sheen.addColorStop(0.55, 'rgba(255,255,255,0)');
    g.fillStyle = sheen;
    g.fillRect(-pageW / 2, -pageH / 2, pageW, pageH);
    fileIcon(g, r.facts.kind, -44, -90, 112, r.facts.ext);
    g.fillStyle = C.text;
    const size = fitText(g, r.facts.name, pageW - 30, 15, '600');
    g.textAlign = 'center';
    g.fillText(r.facts.name, 0, 70 + size);
    g.textAlign = 'left';
    g.restore();
  });
}

// ---- The Dot Matrix -----------------------------------------------------------------------------------------------

const DM_COLS = 32;

function dmLines(p, r) {
  const props = r.script.props;
  if (p.mode === 'binary') {
    const header = r.fill(p.header ?? '{FILE}').toUpperCase().slice(0, DM_COLS);
    return [header, '', ...binaryLines(p.message, 3), '', 'END OF PRINTOUT.'];
  }
  if (p.mode === 'text') {
    const doc = props[p.doc];
    const out = [doc.file, ''];
    for (const line of doc.lines) {
      let rest = line.toUpperCase();
      while (rest.length > DM_COLS) {
        const cut = rest.lastIndexOf(' ', DM_COLS);
        const at = cut > 0 ? cut : DM_COLS;
        out.push(rest.slice(0, at));
        rest = rest.slice(at).trimStart();
      }
      out.push(rest);
    }
    return out;
  }
  const sheet = props.sheet;
  const name = r.facts.name.toUpperCase().slice(0, DM_COLS);
  const out = [name, ''];
  const letter = n => (n <= 26 ? String.fromCharCode(64 + n) : String.fromCharCode(64 + Math.floor((n - 1) / 26)) + String.fromCharCode(65 + ((n - 1) % 26)));
  for (const n of [1, 2]) {
    out.push(`PAGE ${n} OF ${sheet.pages}`, r.fill(sheet.column, { n: letter(n) }).toUpperCase());
    for (let i = 0; i < 5; i++) out.push(n === 1 ? ['PAPER', 'TONER', 'CYAN', 'MORE CYAN', "LINDA'S CARD"][i] : String(1200 + ((i * 377) % 900)));
    out.push('- - - - - - - - - - - - - - - -');
  }
  out.push(`... ${sheet.pages - 3} MORE PAGES ...`, '- - - - - - - - - - - - - - - -');
  out.push(`PAGE ${sheet.pages} OF ${sheet.pages}`, r.fill(sheet.column, { n: letter(sheet.pages) }).toUpperCase(), '(EMPTY)');
  return out;
}

async function dotMatrix(p, r) {
  const lines = dmLines(p, r);
  const dot = 1.48;
  const lineH = CELL_H * dot + 5;
  const margin = 28;
  const w = 340;
  const topPad = 18;
  const h = Math.round(topPad + lines.length * lineH + 40);
  const { canvas, g } = r.sheet(w, h);
  r.figure(canvas, `The Dot Matrix prints on green-bar paper:\n${lines.join('\n')}`, { pre: true });
  const band = lineH * 3;
  const drawPaper = (bottom, torn) => {
    g.clearRect(0, 0, w, h);
    g.save();
    g.beginPath();
    if (torn) {
      g.moveTo(0, 0);
      g.lineTo(w, 0);
      g.lineTo(w, bottom - 14);
      for (let x = w; x >= 0; x -= 8) g.lineTo(x, bottom - 14 + ((w - x) / w) * 18 + (x % 16 === 0 ? 2 : -1));
      g.closePath();
    } else {
      g.rect(0, 0, w, bottom);
    }
    g.clip();
    g.fillStyle = '#fbfdf8';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#dcefd3';
    for (let y = topPad - 4; y < h; y += band * 2) g.fillRect(margin - 6, y, w - (margin - 6) * 2, band);
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, margin - 8, h);
    g.fillRect(w - margin + 8, 0, margin - 8, h);
    g.strokeStyle = '#c8d6c1';
    g.setLineDash([2, 3]);
    g.beginPath();
    g.moveTo(margin - 8, 0);
    g.lineTo(margin - 8, h);
    g.moveTo(w - margin + 8, 0);
    g.lineTo(w - margin + 8, h);
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = '#e9ece4';
    g.strokeStyle = '#b9c2b1';
    for (let y = 8; y < h; y += 14) {
      for (const x of [10, w - 10]) {
        g.beginPath();
        g.arc(x, y, 3.2, 0, TAU);
        g.fill();
        g.stroke();
      }
    }
    g.restore();
  };
  const printedText = [];
  const drawText2 = () => {
    g.fillStyle = '#2b2b2e';
    printedText.forEach((line, i) => {
      for (let c = 0; c < line.length; c++) {
        drawText(g, line[c], margin + 4 + c * CELL_W * dot, topPad + i * lineH, dot);
      }
    });
  };
  drawPaper(h, false);
  let chars = 0;
  for (let i = 0; i < lines.length; i++) {
    printedText.push('');
    const line = lines[i];
    for (let c = 0; c < line.length; c++) {
      if (r.signal.aborted) return;
      printedText[i] += line[c];
      g.fillStyle = '#2b2b2e';
      drawText(g, line[c], margin + 4 + c * CELL_W * dot, topPad + i * lineH, dot, 0.35);
      if (line[c] !== ' ' && chars++ % 2 === 0) r.sound.play('screech');
      const stutter = chars % (7 + (i % 4)) === 0 ? 90 + Math.random() * 90 : 0;
      await r.wait(r.reduced ? 1 : 16 + Math.random() * 14 + stutter);
    }
    await r.wait(r.reduced ? 1 : line ? 200 : 90);
  }
  if (r.signal.aborted) return;
  r.worstMoment();
  await r.wait(400);
  r.sound.play('rip');
  await animate(r, 500, t => {
    drawPaper(h, t > 0.5);
    drawText2();
  });
}

// ---- The LaserJet's queue, warranty and paper jam ------------------------------------------------------------------

function queue(p, r) {
  const props = r.script.props.queue;
  const { canvas, g, w, h } = r.sheet(320, 112);
  r.run.queue ??= props.start;
  const fig = r.figure(canvas, `${props.label} ${formatNumber(r.run.queue)}. ETA: ${props.eta}.`);
  let note = '';
  const draw = () => {
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#f7f8fa';
    roundRect(g, 2, 2, w - 4, h - 4, 10);
    g.fill();
    g.strokeStyle = '#cfd4dc';
    g.stroke();
    g.fillStyle = C.text;
    g.font = `500 13px ${FONT}`;
    g.fillText(props.label, 18, 26);
    g.font = `700 30px ${MONO}`;
    g.fillText(formatNumber(r.run.queue), 18, 62);
    g.font = `500 13px ${FONT}`;
    g.fillStyle = C.grey;
    g.fillText(`ETA: ${props.eta}`, 18, 88);
    if (note) {
      g.fillStyle = C.red;
      g.fillText(note, 120, 88);
    }
  };
  draw();
  let next = performance.now() + 1000;
  loop(r, () => {
    const now = performance.now();
    if (now < next) return;
    next = now + (700 + Math.random() * 700) / r.speed;
    if (Math.random() < 0.1) {
      r.run.queue += 1 + Math.floor(Math.random() * 3);
      note = '(Linda added a copy)';
    } else {
      r.run.queue -= 1;
      note = '';
    }
    draw();
    fig.querySelector('figcaption').textContent = `${props.label} ${formatNumber(r.run.queue)}. ETA: ${props.eta}.`;
  }, r.runSignal, 10);
}

function warranty(p, r) {
  const wr = r.script.warranty;
  const { canvas, g, w, h } = r.sheet(320, 190);
  r.figure(canvas, `${wr.title}: ${wr.price}. Covers ${wr.covers}.`);
  const card = g.createLinearGradient(0, 0, w, h);
  card.addColorStop(0, '#fff7da');
  card.addColorStop(1, '#f3d98a');
  g.fillStyle = card;
  roundRect(g, 4, 4, w - 8, h - 8, 14);
  g.fill();
  g.strokeStyle = '#c49a2a';
  g.lineWidth = 2;
  g.stroke();
  g.fillStyle = '#7a5a10';
  g.font = `800 15px ${FONT}`;
  g.fillText(wr.title.toUpperCase(), 22, 34);
  g.fillStyle = C.text;
  g.font = `800 40px ${FONT}`;
  g.fillText(wr.price, 22, 82);
  g.font = `600 15px ${FONT}`;
  g.fillText('Covers everything*', 22, 108);
  g.fillStyle = '#6b5a2a';
  g.font = `500 12px ${FONT}`;
  wrap(g, `*except ${wr.covers.replace(/^everything except /, '')}.`, w - 44).forEach((line, i) => g.fillText(line, 22, 134 + i * 16));
  g.fillStyle = '#c49a2a';
  g.beginPath();
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * TAU;
    const rad = i % 2 ? 26 : 32;
    g.lineTo(w - 58 + Math.cos(a) * rad, 62 + Math.sin(a) * rad);
  }
  g.closePath();
  g.fill();
  g.fillStyle = '#fff7da';
  g.font = `800 12px ${FONT}`;
  g.textAlign = 'center';
  g.fillText('BEST', w - 58, 60);
  g.fillText('VALUE', w - 58, 74);
  g.textAlign = 'left';
}

function jam(p, r) {
  const { canvas, g, w, h } = r.sheet(300, 270);
  canvas.classList.add('op-drag');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'op-btn';
  button.textContent = 'Pull the paper';
  const fig = r.figure(canvas, 'Paper jam. Pull the paper out: it rips, every time.', { extra: button });
  void fig;
  const slotY = 96;
  const sheetW = 150;
  let stub = 120;
  let pull = 0;
  let rips = 0;
  let falling = null;
  let busy = false;
  const draw = () => {
    g.clearRect(0, 0, w, h);
    const body = g.createLinearGradient(0, 0, 0, slotY);
    body.addColorStop(0, '#e7e9ec');
    body.addColorStop(1, '#b9bec6');
    g.fillStyle = body;
    roundRect(g, 20, 8, w - 40, slotY - 4, 12);
    g.fill();
    lcdScreen(g, 40, 22, 120, 30, true);
    lcdLine(g, rips >= 3 ? 'PAPER JAM' : 'PAPER JAM', 44, 30, 112, 1.6);
    g.fillStyle = C.red;
    g.beginPath();
    g.arc(w - 60, 38, 6, 0, TAU);
    g.fill();
    g.fillStyle = '#3b3f46';
    g.fillRect(w / 2 - sheetW / 2 - 10, slotY - 6, sheetW + 20, 8);
    const len = stub + pull;
    g.save();
    paper(g, w / 2 - sheetW / 2, slotY, sheetW, len);
    g.fillStyle = '#c9cdd4';
    for (let i = 0; i < Math.floor(len / 14); i++) g.fillRect(w / 2 - sheetW / 2 + 14, slotY + 14 + i * 14, sheetW - 28, 3);
    g.restore();
    if (falling) {
      g.save();
      g.translate(falling.x, falling.y);
      g.rotate(falling.a);
      g.fillStyle = C.paper;
      g.strokeStyle = C.paperEdge;
      g.beginPath();
      g.moveTo(-sheetW / 2, 0);
      for (let x = -sheetW / 2; x <= sheetW / 2; x += 10) g.lineTo(x, (x / 10) % 2 ? -4 : 3);
      g.lineTo(sheetW / 2, falling.len);
      g.lineTo(-sheetW / 2, falling.len);
      g.closePath();
      g.fill();
      g.stroke();
      g.restore();
    }
    g.fillStyle = C.text;
    g.font = `600 13px ${FONT}`;
    g.textAlign = 'center';
    g.fillText(rips ? `Ripped. ${rips === 1 ? 'Again?' : 'Again.'}` : 'Paper jam. Please remove the paper.', w / 2, h - 10);
    g.textAlign = 'left';
  };
  draw();
  return new Promise(resolve => {
    const rip = async () => {
      busy = true;
      r.sound.play('rip');
      rips++;
      const tornLen = stub + pull - 30;
      falling = { x: w / 2, y: slotY + 30, a: 0, len: tornLen };
      stub = 30 + Math.max(0, 60 - rips * 18);
      pull = 0;
      await animate(r, 700, t => {
        falling.y = slotY + 30 + t * t * 160;
        falling.a = t * 0.5;
        draw();
      }, r.runSignal);
      falling = null;
      stub = Math.max(24, stub);
      draw();
      busy = false;
      if (rips >= 3) {
        button.disabled = true;
        resolve();
      }
    };
    let startY = null;
    canvas.addEventListener('pointerdown', event => {
      if (busy || rips >= 3) return;
      startY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
    }, { signal: r.signal });
    canvas.addEventListener('pointermove', event => {
      if (startY === null || busy) return;
      const scale = w / canvas.getBoundingClientRect().width;
      pull = Math.max(0, Math.min(90, (event.clientY - startY) * scale));
      draw();
      if (pull >= 72) {
        startY = null;
        void rip();
      }
    }, { signal: r.signal });
    const end = () => {
      if (startY === null) return;
      startY = null;
      if (!busy) {
        pull = 0;
        draw();
      }
    };
    canvas.addEventListener('pointerup', end, { signal: r.signal });
    canvas.addEventListener('pointercancel', end, { signal: r.signal });
    button.addEventListener('click', async () => {
      if (busy || rips >= 3) return;
      busy = true;
      await animate(r, 500, t => {
        pull = 76 * ease(t);
        draw();
      }, r.runSignal);
      void rip();
    }, { signal: r.signal });
    r.signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

function doubleSided(p, r) {
  const { canvas, g, w, h } = r.sheet(260, 320);
  r.figure(canvas, 'Double-sided: both sides printed onto the same side.');
  return slideOut(r, 900, t => {
    g.clearRect(0, 0, w, h);
    g.save();
    g.translate(0, (1 - t) * -280);
    paper(g, 30, 20, 200, 280, '#ffffff');
    printedItem(g, r, 44, 36, 172, 240);
    g.globalAlpha = 0.55;
    g.translate(30 + 200 + 14, 44);
    g.scale(-1, 1);
    printedItem(g, r, 0, 0, 172, 240);
    g.restore();
    g.fillStyle = C.grey;
    g.font = `600 12px ${FONT}`;
    g.fillText('Side 1 + Side 2', 36, h - 6);
  });
}

async function blankStack(p, r) {
  const count = p.count ?? 400;
  const { canvas, g, w, h } = r.sheet(320, 230);
  r.figure(canvas, `${count} blank pages, printed for the environment.`);
  await animate(r, 3200, t => {
    const n = Math.max(1, Math.round(count * t));
    if (n % 8 === 0) r.sound.play('feed');
    g.clearRect(0, 0, w, h);
    const layers = Math.min(40, Math.round(n / 10));
    for (let i = 0; i < layers; i++) {
      g.fillStyle = i % 2 ? '#fbfaf6' : '#f1eee6';
      g.fillRect(70 + (i % 3) - 1, 190 - i * 3, 180, 4);
    }
    g.strokeStyle = C.paperEdge;
    g.strokeRect(70.5, 190.5 - layers * 3, 180, layers * 3 + 3);
    if (t < 1) {
      const fly = (t * 40) % 1;
      g.save();
      g.translate(160, 40 + fly * 120);
      g.rotate((fly - 0.5) * 0.6);
      paper(g, -60, -30, 120, 60);
      g.restore();
    }
    g.fillStyle = C.text;
    g.font = `700 16px ${FONT}`;
    g.fillText(`Page ${formatNumber(n)} of ${formatNumber(count)}`, 20, 26);
  });
}

// ---- The network ---------------------------------------------------------------------------------------------------

async function network(p, r) {
  const props = r.script.props.network;
  const { canvas, g, w, h } = r.sheet(340, 262);
  const ring = ['inkjet', 'photo', 'dotmatrix', 'laserjet', 'canon'];
  const missing = { inkjet: 'no C', photo: 'no M', dotmatrix: 'no Y', laserjet: 'no K', canon: 'no paper' };
  const cx = w / 2;
  const cy = 128;
  const spots = ring.map((id, i) => {
    const a = -Math.PI / 2 + (i / ring.length) * TAU;
    return { id, x: cx + Math.cos(a) * 118, y: cy + Math.sin(a) * 92 };
  });
  const names = r.script.speakers;
  const caption = p.infamous
    ? `Every machine on the network shows "${props.infamous}".`
    : p.loop
      ? 'The network goes round: out of cyan, out of magenta, out of yellow, out of black, out of paper, and back to the start.'
      : `The office network: ${ring.map(id => names[id].name).join(', ')}, and ${props.others.map(o => o.name).join(' and ')}.`;
  r.figure(canvas, caption);
  const draw = (t, packet) => {
    g.clearRect(0, 0, w, h);
    g.strokeStyle = '#c6cdd8';
    g.lineWidth = 2;
    g.beginPath();
    spots.forEach((s, i) => {
      if (i === 0) g.moveTo(s.x, s.y);
      else g.lineTo(s.x, s.y);
    });
    g.closePath();
    g.stroke();
    g.fillStyle = '#eef1f5';
    roundRect(g, cx - 52, cy - 24, 104, 48, 8);
    g.fill();
    props.others.forEach((o, i) => drawFace(g, o.id, cx - 46 + i * 50, cy - 20, 32));
    if (!p.infamous && !p.loop && t < 1) {
      g.strokeStyle = `rgba(63,127,216,${0.5 * (1 - t)})`;
      g.lineWidth = 3;
      g.beginPath();
      g.arc(cx, cy, 20 + t * 160, 0, TAU);
      g.stroke();
    }
    spots.forEach((s, i) => {
      const shown = p.infamous || p.loop || t > i / ring.length;
      if (!shown) return;
      const here = s.id === r.run.at;
      g.fillStyle = here ? '#dbe8ff' : '#ffffff';
      roundRect(g, s.x - 40, s.y - 30, 80, 60, 8);
      g.fill();
      g.strokeStyle = here ? '#3f7fd8' : '#cfd6e0';
      g.lineWidth = here ? 2 : 1;
      g.stroke();
      drawFace(g, s.id, s.x - 14, s.y - 29, 28);
      g.fillStyle = C.text;
      g.font = `600 11px ${FONT}`;
      g.textAlign = 'center';
      g.fillText(names[s.id].name, s.x, s.y + 11);
      let status = 'READY';
      if (p.infamous) status = t > i / ring.length ? props.infamous : '';
      else if (p.loop) status = missing[s.id].toUpperCase();
      g.fillStyle = C.lcd;
      roundRect(g, s.x - 36, s.y + 15, 72, 12, 2);
      g.fill();
      g.fillStyle = C.lcdInk;
      g.font = `700 9px ${MONO}`;
      g.fillText(status, s.x, s.y + 24.5);
      g.textAlign = 'left';
    });
    if (packet) {
      g.fillStyle = C.cyan;
      g.beginPath();
      g.arc(packet.x, packet.y, 6, 0, TAU);
      g.fill();
    }
    if (p.loop) {
      g.fillStyle = C.red;
      g.font = `800 12px ${FONT}`;
      g.textAlign = 'center';
      g.fillText(props.loop, cx, h - 8);
      g.textAlign = 'left';
    }
  };
  if (p.loop) {
    const at = u => {
      const f = (u % 1) * spots.length;
      const i = Math.floor(f);
      const a = spots[i];
      const b = spots[(i + 1) % spots.length];
      const k = f - i;
      return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
    };
    await animate(r, 3600, t => draw(1, at(t * 1.6)));
    if (!r.reduced) loop(r, s => draw(1, at(1.6 + s * 0.45)), r.signal, 30);
    return;
  }
  await animate(r, p.infamous ? 2600 : 1800, t => draw(t, null));
}

// ---- The Photo Printer's firmware and art --------------------------------------------------------------------------

function firmware(p, r) {
  const props = r.script.props.firmware;
  const { canvas, g, w, h } = r.sheet(320, 118);
  r.figure(canvas, `Firmware update ${props.version}. Estimated time: ${props.eta}. Do not turn off the printer.`);
  let warned = false;
  const draw = s => {
    const pct = Math.min(2.4, s * 0.12);
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#20242b';
    roundRect(g, 2, 2, w - 4, h - 4, 10);
    g.fill();
    g.fillStyle = '#e8ebf0';
    g.font = `600 13px ${FONT}`;
    g.fillText(`Firmware update ${props.version}`, 18, 28);
    g.fillStyle = '#3a404a';
    roundRect(g, 18, 42, w - 36, 12, 6);
    g.fill();
    g.fillStyle = '#5ab0ff';
    roundRect(g, 18, 42, Math.max(6, (w - 36) * (pct / 100)), 12, 6);
    g.fill();
    g.fillStyle = '#b8c0cc';
    g.font = `500 12px ${FONT}`;
    g.fillText(`${pct.toFixed(1)}% · Estimated time: ${props.eta}`, 18, 76);
    g.fillText('Do not turn off the printer.', 18, 96);
    if (!warned && s > 2.5) {
      warned = true;
      r.worstMoment();
    }
  };
  draw(0);
  loop(r, s => draw(s * r.speed), r.signal, 15);
}

async function timeSkip(p, r) {
  const { canvas, g, w, h } = r.sheet(320, 150);
  const text = r.fill(p.text);
  r.figure(canvas, text);
  await animate(r, 1900, t => {
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#3a2a6b';
    roundRect(g, 2, 2, w - 4, h - 4, 12);
    g.fill();
    const cx = 64;
    const cy = h / 2;
    g.fillStyle = '#fffbe8';
    g.beginPath();
    g.arc(cx, cy, 38, 0, TAU);
    g.fill();
    g.strokeStyle = '#3a2a6b';
    g.lineWidth = 3;
    g.lineCap = 'round';
    const a = t * TAU * 8;
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(cx + Math.cos(a) * 28, cy + Math.sin(a) * 28);
    g.moveTo(cx, cy);
    g.lineTo(cx + Math.cos(a / 12) * 18, cy + Math.sin(a / 12) * 18);
    g.stroke();
    g.fillStyle = '#ffd84a';
    g.font = `800 24px ${COMIC}`;
    const lines = wrap(g, text, w - 130);
    lines.forEach((line, i) => g.fillText(line, 118, cy - (lines.length - 1) * 14 + i * 28 + 8));
  });
}

function artCritic(p, r) {
  const props = r.script.props.artCritic;
  const { canvas, g, w, h } = r.sheet(280, 320);
  r.figure(canvas, `A framed test page of a sunset: ${props.caption}`);
  g.fillStyle = '#b8860b';
  g.fillRect(30, 10, w - 60, 240);
  g.fillStyle = '#e2b84a';
  g.fillRect(38, 18, w - 76, 224);
  const sky = g.createLinearGradient(0, 30, 0, 230);
  sky.addColorStop(0, '#3d1466');
  sky.addColorStop(0.35, '#d6007e');
  sky.addColorStop(0.6, '#ff7a2f');
  sky.addColorStop(0.8, '#ffd23f');
  sky.addColorStop(1, '#ffe89a');
  g.fillStyle = sky;
  g.fillRect(48, 28, w - 96, 204);
  g.fillStyle = 'rgba(255, 240, 180, 0.95)';
  g.beginPath();
  g.arc(w / 2, 170, 34, Math.PI, 0);
  g.fill();
  g.fillStyle = '#2a1650';
  for (let i = 0; i < 5; i++) g.fillRect(48, 176 + i * 12, w - 96, 5);
  g.fillStyle = '#f6f1e3';
  g.fillRect(70, 266, w - 140, 38);
  g.strokeStyle = '#cfc6b0';
  g.strokeRect(70.5, 266.5, w - 141, 37);
  g.fillStyle = C.text;
  g.font = `italic 500 12px ${FONT}`;
  wrap(g, props.caption, w - 156).forEach((line, i) => g.fillText(line, 78, 282 + i * 14));
}

// ---- Strike, fridge, love, Linda's card ----------------------------------------------------------------------------

async function strike(p, r) {
  const signs = r.script.props.strike.signs;
  const { canvas, g, w, h } = r.sheet(340, 230);
  r.figure(canvas, `On strike: the printers, the scanner and the fax machine, with signs saying ${signs.map(s => `"${s}"`).join(', ')}.`);
  const who = ['laserjet', 'fax', 'scanner', 'dotmatrix'];
  const draw = s => {
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#eef0f3';
    g.fillRect(0, 186, w, 44);
    who.forEach((id, i) => {
      const x = 20 + i * 80;
      const bob = Math.sin(s * 5 + i) * 4;
      g.strokeStyle = '#8a6d3b';
      g.lineWidth = 4;
      g.beginPath();
      g.moveTo(x + 34, 70 + bob);
      g.lineTo(x + 34, 150 + bob);
      g.stroke();
      g.fillStyle = '#fffdf2';
      g.strokeStyle = '#2a2d33';
      g.lineWidth = 1.5;
      roundRect(g, x, 12 + bob, 72, 62, 4);
      g.fill();
      g.stroke();
      g.fillStyle = C.red;
      g.font = `800 11px ${FONT}`;
      g.textAlign = 'center';
      const lines = wrap(g, signs[i % signs.length], 64);
      lines.forEach((line, j) => g.fillText(line, x + 36, 32 + bob + j * 13));
      g.textAlign = 'left';
      drawFace(g, id, x + 10, 136 + bob * 0.5, 52);
    });
  };
  draw(0);
  await animate(r, 1600, t => draw(t * 1.6));
  if (!r.reduced) loop(r, s => draw(1.6 + s), r.signal, 24);
}

async function fridge(p, r) {
  const props = r.script.props.fridge;
  const { canvas, g, w, h } = r.sheet(320, 390);
  r.figure(canvas, `Your print on the fridge, held by a magnet, slightly crooked, next to a crayon drawing and a pizza menu.`);
  const drawFridge = () => {
    g.clearRect(0, 0, w, h);
    const body = g.createLinearGradient(20, 0, w - 20, 0);
    body.addColorStop(0, '#e9e4d8');
    body.addColorStop(0.5, '#f8f5ee');
    body.addColorStop(1, '#ddd7c9');
    g.fillStyle = body;
    roundRect(g, 20, 8, w - 40, h - 16, 18);
    g.fill();
    g.strokeStyle = '#bdb6a6';
    g.lineWidth = 1.5;
    g.stroke();
    g.beginPath();
    g.moveTo(22, 112);
    g.lineTo(w - 22, 112);
    g.stroke();
    g.fillStyle = '#a9a394';
    roundRect(g, w - 44, 40, 8, 50, 4);
    g.fill();
    roundRect(g, w - 44, 140, 8, 90, 4);
    g.fill();
    g.save();
    g.translate(60, 40);
    g.rotate(0.07);
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, 90, 64);
    g.lineWidth = 2.5;
    g.lineCap = 'round';
    g.strokeStyle = '#e25b3a';
    g.beginPath();
    g.moveTo(18, 54);
    g.lineTo(18, 34);
    g.lineTo(34, 20);
    g.lineTo(50, 34);
    g.lineTo(50, 54);
    g.closePath();
    g.stroke();
    g.strokeStyle = '#f5b400';
    g.beginPath();
    g.arc(72, 16, 8, 0, TAU);
    g.stroke();
    g.strokeStyle = '#3a7bd5';
    g.beginPath();
    g.moveTo(64, 56);
    g.lineTo(64, 40);
    g.moveTo(58, 46);
    g.lineTo(70, 46);
    g.stroke();
    g.fillStyle = '#6b6b6b';
    g.font = `500 9px ${COMIC}`;
    g.fillText(props.drawing, 4, 62 + 10);
    g.restore();
    g.save();
    g.translate(w - 130, 262);
    g.rotate(-0.05);
    g.fillStyle = '#fff4e6';
    g.fillRect(0, 0, 84, 104);
    g.fillStyle = '#c8321f';
    g.fillRect(0, 0, 84, 22);
    g.fillStyle = '#ffffff';
    g.font = `800 13px ${FONT}`;
    g.fillText(props.menu, 8, 16);
    g.fillStyle = C.text;
    g.font = `500 9px ${FONT}`;
    props.menuLines.forEach((line, i) => g.fillText(line, 6, 38 + i * 14));
    g.restore();
  };
  const pw = 124;
  const ph = r.facts.bitmap ? Math.max(70, Math.min(160, pw * (r.facts.height / r.facts.width))) : 160;
  await animate(r, r.reduced ? 1 : 900, t => {
    drawFridge();
    const e = ease(t);
    g.save();
    g.translate(118 + pw / 2, 132 - (1 - e) * 120);
    g.rotate(-0.09 + Math.sin(t * 9) * 0.05 * (1 - t));
    paper(g, -pw / 2 - 6, -6, pw + 12, ph + 12, '#ffffff');
    printedItem(g, r, -pw / 2, 0, pw, ph);
    g.restore();
    g.save();
    g.translate(118 + pw / 2, 132 - (1 - e) * 120);
    const mag = g.createRadialGradient(-3, -4, 1, 0, 0, 12);
    mag.addColorStop(0, '#ff8a80');
    mag.addColorStop(1, '#c62828');
    g.fillStyle = mag;
    g.beginPath();
    g.arc(0, 2, 11, 0, TAU);
    g.fill();
    g.restore();
  });
}

function loveLetter(p, r) {
  const props = r.script.props.loveLetter;
  const { canvas, g, w, h } = r.sheet(260, 320);
  const lines = props.lines.map(line => r.fill(line));
  r.figure(canvas, `A love letter: ${lines.join(' ')}`);
  return slideOut(r, 1000, t => {
    g.clearRect(0, 0, w, h);
    g.save();
    g.translate(0, (1 - t) * -300);
    paper(g, 30, 10, 200, 290, '#fff0f5');
    g.fillStyle = '#e8487a';
    g.beginPath();
    const hx = w / 2;
    const hy = 90;
    g.moveTo(hx, hy + 50);
    g.bezierCurveTo(hx - 80, hy - 5, hx - 38, hy - 58, hx, hy - 18);
    g.bezierCurveTo(hx + 38, hy - 58, hx + 80, hy - 5, hx, hy + 50);
    g.fill();
    g.fillStyle = '#7a2140';
    g.font = `500 15px ${COMIC}`;
    lines.forEach((line, i) => {
      wrap(g, line, 170).forEach((part, j) => g.fillText(part, 45, 180 + i * 34 + j * 18));
    });
    g.restore();
  });
}

function wrongDocument(p, r) {
  const props = r.script.props.wrongDocument;
  const { canvas, g, w, h } = r.sheet(280, 370);
  r.figure(canvas, `Printed perfectly: "${props.title}" ${props.copy}.`);
  return slideOut(r, 1100, t => {
    g.clearRect(0, 0, w, h);
    g.save();
    g.translate(0, (1 - t) * -340);
    paper(g, 30, 10, 220, 340, '#fffaf0');
    const colours = [C.cyan, C.magenta, C.yellow, '#35b56a', '#ff7a2f'];
    for (let i = 0; i < 5; i++) {
      const bx = 70 + i * 36;
      const by = 90 + (i % 2) * 22;
      g.strokeStyle = '#8b8f98';
      g.beginPath();
      g.moveTo(bx, by + 26);
      g.quadraticCurveTo(bx + 6, by + 70, bx - 2, by + 110);
      g.stroke();
      g.fillStyle = colours[i];
      g.beginPath();
      g.ellipse(bx, by, 18, 24, 0, 0, TAU);
      g.fill();
    }
    for (let i = 0; i < 40; i++) {
      g.fillStyle = colours[i % colours.length];
      g.fillRect(40 + ((i * 53) % 200), 30 + ((i * 97) % 300), 4, 7);
    }
    g.fillStyle = '#c8321f';
    g.font = `800 22px ${COMIC}`;
    g.textAlign = 'center';
    wrap(g, props.title, 190).forEach((line, i) => g.fillText(line, w / 2, 250 + i * 28));
    g.fillStyle = C.grey;
    g.font = `500 11px ${FONT}`;
    g.fillText(props.copy, w / 2, 336);
    g.textAlign = 'left';
    g.restore();
  });
}

function comicSans(p, r) {
  const { canvas, g, w, h } = r.sheet(320, 250);
  r.figure(canvas, `${r.facts.name}, reformatted in Comic Sans and printed sideways.`);
  return slideOut(r, 900, t => {
    g.clearRect(0, 0, w, h);
    g.save();
    g.translate(0, (1 - t) * -240);
    paper(g, 20, 10, 280, 220, '#ffffff');
    g.translate(w / 2, 120);
    g.rotate(-Math.PI / 2);
    printedItem(g, r, -100, -130, 200, 260, COMIC);
    g.restore();
  });
}

function tinyPrint(p, r) {
  const { canvas, g, w, h } = r.sheet(300, 280);
  r.figure(canvas, `${r.facts.name}, printed at 12 × 12 pixels in the middle of a page.`);
  const tiny = document.createElement('canvas');
  tiny.width = 12;
  tiny.height = 12;
  const tg = tiny.getContext('2d');
  printedItem(tg, r, 0, 0, 12, 12);
  return slideOut(r, 800, t => {
    g.clearRect(0, 0, w, h);
    g.save();
    g.translate(0, (1 - t) * -260);
    paper(g, 30, 10, 170, 240, '#ffffff');
    g.imageSmoothingEnabled = false;
    g.drawImage(tiny, 30 + 85 - 6, 10 + 120 - 6, 12, 12);
    g.restore();
    if (t >= 1) {
      g.strokeStyle = '#6b7280';
      g.lineWidth = 3;
      g.beginPath();
      g.arc(245, 150, 44, 0, TAU);
      g.stroke();
      g.save();
      g.beginPath();
      g.arc(245, 150, 42, 0, TAU);
      g.clip();
      g.fillStyle = '#ffffff';
      g.fillRect(200, 105, 90, 90);
      g.imageSmoothingEnabled = false;
      g.drawImage(tiny, 215, 120, 60, 60);
      g.restore();
      g.strokeStyle = '#6b7280';
      g.beginPath();
      g.moveTo(214, 182);
      g.lineTo(196, 206);
      g.stroke();
      g.beginPath();
      g.moveTo(121, 130);
      g.lineTo(201, 145);
      g.setLineDash([3, 3]);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = C.grey;
      g.font = `600 12px ${FONT}`;
      g.fillText('12 × 12 pixels', 204, 216);
    }
  });
}

function transparent(p, r) {
  const { canvas, g, w, h } = r.sheet(240, 300);
  r.figure(canvas, 'A blank page: the transparent background, printed as nothing.');
  return slideOut(r, 900, t => {
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#6b7280';
    g.fillRect(20, 12, w - 40, 8);
    g.save();
    g.beginPath();
    g.rect(0, 18, w, h);
    g.clip();
    paper(g, 36, 18 - 240 + 240 * t, w - 72, 240, '#ffffff');
    g.restore();
    if (t >= 1) {
      g.fillStyle = C.grey;
      g.font = `600 12px ${FONT}`;
      g.fillText('Page 1 of 1: printed.', 40, 284);
    }
  });
}

async function certificate(p, r) {
  const props = r.script.props.certificate;
  const { canvas, g, w, h } = r.sheet(340, 240);
  const line = r.fill(props.line);
  r.figure(canvas, `Certificate: ${props.title}, ${r.vars().year}. ${line} Signed, ${props.signed}.`);
  g.fillStyle = '#fffaf0';
  g.fillRect(4, 4, w - 8, h - 8);
  g.strokeStyle = '#b8860b';
  g.lineWidth = 3;
  g.strokeRect(10, 10, w - 20, h - 20);
  g.lineWidth = 1;
  g.strokeRect(16, 16, w - 32, h - 32);
  g.fillStyle = '#7a5a10';
  g.textAlign = 'center';
  g.font = `600 13px Georgia, "Times New Roman", serif`;
  g.fillText('CERTIFICATE', w / 2, 44);
  g.fillStyle = C.text;
  g.font = `700 24px Georgia, "Times New Roman", serif`;
  g.fillText(`${props.title}, ${r.vars().year}`, w / 2, 82);
  g.font = `500 13px ${FONT}`;
  wrap(g, line, w - 80).forEach((part, i) => g.fillText(part, w / 2, 114 + i * 18));
  g.font = `italic 500 13px Georgia, serif`;
  g.fillText(props.signed, w / 2 + 40, 196);
  g.textAlign = 'left';
  g.fillStyle = '#c62828';
  g.beginPath();
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * TAU;
    const rad = i % 2 ? 22 : 27;
    g.lineTo(62 + Math.cos(a) * rad, 188 + Math.sin(a) * rad);
  }
  g.closePath();
  g.fill();
  g.fillStyle = '#ffffff';
  g.font = `800 10px ${FONT}`;
  g.textAlign = 'center';
  g.fillText('0', 62, 186);
  g.fillText('PAGES', 62, 198);
  g.textAlign = 'left';
  await r.wait(600);
}

// ---- Terms of Service and the speed-reading test --------------------------------------------------------------------

let builtTos = null;

function tos(p, r) {
  const spec = r.script.tos;
  builtTos ??= buildTos(spec);
  const { sections, words } = builtTos;
  const doc = r.el('div', { class: 'op-panel op-tos', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'op-tos-title' });
  const title = r.el('h2', { id: 'op-tos-title' }, spec.title);
  const updated = r.el('p', { class: 'op-small' }, `Last updated: ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}. ${formatNumber(words)} words.`);
  const box = r.el('div', { class: 'op-tos-box', tabindex: '0', 'aria-label': spec.title });
  const [secretSection, secretClause] = spec.secret.clause.split('.');
  let secretButton = null;
  for (const section of sections) {
    box.append(r.el('h3', {}, `${section.n}. ${section.title}`));
    for (const clause of section.clauses) {
      const para = r.el('p', {}, r.el('span', { class: 'op-tos-n' }, clause.n), ' ');
      if (clause.n === `${secretSection}.${secretClause}` && clause.text.includes(spec.secret.link)) {
        const [before] = clause.text.split(spec.secret.link);
        secretButton = r.el('button', { type: 'button', class: 'op-secret' }, spec.secret.link);
        para.append(before, secretButton);
      } else {
        para.append(clause.text);
      }
      box.append(para);
    }
  }
  const agree = r.el('button', { type: 'button', class: 'op-btn op-primary', disabled: true }, 'I Agree');
  const hint = r.el('p', { class: 'op-small op-tos-hint' }, 'Scroll to the end to agree.');
  doc.append(title, updated, box, r.el('div', { class: 'op-tos-foot' }, hint, agree));
  const close = r.overlay(doc);
  const started = performance.now();
  box.focus({ preventScroll: true });
  return new Promise(resolve => {
    const done = result => {
      close();
      r.run.tos = { ...result, words };
      resolve();
    };
    const check = () => {
      if (box.scrollTop + box.clientHeight >= box.scrollHeight - 4) {
        agree.disabled = false;
        hint.textContent = 'You may now agree.';
      }
    };
    box.addEventListener('scroll', check, { passive: true, signal: r.signal });
    agree.addEventListener('click', () => done({ seconds: (performance.now() - started) / 1000, secret: false }), { signal: r.signal });
    secretButton?.addEventListener('click', () => done({ seconds: (performance.now() - started) / 1000, secret: true }), { signal: r.signal });
    r.signal.addEventListener('abort', () => {
      close();
      resolve();
    }, { once: true });
    check();
  });
}

async function speedRead(p, r) {
  const spec = r.script.tos;
  const claim = r.run.tos;
  if (!claim) return;
  const seconds = Math.max(0.05, claim.seconds);
  const want = workFor(r.script, seconds);
  const order = [want, ...spec.works.filter(x => x !== want).sort((a, b) => a.minSeconds < b.minSeconds ? 1 : -1)];
  let work = null;
  let text = '';
  for (const candidate of order) {
    try {
      text = await r.loadText(candidate.file);
      if (countWords(text) > 1000) {
        work = candidate;
        break;
      }
    } catch {
      // Not installed; try the next one.
    }
  }
  if (r.signal.aborted) return;
  if (!work) {
    await r.say(spec.noText);
    return;
  }
  const words = text.split(/\s+/).filter(Boolean);
  const speed = claim.words / seconds;
  const duration = words.length / speed;
  const panel = r.el('div', { class: 'op-panel op-speed', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Speed reading' });
  const head = r.el('h2', {}, `${work.title[0].toUpperCase()}${work.title.slice(1)}`);
  const stats = r.el('p', {}, `${formatNumber(words.length)} words at your speed of ${formatNumber(speed)} words a second: ${formatSeconds(duration)} seconds.`);
  const page = r.el('p', { class: 'op-speed-text', 'aria-hidden': 'true' });
  const bar = r.el('div', { class: 'op-speed-bar' }, r.el('span', {}));
  panel.append(head, stats, page, bar);
  const close = r.overlay(panel);
  await r.wait(2600);
  const fillBar = bar.firstChild;
  const span = 90;
  const start = performance.now();
  let lastShown = -1;
  while (!r.signal.aborted) {
    const now = await r.frame();
    const elapsed = (now - start) / 1000;
    const at = Math.min(words.length, Math.floor(elapsed * speed));
    const step = r.reduced ? Math.floor(elapsed * 2) : at;
    if (step !== lastShown) {
      lastShown = step;
      page.textContent = words.slice(at, at + span).join(' ');
      fillBar.style.width = `${(at / words.length) * 100}%`;
    }
    if (at >= words.length) break;
  }
  page.textContent = 'The end.';
  await r.wait(1200);
  close();
}

export const RENDERS = {
  laserjetScreen, lcd, testPage, blankPage, pixelPrint, pixelFast, iconPrintout, dotMatrix, queue, warranty, jam,
  doubleSided, blankStack, network, firmware, timeSkip, artCritic, strike, fridge, loveLetter, wrongDocument,
  comicSans, tinyPrint, transparent, certificate, tos, speedRead,
};
