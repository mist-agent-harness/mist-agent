/**
 * D31-1 产品文字 HTTP 入口：`startFrontendHost` 接 `HostTextEngine`（借用本进程
 * `ResidentRuntime`），文字回合经宿主 `say()` 写账。核鉴权先于解析、伪造历史丢弃、
 * utility 拒绝、canonical 真实事件；并核关前端不关借用 owner（owner 仍能 say）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type FrontendHost, startFrontendHost } from "../src/frontend/frontend-host.ts";
import { InProcessResidentHostPort } from "../src/frontend/host-port.ts";
import { HostTextEngine } from "../src/frontend/host-text-engine.ts";
import { assembleResidentRuntime } from "../src/resident-runtime/assembly.ts";
import type { ModelTransport } from "../src/resident-runtime/channels.ts";
import type { ResidentRuntime } from "../src/resident-runtime/runtime.ts";

const dirs: string[] = [];
const hosts: FrontendHost[] = [];
const runtimes: ResidentRuntime[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close();
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

class QueueTransport implements ModelTransport {
  readonly #queue: string[] = [];
  enqueue(text: string): void {
    this.#queue.push(text);
  }
  async *complete(): AsyncIterable<string> {
    const reply = this.#queue.shift();
    if (reply === undefined) throw new Error("no queued reply");
    yield reply;
  }
}

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "mist-fe-http-"));
  dirs.push(dataDir);
  const transport = new QueueTransport();
  const runtime = assembleResidentRuntime({ dataDir, transport });
  runtimes.push(runtime);
  const candidate = runtime.createCandidate({
    persona: "persona:resident-http",
    proposedBy: { kind: "installer", id: "test" },
    residentId: "resident-http",
  });
  runtime.attestCandidate(
    candidate.candidateId,
    { kind: "candidate", candidateId: candidate.candidateId },
    "accepted",
  );
  const active = runtime.requireActiveResident("resident-http");
  if (!active.ok) throw new Error("resident not active");
  const residentId = active.value.residentId;
  await runtime.provisionChannel({
    residentId,
    channel: { claudeSubscription: false, credentialKind: "api-key", model: "pi-test/model" },
    canarySecret: "synthetic-canary",
  });
  const engine = new HostTextEngine(new InProcessResidentHostPort(runtime));
  const binding = {
    bindingId: "binding:http",
    endpointId: "endpoint:http",
    residentId,
    scopeId: "scope:http",
    streamId: `stream:${residentId}`,
    token: "mist-token-http",
    serverModel: "mist:http",
    canonicalWriterId: `owner:${residentId}`,
  };
  engine.registerBinding(binding);
  const host = await startFrontendHost({ engine });
  hosts.push(host);
  return { engine, runtime, transport, binding, host };
}

function headers(token: string | null): Record<string, string> {
  const value: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== null) value.Authorization = `Bearer ${token}`;
  return value;
}

describe("#218 product HTTP host over borrowed ResidentRuntime", () => {
  it("authenticates before parsing the body", async () => {
    const { host } = await setup();
    const response = await fetch(`${host.url}/v1/chat/completions`, {
      method: "POST",
      headers: headers(null),
      body: "not json",
    });
    expect(response.status).toBe(401);
    expect(await response.text()).toContain("AUTH_REQUIRED");
  });

  it("routes a plain text turn through host say() and reads the real root pair", async () => {
    const { engine, transport, binding, host } = await setup();
    transport.enqueue("host-reply");
    const response = await fetch(`${host.url}/v1/chat/completions`, {
      method: "POST",
      headers: headers(binding.token),
      body: JSON.stringify({
        model: "client-model",
        messages: [
          { role: "assistant", content: null },
          { role: "user", content: "hello" },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      model: string;
      choices: { message: { content: string } }[];
      mist: { stream_id: string };
    };
    expect(payload.choices[0]?.message.content).toBe("host-reply");
    expect(payload.model).toBe(binding.serverModel);
    const events = await engine.readCanonicalEvents(binding.bindingId);
    expect(events.map((event) => [event.kind, event.text])).toEqual([
      ["user", "hello"],
      ["assistant", "host-reply"],
    ]);
    expect(events.every((event) => event.residentId === binding.residentId)).toBe(true);
  });

  it("rejects utility and structural requests without calling the model", async () => {
    const { engine, binding, host } = await setup();
    const utility = await fetch(`${host.url}/v1/chat/completions`, {
      method: "POST",
      headers: headers(binding.token),
      body: JSON.stringify({
        model: "m",
        messages: [{ role: "user", content: "x" }],
        mist: { task_kind: "title" },
      }),
    });
    expect(utility.status).toBe(400);
    expect(await utility.text()).toContain("MIST_UTILITY_REQUEST_UNSUPPORTED");
    const structural = await fetch(`${host.url}/v1/chat/completions`, {
      method: "POST",
      headers: headers(binding.token),
      body: JSON.stringify({
        model: "m",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "x" },
              { type: "file", file: { filename: "a.txt", file_data: "aGVsbG8=" } },
            ],
          },
        ],
      }),
    });
    expect(structural.status).toBe(400);
    expect(await structural.text()).toContain("MIST_ATTACHMENT_UNSUPPORTED");
    expect(await engine.readCanonicalEvents(binding.bindingId)).toEqual([]);
  });

  it("records exactly one auth attempt per request, including parse failures", async () => {
    const { engine, binding, transport, host } = await setup();
    await fetch(`${host.url}/v1/chat/completions`, {
      method: "POST",
      headers: headers(null),
      body: "bad",
    });
    await fetch(`${host.url}/v1/chat/completions`, {
      method: "POST",
      headers: headers("wrong"),
      body: "bad",
    });
    await fetch(`${host.url}/v1/chat/completions`, {
      method: "POST",
      headers: headers(binding.token),
      body: "bad",
    });
    transport.enqueue("ok");
    const ok = await fetch(`${host.url}/v1/chat/completions`, {
      method: "POST",
      headers: headers(binding.token),
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(ok.status).toBe(200);
    const audit = await engine.readSecurityAudit();
    expect(audit.attempts).toBe(4);
    expect(audit.accepted).toBe(2);
    expect(audit.entries).toEqual([
      { source: "loopback", result: "rejected", code: "AUTH_REQUIRED" },
      { source: "loopback", result: "rejected", code: "AUTH_INVALID" },
      { source: "loopback", result: "accepted", code: "AUTH_ACCEPTED" },
      { source: "loopback", result: "accepted", code: "AUTH_ACCEPTED" },
    ]);
  });

  it("closing the frontend does not close the borrowed owner (owner can still say)", async () => {
    const { runtime, transport, binding, host } = await setup();
    transport.enqueue("after-close");
    await host.close();
    const result = await runtime.say({ residentId: binding.residentId, text: "still-here" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.reply).toBe("after-close");
  });
});
