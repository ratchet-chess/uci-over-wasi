#!/bin/sh
# Builds Caissa 2.0: build.sh native|module <tree> <out>
set -eu
kind=$1 tree=$2 out=$3 state=$PWD
# CMake's Final configuration, compiled by hand, because the build container has no CMake: the same definitions,
# the same sources, and the net that fetch.sh left compiled in, where CMake would copy it beside the binary.
# -Werror is left out, because a different compiler's new warning would stop the build.
src=$tree/src
sources="$src/backend/*.cpp $src/backend/syzygy/tbprobe.cpp $src/frontend/*.cpp"
defs="-DCONFIGURATION_FINAL -DCAISSA_VERSION=\"2.0\" -DCAISSA_EVALFILE=\"$state/eval-ml-8-152B-spsa.pnn\""
flags="-std=c++20 -O3 -flto -fno-rtti -Wall -Wextra -Wno-unused-function -Wno-multichar -Wno-switch -Wno-attributes
  -Wno-missing-field-initializers -Wno-unused-const-variable -Wno-deprecated-declarations"
if [ "$kind" = native ]; then
  # CMake's x64-avx2 architecture: a fixed one. Its AVX2 path searches the same nodes as the 128-bit path.
  g++ $flags $defs -DARCHITECTURE_X64 -DUSE_SSE -DUSE_SSE2 -DUSE_SSE4 -DUSE_POPCNT -DUSE_AVX -DUSE_AVX2 -mavx -mfma -mavx2 \
    $sources -lpthread -o "$out"
else
  # The engine's portable path, which clang vectorizes with -msimd128: its SSE4 path through SIMDe was the slower one,
  # at the same node counts. Syzygy's mmap and the debug break's raise are wasi-libc's emulations; a module opens no
  # tablebase file. The stack is the native search thread's 8 MiB.
  $CXX_WASI $flags $defs -msimd128 -I"$HELPER" -fno-exceptions -D_WASI_EMULATED_MMAN -D_WASI_EMULATED_SIGNAL \
    $sources "$HELPER_O" -lwasi-emulated-mman -lwasi-emulated-signal -Wl,-z,stack-size=8388608 $WRAP -o "$out"
fi
