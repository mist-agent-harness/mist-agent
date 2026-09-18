import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DispatchReceipt } from "../session/session-registry.ts";
import type { ExternalChannelAddress, ExternalChannelBinding } from "./binding-store.ts";

export type ExternalInboundStatus = "pending" | "queued" | "dispatched" | "rejected" | "expired";

export type ExternalInboundReason = "QUEUE_FULL" | "EXPIRED";

export interface ExternalInboundItem {
  readonly inboundId: string;
  readonly bindingId: string;
  readonly residentId: string;
  readonly scopeId: string;
  readonly address: ExternalChannelAddress;
  readonly externalMessageId: string;
  readonly body: string;
  readonly receivedAt: string;
  readonly queuedAt: string;
  readonly expiresAt: string;
  readonly sequence: number;
  readonly status: ExternalInboundStatus;
  readonly reason?: ExternalInboundReason;
  readonly dispatch?: DispatchReceipt;
}

export interface ExternalScopeFact {
  readonly inboundId: string;
  readonly bindingId: string;
  readonly residentId: string;
  readonly scopeId: string;
  readonly address: ExternalChannelAddress;
  readonly externalMessageId: string;
  readonly body: string;
  readonly receivedAt: string;
  readonly dispatch: DispatchReceipt;
}

export interface ExternalInboundStoreOptions {
  readonly journalPath: string;
  readonly maxQueuedItems: number;
  readonly maxAgeMs: number;
  readonly now?: () => number;
}

type ReceivedEvent = {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly type: "received";
  readonly item: ExternalInboundItem;
};

type TransitionEvent = {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly type: "transition";
  readonly inboundId: string;
  readonly status: "queued" | "dispatched" | "expired" | "rejected";
  readonly at: string;
  readonly reason?: ExternalInboundReason;
  readonly dispatch?: DispatchReceipt;
};

type InboundJournalEvent = ReceivedEvent | TransitionEvent;

function sourceKey(
  bindingId: string,
  address: ExternalChannelAddress,
  externalMessageId: string,
): string {
  return JSON.stringify([bindingId, address.pluginId, address.channelId, externalMessageId]);
}

function cloneDispatch(dispatch: DispatchReceipt): DispatchReceipt {
  return { ...dispatch };
}

function cloneItem(item: ExternalInboundItem): ExternalInboundItem {
  return {
    ...item,
    address: { ...item.address },
    ...(item.dispatch === undefined ? {} : { dispatch: cloneDispatch(item.dispatch) }),
  };
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function validDispatch(value: unknown): value is DispatchReceipt {
  if (typeof value !== "object" || value === null) return false;
  const receipt = value as Partial<DispatchReceipt>;
  return (
    typeof receipt.residentId === "string" &&
    receipt.residentId.length > 0 &&
    typeof receipt.scopeId === "string" &&
    receipt.scopeId.length > 0 &&
    Number.isSafeInteger(receipt.scopeGeneration) &&
    Number(receipt.scopeGeneration) >= 1 &&
    typeof receipt.windowId === "string" &&
    receipt.windowId.length > 0 &&
    Number.isSafeInteger(receipt.generation) &&
    Number(receipt.generation) >= 1 &&
    typeof receipt.dispatchId === "string" &&
    receipt.dispatchId.length > 0
  );
}

function parseEvent(line: string, lineNumber: number): InboundJournalEvent {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error(`invalid external inbound journal JSON at line ${lineNumber}`);
  }
  if (typeof value !== "object" || value === null) {
    throw new Error(`invalid external inbound event at line ${lineNumber}`);
  }
  const event = value as Record<string, unknown>;
  if (
    event.schemaVersion !== 1 ||
    !Number.isSafeInteger(event.sequence) ||
    Number(event.sequence) < 1
  ) {
    throw new Error(`invalid external inbound event at line ${lineNumber}`);
  }
  if (event.type === "received") {
    const item = event.item as Partial<ExternalInboundItem> | undefined;
    if (
      typeof item !== "object" ||
      item === null ||
      typeof item.inboundId !== "string" ||
      item.inboundId.length === 0 ||
      typeof item.bindingId !== "string" ||
      item.bindingId.length === 0 ||
      typeof item.residentId !== "string" ||
      item.residentId.length === 0 ||
      typeof item.scopeId !== "string" ||
      item.scopeId.length === 0 ||
      typeof item.address?.pluginId !== "string" ||
      item.address.pluginId.length === 0 ||
      typeof item.address.channelId !== "string" ||
      item.address.channelId.length === 0 ||
      typeof item.externalMessageId !== "string" ||
      item.externalMessageId.length === 0 ||
      typeof item.body !== "string" ||
      typeof item.receivedAt !== "string" ||
      !Number.isFinite(Date.parse(item.receivedAt)) ||
      typeof item.queuedAt !== "string" ||
      !Number.isFinite(Date.parse(item.queuedAt)) ||
      typeof item.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(item.expiresAt)) ||
      !Number.isSafeInteger(item.sequence) ||
      Number(item.sequence) < 1 ||
      !["pending", "queued", "rejected", "expired"].includes(String(item.status))
    ) {
      throw new Error(`invalid external inbound item at line ${lineNumber}`);
    }
    return event as unknown as ReceivedEvent;
  }
  if (event.type === "transition") {
    if (
      typeof event.inboundId !== "string" ||
      event.inboundId.length === 0 ||
      !["queued", "dispatched", "expired", "rejected"].includes(String(event.status)) ||
      typeof event.at !== "string" ||
      !Number.isFinite(Date.parse(event.at)) ||
      (event.status === "dispatched" && !validDispatch(event.dispatch))
    ) {
      throw new Error(`invalid external inbound transition at line ${lineNumber}`);
    }
    return event as unknown as TransitionEvent;
  }
  throw new Error(`unsupported external inbound event at line ${lineNumber}`);
}

/** Durable ingress ledger. Queued transport facts are deliberately separate from resident memory. */
export class ExternalInboundStore {
  readonly #journalPath: string;
  readonly #maxQueuedItems: number;
  readonly #maxAgeMs: number;
  readonly #now: () => number;
  readonly #items = new Map<string, ExternalInboundItem>();
  readonly #bySource = new Map<string, string>();
  #eventSequence = 0;
  #inboundSequence = 0;

  constructor(options: ExternalInboundStoreOptions) {
    assertPositiveInteger(options.maxQueuedItems, "maxQueuedItems");
    assertPositiveInteger(options.maxAgeMs, "maxAgeMs");
    this.#journalPath = options.journalPath;
    this.#maxQueuedItems = options.maxQueuedItems;
    this.#maxAgeMs = options.maxAgeMs;
    this.#now = options.now ?? Date.now;
    mkdirSync(dirname(this.#journalPath), { recursive: true });
    if (!existsSync(this.#journalPath)) return;
    const events = readFileSync(this.#journalPath, "utf8")
      .split("\n")
      .flatMap((line, index) => (line.trim().length === 0 ? [] : [parseEvent(line, index + 1)]));
    for (const event of events) {
      if (event.sequence !== this.#eventSequence + 1) {
        throw new Error(`external inbound journal sequence gap at ${event.sequence}`);
      }
      this.#eventSequence = event.sequence;
      this.#apply(event);
    }
  }

  receive(
    binding: ExternalChannelBinding,
    input: {
      externalMessageId: string;
      body: string;
      receivedAt?: string;
    },
    mode: "queue" | "dispatch",
  ): { readonly item: ExternalInboundItem; readonly duplicate: boolean } {
    if (input.externalMessageId.trim().length === 0) {
      throw new Error("externalMessageId must be a non-empty string");
    }
    if (typeof input.body !== "string") throw new Error("body must be a string");
    this.expire();
    const key = sourceKey(binding.bindingId, binding.address, input.externalMessageId);
    const existingId = this.#bySource.get(key);
    if (existingId !== undefined) {
      return {
        item: cloneItem(this.#items.get(existingId) as ExternalInboundItem),
        duplicate: true,
      };
    }

    const receivedMs = input.receivedAt === undefined ? this.#now() : Date.parse(input.receivedAt);
    if (!Number.isFinite(receivedMs)) throw new Error("receivedAt must be an ISO-8601 timestamp");
    const now = this.#now();
    const initialStatus: ExternalInboundStatus =
      mode === "queue" && receivedMs + this.#maxAgeMs <= now
        ? "expired"
        : mode === "queue" &&
            this.#queuedCount(binding.residentId, binding.scopeId) >= this.#maxQueuedItems
          ? "rejected"
          : mode === "queue"
            ? "queued"
            : "pending";
    this.#inboundSequence += 1;
    const item: ExternalInboundItem = {
      inboundId: `inbound-${this.#inboundSequence.toString(36).padStart(8, "0")}`,
      bindingId: binding.bindingId,
      residentId: binding.residentId,
      scopeId: binding.scopeId,
      address: { ...binding.address },
      externalMessageId: input.externalMessageId,
      body: input.body,
      receivedAt: new Date(receivedMs).toISOString(),
      queuedAt: new Date(now).toISOString(),
      expiresAt: new Date(receivedMs + this.#maxAgeMs).toISOString(),
      sequence: this.#inboundSequence,
      status: initialStatus,
      ...(initialStatus === "rejected" ? { reason: "QUEUE_FULL" as const } : {}),
      ...(initialStatus === "expired" ? { reason: "EXPIRED" as const } : {}),
    };
    const event: ReceivedEvent = {
      schemaVersion: 1,
      sequence: this.#eventSequence + 1,
      type: "received",
      item,
    };
    this.#append(event);
    this.#apply(event);
    this.#eventSequence = event.sequence;
    return { item: cloneItem(item), duplicate: false };
  }

  markDispatched(inboundId: string, dispatch: DispatchReceipt): ExternalInboundItem {
    const item = this.#require(inboundId);
    if (item.status === "dispatched") return cloneItem(item);
    if (item.status !== "queued" && item.status !== "pending") {
      throw new Error(`cannot dispatch inbound item in status ${item.status}`);
    }
    if (dispatch.residentId !== item.residentId || dispatch.scopeId !== item.scopeId) {
      throw new Error("dispatch identity does not match the inbound resident scope");
    }
    const event: TransitionEvent = {
      schemaVersion: 1,
      sequence: this.#eventSequence + 1,
      type: "transition",
      inboundId,
      status: "dispatched",
      at: new Date(this.#now()).toISOString(),
      dispatch: cloneDispatch(dispatch),
    };
    this.#append(event);
    this.#apply(event);
    this.#eventSequence = event.sequence;
    return cloneItem(this.#require(inboundId));
  }

  markQueued(inboundId: string): ExternalInboundItem {
    const item = this.#require(inboundId);
    if (item.status === "queued") return cloneItem(item);
    if (item.status !== "pending") throw new Error(`cannot queue inbound item in ${item.status}`);
    this.expire();
    const full = this.#queuedCount(item.residentId, item.scopeId) >= this.#maxQueuedItems;
    const expired = Date.parse(item.expiresAt) <= this.#now();
    const event: TransitionEvent = {
      schemaVersion: 1,
      sequence: this.#eventSequence + 1,
      type: "transition",
      inboundId,
      status: expired ? "expired" : full ? "rejected" : "queued",
      at: new Date(this.#now()).toISOString(),
      ...(expired ? { reason: "EXPIRED" as const } : {}),
      ...(full ? { reason: "QUEUE_FULL" as const } : {}),
    };
    this.#append(event);
    this.#apply(event);
    this.#eventSequence = event.sequence;
    return cloneItem(this.#require(inboundId));
  }

  expire(): void {
    const now = this.#now();
    for (const item of [...this.#items.values()].sort((a, b) => a.sequence - b.sequence)) {
      if (item.status !== "queued" || Date.parse(item.expiresAt) > now) continue;
      const event: TransitionEvent = {
        schemaVersion: 1,
        sequence: this.#eventSequence + 1,
        type: "transition",
        inboundId: item.inboundId,
        status: "expired",
        at: new Date(now).toISOString(),
        reason: "EXPIRED",
      };
      this.#append(event);
      this.#apply(event);
      this.#eventSequence = event.sequence;
    }
  }

  queued(residentId: string, scopeId: string): ExternalInboundItem[] {
    this.expire();
    return this.#ordered(residentId, scopeId)
      .filter((item) => item.status === "queued" || item.status === "pending")
      .map(cloneItem);
  }

  inspect(residentId: string, scopeId: string): ExternalInboundItem[] {
    this.expire();
    return this.#ordered(residentId, scopeId).map(cloneItem);
  }

  facts(residentId: string, scopeId: string): ExternalScopeFact[] {
    return this.#ordered(residentId, scopeId).flatMap((item) =>
      item.status === "dispatched" && item.dispatch !== undefined
        ? [
            {
              inboundId: item.inboundId,
              bindingId: item.bindingId,
              residentId: item.residentId,
              scopeId: item.scopeId,
              address: { ...item.address },
              externalMessageId: item.externalMessageId,
              body: item.body,
              receivedAt: item.receivedAt,
              dispatch: cloneDispatch(item.dispatch),
            },
          ]
        : [],
    );
  }

  get(inboundId: string): ExternalInboundItem | undefined {
    const item = this.#items.get(inboundId);
    return item === undefined ? undefined : cloneItem(item);
  }

  #ordered(residentId: string, scopeId: string): ExternalInboundItem[] {
    return [...this.#items.values()]
      .filter((item) => item.residentId === residentId && item.scopeId === scopeId)
      .sort((left, right) => left.sequence - right.sequence);
  }

  #queuedCount(residentId: string, scopeId: string): number {
    return this.#ordered(residentId, scopeId).filter((item) => item.status === "queued").length;
  }

  #require(inboundId: string): ExternalInboundItem {
    const item = this.#items.get(inboundId);
    if (item === undefined) throw new Error(`no external inbound item ${inboundId}`);
    return item;
  }

  #append(event: InboundJournalEvent): void {
    appendFileSync(this.#journalPath, `${JSON.stringify(event)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  #apply(event: InboundJournalEvent): void {
    if (event.type === "received") {
      const source = sourceKey(
        event.item.bindingId,
        event.item.address,
        event.item.externalMessageId,
      );
      const sequenceTaken = [...this.#items.values()].some(
        (item) => item.sequence === event.item.sequence,
      );
      if (this.#bySource.has(source) || this.#items.has(event.item.inboundId) || sequenceTaken) {
        throw new Error(`duplicate external inbound receipt at sequence ${event.sequence}`);
      }
      const item = cloneItem(event.item);
      this.#items.set(item.inboundId, item);
      this.#bySource.set(source, item.inboundId);
      this.#inboundSequence = Math.max(this.#inboundSequence, item.sequence);
      return;
    }
    const item = this.#require(event.inboundId);
    if (item.status === "dispatched" || item.status === "expired" || item.status === "rejected") {
      throw new Error(`terminal external inbound item transitioned at sequence ${event.sequence}`);
    }
    const validTransition =
      (item.status === "pending" &&
        ["queued", "dispatched", "expired", "rejected"].includes(event.status)) ||
      (item.status === "queued" && ["dispatched", "expired"].includes(event.status));
    if (!validTransition) {
      throw new Error(`invalid external inbound transition at sequence ${event.sequence}`);
    }
    Object.assign(item, {
      status: event.status,
      ...(event.reason === undefined ? {} : { reason: event.reason }),
      ...(event.dispatch === undefined ? {} : { dispatch: cloneDispatch(event.dispatch) }),
    });
  }
}
