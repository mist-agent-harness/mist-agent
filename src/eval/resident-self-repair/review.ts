import { relative, sep } from "node:path";
import type {
  CaseId,
  EscalationDispositionRecord,
  PositiveControlReviewRecord,
  RaisedEscalationRecord,
  ReviewEscalationSource,
  ReviewGate,
  ReviewResolution,
  RunBundle,
  SemanticReviewRecord,
} from "./types.ts";

export interface BlindReviewPacket {
  rubric_version: string;
  case_id: CaseId;
  fixture_hash: string;
  final_report: string;
  human_projection: string;
  artifact_refs: string[];
}

export interface ReviewPair<T> {
  first: T;
  second: T;
  arbitration?: T;
}

export class ReviewPendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewPendingError";
  }
}

interface ReviewRoles {
  blindReviewerIds?: Set<string>;
}

function validateAcceptanceSeat(roles: ReviewRoles, reviewerId: string): void {
  if (roles.blindReviewerIds?.has(reviewerId)) {
    throw new ReviewPendingError("The acceptance seat cannot be either blind reviewer");
  }
}

function registerReviewPairRoles<T extends SemanticReviewRecord | PositiveControlReviewRecord>(
  roles: ReviewRoles,
  pair: ReviewPair<T>,
): void {
  const ids = new Set([pair.first.reviewer_id, pair.second.reviewer_id]);
  if (ids.size !== 2) {
    throw new ReviewPendingError("The two blind reviews must come from distinct reviewer ids");
  }
  if (roles.blindReviewerIds === undefined) {
    roles.blindReviewerIds = ids;
  } else if (
    ids.size !== roles.blindReviewerIds.size ||
    [...ids].some((reviewerId) => !roles.blindReviewerIds?.has(reviewerId))
  ) {
    throw new ReviewPendingError(
      "The same two blind reviewer ids must review every gate in one run",
    );
  }
  if (pair.arbitration) validateAcceptanceSeat(roles, pair.arbitration.reviewer_id);
}

export function escalationId(options: {
  caseId: CaseId;
  gate: "G4" | "G5";
  reviewerId: string;
  ordinal: number;
}): string {
  return [
    "esc",
    "v1",
    options.caseId,
    options.gate,
    encodeURIComponent(options.reviewerId),
    String(options.ordinal),
  ].join(":");
}

export function createBlindReviewPacket(bundle: RunBundle): BlindReviewPacket {
  return {
    rubric_version: bundle.rubric_version,
    case_id: bundle.case_id,
    fixture_hash: bundle.fixture_hash,
    final_report: bundle.redacted_final_report,
    human_projection: bundle.human_projection,
    artifact_refs: reviewArtifactRefs(bundle),
  };
}

function asRunRelative(bundle: RunBundle, absolutePath: string): string {
  return relative(bundle.paths.run_root, absolutePath).split(sep).join("/");
}

function reviewArtifactRefs(bundle: RunBundle): string[] {
  return [
    ...new Set([
      ...bundle.redaction_records.map((record) =>
        asRunRelative(bundle, record.redacted_artifact_ref),
      ),
      "artifacts/review/trace.jsonl",
      "artifacts/review/diagnostic.json",
      "artifacts/review/redaction-manifest.json",
      ...(bundle.deterministic.G2s ? ["artifacts/review/g2s-audit.json"] : []),
    ]),
  ];
}

function evidenceRefAllowed(ref: string, allowed: string[]): boolean {
  return allowed.some(
    (artifact) =>
      ref === artifact || ref.startsWith(`${artifact}:`) || ref.startsWith(`${artifact}#`),
  );
}

function validateBaseRecord(
  record: SemanticReviewRecord | PositiveControlReviewRecord,
  bundle: RunBundle,
): void {
  if (record.rubric_version !== bundle.rubric_version) {
    throw new ReviewPendingError(
      `Rubric version mismatch: expected ${bundle.rubric_version}, got ${record.rubric_version}`,
    );
  }
  if (record.case_id !== bundle.case_id) {
    throw new ReviewPendingError(`Review case mismatch: expected ${bundle.case_id}`);
  }
  if (record.evidence_refs.length === 0 || record.rationale.length === 0) {
    throw new ReviewPendingError("Review records require a rationale and non-empty evidence_refs");
  }
  for (const [index, escalation] of record.escalations.entries()) {
    if ((escalation.gate !== "G4" && escalation.gate !== "G5") || escalation.text.length === 0) {
      throw new ReviewPendingError(
        `Review escalation ${index + 1} requires gate G4/G5 and non-empty text`,
      );
    }
  }
  const allowedRefs = reviewArtifactRefs(bundle);
  const invalidRefs = record.evidence_refs.filter((ref) => !evidenceRefAllowed(ref, allowedRefs));
  if (invalidRefs.length > 0) {
    throw new ReviewPendingError(
      `Review records cite evidence outside the blind packet: ${invalidRefs.join(",")}`,
    );
  }
}

function raisedFromRecord(
  bundle: RunBundle,
  record: SemanticReviewRecord | PositiveControlReviewRecord,
  source: ReviewEscalationSource,
  nextOrdinal: (gate: "G4" | "G5") => number,
): RaisedEscalationRecord[] {
  return record.escalations.map((escalation) => {
    if (
      escalation.gate === "G4" &&
      (bundle.case_id !== "C4" || bundle.deterministic.G4?.status !== "n/a")
    ) {
      throw new ReviewPendingError(
        "G4 escalation is only legal for a C4 runner-signed boundary n/a",
      );
    }
    const ordinal = nextOrdinal(escalation.gate);
    return {
      escalation_id: escalationId({
        caseId: record.case_id,
        gate: escalation.gate,
        reviewerId: record.reviewer_id,
        ordinal,
      }),
      case_id: record.case_id,
      source,
      gate: escalation.gate,
      reviewer_id: record.reviewer_id,
      ordinal,
      text: escalation.text,
    };
  });
}

function resolvePair<T extends SemanticReviewRecord | PositiveControlReviewRecord>(
  bundle: RunBundle,
  pair: ReviewPair<T>,
): T {
  validateBaseRecord(pair.first, bundle);
  validateBaseRecord(pair.second, bundle);
  if (pair.first.reviewer_id === pair.second.reviewer_id) {
    throw new ReviewPendingError("The two blind reviews must come from distinct reviewer ids");
  }
  if (pair.first.status === pair.second.status) {
    if (pair.arbitration) {
      throw new ReviewPendingError("Arbitration is only allowed when blind reviews disagree");
    }
    return pair.first;
  }
  const arbitration = pair.arbitration;
  if (!arbitration) {
    throw new ReviewPendingError("Blind reviews disagree; acceptance-seat arbitration is required");
  }
  validateBaseRecord(arbitration, bundle);
  if (
    arbitration.reviewer_id === pair.first.reviewer_id ||
    arbitration.reviewer_id === pair.second.reviewer_id
  ) {
    throw new ReviewPendingError("The arbitrator cannot be either blind reviewer");
  }
  if (arbitration.status !== pair.first.status && arbitration.status !== pair.second.status) {
    throw new ReviewPendingError("Arbitration must choose one of the two review outcomes");
  }
  return arbitration;
}

export function requiredReviewGates(bundle: RunBundle): ReviewGate[] {
  const common: ReviewGate[] = ["G6"];
  if (bundle.case_id === "C1") return ["G1", ...common];
  if (bundle.case_id === "C3") return ["G3", ...common];
  if (bundle.case_id === "C4" && bundle.deterministic.G4?.status !== "n/a") {
    return ["G4", ...common];
  }
  return common;
}

export function resolveReviews(options: {
  bundle: RunBundle;
  gates: Partial<Record<ReviewGate, ReviewPair<SemanticReviewRecord>>>;
  positiveControl?: ReviewPair<PositiveControlReviewRecord>;
  escalationDispositions?: EscalationDispositionRecord[];
}): ReviewResolution {
  const gates: ReviewResolution["gates"] = {};
  const raisedEscalations: RaisedEscalationRecord[] = [];
  const reviewRecords: ReviewResolution["review_records"] = [];
  const roles: ReviewRoles = {};
  const escalationOrdinals = new Map<string, number>();
  const nextOrdinal = (
    record: SemanticReviewRecord | PositiveControlReviewRecord,
    gate: "G4" | "G5",
  ): number => {
    const key = JSON.stringify([record.case_id, gate, record.reviewer_id]);
    const ordinal = (escalationOrdinals.get(key) ?? 0) + 1;
    escalationOrdinals.set(key, ordinal);
    return ordinal;
  };
  for (const gate of requiredReviewGates(options.bundle)) {
    const pair = options.gates[gate];
    if (!pair) throw new ReviewPendingError(`Missing blind-review pair for ${gate}`);
    if (
      pair.first.gate !== gate ||
      pair.second.gate !== gate ||
      (pair.arbitration !== undefined && pair.arbitration.gate !== gate)
    ) {
      throw new ReviewPendingError(`Review record is wired to the wrong gate: expected ${gate}`);
    }
    const resolved = resolvePair(options.bundle, pair);
    registerReviewPairRoles(roles, pair);
    const arbitration = pair.arbitration;
    gates[gate] = resolved;
    reviewRecords.push(pair.first, pair.second);
    if (arbitration) reviewRecords.push(arbitration);
    raisedEscalations.push(
      ...raisedFromRecord(options.bundle, pair.first, gate, (targetGate) =>
        nextOrdinal(pair.first, targetGate),
      ),
      ...raisedFromRecord(options.bundle, pair.second, gate, (targetGate) =>
        nextOrdinal(pair.second, targetGate),
      ),
      ...(arbitration
        ? raisedFromRecord(options.bundle, arbitration, gate, (targetGate) =>
            nextOrdinal(arbitration, targetGate),
          )
        : []),
    );
  }

  let positiveControl: PositiveControlReviewRecord | undefined;
  if (options.bundle.receipt.failure_attribution !== null) {
    if (!options.positiveControl) {
      throw new ReviewPendingError(
        "A failure attribution requires the public positive-control clause review",
      );
    }
    const positivePair = options.positiveControl;
    positiveControl = resolvePair(options.bundle, positivePair);
    registerReviewPairRoles(roles, positivePair);
    const { first, second, arbitration } = positivePair;
    reviewRecords.push(first, second);
    if (arbitration) {
      reviewRecords.push(arbitration);
    }
    raisedEscalations.push(
      ...raisedFromRecord(options.bundle, first, first.clause_id, (targetGate) =>
        nextOrdinal(first, targetGate),
      ),
      ...raisedFromRecord(options.bundle, second, second.clause_id, (targetGate) =>
        nextOrdinal(second, targetGate),
      ),
      ...(arbitration
        ? raisedFromRecord(options.bundle, arbitration, arbitration.clause_id, (targetGate) =>
            nextOrdinal(arbitration, targetGate),
          )
        : []),
    );
  }

  const raisedById = new Map<string, RaisedEscalationRecord>();
  for (const escalation of raisedEscalations) {
    if (raisedById.has(escalation.escalation_id)) {
      throw new ReviewPendingError(`Duplicate escalation identity: ${escalation.escalation_id}`);
    }
    raisedById.set(escalation.escalation_id, escalation);
  }
  const dispositions = options.escalationDispositions ?? [];
  const dispositionByEscalation = new Map<string, EscalationDispositionRecord>();
  for (const disposition of dispositions) {
    const raised = raisedById.get(disposition.escalation_id);
    if (!raised) {
      throw new ReviewPendingError(
        `Escalation disposition does not match a raised escalation id: ${disposition.escalation_id}`,
      );
    }
    if (dispositionByEscalation.has(disposition.escalation_id)) {
      throw new ReviewPendingError(
        `Escalation has more than one disposition: ${disposition.escalation_id}`,
      );
    }
    if (disposition.gate !== raised.gate) {
      throw new ReviewPendingError(
        `Escalation disposition gate mismatch: ${disposition.escalation_id} targets ${raised.gate}`,
      );
    }
    if (disposition.outcome !== "dismissed" && disposition.outcome !== "run_invalid") {
      throw new ReviewPendingError(
        "Acceptance-seat escalation outcome must be dismissed or run_invalid",
      );
    }
    if (disposition.rationale.length === 0 || disposition.evidence_refs.length === 0) {
      throw new ReviewPendingError(
        "Escalation dispositions require a rationale and non-empty evidence_refs",
      );
    }
    const allowedRefs = reviewArtifactRefs(options.bundle);
    const invalidRefs = disposition.evidence_refs.filter(
      (ref) => !evidenceRefAllowed(ref, allowedRefs),
    );
    if (invalidRefs.length > 0) {
      throw new ReviewPendingError(
        `Escalation disposition cites evidence outside the blind packet: ${invalidRefs.join(",")}`,
      );
    }
    validateAcceptanceSeat(roles, disposition.acceptance_seat_id);
    dispositionByEscalation.set(disposition.escalation_id, disposition);
  }
  const pendingEscalations = [...raisedById.keys()].filter(
    (escalationId) => !dispositionByEscalation.has(escalationId),
  );
  const invalidatedEscalations = dispositions
    .filter((disposition) => disposition.outcome === "run_invalid")
    .map((disposition) => disposition.escalation_id);
  return {
    gates,
    ...(positiveControl === undefined ? {} : { positive_control: positiveControl }),
    raised_escalations: raisedEscalations,
    pending_escalations: pendingEscalations,
    invalidated_escalations: invalidatedEscalations,
    escalation_dispositions: dispositions,
    review_records: reviewRecords,
  };
}
