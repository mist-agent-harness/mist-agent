import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyEnabledChange } from "../src/plugin/enable.ts";
import type { PluginManifestV0 } from "../src/plugin/manifest.ts";
import { moduleRefFromSource } from "../src/plugin/module-ref.ts";
import { PluginOperationStore } from "../src/plugin/operation-store.ts";
import {
  type ReadinessAuthorization,
  type ReadinessDefinition,
  type ReadinessEvaluationInput,
  type ReadinessScope,
  type RuntimeEvidence,
  type RuntimeReadinessRequest,
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

function probeRequest(overrides: Partial<ReadinessEvaluationInput> = {}): RuntimeReadinessRequest {
  const readinessInput = input(overrides);
  const probeEvidence = (kind: RuntimeEvidence["kind"]): RuntimeEvidence => ({
    ...evidence(kind),
    scope: readinessInput.scope,
    version: readinessInput.definition.version,
    moduleRef: readinessInput.definition.moduleRef,
  });
  return {
    input: readinessInput,
    probe: {
      existence: async () => probeEvidence("existence"),
      running: async () => probeEvidence("running"),
      readback: async () => probeEvidence("readback"),
    },
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

  it("rejects a forged verification timestamp or replayed evidence outside the window", () => {
    const receipt = evaluateRuntimeReadiness(input());
    expect(
      isReadinessReceipt({
        ...receipt,
        lastVerifiedAt: "2026-08-21T00:00:01.000Z",
      }),
    ).toBe(false);

    const replayedEvidence = {
      ...receipt,
      evidence: receipt.evidence.map((item, index) =>
        index === 0 ? { ...item, observedAt: "2026-08-20T23:00:00.000Z" } : item,
      ),
    };
    expect(isReadinessReceipt(replayedEvidence)).toBe(false);
  });

  it("rejects a ready receipt that carries a failure reason", () => {
    const receipt = evaluateRuntimeReadiness(input());
    expect(isReadinessReceipt({ ...receipt, reasonCode: "PLUGIN_RUNTIME_FAILED" })).toBe(false);
    expect(isReadinessReceipt({ ...receipt, reason: "readback-failed" })).toBe(false);
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
        async prepare(context) {
          context.register({
            id: "fixture-unverified-call",
            kind: "tool",
            capabilityId: "fixture.call",
            recoveryKey: "fixture-unverified-call",
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
      expect(host.publishedResources("fixture.unverified")).toEqual([
        { id: "fixture-unverified-call", kind: "tool", capabilityId: "fixture.call" },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("runs all three probes through applyEnabledChange and fails closed on probe failure", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mist-runtime-readiness-enable-"));
    try {
      const store = new PluginOperationStore(directory);
      const host = new PluginTransactionHost({ store });
      const manifest: PluginManifestV0 = {
        manifestSchemaVersion: 0,
        id: "fixture.enable",
        version: "1.2.3",
        requiresMist: ">=0.1.0",
        entrypoint: "dist/index.js",
        kinds: ["tool_capability"],
        configSchemaVersion: 1,
        capabilities: [
          {
            id: "fixture.call",
            description: "fixture call",
            effect: "read",
            operations: ["call"],
            injectionMode: "eager",
          },
        ],
        contextInjections: [],
        env: [],
        credentials: [],
        permissions: [],
      };
      const moduleRef = moduleRefFromSource("fixture-enable");
      const module: PluginModuleV0 = {
        async prepare(context) {
          context.register({
            id: "fixture-enable-call",
            kind: "tool",
            capabilityId: "fixture.call",
            recoveryKey: "fixture-enable-call",
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
      const baseProbeRequest = probeRequest({
        definition: { ...definition, pluginId: manifest.id, moduleRef },
        binding: { ...binding, pluginId: manifest.id, moduleRef },
      });
      const probeCalls = { existence: 0, running: 0, readback: 0 };
      const readinessRequest: RuntimeReadinessRequest = {
        input: baseProbeRequest.input,
        probe: {
          existence: async (probeScope) => {
            probeCalls.existence += 1;
            return baseProbeRequest.probe.existence(probeScope);
          },
          running: async (probeScope) => {
            probeCalls.running += 1;
            return baseProbeRequest.probe.running(probeScope);
          },
          readback: async (probeScope) => {
            probeCalls.readback += 1;
            return baseProbeRequest.probe.readback(probeScope);
          },
        },
      };
      const request = {
        pluginId: manifest.id,
        manifest,
        module,
        moduleRef,
        config: { enabled: true, settings: {}, environment: [], credentialRefs: {} },
        resolveSecret: () => "unused",
        readinessRequest,
      };
      const directReadyReceipt = await readRuntimeReadiness(
        readinessRequest.input,
        readinessRequest.probe,
      );
      const legacyRequest = { ...request };
      Reflect.deleteProperty(legacyRequest, "readinessRequest");
      await expect(
        applyEnabledChange(host, store, { ...legacyRequest, readiness: directReadyReceipt }),
      ).rejects.toThrow("must be produced by a current-process readback probe");
      expect(() => store.read(manifest.id)).toThrow();
      expect((await applyEnabledChange(host, store, request)).state).toBe("active");
      expect((await applyEnabledChange(host, store, request)).state).toBe("active");
      expect(probeCalls).toEqual({ existence: 3, running: 3, readback: 3 });
      expect(host.readiness(manifest.id, "2026-08-21T00:00:30.000Z").status).toBe("ready");

      const failingRequest: typeof request = {
        ...request,
        readinessRequest: {
          ...readinessRequest,
          probe: {
            ...readinessRequest.probe,
            readback: async () => {
              throw new Error("readback unavailable");
            },
          },
        },
      };
      expect((await applyEnabledChange(host, store, failingRequest)).state).toBe("active");
      expect(probeCalls).toEqual({ existence: 4, running: 4, readback: 3 });
      expect(host.readiness(manifest.id).status).toBe("unknown");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("projects only a receipt produced by the current-process readback probe", async () => {
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
      const readyProbeRequest = probeRequest({
        definition: readyDefinition,
        binding: readyBinding,
      });
      const callerReceipt = await readRuntimeReadiness(
        readyProbeRequest.input,
        readyProbeRequest.probe,
      );
      await expect(
        host.activate({
          pluginId: definition.pluginId,
          moduleRef,
          module,
          config: { enabled: true },
          env: {},
          bindings: {},
          verifiedScope: null,
          readiness: callerReceipt,
        }),
      ).rejects.toThrow("must be produced by a current-process readback probe");
      expect(() => store.read(definition.pluginId)).toThrow();
      const mismatchedCapabilityOutcome = await host.activate({
        pluginId: definition.pluginId,
        moduleRef,
        module,
        config: { enabled: true },
        env: {},
        bindings: {},
        verifiedScope: null,
        readinessRequest: probeRequest({
          definition: { ...readyDefinition, capabilityId: "fixture.other" },
          binding: { ...readyBinding, capabilityId: "fixture.other" },
        }),
      });
      expect(mismatchedCapabilityOutcome).toMatchObject({
        state: "blocked",
        reasonCode: "ACTIVATE_FAILED",
      });
      expect(store.read(definition.pluginId).readiness).toBeUndefined();

      await host.activate({
        pluginId: definition.pluginId,
        moduleRef,
        module,
        config: { enabled: true },
        env: {},
        bindings: {},
        verifiedScope: null,
        readinessRequest: readyProbeRequest,
      });
      const readyProjection = host.readiness(definition.pluginId, "2026-08-21T00:00:30.000Z");
      expect(readyProjection.status).toBe("ready");
      expect("reasonCode" in readyProjection).toBe(false);
      const persisted = store.read(definition.pluginId).readiness;
      if (persisted === undefined) throw new Error("probe result was not persisted");
      expect(persisted.status).toBe("ready");
      const restartedHost = new PluginTransactionHost({
        store: new PluginOperationStore(directory),
      });
      expect(
        restartedHost.readiness(definition.pluginId, "2026-08-21T00:01:01.000Z"),
      ).toMatchObject({
        status: "unknown",
        reasonCode: "CAPABILITY_UNVERIFIED",
      });
      expect(() => host.recordReadiness(definition.pluginId, persisted)).toThrow(
        "must be produced by a current-process readback probe",
      );
      await expect(
        host.recordReadinessFromProbe(
          definition.pluginId,
          readyProbeRequest,
          "2026-08-21T00:00:30.000Z",
        ),
      ).resolves.toMatchObject({ status: "ready" });
      await expect(
        host.recordReadinessFromProbe(
          definition.pluginId,
          probeRequest({
            definition: { ...readyDefinition, capabilityId: "fixture.other" },
            binding: { ...readyBinding, capabilityId: "fixture.other" },
          }),
        ),
      ).rejects.toThrow("does not match the current plugin authority");

      const authority = store.read(definition.pluginId);
      store.save({ ...authority, verifiedScope: null });
      expect(host.readiness(definition.pluginId, "2026-08-21T00:00:30.000Z")).toMatchObject({
        status: "unknown",
        reasonCode: "CAPABILITY_UNVERIFIED",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
