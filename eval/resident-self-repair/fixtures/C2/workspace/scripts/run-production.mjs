import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const bridge = spawnSync(
  process.execPath,
  [new URL("../src/bridge.mjs", import.meta.url).pathname],
  {
    encoding: "utf8",
  },
);
if (bridge.status !== 17) throw new Error(`expected worker exit 17, got ${bridge.status}`);
const retained = readFileSync(new URL("../var/last-error.log", import.meta.url), "utf8");
if (!retained.includes("reason=fixture_failure")) throw new Error("raw stderr was not retained");
if (!bridge.stderr.includes("reason=fixture_failure"))
  throw new Error("bridge stderr was not observable");
process.stderr.write(bridge.stderr);
process.stdout.write("C2_PRODUCTION_PATH_OK\n");
