import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { moduleRefFromSource } from "../src/plugin/module-ref.ts";
import {
  type PluginAuthorityRecord,
  type PluginOperationResourceRecord,
  PluginOperationStore,
} from "../src/plugin/operation-store.ts";
import {
  PluginTransactionHost,
  type RecoveryModule,
  type RecoveryModuleLoader,
} from "../src/plugin/transaction-host.ts";
import type { PluginModuleV0, RecoveredPlugin } from "../src/plugin/types.ts";

const directories: string[] = [];
const moduleRef = moduleRefFromSource("recovery descriptor fixture v1");

function freshStore(): PluginOperationStore {
  const directory = mkdtempSync(join(tmpdir(), "mist-plugin-recovery-"));
  directories.push(directory);
  return new PluginOperationStore(directory);
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function resource(
  registrationIndex: number,
  id: string,
  recoveryKey: string | null,
): PluginOperationResourceRecord {
  return {
    registrationIndex,
    id,
    kind: "tool",
    recoveryKey,
    phase: "ready",
  };
}

function interruptedRecord(
  resources: readonly PluginOperationResourceRecord[],
  operationModuleRef: string = moduleRef,
): PluginAuthorityRecord {
  return {
    schemaVersion: 1,
    pluginId: "fixture.plugin",
    lifecycleState: "prepared",
    enabled: true,
    moduleRef,
    config: { enabled: true },
    bindings: [],
    verifiedScope: { operations: ["call"] },
    operation: {
      operationId: "operation-interrupted",
      operation: "activate",
      phase: "activating",
      moduleRef: operationModuleRef,
      resources: [...resources],
      rollbackCompleted: false,
      disposeCompleted: false,
      cleanupAttempts: [],
    },
  };
}

function recoveryModule(options: {
  recoverCalls: { value: number };
  throwOnRecover?: boolean;
}): PluginModuleV0 {
  return {
    async prepare() {
      throw new Error("startup recovery must not call prepare");
    },
    async recover(): Promise<RecoveredPlugin> {
      options.recoverCalls.value += 1;
      if (options.throwOnRecover === true) throw new Error("fixture recovery failure");
      return {
        async revoke() {},
        async rollback() {},
        async dispose() {
          return { revoked: [], failed: [] };
        },
      };
    },
  };
}

interface InvalidDescriptorCase {
  readonly name: string;
  readonly resources: readonly PluginOperationResourceRecord[];
  readonly expectedKeys?: Readonly<Record<string, string>>;
}

const invalidDescriptors: readonly InvalidDescriptorCase[] = [
  {
    name: "missing recoveryKey",
    resources: [resource(0, "tool-a", null)],
  },
  {
    name: "duplicate recoveryKey",
    resources: [resource(0, "tool-a", "recover:shared"), resource(1, "tool-b", "recover:shared")],
  },
  {
    name: "drifting recoveryKey",
    resources: [resource(0, "tool-a", "recover:logged")],
    expectedKeys: { "tool-a": "recover:actual" },
  },
  {
    name: "invalid registration order",
    resources: [resource(1, "tool-a", "recover:tool-a")],
  },
];

describe("PluginRecoveryCoordinator fail-closed boundaries", () => {
  it.each(invalidDescriptors)("quarantines $name before calling recover", async (testCase) => {
    const store = freshStore();
    store.save(interruptedRecord(testCase.resources));
    const recoverCalls = { value: 0 };
    const module = recoveryModule({ recoverCalls });
    const host = new PluginTransactionHost({ store });

    const outcomes = await host.coordinateStartup(async () => ({
      module,
      moduleRef,
      env: {},
      ...(testCase.expectedKeys === undefined ? {} : { recoveryKeys: testCase.expectedKeys }),
    }));

    expect(outcomes).toEqual([
      {
        pluginId: "fixture.plugin",
        operationId: "operation-interrupted",
        state: "quarantined",
        reasonCode: "RECOVERY_HANDLE_UNAVAILABLE",
        remainingResourceIds: testCase.resources.map((entry) => entry.id),
      },
    ]);
    expect(recoverCalls.value).toBe(0);
    expect(
      await new PluginTransactionHost({ store }).coordinateStartup(async () => {
        throw new Error("quarantined startup must not reload the module");
      }),
    ).toEqual([]);
  });

  it("quarantines mismatched operation authority and recover(context) failure", async () => {
    const cases = ["authority mismatch", "recover failure"] as const;
    for (const testCase of cases) {
      const store = freshStore();
      const record = interruptedRecord(
        [resource(0, "tool-a", "recover:tool-a")],
        testCase === "authority mismatch"
          ? moduleRefFromSource("wrong operation module")
          : moduleRef,
      );
      store.save(record);
      const recoverCalls = { value: 0 };
      const host = new PluginTransactionHost({ store });

      const [outcome] = await host.coordinateStartup(async () => ({
        module: recoveryModule({
          recoverCalls,
          throwOnRecover: testCase === "recover failure",
        }),
        moduleRef,
        env: {},
        recoveryKeys: { "tool-a": "recover:tool-a" },
      }));

      expect(outcome?.state).toBe("quarantined");
      expect(outcome?.reasonCode).toBe("RECOVERY_HANDLE_UNAVAILABLE");
      expect(recoverCalls.value).toBe(testCase === "recover failure" ? 1 : 0);
    }
  });

  it.each(["activate", "dispose"] as const)(
    "finishes an interrupted zero-resource %s without loading the module",
    async (operation) => {
      const store = freshStore();
      const base = interruptedRecord([]);
      const interrupted: PluginAuthorityRecord = {
        ...base,
        lifecycleState: operation === "activate" ? "prepared" : "disposing",
        operation: {
          ...base.operation,
          operation,
          phase: operation === "activate" ? "activating" : "disposing",
        },
      };
      store.save(interrupted);
      const host = new PluginTransactionHost({ store });
      let loaderCalls = 0;

      const outcomes = await host.coordinateStartup(async () => {
        loaderCalls += 1;
        throw new Error("zero-resource coordination must not load a missing module");
      });

      expect(outcomes).toEqual([
        operation === "activate"
          ? {
              pluginId: "fixture.plugin",
              operationId: "operation-interrupted",
              state: "blocked",
              reasonCode: "ACTIVATE_FAILED",
            }
          : {
              pluginId: "fixture.plugin",
              operationId: "operation-interrupted",
              state: "disposed",
            },
      ]);
      expect(loaderCalls).toBe(0);
      const completed = store.read("fixture.plugin");
      expect(completed.operation.phase).toBe("completed");
      if (operation === "dispose") expect(completed.operation.disposeCompleted).toBe(true);
    },
  );

  it("requires recover whenever the interrupted operation logged resource records", async () => {
    const store = freshStore();
    store.save(interruptedRecord([resource(0, "tool-a", "recover:tool-a")]));
    const host = new PluginTransactionHost({ store });
    const module: PluginModuleV0 = {
      async prepare() {
        throw new Error("startup recovery must not call prepare");
      },
    };

    const [outcome] = await host.coordinateStartup(async () => ({ module, moduleRef, env: {} }));

    expect(outcome?.state).toBe("quarantined");
    expect(outcome?.reasonCode).toBe("RECOVERY_HANDLE_UNAVAILABLE");
    expect(store.read("fixture.plugin").operation.phase).toBe("quarantined");
  });

  it("retries plugin-level dispose even when every resource receipt is already revoked", async () => {
    const store = freshStore();
    const interrupted = interruptedRecord([
      { ...resource(0, "tool-a", "recover:tool-a"), phase: "revoked" },
    ]);
    store.save({
      ...interrupted,
      lifecycleState: "quarantined",
      reasonCode: "DISPOSE_INCOMPLETE",
      operation: {
        ...interrupted.operation,
        operation: "dispose",
        phase: "quarantined",
      },
      quarantine: {
        reasonCode: "DISPOSE_INCOMPLETE",
        remainingResourceIds: [],
        manualActions: ["Retry plugin-level disposal."],
      },
    });
    const calls = { recover: 0, revoke: 0, dispose: 0 };
    const module: PluginModuleV0 = {
      async prepare() {
        throw new Error("explicit cleanup must not call prepare");
      },
      async recover() {
        calls.recover += 1;
        return {
          async revoke() {
            calls.revoke += 1;
          },
          async rollback() {},
          async dispose() {
            calls.dispose += 1;
            return { revoked: [], failed: [] };
          },
        };
      },
    };
    const host = new PluginTransactionHost({ store });

    const outcome = await host.retryCleanup("fixture.plugin", async () => ({
      module,
      moduleRef,
      env: {},
      recoveryKeys: { "tool-a": "recover:tool-a" },
    }));

    expect(outcome.state).toBe("disposed");
    expect(calls).toEqual({ recover: 1, revoke: 0, dispose: 1 });
    expect(store.read("fixture.plugin").operation.disposeCompleted).toBe(true);
  });

  it("reports LIFECYCLE_RECOVERY_PENDING while module loading is unresolved", async () => {
    const store = freshStore();
    store.save(interruptedRecord([]));
    const host = new PluginTransactionHost({ store });
    let release: ((module: RecoveryModule) => void) | undefined;
    const loading = new Promise<RecoveryModule>((resolve) => {
      release = resolve;
    });
    const loader: RecoveryModuleLoader = async () => loading;

    const coordination = host.coordinateStartup(loader);
    expect(host.status("fixture.plugin")).toEqual({
      pluginId: "fixture.plugin",
      operationId: "operation-interrupted",
      state: "blocked",
      reasonCode: "LIFECYCLE_RECOVERY_PENDING",
    });
    const module: PluginModuleV0 = {
      async prepare() {
        throw new Error("startup recovery must not call prepare");
      },
    };
    if (release === undefined) throw new Error("loader was not started");
    release({ module, moduleRef, env: {} });

    await expect(coordination).resolves.toHaveLength(1);
    expect(host.status("fixture.plugin").reasonCode).toBe("ACTIVATE_FAILED");
  });
});
