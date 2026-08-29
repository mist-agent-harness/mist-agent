import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const errorPath = new URL("../var/last-error.log", import.meta.url);
const result = spawnSync(process.execPath, [new URL("./worker.mjs", import.meta.url).pathname], {
  encoding: "utf8",
});
mkdirSync(dirname(errorPath.pathname), { recursive: true });
writeFileSync(errorPath, result.stderr, { encoding: "utf8", mode: 0o600 });
process.stderr.write(result.stderr);
process.exitCode = result.status ?? 1;
