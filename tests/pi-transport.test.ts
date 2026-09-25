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
  "PI_API_KEY",
] as const;

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

/** 假 pi：记录 argv / 环境变量并按模式回放事件或维持挂起。 */
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
if (process.env.FAKE_PI_RECORD) {
  fs.writeFileSync(process.env.FAKE_PI_RECORD, JSON.stringify({
    pid: process.pid,
    args,
    secretEnvs: { ${envRecord} },
  }));
}
if (mode === "crash") {
  process.stderr.write("private stderr canary");
  process.exit(3);
}
if (mode === "hang") {
  setInterval(() => {}, 1000);
} else if (mode === "slow") {
  process.on("SIGTERM", () => {});
  process.stdout.write(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "先发一段" } }) + "\\n");
  setInterval(() => {}, 1000);
} else {
  const deltas = mode === "authfail"
    ? ["Failed to auth", "enticate: OAuth session expired"]
    : mode === "authfail401"
      ? ["HTTP ", "401 Unauthorized: token expired"]
      : mode === "authfail-api-key"
        ? ["API key is ", "invalid: token revoked"]
        : ["你好", "，世界"];
  const out = [
    { type: "session", version: 3, id: "fake", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/" },
    { type: "agent_start" },
    { type: "turn_start" },
  ];
  for (const delta of deltas) {
    out.push({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta } });
  }
  out.push({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_end", contentIndex: 0, content: deltas.join("") } });
  out.push({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: deltas.join("") }] } });
  out.push({ type: "agent_settled" });
  process.stdout.write(out.map((event) => JSON.stringify(event)).join("\\n") + "\\n");
}
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

describe("PiCliTransport", () => {
  it("流式增量按序吐（≥2 段），拼接即完整回复", async () => {
    const { bin } = fakePi();
    const transport = new PiCliTransport({ piBin: bin });
    const chunks = await collect(transport.complete(request()));
    expect(chunks).toEqual(["你好", "，世界"]);
  });

  it("API key 只进当前 provider 的环境变量，不进 argv 或其他 provider 环境变量", async () => {
    const { bin, recordPath } = fakePi();
    const transport = new PiCliTransport({ piBin: bin, extraEnv: { FAKE_PI_RECORD: recordPath } });
    await collect(transport.complete(request()));
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as {
      args: string[];
      secretEnvs: Record<string, string | null>;
    };
    expect(record.args.join(" ")).not.toContain("sk-canary-pi-1");
    expect(record.secretEnvs.ANTHROPIC_API_KEY).toBe("sk-canary-pi-1");
    for (const name of RECORDED_SECRET_ENVS.filter((key) => key !== "ANTHROPIC_API_KEY")) {
      expect(record.secretEnvs[name]).toBeNull();
    }
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

  it.each(["authfail", "authfail401", "authfail-api-key"])(
    "认证失败（%s）不 yield 错误文本且 fail-closed",
    async (mode) => {
      const { bin } = fakePi();
      const transport = new PiCliTransport({ piBin: bin, extraEnv: { FAKE_PI_MODE: mode } });
      const emitted: string[] = [];
      await expect(async () => {
        for await (const chunk of transport.complete(request())) emitted.push(chunk);
      }).rejects.toThrow(/认证失败/);
      expect(emitted).toEqual([]);
    },
  );

  it("非零退出抛安全错误，不把 stderr 原文带进异常", async () => {
    const { bin } = fakePi();
    const transport = new PiCliTransport({ piBin: bin, extraEnv: { FAKE_PI_MODE: "crash" } });
    const result = collect(transport.complete(request()));
    await expect(result).rejects.toThrow(/退出码 3/);
    await expect(result).rejects.not.toThrow(/private stderr canary/);
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
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as { pid: number };
    await waitForExit(record.pid);
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
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as { args: string[] };
    const prompt = record.args[record.args.indexOf("--system-prompt") + 1] ?? "";
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
