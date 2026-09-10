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
const fixture = fileURLToPath(new URL("./fixtures/scope-dispatch-host.ts", import.meta.url));

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

describe("scope retirement through the real isolation host", () => {
  it("drops the original activation result, keeps B working, and never revives A's old viewport", async () => {
    const child = startHost();
    await waitForReady(child);
    const a = await callHost<{ scopeId: string; entryWindowId: string }>(child, {
      op: "create",
      name: "A",
    });
    const b = await callHost<{ scopeId: string; entryWindowId: string }>(child, {
      op: "create",
      name: "B",
    });
    await callHost(child, { op: "hold" });
    const pending = callHost(child, {
      op: "say",
      windowId: a.entryWindowId,
      message: "A old work",
    });
    // Attach rejection handling before releasing the responder.
    const dropped = expect(pending).rejects.toThrow(DISPATCH_RESULT_DROPPED);
    const started = await callHost<DispatchEvent[]>(child, { op: "events" });
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ event: "dispatch", scopeId: a.scopeId, scopeGeneration: 1 });
    await callHost(child, { op: "retire", scopeId: a.scopeId, scopeGeneration: 1 });
    await callHost(child, { op: "say", windowId: b.entryWindowId, message: "B still works" });
    await expect(callHost(child, { op: "open", scopeId: a.scopeId })).rejects.toThrow(
      "SCOPE_INACTIVE",
    );
    await callHost(child, { op: "activate", scopeId: a.scopeId });
    await callHost(child, { op: "release" });
    await dropped;
    await expect(
      callHost(child, { op: "say", windowId: a.entryWindowId, message: "stale viewport" }),
    ).rejects.toThrow("SCOPE_INACTIVE");
    await callHost(child, { op: "kill", windowId: a.entryWindowId });
    const reopened = await callHost<{
      windowId: string;
      generation: number;
      scopeGeneration: number;
    }>(child, { op: "open", scopeId: a.scopeId, windowId: a.entryWindowId });
    expect(reopened).toMatchObject({ generation: 2, scopeGeneration: 2 });
    await callHost(child, { op: "say", windowId: reopened.windowId, message: "A new work" });
    const events = await callHost<DispatchEvent[]>(child, { op: "events" });
    expect(events.map((event) => event.event)).toEqual([
      "dispatch",
      "dispatch",
      "receipt",
      "dropped",
      "dispatch",
      "receipt",
    ]);
    for (const event of events) {
      expect(event.residentId).toEqual(expect.any(String));
      expect(event.residentId.length).toBeGreaterThan(0);
      expect(event.scopeId).toEqual(expect.any(String));
      expect(event.scopeId.length).toBeGreaterThan(0);
      expect(Number.isSafeInteger(event.scopeGeneration)).toBe(true);
      expect(event.scopeGeneration).toBeGreaterThan(0);
      expect(event.dispatchId).toMatch(/^dispatch-/);
      expect(event.windowId).toMatch(/^w_/);
      expect(event.generation).toBeGreaterThan(0);
    }
    expect(events[3]).toMatchObject({
      ...started[0],
      event: "dropped",
      detail: expect.any(String),
    });
    expect(events[2]).toMatchObject({ scopeId: b.scopeId, scopeGeneration: 1 });
    expect(events[5]).toMatchObject({ scopeId: a.scopeId, scopeGeneration: 2 });
    const history = await callHost<HistoryNode[]>(child, { op: "history" });
    expect(history).toHaveLength(4);
    expect(JSON.stringify(history)).not.toContain("A old work");
    expect(JSON.stringify(history)).not.toContain("old result");
  });

  it("rejects forged ids and a revoked in-flight result through the host, without touching B", async () => {
    const child = startHost();
    await waitForReady(child);
    const a = await callHost<{ entryWindowId: string }>(child, { op: "create", name: "A" });
    const b = await callHost<{ entryWindowId: string }>(child, { op: "create", name: "B" });
    await callHost(child, { op: "hold" });
    const pending = callHost(child, {
      op: "say",
      windowId: a.entryWindowId,
      message: "revoked turn",
    });
    const dropped = expect(pending).rejects.toThrow(DISPATCH_RESULT_DROPPED);
    const [receipt] = await callHost<DispatchEvent[]>(child, { op: "events" });
    expect(receipt).toBeDefined();
    expect(
      await callHost(child, {
        op: "belongs",
        receipt: { ...receipt, dispatchId: "dispatch-forged" },
      }),
    ).toBe(false);
    expect(await callHost(child, { op: "belongs", receipt })).toBe(true);
    expect(await callHost(child, { op: "revoke", receipt })).toBe(true);
    await callHost(child, { op: "say", windowId: b.entryWindowId, message: "B unaffected" });
    await callHost(child, { op: "release" });
    await dropped;
    const events = await callHost<DispatchEvent[]>(child, { op: "events" });
    expect(events.map((event) => event.event)).toEqual([
      "dispatch",
      "dispatch",
      "receipt",
      "dropped",
    ]);
    expect(events[3]).toMatchObject({ ...receipt, event: "dropped", detail: expect.any(String) });
    // A terminal receipt cannot be consumed again or impersonate an outstanding dispatch.
    expect(await callHost(child, { op: "consume", receipt: events[2] })).toBe(false);
    expect(await callHost(child, { op: "consume", receipt })).toBe(false);
    const history = await callHost<HistoryNode[]>(child, { op: "history" });
    expect(history).toHaveLength(2);
    expect(JSON.stringify(history)).not.toContain("revoked turn");
    expect(JSON.stringify(history)).not.toContain("old result");
  });
});
