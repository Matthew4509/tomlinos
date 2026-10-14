// Printing and PDF for TOMLIN Write. The pages are read off the screen: every word where the browser drew it (so the
// lines, and the page breaks, are the ones on screen), the list numbers and bullets, table cells with their shading
// and lines, pictures, and the header and footer. Printing draws each page as a picture of the paper in the document's
// own typefaces; the PDF draws it with the typefaces every PDF reader has (Helvetica, Times, Courier), each word at its
// place on the line, so a line never runs longer than it does on screen. Characters those typefaces lack show as "?".
import { h, on, svg } from '../../core/dom.ts';
import { joinPath, uniqueName } from '../../fs/names.ts';
import type { Shell } from '../../shell/types.ts';
import { cssFamily, fontKind, type FontKind } from '../sheet/fonts.ts';
import { PdfDocument, type PdfPage } from '../sheet/pdf.ts';
import { pageAt, pageTop, type Geometry } from './layout.ts';
import { frameOf, geometryOf, type Frame } from './measure.ts';
import { fillLine, paperPt, pxToPt, type PageBox, type PageSetup } from './model.ts';
import { picture } from './images.ts';

/** A word, a box or a picture on one page, in points from the page's top-left corner. */
export type Item =
  | { k: 'text'; x: number; base: number; text: string; size: number; face: string; kind: FontKind; bold: boolean; italic: boolean; underline: boolean; strike: boolean; colour: string; align?: 'r' | 'c' }
  | { k: 'rect'; x: number; y: number; w: number; h: number; fill: string | null; stroke: string | null; width: number }
  | { k: 'image'; x: number; y: number; w: number; h: number; id: string };

export interface Snapshot {
  pages: Item[][];
  size: { w: number; h: number };
}

/** "rgb(12, 34, 56)" as "#0c2238"; null when transparent. */
function hexOf(css: string): string | null {
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\s*\)/.exec(css);
  if (!m) return null;
  if (m[4] !== undefined && Number(m[4]) === 0) return null;
  return `#${[m[1], m[2], m[3]].map(v => Number(v).toString(16).padStart(2, '0')).join('')}`;
}

/** The first typeface in a CSS font-family list. */
const firstFace = (family: string): string => family.split(',')[0].trim().replace(/^["']|["']$/g, '');

const ROMAN: Array<[number, string]> = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
function roman(n: number): string {
  let out = '';
  for (const [v, s] of ROMAN) while (n >= v) {
    out += s;
    n -= v;
  }
  return out;
}
const letters = (n: number): string => {
  let s = '';
  while (n > 0) {
    n--;
    s = String.fromCharCode(97 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
};

/** The number or bullet shown before a list item (as the editor's CSS draws it: 1. a. i. and • ◦ ▪ by depth). */
export function markerText(li: HTMLElement, editor: HTMLElement): string {
  const list = li.parentElement;
  if (!list) return '';
  // How many lists of the same kind it sits inside: the style turns with each level, as the CSS draws it.
  let same = 0;
  for (let e = list.parentElement; e && e !== editor; e = e.parentElement) if (e.nodeName === list.nodeName) same++;
  if (list.nodeName === 'UL') return ['•', '◦', '▪'][same % 3];
  const start = Number((list as HTMLOListElement).getAttribute('start')) || 1;
  const n = start + [...list.children].indexOf(li);
  return same % 3 === 0 ? `${n}.` : same % 3 === 1 ? `${letters(n)}.` : `${roman(n)}.`;
}

/** Reads the pages off the screen: the editor's element, the paper strip it sits on, and the page setup. */
export function snapshot(editor: HTMLElement, paper: HTMLElement, page: PageSetup, box: PageBox, count: number): Snapshot {
  const f: Frame = frameOf(paper, box.w);
  const g: Geometry = geometryOf(box);
  const fills: Item[][] = Array.from({ length: count }, () => []);
  const lines: Item[][] = Array.from({ length: count }, () => []);
  const front: Item[][] = Array.from({ length: count }, () => []);
  const px = (screenX: number) => (screenX - f.left) / f.k;
  const py = (screenY: number) => (screenY - f.top) / f.k;
  /** A point on the strip (pixels) as a page and a position on it (points). */
  const place = (x: number, y: number) => {
    const i = Math.min(count - 1, pageAt(g, y));
    return { i, x: pxToPt(x), y: pxToPt(y - pageTop(g, i)) };
  };

  // Words.
  const range = document.createRange();
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const el = n.parentElement;
    if (!el || el.closest('.wp-spacer, .wp-break, .column-resize-handle')) continue;
    const cs = getComputedStyle(el);
    const size = pxToPt(parseFloat(cs.fontSize) || 14.67);
    const family = firstFace(cs.fontFamily);
    const colour = hexOf(cs.color) ?? '#000000';
    const bold = Number(cs.fontWeight) >= 600 || cs.fontWeight === 'bold';
    const italic = cs.fontStyle === 'italic' || cs.fontStyle === 'oblique';
    const underline = !!el.closest('u');
    const strike = !!el.closest('s');
    const mark = el.closest('mark');
    const highlight = mark ? hexOf(getComputedStyle(mark).backgroundColor) : null;
    const kind = fontKind(family);
    const re = /\S+\s*/g;
    for (let m = re.exec(n.data); m; m = re.exec(n.data)) {
      range.setStart(n, m.index);
      range.setEnd(n, m.index + m[0].length);
      const rects = [...range.getClientRects()].filter(r => r.width > 0.5);
      if (!rects.length) continue;
      // A word broken over two lines (too long for one) is split where the browser broke it.
      const pieces: Array<{ r: DOMRect; text: string }> = [];
      if (rects.length === 1) pieces.push({ r: rects[0], text: m[0] });
      else {
        let from = 0;
        for (let k = 1; k <= m[0].length; k++) {
          range.setStart(n, m.index + from);
          range.setEnd(n, m.index + k);
          const rr = [...range.getClientRects()].filter(r => r.width > 0.5);
          if (rr.length > 1 || k === m[0].length) {
            const end = rr.length > 1 ? k - 1 : k;
            range.setStart(n, m.index + from);
            range.setEnd(n, m.index + end);
            const one = [...range.getClientRects()].filter(r => r.width > 0.5)[0];
            if (one) pieces.push({ r: one, text: m[0].slice(from, end) });
            from = end;
          }
        }
      }
      for (const piece of pieces) {
        const top = py(piece.r.top);
        const at = place(px(piece.r.left), top);
        const hgt = pxToPt(piece.r.height / f.k);
        if (highlight) fills[at.i].push({ k: 'rect', x: at.x, y: at.y, w: pxToPt(piece.r.width / f.k), h: hgt, fill: highlight, stroke: null, width: 0 });
        const text = piece.text.replace(/\t/g, ' ');
        if (!text.trim()) continue;
        // The baseline sits about four fifths of the way down the line of letters for the common typefaces.
        front[at.i].push({ k: 'text', x: at.x, base: at.y + hgt * 0.79, text, size, face: family, kind, bold, italic, underline, strike, colour });
      }
    }
  }

  // List numbers and bullets, right-aligned just before each item's first line.
  for (const li of editor.querySelectorAll<HTMLElement>('li')) {
    const first = li.firstElementChild as HTMLElement | null;
    if (!first) continue;
    range.selectNodeContents(first);
    const r = [...range.getClientRects()].find(x => x.height > 0) ?? first.getBoundingClientRect();
    const liBox = li.getBoundingClientRect();
    const cs = getComputedStyle(first);
    const size = pxToPt(parseFloat(cs.fontSize) || 14.67);
    const at = place(px(liBox.left) - 6, py(r.top));
    const hgt = pxToPt(r.height / f.k);
    front[at.i].push({ k: 'text', x: at.x, base: at.y + hgt * 0.79, text: markerText(li, editor), size, face: firstFace(cs.fontFamily), kind: fontKind(firstFace(cs.fontFamily)), bold: false, italic: false, underline: false, strike: false, colour: hexOf(cs.color) ?? '#000000', align: 'r' });
  }

  // Table cells: shading, then lines (a cell that runs over a page break is drawn on each page it is on).
  for (const cell of editor.querySelectorAll<HTMLElement>('td, th')) {
    const r = cell.getBoundingClientRect();
    const cs = getComputedStyle(cell);
    const fill = hexOf(cs.backgroundColor);
    const ruled = !cell.closest('table')?.classList.contains('wp-noborders');
    const top = py(r.top);
    const bottom = py(r.bottom);
    const left = px(r.left);
    const width = r.width / f.k;
    for (let i = pageAt(g, top); i <= Math.min(count - 1, pageAt(g, bottom - 1)); i++) {
      const y0 = Math.max(top, pageTop(g, i) + g.top);
      const y1 = Math.min(bottom, pageTop(g, i) + g.top + g.body);
      if (y1 <= y0) continue;
      const item = { x: pxToPt(left), y: pxToPt(y0 - pageTop(g, i)), w: pxToPt(width), h: pxToPt(y1 - y0) };
      if (fill && fill !== '#ffffff') fills[i].push({ k: 'rect', ...item, fill, stroke: null, width: 0 });
      if (ruled) lines[i].push({ k: 'rect', ...item, fill: null, stroke: hexOf(cs.borderTopColor) ?? '#000000', width: 0.5 });
    }
  }

  // Pictures.
  for (const img of editor.querySelectorAll<HTMLImageElement>('img.wp-img')) {
    const r = img.getBoundingClientRect();
    const id = img.getAttribute('data-img') ?? '';
    if (!picture(id) || r.width < 1) continue;
    const at = place(px(r.left), py(r.top));
    front[at.i].push({ k: 'image', x: at.x, y: at.y, w: pxToPt(r.width / f.k), h: pxToPt(r.height / f.k), id });
  }

  // Header and footer on every page (Calibri 11, as Word's own).
  const size = paperPt(page);
  const hf = (which: 'header' | 'footer', i: number) => {
    const l = page[which];
    const base = which === 'header' ? page.margins.header * 72 + 11 : size.h - page.margins.footer * 72 - 3;
    const left = page.margins.l * 72;
    const right = size.w - page.margins.r * 72;
    const one = (text: string, x: number, align?: 'r' | 'c') => {
      const t = fillLine(text, i + 1, count);
      if (t.trim()) front[i].push({ k: 'text', x, base, text: t, size: 11, face: 'Calibri', kind: 'sans', bold: false, italic: false, underline: false, strike: false, colour: '#000000', align });
    };
    one(l.l, left);
    one(l.c, (left + right) / 2, 'c');
    one(l.r, right, 'r');
  };
  for (let i = 0; i < count; i++) {
    hf('header', i);
    hf('footer', i);
  }
  return { pages: fills.map((f0, i) => [...f0, ...lines[i], ...front[i]]), size };
}

// ---- PDF ---------------------------------------------------------------------------------------------------------

/** A picture as a JPEG for the PDF (on white, at most 2000 pixels on its long side). */
async function jpegOf(id: string): Promise<{ data: Uint8Array; w: number; h: number } | null> {
  const pic = picture(id);
  if (!pic) return null;
  const bitmap = await createImageBitmap(new Blob([pic.bytes as BlobPart], { type: pic.type }));
  const k = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * k));
  const hh = Math.max(1, Math.round(bitmap.height * k));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = hh;
  const c = canvas.getContext('2d');
  if (!c) return null;
  c.fillStyle = '#ffffff';
  c.fillRect(0, 0, w, hh);
  c.drawImage(bitmap, 0, 0, w, hh);
  bitmap.close();
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
  if (!blob) return null;
  return { data: new Uint8Array(await blob.arrayBuffer()), w, h: hh };
}

/** The pages as a PDF file's bytes. */
export async function pdfOf(snap: Snapshot, title: string): Promise<Uint8Array<ArrayBuffer>> {
  const doc = new PdfDocument();
  doc.title = title;
  doc.producer = 'TOMLIN Write';
  const names = new Map<string, string | null>();
  for (const items of snap.pages) {
    const page: PdfPage = doc.addPage(snap.size.w, snap.size.h);
    for (const it of items) {
      if (it.k === 'rect') page.rect(it.x, it.y, it.w, it.h, it.fill, it.stroke, it.width);
      else if (it.k === 'text') {
        // The painter puts y in the middle of the letters: a third of the size above the baseline.
        page.text(it.x, it.base - it.size * 0.36, it.text, { size: it.size, bold: it.bold, italic: it.italic, underline: it.underline, strike: it.strike, colour: it.colour, kind: it.kind, align: it.align === 'r' ? 'r' : it.align === 'c' ? 'c' : 'l' });
      } else {
        if (!names.has(it.id)) {
          const jpeg = await jpegOf(it.id).catch(() => null);
          names.set(it.id, jpeg ? doc.addJpeg(jpeg.data, jpeg.w, jpeg.h) : null);
        }
        const name = names.get(it.id);
        if (name) page.image(it.x, it.y, it.w, it.h, name);
      }
    }
  }
  return doc.bytes();
}

// ---- Printing ----------------------------------------------------------------------------------------------------

/** One page as an <svg> in points, in the document's own typefaces. */
export function pageSvg(snap: Snapshot, i: number): SVGElement {
  const root = svg('svg', { viewBox: `0 0 ${snap.size.w} ${snap.size.h}`, width: snap.size.w, height: snap.size.h, class: 'print-page-svg' });
  root.append(svg('rect', { x: 0, y: 0, width: snap.size.w, height: snap.size.h, fill: '#ffffff' }));
  for (const it of snap.pages[i] ?? []) {
    if (it.k === 'rect') root.append(svg('rect', { x: it.x, y: it.y, width: it.w, height: it.h, fill: it.fill ?? 'none', stroke: it.stroke ?? 'none', 'stroke-width': it.width }));
    else if (it.k === 'image') {
      const pic = picture(it.id);
      if (pic) root.append(svg('image', { href: pic.url, x: it.x, y: it.y, width: it.w, height: it.h, preserveAspectRatio: 'none' }));
    } else {
      const deco = [it.underline ? 'underline' : '', it.strike ? 'line-through' : ''].filter(Boolean).join(' ');
      const t = svg('text', {
        x: it.x, y: it.base, 'font-family': cssFamily(it.face), 'font-size': it.size, fill: it.colour, 'xml:space': 'preserve',
        'font-weight': it.bold ? 'bold' : 'normal', 'font-style': it.italic ? 'italic' : 'normal', 'text-anchor': it.align === 'r' ? 'end' : it.align === 'c' ? 'middle' : 'start',
        ...(deco ? { 'text-decoration': deco } : {}),
      });
      t.textContent = it.text;
      root.append(t);
    }
  }
  return root;
}

/** Prints through the browser: each page at paper size, everything else hidden while it prints. */
export function printNow(snap: Snapshot, page: PageSetup): void {
  const holder = h('div', { class: 'sheet-print', 'aria-hidden': 'true' });
  for (let i = 0; i < snap.pages.length; i++) {
    const el = pageSvg(snap, i);
    el.setAttribute('width', `${snap.size.w}pt`);
    el.setAttribute('height', `${snap.size.h}pt`);
    holder.append(h('div', { class: `print-sheet-page paper-${page.paper}-${page.orient}` }, el));
  }
  document.body.append(holder);
  document.body.classList.add('printing-sheet');
  const cleanup = () => {
    holder.remove();
    document.body.classList.remove('printing-sheet');
  };
  window.addEventListener('afterprint', cleanup, { once: true });
  try {
    window.print();
  } finally {
    setTimeout(() => {
      if (holder.isConnected) cleanup();
    }, 1000);
  }
}

export async function savePdfInDocuments(shell: Shell, bytes: Uint8Array, name: string): Promise<void> {
  let taken: string[] = [];
  try {
    taken = (await shell.fs.list('/Documents', true)).map(e => e.name);
  } catch {
    // Writing says so if Documents is not there.
  }
  const entry = await shell.fs.writeFile(joinPath('/Documents', uniqueName(name, taken)), bytes, { mustBeNew: true });
  shell.toast(`Saved “${entry.name}” in Documents.`, { label: 'Open', run: () => void shell.openPath(joinPath('/Documents', entry.name)) });
}

/** File > Print: a preview of every page, then Print, a PDF to download, or a PDF saved in Documents. */
export async function printPreview(shell: Shell, take: () => Snapshot, page: PageSetup, title: string, pdfName: string): Promise<void> {
  const done = new AbortController();
  let snap = take();
  let index = 0;
  const view = h('div', { class: 'pp-view' });
  const count = h('span', { class: 'pp-count', role: 'status', 'aria-live': 'polite' });
  const prev = h('button', { type: 'button', class: 'btn', 'aria-label': 'Previous page' }, '◀');
  const next = h('button', { type: 'button', class: 'btn', 'aria-label': 'Next page' }, '▶');
  const draw = () => {
    index = Math.max(0, Math.min(index, snap.pages.length - 1));
    const el = pageSvg(snap, index);
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', `Page ${index + 1} of ${snap.pages.length}`);
    const k = Math.min(420 / snap.size.w, 540 / snap.size.h);
    el.setAttribute('width', String(Math.round(snap.size.w * k)));
    el.setAttribute('height', String(Math.round(snap.size.h * k)));
    view.replaceChildren(el);
    count.textContent = `Page ${index + 1} of ${snap.pages.length}`;
    prev.disabled = index === 0;
    next.disabled = index >= snap.pages.length - 1;
  };
  on(prev, 'click', () => { index--; draw(); }, done.signal);
  on(next, 'click', () => { index++; draw(); }, done.signal);
  draw();
  const body = h('div', { class: 'pp-dialog' },
    h('div', { class: 'pp-side' },
      h('p', { class: 'dialog-detail' }, `${page.paper === 'letter' ? 'Letter' : page.paper.toUpperCase()}, ${page.orient}. Paper, margins and the header and footer are on the Layout tab.`),
      h('p', { class: 'dialog-detail' }, 'The PDF uses Helvetica, Times or Courier in place of each typeface (every PDF reader has them), so words keep their places but may look a little different. Letters outside Western European alphabets show as "?" in the PDF; Print keeps them.')),
    h('div', { class: 'pp-main' }, view, h('div', { class: 'pp-nav' }, prev, count, next)));
  const answer = await shell.dialogs.ask<'print' | 'pdf' | 'save' | null>({
    title: `Print: ${title}`,
    body,
    buttons: [{ label: 'Print', value: 'print', primary: true }, { label: 'Download PDF', value: 'pdf' }, { label: 'Save PDF in Documents', value: 'save' }, { label: 'Close', value: null }],
    cancel: null,
  });
  done.abort();
  if (!answer) return;
  snap = take();
  if (answer === 'print') printNow(snap, page);
  else {
    try {
      const bytes = await pdfOf(snap, title);
      if (answer === 'pdf') shell.transfers.save(pdfName, bytes);
      else await savePdfInDocuments(shell, bytes, pdfName);
    } catch (error) {
      await shell.report('Could not make the PDF', error);
    }
  }
}

