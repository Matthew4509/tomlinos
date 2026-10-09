// The computer the RISC-V Studio runs programs on: memory, one 160 x 90 screen, the keyboard, the clock, and the
// firmware services a program calls with ecall. The addresses are fixed, so the example games run here unchanged. No DOM here; the studio draws the screen.
//
// A program can never freeze the page: each animation frame runs at most FRAME_BUDGET instructions, then hands back.
import { assemble, BusFault, Cpu, disassemble, hex, type Assembled } from './rv32i.ts';

export const PROGRAM_BASE = 0x00010000;
export const PROGRAM_SIZE = 0x40000;
export const RAM_BASE = 0x00100000;
export const RAM_SIZE = 0x100000;
export const STACK_TOP = RAM_BASE + RAM_SIZE;
export const DISPLAY_BASE = 0x80000000;
export const FB_OFFSET = 0x10000;
export const INPUT_BASE = 0x90000000;
export const CLOCK_BASE = 0x91000000;
export const SCREEN_W = 160;
export const SCREEN_H = 90;
export const TEXT_COLS = 40;
export const TEXT_ROWS = 11;
export const FRAME_BUDGET = 40000;
/** Lines kept in the output panel, and the longest one: a program printing forever cannot grow the page without end. */
export const OUTPUT_LINES = 500;
export const OUTPUT_LINE_MAX = 400;

export const PALETTE = ['#000000', '#ffffff', '#ff3b30', '#34c759', '#3b6cff', '#ffd60a', '#5ac8fa', '#ff2d92', '#8e8e93', '#3a3a3c', '#ff9500', '#e9b46f', '#7bf4e8', '#0b1a3a', '#8b5a2b', '#ffb3c6'];
export const PALETTE_NAMES = ['BLACK', 'WHITE', 'RED', 'GREEN', 'BLUE', 'YELLOW', 'CYAN', 'MAGENTA', 'GREY', 'DARK GREY', 'ORANGE', 'AMBER', 'SAT CYAN', 'NAVY', 'BROWN', 'PINK'];

/** Keyboard bits at INPUT.KEYS, with the browser key names that set them. KEY_EVENT reports bit + 1. */
export const KEY_BITS: Array<[number, string, string[]]> = [
  [0, 'UP', ['ArrowUp']],
  [1, 'DOWN', ['ArrowDown']],
  [2, 'LEFT', ['ArrowLeft']],
  [3, 'RIGHT', ['ArrowRight']],
  [4, 'SPACE', [' ']],
  [5, 'ENTER', ['Enter']],
  [6, 'W', ['w', 'W']],
  [7, 'A', ['a', 'A']],
  [8, 'S', ['s', 'S']],
  [9, 'D', ['d', 'D']],
  [10, 'SHIFT', ['Shift']],
  [11, 'P', ['p', 'P']],
];

export interface Register {
  device: string;
  name: string;
  addr: number;
  access: 'ro' | 'wo' | 'rw';
  description: string;
}

/** Every device register, written down once: the bus and the Help screen both read this list. */
export const REGISTERS: Register[] = [
  { device: 'DISPLAY', name: 'CONTROL', addr: DISPLAY_BASE + 0x0, access: 'rw', description: 'Bit 0 on; bits 4-7 the mode: 1 text, 2 framebuffer. 0x21 = framebuffer on, 0x11 = text on.' },
  { device: 'DISPLAY', name: 'WIDTH', addr: DISPLAY_BASE + 0x4, access: 'ro', description: `${SCREEN_W} pixels (or ${TEXT_COLS} characters in text mode).` },
  { device: 'DISPLAY', name: 'HEIGHT', addr: DISPLAY_BASE + 0x8, access: 'ro', description: `${SCREEN_H} pixels (or ${TEXT_ROWS} lines in text mode).` },
  { device: 'DISPLAY', name: 'PRESENT', addr: DISPLAY_BASE + 0xc, access: 'wo', description: 'Write anything to show the framebuffer. Nothing drawn is seen until then.' },
  { device: 'DISPLAY', name: 'CLEAR', addr: DISPLAY_BASE + 0x10, access: 'wo', description: 'Write a colour (0-15) to fill the framebuffer with it.' },
  { device: 'DISPLAY', name: 'CURSOR', addr: DISPLAY_BASE + 0x14, access: 'rw', description: 'Text mode: row << 8 | column.' },
  { device: 'DISPLAY', name: 'TEXT_OUT', addr: DISPLAY_BASE + 0x18, access: 'wo', description: 'Text mode: print one character. 10 = new line, 12 = clear.' },
  { device: 'DISPLAY', name: 'BRIGHTNESS', addr: DISPLAY_BASE + 0x1c, access: 'rw', description: '0-255, default 255.' },
  { device: 'INPUT', name: 'KEYS', addr: INPUT_BASE + 0x0, access: 'ro', description: 'Keys held now, one bit each (see KEY_BITS in Help).' },
  { device: 'INPUT', name: 'KEY_EVENT', addr: INPUT_BASE + 0x4, access: 'ro', description: 'The oldest key pressed since the last read, as bit + 1; 0 if none.' },
  { device: 'INPUT', name: 'OWNS_KEYBOARD', addr: INPUT_BASE + 0x8, access: 'ro', description: '1 while the program has the keyboard.' },
  { device: 'CLOCK', name: 'MILLIS', addr: CLOCK_BASE + 0x0, access: 'ro', description: 'Milliseconds since the program started.' },
  { device: 'CLOCK', name: 'FRAME', addr: CLOCK_BASE + 0x4, access: 'ro', description: 'Frames since the program started.' },
  { device: 'CLOCK', name: 'VSYNC', addr: CLOCK_BASE + 0x8, access: 'wo', description: 'Write anything to wait for the next frame: draw, PRESENT, VSYNC.' },
  { device: 'CLOCK', name: 'SLEEP_MS', addr: CLOCK_BASE + 0xc, access: 'wo', description: 'Write a number of milliseconds to wait.' },
  { device: 'CLOCK', name: 'FRAME_BUDGET', addr: CLOCK_BASE + 0x10, access: 'ro', description: `Instructions allowed per frame (${FRAME_BUDGET}).` },
];
const BY_ADDR = new Map(REGISTERS.map(r => [r.addr >>> 0, r]));

export const SERVICES: Array<[number, string]> = [
  [1, 'print a0 as a number'],
  [4, 'print the text at a0 (ends at a zero byte)'],
  [10, 'exit'],
  [11, 'print a0 as one character'],
  [30, 'time: a0 low, a1 high milliseconds'],
  [32, 'sleep a0 milliseconds'],
  [34, 'print a0 in hex'],
  [35, 'print a0 in binary'],
  [40, 'seed the random numbers with a1'],
  [41, 'a0 = a random number'],
  [42, 'a0 = a random number from 0 to a1 - 1'],
  [64, 'Linux write: a0 = 1 (screen), a1 = where the text is, a2 = how many bytes'],
  [93, 'Linux exit: a0 = the exit code'],
];

export type MachineState = 'empty' | 'ready' | 'running' | 'waiting' | 'paused' | 'halted' | 'fault';

export class Machine {
  cpu = new Cpu();
  program = new Uint8Array(PROGRAM_SIZE);
  ram = new Uint8Array(RAM_SIZE);
  fb = new Uint8Array(SCREEN_W * SCREEN_H);
  shown = new Uint8Array(SCREEN_W * SCREEN_H);
  text: string[] = [];
  control = 0;
  brightness = 255;
  cursor = 0;
  presented = 0;
  state: MachineState = 'empty';
  message = 'Nothing assembled yet. Press F5 to run the program in the editor.';
  assembled: Assembled | null = null;
  output: string[] = [];
  keys = 0;
  events: number[] = [];
  frames = 0;
  now = 0;
  private startedAt = 0;
  private wakeAt = 0;
  private waitFrame = false;
  private debt = 0;
  private seed = ((Date.now() ^ 0x9e3779b9) >>> 0) || 1;

  /** Assembles and loads. Returns the problem and its line, or null when it assembled. */
  load(source: string): { line: number; message: string } | null {
    const a = assemble(source);
    if (a.error) {
      this.assembled = null;
      this.state = 'empty';
      this.message = `Line ${a.error.line}: ${a.error.message}`;
      return a.error;
    }
    if (a.image.length > PROGRAM_SIZE) {
      this.message = `The program is ${a.image.length} bytes; program memory holds ${PROGRAM_SIZE}.`;
      return { line: 1, message: this.message };
    }
    this.assembled = a;
    this.powerOn();
    this.message = `Assembled: ${a.textSize / 4} instructions, ${a.image.length - a.textSize} bytes of data.`;
    return null;
  }

  /** Everything back to power-on, with the assembled program in memory again. */
  powerOn(): void {
    // A program with a _start label (as a Linux program has) starts there; any other starts at its first line.
    const entry = this.assembled?.labels._start;
    this.cpu.reset(typeof entry === 'number' ? entry : PROGRAM_BASE, STACK_TOP);
    this.program.fill(0);
    if (this.assembled) this.program.set(this.assembled.image, 0);
    this.ram.fill(0);
    this.fb.fill(0);
    this.shown.fill(0);
    this.text = [];
    this.control = 0;
    this.brightness = 255;
    this.cursor = 0;
    this.presented = 0;
    this.output = [];
    this.keys = 0;
    this.events = [];
    this.frames = 0;
    this.wakeAt = 0;
    this.waitFrame = false;
    this.state = this.assembled ? 'ready' : 'empty';
  }

  start(now: number): void {
    if (!this.assembled) return;
    if (this.state === 'halted' || this.state === 'fault') this.powerOn();
    if (this.state === 'ready') this.startedAt = now;
    this.now = now;
    this.state = 'running';
    this.message = 'Running';
  }

  pause(): void {
    if (this.state !== 'running' && this.state !== 'waiting') return;
    this.state = 'paused';
    this.message = `Paused at 0x${hex(this.cpu.pc)}${this.lineFor(this.cpu.pc)}`;
    this.keys = 0;
    this.events = [];
  }

  get active(): boolean {
    return this.state === 'running' || this.state === 'waiting';
  }

  /** Does the program have the screen on, and so the keyboard? */
  ownsKeyboard(): boolean {
    return this.active && (this.control & 1) === 1 && ((this.control >> 4) & 0xf) !== 0;
  }

  /** One animation frame of work. */
  frame(now: number): void {
    this.now = now;
    if (!this.active) return;
    this.frames++;
    if (this.state === 'waiting') {
      if (this.waitFrame) {
        this.waitFrame = false;
        this.state = 'running';
      } else if (now >= this.wakeAt) this.state = 'running';
      else return;
    }
    let budget = FRAME_BUDGET;
    while (budget-- > 0) {
      const r = this.execute();
      if (this.debt) {
        budget -= this.debt;
        this.debt = 0;
      }
      if (r !== 'ok') break;
    }
  }

  /** One instruction for the Step key. Returns a line describing it. */
  step(now: number): string {
    if (!this.assembled) return 'Nothing is assembled.';
    if (this.state === 'halted' || this.state === 'fault') return this.message;
    if (this.state === 'ready') this.startedAt = now;
    this.now = now;
    this.state = 'running';
    this.waitFrame = false;
    const pc = this.cpu.pc;
    let word = 0;
    try {
      word = this.read(pc, 4);
    } catch {
      // The fault itself will say what went wrong.
    }
    const r = this.execute();
    if (r !== 'end') {
      this.state = 'paused';
      this.message = `Stepped: 0x${hex(pc)}  ${disassemble(word)}`;
    }
    return `0x${hex(pc)}  ${disassemble(word)}${this.lineFor(pc)}`;
  }

  /** The editor line an address came from, if it came from one. */
  sourceLine(pc: number): number | null {
    return this.assembled?.listing.find(l => l.addr === pc)?.line ?? null;
  }

  private lineFor(pc: number): string {
    const line = this.sourceLine(pc);
    return line ? `, line ${line}` : '';
  }

  private end(state: 'halted' | 'fault', message: string): 'end' {
    this.state = state;
    this.message = message;
    this.keys = 0;
    this.events = [];
    return 'end';
  }

  private execute(): 'ok' | 'wait' | 'end' {
    const ex = this.cpu.step(this.bus);
    if (ex.kind === 'ok') return this.state === 'waiting' ? 'wait' : 'ok';
    if (ex.kind === 'ebreak') return this.end('halted', `Stopped at ebreak (0x${hex(this.cpu.pc)}${this.lineFor(this.cpu.pc)}) after ${this.cpu.retired} instructions.`);
    if (ex.kind === 'fault') return this.end('fault', `Fault: ${ex.message}${this.lineFor(this.cpu.pc)}.`);
    const x = this.cpu.x;
    const a0 = x[10];
    const a7 = x[17];
    switch (a7) {
      case 1:
        this.print(String(a0));
        return 'ok';
      case 4: {
        let s = '';
        let p = a0 >>> 0;
        for (let i = 0; i < 1024; i++) {
          let c: number;
          try {
            c = this.read(p++, 1);
          } catch {
            return this.end('fault', `Fault: service 4 read past memory at 0x${hex(p - 1)}.`);
          }
          if (c === 0) break;
          s += String.fromCharCode(c);
        }
        this.debt += s.length;
        this.print(s);
        return 'ok';
      }
      case 10:
        return this.end('halted', `Program ended (exit) after ${this.cpu.retired} instructions.`);
      case 11:
        this.print(String.fromCharCode(a0 & 0xff));
        return 'ok';
      case 30: {
        const now = Date.now();
        x[10] = (now % 0x100000000) | 0;
        x[11] = Math.floor(now / 0x100000000) | 0;
        return 'ok';
      }
      case 32:
        this.wakeAt = this.now + Math.max(0, a0);
        this.state = 'waiting';
        return 'wait';
      case 34:
        this.print('0x' + hex(a0));
        return 'ok';
      case 35:
        this.print((a0 >>> 0).toString(2).padStart(32, '0'));
        return 'ok';
      case 40:
        this.seed = (x[11] >>> 0) || 1;
        return 'ok';
      case 41:
        x[10] = this.random() | 0;
        return 'ok';
      case 42: {
        const bound = x[11] | 0;
        if (bound <= 0) return this.end('fault', `Fault: service 42 needs a1 above zero (at 0x${hex(this.cpu.pc - 4)}).`);
        x[10] = this.random() % bound;
        return 'ok';
      }
      // The two Linux system calls a first program needs, numbered as RISC-V Linux numbers them, so a program written for
      // a real RISC-V Linux board runs here unchanged.
      case 64: {
        const fd = a0 | 0;
        const length = x[12] | 0;
        if (fd !== 1 && fd !== 2) return this.end('fault', `Fault: write (64) can only write to 1 (the screen) or 2 (errors); a0 was ${fd}.`);
        if (length < 0 || length > 4096) return this.end('fault', `Fault: write (64) takes 0 to 4096 bytes at a time; a2 was ${length}.`);
        let s = '';
        for (let i = 0; i < length; i++) {
          try {
            s += String.fromCharCode(this.read((x[11] + i) >>> 0, 1));
          } catch {
            return this.end('fault', `Fault: write (64) read past memory at 0x${hex((x[11] + i) >>> 0)}.`);
          }
        }
        this.debt += length;
        this.print(s);
        x[10] = length;
        return 'ok';
      }
      case 93:
      case 94:
        return this.end('halted', `Program ended (exit code ${a0 | 0}) after ${this.cpu.retired} instructions.`);
      default:
        return this.end('fault', `Fault: there is no firmware service ${a7} (a7, at 0x${hex(this.cpu.pc - 4)}). Help > Services lists them.`);
    }
  }

  private random(): number {
    let v = this.seed;
    v ^= v << 13;
    v ^= v >>> 17;
    v ^= v << 5;
    this.seed = v >>> 0;
    return this.seed;
  }

  private print(s: string): void {
    const cap = (line: string) => (line.length > OUTPUT_LINE_MAX ? line.slice(0, OUTPUT_LINE_MAX) : line);
    const parts = s.split('\n');
    if (!this.output.length) this.output.push('');
    this.output[this.output.length - 1] = cap(this.output[this.output.length - 1] + parts[0]);
    for (let i = 1; i < parts.length; i++) this.output.push(cap(parts[i]));
    if (this.output.length > OUTPUT_LINES) this.output.splice(0, this.output.length - OUTPUT_LINES);
  }

  /** x0-x31 by ABI name, and the pc. */
  registerRows(): string[] {
    const names = ['zero', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2', 's0', 's1', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11', 't3', 't4', 't5', 't6'];
    const rows: string[] = [];
    for (let i = 0; i < 32; i += 2) rows.push(`${names[i].padStart(4)} ${hex(this.cpu.x[i])}  ${names[i + 1].padStart(4)} ${hex(this.cpu.x[i + 1])}`);
    rows.push(`  pc ${hex(this.cpu.pc)}  ran ${this.cpu.retired}`);
    return rows;
  }

  // ---- keyboard ----

  keyDown(key: string): boolean {
    for (const [bit, , names] of KEY_BITS) {
      if (!names.includes(key)) continue;
      if (!(this.keys & (1 << bit))) {
        this.events.push(bit + 1);
        if (this.events.length > 32) this.events.shift();
      }
      this.keys |= 1 << bit;
      return true;
    }
    return false;
  }

  keyUp(key: string): boolean {
    for (const [bit, , names] of KEY_BITS) {
      if (!names.includes(key)) continue;
      this.keys &= ~(1 << bit);
      return true;
    }
    return false;
  }

  releaseKeys(): void {
    this.keys = 0;
  }

  // ---- the bus ----

  private bus = {
    load: (addr: number, size: 1 | 2 | 4): number => this.read(addr >>> 0, size),
    store: (addr: number, size: 1 | 2 | 4, value: number): void => this.write(addr >>> 0, size, value >>> 0),
  };

  private region(addr: number): { mem: Uint8Array; off: number } | null {
    if (addr >= PROGRAM_BASE && addr < PROGRAM_BASE + PROGRAM_SIZE) return { mem: this.program, off: addr - PROGRAM_BASE };
    if (addr >= RAM_BASE && addr < RAM_BASE + RAM_SIZE) return { mem: this.ram, off: addr - RAM_BASE };
    const fb = DISPLAY_BASE + FB_OFFSET;
    if (addr >= fb && addr < fb + this.fb.length) return { mem: this.fb, off: addr - fb };
    return null;
  }

  read(addr: number, size: 1 | 2 | 4): number {
    addr >>>= 0;
    if (addr & (size - 1)) throw new BusFault(`Misaligned ${size}-byte read at 0x${hex(addr)}`);
    const r = this.region(addr);
    if (r) {
      if (r.off + size > r.mem.length) throw new BusFault(`Read runs past the end of memory at 0x${hex(addr)}`);
      let v = 0;
      for (let k = size - 1; k >= 0; k--) v = (v << 8) | r.mem[r.off + k];
      return v >>> 0;
    }
    const reg = BY_ADDR.get(addr);
    if (!reg) throw new BusFault(`Nothing is at 0x${hex(addr)}`);
    if (size !== 4) throw new BusFault(`Device registers are whole words: use lw at 0x${hex(addr)}`);
    if (reg.access === 'wo') return 0;
    const textMode = ((this.control >> 4) & 0xf) === 1;
    switch (reg.name) {
      case 'CONTROL': return this.control;
      case 'WIDTH': return textMode ? TEXT_COLS : SCREEN_W;
      case 'HEIGHT': return textMode ? TEXT_ROWS : SCREEN_H;
      case 'CURSOR': return this.cursor;
      case 'BRIGHTNESS': return this.brightness;
      case 'KEYS': return this.ownsKeyboard() ? this.keys : 0;
      case 'KEY_EVENT': return this.ownsKeyboard() ? (this.events.shift() ?? 0) : 0;
      case 'OWNS_KEYBOARD': return this.ownsKeyboard() ? 1 : 0;
      case 'MILLIS': return Math.max(0, Math.floor(this.now - this.startedAt));
      case 'FRAME': return this.frames;
      case 'FRAME_BUDGET': return FRAME_BUDGET;
    }
    throw new BusFault(`${reg.device}.${reg.name} cannot be read`);
  }

  write(addr: number, size: 1 | 2 | 4, value: number): void {
    addr >>>= 0;
    if (addr & (size - 1)) throw new BusFault(`Misaligned ${size}-byte write at 0x${hex(addr)}`);
    const r = this.region(addr);
    if (r) {
      if (r.off + size > r.mem.length) throw new BusFault(`Write runs past the end of memory at 0x${hex(addr)}`);
      for (let k = 0; k < size; k++) r.mem[r.off + k] = (value >>> (8 * k)) & 0xff;
      return;
    }
    if (addr < 0x10000) throw new BusFault(`The first 64 KB is read-only (0x${hex(addr)})`);
    const reg = BY_ADDR.get(addr);
    if (!reg) throw new BusFault(`Nothing is at 0x${hex(addr)}`);
    if (size !== 4) throw new BusFault(`Device registers are whole words: use sw at 0x${hex(addr)}`);
    if (reg.access === 'ro') throw new BusFault(`${reg.device}.${reg.name} is read-only`);
    switch (reg.name) {
      case 'CONTROL':
        this.control = value & 0xff;
        if (!this.ownsKeyboard()) {
          this.keys = 0;
          this.events = [];
        }
        return;
      case 'PRESENT':
        this.shown.set(this.fb);
        this.presented++;
        return;
      case 'CLEAR':
        this.fb.fill(value & 0xf);
        if (((this.control >> 4) & 0xf) === 1) this.text = [];
        return;
      case 'CURSOR':
        this.cursor = value & 0xffff;
        return;
      case 'TEXT_OUT':
        this.textOut(value & 0xff);
        return;
      case 'BRIGHTNESS':
        this.brightness = value & 0xff;
        return;
      case 'VSYNC':
        this.waitFrame = true;
        this.state = 'waiting';
        return;
      case 'SLEEP_MS':
        this.wakeAt = this.now + Math.max(0, value | 0);
        this.state = 'waiting';
        return;
    }
    throw new BusFault(`${reg.device}.${reg.name} cannot be written`);
  }

  private textOut(c: number): void {
    if (c === 12) {
      this.text = [];
      this.cursor = 0;
      return;
    }
    let row = this.cursor >> 8;
    let col = this.cursor & 0xff;
    while (this.text.length <= row) this.text.push('');
    if (c === 10) {
      row++;
      col = 0;
    } else {
      const line = this.text[row].padEnd(col, ' ');
      this.text[row] = (line.slice(0, col) + String.fromCharCode(c) + line.slice(col + 1)).slice(0, TEXT_COLS);
      col++;
      if (col >= TEXT_COLS) {
        col = 0;
        row++;
      }
    }
    if (row >= TEXT_ROWS) {
      this.text.shift();
      row = TEXT_ROWS - 1;
    }
    this.cursor = (row << 8) | col;
  }
}
