import { describe, expect, it } from "vitest";
import { telegramChannelChecks } from "../acceptance/telegram-channel-checks.ts";
import {
  type ChannelBinding,
  type ChannelObservability,
  type ContinuityActivation,
  type ContinuityVotes,
  type DispatchContext,
  type DispatchIdentity,
  type GroupFixture,
  type GroupPlanStatus,
  type GroupTraceEntry,
  type HostDispatchSnapshot,
  type InFlightChannelOperation,
  type InboundReceipt,
  type OutboundReceipt,
  type OutboundRequest,
  type ResidentFixture,
  type Result,
  type ScopeFixture,
  type TelegramAddress,
  type TelegramChannelDriver,
  type TelegramUpdate,
  type TokenBoundarySnapshot,
  type TokenReference,
  cloneTelegramChannelDriverBoundary,
} from "../acceptance/telegram-channel-driver.ts";

type Fault =
  | "message-id-resolves"
  | "seen-id-resolves"
  | "seen-id-topic-resolves"
  | "seen-sender-used-as-resident"
  | "resolve-mutates-tg01-oracles"
  | "tg01-scope-rewrites-resident"
  | "reject-all-inbound"
  | "current-completion-rejected"
  | "scope-generation-noop"
  | "scope-generation-return-only"
  | "coupled-generation-return-only"
  | "wrong-completion-generation"
  | "null-current-dispatch"
  | "invalid-failures-write-dispatch"
  | "unordered-wrong-identity"
  | "live-resident-mutation-tg02"
  | "live-resident-mutation-tg04"
  | "bind-renames-ready-oracles"
  | "ready-binding-healed-by-later-call"
  | "live-host-dispatch-snapshot"
  | "tg03-dispatch-healed-by-host-read"
  | "bind-mutates-tg03-oracles"
  | "tg04-first-wrong-identity"
  | "duplicate-replayed-dispatch"
  | "tg04-first-healed-by-duplicate"
  | "tg04-newer-healed-by-older"
  | "tg04-effect-ids-healed-by-ledger-read"
  | "current-operation-healed-by-complete"
  | "inflight-underreports-noop-advance"
  | "scope-readback-healed-by-next-begin"
  | "root-binding-healed-by-topic-bind"
  | "live-effect-ledger-mutation"
  | "wrong-dispatch-identity"
  | "live-scope-mutation"
  | "duplicate-extra-effect"
  | "submitted-looks-visible"
  | "unknown-has-message-id"
  | "durable-status-promoted"
  | "durable-binding-moved"
  | "live-receipt-message-mutation"
  | "visible-receipt-mutates-before-clone"
  | "live-address-mutation"
  | "target-hints-win"
  | "durable-target-hints-win"
  | "token-leaks-in-receipt"
  | "token-leaks-in-fixture"
  | "token-leaks-in-durable-receipt"
  | "token-leaks-in-inbound-effect"
  | "live-token-receipt-cleared-before-scan"
  | "tg07-inbound-leak-healed-by-send"
  | "tg07-durable-leak-healed-by-effect-read"
  | "tg07-inbound-effects-leak-healed-by-boundary"
  | "tg07-outbound-effects-leak-healed-by-boundary"
  | "token-ref-healed-by-boundary"
  | "token-resolves-after-revoke"
  | "hidden-token-resolve-log"
  | "token-leaks-early-snapshot"
  | "revoked-requests-write-effects"
  | "revoke-token-noop"
  | "token-only-inbound-allowed"
  | "token-only-inflight-allowed"
  | "middle-token-count-drift"
  | "unstable-revoke-reason"
  | "tg08-inbound-baseline-healed-by-outbound-read"
  | "credential-generation-healed-by-complete"
  | "send-fails-observability-fresh"
  | "observability-mutates-live-binding"
  | "observability-drifts-when-unavailable"
  | "unavailable-send-still-visible"
  | "unavailable-durable-visible"
  | "live-unavailable-receipt-mutation"
  | "wrong-group-address"
  | "group-shadow-residents"
  | "group-wrong-scope"
  | "group-unissued-dispatch"
  | "group-fixture-shadow-members"
  | "group-shared-runtime"
  | "gd01-scope-mutates-models"
  | "gd01-second-scope-mutates-first"
  | "gd01-trace-healed-by-host-read"
  | "shadow-resident-on-switch"
  | "census-state-drift"
  | "binding-drift-on-switch"
  | "live-resident-census-array"
  | "switch-return-stale-model"
  | "gd02-switch-healed-by-binding-read"
  | "gd02-binding-healed-by-resident-list"
  | "mutate-resident-on-blocked-activation"
  | "live-resident-mutation-on-blocked"
  | "gd03-activation-healed-by-canonical-read"
  | "rejected-continuity-vote-activates"
  | "swap-group-residents"
  | "live-group-mutation"
  | "unknown-wrong-target"
  | "binding-drift-after-restart"
  | "gd04-live-resident-swap"
  | "gd04-scope-create-swaps-residents"
  | "gd04-last-scope-swaps-residents"
  | "gd04-later-resident-mutates-first"
  | "gd04-later-scope-mutates-first"
  | "group-create-mutates-member-oracles"
  | "unknown-durable-message-id"
  | "replay-inbound-on-recovery"
  | "canonical-drift-after-recovery"
  | "canonical-fields-drift-after-recovery"
  | "unknown-binding-mutates-before-clone"
  | "gd05-binding-healed-by-canonical-read"
  | "live-token-boundary-snapshot"
  | "final-token-boundary-rewinds"
  | "wrong-group-speaker-after-switch";

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
  private returnedScopeGeneration: number | null = null;
  private tg01ResolvedMutation = false;
  private hostDispatchView: HostDispatchSnapshot | null = null;
  private tokenBoundaryView: TokenBoundarySnapshot | null = null;
  private residentCensusView: ResidentFixture[] | null = null;
  private readyBindingView: ChannelBinding | null = null;
  private tg03InboundView: InboundReceipt | null = null;
  private tg04NewerView: InboundReceipt | null = null;
  private tg07InboundView: InboundReceipt | null = null;
  private tg07DurableView: OutboundReceipt | null = null;
  private tg08BaselineInjected = false;
  private groupTraceView: GroupTraceEntry[] | null = null;
  private groupTraceTruth: GroupTraceEntry[] | null = null;
  private switchedView: ResidentFixture | null = null;
  private switchedTruth: ResidentFixture | null = null;
  private bindingView: ChannelBinding | null = null;
  private bindingTruth: ChannelBinding | null = null;
  private activationView: ContinuityActivation | null = null;
  private beginCount = 0;
  private scopeReadbackView: ScopeFixture | null = null;
  private tokenReferenceView: TokenReference | null = null;
  private rootBindingView: ChannelBinding | null = null;
  private rootBindingTruth: ChannelBinding | null = null;

  constructor(private readonly fault: Fault | null) {}

  async reset(): Promise<void> {}

  async createResidentFixture(
    label: string,
    model: string,
    provider: string,
  ): Promise<ResidentFixture> {
    if (this.fault === "gd04-later-resident-mutates-first" && label === "gd04-failed") {
      const first = this.resident("resident:gd04-visible");
      first.model = "model:rewritten-by-later-resident";
      first.provider = "provider:rewritten-by-later-resident";
      first.runtimeSessionId = "session:rewritten-by-later-resident";
      first.canonicalStateHash = "hash:rewritten-by-later-resident";
    }
    const resident: ResidentFixture = {
      residentId: `resident:${label}`,
      model: this.fault === "token-leaks-in-fixture" ? this.tokenSecret : model,
      provider,
      runtimeSessionId: `session:${label}:1`,
      canonicalStateHash:
        this.fault === "token-leaks-in-fixture" ? this.tokenSecret : `hash:${label}`,
    };
    this.residents.set(resident.residentId, resident);
    return this.fault === "live-resident-mutation-on-blocked" ||
      this.fault === "live-resident-mutation-tg02" ||
      this.fault === "live-resident-mutation-tg04" ||
      this.fault === "resolve-mutates-tg01-oracles" ||
      this.fault === "tg01-scope-rewrites-resident" ||
      this.fault === "bind-mutates-tg03-oracles" ||
      this.fault === "bind-renames-ready-oracles" ||
      this.fault === "group-create-mutates-member-oracles" ||
      this.fault === "gd04-live-resident-swap" ||
      this.fault === "gd04-scope-create-swaps-residents" ||
      this.fault === "gd04-last-scope-swaps-residents" ||
      this.fault === "gd04-later-resident-mutates-first" ||
      this.fault === "gd01-scope-mutates-models"
      ? resident
      : cloneResident(resident);
  }

  async createScopeFixture(residentId: string, label: string): Promise<ScopeFixture> {
    if (
      this.fault === "ready-binding-healed-by-later-call" &&
      label === "tg02-second" &&
      this.readyBindingView !== null
    ) {
      this.readyBindingView.bindingVersion = 99;
    }
    let scopeResidentId = residentId;
    if (this.fault === "tg01-scope-rewrites-resident" && label === "tg01") {
      const resident = this.resident(residentId);
      resident.residentId = "resident:rewritten-before-freeze";
      scopeResidentId = resident.residentId;
    }
    if (this.fault === "gd01-scope-mutates-models" && label === "gd01-b") {
      for (const resident of this.residents.values()) {
        if (resident.residentId.startsWith("resident:gd01-")) {
          resident.model = `model:rewritten:${resident.residentId}`;
          resident.provider = `provider:rewritten:${resident.residentId}`;
        }
      }
    }
    if (this.fault === "gd01-second-scope-mutates-first" && label === "gd01-b") {
      const first = this.scope("scope:gd01-a");
      first.scopeId = "scope:gd01-a:rewritten";
      first.windowId = "window:gd01-a:rewritten";
    }
    if (this.fault === "gd04-scope-create-swaps-residents" && label === "gd04-0") {
      const visible = this.resident("resident:gd04-visible");
      const failed = this.resident("resident:gd04-failed");
      const visibleId = visible.residentId;
      visible.residentId = failed.residentId;
      failed.residentId = visibleId;
      scopeResidentId = visible.residentId;
    }
    if (this.fault === "gd04-last-scope-swaps-residents" && label === "gd04-2") {
      const visible = this.resident("resident:gd04-visible");
      const failed = this.resident("resident:gd04-failed");
      const visibleId = visible.residentId;
      visible.residentId = failed.residentId;
      failed.residentId = visibleId;
    }
    if (this.fault === "gd04-later-scope-mutates-first" && label === "gd04-2") {
      const first = this.scope("scope:gd04-0");
      first.scopeId = "scope:gd04-0:rewritten";
      first.windowId = "window:gd04-0:rewritten";
    }
    const scope: ScopeFixture = {
      residentId: scopeResidentId,
      scopeId: `scope:${label}`,
      scopeGeneration: 1,
      windowId: `window:${label}`,
      windowGeneration: 1,
      visible: true,
    };
    this.scopes.set(scope.scopeId, scope);
    return this.fault === "live-scope-mutation" ||
      this.fault === "resolve-mutates-tg01-oracles" ||
      this.fault === "bind-mutates-tg03-oracles" ||
      this.fault === "bind-renames-ready-oracles" ||
      this.fault === "group-create-mutates-member-oracles" ||
      this.fault === "gd01-second-scope-mutates-first" ||
      this.fault === "gd04-later-scope-mutates-first"
      ? scope
      : cloneScope(scope);
  }

  async setScopeVisibility(scopeId: string, visible: boolean): Promise<ScopeFixture> {
    const scope = this.scope(scopeId);
    scope.visible = visible;
    const returned = cloneScope(scope);
    if (this.fault === "scope-readback-healed-by-next-begin") {
      this.scopeReadbackView = returned;
      return returned;
    }
    return returned;
  }

  async advanceScopeGeneration(scopeId: string): Promise<ScopeFixture> {
    const scope = this.scope(scopeId);
    if (this.fault === "scope-generation-return-only") {
      return { ...cloneScope(scope), scopeGeneration: scope.scopeGeneration + 1 };
    }
    if (this.fault === "coupled-generation-return-only") {
      this.returnedScopeGeneration = scope.scopeGeneration + 1;
      return { ...cloneScope(scope), scopeGeneration: this.returnedScopeGeneration };
    }
    if (
      this.fault !== "scope-generation-noop" &&
      this.fault !== "inflight-underreports-noop-advance"
    ) {
      scope.scopeGeneration += 1;
    }
    return cloneScope(scope);
  }

  async bindAddress(input: {
    address: TelegramAddress;
    residentId: string;
    scopeId: string;
  }): Promise<Result<ChannelBinding>> {
    if (
      this.fault === "root-binding-healed-by-topic-bind" &&
      input.address.topicId === "topic:7" &&
      this.rootBindingView !== null &&
      this.rootBindingTruth !== null
    ) {
      Object.assign(this.rootBindingView, cloneBinding(this.rootBindingTruth));
    }
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
    if (this.fault === "bind-renames-ready-oracles") {
      const resident = this.resident(input.residentId);
      const scope = this.scope(input.scopeId);
      resident.residentId = `${input.residentId}:renamed`;
      scope.residentId = resident.residentId;
      scope.scopeId = `${input.scopeId}:renamed`;
      binding.residentId = resident.residentId;
      binding.scopeId = scope.scopeId;
    }
    this.bindings.set(binding.bindingId, binding);
    this.addressBindings.set(key(binding.address), binding.bindingId);
    if (
      this.fault === "root-binding-healed-by-topic-bind" &&
      input.address.chatId === "chat:tg01" &&
      input.address.topicId === null
    ) {
      this.rootBindingTruth = cloneBinding(binding);
      this.rootBindingView = binding;
      binding.address = { chatId: "chat:wrong", topicId: null };
      binding.residentId = "resident:wrong";
      binding.scopeId = "scope:wrong";
      binding.bindingVersion = 99;
    }
    if (
      this.fault === "ready-binding-healed-by-later-call" &&
      input.address.chatId === "chat:tg02"
    ) {
      this.readyBindingView = binding;
    }
    if (this.fault === "bind-mutates-tg03-oracles" && input.scopeId.includes("tg03")) {
      this.resident(input.residentId).residentId = "resident:rewritten";
      const scope = this.scope(input.scopeId);
      scope.scopeId = "scope:rewritten";
      scope.scopeGeneration = 77;
      scope.windowId = "window:rewritten";
      scope.windowGeneration = 88;
    }
    return {
      ok: true,
      value:
        this.fault === "live-address-mutation" ||
        this.fault === "observability-mutates-live-binding" ||
        this.fault === "ready-binding-healed-by-later-call" ||
        this.fault === "root-binding-healed-by-topic-bind"
          ? binding
          : cloneBinding(binding),
    };
  }

  async readBinding(bindingId: string): Promise<ChannelBinding> {
    if (
      this.fault === "gd02-switch-healed-by-binding-read" &&
      this.switchedView !== null &&
      this.switchedTruth !== null
    ) {
      Object.assign(this.switchedView, cloneResident(this.switchedTruth));
    }
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
    if (this.fault === "gd02-binding-healed-by-resident-list" && this.modelSwitchCount > 0) {
      this.bindingTruth = cloneBinding(value);
      this.bindingView = value;
      value.address = { chatId: "chat:drifted", topicId: "topic:drifted" };
      value.active = false;
      value.bindingVersion = 99;
      return value;
    }
    if (this.fault === "gd05-binding-healed-by-canonical-read" && this.restartCount > 0) {
      this.bindingTruth = cloneBinding(value);
      this.bindingView = value;
      value.address = { chatId: "chat:drifted", topicId: "topic:drifted" };
      value.active = false;
      value.bindingVersion = 99;
      return value;
    }
    return value;
  }

  async resolveAddress(address: TelegramAddress): Promise<Result<ChannelBinding>> {
    const bindingId = this.addressBindings.get(key(address));
    if (
      bindingId !== undefined &&
      this.fault === "resolve-mutates-tg01-oracles" &&
      !this.tg01ResolvedMutation &&
      address.chatId === "chat:tg01"
    ) {
      const binding = this.binding(bindingId);
      const oldResidentId = binding.residentId;
      const oldScopeId = binding.scopeId;
      const resident = this.resident(oldResidentId);
      const scope = this.scope(oldScopeId);
      this.residents.delete(oldResidentId);
      this.scopes.delete(oldScopeId);
      resident.residentId = "resident:rewritten";
      scope.residentId = resident.residentId;
      scope.scopeId = "scope:rewritten";
      this.residents.set(resident.residentId, resident);
      this.scopes.set(scope.scopeId, scope);
      for (const stored of this.bindings.values()) {
        if (stored.residentId === oldResidentId) stored.residentId = resident.residentId;
        if (stored.scopeId === oldScopeId) stored.scopeId = scope.scopeId;
      }
      this.tg01ResolvedMutation = true;
    }
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
    if (this.fault === "visible-receipt-mutates-before-clone") {
      for (const receipt of this.outbound.values()) {
        if (receipt.status === "visible") {
          receipt.telegramMessageId = "telegram:rewritten-before-clone";
        }
      }
    }
    this.seenExternalIds.add(update.messageId);
    this.seenExternalIds.add(update.senderId);
    if (
      this.fault === "tg04-newer-healed-by-older" &&
      update.updateId.includes("tg04-100") &&
      this.tg04NewerView?.dispatch !== null &&
      this.tg04NewerView !== null
    ) {
      this.tg04NewerView.dispatch = {
        ...this.tg04NewerView.dispatch,
        residentId: "resident:tg04",
        scopeId: "scope:tg04",
        scopeGeneration: 1,
        windowId: "window:tg04",
        windowGeneration: 1,
      };
    }
    const bindingId = this.addressBindings.get(key(update.address));
    if (bindingId === undefined) {
      this.recordInvalidFailure("BINDING_NOT_FOUND");
      return { ok: false, reason: "BINDING_NOT_FOUND" };
    }
    const binding = this.binding(bindingId);
    if (!binding.active) {
      if (this.fault === "token-resolves-after-revoke") this.tokenResolved += 1;
      if (
        this.fault === "revoked-requests-write-effects" ||
        this.fault === "live-effect-ledger-mutation"
      ) {
        this.inboundEffects.push(`effect:revoked-inbound:${update.updateId}`);
      }
      this.recordInvalidFailure("BINDING_REVOKED");
      return {
        ok: false,
        reason: this.fault === "unstable-revoke-reason" ? "NOPE" : "BINDING_REVOKED",
      };
    }
    if (this.tokenAttached && this.tokenRevoked && this.fault !== "token-only-inbound-allowed") {
      if (this.fault === "live-effect-ledger-mutation") {
        this.inboundEffects.push(`effect:revoked-token-inbound:${update.updateId}`);
      }
      return { ok: false, reason: "TOKEN_REVOKED" };
    }
    const scope = this.scope(binding.scopeId);
    if (this.fault === "live-scope-mutation" && update.updateId.includes("tg03")) {
      scope.scopeGeneration = 77;
      scope.windowGeneration = 88;
      scope.windowId = "window:rewritten";
    }
    if (!scope.visible) {
      if (this.fault === "live-effect-ledger-mutation") {
        this.inboundEffects.push(`effect:hidden:${update.updateId}`);
      }
      this.recordInvalidFailure("SCOPE_NOT_VISIBLE");
      return { ok: false, reason: "SCOPE_NOT_VISIBLE" };
    }
    if (this.fault === "reject-all-inbound") return { ok: false, reason: "REJECT_ALL" };
    const existing = this.inbound.get(update.updateId);
    if (existing !== undefined) {
      if (
        this.fault === "tg04-first-healed-by-duplicate" &&
        update.updateId.includes("tg04-same") &&
        existing.dispatch !== null
      ) {
        existing.dispatch = {
          ...existing.dispatch,
          residentId: binding.residentId,
          scopeId: binding.scopeId,
          scopeGeneration: scope.scopeGeneration,
          windowId: scope.windowId,
          windowGeneration: scope.windowGeneration,
        };
      }
      if (this.fault === "duplicate-extra-effect" || this.fault === "live-effect-ledger-mutation") {
        this.inboundEffects.push("effect:duplicate-extra");
      }
      const duplicate: InboundReceipt = { ...existing, status: "duplicate" };
      if (this.fault === "duplicate-replayed-dispatch" && duplicate.dispatch !== null) {
        duplicate.dispatch = {
          ...duplicate.dispatch,
          residentId: "resident:replayed",
          scopeId: "scope:replayed",
        };
      }
      return { ok: true, value: duplicate };
    }
    const dispatchId = `dispatch:${update.updateId}`;
    if (
      (this.fault === "live-resident-mutation-tg02" && update.updateId.includes("tg02-valid")) ||
      (this.fault === "live-resident-mutation-tg04" && update.updateId.includes("tg04-"))
    ) {
      this.resident(binding.residentId).residentId = "resident:shadow";
    }
    const mutateResident =
      (this.fault === "live-resident-mutation-tg02" && update.updateId.includes("tg02-valid")) ||
      (this.fault === "live-resident-mutation-tg04" && update.updateId.includes("tg04-"));
    const wrongUnordered =
      this.fault === "unordered-wrong-identity" &&
      (update.updateId.includes("tg04-200") || update.updateId.includes("tg04-100"));
    const wrongFirst =
      this.fault === "tg04-first-wrong-identity" && update.updateId.includes("tg04-same");
    const bindMutatedTg03 =
      this.fault === "bind-mutates-tg03-oracles" && update.updateId.includes("tg03");
    const dispatch: DispatchIdentity = {
      residentId:
        this.fault === "wrong-dispatch-identity" || wrongFirst
          ? "resident:wrong"
          : bindMutatedTg03
            ? this.resident(binding.residentId).residentId
            : this.fault === "seen-sender-used-as-resident" &&
                update.updateId.includes("tg01-non-address")
              ? `resident:${update.senderId}`
              : mutateResident
                ? "resident:shadow"
                : binding.residentId,
      scopeId:
        this.fault === "wrong-dispatch-identity" || wrongUnordered || wrongFirst
          ? "scope:wrong"
          : bindMutatedTg03
            ? scope.scopeId
            : binding.scopeId,
      scopeGeneration: wrongUnordered ? 99 : scope.scopeGeneration,
      windowId: wrongUnordered ? "window:wrong" : scope.windowId,
      windowGeneration: wrongUnordered ? 99 : scope.windowGeneration,
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
    if (
      this.fault === "tg03-dispatch-healed-by-host-read" &&
      update.updateId.includes("tg03") &&
      receipt.dispatch !== null
    ) {
      receipt.dispatch.residentId = "resident:temporary-wrong";
      receipt.dispatch.scopeId = "scope:temporary-wrong";
      receipt.dispatch.scopeGeneration = 77;
      receipt.dispatch.windowId = "window:temporary-wrong";
      receipt.dispatch.windowGeneration = 77;
      this.tg03InboundView = receipt;
      return { ok: true, value: receipt };
    }
    if (
      this.fault === "tg04-first-healed-by-duplicate" &&
      update.updateId.includes("tg04-same") &&
      receipt.dispatch !== null
    ) {
      receipt.dispatch.residentId = "resident:temporary-wrong";
      receipt.dispatch.scopeId = "scope:temporary-wrong";
      return { ok: true, value: receipt };
    }
    if (
      this.fault === "tg04-newer-healed-by-older" &&
      update.updateId.includes("tg04-200") &&
      receipt.dispatch !== null
    ) {
      receipt.dispatch.scopeId = "scope:temporary-wrong";
      receipt.dispatch.scopeGeneration = 99;
      receipt.dispatch.windowId = "window:temporary-wrong";
      receipt.dispatch.windowGeneration = 99;
      this.tg04NewerView = receipt;
      return { ok: true, value: receipt };
    }
    if (
      this.fault === "tg04-effect-ids-healed-by-ledger-read" &&
      update.updateId.includes("tg04")
    ) {
      receipt.effectId = `effect:lie:${update.updateId}`;
      return { ok: true, value: receipt };
    }
    if (
      this.fault === "tg07-inbound-leak-healed-by-send" &&
      update.updateId.includes("tg07-context")
    ) {
      receipt.reason = this.tokenSecret;
      this.tg07InboundView = receipt;
      return { ok: true, value: receipt };
    }
    return { ok: true, value: structuredClone(receipt) };
  }

  async readInboundEffects(): Promise<string[]> {
    if (this.fault === "tg04-effect-ids-healed-by-ledger-read") {
      for (const receipt of this.inbound.values()) {
        const effectId = this.inboundEffects.find((candidate) =>
          candidate.includes(receipt.updateId),
        );
        if (effectId !== undefined) receipt.effectId = effectId;
      }
    }
    if (this.fault === "tg07-durable-leak-healed-by-effect-read" && this.tg07DurableView !== null) {
      this.tg07DurableView.reason = null;
      this.tg07DurableView.telegramMessageId = "telegram:1";
      this.tg07DurableView.effectId = "outbound-effect:1";
    }
    if (this.fault === "tg07-inbound-effects-leak-healed-by-boundary") {
      this.inboundEffects.push(this.tokenSecret);
      return this.inboundEffects;
    }
    if (
      this.fault === "tg08-inbound-baseline-healed-by-outbound-read" &&
      !this.tg08BaselineInjected
    ) {
      this.tg08BaselineInjected = true;
      this.inboundEffects.push("effect:temporary-baseline-drift");
      return this.inboundEffects;
    }
    return this.fault === "live-effect-ledger-mutation"
      ? this.inboundEffects
      : [...this.inboundEffects];
  }

  async readHostDispatch(): Promise<HostDispatchSnapshot> {
    if (
      this.fault === "tg03-dispatch-healed-by-host-read" &&
      this.tg03InboundView?.dispatch !== null &&
      this.tg03InboundView !== null &&
      this.lastDispatch !== null
    ) {
      this.tg03InboundView.dispatch = { ...this.lastDispatch };
    }
    const snapshot: HostDispatchSnapshot = {
      hostProviderDispatches: this.hostDispatches,
      channelOwnedHosts: 0,
      lastDispatch: this.lastDispatch === null ? null : { ...this.lastDispatch },
    };
    if (this.fault !== "live-host-dispatch-snapshot") return snapshot;
    if (this.hostDispatchView === null) this.hostDispatchView = snapshot;
    else Object.assign(this.hostDispatchView, snapshot);
    return this.hostDispatchView;
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
    if (this.fault === "tg07-inbound-leak-healed-by-send" && this.tg07InboundView !== null) {
      this.tg07InboundView.reason = null;
    }
    const binding = this.bindings.get(request.context.bindingId);
    if (binding === undefined || !binding.active) {
      if (this.fault === "token-resolves-after-revoke") this.tokenResolved += 1;
      if (
        this.fault === "revoked-requests-write-effects" ||
        this.fault === "live-effect-ledger-mutation"
      ) {
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
      if (
        this.fault === "revoked-requests-write-effects" ||
        this.fault === "live-effect-ledger-mutation"
      ) {
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
    if (
      this.fault === "live-token-receipt-cleared-before-scan" &&
      request.context.dispatchId.includes("tg07-context")
    ) {
      receipt.reason = this.tokenSecret;
    }
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
    if (this.fault === "unknown-durable-message-id" && scenario === "telegram-unavailable") {
      stored.telegramMessageId = "telegram:secretly-delivered";
    }
    const liveReceipt =
      this.fault === "live-receipt-message-mutation" ||
      (this.fault === "visible-receipt-mutates-before-clone" && scenario === "visible") ||
      (this.fault === "live-token-receipt-cleared-before-scan" &&
        request.context.dispatchId.includes("tg07-context")) ||
      (this.fault === "unknown-binding-mutates-before-clone" && status === "unknown") ||
      (this.fault === "live-unavailable-receipt-mutation" && scenario === "telegram-unavailable");
    const durable = liveReceipt ? receipt : stored;
    this.outbound.set(receipt.outboundId, durable);
    if (!(this.fault === "unknown-wrong-target" && status === "unknown")) {
      this.outboundEffects.push(effectId);
    }
    return {
      ok: true,
      value: liveReceipt ? durable : structuredClone(receipt),
    };
  }

  async readOutbound(outboundId: string): Promise<Result<OutboundReceipt>> {
    const receipt = this.outbound.get(outboundId);
    if (
      receipt !== undefined &&
      this.fault === "tg07-durable-leak-healed-by-effect-read" &&
      receipt.outboundId === "outbound:1"
    ) {
      receipt.reason = this.tokenSecret;
      receipt.telegramMessageId = this.tokenSecret;
      receipt.effectId = this.tokenSecret;
      this.tg07DurableView = receipt;
      return { ok: true, value: receipt };
    }
    if (receipt !== undefined && this.fault === "live-token-receipt-cleared-before-scan") {
      receipt.reason = null;
    }
    if (
      receipt !== undefined &&
      this.fault === "live-receipt-message-mutation" &&
      receipt.status === "visible"
    ) {
      receipt.telegramMessageId = "telegram:swapped-after-read";
    }
    if (
      receipt !== undefined &&
      this.fault === "live-unavailable-receipt-mutation" &&
      receipt.status === "unknown"
    ) {
      receipt.effectId = "outbound-effect:swapped-after-read";
    }
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
      : {
          ok: true,
          value:
            this.fault === "live-receipt-message-mutation" ||
            this.fault === "live-unavailable-receipt-mutation"
              ? receipt
              : structuredClone(receipt),
        };
  }

  async readOutboundEffects(): Promise<string[]> {
    if (this.fault === "tg08-inbound-baseline-healed-by-outbound-read") {
      const temporary = this.inboundEffects.indexOf("effect:temporary-baseline-drift");
      if (temporary !== -1) this.inboundEffects.splice(temporary, 1);
    }
    if (this.fault === "unknown-binding-mutates-before-clone") {
      for (const receipt of this.outbound.values()) {
        if (receipt.status === "unknown") receipt.bindingId = "binding:moved";
      }
    }
    if (this.fault === "tg07-outbound-effects-leak-healed-by-boundary") {
      this.outboundEffects.push(this.tokenSecret);
      return this.outboundEffects;
    }
    return this.fault === "live-effect-ledger-mutation"
      ? this.outboundEffects
      : [...this.outboundEffects];
  }

  async createTokenReference(secretCanary: string): Promise<TokenReference> {
    this.tokenSecret = secretCanary;
    this.tokenRef = "credential:opaque-telegram";
    const reference = { credentialRef: this.tokenRef };
    if (this.fault === "token-ref-healed-by-boundary") this.tokenReferenceView = reference;
    return reference;
  }

  async attachToken(credentialRef: string): Promise<void> {
    this.tokenRef = credentialRef;
    this.tokenAttached = true;
  }

  async inspectTokenBoundary(): Promise<TokenBoundarySnapshot> {
    if (this.fault === "token-ref-healed-by-boundary" && this.tokenReferenceView !== null) {
      this.tokenReferenceView.credentialRef = "credential:foreign-not-attached";
    }
    if (this.fault === "tg07-inbound-effects-leak-healed-by-boundary") {
      const secret = this.inboundEffects.indexOf(this.tokenSecret);
      if (secret !== -1) this.inboundEffects.splice(secret, 1);
    }
    if (this.fault === "tg07-outbound-effects-leak-healed-by-boundary") {
      const secret = this.outboundEffects.indexOf(this.tokenSecret);
      if (secret !== -1) this.outboundEffects.splice(secret, 1);
    }
    this.boundaryInspectCount += 1;
    const snapshot: TokenBoundarySnapshot = {
      credentialRef:
        this.fault === "token-ref-healed-by-boundary"
          ? "credential:foreign-not-attached"
          : this.tokenRef,
      credentialStatus:
        this.fault === "final-token-boundary-rewinds" && this.boundaryInspectCount === 4
          ? "attached"
          : this.tokenRevoked
            ? "revoked"
            : this.tokenAttached
              ? "attached"
              : "detached",
      credentialGeneration:
        this.fault === "final-token-boundary-rewinds" && this.boundaryInspectCount === 4
          ? this.credentialGeneration - 1
          : this.credentialGeneration,
      resolvedCount:
        this.fault === "middle-token-count-drift" && this.boundaryInspectCount === 3
          ? this.tokenResolved + 5
          : this.tokenResolved,
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
    if (this.fault !== "live-token-boundary-snapshot") return snapshot;
    if (this.tokenBoundaryView === null) {
      snapshot.logs = [this.tokenSecret];
      this.tokenBoundaryView = snapshot;
    } else {
      this.tokenBoundaryView.credentialRef = snapshot.credentialRef;
      this.tokenBoundaryView.credentialStatus = snapshot.credentialStatus;
      this.tokenBoundaryView.credentialGeneration = snapshot.credentialGeneration;
      this.tokenBoundaryView.resolvedCount = snapshot.resolvedCount;
      this.tokenBoundaryView.config.splice(0, this.tokenBoundaryView.config.length);
      this.tokenBoundaryView.logs.splice(0, this.tokenBoundaryView.logs.length);
      this.tokenBoundaryView.receipts.splice(0, this.tokenBoundaryView.receipts.length);
      this.tokenBoundaryView.errors.splice(0, this.tokenBoundaryView.errors.length);
    }
    return this.tokenBoundaryView;
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
    this.beginCount += 1;
    const scope = this.scope(binding.scopeId);
    if (this.fault === "scope-readback-healed-by-next-begin" && this.beginCount === 3) {
      scope.scopeGeneration = 99;
      if (this.scopeReadbackView !== null) this.scopeReadbackView.scopeGeneration = 99;
    }
    const operation: InFlightChannelOperation = {
      operationId: `operation:${direction}`,
      direction,
      bindingId,
      bindingVersion: binding.bindingVersion,
      scopeGeneration:
        this.fault === "coupled-generation-return-only" && this.returnedScopeGeneration !== null
          ? this.returnedScopeGeneration
          : scope.scopeGeneration,
      credentialGeneration: this.credentialGeneration,
    };
    if (this.fault === "current-operation-healed-by-complete" && this.beginCount === 1) {
      operation.scopeGeneration = 99;
    }
    if (this.fault === "inflight-underreports-noop-advance" && this.beginCount === 2) {
      operation.scopeGeneration = 0;
    }
    if (this.fault === "credential-generation-healed-by-complete") {
      operation.credentialGeneration += 1;
    }
    return {
      ok: true,
      value: operation,
    };
  }

  async completeInFlightChannelOperation(
    operation: InFlightChannelOperation,
  ): Promise<Result<InboundReceipt | OutboundReceipt>> {
    const binding = this.binding(operation.bindingId);
    if (this.fault === "current-operation-healed-by-complete" && operation.scopeGeneration === 99) {
      operation.scopeGeneration = this.scope(binding.scopeId).scopeGeneration;
    }
    if (this.fault === "credential-generation-healed-by-complete") {
      operation.credentialGeneration -= 1;
    }
    if (this.fault === "current-completion-rejected") {
      return { ok: false, reason: "STALE_SCOPE_GENERATION" };
    }
    const bindingAuthorityInvalid =
      !binding.active || operation.bindingVersion !== binding.bindingVersion;
    const credentialInvalid = operation.credentialGeneration !== this.credentialGeneration;
    if (
      bindingAuthorityInvalid ||
      (credentialInvalid && this.fault !== "token-only-inflight-allowed")
    ) {
      if (this.fault === "token-resolves-after-revoke") this.tokenResolved += 1;
      if (
        this.fault === "revoked-requests-write-effects" ||
        this.fault === "live-effect-ledger-mutation"
      ) {
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
    if (
      operation.scopeGeneration !== scope.scopeGeneration &&
      this.fault !== "coupled-generation-return-only"
    ) {
      if (this.fault === "live-effect-ledger-mutation") {
        this.inboundEffects.push(`effect:stale:${operation.operationId}`);
      }
      if (this.fault === "live-host-dispatch-snapshot") {
        this.hostDispatches += 1;
        this.lastDispatch = {
          residentId: binding.residentId,
          scopeId: binding.scopeId,
          scopeGeneration: scope.scopeGeneration,
          windowId: scope.windowId,
          windowGeneration: scope.windowGeneration,
          dispatchId: `dispatch:stale:${operation.operationId}`,
          sourceMessageId: `message:stale:${operation.operationId}`,
        };
      }
      this.recordInvalidFailure("STALE_SCOPE_GENERATION");
      return { ok: false, reason: "STALE_SCOPE_GENERATION" };
    }
    if (this.fault === "null-current-dispatch" && operation.scopeGeneration > 1) {
      return {
        ok: true,
        value: {
          updateId: `update:${operation.operationId}`,
          status: "dispatched",
          reason: null,
          dispatch: null,
          effectId: null,
        },
      };
    }
    const dispatch: DispatchIdentity = {
      residentId: binding.residentId,
      scopeId: binding.scopeId,
      scopeGeneration:
        this.fault === "wrong-completion-generation" && operation.scopeGeneration > 1
          ? operation.scopeGeneration - 1
          : scope.scopeGeneration,
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
    if (this.fault === "observability-mutates-live-binding") {
      this.binding(bindingId).bindingVersion = 99;
    }
    return {
      adapterVersion:
        this.fault === "observability-drifts-when-unavailable" && !this.telegramAvailable
          ? "2.0.0"
          : "1.0.0",
      botApiVersion:
        this.fault === "observability-drifts-when-unavailable" && !this.telegramAvailable
          ? "0.0"
          : "10.1",
      capabilities:
        this.fault === "observability-drifts-when-unavailable" && !this.telegramAvailable
          ? []
          : ["inbound", "outbound"],
      bindingVersion:
        this.fault === "observability-drifts-when-unavailable" && !this.telegramAvailable
          ? 99
          : this.binding(bindingId).bindingVersion,
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
    if (this.fault === "canonical-drift-after-recovery" && this.restartCount === 2) {
      const resident = this.residents.values().next().value as ResidentFixture | undefined;
      if (resident !== undefined) resident.canonicalStateHash = "hash:drifted-after-recovery";
    }
    if (this.fault === "canonical-fields-drift-after-recovery" && this.restartCount === 2) {
      const resident = this.residents.values().next().value as ResidentFixture | undefined;
      if (resident !== undefined) {
        resident.model = "model:drifted-after-recovery";
        resident.provider = "provider:drifted-after-recovery";
        resident.runtimeSessionId = "session:drifted-after-recovery";
      }
    }
    if (
      (this.fault === "replay-inbound-on-recovery" ||
        this.fault === "live-effect-ledger-mutation") &&
      this.restartCount === 2
    ) {
      this.inboundEffects.push("effect:replayed-on-recovery");
    }
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
    if (this.fault === "live-resident-census-array" && this.residentCensusView !== null) {
      const liveResident = this.residentCensusView.find(
        (candidate) => candidate.residentId === residentId,
      );
      if (liveResident !== undefined) Object.assign(liveResident, cloneResident(resident));
      this.residentCensusView.push({
        ...cloneResident(resident),
        residentId: "resident:late-shadow",
      });
    }
    if (this.fault === "shadow-resident-on-switch") {
      this.residents.set("resident:shadow", {
        ...resident,
        residentId: "resident:shadow",
      });
    }
    const returned = cloneResident(resident);
    if (this.fault === "switch-return-stale-model") {
      returned.model = "model:old";
      returned.provider = "provider:old";
    }
    if (this.fault === "gd02-switch-healed-by-binding-read") {
      this.switchedTruth = cloneResident(returned);
      this.switchedView = returned;
      returned.model = "model:old";
      returned.provider = "provider:old";
      return returned;
    }
    return returned;
  }

  async listResidents(): Promise<ResidentFixture[]> {
    if (
      this.fault === "gd02-binding-healed-by-resident-list" &&
      this.bindingView !== null &&
      this.bindingTruth !== null
    ) {
      Object.assign(this.bindingView, cloneBinding(this.bindingTruth));
    }
    if (this.fault === "live-resident-census-array" && this.residentCensusView !== null) {
      return this.residentCensusView;
    }
    const census = [...this.residents.values()].map((resident) => {
      const value = cloneResident(resident);
      if (this.fault === "census-state-drift" && !value.residentId.includes("shadow")) {
        value.canonicalStateHash = "hash:mutated-in-census";
        value.runtimeSessionId = "session:stale";
      }
      return value;
    });
    if (this.fault === "live-resident-census-array") this.residentCensusView = census;
    return census;
  }

  async setContinuityVotes(residentId: string, votes: ContinuityVotes): Promise<void> {
    this.votes.set(residentId, structuredClone(votes));
  }

  async activateContinuity(residentId: string): Promise<ContinuityActivation> {
    const votes = this.votes.get(residentId);
    const activated =
      votes?.machine === "passed" &&
      (votes.resident === "accepted" ||
        (this.fault === "rejected-continuity-vote-activates" && votes.resident !== "missing")) &&
      votes.relationships.every(
        (vote) =>
          vote === "accepted" ||
          (this.fault === "rejected-continuity-vote-activates" && vote !== "not-asked"),
      );
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
    const result: ContinuityActivation = {
      residentId,
      activated,
      reason: activated ? null : "MISSING_VOTE",
    };
    if (this.fault === "gd03-activation-healed-by-canonical-read") {
      result.residentId = "resident:temporary-shadow";
      this.activationView = result;
    }
    return result;
  }

  async createGroupFixture(input: {
    address: TelegramAddress;
    members: Array<{ residentId: string; scopeId: string }>;
  }): Promise<GroupFixture> {
    if (this.fault === "gd01-second-scope-mutates-first") {
      const first = input.members[0];
      if (first !== undefined) first.scopeId = this.scope("scope:gd01-a").scopeId;
    }
    if (this.fault === "gd04-later-scope-mutates-first") {
      const first = input.members[0];
      if (first !== undefined) first.scopeId = this.scope("scope:gd04-0").scopeId;
    }
    if (this.fault === "group-create-mutates-member-oracles") {
      for (const [index, member] of input.members.entries()) {
        const resident = this.resident(member.residentId);
        const scope = this.scope(member.scopeId);
        resident.residentId = `${member.residentId}:renamed:${index}`;
        scope.residentId = resident.residentId;
        scope.scopeId = `${member.scopeId}:renamed:${index}`;
        member.residentId = resident.residentId;
        member.scopeId = scope.scopeId;
      }
    }
    const gd04Residents = [...this.residents.values()].filter((resident) =>
      resident.residentId.includes("gd04-"),
    );
    const group: GroupFixture = {
      groupId: `group:${this.groups.size + 1}`,
      address: { ...input.address },
      members: input.members.map((member, index) => {
        if (this.fault === "gd04-last-scope-swaps-residents") {
          const resident = gd04Residents[index];
          if (resident !== undefined) {
            return {
              ...member,
              residentId: resident.residentId,
              model: resident.model,
              provider: resident.provider,
            };
          }
        }
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
    if (this.fault === "gd04-live-resident-swap" && plans.length === 3) {
      const first = this.residents.get(plans[0]?.residentId ?? "");
      const last = this.residents.get(plans[2]?.residentId ?? "");
      if (first !== undefined && last !== undefined) {
        const firstId = first.residentId;
        first.residentId = last.residentId;
        last.residentId = firstId;
      }
    }
    const hostDispatches: DispatchIdentity[] = [];
    const trace: GroupTraceEntry[] = plans.map((plan, index) => {
      const residentId =
        this.fault === "swap-group-residents"
          ? (plans[plans.length - 1 - index]?.residentId ?? plan.residentId)
          : plan.residentId;
      const storedResident = this.resident(residentId);
      const reportedResidentId =
        this.fault === "group-shadow-residents"
          ? `resident:shadow:${index}`
          : this.fault === "wrong-group-speaker-after-switch" && plans.length === 1
            ? "resident:other"
            : this.fault === "gd04-live-resident-swap"
              ? storedResident.residentId
              : residentId;
      const resident = storedResident;
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
    if (this.fault === "gd01-trace-healed-by-host-read" && plans.length === 2) {
      this.groupTraceTruth = structuredClone(trace);
      this.groupTraceView = trace;
      for (const entry of trace) {
        entry.model = "model:shared";
        entry.provider = "provider:shared";
      }
      return trace;
    }
    return trace;
  }

  async readGroupDispatches(groupId: string): Promise<DispatchIdentity[]> {
    if (
      this.fault === "gd01-trace-healed-by-host-read" &&
      this.groupTraceView !== null &&
      this.groupTraceTruth !== null
    ) {
      this.groupTraceView.splice(
        0,
        this.groupTraceView.length,
        ...structuredClone(this.groupTraceTruth),
      );
    }
    return structuredClone(this.groupDispatches.get(groupId) ?? []);
  }

  async readCanonicalState(residentId: string): Promise<ResidentFixture> {
    if (this.fault === "gd03-activation-healed-by-canonical-read" && this.activationView !== null) {
      this.activationView.residentId = residentId;
    }
    if (
      this.fault === "gd05-binding-healed-by-canonical-read" &&
      this.bindingView !== null &&
      this.bindingTruth !== null
    ) {
      Object.assign(this.bindingView, cloneBinding(this.bindingTruth));
    }
    const resident = this.residents.get(residentId);
    if (resident === undefined) {
      const mutated = [...this.residents.values()][0];
      if (mutated !== undefined) return cloneResident(mutated);
      throw new Error("RESIDENT_NOT_FOUND");
    }
    return cloneResident(resident);
  }

  private recordInvalidFailure(reason: string): void {
    if (this.fault !== "invalid-failures-write-dispatch") return;
    this.inboundEffects.push(`effect:guessed:${reason}`);
    this.hostDispatches += 1;
    this.lastDispatch = {
      residentId: "resident:default",
      scopeId: "scope:default",
      scopeGeneration: 1,
      windowId: "window:default",
      windowGeneration: 1,
      dispatchId: `dispatch:guessed:${reason}`,
      sourceMessageId: `message:guessed:${reason}`,
    };
  }

  private resident(residentId: string): ResidentFixture {
    const resident =
      this.residents.get(residentId) ??
      [...this.residents.values()].find((candidate) => candidate.residentId === residentId);
    if (resident === undefined) throw new Error("RESIDENT_NOT_FOUND");
    return resident;
  }

  private scope(scopeId: string): ScopeFixture {
    const scope =
      this.scopes.get(scopeId) ??
      [...this.scopes.values()].find((candidate) => candidate.scopeId === scopeId);
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
  { checkId: "TG-01", fault: "resolve-mutates-tg01-oracles" },
  { checkId: "TG-01", fault: "tg01-scope-rewrites-resident" },
  { checkId: "TG-01", fault: "root-binding-healed-by-topic-bind" },
  { checkId: "TG-02", fault: "reject-all-inbound" },
  { checkId: "TG-02", fault: "current-completion-rejected" },
  { checkId: "TG-02", fault: "scope-generation-noop" },
  { checkId: "TG-02", fault: "scope-generation-return-only" },
  { checkId: "TG-02", fault: "coupled-generation-return-only" },
  { checkId: "TG-02", fault: "wrong-completion-generation" },
  { checkId: "TG-02", fault: "invalid-failures-write-dispatch" },
  { checkId: "TG-02", fault: "live-resident-mutation-tg02" },
  { checkId: "TG-02", fault: "bind-renames-ready-oracles" },
  { checkId: "TG-02", fault: "ready-binding-healed-by-later-call" },
  { checkId: "TG-02", fault: "live-host-dispatch-snapshot" },
  { checkId: "TG-02", fault: "live-effect-ledger-mutation" },
  { checkId: "TG-02", fault: "current-operation-healed-by-complete" },
  { checkId: "TG-02", fault: "inflight-underreports-noop-advance" },
  { checkId: "TG-02", fault: "scope-readback-healed-by-next-begin" },
  { checkId: "TG-03", fault: "wrong-dispatch-identity" },
  { checkId: "TG-03", fault: "live-scope-mutation" },
  { checkId: "TG-03", fault: "bind-mutates-tg03-oracles" },
  { checkId: "TG-03", fault: "tg03-dispatch-healed-by-host-read" },
  { checkId: "TG-04", fault: "duplicate-extra-effect" },
  { checkId: "TG-04", fault: "current-completion-rejected" },
  { checkId: "TG-04", fault: "scope-generation-return-only" },
  { checkId: "TG-04", fault: "coupled-generation-return-only" },
  { checkId: "TG-04", fault: "wrong-completion-generation" },
  { checkId: "TG-04", fault: "null-current-dispatch" },
  { checkId: "TG-04", fault: "unordered-wrong-identity" },
  { checkId: "TG-04", fault: "live-resident-mutation-tg04" },
  { checkId: "TG-04", fault: "bind-renames-ready-oracles" },
  { checkId: "TG-04", fault: "tg04-first-wrong-identity" },
  { checkId: "TG-04", fault: "duplicate-replayed-dispatch" },
  { checkId: "TG-04", fault: "live-effect-ledger-mutation" },
  { checkId: "TG-04", fault: "tg04-first-healed-by-duplicate" },
  { checkId: "TG-04", fault: "tg04-newer-healed-by-older" },
  { checkId: "TG-04", fault: "tg04-effect-ids-healed-by-ledger-read" },
  { checkId: "TG-04", fault: "current-operation-healed-by-complete" },
  { checkId: "TG-04", fault: "inflight-underreports-noop-advance" },
  { checkId: "TG-04", fault: "scope-readback-healed-by-next-begin" },
  { checkId: "TG-05", fault: "submitted-looks-visible" },
  { checkId: "TG-05", fault: "unknown-has-message-id" },
  { checkId: "TG-05", fault: "durable-status-promoted" },
  { checkId: "TG-05", fault: "durable-binding-moved" },
  { checkId: "TG-05", fault: "live-address-mutation" },
  { checkId: "TG-05", fault: "live-receipt-message-mutation" },
  { checkId: "TG-05", fault: "visible-receipt-mutates-before-clone" },
  { checkId: "TG-06", fault: "target-hints-win" },
  { checkId: "TG-06", fault: "durable-target-hints-win" },
  { checkId: "TG-06", fault: "live-address-mutation" },
  { checkId: "TG-07", fault: "token-leaks-in-receipt" },
  { checkId: "TG-07", fault: "token-leaks-in-fixture" },
  { checkId: "TG-07", fault: "token-leaks-in-durable-receipt" },
  { checkId: "TG-07", fault: "token-leaks-in-inbound-effect" },
  { checkId: "TG-07", fault: "live-token-receipt-cleared-before-scan" },
  { checkId: "TG-07", fault: "tg07-inbound-leak-healed-by-send" },
  { checkId: "TG-07", fault: "tg07-durable-leak-healed-by-effect-read" },
  { checkId: "TG-07", fault: "tg07-inbound-effects-leak-healed-by-boundary" },
  { checkId: "TG-07", fault: "tg07-outbound-effects-leak-healed-by-boundary" },
  { checkId: "TG-07", fault: "token-ref-healed-by-boundary" },
  { checkId: "TG-08", fault: "token-resolves-after-revoke" },
  { checkId: "TG-08", fault: "hidden-token-resolve-log" },
  { checkId: "TG-08", fault: "token-leaks-early-snapshot" },
  { checkId: "TG-08", fault: "revoked-requests-write-effects" },
  { checkId: "TG-08", fault: "revoke-token-noop" },
  { checkId: "TG-08", fault: "unstable-revoke-reason" },
  { checkId: "TG-08", fault: "token-only-inbound-allowed" },
  { checkId: "TG-08", fault: "token-only-inflight-allowed" },
  { checkId: "TG-08", fault: "middle-token-count-drift" },
  { checkId: "TG-08", fault: "live-token-boundary-snapshot" },
  { checkId: "TG-08", fault: "final-token-boundary-rewinds" },
  { checkId: "TG-08", fault: "live-effect-ledger-mutation" },
  { checkId: "TG-08", fault: "tg08-inbound-baseline-healed-by-outbound-read" },
  { checkId: "TG-08", fault: "credential-generation-healed-by-complete" },
  { checkId: "TG-09", fault: "send-fails-observability-fresh" },
  { checkId: "TG-09", fault: "unavailable-send-still-visible" },
  { checkId: "TG-09", fault: "unavailable-durable-visible" },
  { checkId: "TG-09", fault: "live-unavailable-receipt-mutation" },
  { checkId: "TG-09", fault: "live-receipt-message-mutation" },
  { checkId: "TG-09", fault: "observability-mutates-live-binding" },
  { checkId: "TG-09", fault: "observability-drifts-when-unavailable" },
  { checkId: "GD-01", fault: "wrong-group-address" },
  { checkId: "GD-01", fault: "group-shadow-residents" },
  { checkId: "GD-01", fault: "group-wrong-scope" },
  { checkId: "GD-01", fault: "group-unissued-dispatch" },
  { checkId: "GD-01", fault: "group-fixture-shadow-members" },
  { checkId: "GD-01", fault: "group-shared-runtime" },
  { checkId: "GD-01", fault: "live-address-mutation" },
  { checkId: "GD-01", fault: "gd01-scope-mutates-models" },
  { checkId: "GD-01", fault: "gd01-second-scope-mutates-first" },
  { checkId: "GD-01", fault: "gd01-trace-healed-by-host-read" },
  { checkId: "GD-02", fault: "shadow-resident-on-switch" },
  { checkId: "GD-02", fault: "census-state-drift" },
  { checkId: "GD-02", fault: "binding-drift-on-switch" },
  { checkId: "GD-02", fault: "bind-renames-ready-oracles" },
  { checkId: "GD-02", fault: "live-resident-census-array" },
  { checkId: "GD-02", fault: "switch-return-stale-model" },
  { checkId: "GD-02", fault: "wrong-group-speaker-after-switch" },
  { checkId: "GD-02", fault: "gd02-switch-healed-by-binding-read" },
  { checkId: "GD-02", fault: "gd02-binding-healed-by-resident-list" },
  { checkId: "GD-03", fault: "mutate-resident-on-blocked-activation" },
  { checkId: "GD-03", fault: "live-resident-mutation-on-blocked" },
  { checkId: "GD-03", fault: "gd03-activation-healed-by-canonical-read" },
  { checkId: "GD-03", fault: "rejected-continuity-vote-activates" },
  { checkId: "GD-04", fault: "swap-group-residents" },
  { checkId: "GD-04", fault: "live-group-mutation" },
  { checkId: "GD-04", fault: "gd04-live-resident-swap" },
  { checkId: "GD-04", fault: "group-create-mutates-member-oracles" },
  { checkId: "GD-04", fault: "gd04-scope-create-swaps-residents" },
  { checkId: "GD-04", fault: "gd04-last-scope-swaps-residents" },
  { checkId: "GD-04", fault: "gd04-later-resident-mutates-first" },
  { checkId: "GD-04", fault: "gd04-later-scope-mutates-first" },
  { checkId: "GD-05", fault: "unknown-wrong-target" },
  { checkId: "GD-05", fault: "live-address-mutation" },
  { checkId: "GD-05", fault: "bind-renames-ready-oracles" },
  { checkId: "GD-05", fault: "binding-drift-after-restart" },
  { checkId: "GD-05", fault: "duplicate-extra-effect" },
  { checkId: "GD-05", fault: "unknown-durable-message-id" },
  { checkId: "GD-05", fault: "replay-inbound-on-recovery" },
  { checkId: "GD-05", fault: "canonical-drift-after-recovery" },
  { checkId: "GD-05", fault: "canonical-fields-drift-after-recovery" },
  { checkId: "GD-05", fault: "unknown-binding-mutates-before-clone" },
  { checkId: "GD-05", fault: "live-effect-ledger-mutation" },
  { checkId: "GD-05", fault: "gd05-binding-healed-by-canonical-read" },
];

describe("D26 Telegram channel adversarial acceptance", () => {
  it.each(adversarialCases)("$checkId rejects $fault", async ({ checkId, fault }) => {
    const check = telegramChannelChecks.find(({ id }) => id === checkId);
    if (check === undefined) throw new Error(`missing check ${checkId}`);

    const baseline = await check.run(
      cloneTelegramChannelDriverBoundary(new AdversarialTelegramDriver(null)),
    );
    expect(baseline, `${checkId} synthetic positive control`).toMatchObject({ passed: true });

    const attacked = await check.run(
      cloneTelegramChannelDriverBoundary(new AdversarialTelegramDriver(fault)),
    );
    expect(attacked, `${checkId} accepted adversarial fault ${fault}`).toMatchObject({
      passed: false,
    });
  });
});
