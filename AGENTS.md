# Agent instructions

`README.md` describes the repo for its readers. This file has the terms, the layout and the working rules. Where
another text disagrees with this file, one of them is stale; correct it. A user decision newer than this file
holds until this file records it.

The user's decisions and the work's state are kept outside this repo. If the session's instructions do not say
where, ask the user.

## Terms

`docs/uci-over-wasi.md` § Terms defines **module**, **host** and **GUI**. This file adds two.

| term | meaning | not |
|---|---|---|
| **WASI build** | a WASI preview-1 command module that speaks UCI on stdin and stdout, as UCI over WASI states; the spec calls it a module | |
| **adapted engine** | another engine with the edits that make it a module of UCI over WASI; the how-to is `helper/README.md` | port, WASI port |

## Layout

- `docs/uci-over-wasi.md`: the spec. Part 1 is for a module's author, Part 2 for a host's author, and Part 3 describes the reference host.
- `docs/wasm-limits.md`: what the WebAssembly target limits.
- `helper/`: the poll helper, one file per language, its how-to, and `echo.c`, the smallest module on it.
- `host/wasi/`: the reference host: under Bun and Node (`main.ts`, `thread.ts`), in a page (`browser.ts`), the WASI calls both answer (`wasi.ts`), the feature decoder (`features.ts`), and the shared checker (`check.ts`, `check-browser.ts`, `check-worker.ts`).
- `tools/wasi-check.ts`: the CLI driver for `host/wasi/check.ts`. `tools/wasm-features.ts` prints `host/wasi/features.ts`.
- `tools/adapted.sh`: fetches, builds, compares and checks one adapted engine. Its header states the form of a folder of `adapted/`.
- `tools/meta.ts`: combines an adapted folder's `pin` and optional `meta.json` into public `<id>.meta.json` provenance metadata for GUIs (`--check`, `--all`).
- `tools/positions.ts`: a build's moves and node counts over a position file.
- `tools/toolchains.sh` and `tools/toolchains.txt`: the pinned toolchains.
- `tools/vendor.ts`: copies the host into another repo.
- `adapted/<engine>-<version>/`: one adapted engine.

```sh
bun install
bun run typecheck
tools/toolchains.sh fetch && tools/toolchains.sh unpack   # the pinned toolchains, into tmp/toolchains/
tools/adapted.sh echo                                     # the helper and the checker, on the smallest module
tools/adapted.sh fetch adapted/<folder>                   # the engine's source at its pin; needs network
tools/adapted.sh check adapted/<folder>                   # both builds, their comparison, and the checker
```

## The spec

- **Parts 1 and 2 are rules, and Part 3 is a record.** A rule binds every module or every host. Part 3 says what this repo's host does.
- **A change to a rule changes the checker in the same commit.** A rule the checker cannot check says so in the spec.
- **The published names stay.** They are the custom section `uci_over_wasi` with its keys and values, the helper's file names, and its calls `uci_getline`, `uci_poll` and `uci_wait`.
- **The helper has no dependency.** It is one file per language, which an engine copies into its tree.
- **State what has not been run.** The spec's last section lists it.

## Adapted engines

- **One folder holds one engine at one version:** `pin`, `edits.patch`, `build.sh`, and optionally `meta.json` (curated provenance and 8-15 CPW features, checked by `tools/meta.ts`). `tools/adapted.sh` states the build files' form.
- **Read the engine's license in its own source,** and write it in the pin file. The folder's files are under that license.
- **Adapt only an engine whose license permits the edits and their publication.**
- **Put every edit under the target's guard,** `#ifdef __wasi__` or `cfg(target_os = "wasi")`. Open its comment with `UCI over WASI:`.
- **Keep the edits small.** Change how the search hears input, and what a module cannot have. Change nothing else.
- **The module plays the native build's search.** Their node counts are equal. A difference is a bug in the edits.
- **Never weaken a comparison or a check to pass an engine.** Report the engine that cannot pass, with the output.
- **A patch belongs to one version.** Do not expect one version's edits to apply to the next.
- **A build script names no machine path.** It uses what `tools/adapted.sh` exports.
- **The native build does not depend on the machine's processor.** Give it a fixed architecture.

## Running tools

- **Handle an engine's code only inside a container,** because it is an untrusted download. Never run its binary on the host.
- **`tools/adapted.sh fetch` is the one step with network,** and it runs no downloaded code. A build runs without network.
- **A CI job builds on one CPU,** because its runner shares a host with other work. `JOBS` is 1 unless a caller sets it.
- **Add adapted engines to main a few at a time.** CI builds each changed folder twice.
- **Run state goes in the gitignored `tmp/`.**

## Copies in other repos

- **Another repo takes the host as a copy at a recorded commit.** `bun tools/vendor.ts <folder>` writes the copy and its `README.md`.
- **Fix the host here, then copy it again.** Never edit a copy.

## License

- **Everything outside `adapted/` is under the MIT License,** the spec included. `LICENSE` has the text.
- **A folder of `adapted/` is under its engine's license.** `adapted/COPYING` has the text of the GNU General Public License, version 3.
- **A new file of the host, the checker or the helper opens with the SPDX line and the copyright line.**
