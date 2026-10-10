// The desktop itself: puts the parts together (files, session, Recycle Bin, windows, menus, dialogs, taskbar,
// Start menu, desktop icons, wallpaper) and runs apps. Nothing here ever erases files by itself.
import { APPS, LOADERS, type AppId } from '../apps/catalog.ts';
import { HIDDEN_APPS } from '../release.ts';
import { storeAppDef, type StoreApp } from '../apps/storeapp.ts';
import { ServiceApi } from '../net/service.ts';
import { startPrinterMessages } from '../apps/printer/entry.ts';
import { pictureTooBig } from '../core/imagesize.ts';
import { LockScreen } from '../auth/lock.ts';
import { Bus } from '../core/bus.ts';
import { css, h, on } from '../core/dom.ts';
import { FileSystem } from '../fs/fs.ts';
import type { Store } from '../store/store.ts';
import { FileActions } from './actions.ts';
import { DialogLayer, isLockRefusal } from './dialogs.ts';
import { createFolderView } from './foldview.ts';
import { fileTypeOf } from './filetypes.ts';
import { isAppShortcut, openShortcut } from './appshortcut.ts';
import { iconDefs } from './icons.ts';
import { readInstalled, writeInstalled } from './installed.ts';
import { bindDesktopKeys } from './keys.ts';
import { NoticeCentre } from './notices.ts';
import { startReminders } from './reminders.ts';
import { MenuLayer } from './menu.ts';
import { Session, type Theme, type Wallpaper } from './session.ts';
import { StartMenu } from './startmenu.ts';
import { buildTaskbar } from './taskbar.ts';
import { Transfers } from './transfer.ts';
import { purgeCutoff, RecycleBin, TRASH_DIR } from './trash.ts';
import type { Account, AppDef, AppHandle, Clipboard, Shell } from './types.ts';
import { WindowManager } from './windows.ts';
import { clearOldThreads } from '../apps/chat/agents.ts';

const PICTURE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
};
const MAX_WALLPAPER_BYTES = 25 * 1024 * 1024;

/** A catalog app as the shell runs it: its code loads the first time it opens (the window shows at once, then fills). */
function catalogApp(id: AppId): AppDef {
  const meta = APPS[id];
  return {
    ...meta,
    launch: async (handle, arg) => {
      const waiting = h('p', { class: 'app-message' }, 'Opening...');
      handle.root.append(waiting);
      let real: AppDef;
      try {
        real = await LOADERS[id]();
      } catch {
        waiting.textContent = `${meta.title} could not be loaded. Check the connection to the server, then open it again.`;
        return;
      }
      waiting.remove();
      if (!handle.signal.aborted) await real.launch(handle, arg);
    },
  };
}

class DesktopShell implements Shell {
  readonly fs: FileSystem;
  readonly storeLabel: string;
  readonly windows: WindowManager;
  readonly menus: MenuLayer;
  readonly dialogs: DialogLayer;
  readonly session: Session;
  readonly bin: RecycleBin;
  readonly actions: FileActions;
  readonly transfers: Transfers;
  readonly changes = new Bus<string[]>();
  readonly clipboardChanged = new Bus<void>();
  readonly lockChanged = new Bus<boolean>();
  account: Account | null = null;
  lock!: LockScreen;
  clipboard: Clipboard | null = null;
  notices: NoticeCentre | null = null;
  private registry = new Map<string, AppDef>();
  private toasts: HTMLElement;
  private wallpaperEl: HTMLElement;
  private wallpaperUrl: string | null = null;
  private wallpaperGeneration = 0;

  constructor(store: Store, layers: Layers) {
    this.fs = new FileSystem(store);
    this.storeLabel = store.label;
    this.session = new Session(this.fs);
    this.bin = new RecycleBin(this.fs);
    this.menus = new MenuLayer(layers.menus);
    this.dialogs = new DialogLayer(layers.modal);
    this.toasts = layers.toasts;
    this.wallpaperEl = layers.wallpaper;
    this.actions = new FileActions(this);
    this.transfers = new Transfers(this, layers.transfers);
    this.windows = new WindowManager(layers.windows, {
      savePrefs: (appId, prefs) => {
        this.session.data.windows[appId] = prefs;
        this.session.touch();
      },
      savedPrefs: appId => this.session.data.windows[appId],
      menu: (items, x, y, returnFocus) => this.menus.show(items, x, y, { returnFocus }),
      confirmDiscard: title =>
        this.dialogs.confirm({ title: 'Close without saving?', text: `“${title}” has changes that are not saved. If you close it they will be lost.`, ok: 'Close without saving', danger: true, cancel: 'Keep it open' }),
    });
    // A save the lock turned down is made again once the screen is unlocked.
    let saveWaiting = false;
    this.session.onSaveError = error => {
      if (isLockRefusal(error)) saveWaiting = true;
      else void this.report('Could not remember your desktop settings', error);
    };
    this.lockChanged.on(locked => {
      if (locked || !saveWaiting) return;
      saveWaiting = false;
      void this.session.flush();
    });
  }

  registerApp(app: AppDef): void {
    this.registry.set(app.id, app);
  }

  hasApp(id: string): boolean {
    return this.registry.has(id);
  }

  installedApps = new Set<string>();
  storeApps = new Map<string, StoreApp>();

  setStoreApps(apps: StoreApp[]): void {
    // A store app never takes a built-in app's name.
    this.storeApps = new Map(apps.filter(a => !(a.id in APPS)).map(a => [a.id, a]));
    for (const id of [...this.registry.keys()]) {
      if (!(id in APPS) && !(this.storeApps.has(id) && this.installedApps.has(id))) this.unregisterStoreApp(id);
    }
    for (const a of this.storeApps.values()) if (this.installedApps.has(a.id)) this.registerApp(storeAppDef(a));
  }

  private unregisterStoreApp(id: string): void {
    for (const win of this.windows.list().filter(w => w.appId === id)) void this.windows.close(win);
    this.registry.delete(id);
  }

  async setInstalled(id: string, on: boolean): Promise<void> {
    if ((on && !this.storeApps.has(id)) || this.installedApps.has(id) === on) return;
    // The list as kept now (another device may have changed it), read strictly: one that cannot be read is not replaced.
    const next = new Set(await readInstalled(this.fs, true));
    if (on) next.add(id);
    else next.delete(id);
    // Saved first: if the person's files cannot be written, nothing changes on screen either.
    await writeInstalled(this.fs, [...next]);
    this.installedApps = next;
    if (on) this.registerApp(storeAppDef(this.storeApps.get(id)!));
    else this.unregisterStoreApp(id);
  }

  apps(): AppDef[] {
    return [...this.registry.values()];
  }

  async openApp(id: string, arg?: string): Promise<void> {
    const app = this.registry.get(id);
    if (!app) {
      await this.dialogs.alert('That app is not installed', 'This desktop has no app by that name yet.');
      return;
    }
    const key = app.single ? id : `${id}:${arg ?? ''}`;
    const existing = this.windows.find(key);
    if (existing) {
      this.windows.focus(existing);
      // Focusing alone would drop where the caller asked to go ("Chat › Agents", "Settings › AI", a book).
      if (app.single && arg !== undefined) existing.reopen?.(arg);
      return;
    }
    const win = this.windows.create({ key, appId: id, title: app.title, icon: app.icon, size: app.size, minSize: app.minSize });
    const handle: AppHandle = {
      id: win.id,
      root: win.body,
      signal: win.abort.signal,
      shell: this,
      setTitle: t => {
        win.setTitle(t);
        this.windows.changed.emit();
      },
      setIcon: i => {
        win.setIcon(i);
        this.windows.changed.emit();
      },
      setWidth: w => this.windows.setWidth(win, w),
      close: () => void this.windows.close(win),
      setDirty: dirty => {
        win.dirty = dirty;
        this.windows.changed.emit();
      },
      onClose: guard => {
        win.guard = guard;
      },
      onReopen: listener => {
        win.reopen = listener;
      },
    };
    try {
      await app.launch(handle, arg);
    } catch (error) {
      win.dirty = false;
      win.guard = null;
      await this.windows.close(win);
      await this.report(`Could not open ${app.title}`, error);
    }
  }

  async openPath(path: string): Promise<void> {
    let entry;
    try {
      entry = await this.fs.stat(path);
    } catch (error) {
      await this.report('Could not open that', error);
      return;
    }
    if (!entry) {
      await this.dialogs.alert('Not there any more', 'This item may have been moved or deleted in another window.');
      return;
    }
    if (entry.kind === 'file' && isAppShortcut(entry.name)) {
      await openShortcut(this, path, entry.name);
      return;
    }
    const type = fileTypeOf(entry.name, entry.kind);
    const app = type.apps.find(id => this.registry.has(id));
    if (!app) {
      await this.dialogs.alert(
        `There is no app for “${entry.name}” yet`,
        `Nothing installed on this desktop can open a ${type.label.toLowerCase()} yet. The file is safe where it is.`,
      );
      return;
    }
    await this.openApp(app, path);
  }

  async applyBinPolicy(ask = false): Promise<boolean> {
    const { clear, days } = this.session.data.bin;
    const cutoff = purgeCutoff(clear, days);
    if (cutoff === null) return true;
    try {
      const due = (await this.bin.list()).filter(i => i.deleted < cutoff);
      if (!due.length) return true;
      if (ask) {
        const ok = await this.dialogs.confirm({
          title: 'Delete old items now?',
          text: `${due.length === 1 ? '1 item' : due.length + ' items'} in the Recycle Bin ${due.length === 1 ? 'is' : 'are'} older than this setting allows. Applying it deletes ${due.length === 1 ? 'it' : 'them'} for good.`,
          ok: 'Delete them',
          danger: true,
          cancel: 'Keep the old setting',
        });
        if (!ok) return false;
      }
      const gone = await this.bin.purgeBefore(cutoff);
      if (gone) this.toast(`The Recycle Bin cleared ${gone === 1 ? '1 old item' : gone + ' old items'}.`);
    } catch (error) {
      await this.report('Could not clear old items from the Recycle Bin', error);
    }
    return true;
  }

  toast(message: string, action?: { label: string; run: () => void }): void {
    const el = h('div', { class: 'toast' }, h('span', {}, message));
    if (action) {
      const button = h('button', { type: 'button', class: 'toast-action' }, action.label);
      button.addEventListener('click', () => {
        el.remove();
        action.run();
      });
      el.append(button);
    }
    this.toasts.append(el);
    while (this.toasts.children.length > 4) this.toasts.firstElementChild?.remove();
    window.setTimeout(() => el.remove(), action ? 10000 : 5000);
  }

  notify(title: string, text: string, action?: { label: string; run: () => void }): void {
    this.toast(text ? `${title}: ${text}` : title, action);
    this.notices?.add(title, text, action);
  }

  setTheme(theme: Theme): void {
    this.session.data.theme = theme;
    this.session.touch();
    this.applyTheme();
  }

  applyTheme(): void {
    document.documentElement.dataset.theme = this.session.data.theme;
    // Xfce calls its button Menu; the other schemes call it Start (Glass and Flat show only the orb).
    const word = this.session.data.theme === 'xfce' ? 'Menu' : 'Start';
    const label = document.querySelector('.start-label');
    if (label) label.textContent = word;
    // The word is hidden on phones and in Glass and Flat, so the button carries its name itself.
    document.querySelector('.start-btn')?.setAttribute('aria-label', word);
  }

  async report(title: string, error: unknown): Promise<void> {
    await this.dialogs.error(title, error);
  }

  // ---- Wallpaper -----------------------------------------------------------------------------------------------

  applyLockHint(): void {
    let hint = this.wallpaperEl.querySelector<HTMLElement>('.desk-hint');
    if (!hint) {
      hint = h('p', { class: 'desk-hint', 'aria-hidden': 'true' }, 'Alt+L locks · Alt+Shift+L signs out');
      this.wallpaperEl.append(hint);
    }
    hint.hidden = !(this.session.data.lock.hint && this.lock.canLock);
  }

  async setWallpaper(wallpaper: Wallpaper): Promise<void> {
    this.session.data.wallpaper = wallpaper;
    this.session.touch();
    await this.applyWallpaper();
  }

  async applyWallpaper(): Promise<void> {
    const mine = ++this.wallpaperGeneration;
    const wp = this.session.data.wallpaper;
    const release = () => {
      if (this.wallpaperUrl) URL.revokeObjectURL(this.wallpaperUrl);
      this.wallpaperUrl = null;
      css(this.wallpaperEl, { 'background-image': null });
    };
    if (wp.kind === 'colour') {
      release();
      css(this.wallpaperEl, { 'background-color': wp.value });
      return;
    }
    try {
      const entry = await this.fs.stat(wp.path);
      const mime = entry ? PICTURE_MIME[wp.path.slice(wp.path.lastIndexOf('.') + 1).toLowerCase()] : undefined;
      if (!entry || entry.kind !== 'file' || !mime) throw new Error('missing');
      if (entry.size > MAX_WALLPAPER_BYTES) {
        this.toast('That picture is too big to use as a background (over 25 MB).');
        throw new Error('big');
      }
      const bytes = await this.fs.readFile(wp.path);
      if (mine !== this.wallpaperGeneration) return;
      if (pictureTooBig(bytes)) {
        this.toast('That picture has too many pixels to use as a background.');
        throw new Error('big');
      }
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
      release();
      this.wallpaperUrl = url;
      css(this.wallpaperEl, { 'background-image': `url("${url}")` });
    } catch {
      if (mine !== this.wallpaperGeneration) return;
      release();
      this.session.data.wallpaper = { kind: 'colour', value: this.session.data.wallpaper.kind === 'colour' ? this.session.data.wallpaper.value : '#3a6ea5' };
      css(this.wallpaperEl, { 'background-color': '#3a6ea5' });
      this.toast('The background picture could not be used, so the plain colour is showing.');
    }
  }
}

interface Layers {
  wallpaper: HTMLElement;
  desktop: HTMLElement;
  windows: HTMLElement;
  taskbar: HTMLElement;
  start: HTMLElement;
  menus: HTMLElement;
  modal: HTMLElement;
  toasts: HTMLElement;
  transfers: HTMLElement;
}

function buildLayers(root: HTMLElement): Layers {
  const wallpaper = h('div', { id: 'wallpaper' });
  const desktop = h('div', { id: 'desktop' });
  const windows = h('div', { id: 'windows' });
  const taskbar = h('div', { id: 'taskbar', role: 'region', 'aria-label': 'Taskbar' });
  const start = h('div', { id: 'layer-start' });
  const menus = h('div', { id: 'layer-menus' });
  const modal = h('div', { id: 'layer-modal' });
  const toasts = h('div', { id: 'layer-toasts', role: 'status', 'aria-live': 'polite' });
  const transfers = h('div', { id: 'layer-transfers', role: 'region', 'aria-label': 'Uploads and downloads' });
  const drag = h('div', { id: 'layer-drag' });
  root.replaceChildren(iconDefs(), h('div', { id: 'screen' }, wallpaper, desktop, windows), taskbar, start, menus, modal, transfers, toasts, drag);
  return { wallpaper, desktop, windows, taskbar, start, menus, modal, toasts, transfers };
}

/** `account` is the signed-in person when the desktop runs on its server; null for a copy kept in this browser. */
export async function startDesktop(root: HTMLElement, store: Store, account: Account | null = null): Promise<Shell> {
  const layers = buildLayers(root);
  const shell = new DesktopShell(store, layers);
  const lifetime = new AbortController();
  const signal = lifetime.signal;
  shell.account = account;
  shell.lock = new LockScreen({
    root,
    shell,
    api: account?.api ?? null,
    user: () => shell.account?.user() ?? null,
    settings: () => shell.session.data.lock,
    signedOut: message => void shell.account?.signOut(message),
  });

  // Every app from the catalog; its code loads the first time it opens (the window shows at once, then fills).
  for (const meta of Object.values(APPS)) {
    const id = meta.id as AppId;
    if (HIDDEN_APPS.includes(id)) continue; // not in this release (src/release.ts)
    shell.registerApp(catalogApp(id));
  }
  // The store apps on this server that this person has added (asked in the background: the desktop does not wait).
  shell.installedApps = new Set(await readInstalled(shell.fs));
  if (account) {
    new ServiceApi(account.api.base, 'apps').call<{ apps: StoreApp[] }>('here').then(r => shell.setStoreApps(r.apps), () => undefined);
  }

  // Our own changes, and other tabs' changes, reach every open view.
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel('tomlinos-changes') : null;
  shell.fs.onChange(paths => {
    shell.changes.emit(paths);
    channel?.postMessage(paths);
  });
  if (channel) {
    channel.onmessage = event => {
      if (Array.isArray(event.data) && event.data.every((p: unknown) => typeof p === 'string')) shell.changes.emit(event.data);
    };
  }

  await shell.fs.list('/');
  await shell.session.load();
  await shell.applyWallpaper();
  shell.applyTheme();

  const { startButton } = buildTaskbar(layers.taskbar, shell.windows, shell.menus, signal, layers.start, {
    canLock: () => shell.lock.canLock,
    lock: () => void shell.lock.show(true),
    signOut: shell.account ? () => void shell.account?.signOut() : null,
  });
  shell.applyLockHint();
  const start = new StartMenu(shell, layers.start, startButton);
  const tray = layers.taskbar.querySelector<HTMLElement>('.tray');
  if (tray) shell.notices = new NoticeCentre(tray, layers.start, signal);
  bindDesktopKeys(shell, signal, () => shell.notices?.toggle());
  startReminders(shell, signal);
  startPrinterMessages(shell, signal);

  // The desktop's own icons: the Desktop folder plus four shortcuts that are not files (Panel, the control panel, is
  // here for everyone, so nobody has to find it in the Start menu; the printer is the game).
  let binFull = false;
  layers.desktop.setAttribute('data-drop-path', '/Desktop');
  const desktopView = createFolderView({
    shell,
    host: layers.desktop,
    signal,
    mode: 'desktop',
    label: 'Desktop',
    path: () => '/Desktop',
    onOpenFolder: path => void shell.openApp('explorer', path),
    virtual: [
      { key: 'v-files', name: 'My Files', icon: () => 'files', open: () => void shell.openApp('explorer', '/') },
      { key: 'v-panel', name: APPS.panel.title, icon: () => 'panel', open: () => void shell.openApp('panel') },
      ...(shell.hasApp('printer') ? [{ key: 'v-printer', name: APPS.printer.title, icon: () => 'printer' as const, open: () => void shell.openApp('printer') }] : []),
      {
        key: 'v-trash',
        name: 'Recycle Bin',
        icon: () => (binFull ? 'trash-full' : 'trash'),
        open: () => void shell.openApp('trash'),
        dropBin: true,
        menu: () => [{ label: 'Empty Recycle Bin', disabled: !binFull, action: () => void shell.openApp('trash') }],
      },
    ],
  });
  const checkBin = async () => {
    const full = (await shell.bin.count().catch(() => 0)) > 0;
    if (full !== binFull) {
      binFull = full;
      await desktopView.refresh();
    }
  };
  shell.changes.on(paths => {
    if (paths.some(p => p === TRASH_DIR)) void checkBin();
  }, signal);
  await desktopView.refresh();
  await checkBin();

  // Housekeeping, as the person set it in Settings (the Recycle Bin's clearing, and old AI chats): at start-up, hourly,
  // and on coming back.
  const tidy = () => {
    void shell.applyBinPolicy();
    void clearOldThreads(shell.fs, shell.session.data.aiHistoryDays).catch(() => undefined);
  };
  tidy();
  const housekeeping = window.setInterval(tidy, 3600000);
  signal.addEventListener('abort', () => clearInterval(housekeeping), { once: true });
  on(document, 'visibilitychange', () => {
    if (!document.hidden) tidy();
  }, signal);

  // ---- Page-level behaviour --------------------------------------------------------------------------------

  // A file dropped anywhere else must not make the browser navigate away to it.
  for (const type of ['dragover', 'drop']) {
    on(window, type, (event: DragEvent) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
    }, signal);
  }
  on(window, 'beforeunload', (event: BeforeUnloadEvent) => {
    void shell.session.flush();
    if (shell.windows.hasUnsaved()) {
      event.preventDefault();
      event.returnValue = '';
    }
  }, signal);
  on(document, 'visibilitychange', () => {
    if (document.hidden) void shell.session.flush();
  }, signal);
  // A failure nobody caught is shown once, in words. It never reloads the page or touches files.
  const surface = (error: unknown) => {
    if (!shell.dialogs.isOpen) void shell.report('Something went wrong', error);
  };
  on(window, 'error', (event: ErrorEvent) => surface(event.error ?? event.message), signal);
  on(window, 'unhandledrejection', (event: PromiseRejectionEvent) => surface(event.reason), signal);
  // The menu key and Escape close the Start menu and menus from anywhere, unless the Start menu used the Escape itself
  // (to close one of its All Programs columns).
  on(document, 'keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape' && start.isOpen && !event.defaultPrevented) start.close();
  }, signal);
  on(layers.desktop, 'pointerdown', () => {
    if (start.isOpen) start.close(false);
  }, signal);

  shell.lock.start(signal);

  desktopView.focus();
  root.classList.add('ready');
  document.getElementById('boot')?.remove();
  return shell;
}
