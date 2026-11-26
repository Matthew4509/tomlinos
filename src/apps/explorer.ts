// File Explorer. A menu bar (File, Edit, View, Go, Help) and a toolbar of small pictures (Back, Forward, Up, New folder,
// Cut, Copy, Paste, Rename, Delete, Properties, Refresh), then the address row (the path (click it to type one),
// Search, Upload, Download), the shared folder view, and a status line. Every part of the path is a drop target for
// moving items. The search box (Ctrl+F) looks through this folder and every folder inside it, by name and, when
// ticked, inside text files.
import { css, h, on } from '../core/dom.ts';
import { formatDate } from '../core/format.ts';
import { joinPath, nameKey, parentPath, splitPath } from '../fs/names.ts';
import { fileTypeOf } from '../shell/filetypes.ts';
import { createFolderView } from '../shell/foldview.ts';
import { icon } from '../shell/icons.ts';
import { MAX_HITS, searchFiles } from '../shell/search.ts';
import type { AppDef } from '../shell/types.ts';
import { destinationReason } from '../shell/actions.ts';
import { classicBar } from '../shell/menubar.ts';
import { APPS } from './catalog.ts';
import { fromMenuItems, helpMenu } from './classic-menus.ts';

export const explorerApp: AppDef = {
  ...APPS.explorer,
  async launch(app, arg) {
    const shell = app.shell;
    let path = joinPath(arg ?? '/');
    const back: string[] = [];
    const forward: string[] = [];

    const crumbs = h('nav', { class: 'crumbs', 'aria-label': 'Folder path', title: 'Click the empty part to type a path' });
    const address = h('input', { type: 'text', class: 'field address', 'aria-label': 'Folder path', spellcheck: 'false', autocomplete: 'off' });
    css(address, { display: 'none' });
    const uploadBtn = h('button', { type: 'button', class: 'tool wide', title: 'Upload files from your computer (Shift: a folder)' }, 'Upload');
    const downloadBtn = h('button', { type: 'button', class: 'tool wide', title: 'Download the selected items' }, 'Download');
    const search = h('input', { type: 'search', class: 'field search', placeholder: 'Search', 'aria-label': 'Search this folder and the folders inside it', autocomplete: 'off', spellcheck: 'false', title: 'Search (Ctrl+F). Enter searches; Escape goes back to the folder.' });
    const inside = h('input', { type: 'checkbox', checked: true });
    const insideLabel = h('label', { class: 'search-inside', title: 'Also look inside text, code and spreadsheet files (up to 1 MB each)' }, inside, 'Inside files');
    const body = h('div', { class: 'explorer-view' });
    const results = h('div', { class: 'search-results', role: 'list', 'aria-label': 'Search results', hidden: true });
    const statusEl = h('div', { class: 'statusbar', role: 'status' });
    app.root.classList.add('explorer');
    const addressRow = h('div', { class: 'toolbar' }, crumbs, address, search, insideLabel, uploadBtn, downloadBtn);

    const view = createFolderView({
      shell,
      host: body,
      signal: app.signal,
      mode: 'explorer',
      label: 'Files and folders',
      path: () => path,
      onOpenFolder: p => go(p),
      onUp: () => up(),
      onStatus: text => (statusEl.textContent = text),
    });

    // ---- Menu bar and toolbar ----
    const cmd = view.commands;
    const chosen = () => view.selectedPaths();
    const some = () => chosen().length > 0;
    const atTop = () => splitPath(path).length === 0;
    const properties = () => {
      const one = chosen();
      void shell.actions.properties(one.length === 1 ? one[0] : path);
    };
    const recycle = () => {
      const paths = chosen();
      if (paths.length) void shell.actions.deleteToBin(paths);
    };
    const download = () => {
      const paths = chosen();
      if (paths.length) void shell.transfers.download(paths);
      else void shell.dialogs.alert('Nothing selected', 'Click a file or folder first, then Download.');
    };
    const findBox = () => {
      search.focus();
      search.select();
    };
    const bar = classicBar({
      menus: [
        { label: 'File', items: [
          { label: 'Open', shortcut: 'Enter', enabled: () => cmd.chosen() > 0, action: () => cmd.open() },
          { separator: true },
          { label: 'New folder', icon: 'new-folder', action: () => void cmd.create('folder') },
          { label: 'New', submenu: [
            { label: 'Text document', action: () => void cmd.create('text') },
            { label: 'Spreadsheet', action: () => void cmd.create('sheet') },
            { label: 'Web link...', action: () => void cmd.create('link') },
          ] },
          { separator: true },
          { label: 'Upload files...', action: () => shell.transfers.choose('files', path) },
          { label: 'Upload a folder...', action: () => shell.transfers.choose('folder', path) },
          { label: 'Download', enabled: some, action: download },
          { separator: true },
          { label: 'Open Terminal here', shown: () => shell.hasApp('terminal'), action: () => void shell.openApp('terminal', path) },
          { label: 'Properties', icon: 'properties', shortcut: 'Alt+Enter', action: properties },
          { separator: true },
          { label: 'Close', icon: 'close', shortcut: 'Alt+Q', action: () => app.close() },
        ] },
        { label: 'Edit', items: [
          { label: 'Cut', icon: 'cut', shortcut: 'Ctrl+X', enabled: some, action: () => shell.actions.setClipboard('cut', chosen()) },
          { label: 'Copy', icon: 'copy', shortcut: 'Ctrl+C', enabled: some, action: () => shell.actions.setClipboard('copy', chosen()) },
          { label: 'Paste', icon: 'paste', shortcut: 'Ctrl+V', enabled: () => !!shell.clipboard, action: () => void shell.actions.paste(path) },
          { separator: true },
          { label: 'Delete', icon: 'recycle', shortcut: 'Delete', enabled: some, action: recycle },
          { label: 'Rename', icon: 'rename', shortcut: 'F2', enabled: () => cmd.chosen() === 1 && some(), action: () => cmd.rename() },
          { separator: true },
          { label: 'Select all', icon: 'select-all', shortcut: 'Ctrl+A', action: () => cmd.selectAll() },
          { separator: true },
          { label: 'Search...', icon: 'find', shortcut: 'Ctrl+F', action: findBox },
        ] },
        { label: 'View', items: () => [
          ...fromMenuItems(cmd.viewItems()),
          { separator: true },
          { label: 'Sort by', submenu: () => fromMenuItems(cmd.sortItems()) },
          { label: 'Search inside files', checked: () => inside.checked, action: () => {
            inside.checked = !inside.checked;
            if (search.value.trim()) void runSearch();
          } },
          { separator: true },
          { label: 'Refresh', icon: 'refresh', shortcut: 'F5', action: () => void view.refresh() },
        ] },
        { label: 'Go', items: [
          { label: 'Back', icon: 'back', shortcut: 'Alt+Left', enabled: () => back.length > 0, action: goBack },
          { label: 'Forward', icon: 'forward', shortcut: 'Alt+Right', enabled: () => forward.length > 0, action: goForward },
          { label: 'Up one folder', icon: 'up-folder', shortcut: 'Alt+Up', enabled: () => !atTop(), action: up },
          { separator: true },
          { label: 'Type a path...', shortcut: 'Ctrl+L', action: editPath },
          { label: 'This desktop', action: () => go('/') },
          { label: 'Recycle Bin', shown: () => shell.hasApp('trash'), action: () => void shell.openApp('trash') },
        ] },
        helpMenu(shell),
      ],
      tools: [
        { label: 'Back', icon: 'back', shortcut: 'Alt+Left', enabled: () => back.length > 0, action: goBack },
        { label: 'Forward', icon: 'forward', shortcut: 'Alt+Right', enabled: () => forward.length > 0, action: goForward },
        { id: 'up', label: 'Up one folder', icon: 'up-folder', shortcut: 'Alt+Up', enabled: () => !atTop(), action: up },
        '|',
        { label: 'New folder', icon: 'new-folder', action: () => void cmd.create('folder') },
        '|',
        { label: 'Cut', icon: 'cut', shortcut: 'Ctrl+X', enabled: some, action: () => shell.actions.setClipboard('cut', chosen()) },
        { label: 'Copy', icon: 'copy', shortcut: 'Ctrl+C', enabled: some, action: () => shell.actions.setClipboard('copy', chosen()) },
        { label: 'Paste', icon: 'paste', shortcut: 'Ctrl+V', enabled: () => !!shell.clipboard, action: () => void shell.actions.paste(path) },
        '|',
        { label: 'Rename', icon: 'rename', shortcut: 'F2', enabled: () => cmd.chosen() === 1 && some(), action: () => cmd.rename() },
        { label: 'Delete (to the Recycle Bin)', icon: 'recycle', shortcut: 'Delete', enabled: some, action: recycle },
        { label: 'Properties', icon: 'properties', shortcut: 'Alt+Enter', action: properties },
        '|',
        { label: 'Refresh', icon: 'refresh', shortcut: 'F5', action: () => void view.refresh() },
      ],
    }, { layer: shell.menus, signal: app.signal, scope: app.root, doc: () => body.querySelector<HTMLElement>('[tabindex="0"]') ?? body, label: 'File Explorer menu bar' });
    app.root.append(bar.el, addressRow, body, results, statusEl);
    shell.clipboardChanged.on(() => bar.refresh(), app.signal);

    function drawCrumbs(): void {
      const parts = splitPath(path);
      const nodes: Node[] = [];
      const make = (label: string, target: string) => {
        const b = h('button', { type: 'button', class: 'crumb', 'data-drop-path': target }, label);
        b.addEventListener('click', () => go(target), { signal: app.signal });
        return b;
      };
      nodes.push(make('This desktop', '/'));
      parts.forEach((part, i) => {
        nodes.push(h('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '›'), make(part, joinPath(...parts.slice(0, i + 1))));
      });
      crumbs.replaceChildren(...nodes);
      // A deep path keeps the folder you are in visible: the bar shows its end, as a file manager does.
      requestAnimationFrame(() => (crumbs.scrollLeft = crumbs.scrollWidth));
      const title = parts.length ? parts[parts.length - 1] : 'This desktop';
      app.setTitle(title);
      app.setIcon(parts.length ? 'folder' : 'files');
      bar.refresh();
    }

    async function show(): Promise<void> {
      drawCrumbs();
      void learnChain(path);
      await view.refresh();
    }

    // ---- Following a rename ----
    // The folders along the path, by id: one renamed here, in another window or another tab is followed to its new
    // name instead of the window saying the folder is not there. One moved elsewhere or deleted is not followed.
    let chain: string[] = [];
    async function learnChain(at: string): Promise<void> {
      const parts = splitPath(at);
      const ids: string[] = [];
      try {
        for (let i = 0; i < parts.length; i++) {
          const entry = await shell.fs.stat(joinPath(...parts.slice(0, i + 1)));
          if (entry?.kind !== 'folder') return;
          ids.push(entry.id);
        }
      } catch {
        return;
      }
      if (at === path) chain = ids;
    }
    let following = false;
    let followAgain = false;
    async function follow(): Promise<void> {
      if (following) return void (followAgain = true);
      if (!chain.length) return;
      following = true;
      followAgain = false;
      const at = path;
      try {
        const parts: string[] = [];
        for (const id of chain) {
          const found = (await shell.fs.list(joinPath(...parts), true)).find(e => e.id === id && e.kind === 'folder');
          if (!found) return;
          parts.push(found.name);
        }
        const now = joinPath(...parts);
        if (at !== path || now === path) return;
        const old = path;
        path = now;
        // Back and Forward lead to the folder's new name too.
        const moved = (p: string) => (p === old || p.startsWith(old + '/') ? now + p.slice(old.length) : p);
        back.splice(0, back.length, ...back.map(moved));
        forward.splice(0, forward.length, ...forward.map(moved));
        drawCrumbs();
        await view.refresh();
      } catch {
        // Could not look: the window shows what it finds, as before.
      } finally {
        following = false;
        if (followAgain) void follow();
      }
    }
    // A rename changes the folder holding the renamed one: a change to any folder above this one may be a rename.
    shell.changes.on(paths => {
      const mine = splitPath(path).map(nameKey);
      const above = paths.some(p => {
        const theirs = splitPath(p).map(nameKey);
        return theirs.length < mine.length && theirs.every((part, i) => part === mine[i]);
      });
      if (above) void follow();
    }, app.signal);

    // ---- Search ----
    let searching: AbortController | null = null;
    function endSearch(): void {
      const was = searching !== null || !results.hidden;
      searching?.abort();
      searching = null;
      results.hidden = true;
      results.replaceChildren();
      body.hidden = false;
      // The status bar goes back to the folder's own count, not the last "found" line.
      if (was) void view.refresh();
    }
    async function runSearch(): Promise<void> {
      const query = search.value.trim();
      searching?.abort();
      if (!query) return endSearch();
      const abort = new AbortController();
      searching = abort;
      body.hidden = true;
      results.hidden = false;
      results.replaceChildren();
      const where = path === '/' ? 'This desktop' : path;
      statusEl.textContent = `Searching ${where}…`;
      let count = 0;
      const outcome = await searchFiles(shell.fs, path, query, {
        contents: inside.checked,
        signal: abort.signal,
        onProgress: n => {
          if (!abort.signal.aborted) statusEl.textContent = `Searching ${where}… ${n} folder${n === 1 ? '' : 's'} looked at, ${count} found`;
        },
        onHit: hit => {
          count++;
          const folder = hit.path.slice(0, hit.path.length - hit.name.length - 1) || '/';
          const row = h('button', { type: 'button', class: 'search-hit', role: 'listitem', title: `Open ${hit.name}` },
            icon(hit.kind === 'folder' ? 'folder' : fileTypeOf(hit.name).icon, 32),
            h('span', { class: 'hit-text' },
              h('span', { class: 'hit-name' }, hit.name),
              h('span', { class: 'hit-where' }, `${folder === '/' ? 'This desktop' : folder} · ${formatDate(hit.modified)}`),
              hit.snippet ? h('span', { class: 'hit-snippet' }, hit.snippet) : null),
          );
          // A folder opens here, in this window, as a folder clicked in the list does; a file opens in its app.
          const open = () => (hit.kind === 'folder' ? go(hit.path) : void shell.openPath(hit.path));
          row.addEventListener('click', open, { signal: app.signal });
          row.addEventListener('contextmenu', event => {
            event.preventDefault();
            shell.menus.show([
              { label: 'Open', action: open },
              { label: 'Open folder location', action: () => { search.value = ''; endSearch(); go(folder); } },
            ], event.clientX, event.clientY, { returnFocus: row });
          }, { signal: app.signal });
          results.append(row);
        },
      });
      if (abort.signal.aborted) return;
      searching = null;
      if (!count) results.append(h('p', { class: 'hint search-none' }, `Nothing called “${query}”${inside.checked ? ' or containing it' : ''} in ${where}. To search everywhere, start from This desktop.`));
      statusEl.textContent = outcome.capped ? `The first ${MAX_HITS} results. Add a word to narrow it down.` : `${count} found in ${where}.`;
    }
    let typing = 0;
    on(search, 'input', () => {
      clearTimeout(typing);
      typing = window.setTimeout(() => void runSearch(), 350);
    }, app.signal);
    on(search, 'keydown', (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        clearTimeout(typing);
        void runSearch();
      } else if (event.key === 'Escape') {
        event.stopPropagation();
        search.value = '';
        endSearch();
        void view.refresh();
        view.focus();
      } else if (event.key === 'ArrowDown') {
        const first = results.querySelector<HTMLElement>('.search-hit');
        if (first) {
          event.preventDefault();
          first.focus();
        }
      }
    }, app.signal);
    on(results, 'keydown', (event: KeyboardEvent) => {
      const rows = [...results.querySelectorAll<HTMLElement>('.search-hit')];
      const at = rows.indexOf(document.activeElement as HTMLElement);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const next = at + (event.key === 'ArrowDown' ? 1 : -1);
        if (next < 0) search.focus();
        else rows[Math.min(next, rows.length - 1)]?.focus();
      } else if (event.key === 'Escape') {
        search.focus();
      }
    }, app.signal);
    on(inside, 'change', () => search.value.trim() && void runSearch(), app.signal);
    app.signal.addEventListener('abort', () => searching?.abort(), { once: true });

    function go(target: string, remember = true): void {
      const next = joinPath(target);
      if (search.value || searching || !results.hidden) {
        search.value = '';
        endSearch();
      }
      if (next === path) return;
      if (remember) {
        back.push(path);
        forward.length = 0;
      }
      path = next;
      void show();
      view.focus();
    }

    function up(): void {
      if (splitPath(path).length) go(parentPath(path));
    }

    function goBack(): void {
      const to = back.pop();
      if (to === undefined) return;
      forward.push(path);
      go(to, false);
    }
    function goForward(): void {
      const to = forward.pop();
      if (to === undefined) return;
      back.push(path);
      go(to, false);
    }

    function editPath(): void {
      address.value = path === '/' ? '/' : path;
      css(crumbs, { display: 'none' });
      css(address, { display: null });
      address.focus();
      address.select();
    }
    function stopEditing(): void {
      css(address, { display: 'none' });
      css(crumbs, { display: null });
    }
    on(crumbs, 'click', (event: MouseEvent) => {
      if (event.target === crumbs) editPath();
    }, app.signal);
    on(address, 'keydown', async (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        stopEditing();
        view.focus();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        const typed = address.value.trim().replace(/^This desktop/i, '');
        // While a message about the path is up, the box stays open with what was typed, ready to correct.
        const tell = async (say: () => Promise<void>) => {
          asking = true;
          try {
            await say();
          } finally {
            asking = false;
          }
          css(crumbs, { display: 'none' });
          css(address, { display: null });
          address.focus();
        };
        let target: string;
        try {
          target = joinPath(typed);
          const refused = destinationReason(target);
          if (refused) return await tell(() => shell.dialogs.alert('That folder is not for files', refused));
          const entry = await shell.fs.stat(target);
          if (target !== '/' && entry?.kind !== 'folder') {
            return await tell(() => shell.dialogs.alert('No such folder', entry ? `“${target}” is a file, not a folder.` : `There is no folder called “${target}”.`, 'Check the spelling, or click a folder in the list.'));
          }
          // The folder's names as they are spelt, not as typed ("/documents" opens "Documents").
          const parts = splitPath(target);
          const real: string[] = [];
          for (let i = 0; i < parts.length; i++) real.push((await shell.fs.stat(joinPath(...parts.slice(0, i + 1))))?.name ?? parts[i]);
          target = joinPath(...real);
        } catch (error) {
          return await tell(() => shell.report('Could not open that path', error));
        }
        stopEditing();
        go(target);
        view.focus();
      }
    }, app.signal);
    let asking = false;
    on(address, 'blur', () => !asking && stopEditing(), app.signal);
    on(uploadBtn, 'click', (event: MouseEvent) => shell.transfers.choose(event.shiftKey ? 'folder' : 'files', path), app.signal);
    on(downloadBtn, 'click', download, app.signal);
    on(app.root, 'keydown', (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        search.focus();
        search.select();
      } else if (event.ctrlKey && event.key.toLowerCase() === 'l') {
        event.preventDefault();
        editPath();
      } else if (event.altKey && !event.ctrlKey && !event.metaKey) {
        // Alt alone: Ctrl+Alt+arrow snaps the window (keys.ts) and must not also go Back, Forward or Up.
        if (event.key === 'ArrowLeft') goBack();
        else if (event.key === 'ArrowRight') goForward();
        else if (event.key === 'ArrowUp') up();
      }
    }, app.signal);

    await show();
  },
};
