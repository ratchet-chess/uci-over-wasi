#!/bin/sh
# Builds Renegade 1.3.0: build.sh native|module <tree> <out>
set -eu
kind=$1 tree=$2 out=$3
if [ "$kind" = native ]; then
  # build=x86-64-bmi2: a fixed architecture (Haswell), not the Makefile's -march=native. CXX=g++: the
  # Makefile names clang++.
  make -C "$tree" -j"$JOBS" build=x86-64-bmi2 CXX=g++ EXE="$out"
else
  # The Makefile is not used: it adds -march, -flto and -pthread.
  # The net runs on the engine's portable path, which clang vectorizes to WebAssembly SIMD. Its one AVX2
  # kernel through SIMDe ran at a tenth of that speed.
  # --embed-dir: the edits hold the net with #embed. The stack is the native search thread's, 8 MiB.
  cd "$tree"
  $CXX_WASI -std=c++20 -O3 -funroll-loops -fno-exceptions -DNDEBUG -Wall -Wextra --embed-dir="$tree" -msimd128 \
    -I"$HELPER" $(ls *.cpp | grep -v -e '^Datagen.cpp$' -e '^Classical.cpp$') "$HELPER_O" \
    -Wl,-z,stack-size=8388608 $WRAP -o "$out"
fi
