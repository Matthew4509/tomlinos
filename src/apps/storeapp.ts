// A store app (server/lib/appstore.php) in a TOMLIN OS window: its page, public_html/apps/<id>/index.html, in a frame.
// The frame is sandboxed without its own site's rights: the app runs as a stranger to TOMLIN OS, so it cannot reach the
// desktop, the person's files, mail or chats, nor anything the sign-in opens. It gets its own files (served to it across
// origins, see tools/package.mjs) and is told where the Reader is (?reader=), whose built-in books it may read. To show
// a book it asks the desktop, which opens the Reader in a window of its own (the Reader is never framed by a store app).
import { h, on } from '../core/dom.ts';
import { ServiceApi } from '../net/service.ts';
import { isIconName } from '../shell/icons.ts';
import type { AppDef } from '../shell/types.ts';

/** What the server says about an app it has (api/apps.php op=here). */
export interface StoreApp {
  id: string;
  title: string;
  icon: string;
  kind: string;
  version: string;
  size: [number, number];
}

/**
 * Said to the other tabs of this browser when the owner downloads or deletes a store app on the server. It carries
 * nothing: a tab that hears it asks the server which apps are here now.
 */
export const STORE_APPS_CHANNEL = 'tomlinos-store-apps';

/** Tells this browser's other tabs that the server's store apps changed (see STORE_APPS_CHANNEL). */
export function sayStoreAppsChanged(): void {
  if (!('BroadcastChannel' in window)) return;
  const channel = new BroadcastChannel(STORE_APPS_CHANNEL);
  channel.postMessage('changed');
  channel.close();
}

/** Which Start menu group a kind of store app goes in (src/shell/startgroups.ts). */
const GROUP_OF: Record<string, string> = { games: 'games', office: 'office', system: 'system' };

export function storeAppDef(app: StoreApp): AppDef {
  const [w, tall] = Array.isArray(app.size) ? app.size : [960, 640];
  return {
    id: app.id,
    title: app.title,
    icon: isIconName(app.icon) ? app.icon : 'app',
    size: [w, tall],
    minSize: [320, 300],
    start: true,
    single: true,
    group: GROUP_OF[app.kind] ?? 'other',
    launch(handle) {
      handle.root.classList.add('reader-app');
      const reader = new URL('reader/', document.baseURI).pathname;
      const src = `apps/${encodeURIComponent(app.id)}/index.html?${new URLSearchParams({ reader, v: app.version })}`;
      const frame = h('iframe', { class: 'reader-app-frame', src, title: app.title, sandbox: 'allow-scripts' }) as HTMLIFrameElement;
      handle.root.append(frame);
      // The one thing a store app may ask of the desktop: open a book in the Reader. Only this window's own frame is
      // heard, and only plain book names are passed on.
      on(window, 'message', (event: MessageEvent) => {
        const d = event.data as { type?: unknown; author?: unknown; work?: unknown } | null;
        if (event.source !== frame.contentWindow || d?.type !== 'tomlinos-open-reader') return;
        const author = String(d.author ?? '');
        const work = String(d.work ?? '');
        if (/^[a-z0-9-]{1,80}$/.test(author) && /^[a-z0-9-]{0,80}$/.test(work)) void handle.shell.openApp('reader', `work:${author}:${work}`);
      }, handle.signal);
      // The owner may delete this app from the server while it is open here (in another tab, or on another device):
      // this window then closes and says why, rather than stay on a page whose files are gone. Another tab of this
      // browser says so at once; otherwise it is found when this tab is looked at again.
      const shell = handle.shell;
      const appsApi = shell.account ? new ServiceApi(shell.account.api.base, 'apps') : null;
      let asking = false;
      const recheck = async (): Promise<void> => {
        if (!appsApi || asking || handle.signal.aborted) return;
        asking = true;
        try {
          const r = await appsApi.call<{ apps: StoreApp[] }>('here', { signal: handle.signal });
          if (handle.signal.aborted || !Array.isArray(r.apps) || r.apps.some(a => a?.id === app.id)) return;
          shell.toast(`${app.title} was deleted from this server, so its window is closed.`);
          // Takes it off the Start menu and closes its windows, this one too.
          shell.setStoreApps(r.apps);
          if (!handle.signal.aborted) handle.close();
        } catch {
          // Out of reach or signed out: nothing is known, so nothing changes.
        } finally {
          asking = false;
        }
      };
      if ('BroadcastChannel' in window) {
        const channel = new BroadcastChannel(STORE_APPS_CHANNEL);
        channel.onmessage = () => void recheck();
        handle.signal.addEventListener('abort', () => channel.close(), { once: true });
      }
      on(document, 'visibilitychange', () => { if (document.visibilityState === 'visible') void recheck(); }, handle.signal);
    },
  };
}
