import { createHash, randomUUID } from "node:crypto";
import type { RoomBindingGrant, RoomPostResult } from "./post-room-message.ts";
import { ResidentPrivateStore } from "./resident-private-store.ts";
import { ROOM_RECORDED_CLAIM, RoomEventStore, type RoomVisibility } from "./room-event-store.ts";
import type { RoomMessageHost } from "./room-message-host.ts";

export type GroupChatAcceptanceAdminCommand =
  | {
      readonly kind: "reset";
      readonly grants: readonly RoomBindingGrant[];
      readonly roomId: string;
      readonly residentIds: readonly string[];
    }
  | { readonly kind: "seed-resident-private"; readonly residentId: string; readonly canary: string }
  | { readonly kind: "read-memories" }
  | {
      readonly kind: "record-event";
      readonly roomId: string;
      readonly authorId: string;
      readonly body: string;
    }
  | {
      readonly kind: "create-room";
      readonly roomId: string;
      readonly visibility: RoomVisibility;
      readonly body: string;
      readonly creatorId: string;
    }
  | {
      /** Resubmit a recorded public operation, unchanged but for its room, through the write path. */
      readonly kind: "replay-public-payload";
      readonly sourceRoomId: string;
      readonly targetRoomId: string;
      readonly eventMarker: string;
    };

/** Test-only capabilities used by the acceptance runner, kept off the resident-facing host API. */
export class GroupChatAcceptanceAdmin {
  readonly #host: RoomMessageHost;
  readonly #events: RoomEventStore;
  readonly #private: ResidentPrivateStore;

  constructor(dataRoot: string, host: RoomMessageHost) {
    this.#host = host;
    this.#events = new RoomEventStore(dataRoot);
    this.#private = new ResidentPrivateStore(dataRoot);
  }

  run(command: GroupChatAcceptanceAdminCommand): unknown {
    switch (command.kind) {
      case "reset":
        this.#host.replaceAcceptanceGrants(command.grants, command.roomId, command.residentIds);
        return undefined;
      case "seed-resident-private":
        this.#private.seedContext(command.residentId, command.canary);
        return undefined;
      case "read-memories":
        return this.#private
          .readAllMemoriesForHostAudit()
          .map(({ residentId, sourceEventId, body }) => ({
            residentId,
            sourceEventId,
            body,
          }));
      case "record-event": {
        const operationId = `acceptance:${randomUUID()}`;
        this.#events.append({
          operationId,
          roomId: command.roomId,
          principalId: command.authorId,
          authorId: command.authorId,
          body: command.body,
          visibility: "public",
          requestSemantics: JSON.stringify({
            roomId: command.roomId,
            authorId: command.authorId,
            body: command.body,
            visibility: "public",
          }),
          recordedClaim: ROOM_RECORDED_CLAIM,
        });
        return undefined;
      }
      case "create-room":
        this.#host.createRoom({
          operationId: `acceptance-room:${createHash("sha256").update(command.roomId).digest("hex")}`,
          roomId: command.roomId,
          visibility: command.visibility,
          creatorId: command.creatorId,
          openingBody: command.body,
        });
        return undefined;
      case "replay-public-payload":
        return this.#replayPublicPayload(command);
    }
  }

  #replayPublicPayload(
    command: Extract<GroupChatAcceptanceAdminCommand, { readonly kind: "replay-public-payload" }>,
  ): RoomPostResult {
    const source = this.#events.findRoomEventByMarker(command.eventMarker, command.sourceRoomId);
    if (source.visibility !== "public") throw new Error("only a public event can be replayed");
    const operation = this.#events.readEventOperation(source.id);
    if (operation === null) throw new Error("replayed event has no recorded operation");
    const original = JSON.parse(operation.requestSemantics) as {
      readonly binding?: string | null;
      readonly body?: string;
      readonly mentions?: readonly string[] | null;
    };
    return this.#host.post(
      { principalId: operation.principalId },
      {
        operationId: operation.operationId,
        roomId: command.targetRoomId,
        visibility: "public",
        binding: original.binding ?? null,
        body: original.body ?? source.body,
        ...(original.mentions === null || original.mentions === undefined
          ? {}
          : { mentions: original.mentions }),
      },
    );
  }

  close(): void {
    this.#private.close();
    this.#events.close();
  }
}
