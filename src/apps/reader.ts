// Reader: the book reader (public/reader/, the same one the front page and the lock screen show), in a window, for a
// signed-in person. Here it also has the Gutenberg library (server/api/books.php) and My books: this window answers
// the Reader's handshake, so its Save button says "Save to TOMLIN OS" and each saved book is a text file in
// Documents › Books, listed in a hidden index (/System/reader-books.json) with where it came from. Only this window's
// own frame is answered: the lock screen's Reader gets nothing, so a locked screen shows no saved books.
import { h, on } from '../core/dom.ts';
import { joinPath, uniqueName } from '../fs/names.ts';
import type { AppDef } from '../shell/types.ts';
import { APPS } from './catalog.ts';

export const BOOKS_FOLDER = '/Documents/Books';
export const SHELF_PATH = '/System/reader-books.json';
/** Where each Gutenberg book was left (chapter, how far through), kept with the person's files, not in the browser. */
export const PLACES_PATH = '/System/reader-places.json';
const PLACES_MAX = 500;

interface SavedBook {
  id: number;
  title: string;
  author: string;
  years: string;
  genres: string[];
  saved: number;
  /** The book's text file in Documents › Books. */
  path: string;
}

/** A file name for a book: its title and author, without characters a file name cannot hold, at most 100 letters. */
export function bookFileName(title: string, author: string): string {
  const base = `${title} - ${author}`.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100).trim();
  return `${base || 'Book'}.txt`;
}

/** Only rows that make sense: a Gutenberg number, a title, a path in Documents › Books. */
export function cleanShelf(raw: unknown): SavedBook[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r: Partial<SavedBook>) => {
    const id = Number(r?.id);
    const path = String(r?.path ?? '');
    if (!Number.isInteger(id) || id < 1 || !r?.title || !path.startsWith(`${BOOKS_FOLDER}/`)) return [];
    return [{ id, title: String(r.title).slice(0, 300), author: String(r.author ?? '').slice(0, 200), years: String(r.years ?? '').slice(0, 40), genres: Array.isArray(r.genres) ? r.genres.map(String).slice(0, 8) : [], saved: Number(r.saved) || 0, path }];
  });
}

export const readerApp: AppDef = {
  ...APPS.reader,
  async launch(app, arg) {
    const { shell, signal } = app;
    const fs = shell.fs;
    app.root.classList.add('reader-app');
    // "library" opens the Gutenberg library; "work:<author>:<work>" one book (a store app asks for that, storeapp.ts).
    const book = /^work:([a-z0-9-]{1,80}):([a-z0-9-]{0,80})$/.exec(arg ?? '');
    const query = arg === 'library' ? '?author=gutenberg' : book ? `?${new URLSearchParams(book[2] ? { author: book[1], work: book[2] } : { author: book[1] })}` : '';
    const frame = h('iframe', { class: 'reader-app-frame', src: `reader/index.html${query}`, title: 'Reader' });
    app.root.append(frame);

    async function readShelf(): Promise<SavedBook[]> {
      try {
        return cleanShelf(JSON.parse(await fs.readText(SHELF_PATH)));
      } catch {
        return [];
      }
    }
    async function writeShelf(list: SavedBook[]): Promise<void> {
      await fs.ensureFolder('/System', { hidden: true });
      await fs.writeText(SHELF_PATH, JSON.stringify(list, null, 1), { hidden: true });
    }

    async function readPlaces(): Promise<Record<string, { chapter: number; ratio: number }>> {
      try {
        const raw = JSON.parse(await fs.readText(PLACES_PATH));
        return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
      } catch {
        return {};
      }
    }

    async function save(book: Record<string, unknown>): Promise<void> {
      const id = Number(book.id);
      const text = typeof book.text === 'string' ? book.text : '';
      if (!Number.isInteger(id) || id < 1 || !text) throw new Error('that book did not arrive whole');
      const list = await readShelf();
      const had = list.find(b => b.id === id);
      await fs.ensureFolder('/Documents');
      await fs.ensureFolder(BOOKS_FOLDER);
      let path = had?.path;
      if (!path) {
        const names = (await fs.list(BOOKS_FOLDER)).map(e => e.name);
        path = joinPath(BOOKS_FOLDER, uniqueName(bookFileName(String(book.title ?? ''), String(book.author ?? '')), names));
      }
      await fs.writeText(path, text);
      const row: SavedBook = cleanShelf([{ ...book, id, saved: Date.now(), path }])[0];
      await writeShelf([...list.filter(b => b.id !== id), row]);
    }

    on(window, 'message', (e: MessageEvent) => {
      if (e.source !== frame.contentWindow || e.origin !== location.origin) return;
      const d = (e.data ?? {}) as Record<string, unknown>;
      const reply = (answer: Record<string, unknown>) => frame.contentWindow?.postMessage({ rid: d.rid, ...answer }, location.origin);
      const fail = (error: unknown) => reply({ error: error instanceof Error ? error.message : String(error) });
      if (d.type === 'reader-hello') {
        frame.contentWindow?.postMessage({ type: 'reader-host', name: 'TOMLIN OS' }, location.origin);
      } else if (d.type === 'reader-save') {
        save((d.book ?? {}) as Record<string, unknown>).then(() => reply({ ok: true }), fail);
      } else if (d.type === 'reader-shelf') {
        readShelf().then(books => reply({ books: books.map(({ path, ...rest }) => rest) }), fail);
      } else if (d.type === 'reader-load') {
        readShelf().then(async list => {
          const b = list.find(x => x.id === Number(d.id));
          reply({ text: b ? await fs.readText(b.path) : null });
        }).catch(fail);
      } else if (d.type === 'reader-remove') {
        readShelf().then(async list => {
          const b = list.find(x => x.id === Number(d.id));
          // The text file goes to the Recycle Bin, so a removal can be undone from there.
          if (b) await shell.actions.deleteToBin([b.path]).catch(() => undefined);
          await writeShelf(list.filter(x => x.id !== Number(d.id)));
          reply({ ok: true });
        }).catch(fail);
      } else if (d.type === 'reader-place-get' || d.type === 'reader-place-set') {
        const id = String(d.id ?? '');
        if (!/^pg-\d{1,7}$/.test(id)) return fail(new Error('not a book'));
        readPlaces().then(async all => {
          if (d.type === 'reader-place-get') return reply({ place: all[id] ?? null });
          const p = (d.place ?? {}) as { chapter?: unknown; ratio?: unknown };
          const chapter = Number(p.chapter);
          const ratio = Number(p.ratio);
          if (!Number.isInteger(chapter) || chapter < 0 || !(ratio >= 0 && ratio <= 1)) return fail(new Error('not a place'));
          delete all[id];
          all[id] = { chapter, ratio };
          // Only the most recent books are kept.
          const keep = Object.fromEntries(Object.entries(all).slice(-PLACES_MAX));
          await fs.ensureFolder('/System', { hidden: true });
          await fs.writeText(PLACES_PATH, JSON.stringify(keep), { hidden: true });
          reply({ ok: true });
        }).catch(fail);
      } else if (d.type === 'reader-close') app.close();
    }, signal);
  },
};
