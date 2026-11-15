/**
 * Runs a WASI build as a UCI engine under Bun or Node: stdin feeds the engine's
 * input ring, and the engine runs on its own thread (thread.ts), so a `stop`
 * reaches a running search.
 *
 *   bun host/wasi/main.ts <build.wasm> [args...]   (or node)
 *   bun host/wasi/main.ts build/wasi/ratchet.wasm bench
 *
 * The arguments after the build go to the engine as its command line. A Bun
 * executable (tools/package.ts) embeds one build and calls runEngine.
 */
import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { Ring } from "./wasi.ts";

/**
 * Runs the WASI build `wasm` with the command line `args`, its name first, and ends the process with its exit
 * code. `thread` is thread.ts's location: a Bun executable embeds it at its own path inside the executable.
 */
export function runEngine(wasm: Uint8Array, args: string[], thread: URL = new URL("./thread.ts", import.meta.url)): void {
  const ring = new Ring();
  const worker = new Worker(thread, { workerData: { wasm, ring: ring.buffer, args } });
  worker.on("message", (code: number) => process.exit(code));
  worker.on("error", (e: Error) => {
    process.stderr.write(`engine error: ${e.stack ?? e}\n`);
    process.exit(1);
  });
  process.stdin.on("data", (chunk: Buffer) => ring.push(chunk));
  process.stdin.on("end", () => ring.close());
}

if (import.meta.main) {
  const [file, ...rest] = process.argv.slice(2);
  if (!file) throw new Error("usage: main.ts <build.wasm> [args...]");
  runEngine(readFileSync(file), [file, ...rest]);
}
