/* RV32I: the assembler and the processor.
 *
 * This is a genuine RISC-V RV32I implementation, not a language that looks
 * like one. Every instruction of the unprivileged base integer set is
 * decoded and executed exactly as the specification describes it: the
 * encodings, the immediates, the sign extension, the branch semantics, the
 * shift amounts, jalr clearing bit 0, x0 reading as zero. What is NOT here is
 * any other extension - M (multiply/divide) is here, but no compressed instructions, no CSRs
 * - and the assembler refuses their mnemonics rather than inventing them.
 *
 * The assembler accepts the standard pseudo-instructions, expanded the way
 * the RISC-V assembly manual expands them (li, la, mv, not, neg, seqz, snez,
 * sltz, sgtz, beqz/bnez/blez/bgez/bltz/bgtz, bgt/ble/bgtu/bleu, j, jal
 * label, jr, jalr rs, ret, call), the ABI register names, the common
 * directives, and %hi/%lo. Everything else is an error with the line.
 *
 * Pure: no imports, no DOM, no globals. The machine around it (machine.ts)
 * supplies memory and devices through the Bus interface.
 *
 * Kept in its own one-space layout, as written.
 */

/* ---------- the bus the processor talks to ---------- */

/** A read or write outside the map, misaligned, or to a register that does
    not allow it. The processor turns it into a fault with the pc. */
export class BusFault extends Error {}

export interface Bus {
 /** Unsigned value of `size` bytes at `addr`. Throws BusFault. */
 load(addr: number, size: 1 | 2 | 4): number;
 /** Writes the low `size` bytes of `value`. Throws BusFault. */
 store(addr: number, size: 1 | 2 | 4, value: number): void;
}

/* ---------- registers ---------- */

export const ABI_NAMES = ['zero', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2', 's0', 's1', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7',
 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11', 't3', 't4', 't5', 't6'];
const REGISTER_INDEX: Record<string, number> = {};
ABI_NAMES.forEach((n, i) => { REGISTER_INDEX[n] = i; REGISTER_INDEX['x' + i] = i; });
REGISTER_INDEX.fp = 8;

/** x0..x31 as a number, or null. */
export const registerIndex = (token: string): number | null => {
 const i = REGISTER_INDEX[token.trim().toLowerCase()];
 return i === undefined ? null : i;
};

/* ---------- the processor ---------- */

export type Exec = { kind: 'ok' } | { kind: 'ecall' } | { kind: 'ebreak' } | { kind: 'fault'; message: string };
const OK: Exec = { kind: 'ok' }, ECALL: Exec = { kind: 'ecall' }, EBREAK: Exec = { kind: 'ebreak' };

const sext = (value: number, bits: number) => (value << (32 - bits)) >> (32 - bits);

export class Cpu {
 /** x0..x31. x0 is forced to zero after every instruction. */
 x = new Int32Array(32);
 pc = 0;
 /** Instructions retired since reset. */
 retired = 0;
 reset(pc: number, sp: number) { this.x.fill(0); this.x[2] = sp | 0; this.pc = pc >>> 0; this.retired = 0; }

 /** One instruction. Never throws: a bus fault or an illegal encoding comes
     back as a fault, with the pc still pointing at the instruction. */
 step(bus: Bus): Exec {
  const x = this.x, pc = this.pc;
  let ins: number;
  try { ins = bus.load(pc, 4); } catch (e) { return { kind: 'fault', message: `Instruction fetch failed at 0x${hex(pc)}: ${(e as Error).message}` }; }
  const opcode = ins & 0x7f, rd = (ins >>> 7) & 0x1f, funct3 = (ins >>> 12) & 7, rs1 = (ins >>> 15) & 0x1f, rs2 = (ins >>> 20) & 0x1f, funct7 = ins >>> 25;
  const immI = sext(ins >>> 20, 12);
  let next = pc + 4;
  try {
   switch (opcode) {
    case 0x37: x[rd] = ins & 0xfffff000; break;                                   // lui
    case 0x17: x[rd] = (pc + (ins & 0xfffff000)) | 0; break;                      // auipc
    case 0x6f: {                                                                 // jal
     const imm = sext(((ins >>> 31) << 20) | (((ins >>> 12) & 0xff) << 12) | (((ins >>> 20) & 1) << 11) | (((ins >>> 21) & 0x3ff) << 1), 21);
     x[rd] = next | 0; next = (pc + imm) | 0; break;
    }
    case 0x67: {                                                                 // jalr
     if (funct3 !== 0) return illegal(pc, ins);
     const target = ((x[rs1] + immI) | 0) & ~1; x[rd] = next | 0; next = target; break;
    }
    case 0x63: {                                                                 // branches
     const imm = sext(((ins >>> 31) << 12) | (((ins >>> 7) & 1) << 11) | (((ins >>> 25) & 0x3f) << 5) | (((ins >>> 8) & 0xf) << 1), 13);
     const a = x[rs1], b = x[rs2];
     let take: boolean;
     switch (funct3) {
      case 0: take = a === b; break; case 1: take = a !== b; break;
      case 4: take = a < b; break; case 5: take = a >= b; break;
      case 6: take = (a >>> 0) < (b >>> 0); break; case 7: take = (a >>> 0) >= (b >>> 0); break;
      default: return illegal(pc, ins);
     }
     if (take) next = (pc + imm) | 0; break;
    }
    case 0x03: {                                                                 // loads
     const addr = (x[rs1] + immI) >>> 0;
     switch (funct3) {
      case 0: x[rd] = sext(bus.load(addr, 1), 8); break;
      case 1: x[rd] = sext(bus.load(addr, 2), 16); break;
      case 2: x[rd] = bus.load(addr, 4) | 0; break;
      case 4: x[rd] = bus.load(addr, 1); break;
      case 5: x[rd] = bus.load(addr, 2); break;
      default: return illegal(pc, ins);
     }
     break;
    }
    case 0x23: {                                                                 // stores
     const imm = sext((funct7 << 5) | rd, 12), addr = (x[rs1] + imm) >>> 0;
     switch (funct3) {
      case 0: bus.store(addr, 1, x[rs2] & 0xff); break;
      case 1: bus.store(addr, 2, x[rs2] & 0xffff); break;
      case 2: bus.store(addr, 4, x[rs2] >>> 0); break;
      default: return illegal(pc, ins);
     }
     break;
    }
    case 0x13: {                                                                 // op-imm
     const a = x[rs1], shamt = rs2;
     switch (funct3) {
      case 0: x[rd] = (a + immI) | 0; break;
      case 2: x[rd] = a < immI ? 1 : 0; break;
      case 3: x[rd] = (a >>> 0) < (immI >>> 0) ? 1 : 0; break;
      case 4: x[rd] = a ^ immI; break;
      case 6: x[rd] = a | immI; break;
      case 7: x[rd] = a & immI; break;
      case 1: if (funct7 !== 0) return illegal(pc, ins); x[rd] = a << shamt; break;
      case 5: if (funct7 === 0) x[rd] = a >>> shamt; else if (funct7 === 0x20) x[rd] = a >> shamt; else return illegal(pc, ins); break;
     }
     break;
    }
    case 0x33: {                                                                 // op
     const a = x[rs1], b = x[rs2], sh = b & 31;
     if (funct7 === 0) {
      switch (funct3) {
       case 0: x[rd] = (a + b) | 0; break; case 1: x[rd] = a << sh; break;
       case 2: x[rd] = a < b ? 1 : 0; break; case 3: x[rd] = (a >>> 0) < (b >>> 0) ? 1 : 0; break;
       case 4: x[rd] = a ^ b; break; case 5: x[rd] = a >>> sh; break;
       case 6: x[rd] = a | b; break; case 7: x[rd] = a & b; break;
      }
     } else if (funct7 === 0x20 && funct3 === 0) x[rd] = (a - b) | 0;
     else if (funct7 === 0x20 && funct3 === 5) x[rd] = a >> sh;
     else if (funct7 === 1) x[rd] = mulDiv(funct3, a, b);                         // M extension
     else return illegal(pc, ins);
     break;
    }
    case 0x0f: break;                                                            // fence: one hart, no cache
    case 0x73: {                                                                 // system
     if (ins === 0x00000073) { x[0] = 0; this.retired++; this.pc = next >>> 0; return ECALL; }
     if (ins === 0x00100073) { x[0] = 0; this.retired++; return EBREAK; }
     return { kind: 'fault', message: `Illegal instruction at 0x${hex(pc)}: 0x${hex(ins)} is a CSR or privileged instruction, which this processor does not implement.` };
    }
    default: return illegal(pc, ins);
   }
  } catch (e) {
   if (e instanceof BusFault) return { kind: 'fault', message: `${e.message} (at pc 0x${hex(pc)})` };
   throw e;
  }
  x[0] = 0;
  this.retired++;
  this.pc = next >>> 0;
  return OK;
 }
}

/** The M extension, as the RISC-V spec defines it: the high halves of the 64-bit product, and division that never
    traps (divide by zero gives -1 / all ones and the remainder is the dividend; -2^31 / -1 gives -2^31, remainder 0). */
function mulDiv(f3: number, a: number, b: number): number {
 const hi = (p: bigint) => Number(BigInt.asIntN(32, p >> 32n));
 switch (f3) {
  case 0: return Math.imul(a, b);
  case 1: return hi(BigInt(a) * BigInt(b));                                     // mulh
  case 2: return hi(BigInt(a) * BigInt(b >>> 0));                               // mulhsu
  case 3: return hi(BigInt(a >>> 0) * BigInt(b >>> 0));                         // mulhu
  case 4: return b === 0 ? -1 : a === -0x80000000 && b === -1 ? a : (a / b) | 0; // div
  case 5: return b === 0 ? -1 : ((a >>> 0) / (b >>> 0)) | 0;                   // divu
  case 6: return b === 0 ? a : a === -0x80000000 && b === -1 ? 0 : (a % b) | 0;  // rem
  default: return b === 0 ? a : ((a >>> 0) % (b >>> 0)) | 0;                   // remu
 }
}

const illegal = (pc: number, ins: number): Exec => ({ kind: 'fault', message: `Illegal instruction at 0x${hex(pc)}: 0x${hex(ins)}.` });
export const hex = (n: number, width = 8) => (n >>> 0).toString(16).padStart(width, '0');

/* ---------- the assembler ---------- */

export type AsmError = { line: number; message: string };
export type Listing = { addr: number; word: number; line: number; source: string };
export type Assembled = {
 /** The whole image, text then data, as it is loaded at `base`. */
 image: Uint8Array;
 base: number;
 textSize: number;
 dataStart: number;
 labels: Record<string, number>;
 listing: Listing[];
 error: AsmError | null;
};

/** Base instructions by mnemonic: what shape they take and how they encode. */
type Shape = 'R' | 'I' | 'IL' | 'S' | 'B' | 'U' | 'J' | 'SH' | 'N' | 'JR';
const BASE: Record<string, { shape: Shape; op: number; f3?: number; f7?: number }> = {
 lui: { shape: 'U', op: 0x37 }, auipc: { shape: 'U', op: 0x17 },
 jal: { shape: 'J', op: 0x6f }, jalr: { shape: 'JR', op: 0x67, f3: 0 },
 beq: { shape: 'B', op: 0x63, f3: 0 }, bne: { shape: 'B', op: 0x63, f3: 1 }, blt: { shape: 'B', op: 0x63, f3: 4 }, bge: { shape: 'B', op: 0x63, f3: 5 }, bltu: { shape: 'B', op: 0x63, f3: 6 }, bgeu: { shape: 'B', op: 0x63, f3: 7 },
 lb: { shape: 'IL', op: 0x03, f3: 0 }, lh: { shape: 'IL', op: 0x03, f3: 1 }, lw: { shape: 'IL', op: 0x03, f3: 2 }, lbu: { shape: 'IL', op: 0x03, f3: 4 }, lhu: { shape: 'IL', op: 0x03, f3: 5 },
 sb: { shape: 'S', op: 0x23, f3: 0 }, sh: { shape: 'S', op: 0x23, f3: 1 }, sw: { shape: 'S', op: 0x23, f3: 2 },
 addi: { shape: 'I', op: 0x13, f3: 0 }, slti: { shape: 'I', op: 0x13, f3: 2 }, sltiu: { shape: 'I', op: 0x13, f3: 3 }, xori: { shape: 'I', op: 0x13, f3: 4 }, ori: { shape: 'I', op: 0x13, f3: 6 }, andi: { shape: 'I', op: 0x13, f3: 7 },
 slli: { shape: 'SH', op: 0x13, f3: 1, f7: 0 }, srli: { shape: 'SH', op: 0x13, f3: 5, f7: 0 }, srai: { shape: 'SH', op: 0x13, f3: 5, f7: 0x20 },
 add: { shape: 'R', op: 0x33, f3: 0, f7: 0 }, sub: { shape: 'R', op: 0x33, f3: 0, f7: 0x20 }, sll: { shape: 'R', op: 0x33, f3: 1, f7: 0 }, slt: { shape: 'R', op: 0x33, f3: 2, f7: 0 }, sltu: { shape: 'R', op: 0x33, f3: 3, f7: 0 },
 mul: { shape: 'R', op: 0x33, f3: 0, f7: 1 }, mulh: { shape: 'R', op: 0x33, f3: 1, f7: 1 }, mulhsu: { shape: 'R', op: 0x33, f3: 2, f7: 1 }, mulhu: { shape: 'R', op: 0x33, f3: 3, f7: 1 },
 div: { shape: 'R', op: 0x33, f3: 4, f7: 1 }, divu: { shape: 'R', op: 0x33, f3: 5, f7: 1 }, rem: { shape: 'R', op: 0x33, f3: 6, f7: 1 }, remu: { shape: 'R', op: 0x33, f3: 7, f7: 1 },
 xor: { shape: 'R', op: 0x33, f3: 4, f7: 0 }, srl: { shape: 'R', op: 0x33, f3: 5, f7: 0 }, sra: { shape: 'R', op: 0x33, f3: 5, f7: 0x20 }, or: { shape: 'R', op: 0x33, f3: 6, f7: 0 }, and: { shape: 'R', op: 0x33, f3: 7, f7: 0 },
 fence: { shape: 'N', op: 0x0f }, ecall: { shape: 'N', op: 0x73 }, ebreak: { shape: 'N', op: 0x73 },
};
/** Documented pseudo-instructions and their expansion sizes in words. */
export const PSEUDO: Record<string, { words: number; expands: string }> = {
 nop: { words: 1, expands: 'addi x0, x0, 0' }, li: { words: 2, expands: 'addi rd, x0, imm — or lui rd, hi; addi rd, rd, lo for a 32-bit value' }, la: { words: 2, expands: 'auipc rd, hi; addi rd, rd, lo (pc-relative)' },
 mv: { words: 1, expands: 'addi rd, rs, 0' }, not: { words: 1, expands: 'xori rd, rs, -1' }, neg: { words: 1, expands: 'sub rd, x0, rs' },
 seqz: { words: 1, expands: 'sltiu rd, rs, 1' }, snez: { words: 1, expands: 'sltu rd, x0, rs' }, sltz: { words: 1, expands: 'slt rd, rs, x0' }, sgtz: { words: 1, expands: 'slt rd, x0, rs' },
 beqz: { words: 1, expands: 'beq rs, x0, label' }, bnez: { words: 1, expands: 'bne rs, x0, label' }, blez: { words: 1, expands: 'bge x0, rs, label' }, bgez: { words: 1, expands: 'bge rs, x0, label' }, bltz: { words: 1, expands: 'blt rs, x0, label' }, bgtz: { words: 1, expands: 'blt x0, rs, label' },
 bgt: { words: 1, expands: 'blt rt, rs, label' }, ble: { words: 1, expands: 'bge rt, rs, label' }, bgtu: { words: 1, expands: 'bltu rt, rs, label' }, bleu: { words: 1, expands: 'bgeu rt, rs, label' },
 j: { words: 1, expands: 'jal x0, label' }, jr: { words: 1, expands: 'jalr x0, 0(rs)' }, ret: { words: 1, expands: 'jalr x0, 0(ra)' }, call: { words: 2, expands: 'auipc ra, hi; jalr ra, lo(ra)' },
};
/* RARS writes loads and stores against a label (RARS PseudoOps.txt): "lw t1,label"
   is auipc t1 then lw t1 from it, the destination serving as the temporary;
   "sw t1,label,t2" names the register that holds the address. GNU as accepts
   the same forms. A store with no third register has nowhere to put the
   address, and RARS refuses it too; so does this, with the form to use. */
const LOADS = new Set(['lb', 'lh', 'lw', 'lbu', 'lhu']), STORES = new Set(['sb', 'sh', 'sw']);
const isSymbolArg = (t: string | undefined) => !!t && /^[A-Za-z_.$][\w.$]*(\s*[+-]\s*\w+)?$/.test(t.trim()) && registerIndex(t.trim()) === null;
const labelLoad = (op: string, args: string[]) => LOADS.has(op) && args.length === 2 && isSymbolArg(args[1]);
const labelStore = (op: string, args: string[]) => STORES.has(op) && args.length === 3 && isSymbolArg(args[1]);
const NOT_HERE: Record<string, string> = { csrr: 'Zicsr', csrw: 'Zicsr', csrrw: 'Zicsr', csrrs: 'Zicsr', csrrc: 'Zicsr', mret: 'privileged', wfi: 'privileged', 'lr.w': 'A', 'sc.w': 'A', amoadd: 'A', 'fadd.s': 'F', 'flw': 'F', 'fsw': 'F', 'c.addi': 'C' };

export const TEXT_BASE = 0x00010000;
/** Program memory, as machine.ts declares it (PROGRAM_SIZE; the two must agree).
    Checked while assembling, before anything is allocated, so an oversized program cannot claim the memory. */
export const IMAGE_LIMIT = 0x40000;

type Item = { line: number; source: string; section: 'text' | 'data'; kind: 'ins' | 'data'; op: string; args: string[]; size: number; addr: number };

/** Strips a comment, honouring quotes so a '#' inside a string survives. */
function stripComment(raw: string): string {
 let out = '', quote: string | null = null;
 for (let i = 0; i < raw.length; i++) {
  const c = raw[i];
  if (quote) { out += c; if (c === '\\' && i + 1 < raw.length) { out += raw[++i]; } else if (c === quote) quote = null; continue; }
  if (c === '"' || c === "'") { quote = c; out += c; continue; }
  if (c === '#' || c === ';') break;
  out += c;
 }
 return out.trim();
}
/** Splits operands on commas outside quotes and parentheses. */
function splitArgs(text: string): string[] {
 const args: string[] = []; let cur = '', depth = 0, quote: string | null = null;
 for (let i = 0; i < text.length; i++) {
  const c = text[i];
  if (quote) { cur += c; if (c === '\\') { cur += text[++i] ?? ''; } else if (c === quote) quote = null; continue; }
  if (c === '"' || c === "'") { quote = c; cur += c; continue; }
  if (c === '(') depth++; if (c === ')') depth--;
  if (c === ',' && depth === 0) { args.push(cur.trim()); cur = ''; continue; }
  cur += c;
 }
 if (cur.trim() !== '' || args.length) args.push(cur.trim());
 return args.filter(a => a !== '');
}
function unescape(s: string): string {
 return s.replace(/\\(n|t|r|0|\\|"|')/g, (_, c) => ({ n: '\n', t: '\t', r: '\r', '0': '\0', '\\': '\\', '"': '"', "'": "'" }[c as string] as string));
}

export function assemble(source: string): Assembled {
 const fail = (line: number, message: string): Assembled => ({ image: new Uint8Array(0), base: TEXT_BASE, textSize: 0, dataStart: TEXT_BASE, labels: {}, listing: [], error: { line, message } });
 const raw = source.replace(/\r/g, '').split('\n');
 const items: Item[] = [];
 const labels: Record<string, number> = {};
 const constants: Record<string, number> = {};
 const pendingLabels: { name: string; line: number; section: 'text' | 'data' }[] = [];
 /* GNU-style numeric local labels: `1:` may be defined many times; `1f` is
    the next definition after the reference, `1b` the last one before it. */
 const locals: { num: string; item: number }[] = [];
 let section: 'text' | 'data' = 'text';

 /* Pass 0: constants. .equ, .set and RARS's .eqv may appear anywhere; the value is a number or an expression of constants defined above it. */
 for (let i = 0; i < raw.length; i++) {
  const text = stripComment(raw[i]);
  const m = /^\.(equ|set|eqv)\s+([A-Za-z_.$][\w.$]*)\s*(?:,\s*|\s+)(.+)$/.exec(text);
  if (m) { const v = parseNumber(m[3].trim()) ?? evalExpr(m[3].trim(), constants, null); if (v === null) return fail(i + 1, `.${m[1]} needs a number: ${m[3]}`); constants[m[2]] = v; }
 }

 /* Pass 1: items and sizes. A label takes the address of the next item in its section. */
 const declared = new Set<string>();
 for (let i = 0; i < raw.length; i++) {
  let text = stripComment(raw[i]);
  const line = i + 1;
  const nm = /^(\d+)\s*:\s*(.*)$/.exec(text);
  if (nm) { locals.push({ num: nm[1], item: items.length }); text = nm[2].trim(); }
  const lm = /^([A-Za-z_.$][\w.$]*)\s*:\s*(.*)$/.exec(text);
  if (lm) {
   /* `declared`, not `labels`: labels get their addresses only after the whole file is read (place, below), so a
      name used twice with an instruction between - or once in .text and once in .data - used to pass this check. */
   if (declared.has(lm[1]) || Object.hasOwn(constants, lm[1])) return fail(line, `Label ${lm[1]} is defined twice.`);
   declared.add(lm[1]);
   if (registerIndex(lm[1]) !== null) return fail(line, `${lm[1]} is a register name and cannot be a label.`);
   pendingLabels.push({ name: lm[1], line, section }); text = lm[2].trim();
  }
  if (text === '') continue;
  const om = /^([A-Za-z_.][\w.]*)\s*(.*)$/.exec(text);
  if (!om) return fail(line, `This line is not an instruction or directive: ${text}`);
  const op = om[1].toLowerCase(), rest = om[2].trim();
  if (op.startsWith('.')) {
   if (op === '.text' || op === '.data') { section = op.slice(1) as 'text' | 'data'; for (const p of pendingLabels) if (!p.section) p.section = section; continue; }
   if (op === '.globl' || op === '.global' || op === '.section' || op === '.equ' || op === '.set' || op === '.eqv' || op === '.option') continue;
   const args = splitArgs(rest);
   let size = 0;
   if (op === '.word') size = 4 * args.length; else if (op === '.half') size = 2 * args.length; else if (op === '.byte') size = args.length;
   else if (op === '.string' || op === '.asciz' || op === '.ascii') { if (args.length !== 1 || !/^".*"$/.test(args[0])) return fail(line, `${op} needs one quoted string.`); size = unescape(args[0].slice(1, -1)).length + (op === '.ascii' ? 0 : 1); }
   else if (op === '.space' || op === '.zero') { const n = parseNumber(args[0] ?? ''); if (n === null || n < 0) return fail(line, `${op} needs a byte count.`); if (n > IMAGE_LIMIT) return fail(line, `${op} ${n} is larger than program memory (${IMAGE_LIMIT} bytes).`); size = n; }
   else if (op === '.align') { const n = parseNumber(args[0] ?? ''); if (n === null || n < 0 || n > 16) return fail(line, '.align needs a power of two exponent from 0 to 16.'); size = -(1 << n); }
   else return fail(line, `Unknown directive ${op}.`);
   items.push({ line, source: text, section, kind: 'data', op, args, size, addr: 0 });
   bindLabels(items[items.length - 1]);
   continue;
  }
  if (NOT_HERE[op]) return fail(line, `${op} is not RV32I: it belongs to the ${NOT_HERE[op]} extension, which this processor does not implement.`);
  if (!BASE[op] && !PSEUDO[op]) return fail(line, `${op} is not an RV32IM instruction or a supported pseudo-instruction.`);
  if (section !== 'text') return fail(line, 'Instructions must be in the .text section.');
  const args = splitArgs(rest);
  let words = BASE[op] ? 1 : PSEUDO[op].words;
  if (labelLoad(op, args) || labelStore(op, args)) words = 2;
  /* li: one word when the value fits twelve signed bits. The value must be
     a constant here, so the size is known before any label is placed. */
  if (op === 'li') { if (args.length !== 2) return fail(line, 'li takes a register and a value: li t0, 100'); const v = evalExpr(args[1], constants, null); if (v === null) return fail(line, `li needs a constant value, not ${args[1]}. Use la for a label.`); if (fits12(v)) words = 1; }
  items.push({ line, source: text, section, kind: 'ins', op, args, size: 4 * words, addr: 0 });
  bindLabels(items[items.length - 1]);
  function bindLabels(item: Item) { for (const p of pendingLabels) (item as Item & { labels?: string[] }).labels = [...((item as Item & { labels?: string[] }).labels ?? []), p.name]; pendingLabels.length = 0; }
 }
 /* Layout: text in order, then data in order, each aligned as asked. */
 let addr = TEXT_BASE;
 const place = (sec: 'text' | 'data') => { for (const it of items) { if (it.section !== sec) continue; if (it.size < 0) { const a = -it.size; addr = (addr + a - 1) & ~(a - 1); it.size = 0; } it.addr = addr; for (const l of (it as Item & { labels?: string[] }).labels ?? []) labels[l] = addr; addr += it.size; } };
 place('text'); const textSize = addr - TEXT_BASE; addr = (addr + 3) & ~3; const dataStart = addr; place('data');
 for (const p of pendingLabels) labels[p.name] = addr;   // a label at the very end
 const localAddr = (l: { item: number }) => l.item < items.length ? items[l.item].addr : addr;
 const resolveLocals = (text: string, at: number): string => text.replace(/(?<![\w$.])(\d+)([fb])(?![\w])/g, (m, num, dir) => {
  const defs = locals.filter(l => l.num === num);
  const hit = dir === 'f' ? defs.find(l => localAddr(l) > at) : [...defs].reverse().find(l => localAddr(l) <= at);
  return hit ? String(localAddr(hit)) : m;
 });
 if (addr - TEXT_BASE > IMAGE_LIMIT) return fail(items.length ? items[items.length - 1].line : 1, `The program is ${addr - TEXT_BASE} bytes; program memory is ${IMAGE_LIMIT}.`);
 const image = new Uint8Array(addr - TEXT_BASE);
 const listing: Listing[] = [];
 const put32 = (at: number, w: number) => { const o = at - TEXT_BASE; image[o] = w & 0xff; image[o + 1] = (w >>> 8) & 0xff; image[o + 2] = (w >>> 16) & 0xff; image[o + 3] = (w >>> 24) & 0xff; };

 /* Pass 2: encode. */
 for (const it of items) {
  if (it.kind === 'data') {
   let o = it.addr - TEXT_BASE;
   if (it.op === '.word' || it.op === '.half' || it.op === '.byte') {
    const width = it.op === '.word' ? 4 : it.op === '.half' ? 2 : 1;
    for (const a of it.args) { const v = evalExpr(a, constants, labels); if (v === null) return fail(it.line, `Cannot read ${a} as a value.`); for (let k = 0; k < width; k++) image[o++] = (v >>> (8 * k)) & 0xff; }
   } else if (it.op === '.string' || it.op === '.asciz' || it.op === '.ascii') {
    const s = unescape(it.args[0].slice(1, -1)); for (let k = 0; k < s.length; k++) image[o++] = s.charCodeAt(k) & 0xff; if (it.op !== '.ascii') image[o++] = 0;
   }
   continue;
  }
  const words = encode({ ...it, args: it.args.map(a => resolveLocals(a, it.addr)) }, constants, labels);
  if (typeof words === 'string') return fail(it.line, words);
  words.forEach((w, k) => { put32(it.addr + 4 * k, w); listing.push({ addr: it.addr + 4 * k, word: w, line: it.line, source: it.source }); });
 }
 return { image, base: TEXT_BASE, textSize, dataStart, labels, listing, error: null };
}

const fits12 = (v: number) => v >= -2048 && v <= 2047;
const hi20 = (v: number) => ((v + 0x800) >> 12) & 0xfffff;
const lo12 = (v: number) => sext(v & 0xfff, 12);

/** A literal number: decimal, 0x, 0b, 'c', with an optional sign. */
export function parseNumber(t: string): number | null {
 t = t.trim();
 const neg = t.startsWith('-'); if (neg || t.startsWith('+')) t = t.slice(1).trim();
 let v: number | null = null;
 if (/^0x[0-9a-f]+$/i.test(t)) v = parseInt(t.slice(2), 16);
 else if (/^0b[01]+$/i.test(t)) v = parseInt(t.slice(2), 2);
 else if (/^\d+$/.test(t)) v = parseInt(t, 10);
 else if (/^'(\\.|[^'\\])'$/.test(t)) v = unescape(t.slice(1, -1)).charCodeAt(0);
 if (v === null || !Number.isFinite(v)) return null;
 return (neg ? -v : v) | 0;
}
/** A value: a number, a symbol, %hi(sym), %lo(sym), or terms of those joined by + and -.

    SYMBOLS ARE OWN KEYS (Object.hasOwn, not `in`): `in` also finds what every object inherits, so `li t0, toString`,
    `j constructor` and `la a0, __proto__` assembled against the object prototype instead of failing as undefined
    labels. And NESTING IS BOUNDED: 12,000 parentheses recursed until the stack overflowed, an exception out of
    assemble() and Machine.load. Past MAX_NEST it is simply not a value, which the caller reports as an error. Both
    found by testing the assembler with hostile input. */
export const MAX_NEST = 32;
export function evalExpr(text: string, constants: Record<string, number>, labels: Record<string, number> | null, nest = 0): number | null {
 if (nest > MAX_NEST) return null;
 const s = text.trim();
 const hm = /^%(hi|lo)\((.+)\)$/.exec(s);
 if (hm) { const v = evalExpr(hm[2], constants, labels, nest + 1); if (v === null) return null; return hm[1] === 'hi' ? hi20(v) : lo12(v); }
 const terms: { sign: number; term: string }[] = []; let cur = '', sign = 1, depth = 0;
 for (let i = 0; i < s.length; i++) { const c = s[i]; if (c === '(') depth++; if (c === ')') depth--; if ((c === '+' || c === '-') && depth === 0 && cur.trim() !== '') { terms.push({ sign, term: cur }); cur = ''; sign = c === '-' ? -1 : 1; continue; } cur += c; }
 terms.push({ sign, term: cur });
 const atom = (t: string): number | null => {
  t = t.trim(); if (t === '') return null;
  let v = parseNumber(t);
  if (v === null) { if (Object.hasOwn(constants, t)) v = constants[t]; else if (labels && Object.hasOwn(labels, t)) v = labels[t]; else if (/^%(hi|lo)\(/.test(t)) v = evalExpr(t, constants, labels, nest + 1); else if (/^\(.*\)$/.test(t)) v = evalExpr(t.slice(1, -1), constants, labels, nest + 1); else return null; }
  return v;
 };
 /* A term is atoms joined by * and / - enough for 45*160+80 in a constant. */
 const product = (t: string): number | null => {
  const parts = t.split(/([*/])/); let v = atom(parts[0]); if (v === null) return null;
  for (let i = 1; i < parts.length; i += 2) { const w = atom(parts[i + 1]); if (w === null) return null; if (parts[i] === '*') v = Math.imul(v, w); else { if (w === 0) return null; v = (v / w) | 0; } }
  return v;
 };
 let total = 0;
 for (const { sign: sg, term } of terms) {
  const v = product(term);
  if (v === null) return null;
  total = (total + sg * v) | 0;
 }
 return total;
}

const R = (f7: number, rs2: number, rs1: number, f3: number, rd: number, op: number) => ((f7 << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | op) >>> 0;
const I = (imm: number, rs1: number, f3: number, rd: number, op: number) => (((imm & 0xfff) << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | op) >>> 0;
const S = (imm: number, rs2: number, rs1: number, f3: number, op: number) => ((((imm >> 5) & 0x7f) << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | ((imm & 0x1f) << 7) | op) >>> 0;
const B = (imm: number, rs2: number, rs1: number, f3: number, op: number) => ((((imm >> 12) & 1) << 31) | (((imm >> 5) & 0x3f) << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | (((imm >> 1) & 0xf) << 8) | (((imm >> 11) & 1) << 7) | op) >>> 0;
const U = (imm20: number, rd: number, op: number) => (((imm20 & 0xfffff) << 12) | (rd << 7) | op) >>> 0;
const J = (imm: number, rd: number, op: number) => ((((imm >> 20) & 1) << 31) | (((imm >> 1) & 0x3ff) << 21) | (((imm >> 11) & 1) << 20) | (((imm >> 12) & 0xff) << 12) | (rd << 7) | op) >>> 0;

/** The words for one instruction item, or an error message. */
function encode(it: Item, constants: Record<string, number>, labels: Record<string, number>): number[] | string {
 const { op, args } = it;
 const reg = (t: string | undefined, what: string): number | string => { const i = registerIndex(t ?? ''); return i === null ? `${op} needs a register for ${what}, not "${t ?? ''}".` : i; };
 const val = (t: string | undefined, what: string): number | string => { const v = evalExpr(t ?? '', constants, labels); return v === null ? `${op}: cannot read ${what} "${t ?? ''}".` : v; };
 const need = (n: number): string | null => args.length === n ? null : `${op} takes ${n} operand${n === 1 ? '' : 's'}: ${op} ${usage(op)}`;
 /* Branch and jump targets are pc-relative; a label is the common case and a
    bare number is taken as an absolute address, as assemblers do. */
 const branchOff = (t: string, range: number, name: string): number | string => { const v = evalExpr(t, constants, labels); if (v === null) return `${op}: unknown label ${t}.`; const off = (v - it.addr) | 0; if (off & 1) return `${op}: target ${t} is not 2-byte aligned.`; if (off < -range || off >= range) return `${op}: ${t} is out of ${name} range (${off} bytes).`; return off; };
 const memArg = (t: string | undefined): { off: number; rs: number } | string => { const m = /^(.*)\((\s*[\w$]+\s*)\)$/.exec((t ?? '').trim()); if (!m) { const rs = registerIndex(t ?? ''); if (rs !== null) return { off: 0, rs }; return `${op} needs offset(register), such as 0(t0).`; } const off = m[1].trim() === '' ? 0 : evalExpr(m[1], constants, labels); const rs = registerIndex(m[2]); if (off === null) return `${op}: cannot read offset "${m[1]}".`; if (rs === null) return `${op}: "${m[2]}" is not a register.`; if (!fits12(off)) return `${op}: offset ${off} does not fit in 12 bits.`; return { off, rs }; };
 const base = BASE[op];
 if (base) {
  switch (base.shape) {
   case 'R': { const e = need(3); if (e) return e; const rd = reg(args[0], 'rd'), rs1 = reg(args[1], 'rs1'), rs2 = reg(args[2], 'rs2'); if (typeof rd === 'string') return rd; if (typeof rs1 === 'string') return rs1; if (typeof rs2 === 'string') return rs2; return [R(base.f7!, rs2, rs1, base.f3!, rd, base.op)]; }
   case 'I': { const e = need(3); if (e) return e; const rd = reg(args[0], 'rd'), rs1 = reg(args[1], 'rs1'), imm = val(args[2], 'the immediate'); if (typeof rd === 'string') return rd; if (typeof rs1 === 'string') return rs1; if (typeof imm === 'string') return imm; if (!fits12(imm)) return `${op}: ${imm} does not fit in a 12-bit immediate (-2048..2047). Use li into a register first.`; return [I(imm, rs1, base.f3!, rd, base.op)]; }
   case 'SH': { const e = need(3); if (e) return e; const rd = reg(args[0], 'rd'), rs1 = reg(args[1], 'rs1'), sh = val(args[2], 'the shift amount'); if (typeof rd === 'string') return rd; if (typeof rs1 === 'string') return rs1; if (typeof sh === 'string') return sh; if (sh < 0 || sh > 31) return `${op}: shift amount must be 0..31.`; return [R(base.f7!, sh, rs1, base.f3!, rd, base.op)]; }
   case 'IL': { const e = need(2); if (e) return e; const rd = reg(args[0], 'rd'); if (typeof rd === 'string') return rd; if (labelLoad(op, args)) { const v = evalExpr(args[1], constants, labels); if (v === null) return op + ': unknown label ' + args[1] + '.'; const off = (v - it.addr) | 0; return [U(hi20(off), rd, 0x17), I(lo12(off), rd, base.f3!, rd, base.op)]; } const m = memArg(args[1]); if (typeof m === 'string') return m; return [I(m.off, m.rs, base.f3!, rd, base.op)]; }
   case 'S': { if (labelStore(op, args)) { const rs2 = reg(args[0], 'the source register'), rt = reg(args[2], 'the address register'); if (typeof rs2 === 'string') return rs2; if (typeof rt === 'string') return rt; const v = evalExpr(args[1], constants, labels); if (v === null) return op + ': unknown label ' + args[1] + '.'; const off = (v - it.addr) | 0; return [U(hi20(off), rt, 0x17), S(lo12(off), rs2, rt, base.f3!, base.op)]; } if (args.length === 2 && isSymbolArg(args[1])) return op + ' with a label needs a register to hold the address: ' + op + ' ' + args[0] + ', ' + args[1] + ', t1 (any spare register; this is the form RARS and GNU accept).'; const e = need(2); if (e) return e; const rs2 = reg(args[0], 'the source register'); if (typeof rs2 === 'string') return rs2; const m = memArg(args[1]); if (typeof m === 'string') return m; return [S(m.off, rs2, m.rs, base.f3!, base.op)]; }
   case 'B': { const e = need(3); if (e) return e; const rs1 = reg(args[0], 'rs1'), rs2 = reg(args[1], 'rs2'); if (typeof rs1 === 'string') return rs1; if (typeof rs2 === 'string') return rs2; const off = branchOff(args[2], 4096, 'branch'); if (typeof off === 'string') return off; return [B(off, rs2, rs1, base.f3!, base.op)]; }
   case 'U': { const e = need(2); if (e) return e; const rd = reg(args[0], 'rd'), imm = val(args[1], 'the upper immediate'); if (typeof rd === 'string') return rd; if (typeof imm === 'string') return imm; if (imm < 0 || imm > 0xfffff) return `${op}: the immediate must be 0..0xFFFFF (use %hi(value)).`; return [U(imm, rd, base.op)]; }
   case 'J': { if (args.length === 1) { const off = branchOff(args[0], 1 << 20, 'jal'); if (typeof off === 'string') return off; return [J(off, 1, base.op)]; } const e = need(2); if (e) return e; const rd = reg(args[0], 'rd'); if (typeof rd === 'string') return rd; const off = branchOff(args[1], 1 << 20, 'jal'); if (typeof off === 'string') return off; return [J(off, rd, base.op)]; }
   case 'JR': { if (args.length === 1) { const rs = reg(args[0], 'rs'); if (typeof rs === 'string') return rs; return [I(0, rs, 0, 1, base.op)]; } const e = need(2); if (e) return e; const rd = reg(args[0], 'rd'); if (typeof rd === 'string') return rd; const m = memArg(args[1]); if (typeof m === 'string') return m; return [I(m.off, m.rs, 0, rd, base.op)]; }
   case 'N': { if (args.length && op !== 'fence') return `${op} takes no operands.`; return [op === 'ecall' ? 0x00000073 : op === 'ebreak' ? 0x00100073 : 0x0ff0000f]; }
  }
 }
 /* Pseudo-instructions, expanded as the manual expands them. */
 const x0 = 0, ra = 1;
 switch (op) {
  case 'nop': return [I(0, x0, 0, x0, 0x13)];
  case 'li': { const rd = reg(args[0], 'rd'), imm = val(args[1], 'the value'); if (typeof rd === 'string') return rd; if (typeof imm === 'string') return imm; if (fits12(imm)) return [I(imm, x0, 0, rd, 0x13)]; return [U(hi20(imm), rd, 0x37), I(lo12(imm), rd, 0, rd, 0x13)]; }
  case 'la': { const e = need(2); if (e) return e; const rd = reg(args[0], 'rd'); if (typeof rd === 'string') return rd; const v = evalExpr(args[1], constants, labels); if (v === null) return `la: unknown symbol ${args[1]}.`; const off = (v - it.addr) | 0; return [U(hi20(off), rd, 0x17), I(lo12(off), rd, 0, rd, 0x13)]; }
  case 'mv': { const e = need(2); if (e) return e; const rd = reg(args[0], 'rd'), rs = reg(args[1], 'rs'); if (typeof rd === 'string') return rd; if (typeof rs === 'string') return rs; return [I(0, rs, 0, rd, 0x13)]; }
  case 'not': { const e = need(2); if (e) return e; const rd = reg(args[0], 'rd'), rs = reg(args[1], 'rs'); if (typeof rd === 'string') return rd; if (typeof rs === 'string') return rs; return [I(-1, rs, 4, rd, 0x13)]; }
  case 'neg': { const e = need(2); if (e) return e; const rd = reg(args[0], 'rd'), rs = reg(args[1], 'rs'); if (typeof rd === 'string') return rd; if (typeof rs === 'string') return rs; return [R(0x20, rs, x0, 0, rd, 0x33)]; }
  case 'seqz': { const e = need(2); if (e) return e; const rd = reg(args[0], 'rd'), rs = reg(args[1], 'rs'); if (typeof rd === 'string') return rd; if (typeof rs === 'string') return rs; return [I(1, rs, 3, rd, 0x13)]; }
  case 'snez': { const e = need(2); if (e) return e; const rd = reg(args[0], 'rd'), rs = reg(args[1], 'rs'); if (typeof rd === 'string') return rd; if (typeof rs === 'string') return rs; return [R(0, rs, x0, 3, rd, 0x33)]; }
  case 'sltz': { const e = need(2); if (e) return e; const rd = reg(args[0], 'rd'), rs = reg(args[1], 'rs'); if (typeof rd === 'string') return rd; if (typeof rs === 'string') return rs; return [R(0, x0, rs, 2, rd, 0x33)]; }
  case 'sgtz': { const e = need(2); if (e) return e; const rd = reg(args[0], 'rd'), rs = reg(args[1], 'rs'); if (typeof rd === 'string') return rd; if (typeof rs === 'string') return rs; return [R(0, rs, x0, 2, rd, 0x33)]; }
  case 'beqz': case 'bnez': case 'blez': case 'bgez': case 'bltz': case 'bgtz': {
   const e = need(2); if (e) return e; const rs = reg(args[0], 'rs'); if (typeof rs === 'string') return rs; const off = branchOff(args[1], 4096, 'branch'); if (typeof off === 'string') return off;
   switch (op) { case 'beqz': return [B(off, x0, rs, 0, 0x63)]; case 'bnez': return [B(off, x0, rs, 1, 0x63)]; case 'blez': return [B(off, rs, x0, 5, 0x63)]; case 'bgez': return [B(off, x0, rs, 5, 0x63)]; case 'bltz': return [B(off, x0, rs, 4, 0x63)]; default: return [B(off, rs, x0, 4, 0x63)]; }
  }
  case 'bgt': case 'ble': case 'bgtu': case 'bleu': {
   const e = need(3); if (e) return e; const rs = reg(args[0], 'rs'), rt = reg(args[1], 'rt'); if (typeof rs === 'string') return rs; if (typeof rt === 'string') return rt; const off = branchOff(args[2], 4096, 'branch'); if (typeof off === 'string') return off;
   switch (op) { case 'bgt': return [B(off, rs, rt, 4, 0x63)]; case 'ble': return [B(off, rs, rt, 5, 0x63)]; case 'bgtu': return [B(off, rs, rt, 6, 0x63)]; default: return [B(off, rs, rt, 7, 0x63)]; }
  }
  case 'j': { const e = need(1); if (e) return e; const off = branchOff(args[0], 1 << 20, 'jump'); if (typeof off === 'string') return off; return [J(off, x0, 0x6f)]; }
  case 'jr': { const e = need(1); if (e) return e; const rs = reg(args[0], 'rs'); if (typeof rs === 'string') return rs; return [I(0, rs, 0, x0, 0x67)]; }
  case 'ret': { if (args.length) return 'ret takes no operands.'; return [I(0, ra, 0, x0, 0x67)]; }
  case 'call': { const e = need(1); if (e) return e; const v = evalExpr(args[0], constants, labels); if (v === null) return `call: unknown label ${args[0]}.`; const off = (v - it.addr) | 0; return [U(hi20(off), ra, 0x17), I(lo12(off), ra, 0, ra, 0x67)]; }
 }
 return `${op} is not implemented.`;
}
function usage(op: string): string {
 const b = BASE[op]; if (!b) return '...';
 switch (b.shape) { case 'R': return 'rd, rs1, rs2'; case 'I': return 'rd, rs1, imm'; case 'SH': return 'rd, rs1, shamt'; case 'IL': return 'rd, offset(rs1)'; case 'S': return 'rs2, offset(rs1)'; case 'B': return 'rs1, rs2, label'; case 'U': return 'rd, imm20'; case 'J': return 'rd, label'; case 'JR': return 'rd, offset(rs1)'; default: return ''; }
}

/** Every mnemonic the assembler knows, for the reference panel. */
export const BASE_MNEMONICS = Object.keys(BASE);
export const PSEUDO_MNEMONICS = Object.keys(PSEUDO);

/** Disassembles enough for a trace line: mnemonic and operands of a word. */
export function disassemble(ins: number): string {
 const op = ins & 0x7f, rd = (ins >>> 7) & 0x1f, f3 = (ins >>> 12) & 7, rs1 = (ins >>> 15) & 0x1f, rs2 = (ins >>> 20) & 0x1f, f7 = ins >>> 25;
 const immI = sext(ins >>> 20, 12), r = (i: number) => ABI_NAMES[i];
 switch (op) {
  case 0x37: return `lui ${r(rd)}, 0x${((ins >>> 12) & 0xfffff).toString(16)}`;
  case 0x17: return `auipc ${r(rd)}, 0x${((ins >>> 12) & 0xfffff).toString(16)}`;
  case 0x6f: return `jal ${r(rd)}, ${sext(((ins >>> 31) << 20) | (((ins >>> 12) & 0xff) << 12) | (((ins >>> 20) & 1) << 11) | (((ins >>> 21) & 0x3ff) << 1), 21)}`;
  case 0x67: return `jalr ${r(rd)}, ${immI}(${r(rs1)})`;
  case 0x63: return `${['beq', 'bne', '?', '?', 'blt', 'bge', 'bltu', 'bgeu'][f3]} ${r(rs1)}, ${r(rs2)}, ${sext(((ins >>> 31) << 12) | (((ins >>> 7) & 1) << 11) | (((ins >>> 25) & 0x3f) << 5) | (((ins >>> 8) & 0xf) << 1), 13)}`;
  case 0x03: return `${['lb', 'lh', 'lw', '?', 'lbu', 'lhu'][f3] ?? '?'} ${r(rd)}, ${immI}(${r(rs1)})`;
  case 0x23: return `${['sb', 'sh', 'sw'][f3] ?? '?'} ${r(rs2)}, ${sext((f7 << 5) | rd, 12)}(${r(rs1)})`;
  case 0x13: return f3 === 1 ? `slli ${r(rd)}, ${r(rs1)}, ${rs2}` : f3 === 5 ? `${f7 ? 'srai' : 'srli'} ${r(rd)}, ${r(rs1)}, ${rs2}` : `${['addi', '?', 'slti', 'sltiu', 'xori', '?', 'ori', 'andi'][f3]} ${r(rd)}, ${r(rs1)}, ${immI}`;
  case 0x33: if (f7 === 1) return `${['mul', 'mulh', 'mulhsu', 'mulhu', 'div', 'divu', 'rem', 'remu'][f3]} ${r(rd)}, ${r(rs1)}, ${r(rs2)}`;
   return `${f7 === 0x20 ? (f3 === 0 ? 'sub' : 'sra') : ['add', 'sll', 'slt', 'sltu', 'xor', 'srl', 'or', 'and'][f3]} ${r(rd)}, ${r(rs1)}, ${r(rs2)}`;
  case 0x0f: return 'fence';
  case 0x73: return ins === 0x73 ? 'ecall' : ins === 0x100073 ? 'ebreak' : 'system';
  default: return `.word 0x${hex(ins)}`;
 }
}
