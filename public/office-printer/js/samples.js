// The files you can print without bringing your own: the report, a holiday photo, a logo, a Word document, a
// spreadsheet, plain text and a program. The two pictures are drawn here and saved as a real JPEG and PNG, so the
// printers measure them exactly as they would measure yours.
import { seeded } from './tos.js';

function drawPool(g, w, h) {
  const rand = seeded(4471);
  const water = g.createLinearGradient(0, 0, 0, h);
  water.addColorStop(0, '#2cc6e2');
  water.addColorStop(1, '#0c9cc4');
  g.fillStyle = water;
  g.fillRect(0, 0, w, h);
  g.lineCap = 'round';
  for (let i = 0; i < 140; i++) {
    g.strokeStyle = `rgba(150, 236, 248, ${0.25 + rand() * 0.35})`;
    g.lineWidth = 3 + rand() * 7;
    const x = rand() * w;
    const y = rand() * h;
    g.beginPath();
    g.moveTo(x, y);
    g.bezierCurveTo(x + 40 + rand() * 60, y - 30, x + 80, y + 40, x + 140 + rand() * 80, y + rand() * 20);
    g.stroke();
  }
  const ropeY = h * 0.42;
  for (let x = -20; x < w + 40; x += 46) {
    g.fillStyle = Math.round(x / 46) % 4 === 0 ? '#e0453a' : '#f7f7f2';
    g.beginPath();
    g.ellipse(x, ropeY, 22, 15, 0, 0, Math.PI * 2);
    g.fill();
  }
  const dx = w * 0.68;
  const dy = h * 0.66;
  g.fillStyle = 'rgba(0, 60, 90, 0.25)';
  g.beginPath();
  g.ellipse(dx + 20, dy + 90, 150, 38, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#ffd21f';
  g.beginPath();
  g.ellipse(dx, dy + 30, 140, 80, 0, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.arc(dx + 90, dy - 60, 62, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#f08a1c';
  g.beginPath();
  g.ellipse(dx + 160, dy - 50, 42, 16, 0.1, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#1c1c1c';
  g.beginPath();
  g.arc(dx + 105, dy - 80, 9, 0, Math.PI * 2);
  g.fill();
}

function drawLogo(g, w, h) {
  g.clearRect(0, 0, w, h);
  g.fillStyle = '#1f3b64';
  g.beginPath();
  g.arc(150, h / 2, 110, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.moveTo(90, 210);
  g.lineTo(220, 140);
  g.lineTo(170, 260);
  g.lineTo(150, 220);
  g.closePath();
  g.fill();
  g.fillStyle = '#1f3b64';
  g.font = '700 64px "Segoe UI", system-ui, sans-serif';
  g.fillText('ACME', 300, 190);
  g.font = '600 40px "Segoe UI", system-ui, sans-serif';
  g.fillText('PAPER CO.', 302, 250);
}

function pictureBlob(w, h, draw, type, quality) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext('2d'), w, h);
  return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Could not draw the sample picture'))), type, quality));
}

const MAKERS = {
  pool: () => pictureBlob(1600, 1200, drawPool, 'image/jpeg', 0.86),
  logo: () => pictureBlob(800, 400, drawLogo, 'image/png'),
};

/** The sample files as file-likes: { name, note, sample, blob() }. Pictures are drawn once, the first time they are asked for. */
export function sampleFiles(script) {
  return script.samples.map(s => {
    let made = null;
    const make = MAKERS[s.id];
    return {
      name: s.name,
      note: s.note,
      sample: s.id,
      blob: make ? () => (made ??= make()) : undefined,
    };
  });
}
