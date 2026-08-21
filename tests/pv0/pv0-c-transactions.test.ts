/** PV0 acceptance suite — series C: 事务注册、隔离与注销 (RFC §3/§4). */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { moduleRefFromSource } from "../../src/plugin/module-ref.ts";
import { PluginOperationStore } from "../../src/plugin/operation-store.ts";
import {
  PluginTransactionHost,
  type RecoveryModuleLoader,
} from "../../src/plugin/transaction-host.ts";
import type {
  ActivePlugin,
  DisposeReport,
  PluginModuleV0,
  PluginPrepareContext,
  PreparedPlugin,
  RecoveredPlugin,
  RecoveryResourceRecord,
  ResourceDeclaration,
} from "../../src/plugin/types.ts";

const storeDirectories: string[] = [];
const moduleRef = moduleRefFromSource("PV0-C in-process fixture v1");
const resourceIds = ["route-a", "tool-b", "timer-c"] as const;
const authority = {
  config: { enabled: true, declarationVersion: "fixture-v1" },
  bindings: [{ residentId: "resident-fixture", lane: "primary" }],
  verifiedScope: { residentId: "resident-fixture", operations: ["call"] },
};

interface FixtureControls {
  readonly failResourceActivate: Set<string>;
  readonly failResourceDispose: Set<string>;
  readonly failRecoveredRevoke: Set<string>;
  failPreparedActivate: boolean;
}

interface FixtureState {
  readonly calls: string[];
  readonly committed: Set<string>;
  readonly reachable: Set<string>;
  readonly controls: FixtureControls;
  module: PluginModuleV0;
}

function freshStore(): PluginOperationStore {
  const directory = mkdtempSync(join(tmpdir(), "mist-pv0-c-store-"));
  storeDirectories.push(directory);
  return new PluginOperationStore(directory);
}

function fixture(): FixtureState {
  const calls: string[] = [];
  const committed = new Set<string>();
  const reachable = new Set<string>();
  const controls: FixtureControls = {
    failResourceActivate: new Set(),
    failResourceDispose: new Set(),
    failRecoveredRevoke: new Set(),
    failPreparedActivate: false,
  };
  const module: PluginModuleV0 = {
    async prepare(context) {
      calls.push("prepare");
      for (const id of resourceIds) context.register(declaration(id));
      return preparedPlugin();
    },
    async recover() {
      calls.push("recover");
      const recovered: RecoveredPlugin = {
        async revoke(resource: RecoveryResourceRecord) {
          calls.push(`recovered.revoke:${resource.id}`);
          if (controls.failRecoveredRevoke.has(resource.id)) {
            throw new Error(`recovered revoke failed: ${resource.id}`);
          }
          committed.delete(resource.id);
        },
        async rollback() {
          calls.push("recovered.rollback");
          reachable.clear();
        },
        async dispose(): Promise<DisposeReport> {
          calls.push("recovered.dispose");
          reachable.clear();
          return { revoked: [], failed: [] };
        },
      };
      return recovered;
    },
  };

  function declaration(id: string): ResourceDeclaration {
    return {
      id,
      kind: id.startsWith("route") ? "route" : id.startsWith("timer") ? "timer" : "tool",
      recoveryKey: `recover:${id}`,
      async activate() {
        calls.push(`resource.activate:${id}`);
        if (controls.failResourceActivate.has(id)) {
          throw new Error(`resource activate failed: ${id}`);
        }
        committed.add(id);
      },
      async dispose() {
        calls.push(`resource.dispose:${id}`);
        if (controls.failResourceDispose.has(id)) {
          throw new Error(`resource dispose failed: ${id}`);
        }
        committed.delete(id);
      },
    };
  }

  function preparedPlugin(): PreparedPlugin {
    return {
      async activate(): Promise<ActivePlugin> {
        calls.push("prepared.activate");
        if (controls.failPreparedActivate) throw new Error("publication failed");
        for (const id of resourceIds) reachable.add(id);
        return {
          async dispose(): Promise<DisposeReport> {
            calls.push("active.dispose");
            reachable.clear();
            return { revoked: [], failed: [] };
          },
        };
      },
      async rollback() {
        calls.push("prepared.rollback");
        reachable.clear();
      },
    };
  }

  return { calls, committed, reachable, controls, module };
}

function activate(host: PluginTransactionHost, module: PluginModuleV0) {
  return host.activate({
    pluginId: "fixture.plugin",
    moduleRef,
    module,
    env: {},
    ...authority,
  });
}

function loader(state: FixtureState): RecoveryModuleLoader {
  return async () => ({
    module: state.module,
    moduleRef,
    env: {},
    recoveryKeys: Object.fromEntries(resourceIds.map((id) => [id, `recover:${id}`])),
  });
}

afterEach(() => {
  for (const directory of storeDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("PV0 series C — 事务注册、隔离与注销 (RFC §3/§4)", () => {
  it("[PV0-C01] prepare 不提前公开", async () => {
    const store = freshStore();
    let releasePrepare: (() => void) | undefined;
    let registered: (() => void) | undefined;
    const allRegistered = new Promise<void>((resolve) => {
      registered = resolve;
    });
    const prepareGate = new Promise<void>((resolve) => {
      releasePrepare = resolve;
    });
    const state = fixture();
    const originalPrepare = state.module.prepare;
    state.module = {
      ...state.module,
      async prepare(context) {
        const prepared = await originalPrepare(context);
        registered?.();
        await prepareGate;
        return prepared;
      },
    };
    const host = new PluginTransactionHost({ store });

    const activation = activate(host, state.module);
    await allRegistered;
    expect(store.read("fixture.plugin").operation.resources).toHaveLength(3);
    expect(state.committed).toEqual(new Set());
    expect(state.reachable).toEqual(new Set());
    expect(host.publishedResources("fixture.plugin")).toEqual([]);
    releasePrepare?.();
    await expect(activation).resolves.toMatchObject({ state: "active" });
  });

  it("[PV0-C02] 部分注册失败全回滚", async () => {
    const store = freshStore();
    const revoked: string[] = [];
    const declaration = (id: string): ResourceDeclaration => ({
      id,
      kind: "tool",
      recoveryKey: `recover:${id}`,
      async activate() {},
      async dispose() {
        revoked.push(id);
      },
    });
    const module: PluginModuleV0 = {
      async prepare(context: PluginPrepareContext) {
        context.register(declaration("first"));
        context.register(declaration("second"));
        context.register(declaration("first"));
        throw new Error("unreachable");
      },
    };
    const host = new PluginTransactionHost({ store });

    await expect(activate(host, module)).resolves.toMatchObject({
      state: "blocked",
      reasonCode: "PREPARE_FAILED",
    });
    expect(revoked).toEqual(["second", "first"]);
    expect(host.publishedResources("fixture.plugin")).toEqual([]);
    expect(store.read("fixture.plugin").operation.resources.map((entry) => entry.phase)).toEqual([
      "revoked",
      "revoked",
    ]);
  });

  it("[PV0-C03] activate 失败全回滚", async () => {
    const store = freshStore();
    const state = fixture();
    state.controls.failPreparedActivate = true;
    const host = new PluginTransactionHost({ store });

    await expect(activate(host, state.module)).resolves.toMatchObject({
      state: "blocked",
      reasonCode: "ACTIVATE_FAILED",
    });
    expect(state.calls.slice(-4)).toEqual([
      "resource.dispose:timer-c",
      "resource.dispose:tool-b",
      "resource.dispose:route-a",
      "prepared.rollback",
    ]);
    expect(state.committed).toEqual(new Set());
    expect(state.reachable).toEqual(new Set());
    expect(host.publishedResources("fixture.plugin")).toEqual([]);
  });

  it("[PV0-C04] 成功提交原子可见", async () => {
    const store = freshStore();
    const state = fixture();
    const projections: string[][] = [];
    const host = new PluginTransactionHost({
      store,
      checkpoint: async () => {
        projections.push(host.publishedResources("fixture.plugin").map((entry) => entry.id));
      },
    });

    await expect(activate(host, state.module)).resolves.toMatchObject({ state: "active" });
    expect(projections.every((projection) => projection.length === 0)).toBe(true);
    expect(host.publishedResources("fixture.plugin").map((entry) => entry.id)).toEqual(resourceIds);
    expect(state.reachable).toEqual(new Set(resourceIds));
  });

  it("[PV0-C05] dispose 幂等", async () => {
    const store = freshStore();
    const state = fixture();
    let sequence = 0;
    const host = new PluginTransactionHost({
      store,
      newOperationId: () => `operation-${String(++sequence)}`,
    });
    await activate(host, state.module);

    const first = await host.dispose("fixture.plugin");
    const callsAfterFirst = [...state.calls];
    const second = await host.dispose("fixture.plugin");

    expect(first).toEqual(second);
    expect(first.state).toBe("disposed");
    expect(state.calls).toEqual(callsAfterFirst);
    expect(state.calls.filter((call) => call.startsWith("resource.dispose:"))).toEqual([
      "resource.dispose:timer-c",
      "resource.dispose:tool-b",
      "resource.dispose:route-a",
    ]);
    expect(host.publishedResources("fixture.plugin")).toEqual([]);
  });

  // STUBBED-PENDING: the frozen host has no call dispatcher/in-flight registry yet.
  it.todo("[PV0-C06] 注销先断路");

  it("[PV0-C07] 清理失败 fail-closed", async () => {
    const store = freshStore();
    const state = fixture();
    state.controls.failResourceDispose.add("tool-b");
    const host = new PluginTransactionHost({ store });
    await activate(host, state.module);

    await expect(host.dispose("fixture.plugin")).resolves.toMatchObject({
      state: "quarantined",
      reasonCode: "DISPOSE_INCOMPLETE",
      remainingResourceIds: ["tool-b"],
    });
    expect(host.publishedResources("fixture.plugin")).toEqual([]);
    expect(store.read("fixture.plugin").quarantine).toMatchObject({
      reasonCode: "DISPOSE_INCOMPLETE",
      remainingResourceIds: ["tool-b"],
    });
  });

  // STUBBED-PENDING: runtime call isolation/timeout belongs to the absent dispatcher layer.
  it.todo("[PV0-C08] 单插件故障不拖地基");
  // STUBBED-PENDING: there is no production call scheduler whose retry policy can be observed.
  it.todo("[PV0-C09] 不自动重试风暴");

  it("[PV0-C12] quarantined 只能显式清理重试", async () => {
    const store = freshStore();
    const state = fixture();
    state.controls.failResourceDispose.add("tool-b");
    state.controls.failRecoveredRevoke.add("tool-b");
    const host = new PluginTransactionHost({ store });
    await activate(host, state.module);
    const quarantined = await host.dispose("fixture.plugin");
    const callsAfterDispose = [...state.calls];

    expect(await host.dispose("fixture.plugin")).toEqual(quarantined);
    expect(state.calls).toEqual(callsAfterDispose);
    const failedRetry = await host.retryCleanup("fixture.plugin", loader(state));
    expect(failedRetry).toMatchObject({
      state: "quarantined",
      reasonCode: "RECOVERY_HANDLE_UNAVAILABLE",
      remainingResourceIds: ["tool-b"],
    });
    expect(store.read("fixture.plugin").operation.cleanupAttempts[0]).toMatchObject({
      failedResourceIds: ["tool-b"],
      reasonCode: "RECOVERY_HANDLE_UNAVAILABLE",
    });
    expect(store.read("fixture.plugin").quarantine?.manualActions.join(" ")).toContain("tool-b");

    state.controls.failRecoveredRevoke.clear();
    await expect(host.retryCleanup("fixture.plugin", loader(state))).resolves.toMatchObject({
      state: "disposed",
    });
    expect(host.publishedResources("fixture.plugin")).toEqual([]);
  });

  it("[PV0-C13] 两个 activate 顺序固定", async () => {
    const store = freshStore();
    const calls: string[] = [];
    const committed = new Set<string>();
    const module: PluginModuleV0 = {
      async prepare(context) {
        for (const id of resourceIds) {
          context.register({
            id,
            kind: "tool",
            recoveryKey: `recover:${id}`,
            async activate() {
              calls.push(`resource.activate:${id}`);
              committed.add(id);
            },
            async dispose() {
              calls.push(`resource.dispose:${id}`);
              committed.delete(id);
            },
          });
        }
        return {
          async activate() {
            calls.push("prepared.activate");
            expect(committed).toEqual(new Set(resourceIds));
            expect(host.publishedResources("fixture.plugin")).toEqual([]);
            expect(store.read("fixture.plugin")).toMatchObject({
              lifecycleState: "active",
              config: authority.config,
              bindings: authority.bindings,
              verifiedScope: authority.verifiedScope,
            });
            return {
              async dispose() {
                return { revoked: [], failed: [] };
              },
            };
          },
          async rollback() {},
        };
      },
    };
    const host = new PluginTransactionHost({ store });
    await expect(activate(host, module)).resolves.toMatchObject({ state: "active" });
    expect(calls).toEqual([
      "resource.activate:route-a",
      "resource.activate:tool-b",
      "resource.activate:timer-c",
      "prepared.activate",
    ]);

    const failedState = fixture();
    failedState.controls.failResourceActivate.add("tool-b");
    const failedHost = new PluginTransactionHost({ store: freshStore() });
    await expect(activate(failedHost, failedState.module)).resolves.toMatchObject({
      state: "blocked",
      reasonCode: "ACTIVATE_FAILED",
    });
    expect(failedState.calls).not.toContain("prepared.activate");
    expect(failedHost.publishedResources("fixture.plugin")).toEqual([]);
  });
});
