#!/bin/sh
# The toolchains that build an adapted engine, as tools/toolchains.txt pins them.
#
#   tools/toolchains.sh fetch [name...]    downloads each archive and checks its sha256; the one step that needs network
#   tools/toolchains.sh unpack [name...]   unpacks the archives: wasi-sdk/, rust/ and go/
#   tools/toolchains.sh env                prints the settings that tools/adapted.sh gives a build
#
# A name is wasi-sdk, rust or go; with none, every toolchain. They go in $TOOLCHAINS, default tmp/toolchains.
# An author with their own toolchains skips this script and sets WASI_SDK, and puts cargo or go on PATH.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
T=${TOOLCHAINS:-$here/tmp/toolchains}
pins=$here/tools/toolchains.txt
cmd=${1:-}
[ $# -gt 0 ] && shift
wanted() { [ -z "$names" ] || case " $names " in *" $1 "*) true ;; *) false ;; esac; }
names=$*

case "$cmd" in
  fetch)
    mkdir -p "$T/archives"
    grep -v '^#' "$pins" | while read -r name sha url; do
      wanted "$name" || continue
      file=$T/archives/${url##*/}
      [ -f "$file" ] || curl -sSLf -o "$file.part" "$url"
      [ -f "$file" ] || mv "$file.part" "$file"
      echo "$sha  $file" | sha256sum -c --quiet -
    done
    ;;
  unpack)
    grep -v '^#' "$pins" | while read -r name sha url; do
      wanted "$name" || continue
      file=$T/archives/${url##*/}
      echo "$sha  $file" | sha256sum -c --quiet -
      case "$name" in
        rust)
          # a Rust archive holds components, each a tree to put over the others; its installer is not run
          rm -rf "$T/unpack" && mkdir -p "$T/unpack" "$T/rust"
          tar -xzf "$file" -C "$T/unpack" --strip-components=1
          while read -r part; do
            (cd "$T/unpack/$part" && tar -cf - --exclude=./manifest.in .) | tar -xf - -C "$T/rust"
          done < "$T/unpack/components"
          rm -rf "$T/unpack"
          ;;
        *)
          rm -rf "$T/$name" && mkdir -p "$T/$name"
          tar -xzf "$file" -C "$T/$name" --strip-components=1
          ;;
      esac
    done
    ;;
  env)
    echo "export WASI_SDK=$T/wasi-sdk"
    echo "export PATH=$T/rust/bin:$T/go/bin:\$PATH"
    ;;
  *) sed -n '2,8p' "$0" >&2; exit 2 ;;
esac
