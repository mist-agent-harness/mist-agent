/**
 * pi 通道传输（D25）：把一条消息交给用户 `pi install` 装的模型栈跑一个回合。
 *
 * 分工（「mist 当宿主，pi 当零件库」）：mist 不内置、不 fork、不 submodule 任何
 * pi 扩展——本传输只 spawn 用户机器上的 `pi` 公共 CLI（`--print --mode json`），
 * 由 pi 自己解析它装的 provider（pi-ai 的 anthropic/openai/... 或 pi-claude-bridge）。
 * Claude 订阅是唯一特例：走 pi-claude-bridge 时**没有密钥**（Claude Code 自己的
 * 登录态），其余通道的密钥经**环境变量**进子进程。
 *
 * 凭证纪律（RT-06）：密钥原文不进 argv（ps 看得见）、不落盘、不打日志——
 * 只进子进程环境变量；子进程退出即消失。
 *
 * 事件口径（pi `--mode json`，实测样谱）：`message_update.assistantMessageEvent`
 * 是 pi-ai 的助手事件流——`text_start` / `text_delta{delta}` / `text_end{content}`，
 * 本传输只把 `text_delta` 的增量吐给上层；`turn_end` 收尾。上游把认证失败当普通
 * 回复文本吐出来（exit 0），所以按前缀 fail-closed 判失败，不把「登录过期」
 * 当住户的回复落账。
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { ModelCompletionRequest, ModelTransport } from "./channels.ts";

/** provider → 密钥环境变量名（pi 的 provider 各自认的那把钥匙）。 */
const PROVIDER_SECRET_ENV: Readonly<Record<string, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  mistral: "MISTRAL_API_KEY",
  groq: "GROQ_API_KEY",
};

/** 上游把认证失败当普通回复吐出来（实测）：这些前缀是通道故障，不是住户的回复。 */
const FAILURE_PREFIXES = ["Failed to authenticate", "Error:", "error:", "AuthenticationError"];

export interface PiCliTransportOptions {
  /** pi 可执行文件；测试注入假 pi。缺省 PATH 里的 `pi`。 */
  piBin?: string;
  /** 子进程附加环境（测试用）。 */
  extraEnv?: Readonly<Record<string, string>>;
}

export class PiCliTransport implements ModelTransport {
  readonly #piBin: string;
  readonly #extraEnv: Readonly<Record<string, string>>;

  constructor(options: PiCliTransportOptions = {}) {
    this.#piBin = options.piBin ?? "pi";
    this.#extraEnv = options.extraEnv ?? {};
  }

  async *complete(request: ModelCompletionRequest): AsyncIterable<string> {
    const { provider, model } = splitModelId(request.model);
    // 密钥只走环境变量（RT-06）：claude-bridge 走订阅登录、没有密钥，别把
    // 任何东西塞给它；其余 provider 按各家的环境变量名送。
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.#extraEnv };
    if (provider !== "claude-bridge" && request.credentialSecret.length > 0) {
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
      model,
      "--system-prompt",
      renderSystemPrompt(request),
      "--",
      request.text,
    ];
    const child = spawn(this.#piBin, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderrTail = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-2000);
    });

    let reply = "";
    let exitCode: number | null = null;
    let exitFailure: string | null = null;
    child.on("error", (error) => {
      exitFailure = error.message;
    });
    child.on("close", (code) => {
      exitCode = code;
    });

    const lines = createInterface({ input: child.stdout });
    for await (const line of lines) {
      const event = parseJsonLine(line);
      if (event === null) continue;
      const inner = (event as { assistantMessageEvent?: { type?: string; delta?: unknown } })
        .assistantMessageEvent;
      if (inner?.type === "text_delta" && typeof inner.delta === "string") {
        reply += inner.delta;
        yield inner.delta;
      }
    }
    // 收尾判失败：exit 非 0、进程起不来、上游把认证失败当回复吐——都不算真回复。
    await new Promise<void>((resolve) => {
      if (exitCode !== null || exitFailure !== null) resolve();
      else child.on("close", () => resolve());
    });
    if (exitFailure !== null) {
      throw new Error(`pi 起不来：${String(exitFailure)}`);
    }
    if (exitCode !== 0) {
      throw new Error(`pi 退出码 ${String(exitCode)}：${stderrTail.trim() || "无错误输出"}`);
    }
    const trimmed = reply.trim();
    if (trimmed.length === 0) {
      throw new Error("pi 没有产出任何文本增量");
    }
    for (const prefix of FAILURE_PREFIXES) {
      if (trimmed.startsWith(prefix)) {
        throw new Error(`pi 通道故障：${trimmed.slice(0, 200)}`);
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
 * 把完整启动包 + 本代历史渲染进系统提示：身份、承诺、记忆、现行有效事实、
 * 此前对话都随这一条请求进模型（验收席意见 1 的口径；currentFacts 缺席 =
 * 没接账，照旧不编空）。
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
  if (pack.currentFacts !== undefined && pack.currentFacts.length > 0) {
    parts.push(`现行有效事实：\n${pack.currentFacts.map((item) => `- ${item.body}`).join("\n")}`);
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
