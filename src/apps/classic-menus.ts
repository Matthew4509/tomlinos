// The Help menu every app's classic menu bar ends with. It reaches only what the desktop already has: the Keyboard
// shortcuts window and About; a program running on its own (outside the desktop) shows its own help instead.
// Also the plain text-box commands (Undo, Cut, Copy...) the Edit menus of the text apps share.
import type { MenuItem } from '../shell/menu.ts';
import type { BarItem, BarMenu } from '../shell/menubar.ts';
import type { Shell } from '../shell/types.ts';

/** A right-click or ribbon menu's items (made fresh each time it opens) as menu bar items. */
export function fromMenuItems(items: MenuItem[]): BarItem[] {
  return items.map(m =>
    m.separator
      ? { separator: true }
      : {
          label: m.label,
          shortcut: m.hint,
          enabled: () => !m.disabled,
          checked: m.checked === undefined ? undefined : () => !!m.checked,
          danger: m.danger,
          submenu: m.submenu ? fromMenuItems(m.submenu) : undefined,
          action: m.action,
        });
}

export function helpMenu(shell: Shell, first: BarItem[] = []): BarMenu {
  return {
    label: 'Help',
    items: () => {
      const own: BarItem[] = shell.native
        ? shell.native.help().flatMap(g => [{ separator: true }, ...g.items.map(i => ({ label: i.label, action: i.run }))])
        : [
            { label: 'Keyboard shortcuts', shown: () => shell.hasApp('shortcuts'), action: () => void shell.openApp('shortcuts') },
            { separator: true },
            { label: 'About TOMLIN OS', icon: 'help', shown: () => shell.hasApp('about'), action: () => void shell.openApp('about') },
          ];
      return [...first, { separator: true }, ...own];
    },
  };
}

/** Undo, Redo, Cut, Copy and Select all for a plain text box, as its own keys do them (Paste stays Ctrl+V: a page may not read the clipboard unasked). */
export function textBoxEdits(box: () => HTMLTextAreaElement | HTMLInputElement | null, enabled: () => boolean = () => true): BarItem[] {
  const run = (command: string) => () => {
    const el = box();
    if (!el) return;
    el.focus();
    document.execCommand(command);
  };
  const chosen = () => {
    const el = box();
    return !!el && enabled() && el.selectionStart !== el.selectionEnd;
  };
  return [
    { label: 'Undo', icon: 'undo', shortcut: 'Ctrl+Z', enabled, action: run('undo') },
    { label: 'Redo', icon: 'redo', shortcut: 'Ctrl+Y', enabled, action: run('redo') },
    { separator: true },
    { label: 'Cut', icon: 'cut', shortcut: 'Ctrl+X', enabled: chosen, action: run('cut') },
    { label: 'Copy', icon: 'copy', shortcut: 'Ctrl+C', enabled: chosen, action: run('copy') },
    { separator: true },
    { label: 'Select all', icon: 'select-all', shortcut: 'Ctrl+A', enabled, action: () => {
      const el = box();
      if (!el) return;
      el.focus();
      el.select();
    } },
  ];
}
