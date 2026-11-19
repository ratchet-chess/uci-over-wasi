#!/bin/sh
# Gets Simbelmyne's crates: fetch.sh <tree>. cargo downloads them and runs none of their code.
set -eu
# the cargo home that build.sh reads, in the folder this script is run in
export CARGO_HOME="$PWD/cargo"
# Not --locked: the lock file names the engine's own crate at an older version, so cargo must rewrite that entry.
# Every dependency stays at its locked version. cargo is run from outside the tree, so it reads no config of the
# tree's.
cargo fetch --manifest-path "$1/Cargo.toml"
