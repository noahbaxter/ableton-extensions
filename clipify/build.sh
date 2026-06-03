#!/usr/bin/env bash
set -euo pipefail

# Build/run the Clipify extension.
#
#   ./build.sh            Build the distributable .ablx (production, minified)
#   ./build.sh dev        Dev bundle only (sourcemaps, no .ablx)
#   ./build.sh run        Build + launch in Live's Extension Host (dev mode)
#
# The Ableton Extensions CLI requires Node >= 24.14.1. This script locates a
# suitable node (e.g. Homebrew's) even if your shell defaults to an older one.

cd "$(dirname "$0")"

MIN_NODE="24.14.1"

# Is version $1 >= version $2 ? (pure awk, no reliance on `sort -V`)
version_ge() {
  awk -v a="$1" -v b="$2" 'BEGIN {
    na = split(a, x, "."); nb = split(b, y, ".")
    for (i = 1; i <= 3; i++) {
      xi = (i <= na ? x[i] : 0) + 0; yi = (i <= nb ? y[i] : 0) + 0
      if (xi > yi) { print 1; exit }
      if (xi < yi) { print 0; exit }
    }
    print 1
  }'
}

find_node() {
  local candidates=(node /opt/homebrew/bin/node /usr/local/bin/node)
  local n
  for n in "$HOME"/.nvm/versions/node/v*/bin/node; do candidates+=("$n"); done
  for n in "${candidates[@]}"; do
    command -v "$n" >/dev/null 2>&1 || [ -x "$n" ] || continue
    local v
    v="$("$n" -v 2>/dev/null | sed 's/^v//')" || continue
    [ "$(version_ge "$v" "$MIN_NODE")" = 1 ] && { echo "$n"; return 0; }
  done
  return 1
}

NODE="$(find_node)" || {
  echo "error: need Node >= $MIN_NODE for the Ableton Extensions CLI, but none was found." >&2
  echo "       Install a recent Node (e.g. 'brew install node') and re-run." >&2
  exit 1
}
export PATH="$(dirname "$NODE"):$PATH"
echo "Using node $(node -v)"

[ -d node_modules ] || { echo "Installing dependencies..."; npm install; }

# Launch the dev Extension Host, working around Live's cold-start handshake: Live
# only connects to a dev host that registers AFTER the previous one disconnects,
# so from a cold start the first host never completes its greeting (you'd have to
# run twice). We launch a throwaway host to nudge Live into its ready state, tear
# it down, then exec the real host in the foreground.
dev_run() {
  local cli="node_modules/.bin/extensions-cli"
  local storage="$PWD/.clipify-dev" # stable storageDirectory so settings persist in dev
  local tmp="$PWD/.clipify-dev-temp" # tempDirectory (Live provides one when installed)
  local log; log="$(mktemp)"

  mkdir -p "$storage" "$tmp" # the host sets these paths but won't create them

  echo "Warming up Extension Host handshake…"
  "$cli" run --storage-directory "$storage" --temp-directory "$tmp" >"$log" 2>&1 &
  local wpid=$!
  # wait (up to ~8s) for the warm-up host to come up
  local i
  for i in $(seq 1 40); do
    if grep -q "Started: Extension Host" "$log" 2>/dev/null; then break; fi
    sleep 0.2
  done
  sleep 1.5 # let Live register the connection so the kill reads as a disconnect
  pkill -P "$wpid" 2>/dev/null || true # the host child
  kill "$wpid" 2>/dev/null || true
  wait "$wpid" 2>/dev/null || true
  rm -f "$log"

  echo "Launching Extension Host…"
  exec "$cli" run --storage-directory "$storage" --temp-directory "$tmp"
}

case "${1:-package}" in
  package) npm run package; echo "Built: $PWD/dist/clipify.ablx" ;;
  dev)     npm run build:dev ;;
  run)     npm run build:dev && dev_run ;;
  *)       echo "usage: ./build.sh [package|dev|run]" >&2; exit 2 ;;
esac
