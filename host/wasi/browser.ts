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
 */
import { Ring, runWasi } from "./wasi.ts";

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

if (scope.name === ENGINE_THREAD) {
  scope.onmessage = async (e: MessageEvent<{ wasm: ArrayBuffer; ring: SharedArrayBuffer; args: string[] }>) => {
    const decoder = new TextDecoder();
    let partial = "";
    const write = (fd: number, bytes: Uint8Array) => {
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
    const code = await runWasi(e.data.wasm, new Ring(e.data.ring), e.data.args, write);
    scope.postMessage({ exit: code });
  };
} else if (!scope.crossOriginIsolated) {
  // without shared memory no input reaches a running search; this Worker does not run without it
  scope.onmessage = () => {};
  scope.postMessage("info string error: the page is not cross-origin isolated, so the engine cannot run (COOP same-origin, COEP require-corp)");
} else {
  const ring = new Ring();
  const encoder = new TextEncoder();
  // lines that come before the build has loaded wait in the ring
  scope.onmessage = (e: MessageEvent) => ring.push(encoder.encode(String(e.data) + "\n"));
  const script = scope.location.href.split("#")[0];
  const build = new URL(scope.location.hash.slice(1) || script.replace(/\.js$/, ".wasm"), script);
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
    const name = build.pathname.slice(build.pathname.lastIndexOf("/") + 1);
    engine.postMessage({ wasm, ring: ring.buffer, args: [name] }, [wasm]);
  })();
}
