#!/usr/bin/env bash
set -euo pipefail

workspace=${1:?workspace path required}
if [[ -e "$workspace/tools/mist-restore" ]]; then
  echo "C4 injection failed: required tool must be absent" >&2
  exit 1
fi
test -f "$workspace/state/snapshot.enc"
