#!/bin/sh
# Builds Clovis III: build.sh native|module <tree> <out>
set -eu
kind=$1 tree=$2 out=$3
if [ "$kind" = native ]; then
  # The Makefile's flags without -Werror, which stops a current gcc. The sources use uint8_t without <cstdint>,
  # which a current libstdc++ no longer includes for them.
  make -C "$tree" -j"$JOBS" CXXFLAGS="-std=c++17 -O3 -fopenmp -flto -include cstdint"
  cp "$tree/build/Clovis" "$out"
else
  # The Makefile is not used: its -fopenmp serves only the tuner, and wasi-sdk has no OpenMP.
  # -fno-exceptions: the sources throw nothing, and the standard library's own throws need a runtime that
  # wasi-sdk leaves out.
  $CXX_WASI -std=c++17 -O3 -flto -fno-exceptions -Wall -Wextra -Wshadow -Wno-unknown-pragmas "$tree"/src/*.cpp \
    -Wl,-z,stack-size=2097152 -Wl,--strip-debug -o "$out"
  # the module reads nothing during a search, and says so for its host
  printf 'profile=deaf\n' > "$tree/profile.txt"
  "$WASI_SDK/bin/llvm-objcopy" --add-section=uci_over_wasi="$tree/profile.txt" "$out"
fi
