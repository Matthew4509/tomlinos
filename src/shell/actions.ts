// The things a person does to files, shared by the desktop, File Explorer and the Recycle Bin: make, rename,
// delete (to the bin), cut, copy, paste, move, look at properties. Each one reports a failure in words
// (what, why, what to do) and never leaves the screen silent.
import { h } from '../core/dom.ts';
import { formatDate, formatSize, plural } from '../core/format.ts';
import type { Entry } from '../fs/fs.ts';
import { baseName, cleanName, joinPath, nameKey, nameProblem, parentPath, splitPath, uniqueName } from '../fs/names.ts';
import { webAddress } from '../apps/link.ts';
import { describeError } from './dialogs.ts';
import { fileTypeOf } from './filetypes.ts';
import type { Failure } from './trash.ts';
import type { Shell } from './types.ts';

const PROTECTED_TOP = ['Desktop', 'Documents', 'Pictures', 'Videos', 'Music', 'System'];

/** The standard folders (and everything about the desktop's own System folder) cannot be deleted, moved or renamed. */
export function protectedReason(path: string): string | null {
  const parts = splitPath(path);
  if (parts.length === 0) return 'That is the top folder; it cannot be changed.';
  if (parts.length === 1 && PROTECTED_TOP.some(n => nameKey(n) === nameKey(parts[0]))) {
    return `"${parts[0]}" is one of the desktop's standard folders, so it cannot be deleted, moved or renamed.`;
  }
  if (nameKey(parts[0]) === 'system') return 'That belongs to the desktop itself and cannot be changed here.';
  return null;
}

/**
 * Why nothing may be put into `folder`, or null. The desktop's own System folder takes nothing from a person: what was
 * put there could never be deleted, moved, copied or downloaded again.
 */
/** Why a path cannot be copied, or null: the top folder, and anything of the desktop's own System folder. */
export function copyReason(path: string): string | null {
  const parts = splitPath(path);
  if (parts.length === 0) return 'That is the top folder; it cannot be copied.';
  return nameKey(parts[0]) === 'system' ? 'That belongs to the desktop itself and cannot be copied.' : null;
}

export function destinationReason(folder: string): string | null {
  const parts = splitPath(folder);
  return parts.length && nameKey(parts[0]) === 'system' ? 'The System folder belongs to the desktop itself; nothing can be put there. Choose another folder.' : null;
}

export class FileActions {
  private shell: Shell;

  constructor(shell: Shell) {
    this.shell = shell;
  }

  private failed(title: string, failures: Failure[]): Promise<void> {
    const shown = failures.slice(0, 5).map(f => `“${f.name}”: ${f.reason}`);
    if (failures.length > 5) shown.push(`...and ${failures.length - 5} more.`);
    return this.shell.dialogs.alert(title, shown.join('\n'), 'The items listed were left where they were.');
  }

  // ---- Making things -------------------------------------------------------------------------------------------

  /** A new folder or empty text file with a free name; returns its entry so the view can start renaming it. */
  async create(kind: 'folder' | 'text' | 'sheet' | 'link', folder: string): Promise<Entry | null> {
    const refused = destinationReason(folder);
    if (refused) {
      await this.shell.dialogs.alert('Cannot make that here', refused);
      return null;
    }
    try {
      if (kind === 'link') {
        const address = await this.shell.dialogs.prompt({ title: 'New web link', label: 'Web address (starting https://)', ok: 'Next', check: v => (webAddress(v) ? null : 'Type a full web address, starting https:// or http://') });
        if (address === null) return null;
        const url = webAddress(address)!;
        const taken = (await this.shell.fs.list(folder, true)).map(e => e.name);
        const name = uniqueName(`${cleanName(url.hostname.replace(/^www\./, '')) || 'Web link'}.url`, taken);
        return await this.shell.fs.writeFile(joinPath(folder, name), new TextEncoder().encode(`[InternetShortcut]\r\nURL=${url.href}\r\n`), { mustBeNew: true });
      }
      const taken = (await this.shell.fs.list(folder, true)).map(e => e.name);
      if (kind === 'folder') return await this.shell.fs.mkdir(joinPath(folder, uniqueName('New folder', taken, true)));
      // The spreadsheet's code loads only when a spreadsheet is made or opened, not with the page.
      if (kind === 'sheet') {
        const { Workbook } = await import('../apps/sheet/workbook.ts');
        return await this.shell.fs.writeFile(joinPath(folder, uniqueName('New Spreadsheet.sheet', taken)), new TextEncoder().encode(new Workbook().serialize()), { mustBeNew: true });
      }
      return await this.shell.fs.writeFile(joinPath(folder, uniqueName('New Text Document.txt', taken)), new Uint8Array(0), { mustBeNew: true });
    } catch (error) {
      await this.shell.report(kind === 'folder' ? 'Could not create the folder' : 'Could not create the file', error);
      return null;
    }
  }

  async rename(path: string, newName: string): Promise<Entry | null> {
    if (baseName(path) === newName) return null;
    const reason = protectedReason(path);
    if (reason) {
      await this.shell.dialogs.alert('Could not rename', reason);
      return null;
    }
    try {
      return await this.shell.fs.rename(path, newName);
    } catch (error) {
      await this.shell.report('Could not rename', error);
      return null;
    }
  }

  /** Why this name cannot be used for a rename in this folder, or null. Shown live while typing. */
  async nameCheck(folder: string, current: string, value: string): Promise<string | null> {
    const problem = nameProblem(value);
    if (problem) return problem;
    if (nameKey(value) === nameKey(current) && value !== current) return null;
    const taken = (await this.shell.fs.list(folder, true)).find(e => nameKey(e.name) === nameKey(value) && e.name !== current);
    return taken ? `There is already something called "${taken.name}" here.` : null;
  }

  // ---- Deleting (to the Recycle Bin) ---------------------------------------------------------------------------

  /** Returns what happened, for a caller that reports it in words of its own (the Terminal). */
  async deleteToBin(paths: string[]): Promise<{ binned: number; gone: number; kept: number }> {
    const done = { binned: 0, gone: 0, kept: paths.length };
    const blocked = paths.map(p => ({ path: p, reason: protectedReason(p) })).filter(p => p.reason);
    const allowed = paths.filter(p => !protectedReason(p));
    if (blocked.length) {
      await this.failed('Some items cannot be deleted', blocked.map(b => ({ name: baseName(b.path), reason: b.reason! })));
    }
    if (!allowed.length) return done;
    try {
      const { toBin, over } = await this.splitByLimit(allowed);
      if (over.length) {
        const limit = this.shell.session.data.bin.limitMb;
        const list = over.map(o => `“${baseName(o.path)}” (${formatSize(o.size)})`).slice(0, 5).join(', ');
        const ok = await this.shell.dialogs.confirm({
          title: 'Too big for the Recycle Bin',
          text: `${list} ${over.length === 1 ? 'is' : 'are'} over the Recycle Bin size limit of ${limit} MB, so ${over.length === 1 ? 'it' : 'they'} cannot be kept there. Confirm delete: ${over.length === 1 ? 'it' : 'they'} will be deleted for good and cannot be restored. You can change the limit in Settings.`,
          ok: 'Delete for good',
          danger: true,
        });
        if (ok) {
          await this.shell.fs.remove(over.map(o => o.path));
          this.shell.toast(`Deleted ${plural(over.length, 'item')} for good.`);
          done.gone = over.length;
          done.kept -= over.length;
        }
      }
      if (!toBin.length) return done;
      const { slots, failures } = await this.shell.bin.put(toBin);
      done.binned = slots.length;
      done.kept -= slots.length;
      if (slots.length) {
        // The one that went: not allowed[0], which may have been too big for the Bin, nor one that failed to move.
        const moved = slots.length === 1 ? (toBin.find(p => !failures.some(f => f.name === baseName(p))) ?? toBin[0]) : '';
        this.shell.toast(
          slots.length === 1 ? `Moved “${baseName(moved)}” to the Recycle Bin.` : `Moved ${plural(slots.length, 'item')} to the Recycle Bin.`,
          { label: 'Undo', run: () => void this.restoreFromBin(slots) },
        );
      }
      if (failures.length) await this.failed('Some items could not be deleted', failures);
    } catch (error) {
      await this.shell.report('Could not delete', error);
    }
    return done;
  }

  /** Total bytes in a file, or in everything inside a folder. */
  async treeSize(path: string): Promise<number> {
    const entry = await this.shell.fs.stat(path);
    if (!entry) return 0;
    if (entry.kind === 'file') return entry.size;
    let total = 0;
    for (const child of await this.shell.fs.list(path, true)) total += await this.treeSize(joinPath(path, child.name));
    return total;
  }

  /** Items over the Recycle Bin's size limit are set apart: they need a yes before they are deleted for good. */
  async splitByLimit(paths: string[]): Promise<{ toBin: string[]; over: Array<{ path: string; size: number }> }> {
    const limit = this.shell.session.data.bin.limitMb * 1024 * 1024;
    const toBin: string[] = [];
    const over: Array<{ path: string; size: number }> = [];
    for (const path of paths) {
      const size = await this.treeSize(path);
      if (size > limit) over.push({ path, size });
      else toBin.push(path);
    }
    return { toBin, over };
  }

  async restoreFromBin(slots: string[]): Promise<void> {
    try {
      const { restored, failures } = await this.shell.bin.restore(slots);
      const moved = restored.filter(r => r.fallback);
      if (moved.length) {
        await this.shell.dialogs.alert(
          'Restored to a different folder',
          `The original folder of ${moved.map(m => `“${m.name}”`).join(', ')} is gone, so it was put in ${moved[0].to.slice(1)}.`,
        );
      } else if (restored.length) {
        this.shell.toast(restored.length === 1 ? `Restored “${restored[0].name}”.` : `Restored ${plural(restored.length, 'item')}.`);
      }
      if (failures.length) await this.failed('Some items could not be restored', failures);
    } catch (error) {
      await this.shell.report('Could not restore', error);
    }
  }

  // ---- Cut, copy, paste, move ----------------------------------------------------------------------------------

  setClipboard(mode: 'copy' | 'cut', paths: string[]): void {
    // Copying leaves the original as it was, so a standard folder (Documents...) may be copied; only the top folder and
    // the desktop's own System folder may not. Cut moves, so it takes only what may be moved.
    const why = (p: string) => (mode === 'cut' ? protectedReason(p) : copyReason(p));
    const usable = paths.filter(p => !why(p));
    this.shell.clipboard = usable.length ? { mode, paths: usable } : null;
    this.shell.clipboardChanged.emit();
    if (!usable.length && paths.length) void this.shell.dialogs.alert(mode === 'cut' ? 'Nothing to cut' : 'Nothing to copy', why(paths[0]) ?? 'That cannot be copied.');
  }

  async paste(destFolder: string): Promise<void> {
    const clip = this.shell.clipboard;
    if (!clip) return;
    const refused = destinationReason(destFolder);
    if (refused) {
      await this.shell.dialogs.alert('Cannot paste here', refused);
      return;
    }
    try {
      if (clip.mode === 'copy') {
        await this.shell.fs.copy(clip.paths, destFolder);
      } else {
        // What could not be moved stays on the clipboard, ready to paste again; what moved (or was skipped) leaves it.
        const { left } = await this.moveInto(clip.paths, destFolder);
        if (this.shell.clipboard === clip) {
          this.shell.clipboard = left.length ? { mode: 'cut', paths: left } : null;
          this.shell.clipboardChanged.emit();
        }
      }
    } catch (error) {
      await this.shell.report('Could not paste', error);
    }
  }

  /**
   * Moves paths into a folder, one at a time so one failure does not stop the rest. A name already taken there is never
   * replaced: the person is asked first whether to keep both (the moved item gets " (2)" added, in the same change as
   * the move, so it is never renamed where it stood) or to skip those items. Returns the paths that were not moved
   * because something went wrong (or the question was cancelled), for the clipboard to keep.
   */
  async moveInto(paths: string[], destFolder: string): Promise<{ left: string[] }> {
    const fs = this.shell.fs;
    const refused = destinationReason(destFolder);
    if (refused) {
      await this.shell.dialogs.alert('Cannot move there', refused);
      return { left: [...paths] };
    }
    const failures: Failure[] = [];
    const left: string[] = [];
    const todo: string[] = [];
    for (const path of paths) {
      const reason = protectedReason(path);
      if (reason) {
        failures.push({ name: baseName(path), reason });
        left.push(path);
      } else if (nameKey(parentPath(path)) !== nameKey(joinPath(destFolder))) {
        todo.push(path);
      }
    }
    let skip = new Set<string>();
    let taken: string[] = [];
    try {
      taken = (await fs.list(destFolder, true)).map(e => nameKey(e.name));
    } catch {
      // The move itself will say what is wrong with the folder.
    }
    const clashing = todo.filter(p => taken.includes(nameKey(baseName(p))));
    if (clashing.length) {
      const where = destFolder === '/' ? 'This desktop' : `“${baseName(destFolder)}”`;
      const named = clashing.slice(0, 5).map(p => `“${baseName(p)}”`).join(', ') + (clashing.length > 5 ? ` and ${clashing.length - 5} more` : '');
      const one = clashing.length === 1;
      const answer = await this.shell.dialogs.ask<'keep' | 'skip' | 'cancel'>({
        title: 'Name already taken',
        text: `${where} already has something called ${named}. Keep both (the one moved gets a number added, nothing is replaced), or skip ${one ? 'it' : 'those'} and move the rest?`,
        buttons: [
          { label: 'Keep both', value: 'keep', primary: true },
          { label: one ? 'Skip it' : 'Skip those', value: 'skip' },
          { label: 'Cancel', value: 'cancel' },
        ],
        cancel: 'cancel',
      });
      if (answer !== 'keep' && answer !== 'skip') return { left: [...paths] };
      if (answer === 'skip') skip = new Set(clashing);
    }
    const renamed: string[] = [];
    for (const path of todo) {
      if (skip.has(path)) continue;
      const name = baseName(path);
      try {
        const [placed] = await fs.move([path], destFolder, { keepBoth: true });
        if (placed && placed.name !== name) renamed.push(`“${name}” is now “${placed.name}”`);
      } catch (error) {
        failures.push({ name, reason: describeError(error) });
        left.push(path);
      }
    }
    if (renamed.length) this.shell.toast(renamed.length === 1 ? `Moved: ${renamed[0]}.` : `Moved ${plural(renamed.length, 'item')} under new names.`);
    if (failures.length) await this.failed('Some items could not be moved', failures);
    return { left };
  }

  // ---- Properties ----------------------------------------------------------------------------------------------

  async properties(path: string): Promise<void> {
    const entry = await this.shell.fs.stat(path);
    if (!entry) {
      await this.shell.dialogs.alert('Not there any more', 'This item may have been moved or deleted in another window.');
      return;
    }
    let size = entry.kind === 'file' ? formatSize(entry.size) : '';
    if (entry.kind === 'folder') {
      const count = (await this.shell.fs.list(path, true)).length;
      size = plural(count, 'item') + ' inside';
    }
    const rows: Array<[string, string]> = [
      ['Type', fileTypeOf(entry.name, entry.kind).label],
      ['Location', parentPath(path)],
      ['Size', size],
      ['Modified', formatDate(entry.modified)],
    ];
    await this.shell.dialogs.ask<true>({
      title: entry.name,
      body: h('dl', { class: 'props' }, ...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
      buttons: [{ label: 'OK', value: true, primary: true }],
      cancel: true,
    });
  }
}
