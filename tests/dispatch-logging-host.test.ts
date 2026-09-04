import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { HistoryNode } from "../acceptance/driver.ts";
import { DISPATCH_RESULT_DROPPED, type DispatchEvent } from "../src/message-tree/index.ts";

type HostReply = {
  requestId?: string;
  type?: string;
  pid?: number;
  ok?: boolean;
  value?: unknown;
  error?: { name?: string; message?: string; code?: string };
};

const children: ChildProcess[] = [];
const fixture = fileURLToPath(new URL("./fixtures/dispatch-logging-host.ts", import.meta.url));

function startHost(): ChildProcess {
  const child = spawn(process.execPath, ["--import", "tsx", fixture], {
    env: { ...process.env },
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
});

describe("MV-B03 dispatch logging (real host subprocess)", () => {
  it("logs complete triples for dispatch/receipt/drop and leaves a late result out of history", async () => {
    const child = startHost();
    await waitForReady(child);
    const residentId = await callHost<string>(child, {
      op: "createResident",
      name: "placeholder-b03",
    });

    await callHost(child, { op: "holdNext" });
    const pending = callHost(child, { op: "say", residentId, message: "会在返回前失去原窗" });

    const started = await callHost<DispatchEvent[]>(child, { op: "events" });
    expect(started).toHaveLength(1);
    expect(started[0]?.event).toBe("dispatch");

    await callHost(child, { op: "killSession", residentId });
    await callHost(child, { op: "release" });
    await expect(pending).rejects.toThrow(DISPATCH_RESULT_DROPPED);

    const afterDrop = await callHost<DispatchEvent[]>(child, { op: "events" });
    expect(afterDrop.map((event) => event.event)).toEqual(["dispatch", "dropped"]);
    expect(afterDrop[1]).toMatchObject({
      residentId,
      windowId: afterDrop[0]?.windowId,
      generation: afterDrop[0]?.generation,
      dispatchId: afterDrop[0]?.dispatchId,
    });
    expect(await callHost<HistoryNode[]>(child, { op: "history", residentId })).toEqual([]);

    await callHost(child, { op: "say", residentId, message: "新窗正常回合" });
    const all = await callHost<DispatchEvent[]>(child, { op: "events" });
    expect(all.map((event) => event.event)).toEqual(["dispatch", "dropped", "dispatch", "receipt"]);
    expect(all[3]).toMatchObject({
      residentId,
      windowId: all[2]?.windowId,
      generation: all[2]?.generation,
      dispatchId: all[2]?.dispatchId,
    });

    // 三类事件逐字段验完整三元组；少任一字段，本条直接红。
    for (const event of all) {
      expect(event.residentId).toBe(residentId);
      expect(event.windowId).toMatch(/^w_[0-9A-Z]{26}$/);
      expect(event.generation).toBe(1);
      expect(event.dispatchId).toMatch(/^dispatch-/);
    }
    expect(all[2]?.windowId).not.toBe(all[0]?.windowId);
    expect(await callHost<HistoryNode[]>(child, { op: "history", residentId })).toHaveLength(2);
  });
});
