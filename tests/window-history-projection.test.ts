/**
 * #120 FEAT-001：生产 window-history 只读投影的单元验证。
 *
 * 用真实 CanonicalStreamStore（真实临时 dataDir）+ 真实 CanonicalStreamWriter
 * （写方只允许出现在测试与组装根，不许进 src/window-history/）造被读的事实，
 * 断言投影的窗过滤、代际过滤、升序、分页、空窗、缺窗、损坏可见。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CanonicalEvent,
  type CanonicalEventDraft,
  type CanonicalStreamReadPort,
  CanonicalStreamStore,
  CanonicalStreamWriter,
} from "../src/one-stream/index.ts";
import {
  WindowHistoryProjection,
  type WindowLifecycleView,
  type WindowStorageMigrationStatus,
} from "../src/window-history/index.ts";
import type { Result } from "../src/window-history/port.ts";

const directories: string[] = [];
const writers: CanonicalStreamWriter[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "mist-window-history-projection-"));
  directories.push(directory);
  return directory;
}

function draft(input: {
  windowId: string;
  generation: number;
  mark: string;
}): CanonicalEventDraft {
  return {
    purpose: "progress",
    occurredAt: "2026-09-01T00:00:00.000Z",
    workRef: null,
    authoritySource: { kind: "host", id: "mist-host" },
    origin: {
      reporter: { kind: "viewport", id: "viewport-a" },
      subject: { kind: "work", id: "work-alpha" },
      viewport: { windowId: input.windowId, generation: input.generation },
    },
    effect: { state: "attempted", requiresUserAction: false, retry: "automatic" },
    artifactRef: null,
    payload: { mark: input.mark },
  };
}

/** 全存在、v1、无迁移、不在跑的默认视图，覆盖大多数 happy-path 断言。 */
function healthyLifecycle(overrides: Partial<WindowLifecycleView> = {}): WindowLifecycleView {
  return {
    windowExists: () => true,
    formatVersion: () => 1,
    migrationStatus: (): WindowStorageMigrationStatus => "none",
    isRunning: () => false,
    ...overrides,
  };
}

interface Harness {
  readonly store: CanonicalStreamStore;
  readonly writer: CanonicalStreamWriter;
  readonly residentId: string;
}

function harness(residentId = "resident-a"): Harness {
  const store = new CanonicalStreamStore({ dataDir: temporaryDirectory() });
  store.createStream(residentId);
  let sequence = 0;
  const writer = new CanonicalStreamWriter(store, {
    newEventId: () => {
      sequence += 1;
      return `event-${sequence}`;
    },
  });
  writers.push(writer);
  return { store, writer, residentId };
}

async function seed(
  harnessed: Harness,
  entries: ReadonlyArray<{ windowId: string; generation: number; mark: string }>,
): Promise<void> {
  for (const [index, entry] of entries.entries()) {
    await harnessed.writer.submit({
      residentId: harnessed.residentId,
      idempotencyKey: `seed-${index}`,
      draft: draft(entry),
    });
  }
}

const FULL_PAGE = { beforeSeq: null, maxMessages: null } as const;

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`expected ok result, got error: ${result.error.code}`);
  return result.value;
}

afterEach(async () => {
  await Promise.all(writers.splice(0).map((writer) => writer.close()));
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("WindowHistoryProjection.read", () => {
  it("filters events to the requested windowId", async () => {
    const test = harness();
    await seed(test, [
      { windowId: "window-a", generation: 1, mark: "a-0" },
      { windowId: "window-b", generation: 1, mark: "b-0" },
      { windowId: "window-a", generation: 1, mark: "a-1" },
    ]);
    const projection = new WindowHistoryProjection(test.store, healthyLifecycle());

    const page = unwrap(
      await projection.read(
        { residentId: test.residentId, windowId: "window-a", generation: null },
        FULL_PAGE,
      ),
    );

    expect(page.windowId).toBe("window-a");
    expect(page.entries.map((entry) => entry.payload.mark)).toEqual(["a-0", "a-1"]);
    expect(page.damaged).toEqual([]);
    expect(page.hasMore).toBe(false);
  });

  it("filters by generation when ref.generation is not null", async () => {
    const test = harness();
    await seed(test, [
      { windowId: "window-a", generation: 1, mark: "g1-0" },
      { windowId: "window-a", generation: 2, mark: "g2-0" },
      { windowId: "window-a", generation: 1, mark: "g1-1" },
    ]);
    const projection = new WindowHistoryProjection(test.store, healthyLifecycle());

    const g1 = unwrap(
      await projection.read(
        { residentId: test.residentId, windowId: "window-a", generation: 1 },
        FULL_PAGE,
      ),
    );
    expect(g1.entries.map((entry) => entry.payload.mark)).toEqual(["g1-0", "g1-1"]);
    for (const entry of g1.entries) expect(entry.generation).toBe(1);

    const whole = unwrap(
      await projection.read(
        { residentId: test.residentId, windowId: "window-a", generation: null },
        FULL_PAGE,
      ),
    );
    expect(whole.entries.map((entry) => entry.generation)).toEqual([1, 2, 1]);
  });

  it("returns entries in ascending streamSeq order", async () => {
    const test = harness();
    await seed(test, [
      { windowId: "window-a", generation: 1, mark: "0" },
      { windowId: "window-a", generation: 1, mark: "1" },
      { windowId: "window-a", generation: 1, mark: "2" },
    ]);
    const projection = new WindowHistoryProjection(test.store, healthyLifecycle());

    const page = unwrap(
      await projection.read(
        { residentId: test.residentId, windowId: "window-a", generation: null },
        FULL_PAGE,
      ),
    );
    const seqs = page.entries.map((entry) => entry.streamSeq);
    expect(seqs).toEqual([...seqs].sort((left, right) => left - right));
  });

  it("paginates by beforeSeq filter then tail maxMessages, reporting hasMore only when head dropped", async () => {
    const test = harness();
    await seed(test, [
      { windowId: "window-a", generation: 1, mark: "0" },
      { windowId: "window-a", generation: 1, mark: "1" },
      { windowId: "window-a", generation: 1, mark: "2" },
      { windowId: "window-a", generation: 1, mark: "3" },
      { windowId: "window-a", generation: 1, mark: "4" },
    ]);
    const projection = new WindowHistoryProjection(test.store, healthyLifecycle());
    const ref = { residentId: test.residentId, windowId: "window-a", generation: null };

    // beforeSeq = seq of mark "4" (=5) keeps 0..3; tail 2 => marks 2,3; head dropped => hasMore.
    const paged = unwrap(await projection.read(ref, { beforeSeq: 5, maxMessages: 2 }));
    expect(paged.entries.map((entry) => entry.payload.mark)).toEqual(["2", "3"]);
    expect(paged.hasMore).toBe(true);

    // maxMessages covering the whole filtered set => no head dropped => hasMore false.
    const exact = unwrap(await projection.read(ref, { beforeSeq: null, maxMessages: 5 }));
    expect(exact.entries.map((entry) => entry.payload.mark)).toEqual(["0", "1", "2", "3", "4"]);
    expect(exact.hasMore).toBe(false);

    // beforeSeq alone (no maxMessages) never reports hasMore.
    const beforeOnly = unwrap(await projection.read(ref, { beforeSeq: 3, maxMessages: null }));
    expect(beforeOnly.entries.map((entry) => entry.payload.mark)).toEqual(["0", "1"]);
    expect(beforeOnly.hasMore).toBe(false);
  });

  it("returns an OK empty page for a window that exists but has no events", async () => {
    const test = harness();
    // Window exists per lifecycle view, but no events were written for it.
    const projection = new WindowHistoryProjection(test.store, healthyLifecycle());

    const page = unwrap(
      await projection.read(
        { residentId: test.residentId, windowId: "window-empty", generation: null },
        FULL_PAGE,
      ),
    );
    expect(page.entries).toEqual([]);
    expect(page.damaged).toEqual([]);
    expect(page.hasMore).toBe(false);
  });

  it("fails closed with window-not-found when the window does not exist", async () => {
    const test = harness();
    const projection = new WindowHistoryProjection(
      test.store,
      healthyLifecycle({ windowExists: () => false }),
    );

    const result = await projection.read(
      { residentId: test.residentId, windowId: "window-gone", generation: null },
      FULL_PAGE,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("window-not-found");
    expect(result.error.windowId).toBe("window-gone");
    expect(result.error.message.length).toBeGreaterThan(0);
  });

  it("fails closed with migration-incomplete when storage is mid-migration", async () => {
    const test = harness();
    await seed(test, [{ windowId: "window-a", generation: 1, mark: "0" }]);
    const projection = new WindowHistoryProjection(
      test.store,
      healthyLifecycle({ migrationStatus: () => "incomplete" }),
    );

    const result = await projection.read(
      { residentId: test.residentId, windowId: "window-a", generation: null },
      FULL_PAGE,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("migration-incomplete");
  });

  it("fails closed with storage-unavailable when the read port throws", async () => {
    const test = harness();
    const failingPort: CanonicalStreamReadPort = {
      eventsAfter: () => {
        throw new Error("permission denied");
      },
    };
    const projection = new WindowHistoryProjection(failingPort, healthyLifecycle());

    const result = await projection.read(
      { residentId: test.residentId, windowId: "window-a", generation: null },
      FULL_PAGE,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("storage-unavailable");
    expect(result.error.message).toContain("permission denied");
  });

  it("surfaces a corrupt entry in damaged[] without dropping healthy entries", async () => {
    const test = harness();
    await seed(test, [
      { windowId: "window-a", generation: 1, mark: "0" },
      { windowId: "window-a", generation: 1, mark: "1" },
      { windowId: "window-a", generation: 1, mark: "2" },
    ]);
    // Wrap the store so the middle event's payload is tampered, breaking its hash.
    const healthy = test.store.eventsAfter(test.residentId, 0);
    const tampered = healthy.map(
      (event): CanonicalEvent =>
        event.streamSeq === 2 ? { ...event, payload: { mark: "tampered" } } : event,
    );
    const corruptPort: CanonicalStreamReadPort = {
      eventsAfter: () => tampered.map((event) => structuredClone(event)),
    };
    const projection = new WindowHistoryProjection(corruptPort, healthyLifecycle());

    const page = unwrap(
      await projection.read(
        { residentId: test.residentId, windowId: "window-a", generation: null },
        FULL_PAGE,
      ),
    );
    expect(page.entries.map((entry) => entry.payload.mark)).toEqual(["0", "2"]);
    expect(page.damaged.map((report) => report.streamSeq)).toEqual([2]);
    expect(page.damaged[0]?.reason).toBe("hash-mismatch");
  });
});

describe("WindowHistoryProjection.summarize", () => {
  it("reports blank=true for an existing window with no history", async () => {
    const test = harness();
    const projection = new WindowHistoryProjection(test.store, healthyLifecycle());

    const summary = unwrap(
      await projection.summarize({
        residentId: test.residentId,
        windowId: "window-empty",
        generation: null,
      }),
    );
    expect(summary.blank).toBe(true);
    expect(summary.windowId).toBe("window-empty");
    expect(summary.updatedAt).toBe(0);
    expect(summary.running).toBe(false);
  });

  it("reports blank=false with a deterministic updatedAt for a window with events", async () => {
    const test = harness();
    await seed(test, [
      { windowId: "window-a", generation: 1, mark: "0" },
      { windowId: "window-a", generation: 1, mark: "1" },
    ]);
    const projection = new WindowHistoryProjection(
      test.store,
      healthyLifecycle({ isRunning: () => true }),
    );
    const ref = { residentId: test.residentId, windowId: "window-a", generation: null };

    const summary = unwrap(await projection.summarize(ref));
    expect(summary.blank).toBe(false);
    expect(summary.running).toBe(true);
    // updatedAt derives from the max durable streamSeq (2 here), stable across reads.
    expect(summary.updatedAt).toBe(2);
    const again = unwrap(await projection.summarize(ref));
    expect(again.updatedAt).toBe(summary.updatedAt);
  });

  it("fails closed with window-not-found when the window does not exist", async () => {
    const test = harness();
    const projection = new WindowHistoryProjection(
      test.store,
      healthyLifecycle({ windowExists: () => false }),
    );

    const result = await projection.summarize({
      residentId: test.residentId,
      windowId: "window-gone",
      generation: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("window-not-found");
  });
});
