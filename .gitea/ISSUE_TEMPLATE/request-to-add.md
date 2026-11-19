---
name: Request to add an adapted engine
about: Offer an adapted engine for adapted/
title: "Add: <engine> <version>"
---

<!-- Open a pull request with one folder, adapted/<engine>-<version>/, and link it here. tools/adapted.sh states the folder's form. -->

**The engine's public repo and the pinned commit:**

**Its license:** <!-- The folder's files are under this license. -->

**The pull request:**

**The folder holds:**

- [ ] `pin`: the repo, the commit, the license, and how the two builds are compared
- [ ] `edits.patch`: every edit inside the target's guard, with a comment that opens `UCI over WASI:`
- [ ] `build.sh`: builds the native engine and the module from the same tree
- [ ] `positions.txt`, if the native build has no node count that repeats

**What CI checks:** the native engine and the module are built from the pinned commit, their node counts are
compared, and `tools/wasi-check.ts` runs on the module.

**The module's profile:** <!-- polls, through the helper, or deaf. -->

**What the module leaves out:** <!-- Such as tablebases, a book, more than one thread, a net's fast path. -->
