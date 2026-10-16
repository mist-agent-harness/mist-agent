import type { TurnUsage } from "./channels.ts";

export const USAGE_FIELDS = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "totalTokens",
  "costTotal",
] as const;

/** Usage 写入边界只接受已声明字段中的合法数值。 */
export function normalizeTurnUsage(value: unknown): TurnUsage | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const usage: { -readonly [K in keyof TurnUsage]?: TurnUsage[K] } = {};
  for (const field of USAGE_FIELDS) {
    const number = raw[field];
    if (
      typeof number === "number" &&
      number >= 0 &&
      (field === "costTotal" ? Number.isFinite(number) : Number.isSafeInteger(number))
    )
      usage[field] = number;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}
