// How the Start menu files the apps: pinned apps plus groups, so the menu is not a wall of tiles. The group names are the freedesktop categories Xfce shows (Accessories, Office, Internet...), which
// are also close to the folders of Windows' All Programs. A person can pin and unpin apps; this is the starting set.
import type { IconName } from './icons.ts';

export interface StartGroup {
  id: string;
  name: string;
  apps: string[];
}

/** Pinned until the person changes it (kept per person in their session file): the Panel (easy to miss under System)
 * and File Explorer; everything else is in its group. */
export const DEFAULT_PINNED = ['panel', 'explorer'];

export const START_GROUPS: StartGroup[] = [
  { id: 'accessories', name: 'Accessories', apps: ['explorer', 'editor', 'notepadpro', 'calculator', 'reader', 'aimodels'] },
  { id: 'office', name: 'Office', apps: ['sheet', 'calendar', 'contacts'] },
  { id: 'internet', name: 'Internet', apps: ['mail', 'chat'] },
  { id: 'media', name: 'Graphics & media', apps: ['photoedit'] },
  { id: 'games', name: 'Games', apps: ['planetziods', 'printer'] },
  { id: 'development', name: 'Development', apps: ['riscv', 'terminal'] },
  { id: 'system', name: 'System', apps: ['taskmanager', 'panel', 'trash'] },
  { id: 'settings', name: 'Settings', apps: ['settings', 'account', 'shortcuts'] },
];

/** Shown in the Start menu's bottom row instead of a group (Windows' Help, Xfce's About). */
export const FOOT_APPS = ['about'];

export const GROUP_ICON: IconName = 'folder';
/** A Start-menu app that no group names still appears, in "Other" (as Xfce does), so nothing can go missing. */
export const OTHER_GROUP: StartGroup = { id: 'other', name: 'Other', apps: [] };

/** The groups for the apps that exist, each app filed once; an app no group names goes to the group it asks for
 *  (`groupOf`, store apps), else to Other. */
export function groupsFor(appIds: string[], groupOf: Record<string, string | undefined> = {}): StartGroup[] {
  const known = new Set(appIds);
  const filed = new Set<string>(FOOT_APPS);
  const out = START_GROUPS.map(g => ({ ...g, apps: g.apps.filter(id => known.has(id) && !filed.has(id) && (filed.add(id), true)) }));
  for (const id of appIds) {
    const g = out.find(x => x.id === groupOf[id]);
    if (g && !filed.has(id)) {
      g.apps.push(id);
      filed.add(id);
    }
  }
  const other = appIds.filter(id => !filed.has(id));
  if (other.length) out.push({ ...OTHER_GROUP, apps: other });
  return out.filter(g => g.apps.length);
}

/** The pinned apps that exist, in order, without repeats. `null` means the starting set. */
export function pinnedFor(saved: string[] | null, appIds: string[]): string[] {
  const known = new Set(appIds);
  return [...new Set(saved ?? DEFAULT_PINNED)].filter(id => known.has(id));
}
