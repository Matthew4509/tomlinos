// The Start menu: pinned apps, every app filed in groups (startgroups.ts), the standard folders, a search box, and
// Lock, Sign out, Reload and About at the foot. "Reload" only reloads the page; nothing here erases files.
// One arrangement whatever the colour scheme, the classic Xfce and MATE menu: one column (the pinned apps, then each
// group and Places), and a group opens its apps in a column to the right of the menu, level with the group; a column
// can open another to its right the same way. A click opens a column (so a keyboard and a finger can use it: Right
// opens, Left and Escape close); a mouse resting on a group opens it too, as Xfce's menu does. A screen too narrow for
// a column beside the menu (a phone) opens the group in place, with a Back button.
// Typing searches everything. Right-click an app (or the menu key) to pin or unpin it; pins are kept per person in
// their session file.
import { css, h, on } from '../core/dom.ts';
import { icon, type IconName } from './icons.ts';
import { bindContextMenu } from './menu.ts';
import { addToDesktop } from './appshortcut.ts';
import { FOOT_APPS, GROUP_ICON, groupsFor, pinnedFor } from './startgroups.ts';
import type { AppDef, Shell } from './types.ts';

const PLACES = ['Desktop', 'Documents', 'Pictures', 'Videos', 'Music'];
const COLUMN_WIDTH = 240;
/** How long a mouse rests on a group before its column opens (a pointer passing over it opens nothing). */
const HOVER_MS = 200;

/** A row that opens a column: a group, or Places. */
interface Branch {
  id: string;
  name: string;
  iconName: IconName;
  items: () => HTMLElement[];
}

export class StartMenu {
  private shell: Shell;
  private host: HTMLElement;
  private button: HTMLButtonElement;
  private panel: HTMLElement | null = null;
  /** The open columns, left to right: each its own box in the Start layer, outside the menu (which clips what overflows it). */
  private flyouts: HTMLElement[] = [];
  private abort: AbortController | null = null;

  constructor(shell: Shell, host: HTMLElement, button: HTMLButtonElement) {
    this.shell = shell;
    this.host = host;
    this.button = button;
    button.addEventListener('click', () => (this.panel ? this.close() : this.open()));
  }

  get isOpen(): boolean {
    return this.panel !== null;
  }

  close(restore = true): void {
    if (!this.panel) return;
    this.abort?.abort();
    this.panel.remove();
    this.panel = null;
    for (const fly of this.flyouts) fly.remove();
    this.flyouts = [];
    this.button.setAttribute('aria-expanded', 'false');
    if (restore) this.button.focus({ preventScroll: true });
  }

  open(): void {
    if (this.panel) return;
    const abort = new AbortController();
    this.abort = abort;
    const { signal } = abort;
    const shell = this.shell;
    // Only the words for pinning follow the colour scheme (Xfce says Favourites); the menu itself is the same.
    const xfce = document.documentElement.dataset.theme === 'xfce';
    const launch = (run: () => void) => () => {
      this.close(false);
      run();
    };

    const all = shell.apps().filter((a: AppDef) => a.start);
    const byId = new Map(all.map(a => [a.id, a]));
    const listed = all.filter(a => !FOOT_APPS.includes(a.id));
    const groups = groupsFor(listed.map(a => a.id), Object.fromEntries(listed.map(a => [a.id, a.group])));
    const pinned = () => pinnedFor(shell.session.data.pinned, listed.map(a => a.id));

    const filter = h('input', { type: 'search', class: 'field start-filter', placeholder: 'Find an app or folder', 'aria-label': 'Find an app or folder', autocomplete: 'off', spellcheck: false });
    const list = h('div', { class: 'start-list', role: 'group', 'aria-label': 'Apps' });

    /** One app (or folder) to open. `data-label` is its name in lower case, for the search box. */
    const entry = (label: string, iconName: IconName, run: () => void, appId?: string) => {
      const b = h('button', { type: 'button', class: 'start-item', 'data-label': label.toLowerCase(), 'data-app': appId ?? null }, icon(iconName, 24), h('span', {}, label));
      b.addEventListener('click', launch(run), { signal });
      return b;
    };
    const appEntry = (a: AppDef) => entry(a.title, a.icon, () => void shell.openApp(a.id), a.id);
    const placeEntry = (name: string) => entry(name, `folder-${name.toLowerCase()}` as IconName, () => void shell.openApp('explorer', `/${name}`));
    const note = (text: string) => h('p', { class: 'start-note' }, text);

    const branches: Branch[] = [
      ...groups.map(g => ({ id: g.id, name: g.name, iconName: GROUP_ICON, items: () => g.apps.map(id => appEntry(byId.get(id)!)) })),
      { id: 'places', name: 'Places', iconName: 'folder' as IconName, items: () => PLACES.map(placeEntry) },
    ];

    // ---- What the menu's column shows: the main list, or (no room for columns) one branch in place ----
    let inPlace: Branch | null = null;

    const pinnedList = (): Node[] => {
      const items = pinned().map(id => byId.get(id)).filter((a): a is AppDef => !!a).map(appEntry);
      return items.length ? items : [note(xfce ? 'No favourites yet. Right-click an app to add it.' : 'Nothing pinned. Right-click an app to pin it here.')];
    };
    const branchRow = (b: Branch) => {
      const row = h('button', { type: 'button', class: 'start-group', 'aria-haspopup': 'true', 'aria-expanded': 'false', 'data-group': b.id }, icon(b.iconName, 20), h('span', { class: 'start-group-name' }, b.name));
      row.addEventListener('click', () => {
        if (!cascades()) {
          inPlace = b;
          paint();
          list.querySelector<HTMLElement>('.start-item')?.focus();
        } else if (row.getAttribute('aria-expanded') === 'true') {
          // Already open (the mouse resting on it opened it a moment ago): a click keeps it open, as Xfce's does.
          this.flyouts[0]?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
        } else openColumn(0, b, row);
      }, { signal });
      return row;
    };
    const backBtn = h('button', { type: 'button', class: 'start-more start-back' }, h('span', { 'aria-hidden': 'true' }, '◂'), h('span', {}, 'Back'));
    on(backBtn, 'click', () => {
      const from = inPlace?.id;
      inPlace = null;
      paint();
      list.querySelector<HTMLElement>(`[data-group="${from}"]`)?.focus();
    }, signal);

    // ---- Columns to the right ----
    let menuEl: HTMLElement | null = null;
    /** Room for a column beside the menu. */
    const cascades = () => (menuEl?.getBoundingClientRect().right ?? 300) + COLUMN_WIDTH <= window.innerWidth;
    const openers = () => [list, ...this.flyouts].map(el => el.querySelector<HTMLElement>('.start-group[aria-expanded="true"]'));
    /** Closes the columns from `depth` on (0 = all) and clears the marks on the rows that opened them. */
    const closeColumns = (depth: number) => {
      for (const fly of this.flyouts.splice(depth)) fly.remove();
      const holders = [list, ...this.flyouts];
      for (const el of holders.slice(depth)) for (const b of el.querySelectorAll('.start-group')) b.setAttribute('aria-expanded', 'false');
    };
    /** Puts a column beside `left` (a screen x), level with its opener, kept above the taskbar. */
    const placeColumn = (fly: HTMLElement, left: number, opener: HTMLElement) => {
      const host = this.host.getBoundingClientRect();
      const floor = (menuEl?.getBoundingClientRect().bottom ?? host.bottom) - host.top;
      css(fly, { left: left - host.left, maxHeight: floor, width: COLUMN_WIDTH });
      const top = opener.getBoundingClientRect().top - host.top - 4;
      css(fly, { top: Math.max(0, Math.min(top, floor - fly.offsetHeight)) });
    };
    /** Opens `b` as the column at `depth` (0 = beside the menu), beside the column its row is in. */
    const openColumn = (depth: number, b: Branch, opener: HTMLElement, focus = true) => {
      closeColumns(depth);
      opener.setAttribute('aria-expanded', 'true');
      const fly = h('div', { class: 'start-fly', role: 'group', 'aria-label': b.name }, ...b.items());
      on(fly, 'keydown', keys, signal);
      bindContextMenu(fly, signal, shell.menus, pinMenu);
      this.host.append(fly);
      this.flyouts.push(fly);
      const beside = depth === 0 ? menuEl! : this.flyouts[depth - 1];
      placeColumn(fly, beside.getBoundingClientRect().right - 2, opener);
      if (focus) fly.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
    };

    // A mouse resting on a group opens its column; resting on anything else in that column's parent closes it.
    let hover = 0;
    const onHover = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse' || !cascades()) return;
      clearTimeout(hover);
      const holder = event.currentTarget as HTMLElement;
      const depth = holder === list ? 0 : this.flyouts.indexOf(holder) + 1;
      const row = (event.target as Element).closest<HTMLElement>('.start-group, .start-item');
      if (!row) return;
      hover = window.setTimeout(() => {
        if (!row.isConnected) return;
        if (!row.classList.contains('start-group')) {
          if (this.flyouts.length > depth) closeColumns(depth);
          return;
        }
        if (row.getAttribute('aria-expanded') === 'true') return;
        const b = branches.find(x => x.id === row.dataset.group);
        if (b) openColumn(depth, b, row, false);
      }, HOVER_MS);
    };
    on(list, 'pointerover', onHover, signal);
    signal.addEventListener('abort', () => clearTimeout(hover), { once: true });

    function paint() {
      const q = filter.value.trim().toLowerCase();
      let nodes: Node[];
      if (q) {
        // Search: every app and folder whose name matches, each once; the foot's apps (About) too, though without the pin
        // menu, as they cannot be pinned.
        const apps = all.filter(a => a.title.toLowerCase().includes(q)).sort((a, b) => a.title.localeCompare(b.title))
          .map(a => (FOOT_APPS.includes(a.id) ? entry(a.title, a.icon, () => void shell.openApp(a.id)) : appEntry(a)));
        const places = PLACES.filter(p => p.toLowerCase().includes(q)).map(placeEntry);
        nodes = apps.length || places.length ? [...apps, ...places] : [note(`Nothing called “${filter.value.trim()}”.`)];
      } else if (inPlace) {
        nodes = [backBtn, h('p', { class: 'start-place-title' }, inPlace.name), ...inPlace.items()];
      } else {
        nodes = [...pinnedList(), h('hr', { class: 'start-rule' }), ...branches.map(branchRow)];
      }
      list.replaceChildren(...nodes);
    }

    on(filter, 'input', () => {
      inPlace = null;
      closeColumns(0);
      paint();
    }, signal);
    // Enter (a phone keyboard's Go key) opens the first match.
    on(filter, 'keydown', (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || !filter.value.trim()) return;
      const first = list.querySelector<HTMLElement>('.start-item');
      if (!first) return;
      event.preventDefault();
      first.click();
    }, signal);

    // ---- Pin and unpin ----
    const setPinned = (ids: string[]) => {
      shell.session.data.pinned = ids;
      shell.session.touch();
      paint();
    };
    const pinMenu = (target: Element | null) => {
      const id = target?.closest<HTMLElement>('.start-item')?.dataset.app;
      if (!id) return null;
      const now = pinned();
      const isPinned = now.includes(id);
      const at = now.indexOf(id);
      return [
        { label: 'Open', action: launch(() => void shell.openApp(id)) },
        { separator: true },
        isPinned
          ? { label: xfce ? 'Remove from Favourites' : 'Unpin from Start', action: () => setPinned(now.filter(x => x !== id)) }
          : { label: xfce ? 'Add to Favourites' : 'Pin to Start', action: () => setPinned([...now, id]) },
        // A shortcut on the desktop.
        { label: xfce ? 'Add to Desktop' : 'Add to desktop', action: () => void addToDesktop(shell, id) },
        ...(isPinned && !inPlace && !filter.value.trim() && !!target && list.contains(target)
          ? [
              { label: 'Move up', disabled: at === 0, action: () => setPinned(now.map((x, i) => (i === at - 1 ? id : i === at ? now[at - 1] : x))) },
              { label: 'Move down', disabled: at === now.length - 1, action: () => setPinned(now.map((x, i) => (i === at + 1 ? id : i === at ? now[at + 1] : x))) },
            ]
          : []),
      ];
    };
    bindContextMenu(list, signal, shell.menus, pinMenu);

    // ---- Foot ----
    const reload = h('button', { type: 'button', class: 'btn start-reload' }, 'Reload');
    const account = shell.account;
    const lockBtn = h('button', { type: 'button', class: 'btn start-lock', title: 'Lock the screen (Alt+L)' }, icon('lock', 16), 'Lock');
    const signOutBtn = h('button', { type: 'button', class: 'btn start-signout' }, 'Sign out');
    const footApps = FOOT_APPS.map(id => byId.get(id)).filter((a): a is AppDef => !!a).map(a => {
      const b = h('button', { type: 'button', class: 'btn start-foot-app', 'data-label': a.title.toLowerCase() }, icon(a.icon, 16), a.title);
      b.addEventListener('click', launch(() => void shell.openApp(a.id)), { signal });
      return b;
    });
    on(reload, 'click', () => location.reload(), signal);
    on(lockBtn, 'click', launch(() => void shell.lock.show(true)), signal);
    on(signOutBtn, 'click', launch(() => void account?.signOut()), signal);

    const panel = h(
      'div',
      { class: 'start-menu', id: 'start-menu', role: 'dialog', 'aria-label': 'Start menu' },
      h('div', { class: 'start-head' }, h('span', { class: 'start-orb', 'aria-hidden': 'true' }), account ? account.user().display : 'TOMLIN OS'),
      h('div', { class: 'start-body' }, filter, list),
      h('div', { class: 'start-foot' }, ...footApps, h('span', { class: 'start-gap' }), ...(shell.lock.canLock ? [lockBtn] : []), ...(account ? [signOutBtn] : []), reload),
    );
    paint();
    this.host.append(panel);
    menuEl = panel;
    // Held at the size it opened at (the list scrolls inside): typing or going into a group in place must not make the
    // menu jump under the pointer.
    css(panel, { height: panel.offsetHeight, width: panel.offsetWidth });
    this.panel = panel;
    this.button.setAttribute('aria-expanded', 'true');

    // Keys, in the menu and in its columns: Up and Down move within the column that has the focus; Right on a group
    // opens its column; Left and Escape close the last column (Escape with none open closes the menu).
    const keys = (event: KeyboardEvent) => {
      const at = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const inColumn = at?.closest<HTMLElement>('.start-fly') ?? null;
      const depth = inColumn ? this.flyouts.indexOf(inColumn) : -1;
      const back = () => {
        const d = depth >= 0 ? depth : this.flyouts.length - 1;
        const opener = openers()[d];
        closeColumns(d);
        opener?.focus();
      };
      if (event.key === 'Escape') {
        if (shell.menus.isOpen) return;
        event.preventDefault();
        if (this.flyouts.length) back();
        else if (inPlace) backBtn.click();
        else this.close();
      } else if (event.key === 'ArrowRight' && at?.classList.contains('start-group')) {
        event.preventDefault();
        if (at.getAttribute('aria-expanded') === 'true') this.flyouts[depth + 1]?.querySelector<HTMLElement>('button')?.focus();
        else at.click();
      } else if (event.key === 'ArrowLeft' && depth >= 0) {
        event.preventDefault();
        back();
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const buttons = [...(inColumn ?? panel).querySelectorAll<HTMLElement>('.start-item, .start-group, .start-more')];
        const now = buttons.indexOf(at as HTMLElement);
        const next = event.key === 'ArrowDown' ? now + 1 : now - 1;
        if (buttons.length) {
          event.preventDefault();
          buttons[(next + buttons.length) % buttons.length].focus();
        }
      }
    };
    on(document, 'pointerdown', (event: PointerEvent) => {
      const t = event.target;
      // The pin menu is drawn in its own layer: choosing from it must not close the Start menu first.
      if (t instanceof Element && t.closest('.menu-root')) return;
      if (t instanceof Node && !panel.contains(t) && !this.button.contains(t) && !this.flyouts.some(f => f.contains(t))) this.close(false);
    }, signal, { capture: true });
    on(panel, 'keydown', keys, signal);
    // On a touch screen the search box waits for a tap: focusing it would raise the on-screen keyboard over the menu.
    if (!matchMedia('(pointer: coarse)').matches) filter.focus();
  }
}
