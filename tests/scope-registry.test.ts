import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ScopeRegistry } from "../src/session/scope-registry.ts";

const directories: string[] = [];
function journal(): string {
  const directory = mkdtempSync(join(tmpdir(), "mist-scope-"));
  directories.push(directory);
  return join(directory, "scopes.jsonl");
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("scope activation authority", () => {
  it("keeps scope identities separate within and across residents", () => {
    const scopes = new ScopeRegistry();
    const a = scopes.activate("resident-a", "project-a");
    const b = scopes.activate("resident-a", "project-b");
    const other = scopes.activate("resident-b", "project-a");
    expect(a).toEqual({
      residentId: "resident-a",
      scopeId: "project-a",
      scopeGeneration: 1,
      status: "active",
    });
    expect(scopes.activeScopesOf("resident-a")).toEqual([a, b]);
    expect(scopes.activeScopesOf("resident-b")).toEqual([other]);
    expect(scopes.get("missing", "project-a")).toBeUndefined();
    expect(scopes.activate("resident-a", "project-a")).toEqual(a);
    expect(scopes.activeScopesOf("resident-a")).toHaveLength(2);
  });

  it("retires only the named activation, then explicitly issues a new generation", () => {
    const scopes = new ScopeRegistry();
    scopes.activate("resident-a", "a");
    const b = scopes.activate("resident-a", "b");
    const retired = scopes.retire("resident-a", "a", 1);
    expect(retired).toMatchObject({ scopeGeneration: 1, status: "inactive" });
    expect(scopes.retire("resident-a", "a", 1)).toEqual(retired);
    expect(scopes.activeScopesOf("resident-a")).toEqual([b]);
    const next = scopes.activate("resident-a", "a");
    expect(next).toMatchObject({ scopeId: "a", scopeGeneration: 2, status: "active" });
    expect(() => scopes.retire("resident-a", "a", 1)).toThrow();
    expect(scopes.get("resident-a", "a")).toEqual(next);
    expect(scopes.get("resident-a", "b")).toEqual(b);
    expect(() => scopes.retire("resident-b", "a", 2)).toThrow();
  });

  it("does not let returned objects rewrite the authority", () => {
    const scopes = new ScopeRegistry();
    const opened = scopes.activate("r", "s");
    Object.assign(opened, { scopeGeneration: 99, status: "inactive" });
    const listed = scopes.activeScopesOf("r")[0];
    Object.assign(listed ?? {}, { residentId: "other", scopeId: "elsewhere" });
    const queried = scopes.get("r", "s");
    Object.assign(queried ?? {}, { scopeGeneration: -1 });
    expect(scopes.get("r", "s")).toEqual({
      residentId: "r",
      scopeId: "s",
      scopeGeneration: 1,
      status: "active",
    });
  });

  it("does not alias delimiter-shaped identities", () => {
    const scopes = new ScopeRegistry();
    scopes.activate("a:b", "c");
    scopes.activate("a", "b:c");
    scopes.retire("a:b", "c", 1);
    expect(scopes.get("a", "b:c")?.status).toBe("active");
  });

  it("recovers both the inactive state and generation high-water mark", () => {
    const journalPath = journal();
    const first = new ScopeRegistry({ journalPath });
    first.activate("r", "a");
    first.activate("r", "b");
    first.retire("r", "a", 1);
    const before = readFileSync(journalPath, "utf8");
    const second = new ScopeRegistry({ journalPath });
    expect(second.get("r", "a")?.status).toBe("inactive");
    expect(second.get("r", "b")?.scopeGeneration).toBe(1);
    expect(readFileSync(journalPath, "utf8")).toBe(before);
    expect(second.activate("r", "a").scopeGeneration).toBe(2);
    const third = new ScopeRegistry({ journalPath });
    expect(third.activate("r", "a").scopeGeneration).toBe(2);
    expect(() => third.retire("r", "a", 1)).toThrow();
  });

  it("rejects malformed or non-monotonic durable history instead of resetting", () => {
    const journalPath = journal();
    const first = new ScopeRegistry({ journalPath });
    first.activate("r", "a");
    const valid = readFileSync(journalPath, "utf8");
    writeFileSync(journalPath, `${valid}{broken`);
    expect(() => new ScopeRegistry({ journalPath })).toThrow();
    writeFileSync(journalPath, valid + valid);
    expect(() => new ScopeRegistry({ journalPath })).toThrow();
    expect(readFileSync(journalPath, "utf8")).toBe(valid + valid);
  });

  it("does not report success when the journal append cannot be persisted", () => {
    const journalPath = journal();
    const scopes = new ScopeRegistry({ journalPath });
    scopes.activate("r", "a");
    rmSync(journalPath);
    mkdirSync(journalPath);
    expect(() => scopes.retire("r", "a", 1)).toThrow();
    expect(() => scopes.activate("r", "b")).toThrow();
  });

  it("rejects absent identities and invalid generation claims", () => {
    const scopes = new ScopeRegistry();
    expect(() => scopes.activate("", "a")).toThrow();
    expect(() => scopes.activate("r", "")).toThrow();
    scopes.activate("r", "a");
    for (const generation of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => scopes.retire("r", "a", generation)).toThrow();
    }
    expect(scopes.get("r", "a")?.status).toBe("active");
  });
});
