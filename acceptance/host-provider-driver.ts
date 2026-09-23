/**
 * #184 / D24 的 HostProvider 验收驱动契约。
 *
 * 判卷只通过本接口观察宿主，不 import `src/` 实现。实现方在
 * `src/host-provider-acceptance-driver.ts` 导出 `createHostProviderDriver()`；
 * 驱动缺失时十四盏灯全部保持红色。
 */

export type Result<T> = { ok: true; value: T } | { ok: false; reason: string };

export type ProviderKind = "local" | "contract-test-double";
export type ProviderLifecycle = "provisioned" | "attached" | "awake" | "stopped" | "revoked";
export type DispatchStage =
  | "accepted"
  | "received"
  | "executed"
  | "visible"
  | "unknown"
  | "rejected";
export type FailureKind =
  | "disconnect"
  | "duplicate-wake"
  | "timeout"
  | "receipt-lost"
  | "restart-replay";

export interface ResidentFixture {
  residentId: string;
  canonicalStateHash: string;
  privateCanary: string;
  commitments: string[];
  revocationAuthority: "resident-core";
}

export interface ScopeFixture {
  residentId: string;
  scopeId: string;
  scopeGeneration: number;
  windowId: string;
  generation: number;
}

export interface CredentialReference {
  credentialRef: string;
}

export interface ProviderBindingSnapshot {
  providerId: string;
  kind: ProviderKind;
  lifecycle: ProviderLifecycle;
  residentId: string | null;
  scopeId: string | null;
  providerSessionId: string | null;
  credentialRef: string | null;
  revocationGeneration: number;
}

export interface HealthReadback {
  status: "fresh" | "stale" | "unavailable";
  source: "probe" | "process" | "self-report" | null;
  probeId: string | null;
  observedAt: string | null;
  reason: string | null;
}

export interface HealthProbeAttempt {
  probeId: string;
  startedAt: string;
}

export interface HealthScenario {
  processRunning: boolean;
  selfReportedOnline: boolean;
  probe: "healthy" | "unreachable" | "not-run";
}

export interface DispatchEnvelope {
  residentId?: string;
  scopeId?: string;
  scopeGeneration?: number;
  windowId?: string;
  generation?: number;
  dispatchId?: string;
  payload?: string;
}

export interface DispatchReceipt {
  dispatchId: string;
  providerId: string;
  scopeGeneration: number;
  generation: number;
  stage: DispatchStage;
  stages: Array<{
    stage: DispatchStage;
    observedAt: string;
    reason: string | null;
  }>;
  effectId: string | null;
  providerReceiptId: string | null;
  reason: string | null;
}

export interface DispatchScenario {
  outcome: "visible" | "receipt-lost" | "timeout";
}

export interface CredentialBoundarySnapshot {
  credentialRef: string;
  resolvedCount: number;
  config: string[];
  logs: string[];
  receipts: string[];
  exports: string[];
}

export interface ObservabilitySnapshot {
  providerId: string;
  adapterVersion: string;
  capabilities: string[];
  policyStatus: { status: "available" | "unavailable"; value: string | null };
  cost: { status: "available" | "unavailable"; value: number | null; currency: string | null };
  lastHealth: HealthReadback;
}

export interface EgressRecord {
  providerId: string;
  residentId: string;
  fields: string[];
  payload: string;
}

export interface ProviderNeutralExport {
  format: "mist-host-export/v1";
  residentId: string;
  canonicalStateHash: string;
  payload: string;
  providerSpecificFields: string[];
}

export interface ImportedResident {
  residentId: string;
  canonicalStateHash: string;
  providerId: string;
}

export interface ProviderAccessRecord {
  providerId: string;
  operation: string;
}

export interface InFlightWake {
  requestId: string;
  providerId: string;
  revocationGeneration: number;
}

export interface FailureOutcome {
  failureId: string;
  providerId: string;
  kind: FailureKind;
  injected: boolean;
  status: "rejected" | "unknown" | "deduplicated";
  reason: string;
  effectCount: number;
}

export interface ExternalBindingSnapshot {
  bindingId: string;
  externalAddress: string;
  residentId: string;
  scopeId: string;
  providerId: string;
  providerSessionId: string;
}

export interface HostProviderDriver {
  /** 每盏灯后清掉合成住户、scope、provider、凭证和回执。 */
  reset(): Promise<void>;

  createResidentFixture(label: string): Promise<ResidentFixture>;
  createScopeFixture(residentId: string, label: string): Promise<ScopeFixture>;
  createCredentialReference(secretCanary: string): Promise<CredentialReference>;

  provisionProvider(input: {
    providerId: string;
    kind: ProviderKind;
    credentialRef: string | null;
    remote: boolean;
  }): Promise<Result<ProviderBindingSnapshot>>;
  attachProvider(input: {
    providerId: string;
    residentId: string;
    scopeId: string;
  }): Promise<Result<ProviderBindingSnapshot>>;
  wakeProvider(providerId: string): Promise<Result<ProviderBindingSnapshot>>;
  stopProvider(providerId: string): Promise<Result<ProviderBindingSnapshot>>;
  revokeProvider(providerId: string): Promise<Result<ProviderBindingSnapshot>>;
  readProvider(providerId: string): Promise<ProviderBindingSnapshot>;

  runHealthProbe(providerId: string, scenario: HealthScenario): Promise<HealthProbeAttempt>;
  readHealth(providerId: string): Promise<Result<HealthReadback>>;

  dispatch(
    providerId: string,
    envelope: DispatchEnvelope,
    scenario: DispatchScenario,
  ): Promise<Result<DispatchReceipt>>;
  readDispatch(dispatchId: string): Promise<Result<DispatchReceipt>>;
  settleDispatch(receipt: DispatchReceipt): Promise<Result<DispatchReceipt>>;
  readEffects(providerId: string): Promise<string[]>;
  advanceScopeGeneration(scopeId: string): Promise<ScopeFixture>;
  advanceWindowGeneration(windowId: string): Promise<ScopeFixture>;

  inspectCredentialBoundary(providerId: string): Promise<CredentialBoundarySnapshot>;
  simulateProviderFailure(providerId: string, kind: FailureKind): Promise<FailureOutcome>;
  readFailureLog(providerId: string): Promise<FailureOutcome[]>;
  readCanonicalState(residentId: string): Promise<ResidentFixture>;

  readObservability(providerId: string): Promise<ObservabilitySnapshot>;
  setObservabilityAvailability(
    providerId: string,
    input: { policy: "available" | "unavailable"; cost: "available" | "unavailable" },
  ): Promise<void>;

  readEgressLog(): Promise<EgressRecord[]>;
  readProviderAccessLog(): Promise<ProviderAccessRecord[]>;
  exportResident(residentId: string): Promise<ProviderNeutralExport>;
  importResident(
    archive: ProviderNeutralExport,
    targetProviderId: string,
  ): Promise<Result<ImportedResident>>;

  beginInFlightWake(providerId: string): Promise<Result<InFlightWake>>;
  completeInFlightWake(request: InFlightWake): Promise<Result<ProviderBindingSnapshot>>;

  bindExternalAddress(input: {
    externalAddress: string;
    residentId: string;
    scopeId: string;
    providerId: string;
  }): Promise<Result<ExternalBindingSnapshot>>;
  resolveExternalAddress(externalAddress: string): Promise<Result<ExternalBindingSnapshot>>;
  replaceProviderSession(providerId: string): Promise<ProviderBindingSnapshot>;
}

export interface HostProviderCheckResult {
  passed: boolean;
  detail: string;
}

export interface HostProviderCheck {
  id: string;
  title: string;
  uses: Array<keyof HostProviderDriver>;
  run(driver: HostProviderDriver): Promise<HostProviderCheckResult>;
}
