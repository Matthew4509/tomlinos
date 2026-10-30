// Settings: the wallpaper (a plain colour by default; your own colour or one of your pictures), the colour scheme, the
// screensaver, the AI (the built-in model and keys for AI services: assistant/aisettings.ts), the Recycle Bin, and where
// the desktop keeps its files. Opened with "ai" it starts at the AI section. Nothing here can erase files.
import { askIdentity } from '../auth/identity.ts';
import { h, on } from '../core/dom.ts';
import { THEMES, BIN_DAYS_MAX, BIN_LIMIT_MAX_MB, BIN_LIMIT_MIN_MB, DEFAULT_COLOUR, WALLPAPER_COLOURS } from '../shell/session.ts';
import { extensionOf } from '../shell/filetypes.ts';
import type { AppDef } from '../shell/types.ts';
import { saverControls } from '../shell/saverform.ts';
import { aiSettings } from './assistant/aisettings.ts';
import { APPS } from './catalog.ts';
import { ServiceApi } from '../net/service.ts';
import { clearOldThreads } from './chat/agents.ts';

export const PICTURE_TYPES = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp'];

export const settingsApp: AppDef = {
  ...APPS.settings,
  async launch(app, arg) {
    const shell = app.shell;
    app.root.classList.add('settings');
    const current = () => shell.session.data.wallpaper;

    const swatches = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Background colour' });
    const custom = h('input', { type: 'color', class: 'colour-input', 'aria-label': 'Choose your own colour', value: DEFAULT_COLOUR });
    const pictures = h('div', { class: 'picture-list', role: 'radiogroup', 'aria-label': 'Background picture' });
    const note = h('p', { class: 'hint' });

    function drawSwatches(): void {
      const now = current();
      swatches.replaceChildren(
        ...WALLPAPER_COLOURS.map(c => {
          const on = now.kind === 'colour' && now.value === c.value;
          const b = h('button', { type: 'button', class: `swatch${on ? ' on' : ''}`, role: 'radio', 'aria-checked': String(on), 'data-colour': c.value }, h('span', { class: 'swatch-chip', 'data-colour': c.value }), c.name);
          b.addEventListener('click', () => void shell.setWallpaper({ kind: 'colour', value: c.value }).then(drawSwatches), { signal: app.signal });
          return b;
        }),
      );
      for (const chip of swatches.querySelectorAll<HTMLElement>('.swatch-chip')) chip.style.setProperty('background', chip.dataset.colour ?? '');
      if (now.kind === 'colour') custom.value = now.value;
    }

    async function drawPictures(): Promise<void> {
      let names: string[] = [];
      try {
        names = (await shell.fs.list('/Pictures')).filter(e => e.kind === 'file' && PICTURE_TYPES.includes(extensionOf(e.name))).map(e => e.name);
      } catch (error) {
        await shell.report('Could not read the Pictures folder', error);
      }
      const now = current();
      const rows = names.sort((a, b) => a.localeCompare(b)).map(name => {
        const path = `/Pictures/${name}`;
        const on = now.kind === 'picture' && now.path === path;
        const b = h('button', { type: 'button', class: `picture${on ? ' on' : ''}`, role: 'radio', 'aria-checked': String(on) }, name);
        b.addEventListener('click', () => void shell.setWallpaper({ kind: 'picture', path }).then(drawPictures), { signal: app.signal });
        return b;
      });
      pictures.replaceChildren(...rows);
      note.textContent = rows.length
        ? 'Pictures in your Pictures folder. Choosing a colour above puts the plain background back.'
        : 'To use your own picture, put a PNG, JPG, GIF, WebP, AVIF or BMP file in your Pictures folder, then open Settings again.';
    }

    on(custom, 'change', () => void shell.setWallpaper({ kind: 'colour', value: custom.value.toLowerCase() }).then(drawSwatches), app.signal);

    // ---- Recycle Bin ----
    const bin = shell.session.data.bin;
    const clearSel = h('select', { class: 'field', 'aria-label': 'Clear old items' },
      h('option', { value: 'days' }, 'Delete items after a number of days'),
      h('option', { value: 'daily' }, 'Clear every day (items from before today)'),
      h('option', { value: 'never' }, 'Never clear by itself'),
    );
    const daysIn = h('input', { type: 'number', class: 'field num', min: 1, max: BIN_DAYS_MAX, step: 1, 'aria-label': 'Days to keep deleted items' });
    const limitIn = h('input', { type: 'number', class: 'field num', min: BIN_LIMIT_MIN_MB, max: BIN_LIMIT_MAX_MB, step: 1, 'aria-label': 'Size limit in megabytes' });
    const binProblem = h('p', { class: 'dialog-problem', role: 'alert' });
    const binNote = h('p', { class: 'hint' });
    const showBin = () => {
      clearSel.value = bin.clear;
      daysIn.value = String(bin.days);
      limitIn.value = String(bin.limitMb);
      daysIn.disabled = bin.clear !== 'days';
      binNote.textContent =
        (bin.clear === 'days' ? `Deleted items are kept ${bin.days} day${bin.days === 1 ? '' : 's'}, then deleted for good. ` : bin.clear === 'daily' ? 'Items deleted before today are deleted for good each day. ' : 'Deleted items stay until you empty the Recycle Bin. ') +
        `An item over ${bin.limitMb} MB is not kept: you are asked, and it is then deleted for good.`;
    };
    on(clearSel, 'change', () => {
      const before = { ...bin };
      bin.clear = clearSel.value as typeof bin.clear;
      void shell.applyBinPolicy(true).then(ok => {
        if (!ok) Object.assign(bin, before);
        else shell.session.touch();
        showBin();
      });
    }, app.signal);
    on(daysIn, 'change', () => {
      const n = Number(daysIn.value);
      if (!Number.isInteger(n) || n < 1 || n > BIN_DAYS_MAX) {
        binProblem.textContent = `Choose a whole number of days from 1 to ${BIN_DAYS_MAX}.`;
        return showBin();
      }
      binProblem.textContent = '';
      const before = bin.days;
      bin.days = n;
      void shell.applyBinPolicy(true).then(ok => {
        if (!ok) bin.days = before;
        else shell.session.touch();
        showBin();
      });
    }, app.signal);
    on(limitIn, 'change', () => {
      const n = Number(limitIn.value);
      if (!Number.isInteger(n) || n < BIN_LIMIT_MIN_MB || n > BIN_LIMIT_MAX_MB) {
        binProblem.textContent = `The size limit can be from ${BIN_LIMIT_MIN_MB} MB to ${BIN_LIMIT_MAX_MB} MB (4 GB).`;
        return showBin();
      }
      binProblem.textContent = '';
      bin.limitMb = n;
      shell.session.touch();
      showBin();
    }, app.signal);
    showBin();

    // ---- Colour scheme ----
    const themes = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Colour scheme' });
    const drawThemes = () => {
      const now = shell.session.data.theme;
      themes.replaceChildren(...THEMES.map(t => {
        const b = h('button', { type: 'button', class: `swatch theme-swatch${t.id === now ? ' on' : ''}`, role: 'radio', 'aria-checked': String(t.id === now), 'data-theme-sample': t.id }, h('span', { class: 'swatch-chip' }), t.name);
        b.addEventListener('click', () => {
          shell.setTheme(t.id);
          drawThemes();
        }, { signal: app.signal });
        return b;
      }));
    };
    drawThemes();

    // ---- Chat and AI history ----
    // Chat's messages live on the server: how long they are kept is the owner's choice, for everyone. AI chats are each
    // person's own files (Documents › AI chats), so each person chooses.
    const dayChoices = (never: string) => [0, 3, 7, 30].map(d => h('option', { value: String(d) }, d ? `${d} days` : never));
    const vanishPick = h('select', { class: 'field', 'aria-label': 'Chat messages vanish after', disabled: true }, ...dayChoices('Never (kept until deleted)'));
    const vanishNote = h('p', { class: 'hint', role: 'status' });
    const aiPick = h('select', { class: 'field', 'aria-label': 'Clear my AI chats after' }, ...dayChoices('Never'));
    const aiNote = h('p', { class: 'hint', role: 'status' });
    aiPick.value = String(shell.session.data.aiHistoryDays);
    const chatApi = shell.account ? new ServiceApi(shell.account.api.base, 'chat') : null;
    if (chatApi) {
      void chatApi.call<{ vanishDays: number; owner: boolean }>('settings').then(r => {
        vanishPick.value = String(r.vanishDays);
        vanishPick.disabled = !r.owner;
        vanishNote.textContent = r.owner ? 'For everyone on this desktop. Older messages are deleted from the server.' : 'Set by the owner of this desktop, for everyone.';
      }).catch(() => (vanishNote.textContent = 'Chat is not reachable just now.'));
      on(vanishPick, 'change', async () => {
        const days = Number(vanishPick.value);
        const putBack = () => void chatApi.call<{ vanishDays: number }>('settings').then(r => (vanishPick.value = String(r.vanishDays)));
        const who = await askIdentity(shell, days
          ? { title: `Messages vanish after ${days} days?`, text: `Chat messages older than ${days} days are deleted from the server now, and from then on, for everyone on this desktop. This cannot be undone.`, ok: 'Delete old messages', danger: true, signal: app.signal }
          : { title: 'Keep messages until someone deletes them?', text: 'For everyone on this desktop.', ok: 'Keep them', signal: app.signal });
        if (!who) {
          putBack();
          return;
        }
        try {
          await chatApi.call('settings', { body: { vanishDays: days, ...who } });
          vanishNote.textContent = days ? `Saved: messages vanish after ${days} days.` : 'Saved: messages are kept until someone deletes them.';
        } catch (error) {
          vanishNote.textContent = error instanceof Error ? error.message : 'It could not be saved.';
          putBack();
        }
      }, app.signal);
    }
    on(aiPick, 'change', async () => {
      const days = Number(aiPick.value);
      const before = shell.session.data.aiHistoryDays;
      if (days) {
        const ok = await shell.dialogs.confirm({ title: `Clear AI chats after ${days} days?`, text: `Your conversations in Chat › Agents (kept in Documents › AI chats) that have not changed for ${days} days are deleted for good, now and from then on. They do not go to the Recycle Bin.`, ok: 'Clear old AI chats', danger: true });
        if (!ok) {
          aiPick.value = String(before);
          return;
        }
      }
      shell.session.data.aiHistoryDays = days;
      shell.session.touch();
      try {
        const n = await clearOldThreads(shell.fs, days);
        aiNote.textContent = days ? `Saved. ${n ? `${n} old AI chat${n === 1 ? ' was' : 's were'} deleted.` : 'None were old enough to delete yet.'}` : 'Saved: AI chats are kept until you delete them.';
      } catch (error) {
        aiNote.textContent = error instanceof Error ? error.message : 'Old AI chats could not be deleted just now; they will be at the next start.';
      }
    }, app.signal);

    const lockLink = h('button', { type: 'button', class: 'btn' }, 'Open My account');
    const aiHead = h('h2', { class: 'set-h', id: `${app.id}-ai` }, 'AI');

    // The front page, for the owner: what anyone not signed in sees (auth/gate.ts). The Reader shows only Sherlock Holmes;
    // everything else needs a sign-in.
    const account = shell.account;
    const frontPick = h('select', { class: 'field', 'aria-label': 'Before anyone signs in' },
      h('option', { value: 'reader' }, 'The Reader: Sherlock Holmes, and Log in for more'),
      h('option', { value: 'signin' }, 'The TOMLIN OS sign-in'));
    const frontNote = h('p', { class: 'hint', role: 'status' });
    const frontBox = account?.user().admin ? h('div', {},
      h('label', { class: 'bin-set' }, 'Before anyone signs in, the site shows ', frontPick),
      h('p', { class: 'hint' }, 'With the Reader, someone who finds this site, or a search engine’s robot, sees only an old book. Log in for more, in its corner, brings up the sign-in. Your own books and the Gutenberg library need a sign-in.'),
      frontNote) : null;
    if (account && frontBox) {
      void account.api.status().then(st => { frontPick.value = st.front ?? 'reader'; }).catch(() => undefined);
      on(frontPick, 'change', async () => {
        try {
          await account.api.setFront(frontPick.value as 'reader' | 'signin');
          frontNote.textContent = frontPick.value === 'reader' ? 'Saved: visitors see the Reader.' : 'Saved: visitors see the sign-in.';
        } catch (error) {
          frontNote.textContent = error instanceof Error ? error.message : 'It could not be saved.';
        }
      }, app.signal);
    }
    on(lockLink, 'click', () => void shell.openApp('account'), app.signal);
    app.root.append(
      h('h2', { class: 'set-h' }, 'Background picture'),
      pictures,
      note,
      h('h2', { class: 'set-h' }, 'Background colour'),
      swatches,
      h('label', { class: 'custom-row' }, 'Your own colour ', custom),
      h('h2', { class: 'set-h' }, 'Colour scheme'),
      themes,
      h('p', { class: 'hint' }, 'Title bars, the taskbar and the Start menu. Standard is the look of Debian with Xfce; Glass has a see-through taskbar and glassy title bars; Flat is flat and square with one blue accent; Classic blue, Olive green and Silver have shaded title bars in those colours; Dark also darkens the inside of windows.'),
      h('h2', { class: 'set-h' }, 'Screensaver and lock'),
      ...saverControls(shell, app.signal),
      ...(frontBox ? [frontBox] : []),
      h('p', { class: 'hint' }, 'Your PIN, password and two-step sign-in are in My account.'),
      lockLink,
      aiHead,
      aiSettings(shell, app.signal),
      h('h2', { class: 'set-h' }, 'Chat and AI history'),
      ...(chatApi ? [h('label', { class: 'bin-set' }, 'Internal chat messages vanish after ', vanishPick), vanishNote] : []),
      h('label', { class: 'bin-set' }, 'Clear my AI chats after ', aiPick),
      aiNote,
      h('h2', { class: 'set-h' }, 'Recycle Bin'),
      h('label', { class: 'bin-set' }, 'Clearing ', clearSel),
      h('label', { class: 'bin-set' }, 'Days to keep ', daysIn),
      h('label', { class: 'bin-set' }, `Size limit (${BIN_LIMIT_MIN_MB}–${BIN_LIMIT_MAX_MB} MB) `, limitIn, ' MB'),
      binProblem,
      binNote,
      h('h2', { class: 'set-h' }, 'Storage'),
      h('p', {}, `Your files are kept in ${shell.storeLabel}.`),
      h('p', { class: 'hint' }, `Deleting a file moves it to the Recycle Bin. The only automatic deleting is what is set above: the Recycle Bin clearing, AI chats cleared after the days you chose${chatApi ? ', and Chat messages when they are set to vanish (by the owner, for everyone)' : ''}. Restarting only reloads the page.`),
    );
    drawSwatches();
    if (arg === 'ai') requestAnimationFrame(() => aiHead.scrollIntoView({ block: 'start' }));
    // Opened again while open (Chat's "AI keys..."): to the AI section, as on a first opening.
    app.onReopen(next => {
      if (next === 'ai') aiHead.scrollIntoView({ block: 'start' });
    });
    await drawPictures();
  },
};
