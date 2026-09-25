/**
 * pi 通道传输的单元测试：假 pi 回放**真实 `pi --mode json` 的事件型谱**
 * （样谱来自本机真通道探测：message_update.assistantMessageEvent 的
 * text_start / text_delta / text_end），零网络、零真实凭据。
 *
 * 钉住：流式增量按序吐、密钥只走环境变量不进 argv、claude-bridge（订阅特例）
 * 不带密钥、上游认证失败不当真回复、启动包与历史进系统提示。
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

/** 假 pi：事件型谱照真通道样谱；把 argv 与密钥环境变量落到记录文件供断言。 */
function fakePi(): { bin: string; recordPath: string } {
  const dir = tempDir();
  const bin = join(dir, "fake-pi.js");
  const recordPath = join(dir, "record.json");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
const mode = process.env.FAKE_PI_MODE ?? "ok";
if (process.env.FAKE_PI_RECORD) {
  fs.writeFileSync(process.env.FAKE_PI_RECORD, JSON.stringify({
    args,
    secretEnvs: {
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null,
      PI_API_KEY: process.env.PI_API_KEY ?? null,
    },
  }));
}
if (mode === "crash") { process.stderr.write("boom"); process.exit(3); }
const deltas = mode === "authfail"
  ? ["Failed to authenticate: OAuth session expired"]
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
`,
    "utf8",
  );
  chmodSync(bin, 0o755);
  return { bin, recordPath };
}

function request(overrides: Partial<ModelCompletionRequest> = {}): ModelCompletionRequest {
  return {
    residentId: "r-pi",
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

describe("PiCliTransport", () => {
  it("流式增量按序吐（≥2 段），拼接即完整回复", async () => {
    const { bin, recordPath } = fakePi();
    const transport = new PiCliTransport({
      piBin: bin,
      extraEnv: { FAKE_PI_RECORD: recordPath },
    });
    const chunks = await collect(transport.complete(request()));
    expect(chunks).toEqual(["你好", "，世界"]);
  });

  it("密钥只走环境变量、不进 argv（RT-06 蜜罐纪律）", async () => {
    const { bin, recordPath } = fakePi();
    const transport = new PiCliTransport({ piBin: bin, extraEnv: { FAKE_PI_RECORD: recordPath } });
    await collect(transport.complete(request()));
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as {
      args: string[];
      secretEnvs: Record<string, string | null>;
    };
    expect(record.args.join(" ")).not.toContain("sk-canary-pi-1"); // argv 里没有密钥
    expect(record.secretEnvs.ANTHROPIC_API_KEY).toBe("sk-canary-pi-1"); // 环境变量里有
  });

  it("claude-bridge 订阅特例：不带任何密钥（Claude Code 自己的登录态）", async () => {
    const { bin, recordPath } = fakePi();
    const transport = new PiCliTransport({ piBin: bin, extraEnv: { FAKE_PI_RECORD: recordPath } });
    await collect(transport.complete(request({ model: "claude-bridge/claude-haiku-4-5" })));
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as {
      args: string[];
      secretEnvs: Record<string, string | null>;
    };
    expect(record.secretEnvs.ANTHROPIC_API_KEY).toBeNull();
    expect(record.secretEnvs.PI_API_KEY).toBeNull();
    expect(record.args.join(" ")).not.toContain("sk-canary-pi-1");
  });

  it("上游把认证失败当回复吐出来：fail-closed 抛错，不当真回复", async () => {
    const { bin } = fakePi();
    const transport = new PiCliTransport({ piBin: bin, extraEnv: { FAKE_PI_MODE: "authfail" } });
    await expect(collect(transport.complete(request()))).rejects.toThrow(/Failed to authenticate/);
  });

  it("pi 起不来/退出码非 0：抛错交给 channel-unavailable 口径", async () => {
    const { bin } = fakePi();
    const transport = new PiCliTransport({ piBin: bin, extraEnv: { FAKE_PI_MODE: "crash" } });
    await expect(collect(transport.complete(request()))).rejects.toThrow(/退出码 3/);
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

  it("renderSystemPrompt：没接账（currentFacts 缺席）不编空事实区", () => {
    const prompt = renderSystemPrompt(request());
    expect(prompt).toContain("你是住户 小派（r-pi）");
    expect(prompt).not.toContain("现行有效事实");
    expect(prompt).not.toContain("本代此前对话");
  });

  it('createModelTransport("pi") 接真通道，不再抛「随通道 PR 落地」', () => {
    expect(createModelTransport("pi")).toBeInstanceOf(PiCliTransport);
    expect(createModelTransport("synthetic")).not.toBeInstanceOf(PiCliTransport);
  });
});
