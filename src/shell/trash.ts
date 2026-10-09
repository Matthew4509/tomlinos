// The Recycle Bin. Deleting moves things here; only emptying the bin (or deleting from inside it) destroys them,
// and both ask first. Each deleted item sits in its own slot folder under /System/Trash, keeping its name, and a
// small list (/System/trash.json) remembers where each one came from. If that list is lost, the slots are still
// there and are shown as "original location unknown"; nothing is lost with it.
import { FsError, type Entry, type FileSystem } from '../fs/fs.ts';
import { baseName, joinPath, nameKey, parentPath, uniqueName } from '../fs/names.ts';
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
    try {
      const raw = JSON.parse(await this.fs.readText(META_PATH));
      if (raw && raw.v === 1 && Array.isArray(raw.items)) {
        return {
          v: 1,
          items: raw.items.filter(
            (i: any) => i && typeof i.slot === 'string' && typeof i.name === 'string' && typeof i.from === 'string' && typeof i.deleted === 'number',
          ),
        };
      }
    } catch {
      // Missing or unreadable: the slots themselves are the source of truth.
    }
    return { v: 1, items: [] };
  }

  private async writeMeta(meta: Meta): Promise<void> {
    await this.fs.writeText(META_PATH, JSON.stringify(meta), { hidden: true });
  }

  private async ensureDir(): Promise<void> {
    await this.fs.ensureFolder('/System', { hidden: true });
    await this.fs.ensureFolder(TRASH_DIR, { hidden: true });
  }

  /** What is in the bin, newest first. */
  async list(): Promise<BinItem[]> {
    let slots: Entry[];
    try {
      slots = (await this.fs.list(TRASH_DIR, true)).filter(e => e.kind === 'folder');
    } catch (error) {
      if (error instanceof FsError) return [];
      throw error;
    }
    const meta = await this.readMeta();
    const items: BinItem[] = [];
    for (const slot of slots) {
      const inside = (await this.fs.list(`${TRASH_DIR}/${slot.name}`, true))[0];
      if (!inside) continue;
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

  async count(): Promise<number> {
    return (await this.list()).length;
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
    if (added.length) {
      const meta = await this.readMeta();
      meta.items.push(...added);
      await this.writeMeta(meta);
    }
    return { slots, failures };
  }

  /**
   * Puts items back where they came from. If the old folder is gone they go to Documents, and a name already taken
   * there gets " (2)" added. Returns where each ended up.
   */
  async restore(slots: string[]): Promise<{ restored: Array<{ name: string; to: string; fallback: boolean }>; failures: Failure[] }> {
    const meta = await this.readMeta();
    const restored: Array<{ name: string; to: string; fallback: boolean }> = [];
    const failures: Failure[] = [];
    for (const slot of slots) {
      const slotPath = `${TRASH_DIR}/${slot}`;
      let name = slot;
      try {
        const inside = (await this.fs.list(slotPath, true))[0];
        if (!inside) throw new FsError('This item is not in the Recycle Bin any more.');
        name = inside.name;
        const from = meta.items.find(i => i.slot === slot)?.from ?? '';
        let dest = from ? parentPath(from) : FALLBACK_FOLDER;
        let fallback = !from;
        const destEntry = dest === '/' ? { kind: 'folder' } : await this.fs.stat(dest);
        if (!destEntry || destEntry.kind !== 'folder') {
          dest = FALLBACK_FOLDER;
          fallback = true;
        }
        const taken = (await this.fs.list(dest, true)).map(e => e.name);
        const finalName = uniqueName(inside.name, taken);
        if (nameKey(finalName) !== nameKey(inside.name)) await this.fs.rename(`${slotPath}/${inside.name}`, finalName);
        await this.fs.move([`${slotPath}/${finalName}`], dest);
        await this.fs.remove([slotPath]);
        meta.items = meta.items.filter(i => i.slot !== slot);
        restored.push({ name: finalName, to: dest, fallback });
      } catch (error) {
        failures.push({ name, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    if (restored.length) await this.writeMeta(meta);
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
    if (gone.length) {
      const meta = await this.readMeta();
      meta.items = meta.items.filter(i => !gone.includes(i.slot));
      await this.writeMeta(meta);
    }
    return { failures };
  }

  /** Destroys items deleted before the cutoff (ms since 1970). Returns how many went. */
  async purgeBefore(cutoff: number): Promise<number> {
    const old = (await this.list()).filter(i => i.deleted < cutoff);
    if (!old.length) return 0;
    const { failures } = await this.destroy(old.map(i => i.slot));
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
