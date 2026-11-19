#!/bin/sh
# Builds Stockfish 10: build.sh native|module <tree> <out>
set -eu
kind=$1 tree=$2 out=$3
if [ "$kind" = native ]; then
  # the plain build, which adds no -march; profile-build would run the engine to train the build
  make -C "$tree" -j"$JOBS" build ARCH=x86-64-modern EXE="$out"
else
  # The Makefile is not used: it has no architecture for a module, and its link adds -lpthread.
  cd "$tree"
  $CXX_WASI -std=c++11 -O3 -DNDEBUG -fno-exceptions -Wall -Wcast-qual -DIS_64BIT -DUSE_POPCNT -I"$HELPER" \
    -D_WASI_EMULATED_MMAN -lwasi-emulated-mman -Wl,-z,stack-size=2097152 -Wl,--strip-debug $WRAP \
    benchmark.cpp bitbase.cpp bitboard.cpp endgame.cpp evaluate.cpp main.cpp material.cpp misc.cpp \
    movegen.cpp movepick.cpp pawns.cpp position.cpp psqt.cpp search.cpp thread.cpp timeman.cpp tt.cpp \
    uci.cpp ucioption.cpp syzygy/tbprobe.cpp "$HELPER_O" -o "$out"
fi
