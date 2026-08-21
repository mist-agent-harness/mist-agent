/**
 * PV0 acceptance suite — series F: readiness 与稳定失败语义 (RFC §4/§8)
 *
 * Doctrine (#76, 旦九 2026-08-20 ruling): PV0 runs as an independent Vitest suite,
 * NOT inside the six-lights acceptance driver. The readiness slice is now backed by
 * external-evidence fixtures; unrelated F04/F05 and mutation accounting remain todo.
 *
 * Item source of truth: acceptance/plugin-protocol-v0.md at the #62 freeze point
 * (main@acdfcab2); these tests intentionally name only the implemented narrow slice, not a
 * completed F01/F02/F06 checklist item.
 * Awaits: readiness lamps + reason-code wiring (spans PR①-③).
 */
import { describe, expect, it } from "vitest";
import {
  type ReadinessEvaluationInput,
  type RuntimeEvidence,
  evaluateRuntimeReadiness,
} from "../../src/plugin/runtime-readiness.ts";

const scope = {
  residentId: "pv0-resident",
  lane: "primary",
  operations: ["call"],
  host: "pv0-host",
  networkPath: "loopback:19001/call",
  version: "1.0.0",
} as const;
const definition = {
  pluginId: "pv0.fixture",
  capabilityId: "pv0.call",
  version: scope.version,
  moduleRef: "sha256:pv0",
} as const;
const binding = {
  pluginId: definition.pluginId,
  capabilityId: definition.capabilityId,
  version: definition.version,
  moduleRef: definition.moduleRef,
  host: scope.host,
  networkPath: scope.networkPath,
} as const;
const authorization = {
  residentId: scope.residentId,
  lane: scope.lane,
  operations: [...scope.operations],
} as const;
function probe(
  kind: RuntimeEvidence["kind"],
  outcome: RuntimeEvidence["outcome"] = "pass",
): RuntimeEvidence {
  return {
    kind,
    source: "external",
    probeId: `pv0-${kind}`,
    observedAt: "2026-08-21T00:00:00.000Z",
    scope,
    version: scope.version,
    moduleRef: definition.moduleRef,
    outcome,
    conditions: { endpoint: scope.networkPath },
  };
}
function request(overrides: Partial<ReadinessEvaluationInput> = {}): ReadinessEvaluationInput {
  return {
    definition,
    binding,
    authorization,
    scope,
    evidence: [probe("existence"), probe("running"), probe("readback")],
    now: "2026-08-21T00:00:01.000Z",
    maxAgeMs: 60_000,
    ...overrides,
  };
}

describe("PV0 series F — readiness 与稳定失败语义 (RFC §4/§8)", () => {
  it("readiness narrow slice preserves scope (not the full PV0-F01 checklist)", () => {
    const receipt = evaluateRuntimeReadiness(request());
    expect(receipt.status).toBe("ready");
    expect(receipt.verifiedScope).toEqual(scope);
    expect(receipt.lastVerifiedAt).toBe("2026-08-21T00:00:00.000Z");
  });
  it("narrow slice keeps CAPABILITY_UNVERIFIED stable (not the full PV0-F02 A–E matrix)", () => {
    const receipt = evaluateRuntimeReadiness(request({ evidence: [probe("existence")] }));
    expect(receipt.status).toBe("unknown");
    expect(receipt.reasonCode).toBe("CAPABILITY_UNVERIFIED");
  });
  it.todo("[PV0-F03] 每条约束都有指定红格 — mutation accounting remains pending");
  it.todo(
    "[PV0-F04] boot-time 不变量不可卸载 — STUBBED-PENDING(readiness lamps + capability receipts — 单B 范围外)",
  );
  it.todo(
    "[PV0-F05] 壳共享魂私有 — STUBBED-PENDING(readiness lamps + capability receipts — 单B 范围外)",
  );
  it("narrow slice requires a current readback receipt (not the full PV0-F06 provider matrix)", () => {
    const missingReadback = evaluateRuntimeReadiness(
      request({ evidence: [probe("existence"), probe("running")] }),
    );
    expect(missingReadback.status).toBe("unknown");
    expect(missingReadback.reasonCode).toBe("CAPABILITY_UNVERIFIED");

    const wrongPath = evaluateRuntimeReadiness(
      request({
        evidence: [probe("existence"), probe("running"), probe("readback", "fail")],
      }),
    );
    expect(wrongPath.status).toBe("blocked");
    expect(wrongPath.reasonCode).toBe("PLUGIN_RUNTIME_FAILED");
  });
});
