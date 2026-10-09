// Pictures: shows one picture at a time, fitted to the window or at full size, and steps through the other
// pictures in the same folder with the arrow keys. A picture is shown as an image only, so scripts inside an SVG
// never run.
import { css, h, on } from '../core/dom.ts';
import { formatSize } from '../core/format.ts';
import { baseName, joinPath, nameKey, parentPath } from '../fs/names.ts';
import { fileTypeOf } from '../shell/filetypes.ts';
import type { AppDef } from '../shell/types.ts';
import { blobUrl, mediaTypeOf } from './media.ts';
import { pictureTooBig } from '../core/imagesize.ts';
import { APPS } from './catalog.ts';

const MAX_IMAGE_BYTES = 60 * 1024 * 1024;

/** An SVG drawn once into a canvas and kept as a PNG: the picture without anything that could run. */
async function svgAsPng(bytes: Uint8Array): Promise<string> {
  const svgUrl = blobUrl(bytes, 'image/svg+xml');
  try {
    const pic = new Image();
    pic.src = svgUrl;
    await pic.decode();
    const scale = Math.min(1, 4096 / Math.max(pic.naturalWidth || 1, pic.naturalHeight || 1));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round((pic.naturalWidth || 300) * scale));
    canvas.height = Math.max(1, Math.round((pic.naturalHeight || 150) * scale));
    canvas.getContext('2d')!.drawImage(pic, 0, 0, canvas.width, canvas.height);
    const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('The browser could not draw this picture.'))), 'image/png'));
    return URL.createObjectURL(png);
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}
export const photosApp: AppDef = {
  ...APPS.photos,
  async launch(app, arg) {
    const shell = app.shell;
    app.root.classList.add('photos');
    if (!arg) {
      app.root.append(h('p', { class: 'app-message' }, 'Open a picture from File Explorer.'));
      return;
    }
    const folder = parentPath(arg);
    let names: string[] = [];
    try {
      names = (await shell.fs.list(folder)).filter(e => e.kind === 'file' && fileTypeOf(e.name).apps.includes('photos')).map(e => e.name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    } catch {
      names = [];
    }
    if (!names.some(n => nameKey(n) === nameKey(baseName(arg)))) names = [baseName(arg)];
    let index = Math.max(0, names.findIndex(n => nameKey(n) === nameKey(baseName(arg))));
    let fitted = true;
    let url: string | null = null;
    let generation = 0;

    const prev = h('button', { type: 'button', class: 'tool', 'aria-label': 'Previous picture', title: 'Previous (left arrow)' }, '←');
    const next = h('button', { type: 'button', class: 'tool', 'aria-label': 'Next picture', title: 'Next (right arrow)' }, '→');
    const zoom = h('button', { type: 'button', class: 'tool wide', title: 'Switch between fitting the window and full size' }, 'Full size');
    const edit = h('button', { type: 'button', class: 'tool wide', title: 'Open this picture in Photo Editor (E)' }, 'Edit');
    const label = h('span', { class: 'photo-label' });
    const img = h('img', { class: 'photo-img', alt: '', draggable: 'false' });
    const view = h('div', { class: 'photo-view', tabindex: 0, 'aria-label': 'Picture' }, img);
    const status = h('div', { class: 'statusbar', role: 'status' });
    app.root.append(h('div', { class: 'toolbar' }, prev, next, zoom, edit, label), view, status);

    const layout = () => {
      img.classList.toggle('fit', fitted);
      zoom.textContent = fitted ? 'Full size' : 'Fit window';
    };
    async function show(): Promise<void> {
      const mine = ++generation;
      const name = names[index];
      prev.disabled = index === 0;
      next.disabled = index >= names.length - 1;
      label.textContent = `${name}  (${index + 1} of ${names.length})`;
      app.setTitle(name);
      status.textContent = 'Loading...';
      try {
        const path = joinPath(folder, name);
        const entry = await shell.fs.stat(path);
        if (!entry) throw new Error('That picture is not there any more. It may have been moved or deleted.');
        if (entry.size > MAX_IMAGE_BYTES) throw new Error(`This picture is ${formatSize(entry.size)}. Pictures up to ${formatSize(MAX_IMAGE_BYTES)} open here.`);
        const type = mediaTypeOf(name);
        if (!type) throw new Error('This kind of picture cannot be shown.');
        const bytes = await shell.fs.readFile(path);
        if (mine !== generation) return;
        const tooBig = pictureTooBig(bytes);
        if (tooBig) throw new Error(tooBig);
        const old = url;
        // An SVG is shown as a drawn copy (PNG): the file itself, opened on its own from the page, could carry script.
        url = type === 'image/svg+xml' ? await svgAsPng(bytes) : blobUrl(bytes, type);
        img.alt = name;
        img.src = url;
        if (old) URL.revokeObjectURL(old);
        css(img, { display: null });
        await img.decode().catch(() => {
          throw new Error('The browser could not read this picture. The file may be damaged.');
        });
        if (mine === generation) status.textContent = `${img.naturalWidth} × ${img.naturalHeight} pixels, ${formatSize(entry.size)}`;
      } catch (error) {
        if (mine !== generation) return;
        css(img, { display: 'none' });
        status.textContent = error instanceof Error ? error.message : 'This picture could not be opened.';
      }
    }
    const step = (d: number) => {
      const to = Math.max(0, Math.min(names.length - 1, index + d));
      if (to !== index) {
        index = to;
        void show();
      }
    };
    on(prev, 'click', () => step(-1), app.signal);
    on(next, 'click', () => step(1), app.signal);
    const editThis = () => void shell.openApp('photoedit', joinPath(folder, names[index]));
    on(edit, 'click', editThis, app.signal);
    on(zoom, 'click', () => {
      fitted = !fitted;
      layout();
    }, app.signal);
    on(app.root, 'keydown', (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') step(-1);
      else if (event.key === 'ArrowRight') step(1);
      else if (event.key === 'e') editThis();
      else if (event.key === '0' || event.key === 'f') {
        fitted = !fitted;
        layout();
      } else return;
      event.preventDefault();
    }, app.signal);
    app.signal.addEventListener('abort', () => {
      generation++;
      if (url) URL.revokeObjectURL(url);
    }, { once: true });
    layout();
    await show();
    view.focus({ preventScroll: true });
  },
};
