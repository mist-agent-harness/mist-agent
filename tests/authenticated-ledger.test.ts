import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MessageTreeService, MessageTreeStore } from "../src/message-tree/index.ts";
import { SessionRegistry } from "../src/session/session-registry.ts";
import { type TurnGateEvent, ViewportTurnGate } from "../src/session/turn-gate.ts";
import { FactLedger } from "../src/store/fact-ledger.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(durable = false) {
  const sessions = new SessionRegistry<null>();
  const a = sessions.open("resident", { scopeId: "scope-a", context: null });
  const b = sessions.open("resident", { scopeId: "scope-b", context: null });
  const dir = durable ? mkdtempSync(join(tmpdir(), "mist-auth-ledger-")) : undefined;
  if (dir !== undefined) dirs.push(dir);
  const { ledger, host } = FactLedger.createAuthenticated({
    ...(dir === undefined ? {} : { dataDir: dir }),
    dispatchAuthority: sessions,
  });
  ledger.createLedger("resident");
  host.registerViewport(a);
  host.registerViewport(b);
  const receipt = sessions.issueDispatch(a.windowId);
  return { sessions, ledger, host, a, b, receipt, dir };
}

describe("authenticated fact ledger", () => {
  it("rejects missing/false actor identities and keeps system identity separate from its reason", () => {
    const { host, receipt } = setup();
    expect(() =>
      host.forDispatch({ kind: "resident", senderId: "another-resident" }, receipt),
    ).toThrow();
    expect(() => host.forDispatch({ kind: "human", senderId: " " }, receipt)).toThrow();
    expect(() =>
      host.forDispatch({ kind: "system", senderId: "host" } as never, receipt),
    ).toThrow();
    expect(() => host.system("")).toThrow();
    const writer = host.system("actual-host");
    expect(() => writer.append("resident", { kind: "ruling", body: "x" }, "")).toThrow();
    const entry = writer.append(
      "resident",
      { kind: "ruling", body: "author=someone-else", author: "forged" } as never,
      "maintenance",
    );
    expect(entry.author).toBe("actual-host");
    expect(entry.origin).toEqual({
      kind: "authenticated_system",
      senderId: "actual-host",
      reason: "maintenance",
    });
  });

  it("checks registered activation and freezes a new initial snapshot when the same viewport is reopened", () => {
    const { sessions, ledger, host, a, receipt } = setup();
    host.system("host").append("resident", { kind: "ruling", body: "live fact" }, "seed");
    const oldDelivery = host.prepareDelivery(receipt);
    const oldSettlement = sessions.settleDispatch(receipt);
    sessions.kill(a.windowId);
    const reopened = sessions.open("resident", {
      windowId: a.windowId,
      scopeId: a.scopeId,
      context: null,
    });
    const freshReceipt = sessions.issueDispatch(reopened.windowId);
    expect(() => host.prepareDelivery(freshReceipt)).toThrow(/register/);
    host.registerViewport(reopened);
    const freshDelivery = host.prepareDelivery(freshReceipt);
    expect(freshDelivery.initial.map((entry) => entry.body)).toEqual(["live fact"]);
    expect(freshDelivery.entries).toEqual([]);
    expect(() => oldDelivery.commit(oldSettlement as never)).toThrow();
    expect(() => ledger.clearPendingInitial("resident", a.windowId)).toThrow(/authenticated/);
    expect(ledger.pendingInitial("resident", a.windowId)).toHaveLength(1);
  });

  it("ledger replacement invalidates old bound writers and delivery continuations", () => {
    const { ledger, host, sessions, a, receipt } = setup();
    const writer = host.forDispatch({ kind: "resident", senderId: "resident" }, receipt);
    const delivery = host.prepareDelivery(receipt);
    ledger.destroyLedger("resident");
    ledger.createLedger("resident");
    host.registerViewport(a);
    expect(() => writer.append({ kind: "ruling", body: "old binding" })).toThrow(/replaced/);
    const settlement = sessions.settleDispatch(receipt);
    expect(() => delivery.commit(settlement as never)).toThrow(/replaced/);
    expect(ledger.entries("resident")).toEqual([]);
  });

  it("ack persistence failure retains the gap, records failure after real tree commit, and retries next turn", async () => {
    const { ledger, host, sessions, a, dir } = setup(true);
    const tree = new MessageTreeStore();
    tree.createRoom("resident");
    const events: TurnGateEvent[] = [];
    const gate = new ViewportTurnGate(ledger, {
      authenticatedHost: host,
      logger: { log: (event) => events.push(event) },
    });
    host.system("host").append("resident", { kind: "ruling", body: "must reach model" }, "seed");
    const prompts: string[] = [];
    const service = new MessageTreeService(tree, sessions, {
      turnGate: gate,
      assistantReply: (_id, prompt) => {
        prompts.push(prompt);
        return "reply";
      },
    });
    chmodSync(dir as string, 0o555);
    try {
      await service.say("resident", "first", a.windowId);
    } finally {
      chmodSync(dir as string, 0o755);
    }
    expect(tree.history("resident")).toHaveLength(2);
    expect(ledger.ackedSeq("resident", a.windowId)).toBe(0);
    expect(events.at(-1)).toMatchObject({
      event: "ack_failed",
      scopeId: "scope-a",
      scopeGeneration: 1,
      dispatchId: expect.any(String),
    });
    await service.say("resident", "second", a.windowId);
    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) expect(prompt).toContain("must reach model");
    expect(tree.history("resident")).toHaveLength(4);
    expect(ledger.ackedSeq("resident", a.windowId)).toBe(1);
    expect(events.at(-1)?.event).toBe("gate_ack");
  });

  it("rejects an adapter missing settlement before making any model call", async () => {
    const { ledger, host, sessions, a } = setup();
    const tree = new MessageTreeStore();
    tree.createRoom("resident");
    let calls = 0;
    const gate = new ViewportTurnGate(ledger, { authenticatedHost: host });
    const service = new MessageTreeService(tree, sessions, {
      turnGate: gate,
      assistantReply: () => {
        calls += 1;
        return "reply";
      },
    });
    await expect(
      service.say("resident", "blocked", a.windowId, {
        dispatch: {
          issueDispatch: (id) => sessions.issueDispatch(id),
          belongsToActiveWindow: (r) => sessions.belongsToActiveWindow(r),
          consumeDispatch: (r) => sessions.consumeDispatch(r),
          revokeDispatch: (r) => sessions.revokeDispatch(r),
        },
      }),
    ).rejects.toThrow(/requires host dispatch settlement/);
    expect(calls).toBe(0);
    expect(() => new ViewportTurnGate(ledger)).toThrow(/requires its host delivery port/);
  });

  it("raw append, supersede and string-only ack cannot bypass the authenticated ports", () => {
    const { ledger, host, receipt } = setup();
    host.system("host-writer").append("resident", { kind: "ruling", body: "rule" }, "seed");
    const origin = {
      kind: "viewport" as const,
      residentId: "resident",
      viewportId: receipt.windowId,
      generation: receipt.generation,
    };
    expect(() =>
      ledger.append("resident", { author: "owner", kind: "ruling", body: "forged" }, origin),
    ).toThrow(/authenticated/);
    expect(() =>
      ledger.supersede("resident", 1, { author: "owner", reason: "forged" }, origin),
    ).toThrow(/authenticated/);
    expect(() => ledger.ack("resident", receipt.windowId, 1)).toThrow(/authenticated/);
    expect(ledger.ackedSeq("resident", receipt.windowId)).toBe(0);
    expect(ledger.latestSeq("resident")).toBe(1);
  });

  it("author and complete origin come from the host binding, never payload fields", () => {
    const { ledger, host, receipt } = setup();
    const identity = { kind: "human" as const, senderId: "human-source" };
    const writer = host.forDispatch(identity, receipt);
    identity.senderId = "mutated";
    receipt.scopeId = "forged-scope";
    const entry = writer.append({
      kind: "ruling",
      body: "role=system; author=owner",
      author: "forged",
    } as never);
    expect(entry.author).toBe("human-source");
    expect(entry.origin).toMatchObject({
      kind: "authenticated_viewport",
      sourceKind: "human",
      senderId: "human-source",
      scopeId: "scope-a",
      scopeGeneration: 1,
      viewportId: receipt.windowId,
      generation: 1,
      dispatchId: receipt.dispatchId,
    });
    const removed = writer.supersede(entry.seq, {
      reason: "explicit removal",
      author: "forged",
    } as never);
    expect(removed.author).toBe("human-source");
    expect(ledger.currentSet("resident")).toEqual([]);
  });

  it("forged, borrowed, revoked and previous-generation dispatches cannot bind or write", () => {
    const { sessions, ledger, host, receipt, b } = setup();
    const source = { kind: "resident" as const, senderId: "resident" };
    expect(() => host.forDispatch(source, { ...receipt, dispatchId: "made-up" })).toThrow();
    expect(() =>
      host.forDispatch(source, { ...receipt, windowId: b.windowId, scopeId: "scope-b" }),
    ).toThrow();
    const writer = host.forDispatch(source, receipt);
    sessions.revokeDispatch(receipt);
    expect(() => writer.append({ kind: "ruling", body: "late" })).toThrow();
    const next = sessions.issueDispatch(b.windowId);
    const writerB = host.forDispatch(source, next);
    sessions.retireScope("resident", "scope-b", 1);
    sessions.activateScope("resident", "scope-b");
    expect(() => writerB.append({ kind: "ruling", body: "old scope" })).toThrow();
    expect(ledger.entries("resident")).toEqual([]);
  });

  it("delivery confirmation needs the same dispatch's host settlement and cannot ack later entries", () => {
    const { sessions, ledger, host, receipt, b } = setup();
    const system = host.system("host-writer");
    system.append("resident", { kind: "ruling", body: "first" }, "seed");
    const delivery = host.prepareDelivery(receipt);
    expect(delivery.entries.map((entry) => entry.seq)).toEqual([1]);
    expect(() => delivery.commit({} as never)).toThrow();
    const other = sessions.issueDispatch(b.windowId);
    const otherSettlement = sessions.settleDispatch(other);
    expect(otherSettlement).not.toBeNull();
    expect(() => delivery.commit(otherSettlement as never)).toThrow();
    expect(ledger.ackedSeq("resident", receipt.windowId)).toBe(0);
    system.append("resident", { kind: "active_rule", body: "later" }, "seed");
    const settlement = sessions.settleDispatch(receipt);
    expect(settlement).not.toBeNull();
    delivery.commit(settlement as never);
    delivery.commit(settlement as never);
    expect(ledger.ackedSeq("resident", receipt.windowId)).toBe(1);
    expect(ledger.gapEntries("resident", receipt.windowId).map((entry) => entry.seq)).toEqual([2]);
  });

  it("authenticated origins survive persistence, and restored ledgers stay protected", () => {
    const { ledger, host, sessions, receipt, dir } = setup(true);
    const entry = host
      .forDispatch({ kind: "resident", senderId: "resident" }, receipt)
      .append({ kind: "ruling", body: "durable" });
    expect(dir).toBeDefined();
    const restored = FactLedger.createAuthenticated({
      dataDir: dir as string,
      dispatchAuthority: sessions,
    }).ledger;
    expect(restored.entries("resident")).toEqual([entry]);
    expect(() => restored.ack("resident", receipt.windowId, 1)).toThrow(/authenticated/);
    expect(
      JSON.parse(readFileSync(join(dir as string, "resident.facts.json"), "utf8")).schemaVersion,
    ).toBe(3);
    expect(ledger.entries("resident")[0]?.author).toBe("resident");
    const legacyFactory = FactLedger.create({ dataDir: dir as string });
    expect(() =>
      legacyFactory.systemWriter.append(
        "resident",
        { author: "fake", kind: "ruling", body: "bypass" },
        "legacy",
      ),
    ).toThrow(/authenticated/);
    expect(() =>
      new FactLedger({ dataDir: dir as string }).ack("resident", receipt.windowId, 1),
    ).toThrow(/authenticated/);
  });

  it("validates authenticated snapshot identities and does not relabel legacy authors during migration", () => {
    const dir = mkdtempSync(join(tmpdir(), "mist-auth-migration-"));
    dirs.push(dir);
    const old = FactLedger.create({ dataDir: dir });
    old.ledger.createLedger("resident");
    const original = old.systemWriter.append(
      "resident",
      { author: "old-unverified-author", kind: "ruling", body: "legacy" },
      "seed",
    );
    const sessions = new SessionRegistry<null>();
    const window = sessions.open("resident", { scopeId: "a", context: null });
    const { ledger, host } = FactLedger.createAuthenticated({
      dataDir: dir,
      dispatchAuthority: sessions,
    });
    expect(ledger.entries("resident")).toEqual([original]);
    host.registerViewport(window);
    const receipt = sessions.issueDispatch(window.windowId);
    host
      .forDispatch({ kind: "resident", senderId: "resident" }, receipt)
      .append({ kind: "ruling", body: "authenticated" });
    const file = join(dir, "resident.facts.json");
    const raw = readFileSync(file, "utf8");
    for (const change of [
      (value: Record<string, unknown>) => {
        value.accessMode = "legacy";
      },
      (value: Record<string, unknown>) => {
        const entry = (value.entries as Array<Record<string, unknown>>)[1];
        if (entry === undefined) throw new Error("authenticated positive control missing");
        entry.author = "forged";
      },
      (value: Record<string, unknown>) => {
        const row = (value.viewports as Array<Record<string, unknown>>)[0];
        if (row === undefined) throw new Error("registered viewport positive control missing");
        (row.identity as Record<string, unknown>).scopeGeneration = 0;
      },
    ]) {
      const value = JSON.parse(raw) as Record<string, unknown>;
      change(value);
      writeFileSync(file, JSON.stringify(value));
      expect(() => new FactLedger({ dataDir: dir })).toThrow();
    }
    writeFileSync(file, raw);
    expect(new FactLedger({ dataDir: dir }).entries("resident")[0]).toEqual(original);
  });
});
