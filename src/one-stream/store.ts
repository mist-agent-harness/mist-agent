import {
  closeSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  type CanonicalEvent,
  type CanonicalEventDraft,
  type DeliveryReceipt,
  assertCanonicalEvent,
  buildCanonicalEvent,
  cloneEvent,
  cloneReceipt,
  hashSubmission,
  verifyCanonicalEvent,
} from "./event-contract.ts";

const SCHEMA_VERSION = 1;
const FILE_SUFFIX = ".stream.json";

interface IdempotencyRecord {
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly receipt: DeliveryReceipt;
}

interface StreamRecord {
  readonly schemaVersion: 1;
  readonly residentId: string;
  readonly nextSeq: number;
  readonly events: CanonicalEvent[];
  readonly idempotency: IdempotencyRecord[];
}

interface ResidentStream {
  readonly residentId: string;
  readonly events: CanonicalEvent[];
  readonly idempotency: Map<string, IdempotencyRecord>;
  nextSeq: number;
}

export interface CanonicalStreamReadPort {
  eventsAfter(residentId: string, afterSeq: number): CanonicalEvent[];
}

export class StreamNotFoundError extends Error {
  readonly code = "STREAM_NOT_FOUND";
  constructor(residentId: string) {
    super(`no canonical stream for resident: ${residentId}`);
    this.name = "StreamNotFoundError";
  }
}

export class IdempotencyConflictError extends Error {
  readonly code = "IDEMPOTENCY_CONFLICT";
  constructor(residentId: string, idempotencyKey: string) {
    super(`idempotency key reused with different content: ${residentId}/${idempotencyKey}`);
    this.name = "IdempotencyConflictError";
  }
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  name: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${name} has unexpected fields`);
  }
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value as number;
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function parseReceipt(value: unknown): DeliveryReceipt {
  const candidate = object(value, "delivery receipt");
  exactKeys(
    candidate,
    ["eventId", "payloadHash", "phase", "residentId", "streamSeq"],
    "delivery receipt",
  );
  if (candidate.phase !== "delivered") throw new Error("delivery receipt phase is invalid");
  return {
    phase: "delivered",
    residentId: nonEmptyString(candidate.residentId, "receipt.residentId"),
    eventId: nonEmptyString(candidate.eventId, "receipt.eventId"),
    streamSeq: positiveInteger(candidate.streamSeq, "receipt.streamSeq"),
    payloadHash: nonEmptyString(candidate.payloadHash, "receipt.payloadHash"),
  };
}

function parseRecord(value: unknown, file: string): StreamRecord {
  const candidate = object(value, `stream snapshot ${file}`);
  exactKeys(
    candidate,
    ["events", "idempotency", "nextSeq", "residentId", "schemaVersion"],
    `stream snapshot ${file}`,
  );
  if (candidate.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`unsupported stream schema in ${file}`);
  }
  const residentId = nonEmptyString(candidate.residentId, "snapshot.residentId");
  const nextSeq = positiveInteger(candidate.nextSeq, "snapshot.nextSeq");
  if (!Array.isArray(candidate.events) || !Array.isArray(candidate.idempotency)) {
    throw new Error(`stream snapshot arrays are invalid in ${file}`);
  }
  const events = candidate.events.map((value, index) => {
    assertCanonicalEvent(value);
    verifyCanonicalEvent(value);
    if (value.residentId !== residentId) {
      throw new Error(`event resident mismatch in ${file}`);
    }
    if (value.streamSeq !== index + 1) {
      throw new Error(`stream sequence is not contiguous in ${file}`);
    }
    return cloneEvent(value);
  });
  if (nextSeq !== events.length + 1) {
    throw new Error(`nextSeq does not follow stream head in ${file}`);
  }

  const eventById = new Map(events.map((event) => [event.eventId, event]));
  if (eventById.size !== events.length) throw new Error(`duplicate eventId in ${file}`);
  const seenKeys = new Set<string>();
  const seenReceiptEvents = new Set<string>();
  const idempotency = candidate.idempotency.map((value) => {
    const row = object(value, "idempotency record");
    exactKeys(row, ["idempotencyKey", "receipt", "requestHash"], "idempotency record");
    const idempotencyKey = nonEmptyString(row.idempotencyKey, "idempotencyKey");
    if (seenKeys.has(idempotencyKey)) throw new Error(`duplicate idempotency key in ${file}`);
    seenKeys.add(idempotencyKey);
    const requestHash = nonEmptyString(row.requestHash, "requestHash");
    const receipt = parseReceipt(row.receipt);
    const event = eventById.get(receipt.eventId);
    if (
      event === undefined ||
      receipt.residentId !== residentId ||
      receipt.streamSeq !== event.streamSeq ||
      receipt.payloadHash !== event.payloadHash
    ) {
      throw new Error(`idempotency receipt is not bound to its event in ${file}`);
    }
    if (seenReceiptEvents.has(receipt.eventId)) {
      throw new Error(`multiple idempotency records target one event in ${file}`);
    }
    seenReceiptEvents.add(receipt.eventId);
    const eventDraft: CanonicalEventDraft = {
      purpose: event.purpose,
      occurredAt: event.occurredAt,
      workRef: event.workRef,
      authoritySource: event.authoritySource,
      origin: event.origin,
      effect: event.effect,
      artifactRef: event.artifactRef,
      payload: event.payload,
    };
    if (requestHash !== hashSubmission(residentId, eventDraft)) {
      throw new Error(`idempotency request hash does not match its event in ${file}`);
    }
    return { idempotencyKey, requestHash, receipt };
  });
  if (idempotency.length !== events.length) {
    throw new Error(`stream event/idempotency count mismatch in ${file}`);
  }
  return { schemaVersion: 1, residentId, nextSeq, events, idempotency };
}

export class CanonicalStreamStore implements CanonicalStreamReadPort {
  readonly #streams = new Map<string, ResidentStream>();
  readonly #dataDir: string | null;
  readonly #memoryScope = Symbol("in-memory-canonical-stream");

  constructor(options: { dataDir?: string } = {}) {
    this.#dataDir = options.dataDir === undefined ? null : resolve(options.dataDir);
    if (this.#dataDir !== null) {
      mkdirSync(this.#dataDir, { recursive: true });
      this.#restore();
    }
  }

  /** Same-process writer ownership key. It is not a cross-process lock. */
  writerScope(): string | symbol {
    return this.#dataDir ?? this.#memoryScope;
  }

  createStream(residentId: string): void {
    this.#assertResidentId(residentId);
    if (this.#streams.has(residentId))
      throw new Error(`canonical stream already exists: ${residentId}`);
    const stream: ResidentStream = {
      residentId,
      nextSeq: 1,
      events: [],
      idempotency: new Map(),
    };
    this.#persist(this.#record(stream));
    this.#streams.set(residentId, stream);
  }

  has(residentId: string): boolean {
    return this.#streams.has(residentId);
  }

  events(residentId: string): CanonicalEvent[] {
    return this.#mustStream(residentId).events.map(cloneEvent);
  }

  eventsAfter(residentId: string, afterSeq: number): CanonicalEvent[] {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
      throw new Error("afterSeq must be a non-negative integer");
    }
    return this.#mustStream(residentId)
      .events.filter((event) => event.streamSeq > afterSeq)
      .map(cloneEvent);
  }

  receiptFor(
    residentId: string,
    idempotencyKey: string,
    requestHash: string,
  ): DeliveryReceipt | null {
    const previous = this.#mustStream(residentId).idempotency.get(idempotencyKey);
    if (previous === undefined) return null;
    if (previous.requestHash !== requestHash) {
      throw new IdempotencyConflictError(residentId, idempotencyKey);
    }
    return cloneReceipt(previous.receipt);
  }

  append(input: {
    residentId: string;
    idempotencyKey: string;
    requestHash: string;
    eventId: string;
    draft: CanonicalEventDraft;
  }): DeliveryReceipt {
    const stream = this.#mustStream(input.residentId);
    const previous = stream.idempotency.get(input.idempotencyKey);
    if (previous !== undefined) {
      if (previous.requestHash !== input.requestHash) {
        throw new IdempotencyConflictError(input.residentId, input.idempotencyKey);
      }
      return cloneReceipt(previous.receipt);
    }
    if (!Number.isSafeInteger(stream.nextSeq) || stream.nextSeq >= Number.MAX_SAFE_INTEGER)
      throw new Error("canonical stream sequence exhausted");
    const event = buildCanonicalEvent({
      residentId: input.residentId,
      eventId: input.eventId,
      streamSeq: stream.nextSeq,
      draft: input.draft,
    });
    if (stream.events.some((existing) => existing.eventId === event.eventId)) {
      throw new Error(`canonical event id collision: ${event.eventId}`);
    }
    const receipt: DeliveryReceipt = {
      phase: "delivered",
      residentId: event.residentId,
      eventId: event.eventId,
      streamSeq: event.streamSeq,
      payloadHash: event.payloadHash,
    };
    const next: ResidentStream = {
      residentId: stream.residentId,
      nextSeq: stream.nextSeq + 1,
      events: [...stream.events, event],
      idempotency: new Map(stream.idempotency),
    };
    next.idempotency.set(input.idempotencyKey, {
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      receipt,
    });
    this.#persist(this.#record(next));
    this.#streams.set(input.residentId, next);
    return cloneReceipt(receipt);
  }

  #mustStream(residentId: string): ResidentStream {
    const stream = this.#streams.get(residentId);
    if (stream === undefined) throw new StreamNotFoundError(residentId);
    return stream;
  }

  #assertResidentId(residentId: string): void {
    if (!/^[a-z0-9-]+$/.test(residentId)) {
      throw new Error(`resident id cannot be used as a stream filename: ${residentId}`);
    }
  }

  #record(stream: ResidentStream): StreamRecord {
    return {
      schemaVersion: 1,
      residentId: stream.residentId,
      nextSeq: stream.nextSeq,
      events: stream.events.map(cloneEvent),
      idempotency: [...stream.idempotency.values()].map((entry) => ({
        idempotencyKey: entry.idempotencyKey,
        requestHash: entry.requestHash,
        receipt: cloneReceipt(entry.receipt),
      })),
    };
  }

  #persist(record: StreamRecord): void {
    if (this.#dataDir === null) return;
    const finalPath = join(this.#dataDir, `${record.residentId}${FILE_SUFFIX}`);
    const temporaryPath = `${finalPath}.tmp`;
    let descriptor: number | null = null;
    try {
      descriptor = openSync(temporaryPath, "w", 0o600);
      fchmodSync(descriptor, 0o600);
      writeSync(descriptor, JSON.stringify(record));
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      renameSync(temporaryPath, finalPath);
    } catch (error) {
      if (descriptor !== null) {
        try {
          closeSync(descriptor);
        } catch {
          // Preserve the original write error.
        }
      }
      try {
        rmSync(temporaryPath, { force: true });
      } catch {
        // The write still fails loudly even if a malformed temporary target cannot be removed.
      }
      throw error;
    }
  }

  #restore(): void {
    if (this.#dataDir === null) return;
    for (const file of readdirSync(this.#dataDir).sort()) {
      if (!file.endsWith(FILE_SUFFIX)) continue;
      const record = parseRecord(
        JSON.parse(readFileSync(join(this.#dataDir, file), "utf8")) as unknown,
        file,
      );
      this.#assertResidentId(record.residentId);
      if (`${record.residentId}${FILE_SUFFIX}` !== file) {
        throw new Error(`stream snapshot filename/resident mismatch: ${file}`);
      }
      if (this.#streams.has(record.residentId)) {
        throw new Error(`duplicate resident stream snapshot: ${record.residentId}`);
      }
      this.#streams.set(record.residentId, {
        residentId: record.residentId,
        nextSeq: record.nextSeq,
        events: record.events.map(cloneEvent),
        idempotency: new Map(record.idempotency.map((entry) => [entry.idempotencyKey, entry])),
      });
    }
  }
}
