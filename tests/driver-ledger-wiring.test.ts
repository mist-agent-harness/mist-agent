import { chmodSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDriver } from "../src/acceptance-driver.ts";
import { MessageTreeError } from "../src/message-tree/index.ts";
import type { TurnGateEvent } from "../src/session/turn-gate.ts";
import { FactLedger } from "../src/store/fact-ledger.ts";
import { ResidentNotFoundError } from "../src/store/resident-store.ts";

/**
 * driver 级接线测试：启动包与首窗 baseline 的时序（F1）、住户与账本的生命周期
 * 原子性（F4）、两个真实 driver 共享一账时的窗发号（F5）。
 * 全部走生产 MistDriver + 真 FactLedger；落盘失败用真 dataDir + chmod 注入。
 * 测试数据全为虚构占位（AGENTS.md：住户内容不进仓库）。
 */

const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mist-wiring-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("F1 启动包与首窗 baseline 时序", () => {
  it("(a) bootpack 之后落的裁定走缺口通道：首轮 say 必须拉到，不永久漏", async () => {
    const ledger = new FactLedger();
    const events: TurnGateEvent[] = [];
    const prompts: string[] = [];
    const driver = createDriver({
      factLedger: ledger,
      turnEventLogger: {
        log: (event) => {
          events.push(event);
        },
      },
      reply: (_residentId, message) => {
        prompts.push(message);
        return "占位回应";
      },
    });
    const residentId = await driver.createResident("placeholder-f1a");

    // buildBootPack 开首窗记 baseline（此刻 latestSeq=0），currentSet 为空。
    const pack = await driver.buildBootPack(residentId);
    expect(pack.currentFacts).toEqual([]);

    ledger.append(residentId, { author: "main-thread", kind: "ruling", body: "占位裁定-包后" });
    await driver.say(residentId, "占位首句");

    expect(prompts[0]).toContain(
      "[权威事实账缺口 | kind=ruling | seq=1 | author=main-thread] 占位裁定-包后",
    );
    const pulled = events.find((event) => event.event === "gate_gap_pulled");
    expect(pulled).toBeDefined();
    expect(ledger.ackedSeq(residentId, pulled?.windowId ?? "")).toBe(1);
  });

  it("(b) 恢复补空账后：包前落的裁定进包不进缺口，只出现一次", async () => {
    const residentsDir = freshDir();
    // 账接线之前落盘的老住户（无 facts.json）。
    const legacy = createDriver({ dataDir: residentsDir });
    const residentId = await legacy.createResident("placeholder-f1b");

    const ledger = new FactLedger();
    const prompts: string[] = [];
    const revived = createDriver({
      dataDir: residentsDir,
      factLedger: ledger,
      reply: (_residentId, message) => {
        prompts.push(message);
        return "占位回应";
      },
    });
    // 构造时已为老住户补空账（baseline=0，不开窗）。
    expect(ledger.has(residentId)).toBe(true);
    expect(ledger.latestSeq(residentId)).toBe(0);

    ledger.append(residentId, { author: "main-thread", kind: "ruling", body: "占位裁定-包前" });
    const pack = await revived.buildBootPack(residentId);
    expect(pack.currentFacts?.map((entry) => entry.body)).toEqual(["占位裁定-包前"]);

    // 这条裁定已在包里：say 的注入里不得再出现它。
    await revived.say(residentId, "占位首句");
    expect(prompts[0]).toBe("占位首句");
  });
});

describe("F4 住户与账本生命周期原子性", () => {
  it("createResident 开户失败回滚：住户、消息房、账都不留", async () => {
    const factsDir = freshDir();
    const ledger = new FactLedger({ dataDir: factsDir });
    const driver = createDriver({ factLedger: ledger });

    chmodSync(factsDir, 0o555);
    try {
      await expect(driver.createResident("placeholder-rollback")).rejects.toThrow();
    } finally {
      chmodSync(factsDir, 0o755);
    }

    await expect(driver.recall("resident-000001", "占位")).rejects.toThrow(ResidentNotFoundError);
    await expect(driver.history("resident-000001")).rejects.toThrow(MessageTreeError);
    expect(ledger.has("resident-000001")).toBe(false);
    expect(readdirSync(factsDir)).toEqual([]);
    // 回滚后 driver 健康，下一户照常开立。
    const second = await driver.createResident("placeholder-after-rollback");
    expect(second).toBe("resident-000002");
    expect(ledger.has(second)).toBe(true);
  });

  it("importResident 补账失败回滚导入件：住户、消息房都不留，同包可再导入", async () => {
    const ledger = new FactLedger();
    const driver = createDriver({ factLedger: ledger });
    const sourceId = await driver.createResident("placeholder-import-source");
    await driver.remember(sourceId, "占位记忆");
    const pack = await driver.exportResident(sourceId);

    // 只拦 createLedger 这一下：迁入本身成功，补账失败触发回滚。
    const real = ledger.createLedger.bind(ledger);
    let capturedId: string | null = null;
    ledger.createLedger = (residentId) => {
      capturedId = residentId;
      throw new Error("injected createLedger failure");
    };
    await expect(driver.importResident(pack)).rejects.toThrow("injected createLedger failure");
    ledger.createLedger = real;

    if (capturedId === null) throw new Error("createLedger 未被调用，故障注入没生效");
    await expect(driver.recall(capturedId, "占位")).rejects.toThrow(ResidentNotFoundError);
    await expect(driver.history(capturedId)).rejects.toThrow(MessageTreeError);
    expect(ledger.has(capturedId)).toBe(false);

    // 没有半成品占着位置：同一包再导入，照常补一本空账。
    const imported = await driver.importResident(pack);
    expect(ledger.has(imported)).toBe(true);
    expect(ledger.latestSeq(imported)).toBe(0);
  });

  it("dataDir 恢复补缺账：老住户补空账，facts.json 恢复出的真账一字不动", async () => {
    const residentsDir = freshDir();
    const factsDir = freshDir();
    const legacy = createDriver({ dataDir: residentsDir });
    const oldId = await legacy.createResident("placeholder-old");

    // 第一次带账启动：老住户没有 facts.json，补一本空账。
    const ledger1 = new FactLedger({ dataDir: factsDir });
    createDriver({ dataDir: residentsDir, factLedger: ledger1 });
    expect(ledger1.has(oldId)).toBe(true);
    expect(ledger1.latestSeq(oldId)).toBe(0);
    ledger1.append(oldId, { author: "main-thread", kind: "ruling", body: "占位真账" });
    ledger1.openViewport(oldId, "w_probe");
    ledger1.ack(oldId, "w_probe", 1);

    // 第二次带账启动：真账从 facts.json 恢复进内存，补缺必须跳过——
    // 重置就等于把一本活着的账洗成空白。
    const ledger2 = new FactLedger({ dataDir: factsDir });
    createDriver({ dataDir: residentsDir, factLedger: ledger2 });
    expect(ledger2.entries(oldId).map((entry) => entry.body)).toEqual(["占位真账"]);
    expect(ledger2.ackedSeq(oldId, "w_probe")).toBe(1);
  });

  it("destroyResident 同步销账：facts.json 不留、重启不诈尸、destroyLedger 幂等", async () => {
    const residentsDir = freshDir();
    const factsDir = freshDir();
    const ledger = new FactLedger({ dataDir: factsDir });
    const driver = createDriver({ dataDir: residentsDir, factLedger: ledger });
    const residentId = await driver.createResident("placeholder-destroy");
    expect(readdirSync(factsDir)).toEqual([`${residentId}.facts.json`]);

    await driver.destroyResident(residentId);

    expect(readdirSync(factsDir)).toEqual([]);
    expect(readdirSync(residentsDir)).toEqual([]);
    // 新进程形态（重新从盘恢复）也见不到这本账。
    const restored = new FactLedger({ dataDir: factsDir });
    expect(restored.has(residentId)).toBe(false);
    // 幂等：销一本不存在的账是 no-op，不炸。
    expect(() => ledger.destroyLedger(residentId)).not.toThrow();
  });
});

describe("F5 两个真实 MistDriver 共用 dataDir 与 FactLedger", () => {
  it("同一住户两窗各开各的、各过各的闸、ack 确认位各归各不串", async () => {
    const residentsDir = freshDir();
    const factsDir = freshDir();
    const events: TurnGateEvent[] = [];
    const logger = {
      log: (event: TurnGateEvent) => {
        events.push(event);
      },
    };
    const ledger = new FactLedger({ dataDir: factsDir });
    const driverA = createDriver({
      dataDir: residentsDir,
      factLedger: ledger,
      turnEventLogger: logger,
    });
    const residentId = await driverA.createResident("placeholder-shared");
    await driverA.say(residentId, "占位 A 窗首句");

    // 第二个 driver 以「另一进程」形态进场：同 dataDir 恢复出同一住户、共享
    // 同一本账。顺序发号时代它会发出与 A 相同的 windowId，在 openViewport
    // 撞「ack row already exists」——w_ + ULID 之后两窗各开各的。
    const driverB = createDriver({
      dataDir: residentsDir,
      factLedger: ledger,
      turnEventLogger: logger,
    });
    // B 启动时 A 的真账已在：补缺跳过，账还是那本账。
    expect(ledger.latestSeq(residentId)).toBe(0);
    await driverB.say(residentId, "占位 B 窗首句");

    const windowIds = [
      ...new Set(events.filter((event) => event.residentId === residentId).map((e) => e.windowId)),
    ];
    expect(windowIds).toHaveLength(2);
    const windowA = windowIds[0];
    const windowB = windowIds[1];
    if (windowA === undefined || windowB === undefined) {
      throw new Error("两窗的闸事件未齐");
    }

    // ack 各归各：A 窗 ack 一条 ruling，B 窗的确认位不动；反之亦然。
    ledger.append(residentId, { author: "main-thread", kind: "ruling", body: "占位共享裁定" });
    await driverA.say(residentId, "占位 A 窗第二句");
    expect(ledger.ackedSeq(residentId, windowA)).toBe(1);
    expect(ledger.ackedSeq(residentId, windowB)).toBe(0);
    await driverB.say(residentId, "占位 B 窗第二句");
    expect(ledger.ackedSeq(residentId, windowB)).toBe(1);
    expect(ledger.ackedSeq(residentId, windowA)).toBe(1);
  });
});
