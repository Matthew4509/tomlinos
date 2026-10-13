// Updates: the program reads the published list of the newest version (sheets/latest.json in the project's Git
// repository on GitHub, which points at the installer attached to that version's GitHub release). An installer is
// used only if it carries this program's own signature, so a changed or broken download is refused. Installing closes
// the program, runs the installer without questions and starts the program again. The steps themselves are in
// src-tauri/src/update.rs; this side asks and explains.
import { h } from '../../src/core/dom.ts';
import type { DialogLayer } from '../../src/shell/dialogs.ts';
import { appVersion, PRODUCT } from './about.ts';
import { readValue, writeValue } from './prefs.ts';
import { invoke, tauri } from './tauri.ts';

interface UpdateInfo { version: string; notes: string }

export interface UpdateContext {
  dialogs: DialogLayer;
  toast(message: string, action?: { label: string; run: () => void }): void;
  /** Names of other windows with unsaved changes. */
  otherUnsaved(): Promise<string[]>;
  /** This window's "save changes?" question; false when the person cancelled. */
  runGuards(): Promise<boolean>;
}

/** How long a quiet check at start-up waits after the last one. */
const QUIET_GAP_MS = 12 * 60 * 60 * 1000;

/** The program's answer (it starts with what kind of fault it is) in words: the fault, the reason, the way out. */
function offlineWords(error: unknown): string {
  const raw = String(error ?? '');
  if (raw.startsWith('SIGNATURE')) return 'The update that was downloaded does not carry this program\'s signature, so it was not installed. Nothing was changed. Try again later.';
  if (raw.startsWith('BADLIST') || raw.startsWith('BADFILE')) return 'The update that was found could not be read, so nothing was installed. Nothing was changed. Try again later.';
  if (raw.startsWith('NOTFOUND')) return 'No list of new versions has been published yet, so there is nothing to install. Nothing was changed.';
  if (raw.startsWith('DISK')) return 'The update was downloaded but could not be started, because Windows did not allow it to be saved in the temporary folder. Nothing was changed. Free some space on drive C, then try again.';
  return 'The list of new versions could not be reached. Check that this computer is connected to the internet, then try again. Nothing was changed.';
}

/** A quiet check a few seconds after start-up, at most twice a day; says something only when there is a new version. */
export function startupUpdateCheck(ctx: UpdateContext): void {
  if (!tauri) return;
  const last = readValue<number>('update-checked') ?? 0;
  if (Date.now() - last < QUIET_GAP_MS) return;
  window.setTimeout(async () => {
    try {
      const update = await invoke<UpdateInfo | null>('update_check');
      writeValue('update-checked', Date.now());
      if (update && readValue<string>('update-skipped') !== update.version) {
        ctx.toast(`${PRODUCT} ${update.version} is available.`, { label: 'See what is new', run: () => void offer(ctx, update) });
      }
    } catch {
      // Offline or GitHub unreachable: tried again next start; Check for updates says why.
    }
  }, 6000);
}

/** File > Check for updates. */
export async function checkForUpdates(ctx: UpdateContext): Promise<void> {
  if (!tauri) {
    await ctx.dialogs.alert('Check for updates', 'Updates are checked by the installed program.');
    return;
  }
  ctx.toast('Checking for updates...');
  let update: UpdateInfo | null;
  try {
    update = await invoke<UpdateInfo | null>('update_check');
    writeValue('update-checked', Date.now());
  } catch (error) {
    await ctx.dialogs.alert('Could not check for updates', offlineWords(error));
    return;
  }
  if (!update) {
    await ctx.dialogs.alert('You are up to date', `${PRODUCT} ${await appVersion()} is the newest version.`);
    return;
  }
  await offer(ctx, update);
}

async function offer(ctx: UpdateContext, manifest: UpdateInfo): Promise<void> {
  const current = await appVersion();
  const notes = manifest.notes.trim();
  const body = h('div', { class: 'update-offer' },
    h('p', { class: 'dialog-text' }, `Version ${manifest.version} is available. You have ${current}.`),
    notes ? h('div', { class: 'update-notes' }, ...notes.split(/\r?\n/).filter(Boolean).map(line => h('p', {}, line.replace(/^[-*]\s*/, '• ')))) : null,
    h('p', { class: 'dialog-detail' }, `Installing closes ${PRODUCT}, updates it and opens it again. It takes under a minute.`),
  );
  const answer = await ctx.dialogs.ask<'install' | 'later' | 'skip'>({
    title: `Update ${PRODUCT}`,
    body,
    buttons: [
      { label: 'Install and restart', value: 'install', primary: true },
      { label: 'Skip this version', value: 'skip' },
      { label: 'Later', value: 'later' },
    ],
    cancel: 'later',
  });
  if (answer === 'skip') writeValue('update-skipped', manifest.version);
  if (answer !== 'install') return;
  const others = await ctx.otherUnsaved();
  if (others.length) {
    await ctx.dialogs.alert('Save your other work first', `These windows have changes that are not saved: ${others.join(', ')}. Save or close them, then install the update again from File > Check for updates.`);
    return;
  }
  if (!(await ctx.runGuards())) return;
  ctx.toast(`Downloading ${PRODUCT} ${manifest.version}...`);
  try {
    // On Windows this ends the program once the installer has started; the installer opens it again.
    await invoke('update_install');
    await tauri!.process.relaunch();
  } catch (error) {
    if (String(error) === 'UPTODATE') await ctx.dialogs.alert('You are up to date', `${PRODUCT} ${await appVersion()} is the newest version.`);
    else await ctx.dialogs.alert('The update was not installed', offlineWords(error));
  }
}
