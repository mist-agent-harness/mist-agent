import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  type DispatchEvent,
  MessageTreeService,
  MessageTreeStore,
} from "../src/message-tree/index.ts";
import {
  BlockedReplyRouter,
  BoundedWorkEventPort,
  CanonicalBlockedReplyResolutionPort,
  CanonicalStreamStore,
  CanonicalStreamWriter,
  MessageTreeWorkspaceReplyDelivery,
  ReplyRouteError,
} from "../src/one-stream/index.ts";
import { SessionRegistry } from "../src/session/session-registry.ts";

async function assembly(
  options: {
    assistantReply?: (residentId: string, message: string) => string | Promise<string>;
    dataDir?: string;
  } = {},
) {
  const stream = new CanonicalStreamStore(
    options.dataDir === undefined ? {} : { dataDir: options.dataDir },
  );
  stream.createStream("resident-a");
  const writer = new CanonicalStreamWriter(stream);
  const sessions = new SessionRegistry<null>();
  const first = sessions.open("resident-a", { context: null });
  const second = sessions.open("resident-a", { context: null });
  const tree = new MessageTreeStore();
  tree.createRoom("resident-a");
  const dispatchEvents: DispatchEvent[] = [];
  const service = new MessageTreeService(
    tree,
    {
      getHead: (windowId) => sessions.getHead(windowId),
      setHead: (windowId, headId) => sessions.setHead(windowId, headId),
    },
    {
      dispatch: sessions,
      dispatchEventLogger: { log: (event) => dispatchEvents.push(event) },
      assistantReply:
        options.assistantReply ??
        ((_residentId, message) => {
          if (message === "dispatch-fails") throw new Error("responder unavailable");
          return `reply:${message}`;
        }),
    },
  );
  const workEvents = new BoundedWorkEventPort(writer, {
    authoritySource: { kind: "host", id: "mist-host" },
  });
  const blocked = [];
  for (const [index, window] of [first, second].entries()) {
    blocked.push(
      await workEvents.submit({
        residentId: "resident-a",
        idempotencyKey: `blocked-${index + 1}`,
        purpose: "blocked",
        occurredAt: `2026-09-04T08:00:0${index}.000Z`,
        workRef: `work-${index + 1}`,
        artifactRef: `artifact:block-${index + 1}`,
        source: { windowId: window.windowId, generation: window.generation },
        effect: {
          state: "failed-not-effective",
          requiresUserAction: true,
          retry: "awaiting-external",
        },
        summary: `blocked ${index + 1}`,
      }),
    );
  }
  const delivery = new MessageTreeWorkspaceReplyDelivery(service, sessions);
  const resolutions = new CanonicalBlockedReplyResolutionPort(stream, writer, {
    authoritySource: { kind: "host", id: "mist-host" },
    now: () => "2026-09-04T08:01:00.000Z",
  });
  const router = new BlockedReplyRouter(stream, sessions, delivery, resolutions);
  return {
    stream,
    writer,
    sessions,
    tree,
    service,
    delivery,
    resolutions,
    first,
    second,
    blocked,
    router,
    dispatchEvents,
  };
}

describe("OS-06 canonical blocked reply routing", () => {
  it("issues one receipt for a responder call and none for a committed replay", async () => {
    const assistantReply = vi.fn((_residentId: string, message: string) => `reply:${message}`);
    const { writer, sessions, first, blocked, delivery, tree, dispatchEvents } = await assembly({
      assistantReply,
    });
    const issueDispatch = vi.spyOn(sessions, "issueDispatch");
    const request = {
      residentId: "resident-a",
      text: "answer-once",
      eventId: blocked[0]?.eventId ?? "missing-blocker",
      workRef: "work-1",
      viewport: { windowId: first.windowId, generation: first.generation },
    };
    const committed = await delivery.deliver(request);
    expect(issueDispatch).toHaveBeenCalledTimes(1);
    expect(dispatchEvents.map((event) => event.event)).toEqual(["dispatch", "receipt"]);
    for (const event of dispatchEvents) {
      expect(event).toMatchObject(issueDispatch.mock.results[0]?.value);
    }

    await expect(delivery.deliver(request)).resolves.toEqual(committed);
    expect(issueDispatch).toHaveBeenCalledTimes(1);
    expect(assistantReply).toHaveBeenCalledTimes(1);
    expect(dispatchEvents).toHaveLength(2);
    expect(tree.history("resident-a")).toHaveLength(2);

    sessions.kill(first.windowId);
    sessions.open("resident-a", { windowId: first.windowId, context: null });
    await expect(delivery.deliver(request)).rejects.toMatchObject({ code: "REPLY_TARGET_STALE" });
    expect(issueDispatch).toHaveBeenCalledTimes(1);
    expect(sessions.getHead(first.windowId)).toBeNull();
    expect(tree.history("resident-a")).toHaveLength(2);
    await writer.close();
  });

  it("rejects an archived delivery before issuing a receipt or calling the responder", async () => {
    const assistantReply = vi.fn(() => "must not run");
    const { writer, sessions, first, delivery, tree, dispatchEvents } = await assembly({
      assistantReply,
    });
    const issueDispatch = vi.spyOn(sessions, "issueDispatch");
    sessions.kill(first.windowId);
    await expect(
      delivery.deliver({
        residentId: "resident-a",
        text: "stale",
        eventId: "archived-blocker",
        workRef: "work-1",
        viewport: { windowId: first.windowId, generation: first.generation },
      }),
    ).rejects.toMatchObject({ code: "REPLY_TARGET_STALE" });
    expect(issueDispatch).not.toHaveBeenCalled();
    expect(assistantReply).not.toHaveBeenCalled();
    expect(dispatchEvents).toEqual([]);
    expect(tree.history("resident-a")).toEqual([]);
    await writer.close();
  });

  it("routes explicit handles exactly, allows one naked target, and never guesses among two", async () => {
    const { writer, sessions, tree, first, second, blocked, router } = await assembly();
    const before = JSON.stringify(tree.history("resident-a"));
    const ambiguous = await router.route({ residentId: "resident-a", text: "naked" });
    expect(ambiguous).toMatchObject({ status: "disambiguation-required" });
    expect(ambiguous.status === "disambiguation-required" && ambiguous.candidates).toHaveLength(2);
    expect(JSON.stringify(tree.history("resident-a"))).toBe(before);
    expect(sessions.getHead(first.windowId)).toBeNull();
    expect(sessions.getHead(second.windowId)).toBeNull();

    const firstRoute = await router.route({
      residentId: "resident-a",
      text: "answer-one",
      replyToEventId: blocked[0]?.eventId,
      workRef: "work-1",
    });
    expect(firstRoute).toMatchObject({
      status: "routed",
      receipt: { eventId: blocked[0]?.eventId, viewport: { windowId: first.windowId } },
    });
    expect(sessions.getHead(first.windowId)).not.toBeNull();
    expect(sessions.getHead(second.windowId)).toBeNull();

    const naked = await router.route({ residentId: "resident-a", text: "answer-two" });
    expect(naked).toMatchObject({
      status: "routed",
      receipt: { eventId: blocked[1]?.eventId, viewport: { windowId: second.windowId } },
    });
    expect(sessions.getHead(second.windowId)).not.toBeNull();
    expect(tree.history("resident-a").map((node) => node.content)).toEqual([
      "answer-one",
      "reply:answer-one",
      "answer-two",
      "reply:answer-two",
    ]);
    expect(await router.route({ residentId: "resident-a", text: "nothing-left" })).toEqual({
      status: "no-target",
    });
    await writer.close();
  });

  it("rejects unknown, inconsistent, stale, and failed targets without resolving another workspace", async () => {
    const { writer, sessions, tree, first, blocked, router } = await assembly();
    const before = JSON.stringify(tree.history("resident-a"));
    await expect(
      router.route({
        residentId: "resident-a",
        text: "wrong",
        replyToEventId: "unknown-event",
      }),
    ).rejects.toMatchObject({ code: "REPLY_TARGET_UNKNOWN" });
    await expect(
      router.route({
        residentId: "resident-a",
        text: "wrong",
        replyToEventId: blocked[0]?.eventId,
        workRef: "work-2",
      }),
    ).rejects.toMatchObject({ code: "REPLY_TARGET_INCONSISTENT" });
    expect(JSON.stringify(tree.history("resident-a"))).toBe(before);

    sessions.kill(first.windowId);
    await expect(
      router.route({
        residentId: "resident-a",
        text: "stale",
        replyToEventId: blocked[0]?.eventId,
      }),
    ).rejects.toMatchObject({ code: "REPLY_TARGET_STALE" });
    expect(JSON.stringify(tree.history("resident-a"))).toBe(before);

    await expect(
      router.route({
        residentId: "resident-a",
        text: "dispatch-fails",
        replyToEventId: blocked[1]?.eventId,
      }),
    ).rejects.toThrow("responder unavailable");
    expect(JSON.stringify(tree.history("resident-a"))).toBe(before);
    expect(
      await router.route({
        residentId: "resident-a",
        text: "retry-after-failure",
        replyToEventId: blocked[1]?.eventId,
      }),
    ).toMatchObject({ status: "routed", receipt: { eventId: blocked[1]?.eventId } });

    await expect(
      router.route({
        residentId: "resident-a",
        text: "duplicate",
        replyToEventId: blocked[1]?.eventId,
      }),
    ).rejects.toBeInstanceOf(ReplyRouteError);
    await writer.close();
  });

  it("derives resolved blockers from the durable stream after router and port rebuild", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mist-reply-resolution-"));
    try {
      const { writer, sessions, tree, delivery, blocked, router } = await assembly({ dataDir });
      await router.route({
        residentId: "resident-a",
        text: "answer-once",
        replyToEventId: blocked[0]?.eventId,
      });
      const afterFirst = JSON.stringify(tree.history("resident-a"));
      await writer.close();

      const restoredStream = new CanonicalStreamStore({ dataDir });
      const restoredWriter = new CanonicalStreamWriter(restoredStream);
      const rebuilt = new BlockedReplyRouter(
        restoredStream,
        sessions,
        delivery,
        new CanonicalBlockedReplyResolutionPort(restoredStream, restoredWriter, {
          authoritySource: { kind: "host", id: "mist-host" },
        }),
      );

      await expect(
        rebuilt.route({
          residentId: "resident-a",
          text: "must-not-repeat",
          replyToEventId: blocked[0]?.eventId,
        }),
      ).rejects.toMatchObject({ code: "REPLY_TARGET_RESOLVED" });
      expect(JSON.stringify(tree.history("resident-a"))).toBe(afterFirst);
      expect(
        restoredStream
          .eventsAfter("resident-a", 0)
          .filter((event) => event.payload.kind === "blocked-reply-resolved"),
      ).toHaveLength(1);
      await restoredWriter.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("recovers a committed tree delivery when the durable resolved receipt failed", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mist-reply-crash-gap-"));
    let closeWriter = async (): Promise<void> => undefined;
    let responderCalls = 0;
    try {
      const built = await assembly({
        dataDir,
        assistantReply: async (_residentId, message) => {
          responderCalls += 1;
          await closeWriter();
          return `reply:${message}`;
        },
      });
      closeWriter = () => built.writer.close();

      await expect(
        built.router.route({
          residentId: "resident-a",
          text: "answer-survives-receipt-crash",
          replyToEventId: built.blocked[0]?.eventId,
        }),
      ).rejects.toThrow("canonical stream writer is closed");
      expect(built.tree.history("resident-a")).toHaveLength(2);
      expect(responderCalls).toBe(1);

      const restoredStream = new CanonicalStreamStore({ dataDir });
      const restoredWriter = new CanonicalStreamWriter(restoredStream);
      const restoredTree = new MessageTreeStore();
      restoredTree.createRoom("resident-a");
      restoredTree.importTree("resident-a", built.tree.exportTree("resident-a"));
      const restoredService = new MessageTreeService(
        restoredTree,
        {
          getHead: (windowId) => built.sessions.getHead(windowId),
          setHead: (windowId, headId) => built.sessions.setHead(windowId, headId),
        },
        {
          assistantReply: () => {
            responderCalls += 1;
            throw new Error("committed delivery must not invoke responder again");
          },
        },
      );
      const rebuilt = new BlockedReplyRouter(
        restoredStream,
        built.sessions,
        new MessageTreeWorkspaceReplyDelivery(restoredService, built.sessions),
        new CanonicalBlockedReplyResolutionPort(restoredStream, restoredWriter, {
          authoritySource: { kind: "host", id: "mist-host" },
        }),
      );

      await expect(
        rebuilt.route({
          residentId: "resident-a",
          text: "answer-survives-receipt-crash",
          replyToEventId: built.blocked[0]?.eventId,
        }),
      ).resolves.toMatchObject({ status: "routed" });
      expect(responderCalls).toBe(1);
      expect(restoredTree.history("resident-a")).toHaveLength(2);
      expect(
        restoredStream
          .eventsAfter("resident-a", 0)
          .filter((event) => event.payload.kind === "blocked-reply-resolved"),
      ).toHaveLength(1);
      await expect(
        rebuilt.route({
          residentId: "resident-a",
          text: "answer-survives-receipt-crash",
          replyToEventId: built.blocked[0]?.eventId,
        }),
      ).rejects.toMatchObject({ code: "REPLY_TARGET_RESOLVED" });
      await restoredWriter.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("recovers the resolved receipt after later turns advanced beyond the committed pair", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mist-reply-crash-gap-later-turn-"));
    let closeWriter = async (): Promise<void> => undefined;
    let blockerResponderCalls = 0;
    try {
      const built = await assembly({
        dataDir,
        assistantReply: async (_residentId, message) => {
          if (message === "answer-before-later-turn") {
            blockerResponderCalls += 1;
            await closeWriter();
          }
          return `reply:${message}`;
        },
      });
      closeWriter = () => built.writer.close();

      await expect(
        built.router.route({
          residentId: "resident-a",
          text: "answer-before-later-turn",
          replyToEventId: built.blocked[0]?.eventId,
        }),
      ).rejects.toThrow("canonical stream writer is closed");
      expect(blockerResponderCalls).toBe(1);
      expect(built.tree.history("resident-a")).toHaveLength(2);

      closeWriter = async () => undefined;
      const later = await built.service.say("resident-a", "later-turn", built.first.windowId);
      expect(built.sessions.getHead(built.first.windowId)).toBe(later.id);
      expect(built.tree.history("resident-a")).toHaveLength(4);

      const restoredStream = new CanonicalStreamStore({ dataDir });
      const restoredWriter = new CanonicalStreamWriter(restoredStream);
      const restoredTree = new MessageTreeStore();
      restoredTree.createRoom("resident-a");
      restoredTree.importTree("resident-a", built.tree.exportTree("resident-a"));
      const restoredService = new MessageTreeService(
        restoredTree,
        {
          getHead: (windowId) => built.sessions.getHead(windowId),
          setHead: (windowId, headId) => built.sessions.setHead(windowId, headId),
        },
        {
          assistantReply: () => {
            blockerResponderCalls += 1;
            throw new Error("committed blocker delivery must not invoke responder again");
          },
        },
      );
      const rebuilt = new BlockedReplyRouter(
        restoredStream,
        built.sessions,
        new MessageTreeWorkspaceReplyDelivery(restoredService, built.sessions),
        new CanonicalBlockedReplyResolutionPort(restoredStream, restoredWriter, {
          authoritySource: { kind: "host", id: "mist-host" },
        }),
      );

      await expect(
        rebuilt.route({
          residentId: "resident-a",
          text: "answer-before-later-turn",
          replyToEventId: built.blocked[0]?.eventId,
        }),
      ).resolves.toMatchObject({ status: "routed" });
      expect(blockerResponderCalls).toBe(1);
      expect(restoredTree.history("resident-a")).toHaveLength(4);
      expect(built.sessions.getHead(built.first.windowId)).toBe(later.id);
      expect(
        restoredStream
          .eventsAfter("resident-a", 0)
          .filter((event) => event.payload.kind === "blocked-reply-resolved"),
      ).toHaveLength(1);
      await restoredWriter.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("serializes concurrent replies to one blocker before either can dispatch twice", async () => {
    let releaseReply = (): void => undefined;
    let markStarted = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const replyReleased = new Promise<void>((resolve) => {
      releaseReply = resolve;
    });
    const { stream, writer, tree, blocked, router } = await assembly({
      assistantReply: async (_residentId, message) => {
        markStarted();
        await replyReleased;
        return `reply:${message}`;
      },
    });

    const first = router.route({
      residentId: "resident-a",
      text: "first",
      replyToEventId: blocked[0]?.eventId,
    });
    await started;
    const second = router.route({
      residentId: "resident-a",
      text: "second",
      replyToEventId: blocked[0]?.eventId,
    });
    releaseReply();

    await expect(first).resolves.toMatchObject({ status: "routed" });
    await expect(second).rejects.toMatchObject({ code: "REPLY_TARGET_RESOLVED" });
    expect(tree.history("resident-a")).toHaveLength(2);
    expect(
      stream
        .eventsAfter("resident-a", 0)
        .filter((event) => event.payload.kind === "blocked-reply-resolved"),
    ).toHaveLength(1);
    await writer.close();
  });

  it("rechecks generation at the synchronous tree/head commit boundary", async () => {
    let releaseReply = (): void => undefined;
    let markStarted = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const replyReleased = new Promise<void>((resolve) => {
      releaseReply = resolve;
    });
    const { writer, sessions, tree, first, blocked, router, dispatchEvents } = await assembly({
      assistantReply: async (_residentId, message) => {
        markStarted();
        await replyReleased;
        return `reply:${message}`;
      },
    });

    const issueDispatch = vi.spyOn(sessions, "issueDispatch");
    const inFlight = router.route({
      residentId: "resident-a",
      text: "old-generation",
      replyToEventId: blocked[0]?.eventId,
    });
    await started;
    sessions.kill(first.windowId);
    const reopened = sessions.open("resident-a", {
      windowId: first.windowId,
      context: null,
    });
    expect(reopened.generation).toBe(first.generation + 1);
    releaseReply();

    await expect(inFlight).rejects.toMatchObject({ code: "REPLY_TARGET_STALE" });
    expect(issueDispatch).toHaveBeenCalledTimes(1);
    expect(dispatchEvents.map((event) => event.event)).toEqual(["dispatch", "dropped"]);
    for (const event of dispatchEvents) {
      expect(event).toMatchObject(issueDispatch.mock.results[0]?.value);
    }
    expect(tree.history("resident-a")).toEqual([]);
    expect(sessions.getHead(first.windowId)).toBeNull();
    await writer.close();
  });
});
