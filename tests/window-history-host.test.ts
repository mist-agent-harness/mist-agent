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

// P1-①（审核意见）：窗账按 `(residentId, windowId)` 复合键，跨住户同名窗是两扇不同的
// 窗。壳共享魂私有；串房是本项目性质上最严重的事故。这些负向用例把洞钉死：住户 B 不得
// 读到、开到、写到、换气到、归档到、删到住户 A 的同名窗。每个负向断言都配一个正向对照
// （真主人能读/写/换气），确保不是空断言。
describe("WindowHistoryHost cross-resident isolation (P1-①)", () => {
  const SHARED = "shared-window";
  // residentId 必须匹配 ^[a-z0-9-]+$（底座 store 的流文件名校验）。
  const A = "res-a";
  const B = "res-b";

  async function seedTwoResidentSameWindow(): Promise<void> {
    // A 拥有 shared-window 并写了两条；B 各自持有自己的流（写到自己的另一扇窗）。
    await seedWindow(A, SHARED, 1, 2);
    await seedWindow(B, "b-own", 1, 1);
  }

  it("B's read/summarize of A's window fail-closed with window-not-found (not an OK empty page, not A's events)", async () => {
    await seedTwoResidentSameWindow();

    // 负向：B 读/摘要 A 的同名窗 => window-not-found（不是 OK 空页，也不是 A 的事件）。
    const bRef: WindowHistoryRef = { residentId: B, windowId: SHARED, generation: null };
    const bRead = await host.read(bRef, FULL_PAGE);
    const bSummarize = await host.summarize(bRef);
    expect(bRead.ok).toBe(false);
    if (!bRead.ok) expect(bRead.error.code).toBe("window-not-found");
    expect(bSummarize.ok).toBe(false);
    if (!bSummarize.ok) expect(bSummarize.error.code).toBe("window-not-found");

    // 正向对照：A（真主人）能读到自己的两条。
    const aRef: WindowHistoryRef = { residentId: A, windowId: SHARED, generation: null };
    const aPage = unwrap(await host.read(aRef, FULL_PAGE));
    expect(aPage.entries.map((entry) => entry.payload.mark)).toEqual([
      `${SHARED}-0`,
      `${SHARED}-1`,
    ]);
  });

  it("B's openWindow(sameWindowId) returns B's own independent window, never A's residentId", async () => {
    await seedTwoResidentSameWindow();

    // 负向：B 开同名窗拿到的是 B 自己的独立窗（residentId=B、第 1 代、空），绝不是 A 的。
    const bDescriptor = unwrap(host.openWindow({ residentId: B, windowId: SHARED }));
    expect(bDescriptor.residentId).toBe(B);
    expect(bDescriptor.windowId).toBe(SHARED);
    expect(bDescriptor.generation).toBe(1);

    // B 现在能读自己的 shared-window，且它是空的（没有 A 的事件）。
    const bRef: WindowHistoryRef = { residentId: B, windowId: SHARED, generation: null };
    const bPage = unwrap(await host.read(bRef, FULL_PAGE));
    expect(bPage.entries).toHaveLength(0);

    // 正向对照：A 的 shared-window 完好无损。
    const aRef: WindowHistoryRef = { residentId: A, windowId: SHARED, generation: null };
    const aPage = unwrap(await host.read(aRef, FULL_PAGE));
    expect(aPage.entries.map((entry) => entry.payload.mark)).toEqual([
      `${SHARED}-0`,
      `${SHARED}-1`,
    ]);
  });

  it("B cannot write/rotate/archive/delete A's window; A's window and history stay unchanged", async () => {
    await seedTwoResidentSameWindow();
    const aRef: WindowHistoryRef = { residentId: A, windowId: SHARED, generation: null };

    // B 从未 openWindow(shared-window)：对 B 而言这扇窗不存在，全部写侧操作 fail-closed。
    const bWrite = await host.appendWindowEvent({
      residentId: B,
      windowId: SHARED,
      generation: 1,
      idempotencyKey: "b-intrusion",
      payload: { mark: "b-intrusion" },
    });
    expect(bWrite.ok).toBe(false);
    if (!bWrite.ok) expect(bWrite.error.code).toBe("window-not-found");

    const bRotate = host.rotateGeneration({ residentId: B, windowId: SHARED });
    expect(bRotate.ok).toBe(false);
    if (!bRotate.ok) expect(bRotate.error.code).toBe("window-not-found");

    const bArchive = host.archiveWindow({ residentId: B, windowId: SHARED });
    expect(bArchive.ok).toBe(false);
    if (!bArchive.ok) expect(bArchive.error.code).toBe("window-not-found");

    // B 删「A 的窗」：只应影响 (B, shared-window)（此刻不存在），绝不动 A 的窗。
    host.deleteDurableWindowData({ residentId: B, windowId: SHARED });

    // A 的窗与历史全程不变。
    const aSummary = unwrap(await host.summarize(aRef));
    expect(aSummary.blank).toBe(false);
    const aPage = unwrap(await host.read(aRef, FULL_PAGE));
    expect(aPage.entries.map((entry) => entry.payload.mark)).toEqual([
      `${SHARED}-0`,
      `${SHARED}-1`,
    ]);

    // 正向对照：A（真主人）能写自己的窗、能换气。
    unwrap(
      await host.appendWindowEvent({
        residentId: A,
        windowId: SHARED,
        generation: 1,
        idempotencyKey: "a-legit",
        payload: { mark: "a-legit" },
      }),
    );
    const rotated = unwrap(host.rotateGeneration({ residentId: A, windowId: SHARED }));
    expect(rotated.generation).toBe(2);
  });

  it("composite ownership survives a cold restart: B still cannot read A's window", async () => {
    await seedTwoResidentSameWindow();
    await host.close();

    // 冷启动：新宿主只凭落盘事实重建窗账，复合键归属必须存活。
    const restarted = makeHost(join(root, "data"));
    try {
      const bRead = await restarted.read(
        { residentId: B, windowId: SHARED, generation: null },
        FULL_PAGE,
      );
      expect(bRead.ok).toBe(false);
      if (!bRead.ok) expect(bRead.error.code).toBe("window-not-found");

      // 正向对照：重启后 A 仍能读到自己的两条。
      const aPage = unwrap(
        await restarted.read({ residentId: A, windowId: SHARED, generation: null }, FULL_PAGE),
      );
      expect(aPage.entries.map((entry) => entry.payload.mark)).toEqual([
        `${SHARED}-0`,
        `${SHARED}-1`,
      ]);
    } finally {
      await restarted.close();
    }
  });
});

// P1-②（审核意见）：写的代际必须**严格等于**窗当前代际。旧代 => stale-generation；
// 未来/未开代际 => fail-closed（不入流、不抬重启水位）。推进代际的唯一合法路径是换气。
describe("WindowHistoryHost future-generation writes (P1-②)", () => {
  it("rejects a future-generation write fail-closed, absent from projection, without raising the restart watermark", async () => {
    unwrap(host.openWindow({ residentId: "r", windowId: "w" }));
    // 先写一条合法的当代（gen 1）事件作正向对照的底子。
    unwrap(
      await host.appendWindowEvent({
        residentId: "r",
        windowId: "w",
        generation: 1,
        idempotencyKey: "gen1-a",
        payload: { mark: "gen1-a" },
      }),
    );

    // 负向：窗在第 1 代，写 gen 99 未来代际必须 fail-closed，且不进流。
    const future = await host.appendWindowEvent({
      residentId: "r",
      windowId: "w",
      generation: 99,
      idempotencyKey: "future",
      payload: { mark: "future" },
    });
    expect(future.ok).toBe(false);
    if (!future.ok) expect(future.error.code).toBe("window-not-found");

    const ref: WindowHistoryRef = { residentId: "r", windowId: "w", generation: null };
    const page = unwrap(await host.read(ref, FULL_PAGE));
    expect(page.entries.map((entry) => entry.payload.mark)).not.toContain("future");
    expect(page.entries.map((entry) => entry.payload.mark)).toEqual(["gen1-a"]);
    // provenance 里也不该出现代际 99。
    expect(page.entries.every((entry) => entry.generation === 1)).toBe(true);

    // 冷启动：未来写没抬水位，重启后窗仍在第 1 代，正常 gen-1 写照样成功、不被判旧代。
    // 用独立 eventId 前缀，避免与重启前落盘事件（event-1..）撞号。
    await host.close();
    let restartSeed = 0;
    const restarted = new WindowHistoryHost({
      dataDir: join(root, "data"),
      writerId: "test-writer",
      newEventId: () => {
        restartSeed += 1;
        return `restart-event-${restartSeed}`;
      },
    });
    try {
      const legit = await restarted.appendWindowEvent({
        residentId: "r",
        windowId: "w",
        generation: 1,
        idempotencyKey: "gen1-b",
        payload: { mark: "gen1-b" },
      });
      expect(legit.ok).toBe(true);
      const after = unwrap(await restarted.read(ref, FULL_PAGE));
      expect(after.entries.map((entry) => entry.payload.mark)).toEqual(["gen1-a", "gen1-b"]);
    } finally {
      await restarted.close();
    }
  });

  it("still advances legitimately via rotateGeneration, then accepts the new current generation", async () => {
    // 正向对照：合法推进代际的唯一路径是换气；换气后当代写成功。
    unwrap(host.openWindow({ residentId: "r", windowId: "w" }));
    unwrap(host.rotateGeneration({ residentId: "r", windowId: "w" }));
    const write = await host.appendWindowEvent({
      residentId: "r",
      windowId: "w",
      generation: 2,
      idempotencyKey: "gen2",
      payload: { mark: "gen2" },
    });
    expect(write.ok).toBe(true);

    // 换气到第 2 代后，写第 3 代（又一次未来）仍 fail-closed。
    const future = await host.appendWindowEvent({
      residentId: "r",
      windowId: "w",
      generation: 3,
      idempotencyKey: "gen3",
      payload: { mark: "gen3" },
    });
    expect(future.ok).toBe(false);
    if (!future.ok) expect(future.error.code).toBe("window-not-found");
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
