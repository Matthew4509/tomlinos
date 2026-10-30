// The Recycle Bin. Deleting moves things here; only emptying the bin (or deleting from inside it) destroys them,
// and both ask first. Each deleted item sits in its own slot folder under /System/Trash, keeping its name, and a
// small list (/System/trash.json) remembers where each one came from. If that list is lost, the slots are still
// there and are shown as "original location unknown"; nothing is lost with it.
import { FileChanged, FsError, type Entry, type FileSystem } from '../fs/fs.ts';
import { baseName, joinPath, parentPath, splitPath } from '../fs/names.ts';
import { newKey } from '../store/store.ts';

export const TRASH_DIR = '/System/Trash';
const META_PATH = '/System/trash.json';
const FALLBACK_FOLDER = '/Documents';

export interface BinItem {
  /** The slot's folder name; identifies the item in every call below. */
  slot: string;
  name: string;
  kind: 'file' | 'folder';
  size: number;
  /** Where it was deleted from, or '' when unknown. */
  from: string;
  deleted: number;
}

interface Meta {
  v: 1;
  items: Array<{ slot: string; name: string; from: string; deleted: number }>;
}

export interface Failure {
  name: string;
  reason: string;
}

export class RecycleBin {
  private fs: FileSystem;

  constructor(fs: FileSystem) {
    this.fs = fs;
  }

  private async readMeta(): Promise<Meta> {
    return (await this.readMetaWithId()).meta;
  }

  /**
   * The list and the id of the copy it came from ('' when there is none). Missing or damaged, it reads as empty: the
   * slots themselves are the source of truth. `strict` (before changing it): a list that is there but could not be read
   * (the server out of reach, say) throws instead, so the change is not written over it and every other item's
   * "deleted from" with it. For showing, it reads as empty for now.
   */
  private async readMetaWithId(strict = false): Promise<{ meta: Meta; id: string }> {
    let entry: Entry | null = null;
    let text: string | null = null;
    try {
      entry = await this.fs.stat(META_PATH);
      if (entry) text = await this.fs.readText(META_PATH);
    } catch (error) {
      if (strict && !(error instanceof FsError)) throw error;
    }
    try {
      const raw = text === null ? null : JSON.parse(text);
      if (raw && raw.v === 1 && Array.isArray(raw.items)) {
        return {
          id: entry?.id ?? '',
          meta: {
            v: 1,
            items: raw.items.filter(
              (i: any) => i && typeof i.slot === 'string' && typeof i.name === 'string' && typeof i.from === 'string' && typeof i.deleted === 'number',
            ),
          },
        };
      }
    } catch {
      // Damaged: a change may replace it.
    }
    return { meta: { v: 1, items: [] }, id: entry?.id ?? '' };
  }

  /**
   * Changes the list on top of the copy there now, so two deletes (or a delete and a restore) close together, in this
   * window or another, never drop each other's lines. A copy saved in between is read again and the change redone.
   */
  private async changeMeta(apply: (meta: Meta) => void): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      let read: { meta: Meta; id: string };
      try {
        read = await this.readMetaWithId(true);
      } catch (error) {
        // A read that failed tells nothing about the list, so it is read again rather than written over.
        if (attempt >= 5) throw error;
        continue;
      }
      const { meta, id } = read;
      apply(meta);
      try {
        await this.fs.writeText(META_PATH, JSON.stringify(meta), id ? { hidden: true, replacing: id } : { hidden: true, mustBeNew: true });
        return;
      } catch (error) {
        const raced = error instanceof FileChanged || (!id && error instanceof FsError && (await this.fs.stat(META_PATH)) !== null);
        if (!raced || attempt >= 5) throw error;
      }
    }
  }

  /** The slot folders, or none when the bin was never made. */
  private async slotFolders(): Promise<Entry[]> {
    try {
      return (await this.fs.list(TRASH_DIR, true)).filter(e => e.kind === 'folder');
    } catch (error) {
      if (error instanceof FsError) return [];
      throw error;
    }
  }

  private async ensureDir(): Promise<void> {
    await this.fs.ensureFolder('/System', { hidden: true });
    await this.fs.ensureFolder(TRASH_DIR, { hidden: true });
  }

  /** What is in the bin, newest first. */
  async list(): Promise<BinItem[]> {
    const slots = await this.slotFolders();
    const meta = await this.readMeta();
    const items: BinItem[] = [];
    for (const slot of slots) {
      const inside = (await this.fs.list(`${TRASH_DIR}/${slot.name}`, true))[0];
      if (!inside) {
        // An empty slot (a restore that moved its item out but could not tidy up) is removed when seen, so the count is right.
        await this.fs.remove([`${TRASH_DIR}/${slot.name}`]).catch(() => {});
        continue;
      }
      const info = meta.items.find(i => i.slot === slot.name);
      items.push({
        slot: slot.name,
        name: inside.name,
        kind: inside.kind,
        size: inside.size,
        from: info?.from ?? '',
        deleted: info?.deleted ?? slot.modified,
      });
    }
    return items.sort((a, b) => b.deleted - a.deleted);
  }

  /** How many items: the slot folders alone (one request, not one per item: it runs on every change to the bin). */
  async count(): Promise<number> {
    return (await this.slotFolders()).length;
  }

  /** Moves paths into the bin one at a time, so one failure does not stop the rest. Returns what happened. */
  async put(paths: string[]): Promise<{ slots: string[]; failures: Failure[] }> {
    await this.ensureDir();
    const slots: string[] = [];
    const failures: Failure[] = [];
    const now = Date.now();
    const added: Meta['items'] = [];
    for (const path of paths) {
      const name = baseName(path);
      const slot = newKey();
      try {
        await this.fs.mkdir(`${TRASH_DIR}/${slot}`, { hidden: true });
        try {
          await this.fs.move([path], `${TRASH_DIR}/${slot}`);
        } catch (error) {
          await this.fs.remove([`${TRASH_DIR}/${slot}`]).catch(() => {});
          throw error;
        }
        slots.push(slot);
        added.push({ slot, name, from: joinPath(path), deleted: now });
      } catch (error) {
        failures.push({ name, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    if (added.length) await this.changeMeta(meta => void meta.items.push(...added));
    return { slots, failures };
  }

  /**
   * Puts items back where they came from. If the old folder is gone they go to Documents, and a name already taken
   * there gets " (2)" added. Returns where each ended up. Folders go back before what was inside them, so a file and
   * its folder restored together end up together again.
   */
  async restore(slots: string[]): Promise<{ restored: Array<{ name: string; to: string; fallback: boolean }>; failures: Failure[] }> {
    // Read strictly: a list that could not be read would send everything to Documents as "location unknown".
    const { meta } = await this.readMetaWithId(true);
    const restored: Array<{ name: string; to: string; fallback: boolean }> = [];
    const failures: Failure[] = [];
    const done: string[] = [];
    const fromOf = (slot: string) => meta.items.find(i => i.slot === slot)?.from ?? '';
    const depth = (slot: string) => splitPath(fromOf(slot)).length;
    for (const slot of [...slots].sort((a, b) => depth(a) - depth(b))) {
      const slotPath = `${TRASH_DIR}/${slot}`;
      let name = slot;
      try {
        const inside = (await this.fs.list(slotPath, true))[0];
        if (!inside) throw new FsError('This item is not in the Recycle Bin any more.');
        name = inside.name;
        const from = fromOf(slot);
        let dest = from ? parentPath(from) : FALLBACK_FOLDER;
        let fallback = !from;
        const destEntry = dest === '/' ? { kind: 'folder' } : await this.fs.stat(dest);
        if (!destEntry || destEntry.kind !== 'folder') {
          dest = FALLBACK_FOLDER;
          fallback = true;
        }
        // Moved with " (2)" added if its name is taken, in one change: nothing is renamed and then left in the bin.
        const [moved] = await this.fs.move([`${slotPath}/${inside.name}`], dest, { keepBoth: true });
        await this.fs.remove([slotPath]).catch(() => {
          // The item is back; the empty slot goes when the bin is next listed.
        });
        done.push(slot);
        restored.push({ name: moved?.name ?? inside.name, to: dest, fallback });
      } catch (error) {
        failures.push({ name, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    if (done.length) await this.changeMeta(m => void (m.items = m.items.filter(i => !done.includes(i.slot))));
    return { restored, failures };
  }

  /** Destroys items for good. The caller has already asked the person. */
  async destroy(slots: string[]): Promise<{ failures: Failure[] }> {
    const failures: Failure[] = [];
    const gone: string[] = [];
    for (const slot of slots) {
      try {
        await this.fs.remove([`${TRASH_DIR}/${slot}`]);
        gone.push(slot);
      } catch (error) {
        failures.push({ name: slot, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    if (gone.length) await this.changeMeta(m => void (m.items = m.items.filter(i => !gone.includes(i.slot))));
    return { failures };
  }

  /** Destroys items deleted before the cutoff (ms since 1970). Returns how many went. Two requests when nothing is due. */
  async purgeBefore(cutoff: number): Promise<number> {
    const slots = await this.slotFolders();
    if (!slots.length) return 0;
    const meta = await this.readMeta();
    const old = slots.filter(s => (meta.items.find(i => i.slot === s.name)?.deleted ?? s.modified) < cutoff).map(s => s.name);
    if (!old.length) return 0;
    const { failures } = await this.destroy(old);
    return old.length - failures.length;
  }

  async empty(): Promise<{ failures: Failure[] }> {
    return this.destroy((await this.list()).map(i => i.slot));
  }
}

/** When the bin's automatic clearing would delete an item deleted at some time: items older than this go. */
export function purgeCutoff(clear: 'days' | 'daily' | 'never', days: number, now = new Date()): number | null {
  if (clear === 'never') return null;
  if (clear === 'daily') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return now.getTime() - days * 86400000;
}
