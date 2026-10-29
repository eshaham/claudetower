#!/bin/sh
set -eu

if [ $# -lt 1 ]; then
  echo "usage: bench/run.sh <work-dir> [before-ref] [sessions] [seconds]" >&2
  exit 1
fi

WORK=$1
BEFORE=${2:-}
SESSIONS=${3:-5}
SECONDS_EACH=${4:-90}
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/.." && pwd)

mkdir -p "$WORK/tsx" "$WORK/modules/claude-code"
[ -f "$WORK/tsx/node_modules/tsx/dist/loader.mjs" ] ||
  npm install --silent --prefix "$WORK/tsx" tsx@4 >/dev/null
LOADER=$WORK/tsx/node_modules/tsx/dist/loader.mjs
ln -sf "$HERE/claude-code-stub.ts" "$WORK/modules/claude-code/index.ts"
printf '{ "name": "claude-code", "main": "index.ts" }\n' >"$WORK/modules/claude-code/package.json"

run() {
  NODE_PATH=$WORK/modules node --import "$LOADER" "$@"
}

[ -d "$WORK/sandbox" ] || run "$HERE/prepare.ts" "$WORK/sandbox" Claude

CODES="$REPO:new"
if [ -n "$BEFORE" ]; then
  rm -rf "$WORK/before" && mkdir -p "$WORK/before"
  git -C "$REPO" archive "$BEFORE" hooks types | tar -x -C "$WORK/before"
  CODES="$WORK/before:old $CODES"
fi

for code in $CODES; do
  for scenario in "0 none" "20 touch" "60 touch" "20 append" "60 append"; do
    set -- $scenario
    run "$HERE/measure.ts" "${code%:*}" "${code##*:}" "$WORK/sandbox" \
      "$SESSIONS" "$1" "$2" "$LOADER" "$SECONDS_EACH" "$SECONDS_EACH"
  done
done
