#!/bin/sh
# Builds Halogen 16: build.sh native|module <tree> <out>
set -eu
kind=$1 tree=$2 out=$3 state=$PWD
if [ "$kind" = native ]; then
  # The Makefile's release build for its avx2 architecture, a fixed one, with the net that fetch.sh left. Its AVX2,
  # SSE4 and portable paths search the same nodes.
  make -C "$tree/src" -j"$JOBS" release ARCH=avx2 EVALFILE="$state/150521a9.nn" CXX=g++
  cp "$tree/bin/Halogen-avx2" "$out"
  exit 0
fi
# The module: the Makefile's release flags and sources, compiled by hand, because its build runs the tool it builds.
# That tool lays the net out for the module's SIMD path, built natively with the same definitions.
cd "$tree/src"
# The engine's SSE4 path, compiled to WebAssembly SIMD: USE_SSE4 and the __SSE*__ macros select it, and SIMDe, which
# fetch.sh left, stands in for immintrin.h. SIMDe reads x86 feature macros only on an x86 target.
defines=-DUSE_SSE4
mkdir -p "$state/shim"
printf '#define SIMDE_ENABLE_NATIVE_ALIASES\n#include "x86/sse4.2.h"\n' > "$state/shim/immintrin.h"
simd="-msimd128 -D__SSE__ -D__SSE2__ -D__SSE3__ -D__SSSE3__ -D__SSE4_1__ -D__SSE4_2__ -I$state/shim -I$state/simde
  -DSIMDE_FLOAT16_API=SIMDE_FLOAT16_API_PORTABLE"
flags="-O3 -DNDEBUG -Wall -Wextra -Wshadow -Wno-missing-field-initializers -Wno-deprecated-declarations
  -Wno-ignored-attributes -I. -std=c++20 -fno-exceptions -ffp-contract=off"
g++ $flags $defines tools/verbatim.cpp -o "$state/verbatim"
"$state/verbatim" "$state/150521a9.nn" "$state/verbatim.nn"
sources="main.cpp chessboard/board_state.cpp chessboard/game_state.cpp evaluation/evaluate.cpp movegen/move.cpp
  movegen/movegen.cpp network/network.cpp numa/numa.cpp search/cuckoo.cpp search/data.cpp search/history.cpp
  search/search.cpp search/staged_movegen.cpp search/static_exchange_evaluation.cpp search/syzygy.cpp
  search/zobrist.cpp search/limit/time.cpp search/transposition/table.cpp search/transposition/entry.cpp
  search/thread.cpp test/static_exchange_evaluation_test.cpp third-party/Pyrrhic/tbprobe.cpp uci/uci.cpp
  datagen/datagen.cpp datagen/encode.cpp utility/arch.cpp"
# Pyrrhic's mmap is wasi-libc's emulation; a module opens no tablebase file. The stack is the main thread's 8 MiB.
$CXX_WASI $flags $defines $simd -flto -DEVALFILE="\"$state/verbatim.nn\"" -I"$HELPER" -D_WASI_EMULATED_MMAN \
  $sources "$HELPER_O" -lwasi-emulated-mman -Wl,-z,stack-size=8388608 $WRAP -o "$out"
