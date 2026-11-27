// SPDX-License-Identifier: MIT
// Copyright (c) 2026 the uci-over-wasi contributors. The license's text is in LICENSE.
/**
 * The host side of UCI over WASI: the WASI preview-1 calls a WASI build imports,
 * answered on the thread that runs the engine. A host delivers input to a running
 * search, and this file has two ways to do it.
 *
 * Through shared memory (Ring): another thread writes input into a ring, stdin's
 * reader under Bun and Node (main.ts) or the page's messages in a browser, and the
 * engine's thread reads it without returning to its event loop.
 *
 * By suspending the module (Queue, runSuspending): one thread runs the engine and
 * takes the input. `fd_read` and `poll_oneoff` are suspending imports (JavaScript
 * Promise Integration), so a read with nothing waiting, and now and then a
 * search's poll, hand the thread to its event loop, which delivers what waits. It
 * needs no shared memory, so it serves a page that is not cross-origin isolated.
 *
 * Input known in full before the engine starts needs neither (Script).
 * Platform-neutral: no node: imports.
 *
 * A module may rely on seven calls (wasiImports). A libc or a Rust std imports
 * more of preview 1 than it calls, so every other import gets a fixed answer
 * (floorStubs), and a module that needs more than those answers does not run here.
 *
 * A module declares in a custom section (declarationOf) the features it needs
 * beyond the floor, which a host without them refuses (refusal), and whether
 * it reads nothing during a search. Such a module's host answers in its place
 * the lines its search could not act on (unheard), and passes on the rest.
 *
 * The layouts are WASI preview 1's (WebAssembly/WASI, legacy/preview1/docs.md).
 */

// === Module inspection ===

/** how a module takes input during a search: it hears stdin during the search, or it is deaf until the search ends */
export type Profile = "polls" | "deaf";

/** the WebAssembly features beyond the floor that a module may need, by their proposal names */
export type Feature = "threads" | "relaxed-simd" | "exception-handling";
const FEATURES: readonly Feature[] = ["threads", "relaxed-simd", "exception-handling"];

/** what a module declares in its custom section: its profile, and the features it needs */
export type Declaration = { profile: Profile; requires: Feature[] };

/** the custom section a module declares itself in, as lines of key=value */
const SECTION = "uci_over_wasi";

/** the 8-byte header of a core WebAssembly module: the magic `\0asm`, then version 1 */
const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

/** an unsigned LEB128 in `wasm` at `at` (before `limit`): its value and the offset after it */
function leb(wasm: Uint8Array, at: number, limit = wasm.length): [number, number] {
  let value = 0;
  for (let shift = 0; shift <= 56; shift += 7) {
    if (at >= limit) throw new Error("unexpected end of WebAssembly module");
    const b = wasm[at++]!;
    value += (b & 0x7f) * 2 ** shift;
    if (b < 0x80) return [value, at];
  }
  throw new Error("invalid LEB128 in WebAssembly module");
}

/** a module's sections in order: each one's id and the bounds of its content; throws for a bad header or a truncated section */
function* sections(wasm: Uint8Array): Generator<{ id: number; body: number; end: number }> {
  if (wasm.length < HEADER.length || HEADER.some((b, i) => wasm[i] !== b)) throw new Error("not a WebAssembly module");
  for (let at = HEADER.length; at < wasm.length; ) {
    const id = wasm[at]!;
    const [size, body] = leb(wasm, at + 1);
    const end = body + size;
    if (end > wasm.length) throw new Error("truncated section in WebAssembly module");
    yield { id, body, end };
    at = end;
  }
}

/**
 * A module's declaration, read from its bytes: the `profile` and `requires` lines of its `uci_over_wasi`
 * custom section, which holds lines of key=value. With no section or no line, a module polls and needs no
 * feature. A key this host does not know is ignored. A profile or a feature it does not know throws: the
 * host could not tell what the module needs, so it does not run it. A build writes the section with
 * `llvm-objcopy --add-section=uci_over_wasi=<file>`, or from its source.
 */
export function declarationOf(wasm: Uint8Array): Declaration {
  const declaration: Declaration = { profile: "polls", requires: [] };
  const text = new TextDecoder();
  for (const { id, body, end } of sections(wasm)) {
    // a custom section (id 0) opens with its name
    if (id === 0) {
      const [nameLen, name] = leb(wasm, body, end);
      if (name + nameLen > end) throw new Error("truncated custom section in WebAssembly module");
      if (text.decode(wasm.subarray(name, name + nameLen)) === SECTION) {
        for (const line of text.decode(wasm.subarray(name + nameLen, end)).split("\n")) {
          const eq = line.indexOf("=");
          if (eq < 0) continue;
          const key = line.slice(0, eq).trim();
          const value = line.slice(eq + 1).trim();
          if (key === "profile") {
            if (value !== "polls" && value !== "deaf") throw new Error(`the module declares profile=${value}; this host knows polls and deaf`);
            declaration.profile = value;
          } else if (key === "requires") {
            for (const f of value.split(/\s+/).filter((w) => w !== "")) {
              if (!FEATURES.includes(f as Feature)) throw new Error(`the module requires ${f}; this host knows ${FEATURES.join(", ")}`);
              if (!declaration.requires.includes(f as Feature)) declaration.requires.push(f as Feature);
            }
          }
        }
      }
    }
  }
  return declaration;
}

/** a module's profile (declarationOf) */
export function profileOf(wasm: Uint8Array): Profile {
  return declarationOf(wasm).profile;
}

/**
 * The smallest module that uses each feature, for WebAssembly.validate: whether this runtime has it.
 * Exception handling has two encodings, the legacy `try` and `try_table`; a runtime with either counts.
 */
const PROBES: Record<Exclude<Feature, "threads">, number[][]> = {
  // () -> v128: i8x16.relaxed_swizzle of two splats
  "relaxed-simd": [[0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 15, 1, 13, 0, 65, 1, 253, 15, 65, 2, 253, 15, 253, 128, 2, 11]],
  // () -> (): try with catch_all; try_table with no catch
  "exception-handling": [
    [0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 8, 1, 6, 0, 6, 64, 25, 11, 11],
    [0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 8, 1, 6, 0, 31, 64, 0, 11, 11],
  ],
};

/**
 * Why this host cannot run a module that declares `declaration`, or undefined if it can. `canSpawn` is whether
 * the host starts threads where it runs now; the other features are the runtime's.
 */
export function refusal(declaration: Declaration, canSpawn: boolean): string | undefined {
  for (const f of declaration.requires) {
    if (f === "threads") {
      if (!canSpawn) return "the module requires threads, which this host cannot start here";
    } else if (!PROBES[f].some((p) => WebAssembly.validate(new Uint8Array(p)))) return `the module requires ${f}, which this runtime does not have`;
  }
  return undefined;
}

/** the one memory import a host gives: a wasi-threads module's shared memory, as wasm-ld names it */
const MEMORY_MODULE = "env";
const MEMORY_NAME = "memory";

/**
 * The shared memory a wasi-threads module imports, made to the limits its import declares, or undefined for a
 * module that imports no memory. A JavaScript runtime does not report an import's limits, so they are read from
 * the bytes. Every thread of one instance is given the same memory. Throws for a memory a host does not give:
 * one not shared, with no maximum, or under another name.
 */
export function sharedMemory(wasm: Uint8Array): WebAssembly.Memory | undefined {
  const text = new TextDecoder();
  for (const { id, body, end } of sections(wasm)) {
    if (id === 2) {
      let [count, p] = leb(wasm, body, end);
      const byte = () => {
        if (p >= end) throw new Error("truncated import section in WebAssembly module");
        return wasm[p++]!;
      };
      const skipValType = () => {
        const t = byte();
        if (t === 0x63 || t === 0x64) [, p] = leb(wasm, p, end);
      };
      for (; count > 0; count--) {
        const [mLen, m] = leb(wasm, p, end);
        if (m + mLen > end) throw new Error("truncated import section in WebAssembly module");
        const [nLen, n] = leb(wasm, m + mLen, end);
        if (n + nLen > end) throw new Error("truncated import section in WebAssembly module");
        const module = text.decode(wasm.subarray(m, m + mLen));
        const name = text.decode(wasm.subarray(n, n + nLen));
        p = n + nLen;
        const kind = byte();
        if (kind === 0) [, p] = leb(wasm, p, end);
        else if (kind === 1 || kind === 2) {
          // a table's element type, then the limits: flags, the initial size and, with flag 1, the maximum
          if (kind === 1) skipValType();
          const flags = byte();
          let initial: number;
          let maximum: number | undefined;
          [initial, p] = leb(wasm, p, end);
          if (flags & 1) [maximum, p] = leb(wasm, p, end);
          if (kind === 2) {
            if (module !== MEMORY_MODULE || name !== MEMORY_NAME || !(flags & 2) || maximum === undefined) {
              throw new Error(`the module imports memory ${module}.${name}; a host gives only a shared memory with a maximum, as ${MEMORY_MODULE}.${MEMORY_NAME}`);
            }
            return new WebAssembly.Memory({ initial, maximum, shared: true });
          }
        } else if (kind === 3) {
          skipValType();
          byte();
        } else if (kind === 4) {
          byte();
          [, p] = leb(wasm, p, end);
        } else throw new Error(`the module has an import of kind ${kind}, which this host does not know`);
      }
      return undefined;
    }
  }
  return undefined;
}

/** what one instance of a wasi-threads module is given: the module's shared memory, and its thread start */
export type Threads = {
  memory: WebAssembly.Memory;
  /** answers wasi.thread-spawn: starts a thread that calls the module's wasi_thread_start(id, arg), and returns its id */
  spawn: (arg: number) => number;
};

/**
 * thread-spawn's answer where a host starts no thread: a negative value, which wasi-libc's pthread_create
 * reports as EAGAIN. A module that does not require threads then plays on the threads it has.
 */
export const NO_SPAWN = (_arg: number): number => -6;

/** what a host that starts no thread gives a module: its shared memory, if it imports one, and a failing spawn */
export function unthreaded(wasm: Uint8Array): Threads | undefined {
  const memory = sharedMemory(wasm);
  return memory && { memory, spawn: NO_SPAWN };
}

// === Deaf module filtering ===

/** the words of a `go` that end its search without a `stop`; `perft` is no search, and ends by itself */
const BOUNDS = ["wtime", "btime", "movetime", "depth", "nodes", "mate", "perft"];

/**
 * Whether a `go` line is unbounded: nothing in it ends the search. It has
 * `infinite` or `ponder`, or it has none of the words that bound a search.
 * Either side's clock counts as a bound, so a host need not know the side to
 * move.
 */
export function unbounded(words: string[]): boolean {
  return words.includes("infinite") || words.includes("ponder") || !BOUNDS.some((b) => words.includes(b));
}

/**
 * What a host does with one line of input for a search that hears nothing: a
 * deaf module's, or any module's where the host cannot deliver input to a
 * running search. null: pass the line on. Otherwise the host's own answer, which
 * may be no lines at all. A `stop` or `ponderhit` is dropped, since the search
 * has ended by the time it could be read. An unbounded `go` is refused, since
 * nothing could end it; the null move keeps a GUI that waits for a bestmove
 * going. `why` ends the refusal's sentence.
 */
export function unheard(line: string, why: string): string[] | null {
  const words = line.trim().split(/\s+/);
  if (words[0] === "stop" || words[0] === "ponderhit") return [];
  if (words[0] === "go" && unbounded(words)) {
    const what = words.includes("ponder") ? "go ponder" : words.includes("infinite") ? "go infinite" : "a go with no limit";
    return [`info string error: ${what} ${why}`, "bestmove 0000"];
  }
  return null;
}

/** why a deaf module's host refuses an unbounded go */
export const DEAF_REFUSAL = "needs an engine that reads its input during a search";

// === Input channels ===

/** the ring's header, in Int32 slots: bytes written, bytes read, 1 once input has ended, and a wake counter */
const WRITTEN = 0;
const READ = 1;
const CLOSED = 2;
const SIGNAL = 3;
const HEADER_BYTES = 16;
/** the ring's data size, a power of two; a UCI line is far shorter */
const RING_BYTES = 1 << 20;

/** where an engine's stdin comes from, as the thread that runs the engine reads it */
export interface Input {
  /** bytes waiting */
  available(): number;
  /** whether input has ended */
  closed(): boolean;
  /** waits until input arrives or ends, at most `ms` milliseconds (Infinity for no limit) */
  wait(ms: number): void;
  /** moves up to `max` waiting bytes into `out` at `at`; returns how many */
  read(out: Uint8Array, at: number, max: number): number;
}

/**
 * Input known in full before the engine starts: its bytes, then the end of input.
 * It needs no shared memory, so it serves a host that has none.
 */
export class Script implements Input {
  private readonly bytes: Uint8Array;
  private at = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  available(): number {
    return this.bytes.length - this.at;
  }

  closed(): boolean {
    return true;
  }

  /** nothing more arrives, so there is nothing to wait for; a module's sleep spins */
  wait(_ms: number): void {}

  read(out: Uint8Array, at: number, max: number): number {
    const n = Math.min(max, this.available());
    out.set(this.bytes.subarray(this.at, this.at + n), at);
    this.at += n;
    return n;
  }
}

/**
 * Input that arrives on the engine's own thread, between turns of its event loop.
 * A reader cannot block for it; it suspends the module until `arrival` resolves
 * (runSuspending).
 */
export class Queue implements Input {
  private chunks: Uint8Array[] = [];
  private size = 0;
  private ended = false;
  private waiters: (() => void)[] = [];

  /** appends bytes and resumes a reader that waits */
  push(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.size += bytes.length;
    for (const w of this.waiters.splice(0)) w();
  }

  /** marks the end of input */
  close(): void {
    this.ended = true;
    for (const w of this.waiters.splice(0)) w();
  }

  available(): number {
    return this.size;
  }

  closed(): boolean {
    return this.ended;
  }

  /** this thread delivers the input itself, so a blocking wait would never end; a reader awaits `arrival` */
  wait(_ms: number): void {}

  read(out: Uint8Array, at: number, max: number): number {
    let n = 0;
    while (n < max && this.chunks.length > 0) {
      const c = this.chunks[0]!;
      const take = Math.min(max - n, c.length);
      out.set(c.subarray(0, take), at + n);
      n += take;
      if (take === c.length) this.chunks.shift();
      else this.chunks[0] = c.subarray(take);
    }
    this.size -= n;
    return n;
  }

  /** resolves when bytes arrive or input ends */
  arrival(): Promise<void> {
    return this.waitFor(Infinity);
  }

  /** resolves when bytes arrive, input ends, or `ms` elapses, without leaking a waiter or timer */
  waitFor(ms: number): Promise<void> {
    if (this.size > 0 || this.ended) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        if (timer !== undefined) clearTimeout(timer);
        const i = this.waiters.indexOf(done);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve();
      };
      this.waiters.push(done);
      if (ms !== Infinity) timer = setTimeout(done, ms);
    });
  }
}

/** a single-writer, single-reader byte ring in a SharedArrayBuffer */
export class Ring implements Input {
  readonly buffer: SharedArrayBuffer;
  private readonly head: Int32Array;
  private readonly data: Uint8Array;

  constructor(buffer?: SharedArrayBuffer) {
    this.buffer = buffer ?? new SharedArrayBuffer(HEADER_BYTES + RING_BYTES);
    this.head = new Int32Array(this.buffer, 0, 4);
    this.data = new Uint8Array(this.buffer, HEADER_BYTES, RING_BYTES);
  }

  /** the writer: appends bytes and wakes the reader; throws if the reader has fallen a ring behind */
  push(bytes: Uint8Array): void {
    const w = Atomics.load(this.head, WRITTEN);
    if (((w - Atomics.load(this.head, READ)) | 0) + bytes.length > RING_BYTES) throw new Error("the engine's input ring is full");
    for (let i = 0; i < bytes.length; i++) this.data[(w + i) & (RING_BYTES - 1)] = bytes[i]!;
    Atomics.store(this.head, WRITTEN, (w + bytes.length) | 0);
    Atomics.add(this.head, SIGNAL, 1);
    Atomics.notify(this.head, SIGNAL);
  }

  /** the writer: marks the end of input */
  close(): void {
    Atomics.store(this.head, CLOSED, 1);
    Atomics.add(this.head, SIGNAL, 1);
    Atomics.notify(this.head, SIGNAL);
  }

  /** the reader: bytes waiting */
  available(): number {
    return (Atomics.load(this.head, WRITTEN) - Atomics.load(this.head, READ)) | 0;
  }

  /** the reader: whether input has ended */
  closed(): boolean {
    return Atomics.load(this.head, CLOSED) !== 0;
  }

  /** the reader: waits until input arrives or ends, at most `ms` milliseconds (Infinity for no limit) */
  wait(ms: number): void {
    const seq = Atomics.load(this.head, SIGNAL);
    if (this.available() > 0 || this.closed()) return;
    Atomics.wait(this.head, SIGNAL, seq, ms);
  }

  /** the reader: moves up to `max` waiting bytes into `out` at `at`; returns how many */
  read(out: Uint8Array, at: number, max: number): number {
    const r = Atomics.load(this.head, READ);
    const n = Math.min(max, this.available());
    for (let i = 0; i < n; i++) out[at + i] = this.data[(r + i) & (RING_BYTES - 1)]!;
    Atomics.store(this.head, READ, (r + n) | 0);
    return n;
  }
}

// === WASI preview-1 imports ===

/** thrown by proc_exit to unwind the engine's stack; `code` is the exit code */
export class Exit extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

const ESUCCESS = 0;
const EBADF = 8;
const EINVAL = 28;
const ENOSYS = 52;
const ESPIPE = 70;
const CHARACTER_DEVICE = 2;
const PREVIEW1 = "wasi_snapshot_preview1";
const EVENT_CLOCK = 0;
const EVENT_FD_READ = 1;
const HANGUP = 1;

/** JavaScript Promise Integration, where the runtime has it: an import that may suspend the module, and an export that returns a promise */
const jspi = WebAssembly as unknown as {
  Suspending?: new (f: (...a: number[]) => number | Promise<number>) => Function;
  promising?: (f: Function) => (...a: unknown[]) => Promise<unknown>;
};

/** whether this runtime can suspend a module, so runSuspending works */
export function canSuspend(): boolean {
  return typeof jspi.Suspending === "function" && typeof jspi.promising === "function";
}

/**
 * How often a suspended search's poll gives the event loop a turn, in milliseconds:
 * the longest a `stop` waits beyond the engine's own polling. A turn costs
 * microseconds, so at this rate its cost is lost in a speed read's noise
 * (measured in Chrome and Firefox).
 */
const TURN_MS = 5;

/**
 * The preview-1 answers for one instance: the seven calls a module may rely on, read from `input`, and a
 * fixed answer for the rest. `args` are the command line, the program's name first; `write` receives each
 * fd_write's bytes for fd 1 (stdout) or 2 (stderr). With `suspend`, a Queue, `fd_read` and `poll_oneoff`
 * are suspending imports that wait for that queue (runSuspending). `origin` is the monotonic clock's zero,
 * in milliseconds since the epoch, which every thread of one instance shares. Pass `importsFor` to the
 * instance, and bind its memory with `setMemory` before calling `_start`.
 */
export function wasiImports(input: Input, args: string[], write: (fd: number, bytes: Uint8Array) => void, suspend?: Queue, origin?: number) {
  let memory: WebAssembly.Memory | undefined;
  let view = new DataView(new ArrayBuffer(0));
  let bytes = new Uint8Array(0);
  /** the views over memory, renewed when it has grown */
  const mem = () => {
    if (view.buffer !== memory!.buffer) {
      view = new DataView(memory!.buffer);
      bytes = new Uint8Array(memory!.buffer);
    }
  };
  const encoded = args.map((a) => new TextEncoder().encode(a + "\0"));
  /** a u64 as two u32s, so no BigInt is made */
  const setU64 = (at: number, v: number) => {
    view.setUint32(at, v % 0x100000000, true);
    view.setUint32(at + 4, Math.floor(v / 0x100000000), true);
  };
  const getU64 = (at: number) => view.getUint32(at, true) + view.getUint32(at + 4, true) * 0x100000000;
  // each Worker's performance.now() has its own zero, so threads share `origin` instead
  const t0 = origin ?? performance.timeOrigin + performance.now();

  /** what one poll_oneoff asks for: the index of its read of stdin and of its soonest clock, -1 for none, and that clock's timeout */
  type Asked = { readSub: number; clockSub: number; timeoutMs: number };
  /** reads a poll's subscriptions; undefined for one this host does not answer */
  const subscriptions = (subs: number, n: number): Asked | undefined => {
    if (n === 0) return undefined;
    mem();
    const asked: Asked = { readSub: -1, clockSub: -1, timeoutMs: Infinity };
    for (let i = 0; i < n; i++) {
      const s = subs + 48 * i;
      const tag = view.getUint8(s + 8);
      if (tag === EVENT_FD_READ && view.getUint32(s + 16, true) === 0) asked.readSub = i;
      else if (tag === EVENT_CLOCK) {
        // WASI subclockflags at offset 40: bit 0 is ABSTIME; only relative timeouts are answered
        if (view.getUint16(s + 40, true) !== 0) return undefined;
        const ms = getU64(s + 24) / 1e6;
        if (ms < asked.timeoutMs) {
          asked.timeoutMs = ms;
          asked.clockSub = i;
        }
      } else return undefined;
    }
    return asked;
  };
  let sleepCell: Int32Array | undefined;
  /** sleeps for `ms` without waking on stdin readiness; spins only where SharedArrayBuffer is unavailable */
  const sleep = (ms: number) => {
    if (!sleepCell && typeof SharedArrayBuffer !== "undefined") sleepCell = new Int32Array(new SharedArrayBuffer(4));
    if (sleepCell) Atomics.wait(sleepCell, 0, 0, ms);
  };
  /** whether the poll's read of stdin has input, or its end, to report */
  const ready = (asked: Asked) => asked.readSub >= 0 && (input.available() > 0 || input.closed());
  /** writes a poll's one event, once its wait is over: stdin if it is ready, else the clock, else none */
  const answerPoll = (asked: Asked, subs: number, events: number, nevents: number): number => {
    mem();
    const hit = ready(asked) ? asked.readSub : asked.clockSub;
    if (hit < 0) {
      view.setUint32(nevents, 0, true);
      return ESUCCESS;
    }
    bytes.fill(0, events, events + 32);
    setU64(events, getU64(subs + 48 * hit));
    view.setUint8(events + 10, hit === asked.readSub ? EVENT_FD_READ : EVENT_CLOCK);
    if (hit === asked.readSub) {
      setU64(events + 16, input.available());
      view.setUint16(events + 24, input.closed() ? HANGUP : 0, true);
    }
    view.setUint32(nevents, 1, true);
    return ESUCCESS;
  };

  const imports = {
    args_sizes_get(argc: number, size: number): number {
      mem();
      view.setUint32(argc, encoded.length, true);
      view.setUint32(size, encoded.reduce((n, a) => n + a.length, 0), true);
      return ESUCCESS;
    },
    args_get(argv: number, buf: number): number {
      mem();
      let at = buf;
      encoded.forEach((a, i) => {
        view.setUint32(argv + 4 * i, at, true);
        bytes.set(a, at);
        at += a.length;
      });
      return ESUCCESS;
    },
    clock_time_get(id: number, _precision: bigint, out: number): number {
      mem();
      // realtime is 0; monotonic (1) and the CPU-time clocks (2, 3) answer the monotonic clock,
      // clamped at 0 so a skew between threads' origins never wraps the u64
      const ms = id === 0 ? Date.now() : Math.max(0, performance.timeOrigin + performance.now() - t0);
      setU64(out, Math.round(ms * 1e6));
      return ESUCCESS;
    },
    fd_read(fd: number, iovs: number, iovsLen: number, nread: number): number {
      if (fd !== 0) return EBADF;
      while (input.available() === 0 && !input.closed()) input.wait(Infinity);
      mem();
      let n = 0;
      for (let i = 0; i < iovsLen; i++) {
        const buf = view.getUint32(iovs + 8 * i, true);
        const len = view.getUint32(iovs + 8 * i + 4, true);
        const got = input.read(bytes, buf, len);
        n += got;
        if (got < len) break;
      }
      view.setUint32(nread, n, true);
      return ESUCCESS;
    },
    fd_write(fd: number, iovs: number, iovsLen: number, nwritten: number): number {
      if (fd !== 1 && fd !== 2) return EBADF;
      mem();
      let n = 0;
      for (let i = 0; i < iovsLen; i++) {
        const buf = view.getUint32(iovs + 8 * i, true);
        const len = view.getUint32(iovs + 8 * i + 4, true);
        write(fd, bytes.slice(buf, buf + len));
        n += len;
      }
      view.setUint32(nwritten, n, true);
      return ESUCCESS;
    },
    /** stdin's readiness and relative clock timeouts: the two subscriptions a UCI loop needs */
    poll_oneoff(subs: number, events: number, n: number, nevents: number): number {
      const asked = subscriptions(subs, n);
      if (!asked) return EINVAL;
      if (!ready(asked) && asked.timeoutMs > 0) {
        const end = performance.now() + asked.timeoutMs;
        for (let left = asked.timeoutMs; !ready(asked) && left > 0; left = end - performance.now()) {
          if (asked.readSub >= 0) input.wait(left);
          else sleep(left);
        }
      }
      return answerPoll(asked, subs, events, nevents);
    },
    proc_exit(code: number): never {
      throw new Exit(code);
    },
  };
  let closeSuspend: (() => void) | undefined;
  /**
   * The two calls that wait for input, as suspending imports: where the blocking
   * forms wait on the ring, these suspend the module and resume it when input
   * arrives on this thread. A search's zero-timeout poll gives the event loop one
   * turn at most every TURN_MS, through a MessageChannel: a timer's turn takes
   * milliseconds, and a suspending import that returns at once reaches only the
   * microtask queue, which delivers no message.
   */
  const suspending = (queue: Queue): Record<string, Function> => {
    const channel = new MessageChannel();
    let resume: (() => void) | undefined;
    channel.port1.onmessage = () => {
      const r = resume;
      resume = undefined;
      r?.();
    };
    closeSuspend = () => {
      channel.port1.onmessage = null;
      channel.port1.close();
      channel.port2.close();
    };
    /** one turn of the event loop: input that waits is delivered before this resolves */
    const turn = () => new Promise<void>((resolve) => {
      resume = resolve;
      channel.port2.postMessage(0);
    });
    let lastTurn = performance.now();
    return {
      fd_read: new jspi.Suspending!(async (fd: number, iovs: number, iovsLen: number, nread: number) => {
        if (fd === 0) {
          while (queue.available() === 0 && !queue.closed()) await queue.arrival();
          lastTurn = performance.now();
        }
        return imports.fd_read(fd, iovs, iovsLen, nread);
      }),
      poll_oneoff: new jspi.Suspending!(async (subs: number, events: number, n: number, nevents: number) => {
        const asked = subscriptions(subs, n);
        if (!asked) return EINVAL;
        if (!ready(asked)) {
          if (asked.timeoutMs === 0) {
            if (performance.now() - lastTurn >= TURN_MS) {
              await turn();
              lastTurn = performance.now();
            }
          } else if (asked.timeoutMs < 1) {
            // a timer rounds a short sleep up, so a sleep under a millisecond spins
            for (const end = performance.now() + asked.timeoutMs; performance.now() < end; );
          } else if (asked.readSub >= 0) {
            await queue.waitFor(asked.timeoutMs);
            lastTurn = performance.now();
          } else {
            await new Promise<void>((resolve) => setTimeout(resolve, asked.timeoutMs));
            lastTurn = performance.now();
          }
        }
        return answerPoll(asked, subs, events, nevents);
      }),
    };
  };

  /**
   * The fixed answers to the rest of preview 1. Stdin, stdout and stderr are pipes
   * with no file system behind them, the environment is empty, and random bytes
   * come from a fixed seed, so two runs of a module are the same run.
   */
  let seed = 0x9e3779b9;
  const floorStubs: Record<string, (...a: number[]) => number> = {
    fd_fdstat_get(fd: number, out: number): number {
      if (fd < 0 || fd > 2) return EBADF;
      mem();
      bytes.fill(0, out, out + 8);
      bytes[out] = CHARACTER_DEVICE;
      // every right, base and inheriting: with the seek right set, a libc does not take the fd for a terminal
      bytes.fill(0xff, out + 8, out + 24);
      return ESUCCESS;
    },
    fd_prestat_get: () => EBADF,
    fd_seek: () => ESPIPE,
    environ_sizes_get(count: number, size: number): number {
      mem();
      view.setUint32(count, 0, true);
      view.setUint32(size, 0, true);
      return ESUCCESS;
    },
    environ_get: () => ESUCCESS,
    // the runtime schedules the threads, so a yield has nothing to do, and Go's runtime throws on a failed one
    sched_yield: () => ESUCCESS,
    random_get(buf: number, len: number): number {
      mem();
      for (let i = 0; i < len; i++) {
        // xorshift32 (Marsaglia 2003)
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        bytes[buf + i] = seed;
      }
      return ESUCCESS;
    },
  };
  return {
    /**
     * The import object for `module`: the seven calls, a fixed answer for each other preview-1 import, a
     * wasi-threads module's memory and thread start from `threads`, and an error for any other import.
     */
    importsFor(module: WebAssembly.Module, threads?: Threads): WebAssembly.Imports {
      const answers: Record<string, Function> = {};
      const waiting = suspend ? suspending(suspend) : {};
      const result: WebAssembly.Imports = { [PREVIEW1]: answers };
      for (const i of WebAssembly.Module.imports(module)) {
        if (i.kind === "memory" && i.module === MEMORY_MODULE && i.name === MEMORY_NAME && threads) result.env = { memory: threads.memory };
        else if (i.module === "wasi" && i.name === "thread-spawn" && threads) result.wasi = { "thread-spawn": threads.spawn };
        else if (i.module !== PREVIEW1) throw new Error(`the module imports ${i.module}.${i.name}; a UCI over WASI host answers ${PREVIEW1}, and wasi.thread-spawn with a shared memory`);
        else answers[i.name] = waiting[i.name] ?? (imports as Record<string, Function>)[i.name] ?? floorStubs[i.name] ?? (() => ENOSYS);
      }
      return result;
    },
    setMemory(m: WebAssembly.Memory) {
      memory = m;
    },
    close() {
      closeSuspend?.();
      closeSuspend = undefined;
    },
  };
}

// === Module runners ===

/** an instance of `module` on `wasi`'s answers, with its memory bound: the shared one in `threads`, else its own */
function instantiate(module: WebAssembly.Module, wasi: ReturnType<typeof wasiImports>, threads?: Threads): WebAssembly.Instance {
  const instance = new WebAssembly.Instance(module, wasi.importsFor(module, threads));
  wasi.setMemory(threads?.memory ?? (instance.exports.memory as WebAssembly.Memory));
  return instance;
}

/** the exit code a proc_exit unwound with; rethrows any other error, such as a trap */
function exitCode(e: unknown): number {
  if (e instanceof Exit) return e.code;
  throw e;
}

/**
 * Runs one instance of a compiled WASI build to its end; returns the exit code.
 * The thread is the engine's for the whole run. A wasi-threads module needs
 * `threads`; with spawn NO_SPAWN, it plays on this thread alone.
 */
export function runModule(module: WebAssembly.Module, input: Input, args: string[], write: (fd: number, bytes: Uint8Array) => void, threads?: Threads): number {
  const instance = instantiate(module, wasiImports(input, args, write), threads);
  try {
    (instance.exports._start as () => void)();
    return 0;
  } catch (e) {
    return exitCode(e);
  }
}

/**
 * Runs one thread of a wasi-threads instance: the engine's `_start`, or with `thread` a spawned thread's
 * `wasi_thread_start(tid, arg)`. Every thread of the instance is given the same `threads` and `origin`, the
 * monotonic clock's zero. Returns the exit code when the module ends: `_start` returned, or `proc_exit` on
 * this thread. Returns undefined when a spawned thread returns, which ends that thread alone. A trap throws.
 */
export function runThread(module: WebAssembly.Module, input: Input, args: string[], write: (fd: number, bytes: Uint8Array) => void, threads: Threads, origin: number, thread?: { tid: number; arg: number }): number | undefined {
  const instance = instantiate(module, wasiImports(input, args, write, undefined, origin), threads);
  try {
    if (!thread) {
      (instance.exports._start as () => void)();
      return 0;
    }
    (instance.exports.wasi_thread_start as (tid: number, arg: number) => void)(thread.tid, thread.arg);
    return undefined;
  } catch (e) {
    return exitCode(e);
  }
}

/** a thread id for thread-spawn from the counter at slot 0 of `ids`, shared by every thread; 0 once they run out */
export function nextThreadId(ids: Int32Array): number {
  const tid = Atomics.add(ids, 0, 1) + 1;
  // wasi-threads' ids are positive and below 2^29
  return tid < 1 << 29 ? tid : 0;
}

/**
 * Runs one instance of a compiled WASI build to its end on a thread that also
 * delivers its input: push the input into `input` from that thread's event loop.
 * Resolves to the exit code. It needs canSuspend().
 */
export async function runSuspending(module: WebAssembly.Module, input: Queue, args: string[], write: (fd: number, bytes: Uint8Array) => void, threads?: Threads): Promise<number> {
  const wasi = wasiImports(input, args, write, input);
  const instance = instantiate(module, wasi, threads);
  try {
    await jspi.promising!(instance.exports._start as Function)();
    return 0;
  } catch (e) {
    return exitCode(e);
  } finally {
    wasi.close();
  }
}

/**
 * Compiles a WASI build and runs it to its end on this thread alone; returns the exit code. A wasi-threads
 * module is given its shared memory, and thread-spawn fails (NO_SPAWN).
 */
export async function runWasi(wasm: ArrayBuffer | Uint8Array<ArrayBuffer>, input: Input, args: string[], write: (fd: number, bytes: Uint8Array) => void): Promise<number> {
  const bytes = wasm instanceof Uint8Array ? wasm : new Uint8Array(wasm);
  return runModule(await WebAssembly.compile(bytes), input, args, write, unthreaded(bytes));
}
