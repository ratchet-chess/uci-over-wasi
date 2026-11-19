# UCI over WASI

**UCI over WASI** is a way to build a chess engine as one WebAssembly file. The file is a WASI preview-1 command
module. It speaks UCI on standard input and standard output, as a native engine does. So one file plays in a web
page, under Bun or Node, and in any other program that hosts WASI. No engine brings glue code of its own.

No standard exists in the field. This repo holds one reading of how the two fit together, the code that goes with
it, and engines adapted to it. Other engines and other hosts may adopt it.

The repo is developed with AI coding agents throughout. The user directs the work. The agents write the text and
the code, and run the checks. `AGENTS.md` holds the rules they work under.

**Status:** in development. The spec began in the Ratchet chess engine, which is written for it. § What has not
been run, in the spec, lists what is untested.

**License:** everything outside `adapted/` is under the MIT License, the spec included. See `LICENSE`. Each folder
of `adapted/` holds edits to another engine's code, under that engine's license. Most of those engines are under the GNU
General Public License, version 3, and `adapted/COPYING` has its text.

## What is here

| Path | Holds |
|---|---|
| `docs/uci-over-wasi.md` | The spec: what a module must do, and what a host must answer and deliver |
| `docs/wasm-limits.md` | What the WebAssembly target limits, for an engine written for it and for an adapted engine |
| `helper/` | The poll helper, in C, Rust and Go, and the how-to for adapting an engine |
| `host/wasi/` | The reference host, under Bun and Node and in a page |
| `tools/wasi-check.ts` | The checker: a module's handling of input during a search |
| `adapted/` | Adapted engines, each a pin file, a patch and a build script |

## For an engine's author

* **An engine written for the target** follows Part 1 of the spec. Its search polls standard input, and it relies
  only on the seven WASI calls the spec lists.
* **An existing engine** is adapted. `helper/README.md` is the how-to. An engine whose search has an input thread
  links the poll helper, and its periodic time check calls it. An engine that reads nothing during a search
  needs no helper: its module declares the deaf profile.
* **Check the module:**

```sh
bun install
bun tools/wasi-check.ts <module.wasm> [--bench <nodes>]
```

## For a host's author

Part 2 of the spec states what a host answers, and three ways to deliver input to a running search. The
reference host is one implementation:

```sh
bun host/wasi/main.ts <module.wasm>          # UCI on standard input and output
bun host/wasi/main.ts <module.wasm> bench    # the arguments after the module are its own
```

`host/wasi/browser.ts` is a Worker script with stockfish.js's interface. Each message to it is one UCI line, and
each message from it is one line of the module's output.

Another repo takes the host as a copy: `bun tools/vendor.ts <folder>` writes the files and names their commit.

## Adapted engines

An adapted engine is another engine with the edits that make it a module. Each folder of `adapted/` holds one
engine at one version:

* **`pin`:** the engine's public repo, the commit, its license, and how the two builds are compared.
* **`edits.patch`:** the edits. Each one is under the target's guard, with a comment that opens `UCI over WASI:`.
* **`build.sh`:** builds the native engine and the module from the same tree.

The module must play the native build's search. Where the native build has a node count that repeats, the two
counts are compared. Where it has none, their moves and node counts are compared over a position file.

```sh
tools/toolchains.sh fetch && tools/toolchains.sh unpack   # wasi-sdk, Rust and Go, as tools/toolchains.txt pins them
tools/adapted.sh fetch adapted/<folder>                   # the engine's source at its pin
tools/adapted.sh check adapted/<folder>                   # both builds, their comparison, and the checker
```

An engine's code is an untrusted download, so run these inside a container. An author with their own toolchains
sets `WASI_SDK` and skips the first line.

The folders here are examples for the how-to. They cover C, C++, Rust and Go, engines on the poll helper, and
the deaf profile.

## Requests

* **To ask for an adaptation,** open an issue with the "Request an adaptation" form. The engine needs a public
  repo and a license that permits the edits.
* **To add an adapted engine,** open a pull request with its folder, and an issue with the "Request to add" form.
  CI builds the native engine and the module from the pinned commit, compares them, and runs the checker.

CI checks an adaptation. It does not write one, and it plays no rating or speed run.

## Credits

* [UCI](https://www.shredderchess.com/chess-features/uci-universal-chess-interface.html), by Stefan Meyer-Kahlen
  and Rudolf Huber, and [WASI](https://wasi.dev): the two standards this repo joins.
* [wasi-sdk](https://github.com/WebAssembly/wasi-sdk): the compiler for C and C++ modules.
* [stockfish.js](https://github.com/nmrugg/stockfish.js): the Worker interface the page host follows.
* The authors of the adapted engines. Each pin file names its engine, its author and its repo.

If you see a problem with a credit or a license, please open an issue.
