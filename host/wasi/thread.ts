// SPDX-License-Identifier: MIT
// Copyright (c) 2026 the uci-over-wasi contributors. The license's text is in LICENSE.
/**
 * The engine's thread under Bun and Node: runs a WASI build (wasi.ts runWasi),
 * writes its output straight to the process's stdout and stderr, and posts its
 * exit code to main.ts, which ends the process.
 */
import { writeSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { Ring, runWasi } from "./wasi.ts";

const { wasm, ring, args } = workerData as { wasm: Uint8Array<ArrayBuffer>; ring: SharedArrayBuffer; args: string[] };
const write = (fd: number, bytes: Uint8Array) => {
  for (let at = 0; at < bytes.length; ) at += writeSync(fd, bytes, at, bytes.length - at);
};
parentPort!.postMessage(await runWasi(wasm, new Ring(ring), args, write));
