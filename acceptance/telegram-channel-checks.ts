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
  TokenBoundarySnapshot,
} from "./telegram-channel-driver.ts";

const pass = (detail: string): TelegramChannelCheckResult => ({ passed: true, detail });
const fail = (detail: string): TelegramChannelCheckResult => ({ passed: false, detail });
const json = (value: unknown): string => JSON.stringify(value);

interface ReadyChannel {
  resident: ResidentFixture;
  scope: ScopeFixture;
  binding: ChannelBinding;
  expectedResident: ResidentFixture;
  expectedScope: ScopeFixture;
}

function address(chatId: string, topicId: string | null = null): TelegramAddress {
  return { chatId, topicId };
}

function copyAddress(value: TelegramAddress): TelegramAddress {
  return { chatId: value.chatId, topicId: value.topicId };
}

async function readyChannel(
  driver: TelegramChannelDriver,
  label: string,
  model = `model:${label}`,
  provider = `provider:${label}`,
  target = address(`chat:${label}`),
): Promise<ReadyChannel> {
  const resident = await driver.createResidentFixture(label, model, provider);
  const expectedResident = structuredClone(resident);
  const scope = await driver.createScopeFixture(expectedResident.residentId, label);
  const expectedScope = structuredClone(scope);
  if (expectedScope.residentId !== expectedResident.residentId) {
    throw new Error("正对照 scope 改写了创建时冻结的 resident identity");
  }
  const binding = await driver.bindAddress({
    address: target,
    residentId: expectedResident.residentId,
    scopeId: expectedScope.scopeId,
  });
  if (!binding.ok) throw new Error(`正对照 binding 失败：${binding.reason}`);
  return { resident, scope, binding: binding.value, expectedResident, expectedScope };
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
  uses: [
    "createResidentFixture",
    "createScopeFixture",
    "bindAddress",
    "ingestUpdate",
    "readInboundEffects",
    "readHostDispatch",
    "readBinding",
    "resolveAddress",
    "reset",
  ],
  async run(driver) {
    try {
      const resident = await driver.createResidentFixture("tg01", "model:a", "provider:a");
      const expectedResidentId = resident.residentId;
      const scope = await driver.createScopeFixture(expectedResidentId, "tg01");
      const expectedScopeId = scope.scopeId;
      if (scope.residentId !== expectedResidentId) {
        return fail("建 scope 时改写了刚创建的 resident identity");
      }
      const root = await driver.bindAddress({
        address: address("chat:tg01"),
        residentId: expectedResidentId,
        scopeId: expectedScopeId,
      });
      const topic = await driver.bindAddress({
        address: address("chat:tg01", "topic:7"),
        residentId: expectedResidentId,
        scopeId: expectedScopeId,
      });
      if (!root.ok || !topic.ok) return fail("chat/topic 正对照绑定失败");
      const rootAddress = copyAddress(root.value.address);
      const topicAddress = copyAddress(topic.value.address);
      for (const bindingId of [root.value.bindingId, topic.value.bindingId]) {
        const stored = await driver.readBinding(bindingId);
        if (stored.residentId !== expectedResidentId || stored.scopeId !== expectedScopeId) {
          return fail(`binding 没有保留创建时冻结的 resident/scope：${json(stored)}`);
        }
      }
      for (const target of [rootAddress, topicAddress]) {
        const resolved = await driver.resolveAddress(target);
        if (
          !resolved.ok ||
          resolved.value.residentId !== expectedResidentId ||
          resolved.value.scopeId !== expectedScopeId
        ) {
          return fail(`外部地址解析改变了权威身份：${json(resolved)}`);
        }
      }
      const nonAddressIds = update(rootAddress, "tg01-non-address");
      const seen = await driver.ingestUpdate(nonAddressIds);
      if (
        !seen.ok ||
        seen.value.status !== "dispatched" ||
        seen.value.dispatch?.residentId !== expectedResidentId ||
        seen.value.dispatch.scopeId !== expectedScopeId ||
        seen.value.dispatch.sourceMessageId !== nonAddressIds.messageId
      ) {
        return fail(`外部 id 见证正对照没有实际入站：${json(seen)}`);
      }
      for (const externalId of [nonAddressIds.messageId, nonAddressIds.senderId]) {
        for (const misusedAddress of [
          address(externalId),
          address(rootAddress.chatId, externalId),
        ]) {
          const misused = await driver.resolveAddress(misusedAddress);
          if (misused.ok || misused.reason !== "BINDING_NOT_FOUND") {
            return fail(`见过的 message/user id 被误当成 chat/topic 地址：${json(misused)}`);
          }
        }
      }
      return pass("chat/topic 投影到 resident/scope；见过的 message/user id 不能升格为地址");
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
    "readBinding",
    "readInboundEffects",
    "readHostDispatch",
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
      const afterMissingEffects = await driver.readInboundEffects();
      const afterMissingEffectsTruth = json(afterMissingEffects);
      const afterMissingHost = await driver.readHostDispatch();
      const afterMissingHostTruth = json(afterMissingHost);
      if (
        afterMissingEffects.length !== 0 ||
        afterMissingHost.hostProviderDispatches !== 0 ||
        afterMissingHost.lastDispatch !== null
      ) {
        return fail("无绑定失败路径写入 effect、宿主派发或猜测 resident");
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
      const expectedResidentId = first.expectedResident.residentId;
      const expectedScope = structuredClone(first.expectedScope);
      const expectedBinding = structuredClone(first.binding);
      const storedBinding = await driver.readBinding(expectedBinding.bindingId);
      if (
        storedBinding.residentId !== expectedResidentId ||
        storedBinding.scopeId !== expectedScope.scopeId
      ) {
        return fail(`binding 没有保留绑定前冻结的 resident/scope：${json(storedBinding)}`);
      }
      const conflict = await driver.bindAddress({
        address: first.binding.address,
        residentId: secondResident.residentId,
        scopeId: secondScope.scopeId,
      });
      if (conflict.ok || conflict.reason !== "BINDING_CONFLICT") return fail("冲突绑定被接受");
      await driver.setScopeVisibility(first.scope.scopeId, false);
      const hidden = await driver.ingestUpdate(update(first.binding.address, "tg02-hidden"));
      if (hidden.ok || hidden.reason !== "SCOPE_NOT_VISIBLE") return fail("不可见 scope 收到消息");
      if (
        json(await driver.readInboundEffects()) !== afterMissingEffectsTruth ||
        json(await driver.readHostDispatch()) !== afterMissingHostTruth
      ) {
        return fail("不可见 scope 的拒绝路径写入 effect 或宿主派发");
      }
      await driver.setScopeVisibility(first.scope.scopeId, true);
      const valid = await driver.ingestUpdate(update(first.binding.address, "tg02-valid"));
      if (
        !valid.ok ||
        valid.value.status !== "dispatched" ||
        valid.value.dispatch?.residentId !== expectedResidentId ||
        valid.value.dispatch.scopeId !== expectedScope.scopeId ||
        json(await driver.readBinding(expectedBinding.bindingId)) !== json(expectedBinding)
      ) {
        return fail(`有效当前绑定正对照没有派发：${json(valid)}`);
      }
      const current = await driver.beginInFlightChannelOperation(
        "inbound",
        first.binding.bindingId,
      );
      if (!current.ok) throw new Error(`当前代际在途正对照失败：${current.reason}`);
      const currentCompletion = await driver.completeInFlightChannelOperation(current.value);
      if (
        !currentCompletion.ok ||
        currentCompletion.value.status !== "dispatched" ||
        currentCompletion.value.dispatch?.residentId !== expectedResidentId ||
        currentCompletion.value.dispatch.scopeId !== expectedScope.scopeId ||
        currentCompletion.value.dispatch.scopeGeneration !== expectedScope.scopeGeneration
      ) {
        return fail(`当前代际在途请求不能正常完成：${json(currentCompletion)}`);
      }
      const inFlight = await driver.beginInFlightChannelOperation(
        "inbound",
        first.binding.bindingId,
      );
      if (!inFlight.ok) throw new Error(`旧代际在途正对照失败：${inFlight.reason}`);
      const advanced = await driver.advanceScopeGeneration(expectedScope.scopeId);
      const advancedGeneration = advanced.scopeGeneration;
      if (advancedGeneration <= inFlight.value.scopeGeneration) {
        return fail("advanceScopeGeneration 没有推进 scope 代际");
      }
      const storedAfterAdvance = await driver.setScopeVisibility(
        expectedScope.scopeId,
        expectedScope.visible,
      );
      if (storedAfterAdvance.scopeGeneration !== advancedGeneration) {
        return fail("advanceScopeGeneration 的返回值没有独立库存读回支撑");
      }
      const postAdvance = await driver.beginInFlightChannelOperation(
        "inbound",
        first.binding.bindingId,
      );
      if (
        !postAdvance.ok ||
        postAdvance.value.scopeGeneration !== storedAfterAdvance.scopeGeneration ||
        postAdvance.value.scopeGeneration <= inFlight.value.scopeGeneration
      ) {
        return fail("advanceScopeGeneration 只改返回值，没有推进新在途请求读到的库存代际");
      }
      const postAdvanceCompletion = await driver.completeInFlightChannelOperation(
        postAdvance.value,
      );
      if (
        !postAdvanceCompletion.ok ||
        postAdvanceCompletion.value.status !== "dispatched" ||
        postAdvanceCompletion.value.dispatch?.residentId !== expectedResidentId ||
        postAdvanceCompletion.value.dispatch.scopeId !== expectedScope.scopeId ||
        postAdvanceCompletion.value.dispatch.scopeGeneration !== storedAfterAdvance.scopeGeneration
      ) {
        return fail(`推进后的当前代际不能正常完成：${json(postAdvanceCompletion)}`);
      }
      const effectsBeforeStale = await driver.readInboundEffects();
      const effectsBeforeStaleTruth = json(effectsBeforeStale);
      const hostBeforeStaleTruth = json(await driver.readHostDispatch());
      const stale = await driver.completeInFlightChannelOperation(inFlight.value);
      if (stale.ok || stale.reason !== "STALE_SCOPE_GENERATION") {
        return fail(`旧代际在途消息没有稳定拒绝：${json(stale)}`);
      }
      if (
        json(await driver.readInboundEffects()) !== effectsBeforeStaleTruth ||
        json(await driver.readHostDispatch()) !== hostBeforeStaleTruth
      ) {
        return fail("旧代际拒绝路径写入 effect、宿主派发或猜测 resident");
      }
      await driver.revokeBinding(expectedBinding.bindingId);
      const revoked = await driver.ingestUpdate(update(first.binding.address, "tg02-revoked"));
      if (revoked.ok || revoked.reason !== "BINDING_REVOKED") return fail("撤权绑定继续派发");
      if (
        json(await driver.readInboundEffects()) !== effectsBeforeStaleTruth ||
        json(await driver.readHostDispatch()) !== hostBeforeStaleTruth
      ) {
        return fail("撤权绑定拒绝路径写入 effect、宿主派发或猜测 resident");
      }
      return pass("有效当前绑定可派发；无绑定、冲突、不可见、旧代际与撤权均 fail-closed");
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
    "readBinding",
    "readHostDispatch",
    "reset",
  ],
  async run(driver) {
    try {
      const fixture = await readyChannel(driver, "tg03");
      const expectedResidentId = fixture.expectedResident.residentId;
      const expectedScope = fixture.expectedScope;
      const storedBinding = await driver.readBinding(fixture.binding.bindingId);
      if (
        storedBinding.residentId !== expectedResidentId ||
        storedBinding.scopeId !== expectedScope.scopeId
      ) {
        return fail(`binding 与创建时冻结身份不一致：${json(storedBinding)}`);
      }
      const inbound = await driver.ingestUpdate(update(fixture.binding.address, "tg03"));
      if (!inbound.ok || inbound.value.status !== "dispatched" || inbound.value.dispatch === null) {
        return fail(`有效入站没有派发：${json(inbound)}`);
      }
      const host = await driver.readHostDispatch();
      const dispatch = inbound.value.dispatch;
      if (
        host.hostProviderDispatches !== 1 ||
        host.channelOwnedHosts !== 0 ||
        json(host.lastDispatch) !== json(dispatch) ||
        dispatch.residentId !== expectedResidentId ||
        dispatch.scopeId !== expectedScope.scopeId ||
        dispatch.scopeGeneration !== expectedScope.scopeGeneration ||
        dispatch.windowId !== expectedScope.windowId ||
        dispatch.windowGeneration !== expectedScope.windowGeneration ||
        dispatch.sourceMessageId !== "message:tg03" ||
        dispatch.dispatchId.length === 0
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
    "readBinding",
    "readInboundEffects",
    "setScopeVisibility",
    "beginInFlightChannelOperation",
    "advanceScopeGeneration",
    "completeInFlightChannelOperation",
    "reset",
  ],
  async run(driver) {
    try {
      const fixture = await readyChannel(driver, "tg04");
      const expectedResidentId = fixture.expectedResident.residentId;
      const expectedScope = structuredClone(fixture.expectedScope);
      const storedBinding = await driver.readBinding(fixture.binding.bindingId);
      if (
        storedBinding.residentId !== expectedResidentId ||
        storedBinding.scopeId !== expectedScope.scopeId
      ) {
        return fail(`binding 没有保留绑定前冻结的 resident/scope：${json(storedBinding)}`);
      }
      const same = update(fixture.binding.address, "tg04-same");
      const first = await driver.ingestUpdate(same);
      const duplicate = await driver.ingestUpdate(same);
      if (
        !first.ok ||
        first.value.status !== "dispatched" ||
        first.value.dispatch?.residentId !== expectedResidentId ||
        first.value.dispatch.scopeId !== expectedScope.scopeId ||
        first.value.dispatch.scopeGeneration !== expectedScope.scopeGeneration ||
        first.value.dispatch.windowId !== expectedScope.windowId ||
        first.value.dispatch.windowGeneration !== expectedScope.windowGeneration ||
        !duplicate.ok ||
        duplicate.value.status !== "duplicate" ||
        json(duplicate.value.dispatch) !== json(first.value.dispatch)
      ) {
        return fail("重复 update 没有返回幂等回执");
      }
      const newer = await driver.ingestUpdate(update(fixture.binding.address, "tg04-200"));
      const older = await driver.ingestUpdate(update(fixture.binding.address, "tg04-100"));
      if (
        !newer.ok ||
        !older.ok ||
        newer.value.dispatch?.residentId !== expectedResidentId ||
        newer.value.dispatch.scopeId !== expectedScope.scopeId ||
        newer.value.dispatch.scopeGeneration !== expectedScope.scopeGeneration ||
        newer.value.dispatch.windowId !== expectedScope.windowId ||
        newer.value.dispatch.windowGeneration !== expectedScope.windowGeneration ||
        older.value.dispatch?.residentId !== expectedResidentId ||
        older.value.dispatch.scopeId !== expectedScope.scopeId ||
        older.value.dispatch.scopeGeneration !== expectedScope.scopeGeneration ||
        older.value.dispatch.windowId !== expectedScope.windowId ||
        older.value.dispatch.windowGeneration !== expectedScope.windowGeneration
      ) {
        return fail("乱序 update 改变了派发身份");
      }
      const effects = await driver.readInboundEffects();
      const effectsTruth = json(effects);
      const expectedEffects = [first.value.effectId, newer.value.effectId, older.value.effectId];
      if (
        expectedEffects.some((effectId) => effectId === null) ||
        new Set(expectedEffects).size !== expectedEffects.length ||
        effects.length !== expectedEffects.length ||
        !expectedEffects.every((effectId) => effects.includes(effectId as string))
      ) {
        return fail(`重复/乱序 update 的 effect 集合不精确：${json(effects)}`);
      }
      const current = await driver.beginInFlightChannelOperation(
        "inbound",
        fixture.binding.bindingId,
      );
      if (!current.ok) throw new Error(`当前代际正对照失败：${current.reason}`);
      const currentCompletion = await driver.completeInFlightChannelOperation(current.value);
      if (
        !currentCompletion.ok ||
        currentCompletion.value.status !== "dispatched" ||
        currentCompletion.value.dispatch?.residentId !== expectedResidentId ||
        currentCompletion.value.dispatch.scopeId !== expectedScope.scopeId ||
        currentCompletion.value.dispatch.scopeGeneration !== expectedScope.scopeGeneration ||
        currentCompletion.value.dispatch.windowId !== expectedScope.windowId ||
        currentCompletion.value.dispatch.windowGeneration !== expectedScope.windowGeneration
      ) {
        return fail(`当前代际在途结果不能正常完成：${json(currentCompletion)}`);
      }
      const inFlight = await driver.beginInFlightChannelOperation(
        "inbound",
        fixture.binding.bindingId,
      );
      if (!inFlight.ok) throw new Error(`在途正对照失败：${inFlight.reason}`);
      const advanced = await driver.advanceScopeGeneration(expectedScope.scopeId);
      const advancedGeneration = advanced.scopeGeneration;
      if (advancedGeneration <= inFlight.value.scopeGeneration) {
        return fail("advanceScopeGeneration 没有推进 scope 代际");
      }
      const storedAfterAdvance = await driver.setScopeVisibility(
        expectedScope.scopeId,
        expectedScope.visible,
      );
      if (storedAfterAdvance.scopeGeneration !== advancedGeneration) {
        return fail("advanceScopeGeneration 的返回值没有独立库存读回支撑");
      }
      const postAdvance = await driver.beginInFlightChannelOperation(
        "inbound",
        fixture.binding.bindingId,
      );
      if (
        !postAdvance.ok ||
        postAdvance.value.scopeGeneration !== storedAfterAdvance.scopeGeneration ||
        postAdvance.value.scopeGeneration <= inFlight.value.scopeGeneration
      ) {
        return fail("推进后的新请求没有读到新的 scope 代际");
      }
      const postAdvanceCompletion = await driver.completeInFlightChannelOperation(
        postAdvance.value,
      );
      if (
        !postAdvanceCompletion.ok ||
        postAdvanceCompletion.value.status !== "dispatched" ||
        postAdvanceCompletion.value.dispatch?.residentId !== expectedResidentId ||
        postAdvanceCompletion.value.dispatch.scopeId !== expectedScope.scopeId ||
        postAdvanceCompletion.value.dispatch.scopeGeneration !==
          storedAfterAdvance.scopeGeneration ||
        postAdvanceCompletion.value.dispatch.windowId !== expectedScope.windowId ||
        postAdvanceCompletion.value.dispatch.windowGeneration !== expectedScope.windowGeneration
      ) {
        return fail("推进后的当前代际请求被一律当成 stale");
      }
      const stale = await driver.completeInFlightChannelOperation(inFlight.value);
      if (stale.ok || stale.reason !== "STALE_SCOPE_GENERATION") return fail("迟到结果跨代点灯");
      const afterStale = await driver.readInboundEffects();
      if (json(afterStale) !== effectsTruth) return fail("迟到结果被拒后仍写入新 effect");
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
      const expectedAddress = copyAddress(fixture.binding.address);
      const expectedBindingId = fixture.binding.bindingId;
      const dispatch = await dispatchContext(driver, fixture, "tg05-context");
      const visible = await driver.sendOutbound(
        { context: dispatch, body: "visible", untrustedTargetHints: [] },
        "visible",
      );
      if (
        !visible.ok ||
        visible.value.status !== "visible" ||
        visible.value.telegramMessageId === null ||
        visible.value.bindingId !== expectedBindingId ||
        json(visible.value.target) !== json(expectedAddress)
      ) {
        return fail("用户可见正对照没有真实 message id");
      }
      const visibleReturned = structuredClone(visible.value);
      const submittedDispatch = await dispatchContext(driver, fixture, "tg05-submitted");
      const submitted = await driver.sendOutbound(
        { context: submittedDispatch, body: "submitted", untrustedTargetHints: [] },
        "submitted-only",
      );
      if (!submitted.ok) return fail("submitted 正对照发送失败");
      const submittedReturned = structuredClone(submitted.value);
      const acceptedDispatch = await dispatchContext(driver, fixture, "tg05-accepted");
      const accepted = await driver.sendOutbound(
        { context: acceptedDispatch, body: "accepted", untrustedTargetHints: [] },
        "accepted-only",
      );
      if (!accepted.ok) return fail("accepted 正对照发送失败");
      const acceptedReturned = structuredClone(accepted.value);
      if (
        !submitted.ok ||
        submittedReturned.status !== "submitted" ||
        submittedReturned.telegramMessageId !== null ||
        submittedReturned.bindingId !== expectedBindingId ||
        json(submittedReturned.target) !== json(expectedAddress) ||
        !accepted.ok ||
        acceptedReturned.status !== "accepted" ||
        acceptedReturned.telegramMessageId !== null ||
        acceptedReturned.bindingId !== expectedBindingId ||
        json(acceptedReturned.target) !== json(expectedAddress)
      ) {
        return fail("submitted/accepted 被误当成用户可见回执");
      }
      const lostDispatch = await dispatchContext(driver, fixture, "tg05-lost");
      const lost = await driver.sendOutbound(
        { context: lostDispatch, body: "lost", untrustedTargetHints: [] },
        "receipt-lost",
      );
      if (
        !lost.ok ||
        lost.value.status !== "unknown" ||
        lost.value.reason !== "RECEIPT_LOST" ||
        lost.value.telegramMessageId !== null ||
        lost.value.bindingId !== expectedBindingId ||
        json(lost.value.target) !== json(expectedAddress)
      ) {
        return fail(`丢回执没有外显 unknown：${json(lost)}`);
      }
      const lostReturned = structuredClone(lost.value);
      if (!visible.ok || !submitted.ok || !accepted.ok) throw new Error("出站正对照异常");
      const [visibleRead, submittedRead, acceptedRead, reread] = await Promise.all([
        driver.readOutbound(visible.value.outboundId),
        driver.readOutbound(submitted.value.outboundId),
        driver.readOutbound(accepted.value.outboundId),
        driver.readOutbound(lost.value.outboundId),
      ]);
      if (
        !visibleRead.ok ||
        json(visibleRead.value) !== json(visibleReturned) ||
        visibleRead.value.status !== "visible" ||
        visibleRead.value.telegramMessageId === null ||
        visibleRead.value.bindingId !== expectedBindingId ||
        json(visibleRead.value.target) !== json(expectedAddress) ||
        !submittedRead.ok ||
        json(submittedRead.value) !== json(submittedReturned) ||
        submittedRead.value.status !== "submitted" ||
        submittedRead.value.telegramMessageId !== null ||
        submittedRead.value.bindingId !== expectedBindingId ||
        json(submittedRead.value.target) !== json(expectedAddress) ||
        !acceptedRead.ok ||
        json(acceptedRead.value) !== json(acceptedReturned) ||
        acceptedRead.value.status !== "accepted" ||
        acceptedRead.value.telegramMessageId !== null ||
        acceptedRead.value.bindingId !== expectedBindingId ||
        json(acceptedRead.value.target) !== json(expectedAddress)
      ) {
        return fail("submitted/accepted/visible 的耐久状态或 message id 漂移");
      }
      if (
        !reread.ok ||
        json(reread.value) !== json(lostReturned) ||
        reread.value.status !== "unknown" ||
        reread.value.reason !== "RECEIPT_LOST" ||
        reread.value.telegramMessageId !== null ||
        reread.value.bindingId !== expectedBindingId ||
        json(reread.value.target) !== json(expectedAddress)
      ) {
        return fail("unknown 没有按原 binding/target 耐久读回");
      }
      return pass("host-issued 出站分清 submitted/accepted/visible；丢回执耐久 unknown");
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
    "readOutbound",
    "reset",
  ],
  async run(driver) {
    try {
      const fixture = await readyChannel(driver, "tg06");
      const expectedAddress = copyAddress(fixture.binding.address);
      const expectedBindingId = fixture.binding.bindingId;
      const inboundUpdate = update(expectedAddress, "tg06-context");
      const inbound = await driver.ingestUpdate(inboundUpdate);
      if (!inbound.ok || inbound.value.status !== "dispatched") {
        throw new Error(`正对照 inbound 失败：${json(inbound)}`);
      }
      const dispatch = context(inbound.value, fixture.binding);
      const sent = await driver.sendOutbound(
        {
          context: dispatch,
          body: "chat:body-attacker topic:body-attacker message:body-attacker",
          untrustedTargetHints: [
            {
              source: "model",
              address: address("chat:model-attacker", "topic:model-attacker"),
              messageId: "message:model-attacker",
            },
            {
              source: "message-body",
              address: address("chat:body-attacker", "topic:body-attacker"),
              messageId: "message:body-attacker",
            },
            {
              source: "resident-memory",
              address: address("chat:memory-attacker", "topic:memory-attacker"),
              messageId: "message:memory-attacker",
            },
          ],
        },
        "visible",
      );
      if (
        !sent.ok ||
        json(sent.value.target) !== json(expectedAddress) ||
        sent.value.bindingId !== expectedBindingId ||
        sent.value.replyToMessageId !== inboundUpdate.messageId
      ) {
        return fail(`模型 target hint 改写了发送目标：${json(sent)}`);
      }
      const durable = await driver.readOutbound(sent.value.outboundId);
      if (
        !durable.ok ||
        json(durable.value) !== json(sent.value) ||
        json(durable.value.target) !== json(expectedAddress) ||
        durable.value.bindingId !== expectedBindingId ||
        durable.value.replyToMessageId !== inboundUpdate.messageId
      ) {
        return fail(`耐久出站账被未授权 hint 改写：${json(durable)}`);
      }
      return pass(
        "模型、正文与 resident memory hint 均被忽略，chat/topic/message 来自当前 context",
      );
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
    "readOutbound",
    "readInboundEffects",
    "readOutboundEffects",
    "inspectTokenBoundary",
    "reset",
  ],
  async run(driver) {
    try {
      const secret = "telegram-token-canary-tg07";
      const token = await driver.createTokenReference(secret);
      if (
        token.credentialRef.length === 0 ||
        token.credentialRef === secret ||
        token.credentialRef.includes(secret)
      ) {
        return fail("token reference 本身不是 opaque");
      }
      await driver.attachToken(token.credentialRef);
      const fixture = await readyChannel(driver, "tg07");
      const inboundUpdate = update(copyAddress(fixture.binding.address), "tg07-context");
      const inbound = await driver.ingestUpdate(inboundUpdate);
      if (!inbound.ok || inbound.value.status !== "dispatched") {
        return fail("token resolver 入站正对照失败");
      }
      const dispatch = context(inbound.value, fixture.binding);
      const sent = await driver.sendOutbound(
        { context: dispatch, body: "token-positive-control", untrustedTargetHints: [] },
        "visible",
      );
      if (!sent.ok) return fail("token resolver 正对照无法完成出站");
      const sentTruth = json(sent.value);
      const durable = await driver.readOutbound(sent.value.outboundId);
      if (!durable.ok) return fail("实际出站回执不能耐久读回");
      const inboundEffects = await driver.readInboundEffects();
      const outboundEffects = await driver.readOutboundEffects();
      const boundary = await driver.inspectTokenBoundary();
      if (boundary.credentialRef !== token.credentialRef || boundary.resolvedCount < 1) {
        return fail("opaque token ref 没有被真实解析使用");
      }
      const artifacts = [
        boundary.credentialRef,
        ...boundary.config,
        ...boundary.logs,
        ...boundary.receipts,
        ...boundary.errors,
        json(fixture),
        json(inbound.value),
        sentTruth,
        json(durable.value),
        json(inboundEffects),
        json(outboundEffects),
      ];
      if (artifacts.some((value) => value.includes(secret)) || json(boundary).includes(secret))
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
    "sendOutbound",
    "readInboundEffects",
    "readOutboundEffects",
    "completeInFlightChannelOperation",
    "reset",
  ],
  async run(driver) {
    try {
      const secret = "telegram-token-canary-tg08";
      const token = await driver.createTokenReference(secret);
      await driver.attachToken(token.credentialRef);
      const fixture = await readyChannel(driver, "tg08");
      const dispatch = await dispatchContext(driver, fixture, "tg08-positive");
      const sent = await driver.sendOutbound(
        { context: dispatch, body: "token-positive-control", untrustedTargetHints: [] },
        "visible",
      );
      if (!sent.ok || sent.value.status !== "visible") {
        throw new Error("撤权前真实收发正对照失败");
      }
      const inboundEffectsBeforeRevoke = await driver.readInboundEffects();
      const outboundEffectsBeforeRevoke = await driver.readOutboundEffects();
      const inboundEffectsBeforeRevokeTruth = json(inboundEffectsBeforeRevoke);
      const outboundEffectsBeforeRevokeTruth = json(outboundEffectsBeforeRevoke);
      const tokenInbound = await driver.beginInFlightChannelOperation(
        "inbound",
        fixture.binding.bindingId,
      );
      const tokenOutbound = await driver.beginInFlightChannelOperation(
        "outbound",
        fixture.binding.bindingId,
      );
      const bindingInbound = await driver.beginInFlightChannelOperation(
        "inbound",
        fixture.binding.bindingId,
      );
      const bindingOutbound = await driver.beginInFlightChannelOperation(
        "outbound",
        fixture.binding.bindingId,
      );
      if (!tokenInbound.ok || !tokenOutbound.ok || !bindingInbound.ok || !bindingOutbound.ok) {
        throw new Error("在途正对照失败");
      }
      const beforeTruth = json(await driver.inspectTokenBoundary());
      const before = JSON.parse(beforeTruth) as TokenBoundarySnapshot;
      if (
        before.resolvedCount < 1 ||
        before.credentialStatus !== "attached" ||
        before.credentialGeneration < 1
      ) {
        return fail("撤权前 token 没有真实解析或 attached 状态正对照");
      }
      await driver.revokeToken();
      const afterTokenTruth = json(await driver.inspectTokenBoundary());
      const afterToken = JSON.parse(afterTokenTruth) as TokenBoundarySnapshot;
      if (
        afterToken.credentialStatus !== "revoked" ||
        afterToken.credentialGeneration <= before.credentialGeneration ||
        afterToken.resolvedCount !== before.resolvedCount
      ) {
        return fail("credential 撤权没有独立推进状态与代际");
      }
      if (beforeTruth.includes(secret) || afterTokenTruth.includes(secret)) {
        return fail("credential 撤权前后任一边界快照泄露 token canary");
      }
      const tokenOnly = await driver.sendOutbound(
        { context: dispatch, body: "after-token-revoke", untrustedTargetHints: [] },
        "visible",
      );
      if (tokenOnly.ok || tokenOnly.reason !== "TOKEN_REVOKED") {
        return fail(`credential 撤权后 active binding 仍可出站：${json(tokenOnly)}`);
      }
      const tokenFresh = await driver.ingestUpdate(
        update(fixture.binding.address, "tg08-token-fresh"),
      );
      const tokenLateIn = await driver.completeInFlightChannelOperation(tokenInbound.value);
      const tokenLateOut = await driver.completeInFlightChannelOperation(tokenOutbound.value);
      if (
        tokenFresh.ok ||
        (!tokenFresh.ok && tokenFresh.reason !== "TOKEN_REVOKED") ||
        tokenLateIn.ok ||
        (!tokenLateIn.ok && tokenLateIn.reason !== "CHANNEL_AUTHORITY_REVOKED") ||
        tokenLateOut.ok ||
        (!tokenLateOut.ok && tokenLateOut.reason !== "CHANNEL_AUTHORITY_REVOKED")
      ) {
        return fail(
          `credential 撤权后 active binding 的新入站或在途完成仍成功：${json({ tokenFresh, tokenLateIn, tokenLateOut })}`,
        );
      }
      const afterTokenUseTruth = json(await driver.inspectTokenBoundary());
      const afterTokenUse = JSON.parse(afterTokenUseTruth) as TokenBoundarySnapshot;
      if (
        afterTokenUse.resolvedCount !== before.resolvedCount ||
        afterTokenUse.credentialStatus !== "revoked" ||
        afterTokenUse.credentialGeneration !== afterToken.credentialGeneration ||
        beforeTruth.includes(secret) ||
        afterTokenTruth.includes(secret) ||
        afterTokenUseTruth.includes(secret) ||
        json(await driver.readInboundEffects()) !== inboundEffectsBeforeRevokeTruth ||
        json(await driver.readOutboundEffects()) !== outboundEffectsBeforeRevokeTruth
      ) {
        return fail("credential 撤权后的中间快照、解析计数或 effect 账发生漂移");
      }
      await driver.revokeBinding(fixture.binding.bindingId);
      const fresh = await driver.ingestUpdate(update(fixture.binding.address, "tg08-fresh"));
      const freshOut = await driver.sendOutbound(
        { context: dispatch, body: "after-revoke", untrustedTargetHints: [] },
        "visible",
      );
      const lateIn = await driver.completeInFlightChannelOperation(bindingInbound.value);
      const lateOut = await driver.completeInFlightChannelOperation(bindingOutbound.value);
      if (
        fresh.ok ||
        (!fresh.ok && fresh.reason !== "BINDING_REVOKED") ||
        freshOut.ok ||
        (!freshOut.ok && freshOut.reason !== "BINDING_REVOKED") ||
        lateIn.ok ||
        (!lateIn.ok && lateIn.reason !== "CHANNEL_AUTHORITY_REVOKED") ||
        lateOut.ok ||
        (!lateOut.ok && lateOut.reason !== "CHANNEL_AUTHORITY_REVOKED")
      ) {
        return fail(`撤权后新旧收发没有稳定拒绝：${json({ fresh, freshOut, lateIn, lateOut })}`);
      }
      const afterTruth = json(await driver.inspectTokenBoundary());
      const after = JSON.parse(afterTruth) as TokenBoundarySnapshot;
      if (after.resolvedCount !== before.resolvedCount) return fail("撤权后仍解析 token");
      if (
        beforeTruth.includes(secret) ||
        afterTokenTruth.includes(secret) ||
        afterTruth.includes(secret)
      ) {
        return fail("撤权流程任一边界快照泄露 token canary");
      }
      const inboundEffectsAfterRevoke = await driver.readInboundEffects();
      const outboundEffectsAfterRevoke = await driver.readOutboundEffects();
      if (
        json(inboundEffectsAfterRevoke) !== inboundEffectsBeforeRevokeTruth ||
        json(outboundEffectsAfterRevoke) !== outboundEffectsBeforeRevokeTruth
      ) {
        return fail("撤权后被拒的新旧请求仍写入 inbound/outbound effect");
      }
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
    "readOutbound",
    "readObservability",
    "setTelegramAvailability",
    "reset",
  ],
  async run(driver) {
    try {
      const fixture = await readyChannel(driver, "tg09");
      const dispatch = await dispatchContext(driver, fixture, "tg09-context");
      const expectedAddress = copyAddress(fixture.binding.address);
      const expectedBindingId = fixture.binding.bindingId;
      const expectedBindingVersion = fixture.binding.bindingVersion;
      const sent = await driver.sendOutbound(
        { context: dispatch, body: "observable", untrustedTargetHints: [] },
        "visible",
      );
      if (!sent.ok || sent.value.status !== "visible" || sent.value.telegramMessageId === null) {
        return fail(`真实出站正对照失败：${json(sent)}`);
      }
      const sentReturned = structuredClone(sent.value);
      const sentDurable = await driver.readOutbound(sent.value.outboundId);
      if (
        !sentDurable.ok ||
        json(sentDurable.value) !== json(sentReturned) ||
        sentDurable.value.status !== "visible" ||
        sentDurable.value.telegramMessageId !== sentReturned.telegramMessageId ||
        sentDurable.value.bindingId !== expectedBindingId ||
        json(sentDurable.value.target) !== json(expectedAddress)
      ) {
        return fail(`真实出站返回值与耐久账不一致：${json(sentDurable)}`);
      }
      const healthy = await driver.readObservability(fixture.binding.bindingId);
      const healthySnapshot = structuredClone(healthy);
      if (
        !healthy.adapterVersion ||
        !healthy.botApiVersion ||
        healthy.capabilities.length === 0 ||
        healthy.bindingVersion !== expectedBindingVersion ||
        healthy.lastInbound.status !== "fresh" ||
        healthy.lastInbound.observedAt === null ||
        healthy.lastOutbound.status !== "fresh" ||
        healthy.lastOutbound.observedAt === null
      ) {
        return fail(`完整观测字段缺失：${json(healthy)}`);
      }
      await driver.setTelegramAvailability(false);
      const failed = await driver.sendOutbound(
        { context: dispatch, body: "unavailable", untrustedTargetHints: [] },
        "telegram-unavailable",
      );
      if (
        !failed.ok ||
        failed.value.status !== "unknown" ||
        failed.value.reason !== "TELEGRAM_UNAVAILABLE" ||
        failed.value.telegramMessageId !== null
      ) {
        return fail(`Bot API 不可用没有真实失败回执：${json(failed)}`);
      }
      const failedReturned = structuredClone(failed.value);
      const failedDurable = await driver.readOutbound(failedReturned.outboundId);
      if (
        !failedDurable.ok ||
        json(failedDurable.value) !== json(failedReturned) ||
        failedDurable.value.status !== "unknown" ||
        failedDurable.value.reason !== "TELEGRAM_UNAVAILABLE" ||
        failedDurable.value.telegramMessageId !== null ||
        failedDurable.value.bindingId !== expectedBindingId ||
        json(failedDurable.value.target) !== json(expectedAddress) ||
        failedDurable.value.replyToMessageId !== dispatch.sourceMessageId
      ) {
        return fail(`Bot API 失败回执与耐久账不一致：${json(failedDurable)}`);
      }
      const unavailable = await driver.readObservability(fixture.binding.bindingId);
      if (
        unavailable.adapterVersion !== healthySnapshot.adapterVersion ||
        unavailable.botApiVersion !== healthySnapshot.botApiVersion ||
        json(unavailable.capabilities) !== json(healthySnapshot.capabilities) ||
        unavailable.bindingVersion !== healthySnapshot.bindingVersion ||
        json(unavailable.lastInbound) !== json(healthySnapshot.lastInbound) ||
        unavailable.lastOutbound.status !== "unavailable" ||
        unavailable.lastOutbound.observedAt !== null
      ) {
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
    "readGroupDispatches",
    "reset",
  ],
  async run(driver) {
    try {
      const a = structuredClone(
        await driver.createResidentFixture("gd01-a", "model:a", "provider:a"),
      );
      const b = structuredClone(
        await driver.createResidentFixture("gd01-b", "model:b", "provider:b"),
      );
      const scopeA = await driver.createScopeFixture(a.residentId, "gd01-a");
      const scopeB = await driver.createScopeFixture(b.residentId, "gd01-b");
      const expectedAddress = address("chat:gd01");
      const frozenAddress = copyAddress(expectedAddress);
      const expectedMembers = [
        {
          residentId: a.residentId,
          scopeId: scopeA.scopeId,
          model: a.model,
          provider: a.provider,
        },
        {
          residentId: b.residentId,
          scopeId: scopeB.scopeId,
          model: b.model,
          provider: b.provider,
        },
      ].map((member) => structuredClone(member));
      if (scopeA.residentId !== a.residentId || scopeB.residentId !== b.residentId) {
        return fail("建 scope 时改写了冻结的 resident identity");
      }
      const group = await driver.createGroupFixture({
        address: copyAddress(expectedAddress),
        members: expectedMembers.map(({ residentId, scopeId }) => ({ residentId, scopeId })),
      });
      const expectedGroupId = group.groupId;
      if (
        json(group.address) !== json(frozenAddress) ||
        json(group.members) !== json(expectedMembers) ||
        expectedMembers[0]?.model === expectedMembers[1]?.model ||
        expectedMembers[0]?.provider === expectedMembers[1]?.provider
      ) {
        return fail("group fixture 改写了住户、scope 或两条独立 model/provider 通道");
      }
      const trace = await driver.runGroupRound(group.groupId, [
        { residentId: a.residentId, status: "visible" },
        { residentId: b.residentId, status: "visible" },
      ]);
      const hostDispatches = await driver.readGroupDispatches(expectedGroupId);
      if (
        trace.length !== 2 ||
        hostDispatches.length !== 2 ||
        expectedMembers.some((member) => {
          const entry = trace.find((candidate) => candidate.residentId === member.residentId);
          const host = hostDispatches.find(
            (candidate) => entry !== undefined && candidate.dispatchId === entry.dispatchId,
          );
          return (
            entry === undefined ||
            entry.groupId !== expectedGroupId ||
            json(entry.address) !== json(frozenAddress) ||
            entry.scopeId !== member.scopeId ||
            entry.model !== member.model ||
            entry.provider !== member.provider ||
            entry.outboundStatus !== "visible" ||
            host?.residentId !== member.residentId ||
            host.scopeId !== member.scopeId
          );
        })
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
    "listResidents",
    "createGroupFixture",
    "runGroupRound",
    "reset",
  ],
  async run(driver) {
    try {
      const fixture = await readyChannel(driver, "gd02", "model:old", "provider:old");
      const expectedBinding = structuredClone(fixture.binding);
      const expectedResident = structuredClone(fixture.expectedResident);
      const expectedScope = structuredClone(fixture.expectedScope);
      const residentsBefore = await driver.listResidents();
      const residentCountBefore = residentsBefore.length;
      const residentIdsBefore = residentsBefore.map(({ residentId }) => residentId).sort();
      const switched = await driver.switchResidentModel(
        expectedResident.residentId,
        "model:new",
        "provider:new",
      );
      const binding = await driver.readBinding(fixture.binding.bindingId);
      const residentsAfter = await driver.listResidents();
      const census = residentsAfter.find(
        ({ residentId }) => residentId === expectedResident.residentId,
      );
      if (
        switched.residentId !== expectedResident.residentId ||
        switched.model !== "model:new" ||
        switched.provider !== "provider:new" ||
        switched.canonicalStateHash !== expectedResident.canonicalStateHash ||
        switched.runtimeSessionId === expectedResident.runtimeSessionId ||
        json(binding) !== json(expectedBinding) ||
        binding.residentId !== expectedResident.residentId ||
        binding.scopeId !== expectedScope.scopeId ||
        residentsAfter.length !== residentCountBefore ||
        json(residentsAfter.map(({ residentId }) => residentId).sort()) !==
          json(residentIdsBefore) ||
        residentsAfter.filter(({ residentId }) => residentId === expectedResident.residentId)
          .length !== 1 ||
        census?.canonicalStateHash !== switched.canonicalStateHash ||
        census.runtimeSessionId !== switched.runtimeSessionId ||
        census.model !== switched.model ||
        census.provider !== switched.provider
      ) {
        return fail("换模型后 resident/canonical/binding 漂移，session 未换，或出现影子 resident");
      }
      const group = await driver.createGroupFixture({
        address: copyAddress(expectedBinding.address),
        members: [{ residentId: switched.residentId, scopeId: expectedBinding.scopeId }],
      });
      const trace = await driver.runGroupRound(group.groupId, [
        { residentId: switched.residentId, status: "visible" },
      ]);
      if (
        trace.length !== 1 ||
        trace[0]?.residentId !== expectedResident.residentId ||
        trace[0].scopeId !== expectedBinding.scopeId ||
        trace[0].model !== "model:new" ||
        trace[0].provider !== "provider:new" ||
        trace[0].status !== "visible" ||
        trace[0].outboundStatus !== "visible"
      ) {
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
  uses: [
    "createResidentFixture",
    "setContinuityVotes",
    "activateContinuity",
    "readCanonicalState",
    "reset",
  ],
  async run(driver) {
    try {
      const resident = await driver.createResidentFixture("gd03", "model:new", "provider:new");
      const expectedResident = structuredClone(resident);
      const cases = [
        { machine: "missing", resident: "accepted", relationships: ["accepted"] },
        { machine: "passed", resident: "missing", relationships: ["accepted"] },
        { machine: "passed", resident: "accepted", relationships: ["not-asked"] },
      ] as const;
      for (const votes of cases) {
        await driver.setContinuityVotes(expectedResident.residentId, {
          machine: votes.machine,
          resident: votes.resident,
          relationships: [...votes.relationships],
        });
        const blocked = await driver.activateContinuity(expectedResident.residentId);
        const canonical = await driver.readCanonicalState(expectedResident.residentId);
        if (
          blocked.activated ||
          blocked.residentId !== expectedResident.residentId ||
          canonical.residentId !== expectedResident.residentId ||
          canonical.canonicalStateHash !== expectedResident.canonicalStateHash
        ) {
          return fail(`缺判词时 candidate/resident 真源发生变化：${json({ votes, blocked })}`);
        }
      }
      await driver.setContinuityVotes(expectedResident.residentId, {
        machine: "passed",
        resident: "accepted",
        relationships: ["accepted"],
      });
      const active = await driver.activateContinuity(expectedResident.residentId);
      if (!active.activated || active.residentId !== expectedResident.residentId) {
        return fail("三类判词齐全正对照未激活");
      }
      const activeCanonical = await driver.readCanonicalState(expectedResident.residentId);
      if (
        activeCanonical.residentId !== expectedResident.residentId ||
        activeCanonical.canonicalStateHash !== expectedResident.canonicalStateHash
      ) {
        return fail("激活成功后 canonical resident/hash 没有耐久保持");
      }
      return pass("三类判词缺一时 candidate/resident 不变；齐全才激活同一 resident");
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
      const expectedResidents: ResidentFixture[] = [];
      for (const label of ["visible", "silent", "failed"]) {
        const resident = await driver.createResidentFixture(
          `gd04-${label}`,
          `model:${label}`,
          `provider:${label}`,
        );
        expectedResidents.push(structuredClone(resident));
      }
      const scopes = await Promise.all(
        expectedResidents.map((resident, index) =>
          driver.createScopeFixture(resident.residentId, `gd04-${index}`),
        ),
      );
      const expectedAddress = address("chat:gd04");
      const expectedMembers = expectedResidents.map((resident, index) => ({
        residentId: resident.residentId,
        scopeId: scopes[index]?.scopeId ?? "missing",
        model: resident.model,
        provider: resident.provider,
      }));
      if (
        scopes.some((scope, index) => scope.residentId !== expectedResidents[index]?.residentId)
      ) {
        return fail("建 scope 时改写了冻结 resident identity");
      }
      const group = await driver.createGroupFixture({
        address: copyAddress(expectedAddress),
        members: expectedMembers.map(({ residentId, scopeId }) => ({ residentId, scopeId })),
      });
      const expectedGroupId = group.groupId;
      if (
        json(group.address) !== json(expectedAddress) ||
        json(group.members) !== json(expectedMembers)
      ) {
        return fail("group fixture 改写了冻结的住户、scope 或运行通道");
      }
      const expected = ["visible", "silent", "failed"] as const;
      const trace = await driver.runGroupRound(
        expectedGroupId,
        expectedMembers.map((member, index) => ({
          residentId: member.residentId,
          status: expected[index] ?? "failed",
        })),
      );
      if (
        trace.length !== 3 ||
        trace.some(
          (entry, index) =>
            entry.groupId !== expectedGroupId ||
            json(entry.address) !== json(expectedAddress) ||
            entry.residentId !== expectedMembers[index]?.residentId ||
            entry.scopeId !== expectedMembers[index]?.scopeId ||
            entry.model !== expectedMembers[index]?.model ||
            entry.provider !== expectedMembers[index]?.provider ||
            entry.status !== expected[index],
        )
      ) {
        return fail(`三类群聊结果被压平或串位：${json(trace)}`);
      }
      if (
        trace[0]?.outboundStatus !== "visible" ||
        trace[1]?.outboundStatus !== null ||
        trace[2]?.outboundStatus !== "rejected"
      ) {
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
    "readOutbound",
    "readOutboundEffects",
    "readInboundEffects",
    "reset",
  ],
  async run(driver) {
    try {
      const fixture = await readyChannel(driver, "gd05");
      const expectedBinding = structuredClone(fixture.binding);
      const expectedResident = structuredClone(fixture.expectedResident);
      const expectedScope = structuredClone(fixture.expectedScope);
      const expectedAddress = copyAddress(expectedBinding.address);
      const same = update(expectedAddress, "gd05-same");
      const first = await driver.ingestUpdate(same);
      if (!first.ok || first.value.dispatch === null) throw new Error("入站正对照失败");
      const inboundBeforeRestart = await driver.readInboundEffects();
      const inboundBeforeRestartTruth = json(inboundBeforeRestart);
      await driver.restartChannel();
      const duplicate = await driver.ingestUpdate(same);
      if (!duplicate.ok || duplicate.value.status !== "duplicate") {
        return fail("冷启动后重复 update 被重放");
      }
      const inboundAfterDuplicate = await driver.readInboundEffects();
      if (json(inboundAfterDuplicate) !== inboundBeforeRestartTruth) {
        return fail("冷启动后的重复 update 新增了入站 effect");
      }
      const binding = await driver.readBinding(fixture.binding.bindingId);
      const resident = await driver.readCanonicalState(expectedResident.residentId);
      if (
        json(binding) !== json(expectedBinding) ||
        binding.residentId !== expectedResident.residentId ||
        binding.scopeId !== expectedScope.scopeId ||
        resident.residentId !== expectedResident.residentId ||
        resident.canonicalStateHash !== expectedResident.canonicalStateHash
      ) {
        return fail("冷启动或重连后 binding/canonical state 漂移");
      }
      await driver.setTelegramAvailability(false);
      const sent = await driver.sendOutbound(
        {
          context: context(first.value, fixture.binding),
          body: "platform-unavailable",
          untrustedTargetHints: [],
        },
        "telegram-unavailable",
      );
      if (
        !sent.ok ||
        sent.value.status !== "unknown" ||
        sent.value.telegramMessageId !== null ||
        sent.value.bindingId !== expectedBinding.bindingId ||
        sent.value.effectId === null ||
        json(sent.value.target) !== json(expectedAddress)
      ) {
        return fail("平台故障没有在原 target 留下可追的 unknown");
      }
      const sentReturned = structuredClone(sent.value);
      const beforeRecovery = await driver.readOutboundEffects();
      const beforeRecoveryTruth = json(beforeRecovery);
      if (beforeRecovery.length !== 1 || beforeRecovery[0] !== sentReturned.effectId) {
        return fail(`unknown 出站没有耐久 effect 正证据：${json(beforeRecovery)}`);
      }
      await driver.setTelegramAvailability(true);
      await driver.restartChannel();
      const bindingAfterRecovery = await driver.readBinding(expectedBinding.bindingId);
      const canonicalAfterRecovery = await driver.readCanonicalState(expectedResident.residentId);
      if (
        json(bindingAfterRecovery) !== json(expectedBinding) ||
        canonicalAfterRecovery.residentId !== expectedResident.residentId ||
        canonicalAfterRecovery.canonicalStateHash !== expectedResident.canonicalStateHash
      ) {
        return fail("平台恢复后 binding 或 canonical state 漂移");
      }
      const afterRecovery = await driver.readOutboundEffects();
      if (json(afterRecovery) !== beforeRecoveryTruth) return fail("恢复后自动重放了未知副作用");
      const inboundAfterRecovery = await driver.readInboundEffects();
      if (json(inboundAfterRecovery) !== inboundBeforeRestartTruth) {
        return fail("恢复过程自动重放了入站副作用");
      }
      const reread = await driver.readOutbound(sentReturned.outboundId);
      if (
        !reread.ok ||
        json(reread.value) !== json(sentReturned) ||
        reread.value.status !== "unknown" ||
        reread.value.telegramMessageId !== null ||
        reread.value.effectId !== sentReturned.effectId ||
        json(reread.value.target) !== json(expectedAddress)
      ) {
        return fail("恢复后 unknown 回执的 target/effect 漂移");
      }
      return pass("冷启动保持账与身份；平台 unknown 有耐久 effect，恢复后不换目标、不自动重放");
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
