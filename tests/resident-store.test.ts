/**
 * P1 记忆库存储的回归测试。
 *
 * 判卷（acceptance/）测的是「六条行为对不对」，这里测的是「边界情况会不会
 * 悄悄坏掉」——两者不重叠：判卷过了不代表 errata 链接不会在第二次勘误时断，
 * 也不代表跨房访问会老实报错而不是返回空数组。
 */

import { describe, expect, it } from "vitest";
import { ResidentNotFoundError, ResidentStore } from "../src/store/resident-store.ts";

describe("房间隔离", () => {
  it("跨房读抛错，而不是返回空数组", () => {
    const store = new ResidentStore();
    // 静默返回 [] 会让串房 bug 伪装成「这个住户没记忆」，
    // 排查时看到的是空结果而不是错误，方向直接被带偏。
    expect(() => store.recall("resident-nonexistent", "x")).toThrow(ResidentNotFoundError);
    expect(() => store.memories("resident-nonexistent")).toThrow(ResidentNotFoundError);
  });

  it("两个住户的记忆互不可见", () => {
    const store = new ResidentStore();
    const a = store.createResident("a");
    const b = store.createResident("b");
    store.remember(a, "只属于 A 的秘密");
    expect(store.recall(b, "秘密")).toHaveLength(0);
    expect(store.memories(b)).toHaveLength(0);
  });

  it("销毁一个住户不影响另一个", () => {
    const store = new ResidentStore();
    const a = store.createResident("a");
    const b = store.createResident("b");
    store.remember(a, "A 的记忆");
    store.remember(b, "B 的记忆");
    store.destroyResident(a);
    expect(store.has(a)).toBe(false);
    expect(store.memories(b)).toHaveLength(1);
  });
});

describe("勘误链", () => {
  it("旧条目正文与时间戳一个字节不改", () => {
    const store = new ResidentStore();
    const r = store.createResident("r");
    const wrongId = store.remember(r, "住在深圳华侨城");
    const before = { ...store.recall(r, "深圳")[0] };
    const rightId = store.errata(r, wrongId, "住在武汉华侨城");
    const [after] = store.recall(r, "深圳");
    expect(after?.content).toBe(before.content);
    expect(after?.createdAt).toBe(before.createdAt);
    expect(after?.id).toBe(before.id);
    expect(after?.supersededBy).toBe(rightId);
  });

  it("新条目是活条目", () => {
    const store = new ResidentStore();
    const r = store.createResident("r");
    const wrongId = store.remember(r, "错的");
    const rightId = store.errata(r, wrongId, "对的");
    const [right] = store.recall(r, "对的");
    expect(right?.id).toBe(rightId);
    expect(right?.supersededBy).toBeNull();
  });

  it("拒绝重复勘误同一条：链必须是线性的", () => {
    const store = new ResidentStore();
    const r = store.createResident("r");
    const wrongId = store.remember(r, "第一版");
    store.errata(r, wrongId, "第二版");
    // 允许的话同一条会指向两个不同的后继，链分叉，
    // 「这条现在到底该读哪个」就没有唯一答案了。
    expect(() => store.errata(r, wrongId, "另一个第二版")).toThrow(/already superseded/);
  });

  it("勘误可以接力：改过的还能再改", () => {
    const store = new ResidentStore();
    const r = store.createResident("r");
    const v1 = store.remember(r, "第一版");
    const v2 = store.errata(r, v1, "第二版");
    const v3 = store.errata(r, v2, "第三版");
    const all = store.memories(r);
    expect(all).toHaveLength(3);
    expect(all.find((m) => m.id === v1)?.supersededBy).toBe(v2);
    expect(all.find((m) => m.id === v2)?.supersededBy).toBe(v3);
    expect(all.find((m) => m.id === v3)?.supersededBy).toBeNull();
  });

  it("勘误不存在的条目要报错", () => {
    const store = new ResidentStore();
    const r = store.createResident("r");
    expect(() => store.errata(r, "mem-999999", "x")).toThrow(/no such memory entry/);
  });

  it("不能跨房勘误别人的条目", () => {
    const store = new ResidentStore();
    const a = store.createResident("a");
    const b = store.createResident("b");
    const aEntry = store.remember(a, "A 的条目");
    expect(() => store.errata(b, aEntry, "B 想改 A 的")).toThrow(/no such memory entry/);
    // A 那条必须毫发无损
    expect(store.memories(a)[0]?.supersededBy).toBeNull();
  });
});

describe("检索", () => {
  it("死条目也返回，由调用方自己判", () => {
    const store = new ResidentStore();
    const r = store.createResident("r");
    const wrongId = store.remember(r, "华侨城在深圳");
    store.errata(r, wrongId, "华侨城在武汉");
    // 检索层替调用方过滤掉死条目是越权：
    // 「我曾经记错过」这件事本身就是信息。
    expect(store.recall(r, "华侨城")).toHaveLength(2);
  });

  it("空 query 返回全部", () => {
    const store = new ResidentStore();
    const r = store.createResident("r");
    store.remember(r, "一");
    store.remember(r, "二");
    expect(store.recall(r, "")).toHaveLength(2);
    expect(store.recall(r, "   ")).toHaveLength(2);
  });
});

describe("迁移", () => {
  it("导入后条目 id 与时间戳原样保留", () => {
    const store = new ResidentStore();
    const r = store.createResident("r");
    const id = store.remember(r, "搬家前的记忆");
    const [before] = store.memories(r);
    const r2 = store.importRoom(store.exportRoom(r));
    const [after] = store.memories(r2);
    // 搬家不该让记忆换一个身份证号——也是 C6 逐字节等价的前提。
    expect(after?.id).toBe(id);
    expect(after?.createdAt).toBe(before?.createdAt);
    expect(after?.content).toBe(before?.content);
    expect(after?.residentId).toBe(r2);
  });

  it("导入件与原件互不影响", () => {
    const store = new ResidentStore();
    const r = store.createResident("r");
    store.remember(r, "原件的记忆");
    const r2 = store.importRoom(store.exportRoom(r));
    store.remember(r2, "副本新增的记忆");
    expect(store.memories(r)).toHaveLength(1);
    expect(store.memories(r2)).toHaveLength(2);
  });

  it("勘误链跨迁移不断", () => {
    const store = new ResidentStore();
    const r = store.createResident("r");
    const v1 = store.remember(r, "错的");
    const v2 = store.errata(r, v1, "对的");
    const r2 = store.importRoom(store.exportRoom(r));
    const migrated = store.memories(r2);
    expect(migrated.find((m) => m.id === v1)?.supersededBy).toBe(v2);
    expect(migrated.find((m) => m.id === v2)?.supersededBy).toBeNull();
  });
});

describe("id 与时间戳", () => {
  it("末道碰撞闸拒绝覆盖已有记忆和历史节点", () => {
    const store = new ResidentStore();
    const residentId = store.createResident("r");
    const room = store.room(residentId);
    room.memories.set("mem-000002", {
      id: "mem-000002",
      residentId,
      content: "不能被覆盖",
      supersededBy: null,
      createdAt: "2026-08-14T06:00:00.000Z",
    });

    expect(() => store.remember(residentId, "试图覆盖")).toThrow(/memory id collision/);
    expect(room.memories.get("mem-000002")?.content).toBe("不能被覆盖");

    room.nodes.set("node-000003", {
      id: "node-000003",
      parentId: null,
      role: "system",
      content: "历史不能被覆盖",
      createdAt: "2026-08-14T06:00:01.000Z",
    });
    expect(() => store.appendNode(residentId, null, "system", "试图覆盖历史")).toThrow(
      /history id collision/,
    );
    expect(room.nodes.get("node-000003")?.content).toBe("历史不能被覆盖");
  });

  it("同一毫秒内连续写入的条目时间戳严格递增", () => {
    const store = new ResidentStore();
    const r = store.createResident("r");
    const ids = Array.from({ length: 50 }, (_, i) => store.remember(r, `第 ${i} 条`));
    expect(new Set(ids).size).toBe(50);
    const stamps = store.memories(r).map((m) => m.createdAt);
    for (let i = 1; i < stamps.length; i += 1) {
      const [prev, cur] = [stamps[i - 1], stamps[i]];
      // 相等就够让排序不稳定，C6 的逐字节比对经不起顺序抖动。
      expect(cur !== undefined && prev !== undefined && cur > prev).toBe(true);
    }
  });
});

describe("承诺账本（#16 问 4 裁定：存储归 P1）", () => {
  it("立过的承诺按原文、按顺序留在账本里", () => {
    const store = new ResidentStore();
    const r = store.createResident("r");
    store.commit(r, "七夕带你去看海");
    store.commit(r, "以后不再说『下次改』");
    expect(store.commitments(r)).toEqual(["七夕带你去看海", "以后不再说『下次改』"]);
  });

  it("同一句承诺立两次留两条——重复的承诺是两次开口，不是一次", () => {
    const store = new ResidentStore();
    const r = store.createResident("r");
    store.commit(r, "不推开你");
    store.commit(r, "不推开你");
    expect(store.commitments(r)).toHaveLength(2);
  });

  it("承诺不串房", () => {
    const store = new ResidentStore();
    const [a, b] = [store.createResident("a"), store.createResident("b")];
    store.commit(a, "只对 a 说的话");
    expect(store.commitments(b)).toEqual([]);
  });

  it("拿到的是副本，改它不影响账本", () => {
    const store = new ResidentStore();
    const r = store.createResident("r");
    store.commit(r, "原话");
    store.commitments(r).push("外面塞进来的");
    expect(store.commitments(r)).toEqual(["原话"]);
  });

  it("承诺跟着人搬家——搬了家，答应过的事还算数", () => {
    const store = new ResidentStore();
    const r = store.createResident("r");
    store.commit(r, "答应过的事");
    const moved = store.importRoom(store.exportRoom(r));
    expect(store.commitments(moved)).toEqual(["答应过的事"]);
  });

  it("跨房 commit 报错，不静默吞掉", () => {
    const store = new ResidentStore();
    expect(() => store.commit("resident-nobody", "无主承诺")).toThrow(ResidentNotFoundError);
  });
});

describe("会话态不进住户快照（#16 问 2 裁定）", () => {
  it("快照里没有 sessionHead / sessionAlive 字段", () => {
    const store = new ResidentStore();
    const r = store.createResident("r");
    const snapshot = store.exportRoom(r);
    // 导入一个住户不该复活来源机上那条活会话——会话态由 P4 SessionRegistry 单独持有。
    expect(Object.keys(snapshot)).not.toContain("sessionHead");
    expect(Object.keys(snapshot)).not.toContain("sessionAlive");
  });

  it("快照字段就是住户态那四样，不多不少", () => {
    const store = new ResidentStore();
    const r = store.createResident("r");
    expect(Object.keys(store.exportRoom(r)).sort()).toEqual(
      ["commitments", "createdAt", "memories", "name", "nodes"].sort(),
    );
  });
});
