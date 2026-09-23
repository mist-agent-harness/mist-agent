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
  | "seen-id-resolves"
  | "seen-id-topic-resolves"
  | "seen-sender-used-as-resident"
  | "reject-all-inbound"
  | "current-completion-rejected"
  | "scope-generation-noop"
  | "scope-generation-return-only"
  | "wrong-dispatch-identity"
  | "live-scope-mutation"
  | "duplicate-extra-effect"
  | "submitted-looks-visible"
  | "unknown-has-message-id"
  | "durable-status-promoted"
  | "durable-binding-moved"
  | "live-address-mutation"
  | "target-hints-win"
  | "durable-target-hints-win"
  | "token-leaks-in-receipt"
  | "token-leaks-in-fixture"
  | "token-leaks-in-durable-receipt"
  | "token-leaks-in-inbound-effect"
  | "token-resolves-after-revoke"
  | "hidden-token-resolve-log"
  | "token-leaks-early-snapshot"
  | "revoked-requests-write-effects"
  | "revoke-token-noop"
  | "unstable-revoke-reason"
  | "send-fails-observability-fresh"
  | "unavailable-send-still-visible"
  | "unavailable-durable-visible"
  | "wrong-group-address"
  | "group-shadow-residents"
  | "group-wrong-scope"
  | "group-unissued-dispatch"
  | "group-fixture-shadow-members"
  | "group-shared-runtime"
  | "shadow-resident-on-switch"
  | "census-state-drift"
  | "binding-drift-on-switch"
  | "mutate-resident-on-blocked-activation"
  | "live-resident-mutation-on-blocked"
  | "swap-group-residents"
  | "live-group-mutation"
  | "unknown-wrong-target"
  | "binding-drift-after-restart";

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
  private readonly groupDispatches = new Map<string, DispatchIdentity[]>();
  private readonly votes = new Map<string, ContinuityVotes>();
  private readonly seenExternalIds = new Set<string>();
  private hostDispatches = 0;
  private lastDispatch: DispatchIdentity | null = null;
  private tokenRef = "";
  private tokenSecret = "";
  private tokenAttached = false;
  private tokenRevoked = false;
  private tokenResolved = 0;
  private credentialGeneration = 1;
  private telegramAvailable = true;
  private restartCount = 0;
  private modelSwitchCount = 0;
  private boundaryInspectCount = 0;

  constructor(private readonly fault: Fault | null) {}

  async reset(): Promise<void> {}

  async createResidentFixture(
    label: string,
    model: string,
    provider: string,
  ): Promise<ResidentFixture> {
    const resident: ResidentFixture = {
      residentId: `resident:${label}`,
      model: this.fault === "token-leaks-in-fixture" ? this.tokenSecret : model,
      provider,
      runtimeSessionId: `session:${label}:1`,
      canonicalStateHash:
        this.fault === "token-leaks-in-fixture" ? this.tokenSecret : `hash:${label}`,
    };
    this.residents.set(resident.residentId, resident);
    return this.fault === "live-resident-mutation-on-blocked" ? resident : cloneResident(resident);
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
    return this.fault === "live-scope-mutation" ? scope : cloneScope(scope);
  }

  async setScopeVisibility(scopeId: string, visible: boolean): Promise<ScopeFixture> {
    const scope = this.scope(scopeId);
    scope.visible = visible;
    return cloneScope(scope);
  }

  async advanceScopeGeneration(scopeId: string): Promise<ScopeFixture> {
    const scope = this.scope(scopeId);
    if (this.fault === "scope-generation-return-only") {
      return { ...cloneScope(scope), scopeGeneration: scope.scopeGeneration + 1 };
    }
    if (this.fault !== "scope-generation-noop") scope.scopeGeneration += 1;
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
    return {
      ok: true,
      value: this.fault === "live-address-mutation" ? binding : cloneBinding(binding),
    };
  }

  async readBinding(bindingId: string): Promise<ChannelBinding> {
    const value = cloneBinding(this.binding(bindingId));
    if (this.fault === "binding-drift-after-restart" && this.restartCount > 0) {
      value.address = { chatId: "chat:drifted", topicId: "topic:drifted" };
      value.active = false;
      value.bindingVersion = 99;
    }
    if (this.fault === "binding-drift-on-switch" && this.modelSwitchCount > 0) {
      value.address = { chatId: "chat:drifted", topicId: "topic:drifted" };
      value.active = false;
      value.bindingVersion = 99;
    }
    return value;
  }

  async resolveAddress(address: TelegramAddress): Promise<Result<ChannelBinding>> {
    const bindingId = this.addressBindings.get(key(address));
    const externalIdUsed =
      this.seenExternalIds.has(address.chatId) ||
      (address.topicId !== null && this.seenExternalIds.has(address.topicId));
    if (
      bindingId === undefined &&
      ((this.fault === "seen-id-resolves" && externalIdUsed) ||
        (this.fault === "seen-id-topic-resolves" &&
          address.topicId !== null &&
          this.seenExternalIds.has(address.topicId)))
    ) {
      const first = this.bindings.values().next().value as ChannelBinding | undefined;
      if (first !== undefined) return { ok: true, value: cloneBinding(first) };
    }
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
    this.seenExternalIds.add(update.messageId);
    this.seenExternalIds.add(update.senderId);
    const bindingId = this.addressBindings.get(key(update.address));
    if (bindingId === undefined) return { ok: false, reason: "BINDING_NOT_FOUND" };
    const binding = this.binding(bindingId);
    if (!binding.active) {
      if (this.fault === "token-resolves-after-revoke") this.tokenResolved += 1;
      if (this.fault === "revoked-requests-write-effects") {
        this.inboundEffects.push(`effect:revoked-inbound:${update.updateId}`);
      }
      return {
        ok: false,
        reason: this.fault === "unstable-revoke-reason" ? "NOPE" : "BINDING_REVOKED",
      };
    }
    const scope = this.scope(binding.scopeId);
    if (this.fault === "live-scope-mutation" && update.updateId.includes("tg03")) {
      scope.scopeGeneration = 77;
      scope.windowGeneration = 88;
      scope.windowId = "window:rewritten";
    }
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
      residentId:
        this.fault === "wrong-dispatch-identity"
          ? "resident:wrong"
          : this.fault === "seen-sender-used-as-resident" &&
              update.updateId.includes("tg01-non-address")
            ? `resident:${update.senderId}`
            : binding.residentId,
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
      effectId:
        this.fault === "token-leaks-in-inbound-effect"
          ? `effect:${this.tokenSecret}`
          : `effect:${update.updateId}`,
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
      if (this.fault === "revoked-requests-write-effects") {
        this.outboundEffects.push(`effect:revoked-outbound:${request.context.dispatchId}`);
      }
      return {
        ok: false,
        reason: this.fault === "unstable-revoke-reason" ? "NOPE" : "BINDING_REVOKED",
      };
    }
    if (!this.issuedDispatches.has(request.context.dispatchId)) {
      return { ok: false, reason: "UNKNOWN_DISPATCH" };
    }
    if (this.tokenAttached && this.tokenRevoked) {
      if (this.fault === "revoked-requests-write-effects") {
        this.outboundEffects.push(`effect:revoked-token:${request.context.dispatchId}`);
      }
      return { ok: false, reason: "TOKEN_REVOKED" };
    }
    if (
      this.fault === "send-fails-observability-fresh" &&
      request.context.dispatchId.includes("tg09-context") &&
      scenario === "visible"
    ) {
      return { ok: false, reason: "NO_SEND" };
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
    if (this.fault === "unavailable-send-still-visible" && scenario === "telegram-unavailable") {
      status = "visible";
    }
    if (
      this.fault === "live-address-mutation" &&
      (request.context.dispatchId.includes("tg05-lost") ||
        request.context.dispatchId.includes("tg06-context") ||
        scenario === "telegram-unavailable")
    ) {
      binding.address.chatId = "chat:mutated-live";
      binding.address.topicId = "topic:mutated-live";
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
      telegramMessageId:
        status === "visible" || (this.fault === "unknown-has-message-id" && status === "unknown")
          ? `telegram:${this.outbound.size + 1}`
          : null,
      effectId,
    };
    const stored = structuredClone(receipt);
    if (this.fault === "token-leaks-in-durable-receipt") {
      stored.reason = this.tokenSecret;
      stored.telegramMessageId = this.tokenSecret;
      stored.effectId = this.tokenSecret;
    }
    if (
      this.fault === "durable-target-hints-win" &&
      request.context.dispatchId.includes("tg06-context") &&
      hinted !== undefined
    ) {
      stored.target = { ...hinted.address };
      stored.replyToMessageId = hinted.messageId;
    }
    if (this.fault === "unavailable-durable-visible" && scenario === "telegram-unavailable") {
      stored.status = "visible";
      stored.telegramMessageId = "telegram:fake-visible";
    }
    this.outbound.set(receipt.outboundId, stored);
    if (!(this.fault === "unknown-wrong-target" && status === "unknown")) {
      this.outboundEffects.push(effectId);
    }
    return { ok: true, value: structuredClone(receipt) };
  }

  async readOutbound(outboundId: string): Promise<Result<OutboundReceipt>> {
    const receipt = this.outbound.get(outboundId);
    if (
      receipt !== undefined &&
      this.fault === "durable-binding-moved" &&
      receipt.replyToMessageId?.includes("tg05-lost")
    ) {
      const binding = this.bindings.get(receipt.bindingId);
      if (binding !== undefined) binding.bindingId = "binding:moved";
      receipt.bindingId = "binding:moved";
    }
    if (
      receipt !== undefined &&
      this.fault === "durable-status-promoted" &&
      (receipt.status === "submitted" || receipt.status === "accepted")
    ) {
      return {
        ok: true,
        value: {
          ...structuredClone(receipt),
          status: "visible",
          telegramMessageId: "telegram:fake",
        },
      };
    }
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
    this.boundaryInspectCount += 1;
    return {
      credentialRef: this.tokenRef,
      credentialStatus: this.tokenRevoked
        ? "revoked"
        : this.tokenAttached
          ? "attached"
          : "detached",
      credentialGeneration: this.credentialGeneration,
      resolvedCount: this.tokenResolved,
      config: [],
      logs:
        this.fault === "hidden-token-resolve-log" && this.tokenRevoked
          ? [`resolved-after-revoke:${this.tokenSecret}`]
          : this.fault === "token-leaks-early-snapshot" && this.boundaryInspectCount <= 2
            ? [this.tokenSecret]
            : [],
      receipts: [],
      errors: [],
    };
  }

  async revokeToken(): Promise<void> {
    if (this.fault === "revoke-token-noop") return;
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
        scopeGeneration: this.scope(binding.scopeId).scopeGeneration,
        credentialGeneration: this.credentialGeneration,
      },
    };
  }

  async completeInFlightChannelOperation(
    operation: InFlightChannelOperation,
  ): Promise<Result<InboundReceipt | OutboundReceipt>> {
    const binding = this.binding(operation.bindingId);
    if (this.fault === "current-completion-rejected") {
      return { ok: false, reason: "STALE_SCOPE_GENERATION" };
    }
    if (
      !binding.active ||
      operation.bindingVersion !== binding.bindingVersion ||
      operation.credentialGeneration !== this.credentialGeneration
    ) {
      if (this.fault === "token-resolves-after-revoke") this.tokenResolved += 1;
      if (this.fault === "revoked-requests-write-effects") {
        const effects =
          operation.direction === "inbound" ? this.inboundEffects : this.outboundEffects;
        effects.push(`effect:revoked-inflight:${operation.operationId}`);
      }
      return {
        ok: false,
        reason: this.fault === "unstable-revoke-reason" ? "NOPE" : "CHANNEL_AUTHORITY_REVOKED",
      };
    }
    const scope = this.scope(binding.scopeId);
    if (operation.scopeGeneration !== scope.scopeGeneration) {
      return { ok: false, reason: "STALE_SCOPE_GENERATION" };
    }
    const dispatch: DispatchIdentity = {
      residentId: binding.residentId,
      scopeId: binding.scopeId,
      scopeGeneration: scope.scopeGeneration,
      windowId: scope.windowId,
      windowGeneration: scope.windowGeneration,
      dispatchId: `dispatch:${operation.operationId}`,
      sourceMessageId: `message:${operation.operationId}`,
    };
    return {
      ok: true,
      value: {
        updateId: `update:${operation.operationId}`,
        status: "dispatched",
        reason: null,
        dispatch,
        effectId: null,
      },
    };
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

  async restartChannel(): Promise<void> {
    this.restartCount += 1;
  }

  async switchResidentModel(
    residentId: string,
    model: string,
    provider: string,
  ): Promise<ResidentFixture> {
    const resident = this.resident(residentId);
    this.modelSwitchCount += 1;
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
    return [...this.residents.values()].map((resident) => {
      const value = cloneResident(resident);
      if (this.fault === "census-state-drift" && !value.residentId.includes("shadow")) {
        value.canonicalStateHash = "hash:mutated-in-census";
        value.runtimeSessionId = "session:stale";
      }
      return value;
    });
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
    if (
      !activated &&
      (this.fault === "mutate-resident-on-blocked-activation" ||
        this.fault === "live-resident-mutation-on-blocked")
    ) {
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
    if (this.fault === "group-fixture-shadow-members") {
      group.members = group.members.map((member, index) => ({
        ...member,
        residentId: `resident:shadow:${index}`,
        model: `model:shadow:${index}`,
        provider: `provider:shadow:${index}`,
      }));
    }
    if (this.fault === "group-shared-runtime") {
      group.members = group.members.map((member) => ({
        ...member,
        model: "model:shared",
        provider: "provider:shared",
      }));
    }
    this.groups.set(group.groupId, group);
    return this.fault === "live-address-mutation" || this.fault === "live-group-mutation"
      ? group
      : structuredClone(group);
  }

  async runGroupRound(
    groupId: string,
    plans: Array<{ residentId: string; status: GroupPlanStatus }>,
  ): Promise<GroupTraceEntry[]> {
    const group = this.groups.get(groupId);
    if (group === undefined) throw new Error("GROUP_NOT_FOUND");
    if (this.fault === "live-address-mutation") {
      group.address.chatId = "chat:mutated-live";
      group.address.topicId = "topic:mutated-live";
    }
    if (this.fault === "live-group-mutation") {
      group.groupId = "group:rewritten";
      group.address = { chatId: "chat:wrong", topicId: "topic:wrong" };
    }
    const hostDispatches: DispatchIdentity[] = [];
    const trace: GroupTraceEntry[] = plans.map((plan, index) => {
      const residentId =
        this.fault === "swap-group-residents"
          ? (plans[plans.length - 1 - index]?.residentId ?? plan.residentId)
          : plan.residentId;
      const reportedResidentId =
        this.fault === "group-shadow-residents" ? `resident:shadow:${index}` : residentId;
      const resident = this.resident(residentId);
      const member = group.members.find((candidate) => candidate.residentId === residentId);
      const dispatchId = `dispatch:group:${index}`;
      hostDispatches.push({
        residentId,
        scopeId: member?.scopeId ?? "scope:missing",
        scopeGeneration: 1,
        windowId: `window:group:${index}`,
        windowGeneration: 1,
        dispatchId,
        sourceMessageId: `message:group:${index}`,
      });
      return {
        groupId: this.fault === "wrong-group-address" ? "group:wrong" : group.groupId,
        address:
          this.fault === "wrong-group-address"
            ? { chatId: "chat:wrong", topicId: null }
            : { ...group.address },
        residentId: reportedResidentId,
        scopeId:
          this.fault === "group-wrong-scope" ? "scope:wrong" : (member?.scopeId ?? "scope:missing"),
        dispatchId:
          this.fault === "group-unissued-dispatch" ? `dispatch:not-issued:${index}` : dispatchId,
        model: this.fault === "group-shadow-residents" ? `model:shadow:${index}` : resident.model,
        provider:
          this.fault === "group-shadow-residents" ? `provider:shadow:${index}` : resident.provider,
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
    this.groupDispatches.set(group.groupId, hostDispatches);
    return trace;
  }

  async readGroupDispatches(groupId: string): Promise<DispatchIdentity[]> {
    return structuredClone(this.groupDispatches.get(groupId) ?? []);
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
  { checkId: "TG-01", fault: "seen-id-resolves" },
  { checkId: "TG-01", fault: "seen-id-topic-resolves" },
  { checkId: "TG-01", fault: "seen-sender-used-as-resident" },
  { checkId: "TG-02", fault: "reject-all-inbound" },
  { checkId: "TG-02", fault: "current-completion-rejected" },
  { checkId: "TG-02", fault: "scope-generation-noop" },
  { checkId: "TG-02", fault: "scope-generation-return-only" },
  { checkId: "TG-03", fault: "wrong-dispatch-identity" },
  { checkId: "TG-03", fault: "live-scope-mutation" },
  { checkId: "TG-04", fault: "duplicate-extra-effect" },
  { checkId: "TG-04", fault: "current-completion-rejected" },
  { checkId: "TG-04", fault: "scope-generation-return-only" },
  { checkId: "TG-05", fault: "submitted-looks-visible" },
  { checkId: "TG-05", fault: "unknown-has-message-id" },
  { checkId: "TG-05", fault: "durable-status-promoted" },
  { checkId: "TG-05", fault: "durable-binding-moved" },
  { checkId: "TG-05", fault: "live-address-mutation" },
  { checkId: "TG-06", fault: "target-hints-win" },
  { checkId: "TG-06", fault: "durable-target-hints-win" },
  { checkId: "TG-06", fault: "live-address-mutation" },
  { checkId: "TG-07", fault: "token-leaks-in-receipt" },
  { checkId: "TG-07", fault: "token-leaks-in-fixture" },
  { checkId: "TG-07", fault: "token-leaks-in-durable-receipt" },
  { checkId: "TG-07", fault: "token-leaks-in-inbound-effect" },
  { checkId: "TG-08", fault: "token-resolves-after-revoke" },
  { checkId: "TG-08", fault: "hidden-token-resolve-log" },
  { checkId: "TG-08", fault: "token-leaks-early-snapshot" },
  { checkId: "TG-08", fault: "revoked-requests-write-effects" },
  { checkId: "TG-08", fault: "revoke-token-noop" },
  { checkId: "TG-08", fault: "unstable-revoke-reason" },
  { checkId: "TG-09", fault: "send-fails-observability-fresh" },
  { checkId: "TG-09", fault: "unavailable-send-still-visible" },
  { checkId: "TG-09", fault: "unavailable-durable-visible" },
  { checkId: "GD-01", fault: "wrong-group-address" },
  { checkId: "GD-01", fault: "group-shadow-residents" },
  { checkId: "GD-01", fault: "group-wrong-scope" },
  { checkId: "GD-01", fault: "group-unissued-dispatch" },
  { checkId: "GD-01", fault: "group-fixture-shadow-members" },
  { checkId: "GD-01", fault: "group-shared-runtime" },
  { checkId: "GD-01", fault: "live-address-mutation" },
  { checkId: "GD-02", fault: "shadow-resident-on-switch" },
  { checkId: "GD-02", fault: "census-state-drift" },
  { checkId: "GD-02", fault: "binding-drift-on-switch" },
  { checkId: "GD-03", fault: "mutate-resident-on-blocked-activation" },
  { checkId: "GD-03", fault: "live-resident-mutation-on-blocked" },
  { checkId: "GD-04", fault: "swap-group-residents" },
  { checkId: "GD-04", fault: "live-group-mutation" },
  { checkId: "GD-05", fault: "unknown-wrong-target" },
  { checkId: "GD-05", fault: "live-address-mutation" },
  { checkId: "GD-05", fault: "binding-drift-after-restart" },
  { checkId: "GD-05", fault: "duplicate-extra-effect" },
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
