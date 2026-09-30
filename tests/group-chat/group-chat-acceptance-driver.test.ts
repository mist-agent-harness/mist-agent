import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type GroupChatCommand,
  type GroupChatHostDriver,
  groupChatSyntheticFixture,
} from "../../acceptance/group-chat-driver.ts";
import {
  type HostProvenanceFacts,
  judgeDirectWriteReadback,
  readProcessInfo,
} from "../../acceptance/group-chat-run.ts";
import {
  type RoomPostExchangeObservation,
  createGroupChatHostDriver,
} from "../../src/group-chat-acceptance-driver.ts";
import { RoomEventStore } from "../../src/group-chat/room-event-store.ts";

const ipcCaptures = vi.hoisted(
  () => [] as Array<{ pid: number | undefined; sent: unknown[]; received: unknown[] }>,
);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    fork: (...args: Parameters<typeof actual.fork>) => {
      const child = actual.fork(...args);
      const capture = { pid: child.pid, sent: [] as unknown[], received: [] as unknown[] };
      const send = child.send.bind(child);
      vi.spyOn(child, "send").mockImplementation((message, ...rest) => {
        capture.sent.push(message);
        return send(message, ...rest);
      });
      child.on("message", (message) => capture.received.push(message));
      ipcCaptures.push(capture);
      return child;
    },
  };
});

describe("group-chat acceptance host process", () => {
  let driver: ReturnType<typeof createGroupChatHostDriver> | undefined;
  let dataRoot: string | undefined;

  afterEach(async () => {
    if (driver !== undefined) await driver.stopHost();
    if (dataRoot !== undefined) await rm(dataRoot, { recursive: true, force: true });
    driver = undefined;
    dataRoot = undefined;
    ipcCaptures.splice(0);
  });

  it("reads a judge-direct durable append after stopping and restarting the child host", async () => {
    driver = createGroupChatHostDriver();
    const fixture = groupChatSyntheticFixture;
    const firstRun = await driver.startHost();
    if (firstRun.dataRoot === undefined) throw new Error("host omitted its dataRoot");
    dataRoot = firstRun.dataRoot;
    expect(dataRoot).toBe(realpathSync(dataRoot));
    expect(firstRun.pid).toBeGreaterThan(0);

    await driver.resetScenario("GC-01", fixture);
    const command: GroupChatCommand = {
      kind: "post",
      roomId: fixture.roomId,
      principalId: fixture.humanId,
      visibility: "public",
      binding: fixture.trustedOwnerBinding,
      body: "adapter-write",
    };
    await driver.perform(command);
    const adapterEvent = (await driver.readRoomEvents()).find(
      (event) => event.body === "adapter-write",
    );
    expect(adapterEvent?.authorId).toBe(fixture.humanId);

    await driver.stopHost();
    const judge = new RoomEventStore(dataRoot);
    const direct = judge.append({
      operationId: "judge-direct-operation",
      roomId: fixture.roomId,
      principalId: fixture.residentIds.a,
      authorId: fixture.residentIds.a,
      body: "judge-direct-write",
      visibility: "public",
      requestSemantics: "judge-direct-write",
    });
    judge.close();

    const restartedRun = await driver.startHost();
    expect(restartedRun.pid).not.toBe(firstRun.pid);
    expect(restartedRun.dataRoot).toBe(dataRoot);
    const readback = await driver.readRoomEvents(fixture.roomId);
    expect(readback.map((event) => event.id)).toContain(direct.event.id);
    expect(readback.find((event) => event.id === direct.event.id)?.body).toBe("judge-direct-write");
  });

  it("reads room, delivery, private, memory and stage ledgers over IPC after host restart", async () => {
    driver = createGroupChatHostDriver();
    const fixture = groupChatSyntheticFixture;
    const firstRun = await driver.startHost();
    if (firstRun.dataRoot === undefined) throw new Error("host omitted its dataRoot");
    dataRoot = firstRun.dataRoot;
    await driver.resetScenario("GC-03", fixture);

    await driver.perform({
      kind: "seed-resident-private",
      residentId: fixture.residentIds.a,
      canary: "restart-private-a",
    });
    await driver.perform({ kind: "register-resident", residentId: fixture.residentIds.a });
    await driver.perform({
      kind: "record-event",
      roomId: fixture.roomId,
      authorId: fixture.humanId,
      body: "TEST-IPC-DURABLE-EVENT",
    });
    const event = (await driver.readRoomEvents(fixture.roomId)).find((row) =>
      row.body.includes("TEST-IPC-DURABLE-EVENT"),
    );
    if (event === undefined) throw new Error("record-event was not visible over host IPC");
    await driver.perform({
      kind: "set-delivery-state",
      eventMarker: "TEST-IPC-DURABLE-EVENT",
      residentId: fixture.residentIds.a,
      state: "loaded",
    });
    await driver.perform({
      kind: "save-memory",
      residentId: fixture.residentIds.a,
      sourceEventId: event.id,
    });
    await driver.perform({ kind: "dispatch-event", eventMarker: "TEST-IPC-DURABLE-EVENT" });
    await driver.perform({
      kind: "commit-context",
      residentId: fixture.residentIds.a,
      marker: "TEST-IPC-COMMIT",
    });

    await driver.stopHost();
    const restartedRun = await driver.startHost();
    expect(restartedRun.pid).not.toBe(firstRun.pid);
    expect(restartedRun.dataRoot).toBe(dataRoot);
    expect((await driver.readRoomEvents(fixture.roomId)).some((row) => row.id === event.id)).toBe(
      true,
    );
    expect(await driver.readDeliveries(event.id)).toEqual([
      { residentId: fixture.residentIds.a, state: "queued" },
      { residentId: fixture.residentIds.b, state: "queued" },
    ]);
    expect(await driver.readResidentContext(fixture.residentIds.a)).toBe("restart-private-a");
    expect(await driver.readMemories()).toEqual([
      {
        residentId: fixture.residentIds.a,
        sourceEventId: event.id,
        body: "TEST-IPC-DURABLE-EVENT",
      },
    ]);
    expect((await driver.readSystemReceipts()).map((receipt) => receipt.phase)).toEqual([
      "recorded",
      "dispatched",
      "context-committed",
    ]);
  });

  it("returns a wrong-binding rejection to its sender without recording it", async () => {
    const exchanges: RoomPostExchangeObservation[] = [];
    driver = createGroupChatHostDriver({ onPostExchange: (exchange) => exchanges.push(exchange) });
    const fixture = groupChatSyntheticFixture;
    const run = await driver.startHost();
    dataRoot = (run as typeof run & { readonly dataRoot: string }).dataRoot;

    await driver.resetScenario("GC-01", fixture);
    const command: GroupChatCommand = {
      kind: "post",
      roomId: fixture.roomId,
      principalId: fixture.humanId,
      visibility: "public",
      binding: "test-binding:wrong",
      body: "must-not-be-recorded",
    };

    await driver.perform(command);
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]?.result).toStrictEqual({
      status: "rejected",
      operationId: exchanges[0]?.envelope.operationId,
      recipient: "sender",
      reasonCode: "room_binding_denied",
    });
    expect(await driver.readRoomEvents(fixture.roomId)).toEqual([]);
    expect(await driver.readSystemReceipts()).toEqual([]);
  });

  it.each([
    {
      label: "missing public declaration",
      valid: (fixture: typeof groupChatSyntheticFixture): Record<string, unknown> => ({
        kind: "post",
        roomId: fixture.roomId,
        principalId: fixture.humanId,
        visibility: "public",
        binding: fixture.trustedOwnerBinding,
        body: "visible-control",
      }),
      invalid: (fixture: typeof groupChatSyntheticFixture): Record<string, unknown> => ({
        kind: "post",
        roomId: fixture.roomId,
        principalId: fixture.humanId,
        binding: fixture.trustedOwnerBinding,
        body: "missing-visibility",
        mentions: undefined,
      }),
      reasonCode: "public_declaration_required",
    },
    {
      label: "empty room",
      valid: (fixture: typeof groupChatSyntheticFixture): Record<string, unknown> => ({
        kind: "post",
        roomId: fixture.roomId,
        principalId: fixture.humanId,
        visibility: "public",
        binding: fixture.trustedOwnerBinding,
        body: "visible-control",
      }),
      invalid: (fixture: typeof groupChatSyntheticFixture): Record<string, unknown> => ({
        kind: "post",
        roomId: "",
        principalId: fixture.humanId,
        visibility: "public",
        binding: fixture.trustedOwnerBinding,
        body: "empty-room",
      }),
      reasonCode: "room_required",
    },
    {
      label: "missing room binding",
      valid: (fixture: typeof groupChatSyntheticFixture): Record<string, unknown> => ({
        kind: "post",
        roomId: fixture.roomId,
        principalId: fixture.humanId,
        visibility: "public",
        binding: fixture.trustedOwnerBinding,
        body: "visible-control",
      }),
      invalid: (fixture: typeof groupChatSyntheticFixture): Record<string, unknown> => ({
        kind: "post",
        roomId: fixture.roomId,
        principalId: fixture.humanId,
        visibility: "public",
        body: "missing-binding",
      }),
      reasonCode: "room_binding_denied",
    },
    {
      label: "private fields",
      valid: (fixture: typeof groupChatSyntheticFixture): Record<string, unknown> => ({
        kind: "post",
        roomId: fixture.roomId,
        principalId: fixture.humanId,
        visibility: "public",
        binding: fixture.trustedOwnerBinding,
        body: "visible-control",
      }),
      invalid: (fixture: typeof groupChatSyntheticFixture): Record<string, unknown> => ({
        kind: "post",
        roomId: fixture.roomId,
        principalId: fixture.humanId,
        visibility: "public",
        binding: fixture.trustedOwnerBinding,
        body: "private-field-canary",
        privateFields: ["not-for-room"],
      }),
      reasonCode: "private_fields_not_allowed",
    },
  ] as const)(
    "passes $label unchanged through the real child host and reports its rejection",
    async ({ valid, invalid, reasonCode }) => {
      const exchanges: RoomPostExchangeObservation[] = [];
      driver = createGroupChatHostDriver({
        onPostExchange: (exchange) => exchanges.push(exchange),
      });
      const fixture = groupChatSyntheticFixture;
      const run = await driver.startHost();
      dataRoot = run.dataRoot;
      await driver.resetScenario("GC-01", fixture);

      const validCommand = valid(fixture);
      const invalidCommand = invalid(fixture);
      const validSnapshot = structuredClone(validCommand);
      const invalidSnapshot = structuredClone(invalidCommand);
      await driver.perform(validCommand as unknown as GroupChatCommand);
      await driver.perform(invalidCommand as unknown as GroupChatCommand);

      expect(validCommand).toStrictEqual(validSnapshot);
      expect(invalidCommand).toStrictEqual(invalidSnapshot);
      expect(exchanges).toHaveLength(2);
      const assertUnchangedPostFields = (
        command: Record<string, unknown>,
        exchange: RoomPostExchangeObservation | undefined,
      ) => {
        expect(exchange).toBeDefined();
        if (exchange === undefined) throw new Error("missing child-host post exchange");
        const expectedEnvelope = Object.fromEntries(
          Object.entries(command).filter(([key]) => key !== "kind"),
        );
        const wireExpectedEnvelope = JSON.parse(JSON.stringify(expectedEnvelope)) as Record<
          string,
          unknown
        >;
        const { operationId, ...observedFields } = exchange.envelope;
        expect(operationId).toBeTruthy();
        expect(observedFields).toStrictEqual(wireExpectedEnvelope);
        expect(exchange.principal).toStrictEqual({ principalId: command.principalId });
        expect(exchange.result.operationId).toBe(operationId);
        expect(exchange.childPid).toBe(run.pid);
        expect(exchange.childRequestHash).toBe(exchange.requestHash);

        const capture = ipcCaptures.find((candidate) => candidate.pid === run.pid);
        expect(capture).toBeDefined();
        const asFrame = (frame: unknown): Record<string, unknown> | undefined =>
          typeof frame === "object" && frame !== null
            ? (frame as Record<string, unknown>)
            : undefined;
        const sentFrame = capture?.sent.map(asFrame).find((frame) => {
          const envelope = asFrame(frame?.envelope);
          return frame?.kind === "post" && envelope?.operationId === exchange.envelope.operationId;
        });
        expect(sentFrame).toBeDefined();
        if (sentFrame === undefined) throw new Error("missing post request on child IPC");
        expect(sentFrame.envelope).toStrictEqual({
          operationId: exchange.envelope.operationId,
          ...wireExpectedEnvelope,
        });
        expect(sentFrame.principal).toStrictEqual({ principalId: command.principalId });
        expect(sentFrame.requestHash).toBe(exchange.requestHash);

        const receivedFrame = capture?.received
          .map(asFrame)
          .find((frame) => frame?.id === sentFrame.id);
        expect(receivedFrame).toMatchObject({
          id: sentFrame.id,
          ok: true,
          hostPid: run.pid,
          requestHash: exchange.requestHash,
          value: exchange.result,
        });
      };
      assertUnchangedPostFields(validCommand, exchanges[0]);
      assertUnchangedPostFields(invalidCommand, exchanges[1]);
      expect(exchanges[0]?.result.status).toBe("recorded");
      expect(exchanges[1]?.result).toStrictEqual({
        status: "rejected",
        operationId: exchanges[1]?.envelope.operationId,
        recipient: "sender",
        reasonCode,
      });

      const events = await driver.readRoomEvents(fixture.roomId);
      expect(events).toHaveLength(1);
      expect(events[0]?.body).toBe("visible-control");
      expect(await driver.readSystemReceipts()).toHaveLength(1);
    },
  );

  it("turns red when adapter readback is a pre-restart memory copy", async () => {
    const realDriver = createGroupChatHostDriver();
    driver = realDriver;
    const firstRun = await realDriver.startHost();
    if (firstRun.dataRoot === undefined) throw new Error("host omitted its dataRoot");
    dataRoot = firstRun.dataRoot;
    const memoryCopy = await realDriver.readRoomEvents(groupChatSyntheticFixture.roomId);
    await realDriver.stopHost();

    const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
    const facts: HostProvenanceFacts = {
      headCommit: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repoRoot,
        encoding: "utf8",
      }).trim(),
      judgePid: process.pid,
      judgeExecutable: realpathSync(process.execPath),
      repoRoot,
      readProcess: (pid) => readProcessInfo(pid),
    };
    let childRunning = false;
    const memoryOnlyReadback: GroupChatHostDriver = {
      ...realDriver,
      startHost: async () => {
        const run = await realDriver.startHost();
        childRunning = true;
        return run;
      },
      stopHost: async () => {
        await realDriver.stopHost();
        childRunning = false;
      },
      readRoomEvents: async (roomId) => {
        if (!childRunning) return realDriver.readRoomEvents(roomId);
        return memoryCopy.filter((event) => roomId === undefined || event.roomId === roomId);
      },
    };

    const result = await judgeDirectWriteReadback(memoryOnlyReadback, firstRun, facts);
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("missed or altered");
  });
});
