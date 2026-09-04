import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HistoryNode } from "../acceptance/driver.ts";
import type { AssistantReply } from "../src/message-tree/index.ts";
import { MessageTreeService, MessageTreeStore } from "../src/message-tree/index.ts";
import { SessionRegistry } from "../src/session/session-registry.ts";
import {
  GateUnavailableError,
  type TurnEventLogger,
  type TurnGateEvent,
  ViewportTurnGate,
} from "../src/session/turn-gate.ts";
import { FactLedger } from "../src/store/fact-ledger.ts";

/**
 * 开工闸单测：真 FactLedger + 内存 MessageTreeStore + 真 SessionRegistry 装配，
 * 与生产 driver 的差异只在 reply 是捕获桩——闸、账、窗全是生产件。
 * 测试数据全为虚构占位（AGENTS.md：住户内容不进仓库）。
 */

const RESIDENT = "resident-a";

class CollectingLogger implements TurnEventLogger {
  readonly events: TurnGateEvent[] = [];
  log(event: TurnGateEvent): void {
    this.events.push(event);
  }
}

function setup(options: { reply?: AssistantReply } = {}) {
  let next = 0;
  const store = new MessageTreeStore({
    now: () => "2026-08-20T00:00:00.000Z",
    newId: () => `node-${++next}`,
  });
  store.createRoom(RESIDENT);
  const sessions = new SessionRegistry<null>();
  const ledger = new FactLedger();
  ledger.createLedger(RESIDENT);
  const logger = new CollectingLogger();
  const gate = new ViewportTurnGate(ledger, {
    logger,
    generationOf: (windowId) => sessions.get(windowId)?.generation ?? null,
  });
  const prompts: string[] = [];
  const service = new MessageTreeService(
    store,
    {
      getHead: (windowId) => sessions.getHead(windowId),
      setHead: (windowId, headId) => sessions.setHead(windowId, headId),
    },
    {
      assistantReply:
        options.reply ??
        ((_residentId, message) => {
          prompts.push(message);
          return `回应：${message}`;
        }),
      turnGate: gate,
    },
  );
  const window = sessions.open(RESIDENT, { context: null });
  ledger.openViewport(RESIDENT, window.windowId);
  return { store, sessions, ledger, logger, gate, service, prompts, window };
}

describe("ViewportTurnGate 经 MessageTreeService.say", () => {
  it("无缺口：空注入，模型拿到原文，记 gate_clear 且三元组齐全", async () => {
    const { service, prompts, logger, window } = setup();

    const reply = await service.say(RESIDENT, "开工", window.windowId);

    expect(prompts).toEqual(["开工"]);
    expect(reply.content).toBe("回应：开工");
    const tree = await service.history(RESIDENT);
    expect(tree).toEqual([
      expect.objectContaining({ role: "user", content: "开工" }),
      expect.objectContaining({ role: "assistant", content: "回应：开工" }),
    ]);
    expect(logger.events).toEqual([
      {
        event: "gate_clear",
        residentId: RESIDENT,
        windowId: window.windowId,
        generation: 1,
        detail: "无缺口（latestSeq=0）",
      },
    ]);
  });

  it("有缺口：注入格式档位标注齐全，落树 user 仍是原文，落树后 ack 到 latestSeq", async () => {
    const { service, ledger, prompts, logger, window } = setup();
    ledger.append(
      RESIDENT,
      { author: "main-thread", kind: "ruling", body: "裁定甲" },
      { kind: "system", reason: "test" },
    );
    ledger.append(
      RESIDENT,
      { author: "main-thread", kind: "active_rule", body: "规矩乙" },
      { kind: "system", reason: "test" },
    );

    await service.say(RESIDENT, "住户原话", window.windowId);

    expect(prompts).toEqual([
      "[权威事实账缺口 | kind=ruling | seq=1 | author=main-thread] 裁定甲\n\n" +
        "[权威事实账缺口 | kind=active_rule | seq=2 | author=main-thread] 规矩乙\n\n" +
        "住户原话",
    ]);
    // 注入是上下文装配不是用户发言：树上的 user 节点只能是她说的那句话。
    const tree = await service.history(RESIDENT);
    expect(tree).toEqual([
      expect.objectContaining({ role: "user", content: "住户原话" }),
      expect.objectContaining({ role: "assistant" }),
    ]);
    expect(ledger.ackedSeq(RESIDENT, window.windowId)).toBe(2);
    expect(logger.events).toEqual([
      {
        event: "gate_gap_pulled",
        residentId: RESIDENT,
        windowId: window.windowId,
        generation: 1,
        detail: "pulled 2 entries (seq 1..2)",
      },
      {
        event: "gate_ack",
        residentId: RESIDENT,
        windowId: window.windowId,
        generation: 1,
        detail: "acked seq=2",
      },
    ]);
  });

  it("assistantReply 失败：不 ack 不落树，下轮原样重拉后正常 ack（MV-C05）", async () => {
    const prompts: string[] = [];
    const { service, ledger, window } = setup({
      reply: (_residentId, message) => {
        prompts.push(message);
        if (prompts.length === 1) throw new Error("model down");
        return "复原后的回应";
      },
    });
    ledger.append(
      RESIDENT,
      { author: "main-thread", kind: "ruling", body: "裁定甲" },
      { kind: "system", reason: "test" },
    );

    await expect(service.say(RESIDENT, "第一句", window.windowId)).rejects.toThrow("model down");
    expect(ledger.ackedSeq(RESIDENT, window.windowId)).toBe(0);
    expect(await service.history(RESIDENT)).toEqual([]);

    await service.say(RESIDENT, "第一句", window.windowId);

    // 重拉的是同一份缺口——回执没发出去，账上就不是「已知悉」。
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toBe(prompts[0]);
    expect(ledger.ackedSeq(RESIDENT, window.windowId)).toBe(1);
  });

  it("查账 unknown：say 抛 GateUnavailableError，模型零调用、树零写入（MV-C03 裁定级半）", async () => {
    let replyCalls = 0;
    const { service, store, sessions, logger } = setup({
      reply: () => {
        replyCalls += 1;
        return "不应生成";
      },
    });
    // 开窗但不向账登记确认位：probeGap 必返 unknown。
    const unregistered = sessions.open(RESIDENT, { context: null });

    await expect(service.say(RESIDENT, "hi", unregistered.windowId)).rejects.toThrow(
      GateUnavailableError,
    );

    expect(replyCalls).toBe(0);
    expect(store.history(RESIDENT)).toEqual([]);
    expect(logger.events).toEqual([
      expect.objectContaining({
        event: "gate_unknown",
        residentId: RESIDENT,
        windowId: unregistered.windowId,
        generation: 1,
      }),
    ]);
    expect(logger.events[0]?.detail).toContain("缺口未知");
  });

  it("reviseNode 不过闸：有缺口时改口既不拉取也不 ack（改口不是开工）", async () => {
    const { service, ledger, logger, window } = setup();
    const reply = await service.say(RESIDENT, "初稿", window.windowId);
    ledger.append(
      RESIDENT,
      { author: "main-thread", kind: "ruling", body: "裁定甲" },
      { kind: "system", reason: "test" },
    );
    const eventsBefore = logger.events.length;

    await service.reviseNode(RESIDENT, reply.id, "改口", window.windowId);

    expect(logger.events).toHaveLength(eventsBefore);
    expect(ledger.ackedSeq(RESIDENT, window.windowId)).toBe(0);
  });
});

describe("ViewportTurnGate.noteOrdinaryAction（MV-C03 普通半）", () => {
  it("查账 unknown：只记 gate_unknown 日志，不抛", () => {
    const { gate, sessions, logger } = setup();
    const unregistered = sessions.open(RESIDENT, { context: null });

    expect(() => gate.noteOrdinaryAction(RESIDENT, unregistered.windowId)).not.toThrow();

    expect(logger.events).toEqual([
      expect.objectContaining({ event: "gate_unknown", windowId: unregistered.windowId }),
    ]);
    expect(logger.events[0]?.detail).toContain("缺口未知");
  });

  it("查账正常：什么都不记，什么都不做", () => {
    const { gate, ledger, window, logger } = setup();
    ledger.append(
      RESIDENT,
      { author: "main-thread", kind: "ruling", body: "裁定甲" },
      { kind: "system", reason: "test" },
    );

    expect(() => gate.noteOrdinaryAction(RESIDENT, window.windowId)).not.toThrow();

    expect(logger.events).toEqual([]);
    expect(ledger.ackedSeq(RESIDENT, window.windowId)).toBe(0);
  });

  it("generationOf 查不到窗时事件 generation 落 null，不伪报", () => {
    const { gate, logger } = setup();

    gate.noteOrdinaryAction(RESIDENT, "window-not-in-registry");

    expect(logger.events).toEqual([
      expect.objectContaining({ event: "gate_unknown", generation: null }),
    ]);
  });
});

describe("回执幂等", () => {
  it("同一轮 commit 重发不炸也不退（MV-C05：回执重发是传播机制的常态）", () => {
    const { gate, ledger, window } = setup();
    ledger.append(
      RESIDENT,
      { author: "main-thread", kind: "ruling", body: "裁定甲" },
      { kind: "system", reason: "test" },
    );

    const pass = gate.beforeTurn(RESIDENT, window.windowId);
    pass.commit();
    expect(() => pass.commit()).not.toThrow();

    expect(ledger.ackedSeq(RESIDENT, window.windowId)).toBe(1);
  });
});

describe("不接闸的 MessageTreeService", () => {
  it("无 turnGate 时行为与接闸前完全一致：模型拿原文、零账副作用", async () => {
    let next = 0;
    const store = new MessageTreeStore({
      now: () => "2026-08-20T00:00:00.000Z",
      newId: () => `node-${++next}`,
    });
    store.createRoom(RESIDENT);
    const sessions = new SessionRegistry<null>();
    const window = sessions.open(RESIDENT, { context: null });
    const prompts: string[] = [];
    const service = new MessageTreeService(
      store,
      {
        getHead: (windowId) => sessions.getHead(windowId),
        setHead: (windowId, headId) => sessions.setHead(windowId, headId),
      },
      {
        assistantReply: (_residentId, message) => {
          prompts.push(message);
          return `回应：${message}`;
        },
      },
    );

    await service.say(RESIDENT, "没有闸的日子", window.windowId);

    expect(prompts).toEqual(["没有闸的日子"]);
    expect(await service.history(RESIDENT)).toHaveLength(2);
  });
});

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("ack 落盘失败（MV-C05：回执未达不能否认本轮已交付）", () => {
  it("真实落盘失败：say 照常返回、记 ack_failed、ackedSeq 不前进、恢复后重拉并 ack 成功", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mist-gate-ack-"));
    tempDirs.push(dir);
    let next = 0;
    const store = new MessageTreeStore({
      now: () => "2026-08-20T00:00:00.000Z",
      newId: () => `node-${++next}`,
    });
    store.createRoom(RESIDENT);
    const sessions = new SessionRegistry<null>();
    // 真 FactLedger + 真 dataDir：注入的是磁盘写失败，不是 mocked 的账。
    const ledger = new FactLedger({ dataDir: dir });
    ledger.createLedger(RESIDENT);
    const logger = new CollectingLogger();
    const gate = new ViewportTurnGate(ledger, {
      logger,
      generationOf: (windowId) => sessions.get(windowId)?.generation ?? null,
    });
    const prompts: string[] = [];
    const service = new MessageTreeService(
      store,
      {
        getHead: (windowId) => sessions.getHead(windowId),
        setHead: (windowId, headId) => sessions.setHead(windowId, headId),
      },
      {
        assistantReply: (_residentId, message) => {
          prompts.push(message);
          return "占位回应";
        },
        turnGate: gate,
      },
    );
    const window = sessions.open(RESIDENT, { context: null });
    ledger.openViewport(RESIDENT, window.windowId);
    ledger.append(
      RESIDENT,
      { author: "main-thread", kind: "ruling", body: "裁定甲" },
      { kind: "system", reason: "test" },
    );

    // chmod 0555 让 ack 的落盘必败（同 tests/fact-ledger.test.ts 的装置）。
    let reply: HistoryNode | undefined;
    chmodSync(dir, 0o555);
    try {
      reply = await service.say(RESIDENT, "第一句", window.windowId);
    } finally {
      chmodSync(dir, 0o755);
    }

    // say 不得制造可重试假失败：本轮交付已被树与 head 证明，必须照常返回。
    expect(reply?.role).toBe("assistant");
    expect(store.history(RESIDENT)).toHaveLength(2);
    expect(ledger.ackedSeq(RESIDENT, window.windowId)).toBe(0);
    const failed = logger.events.filter((event) => event.event === "ack_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.detail).toContain("回执未达");
    expect(logger.events.some((event) => event.event === "gate_ack")).toBe(false);

    // 恢复可写：下轮开工重拉同一份缺口，这次回执到账。
    await service.say(RESIDENT, "第二句", window.windowId);
    expect(prompts[1]).toContain("裁定甲");
    expect(ledger.ackedSeq(RESIDENT, window.windowId)).toBe(1);
    expect(logger.events.filter((event) => event.event === "gate_ack")).toHaveLength(1);
  });
});
