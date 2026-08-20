/**
 * Service 层对抗测试 —— 交叉挑刺（Store 作者打 Service，设计052 流程第 1 段）。
 * 只打 message-tree-service.test.ts 没覆盖的角落：多住户 head 隔离、异步 responder、
 * setHead 失败的落点、service 出口的不透明性、user 节点改口、同点二次分叉。
 * 不触碰未裁定的 revise-head 语义（it.todo 在 service 测试里守着）。
 */
import { describe, expect, it } from "vitest";
import {
  MessageTreeService,
  MessageTreeStore,
  NODE_UNAVAILABLE,
} from "../src/message-tree/index.ts";
import type { SessionHeadPort } from "../src/message-tree/index.ts";

class Heads implements SessionHeadPort {
  readonly #map = new Map<string, string>();
  failNextSet = false;

  getHead(residentId: string): string | null {
    return this.#map.get(residentId) ?? null;
  }

  setHead(residentId: string, headId: string): void {
    if (this.failNextSet) {
      this.failNextSet = false;
      throw new Error("session registry unavailable");
    }
    this.#map.set(residentId, headId);
  }

  force(residentId: string, headId: string): void {
    this.#map.set(residentId, headId);
  }
}

function setup() {
  let seq = 0;
  const store = new MessageTreeStore({
    now: () => "2026-08-14T06:00:00.000Z",
    newId: () => `n${++seq}`,
  });
  const heads = new Heads();
  const service = new MessageTreeService(store, heads, {
    assistantReply: (_rid, message) => `回：${message}`,
  });
  return { store, heads, service };
}

describe("多住户交错", () => {
  it("A、B 交错 say：两条链各自延伸，head 互不越界", async () => {
    const { store, heads, service } = setup();
    store.createRoom("a");
    store.createRoom("b");

    const a1 = await service.say("a", "A 一", "a");
    const b1 = await service.say("b", "B 一", "b");
    const a2 = await service.say("a", "A 二", "a");
    const b2 = await service.say("b", "B 二", "b");

    const treeA = await service.history("a");
    const treeB = await service.history("b");
    expect(treeA).toHaveLength(4);
    expect(treeB).toHaveLength(4);
    // A 的第二轮 user 挂 A 的第一轮 assistant 下，与 B 的动作无关
    const a2User = treeA.find((n) => n.role === "user" && n.content === "A 二");
    const b2User = treeB.find((n) => n.role === "user" && n.content === "B 二");
    expect(a2User?.parentId).toBe(a1.id);
    expect(b2User?.parentId).toBe(b1.id);
    expect(heads.getHead("a")).toBe(a2.id);
    expect(heads.getHead("b")).toBe(b2.id);
    // 两房节点 id 集合不相交
    const idsA = new Set(treeA.map((n) => n.id));
    expect(treeB.every((n) => !idsA.has(n.id))).toBe(true);
  });
});

describe("异步 responder", () => {
  it("Promise 回应也走完整原子路径，responder 收到正确实参", async () => {
    const { store, heads, service } = setup();
    store.createRoom("a");
    const calls: Array<{ rid: string; msg: string }> = [];
    const slowService = new MessageTreeService(store, heads, {
      assistantReply: async (rid, msg) => {
        calls.push({ rid, msg });
        await Promise.resolve();
        return `异步回：${msg}`;
      },
    });

    const reply = await slowService.say("a", "慢一点", "a");
    expect(calls).toStrictEqual([{ rid: "a", msg: "慢一点" }]);
    expect(reply.content).toBe("异步回：慢一点");
    expect((await slowService.history("a")).map((n) => n.content)).toStrictEqual([
      "慢一点",
      "异步回：慢一点",
    ]);
  });
});

describe("setHead 失败的落点", () => {
  it("双节点已落树后 setHead 抛错：错误上抛，树保持 append-only 不回滚，head 停在原地", async () => {
    const { store, heads, service } = setup();
    store.createRoom("a");
    const first = await service.say("a", "第一轮", "a");

    heads.failNextSet = true;
    await expect(service.say("a", "第二轮", "a")).rejects.toThrow("session registry unavailable");

    // append-only：已落的节点不因 head 失败而消失——树永不回滚
    const tree = await service.history("a");
    expect(tree).toHaveLength(4);
    // head 仍指第一轮 assistant，下一轮从旧 head 分叉而不是断链
    expect(heads.getHead("a")).toBe(first.id);
    const third = await service.say("a", "第三轮", "a");
    const thirdUser = (await service.history("a")).find(
      (n) => n.role === "user" && n.content === "第三轮",
    );
    expect(thirdUser?.parentId).toBe(first.id);
    expect(third.parentId).toBe(thirdUser?.id);
  });
});

describe("service 出口的不透明性", () => {
  it("跨房 revise 与真不存在的 revise，从 service 出口拿到的报错文案逐字相同", async () => {
    const { store, service } = setup();
    store.createRoom("a");
    store.createRoom("b");
    const reply = await service.say("a", "A 的话", "a");

    let crossMessage = "";
    let missingMessage = "";
    try {
      await service.reviseNode("b", reply.id, "越权", "b");
    } catch (err) {
      crossMessage = (err as Error).message;
    }
    try {
      await service.reviseNode("b", "never-existed", "改", "b");
    } catch (err) {
      missingMessage = (err as Error).message;
    }
    expect(crossMessage).toBe(NODE_UNAVAILABLE);
    expect(crossMessage).toBe(missingMessage);
  });

  it("未知住户走 history / reviseNode 也被拒绝（say 之外的口同样不开门）", async () => {
    const { service } = setup();
    await expect(service.history("ghost")).rejects.toThrow();
    await expect(service.reviseNode("ghost", "n1", "改", "ghost")).rejects.toThrow();
  });
});

describe("失效 head 在 responder 前 fail-close", () => {
  it("本房不存在的 head：responder 零调用，树与 head 逐字不动", async () => {
    const { store, heads } = setup();
    store.createRoom("a");
    heads.force("a", "missing-head");
    const beforeTree = JSON.stringify(store.history("a"));
    const beforeHead = heads.getHead("a");
    let responderCalls = 0;
    const guardedService = new MessageTreeService(store, heads, {
      assistantReply: () => {
        responderCalls += 1;
        return "不该生成";
      },
    });

    await expect(guardedService.say("a", "不会付模型成本", "a")).rejects.toThrow(NODE_UNAVAILABLE);
    expect(responderCalls).toBe(0);
    expect(JSON.stringify(store.history("a"))).toBe(beforeTree);
    expect(heads.getHead("a")).toBe(beforeHead);
  });

  it("A 房节点被塞成 B 房 head：responder 零调用，两房树与 head 逐字不动", async () => {
    const { store, heads, service } = setup();
    store.createRoom("a");
    store.createRoom("b");
    const aReply = await service.say("a", "只属于 A", "a");
    heads.force("b", aReply.id);
    const beforeTreeA = JSON.stringify(store.history("a"));
    const beforeTreeB = JSON.stringify(store.history("b"));
    const beforeHeadA = heads.getHead("a");
    const beforeHeadB = heads.getHead("b");
    let responderCalls = 0;
    const guardedService = new MessageTreeService(store, heads, {
      assistantReply: () => {
        responderCalls += 1;
        return "不该生成";
      },
    });

    await expect(guardedService.say("b", "不能跨房续写", "b")).rejects.toThrow(NODE_UNAVAILABLE);
    expect(responderCalls).toBe(0);
    expect(JSON.stringify(store.history("a"))).toBe(beforeTreeA);
    expect(JSON.stringify(store.history("b"))).toBe(beforeTreeB);
    expect(heads.getHead("a")).toBe(beforeHeadA);
    expect(heads.getHead("b")).toBe(beforeHeadB);
  });
});

describe("改口的角落", () => {
  it("对 user 节点改口：继承 user 角色，同父成兄弟", async () => {
    const { store, service } = setup();
    store.createRoom("a");
    await service.say("a", "原问法", "a");
    const userNode = (await service.history("a")).find((n) => n.role === "user");
    expect(userNode).toBeDefined();
    if (userNode === undefined) throw new Error("unreachable");

    const revised = await service.reviseNode("a", userNode.id, "换个问法", "a");
    expect(revised.role).toBe("user");
    expect(revised.parentId).toBe(userNode.parentId);
    expect(revised.id).not.toBe(userNode.id);
  });

  it("同一节点二次改口：两个兄弟并存同父，旧节点始终不动", async () => {
    const { service, store } = setup();
    store.createRoom("a");
    const reply = await service.say("a", "初稿", "a");
    const snapshot = JSON.stringify((await service.history("a")).find((n) => n.id === reply.id));

    const r1 = await service.reviseNode("a", reply.id, "第二版", "a");
    const r2 = await service.reviseNode("a", reply.id, "第三版", "a");
    const tree = await service.history("a");

    expect(tree).toHaveLength(4);
    expect(r1.parentId).toBe(reply.parentId);
    expect(r2.parentId).toBe(reply.parentId);
    expect(new Set([reply.id, r1.id, r2.id]).size).toBe(3);
    expect(JSON.stringify(tree.find((n) => n.id === reply.id))).toBe(snapshot);
  });

  it("user 改口也切 head：未重新生成便继续 say 时，有意形成 user 挂 user", async () => {
    const { service, store, heads } = setup();
    store.createRoom("a");
    await service.say("a", "原问法", "a");
    const originalUser = (await service.history("a")).find(
      (node) => node.role === "user" && node.content === "原问法",
    );
    expect(originalUser).toBeDefined();
    if (originalUser === undefined) throw new Error("unreachable");

    const revisedUser = await service.reviseNode("a", originalUser.id, "修订后的问法", "a");
    const nextReply = await service.say("a", "不经重新生成，直接续话", "a");
    const nextUser = (await service.history("a")).find(
      (node) => node.role === "user" && node.content === "不经重新生成，直接续话",
    );

    expect(revisedUser.role).toBe("user");
    expect(nextUser?.role).toBe("user");
    expect(nextUser?.parentId).toBe(revisedUser.id);
    expect(nextReply.parentId).toBe(nextUser?.id);
    expect(heads.getHead("a")).toBe(nextReply.id);
  });
});
