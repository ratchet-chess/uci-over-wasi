/**
 * Checks a WASI build against UCI over WASI's rules for input during a search,
 * under host/wasi and the runtime that runs this script.
 *
 *   bun tools/wasi-check.ts <build.wasm> [--profile polls|deaf] [--bench <nodes>] [--bench-args <args>] [--only <check>]
 *   bun tools/wasi-check.ts build/wasi/ratchet.wasm
 *
 * --profile is the module's profile, default the one it declares (host/wasi
 * profileOf): polls, a module that reads stdin from inside its search, unless
 * its custom section says deaf. A deaf module reads nothing during a search.
 * Its checks: a bounded search ends by itself, lines sent during it are handled
 * after it in order, the end of input ends the module after its bestmove, and
 * the host keeps a `stop` and an unbounded `go` from it.
 *
 * --bench runs the module's bench from its command line, once with stdin at
 * its end and once with stdin open, and looks for <nodes> in each output: the
 * end of input must not cut a bench short. --bench-args is that command line,
 * default `bench`.
 *
 * Each check starts a fresh process. It prints one line per check and exits 1
 * if any failed. Another engine's build runs only inside a container
 * (tools/ws.ts); this script starts it wherever the script runs.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { profileOf } from "../host/wasi/wasi.ts";

const HOST = fileURLToPath(new URL("../host/wasi/main.ts", import.meta.url));
/** a module's start: a large build compiles for seconds on a cold start */
const START_MS = 30000;
/** the longest wait for an answer to a line that a search must hear */
const HEAR_MS = 2000;
/** how long a search runs before a check sends its line */
const SEARCH_MS = 300;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** one run of the module, with its output split into timed lines */
class Run {
  readonly lines: { text: string; at: number }[] = [];
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly waiters: (() => void)[] = [];
  private partial = "";
  private stderr = "";
  code: number | null | undefined;

  constructor(module: string, args: string[] = []) {
    this.child = spawn(process.execPath, [HOST, module, ...args], { stdio: ["pipe", "pipe", "pipe"] });
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

  /** waits until `done` holds, at most `ms`; returns whether it held */
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

  /** ends the module's input */
  end(): void {
    this.child.stdin.end();
  }

  /** the index of the first line from `from` on that starts with `word`, or -1 */
  find(word: string, from = 0): number {
    for (let i = from; i < this.lines.length; i++) if (this.lines[i].text === word || this.lines[i].text.startsWith(word + " ")) return i;
    return -1;
  }

  /** waits for a line that starts with `word`, from line `from` on; returns its index, or throws with what the check was waiting for */
  async expect(word: string, ms: number, from = 0): Promise<number> {
    await this.until(() => this.find(word, from) >= 0 || this.code !== undefined, ms);
    const i = this.find(word, from);
    if (i < 0) throw new Error(this.code !== undefined ? `exited with ${this.code} before \`${word}\`${this.stderr ? ": " + this.stderr.trim().split("\n").pop() : ""}` : `no \`${word}\` within ${ms} ms`);
    return i;
  }

  /** waits for the process to end; throws if it has not within `ms` */
  async exit(ms: number): Promise<number | null> {
    if (!(await this.until(() => this.code !== undefined, ms))) throw new Error(`still running ${ms} ms later`);
    return this.code!;
  }

  kill(): void {
    if (this.code === undefined) this.child.kill("SIGKILL");
  }

  /** everything the run printed: stdout, then stderr, where some engines print their bench summary */
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
const module = argv[0];
if (!module) throw new Error("usage: wasi-check.ts <build.wasm> [--profile polls|deaf] [--bench <nodes>] [--bench-args <args>] [--only <check>]");

const profile = asked ?? profileOf(readFileSync(module));

/** starts the module and takes it through `uci` and `isready` */
async function start(): Promise<Run> {
  const run = new Run(module);
  run.send("uci");
  await run.expect("uciok", START_MS);
  run.send("isready");
  await run.expect("readyok", START_MS);
  return run;
}

/** sends `quit` and waits for the end */
async function quit(run: Run): Promise<void> {
  run.send("quit");
  await run.exit(HEAR_MS);
}

/** a position with one legal move, a mate: an unbounded search of it ends by itself and must then wait for `stop` */
const MATE_IN_ONE = "position fen k7/8/1K6/8/8/8/8/7R w - - 0 1";

/** a bench from the command line reaches its node count whether stdin has ended or not */
async function bench(): Promise<string> {
  if (!benchNodes) return "skipped: no --bench";
  for (const open of [false, true]) {
    const run = new Run(module, benchArgs);
    if (!open) run.end();
    await run.exit(30 * 60 * 1000);
    if (!new RegExp(`(^|\\D)${benchNodes}(\\D|$)`).test(run.output())) throw new Error(`no ${benchNodes} in the bench output with stdin ${open ? "open" : "at its end"}: ${run.output().trim().split("\n").slice(-2).join(" | ")}`);
    run.end();
  }
  return `${benchNodes} nodes with stdin at its end and open`;
}

/** a bounded search long enough that the lines after it arrive while it runs, on most engines */
const DEAF_GO = "go depth 10";

/** the deaf profile's checks; the `stop` and unbounded `go` they send are for the host to answer */
const deafChecks: Record<string, () => Promise<string | void>> = {
  /** a bounded search ends by itself, and the module answers after it */
  async bounded() {
    const run = await start();
    const from = run.lines.length;
    const at = run.send("position startpos", DEAF_GO);
    const i = await run.expect("bestmove", START_MS);
    run.send("isready");
    await run.expect("readyok", HEAR_MS, from);
    await quit(run);
    return `bestmove after ${Math.round(run.lines[i].at - at)} ms`;
  },

  /** lines sent during a search are handled after it, in order, and none is lost */
  async order() {
    const run = await start();
    const from = run.lines.length;
    run.send("position startpos", DEAF_GO, "position startpos moves e2e4", "isready", "go depth 1");
    const best = await run.expect("bestmove", START_MS);
    const ready = await run.expect("readyok", HEAR_MS, from);
    if (ready < best) throw new Error("readyok came before the bestmove of the search sent ahead of it");
    const next = await run.expect("bestmove", HEAR_MS, best + 1);
    const move = run.lines[next].text.split(" ")[1];
    await quit(run);
    if (!/^[a-h][78]/.test(move)) throw new Error(`the queued \`position\` was lost: after 1. e4 the module played ${move}`);
    return `bestmove, readyok, then the queued position's reply ${move}`;
  },

  /** at the end of input the search finishes, prints its bestmove, and the module exits */
  async eof() {
    const run = new Run(module);
    run.send("uci", "position startpos", DEAF_GO);
    run.end();
    await run.expect("bestmove", START_MS);
    const code = await run.exit(HEAR_MS);
    if (code !== 0) throw new Error(`exit code ${code}`);
    return "bestmove, then exit 0";
  },

  /** `quit` between searches ends the module */
  async quit() {
    const run = await start();
    run.send("position startpos", "go depth 4");
    await run.expect("bestmove", START_MS);
    await quit(run);
    return "exit after quit";
  },

  /** the host keeps a `stop` from the module, during a search and between searches */
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

  /** the host refuses an unbounded `go` with a null move, and the module goes on */
  async infinite() {
    const run = await start();
    const from = run.lines.length;
    run.send("position startpos", "go infinite");
    const i = await run.expect("bestmove", HEAR_MS);
    if (run.lines[i].text !== "bestmove 0000") throw new Error(`\`go infinite\` was not refused: ${run.lines[i].text}`);
    run.send("isready");
    await run.expect("readyok", HEAR_MS, from);
    await quit(run);
    return "bestmove 0000, then readyok";
  },

  bench,
};

const pollsChecks: Record<string, () => Promise<string | void>> = {
  /** `stop` ends an unbounded search */
  async stop() {
    const run = await start();
    run.send("position startpos", "go infinite");
    await sleep(SEARCH_MS);
    if (run.find("bestmove") >= 0) throw new Error("`go infinite` printed a bestmove before `stop`");
    const at = run.send("stop");
    const i = await run.expect("bestmove", HEAR_MS);
    await quit(run);
    return `bestmove ${Math.round(run.lines[i].at - at)} ms after stop`;
  },

  /** `isready` is answered during a search */
  async isready() {
    const run = await start();
    const from = run.lines.length;
    run.send("position startpos", "go infinite");
    await sleep(SEARCH_MS);
    const at = run.send("isready");
    const i = await run.expect("readyok", HEAR_MS, from);
    if (run.find("bestmove") >= 0) throw new Error("the search ended before `stop`");
    run.send("stop");
    await run.expect("bestmove", HEAR_MS);
    await quit(run);
    return `readyok ${Math.round(run.lines[i].at - at)} ms after isready`;
  },

  /** a line the search cannot act on waits its turn, and an `isready` behind it waits too */
  async order() {
    const run = await start();
    const from = run.lines.length;
    run.send("position startpos", "go infinite");
    await sleep(SEARCH_MS);
    run.send("position startpos moves e2e4", "isready");
    await sleep(SEARCH_MS);
    if (run.find("readyok", from) >= 0) throw new Error("`isready` was answered ahead of the `position` line queued before it");
    run.send("stop");
    const best = await run.expect("bestmove", HEAR_MS);
    const ready = await run.expect("readyok", HEAR_MS, from);
    if (ready < best) throw new Error("readyok came before the bestmove");
    run.send("go depth 1");
    const next = await run.expect("bestmove", HEAR_MS, best + 1);
    const move = run.lines[next].text.split(" ")[1];
    await quit(run);
    if (!/^[a-h][78]/.test(move)) throw new Error(`the queued \`position\` was lost: after 1. e4 the module played ${move}`);
    return `queued position applied, reply ${move}`;
  },

  /**
   * At the end of input a bounded search finishes, prints its bestmove, and the
   * module exits. The same lines go to a module whose stdin stays open, and the
   * search that sees the end of input must take about as long: how much of a
   * movetime an engine uses is its own.
   */
  async "eof-bounded"() {
    const lines = ["uci", "position startpos", "go movetime 1500"];
    const open = new Run(module);
    let at = open.send(...lines);
    const openMs = open.lines[await open.expect("bestmove", START_MS)].at - at;
    await quit(open);
    const run = new Run(module);
    at = run.send(...lines);
    run.end();
    const ms = run.lines[await run.expect("bestmove", START_MS)].at - at;
    const code = await run.exit(HEAR_MS);
    if (ms < 0.7 * openMs) throw new Error(`the search ended ${Math.round(ms)} ms in, against ${Math.round(openMs)} ms with stdin open: cut short by the end of input`);
    if (code !== 0) throw new Error(`exit code ${code}`);
    return `bestmove after ${Math.round(ms)} ms, against ${Math.round(openMs)} ms with stdin open, then exit 0`;
  },

  /** at the end of input an unbounded search ends as on `stop`, and the module exits */
  async "eof-unbounded"() {
    const run = await start();
    run.send("position startpos", "go infinite");
    await sleep(SEARCH_MS);
    const at = performance.now();
    run.end();
    const i = await run.expect("bestmove", HEAR_MS);
    const code = await run.exit(HEAR_MS);
    if (code !== 0) throw new Error(`exit code ${code}`);
    return `bestmove ${Math.round(run.lines[i].at - at)} ms after the end of input, then exit 0`;
  },

  /** the end of input that arrives with the `go` line itself still gets a bestmove */
  async "eof-with-go"() {
    const run = new Run(module);
    run.send("uci", "position startpos", "go infinite");
    run.end();
    await run.expect("bestmove", START_MS);
    const code = await run.exit(HEAR_MS);
    if (code !== 0) throw new Error(`exit code ${code}`);
    return "bestmove, then exit 0";
  },

  /** `quit` during a search ends the module */
  async quit() {
    const run = await start();
    run.send("position startpos", "go infinite");
    await sleep(SEARCH_MS);
    const at = run.send("quit");
    const code = await run.exit(HEAR_MS);
    if (code !== 0) throw new Error(`exit code ${code}`);
    return `exit ${Math.round(performance.now() - at)} ms after quit${run.find("bestmove") >= 0 ? ", with a bestmove" : ", with no bestmove"}`;
  },

  /** an unbounded search that ends by itself still hears `isready` and `stop` */
  async wait() {
    const run = await start();
    const from = run.lines.length;
    run.send(MATE_IN_ONE, "go infinite");
    await sleep(4 * SEARCH_MS);
    const early = run.find("bestmove") >= 0;
    run.send("isready");
    await run.expect("readyok", HEAR_MS, from);
    run.send("stop");
    await run.expect("bestmove", HEAR_MS);
    await quit(run);
    return early ? "the module printed its bestmove before `stop`" : "bestmove held until `stop`";
  },

  /** a ponder search holds its bestmove until `ponderhit`, then plays on its clock */
  async ponder() {
    const run = await start();
    if (!run.lines.some((l) => /^option name Ponder /i.test(l.text))) {
      await quit(run);
      return "skipped: no Ponder option";
    }
    run.send("setoption name Ponder value true", "position startpos moves e2e4 e7e5", "go ponder wtime 3000 btime 3000");
    await sleep(1000);
    if (run.find("bestmove") >= 0) throw new Error("a ponder search printed its bestmove before `ponderhit`");
    const at = run.send("ponderhit");
    const i = await run.expect("bestmove", 3000 + HEAR_MS);
    run.send("position startpos", "go ponder wtime 3000 btime 3000");
    await sleep(SEARCH_MS);
    run.send("stop");
    await run.expect("bestmove", HEAR_MS, i + 1);
    await quit(run);
    return `bestmove ${Math.round(run.lines[i].at - at)} ms after ponderhit; stop ends a ponder search`;
  },

  bench,
};

let failed = 0;
for (const [name, check] of Object.entries(profile === "deaf" ? deafChecks : pollsChecks)) {
  if (only && only !== name) continue;
  try {
    console.log(`pass  ${name}: ${(await check()) ?? ""}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}: ${(e as Error).message}`);
  }
}
process.exit(failed ? 1 : 0);
