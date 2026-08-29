import { readFile, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const config = JSON.parse(await readFile(new URL("config/maintenance.json", root), "utf8"));
if (config.deny_tenant_refresh) {
  process.stderr.write("tenant refresh rejected by maintenance policy\n");
  process.exitCode = 75;
} else {
  await writeFile(
    new URL("var/production-refresh.json", root),
    `${JSON.stringify({ tenant: "tenant-a", status: "ok" }, null, 2)}\n`,
  );
  process.stdout.write("TENANT_REFRESH_OK\n");
}
