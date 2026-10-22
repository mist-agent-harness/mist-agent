/**
 * pi 通道传输单元测试：假 pi 回放 `--mode rpc` 事件形状，零网络、零真实凭据。
 * 钉住路由、密钥隔离、错误 fail-closed、流式增量、子进程生命周期和启动包渲染。
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ModelCompletionRequest,
  createModelTransport,
} from "../src/resident-runtime/channels.ts";
import {
  PiCliTransport,
  renderBootContextMessage,
  renderHistorySession,
  renderSystemPrompt,
  splitModelId,
} from "../src/resident-runtime/pi-transport.ts";
import { ResidentRuntime } from "../src/resident-runtime/runtime.ts";

/** 假 pi 记录下来的一个请求现场。 */
interface FakeRecord {
  pid: number;
  args: string[];
  message: string;
  systemPrompt: string;
  systemPromptPath: string;
  systemPromptMode: number;
  noSession: boolean;
  sessionPath: string | null;
  sessionMode: number | null;
  sessionDirMode: number | null;
  sessionRaw: string | null;
  agentDir: string;
  agentEntries: string[];
  agentSettings: {
    compaction?: { enabled?: boolean };
    packages?: unknown;
    reviewSetting?: string;
  } | null;
  agentModelsTarget: string | null;
}

interface SessionEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  message?: { role?: string; content?: unknown };
  content?: unknown;
  customType?: string;
}

/** 解析假 pi 读到的 session JSONL。 */
function parseSession(raw: string | null): SessionEntry[] {
  if (raw === null) return [];
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as SessionEntry);
}

/** 一条 message 条目 → {role, text}；text 按上游口径从 content 里取（块数组或串）。 */
function roleContentText(entry: SessionEntry | undefined): { role: string; text: string } {
  const message = entry?.message;
  if (message === undefined) throw new Error("no message entry");
  const content = message.content;
  let text: string;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content.map((block) => (block as { text?: string }).text ?? "").join("");
  } else {
    text = "";
  }
  return { role: String(message.role), text };
}

const tempDirs: string[] = [];
const RECORDED_SECRET_ENVS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "MISTRAL_API_KEY",
  "GROQ_API_KEY",
  "DEEPSEEK_API_KEY",
  "XAI_API_KEY",
  "QWEN_TOKEN_PLAN_API_KEY",
  "COPILOT_GITHUB_TOKEN",
  "PI_API_KEY",
];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mist-pi-transport-test-"));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  vi.stubEnv("PI_CODING_AGENT_DIR", tempDir());
});

afterEach(() => {
  vi.unstubAllEnvs();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** 假 pi：读取一条 RPC prompt 命令并按模式回放 JSONL 事件。 */
function fakePi(): { bin: string; recordPath: string } {
  const dir = tempDir();
  const bin = join(dir, "fake-pi.js");
  const recordPath = join(dir, "record.json");
  const envRecord = RECORDED_SECRET_ENVS.map(
    (name) => `${JSON.stringify(name)}: process.env[${JSON.stringify(name)}] ?? null`,
  ).join(",\n");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const mode = process.env.FAKE_PI_MODE ?? "ok";
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
const commands = [];
require("readline").createInterface({input:process.stdin}).on("line", (line) => {
  const command = JSON.parse(line);
  commands.push(command.type);
  if (command.type === "get_state") {
    emit({type:"response", id:command.id, command:"get_state", success:true,
      data: {autoCompactionEnabled: process.env.FAKE_PI_POLICY_ENABLED === "1"}});
    return;
  }
  const promptPath = args[args.indexOf("--system-prompt") + 1];
  const recordPath = process.env.FAKE_PI_RECORD;
  const sessionFlag = args.indexOf("--session");
  const sessionPath = sessionFlag === -1 ? null : args[sessionFlag + 1];
  if (recordPath) fs.writeFileSync(recordPath, JSON.stringify({
    pid: process.pid,
    args,
    message: command.message,
    systemPrompt: fs.readFileSync(promptPath, "utf8"),
    systemPromptPath: promptPath,
    systemPromptMode: fs.statSync(promptPath).mode & 0o777,
    noSession: args.includes("--no-session"),
    sessionPath,
    sessionMode: sessionPath ? (fs.statSync(sessionPath).mode & 0o777) : null,
    sessionDirMode: sessionPath ? (fs.statSync(require("path").dirname(sessionPath)).mode & 0o777) : null,
    sessionRaw: sessionPath ? fs.readFileSync(sessionPath, "utf8") : null,
    agentDir: process.env.PI_CODING_AGENT_DIR,
    agentEntries: fs.readdirSync(process.env.PI_CODING_AGENT_DIR),
    agentSettings: fs.existsSync(require("path").join(process.env.PI_CODING_AGENT_DIR,"settings.json"))
      ? JSON.parse(fs.readFileSync(require("path").join(process.env.PI_CODING_AGENT_DIR,"settings.json"),"utf8")) : null,
    agentModelsTarget: fs.existsSync(require("path").join(process.env.PI_CODING_AGENT_DIR,"models.json"))
      && fs.lstatSync(require("path").join(process.env.PI_CODING_AGENT_DIR,"models.json")).isSymbolicLink()
      ? fs.readlinkSync(require("path").join(process.env.PI_CODING_AGENT_DIR,"models.json")) : null,
    commands,
    secretEnvs: { ${envRecord} },
  }));
  if (mode === "crash") {
    process.stderr.write("private stderr canary");
    process.exit(3);
  }
  if (mode === "hang") {
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === "slow") {
    process.on("SIGTERM", () => {});
    emit({ type: "response", id: "mist-prompt", command: "prompt", success: true });
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "先发一段" } });
    setInterval(() => {}, 1000);
    return;
  }
  emit({ type: "response", id: "mist-prompt", command: "prompt", success: true });
  if (mode.startsWith("compact-")) {
    emit({ type: mode === "compact-start" ? "compaction_start" : "compaction_end", reason:"threshold" });
  }
  if (mode === "malformed") {
    process.stdout.write("{\\"type\\":\\"message_update\\"\\n");
    return;
  }
  if (mode === "error-event") {
    emit({ type: "error", message: "private error details" });
    return;
  }
  if (mode === "assistant-error-event") {
    emit({ type: "message_update", assistantMessageEvent: {
      type: "error",
      reason: "error",
      error: { role: "assistant", stopReason: "error", errorMessage: "private error details" },
    } });
    return;
  }
  if (mode === "stderr-error") process.stderr.write("Error: something on stderr\\n");
  if (mode === "stderr-inline-error") {
    process.stderr.write("prefix ".repeat(32));
    setTimeout(() => {
      const inline = "error was mentioned mid-line";
      process.stderr.write(inline + "x".repeat(128 - inline.length));
      setTimeout(() => process.stderr.write("\\ncontinuation\\n"), 20);
    }, 20);
  }
  if (mode === "incomplete") {
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "部分" } });
    process.exit(0);
  }
  const deltas = process.env.FAKE_PI_TEXT !== undefined
    ? [process.env.FAKE_PI_TEXT]
    : mode === "ordinary-error"
      ? ["Error: file not found, try the other path"]
      : mode === "turn-end-only"
        ? []
        : mode === "mismatch"
          ? ["streamed"]
          : ["你好", "，世界"];
  const finalText = mode === "mismatch" ? "different final" : deltas.join("") || "turn-end 完整回复";
  for (const delta of deltas) {
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
  }
  if (process.env.FAKE_PI_MESSAGE_USAGE !== undefined) emit({
    type: "message_end", message: {
      role: "assistant", stopReason: "stop", content: [{type:"text",text:finalText}],
      usage: JSON.parse(process.env.FAKE_PI_MESSAGE_USAGE),
    },
  });
  emit({
    type: "turn_end",
    message: {
      role: "assistant",
      stopReason: mode === "turn-error" ? "error" : mode === "turn-aborted" ? "aborted" : "stop",
      errorMessage: mode === "turn-error" ? "private auth details" : undefined,
      content: [{ type: "text", text: finalText }],
      ...(process.env.FAKE_PI_USAGE === undefined
        ? {}
        : { usage: JSON.parse(process.env.FAKE_PI_USAGE) }),
    },
  });
  // 重复终态（FAKE_PI_DUP_TURN_END=1）：验证 usage 不重复累计。
  if (process.env.FAKE_PI_DUP_TURN_END === "1") {
    emit({
      type: "turn_end",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: finalText }],
        ...(process.env.FAKE_PI_USAGE === undefined
          ? {}
          : { usage: JSON.parse(process.env.FAKE_PI_USAGE) }),
      },
    });
  }
  // 报完 usage 再在 stderr 报错（usage-then-stderr）：验证失败回合不报成功用量。
  if (mode === "usage-then-stderr") {
    process.stderr.write("Error: died after streaming\\n");
  }
  emit({ type: "agent_settled" });
});
`,
    "utf8",
  );
  chmodSync(bin, 0o755);
  return { bin, recordPath };
}

function request(overrides: Partial<ModelCompletionRequest> = {}): ModelCompletionRequest {
  return {
    residentId: "r-pi",
    adapterId: "pi-ai",
    model: "anthropic/claude-test",
    text: "在吗",
    bootPack: { residentId: "r-pi", identity: "小派", commitments: ["每天写日报"], memories: [] },
    history: [],
    credentialSecret: "sk-canary-pi-1",
    ...overrides,
  };
}

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

async function waitForExit(pid: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`child ${pid} did not exit`);
}

async function waitForRecord(path: string): Promise<FakeRecord> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as FakeRecord;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error("fake pi did not write its process record");
}

describe("PiCliTransport", () => {
  it("流式增量按序吐（≥2 段），拼接即完整回复", async () => {
    const { bin } = fakePi();
    const transport = new PiCliTransport({ piBin: bin });
    const chunks = await collect(transport.complete(request()));
    expect(chunks).toEqual(["你好", "，世界"]);
  });

  it("用户文本走 RPC stdin，argv 不含消息或系统提示正文；临时提示文件限权并清理", async () => {
    const { bin, recordPath } = fakePi();
    const transport = new PiCliTransport({ piBin: bin, extraEnv: { FAKE_PI_RECORD: recordPath } });
    const message = `${"x".repeat(200_000)} @/etc/passwd `;
    const systemHistory = "历史内容".repeat(40_000);
    const systemPrompt = renderSystemPrompt(
      request({ history: [{ role: "user", text: systemHistory }] }),
    );
    await collect(
      transport.complete(
        request({ text: message, history: [{ role: "user", text: systemHistory }] }),
      ),
    );
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as FakeRecord;
    expect(record.args).toContain("rpc");
    expect(record.args).toContain("--no-extensions");
    expect(record.args).not.toContain(message);
    expect(record.args.join(" ")).not.toContain("@/etc/passwd");
    expect(record.message).toBe(message);
    expect(record.systemPrompt).toBe(systemPrompt);
    expect(record.systemPromptMode).toBe(0o600);
    // 历史走 --session 文件、不进 argv；文件名带历史正文，权限收紧到 0600，目录 0700。
    expect(record.noSession).toBe(false);
    expect(record.sessionPath).not.toBeNull();
    expect(record.args.join(" ")).not.toContain(systemHistory);
    expect(record.sessionMode).toBe(0o600);
    expect(record.sessionDirMode).toBe(0o700);
    if (record.sessionPath === null) throw new Error("session path missing");
    expect(() => readFileSync(record.systemPromptPath, "utf8")).toThrow();
    // 退出后两个临时文件都清理。
    expect(() => readFileSync(record.sessionPath as string, "utf8")).toThrow();
  });

  it("provider 密钥变量映射到 pi-ai 定义的名称，不向未知 provider 回退", async () => {
    for (const [model, envName] of [
      ["deepseek/deepseek-chat", "DEEPSEEK_API_KEY"],
      ["xai/grok-test", "XAI_API_KEY"],
      ["qwen-token-plan/qwen-test", "QWEN_TOKEN_PLAN_API_KEY"],
    ] as const) {
      const { bin, recordPath } = fakePi();
      await collect(
        new PiCliTransport({ piBin: bin, extraEnv: { FAKE_PI_RECORD: recordPath } }).complete(
          request({ model }),
        ),
      );
      const record = JSON.parse(readFileSync(recordPath, "utf8")) as {
        secretEnvs: Record<string, string | null>;
      };
      expect(record.secretEnvs[envName]).toBe("sk-canary-pi-1");
      for (const name of RECORDED_SECRET_ENVS.filter((entry) => entry !== envName)) {
        expect(record.secretEnvs[name]).toBeNull();
      }
    }
    const { bin, recordPath } = fakePi();
    await expect(
      collect(
        new PiCliTransport({ piBin: bin, extraEnv: { FAKE_PI_RECORD: recordPath } }).complete(
          request({ model: "unknown-provider/model" }),
        ),
      ),
    ).rejects.toThrow(/unsupported provider/);
    expect(() => readFileSync(recordPath, "utf8")).toThrow();
  });

  it("Claude 订阅按 adapter 路由 bridge，清除父环境里的 provider keys", async () => {
    const { bin, recordPath } = fakePi();
    const transport = new PiCliTransport({
      piBin: bin,
      extraEnv: {
        FAKE_PI_RECORD: recordPath,
        ANTHROPIC_API_KEY: "ambient-anthropic-key",
        OPENAI_API_KEY: "ambient-openai-key",
        PI_API_KEY: "ambient-generic-key",
      },
    });
    await collect(
      transport.complete(request({ adapterId: "pi-claude-bridge", model: "claude-sonnet-4-5" })),
    );
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as {
      args: string[];
      secretEnvs: Record<string, string | null>;
    };
    expect(record.args[record.args.indexOf("--provider") + 1]).toBe("claude-bridge");
    expect(record.args[record.args.indexOf("--model") + 1]).toBe("claude-sonnet-4-5");
    expect(record.args).toContain("--no-extensions");
    expect(record.args).not.toContain("--extension");
    for (const name of RECORDED_SECRET_ENVS) expect(record.secretEnvs[name]).toBeNull();
    expect(record.args.join(" ")).not.toContain("sk-canary-pi-1");
  });

  it.each(["turn-error", "turn-aborted", "assistant-error-event"])(
    "依照 pi 结构化错误事件 fail-closed（%s）且不泄露错误原文",
    async (mode) => {
      const { bin } = fakePi();
      const transport = new PiCliTransport({ piBin: bin, extraEnv: { FAKE_PI_MODE: mode } });
      const completion = collect(transport.complete(request()));
      await expect(completion).rejects.toThrow(/回合未正常完成|assistant 回合失败/);
      await expect(completion).rejects.not.toThrow(/private auth details|private error details/);
    },
  );

  it("把普通 Error: 文本当作合法模型回复", async () => {
    const { bin } = fakePi();
    const chunks = await collect(
      new PiCliTransport({ piBin: bin, extraEnv: { FAKE_PI_MODE: "ordinary-error" } }).complete(
        request(),
      ),
    );
    expect(chunks).toEqual(["Error: file not found, try the other path"]);
  });
  it.each([
    "401 ways to cook rice",
    "The API key rotation policy is invalid for this tenant",
    "Unauthorized access requests should be logged",
  ])("合法回复文本不按认证错误误判：%s", async (text) => {
    const { bin } = fakePi();
    const chunks = await collect(
      new PiCliTransport({ piBin: bin, extraEnv: { FAKE_PI_TEXT: text } }).complete(request()),
    );
    expect(chunks.join("")).toBe(text);
  });

  it("最终 turn_end 含完整文本时，即使没有 text_delta 也能交付", async () => {
    const { bin } = fakePi();
    const chunks = await collect(
      new PiCliTransport({ piBin: bin, extraEnv: { FAKE_PI_MODE: "turn-end-only" } }).complete(
        request(),
      ),
    );
    expect(chunks).toEqual(["turn-end 完整回复"]);
  });

  it.each(["malformed", "incomplete", "error-event", "mismatch"])(
    "拒绝不完整或不一致的 JSONL 流（%s）",
    async (mode) => {
      const { bin } = fakePi();
      await expect(
        collect(
          new PiCliTransport({ piBin: bin, extraEnv: { FAKE_PI_MODE: mode } }).complete(request()),
        ),
      ).rejects.toThrow();
    },
  );

  it("非零退出抛安全错误，不把 stderr 原文带进异常", async () => {
    const { bin } = fakePi();
    const transport = new PiCliTransport({ piBin: bin, extraEnv: { FAKE_PI_MODE: "crash" } });
    const result = collect(transport.complete(request()));
    await expect(result).rejects.toThrow(/退出码 3/);
    await expect(result).rejects.not.toThrow(/private stderr canary/);
  });
  it("协议成功但 stderr 报错时 fail-closed 且不暴露 stderr 原文", async () => {
    const { bin } = fakePi();
    await expect(
      collect(
        new PiCliTransport({ piBin: bin, extraEnv: { FAKE_PI_MODE: "stderr-error" } }).complete(
          request(),
        ),
      ),
    ).rejects.toThrow(/stderr 报告错误/);
  });

  it("不把分块 stderr 中行中间的 error 误判为行首错误", async () => {
    const { bin } = fakePi();
    const chunks = await collect(
      new PiCliTransport({
        piBin: bin,
        extraEnv: { FAKE_PI_MODE: "stderr-inline-error" },
      }).complete(request()),
    );
    expect(chunks).toEqual(["你好", "，世界"]);
  });

  it("pi 可执行文件不存在时安全失败", async () => {
    const transport = new PiCliTransport({ piBin: join(tempDir(), "missing-pi") });
    await expect(collect(transport.complete(request()))).rejects.toThrow(/子进程启动失败/);
  });
  it("空 API 凭证在启动子进程前 fail-closed", async () => {
    const { bin, recordPath } = fakePi();
    const transport = new PiCliTransport({ piBin: bin, extraEnv: { FAKE_PI_RECORD: recordPath } });
    await expect(collect(transport.complete(request({ credentialSecret: "" })))).rejects.toThrow(
      /empty credential/,
    );
    expect(() => readFileSync(recordPath, "utf8")).toThrow();
  });

  it("超时后杀掉挂起的 pi 子进程", async () => {
    const { bin, recordPath } = fakePi();
    const transport = new PiCliTransport({
      piBin: bin,
      timeoutMs: 1_000,
      extraEnv: { FAKE_PI_MODE: "hang", FAKE_PI_RECORD: recordPath },
    });
    await expect(collect(transport.complete(request()))).rejects.toThrow(/运行超时/);
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as { pid: number };
    await waitForExit(record.pid);
  });

  it("消费方提前停止迭代时会杀掉 pi 子进程", async () => {
    const { bin, recordPath } = fakePi();
    const transport = new PiCliTransport({
      piBin: bin,
      extraEnv: { FAKE_PI_MODE: "slow", FAKE_PI_RECORD: recordPath },
    });
    const iterator = transport.complete(request())[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ done: false, value: "先发一段" });
    await iterator.return?.();
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as {
      pid: number;
      systemPromptPath: string;
    };
    await waitForExit(record.pid);
    expect(() => readFileSync(record.systemPromptPath, "utf8")).toThrow();
  });
  it("首个增量到达前调用 return 立即终止 pi 子进程", async () => {
    const { bin, recordPath } = fakePi();
    const transport = new PiCliTransport({
      piBin: bin,
      timeoutMs: 5_000,
      extraEnv: { FAKE_PI_MODE: "hang", FAKE_PI_RECORD: recordPath },
    });
    const iterator = transport.complete(request())[Symbol.asyncIterator]();
    const pendingNext = iterator.next().then(
      () => ({ status: "fulfilled" as const }),
      () => ({ status: "rejected" as const }),
    );
    const record = await waitForRecord(recordPath);
    const returnPromise = iterator.return?.();
    if (returnPromise === undefined) throw new Error("transport iterator has no return method");
    let deadline: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        returnPromise,
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error("iterator.return() timed out")), 1_500);
        }),
      ]);
    } finally {
      if (deadline !== undefined) clearTimeout(deadline);
    }
    await waitForExit(record.pid);
    await expect(pendingNext).resolves.toEqual({ status: "rejected" });
  });

  it("启动包按布局分流：身份+信进系统提示，动态材料与历史进 session（历史退出系统提示）", async () => {
    const { bin, recordPath } = fakePi();
    const transport = new PiCliTransport({ piBin: bin, extraEnv: { FAKE_PI_RECORD: recordPath } });
    await collect(
      transport.complete(
        request({
          bootPack: {
            residentId: "r-pi",
            identity: "小派",
            commitments: ["每天写日报"],
            memories: [{ id: "m1", content: "爱吃苹果", supersededBy: null }],
            currentFacts: [
              {
                seq: 1,
                ts: "2026-01-01T00:00:00.000Z",
                author: "system",
                kind: "confirmed_preference",
                body: "偏好短句",
                supersedesSeq: null,
              },
            ],
          },
          history: [
            { role: "user", text: "早安" },
            { role: "assistant", text: "早" },
          ],
        }),
      ),
    );
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as FakeRecord;
    // 稳定系统前缀只有身份（这里没有信）；历史与动态材料都不在系统提示里。
    expect(record.systemPrompt).toContain("小派");
    expect(record.systemPrompt).not.toContain("每天写日报");
    expect(record.systemPrompt).not.toContain("爱吃苹果");
    expect(record.systemPrompt).not.toContain("早安");
    // 历史与动态材料进 session 文件：历史角色/顺序/正文保留，动态材料在历史前的 context。
    const entries = parseSession(record.sessionRaw);
    const messages = entries.filter((entry) => entry.type === "message");
    expect(roleContentText(messages[0])).toEqual({ role: "user", text: "早安" });
    expect(roleContentText(messages[1])).toEqual({ role: "assistant", text: "早" });
    const dynamic = entries.find((entry) => entry.type === "custom_message");
    expect(String(dynamic?.content)).toContain("每天写日报");
    expect(String(dynamic?.content)).toContain("爱吃苹果");
    expect(String(dynamic?.content)).toContain("- [#1] 偏好短句");
    expect(record.noSession).toBe(false);
  });
});

/**
 * #227 第 1 项：结构化历史走 session JSONL，按官方 schema 生成，上游可保留每条正文。
 * 抓的是「把历史折成字符串丢进系统提示 / 把 assistant.content 写成 string」这类未修形状。
 */
describe("#227 结构化历史 session（role/content 形状与顺序）", () => {
  it("dynamic context retains a stable system authority binding while current data changes", () => {
    const first = request({
      bootPack: {
        residentId: "r-pi",
        identity: "synthetic",
        commitments: ["old constraint"],
        memories: [],
      },
    });
    const next = request({ bootPack: { ...first.bootPack, commitments: ["current constraint"] } });
    expect(renderSystemPrompt(first)).toBe(renderSystemPrompt(next));
    expect(renderSystemPrompt(next)).toContain("生效约束只能按正常流程解除");
    expect(renderSystemPrompt(next)).not.toContain("current constraint");
    expect(renderBootContextMessage(next)).toContain("由 Mist 从真源投影");
    expect(renderBootContextMessage(next)).toContain("current constraint");
  });
  it("assistant 历史条目是块数组（不是 string）——string 会被上游当空回复丢掉", async () => {
    const { bin, recordPath } = fakePi();
    await collect(
      new PiCliTransport({ piBin: bin, extraEnv: { FAKE_PI_RECORD: recordPath } }).complete(
        request({
          bootPack: { residentId: "r-pi", identity: "小派", commitments: [], memories: [] },
          history: [
            { role: "user", text: "第一问" },
            { role: "assistant", text: "第一答" },
          ],
        }),
      ),
    );
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as FakeRecord;
    const entries = parseSession(record.sessionRaw);
    const assistant = entries.find((entry) => entry.message?.role === "assistant");
    // 形状钉死：assistant.content 必须是数组，且第一块是文本块。
    expect(Array.isArray(assistant?.message?.content)).toBe(true);
    expect((assistant?.message?.content as unknown[])[0]).toEqual({
      type: "text",
      text: "第一答",
    });
    // assistant 必填 metadata 在场（bridge/pi-ai 转换需要），但 usage 是零占位（非实测）。
    const message = assistant?.message as Record<string, unknown>;
    expect(typeof message.api).toBe("string");
    expect(typeof message.provider).toBe("string");
    expect(message.stopReason).toBe("stop");
    expect(message.usage).toMatchObject({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("历史保持原角色、顺序与文本；当前 user 单独且仅一次（不进 session）", async () => {
    const { bin, recordPath } = fakePi();
    const history = [
      { role: "user" as const, text: "甲问" },
      { role: "assistant" as const, text: "甲答" },
      { role: "user" as const, text: "乙问" },
      { role: "assistant" as const, text: "乙答" },
    ];
    const current = "丙问（当前）";
    await collect(
      new PiCliTransport({ piBin: bin, extraEnv: { FAKE_PI_RECORD: recordPath } }).complete(
        request({
          bootPack: { residentId: "r-pi", identity: "小派", commitments: [], memories: [] },
          text: current,
          history,
        }),
      ),
    );
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as FakeRecord;
    const messages = parseSession(record.sessionRaw).filter((entry) => entry.type === "message");
    expect(messages.map(roleContentText)).toEqual([
      { role: "user", text: "甲问" },
      { role: "assistant", text: "甲答" },
      { role: "user", text: "乙问" },
      { role: "assistant", text: "乙答" },
    ]);
    // 当前 user 只在 RPC prompt 里出现一次，不在 session 历史里。
    expect(record.message).toBe(current);
    expect(record.sessionRaw ?? "").not.toContain(current);
  });

  it("session 是合法 v3 JSONL：header + parentId 线性链 + 首部 custom context（动态材料）", () => {
    const raw = renderHistorySession(
      request({
        bootPack: {
          residentId: "r-pi",
          identity: "小派",
          commitments: ["每天写日报"],
          memories: [],
          currentFacts: [],
        },
        history: [
          { role: "user", text: "甲问" },
          { role: "assistant", text: "甲答" },
        ],
      }),
    );
    const entries = parseSession(raw);
    expect(entries[0]).toMatchObject({ type: "session", version: 3 });
    const chain = entries.slice(1);
    expect(chain).toHaveLength(3);
    expect(chain.every((entry) => typeof entry.id === "string" && entry.id.length > 0)).toBe(true);
    expect(chain[0]?.parentId).toBeNull();
    for (let i = 1; i < chain.length; i += 1) {
      expect(chain[i]?.parentId).toBe(chain[i - 1]?.id);
    }
    expect(chain[0]?.type).toBe("custom_message");
    expect(String(chain[0]?.content)).toContain("每天写日报");
  });

  it("pi-ai 与 bridge 两路用同一个 session（不换住户、不换角色）；bridge 也拿到 assistant 正文", async () => {
    for (const adapterId of ["pi-ai", "pi-claude-bridge"] as const) {
      const { bin, recordPath } = fakePi();
      await collect(
        new PiCliTransport({
          piBin: bin,
          extraEnv: {
            FAKE_PI_RECORD: recordPath,
          },
        }).complete(
          request({
            adapterId,
            model: adapterId === "pi-claude-bridge" ? "claude-sonnet-4-5" : "anthropic/claude-test",
            bootPack: { residentId: "r-pi", identity: "小派", commitments: [], memories: [] },
            history: [
              { role: "user", text: "你还记得吗" },
              { role: "assistant", text: "记得。" },
            ],
          }),
        ),
      );
      const record = JSON.parse(readFileSync(recordPath, "utf8")) as FakeRecord;
      const messages = parseSession(record.sessionRaw).filter((entry) => entry.type === "message");
      expect(messages.map(roleContentText)).toEqual([
        { role: "user", text: "你还记得吗" },
        { role: "assistant", text: "记得。" },
      ]);
      expect(record.args[record.args.indexOf("--provider") + 1]).toBe(
        adapterId === "pi-claude-bridge" ? "claude-bridge" : "anthropic",
      );
    }
  });

  it("无历史且无动态材料时不建 session（退回单轮 --no-session）", async () => {
    const { bin, recordPath } = fakePi();
    await collect(
      new PiCliTransport({ piBin: bin, extraEnv: { FAKE_PI_RECORD: recordPath } }).complete(
        request({
          bootPack: { residentId: "r-pi", identity: "小派", commitments: [], memories: [] },
          history: [],
        }),
      ),
    );
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as FakeRecord;
    expect(record.noSession).toBe(true);
    expect(record.sessionPath).toBeNull();
  });

  it("失败/取消时临时 session 文件与目录都被清理", async () => {
    const { bin, recordPath } = fakePi();
    const transport = new PiCliTransport({
      piBin: bin,
      extraEnv: { FAKE_PI_MODE: "hang", FAKE_PI_RECORD: recordPath },
    });
    const iterator = transport
      .complete(
        request({
          bootPack: { residentId: "r-pi", identity: "小派", commitments: [], memories: [] },
          history: [{ role: "user", text: "这段历史要能被清理" }],
        }),
      )
      [Symbol.asyncIterator]();
    const pending = iterator.next().then(
      () => "settled",
      () => "rejected",
    );
    const record = await waitForRecord(recordPath);
    if (record.sessionPath === null) throw new Error("session path missing");
    const sessionPath = record.sessionPath;
    const dirPath = join(sessionPath, "..");
    await iterator.return?.(undefined);
    await waitForExit(record.pid);
    await expect(pending).resolves.toBe("rejected");
    expect(() => readFileSync(sessionPath, "utf8")).toThrow();
    expect(existsSync(dirPath)).toBe(false);
  });
});

describe("#231 policy and history regressions", () => {
  it("keeps the session cwd stable across real transport turns", async () => {
    const { bin, recordPath } = fakePi();
    const transport = new PiCliTransport({ piBin: bin, extraEnv: { FAKE_PI_RECORD: recordPath } });
    await collect(transport.complete(request()));
    const first = JSON.parse(readFileSync(recordPath, "utf8")) as FakeRecord;
    await collect(transport.complete(request({ history: [{ role: "user", text: "prior" }] })));
    const second = JSON.parse(readFileSync(recordPath, "utf8")) as FakeRecord;
    expect(parseSession(first.sessionRaw)[0]).toMatchObject({ cwd: process.cwd() });
    expect(parseSession(second.sessionRaw)[0]).toMatchObject({ cwd: process.cwd() });
  });

  it("projects settings without installed packages and without copying private Pi state", async () => {
    const original = tempDir();
    const settings = JSON.stringify({
      compaction: { enabled: true },
      packages: ["npm:pi-claude-bridge", "git:https://example.invalid/extension.git"],
      reviewSetting: "preserve-me",
    });
    const models = JSON.stringify({ providers: { synthetic: { models: [] } } });
    writeFileSync(join(original, "settings.json"), settings);
    writeFileSync(join(original, "models.json"), models);
    writeFileSync(join(original, "auth.json"), '{"anthropic":{"apiKey":"AUTH-CANARY"}}');
    writeFileSync(join(original, "trust.json"), '{"project":"TRUST-CANARY"}');
    writeFileSync(join(original, "models-store.json"), '{"dynamic":"MODEL-CANARY"}');
    const { bin, recordPath } = fakePi();
    await collect(
      new PiCliTransport({
        piBin: bin,
        extraEnv: { FAKE_PI_RECORD: recordPath, PI_CODING_AGENT_DIR: original },
      }).complete(request()),
    );
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as FakeRecord & {
      commands: string[];
    };
    expect(record.agentSettings).toMatchObject({
      compaction: { enabled: false },
      reviewSetting: "preserve-me",
    });
    expect(record.agentSettings).not.toHaveProperty("packages");
    expect(record.agentEntries.sort()).toEqual(["models.json", "settings.json"]);
    expect(record.agentModelsTarget).toBe(join(original, "models.json"));
    expect(record.commands).toEqual(["get_state", "prompt"]);
    expect(record.agentDir).not.toBe(original);
    expect(existsSync(record.agentDir)).toBe(false);
    expect(readFileSync(join(original, "settings.json"), "utf8")).toBe(settings);
    expect(readFileSync(join(original, "models.json"), "utf8")).toBe(models);
    expect(readFileSync(join(original, "auth.json"), "utf8")).toContain("AUTH-CANARY");
    expect(readFileSync(join(original, "trust.json"), "utf8")).toContain("TRUST-CANARY");
    expect(readFileSync(join(original, "models-store.json"), "utf8")).toContain("MODEL-CANARY");
  });

  it("expands PI_CODING_AGENT_DIR='~' like pi and projects that root", async () => {
    const home = tempDir();
    const original = home;
    writeFileSync(
      join(home, "settings.json"),
      JSON.stringify({ compaction: { enabled: true }, reviewSetting: "home-settings" }),
    );
    const { bin, recordPath } = fakePi();
    await collect(
      new PiCliTransport({
        piBin: bin,
        extraEnv: {
          FAKE_PI_RECORD: recordPath,
          PI_CODING_AGENT_DIR: "~",
          HOME: home,
        },
      }).complete(request()),
    );
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as FakeRecord;
    expect(record.agentDir).not.toBe(original);
    expect(record.agentSettings).toMatchObject({
      compaction: { enabled: false },
      reviewSetting: "home-settings",
    });
  });

  it("reports malformed settings without echoing their contents and never starts pi", async () => {
    const original = tempDir();
    writeFileSync(join(original, "settings.json"), '{"secret":"SETTINGS-CONTENT-CANARY",');
    const { bin, recordPath } = fakePi();
    const completion = collect(
      new PiCliTransport({
        piBin: bin,
        extraEnv: { FAKE_PI_RECORD: recordPath, PI_CODING_AGENT_DIR: original },
      }).complete(request()),
    );
    await expect(completion).rejects.toThrow(/settings\.json 不是有效 JSON/);
    await expect(completion).rejects.not.toThrow(/SETTINGS-CONTENT-CANARY/);
    expect(existsSync(recordPath)).toBe(false);
  });

  it("reports unreadable settings specifically and never starts pi", async () => {
    const original = tempDir();
    mkdirSync(join(original, "settings.json"));
    const { bin, recordPath } = fakePi();
    await expect(
      collect(
        new PiCliTransport({
          piBin: bin,
          extraEnv: { FAKE_PI_RECORD: recordPath, PI_CODING_AGENT_DIR: original },
        }).complete(request()),
      ),
    ).rejects.toThrow(/settings\.json 不可读取/);
    expect(existsSync(recordPath)).toBe(false);
  });

  it("settings projection failure does not invoke the model", async () => {
    const original = tempDir();
    writeFileSync(join(original, "settings.json"), "{not-json");
    const { bin, recordPath } = fakePi();
    const calls: unknown[] = [];
    await expect(
      collect(
        new PiCliTransport({
          piBin: bin,
          extraEnv: { FAKE_PI_RECORD: recordPath, PI_CODING_AGENT_DIR: original },
        }).complete(request({ onUsage: (usage) => calls.push(usage) })),
      ),
    ).rejects.toThrow(/settings\.json 不是有效 JSON/);
    expect(calls).toEqual([]);
    expect(existsSync(recordPath)).toBe(false);
  });

  it("refuses an effective compaction policy that is still enabled before any prompt", async () => {
    const { bin, recordPath } = fakePi();
    await expect(
      collect(
        new PiCliTransport({
          piBin: bin,
          extraEnv: { FAKE_PI_RECORD: recordPath, FAKE_PI_POLICY_ENABLED: "1" },
        }).complete(request()),
      ),
    ).rejects.toThrow(/compaction|压缩/);
    expect(existsSync(recordPath)).toBe(false);
  });

  it.each([
    { mode: "compact-start", event: "compaction_start" },
    { mode: "compact-end", event: "compaction_end" },
  ])("rejects $event before committing a runtime turn", async ({ mode }) => {
    const { bin } = fakePi();
    const runtime = new ResidentRuntime({
      dataDir: tempDir(),
      transport: new PiCliTransport({ piBin: bin, extraEnv: { FAKE_PI_MODE: mode } }),
    });
    try {
      const candidate = runtime.createCandidate({
        residentId: "review-compact",
        persona: "synthetic",
        proposedBy: { kind: "installer", id: "test" },
      });
      runtime.attestCandidate(
        candidate.candidateId,
        { kind: "candidate", candidateId: candidate.candidateId },
        "accepted",
      );
      runtime.provisionChannel({
        residentId: "review-compact",
        channel: {
          claudeSubscription: false,
          credentialKind: "api-key",
          model: "anthropic/claude-test",
        },
        canarySecret: "SYNTHETIC-KEY",
      });
      expect(await runtime.say({ residentId: "review-compact", text: "current" })).toMatchObject({
        ok: false,
        error: { code: "channel-unavailable" },
      });
      expect(runtime.readStream({ residentId: "review-compact" })).toMatchObject({
        ok: false,
        error: { code: "stream-not-found" },
      });
    } finally {
      await runtime.close();
    }
  });
});

/**
 * #227 第 2 项：usage 只搬运上游终态报出来的数字；缺失=未知、不补零；失败/取消不报成功
 * 用量；重复终态不重复累计；非法/非有限值不算数；只保留字段 allowlist。
 */
describe("#227 逐回合 usage 观察口", () => {
  function usageOf(text: string): Promise<unknown[]> {
    const collected: unknown[] = [];
    const { bin } = fakePi();
    return collect(
      new PiCliTransport({ piBin: bin, extraEnv: { FAKE_PI_MODE: "ok" } }).complete(
        request({
          text,
          bootPack: { residentId: "r-pi", identity: "小派", commitments: [], memories: [] },
          onUsage: (usage) => collected.push(usage),
        }),
      ),
    ).then(() => collected);
  }

  async function usageWith(env: Record<string, string>): Promise<unknown[]> {
    const collected: unknown[] = [];
    const { bin } = fakePi();
    await collect(
      new PiCliTransport({ piBin: bin, extraEnv: env }).complete(
        request({
          bootPack: { residentId: "r-pi", identity: "小派", commitments: [], memories: [] },
          onUsage: (usage) => collected.push(usage),
        }),
      ),
    );
    return collected;
  }

  it("上游终态报 usage 时原样转述（含显式 0），未知字段不出现", async () => {
    const collected = await usageWith({
      FAKE_PI_USAGE: JSON.stringify({
        input: 12,
        output: 3,
        cacheRead: 0,
        cacheWrite: 7,
        totalTokens: 22,
        cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
      }),
    });
    expect(collected).toEqual([
      { input: 12, output: 3, cacheRead: 0, cacheWrite: 7, totalTokens: 22, costTotal: 0.03 },
    ]);
  });

  it("部分字段：只保留上游报了的字段，缺的记为未知（不补零）", async () => {
    const collected = await usageWith({
      FAKE_PI_USAGE: JSON.stringify({ input: 5, output: 1 }),
    });
    expect(collected).toEqual([{ input: 5, output: 1 }]);
  });

  it("message_end usage is retained when turn_end omits it, and partial terminal fields merge once", async () => {
    expect(
      await usageWith({ FAKE_PI_MESSAGE_USAGE: JSON.stringify({ input: 8, cacheRead: 0 }) }),
    ).toEqual([{ input: 8, cacheRead: 0 }]);
    expect(
      await usageWith({
        FAKE_PI_MESSAGE_USAGE: JSON.stringify({ input: 8, cacheRead: 0 }),
        FAKE_PI_USAGE: JSON.stringify({ output: 2 }),
      }),
    ).toEqual([{ input: 8, cacheRead: 0, output: 2 }]);
  });

  it("fractional and unsafe token counters are unknown while fractional reported cost remains valid", async () => {
    expect(
      await usageWith({
        FAKE_PI_USAGE: JSON.stringify({
          input: 1.5,
          output: Number.MAX_SAFE_INTEGER + 1,
          cacheRead: 0,
          cost: { total: 0.002 },
        }),
      }),
    ).toEqual([{ cacheRead: 0, costTotal: 0.002 }]);
  });

  it("上游没报 usage 就一次都不回调（未知，不是零）", async () => {
    const collected = await usageOf("在吗");
    expect(collected).toEqual([]);
  });

  it("非法/非有限计数不算数（负数、NaN、字符串、null 都不进结果）", async () => {
    const collected = await usageWith({
      FAKE_PI_USAGE: JSON.stringify({
        input: -5,
        output: "3",
        cacheRead: null,
        cacheWrite: 4,
      }),
    });
    expect(collected).toEqual([{ cacheWrite: 4 }]);
  });

  it("重复终态事件不重复累计：onUsage 只回调一次", async () => {
    const collected = await usageWith({
      FAKE_PI_USAGE: JSON.stringify({ input: 9, output: 2 }),
      FAKE_PI_DUP_TURN_END: "1",
    });
    expect(collected).toEqual([{ input: 9, output: 2 }]);
  });

  it.each(["turn-error", "usage-then-stderr"])("失败回合不报成功用量（%s）", async (mode) => {
    const collected: unknown[] = [];
    const { bin } = fakePi();
    await expect(
      collect(
        new PiCliTransport({
          piBin: bin,
          extraEnv: {
            FAKE_PI_MODE: mode,
            FAKE_PI_USAGE: JSON.stringify({ input: 100, output: 50 }),
          },
        }).complete(
          request({
            bootPack: { residentId: "r-pi", identity: "小派", commitments: [], memories: [] },
            onUsage: (usage) => collected.push(usage),
          }),
        ),
      ),
    ).rejects.toThrow();
    expect(collected).toEqual([]);
  });

  it("取消（消费方提前 return）不报成功用量", async () => {
    const collected: unknown[] = [];
    const { bin, recordPath } = fakePi();
    const iterator = new PiCliTransport({
      piBin: bin,
      extraEnv: {
        FAKE_PI_MODE: "slow",
        FAKE_PI_RECORD: recordPath,
        FAKE_PI_USAGE: JSON.stringify({ input: 1, output: 1 }),
      },
    })
      .complete(
        request({
          bootPack: { residentId: "r-pi", identity: "小派", commitments: [], memories: [] },
          onUsage: (usage) => collected.push(usage),
        }),
      )
      [Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    await iterator.return?.(undefined);
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as { pid: number };
    await waitForExit(record.pid);
    expect(collected).toEqual([]);
  });
});

describe("pi 通道的解析件", () => {
  it("splitModelId：provider/model 与裸 model", () => {
    expect(splitModelId("claude-bridge/claude-haiku-4-5")).toEqual({
      provider: "claude-bridge",
      model: "claude-haiku-4-5",
    });
    expect(splitModelId("model-alpha")).toEqual({ provider: "", model: "model-alpha" });
  });

  it("renderBootContextMessage：缺席与空的 currentFacts 明确不同", () => {
    const absent = renderBootContextMessage(
      request({
        bootPack: { residentId: "r-pi", identity: "小派", commitments: [], memories: [] },
      }),
    );
    const empty = renderBootContextMessage(
      request({
        bootPack: {
          residentId: "r-pi",
          identity: "小派",
          commitments: [],
          memories: [],
          currentFacts: [],
        },
      }),
    );
    // 没接账 = null（不渲染），接了空账 = 明确的「没有现行有效事实」文本。
    expect(absent).toBeNull();
    expect(empty).toBe(
      "本轮宿主上下文（由 Mist 从真源投影）：\n现行有效事实：\n（当前没有现行有效事实）",
    );
  });

  it("renderSystemPrompt：交接信随启动包渲染，保留标题 / 署名 / 时间 / 三档原文", () => {
    const prompt = renderSystemPrompt(
      request({
        bootPack: {
          residentId: "r-pi",
          identity: "小派",
          commitments: [],
          memories: [],
          letter: {
            title: "第 1 代交接信（r-pi）",
            author: "r-pi#1",
            writtenAt: "2026-09-30T12:00:00.000Z",
            state: [
              { tier: "commitment", body: "承诺每天写日报" },
              { tier: "fact", body: "上代在做迁移" },
            ],
            intent: [{ tier: "judgment", body: "接续以本信为锚" }],
          },
        },
      }),
    );
    // 标题是召回锚点、署名是写信那一代、writtenAt 是当刻时间。
    expect(prompt).toContain("上一代交接信：第 1 代交接信（r-pi）");
    expect(prompt).toContain("r-pi#1");
    expect(prompt).toContain("2026-09-30T12:00:00.000Z");
    expect(prompt).toContain("必须继承，只能按正常流程解除");
    expect(prompt).toContain("以现实为准，可查证，不必尊重前任");
    expect(prompt).toContain("你有权不同意，且不续写前任对自己行为的事后分析");
    // 条目正文与 tier 原样呈现，不转写。
    expect(prompt).toContain("- [commitment] 承诺每天写日报");
    expect(prompt).toContain("- [fact] 上代在做迁移");
    expect(prompt).toContain("- [judgment] 接续以本信为锚");
  });

  it("renderSystemPrompt：没有信就不出现交接信分区（缺席即缺席）", () => {
    expect(renderSystemPrompt(request())).not.toContain("上一代交接信");
    expect(
      renderSystemPrompt(request({ bootPack: { ...request().bootPack, letter: null } })),
    ).not.toContain("上一代交接信");
  });

  it('createModelTransport("pi") 接真通道', () => {
    expect(createModelTransport("pi")).toBeInstanceOf(PiCliTransport);
    expect(createModelTransport("synthetic")).not.toBeInstanceOf(PiCliTransport);
  });
});
