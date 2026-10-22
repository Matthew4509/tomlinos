// The parts library: a drawn group kept under a name (a hinge-hole pattern, a sink cut-out, a 32 mm shelf-hole row) and
// dropped into a drawing again at a point and a turn. A part is an ordinary .tcad drawing with its base point at 0,0,
// kept in one folder, so it opens, changes and saves as any drawing does. Placed, it becomes plain items of the
// drawing (lines, arcs, circles...), so the DXF for the CAM program holds nothing new.
// No browser needed here: reading and writing the folder is the window's job (cad.ts).
import { P, type Pt } from './geom.ts';
import { moveShape, rotateShape, scaleShape } from './edit.ts';
import { CONSTRUCTION, DIMENSIONS, GEOMETRY, TEXT, newDrawing, readTcad, rectangle, writeTcad, type Drawing, type Ent, type Shape, type Units } from './model.ts';

export const PARTS_FOLDER = '/Documents/CAD parts';
export const PART_EXT = '.tcad';

export interface PartItem {
  shape: Shape;
  /** The layer it was on in the part. */
  layer: string;
}

export interface Part {
  name: string;
  units: Units;
  items: PartItem[];
  /** One of the parts that come with CAD Draft (kept in the program, not in the folder). */
  starter?: boolean;
  /** What it is, for the box that lists the parts. */
  note?: string;
}

const hole = (x: number, y: number, d: number): PartItem => ({ shape: { type: 'circle', c: P(x, y), r: d / 2 }, layer: GEOMETRY });

/**
 * The parts that come with CAD Draft, in millimetres, each with its base point at 0,0. Sizes are the common ones;
 * the hardware maker's own drilling sheet decides.
 */
export const STARTER_PARTS: Part[] = [
  {
    name: 'Hinge cup 35 mm, screw holes 45 apart',
    note: 'A 35 mm cup with two 8 mm screw holes 45 mm apart, 9.5 mm further from the door edge than the cup (the usual European hinge pattern). Base point: the middle of the cup; the door edge is below it. How far the cup sits from the edge depends on the hinge: check its drilling sheet.',
    units: 'mm',
    items: [hole(0, 0, 35), hole(-22.5, 9.5, 8), hole(22.5, 9.5, 8)],
  },
  {
    name: 'Shelf-pin holes, 32 mm row of 10',
    note: 'Ten 5 mm holes at 32 mm centres (the 32 mm system). Base point: the first hole.',
    units: 'mm',
    items: Array.from({ length: 10 }, (_, i) => hole(32 * i, 0, 5)),
  },
  ...[96, 128, 160].map(c => ({
    name: `Handle holes ${c} mm`,
    note: `Two 5 mm holes ${c} mm apart, for a handle with ${c} mm screw centres. Base point: halfway between them.`,
    units: 'mm' as const,
    items: [hole(-c / 2, 0, 5), hole(c / 2, 0, 5)],
  })),
  {
    name: 'Sink cut-out 760 x 440, R15 corners (an example)',
    note: 'An example cut-out to change to the sink in hand: every sink comes with its own template, and that decides. Base point: the middle.',
    units: 'mm',
    items: [{ shape: rectangle(P(-380, -220), P(380, 220), 15)!, layer: GEOMETRY }],
  },
];

/** Why a part's name will not do as a file name, or null when it will. */
export function partNameProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return 'Type a name for the part.';
  if (n.length > 60) return 'At most 60 letters in a part’s name.';
  if (/[\\/:*?"<>|]/.test(n)) return 'A part’s name cannot have any of  \\ / : * ? " < > |  in it (it becomes a file name).';
  if (/^\.+$/.test(n)) return 'A part’s name needs a letter or number in it.';
  return null;
}

/** The chosen items as a part file: moved so the base point is at 0,0, with the layers they are on. */
export function writePart(d: Pick<Drawing, 'units' | 'layers' | 'style'>, ents: Ent[], base: Pt): string {
  const part = newDrawing(d.units);
  const used = new Set(ents.map(e => e.layer));
  part.layers = d.layers.filter(l => used.has(l.name)).map(l => ({ ...l, on: true, locked: false }));
  part.current = part.layers[0]?.name ?? GEOMETRY;
  part.style = d.style;
  part.ents = ents.map((e, i) => ({ ...moveShape(e, P(-base.x, -base.y)), id: i + 1, layer: e.layer }) as Ent);
  return writeTcad(part, { tomlinCadPart: 1 });
}

/** A part file read back (any .tcad will do: its 0,0 is the base point). Throws CadProblem when it cannot be read. */
export function readPart(name: string, text: string): Part {
  const { drawing } = readTcad(text);
  return { name, units: drawing.units, items: drawing.ents.map(({ id: _id, layer, ...shape }) => ({ shape: shape as Shape, layer })) };
}

/**
 * The layer a placed item goes on: construction lines, text and dimensions keep their own layer when the drawing has
 * one by that name; everything else goes on the current layer (where the person is drawing).
 */
export function layerFor(itemLayer: string, drawingLayers: string[], current: string): string {
  return [CONSTRUCTION, DIMENSIONS, TEXT].includes(itemLayer) && drawingLayers.includes(itemLayer) ? itemLayer : current;
}

/** The size factor from the part's units to the drawing's. */
export const unitFactor = (from: Units, to: Units): number => (from === to ? 1 : from === 'mm' ? 1 / 25.4 : 25.4);

/** The part's shapes placed: its base point at `at`, turned by `angle` (radians, anticlockwise), in the drawing's units. */
export function placePart(part: Part, units: Units, at: Pt, angle: number): Shape[] {
  const k = unitFactor(part.units, units);
  return part.items.map(({ shape }) => {
    let s = k === 1 ? shape : scaleShape(shape, P(0, 0), k);
    if (angle) s = rotateShape(s, P(0, 0), angle);
    return moveShape(s, at);
  });
}

/** Sorted by name, the person's own first, then the starters (an own part of the same name hides the starter). */
export function partList(own: Part[]): Part[] {
  const names = new Set(own.map(p => p.name.toLowerCase()));
  const byName = (a: Part, b: Part) => a.name.localeCompare(b.name, 'en', { numeric: true, sensitivity: 'base' });
  return [...[...own].sort(byName), ...STARTER_PARTS.filter(p => !names.has(p.name.toLowerCase())).map(p => ({ ...p, starter: true }))];
}
