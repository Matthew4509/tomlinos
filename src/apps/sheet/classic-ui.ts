// The Classic look's menu bar: File, Edit, View... across the top, each opening its menu under itself, as older desktop
// spreadsheets had before the ribbon. Once one menu is open, moving the pointer along the bar (or pressing Left and
// Right) opens the next; Alt and the underlined letter, or F10, opens one from the keyboard.
import { h, on } from '../../core/dom.ts';
import type { MenuItem } from '../../shell/menu.ts';
import type { Shell } from '../../shell/types.ts';

export interface BarMenu {
  label: string;
  /** The letter that opens it with Alt (underlined in its name). */
  key: string;
  items: () => MenuItem[];
  /** For a menu that is only there some of the time (Table, while in a table). */
  shown?: () => boolean;
}

export interface MenuBar {
  el: HTMLElement;
  /** Opens the menu whose letter this is (Alt+letter); false when no menu on the bar has it. */
  openByKey(letter: string): boolean;
  /** Opens the first menu from the keyboard (F10). */
  openFirst(): void;
  /** Shows or hides the menus that come and go. */
  sync(): void;
}

export function menuBar(shell: Shell, signal: AbortSignal, menus: BarMenu[], opts: { before(): boolean; returnFocus(): HTMLElement | null }): MenuBar {
  let openAt = -1;
  /**
   * Which menu was open when the current press began. The menu layer closes an open menu on any press outside it,
   * before the press reaches a name here; a press on the open menu's own name must then not open it again, while a
   * press on the name of a menu that had just closed (an item chosen a moment before) opens it. (Telling the two
   * apart by time once swallowed a quick click: a fast person, or a test, saw the menu not open.) This listener is added
   * once, before any menu is shown, so it hears each press before the menu layer's own.
   */
  let openAtPress = -1;
  let pressClosed = -1;
  on(document, 'pointerdown', () => {
    openAtPress = shell.menus.isOpen ? openAt : -1;
  }, signal, { capture: true });
  const titles = menus.map((m, i) => {
    const at = m.label.toLowerCase().indexOf(m.key.toLowerCase());
    const name = at < 0 ? [m.label] : [m.label.slice(0, at), h('u', {}, m.label[at]), m.label.slice(at + 1)];
    const b = h('button', { type: 'button', class: 'menubar-item', role: 'menuitem', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-keyshortcuts': `Alt+${m.key.toUpperCase()}` }, ...name);
    on(b, 'click', () => {
      // A second click on the open menu's name closes it (the press already closed it: the menu layer closes a menu
      // on any press outside it).
      if (openAt === i && shell.menus.isOpen) {
        shell.menus.close();
        return;
      }
      if (pressClosed === i) {
        pressClosed = -1;
        return;
      }
      open(i, false);
    }, signal);
    // This press began while this menu was open: the menu layer has just closed it for this press.
    on(b, 'pointerdown', () => {
      pressClosed = openAtPress === i ? i : -1;
    }, signal);
    on(b, 'pointerenter', () => {
      if (openAt >= 0 && openAt !== i && shell.menus.isOpen) open(i, false);
    }, signal);
    return b;
  });
  const el = h('div', { class: 'menubar', role: 'menubar', 'aria-label': 'Menu bar' }, ...titles);

  const visible = (i: number) => !titles[i].hidden;
  function open(i: number, fromKeyboard: boolean): void {
    if (!opts.before()) return;
    const r = titles[i].getBoundingClientRect();
    shell.menus.show(menus[i].items(), r.left, r.bottom, {
      returnFocus: opts.returnFocus(),
      fromKeyboard,
      anchor: el,
      onSide: step => {
        let j = i;
        do j = (j + step + menus.length) % menus.length; while (!visible(j) && j !== i);
        open(j, true);
      },
      // However it closes (a choice, Escape, a click elsewhere), the bar stops showing it open.
      onClose: () => {
        if (openAt !== i) return;
        openAt = -1;
        titles[i].setAttribute('aria-expanded', 'false');
      },
    });
    if (!shell.menus.isOpen) return;
    titles[i].setAttribute('aria-expanded', 'true');
    openAt = i;
  }
  return {
    el,
    openByKey(letter) {
      const i = menus.findIndex((m, k) => m.key.toLowerCase() === letter.toLowerCase() && visible(k));
      if (i < 0) return false;
      open(i, true);
      return true;
    },
    openFirst() {
      open(0, true);
    },
    sync() {
      menus.forEach((m, i) => {
        if (m.shown) titles[i].hidden = !m.shown();
      });
    },
  };
}
