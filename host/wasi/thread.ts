// SPDX-License-Identifier: MIT
// Copyright (c) 2026 the uci-over-wasi contributors. The license's text is in LICENSE.
/**
 * The engine's thread under Bun and Node: runs a WASI build (wasi.ts runModule),
 * writes its output straight to the process's stdout and stderr, and posts its
 * exit code to main.ts, which ends the process.
 *
 * A wasi-threads module gets a shared memory made to its import's limits. Each
 * thread-spawn starts this script again as a Worker, role "thread", which
 * instantiates the same module over the same memory and calls its
 * wasi_thread_start. A thread that exits or traps ends the process through `ctl`.
 */
import { writeSync } from "node:fs";
import { Worker, parentPort, workerData } from "node:worker_threads";
import { Exit, NO_SPAWN, Ring, runModule, sharedMemory, wasiImports } from "./wasi.ts";

type Data = {
  wasm: Uint8Array<ArrayBuffer>;
  ring: SharedArrayBuffer;
  args: string[];
  /** this script's URL, which each spawned thread runs: a Bun executable embeds it at its own path */
  thread: string;
  /** false for a host that starts no thread: thread-spawn fails (wasi.ts NO_SPAWN) */
  spawns: boolean;
  /** slot 0: the last thread id given; slot 1: the process's exit code plus 1, once a spawned thread ends it */
  ctl: SharedArrayBuffer;
  /** a spawned thread's: its role, the engine thread's clock origin and memory, its id and its start argument */
  role?: "thread";
  origin?: number;
  memory?: WebAssembly.Memory;
  tid?: number;
  arg?: number;
};
const data = workerData as Data;
const write = (fd: number, bytes: Uint8Array) => {
  for (let at = 0; at < bytes.length; ) at += writeSync(fd, bytes, at, bytes.length - at);
};
const ctl = new Int32Array(data.ctl);
/** ends the process from any thread: main.ts watches slot 1 */
const endProcess = (code: number) => {
  Atomics.store(ctl, 1, code + 1);
  Atomics.notify(ctl, 1);
};

/** runs this thread's part of the module: the whole engine, or, as role "thread", one spawned thread */
async function run(): Promise<void> {
  const module = await WebAssembly.compile(data.wasm);
  const memory = data.memory ?? sharedMemory(data.wasm);
  if (!memory) {
    parentPort!.postMessage(runModule(module, new Ring(data.ring), data.args, write));
    return;
  }
  const origin = data.origin ?? performance.timeOrigin + performance.now();
  const spawn = (arg: number): number => {
    // wasi-threads' ids are positive and below 2^29
    const tid = Atomics.add(ctl, 0, 1) + 1;
    if (tid >= 1 << 29) return NO_SPAWN(arg);
    new Worker(new URL(data.thread), {
      workerData: { ...data, role: "thread", origin, memory, tid, arg } satisfies Data,
    });
    return tid;
  };
  const wasi = wasiImports(new Ring(data.ring), data.args, write, undefined, origin);
  const instance = new WebAssembly.Instance(module, wasi.importsFor(module, { memory, spawn: data.spawns ? spawn : NO_SPAWN }));
  wasi.setMemory(memory);
  if (data.role === "thread") (instance.exports.wasi_thread_start as (tid: number, arg: number) => void)(data.tid!, data.arg!);
  else {
    (instance.exports._start as () => void)();
    parentPort!.postMessage(0);
  }
}

try {
  await run();
} catch (e) {
  if (data.role === "thread") {
    // a spawned thread ends the process itself: the thread that spawned it is inside the module, and its
    // event loop, where a Worker's error event would arrive, does not turn while the module runs
    if (!(e instanceof Exit)) process.stderr.write(`thread ${data.tid} error: ${(e as Error).stack ?? e}\n`);
    endProcess(e instanceof Exit ? e.code : 1);
  } else if (e instanceof Exit) parentPort!.postMessage(e.code);
  else throw e;
}
