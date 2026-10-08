import { createHash } from "node:crypto";
import {
  type AuthenticatedPrincipal,
  RoomAccessRegistry,
  type RoomBindingGrant,
  type RoomMessageEnvelope,
  type RoomPostResult,
  postRoomMessage,
} from "./post-room-message.ts";
import { ResidentPrivateStore } from "./resident-private-store.ts";
import { type DeliveryState, RoomEventStore } from "./room-event-store.ts";

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

  readSurface(roomId: string, viewerId: string) {
    const activeResident = this.#store.roster.isActiveMember(roomId, viewerId);
    const acceptedHuman =
      roomId === this.#scenarioRoomId && this.#scenarioHumanIds.includes(viewerId);
    if (!activeResident && !acceptedHuman) {
      return {
        body: "",
        visibleEventIds: [],
        candidates: [],
        count: 0,
        errorCode: "room_membership_required",
        receipt: null,
      };
    }
    const events = this.#store
      .readRoomEvents(roomId)
      .filter((event) => event.visibility === "public");
    return {
      body: events.map((event) => event.body).join("\n"),
      visibleEventIds: events.map((event) => event.id),
      candidates: [],
      count: events.length,
      errorCode: null,
      receipt: null,
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
