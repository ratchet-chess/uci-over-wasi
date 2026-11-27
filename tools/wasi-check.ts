// SPDX-License-Identifier: MIT
// Copyright (c) 2026 the uci-over-wasi contributors. The license's text is in LICENSE.
/**
 * Checks a WASI build against UCI over WASI's rules (host/wasi/check.ts) under
 * host/wasi/main.ts and the runtime that runs this script.
 *
 *   bun tools/wasi-check.ts <build.wasm> [--profile polls|deaf] [--threads <n>] [--bench <nodes>] [--bench-args <args>] [--only <check>]
 *
 * Each check starts a fresh process. It prints one line per check and exits 1
 * if any failed. This script starts the build wherever the script runs, so run
 * another engine's build inside a container.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CheckSession, runChecks, type CheckDriver } from "../host/wasi/check.ts";

const HOST = fileURLToPath(new URL("../host/wasi/main.ts", import.meta.url));

class ProcessRun extends CheckSession {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly outDecoder = new TextDecoder();
  private readonly errDecoder = new TextDecoder();
  private partial = "";

  constructor(module: string, args: string[], spawns: boolean) {
    super();
    this.child = spawn(process.execPath, [HOST, module, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(spawns ? {} : { UCI_OVER_WASI_SPAWN: "0" }) },
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.partial += this.outDecoder.decode(chunk, { stream: true });
      for (let nl = this.partial.indexOf("\n"); nl >= 0; nl = this.partial.indexOf("\n")) {
        this.recordLine(this.partial.slice(0, nl));
        this.partial = this.partial.slice(nl + 1);
      }
    });
    this.child.stderr.on("data", (chunk: Buffer) => this.recordStderr(this.errDecoder.decode(chunk, { stream: true })));
    this.child.on("error", (e: Error) => {
      this.recordError(e.message);
      this.recordExit(1);
    });
    // wait for close so stdout and stderr finish draining before recording exit
    this.child.on("close", (code) => {
      this.partial += this.outDecoder.decode();
      if (this.partial !== "") {
        this.recordLine(this.partial);
        this.partial = "";
      }
      const errTail = this.errDecoder.decode();
      if (errTail !== "") this.recordStderr(errTail);
      this.recordExit(code);
    });
    this.child.stdin.on("error", () => {});
  }

  send(...lines: string[]): number {
    this.child.stdin.write(lines.map((l) => l + "\n").join(""));
    return performance.now();
  }

  end(): void {
    this.child.stdin.end();
  }

  kill(): void {
    if (this.code === undefined) this.child.kill("SIGKILL");
  }
}

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  if (i + 1 >= argv.length) throw new Error(`${name} requires a value`);
  return argv.splice(i, 2)[1];
};
const asked = flag("--profile");
if (asked !== undefined && asked !== "polls" && asked !== "deaf") throw new Error(`unknown profile ${asked}`);
const benchNodes = flag("--bench");
const benchArgs = (flag("--bench-args") ?? "bench").trim().split(/\s+/).filter(Boolean);
const only = flag("--only");
const threadCount = flag("--threads");
const module = argv[0];
if (!module) throw new Error("usage: wasi-check.ts <build.wasm> [--profile polls|deaf] [--threads <n>] [--bench <nodes>] [--bench-args <args>] [--only <check>]");

const driver: CheckDriver = ({ args = [], spawns }) => new ProcessRun(module, args, spawns);
const results = await runChecks(
  readFileSync(module),
  driver,
  { profile: asked, threadCount, benchNodes, benchArgs, only },
  (r) => console.log(`${r.status === "fail" ? "FAIL" : "pass"}  ${r.name}: ${r.detail}`),
);
process.exit(results.some((r) => r.status === "fail") ? 1 : 0);
