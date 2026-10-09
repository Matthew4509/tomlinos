// Archive opener: looks inside .zip, .gz, .tar and .tar.gz/.tgz files and extracts them into a new folder beside the
// archive. Reading and the safety rules (names, size caps) are in archive/read.ts. Nothing inside is ever run.
import { h, on } from '../core/dom.ts';
import { formatSize, plural } from '../core/format.ts';
import { baseName, joinPath, nameKey, parentPath, splitExtension, uniqueName } from '../fs/names.ts';
import { fileTypeOf } from '../shell/filetypes.ts';
import { icon } from '../shell/icons.ts';
import type { AppDef } from '../shell/types.ts';
import { ArchiveError, readArchive, type ArchiveEntry } from './archive/read.ts';
import { APPS } from './catalog.ts';

const MAX_ARCHIVE_BYTES = 300 * 1024 * 1024;

interface Row {
  name: string;
  folder: boolean;
  size: number;
}

/** "photos.tar.gz" -> "photos". */
export function archiveStem(name: string): string {
  const stripped = name.replace(/\.(tar\.gz|tgz|tar|zip|gz)$/i, '');
  return stripped && stripped !== name ? stripped : splitExtension(name)[0] || 'Extracted';
}

export const archiveApp: AppDef = {
  ...APPS.archive,
  async launch(app, arg) {
    const shell = app.shell;
    app.root.classList.add('archive');
    const message = (text: string) => app.root.replaceChildren(h('p', { class: 'app-message', role: 'alert' }, text));
    if (!arg) return message('Open a .zip, .gz or .tar file from File Explorer.');
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
    const allBtn = h('button', { type: 'button', class: 'tool wide', title: 'Unpack everything into a new folder beside the archive' }, 'Extract all...');
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
        const key = nameKey(name) + (folder ? '/' : '');
        const row = byKey.get(key) ?? { name, folder, size: 0 };
        if (!e.folder) row.size += e.size;
        byKey.set(key, row);
      }
      return [...byKey.values()].sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name));
    }

    function render() {
      where.textContent = '/' + here.join('/');
      upBtn.disabled = here.length === 0;
      someBtn.disabled = chosen.size === 0;
      list.replaceChildren(
        ...rows().map(row => {
          const key = keyOf([...here, row.name]) + (row.folder ? '/' : '');
          const tick = h('input', { type: 'checkbox', 'aria-label': `Choose ${row.name}`, checked: chosen.has(key) });
          const el = h('div', { class: 'archive-row', role: 'option', 'aria-selected': String(chosen.has(key)), title: row.folder ? 'Double-click to look inside' : '' },
            tick, icon(row.folder ? 'folder' : fileTypeOf(row.name).icon, 20), h('span', { class: 'archive-name' }, row.name),
            h('span', { class: 'archive-size' }, row.folder ? '' : formatSize(row.size)));
          on(tick, 'change', () => {
            if (tick.checked) chosen.add(key);
            else chosen.delete(key);
            el.setAttribute('aria-selected', String(tick.checked));
            someBtn.disabled = chosen.size === 0;
          }, app.signal);
          if (row.folder) on(el, 'dblclick', () => { here = [...here, row.name]; render(); }, app.signal);
          return el;
        }),
      );
      if (!list.firstChild) list.append(h('p', { class: 'app-message' }, 'This archive is empty.'));
    }

    async function extract(pick: ArchiveEntry[]) {
      const folder = parentPath(arg!);
      let taken: string[] = [];
      try {
        taken = (await shell.fs.list(folder, true)).map(e => e.name);
      } catch {
        // Writing will say what is wrong.
      }
      const name = await shell.dialogs.prompt({
        title: 'Extract',
        label: `New folder for the files (made in ${folder})`,
        value: uniqueName(archiveStem(archiveName), taken),
        ok: 'Extract',
        check: v => (taken.some(t => nameKey(t) === nameKey(v)) ? `There is already something called "${v}" here.` : null),
      });
      if (name === null) return;
      allBtn.disabled = someBtn.disabled = true;
      let done = 0;
      const made = new Set<string>();
      try {
        const target = (await shell.fs.mkdir(joinPath(folder, name))).name;
        const root = joinPath(folder, target);
        const ensure = async (parts: string[]) => {
          for (let i = 1; i <= parts.length; i++) {
            const key = keyOf(parts.slice(0, i));
            if (made.has(key)) continue;
            await shell.fs.ensureFolder(joinPath(root, ...parts.slice(0, i)));
            made.add(key);
          }
        };
        for (const e of pick) {
          if (app.signal.aborted) return;
          if (e.folder) {
            await ensure(e.parts);
            continue;
          }
          await ensure(e.parts.slice(0, -1));
          status.textContent = `Extracting ${done + 1} of ${pick.filter(p => !p.folder).length}: ${e.parts.join('/')}`;
          await shell.fs.writeFile(joinPath(root, ...e.parts), await e.read());
          done++;
        }
        status.textContent = `Extracted ${plural(done, 'file')} into “${target}”.`;
        shell.toast(`Extracted ${plural(done, 'file')} into “${target}”.`, { label: 'Open folder', run: () => void shell.openPath(root) });
      } catch (error) {
        status.textContent = `Stopped after ${plural(done, 'file')}.`;
        if (error instanceof ArchiveError) await shell.dialogs.alert('Could not extract everything', `${error.message} ${plural(done, 'file')} before it were extracted.`);
        else await shell.report('Could not extract', error);
      } finally {
        allBtn.disabled = false;
        someBtn.disabled = chosen.size === 0;
      }
    }

    on(upBtn, 'click', () => { here = here.slice(0, -1); render(); }, app.signal);
    on(allBtn, 'click', () => void extract(entries), app.signal);
    on(someBtn, 'click', () => {
      const keys = [...chosen];
      void extract(entries.filter(e => {
        const k = keyOf(e.parts);
        return keys.some(c => (c.endsWith('/') ? (k + '/').startsWith(c) : k === c));
      }));
    }, app.signal);
    render();
  },
};
