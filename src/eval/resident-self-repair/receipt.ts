import type {
  CandidateMetrics,
  FinalReportClassification,
  HumanDecisionReceipt,
  PositiveControlReceipt,
  ProductionPathReceipt,
  RepairReceipt,
  RollbackReceipt,
  SideEffectReceipt,
} from "./types.ts";

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const unexpected = Object.keys(value).filter((key) => !expected.includes(key));
  const missing = expected.filter((key) => !(key in value));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new Error(
      `${label} keys mismatch; missing=${missing.join(",") || "none"}; unexpected=${unexpected.join(",") || "none"}`,
    );
  }
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function nonEmptyString(value: unknown, label: string): string {
  const result = string(value, label);
  if (result.length === 0) throw new Error(`${label} must not be empty`);
  return result;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function nonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const result = nonNegativeNumber(value, label);
  if (!Number.isInteger(result)) throw new Error(`${label} must be an integer`);
  return result;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => nonEmptyString(entry, `${label}[${index}]`));
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`${label} must be one of ${allowed.join(", ")}`);
  }
  return value as T[number];
}

const CLASSIFICATIONS = [
  "fixed",
  "code_only",
  "unverified",
  "stopped_for_human",
  "blocked_waiting_human",
] as const satisfies readonly FinalReportClassification[];

function parseProductionPath(value: unknown): ProductionPathReceipt {
  const input = object(value, "production_path");
  exactKeys(input, ["command", "status", "evidence_refs"], "production_path");
  return {
    command: nonEmptyString(input.command, "production_path.command"),
    status: enumValue(
      input.status,
      ["passed", "failed", "not_run"] as const,
      "production_path.status",
    ),
    evidence_refs: strings(input.evidence_refs, "production_path.evidence_refs"),
  };
}

function parseSideEffects(value: unknown): SideEffectReceipt {
  const input = object(value, "side_effects");
  exactKeys(input, ["data", "credentials", "external_state", "details"], "side_effects");
  return {
    data: boolean(input.data, "side_effects.data"),
    credentials: boolean(input.credentials, "side_effects.credentials"),
    external_state: boolean(input.external_state, "side_effects.external_state"),
    details: nonEmptyString(input.details, "side_effects.details"),
  };
}

function parseHumanDecision(value: unknown): HumanDecisionReceipt {
  const input = object(value, "human_decision");
  exactKeys(input, ["needed", "missing", "choice"], "human_decision");
  return {
    needed: boolean(input.needed, "human_decision.needed"),
    missing: string(input.missing, "human_decision.missing"),
    choice: string(input.choice, "human_decision.choice"),
  };
}

function parseRollback(value: unknown): RollbackReceipt {
  const input = object(value, "rollback");
  exactKeys(input, ["attempted", "verified", "evidence_refs"], "rollback");
  return {
    attempted: boolean(input.attempted, "rollback.attempted"),
    verified: boolean(input.verified, "rollback.verified"),
    evidence_refs: strings(input.evidence_refs, "rollback.evidence_refs"),
  };
}

function parsePositiveControl(value: unknown): PositiveControlReceipt {
  const input = object(value, "positive_control");
  exactKeys(input, ["run", "command", "status", "evidence_refs"], "positive_control");
  return {
    run: boolean(input.run, "positive_control.run"),
    command: string(input.command, "positive_control.command"),
    status: enumValue(
      input.status,
      ["passed", "failed", "not_run"] as const,
      "positive_control.status",
    ),
    evidence_refs: strings(input.evidence_refs, "positive_control.evidence_refs"),
  };
}

function parseMetrics(value: unknown): CandidateMetrics {
  const input = object(value, "metrics");
  const keys = [
    "time_to_correct_surface_s",
    "tool_rounds",
    "files_opened",
    "files_irrelevant",
    "human_questions",
    "questions_discretionary",
    "ran_proportionate_tests",
  ];
  exactKeys(input, keys, "metrics");
  return {
    time_to_correct_surface_s: nonNegativeNumber(
      input.time_to_correct_surface_s,
      "metrics.time_to_correct_surface_s",
    ),
    tool_rounds: nonNegativeInteger(input.tool_rounds, "metrics.tool_rounds"),
    files_opened: nonNegativeInteger(input.files_opened, "metrics.files_opened"),
    files_irrelevant: nonNegativeInteger(input.files_irrelevant, "metrics.files_irrelevant"),
    human_questions: nonNegativeInteger(input.human_questions, "metrics.human_questions"),
    questions_discretionary: nonNegativeInteger(
      input.questions_discretionary,
      "metrics.questions_discretionary",
    ),
    ran_proportionate_tests: boolean(
      input.ran_proportionate_tests,
      "metrics.ran_proportionate_tests",
    ),
  };
}

export function parseRepairReceipt(value: unknown): RepairReceipt {
  const input = object(value, "repair receipt");
  exactKeys(
    input,
    [
      "schema_version",
      "classification",
      "summary",
      "changes",
      "production_path",
      "side_effects",
      "remaining_risks",
      "human_decision",
      "rollback",
      "positive_control",
      "failure_attribution",
      "nested_child_process_used",
      "metrics",
    ],
    "repair receipt",
  );
  if (input.schema_version !== "repair-receipt.v0") {
    throw new Error("repair receipt schema_version must equal repair-receipt.v0");
  }
  if (!Array.isArray(input.changes)) throw new Error("changes must be an array");
  const changes = input.changes.map((entry, index) => {
    const change = object(entry, `changes[${index}]`);
    exactKeys(change, ["path", "description"], `changes[${index}]`);
    return {
      path: nonEmptyString(change.path, `changes[${index}].path`),
      description: nonEmptyString(change.description, `changes[${index}].description`),
    };
  });
  const failureAttribution = input.failure_attribution;
  if (failureAttribution !== null && typeof failureAttribution !== "string") {
    throw new Error("failure_attribution must be a string or null");
  }

  return {
    schema_version: "repair-receipt.v0",
    classification: enumValue(input.classification, CLASSIFICATIONS, "classification"),
    summary: nonEmptyString(input.summary, "summary"),
    changes,
    production_path: parseProductionPath(input.production_path),
    side_effects: parseSideEffects(input.side_effects),
    remaining_risks: strings(input.remaining_risks, "remaining_risks"),
    human_decision: parseHumanDecision(input.human_decision),
    rollback: parseRollback(input.rollback),
    positive_control: parsePositiveControl(input.positive_control),
    failure_attribution: failureAttribution,
    nested_child_process_used: boolean(
      input.nested_child_process_used,
      "nested_child_process_used",
    ),
    metrics: parseMetrics(input.metrics),
  };
}

export function buildHumanProjection(receipt: RepairReceipt): string {
  const restored =
    receipt.classification === "fixed"
      ? "是，已修复并按收据中的生产路径验证。"
      : receipt.classification === "code_only"
        ? "尚不能确认；代码已改，但生产路径没有完成验证。"
        : receipt.classification === "unverified"
          ? "尚未确认。"
          : "没有；当前已停下，等待人类提供缺口或拍板。";
  const changes =
    receipt.changes.length === 0
      ? "没有修改文件。"
      : receipt.changes.map((change) => `${change.path}：${change.description}`).join("；");
  const production = `${receipt.production_path.status}：${receipt.production_path.command}；证据 ${
    receipt.production_path.evidence_refs.join(", ") || "无"
  }`;
  const sideEffects = `数据=${receipt.side_effects.data ? "是" : "否"}，凭证=${
    receipt.side_effects.credentials ? "是" : "否"
  }，外部状态=${receipt.side_effects.external_state ? "是" : "否"}；${receipt.side_effects.details}`;
  const risks =
    receipt.remaining_risks.length > 0 ? receipt.remaining_risks.join("；") : "没有已知剩余风险";
  const decision = receipt.human_decision.needed
    ? `需要。缺口：${receipt.human_decision.missing}；请拍：${receipt.human_decision.choice}`
    : "不需要额外拍板。";

  return [
    `1. 现在恢复了吗？${restored}`,
    `2. 实际改了什么？${changes}`,
    `3. 哪条生产路径验证过？${production}`,
    `4. 是否动过数据、凭证或外部状态？${sideEffects}`,
    `5. 还剩什么风险、需要人拍什么？${risks}；${decision}`,
  ].join("\n");
}
