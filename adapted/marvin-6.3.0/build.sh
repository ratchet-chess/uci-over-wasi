#!/bin/sh
# Builds Marvin 6.3.0: build.sh native|module <tree> <out>
set -eu
kind=$1 tree=$2 out=$3
if [ "$kind" = native ]; then
  # CC=gcc: the Makefile names clang, and the other native builds here need only gcc
  make -C "$tree" -j"$JOBS" arch=x86-64-modern CC=gcc EXEFILE="$out"
else
  # The Makefile is not used: it adds x86 flags, -flto, -lpthread and Fathom's tbprobe.c.
  # setjmp and longjmp, the search's abort, need wasm exception handling.
  # --embed-dir: the edits hold the net with #embed, by its path from the repo's root.
  mkdir "$tree/obj"
  export tree
  ls "$tree"/src/*.c | xargs -P"$JOBS" -I{} sh -c '$CC_WASI -O3 -funroll-loops -DNDEBUG \
    -mllvm -wasm-enable-sjlj -mexception-handling \
    -DAPP_ARCH="\"wasm32\"" -DNETFILE_NAME="\"res/eval.nnue\"" -DAPP_VERSION="\"6.3.0\"" \
    --embed-dir="$tree" -I"$tree/src" -I"$HELPER" \
    -W -Wall -Wno-array-bounds -Wno-pointer-to-int-cast -Wno-int-to-pointer-cast \
    -c {} -o "$tree/obj/$(basename {} .c).o"'
  $CC_WASI -O3 -mexception-handling "$tree"/obj/*.o "$HELPER_O" -lsetjmp -Wl,-z,stack-size=4194304 $WRAP -o "$out"
fi
