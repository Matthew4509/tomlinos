// The Workshop icon set: a second look for CAD Draft's toolbar pictures, chosen in View > Icon style and
// kept with CAD Draft's other settings. Every picture is 16 by 16 and made only of paths, each with one stroke colour,
// an optional fill and one line width, with round ends and joins. The drawn shapes are slate ink, the points a tool
// asks for are small blue dots, snap marks are red, construction lines teal and the measuring tools amber.
// Standard is the set in icons.ts; this one has a drawing for every name that set has.
import { svg } from '../../core/dom.ts';
import type { ToolIconId } from '../../shell/toolicons.ts';
import type { CadIcon } from './icons.ts';

/** The two sets a person can choose between. */
export const ICON_STYLES = ['standard', 'workshop'] as const;
export type IconStyle = (typeof ICON_STYLES)[number];
/** As View > Icon style names them. */
export const ICON_STYLE_NAMES: Record<IconStyle, string> = { standard: 'Standard', workshop: 'Workshop' };

/** A kept setting read back: anything but a known set name is the Standard set. */
export function readIconStyle(v: unknown): IconStyle {
  return typeof v === 'string' && (ICON_STYLES as readonly string[]).includes(v) ? (v as IconStyle) : 'standard';
}

/** One drawn path: its data, stroke colour, fill (null: none) and line width. */
export type WorkshopPart = readonly [d: string, stroke: string, fill: string | null, width: number];

const INK = '#2B3A4A';
const BLUE = '#2F6FDB';
const TEAL = '#0E8A7A';
const AMBER = '#E08A1E';
const RED = '#C8372D';
const GREEN = '#2E8B57';
const PAPER = '#FFFFFF';
const FOLDER = '#E9B949';
const BROWN = '#8A6A1F';
const NAVY = '#1F3C66';
const GREY = '#8A96A3';
const STEEL = '#C9D1DA';
const MIST = '#DCE6F2';
const SAND = '#F6D9A8';
const SKY = '#CFE0F5';
const LEAF = '#D4EDDA';
const STRAW = '#F2C27A';

/** Rounded to a hundredth, so the path data stays short. */
const n = (v: number) => String(Math.round(v * 100) / 100);
/** A whole circle as path data (two half arcs). */
const ring = (cx: number, cy: number, r: number) => `M${n(cx - r)},${n(cy)} a${n(r)},${n(r)} 0 1,0 ${n(2 * r)},0 a${n(r)},${n(r)} 0 1,0 ${n(-2 * r)},0`;
/** A point the tool asks for: a small blue dot. */
const pt = (x: number, y: number): WorkshopPart => [ring(x, y, 1.5), BLUE, BLUE, 0.5];
/** A small centre dot. */
const centre = (x: number, y: number, colour = BLUE): WorkshopPart => [ring(x, y, 1), colour, colour, 0.5];
const MAGNIFIER: WorkshopPart[] = [[ring(6.5, 6.5, 4.5), INK, PAPER, 1.3], ['M10,10 L14.5,14.5', INK, null, 2]];

const DRAW: Record<CadIcon, readonly WorkshopPart[]> = {
  // Files and the edit history.
  new: [['M3.5,1.5 H10 L12.5,4 V14.5 H3.5 Z', INK, PAPER, 1], ['M10,1.5 V4 H12.5', INK, null, 1]],
  open: [['M1.5,4.5 H6 L7.5,6 H13.5 V13.5 H1.5 Z', BROWN, FOLDER, 1]],
  save: [['M2,2 H12 L14,4 V14 H2 Z', NAVY, BLUE, 1], ['M4.5,2.5 H10.5 V6 H4.5 Z', PAPER, PAPER, 0.5], ['M4.5,9 H11.5 V13.5 H4.5 Z', PAPER, PAPER, 0.5]],
  undo: [['M4,7 C6,3 12,3 13,8 C13.5,11 11,13 8.5,13', TEAL, null, 1.6], ['M2,3.5 L4,7.5 L8,6', TEAL, null, 1.6]],
  redo: [['M12,7 C10,3 4,3 3,8 C2.5,11 5,13 7.5,13', TEAL, null, 1.6], ['M14,3.5 L12,7.5 L8,6', TEAL, null, 1.6]],
  dxfOut: [['M1.5,2 H10 V14 H1.5 Z', INK, PAPER, 1], ['M3.5,12 A4.5,4.5 0 0,1 8,5', BLUE, null, 1.2], ['M10,8 H15 M13,5.8 L15.3,8 L13,10.2', AMBER, null, 1.5]],
  print: [['M2,6 H14 V11 H2 Z', INK, STEEL, 1], ['M4.5,2 H11.5 V6 H4.5 Z', INK, PAPER, 1], ['M4.5,9.5 H11.5 V14 H4.5 Z', INK, PAPER, 1]],
  photo: [['M1.5,2.5 H14.5 V13.5 H1.5 Z', INK, MIST, 1], ['M2,13 L6,8.5 L9,11.5 L11,9.5 L14,13 Z', GREEN, LEAF, 1], [ring(11, 5.5, 1.4), AMBER, STRAW, 0.8]],

  // Draw.
  line: [['M2.5,13.5 L13.5,2.5', INK, null, 1.5], pt(2.5, 13.5), pt(13.5, 2.5)],
  polyline: [['M1.5,13 L5,4 L9,10 L14.5,3', INK, null, 1.5]],
  rect: [['M2,4 H14 V12 H2 Z', INK, null, 1.5]],
  rectCentre: [['M2,4 H14 V12 H2 Z', INK, null, 1.5], pt(8, 8)],
  rectRound: [['M4.5,4 H11.5 A2.5,2.5 0 0,1 14,6.5 V9.5 A2.5,2.5 0 0,1 11.5,12 H4.5 A2.5,2.5 0 0,1 2,9.5 V6.5 A2.5,2.5 0 0,1 4.5,4 Z', INK, null, 1.5]],
  circle: [[ring(8, 8, 6), INK, null, 1.5], centre(8, 8)],
  circle2: [[ring(8, 8, 6), INK, null, 1.5], pt(2, 8), pt(14, 8)],
  circle3: [[ring(8, 8, 6), INK, null, 1.5], pt(2, 8), pt(8, 2), pt(12.2, 12.2)],
  circleTtr: [['M1.5,14.5 H14.5 M1.5,14.5 V1.5', GREY, null, 1.2], [ring(6.5, 9.5, 4.5), INK, null, 1.5], ['M6.5,9.5 L9.7,6.3', BLUE, null, 1]],
  circleTtt: [['M1.5,14.5 H14.5 M1.5,14.5 V1.5 M14.5,14.5 V1.5', GREY, null, 1.2], [ring(8, 8.5, 6), INK, null, 1.5]],
  arc: [['M2,13 A7,7 0 0,1 14,13', INK, null, 1.5], pt(2, 13), pt(8, 2.4), pt(14, 13)],
  arcCentre: [['M13.5,9 A5.5,5.5 0 0,0 4.1,5.1', INK, null, 1.5], ['M8,9 H13.5 M8,9 L4.1,5.1', GREY, null, 1], centre(8, 9)],
  ellipse: [['M1.5,8 a6.5,4 0 1,0 13,0 a6.5,4 0 1,0 -13,0', INK, null, 1.5]],
  polygon: [['M8,1.8 L14,6.2 L11.7,13.5 H4.3 L2,6.2 Z', INK, null, 1.4]],
  polygonOut: [['M8,1.8 L14,6.2 L11.7,13.5 H4.3 L2,6.2 Z', INK, null, 1.4], [ring(8, 8.3, 5), GREY, null, 0.9]],
  slot: [['M5,5 H11 A3,3 0 0,1 11,11 H5 A3,3 0 0,1 5,5 Z', INK, null, 1.5], pt(5, 8), pt(11, 8)],
  spline: [['M1.5,12 C4,2 7,2 8,8 C9,14 12,14 14.5,4', INK, null, 1.5]],
  point: [['M4,4 L12,12 M12,4 L4,12', BLUE, null, 1.6]],

  // Construction lines and tangents.
  xlineH: [['M0.5,8 H15.5', TEAL, null, 1.4], pt(8, 8)],
  xlineV: [['M8,0.5 V15.5', TEAL, null, 1.4], pt(8, 8)],
  xlineAngle: [['M1.5,14.5 L14.5,1.5', TEAL, null, 1.4], ['M1.5,14.5 H7', GREY, null, 1], ['M6,14.5 A4.5,4.5 0 0,0 4.7,11.3', INK, null, 1], pt(8, 8)],
  xlineOffset: [['M1,12 H15', INK, null, 1.3], ['M1,4.5 H15', TEAL, null, 1.4], ['M8,6 V10.5 M6.5,7.5 L8,6 L9.5,7.5 M6.5,9 L8,10.5 L9.5,9', BLUE, null, 1]],
  tanLine: [[ring(5, 8.2, 3.5), INK, null, 1.3], ['M1,5.6 L14.5,2', BLUE, null, 1.4], pt(14.5, 2)],
  tanTwo: [[ring(4.5, 10, 3), INK, null, 1.3], [ring(11.5, 10, 3), INK, null, 1.3], ['M4.5,7 H11.5', BLUE, null, 1.4]],

  // Select and zoom.
  select: [['M3,1.5 V12.5 L6,9.5 L8.2,14.5 L10,13.7 L7.8,8.9 H12 Z', INK, PAPER, 1]],
  pan: [['M5.5,9 V4 A1,1 0 0,1 7.5,4 V8 V2.8 A1,1 0 0,1 9.5,2.8 V8 V3.8 A1,1 0 0,1 11.5,3.8 V8.5 V5.8 A1,1 0 0,1 13.5,5.8 V10 C13.5,12.8 11.6,14.5 9,14.5 C7.2,14.5 6.2,13.8 5.2,12.4 L2.7,9.6 A1,1 0 0,1 4.2,8.4 L5.5,9.8 Z', INK, SAND, 1]],
  zoomFit: [['M1.5,5 V1.5 H5 M11,1.5 H14.5 V5 M14.5,11 V14.5 H11 M5,14.5 H1.5 V11', INK, null, 1.3], ['M5,5 H11 V11 H5 Z', BLUE, null, 1.2]],
  zoomWindow: [...MAGNIFIER, ['M4.5,4.5 H8.5 V8.5 H4.5 Z', BLUE, null, 1]],
  zoomPrev: [...MAGNIFIER, ['M4.5,6.5 H8.5 M6,5 L4.5,6.5 L6,8', TEAL, null, 1.3]],
  zoomIn: [...MAGNIFIER, ['M4.5,6.5 H8.5 M6.5,4.5 V8.5', GREEN, null, 1.4]],
  zoomOut: [...MAGNIFIER, ['M4.5,6.5 H8.5', RED, null, 1.4]],

  // Modify.
  move: [['M8,1.5 V14.5 M1.5,8 H14.5 M6,3.5 L8,1.5 L10,3.5 M6,12.5 L8,14.5 L10,12.5 M3.5,6 L1.5,8 L3.5,10 M12.5,6 L14.5,8 L12.5,10', INK, null, 1.3]],
  copy: [['M2,2 H10 V10 H2 Z', INK, PAPER, 1], ['M6,6 H14 V14 H6 Z', BLUE, PAPER, 1]],
  rotate: [['M13,8 A5,5 0 1,1 8,3', INK, null, 1.5], ['M6,1 L8.5,3 L6,5.5', INK, null, 1.3], centre(8, 8)],
  mirror: [['M8,1 V15', GREY, null, 1], ['M6,3 L2,13 H6 Z', INK, null, 1.2], ['M10,3 L14,13 H10 Z', BLUE, null, 1.2]],
  scale: [['M2,8 H8 V14 H2 Z', INK, null, 1.2], ['M2,2 H14 V14', BLUE, null, 1.2], ['M8,8 L13,3', BLUE, null, 1.2]],
  arrayLine: [['M2,2 H6 V6 H2 Z M10,2 H14 V6 H10 Z M2,10 H6 V14 H2 Z', INK, null, 1.1], ['M10,10 H14 V14 H10 Z', BLUE, null, 1.1]],
  arrayPolar: [centre(8, 8, INK), ['M6.5,1 H9.5 V4 H6.5 Z M12,6.5 H15 V9.5 H12 Z M1,6.5 H4 V9.5 H1 Z', INK, null, 1.1], ['M6.5,12 H9.5 V15 H6.5 Z', BLUE, null, 1.1]],
  delete: [['M3,3 L13,13 M13,3 L3,13', RED, null, 2]],
  chain: [['M2,12 H7 L10,5 H14', INK, null, 1.5], [`${ring(7, 12, 1.3)} ${ring(10, 5, 1.3)}`, GREEN, GREEN, 0.5]],

  // Measure.
  measure: [['M1.5,10 L10,1.5 L14.5,6 L6,14.5 Z', AMBER, SAND, 1], ['M5,9 L6.5,10.5 M7,7 L8.5,8.5 M9,5 L10.5,6.5', INK, null, 1]],
  list: [['M2.5,1.5 H13.5 V14.5 H2.5 Z', INK, PAPER, 1], ['M4.5,4.5 h0.1 M4.5,8 h0.1 M4.5,11.5 h0.1', RED, null, 1.6], ['M7,4.5 H11.5 M7,8 H11.5 M7,11.5 H11.5', BLUE, null, 1]],
  angle: [['M2,14 H14 M2,14 L11,3', INK, null, 1.3], ['M8,14 A6,6 0 0,0 5.8,9.4', AMBER, null, 1.3]],
  area: [['M2,13 L5,3 H13 L14,13 Z', INK, SKY, 1.2], ['M5.5,10.5 L9,7 M8.5,11.5 L12,8', BLUE, null, 0.9]],
  info: [[ring(8, 8, 6.5), BLUE, BLUE, 1], ['M8,7 V12', PAPER, null, 1.8], ['M8,4.3 V4.6', PAPER, null, 1.9]],

  // Trim, break, fillet and offset.
  trim: [['M8,1.5 V14.5', INK, null, 1.5], ['M1.5,8 H8', INK, null, 1.5], ['M8,8 H14.5', RED, null, 1.3]],
  extend: [['M13,1.5 V14.5', INK, null, 1.5], ['M1.5,8 H7', INK, null, 1.5], ['M7,8 H13', GREEN, null, 1.3]],
  breakPoint: [['M1.5,8 H6.5 M9.5,8 H14.5', INK, null, 1.5], ['M8,4 V12', RED, null, 1.2]],
  breakTwo: [['M1.5,8 H5 M11,8 H14.5', INK, null, 1.5], ['M5,5 V11 M11,5 V11', RED, null, 1.2]],
  fillet: [['M2,8 V2 H8', GREY, null, 1], ['M2,14 V8 A6,6 0 0,1 8,2 H14', INK, null, 1.5]],
  filletAll: [['M5.5,2.5 H10.5 A3,3 0 0,1 13.5,5.5 V10.5 A3,3 0 0,1 10.5,13.5 H5.5 A3,3 0 0,1 2.5,10.5 V5.5 A3,3 0 0,1 5.5,2.5 Z', INK, null, 1.5]],
  chamfer: [['M2,7 V2 H7', GREY, null, 1], ['M2,14 V7 L7,2 H14', INK, null, 1.5]],
  offset: [['M2,2 H14 V14 H2 Z', TEAL, null, 1.2], ['M5,5 H11 V11 H5 Z', INK, null, 1.2]],

  // Geometries.
  join: [['M2,12 L6,4 H10 L14,12', INK, null, 1.5], [`${ring(6, 4, 1.5)} ${ring(10, 4, 1.5)}`, GREEN, GREEN, 0.5]],
  explode: [['M2,6 L6,2 M10,2 L14,6 M14,10 L10,14 M6,14 L2,10', INK, null, 1.5]],
  closeGeo: [['M3,13 V3 H13 V13', INK, null, 1.5], ['M3,13 H13', GREEN, null, 1.5]],
  startPoint: [['M3,3 H13 V13 H3 Z', INK, null, 1.2], [ring(3, 3, 2), GREEN, GREEN, 0.5]],
  reverse: [['M2,5 H13 M10,2 L13,5 L10,8', INK, null, 1.4], ['M14,11 H3 M6,8 L3,11 L6,14', BLUE, null, 1.4]],
  direction: [['M2,12 H14', INK, null, 1.3], ['M7,9.5 L9.5,12 L7,14.5', AMBER, null, 1.6], [ring(2, 12, 1.5), AMBER, AMBER, 0.5]],

  // Snaps: the drawn shape in ink, the snap mark in red.
  snapEnd: [['M2,14 L12,4', INK, null, 1.3], ['M10,1.5 H14.5 V6 H10 Z', RED, null, 1.2]],
  snapMid: [['M2,13 L14,3', INK, null, 1.3], ['M5.5,10.5 H10.5 L8,5.5 Z', RED, null, 1.1]],
  snapCentre: [[ring(8, 8, 6), INK, null, 1.2], ['M6,8 H10 M8,6 V10', RED, null, 1.3]],
  snapIntersection: [['M2,2 L14,14 M14,2 L2,14', INK, null, 1.2], ['M5.5,5.5 H10.5 V10.5 H5.5 Z', RED, null, 1.1]],
  snapQuadrant: [[ring(8, 9, 5.5), INK, null, 1.2], ['M8,1.3 L10.2,3.5 L8,5.7 L5.8,3.5 Z', RED, null, 1.1]],
  snapNearest: [['M1.5,12 L14.5,6', INK, null, 1.3], ['M5.5,6 H10.5 L5.5,11 H10.5 Z', RED, null, 1.1]],
  snapPerpendicular: [['M1.5,13.5 H14.5 M8,13.5 V2', INK, null, 1.3], ['M8,10 H11.5 V13.5', RED, null, 1.1]],
  snapTangent: [[ring(8, 10, 4.5), INK, null, 1.2], ['M1.5,5.5 H14.5', RED, null, 1.4]],
  snapGrid: [['M4,2 V14 M8,2 V14 M12,2 V14 M2,4 H14 M2,8 H14 M2,12 H14', GREY, null, 0.8], [ring(8, 8, 1.8), RED, RED, 0.5]],

  // Text and dimensions.
  text: [['M3,3 H13 M8,3 V14', INK, null, 2]],
  textArc: [['M1.5,14 A7,7 0 0,1 14.5,14', GREY, null, 1], ['M5,3 H11 M8,3 V9.5', INK, null, 1.6]],
  textBox: [['M2.5,3.5 H13.5 V12.5 H2.5 Z', GREY, null, 1], ['M5,6 H11 M8,6 V11', INK, null, 1.6], ['M1,2 H4 V5 H1 Z M12,11 H15 V14 H12 Z', INK, PAPER, 0.9]],
  textWarp: [['M1.5,6 Q8,1 14.5,6 M1.5,14 Q8,9 14.5,14', GREY, null, 1], ['M4,6.5 Q8,4 12,6.5 M8,5.2 V12', INK, null, 1.6]],
  textEdit: [['M2,3 H9 M5.5,3 V12', INK, null, 1.8], ['M8.5,14 L9.3,11.5 L13.3,7.5 L15,9.2 L11,13.2 Z', INK, FOLDER, 1]],
  dimLinear: [['M2,3 V13 M14,3 V13', GREY, null, 1], ['M2.5,9 H13.5', BLUE, null, 1.1], ['M2.2,9 L5,7.5 V10.5 Z M13.8,9 L11,7.5 V10.5 Z', BLUE, BLUE, 0.6], ['M6.5,5.5 H9.5', INK, null, 1.2]],
  dimAligned: [['M2,10 L5,13 M10,2 L13,5', GREY, null, 1], ['M3.5,11.5 L11.5,3.5', BLUE, null, 1.1], ['M3.2,11.8 L4.3,8.8 L6.2,10.7 Z M11.8,3.2 L10.7,6.2 L8.8,4.3 Z', BLUE, BLUE, 0.6]],
  dimRadius: [[ring(6.5, 9.5, 5.5), GREY, null, 1], ['M6.5,9.5 L10.4,5.6', BLUE, null, 1.2], ['M10.9,5.1 L9.9,8 L8,6.1 Z', BLUE, BLUE, 0.6], centre(6.5, 9.5)],
  dimDiameter: [[ring(8, 8, 5.5), GREY, null, 1], ['M4.6,11.4 L11.4,4.6', BLUE, null, 1.2], ['M11.9,4.1 L10.9,7 L9,5.1 Z M4.1,11.9 L5.1,9 L7,10.9 Z', BLUE, BLUE, 0.6]],
  dimAngle: [['M2,13.5 H14.5 M2,13.5 L12,3.5', GREY, null, 1], ['M11,13.5 A9,9 0 0,0 8.4,7.1', BLUE, null, 1.2]],
  leader: [['M3,3 L8.5,10.5 H14', BLUE, null, 1.2], ['M2.5,2.3 L6,4.2 L4.2,5.6 Z', BLUE, BLUE, 0.6]],
};

/** The desktop's own pictures that CAD Draft's toolbars use in the Standard set, and the Workshop drawing for each. */
export const WORKSHOP_FOR_DESKTOP = {
  new: 'new', open: 'open', save: 'save', print: 'print', undo: 'undo', redo: 'redo', delete: 'delete',
  'zoom-fit': 'zoomFit', 'zoom-in': 'zoomIn', 'zoom-out': 'zoomOut',
} as const satisfies Partial<Record<ToolIconId, CadIcon>>;
export type DesktopIcon = keyof typeof WORKSHOP_FOR_DESKTOP;

/** The names that have a Workshop drawing. */
export const WORKSHOP_NAMES = Object.keys(DRAW) as CadIcon[];

/** The paths of one Workshop picture (for checks; an unknown name has none). */
export function workshopParts(name: string): readonly WorkshopPart[] | null {
  return Object.hasOwn(DRAW, name) ? DRAW[name as CadIcon] : null;
}

/** One toolbar picture in the Workshop set; screen readers skip it (its button carries the name). */
export function workshopIcon(name: CadIcon): SVGElement {
  return svg('svg', { class: 'tb-icon cad-ws-icon', width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' },
    ...DRAW[name].map(([d, stroke, fill, width]) =>
      svg('path', { d, stroke, fill: fill ?? 'none', 'stroke-width': width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })));
}
