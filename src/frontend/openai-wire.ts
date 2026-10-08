/**
 * #218/D31 OpenAI Chat Completions 线协议序列化。判卷独立解析真实 wire，
 * 所以这里只产标准 JSON / SSE 字节，不做任何私有形状。
 */
import type {
  FrontendChatRequest,
  StructuredAttachment,
  StructuredInteraction,
  SurfaceProjection,
} from "../../acceptance/frontend-adapter-driver.ts";

export interface CompletionWireInput {
  id: string;
  model: string;
  created: number;
  streamId: string;
  text: string;
  attachments: StructuredAttachment[];
  interaction: StructuredInteraction | null;
  projection: SurfaceProjection;
}

export function wireAttachment(value: StructuredAttachment): Record<string, unknown> {
  return {
    attachment_id: value.attachmentId,
    kind: value.kind,
    filename: value.filename,
    media_type: value.mediaType,
    size_bytes: value.sizeBytes,
    source: value.source,
  };
}

export function wireInteraction(
  value: StructuredInteraction | null,
): Record<string, unknown> | null {
  if (value === null) return null;
  return {
    interaction_id: value.interactionId,
    kind: value.kind,
    prompt: value.prompt,
    blocking: value.blocking,
    options: value.options.map((option) => ({
      option_id: option.optionId,
      label: option.label,
      description: option.description,
    })),
    reason_code: value.reasonCode,
  };
}

export function wireProjection(value: SurfaceProjection): Record<string, unknown> {
  return {
    status: value.status,
    missing_capabilities: value.missingCapabilities,
    canonical_event_ids: value.canonicalEventIds,
  };
}

function mistExtension(input: CompletionWireInput): Record<string, unknown> {
  return {
    stream_id: input.streamId,
    attachments: input.attachments.map(wireAttachment),
    interaction: wireInteraction(input.interaction),
    projection: wireProjection(input.projection),
  };
}

/** 非流式标准 completion envelope。 */
export function serializeCompletion(input: CompletionWireInput): string {
  return JSON.stringify({
    id: input.id,
    object: "chat.completion",
    created: input.created,
    model: input.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: input.text },
        finish_reason: "stop",
      },
    ],
    mist: mistExtension(input),
  });
}

/**
 * SSE：恰好一帧携带完整 `mist` 扩展且是末帧（finish_reason: "stop"），
 * 之后恰好一个 `data: [DONE]`。空行分帧，判卷逐帧核。
 */
export function serializeSse(input: CompletionWireInput): string {
  const contentFrame = {
    id: input.id,
    object: "chat.completion.chunk",
    created: input.created,
    model: input.model,
    choices: [{ index: 0, delta: { role: "assistant", content: input.text }, finish_reason: null }],
  };
  const terminalFrame = {
    id: input.id,
    object: "chat.completion.chunk",
    created: input.created,
    model: input.model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    mist: mistExtension(input),
  };
  return `data: ${JSON.stringify(contentFrame)}\n\ndata: ${JSON.stringify(terminalFrame)}\n\ndata: [DONE]\n\n`;
}

/**
 * 请求体原文（判卷独立解析）。`mist.interaction_response` 用线协议 snake_case；
 * 不复制 `Authorization` / token。前缀 history 原样保留在请求里（是否被采纳由服务端决定）。
 */
export function serializeRequest(request: FrontendChatRequest): string {
  const response = request.mist?.interactionResponse;
  return JSON.stringify({
    model: request.model,
    stream: request.stream,
    messages: request.messages,
    mist: {
      client: request.mist?.client ?? null,
      ...(response === undefined
        ? {}
        : {
            interaction_response: {
              interaction_id: response.interactionId,
              option_id: response.optionId,
            },
          }),
      task_kind: request.mist?.taskKind ?? null,
    },
  });
}

export function errorEnvelope(input: {
  code: string;
  type: string;
  message: string;
}): Record<string, unknown> {
  return {
    error: {
      type: input.type,
      code: input.code,
      message: input.message,
      param: null,
    },
  };
}
