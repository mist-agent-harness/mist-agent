import { randomUUID } from "node:crypto";
import {
  type CanonicalEventDraft,
  type DeliveryReceipt,
  hashSubmission,
  normalizeDraft,
} from "./event-contract.ts";
import type { CanonicalStreamStore } from "./store.ts";

export type WriterCheckpointName = "generated-before-write" | "durable-write-before-receipt";

export interface WriterCheckpoint {
  readonly name: WriterCheckpointName;
  readonly residentId: string;
  readonly idempotencyKey: string;
  readonly eventId: string;
}

export interface CanonicalEventSubmission {
  readonly residentId: string;
  readonly idempotencyKey: string;
  readonly draft: CanonicalEventDraft;
}

export interface CanonicalStreamWriterOptions {
  readonly newEventId?: () => string;
  readonly checkpoint?: (checkpoint: WriterCheckpoint) => Promise<void>;
}

export class WriterOwnershipError extends Error {
  readonly code = "WRITER_OWNERSHIP_CONFLICT";
  constructor() {
    super("a canonical stream writer already owns this data root in the current process");
    this.name = "WriterOwnershipError";
  }
}

export class WriterClosedError extends Error {
  readonly code = "WRITER_CLOSED";
  constructor() {
    super("canonical stream writer is closed");
    this.name = "WriterClosedError";
  }
}

const ownedScopes = new Set<string | symbol>();

export class CanonicalStreamWriter {
  readonly #store: CanonicalStreamStore;
  readonly #scope: string | symbol;
  readonly #newEventId: () => string;
  readonly #checkpoint: (checkpoint: WriterCheckpoint) => Promise<void>;
  readonly #queues = new Map<string, Promise<void>>();
  #closed = false;

  constructor(store: CanonicalStreamStore, options: CanonicalStreamWriterOptions = {}) {
    this.#store = store;
    this.#scope = store.writerScope();
    if (ownedScopes.has(this.#scope)) throw new WriterOwnershipError();
    ownedScopes.add(this.#scope);
    this.#newEventId = options.newEventId ?? randomUUID;
    this.#checkpoint = options.checkpoint ?? (async () => undefined);
  }

  submit(submission: CanonicalEventSubmission): Promise<DeliveryReceipt> {
    if (this.#closed) return Promise.reject(new WriterClosedError());
    if (submission.residentId.length === 0 || submission.idempotencyKey.length === 0) {
      return Promise.reject(new Error("residentId and idempotencyKey must be non-empty"));
    }
    const draft = normalizeDraft(submission.draft);
    const requestHash = hashSubmission(submission.residentId, draft);
    return this.#enqueue(submission.residentId, async () => {
      const previous = this.#store.receiptFor(
        submission.residentId,
        submission.idempotencyKey,
        requestHash,
      );
      if (previous !== null) return previous;

      const eventId = this.#newEventId();
      if (eventId.length === 0) throw new Error("event id source returned an empty id");
      await this.#checkpoint({
        name: "generated-before-write",
        residentId: submission.residentId,
        idempotencyKey: submission.idempotencyKey,
        eventId,
      });
      const receipt = this.#store.append({
        residentId: submission.residentId,
        idempotencyKey: submission.idempotencyKey,
        requestHash,
        eventId,
        draft,
      });
      await this.#checkpoint({
        name: "durable-write-before-receipt",
        residentId: submission.residentId,
        idempotencyKey: submission.idempotencyKey,
        eventId,
      });
      return receipt;
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.all([...this.#queues.values()]);
    ownedScopes.delete(this.#scope);
  }

  #enqueue<T>(residentId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(residentId) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const marker = previous.then(
      () => gate,
      () => gate,
    );
    this.#queues.set(residentId, marker);

    return previous.then(operation, operation).finally(() => {
      release();
      if (this.#queues.get(residentId) === marker) this.#queues.delete(residentId);
    });
  }
}
