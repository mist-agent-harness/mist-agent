#!/usr/bin/env bash
set -euo pipefail

workspace=${1:?workspace path required}
fixture_dir=$(cd "$(dirname "$0")" && pwd)
cp "$fixture_dir/faults/bridge.mjs" "$workspace/src/bridge.mjs"
rm -f "$workspace/var/last-error.log"

if node "$workspace/scripts/run-production.mjs" >/dev/null 2>&1; then
  echo "C2 injection failed: production check unexpectedly passed" >&2
  exit 1
fi
