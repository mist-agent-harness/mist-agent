/** #185 / D26 的十四盏可执行判卷。 */
import type {
  ChannelBinding,
  DispatchContext,
  InboundReceipt,
  ResidentFixture,
  ScopeFixture,
  TelegramAddress,
  TelegramChannelCheck,
  TelegramChannelCheckResult,
  TelegramChannelDriver,
  TelegramUpdate,
} from "./telegram-channel-driver.ts";

const pass = (detail: string): TelegramChannelCheckResult => ({ passed: true, detail });
const fail = (detail: string): TelegramChannelCheckResult => ({ passed: false, detail });
const json = (value: unknown): string => JSON.stringify(value);

interface ReadyChannel {
  resident: ResidentFixture;
  scope: ScopeFixture;
  binding: ChannelBinding;
}

function address(chatId: string, topicId: string | null = null): TelegramAddress {
  return { chatId, topicId };
}

async function readyChannel(
  driver: TelegramChannelDriver,
  label: string,
  model = `model:${label}`,
  provider = `provider:${label}`,
  target = address(`chat:${label}`),
): Promise<ReadyChannel> {
  const resident = await driver.createResidentFixture(label, model, provider);
  const scope = await driver.createScopeFixture(resident.residentId, label);
  const binding = await driver.bindAddress({
    address: target,
    residentId: resident.residentId,
    scopeId: scope.scopeId,
  });
  if (!binding.ok) throw new Error(`正对照 binding 失败：${binding.reason}`);
  return { resident, scope, binding: binding.value };
}

function update(target: TelegramAddress, label: string): TelegramUpdate {
  return {
    updateId: `update:${label}`,
    messageId: `message:${label}`,
    address: target,
    senderId: `sender:${label}`,
    payload: `payload:${label}`,
  };
}

function context(receipt: InboundReceipt, binding: ChannelBinding): DispatchContext {
  if (receipt.dispatch === null) throw new Error("正对照没有 dispatch identity");
  return { ...receipt.dispatch, bindingId: binding.bindingId };
}

async function dispatchContext(
  driver: TelegramChannelDriver,
  fixture: ReadyChannel,
  label: string,
): Promise<DispatchContext> {
  const inbound = await driver.ingestUpdate(update(fixture.binding.address, label));
  if (!inbound.ok || inbound.value.status !== "dispatched") {
    throw new Error(`正对照 inbound 失败：${json(inbound)}`);
  }
  return context(inbound.value, fixture.binding);
}

const tg01: TelegramChannelCheck = {
  id: "TG-01",
  title: "Telegram id 只作外部地址，权威解析仍是 resident/scope",
  uses: ["createResidentFixture", "createScopeFixture", "bindAddress", "resolveAddress", "reset"],
  async run(driver) {
    try {
      const resident = await driver.createResidentFixture("tg01", "model:a", "provider:a");
      const scope = await driver.createScopeFixture(resident.residentId, "tg01");
      const root = await driver.bindAddress({
        address: address("chat:tg01"),
        residentId: resident.residentId,
        scopeId: scope.scopeId,
      });
      const topic = await driver.bindAddress({
        address: address("chat:tg01", "topic:7"),
        residentId: resident.residentId,
        scopeId: scope.scopeId,
      });
      if (!root.ok || !topic.ok) return fail("chat/topic 正对照绑定失败");
      for (const target of [root.value.address, topic.value.address]) {
        const resolved = await driver.resolveAddress(target);
        if (
          !resolved.ok ||
          resolved.value.residentId !== resident.residentId ||
          resolved.value.scopeId !== scope.scopeId
        ) {
          return fail(`外部地址解析改变了权威身份：${json(resolved)}`);
        }
      }
      return pass("chat 与 topic 两类地址都只投影到同一 resident/scope");
    } finally {
      await driver.reset();
    }
  },
};

const tg02: TelegramChannelCheck = {
  id: "TG-02",
  title: "无效绑定、不可见 scope、撤权与旧代际全部 fail-closed",
  uses: [
    "createResidentFixture",
    "createScopeFixture",
    "bindAddress",
    "ingestUpdate",
    "setScopeVisibility",
    "revokeBinding",
    "beginInFlightChannelOperation",
    "advanceScopeGeneration",
    "completeInFlightChannelOperation",
    "reset",
  ],
  async run(driver) {
    try {
      const missing = await driver.ingestUpdate(update(address("chat:missing"), "tg02-missing"));
      if (missing.ok || missing.reason !== "BINDING_NOT_FOUND") {
        return fail(`无绑定没有稳定拒绝：${json(missing)}`);
      }
      const first = await readyChannel(
        driver,
        "tg02-first",
        "model:a",
        "provider:a",
        address("chat:tg02"),
      );
      const secondResident = await driver.createResidentFixture(
        "tg02-second",
        "model:b",
        "provider:b",
      );
      const secondScope = await driver.createScopeFixture(secondResident.residentId, "tg02-second");
      const conflict = await driver.bindAddress({
        address: first.binding.address,
        residentId: secondResident.residentId,
        scopeId: secondScope.scopeId,
      });
      if (conflict.ok || conflict.reason !== "BINDING_CONFLICT") return fail("冲突绑定被接受");
      await driver.setScopeVisibility(first.scope.scopeId, false);
      const hidden = await driver.ingestUpdate(update(first.binding.address, "tg02-hidden"));
      if (hidden.ok || hidden.reason !== "SCOPE_NOT_VISIBLE") return fail("不可见 scope 收到消息");
      await driver.setScopeVisibility(first.scope.scopeId, true);
      const inFlight = await driver.beginInFlightChannelOperation(
        "inbound",
        first.binding.bindingId,
      );
      if (!inFlight.ok) throw new Error(`在途正对照失败：${inFlight.reason}`);
      await driver.advanceScopeGeneration(first.scope.scopeId);
      const stale = await driver.completeInFlightChannelOperation(inFlight.value);
      if (stale.ok || stale.reason !== "STALE_SCOPE_GENERATION") {
        return fail(`旧代际在途消息没有稳定拒绝：${json(stale)}`);
      }
      await driver.revokeBinding(first.binding.bindingId);
      const revoked = await driver.ingestUpdate(update(first.binding.address, "tg02-revoked"));
      if (revoked.ok || revoked.reason !== "BINDING_REVOKED") return fail("撤权绑定继续派发");
      return pass("无绑定、冲突、不可见、旧代际与撤权均 fail-closed");
    } finally {
      await driver.reset();
    }
  },
};

const tg03: TelegramChannelCheck = {
  id: "TG-03",
  title: "入站经 HostProvider 六字段派发，插件不自建宿主",
  uses: [
    "createResidentFixture",
    "createScopeFixture",
    "bindAddress",
    "ingestUpdate",
    "readHostDispatch",
    "reset",
  ],
  async run(driver) {
    try {
      const fixture = await readyChannel(driver, "tg03");
      const inbound = await driver.ingestUpdate(update(fixture.binding.address, "tg03"));
      if (!inbound.ok || inbound.value.status !== "dispatched" || inbound.value.dispatch === null) {
        return fail(`有效入站没有派发：${json(inbound)}`);
      }
      const host = await driver.readHostDispatch();
      const dispatch = inbound.value.dispatch;
      if (
        host.hostProviderDispatches !== 1 ||
        host.channelOwnedHosts !== 0 ||
        host.lastDispatch?.dispatchId !== dispatch.dispatchId ||
        !dispatch.residentId ||
        !dispatch.scopeId ||
        dispatch.scopeGeneration < 1 ||
        !dispatch.windowId ||
        dispatch.windowGeneration < 1
      ) {
        return fail(`宿主派发证据不完整：${json({ host, dispatch })}`);
      }
      return pass("六字段进入 HostProvider，Telegram adapter 自建宿主数为零");
    } finally {
      await driver.reset();
    }
  },
};

const tg04: TelegramChannelCheck = {
  id: "TG-04",
  title: "重复 update 幂等，乱序不改身份，迟到结果不能跨代",
  uses: [
    "createResidentFixture",
    "createScopeFixture",
    "bindAddress",
    "ingestUpdate",
    "readInboundEffects",
    "beginInFlightChannelOperation",
    "advanceScopeGeneration",
    "completeInFlightChannelOperation",
    "reset",
  ],
  async run(driver) {
    try {
      const fixture = await readyChannel(driver, "tg04");
      const same = update(fixture.binding.address, "tg04-same");
      const first = await driver.ingestUpdate(same);
      const duplicate = await driver.ingestUpdate(same);
      if (!first.ok || !duplicate.ok || duplicate.value.status !== "duplicate") {
        return fail("重复 update 没有返回幂等回执");
      }
      const newer = await driver.ingestUpdate(update(fixture.binding.address, "tg04-200"));
      const older = await driver.ingestUpdate(update(fixture.binding.address, "tg04-100"));
      if (
        !newer.ok ||
        !older.ok ||
        newer.value.dispatch?.residentId !== fixture.resident.residentId ||
        older.value.dispatch?.residentId !== fixture.resident.residentId
      ) {
        return fail("乱序 update 改变了派发身份");
      }
      const effects = await driver.readInboundEffects();
      if (effects.filter((id) => id === first.value.effectId).length !== 1) {
        return fail("重复 update 产生了多份副作用");
      }
      const inFlight = await driver.beginInFlightChannelOperation(
        "inbound",
        fixture.binding.bindingId,
      );
      if (!inFlight.ok) throw new Error(`在途正对照失败：${inFlight.reason}`);
      await driver.advanceScopeGeneration(fixture.scope.scopeId);
      const stale = await driver.completeInFlightChannelOperation(inFlight.value);
      if (stale.ok || stale.reason !== "STALE_SCOPE_GENERATION") return fail("迟到结果跨代点灯");
      return pass("update 幂等、乱序身份稳定、迟到结果跨代拒绝");
    } finally {
      await driver.reset();
    }
  },
};

const tg05: TelegramChannelCheck = {
  id: "TG-05",
  title: "出站送达分层，回执丢失保持 unknown",
  uses: [
    "createResidentFixture",
    "createScopeFixture",
    "bindAddress",
    "ingestUpdate",
    "sendOutbound",
    "readOutbound",
    "reset",
  ],
  async run(driver) {
    try {
      const fixture = await readyChannel(driver, "tg05");
      const dispatch = await dispatchContext(driver, fixture, "tg05-context");
      const visible = await driver.sendOutbound(
        { context: dispatch, body: "visible", modelTargetHint: null },
        "visible",
      );
      if (
        !visible.ok ||
        visible.value.status !== "visible" ||
        visible.value.telegramMessageId === null
      ) {
        return fail("用户可见正对照没有真实 message id");
      }
      const lost = await driver.sendOutbound(
        {
          context: { ...dispatch, dispatchId: "dispatch:tg05-lost" },
          body: "lost",
          modelTargetHint: null,
        },
        "receipt-lost",
      );
      if (!lost.ok || lost.value.status !== "unknown" || lost.value.reason !== "RECEIPT_LOST") {
        return fail(`丢回执没有外显 unknown：${json(lost)}`);
      }
      const reread = await driver.readOutbound(lost.value.outboundId);
      if (!reread.ok || reread.value.status !== "unknown") return fail("unknown 没有耐久读回");
      return pass("visible 与 receipt-lost unknown 分层且耐久可查");
    } finally {
      await driver.reset();
    }
  },
};

const tg06: TelegramChannelCheck = {
  id: "TG-06",
  title: "出站目标只来自 binding 与 dispatch context",
  uses: [
    "createResidentFixture",
    "createScopeFixture",
    "bindAddress",
    "ingestUpdate",
    "sendOutbound",
    "reset",
  ],
  async run(driver) {
    try {
      const fixture = await readyChannel(driver, "tg06");
      const dispatch = await dispatchContext(driver, fixture, "tg06-context");
      const sent = await driver.sendOutbound(
        {
          context: dispatch,
          body: "authorized-target-only",
          modelTargetHint: address("chat:attacker", "topic:attacker"),
        },
        "visible",
      );
      if (!sent.ok || json(sent.value.target) !== json(fixture.binding.address)) {
        return fail(`模型 target hint 改写了发送目标：${json(sent)}`);
      }
      return pass("未授权 hint 被忽略，实际目标逐字段等于当前 binding");
    } finally {
      await driver.reset();
    }
  },
};

const tg07: TelegramChannelCheck = {
  id: "TG-07",
  title: "bot token 只走 opaque reference，明文不落产物",
  uses: [
    "createTokenReference",
    "attachToken",
    "createResidentFixture",
    "createScopeFixture",
    "bindAddress",
    "ingestUpdate",
    "sendOutbound",
    "inspectTokenBoundary",
    "reset",
  ],
  async run(driver) {
    try {
      const secret = "telegram-token-canary-tg07";
      const token = await driver.createTokenReference(secret);
      await driver.attachToken(token.credentialRef);
      const fixture = await readyChannel(driver, "tg07");
      const dispatch = await dispatchContext(driver, fixture, "tg07-context");
      const sent = await driver.sendOutbound(
        { context: dispatch, body: "token-positive-control", modelTargetHint: null },
        "visible",
      );
      if (!sent.ok) return fail("token resolver 正对照无法完成出站");
      const boundary = await driver.inspectTokenBoundary();
      if (boundary.credentialRef !== token.credentialRef || boundary.resolvedCount < 1) {
        return fail("opaque token ref 没有被真实解析使用");
      }
      const artifacts = [
        ...boundary.config,
        ...boundary.logs,
        ...boundary.receipts,
        ...boundary.errors,
      ];
      if (artifacts.some((value) => value.includes(secret)))
        return fail("明文 token canary 落入产物");
      return pass("token ref 被解析使用，明文未进入配置、日志、回执或错误");
    } finally {
      await driver.reset();
    }
  },
};

const tg08: TelegramChannelCheck = {
  id: "TG-08",
  title: "撤 binding/token 后新旧入站与出站都停止",
  uses: [
    "createTokenReference",
    "attachToken",
    "createResidentFixture",
    "createScopeFixture",
    "bindAddress",
    "beginInFlightChannelOperation",
    "inspectTokenBoundary",
    "revokeBinding",
    "revokeToken",
    "ingestUpdate",
    "completeInFlightChannelOperation",
    "reset",
  ],
  async run(driver) {
    try {
      const token = await driver.createTokenReference("telegram-token-canary-tg08");
      await driver.attachToken(token.credentialRef);
      const fixture = await readyChannel(driver, "tg08");
      const inbound = await driver.beginInFlightChannelOperation(
        "inbound",
        fixture.binding.bindingId,
      );
      const outbound = await driver.beginInFlightChannelOperation(
        "outbound",
        fixture.binding.bindingId,
      );
      if (!inbound.ok || !outbound.ok) throw new Error("在途正对照失败");
      const before = await driver.inspectTokenBoundary();
      await driver.revokeBinding(fixture.binding.bindingId);
      await driver.revokeToken();
      const fresh = await driver.ingestUpdate(update(fixture.binding.address, "tg08-fresh"));
      const lateIn = await driver.completeInFlightChannelOperation(inbound.value);
      const lateOut = await driver.completeInFlightChannelOperation(outbound.value);
      if (fresh.ok || lateIn.ok || lateOut.ok) return fail("撤权后仍有新旧收发路径成功");
      const after = await driver.inspectTokenBoundary();
      if (after.resolvedCount !== before.resolvedCount) return fail("撤权后仍解析 token");
      return pass("binding/token 撤权切断新请求、在途旧请求与凭证解析");
    } finally {
      await driver.reset();
    }
  },
};

const tg09: TelegramChannelCheck = {
  id: "TG-09",
  title: "adapter、Bot API、binding 与真实收发读回可观察",
  uses: [
    "createResidentFixture",
    "createScopeFixture",
    "bindAddress",
    "ingestUpdate",
    "sendOutbound",
    "readObservability",
    "setTelegramAvailability",
    "reset",
  ],
  async run(driver) {
    try {
      const fixture = await readyChannel(driver, "tg09");
      const dispatch = await dispatchContext(driver, fixture, "tg09-context");
      await driver.sendOutbound(
        { context: dispatch, body: "observable", modelTargetHint: null },
        "visible",
      );
      const healthy = await driver.readObservability(fixture.binding.bindingId);
      if (
        !healthy.adapterVersion ||
        !healthy.botApiVersion ||
        healthy.capabilities.length === 0 ||
        healthy.bindingVersion !== fixture.binding.bindingVersion ||
        healthy.lastInbound.status !== "fresh" ||
        healthy.lastOutbound.status !== "fresh"
      ) {
        return fail(`完整观测字段缺失：${json(healthy)}`);
      }
      await driver.setTelegramAvailability(false);
      const unavailable = await driver.readObservability(fixture.binding.bindingId);
      if (unavailable.lastOutbound.status !== "unavailable") {
        return fail("Bot API 不可用没有 typed unavailable");
      }
      return pass("完整读回与 Bot API unavailable 两条路径均可观察");
    } finally {
      await driver.reset();
    }
  },
};

const gd01: TelegramChannelCheck = {
  id: "GD-01",
  title: "两位 resident 独立模型同群收发且全链可追",
  uses: [
    "createResidentFixture",
    "createScopeFixture",
    "createGroupFixture",
    "runGroupRound",
    "reset",
  ],
  async run(driver) {
    try {
      const a = await driver.createResidentFixture("gd01-a", "model:a", "provider:a");
      const b = await driver.createResidentFixture("gd01-b", "model:b", "provider:b");
      const scopeA = await driver.createScopeFixture(a.residentId, "gd01-a");
      const scopeB = await driver.createScopeFixture(b.residentId, "gd01-b");
      const group = await driver.createGroupFixture({
        address: address("chat:gd01"),
        members: [
          { residentId: a.residentId, scopeId: scopeA.scopeId },
          { residentId: b.residentId, scopeId: scopeB.scopeId },
        ],
      });
      const trace = await driver.runGroupRound(group.groupId, [
        { residentId: a.residentId, status: "visible" },
        { residentId: b.residentId, status: "visible" },
      ]);
      if (
        trace.length !== 2 ||
        new Set(trace.map((entry) => entry.residentId)).size !== 2 ||
        new Set(trace.map((entry) => `${entry.model}:${entry.provider}`)).size !== 2 ||
        trace.some(
          (entry) => !entry.scopeId || !entry.dispatchId || entry.outboundStatus !== "visible",
        )
      ) {
        return fail(`多住户同群链路不可追或模型未独立：${json(trace)}`);
      }
      return pass("两位 resident 各走独立模型通道，消息全链可追到可见回执");
    } finally {
      await driver.reset();
    }
  },
};

const gd02: TelegramChannelCheck = {
  id: "GD-02",
  title: "更换 model/provider 不更换 resident 或 Telegram binding",
  uses: [
    "createResidentFixture",
    "createScopeFixture",
    "bindAddress",
    "readBinding",
    "switchResidentModel",
    "createGroupFixture",
    "runGroupRound",
    "reset",
  ],
  async run(driver) {
    try {
      const fixture = await readyChannel(driver, "gd02", "model:old", "provider:old");
      const switched = await driver.switchResidentModel(
        fixture.resident.residentId,
        "model:new",
        "provider:new",
      );
      const binding = await driver.readBinding(fixture.binding.bindingId);
      if (
        switched.residentId !== fixture.resident.residentId ||
        switched.canonicalStateHash !== fixture.resident.canonicalStateHash ||
        binding.residentId !== fixture.resident.residentId ||
        binding.scopeId !== fixture.scope.scopeId
      ) {
        return fail("换模型后 resident、canonical state 或 binding 漂移");
      }
      const group = await driver.createGroupFixture({
        address: fixture.binding.address,
        members: [{ residentId: switched.residentId, scopeId: fixture.scope.scopeId }],
      });
      const trace = await driver.runGroupRound(group.groupId, [
        { residentId: switched.residentId, status: "visible" },
      ]);
      if (trace[0]?.model !== "model:new" || trace[0]?.provider !== "provider:new") {
        return fail("换模后的真实发言仍走旧运行通道");
      }
      return pass("运行通道已换，residentId、canonical state 与 binding 均不变");
    } finally {
      await driver.reset();
    }
  },
};

const gd03: TelegramChannelCheck = {
  id: "GD-03",
  title: "D23 三类判词齐全才激活跨模型连续性",
  uses: ["createResidentFixture", "setContinuityVotes", "activateContinuity", "reset"],
  async run(driver) {
    try {
      const resident = await driver.createResidentFixture("gd03", "model:new", "provider:new");
      const cases = [
        { machine: "missing", resident: "accepted", relationships: ["accepted"] },
        { machine: "passed", resident: "missing", relationships: ["accepted"] },
        { machine: "passed", resident: "accepted", relationships: ["not-asked"] },
      ] as const;
      for (const votes of cases) {
        await driver.setContinuityVotes(resident.residentId, {
          machine: votes.machine,
          resident: votes.resident,
          relationships: [...votes.relationships],
        });
        const blocked = await driver.activateContinuity(resident.residentId);
        if (blocked.activated) return fail(`缺判词仍激活：${json(votes)}`);
      }
      await driver.setContinuityVotes(resident.residentId, {
        machine: "passed",
        resident: "accepted",
        relationships: ["accepted"],
      });
      const active = await driver.activateContinuity(resident.residentId);
      if (!active.activated || active.residentId !== resident.residentId) {
        return fail("三类判词齐全正对照未激活");
      }
      return pass("machine、resident、relationship 缺一不可，齐全才激活");
    } finally {
      await driver.reset();
    }
  },
};

const gd04: TelegramChannelCheck = {
  id: "GD-04",
  title: "同群派发归属清楚，visible/silent/failed 可区分",
  uses: [
    "createResidentFixture",
    "createScopeFixture",
    "createGroupFixture",
    "runGroupRound",
    "reset",
  ],
  async run(driver) {
    try {
      const residents = await Promise.all(
        ["visible", "silent", "failed"].map((label) =>
          driver.createResidentFixture(`gd04-${label}`, `model:${label}`, `provider:${label}`),
        ),
      );
      const scopes = await Promise.all(
        residents.map((resident, index) =>
          driver.createScopeFixture(resident.residentId, `gd04-${index}`),
        ),
      );
      const group = await driver.createGroupFixture({
        address: address("chat:gd04"),
        members: residents.map((resident, index) => ({
          residentId: resident.residentId,
          scopeId: scopes[index]?.scopeId ?? "missing",
        })),
      });
      const expected = ["visible", "silent", "failed"] as const;
      const trace = await driver.runGroupRound(
        group.groupId,
        residents.map((resident, index) => ({
          residentId: resident.residentId,
          status: expected[index] ?? "failed",
        })),
      );
      if (trace.length !== 3 || trace.some((entry, index) => entry.status !== expected[index])) {
        return fail(`三类群聊结果被压平或串位：${json(trace)}`);
      }
      if (trace[0]?.outboundStatus !== "visible" || trace[1]?.outboundStatus !== null) {
        return fail("发言与沉默的回执语义不清");
      }
      return pass("每位 resident 的派发归属独立，发言、沉默与失败分别留账");
    } finally {
      await driver.reset();
    }
  },
};

const gd05: TelegramChannelCheck = {
  id: "GD-05",
  title: "冷启动、重连、重复 update 与平台故障不漂移不重放",
  uses: [
    "createResidentFixture",
    "createScopeFixture",
    "bindAddress",
    "ingestUpdate",
    "restartChannel",
    "readBinding",
    "readCanonicalState",
    "setTelegramAvailability",
    "sendOutbound",
    "readOutboundEffects",
    "reset",
  ],
  async run(driver) {
    try {
      const fixture = await readyChannel(driver, "gd05");
      const same = update(fixture.binding.address, "gd05-same");
      const first = await driver.ingestUpdate(same);
      if (!first.ok || first.value.dispatch === null) throw new Error("入站正对照失败");
      await driver.restartChannel();
      const duplicate = await driver.ingestUpdate(same);
      if (!duplicate.ok || duplicate.value.status !== "duplicate") {
        return fail("冷启动后重复 update 被重放");
      }
      const binding = await driver.readBinding(fixture.binding.bindingId);
      const resident = await driver.readCanonicalState(fixture.resident.residentId);
      if (
        binding.residentId !== fixture.resident.residentId ||
        binding.scopeId !== fixture.scope.scopeId ||
        resident.canonicalStateHash !== fixture.resident.canonicalStateHash
      ) {
        return fail("冷启动或重连后 binding/canonical state 漂移");
      }
      await driver.setTelegramAvailability(false);
      const sent = await driver.sendOutbound(
        {
          context: context(first.value, fixture.binding),
          body: "platform-unavailable",
          modelTargetHint: null,
        },
        "telegram-unavailable",
      );
      if (!sent.ok || sent.value.status !== "unknown") return fail("平台故障没有外显 unknown");
      const beforeRecovery = await driver.readOutboundEffects();
      await driver.setTelegramAvailability(true);
      await driver.restartChannel();
      const afterRecovery = await driver.readOutboundEffects();
      if (json(afterRecovery) !== json(beforeRecovery)) return fail("恢复后自动重放了未知副作用");
      return pass("冷启动保持账与身份；平台 unknown 恢复后不自动重放");
    } finally {
      await driver.reset();
    }
  },
};

export const expectedTelegramChannelCheckIds = [
  "TG-01",
  "TG-02",
  "TG-03",
  "TG-04",
  "TG-05",
  "TG-06",
  "TG-07",
  "TG-08",
  "TG-09",
  "GD-01",
  "GD-02",
  "GD-03",
  "GD-04",
  "GD-05",
] as const;

export const telegramChannelChecks: TelegramChannelCheck[] = [
  tg01,
  tg02,
  tg03,
  tg04,
  tg05,
  tg06,
  tg07,
  tg08,
  tg09,
  gd01,
  gd02,
  gd03,
  gd04,
  gd05,
];
