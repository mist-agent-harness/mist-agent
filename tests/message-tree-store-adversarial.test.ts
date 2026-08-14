/**
 * P2 交叉挑刺：只打 Store 的原子性、跨房边界与 append-only 完整性。
 *
 * 这组测试由 Service 层作者补，不改 Store 实现。红门交回 Store 作者修，
 * 防止同一个人既写实现又替自己的边界作证。
 */
import { describe, expect, it } from "vitest";
import { MessageTreeError, NODE_UNAVAILABLE } from "../src/message-tree/errors.ts";
import { MessageTreeStore } from "../src/message-tree/store.ts";

function snapshot(store: MessageTreeStore, residentId: string): string {
  return JSON.stringify(store.history(residentId));
}

describe("MessageTreeStore 跨房 parent 边界", () => {
  it("appendPair 不接受另一住户的 parentId：报错与真不存在相同，两房零写入", () => {
    let seq = 0;
    const store = new MessageTreeStore({
      now: () => "2026-08-14T00:00:00.000Z",
      newId: () => `n${++seq}`,
    });
    store.createRoom("a");
    store.createRoom("b");
    const { assistant } = store.appendPair("a", "A 的话", "A 的回应", null);
    const beforeA = snapshot(store, "a");
    const beforeB = snapshot(store, "b");

    let crossMessage = "";
    let missingMessage = "";
    try {
      store.appendPair("b", "越权续写", "不该出现", assistant.id);
    } catch (err) {
      crossMessage = (err as Error).message;
    }
    try {
      store.appendPair("b", "不存在续写", "也不该出现", "never-existed");
    } catch (err) {
      missingMessage = (err as Error).message;
    }

    expect(crossMessage).toBe(NODE_UNAVAILABLE);
    expect(crossMessage).toBe(missingMessage);
    expect(snapshot(store, "a")).toBe(beforeA);
    expect(snapshot(store, "b")).toBe(beforeB);
  });
});

describe("MessageTreeStore id 碰撞不得覆盖历史", () => {
  it("同一 appendPair 的 user/assistant 得到相同 id：整对拒绝且零写入", () => {
    const store = new MessageTreeStore({
      now: () => "2026-08-14T00:00:00.000Z",
      newId: () => "collision",
    });
    store.createRoom("r");

    expect(() => store.appendPair("r", "问", "答", null)).toThrow(MessageTreeError);
    expect(store.history("r")).toStrictEqual([]);
  });

  it("新 sibling 的 id 撞上已有节点：拒绝且旧树逐字不动", () => {
    const ids = ["user-1", "assistant-1", "user-1"];
    const store = new MessageTreeStore({
      now: () => "2026-08-14T00:00:00.000Z",
      newId: () => ids.shift() ?? "unexpected-id",
    });
    store.createRoom("r");
    const { assistant } = store.appendPair("r", "原问", "原答", null);
    const before = snapshot(store, "r");

    expect(() => store.appendSibling("r", assistant.id, "新分叉")).toThrow(MessageTreeError);
    expect(snapshot(store, "r")).toBe(before);
  });
});

describe("MessageTreeStore appendPair 生成阶段失败仍为零写入", () => {
  it("第二次取 id 抛错：user 不得先落成半截", () => {
    let calls = 0;
    const store = new MessageTreeStore({
      now: () => "2026-08-14T00:00:00.000Z",
      newId: () => {
        calls += 1;
        if (calls === 2) throw new Error("id source failed");
        return `n${calls}`;
      },
    });
    store.createRoom("r");

    expect(() => store.appendPair("r", "问", "答", null)).toThrow("id source failed");
    expect(store.history("r")).toStrictEqual([]);
  });

  it("生成 assistant 时间戳时抛错：user 不得先落成半截", () => {
    let idCalls = 0;
    let clockCalls = 0;
    const store = new MessageTreeStore({
      newId: () => `n${++idCalls}`,
      now: () => {
        clockCalls += 1;
        if (clockCalls === 2) throw new Error("clock failed");
        return "2026-08-14T00:00:00.000Z";
      },
    });
    store.createRoom("r");

    expect(() => store.appendPair("r", "问", "答", null)).toThrow("clock failed");
    expect(store.history("r")).toStrictEqual([]);
  });
});
