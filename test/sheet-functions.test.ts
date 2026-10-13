// The spreadsheet's wider function library (session 7): conditions, maths, statistics, money, references, names, LET
// and the list-reshaping functions. Expected answers are Excel's (from its documentation examples where it gives one).
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Workbook } from '../src/apps/sheet/workbook.ts';
import { parseCellRef } from '../src/apps/sheet/refs.ts';

function book(cells: Record<string, string>): Workbook {
  const wb = new Workbook();
  for (const [addr, text] of Object.entries(cells)) {
    const r = parseCellRef(addr)!;
    wb.setInput(0, r.col, r.row, text);
  }
  return wb;
}
const v = (wb: Workbook, addr: string) => {
  const r = parseCellRef(addr)!;
  return wb.value(0, r.col, r.row);
};
const close = (got: unknown, want: number, digits = 9) => {
  assert.equal(typeof got, 'number', `expected a number, got ${String(got)}`);
  assert.ok(Math.abs((got as number) - want) < Math.pow(10, -digits) * Math.max(1, Math.abs(want)), `${got} is not ${want}`);
};
/** One formula worked out on its own (cells given first). */
function calc(formula: string, cells: Record<string, string> = {}): unknown {
  const wb = book({ ...cells, Z100: `=${formula}` });
  const got = v(wb, 'Z100');
  return got && typeof got === 'object' && 'code' in got ? (got as { code: string }).code : got;
}

const SALES = {
  A1: 'Region', B1: 'Rep', C1: 'Amount',
  A2: 'North', B2: 'Ann', C2: '100',
  A3: 'South', B3: 'Bob', C3: '250',
  A4: 'North', B4: 'Bob', C4: '75',
  A5: 'North', B5: 'Ann', C5: '300',
  A6: 'South', B6: 'Ann', C6: '50',
};

test('SUMIFS, COUNTIFS, AVERAGEIFS, MAXIFS, MINIFS with several conditions and wildcards', () => {
  assert.equal(calc('SUMIFS(C2:C6,A2:A6,"North",B2:B6,"Ann")', SALES), 400);
  assert.equal(calc('COUNTIFS(A2:A6,"North",C2:C6,">=100")', SALES), 2);
  assert.equal(calc('AVERAGEIFS(C2:C6,B2:B6,"A*")', SALES), 150);
  assert.equal(calc('MAXIFS(C2:C6,A2:A6,"South")', SALES), 250);
  assert.equal(calc('MINIFS(C2:C6,A2:A6,"North")', SALES), 75);
  assert.equal(calc('SUMIFS(C2:C6,A2:A6,"East")', SALES), 0);
  assert.equal(calc('AVERAGEIFS(C2:C6,A2:A6,"East")', SALES), '#DIV/0!');
  // Ranges of different sizes are refused, as in Excel.
  assert.equal(calc('SUMIFS(C2:C6,A2:A5,"North")', SALES), '#VALUE!');
  // A list of conditions gives a list of answers (summed here).
  assert.equal(calc('SUM(SUMIFS(C2:C6,A2:A6,{"North","South"}))', SALES), 775);
});

test('rounding to multiples, and the rest of the maths', () => {
  assert.equal(calc('CEILING(2.5,1)'), 3);
  assert.equal(calc('CEILING(-2.5,-2)'), -4);
  assert.equal(calc('CEILING(-2.5,2)'), -2);
  assert.equal(calc('CEILING(1.5,0.1)'), 1.5);
  assert.equal(calc('CEILING(2.5,-2)'), '#NUM!');
  assert.equal(calc('CEILING.MATH(-5.5,2,-1)'), -6);
  assert.equal(calc('CEILING.MATH(-5.5,2)'), -4);
  assert.equal(calc('FLOOR(3.7,2)'), 2);
  assert.equal(calc('FLOOR(-2.5,-2)'), -2);
  assert.equal(calc('FLOOR.MATH(-5.5,2,-1)'), -4);
  assert.equal(calc('MROUND(10,3)'), 9);
  assert.equal(calc('MROUND(-10,-3)'), -9);
  assert.equal(calc('MROUND(5,-2)'), '#NUM!');
  assert.deepEqual([calc('EVEN(1.5)'), calc('EVEN(-1)'), calc('ODD(1.5)'), calc('ODD(2)'), calc('ODD(0)')], [2, -2, 3, 3, 1]);
  assert.equal(calc('TRUNC(8.97,1)'), 8.9);
  assert.equal(calc('TRUNC(-8.9)'), -8);
  assert.equal(calc('QUOTIENT(-10,3)'), -3);
  assert.deepEqual([calc('GCD(24,36)'), calc('LCM(4,6,10)'), calc('FACT(5)'), calc('COMBIN(8,2)'), calc('PERMUT(100,3)')], [12, 60, 120, 28, 970200]);
  assert.equal(calc('LOG(8,2)'), 3);
  assert.equal(calc('LOG(100)'), 2);
  close(calc('DEGREES(PI())'), 180);
  close(calc('ATAN2(1,1)'), Math.PI / 4);
  assert.deepEqual([calc('DEC2BIN(9,4)'), calc('DEC2BIN(-100)'), calc('DEC2HEX(255)'), calc('HEX2DEC("FFFFFFFF9C")'), calc('BIN2DEC("1100100")')], ['1001', '1110011100', 'FF', -100, 100]);
  assert.equal(calc('BASE(7,2,4)'), '0111');
  assert.equal(calc('DECIMAL("FF",16)'), 255);
  assert.equal(calc('SUMSQ(3,4)'), 25);
  assert.equal(calc('MDETERM({3,6,1;1,1,0;3,10,2})'), 1);
  const r = calc('RANDBETWEEN(1,6)') as number;
  assert.ok(Number.isInteger(r) && r >= 1 && r <= 6);
});

test('statistics: ranks, percentiles, quartiles, modes, spreads and lines', () => {
  const data = { A1: '1', A2: '2', A3: '3', A4: '4', A5: '5', A6: '6', A7: '7', A8: '8', A9: '9', A10: '10' };
  assert.equal(calc('LARGE(A1:A10,3)', data), 8);
  assert.equal(calc('SMALL(A1:A10,4)', data), 4);
  assert.equal(calc('LARGE(A1:A10,11)', data), '#NUM!');
  assert.equal(calc('RANK(7,A1:A10)', data), 4);
  assert.equal(calc('RANK.EQ(7,A1:A10,1)', data), 7);
  assert.equal(calc('RANK.AVG(94,{89,88,92,101,94,97,95})'), 4);
  assert.equal(calc('RANK(3.5,A1:A10)', data), '#N/A');
  close(calc('PERCENTILE.INC({1,3,2,4},0.3)'), 1.9);
  close(calc('PERCENTILE.EXC({1,2,3,6,6,6,7,8,9},0.25)'), 2.5);
  assert.equal(calc('PERCENTILE.EXC({1,2,3,6,6,6,7,8,9},0)'), '#NUM!');
  close(calc('QUARTILE.INC({1,2,4,7,8,9,10,12},1)'), 3.5);
  close(calc('QUARTILE.EXC({6,7,15,36,39,40,41,42,43,47,49},1)'), 15);
  close(calc('PERCENTRANK.INC({13,12,11,8,4,3,2,1,1,1},2)'), 0.333);
  close(calc('PERCENTRANK.INC({13,12,11,8,4,3,2,1,1,1},4)'), 0.555);
  close(calc('PERCENTRANK.INC({13,12,11,8,4,3,2,1,1,1},8)'), 0.666);
  close(calc('PERCENTRANK.INC({13,12,11,8,4,3,2,1,1,1},5)'), 0.583);
  close(calc('PERCENTRANK.EXC({1,2,3,6,6,6,7,8,9},7)'), 0.7);
  assert.equal(calc('MODE.SNGL({5.6,4,4,3,2,4})'), 4);
  assert.equal(calc('MODE({1,2,3})'), '#N/A');
  close(calc('STDEV.S({1345,1301,1368,1322,1310,1370,1318,1350,1303,1299})'), 27.46391572, 7);
  close(calc('STDEV.P({1345,1301,1368,1322,1310,1370,1318,1350,1303,1299})'), 26.05455814, 7);
  close(calc('VAR.S({1345,1301,1368,1322,1310,1370,1318,1350,1303,1299})'), 754.2666667, 7);
  close(calc('VAR.P({1345,1301,1368,1322,1310,1370,1318,1350,1303,1299})'), 678.84, 9);
  close(calc('AVEDEV({4,5,6,7,5,4,3})'), 1.020408163, 8);
  assert.equal(calc('DEVSQ({4,5,8,7,11,4,3})'), 48);
  close(calc('GEOMEAN({4,5,8,7,11,4,3})'), 5.476987, 6);
  close(calc('HARMEAN({4,5,8,7,11,4,3})'), 5.028376, 6);
  close(calc('TRIMMEAN({4,5,6,7,2,3,4,5,1,2,3},0.2)'), 3.777777778, 8);
  close(calc('CORREL({3,2,4,5,6},{9,7,12,15,17})'), 0.997054486, 8);
  close(calc('SLOPE({2,3,9,1,8,7,5},{6,5,11,7,5,4,4})'), 0.305555556, 8);
  close(calc('INTERCEPT({2,3,9,1,8},{6,5,11,7,5})'), 0.048387097, 8);
  close(calc('FORECAST.LINEAR(30,{6,7,9,15,21},{20,28,31,38,40})'), 10.60725308, 7);
  close(calc('RSQ({2,3,9,1,8,7,5},{6,5,11,7,5,4,4})'), 0.05795, 5);
  close(calc('COVARIANCE.P({3,2,4,5,6},{9,7,12,15,17})'), 5.2);
  close(calc('COVARIANCE.S({2,4,8},{5,11,12})'), 9.666666667, 8);
  close(calc('AVERAGEA(A1:A3)', { A1: '10', A2: 'text', A3: 'TRUE' }), 11 / 3);
  // Text typed into a cell of the range counts as 0 for MINA, and TRUE as 1 for MAXA.
  assert.equal(calc('MINA(A1:A3)', { A1: '10', A2: 'text', A3: '5' }), 0);
});

test('the normal distribution', () => {
  close(calc('NORM.DIST(42,40,1.5,TRUE)'), 0.9087888, 7);
  close(calc('NORM.DIST(42,40,1.5,FALSE)'), 0.10934, 5);
  close(calc('NORM.S.DIST(1.333333,TRUE)'), 0.908788726, 7);
  close(calc('NORM.INV(0.908789,40,1.5)'), 42.000002, 6);
  close(calc('NORM.S.INV(0.908789)'), 1.3333347, 6);
  close(calc('STANDARDIZE(42,40,1.5)'), 1.333333333, 8);
  assert.equal(calc('NORM.INV(1,0,1)'), '#NUM!');
});

test('money: loan payments, values, rates and returns', () => {
  close(calc('PMT(8%/12,10,10000)'), -1037.032089, 6);
  close(calc('PMT(8%/12,10,10000,0,1)'), -1030.164327, 6);
  close(calc('PMT(6%/12,18*12,0,50000)'), -129.0811609, 6);
  close(calc('FV(0.06/12,10,-200,-500,1)'), 2581.403374, 6);
  close(calc('PV(0.08/12,12*20,500,,0)'), -59777.14585, 5);
  close(calc('NPER(0.12/12,-100,-1000,10000,1)'), 59.6738657, 6);
  close(calc('RATE(4*12,-200,8000)'), 0.007701472, 8);
  close(calc('IPMT(0.1/12,1,36,8000)'), -66.66666667, 7);
  close(calc('IPMT(0.1,3,3,8000)'), -292.4471299, 6);
  close(calc('PPMT(0.1/12,1,24,2000)'), -75.62318601, 7);
  close(calc('CUMIPMT(0.09/12,30*12,125000,13,24,0)'), -11135.23213, 5);
  close(calc('CUMPRINC(0.09/12,30*12,125000,13,24,0)'), -934.1071234, 6);
  close(calc('NPV(0.1,-10000,3000,4200,6800)'), 1188.443412, 6);
  close(calc('IRR({-70000,12000,15000,18000,21000,26000})'), 0.086630948, 8);
  close(calc('IRR({-70000,12000,15000,18000,21000})'), -0.021244848, 8);
  assert.equal(calc('IRR({100,200})'), '#NUM!');
  const flows = { A1: '-10000', A2: '2750', A3: '4250', A4: '3250', A5: '2750', B1: '=DATE(2008,1,1)', B2: '=DATE(2008,3,1)', B3: '=DATE(2008,10,30)', B4: '=DATE(2009,2,15)', B5: '=DATE(2009,4,1)' };
  close(calc('XNPV(0.09,A1:A5,B1:B5)', flows), 2086.647602, 5);
  close(calc('XIRR(A1:A5,B1:B5)', flows), 0.373362535, 7);
  assert.equal(calc('SLN(30000,7500,10)'), 2250);
  close(calc('SYD(30000,7500,10,1)'), 4090.909090909);
  close(calc('DDB(2400,300,10*365,1)'), 1.315068493, 8);
  close(calc('DDB(2400,300,10,2)'), 384, 9);
  close(calc('EFFECT(0.0525,4)'), 0.053542667, 8);
  close(calc('NOMINAL(0.053543,4)'), 0.05250032, 7);
});

test('information and logic', () => {
  assert.deepEqual([calc('ISEVEN(-1)'), calc('ISEVEN(2.5)'), calc('ISODD(5)'), calc('ISODD("x")')], [false, true, true, '#VALUE!']);
  assert.deepEqual([calc('N(7)'), calc('N("7")'), calc('N(TRUE)'), calc('T("a")'), calc('T(1)')], [7, 0, 1, 'a', '']);
  assert.deepEqual([calc('TYPE(1)'), calc('TYPE("a")'), calc('TYPE(TRUE)'), calc('TYPE(1/0)'), calc('TYPE({1,2})')], [1, 2, 4, 16, 64]);
  assert.equal(calc('NA()'), '#N/A');
  assert.equal(calc('ERROR.TYPE(1/0)'), 2);
  assert.equal(calc('ERROR.TYPE(1)'), '#N/A');
  assert.deepEqual([calc('XOR(TRUE,TRUE)'), calc('XOR(TRUE,FALSE,FALSE)'), calc('XOR(1>0,2<1)')], [false, true, true]);
  assert.deepEqual([calc('ISREF(A1)'), calc('ISREF("A1")'), calc('ISREF(OFFSET(A1,1,1))')], [true, false, true]);
  assert.deepEqual([calc('ISFORMULA(A1)', { A1: '=1+1' }), calc('ISFORMULA(A1)', { A1: '2' }), calc('FORMULATEXT(A1)', { A1: '=SUM(1,2)' }), calc('FORMULATEXT(A1)', { A1: '3' })], [true, false, '=SUM(1,2)', '#N/A']);
});

test('text and dates', () => {
  assert.deepEqual([calc('FIXED(1234.567,1)'), calc('FIXED(1234.567,-1)'), calc('FIXED(-1234.567,-1,TRUE)'), calc('FIXED(44.332)')], ['1,234.6', '1,230', '-1230', '44.33']);
  assert.deepEqual([calc('DOLLAR(1234.567,2)'), calc('DOLLAR(-0.123,4)')], ['$1,234.57', '($0.1230)']);
  assert.equal(calc('VALUETOTEXT("a",1)'), '"a"');
  assert.equal(calc('ARRAYTOTEXT({1,"b";TRUE,4},1)'), '{1,"b";TRUE,4}');
  assert.equal(calc('ARRAYTOTEXT({1,"b";TRUE,4})'), '1, b, TRUE, 4');
  close(calc('YEARFRAC(DATE(2012,1,1),DATE(2012,7,30))'), 0.580555556, 8);
  close(calc('YEARFRAC(DATE(2012,1,1),DATE(2012,7,30),1)'), 0.57650273, 8);
  close(calc('YEARFRAC(DATE(2012,1,1),DATE(2012,7,30),3)'), 0.57808219, 8);
  close(calc('YEARFRAC(DATE(2010,1,1),DATE(2013,7,1),1)'), 1277 / 365.25, 9);
  assert.equal(calc('DAYS360(DATE(2011,1,1),DATE(2011,12,31))'), 360);
  assert.equal(calc('DAYS360(DATE(2011,1,30),DATE(2011,2,1))'), 1);
  assert.equal(calc('DAYS360(DATE(2011,1,30),DATE(2011,12,31))'), 330);
  assert.equal(calc('DAYS360(DATE(2011,1,1),DATE(2011,12,31),TRUE)'), 359);
  // January 2006: 22 working days Monday to Friday. To 1 February with only Sundays off: 27; Wednesdays and Sundays: 22.
  assert.equal(calc('NETWORKDAYS.INTL(DATE(2006,1,1),DATE(2006,1,31))'), 22);
  assert.equal(calc('NETWORKDAYS.INTL(DATE(2006,1,1),DATE(2006,2,1),11)'), 27);
  assert.equal(calc('NETWORKDAYS.INTL(DATE(2006,1,1),DATE(2006,2,1),"0010001")'), 22);
  assert.equal(calc('NETWORKDAYS.INTL(DATE(2006,1,1),DATE(2006,2,1),"0010001",{"2006/1/2","2006/1/16"})'), 20);
  assert.equal(calc('WORKDAY.INTL(DATE(2012,1,1),30,0)'), '#NUM!');
  assert.equal(calc('WORKDAY.INTL(DATE(2012,1,1),90,11)'), 41013);
  assert.equal(calc('WORKDAY.INTL(DATE(2012,1,1),30,17)'), 40944);
});

test('lookups: HLOOKUP, LOOKUP, and wildcards in exact lookups', () => {
  const t = { A1: 'Axles', B1: 'Bearings', C1: 'Bolts', A2: '4', B2: '4', C2: '9', A3: '5', B3: '7', C3: '10', A4: '6', B4: '8', C4: '11' };
  assert.equal(calc('HLOOKUP("Axles",A1:C4,2,TRUE)', t), 4);
  assert.equal(calc('HLOOKUP("Bearings",A1:C4,3,FALSE)', t), 7);
  assert.equal(calc('HLOOKUP("B",A1:C4,3,TRUE)', t), 5);
  assert.equal(calc('HLOOKUP("Bo*",A1:C4,4,FALSE)', t), 11);
  assert.equal(calc('HLOOKUP(3,{1,2,3;"a","b","c";"d","e","f"},2,TRUE)'), 'c');
  const v = { A1: '4.14', A2: '4.19', A3: '5.17', A4: '5.77', A5: '6.39', B1: 'red', B2: 'orange', B3: 'yellow', B4: 'green', B5: 'blue' };
  assert.equal(calc('LOOKUP(4.19,A1:A5,B1:B5)', v), 'orange');
  assert.equal(calc('LOOKUP(5,A1:A5,B1:B5)', v), 'orange');
  assert.equal(calc('LOOKUP(7.66,A1:A5,B1:B5)', v), 'blue');
  assert.equal(calc('LOOKUP(0,A1:A5,B1:B5)', v), '#N/A');
  assert.equal(calc('LOOKUP("C",{"a","b","c","d";1,2,3,4})'), 3);
  assert.equal(calc('LOOKUP("bump",{"a",1;"b",2;"c",3})'), 2);
  // The last filled cell of a column, a well-known LOOKUP trick.
  assert.equal(calc('LOOKUP(2,1/(A1:A10<>""),A1:A10)', { A1: 'x', A2: 'y', A3: 'z' }), 'z');
  assert.equal(calc('VLOOKUP("*ear*",A1:C4,1,FALSE)', { A1: 'Axles', A2: 'Bearings', A3: 'Bolts' }), 'Bearings');
  assert.equal(calc('MATCH("b?lts",A1:A3,0)', { A1: 'Axles', A2: 'Bearings', A3: 'Bolts' }), 3);
});

test('references: ROW, COLUMN, OFFSET, INDIRECT, ADDRESS, INDEX as a reference, and A1:INDEX ranges', () => {
  const wb = book({
    A1: '1', A2: '2', A3: '3', A4: '4', A5: '5', B1: 'B1 text', C3: 'Sheet text',
    D1: '=ROW()', D2: '=COLUMN()', D3: '=ROW(C10)', D4: '=MIN(COLUMN(F1:H1))', D5: '=SUM(ROW(A1:A4))',
    E1: '=SUM(OFFSET(A1,1,0,3,1))', E2: '=OFFSET(A1,2,0)', E3: '=INDIRECT("B1")', E4: '=SUM(INDIRECT("A1:A"&3))', E5: '=INDIRECT("R3C3",FALSE)',
    F1: '=ADDRESS(2,3)', F2: '=ADDRESS(2,3,2)', F3: '=ADDRESS(2,3,4,FALSE)', F4: '=ADDRESS(1,1,1,TRUE,"My sheet")', F5: '=ADDRESS(2,3,1,FALSE)',
    G1: '=SUM(A1:INDEX(A1:A5,3))', G2: '=SUM(INDEX(A1:B5,0,1))', G3: '=ROWS(OFFSET(A1,0,0,4,2))', G4: '=OFFSET(A1,-1,0)', G5: '=INDIRECT("nowhere")',
  });
  assert.deepEqual(['D1', 'D2', 'D3', 'D4', 'D5'].map(a => v(wb, a)), [1, 4, 10, 6, 10]);
  assert.deepEqual(['E1', 'E2', 'E3', 'E4', 'E5'].map(a => v(wb, a)), [9, 3, 'B1 text', 6, 'Sheet text']);
  assert.deepEqual(['F1', 'F2', 'F3', 'F4', 'F5'].map(a => v(wb, a)), ['$C$2', 'C$2', 'R[2]C[3]', "'My sheet'!$A$1", 'R2C3']);
  assert.deepEqual(['G1', 'G2', 'G3'].map(a => v(wb, a)), [6, 15, 4]);
  assert.equal((v(wb, 'G4') as { code: string }).code, '#REF!');
  assert.equal((v(wb, 'G5') as { code: string }).code, '#REF!');
  // =ROW(A1:A3) fills three cells down.
  wb.setInput(0, 8, 0, '=ROW(A1:A3)');
  assert.deepEqual([wb.value(0, 8, 0), wb.value(0, 8, 1), wb.value(0, 8, 2)], [1, 2, 3]);
});

test('SUBTOTAL and AGGREGATE leave out filtered rows, hidden rows when asked, errors, and each other', () => {
  const wb = book({ A1: 'Item', A2: '10', A3: '20', A4: '30', A5: '40', A6: '=SUBTOTAL(9,A2:A5)', B1: '=SUBTOTAL(9,A2:A6)', B2: '=SUBTOTAL(109,A2:A5)', B3: '=SUBTOTAL(1,A2:A5)', B4: '=AGGREGATE(9,0,A2:A6)', B5: '=AGGREGATE(14,6,C1:C3,1)', C1: '5', C2: '=1/0', C3: '7', B6: '=SUBTOTAL(3,A1:A5)', B7: '=AGGREGATE(9,0,C1:C3)' });
  assert.equal(v(wb, 'A6'), 100);
  // SUBTOTAL over a range holding another SUBTOTAL counts only the figures.
  assert.equal(v(wb, 'B1'), 100);
  assert.equal(v(wb, 'B4'), 100);
  assert.equal(v(wb, 'B5'), 7);
  assert.equal((v(wb, 'B7') as { code: string }).code, '#DIV/0!');
  assert.equal(v(wb, 'B6'), 5);
  // A row hidden by hand: 109 leaves it out, 9 keeps it.
  wb.setHidden(0, 'row', 2, 2, true);
  assert.equal(v(wb, 'A6'), 100);
  assert.equal(v(wb, 'B2'), 80);
  // A row hidden by the filter: both leave it out.
  wb.setHidden(0, 'row', 2, 2, false);
  wb.setFilter(0, { c0: 0, r0: 0, c1: 0, r1: 4 });
  wb.filterBy(0, 0, ['10', '30', '40']);
  assert.equal(v(wb, 'A6'), 80);
  close(v(wb, 'B3'), 80 / 3);
});

test('LET names its parts, and the names can be lists', () => {
  assert.equal(calc('LET(x,5,y,x*2,x+y)'), 15);
  assert.equal(calc('LET(rate,0.1,price,200,price*(1+rate))'), 220);
  assert.equal(calc('LET(r,A1:A3,SUM(r*2))', { A1: '1', A2: '2', A3: '3' }), 12);
  assert.equal(calc('LET(x,1/0,IFERROR(x,"bad"))'), 'bad');
  assert.equal(calc('LET(x,5)'), '#VALUE!');
  assert.equal(calc('nothere+1'), '#NAME?');
  // A LET whose answer is a list fills the cells around it.
  const wb = book({ A1: '1', A2: '2', A3: '3', B1: '=LET(d,A1:A3,d*10)' });
  assert.deepEqual([v(wb, 'B1'), v(wb, 'B2'), v(wb, 'B3')], [10, 20, 30]);
});

test('lists reshaped: CHOOSECOLS, CHOOSEROWS, TAKE, DROP, VSTACK, HSTACK, TOCOL, TOROW, WRAPROWS, EXPAND, FREQUENCY, MMULT', () => {
  const sumOf = (f: string) => calc(`SUM(${f})`);
  assert.equal(calc('ROWS(TAKE(SEQUENCE(5,3),2))'), 2);
  assert.equal(sumOf('TAKE(SEQUENCE(5,3),-1)'), 13 + 14 + 15);
  assert.equal(sumOf('DROP(SEQUENCE(5,3),3,2)'), 12 + 15);
  assert.equal(calc('DROP(SEQUENCE(2),5)'), '#CALC!');
  assert.equal(sumOf('CHOOSECOLS(SEQUENCE(3,3),1,-1)'), 1 + 4 + 7 + 3 + 6 + 9);
  assert.equal(calc('INDEX(CHOOSEROWS(SEQUENCE(4,2),-1,1),1,2)'), 8);
  assert.equal(calc('CHOOSEROWS(SEQUENCE(4,2),5)'), '#VALUE!');
  assert.equal(calc('ROWS(VSTACK({1,2},{3,4},{5,6}))'), 3);
  assert.equal(calc('INDEX(VSTACK({1,2,3},{4}),2,3)'), '#N/A');
  assert.equal(calc('COLUMNS(HSTACK({1;2},{3;4},{5;6}))'), 3);
  assert.equal(calc('ROWS(TOCOL(SEQUENCE(3,4)))'), 12);
  assert.equal(calc('INDEX(TOCOL(SEQUENCE(2,3),0,TRUE),2)'), 4);
  assert.equal(calc('COLUMNS(TOROW(A1:B3,1))', { A1: '1', B2: '2' }), 2);
  assert.equal(calc('INDEX(WRAPROWS(SEQUENCE(7),3),3,2)'), '#N/A');
  assert.equal(calc('INDEX(WRAPROWS(SEQUENCE(7),3,0),3,1)'), 7);
  assert.equal(calc('INDEX(WRAPCOLS(SEQUENCE(6),2),2,3)'), 6);
  assert.equal(calc('INDEX(EXPAND({1,2},2,3,"-"),2,3)'), '-');
  const f = book({ A1: '79', A2: '85', A3: '78', A4: '85', A5: '50', A6: '81', A7: '95', A8: '88', A9: '97', B1: '70', B2: '79', B3: '89', C1: '=FREQUENCY(A1:A9,B1:B3)' });
  assert.deepEqual([0, 1, 2, 3].map(r => f.value(0, 2, r)), [1, 2, 4, 2]);
  assert.equal(calc('INDEX(MMULT({1,3;7,2},{2,0;0,2}),2,1)'), 14);
  assert.equal(calc('SUM(MODE.MULT({1,2,3,4,3,2,1,2,3}))'), 5);
});

test('names: a workbook name for a range, a value or a formula, kept for a sheet or the whole workbook', () => {
  const wb = book({ A1: '10', A2: '20', A3: '30', B1: '0.1' });
  wb.setName('Prices', 'Sheet1!$A$1:$A$3');
  wb.setName('Rate', '=Sheet1!$B$1');
  wb.setName('Tax', '=0.15');
  wb.setInput(0, 3, 0, '=SUM(Prices)');
  wb.setInput(0, 3, 1, '=SUM(Prices)*Rate');
  wb.setInput(0, 3, 2, '=100*tax');
  wb.setInput(0, 3, 3, '=Prices*2');
  assert.deepEqual([v(wb, 'D1'), v(wb, 'D2'), v(wb, 'D3')], [60, 6, 15]);
  // A name for a range used where a list fits fills the cells below.
  assert.deepEqual([v(wb, 'D4'), v(wb, 'D5'), v(wb, 'D6')], [20, 40, 60]);
  // Inserting a row above moves the name's range with the cells, as Excel does.
  wb.shiftAxis(0, 'row', 0, 1);
  assert.equal(wb.names.find(n => n.name === 'Prices')!.ref, 'Sheet1!$A$2:$A$4');
  assert.equal(wb.value(0, 3, 1), 60);
  // Renaming the sheet follows too; a name that is deleted leaves #NAME?.
  wb.renameSheet(0, 'Data');
  assert.equal(wb.names.find(n => n.name === 'Prices')!.ref, 'Data!$A$2:$A$4');
  wb.deleteName('Tax');
  assert.equal((wb.value(0, 3, 3) as { code: string }).code, '#NAME?');
  // Names are kept in the saved file.
  const again = new Workbook();
  again.load(JSON.parse(wb.serialize()));
  assert.equal(again.value(0, 3, 1), 60);
  // Bad names are refused with a reason.
  assert.throws(() => wb.setName('A1', '=1'), /cell/i);
  assert.throws(() => wb.setName('two words', '=1'), /space/i);
  assert.throws(() => wb.setName('Rate', '=2'), /already/i);
});

test('corners found by the deliberate-break audit: weekend codes 1-7, OFFSET keeps its block\'s size, LET names stay inside', () => {
  // 1 to 31 January 2006 with Friday and Saturday off (code 7): 31 days less 4 Fridays and 4 Saturdays.
  assert.equal(calc('NETWORKDAYS.INTL(DATE(2006,1,1),DATE(2006,1,31),7)'), 23);
  // Sunday and Monday off (code 2): 5 Sundays, 5 Mondays.
  assert.equal(calc('NETWORKDAYS.INTL(DATE(2006,1,1),DATE(2006,1,31),2)'), 21);
  assert.equal(calc('SUM(OFFSET(A1:A3,1,0))', { A1: '1', A2: '2', A3: '3', A4: '4' }), 9, 'A2:A4, three rows like A1:A3');
  assert.equal(calc('ROWS(OFFSET(A1:B3,0,1))'), 3);
  assert.equal(calc('LET(x,1,x)+x'), '#NAME?', 'x is not known outside its LET');
});
