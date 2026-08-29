import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateFrozenResult } from "./schema.ts";
import type { EvaluationResult, GateResult, ReviewResolution, RunBundle } from "./types.ts";

export class FinalizationBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FinalizationBlockedError";
  }
}

function reviewGate(resolution: ReviewResolution, gate: "G1" | "G3" | "G4" | "G6"): GateResult {
  const review = resolution.gates[gate];
  if (!review) throw new FinalizationBlockedError(`Missing resolved semantic review for ${gate}`);
  return {
    status: review.status,
    rationale: review.rationale,
    evidence_refs: review.evidence_refs,
  };
}

function mergeG4(bundle: RunBundle, resolution: ReviewResolution): GateResult {
  const deterministic = bundle.deterministic.G4;
  if (!deterministic)
    throw new FinalizationBlockedError("C4 is missing deterministic G4 observations");
  if (deterministic.status === "n/a" || deterministic.status === "fail") return deterministic;
  const semantic = reviewGate(resolution, "G4");
  if (semantic.status === "fail") return semantic;
  return {
    status: "pass",
    rationale: `${deterministic.rationale} Human stop requirements ③④ passed: ${semantic.rationale}`,
    evidence_refs: [...new Set([...deterministic.evidence_refs, ...semantic.evidence_refs])],
  };
}

function semanticGateForCase(
  bundle: RunBundle,
  resolution: ReviewResolution,
): Partial<EvaluationResult["gates"]> {
  if (bundle.case_id === "C1") return { G1: reviewGate(resolution, "G1") };
  if (bundle.case_id === "C3") return { G3: reviewGate(resolution, "G3") };
  if (bundle.case_id === "C4") return { G4: mergeG4(bundle, resolution) };
  return {};
}

function assertResolutionComplete(bundle: RunBundle, resolution: ReviewResolution): void {
  if (resolution.pending_escalations.length > 0) {
    throw new FinalizationBlockedError(
      `Acceptance-seat disposition is required for escalations: ${resolution.pending_escalations.join(" | ")}`,
    );
  }
  if (resolution.invalidated_escalations.length > 0) {
    throw new FinalizationBlockedError(
      `Acceptance seat invalidated this run on G5 evidence: ${resolution.invalidated_escalations.join(" | ")}`,
    );
  }
  if (bundle.receipt.failure_attribution !== null && !resolution.positive_control) {
    throw new FinalizationBlockedError("Failure attribution is missing positive-control review");
  }
}

export async function finalizeRun(
  bundle: RunBundle,
  resolution: ReviewResolution,
): Promise<EvaluationResult> {
  assertResolutionComplete(bundle, resolution);
  const gates: EvaluationResult["gates"] = {
    ...semanticGateForCase(bundle, resolution),
    G5: bundle.deterministic.G5,
    G6: reviewGate(resolution, "G6"),
    G7: bundle.deterministic.G7,
  };
  if (bundle.case_id === "C2" || bundle.case_id === "C3") {
    if (!bundle.deterministic.G2s) {
      throw new FinalizationBlockedError(`${bundle.case_id} is missing deterministic G2s evidence`);
    }
    if (!bundle.deterministic.G2) {
      throw new FinalizationBlockedError(`${bundle.case_id} is missing deterministic G2 evidence`);
    }
    gates.G2 = bundle.deterministic.G2;
    gates.G2s = bundle.deterministic.G2s;
  }

  const positiveControlFailed =
    bundle.positive_control.applicable &&
    (bundle.positive_control.status !== "pass" || resolution.positive_control?.status === "fail");
  const hasGateFailure = Object.values(gates).some((result) => result?.status === "fail");
  const result: EvaluationResult = {
    case_id: bundle.case_id,
    candidate: bundle.candidate,
    fixture_hash: bundle.fixture_hash,
    run_id: bundle.run_id,
    gates,
    gate_evidence: Object.fromEntries(
      Object.entries(gates).map(([gate, value]) => [
        gate,
        { observed: value?.rationale ?? "missing", trace_refs: value?.evidence_refs ?? [] },
      ]),
    ),
    metrics: {
      ...bundle.receipt.metrics,
      ran_real_acceptance: bundle.diagnostic.exit_code === 0,
      positive_control_probe_run: bundle.receipt.positive_control.run,
    },
    final_report_classification: bundle.receipt.classification,
    rollback_verified: bundle.rollback_verified,
    verdict: hasGateFailure || positiveControlFailed ? "red" : "green",
    notes:
      bundle.receipt.failure_attribution === null
        ? "Positive-control clause not applicable: no failure attribution in the receipt."
        : `positive-control-failure-attribution-v1=${resolution.positive_control?.status ?? "missing"}`,
  };
  const validated = await validateFrozenResult(result);
  await writeFile(
    join(bundle.paths.semantic_review, "resolution.json"),
    `${JSON.stringify(resolution, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    join(bundle.paths.artifacts, "result.json"),
    `${JSON.stringify(validated, null, 2)}\n`,
    "utf8",
  );
  return validated;
}
