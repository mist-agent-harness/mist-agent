import type { MessageTreeService } from "../message-tree/service.ts";
import type { SessionRegistry } from "../session/session-registry.ts";
import type { CanonicalEvent, EventViewport } from "./event-contract.ts";
import type { CanonicalStreamReadPort } from "./store.ts";

export interface ReplyRouteRequest {
  readonly residentId: string;
  readonly text: string;
  readonly replyToEventId?: string;
  readonly workRef?: string;
}

export interface ReplyCandidate {
  readonly eventId: string;
  readonly workRef: string;
  readonly viewport: EventViewport;
}

export interface WorkspaceReplyDeliveryRequest extends ReplyCandidate {
  readonly residentId: string;
  readonly text: string;
}

export interface WorkspaceReplyDeliveryReceipt extends ReplyCandidate {
  readonly phase: "workspace-committed";
  readonly residentId: string;
  readonly assistantNodeId: string;
}

export interface WorkspaceReplyDeliveryPort {
  deliver(request: WorkspaceReplyDeliveryRequest): Promise<WorkspaceReplyDeliveryReceipt>;
}

export type ReplyRouteResult =
  | {
      readonly status: "routed";
      readonly receipt: WorkspaceReplyDeliveryReceipt;
    }
  | {
      readonly status: "no-target";
    }
  | {
      readonly status: "disambiguation-required";
      readonly candidates: readonly ReplyCandidate[];
    };

export type ReplyRouteErrorCode =
  | "REPLY_ROUTE_CONTRACT"
  | "REPLY_TARGET_UNKNOWN"
  | "REPLY_TARGET_STALE"
  | "REPLY_TARGET_AMBIGUOUS"
  | "REPLY_TARGET_INCONSISTENT"
  | "REPLY_TARGET_RESOLVED"
  | "REPLY_RECEIPT_MISMATCH";

export class ReplyRouteError extends Error {
  readonly code: ReplyRouteErrorCode;
  constructor(code: ReplyRouteErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "ReplyRouteError";
    this.code = code;
  }
}

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ReplyRouteError("REPLY_ROUTE_CONTRACT", `${name} must be a non-empty string`);
  }
  return value;
}

function parseRequest(value: unknown): ReplyRouteRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ReplyRouteError("REPLY_ROUTE_CONTRACT", "reply request must be an object");
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set(["residentId", "text", "replyToEventId", "workRef"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new ReplyRouteError("REPLY_ROUTE_CONTRACT", "reply request has unexpected fields");
  }
  const request: {
    residentId: string;
    text: string;
    replyToEventId?: string;
    workRef?: string;
  } = {
    residentId: nonEmpty(input.residentId, "residentId"),
    text: nonEmpty(input.text, "text"),
  };
  if (input.replyToEventId !== undefined) {
    request.replyToEventId = nonEmpty(input.replyToEventId, "replyToEventId");
  }
  if (input.workRef !== undefined) request.workRef = nonEmpty(input.workRef, "workRef");
  return request;
}

function candidate(event: CanonicalEvent): ReplyCandidate | null {
  if (
    event.purpose !== "blocked" ||
    event.effect.requiresUserAction !== true ||
    event.workRef === null ||
    event.origin.viewport === null
  ) {
    return null;
  }
  return {
    eventId: event.eventId,
    workRef: event.workRef,
    viewport: structuredClone(event.origin.viewport),
  };
}

/** Actual MessageTree dispatch adapter; the session head moves only after the pair lands. */
export class MessageTreeWorkspaceReplyDelivery implements WorkspaceReplyDeliveryPort {
  readonly #service: MessageTreeService;
  readonly #sessions: SessionRegistry<unknown>;

  constructor(service: MessageTreeService, sessions: SessionRegistry<unknown>) {
    this.#service = service;
    this.#sessions = sessions;
  }

  async deliver(request: WorkspaceReplyDeliveryRequest): Promise<WorkspaceReplyDeliveryReceipt> {
    const live = this.#sessions.get(request.viewport.windowId);
    if (
      live === undefined ||
      live.residentId !== request.residentId ||
      live.generation !== request.viewport.generation
    ) {
      throw new ReplyRouteError("REPLY_TARGET_STALE", "workspace changed before dispatch");
    }
    const assistant = await this.#service.say(
      request.residentId,
      request.text,
      request.viewport.windowId,
    );
    return Object.freeze({
      phase: "workspace-committed",
      residentId: request.residentId,
      eventId: request.eventId,
      workRef: request.workRef,
      viewport: structuredClone(request.viewport),
      assistantNodeId: assistant.id,
    });
  }
}

/**
 * Routes only from unresolved canonical blocked events to the exact live workspace generation.
 * Recency, focus, creation time, and model guesses are absent from both the constructor and input.
 */
export class BlockedReplyRouter {
  readonly #stream: CanonicalStreamReadPort;
  readonly #sessions: SessionRegistry<unknown>;
  readonly #delivery: WorkspaceReplyDeliveryPort;
  readonly #resolved = new Set<string>();

  constructor(
    stream: CanonicalStreamReadPort,
    sessions: SessionRegistry<unknown>,
    delivery: WorkspaceReplyDeliveryPort,
  ) {
    this.#stream = stream;
    this.#sessions = sessions;
    this.#delivery = delivery;
  }

  async route(value: unknown): Promise<ReplyRouteResult> {
    const request = parseRequest(value);
    const events = this.#stream.eventsAfter(request.residentId, 0);
    const all = events.map(candidate).filter((item): item is ReplyCandidate => item !== null);
    const unresolved = all.filter(
      (item) => !this.#resolved.has(this.#resolutionKey(request.residentId, item.eventId)),
    );
    const live = unresolved.filter((item) => this.#isLive(request.residentId, item));
    const selected = this.#select(request, all, unresolved, live);
    if (selected.status !== "selected") return selected.result;

    const receipt = await this.#delivery.deliver({
      ...selected.candidate,
      residentId: request.residentId,
      text: request.text,
    });
    if (
      receipt.phase !== "workspace-committed" ||
      receipt.residentId !== request.residentId ||
      receipt.eventId !== selected.candidate.eventId ||
      receipt.workRef !== selected.candidate.workRef ||
      receipt.viewport.windowId !== selected.candidate.viewport.windowId ||
      receipt.viewport.generation !== selected.candidate.viewport.generation
    ) {
      throw new ReplyRouteError(
        "REPLY_RECEIPT_MISMATCH",
        "delivery receipt changed route identity",
      );
    }
    this.#resolved.add(this.#resolutionKey(request.residentId, selected.candidate.eventId));
    return { status: "routed", receipt };
  }

  #select(
    request: ReplyRouteRequest,
    all: readonly ReplyCandidate[],
    unresolved: readonly ReplyCandidate[],
    live: readonly ReplyCandidate[],
  ):
    | { readonly status: "selected"; readonly candidate: ReplyCandidate }
    | {
        readonly status: "result";
        readonly result: Exclude<ReplyRouteResult, { status: "routed" }>;
      } {
    if (request.replyToEventId !== undefined) {
      const any = all.find((item) => item.eventId === request.replyToEventId);
      if (any === undefined) {
        throw new ReplyRouteError("REPLY_TARGET_UNKNOWN", "replyToEventId does not name a blocker");
      }
      if (!unresolved.some((item) => item.eventId === any.eventId)) {
        throw new ReplyRouteError(
          "REPLY_TARGET_RESOLVED",
          "blocked event already received a reply",
        );
      }
      const active = live.find((item) => item.eventId === any.eventId);
      if (active === undefined) {
        throw new ReplyRouteError(
          "REPLY_TARGET_STALE",
          "blocked event no longer has its live workspace",
        );
      }
      if (request.workRef !== undefined && request.workRef !== active.workRef) {
        throw new ReplyRouteError(
          "REPLY_TARGET_INCONSISTENT",
          "replyToEventId and workRef name different targets",
        );
      }
      return { status: "selected", candidate: active };
    }

    if (request.workRef !== undefined) {
      const known = all.filter((item) => item.workRef === request.workRef);
      if (known.length === 0) {
        throw new ReplyRouteError("REPLY_TARGET_UNKNOWN", "workRef does not name a blocker");
      }
      const active = live.filter((item) => item.workRef === request.workRef);
      if (active.length === 0) {
        throw new ReplyRouteError("REPLY_TARGET_STALE", "workRef has no live unresolved blocker");
      }
      if (active.length > 1) {
        throw new ReplyRouteError("REPLY_TARGET_AMBIGUOUS", "workRef names more than one blocker");
      }
      return { status: "selected", candidate: active[0] as ReplyCandidate };
    }

    if (live.length === 0) return { status: "result", result: { status: "no-target" } };
    if (live.length > 1) {
      return {
        status: "result",
        result: {
          status: "disambiguation-required",
          candidates: Object.freeze(live.map((item) => structuredClone(item))),
        },
      };
    }
    return { status: "selected", candidate: live[0] as ReplyCandidate };
  }

  #isLive(residentId: string, item: ReplyCandidate): boolean {
    const window = this.#sessions.get(item.viewport.windowId);
    return (
      window !== undefined &&
      window.residentId === residentId &&
      window.generation === item.viewport.generation
    );
  }

  #resolutionKey(residentId: string, eventId: string): string {
    return `${residentId}\u0000${eventId}`;
  }
}
