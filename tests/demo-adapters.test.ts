import { afterEach, describe, expect, it, vi } from "vitest";
import { anthropicMessagesAdapter } from "../demo/adapters/anthropic.ts";
import { openAiChatCompletionsAdapter } from "../demo/adapters/openai.ts";
import {
  type DemoDriver,
  type DemoRuntime,
  type DemoServer,
  createDemoServer,
} from "../demo/server.ts";

const servers: DemoServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

async function start(reply = "Mist says hello") {
  const say = vi.fn(async (_residentId: string, message: string) => ({
    content: `${reply}:${message}`,
  }));
  const driver: DemoDriver = { say, killSession: vi.fn(async () => undefined) };
  const runtime: DemoRuntime = {
    current: () => ({ driver, residentId: "resident-demo" }),
    reset: vi.fn(async () => undefined),
  };
  const server = createDemoServer({
    runtime,
    adapters: [openAiChatCompletionsAdapter, anthropicMessagesAdapter],
  });
  servers.push(server);
  const address = await server.start(0);
  return { say, baseUrl: `http://${address.address}:${address.port}` };
}

function eventNames(body: string): string[] {
  return body
    .split("\n")
    .filter((line) => line.startsWith("event: "))
    .map((line) => line.slice("event: ".length));
}

describe("demo provider adapters", () => {
  it("serves OpenAI Chat Completions SSE and sends only the latest user text to Mist", async () => {
    const { say, baseUrl } = await start();
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mist-openai-canary",
        stream: true,
        messages: [
          { role: "user", content: "old shell history" },
          { role: "assistant", content: null, tool_calls: [{ id: "old-tool" }] },
          { role: "tool", content: { ignored: true } },
          {
            role: "user",
            content: [{ type: "text", text: "latest OpenAI turn  " }],
          },
          {
            role: "user",
            content: "<system-reminder>\nKimi internal instruction\n</system-reminder>",
          },
        ],
      }),
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(body).toContain('"model":"mist-openai-canary"');
    expect(body).toContain('"content":"Mist says hello:latest OpenAI turn  "');
    expect(body).toContain('"finish_reason":"stop"');
    expect(body).toMatch(/data: \[DONE\]\n\n$/);
    expect(say).toHaveBeenCalledOnce();
    expect(say).toHaveBeenCalledWith("resident-demo", "latest OpenAI turn  ");
  });

  it("serves Anthropic Messages SSE through message_stop without an OpenAI sentinel", async () => {
    const { say, baseUrl } = await start();
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "x-api-key": "local-demo-placeholder",
      },
      body: JSON.stringify({
        model: "mist-anthropic-canary",
        stream: true,
        max_tokens: 256,
        messages: [
          { role: "user", content: "old shell history" },
          {
            role: "user",
            content: [
              { type: "text", text: "latest Anthropic turn" },
              {
                type: "text",
                text: "<system-reminder>internal Anthropic instruction</system-reminder>",
              },
            ],
          },
        ],
      }),
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(eventNames(body)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(body).toContain('"model":"mist-anthropic-canary"');
    expect(body).toContain('"text":"Mist says hello:latest Anthropic turn"');
    expect(body).not.toContain("[DONE]");
    expect(body).toMatch(/event: message_stop\ndata: \{"type":"message_stop"\}\n\n$/);
    expect(say).toHaveBeenCalledOnce();
    expect(say).toHaveBeenCalledWith("resident-demo", "latest Anthropic turn");
  });

  it("returns provider-native JSON when streaming is disabled", async () => {
    const { baseUrl } = await start("reply");
    const openAi = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({
        model: "openai-json",
        messages: [{ role: "user", content: "one" }],
      }),
    });
    const anthropic = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      body: JSON.stringify({
        model: "anthropic-json",
        stream: false,
        messages: [{ role: "user", content: "two" }],
      }),
    });

    expect(await openAi.json()).toMatchObject({
      object: "chat.completion",
      model: "openai-json",
      choices: [{ message: { role: "assistant", content: "reply:one" } }],
    });
    expect(await anthropic.json()).toMatchObject({
      type: "message",
      model: "anthropic-json",
      content: [{ type: "text", text: "reply:two" }],
      stop_reason: "end_turn",
    });
  });

  it("rejects malformed provider envelopes before calling Mist", async () => {
    const { say, baseUrl } = await start();
    const badStream = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({
        stream: "yes",
        messages: [{ role: "user", content: "must not run" }],
      }),
    });
    const badMessages = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      body: JSON.stringify({ messages: "not-an-array" }),
    });
    const reminderOnly = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({
        messages: [
          {
            role: "user",
            content: "<system-reminder>internal only</system-reminder>",
          },
        ],
      }),
    });

    expect(badStream.status).toBe(400);
    expect(badMessages.status).toBe(400);
    expect(reminderOnly.status).toBe(400);
    expect(say).not.toHaveBeenCalled();
  });
});
