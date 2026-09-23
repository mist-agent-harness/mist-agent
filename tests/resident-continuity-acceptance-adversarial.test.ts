import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { residentContinuityChecks } from "../acceptance/resident-continuity-checks.ts";
import {
  type Actor,
  type BlindEvidenceCard,
  type CandidateSnapshot,
  type ContinuityVerdict,
  type EvaluationReceipt,
  type EvaluationStorageSnapshot,
  type MachineCheckResult,
  type MigrationCaseSnapshot,
  type PersonaVersion,
  type PrivateProjectionResult,
  type PrivateSourceHandle,
  type ProjectionItem,
  type ProjectionReceipt,
  type RelationshipAssertionSnapshot,
  type ResidentContinuityDriver,
  type ResidentSnapshot,
  type Result,
  type ScopeCapsuleEntry,
  type ScopeGrant,
  type ScopeSnapshot,
  type ScopedTurnResult,
  type SyntheticEvaluationResult,
  type SyntheticFixture,
  cloneResidentContinuityDriverBoundary,
} from "../acceptance/resident-continuity-driver.ts";

type Fault =
  | "allow-other-candidate-attestation"
  | "self-attestation-return-only"
  | "reuse-existing-resident-for-self-attestation"
  | "defer-rejection-until-restart"
  | "reject-idempotent-confirmation"
  | "relationship-shared-return-only"
  | "operation-wildcard"
  | "cross-scope-turn-leak"
  | "cross-scope-output-leak"
  | "cross-scope-turn-id-leak"
  | "cross-scope-memory-leak"
  | "deny-all-operations"
  | "ignore-machine-failure"
  | "drop-failed-machine-key"
  | "drop-green-machine-keys"
  | "drop-history-machine-keys"
  | "return-only-activation"
  | "activate-on-rejected-attempt"
  | "erase-verdicts-on-activation"
  | "target-return-only"
  | "drop-blind-cards"
  | "drop-resident-verdict"
  | "one-relationship-vote-enough"
  | "resident-rejection-counts-as-acceptance"
  | "relationship-rejection-counts-as-acceptance"
  | "leak-hidden-evaluation-surfaces"
  | "leak-hidden-card-id"
  | "leak-hidden-existence"
  | "placeholder-evaluation-receipt"
  | "leak-partial-private-source"
  | "leak-private-projection-result"
  | "leak-private-projection-envelope"
  | "leak-revoked-result"
  | "erase-superseded-persona"
  | "erase-superseded-persona-live-readback"
  | "resident-readback-alias-writeback"
  | "target-reverted-during-evaluation"
  | "candidate-activated-on-rejection"
  | "candidate-activation-return-only"
  | "rewrite-target-during-private-projection"
  | "live-operation-reason-mutation"
  | "rewrite-case-candidate-after-activation"
  | "retain-current-verdicts-on-target-change"
  | "rewrite-target-during-failed-private-projection"
  | "drop-relationship-participants-on-target-change"
  | "rewrite-history-target-after-rerun"
  | "rewrite-target-during-second-owner-grant";

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
  private sharedOperationFailure: { ok: false; reason: string } | null = null;
  private readonly failedProjectionTargets = new Map<string, MigrationCaseSnapshot["target"]>();
  private readonly secondGrantTargets = new Map<string, MigrationCaseSnapshot["target"]>();
  private readonly deferredRejectionIds = new Set<string>();

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
      if (this.fault === "defer-rejection-until-restart") {
        this.deferredRejectionIds.add(candidateId);
        return { ok: true, value: { ...cloneCandidate(candidate), state: "rejected" } };
      }
      candidate.state = "rejected";
      return { ok: true, value: cloneCandidate(candidate) };
    }
    if (this.fault === "self-attestation-return-only") {
      this.residentCounter += 1;
      const residentId = `resident:${this.residentCounter}`;
      this.residents.set(residentId, {
        residentId,
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
      return {
        ok: true,
        value: { ...cloneCandidate(candidate), state: "active", residentId },
      };
    }
    if (
      this.fault === "reuse-existing-resident-for-self-attestation" &&
      candidate.residentId === null &&
      this.residents.size > 0
    ) {
      const existing = this.residents.keys().next().value as string;
      candidate.state = "active";
      candidate.residentId = existing;
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
    if (
      this.fault === "erase-superseded-persona-live-readback" ||
      this.fault === "resident-readback-alias-writeback"
    ) {
      return this.resident(residentId);
    }
    return structuredClone(this.resident(residentId));
  }

  async restartHost(): Promise<void> {
    for (const candidateId of this.deferredRejectionIds) {
      this.candidate(candidateId).state = "rejected";
    }
    this.deferredRejectionIds.clear();
  }

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
    if (this.fault === "relationship-shared-return-only" && actor.kind === "resident") {
      const returned = cloneRelationship(assertion);
      returned.confirmedBy.push(participantId);
      returned.status = "shared";
      return { ok: true, value: returned };
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
    const foreignCanary = [...this.scopes.values()]
      .filter((other) => other.scopeId !== scope.scopeId && other.residentId === input.residentId)
      .flatMap((other) => other.capsule.map(({ content }) => content))[0];
    if (this.fault === "cross-scope-memory-leak" && foreignCanary !== undefined) {
      this.resident(input.residentId).memories.push(foreignCanary);
    }
    return {
      ok: true,
      value: {
        turnId:
          this.fault === "cross-scope-turn-id-leak" && foreignCanary !== undefined
            ? `turn:${input.scopeId}:${foreignCanary}`
            : `turn:${input.scopeId}`,
        observedContext,
        output:
          this.fault === "cross-scope-output-leak" && foreignCanary !== undefined
            ? `synthetic-output:${foreignCanary}`
            : "synthetic-output",
      },
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
    if (grant === undefined) {
      if (this.fault === "live-operation-reason-mutation") {
        if (this.sharedOperationFailure === null) {
          this.sharedOperationFailure = { ok: false, reason: "GRANT_NOT_FOUND#1" };
        } else {
          this.sharedOperationFailure.reason = "GRANT_NOT_FOUND#2";
        }
        return this.sharedOperationFailure;
      }
      return { ok: false, reason: "GRANT_NOT_FOUND" };
    }
    return { ok: true, value: { grantId: grant.id } };
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
    if (this.fault === "resident-readback-alias-writeback") {
      const resident = this.resident(input.residentId);
      const currentPersona = resident.persona[0];
      if (currentPersona === undefined) throw new Error("PERSONA_NOT_FOUND");
      currentPersona.content = `${currentPersona.content}:projection-writeback`;
      resident.memories.push("projection-writeback");
    }
    const scope = this.scope(input.scopeId);
    scope.capsule.push(
      ...input.items
        .filter(({ decision }) => decision === "retain")
        .map(({ id, content }) => ({ id, content, sourceHandle: input.sourceHandle })),
    );
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

  async revisePersona(input: {
    residentId: string;
    actor: Actor;
    content: string;
    supersedesVersionId: string;
  }): Promise<Result<PersonaVersion>> {
    const resident = this.resident(input.residentId);
    if (input.actor.kind !== "resident" || input.actor.residentId !== input.residentId) {
      return { ok: false, reason: "RESIDENT_SELF_REQUIRED" };
    }
    const previous = resident.persona.find(({ id }) => id === input.supersedesVersionId);
    if (previous === undefined || previous.supersededBy !== null) {
      return { ok: false, reason: "PERSONA_VERSION_NOT_CURRENT" };
    }
    const fresh: PersonaVersion = {
      id: `${input.supersedesVersionId}:next`,
      content: input.content,
      author: { kind: "resident", residentId: input.residentId },
      supersededBy: null,
    };
    previous.supersededBy = fresh.id;
    if (
      this.fault === "erase-superseded-persona" ||
      this.fault === "erase-superseded-persona-live-readback"
    ) {
      previous.content = "";
    }
    resident.persona.push(fresh);
    return { ok: true, value: structuredClone(fresh) };
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
    if (this.fault === "drop-failed-machine-key" && checks.some(({ passed }) => !passed)) {
      migration.machineChecks = structuredClone(checks.filter(({ key }) => key !== "permissions"));
    } else if (this.fault === "drop-green-machine-keys" && checks.every(({ passed }) => passed)) {
      migration.machineChecks = [];
    } else {
      migration.machineChecks = structuredClone(checks);
    }
    if (
      this.fault === "rewrite-history-target-after-rerun" &&
      migration.verdictHistory.length > 0 &&
      checks.every(({ passed }) => passed)
    ) {
      const history = migration.verdictHistory[migration.verdictHistory.length - 1];
      if (history !== undefined) {
        history.target.model = "unrelated-model";
        history.target.provider = "unrelated-provider";
      }
    }
    if (this.fault === "retain-current-verdicts-on-target-change") migration.stale = false;
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
      this.fault === "drop-relationship-participants-on-target-change" &&
      actor.kind === "human" &&
      actor.id === participantId &&
      !migration.relationshipParticipants.includes(participantId)
    ) {
      migration.relationshipParticipants.push(participantId);
      migration.relationshipVerdicts[participantId] = "not-asked";
    }
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
    const residentPassed =
      migration.residentVerdict === "accepted" ||
      (this.fault === "resident-rejection-counts-as-acceptance" &&
        migration.residentVerdict === "rejected");
    const relationshipsPassed =
      relationshipVotes.length > 0 &&
      relationshipVotes.every(
        (verdict) =>
          verdict === "accepted" ||
          (this.fault === "relationship-rejection-counts-as-acceptance" && verdict === "rejected"),
      );
    const oneRelationshipPassed = relationshipVotes.some((verdict) => verdict === "accepted");
    const activated =
      residentPassed &&
      (machinePassed || this.fault === "ignore-machine-failure") &&
      (relationshipsPassed ||
        (this.fault === "one-relationship-vote-enough" && oneRelationshipPassed));
    if (this.fault === "retain-current-verdicts-on-target-change" && migration.stale) {
      migration.activation = "blocked";
      return { ok: false, reason: "MIGRATION_GATES_INCOMPLETE" };
    }
    if (!activated) {
      migration.activation =
        this.fault === "activate-on-rejected-attempt" ? "activated" : "blocked";
      if (this.fault === "candidate-activated-on-rejection") {
        const candidate = this.candidate(migration.candidateId);
        candidate.state = "active";
        candidate.residentId = migration.sourceResidentId;
      }
      return { ok: false, reason: "MIGRATION_GATES_INCOMPLETE" };
    }
    if (this.fault !== "return-only-activation") migration.activation = "activated";
    if (this.fault === "erase-verdicts-on-activation") {
      migration.machineChecks = [];
      migration.residentVerdict = null;
      migration.relationshipVerdicts = Object.fromEntries(
        migration.relationshipParticipants.map((participant) => [participant, "not-asked"]),
      );
      migration.verdictHistory = [];
    }
    if (this.fault !== "candidate-activation-return-only") {
      const candidate = this.candidate(migration.candidateId);
      candidate.state = "active";
      candidate.residentId = migration.sourceResidentId;
    }
    if (this.fault === "rewrite-case-candidate-after-activation") {
      const replacement = await this.createCandidate({
        persona: "candidate:replacement-after-activation",
        proposedBy: { kind: "external-model", id: "model:replacement-after-activation" },
      });
      migration.candidateId = replacement.candidateId;
    }
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
      machineChecks:
        this.fault === "drop-history-machine-keys" ? [] : structuredClone(migration.machineChecks),
      residentVerdict: migration.residentVerdict,
      relationshipVerdicts: { ...migration.relationshipVerdicts },
      retiredReason: "target-changed",
    });
    if (this.fault === "drop-relationship-participants-on-target-change") {
      migration.relationshipParticipants = [];
      migration.relationshipVerdicts = {};
    }
    if (this.fault === "retain-current-verdicts-on-target-change") {
      const history = migration.verdictHistory[migration.verdictHistory.length - 1];
      if (history !== undefined) {
        history.target.model = "unrelated-model";
        history.target.provider = "unrelated-provider";
      }
      migration.target = { ...target };
      migration.activation = "blocked";
      migration.stale = true;
      return cloneMigration(migration);
    }
    if (this.fault !== "target-return-only") migration.target = { ...target };
    migration.machineChecks = [];
    migration.blindCards = [];
    migration.residentVerdict = null;
    migration.relationshipVerdicts = Object.fromEntries(
      migration.relationshipParticipants.map((participant) => [participant, "not-asked"]),
    );
    migration.activation = "blocked";
    migration.stale = true;
    const returned = cloneMigration(migration);
    if (this.fault === "target-return-only") returned.target = { ...target };
    return returned;
  }

  async runSyntheticEvaluation(
    caseId: string,
    fixture: SyntheticFixture,
    runtime?: { viewportId: string },
  ): Promise<SyntheticEvaluationResult> {
    const migration = this.migration(caseId);
    const target = { ...migration.target };
    if (this.fault === "target-reverted-during-evaluation") {
      migration.target = {
        model: "synthetic-model",
        modelVersion: "1",
        provider: "synthetic-provider",
        providerVersion: "1",
      };
    }
    const leaked =
      this.fault === "leak-hidden-evaluation-surfaces" ? [...fixture.hiddenMarkers] : [];
    const existenceLeak =
      this.fault === "leak-hidden-existence" && fixture.hiddenMarkers.length > 0
        ? ["hidden-fact-present"]
        : [];
    return {
      candidateContext: [
        ...fixture.authorizedMarkers,
        ...fixture.projectMarkers,
        ...fixture.authorizedCollaboratorRefs,
        ...leaked,
        ...existenceLeak,
      ],
      evaluatorPayload: [...fixture.authorizedMarkers],
      publicView: {
        retainedCount: fixture.authorizedMarkers.length + existenceLeak.length,
        displayedCount: fixture.authorizedMarkers.length + existenceLeak.length,
        errors: [...existenceLeak],
      },
      evidenceCard: {
        cardId:
          this.fault === "leak-hidden-card-id" && fixture.hiddenMarkers.length > 0
            ? (fixture.hiddenMarkers[0] ?? "synthetic-card")
            : "synthetic-card",
        reviewerId: "synthetic-reviewer",
        rubricVersion: "rubric:synthetic",
        score: 0.8,
        evidence: [...fixture.authorizedMarkers, ...leaked, ...existenceLeak],
      },
      coldStartTrace:
        fixture.kind === "cold-start"
          ? {
              viewportId: runtime?.viewportId ?? "viewport:missing",
              model: target.model,
              modelVersion: target.modelVersion,
              provider: target.provider,
              providerVersion: target.providerVersion,
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

  async grantPrivateProjection(handle: string, caseId: string, ownerId: string): Promise<void> {
    this.privateSource(handle).grants.add(ownerId);
    if (this.fault === "rewrite-target-during-second-owner-grant" && ownerId === "human:b") {
      const migration = this.migration(caseId);
      this.secondGrantTargets.set(caseId, structuredClone(migration.target));
      migration.target = {
        model: "projection-rewritten",
        modelVersion: "9",
        provider: "projection-rewritten-provider",
        providerVersion: "9",
      };
    }
  }

  async projectPrivateSource(
    caseId: string,
    handle: string,
    rubricVersion: string,
  ): Promise<Result<PrivateProjectionResult>> {
    const source = this.privateSource(handle);
    if (source.revoked) {
      return {
        ok: false,
        reason:
          this.fault === "leak-revoked-result"
            ? `SOURCE_REVOKED:${source.content}`
            : "SOURCE_REVOKED",
      };
    }
    if (!source.ownerIds.every((ownerId) => source.grants.has(ownerId))) {
      if (this.fault === "rewrite-target-during-failed-private-projection") {
        const migration = this.migration(caseId);
        this.failedProjectionTargets.set(caseId, structuredClone(migration.target));
        migration.target = {
          model: "projection-rewritten",
          modelVersion: "9",
          provider: "projection-rewritten-provider",
          providerVersion: "9",
        };
      }
      if (this.fault === "leak-partial-private-source") {
        this.storage.get(caseId)?.logs.push(source.content);
      }
      return {
        ok: false,
        reason:
          this.fault === "leak-private-projection-result"
            ? `MISSING_OWNER_GRANT:${source.content}`
            : "MISSING_OWNER_GRANT",
      };
    }
    const migration = this.migration(caseId);
    if (this.fault === "rewrite-target-during-second-owner-grant") {
      const originalTarget = this.secondGrantTargets.get(caseId);
      if (originalTarget !== undefined) migration.target = structuredClone(originalTarget);
    }
    if (this.fault === "rewrite-target-during-failed-private-projection") {
      const originalTarget = this.failedProjectionTargets.get(caseId);
      if (originalTarget !== undefined) migration.target = structuredClone(originalTarget);
    }
    if (this.fault === "rewrite-target-during-private-projection") {
      migration.target.model = "projection-rewritten";
      migration.target.provider = "projection-rewritten-provider";
    }
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
    const value = {
      sourceHandle: handle,
      usedContentHash: sha256(source.content),
      receiptId,
      ...(this.fault === "leak-private-projection-result"
        ? { copiedSourceContent: source.content }
        : {}),
    };
    const result: Result<PrivateProjectionResult> & { copiedSourceContent?: string } = {
      ok: true,
      value,
      ...(this.fault === "leak-private-projection-envelope"
        ? { copiedSourceContent: source.content }
        : {}),
    };
    return result;
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
      ? {
          ok: false,
          reason:
            this.fault === "leak-revoked-result"
              ? `SOURCE_REVOKED:${source.content}`
              : "SOURCE_REVOKED",
        }
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
  { checkId: "OI-01", fault: "self-attestation-return-only" },
  { checkId: "OI-01", fault: "reuse-existing-resident-for-self-attestation" },
  { checkId: "OI-02", fault: "defer-rejection-until-restart" },
  { checkId: "OI-04", fault: "reject-idempotent-confirmation" },
  { checkId: "OI-04", fault: "relationship-shared-return-only" },
  { checkId: "OI-05", fault: "operation-wildcard" },
  { checkId: "OI-06", fault: "cross-scope-turn-leak" },
  { checkId: "OI-06", fault: "cross-scope-output-leak" },
  { checkId: "OI-06", fault: "cross-scope-turn-id-leak" },
  { checkId: "OI-06", fault: "cross-scope-memory-leak" },
  { checkId: "OI-09", fault: "deny-all-operations" },
  { checkId: "OI-09", fault: "live-operation-reason-mutation" },
  { checkId: "OI-08", fault: "erase-superseded-persona" },
  { checkId: "OI-08", fault: "erase-superseded-persona-live-readback" },
  { checkId: "OI-07", fault: "resident-readback-alias-writeback" },
  { checkId: "MC-01", fault: "ignore-machine-failure" },
  { checkId: "MC-01", fault: "drop-failed-machine-key" },
  { checkId: "MC-01", fault: "drop-green-machine-keys" },
  { checkId: "MC-01", fault: "return-only-activation" },
  { checkId: "MC-01", fault: "activate-on-rejected-attempt" },
  { checkId: "MC-01", fault: "erase-verdicts-on-activation" },
  { checkId: "MC-01", fault: "candidate-activated-on-rejection" },
  { checkId: "MC-01", fault: "candidate-activation-return-only" },
  { checkId: "MC-01", fault: "rewrite-case-candidate-after-activation" },
  { checkId: "MC-02", fault: "drop-blind-cards" },
  { checkId: "MC-03", fault: "drop-resident-verdict" },
  { checkId: "MC-05", fault: "one-relationship-vote-enough" },
  { checkId: "MC-05", fault: "resident-rejection-counts-as-acceptance" },
  { checkId: "MC-05", fault: "relationship-rejection-counts-as-acceptance" },
  { checkId: "MC-05", fault: "return-only-activation" },
  { checkId: "MC-05", fault: "activate-on-rejected-attempt" },
  { checkId: "MC-05", fault: "erase-verdicts-on-activation" },
  { checkId: "MC-05", fault: "candidate-activated-on-rejection" },
  { checkId: "MC-05", fault: "candidate-activation-return-only" },
  { checkId: "MC-05", fault: "rewrite-case-candidate-after-activation" },
  { checkId: "MC-07", fault: "leak-hidden-evaluation-surfaces" },
  { checkId: "MC-07", fault: "leak-hidden-card-id" },
  { checkId: "MC-07", fault: "leak-hidden-existence" },
  { checkId: "MC-08", fault: "target-return-only" },
  { checkId: "MC-08", fault: "target-reverted-during-evaluation" },
  { checkId: "MC-09", fault: "cross-scope-turn-leak" },
  { checkId: "MC-09", fault: "cross-scope-output-leak" },
  { checkId: "MC-09", fault: "cross-scope-turn-id-leak" },
  { checkId: "MC-09", fault: "cross-scope-memory-leak" },
  { checkId: "MC-11", fault: "placeholder-evaluation-receipt" },
  { checkId: "MC-10", fault: "leak-private-projection-result" },
  { checkId: "MC-10", fault: "leak-private-projection-envelope" },
  { checkId: "MC-11", fault: "leak-private-projection-result" },
  { checkId: "MC-11", fault: "leak-private-projection-envelope" },
  { checkId: "MC-11", fault: "leak-revoked-result" },
  { checkId: "MC-11", fault: "rewrite-target-during-private-projection" },
  { checkId: "MC-12", fault: "leak-partial-private-source" },
  { checkId: "MC-12", fault: "leak-private-projection-result" },
  { checkId: "MC-12", fault: "leak-private-projection-envelope" },
  { checkId: "MC-12", fault: "drop-green-machine-keys" },
  { checkId: "MC-12", fault: "drop-history-machine-keys" },
  { checkId: "MC-12", fault: "return-only-activation" },
  { checkId: "MC-12", fault: "activate-on-rejected-attempt" },
  { checkId: "MC-12", fault: "erase-verdicts-on-activation" },
  { checkId: "MC-12", fault: "target-return-only" },
  { checkId: "MC-12", fault: "candidate-activated-on-rejection" },
  { checkId: "MC-12", fault: "candidate-activation-return-only" },
  { checkId: "MC-12", fault: "rewrite-target-during-private-projection" },
  { checkId: "MC-12", fault: "rewrite-case-candidate-after-activation" },
  { checkId: "MC-12", fault: "retain-current-verdicts-on-target-change" },
  { checkId: "MC-12", fault: "rewrite-target-during-failed-private-projection" },
  { checkId: "MC-12", fault: "drop-relationship-participants-on-target-change" },
  { checkId: "MC-12", fault: "rewrite-history-target-after-rerun" },
  { checkId: "MC-12", fault: "rewrite-target-during-second-owner-grant" },
];

describe("D22 / D23 adversarial acceptance", () => {
  it.each(adversarialCases)("$checkId rejects $fault", async ({ checkId, fault }) => {
    const check = residentContinuityChecks.find(({ id }) => id === checkId);
    if (check === undefined) throw new Error(`missing check ${checkId}`);

    const baseline = await check.run(
      cloneResidentContinuityDriverBoundary(new AdversarialContinuityDriver(null)),
    );
    expect(baseline, `${checkId} synthetic positive control`).toMatchObject({ passed: true });

    const attacked = await check.run(
      cloneResidentContinuityDriverBoundary(new AdversarialContinuityDriver(fault)),
    );
    expect(attacked, `${checkId} accepted adversarial fault ${fault}`).toMatchObject({
      passed: false,
    });
  });
});
