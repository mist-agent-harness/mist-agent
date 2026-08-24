import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

type Reply = {
  requestId?: string;
  type?: string;
  ok?: boolean;
  value?: unknown;
  error?: { name?: string; message?: string; code?: string };
};

const fixture = new URL("./fixtures/intentional-isolation-host.ts", import.meta.url);
const children: ChildProcess[] = [];

function startHost(): ChildProcess {
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(fixture)], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.push(child);
  return child;
}

function waitForReady(child: ChildProcess): Promise<void> {
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
    function onMessage(message: Reply) {
      if (message.type !== "ready") return;
      cleanup();
      resolve();
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
    function onMessage(message: Reply) {
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

describe("intentional isolation public host path", () => {
  it("公开 create 后共享状态立即可见，下一次 say 才注入存在且不污染 transcript", async () => {
    const child = startHost();
    await waitForReady(child);

    const created = await callHost<{
      scopeId: string;
      name: string;
      status: string;
    }>(child, { op: "create", name: "public-path-project" });
    expect(created).toMatchObject({ name: "public-path-project", status: "ready" });

    const shared = await callHost<Array<{ scopeId: string }>>(child, { op: "sharedState" });
    expect(shared.map((scope) => scope.scopeId)).toEqual([created.scopeId]);

    await callHost(child, { op: "sayIsolated", message: "work inside isolation" });
    const isolatedPrompt = await callHost<string[]>(child, { op: "prompts" });
    expect(isolatedPrompt).toEqual(["work inside isolation"]);

    await callHost(child, { op: "say", message: "first public input" });
    const prompts = await callHost<string[]>(child, { op: "prompts" });
    expect(prompts[1]).toContain("[scope-presence]");
    expect(prompts[1]).toContain(created.scopeId);
    expect(prompts[1]).toContain("first public input");

    const history = await callHost<Array<{ role: string; content: string }>>(child, {
      op: "history",
    });
    expect(
      history.some((node) => node.role === "user" && node.content === "first public input"),
    ).toBe(true);
    expect(history.some((node) => node.content.includes("[scope-presence]"))).toBe(false);

    await callHost(child, { op: "say", message: "second public input" });
    const afterAck = await callHost<string[]>(child, { op: "prompts" });
    expect(afterAck[2]).toBe("second public input");
  });
});
