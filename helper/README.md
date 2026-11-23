# The poll helper: adapting an engine to UCI over WASI

`docs/uci-over-wasi.md` states what a module must do. This file is the how-to: how an existing engine becomes
a module that meets it. The helper is one file per language, under the MIT License, so an engine under any
license can link it.

## Which engines need it

| the engine | what the adapted engine needs |
|---|---|
| reads its input from inside its search, through `select`, `poll` or `ioctl(FIONREAD)` | no helper: wasi-libc builds all three on `poll_oneoff`. Its own code must then meet the end-of-input and `isready` rules, and pass the check. |
| has an input thread and a stop flag | the helper, so the module runs on every host; or no helper, and the module requires threads (§ Keeping threads) |
| runs its search in a goroutine | the helper: Go has no threads in a module, and with no preemption the search runs only while the UCI loop is blocked |
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

## Adapting a thread engine

1. **Run the search on the UCI thread.** Where `go` started or woke a search thread, call the search.
2. **Read the UCI loop's lines through the helper's line read.**
3. **Poll from the engine's periodic check,** the one that reads the clock every so many nodes. Map the
   result to what the engine's own UCI loop does for `stop` and `ponderhit`.
4. **Pass `unbounded` correctly.** It is true for `go infinite`, while pondering, and for a `go` with no limit
   the engine acts on. The helper then ends the search at the end of input, and leaves a bounded one alone.
5. **Replace each busy-wait with the helper's wait.** A finished `go infinite` or ponder search waits there
   for its `stop`.
6. **Remove every other thread start, or make it inline:** helper threads, a threaded hash clear, timers.
   A module built for threads keeps the search's helper threads above `Threads` 1 (§ Keeping threads).
7. **Cap the options.** `Threads` has a maximum of 1 in a module without threads. `Hash` has a maximum the module can allocate; the
   adapted engines in `adapted/` use 1024 MB.
8. **Keep the patch small.** Put each edit under the language's guard for the target, with a comment that
   says why.

## Building

| language | build | notes |
|---|---|---|
| C, C++ | wasi-sdk's clang with `--target=wasm32-wasip1`; link the helper's object | Link with `-Wl,--wrap=pthread_create`. Set the stack with `-Wl,-z,stack-size=<bytes>`. `-msimd128` turns on SIMD. |
| Rust | `cargo build --release --target wasm32-wasip1`; copy `uci_wasi.rs` into the crate as a module | Set the stack with `-Clink-arg=-zstack-size=<bytes>`. `-Ctarget-feature=+simd128` turns on SIMD. |
| Go | `GOOS=wasip1 GOARCH=wasm go build`; copy `uci_wasi.go` into the tree as a package | Nothing traps a `go` statement the edits missed; such a goroutine never runs. |

- **`--wrap=pthread_create`** is for the `wasm32-wasip1` target, where a module starts no thread. It sends
  every thread start to a function in the C helper that prints a message and traps. A thread start the edits missed then fails loudly. Without it, wasi-libc's `pthread_create`
  returns an error that an engine may ignore.
- **The stack.** The linker's default stack is small. Give the module the size of the native search
  thread's stack.
- **`setjmp` and `longjmp`** in C need `-mllvm -wasm-enable-sjlj -mexception-handling`, and `-lsetjmp` at
  the link. The module then uses WebAssembly exception handling, and declares `requires=exception-handling`
  (§ The declaration). The pinned wasi-sdk emits the legacy form, `try` and `catch`, which every browser has.
  `-mllvm -wasm-use-legacy-eh=false` emits the exnref form, `try_table`, which Safari has only from 18.4.
- **C++ exceptions.** Build with `-fno-exceptions` where the engine throws nothing.
- **Memory never shrinks.** Free the old hash table before allocating its replacement. In Go, also
  run the collector first.
- **A net compiled in through incbin.** incbin's assembler block has no WebAssembly form. Use C23 `#embed`
  in its place, and name the net's folder with `--embed-dir`. Rust's `include_bytes!` needs no change.
- **A net on x86 intrinsics.** wasi-sdk refuses `immintrin.h`, so the engine builds on its scalar path.
  For a faster net, write a path on `wasm_simd128.h`. Portable vector source, such as Rust's `std::simd`,
  compiles to 128-bit steps as written.
- **A net's 128-bit path needs the 128-bit weight layout.** An engine that permutes its weights for AVX2 keeps a
  separate layout for 128-bit vectors. Load that one.
- **A net compiled in has no alignment of its own.** incbin aligned it; `#embed` into a byte array does not.
  Copy the net to aligned memory, or align the array, where the engine's loader checks alignment.
- **A float layer that uses fused multiply-add stays scalar.** WebAssembly has no fused 128-bit multiply-add
  outside relaxed SIMD, whose `relaxed_madd` is not exact. Keep `fmaf` or `std::fma` on the scalar path, or the
  module's node counts differ from the native build's.
- **Check that the SIMD reached the net's hot functions,** one function at a time. A whole-module count of
  SIMD instructions misses a kernel or a float layer left scalar.
- **In a 128-bit kernel, combine lanes with shuffles,** not `extract_lane`. Test a lane for nonzero with `ne`,
  not a signed `gt`, which is wrong for negative lanes.
- **Relaxed SIMD** (`-mrelaxed-simd`) is allowed only in its exact form (`docs/uci-over-wasi.md` § Form). The
  module then declares `requires=relaxed-simd`, and its node signature must be equal on x86 and on ARM.
- **Sizes have 32 bits.** `size_t`, `long` and Rust's `usize` are 32-bit types in a module. Where a value
  needs 64 bits, name a 64-bit type. A table that is compiled in with 64-bit entries is one such place.

## Keeping threads

A module may search on several threads (`docs/uci-over-wasi.md` § Threads), in one of two forms.

1. **Threads above `Threads` 1 only, the form to choose.** Adapt the UCI loop through the poll helper, as
   above. Start the search's other threads only when `Threads` is above 1. The module declares nothing for
   threads, and plays on one thread where a host starts none.
2. **The engine's own threads at every setting.** Keep the input thread or the search thread. The module
   declares `requires=threads`, and runs only where a host starts threads. Its UCI loop still meets the
   spec's line rules, which a native thread engine often breaks: an `isready` waits behind a queued line, and
   the end of input does not end a timed search.

| language | build |
|---|---|
| C, C++ | `--target=wasm32-wasip1-threads -pthread`, for the helper's object too; link with `-Wl,--import-memory,--export-memory,--shared-memory,--max-memory=<bytes>` and no `--wrap=pthread_create` |
| Rust | `--target wasm32-wasip1-threads`; no Rust module with threads has run yet |
| Go | no threads |

- **The memory's maximum** is `--max-memory`. The largest `Hash` fits inside it, and phones refuse a large
  one (`docs/uci-over-wasi.md` § Threads).
- **A thread's stack.** `-Wl,-z,stack-size` sets the first thread's stack only. wasi-libc gives another thread
  128 KiB with no guard, so set a search thread's stack with `pthread_attr_setstacksize`.
- **`Threads` 1 plays the module's node signature.** Check it there with `--bench`, and the input during a
  search with `--threads`.

## The declaration

A module declares its profile, and each feature it uses beyond WebAssembly 2.0, in a custom section
(`docs/uci-over-wasi.md` § The declaration). Add the section after the link:

```sh
printf 'requires=exception-handling\n' > declaration.txt
llvm-objcopy --add-section=uci_over_wasi=declaration.txt engine.wasm
```

`tools/wasm-features.ts <module.wasm>` lists the features a module uses, and the checker compares them with
the section.

## A deaf engine

An engine that reads nothing during a search needs no helper and no change to its input code. Its module
declares the deaf profile, `profile=deaf`, so its host keeps `stop` and an unbounded `go` away from it.

## Checking an adapted engine

- **`bun tools/wasi-check.ts <module.wasm>`** checks the module's handling of input during a search.
  `--bench <nodes>` also runs the engine's bench from the command line and looks for that node count.
- **The adapted engine's node counts equal the native build's.** A difference is a bug in the edits.
- **Compare the engine's full bench where it has one and the check's time allows it.** A position file comes
  second: a fixed-depth suite can match native while the full bench differs, as a float layer left unfused does.
  An engine without a usable bench, or with one too long for the check, compares moves and node counts over a
  position file.
- **An engine whose play depends on its standard library** is the exception. `std::sort` orders equal
  scores differently under libstdc++ and libc++, so such a module differs from its native build. Its gate
  is a throwaway pair: the native and the wasm build agree once `std::stable_sort` is patched into both.
  The shipped module keeps the engine's own code.
