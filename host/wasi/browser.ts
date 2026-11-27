// SPDX-License-Identifier: MIT
// Copyright (c) 2026 the uci-over-wasi contributors. The license's text is in LICENSE.
/**
 * UCI over WASI in a browser: a Worker with stockfish.js's interface. Each
 * message to it is one UCI line; each message from it is one line of output.
 *
 *   const engine = new Worker("engine.js");
 *   engine.onmessage = (e) => console.log(e.data);
 *   engine.postMessage("uci");
 *
 * It loads the WASI build named like its script (engine.js loads engine.wasm
 * beside it), or the one its URL's hash names (`new Worker("engine.js#other.wasm")`),
 * so it runs any WASI build that speaks UCI.
 *
 * A `stop` must reach a running search, and the Worker has three ways to deliver
 * it. It takes the first the page and the browser allow.
 *
 * 1. Shared memory, on a cross-origin isolated page (COOP same-origin and COEP
 *    require-corp, sent by the page's host). A search blocks the thread that runs
 *    it, so this script runs twice. The Worker the page makes receives the page's
 *    lines and writes them into a ring (wasi.ts Ring). A nested worker, made from
 *    this same script and named ENGINE_THREAD, runs the build and reads the ring.
 *    A wasi-threads build's threads are nested workers too, named SPAWNED_THREAD.
 *    The outer Worker starts each one, because it never blocks: a browser may
 *    hold back a Worker whose creator then blocks.
 * 2. Suspending the build (suspended, below), on any other page whose browser has
 *    JavaScript Promise Integration. One thread runs the build and receives the
 *    page's lines; the build's reads and polls suspend it so those lines arrive
 *    (wasi.ts runSuspending).
 * 3. The degraded mode (degraded, below), the last resort: no input reaches a
 *    running build, so each `go` runs a fresh instance of it.
 *
 * A build that declares itself deaf (wasi.ts declarationOf) never gets a `stop` or an
 * unbounded `go` under the first two: the Worker answers those itself. Under the
 * last two, a wasi-threads build plays on one thread, and one that requires
 * threads is refused: its memory cannot reach a second worker.
 */
import { DEAF_REFUSAL, NO_SPAWN, Queue, Ring, Script, canSuspend, declarationOf, nextThreadId, refusal, runModule, runSuspending, runThread, sharedMemory, unheard, unthreaded, type Profile } from "./wasi.ts";

/** the names of the nested workers this script runs as: the engine's thread, and a thread the engine spawned */
const ENGINE_THREAD = "uci-over-wasi-engine";
const SPAWNED_THREAD = "uci-over-wasi-thread";

/** what the outer Worker posts a nested worker to run: the engine, or with `tid` one thread the engine spawned */
type Start = {
  module: WebAssembly.Module;
  /** a wasi-threads module's shared memory; undefined for a module without one */
  memory?: WebAssembly.Memory;
  ring: SharedArrayBuffer;
  args: string[];
  /** slot 0: the last thread id given (wasi.ts nextThreadId) */
  ids: SharedArrayBuffer;
  /** the monotonic clock's zero, the same for every thread */
  origin: number;
  tid?: number;
  arg?: number;
};
/** what a nested worker posts the outer Worker: a line of output, a spawn to start, a finished thread, or the module's end */
type Note = string | { spawn: number; arg: number } | { exit: number } | { done: true };

/** the parts of a dedicated worker's global scope used here; the project's TypeScript lib is the DOM's */
const scope = globalThis as unknown as {
  name: string;
  location: Location;
  crossOriginIsolated: boolean;
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
  close(): void;
};

/**
 * A build's fd_write: posts each whole line of its stdout as one message, and sends its stderr to the console.
 * With `afterUciok`, it drops the lines up to the first `uciok`: the answer to a replayed `uci`.
 */
function lineWriter(afterUciok = false): (fd: number, bytes: Uint8Array) => void {
  const out = new TextDecoder();
  const err = new TextDecoder();
  let partial = "";
  let dropping = afterUciok;
  return (fd, bytes) => {
    if (fd === 2) {
      console.error(err.decode(bytes, { stream: true }));
      return;
    }
    partial += out.decode(bytes, { stream: true });
    for (let nl = partial.indexOf("\n"); nl >= 0; nl = partial.indexOf("\n")) {
      const line = partial.slice(0, nl);
      partial = partial.slice(nl + 1);
      if (!dropping) scope.postMessage(line);
      else if (line.trim() === "uciok") dropping = false;
    }
  };
}

const script = scope.location.href.split("#")[0]!;
const scriptUrl = new URL(script);
const defaultWasm = new URL(scriptUrl.pathname.replace(/\.js$/, ".wasm"), scriptUrl).href;
const build = new URL(scope.location.hash.slice(1) || defaultWasm, script);
const buildName = build.pathname.slice(build.pathname.lastIndexOf("/") + 1);

/**
 * The build's bytes. A missing build must fail here: fetch resolves on a 404, and a dev server may
 * answer a missing file with its page, so neither status nor bytes can be passed on unchecked. A build
 * that declares a profile or a feature this host does not know, or a feature it lacks, fails here too:
 * `canSpawn` is whether this Worker starts threads.
 */
async function fetchBuild(canSpawn: boolean): Promise<{ wasm: ArrayBuffer; profile: Profile }> {
  const res = await fetch(build);
  if (!res.ok) throw new Error(`${buildName}: ${res.status} ${res.statusText}`);
  const wasm = await res.arrayBuffer();
  const declaration = declarationOf(new Uint8Array(wasm));
  const why = refusal(declaration, canSpawn);
  if (why) throw new Error(`${buildName}: ${why}`);
  if (!WebAssembly.validate(wasm)) throw new Error(`${buildName} is not a WebAssembly module`);
  return { wasm, profile: declaration.profile };
}

/**
 * Takes the page's lines for a build that hears its input, and gives each to
 * `push` as bytes. Lines that come before the build has loaded wait. Call the
 * returned function with the build's profile once it is ready: a deaf build's
 * `stop` and unbounded `go` are then answered here and never pushed.
 */
function feed(push: (bytes: Uint8Array) => void): (profile: Profile) => void {
  const encoder = new TextEncoder();
  /** lines that came before the build had loaded and its profile was known */
  let early: string[] | undefined = [];
  let deaf = false;
  const pass = (line: string) => {
    const answer = deaf ? unheard(line, DEAF_REFUSAL) : null;
    if (answer === null) push(encoder.encode(line + "\n"));
    else for (const a of answer) scope.postMessage(a);
  };
  scope.onmessage = (e: MessageEvent) => {
    if (early) early.push(String(e.data));
    else pass(String(e.data));
  };
  return (profile) => {
    deaf = profile === "deaf";
    for (const line of early!) pass(line);
    early = undefined;
  };
}

/**
 * The build on this thread, suspended whenever it waits for input, for a page
 * without shared memory whose browser has JavaScript Promise Integration. The
 * page gets what the shared-memory mode gives: the instance lives for the whole
 * session, and a `stop`, an `isready` or a `ponderhit` reaches a running search.
 */
async function suspended(): Promise<void> {
  const queue = new Queue();
  const loaded = feed((bytes) => queue.push(bytes));
  try {
    const { wasm, profile } = await fetchBuild(false);
    const module = await WebAssembly.compile(wasm);
    const threads = unthreaded(new Uint8Array(wasm));
    loaded(profile);
    await runSuspending(module, queue, [buildName], lineWriter(), threads);
  } catch (e) {
    scope.postMessage(`info string error: ${e}`);
  }
  scope.close();
}

/**
 * The degraded mode, for a page without shared memory in a browser that cannot
 * suspend a build. A build's read of stdin cannot wait for the page's next line
 * there, so the build cannot stay loaded between commands. This Worker keeps the session instead: it stores the
 * `setoption` and `position` lines, and runs a fresh instance for each `go`, fed
 * `uci`, the stored lines, the `go`, then the end of input, at which a build
 * finishes its search, prints its bestmove and exits. The replayed `uci` is there
 * because a build may take no other command before it; its answer is dropped.
 *
 * What a page loses: a search hears nothing, so `stop` takes effect when the
 * search ends, and an unbounded `go` is refused (wasi.ts unheard, as for a deaf
 * build); the hash table is not kept from one `go` to the next; a build's start
 * is paid on every `go`, inside the move's time. The page's hard stop is
 * Worker.terminate().
 */
async function degraded(): Promise<void> {
  const encoder = new TextEncoder();
  /** the session's `setoption` and `debug` lines, in order, and its last `position` line */
  const options: string[] = [];
  let position = "";
  let module: WebAssembly.Module | undefined;
  let bytes: Uint8Array | undefined;
  /** lines that came before the build had compiled */
  const early: string[] = [];

  /** one fresh instance, given `uci`, the session's lines and then `line` */
  const run = (line: string) => {
    const first = line.trim() === "uci";
    const input = [...(first ? [] : ["uci", ...options, position]), line].filter((l) => l !== "").join("\n") + "\n";
    try {
      runModule(module!, new Script(encoder.encode(input)), [buildName], lineWriter(!first), unthreaded(bytes!));
    } catch (e) {
      scope.postMessage(`info string error: ${e}`);
    }
  };
  const handle = (line: string) => {
    const words = line.trim().split(/\s+/);
    if (words[0] === "isready") scope.postMessage("readyok");
    else if (words[0] === "setoption" || words[0] === "debug") options.push(line);
    else if (words[0] === "position") position = line;
    // every instance is new
    else if (words[0] === "ucinewgame" || words[0] === "") return;
    else if (words[0] === "quit") scope.close();
    else {
      const answer = unheard(line, "needs a cross-origin isolated page, or a browser with JavaScript Promise Integration");
      if (answer === null) run(line);
      else for (const a of answer) scope.postMessage(a);
    }
  };
  scope.onmessage = (e: MessageEvent) => {
    if (module) handle(String(e.data));
    else early.push(String(e.data));
  };
  scope.postMessage("info string the page is not cross-origin isolated (COOP same-origin, COEP require-corp) and this browser has no JavaScript Promise Integration: stop is heard when a search ends, and the hash table is not kept between searches");
  try {
    // every build is run as a deaf one here; fetchBuild has refused a declaration this host cannot meet
    const { wasm } = await fetchBuild(false);
    bytes = new Uint8Array(wasm);
    module = await WebAssembly.compile(wasm);
  } catch (e) {
    scope.postMessage(`info string error: ${e}`);
    scope.close();
    return;
  }
  for (const line of early.splice(0)) handle(line);
}

if (scope.name === ENGINE_THREAD || scope.name === SPAWNED_THREAD) {
  // a nested worker: the engine, or one thread it spawned
  scope.onmessage = (e: MessageEvent<Start>) => {
    const d = e.data;
    const note = (n: Note) => scope.postMessage(n);
    let code: number | undefined = 1;
    try {
      if (!d.memory) code = runModule(d.module, new Ring(d.ring), d.args, lineWriter());
      else {
        const ids = new Int32Array(d.ids);
        // the outer Worker starts the thread; the id is the module's at once, as wasi-threads asks
        const spawn = (arg: number): number => {
          const tid = nextThreadId(ids);
          if (!tid) return NO_SPAWN(arg);
          note({ spawn: tid, arg });
          return tid;
        };
        const thread = d.tid === undefined ? undefined : { tid: d.tid, arg: d.arg! };
        code = runThread(d.module, new Ring(d.ring), d.args, lineWriter(), { memory: d.memory, spawn }, d.origin, thread);
      }
    } catch (err) {
      // a build that traps must still end the session, or the page waits forever
      note(`info string error: ${err}`);
    }
    // a spawned thread that returns ends itself alone; any other end ends the module, and every thread
    if (code !== undefined) note({ exit: code });
    else {
      note({ done: true });
      scope.close();
    }
  };
} else if (!scope.crossOriginIsolated) {
  if (canSuspend()) void suspended();
  else void degraded();
} else {
  const ring = new Ring();
  const loaded = feed((bytes) => ring.push(bytes));
  const workers = new Set<Worker>();
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    for (const w of workers) w.terminate();
    workers.clear();
    scope.close();
  };
  let base: Start | undefined;
  /** starts a nested worker, and relays what it posts */
  const start = (name: string, data: Start) => {
    const w = new Worker(script, { name });
    workers.add(w);
    w.onmessage = (e: MessageEvent<Note>) => {
      const n = e.data;
      if (typeof n === "string") scope.postMessage(n);
      else if ("done" in n) workers.delete(w);
      else if ("exit" in n) end();
      else start(SPAWNED_THREAD, { ...base!, tid: n.spawn, arg: n.arg });
    };
    w.onerror = (e) => {
      scope.postMessage(`info string error: ${e.message}`);
      end();
    };
    w.postMessage(data);
  };
  // a classic worker script has no top-level await
  void (async () => {
    try {
      const { wasm, profile } = await fetchBuild(true);
      const module = await WebAssembly.compile(wasm);
      const memory = sharedMemory(new Uint8Array(wasm));
      loaded(profile);
      base = { module, memory, ring: ring.buffer, args: [buildName], ids: new SharedArrayBuffer(4), origin: performance.timeOrigin + performance.now() };
      start(ENGINE_THREAD, base);
    } catch (e) {
      scope.postMessage(`info string error: ${e}`);
      end();
    }
  })();
}
