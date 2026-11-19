#!/bin/sh
# Builds Zurichess neuchatel: build.sh native|module <tree> <out>
set -eu
kind=$1 tree=$2 out=$3
# The engine needs only the standard library, so the build is offline. Its caches go in the folder it is run in.
export GOPROXY=off GOTOOLCHAIN=local GOENV=off GOCACHE="$PWD/gocache" GOPATH="$PWD/gopath"
cd "$tree"
# the engine is older than Go modules
go mod init bitbucket.org/zurichess/zurichess
if [ "$kind" = module ]; then
  export GOOS=wasip1 GOARCH=wasm
  mkdir -p internal/uciwasi
  cp "$HELPER/uci_wasi.go" internal/uciwasi/uci_wasi.go
fi
go build -p "$JOBS" -o "$out" ./zurichess
