import { createHash } from "node:crypto";
/**
 * D31-1 Open WebUI v0.11.4 **官方原生管理 API** 客户端（真实产品路径用）：
 * `POST /api/v1/auths/signin` → 内存 Bearer；`GET /api/v1/functions/list`（admin）判断本插件是否
 * 存在；`POST /api/v1/functions/create` 注册 `assets/openwebui/mist-pipe.py`；仅当 `is_active`
 * 为 false 时 `POST /api/v1/functions/id/{id}/toggle`；每步再 `GET .../id/{id}` 核验
 * active/type/owned-source。目标 URL 固定为 owned service 的 loopback；不跟随重定向；有界超时。
 *
 * 安全边界：token/密码只在内存与请求头；不写入任何账/提案/argv/URL/模板/日志；上游响应体与
 * 异常原文一律不回显、不进入错误消息（只给固定 code + 中文 remedy）。未知同 id 外部代码绝不
 * 覆写/冒充成功。管理 function id 必须是合法 Python identifier（不含连字符）。
 */
import type { WebuiRuntime } from "../../acceptance/frontend-adapter-driver.ts";

export type HttpFetch = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly redirect: "manual";
    readonly signal: AbortSignal;
  },
) => Promise<{ readonly status: number; text(): Promise<string> }>;

export class WebuiManagementError extends Error {
  readonly code: string;
  readonly remedy: string;
  constructor(code: string, remedy: string) {
    super(code);
    this.name = "WebuiManagementError";
    this.code = code;
    this.remedy = remedy;
  }
}

export const PIPE_FUNCTION_ID = "mist_openai_pipe";
export const PIPE_OWNER_META = "mist_openai_pipe";
export const PIPE_DESCRIPTION = "Mist 文字 adapter 桥（D31-1，仅纯文本）";

export interface WebuiManagementOutcome {
  readonly functionId: string;
  readonly created: boolean;
  readonly toggled: boolean;
}

export interface WebuiManagementRequest {
  readonly serviceId: string;
  readonly baseUrl: string;
  readonly email: string;
  readonly password: string;
}

export interface WebuiManagementApiOptions {
  readonly pipeSource: string;
  readonly fetcher?: HttpFetch;
  readonly functionId?: string;
  readonly requestTimeoutMs?: number;
}

interface ApiFunction {
  readonly id: string;
  readonly type: string;
  readonly is_active: boolean;
  readonly content?: string;
  readonly meta?: Record<string, unknown>;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const DEFAULT_TIMEOUT_MS = 15_000;

function defaultFetcher(): HttpFetch {
  return (url, init) =>
    fetch(url, {
      method: init.method,
      headers: init.headers,
      ...(init.body === undefined ? {} : { body: init.body }),
      redirect: init.redirect,
      signal: init.signal,
    }) as unknown as ReturnType<HttpFetch>;
}

/** 只接受 owned service 的 loopback base URL；拒绝外部 host。 */
function assertLoopback(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new WebuiManagementError(
      "WEBUI_MANAGEMENT_ENDPOINT_INVALID",
      "WebUI 管理端点不可解析；已拒绝把管理凭证发往未知地址。",
    );
  }
  if (parsed.protocol !== "http:" || !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new WebuiManagementError(
      "WEBUI_MANAGEMENT_ENDPOINT_UNTRUSTED",
      "WebUI 管理端点必须是本机 loopback；拒绝把 admin 凭证发往外部 host。",
    );
  }
  return baseUrl.replace(/\/+$/, "");
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asApiFunction(value: unknown): ApiFunction | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    typeof record.type !== "string" ||
    typeof record.is_active !== "boolean"
  )
    return null;
  return {
    id: record.id,
    type: record.type,
    is_active: record.is_active,
    ...(typeof record.content === "string" ? { content: record.content } : {}),
    ...(typeof record.meta === "object" && record.meta !== null
      ? { meta: record.meta as Record<string, unknown> }
      : {}),
  };
}

export class WebuiManagementApi {
  readonly #pipeSource: string;
  readonly #fetcher: HttpFetch;
  readonly #functionId: string;
  readonly #timeoutMs: number;

  constructor(options: WebuiManagementApiOptions) {
    this.#pipeSource = options.pipeSource;
    this.#fetcher = options.fetcher ?? defaultFetcher();
    this.#functionId = options.functionId ?? PIPE_FUNCTION_ID;
    this.#timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(this.#functionId)) {
      throw new WebuiManagementError(
        "WEBUI_MANAGEMENT_ID_INVALID",
        "管理 function id 必须是合法 Python identifier（仅字母/数字/下划线）；不含连字符。",
      );
    }
  }

  async ensurePipe(input: WebuiManagementRequest): Promise<WebuiManagementOutcome> {
    const base = assertLoopback(input.baseUrl);
    const token = await this.#signin(base, input.email, input.password);
    const functions = await this.#list(base, token);
    const existing = functions.find((fn) => fn.id === this.#functionId);

    let created = false;
    if (existing === undefined) {
      await this.#create(base, token);
      created = true;
    } else {
      const detail = await this.#getById(base, token, this.#functionId);
      if (detail === null) {
        // list 说有、getById 说没有：竞态/上游不一致，重试 create。
        await this.#create(base, token);
        created = true;
      } else if (!this.#owns(detail)) {
        throw new WebuiManagementError(
          "WEBUI_FUNCTION_OCCUPIED",
          `管理 id ${this.#functionId} 已被外部代码占用；不覆盖、不复用，请先手动处理该 function。`,
        );
      }
    }

    let verified = await this.#getById(base, token, this.#functionId);
    if (verified === null || !this.#owns(verified)) {
      throw new WebuiManagementError(
        "WEBUI_FUNCTION_REGISTER_FAILED",
        "Pipe 注册后未能核验为已拥有的 pipe；按注册失败处理。",
      );
    }
    let toggled = false;
    if (!verified.is_active) {
      await this.#toggle(base, token, this.#functionId);
      verified = await this.#getById(base, token, this.#functionId);
      if (verified === null || !this.#owns(verified) || !verified.is_active) {
        throw new WebuiManagementError(
          "WEBUI_FUNCTION_ENABLE_FAILED",
          "Pipe 启用未通过核验（active/type/owned-source）；按启用失败处理。",
        );
      }
      toggled = true;
    }
    return { functionId: this.#functionId, created, toggled };
  }

  #owns(fn: ApiFunction): boolean {
    if (fn.id !== this.#functionId || fn.type !== "pipe" || fn.content === undefined) return false;
    if (fn.meta === undefined || fn.meta.mistOwner !== PIPE_OWNER_META) return false;
    return this.#normalizePipeSource(fn.content) === this.#normalizePipeSource(this.#pipeSource);
  }

  #normalizePipeSource(source: string): string {
    // Open WebUI stores the submitted Python source verbatim. Hash actual source; markers are advisory.
    return createHash("sha256").update(source).digest("hex");
  }

  async #request(
    base: string,
    method: string,
    path: string,
    token: string | null,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const controller = new AbortController();
    let response: { status: number; text(): Promise<string> };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("deadline"));
      }, this.#timeoutMs);
    });
    try {
      response = await Promise.race([
        this.#fetcher(`${base}${path}`, {
          method,
          headers: {
            "Content-Type": "application/json",
            ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: "manual",
          signal: controller.signal,
        }),
        deadline,
      ]);
      const text = await Promise.race([response.text(), deadline]);
      return { status: response.status, body: safeJson(text) };
    } catch {
      // 不泄露异常原文（可能含 canary/上游细节）。
      throw new WebuiManagementError(
        "WEBUI_MANAGEMENT_UNREACHABLE",
        "WebUI 管理 API 不可达或超时；已按固定错误处理，请检查本机服务后重试。",
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async #signin(base: string, email: string, password: string): Promise<string> {
    const res = await this.#request(base, "POST", "/api/v1/auths/signin", null, {
      email,
      password,
    });
    const record = res.body as Record<string, unknown> | null;
    const token = record?.token;
    if (res.status !== 200 || typeof token !== "string" || token.length === 0) {
      throw new WebuiManagementError(
        "WEBUI_ADMIN_AUTH_FAILED",
        "以专属 admin 凭据登录 WebUI 失败；请核对该私有凭据面后重试，不要改 DB。",
      );
    }
    return token;
  }

  async #list(base: string, token: string): Promise<ApiFunction[]> {
    const res = await this.#request(base, "GET", "/api/v1/functions/list", token);
    // 401/403 是认证/权限失败，绝不能当成「没有 functions」。
    if (res.status === 401 || res.status === 403) {
      throw new WebuiManagementError(
        "WEBUI_ADMIN_AUTH_FAILED",
        "管理 API 拒绝本次凭据（401/403）；这不是「插件不存在」，请核对 admin 角色与凭据。",
      );
    }
    if (res.status !== 200 || !Array.isArray(res.body)) {
      throw new WebuiManagementError(
        "WEBUI_MANAGEMENT_LIST_FAILED",
        "读取 function 列表失败；按安装失败处理，不猜测插件已存在。",
      );
    }
    const functions: ApiFunction[] = [];
    for (const item of res.body) {
      const fn = asApiFunction(item);
      if (fn === null) {
        throw new WebuiManagementError(
          "WEBUI_MANAGEMENT_LIST_FAILED",
          "function 列表结构不完整；按管理 API 失败处理，不猜测插件缺失。",
        );
      }
      functions.push(fn);
    }
    return functions;
  }

  async #getById(base: string, token: string, id: string): Promise<ApiFunction | null> {
    const res = await this.#request(base, "GET", `/api/v1/functions/id/${id}`, token);
    if (res.status === 200) {
      const detail = asApiFunction(res.body);
      if (detail === null || detail.id !== id) {
        throw new WebuiManagementError(
          "WEBUI_FUNCTION_LOOKUP_FAILED",
          "function 详情结构不完整或 id 不匹配；拒绝按缺失处理。",
        );
      }
      return detail;
    }
    if (res.status === 401) return null; // 官方：不存在即 401 NOT_FOUND（不是 404）
    if (res.status === 403) {
      throw new WebuiManagementError(
        "WEBUI_ADMIN_AUTH_FAILED",
        "管理 API 拒绝读取该 function（403）；请核对 admin 角色与凭据。",
      );
    }
    throw new WebuiManagementError(
      "WEBUI_FUNCTION_LOOKUP_FAILED",
      "读取 function 详情失败；按安装失败处理，不当作未拥有。",
    );
  }

  async #create(base: string, token: string): Promise<void> {
    const res = await this.#request(base, "POST", "/api/v1/functions/create", token, {
      id: this.#functionId,
      name: "Mist (text)",
      content: this.#pipeSource,
      meta: { description: PIPE_DESCRIPTION, mistOwner: PIPE_OWNER_META },
    });
    if (res.status === 200 && asApiFunction(res.body) !== null) return;
    // create 可能因竞态 ID 已存在而 400：再核一次，拥有则视为已注册，否则如实失败。
    const raced = await this.#getById(base, token, this.#functionId);
    if (raced !== null && this.#owns(raced)) return;
    if (raced !== null) {
      throw new WebuiManagementError(
        "WEBUI_FUNCTION_OCCUPIED",
        `管理 id ${this.#functionId} 已被外部代码占用；不覆盖、不复用。`,
      );
    }
    throw new WebuiManagementError(
      "WEBUI_FUNCTION_CREATE_FAILED",
      "注册 Pipe function 失败；按安装失败处理（可能上游拒绝/内容非法）。",
    );
  }

  async #toggle(base: string, token: string, id: string): Promise<void> {
    const res = await this.#request(base, "POST", `/api/v1/functions/id/${id}/toggle`, token);
    if (res.status !== 200) {
      throw new WebuiManagementError(
        "WEBUI_FUNCTION_ENABLE_FAILED",
        "启用 Pipe function 失败；按启用失败处理。",
      );
    }
  }
}

/** 供平台与测试复用的运行时→管理路径类型别名。 */
export type WebuiManagementRuntime = WebuiRuntime;
