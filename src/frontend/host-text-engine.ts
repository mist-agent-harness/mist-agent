/**
 * D31-1 产品文字 engine：文字成功回合经受限宿主端口 `say()`，写账由宿主唯一 writer
 * 完成。引擎不建 writer、不默认 generation、不编造身份；不提供 seed/queue/模型请求观测。
 *
 * 鉴权是唯一公开边界：`authenticate()` 每次恰好记一条 attempts/audit，返回不可伪造、
 * 绑定 binding、一次性的授权凭据；`execute()` 只认引擎自造凭据。HTTP 在解析前
 * authenticate，再 execute；`handle()` 走同一边界。
 *
 * binding 登记为**私有不可变拷贝**：token→host 已解析 active canonical resident 的稳定
 * 绑定；对外 resolveToken/anonymous 返回克隆，内外互不影响；重绑同 binding 清旧 token。
 */
import type {
  AdapterBinding,
  CanonicalEventReadback,
  FrontendChatRequest,
  FrontendCompletionBody,
  FrontendError,
  FrontendRequestContext,
  FrontendResponse,
  FrontendStreamChunk,
  RawWireExchange,
  SecurityAuditReadback,
  SurfaceProjection,
} from "../../acceptance/frontend-adapter-driver.ts";
import { PRIVATE_SCOPE } from "../session/session-registry.ts";
import type { ResidentHostPort } from "./host-port.ts";
import {
  errorEnvelope,
  serializeCompletion,
  serializeRequest,
  serializeSse,
} from "./openai-wire.ts";

export interface HostTextHandleResult {
  response: FrontendResponse;
  wire: RawWireExchange;
}

export type HostAuthOutcome = { ok: true; grant: object } | { ok: false; code: string };

export class HostTextEngineError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "HostTextEngineError";
    this.code = code;
  }
}

const NATIVE_PROJECTION: SurfaceProjection = {
  status: "native",
  missingCapabilities: [],
  canonicalEventIds: [],
};

function structuralRejection(
  request: FrontendChatRequest,
): { code: string; message: string } | null {
  if (request.mist?.interactionResponse !== undefined) {
    return {
      code: "MIST_INTERACTION_UNSUPPORTED",
      message: "本步只支持纯文字聊天；选项/交互响应尚未开放，请等待后续结构事件单。",
    };
  }
  const last = request.messages.at(-1);
  if (last !== undefined && Array.isArray(last.content)) {
    for (const part of last.content) {
      if (typeof part !== "object" || part === null) continue;
      const type = (part as { type?: unknown }).type;
      if (type === "file" || type === "image_url") {
        return {
          code: "MIST_ATTACHMENT_UNSUPPORTED",
          message:
            "本步只支持纯文字聊天；附件与远程 URL 尚未开放，请等待后续结构事件单，或先移除附件后重发。",
        };
      }
    }
  }
  return null;
}

interface RegisteredBinding {
  readonly binding: AdapterBinding;
  readonly token: string;
}

export class HostTextEngine {
  readonly #port: ResidentHostPort;
  readonly #bindings = new Map<string, RegisteredBinding>();
  readonly #tokens = new Map<string, string>();
  readonly #grants = new WeakMap<object, RegisteredBinding>();
  readonly #wire = new Map<string, RawWireExchange[]>();
  #security: SecurityAuditReadback = {
    attempts: 0,
    accepted: 0,
    entries: [],
    logs: [],
    receipts: [],
  };
  #sequence = 0;

  constructor(port: ResidentHostPort) {
    this.#port = port;
  }

  /** 登记一份宿主已解析的 binding（不创建 persona/自认/凭证）；返回私有拷贝。 */
  async registerBinding(input: AdapterBinding): Promise<AdapterBinding> {
    const active = await this.#port.requireActiveResident(input.residentId);
    if (!active.ok || active.residentId === undefined) {
      throw new HostTextEngineError("MIST_BINDING_RESIDENT_UNAVAILABLE");
    }
    const tokenOwner = this.#tokens.get(input.token);
    if (tokenOwner !== undefined && tokenOwner !== input.bindingId) {
      throw new HostTextEngineError("MIST_BINDING_TOKEN_CONFLICT");
    }
    const previous = this.#bindings.get(input.bindingId);
    if (previous !== undefined && previous.token !== input.token) {
      this.#tokens.delete(previous.token);
    }
    const binding: AdapterBinding = Object.freeze({
      ...input,
      residentId: active.residentId,
      // 宿主 scope 用现役 SessionRegistry 的 PRIVATE_SCOPE；不接调用者任意 scope。
      scopeId: PRIVATE_SCOPE,
    });
    this.#bindings.set(binding.bindingId, { binding, token: binding.token });
    this.#tokens.set(binding.token, binding.bindingId);
    if (!this.#wire.has(binding.bindingId)) this.#wire.set(binding.bindingId, []);
    return structuredClone(binding);
  }

  reset(): void {
    this.#bindings.clear();
    this.#tokens.clear();
    this.#wire.clear();
    this.#security = { attempts: 0, accepted: 0, entries: [], logs: [], receipts: [] };
    this.#sequence = 0;
  }

  resolveToken(token: string | null): AdapterBinding | null {
    if (token === null) return null;
    const bindingId = this.#tokens.get(token);
    if (bindingId === undefined) return null;
    const entry = this.#bindings.get(bindingId);
    return entry === undefined ? null : structuredClone(entry.binding);
  }

  /** 唯一鉴权边界：每次恰好一条 attempts/audit；成功才发一次性凭据。 */
  authenticate(bindingId: string | null, context: FrontendRequestContext): HostAuthOutcome {
    this.#security.attempts += 1;
    if (context.token === null) {
      this.#audit(context, "rejected", "AUTH_REQUIRED");
      return { ok: false, code: "AUTH_REQUIRED" };
    }
    const entry = bindingId !== null ? this.#bindings.get(bindingId) : undefined;
    if (bindingId === null || entry === undefined || entry.binding.token !== context.token) {
      this.#audit(context, "rejected", "AUTH_INVALID");
      return { ok: false, code: "AUTH_INVALID" };
    }
    this.#audit(context, "accepted", "AUTH_ACCEPTED");
    this.#security.accepted += 1;
    const grant = Object.freeze({});
    // 凭据绑定**当时的私有 entry**；entry 被替换/reset 后凭据即失效。
    this.#grants.set(grant, entry);
    return { ok: true, grant };
  }

  /** 只认引擎自造凭据，绑定从私有映射取；用过即焚，且不认已被替换/reset 的 entry。 */
  async execute(grant: unknown, request: FrontendChatRequest): Promise<HostTextHandleResult> {
    const entry = typeof grant === "object" && grant !== null ? this.#grants.get(grant) : undefined;
    if (entry === undefined) {
      return this.#detached(request, this.#error(401, "AUTH_REQUIRED"));
    }
    this.#grants.delete(grant as object);
    if (this.#bindings.get(entry.binding.bindingId) !== entry) {
      // 重绑（同 bindingId 换 token/resident）或 reset 后，旧授权立即失效。
      return this.#detached(request, this.#error(401, "AUTH_REQUIRED"));
    }
    return this.#runTurn(entry.binding, request);
  }

  async handle(
    bindingId: string,
    context: FrontendRequestContext,
    request: FrontendChatRequest,
  ): Promise<HostTextHandleResult> {
    const auth = this.authenticate(bindingId, context);
    if (!auth.ok) return this.#finish(bindingId, request, this.#error(401, auth.code));
    return this.execute(auth.grant, request);
  }

  async readCanonicalEvents(bindingId: string): Promise<CanonicalEventReadback[]> {
    const entry = this.#bindings.get(bindingId);
    if (entry === undefined) return [];
    const binding = entry.binding;
    const stream = await this.#port.readStream(binding.residentId);
    if (!stream.ok) return [];
    return stream.events.map((event) => ({
      eventId: event.eventId,
      residentId: binding.residentId,
      scopeId: binding.scopeId,
      streamId: binding.streamId,
      writerId: binding.canonicalWriterId,
      kind: event.kind,
      text: event.text,
      attachment: null,
      interaction: null,
      projection: null,
      resolvedOptionId: null,
    }));
  }

  readRawWire(bindingId: string): Promise<RawWireExchange[]> {
    return Promise.resolve(structuredClone(this.#wire.get(bindingId) ?? []));
  }

  readSecurityAudit(): SecurityAuditReadback {
    return structuredClone(this.#security);
  }

  async #runTurn(
    binding: AdapterBinding,
    request: FrontendChatRequest,
  ): Promise<HostTextHandleResult> {
    const bindingId = binding.bindingId;
    const taskKind = request.mist?.taskKind;
    if (typeof taskKind === "string" && taskKind.length > 0) {
      return this.#finish(bindingId, request, this.#error(400, "MIST_UTILITY_REQUEST_UNSUPPORTED"));
    }
    const structural = structuralRejection(request);
    if (structural !== null) {
      return this.#finish(
        bindingId,
        request,
        this.#error(400, structural.code, structural.message),
      );
    }
    const last = request.messages.at(-1);
    if (last === undefined || last.role !== "user" || typeof last.content !== "string") {
      return this.#finish(bindingId, request, this.#error(400, "MIST_INVALID_TURN_SHAPE"));
    }
    const turn = await this.#port.say({ residentId: binding.residentId, text: last.content });
    if (!turn.ok || turn.reply === undefined) {
      return this.#finish(bindingId, request, this.#error(500, "MIST_HOST_TURN_FAILED"));
    }
    const id = `chatcmpl_mist_${++this.#sequence}`;
    const body: FrontendCompletionBody = {
      id,
      model: binding.serverModel,
      streamId: binding.streamId,
      text: turn.reply,
      attachments: [],
      interaction: null,
      projection: NATIVE_PROJECTION,
    };
    const wireInput = {
      id,
      model: binding.serverModel,
      created: 1_700_000_000,
      streamId: binding.streamId,
      text: turn.reply,
      attachments: [],
      interaction: null,
      projection: NATIVE_PROJECTION,
    };
    const responseBody = request.stream ? serializeSse(wireInput) : serializeCompletion(wireInput);
    this.#wire.get(bindingId)?.push({
      requestBody: serializeRequest(request),
      responseBody,
      responseKind: request.stream ? "sse" : "json",
    });
    const chunks: FrontendStreamChunk[] = request.stream
      ? [
          {
            textDelta: turn.reply,
            attachments: [],
            interaction: null,
            projection: NATIVE_PROJECTION,
            done: false,
          },
          { textDelta: "", attachments: [], interaction: null, projection: null, done: true },
        ]
      : [];
    return {
      response: { status: 200, error: null, body, chunks },
      wire: {
        requestBody: serializeRequest(request),
        responseBody,
        responseKind: request.stream ? "sse" : "json",
      },
    };
  }

  #audit(context: FrontendRequestContext, result: "accepted" | "rejected", code: string): void {
    this.#security.entries.push({ source: context.source, result, code });
    this.#security.logs.push(code);
    this.#security.receipts.push(code);
  }

  #error(status: number, code: string, message?: string): FrontendResponse {
    const type: FrontendError["type"] = code.startsWith("AUTH")
      ? "mist_auth_error"
      : "mist_request_error";
    return {
      status,
      error: { code, type, message: message ?? code, param: null },
      body: null,
      chunks: [],
    };
  }

  #finish(
    bindingId: string,
    request: FrontendChatRequest,
    response: FrontendResponse,
  ): HostTextHandleResult {
    if (response.status === 200) {
      const wire = this.#wire.get(bindingId)?.at(-1) ?? {
        requestBody: serializeRequest(request),
        responseBody: "{}",
        responseKind: "json" as const,
      };
      return { response, wire };
    }
    const wire: RawWireExchange = {
      requestBody: serializeRequest(request),
      responseBody: JSON.stringify(
        errorEnvelope({
          code: response.error?.code ?? "UNKNOWN",
          type: response.error?.type ?? "mist_request_error",
          message: response.error?.message ?? "request failed",
        }),
      ),
      responseKind: "json",
    };
    this.#wire.get(bindingId)?.push(wire);
    return { response, wire };
  }

  #detached(request: FrontendChatRequest, response: FrontendResponse): HostTextHandleResult {
    return {
      response,
      wire: {
        requestBody: serializeRequest(request),
        responseBody: JSON.stringify(
          errorEnvelope({
            code: response.error?.code ?? "UNKNOWN",
            type: response.error?.type ?? "mist_request_error",
            message: response.error?.message ?? "request failed",
          }),
        ),
        responseKind: "json",
      },
    };
  }
}
