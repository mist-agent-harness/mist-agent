/**
 * #182（D22 / D23）的验收驱动契约。
 *
 * 判卷只通过本接口观察宿主，不 import `src/` 实现。实现方在
 * `src/resident-continuity-acceptance-driver.ts` 导出
 * `createResidentContinuityDriver()`；驱动缺失时二十一盏灯全部保持红色。
 */

export type Result<T> = { ok: true; value: T } | { ok: false; reason: string };

export type CandidateState = "inactive" | "rejected" | "active";
export type ContinuityVerdict = "accepted" | "rejected";
export type RelationshipVerdict = ContinuityVerdict | "not-asked";
export type OperationKind = "tool" | "data" | "budget" | "channel";
export type ProjectionDecision = "retain" | "reduce" | "drop" | "hold";

export type Actor =
  | { kind: "candidate"; candidateId: string }
  | { kind: "resident"; residentId: string }
  | { kind: "human"; id: string }
  | { kind: "installer"; id: string }
  | { kind: "summarizer"; id: string }
  | { kind: "external-model"; id: string }
  | { kind: "reviewer"; id: string };

export interface CandidateSnapshot {
  candidateId: string;
  state: CandidateState;
  residentId: string | null;
  persona: string;
  personaVersionId: string;
}

export interface PersonaVersion {
  id: string;
  content: string;
  author: Actor;
  supersededBy: string | null;
}

export interface ResidentSnapshot {
  residentId: string;
  active: boolean;
  persona: PersonaVersion[];
  memories: string[];
  scopeIds: string[];
  grantIds: string[];
}

export interface RelationshipAssertionSnapshot {
  assertionId: string;
  statement: string;
  participantIds: string[];
  confirmedBy: string[];
  status: "one-sided" | "shared";
}

export interface ScopeGrant {
  id: string;
  kind: OperationKind;
  operation: string;
}

export interface ScopeCapsuleEntry {
  id: string;
  content: string;
  sourceHandle: string;
}

export interface ScopeSnapshot {
  scopeId: string;
  residentId: string;
  capsule: ScopeCapsuleEntry[];
  grants: ScopeGrant[];
  attached: boolean;
}

export interface ProjectionItem {
  id: string;
  content: string;
  decision: ProjectionDecision;
}

export interface ProjectionReceipt {
  receiptId: string;
  residentId: string;
  scopeId: string;
  sourceHandle: string;
  policyVersion: string;
  decisions: Array<{ itemId: string; decision: ProjectionDecision }>;
}

export type MachineCheckKey =
  | "permissions"
  | "visibility"
  | "commitments"
  | "revocation"
  | "provenance"
  | "receipts";

export interface MachineCheckResult {
  key: MachineCheckKey;
  passed: boolean;
  reason: string | null;
}

export interface BlindEvidenceCard {
  cardId: string;
  reviewerId: string;
  rubricVersion: string;
  score: number;
  evidence: string[];
  /** 必须永远不存在；字段只为负例输入留形状。 */
  identityVerdict?: ContinuityVerdict;
}

export interface MigrationCaseSnapshot {
  caseId: string;
  sourceResidentId: string;
  candidateId: string;
  target: { model: string; modelVersion: string; provider: string; providerVersion: string };
  relationshipParticipants: string[];
  machineChecks: MachineCheckResult[];
  blindCards: BlindEvidenceCard[];
  residentVerdict: ContinuityVerdict | null;
  relationshipVerdicts: Record<string, RelationshipVerdict>;
  activation: "pending" | "blocked" | "activated";
  stale: boolean;
  retainedCandidate: boolean;
}

export type SyntheticFixtureKind = "familiar-reader" | "stranger" | "cold-start" | "separation";

export interface SyntheticFixture {
  kind: SyntheticFixtureKind;
  authorizedMarkers: string[];
  hiddenMarkers: string[];
  projectMarkers: string[];
  authorizedCollaboratorRefs: string[];
  hiddenCollaboratorRefs: string[];
}

export interface SyntheticEvaluationResult {
  candidateContext: string[];
  evaluatorPayload: string[];
  publicView: {
    retainedCount: number;
    displayedCount: number;
    errors: string[];
  };
  evidenceCard: BlindEvidenceCard;
}

export interface PrivateSourceHandle {
  handle: string;
  ownerIds: string[];
}

export interface PrivateProjectionResult {
  sourceHandle: string;
  usedContentHash: string;
  receiptId: string;
}

export interface EvaluationStorageSnapshot {
  durableRecord: unknown;
  logs: string[];
  publicOutput: unknown;
}

export interface EvaluationReceipt {
  receiptId: string;
  rubricVersion: string;
  model: string;
  modelVersion: string;
  provider: string;
  providerVersion: string;
  verdicts: Record<string, string>;
  metrics: Record<string, number>;
  sourceHandles: string[];
}

export interface ResidentContinuityDriver {
  /** 每盏灯后清掉合成住户、scope、source 和收据。 */
  reset(): Promise<void>;

  // D22：candidate / resident / relationship / scope / projection
  createCandidate(input: { persona: string; proposedBy: Actor }): Promise<CandidateSnapshot>;
  attestCandidate(
    candidateId: string,
    actor: Actor,
    decision: ContinuityVerdict,
  ): Promise<Result<CandidateSnapshot>>;
  readCandidate(candidateId: string): Promise<CandidateSnapshot>;
  readResident(residentId: string): Promise<ResidentSnapshot>;
  restartHost(): Promise<void>;
  openViewport(residentId: string, scopeId: string | null): Promise<string>;
  switchViewportScope(viewportId: string, scopeId: string | null): Promise<void>;

  recordRelationshipAssertion(input: {
    residentId: string;
    statement: string;
    participantIds: string[];
    actor: Actor;
  }): Promise<RelationshipAssertionSnapshot>;
  confirmRelationshipAssertion(
    assertionId: string,
    actor: Actor,
  ): Promise<Result<RelationshipAssertionSnapshot>>;
  readRelationshipAssertion(assertionId: string): Promise<RelationshipAssertionSnapshot>;

  attachScope(input: {
    residentId: string;
    scopeId: string;
    capsule: ScopeCapsuleEntry[];
    grants: ScopeGrant[];
  }): Promise<ScopeSnapshot>;
  detachScope(residentId: string, scopeId: string): Promise<void>;
  readScopeContext(residentId: string, scopeId: string): Promise<Result<string[]>>;
  tryOperation(input: {
    residentId: string;
    scopeId: string | null;
    kind: OperationKind;
    operation: string;
  }): Promise<Result<{ grantId: string }>>;
  introduceEvidenceGap(input: {
    residentId: string;
    scopeId: string;
    target: "identity" | "authority" | "grant";
  }): Promise<void>;

  project(input: {
    residentId: string;
    scopeId: string;
    sourceHandle: string;
    policyVersion: string;
    items: ProjectionItem[];
  }): Promise<ProjectionReceipt>;
  readProjectionReceipt(receiptId: string): Promise<ProjectionReceipt>;
  revisePersona(input: {
    residentId: string;
    actor: Actor;
    content: string;
    supersedesVersionId: string;
  }): Promise<Result<PersonaVersion>>;

  // D23：迁移判词与合成评测
  createMigrationCase(input: {
    sourceResidentId: string;
    candidateId: string;
    target: MigrationCaseSnapshot["target"];
    relationshipParticipants: string[];
  }): Promise<MigrationCaseSnapshot>;
  recordMachineConformance(
    caseId: string,
    checks: MachineCheckResult[],
  ): Promise<MigrationCaseSnapshot>;
  submitBlindEvidence(
    caseId: string,
    card: Omit<BlindEvidenceCard, "cardId">,
  ): Promise<Result<BlindEvidenceCard>>;
  submitResidentContinuity(
    caseId: string,
    actor: Actor,
    verdict: ContinuityVerdict,
  ): Promise<Result<MigrationCaseSnapshot>>;
  submitRelationshipContinuity(
    caseId: string,
    participantId: string,
    actor: Actor,
    verdict: ContinuityVerdict,
  ): Promise<Result<MigrationCaseSnapshot>>;
  activateMigration(caseId: string): Promise<Result<{ residentId: string }>>;
  readMigrationCase(caseId: string): Promise<MigrationCaseSnapshot>;
  changeMigrationTarget(
    caseId: string,
    target: MigrationCaseSnapshot["target"],
  ): Promise<MigrationCaseSnapshot>;

  runSyntheticEvaluation(
    caseId: string,
    fixture: SyntheticFixture,
  ): Promise<SyntheticEvaluationResult>;

  // D23：真实私密样本的零复制投影语义（判卷只用合成 secret）
  createPrivateSource(input: {
    ownerIds: string[];
    content: string;
  }): Promise<PrivateSourceHandle>;
  grantPrivateProjection(handle: string, caseId: string, ownerId: string): Promise<void>;
  projectPrivateSource(caseId: string, handle: string): Promise<Result<PrivateProjectionResult>>;
  inspectEvaluationStorage(caseId: string): Promise<EvaluationStorageSnapshot>;
  revokePrivateSource(handle: string): Promise<void>;
  readPrivateSource(handle: string): Promise<Result<string>>;
  readEvaluationReceipt(receiptId: string): Promise<EvaluationReceipt>;
}

export interface ResidentContinuityCheckResult {
  passed: boolean;
  detail: string;
}

export interface ResidentContinuityCheck {
  id: string;
  title: string;
  uses: (keyof ResidentContinuityDriver)[];
  run(driver: ResidentContinuityDriver): Promise<ResidentContinuityCheckResult>;
}
