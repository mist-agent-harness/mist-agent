import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { BreatheOutcome, Result, TurnResult } from "../acceptance/resident-runtime-driver.ts";
import { SyntheticModelTransport } from "../src/resident-runtime/channels.ts";
import { parseResidentCliArguments, parseResidentCliInput } from "../src/resident-runtime/cli.ts";
import { ResidentRuntime } from "../src/resident-runtime/runtime.ts";
import { type ChatTurnPort, ResidentChatTui } from "../src/resident-runtime/tui.ts";

const cliPath = fileURLToPath(new URL("../src/resident-runtime/cli.ts", import.meta.url));

const turn: TurnResult = {
  residentId: "resident-test",
  model: "openai/test-model",
  generation: 1,
  reply: "第一段第二段",
  streamed: true,
  turnId: "test-turn",
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

  it("breathe renders the generation handover as visible feedback, not a chat turn", async () => {
    const breathed: BreatheOutcome = {
      fromGeneration: 1,
      toGeneration: 2,
      windowId: "w-test",
      letter: {
        title: "第 1 代交接信",
        author: "resident-test#1",
        writtenAt: "2026-10-01T00:00:00.000Z",
        state: [],
        intent: [],
      },
    };
    const say = vi.fn<ChatTurnPort["say"]>(async () => ({ ok: true, value: turn }));
    const breathe = vi.fn(async () => ({ ok: true, value: breathed }) as Result<BreatheOutcome>);
    const tui = new ResidentChatTui(
      { say, breathe },
      { residentId: turn.residentId, model: turn.model },
    );

    tui.start();
    const result = await tui.breathe("clear");
    const transcript = tui.transcript();
    const lastFrame = transcript.frames.at(-1);

    expect(result.ok).toBe(true);
    expect(say).not.toHaveBeenCalled(); // 命令不是发言
    expect(lastFrame?.text).toContain("第 1 代");
    expect(lastFrame?.text).toContain("第 2 代");
    expect(lastFrame?.text).not.toContain("你：");
    expect(transcript.streamChunks).toEqual([]);
  });

  it("breathe surfaces a refusal as visible error and keeps the session usable", async () => {
    const refusal: Result<BreatheOutcome> = {
      ok: false,
      error: {
        code: "breath-refused",
        message: "换气被拒：承诺账缺指针",
        remedy: "修好账再换气",
        residentId: turn.residentId,
      },
    };
    const tui = new ResidentChatTui(
      { say: async () => ({ ok: true, value: turn }), breathe: async () => refusal },
      { residentId: turn.residentId, model: turn.model },
    );

    const failed = await tui.breathe("compact");
    const transcript = tui.transcript();

    expect(failed.ok).toBe(false);
    expect(transcript.errorText).toContain("breath-refused");
    expect(transcript.errorText).toContain("修好账再换气");
    expect(transcript.frames.at(-1)?.text).toContain("[错误]");
    // 拒绝之后仍能正常聊天。
    await tui.submit("拒绝之后还算数吗");
    expect(tui.transcript().frames.at(-1)?.text).toContain("拒绝之后还算数吗");
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

describe("resident CLI input dispatch", () => {
  it("dispatches explicit retry while ordinary same-text input remains chat", () => {
    expect(parseResidentCliInput("  /retry  ")).toEqual({ kind: "retry" });
    expect(parseResidentCliInput("/retrying")).toEqual({ kind: "chat", text: "/retrying" });
  });
  it("maps the three lifecycle commands to the same breathe kind with their own via", () => {
    expect(parseResidentCliInput("/new")).toEqual({ kind: "breathe", via: "new" });
    expect(parseResidentCliInput("/clear")).toEqual({ kind: "breathe", via: "clear" });
    expect(parseResidentCliInput("/compact")).toEqual({ kind: "breathe", via: "compact" });
  });

  it("normalizes case, surrounding whitespace and trailing arguments", () => {
    expect(parseResidentCliInput("  /Clear  ")).toEqual({ kind: "breathe", via: "clear" });
    expect(parseResidentCliInput("/compact 保留最近 20 条")).toEqual({
      kind: "breathe",
      via: "compact",
    });
  });

  it("keeps /exit and ordinary chat on their own tracks", () => {
    expect(parseResidentCliInput("/exit")).toEqual({ kind: "exit" });
    expect(parseResidentCliInput("/new一")).toEqual({ kind: "chat", text: "/new一" });
    expect(parseResidentCliInput("普通的一句")).toEqual({
      kind: "chat",
      text: "普通的一句",
    });
  });
});
describe("resident CLI", () => {
  it("real /retry keeps the failed turn anchor without appending another pair", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mist-cli-retry-"));
    const residentId = "r-cli-retry";
    try {
      await provisionSyntheticResident({ dataDir, residentId });
      mkdirSync(join(dataDir, "turns", `${residentId}.turns.json.tmp`));
      const result = await spawnResidentCli({
        residentId,
        dataDir,
        stdin: "same message\n/retry\n/retry\nsame message\n/exit\n",
      });
      expect(result.code, result.error).toBe(0);
      expect(result.output).toContain("writer-unavailable");
      expect(result.output).toContain("reconciliation-needed");
      const persisted = JSON.parse(
        readFileSync(join(dataDir, "streams", `${residentId}.stream.json`), "utf8"),
      ) as {
        events: { payload: { role: string; text: string; turnId: string } }[];
      };
      expect(persisted.events).toHaveLength(4);
      expect(
        persisted.events
          .filter((event) => event.payload.role === "user")
          .map((event) => event.payload.text),
      ).toEqual(["same message", "same message"]);
      expect(new Set(persisted.events.map((event) => event.payload.turnId)).size).toBe(2);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
  it("runs an interactive round trip with stdin text outside argv", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mist-resident-cli-test-"));
    const residentId = "resident-cli-test";
    const runtime = new ResidentRuntime({
      dataDir,
      transport: new SyntheticModelTransport(),
    });
    const candidate = runtime.createCandidate({
      persona: `persona:${residentId}`,
      proposedBy: { kind: "installer", id: "cli-test" },
      residentId,
    });
    runtime.attestCandidate(
      candidate.candidateId,
      { kind: "candidate", candidateId: candidate.candidateId },
      "accepted",
    );
    runtime.provisionChannel({
      residentId,
      channel: { claudeSubscription: false, credentialKind: "api-key", model: "openai/test-model" },
      canarySecret: "test-only-not-a-real-secret",
    });
    await runtime.close();

    try {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", cliPath, "--resident", candidate.candidateId, "--data-dir", dataDir],
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
    const candidate = runtime.createCandidate({
      persona: `persona:${residentId}`,
      proposedBy: { kind: "installer", id: "cli-test" },
      residentId,
    });
    runtime.attestCandidate(
      candidate.candidateId,
      { kind: "candidate", candidateId: candidate.candidateId },
      "accepted",
    );
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

interface SpawnedCliResult {
  readonly code: number | null;
  readonly output: string;
  readonly error: string;
}

/** 起一个真实的 resident CLI 子进程，喂进 stdin 的每行，收 stdout/stderr。 */
function spawnResidentCli(input: {
  readonly residentId: string;
  readonly dataDir: string;
  readonly stdin: string;
}): Promise<SpawnedCliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", cliPath, "--resident", input.residentId, "--data-dir", input.dataDir],
      {
        env: { ...process.env, MIST_RESIDENT_RUNTIME_TRANSPORT: "synthetic" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
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
    child.stdin?.end(input.stdin);
  });
}

/** 在临时数据目录里显式自认，再用现役 provisionChannel 备好合成通道。 */
async function provisionSyntheticResident(input: {
  readonly dataDir: string;
  readonly residentId: string;
}): Promise<void> {
  const runtime = new ResidentRuntime({
    dataDir: input.dataDir,
    transport: new SyntheticModelTransport(),
  });
  const candidate = runtime.createCandidate({
    persona: `persona:${input.residentId}`,
    proposedBy: { kind: "installer", id: "cli-test" },
    residentId: input.residentId,
  });
  const activated = runtime.attestCandidate(
    candidate.candidateId,
    { kind: "candidate", candidateId: candidate.candidateId },
    "accepted",
  );
  if (!activated.ok) throw new Error("synthetic self-attestation failed");
  const provisioned = runtime.provisionChannel({
    residentId: input.residentId,
    channel: { claudeSubscription: false, credentialKind: "api-key", model: "openai/test-model" },
    canarySecret: "test-only-not-a-real-secret",
  });
  await runtime.close();
  if (!provisioned.ok) throw new Error(`provisionChannel failed: ${provisioned.error.code}`);
}

/** 某户的交接信文件名，按真实目录项列出（只算文件，目录不算信）。 */
function readLetterFiles(dataDir: string, residentId: string): string[] {
  return readdirSync(join(dataDir, "letters"), { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.startsWith(`${residentId}.letter-`) &&
        entry.name.endsWith(".json"),
    )
    .map((entry) => entry.name)
    .sort();
}

interface LetterFile {
  readonly generation: number;
  readonly windowId: string;
  /** intent 半的当刻亲笔标记 `${residentId}#${generation}`（写它的那一代）。 */
  readonly authorMark: string;
}

/** 读一封真实的信档，断言实际形状（不做静默回退）。 */
function readLetter(dataDir: string, residentId: string, generation: number): LetterFile {
  const path = join(dataDir, "letters", `${residentId}.letter-${generation}.json`);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    generation?: unknown;
    windowId?: unknown;
    intent?: readonly { author?: unknown }[];
  };
  const authorMark = parsed.intent?.[0]?.author;
  if (typeof parsed.generation !== "number" || typeof parsed.windowId !== "string") {
    throw new Error(`信档缺 generation/windowId：${path}`);
  }
  if (typeof authorMark !== "string") {
    throw new Error(`信档 intent 条目缺当刻亲笔标记：${path}`);
  }
  return { generation: parsed.generation, windowId: parsed.windowId, authorMark };
}

interface StreamEventFact {
  readonly role: string;
  readonly text: string;
  readonly generation: number;
}

/** 读真实一窗流事件的正文与落盘代际（不做静默回退）。 */
function readStreamEvents(dataDir: string, residentId: string): StreamEventFact[] {
  const path = join(dataDir, "streams", `${residentId}.stream.json`);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    events?: readonly {
      payload?: { role?: unknown; text?: unknown };
      origin?: { viewport?: { generation?: unknown } | null };
    }[];
  };
  return (parsed.events ?? []).map((event) => {
    const role = event.payload?.role;
    const text = event.payload?.text;
    const generation = event.origin?.viewport?.generation;
    if (typeof role !== "string" || typeof text !== "string" || typeof generation !== "number") {
      throw new Error(`一窗流事件形状不合：${path}`);
    }
    return { role, text, generation };
  });
}

describe("resident CLI lifecycle commands", () => {
  it("/new、/clear、/compact 各换一代、各一封交接信，且不作为用户消息进一窗流", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mist-resident-cli-lifecycle-"));
    const residentId = "resident-cli-lifecycle";
    await provisionSyntheticResident({ dataDir, residentId });

    try {
      const result = await spawnResidentCli({
        residentId,
        dataDir,
        stdin: "第一句正常消息\n/clear\n第二句正常消息\n/new\n/compact\n/exit\n",
      });

      expect(result.code, result.error).toBe(0);
      expect(result.error).toBe("");
      // 正常文本往返保留：两条正常消息都拿到合成回复。
      expect(result.output).toContain("第一句正常消息");
      expect(result.output).toContain("第二句正常消息");
      expect(result.output).toContain("合成回声已读来信。");

      // 三个命令各换一代：三封信逐代递增，签名是换代前那代、窗号逐字不变。
      expect(readLetterFiles(dataDir, residentId)).toEqual([
        `${residentId}.letter-1.json`,
        `${residentId}.letter-2.json`,
        `${residentId}.letter-3.json`,
      ]);
      const first = readLetter(dataDir, residentId, 1);
      const second = readLetter(dataDir, residentId, 2);
      const third = readLetter(dataDir, residentId, 3);
      expect([first.generation, second.generation, third.generation]).toEqual([1, 2, 3]);
      expect([first.authorMark, second.authorMark, third.authorMark]).toEqual([
        `${residentId}#1`,
        `${residentId}#2`,
        `${residentId}#3`,
      ]);
      expect([first.windowId, second.windowId, third.windowId]).toEqual([
        first.windowId,
        first.windowId,
        first.windowId,
      ]);

      // 命令不是发言：一窗流里只有两条正常消息的正文，没有任何命令文本。
      const events = readStreamEvents(dataDir, residentId);
      const texts = events.map((event) => event.text);
      expect(texts).toContain("第一句正常消息");
      expect(texts).toContain("第二句正常消息");
      expect(texts.some((text) => text.includes("/clear"))).toBe(false);
      expect(texts.some((text) => text.includes("/new"))).toBe(false);
      expect(texts.some((text) => text.includes("/compact"))).toBe(false);
      // 恰好两条 user + 两条 assistant：命令没有偷偷落成回合。
      expect(texts).toHaveLength(4);
      expect(events.filter((event) => event.role === "user").map((event) => event.text)).toEqual([
        "第一句正常消息",
        "第二句正常消息",
      ]);

      // 成功换代要有可观察的反馈，而不是静默。
      expect(result.output).toContain("换气");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("换代被拒时错误可见且CLI仍可继续使用，旧状态不改", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "mist-resident-cli-refuse-"));
    const residentId = "resident-cli-refuse";
    await provisionSyntheticResident({ dataDir, residentId });

    try {
      // 失败源：把真实的 letters 落盘目录置成只读，首封信的 writeFileSync 撞上
      // EACCES → BreathCycle 在 append 档拒绝换代。不 mock、不碰 runtime/breath，
      // 也不依赖 composeLetterDraft 的已知缺陷；读路径（时间线/开工）照常可用。
      mkdirSync(join(dataDir, "letters"), { recursive: true });
      chmodSync(join(dataDir, "letters"), 0o500);

      const result = await spawnResidentCli({
        residentId,
        dataDir,
        stdin: "先落一句\n/clear\n拒绝之后还能说话吗\n/exit\n",
      });

      expect(result.code, result.error).toBe(0);
      expect(result.error).toBe("");
      // 换代被拒：错误码与完整处理建议都看得见。
      expect(result.output).toContain("breath-refused");
      expect(result.output).toContain("[错误]");
      expect(result.output).toContain("换气失败则窗未换代（失败不改史）：按错误信息修数据面后重试");
      // 进程没有被拒死：拒绝之后继续正常文本往返。
      expect(result.output).toContain("拒绝之后还能说话吗");
      expect(result.output).toContain("合成回声已读来信。");

      // 被拒的换代没有落下交接信文件。
      expect(readLetterFiles(dataDir, residentId)).toEqual([]);

      // 用户命令不成为 stream text：只有两条正常消息，没有 /clear。
      const events = readStreamEvents(dataDir, residentId);
      const userTexts = events.filter((event) => event.role === "user").map((event) => event.text);
      expect(userTexts).toEqual(["先落一句", "拒绝之后还能说话吗"]);
      expect(events.some((event) => event.text.includes("/clear"))).toBe(false);

      // 拒绝后普通回合的落盘代际证明未换代：两句都说在同一代。
      const beforeRefusal = events.find((event) => event.text === "先落一句");
      const afterRefusal = events.find((event) => event.text === "拒绝之后还能说话吗");
      expect(afterRefusal?.generation).toBe(beforeRefusal?.generation);
    } finally {
      // 还原写权限，好让 rmSync 能清掉只读目录树。
      chmodSync(join(dataDir, "letters"), 0o700);
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
