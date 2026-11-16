/**
 * UCI over WASI in a browser: a Worker with stockfish.js's interface. Each
 * message to it is one UCI line; each message from it is one line of output.
 *
 *   const engine = new Worker("ratchet.js");
 *   engine.onmessage = (e) => console.log(e.data);
 *   engine.postMessage("uci");
 *
 * It loads the WASI build named like its script (ratchet.js loads ratchet.wasm
 * beside it), or the one its URL's hash names (`new Worker("ratchet.js#other.wasm")`),
 * so it runs any WASI build that speaks UCI.
 *
 * A search blocks the thread that runs it, so this script runs twice. The Worker
 * the page makes receives the page's lines and writes them into a ring in shared
 * memory (wasi.ts Ring). A nested worker, made from this same script and named
 * ENGINE_THREAD, runs the build and reads the ring, so a `stop` reaches a running
 * search. Shared memory needs a cross-origin isolated page: COOP same-origin and
 * COEP require-corp, as web/serve.ts sends.
 *
 * On a page that is not cross-origin isolated the Worker runs in a degraded mode
 * (degraded, below): no input reaches a running build, so each `go` runs a fresh
 * instance of it.
 */
import { Ring, Script, runModule, runWasi } from "./wasi.ts";

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

/** a build's fd_write: posts each whole line of its stdout as one message, and sends its stderr to the console */
function lineWriter(): (fd: number, bytes: Uint8Array) => void {
  const decoder = new TextDecoder();
  let partial = "";
  return (fd, bytes) => {
    const text = decoder.decode(bytes, { stream: true });
    if (fd === 2) {
      console.error(text);
      return;
    }
    partial += text;
    for (let nl = partial.indexOf("\n"); nl >= 0; nl = partial.indexOf("\n")) {
      scope.postMessage(partial.slice(0, nl));
      partial = partial.slice(nl + 1);
    }
  };
}

const script = scope.location.href.split("#")[0];
const build = new URL(scope.location.hash.slice(1) || script.replace(/\.js$/, ".wasm"), script);
const buildName = build.pathname.slice(build.pathname.lastIndexOf("/") + 1);

/**
 * The degraded mode, for a page without shared memory. A build's read of stdin
 * cannot wait for the page's next line there, so the build cannot stay loaded
 * between commands. This Worker keeps the session instead: it stores the
 * `setoption` and `position` lines, and runs a fresh instance for each `go`, fed
 * the stored lines, the `go`, then the end of input, at which a build finishes
 * its search, prints its bestmove and exits.
 *
 * What a page loses: a search hears nothing, so `stop` takes effect when the
 * search ends, and `go infinite` and `go ponder` are refused; the hash table is
 * not kept from one `go` to the next; a build's start is paid on every `go`,
 * inside the move's time. The page's hard stop is Worker.terminate().
 */
async function degraded(): Promise<void> {
  const encoder = new TextEncoder();
  /** the session's `setoption` and `debug` lines, in order, and its last `position` line */
  const options: string[] = [];
  let position = "";
  let module: WebAssembly.Module | undefined;
  /** lines that came before the build had compiled */
  const early: string[] = [];

  /** one fresh instance, given the session's lines and then `line` */
  const run = (line: string) => {
    const input = [...options, position, line].filter((l) => l !== "").join("\n") + "\n";
    try {
      runModule(module!, new Script(encoder.encode(input)), [buildName], lineWriter());
    } catch (e) {
      scope.postMessage(`info string error: ${e}`);
    }
  };
  const handle = (line: string) => {
    const words = line.trim().split(/\s+/);
    if (words[0] === "isready") scope.postMessage("readyok");
    else if (words[0] === "setoption" || words[0] === "debug") options.push(line);
    else if (words[0] === "position") position = line;
    // every instance is new, and a search has ended by the time its stop is read
    else if (words[0] === "ucinewgame" || words[0] === "stop" || words[0] === "ponderhit" || words[0] === "") return;
    else if (words[0] === "quit") scope.close();
    else if (words[0] === "go" && (words.includes("infinite") || words.includes("ponder"))) {
      // the search could never hear its stop; the null move keeps a page that waits for a bestmove going
      scope.postMessage(`info string error: ${words.includes("ponder") ? "go ponder" : "go infinite"} needs a cross-origin isolated page`);
      scope.postMessage("bestmove 0000");
    } else run(line);
  };
  scope.onmessage = (e: MessageEvent) => {
    if (module) handle(String(e.data));
    else early.push(String(e.data));
  };
  scope.postMessage("info string the page is not cross-origin isolated (COOP same-origin, COEP require-corp): stop is heard when a search ends, and the hash table is not kept between searches");
  module = await WebAssembly.compileStreaming(fetch(build)).catch(async () => WebAssembly.compile(await (await fetch(build)).arrayBuffer()));
  for (const line of early.splice(0)) handle(line);
}

if (scope.name === ENGINE_THREAD) {
  scope.onmessage = async (e: MessageEvent<{ wasm: ArrayBuffer; ring: SharedArrayBuffer; args: string[] }>) => {
    const code = await runWasi(e.data.wasm, new Ring(e.data.ring), e.data.args, lineWriter());
    scope.postMessage({ exit: code });
  };
} else if (!scope.crossOriginIsolated) {
  void degraded();
} else {
  const ring = new Ring();
  const encoder = new TextEncoder();
  // lines that come before the build has loaded wait in the ring
  scope.onmessage = (e: MessageEvent) => ring.push(encoder.encode(String(e.data) + "\n"));
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
    const wasm = await (await fetch(build)).arrayBuffer();
    engine.postMessage({ wasm, ring: ring.buffer, args: [buildName] }, [wasm]);
  })();
}
