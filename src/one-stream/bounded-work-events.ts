import type {
  DeliveryReceipt,
  EffectState,
  EventActor,
  EventEffect,
  EventViewport,
  RetryState,
} from "./event-contract.ts";
import type { CanonicalStreamWriter } from "./writer.ts";

export type WorkEventPurpose = "progress" | "blocked" | "result";

export interface BoundedWorkEventSubmission {
  readonly residentId: string;
  readonly idempotencyKey: string;
  readonly purpose: WorkEventPurpose;
  readonly occurredAt: string;
  readonly workRef: string;
  readonly artifactRef: string;
  readonly source: EventViewport;
  readonly effect: EventEffect;
  readonly summary: string;
}

export interface BoundedWorkEventPortOptions {
  /**
   * Supplied by the trusted host composition root, never by the viewport payload.
   * A source viewport proves provenance only; it does not appoint its own authority.
   */
  readonly authoritySource: EventActor;
}

export class BoundedWorkEventError extends Error {
  readonly code = "BOUNDED_WORK_EVENT";
  constructor(message: string) {
    super(message);
    this.name = "BoundedWorkEventError";
  }
}

const INPUT_KEYS = [
  "artifactRef",
  "effect",
  "idempotencyKey",
  "occurredAt",
  "purpose",
  "residentId",
  "source",
  "summary",
  "workRef",
] as const;
const SOURCE_KEYS = ["generation", "windowId"] as const;
const EFFECT_KEYS = ["requiresUserAction", "retry", "state"] as const;
const PURPOSES = new Set<WorkEventPurpose>(["progress", "blocked", "result"]);
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

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BoundedWorkEventError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  name: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new BoundedWorkEventError(`${name} has unexpected fields`);
  }
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BoundedWorkEventError(`${name} must be a non-empty string`);
  }
  return value;
}

function parseSource(value: unknown): EventViewport {
  const source = record(value, "source");
  exactKeys(source, SOURCE_KEYS, "source");
  const windowId = nonEmptyString(source.windowId, "source.windowId");
  if (!Number.isSafeInteger(source.generation) || (source.generation as number) < 1) {
    throw new BoundedWorkEventError("source.generation must be a positive integer");
  }
  return { windowId, generation: source.generation as number };
}

function parseEffect(value: unknown): EventEffect {
  const effect = record(value, "effect");
  exactKeys(effect, EFFECT_KEYS, "effect");
  if (typeof effect.state !== "string" || !EFFECT_STATES.has(effect.state as EffectState)) {
    throw new BoundedWorkEventError("effect.state is invalid");
  }
  if (typeof effect.retry !== "string" || !RETRY_STATES.has(effect.retry as RetryState)) {
    throw new BoundedWorkEventError("effect.retry is invalid");
  }
  if (typeof effect.requiresUserAction !== "boolean") {
    throw new BoundedWorkEventError("effect.requiresUserAction must be boolean");
  }
  return {
    state: effect.state as EffectState,
    retry: effect.retry as RetryState,
    requiresUserAction: effect.requiresUserAction,
  };
}

function parseSubmission(value: unknown): BoundedWorkEventSubmission {
  const input = record(value, "work event submission");
  exactKeys(input, INPUT_KEYS, "work event submission");
  if (typeof input.purpose !== "string" || !PURPOSES.has(input.purpose as WorkEventPurpose)) {
    throw new BoundedWorkEventError("purpose must be progress, blocked, or result");
  }
  const occurredAt = nonEmptyString(input.occurredAt, "occurredAt");
  if (!Number.isFinite(Date.parse(occurredAt))) {
    throw new BoundedWorkEventError("occurredAt must be a parseable timestamp");
  }
  return {
    residentId: nonEmptyString(input.residentId, "residentId"),
    idempotencyKey: nonEmptyString(input.idempotencyKey, "idempotencyKey"),
    purpose: input.purpose as WorkEventPurpose,
    occurredAt,
    workRef: nonEmptyString(input.workRef, "workRef"),
    artifactRef: nonEmptyString(input.artifactRef, "artifactRef"),
    source: parseSource(input.source),
    effect: parseEffect(input.effect),
    summary: nonEmptyString(input.summary, "summary"),
  };
}

/**
 * The only viewport-facing write port for progress, blocked, and result events.
 * It converts a closed envelope into the lower-level canonical draft. Local transcript,
 * message arrays, arbitrary context, and caller-selected authority have no input slot.
 */
export class BoundedWorkEventPort {
  readonly #writer: CanonicalStreamWriter;
  readonly #authoritySource: EventActor;

  constructor(writer: CanonicalStreamWriter, options: BoundedWorkEventPortOptions) {
    this.#writer = writer;
    // The canonical writer validates this actor together with every completed draft. Keeping
    // it outside the viewport-facing submission is the authority boundary that matters here.
    this.#authoritySource = Object.freeze(structuredClone(options.authoritySource));
  }

  submit(value: unknown): Promise<DeliveryReceipt> {
    const input = parseSubmission(value);
    return this.#writer.submit({
      residentId: input.residentId,
      idempotencyKey: input.idempotencyKey,
      draft: {
        purpose: input.purpose,
        occurredAt: input.occurredAt,
        workRef: input.workRef,
        authoritySource: this.#authoritySource,
        origin: {
          reporter: { kind: "viewport", id: input.source.windowId },
          subject: { kind: "work", id: input.workRef },
          viewport: input.source,
        },
        effect: input.effect,
        artifactRef: input.artifactRef,
        payload: { summary: input.summary },
      },
    });
  }
}
