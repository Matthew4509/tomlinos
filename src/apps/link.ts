// Web links (.url files, the same "internet shortcut" Windows makes). Opening one shows where it goes first, then opens
// it in a new browser tab on request. Pages are never shown inside the desktop: most sites (YouTube, banks, mail)
// refuse to be framed, and a framed page could not use the person's own sign-ins anyway. Only http and https links
// are followed; the address shown is the real one (international names in their plain "xn--" form), so a
// look-alike name cannot hide where a link leads.
import { h, on } from '../core/dom.ts';
import { baseName } from '../fs/names.ts';
import type { AppDef } from '../shell/types.ts';
import { APPS } from './catalog.ts';

/** A full http(s) address, or null. */
export function webAddress(text: string): URL | null {
  try {
    const url = new URL(text.trim());
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname ? url : null;
  } catch {
    return null;
  }
}

/** The address in a .url file ("URL=" line), or a bare address on its own. */
export function linkTarget(text: string): URL | null {
  const line = /^\s*URL\s*=\s*(.+?)\s*$/im.exec(text);
  return webAddress(line ? line[1] : text.split(/\r?\n/)[0] ?? '');
}

export function openInNewTab(url: URL): void {
  // noopener: the new tab gets no handle back to the desktop; noreferrer: the site is not told where it came from.
  window.open(url.href, '_blank', 'noopener,noreferrer');
}

export const linkApp: AppDef = {
  ...APPS.link,
  async launch(app, arg) {
    const shell = app.shell;
    app.root.classList.add('linkapp');
    if (!arg) {
      app.root.append(h('p', { class: 'pad' }, 'Open a web link file (.url) to use this.'));
      return;
    }
    let url: URL | null = null;
    try {
      const entry = await shell.fs.stat(arg);
      // A real .url file is a few hundred bytes; anything big is not a link file, and is not read.
      if (entry && entry.size > 64 * 1024) throw new Error(`“${entry.name}” is too big to be a web link file.`);
      url = linkTarget(await shell.fs.readText(arg));
    } catch (error) {
      await shell.report('Could not open the link', error);
      app.close();
      return;
    }
    app.setTitle(baseName(arg));
    if (!url) {
      app.root.append(h('div', { class: 'pad' },
        h('p', {}, 'This link does not hold a web address that starts with https:// or http://, so it is not followed.'),
        h('p', { class: 'hint' }, 'You can open it in Notepad to see or fix what is inside.')));
      return;
    }
    const target = url;
    const openBtn = h('button', { type: 'button', class: 'btn primary' }, 'Open in a new tab');
    const copyBtn = h('button', { type: 'button', class: 'btn' }, 'Copy address');
    app.root.append(h('div', { class: 'pad' },
      h('p', {}, 'This link goes to:'),
      h('p', { class: 'link-host' }, target.hostname),
      h('p', { class: 'link-full' }, target.href),
      h('p', { class: 'hint' }, 'It opens in a new tab of your browser, where your own sign-ins work. The desktop stays open in this tab.'),
      h('div', { class: 'row-buttons' }, openBtn, copyBtn)));
    on(openBtn, 'click', () => {
      openInNewTab(target);
      app.close();
    }, app.signal);
    on(copyBtn, 'click', () => {
      void navigator.clipboard.writeText(target.href).then(
        () => shell.toast('Address copied.'),
        () => shell.toast('The browser did not allow copying. Select the address above and press Ctrl+C.'),
      );
    }, app.signal);
    openBtn.focus();
  },
};
