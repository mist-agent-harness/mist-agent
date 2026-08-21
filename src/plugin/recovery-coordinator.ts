import { isSelfDescribingModuleRef } from "./module-ref.ts";
import type {
  PluginAuthorityRecord,
  PluginOperationResourceRecord,
  PluginOperationStore,
} from "./operation-store.ts";
import type {
  PluginModuleV0,
  ReasonCode,
  RecoveredPlugin,
  RecoveryResourceRecord,
} from "./types.ts";

export interface RecoveryModule {
  readonly module: PluginModuleV0;
  readonly moduleRef: string;
  readonly env: Readonly<Record<string, string>>;
  /** Optional independent descriptor inventory used to detect missing/drifting keys. */
  readonly recoveryKeys?: Readonly<Record<string, string>>;
}

export type RecoveryModuleLoader = (authority: PluginAuthorityRecord) => Promise<RecoveryModule>;

export interface PluginOperationOutcome {
  readonly pluginId: string;
  readonly operationId: string;
  readonly state: PluginAuthorityRecord["lifecycleState"];
  readonly reasonCode?: ReasonCode;
  readonly remainingResourceIds?: readonly string[];
}

/** Startup-only reconciliation. It never projects entries or re-runs normal prepare/activate. */
export class PluginRecoveryCoordinator {
  readonly #store: PluginOperationStore;
  readonly #pending = new Set<string>();

  constructor(store: PluginOperationStore) {
    this.#store = store;
  }

  isPending(pluginId: string): boolean {
    return this.#pending.has(pluginId);
  }

  async coordinateStartup(loader: RecoveryModuleLoader): Promise<PluginOperationOutcome[]> {
    const candidates = this.#store
      .list()
      .filter(
        (record) =>
          record.operation.phase !== "completed" && record.lifecycleState !== "quarantined",
      );
    for (const record of candidates) this.#pending.add(record.pluginId);
    const outcomes: PluginOperationOutcome[] = [];
    for (const record of candidates) {
      try {
        outcomes.push(await this.#recover(record, loader, false));
      } finally {
        this.#pending.delete(record.pluginId);
      }
    }
    return outcomes;
  }

  async retryCleanup(
    pluginId: string,
    loader: RecoveryModuleLoader,
  ): Promise<PluginOperationOutcome> {
    const record = this.#store.read(pluginId);
    if (record.lifecycleState !== "quarantined") {
      throw new Error(`plugin ${pluginId} is not quarantined`);
    }
    const outcome = await this.#recover(record, loader, true);
    if (outcome.state === "quarantined") {
      record.operation.cleanupAttempts.push({
        attempt: record.operation.cleanupAttempts.length + 1,
        failedResourceIds: outcome.remainingResourceIds ?? [],
        reasonCode: outcome.reasonCode ?? "DISPOSE_INCOMPLETE",
        manualActions: record.quarantine?.manualActions ?? [],
      });
      this.#store.save(record);
    }
    return outcome;
  }

  async #recover(
    record: PluginAuthorityRecord,
    loader: RecoveryModuleLoader,
    explicitCleanup: boolean,
  ): Promise<PluginOperationOutcome> {
    // RFC §3: an empty resource log has nothing to revoke, so its terminal state does
    // not depend on the module still being loadable or matching a recovery digest.
    if (record.operation.resources.length === 0) return this.#finish(record, explicitCleanup);

    let loaded: RecoveryModule;
    try {
      loaded = await loader(record);
    } catch {
      return this.#recoveryUnavailable(record, [
        "The plugin module could not be loaded for cleanup.",
      ]);
    }
    if (
      record.operation.moduleRef !== record.moduleRef ||
      !isSelfDescribingModuleRef(record.moduleRef) ||
      !isSelfDescribingModuleRef(loaded.moduleRef) ||
      loaded.moduleRef !== record.moduleRef
    ) {
      return this.#recoveryUnavailable(record, [
        `Expected moduleRef ${record.moduleRef}; operation recorded ${record.operation.moduleRef}; actual moduleRef ${loaded.moduleRef}.`,
        "Use an explicit reinstall or upgrade; startup coordination must not replace the module.",
      ]);
    }
    const descriptorProblem = this.#descriptorProblem(record, loaded.recoveryKeys);
    if (descriptorProblem !== null) {
      return this.#recoveryUnavailable(record, [descriptorProblem]);
    }
    if (loaded.module.recover === undefined) {
      return this.#recoveryUnavailable(record, [
        "Persisted resources exist but this module exports no recover(context) function.",
      ]);
    }

    record.operation.phase = "recovering";
    this.#store.save(record);
    let recovered: RecoveredPlugin;
    try {
      recovered = await loaded.module.recover({
        pluginId: record.pluginId,
        operationId: record.operation.operationId,
        operation: record.operation.operation,
        config: record.config,
        env: Object.freeze({ ...loaded.env }),
        resources: record.operation.resources.map(recoveryRecord),
      });
    } catch {
      return this.#recoveryUnavailable(record, [
        "recover(context) failed before cleanup completed.",
      ]);
    }

    const failures: string[] = [];
    for (const resource of [...record.operation.resources].reverse()) {
      if (resource.phase === "revoked") continue;
      try {
        await recovered.revoke(recoveryRecord(resource));
        resource.phase = "revoked";
        Reflect.deleteProperty(resource, "lastReasonCode");
        this.#store.save(record);
      } catch {
        resource.lastReasonCode = "RECOVERY_HANDLE_UNAVAILABLE";
        failures.push(resource.id);
        this.#store.save(record);
      }
    }
    if (failures.length > 0) {
      return this.#recoveryUnavailable(record, [
        `Recovery could not revoke resources: ${failures.join(", ")}.`,
      ]);
    }

    const failedResourceIds: string[] = [];
    try {
      if (record.operation.operation === "activate") {
        await recovered.rollback();
        record.operation.rollbackCompleted = true;
      } else {
        const report = await recovered.dispose();
        record.operation.disposeCompleted = report.failed.length === 0;
        for (const failure of report.failed) {
          failures.push(failure.id);
          failedResourceIds.push(failure.id);
        }
      }
    } catch {
      failures.push(`plugin:${record.operation.operation === "activate" ? "rollback" : "dispose"}`);
    }
    if (failures.length > 0) {
      return this.#quarantine(
        record,
        "DISPOSE_INCOMPLETE",
        unique([...remainingIds(record), ...failedResourceIds]),
        [`Plugin-level recovery cleanup failed: ${failures.join(", ")}.`],
      );
    }
    this.#store.save(record);
    return this.#finish(record, explicitCleanup);
  }

  #finish(record: PluginAuthorityRecord, explicitCleanup: boolean): PluginOperationOutcome {
    record.operation.phase = "completed";
    Reflect.deleteProperty(record, "quarantine");
    Reflect.deleteProperty(record, "readiness");
    if (explicitCleanup || record.operation.operation === "dispose") {
      record.lifecycleState = "disposed";
      if (record.operation.operation === "dispose") record.operation.disposeCompleted = true;
      Reflect.deleteProperty(record, "reasonCode");
    } else {
      record.lifecycleState = "blocked";
      record.reasonCode = "ACTIVATE_FAILED";
    }
    this.#store.save(record);
    return operationOutcome(record);
  }

  #descriptorProblem(
    record: PluginAuthorityRecord,
    expectedKeys: Readonly<Record<string, string>> | undefined,
  ): string | null {
    const resourceIds = new Set<string>();
    const recoveryKeys = new Set<string>();
    for (const [index, resource] of record.operation.resources.entries()) {
      if (resource.registrationIndex !== index) {
        return `Invalid recovery registration order for resource ${resource.id}.`;
      }
      if (resourceIds.has(resource.id)) return `Duplicate recovery resource id: ${resource.id}.`;
      resourceIds.add(resource.id);
      if (resource.recoveryKey === null) return `Missing recoveryKey for resource ${resource.id}.`;
      if (recoveryKeys.has(resource.recoveryKey)) {
        return `Duplicate recoveryKey in operation ${record.operation.operationId}.`;
      }
      recoveryKeys.add(resource.recoveryKey);
      if (expectedKeys !== undefined && expectedKeys[resource.id] !== resource.recoveryKey) {
        return `Drifting recoveryKey for resource ${resource.id}.`;
      }
    }
    return null;
  }

  #recoveryUnavailable(
    record: PluginAuthorityRecord,
    manualActions: readonly string[],
  ): PluginOperationOutcome {
    return this.#quarantine(
      record,
      "RECOVERY_HANDLE_UNAVAILABLE",
      remainingIds(record),
      manualActions,
    );
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
    Reflect.deleteProperty(record, "readiness");
    this.#store.save(record);
    return operationOutcome(record);
  }
}

export function operationOutcome(record: PluginAuthorityRecord): PluginOperationOutcome {
  return {
    pluginId: record.pluginId,
    operationId: record.operation.operationId,
    state: record.lifecycleState,
    ...(record.reasonCode === undefined ? {} : { reasonCode: record.reasonCode }),
    ...(record.quarantine === undefined
      ? {}
      : { remainingResourceIds: [...record.quarantine.remainingResourceIds] }),
  };
}

function remainingIds(record: PluginAuthorityRecord): string[] {
  return record.operation.resources
    .filter((resource) => resource.phase !== "revoked")
    .map((resource) => resource.id);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function recoveryRecord(resource: PluginOperationResourceRecord): RecoveryResourceRecord {
  if (resource.recoveryKey === null) throw new Error(`resource ${resource.id} has no recoveryKey`);
  return {
    id: resource.id,
    kind: resource.kind,
    recoveryKey: resource.recoveryKey,
    phase: resource.phase,
    ...(resource.capabilityId === undefined ? {} : { capabilityId: resource.capabilityId }),
  };
}
