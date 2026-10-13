// Typefaces and sizes a cell can have (Home > Font). A cell with no typeface of its own shows in the standard one, and
// Excel files get Calibri 11, as Excel's own standard. Each typeface is drawn with look-alikes after it, for computers
// that do not have it (Carlito looks like Calibri, Liberation like Arial, Times New Roman and Courier New).

/** The size a cell's text has when it has none of its own, in points, as Excel's standard. */
export const STANDARD_SIZE = 11;
/** The standard size on screen, in pixels at 100%. */
export const STANDARD_PX = 13;

export const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72];

export type FontKind = 'sans' | 'serif' | 'mono';

/** The typefaces offered, with their kind and the look-alikes drawn when the computer lacks them. */
export const FONT_FACES: Array<{ name: string; kind: FontKind; stand: string }> = [
  { name: 'Calibri', kind: 'sans', stand: 'Carlito, "Segoe UI", Arial, sans-serif' },
  { name: 'Aptos', kind: 'sans', stand: '"Segoe UI", Arial, sans-serif' },
  { name: 'Arial', kind: 'sans', stand: '"Liberation Sans", Helvetica, sans-serif' },
  { name: 'Segoe UI', kind: 'sans', stand: 'Arial, sans-serif' },
  { name: 'Verdana', kind: 'sans', stand: '"DejaVu Sans", Arial, sans-serif' },
  { name: 'Tahoma', kind: 'sans', stand: '"DejaVu Sans", Arial, sans-serif' },
  { name: 'Trebuchet MS', kind: 'sans', stand: 'Arial, sans-serif' },
  { name: 'Century Gothic', kind: 'sans', stand: '"URW Gothic", Arial, sans-serif' },
  { name: 'Comic Sans MS', kind: 'sans', stand: '"Comic Neue", cursive, sans-serif' },
  { name: 'Times New Roman', kind: 'serif', stand: '"Liberation Serif", Times, serif' },
  { name: 'Cambria', kind: 'serif', stand: 'Caladea, Georgia, serif' },
  { name: 'Georgia', kind: 'serif', stand: '"Times New Roman", serif' },
  { name: 'Garamond', kind: 'serif', stand: '"EB Garamond", Georgia, serif' },
  { name: 'Book Antiqua', kind: 'serif', stand: 'Palatino, "Palatino Linotype", Georgia, serif' },
  { name: 'Courier New', kind: 'mono', stand: '"Liberation Mono", Courier, monospace' },
  { name: 'Consolas', kind: 'mono', stand: '"Cascadia Mono", "DejaVu Sans Mono", monospace' },
];

const STANDARD_STACK = '"Segoe UI", Arial, Helvetica, sans-serif';

/** A typeface's name is kept only when it is plain (letters, digits, spaces, hyphens), so it cannot break the CSS. */
export const cleanFace = (name: unknown): string | undefined =>
  typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9 \-]{0,30}$/.test(name.trim()) ? name.trim() : undefined;

/** The CSS font-family for a typeface (the standard one when unset). */
export function cssFamily(face: string | undefined): string {
  if (!face) return STANDARD_STACK;
  const known = FONT_FACES.find(f => f.name.toLowerCase() === face.toLowerCase());
  return `"${face}", ${known?.stand ?? STANDARD_STACK}`;
}

/** Whether a typeface is plain (sans), has serifs, or is fixed-width: how it prints in a PDF. */
export function fontKind(face: string | undefined): FontKind {
  if (!face) return 'sans';
  const known = FONT_FACES.find(f => f.name.toLowerCase() === face.toLowerCase());
  if (known) return known.kind;
  if (/mono|courier|consol|code/i.test(face)) return 'mono';
  if (/times|serif|georgia|garamond|cambria|book|palatino|roman/i.test(face)) return 'serif';
  return 'sans';
}

/** A cell's text size on screen at 100% (pixels): the standard 11 points is 13 pixels, others in proportion. */
export const sizePx = (fs: number | undefined): number => ((fs ?? STANDARD_SIZE) / STANDARD_SIZE) * STANDARD_PX;

/** The next size up or down the list (Increase / Decrease font size). */
export function stepSize(fs: number | undefined, up: boolean): number {
  const now = fs ?? STANDARD_SIZE;
  if (up) return FONT_SIZES.find(s => s > now) ?? Math.min(409, now + 12);
  return [...FONT_SIZES].reverse().find(s => s < now) ?? Math.max(1, now - 1);
}
