import type {
  LetterItem,
  LetterTier,
  SealedIntentItem,
  SealedLetter,
} from "../session/handover-letter.ts";
import {
  type CanonicalEvent,
  type DeliveryReceipt,
  type EventActor,
  type JsonObject,
  stableJson,
  verifyCanonicalEvent,
} from "./event-contract.ts";
import { type CanonicalStreamReadPort, StreamNotFoundError } from "./store.ts";
import type { CanonicalStreamWriter } from "./writer.ts";

const PAYLOAD_KIND = "handover-letter" as const;
const LETTER_KEYS = [
  "generation",
  "intent",
  "residentId",
  "sealedAt",
  "state",
  "title",
  "windowId",
] as const;
const TIERS = new Set<LetterTier>(["commitment", "fact", "judgment"]);

export interface HandoverLetterAnchor {
  readonly residentId: string;
  readonly windowId: string;
  readonly generation: number;
  readonly title: string;
}

export type HandoverLetterRecall =
  | {
      readonly kind: "found";
      readonly anchor: HandoverLetterAnchor;
      readonly eventId: string;
      readonly streamSeq: number;
      readonly letter: SealedLetter;
    }
  | {
      readonly kind: "not-found";
      readonly anchor: HandoverLetterAnchor;
    }
  | {
      readonly kind: "unavailable";
      readonly anchor: HandoverLetterAnchor;
      readonly reason: "canonical-stream-not-found";
    };

export interface CanonicalHandoverTimelineOptions {
  /** Host composition supplies authority; the resident remains the letter's reporter. */
  readonly authoritySource: EventActor;
}

export class HandoverTimelineError extends Error {
  readonly code = "HANDOVER_TIMELINE";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "HandoverTimelineError";
  }
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HandoverTimelineError(`${name} must be an object`);
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
    throw new HandoverTimelineError(`${name} has unexpected fields`);
  }
}

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HandoverTimelineError(`${name} must be a non-empty string`);
  }
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new HandoverTimelineError(`${name} must be a positive integer`);
  }
  return value as number;
}

function timestamp(value: unknown, name: string): string {
  const parsed = nonEmpty(value, name);
  if (!Number.isFinite(Date.parse(parsed))) {
    throw new HandoverTimelineError(`${name} must be a parseable timestamp`);
  }
  return parsed;
}

function parseItem(value: unknown, name: string, intent: boolean): LetterItem | SealedIntentItem {
  const item = object(value, name);
  const tier = nonEmpty(item.tier, `${name}.tier`) as LetterTier;
  if (!TIERS.has(tier)) throw new HandoverTimelineError(`${name}.tier is invalid`);
  const expected = ["body", "tier"];
  if (tier === "commitment") expected.push("ledgerSeq");
  if (intent) expected.push("author", "writtenAt");
  exactKeys(item, expected, name);

  const parsed: LetterItem = { tier, body: nonEmpty(item.body, `${name}.body`) };
  if (tier === "commitment") {
    parsed.ledgerSeq = positiveInteger(item.ledgerSeq, `${name}.ledgerSeq`);
  }
  if (!intent) return parsed;
  return {
    ...parsed,
    author: nonEmpty(item.author, `${name}.author`),
    writtenAt: timestamp(item.writtenAt, `${name}.writtenAt`),
  };
}

function parseLetter(value: unknown): SealedLetter {
  const letter = object(value, "handover letter");
  exactKeys(letter, LETTER_KEYS, "handover letter");
  const residentId = nonEmpty(letter.residentId, "letter.residentId");
  const windowId = nonEmpty(letter.windowId, "letter.windowId");
  const generation = positiveInteger(letter.generation, "letter.generation");
  const title = nonEmpty(letter.title, "letter.title");
  if (title !== title.trim()) throw new HandoverTimelineError("letter.title must be trimmed");
  const sealedAt = timestamp(letter.sealedAt, "letter.sealedAt");
  if (!Array.isArray(letter.state) || !Array.isArray(letter.intent)) {
    throw new HandoverTimelineError("letter state and intent must be arrays");
  }
  const state = letter.state.map((item, index) => parseItem(item, `letter.state[${index}]`, false));
  const intent = letter.intent.map((item, index) => {
    const parsed = parseItem(item, `letter.intent[${index}]`, true) as SealedIntentItem;
    if (parsed.author !== `${residentId}#${generation}`) {
      throw new HandoverTimelineError(
        `letter.intent[${index}].author does not match its generation`,
      );
    }
    if (parsed.writtenAt !== sealedAt) {
      throw new HandoverTimelineError(`letter.intent[${index}].writtenAt does not match sealedAt`);
    }
    return parsed;
  });
  return { title, state, intent, windowId, residentId, generation, sealedAt };
}

function artifactRef(windowId: string, generation: number): string {
  return `handover-letter:${windowId}:${generation}`;
}

function anchorOf(letter: SealedLetter): HandoverLetterAnchor {
  return {
    residentId: letter.residentId,
    windowId: letter.windowId,
    generation: letter.generation,
    title: letter.title,
  };
}

function parseAnchor(value: HandoverLetterAnchor): HandoverLetterAnchor {
  return {
    residentId: nonEmpty(value.residentId, "anchor.residentId"),
    windowId: nonEmpty(value.windowId, "anchor.windowId"),
    generation: positiveInteger(value.generation, "anchor.generation"),
    title: nonEmpty(value.title, "anchor.title").trim(),
  };
}

function letterFromEvent(event: CanonicalEvent): SealedLetter | null {
  verifyCanonicalEvent(event);
  if (event.payload.kind !== PAYLOAD_KIND) return null;
  exactKeys(event.payload as Record<string, unknown>, ["kind", "letter"], "handover payload");
  const letter = parseLetter(event.payload.letter);
  const viewport = event.origin.viewport;
  if (
    event.purpose !== "message" ||
    event.workRef !== null ||
    event.authoritySource.kind !== "host" ||
    event.origin.reporter.kind !== "resident" ||
    event.origin.reporter.id !== letter.residentId ||
    event.origin.subject.kind !== "viewport" ||
    event.origin.subject.id !== letter.windowId ||
    viewport === null ||
    viewport.windowId !== letter.windowId ||
    viewport.generation !== letter.generation ||
    event.effect.state !== "not-applicable" ||
    event.effect.requiresUserAction ||
    event.effect.retry !== "not-applicable" ||
    event.artifactRef !== artifactRef(letter.windowId, letter.generation) ||
    event.occurredAt !== letter.sealedAt
  ) {
    throw new HandoverTimelineError(
      `canonical handover envelope is inconsistent at ${event.eventId}`,
    );
  }
  return letter;
}

function comparable(letter: SealedLetter): unknown {
  return {
    residentId: letter.residentId,
    windowId: letter.windowId,
    generation: letter.generation,
    title: letter.title,
    state: letter.state,
    intent: letter.intent.map(({ writtenAt: _writtenAt, ...item }) => item),
  };
}

function sameAuthoredLetter(left: SealedLetter, right: SealedLetter): boolean {
  return stableJson(comparable(left)) === stableJson(comparable(right));
}

function receiptFor(event: CanonicalEvent): DeliveryReceipt {
  return {
    phase: "delivered",
    residentId: event.residentId,
    eventId: event.eventId,
    streamSeq: event.streamSeq,
    payloadHash: event.payloadHash,
  };
}

/**
 * Host-owned handover port backed by the resident's one canonical stream.
 *
 * A window generation gets exactly one letter event. Recall always includes the title together
 * with windowId and generation, so equal titles in another window or generation cannot bleed in.
 */
export class CanonicalHandoverTimeline {
  readonly #writer: CanonicalStreamWriter;
  readonly #readPort: CanonicalStreamReadPort;
  readonly #authoritySource: EventActor;

  constructor(
    writer: CanonicalStreamWriter,
    readPort: CanonicalStreamReadPort,
    options: CanonicalHandoverTimelineOptions,
  ) {
    if (options.authoritySource.kind !== "host") {
      throw new HandoverTimelineError("authoritySource must be a host actor");
    }
    this.#writer = writer;
    this.#readPort = readPort;
    this.#authoritySource = Object.freeze(structuredClone(options.authoritySource));
  }

  async append(value: SealedLetter): Promise<DeliveryReceipt> {
    const letter = parseLetter(value);
    const canonicalLetter = JSON.parse(stableJson(letter)) as JsonObject;
    const existing = this.#eventAt(anchorOf(letter), true);
    if (existing !== null) return this.#recover(existing, letter);

    try {
      return await this.#writer.submit({
        residentId: letter.residentId,
        idempotencyKey: artifactRef(letter.windowId, letter.generation),
        draft: {
          purpose: "message",
          occurredAt: letter.sealedAt,
          workRef: null,
          authoritySource: this.#authoritySource,
          origin: {
            reporter: { kind: "resident", id: letter.residentId },
            subject: { kind: "viewport", id: letter.windowId },
            viewport: { windowId: letter.windowId, generation: letter.generation },
          },
          effect: {
            state: "not-applicable",
            requiresUserAction: false,
            retry: "not-applicable",
          },
          artifactRef: artifactRef(letter.windowId, letter.generation),
          payload: { kind: PAYLOAD_KIND, letter: canonicalLetter },
        },
      });
    } catch (error) {
      // The writer can die after the durable rename and before its receipt reaches this caller.
      // Re-read the one stream: a matching event is the receipt; absence preserves the real error.
      const committed = this.#eventAt(anchorOf(letter), true);
      if (committed !== null) return this.#recover(committed, letter);
      throw error;
    }
  }

  recall(value: HandoverLetterAnchor): HandoverLetterRecall {
    const anchor = parseAnchor(value);
    let event: CanonicalEvent | null;
    try {
      event = this.#eventAt(anchor);
    } catch (error) {
      if (error instanceof StreamNotFoundError) {
        return { kind: "unavailable", anchor, reason: "canonical-stream-not-found" };
      }
      throw error;
    }
    if (event === null) return { kind: "not-found", anchor };
    const letter = letterFromEvent(event);
    if (letter === null || letter.title !== anchor.title) return { kind: "not-found", anchor };
    return {
      kind: "found",
      anchor,
      eventId: event.eventId,
      streamSeq: event.streamSeq,
      letter: structuredClone(letter),
    };
  }

  #events(residentId: string): CanonicalEvent[] {
    try {
      return this.#readPort.eventsAfter(residentId, 0);
    } catch (error) {
      if (error instanceof StreamNotFoundError) throw error;
      throw new HandoverTimelineError(`cannot read canonical timeline for ${residentId}`, {
        cause: error,
      });
    }
  }

  #eventAt(anchor: HandoverLetterAnchor, missingIsEmpty = false): CanonicalEvent | null {
    let events: CanonicalEvent[];
    try {
      events = this.#events(anchor.residentId);
    } catch (error) {
      if (missingIsEmpty && error instanceof StreamNotFoundError) return null;
      throw error;
    }
    const matches = events.filter((event) => {
      const letter = letterFromEvent(event);
      return (
        letter !== null &&
        letter.windowId === anchor.windowId &&
        letter.generation === anchor.generation
      );
    });
    if (matches.length > 1) {
      throw new HandoverTimelineError(
        `multiple handover letters for ${anchor.residentId}/${anchor.windowId}#${anchor.generation}`,
      );
    }
    return matches[0] ?? null;
  }

  #recover(event: CanonicalEvent, attempted: SealedLetter): DeliveryReceipt {
    const committed = letterFromEvent(event);
    if (committed === null || !sameAuthoredLetter(committed, attempted)) {
      throw new HandoverTimelineError(
        `handover letter already exists with different content for ${attempted.windowId}#${attempted.generation}`,
      );
    }
    return receiptFor(event);
  }
}
