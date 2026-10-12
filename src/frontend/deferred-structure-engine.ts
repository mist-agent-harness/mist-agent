/**
 * #218 / D31 OpenAI-compatible 前端适配层的生产引擎。
 *
 * 权威边界（图纸 §1）：一份 adapter binding 固定绑定
 *
 *   Bearer token → residentId → scopeId → canonical streamId → server-owned model route
 *
 * 生产路径要求：
 *   - 所有可执行 turn 的公开入口都需真认证：`authenticate()` 是唯一鉴权边界（每次恰好记
 *     一次 attempts/audit），返回**不可伪造、绑定 binding、一次性**的授权凭据；
 *     `execute()` 只认引擎自造的凭据。没有未鉴权执行路径，也不把字符串当真值许可。
 *   - canonical 用住户真实 ID；writer 可借用宿主（不新开第二个写方、不 close owner）。
 *   - 模型必须经 `FrontendModelPort`；没有 port 显式失败（503）。附件字节只经私有 port
 *     流转：入站给本回合受限读取句柄；出站由宿主真签（暂存→回合成功才落），伪造 ref 拒。
 *
 * `/webui`（FE-07）不在此文件。
 */
import { randomUUID } from "node:crypto";
import type {
  AdapterBinding,
  AttachmentWriteReadback,
  CanonicalEventReadback,
  ClientCapability,
  FrontendChatRequest,
  FrontendCompletionBody,
  FrontendRequestContext,
  FrontendResponse,
  FrontendStreamChunk,
  InteractionReadback,
  ModelTurnReadback,
  NetworkAttemptReadback,
  NetworkAttemptRecord,
  RawWireExchange,
  ResidentReply,
  SecurityAuditReadback,
  StructuredAttachment,
  StructuredInteraction,
  SurfaceProjection,
} from "../../acceptance/frontend-adapter-driver.ts";
import { CanonicalStreamStore } from "../one-stream/index.ts";
import type { CanonicalStreamWriter } from "../one-stream/index.ts";
import { openCanonicalStreamWriter } from "../window-host/window-history-host.ts";
import {
  type AttachmentOwner,
  type AttachmentReadHandle,
  AttachmentVault,
  type OutboundAttachmentInput,
  type PreparedAttachment,
  imageContentMatches,
} from "./attachment-vault.ts";
import { type CanonicalIdentity, CanonicalJournal } from "./canonical-journal.ts";
import {
  errorEnvelope,
  serializeCompletion,
  serializeRequest,
  serializeSse,
} from "./openai-wire.ts";

/** 受限附件端口：只在私有面内读取本回合入站字节与合法同户既有引用；出站真签。 */
export interface FrontendAttachmentPort {
  incoming(): AttachmentReadHandle[];
  open(refId: string): AttachmentReadHandle | null;
  prepareOutbound(input: OutboundAttachmentInput): StructuredAttachment;
  reuseOutbound(refId: string, input: OutboundAttachmentInput): StructuredAttachment;
}

export interface FrontendModelTurn {
  bindingId: string;
  residentId: string;
  scopeId: string;
  streamId: string;
  generation: number;
  canonicalHistoryText: string[];
  history: Array<{ role: "user" | "assistant"; text: string }>;
  currentText: string;
  attachments: StructuredAttachment[];
  surfaceCapabilities: ClientCapability[];
  attachmentPort: FrontendAttachmentPort;
}

export interface FrontendModelPort {
  complete(turn: FrontendModelTurn): Promise<ResidentReply>;
}

export interface DeferredStructureEngineOptions {
  modelPort: FrontendModelPort | null;
  streamStore?: CanonicalStreamStore;
  writer?: CanonicalStreamWriter;
  storeFactory?: () => CanonicalStreamStore;
  resolveGeneration?: (residentId: string) => number;
  maxAttachmentBytes?: number;
  /** 宿主出站附件 ID 生成器；生产默认随机 opaque（验收 driver 可注入固定 ID）。 */
  newOutboundAttachmentId?: (owner: AttachmentOwner) => string;
  /**
   * D31-1：默认只交文字聊天，带真实附件/选项控制的请求在调用宿主与写附件前拒绝。
   * 只有分支下层测试显式 `textOnly: false` 才启用附件/选项能力（不作为生产开关）。
   */
  textOnly?: boolean;
}

export interface FrontendHandleResult {
  response: FrontendResponse;
  wire: RawWireExchange;
}

interface StoredInteraction extends InteractionReadback {
  bindingId: string;
  generation: number;
}

interface Session {
  binding: AdapterBinding;
  interactions: Map<string, StoredInteraction>;
  turns: ModelTurnReadback[];
  wire: RawWireExchange[];
}

/**
 * 不可伪造的授权凭据：只是引擎私有 WeakMap 的键对象；**不携带**可被外部改写的
 * binding 字段。授权绑定只从引擎私有映射里取，外部字段篡改/克隆都无效。
 */
interface AuthorizationGrant {
  readonly brand: "mist-frontend-grant";
}

export type AuthOutcome = { ok: true; grant: AuthorizationGrant } | { ok: false; code: string };

interface TurnAttachmentState {
  active: boolean;
  issued: Map<string, { attachment: StructuredAttachment; staged: boolean }>;
  stagedIds: string[];
}

type ParseOutcome =
  | { ok: true; text: string; attachments: PreparedAttachment[]; remoteUrls: string[] }
  | { ok: false; code: string };

const DEFAULT_MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;

function freshSecurity(): SecurityAuditReadback {
  return { attempts: 0, accepted: 0, entries: [], logs: [], receipts: [] };
}

function ownerOf(binding: AdapterBinding): AttachmentOwner {
  return {
    bindingId: binding.bindingId,
    residentId: binding.residentId,
    scopeId: binding.scopeId,
    streamId: binding.streamId,
    writerId: binding.canonicalWriterId,
  };
}

function mediaTypeForFilename(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".txt") || lower.endsWith(".md")) return "text/plain";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".pdf")) return "application/pdf";
  return "application/octet-stream";
}

function decodeBase64Strict(data: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) return null;
  const bytes = Buffer.from(data, "base64");
  return bytes.toString("base64") === data ? bytes : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * D31-1 结构边界：本步只交文字聊天。带**已知结构**（`file`/`image_url`）或选项控制
 * （`interaction_response`）的请求在调用宿主 say / 写附件之前拒绝，稳定错误码 + 中文建议。
 * 未知 content 形状不在此拦（`parseUserContent` 会给 `MIST_INVALID_TURN_SHAPE`）；
 * 纯文字 + capability 声明不是真实附件，不拒绝。
 */
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

function parseUserContent(
  content: unknown,
  binding: AdapterBinding,
  vault: AttachmentVault,
  maxAttachmentBytes: number,
): ParseOutcome {
  if (typeof content === "string") {
    return { ok: true, text: content, attachments: [], remoteUrls: [] };
  }
  if (!Array.isArray(content)) return { ok: false, code: "MIST_INVALID_TURN_SHAPE" };
  const texts: string[] = [];
  const attachments: PreparedAttachment[] = [];
  const remoteUrls: string[] = [];
  let attachmentBytes = 0;
  const owner = ownerOf(binding);
  const withinLimit = (): boolean => attachmentBytes <= maxAttachmentBytes;

  const authorizeRef = (refId: string): PreparedAttachment | null => {
    const record = vault.lookup(refId);
    if (
      record === undefined ||
      record.source !== "inline" ||
      record.bindingId !== owner.bindingId ||
      record.residentId !== owner.residentId ||
      record.scopeId !== owner.scopeId
    ) {
      return null;
    }
    return {
      attachment: {
        attachmentId: record.attachmentId,
        kind: record.kind,
        filename: record.filename,
        mediaType: record.mediaType,
        sizeBytes: record.sizeBytes,
        source: "opaque-ref",
      },
      bytes: vault.readBytes(record.attachmentId),
    };
  };

  for (const part of content) {
    if (!isRecord(part)) return { ok: false, code: "MIST_INVALID_TURN_SHAPE" };
    switch (part.type) {
      case "text": {
        if (typeof part.text !== "string") return { ok: false, code: "MIST_INVALID_TURN_SHAPE" };
        texts.push(part.text);
        break;
      }
      case "file": {
        const file = part.file;
        if (!isRecord(file) || typeof file.filename !== "string" || file.filename.length === 0) {
          return { ok: false, code: "MIST_INVALID_TURN_SHAPE" };
        }
        const hasData = typeof file.file_data === "string";
        const hasId = typeof file.file_id === "string" && file.file_id.length > 0;
        if (hasData === hasId) return { ok: false, code: "MIST_INVALID_TURN_SHAPE" };
        if (hasData) {
          const bytes = decodeBase64Strict(file.file_data as string);
          if (bytes === null) return { ok: false, code: "MIST_INVALID_TURN_SHAPE" };
          attachmentBytes += bytes.length;
          if (!withinLimit()) return { ok: false, code: "MIST_ATTACHMENT_LIMIT_EXCEEDED" };
          attachments.push(
            vault.prepare({
              kind: "file",
              filename: file.filename,
              mediaType: mediaTypeForFilename(file.filename),
              source: "inline",
              bytes,
            }),
          );
        } else {
          const resolved = authorizeRef(file.file_id as string);
          if (resolved === null) return { ok: false, code: "MIST_ATTACHMENT_REF_INVALID" };
          attachmentBytes += resolved.attachment.sizeBytes;
          if (!withinLimit()) return { ok: false, code: "MIST_ATTACHMENT_LIMIT_EXCEEDED" };
          attachments.push(resolved);
        }
        break;
      }
      case "image_url": {
        const image = part.image_url;
        if (!isRecord(image) || typeof image.url !== "string") {
          return { ok: false, code: "MIST_INVALID_TURN_SHAPE" };
        }
        const url = image.url;
        if (/^https?:\/\//i.test(url)) {
          remoteUrls.push(url);
          break;
        }
        if (url.startsWith("data:")) {
          const match = /^data:([^;,]+)?;base64,([\s\S]*)$/.exec(url);
          if (match === null) return { ok: false, code: "MIST_INVALID_TURN_SHAPE" };
          const mediaType = match[1] ?? "";
          const bytes = decodeBase64Strict(match[2] ?? "");
          if (bytes === null) return { ok: false, code: "MIST_INVALID_TURN_SHAPE" };
          if (!imageContentMatches(mediaType, bytes)) {
            return { ok: false, code: "MIST_ATTACHMENT_MEDIA_UNSUPPORTED" };
          }
          attachmentBytes += bytes.length;
          if (!withinLimit()) return { ok: false, code: "MIST_ATTACHMENT_LIMIT_EXCEEDED" };
          attachments.push(
            vault.prepare({ kind: "image", filename: "image", mediaType, source: "inline", bytes }),
          );
          break;
        }
        const resolved = authorizeRef(url);
        if (resolved === null) return { ok: false, code: "MIST_ATTACHMENT_REF_INVALID" };
        if (resolved.attachment.kind !== "image") {
          return { ok: false, code: "MIST_ATTACHMENT_MEDIA_UNSUPPORTED" };
        }
        attachmentBytes += resolved.attachment.sizeBytes;
        if (!withinLimit()) return { ok: false, code: "MIST_ATTACHMENT_LIMIT_EXCEEDED" };
        attachments.push(resolved);
        break;
      }
      default:
        return { ok: false, code: "MIST_INVALID_TURN_SHAPE" };
    }
  }
  return { ok: true, text: texts.join("\n"), attachments, remoteUrls };
}

function validateAttachmentShape(value: unknown): StructuredAttachment | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.attachmentId !== "string" ||
    value.attachmentId.length === 0 ||
    (value.kind !== "image" && value.kind !== "file") ||
    typeof value.filename !== "string" ||
    typeof value.mediaType !== "string" ||
    typeof value.sizeBytes !== "number" ||
    !Number.isFinite(value.sizeBytes) ||
    value.sizeBytes < 0 ||
    (value.source !== "inline" && value.source !== "opaque-ref")
  ) {
    return null;
  }
  return {
    attachmentId: value.attachmentId,
    kind: value.kind,
    filename: value.filename,
    mediaType: value.mediaType,
    sizeBytes: value.sizeBytes,
    source: value.source,
  };
}

function validateResidentReply(value: unknown): ResidentReply | null {
  if (!isRecord(value)) return null;
  if (typeof value.text !== "string") return null;
  switch (value.kind) {
    case "text":
      return { kind: "text", text: value.text };
    case "attachment": {
      if (!Array.isArray(value.attachments)) return null;
      const attachments: StructuredAttachment[] = [];
      for (const item of value.attachments) {
        const attachment = validateAttachmentShape(item);
        if (attachment === null) return null;
        attachments.push(attachment);
      }
      return { kind: "attachment", text: value.text, attachments };
    }
    case "interaction": {
      const interaction = value.interaction;
      if (!isRecord(interaction)) return null;
      if (
        typeof interaction.interactionId !== "string" ||
        (interaction.kind !== "choice" &&
          interaction.kind !== "approval" &&
          interaction.kind !== "blocked") ||
        typeof interaction.prompt !== "string" ||
        interaction.blocking !== true ||
        !Array.isArray(interaction.options) ||
        (interaction.reasonCode !== null && typeof interaction.reasonCode !== "string")
      ) {
        return null;
      }
      const options: StructuredInteraction["options"] = [];
      for (const option of interaction.options) {
        if (!isRecord(option)) return null;
        if (
          typeof option.optionId !== "string" ||
          typeof option.label !== "string" ||
          (option.description !== null && typeof option.description !== "string")
        ) {
          return null;
        }
        options.push({
          optionId: option.optionId,
          label: option.label,
          description: option.description,
        });
      }
      return {
        kind: "interaction",
        text: value.text,
        interaction: {
          interactionId: interaction.interactionId,
          kind: interaction.kind,
          prompt: interaction.prompt,
          blocking: true,
          options,
          reasonCode: interaction.reasonCode,
        },
      };
    }
    default:
      return null;
  }
}

function sameAttachment(left: StructuredAttachment | null, right: StructuredAttachment): boolean {
  if (left === null) return false;
  return (
    left.attachmentId === right.attachmentId &&
    left.kind === right.kind &&
    left.filename === right.filename &&
    left.mediaType === right.mediaType &&
    left.sizeBytes === right.sizeBytes &&
    left.source === right.source
  );
}

export class DeferredStructureEngine {
  readonly #modelPort: FrontendModelPort | null;
  readonly #storeFactory: () => CanonicalStreamStore;
  readonly #resolveGeneration: (residentId: string) => number;
  readonly #maxAttachmentBytes: number;
  readonly #textOnly: boolean;
  readonly #vault: AttachmentVault;
  readonly #ownedWriter: boolean;
  readonly #sessions = new Map<string, Session>();
  readonly #tokens = new Map<string, string>();
  #grants = new WeakMap<object, string>();
  readonly #interactionLocks = new Map<string, Promise<unknown>>();
  #store: CanonicalStreamStore;
  #writer: CanonicalStreamWriter;
  #journal: CanonicalJournal;
  #security: SecurityAuditReadback = freshSecurity();
  #network: NetworkAttemptRecord[] = [];

  constructor(options: DeferredStructureEngineOptions, rootDir: string) {
    this.#modelPort = options.modelPort;
    this.#storeFactory = options.storeFactory ?? (() => new CanonicalStreamStore());
    this.#resolveGeneration = options.resolveGeneration ?? (() => 1);
    this.#maxAttachmentBytes = options.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
    this.#textOnly = options.textOnly !== false;
    this.#vault = new AttachmentVault(rootDir, {
      newOutboundId: options.newOutboundAttachmentId ?? (() => `att_${randomUUID()}`),
      maxAttachmentBytes: this.#maxAttachmentBytes,
    });
    this.#store = options.streamStore ?? this.#storeFactory();
    this.#ownedWriter = options.writer === undefined;
    this.#writer = options.writer ?? openCanonicalStreamWriter(this.#store);
    this.#journal = new CanonicalJournal(this.#store, this.#writer, this.#ownedWriter);
  }

  async close(): Promise<void> {
    await this.#journal.close();
  }

  async reset(): Promise<void> {
    await this.#journal.close();
    this.#sessions.clear();
    this.#tokens.clear();
    this.#grants = new WeakMap<object, string>();
    this.#interactionLocks.clear();
    this.#vault.reset();
    this.#security = freshSecurity();
    this.#network = [];
    if (this.#ownedWriter) {
      this.#store = this.#storeFactory();
      this.#writer = openCanonicalStreamWriter(this.#store);
    }
    this.#journal = new CanonicalJournal(this.#store, this.#writer, this.#ownedWriter);
  }

  resolveToken(token: string | null): AdapterBinding | null {
    if (token === null) return null;
    const bindingId = this.#tokens.get(token);
    if (bindingId === undefined) return null;
    return this.#sessions.get(bindingId)?.binding ?? null;
  }

  /**
   * 唯一鉴权边界：每次恰好记一条 attempts/audit，缺/错 token 直接拒；成功才发一张
   * 不可伪造、绑定 binding、一次性的授权凭据。
   */
  authenticate(bindingId: string | null, context: FrontendRequestContext): AuthOutcome {
    const code = this.#recordAuthAttempt(bindingId, context);
    if (code !== "AUTH_ACCEPTED" || bindingId === null) return { ok: false, code };
    // 授权绑定只存引擎私有 WeakMap；凭据对象不携带可改写字段，也无强引用泄漏。
    const grant: AuthorizationGrant = Object.freeze({ brand: "mist-frontend-grant" as const });
    this.#grants.set(grant, bindingId);
    return { ok: true, grant };
  }

  /** 只认引擎自造的授权凭据，绑定从私有映射取；用过即焚。 */
  async execute(grant: unknown, request: FrontendChatRequest): Promise<FrontendHandleResult> {
    if (typeof grant !== "object" || grant === null) {
      return this.#detached(request, this.#error(401, "AUTH_REQUIRED"));
    }
    const bindingId = this.#grants.get(grant);
    if (bindingId === undefined) {
      return this.#detached(request, this.#error(401, "AUTH_REQUIRED"));
    }
    this.#grants.delete(grant);
    const session = this.#sessions.get(bindingId);
    if (session === undefined) return this.#detached(request, this.#error(401, "AUTH_REQUIRED"));
    const response = await this.#safeProcess(session, request);
    return this.#finish(session, request, response);
  }

  async provisionBinding(input: {
    residentId: string;
    scopeId: string;
    label: string;
  }): Promise<AdapterBinding> {
    const binding: AdapterBinding = {
      bindingId: `binding:${input.label}`,
      endpointId: `endpoint:${input.label}`,
      residentId: input.residentId,
      scopeId: input.scopeId,
      streamId: `stream:${input.residentId}`,
      token: `mist-token-${randomUUID()}`,
      serverModel: `mist:${input.label}`,
      canonicalWriterId: `writer:${input.residentId}`,
    };
    this.#sessions.set(binding.bindingId, {
      binding,
      interactions: new Map(),
      turns: [],
      wire: [],
    });
    this.#tokens.set(binding.token, binding.bindingId);
    this.#journal.ensureStream(binding.residentId);
    return binding;
  }

  async seedCanonicalHistory(bindingId: string, text: string[]): Promise<void> {
    const binding = this.#session(bindingId).binding;
    for (const [index, value] of text.entries()) {
      await this.#journal.append(this.#identity(binding), {
        kind: index % 2 === 0 ? "user" : "assistant",
        text: value,
      });
    }
  }

  /** 便捷入口：认证 + 执行，供直接类型化调用（驱动）与测试。 */
  async handle(
    bindingId: string,
    context: FrontendRequestContext,
    request: FrontendChatRequest,
  ): Promise<FrontendHandleResult> {
    const auth = this.authenticate(bindingId, context);
    if (!auth.ok) {
      const session = this.#sessions.get(bindingId);
      if (session === undefined) return this.#detached(request, this.#error(401, auth.code));
      return this.#finish(session, request, this.#error(401, auth.code));
    }
    return this.execute(auth.grant, request);
  }

  async readRawWire(bindingId: string): Promise<RawWireExchange[]> {
    return structuredClone(this.#session(bindingId).wire);
  }

  async readModelTurns(bindingId: string): Promise<ModelTurnReadback[]> {
    return structuredClone(this.#session(bindingId).turns);
  }

  async readCanonicalEvents(bindingId: string): Promise<CanonicalEventReadback[]> {
    const binding = this.#session(bindingId).binding;
    return this.#journal.events(binding.residentId, this.#identity(binding)).map((event) => ({
      eventId: event.eventId,
      residentId: event.residentId,
      scopeId: event.scopeId,
      streamId: event.streamId,
      writerId: event.writerId,
      kind: event.kind,
      text: event.text,
      attachment: event.attachment,
      interaction: event.interaction,
      projection: event.projection,
      resolvedOptionId: event.resolvedOptionId,
    }));
  }

  async readInteractions(bindingId: string): Promise<InteractionReadback[]> {
    return structuredClone(
      [...this.#session(bindingId).interactions.values()].map(
        ({ bindingId: _bindingId, generation: _generation, ...rest }) => rest,
      ),
    );
  }

  async readAttachmentWrites(): Promise<AttachmentWriteReadback> {
    return this.#vault.readback();
  }

  async readNetworkAttempts(): Promise<NetworkAttemptReadback> {
    return { attempts: this.#network.length, records: structuredClone(this.#network) };
  }

  async readSecurityAudit(): Promise<SecurityAuditReadback> {
    return structuredClone(this.#security);
  }

  #session(bindingId: string): Session {
    const session = this.#sessions.get(bindingId);
    if (session === undefined) throw new Error(`unknown binding: ${bindingId}`);
    return session;
  }

  #identity(binding: AdapterBinding): CanonicalIdentity {
    return {
      residentId: binding.residentId,
      scopeId: binding.scopeId,
      streamId: binding.streamId,
      writerId: binding.canonicalWriterId,
      generation: this.#resolveGeneration(binding.residentId),
    };
  }

  #recordAuthAttempt(bindingId: string | null, context: FrontendRequestContext): string {
    this.#security.attempts += 1;
    if (context.token === null) {
      this.#audit(context, "rejected", "AUTH_REQUIRED");
      return "AUTH_REQUIRED";
    }
    const session = bindingId === null ? undefined : this.#sessions.get(bindingId);
    if (session === undefined || session.binding.token !== context.token) {
      this.#audit(context, "rejected", "AUTH_INVALID");
      return "AUTH_INVALID";
    }
    this.#audit(context, "accepted", "AUTH_ACCEPTED");
    this.#security.accepted += 1;
    return "AUTH_ACCEPTED";
  }

  #error(status: number, code: string, message?: string): FrontendResponse {
    const type = code.startsWith("AUTH") ? "mist_auth_error" : "mist_request_error";
    return {
      status,
      error: { code, type, message: message ?? code, param: null },
      body: null,
      chunks: [],
    };
  }

  #audit(context: FrontendRequestContext, result: "accepted" | "rejected", code: string): void {
    this.#security.entries.push({ source: context.source, result, code });
    this.#security.logs.push(code);
    this.#security.receipts.push(code);
  }

  #wireFor(request: FrontendChatRequest, response: FrontendResponse): RawWireExchange {
    const error = response.error;
    return {
      requestBody: serializeRequest(request),
      responseBody: JSON.stringify(
        errorEnvelope({
          code: error?.code ?? "UNKNOWN",
          type: error?.type ?? "mist_request_error",
          message: error?.message ?? "request failed",
        }),
      ),
      responseKind: "json",
    };
  }

  #finish(
    session: Session,
    request: FrontendChatRequest,
    response: FrontendResponse,
  ): FrontendHandleResult {
    if (response.status === 200) {
      const wire = session.wire.at(-1) ?? {
        requestBody: serializeRequest(request),
        responseBody: "{}",
        responseKind: "json" as const,
      };
      return { response, wire };
    }
    const wire = this.#wireFor(request, response);
    session.wire.push(wire);
    return { response, wire };
  }

  #detached(request: FrontendChatRequest, response: FrontendResponse): FrontendHandleResult {
    return { response, wire: this.#wireFor(request, response) };
  }

  async #safeProcess(session: Session, request: FrontendChatRequest): Promise<FrontendResponse> {
    try {
      return await this.#process(session, request);
    } catch {
      return this.#error(500, "MIST_INTERNAL_ERROR");
    }
  }

  async #process(session: Session, request: FrontendChatRequest): Promise<FrontendResponse> {
    const binding = session.binding;

    const taskKind = request.mist?.taskKind;
    if (typeof taskKind === "string" && taskKind.length > 0) {
      return this.#error(400, "MIST_UTILITY_REQUEST_UNSUPPORTED");
    }

    // D31-1：结构请求（附件/选项控制）在调用宿主 say 与写附件之前拒绝。
    if (this.#textOnly) {
      const structural = structuralRejection(request);
      if (structural !== null) {
        return this.#error(400, structural.code, structural.message);
      }
    }

    // 分支能力：非 textOnly 引擎保留选项控制处理（下层独立测试用）。
    const interactionResponse = request.mist?.interactionResponse;
    if (interactionResponse !== undefined) {
      return this.#resolveInteraction(session, request, interactionResponse);
    }

    const last = request.messages.at(-1);
    if (last === undefined || last.role !== "user") {
      return this.#error(400, "MIST_INVALID_TURN_SHAPE");
    }
    const parsed = parseUserContent(last.content, binding, this.#vault, this.#maxAttachmentBytes);
    if (!parsed.ok) return this.#error(400, parsed.code);
    if (parsed.remoteUrls.length > 0) {
      return this.#error(400, "MIST_REMOTE_URL_UNSUPPORTED");
    }

    const turn: TurnAttachmentState = { active: true, issued: new Map(), stagedIds: [] };
    try {
      const capabilities: ClientCapability[] = [...(request.mist?.client?.capabilities ?? [])];
      const owner = ownerOf(binding);
      const identity = this.#identity(binding);
      const attachmentPort = this.#attachmentPort(parsed.attachments, owner, turn);
      // 模型上下文只取**当前代**的 canonical user/assistant；前代原件留在底层可读，
      // 但不自动灌进当前模型 history（D8：前代靠启动包/交接信承接）。
      const history = this.#journal
        .events(binding.residentId, identity)
        .filter(
          (event) =>
            (event.kind === "user" || event.kind === "assistant") &&
            event.generation === identity.generation,
        )
        .map((event) => ({
          role: event.kind as "user" | "assistant",
          text: event.text ?? "",
        }));
      const modelTurn: FrontendModelTurn = {
        bindingId: binding.bindingId,
        residentId: binding.residentId,
        scopeId: binding.scopeId,
        streamId: binding.streamId,
        generation: identity.generation,
        canonicalHistoryText: history.map((message) => message.text),
        history,
        currentText: parsed.text,
        attachments: parsed.attachments.map((prepared) => prepared.attachment),
        surfaceCapabilities: capabilities,
        attachmentPort,
      };
      if (this.#modelPort === null) return this.#error(503, "MIST_MODEL_UNAVAILABLE");
      let rawReply: ResidentReply;
      try {
        rawReply = await this.#modelPort.complete(modelTurn);
      } catch {
        return this.#error(502, "MIST_MODEL_FAILED");
      }
      const reply = validateResidentReply(rawReply);
      if (reply === null) return this.#error(502, "MIST_MODEL_REPLY_INVALID");

      const replyAttachments = reply.kind === "attachment" ? reply.attachments : [];
      const referencedStaged: string[] = [];
      for (const attachment of replyAttachments) {
        // 只认**本回合实际签发清单**里的条目，并逐项核不可变元数据；不凭全局 stage id 放行。
        const issued = turn.issued.get(attachment.attachmentId);
        if (issued === undefined || !sameAttachment(issued.attachment, attachment)) {
          return this.#error(502, "MIST_MODEL_REPLY_INVALID");
        }
        if (issued.staged) {
          const stagedOwner = this.#vault.stagedOwner(attachment.attachmentId);
          if (stagedOwner === null || stagedOwner.bindingId !== owner.bindingId) {
            return this.#error(502, "MIST_MODEL_REPLY_INVALID");
          }
          referencedStaged.push(attachment.attachmentId);
        } else {
          const record = this.#vault.lookup(attachment.attachmentId);
          if (
            record === undefined ||
            record.bindingId !== owner.bindingId ||
            record.residentId !== owner.residentId ||
            record.scopeId !== owner.scopeId
          ) {
            return this.#error(502, "MIST_MODEL_REPLY_INVALID");
          }
        }
      }
      const interaction = reply.kind === "interaction" ? reply.interaction : null;

      // 正序落账：user → 入站附件 → assistant → 出站附件 → interaction → surface-projection。
      const ingressAttachments = parsed.attachments.map((prepared) => prepared.attachment);
      await this.#journal.append(identity, { kind: "user", text: parsed.text });
      for (const attachment of ingressAttachments) {
        await this.#journal.append(identity, { kind: "attachment", attachment });
      }
      const canonicalEventIds: string[] = [];
      canonicalEventIds.push(
        await this.#journal.append(identity, { kind: "assistant", text: reply.text }),
      );
      for (const attachment of replyAttachments) {
        canonicalEventIds.push(
          await this.#journal.append(identity, { kind: "attachment", attachment }),
        );
      }
      if (interaction !== null) {
        canonicalEventIds.push(
          await this.#journal.append(identity, { kind: "interaction", interaction }),
        );
        session.interactions.set(
          interaction.interactionId,
          this.#interactionReadback(interaction, binding.bindingId, identity.generation),
        );
      }
      // 整个 reply 通过、回合成功后：只提交 **reply 实际引用且本回合合法** 的出站附件，
      // 未引用的暂存丢开；入站附件此时才落字节。
      const unreferenced = turn.stagedIds.filter((id) => !referencedStaged.includes(id));
      this.#vault.discardStaged(unreferenced);
      this.#vault.commitStaged(referencedStaged);
      for (const prepared of parsed.attachments) this.#vault.persist(prepared, owner);
      session.turns.push({
        residentId: binding.residentId,
        scopeId: binding.scopeId,
        canonicalHistoryText: modelTurn.canonicalHistoryText,
        currentText: parsed.text,
        attachments: ingressAttachments,
        surfaceCapabilities: capabilities,
      });

      const missingCapabilities: ClientCapability[] = [];
      let projectionStatus: SurfaceProjection["status"] = "native";
      if (replyAttachments.length > 0 && !capabilities.includes("attachments")) {
        projectionStatus = "degraded";
        missingCapabilities.push("attachments");
      }
      if (interaction !== null && !capabilities.includes("interactions")) {
        projectionStatus = "blocked";
        missingCapabilities.push("interactions");
      }
      const projection: SurfaceProjection = {
        status: projectionStatus,
        missingCapabilities,
        canonicalEventIds,
      };
      // D31-1：文字路径不往主流写 surface-projection 等非文字事件；分支能力保留。
      if (!this.#textOnly) {
        await this.#journal.append(identity, { kind: "surface-projection", projection });
      }

      const id = `chatcmpl_mist_${randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);
      const body: FrontendCompletionBody = {
        id,
        model: binding.serverModel,
        streamId: binding.streamId,
        text: reply.text,
        attachments: replyAttachments,
        interaction,
        projection,
      };
      const wireInput = {
        id,
        model: binding.serverModel,
        created,
        streamId: binding.streamId,
        text: reply.text,
        attachments: replyAttachments,
        interaction,
        projection,
      };
      session.wire.push({
        requestBody: serializeRequest(request),
        responseBody: request.stream ? serializeSse(wireInput) : serializeCompletion(wireInput),
        responseKind: request.stream ? "sse" : "json",
      });
      const chunks: FrontendStreamChunk[] = request.stream
        ? [
            {
              textDelta: reply.text,
              attachments: replyAttachments,
              interaction,
              projection,
              done: false,
            },
            { textDelta: "", attachments: [], interaction: null, projection: null, done: true },
          ]
        : [];
      return { status: 200, error: null, body, chunks };
    } finally {
      // 回合结束：端口失效（不能再签发/读本回合数据），未提交的暂存全丢弃。
      turn.active = false;
      this.#vault.discardStaged(turn.stagedIds);
    }
  }

  #attachmentPort(
    ingress: PreparedAttachment[],
    owner: AttachmentOwner,
    turn: TurnAttachmentState,
  ): FrontendAttachmentPort {
    const assertActive = (): void => {
      if (!turn.active) throw new Error("attachment port is no longer active for this turn");
    };
    return {
      incoming: () => {
        assertActive();
        return ingress.map((prepared) => ({
          attachment: Object.freeze({ ...prepared.attachment }),
          read: async () => {
            assertActive();
            return prepared.bytes !== null
              ? Buffer.from(prepared.bytes)
              : (this.#vault.readBytes(prepared.attachment.attachmentId) ?? Buffer.alloc(0));
          },
        }));
      },
      open: (refId) => {
        assertActive();
        const record = this.#vault.lookup(refId);
        if (
          record === undefined ||
          record.source !== "inline" ||
          record.bindingId !== owner.bindingId ||
          record.residentId !== owner.residentId ||
          record.scopeId !== owner.scopeId
        ) {
          return null;
        }
        const bytes = this.#vault.readBytes(refId);
        if (bytes === null) return null;
        return {
          attachment: Object.freeze({
            attachmentId: record.attachmentId,
            kind: record.kind,
            filename: record.filename,
            mediaType: record.mediaType,
            sizeBytes: record.sizeBytes,
            source: record.source,
          }),
          read: async () => {
            assertActive();
            return Buffer.from(bytes);
          },
        };
      },
      prepareOutbound: (input) => {
        assertActive();
        const attachment = this.#vault.issueOutbound(input, owner);
        turn.issued.set(attachment.attachmentId, { attachment, staged: true });
        turn.stagedIds.push(attachment.attachmentId);
        return attachment;
      },
      reuseOutbound: (refId, input) => {
        assertActive();
        const attachment = this.#vault.reuseOutbound(refId, input, owner);
        turn.issued.set(attachment.attachmentId, { attachment, staged: false });
        return attachment;
      },
    };
  }

  #interactionReadback(
    interaction: StructuredInteraction,
    bindingId: string,
    generation: number,
  ): StoredInteraction {
    return {
      interactionId: interaction.interactionId,
      kind: interaction.kind,
      prompt: interaction.prompt,
      blocking: true,
      options: structuredClone(interaction.options),
      reasonCode: interaction.reasonCode,
      status: "pending",
      resolvedOptionId: null,
      resolutionEventId: null,
      bindingId,
      generation,
    };
  }

  async #resolveInteraction(
    session: Session,
    request: FrontendChatRequest,
    response: { interactionId: string; optionId: string },
  ): Promise<FrontendResponse> {
    if (request.messages.length !== 0) {
      return this.#error(400, "MIST_INTERACTION_RESPONSE_INVALID");
    }
    return this.#withInteractionLock(response.interactionId, async () => {
      const stored = session.interactions.get(response.interactionId);
      const identity = this.#identity(session.binding);
      if (
        stored === undefined ||
        stored.status !== "pending" ||
        stored.generation !== identity.generation ||
        !stored.options.some((option) => option.optionId === response.optionId)
      ) {
        return this.#error(400, "MIST_INTERACTION_RESPONSE_INVALID");
      }
      const interaction: StructuredInteraction = {
        interactionId: stored.interactionId,
        kind: stored.kind,
        prompt: stored.prompt,
        blocking: true,
        options: stored.options,
        reasonCode: stored.reasonCode,
      };
      const eventId = await this.#journal.append(identity, {
        kind: "interaction",
        interaction,
        resolvedOptionId: response.optionId,
      });
      stored.status = "resolved";
      stored.resolvedOptionId = response.optionId;
      stored.resolutionEventId = eventId;

      const projection: SurfaceProjection = {
        status: "native",
        missingCapabilities: [],
        canonicalEventIds: [eventId],
      };
      const id = `chatcmpl_mist_${randomUUID()}`;
      const body: FrontendCompletionBody = {
        id,
        model: session.binding.serverModel,
        streamId: session.binding.streamId,
        text: "",
        attachments: [],
        interaction: null,
        projection,
      };
      session.wire.push({
        requestBody: serializeRequest(request),
        responseBody: serializeCompletion({
          id,
          model: session.binding.serverModel,
          created: Math.floor(Date.now() / 1000),
          streamId: session.binding.streamId,
          text: "",
          attachments: [],
          interaction: null,
          projection,
        }),
        responseKind: "json",
      });
      return { status: 200, error: null, body, chunks: [] };
    });
  }

  async #withInteractionLock<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.#interactionLocks.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const marker = previous.then(
      () => gate,
      () => gate,
    );
    this.#interactionLocks.set(key, marker);
    await previous.catch(() => undefined);
    try {
      return await run();
    } finally {
      release();
      if (this.#interactionLocks.get(key) === marker) this.#interactionLocks.delete(key);
    }
  }
}
