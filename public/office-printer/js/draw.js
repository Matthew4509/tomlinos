// Drawing kit for the printouts: canvases sized for the chat, paper, file icons, the Quarterly Report, and the
// printers' faces. Everything is drawn here; there are no picture files.

export const C = {
  paper: '#fffdf8',
  paperShade: '#efeae0',
  paperEdge: '#cfc8b9',
  shadow: 'rgba(40, 32, 20, 0.22)',
  cyan: '#00a3d9',
  magenta: '#d6007e',
  yellow: '#f5c400',
  black: '#1d1d1f',
  navy: '#1f3b64',
  text: '#2a2d33',
  grey: '#8b8f98',
  lightGrey: '#d9dce1',
  lcd: '#a9c68a',
  lcdInk: '#1f2d14',
  plastic: '#d9dbde',
  plasticDark: '#8f959d',
  red: '#d2352b',
  green: '#2f9a4a',
};

export const FONT = '"Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';
export const MONO = '"Courier New", Courier, monospace';
export const COMIC = '"Comic Sans MS", "Comic Sans", "Chalkboard SE", "Comic Neue", cursive';

/** A canvas `w` by `h` in page pixels, sharp on high-density screens. The chat shrinks it to fit a narrow column. */
export function sheet(w, h) {
  const dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.maxWidth = `${w}px`;
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  return { canvas, g, w, h };
}

export function roundRect(g, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}

/** A sheet of paper with a soft shadow. */
export function paper(g, x, y, w, h, fill = C.paper) {
  g.save();
  g.shadowColor = C.shadow;
  g.shadowBlur = 8;
  g.shadowOffsetY = 3;
  g.fillStyle = fill;
  g.fillRect(x, y, w, h);
  g.restore();
  g.strokeStyle = C.paperEdge;
  g.lineWidth = 1;
  g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
}

/** Splits text into lines that fit `maxW` in the current font. */
export function wrap(g, text, maxW) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (g.measureText(test).width > maxW && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function fitText(g, text, maxW, size, weight = '600', family = FONT) {
  let s = size;
  do {
    g.font = `${weight} ${s}px ${family}`;
    if (g.measureText(text).width <= maxW) return s;
    s -= 1;
  } while (s > 8);
  return s;
}

const KIND_LOOK = {
  pdf: { band: '#c9342b', label: 'PDF' },
  doc: { band: '#2b5fb8', label: 'DOC' },
  sheet: { band: '#2f8a4a', label: 'XLS' },
  text: { band: '#6b7280', label: 'TXT' },
  image: { band: '#3a9bd9', label: 'IMG' },
  exe: { band: '#3b3f48', label: 'EXE' },
  other: { band: '#8a6d3b', label: 'FILE' },
};

/** A file icon: a page with a folded corner and a coloured band naming its kind. */
export function fileIcon(g, kind, x, y, size, ext) {
  const look = KIND_LOOK[kind] ?? KIND_LOOK.other;
  const w = size * 0.78;
  const h = size;
  const fold = size * 0.24;
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.18)';
  g.shadowBlur = size * 0.08;
  g.shadowOffsetY = size * 0.03;
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.moveTo(x, y);
  g.lineTo(x + w - fold, y);
  g.lineTo(x + w, y + fold);
  g.lineTo(x + w, y + h);
  g.lineTo(x, y + h);
  g.closePath();
  g.fill();
  g.restore();
  g.strokeStyle = '#9aa3b2';
  g.lineWidth = Math.max(1, size * 0.025);
  g.stroke();
  g.fillStyle = '#dde3ec';
  g.beginPath();
  g.moveTo(x + w - fold, y);
  g.lineTo(x + w - fold, y + fold);
  g.lineTo(x + w, y + fold);
  g.closePath();
  g.fill();
  g.stroke();
  g.strokeStyle = '#c3cad6';
  g.lineWidth = Math.max(1, size * 0.03);
  for (let i = 0; i < 3; i++) {
    const ly = y + h * 0.3 + i * h * 0.1;
    g.beginPath();
    g.moveTo(x + w * 0.16, ly);
    g.lineTo(x + w * (i === 2 ? 0.6 : 0.84), ly);
    g.stroke();
  }
  g.fillStyle = look.band;
  g.fillRect(x + w * 0.08, y + h * 0.62, w * 0.84, h * 0.26);
  const label = ext ? ext.replace(/^\./, '').toUpperCase().slice(0, 5) : look.label;
  g.fillStyle = '#ffffff';
  fitText(g, label, w * 0.76, Math.round(h * 0.18), '700');
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(label, x + w / 2, y + h * 0.75);
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
}

/**
 * The Quarterly Report, drawn into a box of any size (a thumbnail, a printout, or one strip of the 4000 x 3000 page
 * the Photo Printer prints pixel by pixel).
 */
export function reportPage(g, x, y, w, h, props) {
  g.save();
  g.translate(x, y);
  g.scale(w / 400, h / 300);
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 400, 300);
  g.fillStyle = C.navy;
  g.fillRect(0, 0, 380, 3);
  g.fillStyle = C.cyan;
  g.fillRect(380, 0, 20, 3);
  g.fillStyle = C.navy;
  g.fillRect(24, 22, 352, 34);
  g.fillStyle = '#ffffff';
  g.font = `700 20px ${FONT}`;
  g.fillText(props.title, 36, 45);
  g.fillStyle = C.text;
  g.font = `600 11px ${FONT}`;
  g.fillText(props.subtitle, 26, 74);
  g.font = `600 10px ${FONT}`;
  g.fillText(props.chart, 26, 98);
  const bars = [0.42, 0.58, 0.51, 0.87];
  bars.forEach((v, i) => {
    g.fillStyle = i === 3 ? C.cyan : '#6d87ad';
    const bh = 90 * v;
    g.fillRect(34 + i * 40, 200 - bh, 26, bh);
  });
  g.strokeStyle = C.grey;
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(28, 200.5);
  g.lineTo(200, 200.5);
  g.stroke();
  g.fillStyle = '#c9cdd4';
  for (let i = 0; i < 9; i++) g.fillRect(222, 106 + i * 11, i % 3 === 2 ? 110 : 150, 5);
  for (let i = 0; i < 6; i++) g.fillRect(26, 222 + i * 11, i === 5 ? 180 : 348, 5);
  g.restore();
}

/** A plain document page: a title and lines, in any font. */
export function docPage(g, x, y, w, h, title, lines, family = FONT) {
  g.fillStyle = '#ffffff';
  g.fillRect(x, y, w, h);
  const pad = w * 0.09;
  g.fillStyle = C.text;
  const titleSize = Math.max(12, Math.round(w * 0.07));
  g.font = `700 ${titleSize}px ${family}`;
  let ty = y + pad + titleSize;
  for (const line of wrap(g, title, w - pad * 2)) {
    g.fillText(line, x + pad, ty);
    ty += titleSize * 1.2;
  }
  const size = Math.max(10, Math.round(w * 0.042));
  g.font = `400 ${size}px ${family}`;
  ty += size * 0.6;
  for (const para of lines) {
    for (const line of wrap(g, para, w - pad * 2)) {
      if (ty > y + h - pad) return;
      g.fillText(line, x + pad, ty);
      ty += size * 1.45;
    }
    ty += size * 0.5;
  }
}

/** Grey scribbles where text would be, for documents the printers do not read. */
export function scribbles(g, x, y, w, h, rows) {
  g.fillStyle = '#c9cdd4';
  const step = h / (rows + 1);
  for (let i = 0; i < rows; i++) g.fillRect(x, y + step * (i + 0.5), w * (i % 4 === 3 ? 0.55 : 0.95), Math.max(2, step * 0.35));
}

// ---- The printers' faces -----------------------------------------------------------------------------------------

function eyes(g, cx, cy, gap, r, look = 0) {
  for (const dx of [-gap, gap]) {
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.arc(cx + dx, cy, r, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#1b1d22';
    g.beginPath();
    g.arc(cx + dx + look, cy - r * 0.15, r * 0.55, 0, Math.PI * 2);
    g.fill();
  }
}

const FACES = {
  laserjet(g) {
    g.fillStyle = '#c9cdd3';
    roundRect(g, 5, 8, 30, 26, 4);
    g.fill();
    g.fillStyle = '#50565f';
    g.fillRect(9, 11, 22, 3);
    g.fillStyle = C.lcd;
    roundRect(g, 10, 16, 20, 8, 1.5);
    g.fill();
    g.fillStyle = C.lcdInk;
    g.fillRect(14, 18.5, 3, 3);
    g.fillRect(23, 18.5, 3, 3);
    g.fillStyle = C.navy;
    g.beginPath();
    g.moveTo(18, 26);
    g.lineTo(22, 26);
    g.lineTo(23, 37);
    g.lineTo(20, 39);
    g.lineTo(17, 37);
    g.closePath();
    g.fill();
  },
  inkjet(g) {
    g.fillStyle = '#ffffff';
    g.fillRect(12, 4, 16, 10);
    g.strokeStyle = '#b8bec8';
    g.strokeRect(12.5, 4.5, 15, 9);
    g.fillStyle = '#f1efe9';
    roundRect(g, 4, 11, 32, 24, 7);
    g.fill();
    g.strokeStyle = '#b3aea3';
    g.lineWidth = 1.2;
    g.stroke();
    eyes(g, 20, 21, 6, 4, 0);
    g.strokeStyle = '#6b5e4a';
    g.lineWidth = 1.4;
    g.beginPath();
    g.moveTo(14, 30);
    g.quadraticCurveTo(17, 28, 20, 30);
    g.quadraticCurveTo(23, 32, 26, 30);
    g.stroke();
  },
  photo(g) {
    g.fillStyle = '#2b2d31';
    roundRect(g, 4, 10, 32, 24, 6);
    g.fill();
    g.fillStyle = '#0d0e10';
    roundRect(g, 8, 17, 10, 7, 3);
    g.fill();
    roundRect(g, 22, 17, 10, 7, 3);
    g.fill();
    g.fillRect(17, 19, 6, 1.5);
    g.fillStyle = 'rgba(255,255,255,0.7)';
    g.fillRect(10, 18.5, 3, 1.2);
    g.fillRect(24, 18.5, 3, 1.2);
    g.fillStyle = C.magenta;
    g.beginPath();
    g.ellipse(20, 9, 11, 4, -0.15, 0, Math.PI * 2);
    g.fill();
    g.fillRect(19, 3, 2, 3);
    g.strokeStyle = '#9a9ca3';
    g.lineWidth = 1.2;
    g.beginPath();
    g.moveTo(16, 29);
    g.lineTo(24, 28);
    g.stroke();
  },
  dotmatrix(g) {
    g.fillStyle = '#e8f3e4';
    g.fillRect(9, 2, 22, 10);
    g.fillStyle = '#bfe0b5';
    g.fillRect(9, 5, 22, 2.5);
    g.fillStyle = '#d8cfb5';
    roundRect(g, 2, 12, 36, 22, 3);
    g.fill();
    g.strokeStyle = '#a89f86';
    g.lineWidth = 1.2;
    g.stroke();
    g.fillStyle = '#6d654f';
    for (let i = 0; i < 4; i++) {
      g.beginPath();
      g.arc(5, 15 + i * 5, 1, 0, Math.PI * 2);
      g.arc(35, 15 + i * 5, 1, 0, Math.PI * 2);
      g.fill();
    }
    g.strokeStyle = '#4a4436';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(11, 17);
    g.lineTo(17, 19);
    g.moveTo(29, 17);
    g.lineTo(23, 19);
    g.stroke();
    g.fillStyle = '#2a261d';
    g.fillRect(13, 21, 3, 3);
    g.fillRect(24, 21, 3, 3);
    g.fillRect(15, 28, 10, 2);
  },
  canon(g) {
    g.fillStyle = '#c8453c';
    roundRect(g, 5, 9, 30, 25, 5);
    g.fill();
    g.fillStyle = '#7e231d';
    g.fillRect(9, 12, 22, 3);
    eyes(g, 20, 22, 6, 3.4, -1.6);
    g.fillStyle = '#ffffff';
    g.beginPath();
    g.arc(20, 30, 2.2, 0, Math.PI * 2);
    g.fill();
  },
  fax(g) {
    g.fillStyle = '#bfc4ca';
    roundRect(g, 4, 16, 32, 18, 3);
    g.fill();
    g.fillStyle = '#4b5058';
    roundRect(g, 6, 8, 28, 7, 3.5);
    g.fill();
    g.fillStyle = '#6f757e';
    for (let r = 0; r < 2; r++) for (let c = 0; c < 4; c++) g.fillRect(19 + c * 4, 20 + r * 5, 2.5, 2.5);
    g.fillStyle = C.lcd;
    g.fillRect(7, 20, 9, 6);
  },
  scanner(g) {
    g.fillStyle = '#9ea4ad';
    roundRect(g, 3, 14, 34, 16, 3);
    g.fill();
    g.fillStyle = '#d7dbe0';
    roundRect(g, 3, 10, 34, 6, 2);
    g.fill();
    g.fillStyle = '#7dff9b';
    g.fillRect(8, 21, 24, 3);
    g.fillStyle = 'rgba(125,255,155,0.35)';
    g.fillRect(8, 18, 24, 9);
  },
  network(g) {
    g.strokeStyle = '#5f7290';
    g.lineWidth = 2;
    const pts = [[10, 12], [30, 10], [20, 28], [8, 30], [32, 29]];
    g.beginPath();
    g.moveTo(...pts[0]);
    g.lineTo(...pts[2]);
    g.lineTo(...pts[1]);
    g.moveTo(...pts[2]);
    g.lineTo(...pts[3]);
    g.moveTo(...pts[2]);
    g.lineTo(...pts[4]);
    g.stroke();
    for (const [x, y] of pts) {
      g.fillStyle = '#3f7fd8';
      g.beginPath();
      g.arc(x, y, 4, 0, Math.PI * 2);
      g.fill();
    }
  },
};

/** A printer's face, `size` page pixels square. */
export function face(id, size = 40) {
  const { canvas, g } = sheet(size, size);
  canvas.classList.add('op-face');
  g.scale(size / 40, size / 40);
  (FACES[id] ?? FACES.network)(g);
  return canvas;
}

export function drawFace(g, id, x, y, size) {
  g.save();
  g.translate(x, y);
  g.scale(size / 40, size / 40);
  (FACES[id] ?? FACES.network)(g);
  g.restore();
}
