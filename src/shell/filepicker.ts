// The "Open" and "Save as" windows apps share: browse folders, choose a file (or type a name to save as). Built on the
// dialog layer, so focus, Escape and the backdrop behave like every other dialog. Hidden entries are never listed.
import { h, on } from '../core/dom.ts';
import { formatSize } from '../core/format.ts';
import type { Entry } from '../fs/fs.ts';
import { baseName, joinPath, nameProblem, parentPath, splitPath } from '../fs/names.ts';
import { extensionOf, fileTypeOf } from './filetypes.ts';
import { icon } from './icons.ts';
import type { Shell } from './types.ts';

export interface PickOptions {
  title: string;
  /** Folder to start in (a missing folder falls back to /Documents, then the top). */
  folder?: string;
  /** Extensions to list, without the dot ("txt", "md"); empty lists every file. */
  accept?: string[];
  ok?: string;
}

export interface SaveOptions extends PickOptions {
  /** The name suggested in the box. */
  name: string;
}

async function firstFolder(shell: Shell, candidates: string[]): Promise<string> {
  for (const c of candidates) {
    try {
      const e = await shell.fs.stat(c);
      if (e?.kind === 'folder' || c === '/') return c;
    } catch {
      // Try the next one.
    }
  }
  return '/';
}

function picker(shell: Shell, options: PickOptions, save: SaveOptions | null, folderOnly = false): Promise<string | null> {
  const accept = new Set((options.accept ?? []).map(e => e.toLowerCase()));
  let folder = '/';
  let chosen: string | null = null;
  let entries: Entry[] = [];
  const abort = new AbortController();

  const where = h('div', { class: 'pick-where' });
  const upBtn = h('button', { type: 'button', class: 'tool wide', title: 'Up one folder', 'aria-label': 'Up one folder' }, '↑ Up');
  const list = h('div', { class: 'pick-list', role: 'listbox', 'aria-label': 'Files and folders', tabindex: '0' });
  const nameInput = save ? h('input', { type: 'text', class: 'field', value: save.name, 'aria-label': 'File name', spellcheck: false, autocomplete: 'off' }) : null;
  const problem = h('p', { class: 'dialog-problem', role: 'alert' });
  const body = h('div', { class: 'pick' }, h('div', { class: 'pick-bar' }, upBtn, where), list,
    nameInput ? h('label', { class: 'dialog-label' }, 'File name', nameInput) : null, problem);

  const shown = (e: Entry) => e.kind === 'folder' || (!folderOnly && (accept.size === 0 || accept.has(extensionOf(e.name))));

  async function go(path: string) {
    try {
      entries = (await shell.fs.list(path)).filter(shown)
        .sort((a, b) => Number(b.kind === 'folder') - Number(a.kind === 'folder') || a.name.localeCompare(b.name, undefined, { numeric: true }));
      folder = path;
      problem.textContent = '';
    } catch (error) {
      problem.textContent = error instanceof Error ? error.message : 'That folder cannot be opened.';
      return;
    }
    chosen = null;
    where.textContent = folder === '/' ? 'This desktop' : splitPath(folder).join(' › ');
    upBtn.disabled = folder === '/';
    list.replaceChildren(...entries.map(e => {
      const path = joinPath(folder, e.name);
      const row = h('div', { class: 'pick-row', role: 'option', 'aria-selected': 'false', tabindex: '-1', 'data-path': path },
        icon(e.kind === 'folder' ? 'folder' : fileTypeOf(e.name).icon, 20), h('span', { class: 'pick-name' }, e.name),
        h('span', { class: 'pick-size' }, e.kind === 'file' ? formatSize(e.size) : ''));
      on(row, 'click', () => choose(row, e), abort.signal);
      on(row, 'dblclick', () => (e.kind === 'folder' ? void go(path) : (choose(row, e), okBtn()?.click())), abort.signal);
      on(row, 'keydown', (event: KeyboardEvent) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.stopPropagation();
          if (e.kind === 'folder') void go(path);
          else okBtn()?.click();
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const next = (event.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling) as HTMLElement | null;
          next?.click();
          next?.focus();
        }
      }, abort.signal);
      return row;
    }));
    if (!entries.length) list.append(h('p', { class: 'pick-empty' }, accept.size ? 'Nothing here of the right kind.' : 'This folder is empty.'));
    list.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function choose(row: HTMLElement, e: Entry) {
    for (const r of list.querySelectorAll('.pick-row')) r.setAttribute('aria-selected', String(r === row));
    chosen = row.dataset.path ?? null;
    if (nameInput && e.kind === 'file') nameInput.value = e.name;
    list.dispatchEvent(new Event('change', { bubbles: true }));
    if (e.kind === 'folder') chosen = null;
  }

  const okBtn = () => body.closest('.dialog')?.querySelector<HTMLButtonElement>('.btn.primary');
  on(upBtn, 'click', () => void go(parentPath(folder)), abort.signal);

  return (async () => {
    folder = await firstFolder(shell, [options.folder ?? '/Documents', '/Documents', '/']);
    await go(folder);
    const answer = await shell.dialogs.ask<string>({
      title: options.title,
      body,
      buttons: [
        { label: options.ok ?? (save ? 'Save' : folderOnly ? 'Choose this folder' : 'Open'), value: 'ok', primary: true },
        { label: 'Cancel', value: 'cancel' },
      ],
      cancel: 'cancel',
      primaryEnabled: () => (folderOnly ? true : save ? nameProblem(nameInput!.value) === null : chosen !== null),
      focus: () => nameInput ?? list,
    });
    abort.abort();
    if (answer !== 'ok') return null;
    if (folderOnly) return folder;
    if (!save) return chosen;
    return joinPath(folder, nameInput!.value);
  })();
}

/** Asks for a file to open; null when cancelled. */
export function pickFile(shell: Shell, options: PickOptions): Promise<string | null> {
  return picker(shell, options, null);
}

/** Asks for a folder (the one being shown when the person presses the button); null when cancelled. */
export function pickFolder(shell: Shell, options: PickOptions): Promise<string | null> {
  return picker(shell, options, null, true);
}

/**
 * Asks where to save and under what name. When the name is already taken, asks whether to replace it; returns the
 * path and whether it already existed, or null when cancelled.
 */
export async function pickSave(shell: Shell, options: SaveOptions): Promise<{ path: string; replace: boolean } | null> {
  for (;;) {
    const path = await picker(shell, options, options);
    if (path === null) return null;
    let existing: Entry | null = null;
    try {
      existing = await shell.fs.stat(path);
    } catch {
      // Saving will say what is wrong.
    }
    if (!existing) return { path, replace: false };
    if (existing.kind === 'folder') {
      await shell.dialogs.alert('That is a folder', `“${baseName(path)}” is a folder. Choose another name.`);
    } else if (await shell.dialogs.confirm({ title: 'Replace it?', text: `“${existing.name}” already exists. Replace it with this one?`, ok: 'Replace', danger: true, cancel: 'Choose another name' })) {
      return { path, replace: true };
    }
    options = { ...options, folder: parentPath(path), name: baseName(path) };
  }
}

