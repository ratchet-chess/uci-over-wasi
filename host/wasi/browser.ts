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
 *    require-corp, as web/serve.ts sends). A search blocks the thread that runs
 *    it, so this script runs twice. The Worker the page makes receives the page's
 *    lines and writes them into a ring (wasi.ts Ring). A nested worker, made from
 *    this same script and named ENGINE_THREAD, runs the build and reads the ring.
 * 2. Suspending the build (suspended, below), on any other page whose browser has
 *    JavaScript Promise Integration. One thread runs the build and receives the
 *    page's lines; the build's reads and polls suspend it so those lines arrive
 *    (wasi.ts runSuspending).
 * 3. The degraded mode (degraded, below), the last resort: no input reaches a
 *    running build, so each `go` runs a fresh instance of it.
 *
 * A build that declares itself deaf (wasi.ts profileOf) never gets a `stop` or an
 * unbounded `go` under the first two: the Worker answers those itself.
 */
import { DEAF_REFUSAL, Queue, Ring, Script, canSuspend, profileOf, runModule, runSuspending, runWasi, unheard } from "./wasi.ts";

const ENGINE_THREAD = "uci-over-wasi-engine";

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
  const decoder = new TextDecoder();
  let partial = "";
  let dropping = afterUciok;
  return (fd, bytes) => {
    const text = decoder.decode(bytes, { stream: true });
    if (fd === 2) {
      console.error(text);
      return;
    }
    partial += text;
    for (let nl = partial.indexOf("\n"); nl >= 0; nl = partial.indexOf("\n")) {
      const line = partial.slice(0, nl);
      partial = partial.slice(nl + 1);
      if (!dropping) scope.postMessage(line);
      else if (line.trim() === "uciok") dropping = false;
    }
  };
}

const script = scope.location.href.split("#")[0];
const build = new URL(scope.location.hash.slice(1) || script.replace(/\.js$/, ".wasm"), script);
const buildName = build.pathname.slice(build.pathname.lastIndexOf("/") + 1);

/**
 * The build's bytes. A missing build must fail here: fetch resolves on a 404, and a dev server may
 * answer a missing file with its page, so neither status nor bytes can be passed on unchecked.
 */
async function fetchBuild(): Promise<ArrayBuffer> {
  const res = await fetch(build);
  if (!res.ok) throw new Error(`${buildName}: ${res.status} ${res.statusText}`);
  const wasm = await res.arrayBuffer();
  if (!WebAssembly.validate(wasm)) throw new Error(`${buildName} is not a WebAssembly module`);
  return wasm;
}

/**
 * Takes the page's lines for a build that hears its input, and gives each to
 * `push` as bytes. Lines that come before the build has loaded wait. Call the
 * returned function with the build's bytes once they are there: a deaf build's
 * `stop` and unbounded `go` are then answered here and never pushed.
 */
function feed(push: (bytes: Uint8Array) => void): (wasm: ArrayBuffer) => void {
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
  return (wasm) => {
    deaf = profileOf(new Uint8Array(wasm)) === "deaf";
    for (const line of early!) pass(line);
    early = undefined;
  };
}

/**
 * The build on this thread, suspended whenever it waits for input, for a page
 * without shared memory whose browser has JavaScript Promise Integration. The
 * page gets what it gets through the ring: the instance lives for the whole
 * session, and a `stop`, an `isready` or a `ponderhit` reaches a running search.
 */
async function suspended(): Promise<void> {
  const queue = new Queue();
  const loaded = feed((bytes) => queue.push(bytes));
  try {
    const wasm = await fetchBuild();
    const module = await WebAssembly.compile(wasm);
    loaded(wasm);
    await runSuspending(module, queue, [buildName], lineWriter());
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
  /** lines that came before the build had compiled */
  const early: string[] = [];

  /** one fresh instance, given `uci`, the session's lines and then `line` */
  const run = (line: string) => {
    const first = line.trim() === "uci";
    const input = [...(first ? [] : ["uci", ...options, position]), line].filter((l) => l !== "").join("\n") + "\n";
    try {
      runModule(module!, new Script(encoder.encode(input)), [buildName], lineWriter(!first));
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
    const wasm = await fetchBuild();
    // every build is run as a deaf one here, but a profile this host does not know is still not run
    profileOf(new Uint8Array(wasm));
    module = await WebAssembly.compile(wasm);
  } catch (e) {
    scope.postMessage(`info string error: ${e}`);
    scope.close();
    return;
  }
  for (const line of early.splice(0)) handle(line);
}

if (scope.name === ENGINE_THREAD) {
  scope.onmessage = async (e: MessageEvent<{ wasm: ArrayBuffer; ring: SharedArrayBuffer; args: string[] }>) => {
    // a build that does not compile or traps must still end the session, or the page waits forever
    let code = 1;
    try {
      code = await runWasi(e.data.wasm, new Ring(e.data.ring), e.data.args, lineWriter());
    } catch (err) {
      scope.postMessage(`info string error: ${err}`);
    }
    scope.postMessage({ exit: code });
  };
} else if (!scope.crossOriginIsolated) {
  if (canSuspend()) void suspended();
  else void degraded();
} else {
  const ring = new Ring();
  const loaded = feed((bytes) => ring.push(bytes));
  const engine = new Worker(script, { name: ENGINE_THREAD });
  engine.onmessage = (e: MessageEvent<string | { exit: number }>) => {
    if (typeof e.data === "string") scope.postMessage(e.data);
    else {
      engine.terminate();
      scope.close();
    }
  };
  // a classic worker script has no top-level await
  void (async () => {
    try {
      const wasm = await fetchBuild();
      loaded(wasm);
      engine.postMessage({ wasm, ring: ring.buffer, args: [buildName] }, [wasm]);
    } catch (e) {
      scope.postMessage(`info string error: ${e}`);
      engine.terminate();
      scope.close();
    }
  })();
}
