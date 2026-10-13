// The computer's real files, in the shape the spreadsheet already uses for the desktop's files. Paths stay in the
// desktop's form inside the page ("/C:/Users/Ann/Documents/Budget.xlsx", a network share as "/UNC/server/share/...")
// so the spreadsheet's own path helpers work unchanged; they become Windows paths only on the way to the program.
// "/System/<name>" is a setting, kept in the program's folder under the person's AppData.
import { FileChanged, FsError } from '../../src/fs/errors.ts';
import type { Entry } from '../../src/fs/fs.ts';
import { invoke } from './tauri.ts';

interface Stat { name: string; kind: 'file' | 'folder'; size: number; modified: number; id: string }

const SETTINGS = '/System/';

/** "/C:/Users/Ann/x.xlsx" -> "C:\Users\Ann\x.xlsx"; "/UNC/server/share/x" -> "\\server\share\x". */
export function toWindows(path: string): string {
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'UNC') return `\\\\${parts.slice(1).join('\\')}`;
  if (parts.length === 1 && /^[A-Za-z]:$/.test(parts[0])) return `${parts[0]}\\`;
  return parts.join('\\');
}

/** "C:\Users\Ann\x.xlsx" -> "/C:/Users/Ann/x.xlsx"; "\\server\share\x" -> "/UNC/server/share/x". */
export function fromWindows(path: string): string {
  if (path.startsWith('\\\\')) return '/UNC/' + path.slice(2).split(/[\\/]+/).filter(Boolean).join('/');
  return '/' + path.split(/[\\/]+/).filter(Boolean).join('/');
}

function entryOf(s: Stat): Entry {
  return { name: s.name, id: s.id, kind: s.kind, size: s.size, modified: s.modified };
}

/** The program answers in words already ("... is open in another program ..."): shown as they are. */
function asFsError(error: unknown): FsError {
  return new FsError(typeof error === 'string' ? error : error instanceof Error ? error.message : 'Windows could not do that. Nothing was changed.');
}

function decode(base64: string): Uint8Array {
  const text = atob(base64);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return bytes;
}

function encode(bytes: Uint8Array): string {
  let text = '';
  // In slices: String.fromCharCode with a whole 20 MB file at once runs out of stack.
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

export class NativeFiles {
  async stat(path: string): Promise<Entry | null> {
    if (path.startsWith(SETTINGS)) return null;
    const s = await invoke<Stat | null>('stat', { path: toWindows(path) });
    return s ? entryOf(s) : null;
  }

  async exists(path: string): Promise<boolean> {
    return (await this.stat(path)) !== null;
  }

  async readFile(path: string): Promise<Uint8Array> {
    try {
      return decode(await invoke<string>('read_file', { path: toWindows(path) }));
    } catch (error) {
      throw asFsError(error);
    }
  }

  async readText(path: string): Promise<string> {
    if (path.startsWith(SETTINGS)) {
      const text = await invoke<string | null>('read_setting', { name: path.slice(SETTINGS.length) }).catch(error => {
        throw asFsError(error);
      });
      if (text === null) throw new FsError('That setting has not been kept yet.');
      return text;
    }
    return new TextDecoder('utf-8').decode(await this.readFile(path));
  }

  async writeFile(path: string, data: Uint8Array, options: { replacing?: string; mustBeNew?: boolean; hidden?: boolean } = {}): Promise<Entry> {
    if (path.startsWith(SETTINGS)) {
      await this.writeText(path, new TextDecoder().decode(data));
      return { name: path.slice(SETTINGS.length), id: String(Date.now()), kind: 'file', size: data.length, modified: Date.now() };
    }
    if (options.mustBeNew && (await this.stat(path))) throw new FsError(`There is already a file called “${path.split('/').pop()}” there.`);
    try {
      return entryOf(await invoke<Stat>('write_file', { path: toWindows(path), data: encode(data), replacing: options.replacing ?? null }));
    } catch (error) {
      if (typeof error === 'string' && error.startsWith('CHANGED:')) throw new FileChanged(path.split('/').pop() ?? '', error.slice('CHANGED:'.length));
      throw asFsError(error);
    }
  }

  async writeText(path: string, text: string, options?: { replacing?: string; mustBeNew?: boolean; hidden?: boolean }): Promise<Entry> {
    if (path.startsWith(SETTINGS)) {
      try {
        await invoke('write_setting', { name: path.slice(SETTINGS.length), text });
      } catch (error) {
        throw asFsError(error);
      }
      return { name: path.slice(SETTINGS.length), id: String(Date.now()), kind: 'file', size: text.length, modified: Date.now() };
    }
    return this.writeFile(path, new TextEncoder().encode(text), options);
  }

  async list(path: string): Promise<Entry[]> {
    try {
      return (await invoke<Stat[]>('list', { path: toWindows(path) })).map(entryOf);
    } catch (error) {
      throw asFsError(error);
    }
  }
}
