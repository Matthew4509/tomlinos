// Office Printer in a TOMLIN OS window. The game is public/office-printer/ (plain JavaScript and script.json, shared
// with its stand-alone page) and loads the first time this opens. This file hands it what it needs from TOMLIN OS:
// the saved game in your own files (/System/office-printer.json, never the browser's storage), your files to print
// through the desktop's own picker, and the file Ctrl+P was pressed on.
import { h } from '../core/dom.ts';
import { readLocalText } from '../core/local.ts';
import { pickFile } from '../shell/filepicker.ts';
import type { AppDef, Shell } from '../shell/types.ts';
import { APPS } from './catalog.ts';
import { GAME_FOLDER, PRINT_NOW, RETRY, SAVE_PATH, printRequests } from './printer/entry.ts';

interface GameFile {
  name: string;
  path?: string;
  size?: number;
  blob?: () => Promise<Blob>;
}

interface GameHandle {
  print(file?: GameFile | null): Promise<void>;
  printLast(): Promise<void>;
  destroy(): void;
}

interface GameModule {
  mountGame(root: HTMLElement, host: Record<string, unknown>): Promise<GameHandle>;
}

let styles: Promise<void> | null = null;
let code: Promise<GameModule> | null = null;

/** The game's own stylesheet (every rule starts with .op, so it cannot restyle the desktop), added once. */
function loadStyles(): Promise<void> {
  styles ??= new Promise(resolve => {
    const link = h('link', { rel: 'stylesheet', href: `${GAME_FOLDER}printer.css` });
    link.addEventListener('load', () => resolve(), { once: true });
    link.addEventListener('error', () => resolve(), { once: true });
    document.head.append(link);
  });
  return styles;
}

function loadCode(): Promise<GameModule> {
  code ??= import(new URL(`../../${GAME_FOLDER}js/game.js`, import.meta.url).href) as Promise<GameModule>;
  return code;
}

/** A file in the person's store, as the game reads it: its name and size now, its bytes only if the game asks. */
async function fileAt(shell: Shell, path: string): Promise<GameFile | null> {
  const entry = await shell.fs.stat(path).catch(() => null);
  if (!entry || entry.kind !== 'file') return null;
  return { name: entry.name, path, size: entry.size, blob: async () => new Blob([(await shell.fs.readFile(path)) as BlobPart]) };
}

export const printerApp: AppDef = {
  ...APPS.printer,
  async launch(app, arg) {
    const shell = app.shell;
    const [, game] = await Promise.all([loadStyles(), loadCode()]);
    if (app.signal.aborted) return;
    const file = arg && arg !== PRINT_NOW && arg !== RETRY ? await fileAt(shell, arg) : null;
    const handle = await game.mountGame(app.root, {
      signal: app.signal,
      file,
      messages: true,
      pickLabel: 'Choose one of your files...',
      fileAt: (path: string) => fileAt(shell, path),
      loadText: (path: string) => readLocalText(`${GAME_FOLDER}${path}`),
      storage: {
        load: async () => JSON.parse(await shell.fs.readText(SAVE_PATH)) as unknown,
        save: async (data: unknown) => {
          await shell.fs.ensureFolder('/System', { hidden: true });
          await shell.fs.writeText(SAVE_PATH, JSON.stringify(data), { hidden: true });
        },
      },
      pickFile: async () => {
        const path = await pickFile(shell, { title: 'Print which file?', ok: 'Print this' });
        return path ? fileAt(shell, path) : null;
      },
      onError: (error: unknown) => shell.toast(`Office Printer: ${error instanceof Error ? error.message : String(error)}`),
    });
    // Opened by Ctrl+P: the printers answer straight away; by Retry on the printer's alert: the last document again.
    // From the desktop icon or the Start menu: the print dialog.
    if (arg === RETRY) void handle.printLast();
    else if (arg) void handle.print();
    printRequests.on(path => void (path ? fileAt(shell, path) : Promise.resolve(null)).then(f => handle.print(f)), app.signal);
  },
};
