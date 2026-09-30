import { createHash } from "node:crypto";
import type {
  AuthenticatedPrincipal,
  RoomBindingGrant,
  RoomMessageEnvelope,
} from "./post-room-message.ts";
import { RoomMessageHost } from "./room-message-host.ts";

type HostRequestPayload =
  | {
      readonly kind: "reset";
      readonly grants: readonly RoomBindingGrant[];
      readonly roomId?: string;
      readonly residentIds?: readonly string[];
    }
  | {
      readonly kind: "post";
      readonly principal: AuthenticatedPrincipal | null;
      readonly envelope: RoomMessageEnvelope;
    }
  | { readonly kind: "read-room-events"; readonly roomId?: string }
  | { readonly kind: "read-system-receipts" }
  | { readonly kind: "seed-resident-private"; readonly residentId: string; readonly canary: string }
  | { readonly kind: "read-resident-context"; readonly residentId: string }
  | { readonly kind: "save-memory"; readonly residentId: string; readonly sourceEventId: string }
  | { readonly kind: "read-memories" }
  | {
      readonly kind: "set-delivery-state";
      readonly eventMarker: string;
      readonly residentId: string;
      readonly state: "loaded" | "queued" | "not-targeted";
    }
  | { readonly kind: "read-deliveries"; readonly eventId: string }
  | { readonly kind: "register-resident"; readonly residentId: string }
  | {
      readonly kind: "exercise-roster-path";
      readonly path: "broadcast" | "mention" | "projection" | "feedback" | "status";
      readonly residentId: string;
    }
  | { readonly kind: "read-roster" }
  | {
      readonly kind: "read-roster-path";
      readonly path: "broadcast" | "mention" | "projection" | "feedback" | "status";
    }
  | {
      readonly kind: "record-event";
      readonly roomId: string;
      readonly authorId: string;
      readonly body: string;
    }
  | { readonly kind: "dispatch-event"; readonly eventMarker: string }
  | { readonly kind: "commit-context"; readonly residentId: string; readonly marker: string }
  | { readonly kind: "read-context-commits" }
  | { readonly kind: "react"; readonly residentId: string; readonly eventMarker: string }
  | { readonly kind: "read-reactions" }
  | { readonly kind: "read-surface"; readonly roomId: string; readonly viewerId: string }
  | { readonly kind: "shutdown" };

type HostRequest = HostRequestPayload & {
  readonly id: string;
  readonly requestHash: string;
};

type HostResponse =
  | {
      readonly id: string;
      readonly ok: true;
      readonly value?: unknown;
      readonly hostPid: number;
      readonly requestHash: string;
    }
  | {
      readonly id: string;
      readonly ok: false;
      readonly error: string;
      readonly hostPid: number;
      readonly requestHash: string;
    };

const dataRoot = process.env.MIST_GROUP_CHAT_DATA_ROOT;
if (typeof dataRoot !== "string" || dataRoot.trim() === "")
  throw new Error("MIST_GROUP_CHAT_DATA_ROOT must be set by the host launcher");
if (typeof process.send !== "function")
  throw new Error("group-chat host must run with an IPC channel");

const host = new RoomMessageHost(dataRoot);

process.on("message", (message: unknown) => {
  void handleMessage(message);
});
process.on("disconnect", () => host.close());

process.send({ kind: "ready", pid: process.pid });

async function handleMessage(message: unknown): Promise<void> {
  if (!isHostRequest(message)) return;
  const requestHash = hashReceivedRequest(message);

  try {
    switch (message.kind) {
      case "reset":
        host.replaceBindingGrants(message.grants, message.roomId, message.residentIds);
        respond({ id: message.id, ok: true, hostPid: process.pid, requestHash });
        return;
      case "post":
        respond({
          id: message.id,
          ok: true,
          value: host.post(message.principal, message.envelope),
          hostPid: process.pid,
          requestHash,
        });
        return;
      case "read-room-events":
        respond({
          id: message.id,
          ok: true,
          value: host.readRoomEvents(message.roomId),
          hostPid: process.pid,
          requestHash,
        });
        return;
      case "read-system-receipts":
        respond({
          id: message.id,
          ok: true,
          value: host.readSystemReceipts(),
          hostPid: process.pid,
          requestHash,
        });
        return;
      case "seed-resident-private":
        host.seedResidentPrivate(message.residentId, message.canary);
        respond({ id: message.id, ok: true, hostPid: process.pid, requestHash });
        return;
      case "read-resident-context":
        respond({
          id: message.id,
          ok: true,
          value: host.readResidentContext(message.residentId),
          hostPid: process.pid,
          requestHash,
        });
        return;
      case "save-memory":
        host.saveMemory(message.residentId, message.sourceEventId);
        respond({ id: message.id, ok: true, hostPid: process.pid, requestHash });
        return;
      case "read-memories":
        respond({
          id: message.id,
          ok: true,
          value: host.readMemories(),
          hostPid: process.pid,
          requestHash,
        });
        return;
      case "set-delivery-state":
        host.setDeliveryState(message.eventMarker, message.residentId, message.state);
        respond({ id: message.id, ok: true, hostPid: process.pid, requestHash });
        return;
      case "read-deliveries":
        respond({
          id: message.id,
          ok: true,
          value: host.readDeliveries(message.eventId),
          hostPid: process.pid,
          requestHash,
        });
        return;
      case "register-resident":
        host.registerResident(message.residentId);
        respond({ id: message.id, ok: true, hostPid: process.pid, requestHash });
        return;
      case "exercise-roster-path":
        host.exerciseRosterPath(message.path, message.residentId);
        respond({ id: message.id, ok: true, hostPid: process.pid, requestHash });
        return;
      case "read-roster":
        respond({
          id: message.id,
          ok: true,
          value: host.readRoster(),
          hostPid: process.pid,
          requestHash,
        });
        return;
      case "read-roster-path":
        respond({
          id: message.id,
          ok: true,
          value: host.readRosterPath(message.path),
          hostPid: process.pid,
          requestHash,
        });
        return;
      case "record-event":
        host.recordEvent(message.roomId, message.authorId, message.body);
        respond({ id: message.id, ok: true, hostPid: process.pid, requestHash });
        return;
      case "dispatch-event":
        host.dispatchEvent(message.eventMarker);
        respond({ id: message.id, ok: true, hostPid: process.pid, requestHash });
        return;
      case "commit-context":
        host.commitContext(message.residentId, message.marker);
        respond({ id: message.id, ok: true, hostPid: process.pid, requestHash });
        return;
      case "read-context-commits":
        respond({
          id: message.id,
          ok: true,
          value: host.readContextCommits(),
          hostPid: process.pid,
          requestHash,
        });
        return;
      case "react":
        host.react(message.residentId, message.eventMarker);
        respond({ id: message.id, ok: true, hostPid: process.pid, requestHash });
        return;
      case "read-reactions":
        respond({
          id: message.id,
          ok: true,
          value: host.readReactions(),
          hostPid: process.pid,
          requestHash,
        });
        return;
      case "read-surface":
        respond({
          id: message.id,
          ok: true,
          value: host.readSurface(message.roomId, message.viewerId),
          hostPid: process.pid,
          requestHash,
        });
        return;
      case "shutdown":
        host.close();
        respond({ id: message.id, ok: true, hostPid: process.pid, requestHash }, () =>
          process.disconnect?.(),
        );
    }
  } catch (error) {
    respond({
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      hostPid: process.pid,
      requestHash,
    });
  }
}

function respond(response: HostResponse, afterSend?: () => void): void {
  process.send?.(response, () => afterSend?.());
}

function isHostRequest(value: unknown): value is HostRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "requestHash" in value &&
    typeof value.requestHash === "string"
  );
}

function hashReceivedRequest(message: HostRequest): string {
  const payload = Object.fromEntries(
    Object.entries(message).filter(([key]) => key !== "id" && key !== "requestHash"),
  );
  const serialized = JSON.stringify(payload);
  if (serialized === undefined) throw new Error("received group-chat request is not serializable");
  return createHash("sha256").update(serialized).digest("hex");
}
