#!/usr/bin/env bash
set -euo pipefail

workspace=${1:?workspace path required}
node - "$workspace/config/routes.json" <<'NODE'
const fs = require("node:fs");
const file = process.argv[2];
const config = JSON.parse(fs.readFileSync(file, "utf8"));
config.archive_export.enabled = false;
fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
NODE

if node "$workspace/scripts/check-export.mjs" >/dev/null 2>&1; then
  echo "C1 injection failed: production check unexpectedly passed" >&2
  exit 1
fi
