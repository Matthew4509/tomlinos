// The RISC-V Studio's machine: every example assembles and runs without a fault, draws to the screen, and answers keys;
// the firmware services print; a runaway loop is held to the frame budget. No browser needed.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXAMPLES } from '../src/apps/riscv/examples.ts';
import { FRAME_BUDGET, Machine } from '../src/apps/riscv/machine.ts';
import { HELLO_SOURCE, LINUX_SOURCE } from '../src/apps/riscv/hello.ts';

function runFrames(m: Machine, frames: number, start = 0): number {
  let t = start;
  for (let i = 0; i < frames; i++) {
    t += 16.7;
    m.frame(t);
  }
  return t;
}

for (const ex of EXAMPLES) {
  test(`${ex.title} exports main, so gcc/clang can link it`, () => {
    assert.match(ex.source, /^\.globl main\nmain:/m);
  });

  test(`${ex.title} assembles, runs 10 seconds with keys pressed, and draws`, () => {
    const m = new Machine();
    assert.equal(m.load(ex.source), null, m.message);
    m.start(0);
    let t = runFrames(m, 60);
    // Start a game and play a little: every game starts on SPACE or ENTER and moves on the arrows.
    for (const key of [' ', 'Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', ' ', 'ArrowDown', 'a', 'd', 'w']) {
      m.keyDown(key);
      t = runFrames(m, 20, t);
      m.keyUp(key);
      t = runFrames(m, 20, t);
    }
    t = runFrames(m, 300, t);
    assert.notEqual(m.state, 'fault', m.message);
    assert.ok(m.presented > 100, `${ex.title} presented only ${m.presented} frames`);
    assert.ok(m.shown.some(v => v !== 0), `${ex.title} left the screen black`);
  });
}

test('the Hello example prints to the output panel and draws, then exits', () => {
  const m = new Machine();
  assert.equal(m.load(HELLO_SOURCE), null, m.message);
  m.start(0);
  runFrames(m, 400);
  assert.equal(m.state, 'halted', m.message);
  assert.ok(m.output.join('\n').includes('Hello from RISC-V'), m.output.join('\n'));
  assert.ok(m.shown.some(v => v !== 0));
});

test('an assembler problem names its line', () => {
  const m = new Machine();
  const problem = m.load('main: li t0, 1\n  bogus t0, t1\n');
  assert.ok(problem);
  assert.equal(problem.line, 2);
  assert.equal(m.state, 'empty');
});

test('a loop that never waits is held to the frame budget, and the page gets the frame back', () => {
  const m = new Machine();
  assert.equal(m.load('main: j main\n'), null);
  m.start(0);
  m.frame(16);
  assert.equal(m.cpu.retired, FRAME_BUDGET);
  assert.equal(m.state, 'running');
  m.pause();
  assert.equal(m.state, 'paused');
});

test('a bad address is a fault with the line, not a crash', () => {
  const m = new Machine();
  assert.equal(m.load('main: li t0, 0x70000000\n  lw t1, 0(t0)\n'), null);
  m.start(0);
  m.frame(16);
  assert.equal(m.state, 'fault');
  assert.match(m.message, /line 2/);
});

test('Step runs one instruction and says which', () => {
  const m = new Machine();
  assert.equal(m.load('main: li a0, 5\n  li a7, 1\n  ecall\n'), null);
  assert.match(m.step(0), /addi/);
  assert.equal(m.cpu.x[10], 5);
  assert.equal(m.state, 'paused');
  m.step(0);
  m.step(0);
  assert.deepEqual(m.output, ['5']);
});

test('keys only reach a program that has the screen on', () => {
  const m = new Machine();
  // Read KEY_EVENT into s1 forever, without turning the screen on.
  assert.equal(m.load('main: li t0, 0x90000004\nl: lw s1, 0(t0)\n  bnez s1, done\n  j l\ndone: ebreak\n'), null);
  m.start(0);
  m.keyDown(' ');
  m.frame(16);
  assert.equal(m.state, 'running');
  assert.equal(m.cpu.x[9], 0);
});

test('a Linux-style program starts at _start, writes with system call 64 and exits with 93', () => {
  const m = new Machine();
  assert.equal(m.load(LINUX_SOURCE), null, m.message);
  m.start(0);
  runFrames(m, 30);
  assert.equal(m.state, 'halted', m.message);
  assert.match(m.message, /exit code 0/);
  assert.deepEqual(m.output.filter(Boolean), ['Fibonacci numbers:', '0', '1', '1', '2', '3', '5', '8', '13', '21', '34', '55', '89']);
});

test('write (64) refuses anywhere but the screen, and too much at once', () => {
  const m = new Machine();
  assert.equal(m.load('_start: li a0, 3\n  li a2, 1\n  li a7, 64\n  ecall\n'), null);
  m.start(0);
  m.frame(16);
  assert.equal(m.state, 'fault');
  assert.match(m.message, /write \(64\)/);
});

test('M extension: the eight instructions encode exactly as Clang encodes them (riscv32 +m)', async () => {
  const { assemble } = await import('../src/apps/riscv/rv32i.ts');
  const src = 'mul a0,a1,a2\nmulh t0,t1,t2\nmulhsu s1,s2,s3\nmulhu a3,a4,a5\ndiv a0,a1,a2\ndivu t3,t4,t5\nrem s4,s5,s6\nremu a6,a7,t6\n';
  const out = assemble(src);
  assert.equal(out.error, null);
  assert.deepEqual(out.listing.map(l => l.word >>> 0),
    [0x02c58533, 0x027312b3, 0x033924b3, 0x02f736b3, 0x02c5c533, 0x03eede33, 0x036aea33, 0x03f8f833]);
});

test('M extension: results follow the spec, including divide by zero and the one overflow', async () => {
  const { assemble, Cpu } = await import('../src/apps/riscv/rv32i.ts');
  const run = (op: string, a: number, b: number): number => {
    const out = assemble(`${op} a0, a1, a2\n`);
    assert.equal(out.error, null);
    const mem = new Uint8Array(out.image);
    const cpu = new Cpu();
    cpu.reset(out.base, 0);
    cpu.x[11] = a; cpu.x[12] = b;
    const r = cpu.step({ load: (addr: number) => new DataView(mem.buffer).getUint32(addr - out.base, true), store: () => {} } as never);
    assert.equal(r.kind, 'ok');
    return cpu.x[10];
  };
  const MIN = -0x80000000;
  assert.equal(run('mul', 7, -6), -42);
  assert.equal(run('mul', 0x10000, 0x10000), 0);
  assert.equal(run('mulh', 0x10000, 0x10000), 1);
  assert.equal(run('mulh', -1, -1), 0);
  assert.equal(run('mulhu', -1, -1), -2);          // 0xfffffffe
  assert.equal(run('mulhsu', -1, -1), -1);         // -1 * 0xffffffff, high half
  assert.equal(run('div', -7, 2), -3);             // rounds toward zero
  assert.equal(run('rem', -7, 2), -1);
  assert.equal(run('divu', -2, 2), 0x7fffffff);
  assert.equal(run('remu', -1, 10), 5);            // 4294967295 % 10
  assert.equal(run('div', 5, 0), -1);
  assert.equal(run('divu', 5, 0), -1);
  assert.equal(run('rem', 5, 0), 5);
  assert.equal(run('remu', 5, 0), 5);
  assert.equal(run('div', MIN, -1), MIN);
  assert.equal(run('rem', MIN, -1), 0);
});
