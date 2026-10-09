// PDF viewer: one page at a time, with Previous/Next, a page box, zoom and fit-to-width. Our own reader and renderer
// (src/apps/pdf/); it shows text, shapes and pictures, not every feature. The words of the page are also kept as text
// beside the picture, so a screen reader and the tests can read them.
import { css, h, on } from '../core/dom.ts';
import { formatSize } from '../core/format.ts';
import { baseName } from '../fs/names.ts';
import { PdfDocument, PdfError, type Page } from './pdf/objects.ts';
import { renderPage } from './pdf/render.ts';
import type { AppDef } from '../shell/types.ts';
import { APPS } from './catalog.ts';

const MAX_PDF_BYTES = 60 * 1024 * 1024;
const MAX_CANVAS_PIXELS = 16_000_000;

export const pdfApp: AppDef = {
  ...APPS.pdf,
  async launch(app, arg) {
    const shell = app.shell;
    app.root.classList.add('pdf');
    if (!arg) {
      app.root.append(h('p', { class: 'app-message' }, 'Open a PDF from File Explorer.'));
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
    const textEl = h('div', { class: 'visually-hidden', 'data-pdf-text': '' });
    const stage = h('div', { class: 'pdf-stage', tabindex: 0, 'aria-label': 'Page' }, canvas);
    const status = h('div', { class: 'statusbar', role: 'status' });
    app.root.replaceChildren(h('div', { class: 'toolbar' }, prev, next, pageBox, of, out, inn, fit), stage, textEl, status);

    /** How big to draw: `css` is the size on screen (pixels per point); `scale` is the bitmap's, sharper on dense screens. */
    const scaleFor = (page: Page): { scale: number; css: number; width: number } => {
      const [x0, y0, x1, y1] = page.box;
      const sideways = page.rotate === 90 || page.rotate === 270;
      const pw = sideways ? y1 - y0 : x1 - x0;
      const ph = sideways ? x1 - x0 : y1 - y0;
      const cssScale = zoom || Math.max(0.2, Math.min(4, (stage.clientWidth - 24) / pw));
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      // Never make a canvas bigger than the browser can safely hold.
      const cap = Math.sqrt(MAX_CANVAS_PIXELS / (pw * ph));
      return { scale: Math.min(cssScale * dpr, cap), css: cssScale, width: pw * cssScale };
    };

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
        textEl.textContent = result.text;
        status.textContent = `Page ${index + 1} of ${doc.pages.length}${result.note ? '. ' + result.note : ''}`;
      } catch (error) {
        if (mine !== generation) return;
        status.textContent = 'This page could not be drawn.';
        if (error instanceof PdfError) status.textContent = error.message;
        else console.error(error);
      }
    }

    const go = (i: number) => {
      const clamped = Math.max(0, Math.min(doc.pages.length - 1, i));
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
    on(pageBox, 'change', () => go((parseInt(pageBox.value, 10) || 1) - 1), app.signal);
    on(app.root, 'keydown', (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement) return;
      if (event.key === 'PageDown' || (event.key === 'ArrowRight' && event.altKey)) go(index + 1);
      else if (event.key === 'PageUp' || (event.key === 'ArrowLeft' && event.altKey)) go(index - 1);
      else if (event.key === 'Home') go(0);
      else if (event.key === 'End') go(doc.pages.length - 1);
      else if (event.key === '+' || event.key === '=') setZoom(currentZoom() * 1.25);
      else if (event.key === '-') setZoom(currentZoom() / 1.25);
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
      observer.disconnect();
    }, { once: true });
    await show();
    stage.focus({ preventScroll: true });
  },
};
