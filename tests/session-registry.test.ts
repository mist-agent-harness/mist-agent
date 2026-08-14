import { describe, expect, it } from "vitest";
import { SessionRegistry } from "../src/session/session-registry.ts";

describe("SessionRegistry", () => {
  it("kills the live pointer and in-flight context without touching resident state", () => {
    const residentState = {
      memories: ["答应过：周五晚上一起看电影"],
      messages: ["记住这件事"],
      relationships: ["一起看电影"],
    };
    const before = structuredClone(residentState);
    const sessions = new SessionRegistry<{ pending: string[] }>();

    sessions.open("resident-a", "node-2", { pending: ["还没落库的话"] });
    sessions.kill("resident-a");

    expect(sessions.get("resident-a")).toBeUndefined();
    expect(residentState).toEqual(before);
  });

  it("is idempotent when the same session is killed twice", () => {
    const sessions = new SessionRegistry<Record<string, never>>();
    sessions.open("resident-a", null, {});

    sessions.kill("resident-a");
    expect(() => sessions.kill("resident-a")).not.toThrow();
    expect(sessions.isActive("resident-a")).toBe(false);
  });

  it("does not kill another resident's live session", () => {
    const sessions = new SessionRegistry<string[]>();
    sessions.open("resident-a", "node-a", ["a"]);
    sessions.open("resident-b", "node-b", ["b"]);

    sessions.kill("resident-a");

    expect(sessions.isActive("resident-a")).toBe(false);
    expect(sessions.get("resident-b")).toEqual({
      residentId: "resident-b",
      generation: 1,
      headId: "node-b",
      context: ["b"],
    });
  });

  it("advances the head inside one active generation", () => {
    const sessions = new SessionRegistry<null>();
    const session = sessions.open("resident-a", null, null);

    sessions.setHead("resident-a", "reply-1");

    expect(sessions.get("resident-a")).toEqual({
      ...session,
      headId: "reply-1",
    });
  });

  it("rejects setting a head when no session is active", () => {
    const sessions = new SessionRegistry<null>();

    expect(() => sessions.setHead("resident-a", "reply-1")).toThrow(/no active session/);
  });

  it("marks stale dispatch receipts as not belonging to the active session after kill", () => {
    const sessions = new SessionRegistry<null>();
    sessions.open("resident-a", null, null);
    const stale = sessions.issueDispatch("resident-a");

    sessions.kill("resident-a");
    sessions.open("resident-a", null, null);

    expect(sessions.belongsToActiveSession(stale)).toBe(false);
  });

  it("keeps current-generation dispatch receipts valid while the session is still active", () => {
    const sessions = new SessionRegistry<null>();
    sessions.open("resident-a", null, null);
    const receipt = sessions.issueDispatch("resident-a");

    expect(sessions.belongsToActiveSession(receipt)).toBe(true);
  });
});
