import type { DeliveryReceipt, EventActor, EventViewport } from "./event-contract.ts";
import type { CanonicalStreamWriter } from "./writer.ts";

export type LifecycleFailureHandling =
  | { readonly kind: "automatic-retry" }
  | { readonly kind: "user-action"; readonly action: string };

export interface HostLifecycleFailureSubmission {
  readonly residentId: string;
  readonly idempotencyKey: string;
  readonly occurredAt: string;
  readonly action: "breath";
  readonly subject: EventViewport;
  readonly stage: string;
  readonly reason: string;
  readonly windowRecovered: boolean;
  readonly handling: LifecycleFailureHandling;
}

export interface HostLifecycleFailurePortOptions {
  /** Supplied by the host composition root; lifecycle subjects never report their own failure. */
  readonly authoritySource: EventActor;
}

export class HostLifecycleFailureError extends Error {
  readonly code = "HOST_LIFECYCLE_FAILURE_EVENT";
  constructor(message: string) {
    super(message);
    this.name = "HostLifecycleFailureError";
  }
}

const INPUT_KEYS = [
  "action",
  "handling",
  "idempotencyKey",
  "occurredAt",
  "reason",
  "residentId",
  "stage",
  "subject",
  "windowRecovered",
] as const;
const SUBJECT_KEYS = ["generation", "windowId"] as const;

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HostLifecycleFailureError(`${name} must be an object`);
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
    throw new HostLifecycleFailureError(`${name} has unexpected fields`);
  }
}

function nonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HostLifecycleFailureError(`${name} must be a non-empty string`);
  }
  return value;
}

function parseSubject(value: unknown): EventViewport {
  const subject = record(value, "subject");
  exactKeys(subject, SUBJECT_KEYS, "subject");
  const windowId = nonEmptyString(subject.windowId, "subject.windowId");
  if (!Number.isSafeInteger(subject.generation) || (subject.generation as number) < 1) {
    throw new HostLifecycleFailureError("subject.generation must be a positive integer");
  }
  return { windowId, generation: subject.generation as number };
}

function parseHandling(value: unknown): LifecycleFailureHandling {
  const handling = record(value, "handling");
  if (handling.kind === "automatic-retry") {
    exactKeys(handling, ["kind"], "handling");
    return { kind: "automatic-retry" };
  }
  if (handling.kind === "user-action") {
    exactKeys(handling, ["action", "kind"], "handling");
    return {
      kind: "user-action",
      action: nonEmptyString(handling.action, "handling.action"),
    };
  }
  throw new HostLifecycleFailureError("handling.kind is invalid");
}

function parseSubmission(value: unknown): HostLifecycleFailureSubmission {
  const input = record(value, "lifecycle failure submission");
  exactKeys(input, INPUT_KEYS, "lifecycle failure submission");
  if (input.action !== "breath") {
    throw new HostLifecycleFailureError("action must be breath");
  }
  const occurredAt = nonEmptyString(input.occurredAt, "occurredAt");
  if (!Number.isFinite(Date.parse(occurredAt))) {
    throw new HostLifecycleFailureError("occurredAt must be a parseable timestamp");
  }
  if (typeof input.windowRecovered !== "boolean") {
    throw new HostLifecycleFailureError("windowRecovered must be boolean");
  }
  return {
    residentId: nonEmptyString(input.residentId, "residentId"),
    idempotencyKey: nonEmptyString(input.idempotencyKey, "idempotencyKey"),
    occurredAt,
    action: "breath",
    subject: parseSubject(input.subject),
    stage: nonEmptyString(input.stage, "stage"),
    reason: nonEmptyString(input.reason, "reason"),
    windowRecovered: input.windowRecovered,
    handling: parseHandling(input.handling),
  };
}

/**
 * Host-only adapter for lifecycle failures entering the resident's canonical stream.
 *
 * The affected viewport is the subject, never the reporter. Retry and user-action semantics are
 * supplied explicitly by the host so an automatic retry cannot masquerade as a user blocker.
 */
export class HostLifecycleFailurePort {
  readonly #writer: CanonicalStreamWriter;
  readonly #authoritySource: EventActor;

  constructor(writer: CanonicalStreamWriter, options: HostLifecycleFailurePortOptions) {
    if (options.authoritySource.kind !== "host") {
      throw new HostLifecycleFailureError("authoritySource must be a host actor");
    }
    this.#writer = writer;
    this.#authoritySource = Object.freeze(structuredClone(options.authoritySource));
  }

  submit(value: unknown): Promise<DeliveryReceipt> {
    const input = parseSubmission(value);
    const requiresUserAction = input.handling.kind === "user-action";
    const userAction = requiresUserAction ? input.handling.action : null;
    return this.#writer.submit({
      residentId: input.residentId,
      idempotencyKey: input.idempotencyKey,
      draft: {
        purpose: "lifecycle",
        occurredAt: input.occurredAt,
        workRef: null,
        authoritySource: this.#authoritySource,
        origin: {
          reporter: this.#authoritySource,
          subject: { kind: "viewport", id: input.subject.windowId },
          viewport: input.subject,
        },
        effect: {
          state: "failed-not-effective",
          requiresUserAction,
          retry: requiresUserAction ? "awaiting-external" : "automatic",
        },
        artifactRef: null,
        payload: {
          kind: "host-lifecycle-failed",
          action: input.action,
          stage: input.stage,
          reason: input.reason,
          windowRecovered: input.windowRecovered,
          userAction,
        },
      },
    });
  }
}
