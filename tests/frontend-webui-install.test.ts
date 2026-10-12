/**
 * D31-1 WebUI 真实插件事务/lifecycle 测试：现役 applyEnabledChange + PluginTransactionHost +
 * 真实 PluginOperationStore；外部 appliance 只替系统命令/服务。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AdapterBinding } from "../acceptance/frontend-adapter-driver.ts";
import {
  WebuiInstallError,
  WebuiInstaller,
  webuiModuleRef,
} from "../src/frontend/webui-install.ts";
import type { WebuiAppliancePort, WebuiServiceRequest } from "../src/frontend/webui-module.ts";
import { moduleRefFromSource } from "../src/plugin/module-ref.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "mist-webui-install-"));
  dirs.push(dir);
  return dir;
}

class RecordingAppliance implements WebuiAppliancePort {
  startCalls = 0;
  stopCalls = 0;
  startFail = false;
  startFailAfterEffect = false;
  stopFail = false;
  lastRequest: WebuiServiceRequest | null = null;
  readonly live = new Set<string>();
  async startService(input: WebuiServiceRequest) {
    this.startCalls += 1;
    this.lastRequest = input;
    if (this.startFailAfterEffect) {
      // 先产生真实部分效果，再抛错。
      this.live.add(input.serviceId);
      throw new Error("external start failed after effect");
    }
    if (this.startFail) throw new Error("external start failed");
    this.live.add(input.serviceId);
    return { url: "http://127.0.0.1:3000", runtimeUsed: input.runtime };
  }
  async stopService(serviceId: string) {
    this.stopCalls += 1;
    if (this.stopFail) throw new Error("external stop failed");
    this.live.delete(serviceId);
  }
}

const BINDING: AdapterBinding = {
  bindingId: "binding:w",
  endpointId: "endpoint-w",
  residentId: "resident-w",
  scopeId: "private",
  streamId: "stream:resident-w",
  token: "SYNTHETIC_TOKEN_CANARY",
  serverModel: "mist:w",
  canonicalWriterId: "owner:resident-w",
};

function ledger(dataDir: string): string {
  return readFileSync(join(dataDir, "mist-webui.json"), "utf8");
}
function installerWith(dataDir: string, appliance: RecordingAppliance): WebuiInstaller {
  return new WebuiInstaller({ dataDir, appliance });
}

describe("#218 real WebUI plugin install transaction", () => {
  it("does nothing on cancel or missing runtime", async () => {
    const dataDir = temp();
    const appliance = new RecordingAppliance();
    const installer = installerWith(dataDir, appliance);
    expect(
      (
        await installer.run(BINDING, {
          confirmed: false,
          environment: { docker: true, python: true },
        })
      ).status,
    ).toBe("cancelled");
    expect(
      (
        await installer.run(BINDING, {
          confirmed: true,
          environment: { docker: false, python: false },
        })
      ).status,
    ).toBe("missing-runtime");
    expect(appliance.startCalls).toBe(0);
    expect(installer.readAudit().installGateCalls).toBe(0);
    expect(() => ledger(dataDir)).toThrow();
  });

  it("activates a real transaction with the connection resource", async () => {
    const dataDir = temp();
    const appliance = new RecordingAppliance();
    const installer = installerWith(dataDir, appliance);
    const started = await installer.run(BINDING, {
      confirmed: true,
      environment: { docker: false, python: true },
    });
    expect(started.status).toBe("started");
    expect(started.runtimeUsed).toBe("python");
    expect(appliance.startCalls).toBe(1);
    const record = JSON.parse(ledger(dataDir)) as {
      lifecycleState: string;
      operation: { phase: string; resources: Array<{ id: string; kind: string; phase: string }> };
    };
    expect(record.lifecycleState).toBe("active");
    expect(record.operation.phase).toBe("completed");
    expect(record.operation.resources).toEqual([
      {
        registrationIndex: 0,
        id: `webui-service-${started.serviceId}`,
        kind: "connection",
        recoveryKey: `webui-service-${started.serviceId}`,
        phase: "ready",
      },
    ]);
  });

  it("reuses the current service instead of double-starting", async () => {
    const dataDir = temp();
    const appliance = new RecordingAppliance();
    const installer = installerWith(dataDir, appliance);
    const first = await installer.run(BINDING, {
      confirmed: true,
      environment: { docker: true, python: false },
    });
    const second = await installer.run(BINDING, {
      confirmed: true,
      environment: { docker: true, python: false },
    });
    expect(second.serviceId).toBe(first.serviceId);
    expect(appliance.startCalls).toBe(1);
    expect(installer.readAudit().installGateCalls).toBe(1);
  });

  it("cleans up a partial effect when start throws after producing it", async () => {
    const dataDir = temp();
    const appliance = new RecordingAppliance();
    appliance.startFailAfterEffect = true;
    const installer = installerWith(dataDir, appliance);
    await expect(
      installer.run(BINDING, { confirmed: true, environment: { docker: true, python: false } }),
    ).rejects.toBeInstanceOf(WebuiInstallError);
    expect(appliance.startCalls).toBe(1);
    expect(appliance.stopCalls).toBe(1);
    expect([...appliance.live]).toEqual([]);
    expect(installer.readAudit().installGateCalls).toBe(0);
  });

  it("quarantines (not blocked-clean) when the cleanup itself fails after an effect", async () => {
    const dataDir = temp();
    const appliance = new RecordingAppliance();
    appliance.startFailAfterEffect = true;
    appliance.stopFail = true;
    const installer = installerWith(dataDir, appliance);
    await expect(
      installer.run(BINDING, { confirmed: true, environment: { docker: true, python: false } }),
    ).rejects.toBeInstanceOf(WebuiInstallError);
    expect(appliance.stopCalls).toBe(1);
    const record = JSON.parse(ledger(dataDir)) as { lifecycleState: string };
    expect(record.lifecycleState).toBe("quarantined");
  });

  it("disposes once on stop and marks the ledger disposed", async () => {
    const dataDir = temp();
    const appliance = new RecordingAppliance();
    const installer = installerWith(dataDir, appliance);
    const started = await installer.run(BINDING, {
      confirmed: true,
      environment: { docker: false, python: true },
    });
    if (started.serviceId === null) throw new Error("expected service");
    await installer.stop(started.serviceId);
    expect(appliance.stopCalls).toBe(1);
    expect((JSON.parse(ledger(dataDir)) as { lifecycleState: string }).lifecycleState).toBe(
      "disposed",
    );
  });

  it("reports cleanup failure on reset and keeps service/ledger trackable (no washing)", async () => {
    const dataDir = temp();
    const appliance = new RecordingAppliance();
    const installer = installerWith(dataDir, appliance);
    await installer.run(BINDING, { confirmed: true, environment: { docker: true, python: false } });
    appliance.stopFail = true;
    await expect(installer.reset()).rejects.toBeInstanceOf(WebuiInstallError);
    // 服务记录与真实账都保留，未清理被公开说明。
    expect(installer.readAudit().startedServiceIds.length).toBe(1);
    const quarantined = ledger(dataDir);
    expect(quarantined).toContain("quarantined");
    appliance.stopFail = false;
    // 清理失败后普通安装仍被拒，账原字节不洗。
    await expect(
      installer.run(BINDING, { confirmed: true, environment: { docker: true, python: false } }),
    ).rejects.toBeInstanceOf(WebuiInstallError);
    expect(ledger(dataDir)).toBe(quarantined);
  });

  it("successful reset stops once, disposes the ledger, and clears observations", async () => {
    const dataDir = temp();
    const appliance = new RecordingAppliance();
    const installer = installerWith(dataDir, appliance);
    await installer.run(BINDING, { confirmed: true, environment: { docker: false, python: true } });
    await installer.reset();
    expect(appliance.stopCalls).toBe(1);
    expect((JSON.parse(ledger(dataDir)) as { lifecycleState: string }).lifecycleState).toBe(
      "disposed",
    );
    const audit = installer.readAudit();
    expect(audit.startedServiceIds).toEqual([]);
    expect(audit.proposals).toEqual([]);
    expect(audit.installGateCalls).toBe(0);
  });

  it("never persists the bearer token into ledger or public audit", async () => {
    const dataDir = temp();
    const appliance = new RecordingAppliance();
    const installer = installerWith(dataDir, appliance);
    const started = await installer.run(BINDING, {
      confirmed: true,
      environment: { docker: false, python: true },
    });
    expect(appliance.lastRequest?.token).toBe("SYNTHETIC_TOKEN_CANARY");
    expect(ledger(dataDir)).not.toContain("SYNTHETIC_TOKEN_CANARY");
    expect(JSON.stringify(installer.readAudit())).not.toContain("SYNTHETIC_TOKEN_CANARY");
    expect(JSON.stringify(started)).not.toContain("SYNTHETIC_TOKEN_CANARY");
  });

  it("computes the ledger moduleRef from the real module source", () => {
    const source = readFileSync(new URL("../src/frontend/webui-module.ts", import.meta.url));
    expect(webuiModuleRef()).toBe(moduleRefFromSource(source));
    expect(webuiModuleRef()).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
