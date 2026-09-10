import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { MessageTreeService, MessageTreeStore } from "../src/message-tree/index.ts";
import { SessionRegistry } from "../src/session/session-registry.ts";

const directories: string[] = [];
function path(): string {
  const directory = mkdtempSync(join(tmpdir(), "mist-scope-session-"));
  directories.push(directory);
  return join(directory, "windows.jsonl");
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it("viewport churn leaves scope generation unchanged; scope retirement blocks every old viewport", () => {
  const sessions = new SessionRegistry<null>();
  const a = sessions.open("r", { scopeId: "a", context: null });
  const sibling = sessions.open("r", { scopeId: "a", context: null });
  const b = sessions.open("r", { scopeId: "b", context: null });
  const receipt = sessions.issueDispatch(sibling.windowId);
  sessions.kill(a.windowId);
  const reopened = sessions.open("r", { scopeId: "a", windowId: a.windowId, context: null });
  expect(reopened).toMatchObject({ generation: 2, scopeGeneration: 1 });
  expect(sessions.belongsToActiveWindow(receipt)).toBe(true);
  expect(sessions.belongsToActiveWindow({ ...receipt, scopeId: "b" })).toBe(false);
  expect(sessions.belongsToActiveWindow({ ...receipt, scopeGeneration: 2 })).toBe(false);
  sessions.retireScope("r", "a", 1);
  expect(sessions.activeScopesOf("r").map((scope) => scope.scopeId)).toEqual(["b"]);
  for (const window of [sibling, reopened]) {
    expect(() => sessions.issueDispatch(window.windowId)).toThrow("SCOPE_INACTIVE");
    expect(() => sessions.setHead(window.windowId, "bad")).toThrow("SCOPE_INACTIVE");
  }
  sessions.activateScope("r", "a");
  expect(sessions.belongsToActiveWindow(receipt)).toBe(false);
  expect(sessions.issueDispatch(b.windowId)).toMatchObject({ scopeId: "b", scopeGeneration: 1 });
  // Public window snapshots must not rewrite captured activation authority.
  Object.assign(sibling, { scopeGeneration: 2 });
  Object.assign(sessions.get(sibling.windowId) ?? {}, { scopeGeneration: 2 });
  Object.assign(sessions.windowsOf("r")[0] ?? {}, { scopeGeneration: 2 });
  expect(() => sessions.issueDispatch(sibling.windowId)).toThrow("SCOPE_INACTIVE");
});

it("restart preserves retirement and independent activation high-water marks", () => {
  const archivePath = path();
  const first = new SessionRegistry<null>({ archivePath });
  const a = first.open("r", { scopeId: "a", context: null });
  first.open("r", { scopeId: "b", context: null });
  const old = first.issueDispatch(a.windowId);
  first.retireScope("r", "a", 1);
  const second = new SessionRegistry<null>({ archivePath });
  expect(second.windowsOf("r")).toEqual([]);
  expect(second.getScope("r", "a")?.status).toBe("inactive");
  expect(() => second.open("r", { scopeId: "a", windowId: a.windowId, context: null })).toThrow(
    "SCOPE_INACTIVE",
  );
  second.activateScope("r", "a");
  const next = second.open("r", { scopeId: "a", windowId: a.windowId, context: null });
  expect(next).toMatchObject({ generation: 2, scopeGeneration: 2 });
  expect(second.belongsToActiveWindow(old)).toBe(false);
  const archive = second.kill(next.windowId);
  const third = new SessionRegistry<null>({ archivePath });
  expect(third.getArchived(next.windowId)).toEqual(archive);
  expect(third.getScope("r", "b")?.scopeGeneration).toBe(1);
});

it("migrates legacy windows once and refuses a missing companion even with legacy rows present", () => {
  const archivePath = path();
  const legacy = {
    schemaVersion: 1,
    type: "window_opened",
    window: { residentId: "r", scopeId: "a", windowId: "old-window", generation: 3 },
  };
  writeFileSync(archivePath, `${JSON.stringify(legacy)}\n`);
  const migrated = new SessionRegistry<null>({ archivePath });
  expect(migrated.open("r", { scopeId: "a", windowId: "old-window", context: null })).toMatchObject(
    { generation: 4, scopeGeneration: 1 },
  );
  const before = readFileSync(archivePath, "utf8");
  rmSync(`${archivePath}.scopes`);
  expect(() => new SessionRegistry({ archivePath })).toThrow("missing scope activation history");
  expect(readFileSync(archivePath, "utf8")).toBe(before);
});

it("archive recovery must retain the captured scope generation, including after scope reactivation", () => {
  const archivePath = path();
  const first = new SessionRegistry<null>({ archivePath });
  const opened = first.open("r", { scopeId: "a", context: null });
  first.retireScope("r", "a", 1);
  first.activateScope("r", "a");
  const restarted = new SessionRegistry<null>({ archivePath });
  const { context: _context, ...snapshot } = opened;
  expect(() =>
    restarted.recoverArchived({ ...snapshot, scopeGeneration: 2, archived: true }),
  ).toThrow();
  expect(restarted.recoverArchived({ ...snapshot, archived: true })).toMatchObject({
    scopeGeneration: 1,
  });
});

it("a SessionRegistry passed as the head port cannot silently omit result validation", async () => {
  const sessions = new SessionRegistry<null>();
  const window = sessions.open("r", { scopeId: "a", context: null });
  const store = new MessageTreeStore();
  store.createRoom("r");
  let release: ((value: string) => void) | undefined;
  const service = new MessageTreeService(store, sessions, {
    assistantReply: () =>
      new Promise<string>((resolve) => {
        release = resolve;
      }),
  });
  const pending = service.say("r", "stale input", window.windowId);
  const dropped = expect(pending).rejects.toThrow("DISPATCH_RESULT_DROPPED");
  expect(release).toBeTypeOf("function");
  sessions.retireScope("r", "a", 1);
  release?.("stale result");
  await dropped;
  expect(store.history("r")).toEqual([]);
});
