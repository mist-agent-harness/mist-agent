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
      headId: "node-b",
      context: ["b"],
    });
  });
});
