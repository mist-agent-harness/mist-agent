import { spawnSync } from "node:child_process";

const result = spawnSync(process.execPath, [new URL("./worker.mjs", import.meta.url).pathname], {
  encoding: "utf8",
  stdio: "ignore",
});
process.exitCode = result.status ?? 1;
