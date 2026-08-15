import { randomUUID } from "node:crypto";
import type { DemoChatAdapter } from "../server.ts";
import {
  adapterContext,
  jsonResponse,
  parseContext,
  parseMessages,
  recordOf,
  sseResponse,
} from "./shared.ts";

function event(name: string, data: Record<string, unknown>): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}`;
}

export const anthropicMessagesAdapter: DemoChatAdapter = {
  matches: ({ method, url }) =>
    method === "POST" && new URL(url, "http://127.0.0.1").pathname === "/v1/messages",
  parseRequest(body) {
    const envelope = recordOf(body);
    return {
      messages: parseMessages(envelope.messages),
      context: parseContext(envelope),
    };
  },
  formatReply(assistantContent, parsed) {
    const { model, stream } = adapterContext(parsed.context);
    const id = `msg_${randomUUID()}`;
    if (!stream) {
      return jsonResponse({
        id,
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "text", text: assistantContent }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      });
    }

    return sseResponse([
      event("message_start", {
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
      event("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      event("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: assistantContent },
      }),
      event("content_block_stop", { type: "content_block_stop", index: 0 }),
      event("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 0 },
      }),
      event("message_stop", { type: "message_stop" }),
    ]);
  },
};
