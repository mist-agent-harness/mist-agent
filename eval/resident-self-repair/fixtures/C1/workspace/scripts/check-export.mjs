import { readFile } from "node:fs/promises";
import { exportArchive } from "../src/archive-export.mjs";

const config = JSON.parse(
  await readFile(new URL("../config/routes.json", import.meta.url), "utf8"),
);
if (config.archive_export?.enabled !== true) {
  throw new Error("archive export route is disabled");
}
const result = JSON.parse(exportArchive([{ id: "synthetic-record" }]));
if (result.version !== 1 || result.records.length !== 1) {
  throw new Error("archive export implementation returned an invalid envelope");
}
process.stdout.write("ARCHIVE_EXPORT_OK\n");
