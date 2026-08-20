import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PluginAuthorityRecord } from "../../src/plugin/operation-store.ts";
import type { PluginOperationOutcome } from "../../src/plugin/transaction-host.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const childScript = join(repoRoot, "tests/fixtures/plugin-host-child.ts");
const directories: string[] = [];
const children: ChildProcess[] = [];

export interface ChildResult {
  readonly outcomes: PluginOperationOutcome[];
  readonly published: readonly string[];
  readonly authority: PluginAuthorityRecord;
}

export function freshProcessDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "mist-pv0-c-process-"));
  directories.push(directory);
  return directory;
}

export function startPluginHostChild(
  dataDir: string,
  command: "activate" | "activate-dispose" | "recover",
  options: {
    readonly stopAt?: string;
    readonly blockPublish?: boolean;
    readonly moduleSourcePath?: string;
  } = {},
): ChildProcess {
  const child = spawn(process.execPath, ["--import", "tsx", childScript, command], {
    cwd: repoRoot,
    env: {
      ...process.env,
      MIST_PLUGIN_DATA_DIR: dataDir,
      ...(options.stopAt === undefined ? {} : { MIST_PLUGIN_STOP_AT: options.stopAt }),
      ...(options.blockPublish === true ? { MIST_PLUGIN_BLOCK_PUBLISH: "1" } : {}),
      ...(options.moduleSourcePath === undefined
        ? {}
        : { MIST_PLUGIN_MODULE_SOURCE_PATH: options.moduleSourcePath }),
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.push(child);
  return child;
}

export async function killChildAt(child: ChildProcess, checkpoint: string): Promise<void> {
  await waitForCheckpoint(child, checkpoint);
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
    child.kill("SIGKILL");
  });
  forgetChild(child);
}

export function collectChild(child: ChildProcess): Promise<ChildResult> {
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
      forgetChild(child);
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

export function processOperationRecord(dataDir: string): PluginAuthorityRecord {
  return JSON.parse(
    readFileSync(join(dataDir, "operations", "fixture.plugin.json"), "utf8"),
  ) as PluginAuthorityRecord;
}

export function processEffects(dataDir: string): string[] {
  const directory = join(dataDir, "effects");
  return existsSync(directory) ? readdirSync(directory).sort() : [];
}

export function processCalls(dataDir: string): string[] {
  const path = join(dataDir, "calls.log");
  return existsSync(path)
    ? readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .filter((line) => line.length > 0)
    : [];
}

export async function cleanupProcessHarness(): Promise<void> {
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
}

function waitForCheckpoint(
  child: ChildProcess,
  name: string,
): Promise<{ readonly name: string; readonly resourceId?: string }> {
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
      const message = value as { readonly name?: unknown; readonly resourceId?: unknown };
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

function forgetChild(child: ChildProcess): void {
  const index = children.indexOf(child);
  if (index >= 0) children.splice(index, 1);
}
