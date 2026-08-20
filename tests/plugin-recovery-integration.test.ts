import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginAuthorityRecord } from "../src/plugin/operation-store.ts";
import type { PluginOperationOutcome } from "../src/plugin/transaction-host.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const childScript = join(repoRoot, "tests/fixtures/plugin-host-child.ts");
const directories: string[] = [];
const children: ChildProcess[] = [];

interface ChildResult {
  readonly outcomes: PluginOperationOutcome[];
  readonly published: readonly string[];
  readonly authority: PluginAuthorityRecord;
}

function freshDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "mist-plugin-recovery-"));
  directories.push(directory);
  return directory;
}

function startChild(
  dataDir: string,
  command: "activate" | "activate-dispose" | "recover",
  options: { stopAt?: string; blockPublish?: boolean } = {},
): ChildProcess {
  const child = spawn(process.execPath, ["--import", "tsx", childScript, command], {
    cwd: repoRoot,
    env: {
      ...process.env,
      MIST_PLUGIN_DATA_DIR: dataDir,
      ...(options.stopAt === undefined ? {} : { MIST_PLUGIN_STOP_AT: options.stopAt }),
      ...(options.blockPublish === true ? { MIST_PLUGIN_BLOCK_PUBLISH: "1" } : {}),
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.push(child);
  return child;
}

function waitForCheckpoint(
  child: ChildProcess,
  name: string,
): Promise<{ name: string; resourceId?: string }> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(
      () => reject(new Error(`checkpoint ${name} timed out: ${stderr}`)),
      10_000,
    );
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("message", onMessage);
    child.once("exit", onExit);

    function cleanup() {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
    }
    function onMessage(value: unknown) {
      if (typeof value !== "object" || value === null || !("name" in value)) return;
      const message = value as { name?: unknown; resourceId?: unknown };
      if (message.name !== name) return;
      cleanup();
      resolve({
        name,
        ...(typeof message.resourceId === "string" ? { resourceId: message.resourceId } : {}),
      });
    }
    function onExit(code: number | null, signal: NodeJS.Signals | null) {
      cleanup();
      reject(
        new Error(
          `child exited before ${name}: code=${String(code)} signal=${String(signal)} ${stderr}`,
        ),
      );
    }
  });
}

async function killAt(child: ChildProcess, checkpoint: string): Promise<void> {
  await waitForCheckpoint(child, checkpoint);
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
    child.kill("SIGKILL");
  });
  const index = children.indexOf(child);
  if (index >= 0) children.splice(index, 1);
}

function collect(child: ChildProcess): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      const index = children.indexOf(child);
      if (index >= 0) children.splice(index, 1);
      if (code !== 0) {
        reject(new Error(`child exited ${String(code)}: ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()) as ChildResult);
      } catch (error) {
        reject(new Error(`invalid child output: ${stdout}\n${stderr}`, { cause: error }));
      }
    });
  });
}

function operationRecord(dataDir: string): PluginAuthorityRecord {
  return JSON.parse(
    readFileSync(join(dataDir, "operations", "fixture.plugin.json"), "utf8"),
  ) as PluginAuthorityRecord;
}

function effects(dataDir: string): string[] {
  const directory = join(dataDir, "effects");
  return existsSync(directory) ? readdirSync(directory).sort() : [];
}

function calls(dataDir: string): string[] {
  const path = join(dataDir, "calls.log");
  return existsSync(path)
    ? readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
    : [];
}

afterEach(async () => {
  await Promise.all(
    children.splice(0).map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          child.once("exit", () => resolve());
          child.kill("SIGKILL");
        }),
    ),
  );
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("PV0-C10 real process interruption recovery", () => {
  it("persists operationId/moduleRef/recoveryKey before a resource effect receipt, then recovers without rerunning prepare/activate", async () => {
    const dataDir = freshDirectory();
    const child = startChild(dataDir, "activate", {
      stopAt: "resource-effect-before-receipt",
    });
    await killAt(child, "resource-effect-before-receipt");

    const interrupted = operationRecord(dataDir);
    expect(interrupted.operation.operationId).toBe("fixture-operation-1");
    expect(interrupted.moduleRef).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(interrupted.operation.resources.map((resource) => resource.recoveryKey)).toEqual([
      "recover:route-a",
      "recover:tool-b",
      "recover:tool-c",
    ]);
    expect(interrupted.operation.resources[0]?.phase).toBe("registered");
    expect(effects(dataDir)).toContain("route-a.live");
    const callsBeforeRecovery = calls(dataDir);

    const recovered = await collect(startChild(dataDir, "recover"));

    expect(recovered.outcomes[0]).toMatchObject({
      state: "blocked",
      reasonCode: "ACTIVATE_FAILED",
      operationId: "fixture-operation-1",
    });
    expect(recovered.published).toEqual([]);
    expect(effects(dataDir)).toEqual([]);
    const recoveryCalls = calls(dataDir).slice(callsBeforeRecovery.length);
    expect(recoveryCalls).not.toContain("prepare");
    expect(recoveryCalls.some((entry) => entry.startsWith("resource.activate:"))).toBe(false);
    expect(recoveryCalls).not.toContain("prepared.activate");
    expect(recoveryCalls).toEqual([
      "recover",
      "recovered.revoke:tool-c",
      "recovered.revoke:tool-b",
      "recovered.revoke:route-a",
      "recovered.rollback",
    ]);
  });

  it("rolls back all committed resources when killed inside the sole publication call", async () => {
    const dataDir = freshDirectory();
    const child = startChild(dataDir, "activate", { blockPublish: true });
    await killAt(child, "plugin-publish-entered");

    expect(operationRecord(dataDir).operation.phase).toBe("authority_committed");
    expect(effects(dataDir)).toEqual([
      "published.live",
      "route-a.live",
      "tool-b.live",
      "tool-c.live",
    ]);
    const callsBeforeRecovery = calls(dataDir);

    const recovered = await collect(startChild(dataDir, "recover"));

    expect(recovered.authority.lifecycleState).toBe("blocked");
    expect(recovered.authority.reasonCode).toBe("ACTIVATE_FAILED");
    expect(recovered.authority.enabled).toBe(true);
    expect(recovered.published).toEqual([]);
    expect(effects(dataDir)).toEqual([]);
    expect(calls(dataDir).slice(callsBeforeRecovery.length)).toEqual([
      "recover",
      "recovered.revoke:tool-c",
      "recovered.revoke:tool-b",
      "recovered.revoke:route-a",
      "recovered.rollback",
    ]);
  });

  it("continues an interrupted dispose from durable receipts and ends disposed", async () => {
    const dataDir = freshDirectory();
    const child = startChild(dataDir, "activate-dispose", {
      stopAt: "dispose-resource-effect-before-receipt",
    });
    await killAt(child, "dispose-resource-effect-before-receipt");

    const interrupted = operationRecord(dataDir);
    expect(interrupted.operation.operation).toBe("dispose");
    expect(interrupted.operation.resources[2]?.phase).toBe("ready");
    expect(effects(dataDir)).not.toContain("tool-c.live");

    const recovered = await collect(startChild(dataDir, "recover"));

    expect(recovered.authority.lifecycleState).toBe("disposed");
    expect(recovered.authority.operation.disposeCompleted).toBe(true);
    expect(recovered.published).toEqual([]);
    expect(effects(dataDir)).toEqual([]);
  });
});

describe("PV0-C11 authority is durable before every public projection", () => {
  const checkpoints = [
    "before-active-authority-commit",
    "active-authority-committed-before-publish",
    "published-before-operation-complete",
  ] as const;

  for (const checkpoint of checkpoints) {
    it(`keeps restarted indexes a subset of authority after SIGKILL at ${checkpoint}`, async () => {
      const dataDir = freshDirectory();
      const child = startChild(dataDir, "activate", { stopAt: checkpoint });
      await killAt(child, checkpoint);

      const interrupted = operationRecord(dataDir);
      if (checkpoint === "before-active-authority-commit") {
        expect(interrupted.lifecycleState).toBe("prepared");
        expect(effects(dataDir)).not.toContain("published.live");
      } else {
        expect(interrupted.lifecycleState).toBe("active");
      }

      const recovered = await collect(startChild(dataDir, "recover"));
      expect(recovered.published).toEqual([]);
      expect(recovered.authority.lifecycleState).toBe("blocked");
      expect(effects(dataDir)).toEqual([]);
    });
  }
});
