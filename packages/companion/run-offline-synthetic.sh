#!/bin/sh
# Offline synthetic tests only. No production configuration, data, sockets or accounts.
set -eu
D=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
exec unshare --mount --net -- sh -eu -c '
  mount --make-rprivate /
  mount -t tmpfs -o mode=700,size=32m tmpfs /run
  mkdir -m 700 /run/workspace
  mount --bind "$1" /run/workspace
  mount -t tmpfs -o mode=700,size=32m tmpfs /root
  mkdir -m 700 /root/workspace /root/home
  mount --bind /run/workspace /root/workspace
  mount -t tmpfs -o mode=700,size=32m tmpfs /run
  mount -t tmpfs -o mode=700,size=256m tmpfs /tmp
  cd /root/workspace
  exec env -i PATH=/usr/bin:/bin HOME=/root/home TMPDIR=/tmp NODE_ENV=test node --test --test-concurrency=1 test/humanize-preservation.test.js test/factual-grounding.test.js test/tts-emotion-request.test.js
' sh "$D"
