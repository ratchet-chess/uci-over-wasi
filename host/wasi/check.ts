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
/** a bounded search long enough that lines after it arrive while it runs, on most engines */
const DEAF_GO = "go depth 10";
/** a position with one legal move, a mate: an unbounded search of it ends by itself and must then wait for `stop` */
const MATE_IN_ONE = "position fen k7/8/1K6/8/8/8/8/7R w - - 0 1";

/** one timed line written by a running module */
export type TimedLine = { text: string; at: number };

/** one running session of the module under test, supplied by a driver */
export interface CheckRun {
  readonly lines: TimedLine[];
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
  const declared = declarationOf(wasm);
  const profile = opts.profile ?? declared.profile;
  const used = featuresOf(wasm);
  const threadCount = opts.threadCount;
  const benchNodes = opts.benchNodes;
  const benchArgs = opts.benchArgs ?? ["bench"];
  const only = opts.only;
  const signal = opts.signal;
  /** whether the host starts threads: not for a module that imports thread-spawn without requiring threads, unless --threads */
  const spawns = !used.threadSpawn || declared.requires.includes("threads") || threadCount !== undefined;

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

  const quit = async (run: CheckRun): Promise<void> => {
    run.send("quit");
    await run.exit(HEAR_MS);
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
    for (const open of [false, true]) {
      const run = spawnRun(benchArgs);
      if (!open) run.end();
      await run.exit(30 * 60 * 1000);
      if (!new RegExp(`(^|\\D)${benchNodes}(\\D|$)`).test(run.output())) {
        throw new Error(`no ${benchNodes} in the bench output with stdin ${open ? "open" : "at its end"}: ${run.output().trim().split("\n").slice(-2).join(" | ")}`);
      }
      run.end();
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
      await quit(run);
      return "skipped: no Threads option above 1";
    }
    const from = run.lines.length;
    run.send("setoption name Threads value 2", "isready");
    await run.expect("readyok", START_MS, from);
    run.send("position startpos", "go movetime 500");
    const best = await run.expect("bestmove", START_MS, from);
    run.send("isready");
    await run.expect("readyok", HEAR_MS, best + 1);
    await quit(run);
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
    const move = run.lines[first]!.text.split(" ")[1] ?? "";
    if (!/^[a-h][78]/.test(move)) throw new Error(`the last move of the \`position\` line was lost: after 1. e4 the module played ${move}`);
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
      await quit(run);
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
      const move = run.lines[next]!.text.split(" ")[1] ?? "";
      await quit(run);
      if (!/^[a-h][78]/.test(move)) throw new Error(`the queued \`position\` was lost: after 1. e4 the module played ${move}`);
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
      await quit(run);
      return "exit after quit";
    },

    async stop() {
      const run = await start();
      const from = run.lines.length;
      run.send("position startpos", DEAF_GO, "stop");
      await run.expect("bestmove", START_MS);
      run.send("stop", "isready");
      await run.expect("readyok", HEAR_MS, from);
      await quit(run);
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
      await quit(run);
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
      await quit(run);
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
      await quit(run);
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
      const move = run.lines[next]!.text.split(" ")[1] ?? "";
      await quit(run);
      if (!/^[a-h][78]/.test(move)) throw new Error(`the queued \`position\` was lost: after 1. e4 the module played ${move}`);
      return `queued position applied, reply ${move}`;
    },

    async "eof-bounded"() {
      const lines = ["uci", "position startpos", "go movetime 1500"];
      const open = spawnRun();
      let at = open.send(...lines);
      const openMs = open.lines[await open.expect("bestmove", START_MS)]!.at - at;
      await quit(open);
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
      await quit(run);
      return early ? "the module printed its bestmove before `stop`" : "bestmove held until `stop`";
    },

    async ponder() {
      const run = await start();
      if (!run.lines.some((l) => /^option name Ponder /i.test(l.text))) {
        await quit(run);
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
      await quit(run);
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
