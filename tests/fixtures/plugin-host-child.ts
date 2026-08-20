import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { moduleRefFromSource } from "../../src/plugin/module-ref.ts";
import { PluginOperationStore } from "../../src/plugin/operation-store.ts";
import { type PluginCheckpoint, PluginTransactionHost } from "../../src/plugin/transaction-host.ts";
import type { PluginModuleV0 } from "../../src/plugin/types.ts";

const dataDir = process.env.MIST_PLUGIN_DATA_DIR;
if (dataDir === undefined) throw new Error("MIST_PLUGIN_DATA_DIR is required");
const command = process.argv[2];
if (command !== "activate" && command !== "activate-dispose" && command !== "recover") {
  throw new Error(`unsupported fixture command: ${String(command)}`);
}

const fixturePath = fileURLToPath(new URL("./recoverable-plugin.ts", import.meta.url));
const moduleSourcePath = process.env.MIST_PLUGIN_MODULE_SOURCE_PATH ?? fixturePath;
const loadedFixture = (await import(pathToFileURL(moduleSourcePath).href)) as {
  readonly fixturePlugin: PluginModuleV0;
  readonly RECOVERY_KEYS: Readonly<Record<string, string>>;
  readonly declarationVersion?: string;
};
const { fixturePlugin, RECOVERY_KEYS } = loadedFixture;
const moduleRef = moduleRefFromSource(readFileSync(moduleSourcePath));
const store = new PluginOperationStore(join(dataDir, "operations"));
let operationSequence = 0;
const stopAt = process.env.MIST_PLUGIN_STOP_AT;

async function checkpoint(value: PluginCheckpoint): Promise<void> {
  if (value.name !== stopAt) return;
  process.send?.(value);
  await new Promise<never>(() => undefined);
}

const host = new PluginTransactionHost({
  store,
  newOperationId: () => {
    operationSequence += 1;
    return `fixture-operation-${String(operationSequence)}`;
  },
  checkpoint,
});

const activation = {
  pluginId: "fixture.plugin",
  moduleRef,
  module: fixturePlugin,
  config: {
    enabled: true,
    declarationVersion: loadedFixture.declarationVersion ?? "fixture-v1",
    settings: { moduleSourcePath },
  },
  env: {},
  bindings: [{ residentId: "resident-fixture", lane: "primary" }],
  verifiedScope: {
    residentId: "resident-fixture",
    lane: "primary",
    operations: ["call"],
    verifiedAt: "2026-08-20T00:00:00.000Z",
  },
} as const;

if (command === "activate" || command === "activate-dispose") {
  const activated = await host.activate(activation);
  const outcomes = [activated];
  if (command === "activate-dispose") outcomes.push(await host.dispose("fixture.plugin"));
  process.stdout.write(
    JSON.stringify({
      outcomes,
      published: host.publishedResources("fixture.plugin").map((resource) => resource.id),
      authority: store.read("fixture.plugin"),
    }),
  );
} else {
  const outcomes = await host.coordinateStartup(async () => ({
    module: fixturePlugin,
    moduleRef,
    env: {},
    recoveryKeys: RECOVERY_KEYS,
  }));
  process.stdout.write(
    JSON.stringify({
      outcomes,
      published: host.publishedResources("fixture.plugin").map((resource) => resource.id),
      authority: store.read("fixture.plugin"),
    }),
  );
}
