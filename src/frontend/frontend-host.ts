/**
 * #218/D31 生产入口：把受限 loopback listener 接到同一回合引擎。
 *
 * - 鉴权先于消息解析：HTTP 先解析 Bearer/绑定并让引擎 `authenticate()` 记**唯一一次**鉴权
 *   尝试并发授权凭据，再 `JSON.parse`；缺/错 token 直接 401，不解析 messages/附件。
 * - 只验证并消费最后一条 current user；前缀 history 一律丢弃，不进模型/日志/错误。
 * - 显式 utility task hint（`mist.task_kind`）先分类拒绝，晚于鉴权、早于消息校验与附件。
 * - 控制扩展（`mist.interaction_response`）形状错误返回 `MIST_INTERACTION_RESPONSE_INVALID`，
 *   不被当成普通聊天。
 */
import type {
  ClientCapability,
  FrontendChatRequest,
  FrontendContentPart,
  FrontendMessage,
  FrontendRole,
  RequestSource,
} from "../../acceptance/frontend-adapter-driver.ts";
import type { HostTextEngine } from "./host-text-engine.ts";
import { type FrontendListenerOptions, startFrontendListener } from "./openai-listener.ts";

export interface FrontendHostOptions extends FrontendListenerOptions {
  engine: HostTextEngine;
  source?: RequestSource;
}

export interface FrontendHost {
  readonly url: string;
  close(): Promise<void>;
}

export type RequestConversion = { request: FrontendChatRequest } | { errorCode: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ROLES: readonly FrontendRole[] = ["system", "developer", "user", "assistant", "tool"];

function toMessage(value: unknown): FrontendMessage | null {
  if (!isRecord(value)) return null;
  if (typeof value.role !== "string" || !ROLES.includes(value.role as FrontendRole)) return null;
  const content = value.content;
  if (typeof content !== "string" && !Array.isArray(content)) return null;
  const message: FrontendMessage = {
    role: value.role as FrontendRole,
    content: content as string | FrontendContentPart[],
  };
  if (typeof value.name === "string") message.name = value.name;
  if (typeof value.tool_call_id === "string") message.tool_call_id = value.tool_call_id;
  return message;
}

function clientOf(mist: Record<string, unknown>): {
  surface: string;
  capabilities: ClientCapability[];
} {
  const client = isRecord(mist.client) ? mist.client : null;
  if (client === null) return { surface: "generic", capabilities: [] };
  return {
    surface: typeof client.surface === "string" ? client.surface : "generic",
    capabilities: Array.isArray(client.capabilities)
      ? client.capabilities.filter(
          (capability): capability is ClientCapability =>
            capability === "attachments" || capability === "interactions",
        )
      : [],
  };
}

/** 线协议 snake_case → 归一化请求。只验证最后一条 current user；前缀丢弃。 */
export function toFrontendChatRequest(value: unknown): RequestConversion {
  if (!isRecord(value)) return { errorCode: "MIST_INVALID_TURN_SHAPE" };
  if (typeof value.model !== "string") return { errorCode: "MIST_INVALID_TURN_SHAPE" };
  const stream = value.stream === undefined ? false : value.stream;
  if (typeof stream !== "boolean") return { errorCode: "MIST_INVALID_TURN_SHAPE" };
  const mist = isRecord(value.mist) ? value.mist : {};
  const client = clientOf(mist);
  const taskKind =
    typeof mist.task_kind === "string"
      ? mist.task_kind
      : typeof mist.taskKind === "string"
        ? mist.taskKind
        : undefined;

  // 显式 utility 先分类：不做消息/附件校验，直接交给引擎拒绝。
  if (taskKind !== undefined && taskKind.length > 0) {
    const request: FrontendChatRequest = {
      model: value.model,
      stream,
      messages: [],
      mist: { client, taskKind },
    };
    return { request };
  }

  if ("interaction_response" in mist || "interactionResponse" in mist) {
    const raw = isRecord(mist.interaction_response)
      ? mist.interaction_response
      : isRecord(mist.interactionResponse)
        ? mist.interactionResponse
        : null;
    if (raw === null) return { errorCode: "MIST_INTERACTION_RESPONSE_INVALID" };
    const interactionId = raw.interaction_id ?? raw.interactionId;
    const optionId = raw.option_id ?? raw.optionId;
    if (typeof interactionId !== "string" || typeof optionId !== "string") {
      return { errorCode: "MIST_INTERACTION_RESPONSE_INVALID" };
    }
    return {
      request: {
        model: value.model,
        stream,
        messages: [],
        mist: { client, interactionResponse: { interactionId, optionId } },
      },
    };
  }

  if (!Array.isArray(value.messages)) return { errorCode: "MIST_INVALID_TURN_SHAPE" };
  const messages: FrontendMessage[] = [];
  if (value.messages.length > 0) {
    const last = toMessage(value.messages.at(-1));
    if (last === null) return { errorCode: "MIST_INVALID_TURN_SHAPE" };
    messages.push(last);
  }
  return { request: { model: value.model, stream, messages, mist: { client } } };
}

export async function startFrontendHost(options: FrontendHostOptions): Promise<FrontendHost> {
  const source = options.source ?? "loopback";
  const { engine, ...listenerOptions } = options;
  const listener = await startFrontendListener(
    async (httpRequest) => {
      const authorization = httpRequest.headers.authorization;
      const token =
        typeof authorization === "string" && authorization.startsWith("Bearer ")
          ? authorization.slice("Bearer ".length)
          : null;
      const binding = engine.resolveToken(token);
      const context = { token, source, conversationId: null };
      // 唯一鉴权边界先于 JSON/消息/结构解析；每次恰好一条 audit。
      const auth = engine.authenticate(binding?.bindingId ?? null, context);
      if (!auth.ok) {
        return {
          status: 401,
          body: JSON.stringify({
            error: { type: "mist_auth_error", code: auth.code, message: auth.code, param: null },
          }),
          sse: false,
        };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(httpRequest.body);
      } catch {
        return badRequest("MIST_INVALID_TURN_SHAPE");
      }
      const conversion = toFrontendChatRequest(parsed);
      if ("errorCode" in conversion) return badRequest(conversion.errorCode);
      const { response, wire } = await engine.execute(auth.grant, conversion.request);
      return { status: response.status, body: wire.responseBody, sse: wire.responseKind === "sse" };
    },
    { ...listenerOptions, maxBodyBytes: listenerOptions.maxBodyBytes ?? 8 * 1024 * 1024 },
  );
  return { url: listener.url, close: () => listener.close() };
}

function badRequest(code: string): { status: number; body: string; sse: boolean } {
  return {
    status: 400,
    body: JSON.stringify({
      error: { type: "mist_request_error", code, message: code, param: null },
    }),
    sse: false,
  };
}
