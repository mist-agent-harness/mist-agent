/**
 * #194 运行时出信绑定权威事实账的行为钉子（责任：运行时出信 + CLI 宿主装配）。
 *
 * 覆盖：
 * - 换气落盘信的 commitment 档只带 currentSet 的 seq 指针，不复制正文（图纸 §4.2）；
 * - supersede 后的条目不进信；
 * - 住户隔离：甲的账不进乙的信；
 * - ResidentStore 旧 string 承诺未入账时 breath-refused、逐条列出、给真实入口、
 *   不换代、不落信、不入账、不自动清（remedy 不承诺入账后即可换气）；
 * - say 走真实认证交付：成功回合 settle+ack，失败回合不 ack（读落盘 .facts.json 取证）；
 * - 换代后账窗重登记：新代 say/写正常，旧代不冒充新代。
 *
 * 端到端七灯归 acceptance/resident-runtime-*.ts；这里钉单元行为。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  BreatheOutcome,
  LetterTimeline,
  Result,
  TurnResult,
} from "../acceptance/resident-runtime-driver.ts";
import type { ModelCompletionRequest, ModelTransport } from "../src/resident-runtime/channels.ts";
import { ResidentRuntime } from "../src/resident-runtime/runtime.ts";
import { FactLedger } from "../src/store/fact-ledger.ts";
import { ResidentStore } from "../src/store/resident-store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mist-rt-ledger-"));
  dirs.push(dir);
  return dir;
}

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`预期成功却失败：${result.error.code} ${result.error.message}`);
  return result.value;
}
function failureOf<T>(result: Result<T>): { code: string; message: string; remedy: string } {
  if (result.ok) throw new Error("预期失败却成功");
  return { code: result.error.code, message: result.error.message, remedy: result.error.remedy };
}

const channel = {
  claudeSubscription: false,
  credentialKind: "api-key" as const,
  model: "model-alpha",
};

function fixedTransport(): { transport: ModelTransport; requests: ModelCompletionRequest[] } {
  const requests: ModelCompletionRequest[] = [];
  return {
    transport: {
      async *complete(request: ModelCompletionRequest): AsyncIterable<string> {
        requests.push(request);
        yield "收到。";
      },
    },
    requests,
  };
}

function activate(runtime: ResidentRuntime, residentId: string): void {
  const candidate = runtime.createCandidate({
    persona: `persona:${residentId}`,
    proposedBy: { kind: "installer", id: "ledger-test" },
    residentId,
  });
  expect(
    runtime.attestCandidate(
      candidate.candidateId,
      { kind: "candidate", candidateId: candidate.candidateId },
      "accepted",
    ).ok,
  ).toBe(true);
}

function provision(runtime: ResidentRuntime, residentId: string): void {
  if (!runtime.requireActiveResident(residentId).ok) activate(runtime, residentId);
  unwrap(runtime.provisionChannel({ residentId, channel, canarySecret: `sk-${residentId}` }));
}

function letterPath(root: string, residentId: string): string {
  return join(root, "letters", `${residentId}.letter-1.json`);
}

/** 落盘认证账快照：取某住户某窗的 ackedSeq / latestSeq（判卷不经公开 API 也能取证）。 */
function ledgerSnapshot(
  root: string,
  residentId: string,
): { entries: { seq: number }[]; viewports: { viewportId: string; ackedSeq: number }[] } {
  return JSON.parse(readFileSync(join(root, "residents", `${residentId}.facts.json`), "utf8")) as {
    entries: { seq: number }[];
    viewports: { viewportId: string; ackedSeq: number }[];
  };
}

describe("运行时出信绑定权威事实账", () => {
  it("只有本人 accepted 才物化 room 与账，配通道和身份查询不开户", async () => {
    const dataDir = tempDir();
    const runtime = new ResidentRuntime({
      dataDir,
      transport: fixedTransport().transport,
      ledger: { dataDir: join(dataDir, "residents") },
    });
    try {
      const residentId = "r-room-book";
      const candidate = runtime.createCandidate({
        persona: "synthetic persona",
        proposedBy: { kind: "installer", id: "room-book-test" },
        residentId,
      });
      const room = join(dataDir, "residents", `${residentId}.json`);
      const book = join(dataDir, "residents", `${residentId}.facts.json`);
      expect(runtime.requireActiveResident(candidate.candidateId).ok).toBe(false);
      expect(
        runtime.provisionChannel({ residentId, channel, canarySecret: "synthetic-only" }).ok,
      ).toBe(false);
      expect(
        runtime.attestCandidate(
          candidate.candidateId,
          { kind: "installer", id: "room-book-test" },
          "accepted",
        ).ok,
      ).toBe(false);
      expect(existsSync(room)).toBe(false);
      expect(existsSync(book)).toBe(false);
      expect(
        runtime.attestCandidate(
          candidate.candidateId,
          { kind: "candidate", candidateId: candidate.candidateId },
          "accepted",
        ).ok,
      ).toBe(true);
      expect(existsSync(room)).toBe(true);
      expect(existsSync(book)).toBe(true);
      expect(runtime.ledgerAuthority()?.ledger.currentSet(residentId)).toEqual([]);
      // 不需要先 provision：认证 writer 在 active room 物化后已经能向账追加。
      runtime
        .ledgerAuthority()
        ?.host.system("mist-host")
        .append(
          residentId,
          { kind: "active_rule", body: "synthetic promise" },
          "synthetic fixture",
        );
      const before = readFileSync(book, "utf8");
      unwrap(runtime.provisionChannel({ residentId, channel, canarySecret: "synthetic-only" }));
      expect(readFileSync(book, "utf8")).toBe(before);
      const rejected = runtime.createCandidate({
        persona: "rejected persona",
        proposedBy: { kind: "installer", id: "room-book-test" },
        residentId: "r-rejected-book",
      });
      expect(
        runtime.attestCandidate(
          rejected.candidateId,
          { kind: "candidate", candidateId: rejected.candidateId },
          "rejected",
        ).ok,
      ).toBe(true);
      expect(existsSync(join(dataDir, "residents", "r-rejected-book.facts.json"))).toBe(false);
    } finally {
      await runtime.close();
    }
  });

  it("启动时为已有 active room 补齐认证账，重启不重建既有账或代签身份", async () => {
    const dataDir = tempDir();
    // 模拟已合身份入口在无认证账嵌入方物化了 room；启动装配承担账恢复。
    const prep = new ResidentRuntime({ dataDir, transport: fixedTransport().transport });
    activate(prep, "r-recovered-book");
    await prep.close();
    const book = join(dataDir, "residents", "r-recovered-book.facts.json");
    expect(existsSync(book)).toBe(false);
    const options = {
      dataDir,
      transport: fixedTransport().transport,
      ledger: { dataDir: join(dataDir, "residents") },
    };
    const restored = new ResidentRuntime(options);
    try {
      expect(restored.requireActiveResident("r-recovered-book").ok).toBe(true);
      expect(existsSync(book)).toBe(true);
      restored
        .ledgerAuthority()
        ?.host.system("mist-host")
        .append(
          "r-recovered-book",
          { kind: "active_rule", body: "recover me" },
          "synthetic fixture",
        );
    } finally {
      await restored.close();
    }
    const before = readFileSync(book, "utf8");
    const again = new ResidentRuntime(options);
    try {
      expect(readFileSync(book, "utf8")).toBe(before);
      expect(
        again
          .ledgerAuthority()
          ?.ledger.currentSet("r-recovered-book")
          .map((entry) => entry.body),
      ).toEqual(["recover me"]);
    } finally {
      await again.close();
    }
  });

  it("换气落盘信的 commitment 档只带 currentSet 指针，supersede 的不装", async () => {
    const dataDir = tempDir();
    const stub = fixedTransport();
    const runtime = new ResidentRuntime({
      dataDir,
      transport: stub.transport,
      ledger: { dataDir: join(dataDir, "residents") },
    });
    try {
      provision(runtime, "r-letter");
      const authority = runtime.ledgerAuthority();
      expect(authority).not.toBeNull();
      if (authority === null) return;
      const kept = authority.host
        .system("mist-host")
        .append("r-letter", { kind: "ruling", body: "我答应过每周写一封" }, "宿主维护：立裁定");
      const doomed = authority.host
        .system("mist-host")
        .append(
          "r-letter",
          { kind: "confirmed_preference", body: "这条会被解除" },
          "宿主维护：立条",
        );
      authority.host
        .system("mist-host")
        .supersede("r-letter", doomed.seq, { reason: "已失效" }, "宿主维护：解除");

      unwrap<TurnResult>(await runtime.say({ residentId: "r-letter", text: "在吗" }));
      const outcome = unwrap<BreatheOutcome>(
        await runtime.breathe({ residentId: "r-letter", via: "new" }),
      );
      expect(outcome.fromGeneration).toBe(1);
      expect(outcome.toGeneration).toBe(2);

      const sealed = JSON.parse(readFileSync(letterPath(dataDir, "r-letter"), "utf8")) as {
        state: { tier: string; body: string; ledgerSeq?: number }[];
      };
      const commitments = sealed.state.filter((item) => item.tier === "commitment");
      expect(commitments).toHaveLength(1);
      expect(commitments[0]).toMatchObject({
        body: `账上第 ${kept.seq} 条`,
        ledgerSeq: kept.seq,
      });
      expect(authority.ledger.entries("r-letter").map((e) => e.seq)).toContain(doomed.seq);
      const timeline = unwrap<LetterTimeline>(runtime.letterTimeline({ residentId: "r-letter" }));
      expect(timeline.letters).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });

  it("封存信只带承诺指针；解除后新代有效事实不再带旧正文，原信不改", async () => {
    const dataDir = tempDir();
    const stub = fixedTransport();
    const runtime = new ResidentRuntime({
      dataDir,
      transport: stub.transport,
      ledger: { dataDir: join(dataDir, "residents") },
    });
    try {
      provision(runtime, "r-pointer");
      const authority = runtime.ledgerAuthority();
      if (authority === null) throw new Error("缺认证账");
      const fact = authority.host
        .system("mist-host")
        .append(
          "r-pointer",
          { kind: "active_rule", body: "只在权威账上保存的承诺正文" },
          "宿主维护",
        );
      unwrap(await runtime.say({ residentId: "r-pointer", text: "第一代" }));
      expect(stub.requests[0]?.bootPack.currentFacts).toContainEqual(fact);
      unwrap(await runtime.breathe({ residentId: "r-pointer", via: "new" }));
      const original = readFileSync(letterPath(dataDir, "r-pointer"), "utf8");
      const letter = JSON.parse(original) as {
        state: { tier: string; body: string; ledgerSeq?: number }[];
      };
      const commitments = letter.state.filter((item) => item.tier === "commitment");
      expect(commitments).toHaveLength(1);
      expect(commitments[0]?.ledgerSeq).toBe(fact.seq);
      expect(commitments[0]?.body).not.toContain(fact.body);

      authority.host
        .system("mist-host")
        .supersede("r-pointer", fact.seq, { reason: "承诺解除" }, "宿主维护");
      unwrap(await runtime.say({ residentId: "r-pointer", text: "第二代" }));
      expect(stub.requests.at(-1)?.bootPack.currentFacts?.map((entry) => entry.seq)).not.toContain(
        fact.seq,
      );
      expect(readFileSync(letterPath(dataDir, "r-pointer"), "utf8")).toBe(original);
    } finally {
      await runtime.close();
    }
  });

  it("住户隔离：甲的账不进乙的启动包、也不进乙的信", async () => {
    const dataDir = tempDir();
    const stub = fixedTransport();
    const runtime = new ResidentRuntime({
      dataDir,
      transport: stub.transport,
      ledger: { dataDir: join(dataDir, "residents") },
    });
    try {
      provision(runtime, "r-iso-a");
      provision(runtime, "r-iso-b");
      const authority = runtime.ledgerAuthority();
      if (authority === null) throw new Error("缺认证账");
      authority.host
        .system("mist-host")
        .append("r-iso-a", { kind: "ruling", body: "甲的秘密裁定" }, "宿主维护");

      unwrap<TurnResult>(await runtime.say({ residentId: "r-iso-a", text: "甲说话" }));
      unwrap<TurnResult>(await runtime.say({ residentId: "r-iso-b", text: "乙说话" }));
      expect(stub.requests[0]?.bootPack.currentFacts?.map((f) => f.body)).toContain("甲的秘密裁定");
      expect(stub.requests[1]?.bootPack.currentFacts?.map((f) => f.body) ?? []).not.toContain(
        "甲的秘密裁定",
      );

      unwrap<BreatheOutcome>(await runtime.breathe({ residentId: "r-iso-b", via: "new" }));
      const sealedB = JSON.parse(readFileSync(letterPath(dataDir, "r-iso-b"), "utf8")) as {
        state: { tier: string; body: string }[];
      };
      expect(sealedB.state.filter((i) => i.tier === "commitment")).toHaveLength(0);
    } finally {
      await runtime.close();
    }
  });

  it("旧 string 承诺未入账：breath-refused、逐条列出、给真实入口、不换代不落信不入账不清数据", async () => {
    const dataDir = tempDir();
    const stub = fixedTransport();
    const prep = new ResidentRuntime({ dataDir, transport: fixedTransport().transport });
    activate(prep, "r-old");
    await prep.close();
    const residents = new ResidentStore({ dataDir: join(dataDir, "residents") });
    residents.commit("r-old", "旧档案里的一句话承诺");
    residents.commit("r-old", "旧档案里的第二句话");
    const runtime = new ResidentRuntime({
      dataDir,
      transport: stub.transport,
      ledger: { dataDir: join(dataDir, "residents") },
    });
    try {
      provision(runtime, "r-old");
      unwrap<TurnResult>(await runtime.say({ residentId: "r-old", text: "在" }));
      const authority = runtime.ledgerAuthority();
      if (authority === null) throw new Error("缺认证账");
      const entriesBefore = authority.ledger.entries("r-old").length;

      const refused = failureOf(await runtime.breathe({ residentId: "r-old", via: "new" }));
      expect(refused.code).toBe("breath-refused");
      expect(refused.message).toContain("旧档案里的一句话承诺");
      expect(refused.message).toContain("旧档案里的第二句话");
      expect(refused.remedy.trim().length).toBeGreaterThan(0);
      // 入口指到真实宿主 API（system.append），不是编造的终端命令；且不承诺入账后即可换气。
      expect(refused.remedy).toContain("system");
      expect(refused.remedy).toContain("active_rule");
      expect(refused.remedy).toContain("另单");

      expect(unwrap(runtime.letterTimeline({ residentId: "r-old" })).letters).toHaveLength(0);
      expect(readdirSync(join(dataDir, "letters"))).toEqual([]);
      expect(authority.ledger.entries("r-old").length).toBe(entriesBefore);
      expect(residents.commitments("r-old")).toEqual([
        "旧档案里的一句话承诺",
        "旧档案里的第二句话",
      ]);
    } finally {
      await runtime.close();
    }
  });

  it("say 走真实认证交付：成功回合 ack 推进到 latestSeq，失败回合不 ack", async () => {
    const dataDir = tempDir();
    const stub = fixedTransport();
    const runtime = new ResidentRuntime({
      dataDir,
      transport: stub.transport,
      ledger: { dataDir: join(dataDir, "residents") },
    });
    try {
      provision(runtime, "r-ack");
      unwrap<TurnResult>(await runtime.say({ residentId: "r-ack", text: "第一句" }));
      const afterFirst = ledgerSnapshot(dataDir, "r-ack");
      expect(afterFirst.entries.length).toBeGreaterThanOrEqual(0);

      // 窗开之后宿主再落一条新裁定：说一句成功，ack 必须推进到 latestSeq。
      const authority = runtime.ledgerAuthority();
      if (authority === null) throw new Error("缺认证账");
      authority.host
        .system("mist-host")
        .append("r-ack", { kind: "ruling", body: "后落的新裁定" }, "宿主维护");
      const snapshotPending = ledgerSnapshot(dataDir, "r-ack");
      const windowId = snapshotPending.viewports[0]?.viewportId;
      if (windowId === undefined) throw new Error("账里没有窗确认位");
      expect(snapshotPending.viewports[0]?.ackedSeq).toBeLessThan(snapshotPending.entries.length);

      unwrap<TurnResult>(await runtime.say({ residentId: "r-ack", text: "第二句" }));
      const afterSecond = ledgerSnapshot(dataDir, "r-ack");
      expect(afterSecond.viewports[0]?.ackedSeq).toBe(afterSecond.entries.length);
      // 正对照：这条新裁定确实进了模型请求的 currentFacts。
      expect(stub.requests.at(-1)?.bootPack.currentFacts?.map((f) => f.body)).toContain(
        "后落的新裁定",
      );
    } finally {
      await runtime.close();
    }
  });

  it("失败回合不 ack：通道报错后窗确认位不动", async () => {
    const dataDir = tempDir();
    // 先成功起窗（确认位落在 baseline），再落一条账后失败的回合——缺口是账后新造的。
    let calls = 0;
    const firstOkThenFail: ModelTransport = {
      async *complete(request: ModelCompletionRequest): AsyncIterable<string> {
        calls += 1;
        if (calls === 1) {
          yield "收到。";
          return;
        }
        throw new Error("channel down");
      },
    };
    const runtime = new ResidentRuntime({
      dataDir,
      transport: firstOkThenFail,
      ledger: { dataDir: join(dataDir, "residents") },
    });
    try {
      provision(runtime, "r-noack");
      unwrap<TurnResult>(await runtime.say({ residentId: "r-noack", text: "起窗" }));
      const authority = runtime.ledgerAuthority();
      if (authority === null) throw new Error("缺认证账");
      authority.host
        .system("mist-host")
        .append("r-noack", { kind: "ruling", body: "还没读到的裁定" }, "宿主维护");
      const refused = failureOf(await runtime.say({ residentId: "r-noack", text: "会失败" }));
      expect(refused.code).toBe("channel-unavailable");
      const snapshot = ledgerSnapshot(dataDir, "r-noack");
      // 失败回合不许 ack：确认位仍 < latestSeq（缺口保留，下轮重拉）。
      expect(snapshot.viewports[0]?.ackedSeq).toBeLessThan(snapshot.entries.length);
    } finally {
      await runtime.close();
    }
  });

  it("ledger 与 factLedger 互斥：同时给直接构造失败，不静默顶掉另一本", () => {
    const dataDir = tempDir();
    const { ledger } = FactLedger.create();
    expect(
      () =>
        new ResidentRuntime({
          dataDir,
          factLedger: ledger,
          ledger: { dataDir: join(dataDir, "residents") },
        }),
    ).toThrow(/只接一种账模式/);
  });

  it("确认位落盘失败返回结构化错误，已落流回复保留，缺口下回合重新交付", async () => {
    const dataDir = tempDir();
    const blockedPath = join(dataDir, "residents", "r-ack-write.facts.json.tmp");
    let calls = 0;
    const runtime = new ResidentRuntime({
      dataDir,
      ledger: { dataDir: join(dataDir, "residents") },
      transport: {
        async *complete() {
          calls += 1;
          yield "成功的模型回复";
          if (calls === 2) mkdirSync(blockedPath);
        },
      },
    });
    try {
      provision(runtime, "r-ack-write");
      unwrap(await runtime.say({ residentId: "r-ack-write", text: "起窗" }));
      const authority = runtime.ledgerAuthority();
      if (authority === null) throw new Error("缺认证账");
      authority.host
        .system("mist-host")
        .append("r-ack-write", { kind: "active_rule", body: "还未确认的约束" }, "宿主维护");
      const result = await runtime.say({ residentId: "r-ack-write", text: "确认落盘会失败" });
      expect(failureOf(result).code).toBe("writer-unavailable");
      expect(unwrap(runtime.readStream({ residentId: "r-ack-write" })).events).toHaveLength(4);
      const failed = ledgerSnapshot(dataDir, "r-ack-write");
      expect(failed.viewports[0]?.ackedSeq).toBeLessThan(failed.entries.length);
      rmSync(blockedPath, { recursive: true });
      unwrap(await runtime.say({ residentId: "r-ack-write", text: "修复后重新交付" }));
      const retried = ledgerSnapshot(dataDir, "r-ack-write");
      expect(retried.viewports[0]?.ackedSeq).toBe(retried.entries.length);
    } finally {
      await runtime.close();
    }
  });

  it("到线回合在换代前确认账，下一代与重启后仍读到同一现行条目", async () => {
    const dataDir = tempDir();
    const stub = fixedTransport();
    const options = {
      dataDir,
      transport: stub.transport,
      ledger: { dataDir: join(dataDir, "residents") },
    };
    const first = new ResidentRuntime(options);
    try {
      provision(first, "r-threshold");
      unwrap(await first.say({ residentId: "r-threshold", text: "起窗" }));
      const authority = first.ledgerAuthority();
      if (authority === null) throw new Error("缺认证账");
      const fact = authority.host
        .system("mist-host")
        .append(
          "r-threshold",
          { kind: "active_rule", body: "下一代也要继承" },
          "明确的宿主维护动作",
        );
      const windowId = ledgerSnapshot(dataDir, "r-threshold").viewports[0]?.viewportId;
      if (windowId === undefined) throw new Error("缺窗确认位");
      unwrap(
        first.setBreathThreshold({
          residentId: "r-threshold",
          windowId,
          generation: 1,
          thresholdTokens: 1,
          authority: "owner",
        }),
      );
      // 主人设线从第二代生效；第一代先手动换气。
      unwrap(await first.breathe({ residentId: "r-threshold", via: "new" }));
      unwrap(await first.say({ residentId: "r-threshold", text: "第二代第一回合到线" }));
      unwrap(
        first.setBreathThreshold({
          residentId: "r-threshold",
          windowId,
          generation: 3,
          thresholdTokens: 1,
          authority: "owner",
        }),
      );
      authority.host
        .system("mist-host")
        .append("r-threshold", { kind: "active_rule", body: "第三代回合前的新约束" }, "宿主维护");
      const pending = ledgerSnapshot(dataDir, "r-threshold");
      expect(pending.viewports[0]?.ackedSeq).toBeLessThan(pending.entries.length);
      unwrap(await first.say({ residentId: "r-threshold", text: "第三代回合到线" }));
      // say 已换代，但第三代回执必须在离开第三代前确认。
      const acknowledged = ledgerSnapshot(dataDir, "r-threshold");
      expect(acknowledged.viewports[0]?.ackedSeq).toBe(acknowledged.entries.length);
      const sealed = JSON.parse(
        readFileSync(join(dataDir, "letters", "r-threshold.letter-3.json"), "utf8"),
      ) as { state: { tier: string; ledgerSeq?: number; body: string }[] };
      expect(sealed.state).toContainEqual({
        tier: "commitment",
        ledgerSeq: fact.seq,
        body: `账上第 ${fact.seq} 条`,
      });
    } finally {
      await first.close();
    }
    const second = new ResidentRuntime(options);
    try {
      const result = unwrap(
        await second.say({ residentId: "r-threshold", text: "重启后仍能接续" }),
      );
      expect(result.generation).toBeGreaterThan(3);
      expect(stub.requests.at(-1)?.bootPack.currentFacts?.map((entry) => entry.body)).toContain(
        "下一代也要继承",
      );
      const snapshot = ledgerSnapshot(dataDir, "r-threshold");
      expect(snapshot.viewports[0]?.ackedSeq).toBe(snapshot.entries.length);
    } finally {
      await second.close();
    }
  });

  it("换代后账窗重登记：手动换气的下一代 say 正常且 ack 覆盖新代", async () => {
    const dataDir = tempDir();
    const stub = fixedTransport();
    const runtime = new ResidentRuntime({
      dataDir,
      transport: stub.transport,
      ledger: { dataDir: join(dataDir, "residents") },
    });
    try {
      provision(runtime, "r-gen");
      unwrap<TurnResult>(await runtime.say({ residentId: "r-gen", text: "第一代" }));
      unwrap<BreatheOutcome>(await runtime.breathe({ residentId: "r-gen", via: "new" }));
      // 换代由 BreathCycle 在账外完成；缓存命中的新代若未重登记，这句 say 会报
      // writer-unavailable（prepareDelivery 判 alignment）。
      const afterBreathe = unwrap<TurnResult>(
        await runtime.say({ residentId: "r-gen", text: "第二代" }),
      );
      expect(afterBreathe.generation).toBe(2);
      const snapshot = ledgerSnapshot(dataDir, "r-gen");
      expect(snapshot.viewports[0]?.ackedSeq).toBe(snapshot.entries.length);
    } finally {
      await runtime.close();
    }
  });
});
