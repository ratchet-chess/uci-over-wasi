# UCI over WASI

UCI over WASI is a way to ship a chess engine as one WebAssembly file. The file runs unchanged in a
browser, under a JavaScript runtime, and under any other host that follows this document.

The engine speaks UCI on standard input and standard output, as a native engine does. The file is a WASI
preview-1 command, so it needs no glue code of its own.

This document is Ratchet's reading of how UCI and WASI fit together. No standard exists in the field. Other
engines and other hosts may adopt it.

- **Part 1** is for an engine's author: what a module must do, and what it may rely on.
- **Part 2** is for a host's author: what a host must answer and deliver.
- **Part 3** describes Ratchet's own hosts. It is a record of one implementation, not a rule.

`helper/README.md` is the how-to for porting an existing engine.

## Terms

| term | meaning |
|---|---|
| **module** | the engine as one WebAssembly file that meets Part 1; Ratchet's tree calls it a WASI build |
| **host** | the program that runs a module: it answers the module's imports, feeds its input and takes its output |
| **GUI** | whatever writes the UCI lines, as in UCI: a chess GUI, a match runner, a page, a person at a terminal |
| **profile** | how an engine takes input during a search: **polls**, **deaf** or **threads** |
| **polls** | the module reads its input from inside its search, so it hears `stop` |
| **deaf** | the module reads nothing during a search, so a line takes effect when the search ends |
| **unbounded** | said of a `go` that nothing ends but a `stop` (§ The unbounded `go`) |
| **poll helper** | the file in `helper/` that puts a thread engine's search on the UCI thread |

## Part 1: the module

### Form

- The module is a WASI preview-1 command. It exports `_start` and `memory`.
- It imports only from `wasi_snapshot_preview1`.
- It has one thread. It uses no thread proposal, and it starts no thread.
- It is a 32-bit module, so it addresses at most 4 GiB.
- It may use WebAssembly features beyond the first version, such as fixed-width SIMD and exception handling.
  A host runs the module only where the runtime has those features.

The host calls `_start` once. The module's whole session runs inside that call.

### Input and output

| stream | carries |
|---|---|
| fd 0, standard input | the GUI's UCI lines, each ended by a line feed |
| fd 1, standard output | the module's UCI lines, each ended by a line feed |
| fd 2, standard error | diagnostics, which no GUI reads |

- The module writes each line in full before it waits for input. A line left in a buffer never reaches the GUI.
- The module accepts a carriage return before a line feed, and ignores it. A GUI on Windows may send one.
- The command line is the module's own. The first argument is the module's name. A host passes the rest
  unchanged, so an argument such as `bench` works as it does natively.

### What a module may rely on

A module may rely on seven calls. § The seven calls states what each one answers.

| call | use |
|---|---|
| `args_sizes_get`, `args_get` | the command line |
| `clock_time_get` | the time, for the engine's clock |
| `fd_read` | input from fd 0; it waits until input arrives or ends |
| `fd_write` | output to fd 1 and fd 2 |
| `poll_oneoff` | whether input waits on fd 0, and a sleep |
| `proc_exit` | the end of the module, with an exit code |

A C library, a Rust standard library or a Go runtime imports more of preview 1 than these seven. A host gives
each other import a fixed answer (§ The fixed answers). A module that needs more than those answers does not
meet this document. In practice:

- **No file system.** A net or a book is compiled into the module, or it is off. Tablebases are off.
- **No environment.** There are no environment variables.
- **Repeatable random bytes.** `random_get` fills from a fixed seed, so two runs of a module are the same run.

### Hearing input during a search

A module with the polls profile checks its input from inside its search. The engine's own periodic check
does this, the one that reads the clock every so many nodes.

1. Call `poll_oneoff` with two subscriptions: a read of fd 0, and a clock with a relative timeout of zero.
   The clock makes the call return at once.
2. If the event says fd 0 is ready, call `fd_read` and act on the lines.

To wait without spinning, call `poll_oneoff` with the read of fd 0 alone, or call `fd_read`. Both wait
until input arrives or ends.

A host answers a read of fd 0 and clocks with relative timeouts. It answers no other subscription.

### What a module does with each line

These rules apply while a search runs. Between searches a module handles lines as UCI states.

| line | rule |
|---|---|
| `uci` | A module may expect `uci` as the first line of every session, as UCI states. |
| `stop` | The search ends and prints its `bestmove`. |
| `ponderhit` | The ponder search goes on as a normal search. |
| `isready` | The module answers `readyok` at once, but only when no earlier line still waits to be handled. |
| `quit` | The module exits as soon as possible. Whether it first prints a `bestmove` is the engine's own choice. |
| any other line | The module keeps the line, in order, and handles it after the search. |

The `isready` rule protects the GUI. A GUI reads `readyok` as proof that every earlier line was handled.
So an `isready` that arrives behind a queued `position` waits its turn.

### The end of input

The end of input means that no more input comes. It does not mean `quit`.

- A bounded search finishes and prints its `bestmove`.
- An unbounded search ends as on `stop` and prints its `bestmove`.
- Then the module exits with code 0.

Every `go` gets a `bestmove`. So a script that pipes its commands needs no pause, and a module never
hangs at the end of input. A bench from the command line runs to its end whether input is open or ended.

### The unbounded `go`

A `go` is unbounded when nothing in it ends the search. Only a `stop` ends it.

A module decides this in its own terms. A limit the engine does not act on is no bound for that engine.

- `go infinite` is unbounded.
- A ponder search is unbounded until its `ponderhit`.
- A `go` with no limit the engine acts on is unbounded. A bare `go` is always one of these.

The third case matters at the end of input. An engine alone would search such a `go` to its depth limit.

### The profile

An engine fits one of three profiles. A module declares one of the first two.

| profile | the engine | as a module |
|---|---|---|
| **polls** | reads input from inside its search | runs as it is |
| **deaf** | reads nothing during a search | runs as it is, and its host keeps from it what it could not act on |
| **threads** | has an input thread and a stop flag, or a search in a goroutine | not supported: a module has one thread. It ships as polls through the poll helper. |

A module declares its profile in a custom section named `uci_over_wasi`. The section holds lines of
`key=value`.

- `profile=deaf` declares a deaf module.
- `profile=polls`, no `profile` line, or no section declares a polls module.
- No other key exists yet.

`llvm-objcopy --add-section=uci_over_wasi=<file>` writes the section into a linked module, with no change to
the source. A deaf module needs the section: its host must keep `stop` and an unbounded `go` away from it.

### UCI options

- **`Threads`** has a maximum of 1, if the engine has the option.
- **`Hash`** has a maximum the module can allocate. Ratchet's ports cap it at 1024 MB. A table size wraps at
  4096 MB in a 32-bit module, and an allocation can fail well below that.

## Part 2: the host

### Running a module

- The host refuses a module that imports from anywhere but `wasi_snapshot_preview1`.
- It reads the module's profile (§ Reading the profile) before it runs the module.
- It calls `_start` once, with the command line the GUI gave.
- The module ends when `_start` returns, with code 0, or when it calls `proc_exit`.

### The seven calls

| call | the host answers |
|---|---|
| `args_sizes_get`, `args_get` | the command line, the module's name first |
| `clock_time_get` | clock 0: the time of day. Every other clock: a monotonic clock. Both in nanoseconds. |
| `fd_read` | on fd 0, at least one byte once input waits, or zero bytes at the end of input; it waits for either. On any other fd, `EBADF`. |
| `fd_write` | on fd 1 and fd 2, every byte, in order. On any other fd, `EBADF`. |
| `poll_oneoff` | one event: fd 0 if it has input or has ended, else the soonest clock once its timeout passes |
| `proc_exit` | the end of the module, with that exit code |

For `poll_oneoff`:

- A read of fd 0 is ready when input waits or has ended. Its event says how many bytes wait, and sets the
  hang-up flag at the end of input.
- A clock's timeout is relative. A timeout of zero makes the call return at once.
- A call with a read alone waits until input arrives or ends.
- Any other subscription gets `EINVAL`.

### The fixed answers

A host answers every other preview-1 import the same way each time.

| call | the host answers |
|---|---|
| `fd_fdstat_get` on fd 0, 1, 2 | a character device with every right |
| `fd_fdstat_get` on any other fd | `EBADF` |
| `fd_prestat_get` | `EBADF`: there are no preopened directories |
| `fd_seek` | `ESPIPE` |
| `environ_sizes_get`, `environ_get` | an empty environment |
| `random_get` | bytes from a fixed seed |
| `sched_yield` | success: one thread has nothing to yield to |
| every other call | `ENOSYS` |

### Delivering input during a search

A host delivers input to a running search. A `stop` that the GUI writes reaches a polls module's next
poll. This is the host's main duty, and how the host does it is the host's own business.

A search does not return to the host until it ends. So the host needs a way to make input appear to code
that is already running. Three ways are known.

| way | how | needs |
|---|---|---|
| a second thread | Another thread receives the input and writes it into memory both threads share. The module's thread reads it there. | shared memory; in a browser, a cross-origin isolated page |
| suspending the module | `fd_read` and `poll_oneoff` suspend the module, and the host's event loop takes the input. | a runtime with JavaScript Promise Integration |
| rewriting the module | A tool rewrites the linked module so that the host can unwind and rewind its stack (Asyncify). | a second file per module |

The first two need no change to a module. Ratchet's hosts use them (Part 3). The third is not built.

A host that suspends the module need not suspend at every poll. It gives its event loop a turn every few
milliseconds, and answers the other polls at once.

### A host that cannot deliver

This document gives no rule for a host with none of the three ways. Part 3 describes what Ratchet's
Worker does there, as one host's choice.

### A deaf module

A deaf module's host answers, in the module's place, the lines its search could not act on.

| line | the host |
|---|---|
| `stop`, `ponderhit` | drops it: the search has ended by the time the module could read it |
| an unbounded `go` | refuses it: it prints an `info string` that says why, then `bestmove 0000` |
| any other line | passes it on |

The null move keeps a GUI that waits for a `bestmove` going.

- **The refusal is printed at once.** If a search still runs, the refusal comes before that search's
  `bestmove`. A GUI sends no `go` during a search, so a GUI does not see this order.
- **A carriage return at a line's end is not part of its last word.** The host ignores it when it reads
  a line's words, as a module does. So `stop` with a carriage return is still dropped.

A host reads "unbounded" from the line's words. A `go` is unbounded when it has `infinite` or `ponder`, or
when it has none of `wtime`, `btime`, `movetime`, `depth`, `nodes`, `mate` and `perft`. Either side's clock
counts as a bound, so a host need not know the side to move.

The page's hard stop is to end the module's thread. It works under every profile.

### Reading the profile

A host reads the `uci_over_wasi` section from the module's bytes. It need not compile the module first.

- A key the host does not know is ignored.
- A `profile` value the host does not know means the host does not run the module. It could not tell what
  input the module's search takes.
- The section has no version key. A later key is compatible, because its absence means this document.

## Part 3: Ratchet's hosts

### Under Bun and Node

`host/wasi/main.ts` runs a module as a UCI engine on the command line:

```sh
bun host/wasi/main.ts build/wasi/ratchet.wasm          # UCI on standard input and output
bun host/wasi/main.ts build/wasi/ratchet.wasm bench    # the arguments after the module are its own
```

The module runs on a second thread, and standard input feeds a ring in shared memory (`Ring` in
`host/wasi/wasi.ts`). `tools/package.ts` builds a Bun executable around one module from the same code.

### In a browser

`host/wasi/browser.ts` is a Worker script with stockfish.js's interface. Each message to it is one UCI
line. Each message from it is one line of the module's output.

```js
const engine = new Worker("ratchet.js");          // loads ratchet.wasm beside it
engine.onmessage = (e) => console.log(e.data);
engine.postMessage("uci");
```

`new Worker("ratchet.js#other.wasm")` loads another module, so one script runs any module. The module's
standard error goes to the console.

The Worker delivers input in the first way the page and the browser allow.

```mermaid
flowchart TD
  start[The page creates the Worker] --> isolated{Is the page cross-origin isolated?}
  isolated -- yes --> ring[A nested worker runs the module and reads a ring in shared memory]
  isolated -- no --> jspi{Does the browser have JavaScript Promise Integration?}
  jspi -- yes --> suspended[One thread runs the module and suspends it when it waits for input]
  jspi -- no --> degraded[The degraded mode: a fresh instance for each go]
```

A page is cross-origin isolated when its server sends `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`. The first two ways give a page the same engine: the hash
table is kept, and `stop`, `isready` and `ponderhit` reach a running search.

The degraded mode is the last resort. No line reaches a running module there, and a module that waits in
`fd_read` holds the Worker's only thread. So the Worker keeps the session itself, and runs every module
as a deaf one (§ A deaf module):

- It answers `isready`.
- It stores the `setoption` and `debug` lines, and the last `position` line.
- It drops `ucinewgame`, because every instance is new.
- For every other line, such as a `go`, it runs a fresh instance. It writes `uci`, the stored lines and
  that line, then ends the input. The module finishes and exits, by § The end of input.
- It drops the answer to the `uci` it wrote.

A page loses three things there. A `stop` takes effect when the search ends. An unbounded `go` is refused.
The hash table is not kept, and each move's time includes the module's start.

### As a native executable

`host/wasi/native.c` is the host of a native build, made from a module through wasm2c. It answers the
seven calls only, so it runs Ratchet's own modules and not every module that meets this document.

### Checking a module

`tools/wasi-check.ts` runs a module under `host/wasi/` and checks the rules of Part 1.

- **For a polls module:** `stop`, `isready` and line order during a search; the end of input in each of
  its cases; `quit`; and ponder.
- **For a deaf module:** a bounded search ends by itself, and the host keeps `stop` and an unbounded `go`
  away from it.
- **For both:** a session whose lines each end with a carriage return and a line feed.

```sh
bun tools/wasi-check.ts <module.wasm> [--bench <nodes>]
```

No check exists yet for a host. A second host is checked by running modules that pass this check.

### What has not been run

- **WebKit.** No module and no Worker has run in a WebKit browser.
- **A host other than Ratchet's.** The fixed answers were chosen from what C, C++, Rust, Go and
  AssemblyScript modules call. Another language's runtime may call more.
