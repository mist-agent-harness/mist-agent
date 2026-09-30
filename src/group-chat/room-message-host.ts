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
import { type DeliveryState, ROOM_RECORDED_CLAIM, RoomEventStore } from "./room-event-store.ts";

/** Production composition: trusted grants arrive separately from untrusted post envelopes. */
export class RoomMessageHost {
  readonly #store: RoomEventStore;
  readonly #privateStore: ResidentPrivateStore;
  readonly #access = new RoomAccessRegistry();
  #scenarioRoomId: string | null = null;

  constructor(dataRoot: string) {
    this.#store = new RoomEventStore(dataRoot);
    this.#privateStore = new ResidentPrivateStore(dataRoot);
  }

  replaceBindingGrants(
    grants: readonly RoomBindingGrant[],
    roomId?: string,
    residentIds: readonly string[] = [],
  ): void {
    this.#access.replace(grants);
    if (roomId !== undefined) {
      this.#scenarioRoomId = roomId;
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

  seedResidentPrivate(residentId: string, canary: string): void {
    this.#privateStore.seedContext(residentId, canary);
  }

  readResidentContext(residentId: string): string {
    return this.#privateStore.readContext(residentId);
  }

  saveMemory(residentId: string, sourceEventId: string): void {
    const source = this.#store.readRoomEvents().find((event) => event.id === sourceEventId);
    if (source === undefined || source.visibility !== "public")
      throw new Error("memory source must be an existing public room event");
    this.#privateStore.saveMemory({
      residentId,
      sourceEventId: source.id,
      body: source.body,
    });
  }

  readMemories() {
    return this.#privateStore
      .readAllMemoriesForHostAudit()
      .map(({ residentId, sourceEventId, body }) => ({
        residentId,
        sourceEventId,
        body,
      }));
  }

  setDeliveryState(eventMarker: string, residentId: string, state: DeliveryState): void {
    const event = this.#store.findRoomEventByMarker(eventMarker, this.#scenarioRoomId ?? undefined);
    this.#store.setDeliveryState({
      eventId: event.id,
      residentId,
      operationId: stableOperationId("delivery", event.id, residentId, state),
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
    const projection = this.#store.roster.readRosterPath(path);
    if (!projection.residentIds.includes(residentId))
      throw new Error(`resident is absent from ${path} roster projection`);
  }

  readRoster() {
    return this.#store.roster.readRoster();
  }

  readRosterPath(path: "broadcast" | "mention" | "projection" | "feedback" | "status") {
    return this.#store.roster.readRosterPath(path);
  }

  recordEvent(roomId: string, authorId: string, body: string): void {
    this.#store.append({
      operationId: stableOperationId("record", roomId, authorId, body),
      roomId,
      principalId: authorId,
      authorId,
      body,
      visibility: "public",
      requestSemantics: JSON.stringify({ roomId, authorId, body, visibility: "public" }),
      recordedClaim: ROOM_RECORDED_CLAIM,
    });
  }

  dispatchEvent(eventMarker: string): void {
    const event = this.#store.findRoomEventByMarker(eventMarker, this.#scenarioRoomId ?? undefined);
    this.#store.dispatchEvent(event.id, this.#store.roster.activeResidentIds(event.roomId));
  }

  commitContext(residentId: string, marker: string): void {
    const dispatched = this.#store.latestDispatchedEvent(this.#requireScenarioRoom());
    if (dispatched === null)
      throw new Error("no dispatched room event is available for context commit");
    this.#store.commitContext({ roomEventId: dispatched.id, residentId, marker });
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

  readSurface(roomId: string, _viewerId: string) {
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
