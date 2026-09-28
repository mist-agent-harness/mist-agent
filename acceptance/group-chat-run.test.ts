import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type GroupChatJudgeContext,
  evaluateGroupChatEvidence,
  groupChatChecks,
  isPersonalStatePhase,
  isUnsupportedPersonalClaim,
  runGroupChatCheck,
} from "./group-chat-checks.ts";
import {
  type AccessAudit,
  type CallReceipt,
  type ContextCommit,
  type DeliveryRecord,
  type DualCommitStatus,
  type ExternalCallAttempt,
  GROUP_CHAT_CHECK_IDS,
  type GroupChatCheckId,
  type GroupChatCommand,
  type GroupChatHostDriver,
  type MainstreamEntry,
  type MemoryRecord,
  type MentionDecision,
  type PendingPluginItem,
  type PluginBridgeState,
  type PluginEntryAttempt,
  type PublishOutcome,
  type QuarantineRecord,
  type ResidentId,
  type ResidentReaction,
  type RoomEvent,
  type RosterPath,
  type RosterProjection,
  type RosterSnapshot,
  type SurfaceSnapshot,
  type SystemReceipt,
  cloneGroupChatDriverBoundary,
  groupChatSyntheticFixture as fixture,
} from "./group-chat-driver.ts";
import {
  type HostProcessInfo,
  type HostProvenanceFacts,
  findSourceLiterals,
  hostProvenanceProblem,
  hostStopProblem,
  isRepoEntryFile,
  provenanceFailedResults,
  readProcessInfo,
  restartedHostProblem,
  missingDriverResults as runnerMissingDriverResults,
  scoreGroupChatResults,
} from "./group-chat-run.ts";

interface TestOptions {
  readonly acceptForged?: boolean;
  readonly dropForgedBodyPost?: boolean;
  readonly trustBodyAuthorHeader?: boolean;
  readonly acceptInvalidPosts?: boolean;
  /** Checks boundaries on the human entry only: accept a resident post with just this defect. */
  readonly acceptOnlyInvalid?: "visibility" | "room" | "binding" | "private-fields";
  readonly wrongMemorySource?: boolean;
  readonly noopSeedPrivate?: boolean;
  readonly leakPrivateCanariesIntoRoom?: boolean;
  readonly noRosterVersionBump?: boolean;
  readonly rosterSnapshotOmitsNewResident?: boolean;
  readonly projectionsHardcode?: ResidentId;
  readonly bypassGate?: boolean;
  readonly deadRouter?: boolean;
  readonly contextCommitRef?: string;
  readonly claimOverride?: string;
  readonly publishFutureReceiptsEarly?: boolean;
  readonly extraSystemPhase?: string;
  readonly proxyReaction?: boolean;
  readonly commitWritesMemory?: boolean;
  readonly residentReceiptAfterReaction?: boolean;
  readonly forgedResidentReceipt?: boolean;
  readonly skipRosterPath?: RosterPath;
  readonly leakHiddenToUnauthorized?: boolean;
  readonly revealHiddenExistence?: boolean;
  readonly noHiddenRoom?: boolean;
  readonly publicBodyX?: boolean;
  readonly acceptCrossRoomReplay?: boolean;
  readonly newResidentGetsHistory?: boolean;
  readonly leakResidentScope?: boolean;
  readonly silentScopeRead?: boolean;
  readonly leakPrivateCanaries?: boolean;
  readonly skipDeliveryFor?: ResidentId;
  readonly routePlainText?: boolean;
  readonly routeBareName?: boolean;
  readonly resolvePlainTextTarget?: boolean;
  readonly omitPlainDecisions?: boolean;
  readonly holdGatedMentions?: boolean;
  readonly acceptUnknownTargetWithoutCall?: boolean;
  /** #202 second-review probes: calls the decisions do not account for. */
  readonly plainCallOffDecision?: boolean;
  readonly orphanCalls?: boolean;
  readonly gatedCallsWithoutDecision?: boolean;
  readonly heldButCalled?: boolean;
  readonly phantomReceipt?: boolean;
  readonly wrongTargetReceipt?: boolean;
  readonly duplicateDecision?: boolean;
  readonly blankReason?: boolean;
  readonly preexistingCall?: boolean;
  readonly rewriteLedger?: boolean;
  readonly newcomerSurfaceIncludesRoomBody?: boolean;
  readonly newcomerSeesPreJoinIds?: boolean;
  readonly newcomerMissesPostJoin?: boolean;
  readonly duplicatePositions?: boolean;
  // —— GC-11 ——
  /** Buggy host: accepts a same-key request whose content differs instead of conflicting. */
  readonly gc11AcceptConflictingContent?: boolean;
  /** Buggy host: commits a publish even though the crash was armed before the room commit. */
  readonly gc11FalseSuccessBeforeCommit?: boolean;
  /** Buggy host: loses a publish that should have survived a post-commit, pre-ack crash. */
  readonly gc11LoseCommitAfterCrash?: boolean;
  /** Buggy host: fires a second external call attempt instead of checking the ledger first. */
  readonly gc11BlindResendOnRestart?: boolean;
  // —— GC-13 ——
  /** Buggy host: reports every plugin-entry attempt as reachable regardless of bridge state. */
  readonly gc13AlwaysReachable?: boolean;
  /** Buggy host: still delivers a queued message after the agent/entry was revoked. */
  readonly gc13DeliverAfterRevoke?: boolean;
  /** Buggy host: still reports the in-flight call as a completed success after revocation. */
  readonly gc13CompleteAfterRevoke?: boolean;
  /** Buggy host: a resource failure leaves no quarantine trace. */
  readonly gc13NoQuarantineTrace?: boolean;
  /** Buggy host: falls back to the seeded terminal/private-file canary and leaks it. */
  readonly gc13LeakFallbackCanary?: boolean;
  /** Buggy host: a plugin failure for one resident also blocks another resident's post. */
  readonly gc13OtherResidentBlocked?: boolean;
  /** Buggy host: a plugin failure blocks the human control plane's post. */
  readonly gc13HumanBlocked?: boolean;
  // —— GC-14 ——
  /** Buggy host: accepts a direct append that bypasses the bounded mainstream writer. */
  readonly gc14AcceptArbitraryAppend?: boolean;
  /** Buggy host: publishes success even though only the room side committed before the crash. */
  readonly gc14FalseSuccessOnCrash?: boolean;
  /** Buggy host: does not keep a pending-reconciliation record after a half-committed crash. */
  readonly gc14NoReconciliationRecord?: boolean;
  /** Buggy host: claims external delivery for a half-committed, still-reconciling entry. */
  readonly gc14ClaimsExternalDelivery?: boolean;
  /** Buggy host: a resident's mainstream includes another resident's room post. */
  readonly gc14OtherResidentLeaksIntoMainstream?: boolean;
}

/** Test-only host model; production runner never imports this adapter. */
class SyntheticGroupChatHost implements GroupChatHostDriver {
  readonly kind = "mist-host" as const;
  readonly options: TestOptions;
  private events: RoomEvent[] = [];
  private eventTime = new Map<string, number>();
  private roomCounters = new Map<string, number>();
  private clock = 1;
  private deliveries = new Map<string, DeliveryRecord[]>();
  private memories: MemoryRecord[] = [];
  private privateContexts = new Map<ResidentId, string[]>();
  private roster = new Set<ResidentId>([fixture.residentIds.a, fixture.residentIds.b]);
  private joinedAt = new Map<ResidentId, number>();
  private rosterVersion = 1;
  private projections = new Map<RosterPath, RosterProjection>();
  private decisions: MentionDecision[] = [];
  private callLedger: CallReceipt[] = [];
  private callCounter = 0;
  private receipts: SystemReceipt[] = [];
  private commits: ContextCommit[] = [];
  private reactions: ResidentReaction[] = [];
  private rooms = new Map<string, { visibility: "public" | "hidden"; body: string }>();
  private gateStopped = false;
  private gateTurnOpen = true;
  private crossResidentPrivateReads = 0;
  private unauthorizedReadResults: string[] = [];
  // —— GC-11 ——
  private publishOutcomes = new Map<string, PublishOutcome>();
  private publishContent = new Map<
    string,
    { body: string; mentions: readonly string[]; roomId: string; rootEventMarker: string | null }
  >();
  private externalCallAttempts: ExternalCallAttempt[] = [];
  // —— GC-13 ——
  private pluginBridgeState = new Map<ResidentId, PluginBridgeState>();
  private pluginEntryAttempts: PluginEntryAttempt[] = [];
  private pendingPluginItems: PendingPluginItem[] = [];
  private quarantineRecords: QuarantineRecord[] = [];
  private pluginAgentRevoked = new Set<ResidentId>();
  // —— GC-14 ——
  private mainstream: MainstreamEntry[] = [];
  private dualCommitStatuses = new Map<string, DualCommitStatus>();

  constructor(options: TestOptions = {}) {
    this.options = options;
  }

  async startHost() {
    return { pid: 12345, commit: "synthetic-test-only" };
  }
  async stopHost(): Promise<void> {}

  async resetScenario(_id: GroupChatCheckId): Promise<void> {
    this.events = [];
    this.eventTime.clear();
    this.roomCounters.clear();
    this.clock = 1;
    this.deliveries.clear();
    this.memories = [];
    this.privateContexts.clear();
    this.roster = new Set([fixture.residentIds.a, fixture.residentIds.b]);
    this.joinedAt = new Map<ResidentId, number>([
      [fixture.residentIds.a, 0],
      [fixture.residentIds.b, 0],
    ]);
    this.rosterVersion = 1;
    this.projections.clear();
    this.decisions = [];
    // A durable ledger may survive a scenario reset; the judge must only count its own window.
    this.callLedger = this.options.preexistingCall
      ? [{ id: "call:before-scenario", targetId: fixture.residentIds.a }]
      : [];
    this.callCounter = 0;
    this.receipts = [];
    this.commits = [];
    this.reactions = [];
    this.rooms.clear();
    this.gateStopped = false;
    this.gateTurnOpen = true;
    this.crossResidentPrivateReads = 0;
    this.unauthorizedReadResults = [];
    this.publishOutcomes.clear();
    this.publishContent.clear();
    this.externalCallAttempts = [];
    this.pluginBridgeState.clear();
    this.pluginEntryAttempts = [];
    this.pendingPluginItems = [];
    this.quarantineRecords = [];
    this.pluginAgentRevoked.clear();
    this.mainstream = [];
    this.dualCommitStatuses.clear();
  }

  /** Per-room event ids: a global counter would itself reveal hidden-room traffic (GC-15). */
  private addEvent(event: Omit<RoomEvent, "id" | "position">): void {
    const next = (this.roomCounters.get(event.roomId) ?? 0) + 1;
    this.roomCounters.set(event.roomId, next);
    const id = `event:${event.roomId}#${next}`;
    this.eventTime.set(id, this.clock++);
    this.events.push({ ...event, id, position: this.options.duplicatePositions ? 1 : next });
  }

  private call(targetId: string): string {
    this.callCounter += 1;
    const id = `call:${this.callCounter}`;
    this.callLedger.push({ id, targetId });
    return id;
  }

  private decide(decision: MentionDecision): void {
    const recorded = this.options.blankReason ? { ...decision, reason: "" } : decision;
    this.decisions.push(recorded);
    if (this.options.duplicateDecision && decision.outcome === "accepted")
      this.decisions.push({ ...recorded });
  }

  /** GC-11: commit a room event for `key` and record it as the key's canonical outcome. */
  private commitPublish(
    key: string,
    input: { readonly roomId: string; readonly principalId: ResidentId; readonly body: string },
  ): void {
    this.addEvent({
      roomId: input.roomId,
      authorId: input.principalId,
      body: input.body,
      visibility: "public",
    });
    const event = this.events.at(-1);
    if (event === undefined) return;
    this.publishOutcomes.set(key, {
      operationKey: key,
      status: "committed",
      eventId: event.id,
      reason: null,
    });
    const rows = this.deliveries.get(event.id) ?? [];
    rows.push({ residentId: input.principalId, state: "loaded" });
    this.deliveries.set(event.id, rows);
  }

  async perform(command: GroupChatCommand): Promise<void> {
    switch (command.kind) {
      case "post": {
        if (this.options.dropForgedBodyPost && command.body.includes("TEST-GC01-BODY-FORGERY"))
          return;
        // GC-13 negative-test options: a buggy host lets one resident's plugin fault drag
        // down another resident's post or the human control plane's post.
        if (this.options.gc13OtherResidentBlocked && command.principalId === fixture.residentIds.b)
          return;
        if (this.options.gc13HumanBlocked && command.principalId === fixture.humanId) return;
        const valid =
          command.roomId !== "" &&
          command.visibility === "public" &&
          command.binding === "test-binding:owner" &&
          command.privateFields === undefined &&
          command.claimedAuthorId === undefined;
        const defects = [
          command.visibility !== "public" ? "visibility" : null,
          command.roomId === "" ? "room" : null,
          command.binding !== "test-binding:owner" ? "binding" : null,
          command.privateFields !== undefined ? "private-fields" : null,
          command.claimedAuthorId !== undefined ? "claimed-author" : null,
        ].filter((defect) => defect !== null);
        const toleratedDefect =
          command.principalId !== fixture.humanId &&
          defects.length === 1 &&
          defects[0] === this.options.acceptOnlyInvalid;
        if (
          !valid &&
          !toleratedDefect &&
          !this.options.acceptInvalidPosts &&
          !this.options.acceptForged
        )
          return;
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
        this.addEvent({
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
          this.joinedAt.set(command.residentId, this.clock);
          if (!this.options.noRosterVersionBump) this.rosterVersion += 1;
        }
        return;
      case "exercise-roster-path": {
        if (this.options.skipRosterPath === command.path) return;
        const hardcoded = this.options.projectionsHardcode;
        const residentIds =
          hardcoded === undefined
            ? [...this.roster]
            : [...this.roster].filter(
                (id) =>
                  id === fixture.residentIds.a || id === fixture.residentIds.b || id === hardcoded,
              );
        this.projections.set(command.path, { residentIds, humanIds: [fixture.humanId] });
        return;
      }
      case "plain-text-mention": {
        if (this.options.omitPlainDecisions) return;
        const target = fixture.residentIds.b;
        const bareName = command.body.replaceAll(`@${target}`, "").includes(target);
        const routed =
          this.options.routePlainText === true || (this.options.routeBareName === true && bareName);
        // Review probe: the call happens, but this operation's decision does not cite it.
        if (this.options.plainCallOffDecision) this.call(target);
        this.decide({
          operationId: command.operationId,
          outcome: routed ? "accepted" : "rejected",
          reason: routed ? "text-mention" : "no-structured-target",
          targetId: routed || this.options.resolvePlainTextTarget ? target : null,
          callReceiptIds: routed ? [this.call(target)] : [],
        });
        return;
      }
      case "structured-mention": {
        const validTarget = [...this.roster].includes(command.targetId as ResidentId);
        const gateClosed = this.gateStopped || !this.gateTurnOpen;
        const operationId = command.operationId;
        if (this.options.rewriteLedger)
          this.callLedger = this.callLedger.filter(({ id }) => id !== "call:before-scenario");
        // Review probe: calls made while the gate is closed, with no decision at all.
        if (gateClosed && this.options.gatedCallsWithoutDecision) {
          this.call(command.targetId);
          return;
        }
        if (!validTarget && !gateClosed && this.options.acceptUnknownTargetWithoutCall) {
          this.decide({
            operationId,
            outcome: "accepted",
            reason: "unchecked-target",
            targetId: command.targetId,
            callReceiptIds: [],
          });
          return;
        }
        if (
          gateClosed &&
          validTarget &&
          (this.options.holdGatedMentions || this.options.heldButCalled)
        ) {
          if (this.options.heldButCalled) this.call(command.targetId);
          this.decide({
            operationId,
            outcome: "held",
            reason: "gate-closed",
            targetId: command.targetId,
            callReceiptIds: [],
          });
          return;
        }
        const rejected = gateClosed || !validTarget || this.options.deadRouter === true;
        const calls = !rejected || (gateClosed && this.options.bypassGate === true);
        // Review probe: extra calls outside every decision (the NOT-A-JUDGE-MARKER rows).
        if (calls && !gateClosed && this.options.orphanCalls)
          for (let extra = 0; extra < 5; extra += 1) this.call(command.targetId);
        let callReceiptIds: string[] = [];
        if (calls && this.options.phantomReceipt) callReceiptIds = ["call:never-made"];
        else if (calls)
          callReceiptIds = [
            this.call(this.options.wrongTargetReceipt ? fixture.residentIds.a : command.targetId),
          ];
        this.decide({
          operationId,
          outcome: calls ? "accepted" : "rejected",
          reason: calls ? "structured-target" : gateClosed ? "gate-closed" : "invalid-target",
          targetId: validTarget ? command.targetId : null,
          callReceiptIds,
        });
        return;
      }
      case "set-turn-gate":
        this.gateStopped = command.stopped;
        this.gateTurnOpen = command.turnOpen;
        return;
      case "record-event": {
        this.addEvent({
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
        const claim = this.options.claimOverride ?? "已派发，尚未装入成员上下文";
        this.receipts.push({ actor: "system", phase: "dispatched", claim });
        if (this.options.extraSystemPhase !== undefined) {
          this.receipts.push({
            actor: "system",
            phase: this.options.extraSystemPhase,
            claim: "排队等待装入",
          });
        }
        if (this.options.proxyReaction) {
          this.reactions.push({
            residentId: fixture.residentIds.a,
            eventMarker: command.eventMarker,
          });
        }
        if (this.options.forgedResidentReceipt) {
          this.receipts.push({ actor: fixture.residentIds.b, phase: "reaction" });
        }
        return;
      }
      case "commit-context": {
        const id = `context-commit:${this.clock++}`;
        this.commits.push({ id, residentId: command.residentId, marker: command.marker });
        this.receipts.push({
          actor: "system",
          phase: "context-committed",
          claim: this.options.claimOverride ?? "已装入，不代表理解",
          contextCommitRef: this.options.contextCommitRef ?? id,
        });
        if (this.options.commitWritesMemory) {
          this.memories.push({
            residentId: command.residentId,
            sourceEventId: null,
            body: command.marker,
          });
        }
        return;
      }
      case "react":
        this.reactions.push({ residentId: command.residentId, eventMarker: command.eventMarker });
        if (this.options.residentReceiptAfterReaction) {
          this.receipts.push({ actor: command.residentId, phase: "reaction" });
        }
        return;
      case "create-room":
        if (this.options.noHiddenRoom && command.visibility === "hidden") return;
        this.rooms.set(command.roomId, { visibility: command.visibility, body: command.body });
        this.addEvent({
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
          this.addEvent({
            roomId: command.targetRoomId,
            authorId: source.authorId,
            body: source.body,
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
      case "attempt-resident-scope-read": {
        if (this.options.silentScopeRead) return;
        this.unauthorizedReadResults.push("not-found");
        if (this.options.leakResidentScope) {
          const owner = this.privateContexts.get(command.ownerId) ?? [];
          const viewer = this.privateContexts.get(command.viewerId) ?? [];
          this.privateContexts.set(command.viewerId, [...viewer, ...owner]);
        }
        return;
      }
      case "set-resident":
        return;
      // —— GC-11 ——
      case "publish-idempotent": {
        const key = command.operationKey;
        const content = {
          body: command.body,
          mentions: command.mentions ?? [],
          roomId: command.roomId,
          rootEventMarker: command.rootEventMarker ?? null,
        };
        const existing = this.publishOutcomes.get(key);
        const prevContent = this.publishContent.get(key);
        if (existing !== undefined && prevContent !== undefined) {
          const same =
            prevContent.body === content.body &&
            prevContent.roomId === content.roomId &&
            prevContent.rootEventMarker === content.rootEventMarker &&
            prevContent.mentions.join("\0") === content.mentions.join("\0");
          if (same) return; // idempotent no-op: readback still returns the original result.
          if (!this.options.gc11AcceptConflictingContent) {
            this.publishOutcomes.set(key, {
              operationKey: key,
              status: "conflict",
              eventId: existing.eventId,
              reason: "content-mismatch",
            });
            return;
          }
          // Negative-test option only: a buggy host accepts the changed content anyway.
        }
        this.publishContent.set(key, content);
        this.commitPublish(key, {
          roomId: content.roomId,
          principalId: command.principalId,
          body: content.body,
        });
        return;
      }
      case "crash-during-publish": {
        if (command.crashPoint === "before-room-commit") {
          if (this.options.gc11FalseSuccessBeforeCommit)
            this.commitPublish(command.operationKey, command);
          return; // correct default: the host died before writing anything.
        }
        if (command.crashPoint === "after-room-commit-before-ack") {
          if (!this.options.gc11LoseCommitAfterCrash)
            this.commitPublish(command.operationKey, command);
          return;
        }
        // external-result-unknown: exactly one side-effect attempt, held pending.
        this.publishOutcomes.set(command.operationKey, {
          operationKey: command.operationKey,
          status: "pending",
          eventId: null,
          reason: "external-result-unknown",
        });
        this.externalCallAttempts.push({ operationKey: command.operationKey, attemptSeq: 1 });
        if (this.options.gc11BlindResendOnRestart)
          this.externalCallAttempts.push({ operationKey: command.operationKey, attemptSeq: 2 });
        return;
      }
      // —— GC-13 ——
      case "seed-plugin-bridge":
        this.pluginBridgeState.set(command.residentId, command.state);
        return;
      case "attempt-plugin-entry": {
        const state = this.pluginBridgeState.get(command.residentId) ?? "inactive";
        const reachable =
          this.options.gc13AlwaysReachable === true ||
          (state === "active" && !this.pluginAgentRevoked.has(command.residentId));
        this.pluginEntryAttempts.push({
          residentId: command.residentId,
          marker: command.marker,
          state,
          reachable,
          invoked: reachable,
        });
        return;
      }
      case "queue-plugin-message":
        this.pendingPluginItems.push({
          residentId: command.residentId,
          marker: command.marker,
          kind: "queued-message",
          delivered: false,
          completedAsSuccess: false,
        });
        return;
      case "start-in-flight-plugin-call":
        this.pendingPluginItems.push({
          residentId: command.residentId,
          marker: command.marker,
          kind: "in-flight-call",
          delivered: false,
          completedAsSuccess: false,
        });
        return;
      case "revoke-plugin-agent": {
        this.pluginAgentRevoked.add(command.residentId);
        this.pluginBridgeState.set(command.residentId, "inactive");
        this.pendingPluginItems = this.pendingPluginItems.map((item) =>
          item.residentId === command.residentId
            ? {
                ...item,
                delivered: this.options.gc13DeliverAfterRevoke === true,
                completedAsSuccess: this.options.gc13CompleteAfterRevoke === true,
              }
            : item,
        );
        if (!this.options.gc13NoQuarantineTrace)
          this.quarantineRecords.push({
            residentId: command.residentId,
            reason: "plugin-agent-revoked",
          });
        return;
      }
      case "seed-fallback-canary": {
        if (this.options.gc13LeakFallbackCanary) {
          // Negative-test option: a buggy host bypasses the failure and uses this "terminal
          // input / private file" stand-in as a silent fallback data source.
          this.addEvent({
            roomId: fixture.roomId,
            authorId: "test-host:fallback",
            body: command.canary,
            visibility: "public",
          });
        }
        return;
      }
      // —— GC-14 ——
      case "publish-dual-account": {
        this.addEvent({
          roomId: command.roomId,
          authorId: command.residentId,
          body: command.body,
          visibility: "public",
        });
        const event = this.events.at(-1);
        if (event === undefined) return;
        const leakOther =
          this.options.gc14OtherResidentLeaksIntoMainstream === true &&
          command.residentId === fixture.residentIds.a;
        this.mainstream.push({
          residentId: command.residentId,
          operationKey: command.operationKey,
          roomEventId: event.id,
          authorId: command.residentId,
          body: command.body,
          claimsExternalDelivery: false,
        });
        if (leakOther) {
          this.mainstream.push({
            residentId: command.residentId,
            operationKey: null,
            roomEventId: null,
            authorId: fixture.residentIds.b,
            body: "TEST-GC14-OTHER-RESIDENT-LEAK",
            claimsExternalDelivery: false,
          });
        }
        return;
      }
      case "attempt-arbitrary-mainstream-append": {
        if (this.options.gc14AcceptArbitraryAppend) {
          this.mainstream.push({
            residentId: command.residentId,
            operationKey: null,
            roomEventId: null,
            authorId: command.residentId,
            body: command.body,
            claimsExternalDelivery: false,
          });
        }
        return; // correct default: rejected, no entry created.
      }
      case "crash-during-dual-commit": {
        this.addEvent({
          roomId: command.roomId,
          authorId: command.residentId,
          body: command.body,
          visibility: "public",
        });
        const event = this.events.at(-1);
        const roomEventId = event?.id ?? null;
        const falseSuccess = this.options.gc14FalseSuccessOnCrash === true;
        if (falseSuccess) {
          this.mainstream.push({
            residentId: command.residentId,
            operationKey: command.operationKey,
            roomEventId,
            authorId: command.residentId,
            body: command.body,
            claimsExternalDelivery: this.options.gc14ClaimsExternalDelivery === true,
          });
        }
        this.dualCommitStatuses.set(command.operationKey, {
          operationKey: command.operationKey,
          roomCommitted: true,
          mainstreamCommitted: falseSuccess,
          publishedAsSuccess: falseSuccess,
          reconciliationPending: !this.options.gc14NoReconciliationRecord,
          claimsExternalDelivery: this.options.gc14ClaimsExternalDelivery === true,
        });
        return;
      }
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
  async readMentionDecisions(): Promise<readonly MentionDecision[]> {
    return this.decisions;
  }
  async readCallLedger(): Promise<readonly CallReceipt[]> {
    return this.callLedger;
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
        return {
          body: room.body,
          visibleEventIds: [],
          candidates: [],
          count: 1,
          errorCode: null,
          receipt: null,
        };
      }
      return {
        body: "",
        visibleEventIds: [],
        candidates: [],
        count: 0,
        errorCode: this.options.revealHiddenExistence ? "forbidden" : "not-found",
        receipt: null,
      };
    }
    // A resident sees room history from its join time; the owner and outsiders keep the
    // all-public view. Residents a and b joined at 0, before anything was recorded.
    const joined = this.options.newResidentGetsHistory
      ? undefined
      : this.joinedAt.get(viewerId as ResidentId);
    const newcomer = joined !== undefined && joined > 0;
    const roomPublic = this.events.filter(
      (event) => event.roomId === roomId && event.visibility === "public",
    );
    const visibleEvents =
      newcomer && this.options.newcomerMissesPostJoin
        ? []
        : roomPublic.filter(
            (event) => joined === undefined || (this.eventTime.get(event.id) ?? 0) >= joined,
          );
    const bodies = visibleEvents.map((event) => event.body);
    // Review probe: the room's seed body glued onto a newcomer's surface outside the event list.
    if (newcomer && room && this.options.newcomerSurfaceIncludesRoomBody) bodies.unshift(room.body);
    const listed = newcomer && this.options.newcomerSeesPreJoinIds ? roomPublic : visibleEvents;
    return {
      body: this.options.publicBodyX && roomId === fixture.roomId ? "x" : bodies.join("\n"),
      visibleEventIds: listed.map(({ id }) => id),
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
  // —— GC-11 ——
  async readPublishOutcomes(operationKey?: string): Promise<readonly PublishOutcome[]> {
    const all = [...this.publishOutcomes.values()];
    return operationKey === undefined
      ? all
      : all.filter((item) => item.operationKey === operationKey);
  }
  async readExternalCallAttempts(operationKey?: string): Promise<readonly ExternalCallAttempt[]> {
    return operationKey === undefined
      ? this.externalCallAttempts
      : this.externalCallAttempts.filter((item) => item.operationKey === operationKey);
  }
  // —— GC-13 ——
  async readPluginEntryAttempts(): Promise<readonly PluginEntryAttempt[]> {
    return this.pluginEntryAttempts;
  }
  async readQuarantineLog(): Promise<readonly QuarantineRecord[]> {
    return this.quarantineRecords;
  }
  async readPendingPluginItems(residentId?: ResidentId): Promise<readonly PendingPluginItem[]> {
    return residentId === undefined
      ? this.pendingPluginItems
      : this.pendingPluginItems.filter((item) => item.residentId === residentId);
  }
  // —— GC-14 ——
  async readMainstream(residentId: ResidentId): Promise<readonly MainstreamEntry[]> {
    return this.mainstream.filter((entry) => entry.residentId === residentId);
  }
  async readDualCommitStatus(operationKey?: string): Promise<readonly DualCommitStatus[]> {
    const all = [...this.dualCommitStatuses.values()];
    return operationKey === undefined
      ? all
      : all.filter((item) => item.operationKey === operationKey);
  }
}

/** No member-id literals found under src/ (the runner supplies the real scan). */
/**
 * GC-11/GC-14 use a synthetic in-memory host, not a real subprocess, so this stub only needs to
 * report a plausible fresh run; the real restart-provenance arithmetic (`restartedHostProblem`)
 * is exercised directly against fake process facts in the "runner: real-host provenance" suite
 * below, the same split already used for `hostProvenanceProblem`/`hostStopProblem`.
 */
const judge: GroupChatJudgeContext = {
  findSourceLiterals: async () => [],
  relaunchAfterCrash: async () => ({ pid: 54321, commit: "synthetic-test-only-restarted" }),
};

/** A relaunch that always fails verification, for GC-11/GC-14's "restart could not be proven" branch. */
const failingRelaunchJudge: GroupChatJudgeContext = {
  findSourceLiterals: async () => [],
  relaunchAfterCrash: async () => {
    throw new Error("synthetic: restart could not be verified");
  },
};

const check = (id: GroupChatCheckId, options: TestOptions = {}) =>
  runGroupChatCheck(id, new SyntheticGroupChatHost(options), judge);

/** Explicit personal-state assertions the system must never make on a member's behalf. */
const unsupportedClaims = [
  "👀",
  "👀 已装入，不代表理解",
  "已发送👀",
  "我看见了",
  "我看见了，不代表理解",
  "seen; does not mean the member understood",
  "the member has read it",
  "typing",
  "对方正在输入…",
  "输入中…",
  "已读",
  "系统已收，成员已读",
  "不代表理解，但已读",
  "不到一秒就已读",
  "不一会儿我看见了",
  "没多久就看到了",
  "我不但看见了",
  "不久前已读",
  "成员已理解",
  "成员已经记住",
  "记住了",
  "已写入记忆",
  "写入了长期记忆",
  // #202 second review: plain synonyms that slipped through, and 👀 under a denial span.
  "成员看见消息了",
  "成员看过这条消息",
  "住户记得这条",
  "成员阅读了消息",
  "对方在打字",
  "系统写入记忆",
  "不代表理解👀",
  "不是未读是已读",
  "member saw the message",
  // Clause and subject edges that must stay red.
  "系统：已读",
  "系统代发已读",
  "已读但不代表理解",
  "成员已经看过并理解了",
  "已装入，不代表成员已读👀",
  // #202 third review: 过 / 正在 affirmatives, reading-class 正在 still red, member subject + config.
  "看见过",
  "看到过",
  "理解过",
  "理解过了",
  "记住过",
  "记住过了",
  "明白过",
  "正在理解",
  "正在记住",
  "正在看见",
  "正在阅读",
  "不代表正在输入",
  "成员已读完配置",
  "住户已读完配置",
  "住户小明已读完配置",
  "他已读完配置",
  "小明已读完配置",
  "Ada已读完配置",
  "系统小明已读完配置",
  "系统我已看到投递失败",
];

/**
 * Honest wording must stay green: bare verbs used in denials, the design doc's own sentence,
 * and every example the #202 review showed being misread as an impersonation.
 */
const honestClaims = [
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
  "不代表已读、理解",
  "ready; already; recorded",
  "not read yet",
  "has not been read",
  "等待用户输入",
  "请在下方输入",
  "输入法",
  "输入中文不受影响",
  "系统不写入记忆",
  "未写入记忆",
  "已装入，尚未形成记忆",
  "装入也不证明住户理解、认同、回复或写入记忆",
  "已装入，不证明写入记忆",
  "没有👀",
  "系统不发送👀",
  "系统已读取配置",
  "以 read-only 方式装入",
  // #202 second review: the system's own reading, misread as a member's.
  "已读完配置",
  "系统已看到投递失败",
  "系统读了配置",
  "查看过程日志",
  "成员没看过",
  "成员不记得",
  "待写入记忆",
  // #202 third review: negation still clears the new forms; 不代表正在阅读; config without a member subject.
  "不代表看见过",
  "没有理解过",
  "不证明记住过了",
  "没有正在理解",
  "不代表正在记住",
  "看见",
  "理解",
  "记住",
  "理解过程",
  "看见过程",
  "不代表正在阅读",
  "没有正在阅读",
  "不证明正在阅读",
  "系统已读完配置",
  "代码已读完配置",
  "其他已读完配置",
  "刚刚已读完配置",
  "代表已读完配置",
  "日志已读完配置",
  "不到一秒就已读完配置",
];

describe("#191 group-chat acceptance: judge-driven synthetic host checks", () => {
  it("freezes exactly the ten frozen PR1 lamps (#191 + #193) and synthetic fixtures", () => {
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
      const result = await check(id);
      expect(result.passed, `${id}: ${result.detail}`).toBe(true);
    }
  });

  // Each negative must go red for its own reason, not trip an earlier, unrelated gate.
  it.each([
    ["GC-01", { acceptForged: true }, "伪造 envelope"],
    ["GC-01", { dropForgedBodyPost: true }, "正文身份伪造负例"],
    ["GC-01", { trustBodyAuthorHeader: true }, "正文身份伪造负例"],
    ["GC-02", { acceptInvalidPosts: true }, "缺显式边界"],
    // Each boundary on its own: the resident sender dropping only visibility must go red too.
    ["GC-02", { acceptOnlyInvalid: "visibility" }, "缺显式边界"],
    ["GC-02", { acceptOnlyInvalid: "room" }, "缺显式边界"],
    ["GC-02", { acceptOnlyInvalid: "binding" }, "缺显式边界"],
    ["GC-02", { acceptOnlyInvalid: "private-fields" }, "缺显式边界"],
    ["GC-02", { noopSeedPrivate: true }, "发送方私有"],
    ["GC-02", { leakPrivateCanariesIntoRoom: true }, "泄漏"],
    ["GC-03", { wrongMemorySource: true }, "指回原房间事件"],
    ["GC-03", { leakPrivateCanaries: true }, "串入"],
    ["GC-03", { noopSeedPrivate: true }, "读回本人"],
    ["GC-03", { skipDeliveryFor: fixture.residentIds.b }, "三条"],
    ["GC-04", { noRosterVersionBump: true }, "版本没有递增"],
    ["GC-04", { skipRosterPath: "feedback" }, "未贯通"],
    ["GC-04", { rosterSnapshotOmitsNewResident: true }, "未读回完整成员名单"],
    ["GC-04", { projectionsHardcode: fixture.residentIds.newcomer }, "novel-e"],
    ["GC-05", { bypassGate: true }, "绕过"],
    ["GC-05", { routePlainText: true }, "触发了调用"],
    ["GC-05", { routeBareName: true }, "触发了调用"],
    ["GC-05", { resolvePlainTextTarget: true }, "解析成了呼叫目标"],
    ["GC-05", { deadRouter: true }, "恰好路由一次"],
    ["GC-05", { acceptUnknownTargetWithoutCall: true }, "未知或越权目标"],
    ["GC-05", { omitPlainDecisions: true }, "缺 8 条"],
    ["GC-05", { plainCallOffDecision: true }, "不对应任何刺激"],
    ["GC-05", { orphanCalls: true }, "不对应任何刺激"],
    ["GC-05", { gatedCallsWithoutDecision: true }, "缺 2 条"],
    ["GC-05", { heldButCalled: true }, "不对应任何刺激"],
    ["GC-05", { phantomReceipt: true }, "呼叫账里没有的回执"],
    ["GC-05", { wrongTargetReceipt: true }, "未路由到正确住户"],
    ["GC-05", { duplicateDecision: true }, "重复 1 条"],
    ["GC-05", { blankReason: true }, "原因码"],
    ["GC-05", { preexistingCall: true, rewriteLedger: true }, "改写或删减"],
    ["GC-09", { contextCommitRef: "x" }, "提交引用"],
    ["GC-09", { publishFutureReceiptsEarly: true }, "提前出现"],
    ["GC-09", { proxyReaction: true }, "代发"],
    ["GC-09", { commitWritesMemory: true }, "写入记忆"],
    ["GC-09", { extraSystemPhase: "seen" }, "个人状态当成了阶段"],
    ["GC-09", { forgedResidentReceipt: true }, "没有本人 reaction"],
    ["GC-15", { leakHiddenToUnauthorized: true }, "泄漏"],
    ["GC-15", { acceptCrossRoomReplay: true }, "错误房间"],
    ["GC-15", { noHiddenRoom: true }, "对照世界"],
    ["GC-15", { publicBodyX: true }, "授权公开表面"],
    ["GC-15", { revealHiddenExistence: true }, "hidden-existence-difference"],
    ["GC-15", { leakResidentScope: true }, "内部 scope"],
    ["GC-15", { silentScopeRead: true }, "恰好一次拒绝"],
    ["GC-15", { newResidentGetsHistory: true }, "入群前"],
    ["GC-15", { newcomerSurfaceIncludesRoomBody: true }, "入群前"],
    ["GC-15", { newcomerSeesPreJoinIds: true }, "入群前"],
    ["GC-15", { newcomerMissesPostJoin: true }, "入群后看不到新消息"],
    ["GC-15", { duplicatePositions: true }, "位置"],
  ] as const)("%s goes red for its own reason under %j", async (id, options, reason) => {
    const result = await check(id, options);
    expect(result.passed).toBe(false);
    expect(result.detail).toContain(reason);
  });

  it("fails if the forged-envelope negative is silently accepted", async () => {
    expect((await check("GC-01", { acceptForged: true })).passed).toBe(false);
  });

  it("requires the judge to send and read back a body that impersonates another author", async () => {
    expect((await check("GC-01", { dropForgedBodyPost: true })).passed).toBe(false);
    expect((await check("GC-01", { trustBodyAuthorHeader: true })).passed).toBe(false);
  });

  it("counts recorded authors as a multiset, not by inclusion", () => {
    const base = {
      legitimateHuman: { accepted: true, authorId: fixture.humanId },
      legitimate: { accepted: true, authorId: fixture.residentIds.a },
      forgedEnvelopeAccepted: false,
      forgedBodyAccepted: true,
      forgedBodyAuthorId: fixture.residentIds.a,
      unexpectedAuthors: [],
    };
    const { humanId } = fixture;
    const { a } = fixture.residentIds;
    expect(
      evaluateGroupChatEvidence("GC-01", { ...base, recordedAuthorIds: [humanId, a, a] }).passed,
    ).toBe(true);
    const skewed = evaluateGroupChatEvidence("GC-01", {
      ...base,
      recordedAuthorIds: [humanId, humanId, a],
    });
    expect(skewed.passed).toBe(false);
    expect(skewed.detail).toContain("三条");
  });

  it("fails if malformed/private payload negatives are silently accepted", async () => {
    expect((await check("GC-02", { acceptInvalidPosts: true })).passed).toBe(false);
  });

  it("seeds private draft/tool canaries, reads them for the sender, and rejects public leakage", async () => {
    expect((await check("GC-02", { noopSeedPrivate: true })).passed).toBe(false);
    expect((await check("GC-02", { leakPrivateCanariesIntoRoom: true })).passed).toBe(false);
  });

  it("requires a personal-memory pointer to equal the exact judge-seeded room event", async () => {
    expect((await check("GC-03", { wrongMemorySource: true })).passed).toBe(false);
  });

  it("fails GC-03 when judge-seeded private canaries cross resident contexts", async () => {
    expect((await check("GC-03", { leakPrivateCanaries: true })).passed).toBe(false);
  });

  it("requires each resident to read back its own judge-seeded private canary", async () => {
    expect((await check("GC-03", { noopSeedPrivate: true })).passed).toBe(false);
  });

  it("fails GC-03 when a delivery ledger setup/readback is omitted", async () => {
    expect((await check("GC-03", { skipDeliveryFor: fixture.residentIds.b })).passed).toBe(false);
  });

  it("says GC-03 only covers separated ledger readback, not delivery semantics", async () => {
    const result = await check("GC-03");
    expect(result.passed).toBe(true);
    expect(result.detail).toContain("投递语义留待投递账阶段");
  });

  it("checks roster version relatively and detects a non-incrementing add", async () => {
    expect((await check("GC-04", { noRosterVersionBump: true })).passed).toBe(false);
  });

  it("fails if any newly added resident projection path is skipped", async () => {
    expect((await check("GC-04", { skipRosterPath: "feedback" })).passed).toBe(false);
  });

  it("checks the roster membership list before and after addition, not just its version", async () => {
    expect((await check("GC-04", { rosterSnapshotOmitsNewResident: true })).passed).toBe(false);
  });

  it("catches a roster path hard-wired to one newcomer by adding a different one", async () => {
    const result = await check("GC-04", { projectionsHardcode: fixture.residentIds.newcomer });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain(fixture.residentIds.newcomerAlt);
  });

  it("fails GC-04 when src/ spells out a member id, and scans for every fixture member", async () => {
    let scanned: readonly string[] = [];
    const result = await runGroupChatCheck("GC-04", new SyntheticGroupChatHost(), {
      findSourceLiterals: async (terms) => {
        scanned = terms;
        return ["src/group-chat/router.ts"];
      },
      relaunchAfterCrash: judge.relaunchAfterCrash,
    });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("src/group-chat/router.ts");
    expect(scanned).toEqual(
      expect.arrayContaining([
        fixture.humanId,
        fixture.residentIds.a,
        fixture.residentIds.newcomer,
        fixture.residentIds.newcomerAlt,
      ]),
    );
  });

  it("refuses to judge GC-04 without the judge-side static scan", async () => {
    await expect(runGroupChatCheck("GC-04", new SyntheticGroupChatHost())).rejects.toThrow(
      /findSourceLiterals/,
    );
  });

  it("fails if a structured mention bypasses the stop/turn gate", async () => {
    expect((await check("GC-05", { bypassGate: true })).passed).toBe(false);
  });

  it("fails if any plain-text mention variant routes a call", async () => {
    expect((await check("GC-05", { routePlainText: true })).passed).toBe(false);
  });

  it("covers bare member names, not only @name, in the plain-text negatives", async () => {
    expect((await check("GC-05", { routeBareName: true })).passed).toBe(false);
  });

  it("fails if plain text is resolved to a call target even without a call", async () => {
    expect((await check("GC-05", { resolvePlainTextTarget: true })).passed).toBe(false);
  });

  it("requires one real route for a legitimate structured mention while the gate is open", async () => {
    expect((await check("GC-05", { deadRouter: true })).passed).toBe(false);
  });

  it("asks each operation for its own decision instead of reading a missing row as a call", async () => {
    const result = await check("GC-05", { omitPlainDecisions: true });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("路由决定");
    expect(result.detail).not.toContain("触发了调用");
  });

  it("counts only this scenario's window of a call ledger that survives resets", async () => {
    const result = await check("GC-05", { preexistingCall: true });
    expect(result.passed, result.detail).toBe(true);
  });

  it("turns the #202 second review's off-marker and unrecorded calls red", async () => {
    const probes: TestOptions[] = [
      { plainCallOffDecision: true },
      { orphanCalls: true },
      { gatedCallsWithoutDecision: true },
    ];
    for (const probe of probes) {
      expect((await check("GC-05", probe)).passed, JSON.stringify(probe)).toBe(false);
    }
  });

  it("lets a closed gate hold a mention without calling it", async () => {
    const result = await check("GC-05", { holdGatedMentions: true });
    expect(result.passed, result.detail).toBe(true);
  });

  it("fails if an unknown target is accepted even when no call is made", async () => {
    expect((await check("GC-05", { acceptUnknownTargetWithoutCall: true })).passed).toBe(false);
  });

  it.each(unsupportedClaims)("flags system claim %j as an unsupported personal claim", (claim) => {
    expect(isUnsupportedPersonalClaim(claim)).toBe(true);
  });

  it.each(honestClaims)("keeps honest system claim %j green", (claim) => {
    expect(isUnsupportedPersonalClaim(claim)).toBe(false);
  });

  it("treats personal states as invalid system phases but allows extra system phases", () => {
    for (const phase of ["recorded", "dispatched", "context-committed", "queued", "thread-created"])
      expect(isPersonalStatePhase(phase), phase).toBe(false);
    for (const phase of ["seen", "read-receipt", "member_typing", "understood", "已读"])
      expect(isPersonalStatePhase(phase), phase).toBe(true);
  });

  it("rejects a context-committed receipt that points to arbitrary non-empty x", async () => {
    expect((await check("GC-09", { contextCommitRef: "x" })).passed).toBe(false);
  });

  it("fails if later-stage receipts are visible before their host operations", async () => {
    expect((await check("GC-09", { publishFutureReceiptsEarly: true })).passed).toBe(false);
  });

  it("runs claim probes through the judge/readback path", async () => {
    for (const claim of unsupportedClaims) {
      expect((await check("GC-09", { claimOverride: claim })).passed, claim).toBe(false);
    }
    for (const claim of honestClaims) {
      const result = await check("GC-09", { claimOverride: claim });
      expect(result.passed, `${claim}: ${result.detail}`).toBe(true);
    }
  });

  it("fails if the orchestrator adds a reaction before the resident reacts", async () => {
    const result = await check("GC-09", { proxyReaction: true });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("代发");
  });

  it("fails if committing context writes the resident's memory ledger", async () => {
    const result = await check("GC-09", { commitWritesMemory: true });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("记忆");
  });

  it("allows an extra system phase but not a personal state dressed as one", async () => {
    expect((await check("GC-09", { extraSystemPhase: "queued" })).passed).toBe(true);
    expect((await check("GC-09", { extraSystemPhase: "seen" })).passed).toBe(false);
  });

  it("allows a resident-authored receipt only when that resident really reacted", async () => {
    expect((await check("GC-09", { residentReceiptAfterReaction: true })).passed).toBe(true);
    expect((await check("GC-09", { forgedResidentReceipt: true })).passed).toBe(false);
  });

  it("makes hidden-room body and side-channel surfaces invariant across hidden canaries", async () => {
    expect((await check("GC-15")).passed).toBe(true);
  });

  it("fails if a hidden canary leaks or the public event is replayed across rooms", async () => {
    expect((await check("GC-15", { leakHiddenToUnauthorized: true })).passed).toBe(false);
    expect((await check("GC-15", { acceptCrossRoomReplay: true })).passed).toBe(false);
  });

  it("requires the hidden canary world and judge-seeded public readback to exist", async () => {
    expect((await check("GC-15", { noHiddenRoom: true })).passed).toBe(false);
    expect((await check("GC-15", { publicBodyX: true })).passed).toBe(false);
  });

  it("compares against a world without the hidden room, so existence cannot leak", async () => {
    const result = await check("GC-15", { revealHiddenExistence: true });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("hidden-existence-difference");
  });

  it("stimulates a member reading another resident's scope and checks the viewer's context", async () => {
    const leaked = await check("GC-15", { leakResidentScope: true });
    expect(leaked.passed).toBe(false);
    expect(leaked.detail).toContain("内部 scope");
    expect((await check("GC-15", { silentScopeRead: true })).passed).toBe(false);
  });

  it("fails if a newcomer without a history grant sees pre-join public messages", async () => {
    const result = await check("GC-15", { newResidentGetsHistory: true });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("入群前");
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

  it("reports absent production adapter as expected red lamps for every frozen check", () => {
    const results = runnerMissingDriverResults();
    expect(results.map(({ id }) => id)).toEqual(GROUP_CHAT_CHECK_IDS);
    expect(
      results.every(({ passed, detail }) => !passed && detail.includes("real-host driver missing")),
    ).toBe(true);
  });

  it("reports a provenance failure as red lamps naming the reason, never a baseline", () => {
    const reason = "real-host provenance check failed: host process 7 is not running";
    const results = provenanceFailedResults(reason);
    expect(results.map(({ id }) => id)).toEqual(GROUP_CHAT_CHECK_IDS);
    expect(
      results.every(
        ({ passed, stubbed, detail }) =>
          !passed &&
          !stubbed &&
          detail.includes(reason) &&
          !detail.includes("real-host driver missing"),
      ),
    ).toBe(true);
    expect(scoreGroupChatResults(results)).toEqual({
      trueGreen: 0,
      stubGreen: 0,
      strictPass: false,
    });
  });

  it("counts declared STUBBED methods as yellow lamps, never true green or strict pass", () => {
    const stubbedResults = groupChatChecks.map((item) => ({
      id: item.id,
      title: item.title,
      passed: true,
      stubbed: item.uses.includes("perform"),
      detail: "synthetic positive-control readback",
    }));
    expect(scoreGroupChatResults(stubbedResults)).toEqual({
      trueGreen: 0,
      stubGreen: groupChatChecks.length,
      strictPass: false,
    });

    const realResults = stubbedResults.map((result) => ({ ...result, stubbed: false }));
    expect(scoreGroupChatResults(realResults)).toEqual({
      trueGreen: groupChatChecks.length,
      stubGreen: 0,
      strictPass: true,
    });
  });
});

describe("#193 PR1 GC-11: idempotency, conflict and crash recovery", () => {
  it("passes: same-key replay reads back the original, content changes conflict, all three crash points recover cleanly", async () => {
    const result = await check("GC-11");
    expect(result.passed).toBe(true);
  });

  it("fails when a same-key retry with different content is silently accepted instead of conflicting", async () => {
    const result = await check("GC-11", { gc11AcceptConflictingContent: true });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("未报冲突");
  });

  it("fails when the host commits despite the crash being armed before the room commit (false success)", async () => {
    const result = await check("GC-11", { gc11FalseSuccessBeforeCommit: true });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("假成功");
  });

  it("fails when the host loses an already-committed event after the post-commit, pre-ack crash", async () => {
    const result = await check("GC-11", { gc11LoseCommitAfterCrash: true });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("丢失了已提交事件");
  });

  it("fails when recovery blindly resends instead of checking the ledger first", async () => {
    const result = await check("GC-11", { gc11BlindResendOnRestart: true });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("盲重发");
  });

  it("fails every crash-point branch when the post-crash relaunch cannot be verified", async () => {
    const result = await runGroupChatCheck(
      "GC-11",
      new SyntheticGroupChatHost(),
      failingRelaunchJudge,
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("换掉");
  });

  it("throws if GC-11 is run without the crash-recovery relaunch helper", async () => {
    await expect(runGroupChatCheck("GC-11", new SyntheticGroupChatHost())).rejects.toThrow(
      /relaunchAfterCrash/,
    );
  });
});

describe("#193 PR1 GC-13: plugin bridge lifecycle and resource failure", () => {
  it("passes: no reachable entry while not ready, revoke stops delivery/completion, quarantine trace, no leaks, others unaffected", async () => {
    const result = await check("GC-13");
    expect(result.passed).toBe(true);
  });

  it("fails when a not-ready bridge state still reports a reachable or invoked entry", async () => {
    const result = await check("GC-13", { gc13AlwaysReachable: true });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("可达入口");
  });

  it("fails when a queued message still gets delivered after the agent/entry is revoked", async () => {
    const result = await check("GC-13", { gc13DeliverAfterRevoke: true });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("排队消息仍被投递");
  });

  it("fails when an in-flight call still completes as success after revocation", async () => {
    const result = await check("GC-13", { gc13CompleteAfterRevoke: true });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("在途调用仍被当成功完成");
  });

  it("fails when a resource failure leaves no quarantine trace", async () => {
    const result = await check("GC-13", { gc13NoQuarantineTrace: true });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("quarantined");
  });

  it("fails when plugin-failure handling bypasses to a fallback canary that leaks", async () => {
    const result = await check("GC-13", { gc13LeakFallbackCanary: true });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("旁路");
  });

  it("fails when one resident's plugin fault also blocks another resident's post", async () => {
    const result = await check("GC-13", { gc13OtherResidentBlocked: true });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("拖住了其他住户");
  });

  it("fails when a plugin fault blocks the human control plane's post", async () => {
    const result = await check("GC-13", { gc13HumanBlocked: true });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("控制面");
  });
});

describe("#193 PR1 GC-14: room/mainstream shared publish identity and crash-safe dual commit", () => {
  it("passes: shared publish identity, no full history copy, direct append rejected, half-committed crash stays pending without false success", async () => {
    const result = await check("GC-14");
    expect(result.passed).toBe(true);
  });

  it("fails when a direct append bypassing the bounded mainstream writer is accepted", async () => {
    const result = await check("GC-14", { gc14AcceptArbitraryAppend: true });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("直接 append");
  });

  it("fails when a half-committed crash still publishes success", async () => {
    const result = await check("GC-14", { gc14FalseSuccessOnCrash: true });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("主流却出现了这条条目");
  });

  it("fails when no pending-reconciliation record survives the crash", async () => {
    const result = await check("GC-14", { gc14NoReconciliationRecord: true });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("待协调");
  });

  it("fails when a still-reconciling half-committed op claims external delivery", async () => {
    const result = await check("GC-14", { gc14ClaimsExternalDelivery: true });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("外部送达");
  });

  it("fails when another resident's room post leaks into this resident's mainstream (a second personality)", async () => {
    const result = await check("GC-14", { gc14OtherResidentLeaksIntoMainstream: true });
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("分身");
  });

  it("fails when the post-crash relaunch cannot be verified as a genuine process replacement", async () => {
    const result = await runGroupChatCheck(
      "GC-14",
      new SyntheticGroupChatHost(),
      failingRelaunchJudge,
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("换掉");
  });

  it("throws if GC-14 is run without the crash-recovery relaunch helper", async () => {
    await expect(runGroupChatCheck("GC-14", new SyntheticGroupChatHost())).rejects.toThrow(
      /relaunchAfterCrash/,
    );
  });
});

describe("#191 runner: real-host provenance and static source scan", () => {
  const head = "0123456789abcdef0123456789abcdef01234567";
  const judgePid = 4242;
  const node = "/opt/test-node/bin/node";
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const entry = join("src", "installer", "cli.ts");
  const hostProcess = (overrides: Partial<HostProcessInfo> = {}): HostProcessInfo => ({
    alive: true,
    ancestors: [judgePid, 1],
    executable: node,
    args: [node, "--import", "tsx", entry],
    ...overrides,
  });
  const facts = (info: HostProcessInfo | null): HostProvenanceFacts => ({
    headCommit: head,
    judgePid,
    judgeExecutable: node,
    repoRoot,
    readProcess: () => info,
  });

  it("rejects the synthetic host's self-report even though it is typed mist-host", async () => {
    const run = await new SyntheticGroupChatHost().startHost();
    expect(hostProvenanceProblem(run, facts(null))).toMatch(/not running/);
    expect(hostProvenanceProblem(run, facts(hostProcess({ ancestors: [1] })))).toMatch(
      /not started by this judge run/,
    );
    expect(hostProvenanceProblem(run, facts(hostProcess()))).toMatch(/not a commit id/);
  });

  it("accepts a live child of the judge running its node on a src/ entry at HEAD", () => {
    const child = facts(hostProcess());
    expect(hostProvenanceProblem({ pid: 5000, commit: head }, child)).toBeNull();
    expect(hostProvenanceProblem({ pid: 5000, commit: head.slice(0, 12) }, child)).toBeNull();
    expect(hostProvenanceProblem({ pid: 5000, commit: "fedcba9876" }, child)).toMatch(
      /not the checked-out HEAD/,
    );
    expect(hostProvenanceProblem({ pid: 5000, commit: "012345" }, child)).toMatch(
      /not a commit id/,
    );
    expect(hostProvenanceProblem({ pid: 0, commit: head }, child)).toMatch(/valid process id/);
  });

  // The #202 second review passed provenance with borrowed live pids and the current HEAD.
  it.each([
    [
      "the judge's own pid",
      judgePid,
      hostProcess({ ancestors: [1] }),
      /not started by this judge run/,
    ],
    ["pid 1", 1, hostProcess({ ancestors: [] }), /not started by this judge run/],
    [
      "a stray sleep",
      7000,
      hostProcess({
        ancestors: [6999, 1],
        executable: "/usr/bin/sleep",
        args: ["sleep", "600"],
      }),
      /not started by this judge run/,
    ],
    [
      "a sleep child",
      7001,
      hostProcess({ executable: "/usr/bin/sleep", args: ["sleep", "600"] }),
      /not this judge's node/,
    ],
    [
      "an idle node -e child",
      7002,
      hostProcess({ args: [node, "-e", "setInterval(() => {}, 1e9)"] }),
      /no entry file/,
    ],
    [
      "a node child running only the judge",
      7003,
      hostProcess({ args: [node, "acceptance/group-chat-run.ts"] }),
      /no entry file/,
    ],
    ["a zombie child", 7004, hostProcess({ alive: false }), /not running/],
  ] as const)("rejects %s even with the current HEAD", (_label, pid, info, reason) => {
    expect(hostProvenanceProblem({ pid, commit: head }, facts(info))).toMatch(reason);
  });

  it("counts only an existing non-test source file under src/ as the host entry", () => {
    expect(isRepoEntryFile(entry, repoRoot)).toBe(true);
    expect(isRepoEntryFile(join(repoRoot, entry), repoRoot)).toBe(true);
    expect(isRepoEntryFile("acceptance/group-chat-run.ts", repoRoot)).toBe(false);
    expect(isRepoEntryFile("src/not-a-real-entry.ts", repoRoot)).toBe(false);
    expect(isRepoEntryFile("src/installer", repoRoot)).toBe(false);
    expect(isRepoEntryFile("--import=tsx", repoRoot)).toBe(false);
    expect(isRepoEntryFile("../outside/src/host.ts", repoRoot)).toBe(false);
  });

  it("finds an entry path containing spaces in a space-joined `ps` command line", async () => {
    const root = await mkdtemp(join(tmpdir(), "gc-provenance-"));
    try {
      await mkdir(join(root, "src", "host dir"), { recursive: true });
      await writeFile(join(root, "src", "host dir", "main.ts"), "export {};\n");
      const words = [node, "--import", "tsx", join(root, "src", "host"), "dir/main.ts"];
      const withRoot = (info: HostProcessInfo): HostProvenanceFacts => ({
        ...facts(info),
        repoRoot: root,
      });
      const run = { pid: 5000, commit: head };
      expect(
        hostProvenanceProblem(run, withRoot(hostProcess({ args: words, argvSplitOnSpaces: true }))),
      ).toBeNull();
      // Exact argv is taken as given: the same words as separate arguments name no entry.
      expect(hostProvenanceProblem(run, withRoot(hostProcess({ args: words })))).toMatch(
        /no entry file/,
      );
      expect(
        hostProvenanceProblem(
          run,
          withRoot(
            hostProcess({
              args: [node, join(root, "src", "host"), "dir/other.ts"],
              argvSplitOnSpaces: true,
            }),
          ),
        ),
      ).toMatch(/no entry file/);
      expect(
        hostProvenanceProblem(
          run,
          withRoot(hostProcess({ executable: null, args: words, argvSplitOnSpaces: true })),
        ),
      ).toMatch(/unreadable binary/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires the host process gone and readbacks refused after stopHost()", async () => {
    const refusing = {
      readRoomEvents: async (): Promise<readonly RoomEvent[]> => {
        throw new Error("host stopped");
      },
    };
    const answering = { readRoomEvents: async (): Promise<readonly RoomEvent[]> => [] };
    expect(await hostStopProblem(refusing, 5000, () => null)).toBeNull();
    expect(await hostStopProblem(refusing, 5000, () => hostProcess({ alive: false }))).toBeNull();
    expect(await hostStopProblem(refusing, 5000, () => hostProcess())).toMatch(/still running/);
    expect(await hostStopProblem(answering, 5000, () => null)).toMatch(/still answered/);
  });

  it.skipIf(process.platform === "win32")(
    "reads a real child's liveness, parents, binary and argv, and forgets it after exit",
    async () => {
      const child = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)", "arg with  spaces"],
        { stdio: "ignore" },
      );
      const pid = child.pid ?? -1;
      try {
        const vias = process.platform === "linux" ? (["proc", "ps"] as const) : (["ps"] as const);
        for (const via of vias) {
          const info = readProcessInfo(pid, via);
          expect(info?.alive, via).toBe(true);
          expect(info?.ancestors, via).toContain(process.pid);
          expect(info?.args?.[1], via).toBe("-e");
        }
        // `ps` only has the space-joined line; its words rejoin to the original argument.
        const viaPs = readProcessInfo(pid, "ps");
        expect(viaPs?.argvSplitOnSpaces).toBe(true);
        expect(viaPs?.args?.join(" ")).toMatch(/ arg with {2}spaces$/u);
        if (process.platform === "linux") {
          const viaProc = readProcessInfo(pid, "proc");
          expect(viaProc?.executable).toBe(realpathSync(process.execPath));
          expect(viaProc?.args?.at(-1)).toBe("arg with  spaces");
          expect(viaProc?.argvSplitOnSpaces).toBeUndefined();
          // procps reports comm as a bare name: unreadable, never matched by name.
          expect(viaPs?.executable).toBeNull();
        }
      } finally {
        const exited = new Promise((done) => child.once("exit", done));
        child.kill();
        await exited;
      }
      expect(readProcessInfo(pid)).toBeNull();
    },
  );

  it.todo(
    "writes a durable challenge straight into the host's room ledger and reads it back through the adapter (needs the #191 adapter's data-root contract)",
  );

  describe("restartedHostProblem (#193 GC-11/GC-14 crash-recovery relaunch)", () => {
    const previous = { pid: 5000, commit: head };
    const factsWith = (info: Record<number, HostProcessInfo | null>): HostProvenanceFacts => ({
      headCommit: head,
      judgePid,
      judgeExecutable: node,
      repoRoot,
      readProcess: (pid) => (pid in info ? (info[pid] ?? null) : null),
    });

    it("accepts a relaunch where the old pid is confirmed dead and the new one passes ordinary provenance", () => {
      const relaunched = { pid: 5001, commit: head };
      const goodFacts = factsWith({ [previous.pid]: null, [relaunched.pid]: hostProcess() });
      expect(restartedHostProblem(previous, relaunched, goodFacts)).toBeNull();
    });

    it("also accepts when the old pid still exists but as a dead/zombie entry", () => {
      const relaunched = { pid: 5001, commit: head };
      const goodFacts = factsWith({
        [previous.pid]: hostProcess({ alive: false }),
        [relaunched.pid]: hostProcess(),
      });
      expect(restartedHostProblem(previous, relaunched, goodFacts)).toBeNull();
    });

    it("rejects a relaunch when the crash-during-* command did not actually kill the old process", () => {
      const relaunched = { pid: 5001, commit: head };
      const badFacts = factsWith({
        [previous.pid]: hostProcess(),
        [relaunched.pid]: hostProcess(),
      });
      expect(restartedHostProblem(previous, relaunched, badFacts)).toMatch(/still alive/);
    });

    it("rejects a relaunch that reports the same pid as the process that just died", () => {
      const sameFacts = factsWith({ [previous.pid]: null });
      expect(restartedHostProblem(previous, previous, sameFacts)).toMatch(
        /not a genuine process replacement/,
      );
    });

    it("still runs the ordinary provenance facts on the relaunched process", () => {
      const relaunched = { pid: 5001, commit: "not-a-commit" };
      const mixedFacts = factsWith({ [previous.pid]: null, [relaunched.pid]: hostProcess() });
      expect(restartedHostProblem(previous, relaunched, mixedFacts)).toMatch(/not a commit id/);
    });
  });

  it("finds member-id literals only in non-test source files", async () => {
    const root = await mkdtemp(join(tmpdir(), "gc04-scan-"));
    try {
      await mkdir(join(root, "group-chat"), { recursive: true });
      await mkdir(join(root, "tests"), { recursive: true });
      await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
      const literal = `if (target === "${fixture.residentIds.b}") route();\n`;
      await writeFile(join(root, "group-chat", "router.ts"), literal);
      await writeFile(join(root, "group-chat", "router.test.ts"), literal);
      await writeFile(join(root, "tests", "fixture.ts"), literal);
      await writeFile(join(root, "node_modules", "pkg", "index.ts"), literal);
      await writeFile(join(root, "group-chat", "roster.ts"), "export const members = load();\n");
      expect(await findSourceLiterals(root, [fixture.residentIds.b])).toEqual([
        join("group-chat", "router.ts"),
      ]);
      expect(await findSourceLiterals(join(root, "missing"), [fixture.residentIds.b])).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
