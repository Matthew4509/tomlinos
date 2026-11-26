// The disguise screensaver: a whole-screen spreadsheet of made-up ordinary work (a quarterly budget, a stock list, a
// timesheet or a sales report, with the title the person chose), built from the real spreadsheet's grid so it looks and
// moves like the real thing. Its numbers drift a little now and then, as if someone were working. Nothing in it is saved
// anywhere, and none of it is real data.
import { h } from '../core/dom.ts';
import { createGrid, type Grid } from '../apps/sheet/grid.ts';
import { icon } from '../shell/icons.ts';
import type { SheetKind } from '../shell/session.ts';
import type { Shell } from '../shell/types.ts';
import { fakeWorkbook } from './fakebook.ts';
import { KINDS, sheetTitle } from './sheetkinds.ts';

export { sheetTitle };

export interface FakeSheet {
  el: HTMLElement;
  grid: Grid;
  /** Nudges one number, as a person editing would. */
  drift(): void;
  /** The title bar's close button (the lock screen hangs its way out on it). */
  close: HTMLButtonElement;
  /** What the browser tab and title bar say ("Q3 Budget - Spreadsheet"). */
  windowTitle: string;
}

export function createFakeSheet(shell: Shell, signal: AbortSignal, kindId: SheetKind = 'budget', title = ''): FakeSheet {
  const k = KINDS[kindId] ?? KINDS.budget;
  const name = sheetTitle(kindId, title);
  const wb = fakeWorkbook(kindId, title);
  const s = 0;

  const grid = createGrid(shell, wb, signal);
  grid.formulaInput.readOnly = true;
  grid.nameBox.readOnly = true;
  const fake = (label: string) => h('span', { class: 'rb text-rb', 'aria-hidden': 'true' }, label);
  const group = (gname: string, ...kids: Node[]) => h('div', { class: 'rgroup' }, h('div', { class: 'rgroup-items' }, ...kids), h('div', { class: 'rgroup-name' }, gname));
  // A window's close button, as any spreadsheet has: the way out a person tries first. It brings up the lock screen.
  const close = h('button', { type: 'button', class: 'fake-close', title: 'Close', 'aria-label': 'Close' }, '✕');
  const tabs = [name, ...k.tabs].map((t, i) => h('span', { class: `sheet-tab${i === 0 ? ' active' : ''}` }, t));
  const windowTitle = `${name} - Spreadsheet`;
  const el = h(
    'div',
    { class: 'sheet fake-sheet' },
    h('div', { class: 'fake-titlebar' }, icon('sheet', 16), h('span', {}, windowTitle), close),
    h('div', { class: 'ribbon-tabs' }, h('span', { class: 'file-tab' }, 'File'), h('span', { class: 'home-tab' }, 'Home')),
    h('div', { class: 'ribbon' },
      group('Clipboard', fake('Paste'), fake('Cut'), fake('Copy')),
      group('Font', fake('B'), fake('I'), fake('U')),
      group('Number', fake('$'), fake('%'), fake(',')),
      group('Editing', fake('Σ AutoSum'), fake('A→Z'), fake('Z→A')),
    ),
    h('div', { class: 'formula-bar' }, grid.nameBox, h('span', { class: 'fx', 'aria-hidden': 'true' }, 'fx'), grid.formulaInput),
    grid.el,
    h('div', { class: 'tabs-bar' }, h('div', { class: 'sheet-tabs' }, ...tabs)),
    h('div', { class: 'statusbar sheet-status' }, h('span', { class: 'fake-mode' }, 'Ready'), h('span', { class: 'spacer' }), h('span', {}, '100%')),
  );

  const drift = () => {
    const i = Math.floor(Math.random() * k.rows.length);
    const row = 3 + i;
    const col = k.typed[Math.floor(Math.random() * Math.min(3, k.typed.length))];
    const now = Number(wb.editText(s, col, row)) || k.rows[i][1];
    const next = Math.max(0, now * (0.985 + Math.random() * 0.03));
    wb.setInput(s, col, row, String(kindId === 'timesheet' ? Math.round(next * 4) / 4 : Math.round(next)));
    grid.goTo(col, row);
    grid.redraw();
  };
  return { el, grid, drift, close, windowTitle };
}
