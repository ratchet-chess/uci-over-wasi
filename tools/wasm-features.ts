// SPDX-License-Identifier: MIT
// Copyright (c) 2026 the uci-over-wasi contributors. The license's text is in LICENSE.
/**
 * Prints the WebAssembly features beyond the floor that a module uses (host/wasi/features.ts).
 *
 *   bun tools/wasm-features.ts <module.wasm>
 */
import { readFileSync } from "node:fs";
import { featuresOf } from "../host/wasi/features.ts";

export { featuresOf, type Features } from "../host/wasi/features.ts";

if (import.meta.main) {
  const file = process.argv[2];
  if (!file) throw new Error("usage: wasm-features.ts <module.wasm>");
  const f = featuresOf(readFileSync(file));
  console.log(`threads: ${f.threadSpawn ? "imports wasi.thread-spawn" : "no thread-spawn"}${f.sharedMemory ? ", shared memory" : ""}${f.atomics ? ", atomics" : ""}`);
  console.log(`exception-handling: ${f.exceptionHandling ? "used" : "not used"}`);
  console.log(`relaxed-simd: ${f.relaxed.size ? [...f.relaxed].map(([op, n]) => `${op} ×${n}`).join(", ") : "not used"}`);
}
