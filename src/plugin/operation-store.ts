import { randomUUID } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { LifecycleState } from "./lifecycle.ts";
import { type ReadinessReceipt, isReadinessReceipt } from "./runtime-readiness.ts";
import type { ReasonCode, ResourceKind } from "./types.ts";

export const PLUGIN_OPERATION_SCHEMA_VERSION = 1 as const;

export type PluginOperationKind = "activate" | "dispose";

export type PluginOperationPhase =
  | "preparing"
  | "prepared"
  | "activating"
  | "authority_committed"
  | "published"
  | "disposing"
  | "recovering"
  | "quarantined"
  | "completed";

/** `null` represents a missing persisted key so startup can quarantine it, not crash-loop. */
export interface PluginOperationResourceRecord {
  readonly registrationIndex: number;
  readonly id: string;
  readonly kind: ResourceKind;
  readonly capabilityId?: string;
  readonly recoveryKey: string | null;
  phase: "registered" | "ready" | "revoked";
  lastReasonCode?: string;
}

export interface PluginCleanupAttemptRecord {
  readonly attempt: number;
  readonly failedResourceIds: readonly string[];
  readonly reasonCode: string;
  readonly manualActions: readonly string[];
}

export interface PluginOperationRecord {
  readonly operationId: string;
  readonly operation: PluginOperationKind;
  phase: PluginOperationPhase;
  readonly moduleRef: string;
  readonly resources: PluginOperationResourceRecord[];
  rollbackCompleted: boolean;
  disposeCompleted: boolean;
  readonly cleanupAttempts: PluginCleanupAttemptRecord[];
}

export interface PluginQuarantineRecord {
  readonly reasonCode: "RECOVERY_HANDLE_UNAVAILABLE" | "DISPOSE_INCOMPLETE";
  readonly remainingResourceIds: readonly string[];
  readonly manualActions: readonly string[];
}

/**
 * One atomic authority unit. The lifecycle state, active authority tuple and current
 * operation can never be observed from different file generations.
 */
export interface PluginAuthorityRecord {
  readonly schemaVersion: typeof PLUGIN_OPERATION_SCHEMA_VERSION;
  readonly pluginId: string;
  lifecycleState: LifecycleState;
  enabled: boolean;
  readonly moduleRef: string;
  readonly config: unknown;
  readonly bindings: unknown;
  readonly verifiedScope: unknown;
  /** Optional runtime receipt; absent means an active lifecycle is not runtime-ready. */
  readonly readiness?: ReadinessReceipt;
  reasonCode?: ReasonCode;
  readonly operation: PluginOperationRecord;
  quarantine?: PluginQuarantineRecord;
}

const PLUGIN_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const RESOURCE_KINDS = new Set<ResourceKind>(["route", "tool", "listener", "timer", "connection"]);
const LIFECYCLE_STATES = new Set<LifecycleState>([
  "discovered",
  "validated",
  "prepared",
  "active",
  "disposing",
  "disposed",
  "blocked",
  "quarantined",
]);
const OPERATION_PHASES = new Set<PluginOperationPhase>([
  "preparing",
  "prepared",
  "activating",
  "authority_committed",
  "published",
  "disposing",
  "recovering",
  "quarantined",
  "completed",
]);
const REASON_CODES = new Set<ReasonCode>([
  "MANIFEST_INVALID",
  "HOST_INCOMPATIBLE",
  "PLUGIN_ID_CONFLICT",
  "CONFIG_INVALID",
  "REQUIREMENT_MISSING",
  "CREDENTIAL_TYPE_MISMATCH",
  "CREDENTIAL_ISSUER_UNAVAILABLE",
  "PERMISSION_DENIED",
  "PREPARE_FAILED",
  "ACTIVATE_FAILED",
  "RECOVERY_HANDLE_UNAVAILABLE",
  "MIGRATION_FAILED",
  "UPGRADE_PERMISSION_CONFIRMATION_REQUIRED",
  "DISPOSE_INCOMPLETE",
  "LIFECYCLE_RECOVERY_PENDING",
  "PLUGIN_RUNTIME_FAILED",
  "CONTEXT_INJECTION_MISMATCH",
  "SENSITIVE_OUTPUT_BLOCKED",
  "CAPABILITY_UNVERIFIED",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`plugin operation record has invalid ${key}`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`plugin operation record has invalid ${key}`);
  }
  return value;
}

function parseResource(value: unknown): PluginOperationResourceRecord {
  if (!isRecord(value)) throw new Error("plugin operation has an invalid resource record");
  const registrationIndex = value.registrationIndex;
  const kind = value.kind;
  const phase = value.phase;
  if (!Number.isSafeInteger(registrationIndex) || Number(registrationIndex) < 0) {
    throw new Error("plugin operation resource has an invalid registrationIndex");
  }
  if (typeof kind !== "string" || !RESOURCE_KINDS.has(kind as ResourceKind)) {
    throw new Error("plugin operation resource has an invalid kind");
  }
  if (phase !== "registered" && phase !== "ready" && phase !== "revoked") {
    throw new Error("plugin operation resource has an invalid phase");
  }
  const recoveryKey = value.recoveryKey;
  if (recoveryKey !== undefined && recoveryKey !== null && typeof recoveryKey !== "string") {
    throw new Error("plugin operation resource has an invalid recoveryKey");
  }
  const capabilityId = optionalString(value, "capabilityId");
  const lastReasonCode = optionalString(value, "lastReasonCode");
  return {
    registrationIndex: Number(registrationIndex),
    id: requiredString(value, "id"),
    kind: kind as ResourceKind,
    recoveryKey: typeof recoveryKey === "string" && recoveryKey.length > 0 ? recoveryKey : null,
    phase,
    ...(capabilityId === undefined ? {} : { capabilityId }),
    ...(lastReasonCode === undefined ? {} : { lastReasonCode }),
  };
}

function parseCleanupAttempt(value: unknown): PluginCleanupAttemptRecord {
  if (!isRecord(value)) throw new Error("plugin operation has an invalid cleanup attempt");
  const attempt = value.attempt;
  if (!Number.isSafeInteger(attempt) || Number(attempt) < 1) {
    throw new Error("plugin cleanup attempt has an invalid sequence");
  }
  if (
    !Array.isArray(value.failedResourceIds) ||
    !value.failedResourceIds.every(isNonemptyString) ||
    !Array.isArray(value.manualActions) ||
    !value.manualActions.every(isNonemptyString)
  ) {
    throw new Error("plugin cleanup attempt has invalid diagnostics");
  }
  return {
    attempt: Number(attempt),
    failedResourceIds: [...value.failedResourceIds],
    reasonCode: requiredString(value, "reasonCode"),
    manualActions: [...value.manualActions],
  };
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function parseOperation(value: unknown): PluginOperationRecord {
  if (!isRecord(value)) throw new Error("plugin authority has an invalid operation");
  const operation = value.operation;
  const phase = value.phase;
  if (operation !== "activate" && operation !== "dispose") {
    throw new Error("plugin operation has an invalid kind");
  }
  if (typeof phase !== "string" || !OPERATION_PHASES.has(phase as PluginOperationPhase)) {
    throw new Error("plugin operation has an invalid phase");
  }
  if (!Array.isArray(value.resources)) {
    throw new Error("plugin operation has invalid resources");
  }
  if (!Array.isArray(value.cleanupAttempts)) {
    throw new Error("plugin operation has invalid cleanup attempts");
  }
  if (typeof value.rollbackCompleted !== "boolean" || typeof value.disposeCompleted !== "boolean") {
    throw new Error("plugin operation has invalid cleanup receipts");
  }
  return {
    operationId: requiredString(value, "operationId"),
    operation,
    phase: phase as PluginOperationPhase,
    moduleRef: requiredString(value, "moduleRef"),
    resources: value.resources.map(parseResource),
    rollbackCompleted: value.rollbackCompleted,
    disposeCompleted: value.disposeCompleted,
    cleanupAttempts: value.cleanupAttempts.map(parseCleanupAttempt),
  };
}

function parseQuarantine(value: unknown): PluginQuarantineRecord | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("plugin authority has an invalid quarantine record");
  const reasonCode = value.reasonCode;
  if (reasonCode !== "RECOVERY_HANDLE_UNAVAILABLE" && reasonCode !== "DISPOSE_INCOMPLETE") {
    throw new Error("plugin quarantine has an invalid reasonCode");
  }
  if (
    !Array.isArray(value.remainingResourceIds) ||
    !value.remainingResourceIds.every(isNonemptyString) ||
    !Array.isArray(value.manualActions) ||
    !value.manualActions.every(isNonemptyString)
  ) {
    throw new Error("plugin quarantine has invalid diagnostics");
  }
  return {
    reasonCode,
    remainingResourceIds: [...value.remainingResourceIds],
    manualActions: [...value.manualActions],
  };
}

function parseAuthority(text: string, expectedPluginId: string): PluginAuthorityRecord {
  const value = JSON.parse(text) as unknown;
  if (!isRecord(value)) throw new Error("plugin authority record must be an object");
  if (value.schemaVersion !== PLUGIN_OPERATION_SCHEMA_VERSION) {
    throw new Error(`unsupported plugin operation schemaVersion: ${String(value.schemaVersion)}`);
  }
  const pluginId = requiredString(value, "pluginId");
  if (pluginId !== expectedPluginId) {
    throw new Error(`plugin authority file says ${pluginId}; expected ${expectedPluginId}`);
  }
  const lifecycleState = value.lifecycleState;
  if (
    typeof lifecycleState !== "string" ||
    !LIFECYCLE_STATES.has(lifecycleState as LifecycleState)
  ) {
    throw new Error("plugin authority has an invalid lifecycleState");
  }
  if (typeof value.enabled !== "boolean") {
    throw new Error("plugin authority has an invalid enabled intent");
  }
  const reasonCodeValue = optionalString(value, "reasonCode");
  if (reasonCodeValue !== undefined && !REASON_CODES.has(reasonCodeValue as ReasonCode)) {
    throw new Error("plugin authority has an invalid reasonCode");
  }
  const reasonCode = reasonCodeValue as ReasonCode | undefined;
  const readiness = value.readiness;
  if (readiness !== undefined && !isReadinessReceipt(readiness)) {
    throw new Error("plugin authority has an invalid readiness receipt");
  }
  const quarantine = parseQuarantine(value.quarantine);
  return {
    schemaVersion: PLUGIN_OPERATION_SCHEMA_VERSION,
    pluginId,
    lifecycleState: lifecycleState as LifecycleState,
    enabled: value.enabled,
    moduleRef: requiredString(value, "moduleRef"),
    config: value.config,
    bindings: value.bindings,
    verifiedScope: value.verifiedScope,
    ...(readiness === undefined ? {} : { readiness }),
    operation: parseOperation(value.operation),
    ...(reasonCode === undefined ? {} : { reasonCode }),
    ...(quarantine === undefined ? {} : { quarantine }),
  };
}

function cloneRecord(record: PluginAuthorityRecord): PluginAuthorityRecord {
  return parseAuthority(JSON.stringify(record), record.pluginId);
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** File-backed, single-writer plugin authority store. */
export class PluginOperationStore {
  readonly #rootDir: string;

  constructor(rootDir: string) {
    this.#rootDir = rootDir;
    mkdirSync(rootDir, { recursive: true, mode: 0o700 });
  }

  save(record: PluginAuthorityRecord): void {
    this.#assertPluginId(record.pluginId);
    const validated = cloneRecord(record);
    const finalPath = this.pathFor(record.pluginId);
    const temporaryPath = `${finalPath}.tmp-${process.pid}-${randomUUID()}`;
    let descriptor: number | null = null;
    try {
      descriptor = openSync(temporaryPath, "wx", 0o600);
      fchmodSync(descriptor, 0o600);
      const payload = Buffer.from(JSON.stringify(validated));
      let offset = 0;
      while (offset < payload.length) {
        const written = writeSync(descriptor, payload, offset, payload.length - offset, offset);
        if (written === 0) throw new Error("plugin authority write made no progress");
        offset += written;
      }
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      renameSync(temporaryPath, finalPath);
      fsyncDirectory(dirname(finalPath));
    } catch (error) {
      if (descriptor !== null) {
        try {
          closeSync(descriptor);
        } catch {
          // Preserve the original write failure.
        }
      }
      rmSync(temporaryPath, { force: true });
      throw error;
    }
  }

  read(pluginId: string): PluginAuthorityRecord {
    this.#assertPluginId(pluginId);
    return parseAuthority(readFileSync(this.pathFor(pluginId), "utf8"), pluginId);
  }

  list(): PluginAuthorityRecord[] {
    const records: PluginAuthorityRecord[] = [];
    for (const file of readdirSync(this.#rootDir).sort()) {
      if (!file.endsWith(".json")) continue;
      const pluginId = file.slice(0, -".json".length);
      this.#assertPluginId(pluginId);
      records.push(this.read(pluginId));
    }
    return records;
  }

  pathFor(pluginId: string): string {
    this.#assertPluginId(pluginId);
    return join(this.#rootDir, `${pluginId}.json`);
  }

  #assertPluginId(pluginId: string): void {
    if (!PLUGIN_ID.test(pluginId)) throw new Error(`invalid plugin id: ${pluginId}`);
  }
}
