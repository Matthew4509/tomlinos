// Shared by the viewers that show one file at a time (PDF Viewer, Pictures, Player, Archive): a classic menu bar with
// File > Open... (Ctrl+O) and Close, and a work area below it. Opening another file clears the work area and loads the
// new file in the same window; everything the old file set up is stopped first (its own signal is aborted).
import { h } from '../core/dom.ts';
import { parentPath } from '../fs/names.ts';
import { pickFile, type FileTypeChoice } from '../shell/filepicker.ts';
import { classicBar, type BarItem } from '../shell/menubar.ts';
import type { AppHandle } from '../shell/types.ts';
import { helpMenu } from './classic-menus.ts';

export interface ViewerSpec {
  /** Names the menu bar for screen readers ("PDF Viewer"). */
  name: string;
  /** Title of the Open window. */
  openTitle: string;
  /** Where the Open window starts when no file is open. */
  folder: string;
  types: FileTypeChoice[];
  /** Shows `path` (or the empty state when there is none) in `view.root`, using `view.signal` for every listener. */
  load(view: AppHandle, path: string | undefined): void | Promise<void>;
  /** More File menu items, after Open... (the PDF Viewer's Print...). */
  fileItems?: BarItem[];
  /** An Edit menu, for a viewer that has one (the PDF Viewer's Find). */
  editItems?: BarItem[];
}

export function openableViewer(app: AppHandle, arg: string | undefined, spec: ViewerSpec): Promise<void> {
  const shell = app.shell;
  const body = h('div', { class: 'viewer-body' });
  let current = arg;
  let run: AbortController | null = null;
  let picking = false;

  async function choose(): Promise<void> {
    if (picking) return;
    picking = true;
    try {
      const path = await pickFile(shell, { title: spec.openTitle, folder: current ? parentPath(current) : spec.folder, ok: 'Open', types: spec.types });
      if (path && !app.signal.aborted) await start(path);
    } finally {
      picking = false;
    }
  }

  function start(path: string | undefined): void | Promise<void> {
    run?.abort();
    const mine = new AbortController();
    run = mine;
    app.signal.addEventListener('abort', () => mine.abort(), { once: true, signal: mine.signal });
    current = path;
    body.replaceChildren();
    return spec.load({ ...app, root: body, signal: mine.signal }, path);
  }

  const bar = classicBar({
    menus: [
      { label: 'File', items: [
        { label: 'Open...', icon: 'open', shortcut: 'Ctrl+O', action: () => void choose() },
        ...(spec.fileItems ?? []),
        { separator: true },
        { label: 'Close', icon: 'close', action: () => app.close() },
      ] },
      ...(spec.editItems ? [{ label: 'Edit', items: spec.editItems }] : []),
      helpMenu(shell),
    ],
  }, { layer: shell.menus, signal: app.signal, scope: app.root, label: `${spec.name} menu bar`, bindShortcuts: true });
  app.root.replaceChildren(bar.el, body);
  return Promise.resolve(start(arg));
}
