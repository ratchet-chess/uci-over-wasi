// SPDX-License-Identifier: MIT
// Copyright (c) 2026 the uci-over-wasi contributors. The license's text is in LICENSE.
/**
 * Dedicated Worker that runs one UCI over WASI check session for host/wasi/check-browser.ts.
 *
 * Unlike browser.ts (which keeps stockfish.js's pure string-line interface), this worker accepts
 * structured control messages:
 *   - { start: { wasm, args, spawns } }  compiles and runs the given WASI module bytes
 *   - { send: string }                   sends one UCI line (newline appended)
 *   - { eof: true }                      closes stdin (ring.close() or queue.close())
 *
 * And posts back:
 *   - { line: string }                   one stdout line
 *   - { stderr: string }                 diagnostic chunk from fd 2
 *   - { exit: number }                   the module's exit code
 *   - { error: string }                  a load, validation, or runtime failure
 */
import {
  DEAF_REFUSAL,
  NO_SPAWN,
  Queue,
  Ring,
  canSuspend,
  declarationOf,
  nextThreadId,
  refusal,
  runModule,
  runSuspending,
  runThread,
  sharedMemory,
  unheard,
  unthreaded,
} from "./wasi.ts";

const ENGINE_THREAD = "uci-over-wasi-check-engine";
const SPAWNED_THREAD = "uci-over-wasi-check-thread";

export type CheckWorkerIn =
  | { start: { wasm: Uint8Array; args: string[]; spawns: boolean } }
  | { send: string }
  | { eof: true };

export type CheckWorkerOut =
  | { line: string }
  | { stderr: string }
  | { exit: number }
  | { error: string };

type NestedStart = {
  module: WebAssembly.Module;
  memory?: WebAssembly.Memory;
  spawns: boolean;
  ring: SharedArrayBuffer;
  args: string[];
  ids: SharedArrayBuffer;
  origin: number;
  tid?: number;
  arg?: number;
};

type NestedNote = CheckWorkerOut | { spawn: number; arg: number };

const scope = globalThis as unknown as {
  name: string;
  location: Location;
  crossOriginIsolated: boolean;
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  close(): void;
};

function makeWriter(post: (msg: CheckWorkerOut) => void): (fd: number, bytes: Uint8Array) => void {
  const decoder = new TextDecoder();
  let partial = "";
  return (fd, bytes) => {
    const text = decoder.decode(bytes, { stream: true });
    if (fd === 2) {
      post({ stderr: text });
      return;
    }
    partial += text;
    for (let nl = partial.indexOf("\n"); nl >= 0; nl = partial.indexOf("\n")) {
      post({ line: partial.slice(0, nl) });
      partial = partial.slice(nl + 1);
    }
  };
}

if (scope.name === ENGINE_THREAD || scope.name === SPAWNED_THREAD) {
  scope.onmessage = (e: MessageEvent<NestedStart>) => {
    const d = e.data;
    const post = (n: NestedNote) => scope.postMessage(n);
    const write = makeWriter((m) => post(m));
    let code: number | undefined = 1;
    try {
      if (!d.memory) code = runModule(d.module, new Ring(d.ring), d.args, write);
      else if (!d.spawns) code = runModule(d.module, new Ring(d.ring), d.args, write, { memory: d.memory, spawn: NO_SPAWN });
      else {
        const ids = new Int32Array(d.ids);
        const spawn = (arg: number): number => {
          const tid = nextThreadId(ids);
          if (!tid) return NO_SPAWN(arg);
          post({ spawn: tid, arg });
          return tid;
        };
        const thread = d.tid === undefined ? undefined : { tid: d.tid, arg: d.arg! };
        code = runThread(d.module, new Ring(d.ring), d.args, write, { memory: d.memory, spawn }, d.origin, thread);
      }
    } catch (err) {
      post({ error: err instanceof Error ? err.message : String(err) });
      code = 1;
    }
    if (code !== undefined) post({ exit: code });
    else scope.close();
  };
} else {
  const encoder = new TextEncoder();
  const post = (m: CheckWorkerOut) => scope.postMessage(m);
  let deaf = false;
  let push: ((bytes: Uint8Array) => void) | null = null;
  let closeInput: (() => void) | null = null;
  const queued: (string | null)[] = [];

  const deliver = (item: string | null) => {
    if (item === null) {
      closeInput?.();
      return;
    }
    const answer = deaf ? unheard(item, DEAF_REFUSAL) : null;
    if (answer === null) push?.(encoder.encode(item + "\n"));
    else for (const a of answer) post({ line: a });
  };

  const startSession = async (wasm: Uint8Array, args: string[], spawns: boolean): Promise<void> => {
    const isolated = Boolean(scope.crossOriginIsolated);
    const canSpawn = isolated && spawns;
    const decl = declarationOf(wasm);
    const why = refusal(decl, canSpawn);
    if (why) throw new Error(why);
    // ArrayBuffer copy ensures WebAssembly.validate/compile accept a non-shared buffer
    const buf = wasm.slice().buffer;
    if (!WebAssembly.validate(buf)) throw new Error("not a valid WebAssembly module");
    const module = await WebAssembly.compile(buf);
    deaf = decl.profile === "deaf";

    if (isolated) {
      const ring = new Ring();
      push = (b) => ring.push(b);
      closeInput = () => ring.close();
      const workers: Worker[] = [];
      const finish = (code: number) => {
        for (const w of workers) w.terminate();
        post({ exit: code });
        scope.close();
      };
      const base: NestedStart = {
        module,
        memory: sharedMemory(wasm),
        spawns: canSpawn,
        ring: ring.buffer,
        args,
        ids: new SharedArrayBuffer(4),
        origin: performance.timeOrigin + performance.now(),
      };
      const launch = (name: string, data: NestedStart) => {
        const w = new Worker(scope.location.href, { type: "module", name });
        workers.push(w);
        w.onmessage = (ev: MessageEvent<NestedNote>) => {
          const n = ev.data;
          if ("spawn" in n) launch(SPAWNED_THREAD, { ...base, tid: n.spawn, arg: n.arg });
          else if ("exit" in n) finish(n.exit);
          else post(n);
        };
        w.onerror = (ev) => {
          post({ error: ev.message || "worker error" });
          finish(1);
        };
        w.postMessage(data);
      };
      for (const item of queued.splice(0)) deliver(item);
      launch(ENGINE_THREAD, base);
      return;
    }

    if (!canSuspend()) {
      throw new Error("live checks require cross-origin isolation or JavaScript Promise Integration");
    }
    const queue = new Queue();
    push = (b) => queue.push(b);
    closeInput = () => queue.close();
    for (const item of queued.splice(0)) deliver(item);
    const code = await runSuspending(module, queue, args, makeWriter(post), unthreaded(wasm));
    post({ exit: code });
    scope.close();
  };

  scope.onmessage = (e: MessageEvent<CheckWorkerIn>) => {
    const msg = e.data;
    if ("start" in msg) {
      void startSession(msg.start.wasm, msg.start.args, msg.start.spawns).catch((err) => {
        post({ error: err instanceof Error ? err.message : String(err) });
        post({ exit: 1 });
        scope.close();
      });
    } else if ("send" in msg) {
      if (push) deliver(msg.send);
      else queued.push(msg.send);
    } else if ("eof" in msg) {
      if (closeInput) deliver(null);
      else queued.push(null);
    }
  };
}
