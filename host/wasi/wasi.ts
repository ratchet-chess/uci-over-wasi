/**
 * The host side of UCI over WASI: the WASI preview-1 calls a WASI build imports,
 * answered on the thread that runs the engine, with stdin fed through a ring in
 * shared memory. One thread writes input into the ring: stdin's reader under Bun
 * and Node (main.ts), the page's messages in a browser. The engine's thread reads
 * it without returning to its event loop, so a `stop` reaches a running search.
 * Platform-neutral: no node: imports.
 *
 * A module may rely on seven calls (core/wasi.ts imports exactly these). A libc
 * or a Rust std imports more of preview 1 than it calls, so every other import
 * gets a fixed answer (floorStubs), and a module that needs more than those
 * answers does not run here.
 *
 * The layouts are WASI preview 1's (WebAssembly/WASI, legacy/preview1/docs.md).
 */

/** the ring's header, in Int32 slots: bytes written so far, bytes read so far, and 1 once input has ended */
const WRITTEN = 0;
const READ = 1;
const CLOSED = 2;
const HEADER_BYTES = 16;
/** the ring's data size, a power of two; a UCI line is far shorter */
const RING_BYTES = 1 << 20;

/** a single-writer, single-reader byte ring in a SharedArrayBuffer */
export class Ring {
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
    if (w - Atomics.load(this.head, READ) + bytes.length > RING_BYTES) throw new Error("the engine's input ring is full");
    for (let i = 0; i < bytes.length; i++) this.data[(w + i) & (RING_BYTES - 1)] = bytes[i];
    Atomics.store(this.head, WRITTEN, (w + bytes.length) | 0);
    Atomics.notify(this.head, WRITTEN);
  }

  /** the writer: marks the end of input */
  close(): void {
    Atomics.store(this.head, CLOSED, 1);
    Atomics.notify(this.head, WRITTEN);
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
    const w = Atomics.load(this.head, WRITTEN);
    if (w !== Atomics.load(this.head, READ) || this.closed()) return;
    Atomics.wait(this.head, WRITTEN, w, ms);
  }

  /** the reader: moves up to `max` waiting bytes into `out` at `at`; returns how many */
  read(out: Uint8Array, at: number, max: number): number {
    const r = Atomics.load(this.head, READ);
    const n = Math.min(max, this.available());
    for (let i = 0; i < n; i++) out[at + i] = this.data[(r + i) & (RING_BYTES - 1)];
    Atomics.store(this.head, READ, (r + n) | 0);
    return n;
  }
}

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

/**
 * The seven `wasi_snapshot_preview1` calls for one instance. `args` are the command
 * line, the program's name first; `write` receives each fd_write's bytes for fd 1
 * (stdout) or 2 (stderr). Bind the instance's memory with `setMemory` before
 * calling `_start`.
 */
export function wasiImports(ring: Ring, args: string[], write: (fd: number, bytes: Uint8Array) => void) {
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
  const t0 = performance.now();

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
      // realtime is 0, monotonic 1; the monotonic clock starts near 0 at load
      setU64(out, Math.round((id === 0 ? Date.now() : performance.now() - t0) * 1e6));
      return ESUCCESS;
    },
    fd_read(fd: number, iovs: number, iovsLen: number, nread: number): number {
      if (fd !== 0) return EBADF;
      while (ring.available() === 0 && !ring.closed()) ring.wait(Infinity);
      mem();
      let n = 0;
      for (let i = 0; i < iovsLen; i++) {
        const buf = view.getUint32(iovs + 8 * i, true);
        const len = view.getUint32(iovs + 8 * i + 4, true);
        const got = ring.read(bytes, buf, len);
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
      mem();
      let readSub = -1;
      let clockSub = -1;
      let timeoutMs = Infinity;
      for (let i = 0; i < n; i++) {
        const s = subs + 48 * i;
        const tag = view.getUint8(s + 8);
        if (tag === EVENT_FD_READ && view.getUint32(s + 16, true) === 0) readSub = i;
        else if (tag === EVENT_CLOCK) {
          const ms = getU64(s + 24) / 1e6;
          if (ms < timeoutMs) {
            timeoutMs = ms;
            clockSub = i;
          }
        } else return EINVAL;
      }
      const ready = () => readSub >= 0 && (ring.available() > 0 || ring.closed());
      if (!ready() && timeoutMs > 0) {
        const end = performance.now() + timeoutMs;
        for (let left = timeoutMs; !ready() && left > 0; left = end - performance.now()) ring.wait(left);
      }
      mem();
      const hit = ready() ? readSub : clockSub;
      if (hit < 0) {
        view.setUint32(nevents, 0, true);
        return ESUCCESS;
      }
      const e = events;
      bytes.fill(0, e, e + 32);
      setU64(e, getU64(subs + 48 * hit));
      view.setUint8(e + 10, hit === readSub ? EVENT_FD_READ : EVENT_CLOCK);
      if (hit === readSub) {
        setU64(e + 16, ring.available());
        view.setUint16(e + 24, ring.closed() ? HANGUP : 0, true);
      }
      view.setUint32(nevents, 1, true);
      return ESUCCESS;
    },
    proc_exit(code: number): never {
      throw new Exit(code);
    },
  };
  /**
   * The fixed answers to the rest of preview 1. Stdin, stdout and stderr are pipes
   * with no file system behind them, the environment is empty, and random bytes
   * come from a fixed seed, so two runs of a module are the same run.
   */
  let seed = 0x9e3779b9;
  const floorStubs: Record<string, (...a: number[]) => number> = {
    fd_fdstat_get(fd: number, out: number): number {
      if (fd > 2) return EBADF;
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
    /** the import object for `module`: the seven calls, a fixed answer for each other preview-1 import, and an error for an import from anywhere else */
    importsFor(module: WebAssembly.Module): WebAssembly.Imports {
      const answers: Record<string, Function> = {};
      for (const i of WebAssembly.Module.imports(module)) {
        if (i.module !== PREVIEW1) throw new Error(`the module imports ${i.module}.${i.name}; a UCI over WASI host answers only ${PREVIEW1}`);
        answers[i.name] = (imports as Record<string, Function>)[i.name] ?? floorStubs[i.name] ?? (() => ENOSYS);
      }
      return { [PREVIEW1]: answers };
    },
    setMemory(m: WebAssembly.Memory) {
      memory = m;
    },
  };
}

/**
 * Instantiates a WASI build and runs it to its end; returns the exit code. The
 * thread is the engine's for the whole run.
 */
export async function runWasi(wasm: BufferSource, ring: Ring, args: string[], write: (fd: number, bytes: Uint8Array) => void): Promise<number> {
  const wasi = wasiImports(ring, args, write);
  const module = await WebAssembly.compile(wasm);
  const instance = await WebAssembly.instantiate(module, wasi.importsFor(module));
  wasi.setMemory(instance.exports.memory as WebAssembly.Memory);
  try {
    (instance.exports._start as () => void)();
    return 0;
  } catch (e) {
    if (e instanceof Exit) return e.code;
    throw e;
  }
}
