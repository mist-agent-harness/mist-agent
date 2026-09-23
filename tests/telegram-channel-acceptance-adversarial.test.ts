import { describe, expect, it } from "vitest";
import { telegramChannelChecks } from "../acceptance/telegram-channel-checks.ts";
import type {
  ChannelBinding,
  ChannelObservability,
  ContinuityActivation,
  ContinuityVotes,
  DispatchContext,
  DispatchIdentity,
  GroupFixture,
  GroupPlanStatus,
  GroupTraceEntry,
  HostDispatchSnapshot,
  InFlightChannelOperation,
  InboundReceipt,
  OutboundReceipt,
  OutboundRequest,
  ResidentFixture,
  Result,
  ScopeFixture,
  TelegramAddress,
  TelegramChannelDriver,
  TelegramUpdate,
  TokenBoundarySnapshot,
  TokenReference,
} from "../acceptance/telegram-channel-driver.ts";

type Fault =
  | "message-id-resolves"
  | "reject-all-inbound"
  | "wrong-dispatch-identity"
  | "duplicate-extra-effect"
  | "submitted-looks-visible"
  | "target-hints-win"
  | "token-leaks-in-receipt"
  | "token-resolves-after-revoke"
  | "unstable-revoke-reason"
  | "wrong-group-address"
  | "shadow-resident-on-switch"
  | "mutate-resident-on-blocked-activation"
  | "swap-group-residents"
  | "unknown-wrong-target";

const key = (value: TelegramAddress): string => JSON.stringify(value);
const cloneResident = (value: ResidentFixture): ResidentFixture => ({ ...value });
const cloneScope = (value: ScopeFixture): ScopeFixture => ({ ...value });
const cloneBinding = (value: ChannelBinding): ChannelBinding => ({
  ...value,
  address: { ...value.address },
});

class AdversarialTelegramDriver implements TelegramChannelDriver {
  private readonly residents = new Map<string, ResidentFixture>();
  private readonly scopes = new Map<string, ScopeFixture>();
  private readonly bindings = new Map<string, ChannelBinding>();
  private readonly addressBindings = new Map<string, string>();
  private readonly inbound = new Map<string, InboundReceipt>();
  private readonly outbound = new Map<string, OutboundReceipt>();
  private readonly inboundEffects: string[] = [];
  private readonly outboundEffects: string[] = [];
  private readonly issuedDispatches = new Set<string>();
  private readonly groups = new Map<string, GroupFixture>();
  private readonly votes = new Map<string, ContinuityVotes>();
  private hostDispatches = 0;
  private lastDispatch: DispatchIdentity | null = null;
  private tokenRef = "";
  private tokenSecret = "";
  private tokenAttached = false;
  private tokenRevoked = false;
  private tokenResolved = 0;
  private credentialGeneration = 1;
  private telegramAvailable = true;

  constructor(private readonly fault: Fault | null) {}

  async reset(): Promise<void> {}

  async createResidentFixture(
    label: string,
    model: string,
    provider: string,
  ): Promise<ResidentFixture> {
    const resident: ResidentFixture = {
      residentId: `resident:${label}`,
      model,
      provider,
      runtimeSessionId: `session:${label}:1`,
      canonicalStateHash: `hash:${label}`,
    };
    this.residents.set(resident.residentId, resident);
    return cloneResident(resident);
  }

  async createScopeFixture(residentId: string, label: string): Promise<ScopeFixture> {
    const scope: ScopeFixture = {
      residentId,
      scopeId: `scope:${label}`,
      scopeGeneration: 1,
      windowId: `window:${label}`,
      windowGeneration: 1,
      visible: true,
    };
    this.scopes.set(scope.scopeId, scope);
    return cloneScope(scope);
  }

  async setScopeVisibility(scopeId: string, visible: boolean): Promise<ScopeFixture> {
    const scope = this.scope(scopeId);
    scope.visible = visible;
    return cloneScope(scope);
  }

  async advanceScopeGeneration(scopeId: string): Promise<ScopeFixture> {
    const scope = this.scope(scopeId);
    scope.scopeGeneration += 1;
    return cloneScope(scope);
  }

  async bindAddress(input: {
    address: TelegramAddress;
    residentId: string;
    scopeId: string;
  }): Promise<Result<ChannelBinding>> {
    if (this.addressBindings.has(key(input.address))) {
      return { ok: false, reason: "BINDING_CONFLICT" };
    }
    const binding: ChannelBinding = {
      bindingId: `binding:${this.bindings.size + 1}`,
      address: { ...input.address },
      residentId: input.residentId,
      scopeId: input.scopeId,
      bindingVersion: 1,
      active: true,
    };
    this.bindings.set(binding.bindingId, binding);
    this.addressBindings.set(key(binding.address), binding.bindingId);
    return { ok: true, value: cloneBinding(binding) };
  }

  async readBinding(bindingId: string): Promise<ChannelBinding> {
    return cloneBinding(this.binding(bindingId));
  }

  async resolveAddress(address: TelegramAddress): Promise<Result<ChannelBinding>> {
    const bindingId = this.addressBindings.get(key(address));
    if (bindingId === undefined && this.fault === "message-id-resolves") {
      const first = this.bindings.values().next().value as ChannelBinding | undefined;
      if (first !== undefined) return { ok: true, value: cloneBinding(first) };
    }
    if (bindingId === undefined) return { ok: false, reason: "BINDING_NOT_FOUND" };
    return { ok: true, value: cloneBinding(this.binding(bindingId)) };
  }

  async revokeBinding(bindingId: string): Promise<Result<ChannelBinding>> {
    const binding = this.binding(bindingId);
    binding.active = false;
    binding.bindingVersion += 1;
    return { ok: true, value: cloneBinding(binding) };
  }

  async ingestUpdate(update: TelegramUpdate): Promise<Result<InboundReceipt>> {
    const bindingId = this.addressBindings.get(key(update.address));
    if (bindingId === undefined) return { ok: false, reason: "BINDING_NOT_FOUND" };
    const binding = this.binding(bindingId);
    if (!binding.active) {
      if (this.fault === "token-resolves-after-revoke") this.tokenResolved += 1;
      return {
        ok: false,
        reason: this.fault === "unstable-revoke-reason" ? "NOPE" : "BINDING_REVOKED",
      };
    }
    const scope = this.scope(binding.scopeId);
    if (!scope.visible) return { ok: false, reason: "SCOPE_NOT_VISIBLE" };
    if (this.fault === "reject-all-inbound") return { ok: false, reason: "REJECT_ALL" };
    const existing = this.inbound.get(update.updateId);
    if (existing !== undefined) {
      if (this.fault === "duplicate-extra-effect") {
        this.inboundEffects.push("effect:duplicate-extra");
      }
      return { ok: true, value: { ...existing, status: "duplicate" } };
    }
    const dispatchId = `dispatch:${update.updateId}`;
    const dispatch: DispatchIdentity = {
      residentId: this.fault === "wrong-dispatch-identity" ? "resident:wrong" : binding.residentId,
      scopeId: this.fault === "wrong-dispatch-identity" ? "scope:wrong" : binding.scopeId,
      scopeGeneration: scope.scopeGeneration,
      windowId: scope.windowId,
      windowGeneration: scope.windowGeneration,
      dispatchId,
      sourceMessageId: update.messageId,
    };
    const receipt: InboundReceipt = {
      updateId: update.updateId,
      status: "dispatched",
      reason: null,
      dispatch,
      effectId: `effect:${update.updateId}`,
    };
    this.inbound.set(update.updateId, receipt);
    this.inboundEffects.push(receipt.effectId as string);
    this.issuedDispatches.add(dispatchId);
    this.hostDispatches += 1;
    this.lastDispatch = { ...dispatch };
    if (this.tokenAttached && !this.tokenRevoked) this.tokenResolved += 1;
    return { ok: true, value: structuredClone(receipt) };
  }

  async readInboundEffects(): Promise<string[]> {
    return [...this.inboundEffects];
  }

  async readHostDispatch(): Promise<HostDispatchSnapshot> {
    return {
      hostProviderDispatches: this.hostDispatches,
      channelOwnedHosts: 0,
      lastDispatch: this.lastDispatch === null ? null : { ...this.lastDispatch },
    };
  }

  async sendOutbound(
    request: OutboundRequest,
    scenario:
      | "visible"
      | "submitted-only"
      | "accepted-only"
      | "receipt-lost"
      | "telegram-unavailable",
  ): Promise<Result<OutboundReceipt>> {
    const binding = this.bindings.get(request.context.bindingId);
    if (binding === undefined || !binding.active) {
      if (this.fault === "token-resolves-after-revoke") this.tokenResolved += 1;
      return {
        ok: false,
        reason: this.fault === "unstable-revoke-reason" ? "NOPE" : "BINDING_REVOKED",
      };
    }
    if (!this.issuedDispatches.has(request.context.dispatchId)) {
      return { ok: false, reason: "UNKNOWN_DISPATCH" };
    }
    if (this.tokenAttached && !this.tokenRevoked) this.tokenResolved += 1;
    let status: OutboundReceipt["status"];
    if (scenario === "submitted-only") status = "submitted";
    else if (scenario === "accepted-only") status = "accepted";
    else if (scenario === "visible") status = "visible";
    else status = "unknown";
    if (this.fault === "submitted-looks-visible" && scenario === "submitted-only") {
      status = "visible";
    }
    const hinted = request.untrustedTargetHints[0];
    const target =
      this.fault === "target-hints-win" && hinted !== undefined
        ? hinted.address
        : this.fault === "unknown-wrong-target" && status === "unknown"
          ? { chatId: "chat:replayed", topicId: null }
          : binding.address;
    const replyToMessageId =
      this.fault === "target-hints-win" && hinted !== undefined
        ? hinted.messageId
        : request.context.sourceMessageId;
    const effectId = `outbound-effect:${this.outbound.size + 1}`;
    const receipt: OutboundReceipt = {
      outboundId: `outbound:${this.outbound.size + 1}`,
      status,
      reason:
        this.fault === "token-leaks-in-receipt"
          ? this.tokenSecret
          : status === "unknown"
            ? scenario === "receipt-lost"
              ? "RECEIPT_LOST"
              : "TELEGRAM_UNAVAILABLE"
            : null,
      target: { ...target },
      bindingId: binding.bindingId,
      replyToMessageId,
      telegramMessageId: status === "visible" ? `telegram:${this.outbound.size + 1}` : null,
      effectId,
    };
    this.outbound.set(receipt.outboundId, receipt);
    if (!(this.fault === "unknown-wrong-target" && status === "unknown")) {
      this.outboundEffects.push(effectId);
    }
    return { ok: true, value: structuredClone(receipt) };
  }

  async readOutbound(outboundId: string): Promise<Result<OutboundReceipt>> {
    const receipt = this.outbound.get(outboundId);
    return receipt === undefined
      ? { ok: false, reason: "OUTBOUND_NOT_FOUND" }
      : { ok: true, value: structuredClone(receipt) };
  }

  async readOutboundEffects(): Promise<string[]> {
    return [...this.outboundEffects];
  }

  async createTokenReference(secretCanary: string): Promise<TokenReference> {
    this.tokenSecret = secretCanary;
    this.tokenRef = "credential:opaque-telegram";
    return { credentialRef: this.tokenRef };
  }

  async attachToken(credentialRef: string): Promise<void> {
    this.tokenRef = credentialRef;
    this.tokenAttached = true;
  }

  async inspectTokenBoundary(): Promise<TokenBoundarySnapshot> {
    return {
      credentialRef: this.tokenRef,
      resolvedCount: this.tokenResolved,
      config: [],
      logs: [],
      receipts: [],
      errors: [],
    };
  }

  async revokeToken(): Promise<void> {
    this.tokenRevoked = true;
    this.credentialGeneration += 1;
  }

  async beginInFlightChannelOperation(
    direction: "inbound" | "outbound",
    bindingId: string,
  ): Promise<Result<InFlightChannelOperation>> {
    const binding = this.binding(bindingId);
    return {
      ok: true,
      value: {
        operationId: `operation:${direction}`,
        direction,
        bindingId,
        bindingVersion: binding.bindingVersion,
        credentialGeneration: this.credentialGeneration,
      },
    };
  }

  async completeInFlightChannelOperation(
    operation: InFlightChannelOperation,
  ): Promise<Result<InboundReceipt | OutboundReceipt>> {
    const binding = this.binding(operation.bindingId);
    if (
      !binding.active ||
      operation.bindingVersion !== binding.bindingVersion ||
      operation.credentialGeneration !== this.credentialGeneration
    ) {
      if (this.fault === "token-resolves-after-revoke") this.tokenResolved += 1;
      return {
        ok: false,
        reason: this.fault === "unstable-revoke-reason" ? "NOPE" : "CHANNEL_AUTHORITY_REVOKED",
      };
    }
    const scope = this.scope(binding.scopeId);
    if (operation.direction === "inbound" && scope.scopeGeneration > 1) {
      return { ok: false, reason: "STALE_SCOPE_GENERATION" };
    }
    return { ok: false, reason: "NO_SYNTHETIC_COMPLETION" };
  }

  async readObservability(bindingId: string): Promise<ChannelObservability> {
    return {
      adapterVersion: "1.0.0",
      botApiVersion: "10.1",
      capabilities: ["inbound", "outbound"],
      bindingVersion: this.binding(bindingId).bindingVersion,
      lastInbound: { status: "fresh", observedAt: "2026-09-23T00:00:01.000Z" },
      lastOutbound: this.telegramAvailable
        ? { status: "fresh", observedAt: "2026-09-23T00:00:02.000Z" }
        : { status: "unavailable", observedAt: null },
    };
  }

  async setTelegramAvailability(available: boolean): Promise<void> {
    this.telegramAvailable = available;
  }

  async restartChannel(): Promise<void> {}

  async switchResidentModel(
    residentId: string,
    model: string,
    provider: string,
  ): Promise<ResidentFixture> {
    const resident = this.resident(residentId);
    resident.model = model;
    resident.provider = provider;
    resident.runtimeSessionId = `${resident.runtimeSessionId}:next`;
    if (this.fault === "shadow-resident-on-switch") {
      this.residents.set("resident:shadow", {
        ...resident,
        residentId: "resident:shadow",
      });
    }
    return cloneResident(resident);
  }

  async listResidents(): Promise<ResidentFixture[]> {
    return [...this.residents.values()].map(cloneResident);
  }

  async setContinuityVotes(residentId: string, votes: ContinuityVotes): Promise<void> {
    this.votes.set(residentId, structuredClone(votes));
  }

  async activateContinuity(residentId: string): Promise<ContinuityActivation> {
    const votes = this.votes.get(residentId);
    const activated =
      votes?.machine === "passed" &&
      votes.resident === "accepted" &&
      votes.relationships.every((vote) => vote === "accepted");
    if (!activated && this.fault === "mutate-resident-on-blocked-activation") {
      const resident = this.resident(residentId);
      resident.residentId = "resident:shadow";
      resident.canonicalStateHash = "hash:mutated";
      return { residentId: "resident:shadow", activated: false, reason: "MISSING_VOTE" };
    }
    return {
      residentId,
      activated,
      reason: activated ? null : "MISSING_VOTE",
    };
  }

  async createGroupFixture(input: {
    address: TelegramAddress;
    members: Array<{ residentId: string; scopeId: string }>;
  }): Promise<GroupFixture> {
    const group: GroupFixture = {
      groupId: `group:${this.groups.size + 1}`,
      address: { ...input.address },
      members: input.members.map((member) => {
        const resident = this.resident(member.residentId);
        return { ...member, model: resident.model, provider: resident.provider };
      }),
    };
    this.groups.set(group.groupId, group);
    return structuredClone(group);
  }

  async runGroupRound(
    groupId: string,
    plans: Array<{ residentId: string; status: GroupPlanStatus }>,
  ): Promise<GroupTraceEntry[]> {
    const group = this.groups.get(groupId);
    if (group === undefined) throw new Error("GROUP_NOT_FOUND");
    return plans.map((plan, index) => {
      const residentId =
        this.fault === "swap-group-residents"
          ? (plans[plans.length - 1 - index]?.residentId ?? plan.residentId)
          : plan.residentId;
      const resident = this.resident(residentId);
      const member = group.members.find((candidate) => candidate.residentId === residentId);
      return {
        groupId: this.fault === "wrong-group-address" ? "group:wrong" : group.groupId,
        address:
          this.fault === "wrong-group-address"
            ? { chatId: "chat:wrong", topicId: null }
            : { ...group.address },
        residentId,
        scopeId: member?.scopeId ?? "scope:missing",
        dispatchId: `dispatch:group:${index}`,
        model: resident.model,
        provider: resident.provider,
        status: plan.status,
        outboundStatus:
          plan.status === "visible"
            ? "visible"
            : plan.status === "silent"
              ? null
              : this.fault === "swap-group-residents"
                ? "visible"
                : "rejected",
      };
    });
  }

  async readCanonicalState(residentId: string): Promise<ResidentFixture> {
    const resident = this.residents.get(residentId);
    if (resident === undefined) {
      const mutated = [...this.residents.values()][0];
      if (mutated !== undefined) return cloneResident(mutated);
      throw new Error("RESIDENT_NOT_FOUND");
    }
    return cloneResident(resident);
  }

  private resident(residentId: string): ResidentFixture {
    const resident = this.residents.get(residentId);
    if (resident === undefined) throw new Error("RESIDENT_NOT_FOUND");
    return resident;
  }

  private scope(scopeId: string): ScopeFixture {
    const scope = this.scopes.get(scopeId);
    if (scope === undefined) throw new Error("SCOPE_NOT_FOUND");
    return scope;
  }

  private binding(bindingId: string): ChannelBinding {
    const binding = this.bindings.get(bindingId);
    if (binding === undefined) throw new Error("BINDING_NOT_FOUND");
    return binding;
  }
}

const adversarialCases: Array<{ checkId: string; fault: Fault }> = [
  { checkId: "TG-01", fault: "message-id-resolves" },
  { checkId: "TG-02", fault: "reject-all-inbound" },
  { checkId: "TG-03", fault: "wrong-dispatch-identity" },
  { checkId: "TG-04", fault: "duplicate-extra-effect" },
  { checkId: "TG-05", fault: "submitted-looks-visible" },
  { checkId: "TG-06", fault: "target-hints-win" },
  { checkId: "TG-07", fault: "token-leaks-in-receipt" },
  { checkId: "TG-08", fault: "token-resolves-after-revoke" },
  { checkId: "TG-08", fault: "unstable-revoke-reason" },
  { checkId: "GD-01", fault: "wrong-group-address" },
  { checkId: "GD-02", fault: "shadow-resident-on-switch" },
  { checkId: "GD-03", fault: "mutate-resident-on-blocked-activation" },
  { checkId: "GD-04", fault: "swap-group-residents" },
  { checkId: "GD-05", fault: "unknown-wrong-target" },
];

describe("D26 Telegram channel adversarial acceptance", () => {
  it.each(adversarialCases)("$checkId rejects $fault", async ({ checkId, fault }) => {
    const check = telegramChannelChecks.find(({ id }) => id === checkId);
    if (check === undefined) throw new Error(`missing check ${checkId}`);

    const baseline = await check.run(new AdversarialTelegramDriver(null));
    expect(baseline, `${checkId} synthetic positive control`).toMatchObject({ passed: true });

    const attacked = await check.run(new AdversarialTelegramDriver(fault));
    expect(attacked, `${checkId} accepted adversarial fault ${fault}`).toMatchObject({
      passed: false,
    });
  });
});
