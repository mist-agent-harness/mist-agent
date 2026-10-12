/**
 * D31-1 WebUI **真实系统平台**（正常产品用）：经可注入 `CommandRunner` 控制真实
 * spawn/exec 的 argv/env/进程句柄与停止。测试注入假外部执行器；真实插件门/事务账不替。
 *
 * 版本固定 Open WebUI v0.11.4。token 只经 child env 交付，不进 argv/URL/日志/账/公开配置。
 * UI 只 bind 127.0.0.1；Docker 用 host networking 让容器真能到宿主 loopback（探测可达，
 * 不偷改 adapter 监听），并挂专属私有 dataDir，不删用户卷/DB。外部命令 argv 用真实数组，
 * 不拼 shell。
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import type { WebuiEnvironment } from "../../acceptance/frontend-adapter-driver.ts";
import { WebuiCredentialError, loadOrCreateAdminCredentials } from "./webui-credentials.ts";
import {
  type HttpFetch,
  WebuiManagementApi,
  WebuiManagementError,
  type WebuiManagementOutcome,
} from "./webui-management-api.ts";
import type { WebuiAppliancePort, WebuiServiceRequest } from "./webui-module.ts";

export const WEBUI_VERSION = "0.11.4";
export const WEBUI_DOCKER_IMAGE = `ghcr.io/open-webui/open-webui:v${WEBUI_VERSION}`;
export const WEBUI_PIP_PACKAGE = `open-webui==${WEBUI_VERSION}`;
export const WEBUI_DEFAULT_PORT = 8080;

/** 固定版本后台任务/压缩/持久配置开关；ENABLE_PERSISTENT_CONFIG=False 代价=UI 设置不持久。 */
export const WEBUI_TASK_ENV: Readonly<Record<string, string>> = Object.freeze({
  ENABLE_TITLE_GENERATION: "False",
  ENABLE_TAGS_GENERATION: "False",
  ENABLE_FOLLOW_UP_GENERATION: "False",
  ENABLE_AUTOCOMPLETE_GENERATION: "False",
  ENABLE_RETRIEVAL_QUERY_GENERATION: "False",
  ENABLE_SEARCH_QUERY_GENERATION: "False",
  ENABLE_IMAGE_PROMPT_GENERATION: "False",
  ENABLE_CONTEXT_COMPACTION: "False",
  ENABLE_PERSISTENT_CONFIG: "False",
  // 纯 Pipe 路径：不经 Open WebUI 直连 OpenAI/Ollama，也不自动下载模型。
  ENABLE_OPENAI_API: "False",
  ENABLE_OLLAMA_API: "False",
  OFFLINE_MODE: "True",
  // 认证保持开启：不允许 False/默认 admin 捷径；专属 admin 由 WEBUI_ADMIN_EMAIL/PASSWORD 建。
  WEBUI_AUTH: "True",
});

export interface CommandInvocation {
  readonly file: string;
  readonly args: readonly string[];
  /** child env；密钥只在此，不进 argv。 */
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRunner {
  run(invocation: CommandInvocation): Promise<CommandResult>;
  /** 跑一个短命容器客户端并返回容器 id；非零退出即失败。 */
  startContainer(
    invocation: CommandInvocation & { name: string },
  ): Promise<{ containerId: string }>;
  /** 启动长期服务进程，短暂存活检查后返回 pid；早退即失败。 */
  startProcess(invocation: CommandInvocation & { name: string }): Promise<{ pid: number }>;
  stopContainer(name: string): Promise<void>;
  stopProcess(name: string): Promise<void>;
  isProcessAlive(name: string): Promise<boolean>;
}

/** host 可信 endpoint registry：endpointId → 实际 adapter loopback URL（非身份权威）。 */
export type EndpointResolver = (endpointId: string) => string;

/** 端口占用检查（默认真实 net 探测；测试可注入）。 */
export type PortFreeCheck = (port: number) => Promise<boolean>;

/** 管理注册端口：默认真实 `WebuiManagementApi`；测试可注入合成 API 组合。 */
export interface WebuiManagementPort {
  ensurePipe(input: {
    readonly serviceId: string;
    readonly baseUrl: string;
    readonly email: string;
    readonly password: string;
  }): Promise<WebuiManagementOutcome>;
}

export interface WebuiPlatformOptions {
  readonly dataDir: string;
  readonly runner: CommandRunner;
  readonly resolveEndpoint: EndpointResolver;
  readonly port?: number;
  readonly isPortFree?: PortFreeCheck;
  readonly pythonCandidates?: readonly string[];
  /** 有界 startup 健康等待轮数/间隔（默认 40 × 3000ms；测试可缩到 0）。 */
  readonly healthMaxAttempts?: number;
  readonly healthPollIntervalMs?: number;
  /** 管理 API base（默认 owned service loopback `http://127.0.0.1:<port>`）。 */
  readonly managementBaseUrl?: string;
  /** 管理 HTTP seam（默认全局 fetch）；测试注入合成 API。 */
  readonly httpFetch?: HttpFetch;
  /** 管理注册端口覆盖（默认构造真实 `WebuiManagementApi`）。 */
  readonly management?: WebuiManagementPort;
  /** Pipe 源（默认读 `assets/openwebui/mist-pipe.py`）。 */
  readonly pipeSource?: string;
}

export class WebuiContainerOwnershipError extends Error {
  constructor() {
    super("container creation ownership could not be verified");
    this.name = "WebuiContainerOwnershipError";
  }
}

export class WebuiPlatformError extends Error {
  readonly code: string;
  readonly remedy: string;
  constructor(code: string, remedy: string) {
    super(code);
    this.name = "WebuiPlatformError";
    this.code = code;
    this.remedy = remedy;
  }
}

type Runtime = "docker" | "python";
interface OwnedService {
  readonly kind: Runtime;
  readonly port: number;
  /** docker 用 host 随机唯一容器名；python 用 serviceId。 */
  readonly resourceName: string;
  readonly quarantined?: boolean;
}

const BASE_ENV_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "LANG",
  "LC_ALL",
  "SYSTEMROOT",
  "ComSpec",
  "PATHEXT",
];
const STARTUP_TIMEOUT_MS = 180_000;
const PROBE_TIMEOUT_MS = 15_000;

/** 只继承必要运行环境；其他 provider/上游密钥绝不继承。 */
export function childEnv(extra: Readonly<Record<string, string>>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of BASE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
}

export function adapterBaseUrl(endpoint: string): string {
  const trimmed = endpoint.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function parseMajorMinor(version: string): [number, number] | null {
  const match = /(\d+)\.(\d+)(?:\.\d+)?/.exec(version);
  return match === null ? null : [Number(match[1]), Number(match[2])];
}

function realPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, "127.0.0.1");
  });
}

/** 生产默认真实 Pipe 源：读随包发布的 `assets/openwebui/mist-pipe.py`。 */
function defaultPipeSource(): string {
  return readFileSync(new URL("../../assets/openwebui/mist-pipe.py", import.meta.url), "utf8");
}

export class WebuiSystemPlatform implements WebuiAppliancePort {
  readonly #dataDir: string;
  readonly #runner: CommandRunner;
  readonly #resolveEndpoint: EndpointResolver;
  readonly #port: number;
  readonly #isPortFree: PortFreeCheck;
  readonly #pythonCandidates: readonly string[];
  readonly #healthMaxAttempts: number;
  readonly #healthPollIntervalMs: number;
  readonly #managementBaseUrl: string | undefined;
  readonly #management: WebuiManagementPort;
  readonly #owned = new Map<string, OwnedService>();
  readonly #urls = new Map<string, string>();
  #pythonInterpreter: string | null = null;

  constructor(options: WebuiPlatformOptions) {
    this.#dataDir = options.dataDir;
    this.#runner = options.runner;
    this.#resolveEndpoint = options.resolveEndpoint;
    this.#port = options.port ?? WEBUI_DEFAULT_PORT;
    this.#isPortFree = options.isPortFree ?? realPortFree;
    this.#pythonCandidates = options.pythonCandidates ?? ["python3.12", "python3.11", "python3"];
    this.#healthMaxAttempts = options.healthMaxAttempts ?? 40;
    this.#healthPollIntervalMs = options.healthPollIntervalMs ?? 3_000;
    this.#managementBaseUrl = options.managementBaseUrl;
    this.#management =
      options.management ??
      new WebuiManagementApi({
        pipeSource: options.pipeSource ?? defaultPipeSource(),
        ...(options.httpFetch === undefined ? {} : { fetcher: options.httpFetch }),
      });
    mkdirSync(this.#dataDir, { recursive: true, mode: 0o700 });
  }

  serviceUrl(serviceId: string): string | null {
    return this.#urls.get(serviceId) ?? null;
  }

  /** 只读探测：Docker daemon 可用；Python 3.11/3.12 且 venv 可用；不安装系统运行时。 */
  async detectEnvironment(): Promise<WebuiEnvironment & { pythonVersion?: string }> {
    let docker = false;
    try {
      const info = await this.#runner.run({
        file: "docker",
        args: ["info", "--format", "{{.ServerVersion}}"],
        env: {},
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      docker = info.code === 0 && info.stdout.trim().length > 0;
    } catch {
      docker = false;
    }
    let python = false;
    let pythonVersion: string | undefined;
    for (const candidate of this.#pythonCandidates) {
      try {
        const version = await this.#runner.run({
          file: candidate,
          args: ["--version"],
          env: {},
          timeoutMs: PROBE_TIMEOUT_MS,
        });
        const combined = `${version.stdout}${version.stderr}`.trim();
        const parsed = version.code === 0 ? parseMajorMinor(combined) : null;
        if (parsed === null || parsed[0] !== 3 || (parsed[1] !== 11 && parsed[1] !== 12)) continue;
        const venv = await this.#runner.run({
          file: candidate,
          args: ["-m", "venv", "--help"],
          env: {},
          timeoutMs: PROBE_TIMEOUT_MS,
        });
        if (venv.code === 0) {
          python = true;
          pythonVersion = combined.replace(/^Python\s+/, "");
          this.#pythonInterpreter = candidate;
          break;
        }
      } catch {
        // 尝试下一个候选。
      }
    }
    return { docker, python, ...(pythonVersion === undefined ? {} : { pythonVersion }) };
  }

  async startService(input: WebuiServiceRequest): Promise<{ url: string; runtimeUsed: Runtime }> {
    const endpoint = this.#resolveEndpoint(input.endpointId);
    const base = adapterBaseUrl(endpoint);
    const port = this.#port;
    if (!(await this.#isPortFree(port))) {
      throw new WebuiPlatformError(
        "WEBUI_PORT_IN_USE",
        `端口 ${port} 已被占用；换一个端口或先停掉占用者。`,
      );
    }
    const name = input.serviceId;
    const dataDir = join(this.#dataDir, "webui-data");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    // 专属 admin 凭据只在确认安装后生成/复用（preflight/cancel 不产生凭据副作用）。
    let credentials: { email: string; password: string };
    try {
      credentials = loadOrCreateAdminCredentials(this.#dataDir);
    } catch (error) {
      if (error instanceof WebuiCredentialError)
        throw new WebuiPlatformError(error.code, error.remedy);
      throw new WebuiPlatformError(
        "WEBUI_CREDENTIAL_UNSAFE",
        "生成/读取专属 WebUI 管理凭据失败；未启动服务，请检查私有目录权限后重试。",
      );
    }
    // docker 用 host 随机唯一容器名：绝不撞已存在同名容器、绝不动无关资源。
    const ownershipNonce = randomUUID();
    const resourceName =
      input.runtime === "docker"
        ? `mist-webui-${ownershipNonce.replace(/-/g, "").slice(0, 16)}`
        : name;
    // 可能产生部分效果前先登记所有权：失败清理失败也不删所有权。
    this.#owned.set(name, { kind: input.runtime, port, resourceName });

    try {
      if (input.runtime === "docker") {
        await this.#runner.startContainer({
          file: "docker",
          name: resourceName,
          args: this.#dockerArgs(resourceName, dataDir, base, port, endpoint, ownershipNonce),
          // token 与 admin 密码只在 child env；argv 用 `--env ...`（无值）。
          env: childEnv({
            OPENAI_API_KEY: input.token,
            MIST_ADAPTER_TOKEN: input.token,
            WEBUI_ADMIN_EMAIL: credentials.email,
            WEBUI_ADMIN_PASSWORD: credentials.password,
          }),
          timeoutMs: PROBE_TIMEOUT_MS,
        });
      } else {
        const interpreter = this.#pythonInterpreter ?? (await this.#requirePython());
        const venvDir = join(this.#dataDir, "venv");
        const venvPython = join(venvDir, "bin", "python");
        const created = await this.#runner.run({
          file: interpreter,
          args: ["-m", "venv", venvDir],
          cwd: this.#dataDir,
          env: {},
          timeoutMs: STARTUP_TIMEOUT_MS,
        });
        if (created.code !== 0)
          throw new WebuiPlatformError(
            "WEBUI_PYTHON_VENV_FAILED",
            "创建专属 venv 失败；请确认 Python 3.11/3.12 与 venv 可用。",
          );
        const pip = await this.#runner.run({
          file: venvPython,
          args: ["-m", "pip", "install", "--no-input", WEBUI_PIP_PACKAGE],
          cwd: this.#dataDir,
          env: {},
          timeoutMs: STARTUP_TIMEOUT_MS,
        });
        if (pip.code !== 0)
          throw new WebuiPlatformError(
            "WEBUI_PIP_INSTALL_FAILED",
            `安装 ${WEBUI_PIP_PACKAGE} 失败；检查网络/私有索引后重试。未改动系统 Python。`,
          );
        await this.#runner.startProcess({
          file: join(venvDir, "bin", "open-webui"),
          name,
          args: ["serve", "--host", "127.0.0.1", "--port", String(port)],
          cwd: this.#dataDir,
          env: childEnv({
            ...WEBUI_TASK_ENV,
            OPENAI_API_BASE_URL: base,
            OPENAI_API_KEY: input.token,
            MIST_ADAPTER_URL: endpoint,
            MIST_ADAPTER_TOKEN: input.token,
            WEBUI_ADMIN_EMAIL: credentials.email,
            WEBUI_ADMIN_PASSWORD: credentials.password,
            DATA_DIR: dataDir,
            WEBUI_HOST: "127.0.0.1",
          }),
          timeoutMs: STARTUP_TIMEOUT_MS,
        });
      }
    } catch (error) {
      if (error instanceof WebuiContainerOwnershipError) {
        this.#owned.set(name, { kind: input.runtime, port, resourceName, quarantined: true });
        throw new WebuiPlatformError(
          "WEBUI_RESOURCE_QUARANTINED",
          "容器创建结果无法通过本次唯一标记核验；保留所有权隔离记录，未删除任何容器。",
        );
      }
      const cleanup = await this.#cleanupOwned(name);
      if (cleanup !== null) throw cleanup;
      if (error instanceof WebuiPlatformError) throw error;
      throw new WebuiPlatformError(
        "WEBUI_START_FAILED",
        `启动 Open WebUI 失败；已回收本次 ${input.runtime} 资源。`,
      );
    }

    let ready = false;
    try {
      ready = await this.#awaitHealthy(resourceName, input.runtime, port, base);
    } catch {
      ready = false;
    }
    if (!ready) {
      const cleanup = await this.#cleanupOwned(name);
      if (cleanup !== null) throw cleanup;
      throw new WebuiPlatformError(
        "WEBUI_NOT_READY",
        "Open WebUI 未就绪或未能连通 adapter endpoint；已回收本次资源。请检查启动日志与平台设置后重试。",
      );
    }

    // 真实官方管理 API 注册并启用 Pipe；只有核验通过才算 started。
    const managementBase = this.#managementBaseUrl ?? `http://127.0.0.1:${port}`;
    try {
      await this.#management.ensurePipe({
        serviceId: name,
        baseUrl: managementBase,
        email: credentials.email,
        password: credentials.password,
      });
    } catch (error) {
      const cleanup = await this.#cleanupOwned(name);
      if (cleanup !== null) throw cleanup;
      if (error instanceof WebuiPlatformError) throw error;
      if (error instanceof WebuiManagementError)
        throw new WebuiPlatformError(error.code, error.remedy);
      throw new WebuiPlatformError(
        "WEBUI_MANAGEMENT_FAILED",
        "Open WebUI 管理 API 注册/启用 Pipe 失败；已回收本次资源。",
      );
    }
    const url = `http://127.0.0.1:${port}`;
    this.#urls.set(name, url);
    return { url, runtimeUsed: input.runtime };
  }

  async stopService(serviceId: string): Promise<void> {
    const owned = this.#owned.get(serviceId);
    if (owned === undefined) return; // 未拥有的服务 no-op
    if (owned.quarantined === true) {
      throw new WebuiPlatformError(
        "WEBUI_RESOURCE_QUARANTINED",
        "容器所有权仍无法核验；保留隔离记录，停止操作未触碰任何资源。",
      );
    }
    await this.#stopOwned(owned); // 失败即抛，保留所有权
    this.#owned.delete(serviceId);
    this.#urls.delete(serviceId);
  }

  #dockerArgs(
    name: string,
    dataDir: string,
    base: string,
    port: number,
    endpoint: string,
    ownershipNonce: string,
  ): string[] {
    const args = [
      "run",
      "-d",
      "--name",
      name,
      "--label",
      `mist.ownerNonce=${ownershipNonce}`,
      "--network",
      "host",
    ];
    args.push("--mount", `type=bind,source=${dataDir},target=/app/backend/data`);
    // 官方 backend/start.sh 用 HOST/PORT 决定 serve 绑定；host network 下必须显式 loopback。
    args.push("--env", "HOST=127.0.0.1", "--env", `PORT=${port}`);
    for (const [key, value] of Object.entries(WEBUI_TASK_ENV))
      args.push("--env", `${key}=${value}`);
    // 非秘密 base/端点内联；秘密 token/admin 密码用无值 --env，值只在 child env。
    args.push(
      "--env",
      `OPENAI_API_BASE_URL=${base}`,
      "--env",
      `MIST_ADAPTER_URL=${endpoint}`,
      "--env",
      "MIST_ADAPTER_TOKEN",
      "--env",
      "OPENAI_API_KEY",
      "--env",
      "WEBUI_ADMIN_EMAIL",
      "--env",
      "WEBUI_ADMIN_PASSWORD",
      WEBUI_DOCKER_IMAGE,
    );
    return args;
  }

  async #requirePython(): Promise<string> {
    const detected = await this.detectEnvironment();
    if (!detected.python || this.#pythonInterpreter === null) {
      throw new WebuiPlatformError(
        "WEBUI_PYTHON_UNAVAILABLE",
        "未找到 Python 3.11/3.12（含 venv）；请安装或用 Docker 路径。不要用 3.13。",
      );
    }
    return this.#pythonInterpreter;
  }

  /**
   * 有界 startup 健康等待（正常启动可慢；非完整重试恢复）：
   * 每轮先核 owner 存活/早退，再请求官方 `/health` 并校验状态体；adapter `/models` 仅额外
   * 证明该受限端点网络可达，绝不作为 UI ready。
   */
  async #awaitHealthy(name: string, kind: Runtime, port: number, base: string): Promise<boolean> {
    for (let attempt = 0; attempt < this.#healthMaxAttempts; attempt += 1) {
      if (kind === "docker") {
        const alive = await this.#runner.run({
          file: "docker",
          args: ["inspect", "-f", "{{.State.Running}}", name],
          env: {},
          timeoutMs: PROBE_TIMEOUT_MS,
        });
        if (alive.code !== 0 || alive.stdout.trim() !== "true") return false; // 早退
      } else if (!(await this.#runner.isProcessAlive(name))) {
        return false; // 早退
      }
      if (
        (await this.#healthOk(name, kind, port)) &&
        (await this.#adapterReachable(name, kind, base))
      ) {
        return true;
      }
      if (this.#healthPollIntervalMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.#healthPollIntervalMs));
      }
    }
    return false;
  }

  async #healthOk(name: string, kind: Runtime, port: number): Promise<boolean> {
    const args = ["-s", "-w", "\n%{http_code}", `http://127.0.0.1:${port}/health`];
    const result =
      kind === "docker"
        ? await this.#runner.run({
            file: "docker",
            args: ["exec", name, "curl", ...args],
            env: {},
            timeoutMs: PROBE_TIMEOUT_MS,
          })
        : await this.#runner.run({ file: "curl", args, env: {}, timeoutMs: PROBE_TIMEOUT_MS });
    if (result.code !== 0) return false;
    const lines = result.stdout.trim().split("\n");
    const status = lines.at(-1)?.trim() ?? "";
    const body = lines.slice(0, -1).join("\n");
    return status === "200" && /"status"\s*:\s*true/.test(body);
  }

  async #adapterReachable(name: string, kind: Runtime, base: string): Promise<boolean> {
    const args = ["-s", "-o", "/dev/null", "-w", "%{http_code}", `${base}/models`];
    const result =
      kind === "docker"
        ? await this.#runner.run({
            file: "docker",
            args: ["exec", name, "curl", ...args],
            env: {},
            timeoutMs: PROBE_TIMEOUT_MS,
          })
        : await this.#runner.run({ file: "curl", args, env: {}, timeoutMs: PROBE_TIMEOUT_MS });
    return this.#httpReachable(result);
  }

  #httpReachable(result: CommandResult): boolean {
    const status = result.stdout.trim();
    return result.code === 0 && /^\d{3}$/.test(status) && status !== "000";
  }

  async #cleanupOwned(name: string): Promise<WebuiPlatformError | null> {
    const owned = this.#owned.get(name);
    if (owned === undefined) return null;
    try {
      await this.#stopOwned(owned);
    } catch {
      return new WebuiPlatformError(
        "WEBUI_CLEANUP_FAILED",
        "启动失败后回收外部资源也失败；已保留所有权记录与真实隔离态，请手动清理后重试。",
      );
    }
    this.#owned.delete(name);
    this.#urls.delete(name);
    return null;
  }

  async #stopOwned(owned: OwnedService): Promise<void> {
    if (owned.kind === "docker") await this.#runner.stopContainer(owned.resourceName);
    else await this.#runner.stopProcess(owned.resourceName);
  }
}

/** 有界等待子进程真实退出；超时返回 false（不无限 await）。 */
function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

/** 生产真实执行器：真 spawn/exec；只继承必要环境；容器/进程所有权与幂等停止。 */
export class NodeCommandRunner implements CommandRunner {
  readonly #containers = new Map<string, string>();
  readonly #processes = new Map<string, ReturnType<typeof spawn>>();
  readonly #dockerBin: string;

  constructor(options: { dockerBin?: string } = {}) {
    this.#dockerBin = options.dockerBin ?? "docker";
  }

  run(invocation: CommandInvocation): Promise<CommandResult> {
    return new Promise((resolve) => {
      const child = spawn(invocation.file, [...invocation.args], {
        env: childEnv(invocation.env ?? {}),
        ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, invocation.timeoutMs ?? 30_000);
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.once("error", () => {
        clearTimeout(timer);
        resolve({ code: 127, stdout, stderr });
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, stdout, stderr });
      });
    });
  }

  async startContainer(
    invocation: CommandInvocation & { name: string },
  ): Promise<{ containerId: string }> {
    const result = await this.run(invocation);
    const reportedId = result.stdout.trim();
    if (result.code === 0 && reportedId.length > 0) {
      this.#containers.set(invocation.name, reportedId);
      return { containerId: reportedId };
    }
    const nonceArg = invocation.args.find((arg) => arg.startsWith("mist.ownerNonce="));
    const nonce = nonceArg?.slice("mist.ownerNonce=".length);
    if (nonce === undefined || nonce.length < 16) throw new WebuiContainerOwnershipError();
    const inspected = await this.run({
      file: this.#dockerBin,
      args: [
        "inspect",
        "--format",
        '{{.Id}} {{ index .Config.Labels "mist.ownerNonce" }}',
        invocation.name,
      ],
      env: {},
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (inspected.code !== 0) {
      if (/no such (object|container)/i.test(inspected.stderr))
        throw new Error("container start failed");
      throw new WebuiContainerOwnershipError();
    }
    const [actualId, actualNonce, extra] = inspected.stdout.trim().split(/\s+/);
    if (!actualId || actualNonce !== nonce || extra !== undefined)
      throw new WebuiContainerOwnershipError();
    this.#containers.set(invocation.name, actualId);
    if (result.code !== 0) throw new Error("container start failed");
    return { containerId: actualId };
  }

  startProcess(invocation: CommandInvocation & { name: string }): Promise<{ pid: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn(invocation.file, [...invocation.args], {
        env: childEnv(invocation.env ?? {}),
        ...(invocation.cwd === undefined ? {} : { cwd: invocation.cwd }),
        detached: true,
        stdio: ["ignore", "ignore", "ignore"],
      });
      // 立即登记尝试句柄：ready 前后 stop 都能拿到并等待真实退出。
      this.#processes.set(invocation.name, child);
      let settled = false;
      const ready: NodeJS.Timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.off("error", onError);
        child.off("exit", onExit);
        child.unref();
        resolve({ pid: child.pid ?? 0 });
      }, 1_500);
      const fail = (message: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(ready);
        child.off("error", onError);
        child.off("exit", onExit);
        this.#processes.delete(invocation.name);
        reject(new Error(message));
      };
      const onError = (): void => fail("service spawn failed");
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
        fail(`service exited early (${code ?? signal ?? "signal"})`);
      child.once("error", onError);
      child.once("exit", onExit);
    });
  }

  async stopContainer(name: string): Promise<void> {
    // 只收回本次真正拥有（成功返回 containerId）的容器；未知/no-op，不 rm 同名无关资源。
    const containerId = this.#containers.get(name);
    if (containerId === undefined) return;
    const result = await this.run({
      file: this.#dockerBin,
      args: ["rm", "-f", containerId],
      env: {},
      timeoutMs: 30_000,
    });
    if (result.code !== 0 && !/No such container/i.test(result.stderr)) {
      throw new Error("container stop failed");
    }
    this.#containers.delete(name);
  }

  async stopProcess(name: string): Promise<void> {
    const child = this.#processes.get(name);
    if (child === undefined) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      this.#processes.delete(name);
      return;
    }
    try {
      child.kill("SIGTERM");
    } catch {
      // 保留句柄，交由上层如实隔离。
      throw new Error("process stop failed");
    }
    if (await waitForExit(child, 2_000)) {
      this.#processes.delete(name);
      return;
    }
    try {
      child.kill("SIGKILL");
    } catch {
      throw new Error("process kill failed");
    }
    if (await waitForExit(child, 2_000)) {
      this.#processes.delete(name);
      return;
    }
    // 未确认退出：保留句柄，不假装已清理。
    throw new Error("process did not exit after SIGKILL");
  }

  async isProcessAlive(name: string): Promise<boolean> {
    const child = this.#processes.get(name);
    if (child === undefined || child.pid === undefined) return false;
    try {
      process.kill(child.pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
