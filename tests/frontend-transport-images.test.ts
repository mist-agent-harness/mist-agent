/**
 * 下层 Pi 原生图片承载的独立测试（D31-1 分支保留）：不经产品文字引擎（本步结构请求
 * 在引擎边界就被拒），直接构造 `FrontendModelTurn` 走 bridge → 真实 PiCliTransport →
 * 假 Pi 子进程，核 native stdin 图片块、route/bootPack/history、凭据只进 env、
 * 以及 text-only transport 带图 calls0 拒绝、结构输出 fail-closed。
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ClientCapability,
  StructuredAttachment,
} from "../acceptance/frontend-adapter-driver.ts";
import type {
  FrontendAttachmentPort,
  FrontendModelTurn,
} from "../src/frontend/deferred-structure-engine.ts";
import { createTransportModelPort } from "../src/frontend/transport-model-port.ts";
import type { ModelTransport } from "../src/resident-runtime/channels.ts";
import { PiCliTransport } from "../src/resident-runtime/pi-transport.ts";

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mist-frontend-pi-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAAWgmWQ0AAAAASUVORK5CYII=";
const PNG_BYTES = Buffer.from(PNG_BASE64, "base64");
const SECRET = "sk-canary-integration-images";

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
    args,
    message: command.message,
    images: command.images ?? null,
    systemPrompt: fs.readFileSync(promptPath, "utf8"),
    deepseekKey: process.env.DEEPSEEK_API_KEY ?? null,
    openaiKey: process.env.OPENAI_API_KEY ?? null,
  }));
  emit({ type: "response", id: "mist-prompt", command: "prompt", success: true });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "看到图了" } });
  const content = mode === "tool-call"
    ? [{ type: "text", text: "synthetic text" }, { type: "toolCall", id: "synthetic-call", name: "synthetic-tool", arguments: {} }]
    : [{ type: "text", text: "看到图了" }];
  emit({ type: "turn_end", message: { role: "assistant", stopReason: "stop", content } });
  emit({ type: "agent_settled" });
});
`,
    "utf8",
  );
  chmodSync(bin, 0o755);
  return { bin, recordPath };
}

function imageAttachment(): StructuredAttachment {
  return {
    attachmentId: "att_lower_image",
    kind: "image",
    filename: "image",
    mediaType: "image/png",
    sizeBytes: PNG_BYTES.length,
    source: "inline",
  };
}

function attachmentPortFor(
  attachment: StructuredAttachment,
  bytes: Buffer,
): FrontendAttachmentPort {
  const handle = { attachment, read: async () => Buffer.from(bytes) };
  return {
    incoming: () => [handle],
    open: (refId) => (refId === attachment.attachmentId ? handle : null),
    prepareOutbound: () => {
      throw new Error("not used in this test");
    },
    reuseOutbound: () => {
      throw new Error("not used in this test");
    },
  };
}

function turn(options: {
  currentText: string;
  attachments: StructuredAttachment[];
  capabilities: ClientCapability[];
  attachmentPort: FrontendAttachmentPort;
}): FrontendModelTurn {
  return {
    bindingId: "binding:lower",
    residentId: "resident-pi-img",
    scopeId: "scope:pi",
    streamId: "stream:resident-pi-img",
    generation: 1,
    canonicalHistoryText: [],
    history: [],
    currentText: options.currentText,
    attachments: options.attachments,
    surfaceCapabilities: options.capabilities,
    attachmentPort: options.attachmentPort,
  };
}

function context() {
  return {
    resolveCompletion: (t: FrontendModelTurn) => ({
      adapterId: "pi-ai" as const,
      model: "deepseek/deepseek-chat",
      bootPack: {
        residentId: t.residentId,
        identity: `persona:${t.residentId}`,
        commitments: ["每天写日报"],
        memories: [{ id: "m1", content: "爱吃苹果", supersededBy: null }],
      },
      credentialSecret: SECRET,
    }),
  };
}

function piTransport(recordPath: string, mode?: string): PiCliTransport {
  const { bin } = fakePi();
  return new PiCliTransport({
    piBin: bin,
    extraEnv: {
      FAKE_PI_RECORD: recordPath,
      OPENAI_API_KEY: "ambient-should-be-cleared",
      ...(mode === undefined ? {} : { FAKE_PI_MODE: mode }),
    },
  });
}

describe("#218 lower-layer Pi native images (branch)", () => {
  it("carries a supported inbound image as a native prompt image block", async () => {
    const { recordPath } = fakePi();
    const transport = piTransport(recordPath);
    const port = createTransportModelPort(transport, context());
    const attachment = imageAttachment();
    const reply = await port.complete(
      turn({
        currentText: "这是什么",
        attachments: [attachment],
        capabilities: ["attachments"],
        attachmentPort: attachmentPortFor(attachment, PNG_BYTES),
      }),
    );
    expect(reply).toEqual({ kind: "text", text: "看到图了" });
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as {
      args: string[];
      message: string;
      images: unknown;
      systemPrompt: string;
      deepseekKey: string | null;
      openaiKey: string | null;
    };
    expect(record.message).toBe("这是什么");
    expect(record.images).toEqual([{ type: "image", data: PNG_BASE64, mimeType: "image/png" }]);
    expect(record.systemPrompt).toContain("persona:resident-pi-img");
    expect(record.deepseekKey).toBe(SECRET);
    expect(record.openaiKey).toBeNull();
    expect(record.args.join(" ")).not.toContain(SECRET);
  });

  it("fails closed on a text+toolCall reply with the upstream call counted", async () => {
    const { recordPath } = fakePi();
    const transport = piTransport(recordPath, "tool-call");
    const port = createTransportModelPort(transport, context());
    await expect(
      port.complete(
        turn({
          currentText: "hi",
          attachments: [],
          capabilities: [],
          attachmentPort: attachmentPortFor(imageAttachment(), PNG_BYTES),
        }),
      ),
    ).rejects.toThrow(/不受支持的内容类型：tool_call/);
    expect(JSON.parse(readFileSync(recordPath, "utf8")).message).toBe("hi");
  });
});

class LegacyTextTransport implements ModelTransport {
  calls = 0;
  async *complete(modelRequest: { text: string }): AsyncIterable<string> {
    this.calls += 1;
    yield `echo:${modelRequest.text}`;
  }
}

describe("#218 bridge respects transport native-image capability (branch)", () => {
  it("rejects an image turn before calling a text-only transport (calls 0)", async () => {
    const transport = new LegacyTextTransport();
    const port = createTransportModelPort(transport, context());
    const attachment = imageAttachment();
    await expect(
      port.complete(
        turn({
          currentText: "看图",
          attachments: [attachment],
          capabilities: ["attachments"],
          attachmentPort: attachmentPortFor(attachment, PNG_BYTES),
        }),
      ),
    ).rejects.toThrow(/native image support/);
    expect(transport.calls).toBe(0);
  });

  it("still routes plain text with surface capabilities through a text-only transport", async () => {
    const transport = new LegacyTextTransport();
    const port = createTransportModelPort(transport, context());
    const reply = await port.complete(
      turn({
        currentText: "纯文本",
        attachments: [],
        capabilities: ["attachments", "interactions"],
        attachmentPort: attachmentPortFor(imageAttachment(), PNG_BYTES),
      }),
    );
    expect(reply).toEqual({ kind: "text", text: "echo:纯文本" });
    expect(transport.calls).toBe(1);
  });

  it("rejects an unsupported inbound file before calling a text transport", async () => {
    const transport = new LegacyTextTransport();
    const port = createTransportModelPort(transport, context());
    const file: StructuredAttachment = {
      attachmentId: "att_file",
      kind: "file",
      filename: "a.txt",
      mediaType: "text/plain",
      sizeBytes: 5,
      source: "inline",
    };
    await expect(
      port.complete(
        turn({
          currentText: "带文件",
          attachments: [file],
          capabilities: ["attachments"],
          attachmentPort: attachmentPortFor(file, Buffer.from("hello")),
        }),
      ),
    ).rejects.toThrow(/file attachments/);
    expect(transport.calls).toBe(0);
  });
});
