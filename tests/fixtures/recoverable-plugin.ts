import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ActivePlugin,
  DisposeReport,
  PluginModuleV0,
  PluginPrepareContext,
  RecoveredPlugin,
  RecoveryResourceRecord,
  ResourceDeclaration,
} from "../../src/plugin/types.ts";

const dataDir = process.env.MIST_PLUGIN_DATA_DIR;
if (dataDir === undefined) throw new Error("MIST_PLUGIN_DATA_DIR is required");
const effectsDir = join(dataDir, "effects");
const callsPath = join(dataDir, "calls.log");
mkdirSync(effectsDir, { recursive: true });

export const RECOVERY_KEYS: Readonly<Record<string, string>> = Object.freeze({
  "route-a": "recover:route-a",
  "tool-b": "recover:tool-b",
  "tool-c": "recover:tool-c",
});

function logCall(value: string): void {
  appendFileSync(callsPath, `${value}\n`, { encoding: "utf8", mode: 0o600 });
}

function effectPath(id: string): string {
  return join(effectsDir, `${id}.live`);
}

function addEffect(id: string): void {
  writeFileSync(effectPath(id), id, { encoding: "utf8", mode: 0o600 });
}

function removeEffect(id: string): void {
  rmSync(effectPath(id), { force: true });
}

async function blockInsidePublishWhenRequested(): Promise<void> {
  if (process.env.MIST_PLUGIN_BLOCK_PUBLISH !== "1") return;
  process.send?.({ name: "plugin-publish-entered" });
  await new Promise<never>(() => undefined);
}

function declaration(id: string): ResourceDeclaration {
  return {
    id,
    kind: id.startsWith("route") ? "route" : "tool",
    recoveryKey: RECOVERY_KEYS[id] ?? `recover:${id}`,
    async activate() {
      logCall(`resource.activate:${id}`);
      addEffect(id);
    },
    async dispose() {
      logCall(`resource.dispose:${id}`);
      removeEffect(id);
    },
  };
}

export const fixturePlugin: PluginModuleV0 = {
  async prepare(context: PluginPrepareContext) {
    logCall("prepare");
    for (const id of ["route-a", "tool-b", "tool-c"] as const) {
      context.register(declaration(id));
    }
    return {
      async activate(): Promise<ActivePlugin> {
        logCall("prepared.activate");
        addEffect("published");
        await blockInsidePublishWhenRequested();
        return {
          async dispose(): Promise<DisposeReport> {
            logCall("active.dispose");
            removeEffect("published");
            return { revoked: [], failed: [] };
          },
        };
      },
      async rollback() {
        logCall("prepared.rollback");
        removeEffect("published");
      },
    };
  },
  async recover(context) {
    logCall("recover");
    for (const resource of context.resources) {
      if (RECOVERY_KEYS[resource.id] !== resource.recoveryKey) {
        throw new Error(`fixture cannot recover ${resource.id}`);
      }
    }
    const recovered: RecoveredPlugin = {
      async revoke(resource: RecoveryResourceRecord) {
        logCall(`recovered.revoke:${resource.id}`);
        removeEffect(resource.id);
      },
      async rollback() {
        logCall("recovered.rollback");
        removeEffect("published");
      },
      async dispose(): Promise<DisposeReport> {
        logCall("recovered.dispose");
        removeEffect("published");
        return { revoked: [], failed: [] };
      },
    };
    return recovered;
  },
};
