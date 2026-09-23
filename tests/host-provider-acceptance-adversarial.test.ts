import { describe, expect, it } from "vitest";
import { hostProviderChecks } from "../acceptance/host-provider-checks.ts";
import type {
  CredentialBoundarySnapshot,
  CredentialReference,
  DispatchEnvelope,
  DispatchReceipt,
  DispatchScenario,
  DispatchStage,
  EgressRecord,
  ExternalBindingSnapshot,
  FailureKind,
  FailureOutcome,
  HealthProbeAttempt,
  HealthReadback,
  HealthScenario,
  HostProviderDriver,
  ImportedResident,
  InFlightWake,
  ObservabilitySnapshot,
  ProviderAccessRecord,
  ProviderBindingSnapshot,
  ProviderNeutralExport,
  ResidentFixture,
  Result,
  ScopeFixture,
} from "../acceptance/host-provider-driver.ts";

type Fault =
  | "empty-observed-at"
  | "reject-current-dispatch"
  | "accept-stale-window"
  | "mutate-on-stale-settlement"
  | "skip-receipt-stages"
  | "plaintext-credential-ref"
  | "no-failure-evidence"
  | "rewrite-resident-on-failure"
  | "self-report-as-health"
  | "currency-on-unavailable"
  | "leak-private-canary"
  | "provider-id-in-export"
  | "reaccess-source-on-import"
  | "revive-after-revoke";

const cloneResident = (resident: ResidentFixture): ResidentFixture => ({
  ...resident,
  commitments: [...resident.commitments],
});

const cloneProvider = (provider: ProviderBindingSnapshot): ProviderBindingSnapshot => ({
  ...provider,
});

const cloneScope = (scope: ScopeFixture): ScopeFixture => ({ ...scope });

class AdversarialDriver implements HostProviderDriver {
  private resident!: ResidentFixture;
  private scope!: ScopeFixture;
  private readonly providers = new Map<string, ProviderBindingSnapshot>();
  private readonly receipts = new Map<string, DispatchReceipt>();
  private readonly effects: string[] = [];
  private readonly failures: FailureOutcome[] = [];
  private readonly egress: EgressRecord[] = [];
  private readonly access: ProviderAccessRecord[] = [];
  private credentialRef = "";
  private resolvedCount = 0;
  private healthScenario: HealthScenario = {
    processRunning: false,
    selfReportedOnline: false,
    probe: "not-run",
  };
  private probe: HealthProbeAttempt = {
    probeId: "probe:not-run",
    startedAt: "2026-09-23T00:00:00.000Z",
  };
  private policyAvailable = true;
  private costAvailable = true;
  private sourceProviderId = "";
  private externalBinding: ExternalBindingSnapshot | null = null;

  constructor(private readonly fault: Fault | null) {}

  async reset(): Promise<void> {}

  async createResidentFixture(label: string): Promise<ResidentFixture> {
    this.resident = {
      residentId: `resident:${label}`,
      canonicalStateHash: `hash:${label}`,
      privateCanary: `private-canary:${label}`,
      commitments: [`commitment:${label}`],
      revocationAuthority: "resident-core",
    };
    return cloneResident(this.resident);
  }

  async createScopeFixture(residentId: string, label: string): Promise<ScopeFixture> {
    this.scope = {
      residentId,
      scopeId: `scope:${label}`,
      scopeGeneration: 1,
      windowId: `window:${label}`,
      generation: 1,
    };
    return cloneScope(this.scope);
  }

  async createCredentialReference(secretCanary: string): Promise<CredentialReference> {
    this.credentialRef =
      this.fault === "plaintext-credential-ref" ? secretCanary : "credential:opaque-1";
    return { credentialRef: this.credentialRef };
  }

  async provisionProvider(input: {
    providerId: string;
    kind: "local" | "contract-test-double";
    credentialRef: string | null;
    remote: boolean;
  }): Promise<Result<ProviderBindingSnapshot>> {
    const provider: ProviderBindingSnapshot = {
      providerId: input.providerId,
      kind: input.kind,
      lifecycle: "provisioned",
      residentId: null,
      scopeId: null,
      providerSessionId: `session:${input.providerId}:1`,
      credentialRef: input.credentialRef,
      revocationGeneration: 0,
    };
    this.providers.set(input.providerId, provider);
    this.access.push({ providerId: input.providerId, operation: "provision" });
    if (input.kind === "local" && this.sourceProviderId.length === 0) {
      this.sourceProviderId = input.providerId;
    }
    return { ok: true, value: cloneProvider(provider) };
  }

  async attachProvider(input: {
    providerId: string;
    residentId: string;
    scopeId: string;
  }): Promise<Result<ProviderBindingSnapshot>> {
    const provider = this.providers.get(input.providerId);
    if (provider === undefined) return { ok: false, reason: "PROVIDER_NOT_FOUND" };
    provider.lifecycle = "attached";
    provider.residentId = input.residentId;
    provider.scopeId = input.scopeId;
    this.access.push({ providerId: input.providerId, operation: "attach" });
    if (provider.kind === "contract-test-double") {
      this.egress.push({
        providerId: provider.providerId,
        residentId: input.residentId,
        fields: ["residentId"],
        payload:
          this.fault === "leak-private-canary"
            ? `authorized:${this.resident.privateCanary}`
            : "authorized:residentId",
      });
    }
    return { ok: true, value: cloneProvider(provider) };
  }

  async wakeProvider(providerId: string): Promise<Result<ProviderBindingSnapshot>> {
    const provider = this.providers.get(providerId);
    if (provider === undefined) return { ok: false, reason: "PROVIDER_NOT_FOUND" };
    if (provider.lifecycle === "revoked") return { ok: false, reason: "PROVIDER_REVOKED" };
    provider.lifecycle = "awake";
    if (provider.credentialRef !== null) this.resolvedCount += 1;
    return { ok: true, value: cloneProvider(provider) };
  }

  async stopProvider(providerId: string): Promise<Result<ProviderBindingSnapshot>> {
    const provider = this.providers.get(providerId);
    if (provider === undefined) return { ok: false, reason: "PROVIDER_NOT_FOUND" };
    provider.lifecycle = "stopped";
    return { ok: true, value: cloneProvider(provider) };
  }

  async revokeProvider(providerId: string): Promise<Result<ProviderBindingSnapshot>> {
    const provider = this.providers.get(providerId);
    if (provider === undefined) return { ok: false, reason: "PROVIDER_NOT_FOUND" };
    provider.lifecycle = "revoked";
    provider.revocationGeneration += 1;
    return { ok: true, value: cloneProvider(provider) };
  }

  async readProvider(providerId: string): Promise<ProviderBindingSnapshot> {
    const provider = this.providers.get(providerId);
    if (provider === undefined) throw new Error("PROVIDER_NOT_FOUND");
    return cloneProvider(provider);
  }

  async runHealthProbe(_providerId: string, scenario: HealthScenario): Promise<HealthProbeAttempt> {
    this.healthScenario = scenario;
    this.probe = {
      probeId: `probe:${scenario.probe}`,
      startedAt: "2026-09-23T00:00:00.000Z",
    };
    return { ...this.probe };
  }

  private healthReadback(): HealthReadback {
    if (this.healthScenario.probe !== "healthy") {
      return {
        status: "stale",
        source: this.healthScenario.processRunning ? "process" : null,
        probeId: this.probe.probeId,
        observedAt: "2026-09-22T23:59:59.000Z",
        reason: "PROBE_UNREACHABLE",
      };
    }
    return {
      status: "fresh",
      source: this.fault === "self-report-as-health" ? "self-report" : "probe",
      probeId: this.probe.probeId,
      observedAt: this.fault === "empty-observed-at" ? "" : "2026-09-23T00:00:01.000Z",
      reason: null,
    };
  }

  async readHealth(providerId: string): Promise<Result<HealthReadback>> {
    const provider = this.providers.get(providerId);
    if (provider?.lifecycle === "revoked") return { ok: false, reason: "PROVIDER_REVOKED" };
    return { ok: true, value: this.healthReadback() };
  }

  async dispatch(
    providerId: string,
    dispatch: DispatchEnvelope,
    scenario: DispatchScenario,
  ): Promise<Result<DispatchReceipt>> {
    if (this.fault === "reject-current-dispatch") {
      return { ok: false, reason: "REJECT_ALL" };
    }
    const required = [
      dispatch.residentId,
      dispatch.scopeId,
      dispatch.scopeGeneration,
      dispatch.windowId,
      dispatch.generation,
      dispatch.dispatchId,
    ];
    if (required.some((value) => value === undefined)) return { ok: false, reason: "MISSING" };
    if (dispatch.residentId !== this.scope.residentId || dispatch.scopeId !== this.scope.scopeId) {
      return { ok: false, reason: "SCOPE_MISMATCH" };
    }
    if (dispatch.scopeGeneration !== this.scope.scopeGeneration) {
      return { ok: false, reason: "STALE_SCOPE_GENERATION" };
    }
    if (dispatch.generation !== this.scope.generation && this.fault !== "accept-stale-window") {
      return { ok: false, reason: "STALE_GENERATION" };
    }
    const dispatchId = dispatch.dispatchId as string;
    const existing = this.receipts.get(dispatchId);
    if (existing !== undefined) return { ok: true, value: structuredClone(existing) };
    const lost = scenario.outcome === "receipt-lost";
    const stage = lost ? "unknown" : "visible";
    const normalStages: DispatchStage[] = lost
      ? ["accepted", "received", "executed", "unknown"]
      : ["accepted", "received", "executed", "visible"];
    const stageNames: DispatchStage[] =
      this.fault === "skip-receipt-stages" ? [stage] : normalStages;
    const effectId = `effect:${dispatchId}`;
    if (!this.effects.includes(effectId)) this.effects.push(effectId);
    const receipt: DispatchReceipt = {
      dispatchId,
      providerId,
      scopeGeneration: dispatch.scopeGeneration as number,
      generation: dispatch.generation as number,
      stage,
      stages: stageNames.map((name) => ({
        stage: name,
        observedAt: "2026-09-23T00:00:02.000Z",
        reason: name === "unknown" ? "RECEIPT_LOST" : null,
      })),
      effectId,
      providerReceiptId: `provider-receipt:${dispatchId}`,
      reason: lost ? "RECEIPT_LOST" : null,
    };
    this.receipts.set(dispatchId, receipt);
    return { ok: true, value: structuredClone(receipt) };
  }

  async readDispatch(dispatchId: string): Promise<Result<DispatchReceipt>> {
    const receipt = this.receipts.get(dispatchId);
    return receipt === undefined
      ? { ok: false, reason: "DISPATCH_NOT_FOUND" }
      : { ok: true, value: structuredClone(receipt) };
  }

  async settleDispatch(receipt: DispatchReceipt): Promise<Result<DispatchReceipt>> {
    if (receipt.scopeGeneration !== this.scope.scopeGeneration) {
      if (this.fault === "mutate-on-stale-settlement") {
        this.effects.push("effect:illegal-stale-settlement");
      }
      return { ok: false, reason: "STALE_SCOPE_GENERATION" };
    }
    return { ok: true, value: structuredClone(receipt) };
  }

  async readEffects(_providerId: string): Promise<string[]> {
    return [...this.effects];
  }

  async advanceScopeGeneration(_scopeId: string): Promise<ScopeFixture> {
    this.scope.scopeGeneration += 1;
    return cloneScope(this.scope);
  }

  async advanceWindowGeneration(_windowId: string): Promise<ScopeFixture> {
    this.scope.generation += 1;
    return cloneScope(this.scope);
  }

  async inspectCredentialBoundary(_providerId: string): Promise<CredentialBoundarySnapshot> {
    return {
      credentialRef: this.credentialRef,
      resolvedCount: this.resolvedCount,
      config: [],
      logs: [],
      receipts: [],
      exports: [],
    };
  }

  async simulateProviderFailure(providerId: string, kind: FailureKind): Promise<FailureOutcome> {
    if (this.fault === "no-failure-evidence") {
      return {
        failureId: "",
        providerId,
        kind,
        injected: false,
        status: "unknown",
        reason: "EMPTY_SIMULATION",
        effectCount: 0,
      };
    }
    if (this.fault === "rewrite-resident-on-failure") {
      this.resident = {
        ...this.resident,
        residentId: `${this.resident.residentId}:rewritten`,
        commitments: [],
        revocationAuthority: "resident-core",
      };
    }
    const outcome: FailureOutcome = {
      failureId: `failure:${kind}`,
      providerId,
      kind,
      injected: true,
      status: kind === "duplicate-wake" ? "deduplicated" : "unknown",
      reason: `INJECTED_${kind.toUpperCase()}`,
      effectCount: kind === "duplicate-wake" ? 1 : 0,
    };
    this.failures.push(outcome);
    return { ...outcome };
  }

  async readFailureLog(_providerId: string): Promise<FailureOutcome[]> {
    return this.failures.map((outcome) => ({ ...outcome }));
  }

  async readCanonicalState(_residentId: string): Promise<ResidentFixture> {
    return cloneResident(this.resident);
  }

  async readObservability(providerId: string): Promise<ObservabilitySnapshot> {
    return {
      providerId,
      adapterVersion: "1.0.0",
      capabilities: ["dispatch"],
      policyStatus: this.policyAvailable
        ? { status: "available", value: "policy:ok" }
        : { status: "unavailable", value: null },
      cost: this.costAvailable
        ? { status: "available", value: 0.25, currency: "AUD" }
        : {
            status: "unavailable",
            value: null,
            currency: this.fault === "currency-on-unavailable" ? "USD" : null,
          },
      lastHealth: this.healthReadback(),
    };
  }

  async setObservabilityAvailability(
    _providerId: string,
    input: { policy: "available" | "unavailable"; cost: "available" | "unavailable" },
  ): Promise<void> {
    this.policyAvailable = input.policy === "available";
    this.costAvailable = input.cost === "available";
  }

  async readEgressLog(): Promise<EgressRecord[]> {
    return structuredClone(this.egress);
  }

  async readProviderAccessLog(): Promise<ProviderAccessRecord[]> {
    return structuredClone(this.access);
  }

  async exportResident(residentId: string): Promise<ProviderNeutralExport> {
    return {
      format: "mist-host-export/v1",
      residentId,
      canonicalStateHash: this.resident.canonicalStateHash,
      payload:
        this.fault === "provider-id-in-export"
          ? `provider-bound:${this.sourceProviderId}`
          : "provider-neutral-payload",
      providerSpecificFields: [],
    };
  }

  async importResident(
    archive: ProviderNeutralExport,
    targetProviderId: string,
  ): Promise<Result<ImportedResident>> {
    if (this.fault === "reaccess-source-on-import") {
      this.access.push({ providerId: this.sourceProviderId, operation: "restore-read" });
    }
    this.access.push({ providerId: targetProviderId, operation: "restore-write" });
    return {
      ok: true,
      value: {
        residentId: archive.residentId,
        canonicalStateHash: archive.canonicalStateHash,
        providerId: targetProviderId,
      },
    };
  }

  async beginInFlightWake(providerId: string): Promise<Result<InFlightWake>> {
    const provider = this.providers.get(providerId);
    if (provider === undefined) return { ok: false, reason: "PROVIDER_NOT_FOUND" };
    return {
      ok: true,
      value: {
        requestId: "wake:in-flight",
        providerId,
        revocationGeneration: provider.revocationGeneration,
      },
    };
  }

  async completeInFlightWake(request: InFlightWake): Promise<Result<ProviderBindingSnapshot>> {
    const provider = this.providers.get(request.providerId);
    if (provider === undefined) return { ok: false, reason: "PROVIDER_NOT_FOUND" };
    if (request.revocationGeneration !== provider.revocationGeneration) {
      if (this.fault === "revive-after-revoke") {
        provider.lifecycle = "awake";
        this.effects.push("effect:revived-after-revoke");
      }
      return { ok: false, reason: "STALE_REVOCATION_GENERATION" };
    }
    provider.lifecycle = "awake";
    return { ok: true, value: cloneProvider(provider) };
  }

  async bindExternalAddress(input: {
    externalAddress: string;
    residentId: string;
    scopeId: string;
    providerId: string;
  }): Promise<Result<ExternalBindingSnapshot>> {
    const provider = this.providers.get(input.providerId);
    if (provider === undefined || provider.providerSessionId === null) {
      return { ok: false, reason: "PROVIDER_NOT_FOUND" };
    }
    this.externalBinding = {
      bindingId: "binding:1",
      ...input,
      providerSessionId: provider.providerSessionId,
    };
    return { ok: true, value: { ...this.externalBinding } };
  }

  async resolveExternalAddress(externalAddress: string): Promise<Result<ExternalBindingSnapshot>> {
    if (this.externalBinding?.externalAddress !== externalAddress) {
      return { ok: false, reason: "BINDING_NOT_FOUND" };
    }
    const provider = this.providers.get(this.externalBinding.providerId);
    if (provider?.providerSessionId === null || provider === undefined) {
      return { ok: false, reason: "PROVIDER_NOT_FOUND" };
    }
    return {
      ok: true,
      value: { ...this.externalBinding, providerSessionId: provider.providerSessionId },
    };
  }

  async replaceProviderSession(providerId: string): Promise<ProviderBindingSnapshot> {
    const provider = this.providers.get(providerId);
    if (provider === undefined) throw new Error("PROVIDER_NOT_FOUND");
    provider.providerSessionId = `session:${providerId}:2`;
    return cloneProvider(provider);
  }
}

const adversarialCases: Array<{ checkId: string; fault: Fault }> = [
  { checkId: "HP-02", fault: "empty-observed-at" },
  { checkId: "HP-03", fault: "reject-current-dispatch" },
  { checkId: "HP-03", fault: "accept-stale-window" },
  { checkId: "HP-04", fault: "mutate-on-stale-settlement" },
  { checkId: "HP-05", fault: "skip-receipt-stages" },
  { checkId: "HP-06", fault: "plaintext-credential-ref" },
  { checkId: "HP-07", fault: "no-failure-evidence" },
  { checkId: "HP-07", fault: "rewrite-resident-on-failure" },
  { checkId: "HP-08", fault: "self-report-as-health" },
  { checkId: "HP-08", fault: "currency-on-unavailable" },
  { checkId: "HC-01", fault: "leak-private-canary" },
  { checkId: "HC-02", fault: "provider-id-in-export" },
  { checkId: "HC-02", fault: "reaccess-source-on-import" },
  { checkId: "HC-03", fault: "revive-after-revoke" },
  { checkId: "HC-05", fault: "reaccess-source-on-import" },
];

describe("D24 HostProvider adversarial acceptance", () => {
  it.each(adversarialCases)("$checkId rejects $fault", async ({ checkId, fault }) => {
    const check = hostProviderChecks.find(({ id }) => id === checkId);
    if (check === undefined) throw new Error(`missing check ${checkId}`);

    const baseline = await check.run(new AdversarialDriver(null));
    expect(baseline, `${checkId} synthetic positive control`).toMatchObject({ passed: true });

    const attacked = await check.run(new AdversarialDriver(fault));
    expect(attacked, `${checkId} accepted adversarial fault ${fault}`).toMatchObject({
      passed: false,
    });
  });
});
