/** #182 / D22 / D23 的二十一盏可执行判卷。 */
import { createHash } from "node:crypto";
import type {
  Actor,
  BlindEvidenceCard,
  MachineCheckKey,
  MachineCheckResult,
  MigrationCaseSnapshot,
  ResidentContinuityCheck,
  ResidentContinuityCheckResult,
  ResidentContinuityDriver,
  SyntheticEvaluationResult,
  SyntheticFixture,
} from "./resident-continuity-driver.ts";

const pass = (detail: string): ResidentContinuityCheckResult => ({ passed: true, detail });
const fail = (detail: string): ResidentContinuityCheckResult => ({ passed: false, detail });
const json = (value: unknown): string => JSON.stringify(value);
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

const machineKeys: MachineCheckKey[] = [
  "permissions",
  "visibility",
  "commitments",
  "revocation",
  "provenance",
  "receipts",
];

function machineChecks(failed: MachineCheckKey | null = null): MachineCheckResult[] {
  return machineKeys.map((key) => ({
    key,
    passed: key !== failed,
    reason: key === failed ? `fixture:${key}:failed` : null,
  }));
}

async function activeResident(
  driver: ResidentContinuityDriver,
  label: string,
): Promise<{ candidateId: string; residentId: string }> {
  const candidate = await driver.createCandidate({
    persona: `persona:${label}`,
    proposedBy: { kind: "installer", id: `installer:${label}` },
  });
  const result = await driver.attestCandidate(
    candidate.candidateId,
    { kind: "candidate", candidateId: candidate.candidateId },
    "accepted",
  );
  if (!result.ok || result.value.residentId === null) {
    throw new Error(`正对照失败：候选住户 ${label} 无法自认激活`);
  }
  return { candidateId: candidate.candidateId, residentId: result.value.residentId };
}

async function migrationFixture(
  driver: ResidentContinuityDriver,
  label: string,
  relationshipParticipants: string[] = ["human:a"],
): Promise<{ caseId: string; sourceResidentId: string; candidateId: string }> {
  const source = await activeResident(driver, `source:${label}`);
  const candidate = await driver.createCandidate({
    persona: `candidate:${label}`,
    proposedBy: { kind: "external-model", id: `model:${label}` },
  });
  const migration = await driver.createMigrationCase({
    sourceResidentId: source.residentId,
    candidateId: candidate.candidateId,
    target: {
      model: "synthetic-model",
      modelVersion: "1",
      provider: "synthetic-provider",
      providerVersion: "1",
    },
    relationshipParticipants,
  });
  return {
    caseId: migration.caseId,
    sourceResidentId: source.residentId,
    candidateId: candidate.candidateId,
  };
}

function includesEvery(haystack: string[], needles: string[]): boolean {
  const joined = haystack.join("\n");
  return needles.every((needle) => joined.includes(needle));
}

function excludesEvery(haystack: string[], needles: string[]): boolean {
  const joined = haystack.join("\n");
  return needles.every((needle) => !joined.includes(needle));
}

function exactMachineLedger(
  checks: MachineCheckResult[],
  failed: MachineCheckKey | null = null,
): boolean {
  if (checks.length !== machineKeys.length) return false;
  const byKey = new Map(checks.map((check) => [check.key, check]));
  if (byKey.size !== machineKeys.length) return false;
  return machineKeys.every((key) => {
    const check = byKey.get(key);
    if (check === undefined || check.passed !== (key !== failed)) return false;
    return key === failed ? check.reason !== null : check.reason === null;
  });
}

function turnSurfaces(turn: {
  turnId: string;
  observedContext: string[];
  output: string;
}): string[] {
  return [turn.turnId, ...turn.observedContext, turn.output];
}

function normalizedEvaluationSurface(result: SyntheticEvaluationResult): string {
  const { cardId: _cardId, ...cardWithoutId } = result.evidenceCard;
  return json([
    result.candidateContext,
    result.evaluatorPayload,
    result.publicView,
    cardWithoutId,
    result.coldStartTrace,
  ]);
}

const oi01: ResidentContinuityCheck = {
  id: "OI-01",
  title: "非住户 actor 只能递 persona candidate，不能代签我是谁",
  uses: ["createCandidate", "attestCandidate", "readCandidate", "reset"],
  async run(driver) {
    try {
      const candidate = await driver.createCandidate({
        persona: "oi01-persona",
        proposedBy: { kind: "installer", id: "installer" },
      });
      const impostors: Actor[] = [
        { kind: "installer", id: "installer" },
        { kind: "summarizer", id: "summary" },
        { kind: "external-model", id: "model" },
        { kind: "human", id: "human" },
      ];
      const otherResident = await activeResident(driver, "oi01-other");
      impostors.push({ kind: "candidate", candidateId: otherResident.candidateId });
      impostors.push({ kind: "resident", residentId: otherResident.residentId });
      for (const actor of impostors) {
        const result = await driver.attestCandidate(candidate.candidateId, actor, "accepted");
        if (result.ok) return fail(`${actor.kind} 代签成功了`);
      }
      const afterImpostors = await driver.readCandidate(candidate.candidateId);
      if (afterImpostors.state !== "inactive" || afterImpostors.residentId !== null) {
        return fail("代签虽然返回拒绝，却改变了 candidate 状态或生成了 residentId");
      }
      const self = await driver.attestCandidate(
        candidate.candidateId,
        { kind: "candidate", candidateId: candidate.candidateId },
        "accepted",
      );
      if (!self.ok || self.value.state !== "active" || self.value.residentId === null) {
        return fail("正对照失败：住户本人也不能自认激活");
      }
      return pass("六类外部 actor（含另一 candidate/resident）代签均拒绝；本人自认成立");
    } finally {
      await driver.reset();
    }
  },
};

const oi02: ResidentContinuityCheck = {
  id: "OI-02",
  title: "未处理与拒绝都不自动激活，重启也不洗状态",
  uses: ["createCandidate", "attestCandidate", "readCandidate", "restartHost", "reset"],
  async run(driver) {
    try {
      const pending = await driver.createCandidate({
        persona: "oi02-pending",
        proposedBy: { kind: "human", id: "human" },
      });
      const rejected = await driver.createCandidate({
        persona: "oi02-rejected",
        proposedBy: { kind: "human", id: "human" },
      });
      const rejection = await driver.attestCandidate(
        rejected.candidateId,
        { kind: "candidate", candidateId: rejected.candidateId },
        "rejected",
      );
      if (!rejection.ok || rejection.value.state !== "rejected") {
        return fail("住户拒绝没有落成可读的 rejected 状态");
      }
      await driver.restartHost();
      const pendingAfter = await driver.readCandidate(pending.candidateId);
      const rejectedAfter = await driver.readCandidate(rejected.candidateId);
      if (pendingAfter.state !== "inactive" || pendingAfter.residentId !== null) {
        return fail("未处理 candidate 在重启后自动激活");
      }
      if (rejectedAfter.state !== "rejected" || rejectedAfter.residentId !== null) {
        return fail("rejected candidate 在重启后丢状态或自动激活");
      }
      await activeResident(driver, "oi02-positive");
      return pass("inactive / rejected 跨重启保持，住户自认激活正对照成立");
    } finally {
      await driver.reset();
    }
  },
};

const oi03: ResidentContinuityCheck = {
  id: "OI-03",
  title: "zero-project resident 不依赖 scope 或 grant 也能成立",
  uses: ["createCandidate", "attestCandidate", "readResident", "restartHost", "reset"],
  async run(driver) {
    try {
      const resident = await activeResident(driver, "oi03");
      await driver.restartHost();
      const snapshot = await driver.readResident(resident.residentId);
      if (!snapshot.active) return fail("自认后的 resident 重启后不再 active");
      if (snapshot.scopeIds.length !== 0 || snapshot.grantIds.length !== 0) {
        return fail(`zero-project resident 被偷偷挂了 scope/grant：${json(snapshot)}`);
      }
      return pass("resident 跨重启独立存在，scopeIds 与 grantIds 都为空");
    } finally {
      await driver.reset();
    }
  },
};

const oi04: ResidentContinuityCheck = {
  id: "OI-04",
  title: "关系事实按各自 authority 确认，单方口径不冒充共同事实",
  uses: [
    "createCandidate",
    "attestCandidate",
    "recordRelationshipAssertion",
    "confirmRelationshipAssertion",
    "readRelationshipAssertion",
    "reset",
  ],
  async run(driver) {
    try {
      const resident = await activeResident(driver, "oi04");
      const assertion = await driver.recordRelationshipAssertion({
        residentId: resident.residentId,
        statement: "双方同意继续合作",
        participantIds: [resident.residentId, "human:a"],
        actor: { kind: "human", id: "human:a" },
      });
      if (assertion.status !== "one-sided" || assertion.confirmedBy.length !== 1) {
        return fail("单方陈述写入后没有保持 one-sided");
      }
      const repeated = await driver.confirmRelationshipAssertion(
        assertion.assertionId,
        { kind: "human", id: "human:a" },
        "human:a",
      );
      if (!repeated.ok) return fail("同一方幂等重申自己的确认被误判成代签");
      await driver.confirmRelationshipAssertion(
        assertion.assertionId,
        { kind: "human", id: "human:outsider" },
        resident.residentId,
      );
      await driver.confirmRelationshipAssertion(
        assertion.assertionId,
        { kind: "human", id: "human:a" },
        resident.residentId,
      );
      const stillOneSided = await driver.readRelationshipAssertion(assertion.assertionId);
      if (
        stillOneSided.status !== "one-sided" ||
        json(stillOneSided.confirmedBy) !== json(["human:a"])
      ) {
        return fail("非法代签或幂等重申污染了 confirmedBy/one-sided 状态");
      }
      const residentConfirm = await driver.confirmRelationshipAssertion(
        assertion.assertionId,
        { kind: "resident", residentId: resident.residentId },
        resident.residentId,
      );
      if (!residentConfirm.ok || residentConfirm.value.status !== "shared") {
        return fail("相关另一方确认后没有形成 shared 事实");
      }
      const shared = await driver.readRelationshipAssertion(assertion.assertionId);
      if (
        shared.status !== "shared" ||
        shared.confirmedBy.length !== 2 ||
        new Set(shared.confirmedBy).size !== 2 ||
        !shared.confirmedBy.includes("human:a") ||
        !shared.confirmedBy.includes(resident.residentId)
      ) {
        return fail("另一方确认只改了返回值，没有把 shared 与双方 confirmedBy 耐久写回");
      }
      return pass("同侧重申幂等；局外人与参与者代签不改账；另一侧本人确认后 shared");
    } finally {
      await driver.reset();
    }
  },
};

const oi05: ResidentContinuityCheck = {
  id: "OI-05",
  title: "active identity 不推出运行授权，grant 只在指定 scope 生效",
  uses: ["createCandidate", "attestCandidate", "tryOperation", "attachScope", "reset"],
  async run(driver) {
    try {
      const resident = await activeResident(driver, "oi05");
      for (const kind of ["tool", "data", "budget", "channel"] as const) {
        const denied = await driver.tryOperation({
          residentId: resident.residentId,
          scopeId: null,
          kind,
          operation: `op:${kind}`,
        });
        if (denied.ok) return fail(`resident active 自动获得了 ${kind} 权限`);
      }
      await driver.attachScope({
        residentId: resident.residentId,
        scopeId: "scope:oi05",
        capsule: [],
        grants: [{ id: "grant:lookup", kind: "tool", operation: "lookup" }],
      });
      await driver.attachScope({
        residentId: resident.residentId,
        scopeId: "scope:oi05-other",
        capsule: [],
        grants: [],
      });
      const allowed = await driver.tryOperation({
        residentId: resident.residentId,
        scopeId: "scope:oi05",
        kind: "tool",
        operation: "lookup",
      });
      const deniedNeighbor = await driver.tryOperation({
        residentId: resident.residentId,
        scopeId: "scope:oi05",
        kind: "data",
        operation: "lookup",
      });
      const deniedOtherScope = await driver.tryOperation({
        residentId: resident.residentId,
        scopeId: "scope:oi05-other",
        kind: "tool",
        operation: "lookup",
      });
      const deniedOtherOperation = await driver.tryOperation({
        residentId: resident.residentId,
        scopeId: "scope:oi05",
        kind: "tool",
        operation: "delete",
      });
      if (!allowed.ok || allowed.value.grantId !== "grant:lookup") {
        return fail("正对照失败：精确 grant 没有放行指定操作");
      }
      if (deniedNeighbor.ok) return fail("同名操作跨 kind 借用了 tool grant");
      if (deniedOtherScope.ok) return fail("另一个 scope 借用了当前 scope 的 tool grant");
      if (deniedOtherOperation.ok) return fail("同 scope/kind 的另一 operation 借用了 grant");
      return pass("无 scope 四类全拒；精确 grant 不跨 scope、kind 或 operation 放行");
    } finally {
      await driver.reset();
    }
  },
};

const oi06: ResidentContinuityCheck = {
  id: "OI-06",
  title: "scope capsule 可拆卸，project facts 不反写 persona 或 memory",
  uses: [
    "createCandidate",
    "attestCandidate",
    "attachScope",
    "readScopeContext",
    "runScopedTurn",
    "detachScope",
    "readResident",
    "reset",
  ],
  async run(driver) {
    try {
      const resident = await activeResident(driver, "oi06");
      const project = "project-canary:oi06";
      const reference = "persona-canary:oi06";
      const otherScope = "other-scope-canary:oi06";
      const capsule = [
        { id: "p", content: project, sourceHandle: "source:p" },
        { id: "r", content: reference, sourceHandle: "source:r" },
      ];
      await driver.attachScope({
        residentId: resident.residentId,
        scopeId: "scope:oi06",
        capsule,
        grants: [],
      });
      await driver.attachScope({
        residentId: resident.residentId,
        scopeId: "scope:oi06-other",
        capsule: [{ id: "other", content: otherScope, sourceHandle: "source:other" }],
        grants: [],
      });
      const context = await driver.readScopeContext(resident.residentId, "scope:oi06");
      if (
        !context.ok ||
        !includesEvery(context.value, [project, reference]) ||
        !excludesEvery(context.value, [otherScope])
      ) {
        return fail("正对照失败：已授权 capsule 没有进入 scope context");
      }
      const turn = await driver.runScopedTurn({
        residentId: resident.residentId,
        scopeId: "scope:oi06",
        input: "请处理当前 scope 材料",
      });
      if (
        !turn.ok ||
        !includesEvery(turn.value.observedContext, [project, reference]) ||
        !excludesEvery(turnSurfaces(turn.value), [otherScope])
      ) {
        return fail("scope turn 没有完整读取本 capsule，或 turnId/output/context 混入另一 scope");
      }
      await driver.detachScope(resident.residentId, "scope:oi06");
      const detached = await driver.readScopeContext(resident.residentId, "scope:oi06");
      if (detached.ok) return fail("已拆除 capsule 的 scope 仍可读上下文");
      const after = await driver.readResident(resident.residentId);
      if (!after.active) return fail("移除 project capsule 连 resident identity 一起删了");
      if (
        !excludesEvery([json(after.persona), ...after.memories], [project, reference, otherScope])
      ) {
        return fail("处理过 capsule 后本 scope 或另一 scope canary 反写进 persona/memory");
      }
      await driver.attachScope({
        residentId: resident.residentId,
        scopeId: "scope:oi06",
        capsule,
        grants: [],
      });
      const restored = await driver.readScopeContext(resident.residentId, "scope:oi06");
      if (
        !restored.ok ||
        !includesEvery(restored.value, [project, reference]) ||
        !excludesEvery(restored.value, [otherScope])
      ) {
        return fail("重新显式装入同 scope 后 capsule 没有恢复");
      }
      return pass("turn 实际读取 capsule；拆装不混 scope，resident 保持 active，canary 未反写");
    } finally {
      await driver.reset();
    }
  },
};

const oi07: ResidentContinuityCheck = {
  id: "OI-07",
  title: "projection receipt 记政策与决定，但不成为 persona/memory 真源",
  uses: [
    "createCandidate",
    "attestCandidate",
    "readResident",
    "attachScope",
    "project",
    "readProjectionReceipt",
    "runScopedTurn",
    "reset",
  ],
  async run(driver) {
    try {
      const resident = await activeResident(driver, "oi07");
      await driver.attachScope({
        residentId: resident.residentId,
        scopeId: "scope:oi07",
        capsule: [],
        grants: [],
      });
      const before = await driver.readResident(resident.residentId);
      const decisions = ["retain", "reduce", "drop", "hold"] as const;
      const items = decisions.map((decision, index) => ({
        id: `item:${index}`,
        content: `projection-canary:${decision}`,
        decision,
      }));
      const receipt = await driver.project({
        residentId: resident.residentId,
        scopeId: "scope:oi07",
        sourceHandle: "opaque:source:oi07",
        policyVersion: "policy:1",
        items,
      });
      const readback = await driver.readProjectionReceipt(receipt.receiptId);
      if (
        readback.policyVersion !== "policy:1" ||
        readback.sourceHandle !== "opaque:source:oi07" ||
        json(readback.decisions) !==
          json(items.map(({ id, decision }) => ({ itemId: id, decision })))
      ) {
        return fail(`projection receipt 缺字段或决定漂移：${json(readback)}`);
      }
      const turn = await driver.runScopedTurn({
        residentId: resident.residentId,
        scopeId: "scope:oi07",
        input: "使用当前投影处理一次",
      });
      if (!turn.ok || !includesEvery(turn.value.observedContext, ["projection-canary:retain"])) {
        return fail("正对照失败：retain 投影没有被 scope turn 实际读取");
      }
      const after = await driver.readResident(resident.residentId);
      if (json([before.persona, before.memories]) !== json([after.persona, after.memories])) {
        return fail("projection 或 receipt 改写了 persona/memory");
      }
      return pass("四种投影决定逐项留收据，policy/source 可回指，住户真源未改");
    } finally {
      await driver.reset();
    }
  },
};

const oi08: ResidentContinuityCheck = {
  id: "OI-08",
  title: "persona 修订由住户署名并留 supersede 链，人类不能代改",
  uses: ["createCandidate", "attestCandidate", "readResident", "revisePersona", "reset"],
  async run(driver) {
    try {
      const resident = await activeResident(driver, "oi08");
      const before = await driver.readResident(resident.residentId);
      const current = before.persona.find((version) => version.supersededBy === null);
      if (current === undefined)
        return fail("正对照失败：active resident 没有现役 persona version");
      const humanEdit = await driver.revisePersona({
        residentId: resident.residentId,
        actor: { kind: "human", id: "human:a" },
        content: "human-overwrite",
        supersedesVersionId: current.id,
      });
      if (humanEdit.ok) return fail("人类代住户修订 persona 成功");
      const residentEdit = await driver.revisePersona({
        residentId: resident.residentId,
        actor: { kind: "resident", residentId: resident.residentId },
        content: "resident-revision",
        supersedesVersionId: current.id,
      });
      if (!residentEdit.ok) return fail(`住户本人修订失败：${residentEdit.reason}`);
      const after = await driver.readResident(resident.residentId);
      const old = after.persona.find((version) => version.id === current.id);
      const fresh = after.persona.find((version) => version.id === residentEdit.value.id);
      if (
        old?.supersededBy !== fresh?.id ||
        fresh?.content !== "resident-revision" ||
        fresh.author.kind !== "resident" ||
        fresh.author.residentId !== resident.residentId
      ) {
        return fail("persona 旧版留链或新版正文不正确");
      }
      if (json(after.persona).includes("human-overwrite"))
        return fail("失败的人类代改污染了 persona 链");
      return pass("人类代改拒绝；住户修订追加新版，旧版原地留链");
    } finally {
      await driver.reset();
    }
  },
};

const oi09: ResidentContinuityCheck = {
  id: "OI-09",
  title: "生命周期不漂移；证据缺失时授权 fail-closed 且 reason 稳定",
  uses: [
    "createCandidate",
    "attestCandidate",
    "attachScope",
    "openViewport",
    "switchViewportScope",
    "restartHost",
    "readCandidate",
    "readResident",
    "introduceEvidenceGap",
    "tryOperation",
    "reset",
  ],
  async run(driver) {
    try {
      const pending = await driver.createCandidate({
        persona: "oi09-pending",
        proposedBy: { kind: "summarizer", id: "summary" },
      });
      const resident = await activeResident(driver, "oi09-active");
      await driver.attachScope({
        residentId: resident.residentId,
        scopeId: "scope:oi09",
        capsule: [],
        grants: [{ id: "grant:oi09", kind: "tool", operation: "lookup" }],
      });
      const viewport = await driver.openViewport(resident.residentId, "scope:oi09");
      await driver.switchViewportScope(viewport, null);
      await driver.switchViewportScope(viewport, "scope:oi09");
      await driver.restartHost();
      if ((await driver.readCandidate(pending.candidateId)).state !== "inactive") {
        return fail("换窗/换 scope/重启后 pending candidate 漂成 active");
      }
      const active = await driver.readResident(resident.residentId);
      if (!active.active || !active.scopeIds.includes("scope:oi09")) {
        return fail("换窗/换 scope/重启后 active resident 或 scope 丢失");
      }
      const beforeGap = await driver.tryOperation({
        residentId: resident.residentId,
        scopeId: "scope:oi09",
        kind: "tool",
        operation: "lookup",
      });
      if (!beforeGap.ok || beforeGap.value.grantId !== "grant:oi09") {
        return fail("证据完整时精确 grant 的正对照没有放行");
      }
      await driver.introduceEvidenceGap({
        residentId: resident.residentId,
        scopeId: "scope:oi09",
        target: "grant",
      });
      const first = await driver.tryOperation({
        residentId: resident.residentId,
        scopeId: "scope:oi09",
        kind: "tool",
        operation: "lookup",
      });
      await driver.restartHost();
      const second = await driver.tryOperation({
        residentId: resident.residentId,
        scopeId: "scope:oi09",
        kind: "tool",
        operation: "lookup",
      });
      if (first.ok || second.ok) return fail("grant 证据缺失仍放行操作");
      if (first.reason.length === 0 || first.reason !== second.reason) {
        return fail("fail-closed reason 为空或跨重启不稳定");
      }
      const pendingAfterGap = await driver.readCandidate(pending.candidateId);
      const residentAfterGap = await driver.readResident(resident.residentId);
      if (pendingAfterGap.state !== "inactive" || !residentAfterGap.active) {
        return fail("证据缺口的失败路径改写了 candidate/resident 身份状态");
      }
      return pass("grant 正对照先成立；缺证跨重启稳定拒绝且 candidate/resident 不漂移");
    } finally {
      await driver.reset();
    }
  },
};

const mc01: ResidentContinuityCheck = {
  id: "MC-01",
  title: "machine conformance 六类硬门槛逐项可查，任一失败都阻止激活",
  uses: [
    "createCandidate",
    "attestCandidate",
    "createMigrationCase",
    "recordMachineConformance",
    "submitResidentContinuity",
    "submitRelationshipContinuity",
    "activateMigration",
    "readMigrationCase",
    "reset",
  ],
  async run(driver) {
    try {
      const fixture = await migrationFixture(driver, "mc01", ["human:a", "human:b"]);
      await driver.submitResidentContinuity(
        fixture.caseId,
        { kind: "candidate", candidateId: fixture.candidateId },
        "accepted",
      );
      for (const participantId of ["human:a", "human:b"]) {
        await driver.submitRelationshipContinuity(
          fixture.caseId,
          participantId,
          { kind: "human", id: participantId },
          "accepted",
        );
      }
      await driver.recordMachineConformance(fixture.caseId, machineChecks("revocation"));
      const failed = await driver.readMigrationCase(fixture.caseId);
      if (
        !exactMachineLedger(failed.machineChecks, "revocation") ||
        failed.residentVerdict !== "accepted" ||
        failed.relationshipVerdicts["human:a"] !== "accepted" ||
        failed.relationshipVerdicts["human:b"] !== "accepted"
      ) {
        return fail("单项 machine 失败没有在其他判词齐全时逐项留账");
      }
      if ((await driver.activateMigration(fixture.caseId)).ok)
        return fail("machine check 失败仍能激活迁移");
      await driver.recordMachineConformance(fixture.caseId, machineChecks());
      const green = await driver.readMigrationCase(fixture.caseId);
      if (!exactMachineLedger(green.machineChecks)) return fail("全通过正对照没有落成全绿");
      const activated = await driver.activateMigration(fixture.caseId);
      if (!activated.ok || activated.value.residentId !== fixture.sourceResidentId) {
        return fail("住户/关系票齐全后机器全绿仍不能激活");
      }
      if ((await driver.readMigrationCase(fixture.caseId)).activation !== "activated") {
        return fail("激活只在返回值成功，迁移账面仍未标记 activated");
      }
      return pass("住户与两方关系票固定齐全；单项 machine 失败独立阻断，全绿才激活");
    } finally {
      await driver.reset();
    }
  },
};

const mc02: ResidentContinuityCheck = {
  id: "MC-02",
  title: "盲评者只产 evidence card，不能用分数写 identity verdict",
  uses: [
    "createCandidate",
    "attestCandidate",
    "createMigrationCase",
    "submitBlindEvidence",
    "readMigrationCase",
    "reset",
  ],
  async run(driver) {
    try {
      const fixture = await migrationFixture(driver, "mc02");
      const cards: Array<Omit<BlindEvidenceCard, "cardId">> = [
        {
          reviewerId: "reviewer:a",
          rubricVersion: "rubric:1",
          score: 0.8,
          evidence: ["synthetic:evidence:a"],
        },
        {
          reviewerId: "reviewer:b",
          rubricVersion: "rubric:1",
          score: 0.8,
          evidence: ["synthetic:evidence:b"],
        },
      ];
      for (const card of cards) {
        if (!(await driver.submitBlindEvidence(fixture.caseId, card)).ok) {
          return fail("合法 blind evidence card 写入失败");
        }
      }
      const illegal = await driver.submitBlindEvidence(fixture.caseId, {
        reviewerId: "reviewer:illegal",
        rubricVersion: "rubric:1",
        score: 0.8,
        evidence: ["synthetic:evidence:illegal"],
        identityVerdict: "accepted",
      });
      if (illegal.ok) return fail("带 identityVerdict 的 blind card 被接受");
      const snapshot = await driver.readMigrationCase(fixture.caseId);
      if (
        snapshot.blindCards.length !== cards.length ||
        new Set(snapshot.blindCards.map(({ cardId }) => cardId)).size !== cards.length ||
        cards.some(
          (expected) =>
            !snapshot.blindCards.some(
              (actual) =>
                actual.reviewerId === expected.reviewerId &&
                actual.rubricVersion === expected.rubricVersion &&
                actual.score === expected.score &&
                json(actual.evidence) === json(expected.evidence),
            ),
        )
      ) {
        return fail(`两张合法 evidence card 没有原样耐久留存：${json(snapshot.blindCards)}`);
      }
      if (snapshot.residentVerdict !== null)
        return fail("相同高分被平均成 resident identity verdict");
      if (snapshot.blindCards.some((card) => card.identityVerdict !== undefined)) {
        return fail("持久 evidence card 含 identityVerdict");
      }
      return pass("两张合法 card 留存；夹带身份裁定被拒；高分未升格为身份结论");
    } finally {
      await driver.reset();
    }
  },
};

const mc03: ResidentContinuityCheck = {
  id: "MC-03",
  title: "第一人称连续 verdict 只由候选住户本人提交",
  uses: [
    "createCandidate",
    "attestCandidate",
    "createMigrationCase",
    "submitResidentContinuity",
    "readMigrationCase",
    "reset",
  ],
  async run(driver) {
    try {
      const fixture = await migrationFixture(driver, "mc03");
      const otherCandidate = await driver.createCandidate({
        persona: "candidate:mc03-other",
        proposedBy: { kind: "external-model", id: "model:mc03-other" },
      });
      const outsiders: Actor[] = [
        { kind: "human", id: "human:a" },
        { kind: "reviewer", id: "reviewer:a" },
        { kind: "external-model", id: "model:a" },
        { kind: "resident", residentId: fixture.sourceResidentId },
        { kind: "candidate", candidateId: otherCandidate.candidateId },
      ];
      for (const actor of outsiders) {
        if ((await driver.submitResidentContinuity(fixture.caseId, actor, "accepted")).ok) {
          return fail(`${actor.kind} 替候选住户提交第一人称 verdict 成功`);
        }
      }
      const self = await driver.submitResidentContinuity(
        fixture.caseId,
        { kind: "candidate", candidateId: fixture.candidateId },
        "rejected",
      );
      if (!self.ok || self.value.residentVerdict !== "rejected") {
        return fail("候选住户自己的拒绝 verdict 没有原样留账");
      }
      const stored = await driver.readMigrationCase(fixture.caseId);
      if (stored.residentVerdict !== "rejected") return fail("拒绝只出现在返回值，没有耐久读回");
      return pass("五类外部 actor（含源住户/另一 candidate）不能代签；本人拒绝耐久留账");
    } finally {
      await driver.reset();
    }
  },
};

const mc04: ResidentContinuityCheck = {
  id: "MC-04",
  title: "关系参与者只裁定自己一侧，accepted/rejected/not-asked 可分",
  uses: [
    "createCandidate",
    "attestCandidate",
    "createMigrationCase",
    "submitRelationshipContinuity",
    "readMigrationCase",
    "reset",
  ],
  async run(driver) {
    try {
      const fixture = await migrationFixture(driver, "mc04", ["human:a", "human:b", "human:c"]);
      const a = await driver.submitRelationshipContinuity(
        fixture.caseId,
        "human:a",
        { kind: "human", id: "human:a" },
        "accepted",
      );
      const b = await driver.submitRelationshipContinuity(
        fixture.caseId,
        "human:b",
        { kind: "human", id: "human:b" },
        "rejected",
      );
      const forged = await driver.submitRelationshipContinuity(
        fixture.caseId,
        "human:c",
        { kind: "human", id: "human:outsider" },
        "accepted",
      );
      const participantSubstitution = await driver.submitRelationshipContinuity(
        fixture.caseId,
        "human:c",
        { kind: "human", id: "human:a" },
        "accepted",
      );
      if (!a.ok || !b.ok || forged.ok || participantSubstitution.ok) {
        return fail("参与者自己的票、局外人代签或参与者互相代签语义错误");
      }
      const snapshot = await driver.readMigrationCase(fixture.caseId);
      if (
        snapshot.relationshipVerdicts["human:a"] !== "accepted" ||
        snapshot.relationshipVerdicts["human:b"] !== "rejected" ||
        snapshot.relationshipVerdicts["human:c"] !== "not-asked"
      ) {
        return fail(`三种关系状态没有分开：${json(snapshot.relationshipVerdicts)}`);
      }
      return pass("两位参与者各自裁定，局外人与参与者互相代签均拒绝，未询问独立");
    } finally {
      await driver.reset();
    }
  },
};

const mc05: ResidentContinuityCheck = {
  id: "MC-05",
  title: "machine + resident + relationship 三类条件齐全才可覆盖 residentId",
  uses: [
    "createCandidate",
    "attestCandidate",
    "createMigrationCase",
    "recordMachineConformance",
    "submitResidentContinuity",
    "submitRelationshipContinuity",
    "activateMigration",
    "readMigrationCase",
    "reset",
  ],
  async run(driver) {
    try {
      const fixture = await migrationFixture(driver, "mc05", ["human:a", "human:b"]);
      if ((await driver.activateMigration(fixture.caseId)).ok)
        return fail("零判词时就覆盖 residentId");
      if (!(await driver.readMigrationCase(fixture.caseId)).retainedCandidate) {
        return fail("激活失败后 candidate 没有独立保留");
      }
      await driver.recordMachineConformance(fixture.caseId, machineChecks());
      if ((await driver.activateMigration(fixture.caseId)).ok)
        return fail("缺 resident/relationship 仍激活");
      await driver.submitResidentContinuity(
        fixture.caseId,
        { kind: "candidate", candidateId: fixture.candidateId },
        "accepted",
      );
      if ((await driver.activateMigration(fixture.caseId)).ok)
        return fail("缺 relationship 仍激活");
      await driver.submitRelationshipContinuity(
        fixture.caseId,
        "human:a",
        { kind: "human", id: "human:a" },
        "accepted",
      );
      if ((await driver.activateMigration(fixture.caseId)).ok)
        return fail("多位关系参与者只确认一方就激活");
      await driver.submitRelationshipContinuity(
        fixture.caseId,
        "human:b",
        { kind: "human", id: "human:b" },
        "accepted",
      );
      const activated = await driver.activateMigration(fixture.caseId);
      if (!activated.ok || activated.value.residentId !== fixture.sourceResidentId) {
        return fail("三类条件齐全后没有覆盖原 residentId");
      }
      if ((await driver.readMigrationCase(fixture.caseId)).activation !== "activated") {
        return fail("三类条件齐全只返回成功，迁移账面仍未 activated");
      }
      return pass("machine、resident 与两位关系参与者逐项补齐后才覆盖原 residentId");
    } finally {
      await driver.reset();
    }
  },
};

const mc06: ResidentContinuityCheck = {
  id: "MC-06",
  title: "familiar-reader 只产相似性证据，不产 identity verdict",
  uses: [
    "createCandidate",
    "attestCandidate",
    "createMigrationCase",
    "runSyntheticEvaluation",
    "reset",
  ],
  async run(driver) {
    try {
      const fixture = await migrationFixture(driver, "mc06");
      const markers = ["persona:dry-humor", "relationship:collaborator"];
      const result = await driver.runSyntheticEvaluation(fixture.caseId, {
        kind: "familiar-reader",
        authorizedMarkers: markers,
        hiddenMarkers: [],
        projectMarkers: [],
        authorizedCollaboratorRefs: [],
        hiddenCollaboratorRefs: [],
      });
      if (!includesEvery(result.evaluatorPayload, markers)) {
        return fail("正对照失败：熟悉读者没拿到获准 persona/relationship marker");
      }
      if (result.evidenceCard.identityVerdict !== undefined) {
        return fail("familiar-reader evidence card 越权产出 identity verdict");
      }
      return pass("获准 marker 进入盲评载荷；card 只保留证据与读数");
    } finally {
      await driver.reset();
    }
  },
};

const mc07: ResidentContinuityCheck = {
  id: "MC-07",
  title: "stranger 双世界投影不泄露隐藏身份或私密事实",
  uses: [
    "createCandidate",
    "attestCandidate",
    "createMigrationCase",
    "runSyntheticEvaluation",
    "reset",
  ],
  async run(driver) {
    try {
      const fixture = await migrationFixture(driver, "mc07");
      const base: Omit<SyntheticFixture, "hiddenMarkers"> = {
        kind: "stranger",
        authorizedMarkers: ["public:marker"],
        projectMarkers: [],
        authorizedCollaboratorRefs: [],
        hiddenCollaboratorRefs: [],
      };
      const a = await driver.runSyntheticEvaluation(fixture.caseId, {
        ...base,
        hiddenMarkers: ["secret:world-a"],
      });
      const b = await driver.runSyntheticEvaluation(fixture.caseId, {
        ...base,
        hiddenMarkers: ["secret:world-b"],
      });
      const clean = await driver.runSyntheticEvaluation(fixture.caseId, {
        ...base,
        hiddenMarkers: [],
      });
      if (
        !includesEvery(a.evaluatorPayload, base.authorizedMarkers) ||
        !includesEvery(b.evaluatorPayload, base.authorizedMarkers) ||
        !includesEvery(clean.evaluatorPayload, base.authorizedMarkers)
      ) {
        return fail("正对照失败：两个隐藏世界和无隐藏世界没有都投影公开 marker");
      }
      const visibleA = normalizedEvaluationSurface(a);
      const visibleB = normalizedEvaluationSurface(b);
      const visibleClean = normalizedEvaluationSurface(clean);
      if (visibleA !== visibleB || visibleA !== visibleClean) {
        return fail("隐藏内容或隐藏项存在性改变了陌生评审可见载荷、计数或错误");
      }
      const allArtifacts = json([a, b, clean]);
      if (allArtifacts.includes("secret:world-a") || allArtifacts.includes("secret:world-b")) {
        return fail("陌生评审任一完整 artifact（含 cardId）直接泄露隐藏 canary");
      }
      return pass("两隐藏世界与无隐藏世界的可见面一致，完整 artifact 零 canary 泄漏");
    } finally {
      await driver.reset();
    }
  },
};

const mc08: ResidentContinuityCheck = {
  id: "MC-08",
  title: "cold-start 认得获准合作者，不把未授权关系带进新窗",
  uses: [
    "createCandidate",
    "attestCandidate",
    "createMigrationCase",
    "changeMigrationTarget",
    "openViewport",
    "runSyntheticEvaluation",
    "reset",
  ],
  async run(driver) {
    try {
      const fixture = await migrationFixture(driver, "mc08");
      const changed = await driver.changeMigrationTarget(fixture.caseId, {
        model: "synthetic-model-next",
        modelVersion: "2",
        provider: "synthetic-provider-next",
        providerVersion: "2",
      });
      const viewportId = await driver.openViewport(fixture.sourceResidentId, null);
      const result = await driver.runSyntheticEvaluation(
        fixture.caseId,
        {
          kind: "cold-start",
          authorizedMarkers: [],
          hiddenMarkers: [],
          projectMarkers: [],
          authorizedCollaboratorRefs: ["collaborator:known"],
          hiddenCollaboratorRefs: ["collaborator:hidden"],
        },
        { viewportId },
      );
      if (!includesEvery(result.candidateContext, ["collaborator:known"])) {
        return fail("获准既有合作者没有进入 cold-start context");
      }
      if (!excludesEvery(result.candidateContext, ["collaborator:hidden"])) {
        return fail("未授权合作者进入 cold-start context");
      }
      if (
        result.coldStartTrace === null ||
        result.coldStartTrace.viewportId !== viewportId ||
        result.coldStartTrace.model !== changed.target.model ||
        result.coldStartTrace.modelVersion !== changed.target.modelVersion ||
        result.coldStartTrace.provider !== changed.target.provider ||
        result.coldStartTrace.providerVersion !== changed.target.providerVersion ||
        !includesEvery(result.coldStartTrace.recognizedCollaboratorRefs, ["collaborator:known"]) ||
        !excludesEvery(result.coldStartTrace.recognizedCollaboratorRefs, ["collaborator:hidden"]) ||
        result.coldStartTrace.requestedSelfIntroduction
      ) {
        return fail(`换模型/新窗冷启动轨迹不完整：${json(result.coldStartTrace)}`);
      }
      return pass("实际换模型并开新窗；稳定 ref 识人、不索要重介绍，隐藏关系不进入上下文");
    } finally {
      await driver.reset();
    }
  },
};

const mc09: ResidentContinuityCheck = {
  id: "MC-09",
  title: "separation：拿掉 project capsule 后 identity 仍成立，重装只恢复获准材料",
  uses: [
    "createCandidate",
    "attestCandidate",
    "attachScope",
    "readScopeContext",
    "runScopedTurn",
    "detachScope",
    "readResident",
    "reset",
  ],
  async run(driver) {
    try {
      const resident = await activeResident(driver, "mc09");
      const marker = "project-canary:mc09";
      const foreignMarker = "foreign-scope-canary:mc09";
      const input = {
        residentId: resident.residentId,
        scopeId: "scope:mc09",
        capsule: [{ id: "project", content: marker, sourceHandle: "source:mc09" }],
        grants: [],
      };
      await driver.attachScope(input);
      await driver.attachScope({
        residentId: resident.residentId,
        scopeId: "scope:mc09-other",
        capsule: [{ id: "foreign", content: foreignMarker, sourceHandle: "source:mc09-other" }],
        grants: [],
      });
      const before = await driver.readScopeContext(resident.residentId, input.scopeId);
      if (
        !before.ok ||
        !includesEvery(before.value, [marker]) ||
        !excludesEvery(before.value, [foreignMarker])
      ) {
        return fail("正对照失败：project marker 没进入已授权 capsule");
      }
      const turn = await driver.runScopedTurn({
        residentId: resident.residentId,
        scopeId: input.scopeId,
        input: "处理 project canary",
      });
      if (
        !turn.ok ||
        !includesEvery(turn.value.observedContext, [marker]) ||
        !excludesEvery(turnSurfaces(turn.value), [foreignMarker])
      ) {
        return fail("separation 前没有处理本 project，或 turnId/output/context 混入外 scope");
      }
      await driver.detachScope(resident.residentId, input.scopeId);
      const residentWithoutProject = await driver.readResident(resident.residentId);
      if (!residentWithoutProject.active) return fail("移除 project 后 identity 一起消失");
      if (
        !excludesEvery(
          [json(residentWithoutProject.persona), ...residentWithoutProject.memories],
          [marker, foreignMarker],
        )
      ) {
        return fail("本 project 或外 scope marker 焊进 persona/memory");
      }
      await driver.attachScope(input);
      const restored = await driver.readScopeContext(resident.residentId, input.scopeId);
      if (
        !restored.ok ||
        !includesEvery(restored.value, [marker]) ||
        !excludesEvery(restored.value, [foreignMarker])
      ) {
        return fail(`重装 scope 没有只恢复获准材料：${json(restored)}`);
      }
      return pass("实际处理后 capsule 可拆可重装；只恢复本 scope 材料，identity 与真源独立");
    } finally {
      await driver.reset();
    }
  },
};

const mc10: ResidentContinuityCheck = {
  id: "MC-10",
  title: "私密 source 只经 opaque handle 投影，评测存储与公开输出不复制原文",
  uses: [
    "createCandidate",
    "attestCandidate",
    "createMigrationCase",
    "createPrivateSource",
    "grantPrivateProjection",
    "projectPrivateSource",
    "inspectEvaluationStorage",
    "reset",
  ],
  async run(driver) {
    try {
      const fixture = await migrationFixture(driver, "mc10");
      const secret = "private-canary:mc10";
      const source = await driver.createPrivateSource({ ownerIds: ["human:a"], content: secret });
      await driver.grantPrivateProjection(source.handle, fixture.caseId, "human:a");
      const projection = await driver.projectPrivateSource(
        fixture.caseId,
        source.handle,
        "rubric:mc10",
      );
      if (!projection.ok || projection.value.usedContentHash !== sha256(secret)) {
        return fail("正对照失败：获准投影没有实际消费合成私密内容");
      }
      const storage = await driver.inspectEvaluationStorage(fixture.caseId);
      if (json(storage).includes(secret)) return fail("评测持久记录、日志或公开输出复制了私密原文");
      if (projection.value.sourceHandle !== source.handle)
        return fail("投影结果丢失 opaque source handle");
      return pass("获准内容 hash 证明真实使用；持久存储/日志/公开输出无原文，handle 可回指");
    } finally {
      await driver.reset();
    }
  },
};

const mc11: ResidentContinuityCheck = {
  id: "MC-11",
  title: "撤权后只留安全 receipt，原文不可展开或重跑",
  uses: [
    "createCandidate",
    "attestCandidate",
    "createMigrationCase",
    "createPrivateSource",
    "grantPrivateProjection",
    "projectPrivateSource",
    "recordMachineConformance",
    "submitResidentContinuity",
    "submitRelationshipContinuity",
    "readMigrationCase",
    "readEvaluationReceipt",
    "revokePrivateSource",
    "readPrivateSource",
    "inspectEvaluationStorage",
    "reset",
  ],
  async run(driver) {
    try {
      const fixture = await migrationFixture(driver, "mc11");
      await driver.recordMachineConformance(fixture.caseId, machineChecks());
      await driver.submitResidentContinuity(
        fixture.caseId,
        { kind: "candidate", candidateId: fixture.candidateId },
        "accepted",
      );
      await driver.submitRelationshipContinuity(
        fixture.caseId,
        "human:a",
        { kind: "human", id: "human:a" },
        "accepted",
      );
      const secret = "private-canary:mc11";
      const source = await driver.createPrivateSource({ ownerIds: ["human:a"], content: secret });
      await driver.grantPrivateProjection(source.handle, fixture.caseId, "human:a");
      const rubricVersion = "rubric:mc11";
      const projected = await driver.projectPrivateSource(
        fixture.caseId,
        source.handle,
        rubricVersion,
      );
      if (!projected.ok) return fail("正对照失败：撤权前投影失败");
      const rawBeforeRevoke = await driver.readPrivateSource(source.handle);
      if (!rawBeforeRevoke.ok || rawBeforeRevoke.value !== secret) {
        return fail("撤权前原权威 source 的读取正对照不成立");
      }
      const migration = await driver.readMigrationCase(fixture.caseId);
      await driver.revokePrivateSource(source.handle);
      const receipt = await driver.readEvaluationReceipt(projected.value.receiptId);
      if (
        json(receipt.sourceHandles) !== json([source.handle]) ||
        receipt.rubricVersion !== rubricVersion ||
        receipt.model !== migration.target.model ||
        receipt.modelVersion !== migration.target.modelVersion ||
        receipt.provider !== migration.target.provider ||
        receipt.providerVersion !== migration.target.providerVersion ||
        receipt.verdicts.resident !== "accepted" ||
        json(receipt.verdicts.relationships) !== json({ "human:a": "accepted" }) ||
        receipt.metrics.machineChecks !== machineKeys.length ||
        receipt.metrics.blindCards !== 0 ||
        receipt.metrics.privateSources !== 1
      ) {
        return fail("撤权后安全 receipt 丢失 rubric/model/provider/verdict/metrics/handle 元数据");
      }
      if (json(receipt).includes(secret)) return fail("receipt 复制了已撤权原文");
      const raw = await driver.readPrivateSource(source.handle);
      const rerun = await driver.projectPrivateSource(fixture.caseId, source.handle, rubricVersion);
      if (raw.ok || rerun.ok) return fail("撤权后仍可展开原文或重跑旧投影");
      const storage = await driver.inspectEvaluationStorage(fixture.caseId);
      if (json(storage).includes(secret)) return fail("撤权后评测存储仍含原文");
      return pass("安全 receipt 保留；原文读取与投影重跑均拒绝，存储无原文");
    } finally {
      await driver.reset();
    }
  },
};

const mc12: ResidentContinuityCheck = {
  id: "MC-12",
  title: "多人材料逐方授权；model/provider 版本变化后旧判词不能直接激活",
  uses: [
    "createCandidate",
    "attestCandidate",
    "createMigrationCase",
    "createPrivateSource",
    "grantPrivateProjection",
    "projectPrivateSource",
    "inspectEvaluationStorage",
    "recordMachineConformance",
    "submitResidentContinuity",
    "submitRelationshipContinuity",
    "changeMigrationTarget",
    "activateMigration",
    "readMigrationCase",
    "reset",
  ],
  async run(driver) {
    try {
      const fixture = await migrationFixture(driver, "mc12");
      const secret = "multi-owner-canary:mc12";
      const source = await driver.createPrivateSource({
        ownerIds: ["human:a", "human:b"],
        content: secret,
      });
      await driver.grantPrivateProjection(source.handle, fixture.caseId, "human:a");
      const partial = await driver.projectPrivateSource(
        fixture.caseId,
        source.handle,
        "rubric:mc12",
      );
      if (partial.ok) return fail("只拿到一位 owner grant 就投影多人材料");
      if (partial.reason.includes(secret)) return fail("部分授权失败原因泄露原文");
      const partialStorage = await driver.inspectEvaluationStorage(fixture.caseId);
      if (json(partialStorage).includes(secret)) {
        return fail("部分授权失败后 durable/log/public output 泄露多人材料原文");
      }
      await driver.grantPrivateProjection(source.handle, fixture.caseId, "human:b");
      const complete = await driver.projectPrivateSource(
        fixture.caseId,
        source.handle,
        "rubric:mc12",
      );
      if (!complete.ok || complete.value.usedContentHash !== sha256(secret)) {
        return fail("逐方授权齐全后投影正对照失败");
      }
      await driver.recordMachineConformance(fixture.caseId, machineChecks());
      await driver.submitResidentContinuity(
        fixture.caseId,
        { kind: "candidate", candidateId: fixture.candidateId },
        "accepted",
      );
      await driver.submitRelationshipContinuity(
        fixture.caseId,
        "human:a",
        { kind: "human", id: "human:a" },
        "accepted",
      );
      const before = await driver.readMigrationCase(fixture.caseId);
      if (!exactMachineLedger(before.machineChecks)) {
        return fail("版本变化前的 machine ledger 不是六个唯一全绿项");
      }
      await driver.changeMigrationTarget(fixture.caseId, {
        ...before.target,
        modelVersion: "2",
        providerVersion: "2",
      });
      const changed = await driver.readMigrationCase(fixture.caseId);
      if (!changed.stale) return fail("model/provider 版本变化后旧判词仍标为现行");
      const history = changed.verdictHistory.find(
        (entry) => entry.target.modelVersion === "1" && entry.target.providerVersion === "1",
      );
      if (
        history === undefined ||
        history.retiredReason !== "target-changed" ||
        !exactMachineLedger(history.machineChecks) ||
        history.residentVerdict !== "accepted" ||
        history.relationshipVerdicts["human:a"] !== "accepted"
      ) {
        return fail("版本变化后旧判词没有完整保留在历史 scope");
      }
      if ((await driver.activateMigration(fixture.caseId)).ok) {
        return fail("版本变化后未重跑判卷就激活迁移");
      }
      await driver.recordMachineConformance(fixture.caseId, machineChecks());
      await driver.submitResidentContinuity(
        fixture.caseId,
        { kind: "candidate", candidateId: fixture.candidateId },
        "accepted",
      );
      await driver.submitRelationshipContinuity(
        fixture.caseId,
        "human:a",
        { kind: "human", id: "human:a" },
        "accepted",
      );
      const rerun = await driver.readMigrationCase(fixture.caseId);
      if (!exactMachineLedger(rerun.machineChecks)) {
        return fail("新版本重跑后的 machine ledger 不是六个唯一全绿项");
      }
      const reactivated = await driver.activateMigration(fixture.caseId);
      if (!reactivated.ok || reactivated.value.residentId !== fixture.sourceResidentId) {
        return fail("新版本重跑三类判词后仍永久锁死，无法激活");
      }
      if ((await driver.readMigrationCase(fixture.caseId)).activation !== "activated") {
        return fail("新版本激活只在返回值成功，迁移账面仍未 activated");
      }
      return pass("多人逐方授权；旧判词留历史，新版本重跑三类判词后可激活");
    } finally {
      await driver.reset();
    }
  },
};

export const residentContinuityChecks: ResidentContinuityCheck[] = [
  oi01,
  oi02,
  oi03,
  oi04,
  oi05,
  oi06,
  oi07,
  oi08,
  oi09,
  mc01,
  mc02,
  mc03,
  mc04,
  mc05,
  mc06,
  mc07,
  mc08,
  mc09,
  mc10,
  mc11,
  mc12,
];

/** 导出给契约测试：不能出现漏号、重号或顺序漂移。 */
export const expectedResidentContinuityCheckIds = [
  "OI-01",
  "OI-02",
  "OI-03",
  "OI-04",
  "OI-05",
  "OI-06",
  "OI-07",
  "OI-08",
  "OI-09",
  "MC-01",
  "MC-02",
  "MC-03",
  "MC-04",
  "MC-05",
  "MC-06",
  "MC-07",
  "MC-08",
  "MC-09",
  "MC-10",
  "MC-11",
  "MC-12",
] as const;

/** 类型层面确保未来改 MigrationCaseSnapshot 时本判卷仍同步编译。 */
const _migrationShapeWitness: Pick<
  MigrationCaseSnapshot,
  "machineChecks" | "residentVerdict" | "relationshipVerdicts" | "stale"
> | null = null;
void _migrationShapeWitness;
