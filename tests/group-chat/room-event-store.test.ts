import { spawn } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  DeliveryOperationConflictError,
  ROOM_RECORDED_CLAIM,
  RoomEventStore,
  RoomOperationConflictError,
} from "../../src/group-chat/room-event-store.ts";

const roots: string[] = [];
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  readonly DatabaseSync: new (
    location: string,
  ) => {
    exec(sql: string): void;
    prepare(sql: string): {
      run(...parameters: (string | number)[]): unknown;
      get(...parameters: (string | number)[]): unknown;
      all(...parameters: (string | number)[]): unknown[];
    };
    close(): void;
  };
};

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mist-room-events-"));
  roots.push(root);
  return root;
}

function appendInput(overrides: Partial<Parameters<RoomEventStore["append"]>[0]> = {}) {
  return {
    operationId: "operation-1",
    roomId: "room-a",
    principalId: "resident-a",
    authorId: "resident-a",
    body: "hello",
    visibility: "public" as const,
    requestSemantics: JSON.stringify({ body: "hello", roomId: "room-a" }),
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("RoomEventStore", () => {
  it("closes the SQLite connection without relying on DatabaseSync.isOpen", async () => {
    const store = new RoomEventStore(await makeRoot());

    store.close();
    expect(() => store.readRoomEvents()).toThrow();
    expect(() => store.roster.readRoster()).toThrow(/room event store is closed/);
    expect(() => store.close()).not.toThrow();
  });

  it("keeps the event, per-room position and recorded receipt durable together", async () => {
    const root = await makeRoot();
    const first = new RoomEventStore(root);
    const appended = first.append({ ...appendInput(), recordedClaim: ROOM_RECORDED_CLAIM });
    first.close();

    const reopened = new RoomEventStore(root);
    expect(reopened.readRoomEvents()).toEqual([appended.event]);
    expect(reopened.readSystemReceipts()).toEqual([
      {
        actor: "system",
        phase: "recorded",
        roomEventId: appended.event.id,
        claim: "房间已记录",
      },
    ]);
    expect(appended.receipt?.roomEventId).toBe(appended.event.id);
    expect(appended.event.position).toBe(1);
    reopened.close();
  });

  it("returns the original event for an identical operation retry and rejects changed semantics", async () => {
    const store = new RoomEventStore(await makeRoot());
    const original = store.append({ ...appendInput(), recordedClaim: ROOM_RECORDED_CLAIM });
    const replay = store.append({ ...appendInput(), recordedClaim: ROOM_RECORDED_CLAIM });

    expect(replay).toEqual({ ...original, replayed: true });
    expect(() =>
      store.append({
        ...appendInput({ body: "changed", requestSemantics: JSON.stringify({ body: "changed" }) }),
        recordedClaim: ROOM_RECORDED_CLAIM,
      }),
    ).toThrow(RoomOperationConflictError);
    expect(store.readRoomEvents()).toHaveLength(1);
    expect(store.readSystemReceipts()).toHaveLength(1);
    store.close();
  });

  it("rejects replay when the original operation had no receipt claim", async () => {
    const store = new RoomEventStore(await makeRoot());
    const original = store.append(appendInput());

    expect(original.receipt).toBeNull();
    expect(() => store.append({ ...appendInput(), recordedClaim: ROOM_RECORDED_CLAIM })).toThrow(
      /already used/,
    );
    expect(store.readRoomEvents()).toHaveLength(1);
    expect(store.readSystemReceipts()).toHaveLength(0);
    store.close();
  });

  it("rejects replay when an existing receipt claim is omitted or changed", async () => {
    const store = new RoomEventStore(await makeRoot());
    const input = appendInput();
    const original = store.append({ ...input, recordedClaim: ROOM_RECORDED_CLAIM });

    expect(original.receipt?.claim).toBe(ROOM_RECORDED_CLAIM);
    expect(() => store.append(input)).toThrow(/already used/);
    expect(() => store.append({ ...input, recordedClaim: "a different claim" })).toThrow(
      /already used/,
    );
    expect(store.readRoomEvents()).toHaveLength(1);
    expect(store.readSystemReceipts()).toEqual([original.receipt]);
    store.close();
  });

  it("migrates the existing v1 ledger without losing records or inventing mentions", async () => {
    const root = await makeRoot();
    const legacy = new DatabaseSync(join(root, "room-events.sqlite"));
    legacy.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE room_events (
        id TEXT PRIMARY KEY NOT NULL,
        operation_id TEXT UNIQUE NOT NULL,
        room_id TEXT NOT NULL,
        position INTEGER NOT NULL CHECK (position > 0),
        principal_id TEXT NOT NULL,
        author_id TEXT NOT NULL,
        body TEXT NOT NULL,
        visibility TEXT NOT NULL CHECK (visibility IN ('public', 'hidden')),
        request_semantics TEXT NOT NULL,
        UNIQUE (room_id, position)
      ) STRICT;
      CREATE TABLE room_heads (
        room_id TEXT PRIMARY KEY NOT NULL,
        last_position INTEGER NOT NULL CHECK (last_position > 0)
      ) STRICT;
      CREATE TABLE room_system_receipts (
        event_id TEXT PRIMARY KEY NOT NULL REFERENCES room_events(id),
        actor TEXT NOT NULL CHECK (actor = 'system'),
        phase TEXT NOT NULL CHECK (phase = 'recorded'),
        claim TEXT NOT NULL
      ) STRICT;
    `);
    legacy
      .prepare(
        `INSERT INTO room_events
          (id, operation_id, room_id, position, principal_id, author_id, body, visibility, request_semantics)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "legacy-event",
        "legacy-operation",
        "room-a",
        1,
        "resident-a",
        "resident-a",
        "legacy",
        "public",
        "legacy",
      );
    legacy
      .prepare("INSERT INTO room_heads (room_id, last_position) VALUES (?, ?)")
      .run("room-a", 1);
    legacy
      .prepare(
        "INSERT INTO room_system_receipts (event_id, actor, phase, claim) VALUES (?, ?, ?, ?)",
      )
      .run("legacy-event", "system", "recorded", "房间已记录");
    legacy.exec("PRAGMA user_version = 1");
    legacy.close();

    const migrated = new RoomEventStore(root);
    expect(migrated.readRoomEvents()).toEqual([
      {
        id: "legacy-event",
        roomId: "room-a",
        position: 1,
        principalId: "resident-a",
        authorId: "resident-a",
        body: "legacy",
        visibility: "public",
        mentions: [],
      },
    ]);
    expect(migrated.readSystemReceipts()).toEqual([
      {
        actor: "system",
        phase: "recorded",
        roomEventId: "legacy-event",
        claim: "房间已记录",
      },
    ]);
    const next = migrated.append(
      appendInput({
        operationId: "after-migration",
        mentions: ["resident-b"],
        requestSemantics: "mentions-after-migration",
      }),
    );
    expect(next.event.mentions).toEqual(["resident-b"]);
    migrated.close();
  });

  it("migrates schema v2 to v3 without changing recorded receipts", async () => {
    const root = await makeRoot();
    const initial = new RoomEventStore(root);
    const appended = initial.append({ ...appendInput(), recordedClaim: ROOM_RECORDED_CLAIM });
    initial.close();
    downgradeToV2(root);

    const migrated = new RoomEventStore(root);
    expect(migrated.readRoomEvents()).toEqual([appended.event]);
    expect(migrated.readSystemReceipts()).toEqual([
      {
        actor: "system",
        phase: "recorded",
        roomEventId: appended.event.id,
        claim: ROOM_RECORDED_CLAIM,
      },
    ]);
    const db = new DatabaseSync(join(root, "room-events.sqlite"));
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 3 });
    const receiptColumns = db.prepare("PRAGMA table_info(room_system_receipts)").all();
    expect(receiptColumns).toHaveLength(4);
    db.close();
    migrated.close();
  });

  it("rolls back every v3 DDL change and the version when migration fails", async () => {
    const root = await makeRoot();
    const initial = new RoomEventStore(root);
    initial.close();
    downgradeToV2(root, true);

    expect(() => new RoomEventStore(root)).toThrow(/room_stage_receipts/);
    const db = new DatabaseSync(join(root, "room-events.sqlite"));
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'room_roster_state'",
        )
        .get(),
    ).toBeUndefined();
    db.close();
  });

  it("keeps delivery transitions append-only and the current state idempotent", async () => {
    const root = await makeRoot();
    const store = new RoomEventStore(root);
    const event = store.append(appendInput()).event;
    const first = {
      eventId: event.id,
      residentId: "resident-a",
      operationId: "delivery-a-loaded",
      state: "loaded" as const,
    };
    expect(store.setDeliveryState(first)).toEqual({
      residentId: "resident-a",
      state: "loaded",
      sequence: 1,
    });
    expect(store.setDeliveryState(first)).toEqual({
      residentId: "resident-a",
      state: "loaded",
      sequence: 1,
    });
    expect(
      store.setDeliveryState({ ...first, operationId: "delivery-a-queued", state: "queued" }),
    ).toEqual({ residentId: "resident-a", state: "queued", sequence: 2 });
    expect(store.readDeliveries(event.id)).toEqual([
      { residentId: "resident-a", state: "queued", sequence: 2 },
    ]);
    expect(() => store.setDeliveryState({ ...first, state: "queued" })).toThrow(
      DeliveryOperationConflictError,
    );
    const db = new DatabaseSync(join(root, "room-events.sqlite"));
    expect(() => db.exec("UPDATE room_delivery_transitions SET state = 'queued'")).toThrow(
      /append-only/,
    );
    expect(() => db.exec("DELETE FROM room_delivery_transitions")).toThrow(/append-only/);
    db.close();
    store.close();
  });

  it.each([
    { initial: "loaded", next: "queued" },
    { initial: "queued", next: "not-targeted" },
    { initial: "not-targeted", next: "loaded" },
  ] as const)(
    "accepts $initial to $next as a new operation, but rejects changed replay",
    async ({ initial, next }) => {
      const store = new RoomEventStore(await makeRoot());
      const event = store.append(appendInput()).event;
      const original = {
        eventId: event.id,
        residentId: "resident-a",
        operationId: "transition-operation",
        state: initial,
      };
      const first = store.setDeliveryState(original);

      expect(store.setDeliveryState(original)).toEqual(first);
      expect(() => store.setDeliveryState({ ...original, state: next })).toThrow(
        DeliveryOperationConflictError,
      );
      expect(
        store.setDeliveryState({
          ...original,
          operationId: "next-transition-operation",
          state: next,
        }),
      ).toEqual({ residentId: "resident-a", state: next, sequence: 2 });
      store.close();
    },
  );

  it("records dispatched then context-committed stages without implying a memory write", async () => {
    const root = await makeRoot();
    const store = new RoomEventStore(root);
    const event = store.append({ ...appendInput(), recordedClaim: ROOM_RECORDED_CLAIM }).event;
    expect(() =>
      store.commitContext({ roomEventId: event.id, residentId: "resident-a", marker: "early" }),
    ).toThrow(/before its room event is dispatched/);
    store.dispatchEvent(event.id, ["resident-a", "resident-b"], store.roster.readRoster().version);
    store.dispatchEvent(event.id, ["resident-a", "resident-b"], store.roster.readRoster().version);
    expect(store.readDeliveries(event.id)).toEqual([
      { residentId: "resident-a", state: "queued", sequence: 1 },
      { residentId: "resident-b", state: "queued", sequence: 1 },
    ]);
    expect(() =>
      store.commitContext({
        roomEventId: event.id,
        residentId: "resident-c",
        marker: "no-delivery",
      }),
    ).toThrow(/without a dispatch delivery/);
    const commit = store.commitContext({
      roomEventId: event.id,
      residentId: "resident-a",
      marker: "context",
    });
    expect(
      store.commitContext({ roomEventId: event.id, residentId: "resident-a", marker: "context" }),
    ).toEqual(commit);
    expect(commit.roomEventId).toBe(event.id);
    expect(store.readContextCommits()).toEqual([commit]);
    expect(store.readSystemReceipts()).toEqual([
      { actor: "system", phase: "recorded", roomEventId: event.id, claim: ROOM_RECORDED_CLAIM },
      { actor: "system", phase: "dispatched", roomEventId: event.id, rosterVersion: 0 },
      {
        actor: "system",
        phase: "context-committed",
        roomEventId: event.id,
        rosterVersion: 0,
        contextCommitRef: commit.id,
      },
    ]);
    const db = new DatabaseSync(join(root, "room-events.sqlite"));
    expect(() => db.exec("UPDATE room_stage_receipts SET claim = 'rewritten'")).toThrow(
      /append-only/,
    );
    expect(() => db.exec("DELETE FROM room_stage_receipts")).toThrow(/append-only/);
    db.close();
    store.close();
  });

  it("rolls back a context commit when its stage receipt cannot be appended", async () => {
    const root = await makeRoot();
    const store = new RoomEventStore(root);
    const event = store.append(appendInput()).event;
    store.dispatchEvent(event.id, ["resident-a"], store.roster.readRoster().version);
    const db = new DatabaseSync(join(root, "room-events.sqlite"));
    db.exec(`CREATE TRIGGER reject_context_receipt BEFORE INSERT ON room_stage_receipts
      WHEN NEW.phase = 'context-committed' BEGIN SELECT RAISE(ABORT, 'receipt rejected'); END`);
    db.close();

    expect(() =>
      store.commitContext({ roomEventId: event.id, residentId: "resident-a", marker: "fail" }),
    ).toThrow(/receipt rejected/);
    expect(store.readContextCommits()).toEqual([]);
    expect(store.readSystemReceipts()).toEqual([
      { actor: "system", phase: "dispatched", roomEventId: event.id, rosterVersion: 0 },
    ]);
    store.close();
  });

  it("routes registration and membership changes through one versioned roster with join watermarks", async () => {
    const root = await makeRoot();
    const store = new RoomEventStore(root);
    store.append(appendInput());
    const before = store.roster.readRoster();
    const registered = store.roster.registerResident({
      operationId: "register-resident-a",
      roomId: "room-a",
      residentId: "resident-a",
    });
    expect(registered.version).toBe(before.version + 1);
    expect(registered.residentIds).toContain("resident-a");
    expect(
      store.roster.registerResident({
        operationId: "register-resident-a",
        roomId: "room-a",
        residentId: "resident-a",
      }),
    ).toEqual(registered);

    store.roster.mutateMembership({
      operationId: "leave-resident-a",
      roomId: "room-a",
      residentId: "resident-a",
      active: false,
    });
    store.append(appendInput({ operationId: "operation-2", requestSemantics: "second" }));
    store.roster.mutateMembership({
      operationId: "rejoin-resident-a",
      roomId: "room-a",
      residentId: "resident-a",
      active: true,
    });
    expect(store.roster.readRosterPath("broadcast", "room-a").residentIds).toContain("resident-a");
    expect(store.roster.readRosterPath("mention", "room-a").residentIds).toEqual(
      store.roster.readRosterPath("status", "room-a").residentIds,
    );
    const db = new DatabaseSync(join(root, "room-events.sqlite"));
    expect(
      db
        .prepare(
          "SELECT join_watermark, history_grant FROM room_memberships WHERE room_id = ? AND resident_id = ?",
        )
        .get("room-a", "resident-a"),
    ).toEqual({ join_watermark: 2, history_grant: 0 });
    db.close();
    store.close();
  });

  it("allocates positions independently for each room", async () => {
    const store = new RoomEventStore(await makeRoot());
    const firstA = store.append(appendInput());
    const firstB = store.append(
      appendInput({
        operationId: "operation-2",
        roomId: "room-b",
        requestSemantics: JSON.stringify({ roomId: "room-b" }),
      }),
    );
    const secondA = store.append(
      appendInput({ operationId: "operation-3", requestSemantics: "second" }),
    );

    expect([firstA.event.position, firstB.event.position, secondA.event.position]).toEqual([
      1, 1, 2,
    ]);
    store.close();
  });

  it("serializes position allocation across independent host processes", async () => {
    const root = await makeRoot();
    const initialize = new RoomEventStore(root);
    initialize.close();

    const worker = fileURLToPath(new URL("./room-event-store-worker.ts", import.meta.url));
    const writers = ["writer-a", "writer-b"].map((writer) => runWriter(worker, root, writer));
    await Promise.all([
      waitForFile(join(root, "writer-a.ready")),
      waitForFile(join(root, "writer-b.ready")),
    ]);
    await writeFile(join(root, "start"), "go", { flag: "wx" });
    await Promise.all(writers);

    const reader = new RoomEventStore(root);
    const events = reader.readRoomEvents("shared-room");
    const positions = events.map((event) => event.position).sort((left, right) => left - right);
    expect(events).toHaveLength(128);
    expect(positions).toEqual(Array.from({ length: 128 }, (_, index) => index + 1));
    expect(new Set(events.map((event) => event.id)).size).toBe(128);
    reader.close();
  }, 20_000);

  it("waits for an external SQLite writer lock and commits after it is released", async () => {
    const root = await makeRoot();
    const initialize = new RoomEventStore(root);
    initialize.close();

    const writerId = "locked-writer";
    const worker = fileURLToPath(new URL("./room-event-store-worker.ts", import.meta.url));
    const writer = runWriter(worker, root, writerId);
    await waitForFile(join(root, `${writerId}.ready`));

    const blocker = new DatabaseSync(join(root, "room-events.sqlite"));
    blocker.exec("PRAGMA busy_timeout = 10000; BEGIN IMMEDIATE");
    try {
      await writeFile(join(root, "start"), "go", { flag: "wx" });
      await waitForFile(join(root, `${writerId}.attempting`));
      await new Promise((resolve) => setTimeout(resolve, 100));

      await expect(access(join(root, `${writerId}.done`))).rejects.toThrow();
      blocker.exec("COMMIT");
      await writer;
      await expect(access(join(root, `${writerId}.done`))).resolves.toBeUndefined();
    } finally {
      try {
        blocker.exec("ROLLBACK");
      } catch {
        // The successful path has already committed the lock transaction.
      }
      blocker.close();
      await writer.catch(() => undefined);
    }

    const reader = new RoomEventStore(root);
    expect(reader.readRoomEvents("shared-room")).toHaveLength(64);
    reader.close();
  }, 20_000);
});

function runWriter(worker: string, root: string, writerId: string): Promise<void> {
  const child = spawn(process.execPath, ["--import", "tsx", worker, root, writerId], {
    cwd: fileURLToPath(new URL("../..", import.meta.url)),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `room-event writer ${writerId} exited ${String(code)}/${String(signal)}: ${stderr}`,
          ),
        );
    });
  });
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`timed out waiting for concurrent writer file: ${path}`);
}

function downgradeToV2(root: string, withStageCollision = false): void {
  const db = new DatabaseSync(join(root, "room-events.sqlite"));
  db.exec(`
    DROP TABLE room_stage_receipts;
    DROP TABLE room_resident_reactions;
    DROP TABLE room_context_commits;
    DROP TABLE room_delivery_current;
    DROP TABLE room_delivery_transitions;
    DROP TABLE room_roster_mutations;
    DROP TABLE room_memberships;
    DROP TABLE room_residents;
    DROP TABLE room_roster_state;
    ${withStageCollision ? "CREATE TABLE room_stage_receipts (collision TEXT);" : ""}
    PRAGMA user_version = 2;
  `);
  db.close();
}
