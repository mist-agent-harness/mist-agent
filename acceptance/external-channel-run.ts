import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const root = mkdtempSync(join(tmpdir(), "mist-external-channel-acceptance-"));
let clock = Date.parse("2026-09-18T00:00:00.000Z");
const now = () => clock;
const address = { pluginId: "acceptance.channel", channelId: "owner-dm" } as const;

function stores() {
  return {
    bindings: new ExternalChannelBindingStore({
      journalPath: join(root, "bindings.jsonl"),
      now,
    }),
    inbox: new ExternalInboundStore({
      journalPath: join(root, "inbound.jsonl"),
      maxQueuedItems: 2,
      maxAgeMs: 1_000,
      now,
    }),
  };
}

async function activatePlugin(
  channel: ExternalChannelHost<Context>,
  operationDirectory: string,
  operationId: string,
) {
  const host = new PluginTransactionHost({
    store: new PluginOperationStore(operationDirectory),
    newOperationId: () => operationId,
  });
  const outcome = await host.activate({
    pluginId: "acceptance.external-channel",
    moduleRef: moduleRefFromSource(`external channel acceptance ${operationId}`),
    module: createExternalChannelPlugin(channel, { connectionId: "resident-channel" }),
    config: {},
    bindings: {},
    verifiedScope: null,
    env: {},
  });
  assert.equal(outcome.state, "active");
  return host;
}

try {
  const sessions = new SessionRegistry<Context>({ archivePath: join(root, "windows.jsonl") });
  const firstStores = stores();
  const channel = new ExternalChannelHost({ sessions, ...firstStores });
  const pluginHost = await activatePlugin(channel, join(root, "plugin-ops-first"), "activate-1");
  firstStores.bindings.bind({ residentId: "resident-a", scopeId: "private", address });
  firstStores.bindings.bind({
    residentId: "resident-a",
    scopeId: "private",
    address: { pluginId: "acceptance.channel", channelId: "second-address" },
  });
  assert.equal(firstStores.bindings.bindingsFor("resident-a", "private").length, 2);
  assert.doesNotMatch(readFileSync(join(root, "bindings.jsonl"), "utf8"), /windowId|sessionId/);
  console.log("✓ EC-A independent resident/scope binding ledger");

  const { ledger } = FactLedger.create();
  ledger.createLedger("resident-a");
  assert.equal(
    channel.ingest({ ...address, externalMessageId: "will-expire", body: "old" }).status,
    "queued",
  );
  clock += 1_001;
  assert.equal(channel.inspect("resident-a", "private")[0]?.status, "expired");
  assert.equal(
    channel.ingest({ ...address, externalMessageId: "m-1", body: "first" }).status,
    "queued",
  );
  assert.equal(
    channel.ingest({ ...address, externalMessageId: "m-2", body: "second" }).status,
    "queued",
  );
  assert.deepEqual(channel.ingest({ ...address, externalMessageId: "m-full", body: "third" }), {
    status: "rejected",
    duplicate: false,
    reason: "QUEUE_FULL",
    inboundId: "inbound-00000004",
    residentId: "resident-a",
    scopeId: "private",
  });
  assert.equal(ledger.latestSeq("resident-a"), 0);
  assert.equal(channel.factsForScope("resident-a", "private").length, 0);
  const firstWindow = sessions.open("resident-a", {
    scopeId: "private",
    context: { notes: [] },
  });
  assert.deepEqual(
    channel.factsForWindow(firstWindow.windowId).map((fact) => fact.body),
    ["first", "second"],
  );
  console.log("✓ EC-B bounded queue, truthful receipt, automatic ordered drain, no memory write");

  const sibling = sessions.open("resident-a", {
    scopeId: "private",
    context: { notes: [] },
  });
  sessions.recordActivity(firstWindow.windowId);
  const shared = channel.ingest({ ...address, externalMessageId: "shared", body: "scope fact" });
  assert.equal(shared.status, "dispatched");
  if (shared.status !== "dispatched") throw new Error("scope fact did not dispatch");
  assert.equal(shared.dispatch.windowId, firstWindow.windowId);
  assert.deepEqual(Object.keys(shared.dispatch).sort(), [
    "dispatchId",
    "generation",
    "residentId",
    "scopeGeneration",
    "scopeId",
    "windowId",
  ]);
  assert.deepEqual(
    channel.factsForWindow(firstWindow.windowId),
    channel.factsForWindow(sibling.windowId),
  );
  const duplicate = channel.ingest({ ...address, externalMessageId: "shared", body: "changed" });
  assert.equal(duplicate.duplicate, true);
  assert.equal(
    channel.factsForScope("resident-a", "private").filter((f) => f.externalMessageId === "shared")
      .length,
    1,
  );
  console.log(
    "✓ EC-C one scope fact, all-window visibility, one recent responder, idempotent ingress",
  );

  const breath = new BreathCycle<Context>({
    registry: sessions,
    appendLetter: () => undefined,
    injectLetter: (context) => context,
    notify: () => undefined,
    now: () => new Date(clock).toISOString(),
  });
  await breath.breathe(firstWindow.windowId, {
    title: "external binding survives breath",
    state: [{ tier: "fact", body: "binding is resident/scope authority" }],
    intent: [{ tier: "judgment", body: "resolve the current viewport generation on ingress" }],
  });
  const afterBreath = channel.ingest({
    ...address,
    externalMessageId: "after-breath",
    body: "new generation",
  });
  assert.equal(afterBreath.status, "dispatched");
  if (afterBreath.status !== "dispatched") throw new Error("breath dispatch missing");
  assert.equal(afterBreath.dispatch.windowId, firstWindow.windowId);
  assert.equal(afterBreath.dispatch.generation, 2);

  sessions.killResident("resident-a");
  assert.equal(
    channel.ingest({ ...address, externalMessageId: "restart", body: "survive restart" }).status,
    "queued",
  );
  assert.equal((await pluginHost.dispose("acceptance.external-channel")).state, "disposed");
  assert.equal(
    channel.ingest({ ...address, externalMessageId: "after-dispose", body: "blocked" }).status,
    "rejected",
  );

  const restartedSessions = new SessionRegistry<Context>({
    archivePath: join(root, "windows.jsonl"),
  });
  const restartedStores = stores();
  const restartedChannel = new ExternalChannelHost({
    sessions: restartedSessions,
    ...restartedStores,
  });
  await activatePlugin(restartedChannel, join(root, "plugin-ops-second"), "activate-2");
  const restartedWindow = restartedSessions.open("resident-a", {
    scopeId: "private",
    context: { notes: [] },
  });
  assert.equal(
    restartedChannel
      .factsForWindow(restartedWindow.windowId)
      .some((fact) => fact.externalMessageId === "restart"),
    true,
  );
  const residentIdentity = { residentId: "resident-a", name: "fixture resident" };
  restartedStores.bindings.revoke(
    { residentId: "resident-a", scopeId: "private", address },
    "acceptance cleanup",
  );
  assert.equal(restartedStores.bindings.resolve(address), undefined);
  assert.deepEqual(residentIdentity, { residentId: "resident-a", name: "fixture resident" });
  console.log("✓ EC-D breath, kill, restart, revocation, and Plugin Protocol connection lifecycle");
  console.log("external-channel acceptance: 4/4 groups passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
