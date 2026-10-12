import { createHash } from "node:crypto";
import {
  type AuthenticatedPrincipal,
  RoomAccessRegistry,
  type RoomBindingGrant,
  type RoomMessageEnvelope,
  type RoomPostResult,
  postRoomMessage,
} from "./post-room-message.ts";
import { CrossResidentPrivateReadError, ResidentPrivateStore } from "./resident-private-store.ts";
import {
  type RoomReadDecision,
  type RoomSurface,
  authorizeRoomRead,
  projectRoomSurface,
  roomNotFoundSurface,
} from "./room-access.ts";
import {
  type DeliveryState,
  type RoomEventAppendResult,
  RoomEventStore,
  type RoomVisibility,
} from "./room-event-store.ts";

/** Approved audit readback: refusals as the requester saw them, and any cross-resident read. */
export interface RoomAccessAuditView {
  readonly crossResidentPrivateReads: number;
  readonly unauthorizedReadResults: readonly string[];
}

/** Production composition: trusted grants arrive separately from untrusted post envelopes. */
export class RoomMessageHost {
  readonly #store: RoomEventStore;
  readonly #privateStore: ResidentPrivateStore;
  readonly #access = new RoomAccessRegistry();
  #scenarioRoomId: string | null = null;
  #scenarioHumanIds: readonly string[] = [];

  constructor(dataRoot: string) {
    this.#store = new RoomEventStore(dataRoot);
    this.#privateStore = new ResidentPrivateStore(dataRoot);
  }

  replaceAcceptanceGrants(
    grants: readonly RoomBindingGrant[],
    roomId?: string,
    residentIds: readonly string[] = [],
  ): void {
    this.#access.replace(grants);
    if (roomId !== undefined) {
      this.#scenarioRoomId = roomId;
      const residentSet = new Set(residentIds);
      this.#scenarioHumanIds = [...new Set(grants.map((grant) => grant.principalId))]
        .filter((principalId) => !residentSet.has(principalId))
        .sort();
      this.#store.roster.synchronizeMemberships(roomId, residentIds);
    }
  }

  post(
    authenticatedPrincipal: AuthenticatedPrincipal | null,
    untrustedEnvelope: RoomMessageEnvelope,
  ): RoomPostResult {
    return postRoomMessage(authenticatedPrincipal, untrustedEnvelope, this.#access, this.#store);
  }

  readRoomEvents(roomId?: string) {
    return this.#store.readRoomEvents(roomId);
  }

  readSystemReceipts() {
    return this.#store.readSystemReceipts();
  }

  readResidentContext(residentId: string): string {
    return this.#privateStore.readContext(residentId, residentId);
  }

  saveMemory(residentId: string, sourceEventId: string): void {
    const source = this.#store.readRoomEvents().find((event) => event.id === sourceEventId);
    if (source === undefined || source.visibility !== "public")
      throw new Error("memory source must be an existing public room event");
    if (!this.#store.roster.isActiveMember(source.roomId, residentId))
      throw new Error("resident must be an active room member to save a room-event memory");
    this.#privateStore.saveMemory({
      residentId,
      sourceEventId: source.id,
      body: source.body,
    });
  }

  setDeliveryState(
    eventMarker: string,
    residentId: string,
    operationId: string,
    state: DeliveryState,
  ): void {
    const event = this.#store.findRoomEventByMarker(eventMarker, this.#scenarioRoomId ?? undefined);
    if (state !== "not-targeted" && !this.#store.roster.isActiveMember(event.roomId, residentId))
      throw new Error("delivery state requires an active member of the event room");
    this.#store.setDeliveryState({
      eventId: event.id,
      residentId,
      operationId,
      state,
    });
  }

  readDeliveries(eventId: string) {
    return this.#store
      .readDeliveries(eventId)
      .map(({ residentId, state }) => ({ residentId, state }));
  }

  registerResident(residentId: string): void {
    const roomId = this.#requireScenarioRoom();
    const version = this.#store.roster.readRoster().version;
    this.#store.roster.registerResident({
      operationId: stableOperationId("roster-register", roomId, residentId, String(version)),
      roomId,
      residentId,
    });
  }

  exerciseRosterPath(
    path: "broadcast" | "mention" | "projection" | "feedback" | "status",
    residentId: string,
  ): void {
    const projection = this.#store.roster.readRosterPath(path, this.#requireScenarioRoom());
    if (!projection.residentIds.includes(residentId))
      throw new Error(`resident is absent from ${path} roster projection`);
  }

  readRoster() {
    return this.#store.roster.readRoster();
  }

  readRosterPath(path: "broadcast" | "mention" | "projection" | "feedback" | "status") {
    return this.#store.roster.readRosterPath(
      path,
      this.#requireScenarioRoom(),
      this.#scenarioHumanIds,
    );
  }

  dispatchEvent(eventMarker: string): void {
    const event = this.#store.findRoomEventByMarker(eventMarker, this.#scenarioRoomId ?? undefined);
    const roster = this.#store.roster.readRoster();
    this.#store.dispatchEvent(
      event.id,
      this.#store.roster.activeResidentIds(event.roomId),
      roster.version,
    );
  }

  commitContext(residentId: string, marker: string): void {
    const roomId = this.#requireScenarioRoom();
    const roomEventIds = new Set(this.#store.readRoomEvents(roomId).map((event) => event.id));
    const prior = this.#store
      .readContextCommits()
      .filter(
        (commit) =>
          commit.residentId === residentId &&
          commit.marker === marker &&
          roomEventIds.has(commit.roomEventId),
      );
    if (prior.length > 1) throw new Error("context marker already refers to multiple room events");
    if (prior.length === 1) return;
    const candidates = this.#store.findContextCommitCandidates(roomId, residentId, marker);
    if (candidates.length !== 1)
      throw new Error(
        `context commit needs exactly one dispatched delivery; found ${candidates.length}`,
      );
    const roomEventId = candidates[0];
    if (roomEventId === undefined) throw new Error("context commit candidate disappeared");
    this.#store.commitContext({ roomEventId, residentId, marker });
  }

  readContextCommits() {
    return this.#store.readContextCommits().map(({ id, residentId, marker }) => ({
      id,
      residentId,
      marker,
    }));
  }

  react(residentId: string, eventMarker: string): void {
    const event = this.#store.findRoomEventByMarker(eventMarker, this.#scenarioRoomId ?? undefined);
    this.#store.recordReaction(residentId, event.id, eventMarker);
  }

  readReactions() {
    return this.#store.readReactions();
  }

  createRoom(input: {
    readonly operationId: string;
    readonly roomId: string;
    readonly visibility: RoomVisibility;
    readonly creatorId: string;
    readonly openingBody: string;
  }): RoomEventAppendResult {
    return this.#store.createRoom(input);
  }

  /** The viewer's projection of a room, unaudited; every refusal has the same not-found shape. */
  readSurface(roomId: string, viewerId: string): RoomSurface {
    return this.#surfaceFor(roomId, authorizeRoomRead(this.#store, this.#access, roomId, viewerId));
  }

  /** A principal opening a room: the same decision as {@link readSurface}, written to the audit. */
  openRoom(roomId: string, viewerId: string): RoomSurface {
    const decision = authorizeRoomRead(this.#store, this.#access, roomId, viewerId);
    this.#store.recordAccessAudit({
      kind: "room-read",
      viewerId,
      roomId,
      externalResult: decision.allowed ? "allowed" : "not-found",
      internalReason: decision.allowed ? "authorized" : decision.internalReason,
    });
    return this.#surfaceFor(roomId, decision);
  }

  /** A refusal never touches the room's ledger, so its cost says nothing about what the room holds. */
  #surfaceFor(roomId: string, decision: RoomReadDecision): RoomSurface {
    if (!decision.allowed) return roomNotFoundSurface();
    return projectRoomSurface(this.#store.readRoomEvents(roomId), decision);
  }

  /**
   * A room member asking for another resident's internal scope. Room membership grants nothing
   * here: the private store decides, and a refusal reads like a missing scope.
   */
  attemptResidentScopeRead(roomId: string, viewerId: string, ownerId: string): string | null {
    let context: string | null = null;
    let internalReason = "owner";
    try {
      context = this.#privateStore.readContext(viewerId, ownerId);
    } catch (error) {
      if (!(error instanceof CrossResidentPrivateReadError)) throw error;
      internalReason = "cross-resident-scope";
    }
    this.#store.recordAccessAudit({
      kind: "resident-scope-read",
      viewerId,
      roomId,
      ownerId,
      externalResult: context === null ? "not-found" : "allowed",
      internalReason,
    });
    return context;
  }

  readAccessAudit(): RoomAccessAuditView {
    const entries = this.#store.readAccessAudit();
    return {
      crossResidentPrivateReads: entries.filter(
        (entry) =>
          entry.kind === "resident-scope-read" &&
          entry.externalResult === "allowed" &&
          entry.viewerId !== entry.ownerId,
      ).length,
      unauthorizedReadResults: entries
        .filter((entry) => entry.externalResult !== "allowed")
        .map((entry) => entry.externalResult),
    };
  }

  #requireScenarioRoom(): string {
    if (this.#scenarioRoomId === null) throw new Error("group-chat scenario room has not been set");
    return this.#scenarioRoomId;
  }

  close(): void {
    this.#privateStore.close();
    this.#store.close();
  }
}

function stableOperationId(kind: string, ...parts: readonly string[]): string {
  const hash = createHash("sha256")
    .update(JSON.stringify([kind, ...parts]))
    .digest("hex");
  return `${kind}:${hash}`;
}
