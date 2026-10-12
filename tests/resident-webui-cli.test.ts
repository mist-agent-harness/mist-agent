/**
 * D31-1 CLI `/webui` 宿主入口测试：命令分派不经 say；preflight 只读无副作用；
 * 缺环境零安装零服务；确认后经真实 runtime + 真实 listener + 真实插件事务（外部命令替身）
 * 启动，close 只关前端、借用 runtime 仍能 say。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  CommandInvocation,
  CommandResult,
  CommandRunner,
} from "../src/frontend/webui-platform.ts";
import { assembleResidentRuntime } from "../src/resident-runtime/assembly.ts";
import type { ModelTransport } from "../src/resident-runtime/channels.ts";
import { parseResidentCliInput } from "../src/resident-runtime/cli.ts";
import type { ResidentRuntime } from "../src/resident-runtime/runtime.ts";
import {
  type WebuiCliDeps,
  installWebui,
  preflightWebui,
} from "../src/resident-runtime/webui-cli.ts";
import { type SyntheticWebuiApi, startSyntheticWebuiApi } from "./fixtures/synthetic-webui-api.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "mist-webui-cli-"));
  dirs.push(dir);
  return dir;
}

class QueueTransport implements ModelTransport {
  readonly #queue: string[] = [];
  enqueue(text: string): void {
    this.#queue.push(text);
  }
  async *complete(): AsyncIterable<string> {
    const reply = this.#queue.shift();
    if (reply === undefined) throw new Error("no queued reply");
    yield reply;
  }
}

class FakeRunner implements CommandRunner {
  readonly live = new Set<string>();
  pythonAvailable = true;
  async run(invocation: CommandInvocation): Promise<CommandResult> {
    if (invocation.file === "docker" && invocation.args[0] === "info")
      return { code: 1, stdout: "", stderr: "no daemon" };
    if (invocation.args.includes("--version")) {
      return this.pythonAvailable
        ? { code: 0, stdout: "", stderr: "Python 3.12.13" }
        : { code: 1, stdout: "", stderr: "" };
    }
    if (invocation.args.some((a) => a.includes("/health")))
      return { code: 0, stdout: '{"status":true}\n200', stderr: "" };
    if (invocation.args.some((a) => a.includes("/models")))
      return { code: 0, stdout: "401\n", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  }
  async startContainer(invocation: CommandInvocation & { name: string }) {
    this.live.add(invocation.name);
    return { containerId: `cid-${invocation.name}` };
  }
  async startProcess(invocation: CommandInvocation & { name: string }) {
    this.live.add(invocation.name);
    return { pid: 111 };
  }
  async stopContainer(name: string) {
    this.live.delete(name);
  }
  async stopProcess(name: string) {
    this.live.delete(name);
  }
  async isProcessAlive() {
    return true;
  }
}

async function runtimeFor(
  dir: string,
): Promise<{ runtime: ResidentRuntime; residentId: string; transport: QueueTransport }> {
  const transport = new QueueTransport();
  const runtime = assembleResidentRuntime({ dataDir: dir, transport });
  const candidate = runtime.createCandidate({
    persona: "persona:resident-webui",
    proposedBy: { kind: "installer", id: "test" },
    residentId: "resident-webui",
  });
  runtime.attestCandidate(
    candidate.candidateId,
    { kind: "candidate", candidateId: candidate.candidateId },
    "accepted",
  );
  const active = runtime.requireActiveResident("resident-webui");
  if (!active.ok) throw new Error("resident not active");
  const residentId = active.value.residentId;
  await runtime.provisionChannel({
    residentId,
    channel: { claudeSubscription: false, credentialKind: "api-key", model: "pi-test/model" },
    canarySecret: "canary",
  });
  return { runtime, residentId, transport };
}

describe("#218 CLI /webui dispatch", () => {
  it("routes /webui as a host command, never chat", () => {
    expect(parseResidentCliInput("/webui")).toEqual({ kind: "webui" });
    expect(parseResidentCliInput("/exit")).toEqual({ kind: "exit" });
    expect(parseResidentCliInput("/new")).toEqual({ kind: "breathe", via: "new" });
    expect(parseResidentCliInput("hello")).toEqual({ kind: "chat", text: "hello" });
  });
});

describe("#218 webui preflight/install", () => {
  let api: SyntheticWebuiApi;
  beforeEach(async () => {
    api = await startSyntheticWebuiApi({ email: "x", password: "y", acceptAny: true });
  });
  afterEach(async () => {
    await api.close();
  });

  it("preflight is read-only: no install, no service", async () => {
    const runner = new FakeRunner();
    const deps: WebuiCliDeps = {
      runtime: {} as ResidentRuntime,
      residentId: "resident-x",
      dataDir: temp(),
      runner,
      log: () => undefined,
    };
    const pre = await preflightWebui(deps);
    expect(pre.ok).toBe(true);
    if (pre.ok) expect(pre.value.proposal).toContain("确认安装");
    expect(runner.live.size).toBe(0);
  });

  it("missing runtime installs nothing and starts no service", async () => {
    const runner = new FakeRunner();
    runner.pythonAvailable = false;
    const deps: WebuiCliDeps = {
      runtime: {} as ResidentRuntime,
      residentId: "resident-x",
      dataDir: temp(),
      runner,
      log: () => undefined,
    };
    const pre = await preflightWebui(deps);
    expect(pre.ok).toBe(true);
    if (!pre.ok) return;
    expect(pre.value.environment).toMatchObject({ docker: false, python: false });
    const outcome = await installWebui(deps, pre.value.environment);
    expect(outcome.status).toBe("missing-runtime");
    expect(runner.live.size).toBe(0);
  });

  it("confirmed path starts a real listener and keeps the borrowed runtime alive after close", async () => {
    const dir = temp();
    const { runtime, residentId, transport } = await runtimeFor(dir);
    const runner = new FakeRunner();
    const deps: WebuiCliDeps = {
      runtime,
      residentId,
      dataDir: dir,
      runner,
      log: () => undefined,
      managementBaseUrl: api.url,
    };
    const pre = await preflightWebui(deps);
    if (!pre.ok) throw new Error("preflight failed");
    const outcome = await installWebui(deps, pre.value.environment);
    expect(outcome.status).toBe("started");
    if (outcome.status !== "started") return;
    expect(outcome.url.startsWith("http://127.0.0.1:")).toBe(true);
    expect(runner.live.size).toBeGreaterThan(0);
    await outcome.close();
    expect(runner.live.size).toBe(0);
    transport.enqueue("after-close");
    const said = await runtime.say({ residentId, text: "still-here" });
    expect(said.ok).toBe(true);
    await runtime.close();
  });

  it("surfaces a safe cleanup error instead of claiming clean when close fails", async () => {
    const dir = temp();
    const { runtime, residentId } = await runtimeFor(dir);
    const runner = new FakeRunner();
    const deps: WebuiCliDeps = {
      runtime,
      residentId,
      dataDir: dir,
      runner,
      log: () => undefined,
      managementBaseUrl: api.url,
    };
    const pre = await preflightWebui(deps);
    if (!pre.ok) throw new Error("preflight failed");
    const outcome = await installWebui(deps, pre.value.environment);
    if (outcome.status !== "started") throw new Error("expected started");
    runner.stopProcess = async () => {
      throw new Error("stop failed");
    };
    await expect(outcome.close()).rejects.toMatchObject({ code: "WEBUI_CLEANUP_FAILED" });
    await runtime.close();
  });
});

describe("#218 real main over piped stdin", () => {
  it("does not hang on /webui preflight and never sends control words to the model", async () => {
    const { spawnSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const { readFileSync, existsSync } = await import("node:fs");
    const dir = temp();
    const record = join(dir, "model-requests.jsonl");
    const fixture = fileURLToPath(
      new URL("./fixtures/resident-cli-webui-child.ts", import.meta.url),
    );
    const result = spawnSync(process.execPath, ["--import", "tsx", fixture, dir, record], {
      input: "/webui\nno\nhello\n/exit\n",
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env },
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("确认安装");
    expect(result.stdout).toContain("已取消");
    const requests = existsSync(record)
      ? readFileSync(record, "utf8")
          .trim()
          .split("\n")
          .filter((l) => l.length > 0)
          .map((l) => JSON.parse(l) as string)
      : [];
    // 只有真实聊天文本；/webui、no 都不进模型。
    expect(requests).toEqual(["hello"]);
  });
});

describe("#218 real main SIGINT during preflight", () => {
  it("cancels install and exits 130 without starting anything", async () => {
    const { spawn } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const dir = temp();
    const record = join(dir, "model-requests.jsonl");
    const fixture = fileURLToPath(
      new URL("./fixtures/resident-cli-webui-child.ts", import.meta.url),
    );
    const child = spawn(process.execPath, ["--import", "tsx", fixture, dir, record], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    await new Promise<void>((resolve) => {
      child.stdout.on("data", () => {
        if (stdout.includes("你> ")) resolve();
      });
    });
    child.stdin.write("/webui\nyes\n");
    await new Promise((resolve) => setTimeout(resolve, 10));
    child.kill("SIGINT");
    const code = await new Promise<number | null>((resolve) =>
      child.once("exit", (value) => resolve(value)),
    );
    expect(code).toBe(130);
    expect(stdout).not.toContain("Open WebUI 已启动");
    expect(stdout).not.toContain("安装并启动 Open WebUI 中");
  });
});
