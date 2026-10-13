// TOMLIN Sheets, the page side: one workbook per window, as desktop spreadsheets work. It gives the spreadsheet what
// the desktop would (dialogs, menus, toasts, files) from this computer instead: real files through Windows' own Open
// and Save boxes, a recent files list, a window title, "save changes?" on closing, files dropped on the window, and
// updates checked against the published list.
import { sheetApp } from '../../src/apps/sheet.ts';
import { h, on } from '../../src/core/dom.ts';
import { FsError } from '../../src/fs/errors.ts';
import { DialogLayer } from '../../src/shell/dialogs.ts';
import { MenuLayer, type MenuItem } from '../../src/shell/menu.ts';
import type { NativeHost } from '../../src/shell/native.ts';
import type { AppHandle, Shell } from '../../src/shell/types.ts';
import { fromWindows, NativeFiles, toWindows } from './files.ts';
import { tauri, invoke, type FileFilter } from './tauri.ts';
import { checkForUpdates, startupUpdateCheck } from './updates.ts';
import { PRODUCT, showAbout } from './about.ts';
import { readList, readValue, writeList, writeValue } from './prefs.ts';
import { ribbonArrows } from './ribbon.ts';

const OPENABLE = /\.(xlsx|xlsm|xls|sheet|csv|tsv|txt)$/i;
const RECENT_MAX = 10;

const appEl = h('div', { id: 'app' });
const menusEl = h('div', { id: 'layer-menus' });
const modalEl = h('div', { id: 'layer-modal' });
const toastsEl = h('div', { id: 'layer-toasts', role: 'status', 'aria-live': 'polite' });
document.getElementById('root')!.replaceChildren(appEl, menusEl, modalEl, toastsEl);

/** Lives as long as the window: every listener below uses it. */
const life = new AbortController();
const dialogs = new DialogLayer(modalEl);
const menus = new MenuLayer(menusEl);
const files = new NativeFiles();
const win = tauri?.window.appWindow ?? null;
const isMain = !win || win.label === 'main';
const params = new URLSearchParams(location.search);

// ---- State of this window ------------------------------------------------------------------------------------------

/** The file this window holds (desktop-form path), or null for a new workbook. */
let currentPath: string | null = params.get('file');
let dirty = false;
/** Changed at any time since the window opened: such a window is not replaced by a file being opened. */
let touched = false;
let title = '';
const closeGuards: Array<() => boolean | Promise<boolean>> = [];

if (isMain) writeValue('book', 1);
const bookNumber = Number(params.get('n')) || 1;

// ---- Small helpers -------------------------------------------------------------------------------------------------

function toast(message: string, action?: { label: string; run: () => void }): void {
  const el = h('div', { class: 'toast' }, h('span', {}, message));
  if (action) {
    const button = h('button', { type: 'button', class: 'toast-action' }, action.label);
    on(button, 'click', () => {
      el.remove();
      action.run();
    }, life.signal);
    el.append(button);
  }
  toastsEl.append(el);
  while (toastsEl.children.length > 3) toastsEl.firstElementChild?.remove();
  window.setTimeout(() => el.remove(), action ? 12000 : 5000);
}

async function report(heading: string, error: unknown): Promise<void> {
  const text = error instanceof FsError
    ? error.message
    : `Something unexpected went wrong inside ${PRODUCT}. Your file was not changed by it. Try again; if it keeps happening, save your work under a new name and restart the program.`;
  if (!(error instanceof FsError)) console.error(error);
  await dialogs.alert(heading, text);
}

function folderOf(path: string): string {
  return path.split('/').slice(0, -1).join('/');
}

function lastFolder(): string | null {
  return readValue<string>('folder');
}

function rememberFolder(path: string): void {
  writeValue('folder', folderOf(path));
}

function remember(path: string): void {
  currentPath = path;
  rememberFolder(path);
  const list = readList('recent').filter(p => p.toLowerCase() !== path.toLowerCase());
  writeList('recent', [path, ...list].slice(0, RECENT_MAX));
}

async function setWindowTitle(label: string): Promise<void> {
  if (label === title) return;
  title = label;
  document.title = `${label} - ${PRODUCT}`;
  await win?.setTitle(document.title);
}

// ---- Windows: new, open, focus one that already has the file -------------------------------------------------------

function newWindow(query: Record<string, string>): void {
  if (!tauri) {
    location.href = `index.html?${new URLSearchParams(query)}`;
    return;
  }
  const label = `book-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  void new tauri.window.WebviewWindow(label, {
    url: `index.html?${new URLSearchParams(query)}`,
    title: PRODUCT,
    width: 1180,
    height: 760,
    minWidth: 640,
    minHeight: 420,
    visible: false,
    fileDropEnabled: true,
  });
}

function newWorkbook(): void {
  const n = (readValue<number>('book') ?? 1) + 1;
  writeValue('book', n);
  newWindow({ n: String(n) });
}

/** Asks every window whether it holds `path`; the one that does comes to the front. */
async function focusIfOpen(path: string): Promise<boolean> {
  if (!tauri) return false;
  const nonce = crypto.randomUUID();
  let found = false;
  const stop = await tauri.event.listen<{ nonce: string }>('sheets-has-file', e => {
    if (e.payload.nonce === nonce) found = true;
  });
  await tauri.event.emit('sheets-who-has', { path, nonce });
  await new Promise(r => setTimeout(r, 250));
  stop();
  return found;
}

/** Opens a file the way a desktop spreadsheet does: an untouched new workbook gives way to it; otherwise a new window. */
async function openPath(path: string): Promise<void> {
  if (!OPENABLE.test(path)) {
    await dialogs.alert('That kind of file cannot be opened here', `${PRODUCT} opens Excel workbooks (.xlsx, .xlsm), its own .sheet files and text files (.csv, .tsv, .txt).`);
    return;
  }
  if (currentPath && currentPath.toLowerCase() === path.toLowerCase()) {
    await win?.setFocus();
    return;
  }
  if (await focusIfOpen(path)) return;
  rememberFolder(path);
  if (!currentPath && !touched) location.replace(`index.html?${new URLSearchParams({ file: path, n: String(bookNumber) })}`);
  else newWindow({ file: path });
}

if (tauri) {
  void tauri.event.listen<{ path: string; nonce: string }>('sheets-who-has', e => {
    if (currentPath && currentPath.toLowerCase() === e.payload.path.toLowerCase()) {
      void tauri!.event.emit('sheets-has-file', { nonce: e.payload.nonce });
      void win?.unminimize().then(() => win?.setFocus());
    }
  });
  void tauri.event.listen<{ nonce: string }>('sheets-who-is-dirty', e => {
    if (dirty) void tauri!.event.emit('sheets-dirty', { nonce: e.payload.nonce, name: title });
  });
}

/** The names of other windows with unsaved changes (before an update closes the program). */
async function otherUnsaved(): Promise<string[]> {
  if (!tauri) return [];
  const nonce = crypto.randomUUID();
  const names: string[] = [];
  const stop = await tauri.event.listen<{ nonce: string; name: string }>('sheets-dirty', e => {
    if (e.payload.nonce === nonce) names.push(e.payload.name);
  });
  await tauri.event.emit('sheets-who-is-dirty', { nonce });
  await new Promise(r => setTimeout(r, 300));
  stop();
  return names.filter(n => n !== title || !dirty);
}

// ---- Open and Save boxes -------------------------------------------------------------------------------------------

const KINDS: Record<string, FileFilter> = {
  all: { name: 'All spreadsheets', extensions: ['xlsx', 'xlsm', 'sheet', 'csv', 'tsv', 'txt'] },
  xlsx: { name: 'Excel Workbook', extensions: ['xlsx'] },
  xlsm: { name: 'Excel Macro-Enabled Workbook (opened without its macros)', extensions: ['xlsm'] },
  sheet: { name: `${PRODUCT} Workbook`, extensions: ['sheet'] },
  csv: { name: 'CSV (comma separated)', extensions: ['csv'] },
  text: { name: 'Text (tab separated)', extensions: ['tsv', 'txt'] },
  pdf: { name: 'PDF', extensions: ['pdf'] },
};

function startAt(name: string): string | undefined {
  if (name.includes('/')) return toWindows(name);
  const folder = lastFolder();
  return folder ? `${toWindows(folder)}\\${name}` : name;
}

async function pickOpen(): Promise<string | null> {
  if (!tauri) return null;
  const folder = lastFolder();
  const chosen = await tauri.dialog.open({ title: 'Open', multiple: false, defaultPath: folder ? toWindows(folder) : undefined, filters: [KINDS.all, KINDS.xlsx, KINDS.xlsm, KINDS.sheet, KINDS.csv, KINDS.text] });
  if (typeof chosen !== 'string') return null;
  return fromWindows(chosen);
}

async function pickSave(suggested: string, kind: 'xlsx' | 'sheet'): Promise<string | null> {
  if (!tauri) return null;
  const filters = kind === 'xlsx' ? [KINDS.xlsx, KINDS.sheet] : [KINDS.sheet, KINDS.xlsx];
  const chosen = await tauri.dialog.save({ title: 'Save as', defaultPath: startAt(suggested), filters });
  if (!chosen) return null;
  // Typed without an ending: the kind being saved.
  const withEnding = /\.(xlsx|sheet)$/i.test(chosen) ? chosen : `${chosen}.${kind}`;
  return fromWindows(withEnding);
}

/** Export (CSV, PDF, a copy as .xlsx): a Save box for the named file, then written. */
async function exportFile(name: string, bytes: Uint8Array): Promise<void> {
  if (!tauri) return;
  const ext = (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? '').toLowerCase();
  const filter = ext === 'csv' ? KINDS.csv : ext === 'pdf' ? KINDS.pdf : ext === 'xlsx' ? KINDS.xlsx : { name: `${ext.toUpperCase()} file`, extensions: [ext] };
  const chosen = await tauri.dialog.save({ title: 'Export', defaultPath: startAt(name), filters: [filter] });
  if (!chosen) return;
  const path = fromWindows(ext && !chosen.toLowerCase().endsWith(`.${ext}`) ? `${chosen}.${ext}` : chosen);
  try {
    const entry = await files.writeFile(path, bytes);
    rememberFolder(path);
    toast(`Exported “${entry.name}”.`);
  } catch (error) {
    await report('Could not export', error);
  }
}

// ---- The File menu's own entries -----------------------------------------------------------------------------------

function recentMenu(): MenuItem {
  const list = readList('recent');
  return {
    label: 'Open recent',
    disabled: !list.length,
    submenu: list.length
      ? [
          ...list.map((p, i) => ({ label: `${i + 1}  ${p.split('/').pop()}`, hint: shortFolder(p), action: () => void openRecent(p) })),
          { separator: true },
          { label: 'Clear the list', action: () => writeList('recent', []) },
        ]
      : [{ label: 'No recent files', disabled: true }],
  };
}

function shortFolder(path: string): string {
  const folder = toWindows(folderOf(path));
  return folder.length > 42 ? `…${folder.slice(-41)}` : folder;
}

async function openRecent(path: string): Promise<void> {
  if (!(await files.exists(path))) {
    writeList('recent', readList('recent').filter(p => p !== path));
    await dialogs.alert('That file is not there any more', `“${path.split('/').pop()}” may have been moved, renamed or deleted, or its drive may be unplugged. It has been taken off the recent list.`);
    return;
  }
  await openPath(path);
}

async function exit(): Promise<void> {
  if (await runGuards()) await tauri?.process.exit(0);
}

const native: NativeHost = {
  product: PRODUCT,
  untitled: `Book${bookNumber}`,
  pickOpen,
  pickSave,
  newWindow: newWorkbook,
  remember,
  fileMenu: () => ({
    top: [recentMenu()],
    bottom: [
      { separator: true },
      { label: 'Check for updates...', action: () => void checkForUpdates(updateContext) },
      { label: `About ${PRODUCT}`, action: () => void showAbout(dialogs) },
      { separator: true },
      { label: 'Close window', hint: 'Ctrl+W', action: () => void closeWindow() },
      { label: `Exit ${PRODUCT}`, action: () => void exit() },
    ],
  }),
};

const updateContext = { dialogs, toast, otherUnsaved, runGuards: () => runGuards() };

// ---- The window's life ---------------------------------------------------------------------------------------------

async function runGuards(): Promise<boolean> {
  for (const guard of closeGuards) if (!(await guard())) return false;
  return true;
}

async function closeWindow(): Promise<void> {
  if (await runGuards()) {
    closing = true;
    await saveWindowSize();
    await win?.close();
  }
}

let closing = false;
if (win) {
  void win.onCloseRequested(async event => {
    if (closing) return;
    // A question already on screen is answered first (the close is asked again afterwards).
    if (dialogs.isOpen) {
      event.preventDefault();
      return;
    }
    if (!(await runGuards())) {
      event.preventDefault();
      return;
    }
    closing = true;
    await saveWindowSize();
  });
  void win.listen<string[]>('tauri://file-drop', e => {
    for (const p of e.payload) void openPath(fromWindows(p));
  });
}

async function saveWindowSize(): Promise<void> {
  if (!win || !tauri) return;
  try {
    const maximized = await win.isMaximized();
    if (maximized) {
      writeValue('window', { ...(readValue<object>('window') ?? {}), maximized: true });
      return;
    }
    const size = await win.innerSize();
    const scale = await win.scaleFactor();
    writeValue('window', { maximized: false, width: Math.round(size.width / scale), height: Math.round(size.height / scale) });
  } catch {
    // The size is a convenience; the window still closes.
  }
}

async function restoreWindowSize(): Promise<void> {
  if (!win || !tauri || !isMain) return;
  const saved = readValue<{ maximized?: boolean; width?: number; height?: number }>('window');
  if (!saved) return;
  try {
    if (saved.width && saved.height && saved.width >= 640 && saved.height >= 420) {
      await win.setSize(new tauri.window.LogicalSize(Math.min(saved.width, screen.availWidth), Math.min(saved.height, screen.availHeight)));
    }
    if (saved.maximized) await win.maximize();
  } catch {
    // Opened at the standard size instead.
  }
}

// A program, not a page: the browser's own right-click menu only where text is typed, and no page zoom.
on(window, 'contextmenu', (event: MouseEvent) => {
  const t = event.target;
  const typing = t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && /^(text|search|number|email|url|tel|)$/.test(t.type)) || (t instanceof HTMLElement && t.isContentEditable);
  if (!typing) event.preventDefault();
}, life.signal, { capture: true });
on(window, 'keydown', (event: KeyboardEvent) => {
  const ctrl = event.ctrlKey || event.metaKey;
  if (ctrl && !event.shiftKey && event.key.toLowerCase() === 'w') {
    event.preventDefault();
    void closeWindow();
  } else if (event.key === 'F1') {
    event.preventDefault();
    void showAbout(dialogs);
  }
}, life.signal);
// Files dragged in from Explorer are handed over by the program (tauri://file-drop), not dropped into the page.
on(window, 'dragover', (event: DragEvent) => event.preventDefault(), life.signal);
on(window, 'drop', (event: DragEvent) => event.preventDefault(), life.signal);

// ---- Start ---------------------------------------------------------------------------------------------------------

const shell = {
  fs: files,
  menus,
  dialogs,
  toast,
  notify: (heading: string, text: string) => toast(text ? `${heading}: ${text}` : heading),
  report,
  openPath,
  transfers: { save: (name: string, bytes: Uint8Array) => void exportFile(name, bytes) },
  native,
  account: null,
} as unknown as Shell;

const handle: AppHandle = {
  id: crypto.randomUUID(),
  root: appEl,
  signal: life.signal,
  shell,
  setTitle: label => void setWindowTitle(label),
  setIcon: () => undefined,
  setWidth: () => undefined,
  close: () => void closeWindow(),
  setDirty: value => {
    dirty = value;
    if (value) touched = true;
  },
  onClose: guard => void closeGuards.push(guard),
  onReopen: () => undefined,
};

async function start(): Promise<void> {
  if (!currentPath && isMain && tauri) {
    const launched = await invoke<string | null>('launch_file').catch(() => null);
    if (launched) currentPath = fromWindows(launched);
  }
  await setWindowTitle(currentPath ? currentPath.split('/').pop()! : native.untitled);
  await restoreWindowSize();
  try {
    await sheetApp.launch(handle, currentPath ?? undefined);
    ribbonArrows(appEl, life.signal);
  } catch (error) {
    await report(`${PRODUCT} could not start`, error);
  }
  await win?.show();
  await win?.setFocus();
  if (isMain) startupUpdateCheck(updateContext);
}

void start();
