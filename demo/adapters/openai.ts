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

function completionBase(model: string) {
  return {
    id: `chatcmpl-${randomUUID()}`,
    created: Math.floor(Date.now() / 1000),
    model,
  };
}

export const openAiChatCompletionsAdapter: DemoChatAdapter = {
  matches: ({ method, url }) =>
    method === "POST" && new URL(url, "http://127.0.0.1").pathname === "/v1/chat/completions",
  parseRequest(body) {
    const envelope = recordOf(body);
    return {
      messages: parseMessages(envelope.messages),
      context: parseContext(envelope),
    };
  },
  formatReply(assistantContent, parsed) {
    const { model, stream } = adapterContext(parsed.context);
    const base = completionBase(model);
    if (!stream) {
      return jsonResponse({
        ...base,
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: assistantContent },
            finish_reason: "stop",
          },
        ],
      });
    }

    const content = JSON.stringify({
      ...base,
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: assistantContent },
          finish_reason: null,
        },
      ],
    });
    const finished = JSON.stringify({
      ...base,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    });
    return sseResponse([`data: ${content}`, `data: ${finished}`, "data: [DONE]"]);
  },
};
