#!/bin/sh
# Builds Stash 30.0: build.sh native|module <tree> <out>
set -eu
kind=$1 tree=$2 out=$3
# ARCH=generic: the Makefile's default, x86-64-modern, adds x86 flags
if [ "$kind" = native ]; then
  make -C "$tree/src" -j"$JOBS" ARCH=generic EXE="$out"
else
  # LDFLAGS on the command line replaces the Makefile's "-lpthread -lm", so it repeats them
  make -C "$tree/src" -j"$JOBS" CC="$WASI_SDK/bin/wasm32-wasip1-clang -I$HELPER" ARCH=generic EXE="$out" \
    LDFLAGS="-lpthread -lm $HELPER_O -Wl,-z,stack-size=4194304 $WRAP"
fi
