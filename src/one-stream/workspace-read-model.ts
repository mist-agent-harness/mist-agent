import type { HistoryNode } from "../../acceptance/driver.ts";
import type { MessageTreeStore } from "../message-tree/store.ts";
import type { ActiveWindow, ArchivedWindow, SessionRegistry } from "../session/session-registry.ts";
import type { CanonicalEvent, DeliveryReceipt, EventActor } from "./event-contract.ts";
import type { CanonicalStreamReadPort } from "./store.ts";
import type { CanonicalStreamWriter } from "./writer.ts";

export interface WorkspaceHandle {
  readonly kind: "workspace";
  readonly windowId: string;
  readonly generation: number;
  readonly scopeId: string;
}

export interface WorkspaceCreatedReceipt {
  readonly phase: "workspace-created";
  readonly handle: WorkspaceHandle;
}

export interface CreateWorkspaceOptions<TContext> {
  readonly context: TContext;
  readonly scopeId?: string;
}

export interface FirstPartyResidentSnapshot {
  readonly residentId: string;
  readonly canonicalEvents: readonly CanonicalEvent[];
  readonly activeWorkspaces: readonly WorkspaceHandle[];
}

export interface EvidencePrincipal {
  readonly principalId: string;
  readonly capability: "viewport-evidence:read";
}

export interface EvidenceReadRequest {
  readonly residentId: string;
  readonly resultEventId: string;
}

export interface ViewportEvidenceBinding {
  readonly residentId: string;
  readonly windowId: string;
  readonly generation: number;
  readonly artifactRef: string;
}

export interface ViewportHistoryReadPort {
  read(binding: ViewportEvidenceBinding): readonly HistoryNode[];
}

export interface EvidenceViewportRecord extends ViewportEvidenceBinding {
  readonly resultEventId: string;
  readonly history: readonly HistoryNode[];
}

export interface CloseWorkspaceRequest {
  readonly residentId: string;
  readonly windowId: string;
  readonly generation: number;
  readonly workRef: string;
  readonly artifactRef: string;
  readonly idempotencyKey: string;
  readonly occurredAt: string;
  readonly summary: string;
}

export interface CloseWorkspaceReceipt {
  readonly requested: DeliveryReceipt;
  readonly effective: DeliveryReceipt;
  readonly archived: ArchivedWindow;
}

export interface WorkspaceLifecycleOptions {
  readonly authoritySource: EventActor;
  readonly checkpoint?: (name: "closure-delivered" | "workspace-archived") => void | Promise<void>;
}

export class WorkspaceCapabilityError extends Error {
  readonly code = "WORKSPACE_CAPABILITY";
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceCapabilityError";
  }
}

/** Host-side issuer. A matching string is not authority; the exact issued token is. */
export class EvidenceAuthority {
  readonly #issued = new WeakSet<object>();

  issue(principalId: string): EvidencePrincipal {
    const principal = Object.freeze({
      principalId: nonEmpty(principalId, "principalId"),
      capability: "viewport-evidence:read" as const,
    });
    this.#issued.add(principal);
    return principal;
  }

  assert(principal: EvidencePrincipal): void {
    if (typeof principal !== "object" || principal === null || !this.#issued.has(principal)) {
      throw new WorkspaceCapabilityError("host-issued evidence principal is required");
    }
  }
}

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new WorkspaceCapabilityError(`${name} must be a non-empty string`);
  }
  return value;
}

function handle<TContext>(window: ActiveWindow<TContext>): WorkspaceHandle {
  return Object.freeze({
    kind: "workspace",
    windowId: window.windowId,
    generation: window.generation,
    scopeId: window.scopeId,
  });
}

function closurePhase(event: CanonicalEvent): string | null {
  const phase = event.payload.phase;
  return typeof phase === "string" ? phase : null;
}

function closureEventId(event: CanonicalEvent): string | null {
  const value = event.payload.closureEventId;
  return typeof value === "string" ? value : null;
}

function operationId(event: CanonicalEvent): string | null {
  const value = event.payload.operationId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function sameActor(left: EventActor, right: EventActor): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function hostIssued(event: CanonicalEvent): boolean {
  return (
    event.authoritySource.kind === "host" &&
    event.origin.reporter.kind === "host" &&
    sameActor(event.authoritySource, event.origin.reporter)
  );
}

function viewportSubjectMatches(event: CanonicalEvent): boolean {
  return (
    event.origin.viewport !== null &&
    event.origin.subject.kind === "viewport" &&
    event.origin.subject.id === event.origin.viewport.windowId
  );
}

function authoritativeClosureRequest(event: CanonicalEvent): boolean {
  return (
    event.purpose === "closure" &&
    event.effect.state === "attempted" &&
    event.effect.requiresUserAction === false &&
    event.effect.retry === "automatic" &&
    closurePhase(event) === "requested" &&
    event.workRef !== null &&
    event.artifactRef !== null &&
    operationId(event) !== null &&
    hostIssued(event) &&
    viewportSubjectMatches(event)
  );
}

function authoritativeClosurePair(requested: CanonicalEvent, result: CanonicalEvent): boolean {
  return (
    authoritativeClosureRequest(requested) &&
    result.purpose === "result" &&
    result.effect.state === "committed-effective" &&
    result.effect.requiresUserAction === false &&
    result.effect.retry === "none" &&
    closurePhase(result) === "closed" &&
    closureEventId(result) === requested.eventId &&
    result.residentId === requested.residentId &&
    result.workRef === requested.workRef &&
    result.artifactRef === requested.artifactRef &&
    operationId(result) === operationId(requested) &&
    hostIssued(result) &&
    viewportSubjectMatches(result) &&
    sameActor(result.authoritySource, requested.authoritySource) &&
    result.origin.viewport?.windowId === requested.origin.viewport?.windowId &&
    result.origin.viewport?.generation === requested.origin.viewport?.generation
  );
}

function sameWindow(
  window: Pick<ActiveWindow<unknown> | ArchivedWindow, "residentId" | "windowId" | "generation">,
  event: CanonicalEvent,
): boolean {
  return (
    event.residentId === window.residentId &&
    event.origin.viewport?.windowId === window.windowId &&
    event.origin.viewport.generation === window.generation
  );
}

/**
 * P1-conformant user read model: one canonical stream plus live workspaces only.
 * It deliberately has no history, archive, resume, or write method.
 */
export class FirstPartyResidentView<TContext> {
  readonly #stream: CanonicalStreamReadPort;
  readonly #sessions: SessionRegistry<TContext>;

  constructor(stream: CanonicalStreamReadPort, sessions: SessionRegistry<TContext>) {
    this.#stream = stream;
    this.#sessions = sessions;
  }

  snapshot(residentId: string): FirstPartyResidentSnapshot {
    nonEmpty(residentId, "residentId");
    return Object.freeze({
      residentId,
      canonicalEvents: Object.freeze(this.#stream.eventsAfter(residentId, 0)),
      activeWorkspaces: Object.freeze(this.#sessions.windowsOf(residentId).map(handle)),
    });
  }
}

/**
 * Host-owned lifecycle coordinator. A durable closure request is written before the
 * workspace disappears; the effective result is written only after archive succeeds.
 * Reconciliation can finish either crash gap idempotently.
 */
export class WorkspaceLifecycleOwner<TContext> {
  readonly #writer: CanonicalStreamWriter;
  readonly #stream: CanonicalStreamReadPort;
  readonly #sessions: SessionRegistry<TContext>;
  readonly #authoritySource: EventActor;
  readonly #checkpoint:
    | ((name: "closure-delivered" | "workspace-archived") => void | Promise<void>)
    | undefined;

  constructor(
    writer: CanonicalStreamWriter,
    stream: CanonicalStreamReadPort,
    sessions: SessionRegistry<TContext>,
    options: WorkspaceLifecycleOptions,
  ) {
    this.#writer = writer;
    this.#stream = stream;
    this.#sessions = sessions;
    this.#authoritySource = structuredClone(options.authoritySource);
    this.#checkpoint = options.checkpoint;
  }

  create(residentId: string, options: CreateWorkspaceOptions<TContext>): WorkspaceCreatedReceipt {
    nonEmpty(residentId, "residentId");
    const keys = Object.keys(options).sort();
    if (
      keys.length < 1 ||
      keys.length > 2 ||
      keys[0] !== "context" ||
      (keys.length === 2 && keys[1] !== "scopeId")
    ) {
      throw new WorkspaceCapabilityError(
        "first-party workspace create accepts only context and optional scopeId",
      );
    }
    const window = this.#sessions.open(residentId, {
      context: options.context,
      ...(options.scopeId === undefined ? {} : { scopeId: options.scopeId }),
    });
    return Object.freeze({ phase: "workspace-created", handle: handle(window) });
  }

  async close(request: CloseWorkspaceRequest): Promise<CloseWorkspaceReceipt> {
    this.#assertRequest(request);
    const snapshot = this.#workspaceSnapshot(request);
    const requested = await this.#submitRequested(request, snapshot);
    await this.#checkpoint?.("closure-delivered");
    const archived = this.#archiveExact(request);
    await this.#checkpoint?.("workspace-archived");
    const effective = await this.#submitEffective(request, requested.eventId);
    return { requested, effective, archived };
  }

  async reconcile(residentId: string): Promise<CloseWorkspaceReceipt[]> {
    nonEmpty(residentId, "residentId");
    const events = this.#stream.eventsAfter(residentId, 0);
    const recovered: CloseWorkspaceReceipt[] = [];
    for (const event of events) {
      if (
        !authoritativeClosureRequest(event) ||
        events.some((candidate) => authoritativeClosurePair(event, candidate))
      ) {
        continue;
      }
      const summary = event.payload.summary;
      if (typeof summary !== "string") {
        throw new WorkspaceCapabilityError(`closure ${event.eventId} has no summary`);
      }
      const viewport = event.origin.viewport;
      if (viewport === null) {
        throw new WorkspaceCapabilityError(`closure ${event.eventId} has no viewport`);
      }
      const request: CloseWorkspaceRequest = {
        residentId,
        windowId: viewport.windowId,
        generation: viewport.generation,
        workRef: nonEmpty(event.workRef, "closure workRef"),
        artifactRef: nonEmpty(event.artifactRef, "closure artifactRef"),
        idempotencyKey: nonEmpty(event.payload.operationId, "closure operationId"),
        occurredAt: event.occurredAt,
        summary,
      };
      const archived = this.#archiveExact(request, event);
      const effective = await this.#submitEffective(request, event.eventId);
      recovered.push({
        requested: {
          phase: "delivered",
          residentId,
          eventId: event.eventId,
          streamSeq: event.streamSeq,
          payloadHash: event.payloadHash,
        },
        effective,
        archived,
      });
    }
    return recovered;
  }

  #assertRequest(request: CloseWorkspaceRequest): void {
    for (const [name, value] of Object.entries(request)) {
      if (name === "generation") continue;
      nonEmpty(value, name);
    }
    if (!Number.isSafeInteger(request.generation) || request.generation < 1) {
      throw new WorkspaceCapabilityError("generation must be a positive integer");
    }
    if (!Number.isFinite(Date.parse(request.occurredAt))) {
      throw new WorkspaceCapabilityError("occurredAt must be a parseable timestamp");
    }
    const live = this.#sessions.get(request.windowId);
    const archived = this.#sessions.getArchived(request.windowId);
    const current = live ?? archived;
    if (current === undefined || !sameWindow(current, this.#eventShape(request))) {
      throw new WorkspaceCapabilityError("workspace identity does not match the requested closure");
    }
  }

  #workspaceSnapshot(request: CloseWorkspaceRequest): ActiveWindow<TContext> | ArchivedWindow {
    const current =
      this.#sessions.get(request.windowId) ?? this.#sessions.getArchived(request.windowId);
    if (current === undefined || !sameWindow(current, this.#eventShape(request))) {
      throw new WorkspaceCapabilityError("workspace identity does not match the requested closure");
    }
    return current;
  }

  #eventShape(request: CloseWorkspaceRequest): CanonicalEvent {
    return {
      schemaVersion: 1,
      residentId: request.residentId,
      eventId: "validation-only",
      streamSeq: 1,
      payloadHash: "validation-only",
      purpose: "closure",
      occurredAt: request.occurredAt,
      workRef: request.workRef,
      authoritySource: this.#authoritySource,
      origin: {
        reporter: this.#authoritySource,
        subject: { kind: "viewport", id: request.windowId },
        viewport: { windowId: request.windowId, generation: request.generation },
      },
      effect: { state: "attempted", requiresUserAction: false, retry: "automatic" },
      artifactRef: request.artifactRef,
      payload: {},
    };
  }

  async #submitRequested(
    request: CloseWorkspaceRequest,
    snapshot: ActiveWindow<TContext> | ArchivedWindow,
  ): Promise<DeliveryReceipt> {
    return this.#writer.submit({
      residentId: request.residentId,
      idempotencyKey: `${request.idempotencyKey}:requested`,
      draft: {
        purpose: "closure",
        occurredAt: request.occurredAt,
        workRef: request.workRef,
        authoritySource: this.#authoritySource,
        origin: {
          reporter: this.#authoritySource,
          subject: { kind: "viewport", id: request.windowId },
          viewport: { windowId: request.windowId, generation: request.generation },
        },
        effect: { state: "attempted", requiresUserAction: false, retry: "automatic" },
        artifactRef: request.artifactRef,
        payload: {
          headId: snapshot.headId,
          operationId: request.idempotencyKey,
          phase: "requested",
          scopeId: snapshot.scopeId,
          summary: request.summary,
        },
      },
    });
  }

  #archiveExact(request: CloseWorkspaceRequest, closure?: CanonicalEvent): ArchivedWindow {
    const live = this.#sessions.get(request.windowId);
    if (live !== undefined && !sameWindow(live, this.#eventShape(request))) {
      throw new WorkspaceCapabilityError("refusing to archive a different workspace generation");
    }
    const archived = this.#sessions.kill(request.windowId);
    if (archived !== undefined) {
      if (!sameWindow(archived, this.#eventShape(request))) {
        throw new WorkspaceCapabilityError("closure points to a mismatched workspace");
      }
      return archived;
    }
    if (closure === undefined) {
      throw new WorkspaceCapabilityError("closure points to a missing workspace");
    }
    const scopeId = nonEmpty(closure.payload.scopeId, "closure scopeId");
    const rawHeadId = closure.payload.headId;
    if (rawHeadId !== null && (typeof rawHeadId !== "string" || rawHeadId.length === 0)) {
      throw new WorkspaceCapabilityError("closure headId must be null or a non-empty string");
    }
    return this.#sessions.recoverArchived({
      residentId: request.residentId,
      windowId: request.windowId,
      generation: request.generation,
      scopeId,
      headId: rawHeadId,
      archived: true,
    });
  }

  async #submitEffective(
    request: CloseWorkspaceRequest,
    requestedEventId: string,
  ): Promise<DeliveryReceipt> {
    return this.#writer.submit({
      residentId: request.residentId,
      idempotencyKey: `${request.idempotencyKey}:effective`,
      draft: {
        purpose: "result",
        occurredAt: request.occurredAt,
        workRef: request.workRef,
        authoritySource: this.#authoritySource,
        origin: {
          reporter: this.#authoritySource,
          subject: { kind: "viewport", id: request.windowId },
          viewport: { windowId: request.windowId, generation: request.generation },
        },
        effect: { state: "committed-effective", requiresUserAction: false, retry: "none" },
        artifactRef: request.artifactRef,
        payload: {
          closureEventId: requestedEventId,
          operationId: request.idempotencyKey,
          phase: "closed",
          summary: request.summary,
        },
      },
    });
  }
}

/** Read-only adapter that reconstructs exactly one archived viewport branch from MessageTree. */
export class MessageTreeViewportHistory implements ViewportHistoryReadPort {
  readonly #tree: MessageTreeStore;
  readonly #sessions: SessionRegistry<unknown>;

  constructor(tree: MessageTreeStore, sessions: SessionRegistry<unknown>) {
    this.#tree = tree;
    this.#sessions = sessions;
  }

  read(binding: ViewportEvidenceBinding): readonly HistoryNode[] {
    const archived = this.#sessions.getArchived(binding.windowId);
    if (
      archived === undefined ||
      archived.residentId !== binding.residentId ||
      archived.generation !== binding.generation
    ) {
      throw new WorkspaceCapabilityError("evidence pointer is not bound to this archived viewport");
    }
    if (archived.headId === null) return Object.freeze([]);
    const byId = new Map(this.#tree.history(binding.residentId).map((node) => [node.id, node]));
    const branch: HistoryNode[] = [];
    let cursor: string | null = archived.headId;
    const seen = new Set<string>();
    while (cursor !== null) {
      if (seen.has(cursor)) throw new WorkspaceCapabilityError("viewport history contains a cycle");
      seen.add(cursor);
      const node = byId.get(cursor);
      if (node === undefined)
        throw new WorkspaceCapabilityError("viewport head is missing from history");
      branch.push(structuredClone(node));
      cursor = node.parentId;
    }
    return Object.freeze(branch.reverse());
  }
}

/** Explicitly authorized evidence surface. It can read only through a canonical result pointer. */
export class EvidenceViewportReader {
  readonly #stream: CanonicalStreamReadPort;
  readonly #history: ViewportHistoryReadPort;

  constructor(
    stream: CanonicalStreamReadPort,
    history: ViewportHistoryReadPort,
    authority: EvidenceAuthority,
    principal: EvidencePrincipal,
  ) {
    authority.assert(principal);
    this.#stream = stream;
    this.#history = history;
  }

  read(request: EvidenceReadRequest): EvidenceViewportRecord {
    const keys = Object.keys(request).sort();
    if (keys.length !== 2 || keys[0] !== "residentId" || keys[1] !== "resultEventId") {
      throw new WorkspaceCapabilityError("evidence read accepts only a canonical result pointer");
    }
    nonEmpty(request.residentId, "residentId");
    nonEmpty(request.resultEventId, "resultEventId");
    const events = this.#stream.eventsAfter(request.residentId, 0);
    const event = events.find((candidate) => candidate.eventId === request.resultEventId);
    if (
      event === undefined ||
      event.purpose !== "result" ||
      event.effect.state !== "committed-effective" ||
      closurePhase(event) !== "closed" ||
      !hostIssued(event) ||
      !viewportSubjectMatches(event) ||
      event.origin.viewport === null ||
      event.artifactRef === null
    ) {
      throw new WorkspaceCapabilityError("result event is not an authoritative closure pointer");
    }
    const requestedEventId = closureEventId(event);
    const requested = events.find((candidate) => candidate.eventId === requestedEventId);
    if (requested === undefined || !authoritativeClosurePair(requested, event)) {
      throw new WorkspaceCapabilityError("result event does not bind to its closure request");
    }
    const binding: ViewportEvidenceBinding = {
      residentId: request.residentId,
      windowId: event.origin.viewport.windowId,
      generation: event.origin.viewport.generation,
      artifactRef: event.artifactRef,
    };
    return Object.freeze({
      ...binding,
      resultEventId: event.eventId,
      history: this.#history.read(binding),
    });
  }
}
