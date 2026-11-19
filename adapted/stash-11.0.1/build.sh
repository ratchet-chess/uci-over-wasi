#!/bin/sh
# Builds Stash 11.0.1: build.sh native|module <tree> <out>
set -eu
kind=$1 tree=$2 out=$3
if [ "$kind" = native ]; then
  # no ARCH: the Makefile then adds no machine flags
  make -C "$tree" -j"$JOBS" NAME="$out"
else
  make -C "$tree" -j"$JOBS" CC="$WASI_SDK/bin/wasm32-wasip1-clang" NAME="$out" \
    EXT_OFLAGS="-I$HELPER" EXT_LFLAGS="$HELPER_O -Wl,-z,stack-size=4194304 $WRAP"
fi
