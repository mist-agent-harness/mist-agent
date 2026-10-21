import type { RoomAccessRegistry } from "./post-room-message.ts";
import type { RoomEvent, RoomEventStore, RoomVisibility } from "./room-event-store.ts";

/** The one code a refused room read returns, whether the room is hidden or does not exist. */
export const ROOM_NOT_FOUND = "room_not_found";

export interface RoomSurface {
  readonly body: string;
  readonly visibleEventIds: readonly string[];
  readonly candidates: readonly string[];
  readonly count: number;
  readonly errorCode: string | null;
  readonly receipt: string | null;
}

export type RoomReadDecision =
  | {
      readonly allowed: true;
      readonly visibility: RoomVisibility;
      /** Events at or below this ledger position stay out of the viewer's projection. */
      readonly historyFloor: number;
    }
  | {
      readonly allowed: false;
      /** For the access audit only; the requester always sees {@link ROOM_NOT_FOUND}. */
      readonly internalReason: RoomReadDenialReason;
    };

export type RoomReadDenialReason =
  | "unknown-room"
  | "hidden-room-non-member"
  | "inactive-resident"
  | "resident-not-member"
  | "principal-not-granted";

/**
 * The room authorization primitive: room registry + current membership + join watermark.
 * Registered residents are judged by their membership row alone; any other principal needs a
 * binding grant for exactly this room. A refusal carries no hint of whether the room exists.
 */
export function authorizeRoomRead(
  store: RoomEventStore,
  access: RoomAccessRegistry,
  roomId: string,
  viewerId: string,
): RoomReadDecision {
  const registration = store.readRoomRegistration(roomId);
  const visibility = registration?.visibility ?? "public";
  // A former member keeps that reason in the audit; anyone else outside a hidden room is a non-member.
  const deny = (reason: RoomReadDenialReason): RoomReadDecision => ({
    allowed: false,
    internalReason: !store.roomExists(roomId)
      ? "unknown-room"
      : visibility === "hidden" && reason !== "inactive-resident"
        ? "hidden-room-non-member"
        : reason,
  });

  if (store.roster.isRegisteredResident(viewerId)) {
    const membership = store.roster.readMembership(roomId, viewerId);
    if (membership === null) return deny("resident-not-member");
    if (!membership.active) return deny("inactive-resident");
    return {
      allowed: true,
      visibility,
      historyFloor: membership.historyGrant ? 0 : membership.joinWatermark,
    };
  }
  if (!access.grantsRoom(viewerId, roomId)) return deny("principal-not-granted");
  return { allowed: true, visibility, historyFloor: 0 };
}

/** What an authorized viewer sees: the room's own events after its history floor. */
export function projectRoomSurface(
  events: readonly RoomEvent[],
  decision: RoomReadDecision,
): RoomSurface {
  if (!decision.allowed) return roomNotFoundSurface();
  const shown = events.filter(
    (event) =>
      event.position > decision.historyFloor &&
      (event.visibility === "public" || decision.visibility === "hidden"),
  );
  return {
    body: shown.map((event) => event.body).join("\n"),
    visibleEventIds: shown.map((event) => event.id),
    candidates: [],
    count: shown.length,
    errorCode: null,
    receipt: null,
  };
}

export function roomNotFoundSurface(): RoomSurface {
  return {
    body: "",
    visibleEventIds: [],
    candidates: [],
    count: 0,
    errorCode: ROOM_NOT_FOUND,
    receipt: null,
  };
}
