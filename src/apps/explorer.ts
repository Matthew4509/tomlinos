// File Explorer. A toolbar (Back, Forward, Up, the path (click it to type one), Upload, Download), the shared
// folder view, and a status line. Every part of the path is a drop target for moving items. The search box (Ctrl+F)
// looks through this folder and every folder inside it, by name and, when ticked, inside text files.
import { css, h, on } from '../core/dom.ts';
import { formatDate } from '../core/format.ts';
import { joinPath, parentPath, splitPath } from '../fs/names.ts';
import { fileTypeOf } from '../shell/filetypes.ts';
import { createFolderView } from '../shell/foldview.ts';
import { icon } from '../shell/icons.ts';
import { MAX_HITS, searchFiles } from '../shell/search.ts';
import type { AppDef } from '../shell/types.ts';
import { APPS } from './catalog.ts';

export const explorerApp: AppDef = {
  ...APPS.explorer,
  async launch(app, arg) {
    const shell = app.shell;
    let path = joinPath(arg ?? '/');
    const back: string[] = [];
    const forward: string[] = [];

    const backBtn = h('button', { type: 'button', class: 'tool', 'aria-label': 'Back', title: 'Back' }, '←');
    const forwardBtn = h('button', { type: 'button', class: 'tool', 'aria-label': 'Forward', title: 'Forward' }, '→');
    const upBtn = h('button', { type: 'button', class: 'tool', 'aria-label': 'Up one folder', title: 'Up one folder' }, '↑');
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
    app.root.append(h('div', { class: 'toolbar' }, backBtn, forwardBtn, upBtn, crumbs, address, search, insideLabel, uploadBtn, downloadBtn), body, results, statusEl);

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
      const title = parts.length ? parts[parts.length - 1] : 'This desktop';
      app.setTitle(title);
      app.setIcon(parts.length ? 'folder' : 'files');
      backBtn.disabled = back.length === 0;
      forwardBtn.disabled = forward.length === 0;
      upBtn.disabled = parts.length === 0;
    }

    async function show(): Promise<void> {
      drawCrumbs();
      await view.refresh();
    }

    // ---- Search ----
    let searching: AbortController | null = null;
    function endSearch(): void {
      searching?.abort();
      searching = null;
      results.hidden = true;
      results.replaceChildren();
      body.hidden = false;
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
          row.addEventListener('click', () => void shell.openPath(hit.path), { signal: app.signal });
          row.addEventListener('contextmenu', event => {
            event.preventDefault();
            shell.menus.show([
              { label: 'Open', action: () => void shell.openPath(hit.path) },
              { label: 'Open folder location', action: () => { search.value = ''; endSearch(); go(folder); } },
            ], event.clientX, event.clientY, { returnFocus: row });
          }, { signal: app.signal });
          results.append(row);
        },
      });
      if (abort.signal.aborted) return;
      searching = null;
      if (!count) results.append(h('p', { class: 'hint search-none' }, `Nothing called “${query}”${inside.checked ? ' or containing it' : ''} in ${where}. Search looks in this folder and every folder inside it; to look everywhere, go to This desktop first.`));
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

    on(backBtn, 'click', () => {
      const to = back.pop();
      if (to === undefined) return;
      forward.push(path);
      go(to, false);
    }, app.signal);
    on(forwardBtn, 'click', () => {
      const to = forward.pop();
      if (to === undefined) return;
      back.push(path);
      go(to, false);
    }, app.signal);
    on(upBtn, 'click', up, app.signal);

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
        let target: string;
        try {
          target = joinPath(typed);
          const entry = await shell.fs.stat(target);
          if (target !== '/' && entry?.kind !== 'folder') {
            await shell.dialogs.alert('No such folder', entry ? `“${target}” is a file, not a folder.` : `There is no folder called “${target}”.`, 'Check the spelling, or click a folder in the list.');
            address.focus();
            return;
          }
        } catch (error) {
          await shell.report('Could not open that path', error);
          address.focus();
          return;
        }
        stopEditing();
        go(target);
        view.focus();
      }
    }, app.signal);
    on(address, 'blur', () => stopEditing(), app.signal);
    on(uploadBtn, 'click', (event: MouseEvent) => shell.transfers.choose(event.shiftKey ? 'folder' : 'files', path), app.signal);
    on(downloadBtn, 'click', () => {
      const chosen = view.selectedPaths();
      if (chosen.length) void shell.transfers.download(chosen);
      else void shell.dialogs.alert('Nothing selected', 'Click a file or folder first, then Download.');
    }, app.signal);
    on(app.root, 'keydown', (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        search.focus();
        search.select();
      } else if (event.ctrlKey && event.key.toLowerCase() === 'l') {
        event.preventDefault();
        editPath();
      } else if (event.altKey && event.key === 'ArrowLeft') backBtn.click();
      else if (event.altKey && event.key === 'ArrowRight') forwardBtn.click();
      else if (event.altKey && event.key === 'ArrowUp') up();
    }, app.signal);

    await show();
  },
};
