// Recovery copies for an app's unsaved work, as CAD Draft keeps them: every two minutes, and at once when the page
// goes to the background, a window with changes not saved keeps a copy in the app's hidden folder, so a flat battery,
// a crash or a closed page loses two minutes at most. The copy goes once the work is saved or the window is closed on
// purpose; one left behind is offered by the app's next window. Each copy is two files: the work in a form the app
// opens again (`<id><ext>`), and a note of its name and where it came from (`<id>.note.json`). The note is written
// again every two minutes while the window is open, even when the work has not changed, so a window in another tab or
// on another device can tell a copy still in use (a fresh note) from one left behind, and offers only the latter.
// The Windows program (shell.native) has no hidden folders yet, so it keeps no copies.
import { h, on } from '../core/dom.ts';
import type { Entry } from '../fs/fs.ts';
import type { Shell } from './types.ts';

export const RECOVERY_MS = 2 * 60 * 1000;
/** A note written more recently than this belongs to a window still open somewhere (two keeps, and a slow background tab). */
export const IN_USE_MS = 5 * 60 * 1000;

/** The copies windows open now are keeping (in this page), which are not offered as left behind. */
const live = new Set<string>();

export interface RecoveryNote {
  /** The name the work had ("Budget.xlsx", "Untitled"). */
  label: string;
  /** The file it was opened from or last saved as, if any. */
  path: string | null;
}

export interface RecoveryOptions {
  /** The app to open a copy in (as shell.openApp knows it). */
  appId: string;
  /** Its hidden folder, such as "/System/sheet-recovery". */
  folder: string;
  /** The ending of a copy, such as ".sheet". */
  ext: string;
  /** The app's name and its work, for the offer: "The spreadsheet", "spreadsheet", "spreadsheets". */
  appName: string;
  one: string;
  many: string;
  /** True while the work has changes not saved. */
  unsaved(): boolean;
  /** Anything that changes when the work does (compared with Object.is), so an unchanged copy is not written again. */
  token(): unknown;
  /** The work as it is now, in the form the app opens from `<id><ext>`. */
  snapshot(): string | Uint8Array | Promise<string | Uint8Array>;
  /** Its name and where it came from, now. */
  note(): RecoveryNote;
}

export interface Recovery {
  /** True for a path that is one of this app's copies. */
  owns(path: string): boolean;
  /** This window opened a copy: it keeps that copy up to date from now on. The note says what it was. */
  adopt(path: string): Promise<RecoveryNote>;
  /** Keeps a copy now if the work changed since the last one (or drops the copy once the work is saved). */
  keep(): Promise<void>;
  /** The work was saved, or replaced on purpose: its copy is no longer needed. */
  drop(): void;
  /** Copies left behind by windows that stopped: offered to open or delete. `asked`: say so when there are none. */
  offer(asked: boolean, after?: { untouched: () => boolean; close: () => void }): Promise<void>;
}

const noteOf = (path: string, ext: string) => path.slice(0, -ext.length) + '.note.json';

export function createRecovery(shell: Shell, signal: AbortSignal, o: RecoveryOptions): Recovery {
  const off = !!shell.native;
  let mine: string | null = null;
  let keptToken: unknown = Symbol('none');
  let keeping: Promise<void> | null = null;
  /** When this window last wrote its copy's note. */
  let noted = 0;

  function drop(): void {
    const p = mine;
    mine = null;
    keptToken = Symbol('none');
    if (!p) return;
    live.delete(p);
    void shell.fs.remove([p, noteOf(p, o.ext)]).catch(() => {
      // Left behind: the next window offers it, and it can be deleted there.
    });
  }

  async function writeNote(p: string): Promise<void> {
    await shell.fs.writeText(noteOf(p, o.ext), JSON.stringify({ label: o.note().label, path: o.note().path }), { hidden: true });
    noted = Date.now();
  }

  async function keepNow(): Promise<void> {
    if (off) return;
    try {
      // Asked before the app has finished starting, these may throw: nothing is kept until it has.
      if (!o.unsaved()) {
        if (mine) drop();
        return;
      }
      const token = o.token();
      if (Object.is(token, keptToken)) {
        // Nothing new to keep: the note is written again instead (not on every call, so a keep straight after a keep
        // writes nothing), which tells other windows the copy is still in use.
        if (mine && Date.now() - noted >= RECOVERY_MS / 2) await writeNote(mine);
        return;
      }
      await shell.fs.ensureFolder(o.folder, { hidden: true });
      mine ??= `${o.folder}/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}${o.ext}`;
      const p = mine;
      live.add(p);
      const data = await o.snapshot();
      await writeNote(p);
      if (typeof data === 'string') await shell.fs.writeText(p, data, { hidden: true });
      else await shell.fs.writeFile(p, data, { hidden: true });
      // Saved, replaced or closed while the copy was being written: it is not needed after all.
      if (mine !== p || !o.unsaved()) {
        live.delete(p);
        if (mine === p) mine = null;
        await shell.fs.remove([p, noteOf(p, o.ext)]).catch(() => {});
        return;
      }
      keptToken = token;
    } catch {
      // Not kept this time: tried again in two minutes.
    }
  }

  /** One copy at a time: a second call while one is being written waits for it, then looks again. */
  function keep(): Promise<void> {
    const run = (keeping ?? Promise.resolve()).then(keepNow);
    keeping = run.finally(() => {
      if (keeping === run) keeping = null;
    });
    return run;
  }

  async function adopt(path: string): Promise<RecoveryNote> {
    mine = path;
    live.add(path);
    let note: RecoveryNote = { label: 'Untitled', path: null };
    try {
      const n = JSON.parse(await shell.fs.readText(noteOf(path, o.ext))) as { label?: unknown; path?: unknown };
      note = { label: typeof n.label === 'string' && n.label ? n.label : 'Untitled', path: typeof n.path === 'string' && n.path ? n.path : null };
    } catch {
      // Opened as "Untitled".
    }
    // Written again as read, so it is fresh: a window offered the same copy a moment later does not open it too.
    void shell.fs.writeText(noteOf(path, o.ext), JSON.stringify(note), { hidden: true }).then(() => (noted = Date.now()), () => {});
    return note;
  }

  async function offer(asked: boolean, after?: { untouched: () => boolean; close: () => void }): Promise<void> {
    if (off) {
      if (asked) await shell.dialogs.alert('No recovery copies here', `${o.appName} keeps recovery copies on the desktop only, not in this program yet: Save keeps your work.`);
      return;
    }
    let left: Entry[] = [];
    let elsewhere = 0;
    try {
      const entries = await shell.fs.list(o.folder, true);
      // A copy whose note was written lately is being kept by a window open in another tab or on another device: not
      // left behind, so not offered (opening it would make two windows write over each other; Delete would destroy it).
      const noteWritten = new Map(entries.filter(e => e.name.endsWith('.note.json')).map(e => [e.name, e.modified]));
      const inUse = (e: Entry) => Date.now() - (noteWritten.get(noteOf(e.name, o.ext)) ?? 0) < IN_USE_MS;
      const copies = entries.filter(e => e.kind === 'file' && e.name.endsWith(o.ext) && !live.has(`${o.folder}/${e.name}`));
      left = copies.filter(e => !inUse(e));
      elsewhere = copies.length - left.length;
    } catch {
      // No folder yet: nothing was left behind.
    }
    if (!left.length) {
      if (asked && elsewhere) {
        await shell.dialogs.alert('Open in another window', `${elsewhere === 1 ? `A ${o.one} with unsaved changes is` : `${elsewhere} ${o.many} with unsaved changes are`} open in another window or tab (or on another device). Save there, or close that window, and the copy goes.`);
      } else if (asked) {
        await shell.dialogs.alert('Nothing to recover', `Every ${o.one} was saved or closed on purpose: there is no unsaved copy left behind.`);
      }
      return;
    }
    left.sort((a, b) => b.modified - a.modified);
    const lines: string[] = [];
    for (const e of left) {
      let name = 'Untitled';
      try {
        const n = JSON.parse(await shell.fs.readText(noteOf(`${o.folder}/${e.name}`, o.ext))) as { label?: unknown };
        if (typeof n.label === 'string' && n.label) name = n.label;
      } catch {
        // Shown as "Untitled"; opening it says what is wrong.
      }
      lines.push(`${name}: kept ${new Date(e.modified).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`);
    }
    const single = left.length === 1;
    const body = h('div', { class: 'recover-offer' },
      h('p', { class: 'dialog-text' }, `${o.appName} stopped before ${single ? `this ${o.one} was` : `these ${o.many} were`} saved (a flat battery, a crash, or the page was closed). The last copy kept of ${single ? 'it' : 'each'}:`),
      h('ul', { class: 'xlsx-list' }, ...lines.map(t => h('li', {}, t))),
      h('p', { class: 'dialog-detail' }, `${single ? 'It opens' : 'Each opens'} as not saved yet: Save asks where to keep it, so the file it came from stays as it was.`));
    const answer = await shell.dialogs.ask<'open' | 'delete' | null>({
      title: `${o.many[0].toUpperCase()}${o.many.slice(1)} not saved`,
      body,
      buttons: [{ label: single ? 'Open it' : 'Open them', value: 'open', primary: true }, { label: single ? 'Delete it' : 'Delete them', value: 'delete', danger: true }, { label: 'Later', value: null }],
      cancel: null,
    });
    if (answer === 'open') {
      const untouched = after?.untouched() ?? false;
      for (const e of left) await shell.openApp(o.appId, `${o.folder}/${e.name}`);
      if (untouched) after?.close();
    } else if (answer === 'delete') {
      await shell.fs.remove(left.flatMap(e => [`${o.folder}/${e.name}`, noteOf(`${o.folder}/${e.name}`, o.ext)])).catch(error => shell.report('Could not delete them', error));
    }
  }

  if (!off) {
    const timer = setInterval(() => void keep(), RECOVERY_MS);
    // The lid closing or the page going to the background keeps a copy at once.
    if (typeof document !== 'undefined') {
      on(document, 'visibilitychange', () => {
        if (document.visibilityState === 'hidden') void keep();
      }, signal);
    }
    // The window closes only after its unsaved question is answered: a close is on purpose, so the copy goes.
    signal.addEventListener('abort', () => {
      clearInterval(timer);
      drop();
    });
  }

  return { owns: path => path.startsWith(`${o.folder}/`) && path.endsWith(o.ext), adopt, keep, drop, offer };
}
