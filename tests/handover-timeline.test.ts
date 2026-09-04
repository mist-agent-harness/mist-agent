import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CanonicalHandoverTimeline,
  HandoverTimelineError,
} from "../src/one-stream/handover-letters.ts";
import { CanonicalStreamStore } from "../src/one-stream/store.ts";
import { CanonicalStreamWriter, type WriterCheckpoint } from "../src/one-stream/writer.ts";
import { BreathCycle } from "../src/session/breath-cycle.ts";
import { type LetterDraft, type SealedLetter, sealLetter } from "../src/session/handover-letter.ts";
import { SessionRegistry } from "../src/session/session-registry.ts";

const RESIDENT = "resident-d05";
const HOST = { kind: "host" as const, id: "mist-host" };

interface Context {
  readonly notes: string[];
  readonly letter?: SealedLetter;
}

const roots: string[] = [];
const writers: CanonicalStreamWriter[] = [];

afterEach(async () => {
  await Promise.all(writers.splice(0).map((writer) => writer.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function draft(title: string, detail: string): LetterDraft {
  return {
    title,
    state: [{ tier: "fact", body: `状态：${detail}` }],
    intent: [{ tier: "judgment", body: `判断：${detail}` }],
  };
}

function persistence(checkpoint?: (value: WriterCheckpoint) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "mist-d05-"));
  roots.push(root);
  const store = new CanonicalStreamStore({ dataDir: root });
  store.createStream(RESIDENT);
  const writer = new CanonicalStreamWriter(store, checkpoint === undefined ? {} : { checkpoint });
  writers.push(writer);
  const timeline = new CanonicalHandoverTimeline(writer, store, { authoritySource: HOST });
  return { root, store, writer, timeline };
}

function cycleHarness(timeline: CanonicalHandoverTimeline) {
  const registry = new SessionRegistry<Context>();
  let now = "2026-09-04T12:00:00.000Z";
  const cycle = new BreathCycle<Context>({
    registry,
    appendLetter: (letter) => timeline.append(letter),
    injectLetter: (context, letter) => ({ ...context, letter }),
    notify: () => undefined,
    now: () => now,
  });
  return {
    registry,
    cycle,
    setNow(value: string) {
      now = value;
    },
  };
}

describe("MV-D05 canonical handover timeline", () => {
  it("rejects an untitled real breath with zero writes, then recalls equal titles by exact window generation", async () => {
    const { root, store, writer, timeline } = persistence();
    const { registry, cycle, setNow } = cycleHarness(timeline);
    const first = registry.open(RESIDENT, { context: { notes: [] } });

    await expect(cycle.breathe(first.windowId, draft("   ", "不可召回"))).rejects.toThrow(
      /LETTER_SCHEMA_INVALID/,
    );
    expect(store.events(RESIDENT)).toEqual([]);
    expect(registry.get(first.windowId)?.generation).toBe(1);

    const firstBreath = await cycle.breathe(first.windowId, draft("共同标题", "第一扇窗第一代"));
    setNow("2026-09-04T12:01:00.000Z");
    const secondBreath = await cycle.breathe(
      firstBreath.window.windowId,
      draft("共同标题", "第一扇窗第二代"),
    );
    setNow("2026-09-04T12:02:00.000Z");
    const other = registry.open(RESIDENT, { context: { notes: ["另一扇窗"] } });
    await cycle.breathe(other.windowId, draft("共同标题", "第二扇窗第一代"));

    const firstGeneration = timeline.recall({
      residentId: RESIDENT,
      windowId: first.windowId,
      generation: 1,
      title: "共同标题",
    });
    const secondGeneration = timeline.recall({
      residentId: RESIDENT,
      windowId: first.windowId,
      generation: 2,
      title: "共同标题",
    });
    const otherWindow = timeline.recall({
      residentId: RESIDENT,
      windowId: other.windowId,
      generation: 1,
      title: "共同标题",
    });
    expect(firstGeneration.kind === "found" && firstGeneration.letter.state[0]?.body).toBe(
      "状态：第一扇窗第一代",
    );
    expect(secondGeneration.kind === "found" && secondGeneration.letter.state[0]?.body).toBe(
      "状态：第一扇窗第二代",
    );
    expect(otherWindow.kind === "found" && otherWindow.letter.state[0]?.body).toBe(
      "状态：第二扇窗第一代",
    );
    expect(secondBreath.window.generation).toBe(3);
    expect(
      timeline.recall({
        residentId: RESIDENT,
        windowId: first.windowId,
        generation: 1,
        title: "另一个标题",
      }).kind,
    ).toBe("not-found");

    await writer.close();
    const restoredStore = new CanonicalStreamStore({ dataDir: root });
    const restoredWriter = new CanonicalStreamWriter(restoredStore);
    writers.push(restoredWriter);
    const restored = new CanonicalHandoverTimeline(restoredWriter, restoredStore, {
      authoritySource: HOST,
    });
    const afterRestart = restored.recall({
      residentId: RESIDENT,
      windowId: first.windowId,
      generation: 2,
      title: "共同标题",
    });
    expect(afterRestart.kind === "found" && afterRestart.letter.intent[0]?.body).toBe(
      "判断：第一扇窗第二代",
    );
  });

  it("does not swap generations until the durable asynchronous append has returned", async () => {
    let release = (): void => undefined;
    let reached = (): void => undefined;
    const waitForRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reachedDurableCheckpoint = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const { store, timeline } = persistence(async (checkpoint) => {
      if (checkpoint.name !== "durable-write-before-receipt") return;
      reached();
      await waitForRelease;
    });
    const { registry, cycle } = cycleHarness(timeline);
    const window = registry.open(RESIDENT, { context: { notes: [] } });

    const breathing = cycle.breathe(window.windowId, draft("异步落盘", "回执之前不能换代"));
    await reachedDurableCheckpoint;

    expect(store.events(RESIDENT)).toHaveLength(1);
    const generationBeforeReceipt = registry.get(window.windowId)?.generation;
    release();
    await expect(breathing).resolves.toMatchObject({ window: { generation: 2 } });
    expect(generationBeforeReceipt).toBe(1);
  });

  it("reuses a durable letter after the receipt gap, but rejects changed authored content", async () => {
    let failReceipt = true;
    const { store, timeline } = persistence(async (checkpoint) => {
      if (checkpoint.name === "durable-write-before-receipt" && failReceipt) {
        failReceipt = false;
        throw new Error("simulated receipt loss");
      }
    });
    const original = sealLetter(draft("耐久重放", "同一封信"), {
      residentId: RESIDENT,
      windowId: "window-replay",
      generation: 4,
      now: "2026-09-04T12:00:00.000Z",
    });
    const retry = sealLetter(draft("耐久重放", "同一封信"), {
      residentId: RESIDENT,
      windowId: "window-replay",
      generation: 4,
      now: "2026-09-04T12:05:00.000Z",
    });

    const firstReceipt = await timeline.append(original);
    const retryReceipt = await timeline.append(retry);
    expect(retryReceipt).toEqual(firstReceipt);
    expect(store.events(RESIDENT)).toHaveLength(1);

    const changed = sealLetter(draft("耐久重放", "内容已经变了"), {
      residentId: RESIDENT,
      windowId: "window-replay",
      generation: 4,
      now: "2026-09-04T12:06:00.000Z",
    });
    await expect(timeline.append(changed)).rejects.toThrow(HandoverTimelineError);
    expect(store.events(RESIDENT)).toHaveLength(1);
  });

  it("distinguishes an unavailable resident stream from a title that is not present", () => {
    const { timeline } = persistence();
    expect(
      timeline.recall({
        residentId: "resident-without-stream",
        windowId: "missing-window",
        generation: 1,
        title: "不存在的信",
      }),
    ).toMatchObject({ kind: "unavailable", reason: "canonical-stream-not-found" });
  });
});
