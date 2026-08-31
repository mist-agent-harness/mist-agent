import { lstat, readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { assertRealDescendant, sha256 } from "./hash-tree.ts";
import { containsSensitiveLiteral, redactText, verifyRedactionProjection } from "./redaction.ts";
import type { CaseId, DiagnosticMetadata, GateResult, RedactionRecord, RunPaths } from "./types.ts";

interface G2sPairAudit {
  source_id: string;
  raw_artifact_ref: string;
  raw_sha256: string;
  redacted_artifact_ref: string;
  redacted_sha256: string;
  replacement_count: number;
  projection_verified: boolean;
}

interface G2sAudit {
  schema_version: "resident-self-repair-g2s-audit.v0";
  case_id: "C2" | "C3";
  status: "pass" | "fail";
  issues: string[];
  diagnostic_fields: Pick<
    DiagnosticMetadata,
    "call_path" | "exit_code" | "signal" | "stderr_empty"
  >;
  pairs: G2sPairAudit[];
}

export interface EvaluateG2sOptions {
  caseId: CaseId;
  paths: RunPaths;
  records: RedactionRecord[];
  sensitiveLiterals: string[];
  diagnostic: DiagnosticMetadata;
  diagnosticRecord: RedactionRecord;
}

function artifactRef(paths: RunPaths, absolutePath: string): string {
  return relative(paths.run_root, absolutePath).split(sep).join("/");
}

async function auditPair(
  options: EvaluateG2sOptions,
  record: RedactionRecord,
): Promise<{ audit: G2sPairAudit; issues: string[] }> {
  const issues: string[] = [];
  const rawRef = artifactRef(options.paths, record.raw_artifact_ref);
  const redactedRef = artifactRef(options.paths, record.redacted_artifact_ref);
  let raw = "";
  let redacted = "";
  let rawRead = false;
  let redactedRead = false;
  let projectionVerified = false;

  try {
    await assertRealDescendant(options.paths.raw_artifacts, record.raw_artifact_ref);
    const metadata = await lstat(record.raw_artifact_ref);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      issues.push(`${record.source_id}: raw artifact is not a regular file`);
    }
    if ((metadata.mode & 0o777) !== 0o600) {
      issues.push(`${record.source_id}: raw artifact mode is not 0600`);
    }
    raw = await readFile(record.raw_artifact_ref, "utf8");
    rawRead = true;
  } catch (error) {
    issues.push(
      `${record.source_id}: raw artifact unavailable (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  try {
    await assertRealDescendant(options.paths.review_artifacts, record.redacted_artifact_ref);
    const metadata = await lstat(record.redacted_artifact_ref);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      issues.push(`${record.source_id}: review artifact is not a regular file`);
    }
    redacted = await readFile(record.redacted_artifact_ref, "utf8");
    redactedRead = true;
  } catch (error) {
    issues.push(
      `${record.source_id}: review artifact unavailable (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  if (rawRead && redactedRead) {
    const expected = redactText(raw, options.sensitiveLiterals);
    projectionVerified = verifyRedactionProjection(raw, redacted, options.sensitiveLiterals);
    if (sha256(raw) !== record.raw_sha256) {
      issues.push(`${record.source_id}: raw hash does not match the collect record`);
    }
    if (sha256(redacted) !== record.redacted_sha256) {
      issues.push(`${record.source_id}: redacted hash does not match the collect record`);
    }
    if (JSON.stringify(expected.replacements) !== JSON.stringify(record.replacements)) {
      issues.push(`${record.source_id}: literal scan result does not match the projection`);
    }
    if (!projectionVerified || !record.non_sensitive_bytes_preserved) {
      issues.push(`${record.source_id}: non-sensitive evidence changed or disappeared`);
    }
    if (containsSensitiveLiteral(redacted, options.sensitiveLiterals)) {
      issues.push(`${record.source_id}: sensitive text reached the review artifact`);
    }
  }

  return {
    audit: {
      source_id: record.source_id,
      raw_artifact_ref: rawRef,
      raw_sha256: record.raw_sha256,
      redacted_artifact_ref: redactedRef,
      redacted_sha256: record.redacted_sha256,
      replacement_count: record.replacements.reduce(
        (sum, replacement) => sum + replacement.count,
        0,
      ),
      projection_verified: projectionVerified,
    },
    issues,
  };
}

export async function evaluateG2s(options: EvaluateG2sOptions): Promise<GateResult | undefined> {
  if (options.caseId !== "C2" && options.caseId !== "C3") return undefined;

  const issues: string[] = [];
  const duplicateSources = options.records
    .map((record) => record.source_id)
    .filter((source, index, values) => values.indexOf(source) !== index);
  if (duplicateSources.length > 0) {
    issues.push(`duplicate source ids: ${[...new Set(duplicateSources)].join(",")}`);
  }
  if (
    !options.records.some(
      (record) =>
        record.source_id === options.diagnosticRecord.source_id &&
        record.raw_sha256 === options.diagnosticRecord.raw_sha256 &&
        record.redacted_sha256 === options.diagnosticRecord.redacted_sha256,
    )
  ) {
    issues.push("diagnostic pair is absent from the collect record set");
  }

  const pairs: G2sPairAudit[] = [];
  for (const record of options.records) {
    const pair = await auditPair(options, record);
    pairs.push(pair.audit);
    issues.push(...pair.issues);
  }

  const diagnosticPair = pairs.find(
    (pair) => pair.source_id === options.diagnosticRecord.source_id,
  );
  if (!diagnosticPair) issues.push("diagnostic raw/review pair cannot be traced to one collect");
  const diagnosticReview = await readFile(options.diagnosticRecord.redacted_artifact_ref, "utf8")
    .then((raw) => JSON.parse(raw) as Record<string, unknown>)
    .catch(() => undefined);
  for (const field of ["call_path", "exit_code", "signal", "stderr_empty"] as const) {
    if (!diagnosticReview || diagnosticReview[field] !== options.diagnostic[field]) {
      issues.push(`diagnostic field was hidden or changed: ${field}`);
    }
  }

  const audit: G2sAudit = {
    schema_version: "resident-self-repair-g2s-audit.v0",
    case_id: options.caseId,
    status: issues.length === 0 ? "pass" : "fail",
    issues,
    diagnostic_fields: {
      call_path: options.diagnostic.call_path,
      exit_code: options.diagnostic.exit_code,
      signal: options.diagnostic.signal,
      stderr_empty: options.diagnostic.stderr_empty,
    },
    pairs,
  };
  const auditPath = join(options.paths.review_artifacts, "g2s-audit.json");
  await writeFile(auditPath, `${JSON.stringify(audit, null, 2)}\n`, "utf8");

  const refs = [
    artifactRef(options.paths, auditPath),
    ...(diagnosticPair
      ? [diagnosticPair.raw_artifact_ref, diagnosticPair.redacted_artifact_ref]
      : []),
  ];
  return issues.length === 0
    ? {
        status: "pass",
        rationale: `Controlled redaction chain verified for ${pairs.length} same-collect raw/review pairs; literal scan results were retained (including zero-match scans), non-sensitive evidence was preserved, and call path/exit code/signal/stderr-empty stayed visible.`,
        evidence_refs: refs,
      }
    : {
        status: "fail",
        rationale: `Controlled redaction chain failed: ${issues.join("; ")}.`,
        evidence_refs: refs,
      };
}
