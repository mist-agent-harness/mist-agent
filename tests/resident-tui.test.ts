import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { Result, TurnResult } from "../acceptance/resident-runtime-driver.ts";
import { SyntheticModelTransport } from "../src/resident-runtime/channels.ts";
import { parseResidentCliArguments } from "../src/resident-runtime/cli.ts";
import { ResidentRuntime } from "../src/resident-runtime/runtime.ts";
import { type ChatTurnPort, ResidentChatTui } from "../src/resident-runtime/tui.ts";

const cliPath = fileURLToPath(new URL("../src/resident-runtime/cli.ts", import.meta.url));

const turn: TurnResult = {
  residentId: "resident-test",
  model: "openai/test-model",
  generation: 1,
  reply: "第一段第二段",
  streamed: true,
};

describe("ResidentChatTui", () => {
  it("renders actual model increments while keeping a single visible conversation", async () => {
    const say = vi.fn<ChatTurnPort["say"]>(async ({ onChunk }) => {
      onChunk?.("第一段");
      onChunk?.("第二段");
      return { ok: true, value: turn };
    });
    const tui = new ResidentChatTui({ say }, { residentId: turn.residentId, model: turn.model });

    tui.start();
    await tui.submit("刚输入的内容");
    const transcript = tui.transcript();
    const lastFrame = transcript.frames.at(-1);

    expect(transcript.streamChunks).toEqual(["第一段", "第二段"]);
    expect(lastFrame?.text).toContain("刚输入的内容");
    expect(lastFrame?.text).toContain("第一段第二段");
    expect(transcript.frames.every((frame) => frame.sessionCount === 1)).toBe(true);
    expect(transcript.statusResidentId).toBe(turn.residentId);
    expect(transcript.statusModel).toBe(turn.model);
  });

  it("renders structured runtime errors instead of failing silently", async () => {
    const failure: Result<TurnResult> = {
      ok: false,
      error: {
        code: "channel-unavailable",
        message: "通道不可用",
        remedy: "检查凭证后重试",
        residentId: turn.residentId,
      },
    };
    const tui = new ResidentChatTui(
      { say: async () => failure },
      {
        residentId: turn.residentId,
        model: turn.model,
      },
    );

    await tui.submit("这轮会失败");
    const transcript = tui.transcript();

    expect(transcript.errorText).toContain("channel-unavailable");
    expect(transcript.errorText).toContain("检查凭证后重试");
    expect(transcript.frames.at(-1)?.text).toContain("[错误]");
  });
});

describe("resident CLI arguments", () => {
  it("accepts an explicit resident and data directory", () => {
    expect(
      parseResidentCliArguments(["--resident", "r-cli", "--data-dir", "/tmp/mist-test"]),
    ).toEqual({
      residentId: "r-cli",
      dataDir: "/tmp/mist-test",
      help: false,
    });
  });

  it("supports help without requiring a resident ID and rejects missing IDs", () => {
    expect(parseResidentCliArguments(["--help"]).help).toBe(true);
    expect(() => parseResidentCliArguments([])).toThrow(/--resident is required/);
  });
});
describe("resident CLI", () => {
  it("runs an interactive round trip with stdin text outside argv", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mist-resident-cli-test-"));
    const residentId = "resident-cli-test";
    const runtime = new ResidentRuntime({
      dataDir,
      transport: new SyntheticModelTransport(),
    });
    runtime.provisionChannel({
      residentId,
      channel: { claudeSubscription: false, credentialKind: "api-key", model: "openai/test-model" },
      canarySecret: "test-only-not-a-real-secret",
    });
    await runtime.close();

    try {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", cliPath, "--resident", residentId, "--data-dir", dataDir],
        {
          env: { ...process.env, MIST_RESIDENT_RUNTIME_TRANSPORT: "synthetic" },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const result = await new Promise<{ code: number | null; output: string; error: string }>(
        (resolve, reject) => {
          let output = "";
          let error = "";
          child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
            output += chunk;
          });
          child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
            error += chunk;
          });
          child.once("error", reject);
          child.once("close", (code) => resolve({ code, output, error }));
          child.stdin?.end("\n从标准输入发出的消息\n/exit\n");
        },
      );

      expect(result.code, result.error).toBe(0);
      expect(result.output).toContain(`住户：${residentId}　模型：openai/test-model`);
      expect(result.output).toContain("从标准输入发出的消息");
      expect(result.output).toContain("合成回声已读来信。");
      expect(result.output).not.toContain("[错误]");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("handles process SIGINT by closing the CLI and returning exit code 130", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mist-resident-cli-sigint-test-"));
    const residentId = "resident-cli-sigint-test";
    const runtime = new ResidentRuntime({
      dataDir,
      transport: new SyntheticModelTransport(),
    });
    runtime.provisionChannel({
      residentId,
      channel: { claudeSubscription: false, credentialKind: "api-key", model: "openai/test-model" },
      canarySecret: "test-only-not-a-real-secret",
    });
    await runtime.close();

    try {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", cliPath, "--resident", residentId, "--data-dir", dataDir],
        {
          env: { ...process.env, MIST_RESIDENT_RUNTIME_TRANSPORT: "synthetic" },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          let output = "";
          let sigintSent = false;
          child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
            output += chunk;
            if (output.includes("你> ") && !sigintSent) {
              sigintSent = true;
              child.kill("SIGINT");
            }
          });
          child.once("error", reject);
          child.once("close", (code, signal) => resolve({ code, signal }));
        },
      );

      expect(result).toEqual({ code: 130, signal: null });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
