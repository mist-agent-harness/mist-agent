import { describe, expect, it } from "vitest";
import { buildBootPack } from "../src/bootpack.ts";
import { ResidentNotFoundError, ResidentStore } from "../src/store/resident-store.ts";

/** 全部用内存态（不传 dataDir），判卷只看行为。 */
function freshStore(): ResidentStore {
  return new ResidentStore();
}

describe("P3 buildBootPack（#15）", () => {
  it("只从存储读：identity 是 createResident 落库的名字，commitments 是 commit() 原文", () => {
    const store = freshStore();
    const r = store.createResident("小试住户");
    store.commit(r, "周五晚上一起看电影");
    store.commit(r, "陪你去医院");
    const pack = buildBootPack(store, r);
    expect(pack.residentId).toBe(r);
    expect(pack.identity).toBe("小试住户");
    expect(pack.commitments).toEqual(["周五晚上一起看电影", "陪你去医院"]);
  });

  it("C1 形状：生前落库的记忆按 id 在包里找得到", () => {
    const store = freshStore();
    const r = store.createResident("c1");
    const entryId = store.remember(r, "答应过的事");
    const pack = buildBootPack(store, r);
    expect(pack.memories.some((m) => m.id === entryId)).toBe(true);
  });

  it("勘误不代裁：死活条目都进包，旧条原文留底并指向新条", () => {
    const store = freshStore();
    const r = store.createResident("c4");
    const wrongId = store.remember(r, "住在深圳华侨城");
    const rightId = store.errata(r, wrongId, "住在武汉华侨城");
    const pack = buildBootPack(store, r);
    const wrong = pack.memories.find((m) => m.id === wrongId);
    const right = pack.memories.find((m) => m.id === rightId);
    expect(wrong).toBeDefined();
    expect(wrong?.content).toBe("住在深圳华侨城");
    expect(wrong?.supersededBy).toBe(rightId);
    expect(right?.supersededBy).toBeNull();
  });

  it("确定性：同一存储状态两次装配，序列化后逐字节相同", () => {
    const store = freshStore();
    const r = store.createResident("det");
    store.commit(r, "承诺甲");
    store.remember(r, "记忆一");
    store.remember(r, "记忆二");
    const a = JSON.stringify(buildBootPack(store, r));
    const b = JSON.stringify(buildBootPack(store, r));
    expect(a).toBe(b);
  });

  it("排序裁定：memories 按 createdAt 再 id，不依赖插入序", () => {
    const store = freshStore();
    const r = store.createResident("sort");
    const idA = store.remember(r, "后写入但时间早");
    const idB = store.remember(r, "先排序靠后");
    const idC = store.remember(r, "同刻靠 id 定序");
    // 白盒改写 createdAt 构造乱序（存储的 Map 插入序 ≠ 时间序的情形）
    const room = store.room(r);
    const get = (id: string) => {
      const entry = room.memories.get(id);
      if (entry === undefined) throw new Error(`test fixture missing ${id}`);
      return entry;
    };
    get(idA).createdAt = "2026-08-14T10:00:00.000Z";
    get(idB).createdAt = "2026-08-14T09:00:00.000Z";
    get(idC).createdAt = "2026-08-14T10:00:00.000Z";
    const pack = buildBootPack(store, r);
    const ids = pack.memories.map((m) => m.id);
    const tied = [idA, idC].sort();
    expect(ids).toEqual([idB, ...tied]);
  });

  it("commitments 保持立的先后，绝不按字典序重排", () => {
    const store = freshStore();
    const r = store.createResident("order");
    store.commit(r, "乙先立");
    store.commit(r, "甲后立");
    expect(buildBootPack(store, r).commitments).toEqual(["乙先立", "甲后立"]);
  });

  it("C5 形状：A 的记忆不出现在 B 的包里", () => {
    const store = freshStore();
    const marker = "串房标记-bootpack";
    const a = store.createResident("a");
    const b = store.createResident("b");
    store.remember(a, marker);
    const packB = buildBootPack(store, b);
    expect(packB.memories.some((m) => m.content.includes(marker))).toBe(false);
  });

  it("包与存储不别名：改返回的包不脏存储，下次装配不受影响", () => {
    const store = freshStore();
    const r = store.createResident("iso");
    const entryId = store.remember(r, "原文");
    const pack = buildBootPack(store, r);
    pack.commitments.push("包上私加的假承诺");
    const entry = pack.memories.find((m) => m.id === entryId);
    if (entry === undefined) throw new Error("fixture");
    entry.content = "包上篡改的正文";
    const again = buildBootPack(store, r);
    expect(again.commitments).toEqual([]);
    expect(again.memories.find((m) => m.id === entryId)?.content).toBe("原文");
  });

  it("住户不存在：抛 ResidentNotFoundError，不返回空包", () => {
    const store = freshStore();
    expect(() => buildBootPack(store, "ghost")).toThrow(ResidentNotFoundError);
  });
});
