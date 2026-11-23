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
import { runChecks, type CheckDriver, type CheckRun, type TimedLine } from "../host/wasi/check.ts";

const HOST = fileURLToPath(new URL("../host/wasi/main.ts", import.meta.url));

class ProcessRun implements CheckRun {
  readonly lines: TimedLine[] = [];
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly waiters: (() => void)[] = [];
  private partial = "";
  private stderr = "";
  private code: number | null | undefined;

  constructor(module: string, args: string[], spawns: boolean) {
    this.child = spawn(process.execPath, [HOST, module, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(spawns ? {} : { UCI_OVER_WASI_SPAWN: "0" }) },
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.partial += chunk.toString();
      for (let nl = this.partial.indexOf("\n"); nl >= 0; nl = this.partial.indexOf("\n")) {
        this.lines.push({ text: this.partial.slice(0, nl).trimEnd(), at: performance.now() });
        this.partial = this.partial.slice(nl + 1);
      }
      this.wake();
    });
    this.child.stderr.on("data", (chunk: Buffer) => (this.stderr += chunk.toString()));
    this.child.on("exit", (code) => {
      this.code = code;
      this.wake();
    });
    this.child.stdin.on("error", () => {});
  }

  private wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }

  private async until(done: () => boolean, ms: number): Promise<boolean> {
    const end = performance.now() + ms;
    while (!done()) {
      const left = end - performance.now();
      if (left <= 0) return false;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return true;
  }

  send(...lines: string[]): number {
    this.child.stdin.write(lines.map((l) => l + "\n").join(""));
    return performance.now();
  }

  end(): void {
    this.child.stdin.end();
  }

  find(word: string, from = 0): number {
    for (let i = from; i < this.lines.length; i++) {
      if (this.lines[i].text === word || this.lines[i].text.startsWith(word + " ")) return i;
    }
    return -1;
  }

  async expect(word: string, ms: number, from = 0): Promise<number> {
    await this.until(() => this.find(word, from) >= 0 || this.code !== undefined, ms);
    const i = this.find(word, from);
    if (i < 0) {
      throw new Error(
        this.code !== undefined
          ? `exited with ${this.code} before \`${word}\`${this.stderr ? ": " + this.stderr.trim().split("\n").pop() : ""}`
          : `no \`${word}\` within ${ms} ms`,
      );
    }
    return i;
  }

  async exit(ms: number): Promise<number | null> {
    if (!(await this.until(() => this.code !== undefined, ms))) {
      throw new Error(`still running ${ms} ms later`);
    }
    return this.code!;
  }

  kill(): void {
    if (this.code === undefined) this.child.kill("SIGKILL");
  }

  output(): string {
    return this.lines.map((l) => l.text).join("\n") + "\n" + this.stderr;
  }
}

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i < 0 ? undefined : argv.splice(i, 2)[1];
};
const asked = flag("--profile");
if (asked !== undefined && asked !== "polls" && asked !== "deaf") throw new Error(`unknown profile ${asked}`);
const benchNodes = flag("--bench");
const benchArgs = (flag("--bench-args") ?? "bench").split(" ");
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
