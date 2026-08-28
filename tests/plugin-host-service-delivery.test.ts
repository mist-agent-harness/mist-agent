import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateManifest } from "../src/plugin/manifest.ts";
import { moduleRefFromSource } from "../src/plugin/module-ref.ts";
import { PluginOperationStore } from "../src/plugin/operation-store.ts";
import { PluginTransactionHost } from "../src/plugin/transaction-host.ts";
import type { PluginModuleV0 } from "../src/plugin/types.ts";

const directories: string[] = [];

function freshStore(): PluginOperationStore {
  const directory = mkdtempSync(join(tmpdir(), "mist-host-services-"));
  directories.push(directory);
  return new PluginOperationStore(directory);
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function request(
  module: PluginModuleV0,
  requiredServices = [{ id: "mist.session-handler", requires: "^1.0.0" }],
) {
  return {
    pluginId: "fixture.frontend",
    moduleRef: moduleRefFromSource("fixture frontend v1"),
    module,
    config: {},
    env: {},
    bindings: {},
    verifiedScope: null,
    requiredServices,
  };
}

function inertModule(
  onPrepare: (context: Parameters<PluginModuleV0["prepare"]>[0]) => void = () => undefined,
): PluginModuleV0 {
  return {
    async prepare(context) {
      onPrepare(context);
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
}

describe("versioned host service delivery", () => {
  it("fails closed before persistence and prepare when a declared service is absent or incompatible", async () => {
    for (const services of [
      [],
      [{ id: "mist.session-handler", version: "2.0.0", service: { ping: () => "pong" } }],
    ]) {
      const store = freshStore();
      let prepares = 0;
      const host = new PluginTransactionHost({ store, services });
      const outcome = await host.activate(
        request(
          inertModule(() => {
            prepares += 1;
          }),
        ),
      );
      expect(outcome).toMatchObject({ state: "blocked", reasonCode: "REQUIREMENT_MISSING" });
      expect(prepares).toBe(0);
      expect(() => store.read("fixture.frontend")).toThrow();
    }
  });

  it("delivers only declared services through a read-only handle", async () => {
    const store = freshStore();
    const service = {
      prefix: "real",
      ping(value: string) {
        return `${this.prefix}:${value}`;
      },
    };
    const host = new PluginTransactionHost({
      store,
      services: [
        { id: "mist.session-handler", version: "1.2.0", service },
        { id: "mist.private", version: "1.0.0", service: { secret: true } },
      ],
    });
    let result = "";
    const module = inertModule((context) => {
      const handle = context.services.get<typeof service>("mist.session-handler");
      result = handle.service.ping("path");
      expect(handle).toMatchObject({ id: "mist.session-handler", version: "1.2.0" });
      expect(() => context.services.get("mist.private")).toThrow("HOST_SERVICE_UNDECLARED");
      expect(Reflect.set(handle.service, "prefix", "fake")).toBe(false);
      expect(Reflect.setPrototypeOf(handle.service, null)).toBe(false);
    });
    expect((await host.activate(request(module))).state).toBe("active");
    expect(result).toBe("real:path");
    expect(service.prefix).toBe("real");
  });

  it("revokes the proxy and previously captured methods on rollback and disposal", async () => {
    for (const failPrepare of [true, false]) {
      const store = freshStore();
      const host = new PluginTransactionHost({
        store,
        services: [
          { id: "mist.session-handler", version: "1.0.0", service: { ping: () => "pong" } },
        ],
      });
      let service: Readonly<{ ping(): string }> | undefined;
      let ping: (() => string) | undefined;
      const module: PluginModuleV0 = {
        async prepare(context) {
          service = context.services.get<{ ping(): string }>("mist.session-handler").service;
          ping = service.ping;
          if (failPrepare) throw new Error("prepare failed");
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
      const outcome = await host.activate(request(module));
      if (!failPrepare) await host.dispose("fixture.frontend");
      expect(outcome.state).toBe(failPrepare ? "blocked" : "active");
      expect(() => service?.ping()).toThrow("HOST_SERVICE_REVOKED");
      expect(() => ping?.()).toThrow("HOST_SERVICE_REVOKED");
    }
  });
});

describe("host service manifest declarations", () => {
  const manifest = {
    manifestSchemaVersion: 0,
    id: "fixture.frontend",
    version: "1.0.0",
    requiresMist: ">=0.0.0",
    entrypoint: "plugin.ts",
    kinds: ["frontend"],
    configSchemaVersion: 0,
    capabilities: [],
    contextInjections: [],
    env: [],
    credentials: [],
    permissions: [],
  };

  it("accepts unique versioned declarations", () => {
    expect(
      validateManifest(
        {
          ...manifest,
          hostServices: [{ id: "mist.session-handler", requires: "^1.0.0" }],
        },
        "0.1.0",
      ),
    ).toMatchObject({ ok: true });
  });

  it("rejects malformed, duplicate, and unsupported service requirements", () => {
    for (const hostServices of [
      {},
      [{ id: "Bad Service", requires: "^1.0.0" }],
      [
        { id: "mist.session-handler", requires: "^1.0.0" },
        { id: "mist.session-handler", requires: "^2.0.0" },
      ],
      [{ id: "mist.session-handler", requires: "1.x" }],
    ]) {
      expect(validateManifest({ ...manifest, hostServices }, "0.1.0")).toMatchObject({
        ok: false,
        reasonCode: "MANIFEST_INVALID",
      });
    }
  });
});
