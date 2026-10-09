// Moving files between the computer and the desktop: upload (files, or whole folders by drop or pick) and download
// (a file as it is, folders and several items as one zip). Both show a progress panel with a Cancel button.
// Nothing is ever replaced: a taken name gets " (2)". Files are held in memory while they move, so there is a
// size limit that says why, instead of the page running out of memory on a small device.
import { h, on } from '../core/dom.ts';
import { formatSize, plural } from '../core/format.ts';
import { zipStore, type ZipEntry } from '../core/zip.ts';
import { cleanName, joinPath, nameKey, splitPath, uniqueName } from '../fs/names.ts';
import { describeError } from './dialogs.ts';
import type { Failure } from './trash.ts';
import type { Shell } from './types.ts';

export const MAX_FILE_BYTES = 200 * 1024 * 1024;
export const MAX_DOWNLOAD_BYTES = 300 * 1024 * 1024;
export const MAX_ITEMS = 10000;
const MAX_DEPTH = 24;

/** One thing picked or dropped: a file (parts = folders then its own name) or an empty-or-not folder (parts = its path). */
export type Picked = { kind: 'file'; parts: string[]; file: File } | { kind: 'dir'; parts: string[] };

// ---- Working out names (pure, so it can be tested without a browser) --------------------------------------------

export interface UploadPlan {
  /** Folders to create, parents before children, as clean paths under the destination. */
  dirs: string[][];
  /** Where each picked file goes (a clean path under the destination, ending in its own name), by index into the input. */
  files: Array<{ index: number; parts: string[] }>;
}

/** Gives every picked item a name that is valid and not taken (by what is already there, or by another picked item). */
export function planUpload(existing: string[], items: Array<{ kind: 'file' | 'dir'; parts: string[] }>): UploadPlan {
  const used = new Map<string, string[]>([['', [...existing]]]);
  const dirMap = new Map<string, string[]>();
  const dirs: string[][] = [];
  const keyOf = (parts: string[]) => parts.map(nameKey).join('\0');
  const claim = (parent: string[], wanted: string): string => {
    const list = used.get(keyOf(parent)) ?? [];
    const name = uniqueName(cleanName(wanted), list);
    list.push(name);
    used.set(keyOf(parent), list);
    return name;
  };
  const resolve = (original: string[]): string[] => {
    let clean: string[] = [];
    for (let i = 0; i < original.length; i++) {
      const prefix = original.slice(0, i + 1).join('\0');
      const known = dirMap.get(prefix);
      if (known) {
        clean = known;
        continue;
      }
      clean = [...clean, claim(clean, original[i])];
      dirMap.set(prefix, clean);
      dirs.push(clean);
    }
    return clean;
  };
  const files: UploadPlan['files'] = [];
  items.forEach((item, index) => {
    if (item.kind === 'dir') {
      resolve(item.parts);
      return;
    }
    const parent = resolve(item.parts.slice(0, -1));
    files.push({ index, parts: [...parent, claim(parent, item.parts[item.parts.length - 1])] });
  });
  return { dirs, files };
}

// ---- Collecting what was picked or dropped ----------------------------------------------------------------------

/** Files from a file picker. A folder picker gives each file its path inside the folder. */
export function pickedFromInput(files: FileList | File[]): Picked[] {
  return [...files].map(file => {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    return { kind: 'file', file, parts: rel ? rel.split('/').filter(Boolean) : [file.name] };
  });
}

interface FsEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?(ok: (f: File) => void, fail: (e: unknown) => void): void;
  createReader?(): { readEntries(ok: (list: FsEntry[]) => void, fail: (e: unknown) => void): void };
}

/**
 * Everything in a drop, folders included. Must be called straight from the drop event: the browser only hands out
 * the folder entries during it, so the first step (reading the entries) is done before anything is awaited.
 */
export function collectDrop(data: DataTransfer): Promise<{ picked: Picked[]; problems: Failure[] }> {
  const entries: FsEntry[] = [];
  let unsupported = false;
  for (const item of [...data.items]) {
    if (item.kind !== 'file') continue;
    const entry = (item as DataTransferItem & { webkitGetAsEntry?(): FsEntry | null }).webkitGetAsEntry?.();
    if (entry) entries.push(entry);
    else unsupported = true;
  }
  const plainFiles = unsupported || entries.length === 0 ? [...data.files] : [];
  return (async () => {
    const picked: Picked[] = pickedFromInput(plainFiles);
    const problems: Failure[] = [];
    let count = 0;
    const walk = async (entry: FsEntry, parent: string[], depth: number): Promise<void> => {
      if (count >= MAX_ITEMS) return;
      const parts = [...parent, entry.name];
      try {
        if (entry.isFile && entry.file) {
          const file = await new Promise<File>((ok, fail) => entry.file!(ok, fail));
          picked.push({ kind: 'file', parts, file });
          count++;
        } else if (entry.isDirectory && entry.createReader) {
          if (depth >= MAX_DEPTH) {
            problems.push({ name: parts.join('/'), reason: `Folders inside folders more than ${MAX_DEPTH} deep are not uploaded.` });
            return;
          }
          picked.push({ kind: 'dir', parts });
          count++;
          const reader = entry.createReader();
          for (;;) {
            const batch = await new Promise<FsEntry[]>((ok, fail) => reader.readEntries(ok, fail));
            if (!batch.length) break;
            for (const child of batch) await walk(child, parts, depth + 1);
          }
        }
      } catch {
        problems.push({ name: parts.join('/'), reason: 'The browser could not read it.' });
      }
    };
    for (const entry of entries) await walk(entry, [], 0);
    if (count >= MAX_ITEMS) problems.push({ name: 'Too many items', reason: `Only the first ${MAX_ITEMS} items were taken. Upload the rest in a second go.` });
    return { picked, problems };
  })();
}

// ---- The progress panel -----------------------------------------------------------------------------------------

export class Job {
  readonly signal: AbortSignal;
  private controller = new AbortController();
  private bar: HTMLProgressElement;
  private line: HTMLElement;
  private cancelBtn: HTMLButtonElement;
  private el: HTMLElement;

  constructor(host: HTMLElement, title: string) {
    this.signal = this.controller.signal;
    this.bar = h('progress', { max: 1, value: 0, 'aria-label': title });
    this.line = h('div', { class: 'transfer-line' });
    this.cancelBtn = h('button', { type: 'button', class: 'btn' }, 'Cancel');
    this.el = h('div', { class: 'transfer', role: 'group', 'aria-label': title }, h('div', { class: 'transfer-title' }, title), this.bar, this.line, this.cancelBtn);
    on(this.cancelBtn, 'click', () => {
      this.controller.abort();
      this.cancelBtn.disabled = true;
      this.line.textContent = 'Stopping...';
    }, new AbortController().signal);
    host.append(this.el);
  }

  progress(text: string, fraction: number): void {
    this.bar.value = Math.max(0, Math.min(1, fraction));
    this.line.textContent = text;
  }

  end(): void {
    this.el.remove();
  }
}

// ---- Upload and download ----------------------------------------------------------------------------------------

async function readWhole(file: File, signal: AbortSignal, onBytes: (n: number) => void): Promise<Uint8Array | null> {
  const out = new Uint8Array(file.size);
  let at = 0;
  const reader = file.stream().getReader();
  for (;;) {
    if (signal.aborted) {
      await reader.cancel();
      return null;
    }
    const { done, value } = await reader.read();
    if (done) break;
    if (at + value.length > out.length) throw new Error('The file grew while it was being read.');
    out.set(value, at);
    at += value.length;
    onBytes(value.length);
  }
  return at === out.length ? out : out.subarray(0, at);
}

export class Transfers {
  private shell: Shell;
  private host: HTMLElement;

  constructor(shell: Shell, host: HTMLElement) {
    this.shell = shell;
    this.host = host;
  }

  /** Opens the computer's file (or folder) picker; what is chosen is uploaded into `dest`. */
  choose(kind: 'files' | 'folder', dest: string): void {
    const input = h('input', { type: 'file', class: 'visually-hidden', tabindex: -1, 'aria-hidden': 'true' });
    if (kind === 'files') input.multiple = true;
    else input.setAttribute('webkitdirectory', '');
    const done = new AbortController();
    on(input, 'change', () => {
      const chosen = pickedFromInput(input.files ?? []);
      done.abort();
      input.remove();
      if (chosen.length) void this.upload(chosen, dest);
    }, done.signal);
    on(input, 'cancel', () => {
      done.abort();
      input.remove();
    }, done.signal);
    document.body.append(input);
    input.click();
  }

  async upload(picked: Picked[], destFolder: string, problems: Failure[] = []): Promise<void> {
    const failures: Failure[] = [...problems];
    let saved = 0;
    const job = new Job(this.host, 'Uploading');
    try {
      const fs = this.shell.fs;
      const taken = (await fs.list(destFolder, true)).map(e => e.name);
      const plan = planUpload(taken, picked);
      const total = picked.reduce((n, p) => n + (p.kind === 'file' ? p.file.size : 0), 0) || 1;
      let done = 0;
      const broken = new Set<string>();
      const key = (parts: string[]) => parts.join('\0');
      for (const dir of plan.dirs) {
        if (job.signal.aborted) break;
        if (broken.has(key(dir.slice(0, -1)))) {
          broken.add(key(dir));
          continue;
        }
        try {
          await fs.mkdir(joinPath(destFolder, ...dir));
        } catch (error) {
          broken.add(key(dir));
          failures.push({ name: dir.join('/'), reason: describeError(error) });
        }
      }
      let n = 0;
      for (const target of plan.files) {
        if (job.signal.aborted) break;
        n++;
        const item = picked[target.index];
        if (item.kind !== 'file') continue;
        const label = target.parts.join('/');
        const parent = target.parts.slice(0, -1);
        if (broken.has(key(parent))) continue;
        job.progress(`${n} of ${plan.files.length}: ${label}`, done / total);
        if (item.file.size > MAX_FILE_BYTES) {
          failures.push({ name: label, reason: `It is ${formatSize(item.file.size)}. Files over ${formatSize(MAX_FILE_BYTES)} cannot be kept here yet.` });
          done += item.file.size;
          continue;
        }
        try {
          const bytes = await readWhole(item.file, job.signal, len => {
            done += len;
            job.progress(`${n} of ${plan.files.length}: ${label}`, done / total);
          });
          if (!bytes) break;
          await fs.writeFile(joinPath(destFolder, ...target.parts), bytes, { mustBeNew: true });
          saved++;
        } catch (error) {
          failures.push({ name: label, reason: describeError(error) });
        }
      }
      if (job.signal.aborted) {
        this.shell.toast(saved ? `Stopped. ${plural(saved, 'file')} saved before that; the rest were not.` : 'Stopped. Nothing was saved.');
      } else if (saved) {
        this.shell.toast(`Saved ${plural(saved, 'file')}.`);
      }
    } catch (error) {
      failures.push({ name: 'Upload', reason: describeError(error) });
    } finally {
      job.end();
    }
    if (failures.length) {
      const shown = failures.slice(0, 5).map(f => `“${f.name}”: ${f.reason}`);
      if (failures.length > 5) shown.push(`...and ${failures.length - 5} more.`);
      await this.shell.dialogs.alert('Some things could not be uploaded', shown.join('\n'), 'Everything else that was picked was saved.');
    }
  }

  /** Downloads one file as it is; a folder, or several items, as one zip. */
  async download(paths: string[]): Promise<void> {
    const fs = this.shell.fs;
    const usable = paths.filter(p => splitPath(p).length > 0 && nameKey(splitPath(p)[0]) !== 'system');
    if (!usable.length) {
      await this.shell.dialogs.alert('Nothing to download', 'The desktop\'s own System folder, and the top folder itself, cannot be downloaded.');
      return;
    }
    const job = new Job(this.host, 'Preparing download');
    try {
      const entries = await Promise.all(usable.map(p => fs.stat(p)));
      if (usable.length === 1 && entries[0]?.kind === 'file') {
        const bytes = await this.readForDownload(usable[0], entries[0].size, job);
        if (bytes) this.save(entries[0].name, bytes);
        return;
      }
      const total = (await Promise.all(usable.map(p => this.shell.actions.treeSize(p)))).reduce((a, b) => a + b, 0);
      if (total > MAX_DOWNLOAD_BYTES) {
        await this.shell.dialogs.alert(
          'Too big to download in one go',
          `These items add up to ${formatSize(total)}. One download can hold up to ${formatSize(MAX_DOWNLOAD_BYTES)}.`,
          'Download a few of them at a time, or the files inside a folder.',
        );
        return;
      }
      const zip: ZipEntry[] = [];
      let done = 0;
      const add = async (path: string, name: string, kind: 'file' | 'folder', modified: number, size: number): Promise<boolean> => {
        if (job.signal.aborted) return false;
        if (zip.length >= 0xfff0) throw new Error('Too many items for one zip file.');
        if (kind === 'folder') {
          zip.push({ name: `${name}/`, modified });
          for (const child of await fs.list(path, true)) {
            if (!(await add(joinPath(path, child.name), `${name}/${child.name}`, child.kind, child.modified, child.size))) return false;
          }
          return true;
        }
        job.progress(name, total ? done / total : 1);
        const bytes = await fs.readFile(path);
        done += size;
        zip.push({ name, data: bytes, modified });
        return true;
      };
      for (let i = 0; i < usable.length; i++) {
        const e = entries[i];
        if (!e) continue;
        if (!(await add(usable[i], e.name, e.kind, e.modified, e.size))) break;
      }
      if (job.signal.aborted) {
        this.shell.toast('Download cancelled.');
        return;
      }
      const only = entries.length === 1 ? entries[0] : null;
      this.save(only ? `${only.name}.zip` : 'TOMLIN OS download.zip', zipStore(zip));
    } catch (error) {
      await this.shell.report('Could not download', error);
    } finally {
      job.end();
    }
  }

  private async readForDownload(path: string, size: number, job: Job): Promise<Uint8Array | null> {
    if (size > MAX_DOWNLOAD_BYTES) {
      await this.shell.dialogs.alert('Too big to download in one go', `This file is ${formatSize(size)}. One download can hold up to ${formatSize(MAX_DOWNLOAD_BYTES)}.`);
      return null;
    }
    job.progress(splitPath(path).pop() ?? '', 0);
    return this.shell.fs.readFile(path);
  }

  /** Hands bytes to the browser as a download. Always typed as raw bytes, so nothing is ever shown or run as a page. */
  save(name: string, bytes: Uint8Array): void {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }));
    const link = h('a', { href: url, download: name, class: 'visually-hidden', tabindex: -1 });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    this.shell.toast(`Downloaded “${name}” (${formatSize(bytes.length)}).`);
  }
}
