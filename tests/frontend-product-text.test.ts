/**
 * D31-1 产品文字路径的具体复核修复测试：binding 不可变/重绑清旧 token、鉴权单次审计、
 * 跨 binding 观测各自正确、IPC 错误不回显上游 canary。
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  FrontendChatRequest,
  FrontendRequestContext,
} from "../acceptance/frontend-adapter-driver.ts";
import { createFrontendAdapterDriver } from "../src/frontend-adapter-acceptance-driver.ts";
import type { ResidentHostPort } from "../src/frontend/host-port.ts";
import { HostTextClient } from "../src/frontend/host-text-client.ts";
import { HostTextEngine } from "../src/frontend/host-text-engine.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "mist-fe-boundary-"));
  dirs.push(dir);
  return dir;
}

class StubPort implements ResidentHostPort {
  async requireActiveResident(referenceId: string) {
    return { ok: true, residentId: referenceId };
  }
  async say(input: { residentId: string; text: string }) {
    return { ok: true, reply: `r:${input.text}`, generation: 1, model: "m" };
  }
  async readStream() {
    return { ok: true, events: [] };
  }
  async bootPack() {
    return { ok: true, identity: "stub" };
  }
}

class FailingPort implements ResidentHostPort {
  async requireActiveResident() {
    return { ok: false, reason: "resident-not-found" };
  }
  async say() {
    return { ok: false, reason: "resident-not-found" };
  }
  async readStream() {
    return { ok: false, events: [] };
  }
  async bootPack() {
    return { ok: false };
  }
}

const BINDING = {
  bindingId: "binding:x",
  endpointId: "endpoint:x",
  residentId: "resident-x",
  scopeId: "private",
  streamId: "stream:resident-x",
  token: "token-1",
  serverModel: "mist:x",
  canonicalWriterId: "owner:resident-x",
};

const CONTEXT: FrontendRequestContext = {
  token: "token-1",
  source: "remote",
  conversationId: null,
};
function request(text: string): FrontendChatRequest {
  return {
    model: "client",
    stream: false,
    messages: [{ role: "user", content: text }],
    mist: { client: { surface: "t", capabilities: [] } },
  };
}

describe("#218 engine binding immutability and token rebind", () => {
  it("stores a private copy and never exposes internal references", async () => {
    const engine = new HostTextEngine(new StubPort());
    const returned = await engine.registerBinding(BINDING);
    (returned as { residentId: string }).residentId = "tampered";
    (returned as { token: string }).token = "tampered";
    const resolved = engine.resolveToken("token-1");
    expect(resolved?.residentId).toBe("resident-x");
    expect(resolved?.token).toBe("token-1");
    // resolveToken 返回克隆：改它不影响内部。
    (resolved as { residentId: string }).residentId = "tampered-2";
    expect(engine.resolveToken("token-1")?.residentId).toBe("resident-x");
  });

  it("drops the old token when the same binding is re-registered", async () => {
    const engine = new HostTextEngine(new StubPort());
    await engine.registerBinding(BINDING);
    await engine.registerBinding({ ...BINDING, token: "token-2" });
    expect(engine.resolveToken("token-2")).not.toBeNull();
    expect(engine.resolveToken("token-1")).toBeNull();
  });

  it("issues a single-use grant; forged or reused grants are rejected", async () => {
    const engine = new HostTextEngine(new StubPort());
    await engine.registerBinding(BINDING);
    expect(engine.readSecurityAudit()).toMatchObject({ attempts: 0 });
    const auth = engine.authenticate("binding:x", CONTEXT);
    expect(auth.ok).toBe(true);
    if (!auth.ok) throw new Error("no grant");
    const first = await engine.execute(auth.grant, request("a"));
    expect(first.response.status).toBe(200);
    const reuse = await engine.execute(auth.grant, request("b"));
    expect(reuse.response.status).toBe(401);
    const forged = await engine.execute({ bindingId: "binding:x" }, request("c"));
    expect(forged.response.status).toBe(401);
    const audit = engine.readSecurityAudit();
    expect(audit.attempts).toBe(1);
    expect(audit.entries).toEqual([
      { source: "remote", result: "accepted", code: "AUTH_ACCEPTED" },
    ]);
  });
});

describe("#218 driver cross-binding model observation", () => {
  it("correlates each binding's model turn by its own resident", async () => {
    const driver = createFrontendAdapterDriver();
    try {
      const a = await driver.provisionBinding({
        residentId: "resident:ca",
        scopeId: "scope:a",
        label: "ca",
      });
      const b = await driver.provisionBinding({
        residentId: "resident:cb",
        scopeId: "scope:b",
        label: "cb",
      });
      await driver.queueResidentReply(a.bindingId, { kind: "text", text: "reply-a" });
      await driver.queueResidentReply(b.bindingId, { kind: "text", text: "reply-b" });
      await Promise.all([
        driver.sendCompletion(
          a.bindingId,
          { token: a.token, source: "remote", conversationId: null },
          request("input-a"),
        ),
        driver.sendCompletion(
          b.bindingId,
          { token: b.token, source: "remote", conversationId: null },
          request("input-b"),
        ),
      ]);
      const turnsA = await driver.readModelTurns(a.bindingId);
      const turnsB = await driver.readModelTurns(b.bindingId);
      expect(turnsA.at(-1)?.currentText).toBe("input-a");
      expect(turnsB.at(-1)?.currentText).toBe("input-b");
    } finally {
      await driver.reset();
    }
  });
});

describe("#218 HostTextClient error boundary", () => {
  it("does not echo upstream IPC error text (canary) into public errors", async () => {
    const dir = temp();
    const bin = join(dir, "fake-host.js");
    writeFileSync(
      bin,
      `#!/usr/bin/env node
process.send({ type: "ready", pid: process.pid, bootId: "b" });
process.on("message", (m) => {
  process.send({ requestId: m.requestId, ok: false, error: { name: "X", message: "SYNTHETIC_PRIVATE_ERROR_CANARY" } });
});
`,
      "utf8",
    );
    chmodSync(bin, 0o755);
    const client = new HostTextClient({ dataDir: dir, hostPath: bin });
    await client.start();
    const error = await client.call("say", { residentId: "r", text: "x" }).then(
      () => null,
      (caught: unknown) => caught as Error,
    );
    expect(error).not.toBeNull();
    expect(error?.message).not.toContain("SYNTHETIC_PRIVATE_ERROR_CANARY");
    expect(error?.message).toBe("HOST_OP_FAILED");
    await client.stop();
  });
});

describe("#218 engine grant invalidation and host-derived binding", () => {
  const ctx = { token: "token-1", source: "remote" as const, conversationId: null };

  it("invalidates an old grant after the same binding is rebound", async () => {
    const engine = new HostTextEngine(new StubPort());
    await engine.registerBinding(BINDING);
    const auth = engine.authenticate("binding:x", ctx);
    if (!auth.ok) throw new Error("expected grant");
    await engine.registerBinding({ ...BINDING, residentId: "resident-y", token: "token-2" });
    const result = await engine.execute(auth.grant, {
      model: "m",
      stream: false,
      messages: [{ role: "user", content: "z" }],
      mist: { client: { surface: "t", capabilities: [] } },
    });
    expect(result.response.status).toBe(401);
  });

  it("invalidates an old grant after reset and same-id re-registration", async () => {
    const engine = new HostTextEngine(new StubPort());
    await engine.registerBinding(BINDING);
    const auth = engine.authenticate("binding:x", ctx);
    if (!auth.ok) throw new Error("expected grant");
    engine.reset();
    await engine.registerBinding({ ...BINDING, token: "token-3" });
    const result = await engine.execute(auth.grant, {
      model: "m",
      stream: false,
      messages: [{ role: "user", content: "z" }],
      mist: { client: { surface: "t", capabilities: [] } },
    });
    expect(result.response.status).toBe(401);
  });

  it("rejects the same token bound to two different bindings", async () => {
    const engine = new HostTextEngine(new StubPort());
    await engine.registerBinding(BINDING);
    await expect(engine.registerBinding({ ...BINDING, bindingId: "binding:y" })).rejects.toThrow(
      "MIST_BINDING_TOKEN_CONFLICT",
    );
  });

  it("uses the host scope, not the caller-provided scope", async () => {
    const engine = new HostTextEngine(new StubPort());
    const returned = await engine.registerBinding({ ...BINDING, scopeId: "client-invented-scope" });
    expect(returned.scopeId).toBe("private");
    expect(engine.resolveToken("token-1")?.scopeId).toBe("private");
  });

  it("fails closed without registering when the host does not resolve an active resident", async () => {
    const engine = new HostTextEngine(new FailingPort());
    await expect(engine.registerBinding(BINDING)).rejects.toThrow(
      "MIST_BINDING_RESIDENT_UNAVAILABLE",
    );
    expect(engine.resolveToken("token-1")).toBeNull();
  });
});
