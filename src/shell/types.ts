// The shapes the parts of the shell share. Parts talk to each other through these small interfaces, not by
// reaching into each other's page elements.
import type { AuthApi, PublicUser } from '../auth/api.ts';
import type { FilesVault } from '../auth/files.ts';
import type { LockScreen } from '../auth/lock.ts';
import type { Bus } from '../core/bus.ts';
import type { FileSystem } from '../fs/fs.ts';
import type { DialogLayer } from './dialogs.ts';
import type { FileActions } from './actions.ts';
import type { IconName } from './icons.ts';
import type { MenuLayer } from './menu.ts';
import type { Session } from './session.ts';
import type { RecycleBin } from './trash.ts';
import type { Transfers } from './transfer.ts';
import type { WindowManager } from './windows.ts';

/** What an app is given for its window: enough to work, nothing more. */
export interface AppHandle {
  /** Generated when the window opens; never derived from a file name. */
  readonly id: string;
  readonly root: HTMLElement;
  /** Aborts when the window closes. Every listener the app adds must use it. */
  readonly signal: AbortSignal;
  readonly shell: Shell;
  setTitle(title: string): void;
  setIcon(icon: IconName): void;
  /** Asks for a new window width in pixels; ignored when maximised or snapped. */
  setWidth(width: number): void;
  close(): void;
  /** Unsaved work: the shell asks before the window closes or the page unloads. */
  setDirty(dirty: boolean): void;
  /** Runs before the window closes; return false to keep it open (after asking the person, for instance). */
  onClose(guard: () => boolean | Promise<boolean>): void;
}

export interface AppDef {
  id: string;
  title: string;
  icon: IconName;
  size: readonly [number, number];
  minSize?: readonly [number, number];
  /** Listed in the Start menu. */
  start?: boolean;
  /** Opening it again with the same argument focuses the open window instead of making another. */
  single?: boolean;
  /** The Start menu group for an app no group lists by name (store apps say theirs). */
  group?: string;
  launch(handle: AppHandle, arg?: string): void | Promise<void>;
}

/** An app's details without its code (src/apps/catalog.ts holds one for every app). */
export type AppMeta = Omit<AppDef, 'launch'>;

/** The signed-in person, when the desktop runs on its server with accounts. */
export interface Account {
  readonly api: AuthApi;
  /** The person's file encryption and recovery key. */
  readonly files: FilesVault;
  user(): PublicUser;
  /** Keeps the page's copy of the person up to date after a change the server made (PIN set, two-step on...). */
  setUser(user: PublicUser): void;
  /** Signs out on the server (unless already signed out), then shows the sign-in screen with `message`. */
  signOut(message?: string): Promise<void>;
}

export interface Clipboard {
  mode: 'copy' | 'cut';
  paths: string[];
}

export interface Shell {
  readonly fs: FileSystem;
  readonly storeLabel: string;
  readonly windows: WindowManager;
  readonly menus: MenuLayer;
  readonly dialogs: DialogLayer;
  readonly session: Session;
  readonly bin: RecycleBin;
  readonly actions: FileActions;
  readonly transfers: Transfers;
  /** Told the folder paths that changed, from this window or another tab. */
  readonly changes: Bus<string[]>;
  clipboard: Clipboard | null;
  readonly clipboardChanged: Bus<void>;
  /** True when the screen locks (screensaver, Lock now), false when it unlocks. Apps pause anything that runs. */
  readonly lockChanged: Bus<boolean>;
  /** null when files are kept in this browser (no accounts there). */
  readonly account: Account | null;
  readonly lock: LockScreen;
  /** The area icons are placed on; drags onto it drop into the Desktop folder. */
  registerApp(app: AppDef): void;
  hasApp(id: string): boolean;
  /** The store apps this person has added to their desktop (src/shell/installed.ts), whether or not on this server. */
  readonly installedApps: ReadonlySet<string>;
  /** The store apps on this server (api/apps.php), by id. */
  readonly storeApps: ReadonlyMap<string, import('../apps/storeapp.ts').StoreApp>;
  /** The server's store apps changed (the owner downloaded or deleted one): registers what this person has added. */
  setStoreApps(apps: import('../apps/storeapp.ts').StoreApp[]): void;
  /** Adds a store app on this server to this person's desktop, or takes it off (its windows close). */
  setInstalled(id: string, on: boolean): Promise<void>;
  openApp(id: string, arg?: string): Promise<void>;
  /** Opens a file or folder with whatever app handles it, or says why nothing does. */
  openPath(path: string): Promise<void>;
  toast(message: string, action?: { label: string; run: () => void }): void;
  /** A toast that is also kept in the notification centre, for things worth finding again (calendar reminders). */
  notify(title: string, text: string, action?: { label: string; run: () => void }): void;
  /** Changes the colour scheme of the title bars, taskbar and windows, and remembers it. */
  setTheme(theme: import('./session.ts').Theme): void;
  report(title: string, error: unknown): Promise<void>;
  setWallpaper(wallpaper: import('./session.ts').Wallpaper): Promise<void>;
  /** Shows or hides the lock keys on the desktop background, as Settings says. */
  applyLockHint(): void;
  apps(): AppDef[];
  /**
   * Deletes Recycle Bin items the person's auto-clear setting says are due. With `ask`, first says how many would
   * go and asks; returns false if they said no (nothing is deleted).
   */
  applyBinPolicy(ask?: boolean): Promise<boolean>;
}
