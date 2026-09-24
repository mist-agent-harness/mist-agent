/**
 * #120 FEAT-002：window-history 生产宿主组装根 + 存储格式管理的单测。
 *
 * 在**同进程**内针对临时目录构造 WindowHistoryHost，直接验存储管理逻辑本身：
 *   - 唯一写方身份跨换气稳定；
 *   - 旧代迟到写 fail-closed 且在投影侧缺席；
 *   - 幂等冲突 fail-closed 且缺席；
 *   - 同窗并发拿到互不相同、连续的发号，且投影按发号序复读；
 *   - v1->v2 迁移后回滚，durableSnapshot 逐字节等价、port 读数不变；
 *   - 迁移前无墓碑、迁移后有墓碑；
 *   - 迁移中断/续跑/回滚的状态机。
 *
 * 跨进程 SIGKILL/重启证据由 FEAT-003 的真实子进程提供；本文件只证明存储管理逻辑。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WindowHistoryPageRequest, WindowHistoryRef } from "../src/window-history/index.ts";
import { WindowHistoryHost } from "../src/window-host/index.ts";

const FULL_PAGE: WindowHistoryPageRequest = { beforeSeq: null, maxMessages: null };

let root: string;
let host: WindowHistoryHost;
let seed = 0;

function makeHost(dataDir: string): WindowHistoryHost {
  seed = 0;
  return new WindowHistoryHost({
    dataDir,
    writerId: "test-writer",
    newEventId: () => {
      seed += 1;
      return `event-${seed}`;
    },
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wh-host-"));
  host = makeHost(join(root, "data"));
});

afterEach(async () => {
  await host.close();
  rmSync(root, { recursive: true, force: true });
});

function unwrap<T>(
  result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } },
): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.error.code}: ${result.error.message}`);
  return result.value;
}

async function seedWindow(
  residentId: string,
  windowId: string,
  generation: number,
  count: number,
): Promise<void> {
  unwrap(host.openWindow({ residentId, windowId }));
  for (let index = 0; index < count; index += 1) {
    unwrap(
      await host.appendWindowEvent({
        residentId,
        windowId,
        generation,
        idempotencyKey: `${windowId}-${index}`,
        payload: { mark: `${windowId}-${index}` },
      }),
    );
  }
}

describe("WindowHistoryHost composition", () => {
  it("keeps exactly one stable writer identity across rotateGeneration (breath)", async () => {
    unwrap(host.openWindow({ residentId: "r", windowId: "w" }));
    const before = unwrap(host.writerIdentity());
    const rotated = unwrap(host.rotateGeneration({ residentId: "r", windowId: "w" }));
    expect(rotated.windowId).toBe("w");
    expect(rotated.generation).toBe(2);
    const after = unwrap(host.writerIdentity());
    expect(after.writerId).toBe(before.writerId);
  });

  it("rejects stale-generation writes fail-closed and keeps them absent from the projection", async () => {
    await seedWindow("r", "w", 1, 1);
    unwrap(host.rotateGeneration({ residentId: "r", windowId: "w" }));
    const stale = await host.appendWindowEvent({
      residentId: "r",
      windowId: "w",
      generation: 1,
      idempotencyKey: "stale",
      payload: { mark: "stale" },
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("stale-generation");

    const ref: WindowHistoryRef = { residentId: "r", windowId: "w", generation: null };
    const page = unwrap(await host.read(ref, FULL_PAGE));
    expect(page.entries.map((entry) => entry.payload.mark)).not.toContain("stale");
    expect(page.entries).toHaveLength(1);
  });

  it("rejects idempotency-conflict writes fail-closed and keeps them absent from the projection", async () => {
    unwrap(host.openWindow({ residentId: "r", windowId: "w" }));
    unwrap(
      await host.appendWindowEvent({
        residentId: "r",
        windowId: "w",
        generation: 1,
        idempotencyKey: "k",
        payload: { mark: "first" },
      }),
    );
    const conflict = await host.appendWindowEvent({
      residentId: "r",
      windowId: "w",
      generation: 1,
      idempotencyKey: "k",
      payload: { mark: "rewritten" },
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error.code).toBe("idempotency-conflict");

    const ref: WindowHistoryRef = { residentId: "r", windowId: "w", generation: null };
    const page = unwrap(await host.read(ref, FULL_PAGE));
    expect(page.entries.map((entry) => entry.payload.mark)).toEqual(["first"]);
    expect(page.entries.map((entry) => entry.payload.mark)).not.toContain("rewritten");
  });

  it("gives concurrent same-window writes distinct contiguous seqs projected in issued order", async () => {
    unwrap(host.openWindow({ residentId: "r", windowId: "w" }));
    const results = await host.appendWindowEventsConcurrently([
      {
        residentId: "r",
        windowId: "w",
        generation: 1,
        idempotencyKey: "a",
        payload: { mark: "a" },
      },
      {
        residentId: "r",
        windowId: "w",
        generation: 1,
        idempotencyKey: "b",
        payload: { mark: "b" },
      },
      {
        residentId: "r",
        windowId: "w",
        generation: 1,
        idempotencyKey: "c",
        payload: { mark: "c" },
      },
    ]);
    const receipts = results.map((result) => unwrap(result));
    const seqs = receipts.map((receipt) => receipt.streamSeq);
    expect(new Set(seqs).size).toBe(seqs.length);
    // contiguous ascending
    const sorted = [...seqs].sort((left, right) => left - right);
    for (let index = 1; index < sorted.length; index += 1) {
      expect(sorted[index]).toBe((sorted[index - 1] ?? 0) + 1);
    }
    const issuedOrder = [...receipts]
      .sort((left, right) => left.streamSeq - right.streamSeq)
      .map((receipt) => receipt.eventId);
    const ref: WindowHistoryRef = { residentId: "r", windowId: "w", generation: null };
    const page = unwrap(await host.read(ref, FULL_PAGE));
    expect(page.entries.map((entry) => entry.eventId)).toEqual(issuedOrder);
  });

  it("does not leak events across windows", async () => {
    await seedWindow("r", "wa", 1, 2);
    await seedWindow("r", "wb", 1, 1);
    const pageA = unwrap(
      await host.read({ residentId: "r", windowId: "wa", generation: null }, FULL_PAGE),
    );
    const pageB = unwrap(
      await host.read({ residentId: "r", windowId: "wb", generation: null }, FULL_PAGE),
    );
    expect(pageA.entries.map((entry) => entry.payload.mark)).toEqual(["wa-0", "wa-1"]);
    expect(pageB.entries.map((entry) => entry.payload.mark)).toEqual(["wb-0"]);
  });

  it("migrate v1->v2 then rollback yields byte-equal durableSnapshot and unchanged port read", async () => {
    await seedWindow("r", "w", 1, 3);
    const ref: WindowHistoryRef = { residentId: "r", windowId: "w", generation: null };

    expect(host.migrationState().formatVersion).toBe(1);
    const v1Page = unwrap(await host.read(ref, FULL_PAGE));
    expect(v1Page.entries.every((entry) => entry.formatVersion === 1)).toBe(true);
    const v1Snapshot = snapshotShape(host.durableSnapshot());
    expect(host.durableSnapshot().records.length).toBeGreaterThan(0);

    const migrated = unwrap(host.migrateStorageFormat({ targetFormatVersion: 2 }));
    expect(migrated.formatVersion).toBe(2);
    expect(host.migrationState().status).toBe("complete");
    const v2Page = unwrap(await host.read(ref, FULL_PAGE));
    expect(v2Page.entries.every((entry) => entry.formatVersion === 2)).toBe(true);
    // same entries (format-agnostic fingerprint: eventId + payload.mark)
    expect(v2Page.entries.map((entry) => [entry.eventId, entry.payload.mark])).toEqual(
      v1Page.entries.map((entry) => [entry.eventId, entry.payload.mark]),
    );

    unwrap(host.rollbackStorageFormat({ targetFormatVersion: 1 }));
    expect(host.migrationState().formatVersion).toBe(1);
    expect(snapshotShape(host.durableSnapshot())).toBe(v1Snapshot);
    const rolledBackPage = unwrap(await host.read(ref, FULL_PAGE));
    expect(rolledBackPage.entries.every((entry) => entry.formatVersion === 1)).toBe(true);
    expect(rolledBackPage.entries.map((entry) => entry.eventId)).toEqual(
      v1Page.entries.map((entry) => entry.eventId),
    );
  });

  it("has no tombstones before migrate and non-empty complete tombstones after", async () => {
    await seedWindow("r", "w", 1, 2);
    expect(unwrap(host.readTombstones())).toHaveLength(0);
    unwrap(host.migrateStorageFormat({ targetFormatVersion: 2 }));
    const tombstones = unwrap(host.readTombstones());
    expect(tombstones.length).toBeGreaterThan(0);
    for (const tombstone of tombstones) {
      expect(tombstone.tombstoneId.length).toBeGreaterThan(0);
      expect(tombstone.retiredField.length).toBeGreaterThan(0);
      expect(tombstone.reason.length).toBeGreaterThan(0);
      expect(tombstone.replacedByFormatVersion).toBe(2);
    }
  });

  it("reports a recognizable incomplete state after interrupt and resumes to a clean single-version page", async () => {
    await seedWindow("r", "w", 1, 3);
    const ref: WindowHistoryRef = { residentId: "r", windowId: "w", generation: null };
    host.interruptMigration({ targetFormatVersion: 2 });

    // Simulate cross-process restart: release the writer scope, then a fresh host
    // reads durable state from disk. (afterEach also closes `host`, which is idempotent.)
    await host.close();
    const restarted = makeHost(join(root, "data"));
    try {
      const state = restarted.migrationState();
      expect(state.status).toBe("incomplete");
      expect(state.resumable || state.rollbackAvailable).toBe(true);

      // While incomplete, read fail-closes to migration-incomplete (window is tracked again after re-open).
      unwrap(restarted.openWindow({ residentId: "r", windowId: "w" }));
      const during = await restarted.read(ref, FULL_PAGE);
      expect(during.ok).toBe(false);
      if (!during.ok) expect(during.error.code).toBe("migration-incomplete");

      const resumed = unwrap(restarted.resumeMigration());
      expect(resumed.formatVersion).toBe(2);
      expect(restarted.migrationState().status).toBe("complete");
      const after = unwrap(await restarted.read(ref, FULL_PAGE));
      const versions = new Set(after.entries.map((entry) => entry.formatVersion));
      expect(versions.size).toBe(1);
      expect(after.entries).toHaveLength(3);
    } finally {
      await restarted.close();
    }
  });

  it("fails read/summarize closed with window-not-found for an unknown window", async () => {
    const ref: WindowHistoryRef = { residentId: "r", windowId: "ghost", generation: null };
    const read = await host.read(ref, FULL_PAGE);
    const summarize = await host.summarize(ref);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error.code).toBe("window-not-found");
    expect(summarize.ok).toBe(false);
    if (!summarize.ok) expect(summarize.error.code).toBe("window-not-found");
  });

  it("returns an OK empty page for an existing window with no events", async () => {
    unwrap(host.openWindow({ residentId: "r", windowId: "w" }));
    const ref: WindowHistoryRef = { residentId: "r", windowId: "w", generation: null };
    const page = unwrap(await host.read(ref, FULL_PAGE));
    expect(page.entries).toHaveLength(0);
    const summary = unwrap(await host.summarize(ref));
    expect(summary.blank).toBe(true);
  });
});

function snapshotShape(snapshot: {
  records: readonly { relativePath: string; byteHash: string; byteLength: number }[];
}): string {
  return JSON.stringify(
    [...snapshot.records]
      .map((record) => ({
        relativePath: record.relativePath,
        byteHash: record.byteHash,
        byteLength: record.byteLength,
      }))
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
  );
}
