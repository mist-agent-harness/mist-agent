/**
 * #218/D31 前端 canonical 落账：读写**住户真实的**一窗流，不发明影子流。
 *
 * - stream key 就是 `residentId` 本身（生产住户 ID 是安全 ID；合成住户由驱动建立合法
 *   ID）；`CanonicalEvent.residentId` 与 `origin.subject` 都是它，不再是 hash。
 * - writer 由宿主持有：引擎可以接收宿主已经打开的 store + writer（借用，不 close、
 *   不抢所有权），也可以自己经 `openCanonicalStreamWriter`（全 src/ 唯一构造点）开一个。
 * - 读回既认前端写的事件（payload.frontend），也认现役 runtime 写的
 *   `{ role, text }` message 事件，所以模型历史与 `readStream` 看到的是同一条主流。
 * - 幂等键用随机值，重开持久 dataDir 后新事件不会撞旧键。
 */
import { randomUUID } from "node:crypto";
import type {
  StructuredAttachment,
  StructuredInteraction,
  SurfaceProjection,
} from "../../acceptance/frontend-adapter-driver.ts";
import type { CanonicalStreamStore } from "../one-stream/index.ts";
import type { CanonicalEvent, CanonicalEventDraft, JsonObject } from "../one-stream/index.ts";
import type { CanonicalStreamWriter } from "../one-stream/index.ts";

export type JournalEventKind =
  | "user"
  | "assistant"
  | "attachment"
  | "interaction"
  | "surface-projection";

/** 写入时刻固定的归属；generation 是这一代主流。 */
export interface CanonicalIdentity {
  residentId: string;
  scopeId: string;
  streamId: string;
  writerId: string;
  generation: number;
}

export interface JournalEventInput {
  kind: JournalEventKind;
  text?: string | null;
  attachment?: StructuredAttachment | null;
  interaction?: StructuredInteraction | null;
  projection?: SurfaceProjection | null;
  resolvedOptionId?: string | null;
}

export interface JournalEvent {
  eventId: string;
  residentId: string;
  scopeId: string;
  streamId: string;
  writerId: string;
  generation: number;
  kind: JournalEventKind;
  text: string | null;
  attachment: StructuredAttachment | null;
  interaction: StructuredInteraction | null;
  projection: SurfaceProjection | null;
  resolvedOptionId: string | null;
}

const PURPOSE_BY_KIND: Record<JournalEventKind, CanonicalEventDraft["purpose"]> = {
  user: "message",
  assistant: "message",
  attachment: "message",
  interaction: "blocked",
  "surface-projection": "progress",
};

function draftFor(identity: CanonicalIdentity, input: JournalEventInput): CanonicalEventDraft {
  const frontend = {
    kind: input.kind,
    text: input.text ?? null,
    attachment: input.attachment ?? null,
    interaction: input.interaction ?? null,
    projection: input.projection ?? null,
    resolvedOptionId: input.resolvedOptionId ?? null,
  };
  const payload = JSON.parse(
    JSON.stringify({
      identity: {
        residentId: identity.residentId,
        scopeId: identity.scopeId,
        streamId: identity.streamId,
        writerId: identity.writerId,
        generation: identity.generation,
      },
      // user/assistant 同步写成现役 runtime 认得的 message 形状（role/text），
      // 让宿主 readStream 的 message 投影看得到前端回合；结构事件另有 frontend 段。
      ...(input.kind === "user" || input.kind === "assistant"
        ? { role: input.kind, text: input.text ?? "" }
        : {}),
      frontend,
    }),
  ) as JsonObject;
  return {
    purpose: PURPOSE_BY_KIND[input.kind],
    occurredAt: new Date().toISOString(),
    workRef: null,
    authoritySource: { kind: "host", id: "frontend-adapter" },
    origin: {
      reporter: { kind: "host", id: "frontend-adapter" },
      subject: { kind: "resident", id: identity.residentId },
      viewport: { windowId: "frontend-adapter", generation: identity.generation },
    },
    effect: { state: "not-applicable", requiresUserAction: false, retry: "not-applicable" },
    artifactRef: null,
    payload,
  };
}

function normalizeAttachment(
  value: StructuredAttachment | null | undefined,
): StructuredAttachment | null {
  if (value === null || value === undefined) return null;
  return {
    attachmentId: value.attachmentId,
    kind: value.kind,
    filename: value.filename,
    mediaType: value.mediaType,
    sizeBytes: value.sizeBytes,
    source: value.source,
  };
}

function normalizeInteraction(
  value: StructuredInteraction | null | undefined,
): StructuredInteraction | null {
  if (value === null || value === undefined) return null;
  return {
    interactionId: value.interactionId,
    kind: value.kind,
    prompt: value.prompt,
    blocking: true,
    options: value.options.map((option) => ({
      optionId: option.optionId,
      label: option.label,
      description: option.description,
    })),
    reasonCode: value.reasonCode,
  };
}

function normalizeProjection(
  value: SurfaceProjection | null | undefined,
): SurfaceProjection | null {
  if (value === null || value === undefined) return null;
  return {
    status: value.status,
    missingCapabilities: [...value.missingCapabilities],
    canonicalEventIds: [...value.canonicalEventIds],
  };
}

interface StoredPayload {
  identity?: CanonicalIdentity;
  frontend?: {
    kind?: JournalEventKind;
    text?: string | null;
    attachment?: StructuredAttachment | null;
    interaction?: StructuredInteraction | null;
    projection?: SurfaceProjection | null;
    resolvedOptionId?: string | null;
  };
  role?: unknown;
  text?: unknown;
}

/**
 * 前端事件照 `payload.identity`（写入时固定）返回；现役 runtime 的 message 事件照
 * `event.residentId` + `origin.viewport.generation` 返回，scope/stream/writer 用当前
 * binding 的映射补足（一窗流按住户一条，binding 即该住户在适配层的句柄）。
 */
function fromCanonical(event: CanonicalEvent, fallback: CanonicalIdentity): JournalEvent | null {
  const payload = event.payload as StoredPayload;
  if (payload.frontend !== undefined) {
    const identity = payload.identity ?? fallback;
    return {
      eventId: event.eventId,
      residentId: identity.residentId,
      scopeId: identity.scopeId,
      streamId: identity.streamId,
      writerId: identity.writerId,
      generation: identity.generation,
      kind: payload.frontend.kind ?? "user",
      text: payload.frontend.text ?? null,
      attachment: normalizeAttachment(payload.frontend.attachment),
      interaction: normalizeInteraction(payload.frontend.interaction),
      projection: normalizeProjection(payload.frontend.projection),
      resolvedOptionId: payload.frontend.resolvedOptionId ?? null,
    };
  }
  if (
    (payload.role === "user" || payload.role === "assistant") &&
    typeof payload.text === "string"
  ) {
    const viewport = event.origin?.viewport ?? null;
    return {
      eventId: event.eventId,
      residentId: event.residentId,
      scopeId: fallback.scopeId,
      streamId: fallback.streamId,
      writerId: fallback.writerId,
      generation: viewport?.generation ?? fallback.generation,
      kind: payload.role,
      text: payload.text,
      attachment: null,
      interaction: null,
      projection: null,
      resolvedOptionId: null,
    };
  }
  return null;
}

export class CanonicalJournal {
  readonly #store: CanonicalStreamStore;
  readonly #writer: CanonicalStreamWriter;
  readonly #ownsWriter: boolean;

  constructor(store: CanonicalStreamStore, writer: CanonicalStreamWriter, ownsWriter: boolean) {
    this.#store = store;
    this.#writer = writer;
    this.#ownsWriter = ownsWriter;
  }

  ensureStream(residentId: string): void {
    if (!this.#store.has(residentId)) this.#store.createStream(residentId);
  }

  async append(identity: CanonicalIdentity, input: JournalEventInput): Promise<string> {
    this.ensureStream(identity.residentId);
    const receipt = await this.#writer.submit({
      residentId: identity.residentId,
      // 随机键：重开持久 dataDir 后新事件不会撞旧键（不要求完整重试协议）。
      idempotencyKey: `${identity.residentId}-event-${randomUUID()}`,
      draft: draftFor(identity, input),
    });
    return receipt.eventId;
  }

  events(residentId: string, fallback: CanonicalIdentity): JournalEvent[] {
    if (!this.#store.has(residentId)) return [];
    const collected: JournalEvent[] = [];
    for (const event of this.#store.events(residentId)) {
      const mapped = fromCanonical(event, fallback);
      if (mapped !== null) collected.push(mapped);
    }
    return collected;
  }

  async close(): Promise<void> {
    if (this.#ownsWriter) await this.#writer.close();
  }
}
