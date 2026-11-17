# The poll helper: porting an engine to UCI over WASI

`docs/uci-over-wasi.md` states what a module must do. This file is the how-to: how an existing engine becomes
a module that meets it. The helper is one file per language, under the MIT License, so an engine under any
license can link it.

## Which engines need it

| the engine | what the port needs |
|---|---|
| reads its input from inside its search, through `select`, `poll` or `ioctl(FIONREAD)` | no helper: wasi-libc builds all three on `poll_oneoff`. Its own code must then meet the end-of-input and `isready` rules, and pass the check. |
| has an input thread and a stop flag | the helper: a module has one thread |
| runs its search in a goroutine | the helper: with one thread and no preemption, the search runs only while the UCI loop is blocked |
| reads nothing during a search | no helper, and the deaf profile (§ A deaf engine) |

## The three calls

The helper owns standard input, and nothing else in the engine reads fd 0. A buffered reader takes bytes
ahead, so it hides a waiting line from the poll.

| C and C++ | Rust | Go | does |
|---|---|---|---|
| `uci_getline()` | `getline()` | `Getline()` | the next line: one queued during a search first, else it waits for one; none at the end of input |
| `uci_poll(unbounded)` | `poll(unbounded)` | `Poll(unbounded)` | handles the input that waits now, without waiting; returns what it heard |
| `uci_wait()` | `wait()` | `Wait()` | waits for input or its end, then handles it as a poll of an unbounded search does |

A poll and a wait return bits: stop, quit and ponderhit. They answer `isready` themselves, and they queue
every other line in order for the UCI loop. Every line comes without its line feed, and without a carriage
return before it. Each file's header has the rules in full.

## Porting a thread engine

1. **Run the search on the UCI thread.** Where `go` started or woke a search thread, call the search.
2. **Read the UCI loop's lines through the helper's line read.**
3. **Poll from the engine's periodic check,** the one that reads the clock every so many nodes. Map the
   result to what the engine's own UCI loop does for `stop` and `ponderhit`.
4. **Pass `unbounded` correctly.** It is true for `go infinite`, while pondering, and for a `go` with no limit
   the engine acts on. The helper then ends the search at the end of input, and leaves a bounded one alone.
5. **Replace each busy-wait with the helper's wait.** A finished `go infinite` or ponder search waits there
   for its `stop`.
6. **Remove every other thread start, or make it inline:** helper threads, a threaded hash clear, timers.
7. **Cap the options.** `Threads` has a maximum of 1. `Hash` has a maximum the module can allocate; Ratchet's
   ports use 1024 MB.
8. **Keep the patch small.** Put each edit under the language's guard for the target, with a comment that
   says why.

## Building

| language | build | notes |
|---|---|---|
| C, C++ | wasi-sdk's clang with `--target=wasm32-wasip1`; link the helper's object | Link with `-Wl,--wrap=pthread_create`. Set the stack with `-Wl,-z,stack-size=<bytes>`. |
| Rust | `cargo build --release --target wasm32-wasip1`; copy `uci_wasi.rs` into the crate as a module | Set the stack with `-Clink-arg=-zstack-size=<bytes>`. `-Ctarget-feature=+simd128` turns on SIMD. |
| Go | `GOOS=wasip1 GOARCH=wasm go build`; copy `uci_wasi.go` into the tree as a package | Nothing traps a `go` statement the port missed; such a goroutine never runs. |

- **`--wrap=pthread_create`** sends every thread start to a function in the C helper that prints a message
  and traps. A thread start the port missed then fails loudly. Without it, wasi-libc's `pthread_create`
  returns an error that an engine may ignore.
- **The stack.** The linker's default stack is small. Give the module the size of the native search
  thread's stack.
- **`setjmp` and `longjmp`** in C need `-mllvm -wasm-enable-sjlj -mexception-handling`, and `-lsetjmp` at
  the link. The module then uses WebAssembly exception handling.
- **C++ exceptions.** Build with `-fno-exceptions` where the engine throws nothing.
- **Memory never shrinks.** Free the old hash table before allocating its replacement. In Go, also
  run the collector first.

## A deaf engine

An engine that reads nothing during a search needs no helper and no change to its input code. Its module
declares the deaf profile, so its host keeps `stop` and an unbounded `go` away from it:

```sh
printf 'profile=deaf\n' > profile.txt
llvm-objcopy --add-section=uci_over_wasi=profile.txt engine.wasm
```

## Checking a port

- **`bun tools/wasi-check.ts <module.wasm>`** checks the module's handling of input during a search.
  `--bench <nodes>` also runs the engine's bench from the command line and looks for that node count.
- **The port's node counts equal the native build's.** Compare the engine's bench, or moves and node
  counts over a position file. A difference is a bug in the port.
- **An engine whose play depends on its standard library** is the exception. `std::sort` orders equal
  scores differently under libstdc++ and libc++, so such a module differs from its native build. Its gate
  is a throwaway pair: the native and the wasm build agree once `std::stable_sort` is patched into both.
  The shipped module keeps the engine's own code.
