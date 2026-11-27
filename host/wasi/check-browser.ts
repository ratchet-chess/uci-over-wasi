// SPDX-License-Identifier: MIT
// Copyright (c) 2026 the uci-over-wasi contributors. The license's text is in LICENSE.
/**
 * Browser driver for host/wasi/check.ts: runs each check session in a fresh check-worker.ts Worker.
 * Platform-neutral DOM/Worker APIs only (no node: imports).
 */
import { CheckSession, type CheckDriver } from "./check.ts";
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

class BrowserRun extends CheckSession {
  private readonly worker: Worker;

  constructor(worker: Worker, wasm: Uint8Array, args: string[], spawns: boolean) {
    super();
    this.worker = worker;
    this.worker.onmessage = (e: MessageEvent<CheckWorkerOut>) => {
      const m = e.data;
      if ("line" in m) this.recordLine(m.line);
      else if ("stderr" in m) this.recordStderr(m.stderr);
      else if ("error" in m) this.recordError(m.error);
      else if ("exit" in m) this.recordExit(m.exit);
    };
    this.worker.onerror = (e: ErrorEvent) => {
      e.preventDefault();
      this.recordError(e.message || "worker failed");
      this.recordExit(1);
    };
    const msg: CheckWorkerIn = { start: { wasm, args, spawns } };
    this.worker.postMessage(msg);
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

  /** the worker's own threads end with it, so it is terminated even after an error recorded an exit */
  kill(): void {
    this.worker.terminate();
    this.recordExit(-1);
  }
}

/** builds a CheckDriver that spawns a fresh check-worker.ts Worker per check session */
export function browserDriver(wasm: Uint8Array, name: string, createWorker: () => Worker): CheckDriver {
  return ({ args = [], spawns }) => new BrowserRun(createWorker(), wasm, [name, ...args], spawns);
}
