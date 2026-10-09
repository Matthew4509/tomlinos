// The screensaver and lock controls. One copy, shown in two places: Settings (where people look first: right-click the
// desktop > Desktop Settings) and My account. Both write the same session.lock, so they always agree.
//
// Laid out as a guide, with a preview: 1 what shows when you step away (the
// spreadsheet's kind and title, or the reader), 2 how the lock screen looks (default, plain or your own words), 3 try it
// (Preview locks nothing), 4 how to get back in, which changes with the choices. Then when it starts and the keys.
import { h, on } from '../core/dom.ts';
import { localStatus } from '../core/local.ts';
import { READER_PATH } from '../auth/lock.ts';
import { IDLE_CHOICES, LOCK_WORDS_MAX, SHEET_KINDS, type LockWords, type SheetKind } from './session.ts';
import type { Shell } from './types.ts';

export function saverControls(shell: Shell, signal: AbortSignal): Node[] {
  const lock = shell.session.data.lock;
  const canLock = shell.lock.canLock;
  const idle = h('select', { class: 'field' }, ...IDLE_CHOICES.map(m => h('option', { value: m }, m === 0 ? 'Never' : m === 60 ? 'After 1 hour' : `After ${m} minute${m === 1 ? '' : 's'}`)));
  idle.value = String(lock.idle);
  const saver = h('select', { class: 'field' },
    h('option', { value: 'sheet' }, 'Spreadsheet (looks like ordinary work)'),
    h('option', { value: 'reader' }, 'Reader (a book; "Log in for more" to get back)'),
    h('option', { value: 'clock' }, 'Clock'),
    h('option', { value: 'blank' }, 'Blank screen'));
  saver.value = lock.saver;
  const kind = h('select', { class: 'field' }, ...SHEET_KINDS.map(k => h('option', { value: k.id }, k.name)));
  kind.value = lock.sheet.kind;
  const sheetTitle = h('input', { type: 'text', class: 'field', maxlength: LOCK_WORDS_MAX, spellcheck: false });
  sheetTitle.value = lock.sheet.title;
  const sheetRow = h('div', { class: 'saver-sub' },
    h('label', { class: 'bin-set' }, 'Kind of work ', kind),
    h('label', { class: 'bin-set' }, 'Its title ', sheetTitle));
  const readerNote = h('p', { class: 'hint', hidden: true });

  const look = h('select', { class: 'field' },
    h('option', { value: 'default' }, 'TOMLIN OS (the name and yours)'),
    h('option', { value: 'plain' }, 'Plain ("Session timed out", no names)'),
    h('option', { value: 'custom' }, 'My own words'));
  look.value = lock.look;
  const wordField = (key: keyof LockWords) => {
    const f = h('input', { type: 'text', class: 'field', maxlength: LOCK_WORDS_MAX, spellcheck: false });
    f.value = lock.words[key];
    return f;
  };
  const words = { title: wordField('title'), user: wordField('user'), pass: wordField('pass'), button: wordField('button') };
  const wordsRow = h('div', { class: 'saver-sub' },
    h('label', { class: 'bin-set' }, 'Heading ', words.title),
    h('label', { class: 'bin-set' }, 'User name label ', words.user),
    h('label', { class: 'bin-set' }, 'Password label ', words.pass),
    h('label', { class: 'bin-set' }, 'Button ', words.button));

  const lockBox = h('input', { type: 'checkbox', disabled: !canLock });
  lockBox.checked = lock.lock && canLock;
  const panic = h('input', { type: 'checkbox' });
  panic.checked = lock.panic;
  const hintBox = h('input', { type: 'checkbox' });
  hintBox.checked = lock.hint === true;
  const wayBack = h('p', { class: 'hint saver-way' });

  function paint(): void {
    sheetRow.hidden = saver.value !== 'sheet';
    sheetTitle.placeholder = SHEET_KINDS.find(k => k.id === kind.value)?.title ?? '';
    wordsRow.hidden = look.value !== 'custom';
    readerNote.hidden = saver.value !== 'reader';
    const w = look.value === 'custom' ? lock.words : null;
    const title = w ? `"${w.title}"` : look.value === 'plain' ? '"Session timed out"' : 'the TOMLIN OS lock screen';
    const pin = shell.account?.user().pin;
    wayBack.textContent = !canLock
      ? 'Locking needs the desktop running on its server with accounts; here the screensaver only covers the screen.'
      : saver.value === 'sheet'
        ? `On the spreadsheet: ${pin ? 'type your PIN and press Enter (nothing appears while you type), or ' : ''}press Escape or the spreadsheet's close button (✕) to get ${title}, then your ${pin ? 'PIN or password' : 'password'}.`
        : saver.value === 'reader'
          ? `On the reader: press "Log in for more" in its top corner, then type your user name (${shell.account?.user().name ?? 'the one you sign in with'}) and your password. Escape does nothing there, so it gives nothing away.`
          : `Move the mouse or press a key to get ${title}, then your ${pin ? 'PIN or password' : 'password'}.`;
  }

  const save = () => {
    lock.idle = Number(idle.value);
    if (lock.saver !== saver.value) lock.chosen = true;
    lock.saver = saver.value as typeof lock.saver;
    lock.sheet = { kind: kind.value as SheetKind, title: sheetTitle.value.replace(/\s+/g, ' ').trim().slice(0, LOCK_WORDS_MAX) };
    lock.look = look.value as typeof lock.look;
    for (const k of Object.keys(words) as Array<keyof LockWords>) lock.words[k] = words[k].value.replace(/\s+/g, ' ').trim().slice(0, LOCK_WORDS_MAX) || lock.words[k];
    lock.lock = lockBox.checked;
    lock.panic = panic.checked;
    lock.hint = hintBox.checked;
    shell.session.touch();
    shell.applyLockHint();
    paint();
  };
  for (const el of [idle, saver, kind, look, lockBox, panic, hintBox]) on(el, 'change', save, signal);
  for (const el of [sheetTitle, ...Object.values(words)]) on(el, 'change', save, signal);
  const button = (label: string, run: () => void, cls = 'btn') => {
    const b = h('button', { type: 'button', class: cls }, label);
    on(b, 'click', run, signal);
    return b;
  };
  // A copy without the Reader shows the spreadsheet in its place; say so rather than let the preview surprise.
  void localStatus(READER_PATH).then(status => {
    readerNote.textContent = status === 200
      ? 'The book opens where the Reader was last left.'
      : 'The Reader is not in this copy of TOMLIN OS yet: the spreadsheet shows in its place until it is.';
  });
  paint();
  const step = (n: number, title: string, ...kids: Node[]) => h('div', { class: 'saver-step' }, h('h3', { class: 'saver-step-h' }, `${n}. ${title}`), ...kids);
  return [
    h('p', { class: 'hint' }, 'Set up how your screen hides when you step away, so anyone passing sees ordinary work, not TOMLIN OS.'),
    step(1, 'What shows when you step away',
      h('label', { class: 'bin-set' }, 'Screensaver ', saver), sheetRow, readerNote),
    step(2, 'The lock screen',
      h('label', { class: 'bin-set' }, 'Looks like ', look), wordsRow),
    step(3, 'Try it',
      h('p', { class: 'hint' }, 'Preview shows exactly what others will see. Nothing is locked: any way back, or "Close preview", ends it.'),
      h('div', { class: 'acct-buttons' }, button('Preview', () => shell.lock.preview(), 'btn primary'))),
    step(4, 'How to get back in', wayBack),
    h('h3', { class: 'saver-step-h' }, 'When it starts'),
    h('label', { class: 'bin-set' }, 'Start the screensaver ', idle),
    h('label', { class: 'check-row' }, lockBox, ' Lock when the screensaver starts'),
    h('label', { class: 'check-row' }, panic, ' Escape twice, quickly: show the spreadsheet and lock at once'),
    h('p', { class: 'hint' }, canLock ? 'Alt+L locks at any time, and so does the padlock by the clock. Alt+Shift+L (or right-click the padlock) signs out and shows the book.' : ''),
    ...(canLock ? [h('label', { class: 'check-row' }, hintBox, ' Show these keys small on the desktop background (anyone passing can read it too)')] : []),
    h('div', { class: 'acct-buttons' },
      button('Show the screensaver now', () => void shell.lock.show(false)),
      ...(canLock ? [button('Lock now (Alt+L)', () => void shell.lock.show(true), 'btn primary')] : []),
    ),
  ];
}
