import { DispatchResultDroppedError, type MessageTreeService } from "../message-tree/service.ts";
import type { SessionRegistry } from "../session/session-registry.ts";
import type { CanonicalEvent, EventActor, EventViewport } from "./event-contract.ts";
import type { CanonicalStreamReadPort } from "./store.ts";
import type { CanonicalStreamWriter } from "./writer.ts";

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

export interface BlockedReplyResolutionPort {
  resolvedEventIds(residentId: string): ReadonlySet<string>;
  resolveAfterDelivery(
    candidate: WorkspaceReplyDeliveryRequest,
    deliver: () => Promise<WorkspaceReplyDeliveryReceipt>,
  ): Promise<WorkspaceReplyDeliveryReceipt>;
}

export interface CanonicalBlockedReplyResolutionOptions {
  /** Host-owned authority; callers replying to a blocker cannot self-appoint it. */
  readonly authoritySource: EventActor;
  readonly now?: () => string;
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

const resolutionQueues = new WeakMap<CanonicalStreamReadPort, Map<string, Promise<void>>>();

function resolutionTarget(event: CanonicalEvent): string | null {
  if (
    event.purpose !== "result" ||
    event.effect.state !== "committed-effective" ||
    event.authoritySource.kind !== "host" ||
    event.origin.reporter.kind !== "host" ||
    event.payload.kind !== "blocked-reply-resolved" ||
    typeof event.payload.replyToEventId !== "string" ||
    event.payload.replyToEventId.length === 0
  ) {
    return null;
  }
  return event.payload.replyToEventId;
}

/**
 * Writes the resolved receipt into the same canonical stream that supplied the blocker. The
 * per-stream queue covers concurrent router instances in one host process; rebuilding a router or
 * the port derives state from the durable event instead of process memory.
 */
export class CanonicalBlockedReplyResolutionPort implements BlockedReplyResolutionPort {
  readonly #stream: CanonicalStreamReadPort;
  readonly #writer: CanonicalStreamWriter;
  readonly #authoritySource: EventActor;
  readonly #now: () => string;

  constructor(
    stream: CanonicalStreamReadPort,
    writer: CanonicalStreamWriter,
    options: CanonicalBlockedReplyResolutionOptions,
  ) {
    this.#stream = stream;
    this.#writer = writer;
    this.#authoritySource = Object.freeze(structuredClone(options.authoritySource));
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  resolvedEventIds(residentId: string): ReadonlySet<string> {
    return new Set(
      this.#stream
        .eventsAfter(residentId, 0)
        .map(resolutionTarget)
        .filter((eventId): eventId is string => eventId !== null),
    );
  }

  resolveAfterDelivery(
    candidate: WorkspaceReplyDeliveryRequest,
    deliver: () => Promise<WorkspaceReplyDeliveryReceipt>,
  ): Promise<WorkspaceReplyDeliveryReceipt> {
    const key = `${candidate.residentId}\u0000${candidate.eventId}`;
    return this.#enqueue(key, async () => {
      if (this.resolvedEventIds(candidate.residentId).has(candidate.eventId)) {
        throw new ReplyRouteError(
          "REPLY_TARGET_RESOLVED",
          "blocked event already received a reply",
        );
      }
      const receipt = await deliver();
      await this.#writer.submit({
        residentId: candidate.residentId,
        idempotencyKey: `blocked-reply-resolved:${candidate.eventId}`,
        draft: {
          purpose: "result",
          occurredAt: this.#now(),
          workRef: candidate.workRef,
          authoritySource: this.#authoritySource,
          origin: {
            reporter: this.#authoritySource,
            subject: { kind: "work", id: candidate.workRef },
            viewport: structuredClone(candidate.viewport),
          },
          effect: {
            state: "committed-effective",
            requiresUserAction: false,
            retry: "none",
          },
          artifactRef: `message-tree-node:${receipt.assistantNodeId}`,
          payload: {
            kind: "blocked-reply-resolved",
            replyToEventId: candidate.eventId,
            assistantNodeId: receipt.assistantNodeId,
          },
        },
      });
      return receipt;
    });
  }

  #enqueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    let queues = resolutionQueues.get(this.#stream);
    if (queues === undefined) {
      queues = new Map();
      resolutionQueues.set(this.#stream, queues);
    }
    const previous = queues.get(key) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const marker = previous.then(
      () => gate,
      () => gate,
    );
    queues.set(key, marker);
    return previous.then(operation, operation).finally(() => {
      release();
      if (queues?.get(key) === marker) queues.delete(key);
    });
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
    const assertCurrentTarget = (): void => {
      const window = this.#sessions.get(request.viewport.windowId);
      if (
        window === undefined ||
        window.residentId !== request.residentId ||
        window.generation !== request.viewport.generation
      ) {
        throw new ReplyRouteError("REPLY_TARGET_STALE", "workspace changed before delivery");
      }
    };
    // Reject stale requests before say reads the head, including durable replays. Minting a
    // dispatch receipt belongs to the service's fresh responder path, never to this preflight.
    assertCurrentTarget();
    let dispatched = false;
    const assistant = await this.#service
      .say(request.residentId, request.text, request.viewport.windowId, {
        idempotencyKey: `blocked-reply-delivery:${request.eventId}`,
        dispatch: {
          issueDispatch: (windowId) => {
            assertCurrentTarget();
            const receipt = this.#sessions.issueDispatch(windowId);
            dispatched = true;
            return receipt;
          },
          belongsToActiveWindow: (receipt) => this.#sessions.belongsToActiveWindow(receipt),
        },
        commitBoundary: {
          commit: (mutation) => {
            // Fresh results are guarded and logged inside mutation by the service. A replay
            // has no dispatch receipt, so validate its target here before repairing the head.
            if (!dispatched) assertCurrentTarget();
            return mutation();
          },
        },
      })
      .catch((error: unknown) => {
        if (error instanceof DispatchResultDroppedError) {
          throw new ReplyRouteError(
            "REPLY_TARGET_STALE",
            "workspace changed while the reply was in flight",
          );
        }
        throw error;
      });
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
  readonly #resolutions: BlockedReplyResolutionPort;

  constructor(
    stream: CanonicalStreamReadPort,
    sessions: SessionRegistry<unknown>,
    delivery: WorkspaceReplyDeliveryPort,
    resolutions: BlockedReplyResolutionPort,
  ) {
    this.#stream = stream;
    this.#sessions = sessions;
    this.#delivery = delivery;
    this.#resolutions = resolutions;
  }

  async route(value: unknown): Promise<ReplyRouteResult> {
    const request = parseRequest(value);
    const events = this.#stream.eventsAfter(request.residentId, 0);
    const all = events.map(candidate).filter((item): item is ReplyCandidate => item !== null);
    const resolved = this.#resolutions.resolvedEventIds(request.residentId);
    const unresolved = all.filter((item) => !resolved.has(item.eventId));
    const live = unresolved.filter((item) => this.#isLive(request.residentId, item));
    const selected = this.#select(request, all, unresolved, live);
    if (selected.status !== "selected") return selected.result;

    const deliveryRequest = {
      ...selected.candidate,
      residentId: request.residentId,
      text: request.text,
    } satisfies WorkspaceReplyDeliveryRequest;
    const receipt = await this.#resolutions.resolveAfterDelivery(deliveryRequest, async () => {
      const delivered = await this.#delivery.deliver(deliveryRequest);
      if (
        delivered.phase !== "workspace-committed" ||
        delivered.residentId !== request.residentId ||
        delivered.eventId !== selected.candidate.eventId ||
        delivered.workRef !== selected.candidate.workRef ||
        delivered.viewport.windowId !== selected.candidate.viewport.windowId ||
        delivered.viewport.generation !== selected.candidate.viewport.generation
      ) {
        throw new ReplyRouteError(
          "REPLY_RECEIPT_MISMATCH",
          "delivery receipt changed route identity",
        );
      }
      return delivered;
    });
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
}
