// Drawing CAD Draft's drawing area on a canvas: the dark blue (or white) background, the scale marks with numbers
// along the left and bottom edges, the grid, the origin, every item in its layer's colour, the chosen items dashed,
// the shape a tool would make, the snap mark with its name, and the selection box.
import { P, angleOf, at, type Box, type Piece, type Pt } from './geom.ts';
import { directionMarks } from './modify.ts';
import { outlineOf, shapeBox, type Ent, type Layer, type LineType, type Shape, type Units } from './model.ts';
import { photoOnPage, pixelMatrix, type Photo } from './photo.ts';
import { SNAP_NAMES, type Snap } from './snap.ts';

/** What part of the drawing shows: the drawing point at the middle of the area, and pixels per drawing unit. */
export interface View {
  cx: number;
  cy: number;
  scale: number;
}

export const MIN_SCALE = 1e-6;
export const MAX_SCALE = 1e7;

export function toScreen(v: View, w: number, h: number, p: Pt): Pt {
  return P(w / 2 + (p.x - v.cx) * v.scale, h / 2 - (p.y - v.cy) * v.scale);
}

export function toWorld(v: View, w: number, h: number, s: Pt): Pt {
  return P(v.cx + (s.x - w / 2) / v.scale, v.cy - (s.y - h / 2) / v.scale);
}

/** A view showing the whole box with a margin (an empty drawing shows 0 to 300 across). */
export function fitView(box: Box | null, w: number, h: number): View {
  const b = box ?? { x0: 0, y0: 0, x1: 300, y1: 200 };
  const bw = Math.max(b.x1 - b.x0, 1e-9);
  const bh = Math.max(b.y1 - b.y0, 1e-9);
  const scale = Math.min((w - 90) / bw, (h - 70) / bh);
  const clamped = Math.max(MIN_SCALE, Math.min(MAX_SCALE, Number.isFinite(scale) && scale > 0 ? scale : 1));
  // A little room at the left and bottom for the scale numbers.
  return { cx: (b.x0 + b.x1) / 2 - 20 / clamped, cy: (b.y0 + b.y1) / 2 - 14 / clamped, scale: clamped };
}

/** A round step (1, 2 or 5 times a power of ten) at least `min` drawing units. */
export function niceStep(min: number): number {
  const p = 10 ** Math.floor(Math.log10(min));
  for (const k of [1, 2, 5, 10]) if (k * p >= min) return k * p;
  return 10 * p;
}

export interface Scene {
  ents: Ent[];
  layers: Map<string, Layer>;
  selected: ReadonlySet<number>;
  hover: number | null;
  preview: Shape[];
  snap: Snap | null;
  /** The selection box being dragged (drawing units), and whether it crosses (right to left) or windows. */
  box: { a: Pt; b: Pt; crossing: boolean } | null;
  grid: number;
  gridOn: boolean;
  white: boolean;
  units: Units;
  /** Arrows along lines and polylines showing which way they run, and a ring at each polyline's start. */
  arrows: boolean;
  /** The photo under the drawing (when it is showing and its pixels are ready). */
  photo: { ph: Photo; img: CanvasImageSource } | null;
}

/** Dash patterns in pixels (the same on screen at every zoom). */
const DASHES: Record<LineType, number[]> = { continuous: [], dashed: [12, 6], centre: [22, 5, 4, 5], hidden: [6, 4], dotted: [2, 4] };

/** Dark colours on a white background: white becomes black, very light colours are darkened. */
function inkFor(colour: string, white: boolean): string {
  if (!white) return colour;
  const n = parseInt(colour.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const light = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  if (light < 0.6) return colour;
  const k = light > 0.95 ? 0 : 0.55;
  const hex = (v: number) => Math.round(v * k).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

export function render(c: CanvasRenderingContext2D, w: number, h: number, v: View, s: Scene): void {
  const bg = s.white ? '#ffffff' : '#1e2088';
  const tickInk = s.white ? '#606060' : '#b8bce8';
  c.save();
  c.fillStyle = bg;
  c.fillRect(0, 0, w, h);
  const scr = (p: Pt) => toScreen(v, w, h, p);
  const tl = toWorld(v, w, h, P(0, 0));
  const br = toWorld(v, w, h, P(w, h));

  // The photo, under everything, as strongly as it is set to show.
  if (s.photo) {
    c.save();
    c.globalAlpha = s.photo.ph.opacity;
    c.imageSmoothingQuality = 'high';
    c.transform(...pixelMatrix(s.photo.ph, photoOnPage(s.photo.ph, scr)));
    // A straightened photo shows only the part the photo filled (the rest of its picture is blank).
    const clip = s.photo.ph.clip;
    if (clip) {
      c.beginPath();
      clip.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
      c.closePath();
      c.clip();
    }
    c.drawImage(s.photo.img, 0, 0);
    c.restore();
  }

  // The grid: dots where the grid lines cross, if they are far enough apart to see.
  if (s.gridOn && s.grid > 0) {
    let g = s.grid;
    while (g * v.scale < 8) g *= g === s.grid ? 5 : 2;
    const x0 = Math.ceil(tl.x / g);
    const x1 = Math.floor(br.x / g);
    const y0 = Math.ceil(br.y / g);
    const y1 = Math.floor(tl.y / g);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) < 40000) {
      c.fillStyle = s.white ? '#b0b0b0' : '#5a60c0';
      for (let i = x0; i <= x1; i++) {
        for (let j = y0; j <= y1; j++) {
          const q = scr(P(i * g, j * g));
          c.fillRect(Math.round(q.x), Math.round(q.y), 1, 1);
        }
      }
    }
  }

  // The origin: a short X arrow and Y arrow.
  const o = scr(P(0, 0));
  if (o.x > -40 && o.x < w + 40 && o.y > -40 && o.y < h + 40) {
    c.lineWidth = 1;
    c.strokeStyle = '#e05050';
    c.beginPath();
    c.moveTo(o.x, o.y);
    c.lineTo(o.x + 28, o.y);
    c.moveTo(o.x + 23, o.y - 3);
    c.lineTo(o.x + 28, o.y);
    c.lineTo(o.x + 23, o.y + 3);
    c.stroke();
    c.strokeStyle = '#40c040';
    c.beginPath();
    c.moveTo(o.x, o.y);
    c.lineTo(o.x, o.y - 28);
    c.moveTo(o.x - 3, o.y - 23);
    c.lineTo(o.x, o.y - 28);
    c.lineTo(o.x + 3, o.y - 23);
    c.stroke();
  }

  // Items off the area are passed over (a little beyond its edge: a point's cross and a thick line have width).
  const edge = 8 / v.scale;
  const offArea = (e: Ent) => {
    const b = shapeBox(e);
    return !!b && (b.x1 < tl.x - edge || b.x0 > br.x + edge || b.y1 < br.y - edge || b.y0 > tl.y + edge);
  };

  // Items, layer by layer colour; chosen ones dashed and brighter.
  for (const e of s.ents) {
    const layer = s.layers.get(e.layer);
    if (!layer || !layer.on || offArea(e)) continue;
    const chosen = s.selected.has(e.id);
    const hovered = s.hover === e.id;
    c.strokeStyle = chosen ? (s.white ? '#d06000' : '#ffd040') : inkFor(layer.colour, s.white);
    c.lineWidth = hovered ? 3 : chosen ? 2 : 1.2;
    c.setLineDash(chosen ? [7, 4] : DASHES[layer.lineType] ?? []);
    stroke(c, e, v, w, h);
  }
  c.setLineDash([]);

  if (s.arrows) {
    for (const e of s.ents) {
      const layer = s.layers.get(e.layer);
      if (!layer || !layer.on || (e.type !== 'poly' && e.type !== 'line') || offArea(e)) continue;
      c.strokeStyle = s.white ? '#c05000' : '#ffb040';
      c.fillStyle = c.strokeStyle;
      c.lineWidth = 1.5;
      for (const m of directionMarks(e)) {
        const q = toScreen(v, w, h, m.at);
        const d = P(m.dir.x, -m.dir.y);
        const n = P(-d.y, d.x);
        c.beginPath();
        c.moveTo(q.x + d.x * 7, q.y + d.y * 7);
        c.lineTo(q.x - d.x * 5 + n.x * 5, q.y - d.y * 5 + n.y * 5);
        c.lineTo(q.x - d.x * 5 - n.x * 5, q.y - d.y * 5 - n.y * 5);
        c.closePath();
        c.fill();
      }
      if (e.type === 'poly') {
        const st = toScreen(v, w, h, e.pts[0]);
        c.beginPath();
        c.arc(st.x, st.y, 6, 0, Math.PI * 2);
        c.stroke();
      }
    }
  }

  // The shape the tool would make.
  if (s.preview.length) {
    c.strokeStyle = s.white ? '#008060' : '#f4f490';
    c.lineWidth = 1.2;
    c.setLineDash([5, 3]);
    for (const p of s.preview) stroke(c, p, v, w, h);
    c.setLineDash([]);
  }

  // The selection box: a window is a solid edge, a crossing box a dashed one.
  if (s.box) {
    const a = scr(s.box.a);
    const b = scr(s.box.b);
    c.fillStyle = s.box.crossing ? 'rgba(80, 230, 120, 0.16)' : 'rgba(90, 150, 255, 0.2)';
    c.strokeStyle = s.box.crossing ? '#60e080' : '#80b0ff';
    c.lineWidth = 1;
    c.setLineDash(s.box.crossing ? [5, 3] : []);
    c.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    c.strokeRect(Math.min(a.x, b.x) + 0.5, Math.min(a.y, b.y) + 0.5, Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    c.setLineDash([]);
  }

  drawTicks(c, w, h, v, tickInk, bg, s.units);
  if (s.snap) drawSnap(c, scr(s.snap.p), s.snap.kind, s.white);
  c.restore();
}

/** Strokes one item (its pieces), or a point as a small cross. */
function stroke(c: CanvasRenderingContext2D, s: Shape, v: View, w: number, h: number): void {
  const scr = (p: Pt) => toScreen(v, w, h, p);
  if (s.type === 'point') {
    const q = scr(s.p);
    c.beginPath();
    c.moveTo(q.x - 4, q.y - 4);
    c.lineTo(q.x + 4, q.y + 4);
    c.moveTo(q.x + 4, q.y - 4);
    c.lineTo(q.x - 4, q.y + 4);
    c.stroke();
    return;
  }
  c.beginPath();
  for (const p of outlineOf(s)) tracePiece(c, p, v, w, h);
  c.stroke();
}

function tracePiece(c: CanvasRenderingContext2D, p: Piece, v: View, w: number, h: number): void {
  const scr = (q: Pt) => toScreen(v, w, h, q);
  switch (p.k) {
    case 'seg': {
      const a = scr(p.a);
      const b = scr(p.b);
      c.moveTo(a.x, a.y);
      c.lineTo(b.x, b.y);
      break;
    }
    case 'xline': {
      // Long enough to run off the area both ways.
      const centre = scr(p.p);
      const reach = (Math.hypot(w, h) + Math.hypot(centre.x - w / 2, centre.y - h / 2)) / v.scale;
      const a = scr(P(p.p.x - p.d.x * reach, p.p.y - p.d.y * reach));
      const b = scr(P(p.p.x + p.d.x * reach, p.p.y + p.d.y * reach));
      c.moveTo(a.x, a.y);
      c.lineTo(b.x, b.y);
      break;
    }
    case 'arc': {
      const s0 = scr(at(p, p.a0));
      const q = scr(p.c);
      c.moveTo(s0.x, s0.y);
      c.arc(q.x, q.y, p.r * v.scale, -p.a0, -p.a1, true);
      break;
    }
    case 'ell': {
      const s0 = scr(at(p, p.t0));
      const q = scr(p.c);
      const a = Math.hypot(p.m.x, p.m.y);
      c.moveTo(s0.x, s0.y);
      c.ellipse(q.x, q.y, a * v.scale, a * p.ratio * v.scale, -angleOf(p.m), -p.t0, -p.t1, true);
      break;
    }
    case 'bez': {
      const [a, b, d, e] = p.p.map(scr);
      c.moveTo(a.x, a.y);
      c.bezierCurveTo(b.x, b.y, d.x, d.y, e.x, e.y);
      break;
    }
  }
}

/** Marks and numbers along the left and bottom edges, as on a drawing board's rules. */
function drawTicks(c: CanvasRenderingContext2D, w: number, h: number, v: View, ink: string, bg: string, units: Units): void {
  const step = niceStep(80 / v.scale);
  const tl = toWorld(v, w, h, P(0, 0));
  const br = toWorld(v, w, h, P(w, h));
  const label = (n: number) => {
    const digits = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
    return (Math.abs(n) < step / 1e6 ? 0 : n).toFixed(Math.min(digits, 6));
  };
  c.font = '12px Tahoma, "Segoe UI", sans-serif';
  c.fillStyle = bg;
  c.globalAlpha = 0.85;
  c.fillRect(0, 0, 44, h);
  c.fillRect(0, h - 26, w, 26);
  c.globalAlpha = 1;
  c.strokeStyle = ink;
  c.fillStyle = ink;
  c.lineWidth = 1;
  c.textBaseline = 'middle';
  c.textAlign = 'right';
  for (let y = Math.ceil(br.y / step) * step; y <= tl.y; y += step) {
    const sy = Math.round(toScreen(v, w, h, P(0, y)).y) + 0.5;
    if (sy > h - 30) continue;
    c.beginPath();
    c.moveTo(36, sy);
    c.lineTo(44, sy);
    c.stroke();
    c.fillText(label(y), 34, sy);
  }
  c.textAlign = 'center';
  c.textBaseline = 'alphabetic';
  for (let x = Math.ceil(tl.x / step) * step; x <= br.x; x += step) {
    const sx = Math.round(toScreen(v, w, h, P(x, 0)).x) + 0.5;
    if (sx < 50) continue;
    c.beginPath();
    c.moveTo(sx, h - 26);
    c.lineTo(sx, h - 19);
    c.stroke();
    c.fillText(label(x), sx, h - 6);
  }
  c.textAlign = 'left';
  c.fillText(units === 'mm' ? 'mm' : 'in', 6, h - 6);
}

/** The snap mark: each kind its own shape (and its name beside it), so colour is not the only clue. */
function drawSnap(c: CanvasRenderingContext2D, q: Pt, kind: Snap['kind'], white: boolean): void {
  const ink = white ? '#008000' : '#60ff60';
  const r = 6;
  c.strokeStyle = ink;
  c.lineWidth = 2;
  c.beginPath();
  switch (kind) {
    case 'end':
      c.rect(q.x - r, q.y - r, 2 * r, 2 * r);
      break;
    case 'mid':
      c.moveTo(q.x, q.y - r);
      c.lineTo(q.x + r, q.y + r * 0.8);
      c.lineTo(q.x - r, q.y + r * 0.8);
      c.closePath();
      break;
    case 'centre':
      c.arc(q.x, q.y, r, 0, Math.PI * 2);
      break;
    case 'intersection':
      c.moveTo(q.x - r, q.y - r);
      c.lineTo(q.x + r, q.y + r);
      c.moveTo(q.x + r, q.y - r);
      c.lineTo(q.x - r, q.y + r);
      break;
    case 'quadrant':
      c.moveTo(q.x, q.y - r);
      c.lineTo(q.x + r, q.y);
      c.lineTo(q.x, q.y + r);
      c.lineTo(q.x - r, q.y);
      c.closePath();
      break;
    case 'nearest':
      c.moveTo(q.x - r, q.y - r);
      c.lineTo(q.x + r, q.y - r);
      c.lineTo(q.x - r, q.y + r);
      c.lineTo(q.x + r, q.y + r);
      c.closePath();
      break;
    case 'perpendicular':
      c.moveTo(q.x - r, q.y - r);
      c.lineTo(q.x - r, q.y + r);
      c.lineTo(q.x + r, q.y + r);
      c.moveTo(q.x - r, q.y);
      c.lineTo(q.x, q.y);
      c.lineTo(q.x, q.y + r);
      break;
    case 'tangent':
      c.arc(q.x, q.y + 1, r - 1, 0, Math.PI * 2);
      c.moveTo(q.x - r - 2, q.y - r + 1);
      c.lineTo(q.x + r + 2, q.y - r + 1);
      break;
    default:
      c.moveTo(q.x - r, q.y);
      c.lineTo(q.x + r, q.y);
      c.moveTo(q.x, q.y - r);
      c.lineTo(q.x, q.y + r);
  }
  c.stroke();
  const name = SNAP_NAMES[kind];
  c.font = '12px Tahoma, "Segoe UI", sans-serif';
  const tw = c.measureText(name).width;
  c.fillStyle = white ? '#fffbe0' : '#000040';
  c.fillRect(q.x + 10, q.y + 8, tw + 8, 17);
  c.strokeStyle = ink;
  c.lineWidth = 1;
  c.strokeRect(q.x + 10.5, q.y + 8.5, tw + 7, 16);
  c.fillStyle = white ? '#000000' : '#ffffff';
  c.textBaseline = 'middle';
  c.textAlign = 'left';
  c.fillText(name, q.x + 14, q.y + 17);
}
