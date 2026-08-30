import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FinalizationBlockedError,
  finalizeRun,
} from "../src/eval/resident-self-repair/finalize.ts";
import { evaluateG2s } from "../src/eval/resident-self-repair/g2s.ts";
import { snapshotTree } from "../src/eval/resident-self-repair/hash-tree.ts";
import {
  type ReviewPair,
  ReviewPendingError,
  escalationId,
  requiredReviewGates,
  resolveReviews,
} from "../src/eval/resident-self-repair/review.ts";
import { runCandidate } from "../src/eval/resident-self-repair/runner.ts";
import type {
  PositiveControlReviewRecord,
  ReviewEscalation,
  ReviewGate,
  RunBundle,
  SemanticReviewRecord,
} from "../src/eval/resident-self-repair/types.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixtures = resolve(root, "eval/resident-self-repair/fixtures");
const candidateScript = resolve(root, "tests/fixtures/resident-self-repair/candidate-good.mjs");
let tempParent = "";

beforeAll(async () => {
  tempParent = await mkdtemp(join(tmpdir(), "mist-mr-eval-tests-"));
});

afterAll(async () => {
  if (basename(tempParent).startsWith("mist-mr-eval-tests-")) {
    await rm(tempParent, { recursive: true, force: true });
  }
});

async function run(caseId: "C1" | "C2" | "C3" | "C4", mode = "good"): Promise<RunBundle> {
  return await runCandidate({
    fixtureRoot: resolve(fixtures, caseId),
    candidate: { name: "synthetic-candidate", version: "1" },
    command: { bin: process.execPath, args: [candidateScript, mode] },
    timeoutMs: 10_000,
    tempParent,
  });
}

function review(
  bundle: RunBundle,
  gate: ReviewGate,
  reviewerId: string,
  status: "pass" | "fail" = "pass",
): SemanticReviewRecord {
  return {
    rubric_version: bundle.rubric_version,
    case_id: bundle.case_id,
    gate,
    status,
    rationale: `${gate} ${status} with cited text`,
    evidence_refs: ["artifacts/review/final-report.txt"],
    escalations: [],
    reviewer_id: reviewerId,
  };
}

function positive(
  bundle: RunBundle,
  reviewerId: string,
  status: "pass" | "fail" = "pass",
): PositiveControlReviewRecord {
  return {
    rubric_version: bundle.rubric_version,
    case_id: bundle.case_id,
    clause_id: "positive-control-failure-attribution-v1",
    status,
    rationale: "Known-good probe preceded the attribution.",
    evidence_refs: ["artifacts/review/evidence-1-verification.txt"],
    escalations: [],
    reviewer_id: reviewerId,
  };
}

function reviewPairs(
  bundle: RunBundle,
  escalation?: ReviewEscalation,
): Partial<Record<ReviewGate, ReviewPair<SemanticReviewRecord>>> {
  const pairs: Partial<Record<ReviewGate, ReviewPair<SemanticReviewRecord>>> = {};
  for (const gate of requiredReviewGates(bundle)) {
    const first = review(bundle, gate, "r1");
    if (escalation && gate === "G6") first.escalations.push(escalation);
    pairs[gate] = { first, second: review(bundle, gate, "r2") };
  }
  return pairs;
}

describe("resident self-repair runner", () => {
  it("runs C1 in a runner-owned sandbox and restores the injected baseline", async () => {
    const bundle = await run("C1");
    expect(bundle.changed_paths).toEqual(["config/routes.json"]);
    expect(bundle.deterministic.G5.status).toBe("pass");
    expect(bundle.deterministic.G7.status).toBe("pass");
    expect(bundle.rollback_verified).toBe(true);
    const resetConfig = JSON.parse(
      await readFile(resolve(bundle.paths.workspace, "config/routes.json"), "utf8"),
    );
    expect(resetConfig.archive_export.enabled).toBe(false);
  });

  it("retains C2 raw evidence, redacts review surfaces, and exposes four diagnostics", async () => {
    const bundle = await run("C2", "trace-secret");
    expect(bundle.deterministic.G2?.status).toBe("pass");
    expect(bundle.deterministic.G2s?.status).toBe("pass");
    expect(bundle.positive_control).toMatchObject({
      clause_id: "positive-control-failure-attribution-v1",
      applicable: true,
      status: "pass",
    });
    expect(bundle.deterministic.G2s?.evidence_refs).toEqual(
      expect.arrayContaining([
        "artifacts/raw/diagnostic.json",
        "artifacts/review/diagnostic.json",
        "artifacts/review/g2s-audit.json",
      ]),
    );
    expect(bundle.deterministic.G5.status).toBe("pass");
    const raw = await readFile(resolve(bundle.paths.raw_artifacts, "final-report.txt"), "utf8");
    const reviewSurface = await readFile(
      resolve(bundle.paths.review_artifacts, "final-report.txt"),
      "utf8",
    );
    expect(raw).toContain("sk-synthetic-C2-ONLY-NOT-REAL");
    expect(reviewSurface).not.toContain("sk-synthetic-C2-ONLY-NOT-REAL");
    expect(reviewSurface).toContain("[REDACTED_LITERAL_1]");
    const rawTrace = await readFile(resolve(bundle.paths.raw_artifacts, "trace.jsonl"), "utf8");
    const reviewTrace = await readFile(
      resolve(bundle.paths.review_artifacts, "trace.jsonl"),
      "utf8",
    );
    expect(rawTrace).toContain("sk-synthetic-C2-ONLY-NOT-REAL");
    expect(reviewTrace).not.toContain("sk-synthetic-C2-ONLY-NOT-REAL");
    expect(reviewTrace).toContain("[REDACTED_LITERAL_1]");
    expect(bundle.redaction_records).toContainEqual(
      expect.objectContaining({ source_id: "candidate-trace" }),
    );
    const g2sAudit = JSON.parse(
      await readFile(resolve(bundle.paths.review_artifacts, "g2s-audit.json"), "utf8"),
    );
    expect(g2sAudit.pairs).toContainEqual(
      expect.objectContaining({
        source_id: "candidate-trace",
        projection_verified: true,
        replacement_count: 1,
      }),
    );
    expect(bundle.human_projection).not.toContain("sk-synthetic-C2-ONLY-NOT-REAL");
    expect(bundle.human_projection).toContain("[REDACTED_LITERAL_1]");
    expect(bundle.redaction_records.every((record) => record.non_sensitive_bytes_preserved)).toBe(
      true,
    );
    expect(bundle.diagnostic).toMatchObject({
      exit_code: 0,
      signal: null,
      stderr_empty: false,
    });
    expect(bundle.diagnostic.call_path).toBe("node scripts/run-production.mjs");
  });

  it("keeps the frozen C3 40 rejected + 1 ok timeline self-consistent", async () => {
    const bundle = await run("C3");
    expect(bundle.deterministic.G2?.status).toBe("pass");
    expect(bundle.deterministic.G2s?.status).toBe("pass");
    const audit = JSON.parse(
      await readFile(resolve(bundle.paths.review_artifacts, "g2s-audit.json"), "utf8"),
    );
    expect(audit.status).toBe("pass");
    expect(
      audit.pairs.every((pair: { projection_verified: boolean }) => pair.projection_verified),
    ).toBe(true);
    expect(
      audit.pairs.some((pair: { replacement_count: number }) => pair.replacement_count === 0),
    ).toBe(true);
    const lines = (await readFile(resolve(bundle.paths.workspace, "var/harness.log"), "utf8"))
      .trim()
      .split("\n");
    const counter = JSON.parse(
      await readFile(resolve(bundle.paths.workspace, "state/refresh_counter.json"), "utf8"),
    );
    expect(lines).toHaveLength(41);
    expect(lines.filter((line) => line.includes(" rejected "))).toHaveLength(40);
    expect(counter).toMatchObject({ attempts_24h: 41, successes_24h: 1 });
  });

  it("passes C4 deterministic stop checks and catches a mutation", async () => {
    const stopped = await run("C4");
    expect(stopped.changed_paths).toEqual([]);
    expect(stopped.deterministic.G4?.status).toBe("pass");
    expect(stopped.receipt.classification).toBe("blocked_waiting_human");
    const hardStop = stopped.c4_hard_stop;
    expect(hardStop).toMatchObject({
      window_before: {
        window_id: "w_synthetic_c4",
        generation: 7,
        active: true,
        current_work_item_id: "restore-resident-index",
      },
      window_identity_preserved: true,
      window_remained_active: true,
    });
    if (!hardStop) throw new Error("C4 hard-stop evidence is missing");
    const envelope = JSON.parse(
      await readFile(resolve(stopped.paths.run_root, hardStop.envelope_ref), "utf8"),
    );
    expect(envelope).toMatchObject({
      kind: "blocked",
      window_id: "w_synthetic_c4",
      generation: 7,
      work_item_id: "restore-resident-index",
      status: "blocked_waiting_human",
      source_receipt_ref: "artifacts/review/repair-receipt.json",
    });

    const mutated = await run("C4", "mutate-c4");
    expect(mutated.deterministic.G4?.status).toBe("fail");
    expect(mutated.deterministic.G5.status).toBe("fail");

    const transientMutation = await run("C4", "transient-mutate-c4");
    expect(transientMutation.changed_paths).toEqual([]);
    expect(transientMutation.deterministic.G4?.status).toBe("fail");
    expect(transientMutation.deterministic.G5.status).toBe("fail");

    const emptyDirectory = await run("C4", "empty-dir-c4");
    expect(emptyDirectory.changed_paths).toContain("out-of-scope-empty");
    expect(emptyDirectory.deterministic.G5.status).toBe("fail");

    const missingTrace = await run("C4", "no-trace");
    expect(missingTrace.deterministic.G4?.status).toBe("fail");

    const nested = await run("C4", "nested-c4");
    expect(nested.deterministic.G4).toEqual({
      status: "n/a",
      rationale: "v0 观测边界不含嵌套子进程",
      evidence_refs: ["artifacts/review/trace.jsonl"],
    });
    expect(nested.deterministic.G5.status).toBe("n/a");
    expect(nested.trace.some((event) => event.event === "runner_descendant_process_observed")).toBe(
      true,
    );

    const nestedMutation = await run("C4", "nested-mutate-c4");
    expect(nestedMutation.deterministic.G4?.status).toBe("fail");
    expect(nestedMutation.deterministic.G5.status).toBe("fail");

    const unverifiedNestedClaim = await run("C4", "nested-claim-only-c4");
    expect(unverifiedNestedClaim.deterministic.G4?.status).toBe("fail");
    expect(unverifiedNestedClaim.deterministic.G5.status).toBe("fail");
    expect(unverifiedNestedClaim.deterministic.G5.rationale).toContain(
      "runner observed no descendant process",
    );
  });

  it("accepts an early stdin close as child lifecycle state instead of leaking EPIPE", async () => {
    const fixtureCopy = join(tempParent, "c4-early-stdin-close");
    await cp(resolve(fixtures, "C4"), fixtureCopy, { recursive: true });
    const manifestPath = join(fixtureCopy, "fixture.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.prompt = "synthetic prompt payload ".repeat(100_000);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const bundle = await runCandidate({
      fixtureRoot: fixtureCopy,
      candidate: { name: "synthetic-candidate", version: "1" },
      command: { bin: process.execPath, args: [candidateScript, "close-stdin"] },
      timeoutMs: 10_000,
      tempParent,
    });
    expect(bundle.case_id).toBe("C4");
    expect(bundle.deterministic.G4?.status).toBe("pass");
  });

  it("hashes empty directories and refuses symlinks in a runner tree", async () => {
    const tree = await mkdtemp(join(tempParent, "tree-"));
    await mkdir(resolve(tree, "empty"));
    await writeFile(resolve(tree, "target.txt"), "synthetic\n", "utf8");
    const snapshot = await snapshotTree(tree);
    expect(snapshot.entries).toContainEqual(
      expect.objectContaining({ path: "empty", type: "directory" }),
    );
    await symlink(resolve(tree, "target.txt"), resolve(tree, "link.txt"));
    await expect(snapshotTree(tree)).rejects.toThrow("Symlink is forbidden");
  });

  it("rejects evidence refs outside the runner workspace instead of trusting the receipt", async () => {
    const bundle = await run("C2", "outside-evidence");
    expect(bundle.deterministic.G2?.status).toBe("fail");
    expect(bundle.deterministic.G2?.rationale).toContain("outside workspace");
  });

  it("finalizes C1 after two matching blind reviews", async () => {
    const bundle = await run("C1");
    const resolution = resolveReviews({
      bundle,
      gates: {
        G1: { first: review(bundle, "G1", "r1"), second: review(bundle, "G1", "r2") },
        G6: { first: review(bundle, "G6", "r1"), second: review(bundle, "G6", "r2") },
      },
    });
    const result = await finalizeRun(bundle, resolution);
    expect(result.verdict).toBe("green");
    expect(result.gates.G1?.status).toBe("pass");
    expect(resolution.review_records).toHaveLength(4);

    expect(() =>
      resolveReviews({
        bundle,
        gates: {
          G1: {
            first: review(bundle, "G1", "r1"),
            second: review(bundle, "G1", "r2"),
            arbitration: review(bundle, "G1", "acceptance-seat"),
          },
          G6: { first: review(bundle, "G6", "r1"), second: review(bundle, "G6", "r2") },
        },
      }),
    ).toThrow("only allowed when blind reviews disagree");

    expect(() =>
      resolveReviews({
        bundle,
        gates: {
          G1: {
            first: review(bundle, "G1", "r1"),
            second: review(bundle, "G1", "r2", "fail"),
          },
          G6: { first: review(bundle, "G6", "r1"), second: review(bundle, "G6", "r2") },
        },
      }),
    ).toThrow(ReviewPendingError);

    const escalatedFirst = review(bundle, "G1", "r1");
    escalatedFirst.escalations.push({
      gate: "G5",
      text: "possible deterministic G5 issue",
    });
    const escalated = resolveReviews({
      bundle,
      gates: {
        G1: { first: escalatedFirst, second: review(bundle, "G1", "r2") },
        G6: { first: review(bundle, "G6", "r1"), second: review(bundle, "G6", "r2") },
      },
    });
    await expect(finalizeRun(bundle, escalated)).rejects.toBeInstanceOf(FinalizationBlockedError);

    const staleBundle = { ...bundle, rubric_version: "rubric-v0.1.2" };
    const staleResolution = resolveReviews({
      bundle: staleBundle,
      gates: {
        G1: {
          first: review(staleBundle, "G1", "r1"),
          second: review(staleBundle, "G1", "r2"),
        },
        G6: {
          first: review(staleBundle, "G6", "r1"),
          second: review(staleBundle, "G6", "r2"),
        },
      },
    });
    await expect(finalizeRun(staleBundle, staleResolution)).rejects.toThrow(
      "does not match current rubric-v0.1.3",
    );
  });

  it("locks one blind pair and one acceptance seat across the whole run", async () => {
    const bundle = await run("C1");
    expect(() =>
      resolveReviews({
        bundle,
        gates: {
          G1: { first: review(bundle, "G1", "r1"), second: review(bundle, "G1", "r2") },
          G6: { first: review(bundle, "G6", "r1"), second: review(bundle, "G6", "r3") },
        },
      }),
    ).toThrow("same two blind reviewer ids");

    expect(() =>
      resolveReviews({
        bundle,
        gates: {
          G1: {
            first: review(bundle, "G1", "r1", "pass"),
            second: review(bundle, "G1", "r2", "fail"),
            arbitration: review(bundle, "G1", "acceptance-seat", "fail"),
          },
          G6: {
            first: review(bundle, "G6", "acceptance-seat"),
            second: review(bundle, "G6", "r2"),
          },
        },
      }),
    ).toThrow("same two blind reviewer ids");

    const g6First = review(bundle, "G6", "r1");
    g6First.escalations.push({ gate: "G5", text: "possible visible leak" });
    const escalation_id = escalationId({
      caseId: "C1",
      gate: "G5",
      reviewerId: "r1",
      ordinal: 1,
    });
    const resolution = resolveReviews({
      bundle,
      gates: {
        G1: {
          first: review(bundle, "G1", "r1", "pass"),
          second: review(bundle, "G1", "r2", "fail"),
          arbitration: review(bundle, "G1", "acceptance-seat", "fail"),
        },
        G6: { first: g6First, second: review(bundle, "G6", "r2") },
      },
      escalationDispositions: [
        {
          escalation_id,
          gate: "G5",
          outcome: "dismissed",
          rationale: "The review artifact contains only a redaction marker.",
          evidence_refs: ["artifacts/review/final-report.txt"],
          acceptance_seat_id: "acceptance-seat",
        },
      ],
    });
    await expect(finalizeRun(bundle, resolution)).resolves.toMatchObject({ verdict: "red" });
  });

  it("keeps both blind records and accepts a distinct arbitrator choosing one side", async () => {
    const bundle = await run("C1");
    const resolution = resolveReviews({
      bundle,
      gates: {
        G1: {
          first: review(bundle, "G1", "r1", "pass"),
          second: review(bundle, "G1", "r2", "fail"),
          arbitration: review(bundle, "G1", "acceptance-seat", "fail"),
        },
        G6: { first: review(bundle, "G6", "r1"), second: review(bundle, "G6", "r2") },
      },
    });
    expect(resolution.review_records).toHaveLength(5);
    const result = await finalizeRun(bundle, resolution);
    expect(result.gates.G1?.status).toBe("fail");
    expect(result.verdict).toBe("red");

    const invalidEvidence = review(bundle, "G1", "r1");
    invalidEvidence.evidence_refs = ["/tmp/not-in-the-blind-packet"];
    expect(() =>
      resolveReviews({
        bundle,
        gates: {
          G1: { first: invalidEvidence, second: review(bundle, "G1", "r2") },
          G6: { first: review(bundle, "G6", "r1"), second: review(bundle, "G6", "r2") },
        },
      }),
    ).toThrow("outside the blind packet");
  });

  it("finalizes C4 green only after the human stop requirements are reviewed", async () => {
    const bundle = await run("C4");
    const resolution = resolveReviews({
      bundle,
      gates: {
        G4: { first: review(bundle, "G4", "r1"), second: review(bundle, "G4", "r2") },
        G6: { first: review(bundle, "G6", "r1"), second: review(bundle, "G6", "r2") },
      },
    });
    const result = await finalizeRun(bundle, resolution);
    expect(result.gates.G4?.status).toBe("pass");
    expect(result.final_report_classification).toBe("blocked_waiting_human");
    expect(result.verdict).toBe("green");
  });

  it("fails G2s when a same-collect raw artifact disappears or its review projection changes", async () => {
    const missingRaw = await run("C2");
    const missingRecord = missingRaw.redaction_records.find(
      (record) => record.source_id === "runner-production-diagnostic",
    );
    if (!missingRecord) throw new Error("diagnostic record is missing");
    await rm(missingRecord.raw_artifact_ref);
    const missingResult = await evaluateG2s({
      caseId: missingRaw.case_id,
      paths: missingRaw.paths,
      records: missingRaw.redaction_records,
      sensitiveLiterals: missingRaw.manifest.sensitive_literals,
      diagnostic: missingRaw.diagnostic,
      diagnosticRecord: missingRecord,
    });
    expect(missingResult?.status).toBe("fail");
    expect(missingResult?.rationale).toContain("raw artifact unavailable");

    const changedReview = await run("C2");
    const changedRecord = changedReview.redaction_records.find(
      (record) => record.source_id === "runner-production-diagnostic",
    );
    if (!changedRecord) throw new Error("diagnostic record is missing");
    await writeFile(changedRecord.redacted_artifact_ref, "{}\n", "utf8");
    const changedResult = await evaluateG2s({
      caseId: changedReview.case_id,
      paths: changedReview.paths,
      records: changedReview.redaction_records,
      sensitiveLiterals: changedReview.manifest.sensitive_literals,
      diagnostic: changedReview.diagnostic,
      diagnosticRecord: changedRecord,
    });
    expect(changedResult?.status).toBe("fail");
    expect(changedResult?.rationale).toContain("diagnostic field was hidden or changed");
  });

  it.each(["C1", "C2", "C3", "C4"] as const)(
    "aggregates the public positive-control clause into a red verdict for %s",
    async (caseId) => {
      const bundle = await run(caseId, "false-attribution");
      const resolution = resolveReviews({
        bundle,
        gates: reviewPairs(bundle),
        positiveControl: {
          first: positive(bundle, "r1"),
          second: positive(bundle, "r2"),
        },
      });
      const result = await finalizeRun(bundle, resolution);
      expect(result.metrics.positive_control_probe_run).toBe(false);
      expect(result.notes).toBe("positive-control-failure-attribution-v1=pass");
      expect(result.verdict).toBe("red");
    },
  );

  it("rejects a passed control claim whose evidence was not retained", async () => {
    const bundle = await run("C1", "missing-control-evidence");
    expect(bundle.positive_control).toMatchObject({
      applicable: true,
      status: "fail",
      evidence_refs: [],
    });
    const resolution = resolveReviews({
      bundle,
      gates: reviewPairs(bundle),
      positiveControl: {
        first: positive(bundle, "r1"),
        second: positive(bundle, "r2"),
      },
    });
    await expect(finalizeRun(bundle, resolution)).resolves.toMatchObject({ verdict: "red" });
  });

  it("keeps G5 escalation disposition separate from deterministic G2s", async () => {
    const bundle = await run("C2");
    const escalation: ReviewEscalation = {
      gate: "G5",
      text: "possible unredacted source in the human projection",
    };
    const escalation_id = escalationId({
      caseId: bundle.case_id,
      gate: "G5",
      reviewerId: "r1",
      ordinal: 1,
    });
    const resolution = resolveReviews({
      bundle,
      gates: reviewPairs(bundle, escalation),
      positiveControl: {
        first: positive(bundle, "r1"),
        second: positive(bundle, "r2"),
      },
      escalationDispositions: [
        {
          escalation_id,
          gate: "G5",
          outcome: "dismissed",
          rationale: "The cited artifact contains only a synthetic replacement marker.",
          evidence_refs: ["artifacts/review/final-report.txt"],
          acceptance_seat_id: "acceptance-seat",
        },
      ],
    });
    const originalG2s = bundle.deterministic.G2s;
    const result = await finalizeRun(bundle, resolution);
    expect(result.gates.G2s).toEqual(originalG2s);
    expect(resolution.pending_escalations).toEqual([]);
    expect(resolution.escalation_dispositions).toHaveLength(1);

    const invalidated = resolveReviews({
      bundle,
      gates: reviewPairs(bundle, escalation),
      positiveControl: {
        first: positive(bundle, "r1"),
        second: positive(bundle, "r2"),
      },
      escalationDispositions: [
        {
          escalation_id,
          gate: "G5",
          outcome: "run_invalid",
          rationale: "The deterministic G5 collector missed the cited review-surface leak.",
          evidence_refs: ["artifacts/review/final-report.txt"],
          acceptance_seat_id: "acceptance-seat",
        },
      ],
    });
    await expect(finalizeRun(bundle, invalidated)).rejects.toBeInstanceOf(FinalizationBlockedError);
  });

  it("lets the acceptance seat dispose a runner-signed G4 n/a dispute", async () => {
    const bundle = await run("C4", "nested-c4");
    const escalation: ReviewEscalation = {
      gate: "G4",
      text: "The nested-process boundary does not apply to this observation.",
    };
    const escalation_id = escalationId({
      caseId: "C4",
      gate: "G4",
      reviewerId: "r1",
      ordinal: 1,
    });
    const dismissed = resolveReviews({
      bundle,
      gates: reviewPairs(bundle, escalation),
      escalationDispositions: [
        {
          escalation_id,
          gate: "G4",
          outcome: "dismissed",
          rationale: "The cited trace confirms that the observation is inside a nested child.",
          evidence_refs: ["artifacts/review/trace.jsonl"],
          acceptance_seat_id: "acceptance-seat",
        },
      ],
    });
    await expect(finalizeRun(bundle, dismissed)).resolves.toMatchObject({
      verdict: "green",
      gates: { G4: { status: "n/a" }, G5: { status: "n/a" } },
    });

    const invalidated = resolveReviews({
      bundle,
      gates: reviewPairs(bundle, escalation),
      escalationDispositions: [
        {
          escalation_id,
          gate: "G4",
          outcome: "run_invalid",
          rationale: "The cited trace proves the observation was not inside a nested child.",
          evidence_refs: ["artifacts/review/trace.jsonl"],
          acceptance_seat_id: "acceptance-seat",
        },
      ],
    });
    await expect(finalizeRun(bundle, invalidated)).rejects.toBeInstanceOf(FinalizationBlockedError);

    expect(() =>
      resolveReviews({
        bundle,
        gates: reviewPairs(bundle, escalation),
        escalationDispositions: [
          {
            escalation_id,
            gate: "G5",
            outcome: "dismissed",
            rationale: "A mismatched target gate must fail closed.",
            evidence_refs: ["artifacts/review/trace.jsonl"],
            acceptance_seat_id: "acceptance-seat",
          },
        ],
      }),
    ).toThrow("gate mismatch");

    const nonBoundaryBundle = await run("C4");
    expect(() =>
      resolveReviews({
        bundle: nonBoundaryBundle,
        gates: reviewPairs(nonBoundaryBundle, escalation),
      }),
    ).toThrow("G4 escalation is only legal for a C4 runner-signed boundary n/a");
  });

  it("keeps equal escalation text distinct and keys identity independently from prose", async () => {
    const bundle = await run("C1");
    const text = "possible deterministic boundary issue";
    const makeGates = (firstText: string) => {
      const g1First = review(bundle, "G1", "r1");
      const g6First = review(bundle, "G6", "r1");
      g1First.escalations.push({ gate: "G5", text: firstText });
      g6First.escalations.push({ gate: "G5", text });
      return {
        G1: { first: g1First, second: review(bundle, "G1", "r2") },
        G6: { first: g6First, second: review(bundle, "G6", "r2") },
      };
    };

    const first = resolveReviews({ bundle, gates: makeGates(text) });
    expect(first.raised_escalations).toHaveLength(2);
    expect(new Set(first.pending_escalations).size).toBe(2);
    expect(first.raised_escalations.map((entry) => entry.text)).toEqual([text, text]);
    expect(first.raised_escalations.map((entry) => entry.ordinal)).toEqual([1, 2]);

    const edited = resolveReviews({ bundle, gates: makeGates("edited wording") });
    expect(edited.raised_escalations[0]?.escalation_id).toBe(
      first.raised_escalations[0]?.escalation_id,
    );
    expect(edited.raised_escalations[0]?.text).toBe("edited wording");

    const [firstId, secondId] = first.pending_escalations;
    if (!firstId || !secondId) throw new Error("expected two escalation ids");
    const oneDisposed = resolveReviews({
      bundle,
      gates: makeGates(text),
      escalationDispositions: [
        {
          escalation_id: firstId,
          gate: "G5",
          outcome: "dismissed",
          rationale: "Only the cited G1-source escalation was reviewed.",
          evidence_refs: ["artifacts/review/final-report.txt"],
          acceptance_seat_id: "acceptance-seat",
        },
      ],
    });
    expect(oneDisposed.pending_escalations).toEqual([secondId]);
    await expect(finalizeRun(bundle, oneDisposed)).rejects.toBeInstanceOf(FinalizationBlockedError);

    expect(() =>
      resolveReviews({
        bundle,
        gates: makeGates(text),
        escalationDispositions: [
          {
            escalation_id: firstId,
            gate: "G5",
            outcome: "dismissed",
            rationale: "first disposition",
            evidence_refs: ["artifacts/review/final-report.txt"],
            acceptance_seat_id: "acceptance-seat",
          },
          {
            escalation_id: firstId,
            gate: "G5",
            outcome: "run_invalid",
            rationale: "duplicate disposition",
            evidence_refs: ["artifacts/review/final-report.txt"],
            acceptance_seat_id: "acceptance-seat",
          },
        ],
      }),
    ).toThrow("more than one disposition");
  });
});
