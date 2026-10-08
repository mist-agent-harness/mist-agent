/**
 * D31-1 `/webui` 前端路径（真实插件事务 + frontend manifest/env 门）：
 * 提案 → 明确确认 → 经现役 `applyEnabledChange`（`validateBindings` 就绪门 + `resolveEnvironment`
 * 执行边界解析 secretRef + `PluginTransactionHost` 事务）安装（prepare/register → activate →
 * publish）；服务作为连接 resource：activate 启动、dispose/rollback 停止。
 *
 * token 只作为 secretRef 在执行边界解析进 `context.env`，绝不落 config/ledger/audit/proposal/URL。
 * moduleRef 由真实 webui-module.ts 源文件内容 digest 得到。清理失败检查 outcome，保留真实账与
 * 服务记录并抛稳定错误，不删账冒充干净。外部系统命令/服务由 `WebuiAppliancePort` 提供。
 */
import { readFileSync } from "node:fs";
import type {
  AdapterBinding,
  WebuiAuditReadback,
  WebuiCommandReadback,
  WebuiEnvironment,
  WebuiInstallProposal,
  WebuiOperation,
  WebuiRuntime,
} from "../../acceptance/frontend-adapter-driver.ts";
import { applyEnabledChange } from "../plugin/enable.ts";
import { type PluginManifestV0, validateManifest } from "../plugin/manifest.ts";
import { moduleRefFromSource } from "../plugin/module-ref.ts";
import { PluginOperationStore } from "../plugin/operation-store.ts";
import { PluginTransactionHost } from "../plugin/transaction-host.ts";
import { type WebuiAppliancePort, createWebuiModule } from "./webui-module.ts";

export type { WebuiAppliancePort } from "./webui-module.ts";

export class WebuiInstallError extends Error {
  readonly code: string;
  readonly remedy: string;
  constructor(code: string, remedy: string) {
    super(code);
    this.name = "WebuiInstallError";
    this.code = code;
    this.remedy = remedy;
  }
}

const PLUGIN_ID = "mist-webui";
const PLUGIN_VERSION = "0.11.4";
const HOST_VERSION = "0.0.0";
const BEARER_SECRET_REF = "mist-webui-bearer";

/** 真实模块源（执行的就是这个文件）→ digest，可重算核对。 */
export function webuiModuleRef(): string {
  const source = readFileSync(new URL("./webui-module.ts", import.meta.url));
  return moduleRefFromSource(source);
}

export function webuiManifest(): PluginManifestV0 {
  const manifest: PluginManifestV0 = {
    manifestSchemaVersion: 0,
    id: PLUGIN_ID,
    version: PLUGIN_VERSION,
    requiresMist: ">=0.0.0",
    entrypoint: "webui-module.ts",
    kinds: ["frontend"],
    configSchemaVersion: 1,
    capabilities: [],
    contextInjections: [],
    env: [
      {
        name: "MIST_WEBUI_ENDPOINT",
        description: "adapter endpoint id",
        required: false,
        secret: false,
      },
      {
        name: "MIST_WEBUI_BEARER",
        description: "adapter bearer token",
        required: true,
        secret: true,
      },
    ],
    credentials: [],
    permissions: [],
  };
  const validated = validateManifest(manifest, HOST_VERSION);
  if (!validated.ok) {
    throw new WebuiInstallError(validated.reasonCode, `WebUI manifest 无效：${validated.detail}`);
  }
  return validated.manifest;
}

interface RunningService {
  bindingId: string;
  endpointId: string;
  runtime: WebuiRuntime;
  url: string;
}

export class WebuiInstaller {
  readonly #store: PluginOperationStore;
  readonly #host: PluginTransactionHost;
  readonly #appliance: WebuiAppliancePort;
  #proposals: WebuiInstallProposal[] = [];
  #operations: WebuiOperation[] = [];
  readonly #services = new Map<string, RunningService>();
  #installGateCalls = 0;

  constructor(options: { dataDir: string; appliance: WebuiAppliancePort }) {
    this.#store = new PluginOperationStore(options.dataDir);
    this.#host = new PluginTransactionHost({ store: this.#store });
    this.#appliance = options.appliance;
  }

  serviceBinding(serviceId: string): string | null {
    return this.#services.get(serviceId)?.bindingId ?? null;
  }

  serviceUrl(serviceId: string): string | null {
    return this.#services.get(serviceId)?.url ?? null;
  }

  readAudit(): WebuiAuditReadback {
    return {
      installGateCalls: this.#installGateCalls,
      systemInstallAttempts: 0,
      startedServiceIds: [...this.#services.keys()],
      endpointIds: [...this.#services.values()].map((service) => service.endpointId),
      proposals: structuredClone(this.#proposals),
      operations: structuredClone(this.#operations),
    };
  }

  async run(
    binding: AdapterBinding,
    input: { confirmed: boolean; environment: WebuiEnvironment },
  ): Promise<WebuiCommandReadback> {
    const serviceId = `webui-${binding.endpointId}`;
    const proposal: WebuiInstallProposal = {
      proposalId: `proposal-${this.#proposals.length + 1}`,
      pluginId: PLUGIN_ID,
      category: "frontend",
      displayName: "Open WebUI",
      resourceUsage: { diskBytes: 512 * 1024 * 1024, memoryBytes: 256 * 1024 * 1024 },
      servicesToStart: [serviceId],
    };
    this.#proposals.push(structuredClone(proposal));
    this.#operations.push({
      kind: "proposal",
      proposalId: proposal.proposalId,
      pluginId: PLUGIN_ID,
      category: "frontend",
    });

    if (!input.confirmed) {
      this.#operations.push({
        kind: "confirmation",
        proposalId: proposal.proposalId,
        confirmed: false,
      });
      return this.#cancelled(proposal);
    }
    if (!input.environment.docker && !input.environment.python) {
      return this.#missing(proposal);
    }
    const runtime: WebuiRuntime = input.environment.docker ? "docker" : "python";
    this.#operations.push({
      kind: "confirmation",
      proposalId: proposal.proposalId,
      confirmed: true,
    });

    const existing = this.#services.get(serviceId);
    if (existing !== undefined && this.#pluginActive()) {
      return this.#started(proposal, serviceId, existing, runtime);
    }

    const started: { value: { url: string; runtimeUsed: WebuiRuntime } | null } = { value: null };
    const manifest = webuiManifest();
    const module = createWebuiModule({ appliance: this.#appliance, runtime, serviceId, started });
    const result = await applyEnabledChange(this.#host, this.#store, {
      pluginId: PLUGIN_ID,
      manifest,
      module,
      moduleRef: webuiModuleRef(),
      config: {
        enabled: true,
        settings: {},
        environment: [
          { name: "MIST_WEBUI_ENDPOINT", value: binding.endpointId },
          { name: "MIST_WEBUI_BEARER", secretRef: BEARER_SECRET_REF },
        ],
        credentialRefs: {},
      },
      // secretRef 只在此执行边界解析；值只进内存 context.env。
      resolveSecret: (ref) => {
        if (ref !== BEARER_SECRET_REF) throw new Error(`unknown secret ref: ${ref}`);
        return binding.token;
      },
    });
    if (!("operationId" in result) || result.state !== "active") {
      const reason = "reasonCode" in result ? result.reasonCode : "WEBUI_PLUGIN_REFUSED";
      throw new WebuiInstallError(
        String(reason),
        `Open WebUI 插件未安装成功（${String(reason)}）；当前账不动，按插件生命周期处理后再试。`,
      );
    }
    this.#installGateCalls += 1;
    this.#operations.push({
      kind: "install",
      proposalId: proposal.proposalId,
      pluginId: PLUGIN_ID,
      category: "frontend",
      runtimeUsed: runtime,
    });
    if (started.value === null) {
      throw new WebuiInstallError(
        "WEBUI_SERVICE_NOT_STARTED",
        "Open WebUI 服务未启动；安装事务未完成。",
      );
    }
    const running: RunningService = {
      bindingId: binding.bindingId,
      endpointId: binding.endpointId,
      runtime: started.value.runtimeUsed,
      url: started.value.url,
    };
    this.#services.set(serviceId, running);
    return this.#started(proposal, serviceId, running, runtime);
  }

  /** 真实 dispose；未成功清理则保留服务记录/真实账并抛稳定错误（不删账冒充干净）。 */
  async stop(serviceId: string): Promise<void> {
    const running = this.#services.get(serviceId);
    if (running === undefined) {
      if (this.#hasQuarantinedLedger()) {
        throw new WebuiInstallError(
          "WEBUI_CLEANUP_INCOMPLETE",
          "Open WebUI 插件账处于 quarantined；没有可验证的服务所有权，拒绝报告清理完成。",
        );
      }
      return;
    }
    const outcome = await this.#host.dispose(PLUGIN_ID);
    if (outcome.state !== "disposed") {
      throw new WebuiInstallError(
        outcome.reasonCode ?? "WEBUI_CLEANUP_INCOMPLETE",
        "Open WebUI 服务未能完整停用；账保持真实隔离态，请按手动处理建议清理后重试。",
      );
    }
    this.#services.delete(serviceId);
  }

  /** 清理现役服务；全部成功才清观测。任一未成功则保留记录/账并抛稳定错误。 */
  async reset(): Promise<void> {
    if (this.#services.size === 0 && this.#hasQuarantinedLedger()) {
      throw new WebuiInstallError(
        "WEBUI_CLEANUP_INCOMPLETE",
        "Open WebUI 插件账处于 quarantined；reset 保留账与操作记录，不报告干净状态。",
      );
    }
    for (const serviceId of [...this.#services.keys()]) {
      const outcome = await this.#host.dispose(PLUGIN_ID);
      if (outcome.state !== "disposed") {
        throw new WebuiInstallError(
          outcome.reasonCode ?? "WEBUI_CLEANUP_INCOMPLETE",
          "Open WebUI 清理未完成；账保持真实隔离态，服务记录保留，请按手动处理建议清理后重试。",
        );
      }
      this.#services.delete(serviceId);
    }
    this.#proposals = [];
    this.#operations = [];
    this.#installGateCalls = 0;
  }

  #hasQuarantinedLedger(): boolean {
    try {
      return this.#store.read(PLUGIN_ID).lifecycleState === "quarantined";
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return false;
      }
      throw new WebuiInstallError(
        "WEBUI_LEDGER_UNREADABLE",
        "Open WebUI 插件账不可读；拒绝把未知状态当作干净完成。",
      );
    }
  }

  #pluginActive(): boolean {
    try {
      return this.#store.read(PLUGIN_ID).lifecycleState === "active";
    } catch {
      return false;
    }
  }

  #cancelled(proposal: WebuiInstallProposal): WebuiCommandReadback {
    return {
      status: "cancelled",
      missing: [],
      serviceId: null,
      url: null,
      endpointId: null,
      runtimeUsed: null,
      proposalId: proposal.proposalId,
      confirmation: "cancelled",
      installedPlugin: null,
    };
  }

  #missing(proposal: WebuiInstallProposal): WebuiCommandReadback {
    return {
      status: "missing-runtime",
      missing: ["docker", "python"],
      serviceId: null,
      url: null,
      endpointId: null,
      runtimeUsed: null,
      proposalId: proposal.proposalId,
      confirmation: null,
      installedPlugin: null,
    };
  }

  #started(
    proposal: WebuiInstallProposal,
    serviceId: string,
    running: RunningService,
    runtime: WebuiRuntime,
  ): WebuiCommandReadback {
    return {
      status: "started",
      missing: [],
      serviceId,
      url: running.url,
      endpointId: running.endpointId,
      runtimeUsed: running.runtime ?? runtime,
      proposalId: proposal.proposalId,
      confirmation: "confirmed",
      installedPlugin: { pluginId: PLUGIN_ID, category: "frontend" },
    };
  }
}
