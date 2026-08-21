import type { ReasonCode } from "./types.ts";

/** Version of the persisted runtime-readiness receipt contract. */
export const READINESS_RECEIPT_SCHEMA_VERSION = 1 as const;

export type ReadinessStatus = "ready" | "degraded" | "blocked" | "quarantined" | "unknown";

/** Values that may be copied into a diagnostic receipt without carrying secrets. */
export type ReadinessValue = string | number | boolean;

/** The boundary at which a readiness claim was observed. */
export interface ReadinessScope {
  readonly residentId: string;
  readonly lane: string;
  readonly operations: readonly string[];
  readonly host: string;
  readonly networkPath: string;
  /** Deployed/runtime version, not a repository version guessed by the caller. */
  readonly version: string;
}

/** Stable capability identity. Runtime readiness never changes this definition. */
export interface ReadinessDefinition {
  readonly pluginId: string;
  readonly capabilityId: string;
  readonly version: string;
  readonly moduleRef: string;
}

/** The implementation path selected for this host and network path. */
export interface ReadinessBinding {
  readonly pluginId: string;
  readonly capabilityId: string;
  readonly version: string;
  readonly moduleRef: string;
  readonly host: string;
  readonly networkPath: string;
}

/** Authorization is an input to readiness, not a fact inferred from a successful probe. */
export interface ReadinessAuthorization {
  readonly residentId: string;
  readonly lane: string;
  readonly operations: readonly string[];
}

export type RuntimeEvidenceKind = "existence" | "running" | "readback";
export type RuntimeEvidenceOutcome = "pass" | "fail";

/**
 * One externally observed fact. `source: "self"` is accepted by the type so callers can
 * report a bad probe, but the evaluator deliberately refuses to use self-reported evidence.
 */
export interface RuntimeEvidence {
  readonly kind: RuntimeEvidenceKind;
  readonly source: "external" | "self";
  readonly probeId: string;
  readonly observedAt: string;
  readonly scope: ReadinessScope;
  readonly version: string;
  readonly moduleRef: string;
  readonly outcome: RuntimeEvidenceOutcome;
  /** Conditions and measurements belong to the same evidence row; no naked numbers. */
  readonly conditions: Readonly<Record<string, ReadinessValue>>;
  readonly measurements?: Readonly<Record<string, number>>;
  readonly detail?: string;
}

export interface ReadinessEvaluationInput {
  readonly definition: ReadinessDefinition;
  readonly binding: ReadinessBinding | null;
  readonly authorization: ReadinessAuthorization | null;
  readonly scope: ReadinessScope;
  readonly expectedConditions?: Readonly<Record<string, ReadinessValue>>;
  readonly evidence?: readonly RuntimeEvidence[];
  /** Clock injection keeps freshness tests deterministic. */
  readonly now?: string;
  readonly maxAgeMs?: number;
}

export interface ReadinessReceipt {
  readonly schemaVersion: typeof READINESS_RECEIPT_SCHEMA_VERSION;
  readonly status: ReadinessStatus;
  readonly definition: ReadinessDefinition;
  readonly binding: ReadinessBinding | null;
  readonly authorization: ReadinessAuthorization | null;
  /** This is the requested/proven boundary; it is proof only when status is ready. */
  readonly verifiedScope: ReadinessScope;
  /** Always present with verifiedScope; null means no successful verification exists. */
  readonly lastVerifiedAt: string | null;
  /**
   * Freshness window used to make this receipt. New ready receipts must persist it so a
   * restarted host can reject the receipt after the same window. It is optional only for
   * receipts written before #101 added the field; those legacy ready receipts parse but project
   * unknown until a fresh time-bound receipt is recorded.
   */
  readonly verificationWindowMs?: number | null;
  readonly evidence: readonly RuntimeEvidence[];
  readonly reasonCode?: ReasonCode;
  readonly reason?: ReadinessReason;
  readonly detail: string;
}

export type ReadinessReason =
  | "binding-missing"
  | "authorization-missing"
  | "evidence-missing"
  | "evidence-not-independent"
  | "scope-mismatch"
  | "version-mismatch"
  | "condition-mismatch"
  | "evidence-stale"
  | "existence-failed"
  | "running-failed"
  | "readback-failed";

export interface RuntimeReadbackProbe {
  readonly existence: (scope: ReadinessScope) => Promise<RuntimeEvidence>;
  readonly running: (scope: ReadinessScope) => Promise<RuntimeEvidence>;
  readonly readback: (scope: ReadinessScope) => Promise<RuntimeEvidence>;
}

/** Input and an observer owned by the current host invocation; callers do not supply a receipt. */
export interface RuntimeReadinessRequest {
  readonly input: ReadinessEvaluationInput;
  readonly probe: RuntimeReadbackProbe;
}

/**
 * Run an independent existence/running/readback probe and evaluate its receipt.
 * A probe that cannot answer is represented by missing evidence and therefore `unknown`;
 * this function never turns a thrown probe into an optimistic ready result.
 */
export async function readRuntimeReadiness(
  input: ReadinessEvaluationInput,
  probe: RuntimeReadbackProbe,
): Promise<ReadinessReceipt> {
  const evidence: RuntimeEvidence[] = [];
  for (const run of [probe.existence, probe.running, probe.readback]) {
    try {
      evidence.push(await run(input.scope));
    } catch {
      // An unavailable readback is not a failed assertion about the target. Keep it unknown.
    }
  }
  return evaluateRuntimeReadiness({ ...input, evidence });
}

/** Evaluate only evidence that is independent, scoped, current, and condition-bound. */
export function evaluateRuntimeReadiness(input: ReadinessEvaluationInput): ReadinessReceipt {
  const evidence = [...(input.evidence ?? [])];
  const base = {
    schemaVersion: READINESS_RECEIPT_SCHEMA_VERSION,
    definition: cloneDefinition(input.definition),
    binding: input.binding === null ? null : cloneBinding(input.binding),
    authorization: input.authorization === null ? null : cloneAuthorization(input.authorization),
    verifiedScope: cloneScope(input.scope),
    lastVerifiedAt: null,
    verificationWindowMs: input.maxAgeMs ?? null,
    evidence: cloneEvidence(evidence),
  } as const;

  const invalid = (reason: ReadinessReason, detail: string): ReadinessReceipt => ({
    ...base,
    status: "unknown",
    reasonCode: "CAPABILITY_UNVERIFIED",
    reason,
    detail,
  });

  if (!validScope(input.scope) || !validDefinition(input.definition)) {
    return invalid(
      "scope-mismatch",
      "readiness scope or definition is not a valid non-empty contract",
    );
  }
  if (input.binding === null) {
    return invalid("binding-missing", "capability definition exists but has no runtime binding");
  }
  if (!validBinding(input.binding)) {
    return invalid("version-mismatch", "runtime binding is not a valid scoped binding");
  }
  if (input.authorization === null) {
    return {
      ...base,
      status: "blocked",
      reasonCode: "PERMISSION_DENIED",
      reason: "authorization-missing",
      detail: "no authorization exists for this resident, lane, and operation set",
    };
  }
  if (!validAuthorization(input.authorization)) {
    return {
      ...base,
      status: "blocked",
      reasonCode: "PERMISSION_DENIED",
      reason: "authorization-missing",
      detail: "authorization is malformed or empty",
    };
  }
  if (!sameDefinition(input.definition, input.binding)) {
    return invalid(
      "version-mismatch",
      "definition, deployment, and runtime module identity disagree",
    );
  }
  if (!sameIdentityScope(input.scope, input.binding)) {
    return invalid("scope-mismatch", "runtime binding does not cover this host or network path");
  }
  if (
    input.authorization.residentId !== input.scope.residentId ||
    input.authorization.lane !== input.scope.lane ||
    !containsAll(input.authorization.operations, input.scope.operations)
  ) {
    return {
      ...base,
      status: "blocked",
      reasonCode: "PERMISSION_DENIED",
      reason: "authorization-missing",
      detail: "authorization does not cover the requested resident, lane, or operations",
    };
  }
  if (input.expectedConditions !== undefined && !validConditions(input.expectedConditions)) {
    return invalid("condition-mismatch", "expected conditions are not a valid non-empty-key map");
  }
  if (evidence.length === 0) {
    return invalid(
      "evidence-missing",
      "no independent runtime existence, running, or readback evidence",
    );
  }

  const now = input.now === undefined ? Date.now() : Date.parse(input.now);
  if (!Number.isFinite(now))
    return invalid("evidence-stale", "readiness clock is not a valid ISO timestamp");
  if (input.maxAgeMs === undefined) {
    return invalid(
      "evidence-stale",
      "a positive maxAgeMs is required to persist a time-bound readiness receipt",
    );
  }
  if (!Number.isFinite(input.maxAgeMs) || input.maxAgeMs <= 0) {
    return invalid("evidence-stale", "maxAgeMs must be a positive finite number");
  }

  const probeIds = new Set<string>();
  for (const item of evidence) {
    const observed = Date.parse(item.observedAt);
    if (!validEvidence(item)) {
      return invalid(
        "scope-mismatch",
        "runtime evidence is malformed or outside the requested scope",
      );
    }
    if (item.source !== "external") {
      return invalid(
        "evidence-not-independent",
        "runtime evidence is self-reported and cannot prove readiness",
      );
    }
    if (probeIds.has(item.probeId)) {
      return invalid(
        "evidence-not-independent",
        "existence, running, and readback evidence must use distinct external probe ids",
      );
    }
    probeIds.add(item.probeId);
    if (
      !sameIdentityScope(item.scope, input.scope) ||
      item.scope.residentId !== input.scope.residentId ||
      item.scope.lane !== input.scope.lane ||
      !containsAll(input.scope.operations, item.scope.operations) ||
      item.version !== input.definition.version ||
      item.version !== input.binding.version ||
      item.moduleRef !== input.definition.moduleRef ||
      item.moduleRef !== input.binding.moduleRef
    ) {
      return invalid(
        "scope-mismatch",
        "runtime evidence is self-reported or outside the requested scope",
      );
    }
    if (input.maxAgeMs !== undefined && now - observed > input.maxAgeMs) {
      return invalid(
        "evidence-stale",
        "runtime evidence is older than the accepted verification window",
      );
    }
    if (observed > now) return invalid("evidence-stale", "runtime evidence is from the future");
    if (
      input.expectedConditions !== undefined &&
      !sameConditions(input.expectedConditions, item.conditions)
    ) {
      return invalid(
        "condition-mismatch",
        "runtime evidence conditions do not match the requested path",
      );
    }
  }

  const requiredKinds: readonly RuntimeEvidenceKind[] = ["existence", "running", "readback"];
  for (const kind of requiredKinds) {
    if (!evidence.some((item) => item.kind === kind)) {
      return invalid("evidence-missing", `missing independent ${kind} evidence`);
    }
  }

  const readbackOperations = new Set(
    evidence.filter((item) => item.kind === "readback").flatMap((item) => item.scope.operations),
  );
  if (!containsAll([...readbackOperations], input.scope.operations)) {
    return invalid("evidence-missing", "runtime readback does not cover every requested operation");
  }

  const failed = evidence.filter((item) => item.outcome === "fail");
  if (failed.length > 0) {
    const first = failed[0];
    if (first?.kind === "existence") {
      return failedReceipt(
        base,
        "existence-failed",
        "PLUGIN_RUNTIME_FAILED",
        "independent existence probe failed",
      );
    }
    if (first?.kind === "running") {
      return failedReceipt(
        base,
        "running-failed",
        "PLUGIN_RUNTIME_FAILED",
        "independent running probe failed",
      );
    }
    const passedReadbackOperations = new Set(
      evidence
        .filter((item) => item.kind === "readback" && item.outcome === "pass")
        .flatMap((item) => item.scope.operations),
    );
    const hasPartialReadback = input.scope.operations.some((operation) =>
      passedReadbackOperations.has(operation),
    );
    return failedReceipt(
      base,
      "readback-failed",
      "PLUGIN_RUNTIME_FAILED",
      hasPartialReadback
        ? "runtime readback failed for part of the authorized operation set"
        : "runtime readback failed for the requested path",
      hasPartialReadback ? "degraded" : "blocked",
    );
  }

  const verifiedAt = latestObservedAt(evidence);
  return {
    ...base,
    status: "ready",
    lastVerifiedAt: verifiedAt,
    detail: "independent existence, running, and scoped runtime readback all passed",
  };
}

/** Runtime type guard for the existing #97 verifiedScope authority field. */
export function isReadinessScope(value: unknown): value is ReadinessScope {
  return validScope(value);
}

/** Stable parser used by the durable authority store; malformed receipts cannot project ready. */
export function isReadinessReceipt(value: unknown): value is ReadinessReceipt {
  if (!isRecord(value)) return false;
  if (
    value.schemaVersion !== READINESS_RECEIPT_SCHEMA_VERSION ||
    !isReadinessStatus(value.status) ||
    typeof value.detail !== "string"
  ) {
    return false;
  }
  if (!validDefinition(value.definition)) return false;
  const definition = value.definition;
  const binding = value.binding;
  const authorization = value.authorization;
  const verifiedScope = value.verifiedScope;
  const evidence = value.evidence;
  if (binding !== null && !validBinding(binding)) return false;
  if (authorization !== null && !validAuthorization(authorization)) return false;
  if (!validScope(verifiedScope)) return false;
  if (
    value.lastVerifiedAt !== null &&
    (typeof value.lastVerifiedAt !== "string" || !Number.isFinite(Date.parse(value.lastVerifiedAt)))
  )
    return false;
  if (
    value.verificationWindowMs !== undefined &&
    value.verificationWindowMs !== null &&
    (typeof value.verificationWindowMs !== "number" ||
      !Number.isFinite(value.verificationWindowMs) ||
      value.verificationWindowMs <= 0)
  )
    return false;
  if (
    value.status === "ready" &&
    value.verificationWindowMs !== undefined &&
    (typeof value.verificationWindowMs !== "number" ||
      !Number.isFinite(value.verificationWindowMs) ||
      value.verificationWindowMs <= 0)
  )
    return false;
  if (!Array.isArray(evidence) || !evidence.every(validEvidence)) return false;
  if (!hasUniqueProbeIds(evidence)) return false;
  if (value.status !== "ready" && value.lastVerifiedAt !== null) return false;
  if (value.status !== "unknown" && evidence.some((item) => item.source !== "external"))
    return false;
  if (value.status === "ready") {
    if (value.lastVerifiedAt === null) return false;
    if (value.lastVerifiedAt !== latestObservedAt(evidence)) return false;
    if (value.reason !== undefined || value.reasonCode !== undefined) return false;
    if (
      value.verificationWindowMs !== undefined &&
      typeof value.verificationWindowMs === "number" &&
      !evidenceWithinVerificationWindow(evidence, value.lastVerifiedAt, value.verificationWindowMs)
    ) {
      return false;
    }
  }
  if (
    value.status === "ready" &&
    (value.lastVerifiedAt === null ||
      binding === null ||
      authorization === null ||
      !sameDefinition(definition, binding) ||
      !sameIdentityScope(verifiedScope, binding) ||
      authorization.residentId !== verifiedScope.residentId ||
      authorization.lane !== verifiedScope.lane ||
      !containsAll(authorization.operations, verifiedScope.operations) ||
      evidence.some(
        (item) =>
          item.outcome !== "pass" ||
          item.source !== "external" ||
          item.version !== definition.version ||
          item.moduleRef !== definition.moduleRef ||
          item.scope.residentId !== verifiedScope.residentId ||
          item.scope.lane !== verifiedScope.lane ||
          !containsAll(verifiedScope.operations, item.scope.operations) ||
          !sameIdentityScope(item.scope, verifiedScope),
      ) ||
      !["existence", "running", "readback"].every((kind) =>
        evidence.some((item) => item.kind === kind),
      ) ||
      !containsAll(
        evidence
          .filter((item) => item.kind === "readback")
          .flatMap((item) => item.scope.operations),
        verifiedScope.operations,
      ))
  )
    return false;
  if (value.reasonCode !== undefined && !isReasonCode(value.reasonCode)) return false;
  if (value.reason !== undefined && !isReadinessReason(value.reason)) return false;
  return true;
}

/** A projection used by the host: an active plugin without a receipt is explicitly unknown. */
export type ReadinessProjection =
  | {
      readonly status: "ready";
      readonly detail: string;
      readonly receipt: ReadinessReceipt;
      readonly reasonCode?: never;
    }
  | {
      readonly status: Exclude<ReadinessStatus, "ready">;
      readonly reasonCode: ReasonCode;
      readonly detail: string;
      readonly receipt?: ReadinessReceipt;
    };

export function projectReadiness(
  lifecycleState:
    | "active"
    | "blocked"
    | "quarantined"
    | "disposed"
    | "disposing"
    | "prepared"
    | "validated"
    | "discovered",
  receipt: ReadinessReceipt | undefined,
  now: string | number = Date.now(),
): ReadinessProjection {
  if (lifecycleState === "active" && receipt !== undefined && isReadinessReceipt(receipt)) {
    if (receipt.status === "ready" && !isReceiptCurrent(receipt, now)) {
      return {
        status: "unknown",
        reasonCode: "CAPABILITY_UNVERIFIED",
        detail: "runtime readiness receipt is expired or has no persisted verification window",
      };
    }
    if (receipt.status === "ready") {
      return {
        status: "ready",
        detail: receipt.detail,
        receipt,
      };
    }
    return {
      status: receipt.status,
      reasonCode: receipt.reasonCode ?? "CAPABILITY_UNVERIFIED",
      detail: receipt.detail,
      receipt,
    };
  }
  if (lifecycleState === "quarantined") {
    return {
      status: "quarantined",
      reasonCode: "DISPOSE_INCOMPLETE",
      detail: "plugin is quarantined; readiness is fail-closed",
    };
  }
  if (lifecycleState === "blocked") {
    return {
      status: "blocked",
      reasonCode: "CAPABILITY_UNVERIFIED",
      detail: "plugin is blocked; no readiness projection is exposed",
    };
  }
  return {
    status: "unknown",
    reasonCode: "CAPABILITY_UNVERIFIED",
    detail: "no runtime readiness receipt is available",
  };
}

function failedReceipt(
  base: Omit<ReadinessReceipt, "status" | "reasonCode" | "reason" | "detail" | "lastVerifiedAt"> & {
    readonly lastVerifiedAt: null;
  },
  reason: ReadinessReason,
  reasonCode: ReasonCode,
  detail: string,
  status: ReadinessStatus = "blocked",
): ReadinessReceipt {
  return { ...base, status, reasonCode, reason, detail, lastVerifiedAt: null };
}

function isReceiptCurrent(receipt: ReadinessReceipt, now: string | number): boolean {
  if (
    receipt.status !== "ready" ||
    receipt.lastVerifiedAt === null ||
    typeof receipt.verificationWindowMs !== "number" ||
    !Number.isFinite(receipt.verificationWindowMs) ||
    receipt.verificationWindowMs <= 0
  ) {
    return false;
  }
  const verifiedAt = Date.parse(receipt.lastVerifiedAt);
  const currentTime = typeof now === "number" ? now : Date.parse(now);
  return (
    Number.isFinite(verifiedAt) &&
    Number.isFinite(currentTime) &&
    verifiedAt <= currentTime &&
    currentTime - verifiedAt <= receipt.verificationWindowMs
  );
}

function evidenceWithinVerificationWindow(
  evidence: readonly RuntimeEvidence[],
  lastVerifiedAt: string,
  verificationWindowMs: number,
): boolean {
  const verifiedAt = Date.parse(lastVerifiedAt);
  if (!Number.isFinite(verifiedAt)) return false;
  return evidence.every((item) => {
    const observedAt = Date.parse(item.observedAt);
    return (
      Number.isFinite(observedAt) &&
      observedAt <= verifiedAt &&
      verifiedAt - observedAt <= verificationWindowMs
    );
  });
}

function latestObservedAt(evidence: readonly RuntimeEvidence[]): string {
  return evidence.reduce((latest, item) => {
    const latestAt = Date.parse(latest);
    const itemAt = Date.parse(item.observedAt);
    if (itemAt > latestAt || (itemAt === latestAt && item.observedAt > latest)) {
      return item.observedAt;
    }
    return latest;
  }, new Date(0).toISOString());
}

function cloneDefinition(value: ReadinessDefinition): ReadinessDefinition {
  return { ...value };
}
function cloneBinding(value: ReadinessBinding): ReadinessBinding {
  return { ...value };
}
function cloneAuthorization(value: ReadinessAuthorization): ReadinessAuthorization {
  return { ...value, operations: [...value.operations] };
}
function cloneScope(value: ReadinessScope): ReadinessScope {
  return { ...value, operations: [...value.operations] };
}
function cloneEvidence(values: readonly RuntimeEvidence[]): RuntimeEvidence[] {
  return values.map((value) => ({
    ...value,
    scope: cloneScope(value.scope),
    conditions: { ...value.conditions },
    ...(value.measurements === undefined ? {} : { measurements: { ...value.measurements } }),
  }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isReadinessStatus(value: unknown): value is ReadinessStatus {
  return (
    value === "ready" ||
    value === "degraded" ||
    value === "blocked" ||
    value === "quarantined" ||
    value === "unknown"
  );
}
function isReadinessReason(value: unknown): value is ReadinessReason {
  return (
    typeof value === "string" &&
    [
      "binding-missing",
      "authorization-missing",
      "evidence-missing",
      "evidence-not-independent",
      "scope-mismatch",
      "version-mismatch",
      "condition-mismatch",
      "evidence-stale",
      "existence-failed",
      "running-failed",
      "readback-failed",
    ].includes(value)
  );
}
function isReasonCode(value: unknown): value is ReasonCode {
  return (
    typeof value === "string" &&
    [
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
    ].includes(value)
  );
}
function validDefinition(value: unknown): value is ReadinessDefinition {
  return (
    isRecord(value) &&
    nonEmpty(value.pluginId) &&
    nonEmpty(value.capabilityId) &&
    nonEmpty(value.version) &&
    nonEmpty(value.moduleRef)
  );
}
function validBinding(value: unknown): value is ReadinessBinding {
  return (
    isRecord(value) &&
    nonEmpty(value.pluginId) &&
    nonEmpty(value.capabilityId) &&
    nonEmpty(value.version) &&
    nonEmpty(value.moduleRef) &&
    nonEmpty(value.host) &&
    nonEmpty(value.networkPath)
  );
}
function validAuthorization(value: unknown): value is ReadinessAuthorization {
  return (
    isRecord(value) &&
    nonEmpty(value.residentId) &&
    nonEmpty(value.lane) &&
    stringArray(value.operations)
  );
}
function validScope(value: unknown): value is ReadinessScope {
  return (
    isRecord(value) &&
    nonEmpty(value.residentId) &&
    nonEmpty(value.lane) &&
    stringArray(value.operations) &&
    value.operations.length > 0 &&
    nonEmpty(value.host) &&
    nonEmpty(value.networkPath) &&
    nonEmpty(value.version)
  );
}
function validEvidence(value: unknown): value is RuntimeEvidence {
  return (
    isRecord(value) &&
    (value.kind === "existence" || value.kind === "running" || value.kind === "readback") &&
    (value.source === "external" || value.source === "self") &&
    nonEmpty(value.probeId) &&
    nonEmpty(value.observedAt) &&
    Number.isFinite(Date.parse(value.observedAt)) &&
    validScope(value.scope) &&
    nonEmpty(value.version) &&
    nonEmpty(value.moduleRef) &&
    (value.outcome === "pass" || value.outcome === "fail") &&
    validConditions(value.conditions) &&
    (value.measurements === undefined || validMeasurements(value.measurements))
  );
}
function validConditions(value: unknown): value is Readonly<Record<string, ReadinessValue>> {
  return (
    isRecord(value) &&
    Object.entries(value).every(([key, item]) => nonEmpty(key) && validValue(item))
  );
}
function validMeasurements(value: unknown): value is Readonly<Record<string, number>> {
  return (
    isRecord(value) &&
    Object.values(value).every((item) => typeof item === "number" && Number.isFinite(item))
  );
}
function validValue(value: unknown): value is ReadinessValue {
  return (
    (typeof value === "string" && value.length > 0) ||
    (typeof value === "number" && Number.isFinite(value)) ||
    typeof value === "boolean"
  );
}
function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function stringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(nonEmpty);
}
function containsAll(haystack: readonly string[], needles: readonly string[]): boolean {
  const values = new Set(haystack);
  return needles.every((value) => values.has(value));
}
function hasUniqueProbeIds(evidence: readonly RuntimeEvidence[]): boolean {
  return new Set(evidence.map((item) => item.probeId)).size === evidence.length;
}
function sameDefinition(definition: ReadinessDefinition, binding: ReadinessBinding): boolean {
  return (
    definition.pluginId === binding.pluginId &&
    definition.capabilityId === binding.capabilityId &&
    definition.version === binding.version &&
    definition.moduleRef === binding.moduleRef
  );
}
function sameIdentityScope(
  scope: ReadinessScope,
  binding: Pick<ReadinessBinding, "host" | "networkPath" | "version">,
): boolean {
  return (
    scope.host === binding.host &&
    scope.networkPath === binding.networkPath &&
    scope.version === binding.version
  );
}
function sameConditions(
  expected: Readonly<Record<string, ReadinessValue>>,
  actual: Readonly<Record<string, ReadinessValue>>,
): boolean {
  const expectedEntries = Object.entries(expected);
  return (
    expectedEntries.length === Object.keys(actual).length &&
    expectedEntries.every(([key, value]) => actual[key] === value)
  );
}

// Descriptive aliases keep callers from coupling to whether the operation is a pure evaluation
// or a probe-backed readback; both paths share exactly the same contract and failure semantics.
export const checkRuntimeReadiness = readRuntimeReadiness;
export const evaluateReadiness = evaluateRuntimeReadiness;
