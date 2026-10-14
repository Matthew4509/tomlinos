// Where TOMLIN Write's pages break. The editor shows the document as one flow of text on a strip of paper; this works
// out, from the height of each line (and each table row), which line starts each new page, and how much space to put
// before it so it starts at the top of the next sheet. Pages sit one under another, each `pageH` tall with `gap`
// between them, so every page's writing area is in a known place and the header, footer and the grey gap between
// sheets are drawn there. The same answer feeds printing and the PDF, so the page breaks on paper are the ones on screen.
// No browser needed: the window measures the lines (measure.ts) and hands them here.

/** A line of a paragraph, a table row or a page break, as measured on screen (pixels at 100%, from the paper's top). */
export interface Unit {
  /** Where it starts, counting the space this layout put before it last time (if any). */
  top: number;
  /** Its own height, without that space. */
  height: number;
  /** The space put before it last time (0 when none). */
  spacer: number;
  /** A page break: whatever follows starts a new page. */
  breakAfter?: boolean;
}

export interface Geometry {
  /** The paper's height, its top margin, the writing area's height, and the gap between sheets on screen. */
  pageH: number;
  top: number;
  body: number;
  gap: number;
}

export interface Pages {
  /** The space to put before each unit (same order as the units; 0 for none). */
  spacers: number[];
  /** The page each unit lands on (0 is the first). */
  pageOf: number[];
  count: number;
}

export const pageTop = (g: Geometry, i: number): number => i * (g.pageH + g.gap);
export const bodyTop = (g: Geometry, i: number): number => pageTop(g, i) + g.top;
export const bodyBottom = (g: Geometry, i: number): number => bodyTop(g, i) + g.body;
/** The page a point on the paper strip is on (a point in the gap counts as the page above it). */
export const pageAt = (g: Geometry, y: number): number => Math.max(0, Math.floor(y / (g.pageH + g.gap)));

/**
 * Breaks the units into pages. Each unit goes where the units before it leave it; one that does not fit in what is
 * left of its page (and is not already the first thing on it) starts the next page. A unit taller than a whole page
 * starts a page and runs over its end, as a too-tall picture does in Word.
 */
export function paginate(units: Unit[], g: Geometry): Pages {
  const spacers: number[] = [];
  const pageOf: number[] = [];
  // How far everything has moved since it was measured (new spaces less the old ones).
  let shift = 0;
  let page = 0;
  let forceNext = false;
  const slack = 0.5;
  for (const u of units) {
    const at = u.top + shift;
    let p = Math.max(page, pageAt(g, at));
    // Measured inside the bottom margin, the gap or the next top margin: it belongs at the top of a later page.
    if (at > bodyBottom(g, p) - slack) p++;
    let space = Math.max(0, bodyTop(g, p) - at);
    if (forceNext && p === page) {
      p = page + 1;
      space = bodyTop(g, p) - at;
    } else if (!forceNext && space === 0 && at + u.height > bodyBottom(g, p) + slack && at > bodyTop(g, p) + slack) {
      p++;
      space = bodyTop(g, p) - at;
    }
    space = Math.max(0, Math.round(space * 100) / 100);
    spacers.push(space);
    pageOf.push(p);
    shift += space - u.spacer;
    page = p;
    forceNext = !!u.breakAfter;
  }
  return { spacers, pageOf, count: page + 1 + (forceNext ? 1 : 0) };
}
