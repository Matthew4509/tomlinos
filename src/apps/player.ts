// Player: music and video with the browser's own controls. The file is read into memory and handed over as a
// temporary address; the media type comes from our table by file extension.
import { h } from '../core/dom.ts';
import { formatSize } from '../core/format.ts';
import { baseName } from '../fs/names.ts';
import { fileTypeOf } from '../shell/filetypes.ts';
import { icon } from '../shell/icons.ts';
import type { AppDef } from '../shell/types.ts';
import { blobUrl, mediaTypeOf } from './media.ts';
import { APPS } from './catalog.ts';

const MAX_MEDIA_BYTES = 300 * 1024 * 1024;

export const playerApp: AppDef = {
  ...APPS.player,
  async launch(app, arg) {
    const shell = app.shell;
    app.root.classList.add('player');
    const message = (text: string) => app.root.replaceChildren(h('p', { class: 'app-message', role: 'alert' }, text));
    if (!arg) return message('Open a music or video file from File Explorer.');
    const name = baseName(arg);
    app.setTitle(name);
    const kind = fileTypeOf(name);
    const type = mediaTypeOf(name);
    if (!type) return message('This kind of file cannot be played.');
    app.setIcon(kind.icon);
    app.root.append(h('p', { class: 'app-message' }, 'Loading...'));
    try {
      const entry = await shell.fs.stat(arg);
      if (!entry || entry.kind !== 'file') return message('That file is not there any more. It may have been moved or deleted.');
      if (entry.size > MAX_MEDIA_BYTES) return message(`This file is ${formatSize(entry.size)}. The player opens files up to ${formatSize(MAX_MEDIA_BYTES)}. You can download it from File Explorer.`);
      const bytes = await shell.fs.readFile(arg);
      if (app.signal.aborted) return;
      const url = blobUrl(bytes, type);
      app.signal.addEventListener('abort', () => URL.revokeObjectURL(url), { once: true });
      const isVideo = type.startsWith('video/');
      const media = isVideo
        ? h('video', { class: 'player-media', controls: true, src: url, 'aria-label': name })
        : h('audio', { class: 'player-audio', controls: true, src: url, 'aria-label': name });
      const status = h('div', { class: 'statusbar', role: 'status' }, `${kind.label}, ${formatSize(entry.size)}`);
      // Locking the screen stops the sound too; it does not start again by itself.
      app.shell.lockChanged.on(locked => locked && media.pause(), app.signal);
      media.addEventListener('error', () => (status.textContent = 'The browser cannot play this file. It may be damaged or in a format this browser does not know.'), { signal: app.signal });
      app.root.replaceChildren(isVideo ? media : h('div', { class: 'player-stage' }, icon('music', 96), h('div', { class: 'player-name' }, name), media), status);
    } catch (error) {
      await shell.report('Could not open the file', error);
      message('This file could not be opened.');
    }
  },
};
