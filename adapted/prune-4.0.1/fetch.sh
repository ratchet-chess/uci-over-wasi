#!/bin/sh
# Gets Prune's net, and SIMDe's headers with its license: fetch.sh <tree>. Downloads and verifies sha256; runs none of their code.
set -eu
get() { # get <url> <file> <sha256>
  [ -f "$2" ] || { curl -sSLf -o "$2.part" "$1" && mv "$2.part" "$2"; }
  echo "$3  $2" | sha256sum -c --quiet -
}
get https://github.com/tgirolami09/Prune-nets/releases/download/nn-pulsar-dev-0d99364/pulsar.bin pulsar.bin \
  0d9936472c089f8b19c52df5e1874b3944668f933f71d7beb3cfa270ce7f0b0e
get https://github.com/simd-everywhere/simde/releases/download/v0.8.2/simde-amalgamated-0.8.2.tar.xz simde.tar.xz \
  59068edc3420e75c5ff85ecfd80a77196fb3a151227a666cc20abb313a5360bf
rm -rf simde && mkdir simde && tar -xJf simde.tar.xz -C simde --strip-components=1
get https://raw.githubusercontent.com/simd-everywhere/simde/v0.8.2/COPYING simde.COPYING \
  75ce0a8c5a7bff42fbd6f8f3b469b518132132c4f4948fb8d02b1ccb5d0df9d8
cp simde.COPYING simde/COPYING
