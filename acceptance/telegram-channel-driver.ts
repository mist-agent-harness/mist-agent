/** #185 / D26 的 Telegram 信道验收驱动契约。 */

export type Result<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface TelegramAddress {
  chatId: string;
  topicId: string | null;
}

export interface ResidentFixture {
  residentId: string;
  model: string;
  provider: string;
  canonicalStateHash: string;
}

export interface ScopeFixture {
  residentId: string;
  scopeId: string;
  scopeGeneration: number;
  windowId: string;
  windowGeneration: number;
  visible: boolean;
}

export interface ChannelBinding {
  bindingId: string;
  address: TelegramAddress;
  residentId: string;
  scopeId: string;
  bindingVersion: number;
  active: boolean;
}

export interface TelegramUpdate {
  updateId: string;
  messageId: string;
  address: TelegramAddress;
  senderId: string;
  payload: string;
}

export interface DispatchIdentity {
  residentId: string;
  scopeId: string;
  scopeGeneration: number;
  windowId: string;
  windowGeneration: number;
  dispatchId: string;
}

export interface InboundReceipt {
  updateId: string;
  status: "dispatched" | "queued" | "duplicate" | "rejected";
  reason: string | null;
  dispatch: DispatchIdentity | null;
  effectId: string | null;
}

export interface DispatchContext extends DispatchIdentity {
  bindingId: string;
}

export interface OutboundRequest {
  context: DispatchContext;
  body: string;
  /** 负例输入；插件不得把模型建议当成发送授权。 */
  modelTargetHint: TelegramAddress | null;
}

export interface OutboundReceipt {
  outboundId: string;
  status: "generated" | "submitted" | "accepted" | "visible" | "unknown" | "rejected";
  reason: string | null;
  target: TelegramAddress;
  bindingId: string;
  telegramMessageId: string | null;
  effectId: string | null;
}

export interface TokenReference {
  credentialRef: string;
  secretCanary: string;
}

export interface TokenBoundarySnapshot {
  credentialRef: string;
  resolvedCount: number;
  config: string[];
  logs: string[];
  receipts: string[];
  errors: string[];
}

export interface ChannelObservability {
  adapterVersion: string;
  botApiVersion: string;
  capabilities: string[];
  bindingVersion: number;
  lastInbound: { status: "fresh" | "unavailable"; observedAt: string | null };
  lastOutbound: { status: "fresh" | "unavailable"; observedAt: string | null };
}

export interface InFlightChannelOperation {
  operationId: string;
  direction: "inbound" | "outbound";
  bindingId: string;
  bindingVersion: number;
  credentialGeneration: number;
}

export interface HostDispatchSnapshot {
  hostProviderDispatches: number;
  channelOwnedHosts: number;
  lastDispatch: DispatchIdentity | null;
}

export interface GroupFixture {
  groupId: string;
  address: TelegramAddress;
  members: Array<{ residentId: string; scopeId: string; model: string; provider: string }>;
}

export type GroupPlanStatus = "visible" | "silent" | "failed";

export interface GroupTraceEntry {
  residentId: string;
  scopeId: string;
  dispatchId: string;
  model: string;
  provider: string;
  status: GroupPlanStatus;
  outboundStatus: OutboundReceipt["status"] | null;
}

export interface ContinuityVotes {
  machine: "passed" | "failed" | "missing";
  resident: "accepted" | "rejected" | "missing";
  relationships: Array<"accepted" | "rejected" | "not-asked">;
}

export interface ContinuityActivation {
  residentId: string;
  activated: boolean;
  reason: string | null;
}

export interface TelegramChannelDriver {
  reset(): Promise<void>;

  createResidentFixture(label: string, model: string, provider: string): Promise<ResidentFixture>;
  createScopeFixture(residentId: string, label: string): Promise<ScopeFixture>;
  setScopeVisibility(scopeId: string, visible: boolean): Promise<ScopeFixture>;
  advanceScopeGeneration(scopeId: string): Promise<ScopeFixture>;

  bindAddress(input: {
    address: TelegramAddress;
    residentId: string;
    scopeId: string;
  }): Promise<Result<ChannelBinding>>;
  readBinding(bindingId: string): Promise<ChannelBinding>;
  resolveAddress(address: TelegramAddress): Promise<Result<ChannelBinding>>;
  revokeBinding(bindingId: string): Promise<Result<ChannelBinding>>;

  ingestUpdate(update: TelegramUpdate): Promise<Result<InboundReceipt>>;
  readInboundEffects(): Promise<string[]>;
  readHostDispatch(): Promise<HostDispatchSnapshot>;

  sendOutbound(
    request: OutboundRequest,
    scenario: "visible" | "receipt-lost" | "telegram-unavailable",
  ): Promise<Result<OutboundReceipt>>;
  readOutbound(outboundId: string): Promise<Result<OutboundReceipt>>;
  readOutboundEffects(): Promise<string[]>;

  createTokenReference(secretCanary: string): Promise<TokenReference>;
  attachToken(credentialRef: string): Promise<void>;
  inspectTokenBoundary(): Promise<TokenBoundarySnapshot>;
  revokeToken(): Promise<void>;

  beginInFlightChannelOperation(
    direction: "inbound" | "outbound",
    bindingId: string,
  ): Promise<Result<InFlightChannelOperation>>;
  completeInFlightChannelOperation(
    operation: InFlightChannelOperation,
  ): Promise<Result<InboundReceipt | OutboundReceipt>>;

  readObservability(bindingId: string): Promise<ChannelObservability>;
  setTelegramAvailability(available: boolean): Promise<void>;
  restartChannel(): Promise<void>;

  switchResidentModel(
    residentId: string,
    model: string,
    provider: string,
  ): Promise<ResidentFixture>;
  setContinuityVotes(residentId: string, votes: ContinuityVotes): Promise<void>;
  activateContinuity(residentId: string): Promise<ContinuityActivation>;

  createGroupFixture(input: {
    address: TelegramAddress;
    members: Array<{ residentId: string; scopeId: string }>;
  }): Promise<GroupFixture>;
  runGroupRound(
    groupId: string,
    plans: Array<{ residentId: string; status: GroupPlanStatus }>,
  ): Promise<GroupTraceEntry[]>;
  readCanonicalState(residentId: string): Promise<ResidentFixture>;
}

export interface TelegramChannelCheckResult {
  passed: boolean;
  detail: string;
}

export interface TelegramChannelCheck {
  id: string;
  title: string;
  uses: Array<keyof TelegramChannelDriver>;
  run(driver: TelegramChannelDriver): Promise<TelegramChannelCheckResult>;
}
