#!/bin/sh
# Builds Viridithas 20.0.0: build.sh native|module <tree> <out>
set -eu
kind=$1 tree=$2 out=$3
# the crates and network that fetch.sh left
export CARGO_HOME="$PWD/cargo"
cp "$PWD/viridithas.nnue.zst" "$tree/viridithas.nnue.zst"
cd "$tree"
if [ "$kind" = native ]; then
  # Fixed x86-64-v3 architecture (AVX2 + FMA) so the native build does not depend on the host CPU.
  RUSTFLAGS="-C target-cpu=x86-64-v3" cargo build --offline --locked --release --no-default-features -j"$JOBS"
  cp target/release/viridithas "$out"
else
  cp "$HELPER/uci_wasi.rs" src/uci_wasi.rs
  # WebAssembly 2.0 fixed-width SIMD floor (+simd128) and 4 MB stack.
  RUSTFLAGS="-C target-feature=+simd128 -C link-arg=-zstack-size=4194304" \
    cargo build --offline --locked --release --no-default-features -j"$JOBS" --target wasm32-wasip1
  cp target/wasm32-wasip1/release/viridithas.wasm "$out"
fi
