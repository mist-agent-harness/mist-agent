import { randomUUID } from "node:crypto";
import type { RoomBindingGrant } from "./post-room-message.ts";
import { ResidentPrivateStore } from "./resident-private-store.ts";
import { ROOM_RECORDED_CLAIM, RoomEventStore } from "./room-event-store.ts";
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
    }
  }

  close(): void {
    this.#private.close();
    this.#events.close();
  }
}
