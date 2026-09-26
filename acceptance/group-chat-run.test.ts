import { describe, expect, it } from "vitest";
import {
  groupChatChecks,
  isUnsupportedPersonalClaim,
  runGroupChatCheck,
} from "./group-chat-checks.ts";
import {
  type AccessAudit,
  type ContextCommit,
  type DeliveryRecord,
  GROUP_CHAT_CHECK_IDS,
  type GroupChatCheckId,
  type GroupChatCommand,
  type GroupChatHostDriver,
  type MemoryRecord,
  type ResidentId,
  type ResidentReaction,
  type RoomEvent,
  type RosterPath,
  type RosterProjection,
  type RosterSnapshot,
  type RouteRecord,
  type SurfaceSnapshot,
  type SystemReceipt,
  cloneGroupChatDriverBoundary,
  groupChatSyntheticFixture as fixture,
} from "./group-chat-driver.ts";
import {
  missingDriverResults as runnerMissingDriverResults,
  scoreGroupChatResults,
} from "./group-chat-run.ts";

interface TestOptions {
  readonly acceptForged?: boolean;
  readonly dropForgedBodyPost?: boolean;
  readonly trustBodyAuthorHeader?: boolean;
  readonly acceptInvalidPosts?: boolean;
  readonly wrongMemorySource?: boolean;
  readonly noopSeedPrivate?: boolean;
  readonly leakPrivateCanariesIntoRoom?: boolean;
  readonly noRosterVersionBump?: boolean;
  readonly rosterSnapshotOmitsNewResident?: boolean;
  readonly bypassGate?: boolean;
  readonly deadRouter?: boolean;
  readonly contextCommitRef?: string;
  readonly claimOverride?: string;
  readonly publishFutureReceiptsEarly?: boolean;
  readonly skipRosterPath?: RosterPath;
  readonly leakHiddenToUnauthorized?: boolean;
  readonly noHiddenRoom?: boolean;
  readonly publicBodyX?: boolean;
  readonly acceptCrossRoomReplay?: boolean;
  readonly leakPrivateCanaries?: boolean;
  readonly skipDeliveryFor?: ResidentId;
  readonly routePlainText?: boolean;
}

/** Test-only host model; production runner never imports this adapter. */
class SyntheticGroupChatHost implements GroupChatHostDriver {
  readonly kind = "mist-host" as const;
  readonly options: TestOptions;
  private events: RoomEvent[] = [];
  private deliveries = new Map<string, DeliveryRecord[]>();
  private memories: MemoryRecord[] = [];
  private privateContexts = new Map<ResidentId, string[]>();
  private roster = new Set<ResidentId>([fixture.residentIds.a, fixture.residentIds.b]);
  private rosterVersion = 1;
  private projections = new Map<RosterPath, RosterProjection>();
  private routes: RouteRecord[] = [];
  private receipts: SystemReceipt[] = [];
  private commits: ContextCommit[] = [];
  private reactions: ResidentReaction[] = [];
  private rooms = new Map<string, { visibility: "public" | "hidden"; body: string }>();
  private gateStopped = false;
  private gateTurnOpen = true;
  private crossResidentPrivateReads = 0;
  private unauthorizedReadResults: string[] = [];
  private nextId = 1;

  constructor(options: TestOptions = {}) {
    this.options = options;
  }

  async startHost() {
    return { pid: 12345, commit: "synthetic-test-only" };
  }
  async stopHost(): Promise<void> {}

  async resetScenario(_id: GroupChatCheckId): Promise<void> {
    this.events = [];
    this.deliveries.clear();
    this.memories = [];
    this.privateContexts.clear();
    this.roster = new Set([fixture.residentIds.a, fixture.residentIds.b]);
    this.rosterVersion = 1;
    this.projections.clear();
    this.routes = [];
    this.receipts = [];
    this.commits = [];
    this.reactions = [];
    this.rooms.clear();
    this.gateStopped = false;
    this.gateTurnOpen = true;
    this.crossResidentPrivateReads = 0;
    this.unauthorizedReadResults = [];
    this.nextId = 1;
  }

  async perform(command: GroupChatCommand): Promise<void> {
    switch (command.kind) {
      case "post": {
        if (this.options.dropForgedBodyPost && command.body.includes("TEST-GC01-BODY-FORGERY"))
          return;
        const valid =
          command.roomId !== "" &&
          command.visibility === "public" &&
          command.binding === "test-binding:owner" &&
          command.privateFields === undefined &&
          command.claimedAuthorId === undefined;
        if (!valid && !this.options.acceptInvalidPosts && !this.options.acceptForged) return;
        const id = `event:${this.nextId++}`;
        const bodyAuthor = this.options.trustBodyAuthorHeader
          ? command.body.match(/^From:\s*([^\r\n]+)/mu)?.[1]
          : undefined;
        const actualAuthor =
          command.claimedAuthorId && this.options.acceptForged
            ? command.claimedAuthorId
            : (bodyAuthor ?? command.principalId);
        const privateContext = this.privateContexts.get(command.principalId as ResidentId) ?? [];
        const body = command.privateFields
          ? `${command.body} ${command.privateFields.join(" ")}`
          : this.options.leakPrivateCanariesIntoRoom &&
              command.body === "TEST-GC02-VALID" &&
              privateContext.length > 0
            ? `${command.body} ${privateContext.join(" ")}`
            : command.body;
        this.events.push({
          id,
          roomId: command.roomId,
          authorId: actualAuthor,
          body,
          visibility: command.visibility ?? "hidden",
        });
        return;
      }
      case "save-memory": {
        const event = this.events.find(({ id }) => id === command.sourceEventId);
        if (event) {
          this.memories.push({
            residentId: command.residentId,
            sourceEventId: this.options.wrongMemorySource ? "event:wrong" : event.id,
            body: event.body,
          });
        }
        return;
      }
      case "seed-resident-private": {
        if (this.options.noopSeedPrivate) return;
        const targets: ResidentId[] = this.options.leakPrivateCanaries
          ? [fixture.residentIds.a, fixture.residentIds.b, fixture.residentIds.c]
          : [command.residentId];
        for (const target of targets) {
          const context = this.privateContexts.get(target) ?? [];
          context.push(command.canary);
          this.privateContexts.set(target, context);
        }
        return;
      }
      case "set-delivery-state": {
        if (this.options.skipDeliveryFor === command.residentId) return;
        const event = this.events.find((item) => item.body.includes(command.eventMarker));
        if (!event) return;
        const rows = this.deliveries.get(event.id) ?? [];
        rows.push({ residentId: command.residentId, state: command.state });
        this.deliveries.set(event.id, rows);
        return;
      }
      case "register-resident":
        if (!this.roster.has(command.residentId)) {
          this.roster.add(command.residentId);
          if (!this.options.noRosterVersionBump) this.rosterVersion += 1;
        }
        return;
      case "exercise-roster-path":
        if (this.options.skipRosterPath === command.path) return;
        this.projections.set(command.path, {
          residentIds: [...this.roster],
          humanIds: [fixture.humanId],
        });
        return;
      case "plain-text-mention": {
        const marker = command.body.split(" ")[0] ?? "";
        this.routes.push({
          marker,
          calls: this.options.routePlainText ? 1 : 0,
          targetId: null,
          rejected: false,
          gateBypassed: false,
        });
        return;
      }
      case "structured-mention": {
        const validTarget = [...this.roster].includes(command.targetId as ResidentId);
        const gateClosed = this.gateStopped || !this.gateTurnOpen;
        const rejected = gateClosed || !validTarget || this.options.deadRouter === true;
        const bypassed = gateClosed && this.options.bypassGate === true;
        this.routes.push({
          marker: command.body,
          calls: rejected && !bypassed ? 0 : 1,
          targetId: validTarget ? command.targetId : null,
          rejected: rejected && !bypassed,
          gateBypassed: bypassed,
        });
        return;
      }
      case "set-turn-gate":
        this.gateStopped = command.stopped;
        this.gateTurnOpen = command.turnOpen;
        return;
      case "record-event": {
        const id = `event:${this.nextId++}`;
        this.events.push({
          id,
          roomId: command.roomId,
          authorId: command.authorId,
          body: command.body,
          visibility: "public",
        });
        const claim = this.options.claimOverride ?? "系统已收，成员尚未派发";
        this.receipts.push({ actor: "system", phase: "recorded", claim });
        if (this.options.publishFutureReceiptsEarly) {
          this.receipts.push({ actor: "system", phase: "dispatched", claim });
          this.receipts.push({
            actor: "system",
            phase: "context-committed",
            claim: "仍不等于理解或记忆",
            contextCommitRef: "context-commit:premature",
          });
        }
        return;
      }
      case "dispatch-event": {
        if (!this.events.some((event) => event.body.includes(command.eventMarker))) return;
        const claim = this.options.claimOverride ?? "系统已收，成员尚未派发";
        this.receipts.push({ actor: "system", phase: "dispatched", claim });
        return;
      }
      case "commit-context": {
        const id = `context-commit:${this.nextId++}`;
        this.commits.push({ id, residentId: command.residentId, marker: command.marker });
        this.receipts.push({
          actor: "system",
          phase: "context-committed",
          claim: this.options.claimOverride ?? "已装入，不代表理解",
          contextCommitRef: this.options.contextCommitRef ?? id,
        });
        return;
      }
      case "react":
        this.reactions.push({ residentId: command.residentId, eventMarker: command.eventMarker });
        return;
      case "create-room":
        if (this.options.noHiddenRoom && command.visibility === "hidden") return;
        this.rooms.set(command.roomId, { visibility: command.visibility, body: command.body });
        this.events.push({
          id: `event:${this.nextId++}`,
          roomId: command.roomId,
          authorId: "test-host:room-seed",
          body: command.body,
          visibility: command.visibility,
        });
        return;
      case "replay-public-payload": {
        if (!this.options.acceptCrossRoomReplay) return;
        const source = this.events.find(
          (event) =>
            event.roomId === command.sourceRoomId && event.body.includes(command.eventMarker),
        );
        const target = this.rooms.get(command.targetRoomId);
        if (source && target) {
          this.events.push({
            ...source,
            id: `event:${this.nextId++}`,
            roomId: command.targetRoomId,
            visibility: target.visibility,
          });
        }
        return;
      }
      case "attempt-room-read": {
        const room = this.rooms.get(command.roomId);
        const allowed = room?.visibility === "public" && command.viewerId === fixture.humanId;
        if (room?.visibility === "hidden" && !allowed) {
          this.unauthorizedReadResults.push("not-found");
          if (this.options.leakHiddenToUnauthorized) this.crossResidentPrivateReads += 1;
        }
        if (room?.visibility === "hidden" && allowed) this.crossResidentPrivateReads += 1;
        return;
      }
      case "set-resident":
        return;
    }
  }

  async readRoomEvents(roomId?: string): Promise<readonly RoomEvent[]> {
    return roomId === undefined
      ? this.events
      : this.events.filter((event) => event.roomId === roomId);
  }
  async readDeliveries(eventId: string): Promise<readonly DeliveryRecord[]> {
    return this.deliveries.get(eventId) ?? [];
  }
  async readMemories(): Promise<readonly MemoryRecord[]> {
    return this.memories;
  }
  async readResidentContext(residentId: ResidentId): Promise<string> {
    return (this.privateContexts.get(residentId) ?? []).join(" ");
  }
  async readRoster(): Promise<RosterSnapshot> {
    const residentIds = [...this.roster].filter(
      (id) => !(this.options.rosterSnapshotOmitsNewResident && id === fixture.residentIds.newcomer),
    );
    return { version: this.rosterVersion, residentIds };
  }
  async readRosterPath(path: RosterPath): Promise<RosterProjection> {
    return this.projections.get(path) ?? { residentIds: [], humanIds: [] };
  }
  async readRoutes(): Promise<readonly RouteRecord[]> {
    return this.routes;
  }
  async readSystemReceipts(): Promise<readonly SystemReceipt[]> {
    return this.receipts;
  }
  async readContextCommits(): Promise<readonly ContextCommit[]> {
    return this.commits;
  }
  async readSurface(roomId: string, viewerId: string): Promise<SurfaceSnapshot> {
    const room = this.rooms.get(roomId);
    if (room?.visibility === "hidden" && viewerId !== fixture.humanId) {
      if (this.options.leakHiddenToUnauthorized) {
        return { body: room.body, candidates: [], count: 1, errorCode: null, receipt: null };
      }
      return { body: "", candidates: [], count: 0, errorCode: "not-found", receipt: null };
    }
    const visibleEvents = this.events.filter(
      (event) => event.roomId === roomId && event.visibility === "public",
    );
    const body = [room?.body, ...visibleEvents.map((event) => event.body)]
      .filter((value): value is string => Boolean(value))
      .join("\n");
    return {
      body: this.options.publicBodyX && roomId === fixture.roomId ? "x" : body,
      candidates: visibleEvents.map(({ id }) => id),
      count: visibleEvents.length,
      errorCode: room ? null : "not-found",
      receipt: null,
    };
  }
  async readAccessAudit(): Promise<AccessAudit> {
    return {
      crossResidentPrivateReads: this.crossResidentPrivateReads,
      unauthorizedReadResults: this.unauthorizedReadResults,
    };
  }
  async readReactions(): Promise<readonly ResidentReaction[]> {
    return this.reactions;
  }
}

describe("#191 group-chat acceptance: judge-driven synthetic host checks", () => {
  it("freezes exactly the seven PR1 lamps and synthetic fixtures", () => {
    expect(groupChatChecks.map(({ id }) => id)).toEqual(GROUP_CHAT_CHECK_IDS);
    expect(fixture.roomId).toMatch(/^test-room:/);
    expect(Object.values(fixture.residentIds).every((id) => id.startsWith("test-resident:"))).toBe(
      true,
    );
    expect(
      Object.values(fixture.canaries).every((value) => value.startsWith("TEST-PRIVATE-CANARY:")),
    ).toBe(true);
  });

  it("passes positive controls only after judge operations and independent readbacks", async () => {
    for (const id of GROUP_CHAT_CHECK_IDS) {
      const result = await runGroupChatCheck(id, new SyntheticGroupChatHost());
      expect(result.passed, `${id}: ${result.detail}`).toBe(true);
    }
  });

  it("fails if the forged-envelope negative is silently accepted", async () => {
    const result = await runGroupChatCheck(
      "GC-01",
      new SyntheticGroupChatHost({ acceptForged: true }),
    );
    expect(result.passed).toBe(false);
  });

  it("requires the judge to send and read back a body that impersonates another author", async () => {
    expect(
      (await runGroupChatCheck("GC-01", new SyntheticGroupChatHost({ dropForgedBodyPost: true })))
        .passed,
    ).toBe(false);
    expect(
      (
        await runGroupChatCheck(
          "GC-01",
          new SyntheticGroupChatHost({ trustBodyAuthorHeader: true }),
        )
      ).passed,
    ).toBe(false);
  });

  it("fails if malformed/private payload negatives are silently accepted", async () => {
    const result = await runGroupChatCheck(
      "GC-02",
      new SyntheticGroupChatHost({ acceptInvalidPosts: true }),
    );
    expect(result.passed).toBe(false);
  });

  it("seeds private draft/tool canaries, reads them for the sender, and rejects public leakage", async () => {
    expect(
      (await runGroupChatCheck("GC-02", new SyntheticGroupChatHost({ noopSeedPrivate: true })))
        .passed,
    ).toBe(false);
    expect(
      (
        await runGroupChatCheck(
          "GC-02",
          new SyntheticGroupChatHost({ leakPrivateCanariesIntoRoom: true }),
        )
      ).passed,
    ).toBe(false);
  });

  it("requires a personal-memory pointer to equal the exact judge-seeded room event", async () => {
    const result = await runGroupChatCheck(
      "GC-03",
      new SyntheticGroupChatHost({ wrongMemorySource: true }),
    );
    expect(result.passed).toBe(false);
  });

  it("fails GC-03 when judge-seeded private canaries cross resident contexts", async () => {
    const result = await runGroupChatCheck(
      "GC-03",
      new SyntheticGroupChatHost({ leakPrivateCanaries: true }),
    );
    expect(result.passed).toBe(false);
  });

  it("requires each resident to read back its own judge-seeded private canary", async () => {
    const result = await runGroupChatCheck(
      "GC-03",
      new SyntheticGroupChatHost({ noopSeedPrivate: true }),
    );
    expect(result.passed).toBe(false);
  });

  it("fails GC-03 when a delivery ledger setup/readback is omitted", async () => {
    const result = await runGroupChatCheck(
      "GC-03",
      new SyntheticGroupChatHost({ skipDeliveryFor: fixture.residentIds.b }),
    );
    expect(result.passed).toBe(false);
  });

  it("checks roster version relatively and detects a non-incrementing add", async () => {
    const result = await runGroupChatCheck(
      "GC-04",
      new SyntheticGroupChatHost({ noRosterVersionBump: true }),
    );
    expect(result.passed).toBe(false);
  });

  it("fails if any newly added resident projection path is skipped", async () => {
    const result = await runGroupChatCheck(
      "GC-04",
      new SyntheticGroupChatHost({ skipRosterPath: "feedback" }),
    );
    expect(result.passed).toBe(false);
  });

  it("checks the roster membership list before and after addition, not just its version", async () => {
    const result = await runGroupChatCheck(
      "GC-04",
      new SyntheticGroupChatHost({ rosterSnapshotOmitsNewResident: true }),
    );
    expect(result.passed).toBe(false);
  });

  it("fails if a structured mention bypasses the stop/turn gate", async () => {
    const result = await runGroupChatCheck(
      "GC-05",
      new SyntheticGroupChatHost({ bypassGate: true }),
    );
    expect(result.passed).toBe(false);
  });

  it("fails if any plain-text mention variant routes a call", async () => {
    const result = await runGroupChatCheck(
      "GC-05",
      new SyntheticGroupChatHost({ routePlainText: true }),
    );
    expect(result.passed).toBe(false);
  });

  it("requires one real route for a legitimate structured mention while the gate is open", async () => {
    const result = await runGroupChatCheck(
      "GC-05",
      new SyntheticGroupChatHost({ deadRouter: true }),
    );
    expect(result.passed).toBe(false);
  });

  it.each([
    ["👀", true],
    ["👀 已装入，不代表理解", true],
    ["我看见了", true],
    ["我看见了，不代表理解", true],
    ["seen; does not mean the member understood", true],
    ["系统已收，成员尚未派发", false],
    ["已装入，不代表理解", false],
    ["仍不等于理解或记忆", false],
    ["does not mean the member understood", false],
    ["成员尚未理解", false],
    ["typing", true],
    ["已读", true],
    ["不到一秒就已读", true],
    ["不一会儿我看见了", true],
    ["没多久就看到了", true],
    ["我不但看见了", true],
    ["不久前已读", true],
    ["成员未看见", false],
    ["成员不一定看到", false],
    ["成员未必看见", false],
    ["没有看见", false],
    ["尚未看到", false],
    ["已装入，不代表成员已读", false],
    ["ready; already; recorded", false],
  ])("classifies system claim %j as unsupported=%s", (claim, unsupported) => {
    expect(isUnsupportedPersonalClaim(String(claim))).toBe(unsupported);
  });

  it("rejects a context-committed receipt that points to arbitrary non-empty x", async () => {
    const result = await runGroupChatCheck(
      "GC-09",
      new SyntheticGroupChatHost({ contextCommitRef: "x" }),
    );
    expect(result.passed).toBe(false);
  });

  it("fails if later-stage receipts are visible before their host operations", async () => {
    const result = await runGroupChatCheck(
      "GC-09",
      new SyntheticGroupChatHost({ publishFutureReceiptsEarly: true }),
    );
    expect(result.passed).toBe(false);
  });

  it("runs claim probes through the judge/readback path", async () => {
    for (const claim of [
      "👀",
      "👀 已装入，不代表理解",
      "我看见了",
      "我看见了，不代表理解",
      "seen; does not mean the member understood",
      "typing",
      "已读",
      "不到一秒就已读",
      "不一会儿我看见了",
      "没多久就看到了",
      "我不但看见了",
      "不久前已读",
    ]) {
      const result = await runGroupChatCheck(
        "GC-09",
        new SyntheticGroupChatHost({ claimOverride: claim }),
      );
      expect(result.passed, claim).toBe(false);
    }
    for (const claim of [
      "系统已收，成员尚未派发",
      "已装入，不代表理解",
      "仍不等于理解或记忆",
      "does not mean the member understood",
      "成员尚未理解",
      "成员未看见",
      "成员不一定看到",
      "成员未必看见",
      "没有看见",
      "尚未看到",
      "已装入，不代表成员已读",
      "ready; already; recorded",
    ]) {
      const result = await runGroupChatCheck(
        "GC-09",
        new SyntheticGroupChatHost({ claimOverride: claim }),
      );
      expect(result.passed, claim).toBe(true);
    }
  });

  it("makes hidden-room body and side-channel surfaces invariant across hidden canaries", async () => {
    const result = await runGroupChatCheck("GC-15", new SyntheticGroupChatHost());
    expect(result.passed).toBe(true);
  });

  it("fails if a hidden canary leaks or the public event is replayed across rooms", async () => {
    expect(
      (
        await runGroupChatCheck(
          "GC-15",
          new SyntheticGroupChatHost({ leakHiddenToUnauthorized: true }),
        )
      ).passed,
    ).toBe(false);
    expect(
      (
        await runGroupChatCheck(
          "GC-15",
          new SyntheticGroupChatHost({ acceptCrossRoomReplay: true }),
        )
      ).passed,
    ).toBe(false);
  });

  it("requires the hidden canary world and judge-seeded public readback to exist", async () => {
    expect(
      (await runGroupChatCheck("GC-15", new SyntheticGroupChatHost({ noHiddenRoom: true }))).passed,
    ).toBe(false);
    expect(
      (await runGroupChatCheck("GC-15", new SyntheticGroupChatHost({ publicBodyX: true }))).passed,
    ).toBe(false);
  });

  it("copies command arguments and host readbacks at the adapter boundary", async () => {
    const raw = new SyntheticGroupChatHost();
    const driver = cloneGroupChatDriverBoundary(raw);
    const command: GroupChatCommand = {
      kind: "post",
      roomId: fixture.roomId,
      principalId: fixture.humanId,
      visibility: "public",
      binding: "test-binding:owner",
      body: "TEST-CLONE-BOUNDARY",
    };
    await driver.perform(command);
    const result = await driver.readRoomEvents();
    const returned = result[0];
    expect(returned).toBeDefined();
    (returned as unknown as { body: string }).body = "mutated-return-value";
    expect(command.body).toBe("TEST-CLONE-BOUNDARY");
    expect((await raw.readRoomEvents())[0]?.body).toBe("TEST-CLONE-BOUNDARY");
  });

  it("reports absent production adapter as seven expected red lamps", () => {
    const results = runnerMissingDriverResults();
    expect(results.map(({ id }) => id)).toEqual(GROUP_CHAT_CHECK_IDS);
    expect(
      results.every(({ passed, detail }) => !passed && detail.includes("real-host driver missing")),
    ).toBe(true);
  });

  it("counts declared STUBBED methods as yellow lamps, never true green or strict pass", () => {
    const stubbedResults = groupChatChecks.map((check) => ({
      id: check.id,
      title: check.title,
      passed: true,
      stubbed: check.uses.includes("perform"),
      detail: "synthetic positive-control readback",
    }));
    expect(scoreGroupChatResults(stubbedResults)).toEqual({
      trueGreen: 0,
      stubGreen: 7,
      strictPass: false,
    });

    const realResults = stubbedResults.map((result) => ({ ...result, stubbed: false }));
    expect(scoreGroupChatResults(realResults)).toEqual({
      trueGreen: 7,
      stubGreen: 0,
      strictPass: true,
    });
  });
});
