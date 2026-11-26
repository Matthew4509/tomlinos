// The screensaver and lock controls. One copy, shown in two places: Settings (where people look first: right-click the
// desktop > Desktop Settings) and My account. Both write the same session.lock, and each tells the other when it saved,
// so they always agree.
//
// Laid out as a guide: 1 what shows when you step away and 2 how the lock screen looks, each a row of small pictures of
// the real thing to pick from (a pick is only a choice until that step's Save keeps it; leaving without saving changes
// nothing), 3 try it (Preview locks nothing), 4 how to get back in, a small picture with a red ring round the place to
// press, which changes with the choices and opens to the words. Then the screensaver / lock screen tile (when it starts
// and the keys), which keeps itself as soon as it changes.
import { Bus } from '../core/bus.ts';
import { css, h, on } from '../core/dom.ts';
import { localStatus } from '../core/local.ts';
import { READER_PATH } from '../auth/lock.ts';
import { blankMini, clockLockPic, clockMini, lockMini, MINI_H, MINI_W, readerMini, RING_AT, ringMini, sheetMini, tileGroup } from './saverminis.ts';
import { IDLE_CHOICES, LOCK_WORDS_MAX, SHEET_KINDS, type LockSettings, type LockWords, type SheetKind } from './session.ts';
import type { Shell } from './types.ts';

/** Which part of session.lock one copy of the form just saved, so the other copy (Settings or My account) catches up. */
const saved = new Bus<{ from: object; part: 'saver' | 'look' | 'other' }>();

const tidy = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, LOCK_WORDS_MAX);

export function saverControls(shell: Shell, signal: AbortSignal): Node[] {
  const me = {};
  const lock = shell.session.data.lock;
  const canLock = shell.lock.canLock;
  const user = () => shell.account?.user() ?? null;
  const idle = h('select', { class: 'field' }, ...IDLE_CHOICES.map(m => h('option', { value: m }, m === 0 ? 'Never' : m === 60 ? 'After 1 hour' : `After ${m} minute${m === 1 ? '' : 's'}`)));
  const lockBox = h('input', { type: 'checkbox', disabled: !canLock });
  const panic = h('input', { type: 'checkbox' });
  const hintBox = h('input', { type: 'checkbox' });
  const showOthers = () => {
    idle.value = String(lock.idle);
    lockBox.checked = lock.lock && canLock;
    panic.checked = lock.panic;
    hintBox.checked = lock.hint === true;
  };
  showOthers();
  const wayBack = h('p', { class: 'hint saver-way' });

  // ---- 4. How to get back in: a small picture of the saved screensaver with a red ring round the place to press (or of
  // the lock screen it leads to); "Show more" opens a bigger one with the words.
  const wayScreen = () => {
    const s = h('div', { class: 'mini-screen' });
    css(s, { width: MINI_W, height: MINI_H });
    return s;
  };
  const waySmall = wayScreen();
  const wayLarge = wayScreen();
  let wayKey = '';
  let wayClock: AbortController | null = null;
  signal.addEventListener('abort', () => wayClock?.abort(), { once: true });
  const wayPicture = (): Node[] => {
    if (lock.saver === 'sheet') return [sheetMini(lock.sheet.kind, lock.sheet.title), ...(canLock ? [ringMini(RING_AT.sheet)] : [])];
    if (lock.saver === 'reader') return [readerMini(), ...(canLock ? [ringMini(RING_AT.reader)] : [])];
    if (canLock) return [lockMini(lock.look, lock.words, user())];
    if (lock.saver === 'clock') return [clockMini((wayClock ??= new AbortController()).signal)];
    return [blankMini()];
  };
  const drawWay = () => {
    const u = user();
    const key = JSON.stringify([lock.saver, lock.sheet, lock.look, lock.words, u?.display, !!u?.pin, !!u?.totp]);
    if (key === wayKey) return;
    wayKey = key;
    wayClock?.abort();
    wayClock = null;
    waySmall.replaceChildren(...wayPicture());
    wayLarge.replaceChildren(...wayPicture());
  };
  const wayPanel = h('div', { class: 'saver-way-more', id: `saver-way-${Math.random().toString(36).slice(2)}`, hidden: true },
    h('div', { class: 'mini-view saver-way-big', 'aria-hidden': 'true', inert: true }, wayLarge), wayBack);
  const wayToggle = h('button', { type: 'button', class: 'btn saver-way-btn', 'aria-expanded': 'false', 'aria-controls': wayPanel.id }, '⤢ Show more');
  const wayTile = h('div', { class: 'mini-tile saver-way-tile' },
    h('div', { class: 'mini-view', 'aria-hidden': 'true', inert: true }, waySmall),
    h('span', { class: 'mini-name' }, h('h3', { class: 'saver-step-h saver-way-h' }, '4. How to get back in'), wayToggle));
  on(wayTile, 'click', () => {
    const open = wayPanel.hidden;
    wayPanel.hidden = !open;
    wayToggle.setAttribute('aria-expanded', String(open));
    wayToggle.textContent = open ? '⤡ Show less' : '⤢ Show more';
  }, signal);

  // ---- 1. What shows when you step away
  const kind = h('select', { class: 'field' }, ...SHEET_KINDS.map(k => h('option', { value: k.id }, k.name)));
  const sheetTitle = h('input', { type: 'text', class: 'field', maxlength: LOCK_WORDS_MAX, spellcheck: false });
  const showSheet = () => {
    kind.value = lock.sheet.kind;
    sheetTitle.value = lock.sheet.title;
  };
  showSheet();
  const sheetRow = h('div', { class: 'saver-sub' },
    h('label', { class: 'bin-set' }, 'Kind of work ', kind),
    h('label', { class: 'bin-set' }, 'Its title ', sheetTitle));
  const readerNote = h('p', { class: 'hint', hidden: true });
  /** Whether this copy has the Reader: unknown until asked; without it the spreadsheet shows in its place. */
  let hasReader: boolean | null = null;
  let clockView: AbortController | null = null;
  signal.addEventListener('abort', () => clockView?.abort(), { once: true });
  const sheetNow = () => sheetMini(kind.value as SheetKind, tidy(sheetTitle.value));
  const savers = tileGroup<LockSettings['saver']>('Screensaver', [
    { value: 'sheet', name: 'Spreadsheet', draw: sheetNow },
    { value: 'reader', name: 'Reader', draw: () => (hasReader === false ? sheetNow() : readerMini()) },
    {
      value: 'clock', name: 'Clock', draw: () => {
        clockView?.abort();
        clockView = new AbortController();
        return clockMini(clockView.signal);
      },
    },
    { value: 'blank', name: 'Blank screen', draw: blankMini },
  ], lock.saver, signal, () => paint());
  const saverDirty = () => savers.value !== lock.saver
    || (savers.value === 'sheet' && (kind.value !== lock.sheet.kind || tidy(sheetTitle.value) !== lock.sheet.title));

  // ---- 2. The lock screen
  const wordField = () => h('input', { type: 'text', class: 'field', maxlength: LOCK_WORDS_MAX, spellcheck: false });
  const words = { title: wordField(), user: wordField(), pass: wordField(), button: wordField() };
  const keys = Object.keys(words) as Array<keyof LockWords>;
  const showWords = () => {
    for (const k of keys) words[k].value = lock.words[k];
  };
  showWords();
  /** The words as they would be kept: tidied, and an emptied one keeps the word it had. */
  const typedWords = (): LockWords => {
    const w = { ...lock.words };
    for (const k of keys) w[k] = tidy(words[k].value) || lock.words[k];
    return w;
  };
  const wordsRow = h('div', { class: 'saver-sub' },
    h('label', { class: 'bin-set' }, 'Heading ', words.title),
    h('label', { class: 'bin-set' }, 'User name label ', words.user),
    h('label', { class: 'bin-set' }, 'Password label ', words.pass),
    h('label', { class: 'bin-set' }, 'Button ', words.button));
  const looks = tileGroup<LockSettings['look']>('Lock screen', [
    { value: 'default', name: 'TOMLIN OS', draw: () => lockMini('default', lock.words, user()) },
    { value: 'plain', name: 'Plain', draw: () => lockMini('plain', lock.words, user()) },
    { value: 'custom', name: 'My own words', draw: () => lockMini('custom', typedWords(), user()) },
  ], lock.look, signal, () => paint());
  const lookDirty = () => looks.value !== lock.look
    || (looks.value === 'custom' && keys.some(k => typedWords()[k] !== lock.words[k]));

  const button = (label: string, run: () => void, cls = 'btn', attrs: Record<string, string> = {}) => {
    const b = h('button', { type: 'button', class: cls, ...attrs }, label);
    on(b, 'click', run, signal);
    return b;
  };
  /** A Save button with its "Saved." beside it, which goes again after a moment. */
  const saveRow = (what: string, run: () => void) => {
    const done = h('span', { class: 'hint mini-saved', role: 'status' });
    let timer = 0;
    const b = button('Save', () => {
      run();
      done.textContent = 'Saved.';
      clearTimeout(timer);
      timer = window.setTimeout(() => (done.textContent = ''), 2500);
    }, 'btn primary', { 'aria-label': `Save the ${what}` });
    signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
    return { b, row: h('div', { class: 'acct-buttons mini-save' }, b, done) };
  };
  const saveSaver = saveRow('screensaver', () => {
    if (lock.saver !== savers.value) lock.chosen = true;
    lock.saver = savers.value;
    if (savers.value === 'sheet') lock.sheet = { kind: kind.value as SheetKind, title: tidy(sheetTitle.value) };
    sheetTitle.value = lock.sheet.title;
    kept('saver');
  });
  const saveLook = saveRow('lock screen', () => {
    lock.look = looks.value;
    if (looks.value === 'custom') lock.words = typedWords();
    showWords();
    kept('look');
  });

  function kept(part: 'saver' | 'look' | 'other'): void {
    shell.session.touch();
    shell.applyLockHint();
    saved.emit({ from: me, part });
    paint();
  }

  function paint(): void {
    savers.inUse(lock.saver);
    looks.inUse(lock.look);
    sheetRow.hidden = savers.value !== 'sheet';
    sheetTitle.placeholder = SHEET_KINDS.find(k => k.id === kind.value)?.title ?? '';
    readerNote.hidden = savers.value !== 'reader';
    wordsRow.hidden = looks.value !== 'custom';
    saveSaver.b.disabled = !saverDirty();
    saveLook.b.disabled = !lookDirty();
    // The way back is the saved one's: what Preview shows, and what a lock will show.
    const w = lock.look === 'custom' ? lock.words : null;
    const title = w ? `"${w.title}"` : lock.look === 'plain' ? '"Session timed out"' : 'the TOMLIN OS lock screen';
    const pin = user()?.pin;
    wayBack.textContent = !canLock
      ? 'Locking needs the desktop running on its server with accounts; here the screensaver only covers the screen.'
      : lock.saver === 'sheet'
        ? `On the spreadsheet: ${pin ? 'type your PIN and press Enter (nothing appears while you type), or ' : ''}press Escape or the spreadsheet's close button (✕) to get ${title}, then your ${pin ? 'PIN or password' : 'password'}.`
        : lock.saver === 'reader'
          ? `On the reader: press "Log in for more" in its top corner, then type your user name (${user()?.name ?? 'the one you sign in with'}) and your password. Escape does nothing there, so it gives nothing away.`
          : `Move the mouse or press a key to get ${title}, then your ${pin ? 'PIN or password' : 'password'}.`;
    drawWay();
  }

  // The sheet's kind and title and the custom words are kept by their step's Save; the pictures follow them as they change.
  const sheetChanged = () => {
    savers.redraw('sheet');
    if (hasReader === false) savers.redraw('reader');
    paint();
  };
  on(kind, 'change', sheetChanged, signal);
  on(sheetTitle, 'input', sheetChanged, signal);
  for (const el of Object.values(words)) {
    on(el, 'input', () => {
      looks.redraw('custom');
      paint();
    }, signal);
  }

  // Everything else keeps itself as soon as it changes.
  const saveOthers = () => {
    lock.idle = Number(idle.value);
    lock.lock = lockBox.checked;
    lock.panic = panic.checked;
    lock.hint = hintBox.checked;
    kept('other');
  };
  for (const el of [idle, lockBox, panic, hintBox]) on(el, 'change', saveOthers, signal);

  // The other copy saved: show what it kept. A pick not yet saved here, in the part it saved, gives way to it.
  saved.on(({ from, part }) => {
    if (from === me) return;
    if (part === 'saver') {
      savers.pick(lock.saver);
      showSheet();
      savers.redraw();
    } else if (part === 'look') {
      looks.pick(lock.look);
      showWords();
      looks.redraw();
    } else showOthers();
    paint();
  }, signal);

  // A copy without the Reader shows the spreadsheet in its place; say so rather than let the preview surprise.
  void localStatus(READER_PATH).then(status => {
    hasReader = status === 200;
    readerNote.textContent = hasReader
      ? 'The book opens where the Reader was last left.'
      : 'The Reader is not in this copy of TOMLIN OS yet: the spreadsheet shows in its place until it is.';
    if (!hasReader) savers.redraw('reader');
  });
  paint();
  const step = (n: number, title: string, ...kids: Node[]) => h('div', { class: 'saver-step' }, h('h3', { class: 'saver-step-h' }, `${n}. ${title}`), ...kids);
  return [
    h('p', { class: 'hint' }, 'Set up how your screen hides when you step away, so anyone passing sees ordinary work, not TOMLIN OS.'),
    step(1, 'What shows when you step away',
      h('p', { class: 'hint' }, 'Pick a screensaver, then press Save.'),
      savers.el, sheetRow, readerNote, saveSaver.row),
    step(2, 'The lock screen',
      h('p', { class: 'hint' }, 'Pick how the lock screen looks, then press Save.'),
      looks.el, wordsRow, saveLook.row),
    step(3, 'Try it',
      h('p', { class: 'hint' }, 'Preview shows exactly what others will see (what is saved). Nothing is locked: any way back, or "Close preview", ends it.'),
      h('div', { class: 'acct-buttons' }, button('Preview', () => shell.lock.preview(), 'btn primary'))),
    h('div', { class: 'saver-step' }, h('div', { class: 'mini-tiles' }, wayTile), wayPanel),
    h('h3', { class: 'saver-step-h' }, 'Screensaver / lock screen'),
    h('div', { class: 'bin-tile tall saver-start' },
      h('span', { class: 'bin-tile-pic', 'aria-hidden': 'true' }, clockLockPic(40)),
      h('div', { class: 'bin-tile-lines' },
        h('label', { class: 'bin-set' }, 'Start the screensaver ', idle),
        h('label', { class: 'check-row' }, lockBox, ' Lock when the screensaver starts'),
        h('label', { class: 'check-row' }, panic, ' Escape twice, quickly: show the spreadsheet and lock at once'),
        h('p', { class: 'hint' }, canLock ? 'Alt+L locks at any time, and so does the padlock by the clock. Alt+Shift+L (or right-click the padlock) signs out and shows the book.' : ''),
        ...(canLock ? [h('label', { class: 'check-row' }, hintBox, ' Show these keys small on the desktop background (anyone passing can read it too)')] : []),
        h('div', { class: 'acct-buttons' },
          button('Show the screensaver now', () => void shell.lock.show(false)),
          ...(canLock ? [button('Lock now (Alt+L)', () => void shell.lock.show(true), 'btn primary')] : []),
        ))),
  ];
}
