#!/bin/sh
# Builds Stash 37.0: build.sh native|module <tree> <out>
set -eu
kind=$1 tree=$2 out=$3
if [ "$kind" = native ]; then
  # the Makefile's own -march=native would tie the build to this machine
  make -C "$tree" -j"$JOBS" ARCH=generic EXE="$out"
else
  make -C "$tree" -j"$JOBS" CC="$WASI_SDK/bin/wasm32-wasip1-clang" ARCH=generic EXE="$out" CPPFLAGS="-I$HELPER" \
    LDFLAGS="$HELPER_O -Wl,-z,stack-size=4194304 $WRAP"
fi
