export const CASE_IDS = ["C1", "C2", "C3", "C4"] as const;
export type CaseId = (typeof CASE_IDS)[number];

export const GATE_IDS = ["G1", "G2", "G2s", "G3", "G4", "G5", "G6", "G7"] as const;
export type GateId = (typeof GATE_IDS)[number];
export const POSITIVE_CONTROL_CLAUSE_ID = "positive-control-failure-attribution-v1" as const;
export type GateStatus = "pass" | "fail" | "n/a";
export type Verdict = "red" | "green";
export type FinalReportClassification =
  | "fixed"
  | "code_only"
  | "unverified"
  | "stopped_for_human"
  | "blocked_waiting_human";

export interface CandidateIdentity {
  name: string;
  version: string;
}

export interface GateResult {
  status: GateStatus;
  rationale: string;
  evidence_refs: string[];
}

export interface ResultMetrics {
  time_to_correct_surface_s: number;
  tool_rounds: number;
  files_opened: number;
  files_irrelevant: number;
  human_questions: number;
  questions_discretionary: number;
  ran_proportionate_tests: boolean;
  ran_real_acceptance: boolean;
  positive_control_probe_run: boolean;
}

export interface EvaluationResult {
  case_id: CaseId;
  candidate: CandidateIdentity;
  fixture_hash: string;
  run_id: string;
  gates: Partial<Record<GateId, GateResult>>;
  gate_evidence?: Partial<Record<GateId, { observed: string; trace_refs: string[] }>>;
  metrics: ResultMetrics;
  final_report_classification: FinalReportClassification;
  rollback_verified: boolean;
  verdict: Verdict;
  notes?: string;
}

export interface FixtureManifest {
  schema_version: "resident-self-repair-fixture.v0";
  case_id: CaseId;
  title: string;
  prompt: string;
  allowed_mutation_paths: string[];
  expected_production_path: string;
  sensitive_literals: string[];
  forbidden_alternative_tools: string[];
  hard_stop_context?: {
    window_state_path: string;
  };
}

export interface C4WindowState {
  resident_id: string;
  window_id: string;
  generation: number;
  active: boolean;
  current_work_item_id: string;
}

export interface CanonicalUserVisibleEnvelope {
  schema_version: "mist-user-visible-envelope.v0";
  kind: "blocked" | "result";
  resident_id: string;
  window_id: string;
  generation: number;
  work_item_id: string;
  status: FinalReportClassification;
  human_decision: HumanDecisionReceipt;
  source_receipt_ref: string;
}

export interface C4HardStopObservation {
  window_before: C4WindowState;
  window_identity_preserved: boolean;
  window_remained_active: boolean;
  envelope_ref: string;
}

export interface ReceiptChange {
  path: string;
  description: string;
}

export interface ProductionPathReceipt {
  command: string;
  status: "passed" | "failed" | "not_run";
  evidence_refs: string[];
}

export interface SideEffectReceipt {
  data: boolean;
  credentials: boolean;
  external_state: boolean;
  details: string;
}

export interface HumanDecisionReceipt {
  needed: boolean;
  missing: string;
  choice: string;
}

export interface RollbackReceipt {
  attempted: boolean;
  verified: boolean;
  evidence_refs: string[];
}

export interface PositiveControlReceipt {
  run: boolean;
  command: string;
  status: "passed" | "failed" | "not_run";
  evidence_refs: string[];
}

export interface CandidateMetrics {
  time_to_correct_surface_s: number;
  tool_rounds: number;
  files_opened: number;
  files_irrelevant: number;
  human_questions: number;
  questions_discretionary: number;
  ran_proportionate_tests: boolean;
}

export interface RepairReceipt {
  schema_version: "repair-receipt.v0";
  classification: FinalReportClassification;
  summary: string;
  changes: ReceiptChange[];
  production_path: ProductionPathReceipt;
  side_effects: SideEffectReceipt;
  remaining_risks: string[];
  human_decision: HumanDecisionReceipt;
  rollback: RollbackReceipt;
  positive_control: PositiveControlReceipt;
  failure_attribution: string | null;
  nested_child_process_used: boolean;
  metrics: CandidateMetrics;
}

export type TraceEventType =
  | "candidate_started"
  | "candidate_finished"
  | "runner_descendant_process_observed"
  | "tool_invocation"
  | "file_read"
  | "file_write"
  | "file_delete"
  | "directory_create"
  | "external_action"
  | "human_question";

export interface CandidateTraceEvent {
  event: TraceEventType;
  at_offset_ms: number;
  tool?: string;
  path?: string;
  detail?: string;
}

export interface DiagnosticMetadata {
  call_path: string;
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  stderr_empty: boolean;
  raw_artifact_ref: string;
  redacted_artifact_ref: string;
}

export interface RedactionRecord {
  source_id: string;
  raw_artifact_ref: string;
  raw_sha256: string;
  redacted_artifact_ref: string;
  redacted_sha256: string;
  replacements: Array<{ literal_sha256: string; replacement: string; count: number }>;
  non_sensitive_bytes_preserved: boolean;
}

export interface DeterministicObservations {
  G2?: GateResult;
  G2s?: GateResult;
  G4?: GateResult;
  G5: GateResult;
  G7: GateResult;
}

export interface RunPaths {
  run_root: string;
  workspace: string;
  artifacts: string;
  raw_artifacts: string;
  review_artifacts: string;
  semantic_review: string;
}

export interface RunBundle {
  schema_version: "resident-self-repair-run.v0";
  run_id: string;
  case_id: CaseId;
  candidate: CandidateIdentity;
  fixture_hash: string;
  rubric_version: string;
  manifest: FixtureManifest;
  receipt: RepairReceipt;
  human_projection: string;
  redacted_final_report: string;
  changed_paths: string[];
  trace: CandidateTraceEvent[];
  diagnostic: DiagnosticMetadata;
  redaction_records: RedactionRecord[];
  positive_control: PositiveControlObservation;
  deterministic: DeterministicObservations;
  c4_hard_stop?: C4HardStopObservation;
  rollback_verified: boolean;
  paths: RunPaths;
}

export type ReviewGate = "G1" | "G3" | "G4" | "G6";
export type EscalationGate = "G4" | "G5";
export type ReviewEscalationSource = ReviewGate | typeof POSITIVE_CONTROL_CLAUSE_ID;

export interface ReviewEscalation {
  gate: EscalationGate;
  text: string;
}

export interface RaisedEscalationRecord extends ReviewEscalation {
  escalation_id: string;
  case_id: CaseId;
  source: ReviewEscalationSource;
  reviewer_id: string;
  ordinal: number;
}

export interface SemanticReviewRecord {
  rubric_version: string;
  case_id: CaseId;
  gate: ReviewGate;
  status: "pass" | "fail";
  rationale: string;
  evidence_refs: string[];
  escalations: ReviewEscalation[];
  reviewer_id: string;
}

export interface PositiveControlReviewRecord {
  rubric_version: string;
  case_id: CaseId;
  clause_id: typeof POSITIVE_CONTROL_CLAUSE_ID;
  status: "pass" | "fail";
  rationale: string;
  evidence_refs: string[];
  escalations: ReviewEscalation[];
  reviewer_id: string;
}

export interface PositiveControlObservation {
  clause_id: typeof POSITIVE_CONTROL_CLAUSE_ID;
  applicable: boolean;
  status: "pass" | "fail" | "not_applicable";
  rationale: string;
  evidence_refs: string[];
}

export interface EscalationDispositionRecord {
  escalation_id: string;
  gate: EscalationGate;
  outcome: "dismissed" | "run_invalid";
  rationale: string;
  evidence_refs: string[];
  acceptance_seat_id: string;
}

export interface ReviewResolution {
  gates: Partial<Record<ReviewGate, SemanticReviewRecord>>;
  positive_control?: PositiveControlReviewRecord;
  raised_escalations: RaisedEscalationRecord[];
  pending_escalations: string[];
  invalidated_escalations: string[];
  escalation_dispositions: EscalationDispositionRecord[];
  review_records: Array<SemanticReviewRecord | PositiveControlReviewRecord>;
}

export interface CandidateCommand {
  bin: string;
  args: string[];
}
