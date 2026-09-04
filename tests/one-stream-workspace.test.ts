import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function assembly(
  options: {
    checkpoint?: (name: "closure-delivered" | "workspace-archived") => void;
    dataDir?: string;
    archivePath?: string;
  } = {},
) {
  const store = new CanonicalStreamStore(
    options.dataDir === undefined ? {} : { dataDir: options.dataDir },
  );
  store.createStream("resident-a");
  const writer = new CanonicalStreamWriter(store);
  const sessions = new SessionRegistry<null>(
    options.archivePath === undefined ? {} : { archivePath: options.archivePath },
  );
  const lifecycle = new WorkspaceLifecycleOwner(writer, store, sessions, {
    authoritySource: { kind: "host", id: "mist-host" },
    ...(options.checkpoint === undefined ? {} : { checkpoint: options.checkpoint }),
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
    const { store, writer, sessions, lifecycle } = assembly({
      checkpoint: (name) => {
        if (crash && name === "closure-delivered") throw new Error("simulated crash");
      },
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
    const { store, writer, sessions, lifecycle } = assembly({
      checkpoint: (name) => {
        if (crash && name === "workspace-archived") throw new Error("simulated post-archive crash");
      },
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

  it("reconciles a durable closure after stream and session registry restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "mist-workspace-recovery-"));
    const dataDir = join(root, "stream");
    const archivePath = join(root, "sessions", "archive.jsonl");
    try {
      const first = assembly({
        dataDir,
        archivePath,
        checkpoint: (name) => {
          if (name === "closure-delivered") throw new Error("simulated host death");
        },
      });
      const opened = first.lifecycle.create("resident-a", { context: null, scopeId: "project" });
      const reply = await first.service.say(
        "resident-a",
        "persist-this-head",
        opened.handle.windowId,
      );
      await expect(
        first.lifecycle.close({
          residentId: "resident-a",
          windowId: opened.handle.windowId,
          generation: opened.handle.generation,
          workRef: "work-restart",
          artifactRef: "evidence:restart",
          idempotencyKey: "close-restart",
          occurredAt: "2026-09-04T08:03:00.000Z",
          summary: "recover after a new host starts",
        }),
      ).rejects.toThrow("simulated host death");
      await first.writer.close();

      const restoredStore = new CanonicalStreamStore({ dataDir });
      const restoredWriter = new CanonicalStreamWriter(restoredStore);
      const restoredSessions = new SessionRegistry<null>({ archivePath });
      expect(restoredSessions.get(opened.handle.windowId)).toBeUndefined();
      expect(restoredSessions.getArchived(opened.handle.windowId)).toBeUndefined();
      const restoredLifecycle = new WorkspaceLifecycleOwner(
        restoredWriter,
        restoredStore,
        restoredSessions,
        { authoritySource: { kind: "host", id: "mist-host" } },
      );

      const recovered = await restoredLifecycle.reconcile("resident-a");
      expect(recovered).toHaveLength(1);
      expect(restoredSessions.getArchived(opened.handle.windowId)).toMatchObject({
        residentId: "resident-a",
        generation: opened.handle.generation,
        scopeId: "project",
        headId: reply.id,
      });
      expect(restoredStore.eventsAfter("resident-a", 0).map((event) => event.purpose)).toEqual([
        "closure",
        "result",
      ]);
      expect(await restoredLifecycle.reconcile("resident-a")).toEqual([]);
      await restoredWriter.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps first-party create from reopening or appending to an archived workspace", async () => {
    const { writer, sessions, lifecycle } = assembly();
    const opened = lifecycle.create("resident-a", { context: null });
    await lifecycle.close({
      residentId: "resident-a",
      windowId: opened.handle.windowId,
      generation: opened.handle.generation,
      workRef: "work-no-resume",
      artifactRef: "evidence:no-resume",
      idempotencyKey: "close-no-resume",
      occurredAt: "2026-09-04T08:04:00.000Z",
      summary: "must stay archived",
    });

    expect(() =>
      lifecycle.create("resident-a", {
        context: null,
        windowId: opened.handle.windowId,
        headId: sessions.getArchived(opened.handle.windowId)?.headId,
      } as never),
    ).toThrow(/accepts only context and optional scopeId/);
    expect(sessions.isArchived(opened.handle.windowId)).toBe(true);
    expect(sessions.windowsOf("resident-a")).toEqual([]);
    await writer.close();
  });

  it("does not let an unrelated result suppress closure reconciliation", async () => {
    let crash = true;
    const { store, writer, sessions, lifecycle } = assembly({
      checkpoint: (name) => {
        if (crash && name === "closure-delivered") throw new Error("simulated crash");
      },
    });
    const opened = lifecycle.create("resident-a", { context: null });
    await expect(
      lifecycle.close({
        residentId: "resident-a",
        windowId: opened.handle.windowId,
        generation: opened.handle.generation,
        workRef: "work-real",
        artifactRef: "evidence:real",
        idempotencyKey: "close-real",
        occurredAt: "2026-09-04T08:05:00.000Z",
        summary: "real closure",
      }),
    ).rejects.toThrow("simulated crash");
    const closure = store.eventsAfter("resident-a", 0)[0];
    await writer.submit({
      residentId: "resident-a",
      idempotencyKey: "unrelated-result",
      draft: {
        purpose: "result",
        occurredAt: "2026-09-04T08:05:01.000Z",
        workRef: "different-work",
        authoritySource: { kind: "host", id: "mist-host" },
        origin: {
          reporter: { kind: "host", id: "mist-host" },
          subject: { kind: "viewport", id: opened.handle.windowId },
          viewport: {
            windowId: opened.handle.windowId,
            generation: opened.handle.generation,
          },
        },
        effect: { state: "committed-effective", requiresUserAction: false, retry: "none" },
        artifactRef: "evidence:different",
        payload: {
          closureEventId: closure?.eventId ?? "missing",
          operationId: "different-operation",
          phase: "closed",
          summary: "not the matching result",
        },
      },
    });

    crash = false;
    expect(await lifecycle.reconcile("resident-a")).toHaveLength(1);
    expect(sessions.isArchived(opened.handle.windowId)).toBe(true);
    expect(
      store
        .eventsAfter("resident-a", 0)
        .filter((event) => event.purpose === "result" && event.workRef === "work-real"),
    ).toHaveLength(1);
    await writer.close();
  });

  it("rejects viewport-issued closure pairs as evidence authority", async () => {
    const { store, writer, sessions, lifecycle, tree } = assembly();
    const opened = lifecycle.create("resident-a", { context: null });
    await lifecycle.close({
      residentId: "resident-a",
      windowId: opened.handle.windowId,
      generation: opened.handle.generation,
      workRef: "work-authority",
      artifactRef: "evidence:authority",
      idempotencyKey: "close-authority",
      occurredAt: "2026-09-04T08:06:00.000Z",
      summary: "real host closure",
    });
    const viewportActor = { kind: "viewport" as const, id: opened.handle.windowId };
    const fakeClosure = await writer.submit({
      residentId: "resident-a",
      idempotencyKey: "fake-closure",
      draft: {
        purpose: "closure",
        occurredAt: "2026-09-04T08:06:01.000Z",
        workRef: "work-authority",
        authoritySource: viewportActor,
        origin: {
          reporter: viewportActor,
          subject: viewportActor,
          viewport: {
            windowId: opened.handle.windowId,
            generation: opened.handle.generation,
          },
        },
        effect: { state: "attempted", requiresUserAction: false, retry: "automatic" },
        artifactRef: "evidence:authority",
        payload: {
          headId: null,
          operationId: "fake-close",
          phase: "requested",
          scopeId: "private",
          summary: "viewport tries to self-authorize",
        },
      },
    });
    const fakeResult = await writer.submit({
      residentId: "resident-a",
      idempotencyKey: "fake-result",
      draft: {
        purpose: "result",
        occurredAt: "2026-09-04T08:06:02.000Z",
        workRef: "work-authority",
        authoritySource: viewportActor,
        origin: {
          reporter: viewportActor,
          subject: viewportActor,
          viewport: {
            windowId: opened.handle.windowId,
            generation: opened.handle.generation,
          },
        },
        effect: { state: "committed-effective", requiresUserAction: false, retry: "none" },
        artifactRef: "evidence:authority",
        payload: {
          closureEventId: fakeClosure.eventId,
          operationId: "fake-close",
          phase: "closed",
          summary: "viewport tries to unlock evidence",
        },
      },
    });
    const authority = new EvidenceAuthority();
    const evidence = new EvidenceViewportReader(
      store,
      new MessageTreeViewportHistory(tree, sessions),
      authority,
      authority.issue("auditor-a"),
    );

    expect(() =>
      evidence.read({ residentId: "resident-a", resultEventId: fakeResult.eventId }),
    ).toThrow(/not an authoritative closure pointer/);
    await writer.close();
  });
});
