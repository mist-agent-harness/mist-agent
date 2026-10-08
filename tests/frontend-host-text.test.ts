/**
 * D31-1 真文字宿主集成：驱动经夹具宿主进程跑现役 `assembleResidentRuntime` + `say()`，
 * 核真实 user/assistant 文字 root、历史连续、单一 canonical stream、并发串行、
 * 换气到 gen2 后旧代原件留存。夹具宿主是真实 runtime，不是模拟 host。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { TurnResult } from "../acceptance/resident-runtime-driver.ts";
import { HostTextClient } from "../src/frontend/host-text-client.ts";

const HOST_FIXTURE = fileURLToPath(new URL("./fixtures/frontend-text-host.ts", import.meta.url));
const dirs: string[] = [];
const clients: HostTextClient[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface HostResult<T> {
  ok: boolean;
  value?: T;
  reason?: string;
}

async function bootstrap(): Promise<{ client: HostTextClient; residentId: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), "mist-fe-host-"));
  dirs.push(dataDir);
  const client = new HostTextClient({ dataDir, hostPath: HOST_FIXTURE });
  clients.push(client);
  await client.start();
  const candidate = await client.call<{ candidateId: string }>("createCandidate", {
    persona: "persona:resident-host",
    proposedBy: { kind: "installer", id: "test" },
    residentId: "resident-host",
  });
  await client.call("attestCandidate", {
    candidateId: candidate.candidateId,
    actor: { kind: "candidate", candidateId: candidate.candidateId },
    decision: "accepted",
  });
  const active = await client.call<HostResult<{ residentId: string }>>("requireActiveResident", {
    referenceId: "resident-host",
  });
  if (!active.ok || active.value === undefined) throw new Error("resident not active");
  const residentId = active.value.residentId;
  await client.call("provisionChannel", {
    residentId,
    channel: { claudeSubscription: false, credentialKind: "api-key", model: "pi-test/model" },
    canarySecret: "synthetic-canary",
  });
  return { client, residentId };
}

async function streamTexts(client: HostTextClient, residentId: string): Promise<string[]> {
  const snapshot = await client.call<HostResult<{ events: ReadonlyArray<{ text: string }> }>>(
    "readStream",
    { residentId },
  );
  return snapshot.ok && snapshot.value !== undefined
    ? snapshot.value.events.map((event) => event.text)
    : [];
}

async function say(client: HostTextClient, residentId: string, text: string): Promise<TurnResult> {
  const result = await client.call<HostResult<TurnResult>>("say", { residentId, text });
  if (!result.ok || result.value === undefined) throw new Error(`say failed: ${result.reason}`);
  return result.value;
}

describe("#218 real host text wiring", () => {
  it("writes exactly one user/assistant text root per turn and keeps history", async () => {
    const { client, residentId } = await bootstrap();
    await client.call("enqueueReply", { residentId, text: "reply-1" });
    const first = await say(client, residentId, "user-1");
    expect(first.reply).toBe("reply-1");
    expect(await streamTexts(client, residentId)).toEqual(["user-1", "reply-1"]);

    await client.call("enqueueReply", { residentId, text: "reply-2" });
    await say(client, residentId, "user-2");
    expect(await streamTexts(client, residentId)).toEqual([
      "user-1",
      "reply-1",
      "user-2",
      "reply-2",
    ]);

    // 下一回合模型真实收到前两条历史。
    const requests = await client.call<
      ReadonlyArray<{ text: string; history: ReadonlyArray<{ text: string }> }>
    >("readModelRequests", {});
    expect(requests.at(-1)?.history.map((m) => m.text)).toEqual(["user-1", "reply-1"]);
    expect(requests.at(-1)?.text).toBe("user-2");
  });

  it("keeps a single canonical stream file (one writer, one stream)", async () => {
    const { client, residentId } = await bootstrap();
    await client.call("enqueueReply", { residentId, text: "a" });
    await say(client, residentId, "u");
    const files = await client.call<HostResult<{ files: readonly string[] }>>("streamFiles", {});
    expect(files.ok).toBe(true);
    expect(files.value?.files.length).toBe(1);
  });

  it("serializes concurrent turns without interleaving", async () => {
    const { client, residentId } = await bootstrap();
    await client.call("enqueueReply", { residentId, text: "a1" });
    await client.call("enqueueReply", { residentId, text: "a2" });
    await Promise.all([say(client, residentId, "u1"), say(client, residentId, "u2")]);
    const texts = await streamTexts(client, residentId);
    expect(texts.length).toBe(4);
    // 每个 user 后紧跟同回合 assistant（串行、不交错）。
    const paired =
      (texts[0] === "u1" && texts[1] === "a1" && texts[2] === "u2" && texts[3] === "a2") ||
      (texts[0] === "u2" && texts[1] === "a2" && texts[2] === "u1" && texts[3] === "a1");
    expect(paired).toBe(true);
  });

  it("breathes to generation 2 while keeping old-generation originals", async () => {
    const { client, residentId } = await bootstrap();
    await client.call("enqueueReply", { residentId, text: "reply-1" });
    const gen1 = await say(client, residentId, "user-1");
    expect(gen1.generation).toBe(1);
    const breathe = await client.call<HostResult<{ toGeneration: number }>>("breathe", {
      residentId,
      via: "new",
    });
    expect(breathe.ok).toBe(true);
    expect(breathe.value?.toGeneration).toBe(2);
    // 旧代原件仍可读。
    expect(await streamTexts(client, residentId)).toEqual(["user-1", "reply-1"]);
    await client.call("enqueueReply", { residentId, text: "reply-2" });
    const gen2 = await say(client, residentId, "user-2");
    expect(gen2.generation).toBe(2);
    expect(await streamTexts(client, residentId)).toEqual([
      "user-1",
      "reply-1",
      "user-2",
      "reply-2",
    ]);
  });
});
