#!/bin/sh
# Builds Stockfish 19: build.sh native|module <tree> <out>
set -eu
kind=$1 tree=$2 out=$3 state=$PWD
# the net that fetch.sh left, compiled in as Stockfish's default net
cp "$state/nn-1a298aa575a0.nnue" "$tree/nn-1a298aa575a0.nnue"
if [ "$kind" = native ]; then
  # The Makefile's plain build for a fixed architecture; its build target runs a script outside src/ to get the net.
  make -C "$tree" -j"$JOBS" all ARCH=x86-64-avx2 COMP=gcc EXE="$out"
  exit 0
fi
# The module follows the Makefile's wasm32 architecture, which is for Emscripten: the SSE4.1 path with its few
# WebAssembly intrinsics, sloppy atomics, and no tablebases. Here SIMDe, which fetch.sh left, stands in for
# Emscripten's x86 headers, under each name the engine includes; SIMDe reads x86 feature macros only on an x86
# target. The Makefile is not used: it builds that architecture with emcc.
cd "$tree"
mkdir -p "$state/shim"
for header in immintrin.h emmintrin.h tmmintrin.h smmintrin.h; do
  printf '#define SIMDE_ENABLE_NATIVE_ALIASES\n#include "x86/sse4.1.h"\n' > "$state/shim/$header"
done
simd="-msimd128 -D__SSE__ -D__SSE2__ -D__SSE3__ -D__SSSE3__ -D__SSE4_1__ -I$state/shim -I$state/simde
  -DSIMDE_FLOAT16_API=SIMDE_FLOAT16_API_PORTABLE -DUSE_SSE2 -DUSE_SSSE3 -DUSE_SSE41 -DUSE_POPCNT"
# The memory code's mmap is wasi-libc's emulation. The stack is the native search thread's large stack, 8 MiB.
$CXX_WASI -std=c++17 -O3 -DNDEBUG -fno-exceptions -Wall -Wcast-qual -Wno-c23-extensions -flto $simd \
  -DUSE_SLOPPY_ATOMICS -DNO_TABLEBASES -DARCH=wasm32 -I"$HELPER" -D_WASI_EMULATED_MMAN \
  attacks.cpp benchmark.cpp bitboard.cpp evaluate.cpp main.cpp misc.cpp movegen.cpp movepick.cpp position.cpp \
  search.cpp thread.cpp timeman.cpp tt.cpp uci.cpp ucioption.cpp tune.cpp syzygy/tbprobe.cpp \
  nnue/nnue_accumulator.cpp nnue/nnue_misc.cpp nnue/network.cpp nnue/features/half_ka_v2_hm.cpp \
  nnue/features/full_threats.cpp nnue/features/pp_3wide.cpp engine.cpp score.cpp memory.cpp \
  "$HELPER_O" -lwasi-emulated-mman -Wl,-z,stack-size=8388608 $WRAP -o "$out"
