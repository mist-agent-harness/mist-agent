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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelCompletionRequest, ModelTransport } from "./channels.ts";
/** provider → pi-ai 使用的密钥环境变量名。 */
const PROVIDER_SECRET_ENV: Readonly<Record<string, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  mistral: "MISTRAL_API_KEY",
  groq: "GROQ_API_KEY",
  "ant-ling": "ANT_LING_API_KEY",
  "qwen-token-plan": "QWEN_TOKEN_PLAN_API_KEY",
  "qwen-token-plan-cn": "QWEN_TOKEN_PLAN_CN_API_KEY",
  "qwen-token-plan-individual": "QWEN_TOKEN_PLAN_API_KEY",
  "azure-openai-responses": "AZURE_OPENAI_API_KEY",
  nvidia: "NVIDIA_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  "google-vertex": "GOOGLE_CLOUD_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  xai: "XAI_API_KEY",
  radius: "RADIUS_API_KEY",
  "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
  zai: "ZAI_API_KEY",
  "zai-coding-cn": "ZAI_CODING_CN_API_KEY",
  minimax: "MINIMAX_API_KEY",
  "minimax-cn": "MINIMAX_CN_API_KEY",
  moonshotai: "MOONSHOT_API_KEY",
  "moonshotai-cn": "MOONSHOT_API_KEY",
  huggingface: "HF_TOKEN",
  fireworks: "FIREWORKS_API_KEY",
  together: "TOGETHER_API_KEY",
  baseten: "BASETEN_API_KEY",
  opencode: "OPENCODE_API_KEY",
  "opencode-go": "OPENCODE_API_KEY",
  "kimi-coding": "KIMI_API_KEY",
  meta: "META_API_KEY",
  "cloudflare-workers-ai": "CLOUDFLARE_API_KEY",
  "cloudflare-ai-gateway": "CLOUDFLARE_API_KEY",
  xiaomi: "XIAOMI_API_KEY",
  "xiaomi-token-plan-cn": "XIAOMI_TOKEN_PLAN_CN_API_KEY",
  "xiaomi-token-plan-ams": "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
  "xiaomi-token-plan-sgp": "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
  "github-copilot": "COPILOT_GITHUB_TOKEN",
  "amazon-bedrock": "AWS_BEARER_TOKEN_BEDROCK",
};

const INHERITED_SECRET_ENV_NAMES = new Set([
  ...Object.values(PROVIDER_SECRET_ENV),
  "PI_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GCLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_DEFAULT_PROFILE",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
]);
const MAX_JSON_LINE_BYTES = 8 * 1024 * 1024;
const MAX_REPLY_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const FORCE_KILL_GRACE_MS = 1_000;

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

  complete(request: ModelCompletionRequest): AsyncIterable<string> {
    const controller = new AbortController();
    const source = this.#complete(request, controller.signal);
    return {
      [Symbol.asyncIterator](): AsyncIterator<string, void, unknown> {
        const iterator = source[Symbol.asyncIterator]();
        return {
          next: (value?: unknown) => iterator.next(value),
          return: (value?: void | PromiseLike<void>) => {
            controller.abort();
            return iterator.return?.(value) ?? Promise.resolve({ done: true, value: undefined });
          },
          throw: (error?: unknown) => {
            controller.abort();
            return iterator.throw?.(error) ?? Promise.reject(error);
          },
        };
      },
    };
  }

  async *#complete(request: ModelCompletionRequest, signal: AbortSignal): AsyncGenerator<string> {
    if (signal.aborted) throw new Error("pi 请求已取消");
    const parsed = splitModelId(request.model);
    const isClaudeBridge = request.adapterId === "pi-claude-bridge";
    const provider = isClaudeBridge ? "claude-bridge" : parsed.provider;
    const secretEnvName = PROVIDER_SECRET_ENV[provider];

    if (!isClaudeBridge && request.credentialSecret.length === 0) {
      throw new Error("pi API-key transport refused an empty credential");
    }
    if (!isClaudeBridge && secretEnvName === undefined) {
      throw new Error("pi API-key transport refused an unsupported provider");
    }

    // 只清理/设置本次路由需要的凭证，避免把其他 provider 的环境密钥交给 pi。
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.#extraEnv };
    for (const name of INHERITED_SECRET_ENV_NAMES) delete env[name];
    if (!isClaudeBridge && secretEnvName !== undefined) {
      env[secretEnvName] = request.credentialSecret;
    }

    // system prompt 可能包含整代历史，不能放 argv；目录 0700、文件 0600，退出后删除。
    const promptDir = mkdtempSync(join(tmpdir(), "mist-pi-prompt-"));
    const promptPath = join(promptDir, "system-prompt.txt");
    try {
      writeFileSync(promptPath, renderSystemPrompt(request), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    } catch {
      rmSync(promptDir, { recursive: true, force: true });
      throw new Error("pi 系统提示准备失败");
    }

    const args = [
      "--mode",
      "rpc",
      "--no-extensions",
      "--no-tools",
      "--no-session",
      "--no-context-files",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--thinking",
      "off",
      "--provider",
      provider,
      "--model",
      parsed.model,
      "--system-prompt",
      promptPath,
    ];

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(this.#piBin, args, {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      rmSync(promptDir, { recursive: true, force: true });
      throw new Error("pi 子进程启动失败");
    }

    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let spawnFailure = false;
    let stdinFailure = false;
    let stderrHadError = false;
    let stderrTail = "";
    let closed = false;
    let timedOut = false;
    let resolveClosed: (() => void) | undefined;
    const closedPromise = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const spawnReady = new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", () => {
        spawnFailure = true;
        reject(new Error("pi 子进程启动失败"));
      });
    });
    child.stdin?.once("error", () => {
      stdinFailure = true;
    });
    child.once("close", (code, signal) => {
      exitCode = code;
      exitSignal = signal;
      closed = true;
      resolveClosed?.();
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      const text = stderrTail + chunk;
      if (/(?:^|\r?\n)\s*(?:error|fatal|uncaught exception)\b/i.test(text)) {
        stderrHadError = true;
      }
      stderrTail = text.slice(-128);
    });

    let forceKillTimer: NodeJS.Timeout | undefined;
    const killChild = (): void => {
      if (closed || child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      if (forceKillTimer === undefined) {
        forceKillTimer = setTimeout(() => {
          if (!closed && child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
        }, FORCE_KILL_GRACE_MS);
        forceKillTimer.unref();
      }
    };
    let resolveAborted: (() => void) | undefined;
    const abortedPromise = new Promise<void>((resolve) => {
      resolveAborted = resolve;
    });
    const onAbort = (): void => {
      killChild();
      resolveAborted?.();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, this.#timeoutMs);
    timeoutTimer.unref();

    const commandId = "mist-prompt";
    const command = `${JSON.stringify({ type: "prompt", id: commandId, message: request.text })}\n`;
    let reply = "";
    let promptAcknowledged = false;
    let finalTurnSeen = false;
    let finalText: string | null = null;
    let agentSettled = false;
    let lineBuffer = "";

    const processLine = (line: string): string[] => {
      if (Buffer.byteLength(line, "utf8") > MAX_JSON_LINE_BYTES) {
        throw new Error("pi 输出行超过安全上限");
      }
      let parsedEvent: unknown;
      try {
        parsedEvent = JSON.parse(line);
      } catch {
        throw new Error("pi 输出不是有效 JSONL");
      }
      if (!isRecord(parsedEvent) || typeof parsedEvent.type !== "string") {
        throw new Error("pi 输出协议无效");
      }

      if (parsedEvent.type === "response") {
        if (
          parsedEvent.command !== "prompt" ||
          parsedEvent.id !== commandId ||
          typeof parsedEvent.success !== "boolean"
        ) {
          throw new Error("pi prompt 响应协议无效");
        }
        if (!parsedEvent.success) throw new Error("pi 通道请求未被接受");
        promptAcknowledged = true;
        return [];
      }

      if (parsedEvent.type === "error" || parsedEvent.type === "extension_error") {
        throw new Error("pi 通道返回错误事件");
      }
      if (parsedEvent.type === "agent_settled") {
        agentSettled = true;
        child.stdin?.end();
        return [];
      }
      if (parsedEvent.type === "turn_end") {
        const message = parsedEvent.message;
        if (
          !isRecord(message) ||
          (message.stopReason !== "stop" && message.stopReason !== "length")
        ) {
          throw new Error("pi 回合未正常完成");
        }
        finalText = extractAssistantText(message);
        if (finalText === null) throw new Error("pi 最终消息结构无效");
        finalTurnSeen = true;
        return [];
      }
      if (parsedEvent.type === "message_update") {
        if (!isRecord(parsedEvent.assistantMessageEvent)) {
          throw new Error("pi 消息更新结构无效");
        }
        const messageEvent = parsedEvent.assistantMessageEvent;
        if (messageEvent.type === "error") throw new Error("pi assistant 回合失败");
        if (messageEvent.type !== "text_delta") return [];
        if (typeof messageEvent.delta !== "string") {
          throw new Error("pi 文本增量结构无效");
        }
        const delta = messageEvent.delta;
        reply += delta;
        if (Buffer.byteLength(reply, "utf8") > MAX_REPLY_BYTES) {
          throw new Error("pi 回复超过安全上限");
        }
        return delta.length === 0 ? [] : [delta];
      }
      if (parsedEvent.type === "extension_ui_request") {
        throw new Error("pi 通道请求了不支持的交互");
      }
      return [];
    };

    const readFinalText = (): string | null => finalText;
    try {
      await Promise.race([spawnReady, abortedPromise]);
      if (signal.aborted) throw new Error("pi 请求已取消");
      const stdin = child.stdin;
      if (stdin === null || child.stdout === null) {
        throw new Error("pi 子进程管道不可用");
      }
      await new Promise<void>((resolve, reject) => {
        stdin.write(command, (error?: Error | null) => {
          if (error !== undefined && error !== null) reject(error);
          else resolve();
        });
      }).catch(() => {
        if (signal.aborted) throw new Error("pi 请求已取消");
        throw new Error("pi prompt 发送失败");
      });

      child.stdout.setEncoding("utf8");
      for await (const chunk of child.stdout) {
        lineBuffer += chunk;
        let newline = lineBuffer.indexOf("\n");
        while (newline !== -1) {
          const line = lineBuffer.slice(0, newline).replace(/\r$/, "");
          lineBuffer = lineBuffer.slice(newline + 1);
          if (line.length === 0) throw new Error("pi 输出包含空 JSONL 行");
          for (const ready of processLine(line)) yield ready;
          newline = lineBuffer.indexOf("\n");
        }
        if (Buffer.byteLength(lineBuffer, "utf8") > MAX_JSON_LINE_BYTES) {
          throw new Error("pi 输出行超过安全上限");
        }
      }
      if (!signal.aborted && lineBuffer.length > 0) {
        for (const ready of processLine(lineBuffer.replace(/\r$/, ""))) yield ready;
      }

      await closedPromise;
      if (signal.aborted) throw new Error("pi 请求已取消");
      if (spawnFailure) throw new Error("pi 子进程启动失败");
      if (stdinFailure) throw new Error("pi 子进程通信失败");
      if (timedOut) throw new Error(`pi 运行超时（${this.#timeoutMs} ms）`);
      if (exitCode !== 0) {
        const status = exitSignal === null ? `退出码 ${String(exitCode)}` : `信号 ${exitSignal}`;
        throw new Error(`pi ${status}`);
      }
      if (stderrHadError) throw new Error("pi 子进程在 stderr 报告错误");
      const completedText = readFinalText();
      if (!promptAcknowledged || !finalTurnSeen || !agentSettled || completedText === null) {
        throw new Error("pi JSONL 流未完整结束");
      }
      if (reply.length > 0 && reply !== completedText) {
        throw new Error("pi 增量与最终消息不一致");
      }
      if (completedText.trim().length === 0) throw new Error("pi 没有产出任何文本");
      if (reply.length === 0) yield completedText;
    } finally {
      clearTimeout(timeoutTimer);
      signal.removeEventListener("abort", onAbort);
      if (!closed && child.exitCode === null && child.signalCode === null) {
        killChild();
        await closedPromise;
      }
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      rmSync(promptDir, { recursive: true, force: true });
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractAssistantText(message: unknown): string | null {
  if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
    return null;
  }
  const text: string[] = [];
  for (const part of message.content) {
    if (!isRecord(part)) return null;
    if (part.type === "text") {
      if (typeof part.text !== "string") return null;
      text.push(part.text);
    }
  }
  return text.join("");
}
