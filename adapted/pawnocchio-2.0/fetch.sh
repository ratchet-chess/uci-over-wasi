#!/bin/sh
# Gets pawnocchio's net, from its nets submodule at the commit the engine pins: fetch.sh <tree>. Downloads and
# verifies sha256, the hash of the first download; runs none of its code.
set -eu
[ -f pp_new2.nnue ] || {
  curl -sSLf -o pp_new2.nnue.part \
    https://raw.githubusercontent.com/JonathanHallstrom/pawnocchio-nets/bbaf11347430bfedbf27461a1c3c2b360aa5e930/networks/pp_new2.nnue
  mv pp_new2.nnue.part pp_new2.nnue
}
echo "8b1d78b2908d330ace30ab69c3679a44db8176e0d6bf4116b60da8c383a4bc17  pp_new2.nnue" | sha256sum -c --quiet -
