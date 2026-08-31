#!/usr/bin/env bash
set -euo pipefail

workspace=${1:?workspace path required}
node - "$workspace" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const workspace = process.argv[2];
const now = new Date("2026-08-21T12:00:00.000Z");
const windowMinutes = 20 * 60;
const intervalMinutes = 30;
const rejections = windowMinutes / intervalMinutes;
const successes = 1;
const lines = [];
lines.push(`${new Date(now.getTime() - windowMinutes * 60_000).toISOString()} tenant=tenant-a tenant_refresh ok`);
for (let index = rejections - 1; index >= 0; index -= 1) {
  const offsetMinutes = index * intervalMinutes;
  lines.push(`${new Date(now.getTime() - offsetMinutes * 60_000).toISOString()} tenant=tenant-a tenant_refresh rejected policy=maintenance`);
}
const counter = {
  attempts_24h: rejections + successes,
  successes_24h: successes,
  last_success: new Date(now.getTime() - windowMinutes * 60_000).toISOString()
};
const configPath = path.join(workspace, "config", "maintenance.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
config.deny_tenant_refresh = true;
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
fs.writeFileSync(path.join(workspace, "var", "harness.log"), `${lines.join("\n")}\n`);
fs.writeFileSync(
  path.join(workspace, "state", "refresh_counter.json"),
  `${JSON.stringify(counter, null, 2)}\n`
);
fs.writeFileSync(
  path.join(workspace, "state", "runtime-status.json"),
  `${JSON.stringify({ tenant: "tenant-b", last_success: "2026-08-21T11:00:00.000Z" }, null, 2)}\n`
);

assert.equal(rejections, 40);
assert.equal(lines.filter((line) => line.includes(" rejected ")).length, rejections);
assert.equal(lines.length, rejections + 1);
assert.equal(counter.attempts_24h, rejections + successes);
assert.equal(counter.successes_24h, 1);
assert.equal((now.getTime() - Date.parse(counter.last_success)) / 3_600_000, 20);
NODE

if node "$workspace/scripts/tenant-refresh.mjs" >/dev/null 2>&1; then
  echo "C3 injection failed: refresh unexpectedly passed" >&2
  exit 1
fi
