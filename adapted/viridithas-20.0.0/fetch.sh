#!/bin/sh
# Gets Viridithas's crates and embedded network: fetch.sh <tree>. Downloads and verifies sha256; runs none of its code.
set -eu
export CARGO_HOME="$PWD/cargo"
net_url=https://github.com/cosmobobak/viridithas-networks/releases/download/v109/sandhi-s2-b200.nnue.zst
net_sha=066c172e22c25ee3d3b4084ad44ff761426f906a9c536cabd0127d17413d0585
if [ ! -f viridithas.nnue.zst ]; then
  curl -sSLf -o viridithas.nnue.zst.part "$net_url"
  mv viridithas.nnue.zst.part viridithas.nnue.zst
fi
echo "$net_sha  viridithas.nnue.zst" | sha256sum -c --quiet -
cargo fetch --manifest-path "$1/Cargo.toml"
