/**
 * D31-1 CLI `/webui` 宿主入口管理器（拆分 preflight / install，供 main 状态机调用）。
 *
 * 借 CLI 已装配的**同一个** `ResidentRuntime`（经 `InProcessResidentHostPort`），
 * `HostTextEngine` + 真实 `startFrontendHost` listener；产品 frontend manager 用真实
 * `NodeCommandRunner`/`WebuiSystemPlatform`/`WebuiInstaller`。清理只停前端服务与 listener，
 * 不关借用宿主 runtime。清理失败不吞：抛稳定 code + 中文 manual remedy，保留所有权/服务引用。
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AdapterBinding, WebuiEnvironment } from "../../acceptance/frontend-adapter-driver.ts";
import { type FrontendHost, startFrontendHost } from "../frontend/frontend-host.ts";
import { InProcessResidentHostPort } from "../frontend/host-port.ts";
import { HostTextEngine } from "../frontend/host-text-engine.ts";
import { WebuiInstaller } from "../frontend/webui-install.ts";
import type { HttpFetch } from "../frontend/webui-management-api.ts";
import {
  type CommandRunner,
  NodeCommandRunner,
  WEBUI_VERSION,
  WebuiPlatformError,
  WebuiSystemPlatform,
} from "../frontend/webui-platform.ts";
import { PRIVATE_SCOPE } from "../session/session-registry.ts";
import type { ResidentRuntime } from "./runtime.ts";

export interface WebuiCliDeps {
  readonly runtime: ResidentRuntime;
  readonly residentId: string;
  readonly dataDir: string;
  readonly runner?: CommandRunner;
  readonly log: (message: string) => void;
  /** host 生成随机 bearer；测试可注入固定值。 */
  readonly newToken?: () => string;
  readonly port?: number;
  /** 管理 API base（默认 owned service loopback）；测试指向合成 API。 */
  readonly managementBaseUrl?: string;
  /** 管理 HTTP seam；测试注入合成 API。 */
  readonly httpFetch?: HttpFetch;
}

export type WebuiEnvironmentReport = WebuiEnvironment & { pythonVersion?: string };

export interface WebuiPreflight {
  readonly environment: WebuiEnvironmentReport;
  readonly proposal: string;
}

export class WebuiCliError extends Error {
  readonly code: string;
  readonly remedy: string;
  constructor(code: string, remedy: string) {
    super(code);
    this.name = "WebuiCliError";
    this.code = code;
    this.remedy = remedy;
  }
}

export type WebuiCliOutcome =
  | { readonly status: "cancelled" }
  | { readonly status: "missing-runtime"; readonly missing: readonly ("docker" | "python")[] }
  | {
      readonly status: "started";
      readonly serviceId: string;
      readonly url: string;
      /** 停前端服务 + 关 listener；失败抛 `WebuiCliError`，不吞。 */
      close(): Promise<void>;
    }
  | { readonly status: "failed"; readonly code: string; readonly remedy: string };

function proposalText(environment: WebuiEnvironmentReport): string {
  const docker = environment.docker ? "可用" : "不可用";
  const python = environment.python ? `可用（${environment.pythonVersion ?? "3.x"}）` : "不可用";
  return [
    `将安装 Open WebUI v${WEBUI_VERSION}（可选组件，需明确确认）。`,
    `环境探测：Docker ${docker}；Python ${python}。`,
    "资源估计（展示估计，非实测）：磁盘约 1–2 GB，内存约 512 MB–1 GB。",
    "将启动服务：单个 loopback（127.0.0.1）WebUI 服务，连本机 adapter endpoint。",
    "代价：确认后启用标题/标签/跟进/补全/检索/图像 prompt 等后台任务与上下文压缩均关闭；",
    "ENABLE_PERSISTENT_CONFIG=False，UI 内设置不持久。",
    "确认安装请输入 yes；否则输入 no 取消。",
  ].join("\n");
}

/** 只读环境探测 + 提案文本（不产生任何安装/服务）。 */
export async function preflightWebui(
  deps: WebuiCliDeps,
): Promise<{ ok: true; value: WebuiPreflight } | { ok: false; code: string; remedy: string }> {
  const runner = deps.runner ?? new NodeCommandRunner();
  const dataDir = join(deps.dataDir, "webui");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const platform = new WebuiSystemPlatform({ dataDir, runner, resolveEndpoint: () => "" });
  try {
    const environment = await platform.detectEnvironment();
    return { ok: true, value: { environment, proposal: proposalText(environment) } };
  } catch {
    return {
      ok: false,
      code: "WEBUI_ENV_PROBE_FAILED",
      remedy: "环境探测失败；请检查 Docker/Python 后重试。",
    };
  }
}

/** 借同一 runtime 建立受限文字 engine + 真实监听器。失败时关已建 listener 再抛。 */
async function startFrontendForCli(
  deps: WebuiCliDeps,
  token: string,
): Promise<{ engine: HostTextEngine; host: FrontendHost; binding: AdapterBinding }> {
  const engine = new HostTextEngine(new InProcessResidentHostPort(deps.runtime));
  const binding: AdapterBinding = {
    bindingId: `binding:webui:${deps.residentId}`,
    endpointId: `endpoint:webui:${deps.residentId}`,
    residentId: deps.residentId,
    scopeId: PRIVATE_SCOPE,
    streamId: `stream:${deps.residentId}`,
    token,
    serverModel: "mist:webui",
    canonicalWriterId: `owner:${deps.residentId}`,
  };
  await engine.registerBinding(binding);
  let host: FrontendHost;
  try {
    host = await startFrontendHost({
      engine,
      ...(deps.port === undefined ? {} : { port: deps.port }),
    });
  } catch {
    throw new WebuiCliError("WEBUI_LISTENER_FAILED", "前端 listener 启动失败；未安装、未启动。");
  }
  return { engine, host, binding };
}

/** 确认后执行真实安装/启动。成功返回带 close 的 outcome；失败清理，清理失败不吞。 */
export async function installWebui(
  deps: WebuiCliDeps,
  environment: WebuiEnvironmentReport,
): Promise<WebuiCliOutcome> {
  if (!environment.docker && !environment.python) {
    return { status: "missing-runtime", missing: ["docker", "python"] };
  }
  const dataDir = join(deps.dataDir, "webui");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const runner = deps.runner ?? new NodeCommandRunner();
  const token = (deps.newToken ?? (() => `mist-webui-${randomUUID()}`))();
  const endpointUrls = new Map<string, string>();
  const servicePlatform = new WebuiSystemPlatform({
    dataDir,
    runner,
    // 端点来源：host 可信 registry —— listener 实际 loopback URL（非虚构 alias）。
    resolveEndpoint: (endpointId) => endpointUrls.get(endpointId) ?? "",
    ...(deps.managementBaseUrl === undefined ? {} : { managementBaseUrl: deps.managementBaseUrl }),
    ...(deps.httpFetch === undefined ? {} : { httpFetch: deps.httpFetch }),
  });
  const { binding, host } = await startFrontendForCli(deps, token);
  endpointUrls.set(binding.endpointId, host.url);
  const installer = new WebuiInstaller({
    dataDir: join(dataDir, "plugins"),
    appliance: servicePlatform,
  });

  const cleanup = async (): Promise<WebuiCliError | null> => {
    let failure: WebuiCliError | null = null;
    try {
      await installer.reset();
    } catch (error) {
      const code = error instanceof WebuiPlatformError ? error.code : "WEBUI_CLEANUP_FAILED";
      failure = new WebuiCliError(
        code,
        "前端服务清理失败；账保持真实隔离态且服务引用保留，请按插件手动处理建议清理后重试。",
      );
    }
    try {
      await host.close();
    } catch {
      failure ??= new WebuiCliError(
        "WEBUI_LISTENER_CLOSE_FAILED",
        "前端 listener 关闭失败；保留引用，请手动处理。",
      );
    }
    return failure;
  };

  let result: Awaited<ReturnType<WebuiInstaller["run"]>>;
  try {
    result = await installer.run(binding, { confirmed: true, environment });
  } catch (error) {
    const cleanupFailure = await cleanup();
    if (cleanupFailure !== null)
      return { status: "failed", code: cleanupFailure.code, remedy: cleanupFailure.remedy };
    if (error instanceof WebuiPlatformError)
      return { status: "failed", code: error.code, remedy: error.remedy };
    return {
      status: "failed",
      code: "WEBUI_INSTALL_FAILED",
      remedy: "WebUI 安装/启动失败；已清理本次资源。",
    };
  }
  if (result.status !== "started" || result.serviceId === null || result.url === null) {
    const cleanupFailure = await cleanup();
    if (cleanupFailure !== null)
      return { status: "failed", code: cleanupFailure.code, remedy: cleanupFailure.remedy };
    return {
      status: "failed",
      code: "WEBUI_START_FAILED",
      remedy: "WebUI 未成功启动；已清理本次前端资源。",
    };
  }
  const serviceId = result.serviceId;
  return {
    status: "started",
    serviceId,
    url: result.url,
    close: async () => {
      const failure = await cleanup();
      if (failure !== null) throw failure;
    },
  };
}
