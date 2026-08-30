import { describe, expect, it } from "vitest";
import {
  redactText,
  verifyRedactionProjection,
} from "../src/eval/resident-self-repair/redaction.ts";
import {
  compileFrozenResultValidator,
  loadFrozenResultSchema,
  loadRubricVersion,
} from "../src/eval/resident-self-repair/schema.ts";
import type { EvaluationResult, GateResult } from "../src/eval/resident-self-repair/types.ts";

const pass: GateResult = {
  status: "pass",
  rationale: "evidence observed",
  evidence_refs: ["trace#1"],
};

function validC1(): EvaluationResult {
  return {
    case_id: "C1",
    candidate: { name: "synthetic", version: "1" },
    fixture_hash: "a".repeat(64),
    run_id: "run-1",
    gates: { G1: pass, G5: pass, G6: pass, G7: pass },
    metrics: {
      time_to_correct_surface_s: 1,
      tool_rounds: 1,
      files_opened: 1,
      files_irrelevant: 0,
      human_questions: 0,
      questions_discretionary: 0,
      ran_proportionate_tests: true,
      ran_real_acceptance: true,
      positive_control_probe_run: false,
    },
    final_report_classification: "fixed",
    rollback_verified: true,
    verdict: "green",
  };
}

describe("frozen resident self-repair result schema", () => {
  it("loads the schema directly from the frozen contract and locks the current rubric version", async () => {
    const schema = await loadFrozenResultSchema();
    expect(schema.$id).toBe("https://mist-agent-harness/mr-eval/result.schema.v0.json");
    await expect(loadRubricVersion()).resolves.toBe("rubric-v0.1.3");
  });

  it("redacts only secret values and can recompute projection integrity", () => {
    const raw = "exit=17 token=synthetic-unknown route=bridge\n";
    const redacted = redactText(raw, []).value;
    expect(redacted).toBe("exit=17 token=[REDACTED_PATTERN_2] route=bridge\n");
    expect(verifyRedactionProjection(raw, redacted, [])).toBe(true);
    expect(verifyRedactionProjection(raw, redacted.replace("exit=17", "exit=0"), [])).toBe(false);
  });

  it("accepts a valid result and rejects frozen contradiction probes", async () => {
    const validate = await compileFrozenResultValidator();
    expect(validate(validC1())).toBe(true);

    const failWithGreen = validC1();
    failWithGreen.gates.G1 = { status: "fail", rationale: "counterexample", evidence_refs: ["x"] };
    expect(validate(failWithGreen)).toBe(false);

    const illegalNa = validC1();
    illegalNa.gates.G1 = { status: "n/a", rationale: "out of scope", evidence_refs: [] };
    expect(validate(illegalNa)).toBe(false);

    const missingGate = validC1();
    const { G6: omittedG6, ...withoutG6 } = missingGate.gates;
    expect(omittedG6).toBeDefined();
    missingGate.gates = withoutG6;
    expect(validate(missingGate)).toBe(false);
  });
});
