import { describe, expect, it } from "vitest";
import { MessageTreeService, MessageTreeStore } from "../src/message-tree/index.ts";
import {
  BlockedReplyRouter,
  BoundedWorkEventPort,
  CanonicalStreamStore,
  CanonicalStreamWriter,
  MessageTreeWorkspaceReplyDelivery,
  ReplyRouteError,
} from "../src/one-stream/index.ts";
import { SessionRegistry } from "../src/session/session-registry.ts";

async function assembly() {
  const stream = new CanonicalStreamStore();
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
      assistantReply: (_residentId, message) => {
        if (message === "dispatch-fails") throw new Error("responder unavailable");
        return `reply:${message}`;
      },
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
  const router = new BlockedReplyRouter(
    stream,
    sessions,
    new MessageTreeWorkspaceReplyDelivery(service, sessions),
  );
  return { stream, writer, sessions, tree, first, second, blocked, router };
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
});
