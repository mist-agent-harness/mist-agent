import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CanonicalEvent,
  CanonicalEventDraft,
  DeliveryReceipt,
  WriterCheckpointName,
} from "../src/one-stream/index.ts";

type HostReply = {
  requestId?: string;
  type?: string;
  pid?: number;
  name?: WriterCheckpointName;
  ok?: boolean;
  value?: unknown;
  error?: { name?: string; message?: string; code?: string };
};

const children: ChildProcess[] = [];
const directories: string[] = [];
const fixture = fileURLToPath(new URL("./fixtures/one-stream-host.ts", import.meta.url));
let requestSequence = 0;

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "mist-one-stream-host-"));
  directories.push(directory);
  return directory;
}

function startHost(dataDir: string, haltAt?: WriterCheckpointName): ChildProcess {
  const child = spawn(process.execPath, ["--import", "tsx", fixture], {
    env: {
      ...process.env,
      MIST_ONE_STREAM_DIR: dataDir,
      ...(haltAt === undefined ? {} : { MIST_ONE_STREAM_HALT_AT: haltAt }),
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.push(child);
  return child;
}

function draft(label: string, viewportId: string): CanonicalEventDraft {
  return {
    purpose: "progress",
    occurredAt: "2026-08-26T00:00:00.000Z",
    workRef: `work-${label}`,
    authoritySource: { kind: "host", id: "mist-host" },
    origin: {
      reporter: { kind: "viewport", id: viewportId },
      subject: { kind: "work", id: `work-${label}` },
      viewport: { windowId: viewportId, generation: 1 },
    },
    effect: {
      state: "attempted",
      requiresUserAction: false,
      retry: "automatic",
    },
    artifactRef: null,
    payload: { label },
  };
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
    function onExit(code: number | null, signal: NodeJS.Signals | null) {
      cleanup();
      reject(new Error(`host exited ${String(code)}/${String(signal)} before ready: ${stderr}`));
    }
  });
}

function callHost<T>(child: ChildProcess, command: Record<string, unknown>): Promise<T> {
  requestSequence += 1;
  const requestId = `request-${requestSequence}`;
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

async function submitUntilKilled(
  child: ChildProcess,
  checkpoint: WriterCheckpointName,
  request: Record<string, unknown>,
): Promise<void> {
  requestSequence += 1;
  const requestId = `doomed-${requestSequence}`;
  const reached = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`checkpoint timed out: ${checkpoint}`)), 5_000);
    child.on("message", onMessage);
    function onMessage(message: HostReply) {
      if (message.type !== "checkpoint" || message.name !== checkpoint) return;
      clearTimeout(timer);
      child.off("message", onMessage);
      resolve();
    }
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.send?.({ ...request, requestId });
  await reached;
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

describe("one canonical stream real host", () => {
  it("orders concurrent viewport events once and gives all projections identical bytes", async () => {
    const directory = temporaryDirectory();
    const child = startHost(directory);
    await waitForReady(child);

    for (const [residentId, order] of [
      ["resident-ab", ["A", "B"]],
      ["resident-ba", ["B", "A"]],
    ] as const) {
      await callHost(child, { op: "create", residentId });
      await callHost(child, {
        op: "openProjection",
        residentId,
        clientId: `${residentId}-desktop`,
      });
      await callHost(child, { op: "openProjection", residentId, clientId: `${residentId}-mobile` });

      const submissions = order.map((label) =>
        callHost<DeliveryReceipt>(child, {
          op: "submit",
          residentId,
          idempotencyKey: `${residentId}-${label}`,
          draft: draft(label, `viewport-${label}`),
        }),
      );
      await Promise.all(submissions);

      const desktop = await callHost<CanonicalEvent[]>(child, {
        op: "pullProjection",
        clientId: `${residentId}-desktop`,
      });
      const mobile = await callHost<CanonicalEvent[]>(child, {
        op: "pullProjection",
        clientId: `${residentId}-mobile`,
      });
      await callHost(child, {
        op: "openProjection",
        residentId,
        clientId: `${residentId}-offline`,
      });
      const offline = await callHost<CanonicalEvent[]>(child, {
        op: "pullProjection",
        clientId: `${residentId}-offline`,
      });

      expect(desktop).toEqual(mobile);
      expect(mobile).toEqual(offline);
      expect(desktop.map((event) => event.streamSeq)).toEqual([1, 2]);
      expect(new Set(desktop.map((event) => event.eventId))).toHaveLength(2);
      expect(desktop.map((event) => event.payloadHash)).toEqual(
        mobile.map((event) => event.payloadHash),
      );
      expect(desktop.map((event) => event.payload)).toEqual(order.map((label) => ({ label })));
    }

    await stopHost(child);
  });

  for (const scenario of [
    {
      name: "generation before durable write",
      checkpoint: "generated-before-write" as const,
      expectedBeforeRetry: 0,
    },
    {
      name: "durable write before delivery receipt",
      checkpoint: "durable-write-before-receipt" as const,
      expectedBeforeRetry: 1,
    },
  ]) {
    it(`recovers ${scenario.name} without duplicate or false effect`, async () => {
      const directory = temporaryDirectory();
      const initializer = startHost(directory);
      await waitForReady(initializer);
      await callHost(initializer, { op: "create", residentId: "resident-a" });
      await stopHost(initializer);

      const doomed = startHost(directory, scenario.checkpoint);
      await waitForReady(doomed);
      await submitUntilKilled(doomed, scenario.checkpoint, {
        op: "submit",
        residentId: "resident-a",
        idempotencyKey: "dispatch-1",
        draft: draft("original", "viewport-a"),
      });

      const recovered = startHost(directory);
      await waitForReady(recovered);
      const beforeRetry = await callHost<CanonicalEvent[]>(recovered, {
        op: "events",
        residentId: "resident-a",
      });
      expect(beforeRetry).toHaveLength(scenario.expectedBeforeRetry);

      const receipt = await callHost<DeliveryReceipt>(recovered, {
        op: "submit",
        residentId: "resident-a",
        idempotencyKey: "dispatch-1",
        draft: draft("original", "viewport-a"),
      });
      expect(receipt.phase).toBe("delivered");
      expect(receipt).not.toHaveProperty("committedEffective");
      expect(receipt).not.toHaveProperty("authorityHead");

      const afterRetry = await callHost<CanonicalEvent[]>(recovered, {
        op: "events",
        residentId: "resident-a",
      });
      expect(afterRetry).toHaveLength(1);
      expect(afterRetry[0]?.effect.state).toBe("attempted");
      expect(afterRetry[0]?.eventId).toBe(receipt.eventId);

      const snapshotPath = join(directory, "resident-a.stream.json");
      const beforeConflict = readFileSync(snapshotPath, "utf8");
      await expect(
        callHost(recovered, {
          op: "submit",
          residentId: "resident-a",
          idempotencyKey: "dispatch-1",
          draft: draft("changed", "viewport-a"),
        }),
      ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
      expect(readFileSync(snapshotPath, "utf8")).toBe(beforeConflict);

      await stopHost(recovered);
    });
  }
});
