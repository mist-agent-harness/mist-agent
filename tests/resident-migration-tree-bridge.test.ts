/**
 * 迁移桥接到 P2 真树：history 走 exportTree/importTree，
 * importTree 失败走 M0 补偿回滚（拆刚导的房，原件不动）。
 */
import { describe, expect, it } from "vitest";
import type { HistoryNode } from "../acceptance/driver.ts";
import { MessageTreeError } from "../src/message-tree/errors.ts";
import { MessageTreeStore } from "../src/message-tree/store.ts";
import {
  ResidentStoreMigrationPort,
  createResidentMigrationService,
} from "../src/migration/resident-store-migration.ts";
import { ResidentStore } from "../src/store/resident-store.ts";

const STAMP = "2026-08-14T06:00:00.000Z";

function historyNode(
  id: string,
  parentId: string | null,
  role: HistoryNode["role"],
  content: string,
): HistoryNode {
  return { id, parentId, role, content, createdAt: STAMP };
}

describe("迁移桥读 P2 真树", () => {
  it("snapshot 的 history 来自 exportTree，不读 P1 空架子上的 nodes", async () => {
    const store = new ResidentStore();
    const tree = new MessageTreeStore();
    const residentId = store.createResident("有树的人");
    tree.createRoom(residentId);
    store.appendNode(residentId, null, "system", "P1 架子上的节点，桥不该看见");
    tree.importTree(residentId, [
      historyNode("real-1", null, "user", "真树上的话"),
      historyNode("real-2", "real-1", "assistant", "真树上的回应"),
    ]);

    const snapshot = await new ResidentStoreMigrationPort(store, tree).snapshotResident(residentId);
    expect(snapshot.history.map((node) => node.id)).toEqual(["real-1", "real-2"]);
    expect(snapshot.history.map((node) => node.content)).toEqual(["真树上的话", "真树上的回应"]);
  });

  it("导入后树在 P2，P1 房间 nodes 仍为空", async () => {
    const source = new ResidentStore();
    const sourceTree = new MessageTreeStore();
    const sourceId = source.createResident("来源");
    sourceTree.createRoom(sourceId);
    source.remember(sourceId, "一条记忆");
    sourceTree.importTree(sourceId, [historyNode("n1", null, "user", "迁过去")]);

    const pack = await createResidentMigrationService(source, sourceTree).exportResident(sourceId);
    const target = new ResidentStore();
    const targetTree = new MessageTreeStore();
    const moved = await createResidentMigrationService(target, targetTree).importResident(pack);

    expect(target.exportRoom(moved).nodes).toEqual([]);
    expect(targetTree.exportTree(moved)).toEqual(sourceTree.exportTree(sourceId));
  });
});

describe("importTree 失败的补偿回滚", () => {
  it("新房不可见，原件无损", async () => {
    const store = new ResidentStore();
    const tree = new MessageTreeStore();
    const originalId = store.createResident("原件");
    tree.createRoom(originalId);
    store.commit(originalId, "答应过的还在");
    const memoryId = store.remember(originalId, "不该被动");
    tree.importTree(originalId, [historyNode("orig", null, "user", "原树")]);
    const beforeRoom = JSON.stringify(store.exportRoom(originalId));
    const beforeTree = JSON.stringify(tree.exportTree(originalId));

    const port = new ResidentStoreMigrationPort(store, tree);
    await expect(
      port.commitImportedResident({
        sourceResidentId: originalId,
        resident: { name: "不该留下", createdAt: STAMP },
        commitments: ["新承诺"],
        memories: [
          {
            id: "mem-imported",
            residentId: originalId,
            content: "不该落地",
            supersededBy: null,
            createdAt: "2026-08-14T06:00:01.000Z",
          },
        ],
        history: [historyNode("orphan", "ghost-parent", "user", "悬空父节点")],
      }),
    ).rejects.toThrow(MessageTreeError);

    expect(store.has(originalId)).toBe(true);
    expect(store.has("resident-000002")).toBe(false);
    expect(() => tree.exportTree("resident-000002")).toThrow(MessageTreeError);
    expect(JSON.stringify(store.exportRoom(originalId))).toBe(beforeRoom);
    expect(JSON.stringify(tree.exportTree(originalId))).toBe(beforeTree);
    expect(store.memories(originalId).map((entry) => entry.id)).toEqual([memoryId]);
  });
});
