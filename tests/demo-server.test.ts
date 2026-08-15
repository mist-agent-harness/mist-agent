import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type DemoChatAdapter,
  type DemoDriver,
  type DemoMessage,
  type DemoRuntime,
  type DemoServer,
  createDemoServer,
} from "../demo/server.ts";
import { createDriver } from "../src/acceptance-driver.ts";

const adapter: DemoChatAdapter = {
  matches: ({ method, url }) => method === "POST" && url === "/wire/chat",
  parseRequest: (body) => ({
    messages: (body as { messages: DemoMessage[] }).messages,
    context: null,
  }),
  formatReply: (content) => ({
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  }),
};

const servers: DemoServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

async function start(runtime: DemoRuntime, options: { maxBodyBytes?: number } = {}) {
  const server = createDemoServer({ runtime, adapters: [adapter], ...options });
  servers.push(server);
  const address = await server.start(0);
  return { server, baseUrl: `http://${address.address}:${address.port}` };
}

describe("demo server core", () => {
  it("only passes the latest user message to Mist", async () => {
    const say = vi.fn(async (_residentId: string, message: string) => ({
      content: `reply:${message}`,
    }));
    const driver: DemoDriver = { say, killSession: vi.fn(async () => undefined) };
    const runtime: DemoRuntime = {
      current: () => ({ driver, residentId: "resident-demo" }),
      reset: vi.fn(async () => undefined),
    };
    const { baseUrl } = await start(runtime);

    const response = await fetch(`${baseUrl}/wire/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [
          { role: "user", content: "shell replay must be ignored" },
          { role: "assistant", content: "old reply" },
          { role: "user", content: "latest stays byte-for-byte  " },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ content: "reply:latest stays byte-for-byte  " });
    expect(say).toHaveBeenCalledOnce();
    expect(say).toHaveBeenCalledWith("resident-demo", "latest stays byte-for-byte  ");
  });

  it("clear uses the real driver's killSession and the next turn starts a new root", async () => {
    const driver = createDriver();
    const residentId = await driver.createResident("demo resident");
    const runtime: DemoRuntime = {
      current: () => ({ driver, residentId }),
      reset: vi.fn(async () => undefined),
    };
    const { baseUrl } = await start(runtime);

    for (const content of ["before clear one", "before clear two"]) {
      expect(
        await fetch(`${baseUrl}/wire/chat`, {
          method: "POST",
          body: JSON.stringify({ messages: [{ role: "user", content }] }),
        }),
      ).toHaveProperty("status", 200);
    }

    const clearResponse = await fetch(`${baseUrl}/demo/clear`, { method: "POST" });
    expect(clearResponse.status).toBe(204);
    await fetch(`${baseUrl}/wire/chat`, {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "after clear" }] }),
    });

    const afterClear = (await driver.history(residentId)).find(
      (node) => node.role === "user" && node.content === "after clear",
    );
    expect(afterClear?.parentId).toBeNull();
  });

  it("reset is serialized and subsequent chat uses the reseeded resident", async () => {
    const calls: string[] = [];
    const driver: DemoDriver = {
      say: vi.fn(async (residentId, message) => {
        calls.push(`${residentId}:${message}`);
        return { content: "ok" };
      }),
      killSession: vi.fn(async () => undefined),
    };
    let residentId = "resident-old";
    const runtime: DemoRuntime = {
      current: () => ({ driver, residentId }),
      reset: vi.fn(async () => {
        residentId = "resident-reseeded";
      }),
    };
    const { baseUrl } = await start(runtime);

    const resetResponse = await fetch(`${baseUrl}/demo/reset`, { method: "POST" });
    expect(resetResponse.status).toBe(204);
    await fetch(`${baseUrl}/wire/chat`, {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    });

    expect(runtime.reset).toHaveBeenCalledOnce();
    expect(calls).toEqual(["resident-reseeded:hello"]);
  });

  it("binds only to IPv4 loopback", async () => {
    const driver: DemoDriver = {
      say: vi.fn(async () => ({ content: "ok" })),
      killSession: vi.fn(async () => undefined),
    };
    const { server } = await start({
      current: () => ({ driver, residentId: "resident-demo" }),
      reset: vi.fn(async () => undefined),
    });

    expect(server.address()?.address).toBe("127.0.0.1");
  });

  it("rejects missing user content, malformed JSON, and oversized bodies before say", async () => {
    const say = vi.fn(async () => ({ content: "must not run" }));
    const driver: DemoDriver = { say, killSession: vi.fn(async () => undefined) };
    const { baseUrl } = await start(
      {
        current: () => ({ driver, residentId: "resident-demo" }),
        reset: vi.fn(async () => undefined),
      },
      { maxBodyBytes: 128 },
    );

    const noUser = await fetch(`${baseUrl}/wire/chat`, {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "assistant", content: "only assistant" }] }),
    });
    const malformed = await fetch(`${baseUrl}/wire/chat`, { method: "POST", body: "{" });
    const oversized = await fetch(`${baseUrl}/wire/chat`, {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "x".repeat(256) }] }),
    });

    expect(noUser.status).toBe(400);
    expect(malformed.status).toBe(400);
    expect(oversized.status).toBe(413);
    expect(say).not.toHaveBeenCalled();
  });

  it("keeps management methods narrow and returns 404 for unknown routes", async () => {
    const driver: DemoDriver = {
      say: vi.fn(async () => ({ content: "ok" })),
      killSession: vi.fn(async () => undefined),
    };
    const { baseUrl } = await start({
      current: () => ({ driver, residentId: "resident-demo" }),
      reset: vi.fn(async () => undefined),
    });

    const clearGet = await fetch(`${baseUrl}/demo/clear`);
    const resetGet = await fetch(`${baseUrl}/demo/reset`);
    const unknown = await fetch(`${baseUrl}/unknown`);

    expect(clearGet.status).toBe(405);
    expect(clearGet.headers.get("allow")).toBe("POST");
    expect(resetGet.status).toBe(405);
    expect(unknown.status).toBe(404);
  });
});
