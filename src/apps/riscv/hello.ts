// The program a new file in the RISC-V Studio starts with: short enough to read in one go, and it shows the three
// things a program does here (print to the Output panel, draw on the screen, wait for the next frame).
// String.raw keeps "\n" inside the .asciz strings as the assembler's escape, not a line break.
export const HELLO_SOURCE = String.raw`# HELLO.S - a first program for the RISC-V Studio.
# It prints a line to the Output panel, then draws colour bars and
# a bouncing box on the screen for about four seconds, then ends.
# F5 runs it. Change a number, press F5 again, and see what happens.
.equ CTRL,    0x80000000
.equ PRESENT, 0x8000000C
.equ CLEAR,   0x80000010
.equ FB,      0x80010000
.equ VSYNC,   0x91000008
.equ MAXX,    152             # 160 wide, less the box
.equ MAXY,    72              # stops above the colour bars
.equ BARS,    12800           # 80 rows x 160: where the bars start

.text
main:   la   a0, hello        # print the greeting (service 4)
        li   a7, 4
        ecall
        li   t0, CTRL         # screen on, framebuffer mode
        li   t1, 0x21
        sw   t1, 0(t0)
        li   s0, 10           # box x
        li   s1, 10           # box y
        li   s2, 1            # x speed
        li   s3, 1            # y speed
        li   s4, 240          # frames left (60 a second)

frame:  li   t0, CLEAR        # clear to navy (colour 13)
        li   t1, 13
        sw   t1, 0(t0)
        call bars
        call box
        li   t0, PRESENT      # show what was drawn
        sw   zero, 0(t0)
        li   t0, VSYNC        # wait for the next frame
        sw   zero, 0(t0)
        add  s0, s0, s2       # move, and bounce at the edges
        add  s1, s1, s3
        bgtz s0, 1f
        neg  s2, s2
1:      li   t0, MAXX
        blt  s0, t0, 2f
        neg  s2, s2
2:      bgtz s1, 3f
        neg  s3, s3
3:      li   t0, MAXY
        blt  s1, t0, 4f
        neg  s3, s3
4:      addi s4, s4, -1
        bnez s4, frame
        la   a0, bye
        li   a7, 4
        ecall
        li   a7, 10           # exit
        ecall

# bars: sixteen bars, one per colour, along the bottom ten rows.
bars:   li   t0, FB
        li   t1, BARS
        add  t0, t0, t1
        li   t2, 10           # rows
b_row:  li   t3, 0            # colour
        mv   t4, t0
b_col:  li   t5, 10           # pixels per bar
b_px:   sb   t3, 0(t4)
        addi t4, t4, 1
        addi t5, t5, -1
        bnez t5, b_px
        addi t3, t3, 1
        li   t6, 16
        blt  t3, t6, b_col
        addi t0, t0, 160
        addi t2, t2, -1
        bnez t2, b_row
        ret

# box: an 8 x 8 yellow box at (s0, s1). y*160 could be one mul;
# the shifts (y<<7)+(y<<5) do the same and run on any RV32I.
box:    slli t0, s1, 7
        slli t1, s1, 5
        add  t0, t0, t1
        add  t0, t0, s0
        li   t1, FB
        add  t0, t0, t1
        li   t2, 8
x_row:  li   t3, 8
        mv   t4, t0
        li   t5, 5            # yellow
x_px:   sb   t5, 0(t4)
        addi t4, t4, 1
        addi t3, t3, -1
        bnez t3, x_px
        addi t0, t0, 160
        addi t2, t2, -1
        bnez t2, x_row
        ret

.data
hello:  .asciz "Hello from RISC-V! Watch the screen on the right.\n"
bye:    .asciz "Done. Change a number above and press F5 again.\n"
`;

/**
 * What a program for a real RISC-V Linux computer looks like: it starts at _start and talks to the operating system with
 * the write (64) and exit (93) system calls, which the Studio also understands. The same text assembles with the GNU
 * tools for a real board or QEMU.
 */
export const LINUX_SOURCE = String.raw`# LINUX.S - what a "real" RISC-V program looks like.
# This is the kind of file you would give the GNU assembler and run on a
# RISC-V Linux board (or the QEMU emulator), for example:
#   riscv64-unknown-elf-as -march=rv32i -mabi=ilp32 linux.s -o linux.o
#   riscv64-unknown-elf-ld -m elf32lriscv linux.o -o linux
# A Linux program starts at _start and asks the operating system for
# things with ecall: a7 = 64 is write(where, text, length) and a7 = 93 is
# exit(code). The Studio understands those two, so it runs here unchanged.
# It prints the first 12 Fibonacci numbers. Dividing by 10 (to print a
# number) is done by subtracting, so it also runs on a plain RV32I.
.equ TITLE_LEN, 19            # "Fibonacci numbers:" and a new line

        .globl _start
        .text
_start:
        li   a0, 1            # write(1 = the screen, title, TITLE_LEN)
        la   a1, title
        li   a2, TITLE_LEN
        li   a7, 64
        ecall

        li   s0, 0            # a = 0
        li   s1, 1            # b = 1
        li   s2, 12           # how many to print
loop:   mv   a0, s0
        call print_number
        add  t0, s0, s1       # a, b = b, a + b
        mv   s0, s1
        mv   s1, t0
        addi s2, s2, -1
        bnez s2, loop

        li   a0, 0            # exit(0): all went well
        li   a7, 93
        ecall

# print_number: writes a0 in decimal, then a new line. The digits are
# made from the right-hand end, into buffer, backwards.
print_number:
        la   t0, buffer
        addi t0, t0, 16       # just past the end of buffer
        li   t1, 10
        addi t0, t0, -1
        sb   t1, 0(t0)        # the new line (character 10)
        li   t4, 1            # characters so far
1:      li   t2, 0            # t2 = a0 / 10, and a0 becomes a0 % 10
2:      blt  a0, t1, 3f
        sub  a0, a0, t1
        addi t2, t2, 1
        j    2b
3:      addi a0, a0, 48       # 48 is the character "0"
        addi t0, t0, -1
        sb   a0, 0(t0)
        addi t4, t4, 1
        mv   a0, t2
        bnez a0, 1b
        li   a0, 1            # write(1, the digits, how many)
        mv   a1, t0
        mv   a2, t4
        li   a7, 64
        ecall
        ret

        .data
title:  .ascii "Fibonacci numbers:\n"
buffer: .space 16
`;
