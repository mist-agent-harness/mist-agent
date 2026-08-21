import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { moduleRefFromSource } from "../src/plugin/module-ref.ts";
import { PluginOperationStore } from "../src/plugin/operation-store.ts";
import {
  type ReadinessAuthorization,
  type ReadinessDefinition,
  type ReadinessEvaluationInput,
  type ReadinessScope,
  type RuntimeEvidence,
  evaluateRuntimeReadiness,
  isReadinessReceipt,
  projectReadiness,
  readRuntimeReadiness,
} from "../src/plugin/runtime-readiness.ts";
import { PluginTransactionHost } from "../src/plugin/transaction-host.ts";
import type { PluginModuleV0 } from "../src/plugin/types.ts";

const definition: ReadinessDefinition = {
  pluginId: "fixture.tool",
  capabilityId: "fixture.call",
  version: "1.2.3",
  moduleRef: "sha256:module-v1",
};
const scope: ReadinessScope = {
  residentId: "resident-a",
  lane: "primary",
  operations: ["call"],
  host: "host-a",
  networkPath: "loopback:19001/call",
  version: definition.version,
};
const binding = {
  pluginId: definition.pluginId,
  capabilityId: definition.capabilityId,
  version: definition.version,
  moduleRef: definition.moduleRef,
  host: scope.host,
  networkPath: scope.networkPath,
};
const authorization: ReadinessAuthorization = {
  residentId: scope.residentId,
  lane: scope.lane,
  operations: [...scope.operations],
};

function evidence(
  kind: RuntimeEvidence["kind"],
  outcome: RuntimeEvidence["outcome"] = "pass",
  overrides: Partial<RuntimeEvidence> = {},
): RuntimeEvidence {
  return {
    kind,
    source: "external",
    probeId: `probe-${kind}`,
    observedAt: "2026-08-21T00:00:00.000Z",
    scope,
    version: definition.version,
    moduleRef: definition.moduleRef,
    outcome,
    conditions: { endpoint: scope.networkPath, transport: "loopback" },
    ...overrides,
  };
}

function input(overrides: Partial<ReadinessEvaluationInput> = {}): ReadinessEvaluationInput {
  return {
    definition,
    binding,
    authorization,
    scope,
    now: "2026-08-21T00:00:01.000Z",
    maxAgeMs: 60_000,
    evidence: [evidence("existence"), evidence("running"), evidence("readback")],
    ...overrides,
  };
}

describe("runtime readiness / readback contract", () => {
  it("requires independent existence, running, and scoped readback before ready", () => {
    const receipt = evaluateRuntimeReadiness(input());
    expect(receipt.status).toBe("ready");
    expect(receipt.lastVerifiedAt).toBe("2026-08-21T00:00:00.000Z");
    expect(receipt.verifiedScope).toEqual(scope);
  });

  it("does not turn a present file into ready when no runtime process evidence exists", () => {
    const receipt = evaluateRuntimeReadiness(input({ evidence: [evidence("existence")] }));
    expect(receipt.status).toBe("unknown");
    expect(receipt.reason).toBe("evidence-missing");
    expect(receipt.reasonCode).toBe("CAPABILITY_UNVERIFIED");
  });

  it("does not trust a green health response when the real operation path is unreachable", () => {
    const receipt = evaluateRuntimeReadiness(
      input({
        evidence: [
          evidence("existence"),
          evidence("running"),
          evidence("readback", "fail", {
            detail: "health=200 but /call cannot be reached",
            conditions: { endpoint: "loopback:19001/call", transport: "loopback", health: 200 },
          }),
        ],
      }),
    );
    expect(receipt.status).toBe("blocked");
    expect(receipt.reason).toBe("readback-failed");
    expect(receipt.reasonCode).toBe("PLUGIN_RUNTIME_FAILED");
  });

  it("keeps repository/deployment/runtime version disagreement unknown", () => {
    const receipt = evaluateRuntimeReadiness(
      input({
        evidence: [
          evidence("existence"),
          evidence("running"),
          evidence("readback", "pass", { version: "1.2.4" }),
        ],
      }),
    );
    expect(receipt.status).toBe("unknown");
    expect(receipt.reason).toBe("scope-mismatch");
    expect(receipt.reasonCode).toBe("CAPABILITY_UNVERIFIED");
  });

  it("keeps a different host or network scope unknown", () => {
    const otherScope = { ...scope, networkPath: "tcp:203.0.113.10:19001/call" };
    const receipt = evaluateRuntimeReadiness(
      input({
        scope: otherScope,
        evidence: [evidence("existence"), evidence("running"), evidence("readback")],
      }),
    );
    expect(receipt.status).toBe("unknown");
    expect(receipt.reason).toBe("scope-mismatch");
  });

  it("does not reuse evidence from another resident, lane, or operation", () => {
    const otherResident = evaluateRuntimeReadiness(
      input({
        evidence: [
          evidence("existence"),
          evidence("running"),
          evidence("readback", "pass", {
            scope: { ...scope, residentId: "resident-b" },
          }),
        ],
      }),
    );
    expect(otherResident.status).toBe("unknown");
    expect(otherResident.reason).toBe("scope-mismatch");

    const otherLane = evaluateRuntimeReadiness(
      input({
        evidence: [
          evidence("existence"),
          evidence("running"),
          evidence("readback", "pass", {
            scope: { ...scope, lane: "coding" },
          }),
        ],
      }),
    );
    expect(otherLane.status).toBe("unknown");
    expect(otherLane.reason).toBe("scope-mismatch");

    const missingOperation = evaluateRuntimeReadiness(
      input({
        scope: { ...scope, operations: ["call", "stream"] },
        authorization: { ...authorization, operations: ["call", "stream"] },
        evidence: [
          evidence("existence"),
          evidence("running"),
          evidence("readback", "pass", { scope: { ...scope, operations: ["call"] } }),
        ],
      }),
    );
    expect(missingOperation.status).toBe("unknown");
    expect(missingOperation.reason).toBe("evidence-missing");
  });

  it("does not use self-reported evidence", () => {
    const receipt = evaluateRuntimeReadiness(
      input({
        evidence: [
          evidence("existence"),
          evidence("running"),
          evidence("readback", "pass", { source: "self" }),
        ],
      }),
    );
    expect(receipt.status).toBe("unknown");
    expect(receipt.reasonCode).toBe("CAPABILITY_UNVERIFIED");
  });

  it("binds conditions and measurements to the same evidence row", () => {
    const receipt = evaluateRuntimeReadiness(
      input({
        expectedConditions: { endpoint: scope.networkPath, transport: "loopback" },
        evidence: [
          evidence("existence", "pass", { measurements: { latencyMs: 2 } }),
          evidence("running"),
          evidence("readback", "pass", {
            conditions: { endpoint: "wrong-path", transport: "loopback" },
          }),
        ],
      }),
    );
    expect(receipt.status).toBe("unknown");
    expect(receipt.reason).toBe("condition-mismatch");
  });

  it("returns unknown for stale evidence instead of guessing current readiness", () => {
    const receipt = evaluateRuntimeReadiness(
      input({ now: "2026-08-21T00:02:00.000Z", maxAgeMs: 60_000 }),
    );
    expect(receipt.status).toBe("unknown");
    expect(receipt.reason).toBe("evidence-stale");
  });

  it("does not create an unbounded ready receipt when maxAgeMs is omitted", () => {
    const withoutWindow = input();
    Reflect.deleteProperty(withoutWindow, "maxAgeMs");
    const receipt = evaluateRuntimeReadiness(withoutWindow);
    expect(receipt.status).toBe("unknown");
    expect(receipt.reason).toBe("evidence-stale");
    expect(receipt.lastVerifiedAt).toBeNull();
    expect(receipt.verificationWindowMs).toBeNull();
  });

  it("parses a legacy ready receipt but never projects it without a persisted window", () => {
    const receipt = evaluateRuntimeReadiness(input());
    const legacyReceipt = { ...receipt };
    Reflect.deleteProperty(legacyReceipt, "verificationWindowMs");
    expect(isReadinessReceipt(legacyReceipt)).toBe(true);
    expect(projectReadiness("active", legacyReceipt, "2026-08-21T00:00:30.000Z")).toMatchObject({
      status: "unknown",
      reasonCode: "CAPABILITY_UNVERIFIED",
    });
  });

  it("rejects evidence legs that reuse one probe identity", () => {
    const receipt = evaluateRuntimeReadiness(
      input({
        evidence: [
          evidence("existence"),
          evidence("running", "pass", { probeId: "probe-existence" }),
          evidence("readback"),
        ],
      }),
    );
    expect(receipt.status).toBe("unknown");
    expect(receipt.reason).toBe("evidence-not-independent");
    expect(receipt.reasonCode).toBe("CAPABILITY_UNVERIFIED");
  });

  it("does not accept an unknown receipt with a successful-verification timestamp", () => {
    const receipt = evaluateRuntimeReadiness(input({ evidence: [evidence("existence")] }));
    expect(receipt.lastVerifiedAt).toBeNull();
    expect(
      isReadinessReceipt({
        ...receipt,
        lastVerifiedAt: "2026-08-21T00:00:00.000Z",
      }),
    ).toBe(false);
  });

  it("exposes probe failures as unknown when the independent observer cannot answer", async () => {
    const receipt = await readRuntimeReadiness(input(), {
      existence: async () => evidence("existence"),
      running: async () => evidence("running"),
      readback: async () => {
        throw new Error("observer unavailable");
      },
    });
    expect(receipt.status).toBe("unknown");
    expect(receipt.reason).toBe("evidence-missing");
  });

  it("does not project an active lifecycle as ready without a persisted receipt", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mist-runtime-readiness-"));
    try {
      const store = new PluginOperationStore(directory);
      const host = new PluginTransactionHost({ store });
      const module: PluginModuleV0 = {
        async prepare() {
          return {
            async activate() {
              return {
                async dispose() {
                  return { revoked: [], failed: [] };
                },
              };
            },
            async rollback() {},
          };
        },
      };
      await host.activate({
        pluginId: "fixture.unverified",
        moduleRef: moduleRefFromSource("fixture-unverified"),
        module,
        config: { enabled: true },
        env: {},
        bindings: {},
        verifiedScope: null,
      });
      expect(host.readiness("fixture.unverified")).toMatchObject({
        status: "unknown",
        reasonCode: "CAPABILITY_UNVERIFIED",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("projects only the receipt that was produced by the external readback contract", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mist-runtime-readiness-"));
    try {
      const store = new PluginOperationStore(directory);
      const host = new PluginTransactionHost({ store });
      const module: PluginModuleV0 = {
        async prepare(context) {
          context.register({
            id: "fixture-call",
            kind: "tool",
            capabilityId: "fixture.call",
            recoveryKey: "fixture-call-recovery",
            async activate() {},
            async dispose() {},
          });
          return {
            async activate() {
              return {
                async dispose() {
                  return { revoked: [], failed: [] };
                },
              };
            },
            async rollback() {},
          };
        },
      };
      const moduleRef = moduleRefFromSource("fixture-ready");
      const readyDefinition = { ...definition, moduleRef };
      const readyBinding = { ...binding, moduleRef };
      const readyEvidence = [evidence("existence"), evidence("running"), evidence("readback")].map(
        (item) => ({ ...item, moduleRef }),
      );
      const receipt = evaluateRuntimeReadiness(
        input({ definition: readyDefinition, binding: readyBinding, evidence: readyEvidence }),
      );
      await host.activate({
        pluginId: definition.pluginId,
        moduleRef,
        module,
        config: { enabled: true },
        env: {},
        bindings: {},
        verifiedScope: receipt.verifiedScope,
        readiness: receipt,
      });
      expect(host.readiness(definition.pluginId, "2026-08-21T00:00:30.000Z").status).toBe("ready");
      const restartedHost = new PluginTransactionHost({
        store: new PluginOperationStore(directory),
      });
      expect(
        restartedHost.readiness(definition.pluginId, "2026-08-21T00:01:01.000Z"),
      ).toMatchObject({
        status: "unknown",
        reasonCode: "CAPABILITY_UNVERIFIED",
      });
      expect(
        host.recordReadiness(definition.pluginId, receipt, "2026-08-21T00:00:30.000Z").status,
      ).toBe("ready");

      const mismatchedCapability = {
        ...receipt,
        definition: { ...receipt.definition, capabilityId: "fixture.other" },
        binding:
          receipt.binding === null ? null : { ...receipt.binding, capabilityId: "fixture.other" },
      };
      expect(isReadinessReceipt(mismatchedCapability)).toBe(true);
      expect(() => host.recordReadiness(definition.pluginId, mismatchedCapability)).toThrow(
        "runtime readiness receipt does not match the current plugin authority",
      );

      const mismatchedVersion = {
        ...receipt,
        definition: { ...receipt.definition, version: "1.2.4" },
      };
      expect(() => host.recordReadiness(definition.pluginId, mismatchedVersion)).toThrow(
        "runtime readiness receipt does not match the current plugin authority",
      );

      const mismatchedBinding = {
        ...receipt,
        verifiedScope: { ...receipt.verifiedScope, networkPath: "loopback:19002/call" },
        binding:
          receipt.binding === null
            ? null
            : { ...receipt.binding, networkPath: "loopback:19002/call" },
        evidence: receipt.evidence.map((item) => ({
          ...item,
          scope: { ...item.scope, networkPath: "loopback:19002/call" },
        })),
      };
      expect(isReadinessReceipt(mismatchedBinding)).toBe(true);
      expect(() => host.recordReadiness(definition.pluginId, mismatchedBinding)).toThrow(
        "runtime readiness receipt does not match the current plugin authority",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
