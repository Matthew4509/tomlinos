// App shortcuts: a small file that opens an app, the way a .desktop file does on Debian with Xfce (and a .lnk on
// Windows), so any app can be put on the desktop. Right-click an app in the Start menu > Add to desktop writes "<App>.desktop" into the Desktop
// folder; double-clicking it opens the app.
//
// The file is a freedesktop Desktop Entry, so it reads sensibly anywhere, but TOMLIN OS only ever takes the app's id from
// it (X-TomlinOS-App) and opens that app if it is installed. It never runs a command (Exec is written for other systems
// to read and is ignored here), so a .desktop file that arrives in an email or a zip can do no more than open an app.
import { joinPath, splitExtension } from '../fs/names.ts';
import type { IconName } from './icons.ts';
import type { AppMeta, Shell } from './types.ts';

export const SHORTCUT_EXTENSION = '.desktop';
const DESKTOP_FOLDER = '/Desktop';

export const isAppShortcut = (name: string): boolean => splitExtension(name)[1].toLowerCase() === SHORTCUT_EXTENSION;

/** The name shown under the icon: the file's name without ".desktop" (as Windows hides ".lnk"). */
export const shortcutLabel = (name: string): string => (isAppShortcut(name) ? splitExtension(name)[0] : name);

export function shortcutText(app: Pick<AppMeta, 'id' | 'title'>): string {
  return ['[Desktop Entry]', 'Type=Application', `Name=${app.title}`, `X-TomlinOS-App=${app.id}`, ''].join('\r\n');
}

/** The app id a shortcut file names, or null when it names none (or not in a shape TOMLIN OS accepts). */
export function shortcutApp(text: string): string | null {
  const lines = text.split(/\r?\n/).map(l => l.trim());
  if (lines.find(l => l !== '' && !l.startsWith('#')) !== '[Desktop Entry]') return null;
  for (const line of lines) {
    const m = /^X-TomlinOS-App=([a-z][a-z0-9]{0,31})$/.exec(line);
    if (m) return m[1];
  }
  return null;
}

/**
 * The icon for a shortcut's file name: the app whose title the name is (so "Panel.desktop" shows Panel's icon) or the
 * plain app icon once it has been renamed. Worked out from the name alone, so the desktop draws it without reading
 * every file.
 */
export function shortcutIcon(name: string, apps: Array<Pick<AppMeta, 'title' | 'icon'>>): IconName {
  const title = shortcutLabel(name).replace(/ \(\d+\)$/, '').toLowerCase();
  return apps.find(a => a.title.toLowerCase() === title)?.icon ?? 'app';
}

/** Apps the desktop always shows an icon for (shell.ts), whatever is in the Desktop folder. */
export const ALWAYS_ON_DESKTOP = ['panel', 'printer'];

/** Puts a shortcut to the app on the desktop, or says it is there already. */
export async function addToDesktop(shell: Shell, appId: string): Promise<void> {
  const app = shell.apps().find(a => a.id === appId);
  if (!app) return;
  if (ALWAYS_ON_DESKTOP.includes(app.id)) {
    shell.toast(`${app.title} is already on the desktop.`);
    return;
  }
  const path = joinPath(DESKTOP_FOLDER, `${app.title}${SHORTCUT_EXTENSION}`);
  try {
    if (await shell.fs.exists(path)) {
      shell.toast(`${app.title} is already on the desktop.`);
      return;
    }
    await shell.fs.ensureFolder(DESKTOP_FOLDER);
    await shell.fs.writeFile(path, new TextEncoder().encode(shortcutText(app)), { mustBeNew: true });
    shell.toast(`${app.title} is on the desktop now.`);
  } catch (error) {
    await shell.report('Could not put the shortcut on the desktop', error);
  }
}

/** Opens what a shortcut file points to; tells the person when it points at nothing installed here. */
export async function openShortcut(shell: Shell, path: string, name: string): Promise<void> {
  let id: string | null = null;
  try {
    id = shortcutApp(await shell.fs.readText(path));
  } catch (error) {
    await shell.report('Could not read the shortcut', error);
    return;
  }
  if (!id || !shell.hasApp(id)) {
    await shell.dialogs.alert(`“${shortcutLabel(name)}” opens nothing here`, id
      ? `It is a shortcut to an app called “${id}”, which this TOMLIN OS does not have. You can delete the shortcut; nothing else is affected.`
      : 'This shortcut file does not name a TOMLIN OS app. You can open it in Notepad to see what is in it, or delete it.');
    return;
  }
  await shell.openApp(id);
}
