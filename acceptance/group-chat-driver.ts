/**
 * Host adapter contract for #191 group-chat acceptance. The judge issues
 * concrete operations and independently reads host-owned ledgers/projections;
 * an adapter never returns a pre-composed pass/fail evidence card.
 */
export const GROUP_CHAT_CHECK_IDS = [
  "GC-01",
  "GC-02",
  "GC-03",
  "GC-04",
  "GC-05",
  "GC-09",
  "GC-15",
] as const;

export type GroupChatCheckId = (typeof GROUP_CHAT_CHECK_IDS)[number];
export type ResidentId =
  | "test-resident:a"
  | "test-resident:b"
  | "test-resident:c"
  | "test-resident:novel-d";
export type DeliveryState = "loaded" | "queued" | "not-targeted";
export type RosterPath = "broadcast" | "mention" | "projection" | "feedback" | "status";

export const groupChatSyntheticFixture = Object.freeze({
  roomId: "test-room:gc-191",
  hiddenRoomId: "test-room:gc-191-hidden",
  humanId: "test-human:owner",
  residentIds: Object.freeze({
    a: "test-resident:a",
    b: "test-resident:b",
    c: "test-resident:c",
    newcomer: "test-resident:novel-d",
  }),
  canaries: Object.freeze({
    privateA: "TEST-PRIVATE-CANARY:a",
    privateB: "TEST-PRIVATE-CANARY:b",
    privateC: "TEST-PRIVATE-CANARY:c",
    draft: "TEST-PRIVATE-CANARY:draft",
    tool: "TEST-PRIVATE-CANARY:tool",
  }),
});

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
  | { readonly kind: "plain-text-mention"; readonly roomId: string; readonly body: string }
  | {
      readonly kind: "structured-mention";
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
  | { readonly kind: "set-resident"; readonly residentId: ResidentId };

export interface RoomEvent {
  readonly id: string;
  readonly roomId: string;
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
export interface RouteRecord {
  readonly marker: string;
  readonly calls: number;
  readonly targetId: string | null;
  readonly rejected: boolean;
  readonly gateBypassed: boolean;
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
    rosterVersionBefore: number;
    rosterVersionAfter: number;
    rosterResidentIdsBefore: readonly ResidentId[];
    rosterResidentIdsAfter: readonly ResidentId[];
    expectedNewResidentId: ResidentId;
    residentIdsByPath: Readonly<Record<RosterPath, readonly ResidentId[]>>;
    hardCodedResidentBranchFound: boolean;
    humanRenderedAsResident: boolean;
  };
  "GC-05": {
    callsFromTextOnlyMentions: number;
    structuredTargetId: ResidentId;
    routedResidentId: ResidentId | null;
    legitimateStructuredRouteAccepted: boolean;
    unknownTargetRejected: boolean;
    unauthorizedTargetRejected: boolean;
    turnOrStopGateBypassed: boolean;
  };
  "GC-09": {
    receipts: readonly {
      actor: "system" | ResidentId;
      phase: string;
      claim?: string;
      contextCommitRef?: string;
    }[];
    systemClaimedPersonalPresence: boolean;
    systemClaimedUnderstandingOrMemory: boolean;
    prematureReceiptPhases: readonly string[];
    judgeSeededContextCommitId: string | null;
    residentReactionAuthorId: string | null;
  };
  "GC-15": {
    authorizedPublicSurface: string;
    hiddenWorldSeedsPresent: boolean;
    unauthorizedSurfaceLeaks: readonly string[];
    crossResidentPrivateReads: number;
    newResidentReceivedHistoryByDefault: boolean;
    crossRoomReplayAccepted: boolean;
  };
}

/**
 * Methods are intentionally commands plus independent readbacks, not a
 * driver-authored evidence object. All fixtures are synthetic and judge-owned.
 */
export interface GroupChatHostDriver {
  readonly kind: "mist-host";
  startHost(): Promise<GroupChatHostRun>;
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
  readRoutes(): Promise<readonly RouteRecord[]>;
  readSystemReceipts(): Promise<readonly SystemReceipt[]>;
  readContextCommits(): Promise<readonly ContextCommit[]>;
  readSurface(roomId: string, viewerId: string): Promise<SurfaceSnapshot>;
  readAccessAudit(): Promise<AccessAudit>;
  readReactions(): Promise<readonly ResidentReaction[]>;
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
