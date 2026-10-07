import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Result } from "../acceptance/resident-runtime-driver.ts";
import { CanonicalStreamStore } from "../src/one-stream/store.ts";
import { CanonicalStreamWriter } from "../src/one-stream/writer.ts";
import type { ModelCompletionRequest, ModelTransport } from "../src/resident-runtime/channels.ts";
import { ResidentRuntime } from "../src/resident-runtime/runtime.ts";
import { ResidentChatTui } from "../src/resident-runtime/tui.ts";

const roots: string[] = [];
const runtimes: ResidentRuntime[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}
function make(ledger: boolean, residentId: string) {
  const dataDir = mkdtempSync(join(tmpdir(), "mist-recovery-audit-"));
  roots.push(dataDir);
  const requests: ModelCompletionRequest[] = [];
  let ackFaultArmed = false;
  let receiptFaultArmed = false;
  const blockedReceipt = join(dataDir, "turns", `${residentId}.turns.json.tmp`);
  const blockedAck = join(dataDir, "residents", `${residentId}.facts.json.tmp`);
  const transport: ModelTransport = {
    async *complete(request) {
      requests.push(request);
      yield `audit reply ${requests.length}`;
      if (receiptFaultArmed) {
        receiptFaultArmed = false;
        mkdirSync(blockedReceipt);
      }
      if (ackFaultArmed) {
        ackFaultArmed = false;
        mkdirSync(blockedAck);
      }
    },
  };
  const options = {
    dataDir,
    transport,
    ...(ledger ? { ledger: { dataDir: join(dataDir, "residents") } } : {}),
  };
  const open = () => {
    const runtime = new ResidentRuntime(options);
    runtimes.push(runtime);
    return runtime;
  };
  const runtime = open();
  const candidate = runtime.createCandidate({
    residentId,
    persona: "synthetic audit persona",
    proposedBy: { kind: "installer", id: "audit" },
  });
  expect(
    runtime.attestCandidate(
      candidate.candidateId,
      { kind: "candidate", candidateId: candidate.candidateId },
      "accepted",
    ).ok,
  ).toBe(true);
  unwrap(
    runtime.provisionChannel({
      residentId,
      channel: { claudeSubscription: false, credentialKind: "api-key", model: "audit-model" },
      canarySecret: "synthetic-audit-only",
    }),
  );
  return {
    runtime,
    residentId,
    dataDir,
    requests,
    open,
    armAckFailure: () => {
      ackFaultArmed = true;
    },
    repairAck: () => rmSync(blockedAck, { recursive: true }),
    armReceiptFailure: () => {
      receiptFaultArmed = true;
    },
    repairReceipt: () => rmSync(blockedReceipt, { recursive: true }),
  };
}
type Fixture = ReturnType<typeof make>;
function stream(f: Fixture) {
  return JSON.parse(
    readFileSync(join(f.dataDir, "streams", `${f.residentId}.stream.json`), "utf8"),
  ) as {
    events: {
      payload: { role: string; text: string; turnId: string };
      origin: { viewport: { windowId: string; generation: number } };
    }[];
  };
}
function book(f: Fixture) {
  return JSON.parse(
    readFileSync(join(f.dataDir, "residents", `${f.residentId}.facts.json`), "utf8"),
  ) as {
    entries: { seq: number }[];
    viewports: {
      viewportId: string;
      baselineSeq: number;
      ackedSeq: number;
      identity: { generation: number };
    }[];
  };
}
function addFact(runtime: ResidentRuntime, residentId: string, body: string) {
  const authority = runtime.ledgerAuthority();
  if (authority === null) throw new Error("Missing authenticated ledger");
  return authority.host
    .system("audit-host")
    .append(residentId, { kind: "active_rule", body }, "synthetic audit fixture");
}
async function failedAckTurn(f: Fixture, turnId?: string) {
  unwrap(await f.runtime.say({ residentId: f.residentId, text: "open window" }));
  addFact(f.runtime, f.residentId, "fact visible to failed turn");
  f.armAckFailure();
  const request = {
    residentId: f.residentId,
    text: "turn whose ack fails",
    ...(turnId === undefined ? {} : { turnId }),
  };
  const failure = await f.runtime.say(request);
  expect(failure).toMatchObject({ ok: false, error: { code: "writer-unavailable" } });
  expect(stream(f).events).toHaveLength(4);
  expect(book(f).viewports[0]?.ackedSeq).toBe(0);
  f.repairAck();
  return { request, failure };
}
function blockAssistantAfterUser(f: Fixture) {
  const original = CanonicalStreamStore.prototype.append;
  const blocker = join(f.dataDir, "streams", `${f.residentId}.stream.json.tmp`);
  let armed = true;
  const spy = vi.spyOn(CanonicalStreamStore.prototype, "append").mockImplementation(function (
    this: CanonicalStreamStore,
    input,
  ) {
    const receipt = original.call(this, input);
    if (armed && input.residentId === f.residentId && input.draft.payload.role === "user") {
      armed = false;
      // User is truly durable; the next real fs.openSync for assistant hits EISDIR.
      mkdirSync(blocker);
    }
    return receipt;
  });
  return () => {
    spy.mockRestore();
    rmSync(blocker, { recursive: true });
  };
}

describe("Resident turn recovery", () => {
  it.each([false, true])(
    "confirmed turn replays across close/reopen without a model call (ledger=%s)",
    async (ledger) => {
      const f = make(ledger, "r-control");
      const request = { residentId: f.residentId, text: "complete me", turnId: "control-turn" };
      const first = unwrap(await f.runtime.say(request));
      expect(unwrap(await f.runtime.say(request))).toEqual(first);
      await f.runtime.close();
      const reopened = f.open();
      expect(unwrap(await reopened.say(request))).toEqual(first);
      expect(f.requests).toHaveLength(1);
      expect(stream(f).events).toHaveLength(2);
    },
  );

  it("same-turn replay must remain incomplete until its ledger target is acknowledged", async () => {
    const f = make(true, "r-ack-replay");
    const { request } = await failedAckTurn(f, "fixed-turn");
    addFact(f.runtime, f.residentId, "later fact not seen by failed turn");
    const replay = await f.runtime.say(request);
    const afterReplay = book(f);
    expect
      .soft(
        replay.ok,
        "stream-complete is insufficient while original ledger target is unacknowledged",
      )
      .toBe(false);
    expect(f.requests).toHaveLength(2);
    expect(afterReplay.viewports[0]?.ackedSeq).toBe(0);
    expect(f.requests[1]?.bootPack.currentFacts?.map((fact) => fact.body)).not.toContain(
      "later fact not seen by failed turn",
    );
    unwrap(await f.runtime.say({ residentId: f.residentId, text: "legitimate later delivery" }));
    const recovered = await f.runtime.say(request);
    expect(recovered).toMatchObject({ ok: true, value: { reply: "audit reply 2" } });
    expect(book(f).viewports[0]?.ackedSeq).toBe(2);
    expect(f.requests.filter((r) => r.text === request.text)).toHaveLength(1);
  });

  it("close/reopen must retain the incomplete ledger distinction", async () => {
    const f = make(true, "r-ack-restart");
    const { request } = await failedAckTurn(f, "restart-turn");
    await f.runtime.close();
    const reopened = f.open();
    const replay = await reopened.say(request);
    expect
      .soft(
        replay.ok,
        "reloaded durable stream must not erase an unacknowledged ledger postcondition",
      )
      .toBe(false);
    expect(book(f).viewports[0]?.ackedSeq).toBe(0);
    expect(f.requests).toHaveLength(2);
    addFact(reopened, f.residentId, "new generation baseline");
    unwrap(await reopened.say({ residentId: f.residentId, text: "open successor window" }));
    expect(book(f).viewports.at(-1)).toMatchObject({ baselineSeq: 2, ackedSeq: 2 });
    expect(await reopened.say(request)).toMatchObject({
      ok: false,
      error: { code: "reconciliation-needed" },
    });
    expect(book(f).viewports[0]?.identity.generation).toBe(2);
    expect(f.requests.filter((r) => r.text === request.text)).toHaveLength(1);
  });

  it("generated retry anchor must be available on a post-write failure", async () => {
    const f = make(true, "r-generated-anchor");
    const { failure } = await failedAckTurn(f);
    const durableId = stream(f).events.at(-1)?.payload.turnId;
    expect(typeof durableId).toBe("string");
    const returnedAnchor = !failure.ok ? failure.error.turnId : undefined;
    expect
      .soft(returnedAnchor, "caller needs the runtime-generated retry identity")
      .toBe(durableId);
  });

  it("real TUI retry of a post-write failure must reuse the failed turn", async () => {
    const f = make(true, "r-tui-retry");
    const tui = new ResidentChatTui(f.runtime, { residentId: f.residentId, model: "audit-model" });
    unwrap(await tui.submit("open window"));
    addFact(f.runtime, f.residentId, "TUI fact");
    f.armAckFailure();
    const first = await tui.submit("same failed message");
    expect(first).toMatchObject({ ok: false, error: { code: "writer-unavailable" } });
    const originalTurnId = stream(f).events.at(-1)?.payload.turnId;
    f.repairAck();
    const retried = await tui.retry();
    expect(retried).toMatchObject({
      ok: false,
      error: { code: "reconciliation-needed", turnId: originalTurnId },
    });
    expect(
      tui
        .transcript()
        .frames.at(-1)
        ?.text.match(/你：same failed message/g),
    ).toHaveLength(1);
    const events = stream(f).events;
    const sameTextRequests = f.requests.filter((r) => r.text === "same failed message");
    expect
      .soft(sameTextRequests, "TUI retry must not produce a second real model turn")
      .toHaveLength(1);
    expect
      .soft(events, "opening pair plus failed-turn pair; no extra pair on retry")
      .toHaveLength(4);
    unwrap(await f.runtime.say({ residentId: f.residentId, text: "later actual delivery" }));
    expect(unwrap(await tui.retry()).turnId).toBe(originalTurnId);
    expect(
      tui
        .transcript()
        .frames.at(-1)
        ?.text.match(/你：same failed message/g),
    ).toHaveLength(1);
    const independent = unwrap(await tui.submit("same failed message"));
    expect(independent.turnId).not.toBe(originalTurnId);
    expect(f.requests.filter((r) => r.text === "same failed message")).toHaveLength(2);
    expect(stream(f).events).toHaveLength(8);
  });

  it("same-generation user-only retry regenerates then completes under the original key", async () => {
    const f = make(false, "r-half-control");
    const repair = blockAssistantAfterUser(f);
    const request = { residentId: f.residentId, text: "half turn", turnId: "half-control" };
    const first = await f.runtime.say(request);
    expect(first).toMatchObject({ ok: false, error: { code: "writer-unavailable" } });
    expect(stream(f).events).toHaveLength(1);
    repair();
    const retried = await f.runtime.say(request);
    expect(retried).toMatchObject({ ok: true, value: { reply: "audit reply 2", generation: 1 } });
    expect(f.requests).toHaveLength(2);
    expect(stream(f).events).toHaveLength(2);
  });

  it("close/reopen must not regenerate a conflicting user draft for an existing half turn", async () => {
    const f = make(false, "r-half-restart");
    const repair = blockAssistantAfterUser(f);
    const request = { residentId: f.residentId, text: "half turn", turnId: "half-restart" };
    const first = await f.runtime.say(request);
    expect(first).toMatchObject({ ok: false, error: { code: "writer-unavailable" } });
    expect(stream(f).events).toHaveLength(1);
    repair();
    await f.runtime.close();
    const reopened = f.open();
    const retried = await reopened.say(request);
    const retriedAgain = await reopened.say(request);
    expect(retried).toMatchObject({
      ok: false,
      error: { code: "reconciliation-needed", turnId: request.turnId },
    });
    expect(retriedAgain).toEqual(retried);
    expect(f.requests).toHaveLength(1);
    expect(stream(f).events).toHaveLength(1);
  });
  it("a confirmed older target and current ACK equality cannot certify a failed later turn", async () => {
    const f = make(true, "r-target-equality");
    const first = unwrap(
      await f.runtime.say({ residentId: f.residentId, text: "confirmed zero target" }),
    );
    f.armReceiptFailure();
    const failed = await f.runtime.say({
      residentId: f.residentId,
      text: "unconfirmed zero target",
    });
    expect(failed).toMatchObject({ ok: false, error: { code: "writer-unavailable" } });
    if (failed.ok || failed.error.turnId === undefined)
      throw new Error("expected receipt failure with anchor");
    f.repairReceipt();
    const request = {
      residentId: f.residentId,
      text: "unconfirmed zero target",
      turnId: failed.error.turnId,
    };
    expect(book(f).viewports[0]?.ackedSeq).toBe(0);
    expect(await f.runtime.say(request)).toMatchObject({
      ok: false,
      error: { code: "reconciliation-needed" },
    });
    expect(f.requests).toHaveLength(2);
    expect(
      unwrap(
        await f.runtime.say({
          residentId: f.residentId,
          text: "confirmed zero target",
          turnId: first.turnId,
        }),
      ),
    ).toEqual(first);
    unwrap(await f.runtime.say({ residentId: f.residentId, text: "later true delivery" }));
    expect(unwrap(await f.runtime.say(request))).toMatchObject({
      reply: "audit reply 2",
      turnId: failed.error.turnId,
    });
    expect(f.requests).toHaveLength(3);
  });

  it("registration baseline is insufficient when the first confirmation record fails, including after restart", async () => {
    const f = make(true, "r-baseline-receipt");
    addFact(f.runtime, f.residentId, "fact before first window");
    f.armReceiptFailure();
    const request = { residentId: f.residentId, text: "first turn", turnId: "baseline-turn" };
    expect(await f.runtime.say(request)).toMatchObject({
      ok: false,
      error: { code: "writer-unavailable", turnId: request.turnId },
    });
    expect(book(f).viewports[0]).toMatchObject({ baselineSeq: 1, ackedSeq: 1 });
    f.repairReceipt();
    expect(await f.runtime.say(request)).toMatchObject({
      ok: false,
      error: { code: "reconciliation-needed" },
    });
    await f.runtime.close();
    expect(await f.open().say(request)).toMatchObject({
      ok: false,
      error: { code: "reconciliation-needed" },
    });
    expect(f.requests).toHaveLength(1);
    expect(stream(f).events).toHaveLength(2);
  });

  it("ACK can be durable while a failed confirmation record still prevents a false success", async () => {
    const f = make(true, "r-receipt-persist");
    unwrap(await f.runtime.say({ residentId: f.residentId, text: "open window" }));
    addFact(f.runtime, f.residentId, "target one");
    f.armReceiptFailure();
    const request = {
      residentId: f.residentId,
      text: "record fails after ACK",
      turnId: "receipt-turn",
    };
    expect(await f.runtime.say(request)).toMatchObject({
      ok: false,
      error: { code: "writer-unavailable", turnId: request.turnId },
    });
    expect(book(f).viewports[0]?.ackedSeq).toBe(1);
    f.repairReceipt();
    expect(await f.runtime.say(request)).toMatchObject({
      ok: false,
      error: { code: "reconciliation-needed" },
    });
    expect(f.requests).toHaveLength(2);
    unwrap(await f.runtime.say({ residentId: f.residentId, text: "later confirmed target" }));
    expect(unwrap(await f.runtime.say(request)).reply).toBe("audit reply 2");
    const receipt = readFileSync(join(f.dataDir, "turns", `${f.residentId}.turns.json`), "utf8");
    expect(receipt).not.toContain("audit reply");
    expect(receipt).not.toContain(request.text);
    expect(receipt).not.toContain("synthetic-audit-only");
    expect(
      unwrap(f.runtime.secretScan({ residentId: f.residentId, needle: "synthetic-audit-only" }))
        .hits,
    ).toEqual([]);
  });

  it("an authenticated pending turn cannot downgrade to stream-only replay after reopening without a ledger", async () => {
    const f = make(true, "r-no-downgrade");
    const { request } = await failedAckTurn(f, "authenticated-turn");
    await f.runtime.close();
    const reopened = new ResidentRuntime({
      dataDir: f.dataDir,
      transport: {
        complete() {
          throw new Error("must not call model");
        },
      },
    });
    runtimes.push(reopened);
    expect(await reopened.say(request)).toMatchObject({
      ok: false,
      error: { code: "reconciliation-needed" },
    });
  });

  it.each([false, true])(
    "legacy stream without delivery metadata remains truthful (ledger=%s)",
    async (ledger) => {
      const f = make(ledger, "r-legacy");
      const original = CanonicalStreamWriter.prototype.submit;
      const spy = vi.spyOn(CanonicalStreamWriter.prototype, "submit").mockImplementation(function (
        this: CanonicalStreamWriter,
        input,
      ) {
        const { ledgerDelivery: _delivery, ...payload } = input.draft.payload;
        return original.call(this, { ...input, draft: { ...input.draft, payload } });
      });
      const request = { residentId: f.residentId, text: "legacy reply", turnId: "legacy-turn" };
      const first = unwrap(await f.runtime.say(request));
      spy.mockRestore();
      await f.runtime.close();
      const retried = await f.open().say(request);
      if (ledger)
        expect(retried).toMatchObject({ ok: false, error: { code: "reconciliation-needed" } });
      else expect(unwrap(retried)).toEqual(first);
      expect(f.requests).toHaveLength(1);
    },
  );

  it("a partial turn after actual sudden death stops before regenerating in the successor", async () => {
    const f = make(true, "r-half-death");
    const repair = blockAssistantAfterUser(f);
    const request = { residentId: f.residentId, text: "orphan user", turnId: "dead-turn" };
    expect(await f.runtime.say(request)).toMatchObject({
      ok: false,
      error: { code: "writer-unavailable" },
    });
    repair();
    await f.runtime.suddenDeath({ residentId: f.residentId });
    expect(await f.runtime.say(request)).toMatchObject({
      ok: false,
      error: { code: "reconciliation-needed" },
    });
    expect(f.requests).toHaveLength(1);
    expect(stream(f).events).toHaveLength(1);
  });
  it("unreadable confirmation evidence fails before model dispatch and the new surface is scanned by resident", async () => {
    const f = make(true, "r-broken-receipt");
    const request = {
      residentId: f.residentId,
      text: "confirmed reply",
      turnId: "broken-evidence",
    };
    unwrap(await f.runtime.say(request));
    const path = join(f.dataDir, "turns", `${f.residentId}.turns.json`);
    writeFileSync(path, "synthetic-receipt-canary");
    expect(
      unwrap(f.runtime.secretScan({ residentId: f.residentId, needle: "synthetic-receipt-canary" }))
        .hits,
    ).toMatchObject([{ surface: "turn-receipt" }]);
    expect(await f.runtime.say(request)).toMatchObject({
      ok: false,
      error: { code: "reconciliation-needed", turnId: request.turnId },
    });
    expect(f.requests).toHaveLength(1);
    expect(stream(f).events).toHaveLength(2);
  });
});
