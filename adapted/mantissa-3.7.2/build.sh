#!/bin/sh
# Builds Mantissa 3.7.2: build.sh native|module <tree> <out>
set -eu
kind=$1 tree=$2 out=$3
# The engine has no dependencies, so there is no fetch.sh. cargo still gets a home of its own, in the folder this
# script is run in.
export CARGO_HOME="$PWD/cargo"
# the engine uses std::simd, a nightly feature, which a stable rustc builds only with this set
export RUSTC_BOOTSTRAP=1
cd "$tree"
if [ "$kind" = native ]; then
  # A current std has simd_max and reduce_sum in the SimdFloat trait, so nnue.rs must import it. edits.patch adds
  # the same line to the module's tree.
  sed -i 's|^use std::simd::\*;$|&\nuse std::simd::prelude::SimdFloat;|' src/nnue.rs
  cargo build --offline --locked --release -j"$JOBS"
  cp target/release/mantissa "$out"
else
  cp "$HELPER/uci_wasi.rs" src/uci_wasi.rs
  # No debug info, which the release profile asks for and a module has no use for. 2 MB of stack: the size of the
  # native search thread's stack, Rust's default. With simd128, the net's f32x8 steps become two v128 steps each.
  CARGO_PROFILE_RELEASE_DEBUG=false RUSTFLAGS="-Clink-arg=-zstack-size=2097152 -Ctarget-feature=+simd128" \
    cargo build --offline --locked --release -j"$JOBS" --target wasm32-wasip1
  cp target/wasm32-wasip1/release/mantissa.wasm "$out"
fi
