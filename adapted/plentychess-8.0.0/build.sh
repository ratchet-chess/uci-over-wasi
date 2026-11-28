#!/bin/sh
# Builds PlentyChess 8.0.0: build.sh native|module <tree> <out>
set -eu
kind=$1 tree=$2 out=$3 state=$PWD
if [ "$kind" = native ]; then
  # The Makefile's build for its avx2 architecture, a fixed one, with the net that fetch.sh left. Its AVX2, FMA, SSSE3
  # and generic paths search the same nodes.
  make -C "$tree" -j"$JOBS" arch=avx2 EVALFILE="$state/0178r.bin" EXE="$out" CXX=g++
  exit 0
fi
# The module: the Makefile's flags for its ssse3 architecture, compiled by hand, because its build runs the tool it
# builds. That tool lays the net out for the SSSE3 path, built natively for the same architecture.
cd "$tree"
make -C tools clean
make -C tools arch=ssse3 CXX=g++
./tools/process_net false "$state/0178r.bin" "$state/processed.bin"
# The engine's SSSE3 path, compiled to WebAssembly SIMD: ARCH_X86 and the __SSE*__ macros select it, and SIMDe, which
# fetch.sh left, stands in for immintrin.h and xmmintrin.h. SIMDe reads x86 feature macros only on an x86 target.
mkdir -p "$state/shim"
for header in immintrin.h xmmintrin.h; do
  printf '#define SIMDE_ENABLE_NATIVE_ALIASES\n#include "x86/ssse3.h"\n' > "$state/shim/$header"
done
simd="-msimd128 -D__SSE__ -D__SSE2__ -D__SSE3__ -D__SSSE3__ -I$state/shim -I$state/simde
  -DSIMDE_FLOAT16_API=SIMDE_FLOAT16_API_PORTABLE -DARCH_X86"
flags="-O3 -DNDEBUG -fcommon -finline-functions -fno-exceptions -fno-rtti -fomit-frame-pointer -I$HELPER $simd"
# Fathom's mmap and the search's clock() are wasi-libc's emulations; a module opens no tablebase file. The stack is
# 8 MiB, the native threads'.
$CC_WASI -w $flags -D_WASI_EMULATED_MMAN -c src/fathom/src/tbprobe.c -o "$state/tbprobe.o"
$CXX_WASI -std=c++17 -Wall -Wextra -Wno-c23-extensions $flags -flto -DEVALFILE="\"$state/processed.bin\"" \
  -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_PROCESS_CLOCKS src/engine.cpp src/board.cpp src/move.cpp src/uci.cpp src/search.cpp src/thread.cpp \
  src/evaluation.cpp src/tt.cpp src/magic.cpp src/bitboard.cpp src/history.cpp src/nnue.cpp src/time.cpp \
  src/spsa.cpp src/zobrist.cpp src/datagen.cpp src/threat-inputs.cpp src/debug.cpp "$state/tbprobe.o" "$HELPER_O" \
  -lwasi-emulated-mman -lwasi-emulated-process-clocks -Wl,-z,stack-size=8388608 $WRAP -o "$out"
