// Application manager: the apps on this TOMLIN OS by kind (Games, Office, System) as a grid of icons, and Updates.
// Built-in apps open from here. Store apps (games and other add-ons, server/lib/appstore.php) come from the TOMLIN OS app
// store's signed list: the owner of this TOMLIN OS downloads one onto the server (or updates or deletes it), and then each
// person adds it to their own desktop with Install, or takes it off with Remove. Nobody gets a store app unasked.
// New versions of TOMLIN OS itself arrive as a System update, signed by TOMLIN OS and fetched by this TOMLIN OS's own server
// (server/lib/updater.php); only the owner installs one. Opened with "updates" it starts there.
import { askIdentity } from '../auth/identity.ts';
import { h, on } from '../core/dom.ts';
import { formatSize } from '../core/format.ts';
import { ServiceApi } from '../net/service.ts';
import { HIDDEN_APPS } from '../release.ts';
import { icon, isIconName, type IconName } from '../shell/icons.ts';
import type { AppDef } from '../shell/types.ts';
import { APPS } from './catalog.ts';
import type { StoreApp } from './storeapp.ts';

type Kind = 'games' | 'office' | 'system';

const KINDS: Array<{ id: Kind | 'updates'; label: string }> = [
  { id: 'games', label: 'Games' },
  { id: 'office', label: 'Office' },
  { id: 'system', label: 'System' },
  { id: 'updates', label: 'Updates' },
];

/** Which shelf each built-in app sits on; an app not named here is Office. */
const KIND_OF: Partial<Record<string, Kind>> = {
  planetziods: 'games', printer: 'games',
  explorer: 'system', terminal: 'system', taskmanager: 'system', settings: 'system', account: 'system',
  shortcuts: 'system', about: 'system', trash: 'system', riscv: 'system', aimodels: 'system', panel: 'system', appmanager: 'system',
};

interface Check {
  current: string;
  owner: boolean;
  back: string | null;
  latest: { version: string; date: string; notes: string; bytes: number } | null;
  newer: boolean;
  error: string | null;
  missing?: string[];
}

/** One app in the store's signed list (api/apps.php op=list). */
interface Listed extends StoreApp {
  date: string;
  notes: string;
  bytes: number;
}

interface Store {
  owner: boolean;
  here: StoreApp[];
  apps: Listed[];
  error: string | null;
}

/** True when version a (1.2 or 1.2.3) is newer than b. */
const isNewer = (a: string, b: string): boolean => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};

export const appManagerApp: AppDef = {
  ...APPS.appmanager,
  async launch(app, arg) {
    const { shell, signal } = app;
    app.root.classList.add('ast');
    const api = shell.account ? new ServiceApi(shell.account.api.base, 'update') : null;
    const appsApi = shell.account ? new ServiceApi(shell.account.api.base, 'apps') : null;
    const nav = h('nav', { class: 'ast-nav', 'aria-label': 'Kinds of app' });
    const panel = h('div', { class: 'ast-panel' });
    app.root.append(nav, panel);
    let showing: Kind | 'updates' = arg === 'updates' ? 'updates' : 'games';

    const buttons = KINDS.map(k => {
      const b = h('button', { type: 'button', class: 'ast-kind' }, k.label);
      on(b, 'click', () => { showing = k.id; paint(); }, signal);
      return { k, b };
    });
    nav.append(...buttons.map(x => x.b));

    // The store: asked when this opens, again by "Search for more apps", and its answer kept after every change.
    let store: Store | null = null;
    let storeNote = appsApi ? 'Looking in the app store...' : 'The app store needs this TOMLIN OS to run on its server.';
    async function readStore(): Promise<void> {
      if (!appsApi) return;
      storeNote = 'Looking in the app store...';
      paint();
      try {
        store = await appsApi.call<Store>('list', { signal });
        shell.setStoreApps(store.here);
        storeNote = store.error ?? '';
      } catch (error) {
        if ((error as Error).name === 'AbortError') return;
        storeNote = error instanceof Error ? error.message : 'The app store could not be read.';
      }
      if (!signal.aborted) paint();
    }

    /**
     * The owner downloads, updates or deletes a store app on this server. The server asks for the owner's own password
     * first (as it does for adding a person): code put on the server, or an app taken from everyone, is not something
     * a passer-by at an unlocked desktop may do.
     */
    async function serverChange(op: 'download' | 'delete', a: StoreApp, button: HTMLButtonElement): Promise<void> {
      if (!appsApi) return;
      const who = await askIdentity(shell, op === 'delete'
        ? { title: `Delete ${a.title} from this server?`, text: `Nobody on this TOMLIN OS will have ${a.title} until it is downloaded again. Files people made with it stay in their own files.`, ok: 'Delete from server', danger: true, signal }
        : { title: `Download ${a.title} to this server?`, text: `${a.title} is put on this server for everyone here to install. Only apps signed by TOMLIN OS can be downloaded, and each runs shut off from people's files.`, ok: 'Download', signal });
      if (!who) return;
      button.disabled = true;
      const was = button.textContent;
      button.textContent = op === 'delete' ? 'Deleting...' : 'Downloading...';
      try {
        const r = await appsApi.call<{ apps: StoreApp[] }>(op, { body: { id: a.id, password: who.password, code: who.code } });
        shell.setStoreApps(r.apps);
        if (store) store.here = r.apps;
        shell.toast(op === 'delete' ? `${a.title} is deleted from this server.` : `${a.title} is on this server: press Install to add it to your desktop.`);
        paint();
      } catch (error) {
        button.disabled = false;
        button.textContent = was;
        void shell.report(op === 'delete' ? `${a.title} could not be deleted` : `${a.title} could not be downloaded`, error);
      }
    }

    function builtInTile(a: { id: string; title: string; icon: string }): HTMLElement {
      const b = h('button', { type: 'button', class: 'ast-app' }, icon(a.icon as IconName, 48), h('span', {}, a.title));
      on(b, 'click', () => void shell.openApp(a.id), signal);
      return h('div', { class: 'ast-tile', role: 'listitem' }, b);
    }

    function storeTile(listed: Listed | undefined, here: StoreApp | undefined): HTMLElement {
      const a = (here ?? listed)!;
      const mine = !!here && shell.installedApps.has(a.id);
      const b = h('button', { type: 'button', class: 'ast-app', disabled: !mine }, icon(isIconName(a.icon) ? a.icon : 'app', 48), h('span', {}, a.title));
      on(b, 'click', () => void shell.openApp(a.id), signal);
      const version = listed ? `${listed.version}${listed.bytes ? ` · ${formatSize(listed.bytes)}` : ''}` : (here?.version ?? '');
      const parts: HTMLElement[] = [b, h('span', { class: 'hint ast-later' }, version)];
      if (listed?.notes) parts.push(h('span', { class: 'hint ast-later', title: listed.notes }, listed.notes.length > 60 ? `${listed.notes.slice(0, 57)}...` : listed.notes));
      if (here) {
        // On this server: each person adds it to their own desktop, or takes it off again.
        const toggle = h('button', { type: 'button', class: `btn ast-install${mine ? '' : ' primary'}` }, mine ? 'Remove' : 'Install');
        on(toggle, 'click', () => {
          toggle.disabled = true;
          shell.setInstalled(a.id, !mine).then(
            () => {
              shell.toast(mine ? `${a.title} is removed from your desktop.` : `${a.title} is installed: open it here or from the Start menu.`);
              paint();
            },
            error => {
              toggle.disabled = false;
              void shell.report(mine ? `${a.title} could not be removed` : `${a.title} could not be installed`, error);
            },
          );
        }, signal);
        parts.push(toggle);
      }
      if (store?.owner) {
        if (listed && (!here || isNewer(listed.version, here.version))) {
          const get = h('button', { type: 'button', class: `btn ast-install${here ? '' : ' primary'}` }, here ? `Update to ${listed.version}` : 'Download to this server');
          on(get, 'click', () => void serverChange('download', listed, get), signal);
          parts.push(get);
        }
        if (here) {
          const del = h('button', { type: 'button', class: 'btn ast-install' }, 'Delete from server');
          on(del, 'click', () => void serverChange('delete', here, del), signal);
          parts.push(del);
        }
      } else if (!here) {
        parts.push(h('span', { class: 'hint ast-later' }, 'Not on this server yet: the owner can download it.'));
      }
      return h('div', { class: 'ast-tile', role: 'listitem' }, ...parts);
    }

    function paint(): void {
      for (const { k, b } of buttons) b.setAttribute('aria-current', String(k.id === showing));
      if (showing === 'updates') { void paintUpdates(); return; }
      const builtIn = Object.values(APPS).filter(a => 'start' in a && a.start && !HIDDEN_APPS.includes(a.id) && (KIND_OF[a.id] ?? 'office') === showing);
      const listed = new Map((store?.apps ?? []).map(a => [a.id, a]));
      const here = new Map((store?.here ?? [...shell.storeApps.values()]).map(a => [a.id, a]));
      const ids = [...new Set([...listed.keys(), ...here.keys()])].filter(id => !(id in APPS) && (here.get(id) ?? listed.get(id))!.kind === showing);
      const more = h('button', { type: 'button', class: 'btn' }, 'Search for more apps');
      on(more, 'click', () => void readStore(), signal);
      const tiles = [...builtIn.map(builtInTile), ...ids.map(id => storeTile(listed.get(id), here.get(id)))];
      panel.replaceChildren(
        h('div', { class: 'ast-grid', role: 'list' }, ...tiles),
        ...(tiles.length ? [] : [h('p', { class: 'hint' }, 'None on this shelf yet.')]),
        ...(storeNote ? [h('p', { class: 'hint', role: 'status' }, storeNote)] : []),
        h('p', { class: 'hint' }, 'Games and other add-ons come from the TOMLIN OS app store: only apps signed by TOMLIN OS can be downloaded, and each runs shut off from your files.'),
        more,
      );
    }

    async function paintUpdates(): Promise<void> {
      const status = h('p', { class: 'hint', role: 'status' }, 'Checking for updates...');
      const again = h('button', { type: 'button', class: 'btn' }, 'Search for more apps and updates');
      on(again, 'click', () => void paintUpdates(), signal);
      panel.replaceChildren(h('h2', { class: 'set-h' }, 'Updates'), status);
      if (!api) { status.textContent = 'Updates need this TOMLIN OS to run on its server.'; return; }
      let c: Check;
      try {
        c = await api.call<Check>('check', { signal });
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : 'The update check failed.';
        panel.append(again);
        return;
      }
      const rows: Array<HTMLElement | null> = [h('p', {}, `This TOMLIN OS is version ${c.current}.`)];
      if (c.error) status.textContent = c.error;
      else if (!c.newer) status.textContent = `Up to date. The newest is ${c.latest?.version ?? c.current}.`;
      else status.textContent = '';
      if (c.newer && c.latest) {
        const l = c.latest;
        rows.push(
          h('div', { class: 'ast-update' },
            h('strong', {}, `TOMLIN OS ${l.version} is available`),
            h('span', { class: 'hint' }, `${l.date}${l.bytes ? ` · ${formatSize(l.bytes)}` : ''}`),
            h('h3', {}, "What's new"),
            h('p', { class: 'ast-notes' }, l.notes)),
        );
        if (c.owner) {
          if (c.missing?.length) rows.push(h('p', { class: 'hint' }, `${c.missing.join(' ')} Until then, update by unzipping the new version in cPanel.`));
          const install = h('button', { type: 'button', class: 'btn primary' }, `Install ${l.version}`);
          on(install, 'click', () => void act('install', install, `Installing ${l.version}... keep this window open.`), signal);
          rows.push(install);
        } else {
          rows.push(h('p', { class: 'hint' }, 'The owner of this TOMLIN OS installs updates.'));
        }
      }
      if (c.owner && c.back) {
        const back = h('button', { type: 'button', class: 'btn' }, `Go back to ${c.back}`);
        on(back, 'click', () => void act('rollback', back, `Putting ${c.back} back...`), signal);
        rows.push(h('p', { class: 'hint' }, 'The version from before the last update is kept, in case the new one misbehaves.'), back);
      }
      panel.append(...rows.filter((r): r is HTMLElement => !!r), again);
    }

    /** Install or Go back: the owner's own password first (the server asks for it), as for the store apps above. */
    async function act(op: 'install' | 'rollback', button: HTMLButtonElement, words: string): Promise<void> {
      if (!api) return;
      const who = await askIdentity(shell, op === 'install'
        ? { title: 'Install this update?', text: 'The new version replaces this TOMLIN OS\'s own files; everyone\'s files and settings are kept, and the version from before is kept to go back to.', ok: 'Install', signal }
        : { title: 'Go back to the earlier version?', text: 'The files from before the last update are put back. Everyone\'s files and settings are kept.', ok: 'Go back', signal });
      if (!who) return;
      button.disabled = true;
      const note = h('p', { class: 'hint', role: 'status' }, words);
      button.after(note);
      try {
        const r = await api.call<{ version: string }>(op, { body: { password: who.password, code: who.code } });
        note.textContent = `TOMLIN OS ${r.version} is installed. Restarting the desktop to use it...`;
        setTimeout(() => location.reload(), 1500);
      } catch (error) {
        note.textContent = error instanceof Error ? error.message : 'It did not work. Nothing was changed.';
        button.disabled = false;
      }
    }

    paint();
    void readStore();
  },
};
