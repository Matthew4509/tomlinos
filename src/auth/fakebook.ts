// The made-up workbook behind the spreadsheet screensaver (and the setup guide's small picture of it): the kind's
// heading, columns, rows, formulas and formats, in a real Workbook so its sums and number formats are the real ones.
import { Workbook } from '../apps/sheet/workbook.ts';
import type { SheetKind } from '../shell/session.ts';
import { COLS, KINDS, sheetTitle } from './sheetkinds.ts';

export function fakeWorkbook(kindId: SheetKind, title: string): Workbook {
  const k = KINDS[kindId] ?? KINDS.budget;
  const name = sheetTitle(kindId, title);
  const wb = new Workbook();
  wb.renameSheet(0, name.slice(0, 31));
  wb.addSheet();
  wb.renameSheet(1, k.tabs[0]);
  wb.addSheet();
  wb.renameSheet(2, k.tabs[1]);
  wb.active = 0;
  const s = 0;
  const put = (addr: string, text: string) => {
    const col = COLS.indexOf(addr[0]);
    const row = Number(addr.slice(1)) - 1;
    wb.setInput(s, col, row, text);
  };
  put('A1', k.heading);
  put('A3', k.first);
  k.columns.forEach((t, i) => put(`${COLS[i + 1]}3`, t));
  k.rows.forEach(([label, base], i) => {
    const r = i + 4;
    put(`A${r}`, label);
    for (const c of k.typed) put(`${COLS[c]}${r}`, String(k.value(base, c)));
    for (const [col, f] of Object.entries(k.formulas(r))) put(`${col}${r}`, f);
  });
  const last = k.rows.length + 3;
  const total = last + 2;
  put(`A${total}`, 'Total');
  for (const c of k.total) put(`${c}${total}`, `=SUM(${c}4:${c}${last})`);

  const all = (c0: number, r0: number, c1: number, r1: number) => ({ c0, r0, c1, r1 });
  wb.setStyle(s, all(0, 0, 0, 0), st => ({ ...st, b: true }));
  wb.setStyle(s, all(0, 2, 7, 2), st => ({ ...st, b: true, fill: '#dbe9df', bb: true }));
  wb.setStyle(s, all(1, 2, 7, 2), st => ({ ...st, al: 'r' }));
  for (const [c0, c1, fmt] of k.formats) wb.setStyle(s, all(c0, 3, c1, total - 1), st => ({ ...st, fmt, dec: fmt === 'percent' ? 1 : fmt === 'currency' ? 2 : kindId === 'timesheet' ? 2 : 0 }));
  wb.setStyle(s, all(0, total - 1, 7, total - 1), st => ({ ...st, b: true, bt: true }));
  wb.setSize(s, 'col', 0, 170);
  for (let c = 1; c <= 7; c++) wb.setSize(s, 'col', c, 96);
  return wb;
}
