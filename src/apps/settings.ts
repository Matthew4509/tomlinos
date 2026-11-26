// Settings: the wallpaper (a plain colour by default; your own colour or one of your pictures), the colour scheme, the
// screensaver, the AI (the built-in model and keys for AI services: assistant/aisettings.ts), the Recycle Bin, and where
// the desktop keeps its files. Opened with "ai" it starts at the AI section. Nothing here can erase files.
import { askIdentity } from '../auth/identity.ts';
import { h, on, type Child } from '../core/dom.ts';
import { icon, type IconName } from '../shell/icons.ts';
import { infoTip, setInfoTip } from '../shell/infotip.ts';
import { THEMES, BIN_DAYS_MAX, BIN_LIMIT_MAX_MB, BIN_LIMIT_MIN_MB, DEFAULT_COLOUR, WALLPAPER_COLOURS } from '../shell/session.ts';
import { extensionOf } from '../shell/filetypes.ts';
import type { AppDef } from '../shell/types.ts';
import { saverControls } from '../shell/saverform.ts';
import { aiSettings } from './assistant/aisettings.ts';
import { APPS } from './catalog.ts';
import { ServiceApi } from '../net/service.ts';
import { clearOldThreads } from './chat/agents.ts';

export const PICTURE_TYPES = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp'];

/** One section of Settings: its picture on the left and its settings as short lines beside it. */
const tile = (pic: IconName, ...lines: Child[]) => h('div', { class: 'bin-tile' },
  h('span', { class: 'bin-tile-pic', 'aria-hidden': 'true' }, icon(pic, 40)),
  h('div', { class: 'bin-tile-lines' }, ...lines));
const line = (...kids: Child[]) => h('div', { class: 'bin-line' }, ...kids);

export const settingsApp: AppDef = {
  ...APPS.settings,
  async launch(app, arg) {
    const shell = app.shell;
    app.root.classList.add('settings');
    const current = () => shell.session.data.wallpaper;

    const swatches = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Background colour' });
    const custom = h('input', { type: 'color', class: 'colour-input', 'aria-label': 'Choose your own colour', value: DEFAULT_COLOUR });
    const pictures = h('div', { class: 'picture-list', role: 'radiogroup', 'aria-label': 'Background picture' });
    const note = h('span', { class: 'hint' });
    const pictureTip = infoTip('background pictures', 'These are the pictures in your Pictures folder (PNG, JPG, GIF, WebP, AVIF or BMP). Put a new one there, then open Settings again. Choosing a colour puts the plain background back.');

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
      pictures.hidden = !rows.length;
      note.textContent = rows.length ? '' : 'none in your Pictures folder yet';
    }

    on(custom, 'change', () => void shell.setWallpaper({ kind: 'colour', value: custom.value.toLowerCase() }).then(drawSwatches), app.signal);

    // ---- Recycle Bin ----
    const bin = shell.session.data.bin;
    // Storage tile: where files are kept and what is deleted by itself, in the days actually chosen.
    const storage = { vanish: null as number | null };
    const storageWhere = h('div', { class: 'bin-line' }, `Your files are kept ${shell.storeLabel.includes('server') ? 'on' : 'in'} ${shell.storeLabel}.`);
    const storageBin = h('div', { class: 'bin-line' });
    const storageChats = h('div', { class: 'bin-line' });
    const paintStorage = () => {
      storageBin.textContent = 'Deleting a file moves it to the Recycle Bin, ' + (bin.clear === 'days' ? `which clears it after ${bin.days} day${bin.days === 1 ? '' : 's'}.` : bin.clear === 'daily' ? 'which clears it the next day.' : 'where it stays until you empty it.');
      const ai = shell.session.data.aiHistoryDays;
      const v = storage.vanish;
      const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;
      storageChats.textContent = v === null
        ? (ai ? `AI chats are deleted after ${days(ai)}.` : 'AI chats are kept until you delete them.')
        : ai && ai === v ? `AI chats and Chat messages are deleted after ${days(ai)}.`
          : `AI chats are ${ai ? `deleted after ${days(ai)}` : 'kept until you delete them'}; Chat messages ${v ? `after ${days(v)}` : 'until someone deletes them'}.`;
    };
    const clearSel = h('select', { class: 'field', 'aria-label': 'Clear old items' },
      h('option', { value: 'days' }, 'after'),
      h('option', { value: 'daily' }, 'every day (from before today)'),
      h('option', { value: 'never' }, 'only when I empty it'),
    );
    const daysIn = h('input', { type: 'number', class: 'field num', min: 1, max: BIN_DAYS_MAX, step: 1, 'aria-label': 'Days to keep deleted items' });
    const limitIn = h('input', { type: 'number', class: 'field num', min: BIN_LIMIT_MIN_MB, max: BIN_LIMIT_MAX_MB, step: 1, 'aria-label': 'Size limit in megabytes' });
    const daysPart = h('span', { class: 'bin-days' }, daysIn, ' days');
    const binProblem = h('p', { class: 'dialog-problem', role: 'alert' });
    const showBin = () => {
      clearSel.value = bin.clear;
      daysIn.value = String(bin.days);
      limitIn.value = String(bin.limitMb);
      daysIn.disabled = bin.clear !== 'days';
      daysPart.hidden = bin.clear !== 'days';
      paintStorage();
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
    const vanishPick = h('select', { class: 'field', 'aria-label': 'Chat messages vanish after', disabled: true }, ...dayChoices('Never'));
    const vanishNote = h('p', { class: 'hint', role: 'status' });
    const EVERYONE = 'This setting is for everyone on this desktop.';
    const vanishTip = infoTip('chat messages vanishing', EVERYONE);
    const aiPick = h('select', { class: 'field', 'aria-label': 'Clear my AI chats after' }, ...dayChoices('Never'));
    const aiNote = h('p', { class: 'hint', role: 'status' });
    aiPick.value = String(shell.session.data.aiHistoryDays);
    new MutationObserver(paintStorage).observe(aiNote, { childList: true, characterData: true, subtree: true });
    const chatApi = shell.account ? new ServiceApi(shell.account.api.base, 'chat') : null;
    if (chatApi) {
      void chatApi.call<{ vanishDays: number; owner: boolean }>('settings').then(r => {
        vanishPick.value = String(r.vanishDays);
        vanishPick.disabled = !r.owner;
        storage.vanish = r.vanishDays;
        paintStorage();
        setInfoTip(vanishTip, r.owner ? EVERYONE : `${EVERYONE} Only the owner can change it.`);
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
          storage.vanish = days;
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

    const lockLink = h('button', { type: 'button', class: 'btn' }, 'Manage my account');
    const aiHead = h('h2', { class: 'set-h', id: `${app.id}-ai` }, 'AI');

    // The front page, for the owner: what anyone not signed in sees (auth/gate.ts). The Reader shows only Sherlock Holmes;
    // everything else needs a sign-in.
    const account = shell.account;
    const frontPick = h('select', { class: 'field', 'aria-label': 'Before anyone signs in' },
      h('option', { value: 'reader' }, 'The Reader: Sherlock Holmes, and Log in for more'),
      h('option', { value: 'signin' }, 'The TOMLIN OS sign-in'));
    const frontNote = h('p', { class: 'hint', role: 'status' });
    const frontBox = account?.user().admin ? h('div', {},
      line(h('label', { class: 'bin-line' }, 'Before anyone signs in, show ', frontPick),
        infoTip('what visitors see', 'With the Reader, someone who finds this site, or a search engine’s robot, sees only an old book; Log in for more, in its corner, brings up the sign-in. Your own books and the Gutenberg library need a sign-in.')),
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
      h('h2', { class: 'set-h' }, 'Background'),
      tile('image',
        swatches,
        h('label', { class: 'bin-line' }, 'Your own colour ', custom),
        line('Or one of your pictures ', note, pictureTip),
        pictures),
      h('h2', { class: 'set-h' }, 'Colour scheme ', infoTip('the colour schemes', 'A scheme colours the title bars, the taskbar and the Start menu. Standard is the look of Debian with Xfce; Glass has a see-through taskbar; Flat is flat and square with one blue accent; Classic blue, Olive green and Silver have shaded title bars; Dark also darkens the inside of windows.')),
      tile('app', themes),
      h('h2', { class: 'set-h' }, 'Screensaver and lock'),
      ...saverControls(shell, app.signal),
      h('h2', { class: 'set-h' }, 'Signing in'),
      tile('user',
        ...(frontBox ? [frontBox] : []),
        line('PIN, password and two-step sign-in ', lockLink)),
      aiHead,
      h('div', { class: 'bin-tile tall' },
        h('span', { class: 'bin-tile-pic', 'aria-hidden': 'true' }, icon('assistant', 40)),
        h('div', { class: 'bin-tile-lines' }, aiSettings(shell, app.signal))),
      h('h2', { class: 'set-h' }, 'Chat and AI history'),
      tile('chat',
        h('label', { class: 'bin-line' }, 'Clear my AI chats after ', aiPick),
        aiNote,
        ...(chatApi ? [line(h('label', { class: 'bin-line' }, 'Internal chat messages vanish after ', vanishPick), vanishTip), vanishNote] : [])),
      h('h2', { class: 'set-h' }, 'Recycle Bin'),
      tile('trash',
        line('Delete items for good ', clearSel, ' ', daysPart),
        line('Items over ', limitIn, ' MB: ask, then delete for good ', infoTip('the size limit', `The limit can be from ${BIN_LIMIT_MIN_MB} MB to ${BIN_LIMIT_MAX_MB} MB (4 GB). Deleting anything bigger asks first, because it cannot go to the Recycle Bin.`)),
        binProblem),
      h('h2', { class: 'set-h' }, 'Storage'),
      h('div', { class: 'bin-tile' },
        h('span', { class: 'bin-tile-pic', 'aria-hidden': 'true' }, icon('files', 40)),
        h('div', { class: 'bin-tile-lines', role: 'status' }, storageWhere, storageBin, storageChats)),
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
