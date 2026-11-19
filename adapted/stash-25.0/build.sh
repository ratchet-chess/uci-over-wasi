#!/bin/sh
# Builds Stash 25.0: build.sh native|module <tree> <out>
set -eu
kind=$1 tree=$2 out=$3
# native=no: the Makefile's own -march=native would tie the build to this machine
if [ "$kind" = native ]; then
  make -C "$tree/src" -j"$JOBS" native=no EXE="$out"
else
  # LDFLAGS on the command line replaces the Makefile's "-lpthread -lm", so it repeats them
  make -C "$tree/src" -j"$JOBS" CC="$WASI_SDK/bin/wasm32-wasip1-clang -I$HELPER" native=no EXE="$out" \
    LDFLAGS="-lpthread -lm $HELPER_O -Wl,-z,stack-size=4194304 $WRAP"
fi
