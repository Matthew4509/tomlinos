// TOMLIN CAD's toolbar pictures, 16 by 16, drawn here from plain lines, circles and arcs: our own drawings, none
// copied from another program. A red dot marks a point the tool asks for; the snap pictures show the mark the
// drawing area puts on a snapped point.
import { svg } from '../../core/dom.ts';

const INK = '#202020';
const BLUE = '#1d4fb8';
const RED = '#c81e1e';
const GREEN = '#1e7a45';
const GOLD = '#b07a00';

const path = (d: string, stroke = INK, width = 1.3, fill = 'none') =>
  svg('path', { d, fill, stroke, 'stroke-width': width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
const circle = (cx: number, cy: number, r: number, stroke = INK, fill = 'none', width = 1.3) => svg('circle', { cx, cy, r, fill, stroke, 'stroke-width': width });
const dot = (cx: number, cy: number, colour = RED) => svg('circle', { cx, cy, r: 1.6, fill: colour });
const rect = (x: number, y: number, w: number, h: number, stroke = INK, fill = 'none', extra: Record<string, string | number> = {}) =>
  svg('rect', { x, y, width: w, height: h, fill, stroke, 'stroke-width': 1.2, ...extra });

const DRAW = {
  new: () => [path('M3.5 1.5h6l3 3v10h-9z', '#6b6b6b', 1, '#fff'), path('M9.5 1.5v3h3', '#6b6b6b', 1)],
  open: () => [path('M1.5 13.5v-10h4l1.5 1.5h5v2.5', '#a77d12', 1, '#e2b33c'), path('M1.5 13.5l2.5-6h11l-2.5 6z', '#a77d12', 1, '#f6cf5a')],
  save: () => [rect(1.5, 1.5, 13, 13, '#1b3f7a', '#2f6fd0', { rx: 1 }), rect(4, 2, 8, 4.5, 'none', '#fff'), rect(4.5, 9.5, 7, 5, 'none', '#dfe6f0')],
  undo: () => [path('M5 4H10a3.5 3.5 0 0 1 0 7H6', GREEN, 1.6), path('M7 1.5L4.5 4 7 6.5', GREEN, 1.6)],
  redo: () => [path('M11 4H6a3.5 3.5 0 0 0 0 7h4', GREEN, 1.6), path('M9 1.5L11.5 4 9 6.5', GREEN, 1.6)],
  line: () => [path('M3 13L13 3', BLUE, 1.5), dot(3, 13), dot(13, 3)],
  polyline: () => [path('M2 13L6 5l4 6 4-8', BLUE, 1.4), dot(2, 13), dot(14, 3)],
  rect: () => [rect(2.5, 4.5, 11, 8, BLUE), dot(2.5, 12.5), dot(13.5, 4.5)],
  rectCentre: () => [rect(2.5, 4.5, 11, 8, BLUE), dot(8, 8.5)],
  rectRound: () => [rect(2.5, 4.5, 11, 8, BLUE, 'none', { rx: 2.5 })],
  circle: () => [circle(8, 8, 5.5, BLUE), dot(8, 8)],
  circle2: () => [circle(8, 8, 5.5, BLUE), dot(2.5, 8), dot(13.5, 8)],
  circle3: () => [circle(8, 8, 5.5, BLUE), dot(2.5, 8), dot(8, 2.5), dot(12, 12)],
  circleTtr: () => [path('M1.5 14.5L14.5 14.5M1.5 14.5L1.5 1.5', INK, 1.2), circle(6.5, 9.5, 4.5, BLUE)],
  circleTtt: () => [path('M1.5 14.5L14.5 14.5M1.5 14.5L1.5 1.5M14.5 14.5L14.5 1.5', INK, 1.2), circle(8, 9, 5, BLUE)],
  arc: () => [path('M2.5 12a6 6 0 0 1 11 0', BLUE, 1.5), dot(2.5, 12), dot(8, 6.1), dot(13.5, 12)],
  arcCentre: () => [path('M13.5 9a5.5 5.5 0 0 0-9.5-4', BLUE, 1.5), path('M8 9L13.5 9M8 9L4 5', '#808080', 0.9), dot(8, 9)],
  ellipse: () => [svg('ellipse', { cx: 8, cy: 8, rx: 6.5, ry: 4, fill: 'none', stroke: BLUE, 'stroke-width': 1.4 })],
  polygon: () => [path('M8 1.8l5.4 3.1v6.2L8 14.2l-5.4-3.1V4.9z', BLUE, 1.3)],
  polygonOut: () => [path('M8 1.8l5.4 3.1v6.2L8 14.2l-5.4-3.1V4.9z', BLUE, 1.3), circle(8, 8, 5.3, '#909090', 'none', 0.8)],
  slot: () => [path('M5 5h6a3 3 0 0 1 0 6H5a3 3 0 0 1 0-6z', BLUE, 1.4), dot(5, 8), dot(11, 8)],
  spline: () => [path('M1.5 12c2-8 5-8 6.5-4s4.5 4 6.5-4', GOLD, 1.5), dot(1.5, 12), dot(8, 8), dot(14.5, 4)],
  point: () => [path('M4 4l8 8M12 4l-8 8', RED, 1.4)],
  xlineH: () => [path('M0.5 8H15.5', '#b02cb0', 1.3, 'none'), dot(8, 8)],
  xlineV: () => [path('M8 0.5V15.5', '#b02cb0', 1.3), dot(8, 8)],
  xlineAngle: () => [path('M1 15L15 1', '#b02cb0', 1.3), path('M3 15A4 4 0 0 0 4.5 11.8', INK, 0.9), dot(8, 8)],
  xlineOffset: () => [path('M1 12L15 12', INK, 1.3), path('M1 5L15 5', '#b02cb0', 1.3), path('M11 6.5v4M10 7.5l1-1 1 1M10 9.5l1 1 1-1', INK, 0.9)],
  tanLine: () => [circle(5, 9, 3.5, INK, 'none', 1.2), path('M1.5 5.5L14 2', BLUE, 1.4), dot(14, 2)],
  tanTwo: () => [circle(4.5, 10, 3, INK, 'none', 1.2), circle(11.5, 9.5, 2.5, INK, 'none', 1.2), path('M2.3 7.6L10.5 7.2', BLUE, 1.4)],
  select: () => [path('M3 1.5v11l3-3 2.2 5 1.8-.8-2.2-4.8H12z', '#000', 1, '#fff')],
  // An open hand (Move is the four arrows).
  pan: () => [path('M5.5 8.5V3.5a1 1 0 0 1 2 0V7.5M7.5 7V2.5a1 1 0 0 1 2 0V7M9.5 7V3.5a1 1 0 0 1 2 0V8M11.5 8V5.5a1 1 0 0 1 2 0V10c0 2.8-2 4.5-4.5 4.5-2 0-3-.8-4-2.3L2.6 9.5a1 1 0 0 1 1.6-1.2L5.5 10', INK, 1.1, '#f3e2c4')],
  zoomFit: () => [rect(1.5, 1.5, 13, 13, '#707070'), path('M4 6V4h2M10 4h2v2M12 10v2h-2M6 12H4v-2', BLUE, 1.4)],
  zoomWindow: () => [rect(1.5, 2.5, 9, 7, '#707070', 'none', { 'stroke-dasharray': '2 1.2' }), circle(10, 10, 3, INK), path('M12.2 12.2L15 15', INK, 1.8)],
  zoomPrev: () => [circle(7, 7, 4.5, INK), path('M10.3 10.3L14.5 14.5', INK, 1.8), path('M5 7h4', GREEN, 1.4), path('M6.3 5.5L4.8 7l1.5 1.5', GREEN, 1.2)],
  zoomIn: () => [circle(7, 7, 4.5, INK), path('M10.3 10.3L14.5 14.5', INK, 1.8), path('M5 7h4M7 5v4', INK, 1.3)],
  zoomOut: () => [circle(7, 7, 4.5, INK), path('M10.3 10.3L14.5 14.5', INK, 1.8), path('M5 7h4', INK, 1.3)],
  move: () => [path('M8 1.5v13M1.5 8h13', BLUE, 1.3), path('M6 3.5l2-2 2 2M6 12.5l2 2 2-2M3.5 6l-2 2 2 2M12.5 6l2 2-2 2', BLUE, 1.3)],
  copy: () => [rect(1.5, 1.5, 8, 8, '#707070'), rect(6.5, 6.5, 8, 8, BLUE, '#fff')],
  rotate: () => [path('M13 8a5 5 0 1 1-1.6-3.7', BLUE, 1.5), path('M12.2 1.6l-.6 3.1-3.1-.6', BLUE, 1.4), dot(8, 8)],
  mirror: () => [path('M8 1v14', '#808080', 1, 'none'), path('M6 3L2 13h4z', INK, 1.1, '#cfd8ea'), path('M10 3l4 10h-4z', BLUE, 1.1, '#cfd8ea')],
  scale: () => [rect(1.5, 8.5, 6, 6, '#707070'), rect(1.5, 2.5, 12, 12, BLUE), path('M6 10l7-7M9.5 3H13v3.5', BLUE, 1.2)],
  arrayLine: () => [rect(1.5, 6, 3.5, 3.5, BLUE), rect(6.25, 6, 3.5, 3.5, BLUE), rect(11, 6, 3.5, 3.5, BLUE)],
  arrayPolar: () => [circle(8, 8, 1, INK, INK), rect(6.5, 1, 3, 3, BLUE), rect(12, 6.5, 3, 3, BLUE), rect(6.5, 12, 3, 3, BLUE), rect(1, 6.5, 3, 3, BLUE)],
  delete: () => [path('M3.5 3.5l9 9M12.5 3.5l-9 9', RED, 2)],
  chain: () => [path('M2 12h5l3-6h4', BLUE, 1.4), dot(2, 12, BLUE), dot(14, 6, BLUE), dot(7, 12, BLUE), dot(10, 6, BLUE)],
  measure: () => [rect(1, 5, 14, 6, '#8a6a10', '#f4d77c'), path('M3.5 5v2.5M6 5v1.5M8.5 5v2.5M11 5v1.5M13.5 5v2.5', '#5a4500', 0.9)],
  list: () => [rect(2.5, 1.5, 11, 13, '#707070', '#fff'), path('M5 5h6M5 8h6M5 11h4', BLUE, 1.2)],
  // The CAD menu.
  trim: () => [path('M2 3l12 10', '#909090', 1, 'none'), path('M8 1v14', INK, 1.3), path('M2 3l6 5', BLUE, 1.6), path('M11 9.5l3 3', RED, 1.4)],
  extend: () => [path('M13 1v14', INK, 1.4), path('M2 8h5', BLUE, 1.6), path('M7 8h6', BLUE, 1, 'none'), path('M10 6l2.5 2-2.5 2', BLUE, 1.2)],
  breakPoint: () => [path('M1.5 10L7 6.5M9 5.5L14.5 2', BLUE, 1.6), path('M6 3l4 6', RED, 1.1)],
  breakTwo: () => [path('M1.5 8H5M11 8h3.5', BLUE, 1.6), dot(5, 8), dot(11, 8)],
  fillet: () => [path('M2 14V8a5 5 0 0 1 5-5h7', BLUE, 1.6), path('M2 3h5', '#909090', 0.9), dot(2, 8), dot(7, 3)],
  filletAll: () => [rect(2.5, 2.5, 11, 11, BLUE, 'none', { rx: 3.5 })],
  chamfer: () => [path('M2 14V7l4-4h8', BLUE, 1.6), path('M2 7V3h4', '#909090', 0.9)],
  offset: () => [path('M2 12L12 2', BLUE, 1.5), path('M5 14L14 5', INK, 1.2, 'none'), path('M8 9l2 2', RED, 1)],
  join: () => [path('M2 11h5', BLUE, 1.6), path('M9 11a3 3 0 0 0 3-3V3', BLUE, 1.6), path('M6 9l2 2-2 2', RED, 1.1)],
  explode: () => [path('M2 11h4M10 11a2 2 0 0 0 2-2V5', BLUE, 1.5), path('M8 3v2M3 6l1.5 1.5M13 13l-1.5-1.5', RED, 1.1)],
  closeGeo: () => [path('M3 13V4h10v9', BLUE, 1.5), path('M3 13h10', RED, 1.4, 'none')],
  startPoint: () => [rect(3, 3, 10, 10, BLUE), circle(3, 13, 2.4, RED, 'none', 1.4)],
  reverse: () => [path('M3 6h9l-2.5-2.5', BLUE, 1.5), path('M13 11H4l2.5 2.5', GREEN, 1.5)],
  direction: () => [path('M2 12h12', BLUE, 1.3), path('M6 9l3 3-3 3', '#c06000', 1.6), circle(2, 12, 1.8, '#c06000')],
  angle: () => [path('M2 14L14 14M2 14L11 3', INK, 1.3), path('M8 14a6 6 0 0 0-2-4.5', RED, 1.2)],
  area: () => [path('M2 13l3-10h8l1 10z', BLUE, 1.2, '#cfd8ea')],
  info: () => [circle(8, 8, 6.5, BLUE, '#e8eefa', 1.2), path('M8 7v5', BLUE, 1.8), dot(8, 4.3, BLUE)],
  // Snap pictures: the same marks as in the drawing area.
  snapEnd: () => [path('M2 13L13 2', '#707070', 1), rect(10, 1, 4.5, 4.5, GREEN, 'none', { 'stroke-width': 1.6 })],
  snapMid: () => [path('M1 13L15 3', '#707070', 1), path('M8 5.2l3 5H5z', GREEN, 1.5)],
  snapCentre: () => [circle(8, 8, 6, '#707070', 'none', 1), circle(8, 8, 2.3, GREEN, 'none', 1.6)],
  snapIntersection: () => [path('M1 14L15 2M1 2l14 12', '#707070', 1), path('M5.5 5.5l5 5M10.5 5.5l-5 5', GREEN, 1.8)],
  snapQuadrant: () => [path('M2 14a12 12 0 0 1 12-12', '#707070', 1), path('M8 4.5l3 3-3 3-3-3z', GREEN, 1.5)],
  snapNearest: () => [path('M1 12L15 6', '#707070', 1), path('M5.5 6h5l-5 5h5z', GREEN, 1.4)],
  snapPerpendicular: () => [path('M2 13.5h12', '#707070', 1), path('M8 13.5V2.5', INK, 1), path('M8 10.5h3v3', GREEN, 1.5)],
  snapTangent: () => [circle(8, 9.5, 4.5, '#707070', 'none', 1), path('M1.5 5h13', GREEN, 1.6)],
  snapGrid: () => [path('M4 2v12M8 2v12M12 2v12M2 4h12M2 8h12M2 12h12', '#9a9a9a', 0.8), circle(8, 8, 1.7, GREEN, GREEN)],
} satisfies Record<string, () => SVGElement[]>;

export type CadIcon = keyof typeof DRAW;

/** One toolbar picture; screen readers skip it (its button carries the name). */
export function cadIcon(name: CadIcon): SVGElement {
  return svg('svg', { class: 'tb-icon', width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' }, ...DRAW[name]());
}
