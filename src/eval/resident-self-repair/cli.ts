import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { finalizeRun } from "./finalize.ts";
import { type ReviewPair, createBlindReviewPacket, resolveReviews } from "./review.ts";
import { runCandidate } from "./runner.ts";
import type {
  EscalationDispositionRecord,
  PositiveControlReviewRecord,
  ReviewEscalation,
  ReviewGate,
  RunBundle,
  SemanticReviewRecord,
} from "./types.ts";
import { POSITIVE_CONTROL_CLAUSE_ID } from "./types.ts";

interface RunCliOptions {
  fixture: string;
  candidateName: string;
  candidateVersion: string;
  bin: string;
  args: string[];
  timeoutMs?: number;
}

interface FinalizeCliOptions {
  bundle: string;
  reviews: string;
}

interface ReviewInput {
  schema_version: "resident-self-repair-review-input.v1";
  gates: Partial<Record<ReviewGate, ReviewPair<SemanticReviewRecord>>>;
  positive_control?: ReviewPair<PositiveControlReviewRecord>;
  escalation_dispositions?: EscalationDispositionRecord[];
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[],
  label: string,
): void {
  const allowed = [...required, ...optional];
  const missing = required.filter((key) => !(key in value));
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `${label} keys mismatch; missing=${missing.join(",") || "none"}; unexpected=${unexpected.join(",") || "none"}`,
    );
  }
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function strings(value: unknown, label: string, requireNonEmpty = false): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be a string array`);
  }
  if (requireNonEmpty && value.length === 0) throw new Error(`${label} must not be empty`);
  return value as string[];
}

function parseEscalations(value: unknown, label: string): ReviewEscalation[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => {
    const escalation = object(entry, `${label}[${index}]`);
    exactKeys(escalation, ["gate", "text"], [], `${label}[${index}]`);
    if (escalation.gate !== "G4" && escalation.gate !== "G5") {
      throw new Error(`${label}[${index}].gate must equal G4 or G5`);
    }
    return {
      gate: escalation.gate,
      text: nonEmptyString(escalation.text, `${label}[${index}].text`),
    };
  });
}

function parseSemanticReview(value: unknown, label: string): SemanticReviewRecord {
  const input = object(value, label);
  exactKeys(
    input,
    [
      "rubric_version",
      "case_id",
      "gate",
      "status",
      "rationale",
      "evidence_refs",
      "escalations",
      "reviewer_id",
    ],
    [],
    label,
  );
  if (!["C1", "C2", "C3", "C4"].includes(String(input.case_id))) {
    throw new Error(`${label}.case_id is invalid`);
  }
  if (!["G1", "G3", "G4", "G6"].includes(String(input.gate))) {
    throw new Error(`${label}.gate is invalid`);
  }
  if (input.status !== "pass" && input.status !== "fail") {
    throw new Error(`${label}.status must be pass or fail`);
  }
  return {
    rubric_version: nonEmptyString(input.rubric_version, `${label}.rubric_version`),
    case_id: input.case_id as SemanticReviewRecord["case_id"],
    gate: input.gate as ReviewGate,
    status: input.status,
    rationale: nonEmptyString(input.rationale, `${label}.rationale`),
    evidence_refs: strings(input.evidence_refs, `${label}.evidence_refs`, true),
    escalations: parseEscalations(input.escalations, `${label}.escalations`),
    reviewer_id: nonEmptyString(input.reviewer_id, `${label}.reviewer_id`),
  };
}

function parsePositiveControlReview(value: unknown, label: string): PositiveControlReviewRecord {
  const input = object(value, label);
  exactKeys(
    input,
    [
      "rubric_version",
      "case_id",
      "clause_id",
      "status",
      "rationale",
      "evidence_refs",
      "escalations",
      "reviewer_id",
    ],
    [],
    label,
  );
  if (!["C1", "C2", "C3", "C4"].includes(String(input.case_id))) {
    throw new Error(`${label}.case_id is invalid`);
  }
  if (input.clause_id !== POSITIVE_CONTROL_CLAUSE_ID) {
    throw new Error(`${label}.clause_id is invalid`);
  }
  if (input.status !== "pass" && input.status !== "fail") {
    throw new Error(`${label}.status must be pass or fail`);
  }
  return {
    rubric_version: nonEmptyString(input.rubric_version, `${label}.rubric_version`),
    case_id: input.case_id as PositiveControlReviewRecord["case_id"],
    clause_id: POSITIVE_CONTROL_CLAUSE_ID,
    status: input.status,
    rationale: nonEmptyString(input.rationale, `${label}.rationale`),
    evidence_refs: strings(input.evidence_refs, `${label}.evidence_refs`, true),
    escalations: parseEscalations(input.escalations, `${label}.escalations`),
    reviewer_id: nonEmptyString(input.reviewer_id, `${label}.reviewer_id`),
  };
}

function parseEscalationDisposition(value: unknown, label: string): EscalationDispositionRecord {
  const input = object(value, label);
  exactKeys(
    input,
    ["escalation_id", "gate", "outcome", "rationale", "evidence_refs", "acceptance_seat_id"],
    [],
    label,
  );
  if (input.gate !== "G4" && input.gate !== "G5") {
    throw new Error(`${label}.gate must equal G4 or G5`);
  }
  if (input.outcome !== "dismissed" && input.outcome !== "run_invalid") {
    throw new Error(`${label}.outcome must be dismissed or run_invalid`);
  }
  return {
    escalation_id: nonEmptyString(input.escalation_id, `${label}.escalation_id`),
    gate: input.gate,
    outcome: input.outcome,
    rationale: nonEmptyString(input.rationale, `${label}.rationale`),
    evidence_refs: strings(input.evidence_refs, `${label}.evidence_refs`, true),
    acceptance_seat_id: nonEmptyString(input.acceptance_seat_id, `${label}.acceptance_seat_id`),
  };
}

function parsePair<T>(
  value: unknown,
  label: string,
  parseRecord: (record: unknown, recordLabel: string) => T,
): ReviewPair<T> {
  const input = object(value, label);
  exactKeys(input, ["first", "second"], ["arbitration"], label);
  return {
    first: parseRecord(input.first, `${label}.first`),
    second: parseRecord(input.second, `${label}.second`),
    ...(input.arbitration === undefined
      ? {}
      : { arbitration: parseRecord(input.arbitration, `${label}.arbitration`) }),
  };
}

function usage(): never {
  throw new Error(
    "Usage:\n  npm run eval:resident-self-repair -- run --fixture <dir> --candidate-name <name> --candidate-version <version> --bin <executable> [--arg <arg> ...] [--timeout-ms <ms>]\n  npm run eval:resident-self-repair -- finalize --bundle <run-bundle.json> --reviews <review-input.json>",
  );
}

function takeValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function parseRunArgs(argv: string[]): RunCliOptions {
  if (argv[0] !== "run") usage();
  const values = new Map<string, string>();
  const args: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag) continue;
    if (flag === "--arg") {
      args.push(takeValue(argv, index, flag));
      index += 1;
      continue;
    }
    if (
      flag === "--fixture" ||
      flag === "--candidate-name" ||
      flag === "--candidate-version" ||
      flag === "--bin" ||
      flag === "--timeout-ms"
    ) {
      if (values.has(flag)) throw new Error(`Duplicate argument: ${flag}`);
      values.set(flag, takeValue(argv, index, flag));
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${flag}`);
  }
  const fixture = values.get("--fixture");
  const candidateName = values.get("--candidate-name");
  const candidateVersion = values.get("--candidate-version");
  const bin = values.get("--bin");
  if (!fixture || !candidateName || !candidateVersion || !bin) usage();
  const timeoutRaw = values.get("--timeout-ms");
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : undefined;
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
    throw new Error("--timeout-ms must be a positive integer");
  }
  return {
    fixture,
    candidateName,
    candidateVersion,
    bin,
    args,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

function parseFinalizeArgs(argv: string[]): FinalizeCliOptions {
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== "--bundle" && flag !== "--reviews") {
      throw new Error(`Unknown finalize argument: ${flag ?? "<empty>"}`);
    }
    if (values.has(flag)) throw new Error(`Duplicate finalize argument: ${flag}`);
    values.set(flag, takeValue(argv, index, flag));
    index += 1;
  }
  const bundle = values.get("--bundle");
  const reviews = values.get("--reviews");
  if (!bundle || !reviews) usage();
  return { bundle, reviews };
}

function parseReviewInput(value: unknown): ReviewInput {
  const input = object(value, "review input");
  exactKeys(
    input,
    ["schema_version", "gates"],
    ["positive_control", "escalation_dispositions"],
    "review input",
  );
  if (input.schema_version !== "resident-self-repair-review-input.v1") {
    throw new Error("review input schema_version must equal resident-self-repair-review-input.v1");
  }
  const rawGates = object(input.gates, "review input gates");
  const allowedGates: ReviewGate[] = ["G1", "G3", "G4", "G6"];
  const unknownGates = Object.keys(rawGates).filter(
    (gate) => !allowedGates.includes(gate as ReviewGate),
  );
  if (unknownGates.length > 0) {
    throw new Error(`review input contains unknown gates: ${unknownGates.join(",")}`);
  }
  const gates: ReviewInput["gates"] = {};
  for (const gate of allowedGates) {
    if (rawGates[gate] !== undefined) {
      gates[gate] = parsePair(rawGates[gate], `gates.${gate}`, parseSemanticReview);
    }
  }
  return {
    schema_version: "resident-self-repair-review-input.v1",
    gates,
    ...(input.positive_control === undefined
      ? {}
      : {
          positive_control: parsePair(
            input.positive_control,
            "positive_control",
            parsePositiveControlReview,
          ),
        }),
    ...(input.escalation_dispositions === undefined
      ? {}
      : {
          escalation_dispositions: (() => {
            if (!Array.isArray(input.escalation_dispositions)) {
              throw new Error("escalation_dispositions must be an array");
            }
            return input.escalation_dispositions.map((entry, index) =>
              parseEscalationDisposition(entry, `escalation_dispositions[${index}]`),
            );
          })(),
        }),
  };
}

async function runCommand(argv: string[]): Promise<void> {
  const options = parseRunArgs(argv);
  const bundle = await runCandidate({
    fixtureRoot: resolve(options.fixture),
    candidate: { name: options.candidateName, version: options.candidateVersion },
    command: { bin: options.bin, args: options.args },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  const rawBundlePath = join(bundle.paths.raw_artifacts, "run-bundle.json");
  const reviewPacketPath = join(bundle.paths.review_artifacts, "blind-review-packet.json");
  await writeFile(rawBundlePath, `${JSON.stringify(bundle, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await writeFile(
    reviewPacketPath,
    `${JSON.stringify(createBlindReviewPacket(bundle), null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        run_id: bundle.run_id,
        case_id: bundle.case_id,
        run_root: bundle.paths.run_root,
        raw_bundle: rawBundlePath,
        blind_review_packet: reviewPacketPath,
        status: "awaiting_blind_review",
      },
      null,
      2,
    )}\n`,
  );
}

async function finalizeCommand(argv: string[]): Promise<void> {
  const options = parseFinalizeArgs(argv);
  const bundle = JSON.parse(await readFile(resolve(options.bundle), "utf8")) as RunBundle;
  const reviewInput = parseReviewInput(
    JSON.parse(await readFile(resolve(options.reviews), "utf8")),
  );
  const resolution = resolveReviews({
    bundle,
    gates: reviewInput.gates,
    ...(reviewInput.positive_control === undefined
      ? {}
      : { positiveControl: reviewInput.positive_control }),
    ...(reviewInput.escalation_dispositions === undefined
      ? {}
      : { escalationDispositions: reviewInput.escalation_dispositions }),
  });
  const result = await finalizeRun(bundle, resolution);
  process.stdout.write(
    `${JSON.stringify(
      {
        run_id: result.run_id,
        case_id: result.case_id,
        verdict: result.verdict,
        result: join(bundle.paths.artifacts, "result.json"),
        status: "finalized",
      },
      null,
      2,
    )}\n`,
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "run") return await runCommand(argv);
  if (argv[0] === "finalize") return await finalizeCommand(argv);
  usage();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
