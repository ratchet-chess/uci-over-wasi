// SPDX-License-Identifier: MIT
// Copyright (c) 2026 the uci-over-wasi contributors. The license's text is in LICENSE.
/**
 * One thread of a WASI build under Bun and Node: the engine's (wasi.ts runModule),
 * or one that a wasi-threads build spawned (wasi.ts runThread). It writes its
 * output straight to the process's stdout and stderr. It posts main.ts each spawn
 * to start, and the module's end, which ends the process.
 */
import { writeSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { NO_SPAWN, Ring, nextThreadId, runModule, runThread } from "./wasi.ts";

/** what main.ts gives a thread */
export type ThreadData = {
  wasm: Uint8Array;
  ring: SharedArrayBuffer;
  args: string[];
  /** false for a host that starts no thread: thread-spawn fails (wasi.ts NO_SPAWN) */
  spawns: boolean;
  /** a wasi-threads module's shared memory, the same for every thread; undefined for a module without one */
  memory?: WebAssembly.Memory;
  /** slot 0: the last thread id given (wasi.ts nextThreadId) */
  ids: SharedArrayBuffer;
  /** the monotonic clock's zero, the same for every thread */
  origin: number;
  /** a spawned thread's id and start argument */
  tid?: number;
  arg?: number;
};
/** what a thread posts main.ts: a thread to start, or the module's end with its exit code */
export type Note = { spawn: number; arg: number } | { exit: number };

const data = workerData as ThreadData;
const note = (n: Note) => parentPort!.postMessage(n);
const write = (fd: number, bytes: Uint8Array) => {
  for (let at = 0; at < bytes.length; ) at += writeSync(fd, bytes, at, bytes.length - at);
};

/** runs this thread's part of the module; returns its exit code, if it ends the module */
function run(module: WebAssembly.Module): number | undefined {
  if (!data.memory) return runModule(module, new Ring(data.ring), data.args, write);
  const ids = new Int32Array(data.ids);
  // main.ts starts the thread; the id is the module's at once, as wasi-threads asks
  const spawn = (arg: number): number => {
    const tid = nextThreadId(ids);
    if (!tid) return NO_SPAWN(arg);
    note({ spawn: tid, arg });
    return tid;
  };
  const thread = data.tid === undefined ? undefined : { tid: data.tid, arg: data.arg! };
  return runThread(module, new Ring(data.ring), data.args, write, { memory: data.memory, spawn: data.spawns ? spawn : NO_SPAWN }, data.origin, thread);
}

let code: number | undefined = 1;
try {
  code = run(await WebAssembly.compile(data.wasm as Uint8Array<ArrayBuffer>));
} catch (e) {
  process.stderr.write(`${data.tid === undefined ? "engine" : `thread ${data.tid}`} error: ${(e as Error).stack ?? e}\n`);
}
// a spawned thread that returns ends itself alone; any other end ends the module, and every thread
if (code !== undefined) note({ exit: code });
