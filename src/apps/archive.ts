// Archive opener: looks inside .zip, .gz, .tar and .tar.gz/.tgz files and extracts them into a new folder made in the
// folder the person picks. Reading and the safety rules (names, size caps) are in archive/read.ts. Nothing inside is ever run.
import { h, on } from '../core/dom.ts';
import { formatSize, plural } from '../core/format.ts';
import { baseName, joinPath, nameKey, parentPath, splitExtension, uniqueName } from '../fs/names.ts';
import { fileTypeOf } from '../shell/filetypes.ts';
import { icon } from '../shell/icons.ts';
import { pickFolder, type FileTypeChoice } from '../shell/filepicker.ts';
import type { AppDef, AppHandle } from '../shell/types.ts';
import { ArchiveError, readArchive, type ArchiveEntry } from './archive/read.ts';
import { APPS } from './catalog.ts';
import { openableViewer } from './viewer.ts';

/** Folders inside folders an extract makes, at most: a deeper entry is left out (and said), not a near-endless walk. */
const MAX_DEPTH = 64;

const MAX_ARCHIVE_BYTES = 300 * 1024 * 1024;

interface Row {
  name: string;
  folder: boolean;
  size: number;
  /** For a file row: the entry it shows (opened by double-click or Enter). */
  entry?: ArchiveEntry;
}

/** At most this many skipped or renamed items are named in the end message; the rest are counted. */
const MAX_LISTED = 15;

/** The end message's list: a few lines, then "and 3 more". */
function listed(lines: string[]): string {
  const shown = lines.slice(0, MAX_LISTED).map(l => '• ' + l);
  if (lines.length > MAX_LISTED) shown.push(`and ${lines.length - MAX_LISTED} more`);
  return shown.join('\n');
}

/** "photos.tar.gz" -> "photos". */
export function archiveStem(name: string): string {
  const stripped = name.replace(/\.(tar\.gz|tgz|tar|zip|gz)$/i, '');
  return stripped && stripped !== name ? stripped : splitExtension(name)[0] || 'Extracted';
}

export const archiveApp: AppDef = {
  ...APPS.archive,
  launch(app, arg) {
    app.root.classList.add('archive');
    return openableViewer(app, arg, { name: 'Archive Opener', openTitle: 'Open an archive', folder: '/Downloads', types: ARCHIVE_TYPES, load: showArchive });
  },
};

const ARCHIVE_TYPES: FileTypeChoice[] = [
  { label: 'All archives', ext: ['zip', 'tar', 'tgz', 'gz'] },
  { label: 'Zip archive', ext: ['zip'] },
  { label: 'Tar archive', ext: ['tar', 'tgz', 'gz'] },
];

async function showArchive(app: AppHandle, arg: string | undefined): Promise<void> {
  const shell = app.shell;
  const message = (text: string) => app.root.replaceChildren(h('p', { class: 'app-message', role: 'alert' }, text));
  if (!arg) {
    app.setTitle(APPS.archive.title);
    return message('Use File > Open to choose a .zip, .gz or .tar file.');
  }
  const archiveName = baseName(arg);
  app.setTitle(archiveName);
  app.root.append(h('p', { class: 'app-message' }, 'Reading...'));

  let entries: ArchiveEntry[];
  try {
    const entry = await shell.fs.stat(arg);
    if (!entry || entry.kind !== 'file') return message('That file is not there any more. It may have been moved or deleted.');
    if (entry.size > MAX_ARCHIVE_BYTES) return message(`This archive is ${formatSize(entry.size)}. The opener reads archives up to ${formatSize(MAX_ARCHIVE_BYTES)}. It is safe where it is.`);
    entries = await readArchive(await shell.fs.readFile(arg), archiveName);
  } catch (error) {
    if (error instanceof ArchiveError) return message(error.message);
    await shell.report('Could not open the archive', error);
    return message('This archive could not be opened.');
  }
  if (app.signal.aborted) return;

  let here: string[] = [];
  const chosen = new Set<string>();
  const allBtn = h('button', { type: 'button', class: 'tool wide', title: 'Unpack everything into a new folder, in a folder you choose' }, 'Extract all...');
  const someBtn = h('button', { type: 'button', class: 'tool wide', disabled: true, title: 'Unpack only the ticked items' }, 'Extract selected...');
  const upBtn = h('button', { type: 'button', class: 'tool wide', disabled: true, title: 'Up one folder', 'aria-label': 'Up one folder' }, '.. Up');
  const where = h('span', { class: 'archive-where' });
  const list = h('div', { class: 'archive-list', role: 'listbox', 'aria-multiselectable': 'true', 'aria-label': 'Inside the archive', tabindex: '0' });
  const files = entries.filter(e => !e.folder);
  const status = h('div', { class: 'statusbar', role: 'status' }, `${plural(files.length, 'file')}, ${formatSize(files.reduce((n, e) => n + e.size, 0))} unpacked`);
  app.root.replaceChildren(h('div', { class: 'toolbar' }, allBtn, someBtn, upBtn, where), list, status);

  const keyOf = (parts: string[]) => parts.map(nameKey).join('/');
  const under = (e: ArchiveEntry, parts: string[]) => e.parts.length > parts.length && parts.every((p, i) => nameKey(e.parts[i]) === nameKey(p));

  /** What sits directly in the folder `here`: files, and folders (named or implied by a file's path). */
  function rows(): Row[] {
    const byKey = new Map<string, Row>();
    for (const e of entries) {
      if (!under(e, here)) continue;
      const name = e.parts[here.length];
      const folder = e.folder || e.parts.length > here.length + 1;
      // Folders whose names fold together are one folder; files keep a row each, as they are extracted each under a name.
      const key = folder ? nameKey(name) + '/' : '\0' + name;
      const row: Row = byKey.get(key) ?? { name, folder, size: 0 };
      if (!e.folder) row.size += e.size;
      if (!folder) row.entry = e;
      byKey.set(key, row);
    }
    return [...byKey.values()].sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name));
  }

  /** The rows on show, in order, and the one the keyboard is on. */
  let shown: { row: Row; el: HTMLElement }[] = [];

  function render(focusName?: string) {
    where.textContent = '/' + here.join('/');
    upBtn.disabled = here.length === 0;
    someBtn.disabled = chosen.size === 0;
    shown = rows().map(row => {
      const key = keyOf([...here, row.name]) + (row.folder ? '/' : '');
      const tick = h('input', { type: 'checkbox', 'aria-label': `Choose ${row.name}`, checked: chosen.has(key) });
      const locked = !row.folder && row.entry?.locked;
      const el = h('div', {
        class: 'archive-row', role: 'option', tabindex: '-1', 'aria-selected': String(chosen.has(key)),
        title: row.folder ? 'Double-click or press Enter to look inside' : locked ? 'Locked with a password: it cannot be opened or extracted here' : 'Double-click or press Enter to open',
      },
        tick, icon(row.folder ? 'folder' : fileTypeOf(row.name).icon, 20), h('span', { class: 'archive-name' }, row.name),
        h('span', { class: 'archive-size' }, row.folder ? '' : locked ? 'Locked' : formatSize(row.size)));
      on(tick, 'change', () => {
        if (tick.checked) chosen.add(key);
        else chosen.delete(key);
        el.setAttribute('aria-selected', String(tick.checked));
        someBtn.disabled = chosen.size === 0;
      }, app.signal);
      on(el, 'dblclick', () => void activate(row), app.signal);
      return { row, el };
    });
    list.replaceChildren(...shown.map(s => s.el));
    if (!list.firstChild) list.append(h('p', { class: 'app-message' }, 'This archive is empty.'));
    if (focusName !== undefined) {
      const at = shown.findIndex(s => s.row.folder && nameKey(s.row.name) === nameKey(focusName));
      moveTo(Math.max(0, at));
    }
  }

  /** A folder row opens the folder; a file row opens the file. */
  async function activate(row: Row) {
    if (row.folder) {
      here = [...here, row.name];
      render('');
    } else if (row.entry) await openEntry(row.entry);
  }

  function goUp() {
    if (!here.length) return;
    const from = here[here.length - 1];
    here = here.slice(0, -1);
    render(from);
  }

  function moveTo(index: number) {
    const target = shown[Math.min(Math.max(index, 0), shown.length - 1)];
    target?.el.focus();
  }

  // The keyboard, as in File Explorer's list: Up, Down, Home and End move through the rows, Enter opens the row,
  // Backspace goes up a folder, Space ticks the row.
  on(list, 'keydown', (event: KeyboardEvent) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const current = (event.target as HTMLElement).closest('.archive-row');
    const index = shown.findIndex(s => s.el === current);
    const move = (to: number) => {
      event.preventDefault();
      moveTo(to);
    };
    if (event.key === 'ArrowDown') return move(index < 0 ? 0 : index + 1);
    if (event.key === 'ArrowUp') return move(index < 0 ? 0 : index - 1);
    if (event.key === 'Home') return move(0);
    if (event.key === 'End') return move(shown.length - 1);
    if (event.key === 'Backspace') {
      event.preventDefault();
      return goUp();
    }
    if (index < 0) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      void activate(shown[index].row);
    } else if (event.key === ' ' && event.target === current) {
      event.preventDefault();
      shown[index].el.querySelector('input')?.click();
    }
  }, app.signal);

  // A file opened from inside the archive is copied out first: into a new folder named after the archive, made beside
  // it the first time and used again for the next file opened from this window.
  let openFolder: string | null = null;
  const openedAt = new Map<ArchiveEntry, string>();
  async function openEntry(e: ArchiveEntry) {
    const name = e.parts[e.parts.length - 1];
    try {
      const before = openedAt.get(e);
      if (before && (await shell.fs.stat(before))?.kind === 'file') return void (await shell.openPath(before));
      if (e.locked) return void (await shell.dialogs.alert('Locked with a password', `“${name}” is locked with a password. This opener does not unlock zip passwords.`));
      const bytes = await e.read();
      if (app.signal.aborted) return;
      if (!openFolder || (await shell.fs.stat(openFolder))?.kind !== 'folder') {
        const beside = parentPath(arg!);
        const taken = (await shell.fs.list(beside, true)).map(x => x.name);
        openFolder = joinPath(beside, (await shell.fs.mkdir(joinPath(beside, uniqueName(archiveStem(archiveName), taken, true)))).name);
      }
      const fileName = uniqueName(name, (await shell.fs.list(openFolder, true)).map(x => x.name));
      const path = joinPath(openFolder, fileName);
      await shell.fs.writeFile(path, bytes, { mustBeNew: true });
      openedAt.set(e, path);
      status.textContent = `Opened a copy of “${name}”, put in ${openFolder}.`;
      const folder = openFolder;
      shell.toast(`“${fileName}” was copied out of the archive into ${folder} to open it.`, { label: 'Open folder', run: () => void shell.openPath(folder) });
      await shell.openPath(path);
    } catch (error) {
      if (error instanceof ArchiveError) await shell.dialogs.alert('Could not open that file', error.message);
      else await shell.report('Could not open that file', error);
    }
  }

  async function extract(pick: ArchiveEntry[]) {
    // The files go into a new folder named after the archive, made inside the folder chosen here.
    const folder = await pickFolder(shell, { title: 'Extract to', folder: parentPath(arg!), ok: 'Extract here' });
    if (folder === null || app.signal.aborted) return;
    let taken: string[] = [];
    try {
      taken = (await shell.fs.list(folder, true)).map(e => e.name);
    } catch {
      // Writing will say what is wrong.
    }
    const name = uniqueName(archiveStem(archiveName), taken);
    allBtn.disabled = someBtn.disabled = true;
    let done = 0;
    let deep = 0;
    // What could not come out (locked, damaged), and what came out under another name, all said once at the end.
    const skipped: string[] = [];
    const renamed: string[] = [];
    // The names given out in each folder (files and folders alike): two entries whose names come to the same one there
    // ("a.txt" and "A.TXT", "q?.txt" and "q_.txt", "café" written two ways, a file "x" and a folder "x/") get " (2)"
    // rather than one writing over the other or the extract stopping.
    const given = new Map<string, string[]>();
    // Each folder in the archive (by its folded path) -> the name it was given on disk.
    const folderNames = new Map<string, string>();
    const fileCount = pick.filter(p => !p.folder).length;
    try {
      const target = (await shell.fs.mkdir(joinPath(folder, name))).name;
      const root = joinPath(folder, target);
      const giveName = (dir: string[], wanted: string, isFolder: boolean, shownAs: string): string => {
        const names = given.get(keyOf(dir)) ?? [];
        const got = uniqueName(wanted, names, isFolder);
        names.push(got);
        given.set(keyOf(dir), names);
        if (got !== wanted) renamed.push(`${shownAs} came out as “${got}”`);
        return got;
      };
      /** Makes the folders of `parts` (as named on disk) and returns their names on disk. */
      const ensure = async (parts: string[]): Promise<string[]> => {
        const real: string[] = [];
        for (let i = 0; i < parts.length; i++) {
          const key = keyOf(parts.slice(0, i + 1));
          let got = folderNames.get(key);
          if (got === undefined) {
            got = giveName(real, parts[i], true, `the folder “${parts.slice(0, i + 1).join('/')}/”`);
            await shell.fs.ensureFolder(joinPath(root, ...real, got));
            folderNames.set(key, got);
          }
          real.push(got);
        }
        return real;
      };
      for (const e of pick) {
        if (app.signal.aborted) return;
        if (e.parts.length > MAX_DEPTH) {
          deep++;
          continue;
        }
        if (e.folder) {
          await ensure(e.parts);
          continue;
        }
        const shownAs = e.parts.join('/');
        status.textContent = `Extracting ${done + skipped.length + 1} of ${fileCount}: ${shownAs}`;
        if (e.locked) {
          skipped.push(`“${shownAs}” is locked with a password`);
          continue;
        }
        let bytes: Uint8Array;
        try {
          bytes = await e.read();
        } catch (error) {
          // A damaged or unreadable file is left out and named; the rest still come out.
          if (!(error instanceof ArchiveError)) throw error;
          skipped.push(error.message);
          continue;
        }
        if (app.signal.aborted) return;
        const dir = await ensure(e.parts.slice(0, -1));
        const fileName = giveName(dir, e.parts[e.parts.length - 1], false, `“${shownAs}”`);
        await shell.fs.writeFile(joinPath(root, ...dir, fileName), bytes, { mustBeNew: true });
        done++;
      }
      const left = deep ? ` ${plural(deep, 'item')} nested more than ${MAX_DEPTH} folders deep ${deep === 1 ? 'was' : 'were'} left out.` : '';
      const notSkipped = skipped.length ? ` ${plural(skipped.length, 'file')} could not be extracted.` : '';
      status.textContent = `Extracted ${plural(done, 'file')} into “${target}”.${notSkipped}${left}`;
      shell.toast(`Extracted ${plural(done, 'file')} into “${target}”.${notSkipped}${left}`, { label: 'Open folder', run: () => void shell.openPath(root) });
      if (skipped.length || renamed.length) {
        const parts: string[] = [];
        if (skipped.length) parts.push(`Left out (${skipped.length}):\n${listed(skipped)}`);
        if (renamed.length) parts.push(`Given a new name, as the name was already used in that folder (${renamed.length}):\n${listed(renamed)}`);
        allBtn.disabled = false;
        someBtn.disabled = chosen.size === 0;
        await shell.dialogs.alert(`Extracted ${plural(done, 'file')} into “${target}”`, parts.join('\n\n'));
      }
    } catch (error) {
      status.textContent = `Stopped after ${plural(done, 'file')}.`;
      if (error instanceof ArchiveError) await shell.dialogs.alert('Could not extract everything', `${error.message} ${plural(done, 'file')} before it were extracted.`);
      else await shell.report('Could not extract', error);
    } finally {
      allBtn.disabled = false;
      someBtn.disabled = chosen.size === 0;
    }
  }

  on(upBtn, 'click', goUp, app.signal);
  on(allBtn, 'click', () => void extract(entries), app.signal);
  on(someBtn, 'click', () => {
    const keys = [...chosen];
    void extract(entries.filter(e => {
      const k = keyOf(e.parts);
      return keys.some(c => (c.endsWith('/') ? (k + '/').startsWith(c) : k === c));
    }));
  }, app.signal);
  render();
}
