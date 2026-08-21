import { createHash } from "node:crypto";

/**
 * Content-addressed plugin module reference.
 *
 * The algorithm is part of the stored value so a future host can distinguish
 * "unsupported old digest" from "same algorithm, different module" instead of
 * silently verifying old bytes with a new rule.
 */
export function moduleRefFromSource(source: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(source).digest("hex")}`;
}

export function isSelfDescribingModuleRef(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*:[0-9a-f]+$/.test(value);
}
