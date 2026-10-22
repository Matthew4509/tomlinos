// Write's pages on screen. The editor is one long strip of paper; this measures every line of every paragraph
// (and every table row) where the browser drew it, asks layout.ts where the pages break, and puts an empty block of
// the right height before each line that starts a page (a "spacer", which is not part of the document). Over the
// strip it draws what lies between the writing of one page and the next: the bottom margin with the footer, the grey
// gap between sheets, the next top margin with the header. Text never lands there because the spacers keep it out.
import { css, h } from '../../core/dom.ts';
import { paginate, pageTop, type Geometry, type Pages, type Unit } from './layout.ts';
import { fillLine, PX_PER_IN, type PageBox, type PageSetup } from './model.ts';
import type { PM } from './schema.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** The grey gap between sheets on screen, in pixels at 100%. */
export const GAP = 24;

/** Where a spacer goes: inside a paragraph before a line, before a block, or at the top of every cell of a table row. */
type Place = { kind: 'at'; pos: number } | { kind: 'cells'; pos: number[] };

interface Measured {
  unit: Unit;
  place: () => Place | null;
}

export const geometryOf = (box: PageBox): Geometry => ({ pageH: box.h, top: box.top, body: box.body, gap: GAP });

/** A spacer element's box, if `el` is one. */
const isSpacer = (el: Element | null | undefined): el is HTMLElement => !!el && el.classList.contains('wp-spacer');

/** The paper's top-left corner on screen and its zoom, to turn screen positions into paper pixels at 100%. */
export interface Frame {
  left: number;
  top: number;
  k: number;
}

export function frameOf(paper: HTMLElement, widthPx: number): Frame {
  const r = paper.getBoundingClientRect();
  return { left: r.left, top: r.top, k: r.width / widthPx || 1 };
}

const yOf = (f: Frame, y: number) => (y - f.top) / f.k;

/** The lines of a paragraph, each with its own box (half way between one line's letters and the next's). */
function paragraphUnits(view: any, node: any, pos: number, f: Frame): Measured[] {
  const dom = view.nodeDOM(pos) as HTMLElement | null;
  if (!dom || !(dom instanceof HTMLElement)) return [];
  const box = dom.getBoundingClientRect();
  const pTop = yOf(f, box.top);
  const pBottom = yOf(f, box.bottom);
  const spacers = [...dom.querySelectorAll<HTMLElement>('.wp-spacer')].map(s => {
    const r = s.getBoundingClientRect();
    return { top: yOf(f, r.top), bottom: yOf(f, r.bottom) };
  });
  // Every piece of text and every picture, as boxes on the strip.
  const rects: Array<{ top: number; bottom: number; left: number; x: number; y: number }> = [];
  const range = document.createRange();
  const walker = document.createTreeWalker(dom, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: n => ((n as Element).classList?.contains('wp-spacer') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) {
      if (!(n as Text).data) continue;
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) if (r.height > 0) rects.push({ top: yOf(f, r.top), bottom: yOf(f, r.bottom), left: r.left, x: r.left, y: (r.top + r.bottom) / 2 });
    } else if ((n as Element).nodeName === 'IMG') {
      const r = (n as Element).getBoundingClientRect();
      if (r.height > 0) rects.push({ top: yOf(f, r.top), bottom: yOf(f, r.bottom), left: r.left, x: r.left + 1, y: (r.top + r.bottom) / 2 });
    }
  }
  if (!rects.length) {
    const sp = spacers[0];
    const spacer = sp ? sp.bottom - sp.top : 0;
    return [{ unit: { top: pTop, height: Math.max(1, pBottom - pTop - spacer), spacer }, place: () => ({ kind: 'at', pos: pos + 1 }) }];
  }
  rects.sort((a, b) => a.top - b.top || a.left - b.left);
  const lines: Array<{ top: number; bottom: number; x: number; y: number }> = [];
  for (const r of rects) {
    const line = lines[lines.length - 1];
    if (line && r.top < line.bottom - 2) {
      line.top = Math.min(line.top, r.top);
      line.bottom = Math.max(line.bottom, r.bottom);
      if (r.x < line.x) {
        line.x = r.x;
        line.y = r.y;
      }
    } else lines.push({ top: r.top, bottom: r.bottom, x: r.x, y: r.y });
  }
  const out: Measured[] = [];
  const first = pos + 1;
  const last = pos + node.nodeSize - 1;
  for (let k = 0; k < lines.length; k++) {
    const prevBottom = k ? lines[k - 1].bottom : pTop;
    const own = spacers.find(s => s.top >= prevBottom - 1 && s.bottom <= lines[k].top + 1);
    const boxTop = own ? own.bottom : k === 0 ? pTop : (lines[k - 1].bottom + lines[k].top) / 2;
    const next = lines[k + 1];
    const nextOwn = next ? spacers.find(s => s.top >= lines[k].bottom - 1 && s.bottom <= next.top + 1) : undefined;
    const boxBottom = !next ? pBottom : nextOwn ? nextOwn.top : (lines[k].bottom + next.top) / 2;
    const line = lines[k];
    out.push({
      unit: { top: own ? own.top : boxTop, height: Math.max(1, boxBottom - boxTop), spacer: own ? own.bottom - own.top : 0 },
      place: () => {
        if (k === 0) return { kind: 'at', pos: first };
        const hit = view.posAtCoords({ left: line.x + 1, top: line.y });
        if (!hit) return null;
        return { kind: 'at', pos: Math.max(first, Math.min(last, hit.pos)) };
      },
    });
  }
  return out;
}

/** The first place inside a cell where a spacer can go (the start of its first paragraph, or before its first block). */
function cellStart(cell: any, cellPos: number): number {
  return cell.firstChild?.isTextblock ? cellPos + 2 : cellPos + 1;
}

function tableUnits(view: any, table: any, pos: number, f: Frame): Measured[] {
  const out: Measured[] = [];
  const outer = view.nodeDOM(pos) as HTMLElement | null;
  const before = outer?.previousElementSibling;
  table.forEach((row: any, offset: number, index: number) => {
    const rowPos = pos + 1 + offset;
    const tr = view.nodeDOM(rowPos) as HTMLElement | null;
    if (!tr) return;
    const r = tr.getBoundingClientRect();
    let top = yOf(f, r.top);
    let spacer = 0;
    if (index === 0 && isSpacer(before)) {
      const s = before.getBoundingClientRect();
      spacer = s.height / f.k;
      top = yOf(f, s.top);
    } else if (index > 0) {
      const s = tr.querySelector('.wp-spacer');
      if (s) spacer = s.getBoundingClientRect().height / f.k;
    }
    const height = index === 0 ? yOf(f, r.bottom) - yOf(f, r.top) : yOf(f, r.bottom) - top - spacer;
    out.push({
      unit: { top, height: Math.max(1, height), spacer },
      place: () => {
        if (index === 0) return { kind: 'at', pos };
        const cells: number[] = [];
        row.forEach((cell: any, cellOffset: number) => cells.push(cellStart(cell, rowPos + 1 + cellOffset)));
        return { kind: 'cells', pos: cells };
      },
    });
  });
  return out;
}

function blockUnits(view: any, node: any, pos: number, f: Frame, out: Measured[]): void {
  const name = node.type.name;
  if (name === 'paragraph') out.push(...paragraphUnits(view, node, pos, f));
  else if (name === 'table') out.push(...tableUnits(view, node, pos, f));
  else if (node.isAtom && node.isBlock) {
    const dom = view.nodeDOM(pos) as HTMLElement | null;
    if (!dom) return;
    const r = dom.getBoundingClientRect();
    const prev = dom.previousElementSibling;
    const spacer = isSpacer(prev) ? prev.getBoundingClientRect().height / f.k : 0;
    out.push({ unit: { top: yOf(f, r.top) - spacer, height: Math.max(1, r.height / f.k), spacer, breakAfter: name === 'page_break' }, place: () => ({ kind: 'at', pos }) });
  } else {
    // Lists (and list items): their paragraphs and tables, in order.
    node.forEach((child: any, offset: number) => blockUnits(view, child, pos + 1 + offset, f, out));
  }
}

export interface Laid {
  pages: Pages;
  spacers: Array<{ pos: number; height: number }>;
  /** For each page, the footnotes on it (their numbers less one, in the order of the text). */
  notesOn: number[][];
}

/**
 * Measures the document as the editor shows it and works out the spacers its pages need. `noteHeights` are the
 * footnotes' heights at the foot of a page, in the order their numbers appear in the text.
 */
export function measure(view: any, paper: HTMLElement, box: PageBox, noteHeights: number[] = []): Laid {
  const f = frameOf(paper, box.w);
  const measured: Measured[] = [];
  view.state.doc.forEach((node: any, offset: number) => blockUnits(view, node, offset, f, measured));
  // Each footnote belongs to the line (or table row) its number is on.
  const unitNotes: number[][] = measured.map(() => []);
  [...(view.dom as HTMLElement).querySelectorAll('.wp-fn')].forEach((el, i) => {
    const r = el.getBoundingClientRect();
    const mid = yOf(f, (r.top + r.bottom) / 2);
    let best = -1;
    for (let k = 0; k < measured.length; k++) if (measured[k].unit.top <= mid + 1) best = k;
    if (best < 0) return;
    measured[best].unit.notes = (measured[best].unit.notes ?? 0) + (noteHeights[i] ?? 0);
    unitNotes[best].push(i);
  });
  const pages = paginate(measured.map(m => m.unit), geometryOf(box));
  const notesOn: number[][] = Array.from({ length: pages.count }, () => []);
  unitNotes.forEach((list, k) => notesOn[pages.pageOf[k]]?.push(...list));
  const spacers: Array<{ pos: number; height: number }> = [];
  pages.spacers.forEach((height, i) => {
    if (height <= 0) return;
    const place = measured[i].place();
    if (!place) return;
    if (place.kind === 'at') spacers.push({ pos: place.pos, height });
    else for (const pos of place.pos) spacers.push({ pos, height });
  });
  return { pages, spacers, notesOn };
}

/** The spacers as editor decorations (each a block of empty space the person cannot type into). */
export function spacerDecorations(pm: PM, doc: any, spacers: Array<{ pos: number; height: number }>): any {
  return pm.DecorationSet.create(doc, spacers.map(s => pm.Decoration.widget(s.pos, () => {
    const el = h('div', { class: 'wp-spacer', contenteditable: 'false', 'aria-hidden': 'true' });
    css(el, { height: `${s.height}px` });
    return el;
  }, { side: -1, key: `sp${Math.round(s.height * 100)}`, ignoreSelection: true })));
}

export const sameSpacers = (a: Array<{ pos: number; height: number }>, b: Array<{ pos: number; height: number }>): boolean =>
  a.length === b.length && a.every((s, i) => s.pos === b[i].pos && Math.abs(s.height - b[i].height) < 0.5);

/**
 * Draws what is around the writing of each page: the header and footer in the margins, and between one page's writing
 * and the next, the bottom margin, the grey gap and the next top margin (covering anything that runs through, such as
 * a table's lines). The paper is made as tall as its pages.
 */
export function drawFurniture(layer: HTMLElement, paper: HTMLElement, page: PageSetup, box: PageBox, count: number, notes?: { heights: number[]; on: number[][]; text: (i: number) => string }): void {
  const g = geometryOf(box);
  const total = count * box.h + (count - 1) * GAP;
  css(paper, { width: `${box.w}px`, height: `${total}px` });
  css(layer, { height: `${total}px` });
  const parts: HTMLElement[] = [];
  const line = (which: 'header' | 'footer', i: number): void => {
    const l = page[which];
    if (!l.l && !l.c && !l.r) return;
    const top = which === 'header' ? pageTop(g, i) + page.margins.header * PX_PER_IN : pageTop(g, i) + box.h - page.margins.footer * PX_PER_IN - 18;
    const el = h('div', { class: `wp-hf wp-${which}` },
      h('span', { class: 'wp-hf-l' }, fillLine(l.l, i + 1, count)), h('span', { class: 'wp-hf-c' }, fillLine(l.c, i + 1, count)), h('span', { class: 'wp-hf-r' }, fillLine(l.r, i + 1, count)));
    css(el, { top: `${top}px`, left: `${box.left}px`, right: `${box.right}px` });
    parts.push(el);
  };
  for (let i = 0; i < count; i++) {
    line('header', i);
    line('footer', i);
    // The footnotes at the foot of the writing, under a short rule.
    const on = notes?.on[i] ?? [];
    if (on.length) {
      const height = on.reduce((sum, n) => sum + (notes!.heights[n] ?? 0), 0);
      const block = h('div', { class: 'wp-notes' }, ...on.map(n => h('p', { class: 'wp-note' }, h('sup', {}, String(n + 1)), ` ${notes!.text(n)}`)));
      css(block, { top: `${pageTop(g, i) + box.top + box.body - height}px`, left: `${box.left}px`, width: `${box.w - box.left - box.right}px` });
      parts.push(block);
    }
    if (i < count - 1) {
      const from = pageTop(g, i) + box.top + box.body;
      const bottomMargin = h('div', { class: 'wp-mask' });
      css(bottomMargin, { top: `${from}px`, height: `${box.bottom}px` });
      const gap = h('div', { class: 'wp-gap' });
      css(gap, { top: `${pageTop(g, i) + box.h}px`, height: `${GAP}px` });
      const topMargin = h('div', { class: 'wp-mask' });
      css(topMargin, { top: `${pageTop(g, i + 1)}px`, height: `${box.top}px` });
      parts.push(bottomMargin, gap, topMargin);
    }
  }
  // The header and footer lines go over the masks.
  parts.sort((a, b) => Number(a.classList.contains('wp-hf')) - Number(b.classList.contains('wp-hf')));
  layer.replaceChildren(...parts);
}

/** Which page (1, 2, ...) the cursor is on, from its position on the strip. */
export function pageOfCursor(view: any, paper: HTMLElement, box: PageBox): number {
  try {
    const c = view.coordsAtPos(view.state.selection.head);
    const f = frameOf(paper, box.w);
    return Math.max(1, Math.floor(yOf(f, c.top) / (box.h + GAP)) + 1);
  } catch {
    return 1;
  }
}
