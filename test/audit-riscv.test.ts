// RISC-V Studio audit (26 Nov): the processor checked against the RV32IM spec, and the assembler and firmware tried with
// wrong, odd and huge programs. No P0 was found: the processor tests pass and guard it. Faults that are P1 are marked
// todo (they report, and wait on a decision, without failing the suite).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Machine } from '../src/apps/riscv/machine.ts';
import { assemble, disassemble } from '../src/apps/riscv/rv32i.ts';

/** Assembles and runs a program until it ends (or 200 frames). */
function run(src: string, frames = 200): Machine {
  const m = new Machine();
  const e = m.load(src);
  assert.equal(e, null, `assembles: ${m.message}`);
  m.start(0);
  for (let i = 1; i <= frames && m.active; i++) m.frame(i * 16);
  return m;
}
const word = (m: Machine, i: number) => new DataView(m.ram.buffer).getInt32(i * 4, true);

/* ---------- the processor, against the spec (these pass and must keep passing) ---------- */

const s32 = (n: bigint) => Number(BigInt.asIntN(32, n));
const u32 = (n: number) => BigInt.asUintN(32, BigInt(n));
function reference(op: string, a: number, b: number): number {
  const A = BigInt(a), B = BigInt(b), Au = u32(a), Bu = u32(b), sh = Bu & 31n;
  switch (op) {
    case 'add': return s32(A + B);
    case 'sub': return s32(A - B);
    case 'sll': return s32(Au << sh);
    case 'srl': return s32(Au >> sh);
    case 'sra': return s32(A >> sh);
    case 'slt': return A < B ? 1 : 0;
    case 'sltu': return Au < Bu ? 1 : 0;
    case 'xor': return a ^ b;
    case 'or': return a | b;
    case 'and': return a & b;
    case 'mul': return s32(A * B);
    case 'mulh': return s32((A * B) >> 32n);
    case 'mulhsu': return s32((A * Bu) >> 32n);
    case 'mulhu': return s32((Au * Bu) >> 32n);
    case 'div': return B === 0n ? -1 : A === -(2n ** 31n) && B === -1n ? a : s32(A / B);
    case 'divu': return Bu === 0n ? -1 : s32(Au / Bu);
    case 'rem': return B === 0n ? a : A === -(2n ** 31n) && B === -1n ? 0 : s32(A % B);
    default: return Bu === 0n ? a : s32(Au % Bu); // remu
  }
}
const EDGE = [0, 1, -1, 2, -2, 31, 32, 33, 63, 0x7fffffff, -0x80000000, 0x55555555, -0x55555556, 0x12345678, -0x7fffffff, 0xffff, 0x10000, 7, -7];

for (const op of ['add', 'sub', 'sll', 'srl', 'sra', 'slt', 'sltu', 'xor', 'or', 'and', 'mul', 'mulh', 'mulhsu', 'mulhu', 'div', 'divu', 'rem', 'remu']) {
  test(`RV guard: ${op} gives the spec's answer for edge values (overflow, shifts of 32+, divide by zero, -2^31 / -1)`, () => {
    const cases: [number, number][] = [];
    for (const a of EDGE) for (const b of EDGE) cases.push([a, b]);
    const src = ['li s0, 0x00100000', ...cases.flatMap(([a, b]) => [`li t0, ${a}`, `li t1, ${b}`, `${op} t2, t0, t1`, 'sw t2, 0(s0)', 'addi s0, s0, 4']), 'ebreak'].join('\n');
    const m = run(src);
    assert.equal(m.state, 'halted', m.message);
    cases.forEach(([a, b], i) => assert.equal(word(m, i), reference(op, a, b), `${op} ${a}, ${b}`));
  });
}

test('RV guard: loads sign- or zero-extend, x0 stays zero, jalr with rd = rs1 jumps to the old rs1', () => {
  const m = run('.data\nb: .byte 0x80, 0x7f\nh: .half 0x8001\n.text\nla t0, b\nlb t1, 0(t0)\nlbu t2, 0(t0)\nla t0, h\nlh a1, 0(t0)\nlhu a2, 0(t0)\nli x0, 5\nlui zero, 1\nla a3, tgt\njalr a3, 0(a3)\nnop\ntgt: ebreak');
  assert.deepEqual([m.cpu.x[6], m.cpu.x[7], m.cpu.x[11], m.cpu.x[12], m.cpu.x[0]], [-128, 128, -32767, 0x8001, 0]);
  assert.equal(m.message.includes('line 16'), true, m.message);
});

test('RV guard: an endless loop is held to the frame budget and pauses', () => {
  const m = new Machine();
  m.load('loop: j loop');
  m.start(0);
  for (let i = 1; i <= 10; i++) m.frame(i * 16);
  assert.equal(m.cpu.retired, 10 * 40000);
  m.pause();
  assert.equal(m.state, 'paused');
});

/* ---------- P1 findings ---------- */

test('RV-P1-1: ";" separates two statements as in GNU as; it does not silently drop the second', { todo: 'P1' }, () => {
  const m = run('li t0, 1; li t1, 2\nebreak');
  assert.equal(m.cpu.x[6], 2, 'the second instruction on the line was thrown away as a comment');
});

test('RV-P1-2: .byte 300 and .half 70000 are refused (they were silently cut to 44 and 4464)', { todo: 'P1' }, () => {
  assert.notEqual(assemble('.data\n.byte 300').error, null);
  assert.notEqual(assemble('.data\n.half 70000').error, null);
});

test('RV-P1-3: a .string with "é" or "€" prints as written (the bytes are UTF-8; print reads them one by one as Latin-1)', { todo: 'P1' }, () => {
  const m = run('.data\ns: .string "café €"\n.text\nla a0, s\nli a7, 4\necall\nebreak');
  assert.equal(m.output.join('\n'), 'café €');
});

test('RV-P1-4: .align inside .text pads with nop, so running through it does not fault', { todo: 'P1' }, () => {
  const m = run('nop\n.align 4\nli t0, 3\nebreak');
  assert.equal(m.state, 'halted', m.message);
});

test('RV-P1-5: common GNU forms assemble: jalr rd, rs1, imm; tail; sgt; \\x escapes; 1<<4 and 2*-3', { todo: 'P1' }, () => {
  for (const src of ['la t0, x\njalr ra, t0, 0\nx: ebreak', 'tail x\nx: ebreak', 'sgt t0, t1, t2', '.data\n.string "\\x41"', 'li t0, 1<<4', 'li t0, 2*-3']) {
    assert.equal(assemble(src).error, null, src);
  }
  const m = run('.data\ns: .string "A\\x42C"\n.text\nla a0, s\nli a7, 4\necall\nebreak');
  assert.equal(m.output.join(''), 'ABC');
});

test('RV-P1-6: CLOCK.MILLIS does not count the time the program sat paused', { todo: 'P1' }, () => {
  const m = new Machine();
  m.load('loop: li t0, 0x91000000\nlw a0, 0(t0)\nli t1, 0x91000008\nsw t1, 0(t1)\nj loop');
  m.start(0);
  m.frame(16);
  m.frame(32);
  m.pause();
  m.start(100000); // paused for 100 seconds
  m.frame(100016);
  m.frame(100032);
  assert.ok(m.cpu.x[10] < 1000, `MILLIS jumped to ${m.cpu.x[10]} across the pause`);
});

test('RV-P1-7: a jump to a misaligned target faults at the jump, with the line, and leaves rd alone', { todo: 'P1' }, () => {
  const m = run('li t0, 0x10002\njalr ra, 0(t0)\nebreak');
  assert.equal(m.state, 'fault');
  assert.equal(m.cpu.x[1], 0, 'ra was written although the jump faulted');
  assert.match(m.message, /line 2/, m.message);
});

test('RV-P1-8: the Step trace does not name a reserved encoding as sra', { todo: 'P1' }, () => {
  assert.doesNotMatch(disassemble(0x40001033), /^sra/);
});

test('RV-P1-9: service 4 prints a string longer than 1024 bytes in full (it stopped at 1024 without a word)', { todo: 'P1' }, () => {
  const text = Array.from({ length: 20 }, () => 'x'.repeat(99)).join('\\n');
  const m = run(`.data\ns: .string "${text}"\n.text\nla a0, s\nli a7, 4\necall\nebreak`);
  assert.equal(m.output.join('\n').length, 20 * 99 + 19);
});

test('RV-P1-10: 8000 numbered local labels assemble in well under a second (6 s now: each 1b scans every 1:)', { todo: 'P1' }, () => {
  const t = performance.now();
  assert.equal(assemble('1: nop\nj 1b\n'.repeat(8000)).error, null);
  assert.ok(performance.now() - t < 1000, `took ${Math.round(performance.now() - t)} ms, with the whole desktop frozen`);
});

test('RV-P1-11: the RARS services a first program expects exist: 36 print unsigned, 5/8/12 read input', { todo: 'P1' }, () => {
  const m = run('li a0, -1\nli a7, 36\necall\nebreak');
  assert.equal(m.output.join(''), '4294967295');
});

test('RV-P1-12: fault messages end in one full stop, not ".."', { todo: 'P1' }, () => {
  const m = run('.word 0');
  assert.doesNotMatch(m.message, /\.\.$/, m.message);
});
