import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ExternalChannelBindingStore,
  ExternalChannelHost,
  ExternalInboundStore,
  createExternalChannelPlugin,
} from "../src/external-channel/index.ts";
import { moduleRefFromSource } from "../src/plugin/module-ref.ts";
import { PluginOperationStore } from "../src/plugin/operation-store.ts";
import { PluginTransactionHost } from "../src/plugin/transaction-host.ts";
import { BreathCycle } from "../src/session/breath-cycle.ts";
import { SessionRegistry } from "../src/session/session-registry.ts";
import { FactLedger } from "../src/store/fact-ledger.ts";

interface Context {
  readonly notes: readonly string[];
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(nowValue = Date.parse("2026-09-18T00:00:00.000Z")) {
  const root = mkdtempSync(join(tmpdir(), "mist-external-channel-"));
  roots.push(root);
  let now = nowValue;
  const sessions = new SessionRegistry<Context>({ archivePath: join(root, "windows.jsonl") });
  const bindings = new ExternalChannelBindingStore({
    journalPath: join(root, "bindings.jsonl"),
    now: () => now,
  });
  const inbox = new ExternalInboundStore({
    journalPath: join(root, "inbound.jsonl"),
    maxQueuedItems: 2,
    maxAgeMs: 1_000,
    now: () => now,
  });
  const channel = new ExternalChannelHost({ sessions, bindings, inbox });
  channel.activate();
  return {
    root,
    sessions,
    bindings,
    inbox,
    channel,
    advance(ms: number) {
      now += ms;
    },
  };
}

const address = { pluginId: "fixture.channel", channelId: "owner-dm" } as const;

function bindResident(
  bindings: ExternalChannelBindingStore,
  residentId = "resident-a",
  scopeId = "private",
) {
  return bindings.bind({ residentId, scopeId, address });
}

describe("EC-A independent resident/scope binding ledger", () => {
  it("persists N:N bindings without viewport identity and revokes one atom with audit", () => {
    const { root, bindings } = fixture();
    const residentRecord = { id: "resident-a", displayName: "A" };
    bindResident(bindings);
    bindings.bind({
      residentId: "resident-a",
      scopeId: "private",
      address: { pluginId: "fixture.channel", channelId: "group-topic-7" },
    });
    expect(bindings.bindingsFor("resident-a", "private")).toHaveLength(2);
    expect(bindings.resolve(address)).toMatchObject({
      residentId: "resident-a",
      scopeId: "private",
    });

    bindings.revoke({ residentId: "resident-a", scopeId: "private", address }, "owner removed it");
    expect(bindings.resolve(address)).toBeUndefined();
    expect(residentRecord).toEqual({ id: "resident-a", displayName: "A" });
    expect(bindings.auditTrail("resident-a", "private").map((event) => event.operation)).toEqual([
      "bound",
      "bound",
      "revoked",
    ]);

    const bytes = readFileSync(join(root, "bindings.jsonl"), "utf8");
    expect(bytes).not.toMatch(/windowId|sessionId|session_id/);
    const restored = new ExternalChannelBindingStore({
      journalPath: join(root, "bindings.jsonl"),
      now: () => Date.parse("2026-09-18T00:00:01.000Z"),
    });
    expect(restored.resolve(address)).toBeUndefined();
    expect(restored.bindingsFor("resident-a", "private")).toHaveLength(1);
  });

  it("rejects an ambiguous reverse mapping", () => {
    const { bindings } = fixture();
    bindResident(bindings);
    expect(() => bindings.bind({ residentId: "resident-b", scopeId: "private", address })).toThrow(
      /already bound/,
    );
  });

  it("treats a revoked then rebound address as a new deduplication generation", () => {
    const { bindings, channel } = fixture();
    const firstBinding = bindResident(bindings);
    const first = channel.ingest({ ...address, externalMessageId: "same-id", body: "for A" });
    bindings.revoke({ residentId: "resident-a", scopeId: "private", address }, "move the address");
    const secondBinding = bindings.bind({
      residentId: "resident-b",
      scopeId: "private",
      address,
    });
    const second = channel.ingest({ ...address, externalMessageId: "same-id", body: "for B" });

    expect(firstBinding.bindingId).not.toBe(secondBinding.bindingId);
    expect(first).toMatchObject({ status: "queued", residentId: "resident-a" });
    expect(second).toMatchObject({
      status: "queued",
      residentId: "resident-b",
      duplicate: false,
    });
  });
});

describe("EC-B bounded queue with truthful receipts", () => {
  it("queues without a live window, stays out of memory, rejects at the bound, and expires", () => {
    const { bindings, channel, inbox, advance } = fixture();
    bindResident(bindings);
    const { ledger } = FactLedger.create();
    ledger.createLedger("resident-a");

    const first = channel.ingest({ ...address, externalMessageId: "m-1", body: "first" });
    const second = channel.ingest({ ...address, externalMessageId: "m-2", body: "second" });
    const full = channel.ingest({ ...address, externalMessageId: "m-3", body: "third" });
    expect(first).toMatchObject({ status: "queued", delivered: false });
    expect(second).toMatchObject({ status: "queued", delivered: false });
    expect(full).toMatchObject({ status: "rejected", reason: "QUEUE_FULL" });
    expect(ledger.entries("resident-a")).toEqual([]);
    expect(channel.factsForScope("resident-a", "private")).toEqual([]);
    expect(inbox.inspect("resident-a", "private").map((item) => item.status)).toEqual([
      "queued",
      "queued",
      "rejected",
    ]);

    advance(1_001);
    expect(inbox.inspect("resident-a", "private").map((item) => item.status)).toEqual([
      "expired",
      "expired",
      "rejected",
    ]);
  });

  it("opens no window on ingress and drains queued items in order when a window opens", () => {
    const { sessions, bindings, channel } = fixture();
    bindResident(bindings);
    channel.ingest({ ...address, externalMessageId: "m-1", body: "first" });
    channel.ingest({ ...address, externalMessageId: "m-2", body: "second" });
    expect(sessions.windowsOf("resident-a")).toEqual([]);

    const window = sessions.open("resident-a", { scopeId: "private", context: { notes: [] } });
    expect(channel.factsForWindow(window.windowId).map((fact) => fact.body)).toEqual([
      "first",
      "second",
    ]);
    const items = channel.inspect("resident-a", "private");
    expect(items.map((item) => item.status)).toEqual(["dispatched", "dispatched"]);
    expect(items.map((item) => item.dispatch?.windowId)).toEqual([
      window.windowId,
      window.windowId,
    ]);
  });
});

describe("EC-C scope facts and responder selection", () => {
  it("shows one fact to every scope window and gives exactly one recent window the six-field dispatch", () => {
    const { sessions, bindings, channel } = fixture();
    bindResident(bindings);
    const older = sessions.open("resident-a", { scopeId: "private", context: { notes: [] } });
    const newer = sessions.open("resident-a", { scopeId: "private", context: { notes: [] } });
    sessions.recordActivity(older.windowId);

    const receipt = channel.ingest({
      ...address,
      externalMessageId: "m-1",
      body: "shared fact",
    });
    expect(receipt.status).toBe("dispatched");
    if (receipt.status !== "dispatched") throw new Error("expected dispatch");
    expect(Object.keys(receipt.dispatch).sort()).toEqual([
      "dispatchId",
      "generation",
      "residentId",
      "scopeGeneration",
      "scopeId",
      "windowId",
    ]);
    expect(receipt.dispatch.windowId).toBe(older.windowId);
    expect(channel.factsForWindow(older.windowId)).toEqual(channel.factsForWindow(newer.windowId));
    expect(channel.factsForScope("resident-a", "private")).toHaveLength(1);

    const duplicate = channel.ingest({
      ...address,
      externalMessageId: "m-1",
      body: "mutated duplicate",
    });
    expect(duplicate).toMatchObject({ duplicate: true });
    expect(channel.factsForScope("resident-a", "private")).toHaveLength(1);
  });
});

describe("EC-D lifecycle independence", () => {
  it("keeps the resident/scope binding through breath and resolves the new generation live", async () => {
    const { sessions, bindings, channel } = fixture();
    bindResident(bindings);
    const before = sessions.open("resident-a", {
      scopeId: "private",
      context: { notes: [] },
    });
    const breath = new BreathCycle<Context>({
      registry: sessions,
      appendLetter: () => undefined,
      injectLetter: (context) => context,
      notify: () => undefined,
      now: () => "2026-09-18T00:00:00.000Z",
    });
    await breath.breathe(before.windowId, {
      title: "external binding survives breath",
      state: [{ tier: "fact", body: "binding belongs to resident scope" }],
      intent: [{ tier: "judgment", body: "resolve the live generation at ingress" }],
    });

    const receipt = channel.ingest({ ...address, externalMessageId: "after-breath", body: "hi" });
    expect(receipt).toMatchObject({
      status: "dispatched",
      dispatch: { windowId: before.windowId, generation: 2 },
    });
  });

  it("queues after kill and dispatches without rebinding when the same window reopens", () => {
    const { sessions, bindings, channel } = fixture();
    bindResident(bindings);
    const before = sessions.open("resident-a", {
      scopeId: "private",
      context: { notes: [] },
    });
    sessions.kill(before.windowId);
    expect(
      channel.ingest({ ...address, externalMessageId: "while-dead", body: "wait" }),
    ).toMatchObject({ status: "queued" });
    const reopened = sessions.open("resident-a", {
      scopeId: "private",
      windowId: before.windowId,
      context: { notes: [] },
    });
    expect(channel.inspect("resident-a", "private")[0]).toMatchObject({
      status: "dispatched",
      dispatch: { windowId: reopened.windowId, generation: 2 },
    });
  });

  it("restores binding and queued ingress across a host restart", () => {
    const first = fixture();
    bindResident(first.bindings);
    first.channel.ingest({ ...address, externalMessageId: "restart-m", body: "persist me" });
    first.channel.deactivate();

    const sessions = new SessionRegistry<Context>({
      archivePath: join(first.root, "windows.jsonl"),
    });
    const bindings = new ExternalChannelBindingStore({
      journalPath: join(first.root, "bindings.jsonl"),
      now: () => Date.parse("2026-09-18T00:00:00.500Z"),
    });
    const inbox = new ExternalInboundStore({
      journalPath: join(first.root, "inbound.jsonl"),
      maxQueuedItems: 2,
      maxAgeMs: 1_000,
      now: () => Date.parse("2026-09-18T00:00:00.500Z"),
    });
    const channel = new ExternalChannelHost({ sessions, bindings, inbox });
    channel.activate();
    const window = sessions.open("resident-a", { scopeId: "private", context: { notes: [] } });
    expect(channel.factsForWindow(window.windowId).map((fact) => fact.body)).toEqual([
      "persist me",
    ]);
  });

  it("uses the standard plugin connection lifecycle for reachability", async () => {
    const { root, sessions, bindings, inbox, channel } = fixture();
    channel.deactivate();
    bindResident(bindings);
    const pluginHost = new PluginTransactionHost({
      store: new PluginOperationStore(join(root, "plugin-operations")),
      newOperationId: () => "external-channel-operation",
    });
    const pluginId = "fixture.external-channel";
    const outcome = await pluginHost.activate({
      pluginId,
      moduleRef: moduleRefFromSource("fixture external channel module"),
      module: createExternalChannelPlugin(channel, { connectionId: "resident-channel" }),
      config: {},
      bindings: {},
      verifiedScope: null,
      env: {},
    });
    expect(outcome).toMatchObject({ state: "active" });
    sessions.open("resident-a", { scopeId: "private", context: { notes: [] } });
    expect(channel.ingest({ ...address, externalMessageId: "active", body: "on" }).status).toBe(
      "dispatched",
    );

    expect(await pluginHost.dispose(pluginId)).toMatchObject({ state: "disposed" });
    expect(
      channel.ingest({ ...address, externalMessageId: "disposed", body: "off" }),
    ).toMatchObject({ status: "rejected", reason: "CONNECTION_INACTIVE" });
  });
});
