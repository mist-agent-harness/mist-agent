import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { moduleRefFromSource } from "../src/plugin/module-ref.ts";
import { type PluginAuthorityRecord, PluginOperationStore } from "../src/plugin/operation-store.ts";
import {
  type PluginCheckpoint,
  PluginTransactionHost,
  type RecoveryModuleLoader,
} from "../src/plugin/transaction-host.ts";
import type {
  ActivePlugin,
  DisposeReport,
  PluginModuleV0,
  PluginPrepareContext,
  RecoveredPlugin,
  RecoveryResourceRecord,
  ResourceDeclaration,
} from "../src/plugin/types.ts";

const directories: string[] = [];

function freshStore(): PluginOperationStore {
  const directory = mkdtempSync(join(tmpdir(), "mist-plugin-operations-"));
  directories.push(directory);
  return new PluginOperationStore(directory);
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface FixtureControls {
  failDisposeIds: Set<string>;
  failRecoveredIds: Set<string>;
}

interface FixtureCalls {
  prepare: number;
  resourceActivate: string[];
  resourceDispose: string[];
  publish: number;
  activeDispose: number;
  recover: number;
  recoveredRevoke: string[];
  recoveredRollback: number;
  recoveredDispose: number;
}

function fixtureModule(
  resourceIds: readonly string[],
  effects: Set<string>,
  controls: FixtureControls,
): { module: PluginModuleV0; calls: FixtureCalls } {
  const calls: FixtureCalls = {
    prepare: 0,
    resourceActivate: [],
    resourceDispose: [],
    publish: 0,
    activeDispose: 0,
    recover: 0,
    recoveredRevoke: [],
    recoveredRollback: 0,
    recoveredDispose: 0,
  };

  const module: PluginModuleV0 = {
    async prepare(context: PluginPrepareContext) {
      calls.prepare += 1;
      for (const id of resourceIds) {
        const resource: ResourceDeclaration = {
          id,
          kind: id.startsWith("route") ? "route" : "tool",
          recoveryKey: `recover:${id}`,
          async activate() {
            calls.resourceActivate.push(id);
            effects.add(id);
          },
          async dispose() {
            calls.resourceDispose.push(id);
            if (controls.failDisposeIds.has(id)) throw new Error(`dispose failed: ${id}`);
            effects.delete(id);
          },
        };
        context.register(resource);
      }
      return {
        async activate(): Promise<ActivePlugin> {
          calls.publish += 1;
          return {
            async dispose(): Promise<DisposeReport> {
              calls.activeDispose += 1;
              return { revoked: [], failed: [] };
            },
          };
        },
        async rollback() {
          // Resource handles own the individual cleanup in the current process.
        },
      };
    },
    async recover() {
      calls.recover += 1;
      const recovered: RecoveredPlugin = {
        async revoke(resource: RecoveryResourceRecord) {
          calls.recoveredRevoke.push(resource.id);
          if (controls.failRecoveredIds.has(resource.id)) {
            throw new Error(`recovery failed: ${resource.id}`);
          }
          effects.delete(resource.id);
        },
        async rollback() {
          calls.recoveredRollback += 1;
        },
        async dispose(): Promise<DisposeReport> {
          calls.recoveredDispose += 1;
          return { revoked: [], failed: [] };
        },
      };
      return recovered;
    },
  };
  return { module, calls };
}

const authorityFields = {
  config: { enabled: true, settings: { fixture: true } },
  bindings: [{ residentId: "resident-fixture", lane: "primary" }],
  verifiedScope: {
    residentId: "resident-fixture",
    lane: "primary",
    operations: ["call"],
    verifiedAt: "2026-08-20T00:00:00.000Z",
  },
};

function recoveryLoader(
  module: PluginModuleV0,
  moduleRef: string,
  recoveryKeys?: Readonly<Record<string, string>>,
): RecoveryModuleLoader {
  return async () => ({
    module,
    moduleRef,
    env: {},
    ...(recoveryKeys === undefined ? {} : { recoveryKeys }),
  });
}

describe("PluginTransactionHost durable ordering", () => {
  it("persists operation and recovery descriptors before effects, then authority before publish", async () => {
    const store = freshStore();
    const effects = new Set<string>();
    const fixture = fixtureModule(["route-a", "tool-b", "tool-c"], effects, {
      failDisposeIds: new Set(),
      failRecoveredIds: new Set(),
    });
    const checkpoints: PluginCheckpoint[] = [];
    const snapshots: PluginAuthorityRecord[] = [];
    const host = new PluginTransactionHost({
      store,
      newOperationId: () => "operation-activate-1",
      checkpoint: async (checkpoint) => {
        checkpoints.push(checkpoint);
        snapshots.push(store.read("fixture.plugin"));
      },
    });
    const moduleRef = moduleRefFromSource("fixture module v1");

    const outcome = await host.activate({
      pluginId: "fixture.plugin",
      moduleRef,
      module: fixture.module,
      env: {},
      ...authorityFields,
    });

    expect(outcome).toEqual({
      pluginId: "fixture.plugin",
      operationId: "operation-activate-1",
      state: "active",
    });
    expect(checkpoints.map((entry) => entry.name)).toEqual([
      "operation-persisted",
      "resource-effect-before-receipt",
      "resource-effect-before-receipt",
      "resource-effect-before-receipt",
      "before-active-authority-commit",
      "active-authority-committed-before-publish",
      "published-before-operation-complete",
    ]);

    const operationPersisted = snapshots[0];
    expect(operationPersisted?.operation.phase).toBe("preparing");
    expect(operationPersisted?.operation.resources).toEqual([]);
    expect(fixture.calls.prepare).toBe(1);

    const effectSnapshots = snapshots.filter(
      (_snapshot, index) => checkpoints[index]?.name === "resource-effect-before-receipt",
    );
    expect(effectSnapshots.map((snapshot) => snapshot.operation.resources.at(-1)?.phase)).toEqual([
      "registered",
      "registered",
      "registered",
    ]);

    const committedIndex = checkpoints.findIndex(
      (entry) => entry.name === "active-authority-committed-before-publish",
    );
    expect(snapshots[committedIndex]?.lifecycleState).toBe("active");
    expect(snapshots[committedIndex]?.operation.phase).toBe("authority_committed");
    expect(fixture.calls.resourceActivate).toEqual(["route-a", "tool-b", "tool-c"]);
    expect(fixture.calls.publish).toBe(1);

    const final = store.read("fixture.plugin");
    expect(final.operation.phase).toBe("completed");
    expect(final.operation.resources.map((resource) => resource.phase)).toEqual([
      "ready",
      "ready",
      "ready",
    ]);
    expect(host.publishedResources("fixture.plugin").map((resource) => resource.id)).toEqual([
      "route-a",
      "tool-b",
      "tool-c",
    ]);
    expect(effects).toEqual(new Set(["route-a", "tool-b", "tool-c"]));
  });

  it("keeps quarantined fail-closed until retryCleanup is explicitly called", async () => {
    const store = freshStore();
    const effects = new Set<string>();
    const controls: FixtureControls = {
      failDisposeIds: new Set(["tool-b"]),
      failRecoveredIds: new Set(["tool-b"]),
    };
    const fixture = fixtureModule(["route-a", "tool-b", "tool-c"], effects, controls);
    let operationSequence = 0;
    const host = new PluginTransactionHost({
      store,
      newOperationId: () => {
        operationSequence += 1;
        return `operation-${String(operationSequence)}`;
      },
    });
    const moduleRef = moduleRefFromSource("fixture module v1");
    await host.activate({
      pluginId: "fixture.plugin",
      moduleRef,
      module: fixture.module,
      env: {},
      ...authorityFields,
    });

    const firstDispose = await host.dispose("fixture.plugin");
    expect(firstDispose.state).toBe("quarantined");
    expect(firstDispose.reasonCode).toBe("DISPOSE_INCOMPLETE");
    expect(firstDispose.remainingResourceIds).toEqual(["tool-b"]);
    expect(host.publishedResources("fixture.plugin")).toEqual([]);
    const callsAfterFailure = [...fixture.calls.resourceDispose];

    const repeatedDispose = await host.dispose("fixture.plugin");
    expect(repeatedDispose).toEqual(firstDispose);
    expect(fixture.calls.resourceDispose).toEqual(callsAfterFailure);
    expect(fixture.calls.recover).toBe(0);

    const keys = {
      "route-a": "recover:route-a",
      "tool-b": "recover:tool-b",
      "tool-c": "recover:tool-c",
    };
    const failedRetry = await host.retryCleanup(
      "fixture.plugin",
      recoveryLoader(fixture.module, moduleRef, keys),
    );
    expect(failedRetry.state).toBe("quarantined");
    expect(failedRetry.remainingResourceIds).toEqual(["tool-b"]);
    expect(store.read("fixture.plugin").operation.cleanupAttempts).toHaveLength(1);
    expect(store.read("fixture.plugin").operation.cleanupAttempts[0]).toMatchObject({
      failedResourceIds: ["tool-b"],
      reasonCode: "RECOVERY_HANDLE_UNAVAILABLE",
    });
    expect(
      store.read("fixture.plugin").operation.cleanupAttempts[0]?.manualActions.join(" "),
    ).toContain("tool-b");

    controls.failRecoveredIds.clear();
    const successfulRetry = await host.retryCleanup(
      "fixture.plugin",
      recoveryLoader(fixture.module, moduleRef, keys),
    );
    expect(successfulRetry).toEqual({
      pluginId: "fixture.plugin",
      operationId: "operation-2",
      state: "disposed",
    });
    expect(store.read("fixture.plugin").operation.phase).toBe("completed");
    expect(fixture.calls.recoveredDispose).toBe(1);
    expect(effects).toEqual(new Set());
  });

  it("quarantines module drift before recover and preserves expected/actual refs", async () => {
    const store = freshStore();
    const effects = new Set(["route-a"]);
    const fixture = fixtureModule(["route-a"], effects, {
      failDisposeIds: new Set(),
      failRecoveredIds: new Set(),
    });
    const expectedModuleRef = moduleRefFromSource("fixture module v1");
    const actualModuleRef = moduleRefFromSource("fixture module v1 changed in place");
    store.save({
      schemaVersion: 1,
      pluginId: "fixture.plugin",
      lifecycleState: "prepared",
      enabled: true,
      moduleRef: expectedModuleRef,
      ...authorityFields,
      operation: {
        operationId: "operation-interrupted",
        operation: "activate",
        phase: "activating",
        moduleRef: expectedModuleRef,
        resources: [
          {
            registrationIndex: 0,
            id: "route-a",
            kind: "route",
            recoveryKey: "recover:route-a",
            phase: "registered",
          },
        ],
        rollbackCompleted: false,
        disposeCompleted: false,
        cleanupAttempts: [],
      },
    });
    const host = new PluginTransactionHost({ store });

    const outcomes = await host.coordinateStartup(
      recoveryLoader(fixture.module, actualModuleRef, { "route-a": "recover:route-a" }),
    );

    expect(outcomes).toEqual([
      {
        pluginId: "fixture.plugin",
        operationId: "operation-interrupted",
        state: "quarantined",
        reasonCode: "RECOVERY_HANDLE_UNAVAILABLE",
        remainingResourceIds: ["route-a"],
      },
    ]);
    expect(fixture.calls.recover).toBe(0);
    expect(effects).toEqual(new Set(["route-a"]));
    expect(store.read("fixture.plugin").quarantine?.manualActions.join(" ")).toContain(
      expectedModuleRef,
    );
    expect(store.read("fixture.plugin").quarantine?.manualActions.join(" ")).toContain(
      actualModuleRef,
    );
    expect(host.publishedResources("fixture.plugin")).toEqual([]);
  });
});
