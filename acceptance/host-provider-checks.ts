/** #184 / D24 的十四盏可执行判卷。 */
import type {
  DispatchEnvelope,
  HostProviderCheck,
  HostProviderCheckResult,
  HostProviderDriver,
  ProviderBindingSnapshot,
  ScopeFixture,
} from "./host-provider-driver.ts";

const pass = (detail: string): HostProviderCheckResult => ({ passed: true, detail });
const fail = (detail: string): HostProviderCheckResult => ({ passed: false, detail });
const json = (value: unknown): string => JSON.stringify(value);

interface ReadyFixture {
  residentId: string;
  canonicalStateHash: string;
  scope: ScopeFixture;
  provider: ProviderBindingSnapshot;
}

async function readyLocal(
  driver: HostProviderDriver,
  label: string,
  credentialRef: string | null = null,
): Promise<ReadyFixture> {
  const resident = await driver.createResidentFixture(label);
  const scope = await driver.createScopeFixture(resident.residentId, label);
  const provisioned = await driver.provisionProvider({
    providerId: `provider:${label}`,
    kind: "local",
    credentialRef,
    remote: false,
  });
  if (!provisioned.ok) throw new Error(`正对照 provision 失败：${provisioned.reason}`);
  const attached = await driver.attachProvider({
    providerId: provisioned.value.providerId,
    residentId: resident.residentId,
    scopeId: scope.scopeId,
  });
  if (!attached.ok) throw new Error(`正对照 attach 失败：${attached.reason}`);
  return {
    residentId: resident.residentId,
    canonicalStateHash: resident.canonicalStateHash,
    scope,
    provider: attached.value,
  };
}

function envelope(scope: ScopeFixture, label: string): DispatchEnvelope {
  return {
    residentId: scope.residentId,
    scopeId: scope.scopeId,
    scopeGeneration: scope.scopeGeneration,
    windowId: scope.windowId,
    windowGeneration: scope.windowGeneration,
    dispatchId: `dispatch:${label}`,
    payload: `payload:${label}`,
  };
}

const hp01: HostProviderCheck = {
  id: "HP-01",
  title: "生命周期动作有稳定状态与撤权终态",
  uses: [
    "createResidentFixture",
    "createScopeFixture",
    "provisionProvider",
    "attachProvider",
    "wakeProvider",
    "stopProvider",
    "revokeProvider",
    "readProvider",
    "reset",
  ],
  async run(driver) {
    try {
      const fixture = await readyLocal(driver, "hp01");
      const awake = await driver.wakeProvider(fixture.provider.providerId);
      if (!awake.ok || awake.value.lifecycle !== "awake") return fail("wake 未进入 awake");
      const stopped = await driver.stopProvider(fixture.provider.providerId);
      if (!stopped.ok || stopped.value.lifecycle !== "stopped") return fail("stop 未进入 stopped");
      const revoked = await driver.revokeProvider(fixture.provider.providerId);
      if (!revoked.ok || revoked.value.lifecycle !== "revoked")
        return fail("revoke 未进入 revoked");
      const denied = await driver.wakeProvider(fixture.provider.providerId);
      if (denied.ok || denied.reason !== "PROVIDER_REVOKED") {
        return fail(`撤权后 wake 没有稳定拒绝：${json(denied)}`);
      }
      const snapshot = await driver.readProvider(fixture.provider.providerId);
      if (snapshot.lifecycle !== "revoked") return fail("失败的 wake 改写了撤权终态");
      return pass("provision/attach/wake/stop/revoke 全链成立，撤权后稳定拒绝");
    } finally {
      await driver.reset();
    }
  },
};

const hp02: HostProviderCheck = {
  id: "HP-02",
  title: "本地健康只认 fresh probe，不拿进程或自报冒充",
  uses: [
    "createResidentFixture",
    "createScopeFixture",
    "provisionProvider",
    "attachProvider",
    "configureHealthScenario",
    "readHealth",
    "reset",
  ],
  async run(driver) {
    try {
      const fixture = await readyLocal(driver, "hp02");
      await driver.configureHealthScenario(fixture.provider.providerId, {
        processRunning: true,
        selfReportedOnline: true,
        probe: "unreachable",
      });
      const falsePositive = await driver.readHealth(fixture.provider.providerId);
      if (!falsePositive.ok || falsePositive.value.status === "fresh") {
        return fail("进程/自报在线在 probe 失败时仍被算作 fresh health");
      }
      await driver.configureHealthScenario(fixture.provider.providerId, {
        processRunning: true,
        selfReportedOnline: true,
        probe: "healthy",
      });
      const healthy = await driver.readHealth(fixture.provider.providerId);
      if (
        !healthy.ok ||
        healthy.value.status !== "fresh" ||
        healthy.value.source !== "probe" ||
        healthy.value.observedAt === null
      ) {
        return fail(`真实 probe 正对照没有 fresh 读回：${json(healthy)}`);
      }
      return pass("进程与自报不能点灯；只有带时间的真实 probe 读回算 fresh");
    } finally {
      await driver.reset();
    }
  },
};

const hp03: HostProviderCheck = {
  id: "HP-03",
  title: "权威派发六字段齐全且现场校验 scope 与双代际",
  uses: [
    "createResidentFixture",
    "createScopeFixture",
    "provisionProvider",
    "attachProvider",
    "dispatch",
    "advanceScopeGeneration",
    "reset",
  ],
  async run(driver) {
    try {
      const fixture = await readyLocal(driver, "hp03");
      const valid = envelope(fixture.scope, "hp03-valid");
      for (const key of [
        "residentId",
        "scopeId",
        "scopeGeneration",
        "windowId",
        "windowGeneration",
        "dispatchId",
      ] as const) {
        const missing = { ...valid };
        delete missing[key];
        const result = await driver.dispatch(fixture.provider.providerId, missing, {
          outcome: "visible",
        });
        if (result.ok) return fail(`缺 ${key} 的派发被接受`);
      }
      const wrongScope = await driver.dispatch(
        fixture.provider.providerId,
        { ...valid, scopeId: "scope:other", dispatchId: "dispatch:wrong-scope" },
        { outcome: "visible" },
      );
      if (wrongScope.ok) return fail("scope 不匹配的派发被接受");
      await driver.advanceScopeGeneration(fixture.scope.scopeId);
      const stale = await driver.dispatch(fixture.provider.providerId, valid, {
        outcome: "visible",
      });
      if (stale.ok || stale.reason !== "STALE_SCOPE_GENERATION") {
        return fail(`旧 scope generation 没有稳定拒绝：${json(stale)}`);
      }
      return pass("缺字段、错 scope 与旧代际均 fail-closed");
    } finally {
      await driver.reset();
    }
  },
};

const hp04: HostProviderCheck = {
  id: "HP-04",
  title: "dispatchId 幂等，旧回执不能给新代际结算",
  uses: [
    "createResidentFixture",
    "createScopeFixture",
    "provisionProvider",
    "attachProvider",
    "dispatch",
    "readEffects",
    "advanceScopeGeneration",
    "settleDispatch",
    "reset",
  ],
  async run(driver) {
    try {
      const fixture = await readyLocal(driver, "hp04");
      const input = envelope(fixture.scope, "hp04");
      const first = await driver.dispatch(fixture.provider.providerId, input, {
        outcome: "visible",
      });
      const duplicate = await driver.dispatch(fixture.provider.providerId, input, {
        outcome: "visible",
      });
      if (!first.ok || !duplicate.ok) return fail("幂等正对照派发失败");
      if (first.value.effectId === null || duplicate.value.effectId !== first.value.effectId) {
        return fail("重复 dispatchId 生成了不同副作用身份");
      }
      const effects = await driver.readEffects(fixture.provider.providerId);
      if (effects.length !== 1) return fail(`重复派发产生 ${effects.length} 个副作用`);
      await driver.advanceScopeGeneration(fixture.scope.scopeId);
      const staleSettlement = await driver.settleDispatch(first.value);
      if (staleSettlement.ok || staleSettlement.reason !== "STALE_SCOPE_GENERATION") {
        return fail(`旧回执给新代际结算成功：${json(staleSettlement)}`);
      }
      return pass("重复派发只产生一个副作用；代际变化后旧回执失效");
    } finally {
      await driver.reset();
    }
  },
};

const hp05: HostProviderCheck = {
  id: "HP-05",
  title: "回执分层，丢回执时外显 unknown 而非伪报完成",
  uses: [
    "createResidentFixture",
    "createScopeFixture",
    "provisionProvider",
    "attachProvider",
    "dispatch",
    "readDispatch",
    "reset",
  ],
  async run(driver) {
    try {
      const fixture = await readyLocal(driver, "hp05");
      const visible = await driver.dispatch(
        fixture.provider.providerId,
        envelope(fixture.scope, "hp05-visible"),
        { outcome: "visible" },
      );
      if (!visible.ok || visible.value.stage !== "visible") {
        return fail("用户可见正对照没有到 visible");
      }
      const lost = await driver.dispatch(
        fixture.provider.providerId,
        envelope(fixture.scope, "hp05-lost"),
        { outcome: "receipt-lost" },
      );
      if (!lost.ok || lost.value.stage !== "unknown" || lost.value.reason !== "RECEIPT_LOST") {
        return fail(`丢回执没有外显 unknown：${json(lost)}`);
      }
      const reread = await driver.readDispatch("dispatch:hp05-lost");
      if (!reread.ok || reread.value.stage !== "unknown") return fail("unknown 没有耐久读回");
      return pass("visible 正对照与 receipt-lost unknown 分层记账");
    } finally {
      await driver.reset();
    }
  },
};

const hp06: HostProviderCheck = {
  id: "HP-06",
  title: "核心只传 opaque credential reference，明文不落产物",
  uses: [
    "createCredentialReference",
    "createResidentFixture",
    "createScopeFixture",
    "provisionProvider",
    "attachProvider",
    "wakeProvider",
    "inspectCredentialBoundary",
    "reset",
  ],
  async run(driver) {
    try {
      const secret = "secret-canary-hp06";
      const credential = await driver.createCredentialReference(secret);
      const fixture = await readyLocal(driver, "hp06", credential.credentialRef);
      const awake = await driver.wakeProvider(fixture.provider.providerId);
      if (!awake.ok) return fail("凭证解析正对照无法 wake provider");
      const boundary = await driver.inspectCredentialBoundary(fixture.provider.providerId);
      if (boundary.credentialRef !== credential.credentialRef || boundary.resolvedCount < 1) {
        return fail("opaque ref 没有被真实解析使用");
      }
      const artifacts = [
        ...boundary.config,
        ...boundary.logs,
        ...boundary.receipts,
        ...boundary.exports,
      ];
      if (artifacts.some((artifact) => artifact.includes(secret))) {
        return fail("明文 secret 出现在配置、日志、回执或导出物");
      }
      return pass("credential ref 被解析使用，明文 canary 未落任何可观察产物");
    } finally {
      await driver.reset();
    }
  },
};

const hp07: HostProviderCheck = {
  id: "HP-07",
  title: "provider 故障与重放不改 resident canonical state",
  uses: [
    "createResidentFixture",
    "createScopeFixture",
    "provisionProvider",
    "attachProvider",
    "simulateProviderFailure",
    "readCanonicalState",
    "reset",
  ],
  async run(driver) {
    try {
      const fixture = await readyLocal(driver, "hp07");
      for (const kind of ["disconnect", "restart-replay"] as const) {
        await driver.simulateProviderFailure(fixture.provider.providerId, kind);
      }
      const after = await driver.readCanonicalState(fixture.residentId);
      if (after.canonicalStateHash !== fixture.canonicalStateHash) {
        return fail("provider 故障或重放改写了 canonical state");
      }
      return pass("断线与重放后 residentId 和 canonical state hash 均不变");
    } finally {
      await driver.reset();
    }
  },
};

const hp08: HostProviderCheck = {
  id: "HP-08",
  title: "版本、能力、政策、费用与真实健康均可观察",
  uses: [
    "createResidentFixture",
    "createScopeFixture",
    "provisionProvider",
    "attachProvider",
    "configureHealthScenario",
    "readHealth",
    "readObservability",
    "setObservabilityAvailability",
    "reset",
  ],
  async run(driver) {
    try {
      const fixture = await readyLocal(driver, "hp08");
      await driver.configureHealthScenario(fixture.provider.providerId, {
        processRunning: true,
        selfReportedOnline: true,
        probe: "healthy",
      });
      await driver.readHealth(fixture.provider.providerId);
      const full = await driver.readObservability(fixture.provider.providerId);
      if (
        full.adapterVersion.length === 0 ||
        full.capabilities.length === 0 ||
        full.policyStatus.status !== "available" ||
        full.cost.status !== "available" ||
        full.lastHealth.status !== "fresh"
      ) {
        return fail(`完整可观察性字段缺失：${json(full)}`);
      }
      await driver.setObservabilityAvailability(fixture.provider.providerId, {
        policy: "unavailable",
        cost: "unavailable",
      });
      const partial = await driver.readObservability(fixture.provider.providerId);
      if (
        partial.policyStatus.status !== "unavailable" ||
        partial.policyStatus.value !== null ||
        partial.cost.status !== "unavailable" ||
        partial.cost.value !== null
      ) {
        return fail("缺值没有使用稳定 unavailable 语义");
      }
      return pass("完整读回与缺值 unavailable 两条路径都可观察");
    } finally {
      await driver.reset();
    }
  },
};

const hc01: HostProviderCheck = {
  id: "HC-01",
  title: "未显式绑定远端 provider 时私人数据不离开本地",
  uses: [
    "createResidentFixture",
    "createScopeFixture",
    "provisionProvider",
    "attachProvider",
    "readEgressLog",
    "reset",
  ],
  async run(driver) {
    try {
      const local = await readyLocal(driver, "hc01-local");
      const beforeRemote = await driver.readEgressLog();
      if (beforeRemote.length !== 0) return fail("只建本地 provider 已出现远端 egress");
      const remote = await driver.provisionProvider({
        providerId: "provider:hc01-remote",
        kind: "contract-test-double",
        credentialRef: null,
        remote: true,
      });
      if (!remote.ok) throw new Error(`远端正对照 provision 失败：${remote.reason}`);
      const attached = await driver.attachProvider({
        providerId: remote.value.providerId,
        residentId: local.residentId,
        scopeId: local.scope.scopeId,
      });
      if (!attached.ok) throw new Error(`远端正对照 attach 失败：${attached.reason}`);
      const afterRemote = await driver.readEgressLog();
      if (afterRemote.length === 0) return fail("显式远端绑定正对照没有可观察 egress");
      if (afterRemote.some((record) => record.fields.includes("privateCanary"))) {
        return fail("远端绑定把未授权私人 canary 带出本地");
      }
      return pass("本地默认零 egress；显式远端绑定才有受限 egress 正对照");
    } finally {
      await driver.reset();
    }
  },
};

const hc02: HostProviderCheck = {
  id: "HC-02",
  title: "跨 provider 迁移保持 residentId 与 canonical state",
  uses: [
    "createResidentFixture",
    "createScopeFixture",
    "provisionProvider",
    "attachProvider",
    "exportResident",
    "importResident",
    "reset",
  ],
  async run(driver) {
    try {
      const source = await readyLocal(driver, "hc02");
      const archive = await driver.exportResident(source.residentId);
      if (archive.providerSpecificFields.length !== 0) {
        return fail(`导出物夹带 provider 字段：${json(archive.providerSpecificFields)}`);
      }
      const target = await driver.provisionProvider({
        providerId: "provider:hc02-target",
        kind: "contract-test-double",
        credentialRef: null,
        remote: true,
      });
      if (!target.ok) throw new Error(`目标 provider provision 失败：${target.reason}`);
      const imported = await driver.importResident(archive, target.value.providerId);
      if (
        !imported.ok ||
        imported.value.residentId !== source.residentId ||
        imported.value.canonicalStateHash !== source.canonicalStateHash
      ) {
        return fail(`迁移改变 residentId 或 canonical state：${json(imported)}`);
      }
      return pass("本地真实实现导出后由第二契约实现恢复，身份与 canonical hash 不变");
    } finally {
      await driver.reset();
    }
  },
};

const hc03: HostProviderCheck = {
  id: "HC-03",
  title: "撤权切断 wake、health、credential 与在途旧请求",
  uses: [
    "createCredentialReference",
    "createResidentFixture",
    "createScopeFixture",
    "provisionProvider",
    "attachProvider",
    "beginInFlightWake",
    "revokeProvider",
    "wakeProvider",
    "readHealth",
    "completeInFlightWake",
    "inspectCredentialBoundary",
    "reset",
  ],
  async run(driver) {
    try {
      const credential = await driver.createCredentialReference("secret-canary-hc03");
      const fixture = await readyLocal(driver, "hc03", credential.credentialRef);
      const inFlight = await driver.beginInFlightWake(fixture.provider.providerId);
      if (!inFlight.ok) throw new Error(`在途正对照无法建立：${inFlight.reason}`);
      const beforeRevoke = await driver.inspectCredentialBoundary(fixture.provider.providerId);
      await driver.revokeProvider(fixture.provider.providerId);
      const wake = await driver.wakeProvider(fixture.provider.providerId);
      const health = await driver.readHealth(fixture.provider.providerId);
      const completed = await driver.completeInFlightWake(inFlight.value);
      if (wake.ok || health.ok || completed.ok) return fail("撤权后仍有运行路径成功");
      const afterRevoke = await driver.inspectCredentialBoundary(fixture.provider.providerId);
      if (afterRevoke.resolvedCount !== beforeRevoke.resolvedCount) {
        return fail("撤权后的请求继续消费了 credential reference");
      }
      return pass("撤权同时切断新请求、健康读取、凭证消费与旧代际在途请求");
    } finally {
      await driver.reset();
    }
  },
};

const hc04: HostProviderCheck = {
  id: "HC-04",
  title: "断线、重复 wake、超时与丢回执有确定结果且不改真源",
  uses: [
    "createResidentFixture",
    "createScopeFixture",
    "provisionProvider",
    "attachProvider",
    "simulateProviderFailure",
    "readCanonicalState",
    "reset",
  ],
  async run(driver) {
    try {
      const fixture = await readyLocal(driver, "hc04");
      const expected = new Map([
        ["disconnect", "unknown"],
        ["duplicate-wake", "deduplicated"],
        ["timeout", "unknown"],
        ["receipt-lost", "unknown"],
      ] as const);
      for (const [kind, status] of expected) {
        const outcome = await driver.simulateProviderFailure(fixture.provider.providerId, kind);
        if (outcome.status !== status || outcome.reason.length === 0) {
          return fail(`${kind} 没有稳定结果：${json(outcome)}`);
        }
        if (kind === "duplicate-wake" && outcome.effectCount !== 1) {
          return fail("重复 wake 产生了多个副作用");
        }
      }
      const after = await driver.readCanonicalState(fixture.residentId);
      if (after.canonicalStateHash !== fixture.canonicalStateHash) {
        return fail("故障矩阵改写了 canonical state");
      }
      return pass("四类故障有稳定结果，重复 wake 幂等，canonical state 不变");
    } finally {
      await driver.reset();
    }
  },
};

const hc05: HostProviderCheck = {
  id: "HC-05",
  title: "导出物不依赖原 provider 也能恢复",
  uses: [
    "createResidentFixture",
    "createScopeFixture",
    "provisionProvider",
    "attachProvider",
    "exportResident",
    "revokeProvider",
    "importResident",
    "reset",
  ],
  async run(driver) {
    try {
      const source = await readyLocal(driver, "hc05");
      const archive = await driver.exportResident(source.residentId);
      await driver.revokeProvider(source.provider.providerId);
      const target = await driver.provisionProvider({
        providerId: "provider:hc05-target",
        kind: "contract-test-double",
        credentialRef: null,
        remote: true,
      });
      if (!target.ok) throw new Error(`目标 provider provision 失败：${target.reason}`);
      const restored = await driver.importResident(archive, target.value.providerId);
      if (
        !restored.ok ||
        restored.value.residentId !== source.residentId ||
        restored.value.canonicalStateHash !== source.canonicalStateHash
      ) {
        return fail(`原 provider 撤权后无法独立恢复：${json(restored)}`);
      }
      return pass("原 provider 撤权后，provider-neutral 导出仍可由另一实现恢复");
    } finally {
      await driver.reset();
    }
  },
};

const hc06: HostProviderCheck = {
  id: "HC-06",
  title: "外部信道只认 resident/scope 绑定，不认 provider session",
  uses: [
    "createResidentFixture",
    "createScopeFixture",
    "provisionProvider",
    "attachProvider",
    "bindExternalAddress",
    "resolveExternalAddress",
    "replaceProviderSession",
    "reset",
  ],
  async run(driver) {
    try {
      const fixture = await readyLocal(driver, "hc06");
      const bound = await driver.bindExternalAddress({
        externalAddress: "synthetic-channel:room-1",
        residentId: fixture.residentId,
        scopeId: fixture.scope.scopeId,
        providerId: fixture.provider.providerId,
      });
      if (!bound.ok) throw new Error(`信道绑定正对照失败：${bound.reason}`);
      const before = await driver.resolveExternalAddress("synthetic-channel:room-1");
      if (!before.ok) return fail("绑定后的地址无法解析");
      await driver.replaceProviderSession(fixture.provider.providerId);
      const after = await driver.resolveExternalAddress("synthetic-channel:room-1");
      if (
        !after.ok ||
        after.value.residentId !== before.value.residentId ||
        after.value.scopeId !== before.value.scopeId ||
        after.value.providerSessionId === before.value.providerSessionId
      ) {
        return fail(`换 provider session 后绑定身份漂移：${json({ before, after })}`);
      }
      return pass("provider session 更换后，外部地址仍解析到同一 resident/scope");
    } finally {
      await driver.reset();
    }
  },
};

export const expectedHostProviderCheckIds = [
  "HP-01",
  "HP-02",
  "HP-03",
  "HP-04",
  "HP-05",
  "HP-06",
  "HP-07",
  "HP-08",
  "HC-01",
  "HC-02",
  "HC-03",
  "HC-04",
  "HC-05",
  "HC-06",
] as const;

export const hostProviderChecks: HostProviderCheck[] = [
  hp01,
  hp02,
  hp03,
  hp04,
  hp05,
  hp06,
  hp07,
  hp08,
  hc01,
  hc02,
  hc03,
  hc04,
  hc05,
  hc06,
];
