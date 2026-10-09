// Finding files: walks the folders under a starting point and reports every item whose name holds the words, and
// (when asked) every text file whose contents do. Hidden items (the desktop's own settings, the Recycle Bin) are
// never searched. Reading contents is capped per file and in total, so a search never pulls a whole library down.
import type { FileSystem } from '../fs/fs.ts';
import { joinPath } from '../fs/names.ts';
import { fileTypeOf } from './filetypes.ts';

export interface SearchHit {
  path: string;
  name: string;
  kind: 'file' | 'folder';
  size: number;
  modified: number;
  /** A line of the file around the first match, when the match was inside it. */
  snippet?: string;
}

export interface SearchOptions {
  contents: boolean;
  signal: AbortSignal;
  onHit: (hit: SearchHit) => void;
  onProgress?: (folders: number) => void;
}

export const MAX_HITS = 500;
const MAX_CONTENT_FILE = 1024 * 1024;
const MAX_CONTENT_TOTAL = 64 * 1024 * 1024;
const CONTENT_TYPES = new Set(['Text document', 'Code or data file', 'RISC-V program', 'Spreadsheet', 'Calendar', 'Contacts', 'Web link']);

/** Lower-case words; an item matches when every word is found. */
export function searchWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
}

export function matchesAll(text: string, words: string[]): boolean {
  const lower = text.toLowerCase();
  return words.every(w => lower.includes(w));
}

/** The line holding the first word, trimmed to about 120 characters around it. */
export function snippetOf(text: string, words: string[]): string {
  const lower = text.toLowerCase();
  const at = lower.indexOf(words[0]);
  if (at < 0) return '';
  const lineStart = text.lastIndexOf('\n', at) + 1;
  const lineEnd = text.indexOf('\n', at);
  const line = text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
  const pos = at - lineStart;
  const from = Math.max(0, pos - 50);
  return (from > 0 ? '…' : '') + line.slice(from, from + 120).trim() + (line.length > from + 120 ? '…' : '');
}

/** Returns how many hits there were, and whether the search stopped at the limit. */
export async function searchFiles(fs: FileSystem, root: string, query: string, o: SearchOptions): Promise<{ hits: number; capped: boolean }> {
  const words = searchWords(query);
  if (!words.length) return { hits: 0, capped: false };
  let hits = 0;
  let read = 0;
  let folders = 0;
  const queue = [joinPath(root)];
  const decoder = new TextDecoder('utf-8', { fatal: false });
  while (queue.length) {
    if (o.signal.aborted) break;
    const folder = queue.shift()!;
    let entries;
    try {
      entries = await fs.list(folder);
    } catch {
      continue; // Moved or deleted while searching.
    }
    o.onProgress?.(++folders);
    for (const e of entries) {
      if (o.signal.aborted) break;
      const path = joinPath(folder, e.name);
      if (e.kind === 'folder') queue.push(path);
      const hit: SearchHit = { path, name: e.name, kind: e.kind, size: e.size, modified: e.modified };
      if (matchesAll(e.name, words)) {
        o.onHit(hit);
      } else if (o.contents && e.kind === 'file' && e.size <= MAX_CONTENT_FILE && read + e.size <= MAX_CONTENT_TOTAL && CONTENT_TYPES.has(fileTypeOf(e.name).label)) {
        read += e.size;
        let text: string;
        try {
          text = decoder.decode(await fs.readFile(path));
        } catch {
          continue;
        }
        if (!matchesAll(text, words)) continue;
        hit.snippet = snippetOf(text, words);
        o.onHit(hit);
      } else {
        continue;
      }
      if (++hits >= MAX_HITS) return { hits, capped: true };
    }
  }
  return { hits, capped: false };
}
