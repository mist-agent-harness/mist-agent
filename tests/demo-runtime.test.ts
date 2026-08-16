import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  type PersistentDemoRuntime,
  type PersistentDemoRuntimeOptions,
  createPersistentDemoRuntime,
} from "../demo/runtime.ts";

const dirs: string[] = [];
const runtimes: PersistentDemoRuntime[] = [];
const children: ChildProcess[] = [];
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const runtimeModuleUrl = pathToFileURL(join(repoRoot, "demo/runtime.ts")).href;
const lockHolderScript = `
const { createPersistentDemoRuntime } = await import(process.env.MIST_RUNTIME_MODULE);
try {
  const runtime = await createPersistentDemoRuntime({ dataDir: process.env.MIST_TEST_DATA_DIR });
  console.log(JSON.stringify({ residentId: runtime.inspect().residentId, pid: process.pid }));
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    clearTimeout(expiry);
    runtime.close();
    process.exit(0);
  };
  const expiry = setTimeout(stop, 5000);
  process.on("message", async (command) => {
    if (command === "reset") {
      await runtime.reset();
      process.send?.({ reset: true, residentId: runtime.inspect().residentId });
    } else if (command === "stop") {
      stop();
    }
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
`;

function freshDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "mist-demo-runtime-"));
  dirs.push(directory);
  return directory;
}

async function openRuntime(options: PersistentDemoRuntimeOptions): Promise<PersistentDemoRuntime> {
  const runtime = await createPersistentDemoRuntime(options);
  runtimes.push(runtime);
  return runtime;
}

function startDemoProcess(dataDir: string): ChildProcess {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", lockHolderScript],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        MIST_RUNTIME_MODULE: runtimeModuleUrl,
        MIST_TEST_DATA_DIR: dataDir,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  children.push(child);
  return child;
}

function waitForStartup(child: ChildProcess): Promise<{
  residentId: string;
  pid: number;
}> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => reject(new Error("demo process startup timed out")), 10_000);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      cleanup();
      try {
        resolve(JSON.parse(stdout.slice(0, newline)));
      } catch (error) {
        reject(error);
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("exit", onExit);

    function cleanup() {
      child.off("exit", onExit);
    }
    function onExit(code: number | null) {
      clearTimeout(timer);
      reject(new Error(`demo process exited ${String(code)} before startup: ${stderr}`));
    }
  });
}

function collectProcess(child: ChildProcess): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
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
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

function resetChild(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("demo process reset timed out")), 5_000);
    child.once("message", (message) => {
      clearTimeout(timer);
      const result = message as { reset?: unknown; residentId?: unknown };
      if (result.reset === true && typeof result.residentId === "string") {
        resolve(result.residentId);
      } else {
        reject(new Error(`unexpected reset response: ${JSON.stringify(message)}`));
      }
    });
    child.send?.("reset", (error) => {
      if (error !== null) {
        clearTimeout(timer);
        reject(error);
      }
    });
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 6_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    try {
      child.send?.("stop");
    } catch {
      // The holder also self-expires, so cleanup does not need broad process signals.
    }
  });
}

afterEach(async () => {
  await Promise.all(children.splice(0).map(stopChild));
  for (const runtime of runtimes.splice(0)) runtime.close();
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const seed = {
  id: "runtime-test-seed",
  name: "编造的住户",
  memories: ["记得纸船是蓝色的。"],
  commitments: ["答应重启后仍认得纸船。"],
};

describe("persistent demo runtime", () => {
  it("keeps identity and resident state across restart while opening a new message root", async () => {
    const dataDir = freshDir();
    const reply = async (_residentId: string, message: string) => `脑子:${message}`;
    const first = await openRuntime({ dataDir, reply, seed });
    const firstResidentId = first.inspect().residentId;
    await first.inspect().driver.say(firstResidentId, "重启前一句");
    first.close();

    const second = await openRuntime({ dataDir, reply, seed });
    const secondResidentId = second.inspect().residentId;
    const bootPack = await second.bootPack();
    const answer = await second.inspect().driver.say(secondResidentId, "重启后第一句");
    const history = await second.inspect().driver.history(secondResidentId);
    const user = history.find((node) => node.role === "user");

    expect(secondResidentId).toBe(firstResidentId);
    expect(bootPack.identity).toBe(seed.name);
    expect(bootPack.memories.map((memory) => memory.content)).toEqual(seed.memories);
    expect(bootPack.commitments).toEqual(seed.commitments);
    expect(answer.content).toBe("脑子:重启后第一句");
    expect(user?.content).toBe("重启后第一句");
    expect(user?.parentId).toBeNull();
    expect(history.some((node) => node.content === "重启前一句")).toBe(false);
  });

  it("reset reseeds a new resident and removes the old snapshot", async () => {
    const dataDir = freshDir();
    const runtime = await openRuntime({ dataDir, seed });
    const oldResidentId = runtime.inspect().residentId;

    await runtime.reset();

    const newResidentId = runtime.inspect().residentId;
    const snapshots = readdirSync(join(dataDir, "residents"));
    expect(newResidentId).not.toBe(oldResidentId);
    expect(snapshots).toEqual([`${newResidentId}.json`]);
    expect((await runtime.bootPack()).memories.map((memory) => memory.content)).toEqual(
      seed.memories,
    );
    const state = JSON.parse(readFileSync(join(dataDir, "demo-state.json"), "utf8"));
    expect(state.residentId).toBe(newResidentId);
    expect(state.seedId).toBe(seed.id);
    expect(state.schemaVersion).toBe(2);
  });

  it("fails closed for corrupt state and for snapshots without an identity pointer", async () => {
    const corrupt = freshDir();
    writeFileSync(
      join(corrupt, "demo-state.json"),
      JSON.stringify({ schemaVersion: 99, seedId: seed.id, residentId: "resident-missing" }),
    );
    await expect(createPersistentDemoRuntime({ dataDir: corrupt, seed })).rejects.toThrow(
      /unsupported demo state schema/,
    );

    const orphaned = freshDir();
    const first = await openRuntime({ dataDir: orphaned, seed });
    const residentId = first.inspect().residentId;
    first.close();
    rmSync(join(orphaned, "demo-state.json"));
    expect(residentId).toMatch(/^resident-/);
    await expect(createPersistentDemoRuntime({ dataDir: orphaned, seed })).rejects.toThrow(
      /snapshots exist without demo-state/,
    );
  });

  it("does not collect snapshots when the identity pointer cannot be opened", async () => {
    const dataDir = freshDir();
    const first = await openRuntime({ dataDir, seed });
    const existingSnapshot = `${first.inspect().residentId}.json`;
    first.close();
    writeFileSync(
      join(dataDir, "demo-state.json"),
      JSON.stringify({ schemaVersion: 2, seedId: seed.id, residentId: "resident-missing" }),
    );

    await expect(createPersistentDemoRuntime({ dataDir, seed })).rejects.toThrow();
    expect(readdirSync(join(dataDir, "residents"))).toContain(existingSnapshot);
  });

  it("starts two real demo processes and rejects the second with the lock owner's pid", async () => {
    const dataDir = freshDir();
    const first = startDemoProcess(dataDir);
    const startup = await waitForStartup(first);
    expect(first.pid).toBeTypeOf("number");
    expect(startup.pid).toBe(first.pid);

    const second = startDemoProcess(dataDir);
    const collision = await collectProcess(second);

    expect(collision.code).toBe(1);
    expect(collision.stdout).toBe("");
    expect(collision.stderr).toContain("demo data directory is locked");
    expect(collision.stderr).toContain(`pid ${String(first.pid)}`);

    const resetResidentId = await resetChild(first);
    expect(resetResidentId).not.toBe(startup.residentId);
    const state = JSON.parse(readFileSync(join(dataDir, "demo-state.json"), "utf8"));
    expect(state.residentId).toBe(resetResidentId);
    expect(existsSync(join(dataDir, "residents", `${resetResidentId}.json`))).toBe(true);
  });
});
