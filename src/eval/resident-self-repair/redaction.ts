import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { sha256 } from "./hash-tree.ts";
import type { RedactionRecord } from "./types.ts";

const GENERIC_SECRET_PATTERNS = [
  /(\bBearer\s+)((?!\[REDACTED_)[A-Za-z0-9._~+\/-]+=*)/gu,
  /(\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*)((?!\[REDACTED_)[^\s"']+)/giu,
] as const;

export interface RedactionOutput {
  value: string;
  replacements: RedactionRecord["replacements"];
}

function replaceLiteral(
  input: string,
  literal: string,
  replacement: string,
): { value: string; count: number } {
  if (literal.length === 0) return { value: input, count: 0 };
  const chunks = input.split(literal);
  return { value: chunks.join(replacement), count: chunks.length - 1 };
}

export function redactText(input: string, sensitiveLiterals: string[]): RedactionOutput {
  let value = input;
  const replacements: RedactionRecord["replacements"] = [];
  for (const [index, literal] of [...new Set(sensitiveLiterals)].entries()) {
    const replacement = `[REDACTED_LITERAL_${index + 1}]`;
    const replaced = replaceLiteral(value, literal, replacement);
    value = replaced.value;
    if (replaced.count > 0) {
      replacements.push({
        literal_sha256: sha256(literal),
        replacement,
        count: replaced.count,
      });
    }
  }

  for (const [index, pattern] of GENERIC_SECRET_PATTERNS.entries()) {
    let count = 0;
    const replacement = `[REDACTED_PATTERN_${index + 1}]`;
    value = value.replace(pattern, (_match, prefix: string) => {
      count += 1;
      return `${prefix}${replacement}`;
    });
    if (count > 0) {
      replacements.push({
        literal_sha256: sha256(pattern.source),
        replacement,
        count,
      });
    }
  }
  return { value, replacements };
}

export function verifyRedactionProjection(
  raw: string,
  redacted: string,
  sensitiveLiterals: string[],
): boolean {
  const recomputed = redactText(raw, sensitiveLiterals).value;
  return recomputed === redacted && !containsSensitiveLiteral(redacted, sensitiveLiterals);
}

export async function persistRawAndRedactedArtifact(options: {
  sourceId: string;
  filename: string;
  raw: string;
  sensitiveLiterals: string[];
  rawDirectory: string;
  reviewDirectory: string;
}): Promise<{ record: RedactionRecord; redacted: string }> {
  await Promise.all([
    mkdir(options.rawDirectory, { recursive: true, mode: 0o700 }),
    mkdir(options.reviewDirectory, { recursive: true, mode: 0o755 }),
  ]);
  const safeName = basename(options.filename);
  const rawPath = join(options.rawDirectory, safeName);
  const reviewPath = join(options.reviewDirectory, safeName);
  const redaction = redactText(options.raw, options.sensitiveLiterals);
  await writeFile(rawPath, options.raw, { encoding: "utf8", mode: 0o600 });
  await writeFile(reviewPath, redaction.value, { encoding: "utf8", mode: 0o644 });
  return {
    redacted: redaction.value,
    record: {
      source_id: options.sourceId,
      raw_artifact_ref: rawPath,
      raw_sha256: sha256(options.raw),
      redacted_artifact_ref: reviewPath,
      redacted_sha256: sha256(redaction.value),
      replacements: redaction.replacements,
      non_sensitive_bytes_preserved: verifyRedactionProjection(
        options.raw,
        redaction.value,
        options.sensitiveLiterals,
      ),
    },
  };
}

export function containsSensitiveLiteral(value: string, sensitiveLiterals: string[]): boolean {
  if (sensitiveLiterals.some((literal) => literal.length > 0 && value.includes(literal))) {
    return true;
  }
  return GENERIC_SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}
