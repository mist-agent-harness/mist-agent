/**
 * Plugin Protocol v0 — canonical host-side types.
 *
 * Source of truth: docs/design/plugin-protocol-v0.md at the #62 freeze point
 * (main@acdfcab2, RFC §2 manifest/env delivery, §3 transactions/recovery,
 * §8 stable failure semantics). Interface members and comments follow the merged
 * wording verbatim; the consumer-side copies in webui/mist-plugin.ts (#61) predate
 * #62 and re-point here in a follow-up PR.
 *
 * Scope note (#76 单B): canonical type surface shared by the runtime landed in this PR
 * series — §2 manifest/discovery/env delivery, §3 transactions/recovery, §8 failure
 * semantics all implement against these shapes.
 */

/** Resource categories a plugin may register through its prepare context. RFC §3. */
export type ResourceKind = "route" | "tool" | "listener" | "timer" | "connection";

/**
 * A single capability-backed resource a plugin asks the host to register. RFC §3.
 * `recoveryKey` is stable and non-secret, unique within one operation, written to the
 * host's registration log BEFORE the first side effect; it can only locate recovery
 * cleanup — never carries secret values, serialized functions, or closures.
 */
export interface ResourceDeclaration {
  readonly id: string;
  readonly kind: ResourceKind;
  readonly capabilityId?: string;
  readonly recoveryKey: string;
  /** Called by the host during the atomic commit phase; must not be reachable during prepare. */
  activate(): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * Host receipt for one registered resource, held by the CURRENT host process only —
 * the registration log persists recovery descriptors, never function objects; after a
 * restart, revocation belongs to {@link RecoveredPlugin.revoke}. Idempotent. RFC §3, glossary.
 */
export interface DisposableHandle {
  readonly id: string;
  revoke(): Promise<void>;
}

/** A versioned host service requirement declared by the plugin manifest. */
export interface HostServiceRequirement {
  readonly id: string;
  readonly requires: string;
}

/**
 * Host-owned view of one delivered service. The service proxy is read-only and is
 * revoked by the host when activation rolls back or disposal begins.
 */
export interface HostServiceHandle<T extends object = object> {
  readonly id: string;
  readonly version: string;
  readonly service: Readonly<T>;
}

export interface PluginHostServices {
  get<T extends object = object>(id: string): HostServiceHandle<T>;
}

/**
 * What a plugin sees during prepare. RFC §2/§3 (#62):
 * - `operationId`: host-generated, persisted to disk BEFORE `prepare` is called; also
 *   the stable recovery key for this whole prepare.
 * - `env`: read-only map delivered ONLY through this context — keys are exactly the
 *   manifest-declared and bound `env` names (secretRef entries arrive resolved);
 *   undeclared names never appear, unbound optionals are absent, and plugins must not
 *   read declared names from `process.env`.
 */
export interface PluginPrepareContext {
  readonly pluginId: string;
  readonly operationId: string;
  readonly config: unknown;
  readonly env: Readonly<Record<string, string>>;
  readonly services: PluginHostServices;
  register(resource: ResourceDeclaration): DisposableHandle;
}

/**
 * Terminal dispose accounting. Only an empty `failed` array is a clean unload (PV0-C07).
 * `reasonCode` stays `string` per RFC §3: the §8 table is the host's stable MINIMUM
 * ("至少给出"), and resource-level failures may surface plugin-specific codes beyond it —
 * hosts still emit {@link ReasonCode} members for every host-judged failure.
 */
export interface DisposeReport {
  readonly revoked: readonly string[];
  readonly failed: readonly { id: string; reasonCode: string }[];
}

/** An activated (published) plugin. Callers MUST inspect `failed[]` on dispose. Idempotent. RFC §3. */
export interface ActivePlugin {
  dispose(): Promise<DisposeReport>;
}

/**
 * A prepared-but-unpublished plugin. RFC §3 (#62 two-activate order): the host first
 * calls every `ResourceDeclaration.activate()` in registration order (commit, still
 * unreachable), writes the active authority record, and only then calls
 * `activate()` here exactly once — the sole publication step. The plugin may refuse a
 * publication attempted while some of its resources were never committed
 * (`ACTIVATE_FAILED`), and the host must not treat that refusal as a plugin defect.
 * `rollback()` is the idempotent reverse of the whole prepare; after a host restart it
 * must be re-established via {@link RecoveredPlugin.rollback} — old closures are gone.
 */
export interface PreparedPlugin {
  activate(): Promise<ActivePlugin>;
  rollback(): Promise<void>;
}

/**
 * One resource's persisted recovery record, as replayed to `recover()`. RFC §3 (#62).
 */
export interface RecoveryResourceRecord {
  readonly id: string;
  readonly kind: ResourceKind;
  readonly capabilityId?: string;
  readonly recoveryKey: string;
  readonly phase: "registered" | "ready" | "revoked";
}

/**
 * What a crashed-and-restarted host hands to `PluginModuleV0.recover` — in-memory
 * handles died with the old process, so coordination works from persisted descriptors
 * only. The host may call `recover` only after re-parsing the module and matching its
 * recomputed content digest against the logged `moduleRef`. RFC §3 (#62).
 */
export interface PluginRecoveryContext {
  readonly pluginId: string;
  readonly operationId: string;
  readonly operation: "activate" | "dispose";
  readonly config: unknown;
  readonly env: Readonly<Record<string, string>>;
  readonly resources: readonly RecoveryResourceRecord[];
}

/**
 * Purpose-built revoker rebuilt during startup coordination. All members idempotent.
 * RFC §3 (#62): `revoke` undoes one resource by its record, `rollback` is the recovery
 * reverse of the whole prepare, `dispose` finishes an interrupted dispose.
 */
export interface RecoveredPlugin {
  revoke(resource: RecoveryResourceRecord): Promise<void>;
  rollback(): Promise<void>;
  dispose(): Promise<DisposeReport>;
}

/**
 * An upgrade/migration request, verbatim from RFC §7. `config` is a deep copy and
 * never contains credential values; migration semantics belong to the E-series scope.
 */
export interface MigrationRequest {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly config: unknown;
}

/**
 * A plugin module's exported surface. RFC §3 (#62 final ruling): `recover` is an
 * OPTIONAL member — plugins that never register resources through their context may
 * omit it (their operation logs hold no resource records, so coordination needs no
 * revoker); a module WITH logged resource records but no `recover` export goes to
 * `quarantined + RECOVERY_HANDLE_UNAVAILABLE`.
 */
export interface PluginModuleV0 {
  migrate?(request: MigrationRequest): Promise<unknown>;
  prepare(context: PluginPrepareContext): Promise<PreparedPlugin>;
  recover?(context: PluginRecoveryContext): Promise<RecoveredPlugin>;
}

/**
 * Stable failure reason codes, verbatim from RFC §8 at the #62 freeze point. Details
 * may be appended to an error, but never substituted for the code.
 */
export type ReasonCode =
  | "MANIFEST_INVALID"
  | "HOST_INCOMPATIBLE"
  | "PLUGIN_ID_CONFLICT"
  | "CONFIG_INVALID"
  | "REQUIREMENT_MISSING"
  | "CREDENTIAL_TYPE_MISMATCH"
  | "CREDENTIAL_ISSUER_UNAVAILABLE"
  | "PERMISSION_DENIED"
  | "PREPARE_FAILED"
  | "ACTIVATE_FAILED"
  | "RECOVERY_HANDLE_UNAVAILABLE"
  | "MIGRATION_FAILED"
  | "UPGRADE_PERMISSION_CONFIRMATION_REQUIRED"
  | "DISPOSE_INCOMPLETE"
  | "LIFECYCLE_RECOVERY_PENDING"
  | "PLUGIN_RUNTIME_FAILED"
  | "CONTEXT_INJECTION_MISMATCH"
  | "SENSITIVE_OUTPUT_BLOCKED"
  | "CAPABILITY_UNVERIFIED";
