// PDF viewer: one page at a time, with Previous/Next, a page box, zoom and fit-to-width. Our own reader and renderer
// (src/apps/pdf/); it shows text, shapes and pictures, not every feature. The words of the page are also kept as text
// beside the picture, so a screen reader and the tests can read them.
// Edit > Find (Ctrl+F) searches the words of every page and marks each match on the page; File > Print (Ctrl+P) draws
// every page as a picture at its own paper size and prints them at actual size, nothing scaled.
import { css, h, on } from '../core/dom.ts';
import { formatSize } from '../core/format.ts';
import { baseName } from '../fs/names.ts';
import { PdfDocument, PdfError, type Page } from './pdf/objects.ts';
import { renderPage } from './pdf/render.ts';
import type { AppDef, AppHandle } from '../shell/types.ts';
import { APPS } from './catalog.ts';
import { openableViewer } from './viewer.ts';

const MAX_PDF_BYTES = 60 * 1024 * 1024;
const MAX_CANVAS_PIXELS = 16_000_000;
/** Printing draws each page at 150 dots per inch, or less for a page so big it would not fit in a canvas. */
const PRINT_SCALE = 150 / 72;
const MAX_PRINT_PIXELS = 12_000_000;

/** What the menus run in the PDF that is open now (none when no PDF is open). */
interface PdfActions {
  print: (() => void) | null;
  find: ((back?: boolean) => void) | null;
  openFind: (() => void) | null;
}

export const pdfApp: AppDef = {
  ...APPS.pdf,
  launch(app, arg) {
    app.root.classList.add('pdf');
    const acts: PdfActions = { print: null, find: null, openFind: null };
    return openableViewer(app, arg, {
      name: 'PDF Viewer', openTitle: 'Open a PDF', folder: '/Documents', types: [{ label: 'PDF document', ext: ['pdf'] }],
      load: (view, path) => showPdf(view, path, acts),
      fileItems: [
        { separator: true },
        { label: 'Print...', icon: 'print', shortcut: 'Ctrl+P', enabled: () => !!acts.print, action: () => acts.print?.() },
      ],
      editItems: [
        { label: 'Find...', icon: 'find', shortcut: 'Ctrl+F', enabled: () => !!acts.openFind, action: () => acts.openFind?.() },
        { label: 'Find next', shortcut: 'F3', enabled: () => !!acts.find, action: () => acts.find?.(false) },
        { label: 'Find previous', shortcut: 'Shift+F3', enabled: () => !!acts.find, action: () => acts.find?.(true) },
      ],
    });
  },
};

/** The page's size on paper in points, turned as it is shown. */
function paperSize(page: Page): { w: number; h: number } {
  const [x0, y0, x1, y1] = page.box;
  const sideways = page.rotate === 90 || page.rotate === 270;
  return { w: sideways ? y1 - y0 : x1 - x0, h: sideways ? x1 - x0 : y1 - y0 };
}

/** Text with each run of spaces and line breaks made one space, in lower case, and where each letter came from. */
export function foldText(text: string): { folded: string; from: number[] } {
  let folded = '';
  const from: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      if (!folded.endsWith(' ')) {
        folded += ' ';
        from.push(i);
      }
      continue;
    }
    for (const c of ch.toLowerCase()) {
      folded += c;
      from.push(i);
    }
  }
  return { folded, from };
}

/** Every place `query` is found in `text`, as offsets into `text` (start, end), ignoring case and spacing. */
export function findIn(text: string, query: string): Array<[number, number]> {
  const q = foldText(query.trim()).folded;
  if (!q) return [];
  const { folded, from } = foldText(text);
  const found: Array<[number, number]> = [];
  for (let at = folded.indexOf(q); at >= 0; at = folded.indexOf(q, at + q.length)) found.push([from[at], from[at + q.length - 1] + 1]);
  return found;
}

async function showPdf(app: AppHandle, arg: string | undefined, acts: PdfActions): Promise<void> {
  const shell = app.shell;
  app.signal.addEventListener('abort', () => {
    acts.print = acts.find = acts.openFind = null;
  }, { once: true });
  if (!arg) {
    app.setTitle(APPS.pdf.title);
    app.root.append(h('p', { class: 'app-message' }, 'Use File > Open to choose a PDF.'));
    return;
  }
  app.setTitle(baseName(arg));
  const message = (text: string, detail?: string) =>
    app.root.replaceChildren(h('div', { class: 'app-message', role: 'alert' }, h('p', {}, text), detail ? h('p', { class: 'dialog-detail' }, detail) : null));

  let doc: PdfDocument;
  try {
    const entry = await shell.fs.stat(arg);
    if (!entry || entry.kind !== 'file') return message('That file is not there any more.', 'It may have been moved or deleted.');
    if (entry.size > MAX_PDF_BYTES) return message(`This PDF is ${formatSize(entry.size)}.`, `This viewer opens PDFs up to ${formatSize(MAX_PDF_BYTES)}. You can still download it from File Explorer.`);
    doc = await PdfDocument.open(await shell.fs.readFile(arg));
  } catch (error) {
    if (error instanceof PdfError) return message(error.message, 'The file was not changed. You can download it from File Explorer and open it another way.');
    await shell.report('Could not open the PDF', error);
    return message('This PDF could not be opened.');
  }
  if (app.signal.aborted) return;

  let index = 0;
  let zoom = 0; // 0 = fit to width
  let generation = 0;
  const prev = h('button', { type: 'button', class: 'tool', 'aria-label': 'Previous page', title: 'Previous page (Page Up)' }, '←');
  const next = h('button', { type: 'button', class: 'tool', 'aria-label': 'Next page', title: 'Next page (Page Down)' }, '→');
  const pageBox = h('input', { type: 'number', class: 'field page-box', min: 1, max: doc.pages.length, value: 1, 'aria-label': 'Page number' });
  const of = h('span', { class: 'pdf-of' }, `of ${doc.pages.length}`);
  const out = h('button', { type: 'button', class: 'tool', 'aria-label': 'Zoom out', title: 'Zoom out (-)' }, '−');
  const inn = h('button', { type: 'button', class: 'tool', 'aria-label': 'Zoom in', title: 'Zoom in (+)' }, '+');
  const fit = h('button', { type: 'button', class: 'tool wide', title: 'Fit the page to the window width' }, 'Fit width');
  const canvas = h('canvas', { class: 'pdf-canvas', role: 'img', 'aria-label': 'PDF page' });
  // The find marks lie over the page, in a layer the size of the canvas that lets clicks through.
  const marks = h('div', { 'data-pdf-marks': '', 'aria-hidden': 'true' });
  css(marks, { position: 'absolute', left: 0, top: 0, right: 0, bottom: 0, 'pointer-events': 'none' });
  const sheet = h('div', { class: 'pdf-sheet' }, canvas, marks);
  css(sheet, { position: 'relative', margin: '0 auto' });
  const textEl = h('div', { class: 'visually-hidden', 'data-pdf-text': '' });
  const stage = h('div', { class: 'pdf-stage', tabindex: 0, 'aria-label': 'Page' }, sheet);
  const status = h('div', { class: 'statusbar', role: 'status' });

  // The find bar (Ctrl+F): Enter finds the next match, Shift+Enter the one before, Escape closes it.
  const findInput = h('input', { type: 'search', class: 'field', 'aria-label': 'Find in the PDF', placeholder: 'Find', spellcheck: false });
  const findTool = (label: string, title: string, extra: Record<string, string> = {}) => h('button', { type: 'button', class: 'tool wide', title, ...extra }, label);
  const findPrev = findTool('Previous', 'Find previous (Shift+Enter)');
  const findNext = findTool('Next', 'Find next (Enter)');
  const findClose = findTool('×', 'Close (Escape)', { 'aria-label': 'Close find' });
  const findNote = h('div', { class: 'find-note', role: 'status', 'aria-live': 'polite' });
  const findBar = h('div', { class: 'find-bar', hidden: true }, h('div', { class: 'find-row' }, findInput, findPrev, findNext, findClose), findNote);

  app.root.replaceChildren(h('div', { class: 'toolbar' }, prev, next, pageBox, of, out, inn, fit), findBar, stage, textEl, status);

  /** How big to draw: `css` is the size on screen (pixels per point); `scale` is the bitmap's, sharper on dense screens. */
  const scaleFor = (page: Page): { scale: number; css: number; width: number } => {
    const { w: pw, h: ph } = paperSize(page);
    const cssScale = zoom || Math.max(0.2, Math.min(4, (stage.clientWidth - 24) / pw));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // Never make a canvas bigger than the browser can safely hold.
    const cap = Math.sqrt(MAX_CANVAS_PIXELS / (pw * ph));
    return { scale: Math.min(cssScale * dpr, cap), css: cssScale, width: pw * cssScale };
  };

  // ---- Find ----
  /** The words of each page, kept once read (the page shown, or a page read without being shown). */
  const texts: Array<string | undefined> = [];
  /** Where the letters of the page shown were drawn (see RenderResult.boxes), and the canvas's size on screen. */
  let shownBoxes: number[] = [];
  let shownWidth = 0;
  let matches: Array<{ page: number; start: number; end: number }> = [];
  let matchedQuery: string | null = null;
  let currentMatch = -1;
  let searching = 0;

  const pageStatus = (note: string | null = null) => `Page ${index + 1} of ${doc.pages.length}${note ? '. ' + note : ''}`;

  function paintMarks(scroll: boolean): void {
    marks.replaceChildren();
    if (findBar.hidden || !matches.length || !canvas.width || !shownWidth) return;
    const ratio = shownWidth / canvas.width;
    let currentEl: HTMLElement | null = null;
    matches.forEach((m, n) => {
      if (m.page !== index) return;
      const rects: Array<{ x: number; y: number; w: number; h: number }> = [];
      for (let i = 0; i < shownBoxes.length; i += 6) {
        const at = shownBoxes[i];
        if (at + shownBoxes[i + 1] <= m.start || at >= m.end) continue;
        const [x, y, w, hh] = [shownBoxes[i + 2], shownBoxes[i + 3], shownBoxes[i + 4], shownBoxes[i + 5]];
        const last = rects[rects.length - 1];
        if (last && Math.abs(last.y - y) < hh / 2 && x >= last.x - 1) {
          const right = Math.max(last.x + last.w, x + w);
          last.y = Math.min(last.y, y);
          last.h = Math.max(last.h, hh);
          last.w = right - last.x;
        } else rects.push({ x, y, w, h: hh });
      }
      for (const r of rects) {
        const mark = h('div', { class: 'pdf-mark', 'data-pdf-mark': n === currentMatch ? 'current' : '' });
        css(mark, {
          position: 'absolute', left: r.x * ratio, top: r.y * ratio, width: Math.max(2, r.w * ratio), height: Math.max(2, r.h * ratio),
          background: n === currentMatch ? 'rgba(255, 140, 0, 0.45)' : 'rgba(255, 220, 0, 0.4)',
          outline: n === currentMatch ? '2px solid rgb(230, 100, 0)' : 'none', 'mix-blend-mode': 'multiply',
        });
        marks.append(mark);
        if (n === currentMatch && !currentEl) currentEl = mark;
      }
    });
    if (scroll && currentEl) (currentEl as HTMLElement).scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /** The words of page `i`, read by drawing it small on a canvas nobody sees. */
  async function textOf(i: number, alive: () => boolean): Promise<string> {
    const known = texts[i];
    if (known !== undefined) return known;
    const scratch = document.createElement('canvas');
    let text = '';
    try {
      text = (await renderPage(doc, doc.pages[i], scratch, 0.1, alive)).text;
    } catch {
      text = '';
    }
    scratch.width = scratch.height = 0;
    if (alive()) texts[i] = text;
    return text;
  }

  async function find(back = false): Promise<void> {
    if (findBar.hidden) openFind();
    const query = findInput.value;
    if (!query.trim()) {
      findNote.textContent = 'Type a word to find.';
      return;
    }
    const folded = foldText(query.trim()).folded;
    if (folded !== matchedQuery) {
      const mine = ++searching;
      const alive = () => mine === searching && !app.signal.aborted;
      const found: typeof matches = [];
      let anyText = false;
      for (let i = 0; i < doc.pages.length; i++) {
        if (doc.pages.length > 20 && i % 10 === 0) findNote.textContent = `Searching page ${i + 1} of ${doc.pages.length}...`;
        const text = await textOf(i, alive);
        if (!alive()) return;
        if (text.trim()) anyText = true;
        for (const [start, end] of findIn(text, query)) found.push({ page: i, start, end });
      }
      matches = found;
      matchedQuery = folded;
      currentMatch = -1;
      if (!found.length) {
        findNote.textContent = anyText ? `Not found: "${query.trim()}".` : 'This PDF has no words to search. Its pages may be scanned pictures.';
        paintMarks(false);
        return;
      }
    }
    if (!matches.length) return;
    if (currentMatch < 0) {
      currentMatch = -1;
      if (back) {
        for (let n = matches.length - 1; n >= 0 && currentMatch < 0; n--) if (matches[n].page <= index) currentMatch = n;
      } else currentMatch = matches.findIndex(m => m.page >= index);
      if (currentMatch < 0) currentMatch = back ? matches.length - 1 : 0;
    } else currentMatch = (currentMatch + (back ? -1 : 1) + matches.length) % matches.length;
    const m = matches[currentMatch];
    findNote.textContent = `${currentMatch + 1} of ${matches.length} (page ${m.page + 1})`;
    if (m.page !== index) go(m.page);
    else paintMarks(true);
  }

  function openFind(): void {
    findBar.hidden = false;
    findInput.focus();
    findInput.select();
  }
  function closeFind(): void {
    findBar.hidden = true;
    searching++;
    paintMarks(false);
    stage.focus({ preventScroll: true });
  }
  on(findInput, 'input', () => {
    matchedQuery = null;
    matches = [];
    currentMatch = -1;
    findNote.textContent = '';
    paintMarks(false);
  }, app.signal);
  on(findInput, 'keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter') void find(event.shiftKey);
    else if (event.key === 'Escape') closeFind();
    else return;
    event.preventDefault();
    event.stopPropagation();
  }, app.signal);
  on(findNext, 'click', () => void find(false), app.signal);
  on(findPrev, 'click', () => void find(true), app.signal);
  on(findClose, 'click', closeFind, app.signal);

  // ---- Print ----
  let printing = false;
  async function print(): Promise<void> {
    if (printing) return;
    printing = true;
    const urls: string[] = [];
    const holder = h('div', { class: 'sheet-print', 'aria-hidden': 'true' });
    const sizes = new Map<string, number>();
    const rules: string[] = [];
    const pictures: HTMLImageElement[] = [];
    let style: CSSStyleSheet | null = null;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      holder.remove();
      document.body.classList.remove('printing-sheet');
      if (style) document.adoptedStyleSheets = document.adoptedStyleSheets.filter(s => s !== style);
      for (const u of urls) URL.revokeObjectURL(u);
      printing = false;
      if (!app.signal.aborted) status.textContent = pageStatus();
    };
    try {
      for (let i = 0; i < doc.pages.length; i++) {
        status.textContent = `Getting page ${i + 1} of ${doc.pages.length} ready to print...`;
        const page = doc.pages[i];
        const { w, h: ph } = paperSize(page);
        const scale = Math.min(PRINT_SCALE, Math.sqrt(MAX_PRINT_PIXELS / (w * ph)));
        const scratch = document.createElement('canvas');
        await renderPage(doc, page, scratch, scale, () => !app.signal.aborted);
        if (app.signal.aborted) return cleanup();
        const blob = await new Promise<Blob | null>(done => scratch.toBlob(done, 'image/png'));
        scratch.width = scratch.height = 0;
        if (!blob) throw new Error('The browser could not turn a page into a picture to print.');
        const url = URL.createObjectURL(blob);
        urls.push(url);
        const key = `${w.toFixed(2)}x${ph.toFixed(2)}`;
        let k = sizes.get(key);
        if (k === undefined) {
          k = sizes.size;
          sizes.set(key, k);
          rules.push(`@page pdf-size-${k} { size: ${w.toFixed(2)}pt ${ph.toFixed(2)}pt; margin: 0; }`, `.pdf-print-size-${k} { page: pdf-size-${k}; }`);
        }
        const picture = h('img', { src: url, alt: '' });
        css(picture, { display: 'block', width: `${w.toFixed(2)}pt`, height: `${ph.toFixed(2)}pt` });
        pictures.push(picture);
        holder.append(h('div', { class: `print-sheet-page pdf-print-size-${k}`, 'data-pdf-print-page': String(i + 1) }, picture));
      }
      await Promise.all(pictures.map(p => p.decode().catch(() => {})));
      if (app.signal.aborted) return cleanup();
      style = new CSSStyleSheet();
      style.replaceSync(rules.join('\n'));
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, style];
      document.body.append(holder);
      document.body.classList.add('printing-sheet');
      status.textContent = 'Printing at actual size...';
      window.addEventListener('afterprint', cleanup, { once: true });
    } catch (error) {
      cleanup();
      await shell.report('Could not print the PDF', error);
      return;
    }
    try {
      window.print();
    } finally {
      // print() waits until the print box is closed in most browsers; the clean-up runs either way.
      setTimeout(cleanup, 1000);
    }
  }

  async function show(): Promise<void> {
    const mine = ++generation;
    const page = doc.pages[index];
    pageBox.value = String(index + 1);
    prev.disabled = index === 0;
    next.disabled = index === doc.pages.length - 1;
    const size = scaleFor(page);
    status.textContent = 'Drawing...';
    try {
      const result = await renderPage(doc, page, canvas, size.scale, () => mine === generation);
      if (mine !== generation) return;
      css(canvas, { width: size.width });
      css(sheet, { width: size.width });
      textEl.textContent = result.text;
      texts[index] = result.text;
      shownBoxes = result.boxes;
      shownWidth = size.width;
      status.textContent = pageStatus(result.note);
      paintMarks(true);
    } catch (error) {
      if (mine !== generation) return;
      shownBoxes = [];
      marks.replaceChildren();
      status.textContent = 'This page could not be drawn.';
      if (error instanceof PdfError) status.textContent = error.message;
      else console.error(error);
    }
  }

  const go = (i: number) => {
    const clamped = Math.max(0, Math.min(doc.pages.length - 1, i));
    // The page box always ends up showing the page shown, even when what was typed is out of range.
    pageBox.value = String(clamped + 1);
    if (clamped === index && generation) return;
    index = clamped;
    stage.scrollTop = 0;
    void show();
  };
  const setZoom = (z: number) => {
    zoom = Math.max(0.25, Math.min(4, z));
    void show();
  };
  const currentZoom = () => scaleFor(doc.pages[index]).css;
  on(prev, 'click', () => go(index - 1), app.signal);
  on(next, 'click', () => go(index + 1), app.signal);
  on(out, 'click', () => setZoom(currentZoom() / 1.25), app.signal);
  on(inn, 'click', () => setZoom(currentZoom() * 1.25), app.signal);
  on(fit, 'click', () => {
    zoom = 0;
    void show();
  }, app.signal);
  on(pageBox, 'change', () => {
    const n = parseInt(pageBox.value, 10);
    if (Number.isNaN(n)) pageBox.value = String(index + 1);
    else go(n - 1);
  }, app.signal);
  on(app.root, 'keydown', (event: KeyboardEvent) => {
    if (event.target instanceof HTMLInputElement) return;
    if (event.key === 'PageDown' || (event.key === 'ArrowRight' && event.altKey)) go(index + 1);
    else if (event.key === 'PageUp' || (event.key === 'ArrowLeft' && event.altKey)) go(index - 1);
    else if (event.key === 'Home') go(0);
    else if (event.key === 'End') go(doc.pages.length - 1);
    else if (event.key === '+' || event.key === '=') setZoom(currentZoom() * 1.25);
    else if (event.key === '-') setZoom(currentZoom() / 1.25);
    else if (event.key === 'Escape' && !findBar.hidden) closeFind();
    else return;
    event.preventDefault();
  }, app.signal);
  let lastWidth = stage.clientWidth;
  const observer = new ResizeObserver(() => {
    if (zoom === 0 && Math.abs(stage.clientWidth - lastWidth) > 8) {
      lastWidth = stage.clientWidth;
      void show();
    }
  });
  observer.observe(stage);
  app.signal.addEventListener('abort', () => {
    generation++;
    searching++;
    observer.disconnect();
  }, { once: true });
  acts.print = () => void print();
  acts.find = back => void find(back);
  acts.openFind = openFind;
  await show();
  stage.focus({ preventScroll: true });
}
