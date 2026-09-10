import { describe, expect, it } from "vitest";
import { MessageTreeService, MessageTreeStore } from "../src/message-tree/index.ts";
import { type DispatchReceipt, SessionRegistry } from "../src/session/session-registry.ts";

function host() {
  const sessions = new SessionRegistry<null>();
  const a = sessions.open("r", { scopeId: "a", context: null });
  const b = sessions.open("r", { scopeId: "b", context: null });
  return { sessions, a, b };
}

describe("host-issued dispatch correlation and single consumption", () => {
  it("rejects an invented id even when all scope and viewport fields are current", () => {
    const { sessions, a } = host();
    const receipt = sessions.issueDispatch(a.windowId);
    expect(sessions.belongsToActiveWindow({ ...receipt, dispatchId: "dispatch-forged" })).toBe(
      false,
    );
    expect(sessions.belongsToActiveWindow(receipt)).toBe(true);
  });

  it("rejects copying an issued id onto another live scope or viewport", () => {
    const { sessions, a, b } = host();
    const sibling = sessions.open("r", { scopeId: "a", context: null });
    const first = sessions.issueDispatch(a.windowId);
    for (const window of [b, sibling]) {
      const other = sessions.issueDispatch(window.windowId);
      expect(sessions.belongsToActiveWindow({ ...other, dispatchId: first.dispatchId })).toBe(
        false,
      );
    }
    Object.assign(first, { scopeId: "b", windowId: b.windowId });
    expect(sessions.belongsToActiveWindow(first)).toBe(false);
  });

  it("consumes an issued receipt once without invalidating a different in-flight receipt", () => {
    const { sessions, a } = host();
    const first = sessions.issueDispatch(a.windowId);
    const second = sessions.issueDispatch(a.windowId);
    expect(sessions.consumeDispatch(second)).toBe(true);
    expect(sessions.consumeDispatch(second)).toBe(false);
    expect(sessions.belongsToActiveWindow(second)).toBe(false);
    expect(sessions.belongsToActiveWindow(first)).toBe(true);
    expect(sessions.consumeDispatch(first)).toBe(true);
  });

  it("revokes exactly the issued receipt and refuses subsequent consumption", () => {
    const { sessions, a, b } = host();
    const first = sessions.issueDispatch(a.windowId);
    const other = sessions.issueDispatch(b.windowId);
    expect(sessions.revokeDispatch({ ...other, dispatchId: first.dispatchId })).toBe(false);
    expect(sessions.belongsToActiveWindow(first)).toBe(true);
    expect(sessions.revokeDispatch(first)).toBe(true);
    expect(sessions.consumeDispatch(first)).toBe(false);
    expect(sessions.belongsToActiveWindow(other)).toBe(true);
  });

  it("does not revive pending receipts after scope retirement and reactivation", () => {
    const { sessions, a, b } = host();
    const first = sessions.issueDispatch(a.windowId);
    const other = sessions.issueDispatch(b.windowId);
    sessions.retireScope("r", "a", 1);
    sessions.activateScope("r", "a");
    expect(sessions.consumeDispatch(first)).toBe(false);
    expect(sessions.consumeDispatch(other)).toBe(true);
  });

  it("cannot append the same response twice through a re-entered commit boundary", async () => {
    const { sessions, a } = host();
    const tree = new MessageTreeStore();
    tree.createRoom("r");
    const service = new MessageTreeService(tree, sessions);
    await service.say("r", "one turn", a.windowId, {
      commitBoundary: {
        commit(mutation) {
          const first = mutation();
          expect(() => mutation()).toThrow("DISPATCH_RESULT_DROPPED");
          return first;
        },
      },
    });
    expect(tree.history("r")).toHaveLength(2);
  });

  it.each(["responder", "boundary", "logger"])(
    "releases the issued receipt after a failed %s",
    async (point) => {
      const { sessions, a } = host();
      const tree = new MessageTreeStore();
      tree.createRoom("r");
      const receipts: DispatchReceipt[] = [];
      const service = new MessageTreeService(tree, sessions, {
        dispatchEventLogger: {
          log: (event) => {
            receipts.push(event);
            if (point === "logger") throw new Error("injected failure");
          },
        },
        assistantReply: () => {
          if (point === "responder") throw new Error("injected failure");
          return "reply";
        },
      });
      await expect(
        service.say(
          "r",
          "input",
          a.windowId,
          point === "boundary"
            ? {
                commitBoundary: {
                  commit() {
                    throw new Error("injected failure");
                  },
                },
              }
            : {},
        ),
      ).rejects.toThrow("injected failure");
      const receipt = receipts[0];
      if (receipt === undefined) throw new Error("dispatch event missing");
      expect(sessions.belongsToActiveWindow(receipt)).toBe(false);
      expect(sessions.consumeDispatch(receipt)).toBe(false);
      expect(tree.history("r")).toEqual([]);
    },
  );
  it("refuses a partial lifecycle adapter instead of silently using the head-only path", () => {
    const { sessions } = host();
    const tree = new MessageTreeStore();
    const oldPort = {
      getHead: (id: string) => sessions.getHead(id),
      setHead: (id: string, head: string) => sessions.setHead(id, head),
      issueDispatch: (id: string) => sessions.issueDispatch(id),
      belongsToActiveWindow: (receipt: DispatchReceipt) => sessions.belongsToActiveWindow(receipt),
    };
    expect(() => new MessageTreeService(tree, oldPort)).toThrow(
      "incomplete dispatch lifecycle port",
    );
  });
});
