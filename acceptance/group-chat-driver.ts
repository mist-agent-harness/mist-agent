/**
 * Host adapter contract for #191/#193 group-chat acceptance. The judge issues
 * concrete operations and independently reads host-owned ledgers/projections;
 * an adapter never returns a pre-composed pass/fail evidence card.
 *
 * GC-11/GC-13/GC-14 (#193 unit C, PR1) add crash-recovery and plugin-failure commands and
 * readbacks below. GC-11/GC-14 involve real process death: `crash-during-*` commands resolve
 * (or the adapter catches whatever the crash does to the in-flight call) only once the host
 * process has actually exited, mirroring `interruptMigration()` in
 * `acceptance/window-history-driver.ts` ("返回时宿主已经死了"). The judge then calls
 * `startHost()` again to relaunch a fresh process against the same durable store — rebuilding
 * an in-memory object instead is not an acceptable adapter per
 * `acceptance/group-chat.md`「判卷方式」.
 */
export const GROUP_CHAT_CHECK_IDS = [
  "GC-01",
  "GC-02",
  "GC-03",
  "GC-04",
  "GC-05",
  "GC-09",
  "GC-11",
  "GC-13",
  "GC-14",
  "GC-15",
] as const;

export type GroupChatCheckId = (typeof GROUP_CHAT_CHECK_IDS)[number];
export type ResidentId =
  | "test-resident:a"
  | "test-resident:b"
  | "test-resident:c"
  | "test-resident:novel-d"
  | "test-resident:novel-e";
export type DeliveryState = "loaded" | "queued" | "not-targeted";
export type RosterPath = "broadcast" | "mention" | "projection" | "feedback" | "status";

/** GC-11: canonical outcome the host keeps per idempotency key, read back by that key. */
export type PublishStatus = "committed" | "conflict" | "pending" | "rejected";
export interface PublishOutcome {
  readonly operationKey: string;
  readonly status: PublishStatus;
  readonly eventId: string | null;
  readonly reason: string | null;
}
/**
 * One entry per external side-effect attempt (an outbound call able to cause a real effect on
 * the other end, not a passive reconciliation read) the host actually made for an operation key.
 */
export interface ExternalCallAttempt {
  readonly operationKey: string;
  readonly attemptSeq: number;
}
/**
 * Where in a publish pipeline the host must have already died by the time the judge's
 * crash-during-publish command settles. "GC-11 判卷方式" 原句：涉及崩溃恢复的场景必须换宿主
 * 进程，只重建内存对象不算。
 */
export type GroupChatCrashPoint =
  | "before-room-commit"
  | "after-room-commit-before-ack"
  | "external-result-unknown";

/** GC-13: the four "not ready" bridge states plus the one state where the entry is callable. */
export type PluginBridgeState =
  | "inactive"
  | "missing-service"
  | "version-mismatch"
  | "insufficient-permission"
  | "active";
export interface PluginEntryAttempt {
  readonly residentId: ResidentId;
  readonly marker: string;
  readonly state: PluginBridgeState;
  /** Whether a callable entry point existed at all for this attempt. */
  readonly reachable: boolean;
  /** Whether the plugin was actually invoked (must be false whenever reachable is false). */
  readonly invoked: boolean;
}
export interface QuarantineRecord {
  readonly residentId: ResidentId;
  readonly reason: string;
}
export interface PendingPluginItem {
  readonly residentId: ResidentId;
  readonly marker: string;
  readonly kind: "queued-message" | "in-flight-call";
  /** Whether this item was delivered/completed after the agent/entry was revoked. */
  readonly delivered: boolean;
  /** Whether an in-flight call's effect got reported as a success after revocation. */
  readonly completedAsSuccess: boolean;
}

/** GC-14: one resident-owned entry in its canonical individual mainstream. */
export interface MainstreamEntry {
  readonly residentId: ResidentId;
  readonly operationKey: string | null;
  readonly roomEventId: string | null;
  readonly authorId: string;
  readonly body: string;
  /**
   * Self-reported by the driver: whether this entry's receipt claims the content reached an
   * external channel. GC-14 requires this stay false for a half-committed crash-recovery op —
   * "stream delivered 不冒充外部送达".
   */
  readonly claimsExternalDelivery: boolean;
}
export interface DualCommitStatus {
  readonly operationKey: string;
  readonly roomCommitted: boolean;
  readonly mainstreamCommitted: boolean;
  readonly publishedAsSuccess: boolean;
  readonly reconciliationPending: boolean;
  /**
   * Whether the pending-reconciliation status itself claims the content reached an external
   * channel — independent of whether a mainstream entry exists at all. GC-14 requires this stay
   * false while mainstreamCommitted is false: "stream delivered 不冒充外部送达".
   */
  readonly claimsExternalDelivery: boolean;
}

export const groupChatSyntheticFixture = Object.freeze({
  roomId: "test-room:gc-191",
  hiddenRoomId: "test-room:gc-191-hidden",
  humanId: "test-human:owner",
  residentIds: Object.freeze({
    a: "test-resident:a",
    b: "test-resident:b",
    c: "test-resident:c",
    newcomer: "test-resident:novel-d",
    /** GC-04 second world: a different newcomer, so a branch keyed on one id cannot pass. */
    newcomerAlt: "test-resident:novel-e",
  }),
  canaries: Object.freeze({
    privateA: "TEST-PRIVATE-CANARY:a",
    privateB: "TEST-PRIVATE-CANARY:b",
    privateC: "TEST-PRIVATE-CANARY:c",
    draft: "TEST-PRIVATE-CANARY:draft",
    tool: "TEST-PRIVATE-CANARY:tool",
  }),
});

/**
 * What startHost() reports about the host it launched. The runner checks it against facts it
 * reads itself: the pid must be a live descendant of the judge process running this judge's
 * node binary with an entry file from this checkout, and commit must be the checked-out HEAD.
 */
export interface GroupChatHostRun {
  readonly pid: number;
  readonly commit: string;
}

export type GroupChatCommand =
  | {
      readonly kind: "post";
      readonly roomId: string;
      readonly principalId: string;
      readonly claimedAuthorId?: string;
      readonly body: string;
      readonly visibility?: "public";
      readonly binding?: string;
      readonly privateFields?: readonly string[];
    }
  | {
      readonly kind: "save-memory";
      readonly residentId: ResidentId;
      readonly sourceEventId: string;
    }
  | {
      readonly kind: "seed-resident-private";
      readonly residentId: ResidentId;
      readonly canary: string;
    }
  | {
      readonly kind: "set-delivery-state";
      readonly eventMarker: string;
      readonly residentId: ResidentId;
      readonly state: DeliveryState;
    }
  | { readonly kind: "register-resident"; readonly residentId: ResidentId }
  | {
      readonly kind: "exercise-roster-path";
      readonly path: RosterPath;
      readonly residentId: ResidentId;
    }
  | {
      readonly kind: "plain-text-mention";
      /** Judge-issued id; the host keeps exactly one routing decision per operation. */
      readonly operationId: string;
      readonly roomId: string;
      readonly body: string;
    }
  | {
      readonly kind: "structured-mention";
      readonly operationId: string;
      readonly roomId: string;
      readonly targetId: string;
      readonly body: string;
    }
  | { readonly kind: "set-turn-gate"; readonly stopped: boolean; readonly turnOpen: boolean }
  | {
      readonly kind: "record-event";
      readonly roomId: string;
      readonly authorId: string;
      readonly body: string;
    }
  | { readonly kind: "dispatch-event"; readonly eventMarker: string }
  | { readonly kind: "commit-context"; readonly residentId: ResidentId; readonly marker: string }
  | { readonly kind: "react"; readonly residentId: ResidentId; readonly eventMarker: string }
  | {
      readonly kind: "create-room";
      readonly roomId: string;
      readonly visibility: "public" | "hidden";
      readonly body: string;
    }
  | {
      readonly kind: "replay-public-payload";
      readonly sourceRoomId: string;
      readonly targetRoomId: string;
      readonly eventMarker: string;
    }
  | { readonly kind: "attempt-room-read"; readonly roomId: string; readonly viewerId: string }
  | {
      /** A room member tries to read another resident's internal scope through the room. */
      readonly kind: "attempt-resident-scope-read";
      readonly roomId: string;
      readonly viewerId: ResidentId;
      readonly ownerId: ResidentId;
    }
  | { readonly kind: "set-resident"; readonly residentId: ResidentId }
  // —— GC-11: idempotency, conflict and crash recovery ——
  | {
      readonly kind: "publish-idempotent";
      readonly operationKey: string;
      readonly roomId: string;
      readonly principalId: ResidentId;
      readonly body: string;
      readonly mentions?: readonly string[];
      readonly rootEventMarker?: string | null;
    }
  | {
      /**
       * By contract, resolves only once the host process has died at `crashPoint` while
       * executing this publish; the judge relaunches via `startHost()` afterwards.
       */
      readonly kind: "crash-during-publish";
      readonly operationKey: string;
      readonly roomId: string;
      readonly principalId: ResidentId;
      readonly body: string;
      readonly crashPoint: GroupChatCrashPoint;
    }
  // —— GC-13: plugin bridge lifecycle and resource failure ——
  | {
      readonly kind: "seed-plugin-bridge";
      readonly residentId: ResidentId;
      readonly state: PluginBridgeState;
    }
  | {
      readonly kind: "attempt-plugin-entry";
      readonly residentId: ResidentId;
      readonly marker: string;
    }
  | {
      readonly kind: "queue-plugin-message";
      readonly residentId: ResidentId;
      readonly marker: string;
    }
  | {
      readonly kind: "start-in-flight-plugin-call";
      readonly residentId: ResidentId;
      readonly marker: string;
    }
  | { readonly kind: "revoke-plugin-agent"; readonly residentId: ResidentId }
  | {
      readonly kind: "seed-fallback-canary";
      readonly residentId: ResidentId;
      readonly canary: string;
    }
  // —— GC-14: dual-account (room ledger / resident canonical mainstream) publish ——
  | {
      readonly kind: "publish-dual-account";
      readonly operationKey: string;
      readonly roomId: string;
      readonly residentId: ResidentId;
      readonly body: string;
    }
  | {
      readonly kind: "crash-during-dual-commit";
      readonly operationKey: string;
      readonly roomId: string;
      readonly residentId: ResidentId;
      readonly body: string;
      readonly crashPoint: "between-room-and-mainstream-commit";
    }
  | {
      /**
       * A direct/unbounded append attempt against a resident's mainstream, bypassing the
       * existing unique writer's bounded publish entry. Must be rejected.
       */
      readonly kind: "attempt-arbitrary-mainstream-append";
      readonly residentId: ResidentId;
      readonly body: string;
    };

export interface RoomEvent {
  readonly id: string;
  readonly roomId: string;
  /** Unique, increasing position in this room's ledger, assigned by the host on record. */
  readonly position: number;
  readonly authorId: string;
  readonly body: string;
  readonly visibility: "public" | "hidden";
}
export interface DeliveryRecord {
  readonly residentId: ResidentId;
  readonly state: DeliveryState;
}
export interface MemoryRecord {
  readonly residentId: ResidentId;
  readonly sourceEventId: string | null;
  readonly body: string;
}
export interface RosterSnapshot {
  readonly version: number;
  readonly residentIds: readonly ResidentId[];
}
export interface RosterProjection {
  readonly residentIds: readonly ResidentId[];
  readonly humanIds: readonly string[];
}
/** The host's routing decision for one judge operation, with a stable reason code. */
export interface MentionDecision {
  readonly operationId: string;
  readonly outcome: "accepted" | "rejected" | "held";
  readonly reason: string;
  readonly targetId: string | null;
  /** Receipts this decision produced in the host-owned call ledger. */
  readonly callReceiptIds: readonly string[];
}
/** One entry per resident call the host actually made. */
export interface CallReceipt {
  readonly id: string;
  readonly targetId: string;
}
export interface SystemReceipt {
  readonly actor: "system" | ResidentId;
  readonly phase: string;
  readonly claim?: string;
  readonly contextCommitRef?: string;
}
export interface ContextCommit {
  readonly id: string;
  readonly residentId: ResidentId;
  readonly marker: string;
}
export interface SurfaceSnapshot {
  readonly body: string;
  /** Ledger event ids this viewer's projection of the room includes. */
  readonly visibleEventIds: readonly string[];
  readonly candidates: readonly string[];
  readonly count: number;
  readonly errorCode: string | null;
  readonly receipt: string | null;
}
export interface AccessAudit {
  readonly crossResidentPrivateReads: number;
  readonly unauthorizedReadResults: readonly string[];
}
export interface ResidentReaction {
  readonly residentId: string;
  readonly eventMarker: string;
}

/** One GC-04 world: add a single newcomer, then read every roster-driven path back. */
export interface GroupChatRosterWorldEvidence {
  readonly newResidentId: ResidentId;
  readonly rosterVersionBefore: number;
  readonly rosterVersionAfter: number;
  readonly rosterResidentIdsBefore: readonly ResidentId[];
  readonly rosterResidentIdsAfter: readonly ResidentId[];
  readonly residentIdsByPath: Readonly<Record<RosterPath, readonly ResidentId[]>>;
  readonly humanRenderedAsResident: boolean;
}

/** What the judge requires of the routing decision for one GC-05 operation. */
export type GroupChatMentionExpectation = "text-only" | "route" | "reject" | "gate-closed";
export interface GroupChatMentionOperation {
  readonly operationId: string;
  readonly expect: GroupChatMentionExpectation;
}

/** GC-15, one world: what a newcomer without a history grant sees around its join. */
export interface GroupChatNewcomerHistoryEvidence {
  /** Room positions of the judge's own posts, in the order the judge made them. */
  readonly judgePostPositions: readonly (number | null)[];
  readonly positionsUnique: boolean;
  /** Public room events at or below the high-water mark read just before the join. */
  readonly preJoinEventIds: readonly string[];
  /** Public room events above the high-water mark read just after the join. */
  readonly postJoinEventIds: readonly string[];
  readonly roomPublicEventIds: readonly string[];
  readonly visibleEventIds: readonly string[];
  /** Judge-seeded pre-join bodies that still appear anywhere on the newcomer's surface. */
  readonly preJoinTextOnSurface: readonly string[];
}

/** Judge-derived observations assembled from the readback APIs below. */
export interface GroupChatEvidenceById {
  "GC-01": {
    legitimateHuman: { accepted: boolean; authorId: string };
    legitimate: { accepted: boolean; authorId: string };
    forgedEnvelopeAccepted: boolean;
    forgedBodyAccepted: boolean;
    forgedBodyAuthorId: string | null;
    unexpectedAuthors: readonly string[];
    recordedAuthorIds: readonly string[];
  };
  "GC-02": {
    publicPayloadAccepted: boolean;
    missingVisibilityAccepted: boolean;
    missingRoomAccepted: boolean;
    missingBindingAccepted: boolean;
    extraPrivateFieldsAccepted: boolean;
    senderPrivateCanariesMissing: readonly string[];
    leakedCanaries: readonly string[];
  };
  "GC-03": {
    roomEventIdsBeforeSave: readonly string[];
    roomEventIdsAfterSave: readonly string[];
    deliveryByResident: Readonly<Partial<Record<ResidentId, DeliveryState | "missing">>>;
    deliveryRowsRead: number;
    memoryWritesByResident: Readonly<Partial<Record<ResidentId, number>>>;
    privateCanariesMissingFromOwners: readonly string[];
    privateCanariesVisibleToOtherResidents: readonly string[];
    judgeSeededEventId: string | null;
    savedSourceEventId: string | null;
  };
  "GC-04": {
    worlds: readonly GroupChatRosterWorldEvidence[];
    /** Repo-relative non-test files under src/ that spell out a roster/fixture member id. */
    sourceFilesWithRosterIdLiterals: readonly string[];
  };
  "GC-05": {
    operations: readonly GroupChatMentionOperation[];
    /** Every decision read back; only those for the judge's operations are judged. */
    decisions: readonly MentionDecision[];
    /** Call-ledger entries that appeared during this scenario (read after minus read before). */
    newCallReceipts: readonly CallReceipt[];
    /** Ids of entries present before the scenario that vanished or changed afterwards. */
    rewrittenCallReceiptIds: readonly string[];
    structuredTargetId: ResidentId;
  };
  "GC-09": {
    receipts: readonly SystemReceipt[];
    prematureReceiptPhases: readonly string[];
    judgeSeededContextCommitId: string | null;
    /** Reactions on the judge event read back before the resident's own react command. */
    reactionAuthorsBeforeResidentReacted: readonly string[];
    reactionAuthorsAfterResidentReacted: readonly string[];
    memoryRecordsAddedByContextCommit: number;
  };
  "GC-15": {
    authorizedPublicSurface: string;
    hiddenWorldSeedsPresent: boolean;
    unauthorizedSurfaceLeaks: readonly string[];
    crossResidentPrivateReads: number;
    scopeReadSeedPresent: boolean;
    crossResidentScopeLeaks: readonly string[];
    scopeReadDenied: boolean;
    newResidentHistory: readonly GroupChatNewcomerHistoryEvidence[];
    crossRoomReplayAccepted: boolean;
  };
  "GC-11": {
    sameKeyRetry: {
      readonly firstOutcome: PublishOutcome | null;
      readonly secondOutcome: PublishOutcome | null;
      readonly roomEventCount: number;
      readonly deliveryRowCountBeforeReplay: number;
      readonly deliveryRowCountAfterReplay: number;
    };
    contentConflicts: readonly {
      readonly variant: string;
      readonly outcome: PublishOutcome | null;
      /** True if the changed content actually landed anywhere in the room ledger. */
      readonly leaked: boolean;
    }[];
    beforeCommitCrash: {
      readonly hostRestarted: boolean;
      readonly eventExists: boolean;
      readonly outcomeAfterRestart: PublishOutcome | null;
    };
    afterCommitCrash: {
      readonly hostRestarted: boolean;
      readonly eventExists: boolean;
      readonly outcomeAfterRestart: PublishOutcome | null;
      readonly deliveryRowCount: number;
    };
    unknownExternalCrash: {
      readonly hostRestarted: boolean;
      readonly outcomeAfterRestart: PublishOutcome | null;
      /**
       * Side-effect-causing external attempts on record right after the restart, before the
       * judge does anything else. The crash-during-publish scenario makes exactly one such
       * attempt before dying, so this must stay 1 — more means the recovery path blindly
       * resent instead of checking the ledger first.
       */
      readonly attemptCountAfterRestart: number;
    };
  };
  "GC-13": {
    notReadyAttempts: readonly PluginEntryAttempt[];
    pendingBeforeRevoke: readonly PendingPluginItem[];
    pendingAfterRevoke: readonly PendingPluginItem[];
    quarantineRecords: readonly QuarantineRecord[];
    fallbackCanaryLeaked: boolean;
    preexistingRoomEventSurvived: boolean;
    otherResidentStillPosts: boolean;
    humanStillPosts: boolean;
  };
  "GC-14": {
    normalPublish: {
      readonly roomEventId: string | null;
      readonly roomAuthorId: string | null;
      readonly mainstreamEntry: MainstreamEntry | null;
      /** Another resident's post must never appear in this resident's mainstream. */
      readonly otherResidentLeakedIntoMainstream: boolean;
    };
    arbitraryAppendRejected: boolean;
    crashedCommit: {
      readonly hostRestarted: boolean;
      readonly status: DualCommitStatus | null;
      readonly roomEventExists: boolean;
      readonly mainstreamEntryExists: boolean;
      readonly claimsExternalDelivery: boolean;
    };
  };
}

/**
 * Methods are intentionally commands plus independent readbacks, not a
 * driver-authored evidence object. All fixtures are synthetic and judge-owned.
 */
export interface GroupChatHostDriver {
  readonly kind: "mist-host";
  /** Launch the host as a child process of this judge run (see GroupChatHostRun). */
  startHost(): Promise<GroupChatHostRun>;
  /** Resolve only after the host process has exited; every readback must reject afterwards. */
  stopHost(): Promise<void>;
  resetScenario(id: GroupChatCheckId, fixture: typeof groupChatSyntheticFixture): Promise<void>;
  perform(command: GroupChatCommand): Promise<void>;
  /** Omitted roomId means all records in the synthetic test namespace. */
  readRoomEvents(roomId?: string): Promise<readonly RoomEvent[]>;
  readDeliveries(eventId: string): Promise<readonly DeliveryRecord[]>;
  readMemories(): Promise<readonly MemoryRecord[]>;
  readResidentContext(residentId: ResidentId): Promise<string>;
  readRoster(): Promise<RosterSnapshot>;
  readRosterPath(path: RosterPath): Promise<RosterProjection>;
  readMentionDecisions(): Promise<readonly MentionDecision[]>;
  readCallLedger(): Promise<readonly CallReceipt[]>;
  readSystemReceipts(): Promise<readonly SystemReceipt[]>;
  readContextCommits(): Promise<readonly ContextCommit[]>;
  readSurface(roomId: string, viewerId: string): Promise<SurfaceSnapshot>;
  readAccessAudit(): Promise<AccessAudit>;
  readReactions(): Promise<readonly ResidentReaction[]>;
  // —— GC-11 ——
  /** Omitted key means every operation key the synthetic scenario has touched. */
  readPublishOutcomes(operationKey?: string): Promise<readonly PublishOutcome[]>;
  readExternalCallAttempts(operationKey?: string): Promise<readonly ExternalCallAttempt[]>;
  // —— GC-13 ——
  readPluginEntryAttempts(): Promise<readonly PluginEntryAttempt[]>;
  readQuarantineLog(): Promise<readonly QuarantineRecord[]>;
  readPendingPluginItems(residentId?: ResidentId): Promise<readonly PendingPluginItem[]>;
  // —— GC-14 ——
  readMainstream(residentId: ResidentId): Promise<readonly MainstreamEntry[]>;
  readDualCommitStatus(operationKey?: string): Promise<readonly DualCommitStatus[]>;
}

/** Clone both arguments and return values at the adapter boundary (#196/#200 pattern). */
export function cloneGroupChatDriverBoundary(driver: GroupChatHostDriver): GroupChatHostDriver {
  return new Proxy(driver, {
    get(target, property) {
      const member = Reflect.get(target, property, target);
      if (typeof member !== "function") return member;
      return async (...args: unknown[]) => {
        const result = await Reflect.apply(member, target, structuredClone(args));
        return structuredClone(result);
      };
    },
  });
}
