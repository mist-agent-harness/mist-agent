import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CanonicalEvent,
  type CanonicalEventDraft,
  CanonicalStreamProjection,
  type CanonicalStreamReadPort,
  CanonicalStreamStore,
  CanonicalStreamWriter,
  IdempotencyConflictError,
  ProjectionIntegrityError,
  WriterOwnershipError,
  normalizeDraft,
} from "../src/one-stream/index.ts";

const directories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "mist-one-stream-core-"));
  directories.push(directory);
  return directory;
}

function draft(label: string): CanonicalEventDraft {
  return {
    purpose: "progress",
    occurredAt: "2026-08-26T00:00:00.000Z",
    workRef: "work-alpha",
    authoritySource: { kind: "host", id: "mist-host" },
    origin: {
      reporter: { kind: "viewport", id: "viewport-a" },
      subject: { kind: "work", id: "work-alpha" },
      viewport: { windowId: "window-a", generation: 1 },
    },
    effect: {
      state: "attempted",
      requiresUserAction: false,
      retry: "automatic",
    },
    artifactRef: null,
    payload: { label, nested: { stable: true } },
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("canonical stream core", () => {
  it("deduplicates an identical retry and rejects changed content without changing bytes", async () => {
    const directory = temporaryDirectory();
    const store = new CanonicalStreamStore({ dataDir: directory });
    store.createStream("resident-a");
    let sequence = 0;
    const writer = new CanonicalStreamWriter(store, {
      newEventId: () => {
        sequence += 1;
        return `event-${sequence}`;
      },
    });

    const first = await writer.submit({
      residentId: "resident-a",
      idempotencyKey: "dispatch-1",
      draft: draft("first"),
    });
    const retried = await writer.submit({
      residentId: "resident-a",
      idempotencyKey: "dispatch-1",
      draft: draft("first"),
    });

    expect(retried).toEqual(first);
    expect(store.events("resident-a")).toHaveLength(1);
    expect(sequence).toBe(1);

    const snapshotPath = join(directory, "resident-a.stream.json");
    const before = readFileSync(snapshotPath, "utf8");
    await expect(
      writer.submit({
        residentId: "resident-a",
        idempotencyKey: "dispatch-1",
        draft: draft("changed"),
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(readFileSync(snapshotPath, "utf8")).toBe(before);
    expect(store.events("resident-a")).toHaveLength(1);

    await writer.close();
  });

  it("keeps residents physically separate and restores contiguous stream state", async () => {
    const directory = temporaryDirectory();
    const firstStore = new CanonicalStreamStore({ dataDir: directory });
    firstStore.createStream("resident-a");
    firstStore.createStream("resident-b");
    let sequence = 0;
    const firstWriter = new CanonicalStreamWriter(firstStore, {
      newEventId: () => {
        sequence += 1;
        return `event-${sequence}`;
      },
    });

    await firstWriter.submit({
      residentId: "resident-a",
      idempotencyKey: "a-1",
      draft: draft("A"),
    });
    await firstWriter.submit({
      residentId: "resident-b",
      idempotencyKey: "b-1",
      draft: draft("B"),
    });
    await firstWriter.close();

    const restored = new CanonicalStreamStore({ dataDir: directory });
    expect(restored.events("resident-a").map((event) => event.payload)).toEqual([
      { label: "A", nested: { stable: true } },
    ]);
    expect(restored.events("resident-b").map((event) => event.payload)).toEqual([
      { label: "B", nested: { stable: true } },
    ]);
    expect(restored.eventsAfter("resident-a", 1)).toEqual([]);
  });

  it("allows only one writer for the same data root inside a host process", async () => {
    const directory = temporaryDirectory();
    const firstStore = new CanonicalStreamStore({ dataDir: directory });
    firstStore.createStream("resident-a");
    const firstWriter = new CanonicalStreamWriter(firstStore);
    const secondStore = new CanonicalStreamStore({ dataDir: directory });

    expect(() => new CanonicalStreamWriter(secondStore)).toThrow(WriterOwnershipError);

    await firstWriter.close();
    const replacement = new CanonicalStreamWriter(secondStore);
    await replacement.close();
  });

  it("rejects a projection that preserves id and sequence but mutates payload", async () => {
    const directory = temporaryDirectory();
    const store = new CanonicalStreamStore({ dataDir: directory });
    store.createStream("resident-a");
    const writer = new CanonicalStreamWriter(store, { newEventId: () => "event-1" });
    await writer.submit({
      residentId: "resident-a",
      idempotencyKey: "dispatch-1",
      draft: draft("original"),
    });
    const original = store.events("resident-a")[0];
    if (original === undefined) throw new Error("fixture event missing");
    const mutated: CanonicalEvent = {
      ...original,
      payload: { label: "mutated", nested: { stable: true } },
    };
    const corruptReadPort: CanonicalStreamReadPort = {
      eventsAfter: () => [mutated],
    };
    const projection = new CanonicalStreamProjection(corruptReadPort, "resident-a");

    await expect(projection.pull()).rejects.toBeInstanceOf(ProjectionIntegrityError);
    expect(projection.cursor).toBe(0);
    expect(projection.snapshot()).toEqual([]);

    await writer.close();
  });

  it("rejects extra authority-envelope fields and a tampered durable snapshot", async () => {
    const withExtraField = { ...draft("original"), transcript: ["must not enter core"] };
    expect(() => normalizeDraft(withExtraField)).toThrow("unexpected fields");

    const directory = temporaryDirectory();
    const store = new CanonicalStreamStore({ dataDir: directory });
    store.createStream("resident-a");
    const writer = new CanonicalStreamWriter(store, { newEventId: () => "event-1" });
    await writer.submit({
      residentId: "resident-a",
      idempotencyKey: "dispatch-1",
      draft: draft("original"),
    });
    await writer.close();

    const snapshotPath = join(directory, "resident-a.stream.json");
    const tampered = readFileSync(snapshotPath, "utf8").replace(
      '"label":"original"',
      '"label":"tampered"',
    );
    writeFileSync(snapshotPath, tampered);
    expect(() => new CanonicalStreamStore({ dataDir: directory })).toThrow("payload hash mismatch");
  });
});
