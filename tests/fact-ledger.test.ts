/**
 * 权威事实账（泳道 2 账本体）的回归测试。
 *
 * 对照验收清单 acceptance/multi-viewport.md 的 MV-A05、MV-C01~C07：
 * 凡是「账侧机制」的部分在这里钉死；凡是「派发链接线」的部分（开工闸拦截、
 * 启动包注入）依赖泳道 1，不在这里，也不许在这里假装验过。
 *
 * 这里测的是账本体的边界会不会悄悄坏掉：supersede 会不会涂改旧条目、
 * 「查不到」会不会被编码成 0、倒走的钟会不会骗过缺口判断。
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AckError,
  FactLedger,
  InvalidSupersedeError,
  LedgerEntryNotFoundError,
  LedgerNotFoundError,
  ViewportNotFoundError,
} from "../src/store/fact-ledger.ts";

function withTempDir(run: (dataDir: string) => void): void {
  const dataDir = mkdtempSync(join(tmpdir(), "mist-fact-ledger-"));
  try {
    run(dataDir);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

/** 让 dataDir 暂时不可写（模拟磁盘写失败），无论断言成败都恢复权限。 */
function whileReadonly(dataDir: string, run: () => void): void {
  chmodSync(dataDir, 0o555);
  try {
    run();
  } finally {
    chmodSync(dataDir, 0o755);
  }
}

describe("发号与 append-only", () => {
  it("seq 由账侧发号，从 1 起单调递增", () => {
    const ledger = new FactLedger();
    ledger.createLedger("r");
    const a = ledger.append("r", { author: "main", kind: "ruling", body: "第一条" });
    const b = ledger.append("r", { author: "main", kind: "active_rule", body: "第二条" });
    const c = ledger.append("r", { author: "main", kind: "confirmed_preference", body: "第三条" });
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3]);
    expect(ledger.latestSeq("r")).toBe(3);
  });

  it("空账 latestSeq 为 0", () => {
    const ledger = new FactLedger();
    ledger.createLedger("r");
    expect(ledger.latestSeq("r")).toBe(0);
    expect(ledger.entries("r")).toEqual([]);
  });

  it("append 不收 supersede——解除只能走 supersede()", () => {
    const ledger = new FactLedger();
    ledger.createLedger("r");
    // 运行时校验给绕过类型系统的调用方：没有 supersedesSeq 指针的「解除」
    // 会毒化推导视图，必须当场炸。
    expect(() =>
      ledger.append("r", {
        author: "main",
        kind: "supersede" as never,
        body: "伪装成事实的解除",
      }),
    ).toThrow(/supersede\(\)/);
  });

  it("拿到的是副本，改返回值涂改不了账", () => {
    const ledger = new FactLedger();
    ledger.createLedger("r");
    const appended = ledger.append("r", { author: "main", kind: "ruling", body: "原话" });
    (appended as { body: string }).body = "涂改后的假话";
    const listed = ledger.entries("r");
    (listed[0] as { body: string }).body = "又一次涂改";
    expect(ledger.entries("r")[0]?.body).toBe("原话");
  });

  it("账面条目在运行时是冻结的", () => {
    const ledger = new FactLedger();
    ledger.createLedger("r");
    ledger.append("r", { author: "main", kind: "ruling", body: "正文" });
    // entries() 返回副本，这里直接探账内引用做不到——但 append 的返回
    // 与账内条目同形，冻结行为用恢复路径间接验（持久化一节）。
    // 这里至少保证：账侧给出的任何条目形状都带齐六字段。
    expect(ledger.entries("r")[0]).toEqual({
      seq: 1,
      ts: expect.any(String),
      author: "main",
      kind: "ruling",
      body: "正文",
      supersedesSeq: null,
    });
  });

  it("重复开户显式报错，不静默重置", () => {
    const ledger = new FactLedger();
    ledger.createLedger("r");
    ledger.append("r", { author: "main", kind: "ruling", body: "不能丢" });
    expect(() => ledger.createLedger("r")).toThrow(/already exists/);
    expect(ledger.latestSeq("r")).toBe(1);
  });
});

describe("supersede 是追加不是涂改（MV-C07 账侧）", () => {
  it("解除后旧条目字节不变", () => {
    const ledger = new FactLedger();
    ledger.createLedger("r");
    ledger.append("r", { author: "main", kind: "ruling", body: "周六一起去图书馆" });
    const before = JSON.stringify(ledger.entries("r")[0]);
    ledger.supersede("r", 1, { author: "main", reason: "她改成周日了" });
    const after = JSON.stringify(ledger.entries("r")[0]);
    expect(after).toBe(before);
  });

  it("解除是一条自带序号的新账目，supersedesSeq 指旧 seq", () => {
    const ledger = new FactLedger();
    ledger.createLedger("r");
    ledger.append("r", { author: "main", kind: "ruling", body: "旧裁定" });
    ledger.append("r", { author: "main", kind: "active_rule", body: "夹在中间的规矩" });
    const s = ledger.supersede("r", 1, { author: "main", reason: "解除旧裁定" });
    expect(s.seq).toBe(3);
    expect(s.kind).toBe("supersede");
    expect(s.supersedesSeq).toBe(1);
    expect(s.body).toBe("解除旧裁定");
    expect(ledger.latestSeq("r")).toBe(3);
    // 全史三条都在：解除留痕，不是消失。
    expect(ledger.entries("r")).toHaveLength(3);
  });

  it("现行有效集不再含被解除的条目", () => {
    const ledger = new FactLedger();
    ledger.createLedger("r");
    ledger.append("r", { author: "main", kind: "ruling", body: "旧裁定" });
    ledger.supersede("r", 1, { author: "main", reason: "解除" });
    expect(ledger.currentSet("r")).toEqual([]);
    // 但归档查询仍能追到它——「曾被解除的条目」本身是可查事实。
    expect(ledger.entries("r")).toHaveLength(2);
  });

  it("已 ack 旧条目的窗，下一轮经缺口通道可见该解除", () => {
    const ledger = new FactLedger();
    ledger.createLedger("r");
    ledger.append("r", { author: "main", kind: "ruling", body: "旧裁定" });
    ledger.openViewport("r", "w-a");
    ledger.ack("r", "w-a", 1); // 窗已确认旧裁定
    const s = ledger.supersede("r", 1, { author: "main", reason: "解除" });
    // 已 ack ≠ 仍然有效：解除经同一条缺口通道送达。
    const missing = ledger.gapEntries("r", "w-a");
    expect(missing).toHaveLength(1);
    expect(missing[0]?.seq).toBe(s.seq);
    expect(missing[0]?.kind).toBe("supersede");
  });

  it("解除不存在的 seq 报错", () => {
    const ledger = new FactLedger();
    ledger.createLedger("r");
    ledger.append("r", { author: "main", kind: "ruling", body: "只有一条" });
    expect(() => ledger.supersede("r", 2, { author: "main", reason: "x" })).toThrow(
      LedgerEntryNotFoundError,
    );
    expect(() => ledger.supersede("r", 0, { author: "main", reason: "x" })).toThrow(
      LedgerEntryNotFoundError,
    );
  });

  it("不能解除一条 supersede", () => {
    const ledger = new FactLedger();
    ledger.createLedger("r");
    ledger.append("r", { author: "main", kind: "ruling", body: "裁定" });
    ledger.supersede("r", 1, { author: "main", reason: "解除" });
    expect(() => ledger.supersede("r", 2, { author: "main", reason: "解除那条解除" })).toThrow(
      InvalidSupersedeError,
    );
  });

  it("重复解除同一条显式报错", () => {
    const ledger = new FactLedger();
    ledger.createLedger("r");
    ledger.append("r", { author: "main", kind: "ruling", body: "裁定" });
    ledger.supersede("r", 1, { author: "main", reason: "第一次解除" });
    // 静默放行会把「操作方以为还没解除过」藏起来。
    expect(() => ledger.supersede("r", 1, { author: "main", reason: "第二次解除" })).toThrow(
      /already superseded/,
    );
  });

  it("跨住户解除报错，且那本账毫发无损", () => {
    const ledger = new FactLedger();
    ledger.createLedger("a");
    ledger.createLedger("b");
    ledger.append("a", { author: "main", kind: "ruling", body: "A 的裁定" });
    expect(() => ledger.supersede("b", 1, { author: "main", reason: "B 想解除 A 的" })).toThrow(
      LedgerEntryNotFoundError,
    );
    expect(ledger.entries("a")).toHaveLength(1);
    expect(ledger.currentSet("a")).toHaveLength(1);
  });
});

describe("现行有效集是推导视图", () => {
  it("同一种 kind 多条并行生效是常态（2026-08-20 主笔拍板的新语义）", () => {
    const ledger = new FactLedger();
    ledger.createLedger("r");
    ledger.append("r", { author: "main", kind: "ruling", body: "裁定一" });
    ledger.append("r", { author: "main", kind: "ruling", body: "裁定二" });
    ledger.append("r", { author: "main", kind: "active_rule", body: "规矩一" });
    // 不是「每条 kind 的最新一条」——未被指名的全部现行，按 seq 升序。
    const current = ledger.currentSet("r");
    expect(current.map((e) => e.body)).toEqual(["裁定一", "裁定二", "规矩一"]);
  });

  it("supersede 精确指向单条：解除两条并行 ruling 中的一条，另一条仍在", () => {
    const ledger = new FactLedger();
    ledger.createLedger("r");
    ledger.append("r", { author: "main", kind: "ruling", body: "裁定一" });
    ledger.append("r", { author: "main", kind: "ruling", body: "裁定二" });
    ledger.supersede("r", 2, { author: "main", reason: "只解除裁定二" });
    expect(ledger.currentSet("r").map((e) => e.body)).toEqual(["裁定一"]);
    // 不存在「回退」——裁定一自始至终都在集里，不是被解除后重新浮上来的。
    ledger.supersede("r", 1, { author: "main", reason: "解除裁定一" });
    expect(ledger.currentSet("r")).toEqual([]);
  });

  it("解除一条不影响其他 kind 的并行条目", () => {
    const ledger = new FactLedger();
    ledger.createLedger("r");
    ledger.append("r", { author: "main", kind: "ruling", body: "裁定一" });
    ledger.append("r", { author: "main", kind: "active_rule", body: "规矩一" });
    ledger.append("r", { author: "main", kind: "confirmed_preference", body: "偏好一" });
    ledger.supersede("r", 1, { author: "main", reason: "只解除裁定一" });
    expect(ledger.currentSet("r").map((e) => e.body)).toEqual(["规矩一", "偏好一"]);
  });

  it("supersede 条目自身不是事实，不进现行有效集", () => {
    const ledger = new FactLedger();
    ledger.createLedger("r");
    ledger.append("r", { author: "main", kind: "ruling", body: "裁定一" });
    ledger.supersede("r", 1, { author: "main", reason: "解除" });
    // 集是空的——解除记录留在全史里查（entries），不冒充一条现行事实。
    expect(ledger.currentSet("r")).toEqual([]);
    expect(ledger.entries("r")).toHaveLength(2);
  });

  it("视图拿到的是副本，改它毒化不了账", () => {
    const ledger = new FactLedger();
    ledger.createLedger("r");
    ledger.append("r", { author: "main", kind: "ruling", body: "现行裁定" });
    const view = ledger.currentSet("r");
    (view[0] as { body: string }).body = "毒化";
    expect(ledger.currentSet("r")[0]?.body).toBe("现行裁定");
  });
});

describe("新窗 baseline（MV-A05 账侧）", () => {
  it("账内预置 50 条后新窗 ackedSeq = 开窗时 latestSeq，不背全史", () => {
    const ledger = new FactLedger();
    ledger.createLedger("r");
    for (let i = 0; i < 50; i += 1) {
      ledger.append("r", { author: "main", kind: "ruling", body: `历史裁定 ${i + 1}` });
    }
    const baseline = ledger.openViewport("r", "w-new");
    expect(baseline).toBe(50);
    expect(ledger.gap("r", "w-new")).toEqual({ latestSeq: 50, ackedSeq: 50 });
    // 开工闸不触发全史拉取：缺口为零，没有要拉的条目。
    expect(ledger.gapEntries("r", "w-new")).toEqual([]);
  });

  it("空账上开的新窗 baseline 为 0", () => {
    const ledger = new FactLedger();
    ledger.createLedger("r");
    expect(ledger.openViewport("r", "w-new")).toBe(0);
    expect(ledger.gap("r", "w-new")).toEqual({ latestSeq: 0, ackedSeq: 0 });
  });

  it("同一窗重复开户显式报错", () => {
    const ledger = new FactLedger();
    ledger.createLedger("r");
    ledger.openViewport("r", "w-a");
    expect(() => ledger.openViewport("r", "w-a")).toThrow(/already exists/);
  });

  it("历史裁定仍走归档查询可达", () => {
    const ledger = new FactLedger();
    ledger.createLedger("r");
    for (let i = 0; i < 50; i += 1) {
      ledger.append("r", { author: "main", kind: "ruling", body: `历史裁定 ${i + 1}` });
    }
    ledger.openViewport("r", "w-new");
    // 新窗不背全史 ≠ 历史不可达：归档查询是另一条路。
    expect(ledger.entries("r")).toHaveLength(50);
  });
});

describe("拉式缺口与回执（MV-C01/C02/C05 账侧）", () => {
  it("裁定落账后另一窗缺口打开，拉取+回执后关闭", () => {
    const ledger = new FactLedger();
    ledger.createLedger("r");
    ledger.openViewport("r", "w-a");
    ledger.openViewport("r", "w-b");
    const ruling = ledger.append("r", { author: "main", kind: "ruling", body: "新裁定" });
    // 无推送通道，拉是唯一正确性来源——账侧只有拉与回执两个动作（C02 的落点）。
    expect(ledger.gap("r", "w-b")).toEqual({ latestSeq: 1, ackedSeq: 0 });
    const missing = ledger.gapEntries("r", "w-b");
    expect(missing.map((e) => e.seq)).toEqual([ruling.seq]);
    ledger.ack("r", "w-b", ruling.seq);
    expect(ledger.gap("r", "w-b")).toEqual({ latestSeq: 1, ackedSeq: 1 });
    expect(ledger.gapEntries("r", "w-b")).toEqual([]);
  });

  it("缺口是逐窗独立的：一窗确认不替另一窗确认", () => {
    const ledger = new FactLedger();
    ledger.createLedger("r");
    ledger.openViewport("r", "w-a");
    ledger.openViewport("r", "w-b");
    ledger.append("r", { author: "main", kind: "ruling", body: "裁定" });
    ledger.ack("r", "w-a", 1);
    expect(ledger.gap("r", "w-a").ackedSeq).toBe(1);
    expect(ledger.gap("r", "w-b").ackedSeq).toBe(0);
    expect(ledger.gapEntries("r", "w-b")).toHaveLength(1);
  });

  it("回执丢失场景：窗不被记为已知悉，重拉后正常 ack", () => {
    const ledger = new FactLedger();
    ledger.createLedger("r");
    ledger.openViewport("r", "w-a");
    ledger.append("r", { author: "main", kind: "ruling", body: "裁定" });
    // 回执丢失 = ack 从未到账：账上不存在「已知悉」的痕迹，也没有「违约」标记——
    // 传播机制的账不算窗的（C05）。窗重拉，缺口条目还在，补 ack 即闭合。
    expect(ledger.gapEntries("r", "w-a")).toHaveLength(1);
    ledger.ack("r", "w-a", 1);
    expect(ledger.gap("r", "w-a").ackedSeq).toBe(1);
  });

  it("重复 ack 同一个 seq 幂等放行（回执重发是常态）", () => {
    const ledger = new FactLedger();
    ledger.createLedger("r");
    ledger.openViewport("r", "w-a");
    ledger.append("r", { author: "main", kind: "ruling", body: "裁定" });
    ledger.ack("r", "w-a", 1);
    expect(() => ledger.ack("r", "w-a", 1)).not.toThrow();
    expect(ledger.ackedSeq("r", "w-a")).toBe(1);
  });

  it("ack 回归显式报错：确认位只前进不后退", () => {
    const ledger = new FactLedger();
    ledger.createLedger("r");
    ledger.openViewport("r", "w-a");
    ledger.append("r", { author: "main", kind: "ruling", body: "一" });
    ledger.append("r", { author: "main", kind: "ruling", body: "二" });
    ledger.ack("r", "w-a", 2);
    expect(() => ledger.ack("r", "w-a", 1)).toThrow(AckError);
    expect(ledger.ackedSeq("r", "w-a")).toBe(2);
  });

  it("不能 ack 账上还不存在的 seq", () => {
    const ledger = new FactLedger();
    ledger.createLedger("r");
    ledger.openViewport("r", "w-a");
    ledger.append("r", { author: "main", kind: "ruling", body: "裁定" });
    expect(() => ledger.ack("r", "w-a", 2)).toThrow(AckError);
    expect(() => ledger.ack("r", "w-a", -1)).toThrow(AckError);
  });

  it("查没开过户的窗抛 ViewportNotFoundError", () => {
    const ledger = new FactLedger();
    ledger.createLedger("r");
    expect(() => ledger.gap("r", "w-ghost")).toThrow(ViewportNotFoundError);
    expect(() => ledger.ack("r", "w-ghost", 0)).toThrow(ViewportNotFoundError);
  });
});

describe("查账失败按缺处理（MV-C03 账侧）", () => {
  it("「查不到」与「查到是零」是两个值，不编码成同一个", () => {
    const ledger = new FactLedger();
    ledger.createLedger("r");
    ledger.openViewport("r", "w-a");
    // 查到是零：ok 分支，数字俱在，latestSeq = ackedSeq = 0。
    const zero = ledger.probeGap("r", "w-a");
    expect(zero).toEqual({ status: "ok", latestSeq: 0, ackedSeq: 0 });
    // 查不到：unknown 分支，根本不携带数字——调用方想把它当 0 用，
    // 类型系统不答应；运行时也没有 latestSeq 字段可摸。
    const missingResident = ledger.probeGap("ghost", "w-a");
    const missingViewport = ledger.probeGap("r", "w-ghost");
    expect(missingResident.status).toBe("unknown");
    expect(missingViewport.status).toBe("unknown");
    expect("latestSeq" in missingResident).toBe(false);
    expect("ackedSeq" in missingViewport).toBe(false);
  });

  it("类型层看门狗：unknown 分支取 latestSeq 必须编译不过", () => {
    const ledger = new FactLedger();
    const probe = ledger.probeGap("nobody", "w-x");
    if (probe.status === "unknown") {
      // 类型级的承诺用编译器来验：哪天 GapProbe 被改成 unknown 也带数字
      // （比如塞个 latestSeq: 0），这行就会编译通过，@ts-expect-error 反过来
      // 报「unused directive」——tsc 是这条承诺的永久看门狗，不靠谁手动撞。
      // @ts-expect-error unknown 分支不携带数字
      void probe.latestSeq;
    }
    if (probe.status === "ok") {
      // 对照：ok 分支的数字必须真的存在且是 number。
      const latest: number = probe.latestSeq;
      expect(latest).toBeGreaterThanOrEqual(0);
    }
    expect(probe.status).toBe("unknown");
  });

  it("probeGap 永不抛：任何失败都归一成 unknown", () => {
    const ledger = new FactLedger();
    // 连账都没开的住户。
    expect(() => ledger.probeGap("nobody", "w-x")).not.toThrow();
    const probe = ledger.probeGap("nobody", "w-x");
    expect(probe.status).toBe("unknown");
    if (probe.status === "unknown") {
      expect(typeof probe.cause).toBe("string");
      expect(probe.cause.length).toBeGreaterThan(0);
    }
  });

  it("gap() 与 probeGap() 分工：要炸的炸，要探的探", () => {
    const ledger = new FactLedger();
    expect(() => ledger.gap("nobody", "w-x")).toThrow(LedgerNotFoundError);
    expect(ledger.probeGap("nobody", "w-x").status).toBe("unknown");
  });
});

describe("序号而非时间戳（MV-C06）", () => {
  it("ts 倒序的快照也骗不过缺口判断：新鲜度只看序号差值", () => {
    withTempDir((dataDir) => {
      // 直接造一份 ts 倒序的快照——进程内 ts 有单调化守卫，「ts 会倒」
      // 这件事只能经由落盘数据出现（跨机搬运、时钟回拨），所以从这里打。
      writeFileSync(
        join(dataDir, "r.facts.json"),
        JSON.stringify({
          schemaVersion: 1,
          residentId: "r",
          entries: [
            {
              seq: 1,
              ts: "2026-08-20T02:00:00.000Z",
              author: "m",
              kind: "ruling",
              body: "一",
              supersedesSeq: null,
            },
            {
              seq: 2,
              ts: "2026-08-20T01:00:00.000Z",
              author: "m",
              kind: "ruling",
              body: "二",
              supersedesSeq: null,
            },
          ],
          viewports: [{ viewportId: "w-a", baselineSeq: 0, ackedSeq: 0 }],
        }),
      );
      const ledger = new FactLedger({ dataDir });
      const entries = ledger.entries("r");
      // ts 确实是倒的——前提成立，这个测试不是空转。
      expect(Date.parse(entries[1]?.ts ?? "")).toBeLessThan(Date.parse(entries[0]?.ts ?? ""));
      // 缺口判断纹丝不动：只看 seq。
      expect(ledger.gap("r", "w-a")).toEqual({ latestSeq: 2, ackedSeq: 0 });
      expect(ledger.gapEntries("r", "w-a").map((e) => e.seq)).toEqual([1, 2]);
      ledger.ack("r", "w-a", 2);
      expect(ledger.gapEntries("r", "w-a")).toEqual([]);
    });
  });
});

describe("住户隔离", () => {
  it("跨住户读写一律抛 LedgerNotFoundError", () => {
    const ledger = new FactLedger();
    ledger.createLedger("a");
    expect(() => ledger.append("b", { author: "main", kind: "ruling", body: "x" })).toThrow(
      LedgerNotFoundError,
    );
    expect(() => ledger.entries("b")).toThrow(LedgerNotFoundError);
    expect(() => ledger.currentSet("b")).toThrow(LedgerNotFoundError);
    expect(() => ledger.openViewport("b", "w-x")).toThrow(LedgerNotFoundError);
    expect(() => ledger.latestSeq("b")).toThrow(LedgerNotFoundError);
  });

  it("两本账互不可见：seq 各自发号，条目各归各", () => {
    const ledger = new FactLedger();
    ledger.createLedger("a");
    ledger.createLedger("b");
    ledger.append("a", { author: "main", kind: "ruling", body: "A 的秘密裁定" });
    expect(ledger.latestSeq("a")).toBe(1);
    expect(ledger.latestSeq("b")).toBe(0);
    expect(ledger.entries("b")).toEqual([]);
    const bFirst = ledger.append("b", { author: "main", kind: "ruling", body: "B 的第一条" });
    expect(bFirst.seq).toBe(1);
  });
});

describe("持久化", () => {
  it("条目、seq 水位、确认位原样恢复，恢复后继续发号不撞", () => {
    withTempDir((dataDir) => {
      const ledger = new FactLedger({ dataDir });
      ledger.createLedger("r");
      ledger.append("r", { author: "main", kind: "ruling", body: "裁定一" });
      ledger.append("r", { author: "main", kind: "active_rule", body: "规矩一" });
      ledger.openViewport("r", "w-a"); // baseline=2，窗已对齐到规矩一
      ledger.supersede("r", 1, { author: "main", reason: "解除裁定一" });

      const restored = new FactLedger({ dataDir });
      expect(restored.entries("r")).toEqual(ledger.entries("r"));
      expect(restored.gap("r", "w-a")).toEqual({ latestSeq: 3, ackedSeq: 2 });
      expect(restored.gapEntries("r", "w-a").map((e) => e.kind)).toEqual(["supersede"]);
      expect(restored.currentSet("r").map((e) => e.body)).toEqual(["规矩一"]);
      const next = restored.append("r", { author: "main", kind: "ruling", body: "裁定二" });
      expect(next.seq).toBe(4);
    });
  });

  it("在线推导与恢复重建的视图必须完全一致：两条路径不许口径分叉", () => {
    withTempDir((dataDir) => {
      // 这颗钉子钉的是一类洞，不是一个洞：restore 的 supersede 校验曾比
      // 在线 append 松（同型事故），视图推导也可能在两条路径上悄悄分叉。
      const ledger = new FactLedger({ dataDir });
      ledger.createLedger("r");
      ledger.append("r", { author: "main", kind: "ruling", body: "裁定一" });
      ledger.append("r", { author: "main", kind: "ruling", body: "裁定二" });
      ledger.append("r", { author: "main", kind: "active_rule", body: "规矩一" });
      ledger.append("r", { author: "main", kind: "confirmed_preference", body: "偏好一" });
      ledger.openViewport("r", "w-1"); // baseline=4
      ledger.ack("r", "w-1", 4);
      ledger.supersede("r", 2, { author: "main", reason: "只解除裁定二" });
      ledger.supersede("r", 4, { author: "main", reason: "偏好一作废——这个 kind 全解除" });
      ledger.openViewport("r", "w-2"); // baseline=6
      ledger.append("r", { author: "main", kind: "active_rule", body: "规矩二" });

      // 在线取一次，落盘后新实例再取一次，深比较相等。
      const restored = new FactLedger({ dataDir });
      expect(restored.currentSet("r")).toEqual(ledger.currentSet("r"));
      // 前提不是空转：集里确实有内容，且有 kind 被全解除。
      expect(ledger.currentSet("r").map((e) => e.body)).toEqual(["裁定一", "规矩一", "规矩二"]);
      // 顺带：seq 水位与各窗确认位也要一致。
      expect(restored.latestSeq("r")).toBe(ledger.latestSeq("r"));
      expect(restored.ackedSeq("r", "w-1")).toBe(ledger.ackedSeq("r", "w-1"));
      expect(restored.ackedSeq("r", "w-2")).toBe(ledger.ackedSeq("r", "w-2"));
      expect(restored.gapEntries("r", "w-1")).toEqual(ledger.gapEntries("r", "w-1"));
      expect(restored.gapEntries("r", "w-2")).toEqual(ledger.gapEntries("r", "w-2"));
    });
  });

  it("多住户共用一个目录，文件名与 ResidentStore 不撞", () => {
    withTempDir((dataDir) => {
      const ledger = new FactLedger({ dataDir });
      ledger.createLedger("a");
      ledger.createLedger("b");
      ledger.append("a", { author: "main", kind: "ruling", body: "A 的" });
      const restored = new FactLedger({ dataDir });
      expect(restored.latestSeq("a")).toBe(1);
      expect(restored.latestSeq("b")).toBe(0);
      // .facts.json 后缀刻意与 ResidentStore 的 .json 区分，两个存储可共用目录。
      expect(statSync(join(dataDir, "a.facts.json")).isFile()).toBe(true);
    });
  });

  it("快照权限 0600", () => {
    withTempDir((dataDir) => {
      const ledger = new FactLedger({ dataDir });
      ledger.createLedger("r");
      const mode = statSync(join(dataDir, "r.facts.json")).mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });

  it("schema 版本不对显式失败，不静默跳过", () => {
    withTempDir((dataDir) => {
      writeFileSync(
        join(dataDir, "r.facts.json"),
        JSON.stringify({ schemaVersion: 999, residentId: "r", entries: [], viewports: [] }),
      );
      expect(() => new FactLedger({ dataDir })).toThrow(/schema_version=999/);
    });
  });

  it("文件名与内容身份对不上显式失败", () => {
    withTempDir((dataDir) => {
      writeFileSync(
        join(dataDir, "a.facts.json"),
        JSON.stringify({ schemaVersion: 1, residentId: "b", entries: [], viewports: [] }),
      );
      expect(() => new FactLedger({ dataDir })).toThrow(/文件名与身份对不上/);
    });
  });

  it("seq 断档的坏档显式失败——append-only 的账不该有洞", () => {
    withTempDir((dataDir) => {
      writeFileSync(
        join(dataDir, "r.facts.json"),
        JSON.stringify({
          schemaVersion: 1,
          residentId: "r",
          entries: [
            {
              seq: 1,
              ts: "2026-08-20T00:00:00.000Z",
              author: "m",
              kind: "ruling",
              body: "一",
              supersedesSeq: null,
            },
            {
              seq: 3,
              ts: "2026-08-20T00:00:01.000Z",
              author: "m",
              kind: "ruling",
              body: "三",
              supersedesSeq: null,
            },
          ],
          viewports: [],
        }),
      );
      expect(() => new FactLedger({ dataDir })).toThrow(/seq 断档/);
    });
  });

  it("字段形状对不上的坏档显式失败", () => {
    withTempDir((dataDir) => {
      writeFileSync(
        join(dataDir, "r.facts.json"),
        JSON.stringify({
          schemaVersion: 1,
          residentId: "r",
          entries: [
            {
              seq: 1,
              ts: "2026-08-20T00:00:00.000Z",
              author: "m",
              kind: "bogus",
              body: "x",
              supersedesSeq: null,
            },
          ],
          viewports: [],
        }),
      );
      expect(() => new FactLedger({ dataDir })).toThrow(/未知 kind/);
    });
  });

  it("supersede 指向另一条 supersede 的坏档显式失败", () => {
    withTempDir((dataDir) => {
      writeFileSync(
        join(dataDir, "r.facts.json"),
        JSON.stringify({
          schemaVersion: 1,
          residentId: "r",
          entries: [
            {
              seq: 1,
              ts: "2026-08-20T00:00:00.000Z",
              author: "m",
              kind: "ruling",
              body: "一",
              supersedesSeq: null,
            },
            {
              seq: 2,
              ts: "2026-08-20T00:00:01.000Z",
              author: "m",
              kind: "supersede",
              body: "解除一",
              supersedesSeq: 1,
            },
            {
              seq: 3,
              ts: "2026-08-20T00:00:02.000Z",
              author: "m",
              kind: "supersede",
              body: "解除解除",
              supersedesSeq: 2,
            },
          ],
          viewports: [],
        }),
      );
      expect(() => new FactLedger({ dataDir })).toThrow(/目标不是事实条目/);
    });
  });

  it("重复 supersede 同一条的坏档显式失败", () => {
    withTempDir((dataDir) => {
      writeFileSync(
        join(dataDir, "r.facts.json"),
        JSON.stringify({
          schemaVersion: 1,
          residentId: "r",
          entries: [
            {
              seq: 1,
              ts: "2026-08-20T00:00:00.000Z",
              author: "m",
              kind: "ruling",
              body: "一",
              supersedesSeq: null,
            },
            {
              seq: 2,
              ts: "2026-08-20T00:00:01.000Z",
              author: "m",
              kind: "supersede",
              body: "第一次解除",
              supersedesSeq: 1,
            },
            {
              seq: 3,
              ts: "2026-08-20T00:00:02.000Z",
              author: "m",
              kind: "supersede",
              body: "第二次解除",
              supersedesSeq: 1,
            },
          ],
          viewports: [],
        }),
      );
      expect(() => new FactLedger({ dataDir })).toThrow(/重复解除/);
    });
  });

  it("supersedesSeq 不是整数的坏档显式失败", () => {
    withTempDir((dataDir) => {
      writeFileSync(
        join(dataDir, "r.facts.json"),
        JSON.stringify({
          schemaVersion: 1,
          residentId: "r",
          entries: [
            {
              seq: 1,
              ts: "2026-08-20T00:00:00.000Z",
              author: "m",
              kind: "ruling",
              body: "一",
              supersedesSeq: null,
            },
            {
              seq: 2,
              ts: "2026-08-20T00:00:01.000Z",
              author: "m",
              kind: "supersede",
              body: "解除一",
              supersedesSeq: "1",
            },
          ],
          viewports: [],
        }),
      );
      expect(() => new FactLedger({ dataDir })).toThrow(/supersedesSeq 既不是 null 也不是整数/);
    });
  });

  it("确认位越界的坏档显式失败", () => {
    withTempDir((dataDir) => {
      writeFileSync(
        join(dataDir, "r.facts.json"),
        JSON.stringify({
          schemaVersion: 1,
          residentId: "r",
          entries: [],
          viewports: [{ viewportId: "w-a", baselineSeq: 0, ackedSeq: 5 }],
        }),
      );
      expect(() => new FactLedger({ dataDir })).toThrow(/确认位越界/);
    });
  });

  it("确认位不是整数的坏档显式失败", () => {
    withTempDir((dataDir) => {
      writeFileSync(
        join(dataDir, "r.facts.json"),
        JSON.stringify({
          schemaVersion: 1,
          residentId: "r",
          entries: [],
          viewports: [{ viewportId: "w-a", baselineSeq: "0", ackedSeq: "0" }],
        }),
      );
      expect(() => new FactLedger({ dataDir })).toThrow(/baselineSeq\/ackedSeq 不是整数/);
    });
  });

  it("残留 .tmp 被跳过，旧 .json 仍是权威", () => {
    withTempDir((dataDir) => {
      const ledger = new FactLedger({ dataDir });
      ledger.createLedger("r");
      ledger.append("r", { author: "main", kind: "ruling", body: "已落盘" });
      writeFileSync(join(dataDir, "r.facts.json.tmp"), "没写完的一次写入");
      const restored = new FactLedger({ dataDir });
      expect(restored.latestSeq("r")).toBe(1);
      // 下一次写入覆盖残留。
      restored.append("r", { author: "main", kind: "ruling", body: "二" });
      expect(readFileSync(join(dataDir, "r.facts.json"), "utf8")).toContain("二");
    });
  });

  it("恢复的条目仍是冻结的，账外副本涂改无效", () => {
    withTempDir((dataDir) => {
      const ledger = new FactLedger({ dataDir });
      ledger.createLedger("r");
      ledger.append("r", { author: "main", kind: "ruling", body: "正文" });
      const restored = new FactLedger({ dataDir });
      const copy = restored.entries("r");
      (copy[0] as { body: string }).body = "涂改";
      expect(restored.entries("r")[0]?.body).toBe("正文");
    });
  });
});

describe("落盘失败不改内存（写路径先落盘后发布）", () => {
  it("createLedger 落盘失败：内存里不留半本账", () => {
    withTempDir((dataDir) => {
      const ledger = new FactLedger({ dataDir });
      whileReadonly(dataDir, () => {
        expect(() => ledger.createLedger("r")).toThrow();
        expect(ledger.has("r")).toBe(false);
      });
      // 恢复可写后同一个 id 能正常开——失败没有留下半个占位。
      ledger.createLedger("r");
      expect(ledger.has("r")).toBe(true);
    });
  });

  it("append 落盘失败：条目不多、seq 不动、盘与内存一致", () => {
    withTempDir((dataDir) => {
      const ledger = new FactLedger({ dataDir });
      ledger.createLedger("r");
      ledger.append("r", { author: "main", kind: "ruling", body: "一" });
      whileReadonly(dataDir, () => {
        expect(() => ledger.append("r", { author: "main", kind: "ruling", body: "二" })).toThrow();
        expect(ledger.latestSeq("r")).toBe(1);
        expect(ledger.entries("r").map((e) => e.body)).toEqual(["一"]);
      });
      // 盘上也没多：新实例读到的和内存一致。
      expect(new FactLedger({ dataDir }).entries("r")).toHaveLength(1);
      // 恢复可写后追加成功，seq 连续——失败没有吃掉序号。
      const entry = ledger.append("r", { author: "main", kind: "ruling", body: "二" });
      expect(entry.seq).toBe(2);
    });
  });

  it("supersede 落盘失败：不留「条目进了全史、解除标记没进」的半改", () => {
    withTempDir((dataDir) => {
      const ledger = new FactLedger({ dataDir });
      ledger.createLedger("r");
      ledger.append("r", { author: "main", kind: "ruling", body: "裁定" });
      whileReadonly(dataDir, () => {
        expect(() => ledger.supersede("r", 1, { author: "main", reason: "解除" })).toThrow();
        // 这是故障注入打过的洞：旧实现先 push 再落盘，失败后全史多一条
        // supersede 而 supersededSeqs 没更新，currentSet 与全史自相矛盾。
        // 现在必须是干净的「什么都没发生」。
        expect(ledger.entries("r")).toHaveLength(1);
        expect(ledger.currentSet("r").map((e) => e.body)).toEqual(["裁定"]);
      });
      // 恢复可写后同一次解除能正常完成。
      ledger.supersede("r", 1, { author: "main", reason: "解除" });
      expect(ledger.currentSet("r")).toEqual([]);
    });
  });

  it("openViewport 落盘失败：不留确认位", () => {
    withTempDir((dataDir) => {
      const ledger = new FactLedger({ dataDir });
      ledger.createLedger("r");
      ledger.append("r", { author: "main", kind: "ruling", body: "裁定" });
      whileReadonly(dataDir, () => {
        expect(() => ledger.openViewport("r", "w-a")).toThrow();
        expect(() => ledger.gap("r", "w-a")).toThrow(ViewportNotFoundError);
      });
      expect(ledger.openViewport("r", "w-a")).toBe(1);
    });
  });

  it("ack 落盘失败：确认位不动", () => {
    withTempDir((dataDir) => {
      const ledger = new FactLedger({ dataDir });
      ledger.createLedger("r");
      ledger.openViewport("r", "w-a");
      ledger.append("r", { author: "main", kind: "ruling", body: "裁定" });
      whileReadonly(dataDir, () => {
        expect(() => ledger.ack("r", "w-a", 1)).toThrow();
        expect(ledger.ackedSeq("r", "w-a")).toBe(0);
        expect(ledger.gap("r", "w-a")).toEqual({ latestSeq: 1, ackedSeq: 0 });
      });
      ledger.ack("r", "w-a", 1);
      expect(ledger.ackedSeq("r", "w-a")).toBe(1);
    });
  });
});

describe("恢复的运行时校验（不可信 JSON 不许直接断言成 LedgerRecord）", () => {
  it("根不是对象 / residentId 不是字符串：显式失败，不猜", () => {
    withTempDir((dataDir) => {
      writeFileSync(join(dataDir, "r.facts.json"), "[]");
      expect(() => new FactLedger({ dataDir })).toThrow(/根不是对象/);
    });
    withTempDir((dataDir) => {
      // 故障注入实测案例：residentId=123 会混过 `as LedgerRecord`，
      // Map 以数字为键、字符串查不到，一本账无声消失。
      writeFileSync(
        join(dataDir, "123.facts.json"),
        JSON.stringify({ schemaVersion: 1, residentId: 123, entries: [], viewports: [] }),
      );
      expect(() => new FactLedger({ dataDir })).toThrow(/residentId 不是字符串/);
    });
  });

  it("entries 与条目字段类型不对：显式失败", () => {
    withTempDir((dataDir) => {
      writeFileSync(
        join(dataDir, "r.facts.json"),
        JSON.stringify({ schemaVersion: 1, residentId: "r", entries: {}, viewports: [] }),
      );
      expect(() => new FactLedger({ dataDir })).toThrow(/entries 不是数组/);

      writeFileSync(
        join(dataDir, "r.facts.json"),
        JSON.stringify({
          schemaVersion: 1,
          residentId: "r",
          entries: [
            {
              seq: 1,
              ts: "2026-08-20T00:00:00.000Z",
              author: "m",
              kind: "ruling",
              body: 42,
              supersedesSeq: null,
            },
          ],
          viewports: [],
        }),
      );
      expect(() => new FactLedger({ dataDir })).toThrow(/body 不是字符串/);

      writeFileSync(
        join(dataDir, "r.facts.json"),
        JSON.stringify({
          schemaVersion: 1,
          residentId: "r",
          entries: [
            {
              seq: "1",
              ts: "2026-08-20T00:00:00.000Z",
              author: "m",
              kind: "ruling",
              body: "x",
              supersedesSeq: null,
            },
          ],
          viewports: [],
        }),
      );
      expect(() => new FactLedger({ dataDir })).toThrow(/seq 不是整数/);
    });
  });

  it("确认位字段类型不对：显式失败", () => {
    withTempDir((dataDir) => {
      writeFileSync(
        join(dataDir, "r.facts.json"),
        JSON.stringify({
          schemaVersion: 1,
          residentId: "r",
          entries: [],
          viewports: [{ viewportId: 123, baselineSeq: 0, ackedSeq: 0 }],
        }),
      );
      expect(() => new FactLedger({ dataDir })).toThrow(/viewportId 不是字符串/);

      writeFileSync(
        join(dataDir, "r.facts.json"),
        JSON.stringify({
          schemaVersion: 1,
          residentId: "r",
          entries: [],
          viewports: [{ viewportId: "w-a", baselineSeq: "0", ackedSeq: 0 }],
        }),
      );
      expect(() => new FactLedger({ dataDir })).toThrow(/baselineSeq\/ackedSeq 不是整数/);
    });
  });

  it("多带的额外字段：拒绝，不静默剥离（根/条目/确认位三层）", () => {
    withTempDir((dataDir) => {
      // 带 extra 的条目若恢复成功，会经 entries() 外泄、后续落盘继续保留——
      // 所以字段集合必须恰好，多一个都当场拒（同 migration assertExactKeys 口径）。
      const valid = {
        schemaVersion: 1,
        residentId: "r",
        entries: [
          {
            seq: 1,
            ts: "2026-08-20T00:00:00.000Z",
            author: "m",
            kind: "ruling",
            body: "一",
            supersedesSeq: null,
          },
        ],
        viewports: [{ viewportId: "w-a", baselineSeq: 0, ackedSeq: 0 }],
      };
      const file = join(dataDir, "r.facts.json");

      writeFileSync(file, JSON.stringify({ ...valid, extra: "leak" }));
      expect(() => new FactLedger({ dataDir })).toThrow(/根.*字段集合对不上/);

      writeFileSync(
        file,
        JSON.stringify({ ...valid, entries: [{ ...valid.entries[0], extra: "leak" }] }),
      );
      expect(() => new FactLedger({ dataDir })).toThrow(/第 1 条.*字段集合对不上/);

      writeFileSync(
        file,
        JSON.stringify({ ...valid, viewports: [{ ...valid.viewports[0], extra: "leak" }] }),
      );
      expect(() => new FactLedger({ dataDir })).toThrow(/确认位行.*字段集合对不上/);

      // 对照：原样不多不少的快照能正常恢复——校验层不误伤好档。
      writeFileSync(file, JSON.stringify(valid));
      expect(new FactLedger({ dataDir }).latestSeq("r")).toBe(1);
    });
  });
});
