import { describe, expect, it } from "vitest";
import { MessageTreeService, MessageTreeStore } from "../src/message-tree/index.ts";
import type { SessionHeadPort } from "../src/message-tree/index.ts";

class TestSessionHeads implements SessionHeadPort {
  readonly #heads = new Map<string, string>();
  readonly writes: Array<{ residentId: string; headId: string }> = [];
  beforeSet?: (residentId: string, headId: string) => void;

  getHead(residentId: string): string | null {
    return this.#heads.get(residentId) ?? null;
  }

  setHead(residentId: string, headId: string): void {
    this.beforeSet?.(residentId, headId);
    this.#heads.set(residentId, headId);
    this.writes.push({ residentId, headId });
  }

  kill(residentId: string): void {
    this.#heads.delete(residentId);
  }

  force(residentId: string, headId: string): void {
    this.#heads.set(residentId, headId);
  }
}

function deterministicStore(): MessageTreeStore {
  let next = 0;
  return new MessageTreeStore({
    now: () => "2026-08-14T06:00:00.000Z",
    newId: () => `node-${++next}`,
  });
}

function setup() {
  const store = deterministicStore();
  const heads = new TestSessionHeads();
  store.createRoom("resident-a");
  const service = new MessageTreeService(store, heads, {
    assistantReply: (_residentId, message) => `回应：${message}`,
  });
  return { store, heads, service };
}

describe("MessageTreeService.say", () => {
  it("首轮原子落双节点，全部落完后才把 head 指向 assistant", async () => {
    const { store, heads, service } = setup();
    heads.beforeSet = (_residentId, headId) => {
      const tree = store.history("resident-a");
      expect(tree).toHaveLength(2);
      expect(tree.some((node) => node.id === headId && node.role === "assistant")).toBe(true);
    };

    const reply = await service.say("resident-a", "第一句", "resident-a");
    const tree = await service.history("resident-a");

    expect(tree).toEqual([
      {
        id: "node-1",
        parentId: null,
        role: "user",
        content: "第一句",
        createdAt: "2026-08-14T06:00:00.000Z",
      },
      {
        id: "node-2",
        parentId: "node-1",
        role: "assistant",
        content: "回应：第一句",
        createdAt: "2026-08-14T06:00:00.000Z",
      },
    ]);
    expect(reply).toEqual(tree[1]);
    expect(heads.getHead("resident-a")).toBe(reply.id);
    expect(heads.writes).toEqual([{ residentId: "resident-a", headId: reply.id }]);
  });

  it("同一会话第二轮 user 挂在上一轮 assistant 下", async () => {
    const { heads, service } = setup();
    const firstReply = await service.say("resident-a", "第一句", "resident-a");
    const secondReply = await service.say("resident-a", "第二句", "resident-a");
    const tree = await service.history("resident-a");
    const secondUser = tree.find((node) => node.content === "第二句" && node.role === "user");

    expect(tree).toHaveLength(4);
    expect(secondUser?.parentId).toBe(firstReply.id);
    expect(secondReply.parentId).toBe(secondUser?.id);
    expect(heads.getHead("resident-a")).toBe(secondReply.id);
  });

  it("会话 head 被杀后，下一轮从新根开始且旧树不动", async () => {
    const { heads, service } = setup();
    await service.say("resident-a", "旧会话", "resident-a");
    const beforeKill = await service.history("resident-a");

    heads.kill("resident-a");
    const newReply = await service.say("resident-a", "新会话", "resident-a");
    const afterKill = await service.history("resident-a");
    const newUser = afterKill.find((node) => node.content === "新会话" && node.role === "user");

    expect(afterKill.slice(0, beforeKill.length)).toEqual(beforeKill);
    expect(newUser?.parentId).toBeNull();
    expect(newReply.parentId).toBe(newUser?.id);
  });

  it("回应生成失败时不写节点也不推进 head", async () => {
    const store = deterministicStore();
    const heads = new TestSessionHeads();
    store.createRoom("resident-a");
    const service = new MessageTreeService(store, heads, {
      assistantReply: () => {
        throw new Error("model unavailable");
      },
    });

    await expect(service.say("resident-a", "不会落库", "resident-a")).rejects.toThrow(
      "model unavailable",
    );
    expect(store.history("resident-a")).toEqual([]);
    expect(heads.writes).toEqual([]);
  });

  it("未知住户在 responder 之前被拒绝", async () => {
    const store = deterministicStore();
    const heads = new TestSessionHeads();
    let responderCalls = 0;
    const service = new MessageTreeService(store, heads, {
      assistantReply: () => {
        responderCalls += 1;
        return "不应生成";
      },
    });

    await expect(service.say("ghost", "不会进 responder", "ghost")).rejects.toThrow();
    expect(responderCalls).toBe(0);
    expect(heads.writes).toEqual([]);
  });

  it("head 指向本房不存在节点时整轮拒绝且不移动 head", async () => {
    const { store, heads, service } = setup();
    heads.force("resident-a", "missing-parent");

    await expect(service.say("resident-a", "不能悬空", "resident-a")).rejects.toThrow();
    expect(store.history("resident-a")).toEqual([]);
    expect(heads.getHead("resident-a")).toBe("missing-parent");
    expect(heads.writes).toEqual([]);
  });

  it("相同正文的两轮仍各自落完整节点，不按内容去重", async () => {
    const { service } = setup();
    await service.say("resident-a", "重复", "resident-a");
    await service.say("resident-a", "重复", "resident-a");

    const tree = await service.history("resident-a");
    expect(tree).toHaveLength(4);
    expect(tree.filter((node) => node.role === "user" && node.content === "重复")).toHaveLength(2);
    expect(new Set(tree.map((node) => node.id)).size).toBe(4);
  });

  it("修改 say/history 返回对象不能篡改 Store 原件", async () => {
    const { service } = setup();
    const reply = await service.say("resident-a", "原文", "resident-a");
    const before = await service.history("resident-a");
    const first = before[0];
    if (first === undefined) {
      throw new Error("test setup did not persist the user node");
    }

    reply.content = "篡改返回值";
    first.content = "篡改历史副本";
    before.pop();

    expect(await service.history("resident-a")).toEqual([
      expect.objectContaining({ role: "user", content: "原文" }),
      expect.objectContaining({ role: "assistant", content: "回应：原文" }),
    ]);
  });
});

describe("MessageTreeService.reviseNode", () => {
  it("只新增同父同角色兄弟，旧节点完整不变", async () => {
    const { service } = setup();
    const reply = await service.say("resident-a", "初稿", "resident-a");
    const before = await service.history("resident-a");
    const old = before.find((node) => node.id === reply.id);
    if (old === undefined) {
      throw new Error("test setup did not persist the assistant reply");
    }
    const oldBefore = structuredClone(old);

    const revised = await service.reviseNode("resident-a", reply.id, "改口", "resident-a");
    const after = await service.history("resident-a");

    expect(after).toHaveLength(before.length + 1);
    expect(after.find((node) => node.id === reply.id)).toEqual(oldBefore);
    expect(revised).toMatchObject({
      parentId: reply.parentId,
      role: reply.role,
      content: "改口",
    });
    expect(revised.id).not.toBe(reply.id);
  });

  it("跨房节点拒绝且两房零写入", async () => {
    const { store, service } = setup();
    store.createRoom("resident-b");
    const reply = await service.say("resident-a", "只属于 A", "resident-a");
    const beforeA = store.history("resident-a");
    const beforeB = store.history("resident-b");

    await expect(
      service.reviseNode("resident-b", reply.id, "越权", "resident-b"),
    ).rejects.toThrow();
    expect(store.history("resident-a")).toEqual(beforeA);
    expect(store.history("resident-b")).toEqual(beforeB);
  });

  it("assistant 改口即换枝：下一轮 user 挂在新兄弟下", async () => {
    const { heads, service } = setup();
    const reply = await service.say("resident-a", "初稿", "resident-a");
    const revised = await service.reviseNode("resident-a", reply.id, "改口", "resident-a");
    const nextReply = await service.say("resident-a", "沿新枝继续", "resident-a");
    const nextUser = (await service.history("resident-a")).find(
      (node) => node.role === "user" && node.content === "沿新枝继续",
    );

    expect(heads.getHead("resident-a")).toBe(nextReply.id);
    expect(nextUser?.parentId).toBe(revised.id);
    expect(nextReply.parentId).toBe(nextUser?.id);
  });
});
