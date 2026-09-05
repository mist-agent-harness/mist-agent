import { createHash } from "node:crypto";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

export type CanonicalEventPurpose =
  | "message"
  | "progress"
  | "blocked"
  | "result"
  | "closure"
  | "lifecycle";

export type EffectState =
  | "not-applicable"
  | "attempted"
  | "rejected"
  | "failed-not-effective"
  | "committed-effective";

export type RetryState = "not-applicable" | "automatic" | "awaiting-external" | "none";

export type ActorKind = "resident" | "viewport" | "host" | "work" | "external";

export interface EventActor {
  readonly kind: ActorKind;
  readonly id: string;
}

export interface EventViewport {
  readonly windowId: string;
  readonly generation: number;
}

export interface EventOrigin {
  readonly reporter: EventActor;
  readonly subject: EventActor;
  readonly viewport: EventViewport | null;
}

export interface EventEffect {
  readonly state: EffectState;
  readonly requiresUserAction: boolean;
  readonly retry: RetryState;
}

/**
 * Low-level canonical draft. Viewports do not receive this port directly: later bounded adapters
 * decide which payload shapes each producer is allowed to submit. The core still validates the
 * authority envelope exactly so retries hash the complete semantics, not only display text.
 */
export interface CanonicalEventDraft {
  readonly purpose: CanonicalEventPurpose;
  readonly occurredAt: string;
  readonly workRef: string | null;
  readonly authoritySource: EventActor;
  readonly origin: EventOrigin;
  readonly effect: EventEffect;
  readonly artifactRef: string | null;
  readonly payload: JsonObject;
}

export interface CanonicalEvent extends CanonicalEventDraft {
  readonly schemaVersion: 1;
  readonly residentId: string;
  readonly eventId: string;
  readonly streamSeq: number;
  readonly payloadHash: string;
}

export interface DeliveryReceipt {
  readonly phase: "delivered";
  readonly residentId: string;
  readonly eventId: string;
  readonly streamSeq: number;
  readonly payloadHash: string;
}

const PURPOSES = new Set<CanonicalEventPurpose>([
  "message",
  "progress",
  "blocked",
  "result",
  "closure",
  "lifecycle",
]);
const EFFECT_STATES = new Set<EffectState>([
  "not-applicable",
  "attempted",
  "rejected",
  "failed-not-effective",
  "committed-effective",
]);
const RETRY_STATES = new Set<RetryState>([
  "not-applicable",
  "automatic",
  "awaiting-external",
  "none",
]);
const ACTOR_KINDS = new Set<ActorKind>(["resident", "viewport", "host", "work", "external"]);

const DRAFT_KEYS = [
  "artifactRef",
  "authoritySource",
  "effect",
  "occurredAt",
  "origin",
  "payload",
  "purpose",
  "workRef",
] as const;
const EVENT_KEYS = [
  ...DRAFT_KEYS,
  "eventId",
  "payloadHash",
  "residentId",
  "schemaVersion",
  "streamSeq",
].sort();

export class CanonicalEventContractError extends Error {
  readonly code = "CANONICAL_EVENT_CONTRACT";
  constructor(message: string) {
    super(message);
    this.name = "CanonicalEventContractError";
  }
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CanonicalEventContractError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  name: string,
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new CanonicalEventContractError(`${name} has unexpected fields`);
  }
}

function nonEmptyString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CanonicalEventContractError(`${name} must be a non-empty string`);
  }
}

function nullableString(value: unknown, name: string): asserts value is string | null {
  if (value === null) return;
  nonEmptyString(value, name);
}

function actor(value: unknown, name: string): asserts value is EventActor {
  const candidate = record(value, name);
  exactKeys(candidate, ["id", "kind"], name);
  if (typeof candidate.kind !== "string" || !ACTOR_KINDS.has(candidate.kind as ActorKind)) {
    throw new CanonicalEventContractError(`${name}.kind is invalid`);
  }
  nonEmptyString(candidate.id, `${name}.id`);
}

function viewport(value: unknown): asserts value is EventViewport | null {
  if (value === null) return;
  const candidate = record(value, "origin.viewport");
  exactKeys(candidate, ["generation", "windowId"], "origin.viewport");
  nonEmptyString(candidate.windowId, "origin.viewport.windowId");
  if (!Number.isSafeInteger(candidate.generation) || (candidate.generation as number) < 1) {
    throw new CanonicalEventContractError("origin.viewport.generation must be a positive integer");
  }
}

function origin(value: unknown): asserts value is EventOrigin {
  const candidate = record(value, "origin");
  exactKeys(candidate, ["reporter", "subject", "viewport"], "origin");
  actor(candidate.reporter, "origin.reporter");
  actor(candidate.subject, "origin.subject");
  viewport(candidate.viewport);
}

function effect(value: unknown): asserts value is EventEffect {
  const candidate = record(value, "effect");
  exactKeys(candidate, ["requiresUserAction", "retry", "state"], "effect");
  if (typeof candidate.state !== "string" || !EFFECT_STATES.has(candidate.state as EffectState)) {
    throw new CanonicalEventContractError("effect.state is invalid");
  }
  if (typeof candidate.requiresUserAction !== "boolean") {
    throw new CanonicalEventContractError("effect.requiresUserAction must be boolean");
  }
  if (typeof candidate.retry !== "string" || !RETRY_STATES.has(candidate.retry as RetryState)) {
    throw new CanonicalEventContractError("effect.retry is invalid");
  }
}

function json(
  value: unknown,
  name: string,
  ancestors: WeakSet<object>,
): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CanonicalEventContractError(`${name} contains a non-finite number`);
    }
    return;
  }
  if (typeof value !== "object") {
    throw new CanonicalEventContractError(`${name} is not JSON`);
  }
  if (ancestors.has(value)) {
    throw new CanonicalEventContractError(`${name} contains a cycle`);
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) json(item, `${name}[${index}]`, ancestors);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new CanonicalEventContractError(`${name} must contain only plain objects`);
    }
    for (const [key, item] of Object.entries(value)) json(item, `${name}.${key}`, ancestors);
  }
  ancestors.delete(value);
}

export function assertCanonicalEventDraft(value: unknown): asserts value is CanonicalEventDraft {
  const candidate = record(value, "draft");
  exactKeys(candidate, DRAFT_KEYS, "draft");
  if (
    typeof candidate.purpose !== "string" ||
    !PURPOSES.has(candidate.purpose as CanonicalEventPurpose)
  ) {
    throw new CanonicalEventContractError("draft.purpose is invalid");
  }
  nonEmptyString(candidate.occurredAt, "draft.occurredAt");
  if (!Number.isFinite(Date.parse(candidate.occurredAt))) {
    throw new CanonicalEventContractError("draft.occurredAt must be a parseable timestamp");
  }
  nullableString(candidate.workRef, "draft.workRef");
  actor(candidate.authoritySource, "draft.authoritySource");
  origin(candidate.origin);
  effect(candidate.effect);
  nullableString(candidate.artifactRef, "draft.artifactRef");
  const payload = record(candidate.payload, "draft.payload");
  json(payload, "draft.payload", new WeakSet());
}

export function assertCanonicalEvent(value: unknown): asserts value is CanonicalEvent {
  const candidate = record(value, "event");
  exactKeys(candidate, EVENT_KEYS, "event");
  if (candidate.schemaVersion !== 1) {
    throw new CanonicalEventContractError("event.schemaVersion is invalid");
  }
  nonEmptyString(candidate.residentId, "event.residentId");
  nonEmptyString(candidate.eventId, "event.eventId");
  if (!Number.isSafeInteger(candidate.streamSeq) || (candidate.streamSeq as number) < 1) {
    throw new CanonicalEventContractError("event.streamSeq must be a positive integer");
  }
  nonEmptyString(candidate.payloadHash, "event.payloadHash");
  const draft: Record<string, unknown> = {};
  for (const key of DRAFT_KEYS) draft[key] = candidate[key];
  assertCanonicalEventDraft(draft);
}

function stable(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stable(item)).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(value[key] as JsonValue)}`)
    .join(",")}}`;
}

export function stableJson(value: unknown): string {
  json(value, "value", new WeakSet());
  return stable(value as JsonValue);
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function normalizeDraft(value: unknown): CanonicalEventDraft {
  assertCanonicalEventDraft(value);
  return JSON.parse(stableJson(value)) as CanonicalEventDraft;
}

export function hashSubmission(residentId: string, draft: CanonicalEventDraft): string {
  nonEmptyString(residentId, "residentId");
  return sha256(stableJson({ draft, residentId }));
}

type EventWithoutHash = Omit<CanonicalEvent, "payloadHash">;

export function hashCanonicalEvent(event: EventWithoutHash): string {
  return sha256(stableJson(event));
}

export function buildCanonicalEvent(input: {
  residentId: string;
  eventId: string;
  streamSeq: number;
  draft: CanonicalEventDraft;
}): CanonicalEvent {
  nonEmptyString(input.residentId, "residentId");
  nonEmptyString(input.eventId, "eventId");
  if (!Number.isSafeInteger(input.streamSeq) || input.streamSeq < 1) {
    throw new CanonicalEventContractError("streamSeq must be a positive integer");
  }
  const unsigned: EventWithoutHash = {
    schemaVersion: 1,
    residentId: input.residentId,
    eventId: input.eventId,
    streamSeq: input.streamSeq,
    ...normalizeDraft(input.draft),
  };
  return { ...unsigned, payloadHash: hashCanonicalEvent(unsigned) };
}

export function verifyCanonicalEvent(event: CanonicalEvent): void {
  assertCanonicalEvent(event);
  const { payloadHash, ...unsigned } = event;
  if (hashCanonicalEvent(unsigned) !== payloadHash) {
    throw new CanonicalEventContractError(`payload hash mismatch for ${event.eventId}`);
  }
}

export function cloneEvent(event: CanonicalEvent): CanonicalEvent {
  return structuredClone(event);
}

export function cloneReceipt(receipt: DeliveryReceipt): DeliveryReceipt {
  return { ...receipt };
}
