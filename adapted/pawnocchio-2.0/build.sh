#!/bin/sh
# Builds pawnocchio 2.0: build.sh native|module <tree> <out>
set -eu
kind=$1 tree=$2 out=$3 state=$PWD
# zig's caches in the folder's state, and the net that fetch.sh left, through the build's net option
export ZIG_GLOBAL_CACHE_DIR="$state/zig-cache" ZIG_LOCAL_CACHE_DIR="$state/zig-cache-$kind"
cd "$tree"
if [ "$kind" = native ]; then
  # a fixed architecture, x86-64-v3, linked statically against musl
  zig build -j"$JOBS" --release=fast -Dtarget=x86_64-linux-musl -Dcpu=x86_64_v3 -Dnet="$state/pp_new2.nnue" \
    -Dversion_string=2.0 --prefix "$state/native-install"
  cp "$state/native-install/bin/pawnocchio" "$out"
else
  # The engine's vector code compiled to 128-bit WebAssembly SIMD, without tablebases, with the C poll helper
  # compiled in.
  zig build -j"$JOBS" --release=fast -Dtarget=wasm32-wasi -Dcpu=generic+simd128 -Duse_tbs=false \
    -Dnet="$state/pp_new2.nnue" -Dversion_string=2.0 -Duci_wasi_c="$HELPER/uci_wasi.c" --prefix "$state/module-install"
  cp "$state/module-install/bin/pawnocchio.wasm" "$out"
fi
