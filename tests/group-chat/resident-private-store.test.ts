import { stat } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CrossResidentPrivateReadError,
  ResidentPrivateStore,
} from "../../src/group-chat/resident-private-store.ts";

const roots: string[] = [];
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  readonly DatabaseSync: new (
    location: string,
  ) => {
    prepare(sql: string): { all(): unknown[] };
    close(): void;
  };
};

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mist-resident-private-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ResidentPrivateStore", () => {
  it("closes the SQLite connection without relying on DatabaseSync.isOpen", async () => {
    const store = new ResidentPrivateStore(await makeRoot());

    store.close();
    expect(() => store.readMemories("resident-a")).toThrow();
    expect(() => store.close()).not.toThrow();
  });

  it.each(["context", "memory"] as const)(
    "allows the owning resident and rejects a different reader for %s",
    async (surface) => {
      const store = new ResidentPrivateStore(await makeRoot());
      store.seedContext("resident-a", "private-a");
      store.seedContext("resident-b", "private-b");
      store.saveMemory({
        residentId: "resident-a",
        sourceEventId: "event-a",
        body: "memory-a",
      });
      const ownRead =
        surface === "context"
          ? () => store.readContext("resident-a")
          : () => store.readMemories("resident-a");
      const crossRead =
        surface === "context"
          ? () => store.readContext("resident-a", "resident-b")
          : () => store.readMemories("resident-a", "resident-b");

      expect(ownRead()).toBeTruthy();
      expect(crossRead).toThrow(CrossResidentPrivateReadError);
      store.close();
    },
  );

  it("keeps context and explicitly saved memories resident-partitioned across reopen", async () => {
    const root = await makeRoot();
    const store = new ResidentPrivateStore(root);
    store.seedContext("resident-a", "private-a");
    store.seedContext("resident-a", "private-a");
    store.seedContext("resident-b", "private-b");
    expect(store.readContext("resident-a")).toBe("private-a");
    expect(store.readContext("resident-b")).toBe("private-b");
    expect(() => store.readContext("resident-a", "resident-b")).toThrow(
      CrossResidentPrivateReadError,
    );

    const saved = store.saveMemory({
      residentId: "resident-a",
      sourceEventId: "exact-room-event-42",
      body: "public source body",
    });
    expect(saved.sourceEventId).toBe("exact-room-event-42");
    expect(
      store.saveMemory({
        residentId: "resident-a",
        sourceEventId: "exact-room-event-42",
        body: "public source body",
      }),
    ).toEqual(saved);
    expect(store.readMemories("resident-a")).toEqual([saved]);
    expect(store.readMemories("resident-b")).toEqual([]);
    expect(() => store.readMemories("resident-a", "resident-b")).toThrow(
      CrossResidentPrivateReadError,
    );
    expect(store.readAllMemoriesForHostAudit()).toEqual([saved]);
    store.close();

    const reopened = new ResidentPrivateStore(root);
    expect(reopened.readContext("resident-a")).toBe("private-a");
    expect(reopened.readMemories("resident-a")).toEqual([saved]);
    const file = await stat(join(root, "resident-private.sqlite"));
    expect(file.mode & 0o777).toBe(0o600);
    reopened.close();
  });

  it("stores no public-room event rows in the private database", async () => {
    const root = await makeRoot();
    const store = new ResidentPrivateStore(root);
    store.seedContext("resident-a", "private-canary");
    store.close();
    const db = new DatabaseSync(join(root, "resident-private.sqlite"));
    // The private file owns only private context and explicit memory rows, never the room stream.
    const tableNames = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all();
    expect(tableNames).not.toContain("room_events");
    db.close();
  });
});
