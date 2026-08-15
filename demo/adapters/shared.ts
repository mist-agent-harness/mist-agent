import type { DemoMessage } from "../server.ts";

export interface AdapterContext {
  model: string;
  stream: boolean;
}

export function recordOf(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("expected an object");
  }
  return value as Record<string, unknown>;
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";

  return value
    .map((part) => {
      const block = recordOf(part);
      if (block.type !== "text" || typeof block.text !== "string") return "";
      return block.text;
    })
    .join("");
}

export function parseMessages(value: unknown): DemoMessage[] {
  if (!Array.isArray(value)) throw new TypeError("messages must be an array");
  return value.map((item) => {
    const message = recordOf(item);
    if (typeof message.role !== "string") throw new TypeError("message role is required");
    return { role: message.role, content: textContent(message.content) };
  });
}

export function parseContext(body: Record<string, unknown>): AdapterContext {
  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    throw new TypeError("stream must be a boolean");
  }
  return {
    model: typeof body.model === "string" && body.model.length > 0 ? body.model : "mist-demo",
    stream: body.stream === true,
  };
}

export function adapterContext(value: unknown): AdapterContext {
  const context = recordOf(value);
  if (typeof context.model !== "string" || typeof context.stream !== "boolean") {
    throw new TypeError("invalid adapter context");
  }
  return { model: context.model, stream: context.stream };
}

export function jsonResponse(body: Record<string, unknown>) {
  return {
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  };
}

export function sseResponse(events: readonly string[]) {
  return {
    headers: {
      "cache-control": "no-cache",
      "content-type": "text/event-stream; charset=utf-8",
    },
    body: `${events.join("\n\n")}\n\n`,
  };
}
