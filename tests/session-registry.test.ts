import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PRIVATE_SCOPE,
  SessionRegistry,
  WINDOW_ARCHIVED,
  WINDOW_REOPEN_INVALID,
} from "../src/session/session-registry.ts";

describe("SessionRegistry：多窗语义", () => {
  it("MV-A01 同一住户同一 scope 连开两次得到两扇活窗，各自 generation=1", () => {
    const sessions = new SessionRegistry<null>();

    const w1 = sessions.open("resident-a", { context: null });
    const w2 = sessions.open("resident-a", { context: null });

    expect(w1.windowId).not.toBe(w2.windowId);
    expect(w1.generation).toBe(1);
    expect(w2.generation).toBe(1);
    expect(sessions.isActive(w1.windowId)).toBe(true);
    expect(sessions.isActive(w2.windowId)).toBe(true);
    expect(sessions.windowsOf("resident-a")).toHaveLength(2);
  });

  it("MV-A04 缺省 scope 落私聊，不落全局", () => {
    const sessions = new SessionRegistry<null>();

    expect(sessions.open("resident-a", { context: null }).scopeId).toBe(PRIVATE_SCOPE);
    expect(sessions.open("resident-a", { scopeId: "room-1", context: null }).scopeId).toBe(
      "room-1",
    );
  });

  it("MV-A03 kill 幂等，归档后只读，写入返 WINDOW_ARCHIVED", () => {
    const sessions = new SessionRegistry<null>();
    const w1 = sessions.open("resident-a", { headId: "node-1", context: null });

    const first = sessions.kill(w1.windowId);
    const second = sessions.kill(w1.windowId);

    expect(first).toEqual(second);
    expect(sessions.isActive(w1.windowId)).toBe(false);
    expect(sessions.getArchived(w1.windowId)).toMatchObject({ archived: true, headId: "node-1" });
    expect(() => sessions.setHead(w1.windowId, "node-2")).toThrow(WINDOW_ARCHIVED);
    expect(() => sessions.issueDispatch(w1.windowId)).toThrow(WINDOW_ARCHIVED);
  });

  it("MV-A03 killResident 杀掉该住户全部活窗，不碰别人", () => {
    const sessions = new SessionRegistry<null>();
    const a1 = sessions.open("resident-a", { context: null });
    const a2 = sessions.open("resident-a", { context: null });
    const b1 = sessions.open("resident-b", { context: null });

    expect(sessions.killResident("resident-a")).toHaveLength(2);

    expect(sessions.isActive(a1.windowId)).toBe(false);
    expect(sessions.isActive(a2.windowId)).toBe(false);
    expect(sessions.isActive(b1.windowId)).toBe(true);
  });

  it("MV-B02 代际归窗，住户级问不出「当前代际」", () => {
    const sessions = new SessionRegistry<null>();
    const w1 = sessions.open("resident-a", { context: null });
    sessions.kill(w1.windowId);
    const reopened = sessions.open("resident-a", { windowId: w1.windowId, context: null });
    const fresh = sessions.open("resident-a", { context: null });

    expect(reopened.generation).toBe(2);
    expect(fresh.generation).toBe(1);
    expect(sessions).not.toHaveProperty("currentGeneration");
    expect(
      sessions
        .windowsOf("resident-a")
        .map((w) => w.generation)
        .sort(),
    ).toEqual([1, 2]);
  });

  it("显式 windowId 只能重开已归档窗，未知 id fail loud 且不污染内部发号", () => {
    const sessions = new SessionRegistry<null>();

    expect(() => sessions.open("resident-a", { windowId: "window-000001", context: null })).toThrow(
      WINDOW_REOPEN_INVALID,
    );

    // 内部发号是 w_ + ULID（图纸 §1.1）：被拒绝的外部 id 不占用、不影响发号，
    // 连开两窗各自唯一且进程内单调（字典序即开窗序）。
    const fresh = sessions.open("resident-a", { context: null });
    const second = sessions.open("resident-a", { context: null });
    expect(fresh.windowId).toMatch(/^w_[0-9A-Z]{26}$/);
    expect(fresh.generation).toBe(1);
    expect(second.windowId).not.toBe(fresh.windowId);
    expect(second.windowId > fresh.windowId).toBe(true);
  });

  it("归档窗不能被另一住户抢注，拒绝后原住户仍可按原 scope 重开", () => {
    const sessions = new SessionRegistry<null>();
    const archived = sessions.open("resident-a", { scopeId: "room-1", context: null });
    sessions.kill(archived.windowId);

    expect(() =>
      sessions.open("resident-b", {
        windowId: archived.windowId,
        scopeId: "room-1",
        context: null,
      }),
    ).toThrow(/resident mismatch/);
    expect(sessions.isArchived(archived.windowId)).toBe(true);

    const reopened = sessions.open("resident-a", {
      windowId: archived.windowId,
      scopeId: "room-1",
      context: null,
    });
    expect(reopened.generation).toBe(2);
  });

  it("归档窗只能按原 scope 重开，scope 不一致显式拒绝", () => {
    const sessions = new SessionRegistry<null>();
    const archived = sessions.open("resident-a", { scopeId: "room-1", context: null });
    sessions.kill(archived.windowId);

    expect(() =>
      sessions.open("resident-a", { windowId: archived.windowId, context: null }),
    ).toThrow(/scope mismatch/);
    expect(sessions.isArchived(archived.windowId)).toBe(true);
  });

  it("MV-A03 归档 append 到 JSONL，重启后仍可查询并按下一代重开", () => {
    const directory = mkdtempSync(join(tmpdir(), "mist-window-archive-"));
    const archivePath = join(directory, "windows.jsonl");
    try {
      const first = new SessionRegistry<null>({ archivePath });
      const window = first.open("resident-a", {
        scopeId: "room-1",
        headId: "node-1",
        context: null,
      });
      first.kill(window.windowId);

      const lines = readFileSync(archivePath, "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0] ?? "null")).toMatchObject({
        schemaVersion: 1,
        type: "window_opened",
        window: { windowId: window.windowId, generation: 1 },
      });
      expect(JSON.parse(lines[1] ?? "null")).toMatchObject({
        schemaVersion: 1,
        type: "window_archived",
        window: { windowId: window.windowId, generation: 1, headId: "node-1" },
      });

      const second = new SessionRegistry<null>({ archivePath });
      expect(second.getArchived(window.windowId)).toMatchObject({
        residentId: "resident-a",
        scopeId: "room-1",
        generation: 1,
        headId: "node-1",
      });
      const reopened = second.open("resident-a", {
        windowId: window.windowId,
        scopeId: "room-1",
        context: null,
      });
      expect(reopened.generation).toBe(2);
      second.kill(reopened.windowId);

      const third = new SessionRegistry<null>({ archivePath });
      expect(third.getArchived(window.windowId)?.generation).toBe(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("损坏的归档 JSONL 在启动时 fail loud", () => {
    const directory = mkdtempSync(join(tmpdir(), "mist-window-archive-corrupt-"));
    const archivePath = join(directory, "windows.jsonl");
    try {
      writeFileSync(archivePath, "not-json\n");
      expect(() => new SessionRegistry<null>({ archivePath })).toThrow(
        /invalid window archive JSONL at line 1/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("会话态归零不动住户留下的东西", () => {
    const residentState = {
      memories: ["答应过：周五晚上一起看电影"],
      messages: ["记住这件事"],
      relationships: ["一起看电影"],
    };
    const before = structuredClone(residentState);
    const sessions = new SessionRegistry<{ pending: string[] }>();

    const w1 = sessions.open("resident-a", {
      headId: "node-2",
      context: { pending: ["还没落库的话"] },
    });
    sessions.kill(w1.windowId);

    expect(sessions.get(w1.windowId)).toBeUndefined();
    expect(residentState).toEqual(before);
  });

  it("按住户枚举归档窗，不混入活窗或其他住户", () => {
    const sessions = new SessionRegistry<null>();
    const archivedA = sessions.open("resident-a", { context: null });
    const liveA = sessions.open("resident-a", { context: null });
    const archivedB = sessions.open("resident-b", { context: null });

    sessions.kill(archivedA.windowId);
    sessions.kill(archivedB.windowId);

    expect(sessions.archivedWindowsOf("resident-a")).toEqual([
      expect.objectContaining({ residentId: "resident-a", windowId: archivedA.windowId }),
    ]);
    expect(sessions.archivedWindowsOf("resident-a")).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ windowId: liveA.windowId }),
        expect.objectContaining({ windowId: archivedB.windowId }),
      ]),
    );
  });

  it("归档返回值是深副本，运行期变异不改权威记录或住户边界", () => {
    const sessions = new SessionRegistry<null>();
    const opened = sessions.open("resident-a", {
      scopeId: "room-1",
      headId: "node-1",
      context: null,
    });
    const killed = sessions.kill(opened.windowId);
    const fetched = sessions.getArchived(opened.windowId);
    const listed = sessions.archivedWindowsOf("resident-a")[0];

    expect(killed).toBeDefined();
    expect(fetched).toBeDefined();
    expect(listed).toBeDefined();
    for (const snapshot of [killed, fetched, listed]) {
      if (snapshot === undefined) throw new Error("expected archived snapshot");
      Object.assign(snapshot, {
        residentId: "resident-b",
        scopeId: "room-mutated",
        generation: 99,
        headId: "node-mutated",
      });
    }

    const expected = {
      residentId: "resident-a",
      windowId: opened.windowId,
      scopeId: "room-1",
      generation: 1,
      headId: "node-1",
      archived: true,
    };
    expect(sessions.getArchived(opened.windowId)).toEqual(expected);
    expect(sessions.archivedWindowsOf("resident-a")).toEqual([expected]);
    expect(sessions.archivedWindowsOf("resident-b")).toEqual([]);
    expect(sessions.kill(opened.windowId)).toEqual(expected);
  });
});

describe("SessionRegistry：贯穿场景（A01/A02/A03/B01/B02/B03 一口咬住）", () => {
  it("杀掉 w1 之后 w2 继续，w1 的迟到回执不落到 w2 身上", () => {
    const sessions = new SessionRegistry<null>();
    const w1 = sessions.open("resident-a", { context: null });
    const w2 = sessions.open("resident-a", { context: null });

    const r1 = sessions.issueDispatch(w1.windowId);
    const r2 = sessions.issueDispatch(w2.windowId);

    // 三元组齐全（MV-B03 的日志字段来源）
    for (const receipt of [r1, r2]) {
      expect(receipt).toMatchObject({ residentId: "resident-a" });
      expect(receipt.windowId).toBeTruthy();
      expect(receipt.generation).toBe(1);
      expect(receipt.dispatchId).toBeTruthy();
    }
    expect(r1.windowId).not.toBe(r2.windowId);

    sessions.kill(w1.windowId);

    // w1 的迟到回执不再属于任何活窗。
    // 这一条同时是「回到 residentId 单键查找」的回归闸：r1 的 residentId 与
    // generation 都和 w2 相同（同住户、同为第 1 代），旧实现按 residentId 查
    // 就会把它认成 w2 的回执；只有按 windowId 查才判得出来。
    expect(r1.residentId).toBe(w2.residentId);
    expect(r1.generation).toBe(w2.generation);
    expect(sessions.belongsToActiveWindow(r1)).toBe(false);

    // w2 完全不受影响——这一步是 MV-A02 的真正判据
    expect(sessions.isActive(w2.windowId)).toBe(true);
    expect(sessions.belongsToActiveWindow(r2)).toBe(true);
    sessions.setHead(w2.windowId, "reply-1");
    expect(sessions.get(w2.windowId)?.headId).toBe("reply-1");
    expect(sessions.issueDispatch(w2.windowId).generation).toBe(1);
  });

  it("同窗换代后旧代回执被丢弃", () => {
    const sessions = new SessionRegistry<null>();
    const w = sessions.open("resident-a", { context: null });
    const stale = sessions.issueDispatch(w.windowId);

    sessions.kill(w.windowId);
    const reopened = sessions.open("resident-a", { windowId: w.windowId, context: null });

    expect(reopened.generation).toBe(2);
    expect(sessions.belongsToActiveWindow(stale)).toBe(false);
    expect(sessions.belongsToActiveWindow(sessions.issueDispatch(w.windowId))).toBe(true);
  });

  it("同住户两窗各有各的 head，杀掉一扇不改另一扇（MV-A02 的 head 面）", () => {
    const sessions = new SessionRegistry<null>();
    const w1 = sessions.open("resident-a", { context: null });
    const w2 = sessions.open("resident-a", { context: null });

    sessions.setHead(w1.windowId, "node-w1");
    sessions.setHead(w2.windowId, "node-w2");
    expect(sessions.get(w1.windowId)?.headId).toBe("node-w1");
    expect(sessions.get(w2.windowId)?.headId).toBe("node-w2");

    sessions.kill(w1.windowId);

    // 共用一颗 head 的旧实现里，w1 的死会把 w2 的续话位置一起带走。
    expect(sessions.get(w2.windowId)?.headId).toBe("node-w2");
    expect(sessions.getArchived(w1.windowId)?.headId).toBe("node-w1");
  });

  it("回执三元组缺一不认：住户对不上也不算数", () => {
    const sessions = new SessionRegistry<null>();
    const w = sessions.open("resident-a", { context: null });
    const receipt = sessions.issueDispatch(w.windowId);

    expect(sessions.belongsToActiveWindow({ ...receipt, residentId: "resident-b" })).toBe(false);
    expect(sessions.belongsToActiveWindow({ ...receipt, generation: 99 })).toBe(false);
    expect(sessions.belongsToActiveWindow(receipt)).toBe(true);
  });
});
