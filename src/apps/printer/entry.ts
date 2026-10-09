// The ways into Office Printer from the rest of the desktop, kept apart from the game so the desktop carries them
// without loading it: Ctrl+P "prints" the front window's file (the printers answer back instead), and now and then
// the printer reports a failed print, the way Windows does, with a Retry button that sends the last document again
// (at most once a day, only while the game is closed).
// The game itself is public/office-printer/ (plain JavaScript, shared with its stand-alone page); apps/printer.ts
// opens it in a window.
import { Bus } from '../../core/bus.ts';
import { readLocalJson } from '../../core/local.ts';
import type { Shell } from '../../shell/types.ts';

export const SAVE_PATH = '/System/office-printer.json';
export const GAME_FOLDER = 'office-printer/';
/** The argument that opens the game straight into printing its own document. */
export const PRINT_NOW = 'print';

/** A file to print (or null for the game's own document), for a printer window that is already open. */
export const printRequests = new Bus<string | null>();

/** The file a window has open, read from the path it was opened with. Folders and the printer itself give null. */
export function fileOfWindow(appId: string, key: string): string | null {
  if (appId === 'explorer' || appId === 'printer') return null;
  const at = key.indexOf(':');
  const arg = at < 0 ? '' : key.slice(at + 1);
  return arg.startsWith('/') ? arg : null;
}

/** Ctrl+P: the printer answers back about the front window's file (or its own report when there is none). */
export async function printFront(shell: Shell): Promise<void> {
  const front = shell.windows.front();
  let path = front ? fileOfWindow(front.appId, front.key) : null;
  if (path && (await shell.fs.stat(path).catch(() => null))?.kind !== 'file') path = null;
  const open = shell.windows.find('printer');
  if (open) {
    shell.windows.focus(open);
    printRequests.emit(path);
    return;
  }
  await shell.openApp('printer', path ?? PRINT_NOW);
}

interface Script {
  alert: { title: string; lines: string[]; action: string; defaultDoc: string };
  speakers: Record<string, { name: string; place: string }>;
}

/** The argument that opens the game straight into printing the last document again ("Retry"). */
export const RETRY = 'retry';

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * The day's printer alert, as Windows shows a failed print: the LaserJet's name as the title, and the last document
 * this person printed (or the report nobody ever printed) in the text. The lines take turns by day.
 */
export function alertFor(script: Script, save: Record<string, unknown>, day: Date): { title: string; text: string } {
  const lj = script.speakers.laserjet;
  const last = save.lastDoc as { name?: unknown } | null | undefined;
  const doc = typeof last?.name === 'string' && last.name ? last.name : script.alert.defaultDoc;
  const lines = script.alert.lines;
  const line = lines[Math.floor(day.getTime() / 86400000) % lines.length];
  return {
    title: script.alert.title.replace('{printer}', lj.name).replace('{place}', lj.place),
    text: line.replace('{doc}', doc),
  };
}

const FIRST_LOOK = 3 * 60000;

/** Three minutes after the desktop starts, the printer may report a failed print (see the top of this file). */
export function startPrinterMessages(shell: Shell, signal: AbortSignal): void {
  if (!shell.hasApp('printer')) return;
  let timer = window.setTimeout(check, FIRST_LOOK);
  signal.addEventListener('abort', () => clearTimeout(timer), { once: true });

  async function check(): Promise<void> {
    if (signal.aborted) return;
    if (shell.lock.isShowing) {
      timer = window.setTimeout(check, 60000);
      return;
    }
    if (shell.windows.find('printer')) return;
    let save: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(await shell.fs.readText(SAVE_PATH));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) save = parsed as Record<string, unknown>;
    } catch {
      save = {};
    }
    const now = new Date();
    if (save.messages === false || save.lastMessage === dayKey(now)) return;
    let script: Script;
    try {
      script = await readLocalJson<Script>(`${GAME_FOLDER}script.json`);
    } catch {
      return;
    }
    save.lastMessage = dayKey(now);
    try {
      await shell.fs.ensureFolder('/System', { hidden: true });
      await shell.fs.writeText(SAVE_PATH, JSON.stringify(save), { hidden: true });
    } catch {
      return;
    }
    if (signal.aborted) return;
    const alert = alertFor(script, save, now);
    shell.notify(alert.title, alert.text, { label: script.alert.action, run: () => void shell.openApp('printer', RETRY) });
  }
}
