/**
 * P2 消息树批量 IO：importTree 整批全成或零写入，exportTree 与 history 同语义。
 */
import { describe, expect, it } from "vitest";
import type { HistoryNode } from "../acceptance/driver.ts";
import { MessageTreeError, NODE_UNAVAILABLE } from "../src/message-tree/errors.ts";
import { MessageTreeStore } from "../src/message-tree/store.ts";

const STAMP = "2026-08-14T00:00:00.000Z";

function node(
  id: string,
  parentId: string | null,
  role: HistoryNode["role"],
  content: string,
): HistoryNode {
  return { id, parentId, role, content, createdAt: STAMP };
}

function snapshot(store: MessageTreeStore, residentId: string): string {
  return JSON.stringify(store.exportTree(residentId));
}

describe("exportTree", () => {
  it("与 history 同插入序、同副本语义", () => {
    const store = new MessageTreeStore({
      now: () => STAMP,
      newId: (() => {
        let seq = 0;
        return () => `n${++seq}`;
      })(),
    });
    store.createRoom("r");
    store.appendPair("r", "一", "回一", null);
    store.appendPair("r", "二", "回二", null);

    const exported = store.exportTree("r");
    expect(exported).toEqual(store.history("r"));
    expect(exported.map((item) => item.id)).toEqual(["n1", "n2", "n3", "n4"]);

    const before = snapshot(store, "r");
    const head = exported[0];
    expect(head).toBeDefined();
    (head as { content: string }).content = "外部篡改";
    exported.pop();
    expect(snapshot(store, "r")).toBe(before);
  });
});

describe("importTree 原子性", () => {
  it("坏批零写入：合法前缀加上一条坏节点，房内一个字节不动", () => {
    const store = new MessageTreeStore();
    store.createRoom("r");
    store.importTree("r", [node("keep", null, "system", "已有")]);
    const before = snapshot(store, "r");

    expect(() =>
      store.importTree("r", [
        node("ok-1", null, "user", "好节点"),
        node("ok-2", "ok-1", "assistant", "也好"),
        { ...node("bad", null, "user", "多字段"), extra: true } as HistoryNode,
      ]),
    ).toThrow(MessageTreeError);

    expect(snapshot(store, "r")).toBe(before);
    expect(store.history("r").map((item) => item.id)).toEqual(["keep"]);
  });

  it("批内 id 互撞：整批拒绝，零写入", () => {
    const store = new MessageTreeStore();
    store.createRoom("r");
    expect(() =>
      store.importTree("r", [
        node("dup", null, "user", "一"),
        node("dup", null, "assistant", "二"),
      ]),
    ).toThrow(MessageTreeError);
    expect(store.history("r")).toEqual([]);
  });

  it("空批是合法批：零写入但也不抛", () => {
    const store = new MessageTreeStore();
    store.createRoom("r");
    store.importTree("r", []);
    expect(store.history("r")).toEqual([]);
  });
});

describe("importTree id 撞房", () => {
  it("与房内已有节点撞 id：拒绝覆盖，旧树逐字不动", () => {
    const store = new MessageTreeStore();
    store.createRoom("r");
    store.importTree("r", [node("n1", null, "user", "原件")]);
    const before = snapshot(store, "r");

    expect(() => store.importTree("r", [node("n1", null, "assistant", "覆盖?")])).toThrow(
      MessageTreeError,
    );
    expect(snapshot(store, "r")).toBe(before);
  });
});

describe("importTree 跨房", () => {
  it("另一房的 parentId 当作不存在：文案与真不存在相同，两房零写入", () => {
    const store = new MessageTreeStore();
    store.createRoom("a");
    store.createRoom("b");
    store.importTree("a", [node("a-root", null, "user", "A 的根")]);
    const beforeA = snapshot(store, "a");
    const beforeB = snapshot(store, "b");

    let crossMessage = "";
    let missingMessage = "";
    try {
      store.importTree("b", [node("b-child", "a-root", "assistant", "越权挂 A")]);
    } catch (err) {
      crossMessage = (err as Error).message;
    }
    try {
      store.importTree("b", [node("b-child", "never-existed", "assistant", "挂幽灵")]);
    } catch (err) {
      missingMessage = (err as Error).message;
    }

    expect(crossMessage).toBe(NODE_UNAVAILABLE);
    expect(crossMessage).toBe(missingMessage);
    expect(snapshot(store, "a")).toBe(beforeA);
    expect(snapshot(store, "b")).toBe(beforeB);
  });

  it("另一房已有相同 id 不构成撞房：本房可以收下同号节点", () => {
    const store = new MessageTreeStore();
    store.createRoom("a");
    store.createRoom("b");
    store.importTree("a", [node("shared", null, "user", "A 的")]);
    store.importTree("b", [node("shared", null, "user", "B 的")]);
    expect(store.exportTree("a")[0]?.content).toBe("A 的");
    expect(store.exportTree("b")[0]?.content).toBe("B 的");
  });
});

describe("importTree parent 悬空", () => {
  it("parent 不在房内也不在本批：不透明拒绝，零写入", () => {
    const store = new MessageTreeStore();
    store.createRoom("r");
    expect(() => store.importTree("r", [node("child", "ghost", "user", "悬空")])).toThrow(
      NODE_UNAVAILABLE,
    );
    expect(store.history("r")).toEqual([]);
  });

  it("parent 在本批即可，不必先于子节点出现在数组里", () => {
    const store = new MessageTreeStore();
    store.createRoom("r");
    store.importTree("r", [
      node("child", "parent", "assistant", "先写子"),
      node("parent", null, "user", "后写父"),
    ]);
    expect(store.exportTree("r").map((item) => item.id)).toEqual(["child", "parent"]);
  });
});

describe("importTree 树形拓扑", () => {
  it("自引用节点不是树：整批拒绝，零写入", () => {
    const store = new MessageTreeStore();
    store.createRoom("r");
    expect(() => store.importTree("r", [node("self", "self", "user", "自环")])).toThrow(
      MessageTreeError,
    );
    expect(store.history("r")).toEqual([]);
  });

  it("批内互指成环不是树：整批拒绝，既有树不动", () => {
    const store = new MessageTreeStore();
    store.createRoom("r");
    store.importTree("r", [node("keep", null, "system", "已有")]);
    const before = snapshot(store, "r");

    expect(() =>
      store.importTree("r", [node("a", "b", "user", "A"), node("b", "a", "assistant", "B")]),
    ).toThrow(MessageTreeError);

    expect(snapshot(store, "r")).toBe(before);
  });

  it("接到房内既有节点的批次仍合法", () => {
    const store = new MessageTreeStore();
    store.createRoom("r");
    store.importTree("r", [node("root", null, "system", "已有根")]);
    store.importTree("r", [
      node("leaf", "mid", "assistant", "叶"),
      node("mid", "root", "user", "中间"),
    ]);

    expect(store.exportTree("r").map((item) => [item.id, item.parentId])).toEqual([
      ["root", null],
      ["leaf", "mid"],
      ["mid", "root"],
    ]);
  });
});

describe("export → import → export", () => {
  it("逐字节等价，且按给定数组顺序插入", () => {
    const store = new MessageTreeStore({
      now: () => STAMP,
      newId: (() => {
        let seq = 0;
        return () => `n${++seq}`;
      })(),
    });
    store.createRoom("src");
    store.appendPair("src", "问", "答", null);
    store.appendSibling("src", "n2", "改口");

    const first = store.exportTree("src");
    const firstBytes = JSON.stringify(first);

    store.createRoom("dst");
    store.importTree("dst", first);
    expect(JSON.stringify(store.exportTree("dst"))).toBe(firstBytes);

    store.createRoom("dst2");
    store.importTree("dst2", store.exportTree("dst"));
    expect(JSON.stringify(store.exportTree("dst2"))).toBe(firstBytes);
    expect(JSON.stringify(store.exportTree("src"))).toBe(firstBytes);
  });
});
