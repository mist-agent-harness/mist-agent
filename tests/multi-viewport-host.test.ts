import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

type HostReply = {
  requestId?: string;
  type?: string;
  pid?: number;
  ok?: boolean;
  value?: unknown;
  error?: { name?: string; message?: string; code?: string };
};

type WindowRecord = {
  residentId: string;
  windowId: string;
  scopeId: string;
  generation: number;
  headId: string | null;
};

type Receipt = {
  residentId: string;
  windowId: string;
  generation: number;
  dispatchId: string;
};

const children: ChildProcess[] = [];
const directories: string[] = [];
const fixture = fileURLToPath(new URL("./fixtures/session-registry-host.ts", import.meta.url));

function startHost(archivePath?: string): ChildProcess {
  const child = spawn(process.execPath, ["--import", "tsx", fixture], {
    env: {
      ...process.env,
      ...(archivePath === undefined ? {} : { MIST_WINDOW_ARCHIVE_PATH: archivePath }),
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.push(child);
  return child;
}

function waitForReady(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`host startup timed out: ${stderr}`)), 10_000);
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
    function onMessage(message: HostReply) {
      if (message.type !== "ready" || typeof message.pid !== "number") return;
      cleanup();
      resolve(message.pid);
    }
    function onExit(code: number | null) {
      cleanup();
      reject(new Error(`host exited ${String(code)} before ready: ${stderr}`));
    }
  });
}

let requestSeq = 0;
function callHost<T>(child: ChildProcess, command: Record<string, unknown>): Promise<T> {
  requestSeq += 1;
  const requestId = `request-${requestSeq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`host request timed out: ${requestId}`)),
      5_000,
    );
    child.on("message", onMessage);

    function cleanup() {
      clearTimeout(timer);
      child.off("message", onMessage);
    }
    function onMessage(message: HostReply) {
      if (message.requestId !== requestId) return;
      cleanup();
      if (message.ok === true) {
        resolve(message.value as T);
      } else {
        reject(
          new Error(`${message.error?.code ?? message.error?.name}: ${message.error?.message}`),
        );
      }
    }

    child.send?.({ ...command, requestId }, (error) => {
      if (error === null) return;
      cleanup();
      reject(error);
    });
  });
}

async function stopHost(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  await callHost(child, { op: "stop" });
  await exited;
}

afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      try {
        await stopHost(child);
      } catch {
        child.kill();
      }
    }),
  );
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("multi-viewport real host subprocess", () => {
  it("opens two windows, kills and reopens one generation, and keeps the other live", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mist-viewport-host-"));
    directories.push(directory);
    const archivePath = join(directory, "windows.jsonl");
    const child = startHost(archivePath);
    const pid = await waitForReady(child);
    expect(pid).toBe(child.pid);

    const w1 = await callHost<WindowRecord>(child, {
      op: "open",
      residentId: "resident-a",
      scopeId: "room-1",
    });
    const w2 = await callHost<WindowRecord>(child, {
      op: "open",
      residentId: "resident-a",
      scopeId: "room-1",
    });
    expect(w1.windowId).not.toBe(w2.windowId);
    expect([w1.generation, w2.generation]).toEqual([1, 1]);

    await callHost(child, { op: "setHead", windowId: w1.windowId, headId: "node-w1" });
    await callHost(child, { op: "setHead", windowId: w2.windowId, headId: "node-w2" });
    const r1 = await callHost<Receipt>(child, { op: "issueDispatch", windowId: w1.windowId });
    const r2 = await callHost<Receipt>(child, { op: "issueDispatch", windowId: w2.windowId });

    const firstArchive = await callHost(child, { op: "kill", windowId: w1.windowId });
    const secondArchive = await callHost(child, { op: "kill", windowId: w1.windowId });
    expect(secondArchive).toEqual(firstArchive);
    expect(await callHost(child, { op: "belongs", receipt: r1 })).toBe(false);
    expect(await callHost(child, { op: "belongs", receipt: r2 })).toBe(true);
    expect(await callHost<WindowRecord>(child, { op: "get", windowId: w2.windowId })).toMatchObject(
      {
        headId: "node-w2",
        generation: 1,
      },
    );

    const killed = await callHost<WindowRecord[]>(child, {
      op: "killResident",
      residentId: "resident-a",
    });
    expect(killed.map((window) => window.windowId)).toEqual([w2.windowId]);
    await stopHost(child);

    const restarted = startHost(archivePath);
    await waitForReady(restarted);
    expect(
      await callHost<WindowRecord>(restarted, { op: "getArchived", windowId: w1.windowId }),
    ).toMatchObject({ generation: 1, headId: "node-w1" });
    expect(
      await callHost<WindowRecord>(restarted, { op: "getArchived", windowId: w2.windowId }),
    ).toMatchObject({ generation: 1, headId: "node-w2" });

    const reopened = await callHost<WindowRecord>(restarted, {
      op: "open",
      residentId: "resident-a",
      scopeId: "room-1",
      windowId: w1.windowId,
    });
    expect(reopened.generation).toBe(2);
    expect(await callHost(restarted, { op: "belongs", receipt: r1 })).toBe(false);
    const generation2Receipt = await callHost<Receipt>(restarted, {
      op: "issueDispatch",
      windowId: w1.windowId,
    });
    await stopHost(restarted);

    // 活窗在未归档时正常停机；第三个进程必须从发号水位继续到 generation 3，
    // 不能重复发 generation 2，让上一化身的迟到回执复活。
    const restartedAgain = startHost(archivePath);
    await waitForReady(restartedAgain);
    const reopenedAgain = await callHost<WindowRecord>(restartedAgain, {
      op: "open",
      residentId: "resident-a",
      scopeId: "room-1",
      windowId: w1.windowId,
    });
    expect(reopenedAgain.generation).toBe(3);
    expect(await callHost(restartedAgain, { op: "belongs", receipt: generation2Receipt })).toBe(
      false,
    );
    await stopHost(restartedAgain);
  });
});
