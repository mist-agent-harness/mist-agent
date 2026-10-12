import {
  ROOM_RECORDED_CLAIM,
  type RoomEventStore,
  RoomOperationConflictError,
  type RoomRecordedReceipt,
} from "./room-event-store.ts";

export interface AuthenticatedPrincipal {
  /** Set only by the authenticated host entry, never from message body or display metadata. */
  readonly principalId: string;
}

export interface RoomMessageEnvelope {
  readonly operationId: string;
  readonly roomId?: string;
  readonly principalId?: string;
  readonly claimedAuthorId?: string;
  readonly visibility?: "public";
  readonly binding?: string | null;
  readonly body?: string;
  readonly mentions?: readonly string[];
  readonly privateFields?: unknown;
  readonly [key: string]: unknown;
}

export interface RoomBindingGrant {
  readonly principalId: string;
  readonly roomId: string;
  readonly bindingId: string;
}

export type RoomPostRejectionCode =
  | "authentication_required"
  | "operation_id_required"
  | "room_required"
  | "public_declaration_required"
  | "room_binding_denied"
  | "claimed_author_mismatch"
  | "private_fields_not_allowed"
  | "principal_mismatch"
  | "unexpected_field"
  | "body_invalid"
  | "mentions_invalid";

export type RoomPostResult =
  | {
      readonly status: "recorded";
      readonly operationId: string;
      readonly eventId: string;
      readonly roomId: string;
      readonly position: number;
      readonly receipt: RoomRecordedReceipt;
      readonly replayed: boolean;
    }
  | {
      readonly status: "rejected";
      readonly operationId: string;
      readonly recipient: "sender";
      readonly reasonCode: RoomPostRejectionCode;
    }
  | {
      readonly status: "conflict";
      readonly operationId: string;
      readonly recipient: "sender";
      readonly reasonCode: "operation_id_conflict";
    };

/** Exact (principal, room, binding) grants; a binding identifies eligibility, not identity. */
export class RoomAccessRegistry {
  readonly #bindings = new Map<string, string>();

  register(principalId: string, roomId: string, binding: string): void {
    if (!principalId.trim() || !roomId.trim() || !binding.trim())
      throw new TypeError("room membership requires a principal, room and binding");
    const key = membershipKey(principalId, roomId);
    const previous = this.#bindings.get(key);
    if (previous !== undefined && previous !== binding)
      throw new Error("a room membership cannot be rebound during the same scenario");
    this.#bindings.set(key, binding);
  }

  allows(principalId: string, roomId: string, binding: string): boolean {
    return this.#bindings.get(membershipKey(principalId, roomId)) === binding;
  }

  /** Whether the principal holds any binding for this exact room. */
  grantsRoom(principalId: string, roomId: string): boolean {
    return this.#bindings.has(membershipKey(principalId, roomId));
  }

  replace(grants: readonly RoomBindingGrant[]): void {
    const replacement = new Map<string, string>();
    for (const grant of grants) {
      if (!grant.principalId.trim() || !grant.roomId.trim() || !grant.bindingId.trim())
        throw new TypeError("room membership requires a principal, room and binding");
      const key = membershipKey(grant.principalId, grant.roomId);
      const previous = replacement.get(key);
      if (previous !== undefined && previous !== grant.bindingId)
        throw new Error("a room membership cannot be rebound during the same scenario");
      replacement.set(key, grant.bindingId);
    }

    this.#bindings.clear();
    for (const [key, binding] of replacement) this.#bindings.set(key, binding);
  }

  clear(): void {
    this.#bindings.clear();
  }
}

/**
 * The one public room write boundary. The adapter passes untrusted envelopes through unchanged;
 * identity, membership, privacy checks, append, and receipt creation happen here.
 */
export function postRoomMessage(
  auth: AuthenticatedPrincipal | null,
  envelope: RoomMessageEnvelope,
  access: RoomAccessRegistry,
  store: RoomEventStore,
): RoomPostResult {
  const operationId = typeof envelope.operationId === "string" ? envelope.operationId : "";

  if (auth === null || typeof auth.principalId !== "string" || auth.principalId.trim() === "")
    return rejected(operationId, "authentication_required");
  if (operationId.trim().length === 0) return rejected(operationId, "operation_id_required");
  if (Object.hasOwn(envelope, "principalId") && envelope.principalId !== auth.principalId)
    return rejected(operationId, "principal_mismatch");
  if (typeof envelope.roomId !== "string" || envelope.roomId.trim() === "")
    return rejected(operationId, "room_required");
  const roomId = envelope.roomId;
  if (envelope.visibility !== "public") return rejected(operationId, "public_declaration_required");
  if (Object.hasOwn(envelope, "claimedAuthorId") && envelope.claimedAuthorId !== auth.principalId)
    return rejected(operationId, "claimed_author_mismatch");
  if (Object.hasOwn(envelope, "privateFields"))
    return rejected(operationId, "private_fields_not_allowed");

  const allowedFields = new Set([
    "operationId",
    "roomId",
    "principalId",
    "claimedAuthorId",
    "visibility",
    "binding",
    "body",
    "mentions",
  ]);
  if (Object.keys(envelope).some((key) => !allowedFields.has(key)))
    return rejected(operationId, "unexpected_field");
  if (typeof envelope.body !== "string") return rejected(operationId, "body_invalid");
  if (
    Object.hasOwn(envelope, "mentions") &&
    (!Array.isArray(envelope.mentions) ||
      envelope.mentions.some((mention) => typeof mention !== "string"))
  ) {
    return rejected(operationId, "mentions_invalid");
  }

  const requestSemantics = JSON.stringify({
    principalId: auth.principalId,
    roomId: envelope.roomId,
    binding: envelope.binding,
    visibility: envelope.visibility,
    claimedAuthorId: envelope.claimedAuthorId ?? null,
    body: envelope.body,
    mentions: envelope.mentions ?? null,
  });

  try {
    const appended = store.appendIfNewAuthorized(
      {
        operationId,
        roomId,
        principalId: auth.principalId,
        authorId: auth.principalId,
        body: envelope.body,
        visibility: "public",
        mentions: envelope.mentions ?? [],
        requestSemantics,
        recordedClaim: ROOM_RECORDED_CLAIM,
      },
      () =>
        typeof envelope.binding === "string" &&
        envelope.binding.trim() !== "" &&
        access.allows(auth.principalId, roomId, envelope.binding),
    );
    if (appended === null) return rejected(operationId, "room_binding_denied");
    if (appended.receipt === null)
      throw new Error("durable room write did not create its system receipt");
    return {
      status: "recorded",
      operationId,
      eventId: appended.event.id,
      roomId: appended.event.roomId,
      position: appended.event.position,
      receipt: appended.receipt,
      replayed: appended.replayed,
    };
  } catch (error) {
    if (error instanceof RoomOperationConflictError)
      return {
        status: "conflict",
        operationId,
        recipient: "sender",
        reasonCode: "operation_id_conflict",
      };
    throw error;
  }
}

function rejected(operationId: string, reasonCode: RoomPostRejectionCode): RoomPostResult {
  return { status: "rejected", operationId, recipient: "sender", reasonCode };
}

function membershipKey(principalId: string, roomId: string): string {
  return `${principalId}\u0000${roomId}`;
}
