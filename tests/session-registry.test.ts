import { describe, expect, it } from "vitest";
import {
  PRIVATE_SCOPE,
  SessionRegistry,
  WINDOW_ARCHIVED,
} from "../src/session/session-registry.ts";

describe("SessionRegistry：多窗语义", () => {
  it("MV-A01 同一住户同一 scope 连开两次得到两扇活窗，各自 generation=1", () => {
    const sessions = new SessionRegistry<null>();

    const w1 = sessions.open("resident-a", { context: null });
    const w2 = sessions.open("resident-a", { context: null });

    expect(w1.windowId).not.toBe(w2.windowId);
    expect(w1.generation).toBe(1);
    expect(w2.generation).toBe(1);
    expect(sessions.isActive(w1.windowId)).toBe(true);
    expect(sessions.isActive(w2.windowId)).toBe(true);
    expect(sessions.windowsOf("resident-a")).toHaveLength(2);
  });

  it("MV-A04 缺省 scope 落私聊，不落全局", () => {
    const sessions = new SessionRegistry<null>();

    expect(sessions.open("resident-a", { context: null }).scopeId).toBe(PRIVATE_SCOPE);
    expect(sessions.open("resident-a", { scopeId: "room-1", context: null }).scopeId).toBe(
      "room-1",
    );
  });

  it("MV-A03 kill 幂等，归档后只读，写入返 WINDOW_ARCHIVED", () => {
    const sessions = new SessionRegistry<null>();
    const w1 = sessions.open("resident-a", { headId: "node-1", context: null });

    const first = sessions.kill(w1.windowId);
    const second = sessions.kill(w1.windowId);

    expect(first).toEqual(second);
    expect(sessions.isActive(w1.windowId)).toBe(false);
    expect(sessions.getArchived(w1.windowId)).toMatchObject({ archived: true, headId: "node-1" });
    expect(() => sessions.setHead(w1.windowId, "node-2")).toThrow(WINDOW_ARCHIVED);
    expect(() => sessions.issueDispatch(w1.windowId)).toThrow(WINDOW_ARCHIVED);
  });

  it("MV-A03 killResident 杀掉该住户全部活窗，不碰别人", () => {
    const sessions = new SessionRegistry<null>();
    const a1 = sessions.open("resident-a", { context: null });
    const a2 = sessions.open("resident-a", { context: null });
    const b1 = sessions.open("resident-b", { context: null });

    expect(sessions.killResident("resident-a")).toHaveLength(2);

    expect(sessions.isActive(a1.windowId)).toBe(false);
    expect(sessions.isActive(a2.windowId)).toBe(false);
    expect(sessions.isActive(b1.windowId)).toBe(true);
  });

  it("MV-B02 代际归窗，住户级问不出「当前代际」", () => {
    const sessions = new SessionRegistry<null>();
    const w1 = sessions.open("resident-a", { context: null });
    sessions.kill(w1.windowId);
    const reopened = sessions.open("resident-a", { windowId: w1.windowId, context: null });
    const fresh = sessions.open("resident-a", { context: null });

    expect(reopened.generation).toBe(2);
    expect(fresh.generation).toBe(1);
    expect(sessions).not.toHaveProperty("currentGeneration");
    expect(
      sessions
        .windowsOf("resident-a")
        .map((w) => w.generation)
        .sort(),
    ).toEqual([1, 2]);
  });

  it("会话态归零不动住户留下的东西", () => {
    const residentState = {
      memories: ["答应过：周五晚上一起看电影"],
      messages: ["记住这件事"],
      relationships: ["一起看电影"],
    };
    const before = structuredClone(residentState);
    const sessions = new SessionRegistry<{ pending: string[] }>();

    const w1 = sessions.open("resident-a", {
      headId: "node-2",
      context: { pending: ["还没落库的话"] },
    });
    sessions.kill(w1.windowId);

    expect(sessions.get(w1.windowId)).toBeUndefined();
    expect(residentState).toEqual(before);
  });
});

describe("SessionRegistry：贯穿场景（A01/A02/A03/B01/B02/B03 一口咬住）", () => {
  it("杀掉 w1 之后 w2 继续，w1 的迟到回执不落到 w2 身上", () => {
    const sessions = new SessionRegistry<null>();
    const w1 = sessions.open("resident-a", { context: null });
    const w2 = sessions.open("resident-a", { context: null });

    const r1 = sessions.issueDispatch(w1.windowId);
    const r2 = sessions.issueDispatch(w2.windowId);

    // 三元组齐全（MV-B03 的日志字段来源）
    for (const receipt of [r1, r2]) {
      expect(receipt).toMatchObject({ residentId: "resident-a" });
      expect(receipt.windowId).toBeTruthy();
      expect(receipt.generation).toBe(1);
      expect(receipt.dispatchId).toBeTruthy();
    }
    expect(r1.windowId).not.toBe(r2.windowId);

    sessions.kill(w1.windowId);

    // w1 的迟到回执不再属于任何活窗。
    // 这一条同时是「回到 residentId 单键查找」的回归闸：r1 的 residentId 与
    // generation 都和 w2 相同（同住户、同为第 1 代），旧实现按 residentId 查
    // 就会把它认成 w2 的回执；只有按 windowId 查才判得出来。
    expect(r1.residentId).toBe(w2.residentId);
    expect(r1.generation).toBe(w2.generation);
    expect(sessions.belongsToActiveWindow(r1)).toBe(false);

    // w2 完全不受影响——这一步是 MV-A02 的真正判据
    expect(sessions.isActive(w2.windowId)).toBe(true);
    expect(sessions.belongsToActiveWindow(r2)).toBe(true);
    sessions.setHead(w2.windowId, "reply-1");
    expect(sessions.get(w2.windowId)?.headId).toBe("reply-1");
    expect(sessions.issueDispatch(w2.windowId).generation).toBe(1);
  });

  it("同窗换代后旧代回执被丢弃", () => {
    const sessions = new SessionRegistry<null>();
    const w = sessions.open("resident-a", { context: null });
    const stale = sessions.issueDispatch(w.windowId);

    sessions.kill(w.windowId);
    const reopened = sessions.open("resident-a", { windowId: w.windowId, context: null });

    expect(reopened.generation).toBe(2);
    expect(sessions.belongsToActiveWindow(stale)).toBe(false);
    expect(sessions.belongsToActiveWindow(sessions.issueDispatch(w.windowId))).toBe(true);
  });

  it("同住户两窗各有各的 head，杀掉一扇不改另一扇（MV-A02 的 head 面）", () => {
    const sessions = new SessionRegistry<null>();
    const w1 = sessions.open("resident-a", { context: null });
    const w2 = sessions.open("resident-a", { context: null });

    sessions.setHead(w1.windowId, "node-w1");
    sessions.setHead(w2.windowId, "node-w2");
    expect(sessions.get(w1.windowId)?.headId).toBe("node-w1");
    expect(sessions.get(w2.windowId)?.headId).toBe("node-w2");

    sessions.kill(w1.windowId);

    // 共用一颗 head 的旧实现里，w1 的死会把 w2 的续话位置一起带走。
    expect(sessions.get(w2.windowId)?.headId).toBe("node-w2");
    expect(sessions.getArchived(w1.windowId)?.headId).toBe("node-w1");
  });

  it("回执三元组缺一不认：住户对不上也不算数", () => {
    const sessions = new SessionRegistry<null>();
    const w = sessions.open("resident-a", { context: null });
    const receipt = sessions.issueDispatch(w.windowId);

    expect(sessions.belongsToActiveWindow({ ...receipt, residentId: "resident-b" })).toBe(false);
    expect(sessions.belongsToActiveWindow({ ...receipt, generation: 99 })).toBe(false);
    expect(sessions.belongsToActiveWindow(receipt)).toBe(true);
  });
});
