// The parts of the Tauri 1 page API this program uses (window.__TAURI__, set because tauri.conf.json has
// withGlobalTauri), typed here so the rest of the host reads like ordinary code. Nothing else is reached.

export interface UnlistenFn { (): void }
export interface CloseRequestedEvent { preventDefault(): void }
export interface TauriWindow {
  readonly label: string;
  setTitle(title: string): Promise<void>;
  show(): Promise<void>;
  setFocus(): Promise<void>;
  close(): Promise<void>;
  maximize(): Promise<void>;
  unminimize(): Promise<void>;
  isMaximized(): Promise<boolean>;
  innerSize(): Promise<{ width: number; height: number }>;
  outerPosition(): Promise<{ x: number; y: number }>;
  scaleFactor(): Promise<number>;
  setSize(size: unknown): Promise<void>;
  setPosition(position: unknown): Promise<void>;
  onCloseRequested(handler: (event: CloseRequestedEvent) => void | Promise<void>): Promise<UnlistenFn>;
  listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<UnlistenFn>;
}
export interface FileFilter { name: string; extensions: string[] }

interface TauriGlobal {
  tauri: { invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> };
  dialog: {
    open(options: { title?: string; multiple?: boolean; filters?: FileFilter[]; defaultPath?: string }): Promise<string | string[] | null>;
    save(options: { title?: string; filters?: FileFilter[]; defaultPath?: string }): Promise<string | null>;
  };
  window: {
    appWindow: TauriWindow;
    WebviewWindow: new (label: string, options: Record<string, unknown>) => TauriWindow;
    getAll(): TauriWindow[];
    LogicalSize: new (width: number, height: number) => unknown;
    PhysicalPosition: new (x: number, y: number) => unknown;
  };
  event: {
    emit(event: string, payload?: unknown): Promise<void>;
    listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<UnlistenFn>;
  };
  process: { relaunch(): Promise<never>; exit(code?: number): Promise<never> };
  app: { getVersion(): Promise<string> };
  shell: { open(url: string): Promise<void> };
}

/** The Tauri page API, or null when the page is opened outside the program (a plain browser, for a quick look). */
export const tauri: TauriGlobal | null = (globalThis as { __TAURI__?: TauriGlobal }).__TAURI__ ?? null;

export function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!tauri) return Promise.reject(new Error('This page is running outside TOMLIN Sheets.'));
  return tauri.tauri.invoke<T>(cmd, args);
}
