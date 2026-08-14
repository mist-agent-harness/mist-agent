import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ResidentMigrationError,
  encodeResidentExportM0,
} from "../src/migration/resident-migration.ts";
import { createResidentMigrationService } from "../src/migration/resident-store-migration.ts";
import { ResidentStore } from "../src/store/resident-store.ts";

const temporaryDirectories: string[] = [];

function freshDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "mist-p5-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("ResidentStore 迁移接缝", () => {
  it("搬齐身份来源、承诺、勘误链和整棵树，副本生死不碰原件", async () => {
    const source = new ResidentStore();
    const sourceId = source.createResident("迁移住户");
    source.commit(sourceId, `正文保留来源 id：${sourceId}`);
    const wrong = source.remember(sourceId, "旧记忆");
    const correction = source.errata(sourceId, wrong, `新记忆仍提到 ${sourceId}`);
    const root = source.appendNode(sourceId, null, "user", "第一句");
    source.appendNode(sourceId, root.id, "assistant", `回应 ${sourceId}`);
    const sourceBefore = JSON.stringify(source.exportRoom(sourceId));

    const exported = await createResidentMigrationService(source).exportResident(sourceId);
    expect(JSON.stringify(source.exportRoom(sourceId))).toBe(sourceBefore);

    const target = new ResidentStore();
    const targetService = createResidentMigrationService(target);
    const first = await targetService.importResident(exported);
    const second = await targetService.importResident(exported);
    expect(first).not.toBe(sourceId);
    expect(second).not.toBe(first);

    const imported = target.exportRoom(first);
    expect(imported.name).toBe("迁移住户");
    expect(imported.commitments).toEqual([`正文保留来源 id：${sourceId}`]);
    expect(imported.memories.find((entry) => entry.id === wrong)?.supersededBy).toBe(correction);
    expect(imported.memories.find((entry) => entry.id === correction)?.content).toContain(sourceId);
    expect(imported.memories.every((entry) => entry.residentId === first)).toBe(true);
    expect(imported.nodes).toEqual(source.exportRoom(sourceId).nodes);

    target.remember(first, "导入件新增");
    target.destroyResident(first);
    expect(JSON.stringify(source.exportRoom(sourceId))).toBe(sourceBefore);
    expect(target.has(second)).toBe(true);
  });

  it("fresh target 导入后继续写，不撞 id，时间戳不倒退", async () => {
    const source = new ResidentStore();
    const sourceId = source.createResident("高水位来源");
    for (let index = 0; index < 30; index += 1) {
      source.remember(sourceId, `记忆 ${index}`);
      source.appendNode(sourceId, null, "system", `节点 ${index}`);
    }
    const exported = await createResidentMigrationService(source).exportResident(sourceId);

    const target = new ResidentStore();
    const moved = await createResidentMigrationService(target).importResident(exported);
    const imported = target.exportRoom(moved);
    const importedIds = new Set([
      ...imported.memories.map((entry) => entry.id),
      ...imported.nodes.map((node) => node.id),
    ]);
    const latestTimestamp = [...imported.memories, ...imported.nodes]
      .map((record) => record.createdAt)
      .sort()
      .at(-1);

    const memoryId = target.remember(moved, "落地后新记忆");
    const node = target.appendNode(moved, null, "system", "落地后新节点");
    expect(importedIds.has(memoryId)).toBe(false);
    expect(importedIds.has(node.id)).toBe(false);
    expect(latestTimestamp !== undefined && node.createdAt > latestTimestamp).toBe(true);
  });

  it("超大原生 id 导入后连续写两次，不撞号也不覆盖", async () => {
    const sourceId = "resident-source";
    const importedId = "mem-zzzzzzzzzzzz";
    const pack = encodeResidentExportM0({
      residentId: sourceId,
      resident: { name: "超大水位来源", createdAt: "2026-08-14T06:00:00.000Z" },
      commitments: [],
      memories: [
        {
          id: importedId,
          residentId: sourceId,
          content: "导入原件",
          supersededBy: null,
          createdAt: "2026-08-14T06:00:01.000Z",
        },
      ],
      history: [],
    });

    const target = new ResidentStore();
    const moved = await createResidentMigrationService(target).importResident(pack);
    const first = target.remember(moved, "落地后第一条");
    const second = target.remember(moved, "落地后第二条");

    expect(first).toBe("mem-1000000000000");
    expect(second).toBe("mem-1000000000001");
    expect(new Set([first, second]).size).toBe(2);
    expect(target.memories(moved)).toHaveLength(3);
    expect(target.memories(moved).find((entry) => entry.id === importedId)?.content).toBe(
      "导入原件",
    );
    expect(target.memories(moved).find((entry) => entry.id === first)?.content).toBe(
      "落地后第一条",
    );
    expect(target.memories(moved).find((entry) => entry.id === second)?.content).toBe(
      "落地后第二条",
    );
  });

  it("恶意超长序号显式失败，且不消耗目标 resident id", async () => {
    const sourceId = "resident-source";
    const pack = encodeResidentExportM0({
      residentId: sourceId,
      resident: { name: "恶意包", createdAt: "2026-08-14T06:00:00.000Z" },
      commitments: [],
      memories: [
        {
          id: `mem-${"z".repeat(65)}`,
          residentId: sourceId,
          content: "不应落地",
          supersededBy: null,
          createdAt: "2026-08-14T06:00:01.000Z",
        },
      ],
      history: [],
    });

    const target = new ResidentStore();
    await expect(createResidentMigrationService(target).importResident(pack)).rejects.toThrow(
      /sequence suffix exceeds/,
    );
    expect(target.createResident("首个有效住户")).toBe("resident-000001");
  });

  it("坏包在 store 前失败，不建房也不消耗 resident id", async () => {
    const target = new ResidentStore();
    await expect(
      createResidentMigrationService(target).importResident(new TextEncoder().encode("bad-json")),
    ).rejects.toThrow(ResidentMigrationError);
    expect(target.createResident("第一个真人")).toBe("resident-000001");
  });

  it("落盘提交失败时不留下房间、最终文件或水位副作用", async () => {
    const source = new ResidentStore();
    const sourceId = source.createResident("来源");
    source.remember(sourceId, "一条记忆");
    const pack = await createResidentMigrationService(source).exportResident(sourceId);

    const directory = freshDirectory();
    // resident-000001 与来源 id 同名会被跳过，真正待提交的目标是 000002。
    const collision = join(directory, "resident-000002.json.tmp");
    mkdirSync(collision);
    const target = new ResidentStore({ dataDir: directory });
    await expect(createResidentMigrationService(target).importResident(pack)).rejects.toThrow();
    expect(target.has("resident-000002")).toBe(false);
    expect(readdirSync(directory)).toEqual(["resident-000002.json.tmp"]);

    rmSync(collision, { recursive: true });
    expect(target.createResident("重试成功")).toBe("resident-000001");
  });
});
