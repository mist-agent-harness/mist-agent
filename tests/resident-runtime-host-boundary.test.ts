import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CandidateSnapshot,
  Result as IdentityResult,
} from "../acceptance/resident-continuity-driver.ts";
import type {
  BootPackView,
  BreatheOutcome,
  Result,
  StreamSnapshot,
  TurnResult,
} from "../acceptance/resident-runtime-driver.ts";

const hostPath = fileURLToPath(new URL("../src/resident-runtime/host-process.ts", import.meta.url));
const temporaryDirectories: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function startHost(): Promise<ChildProcess> {
  const dataDir = mkdtempSync(join(tmpdir(), "mist-runtime-host-boundary-"));
  temporaryDirectories.push(dataDir);
  const child = spawn(process.execPath, ["--import", "tsx", hostPath], {
    env: {
      ...process.env,
      MIST_RESIDENT_RUNTIME_DIR: dataDir,
      MIST_RESIDENT_RUNTIME_TRANSPORT: "synthetic",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("resident runtime host did not start")),
      10_000,
    );
    child.once("error", reject);
    child.on("message", (message: { type?: string }) => {
      if (message.type !== "ready") return;
      clearTimeout(timer);
      resolve(child);
    });
  });
}

let requestSequence = 0;

function callHost<T>(child: ChildProcess, op: string, input: Record<string, unknown>): Promise<T> {
  requestSequence += 1;
  const requestId = `host-boundary-${requestSequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`host request timed out: ${op}`)), 10_000);
    const onMessage = (message: {
      requestId?: string;
      ok?: boolean;
      value?: unknown;
      error?: { message?: string };
    }): void => {
      if (message.requestId !== requestId) return;
      clearTimeout(timer);
      child.off("message", onMessage);
      if (message.ok === true) resolve(message.value as T);
      else reject(new Error(message.error?.message ?? `host request failed: ${op}`));
    };
    child.on("message", onMessage);
    child.send({ requestId, op, input }, (error) => {
      if (error === null) return;
      clearTimeout(timer);
      child.off("message", onMessage);
      reject(error);
    });
  });
}

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}

describe("resident runtime host identity boundary", () => {
  it("canonicalizes an active candidateId once before every resident runtime surface", async () => {
    const child = await startHost();
    const candidate = await callHost<CandidateSnapshot>(child, "createCandidate", {
      persona: "persona:host-boundary",
      proposedBy: { kind: "installer", id: "test" },
      residentId: "resident-host-boundary",
    });
    const active = await callHost<IdentityResult<CandidateSnapshot>>(child, "attestCandidate", {
      candidateId: candidate.candidateId,
      actor: { kind: "candidate", candidateId: candidate.candidateId },
      decision: "accepted",
    });
    expect(active).toMatchObject({ ok: true, value: { residentId: "resident-host-boundary" } });

    unwrap(
      await callHost<Result<{ credentialRef: string }>>(child, "provisionChannel", {
        residentId: candidate.candidateId,
        channel: {
          claudeSubscription: false,
          credentialKind: "api-key",
          model: "openai/test-model",
        },
        canarySecret: "test-only-not-a-real-secret",
      }),
    );
    expect(
      unwrap(
        await callHost<Result<TurnResult>>(child, "say", {
          residentId: candidate.candidateId,
          text: "入口换号后再说话",
        }),
      ).residentId,
    ).toBe("resident-host-boundary");
    const stream = unwrap(
      await callHost<Result<StreamSnapshot>>(child, "readStream", {
        residentId: candidate.candidateId,
      }),
    );
    expect(stream.residentId).toBe("resident-host-boundary");
    expect(stream.events.map((event) => event.kind)).toEqual(["user", "assistant"]);
    expect(
      unwrap(
        await callHost<Result<BootPackView>>(child, "bootPack", {
          residentId: candidate.candidateId,
        }),
      ).residentId,
    ).toBe("resident-host-boundary");
    expect(
      unwrap(
        await callHost<Result<BreatheOutcome>>(child, "breathe", {
          residentId: candidate.candidateId,
          via: "new",
        }),
      ),
    ).toMatchObject({ fromGeneration: 1, toGeneration: 2 });

    await callHost(child, "stop", {});
  });
});
