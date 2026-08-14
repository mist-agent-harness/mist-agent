import { describe, expect, it, vi } from "vitest";
import type {
  DurableResidentSnapshotM0,
  ResidentMigrationPort,
} from "../src/migration/resident-migration.ts";
import {
  MAX_RESIDENT_EXPORT_BYTES,
  ResidentMigrationError,
  ResidentMigrationService,
  decodeResidentExportM0,
  encodeResidentExportM0,
  rebindResidentId,
} from "../src/migration/resident-migration.ts";

const sourceResidentId = "resident-source";

function fixture(): DurableResidentSnapshotM0 {
  return {
    residentId: sourceResidentId,
    resident: { name: "小粽子", createdAt: "2026-08-14T06:00:00.000Z" },
    commitments: ["答应：正文里的 resident-source 不能被替换"],
    memories: [
      {
        id: "mem-2",
        residentId: sourceResidentId,
        content: "修正后：中文\nemoji 🥟；resident-source 仍是正文",
        supersededBy: null,
        createdAt: "2026-08-14T06:00:02.000Z",
      },
      {
        id: "mem-1",
        residentId: sourceResidentId,
        content: "原始记录",
        supersededBy: "mem-2",
        createdAt: "2026-08-14T06:00:01.000Z",
      },
    ],
    history: [
      {
        id: "node-2",
        parentId: "node-1",
        role: "assistant",
        content: "收到：resident-source",
        createdAt: "2026-08-14T06:00:04.000Z",
      },
      {
        id: "node-1",
        parentId: null,
        role: "user",
        content: "第一句",
        createdAt: "2026-08-14T06:00:03.000Z",
      },
    ],
  };
}

function jsonPack(mutator: (value: Record<string, unknown>) => void): Uint8Array {
  const value = JSON.parse(new TextDecoder().decode(encodeResidentExportM0(fixture()))) as Record<
    string,
    unknown
  >;
  mutator(value);
  return new TextEncoder().encode(JSON.stringify(value));
}

function itemAt<T>(items: T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`fixture item ${index} is missing`);
  return item;
}

describe("M0 编解码", () => {
  it("同一状态重复导出逐字节相同，且不修改来源数组顺序", () => {
    const snapshot = fixture();
    const memoryOrder = snapshot.memories.map((entry) => entry.id);
    const historyOrder = snapshot.history.map((node) => node.id);

    const first = encodeResidentExportM0(snapshot);
    const second = encodeResidentExportM0(snapshot);

    expect(first).toEqual(second);
    expect(snapshot.memories.map((entry) => entry.id)).toEqual(memoryOrder);
    expect(snapshot.history.map((node) => node.id)).toEqual(historyOrder);
    const decoded = decodeResidentExportM0(first);
    expect(decoded.memories.map((entry) => entry.id)).toEqual(["mem-1", "mem-2"]);
    expect(decoded.history.map((node) => node.id)).toEqual(["node-1", "node-2"]);
  });

  it("非 ASCII id 使用与 locale 无关的固定 code-unit 顺序", () => {
    const snapshot = fixture();
    snapshot.memories = [
      {
        id: "ä",
        residentId: sourceResidentId,
        content: "非 ASCII",
        supersededBy: null,
        createdAt: "2026-08-14T06:00:01.000Z",
      },
      {
        id: "z",
        residentId: sourceResidentId,
        content: "ASCII",
        supersededBy: null,
        createdAt: "2026-08-14T06:00:01.000Z",
      },
    ];

    const first = encodeResidentExportM0(snapshot);
    const second = encodeResidentExportM0(snapshot);
    expect(first).toEqual(second);
    expect(decodeResidentExportM0(first).memories.map((entry) => entry.id)).toEqual(["z", "ä"]);
  });

  it("只重绑结构化 residentId，不改正文、承诺、id、时间和引用", () => {
    const decoded = decodeResidentExportM0(encodeResidentExportM0(fixture()));
    const rebound = rebindResidentId(decoded, "resident-target");

    expect(rebound.residentId).toBe("resident-target");
    expect(rebound.memories.every((entry) => entry.residentId === "resident-target")).toBe(true);
    expect(rebound.memories[1]?.content).toContain(sourceResidentId);
    expect(rebound.commitments[0]).toContain(sourceResidentId);
    expect(rebound.history[1]?.content).toContain(sourceResidentId);
    expect(
      rebound.memories.map(({ id, createdAt, supersededBy }) => ({
        id,
        createdAt,
        supersededBy,
      })),
    ).toEqual([
      { id: "mem-1", createdAt: "2026-08-14T06:00:01.000Z", supersededBy: "mem-2" },
      { id: "mem-2", createdAt: "2026-08-14T06:00:02.000Z", supersededBy: null },
    ]);
  });

  it("拒绝非 UTF-8、未知版本和超限包", () => {
    expect(() => decodeResidentExportM0(Uint8Array.from([0xc3, 0x28]))).toThrow(
      ResidentMigrationError,
    );
    expect(() =>
      decodeResidentExportM0(
        jsonPack((value) => {
          value.formatVersion = 1;
        }),
      ),
    ).toThrow(/unsupported resident export version/);
    expect(() => decodeResidentExportM0(new Uint8Array(MAX_RESIDENT_EXPORT_BYTES + 1))).toThrow(
      /exceeds/,
    );
  });

  it("拒绝跨房记录、重复 id、悬空引用和环", () => {
    const cases: Uint8Array[] = [
      jsonPack((value) => {
        const raw = value.raw as { memories: Array<Record<string, unknown>> };
        itemAt(raw.memories, 0).residentId = "resident-other";
      }),
      jsonPack((value) => {
        const raw = value.raw as { memories: Array<Record<string, unknown>> };
        itemAt(raw.memories, 1).id = itemAt(raw.memories, 0).id;
      }),
      jsonPack((value) => {
        const raw = value.raw as { history: Array<Record<string, unknown>> };
        itemAt(raw.history, 1).parentId = "node-missing";
      }),
      jsonPack((value) => {
        const raw = value.raw as { history: Array<Record<string, unknown>> };
        itemAt(raw.history, 0).parentId = "node-2";
      }),
    ];

    for (const pack of cases)
      expect(() => decodeResidentExportM0(pack)).toThrow(ResidentMigrationError);
  });
});

describe("迁移服务接缝", () => {
  it("坏包在调用原子提交口之前失败，零写入", async () => {
    const port: ResidentMigrationPort = {
      snapshotResident: vi.fn(async () => fixture()),
      commitImportedResident: vi.fn(async () => "resident-target"),
    };
    const service = new ResidentMigrationService(port);

    await expect(service.importResident(new TextEncoder().encode("not-json"))).rejects.toThrow(
      ResidentMigrationError,
    );
    expect(port.commitImportedResident).not.toHaveBeenCalled();
  });

  it("同一个包可重复导入，每次都交给原子提交口生成新住户", async () => {
    let sequence = 0;
    const port: ResidentMigrationPort = {
      snapshotResident: vi.fn(async () => fixture()),
      commitImportedResident: vi.fn(async () => {
        sequence += 1;
        return `resident-target-${sequence}`;
      }),
    };
    const service = new ResidentMigrationService(port);
    const pack = await service.exportResident(sourceResidentId);

    await expect(service.importResident(pack)).resolves.toBe("resident-target-1");
    await expect(service.importResident(pack)).resolves.toBe("resident-target-2");
    expect(port.commitImportedResident).toHaveBeenCalledTimes(2);
  });
});
