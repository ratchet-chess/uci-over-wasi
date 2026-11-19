#!/bin/sh
# Builds Simbelmyne 1.10: build.sh native|module <tree> <out>
set -eu
kind=$1 tree=$2 out=$3
# the crates that fetch.sh left
export CARGO_HOME="$PWD/cargo"
# RUSTFLAGS replaces the flags of the tree's .cargo/config.toml. Its target-cpu=native would tie the build to this
# machine. Its inline threshold is kept, in the form a current rustc takes.
flags="-Cllvm-args=--inline-threshold=500"
cd "$tree"
if [ "$kind" = native ]; then
  RUSTFLAGS="$flags" cargo build --offline --locked --release -j"$JOBS" -p simbelmyne
  cp target/release/simbelmyne "$out"
else
  cp "$HELPER/uci_wasi.rs" simbelmyne/src/uci_wasi.rs
  # No debug info, which the release profile asks for and a module has no use for. 2 MB of stack: the size of the
  # native search thread's stack, Rust's default.
  RUSTFLAGS="$flags -Cdebuginfo=0 -Clink-arg=-zstack-size=2097152" \
    cargo build --offline --locked --release -j"$JOBS" -p simbelmyne --target wasm32-wasip1
  cp target/wasm32-wasip1/release/simbelmyne.wasm "$out"
fi
