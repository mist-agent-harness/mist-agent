import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  readonly DatabaseSync: new (location: string) => DatabaseSyncType;
};

export const ROOM_RECORDED_CLAIM = "房间已记录";

export interface RoomEvent {
  readonly id: string;
  readonly roomId: string;
  readonly position: number;
  readonly principalId: string;
  readonly authorId: string;
  readonly body: string;
  readonly visibility: "public" | "hidden";
  readonly mentions: readonly string[];
}

export interface RoomRecordedReceipt {
  readonly actor: "system";
  readonly phase: "recorded";
  readonly roomEventId: string;
  readonly claim: string;
}

export type DeliveryState = "loaded" | "queued" | "not-targeted";

export interface DeliveryRecord {
  readonly residentId: string;
  readonly state: DeliveryState;
  readonly sequence: number;
}

export interface ContextCommitRecord {
  readonly id: string;
  readonly roomEventId: string;
  readonly residentId: string;
  readonly marker: string;
}

export interface RoomReactionRecord {
  readonly residentId: string;
  readonly eventMarker: string;
}

export interface RoomRosterSnapshot {
  readonly version: number;
  readonly residentIds: readonly string[];
}

export interface RoomStageReceipt {
  readonly actor: "system";
  readonly phase: "dispatched" | "context-committed";
  readonly roomEventId: string;
  readonly rosterVersion: number;
  readonly claim?: string;
  readonly contextCommitRef?: string;
}

export interface RoomEventAppend {
  readonly operationId: string;
  readonly roomId: string;
  readonly principalId: string;
  readonly authorId: string;
  readonly body: string;
  readonly visibility: "public" | "hidden";
  readonly mentions?: readonly string[];
  /** Stable serialization of the full accepted request, used to detect operation-id reuse. */
  readonly requestSemantics: string;
  /** When supplied, event and system receipt are committed in the same SQLite transaction. */
  readonly recordedClaim?: string;
}

export interface RoomEventAppendResult {
  readonly event: RoomEvent;
  readonly receipt: RoomRecordedReceipt | null;
  readonly replayed: boolean;
}

interface RoomEventRow {
  readonly id: string;
  readonly room_id: string;
  readonly position: number;
  readonly principal_id: string;
  readonly author_id: string;
  readonly body: string;
  readonly visibility: "public" | "hidden";
  readonly mentions_json: string;
  readonly request_semantics: string;
}

interface RoomReceiptRow {
  readonly event_id: string;
  readonly actor: "system";
  readonly phase: "recorded";
  readonly claim: string;
}

interface DeliveryRow {
  readonly resident_id: string;
  readonly state: DeliveryState;
  readonly sequence: number;
}

interface ContextCommitRow {
  readonly id: string;
  readonly event_id: string;
  readonly resident_id: string;
  readonly marker: string;
}

interface SystemReceiptReadRow {
  readonly event_id: string;
  readonly actor: "system";
  readonly phase: "recorded" | "dispatched" | "context-committed";
  readonly claim: string | null;
  readonly context_commit_id: string | null;
  readonly roster_version: number | null;
}

interface ReactionRow {
  readonly resident_id: string;
  readonly event_marker: string;
}

export class DeliveryOperationConflictError extends Error {
  override readonly name = "DeliveryOperationConflictError";

  constructor(readonly operationId: string) {
    super(`delivery operation id was already used with different semantics: ${operationId}`);
  }
}

export class RoomOperationConflictError extends Error {
  override readonly name = "RoomOperationConflictError";

  constructor(readonly operationId: string) {
    super(`operation id was already used with different room-message semantics: ${operationId}`);
  }
}

/**
 * The room stream's single durable writer. SQLite's IMMEDIATE transaction serializes writers
 * across host processes, so position allocation and append cannot split into separate races.
 * This store is internal: authorization belongs to postRoomMessage before append is called.
 */
export class RoomEventStore {
  readonly #databasePath: string;
  readonly #database: DatabaseSyncType;
  readonly roster: RoomRosterStore;
  #closed = false;

  constructor(dataRoot: string) {
    const resolvedRoot = resolve(dataRoot);
    mkdirSync(resolvedRoot, { recursive: true, mode: 0o700 });
    this.#databasePath = join(resolvedRoot, "room-events.sqlite");
    this.#database = new DatabaseSync(this.#databasePath);
    this.#database.exec("PRAGMA busy_timeout = 10000");
    this.#database.exec("PRAGMA journal_mode = WAL");
    this.#database.exec("PRAGMA synchronous = FULL");
    this.#database.exec("PRAGMA foreign_keys = ON");
    try {
      this.#initializeSchema();
    } catch (error) {
      this.#database.close();
      throw error;
    }
    this.roster = new RoomRosterStore(this.#database, () => this.#assertOpen());
    chmodSync(this.#databasePath, 0o600);
  }

  append(input: RoomEventAppend): RoomEventAppendResult {
    const appended = this.#append(input);
    if (appended === null) throw new Error("unconditional room-event append was denied");
    return appended;
  }

  /**
   * Replay an identical durable operation before consulting volatile grants. A genuinely new
   * operation must pass the supplied authorization while this store holds its writer lock.
   */
  appendIfNewAuthorized(
    input: RoomEventAppend,
    authorizeNew: () => boolean,
  ): RoomEventAppendResult | null {
    return this.#append(input, authorizeNew);
  }

  #append(input: RoomEventAppend, authorizeNew?: () => boolean): RoomEventAppendResult | null {
    if (this.#closed) throw new Error("room event store is closed");

    let inTransaction = false;
    try {
      this.#database.exec("BEGIN IMMEDIATE");
      inTransaction = true;

      const existing = this.#database
        .prepare(
          `SELECT id, room_id, position, principal_id, author_id, body, visibility, mentions_json, request_semantics
           FROM room_events WHERE operation_id = ?`,
        )
        .get(input.operationId) as RoomEventRow | undefined;

      if (existing !== undefined) {
        const receiptRow = this.#readReceiptRow(existing.id);
        if (
          existing.request_semantics !== input.requestSemantics ||
          (receiptRow?.claim ?? null) !== (input.recordedClaim ?? null)
        ) {
          throw new RoomOperationConflictError(input.operationId);
        }
        this.#database.exec("COMMIT");
        inTransaction = false;
        return {
          event: eventFromRow(existing),
          receipt: receiptRow === undefined ? null : receiptFromRow(receiptRow),
          replayed: true,
        };
      }

      if (authorizeNew !== undefined && !authorizeNew()) {
        this.#database.exec("COMMIT");
        inTransaction = false;
        return null;
      }

      const currentHead = this.#database
        .prepare("SELECT last_position FROM room_heads WHERE room_id = ?")
        .get(input.roomId) as { readonly last_position: number } | undefined;
      const position = (currentHead?.last_position ?? 0) + 1;
      const mentions = [...(input.mentions ?? [])];
      const event: RoomEvent = {
        id: randomUUID(),
        roomId: input.roomId,
        position,
        principalId: input.principalId,
        authorId: input.authorId,
        body: input.body,
        visibility: input.visibility,
        mentions,
      };

      this.#database
        .prepare(
          `INSERT INTO room_events
            (id, operation_id, room_id, position, principal_id, author_id, body, visibility, mentions_json, request_semantics)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.id,
          input.operationId,
          event.roomId,
          event.position,
          event.principalId,
          event.authorId,
          event.body,
          event.visibility,
          JSON.stringify(event.mentions),
          input.requestSemantics,
        );
      this.#database
        .prepare(
          `INSERT INTO room_heads (room_id, last_position) VALUES (?, ?)
           ON CONFLICT(room_id) DO UPDATE SET last_position = excluded.last_position`,
        )
        .run(event.roomId, event.position);

      let receipt: RoomRecordedReceipt | null = null;
      if (input.recordedClaim !== undefined) {
        this.#database
          .prepare(
            `INSERT INTO room_system_receipts (event_id, actor, phase, claim)
             VALUES (?, 'system', 'recorded', ?)`,
          )
          .run(event.id, input.recordedClaim);
        receipt = {
          actor: "system",
          phase: "recorded",
          roomEventId: event.id,
          claim: input.recordedClaim,
        };
      }

      this.#database.exec("COMMIT");
      inTransaction = false;
      return { event, receipt, replayed: false };
    } catch (error) {
      if (inTransaction) {
        try {
          this.#database.exec("ROLLBACK");
        } catch {
          // Preserve the original transaction error.
        }
      }
      throw error;
    }
  }

  readRoomEvents(roomId?: string): readonly RoomEvent[] {
    if (this.#closed) throw new Error("room event store is closed");
    const rows = (roomId === undefined
      ? this.#database
          .prepare(
            `SELECT id, room_id, position, principal_id, author_id, body, visibility, mentions_json, request_semantics
               FROM room_events ORDER BY room_id, position`,
          )
          .all()
      : this.#database
          .prepare(
            `SELECT id, room_id, position, principal_id, author_id, body, visibility, mentions_json, request_semantics
               FROM room_events WHERE room_id = ? ORDER BY position`,
          )
          .all(roomId)) as unknown as RoomEventRow[];
    return rows.map(eventFromRow);
  }

  latestDispatchedEvent(roomId: string): RoomEvent | null {
    this.#assertOpen();
    const row = this.#database
      .prepare(
        `SELECT event.id, event.room_id, event.position, event.principal_id, event.author_id,
                event.body, event.visibility, event.mentions_json, event.request_semantics
         FROM room_events AS event
         JOIN room_stage_receipts AS receipt ON receipt.event_id = event.id
         WHERE event.room_id = ? AND receipt.phase = 'dispatched'
         ORDER BY event.position DESC LIMIT 1`,
      )
      .get(roomId) as RoomEventRow | undefined;
    return row === undefined ? null : eventFromRow(row);
  }

  readSystemReceipts(): readonly (RoomRecordedReceipt | RoomStageReceipt)[] {
    if (this.#closed) throw new Error("room event store is closed");
    const rows = this.#database
      .prepare(
        `SELECT event_id, actor, phase, claim, context_commit_id, roster_version
         FROM (
           SELECT event.id AS event_id, 'system' AS actor, 'recorded' AS phase,
                  receipt.claim AS claim, NULL AS context_commit_id, NULL AS roster_version,
                  event.room_id AS room_id, event.position AS room_position, 0 AS receipt_order
           FROM room_system_receipts AS receipt
           JOIN room_events AS event ON event.id = receipt.event_id
           UNION ALL
           SELECT stage.event_id, stage.actor, stage.phase, stage.claim,
                  stage.context_commit_id, stage.roster_version,
                  event.room_id, event.position, stage.receipt_order
           FROM room_stage_receipts AS stage
           JOIN room_events AS event ON event.id = stage.event_id
         )
         ORDER BY room_id, room_position, receipt_order`,
      )
      .all() as unknown as SystemReceiptReadRow[];
    return rows.map((row) =>
      row.phase === "recorded"
        ? {
            actor: row.actor,
            phase: row.phase,
            roomEventId: row.event_id,
            claim: row.claim ?? "",
          }
        : {
            actor: row.actor,
            phase: row.phase,
            roomEventId: row.event_id,
            rosterVersion: row.roster_version ?? 0,
            ...(row.claim === null ? {} : { claim: row.claim }),
            ...(row.context_commit_id === null ? {} : { contextCommitRef: row.context_commit_id }),
          },
    );
  }

  findRoomEventByMarker(marker: string, roomId?: string): RoomEvent {
    const matches = this.readRoomEvents(roomId).filter((event) => event.body.includes(marker));
    if (matches.length !== 1)
      throw new Error(`room-event marker must match exactly one event; found ${matches.length}`);
    const match = matches[0];
    if (match === undefined) throw new Error("room-event marker lookup lost its unique match");
    return match;
  }

  setDeliveryState(input: {
    readonly eventId: string;
    readonly residentId: string;
    readonly operationId: string;
    readonly state: DeliveryState;
  }): DeliveryRecord {
    return this.#inTransaction(() => this.#appendDeliveryTransition(input));
  }

  readDeliveries(eventId: string): readonly DeliveryRecord[] {
    this.#assertOpen();
    const rows = this.#database
      .prepare(
        `SELECT resident_id, state, sequence FROM room_delivery_current
         WHERE event_id = ? ORDER BY resident_id`,
      )
      .all(eventId) as unknown as DeliveryRow[];
    return rows.map((row) => ({
      residentId: row.resident_id,
      state: row.state,
      sequence: row.sequence,
    }));
  }

  dispatchEvent(eventId: string, residentIds: readonly string[], rosterVersion: number): void {
    this.#inTransaction(() => {
      const event = this.#database.prepare("SELECT id FROM room_events WHERE id = ?").get(eventId);
      if (event === undefined) throw new Error(`cannot dispatch unknown room event: ${eventId}`);
      const alreadyDispatched = this.#database
        .prepare(
          "SELECT 1 AS present FROM room_stage_receipts WHERE event_id = ? AND phase = 'dispatched'",
        )
        .get(eventId);
      if (alreadyDispatched !== undefined) return;

      this.#database
        .prepare(
          `INSERT INTO room_stage_receipts
            (event_id, actor, phase, claim, context_commit_id, roster_version)
           VALUES (?, 'system', 'dispatched', NULL, NULL, ?)`,
        )
        .run(eventId, rosterVersion);
      for (const residentId of residentIds) {
        this.#appendDeliveryTransition({
          eventId,
          residentId,
          operationId: `dispatch:${eventId}:${residentId}`,
          state: "queued",
        });
      }
    });
  }

  commitContext(input: {
    readonly roomEventId: string;
    readonly residentId: string;
    readonly marker: string;
  }): ContextCommitRecord {
    return this.#inTransaction(() => {
      const dispatched = this.#database
        .prepare(
          "SELECT 1 AS present FROM room_stage_receipts WHERE event_id = ? AND phase = 'dispatched'",
        )
        .get(input.roomEventId);
      if (dispatched === undefined)
        throw new Error("context cannot be committed before its room event is dispatched");

      const delivery = this.#database
        .prepare(
          `SELECT 1 AS present FROM room_delivery_current
           WHERE event_id = ? AND resident_id = ? AND state IN ('queued', 'loaded')`,
        )
        .get(input.roomEventId, input.residentId);
      if (delivery === undefined)
        throw new Error("context cannot be committed for a resident without a dispatch delivery");

      const existing = this.#database
        .prepare(
          `SELECT id, event_id, resident_id, marker FROM room_context_commits
           WHERE event_id = ? AND resident_id = ? AND marker = ?`,
        )
        .get(input.roomEventId, input.residentId, input.marker) as ContextCommitRow | undefined;
      if (existing !== undefined) return contextCommitFromRow(existing);

      const commit: ContextCommitRecord = {
        id: randomUUID(),
        roomEventId: input.roomEventId,
        residentId: input.residentId,
        marker: input.marker,
      };
      this.#database
        .prepare(
          `INSERT INTO room_context_commits (id, event_id, resident_id, marker)
           VALUES (?, ?, ?, ?)`,
        )
        .run(commit.id, commit.roomEventId, commit.residentId, commit.marker);
      this.#database
        .prepare(
          `INSERT INTO room_stage_receipts
            (event_id, actor, phase, claim, context_commit_id, roster_version)
           VALUES (?, 'system', 'context-committed', NULL, ?,
             (SELECT roster_version FROM room_stage_receipts
              WHERE event_id = ? AND phase = 'dispatched'))`,
        )
        .run(commit.roomEventId, commit.id, commit.roomEventId);
      return commit;
    });
  }

  readContextCommits(): readonly ContextCommitRecord[] {
    this.#assertOpen();
    const rows = this.#database
      .prepare("SELECT id, event_id, resident_id, marker FROM room_context_commits ORDER BY rowid")
      .all() as unknown as ContextCommitRow[];
    return rows.map(contextCommitFromRow);
  }

  findContextCommitCandidates(
    roomId: string,
    residentId: string,
    marker: string,
  ): readonly string[] {
    this.#assertOpen();
    const rows = this.#database
      .prepare(
        `SELECT event.id
         FROM room_events AS event
         JOIN room_stage_receipts AS dispatched
           ON dispatched.event_id = event.id AND dispatched.phase = 'dispatched'
         JOIN room_delivery_current AS delivery
           ON delivery.event_id = event.id AND delivery.resident_id = ?
              AND delivery.state IN ('queued', 'loaded')
         LEFT JOIN room_context_commits AS committed
           ON committed.event_id = event.id AND committed.resident_id = ? AND committed.marker = ?
         WHERE event.room_id = ? AND committed.id IS NULL
         ORDER BY event.position`,
      )
      .all(residentId, residentId, marker, roomId) as unknown as { readonly id: string }[];
    return rows.map((row) => row.id);
  }

  recordReaction(residentId: string, eventId: string, eventMarker: string): RoomReactionRecord {
    this.#assertOpen();
    this.#database
      .prepare(
        `INSERT INTO room_resident_reactions (event_id, resident_id, event_marker)
         VALUES (?, ?, ?) ON CONFLICT(event_id, resident_id) DO NOTHING`,
      )
      .run(eventId, residentId, eventMarker);
    const row = this.#database
      .prepare(
        "SELECT resident_id, event_marker FROM room_resident_reactions WHERE event_id = ? AND resident_id = ?",
      )
      .get(eventId, residentId) as unknown as ReactionRow | undefined;
    if (row === undefined) throw new Error("resident reaction was not persisted");
    if (row.event_marker !== eventMarker)
      throw new Error("resident reaction event marker conflicts with the stored reaction");
    return { residentId: row.resident_id, eventMarker: row.event_marker };
  }

  readReactions(): readonly RoomReactionRecord[] {
    this.#assertOpen();
    const rows = this.#database
      .prepare(
        `SELECT resident_id, event_marker FROM room_resident_reactions
         ORDER BY event_id, resident_id`,
      )
      .all() as unknown as ReactionRow[];
    return rows.map((row) => ({ residentId: row.resident_id, eventMarker: row.event_marker }));
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  #readReceiptRow(eventId: string): RoomReceiptRow | undefined {
    return this.#database
      .prepare("SELECT event_id, actor, phase, claim FROM room_system_receipts WHERE event_id = ?")
      .get(eventId) as RoomReceiptRow | undefined;
  }

  #appendDeliveryTransition(input: {
    readonly eventId: string;
    readonly residentId: string;
    readonly operationId: string;
    readonly state: DeliveryState;
  }): DeliveryRecord {
    const existing = this.#database
      .prepare(
        `SELECT event_id, resident_id, state, sequence
         FROM room_delivery_transitions WHERE operation_id = ?`,
      )
      .get(input.operationId) as
      | {
          readonly event_id: string;
          readonly resident_id: string;
          readonly state: DeliveryState;
          readonly sequence: number;
        }
      | undefined;
    if (existing !== undefined) {
      if (
        existing.event_id !== input.eventId ||
        existing.resident_id !== input.residentId ||
        existing.state !== input.state
      )
        throw new DeliveryOperationConflictError(input.operationId);
      return {
        residentId: existing.resident_id,
        state: existing.state,
        sequence: existing.sequence,
      };
    }

    const event = this.#database
      .prepare("SELECT 1 AS present FROM room_events WHERE id = ?")
      .get(input.eventId);
    if (event === undefined)
      throw new Error(`cannot record delivery for unknown room event: ${input.eventId}`);
    const latest = this.#database
      .prepare(
        `SELECT COALESCE(MAX(sequence), 0) AS sequence FROM room_delivery_transitions
         WHERE event_id = ? AND resident_id = ?`,
      )
      .get(input.eventId, input.residentId) as { readonly sequence: number };
    const sequence = latest.sequence + 1;
    this.#database
      .prepare(
        `INSERT INTO room_delivery_transitions
          (event_id, resident_id, operation_id, sequence, state)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.eventId, input.residentId, input.operationId, sequence, input.state);
    this.#database
      .prepare(
        `INSERT INTO room_delivery_current (event_id, resident_id, operation_id, sequence, state)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(event_id, resident_id) DO UPDATE SET
           operation_id = excluded.operation_id, sequence = excluded.sequence, state = excluded.state`,
      )
      .run(input.eventId, input.residentId, input.operationId, sequence, input.state);
    return { residentId: input.residentId, state: input.state, sequence };
  }

  #inTransaction<T>(action: () => T): T {
    this.#assertOpen();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        // Preserve the original transaction error.
      }
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("room event store is closed");
  }

  #initializeSchema(): void {
    const versionRow = this.#database.prepare("PRAGMA user_version").get() as
      | { readonly user_version: number }
      | undefined;
    const version = versionRow?.user_version ?? 0;
    if (version > 3) throw new Error(`unsupported room-event schema version: ${version}`);

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const lockedVersionRow = this.#database.prepare("PRAGMA user_version").get() as
        | { readonly user_version: number }
        | undefined;
      const lockedVersion = lockedVersionRow?.user_version ?? 0;
      if (lockedVersion > 3)
        throw new Error(`unsupported room-event schema version: ${lockedVersion}`);
      if (lockedVersion === 1) {
        this.#database.exec(
          "ALTER TABLE room_events ADD COLUMN mentions_json TEXT NOT NULL DEFAULT '[]'",
        );
        this.#database.exec("PRAGMA user_version = 2");
      } else if (lockedVersion === 0) {
        this.#database.exec(`
          CREATE TABLE IF NOT EXISTS room_events (
            id TEXT PRIMARY KEY NOT NULL,
            operation_id TEXT UNIQUE NOT NULL,
            room_id TEXT NOT NULL,
            position INTEGER NOT NULL CHECK (position > 0),
            principal_id TEXT NOT NULL,
            author_id TEXT NOT NULL,
            body TEXT NOT NULL,
            visibility TEXT NOT NULL CHECK (visibility IN ('public', 'hidden')),
            mentions_json TEXT NOT NULL DEFAULT '[]',
            request_semantics TEXT NOT NULL,
            UNIQUE (room_id, position)
          ) STRICT;
          CREATE TABLE IF NOT EXISTS room_heads (
            room_id TEXT PRIMARY KEY NOT NULL,
            last_position INTEGER NOT NULL CHECK (last_position > 0)
          ) STRICT;
          CREATE TABLE IF NOT EXISTS room_system_receipts (
            event_id TEXT PRIMARY KEY NOT NULL REFERENCES room_events(id),
            actor TEXT NOT NULL CHECK (actor = 'system'),
            phase TEXT NOT NULL CHECK (phase = 'recorded'),
            claim TEXT NOT NULL
          ) STRICT;
          CREATE INDEX IF NOT EXISTS room_events_room_position
            ON room_events (room_id, position);
          PRAGMA user_version = 2;
        `);
      }
      const baseVersion = this.#database.prepare("PRAGMA user_version").get() as {
        readonly user_version: number;
      };
      if (baseVersion.user_version === 2) this.#migrateV2ToV3();
      this.#database.exec("COMMIT");
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        // Preserve the original schema error.
      }
      throw error;
    }
  }

  #migrateV2ToV3(): void {
    this.#database.exec(`
      CREATE TABLE room_roster_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        version INTEGER NOT NULL CHECK (version >= 0)
      ) STRICT;
      INSERT INTO room_roster_state (singleton, version) VALUES (1, 0);
      CREATE TABLE room_residents (
        resident_id TEXT PRIMARY KEY NOT NULL
      ) STRICT;
      CREATE TABLE room_memberships (
        room_id TEXT NOT NULL,
        resident_id TEXT NOT NULL REFERENCES room_residents(resident_id),
        active INTEGER NOT NULL CHECK (active IN (0, 1)),
        join_watermark INTEGER NOT NULL CHECK (join_watermark >= 0),
        history_grant INTEGER NOT NULL CHECK (history_grant IN (0, 1)),
        PRIMARY KEY (room_id, resident_id)
      ) STRICT;
      CREATE TABLE room_roster_mutations (
        operation_id TEXT PRIMARY KEY NOT NULL,
        room_id TEXT NOT NULL,
        resident_id TEXT NOT NULL,
        active INTEGER NOT NULL CHECK (active IN (0, 1))
      ) STRICT;
      CREATE TABLE room_delivery_transitions (
        event_id TEXT NOT NULL REFERENCES room_events(id),
        resident_id TEXT NOT NULL,
        operation_id TEXT UNIQUE NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        state TEXT NOT NULL CHECK (state IN ('loaded', 'queued', 'not-targeted')),
        PRIMARY KEY (event_id, resident_id, sequence)
      ) STRICT;
      CREATE TABLE room_delivery_current (
        event_id TEXT NOT NULL REFERENCES room_events(id),
        resident_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        state TEXT NOT NULL CHECK (state IN ('loaded', 'queued', 'not-targeted')),
        PRIMARY KEY (event_id, resident_id),
        FOREIGN KEY (event_id, resident_id, sequence)
          REFERENCES room_delivery_transitions(event_id, resident_id, sequence)
      ) STRICT;
      CREATE TRIGGER room_delivery_transitions_no_update
        BEFORE UPDATE ON room_delivery_transitions
        BEGIN SELECT RAISE(ABORT, 'delivery transitions are append-only'); END;
      CREATE TRIGGER room_delivery_transitions_no_delete
        BEFORE DELETE ON room_delivery_transitions
        BEGIN SELECT RAISE(ABORT, 'delivery transitions are append-only'); END;
      CREATE TABLE room_context_commits (
        id TEXT PRIMARY KEY NOT NULL,
        event_id TEXT NOT NULL REFERENCES room_events(id),
        resident_id TEXT NOT NULL,
        marker TEXT NOT NULL,
        UNIQUE (event_id, resident_id, marker)
      ) STRICT;
      CREATE TABLE room_resident_reactions (
        event_id TEXT NOT NULL REFERENCES room_events(id),
        resident_id TEXT NOT NULL,
        event_marker TEXT NOT NULL,
        PRIMARY KEY (event_id, resident_id)
      ) STRICT;
      CREATE TABLE room_stage_receipts (
        receipt_order INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL REFERENCES room_events(id),
        actor TEXT NOT NULL CHECK (actor = 'system'),
        phase TEXT NOT NULL CHECK (phase IN ('dispatched', 'context-committed')),
        claim TEXT,
        context_commit_id TEXT REFERENCES room_context_commits(id),
        roster_version INTEGER NOT NULL CHECK (roster_version >= 0),
        CHECK (
          (phase = 'dispatched' AND context_commit_id IS NULL) OR
          (phase = 'context-committed' AND context_commit_id IS NOT NULL)
        )
      ) STRICT;
      CREATE TRIGGER room_stage_receipts_no_update
        BEFORE UPDATE ON room_stage_receipts
        BEGIN SELECT RAISE(ABORT, 'stage receipts are append-only'); END;
      CREATE TRIGGER room_stage_receipts_no_delete
        BEFORE DELETE ON room_stage_receipts
        BEGIN SELECT RAISE(ABORT, 'stage receipts are append-only'); END;
      CREATE UNIQUE INDEX room_stage_dispatched_once
        ON room_stage_receipts(event_id) WHERE phase = 'dispatched';
      CREATE UNIQUE INDEX room_stage_context_commit_once
        ON room_stage_receipts(context_commit_id) WHERE phase = 'context-committed';
      PRAGMA user_version = 3;
    `);
  }
}

function eventFromRow(row: RoomEventRow): RoomEvent {
  return {
    id: row.id,
    roomId: row.room_id,
    position: row.position,
    principalId: row.principal_id,
    authorId: row.author_id,
    body: row.body,
    visibility: row.visibility,
    mentions: parseMentions(row.mentions_json),
  };
}

function receiptFromRow(row: RoomReceiptRow): RoomRecordedReceipt {
  return {
    actor: row.actor,
    phase: row.phase,
    roomEventId: row.event_id,
    claim: row.claim,
  };
}

function contextCommitFromRow(row: ContextCommitRow): ContextCommitRecord {
  return {
    id: row.id,
    roomEventId: row.event_id,
    residentId: row.resident_id,
    marker: row.marker,
  };
}

/** One versioned roster, shared by registration, membership mutations and every roster path. */
export class RoomRosterStore {
  readonly #database: DatabaseSyncType;
  readonly #assertOpen: () => void;

  constructor(database: DatabaseSyncType, assertOpen: () => void) {
    this.#database = database;
    this.#assertOpen = assertOpen;
  }

  mutateMembership(input: {
    readonly operationId: string;
    readonly roomId: string;
    readonly residentId: string;
    readonly active: boolean;
  }): RoomRosterSnapshot {
    return this.#inTransaction(() => {
      const active = input.active ? 1 : 0;
      const prior = this.#database
        .prepare(
          "SELECT room_id, resident_id, active FROM room_roster_mutations WHERE operation_id = ?",
        )
        .get(input.operationId) as
        | { readonly room_id: string; readonly resident_id: string; readonly active: number }
        | undefined;
      if (prior !== undefined) {
        if (
          prior.room_id !== input.roomId ||
          prior.resident_id !== input.residentId ||
          prior.active !== active
        )
          throw new Error(`roster mutation operation id conflict: ${input.operationId}`);
        return this.#readRoster();
      }

      const membership = this.#database
        .prepare("SELECT active FROM room_memberships WHERE room_id = ? AND resident_id = ?")
        .get(input.roomId, input.residentId) as { readonly active: number } | undefined;
      const changed = membership === undefined || membership.active !== active;
      if (membership === undefined) {
        this.#database
          .prepare("INSERT INTO room_residents (resident_id) VALUES (?) ON CONFLICT DO NOTHING")
          .run(input.residentId);
        const head = this.#database
          .prepare("SELECT last_position FROM room_heads WHERE room_id = ?")
          .get(input.roomId) as { readonly last_position: number } | undefined;
        this.#database
          .prepare(
            `INSERT INTO room_memberships
              (room_id, resident_id, active, join_watermark, history_grant)
             VALUES (?, ?, ?, ?, 0)`,
          )
          .run(input.roomId, input.residentId, active, head?.last_position ?? 0);
      } else if (changed) {
        const head = this.#database
          .prepare("SELECT last_position FROM room_heads WHERE room_id = ?")
          .get(input.roomId) as { readonly last_position: number } | undefined;
        const nextWatermark = active === 1 ? (head?.last_position ?? 0) : null;
        this.#database
          .prepare(
            `UPDATE room_memberships SET active = ?,
               join_watermark = COALESCE(?, join_watermark),
               history_grant = CASE WHEN ? = 1 THEN 0 ELSE history_grant END
             WHERE room_id = ? AND resident_id = ?`,
          )
          .run(active, nextWatermark, active, input.roomId, input.residentId);
      }
      this.#database
        .prepare(
          "INSERT INTO room_roster_mutations (operation_id, room_id, resident_id, active) VALUES (?, ?, ?, ?)",
        )
        .run(input.operationId, input.roomId, input.residentId, active);
      if (changed)
        this.#database.exec(
          "UPDATE room_roster_state SET version = version + 1 WHERE singleton = 1",
        );
      return this.#readRoster();
    });
  }

  registerResident(input: {
    readonly operationId: string;
    readonly roomId: string;
    readonly residentId: string;
  }): RoomRosterSnapshot {
    return this.mutateMembership({ ...input, active: true });
  }

  synchronizeMemberships(roomId: string, residentIds: readonly string[]): void {
    this.#assertOpen();
    const desired = new Set(residentIds);
    for (const residentId of this.activeResidentIds(roomId)) {
      if (desired.has(residentId)) continue;
      const version = this.#readRoster().version;
      this.mutateMembership({
        operationId: `fixture-membership:${roomId}:${residentId}:inactive:${version}`,
        roomId,
        residentId,
        active: false,
      });
    }
    for (const residentId of desired) {
      if (this.activeResidentIds(roomId).includes(residentId)) continue;
      const version = this.#readRoster().version;
      this.registerResident({
        operationId: `fixture-membership:${roomId}:${residentId}:active:${version}`,
        roomId,
        residentId,
      });
    }
  }

  readRoster(): RoomRosterSnapshot {
    this.#assertOpen();
    return this.#readRoster();
  }

  readRosterPath(
    path: "broadcast" | "mention" | "projection" | "feedback" | "status",
    roomId: string,
    humanIds: readonly string[] = [],
  ): {
    readonly residentIds: readonly string[];
    readonly humanIds: readonly string[];
  } {
    this.#assertOpen();
    const residentIds = this.activeResidentIds(roomId);
    switch (path) {
      case "broadcast":
      case "mention":
      case "projection":
      case "feedback":
      case "status":
        return { residentIds, humanIds: [...humanIds] };
    }
  }

  isActiveMember(roomId: string, residentId: string): boolean {
    this.#assertOpen();
    return (
      this.#database
        .prepare(
          "SELECT 1 AS present FROM room_memberships WHERE room_id = ? AND resident_id = ? AND active = 1",
        )
        .get(roomId, residentId) !== undefined
    );
  }

  activeResidentIds(roomId?: string): readonly string[] {
    this.#assertOpen();
    const rows = this.#database
      .prepare(
        roomId === undefined
          ? `SELECT DISTINCT resident_id FROM room_memberships
             WHERE active = 1 ORDER BY resident_id`
          : `SELECT resident_id FROM room_memberships
             WHERE active = 1 AND room_id = ? ORDER BY resident_id`,
      )
      .all(...(roomId === undefined ? [] : [roomId])) as unknown as {
      readonly resident_id: string;
    }[];
    return rows.map((row) => row.resident_id);
  }

  #readRoster(): RoomRosterSnapshot {
    const version = this.#database
      .prepare("SELECT version FROM room_roster_state WHERE singleton = 1")
      .get() as { readonly version: number };
    const rows = this.#database
      .prepare(
        `SELECT DISTINCT resident.resident_id FROM room_residents AS resident
         JOIN room_memberships AS membership ON membership.resident_id = resident.resident_id
         WHERE membership.active = 1 ORDER BY resident.resident_id`,
      )
      .all() as unknown as { readonly resident_id: string }[];
    return { version: version.version, residentIds: rows.map((row) => row.resident_id) };
  }

  #inTransaction<T>(action: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        // Preserve the original mutation error.
      }
      throw error;
    }
  }
}

function parseMentions(serialized: string): readonly string[] {
  const parsed: unknown = JSON.parse(serialized);
  if (!Array.isArray(parsed) || parsed.some((mention) => typeof mention !== "string"))
    throw new Error("room-event mentions are not a string array");
  return parsed;
}
