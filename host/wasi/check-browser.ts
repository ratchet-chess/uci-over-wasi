// SPDX-License-Identifier: MIT
// Copyright (c) 2026 the uci-over-wasi contributors. The license's text is in LICENSE.
/**
 * Browser driver for host/wasi/check.ts: runs each check session in a fresh check-worker.ts Worker.
 * Platform-neutral DOM/Worker APIs only (no node: imports).
 */
import type { CheckDriver, CheckRun, TimedLine } from "./check.ts";
import type { CheckWorkerIn, CheckWorkerOut } from "./check-worker.ts";
import { canSuspend } from "./wasi.ts";

/** whether this browser page can deliver live input during a search (isolation or JSPI) */
export function canRunBrowserChecks(): boolean {
  return Boolean(globalThis.crossOriginIsolated) || canSuspend();
}

/** whether this browser page can spawn wasi-threads workers */
export function canSpawnBrowserThreads(): boolean {
  return Boolean(globalThis.crossOriginIsolated);
}

class BrowserRun implements CheckRun {
  readonly lines: TimedLine[] = [];
  private readonly worker: Worker;
  private readonly waiters: (() => void)[] = [];
  private stderr = "";
  private error = "";
  private code: number | null | undefined;

  constructor(worker: Worker, wasm: Uint8Array, args: string[], spawns: boolean) {
    this.worker = worker;
    this.worker.onmessage = (e: MessageEvent<CheckWorkerOut>) => {
      const m = e.data;
      if ("line" in m) this.lines.push({ text: m.line.trimEnd(), at: performance.now() });
      else if ("stderr" in m) this.stderr += m.stderr;
      else if ("error" in m) this.error = m.error;
      else if ("exit" in m) this.code = m.exit;
      this.wake();
    };
    this.worker.onerror = (e: ErrorEvent) => {
      e.preventDefault();
      this.error = e.message || "worker failed";
      this.code = 1;
      this.wake();
    };
    const msg: CheckWorkerIn = { start: { wasm, args, spawns } };
    this.worker.postMessage(msg);
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
    for (const l of lines) {
      const msg: CheckWorkerIn = { send: l };
      this.worker.postMessage(msg);
    }
    return performance.now();
  }

  end(): void {
    const msg: CheckWorkerIn = { eof: true };
    this.worker.postMessage(msg);
  }

  find(word: string, from = 0): number {
    for (let i = from; i < this.lines.length; i++) {
      const text = this.lines[i]!.text;
      if (text === word || text.startsWith(word + " ")) return i;
    }
    return -1;
  }

  async expect(word: string, ms: number, from = 0): Promise<number> {
    await this.until(() => this.find(word, from) >= 0 || this.code !== undefined, ms);
    const i = this.find(word, from);
    if (i < 0) {
      const detail = this.error || this.stderr.trim().split("\n").pop() || "";
      throw new Error(
        this.code !== undefined
          ? `exited with ${this.code} before \`${word}\`${detail ? ": " + detail : ""}`
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
    if (this.code === undefined) {
      this.code = -1;
      this.worker.terminate();
      this.wake();
    }
  }

  output(): string {
    return this.lines.map((l) => l.text).join("\n") + "\n" + this.stderr;
  }
}

/** builds a CheckDriver that spawns a fresh check-worker.ts Worker per check session */
export function browserDriver(wasm: Uint8Array, name: string, createWorker: () => Worker): CheckDriver {
  return ({ args = [], spawns }) => new BrowserRun(createWorker(), wasm, [name, ...args], spawns);
}
