// SPDX-License-Identifier: MIT
// Copyright (c) 2026 the uci-over-wasi contributors. The license's text is in LICENSE.
/**
 * The UCI over WASI checks, shared by the CLI (tools/wasi-check.ts) and the browser driver
 * (host/wasi/check-browser.ts). Platform-neutral: no node: imports.
 *
 * Each check takes a fresh session from the caller's CheckDriver, sends timed UCI lines, and verifies
 * the module's answers against Part 1 of docs/uci-over-wasi.md.
 */
import { declarationOf, refusal, type Declaration, type Feature, type Profile } from "./wasi.ts";
import { featuresOf, type Features } from "./features.ts";

/** a module's start: a large build compiles for seconds on a cold start */
const START_MS = 30000;
/** the longest wait for an answer to a line that a search must hear */
const HEAR_MS = 2000;
/** how long a search runs before a check sends its line */
const SEARCH_MS = 300;
/** the longest a bench may run on one CPU */
const BENCH_MS = 30 * 60 * 1000;
/** a bounded search long enough that lines after it arrive while it runs, on most engines */
const DEAF_GO = "go depth 10";
/** a mate in one: an unbounded search of it finds the mate at once, and must still wait for `stop` */
const MATE_IN_ONE = "position fen k7/8/1K6/8/8/8/8/7R w - - 0 1";

/** one timed line written by a running module */
export type TimedLine = { text: string; at: number };

/** one running session of the module under test, supplied by a driver */
export interface CheckRun {
  readonly lines: TimedLine[];
  /** writes `lines` to the module's stdin; returns the time they were sent, on performance.now()'s clock */
  send(...lines: string[]): number;
  /** ends the module's input */
  end(): void;
  /** the index of the first line from `from` on that starts with `word`, or -1 */
  find(word: string, from?: number): number;
  /** waits for a line that starts with `word`, from line `from` on; throws on exit or timeout */
  expect(word: string, ms: number, from?: number): Promise<number>;
  /** waits for the session to end; throws if it has not within `ms` */
  exit(ms: number): Promise<number | null>;
  /** ends the session immediately */
  kill(): void;
  /** everything the session printed: stdout and stderr */
  output(): string;
}

/** shared line-waiting and exit state for CheckDriver implementations */
export abstract class CheckSession implements CheckRun {
  readonly lines: TimedLine[] = [];
  private readonly waiters: (() => void)[] = [];
  protected stderr = "";
  protected error = "";
  protected code: number | null | undefined;

  abstract send(...lines: string[]): number;
  abstract end(): void;
  abstract kill(): void;

  protected wake(): void {
    for (const w of this.waiters.splice(0)) w();
  }

  protected recordLine(text: string): void {
    this.lines.push({ text: text.trimEnd(), at: performance.now() });
    this.wake();
  }

  protected recordStderr(chunk: string): void {
    this.stderr += chunk;
    this.wake();
  }

  protected recordError(message: string): void {
    this.error = message;
    this.wake();
  }

  protected recordExit(code: number | null): void {
    if (this.code === undefined) this.code = code;
    this.wake();
  }

  private async until(done: () => boolean, ms: number): Promise<boolean> {
    const end = performance.now() + ms;
    while (!done()) {
      const left = end - performance.now();
      if (left <= 0) return false;
      await new Promise<void>((resolve) => {
        const onWake = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          const i = this.waiters.indexOf(onWake);
          if (i >= 0) this.waiters.splice(i, 1);
          resolve();
        }, left);
        this.waiters.push(onWake);
      });
    }
    return true;
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

  output(): string {
    return this.lines.map((l) => l.text).join("\n") + "\n" + this.stderr;
  }
}

/** starts one fresh session of the module */
export type CheckDriver = (opts: { args?: string[]; spawns: boolean }) => CheckRun;

/** options for runChecks */
export type CheckOptions = {
  profile?: Profile;
  threadCount?: string;
  benchNodes?: string;
  benchArgs?: string[];
  only?: string;
  signal?: AbortSignal;
  /** called once when the first `uci` handshake reports `id name` / `id author` */
  onIdentity?: (id: { name: string; author: string }) => void;
};

/** one check's outcome */
export type CheckResult = {
  name: string;
  status: "pass" | "fail" | "skip";
  detail: string;
};

/** static inspection of a module's bytes before any session starts */
export type Inspection = {
  declaration: Declaration;
  features: Features;
  spawns: boolean;
  refusal?: string;
};

/** reads a module's declaration, features, and whether this host can run it */
export function inspectModule(wasm: Uint8Array, canSpawn: boolean, opts?: { threadCount?: string }): Inspection {
  const declaration = declarationOf(wasm);
  const features = featuresOf(wasm);
  const spawns = !features.threadSpawn || declaration.requires.includes("threads") || opts?.threadCount !== undefined;
  const why = refusal(declaration, canSpawn);
  return { declaration, features, spawns, ...(why ? { refusal: why } : {}) };
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("cancelled"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/**
 * Runs the UCI over WASI checks for `wasm` through `driver`. Calls `onResult` after each check finishes,
 * and stops early if `opts.signal` aborts.
 */
export async function runChecks(
  wasm: Uint8Array,
  driver: CheckDriver,
  opts: CheckOptions = {},
  onResult?: (r: CheckResult) => void,
): Promise<CheckResult[]> {
  const { threadCount, benchNodes, benchArgs = ["bench"], only, signal } = opts;
  const { declaration: declared, features: used, spawns } = inspectModule(wasm, true, { threadCount });
  const profile = opts.profile ?? declared.profile;

  const active = new Set<CheckRun>();
  const spawnRun = (args?: string[]): CheckRun => {
    if (signal?.aborted) throw new Error("cancelled");
    const run = driver({ args, spawns });
    active.add(run);
    return run;
  };
  const killAll = () => {
    for (const r of active) r.kill();
    active.clear();
  };
  signal?.addEventListener("abort", killAll);

  let identified = false;
  const start = async (): Promise<CheckRun> => {
    const run = spawnRun();
    run.send("uci");
    const ok = await run.expect("uciok", START_MS);
    if (!identified && opts.onIdentity) {
      identified = true;
      let name = "";
      let author = "";
      for (let i = 0; i < ok; i++) {
        const l = run.lines[i]!.text;
        if (l.startsWith("id name ")) name = l.slice(8).trim();
        else if (l.startsWith("id author ")) author = l.slice(10).trim();
      }
      if (name || author) opts.onIdentity({ name, author });
    }
    if (threadCount) run.send(`setoption name Threads value ${threadCount}`);
    run.send("isready");
    await run.expect("readyok", START_MS);
    return run;
  };

  const sendQuit = async (run: CheckRun): Promise<void> => {
    run.send("quit");
    await run.exit(HEAR_MS);
  };

  /** the move of the bestmove line at `i`, which must be Black's: it answers a position after 1. e4 */
  const replyToE4 = (run: CheckRun, i: number, lost: string): string => {
    const move = run.lines[i]!.text.split(" ")[1] ?? "";
    if (!/^[a-h][78]/.test(move)) throw new Error(`${lost}: after 1. e4 the module played ${move}`);
    return move;
  };

  const declaration = async (): Promise<string> => {
    const uses: Record<Feature, boolean> = {
      threads: used.threadSpawn,
      "relaxed-simd": used.relaxed.size > 0,
      "exception-handling": used.exceptionHandling,
    };
    const wrong: string[] = [];
    for (const [f, yes] of Object.entries(uses) as [Feature, boolean][]) {
      // a thread-spawn module need not require threads: it then plays on one thread where a host cannot spawn
      if (yes && f !== "threads" && !declared.requires.includes(f)) wrong.push(`uses ${f} without requires=${f}`);
      if (!yes && declared.requires.includes(f)) wrong.push(`requires ${f} and does not use it`);
    }
    if (wrong.length) throw new Error(wrong.join("; "));
    const parts = [`requires=${declared.requires.join(" ") || "(none)"}`];
    if (!spawns) parts.push("imports thread-spawn without requiring threads, so it is checked under a host that starts no thread");
    else if (used.threadSpawn && !declared.requires.includes("threads")) parts.push("imports thread-spawn without requiring threads; checked with --threads under a host that starts threads");
    if (used.relaxed.size) parts.push(`relaxed ops ${[...used.relaxed].map(([op, n]) => `${op} ×${n}`).join(", ")}: their exactness is shown by the node signature on x86 and ARM, not here`);
    return parts.join("; ");
  };

  const bench = async (): Promise<string> => {
    if (!benchNodes) return "skipped: no --bench";
    const escaped = benchNodes.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(^|\\D)${escaped}(\\D|$)`);
    for (const open of [false, true]) {
      const run = spawnRun(benchArgs);
      if (!open) run.end();
      await run.exit(BENCH_MS);
      if (!pattern.test(run.output())) {
        throw new Error(`no ${benchNodes} in the bench output with stdin ${open ? "open" : "at its end"}: ${run.output().trim().split("\n").slice(-2).join(" | ")}`);
      }
    }
    return `${benchNodes} nodes with stdin at its end and open`;
  };

  const threads = async (): Promise<string> => {
    if (!used.threadSpawn) return "skipped: no thread-spawn import";
    if (spawns) return threadCount ? `skipped: --threads ${threadCount} checks the module on several threads` : "skipped: the module requires threads; --threads checks it on several";
    const run = spawnRun();
    run.send("uci");
    await run.expect("uciok", START_MS);
    if (!run.lines.some((l) => /^option name Threads .*\bmax\s+([2-9]|\d\d)/i.test(l.text))) {
      await sendQuit(run);
      return "skipped: no Threads option above 1";
    }
    const from = run.lines.length;
    run.send("setoption name Threads value 2", "isready");
    await run.expect("readyok", START_MS, from);
    run.send("position startpos", "go movetime 500");
    const best = await run.expect("bestmove", START_MS, from);
    run.send("isready");
    await run.expect("readyok", HEAR_MS, best + 1);
    await sendQuit(run);
    return "with Threads 2 and every spawn refused, a bestmove and then readyok";
  };

  const crlf = async (): Promise<string> => {
    const cr = (...lines: string[]) => lines.map((l) => l + "\r");
    const run = spawnRun();
    run.send(...cr("uci"));
    await run.expect("uciok", START_MS);
    run.send(...cr("isready"));
    await run.expect("readyok", START_MS);
    run.send(...cr("position startpos moves e2e4", "go depth 1"));
    const first = await run.expect("bestmove", START_MS);
    const move = replyToE4(run, first, "the last move of the `position` line was lost");
    if (profile === "polls") {
      run.send(...cr("go infinite"));
      await sleep(SEARCH_MS, signal);
      if (run.find("bestmove", first + 1) >= 0) throw new Error("`go infinite` printed a bestmove before `stop`");
      run.send(...cr("stop"));
      await run.expect("bestmove", HEAR_MS, first + 1);
    } else {
      const from = run.lines.length;
      run.send(...cr("stop", "go infinite"));
      const refused = await run.expect("bestmove", HEAR_MS, from);
      if (run.lines[refused]!.text !== "bestmove 0000") throw new Error(`\`go infinite\` was not refused: ${run.lines[refused]!.text}`);
      run.send(...cr("isready"));
      await run.expect("readyok", HEAR_MS, from);
    }
    run.send(...cr("quit"));
    const code = await run.exit(HEAR_MS);
    if (code !== 0) throw new Error(`exit code ${code}`);
    return `reply ${move}, ${profile === "polls" ? "`stop` heard" : "`stop` and `go infinite` kept away"}, then exit 0`;
  };

  const deafChecks: Record<string, () => Promise<string | void>> = {
    declaration,

    async bounded() {
      const run = await start();
      const from = run.lines.length;
      const at = run.send("position startpos", DEAF_GO);
      const i = await run.expect("bestmove", START_MS);
      run.send("isready");
      await run.expect("readyok", HEAR_MS, from);
      await sendQuit(run);
      return `bestmove after ${Math.round(run.lines[i]!.at - at)} ms`;
    },

    async order() {
      const run = await start();
      const from = run.lines.length;
      run.send("position startpos", DEAF_GO, "position startpos moves e2e4", "isready", "go depth 1");
      const best = await run.expect("bestmove", START_MS);
      const ready = await run.expect("readyok", HEAR_MS, from);
      if (ready < best) throw new Error("readyok came before the bestmove of the search sent ahead of it");
      const next = await run.expect("bestmove", HEAR_MS, best + 1);
      const move = replyToE4(run, next, "the queued `position` was lost");
      await sendQuit(run);
      return `bestmove, readyok, then the queued position's reply ${move}`;
    },

    async eof() {
      const run = spawnRun();
      run.send("uci", "position startpos", DEAF_GO);
      run.end();
      await run.expect("bestmove", START_MS);
      const code = await run.exit(HEAR_MS);
      if (code !== 0) throw new Error(`exit code ${code}`);
      return "bestmove, then exit 0";
    },

    async quit() {
      const run = await start();
      run.send("position startpos", "go depth 4");
      await run.expect("bestmove", START_MS);
      await sendQuit(run);
      return "exit after quit";
    },

    async stop() {
      const run = await start();
      const from = run.lines.length;
      run.send("position startpos", DEAF_GO, "stop");
      await run.expect("bestmove", START_MS);
      run.send("stop", "isready");
      await run.expect("readyok", HEAR_MS, from);
      await sendQuit(run);
      return "the module answers after two stops";
    },

    async infinite() {
      const run = await start();
      const from = run.lines.length;
      run.send("position startpos");
      for (const go of ["go infinite", "go"]) {
        const sent = run.lines.length;
        run.send(go);
        const i = await run.expect("bestmove", HEAR_MS, sent);
        if (run.lines[i]!.text !== "bestmove 0000") throw new Error(`\`${go}\` was not refused: ${run.lines[i]!.text}`);
      }
      run.send("isready");
      await run.expect("readyok", HEAR_MS, from);
      await sendQuit(run);
      return "bestmove 0000 for `go infinite` and for a bare `go`, then readyok";
    },

    crlf,
    threads,
    bench,
  };

  const pollsChecks: Record<string, () => Promise<string | void>> = {
    declaration,

    async stop() {
      const run = await start();
      run.send("position startpos", "go infinite");
      await sleep(SEARCH_MS, signal);
      if (run.find("bestmove") >= 0) throw new Error("`go infinite` printed a bestmove before `stop`");
      const at = run.send("stop");
      const i = await run.expect("bestmove", HEAR_MS);
      await sendQuit(run);
      return `bestmove ${Math.round(run.lines[i]!.at - at)} ms after stop`;
    },

    async isready() {
      const run = await start();
      const from = run.lines.length;
      run.send("position startpos", "go infinite");
      await sleep(SEARCH_MS, signal);
      const at = run.send("isready");
      const i = await run.expect("readyok", HEAR_MS, from);
      if (run.find("bestmove") >= 0) throw new Error("the search ended before `stop`");
      run.send("stop");
      await run.expect("bestmove", HEAR_MS);
      await sendQuit(run);
      return `readyok ${Math.round(run.lines[i]!.at - at)} ms after isready`;
    },

    async order() {
      const run = await start();
      const from = run.lines.length;
      run.send("position startpos", "go infinite");
      await sleep(SEARCH_MS, signal);
      run.send("position startpos moves e2e4", "isready");
      await sleep(SEARCH_MS, signal);
      if (run.find("readyok", from) >= 0) throw new Error("`isready` was answered ahead of the `position` line queued before it");
      run.send("stop");
      const best = await run.expect("bestmove", HEAR_MS);
      const ready = await run.expect("readyok", HEAR_MS, from);
      if (ready < best) throw new Error("readyok came before the bestmove");
      run.send("go depth 1");
      const next = await run.expect("bestmove", HEAR_MS, best + 1);
      const move = replyToE4(run, next, "the queued `position` was lost");
      await sendQuit(run);
      return `queued position applied, reply ${move}`;
    },

    async "eof-bounded"() {
      const lines = ["uci", "position startpos", "go movetime 1500"];
      const open = spawnRun();
      let at = open.send(...lines);
      const openMs = open.lines[await open.expect("bestmove", START_MS)]!.at - at;
      await sendQuit(open);
      const run = spawnRun();
      at = run.send(...lines);
      run.end();
      const ms = run.lines[await run.expect("bestmove", START_MS)]!.at - at;
      const code = await run.exit(HEAR_MS);
      if (ms < 0.7 * openMs) throw new Error(`the search ended ${Math.round(ms)} ms in, against ${Math.round(openMs)} ms with stdin open: cut short by the end of input`);
      if (code !== 0) throw new Error(`exit code ${code}`);
      return `bestmove after ${Math.round(ms)} ms, against ${Math.round(openMs)} ms with stdin open, then exit 0`;
    },

    async "eof-unbounded"() {
      const run = await start();
      run.send("position startpos", "go infinite");
      await sleep(SEARCH_MS, signal);
      const at = performance.now();
      run.end();
      const i = await run.expect("bestmove", HEAR_MS);
      const code = await run.exit(HEAR_MS);
      if (code !== 0) throw new Error(`exit code ${code}`);
      return `bestmove ${Math.round(run.lines[i]!.at - at)} ms after the end of input, then exit 0`;
    },

    async "eof-no-limit"() {
      const run = await start();
      run.send("position startpos", "go");
      await sleep(SEARCH_MS, signal);
      const before = run.find("bestmove") >= 0;
      const at = performance.now();
      run.end();
      const i = await run.expect("bestmove", HEAR_MS);
      const code = await run.exit(HEAR_MS);
      if (code !== 0) throw new Error(`exit code ${code}`);
      return before ? "the search ended by itself, then exit 0" : `bestmove ${Math.round(run.lines[i]!.at - at)} ms after the end of input, then exit 0`;
    },

    async "eof-with-go"() {
      const run = spawnRun();
      run.send("uci", "position startpos", "go infinite");
      run.end();
      await run.expect("bestmove", START_MS);
      const code = await run.exit(HEAR_MS);
      if (code !== 0) throw new Error(`exit code ${code}`);
      return "bestmove, then exit 0";
    },

    async quit() {
      const run = await start();
      run.send("position startpos", "go infinite");
      await sleep(SEARCH_MS, signal);
      const at = run.send("quit");
      const code = await run.exit(HEAR_MS);
      if (code !== 0) throw new Error(`exit code ${code}`);
      return `exit ${Math.round(performance.now() - at)} ms after quit${run.find("bestmove") >= 0 ? ", with a bestmove" : ", with no bestmove"}`;
    },

    async wait() {
      const run = await start();
      const from = run.lines.length;
      run.send(MATE_IN_ONE, "go infinite");
      await sleep(4 * SEARCH_MS, signal);
      const early = run.find("bestmove") >= 0;
      run.send("isready");
      await run.expect("readyok", HEAR_MS, from);
      run.send("stop");
      await run.expect("bestmove", HEAR_MS);
      await sendQuit(run);
      return early ? "the module printed its bestmove before `stop`" : "bestmove held until `stop`";
    },

    async ponder() {
      const run = await start();
      if (!run.lines.some((l) => /^option name Ponder /i.test(l.text))) {
        await sendQuit(run);
        return "skipped: no Ponder option";
      }
      run.send("setoption name Ponder value true", "position startpos moves e2e4 e7e5", "go ponder wtime 3000 btime 3000");
      await sleep(1000, signal);
      if (run.find("bestmove") >= 0) throw new Error("a ponder search printed its bestmove before `ponderhit`");
      const at = run.send("ponderhit");
      const i = await run.expect("bestmove", 3000 + HEAR_MS);
      run.send("position startpos", "go ponder wtime 3000 btime 3000");
      await sleep(SEARCH_MS, signal);
      run.send("stop");
      await run.expect("bestmove", HEAR_MS, i + 1);
      await sendQuit(run);
      return `bestmove ${Math.round(run.lines[i]!.at - at)} ms after ponderhit; stop ends a ponder search`;
    },

    crlf,
    threads,
    bench,
  };

  const results: CheckResult[] = [];
  try {
    for (const [name, check] of Object.entries(profile === "deaf" ? deafChecks : pollsChecks)) {
      if (only && only !== name) continue;
      if (signal?.aborted) break;
      let result: CheckResult;
      try {
        const detail = (await check()) ?? "";
        const status = detail.startsWith("skipped:") ? "skip" : "pass";
        result = { name, status, detail };
      } catch (e) {
        if (signal?.aborted) break;
        result = { name, status: "fail", detail: e instanceof Error ? e.message : String(e) };
      } finally {
        killAll();
      }
      results.push(result);
      onResult?.(result);
    }
  } finally {
    signal?.removeEventListener("abort", killAll);
    killAll();
  }
  return results;
}
