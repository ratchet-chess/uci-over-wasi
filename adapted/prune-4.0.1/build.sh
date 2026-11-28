#!/bin/sh
# Builds Prune 4.0.1: build.sh native|module <tree> <out>
set -eu
kind=$1 tree=$2 out=$3 state=$PWD
# the net that fetch.sh left; the build permutes it into model.bin for the SIMD width it compiles
cp "$state/pulsar.bin" "$tree/core/pulsar.bin"
if [ "$kind" = native ]; then
  # ARCH=x86-64-v2: a fixed architecture, not the Makefile's -march=native, with the 128-bit vectors the module
  # has. Prune's AVX2 path searches other nodes than its 128-bit path, natively too. NETNAME: the net is here, so
  # the Makefile downloads nothing.
  make -C "$tree/core" -j"$JOBS" all ARCH=x86-64-v2 NETNAME=pulsar CC=gcc CXX=g++ EXE="$out"
else
  # The Makefile is not used: it builds for x86 and links -lpthread.
  # model.bin in the 128-bit layout: the Makefile's permute tool, built for SSE4.2, so its vectors are 128 bits.
  cd "$tree/core"
  g++ -O2 -march=x86-64-v2 -std=gnu++17 -I../Fathom/src permute.cpp -o "$state/permute128"
  "$state/permute128" pulsar.bin model.bin
  # The engine's 128-bit path, compiled to WebAssembly SIMD: the __SSE*__ macros select it, and SIMDe, which
  # fetch.sh left, is included ahead of each file. SIMDe reads x86 feature macros only on an x86 target.
  mkdir -p "$state/shim"
  printf '#define SIMDE_ENABLE_NATIVE_ALIASES\n#include "x86/sse4.1.h"\n' > "$state/shim/simde.h"
  simd="-msimd128 -D__SSE__ -D__SSE2__ -D__SSE3__ -D__SSSE3__ -D__SSE4_1__ -include $state/shim/simde.h \
    -I$state/simde -DSIMDE_FLOAT16_API=SIMDE_FLOAT16_API_PORTABLE"
  # Fathom's mmap is wasi-libc's emulation; a module opens no tablebase file.
  $CC_WASI -c -O3 -D_CRT_SECURE_NO_WARNINGS -D_WASI_EMULATED_MMAN -I../Fathom/src ../Fathom/src/tbprobe.c \
    -o "$state/tbprobe.o"
  # -fno-exceptions: the engine catches nothing, so a throw ends it either way. clock() times perft, through
  # wasi-libc's emulation. The stack is the native search's, the main thread's 8 MiB.
  $CXX_WASI -std=gnu++17 -O3 -flto -funroll-loops -Wall -Wextra -I../Fathom/src -I"$HELPER" -fno-exceptions -D_WASI_EMULATED_MMAN \
    -D_WASI_EMULATED_PROCESS_CLOCKS $simd \
    -DCOMMIT=\"3b9b84fde1ec6420300b7940824895d63ddc0253\" -DVERSION=\"v4.0.1\" \
    $(ls *.cpp | grep -v -x -e collectData.cpp -e unittest.cpp -e netScale.cpp -e spsa.cpp -e datasetStats.cpp \
      -e testTI.cpp -e quantise.cpp -e permute.cpp) \
    "$state/tbprobe.o" "$HELPER_O" -lwasi-emulated-mman -lwasi-emulated-process-clocks \
    -Wl,-z,stack-size=8388608 $WRAP -o "$out"
fi
