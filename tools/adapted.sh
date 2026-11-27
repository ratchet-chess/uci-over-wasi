#!/bin/sh
# Checks one adapted engine: a folder of adapted/ with pin, edits.patch, build.sh and meta.json.
#
#   tools/adapted.sh fetch <folder>   gets the engine's source at its pin; the one step that needs network
#   tools/adapted.sh check <folder>   builds the native engine and the module, compares them, and runs the checker
#   tools/adapted.sh echo             builds helper/echo.c, the smallest module on the helper, with and without
#                                     threads, and runs the checker
#
# The pin file is shell text. It sets:
#   url, commit      the engine's public git repo and the commit to build
#   dir              the folder of that repo that edits.patch applies to (default .)
#   license          the engine's license, which this folder's files are under
#   module           the module's file name
#   compare          bench: both builds print `nodes` for the command line `bench_args` (default bench)
#                    positions: both builds give the same moves and node counts over positions.txt, each position
#                    in a fresh process, searched by `go`, the go command's arguments (tools/positions.ts)
#   gate             a patch in this folder, for an engine whose play depends on its standard library. The native
#                    build and a second module are then built with it, and compare=positions compares those two.
#                    The module that is checked and kept has the edits alone.
#
# build.sh is run as `sh build.sh native|module <tree> <out>`: it builds the tree, the engine's code with or
# without the edits, into the file <out>. A folder's fetch.sh, when it has one, gets what a build needs besides
# the source, such as a Rust engine's crates; it is run by `fetch` with the tree as its argument. Both scripts
# are run in the folder's state, tmp/adapted/<folder>/, so a build finds there what fetch.sh left.
#
# A build sees WASI_SDK; CC_WASI and CXX_WASI, its compilers for the module; HELPER, the helper's folder;
# HELPER_O, the C helper's object; WRAP, the link flag that makes a missed thread start fail; and JOBS. A module
# with threads (docs/uci-over-wasi.md § Threads) uses CC_WASI_THREADS, CXX_WASI_THREADS, HELPER_O_THREADS and
# THREADS_LINK, its link flags but the memory's maximum, and no WRAP.
# The toolchains come from tools/toolchains.sh unless WASI_SDK is already set. State is in tmp/adapted/.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
cmd=${1:-}
[ -n "${WASI_SDK:-}" ] || eval "$("$here/tools/toolchains.sh" env)"
export WASI_SDK
export CC_WASI="$WASI_SDK/bin/clang --target=wasm32-wasip1" CXX_WASI="$WASI_SDK/bin/clang++ --target=wasm32-wasip1"
export CC_WASI_THREADS="$WASI_SDK/bin/clang --target=wasm32-wasip1-threads -pthread"
export CXX_WASI_THREADS="$WASI_SDK/bin/clang++ --target=wasm32-wasip1-threads -pthread"
export THREADS_LINK="-Wl,--import-memory,--export-memory,--shared-memory"
export HELPER=$here/helper WRAP=-Wl,--wrap=pthread_create JOBS=${JOBS:-1}
helper_o() {
  mkdir -p "$1" && $CC_WASI -O2 -Wall -Wextra -c "$HELPER/uci_wasi.c" -o "$1/uci_wasi.o" && export HELPER_O=$1/uci_wasi.o
  $CC_WASI_THREADS -O2 -Wall -Wextra -c "$HELPER/uci_wasi.c" -o "$1/uci_wasi-threads.o" && export HELPER_O_THREADS=$1/uci_wasi-threads.o
}

if [ "$cmd" = echo ]; then
  work=$here/tmp/adapted/echo
  helper_o "$work"
  $CC_WASI -O2 -Wall -Wextra -I"$HELPER" "$HELPER/echo.c" "$HELPER_O" $WRAP -o "$work/echo.wasm"
  bun "$here/tools/wasi-check.ts" "$work/echo.wasm"
  # the first form of threads: checked where no thread starts, then on two threads
  $CC_WASI_THREADS -O2 -Wall -Wextra -I"$HELPER" "$HELPER/echo.c" "$HELPER_O_THREADS" $THREADS_LINK \
    -Wl,--max-memory=67108864 -o "$work/echo-threads.wasm"
  bun "$here/tools/wasi-check.ts" "$work/echo-threads.wasm"
  exec bun "$here/tools/wasi-check.ts" "$work/echo-threads.wasm" --threads 2
fi

folder=${2:-}
[ -f "$folder/pin" ] || { sed -n '2,6p' "$0" >&2; exit 2; }
folder=$(cd "$folder" && pwd)
work=$here/tmp/adapted/$(basename "$folder")
dir=. bench_args=bench compare='' nodes='' go='' module='' gate=''
. "$folder/pin"

case "$cmd" in
  fetch)
    rm -rf "$work" && mkdir -p "$work/repo"
    git -C "$work/repo" init -q
    git -C "$work/repo" fetch -q --depth 1 "$url" "$commit"
    git -C "$work/repo" -c advice.detachedHead=false checkout -q FETCH_HEAD
    [ "$(git -C "$work/repo" rev-parse HEAD)" = "$commit" ] || { echo "$url is not at $commit" >&2; exit 1; }
    [ ! -f "$folder/fetch.sh" ] || (cd "$work" && sh "$folder/fetch.sh" "$work/repo/$dir")
    ;;
  check)
    [ -d "$work/repo" ] || { echo "run: tools/adapted.sh fetch $2" >&2; exit 2; }
    [ -z "$gate" ] || [ "$compare" = positions ] || { echo "$folder/pin: gate needs compare=positions" >&2; exit 2; }
    [ -n "$module" ] || { echo "$folder/pin: module is not set" >&2; exit 2; }
    [ "$compare" != bench ] || [ -n "$nodes" ] || { echo "$folder/pin: compare=bench needs nodes" >&2; exit 2; }
    [ "$compare" != positions ] || [ -n "$go" ] || { echo "$folder/pin: compare=positions needs go" >&2; exit 2; }
    rm -rf "$work/native" "$work/edited" "$work/gated" "$work/out" && mkdir -p "$work/out"
    cp -r "$work/repo/$dir" "$work/native"
    cp -r "$work/repo/$dir" "$work/edited"
    patch -s -p1 -d "$work/edited" < "$folder/edits.patch"
    compared=$work/out/$module with=
    if [ -n "$gate" ]; then
      compared=$work/out/gated.wasm with=", both builds with $gate"
      cp -r "$work/edited" "$work/gated"
      patch -s -p1 -d "$work/native" < "$folder/$gate"
      patch -s -p1 -d "$work/gated" < "$folder/$gate"
    fi
    helper_o "$work/out"
    (cd "$work" && sh "$folder/build.sh" native "$work/native" "$work/out/native") > "$work/out/native.log" 2>&1 \
      || { tail -20 "$work/out/native.log" >&2; echo "the native build failed" >&2; exit 1; }
    (cd "$work" && sh "$folder/build.sh" module "$work/edited" "$work/out/$module") > "$work/out/module.log" 2>&1 \
      || { tail -20 "$work/out/module.log" >&2; echo "the module's build failed" >&2; exit 1; }
    if [ -n "$gate" ]; then
      (cd "$work" && sh "$folder/build.sh" module "$work/gated" "$compared") > "$work/out/gated.log" 2>&1 \
        || { tail -20 "$work/out/gated.log" >&2; echo "the build of the module with $gate failed" >&2; exit 1; }
    fi
    case "$compare" in
      bench)
        # $bench_args is split into words on purpose
        "$work/out/native" $bench_args < /dev/null > "$work/out/native-bench.txt" 2>&1 || true
        grep -q "\b$nodes\b" "$work/out/native-bench.txt" \
          || { tail -5 "$work/out/native-bench.txt" >&2; echo "the native build's bench does not print $nodes" >&2; exit 1; }
        echo "pass  native bench: $nodes nodes"
        exec bun "$here/tools/wasi-check.ts" "$work/out/$module" --bench "$nodes" --bench-args "$bench_args"
        ;;
      positions)
        bun "$here/tools/positions.ts" "$folder/positions.txt" "$go" "$work/out/native" > "$work/out/native-positions.txt"
        bun "$here/tools/positions.ts" "$folder/positions.txt" "$go" bun "$here/host/wasi/main.ts" "$compared" > "$work/out/module-positions.txt"
        [ "$(sha256sum < "$work/out/native-positions.txt")" = "$(sha256sum < "$work/out/module-positions.txt")" ] \
          || { echo "the module's moves and node counts differ from the native build's$with: $work/out/*-positions.txt" >&2; exit 1; }
        echo "pass  positions$with: $(tail -1 "$work/out/module-positions.txt")"
        exec bun "$here/tools/wasi-check.ts" "$work/out/$module"
        ;;
      *) echo "$folder/pin: compare is bench or positions" >&2; exit 2 ;;
    esac
    ;;
  *) sed -n '2,6p' "$0" >&2; exit 2 ;;
esac
