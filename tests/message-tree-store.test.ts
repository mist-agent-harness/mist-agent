/**
 * P2 消息树 Store 层测试 —— 判卷 C3 之外按文字合同补严的部分：
 * 精确节点数、旧节点五字段逐一不动、同文不吞、跨房零写入、
 * 返回值与店内隔离、插入序与时间戳解耦。
 * Service 层（say 链式挂载 / head）的测试在 message-tree-service.test.ts。
 */
import { describe, expect, it } from "vitest";
import type { HistoryNode } from "../acceptance/driver.ts";
import { MessageTreeError, NODE_UNAVAILABLE } from "../src/message-tree/errors.ts";
import { MessageTreeStore } from "../src/message-tree/store.ts";

/** 确定性 store：id 递增（n1, n2, …），时钟恒定。 */
function fixedStore(clock = "2026-08-14T00:00:00.000Z"): MessageTreeStore {
  let seq = 0;
  return new MessageTreeStore({
    now: () => clock,
    newId: () => {
      seq += 1;
      return `n${seq}`;
    },
  });
}

function snapshot(store: MessageTreeStore, residentId: string): string {
  return JSON.stringify(store.history(residentId));
}

describe("appendPair", () => {
  it("空房首对：恰好 +2，user 为新根，assistant 挂 user 下，返回 assistant 关系完整", () => {
    const store = fixedStore();
    store.createRoom("r");
    const { user, assistant } = store.appendPair("r", "你好", "收到", null);
    const tree = store.history("r");
    expect(tree).toHaveLength(2);
    expect(user.parentId).toBeNull();
    expect(user.role).toBe("user");
    expect(assistant.parentId).toBe(user.id);
    expect(assistant.role).toBe("assistant");
  });

  it("显式 parentId：user 挂在指定节点下（链式挂载由 Service 决定，Store 只认显式值）", () => {
    const store = fixedStore();
    store.createRoom("r");
    const first = store.appendPair("r", "第一句", "回一", null);
    const second = store.appendPair("r", "第二句", "回二", first.assistant.id);
    expect(second.user.parentId).toBe(first.assistant.id);
    expect(second.assistant.parentId).toBe(second.user.id);
    expect(store.history("r")).toHaveLength(4);
  });

  it("parentId 不存在：不透明拒绝，零写入——没有 user-only 的半截树", () => {
    const store = fixedStore();
    store.createRoom("r");
    expect(() => store.appendPair("r", "半截", "不该出现", "ghost")).toThrow(NODE_UNAVAILABLE);
    expect(store.history("r")).toHaveLength(0);
  });

  it("同文两次不去重：四个节点各有各的 id", () => {
    const store = fixedStore();
    store.createRoom("r");
    const a = store.appendPair("r", "同一句话", "同一个回应", null);
    const b = store.appendPair("r", "同一句话", "同一个回应", null);
    const ids = new Set(store.history("r").map((n) => n.id));
    expect(ids.size).toBe(4);
    expect(a.user.id).not.toBe(b.user.id);
  });
});

describe("appendSibling", () => {
  it("同父分叉：恰好 +1，同 parentId 同 role 新 id，旧节点五字段逐一不动", () => {
    const store = fixedStore();
    store.createRoom("r");
    const { assistant } = store.appendPair("r", "问", "第一版说法", null);
    const before = store.history("r").find((n) => n.id === assistant.id);
    const sibling = store.appendSibling("r", assistant.id, "改口后的说法");
    const tree = store.history("r");
    expect(tree).toHaveLength(3);
    expect(sibling.id).not.toBe(assistant.id);
    expect(sibling.parentId).toBe(assistant.parentId);
    expect(sibling.role).toBe("assistant");
    expect(sibling.content).toBe("改口后的说法");
    const after = tree.find((n) => n.id === assistant.id);
    expect(after).toStrictEqual(before);
  });

  it("对 user 节点分叉：继承 user 角色", () => {
    const store = fixedStore();
    store.createRoom("r");
    const { user } = store.appendPair("r", "原话", "回应", null);
    const sibling = store.appendSibling("r", user.id, "换个问法");
    expect(sibling.role).toBe("user");
    expect(sibling.parentId).toBeNull();
  });

  it("未知 nodeId：不透明拒绝，零写入", () => {
    const store = fixedStore();
    store.createRoom("r");
    store.appendPair("r", "问", "答", null);
    const before = snapshot(store, "r");
    expect(() => store.appendSibling("r", "ghost", "改")).toThrow(NODE_UNAVAILABLE);
    expect(snapshot(store, "r")).toBe(before);
  });

  it("跨房 nodeId：拒绝且两房零写入，报错文案与「真不存在」逐字相同（不可探针）", () => {
    const store = fixedStore();
    store.createRoom("a");
    store.createRoom("b");
    const { assistant } = store.appendPair("a", "A 的话", "A 的回应", null);
    const beforeA = snapshot(store, "a");
    const beforeB = snapshot(store, "b");

    let crossMessage = "";
    let missingMessage = "";
    try {
      store.appendSibling("b", assistant.id, "越权改口");
    } catch (err) {
      crossMessage = (err as Error).message;
    }
    try {
      store.appendSibling("b", "never-existed", "改");
    } catch (err) {
      missingMessage = (err as Error).message;
    }
    expect(crossMessage).toBe(NODE_UNAVAILABLE);
    expect(crossMessage).toBe(missingMessage);
    expect(snapshot(store, "a")).toBe(beforeA);
    expect(snapshot(store, "b")).toBe(beforeB);
  });
});

describe("房间生命周期", () => {
  it("未知住户：appendPair / appendSibling / history 全部拒绝", () => {
    const store = fixedStore();
    expect(() => store.appendPair("ghost", "问", "答", null)).toThrow(MessageTreeError);
    expect(() => store.appendSibling("ghost", "n1", "改")).toThrow(MessageTreeError);
    expect(() => store.history("ghost")).toThrow(MessageTreeError);
  });

  it("重复建房抛错；拆房后房间真的没了；拆不存在的房抛错", () => {
    const store = fixedStore();
    store.createRoom("r");
    expect(() => store.createRoom("r")).toThrow(MessageTreeError);
    store.destroyRoom("r");
    expect(() => store.history("r")).toThrow(MessageTreeError);
    expect(() => store.destroyRoom("r")).toThrow(MessageTreeError);
  });
});

describe("append-only 与隔离", () => {
  it("改返回值改不动历史：appendPair / appendSibling 的返回对象是副本", () => {
    const store = fixedStore();
    store.createRoom("r");
    const pair = store.appendPair("r", "原文", "原回应", null);
    const before = snapshot(store, "r");
    (pair.user as { content: string }).content = "被篡改";
    (pair.assistant as { parentId: string | null }).parentId = null;
    expect(snapshot(store, "r")).toBe(before);
    const sibling = store.appendSibling("r", pair.assistant.id, "分叉");
    const before2 = snapshot(store, "r");
    (sibling as { content: string }).content = "又被篡改";
    expect(snapshot(store, "r")).toBe(before2);
  });

  it("改 history 返回值改不动历史：节点与数组都是副本", () => {
    const store = fixedStore();
    store.createRoom("r");
    store.appendPair("r", "问", "答", null);
    const before = snapshot(store, "r");
    const tree = store.history("r");
    const head = tree[0];
    expect(head).toBeDefined();
    (head as unknown as { content: string }).content = "外部篡改";
    tree.pop();
    expect(snapshot(store, "r")).toBe(before);
  });

  it("插入序即 history 序，与 createdAt 无关：恒定时钟下顺序仍稳定", () => {
    const store = fixedStore("2026-08-14T00:00:00.000Z");
    store.createRoom("r");
    store.appendPair("r", "一", "回一", null);
    store.appendPair("r", "二", "回二", null);
    const ids = store.history("r").map((n) => n.id);
    expect(ids).toStrictEqual(["n1", "n2", "n3", "n4"]);
    const stamps = new Set(store.history("r").map((n) => n.createdAt));
    expect(stamps.size).toBe(1);
  });

  it("HistoryNode 只有契约五字段，不私增", () => {
    const store = fixedStore();
    store.createRoom("r");
    const { user } = store.appendPair("r", "问", "答", null);
    expect(Object.keys(user).sort()).toStrictEqual([
      "content",
      "createdAt",
      "id",
      "parentId",
      "role",
    ] satisfies (keyof HistoryNode)[]);
  });
});
