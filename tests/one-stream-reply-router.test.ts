import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MessageTreeService, MessageTreeStore } from "../src/message-tree/index.ts";
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
  const service = new MessageTreeService(
    tree,
    {
      getHead: (windowId) => sessions.getHead(windowId),
      setHead: (windowId, headId) => sessions.setHead(windowId, headId),
    },
    {
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
  };
}

describe("OS-06 canonical blocked reply routing", () => {
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
    const { writer, sessions, tree, first, blocked, router } = await assembly({
      assistantReply: async (_residentId, message) => {
        markStarted();
        await replyReleased;
        return `reply:${message}`;
      },
    });

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
    expect(tree.history("resident-a")).toEqual([]);
    expect(sessions.getHead(first.windowId)).toBeNull();
    await writer.close();
  });
});
