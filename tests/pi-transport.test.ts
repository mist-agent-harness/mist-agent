/**
 * pi 通道传输单元测试：假 pi 回放 `--mode json` 事件形状，零网络、零真实凭据。
 * 钉住路由、密钥隔离、错误 fail-closed、流式增量、子进程生命周期和启动包渲染。
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ModelCompletionRequest,
  createModelTransport,
} from "../src/resident-runtime/channels.ts";
import {
  PiCliTransport,
  renderSystemPrompt,
  splitModelId,
} from "../src/resident-runtime/pi-transport.ts";

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

afterEach(() => {
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
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  const newline = input.indexOf("\\n");
  if (newline === -1) return;
  const command = JSON.parse(input.slice(0, newline));
  const promptPath = args[args.indexOf("--system-prompt") + 1];
  const recordPath = process.env.FAKE_PI_RECORD;
  if (recordPath) fs.writeFileSync(recordPath, JSON.stringify({
    pid: process.pid,
    args,
    message: command.message,
    systemPrompt: fs.readFileSync(promptPath, "utf8"),
    systemPromptPath: promptPath,
    systemPromptMode: fs.statSync(promptPath).mode & 0o777,
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
  emit({
    type: "turn_end",
    message: {
      role: "assistant",
      stopReason: mode === "turn-error" ? "error" : mode === "turn-aborted" ? "aborted" : "stop",
      errorMessage: mode === "turn-error" ? "private auth details" : undefined,
      content: [{ type: "text", text: finalText }],
    },
  });
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

async function waitForRecord(path: string): Promise<{ pid: number }> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as { pid: number };
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
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as {
      args: string[];
      message: string;
      systemPrompt: string;
      systemPromptPath: string;
      systemPromptMode: number;
    };
    expect(record.args).toContain("rpc");
    expect(record.args).toContain("--no-extensions");
    expect(record.args).not.toContain(message);
    expect(record.args.join(" ")).not.toContain("@/etc/passwd");
    expect(record.message).toBe(message);
    expect(record.systemPrompt).toBe(systemPrompt);
    expect(record.systemPromptMode).toBe(0o600);
    expect(() => readFileSync(record.systemPromptPath, "utf8")).toThrow();
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

  it("完整启动包与本代历史渲染进系统提示", async () => {
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
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as { systemPrompt: string };
    const prompt = record.systemPrompt;
    expect(prompt).toContain("小派");
    expect(prompt).toContain("每天写日报");
    expect(prompt).toContain("爱吃苹果");
    expect(prompt).toContain("偏好短句");
    expect(prompt).toContain("早安");
    expect(prompt).toContain("早");
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

  it("renderSystemPrompt：缺席与空的 currentFacts 明确不同", () => {
    const absent = renderSystemPrompt(request());
    const empty = renderSystemPrompt(
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
    expect(absent).not.toContain("现行有效事实");
    expect(empty).toContain("现行有效事实：\n（当前没有现行有效事实）");
  });

  it('createModelTransport("pi") 接真通道', () => {
    expect(createModelTransport("pi")).toBeInstanceOf(PiCliTransport);
    expect(createModelTransport("synthetic")).not.toBeInstanceOf(PiCliTransport);
  });
});
