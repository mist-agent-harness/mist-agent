/**
 * pi 通道传输（D25）：把一条消息交给用户 `pi install` 装的模型栈跑一个回合。
 *
 * mist 不内置、不 fork、不 submodule 任何 pi 扩展；本传输只 spawn 用户机器上的
 * `pi` 公共 CLI。Claude 订阅按已解析的 adapter 路由到 pi-claude-bridge，其余走 pi-ai。
 *
 * 凭证纪律（RT-06）：密钥原文不进 argv、不落盘、不进入错误文本；API key 只进入
 * 对应 provider 的子进程环境变量。Claude bridge 不接收任何 provider API key，
 * 使用 Claude Code 自己的登录态。
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { ModelCompletionRequest, ModelTransport } from "./channels.ts";

/** provider → pi-ai 使用的密钥环境变量名。 */
const PROVIDER_SECRET_ENV: Readonly<Record<string, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  mistral: "MISTRAL_API_KEY",
  groq: "GROQ_API_KEY",
};

const INHERITED_SECRET_ENV_NAMES = [
  ...new Set([...Object.values(PROVIDER_SECRET_ENV), "PI_API_KEY"]),
];
const DEFAULT_TIMEOUT_MS = 120_000;
const FORCE_KILL_GRACE_MS = 1_000;

/** 上游会把一部分认证失败当普通回复文本吐出；只判回复开头，避免误判正文引用。 */
const FAILURE_PREFIXES = [
  "Failed to authenticate",
  "Error:",
  "error:",
  "AuthenticationError",
  "401",
  "403",
  "HTTP 401",
  "HTTP 403",
  "Unauthorized",
  "Forbidden",
  "Invalid API key",
  "Invalid key",
  "Incorrect API key",
  "API key is invalid",
  "API key is incorrect",
  "API key has expired",
  "The API key is invalid",
  "Your API key is invalid",
  "OAuth",
  "Authentication",
  "Authorization",
];

const FAILURE_PATTERNS = [
  /^failed to authenticate\b/i,
  /^error:/i,
  /^authenticationerror\b/i,
  /^(?:http\s+)?(?:401|403)\b/i,
  /^(?:unauthorized|forbidden)\b/i,
  /^(?:invalid|incorrect)\s+(?:api\s+)?key\b/i,
  /^(?:the\s+|your\s+)?api[\s_-]*key\b.*\b(?:invalid|incorrect|expired|revoked|rejected|unauthorized|denied)\b/i,
  /^(?:oauth|authentication|authorization)\b.*\b(?:expired|invalid|failed|error|denied|unauthorized|revoked)\b/i,
];

export interface PiCliTransportOptions {
  /** pi 可执行文件；测试注入假 pi。缺省 PATH 里的 `pi`。 */
  piBin?: string;
  /** 子进程附加环境（测试用）；provider 凭证变量仍会按路由清理。 */
  extraEnv?: Readonly<Record<string, string>>;
  /** 子进程最长运行时间，默认 120 秒。 */
  timeoutMs?: number;
}

export class PiCliTransport implements ModelTransport {
  readonly #piBin: string;
  readonly #extraEnv: Readonly<Record<string, string>>;
  readonly #timeoutMs: number;

  constructor(options: PiCliTransportOptions = {}) {
    this.#piBin = options.piBin ?? "pi";
    this.#extraEnv = options.extraEnv ?? {};
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new RangeError("pi timeoutMs must be a positive finite number");
    }
  }

  async *complete(request: ModelCompletionRequest): AsyncIterable<string> {
    const parsed = splitModelId(request.model);
    const isClaudeBridge = request.adapterId === "pi-claude-bridge";
    const provider = isClaudeBridge ? "claude-bridge" : parsed.provider;

    if (!isClaudeBridge && request.credentialSecret.length === 0) {
      throw new Error("pi API-key transport refused an empty credential");
    }

    // 不把父进程或测试注入环境里其他通道的 key 带给子进程，只加当前 API 通道所需的一把。
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.#extraEnv };
    for (const name of INHERITED_SECRET_ENV_NAMES) delete env[name];
    if (!isClaudeBridge) {
      env[PROVIDER_SECRET_ENV[provider] ?? "PI_API_KEY"] = request.credentialSecret;
    }

    const args = [
      "--print",
      "--mode",
      "json",
      "--no-tools",
      "--no-session",
      "--no-context-files",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--thinking",
      "off",
      ...(provider === "" ? [] : ["--provider", provider]),
      "--model",
      parsed.model,
      "--system-prompt",
      renderSystemPrompt(request),
      "--",
      request.text,
    ];
    const child = spawn(this.#piBin, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let spawnFailure: Error | null = null;
    let closed = false;
    let timedOut = false;
    let resolveClosed: (() => void) | undefined;
    const closedPromise = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    child.once("error", (error) => {
      spawnFailure = error;
    });
    child.once("close", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      closed = true;
      resolveClosed?.();
    });

    // stderr 只排空，不保留或放进异常：扩展可能回显提示或其他敏感材料。
    child.stderr?.resume();

    let forceKillTimer: NodeJS.Timeout | undefined;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, FORCE_KILL_GRACE_MS);
        forceKillTimer.unref();
      }
    }, this.#timeoutMs);
    timeoutTimer.unref();

    const lines = createInterface({ input: child.stdout });
    let reply = "";
    let pendingChunks: string[] = [];
    let streamingStarted = false;
    let recognizedFailure = false;

    try {
      for await (const line of lines) {
        const event = parseJsonLine(line);
        if (event === null) continue;
        const inner = (event as { assistantMessageEvent?: { type?: string; delta?: unknown } })
          .assistantMessageEvent;
        if (inner?.type !== "text_delta" || typeof inner.delta !== "string") continue;

        const delta = inner.delta;
        reply += delta;
        if (recognizedFailure) continue;

        if (streamingStarted) {
          yield delta;
          continue;
        }

        // 在回复开头仍可能是认证错误前缀时暂存；识别失败后不会把错误文本 yield 出去。
        pendingChunks.push(delta);
        if (isChannelFailure(reply)) {
          recognizedFailure = true;
          pendingChunks = [];
          continue;
        }
        if (couldBeFailurePrefix(reply)) continue;

        streamingStarted = true;
        for (const pending of pendingChunks) yield pending;
        pendingChunks = [];
      }

      await closedPromise;
      if (spawnFailure !== null) throw new Error("pi 子进程启动失败");
      if (timedOut) throw new Error(`pi 运行超时（${this.#timeoutMs} ms）`);
      if (exitCode !== 0) {
        const status = exitSignal === null ? `退出码 ${String(exitCode)}` : `信号 ${exitSignal}`;
        throw new Error(`pi ${status}`);
      }
      if (recognizedFailure || isChannelFailure(reply)) {
        throw new Error("pi 通道认证失败；请检查凭证或订阅登录状态");
      }
      if (reply.trim().length === 0) {
        throw new Error("pi 没有产出任何文本增量");
      }
      // 回复较短且一直可能匹配错误前缀时，EOF 后确认不是失败再交付。
      for (const pending of pendingChunks) yield pending;
      pendingChunks = [];
    } finally {
      clearTimeout(timeoutTimer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      lines.close();
      // 消费方提前停止 async iterable 时，不能把 pi 子进程留在后台；忽略 TERM 时升级到 KILL。
      if (!closed && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        const cancellationKillTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, FORCE_KILL_GRACE_MS);
        cancellationKillTimer.unref();
        await closedPromise;
        clearTimeout(cancellationKillTimer);
      }
    }
  }
}

/** `provider/model` → pi 的 --provider/--model；裸 model 让 pi 自己解析。 */
export function splitModelId(model: string): { provider: string; model: string } {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return { provider: "", model };
  return { provider: model.slice(0, slash), model: model.slice(slash + 1) };
}

/**
 * 把完整启动包 + 本代历史渲染进系统提示。currentFacts 缺席 = 没接账；空数组 = 权威事实账为空。
 */
export function renderSystemPrompt(request: ModelCompletionRequest): string {
  const parts: string[] = [];
  const pack = request.bootPack;
  parts.push(`你是住户 ${pack.identity}（${pack.residentId}）。`);
  if (pack.commitments.length > 0) {
    parts.push(`承诺：\n${pack.commitments.map((item) => `- ${item}`).join("\n")}`);
  }
  if (pack.memories.length > 0) {
    parts.push(`记忆：\n${pack.memories.map((item) => `- ${item.content}`).join("\n")}`);
  }
  if (pack.currentFacts !== undefined) {
    const facts =
      pack.currentFacts.length === 0
        ? "（当前没有现行有效事实）"
        : pack.currentFacts.map((item) => `- ${item.body}`).join("\n");
    parts.push(`现行有效事实：\n${facts}`);
  }
  if (request.history.length > 0) {
    parts.push(
      `本代此前对话：\n${request.history
        .map((item) => `${item.role === "user" ? "用户" : "你"}：${item.text}`)
        .join("\n")}`,
    );
  }
  return parts.join("\n\n");
}

function isChannelFailure(reply: string): boolean {
  const trimmed = reply.trimStart();
  return FAILURE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

function couldBeFailurePrefix(reply: string): boolean {
  const trimmed = reply.trimStart().toLowerCase();
  return FAILURE_PREFIXES.some((prefix) => prefix.toLowerCase().startsWith(trimmed));
}

function parseJsonLine(line: string): unknown | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // 非 JSON 行（扩展的启动噪声等）不进解析口径。
    return null;
  }
}
