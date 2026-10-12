import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RoomMessageHost } from "../../src/group-chat/room-message-host.ts";

describe("RoomMessageHost", () => {
  const roots: string[] = [];
  const hosts: RoomMessageHost[] = [];

  afterEach(async () => {
    for (const host of hosts.splice(0)) host.close();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("requires a trusted setup grant instead of trusting the post's own binding", async () => {
    const root = await mkdtemp(join(tmpdir(), "mist-room-host-"));
    roots.push(root);
    const host = new RoomMessageHost(root);
    hosts.push(host);
    const envelope = {
      operationId: "without-grant",
      roomId: "room-a",
      principalId: "resident-a",
      visibility: "public" as const,
      binding: "caller-supplied-token",
      body: "hello",
    };

    expect(host.post({ principalId: "resident-a" }, envelope)).toMatchObject({
      status: "rejected",
      operationId: "without-grant",
      recipient: "sender",
      reasonCode: "room_binding_denied",
    });
    expect(host.readRoomEvents()).toEqual([]);
    expect(host.readSystemReceipts()).toEqual([]);
  });

  it("accepts a matching setup grant, then rejects that binding after grants are replaced", async () => {
    const root = await mkdtemp(join(tmpdir(), "mist-room-host-"));
    roots.push(root);
    const host = new RoomMessageHost(root);
    hosts.push(host);
    const principalId = "resident-a";
    const roomId = "room-a";
    const bindingId = "setup-issued-token";
    const envelope = {
      operationId: "with-grant",
      roomId,
      principalId,
      visibility: "public" as const,
      binding: bindingId,
      body: "hello",
    };

    host.replaceAcceptanceGrants([{ principalId, roomId, bindingId }], roomId, [principalId]);
    const accepted = host.post({ principalId }, envelope);
    expect(accepted.status).toBe("recorded");
    expect(host.readRoomEvents()).toHaveLength(1);
    expect(host.readSystemReceipts()).toHaveLength(1);

    host.replaceAcceptanceGrants([], roomId, [principalId]);
    expect(host.post({ principalId }, { ...envelope, operationId: "after-reset" })).toMatchObject({
      status: "rejected",
      reasonCode: "room_binding_denied",
    });
    expect(host.readRoomEvents()).toHaveLength(1);
    expect(host.readSystemReceipts()).toHaveLength(1);
  });

  it("rejects a conflicting replacement without discarding the previous host grant", async () => {
    const root = await mkdtemp(join(tmpdir(), "mist-room-host-"));
    roots.push(root);
    const host = new RoomMessageHost(root);
    hosts.push(host);
    const principalId = "resident-a";
    const roomId = "room-a";
    const oldBinding = "setup-issued-token";
    const oldEnvelope = {
      operationId: "original-binding-still-valid",
      roomId,
      principalId,
      visibility: "public" as const,
      binding: oldBinding,
      body: "hello",
    };

    host.replaceAcceptanceGrants([{ principalId, roomId, bindingId: oldBinding }], roomId, [
      principalId,
    ]);
    expect(() =>
      host.replaceAcceptanceGrants(
        [
          { principalId, roomId, bindingId: oldBinding },
          { principalId, roomId, bindingId: "replacement-token" },
        ],
        roomId,
        [principalId],
      ),
    ).toThrow(/cannot be rebound/);

    expect(host.post({ principalId }, oldEnvelope).status).toBe("recorded");
    expect(
      host.post(
        { principalId },
        { ...oldEnvelope, operationId: "rejected-new-binding", binding: "replacement-token" },
      ),
    ).toMatchObject({
      status: "rejected",
      recipient: "sender",
      reasonCode: "room_binding_denied",
    });
    expect(host.readRoomEvents()).toHaveLength(1);
    expect(host.readSystemReceipts()).toHaveLength(1);
  });

  async function makeHost(): Promise<RoomMessageHost> {
    const root = await mkdtemp(join(tmpdir(), "mist-room-host-"));
    roots.push(root);
    const host = new RoomMessageHost(root);
    hosts.push(host);
    return host;
  }

  it("audits refused room reads as not-found without revealing a hidden room", async () => {
    const host = await makeHost();
    host.replaceAcceptanceGrants(
      [{ principalId: "human-owner", roomId: "room-public", bindingId: "owner-binding" }],
      "room-public",
      ["resident-a", "resident-b"],
    );
    host.createRoom({
      operationId: "create-hidden",
      roomId: "room-hidden",
      visibility: "hidden",
      creatorId: "human-owner",
      openingBody: "TEST-HIDDEN-CANARY",
    });

    const hidden = host.openRoom("room-hidden", "resident-b");
    const missing = host.openRoom("room-never-created", "resident-b");
    host.openRoom("room-public", "human-owner");

    expect(hidden).toEqual(missing);
    expect(JSON.stringify(hidden)).not.toContain("TEST-HIDDEN-CANARY");
    expect(host.readSurface("room-hidden", "resident-b")).toEqual(hidden);
    expect(host.readAccessAudit()).toEqual({
      crossResidentPrivateReads: 0,
      unauthorizedReadResults: ["not-found", "not-found"],
    });
  });

  it("refuses another resident's scope through room membership and counts no read", async () => {
    const host = await makeHost();
    host.replaceAcceptanceGrants([], "room-public", ["resident-a", "resident-b"]);

    expect(host.attemptResidentScopeRead("room-public", "resident-b", "resident-a")).toBeNull();
    expect(host.attemptResidentScopeRead("room-public", "resident-a", "resident-a")).toBe("");
    expect(host.readAccessAudit()).toEqual({
      crossResidentPrivateReads: 0,
      unauthorizedReadResults: ["not-found"],
    });
  });

  it("rejects a recorded public operation replayed into another room", async () => {
    const host = await makeHost();
    const grant = { principalId: "human-owner", roomId: "room-public", bindingId: "owner-binding" };
    host.replaceAcceptanceGrants([grant], "room-public", ["resident-a"]);
    const envelope = {
      operationId: "public-once",
      roomId: "room-public",
      visibility: "public" as const,
      binding: "owner-binding",
      body: "TEST-REPLAY",
    };
    expect(host.post({ principalId: "human-owner" }, envelope).status).toBe("recorded");

    expect(
      host.post({ principalId: "human-owner" }, { ...envelope, roomId: "room-hidden" }),
    ).toMatchObject({ status: "conflict", reasonCode: "operation_id_conflict" });
    expect(host.readRoomEvents("room-hidden")).toEqual([]);
  });
});
