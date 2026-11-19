// SPDX-License-Identifier: MIT
// Copyright (c) 2026 the uci-over-wasi contributors. The license's text is in LICENSE.
/**
 * Runs a WASI build as a UCI engine under Bun or Node: stdin feeds the engine's
 * input ring, and the engine runs on its own thread (thread.ts), so a `stop`
 * reaches a running search. A build that declares itself deaf (wasi.ts profileOf)
 * never gets a `stop` or an unbounded `go`.
 *
 *   bun host/wasi/main.ts <build.wasm> [args...]   (or node)
 *   bun host/wasi/main.ts engine.wasm bench
 *
 * The arguments after the build go to the engine as its command line. A Bun
 * executable (Ratchet's tools/package.ts) embeds one build and calls runEngine.
 */
import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { DEAF_REFUSAL, Ring, profileOf, unheard, type Profile } from "./wasi.ts";

/**
 * Runs the WASI build `wasm` with the command line `args`, its name first, and ends the process with its exit
 * code. `thread` is thread.ts's location: a Bun executable embeds it at its own path inside the executable.
 */
export function runEngine(wasm: Uint8Array, args: string[], thread: URL = new URL("./thread.ts", import.meta.url)): void {
  let profile: Profile;
  try {
    profile = profileOf(wasm);
  } catch (e) {
    // a profile this host does not know: the module is not run
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(1);
  }
  const ring = new Ring();
  const worker = new Worker(thread, { workerData: { wasm, ring: ring.buffer, args } });
  worker.on("message", (code: number) => process.exit(code));
  worker.on("error", (e: Error) => {
    process.stderr.write(`engine error: ${e.stack ?? e}\n`);
    process.exit(1);
  });
  if (profile === "polls") {
    process.stdin.on("data", (chunk: Buffer) => ring.push(chunk));
    process.stdin.on("end", () => ring.close());
    return;
  }
  // a deaf module: the lines its search could not act on are answered here, line by line
  let partial = "";
  const pass = (line: string) => {
    const answer = unheard(line, DEAF_REFUSAL);
    if (answer === null) ring.push(Buffer.from(line + "\n"));
    else for (const a of answer) process.stdout.write(a + "\n");
  };
  process.stdin.on("data", (chunk: Buffer) => {
    partial += chunk.toString();
    for (let nl = partial.indexOf("\n"); nl >= 0; nl = partial.indexOf("\n")) {
      pass(partial.slice(0, nl));
      partial = partial.slice(nl + 1);
    }
  });
  process.stdin.on("end", () => {
    if (partial !== "") pass(partial);
    ring.close();
  });
}

if (import.meta.main) {
  const [file, ...rest] = process.argv.slice(2);
  if (!file) throw new Error("usage: main.ts <build.wasm> [args...]");
  runEngine(readFileSync(file), [file, ...rest]);
}
