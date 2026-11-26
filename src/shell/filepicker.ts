// The "Open", "Save as" and "Choose a folder" windows apps share: a folder tree and recent folders on the left, Back,
// Forward, Up, a clickable path and a search box on top, the folder's files in Details or Tiles in the middle, a
// preview on the right, and the file name and file type at the bottom. New folder and Rename work in the tree and in
// the list. Built on the dialog layer, so focus, Escape and the backdrop behave like every other dialog. Hidden
// entries are never listed.
import { blobUrl, mediaTypeOf } from '../apps/media.ts';
import { css, h, on, svg } from '../core/dom.ts';
import { formatDate, formatSize, plural } from '../core/format.ts';
import type { Entry } from '../fs/fs.ts';
import { baseName, joinPath, nameKey, nameProblem, parentPath, splitPath, uniqueName } from '../fs/names.ts';
import { describeError } from './dialogs.ts';
import { extensionOf, fileTypeOf } from './filetypes.ts';
import { icon, STANDARD_FOLDERS, type IconName } from './icons.ts';
import { allows, finalSaveName, startingType, swapExtension, typeChoices } from './picktypes.ts';
import { toolIcon, type ToolIconId } from './toolicons.ts';
import type { Shell } from './types.ts';

/** One entry of the file-type drop-down. `ext` is without dots; an empty list means every file. */
export interface FileTypeChoice {
  label: string;
  ext: string[];
}

export interface PickOptions {
  title: string;
  /** Folder to start in (a missing folder falls back to /Documents, then the top). */
  folder?: string;
  /** Extensions to list, without the dot ("txt", "md"); empty lists every file. Used for the drop-down when `types` is not given. */
  accept?: string[];
  ok?: string;
  /** The file-type drop-down, in order. */
  types?: FileTypeChoice[];
}

export interface SaveOptions extends PickOptions {
  /** The name suggested in the box. */
  name: string;
}

type View = 'details' | 'tiles';
type SortKey = 'name' | 'modified' | 'type' | 'size';

/** Kept for each signed-in desktop while the page is open (never written to the browser's storage). */
interface Memory {
  recent: string[];
  view: View;
  preview: boolean;
}

const MEMORY = new WeakMap<Shell, Memory>();
const RECENT_MAX = 6;
/** Pictures larger than this are not read for a thumbnail. */
const THUMB_MAX = 4 * 1024 * 1024;
/** Text files larger than this are not read for the preview. */
const TEXT_MAX = 1024 * 1024;
const TEXT_ICONS = new Set<IconName>(['text', 'code', 'chip', 'calendar', 'contacts']);
const ROOT_NAME = 'This desktop';

function memoryOf(shell: Shell): Memory {
  let m = MEMORY.get(shell);
  if (!m) {
    m = { recent: [], view: 'details', preview: true };
    MEMORY.set(shell, m);
  }
  return m;
}

function remember(m: Memory, folder: string): void {
  m.recent = [folder, ...m.recent.filter(f => f !== folder)].slice(0, RECENT_MAX);
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

function iconFor(e: Entry, inFolder: string): IconName {
  if (e.kind === 'folder' && inFolder === '/') {
    const standard = `folder-${e.name.toLowerCase()}` as IconName;
    if (STANDARD_FOLDERS.has(standard)) return standard;
  }
  return fileTypeOf(e.name, e.kind).icon;
}

function folderIcon(path: string): IconName {
  if (path === '/') return 'folder';
  return iconFor({ name: baseName(path), id: '', kind: 'folder', size: 0, modified: 0 }, parentPath(path));
}

function canThumb(e: Entry): boolean {
  return e.kind === 'file' && e.size <= THUMB_MAX && (mediaTypeOf(e.name) ?? '').startsWith('image/');
}

function isTextKind(e: Entry): boolean {
  const ext = extensionOf(e.name);
  return e.kind === 'file' && (TEXT_ICONS.has(fileTypeOf(e.name).icon) || ext === 'csv' || ext === 'tsv');
}

/** Small pictures for the view buttons, drawn in the toolbar icons' house style. */
function viewIcon(kind: 'details' | 'tiles' | 'preview' | 'folders'): SVGElement {
  const line = (d: string, acc = false) => svg('path', { d, fill: 'none', stroke: 'currentColor', ...(acc ? { class: 'ti-acc-line' } : {}) });
  const parts: Record<typeof kind, SVGElement[]> = {
    details: [line('M1.5 2.5h2v2h-2zM1.5 7h2v2h-2zM1.5 11.5h2v2h-2z', true), line('M6 3.5h8.5M6 8h8.5M6 12.5h8.5')],
    tiles: [line('M1.5 1.5h5v5h-5zM9.5 1.5h5v5h-5zM1.5 9.5h5v5h-5z'), line('M9.5 9.5h5v5h-5z', true)],
    preview: [line('M1.5 2.5h13v11h-13zM9.5 2.5v11'), line('M11 5.5h2M11 8h2M11 10.5h2', true)],
    folders: [line('M3.5 2v10.5h4M3.5 6.5h4'), line('M8.5 4.5h6v4h-6zM8.5 10.5h6v4h-6z', true)],
  };
  return svg('svg', { viewBox: '0 0 16 16', width: 16, height: 16, class: 'ti', 'stroke-width': '1', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' }, ...parts[kind]);
}

function toolButton(picture: ToolIconId | SVGElement, label: string, extra = ''): HTMLButtonElement {
  return h('button', { type: 'button', class: `tool pick-tool${extra}`, title: label, 'aria-label': label }, typeof picture === 'string' ? toolIcon(picture) : picture);
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
  const mem = memoryOf(shell);
  const abort = new AbortController();
  const signal = abort.signal;
  const types = typeChoices(options.types, options.accept, save !== null);
  let typeIndex = startingType(types, save ? save.name : null);

  let folder = '/';
  let entries: Entry[] = [];
  let shown: Entry[] = [];
  let selected: string | null = null;
  let chosen: string | null = null;
  let lastFileName = save?.name ?? '';
  let sortKey: SortKey = 'name';
  let sortDir = 1;
  let lastPane: 'tree' | 'list' = 'list';
  let editing = false;
  let goSeq = 0;
  let previewSeq = 0;
  const back: string[] = [];
  const forward: string[] = [];
  let kids = new Map<string, string[]>();
  let expanded = new Set<string>(['/']);
  const thumbs = new Map<string, Promise<string | null>>();
  const urls: string[] = [];
  let observer: IntersectionObserver | null = null;
  const rowByName = new Map<string, HTMLElement>();
  const nodeByPath = new Map<string, HTMLElement>();
  const uid = crypto.randomUUID().slice(0, 8);

  // ---- Parts ----
  const backBtn = toolButton('back', 'Back');
  const forwardBtn = toolButton('forward', 'Forward');
  const upBtn = toolButton('up-folder', 'Up one folder');
  const crumbs = h('div', { class: 'crumbs pick-crumbs', role: 'navigation', 'aria-label': 'Folder path' });
  const search = h('input', { type: 'search', class: 'field pick-search', placeholder: 'Search this folder', 'aria-label': 'Search this folder', spellcheck: false, autocomplete: 'off' });
  const newFolderBtn = toolButton('new-folder', 'New folder');
  const renameBtn = toolButton('rename', 'Rename (F2)');
  const refreshBtn = toolButton('refresh', 'Refresh');
  const foldersBtn = toolButton(viewIcon('folders'), 'Show folders', ' pick-folders-btn');
  const detailsBtn = toolButton(viewIcon('details'), 'Details');
  const tilesBtn = toolButton(viewIcon('tiles'), 'Tiles');
  const previewBtn = toolButton(viewIcon('preview'), 'Preview pane');

  const tree = h('div', { class: 'pick-tree', role: 'tree', 'aria-label': 'Folders', tabindex: '0' });
  const recentList = h('div', { class: 'pick-recent', role: 'list' });
  const recentBox = h('div', { class: 'pick-recent-box' }, h('div', { class: 'pick-side-title' }, 'Recent folders'), recentList);
  const side = h('div', { class: 'pick-side' }, tree, recentBox);

  const head = h('div', { class: 'pick-head' });
  const columns: Array<[SortKey, string]> = [['name', 'Name'], ['modified', 'Date modified'], ['type', 'Type'], ['size', 'Size']];
  const headBtns = columns.map(([key, label]) => {
    const b = h('button', { type: 'button', class: `pick-col pick-col-${key}`, 'data-key': key }, label, h('span', { class: 'pick-sort', 'aria-hidden': 'true' }));
    on(b, 'click', () => {
      if (sortKey === key) sortDir = -sortDir;
      else {
        sortKey = key;
        sortDir = 1;
      }
      renderList();
    }, signal);
    return b;
  });
  head.append(...headBtns);
  const list = h('div', { class: 'pick-list', role: 'listbox', 'aria-label': 'Files and folders', tabindex: '0' });
  const files = h('div', { class: 'pick-files' }, head, list);
  const preview = h('div', { class: 'pick-preview', role: 'region', 'aria-label': 'Preview', 'aria-live': 'polite' });
  const main = h('div', { class: 'pick-main' }, side, files, preview);

  const nameInput = save ? h('input', { type: 'text', class: 'field pick-name-box', id: `pick-name-${uid}`, value: save.name, 'aria-label': 'File name', spellcheck: false, autocomplete: 'off' }) : null;
  const typeSelect = folderOnly ? null : h('select', { class: 'field pick-type-box', id: `pick-type-${uid}`, 'aria-label': save ? 'Save as type' : 'Files of type' },
    ...types.map((t, i) => h('option', { value: String(i) }, t.label)));
  if (typeSelect) typeSelect.value = String(typeIndex);
  const foot = folderOnly ? null : h('div', { class: 'pick-foot' },
    nameInput ? h('label', { class: 'pick-foot-label', for: nameInput.id }, 'File name') : null, nameInput,
    h('label', { class: 'pick-foot-label', for: typeSelect!.id }, save ? 'Save as type' : 'Files of type'), typeSelect);
  const problem = h('p', { class: 'dialog-problem', role: 'alert' });

  const body = h('div', { class: `pick${mem.preview ? ' with-preview' : ''}` },
    h('div', { class: 'pick-bar' }, backBtn, forwardBtn, upBtn, crumbs, search),
    h('div', { class: 'pick-bar pick-tools' }, foldersBtn, newFolderBtn, renameBtn, refreshBtn, h('span', { class: 'pick-gap' }), detailsBtn, tilesBtn, previewBtn),
    main, foot, problem);

  const okBtn = () => body.closest('.dialog')?.querySelector<HTMLButtonElement>('.btn.primary');
  const changed = () => list.dispatchEvent(new Event('change', { bubbles: true }));
  const showProblem = (error: unknown) => { problem.textContent = error instanceof Error ? describeError(error) : String(error); };

  // ---- Loading ----
  async function loadKids(path: string, fresh = false): Promise<string[]> {
    const known = kids.get(path);
    if (known && !fresh) return known;
    try {
      const names = (await shell.fs.list(path)).filter(e => e.kind === 'folder').map(e => e.name).sort(byName);
      kids.set(path, names);
      return names;
    } catch {
      kids.set(path, []);
      return [];
    }
  }

  /** Opens a folder. `record` puts the folder being left on the Back list. Resolves false when it cannot be opened. */
  async function go(path: string, record = true, select: string | null = null): Promise<boolean> {
    const seq = ++goSeq;
    let listed: Entry[];
    try {
      listed = await shell.fs.list(path);
    } catch (error) {
      if (seq === goSeq) problem.textContent = error instanceof Error ? error.message : 'That folder cannot be opened.';
      return false;
    }
    if (seq !== goSeq) return false;
    if (record && path !== folder) {
      back.push(folder);
      forward.length = 0;
    }
    if (path !== folder) search.value = '';
    folder = path;
    entries = listed;
    problem.textContent = '';
    kids.set(path, listed.filter(e => e.kind === 'folder').map(e => e.name).sort(byName));
    const parts = splitPath(path);
    for (let i = 0; i < parts.length; i++) {
      const ancestor = joinPath(...parts.slice(0, i));
      expanded.add(ancestor);
      await loadKids(ancestor);
    }
    // The folder being shown is open in the tree too, so a folder just made in it shows there at once.
    expanded.add(path);
    if (seq !== goSeq) return false;
    selected = select !== null && listed.some(e => e.name === select) ? select : null;
    renderAll();
    return true;
  }

  // ---- Drawing ----
  function renderAll() {
    renderTree();
    renderRecent();
    renderCrumbs();
    renderList();
    backBtn.disabled = back.length === 0;
    forwardBtn.disabled = forward.length === 0;
    upBtn.disabled = folder === '/';
  }

  function visibleNodes(): Array<{ path: string; name: string; depth: number }> {
    const out = [{ path: '/', name: ROOT_NAME, depth: 0 }];
    const walk = (path: string, depth: number) => {
      for (const name of kids.get(path) ?? []) {
        const p = joinPath(path, name);
        out.push({ path: p, name, depth });
        if (expanded.has(p)) walk(p, depth + 1);
      }
    };
    if (expanded.has('/')) walk('/', 1);
    return out;
  }

  function renderTree() {
    nodeByPath.clear();
    let current = '';
    tree.replaceChildren(...visibleNodes().map(({ path, name, depth }, i) => {
      const known = kids.get(path);
      const leaf = known !== undefined && known.length === 0;
      const isOpen = expanded.has(path) && !leaf;
      const twisty = h('span', { class: 'pick-twisty', 'aria-hidden': 'true' }, leaf ? '' : isOpen ? '▾' : '▸');
      const id = `pick-node-${uid}-${i}`;
      const row = h('div', {
        class: 'pick-node', role: 'treeitem', id, 'data-path': path, 'aria-level': depth + 1, 'aria-selected': String(path === folder),
        ...(leaf ? {} : { 'aria-expanded': String(isOpen) }), title: path === '/' ? ROOT_NAME : path,
      }, twisty, icon(folderIcon(path), 16), h('span', { class: 'pick-node-name' }, name));
      css(row, { 'padding-left': 4 + depth * 14 });
      if (path === folder) current = id;
      on(twisty, 'click', event => {
        event.stopPropagation();
        void toggle(path);
      }, signal);
      on(row, 'click', () => {
        if (editing) return;
        lastPane = 'tree';
        if (path !== folder) void go(path);
      }, signal);
      on(row, 'dblclick', () => void toggle(path), signal);
      nodeByPath.set(path, row);
      return row;
    }));
    if (current) tree.setAttribute('aria-activedescendant', current);
    nodeByPath.get(folder)?.scrollIntoView({ block: 'nearest' });
  }

  async function toggle(path: string, open?: boolean) {
    const want = open ?? !expanded.has(path);
    if (want) {
      expanded.add(path);
      await loadKids(path);
    } else expanded.delete(path);
    renderTree();
  }

  function renderRecent() {
    recentBox.hidden = mem.recent.length === 0;
    recentList.replaceChildren(...mem.recent.map(path => {
      const b = h('button', { type: 'button', class: `pick-recent-item${path === folder ? ' current' : ''}`, title: path === '/' ? ROOT_NAME : path, role: 'listitem' },
        icon(folderIcon(path), 16), h('span', { class: 'pick-node-name' }, path === '/' ? ROOT_NAME : baseName(path)));
      on(b, 'click', () => void go(path), signal);
      return b;
    }));
  }

  function renderCrumbs() {
    const parts = splitPath(folder);
    const items: Array<[string, string]> = [['/', ROOT_NAME], ...parts.map((p, i): [string, string] => [joinPath(...parts.slice(0, i + 1)), p])];
    crumbs.replaceChildren(...items.flatMap(([path, label], i) => {
      const b = h('button', { type: 'button', class: 'crumb', title: label, ...(path === folder ? { 'aria-current': 'location' } : {}) }, label);
      on(b, 'click', () => void go(path), signal);
      return i === 0 ? [b] : [h('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '›'), b];
    }));
    crumbs.scrollLeft = crumbs.scrollWidth;
  }

  function compare(a: Entry, b: Entry): number {
    const folders = Number(b.kind === 'folder') - Number(a.kind === 'folder');
    if (folders) return folders;
    let c = 0;
    if (sortKey === 'modified') c = a.modified - b.modified;
    else if (sortKey === 'size') c = a.size - b.size;
    else if (sortKey === 'type') c = fileTypeOf(a.name, a.kind).label.localeCompare(fileTypeOf(b.name, b.kind).label);
    return sortDir * (c || byName(a.name, b.name));
  }

  function renderList() {
    observer?.disconnect();
    observer = null;
    rowByName.clear();
    const choice = types[typeIndex] ?? types[0];
    const query = nameKey(search.value.trim());
    shown = entries
      .filter(e => e.kind === 'folder' || (!folderOnly && allows(choice, e.name)))
      .filter(e => !query || nameKey(e.name).includes(query))
      .sort(compare);
    if (selected !== null && !shown.some(e => e.name === selected)) selected = null;
    const view = mem.view;
    list.className = `pick-list ${view}`;
    head.hidden = view !== 'details';
    for (const b of headBtns) {
      const active = b.dataset.key === sortKey;
      b.setAttribute('aria-sort', active ? (sortDir > 0 ? 'ascending' : 'descending') : 'none');
      b.querySelector('.pick-sort')!.textContent = active ? (sortDir > 0 ? '▲' : '▼') : '';
    }
    detailsBtn.setAttribute('aria-pressed', String(view === 'details'));
    tilesBtn.setAttribute('aria-pressed', String(view === 'tiles'));
    previewBtn.setAttribute('aria-pressed', String(mem.preview));
    if (view === 'tiles' && typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver(seen => {
        for (const s of seen) {
          if (!s.isIntersecting) continue;
          observer?.unobserve(s.target);
          const pic = s.target as HTMLElement;
          const e = shown.find(x => x.name === pic.dataset.name);
          if (e) void thumbFor(e).then(url => { if (url && pic.isConnected) setPicture(pic, url); });
        }
      }, { root: list, rootMargin: '64px' });
    }
    list.replaceChildren(...shown.map(e => {
      const path = joinPath(folder, e.name);
      const type = fileTypeOf(e.name, e.kind).label;
      const nameSpan = h('span', { class: 'pick-name' }, e.name);
      let row: HTMLElement;
      if (view === 'details') {
        row = h('div', { class: 'pick-row', role: 'option', 'aria-selected': String(e.name === selected), tabindex: '-1', 'data-path': path, title: e.name },
          h('span', { class: 'pick-cell-name' }, icon(iconFor(e, folder), 20), nameSpan),
          h('span', { class: 'pick-date' }, e.modified ? formatDate(e.modified) : ''),
          h('span', { class: 'pick-type' }, type),
          h('span', { class: 'pick-size' }, e.kind === 'file' ? formatSize(e.size) : ''));
      } else {
        const pic = h('span', { class: 'pick-pic', 'data-name': e.name }, icon(iconFor(e, folder), 48));
        row = h('div', { class: 'pick-row', role: 'option', 'aria-selected': String(e.name === selected), tabindex: '-1', 'data-path': path, title: e.name },
          pic, h('span', { class: 'pick-tile-text' }, nameSpan, h('span', { class: 'pick-sub' }, e.kind === 'file' ? `${type}, ${formatSize(e.size)}` : type)));
        if (canThumb(e)) observer?.observe(pic);
      }
      on(row, 'click', () => {
        if (editing) return;
        lastPane = 'list';
        choose(e.name);
      }, signal);
      on(row, 'dblclick', () => {
        if (!editing) activate(e);
      }, signal);
      rowByName.set(e.name, row);
      return row;
    }));
    if (!shown.length) {
      const text = query ? `Nothing here matches “${search.value.trim()}”.`
        : folderOnly ? 'No folders here.'
        : entries.length ? 'Nothing here of the right kind.' : 'This folder is empty.';
      list.append(h('p', { class: 'pick-empty' }, text));
    }
    chosen = !save && !folderOnly && selected !== null && shown.find(e => e.name === selected)?.kind === 'file' ? joinPath(folder, selected) : null;
    renameBtn.disabled = selected === null && folder === '/';
    void showPreview();
    changed();
  }

  function setPicture(pic: HTMLElement, url: string) {
    const img = h('img', { class: 'pick-thumb', src: url, alt: '', decoding: 'async' });
    on(img, 'error', () => img.remove(), signal);
    pic.replaceChildren(img);
  }

  function thumbFor(e: Entry): Promise<string | null> {
    const path = joinPath(folder, e.name);
    const key = `${path}\n${e.modified}\n${e.size}`;
    let p = thumbs.get(key);
    if (!p) {
      const type = mediaTypeOf(e.name)!;
      p = shell.fs.readFile(path).then(bytes => {
        if (signal.aborted) return null;
        const url = blobUrl(bytes, type);
        urls.push(url);
        return url;
      }).catch(() => null);
      thumbs.set(key, p);
    }
    return p;
  }

  async function showPreview() {
    body.classList.toggle('with-preview', mem.preview);
    if (!mem.preview) return;
    const seq = ++previewSeq;
    const e = selected === null ? null : shown.find(x => x.name === selected) ?? null;
    const line = (text: string) => h('div', { class: 'pick-pv-line' }, text);
    if (!e) {
      const count = shown.length;
      preview.replaceChildren(h('div', { class: 'pick-pv-pic' }, icon(folderIcon(folder), 48)),
        h('div', { class: 'pick-pv-name' }, folder === '/' ? ROOT_NAME : baseName(folder)),
        line(plural(count, 'item')), line(folderOnly ? 'Choose a folder on the left or open one here.' : 'Choose a file to see it here.'));
      return;
    }
    const pic = h('div', { class: 'pick-pv-pic' }, icon(iconFor(e, folder), 48));
    preview.replaceChildren(pic, h('div', { class: 'pick-pv-name' }, e.name), line(fileTypeOf(e.name, e.kind).label));
    if (e.kind === 'file') preview.append(line(formatSize(e.size)));
    if (e.modified) preview.append(line(`Modified ${formatDate(e.modified)}`));
    if (canThumb(e)) {
      const url = await thumbFor(e);
      if (url && seq === previewSeq) {
        const img = h('img', { class: 'pick-pv-img', src: url, alt: `Preview of ${e.name}`, decoding: 'async' });
        on(img, 'error', () => img.remove(), signal);
        pic.replaceChildren(img);
      }
    } else if (isTextKind(e) && e.size <= TEXT_MAX) {
      try {
        const bytes = await shell.fs.readFile(joinPath(folder, e.name));
        if (seq !== previewSeq) return;
        const text = new TextDecoder('utf-8').decode(bytes.subarray(0, 4096)).split(/\r?\n/).slice(0, 16).join('\n');
        preview.append(h('pre', { class: 'pick-pv-text' }, text || '(empty)'));
      } catch {
        // No preview; the facts above still show.
      }
    }
  }

  // ---- Choosing ----
  function choose(name: string | null, focus = false) {
    selected = name;
    for (const [n, row] of rowByName) row.setAttribute('aria-selected', String(n === name));
    const e = name === null ? null : shown.find(x => x.name === name) ?? null;
    chosen = !save && !folderOnly && e?.kind === 'file' ? joinPath(folder, e.name) : null;
    if (nameInput && e?.kind === 'file') {
      nameInput.value = e.name;
      lastFileName = e.name;
    }
    renameBtn.disabled = name === null && folder === '/';
    if (focus && name !== null) {
      const row = rowByName.get(name);
      row?.focus();
      row?.scrollIntoView({ block: 'nearest' });
    }
    void showPreview();
    changed();
  }

  function activate(e: Entry) {
    if (e.kind === 'folder') {
      void go(joinPath(folder, e.name));
      return;
    }
    choose(e.name);
    okBtn()?.click();
  }

  // ---- Renaming and new folders ----
  /** Puts a box over a name; resolves the typed name, or null when left alone or cancelled. */
  function inlineEdit(span: HTMLElement, value: string, isFile: boolean): Promise<string | null> {
    return new Promise(resolve => {
      editing = true;
      const input = h('input', { type: 'text', class: 'field pick-edit', value, 'aria-label': 'New name', spellcheck: false, autocomplete: 'off' });
      span.hidden = true;
      span.after(input);
      let done = false;
      const finish = (answer: string | null) => {
        if (done) return;
        done = true;
        editing = false;
        input.remove();
        span.hidden = false;
        if (answer === null) problem.textContent = '';
        resolve(answer === value ? null : answer);
      };
      on(input, 'keydown', (event: KeyboardEvent) => {
        if (event.key === 'Tab') return;
        // Enter and Escape belong to this box, not to the dialog's Save and Cancel; arrows and Backspace edit the text.
        event.stopPropagation();
        if (event.key === 'Enter') {
          event.preventDefault();
          const reason = nameProblem(input.value);
          if (reason) problem.textContent = reason;
          else finish(input.value);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          problem.textContent = '';
          finish(null);
        }
      }, signal);
      on(input, 'input', () => { problem.textContent = nameProblem(input.value) ?? ''; }, signal);
      on(input, 'blur', () => finish(nameProblem(input.value) === null ? input.value : null), signal);
      for (const type of ['click', 'dblclick', 'pointerdown'] as const) on(input, type, (event: Event) => event.stopPropagation(), signal);
      input.focus();
      const dot = isFile ? value.lastIndexOf('.') : -1;
      input.setSelectionRange(0, dot > 0 ? dot : value.length);
    });
  }

  /** After a folder is renamed, every remembered path under it follows. */
  function follow(from: string, to: string) {
    const moved = (p: string) => (p === from || p.startsWith(`${from}/`) ? to + p.slice(from.length) : p);
    for (const stack of [back, forward]) stack.splice(0, stack.length, ...stack.map(moved));
    mem.recent = mem.recent.map(moved);
    expanded = new Set([...expanded].map(moved));
    kids = new Map([...kids].map(([k, v]) => [moved(k), v]));
    folder = moved(folder);
  }

  async function renameEntry(parent: string, oldName: string, newName: string, isFolder: boolean): Promise<boolean> {
    try {
      await shell.fs.rename(joinPath(parent, oldName), newName);
    } catch (error) {
      showProblem(error);
      return false;
    }
    if (isFolder) follow(joinPath(parent, oldName), joinPath(parent, newName));
    await loadKids(parent, true);
    return true;
  }

  async function renameInList(name: string) {
    const row = rowByName.get(name);
    const e = shown.find(x => x.name === name);
    const span = row?.querySelector<HTMLElement>('.pick-name');
    if (!row || !e || !span || editing) return;
    const typed = await inlineEdit(span, name, e.kind === 'file');
    if (typed !== null && await renameEntry(folder, name, typed, e.kind === 'folder')) {
      if (nameInput && nameInput.value === name) nameInput.value = typed;
      await go(folder, false, typed);
      if (nameInput && e.kind === 'file' && selected === typed) nameInput.value = typed;
    }
    const after = rowByName.get(typed ?? name);
    if (after) after.focus();
    else list.focus();
  }

  async function renameInTree(path: string) {
    const row = nodeByPath.get(path);
    const span = row?.querySelector<HTMLElement>('.pick-node-name');
    if (path === '/' || !row || !span || editing) return;
    const parent = parentPath(path);
    const typed = await inlineEdit(span, baseName(path), false);
    if (typed !== null && await renameEntry(parent, baseName(path), typed, true)) {
      await go(folder, false, parent === folder ? typed : selected);
    }
    tree.focus();
  }

  async function newFolder() {
    if (editing) return;
    const pane = lastPane;
    const name = uniqueName('New folder', entries.map(e => e.name), true);
    try {
      await shell.fs.mkdir(joinPath(folder, name));
    } catch (error) {
      showProblem(error);
      return;
    }
    search.value = '';
    if (!await go(folder, false, name)) return;
    if (pane === 'tree') {
      await toggle(folder, true);
      await renameInTree(joinPath(folder, name));
    } else {
      choose(name, true);
      await renameInList(name);
    }
  }

  function rename() {
    if (selected !== null && (lastPane === 'list' || folder === '/')) void renameInList(selected);
    else if (folder !== '/') void renameInTree(folder);
  }

  // ---- Wiring ----
  on(backBtn, 'click', async () => {
    const to = back.pop();
    if (to === undefined) return;
    const from = folder;
    if (await go(to, false)) forward.push(from);
    else back.push(to);
    backBtn.disabled = back.length === 0;
    forwardBtn.disabled = forward.length === 0;
  }, signal);
  on(forwardBtn, 'click', async () => {
    const to = forward.pop();
    if (to === undefined) return;
    const from = folder;
    if (await go(to, false)) back.push(from);
    else forward.push(to);
    backBtn.disabled = back.length === 0;
    forwardBtn.disabled = forward.length === 0;
  }, signal);
  on(upBtn, 'click', () => void go(parentPath(folder), true, baseName(folder)), signal);
  on(newFolderBtn, 'click', () => void newFolder(), signal);
  on(renameBtn, 'click', rename, signal);
  on(refreshBtn, 'click', async () => {
    kids.clear();
    thumbs.clear();
    await go(folder, false, selected);
  }, signal);
  on(detailsBtn, 'click', () => { mem.view = 'details'; renderList(); }, signal);
  on(tilesBtn, 'click', () => { mem.view = 'tiles'; renderList(); }, signal);
  on(previewBtn, 'click', () => {
    mem.preview = !mem.preview;
    previewBtn.setAttribute('aria-pressed', String(mem.preview));
    void showPreview();
  }, signal);
  foldersBtn.setAttribute('aria-pressed', 'false');
  on(foldersBtn, 'click', () => {
    const open = body.classList.toggle('side-open');
    foldersBtn.setAttribute('aria-pressed', String(open));
  }, signal);

  on(search, 'input', () => renderList(), signal);
  on(search, 'keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter') {
      // Enter here finds; it never presses Save or Open.
      event.preventDefault();
      event.stopPropagation();
      if (shown.length) choose(shown[0].name, true);
    } else if (event.key === 'Escape' && search.value !== '') {
      event.preventDefault();
      event.stopPropagation();
      search.value = '';
      renderList();
    }
  }, signal);

  if (typeSelect) on(typeSelect, 'change', () => {
    const before = typeIndex;
    typeIndex = Number(typeSelect.value) || 0;
    if (nameInput && before !== typeIndex) {
      nameInput.value = swapExtension(nameInput.value, types, types[typeIndex]);
      lastFileName = nameInput.value;
    }
    renderList();
  }, signal);

  if (nameInput) on(nameInput, 'keydown', (event: KeyboardEvent) => {
    if (event.key !== 'Enter') return;
    // A folder's name typed in the box opens that folder, as in other desktops.
    const typed = nameKey(nameInput.value.trim());
    const hit = entries.find(e => e.kind === 'folder' && nameKey(e.name) === typed);
    if (!hit) return;
    event.preventDefault();
    event.stopPropagation();
    nameInput.value = lastFileName;
    void go(joinPath(folder, hit.name));
  }, signal);

  on(list, 'focusin', () => { lastPane = 'list'; }, signal);
  on(tree, 'focusin', () => { lastPane = 'tree'; }, signal);
  on(list, 'click', event => {
    if (event.target === list && !editing) choose(null);
  }, signal);

  on(list, 'keydown', (event: KeyboardEvent) => {
    if (event.target instanceof HTMLInputElement || editing) return;
    const index = selected === null ? -1 : shown.findIndex(e => e.name === selected);
    const last = shown.length - 1;
    const rows = [...rowByName.values()];
    const perLine = mem.view === 'tiles' && rows.length ? Math.max(1, rows.filter(r => r.offsetTop === rows[0].offsetTop).length) : 1;
    let next: number | null = null;
    switch (event.key) {
      case 'ArrowDown': next = index < 0 ? 0 : index + perLine; break;
      case 'ArrowUp': next = index < 0 ? last : index - perLine; break;
      case 'ArrowRight': if (mem.view === 'tiles') next = index < 0 ? 0 : index + 1; break;
      case 'ArrowLeft': if (mem.view === 'tiles') next = index < 0 ? 0 : index - 1; break;
      case 'Home': next = 0; break;
      case 'End': next = last; break;
      case 'Enter':
        if (index >= 0) {
          event.preventDefault();
          event.stopPropagation();
          activate(shown[index]);
        }
        return;
      case 'Backspace':
        event.preventDefault();
        if (folder !== '/') upBtn.click();
        return;
      case 'F2':
        event.preventDefault();
        if (selected !== null) void renameInList(selected);
        return;
      default:
        return;
    }
    if (!shown.length || next === null) return;
    event.preventDefault();
    choose(shown[Math.max(0, Math.min(last, next))].name, true);
  }, signal);

  on(tree, 'keydown', (event: KeyboardEvent) => {
    if (event.target instanceof HTMLInputElement || editing) return;
    const nodes = visibleNodes();
    const i = nodes.findIndex(n => n.path === folder);
    const goTo = (n: number) => {
      const target = nodes[Math.max(0, Math.min(nodes.length - 1, n))];
      if (target && target.path !== folder) void go(target.path);
    };
    switch (event.key) {
      case 'ArrowDown': goTo(i + 1); break;
      case 'ArrowUp': goTo(i - 1); break;
      case 'Home': goTo(0); break;
      case 'End': goTo(nodes.length - 1); break;
      case 'ArrowRight':
        if (!expanded.has(folder) || (kids.get(folder)?.length ?? 1) === 0) void toggle(folder, true);
        else goTo(i + 1);
        break;
      case 'ArrowLeft':
        if (expanded.has(folder) && folder !== '/' && (kids.get(folder)?.length ?? 0) > 0) void toggle(folder, false);
        else if (folder !== '/') void go(parentPath(folder));
        break;
      case 'Backspace': if (folder !== '/') void go(parentPath(folder)); break;
      case 'F2': void renameInTree(folder); break;
      case 'Enter': break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
  }, signal);

  return (async () => {
    folder = await firstFolder(shell, [options.folder ?? '/Documents', '/Documents', '/']);
    if (!await go(folder, false)) renderAll();
    const answer = await shell.dialogs.ask<string>({
      title: options.title,
      body,
      buttons: [
        { label: options.ok ?? (save ? 'Save' : folderOnly ? 'Choose this folder' : 'Open'), value: 'ok', primary: true },
        { label: 'Cancel', value: 'cancel' },
      ],
      cancel: 'cancel',
      primaryEnabled: () => (folderOnly ? true : save ? nameProblem(nameInput!.value) === null : chosen !== null),
      focus: () => {
        if (!nameInput) return list;
        const dot = nameInput.value.lastIndexOf('.');
        // The box is focused after this returns; the selection is kept.
        queueMicrotask(() => nameInput.setSelectionRange(0, dot > 0 ? dot : nameInput.value.length));
        return nameInput;
      },
    });
    abort.abort();
    (observer as IntersectionObserver | null)?.disconnect();
    for (const url of urls) URL.revokeObjectURL(url);
    if (answer !== 'ok') return null;
    remember(mem, folder);
    if (folderOnly) return folder;
    if (!save) return chosen;
    const typed = nameInput!.value;
    const final = finalSaveName(typed, types, typeIndex);
    return joinPath(folder, nameProblem(final.name) === null ? final.name : typed);
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
 * path and whether it already existed, or null when cancelled. The name carries the chosen type's ending.
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

/** The file-type drop-down for a PDF. */
export const PDF_TYPES: FileTypeChoice[] = [{ label: 'PDF document', ext: ['pdf'] }];

/**
 * Save PDF as...: asks where and under what name (starting in `folder`, with a name not yet taken there), then makes
 * the PDF and writes it. The toast says which folder it went in. Returns false when cancelled.
 */
export async function savePdfAs(shell: Shell, options: { title?: string; folder: string; name: string }, make: () => Promise<Uint8Array> | Uint8Array): Promise<boolean> {
  let taken: string[] = [];
  try {
    taken = (await shell.fs.list(options.folder, true)).map(e => e.name);
  } catch {
    // The window starts somewhere else if the folder is gone.
  }
  const chosen = await pickSave(shell, { title: options.title ?? 'Save PDF as', folder: options.folder, name: uniqueName(options.name, taken), ok: 'Save', types: PDF_TYPES });
  if (!chosen) return false;
  const bytes = await make();
  const entry = await shell.fs.writeFile(chosen.path, bytes, chosen.replace ? {} : { mustBeNew: true });
  const where = parentPath(chosen.path);
  shell.toast(`Saved “${entry.name}” in ${where === '/' ? 'the top folder' : where}.`, { label: 'Open', run: () => void shell.openPath(chosen.path) });
  return true;
}
