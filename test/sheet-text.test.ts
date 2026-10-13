// The spreadsheet's text and lookup functions, checked against the answers Excel gives: cutting pasted text apart
// (TEXTSPLIT, TEXTBEFORE, TEXTAFTER, FIND, SEARCH, SUBSTITUTE...), the newer lookups (XLOOKUP, XMATCH), lists inside a
// formula ({1,2,3}, TEXTSPLIT's pieces passed to INDEX), several lines in one cell, and pasting plain text.
// No browser needed. Run: npm test
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
/** What a formula shows, worked out in an empty cell of a workbook holding `cells`. */
function calc(formula: string, cells: Record<string, string> = {}): string {
  const wb = book({ ...cells, Z99: formula });
  return wb.display(0, 25, 98);
}
const value = (formula: string, cells: Record<string, string> = {}) => {
  const wb = book({ ...cells, Z99: formula });
  return wb.value(0, 25, 98);
};

const ADDRESS = 'Jane Citizen\n12 Example Street\nSpringfield 3000\nPhone: 0400 000 000';

test('several lines in one cell: kept when typed, saved and opened again, and the cell wraps', () => {
  const wb = book({ A1: ADDRESS });
  assert.equal(wb.value(0, 0, 0), ADDRESS);
  assert.equal(wb.styleOf(wb.sheets[0].cells.get(0))?.wrap, true);
  const again = new Workbook();
  again.load(JSON.parse(wb.serialize()));
  assert.equal(again.value(0, 0, 0), ADDRESS);
  assert.equal(again.styleOf(again.sheets[0].cells.get(0))?.wrap, true);
  // One line of text does not turn wrapping on.
  const one = book({ A1: 'one line' });
  assert.equal(one.styleOf(one.sheets[0].cells.get(0))?.wrap, undefined);
});

test('TEXTSPLIT cuts a pasted block into lines, and INDEX picks one', () => {
  const cells = { A1: ADDRESS };
  assert.equal(calc('=INDEX(TEXTSPLIT(A1,,CHAR(10)),1)', cells), 'Jane Citizen');
  assert.equal(calc('=INDEX(TEXTSPLIT(A1,,CHAR(10)),3)', cells), 'Springfield 3000');
  assert.equal(calc('=ROWS(TEXTSPLIT(A1,,CHAR(10)))', cells), '4');
  assert.equal(calc('=COLUMNS(TEXTSPLIT("a,b,c",","))'), '3');
  // On its own the formula's cell shows the first piece (the others fill the cells beside it: sheet-spill.test.ts).
  assert.equal(calc('=TEXTSPLIT("a,b,c",",")'), 'a');
  // Rows and columns at once; a short row is padded with #N/A, or with what pad_with says.
  assert.equal(calc('=INDEX(TEXTSPLIT("1,2,3;4,5,6",",",";"),2,3)'), '6');
  assert.equal(calc('=INDEX(TEXTSPLIT("1,2,3;4",",",";"),2,2)'), '#N/A');
  assert.equal(calc('=INDEX(TEXTSPLIT("1,2,3;4",",",";",FALSE,0,"-"),2,2)'), '-');
  // Two delimiters (an array constant); empty pieces kept unless ignore_empty is TRUE.
  assert.equal(calc('=COLUMNS(TEXTSPLIT("a.b-c",{".","-"}))'), '3');
  assert.equal(calc('=COLUMNS(TEXTSPLIT("a,,b",","))'), '3');
  assert.equal(calc('=COLUMNS(TEXTSPLIT("a,,b",",",,TRUE))'), '2');
  // match_mode 1 ignores case.
  assert.equal(calc('=COLUMNS(TEXTSPLIT("aXbxc","x"))'), '2');
  assert.equal(calc('=COLUMNS(TEXTSPLIT("aXbxc","x",,,1))'), '3');
  // The pieces are text: SUM skips them, as it skips text in a range.
  assert.equal(calc('=SUM(TEXTSPLIT("1,2",","))'), '0');
  assert.equal(calc('=TEXTSPLIT("",",")'), '#VALUE!');
});

test('TEXTBEFORE and TEXTAFTER, by instance, from the end, with a fallback', () => {
  const t = { A1: "Little red Riding Hood's red hood" };
  assert.equal(calc('=TEXTBEFORE(A1,"red")', t), 'Little ');
  assert.equal(calc('=TEXTAFTER(A1,"red")', t), " Riding Hood's red hood");
  assert.equal(calc('=TEXTBEFORE(A1,"red",2)', t), "Little red Riding Hood's ");
  assert.equal(calc('=TEXTBEFORE(A1,"red",-2)', t), 'Little ');
  assert.equal(calc('=TEXTAFTER(A1,"red",-1)', t), ' hood');
  assert.equal(calc('=TEXTAFTER(A1,"RED")', t), '#N/A');
  assert.equal(calc('=TEXTAFTER(A1,"RED",,1)', t), " Riding Hood's red hood");
  assert.equal(calc('=TEXTAFTER(A1,"blue",,,,"none")', t), 'none');
  assert.equal(calc('=TEXTBEFORE(A1,"red",3)', t), '#N/A');
  assert.equal(calc('=TEXTBEFORE(A1,"red",0)', t), '#VALUE!');
  assert.equal(calc('=TEXTAFTER("Phone: 0400","Phone: ")'), '0400');
  assert.equal(calc('=TEXTAFTER(INDEX(TEXTSPLIT(A1,,CHAR(10)),4),": ")', { A1: ADDRESS }), '0400 000 000');
  // An empty delimiter matches at once (the start, or the end when counting from the end).
  assert.equal(calc('=TEXTBEFORE("abc","")'), '');
  assert.equal(calc('=TEXTBEFORE("abc","",-1)'), 'abc');
  assert.equal(calc('=TEXTAFTER("abc","")'), 'abc');
  // match_end: the end of the text counts as a delimiter.
  assert.equal(calc('=TEXTBEFORE("abc","x",1,0,1)'), 'abc');
  assert.equal(calc('=TEXTBEFORE("","x")'), '');
});

test('FIND, SEARCH, SUBSTITUTE, REPLACE and friends', () => {
  assert.equal(calc('=FIND("o","Hello world")'), '5');
  assert.equal(calc('=FIND("o","Hello world",6)'), '8');
  assert.equal(calc('=FIND("O","Hello world")'), '#VALUE!');
  assert.equal(calc('=SEARCH("O","Hello world")'), '5');
  assert.equal(calc('=SEARCH("w*d","Hello world")'), '7');
  assert.equal(calc('=SEARCH("l?o","Hello world")'), '3');
  assert.equal(calc('=SEARCH("~*","a*b")'), '2');
  assert.equal(calc('=FIND("x","abc",0)'), '#VALUE!');
  assert.equal(calc('=SUBSTITUTE("a-b-c","-","+")'), 'a+b+c');
  assert.equal(calc('=SUBSTITUTE("a-b-c","-","+",2)'), 'a-b+c');
  assert.equal(calc('=SUBSTITUTE("aaa","A","b")'), 'aaa');
  assert.equal(calc('=SUBSTITUTE(A1,CHAR(10),", ")', { A1: 'one\ntwo' }), 'one, two');
  assert.equal(calc('=REPLACE("abcdef",2,3,"X")'), 'aXef');
  assert.equal(calc('=CHAR(65)&CHAR(128)&CHAR(150)'), 'A€–');
  assert.equal(calc('=CODE("€")'), '128');
  assert.equal(calc('=CODE("A")'), '65');
  assert.equal(calc('=CHAR(0)'), '#VALUE!');
  assert.equal(calc('=UNICODE(UNICHAR(8364))'), '8364');
  assert.equal(calc('=LEN(CLEAN(A1))', { A1: 'a\nb' }), '2');
  assert.equal(calc('=EXACT("a","A")'), 'FALSE');
  assert.equal(calc('=REPT("ab",3)'), 'ababab');
  assert.equal(calc('=TEXTJOIN(", ",TRUE,A1:A4)', { A1: 'x', A3: 'y', A4: '' }), 'x, y');
  assert.equal(calc('=TEXTJOIN("-",FALSE,A1:A3)', { A1: 'x', A3: 'y' }), 'x--y');
  assert.equal(calc('=TEXTJOIN("/",TRUE,TEXTSPLIT("a b c"," "))'), 'a/b/c');
  assert.equal(calc('=VALUE("$1,234.50")'), '1234.5');
  assert.equal(calc('=VALUE(" 12% ")'), '0.12');
  assert.equal(calc('=VALUE("(25)")'), '-25');
  assert.equal(calc('=VALUE("abc")'), '#VALUE!');
  assert.equal(calc('=NUMBERVALUE("1.234,5",",",".")'), '1234.5');
  // TRIM takes out spaces only, as Excel does: line breaks in the text stay.
  assert.equal(value('=TRIM(A1)', { A1: '  a   b \nc ' }), 'a b \nc');
});

test('XLOOKUP and XMATCH: exact, next smaller/larger, wildcards, from the end, not found', () => {
  const t = { A1: 'apple', A2: 'Banana', A3: 'cherry', A4: 'banana', B1: '1', B2: '2', B3: '3', B4: '4', C1: '10', C2: '20', C3: '30' };
  assert.equal(calc('=XLOOKUP("banana",A1:A4,B1:B4)', t), '2');
  assert.equal(calc('=XLOOKUP("banana",A1:A4,B1:B4,,0,-1)', t), '4');
  assert.equal(calc('=XLOOKUP("kiwi",A1:A4,B1:B4)', t), '#N/A');
  assert.equal(calc('=XLOOKUP("kiwi",A1:A4,B1:B4,"none")', t), 'none');
  assert.equal(calc('=XLOOKUP("ch*",A1:A4,B1:B4,,2)', t), '3');
  assert.equal(calc('=XLOOKUP(25,C1:C3,A1:A3,,-1)', t), 'Banana');
  assert.equal(calc('=XLOOKUP(25,C1:C3,A1:A3,,1)', t), 'cherry');
  assert.equal(calc('=XLOOKUP(35,C1:C3,A1:A3,,1)', t), '#N/A');
  assert.equal(calc('=XLOOKUP("1",B1:B4,A1:A4)', t), '#N/A');
  assert.equal(calc('=XLOOKUP("apple",A1:A4,B1:B3)', t), '#VALUE!');
  // A row comes back whole (it fills the cells beside the formula); INDEX picks one of them.
  assert.equal(calc('=INDEX(XLOOKUP("cherry",A1:A3,B1:C3),2)', t), '30');
  // Across a row.
  assert.equal(calc('=XLOOKUP("b",A1:C1,A2:C2)', { A1: 'a', B1: 'b', C1: 'c', A2: 'x', B2: 'y', C2: 'z' }), 'y');
  assert.equal(calc('=XMATCH("cherry",A1:A4)', t), '3');
  assert.equal(calc('=XMATCH("BANANA",A1:A4,0,-1)', t), '4');
  assert.equal(calc('=XMATCH(25,C1:C3,1)', t), '3');
  assert.equal(calc('=XMATCH(3,{1,2,3})'), '3');
});

test('IFS, SWITCH, IFNA, CHOOSE and the IS- checks', () => {
  assert.equal(calc('=IFS(A1>90,"A",A1>80,"B",TRUE,"C")', { A1: '85' }), 'B');
  assert.equal(calc('=IFS(A1>90,"A")', { A1: '85' }), '#N/A');
  assert.equal(calc('=SWITCH(A1,1,"one",2,"two","other")', { A1: '2' }), 'two');
  assert.equal(calc('=SWITCH(A1,1,"one",2,"two")', { A1: '3' }), '#N/A');
  // The text "1" is not the number 1.
  assert.equal(calc('=SWITCH(A1,1,"one","other")', { A1: "'1" }), 'other');
  assert.equal(calc('=IFNA(XLOOKUP("x",A1:A2,A1:A2),"missing")', { A1: 'a' }), 'missing');
  assert.equal(calc('=IFNA(1/0,"missing")'), '#DIV/0!');
  assert.equal(calc('=CHOOSE(2,"a","b","c")'), 'b');
  assert.equal(calc('=CHOOSE(4,"a","b","c")'), '#VALUE!');
  assert.equal(calc('=ISNA(XMATCH(9,{1,2}))'), 'TRUE');
  assert.equal(calc('=ISERR(XMATCH(9,{1,2}))'), 'FALSE');
  assert.equal(calc('=ISERR(1/0)'), 'TRUE');
  assert.equal(calc('=ISLOGICAL(1=1)'), 'TRUE');
  assert.equal(calc('=INDEX({1,2;3,4},2,1)'), '3');
  assert.equal(calc('=SUM({1,2;3,4})'), '10');
});

test('pasting plain text puts each line in its own row and splits only at tabs (commas stay)', () => {
  const wb = new Workbook();
  wb.importText(0, 0, 0, 'Jane Citizen, 12 Example Street\nSpringfield, 3000', '\t');
  assert.equal(wb.value(0, 0, 0), 'Jane Citizen, 12 Example Street');
  assert.equal(wb.value(0, 0, 1), 'Springfield, 3000');
  assert.equal(wb.value(0, 1, 0), null);
  wb.importText(0, 0, 5, 'a\tb\n1\t2', '\t');
  assert.equal(wb.value(0, 1, 5), 'b');
  assert.equal(wb.value(0, 1, 6), 2);
  // A cell copied with its line breaks comes back as one cell (quoted, the way Excel copies it).
  const src = book({ A1: 'one\ntwo', B1: 'x' });
  const copied = src.exportText(0, { c0: 0, r0: 0, c1: 1, r1: 0 }, '\t');
  const dst = new Workbook();
  dst.importText(0, 0, 0, copied, '\t');
  assert.equal(dst.value(0, 0, 0), 'one\ntwo');
  assert.equal(dst.value(0, 1, 0), 'x');
});
