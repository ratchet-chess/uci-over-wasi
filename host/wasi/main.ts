// SPDX-License-Identifier: MIT
// Copyright (c) 2026 the uci-over-wasi contributors. The license's text is in LICENSE.
/**
 * Runs a WASI build as a UCI engine under Bun or Node: stdin feeds the engine's
 * input ring, and the engine runs on its own thread (thread.ts), so a `stop`
 * reaches a running search. A build that declares itself deaf (wasi.ts declarationOf)
 * never gets a `stop` or an unbounded `go`. A wasi-threads build's threads are
 * Workers too (thread.ts).
 *
 *   bun host/wasi/main.ts <build.wasm> [args...]   (or node)
 *   bun host/wasi/main.ts engine.wasm bench
 *
 * The arguments after the build go to the engine as its command line. A Bun
 * executable (Ratchet's tools/package.ts) embeds one build and calls runEngine.
 *
 * UCI_OVER_WASI_SPAWN=0 in the environment makes this a host that starts no
 * thread, as a page that is not cross-origin isolated is: tools/wasi-check.ts
 * checks there a module that imports thread-spawn without requiring threads.
 */
import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { DEAF_REFUSAL, Ring, declarationOf, refusal, unheard, type Profile } from "./wasi.ts";

/**
 * Runs the WASI build `wasm` with the command line `args`, its name first, and ends the process with its exit
 * code. `thread` is thread.ts's location: a Bun executable embeds it at its own path inside the executable.
 */
export function runEngine(wasm: Uint8Array, args: string[], thread: URL = new URL("./thread.ts", import.meta.url)): void {
  let profile: Profile;
  const canSpawn = process.env.UCI_OVER_WASI_SPAWN !== "0";
  try {
    // a profile or a feature this host does not know, or a feature it lacks: the module is not run
    const declaration = declarationOf(wasm);
    const why = refusal(declaration, canSpawn);
    if (why) throw new Error(why);
    profile = declaration.profile;
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(1);
  }
  const ring = new Ring();
  // a spawned thread that exits or traps sets slot 1 of ctl (thread.ts), and this ends the process
  const ctl = new SharedArrayBuffer(8);
  const ended = new Int32Array(ctl);
  setInterval(() => {
    const code = Atomics.load(ended, 1);
    if (code !== 0) process.exit(code - 1);
  }, 10).unref();
  const worker = new Worker(thread, { workerData: { wasm, ring: ring.buffer, args, thread: thread.href, spawns: canSpawn, ctl } });
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
