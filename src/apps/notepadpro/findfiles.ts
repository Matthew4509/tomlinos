// Find in files for Notepad Pro: searches every text file under a folder (and its folders), plain or as a pattern
// (regular expression). Caps keep a huge folder from freezing the page: files over 2 MB, more than 2,000 files or
// 1,000 matches stop the search and say so.
import type { FileSystem } from '../../fs/fs.ts';
import { joinPath } from '../../fs/names.ts';

export interface FindOptions {
  matchCase: boolean;
  regex: boolean;
}

export interface Hit {
  /** 1-based. */
  line: number;
  col: number;
  /** Offsets in the whole text. */
  start: number;
  end: number;
  /** The line the match is on (cut to 200 letters). */
  text: string;
}

export interface FileHits {
  path: string;
  hits: Hit[];
}

export const MAX_FILE = 2 * 1024 * 1024;
export const MAX_FILES = 2000;
export const MAX_HITS = 1000;

export function makePattern(query: string, options: FindOptions): RegExp {
  const flags = options.matchCase ? 'gm' : 'gim';
  if (!options.regex) return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  try {
    return new RegExp(query, flags + 'u');
  } catch (error) {
    throw new Error(`The search pattern is not valid: ${(error as Error).message.replace(/^Invalid regular expression: /, '')}`);
  }
}

export function searchText(text: string, query: string, options: FindOptions, limit = MAX_HITS): Hit[] {
  if (!query) return [];
  const re = makePattern(query, options);
  const hits: Hit[] = [];
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && hits.length < limit) {
    if (m[0] === '') {
      // An empty match (a pattern like "a*") is skipped, and the search moves on, so it cannot loop forever.
      re.lastIndex++;
      continue;
    }
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= m.index) lo = mid;
      else hi = mid - 1;
    }
    const lineEnd = text.indexOf('\n', m.index);
    hits.push({ line: lo + 1, col: m.index - lineStarts[lo] + 1, start: m.index, end: m.index + m[0].length, text: text.slice(lineStarts[lo], lineEnd < 0 ? undefined : lineEnd).replace(/\r$/, '').slice(0, 200) });
  }
  return hits;
}

/** Files whose names say they are text (the same list the text apps open). */
const TEXT_EXT = /\.(txt|md|markdown|log|ini|cfg|conf|json|xml|html?|js|mjs|cjs|ts|tsx|jsx|css|scss|php|py|rb|go|rs|java|c|h|cpp|hpp|cs|sh|bash|ps1|bat|sql|ya?ml|toml|csv|tsv|s|asm|ics|vcf|url|svg)$/i;

export function isTextName(name: string): boolean {
  return TEXT_EXT.test(name);
}

export interface FolderSearch {
  results: FileHits[];
  files: number;
  skipped: number;
  /** Why the search stopped early, if it did. */
  stopped: string | null;
}

/** Searches `folder` and every folder inside it. `onFile` sees each file with matches as it is found. */
export async function findInFolder(fs: FileSystem, folder: string, query: string, options: FindOptions, signal: AbortSignal, onFile?: (f: FileHits) => void): Promise<FolderSearch> {
  makePattern(query, options); // a bad pattern is reported before any reading
  const out: FolderSearch = { results: [], files: 0, skipped: 0, stopped: null };
  let total = 0;
  const walk = async (path: string): Promise<boolean> => {
    for (const e of await fs.list(path)) {
      if (signal.aborted) return false;
      const child = joinPath(path, e.name);
      if (e.kind === 'folder') {
        if (!(await walk(child))) return false;
        continue;
      }
      if (!isTextName(e.name)) continue;
      if (e.size > MAX_FILE) {
        out.skipped++;
        continue;
      }
      if (++out.files > MAX_FILES) {
        out.stopped = `Stopped after ${MAX_FILES} files. Search a smaller folder to see the rest.`;
        return false;
      }
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(child));
      } catch {
        out.skipped++;
        continue;
      }
      const hits = searchText(text, query, options, MAX_HITS - total);
      if (hits.length) {
        const found = { path: child, hits };
        out.results.push(found);
        onFile?.(found);
        total += hits.length;
        if (total >= MAX_HITS) {
          out.stopped = `Stopped at ${MAX_HITS} matches. Make the search narrower to see the rest.`;
          return false;
        }
      }
    }
    return true;
  };
  await walk(folder);
  return out;
}
