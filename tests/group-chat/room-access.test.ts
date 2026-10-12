import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RoomAccessRegistry } from "../../src/group-chat/post-room-message.ts";
import {
  ROOM_NOT_FOUND,
  authorizeRoomRead,
  projectRoomSurface,
  roomNotFoundSurface,
} from "../../src/group-chat/room-access.ts";
import { ROOM_RECORDED_CLAIM, RoomEventStore } from "../../src/group-chat/room-event-store.ts";

const roots: string[] = [];
const stores: RoomEventStore[] = [];

async function makeStore(): Promise<RoomEventStore> {
  const root = await mkdtemp(join(tmpdir(), "mist-room-access-"));
  roots.push(root);
  const store = new RoomEventStore(root);
  stores.push(store);
  return store;
}

function post(store: RoomEventStore, roomId: string, operationId: string, body: string) {
  return store.append({
    operationId,
    roomId,
    principalId: "human-owner",
    authorId: "human-owner",
    body,
    visibility: "public",
    requestSemantics: JSON.stringify({ operationId, roomId, body }),
    recordedClaim: ROOM_RECORDED_CLAIM,
  }).event;
}

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("authorizeRoomRead", () => {
  it("refuses a hidden room exactly as it refuses a room that does not exist", async () => {
    const withHidden = await makeStore();
    const withoutHidden = await makeStore();
    withHidden.createRoom({
      operationId: "create-hidden",
      roomId: "room-hidden",
      visibility: "hidden",
      creatorId: "human-owner",
      openingBody: "TEST-HIDDEN-CANARY",
    });
    for (const store of [withHidden, withoutHidden])
      store.roster.registerResident({
        operationId: "join-b",
        roomId: "room-public",
        residentId: "resident-b",
      });
    const access = new RoomAccessRegistry();

    const hidden = authorizeRoomRead(withHidden, access, "room-hidden", "resident-b");
    const missing = authorizeRoomRead(withoutHidden, access, "room-hidden", "resident-b");

    expect(hidden).toEqual({ allowed: false, internalReason: "hidden-room-non-member" });
    expect(missing).toEqual({ allowed: false, internalReason: "unknown-room" });
    expect(projectRoomSurface(withHidden.readRoomEvents("room-hidden"), hidden)).toEqual(
      projectRoomSurface(withoutHidden.readRoomEvents("room-hidden"), missing),
    );
    expect(projectRoomSurface([], hidden)).toEqual(roomNotFoundSurface());
    expect(roomNotFoundSurface().errorCode).toBe(ROOM_NOT_FOUND);
  });

  it("hides pre-join history from a newcomer without a history grant", async () => {
    const store = await makeStore();
    store.roster.registerResident({
      operationId: "join-a",
      roomId: "room-public",
      residentId: "resident-a",
    });
    const before = post(store, "room-public", "before", "TEST-BEFORE-JOIN");
    store.roster.registerResident({
      operationId: "join-c",
      roomId: "room-public",
      residentId: "resident-c",
    });
    const after = post(store, "room-public", "after", "TEST-AFTER-JOIN");
    const access = new RoomAccessRegistry();

    const newcomer = authorizeRoomRead(store, access, "room-public", "resident-c");
    const founder = authorizeRoomRead(store, access, "room-public", "resident-a");

    expect(newcomer).toEqual({ allowed: true, visibility: "public", historyFloor: 1 });
    expect(projectRoomSurface(store.readRoomEvents("room-public"), newcomer)).toEqual({
      body: "TEST-AFTER-JOIN",
      visibleEventIds: [after.id],
      candidates: [],
      count: 1,
      errorCode: null,
      receipt: null,
    });
    expect(
      projectRoomSurface(store.readRoomEvents("room-public"), founder).visibleEventIds,
    ).toEqual([before.id, after.id]);
  });

  it("judges registered residents by membership alone, never by a leftover binding", async () => {
    const store = await makeStore();
    store.roster.registerResident({
      operationId: "join-a",
      roomId: "room-public",
      residentId: "resident-a",
    });
    store.roster.mutateMembership({
      operationId: "leave-a",
      roomId: "room-public",
      residentId: "resident-a",
      active: false,
    });
    const access = new RoomAccessRegistry();
    access.register("resident-a", "room-public", "old-binding");
    access.register("resident-a", "room-other", "other-binding");

    post(store, "room-public", "later", "TEST-LATER");

    expect(authorizeRoomRead(store, access, "room-public", "resident-a")).toEqual({
      allowed: false,
      internalReason: "inactive-resident",
    });
    expect(authorizeRoomRead(store, access, "room-other", "resident-a")).toEqual({
      allowed: false,
      internalReason: "unknown-room",
    });
  });

  it("lets a granted non-resident read the whole room and nobody else", async () => {
    const store = await makeStore();
    store.createRoom({
      operationId: "create-public",
      roomId: "room-public",
      visibility: "public",
      creatorId: "human-owner",
      openingBody: "TEST-OPENING",
    });
    const access = new RoomAccessRegistry();
    access.register("human-owner", "room-public", "owner-binding");

    expect(authorizeRoomRead(store, access, "room-public", "human-owner")).toEqual({
      allowed: true,
      visibility: "public",
      historyFloor: 0,
    });
    expect(authorizeRoomRead(store, access, "room-public", "stranger")).toEqual({
      allowed: false,
      internalReason: "principal-not-granted",
    });
  });
});
