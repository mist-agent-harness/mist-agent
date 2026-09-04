import { describe, expect, it } from "vitest";
import { MessageTreeService, MessageTreeStore } from "../src/message-tree/index.ts";
import {
  CanonicalStreamStore,
  CanonicalStreamWriter,
  EvidenceAuthority,
  EvidenceViewportReader,
  FirstPartyResidentView,
  MessageTreeViewportHistory,
  WorkspaceCapabilityError,
  WorkspaceLifecycleOwner,
} from "../src/one-stream/index.ts";
import { SessionRegistry } from "../src/session/session-registry.ts";

function assembly(checkpoint?: (name: "closure-delivered" | "workspace-archived") => void) {
  const store = new CanonicalStreamStore();
  store.createStream("resident-a");
  const writer = new CanonicalStreamWriter(store);
  const sessions = new SessionRegistry<null>();
  const lifecycle = new WorkspaceLifecycleOwner(writer, store, sessions, {
    authoritySource: { kind: "host", id: "mist-host" },
    ...(checkpoint === undefined ? {} : { checkpoint }),
  });
  const tree = new MessageTreeStore();
  tree.createRoom("resident-a");
  const service = new MessageTreeService(
    tree,
    {
      getHead: (windowId) => sessions.getHead(windowId),
      setHead: (windowId, headId) => sessions.setHead(windowId, headId),
    },
    { assistantReply: (_residentId, message) => `reply:${message}` },
  );
  return { store, writer, sessions, lifecycle, tree, service };
}

describe("OS-03 workspace and evidence capability split", () => {
  it("shows only live workspaces to first party and reads an archived branch only by result pointer", async () => {
    const { store, writer, sessions, lifecycle, tree, service } = assembly();
    const first = lifecycle.create("resident-a", { context: null, scopeId: "private" });
    const second = lifecycle.create("resident-a", { context: null, scopeId: "project" });
    await service.say("resident-a", "first-window", first.handle.windowId);
    await service.say("resident-a", "second-window", second.handle.windowId);

    const firstParty = new FirstPartyResidentView(store, sessions);
    expect(firstParty.snapshot("resident-a").activeWorkspaces).toEqual([
      first.handle,
      second.handle,
    ]);
    expect(first.phase).toBe("workspace-created");
    expect(first).not.toHaveProperty("chat");
    expect(first).not.toHaveProperty("history");

    const closed = await lifecycle.close({
      residentId: "resident-a",
      windowId: first.handle.windowId,
      generation: first.handle.generation,
      workRef: "work-first",
      artifactRef: "evidence:first-window",
      idempotencyKey: "close-first",
      occurredAt: "2026-09-04T08:00:00.000Z",
      summary: "first workspace archived",
    });

    const visible = firstParty.snapshot("resident-a");
    expect(visible.activeWorkspaces).toEqual([second.handle]);
    expect(visible.activeWorkspaces).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ windowId: first.handle.windowId })]),
    );
    expect(visible).not.toHaveProperty("archivedWorkspaces");
    expect(visible).not.toHaveProperty("history");
    expect(
      visible.canonicalEvents.some(
        (event) => event.eventId === closed.effective.eventId && event.purpose === "result",
      ),
    ).toBe(true);

    const authority = new EvidenceAuthority();
    expect(
      () =>
        new EvidenceViewportReader(
          store,
          new MessageTreeViewportHistory(tree, sessions),
          authority,
          {
            principalId: "first-party-user",
            capability: "viewport-evidence:read",
          },
        ),
    ).toThrow(WorkspaceCapabilityError);

    const evidence = new EvidenceViewportReader(
      store,
      new MessageTreeViewportHistory(tree, sessions),
      authority,
      authority.issue("auditor-a"),
    );
    expect(
      evidence.read({ residentId: "resident-a", resultEventId: closed.effective.eventId }),
    ).toMatchObject({
      windowId: first.handle.windowId,
      generation: 1,
      artifactRef: "evidence:first-window",
      history: [
        { role: "user", content: "first-window" },
        { role: "assistant", content: "reply:first-window" },
      ],
    });
    expect(() =>
      evidence.read({ residentId: "resident-a", resultEventId: closed.requested.eventId }),
    ).toThrow(/not an authoritative closure pointer/);
    expect(() =>
      evidence.read({
        residentId: "resident-a",
        resultEventId: closed.effective.eventId,
        windowId: first.handle.windowId,
      } as never),
    ).toThrow(/only a canonical result pointer/);
    expect(evidence).not.toHaveProperty("write");
    expect(evidence).not.toHaveProperty("resume");
    await writer.close();
  });

  it("reconciles a crash after durable closure without hiding a live workspace first", async () => {
    let crash = true;
    const { store, writer, sessions, lifecycle } = assembly((name) => {
      if (crash && name === "closure-delivered") throw new Error("simulated crash");
    });
    const opened = lifecycle.create("resident-a", { context: null });
    const request = {
      residentId: "resident-a",
      windowId: opened.handle.windowId,
      generation: opened.handle.generation,
      workRef: "work-recovery",
      artifactRef: "evidence:recovery",
      idempotencyKey: "close-recovery",
      occurredAt: "2026-09-04T08:01:00.000Z",
      summary: "recover closure",
    } as const;

    await expect(lifecycle.close(request)).rejects.toThrow("simulated crash");
    expect(sessions.isActive(opened.handle.windowId)).toBe(true);
    expect(store.eventsAfter("resident-a", 0).map((event) => event.purpose)).toEqual(["closure"]);

    crash = false;
    const recovered = await lifecycle.reconcile("resident-a");
    expect(recovered).toHaveLength(1);
    expect(sessions.isArchived(opened.handle.windowId)).toBe(true);
    expect(store.eventsAfter("resident-a", 0).map((event) => event.purpose)).toEqual([
      "closure",
      "result",
    ]);
    expect(await lifecycle.reconcile("resident-a")).toEqual([]);
    await writer.close();
  });

  it("reconciles a crash after archive without creating a second result", async () => {
    let crash = true;
    const { store, writer, sessions, lifecycle } = assembly((name) => {
      if (crash && name === "workspace-archived") throw new Error("simulated post-archive crash");
    });
    const opened = lifecycle.create("resident-a", { context: null });
    const request = {
      residentId: "resident-a",
      windowId: opened.handle.windowId,
      generation: opened.handle.generation,
      workRef: "work-post-archive-recovery",
      artifactRef: "evidence:post-archive-recovery",
      idempotencyKey: "close-post-archive-recovery",
      occurredAt: "2026-09-04T08:02:00.000Z",
      summary: "recover result after archive",
    } as const;

    await expect(lifecycle.close(request)).rejects.toThrow("simulated post-archive crash");
    expect(sessions.isArchived(opened.handle.windowId)).toBe(true);
    expect(store.eventsAfter("resident-a", 0).map((event) => event.purpose)).toEqual(["closure"]);

    crash = false;
    expect(await lifecycle.reconcile("resident-a")).toHaveLength(1);
    expect(store.eventsAfter("resident-a", 0).map((event) => event.purpose)).toEqual([
      "closure",
      "result",
    ]);
    expect(await lifecycle.reconcile("resident-a")).toEqual([]);
    await writer.close();
  });
});
