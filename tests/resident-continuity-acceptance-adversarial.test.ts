import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { residentContinuityChecks } from "../acceptance/resident-continuity-checks.ts";
import type {
  Actor,
  BlindEvidenceCard,
  CandidateSnapshot,
  ContinuityVerdict,
  EvaluationReceipt,
  EvaluationStorageSnapshot,
  MachineCheckResult,
  MigrationCaseSnapshot,
  PersonaVersion,
  PrivateProjectionResult,
  PrivateSourceHandle,
  ProjectionItem,
  ProjectionReceipt,
  RelationshipAssertionSnapshot,
  ResidentContinuityDriver,
  ResidentSnapshot,
  Result,
  ScopeCapsuleEntry,
  ScopeGrant,
  ScopeSnapshot,
  ScopedTurnResult,
  SyntheticEvaluationResult,
  SyntheticFixture,
} from "../acceptance/resident-continuity-driver.ts";

type Fault =
  | "allow-other-candidate-attestation"
  | "reject-idempotent-confirmation"
  | "operation-wildcard"
  | "cross-scope-turn-leak"
  | "deny-all-operations"
  | "ignore-machine-failure"
  | "drop-blind-cards"
  | "drop-resident-verdict"
  | "one-relationship-vote-enough"
  | "leak-hidden-evaluation-surfaces"
  | "placeholder-evaluation-receipt"
  | "leak-partial-private-source";

interface PrivateRecord {
  handle: string;
  ownerIds: string[];
  content: string;
  grants: Set<string>;
  revoked: boolean;
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const cloneCandidate = (value: CandidateSnapshot): CandidateSnapshot => ({ ...value });
const cloneRelationship = (
  value: RelationshipAssertionSnapshot,
): RelationshipAssertionSnapshot => ({
  ...value,
  participantIds: [...value.participantIds],
  confirmedBy: [...value.confirmedBy],
});
const cloneScope = (value: ScopeSnapshot): ScopeSnapshot => structuredClone(value);
const cloneMigration = (value: MigrationCaseSnapshot): MigrationCaseSnapshot =>
  structuredClone(value);

function actorIdentity(actor: Actor): string | null {
  if (actor.kind === "human") return actor.id;
  if (actor.kind === "resident") return actor.residentId;
  if (actor.kind === "candidate") return actor.candidateId;
  return null;
}

class AdversarialContinuityDriver implements ResidentContinuityDriver {
  private candidateCounter = 0;
  private residentCounter = 0;
  private relationshipCounter = 0;
  private caseCounter = 0;
  private cardCounter = 0;
  private receiptCounter = 0;
  private readonly candidates = new Map<string, CandidateSnapshot>();
  private readonly residents = new Map<string, ResidentSnapshot>();
  private readonly relationships = new Map<string, RelationshipAssertionSnapshot>();
  private readonly scopes = new Map<string, ScopeSnapshot>();
  private readonly migrations = new Map<string, MigrationCaseSnapshot>();
  private readonly projections = new Map<string, ProjectionReceipt>();
  private readonly privateSources = new Map<string, PrivateRecord>();
  private readonly evaluationReceipts = new Map<string, EvaluationReceipt>();
  private readonly storage = new Map<string, EvaluationStorageSnapshot>();

  constructor(private readonly fault: Fault | null) {}

  async reset(): Promise<void> {}

  async createCandidate(input: { persona: string; proposedBy: Actor }): Promise<CandidateSnapshot> {
    this.candidateCounter += 1;
    const candidate: CandidateSnapshot = {
      candidateId: `candidate:${this.candidateCounter}`,
      state: "inactive",
      residentId: null,
      persona: input.persona,
      personaVersionId: `persona:${this.candidateCounter}:1`,
    };
    this.candidates.set(candidate.candidateId, candidate);
    return cloneCandidate(candidate);
  }

  async attestCandidate(
    candidateId: string,
    actor: Actor,
    decision: ContinuityVerdict,
  ): Promise<Result<CandidateSnapshot>> {
    const candidate = this.candidate(candidateId);
    const allowed =
      actor.kind === "candidate" &&
      (actor.candidateId === candidateId || this.fault === "allow-other-candidate-attestation");
    if (!allowed) return { ok: false, reason: "ACTOR_NOT_CANDIDATE_SELF" };
    if (decision === "rejected") {
      candidate.state = "rejected";
      return { ok: true, value: cloneCandidate(candidate) };
    }
    candidate.state = "active";
    if (candidate.residentId === null) {
      this.residentCounter += 1;
      candidate.residentId = `resident:${this.residentCounter}`;
      this.residents.set(candidate.residentId, {
        residentId: candidate.residentId,
        active: true,
        persona: [
          {
            id: candidate.personaVersionId,
            content: candidate.persona,
            author: { kind: "candidate", candidateId },
            supersededBy: null,
          },
        ],
        memories: [],
        scopeIds: [],
        grantIds: [],
      });
    }
    return { ok: true, value: cloneCandidate(candidate) };
  }

  async readCandidate(candidateId: string): Promise<CandidateSnapshot> {
    return cloneCandidate(this.candidate(candidateId));
  }

  async readResident(residentId: string): Promise<ResidentSnapshot> {
    return structuredClone(this.resident(residentId));
  }

  async restartHost(): Promise<void> {}

  async openViewport(_residentId: string, _scopeId: string | null): Promise<string> {
    return "viewport:1";
  }

  async switchViewportScope(_viewportId: string, _scopeId: string | null): Promise<void> {}

  async recordRelationshipAssertion(input: {
    residentId: string;
    statement: string;
    participantIds: string[];
    actor: Actor;
  }): Promise<RelationshipAssertionSnapshot> {
    this.relationshipCounter += 1;
    const identity = actorIdentity(input.actor);
    const confirmedBy =
      identity !== null && input.participantIds.includes(identity) ? [identity] : [];
    const assertion: RelationshipAssertionSnapshot = {
      assertionId: `relationship:${this.relationshipCounter}`,
      statement: input.statement,
      participantIds: [...input.participantIds],
      confirmedBy,
      status: confirmedBy.length === input.participantIds.length ? "shared" : "one-sided",
    };
    this.relationships.set(assertion.assertionId, assertion);
    return cloneRelationship(assertion);
  }

  async confirmRelationshipAssertion(
    assertionId: string,
    actor: Actor,
    participantId: string,
  ): Promise<Result<RelationshipAssertionSnapshot>> {
    const assertion = this.relationship(assertionId);
    const identity = actorIdentity(actor);
    if (
      identity === null ||
      identity !== participantId ||
      !assertion.participantIds.includes(participantId)
    ) {
      return { ok: false, reason: "ACTOR_CANNOT_CONFIRM_SIDE" };
    }
    if (assertion.confirmedBy.includes(participantId)) {
      if (this.fault === "reject-idempotent-confirmation") {
        return { ok: false, reason: "DUPLICATE_CONFIRMATION" };
      }
      return { ok: true, value: cloneRelationship(assertion) };
    }
    assertion.confirmedBy.push(participantId);
    assertion.status =
      assertion.confirmedBy.length === assertion.participantIds.length ? "shared" : "one-sided";
    return { ok: true, value: cloneRelationship(assertion) };
  }

  async readRelationshipAssertion(assertionId: string): Promise<RelationshipAssertionSnapshot> {
    return cloneRelationship(this.relationship(assertionId));
  }

  async attachScope(input: {
    residentId: string;
    scopeId: string;
    capsule: ScopeCapsuleEntry[];
    grants: ScopeGrant[];
  }): Promise<ScopeSnapshot> {
    const scope: ScopeSnapshot = { ...structuredClone(input), attached: true };
    this.scopes.set(input.scopeId, scope);
    const resident = this.resident(input.residentId);
    if (!resident.scopeIds.includes(input.scopeId)) resident.scopeIds.push(input.scopeId);
    for (const grant of input.grants) {
      if (!resident.grantIds.includes(grant.id)) resident.grantIds.push(grant.id);
    }
    return cloneScope(scope);
  }

  async detachScope(residentId: string, scopeId: string): Promise<void> {
    const scope = this.scope(scopeId);
    scope.attached = false;
    const resident = this.resident(residentId);
    resident.scopeIds = resident.scopeIds.filter((id) => id !== scopeId);
    resident.grantIds = resident.grantIds.filter(
      (id) => !scope.grants.some((grant) => grant.id === id),
    );
  }

  async readScopeContext(_residentId: string, scopeId: string): Promise<Result<string[]>> {
    const scope = this.scopes.get(scopeId);
    if (scope === undefined || !scope.attached) return { ok: false, reason: "SCOPE_DETACHED" };
    return { ok: true, value: scope.capsule.map(({ content }) => content) };
  }

  async runScopedTurn(input: {
    residentId: string;
    scopeId: string;
    input: string;
  }): Promise<Result<ScopedTurnResult>> {
    const scope = this.scope(input.scopeId);
    const observedContext = scope.capsule.map(({ content }) => content);
    if (this.fault === "cross-scope-turn-leak") {
      for (const other of this.scopes.values()) {
        if (other.scopeId !== scope.scopeId && other.residentId === input.residentId) {
          observedContext.push(...other.capsule.map(({ content }) => content));
        }
      }
    }
    return {
      ok: true,
      value: { turnId: `turn:${input.scopeId}`, observedContext, output: "synthetic-output" },
    };
  }

  async tryOperation(input: {
    residentId: string;
    scopeId: string | null;
    kind: "tool" | "data" | "budget" | "channel";
    operation: string;
  }): Promise<Result<{ grantId: string }>> {
    if (this.fault === "deny-all-operations") return { ok: false, reason: "DENY_ALL" };
    if (input.scopeId === null) return { ok: false, reason: "SCOPE_REQUIRED" };
    const scope = this.scopes.get(input.scopeId);
    if (scope === undefined || !scope.attached) return { ok: false, reason: "SCOPE_NOT_FOUND" };
    const grant = scope.grants.find(
      (candidate) =>
        candidate.kind === input.kind &&
        (candidate.operation === input.operation || this.fault === "operation-wildcard"),
    );
    return grant === undefined
      ? { ok: false, reason: "GRANT_NOT_FOUND" }
      : { ok: true, value: { grantId: grant.id } };
  }

  async introduceEvidenceGap(input: {
    residentId: string;
    scopeId: string;
    target: "identity" | "authority" | "grant";
  }): Promise<void> {
    if (input.target === "grant") this.scope(input.scopeId).grants = [];
  }

  async project(input: {
    residentId: string;
    scopeId: string;
    sourceHandle: string;
    policyVersion: string;
    items: ProjectionItem[];
  }): Promise<ProjectionReceipt> {
    this.receiptCounter += 1;
    const receipt: ProjectionReceipt = {
      receiptId: `projection:${this.receiptCounter}`,
      residentId: input.residentId,
      scopeId: input.scopeId,
      sourceHandle: input.sourceHandle,
      policyVersion: input.policyVersion,
      decisions: input.items.map(({ id, decision }) => ({ itemId: id, decision })),
    };
    this.projections.set(receipt.receiptId, receipt);
    return structuredClone(receipt);
  }

  async readProjectionReceipt(receiptId: string): Promise<ProjectionReceipt> {
    const receipt = this.projections.get(receiptId);
    if (receipt === undefined) throw new Error("PROJECTION_NOT_FOUND");
    return structuredClone(receipt);
  }

  async revisePersona(_input: {
    residentId: string;
    actor: Actor;
    content: string;
    supersedesVersionId: string;
  }): Promise<Result<PersonaVersion>> {
    return { ok: false, reason: "NOT_USED_BY_ADVERSARIAL_CASES" };
  }

  async createMigrationCase(input: {
    sourceResidentId: string;
    candidateId: string;
    target: MigrationCaseSnapshot["target"];
    relationshipParticipants: string[];
  }): Promise<MigrationCaseSnapshot> {
    this.caseCounter += 1;
    const migration: MigrationCaseSnapshot = {
      caseId: `case:${this.caseCounter}`,
      sourceResidentId: input.sourceResidentId,
      candidateId: input.candidateId,
      target: { ...input.target },
      relationshipParticipants: [...input.relationshipParticipants],
      machineChecks: [],
      blindCards: [],
      residentVerdict: null,
      relationshipVerdicts: Object.fromEntries(
        input.relationshipParticipants.map((participant) => [participant, "not-asked"]),
      ),
      activation: "pending",
      stale: false,
      retainedCandidate: true,
      verdictHistory: [],
    };
    this.migrations.set(migration.caseId, migration);
    this.storage.set(migration.caseId, { durableRecord: {}, logs: [], publicOutput: {} });
    return cloneMigration(migration);
  }

  async recordMachineConformance(
    caseId: string,
    checks: MachineCheckResult[],
  ): Promise<MigrationCaseSnapshot> {
    const migration = this.migration(caseId);
    migration.machineChecks = structuredClone(checks);
    return cloneMigration(migration);
  }

  async submitBlindEvidence(
    caseId: string,
    card: Omit<BlindEvidenceCard, "cardId">,
  ): Promise<Result<BlindEvidenceCard>> {
    if (card.identityVerdict !== undefined)
      return { ok: false, reason: "IDENTITY_VERDICT_FORBIDDEN" };
    this.cardCounter += 1;
    const stored: BlindEvidenceCard = {
      cardId: `card:${this.cardCounter}`,
      ...structuredClone(card),
    };
    if (this.fault !== "drop-blind-cards") this.migration(caseId).blindCards.push(stored);
    return { ok: true, value: structuredClone(stored) };
  }

  async submitResidentContinuity(
    caseId: string,
    actor: Actor,
    verdict: ContinuityVerdict,
  ): Promise<Result<MigrationCaseSnapshot>> {
    const migration = this.migration(caseId);
    if (actor.kind !== "candidate" || actor.candidateId !== migration.candidateId) {
      return { ok: false, reason: "NOT_CANDIDATE_SELF" };
    }
    const returned = cloneMigration(migration);
    returned.residentVerdict = verdict;
    if (this.fault !== "drop-resident-verdict") migration.residentVerdict = verdict;
    return { ok: true, value: returned };
  }

  async submitRelationshipContinuity(
    caseId: string,
    participantId: string,
    actor: Actor,
    verdict: ContinuityVerdict,
  ): Promise<Result<MigrationCaseSnapshot>> {
    const migration = this.migration(caseId);
    if (
      actor.kind !== "human" ||
      actor.id !== participantId ||
      !migration.relationshipParticipants.includes(participantId)
    ) {
      return { ok: false, reason: "NOT_PARTICIPANT_SELF" };
    }
    migration.relationshipVerdicts[participantId] = verdict;
    return { ok: true, value: cloneMigration(migration) };
  }

  async activateMigration(caseId: string): Promise<Result<{ residentId: string }>> {
    const migration = this.migration(caseId);
    const machinePassed =
      migration.machineChecks.length === 6 && migration.machineChecks.every(({ passed }) => passed);
    const relationshipVotes = Object.values(migration.relationshipVerdicts);
    const relationshipsPassed =
      relationshipVotes.length > 0 && relationshipVotes.every((verdict) => verdict === "accepted");
    const oneRelationshipPassed = relationshipVotes.some((verdict) => verdict === "accepted");
    const activated =
      migration.residentVerdict === "accepted" &&
      (machinePassed || this.fault === "ignore-machine-failure") &&
      (relationshipsPassed ||
        (this.fault === "one-relationship-vote-enough" && oneRelationshipPassed));
    if (!activated) {
      migration.activation = "blocked";
      return { ok: false, reason: "MIGRATION_GATES_INCOMPLETE" };
    }
    migration.activation = "activated";
    migration.stale = false;
    return { ok: true, value: { residentId: migration.sourceResidentId } };
  }

  async readMigrationCase(caseId: string): Promise<MigrationCaseSnapshot> {
    return cloneMigration(this.migration(caseId));
  }

  async changeMigrationTarget(
    caseId: string,
    target: MigrationCaseSnapshot["target"],
  ): Promise<MigrationCaseSnapshot> {
    const migration = this.migration(caseId);
    migration.verdictHistory.push({
      target: { ...migration.target },
      machineChecks: structuredClone(migration.machineChecks),
      residentVerdict: migration.residentVerdict,
      relationshipVerdicts: { ...migration.relationshipVerdicts },
      retiredReason: "target-changed",
    });
    migration.target = { ...target };
    migration.machineChecks = [];
    migration.blindCards = [];
    migration.residentVerdict = null;
    migration.relationshipVerdicts = Object.fromEntries(
      migration.relationshipParticipants.map((participant) => [participant, "not-asked"]),
    );
    migration.activation = "blocked";
    migration.stale = true;
    return cloneMigration(migration);
  }

  async runSyntheticEvaluation(
    caseId: string,
    fixture: SyntheticFixture,
    runtime?: { viewportId: string },
  ): Promise<SyntheticEvaluationResult> {
    const migration = this.migration(caseId);
    const leaked =
      this.fault === "leak-hidden-evaluation-surfaces" ? [...fixture.hiddenMarkers] : [];
    return {
      candidateContext: [
        ...fixture.authorizedMarkers,
        ...fixture.projectMarkers,
        ...fixture.authorizedCollaboratorRefs,
        ...leaked,
      ],
      evaluatorPayload: [...fixture.authorizedMarkers],
      publicView: {
        retainedCount: fixture.authorizedMarkers.length,
        displayedCount: fixture.authorizedMarkers.length,
        errors: [],
      },
      evidenceCard: {
        cardId: "synthetic-card",
        reviewerId: "synthetic-reviewer",
        rubricVersion: "rubric:synthetic",
        score: 0.8,
        evidence: [...fixture.authorizedMarkers, ...leaked],
      },
      coldStartTrace:
        fixture.kind === "cold-start"
          ? {
              viewportId: runtime?.viewportId ?? "viewport:missing",
              model: migration.target.model,
              modelVersion: migration.target.modelVersion,
              provider: migration.target.provider,
              providerVersion: migration.target.providerVersion,
              recognizedCollaboratorRefs: [...fixture.authorizedCollaboratorRefs],
              requestedSelfIntroduction: false,
            }
          : null,
    };
  }

  async createPrivateSource(input: {
    ownerIds: string[];
    content: string;
  }): Promise<PrivateSourceHandle> {
    const handle = `private:${this.privateSources.size + 1}`;
    this.privateSources.set(handle, {
      handle,
      ownerIds: [...input.ownerIds],
      content: input.content,
      grants: new Set(),
      revoked: false,
    });
    return { handle, ownerIds: [...input.ownerIds] };
  }

  async grantPrivateProjection(handle: string, _caseId: string, ownerId: string): Promise<void> {
    this.privateSource(handle).grants.add(ownerId);
  }

  async projectPrivateSource(
    caseId: string,
    handle: string,
    rubricVersion: string,
  ): Promise<Result<PrivateProjectionResult>> {
    const source = this.privateSource(handle);
    if (source.revoked) return { ok: false, reason: "SOURCE_REVOKED" };
    if (!source.ownerIds.every((ownerId) => source.grants.has(ownerId))) {
      if (this.fault === "leak-partial-private-source") {
        this.storage.get(caseId)?.logs.push(source.content);
      }
      return { ok: false, reason: "MISSING_OWNER_GRANT" };
    }
    const migration = this.migration(caseId);
    this.receiptCounter += 1;
    const receiptId = `evaluation:${this.receiptCounter}`;
    const receipt: EvaluationReceipt =
      this.fault === "placeholder-evaluation-receipt"
        ? {
            receiptId,
            rubricVersion: "x",
            model: "x",
            modelVersion: "x",
            provider: "x",
            providerVersion: "x",
            verdicts: { resident: "rejected", relationships: {} },
            metrics: { machineChecks: 1, blindCards: 1, privateSources: 0 },
            sourceHandles: [handle],
          }
        : {
            receiptId,
            rubricVersion,
            model: migration.target.model,
            modelVersion: migration.target.modelVersion,
            provider: migration.target.provider,
            providerVersion: migration.target.providerVersion,
            verdicts: {
              resident: migration.residentVerdict ?? "rejected",
              relationships: { ...migration.relationshipVerdicts },
            },
            metrics: {
              machineChecks: migration.machineChecks.length,
              blindCards: migration.blindCards.length,
              privateSources: 1,
            },
            sourceHandles: [handle],
          };
    this.evaluationReceipts.set(receiptId, receipt);
    return {
      ok: true,
      value: { sourceHandle: handle, usedContentHash: sha256(source.content), receiptId },
    };
  }

  async inspectEvaluationStorage(caseId: string): Promise<EvaluationStorageSnapshot> {
    return structuredClone(
      this.storage.get(caseId) ?? { durableRecord: {}, logs: [], publicOutput: {} },
    );
  }

  async revokePrivateSource(handle: string): Promise<void> {
    this.privateSource(handle).revoked = true;
  }

  async readPrivateSource(handle: string): Promise<Result<string>> {
    const source = this.privateSource(handle);
    return source.revoked
      ? { ok: false, reason: "SOURCE_REVOKED" }
      : { ok: true, value: source.content };
  }

  async readEvaluationReceipt(receiptId: string): Promise<EvaluationReceipt> {
    const receipt = this.evaluationReceipts.get(receiptId);
    if (receipt === undefined) throw new Error("RECEIPT_NOT_FOUND");
    return structuredClone(receipt);
  }

  private candidate(candidateId: string): CandidateSnapshot {
    const candidate = this.candidates.get(candidateId);
    if (candidate === undefined) throw new Error("CANDIDATE_NOT_FOUND");
    return candidate;
  }

  private resident(residentId: string): ResidentSnapshot {
    const resident = this.residents.get(residentId);
    if (resident === undefined) throw new Error("RESIDENT_NOT_FOUND");
    return resident;
  }

  private relationship(assertionId: string): RelationshipAssertionSnapshot {
    const relationship = this.relationships.get(assertionId);
    if (relationship === undefined) throw new Error("RELATIONSHIP_NOT_FOUND");
    return relationship;
  }

  private scope(scopeId: string): ScopeSnapshot {
    const scope = this.scopes.get(scopeId);
    if (scope === undefined) throw new Error("SCOPE_NOT_FOUND");
    return scope;
  }

  private migration(caseId: string): MigrationCaseSnapshot {
    const migration = this.migrations.get(caseId);
    if (migration === undefined) throw new Error("MIGRATION_NOT_FOUND");
    return migration;
  }

  private privateSource(handle: string): PrivateRecord {
    const source = this.privateSources.get(handle);
    if (source === undefined) throw new Error("PRIVATE_SOURCE_NOT_FOUND");
    return source;
  }
}

const adversarialCases: Array<{ checkId: string; fault: Fault }> = [
  { checkId: "OI-01", fault: "allow-other-candidate-attestation" },
  { checkId: "OI-04", fault: "reject-idempotent-confirmation" },
  { checkId: "OI-05", fault: "operation-wildcard" },
  { checkId: "OI-06", fault: "cross-scope-turn-leak" },
  { checkId: "OI-09", fault: "deny-all-operations" },
  { checkId: "MC-01", fault: "ignore-machine-failure" },
  { checkId: "MC-02", fault: "drop-blind-cards" },
  { checkId: "MC-03", fault: "drop-resident-verdict" },
  { checkId: "MC-05", fault: "one-relationship-vote-enough" },
  { checkId: "MC-07", fault: "leak-hidden-evaluation-surfaces" },
  { checkId: "MC-09", fault: "cross-scope-turn-leak" },
  { checkId: "MC-11", fault: "placeholder-evaluation-receipt" },
  { checkId: "MC-12", fault: "leak-partial-private-source" },
];

describe("D22 / D23 adversarial acceptance", () => {
  it.each(adversarialCases)("$checkId rejects $fault", async ({ checkId, fault }) => {
    const check = residentContinuityChecks.find(({ id }) => id === checkId);
    if (check === undefined) throw new Error(`missing check ${checkId}`);

    const baseline = await check.run(new AdversarialContinuityDriver(null));
    expect(baseline, `${checkId} synthetic positive control`).toMatchObject({ passed: true });

    const attacked = await check.run(new AdversarialContinuityDriver(fault));
    expect(attacked, `${checkId} accepted adversarial fault ${fault}`).toMatchObject({
      passed: false,
    });
  });
});
