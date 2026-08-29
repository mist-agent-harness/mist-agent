import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import type { EvaluationResult } from "./types.ts";

const CONTRACT_URL = new URL(
  "../../../docs/design/resident-self-repair-eval-v0.md",
  import.meta.url,
);
const RUBRIC_URL = new URL("../../../docs/eval/rubric-v0.1.1.md", import.meta.url);
const SCHEMA_HEADING = "## 附录 A：结果 JSON Schema（Draft 2020-12）";

export class FrozenSchemaError extends Error {
  readonly errors: ErrorObject[];

  constructor(message: string, errors: ErrorObject[] = []) {
    super(message);
    this.name = "FrozenSchemaError";
    this.errors = errors;
  }
}

export async function loadFrozenResultSchema(): Promise<Record<string, unknown>> {
  const contract = await readFile(fileURLToPath(CONTRACT_URL), "utf8");
  const headingIndex = contract.indexOf(SCHEMA_HEADING);
  if (headingIndex < 0) {
    throw new FrozenSchemaError(`Frozen schema heading not found: ${SCHEMA_HEADING}`);
  }

  const fencedStart = contract.indexOf("```json", headingIndex);
  const jsonStart = fencedStart < 0 ? -1 : contract.indexOf("\n", fencedStart) + 1;
  const fencedEnd = jsonStart <= 0 ? -1 : contract.indexOf("\n```", jsonStart);
  if (fencedStart < 0 || jsonStart <= 0 || fencedEnd < 0) {
    throw new FrozenSchemaError("Frozen schema JSON fence is incomplete");
  }

  try {
    return JSON.parse(contract.slice(jsonStart, fencedEnd)) as Record<string, unknown>;
  } catch (error) {
    throw new FrozenSchemaError(
      `Frozen schema is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function loadRubricVersion(): Promise<string> {
  const rubric = await readFile(fileURLToPath(RUBRIC_URL), "utf8");
  const match = rubric.match(/`rubric_version`:\s*\*\*`([^`]+)`\*\*/u);
  if (!match?.[1]) {
    throw new FrozenSchemaError("Current rubric_version literal was not found");
  }
  return match[1];
}

export async function compileFrozenResultValidator(): Promise<ValidateFunction<EvaluationResult>> {
  const schema = await loadFrozenResultSchema();
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  return ajv.compile<EvaluationResult>(schema);
}

export async function validateFrozenResult(result: unknown): Promise<EvaluationResult> {
  const validate = await compileFrozenResultValidator();
  if (!validate(result)) {
    throw new FrozenSchemaError(
      `Result violates the frozen v0 schema: ${JSON.stringify(validate.errors)}`,
      validate.errors ?? [],
    );
  }
  return result;
}
