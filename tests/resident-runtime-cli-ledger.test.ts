/**
 * CLI / 宿主装配边界：认证账接线的真实证据（责任：CLI 宿主装配）。
 *
 * 两条：
 * - 共用装配 seam 的录制测试：实际 CLI 与宿主子进程共用的 `assembleResidentRuntime`
 *   构造出的运行时，模型请求里带的是**实际账里的** currentFacts body；
 * - 实际 CLI entry 回归：独立子进程跑 `src/resident-runtime/cli.ts`，证明 CLI 真的接上
 *   认证账并完成真实交付（落盘 .facts.json 的窗确认位推进），不是「传了 option」就算。
 * 不动真实 provider、不用密钥（synthetic transport）。
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { assembleResidentRuntime } from "../src/resident-runtime/assembly.ts";
import type { ModelCompletionRequest, ModelTransport } from "../src/resident-runtime/channels.ts";

const dirs: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const cliPath = fileURLToPath(new URL("../src/resident-runtime/cli.ts", import.meta.url));
const channel = {
  claudeSubscription: false,
  credentialKind: "api-key" as const,
  model: "openai/test-model",
};

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mist-rt-cli-ledger-"));
  dirs.push(dir);
  return dir;
}

function activate(runtime: ReturnType<typeof assembleResidentRuntime>, residentId: string): string {
  const candidate = runtime.createCandidate({
    persona: `persona:${residentId}`,
    proposedBy: { kind: "installer", id: "cli-ledger-test" },
    residentId,
  });
  expect(
    runtime.attestCandidate(
      candidate.candidateId,
      { kind: "candidate", candidateId: candidate.candidateId },
      "accepted",
    ).ok,
  ).toBe(true);
  return candidate.candidateId;
}

describe("CLI 宿主装配 seam（录制 transport）", () => {
  it("模型请求里带的是账里实际的 currentFacts body", async () => {
    const dataDir = tempDir();
    const requests: ModelCompletionRequest[] = [];
    const recording: ModelTransport = {
      async *complete(request: ModelCompletionRequest): AsyncIterable<string> {
        requests.push(request);
        yield "收到。";
      },
    };
    const runtime = assembleResidentRuntime({ dataDir, transport: recording });
    try {
      activate(runtime, "r-cli");
      runtime.provisionChannel({ residentId: "r-cli", channel, canarySecret: "sk-test" });
      const authority = runtime.ledgerAuthority();
      if (authority === null) throw new Error("CLI seam 没接上认证账");
      authority.host
        .system("mist-host")
        .append("r-cli", { kind: "ruling", body: "账里实际生效的那条" }, "宿主维护");
      const result = await runtime.say({ residentId: "r-cli", text: "在吗" });
      expect(result.ok).toBe(true);
      expect(requests[0]?.bootPack.currentFacts?.map((fact) => fact.body)).toContain(
        "账里实际生效的那条",
      );
    } finally {
      await runtime.close();
    }
  });
});

describe("实际 CLI entry 回归", () => {
  it("真实 CLI 子进程接上认证账并完成交付（落盘确认位推进）", async () => {
    const dataDir = tempDir();
    const residentId = "resident-cli-ledger";
    // 先显式自认，用共用 seam 建档并落一条账（含窗确认位），再让真实 CLI 从同一盘里恢复。
    const prep = assembleResidentRuntime({
      dataDir,
      transport: {
        // 本轮只准备数据、不跑模型：不给 yield，调用即返回空流。
        complete: (): AsyncIterable<string> => ({
          [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
        }),
      },
    });
    let candidateId: string;
    try {
      candidateId = activate(prep, residentId);
      prep.provisionChannel({ residentId, channel, canarySecret: "sk-test" });
      const authority = prep.ledgerAuthority();
      if (authority === null) throw new Error("准备阶段没接上账");
      authority.host
        .system("mist-host")
        .append(residentId, { kind: "ruling", body: "要进请求的那条" }, "宿主维护");
    } finally {
      await prep.close();
    }

    const child = spawn(
      process.execPath,
      ["--import", "tsx", cliPath, "--resident", candidateId, "--data-dir", dataDir],
      {
        env: { ...process.env, MIST_RESIDENT_RUNTIME_TRANSPORT: "synthetic" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    children.push(child);
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
        child.stdin?.end("从 CLI 发出的一句话\n/exit\n");
      },
    );
    expect(result.code, result.error).toBe(0);
    expect(result.output).not.toContain("[错误]");
    expect(result.output).toContain("合成回声已读来信。");

    // CLI 真的接上了认证账并完成交付：窗确认位推进到 latestSeq。
    const snapshot = JSON.parse(
      readFileSync(join(dataDir, "residents", `${residentId}.facts.json`), "utf8"),
    ) as {
      accessMode?: string;
      entries: { seq: number }[];
      viewports: { ackedSeq: number }[];
    };
    expect(snapshot.accessMode).toBe("authenticated");
    expect(snapshot.viewports[0]?.ackedSeq).toBe(snapshot.entries.length);

    // 同一实际 CLI main 的独立子进程，用录制 transport 直接观察模型请求；
    // 只记录 currentFacts，不落凭证或其他 request 字段。
    const runner = join(dataDir, "record-cli.mjs");
    const captured = join(dataDir, "current-facts.json");
    writeFileSync(
      runner,
      `import { main } from ${JSON.stringify(new URL("../src/resident-runtime/cli.ts", import.meta.url).href)};\nimport { writeFileSync } from 'node:fs';\nawait main(process.argv.slice(2), { transport: { async *complete(request) { writeFileSync(${JSON.stringify(captured)}, JSON.stringify(request.bootPack.currentFacts)); yield 'cli-recorded'; } } });\n`,
    );
    const recorded = spawn(
      process.execPath,
      ["--import", "tsx", runner, "--resident", residentId, "--data-dir", dataDir],
      {
        env: { ...process.env, MIST_RESIDENT_RUNTIME_TRANSPORT: "synthetic" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    children.push(recorded);
    const recordedExit = await new Promise<number | null>((resolve, reject) => {
      recorded.stdout?.resume();
      recorded.stderr?.resume();
      recorded.once("error", reject);
      recorded.once("close", resolve);
      recorded.stdin?.end("录制实际 CLI 请求\n/exit\n");
    });
    expect(recordedExit).toBe(0);
    const facts = JSON.parse(readFileSync(captured, "utf8")) as { body: string }[];
    expect(facts.map((fact) => fact.body)).toContain("要进请求的那条");
  });
});
