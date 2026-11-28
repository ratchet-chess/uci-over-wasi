#!/bin/sh
# Builds Cinder 0.6.1: build.sh native|module <tree> <out>
set -eu
kind=$1 tree=$2 out=$3
# the crates that fetch.sh left, and the dated nightly Rust whose unstable features Cinder uses
export CARGO_HOME="$PWD/cargo" PATH="$RUST_NIGHTLY/bin:$PATH"
cd "$tree"
if [ "$kind" = native ]; then
  # Cinder's sse4 release architecture, x86-64-v2: a fixed one, with the module's vector width. Its AVX2 path sums a
  # float layer in another order, and searches other nodes.
  RUSTFLAGS="-Ctarget-cpu=x86-64-v2" cargo build --offline --locked --release --bin cinder -j"$JOBS"
  cp target/release/cinder "$out"
else
  cp "$HELPER/uci_wasi.rs" lib/uci_wasi.rs
  # The engine's portable SIMD, compiled to 128-bit WebAssembly SIMD. The stack is the native search thread's 8 MiB.
  RUSTFLAGS="-Ctarget-feature=+simd128 -Clink-arg=-zstack-size=8388608" \
    cargo build --offline --locked --release --bin cinder -j"$JOBS" --target wasm32-wasip1
  cp target/wasm32-wasip1/release/cinder.wasm "$out"
fi
