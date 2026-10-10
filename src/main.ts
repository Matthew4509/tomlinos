// Entry point: choose where files are kept (the desktop's server, or this browser for a copy opened with no server).
// On the server, ask who is signed in first: nobody set up yet shows the owner's setup, nobody signed in shows the
// sign-in screen, a locked session shows the lock. Encrypted files are opened (password, a key this browser kept, or
// the recovery key after a reset). Then start the desktop. If that fails, say so plainly with a Reload button; never
// loop or erase.
import { AuthApi, type AuthStatus, type PublicUser } from './auth/api.ts';
import { forgetMemoryPasswords } from './apps/mail/account.ts';
import { FilesVault } from './auth/files.ts';
import { chooseEncryption, openFilesScreen, showRecoveryKey, signIn, unlockFirst } from './auth/gate.ts';
import { forgetKeys, lockPending, markLockPending } from './auth/vault.ts';
import { h } from './core/dom.ts';
import { fitAboveKeyboard } from './core/keyboard.ts';
import { startDesktop } from './shell/shell.ts';
import type { Account, Shell } from './shell/types.ts';
import { BrowserStore } from './store/browser-store.ts';
import { EncryptedStore } from './store/encrypted-store.ts';
import { ServerStore } from './store/server-store.ts';
import type { Store } from './store/store.ts';

/** Only a path on this same site is accepted, so a config file cannot point the desktop at another host. */
const samePath = (value: unknown): value is string => typeof value === 'string' && /^\/[A-Za-z0-9._\/-]*$/.test(value) && !value.includes('//') && !value.includes('..');

/**
 * Where the files are kept, as storage.json says (every build writes one: "server" on a server, "browser" for a copy kept
 * in this browser). A file that cannot be read or says neither stops the start with the reason: guessing "browser" would
 * open an empty desktop on a server whose files are only out of reach, and new work would stay in this browser.
 */
async function chooseStore(): Promise<{ store: Store; auth: string | null }> {
  const unread = (why: string) => new Error(`The desktop could not find out where your files are kept: ${why}. No desktop was opened, so nothing was saved in the wrong place.`);
  let config: any;
  try {
    const res = await fetch('storage.json', { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) throw unread(`its settings file (storage.json) answered ${res.status}`);
    config = await res.json().catch(() => {
      throw unread('its settings file (storage.json) is damaged');
    });
  } catch (error) {
    throw error instanceof Error && error.message.startsWith('The desktop could not') ? error : unread("the desktop's server could not be reached");
  }
  if (config?.backend === 'server' && samePath(config.api)) {
    return { store: new ServerStore(config.api), auth: samePath(config.auth) ? config.auth : null };
  }
  if (config?.backend === 'browser') return { store: await BrowserStore.open(), auth: null };
  throw unread('its settings file (storage.json) names no place this desktop knows');
}

function fatal(root: HTMLElement, error: unknown): void {
  console.error(error);
  const reason = error instanceof Error && error.message ? error.message : 'An unknown fault stopped the desktop starting.';
  const button = h('button', { type: 'button', class: 'btn primary' }, 'Reload');
  button.addEventListener('click', () => location.reload());
  root.replaceChildren(
    h(
      'main',
      { class: 'fatal', role: 'alert' },
      h('h1', {}, 'The desktop could not start'),
      h('p', {}, reason),
      h('p', {}, 'Your files were not changed. Check the connection, then reload.'),
      button,
    ),
  );
  button.focus();
}

async function boot(root: HTMLElement): Promise<void> {
  const chosen = await chooseStore();
  if (!chosen.auth || !(chosen.store instanceof ServerStore)) {
    await startDesktop(root, chosen.store, null);
    return;
  }
  const server = chosen.store;
  const store = new EncryptedStore(server);
  const api = new AuthApi(chosen.auth);
  let status: AuthStatus = await api.status();
  document.getElementById('boot')?.remove();
  if (!status.signedIn) await forgetKeys();
  // The screen was locked while the server could not be reached, and the page reloaded before the lock got through:
  // the server locks the session now, before anything is shown.
  if (status.signedIn && !status.locked && status.user && (await lockPending(status.user.id))) {
    status = await api.lock();
    await markLockPending(status.user!.id, false);
  }
  if (status.signedIn && status.locked) {
    status = await unlockFirst(root, api, status);
    // Signed out from the lock (Sign out, or too many wrong tries): the last person's kept file key goes too.
    if (!status.signedIn) await forgetKeys();
  }
  if (!status.signedIn) status = await signIn(root, api, status);
  let user = status.user as PublicUser;
  const files = new FilesVault(api, store, () => user, next => (user = next));
  // Every signed-in answer carries the wrapped file key; if one ever does not while the account says it is encrypted,
  // ask again rather than treat the files as plain.
  const keysOf = async (s: AuthStatus) => (s.vaultKeys === undefined && s.user && s.user.vault !== 'off' ? (await api.status()).vaultKeys : s.vaultKeys);
  files.apply(await keysOf(status));

  // First set-up: the owner's recovery key, and encryption if they chose it. Shown once, before the desktop.
  if (status.adopted !== undefined && status.password) {
    const intro = 'If you forget your password, this key lets you choose a new one yourself (Forgot your password? on the sign-in screen).';
    if (status.encrypt) {
      const key = await files.turnOn(status.password, '');
      await showRecoveryKey(root, key, `${intro} Your files are encrypted: your password or this key opens them. If you lose both, nobody can open them.`);
    } else {
      await showRecoveryKey(root, await files.makeRecoveryKey(status.password, ''), intro);
    }
  }
  let firstRunNote = '';
  if (status.adopted === undefined && status.password && !user.admin && !user.recoveryKey && user.vault === 'off') {
    // Someone the owner added, signing in for the first time: the owner's set-up choice (encrypted unless they
    // untick it) and their recovery key. After this they have a recovery key, so it is asked once.
    const intro = 'If you forget your password, this key lets you choose a new one yourself (Forgot your password? on the sign-in screen).';
    try {
      if (await chooseEncryption(root, user.display)) {
        const key = await files.turnOn(status.password, '');
        await showRecoveryKey(root, key, `${intro} Your files are encrypted: your password or this key opens them. If you lose both, nobody can open them.`);
      } else {
        await showRecoveryKey(root, await files.makeRecoveryKey(status.password, ''), intro);
      }
    } catch (error) {
      firstRunNote = `Your files could not be set up just now (${error instanceof Error ? error.message : 'unknown error'}), so they are not encrypted yet. Open My account > Your files to encrypt them, and Sign-in options for a recovery key.`;
    }
  }
  if (!(await files.openQuietly(status.password))) {
    const how = await openFilesScreen(root, files, user, status.password);
    if (how === 'signout') {
      await api.logout().catch(() => undefined);
      await forgetKeys();
      location.reload();
      return;
    }
  }
  delete status.password;

  let shell: Shell | null = null;
  let asking: Promise<void> | null = null;
  const account: Account = {
    api,
    files,
    user: () => user,
    setUser: next => {
      user = next;
    },
    // The desktop is hidden while the sign-in screen shows. The same person signing in again carries on where they
    // were (unsaved work included); anyone else gets a fresh page, so no one sees another person's windows.
    signOut: message => {
      asking ??= (async () => {
        if (!message) await api.logout().catch(() => undefined);
        shell?.lock.cover();
        const now = await api.status().catch((): AuthStatus => ({ signedIn: false }));
        // However the session ended (Sign out here or on the lock screen, wrong PINs, signed out elsewhere), the file
        // key this browser kept and the mail passwords in memory go with it, so the next person cannot use them.
        if (!message || !now.signedIn) {
          await forgetKeys();
          forgetMemoryPasswords();
        }
        const next = now.signedIn ? now : await signIn(root, api, now, message ?? 'You have signed out.');
        if (next.user?.id === user.id) {
          user = next.user;
          files.apply(await keysOf(next));
          await files.openQuietly(next.password);
          delete next.password;
          shell?.lock.reset();
          if (next.locked) shell?.lock.lockedByServer();
        } else location.reload();
      })().finally(() => (asking = null));
      return asking;
    },
  };
  server.onAuthLost = (kind, message) => {
    if (kind === 'locked') shell?.lock.lockedByServer();
    else void account.signOut(message);
  };
  // Encryption was switched on or off in another window or on another device, and a save here was refused for it: take
  // the server's word on the state and open the files with the key this browser kept (the other window keeps it), so
  // the next save goes through. Without that key, the next save says to sign in again.
  let catchingUp: Promise<void> | null = null;
  const catchUp = (): Promise<void> => {
    catchingUp ??= (async () => {
      const now = await api.status();
      if (!now.signedIn || now.user?.id !== user.id) return;
      user = now.user;
      files.apply(await keysOf(now));
      await files.openQuietly();
    })().catch(() => undefined).finally(() => (catchingUp = null));
    return catchingUp;
  };
  server.onVaultChanged = () => void catchUp();
  // A record that does not fit this page's idea of the encryption is checked against the server's word first.
  store.recheck = catchUp;
  shell = await startDesktop(root, store, account);
  if (status.adopted) shell.toast('Welcome. The files that were already on this desktop are now yours.');
  if (firstRunNote) shell.toast(firstRunNote);
  else if (!user.recoveryKey) shell.toast('You have no recovery key yet. Make one in My account, so a forgotten password can be recovered.');
  // Encryption being turned on or off was interrupted (or has just been chosen at set-up): carry on in the background.
  if (files.moving) {
    const s = shell;
    s.toast(files.keys?.state === 'migrating-on' ? 'Encrypting your files in the background. You can keep working.' : 'Decrypting your files in the background.');
    files.move().then(
      () => s.toast(files.encrypted ? 'All your files are encrypted.' : 'Your files are no longer encrypted.'),
      error => void s.report('Converting your files stopped', error),
    );
  }
}

fitAboveKeyboard();
const root = document.getElementById('root');
if (root) boot(root).catch(error => fatal(root, error));
