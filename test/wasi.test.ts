// SPDX-License-Identifier: MIT
// Copyright (c) 2026 the uci-over-wasi contributors. The license's text is in LICENSE.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Worker } from "node:worker_threads";
import {
  DEAF_REFUSAL,
  Queue,
  Ring,
  Script,
  canSuspend,
  declarationOf,
  refusal,
  runModule,
  runSuspending,
  sharedMemory,
  unbounded,
  unheard,
  wasiImports,
} from "../host/wasi/wasi.ts";
import { featuresOf } from "../host/wasi/features.ts";

const HEADER = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

function uleb(n: number): number[] {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n !== 0) b |= 0x80;
    out.push(b);
  } while (n !== 0);
  return out;
}

function strBytes(s: string): number[] {
  const b = [...new TextEncoder().encode(s)];
  return [...uleb(b.length), ...b];
}

function section(id: number, body: number[]): number[] {
  return [id, ...uleb(body.length), ...body];
}

function customSection(name: string, payload: string): number[] {
  return section(0, [...strBytes(name), ...new TextEncoder().encode(payload)]);
}

function memoryImportModule(mod: string, field: string, flags: number, initial: number, maximum?: number): Uint8Array {
  const limits = [flags, ...uleb(initial), ...(maximum !== undefined ? uleb(maximum) : [])];
  const imp = [...strBytes(mod), ...strBytes(field), 0x02, ...limits];
  return new Uint8Array([...HEADER, ...section(2, [1, ...imp])]);
}

describe("declarationOf and refusal", () => {
  it("defaults to polls with no requirements", () => {
    assert.deepEqual(declarationOf(new Uint8Array(HEADER)), { profile: "polls", requires: [] });
  });

  it("parses profile, requires, ignores unknown keys, and deduplicates features", () => {
    const wasm = new Uint8Array([
      ...HEADER,
      ...customSection("other", "profile=bogus\n"),
      ...customSection("uci_over_wasi", "future_key=1\nprofile=deaf\nrequires=threads relaxed-simd threads\n"),
    ]);
    assert.deepEqual(declarationOf(wasm), { profile: "deaf", requires: ["threads", "relaxed-simd"] });
  });

  it("rejects unknown profile and unknown required feature", () => {
    const badProfile = new Uint8Array([...HEADER, ...customSection("uci_over_wasi", "profile=async\n")]);
    assert.throws(() => declarationOf(badProfile), /profile=async/);

    const badFeature = new Uint8Array([...HEADER, ...customSection("uci_over_wasi", "requires=memory64\n")]);
    assert.throws(() => declarationOf(badFeature), /requires memory64/);
  });

  it("rejects non-Wasm and truncated bytes without hanging", () => {
    const html = new TextEncoder().encode("<!DOCTYPE html><html><body>404</body></html>");
    assert.throws(() => declarationOf(html), /not a WebAssembly module/);
    assert.throws(() => declarationOf(new Uint8Array([0, 97, 115])), /not a WebAssembly module/);
    // truncated section size LEB with high bit set at EOF
    assert.throws(() => declarationOf(new Uint8Array([...HEADER, 0x00, 0x80])), /unexpected end/);
    // section claims more bytes than present
    assert.throws(() => declarationOf(new Uint8Array([...HEADER, 0x00, 0x20, 0x01])), /truncated section/);
    // overlong LEB128
    assert.throws(
      () => declarationOf(new Uint8Array([...HEADER, 0x00, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0x01])),
      /invalid LEB128/,
    );
  });

  it("refuses threads when canSpawn is false", () => {
    const decl = { profile: "polls" as const, requires: ["threads" as const] };
    assert.match(refusal(decl, false) ?? "", /threads/);
    assert.equal(refusal(decl, true), undefined);
  });
});

describe("sharedMemory", () => {
  it("returns undefined when a module imports no memory", () => {
    assert.equal(sharedMemory(new Uint8Array(HEADER)), undefined);
  });

  it("allocates shared memory with matching limits for env.memory", () => {
    const wasm = memoryImportModule("env", "memory", 3, 1, 4);
    const mem = sharedMemory(wasm);
    assert.ok(mem instanceof WebAssembly.Memory);
    assert.ok((mem.buffer as unknown) instanceof SharedArrayBuffer);
    assert.equal(mem.buffer.byteLength, 65536);
  });

  it("rejects non-shared memory, missing max, wrong name, and malformed bytes", () => {
    assert.throws(() => sharedMemory(memoryImportModule("env", "memory", 1, 1, 4)), /shared memory/);
    assert.throws(() => sharedMemory(memoryImportModule("env", "memory", 2, 1)), /shared memory/);
    assert.throws(() => sharedMemory(memoryImportModule("other", "memory", 3, 1, 4)), /other\.memory/);
    assert.throws(() => sharedMemory(new TextEncoder().encode("<html>")), /not a WebAssembly module/);
    assert.throws(() => sharedMemory(new Uint8Array([...HEADER, 2, 5, 1, 3, 101, 110])), /truncated/);
  });
});

describe("unbounded and unheard", () => {
  it("identifies unbounded vs bounded go commands", () => {
    assert.equal(unbounded(["go"]), true);
    assert.equal(unbounded(["go", "infinite"]), true);
    assert.equal(unbounded(["go", "ponder", "wtime", "1000"]), true);
    assert.equal(unbounded(["go", "depth", "5"]), false);
    assert.equal(unbounded(["go", "movetime", "100"]), false);
    assert.equal(unbounded(["go", "perft", "3"]), false);
  });

  it("drops stop/ponderhit and refuses unbounded go, including CRLF", () => {
    assert.deepEqual(unheard("stop\r", DEAF_REFUSAL), []);
    assert.deepEqual(unheard("  ponderhit\r", DEAF_REFUSAL), []);
    const res = unheard("go infinite\r", DEAF_REFUSAL);
    assert.ok(res && res.length === 2);
    assert.match(res[0]!, /^info string error: go infinite /);
    assert.equal(res[1], "bestmove 0000");
    assert.equal(unheard("go depth 4\r", DEAF_REFUSAL), null);
  });
});

describe("Script, Queue, and Ring", () => {
  it("reads from Script across multiple calls", () => {
    const s = new Script(new TextEncoder().encode("abcdef"));
    assert.equal(s.available(), 6);
    assert.equal(s.closed(), true);
    const out = new Uint8Array(4);
    assert.equal(s.read(out, 0, 4), 4);
    assert.equal(new TextDecoder().decode(out), "abcd");
    assert.equal(s.read(out, 0, 4), 2);
    assert.equal(new TextDecoder().decode(out.subarray(0, 2)), "ef");
  });

  it("Queue.waitFor resolves on arrival or timeout without leaking waiters", async () => {
    const q = new Queue();
    await q.waitFor(10);
    // Repeated timeouts must not accumulate dead waiters.
    for (let i = 0; i < 5; i++) await q.waitFor(2);
    const pending = q.waitFor(5000);
    q.push(new TextEncoder().encode("uci\n"));
    await pending;
    assert.equal(q.available(), 4);
    q.close();
    await q.arrival();
  });

  it("Ring wraps around, enforces capacity, and wakes a waiter on close", async () => {
    const ring = new Ring();
    const buf = new Uint8Array(1024);
    // Push and read past the 1 MiB wrap boundary.
    const chunk = new Uint8Array(65536).fill(0x41);
    for (let i = 0; i < 20; i++) {
      ring.push(chunk);
      let left = chunk.length;
      while (left > 0) left -= ring.read(buf, 0, Math.min(buf.length, left));
    }
    assert.equal(ring.available(), 0);
    assert.throws(() => ring.push(new Uint8Array((1 << 20) + 1)), /ring is full/);

    // Verify close() wakes a worker blocked in wait(Infinity).
    const workerUrl = new URL(
      `data:text/javascript,${encodeURIComponent(`
        import { workerData, parentPort } from "node:worker_threads";
        const head = new Int32Array(workerData, 0, 4);
        parentPort.postMessage("ready");
        while (Atomics.load(head, 2) === 0 && Atomics.load(head, 0) === Atomics.load(head, 1)) {
          const seq = Atomics.load(head, 3);
          if (Atomics.load(head, 2) !== 0) break;
          Atomics.wait(head, 3, seq, 5000);
        }
        parentPort.postMessage(Atomics.load(head, 2));
      `)}`,
    );
    const w = new Worker(workerUrl, { workerData: ring.buffer });
    const result = await new Promise<number>((resolve, reject) => {
      w.on("message", (m) => {
        if (m === "ready") setTimeout(() => ring.close(), 15);
        else resolve(m as number);
      });
      w.on("error", reject);
    });
    await w.terminate();
    assert.equal(result, 1);
    assert.equal(ring.closed(), true);
  });
});

describe("wasiImports", () => {
  it("clamps monotonic clock_time_get at 0 and rejects invalid poll_oneoff subscriptions", () => {
    const mem = new WebAssembly.Memory({ initial: 1 });
    const view = new DataView(mem.buffer);
    const futureOrigin = performance.timeOrigin + performance.now() + 60_000;
    const wasi = wasiImports(new Script(new Uint8Array(0)), ["test"], () => {}, undefined, futureOrigin);
    wasi.setMemory(mem);
    // Build a minimal module importing clock_time_get and poll_oneoff.
    const types = section(1, [
      2,
      // type 0: (i32, i64, i32) -> i32
      0x60, 3, 0x7f, 0x7e, 0x7f, 1, 0x7f,
      // type 1: (i32, i32, i32, i32) -> i32
      0x60, 4, 0x7f, 0x7f, 0x7f, 0x7f, 1, 0x7f,
    ]);
    const imports = section(2, [
      2,
      ...strBytes("wasi_snapshot_preview1"), ...strBytes("clock_time_get"), 0x00, 0,
      ...strBytes("wasi_snapshot_preview1"), ...strBytes("poll_oneoff"), 0x00, 1,
    ]);
    const exports = section(7, [
      2,
      ...strBytes("clock_time_get"), 0x00, 0,
      ...strBytes("poll_oneoff"), 0x00, 1,
    ]);
    const mod = new WebAssembly.Module(new Uint8Array([...HEADER, ...types, ...imports, ...exports]));
    const inst = new WebAssembly.Instance(mod, wasi.importsFor(mod));
    const clock = inst.exports.clock_time_get as (id: number, prec: bigint, out: number) => number;
    const poll = inst.exports.poll_oneoff as (subs: number, events: number, n: number, nevents: number) => number;

    assert.equal(clock(1, 0n, 0), 0);
    assert.equal(view.getUint32(0, true), 0);
    assert.equal(view.getUint32(4, true), 0);

    // n === 0 must return EINVAL (28).
    assert.equal(poll(0, 64, 0, 128), 28);

    // ABSTIME flag (bit 0 at offset 40) must return EINVAL (28).
    new Uint8Array(mem.buffer, 0, 48).fill(0);
    view.setUint8(8, 0); // EVENT_CLOCK
    view.setUint16(40, 1, true); // ABSTIME
    assert.equal(poll(0, 64, 1, 128), 28);

    // Relative clock-only sleep (20ms) succeeds even when stdin is closed.
    new Uint8Array(mem.buffer, 0, 48).fill(0);
    view.setUint32(0, 42, true); // userdata
    view.setUint8(8, 0); // EVENT_CLOCK
    view.setUint32(24, 20_000_000, true); // 20ms in ns
    const t0 = performance.now();
    assert.equal(poll(0, 64, 1, 128), 0);
    assert.ok(performance.now() - t0 >= 15);
    assert.equal(view.getUint32(128, true), 1);
    assert.equal(view.getUint32(64, true), 42);
  });

  it("runModule and runSuspending run a WASI module reading stdin and writing stdout", async () => {
    // Module: imports fd_read, fd_write; exports memory and _start.
    // _start reads up to 64 bytes into addr 64, then writes them to fd 1.
    const types = section(1, [
      2,
      0x60, 4, 0x7f, 0x7f, 0x7f, 0x7f, 1, 0x7f, // type 0: fd_read / fd_write
      0x60, 0, 0, // type 1: _start
    ]);
    const imports = section(2, [
      2,
      ...strBytes("wasi_snapshot_preview1"), ...strBytes("fd_read"), 0x00, 0,
      ...strBytes("wasi_snapshot_preview1"), ...strBytes("fd_write"), 0x00, 0,
    ]);
    const funcs = section(3, [1, 1]);
    const mems = section(5, [1, 0, 1]);
    const exports = section(7, [
      2,
      ...strBytes("memory"), 0x02, 0,
      ...strBytes("_start"), 0x00, 2,
    ]);
    // iov at 0: { buf: 48, len: 48 }, nread at 16, write iov at 24: { buf: 48, len: *16 }, nwritten at 32
    const body = [
      0, // 0 local groups
      // iov[0] = 48, iov[4] = 48
      0x41, 0, 0x41, 48, 0x36, 2, 0,
      0x41, 4, 0x41, 48, 0x36, 2, 0,
      // fd_read(0, 0, 1, 16)
      0x41, 0, 0x41, 0, 0x41, 1, 0x41, 16, 0x10, 0, 0x1a,
      // write_iov[0] = 48, write_iov[4] = mem[16]
      0x41, 24, 0x41, 48, 0x36, 2, 0,
      0x41, 28, 0x41, 16, 0x28, 2, 0, 0x36, 2, 0,
      // fd_write(1, 24, 1, 32)
      0x41, 1, 0x41, 24, 0x41, 1, 0x41, 32, 0x10, 1, 0x1a,
      0x0b,
    ];
    const code = section(10, [1, ...uleb(body.length), ...body]);
    const mod = new WebAssembly.Module(new Uint8Array([...HEADER, ...types, ...imports, ...funcs, ...mems, ...exports, ...code]));

    let out = "";
    const exitCode = runModule(mod, new Script(new TextEncoder().encode("hello\n")), ["echo"], (_fd, b) => {
      out += new TextDecoder().decode(b);
    });
    assert.equal(exitCode, 0);
    assert.equal(out, "hello\n");

    if (canSuspend()) {
      const q = new Queue();
      let suspOut = "";
      setTimeout(() => {
        q.push(new TextEncoder().encode("jspi\n"));
        q.close();
      }, 10);
      const suspCode = await runSuspending(mod, q, ["echo"], (_fd, b) => {
        suspOut += new TextDecoder().decode(b);
      });
      assert.equal(suspCode, 0);
      assert.equal(suspOut, "jspi\n");
    }
  });
});

describe("featuresOf", () => {
  it("detects relaxed SIMD and exception handling and rejects truncated binaries", () => {
    assert.deepEqual(featuresOf(new Uint8Array(HEADER)), {
      threadSpawn: false,
      sharedMemory: false,
      atomics: false,
      exceptionHandling: false,
      relaxed: new Map(),
    });
    const relaxedProbe = new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 15, 1, 13, 0, 65, 1, 253, 15, 65, 2, 253, 15, 253, 128, 2, 11,
    ]);
    assert.equal(featuresOf(relaxedProbe).relaxed.get("i8x16.relaxed_swizzle"), 1);

    const ehProbe = new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 8, 1, 6, 0, 31, 64, 0, 11, 11,
    ]);
    assert.equal(featuresOf(ehProbe).exceptionHandling, true);

    assert.throws(() => featuresOf(new Uint8Array([...HEADER, 10, 20, 1, 2])), /truncated section/);
    assert.throws(() => featuresOf(new Uint8Array([...HEADER, 10, 3, 1, 10, 0])), /truncated function body/);
  });
});
