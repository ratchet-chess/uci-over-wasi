/**
 * Runs a WASI build as a UCI engine under Bun or Node: stdin feeds the engine's
 * input ring, and the engine runs on its own thread (thread.ts), so a `stop`
 * reaches a running search.
 *
 *   bun host/wasi/main.ts <build.wasm> [args...]   (or node)
 *   bun host/wasi/main.ts build/wasi/ratchet.wasm bench
 *
 * The arguments after the build go to the engine as its command line.
 */
import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { Ring } from "./wasi.ts";

const [file, ...rest] = process.argv.slice(2);
if (!file) throw new Error("usage: main.ts <build.wasm> [args...]");
const ring = new Ring();
const worker = new Worker(new URL("./thread.ts", import.meta.url), {
  workerData: { wasm: readFileSync(file), ring: ring.buffer, args: [file, ...rest] },
});
worker.on("message", (code: number) => process.exit(code));
worker.on("error", (e: Error) => {
  process.stderr.write(`engine error: ${e.stack ?? e}\n`);
  process.exit(1);
});
process.stdin.on("data", (chunk: Buffer) => ring.push(chunk));
process.stdin.on("end", () => ring.close());
