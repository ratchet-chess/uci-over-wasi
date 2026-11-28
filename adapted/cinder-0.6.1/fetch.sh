#!/bin/sh
# Gets Cinder's crates: fetch.sh <tree>. Downloads and verifies them by Cargo.lock; runs none of their code.
set -eu
export CARGO_HOME="$PWD/cargo"
cargo fetch --locked --manifest-path "$1/Cargo.toml"
