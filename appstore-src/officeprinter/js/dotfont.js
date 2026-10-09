// Copied from ../../../public/office-printer/js/dotfont.js (version A) so B stands on its own.
// A 5 x 7 dot font, drawn one dot at a time: the Dot Matrix's printouts and the printers' little screens.
// Each glyph is seven rows; each row is five bits, the leftmost dot first.

const GLYPHS = {
  ' ': [0, 0, 0, 0, 0, 0, 0],
  '0': [14, 17, 19, 21, 25, 17, 14], '1': [4, 12, 4, 4, 4, 4, 14], '2': [14, 17, 1, 2, 4, 8, 31],
  '3': [31, 2, 4, 2, 1, 17, 14], '4': [2, 6, 10, 18, 31, 2, 2], '5': [31, 16, 30, 1, 1, 17, 14],
  '6': [6, 8, 16, 30, 17, 17, 14], '7': [31, 1, 2, 4, 8, 8, 8], '8': [14, 17, 17, 14, 17, 17, 14],
  '9': [14, 17, 17, 15, 1, 2, 12],
  A: [14, 17, 17, 17, 31, 17, 17], B: [30, 17, 17, 30, 17, 17, 30], C: [14, 17, 16, 16, 16, 17, 14],
  D: [28, 18, 17, 17, 17, 18, 28], E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17], I: [14, 4, 4, 4, 4, 4, 14],
  J: [7, 2, 2, 2, 2, 18, 12], K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17], N: [17, 17, 25, 21, 19, 17, 17], O: [14, 17, 17, 17, 17, 17, 14],
  P: [30, 17, 17, 30, 16, 16, 16], Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17],
  S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4], U: [17, 17, 17, 17, 17, 17, 14],
  V: [17, 17, 17, 17, 17, 10, 4], W: [17, 17, 17, 21, 21, 21, 10], X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 17, 10, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31],
  'Ñ': [10, 5, 17, 25, 21, 19, 17],
  '.': [0, 0, 0, 0, 0, 12, 12], ',': [0, 0, 0, 0, 12, 4, 8], ':': [0, 12, 12, 0, 12, 12, 0],
  ';': [0, 12, 12, 0, 12, 4, 8], '-': [0, 0, 0, 31, 0, 0, 0], '_': [0, 0, 0, 0, 0, 0, 31],
  '!': [4, 4, 4, 4, 0, 0, 4], '?': [14, 17, 1, 2, 4, 0, 4], "'": [12, 4, 8, 0, 0, 0, 0],
  '"': [10, 10, 10, 0, 0, 0, 0], '(': [2, 4, 8, 8, 8, 4, 2], ')': [8, 4, 2, 2, 2, 4, 8],
  '/': [0, 1, 2, 4, 8, 16, 0], '&': [12, 18, 20, 8, 21, 18, 13], $: [4, 15, 20, 14, 5, 30, 4],
  '%': [24, 25, 2, 4, 8, 19, 3], '#': [10, 10, 31, 10, 31, 10, 10], '+': [0, 4, 4, 31, 4, 4, 0],
  '=': [0, 0, 31, 0, 31, 0, 0], '*': [0, 4, 21, 14, 21, 4, 0], '<': [2, 4, 8, 16, 8, 4, 2],
  '>': [8, 4, 2, 1, 2, 4, 8], '×': [0, 17, 10, 4, 10, 17, 0], '@': [14, 17, 1, 13, 21, 21, 14],
};
const UNKNOWN = [31, 17, 17, 17, 17, 17, 31];

export const CELL_W = 6;
export const CELL_H = 9;

function glyph(ch) {
  return GLYPHS[ch] ?? GLYPHS[ch.toUpperCase()] ?? UNKNOWN;
}

/**
 * Draws one character. `dot` is the size of a dot's cell in canvas units; the dot itself is a round blob a little
 * smaller, as a pin leaves it. `wobble` nudges each dot for a worn ribbon.
 */
export function drawChar(g, ch, x, y, dot, wobble = 0) {
  const rows = glyph(ch);
  const r = dot * 0.42;
  for (let row = 0; row < 7; row++) {
    const bits = rows[row];
    if (!bits) continue;
    for (let col = 0; col < 5; col++) {
      if (!(bits & (16 >> col))) continue;
      const jx = wobble ? (Math.random() - 0.5) * wobble : 0;
      const jy = wobble ? (Math.random() - 0.5) * wobble : 0;
      g.beginPath();
      g.arc(x + col * dot + dot / 2 + jx, y + row * dot + dot / 2 + jy, r, 0, Math.PI * 2);
      g.fill();
    }
  }
}

export function drawText(g, text, x, y, dot, wobble = 0) {
  let cx = x;
  for (const ch of String(text)) {
    drawChar(g, ch, cx, y, dot, wobble);
    cx += CELL_W * dot;
  }
}

export function textWidth(text, dot) {
  return [...String(text)].length * CELL_W * dot;
}
