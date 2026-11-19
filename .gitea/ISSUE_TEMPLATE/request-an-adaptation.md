---
name: Request an adaptation
about: Ask for an engine to be adapted to UCI over WASI
title: "Adapt: <engine> <version>"
---

<!-- An adapted engine is another engine with the edits that make it a module of UCI over WASI. -->

**The engine's public repo:**

**The version, tag or commit to adapt:**

**Its license:** <!-- The license must permit edits and their publication. -->

**Its language and build:** <!-- C, C++, Rust or Go; make, CMake, cargo or go build. -->

**How its search hears input:** <!-- A second thread reads stdin, or the search polls, or it reads nothing during a search. -->

**A command that prints a node count that repeats:** <!-- Such as `bench`. Write "none" if the engine has none. -->

**What it needs that a module cannot have:** <!-- Threads, files, tablebases, a net read from a file, x86 intrinsics. docs/wasm-limits.md lists the limits. -->
