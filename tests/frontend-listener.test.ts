import { afterEach, describe, expect, it } from "vitest";
import { type FrontendListener, startFrontendListener } from "../src/frontend/openai-listener.ts";

const listeners: FrontendListener[] = [];
afterEach(async () => {
  for (const listener of listeners.splice(0)) await listener.close();
});

const okHandler = async () => ({ status: 200, body: '{"ok":true}', sse: false });

describe("#218 bounded loopback listener", () => {
  it("binds loopback by default and refuses an explicit non-loopback bind", async () => {
    const listener = await startFrontendListener(okHandler);
    listeners.push(listener);
    expect(listener.bindAddress).toBe("127.0.0.1");
    expect(listener.url.startsWith("http://127.0.0.1:")).toBe(true);
    await expect(startFrontendListener(okHandler, { bindAddress: "0.0.0.0" })).rejects.toThrow(
      /non-loopback/,
    );
  });

  it("rejects an oversized request body with 413", async () => {
    const listener = await startFrontendListener(okHandler, { maxBodyBytes: 16 });
    listeners.push(listener);
    const response = await fetch(`${listener.url}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "x", messages: [], padding: "y".repeat(128) }),
    });
    expect(response.status).toBe(413);
  });

  it("rejects a request above the concurrency limit with 429", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const listener = await startFrontendListener(
      async () => {
        await gate;
        return { status: 200, body: "{}", sse: false };
      },
      { maxConcurrentRequests: 1 },
    );
    listeners.push(listener);
    const first = fetch(`${listener.url}/v1/chat/completions`, { method: "POST", body: "{}" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = await fetch(`${listener.url}/v1/chat/completions`, {
      method: "POST",
      body: "{}",
    });
    expect(second.status).toBe(429);
    release();
    expect((await first).status).toBe(200);
  });

  it("never emits a wildcard CORS header and only echoes allowlisted origins", async () => {
    const listener = await startFrontendListener(okHandler);
    listeners.push(listener);
    const denied = await fetch(`${listener.url}/v1/chat/completions`, {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example" },
    });
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();

    const allowlisted = await startFrontendListener(okHandler, {
      allowedOrigins: ["https://good.example"],
    });
    listeners.push(allowlisted);
    const allowed = await fetch(`${allowlisted.url}/v1/chat/completions`, {
      method: "OPTIONS",
      headers: { Origin: "https://good.example" },
    });
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://good.example");
    expect(allowed.headers.get("access-control-allow-origin")).not.toBe("*");
  });
});
