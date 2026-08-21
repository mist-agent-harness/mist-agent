import { randomUUID } from "node:crypto";
import { type PluginActivateRefusal, refuseActiveIdOverwrite } from "./install-gate.ts";
import { isSelfDescribingModuleRef } from "./module-ref.ts";
import type {
  PluginAuthorityRecord,
  PluginOperationResourceRecord,
  PluginOperationStore,
} from "./operation-store.ts";
import {
  type PluginOperationOutcome,
  PluginRecoveryCoordinator,
  type RecoveryModuleLoader,
  operationOutcome,
} from "./recovery-coordinator.ts";
import {
  type ReadinessProjection,
  type ReadinessReceipt,
  type ReadinessScope,
  isReadinessReceipt,
  isReadinessScope,
  projectReadiness,
} from "./runtime-readiness.ts";
import type {
  ActivePlugin,
  DisposableHandle,
  PluginModuleV0,
  PluginPrepareContext,
  PreparedPlugin,
  ResourceDeclaration,
} from "./types.ts";

export type {
  PluginOperationOutcome,
  RecoveryModule,
  RecoveryModuleLoader,
} from "./recovery-coordinator.ts";
export type { PluginActivateRefusal } from "./install-gate.ts";

export type PluginCheckpointName =
  | "operation-persisted"
  | "resource-effect-before-receipt"
  | "before-active-authority-commit"
  | "active-authority-committed-before-publish"
  | "published-before-operation-complete"
  | "dispose-resource-effect-before-receipt";

export interface PluginCheckpoint {
  readonly name: PluginCheckpointName;
  readonly pluginId: string;
  readonly operationId: string;
  readonly resourceId?: string;
}

export interface ActivatePluginRequest {
  readonly pluginId: string;
  readonly moduleRef: string;
  readonly module: PluginModuleV0;
  readonly config: unknown;
  readonly env: Readonly<Record<string, string>>;
  readonly bindings: unknown;
  readonly verifiedScope: unknown;
  readonly readiness?: ReadinessReceipt;
}

export interface PublishedPluginResource {
  readonly id: string;
  readonly kind: ResourceDeclaration["kind"];
  readonly capabilityId?: string;
}

interface RegisteredResource {
  readonly declaration: ResourceDeclaration;
  readonly record: PluginOperationResourceRecord;
  revoked: boolean;
}

interface ActiveRuntime {
  readonly activePlugin: ActivePlugin;
  readonly resources: RegisteredResource[];
}

export interface PluginTransactionHostOptions {
  readonly store: PluginOperationStore;
  readonly newOperationId?: () => string;
  readonly checkpoint?: (checkpoint: PluginCheckpoint) => Promise<void>;
}

/** Durable Plugin Protocol v0 lifecycle executor and startup recovery coordinator. */
export class PluginTransactionHost {
  readonly #store: PluginOperationStore;
  readonly #newOperationId: () => string;
  readonly #checkpoint: (checkpoint: PluginCheckpoint) => Promise<void>;
  readonly #active = new Map<string, ActiveRuntime>();
  readonly #published = new Map<string, PublishedPluginResource[]>();
  readonly #recovery: PluginRecoveryCoordinator;

  constructor(options: PluginTransactionHostOptions) {
    this.#store = options.store;
    this.#newOperationId = options.newOperationId ?? randomUUID;
    this.#checkpoint = options.checkpoint ?? (async () => undefined);
    this.#recovery = new PluginRecoveryCoordinator(options.store);
  }

  async activate(
    request: ActivatePluginRequest,
  ): Promise<PluginOperationOutcome | PluginActivateRefusal> {
    if (!isSelfDescribingModuleRef(request.moduleRef)) {
      throw new Error(`moduleRef must self-describe its digest algorithm: ${request.moduleRef}`);
    }
    // 写盘门（PR#97 评审① + 153/51F 渡审）：落第一笔权威记录之前按真账状态裁决——
    // active → PLUGIN_ID_CONFLICT；坏账/在飞/quarantined → LIFECYCLE_RECOVERY_PENDING
    // （fail-closed，原字节不动）；仅 ENOENT、blocked 显式重试、disposed 重装放行。
    const refused = refuseActiveIdOverwrite(request.pluginId, this.#active, this.#store);
    if (refused !== null) return refused;
    if (
      request.readiness?.status === "ready" &&
      (!isReadinessReceipt(request.readiness) ||
        !isReadinessScope(request.verifiedScope) ||
        !sameReadinessScope(request.verifiedScope, request.readiness.verifiedScope))
    ) {
      throw new Error(
        "ready runtime readiness requires an authority verifiedScope matching the receipt",
      );
    }
    const operationId = this.#newOperationId();
    const record: PluginAuthorityRecord = {
      schemaVersion: 1,
      pluginId: request.pluginId,
      lifecycleState: "validated",
      enabled: true,
      moduleRef: request.moduleRef,
      config: request.config,
      bindings: request.bindings,
      verifiedScope: request.verifiedScope,
      ...(request.readiness === undefined ? {} : { readiness: request.readiness }),
      operation: {
        operationId,
        operation: "activate",
        phase: "preparing",
        moduleRef: request.moduleRef,
        resources: [],
        rollbackCompleted: false,
        disposeCompleted: false,
        cleanupAttempts: [],
      },
    };
    if (
      request.readiness !== undefined &&
      (!isReadinessReceipt(request.readiness) ||
        !readinessMatchesAuthority(record, request.readiness))
    ) {
      throw new Error("runtime readiness receipt does not match the current plugin authority");
    }
    this.#store.save(record);
    await this.#emit("operation-persisted", record);

    const resources: RegisteredResource[] = [];
    const recoveryKeys = new Set<string>();
    const resourceIds = new Set<string>();
    const context: PluginPrepareContext = {
      pluginId: request.pluginId,
      operationId,
      config: request.config,
      env: Object.freeze({ ...request.env }),
      register: (declaration) => {
        this.#validateDeclaration(declaration, resourceIds, recoveryKeys);
        const resourceRecord: PluginOperationResourceRecord = {
          registrationIndex: resources.length,
          id: declaration.id,
          kind: declaration.kind,
          recoveryKey: declaration.recoveryKey,
          phase: "registered",
          ...(declaration.capabilityId === undefined
            ? {}
            : { capabilityId: declaration.capabilityId }),
        };
        const registered: RegisteredResource = {
          declaration,
          record: resourceRecord,
          revoked: false,
        };
        resources.push(registered);
        record.operation.resources.push(resourceRecord);
        this.#store.save(record);
        return this.#handle(record, registered);
      },
    };

    let prepared: PreparedPlugin;
    try {
      prepared = await request.module.prepare(context);
    } catch {
      return this.#rollbackCurrent(record, resources, undefined, "PREPARE_FAILED");
    }

    record.lifecycleState = "prepared";
    record.operation.phase = "prepared";
    this.#store.save(record);
    record.operation.phase = "activating";
    this.#store.save(record);
    try {
      for (const resource of resources) {
        await resource.declaration.activate();
        await this.#emit("resource-effect-before-receipt", record, resource.record.id);
        resource.record.phase = "ready";
        this.#store.save(record);
      }
    } catch {
      return this.#rollbackCurrent(record, resources, prepared, "ACTIVATE_FAILED");
    }

    await this.#emit("before-active-authority-commit", record);
    record.lifecycleState = "active";
    record.operation.phase = "authority_committed";
    this.#store.save(record);
    await this.#emit("active-authority-committed-before-publish", record);

    let activePlugin: ActivePlugin;
    try {
      activePlugin = await prepared.activate();
    } catch {
      return this.#rollbackCurrent(record, resources, prepared, "ACTIVATE_FAILED");
    }
    record.operation.phase = "published";
    this.#store.save(record);
    await this.#emit("published-before-operation-complete", record);
    record.operation.phase = "completed";
    Reflect.deleteProperty(record, "reasonCode");
    Reflect.deleteProperty(record, "quarantine");
    this.#store.save(record);
    this.#active.set(request.pluginId, { activePlugin, resources });
    this.#published.set(
      request.pluginId,
      resources.map((resource) => this.#public(resource.record)),
    );
    return this.#outcome(record);
  }

  async dispose(
    pluginId: string,
    deactivation?: { readonly config: unknown },
  ): Promise<PluginOperationOutcome> {
    const existing = this.#store.read(pluginId);
    // 停用意图（enabled=false + 本次全量 config）随 dispose 事务的第一笔写盘落地，
    // 后续每代记录自然继承；不得依赖 host 返回后的补写（153/33F 崩溃窗）。
    if (existing.lifecycleState === "quarantined" || existing.lifecycleState === "disposed") {
      if (deactivation === undefined) return this.#outcome(existing);
      const terminal: PluginAuthorityRecord = {
        ...existing,
        enabled: false,
        config: deactivation.config,
      };
      Reflect.deleteProperty(terminal, "readiness");
      this.#store.save(terminal);
      return this.#outcome(terminal);
    }
    const runtime = this.#active.get(pluginId);
    if (runtime === undefined) {
      if (
        existing.lifecycleState !== "blocked" ||
        existing.operation.phase !== "completed" ||
        this.#remaining(existing).length > 0
      ) {
        throw new Error(`plugin ${pluginId} has no current-process active handles`);
      }
      // lifecycle 表既有边 blocked ─显式停用─→ disposing：仅当回滚已完成且零剩余资源时
      // 放行显式停用，走零资源的持久 disposing → disposed（不伪造 active handle；
      // quarantined 仍只走显式 retryCleanup，不经此路）。
      const parked: PluginAuthorityRecord = {
        ...existing,
        ...(deactivation === undefined ? {} : { enabled: false, config: deactivation.config }),
        lifecycleState: "disposing",
        operation: {
          operationId: this.#newOperationId(),
          operation: "dispose",
          phase: "disposing",
          moduleRef: existing.moduleRef,
          resources: [],
          rollbackCompleted: false,
          disposeCompleted: false,
          cleanupAttempts: [],
        },
      };
      Reflect.deleteProperty(parked, "reasonCode");
      Reflect.deleteProperty(parked, "quarantine");
      Reflect.deleteProperty(parked, "readiness");
      this.#store.save(parked);
      this.#published.delete(pluginId);
      parked.lifecycleState = "disposed";
      parked.operation.phase = "completed";
      parked.operation.disposeCompleted = true;
      this.#store.save(parked);
      return this.#outcome(parked);
    }

    const operationId = this.#newOperationId();
    const record: PluginAuthorityRecord = {
      ...existing,
      ...(deactivation === undefined ? {} : { enabled: false, config: deactivation.config }),
      lifecycleState: "disposing",
      operation: {
        operationId,
        operation: "dispose",
        phase: "disposing",
        moduleRef: existing.moduleRef,
        resources: runtime.resources.map((resource) => ({
          ...resource.record,
          phase: resource.record.phase === "revoked" ? "revoked" : "ready",
        })),
        rollbackCompleted: false,
        disposeCompleted: false,
        cleanupAttempts: [],
      },
    };
    Reflect.deleteProperty(record, "reasonCode");
    Reflect.deleteProperty(record, "quarantine");
    Reflect.deleteProperty(record, "readiness");
    this.#store.save(record);
    this.#published.delete(pluginId);

    const failures: string[] = [];
    const failedResourceIds: string[] = [];
    for (let index = runtime.resources.length - 1; index >= 0; index -= 1) {
      const resource = runtime.resources[index];
      const persisted = record.operation.resources[index];
      if (resource === undefined || persisted === undefined || persisted.phase === "revoked")
        continue;
      try {
        await resource.declaration.dispose();
        resource.revoked = true;
        await this.#emit("dispose-resource-effect-before-receipt", record, persisted.id);
        persisted.phase = "revoked";
        Reflect.deleteProperty(persisted, "lastReasonCode");
        this.#store.save(record);
      } catch {
        persisted.lastReasonCode = "DISPOSE_INCOMPLETE";
        failures.push(persisted.id);
        failedResourceIds.push(persisted.id);
        this.#store.save(record);
      }
    }

    try {
      const report = await runtime.activePlugin.dispose();
      record.operation.disposeCompleted = report.failed.length === 0;
      for (const failure of report.failed) {
        const persisted = record.operation.resources.find((resource) => resource.id === failure.id);
        if (persisted !== undefined && persisted.phase !== "revoked") {
          persisted.lastReasonCode = failure.reasonCode;
        }
        failures.push(failure.id);
        failedResourceIds.push(failure.id);
      }
    } catch {
      failures.push("plugin:dispose");
    }
    this.#active.delete(pluginId);
    if (failures.length > 0) {
      return this.#quarantine(
        record,
        "DISPOSE_INCOMPLETE",
        [...new Set([...this.#remaining(record), ...failedResourceIds])],
        ["Run retryCleanup(pluginId) after repairing the resource-specific cleanup failure."],
      );
    }
    record.lifecycleState = "disposed";
    record.operation.phase = "completed";
    record.operation.disposeCompleted = true;
    Reflect.deleteProperty(record, "reasonCode");
    Reflect.deleteProperty(record, "quarantine");
    this.#store.save(record);
    return this.#outcome(record);
  }

  async coordinateStartup(loader: RecoveryModuleLoader): Promise<PluginOperationOutcome[]> {
    return this.#recovery.coordinateStartup(loader);
  }

  async retryCleanup(
    pluginId: string,
    loader: RecoveryModuleLoader,
  ): Promise<PluginOperationOutcome> {
    return this.#recovery.retryCleanup(pluginId, loader);
  }

  status(pluginId: string): PluginOperationOutcome {
    const record = this.#store.read(pluginId);
    if (this.#recovery.isPending(pluginId)) {
      return {
        pluginId,
        operationId: record.operation.operationId,
        state: "blocked",
        reasonCode: "LIFECYCLE_RECOVERY_PENDING",
      };
    }
    return this.#outcome(record);
  }

  publishedResources(pluginId: string): PublishedPluginResource[] {
    return (this.#published.get(pluginId) ?? []).map((resource) => ({ ...resource }));
  }

  /** Runtime readiness never defaults from lifecycle `active`; missing receipt is unknown. */
  readiness(pluginId: string, now: string | number = Date.now()): ReadinessProjection {
    const record = this.#store.read(pluginId);
    if (
      record.readiness !== undefined &&
      (!isReadinessReceipt(record.readiness) ||
        !readinessMatchesAuthority(record, record.readiness))
    ) {
      return {
        status: "unknown",
        reasonCode: "CAPABILITY_UNVERIFIED",
        detail: "runtime readiness receipt does not describe the current plugin authority",
      };
    }
    return projectReadiness(record.lifecycleState, record.readiness, now);
  }

  /** Persist a fresh external receipt without changing lifecycle or capability definitions. */
  recordReadiness(
    pluginId: string,
    receipt: ReadinessReceipt,
    now: string | number = Date.now(),
  ): ReadinessProjection {
    const record = this.#store.read(pluginId);
    if (record.lifecycleState !== "active") {
      throw new Error(`plugin ${pluginId} is not active; runtime readiness cannot be recorded`);
    }
    if (!isReadinessReceipt(receipt) || !readinessMatchesAuthority(record, receipt)) {
      throw new Error("runtime readiness receipt does not match the current plugin authority");
    }
    const updated: PluginAuthorityRecord = {
      ...record,
      verifiedScope: receipt.verifiedScope,
      readiness: receipt,
    };
    this.#store.save(updated);
    return projectReadiness(updated.lifecycleState, updated.readiness, now);
  }

  async #rollbackCurrent(
    record: PluginAuthorityRecord,
    resources: readonly RegisteredResource[],
    prepared: PreparedPlugin | undefined,
    reasonCode: "PREPARE_FAILED" | "ACTIVATE_FAILED",
  ): Promise<PluginOperationOutcome> {
    const failures: string[] = [];
    for (const resource of [...resources].reverse()) {
      try {
        await this.#handle(record, resource).revoke();
      } catch {
        resource.record.lastReasonCode = "DISPOSE_INCOMPLETE";
        failures.push(resource.record.id);
      }
    }
    if (prepared !== undefined) {
      try {
        await prepared.rollback();
        record.operation.rollbackCompleted = true;
      } catch {
        failures.push("plugin:rollback");
      }
    }
    if (failures.length > 0) {
      return this.#quarantine(record, "DISPOSE_INCOMPLETE", this.#remaining(record), [
        `Activation rollback failed: ${failures.join(", ")}.`,
      ]);
    }
    record.lifecycleState = "blocked";
    record.reasonCode = reasonCode;
    record.operation.phase = "completed";
    Reflect.deleteProperty(record, "quarantine");
    Reflect.deleteProperty(record, "readiness");
    this.#store.save(record);
    return this.#outcome(record);
  }

  #handle(record: PluginAuthorityRecord, resource: RegisteredResource): DisposableHandle {
    return {
      id: resource.record.id,
      revoke: async () => {
        if (resource.revoked || resource.record.phase === "revoked") return;
        await resource.declaration.dispose();
        resource.revoked = true;
        resource.record.phase = "revoked";
        Reflect.deleteProperty(resource.record, "lastReasonCode");
        this.#store.save(record);
      },
    };
  }

  #validateDeclaration(
    declaration: ResourceDeclaration,
    resourceIds: Set<string>,
    recoveryKeys: Set<string>,
  ): void {
    if (declaration.id.length === 0 || resourceIds.has(declaration.id)) {
      throw new Error(`duplicate or empty resource id: ${declaration.id}`);
    }
    if (declaration.recoveryKey.length === 0 || recoveryKeys.has(declaration.recoveryKey)) {
      throw new Error(`duplicate or empty recoveryKey for resource ${declaration.id}`);
    }
    resourceIds.add(declaration.id);
    recoveryKeys.add(declaration.recoveryKey);
  }

  #quarantine(
    record: PluginAuthorityRecord,
    reasonCode: "RECOVERY_HANDLE_UNAVAILABLE" | "DISPOSE_INCOMPLETE",
    remainingResourceIds: readonly string[],
    manualActions: readonly string[],
  ): PluginOperationOutcome {
    record.lifecycleState = "quarantined";
    record.reasonCode = reasonCode;
    record.operation.phase = "quarantined";
    record.quarantine = { reasonCode, remainingResourceIds, manualActions };
    this.#published.delete(record.pluginId);
    this.#active.delete(record.pluginId);
    Reflect.deleteProperty(record, "readiness");
    this.#store.save(record);
    return this.#outcome(record);
  }

  #remaining(record: PluginAuthorityRecord): string[] {
    return record.operation.resources
      .filter((resource) => resource.phase !== "revoked")
      .map((resource) => resource.id);
  }

  #outcome(record: PluginAuthorityRecord): PluginOperationOutcome {
    return operationOutcome(record);
  }

  #public(resource: PluginOperationResourceRecord): PublishedPluginResource {
    return {
      id: resource.id,
      kind: resource.kind,
      ...(resource.capabilityId === undefined ? {} : { capabilityId: resource.capabilityId }),
    };
  }

  async #emit(
    name: PluginCheckpointName,
    record: PluginAuthorityRecord,
    resourceId?: string,
  ): Promise<void> {
    await this.#checkpoint({
      name,
      pluginId: record.pluginId,
      operationId: record.operation.operationId,
      ...(resourceId === undefined ? {} : { resourceId }),
    });
  }
}

/**
 * The operation authority has plugin/module identity but deliberately does not become a
 * capability registry. Check the receipt's binding tuple against that identity and against
 * its own definition/scope, while leaving canonical capability ownership to #100.
 */
function readinessMatchesAuthority(
  record: PluginAuthorityRecord,
  receipt: ReadinessReceipt,
): boolean {
  const { binding, definition, verifiedScope } = receipt;
  const declaredCapabilityIds = record.operation.resources.flatMap((resource) =>
    resource.capabilityId === undefined ? [] : [resource.capabilityId],
  );
  const authorityScope = isReadinessScope(record.verifiedScope) ? record.verifiedScope : null;
  return (
    definition.pluginId === record.pluginId &&
    definition.moduleRef === record.moduleRef &&
    (declaredCapabilityIds.length === 0 ||
      declaredCapabilityIds.includes(definition.capabilityId)) &&
    (receipt.status !== "ready"
      ? authorityScope === null || sameReadinessScope(authorityScope, verifiedScope)
      : authorityScope !== null && sameReadinessScope(authorityScope, verifiedScope)) &&
    verifiedScope.version === definition.version &&
    (binding === null ||
      (binding.pluginId === record.pluginId &&
        binding.capabilityId === definition.capabilityId &&
        binding.version === definition.version &&
        binding.moduleRef === record.moduleRef &&
        binding.host === verifiedScope.host &&
        binding.networkPath === verifiedScope.networkPath))
  );
}

function sameReadinessScope(left: ReadinessScope, right: ReadinessScope): boolean {
  return (
    left.residentId === right.residentId &&
    left.lane === right.lane &&
    left.host === right.host &&
    left.networkPath === right.networkPath &&
    left.version === right.version &&
    left.operations.length === right.operations.length &&
    left.operations.every((operation) => right.operations.includes(operation))
  );
}
