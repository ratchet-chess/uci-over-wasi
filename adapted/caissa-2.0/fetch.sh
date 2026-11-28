#!/bin/sh
# Gets Caissa's net: fetch.sh <tree>. Downloads and verifies sha256; runs none of its code.
set -eu
[ -f eval-ml-8-152B-spsa.pnn ] || {
  curl -sSLf -o net.part https://github.com/Witek902/Caissa-Nets/releases/download/eval-ml-8-152B-spsa/eval-ml-8-152B-spsa.pnn
  mv net.part eval-ml-8-152B-spsa.pnn
}
echo "ee9f6bbb0ef6cd1f38a13cf095340968c2ad18d0fa1359d493043e61acc829fa  eval-ml-8-152B-spsa.pnn" | sha256sum -c --quiet -
