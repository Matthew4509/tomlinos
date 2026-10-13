// Dates, times and number formats, checked against the answers Excel gives: typing a date or time into a cell, the
// date functions (DATE, EDATE, DATEDIF, WEEKDAY, WEEKNUM, NETWORKDAYS, WORKDAY...), Excel format codes in a cell and in
// TEXT(), and the 1900 leap-year day Excel counts. No browser needed. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Workbook } from '../src/apps/sheet/workbook.ts';
import { parseCellRef } from '../src/apps/sheet/refs.ts';
import { codeProblem, formatCode } from '../src/apps/sheet/numfmt.ts';

function book(cells: Record<string, string>, order: 'dmy' | 'mdy' = 'dmy'): Workbook {
  const wb = new Workbook();
  wb.dateOrder = order;
  for (const [addr, text] of Object.entries(cells)) {
    const r = parseCellRef(addr)!;
    wb.setInput(0, r.col, r.row, text);
  }
  return wb;
}
const at = (wb: Workbook, addr: string): string => {
  const r = parseCellRef(addr)!;
  return wb.display(0, r.col, r.row);
};
const raw = (wb: Workbook, addr: string) => {
  const r = parseCellRef(addr)!;
  return wb.value(0, r.col, r.row);
};
const calc = (formula: string, cells: Record<string, string> = {}) => at(book({ ...cells, Z99: formula }), 'Z99');
const value = (formula: string, cells: Record<string, string> = {}) => raw(book({ ...cells, Z99: formula }), 'Z99');
const edit = (wb: Workbook, addr: string) => {
  const r = parseCellRef(addr)!;
  return wb.editText(0, r.col, r.row);
};
const THIS_YEAR = new Date().getFullYear();

test('a typed date is kept as a number of days and shown the way it was typed', () => {
  const wb = book({ A1: '13/10/2026', A2: '2026-10-13', A3: '13 Oct 2026', A4: '13-oct', A5: '1/2', A6: '31/02/2026', A7: 'Oct 13, 2026', A8: 'March 2026' });
  assert.equal(raw(wb, 'A1'), 46308);
  assert.equal(at(wb, 'A1'), '13/10/2026');
  assert.equal(raw(wb, 'A2'), 46308);
  assert.equal(at(wb, 'A2'), '13/10/2026');
  assert.equal(at(wb, 'A3'), '13-Oct-26');
  assert.equal(raw(wb, 'A4'), value(`=DATE(${THIS_YEAR},10,13)`));
  assert.equal(at(wb, 'A4'), '13-Oct');
  // 1/2 is a date, as in Excel (1 February when the day comes first).
  assert.equal(at(wb, 'A5'), '1-Feb');
  // A day that does not exist stays text.
  assert.equal(raw(wb, 'A6'), '31/02/2026');
  assert.equal(raw(wb, 'A7'), 46308);
  assert.equal(at(wb, 'A8'), 'Mar-26');
  assert.equal(raw(wb, 'A8'), value('=DATE(2026,3,1)'));
  // It is edited as a date, and putting that back changes nothing.
  assert.equal(edit(wb, 'A3'), '13/10/2026');
  wb.setInput(0, 0, 2, edit(wb, 'A3'));
  assert.equal(raw(wb, 'A3'), 46308);
  assert.equal(at(wb, 'A3'), '13-Oct-26');
  // Month first, on a computer set that way.
  const us = book({ A1: '10/13/2026', A2: '13/10/2026' }, 'mdy');
  assert.equal(raw(us, 'A1'), 46308);
  assert.equal(at(us, 'A1'), '10/13/2026');
  assert.equal(raw(us, 'A2'), '13/10/2026');
  // Numbers stay numbers; an apostrophe keeps a date as text.
  const plain = book({ A1: '2026', A2: "'13/10/2026" });
  assert.equal(raw(plain, 'A1'), 2026);
  assert.equal(raw(plain, 'A2'), '13/10/2026');
  assert.equal(edit(plain, 'A2'), "'13/10/2026");
});

test('a typed time, and a date with a time', () => {
  const wb = book({ A1: '2:30 PM', A2: '14:30', A3: '14:30:15', A4: '13/10/2026 14:30', A5: '9 am', A6: '35:00' });
  assert.equal(at(wb, 'A1'), '2:30 PM');
  assert.ok(Math.abs((raw(wb, 'A1') as number) - 14.5 / 24) < 1e-12);
  assert.equal(at(wb, 'A2'), '14:30');
  assert.equal(at(wb, 'A3'), '14:30:15');
  assert.equal(at(wb, 'A4'), '13/10/2026 14:30');
  assert.equal(at(wb, 'A5'), '9:00 AM');
  assert.equal(at(wb, 'A6'), '35:00:00');
  assert.equal(edit(wb, 'A1'), '2:30:00 PM');
  assert.equal(edit(wb, 'A4'), '13/10/2026 2:30:00 PM');
  wb.setInput(0, 0, 3, edit(wb, 'A4'));
  assert.ok(Math.abs((raw(wb, 'A4') as number) - (46308 + 14.5 / 24)) < 1e-9);
});

test('DATE, YEAR, MONTH, DAY, TIME, HOUR, MINUTE, SECOND, TODAY, NOW', () => {
  assert.equal(value('=DATE(2026,10,13)'), 46308);
  // The cell shows it as a date.
  assert.equal(calc('=DATE(2026,10,13)'), '13/10/2026');
  // Months and days past their ends roll over.
  assert.equal(value('=DATE(2026,14,1)'), value('=DATE(2027,2,1)'));
  assert.equal(value('=DATE(2026,3,0)'), value('=DATE(2026,2,28)'));
  assert.equal(value('=DATE(126,1,1)'), value('=DATE(2026,1,1)'));
  assert.equal(calc('=DATE(-1,1,1)'), '#NUM!');
  assert.equal(value('=YEAR(46308)'), 2026);
  assert.equal(value('=MONTH("13/10/2026")'), 10);
  assert.equal(value('=DAY(A1)', { A1: '13 Oct 2026' }), 13);
  assert.equal(calc('=YEAR(-1)'), '#NUM!');
  assert.equal(calc('=TIME(14,30,0)'), '2:30 PM');
  assert.equal(value('=TIME(25,0,0)'), value('=TIME(1,0,0)'));
  assert.equal(value('=HOUR("14:30:15")'), 14);
  assert.equal(value('=MINUTE("14:30:15")'), 30);
  assert.equal(value('=SECOND("14:30:15")'), 15);
  const now = new Date();
  const today = Math.round((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - Date.UTC(1899, 11, 30)) / 86_400_000);
  assert.equal(value('=TODAY()'), today);
  const gap = (value('=NOW()-TODAY()') as number);
  assert.ok(gap >= 0 && gap < 1);
});

test('dates in sums, comparisons and conditions; a formula on a date shows a date', () => {
  const t = { A1: '13/10/2026', A2: '1/1/2025', A3: '5/6/2026' };
  assert.equal(value('="13/10/2026"+1'), 46309);
  assert.equal(value('=VALUE("13/10/2026")'), 46308);
  assert.equal(calc('=VALUE("soon")'), '#VALUE!');
  assert.equal(value('=COUNTIF(A1:A3,">"&DATE(2026,1,1))', t), 2);
  assert.equal(value('=COUNTIF(A1:A3,">1/1/2026")', t), 2);
  assert.equal(value('=A1>A3', t), true);
  const wb = book({ ...t, B1: '=A1+7', B2: '=YEAR(A1)', B3: '=MAX(A1:A3)', B4: '=A1-A2' });
  assert.equal(at(wb, 'B1'), '20/10/2026');
  assert.equal(at(wb, 'B2'), '2026');
  assert.equal(at(wb, 'B3'), '13/10/2026');
  // A cell with a format of its own keeps it.
  const kept = book({ B1: '5' });
  kept.setStyle(0, { c0: 1, r0: 0, c1: 1, r1: 0 }, s => ({ ...s, fmt: 'number', dec: 1 }));
  kept.setInput(0, 0, 0, '13/10/2026');
  kept.setInput(0, 1, 0, '=A1+1');
  assert.equal(at(kept, 'B1'), '46309.0');
});

test('EDATE, EOMONTH, DATEDIF, DAYS, DATEVALUE, TIMEVALUE', () => {
  assert.equal(value('=EDATE(DATE(2026,1,31),1)'), value('=DATE(2026,2,28)'));
  assert.equal(value('=EDATE(DATE(2024,3,31),-1)'), value('=DATE(2024,2,29)'));
  assert.equal(value('=EOMONTH(DATE(2026,2,10),0)'), value('=DATE(2026,2,28)'));
  assert.equal(value('=EOMONTH(DATE(2026,2,10),-1)'), value('=DATE(2026,1,31)'));
  assert.equal(value('=EOMONTH("13/10/2026",2)'), value('=DATE(2026,12,31)'));
  const born = 'DATE(2000,5,15)';
  const day = 'DATE(2026,10,13)';
  assert.equal(value(`=DATEDIF(${born},${day},"Y")`), 26);
  assert.equal(value(`=DATEDIF(${born},${day},"M")`), 316);
  assert.equal(value(`=DATEDIF(${born},${day},"YM")`), 4);
  assert.equal(value(`=DATEDIF(${born},${day},"MD")`), 28);
  assert.equal(value(`=DATEDIF(${born},${day},"D")`), 46308 - 36661);
  assert.equal(value(`=DATEDIF(${born},${day},"YD")`), 46308 - 46157);
  assert.equal(calc(`=DATEDIF(${day},${born},"Y")`), '#NUM!');
  assert.equal(calc(`=DATEDIF(${born},${day},"Q")`), '#NUM!');
  assert.equal(value(`=DAYS(${day},${born})`), 46308 - 36661);
  assert.equal(value('=DATEVALUE("13 Oct 2026")'), 46308);
  assert.equal(calc('=DATEVALUE("13 Oct 2026")'), '13/10/2026');
  assert.equal(calc('=DATEVALUE("soon")'), '#VALUE!');
  assert.ok(Math.abs((value('=TIMEVALUE("2:30 PM")') as number) - 14.5 / 24) < 1e-12);
});

test('WEEKDAY, WEEKNUM, ISOWEEKNUM, NETWORKDAYS, WORKDAY', () => {
  // 13 October 2026 is a Tuesday.
  assert.equal(value('=WEEKDAY(DATE(2026,10,13))'), 3);
  assert.equal(value('=WEEKDAY(DATE(2026,10,13),2)'), 2);
  assert.equal(value('=WEEKDAY(DATE(2026,10,13),3)'), 1);
  assert.equal(value('=WEEKDAY(DATE(2026,10,13),16)'), 4);
  assert.equal(calc('=WEEKDAY(DATE(2026,10,13),9)'), '#NUM!');
  assert.equal(value('=WEEKNUM(DATE(2026,10,13))'), 42);
  assert.equal(value('=WEEKNUM(DATE(2026,1,1))'), 1);
  // 4 January 2026 is a Sunday: a new week when weeks start on Sunday, not when they start on Monday.
  assert.equal(value('=WEEKNUM(DATE(2026,1,4))'), 2);
  assert.equal(value('=WEEKNUM(DATE(2026,1,4),2)'), 1);
  assert.equal(value('=ISOWEEKNUM(DATE(2026,1,1))'), 1);
  assert.equal(value('=ISOWEEKNUM(DATE(2027,1,1))'), 53);
  assert.equal(value('=WEEKNUM(DATE(2027,1,1),21)'), 53);
  assert.equal(value('=NETWORKDAYS(DATE(2026,10,12),DATE(2026,10,23))'), 10);
  assert.equal(value('=NETWORKDAYS(DATE(2026,10,12),DATE(2026,10,23),DATE(2026,10,14))'), 9);
  assert.equal(value('=NETWORKDAYS(DATE(2026,10,23),DATE(2026,10,12))'), -10);
  assert.equal(calc('=WORKDAY(DATE(2026,10,16),1)'), '19/10/2026');
  assert.equal(value('=WORKDAY(DATE(2026,10,19),-1)'), value('=DATE(2026,10,16)'));
  assert.equal(value('=WORKDAY(DATE(2026,10,16),1,A1:A2)', { A1: '19/10/2026', A2: '20/10/2026' }), value('=DATE(2026,10,21)'));
});

test('1900 is counted as a leap year, as Excel does, so every serial matches Excel', () => {
  assert.equal(value('=DATE(1900,1,1)'), 1);
  assert.equal(value('=DATE(1900,2,28)'), 59);
  assert.equal(value('=DATE(1900,2,29)'), 60);
  assert.equal(value('=DATE(1900,3,1)'), 61);
  assert.equal(value('=WEEKDAY(DATE(1900,3,1))'), 5);
  assert.equal(calc('=TEXT(60,"d mmm yyyy")'), '29 Feb 1900');
  const wb = book({ A1: '29/02/1900' });
  assert.equal(raw(wb, 'A1'), 60);
});

test('filling down a single date goes a day at a time; a single number is copied', () => {
  const wb = book({ A1: '13/10/2026', B1: '5' });
  wb.fill(0, { c0: 0, r0: 0, c1: 1, r1: 0 }, { c0: 0, r0: 0, c1: 1, r1: 2 });
  assert.deepEqual([at(wb, 'A2'), at(wb, 'A3'), at(wb, 'B2'), at(wb, 'B3')], ['14/10/2026', '15/10/2026', '5', '5']);
});

test('format codes: numbers, dates, times, text, colours, fractions, as Excel shows them', () => {
  const cases: Array<[number | string, string, string]> = [
    [1234.5678, '0.00', '1234.57'], [1234.5678, '#,##0.00', '1,234.57'], [1234.5, '$#,##0.00', '$1,234.50'],
    [0.256, '0%', '26%'], [0.256, '0.0%', '25.6%'], [5551234567, '000-000-0000', '555-123-4567'], [123, '00000', '00123'],
    [0.5, '#.00', '.50'], [5, '.00', '5.00'], [-5, '0.00;(0.00)', '(5.00)'], [0, '0;-0;"zero"', 'zero'],
    ['abc', '0;-0;0;"t:"@', 't:abc'], [1234567, '0.0,,', '1.2'], [1234567, '#,##0,', '1,235'],
    [12345, '0.00E+00', '1.23E+04'], [0.000123, '0.0E+0', '1.2E-4'], [1.25, '# ?/?', '1 1/4'], [0.75, '?/4', '3/4'],
    [5, '"Ref: "0', 'Ref: 5'], [3.5, '0.0 "kg"', '3.5 kg'], [-0.001, '0.00', '0.00'], [12.5, 'General', '12.5'],
    [46308, 'dd/mm/yyyy', '13/10/2026'], [46308, 'dddd, d mmmm yyyy', 'Tuesday, 13 October 2026'], [46308, 'mmm-yy', 'Oct-26'],
    [46308, 'ddd d/m/yy', 'Tue 13/10/26'], [46308.6041666667, 'h:mm AM/PM', '2:30 PM'], [46308.6041666667, 'hh:mm:ss', '14:30:00'],
    [1.5, '[h]:mm', '36:00'], [0.999999, 'h:mm:ss', '0:00:00'], [0.5, 'h:mm a/p', '12:00 p'], [46308, 'mmmmm', 'O'],
    [0.000694444, 'mm:ss.0', '01:00.0'], [-1, 'dd/mm/yyyy', '##########'],
  ];
  for (const [v, code, want] of cases) assert.equal(formatCode(v, code).text, want, `${v} as ${code}`);
  assert.deepEqual(formatCode(-3, '[Red]0;[Blue]-0'), { text: '-3', color: '#0000ff' });
  assert.deepEqual(formatCode(150, '[>100][Red]0;0'), { text: '150', color: '#ff0000' });
  assert.equal(codeProblem('0.00'), null);
  assert.match(codeProblem('"open') ?? '', /not closed/);
  assert.match(codeProblem('0;0;0;0;0') ?? '', /four parts/);
});

test('a cell with a format code: shown with it (and its colour), saved with it; a broken code in a file is dropped', () => {
  const wb = book({ A1: '-1234.5', A2: '46308' });
  wb.setStyle(0, { c0: 0, r0: 0, c1: 0, r1: 0 }, s => ({ ...s, fmt: 'custom', code: '#,##0.00;[Red](#,##0.00)' }));
  wb.setStyle(0, { c0: 0, r0: 1, c1: 0, r1: 1 }, s => ({ ...s, fmt: 'custom', code: 'dddd' }));
  assert.deepEqual(wb.shown(0, 0, 0), { text: '(1,234.50)', color: '#ff0000' });
  assert.equal(at(wb, 'A2'), 'Tuesday');
  const again = new Workbook();
  again.load(JSON.parse(wb.serialize()));
  assert.equal(again.display(0, 0, 0), '(1,234.50)');
  assert.equal(again.display(0, 0, 1), 'Tuesday');
  const file = JSON.parse(wb.serialize());
  file.styles = file.styles.map((s: Record<string, unknown>) => (s.code ? { ...s, code: '"never closed' } : s));
  const broken = new Workbook();
  broken.load(file);
  assert.equal(broken.display(0, 0, 0), '-1234.5');
});

test('TEXT with any format code', () => {
  assert.equal(calc('=TEXT(46308,"dddd d mmmm yyyy")'), 'Tuesday 13 October 2026');
  assert.equal(calc('=TEXT(A1,"yyyy-mm-dd")', { A1: '13/10/2026' }), '2026-10-13');
  assert.equal(calc('=TEXT("13/10/2026","d mmm")'), '13 Oct');
  assert.equal(calc('=TEXT(0.5,"h:mm AM/PM")'), '12:00 PM');
  assert.equal(calc('=TEXT(1234.5,"#,##0.00")'), '1,234.50');
  assert.equal(calc('=TEXT(5551234,"000-0000")'), '555-1234');
  assert.equal(calc('=TEXT(7,"00")'), '07');
  assert.equal(calc('=TEXT(0.256,"0.0%")'), '25.6%');
  assert.equal(calc('=TEXT(-5,"0;(0)")'), '(5)');
  assert.equal(calc('=TEXT("abc","0")'), 'abc');
  assert.equal(calc('=TEXT("abc","[@]")'), 'abc');
  assert.equal(calc('=TEXT(1,"0[")'), '#VALUE!');
  assert.equal(calc('="Due "&TEXT(A1+30,"d mmm yyyy")', { A1: '13/10/2026' }), 'Due 12 Nov 2026');
});
