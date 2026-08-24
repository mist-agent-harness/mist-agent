import { describe, expect, it } from "vitest";
import {
  InMemoryIsolationPresenceStore,
  IntentionalIsolation,
  IsolationCreateError,
  type IsolationPresenceStore,
} from "../src/isolation/intentional-isolation.ts";
import { MessageTreeService } from "../src/message-tree/service.ts";
import { MessageTreeStore } from "../src/message-tree/store.ts";
import { SessionRegistry } from "../src/session/session-registry.ts";
import { ResidentStore } from "../src/store/resident-store.ts";

function fixture(options: { presenceStore?: IsolationPresenceStore } = {}) {
  const residents = new ResidentStore();
  const residentId = residents.createResident("resident-a");
  const sessions = new SessionRegistry<null>();
  const origin = sessions.open(residentId, {
    scopeId: "private",
    context: null,
  });
  const isolation = new IntentionalIsolation(residents, sessions, {
    scopeIdFactory: () => "scope_project",
    now: () => "2026-08-24T01:30:00.000Z",
    ...(options.presenceStore === undefined ? {} : { presenceStore: options.presenceStore }),
  });
  return { residents, residentId, sessions, origin, isolation };
}

describe("IntentionalIsolation B1", () => {
  it("从现役来源窗创建，住户身份继承且登记完成后即可在隔离窗工作", async () => {
    const { residentId, sessions, origin, isolation } = fixture();

    const created = isolation.create(origin.windowId, {
      name: "Kafka reading",
      context: null,
    });

    expect(created).toEqual({
      residentId,
      scopeId: "scope_project",
      name: "Kafka reading",
      status: "ready",
      source: { scopeId: "private", windowId: origin.windowId },
      entryWindowId: created.entryWindowId,
      createdAt: "2026-08-24T01:30:00.000Z",
    });
    expect(sessions.get(created.entryWindowId)).toMatchObject({
      residentId,
      scopeId: "scope_project",
      generation: 1,
    });
    expect(isolation.sharedState(residentId)).toEqual([created]);

    const tree = new MessageTreeStore();
    tree.createRoom(residentId);
    const prompts: string[] = [];
    const service = new MessageTreeService(tree, sessions, {
      turnGate: isolation,
      assistantReply: (_residentId, prompt) => {
        prompts.push(prompt);
        return "working";
      },
    });
    await service.say(residentId, "first isolated input", created.entryWindowId);
    expect(prompts).toEqual(["first isolated input"]);
  });

  it("来源窗无效、住户不存在或名称为空都在开新窗前显式拒绝", () => {
    const { residents, residentId, sessions, origin, isolation } = fixture();
    sessions.kill(origin.windowId);

    expect(() => isolation.create(origin.windowId, { name: "x", context: null })).toThrow(
      /origin window is not active/,
    );
    expect(sessions.windowsOf(residentId)).toHaveLength(0);

    const foreignSessions = new SessionRegistry<null>();
    const orphan = foreignSessions.open("missing-resident", { context: null });
    const foreign = new IntentionalIsolation(residents, foreignSessions);
    expect(() => foreign.create(orphan.windowId, { name: "x", context: null })).toThrow(
      /resident does not exist/,
    );

    const live = sessions.open(residentId, { context: null });
    expect(() => isolation.create(live.windowId, { name: "   ", context: null })).toThrow(
      /name must not be empty/,
    );
    expect(sessions.windowsOf(residentId)).toHaveLength(1);
  });

  it("住户级登记失败时不返回假成功，新窗被归档且共享投影为空", () => {
    const underlying = new InMemoryIsolationPresenceStore();
    const failing: IsolationPresenceStore = {
      create() {
        throw new Error("resident projection unavailable");
      },
      list: (residentId) => underlying.list(residentId),
      eventsAfter: (residentId, seq) => underlying.eventsAfter(residentId, seq),
    };
    const { residentId, sessions, origin, isolation } = fixture({ presenceStore: failing });

    let error: unknown;
    try {
      isolation.create(origin.windowId, { name: "will fail", context: null });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(IsolationCreateError);
    expect(String(error)).toContain("ISOLATION_CREATE_FAILED");
    expect(isolation.sharedState(residentId)).toEqual([]);
    expect(sessions.windowsOf(residentId)).toEqual([origin]);
  });
});

describe("IntentionalIsolation B3", () => {
  it("共享状态同步可见；当前生成不被打断，下一次 dispatch 才收存在信封", async () => {
    const { residentId, sessions, origin, isolation } = fixture();
    const tree = new MessageTreeStore();
    tree.createRoom(residentId);

    let release: (() => void) | undefined;
    const firstReplyCanFinish = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prompts: string[] = [];
    let call = 0;
    const service = new MessageTreeService(tree, sessions, {
      turnGate: isolation,
      assistantReply: async (_residentId, prompt) => {
        prompts.push(prompt);
        call += 1;
        if (call === 1) await firstReplyCanFinish;
        return `reply-${call}`;
      },
    });

    const inFlight = service.say(residentId, "already running", origin.windowId);
    await viWaitFor(() => prompts.length === 1);

    const created = isolation.create(origin.windowId, {
      name: "isolated work",
      context: null,
    });
    expect(isolation.sharedState(residentId)).toHaveLength(1);
    expect(sessions.get(origin.windowId)?.generation).toBe(1);
    expect(prompts[0]).toBe("already running");

    release?.();
    await inFlight;
    await service.say(residentId, "next dispatch", origin.windowId);

    expect(prompts[1]).toContain("[scope-presence]");
    expect(prompts[1]).toContain(created.scopeId);
    expect(prompts[1]).not.toContain("already running");
    const history = tree.history(residentId);
    expect(
      history.find((node) => node.role === "user" && node.content === "next dispatch"),
    ).toBeTruthy();
    expect(history.some((node) => node.content.includes("[scope-presence]"))).toBe(false);

    await service.say(residentId, "after ack", origin.windowId);
    expect(prompts[2]).toBe("after ack");
  });

  it("信封只带存在与来源，不带隔离 context；失败回合不确认，下一轮重送", async () => {
    const { residentId, sessions, origin, isolation } = fixture();
    isolation.create(origin.windowId, {
      name: "private project",
      context: null,
    });
    const first = isolation.beforeTurn(residentId, origin.windowId);

    expect(first.contextPrefix).toHaveLength(1);
    const raw = first.contextPrefix[0] ?? "";
    expect(raw).toContain("scope_project");
    expect(raw).toContain("private project");
    expect(raw).not.toContain('"context"');
    expect(raw).not.toContain('"entryWindowId"');

    const retry = isolation.beforeTurn(residentId, origin.windowId);
    expect(retry.contextPrefix).toEqual(first.contextPrefix);
    retry.commit();
    expect(isolation.beforeTurn(residentId, origin.windowId).contextPrefix).toEqual([]);
  });
});

async function viWaitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
