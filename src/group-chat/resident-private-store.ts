import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  readonly DatabaseSync: new (location: string) => DatabaseSyncType;
};

export interface ResidentMemory {
  readonly id: string;
  readonly residentId: string;
  readonly sourceEventId: string;
  readonly body: string;
}

interface ContextRow {
  readonly canary: string;
}

interface MemoryRow {
  readonly id: string;
  readonly resident_id: string;
  readonly source_event_id: string;
  readonly body: string;
}

export class CrossResidentPrivateReadError extends Error {
  override readonly name = "CrossResidentPrivateReadError";

  constructor() {
    super("resident-private store refuses cross-resident reads");
  }
}

/** Private context and explicit memories live in a separate file from the public room ledger. */
export class ResidentPrivateStore {
  readonly #databasePath: string;
  readonly #database: DatabaseSyncType;
  #closed = false;

  constructor(dataRoot: string) {
    const resolvedRoot = resolve(dataRoot);
    mkdirSync(resolvedRoot, { recursive: true, mode: 0o700 });
    this.#databasePath = join(resolvedRoot, "resident-private.sqlite");
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
    chmodSync(this.#databasePath, 0o600);
  }

  seedContext(residentId: string, canary: string): void {
    this.#assertOpen();
    this.#database
      .prepare(
        `INSERT INTO resident_private_context (id, resident_id, canary)
         VALUES (?, ?, ?) ON CONFLICT(resident_id, canary) DO NOTHING`,
      )
      .run(randomUUID(), residentId, canary);
  }

  readContext(requesterResidentId: string, ownerResidentId: string): string {
    this.#assertOpen();
    this.#requireOwner(requesterResidentId, ownerResidentId);
    const rows = this.#database
      .prepare("SELECT canary FROM resident_private_context WHERE resident_id = ? ORDER BY rowid")
      .all(ownerResidentId) as unknown as ContextRow[];
    return rows.map((row) => row.canary).join("\n");
  }

  saveMemory(input: {
    readonly residentId: string;
    readonly sourceEventId: string;
    readonly body: string;
  }): ResidentMemory {
    return this.#inTransaction(() => {
      const existing = this.#database
        .prepare(
          `SELECT id, resident_id, source_event_id, body FROM resident_memories
           WHERE resident_id = ? AND source_event_id = ?`,
        )
        .get(input.residentId, input.sourceEventId) as MemoryRow | undefined;
      if (existing !== undefined) {
        if (existing.body !== input.body)
          throw new Error("memory source event was already saved with different body semantics");
        return memoryFromRow(existing);
      }

      const memory: ResidentMemory = {
        id: randomUUID(),
        residentId: input.residentId,
        sourceEventId: input.sourceEventId,
        body: input.body,
      };
      this.#database
        .prepare(
          `INSERT INTO resident_memories (id, resident_id, source_event_id, body)
           VALUES (?, ?, ?, ?)`,
        )
        .run(memory.id, memory.residentId, memory.sourceEventId, memory.body);
      return memory;
    });
  }

  readMemories(requesterResidentId: string, ownerResidentId: string): readonly ResidentMemory[] {
    this.#assertOpen();
    this.#requireOwner(requesterResidentId, ownerResidentId);
    const rows = this.#database
      .prepare(
        `SELECT id, resident_id, source_event_id, body FROM resident_memories
         WHERE resident_id = ? ORDER BY rowid`,
      )
      .all(ownerResidentId) as unknown as MemoryRow[];
    return rows.map(memoryFromRow);
  }

  /** Trusted host-side acceptance audit; resident-facing reads must use the owner-checked API. */
  readAllMemoriesForHostAudit(): readonly ResidentMemory[] {
    this.#assertOpen();
    const rows = this.#database
      .prepare(
        `SELECT id, resident_id, source_event_id, body FROM resident_memories
         ORDER BY resident_id, rowid`,
      )
      .all() as unknown as MemoryRow[];
    return rows.map(memoryFromRow);
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  #requireOwner(requesterResidentId: string, ownerResidentId: string): void {
    if (requesterResidentId !== ownerResidentId) throw new CrossResidentPrivateReadError();
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
        // Preserve the original write error.
      }
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("resident-private store is closed");
  }

  #initializeSchema(): void {
    const row = this.#database.prepare("PRAGMA user_version").get() as
      | { readonly user_version: number }
      | undefined;
    const version = row?.user_version ?? 0;
    if (version > 1) throw new Error(`unsupported resident-private schema version: ${version}`);
    if (version === 1) return;

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.exec(`
        CREATE TABLE resident_private_context (
          id TEXT PRIMARY KEY NOT NULL,
          resident_id TEXT NOT NULL,
          canary TEXT NOT NULL,
          UNIQUE (resident_id, canary)
        ) STRICT;
        CREATE TABLE resident_memories (
          id TEXT PRIMARY KEY NOT NULL,
          resident_id TEXT NOT NULL,
          source_event_id TEXT NOT NULL,
          body TEXT NOT NULL,
          UNIQUE (resident_id, source_event_id)
        ) STRICT;
        PRAGMA user_version = 1;
      `);
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
}

function memoryFromRow(row: MemoryRow): ResidentMemory {
  return {
    id: row.id,
    residentId: row.resident_id,
    sourceEventId: row.source_event_id,
    body: row.body,
  };
}
