/**
 * npm run verify:pi-wire -- /path/to/pi
 * 使用安装好的真实 pi CLI 与本机假 Anthropic 端点；只用合成内容/凭证，不请求真实 provider。
 * 验输入前缀和不压缩，不宣称真实 cache hit 或费用。公开 CI 不要求安装 pi。
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HistoryMessage, ModelCompletionRequest } from "../src/resident-runtime/channels.ts";
import { PiCliTransport } from "../src/resident-runtime/pi-transport.ts";

interface WireRequest {
  system: unknown;
  messages: { role: string; content: unknown }[];
}

/** cache_control 是请求元数据；对比实际模型输入的块、角色与原文，不比较移动的断点标签。 */
function inputContent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(inputContent);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "cache_control")
      .map(([key, entry]) => [key, inputContent(entry)]),
  );
}

const piBin = process.argv[2];
if (piBin === undefined) throw new Error("Usage: npm run verify:pi-wire -- /path/to/pi");
const dir = mkdtempSync(join(tmpdir(), "mist-pi-wire-"));
const packageTrapDir = mkdtempSync(join(tmpdir(), "mist-pi-package-trap-"));
const packageTrapLog = join(packageTrapDir, "attempts.log");
const requests: WireRequest[] = [];
const answer = "synthetic-wire-answer";
const server = createServer(async (incoming, response) => {
  const pieces: Buffer[] = [];
  for await (const chunk of incoming) pieces.push(Buffer.from(chunk));
  requests.push(JSON.parse(Buffer.concat(pieces).toString("utf8")) as WireRequest);
  response.writeHead(200, { "content-type": "text/event-stream" });
  const emit = (type: string, event: unknown): void => {
    response.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  emit("message_start", {
    type: "message_start",
    message: {
      id: "msg-synthetic",
      type: "message",
      role: "assistant",
      model: "mist-wire",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  });
  emit("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  emit("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: answer },
  });
  emit("content_block_stop", { type: "content_block_stop", index: 0 });
  emit("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 3 },
  });
  emit("message_stop", { type: "message_stop" });
  response.end();
});

try {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address !== null && typeof address !== "string");
  for (const manager of ["npm", "git"]) {
    const trap = join(packageTrapDir, manager);
    writeFileSync(
      trap,
      `#!/bin/sh\nprintf '%s %s\\n' "$0" "$*" >> "$MIST_PACKAGE_TRAP_LOG"\nexit 42\n`,
      { mode: 0o700 },
    );
    chmodSync(trap, 0o700);
  }
  const settings = JSON.stringify({
    compaction: { enabled: true },
    enableAnalytics: false,
    enableInstallTelemetry: false,
    cacheWarming: "off",
    packages: ["npm:pi-claude-bridge", "git:https://example.invalid/pi-extension.git"],
  });
  writeFileSync(join(dir, "settings.json"), settings, { mode: 0o600 });
  writeFileSync(
    join(dir, "models.json"),
    JSON.stringify({
      providers: {
        anthropic: {
          baseUrl: `http://127.0.0.1:${address.port}`,
          api: "anthropic-messages",
          models: [
            {
              id: "mist-wire",
              name: "Synthetic wire probe",
              reasoning: false,
              input: ["text"],
              contextWindow: 20000,
              maxTokens: 512,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
    { mode: 0o600 },
  );
  Reflect.deleteProperty(process.env, "PI_OFFLINE");
  assert.equal(process.env.PI_OFFLINE, undefined);
  const originalSettings = readFileSync(join(dir, "settings.json"), "utf8");
  const transport = new PiCliTransport({
    piBin,
    extraEnv: {
      PI_CODING_AGENT_DIR: dir,
      MIST_PACKAGE_TRAP_LOG: packageTrapLog,
      PATH: `${packageTrapDir}:${process.env.PATH ?? ""}`,
    },
    timeoutMs: 30000,
  });
  const request: ModelCompletionRequest = {
    residentId: "synthetic-wire-resident",
    adapterId: "pi-ai",
    model: "anthropic/mist-wire",
    credentialSecret: "SYNTHETIC-WIRE-KEY",
    text: "wire-current-one",
    history: [],
    bootPack: {
      residentId: "synthetic-wire-resident",
      identity: "Synthetic wire probe, no personal identity.",
      commitments: ["synthetic-constraint"],
      memories: [],
      currentFacts: [
        {
          seq: 1,
          ts: "2026-01-01T00:00:00Z",
          author: "synthetic",
          kind: "active_rule",
          body: "synthetic-fact",
          supersedesSeq: null,
        },
      ],
    },
  };
  const complete = async (item: ModelCompletionRequest): Promise<void> => {
    let reply = "";
    for await (const chunk of transport.complete(item)) reply += chunk;
    assert.equal(reply, answer);
  };
  await complete(request);
  await complete({
    ...request,
    text: "wire-current-two",
    history: [
      { role: "user", text: request.text },
      { role: "assistant", text: answer },
    ],
  });
  assert.equal(requests.length, 2, "one model request per ordinary turn");
  const [first, second] = requests;
  assert(first && second);
  assert.deepEqual(
    first.system,
    second.system,
    "pi's full system prompt, including cwd, must remain stable",
  );
  assert.deepEqual(
    inputContent(first.messages),
    inputContent(second.messages.slice(0, first.messages.length)),
    "previous model input must be the next input's message prefix",
  );
  assert.equal(JSON.stringify(second.messages).split("wire-current-two").length - 1, 1);
  assert(JSON.stringify(second.messages[0]).includes("synthetic-fact"));
  const changed = {
    ...request,
    text: "wire-current-three",
    history: [
      { role: "user" as const, text: request.text },
      { role: "assistant" as const, text: answer },
    ],
    bootPack: { ...request.bootPack, commitments: ["updated-synthetic-constraint"] },
  };
  await complete(changed);
  assert.equal(requests.length, 3);
  assert(JSON.stringify(requests[2]?.messages[0]).includes("updated-synthetic-constraint"));
  const longHistory: HistoryMessage[] = [];
  for (let index = 0; index < 12; index++) {
    longHistory.push(
      { role: "user", text: `u${index}:${"u".repeat(5600)}` },
      { role: "assistant", text: `a${index}:${"a".repeat(5600)}` },
    );
  }
  await complete({ ...request, text: "wire-long-current", history: longHistory });
  assert.equal(requests.length, 4, "long history must not generate summarization calls");
  const long = requests[3];
  assert(long);
  const serialized = JSON.stringify(long);
  assert(!serialized.includes("context summarization assistant"));
  assert(!serialized.includes("compacted into the following summary"));
  let cursor = -1;
  for (const item of longHistory) {
    const next = serialized.indexOf(item.text, cursor + 1);
    assert(next > cursor, `missing/reordered history ${item.text.slice(0, 4)}`);
    cursor = next;
  }
  assert.equal(serialized.split("wire-long-current").length - 1, 1);
  assert.equal(
    readFileSync(join(dir, "settings.json"), "utf8"),
    originalSettings,
    "original settings must remain unchanged",
  );
  const packageManagerAttempts = existsSync(packageTrapLog)
    ? readFileSync(packageTrapLog, "utf8").trim()
    : "";
  assert.equal(packageManagerAttempts, "", "settings packages must not reach the private root");
  process.stdout.write(
    `${JSON.stringify({ ok: true, modelRequests: requests.length, packageManagerAttempts: 0, stableFullSystem: true, previousInputIsMessagePrefix: true, updatedContext: true, longHistoryOriginalMessages: longHistory.length, summarizationRequests: 0, originalSettingsUnchanged: true })}\n`,
  );
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
  rmSync(packageTrapDir, { recursive: true, force: true });
}
