// SPDX-License-Identifier: MIT
// Copyright (c) 2026 the uci-over-wasi contributors. The license's text is in LICENSE.
/**
 * The WebAssembly features beyond the floor that a module uses, read from its bytes: the facts a `requires`
 * line (docs/uci-over-wasi.md § The declaration) is checked against.
 *
 *   bun tools/wasm-features.ts <module.wasm>    prints one line per feature, and each relaxed op with its count
 *
 * It decodes every instruction of every function body, so an opcode it does not know throws rather than being
 * skipped: a skipped immediate would misread every instruction after it. The opcodes are the core
 * specification's, with the SIMD, relaxed SIMD, threads, bulk memory, tail call, typed function reference and
 * exception handling (legacy and exnref) proposals. It reads no constant expression outside a function body.
 */
import { readFileSync } from "node:fs";

/** the features a module uses, as `requires` names them */
export type Features = {
  /** imports wasi.thread-spawn */
  threadSpawn: boolean;
  /** imports or defines a shared memory */
  sharedMemory: boolean;
  /** uses an atomic instruction */
  atomics: boolean;
  /** uses an exception handling instruction or has a tag section */
  exceptionHandling: boolean;
  /** each relaxed SIMD op the module uses, with how many times */
  relaxed: Map<string, number>;
};

/** the relaxed SIMD ops, by their opcode after the 0xfd prefix (WebAssembly/relaxed-simd, Overview.md) */
const RELAXED: Record<number, string> = {
  0x100: "i8x16.relaxed_swizzle",
  0x101: "i32x4.relaxed_trunc_f32x4_s",
  0x102: "i32x4.relaxed_trunc_f32x4_u",
  0x103: "i32x4.relaxed_trunc_f64x2_s_zero",
  0x104: "i32x4.relaxed_trunc_f64x2_u_zero",
  0x105: "f32x4.relaxed_madd",
  0x106: "f32x4.relaxed_nmadd",
  0x107: "f64x2.relaxed_madd",
  0x108: "f64x2.relaxed_nmadd",
  0x109: "i8x16.relaxed_laneselect",
  0x10a: "i16x8.relaxed_laneselect",
  0x10b: "i32x4.relaxed_laneselect",
  0x10c: "i64x2.relaxed_laneselect",
  0x10d: "f32x4.relaxed_min",
  0x10e: "f32x4.relaxed_max",
  0x10f: "f64x2.relaxed_min",
  0x110: "f64x2.relaxed_max",
  0x111: "i16x8.relaxed_q15mulr_s",
  0x112: "i16x8.relaxed_dot_i8x16_i7x16_s",
  0x113: "i32x4.relaxed_dot_i8x16_i7x16_add_s",
};

/** reads a module's sections and function bodies */
class Reader {
  at = 0;
  readonly b: Uint8Array;
  constructor(b: Uint8Array) {
    this.b = b;
  }

  byte(): number {
    if (this.at >= this.b.length) throw new Error("the module ends inside an instruction");
    return this.b[this.at++];
  }

  /** an unsigned LEB128 */
  u(): number {
    let value = 0;
    for (let shift = 0; ; shift += 7) {
      const b = this.byte();
      value += (b & 0x7f) * 2 ** shift;
      if (b < 0x80) return value;
    }
  }

  /** a signed LEB128 of up to 64 bits, as a sign and a magnitude good enough to tell negative values apart */
  s(): number {
    let value = 0;
    let shift = 0;
    let b: number;
    do {
      b = this.byte();
      value += (b & 0x7f) * 2 ** shift;
      shift += 7;
    } while (b & 0x80);
    return b & 0x40 ? value - 2 ** shift : value;
  }

  skip(n: number): void {
    this.at += n;
  }

  /** a heap type: an abstract type's one byte, or a type index */
  heapType(): void {
    this.s();
  }

  /** a value type: one byte, or a reference type's prefix and its heap type */
  valType(): void {
    const t = this.byte();
    if (t === 0x63 || t === 0x64) this.heapType();
  }

  /** a block type: empty, one value type, or a type index */
  blockType(): void {
    const t = this.b[this.at];
    if (t === 0x63 || t === 0x64) {
      this.at++;
      this.heapType();
    } else this.s();
  }

  /** a memory argument: alignment, with a memory index when its bit 6 is set, and an offset */
  memarg(): void {
    if (this.u() & 0x40) this.u();
    this.u();
  }
}

/** the features `wasm` uses; throws on an opcode this file does not know */
export function featuresOf(wasm: Uint8Array): Features {
  const f: Features = { threadSpawn: false, sharedMemory: false, atomics: false, exceptionHandling: false, relaxed: new Map() };
  const r = new Reader(wasm);
  const text = new TextDecoder();
  const name = () => {
    const n = r.u();
    const s = text.decode(wasm.subarray(r.at, r.at + n));
    r.skip(n);
    return s;
  };
  /** memory limits: flags, then min and, if flag bit 0, max; bit 1 marks a shared memory */
  const limits = () => {
    const flags = r.u();
    r.u();
    if (flags & 1) r.u();
    if (flags & 2) f.sharedMemory = true;
  };
  for (r.at = 8; r.at < wasm.length; ) {
    const id = r.byte();
    const size = r.u();
    const end = r.at + size;
    if (id === 2) {
      for (let n = r.u(); n > 0; n--) {
        const module = name();
        const field = name();
        const kind = r.byte();
        if (kind === 0) r.u();
        else if (kind === 1) {
          r.valType();
          const flags = r.u();
          r.u();
          if (flags & 1) r.u();
        } else if (kind === 2) limits();
        else if (kind === 3) {
          r.valType();
          r.byte();
        } else if (kind === 4) {
          r.byte();
          r.u();
          f.exceptionHandling = true;
        } else throw new Error(`an import of kind ${kind}`);
        if (module === "wasi" && field === "thread-spawn") f.threadSpawn = true;
      }
    } else if (id === 5) {
      for (let n = r.u(); n > 0; n--) limits();
    } else if (id === 13) f.exceptionHandling = true;
    else if (id === 10) {
      for (let n = r.u(); n > 0; n--) {
        const bodySize = r.u();
        const bodyEnd = r.at + bodySize;
        for (let groups = r.u(); groups > 0; groups--) {
          r.u();
          r.valType();
        }
        while (r.at < bodyEnd) instruction(r, f);
        if (r.at !== bodyEnd) throw new Error(`a function body decoded past its end, at byte ${r.at}`);
      }
    }
    r.at = end;
  }
  return f;
}

/** decodes one instruction at `r.at`, and records the features it uses */
function instruction(r: Reader, f: Features): void {
  const op = r.byte();
  if (op >= 0x45 && op <= 0xc4) return; // numeric, with sign extension: no immediate
  if (op >= 0x28 && op <= 0x3e) return r.memarg();
  switch (op) {
    case 0x00: case 0x01: case 0x05: case 0x0b: case 0x0f: case 0x1a: case 0x1b: case 0xd1: case 0xd3: case 0xd4:
      return;
    case 0x02: case 0x03: case 0x04:
      return r.blockType();
    case 0x06: // try (legacy exception handling)
      f.exceptionHandling = true;
      return r.blockType();
    case 0x07: case 0x08: case 0x09: case 0x18: // catch, throw, rethrow, delegate
      f.exceptionHandling = true;
      r.u();
      return;
    case 0x0a: case 0x19: // throw_ref, catch_all
      f.exceptionHandling = true;
      return;
    case 0x1f: { // try_table
      f.exceptionHandling = true;
      r.blockType();
      for (let n = r.u(); n > 0; n--) {
        const kind = r.byte();
        if (kind < 2) r.u();
        r.u();
      }
      return;
    }
    case 0x0c: case 0x0d: case 0x10: case 0x12: case 0x14: case 0x15: case 0x20: case 0x21: case 0x22: case 0x23:
    case 0x24: case 0x25: case 0x26: case 0x3f: case 0x40: case 0xd2: case 0xd5: case 0xd6:
      r.u();
      return;
    case 0x0e:
      for (let n = r.u(); n >= 0; n--) r.u();
      return;
    case 0x11: case 0x13:
      r.u();
      r.u();
      return;
    case 0x1c:
      for (let n = r.u(); n > 0; n--) r.valType();
      return;
    case 0x41: case 0x42:
      r.s();
      return;
    case 0x43:
      return r.skip(4);
    case 0x44:
      return r.skip(8);
    case 0xd0:
      return r.heapType();
    case 0xfc:
      return misc(r);
    case 0xfd:
      return simd(r, f);
    case 0xfe:
      f.atomics = true;
      return atomic(r);
  }
  throw new Error(`unknown opcode 0x${op.toString(16)} at byte ${r.at - 1}`);
}

/** the 0xfc prefix: saturating truncation, bulk memory and tables */
function misc(r: Reader): void {
  const op = r.u();
  if (op <= 7) return;
  if (op === 8 || op === 10 || op === 12 || op === 14) {
    r.u();
    r.u();
  } else if (op === 9 || op === 11 || op === 13 || (op >= 15 && op <= 17)) r.u();
  else throw new Error(`unknown opcode 0xfc ${op} at byte ${r.at}`);
}

/** the 0xfd prefix: fixed-width and relaxed SIMD */
function simd(r: Reader, f: Features): void {
  const op = r.u();
  if (op <= 0x0b || op === 0x5c || op === 0x5d) r.memarg();
  else if (op === 0x0c || op === 0x0d) r.skip(16);
  else if (op >= 0x15 && op <= 0x22) r.skip(1);
  else if (op >= 0x54 && op <= 0x5b) {
    r.memarg();
    r.skip(1);
  } else if (op >= 0x100) {
    const relaxed = RELAXED[op];
    if (!relaxed) throw new Error(`unknown opcode 0xfd ${op} at byte ${r.at}`);
    f.relaxed.set(relaxed, (f.relaxed.get(relaxed) ?? 0) + 1);
  }
}

/** the 0xfe prefix: atomics */
function atomic(r: Reader): void {
  const op = r.u();
  if (op === 3) r.skip(1);
  else if (op <= 2 || (op >= 0x10 && op <= 0x4e)) r.memarg();
  else throw new Error(`unknown opcode 0xfe ${op} at byte ${r.at}`);
}

if (import.meta.main) {
  const file = process.argv[2];
  if (!file) throw new Error("usage: wasm-features.ts <module.wasm>");
  const f = featuresOf(readFileSync(file));
  console.log(`threads: ${f.threadSpawn ? "imports wasi.thread-spawn" : "no thread-spawn"}${f.sharedMemory ? ", shared memory" : ""}${f.atomics ? ", atomics" : ""}`);
  console.log(`exception-handling: ${f.exceptionHandling ? "used" : "not used"}`);
  console.log(`relaxed-simd: ${f.relaxed.size ? [...f.relaxed].map(([op, n]) => `${op} ×${n}`).join(", ") : "not used"}`);
}
