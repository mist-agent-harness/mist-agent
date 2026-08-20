/** PV0 acceptance suite — series C: 跨进程生命周期恢复与权威投影 (RFC §3). */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { moduleRefFromSource } from "../../src/plugin/module-ref.ts";
import {
  type PluginAuthorityRecord,
  type PluginOperationResourceRecord,
  PluginOperationStore,
} from "../../src/plugin/operation-store.ts";
import { PluginTransactionHost, type RecoveryModule } from "../../src/plugin/transaction-host.ts";
import type { PluginModuleV0 } from "../../src/plugin/types.ts";
import {
  cleanupProcessHarness,
  collectChild,
  freshProcessDirectory,
  killChildAt,
  processCalls,
  processEffects,
  processOperationRecord,
  startPluginHostChild,
} from "./pv0-c-process-harness.ts";

const storeDirectories: string[] = [];
const moduleRef = moduleRefFromSource("PV0-C in-process fixture v1");
const authority = {
  config: { enabled: true, declarationVersion: "fixture-v1" },
  bindings: [{ residentId: "resident-fixture", lane: "primary" }],
  verifiedScope: { residentId: "resident-fixture", operations: ["call"] },
};

function freshStore(): PluginOperationStore {
  const directory = mkdtempSync(join(tmpdir(), "mist-pv0-c-store-"));
  storeDirectories.push(directory);
  return new PluginOperationStore(directory);
}

afterEach(async () => {
  await cleanupProcessHarness();
  for (const directory of storeDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("PV0 series C — 跨进程生命周期恢复与权威投影 (RFC §3)", () => {
  it("[PV0-C10] 生命周期中断可恢复", async () => {
    const activationDir = freshProcessDirectory();
    const activationChild = startPluginHostChild(activationDir, "activate", {
      stopAt: "resource-effect-before-receipt",
    });
    await killChildAt(activationChild, "resource-effect-before-receipt");
    const activationRecord = processOperationRecord(activationDir);
    expect(activationRecord.operation.operationId).toBe("fixture-operation-1");
    expect(activationRecord.moduleRef).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(activationRecord.operation.resources.map((entry) => entry.recoveryKey)).toEqual([
      "recover:route-a",
      "recover:tool-b",
      "recover:tool-c",
    ]);
    expect(processEffects(activationDir)).toContain("route-a.live");
    const activationCallCount = processCalls(activationDir).length;
    const activationRecovered = await collectChild(startPluginHostChild(activationDir, "recover"));
    expect(activationRecovered.outcomes[0]).toMatchObject({
      state: "blocked",
      reasonCode: "ACTIVATE_FAILED",
      operationId: "fixture-operation-1",
    });
    expect(activationRecovered.authority).toMatchObject({
      enabled: true,
      config: authority.config,
      bindings: authority.bindings,
    });
    expect(activationRecovered.published).toEqual([]);
    expect(processEffects(activationDir)).toEqual([]);
    expect(processCalls(activationDir).slice(activationCallCount)).toEqual([
      "recover",
      "recovered.revoke:tool-c",
      "recovered.revoke:tool-b",
      "recovered.revoke:route-a",
      "recovered.rollback",
    ]);

    const publishDir = freshProcessDirectory();
    const publishChild = startPluginHostChild(publishDir, "activate", { blockPublish: true });
    await killChildAt(publishChild, "plugin-publish-entered");
    expect(processOperationRecord(publishDir).operation.phase).toBe("authority_committed");
    expect(processEffects(publishDir)).toEqual([
      "published.live",
      "route-a.live",
      "tool-b.live",
      "tool-c.live",
    ]);
    const publishCallCount = processCalls(publishDir).length;
    const publishRecovered = await collectChild(startPluginHostChild(publishDir, "recover"));
    expect(publishRecovered.outcomes[0]).toMatchObject({
      state: "blocked",
      reasonCode: "ACTIVATE_FAILED",
    });
    expect(publishRecovered.published).toEqual([]);
    expect(processEffects(publishDir)).toEqual([]);
    expect(processCalls(publishDir).slice(publishCallCount)).toEqual([
      "recover",
      "recovered.revoke:tool-c",
      "recovered.revoke:tool-b",
      "recovered.revoke:route-a",
      "recovered.rollback",
    ]);

    const disposeDir = freshProcessDirectory();
    const disposeChild = startPluginHostChild(disposeDir, "activate-dispose", {
      stopAt: "dispose-resource-effect-before-receipt",
    });
    await killChildAt(disposeChild, "dispose-resource-effect-before-receipt");
    expect(processOperationRecord(disposeDir).operation.operation).toBe("dispose");
    const disposeRecovered = await collectChild(startPluginHostChild(disposeDir, "recover"));
    expect(disposeRecovered.authority.lifecycleState).toBe("disposed");
    expect(disposeRecovered.authority.operation.disposeCompleted).toBe(true);
    expect(disposeRecovered.published).toEqual([]);
    expect(processEffects(disposeDir)).toEqual([]);

    const resource = (
      registrationIndex: number,
      id: string,
      recoveryKey: string | null,
    ): PluginOperationResourceRecord => ({
      registrationIndex,
      id,
      kind: "tool",
      recoveryKey,
      phase: "ready",
    });
    const interruptedRecord = (
      resources: readonly PluginOperationResourceRecord[],
    ): PluginAuthorityRecord => ({
      schemaVersion: 1,
      pluginId: "fixture.plugin",
      lifecycleState: "prepared",
      enabled: true,
      moduleRef,
      ...authority,
      operation: {
        operationId: "operation-interrupted",
        operation: "activate",
        phase: "activating",
        moduleRef,
        resources: [...resources],
        rollbackCompleted: false,
        disposeCompleted: false,
        cleanupAttempts: [],
      },
    });
    const invalidCases: readonly {
      readonly name: string;
      readonly resources: readonly PluginOperationResourceRecord[];
      readonly recoveryKeys?: Readonly<Record<string, string>>;
    }[] = [
      {
        name: "missing recovery key",
        resources: [resource(0, "tool-a", null)],
      },
      {
        name: "duplicate recovery key",
        resources: [
          resource(0, "tool-a", "recover:shared"),
          resource(1, "tool-b", "recover:shared"),
        ],
      },
      {
        name: "drifting recovery key",
        resources: [resource(0, "tool-a", "recover:logged")],
        recoveryKeys: { "tool-a": "recover:actual" },
      },
    ];
    for (const invalidCase of invalidCases) {
      const invalidStore = freshStore();
      invalidStore.save(interruptedRecord(invalidCase.resources));
      let recoverCalls = 0;
      const recoveryModule: PluginModuleV0 = {
        async prepare() {
          throw new Error("startup recovery must not prepare");
        },
        async recover() {
          recoverCalls += 1;
          throw new Error("invalid descriptors must be rejected before recover");
        },
      };
      const [outcome] = await new PluginTransactionHost({ store: invalidStore }).coordinateStartup(
        async () => ({
          module: recoveryModule,
          moduleRef,
          env: {},
          ...(invalidCase.recoveryKeys === undefined
            ? {}
            : { recoveryKeys: invalidCase.recoveryKeys }),
        }),
      );
      expect(outcome, invalidCase.name).toMatchObject({
        state: "quarantined",
        reasonCode: "RECOVERY_HANDLE_UNAVAILABLE",
      });
      expect(recoverCalls, invalidCase.name).toBe(0);
      expect(invalidStore.read("fixture.plugin").quarantine).toMatchObject({
        remainingResourceIds: invalidCase.resources.map((entry) => entry.id),
      });
      await expect(
        new PluginTransactionHost({ store: invalidStore }).coordinateStartup(async () => {
          throw new Error("quarantined record must not be retried automatically");
        }),
      ).resolves.toEqual([]);
    }

    const failureCases = ["module drift", "recover throws"] as const;
    for (const failureCase of failureCases) {
      const failureStore = freshStore();
      failureStore.save(interruptedRecord([resource(0, "tool-a", "recover:tool-a")]));
      let recoverCalls = 0;
      const recoveryModule: PluginModuleV0 = {
        async prepare() {
          throw new Error("startup recovery must not prepare");
        },
        async recover() {
          recoverCalls += 1;
          throw new Error("fixture recover failure");
        },
      };
      const [outcome] = await new PluginTransactionHost({ store: failureStore }).coordinateStartup(
        async () => ({
          module: recoveryModule,
          moduleRef:
            failureCase === "module drift"
              ? moduleRefFromSource("PV0-C changed module")
              : moduleRef,
          env: {},
          recoveryKeys: { "tool-a": "recover:tool-a" },
        }),
      );
      expect(outcome, failureCase).toMatchObject({
        state: "quarantined",
        reasonCode: "RECOVERY_HANDLE_UNAVAILABLE",
        remainingResourceIds: ["tool-a"],
      });
      expect(recoverCalls, failureCase).toBe(failureCase === "recover throws" ? 1 : 0);
      expect(failureStore.read("fixture.plugin").quarantine?.manualActions).not.toEqual([]);
    }

    const pendingStore = freshStore();
    pendingStore.save(interruptedRecord([resource(0, "tool-a", "recover:tool-a")]));
    const pendingHost = new PluginTransactionHost({ store: pendingStore });
    let releaseLoader: ((loaded: RecoveryModule) => void) | undefined;
    const unresolvedLoader = new Promise<RecoveryModule>((resolve) => {
      releaseLoader = resolve;
    });
    const coordination = pendingHost.coordinateStartup(async () => unresolvedLoader);
    expect(pendingHost.status("fixture.plugin")).toMatchObject({
      state: "blocked",
      reasonCode: "LIFECYCLE_RECOVERY_PENDING",
    });
    const recoveredModule: PluginModuleV0 = {
      async prepare() {
        throw new Error("startup recovery must not prepare");
      },
      async recover() {
        return {
          async revoke() {},
          async rollback() {},
          async dispose() {
            return { revoked: [], failed: [] };
          },
        };
      },
    };
    releaseLoader?.({
      module: recoveredModule,
      moduleRef,
      env: {},
      recoveryKeys: { "tool-a": "recover:tool-a" },
    });
    await expect(coordination).resolves.toEqual([
      expect.objectContaining({ state: "blocked", reasonCode: "ACTIVATE_FAILED" }),
    ]);
  }, 30_000);

  it("[PV0-C11] 权威状态先于公开索引", async () => {
    // 取证边界（PR#97 评审「不挡」项）：#published 纯内存，SIGKILL 后跨进程恒为空集。
    // 三个切点在重启面证明的是「公开索引 ⊆ 权威 active」以空集成立 + 权威账完好，
    // 空集不是「完整投影」的证据——提交前不可见性由进程内 C04/C13 取证；重启后重建
    // 公开索引属热加载，单B 范围外，接线时别把本条误读成已覆盖。
    const checkpoints = [
      "before-active-authority-commit",
      "active-authority-committed-before-publish",
      "published-before-operation-complete",
    ] as const;
    for (const checkpoint of checkpoints) {
      const dataDir = freshProcessDirectory();
      const child = startPluginHostChild(dataDir, "activate", { stopAt: checkpoint });
      await killChildAt(child, checkpoint);
      const interrupted = processOperationRecord(dataDir);
      expect(interrupted.lifecycleState).toBe(
        checkpoint === "before-active-authority-commit" ? "prepared" : "active",
      );
      const recovered = await collectChild(startPluginHostChild(dataDir, "recover"));
      expect(recovered.published).toEqual([]);
      expect(recovered.authority.lifecycleState).toBe("blocked");
      expect(processEffects(dataDir)).toEqual([]);
    }
  }, 30_000);

  it("[PV0-C14] 恢复凭据防模块漂移", async () => {
    const dataDir = freshProcessDirectory();
    const sourcePath = join(dataDir, "fixture-module.ts");
    const originalFixturePath = fileURLToPath(
      new URL("../fixtures/recoverable-plugin.ts", import.meta.url),
    );
    const originalFixtureSource = readFileSync(originalFixturePath, "utf8");
    const fixtureV1 = `${originalFixtureSource}\nexport const declarationVersion = "fixture-v1";\n`;
    writeFileSync(sourcePath, fixtureV1, "utf8");
    const expectedModuleRef = moduleRefFromSource(readFileSync(sourcePath));
    const child = startPluginHostChild(dataDir, "activate", {
      stopAt: "resource-effect-before-receipt",
      moduleSourcePath: sourcePath,
    });
    await killChildAt(child, "resource-effect-before-receipt");
    expect(processOperationRecord(dataDir).moduleRef).toBe(expectedModuleRef);
    const callsBeforeRecovery = processCalls(dataDir).length;

    writeFileSync(sourcePath, `${fixtureV1}\n// changed in place without a version bump\n`, "utf8");
    const actualModuleRef = moduleRefFromSource(readFileSync(sourcePath));
    expect(actualModuleRef).not.toBe(expectedModuleRef);
    const recovered = await collectChild(
      startPluginHostChild(dataDir, "recover", { moduleSourcePath: sourcePath }),
    );

    expect(recovered.outcomes[0]).toMatchObject({
      state: "quarantined",
      reasonCode: "RECOVERY_HANDLE_UNAVAILABLE",
    });
    expect(processCalls(dataDir).slice(callsBeforeRecovery)).toEqual([]);
    expect(recovered.authority.quarantine?.manualActions.join(" ")).toContain(expectedModuleRef);
    expect(recovered.authority.quarantine?.manualActions.join(" ")).toContain(actualModuleRef);
    const restarted = await collectChild(
      startPluginHostChild(dataDir, "recover", { moduleSourcePath: sourcePath }),
    );
    expect(restarted.outcomes).toEqual([]);
    expect(restarted.authority.quarantine?.manualActions).toEqual(
      recovered.authority.quarantine?.manualActions,
    );
  }, 20_000);
});
