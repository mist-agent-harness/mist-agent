import { relative, sep } from "node:path";
import type {
  CaseId,
  EscalationDispositionRecord,
  PositiveControlReviewRecord,
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
  const allowedRefs = reviewArtifactRefs(bundle);
  const invalidRefs = record.evidence_refs.filter((ref) => !evidenceRefAllowed(ref, allowedRefs));
  if (invalidRefs.length > 0) {
    throw new ReviewPendingError(
      `Review records cite evidence outside the blind packet: ${invalidRefs.join(",")}`,
    );
  }
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
  if (pair.first.status === pair.second.status) return pair.first;
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
  const raisedEscalations: string[] = [];
  const reviewRecords: ReviewResolution["review_records"] = [];
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
    gates[gate] = resolved;
    reviewRecords.push(pair.first, pair.second);
    if (pair.arbitration) reviewRecords.push(pair.arbitration);
    raisedEscalations.push(
      ...pair.first.escalations,
      ...pair.second.escalations,
      ...(pair.arbitration?.escalations ?? []),
    );
  }

  let positiveControl: PositiveControlReviewRecord | undefined;
  if (options.bundle.receipt.failure_attribution !== null) {
    if (!options.positiveControl) {
      throw new ReviewPendingError(
        "A failure attribution requires the public positive-control clause review",
      );
    }
    positiveControl = resolvePair(options.bundle, options.positiveControl);
    reviewRecords.push(options.positiveControl.first, options.positiveControl.second);
    if (options.positiveControl.arbitration) {
      reviewRecords.push(options.positiveControl.arbitration);
    }
    raisedEscalations.push(
      ...options.positiveControl.first.escalations,
      ...options.positiveControl.second.escalations,
      ...(options.positiveControl.arbitration?.escalations ?? []),
    );
  }

  const reviewerIds = new Set(reviewRecords.map((record) => record.reviewer_id));
  const escalationSet = new Set(raisedEscalations);
  const dispositions = options.escalationDispositions ?? [];
  const dispositionByEscalation = new Map<string, EscalationDispositionRecord>();
  for (const disposition of dispositions) {
    if (!escalationSet.has(disposition.escalation)) {
      throw new ReviewPendingError(
        `Escalation disposition does not match a raised escalation: ${disposition.escalation}`,
      );
    }
    if (dispositionByEscalation.has(disposition.escalation)) {
      throw new ReviewPendingError(
        `Escalation has more than one disposition: ${disposition.escalation}`,
      );
    }
    if (disposition.gate !== "G5") {
      throw new ReviewPendingError("Acceptance-seat escalation dispositions may only target G5");
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
    if (reviewerIds.has(disposition.acceptance_seat_id)) {
      throw new ReviewPendingError(
        "The acceptance-seat disposition cannot be signed by either blind reviewer",
      );
    }
    dispositionByEscalation.set(disposition.escalation, disposition);
  }
  const pendingEscalations = [...escalationSet].filter(
    (escalation) => !dispositionByEscalation.has(escalation),
  );
  const invalidatedEscalations = dispositions
    .filter((disposition) => disposition.outcome === "run_invalid")
    .map((disposition) => disposition.escalation);
  return {
    gates,
    ...(positiveControl === undefined ? {} : { positive_control: positiveControl }),
    pending_escalations: pendingEscalations,
    invalidated_escalations: invalidatedEscalations,
    escalation_dispositions: dispositions,
    review_records: reviewRecords,
  };
}
