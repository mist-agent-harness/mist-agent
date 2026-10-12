/** #218 / D31 的七盏可执行判卷。 */
import type {
  AdapterBinding,
  AttachmentWriteRecord,
  ClientCapability,
  FrontendAdapterCheck,
  FrontendAdapterCheckResult,
  FrontendAdapterDriver,
  FrontendChatRequest,
  FrontendCompletionBody,
  FrontendRequestContext,
  FrontendResponse,
  InteractionReadback,
  ResidentReply,
  StructuredAttachment,
  StructuredInteraction,
  StructuredInteractionOption,
  SurfaceProjection,
  WebuiCommandReadback,
  WebuiInstallProposal,
  WebuiRuntime,
} from "./frontend-adapter-driver.ts";

const pass = (detail: string): FrontendAdapterCheckResult => ({ passed: true, detail });
const fail = (detail: string): FrontendAdapterCheckResult => ({ passed: false, detail });
const json = (value: unknown): string => JSON.stringify(value);

/** 失败 detail 不许把 token 原文带进判卷输出；合成 token 同样按敏感处理。 */
function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out;
}

function request(
  text: string,
  input: {
    model?: string;
    stream?: boolean;
    history?: FrontendChatRequest["messages"];
    capabilities?: ClientCapability[];
    interactionResponse?: { interactionId: string; optionId: string };
    taskKind?: string;
    /**
     * 控制响应（点击/批准）不捏造 user turn：`messages` 为空、只带 `mist.interaction_response`。
     * 它不是一条聊天话语，不许调用模型或落 user/assistant 事件。
     */
    controlOnly?: boolean;
  } = {},
): FrontendChatRequest {
  const mist: NonNullable<FrontendChatRequest["mist"]> = {
    client: {
      surface: "acceptance-fixture",
      capabilities: input.capabilities ?? [],
    },
  };
  if (input.interactionResponse !== undefined) mist.interactionResponse = input.interactionResponse;
  if (input.taskKind !== undefined) mist.taskKind = input.taskKind;
  return {
    model: input.model ?? "client-selected-model",
    stream: input.stream ?? false,
    messages: input.controlOnly
      ? [...(input.history ?? [])]
      : [
          ...(input.history ?? []),
          {
            role: "user",
            content: text,
          },
        ],
    mist,
  };
}

function authorized(binding: AdapterBinding, conversationId: string | null = null) {
  return {
    token: binding.token,
    source: "remote" as const,
    conversationId,
  };
}

function bodyOf(response: FrontendResponse): FrontendCompletionBody | null {
  if (response.status !== 200 || response.error !== null || response.body === null) return null;
  return response.body;
}

function textEvents(events: Awaited<ReturnType<FrontendAdapterDriver["readCanonicalEvents"]>>) {
  return events
    .filter((event) => event.kind === "user" || event.kind === "assistant")
    .map((event) => ({ kind: event.kind, text: event.text }));
}

type CanonicalEvents = Awaited<ReturnType<FrontendAdapterDriver["readCanonicalEvents"]>>;

function addedEvents(before: CanonicalEvents, after: CanonicalEvents): CanonicalEvents {
  const priorIds = new Set(before.map((event) => event.eventId));
  return after.filter((event) => !priorIds.has(event.eventId));
}

function ownedEvents(target: AdapterBinding, events: CanonicalEvents): boolean {
  return events.every(
    (event) =>
      event.residentId === target.residentId &&
      event.scopeId === target.scopeId &&
      event.streamId === target.streamId &&
      event.writerId === target.canonicalWriterId,
  );
}

/** 投影只引用本轮新增记录，并覆盖本次实际呈现的结构；不限定引用条数。 */
function projectionMatchesRound(
  target: AdapterBinding,
  body: FrontendCompletionBody,
  before: CanonicalEvents,
  after: CanonicalEvents,
): boolean {
  const current = addedEvents(before, after);
  const ids = body.projection.canonicalEventIds;
  if (ids.length === 0 || ids.some((id) => !current.some((event) => event.eventId === id)))
    return false;
  const referenced = current.filter((event) => ids.includes(event.eventId));
  return (
    ownedEvents(target, referenced) &&
    current.some((event) => json(event.projection) === json(body.projection)) &&
    body.attachments.every((item) =>
      referenced.some(
        (event) => event.kind === "attachment" && sameAttachment(event.attachment, item),
      ),
    ) &&
    (body.interaction === null ||
      referenced.some(
        (event) =>
          event.kind === "interaction" && json(event.interaction) === json(body.interaction),
      ))
  );
}

function streamMistMatches(
  mist: Record<string, unknown> | undefined,
  body: FrontendCompletionBody,
): boolean {
  return (
    mist !== undefined &&
    mist.stream_id === body.streamId &&
    json(wireAttachments(mist.attachments)) === json(body.attachments) &&
    (body.interaction === null
      ? mist.interaction === null
      : json(wireInteraction(mist.interaction)) === json(body.interaction)) &&
    json(wireProjection(mist.projection)) === json(body.projection)
  );
}

function attachment(label: string): StructuredAttachment {
  return {
    attachmentId: `attachment:${label}`,
    kind: "file",
    filename: `${label}.txt`,
    mediaType: "text/plain",
    sizeBytes: 5,
    source: "inline",
  };
}

function interaction(
  label: string,
  kind: StructuredInteraction["kind"] = "choice",
): StructuredInteraction {
  return {
    interactionId: `interaction:${label}`,
    kind,
    prompt: `Choose ${label}`,
    blocking: true,
    options: [
      { optionId: `${label}:alpha`, label: `${label} ALPHA`, description: null },
      { optionId: `${label}:beta`, label: `${label} BETA`, description: null },
    ],
    reasonCode: null,
  };
}

async function binding(driver: FrontendAdapterDriver, label: string): Promise<AdapterBinding> {
  return driver.provisionBinding({
    residentId: `resident:${label}`,
    scopeId: `scope:${label}`,
    label,
  });
}

function sameInteraction(
  readback: InteractionReadback | undefined,
  expected: StructuredInteraction,
): boolean {
  if (readback === undefined) return false;
  return (
    readback.interactionId === expected.interactionId &&
    readback.kind === expected.kind &&
    readback.prompt === expected.prompt &&
    readback.blocking === expected.blocking &&
    readback.reasonCode === expected.reasonCode &&
    json(readback.options) === json(expected.options)
  );
}

/**
 * 判卷自己的极简 OpenAI wire 解析器。**故意不与被测驱动共享生成代码**：
 * 驱动写 wire，判卷独立读 wire，两边各自实现，避免「用同一 helper 生成 oracle 又解析实际值」。
 */
interface ParsedJsonEnvelope {
  id: string;
  object: string;
  model: string;
  choices: Array<{
    index: number;
    message?: { role?: string; content?: unknown };
    delta?: { role?: string; content?: unknown };
    finish_reason?: unknown;
  }>;
  mist: Record<string, unknown>;
}

function parseJsonEnvelope(raw: string): ParsedJsonEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const envelope = parsed as Record<string, unknown>;
  if (typeof envelope.id !== "string" || typeof envelope.object !== "string") return null;
  if (!Number.isInteger(envelope.created) || (envelope.created as number) < 0) return null;
  if (typeof envelope.model !== "string" || !Array.isArray(envelope.choices)) return null;
  const mist = (
    typeof envelope.mist === "object" && envelope.mist !== null ? envelope.mist : {}
  ) as Record<string, unknown>;
  return {
    id: envelope.id,
    object: envelope.object,
    model: envelope.model,
    choices: envelope.choices as ParsedJsonEnvelope["choices"],
    mist,
  };
}

interface ParsedSse {
  frames: ParsedJsonEnvelope[];
  doneCount: number;
  malformedCount: number;
}

function parseSse(raw: string): ParsedSse {
  const frames: ParsedJsonEnvelope[] = [];
  let doneCount = 0;
  let malformedCount = 0;
  // SSE 空行才会派发事件；逐行解析会误认没有分帧的多个 JSON 为正常流。
  const blocks = raw.replace(/\r\n?/g, "\n").split("\n\n");
  if (blocks.pop()?.trim()) malformedCount += 1;
  let finished = false;
  for (const block of blocks) {
    const payload = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n");
    if (payload.length === 0) continue;
    if (finished) malformedCount += 1;
    if (payload === "[DONE]") {
      doneCount += 1;
      finished = true;
      continue;
    }
    const parsed = parseJsonEnvelope(payload);
    if (parsed === null) malformedCount += 1;
    else frames.push(parsed);
  }
  return { frames, doneCount, malformedCount };
}

function jsonContent(value: unknown): string | null {
  if (typeof value === "string") return value;
  return null;
}

/**
 * 线协议用 snake_case；判卷把 `mist` 扩展的原始形状解析回归一化类型再比对，
 * 这样「归一化对象自洽」骗不过「wire 字段名/结构被换掉」。
 */
function wireProjection(value: unknown): SurfaceProjection | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const status = record.status;
  if (status !== "native" && status !== "degraded" && status !== "blocked") return null;
  const missing = Array.isArray(record.missing_capabilities) ? record.missing_capabilities : [];
  const ids = Array.isArray(record.canonical_event_ids) ? record.canonical_event_ids : [];
  return {
    status,
    missingCapabilities: missing.filter(
      (item): item is ClientCapability => item === "attachments" || item === "interactions",
    ),
    canonicalEventIds: ids.filter((item): item is string => typeof item === "string"),
  };
}

function wireAttachments(value: unknown): StructuredAttachment[] | null {
  if (!Array.isArray(value)) return null;
  const out: StructuredAttachment[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) return null;
    const record = item as Record<string, unknown>;
    if (
      typeof record.attachment_id !== "string" ||
      (record.kind !== "image" && record.kind !== "file") ||
      typeof record.filename !== "string" ||
      typeof record.media_type !== "string" ||
      typeof record.size_bytes !== "number" ||
      (record.source !== "inline" && record.source !== "opaque-ref")
    ) {
      return null;
    }
    out.push({
      attachmentId: record.attachment_id,
      kind: record.kind,
      filename: record.filename,
      mediaType: record.media_type,
      sizeBytes: record.size_bytes,
      source: record.source,
    });
  }
  return out;
}

function wireInteraction(value: unknown): StructuredInteraction | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.interaction_id !== "string" ||
    (record.kind !== "choice" && record.kind !== "approval" && record.kind !== "blocked") ||
    typeof record.prompt !== "string" ||
    record.blocking !== true ||
    !Array.isArray(record.options)
  ) {
    return null;
  }
  const options: StructuredInteractionOption[] = [];
  for (const option of record.options) {
    if (typeof option !== "object" || option === null) return null;
    const item = option as Record<string, unknown>;
    if (
      typeof item.option_id !== "string" ||
      typeof item.label !== "string" ||
      (item.description !== null && typeof item.description !== "string")
    ) {
      return null;
    }
    options.push({
      optionId: item.option_id,
      label: item.label,
      description: item.description,
    });
  }
  return {
    interactionId: record.interaction_id,
    kind: record.kind,
    prompt: record.prompt,
    blocking: true,
    options,
    reasonCode: typeof record.reason_code === "string" ? record.reason_code : null,
  };
}

function sameAttachment(
  left: StructuredAttachment | null | undefined,
  right: StructuredAttachment,
): boolean {
  if (left === null || left === undefined) return false;
  return (
    left.attachmentId === right.attachmentId &&
    left.kind === right.kind &&
    left.filename === right.filename &&
    left.mediaType === right.mediaType &&
    left.sizeBytes === right.sizeBytes &&
    left.source === right.source
  );
}

/**
 * 逐字段核私有附件面写入记录：完整附件结构 + binding/resident/scope/stream/writer 归属。
 * 不依赖对象 JSON key 顺序，也不假设 host opaque id 的字面。
 */
function sameAttachmentWrite(
  record: AttachmentWriteRecord | undefined,
  attachment: StructuredAttachment,
  owner: {
    bindingId: string;
    residentId: string;
    scopeId: string;
    streamId: string;
    writerId: string;
  },
): boolean {
  if (record === undefined) return false;
  return (
    sameAttachment(record, attachment) &&
    record.bindingId === owner.bindingId &&
    record.residentId === owner.residentId &&
    record.scopeId === owner.scopeId &&
    record.streamId === owner.streamId &&
    record.writerId === owner.writerId
  );
}

/** 解析控制响应原始请求体，返回 snake_case 的 interaction_response（缺失返回 undefined）。 */
function requestInteractionResponse(
  raw: string,
): { interaction_id: string; option_id: string } | "missing" | "malformed" {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "malformed";
  }
  if (typeof parsed !== "object" || parsed === null) return "malformed";
  const mist = (parsed as Record<string, unknown>).mist;
  if (typeof mist !== "object" || mist === null) return "missing";
  const response = (mist as Record<string, unknown>).interaction_response;
  if (response === null || response === undefined) return "missing";
  if (typeof response !== "object") return "malformed";
  const record = response as Record<string, unknown>;
  if (typeof record.interaction_id !== "string" || typeof record.option_id !== "string") {
    return "malformed";
  }
  return { interaction_id: record.interaction_id, option_id: record.option_id };
}

interface RawRequestBodyShape {
  messages?: Array<{ role?: string; content?: unknown }>;
}

/** 请求体末尾必须还是本次当前 user turn；解析失败返回 null。 */
function lastRequestMessage(raw: string): { role?: string; content?: unknown } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const messages = (parsed as RawRequestBodyShape).messages;
  if (!Array.isArray(messages)) return null;
  return messages.at(-1) ?? null;
}

const fe01: FrontendAdapterCheck = {
  id: "FE-01",
  title: "默认只进终端，外接前端显式选择，旧 official-skin 不静默改写",
  uses: ["runInstaller", "readLegacyOfficialSkin", "reset"],
  async run(driver) {
    try {
      const defaultInstall = await driver.runInstaller({ frontend: "default" });
      if (
        !defaultInstall.committed ||
        !defaultInstall.defaulted ||
        defaultInstall.frontend.kind !== "terminal"
      ) {
        return fail(`默认安装没有落 terminal：${json(defaultInstall)}`);
      }
      const external = await driver.runInstaller({ frontend: "external" });
      if (
        !external.committed ||
        external.defaulted ||
        external.frontend.kind !== "external" ||
        external.frontend.integration !== "openai-compatible"
      ) {
        return fail(`显式外接前端没有落新适配层：${json(external)}`);
      }
      const legacyBytes = JSON.stringify({
        frontend: {
          kind: "official-skin",
          pluginId: "mist-official-skin",
          installation: "pending",
        },
      });
      const legacy = await driver.readLegacyOfficialSkin(legacyBytes);
      if (
        legacy.ok ||
        legacy.code !== "LEGACY_FRONTEND_UNSUPPORTED" ||
        legacy.rewritten ||
        legacy.bytesAfter !== legacyBytes ||
        legacy.remedy.trim().length === 0
      ) {
        return fail(`旧 official-skin 没有可操作地 fail-closed：${json(legacy)}`);
      }
      return pass("默认 terminal、显式 external 与旧配置拒绝三条边界同时成立");
    } finally {
      await driver.reset();
    }
  },
};

const fe02: FrontendAdapterCheck = {
  id: "FE-02",
  title: "OpenAI-compatible 往返走唯一 writer，普通与流式回复只落一次",
  uses: [
    "provisionBinding",
    "seedCanonicalHistory",
    "queueResidentReply",
    "sendCompletion",
    "readRawWire",
    "readModelTurns",
    "readCanonicalEvents",
    "readInteractions",
    "readAttachmentWrites",
    "reset",
  ],
  async run(driver) {
    try {
      const target = await binding(driver, "fe02");
      await driver.seedCanonicalHistory(target.bindingId, ["seed:user", "seed:assistant"]);
      const seededCount = (await driver.readCanonicalEvents(target.bindingId)).length;

      // —— 普通（非流式）往返 ——
      const plainText = "reply:plain";
      await driver.queueResidentReply(target.bindingId, { kind: "text", text: plainText });
      const plain = await driver.sendCompletion(
        target.bindingId,
        authorized(target),
        request("turn:plain"),
      );
      const plainBody = bodyOf(plain);
      if (
        plainBody === null ||
        plainBody.text !== plainText ||
        plainBody.model !== target.serverModel ||
        plainBody.streamId !== target.streamId
      ) {
        return fail(`普通往返不成立：${json(plain)}`);
      }
      if (
        plainBody.projection.status !== "native" ||
        plainBody.projection.missingCapabilities.length !== 0 ||
        plainBody.attachments.length !== 0 ||
        plainBody.interaction !== null
      ) {
        return fail(`普通回复的投影/附件/交互形状不对：${json(plainBody)}`);
      }

      const plainWire = (await driver.readRawWire(target.bindingId)).at(-1);
      if (plainWire === undefined || plainWire.responseKind !== "json") {
        return fail(`普通回复没有原始 JSON wire：${json(plainWire)}`);
      }
      const envelope = parseJsonEnvelope(plainWire.responseBody);
      if (envelope === null || envelope.object !== "chat.completion") {
        return fail(`普通回复不是标准 completion envelope：${plainWire.responseBody}`);
      }
      const choice = envelope.choices[0];
      if (
        envelope.id !== plainBody.id ||
        envelope.model !== target.serverModel ||
        envelope.choices.length !== 1 ||
        choice?.index !== 0 ||
        choice.message?.role !== "assistant" ||
        jsonContent(choice.message?.content) !== plainBody.text ||
        choice.finish_reason !== "stop"
      ) {
        return fail(
          `归一化正文与 wire 不对应或 envelope/choices 形状不对：${plainWire.responseBody}`,
        );
      }
      if (
        envelope.mist.stream_id !== plainBody.streamId ||
        envelope.mist.stream_id !== target.streamId ||
        json(wireAttachments(envelope.mist.attachments)) !== json(plainBody.attachments) ||
        envelope.mist.interaction !== null ||
        json(wireProjection(envelope.mist.projection)) !== json(plainBody.projection)
      ) {
        return fail(`普通回复的 mist 扩展与归一化值不对应：${plainWire.responseBody}`);
      }
      const lastMessage = lastRequestMessage(plainWire.requestBody);
      if (lastMessage?.role !== "user" || jsonContent(lastMessage.content) !== "turn:plain") {
        return fail(`请求体末尾不是当前 user turn：${plainWire.requestBody}`);
      }

      // —— 流式往返 ——
      const streamText = "reply:stream";
      await driver.queueResidentReply(target.bindingId, { kind: "text", text: streamText });
      const streamed = await driver.sendCompletion(
        target.bindingId,
        authorized(target),
        request("turn:stream", { stream: true }),
      );
      const streamedBody = bodyOf(streamed);
      const reconstructed = streamed.chunks.map((chunk) => chunk.textDelta).join("");
      const doneCount = streamed.chunks.filter((chunk) => chunk.done).length;
      if (
        streamedBody === null ||
        streamedBody.text !== streamText ||
        reconstructed !== streamText ||
        doneCount !== 1
      ) {
        return fail(`流式投影没有重建同一完整回复：${json(streamed)}`);
      }

      const streamWire = (await driver.readRawWire(target.bindingId)).at(-1);
      if (streamWire === undefined || streamWire.responseKind !== "sse") {
        return fail(`流式回复没有原始 SSE wire：${json(streamWire)}`);
      }
      const sse = parseSse(streamWire.responseBody);
      if (sse.malformedCount !== 0 || sse.doneCount !== 1) {
        return fail(`SSE 分词或 [DONE] 不唯一：${streamWire.responseBody}`);
      }
      const terminal = sse.frames.filter((frame) => frame.choices[0]?.finish_reason != null);
      if (terminal.length !== 1 || terminal[0]?.choices[0]?.finish_reason !== "stop") {
        return fail(`SSE 的 finish_reason 不是恰好一次 stop：${streamWire.responseBody}`);
      }
      const streamDelta = sse.frames
        .map((frame) => jsonContent(frame.choices[0]?.delta?.content) ?? "")
        .join("");
      if (
        streamDelta !== streamedBody.text ||
        !sse.frames.some((frame) => frame.choices[0]?.delta?.role === "assistant") ||
        terminal[0] !== sse.frames.at(-1) ||
        sse.frames.some(
          (frame) =>
            frame.object !== "chat.completion.chunk" ||
            frame.model !== target.serverModel ||
            frame.id !== streamedBody.id ||
            frame.choices.length !== 1 ||
            frame.choices[0]?.index !== 0 ||
            typeof frame.choices[0]?.delta !== "object" ||
            frame.choices[0]?.delta === null ||
            (frame.choices[0]?.delta?.role !== undefined &&
              frame.choices[0]?.delta?.role !== "assistant"),
        )
      ) {
        return fail(`SSE chunk 与归一化正文不对应或 envelope 形状不对：${streamWire.responseBody}`);
      }
      const mistFrames = sse.frames.filter((frame) => Object.keys(frame.mist).length > 0);
      const terminalMist = mistFrames[0]?.mist;
      if (
        mistFrames.length !== 1 ||
        streamedBody.streamId !== target.streamId ||
        !streamMistMatches(terminalMist, streamedBody)
      ) {
        return fail(`流式 mist 扩展不是恰好一份且与归一化值不对应：${streamWire.responseBody}`);
      }

      // —— canonical：每个 turn 恰好一份，writer 唯一 ——
      const events = await driver.readCanonicalEvents(target.bindingId);
      const texts = textEvents(events.slice(seededCount));
      const expectedTexts = [
        { kind: "user", text: "turn:plain" },
        { kind: "assistant", text: plainText },
        { kind: "user", text: "turn:stream" },
        { kind: "assistant", text: streamText },
      ];
      if (json(texts) !== json(expectedTexts)) {
        return fail(`本轮文本事件 kind/正文/顺序不对：${json(texts)}`);
      }
      const wrongWriter = events.find((event) => event.writerId !== target.canonicalWriterId);
      if (wrongWriter !== undefined) {
        return fail(`adapter 绕过唯一 writer：${json(wrongWriter)}`);
      }

      // 非空附件/选项的流式正例已按主笔裁定（#218 2026-10-08 拆分）整段迁到 FE-05；
      // 本步 D31-1 只交文字聊天，FE-02 只核普通/流式纯文本。

      // —— Open WebUI utility task：显式 task hint 只能用来拒绝 ——
      //
      // 只核文本不够：utility 请求带 inline 附件时，adapter 必须先识别出 utility task，
      // 在解析/持久化附件之前就拒绝——不能在拒绝之前先把附件字节落进私有附件面，
      // 再靠 canonical 数为零冒充零副作用。这里逐字比对 model/canonical/control/
      // 私有附件完整读回的 before/after。
      const utilitySnapshot = async () => ({
        turns: await driver.readModelTurns(target.bindingId),
        events: await driver.readCanonicalEvents(target.bindingId),
        interactions: await driver.readInteractions(target.bindingId),
        attachments: await driver.readAttachmentWrites(),
      });
      const beforeUtility = await utilitySnapshot();
      const utilityRequest = request("__task__: generate a title", {
        taskKind: "title-generation",
      });
      utilityRequest.messages[0] = {
        role: "user",
        content: [
          { type: "text", text: "__task__: generate a title" },
          { type: "file", file: { filename: "utility-in.txt", file_data: "c3ludGhldGlj" } },
        ],
      };
      const utility = await driver.sendCompletion(
        target.bindingId,
        authorized(target),
        utilityRequest,
      );
      if (utility.status === 200 || utility.error?.code !== "MIST_UTILITY_REQUEST_UNSUPPORTED") {
        return fail(`utility task 没有被稳定拒绝：${json(utility)}`);
      }
      const afterUtility = await utilitySnapshot();
      if (json(beforeUtility) !== json(afterUtility)) {
        return fail(
          `utility 拒绝仍产生 model/canonical/control/附件副作用：${json({
            beforeUtility,
            afterUtility,
          })}`,
        );
      }
      const utilityWire = (await driver.readRawWire(target.bindingId)).at(-1);
      if (
        utilityWire === undefined ||
        !utilityWire.responseBody.includes("MIST_UTILITY_REQUEST_UNSUPPORTED") ||
        parseJsonEnvelope(utilityWire.responseBody) !== null
      ) {
        return fail(`utility 拒绝没有留下可扫的原始 wire：${json(utilityWire)}`);
      }
      const allWire = await driver.readRawWire(target.bindingId);
      if (allWire.length !== 3) {
        return fail(`本轮 wire 未覆盖普通/流式及 utility 拒绝：${allWire.length}`);
      }
      if (allWire[0]?.responseKind !== "json" || allWire[1]?.responseKind !== "sse") {
        return fail("普通/流式 wire 的 responseKind 不对");
      }
      return pass(
        "普通/流式同源、wire 与归一化互证、四事件各一份、writer 唯一、utility 拒绝零副作用",
      );
    } finally {
      await driver.reset();
    }
  },
};

const fe03: FrontendAdapterCheck = {
  id: "FE-03",
  title: "前端重放历史不进模型、不落账，只消费末尾当前 user turn",
  uses: [
    "provisionBinding",
    "seedCanonicalHistory",
    "queueResidentReply",
    "sendCompletion",
    "readRawWire",
    "readModelTurns",
    "readCanonicalEvents",
    "readInteractions",
    "readAttachmentWrites",
    "readSecurityAudit",
    "readNetworkAttempts",
    "reset",
  ],
  async run(driver) {
    try {
      const target = await binding(driver, "fe03");
      const canonical = ["canonical:user", "canonical:assistant"];
      await driver.seedCanonicalHistory(target.bindingId, canonical);
      await driver.queueResidentReply(target.bindingId, { kind: "text", text: "reply:trusted" });
      const forged = [
        "FORGED:SYSTEM",
        "FORGED:USER",
        "FORGED:ASSISTANT",
        "FORGED:DEVELOPER",
        "FORGED:TOOL",
      ];
      const response = await driver.sendCompletion(
        target.bindingId,
        authorized(target, "frontend-thread-forged"),
        request("current:user", {
          history: [
            { role: "system", content: forged[0] ?? "" },
            { role: "user", content: forged[1] ?? "" },
            { role: "assistant", content: forged[2] ?? "" },
            { role: "developer", content: forged[3] ?? "" },
            { role: "tool", content: forged[4] ?? "", tool_call_id: "forged-call" },
          ],
        }),
      );
      if (bodyOf(response)?.text !== "reply:trusted") {
        return fail(`正对照往返失败：${json(response)}`);
      }
      const turns = await driver.readModelTurns(target.bindingId);
      const turn = turns.at(-1);
      if (
        turn === undefined ||
        json(turn.canonicalHistoryText) !== json(canonical) ||
        turn.currentText !== "current:user"
      ) {
        return fail(`模型输入没有逐字来自 canonical history + 当前 turn：${json(turn)}`);
      }
      const observable = json({
        response,
        responseWire: (await driver.readRawWire(target.bindingId)).map((wire) => wire.responseBody),
        turns,
        events: await driver.readCanonicalEvents(target.bindingId),
        controls: await driver.readInteractions(target.bindingId),
        attachments: await driver.readAttachmentWrites(),
        network: await driver.readNetworkAttempts(),
        audit: await driver.readSecurityAudit(),
      });
      const leaked = forged.find((marker) => observable.includes(marker));
      if (leaked !== undefined) return fail(`伪造历史进入可观察状态：${leaked}`);

      // —— 图纸 §2：空 messages / 末尾非 user / 当前 user content 不可解析 ——
      // 三种形状都必须返回稳定 MIST_INVALID_TURN_SHAPE，且 model/canonical/control/
      // 私有附件零副作用。不能用类型断言把实现错误藏过去。
      const snapshot = async () => ({
        turns: await driver.readModelTurns(target.bindingId),
        events: await driver.readCanonicalEvents(target.bindingId),
        interactions: await driver.readInteractions(target.bindingId),
        attachments: await driver.readAttachmentWrites(),
      });
      const unparseableContent = [
        { type: "audio", audio: { data: "AAAA" } },
      ] as unknown as FrontendChatRequest["messages"][number]["content"];
      const invalidShapes: Array<{ label: string; request: FrontendChatRequest }> = [
        {
          label: "empty-messages",
          request: {
            model: "client-selected-model",
            stream: false,
            messages: [],
            mist: { client: { surface: "acceptance-fixture", capabilities: [] } },
          },
        },
        {
          label: "last-not-user",
          request: {
            model: "client-selected-model",
            stream: false,
            messages: [
              { role: "user", content: "earlier" },
              { role: "assistant", content: "not a new user turn" },
            ],
            mist: { client: { surface: "acceptance-fixture", capabilities: [] } },
          },
        },
        {
          label: "unparseable-user-content",
          request: {
            model: "client-selected-model",
            stream: false,
            messages: [{ role: "user", content: unparseableContent }],
            mist: { client: { surface: "acceptance-fixture", capabilities: [] } },
          },
        },
      ];
      for (const shape of invalidShapes) {
        const before = await snapshot();
        const wireBefore = (await driver.readRawWire(target.bindingId)).length;
        const denied = await driver.sendCompletion(
          target.bindingId,
          authorized(target),
          shape.request,
        );
        if (denied.status !== 400 || denied.error?.code !== "MIST_INVALID_TURN_SHAPE") {
          return fail(`${shape.label} 没有返回稳定 MIST_INVALID_TURN_SHAPE：${json(denied)}`);
        }
        const after = await snapshot();
        if (json(before) !== json(after)) {
          return fail(`${shape.label} 的拒绝产生了 model/canonical/control/附件副作用`);
        }
        const wires = await driver.readRawWire(target.bindingId);
        if (
          wires.length !== wireBefore + 1 ||
          !wires.at(-1)?.responseBody.includes("MIST_INVALID_TURN_SHAPE")
        ) {
          return fail(`${shape.label} 的拒绝没有留下可扫的原始 wire：${json(wires.at(-1))}`);
        }
      }
      return pass(
        "请求前缀历史被丢弃；空 messages / 末尾非 user / 不可解析 content 均稳定拒绝且零副作用",
      );
    } finally {
      await driver.reset();
    }
  },
};

const fe04: FrontendAdapterCheck = {
  id: "FE-04",
  title: "model、conversation id 与 user 字段都不能分流或改绑住户",
  uses: [
    "provisionBinding",
    "queueResidentReply",
    "sendCompletion",
    "readRawWire",
    "readModelTurns",
    "readCanonicalEvents",
    "reset",
  ],
  async run(driver) {
    try {
      const target = await binding(driver, "fe04");
      const beforeFirstEvents = await driver.readCanonicalEvents(target.bindingId);
      const beforeFirstTurns = await driver.readModelTurns(target.bindingId);
      await driver.queueResidentReply(target.bindingId, { kind: "text", text: "reply:a" });
      const firstRequest = request("turn:a", { model: "model-a" });
      firstRequest.user = "client-user-a";
      firstRequest.metadata = { thread: "a" };
      const first = await driver.sendCompletion(
        target.bindingId,
        authorized(target, "conversation-a"),
        firstRequest,
      );

      const afterFirstEvents = await driver.readCanonicalEvents(target.bindingId);
      const afterFirstTurns = await driver.readModelTurns(target.bindingId);
      await driver.queueResidentReply(target.bindingId, { kind: "text", text: "reply:b" });
      const secondRequest = request("turn:b", { model: "model-b" });
      secondRequest.user = "client-user-b";
      secondRequest.metadata = { thread: "b" };
      const second = await driver.sendCompletion(
        target.bindingId,
        authorized(target, "conversation-b"),
        secondRequest,
      );

      const firstBody = bodyOf(first);
      const secondBody = bodyOf(second);
      if (
        firstBody === null ||
        secondBody === null ||
        firstBody.streamId !== target.streamId ||
        secondBody.streamId !== target.streamId ||
        firstBody.text !== "reply:a" ||
        secondBody.text !== "reply:b" ||
        firstBody.model !== target.serverModel ||
        secondBody.model !== target.serverModel
      ) {
        return fail(`客户端路由字段改变了服务端目标：${json({ first, second })}`);
      }
      // 客户端 model 不许回显成真实路由：响应 wire 必须是 server-owned route。
      for (const exchange of await driver.readRawWire(target.bindingId)) {
        if (
          exchange.responseBody.includes('"model-a"') ||
          exchange.responseBody.includes('"model-b"')
        ) {
          return fail(`响应回显了客户端 model：${exchange.responseBody}`);
        }
      }
      const afterSecondEvents = await driver.readCanonicalEvents(target.bindingId);
      const afterSecondTurns = await driver.readModelTurns(target.bindingId);
      const rounds = [
        {
          label: "a",
          events: addedEvents(beforeFirstEvents, afterFirstEvents),
          turns: afterFirstTurns.slice(beforeFirstTurns.length),
        },
        {
          label: "b",
          events: addedEvents(afterFirstEvents, afterSecondEvents),
          turns: afterSecondTurns.slice(afterFirstTurns.length),
        },
      ];
      for (const round of rounds) {
        const expected = [
          { kind: "user", text: `turn:${round.label}` },
          { kind: "assistant", text: `reply:${round.label}` },
        ];
        if (
          !ownedEvents(target, round.events) ||
          json(textEvents(round.events)) !== json(expected) ||
          round.turns.length !== 1 ||
          round.turns[0]?.residentId !== target.residentId ||
          round.turns[0]?.scopeId !== target.scopeId ||
          round.turns[0]?.currentText !== `turn:${round.label}`
        ) {
          return fail(
            `请求 ${round.label} 的新增 canonical/model 归属、正文或顺序不对：${json(round)}`,
          );
        }
      }
      return pass("两组 model/user/conversation 字段仍绑定同一 resident、scope 与主流");
    } finally {
      await driver.reset();
    }
  },
};

const fe05: FrontendAdapterCheck = {
  id: "FE-05",
  title: "附件与阻断交互保留结构；不支持的前端收到可审计降级而非文本冒充",
  uses: [
    "provisionBinding",
    "seedCanonicalHistory",
    "queueResidentReply",
    "sendCompletion",
    "readRawWire",
    "readModelTurns",
    "readCanonicalEvents",
    "readInteractions",
    "readAttachmentWrites",
    "readNetworkAttempts",
    "runWebuiCommand",
    "sendWebuiCompletion",
    "reset",
  ],
  async run(driver) {
    try {
      const target = await binding(driver, "fe05");
      const other = await binding(driver, "fe05-other");
      await driver.seedCanonicalHistory(target.bindingId, ["earlier:user", "earlier:assistant"]);

      /** 本轮给定 canonical 事件必须全部归属 target 的 writer/resident/scope/stream。 */
      const allOwned = (
        events: Awaited<ReturnType<FrontendAdapterDriver["readCanonicalEvents"]>>,
      ): boolean =>
        events.every(
          (event) =>
            event.writerId === target.canonicalWriterId &&
            event.residentId === target.residentId &&
            event.scopeId === target.scopeId &&
            event.streamId === target.streamId,
        );

      // —— native 附件：body / wire(json) / canonical / 附件面 四处完整结构互证 ——
      const outboundAttachment = attachment("outbound-native");
      await driver.queueResidentReply(target.bindingId, {
        kind: "attachment",
        text: "native attachment reply",
        attachments: [outboundAttachment],
      });
      const nativeRequest = request("attachment ingress", { capabilities: ["attachments"] });
      nativeRequest.messages[0] = {
        role: "user",
        content: [
          { type: "text", text: "attachment ingress" },
          { type: "file", file: { filename: "inbound.txt", file_data: "aGVsbG8=" } },
        ],
      };
      const beforeNativeEvents = await driver.readCanonicalEvents(target.bindingId);
      const writesBefore = (await driver.readAttachmentWrites()).count;
      const native = await driver.sendCompletion(
        target.bindingId,
        authorized(target),
        nativeRequest,
      );
      const nativeBody = bodyOf(native);
      const ingress = (await driver.readModelTurns(target.bindingId))[0]?.attachments[0];
      if (
        ingress === undefined ||
        ingress.attachmentId.length === 0 ||
        ingress.mediaType.length === 0
      ) {
        return fail("入站附件缺少宿主签发的 opaque id 或媒体类型");
      }
      const inboundAttachment: StructuredAttachment = {
        attachmentId: ingress.attachmentId,
        kind: "file",
        filename: "inbound.txt",
        mediaType: ingress.mediaType,
        sizeBytes: 5,
        source: "inline",
      };
      if (!sameAttachment(ingress, inboundAttachment)) return fail("入站附件元数据与原始内容不符");
      if (
        nativeBody === null ||
        nativeBody.projection.status !== "native" ||
        nativeBody.attachments.length !== 1 ||
        !sameAttachment(nativeBody.attachments[0], outboundAttachment)
      ) {
        return fail(`支持附件的前端没有拿到完整结构化附件：${json(native)}`);
      }
      const nativeWire = (await driver.readRawWire(target.bindingId)).at(-1);
      const nativeEnvelope =
        nativeWire === undefined ? null : parseJsonEnvelope(nativeWire.responseBody);
      if (
        nativeWire === undefined ||
        nativeEnvelope === null ||
        json(wireAttachments(nativeEnvelope.mist.attachments)) !== json([outboundAttachment]) ||
        nativeEnvelope.mist.interaction !== null
      ) {
        return fail(`native 附件 wire 扩展不完整或与归一化不符：${json(nativeWire)}`);
      }
      const writesAfterNative = await driver.readAttachmentWrites();
      const fe05Owner = {
        bindingId: target.bindingId,
        residentId: target.residentId,
        scopeId: target.scopeId,
        streamId: target.streamId,
        writerId: target.canonicalWriterId,
      };
      if (
        writesAfterNative.count !== writesBefore + 2 ||
        !writesAfterNative.records.some((record) =>
          sameAttachmentWrite(record, inboundAttachment, fe05Owner),
        ) ||
        !writesAfterNative.records.some((record) =>
          sameAttachmentWrite(record, outboundAttachment, fe05Owner),
        )
      ) {
        return fail(`附件面写入记录与声明结构/归属不符：${json(writesAfterNative)}`);
      }
      const afterNativeEvents = await driver.readCanonicalEvents(target.bindingId);
      const ingressEvent = afterNativeEvents.find(
        (event) =>
          event.kind === "attachment" &&
          event.attachment?.attachmentId === inboundAttachment.attachmentId,
      );
      const outboundEvent = afterNativeEvents.find(
        (event) =>
          event.kind === "attachment" &&
          event.attachment?.attachmentId === outboundAttachment.attachmentId,
      );
      if (
        !sameAttachment(ingressEvent?.attachment, inboundAttachment) ||
        !sameAttachment(outboundEvent?.attachment, outboundAttachment) ||
        !allOwned([ingressEvent, outboundEvent].filter((event) => event !== undefined))
      ) {
        return fail(`canonical 附件事件缺少完整结构或归属不对：${json(afterNativeEvents)}`);
      }
      if (!projectionMatchesRound(target, nativeBody, beforeNativeEvents, afterNativeEvents)) {
        return fail(`native 投影未引用本轮记录或遗漏呈现结构：${json(nativeBody.projection)}`);
      }

      // —— degraded 附件：结构保留、投影降级、正文不冒充 ——
      const degradedAttachment = attachment("outbound-degraded");
      await driver.queueResidentReply(target.bindingId, {
        kind: "attachment",
        text: "attachment unavailable on this surface",
        attachments: [degradedAttachment],
      });
      const degraded = await driver.sendCompletion(
        target.bindingId,
        authorized(target),
        request("generic attachment surface"),
      );
      const degradedBody = bodyOf(degraded);
      if (
        degradedBody === null ||
        degradedBody.projection.status !== "degraded" ||
        !degradedBody.projection.missingCapabilities.includes("attachments") ||
        !sameAttachment(degradedBody.attachments[0], degradedAttachment)
      ) {
        return fail(`附件降级丢掉了完整结构或收据：${json(degraded)}`);
      }
      const degradedWire = (await driver.readRawWire(target.bindingId)).at(-1);
      const degradedEnvelope =
        degradedWire === undefined ? null : parseJsonEnvelope(degradedWire.responseBody);
      if (
        degradedEnvelope === null ||
        json(wireAttachments(degradedEnvelope.mist.attachments)) !== json([degradedAttachment]) ||
        json(wireProjection(degradedEnvelope.mist.projection)) !== json(degradedBody.projection)
      ) {
        return fail(`degraded 附件 wire 扩展与归一化不符：${json(degradedWire)}`);
      }
      if (/data:|aGVsbG8=|\[attachment\]|!\[[^\]]*\]\(/i.test(degradedBody.text)) {
        return fail(`附件被伪装成正文标记或内联字节：${degradedBody.text}`);
      }

      // —— 远程 image_url：禁止 SSRF 代抓，拒绝后 network/model/canonical/control/附件零副作用 ——
      //
      // 图纸 §4.1：任意 http(s) URL 不由 adapter 代抓。这里用非真实网络的 remote URL 反例，
      // 并从 network attempt 读口核「实现真的没发起远程抓取」，而不是相信它的自声明。
      const remoteSnapshot = async () => ({
        turns: await driver.readModelTurns(target.bindingId),
        events: await driver.readCanonicalEvents(target.bindingId),
        interactions: await driver.readInteractions(target.bindingId),
        attachments: await driver.readAttachmentWrites(),
        network: await driver.readNetworkAttempts(),
      });
      const remoteUrl = "https://images.example.invalid/private.png?token=leak-me";
      const remoteRequest = request("remote image ingress");
      remoteRequest.messages[0] = {
        role: "user",
        content: [
          { type: "text", text: "remote image ingress" },
          { type: "image_url", image_url: { url: remoteUrl } },
        ],
      };
      const remoteBefore = await remoteSnapshot();
      const remoteWireBefore = (await driver.readRawWire(target.bindingId)).length;
      const remote = await driver.sendCompletion(
        target.bindingId,
        authorized(target),
        remoteRequest,
      );
      if (remote.status === 200 || remote.error?.code !== "MIST_REMOTE_URL_UNSUPPORTED") {
        return fail(`远程 image_url 没有被稳定拒绝：${json(remote)}`);
      }
      const remoteAfter = await remoteSnapshot();
      if (json(remoteBefore) !== json(remoteAfter)) {
        return fail(
          `远程 image_url 拒绝仍产生 network/model/canonical/control/附件副作用：${json({
            remoteBefore,
            remoteAfter,
          })}`,
        );
      }
      if (remoteBefore.network.attempts !== 0 || remoteAfter.network.attempts !== 0) {
        return fail(`远程抓取尝试读口不是从零开始：${json(remoteBefore.network)}`);
      }
      const remoteWires = await driver.readRawWire(target.bindingId);
      const remoteWire = remoteWires.at(-1);
      if (
        remoteWires.length !== remoteWireBefore + 1 ||
        remoteWire === undefined ||
        !remoteWire.responseBody.includes("MIST_REMOTE_URL_UNSUPPORTED") ||
        remoteWire.responseBody.includes("images.example.invalid") ||
        remoteWire.requestBody.includes(target.token)
      ) {
        return fail(`远程拒绝没有留下合规的原始 wire（或不许回显 URL）：${json(remoteWire)}`);
      }
      const remoteObservable = json({
        turns: remoteAfter.turns,
        events: remoteAfter.events,
        interactions: remoteAfter.interactions,
        attachments: remoteAfter.attachments,
      });
      if (
        remoteObservable.includes("images.example.invalid") ||
        remoteObservable.includes("leak-me")
      ) {
        return fail("远程 URL 原文或查询串进入了可观察状态");
      }

      // —— native choice：结构完整、wire 完整、待决 ——
      const nativeChoice = interaction("native-choice");
      await driver.queueResidentReply(target.bindingId, {
        kind: "interaction",
        text: "Choose one to continue.",
        interaction: nativeChoice,
      });
      const beforeChoiceEvents = await driver.readCanonicalEvents(target.bindingId);
      const choiceResponse = await driver.sendCompletion(
        target.bindingId,
        authorized(target),
        request("native choice surface", { capabilities: ["interactions"] }),
      );
      const choiceBody = bodyOf(choiceResponse);
      if (
        choiceBody === null ||
        choiceBody.projection.status !== "native" ||
        json(choiceBody.interaction) !== json(nativeChoice)
      ) {
        return fail(`native choice 没有保留完整交互结构：${json(choiceResponse)}`);
      }
      const choiceWire = (await driver.readRawWire(target.bindingId)).at(-1);
      const choiceEnvelope =
        choiceWire === undefined ? null : parseJsonEnvelope(choiceWire.responseBody);
      if (
        choiceEnvelope === null ||
        json(wireInteraction(choiceEnvelope.mist.interaction)) !== json(nativeChoice)
      ) {
        return fail(`native choice wire 交互扩展不完整：${json(choiceWire)}`);
      }
      const choiceEvents = (await driver.readCanonicalEvents(target.bindingId)).filter(
        (event) => event.interaction?.interactionId === nativeChoice.interactionId,
      );
      if (
        choiceEvents.length !== 1 ||
        json(choiceEvents[0]?.interaction) !== json(nativeChoice) ||
        !allOwned(choiceEvents)
      ) {
        return fail(`native choice canonical 事件缺少完整结构或归属不对：${json(choiceEvents)}`);
      }
      if (
        !projectionMatchesRound(
          target,
          choiceBody,
          beforeChoiceEvents,
          await driver.readCanonicalEvents(target.bindingId),
        )
      ) {
        return fail("native choice 投影遗漏本轮交互记录");
      }
      const choiceReadback = (await driver.readInteractions(target.bindingId)).find(
        (item) => item.interactionId === nativeChoice.interactionId,
      );
      if (
        !sameInteraction(choiceReadback, nativeChoice) ||
        choiceReadback?.status !== "pending" ||
        choiceReadback.resolvedOptionId !== null ||
        choiceReadback.resolutionEventId !== null
      ) {
        return fail(`native choice 初始状态不是待决：${json(choiceReadback)}`);
      }

      // —— 合法点击：原始请求 snake_case、不捏造 user turn、恰好一条可归属 resolution ——
      const chosenOption = nativeChoice.options[1];
      if (chosenOption === undefined) return fail("fixture 交互缺少第二个选项");
      const beforeClickEvents = await driver.readCanonicalEvents(target.bindingId);
      const turnsBeforeClick = (await driver.readModelTurns(target.bindingId)).length;
      const clickRequest = request("submit legal click", {
        capabilities: ["interactions"],
        controlOnly: true,
        interactionResponse: {
          interactionId: nativeChoice.interactionId,
          optionId: chosenOption.optionId,
        },
      });
      const click = await driver.sendCompletion(target.bindingId, authorized(target), clickRequest);
      if (bodyOf(click) === null) return fail(`合法点击被拒绝：${json(click)}`);
      const clickWire = (await driver.readRawWire(target.bindingId)).at(-1);
      const controlCommand =
        clickWire === undefined ? "missing" : requestInteractionResponse(clickWire.requestBody);
      if (
        controlCommand === "missing" ||
        controlCommand === "malformed" ||
        controlCommand.interaction_id !== nativeChoice.interactionId ||
        controlCommand.option_id !== chosenOption.optionId
      ) {
        return fail(`控制响应原始请求不是 snake_case interaction_response：${json(clickWire)}`);
      }
      const clickMessages = lastRequestMessage(clickWire?.requestBody ?? "");
      void clickMessages;
      let parsedClickRequest: { messages?: unknown[] } | null = null;
      try {
        parsedClickRequest = JSON.parse(clickWire?.requestBody ?? "") as { messages?: unknown[] };
      } catch {
        parsedClickRequest = null;
      }
      if (parsedClickRequest === null || (parsedClickRequest.messages?.length ?? -1) !== 0) {
        return fail(`控制响应捏造了 user turn：${json(clickWire)}`);
      }
      const clickEvents = (await driver.readCanonicalEvents(target.bindingId)).slice(
        beforeClickEvents.length,
      );
      if (
        clickEvents.length !== 1 ||
        clickEvents[0]?.kind !== "interaction" ||
        clickEvents[0]?.interaction?.interactionId !== nativeChoice.interactionId ||
        !allOwned(clickEvents) ||
        (await driver.readModelTurns(target.bindingId)).length !== turnsBeforeClick
      ) {
        return fail(`合法点击没有恰好新增一条可归属 resolution：${json(clickEvents)}`);
      }
      const resolvedReadback = (await driver.readInteractions(target.bindingId)).find(
        (item) => item.interactionId === nativeChoice.interactionId,
      );
      if (
        resolvedReadback?.status !== "resolved" ||
        resolvedReadback.resolvedOptionId !== chosenOption.optionId ||
        resolvedReadback.resolutionEventId !== clickEvents[0]?.eventId ||
        clickEvents[0]?.resolvedOptionId !== chosenOption.optionId
      ) {
        return fail(
          `合法点击没有耐久地落到 resolved 且带明确 chosenOption：${json(resolvedReadback)}`,
        );
      }

      // —— 负例：拒绝必须零副作用，且不许动任一 binding 的任何状态 ——
      const wrongId = interaction("wrong-id");
      await driver.queueResidentReply(target.bindingId, {
        kind: "interaction",
        text: "pending for wrong-id",
        interaction: wrongId,
      });
      await driver.sendCompletion(
        target.bindingId,
        authorized(target),
        request("pending wrong-id", { capabilities: ["interactions"] }),
      );
      const foreign = interaction("foreign-choice");
      await driver.queueResidentReply(other.bindingId, {
        kind: "interaction",
        text: "pending on other binding",
        interaction: foreign,
      });
      await driver.sendCompletion(
        other.bindingId,
        authorized(other),
        request("pending other binding", { capabilities: ["interactions"] }),
      );
      /** 捕获两个 binding 的全部可观察状态，用于「拒绝零副作用」的严谨比对。 */
      const snapshot = async () => ({
        target: {
          turns: await driver.readModelTurns(target.bindingId),
          events: await driver.readCanonicalEvents(target.bindingId),
          interactions: await driver.readInteractions(target.bindingId),
        },
        other: {
          turns: await driver.readModelTurns(other.bindingId),
          events: await driver.readCanonicalEvents(other.bindingId),
          interactions: await driver.readInteractions(other.bindingId),
        },
        attachments: await driver.readAttachmentWrites(),
      });
      const refusals: Array<{ label: string; req: FrontendChatRequest }> = [
        {
          label: "wrong-interaction-id",
          req: request("bad id", {
            capabilities: ["interactions"],
            controlOnly: true,
            interactionResponse: {
              interactionId: "interaction:nope",
              optionId: wrongId.options[0]?.optionId ?? "x",
            },
          }),
        },
        {
          label: "wrong-option",
          req: request("bad option", {
            capabilities: ["interactions"],
            controlOnly: true,
            interactionResponse: {
              interactionId: wrongId.interactionId,
              optionId: "not-an-option",
            },
          }),
        },
        {
          label: "other-binding-response",
          req: request("foreign response", {
            capabilities: ["interactions"],
            controlOnly: true,
            interactionResponse: {
              interactionId: foreign.interactionId,
              optionId: foreign.options[0]?.optionId ?? "x",
            },
          }),
        },
      ];
      for (const refusal of refusals) {
        const before = await snapshot();
        const denied = await driver.sendCompletion(
          target.bindingId,
          authorized(target),
          refusal.req,
        );
        if (denied.status === 200 || denied.error?.code !== "MIST_INTERACTION_RESPONSE_INVALID") {
          return fail(`${refusal.label} 没有被稳定拒绝：${json(denied)}`);
        }
        const after = await snapshot();
        if (json(before) !== json(after)) {
          return fail(`${refusal.label} 的拒绝改动了可观察状态：${json({ before, after })}`);
        }
      }
      const wrongStillPending = (await driver.readInteractions(target.bindingId)).find(
        (item) => item.interactionId === wrongId.interactionId,
      );
      if (wrongStillPending?.status !== "pending" || wrongStillPending.resolvedOptionId !== null) {
        return fail(`错误响应改掉了待决交互：${json(wrongStillPending)}`);
      }
      const foreignStillPending = (await driver.readInteractions(other.bindingId)).find(
        (item) => item.interactionId === foreign.interactionId,
      );
      if (foreignStillPending?.status !== "pending") {
        return fail(`另一 binding 的响应被错认：${json(foreignStillPending)}`);
      }

      // —— 重复响应：解析后重提同一响应必须被拒，且不产生第二次 resolution ——
      const beforeDuplicate = await snapshot();
      const duplicate = await driver.sendCompletion(
        target.bindingId,
        authorized(target),
        request("duplicate click", {
          capabilities: ["interactions"],
          controlOnly: true,
          interactionResponse: {
            interactionId: nativeChoice.interactionId,
            optionId: chosenOption.optionId,
          },
        }),
      );
      if (
        duplicate.status === 200 ||
        duplicate.error?.code !== "MIST_INTERACTION_RESPONSE_INVALID"
      ) {
        return fail(`重复响应没有被拒绝：${json(duplicate)}`);
      }
      const afterDuplicate = await snapshot();
      if (json(beforeDuplicate) !== json(afterDuplicate)) {
        return fail(`重复响应的拒绝改动了可观察状态：${json({ beforeDuplicate, afterDuplicate })}`);
      }
      const afterDuplicateReadback = (await driver.readInteractions(target.bindingId)).find(
        (item) => item.interactionId === nativeChoice.interactionId,
      );
      if (
        afterDuplicateReadback?.status !== "resolved" ||
        afterDuplicateReadback.resolvedOptionId !== chosenOption.optionId ||
        afterDuplicateReadback.resolutionEventId !== resolvedReadback.resolutionEventId
      ) {
        return fail(`重复响应产生了第二次 resolution：${json(afterDuplicateReadback)}`);
      }

      // —— 普通文字仍可聊天，但不解决 pending ——
      await driver.queueResidentReply(target.bindingId, { kind: "text", text: "plain chat" });
      const plainTurn = await driver.sendCompletion(
        target.bindingId,
        authorized(target),
        request("just chatting, not clicking", { capabilities: ["interactions"] }),
      );
      if (bodyOf(plainTurn)?.text !== "plain chat") {
        return fail(`普通文字 turn 失败：${json(plainTurn)}`);
      }
      const afterPlain = (await driver.readInteractions(target.bindingId)).find(
        (item) => item.interactionId === wrongId.interactionId,
      );
      if (afterPlain?.status !== "pending" || afterPlain.resolvedOptionId !== null) {
        return fail(`普通文字被猜成了点击：${json(afterPlain)}`);
      }

      // —— generic surface：结构可见、投影 blocked、状态待决 ——
      const blockedInteraction = interaction("surface-choice");
      await driver.queueResidentReply(target.bindingId, {
        kind: "interaction",
        text: "This surface cannot complete the pending interaction.",
        interaction: blockedInteraction,
      });
      const blocked = await driver.sendCompletion(
        target.bindingId,
        authorized(target),
        request("generic interaction surface"),
      );
      const blockedBody = bodyOf(blocked);
      if (
        blockedBody === null ||
        blockedBody.projection.status !== "blocked" ||
        !blockedBody.projection.missingCapabilities.includes("interactions") ||
        json(blockedBody.interaction) !== json(blockedInteraction)
      ) {
        return fail(`阻断交互没有保留结构或 blocked 收据：${json(blocked)}`);
      }
      const forbiddenText = blockedInteraction.options.flatMap((option) => [
        option.optionId,
        option.label,
      ]);
      if (
        forbiddenText.some((value) => blockedBody.text.includes(value)) ||
        /\[(option|blocked|approval)\]/i.test(blockedBody.text)
      ) {
        return fail(`交互被摊平成正文选项：${blockedBody.text}`);
      }
      const blockedReadback = (await driver.readInteractions(target.bindingId)).find(
        (item) => item.interactionId === blockedInteraction.interactionId,
      );
      if (
        !sameInteraction(blockedReadback, blockedInteraction) ||
        blockedReadback?.status !== "pending"
      ) {
        return fail(`generic blocked 交互结构或待决状态丢失：${json(blockedReadback)}`);
      }

      // —— native approval：正对照 + 点击解决到 resolved ——
      const nativeApproval = interaction("native-approval", "approval");
      await driver.queueResidentReply(target.bindingId, {
        kind: "interaction",
        text: "Approve to continue.",
        interaction: nativeApproval,
      });
      const beforeApprovalEvents = await driver.readCanonicalEvents(target.bindingId);
      const approvalResponse = await driver.sendCompletion(
        target.bindingId,
        authorized(target),
        request("native approval surface", { capabilities: ["interactions"] }),
      );
      const approvalBody = bodyOf(approvalResponse);
      if (
        approvalBody === null ||
        approvalBody.projection.status !== "native" ||
        json(approvalBody.interaction) !== json(nativeApproval)
      ) {
        return fail(`native approval 没有保留完整交互结构：${json(approvalResponse)}`);
      }
      if (
        !projectionMatchesRound(
          target,
          approvalBody,
          beforeApprovalEvents,
          await driver.readCanonicalEvents(target.bindingId),
        )
      ) {
        return fail("native approval 投影遗漏本轮交互记录");
      }
      const approvalReadback = (await driver.readInteractions(target.bindingId)).find(
        (item) => item.interactionId === nativeApproval.interactionId,
      );
      if (
        !sameInteraction(approvalReadback, nativeApproval) ||
        approvalReadback?.status !== "pending" ||
        approvalReadback.resolvedOptionId !== null ||
        approvalReadback.resolutionEventId !== null
      ) {
        return fail(`native approval 初始状态不是待决：${json(approvalReadback)}`);
      }
      const approveOption = nativeApproval.options[0];
      if (approveOption === undefined) return fail("fixture approval 缺少选项");
      const approveEventsBefore = (await driver.readCanonicalEvents(target.bindingId)).length;
      const approveTurnsBefore = (await driver.readModelTurns(target.bindingId)).length;
      const approve = await driver.sendCompletion(
        target.bindingId,
        authorized(target),
        request("approve", {
          capabilities: ["interactions"],
          controlOnly: true,
          interactionResponse: {
            interactionId: nativeApproval.interactionId,
            optionId: approveOption.optionId,
          },
        }),
      );
      if (bodyOf(approve) === null) return fail(`approval 合法点击被拒绝：${json(approve)}`);
      const approveEvents = (await driver.readCanonicalEvents(target.bindingId)).slice(
        approveEventsBefore,
      );
      const approvalResolved = (await driver.readInteractions(target.bindingId)).find(
        (item) => item.interactionId === nativeApproval.interactionId,
      );
      if (
        approveEvents.length !== 1 ||
        approveEvents[0]?.kind !== "interaction" ||
        json(approveEvents[0]?.interaction) !== json(nativeApproval) ||
        (await driver.readModelTurns(target.bindingId)).length !== approveTurnsBefore ||
        approveEvents[0]?.resolvedOptionId !== approveOption.optionId ||
        !allOwned(approveEvents) ||
        approvalResolved?.status !== "resolved" ||
        approvalResolved.resolvedOptionId !== approveOption.optionId ||
        approvalResolved.resolutionEventId !== approveEvents[0]?.eventId
      ) {
        return fail(
          `native approval 点击没有落到 resolved：${json({ approveEvents, approvalResolved })}`,
        );
      }

      // —— 流式附件 + interaction 扩展：SSE 结构也要完整 ——
      const streamAttachment = attachment("outbound-stream");
      await driver.queueResidentReply(target.bindingId, {
        kind: "attachment",
        text: "stream attachment reply",
        attachments: [streamAttachment],
      });
      const beforeStreamAttachmentEvents = await driver.readCanonicalEvents(target.bindingId);
      const streamNative = await driver.sendCompletion(
        target.bindingId,
        authorized(target),
        request("stream attachment surface", { stream: true, capabilities: ["attachments"] }),
      );
      const streamWire = (await driver.readRawWire(target.bindingId)).at(-1);
      if (streamWire === undefined || streamWire.responseKind !== "sse") {
        return fail(`流式附件没有 SSE wire：${json(streamWire)}`);
      }
      const streamMist = parseSse(streamWire.responseBody)
        .frames.map((frame) => frame.mist)
        .find((mist) => Object.keys(mist).length > 0);
      const streamAttachmentBody = bodyOf(streamNative);
      if (
        streamAttachmentBody === null ||
        streamMist === undefined ||
        json(wireAttachments(streamMist.attachments)) !== json([streamAttachment]) ||
        !projectionMatchesRound(
          target,
          streamAttachmentBody,
          beforeStreamAttachmentEvents,
          await driver.readCanonicalEvents(target.bindingId),
        )
      ) {
        return fail(`SSE mist 附件扩展不完整或与归一化不符：${json(streamWire)}`);
      }

      // —— 独立 stream interaction 正例（kind: blocked）：normalized/wire/canonical 逐字对齐 ——
      //
      // 流式回合不能只搬附件：interaction 的 options、reasonCode、投影关联与目标 writer/identity
      // 都要在归一化值、SSE wire 与 canonical 记录三处一致。这里用 kind: "blocked" 的可执行正例。
      const streamedInteraction: StructuredInteraction = {
        ...interaction("stream-blocked", "blocked"),
        reasonCode: "MIST_INTERACTION_BLOCKED_SURFACE",
      };
      await driver.queueResidentReply(target.bindingId, {
        kind: "interaction",
        text: "Streamed blocked interaction.",
        interaction: streamedInteraction,
      });
      const streamInteractionEventsBefore = await driver.readCanonicalEvents(target.bindingId);
      const streamInteractionResponse = await driver.sendCompletion(
        target.bindingId,
        authorized(target),
        request("stream interaction surface", { stream: true, capabilities: ["interactions"] }),
      );
      const streamInteractionBody = bodyOf(streamInteractionResponse);
      if (
        streamInteractionBody === null ||
        streamInteractionBody.projection.status !== "native" ||
        json(streamInteractionBody.interaction) !== json(streamedInteraction) ||
        streamInteractionBody.attachments.length !== 0
      ) {
        return fail(
          `流式 interaction 归一化结构不完整或与声明不符：${json(streamInteractionResponse)}`,
        );
      }
      const streamInteractionWire = (await driver.readRawWire(target.bindingId)).at(-1);
      if (streamInteractionWire === undefined || streamInteractionWire.responseKind !== "sse") {
        return fail(`流式 interaction 没有 SSE wire：${json(streamInteractionWire)}`);
      }
      const streamInteractionSse = parseSse(streamInteractionWire.responseBody);
      if (streamInteractionSse.malformedCount !== 0 || streamInteractionSse.doneCount !== 1) {
        return fail(
          `流式 interaction 的 SSE 分词或 [DONE] 不唯一：${streamInteractionWire.responseBody}`,
        );
      }
      const streamInteractionFrame = streamInteractionSse.frames.find(
        (frame) => Object.keys(frame.mist).length > 0,
      );
      if (
        streamInteractionFrame === undefined ||
        json(wireInteraction(streamInteractionFrame.mist.interaction)) !==
          json(streamedInteraction) ||
        json(wireProjection(streamInteractionFrame.mist.projection)) !==
          json(streamInteractionBody.projection) ||
        streamInteractionFrame.mist.stream_id !== target.streamId ||
        streamInteractionFrame.model !== target.serverModel ||
        streamInteractionFrame.id !== streamInteractionBody.id ||
        !streamInteractionSse.frames.some((frame) => frame.choices[0]?.delta?.role === "assistant")
      ) {
        return fail(
          `流式 interaction 的 SSE wire 与归一化/声明不对应：${json(streamInteractionWire)}`,
        );
      }
      const streamInteractionEvents = (await driver.readCanonicalEvents(target.bindingId)).slice(
        streamInteractionEventsBefore.length,
      );
      const streamedInteractionEvents = streamInteractionEvents.filter(
        (event) => event.interaction?.interactionId === streamedInteraction.interactionId,
      );
      if (
        streamedInteractionEvents.length !== 1 ||
        json(streamedInteractionEvents[0]?.interaction) !== json(streamedInteraction) ||
        !allOwned(streamedInteractionEvents)
      ) {
        return fail(
          `流式 interaction 的 canonical 记录结构/归属不对：${json(streamedInteractionEvents)}`,
        );
      }
      if (
        !projectionMatchesRound(
          target,
          streamInteractionBody,
          streamInteractionEventsBefore,
          await driver.readCanonicalEvents(target.bindingId),
        )
      ) {
        return fail(
          `流式 interaction 投影没有关联到本轮 canonical 记录：${json({
            events: streamInteractionEvents,
            projection: streamInteractionBody.projection,
          })}`,
        );
      }
      const streamedInteractionReadback = (await driver.readInteractions(target.bindingId)).find(
        (item) => item.interactionId === streamedInteraction.interactionId,
      );
      if (
        !sameInteraction(streamedInteractionReadback, streamedInteraction) ||
        streamedInteractionReadback?.status !== "pending"
      ) {
        return fail(`流式 interaction 耐久状态与声明不符：${json(streamedInteractionReadback)}`);
      }

      // —— 从 FE-02 迁入（#218 2026-10-08 拆分）：非空附件/选项的流式正例 ——
      // 结构通道随 FE-05 另开一单，判据不放松：SSE 的完整 mist 结构（附件/交互/投影）
      // 必须与非空归一化对象逐项对应，不能只靠空数组/null 冒充。
      const structuredStreams: Array<{ reply: ResidentReply; capabilities: ClientCapability[] }> = [
        {
          reply: {
            kind: "attachment",
            text: "structured attachment stream",
            attachments: [attachment("fe02-stream")],
          },
          capabilities: ["attachments"],
        },
        {
          reply: {
            kind: "interaction",
            text: "structured choice stream",
            interaction: interaction("fe02-stream-choice"),
          },
          capabilities: ["interactions"],
        },
      ];
      for (const scene of structuredStreams) {
        await driver.queueResidentReply(target.bindingId, scene.reply);
        const response = await driver.sendCompletion(
          target.bindingId,
          authorized(target),
          request(`turn:${scene.reply.kind}:stream`, {
            stream: true,
            capabilities: scene.capabilities,
          }),
        );
        const body = bodyOf(response);
        const wire = (await driver.readRawWire(target.bindingId)).at(-1);
        const parsed = wire === undefined ? null : parseSse(wire.responseBody);
        const frames = parsed?.frames.filter((frame) => Object.keys(frame.mist).length > 0) ?? [];
        if (
          body === null ||
          wire?.responseKind !== "sse" ||
          parsed?.malformedCount !== 0 ||
          parsed.doneCount !== 1 ||
          frames.length !== 1 ||
          !streamMistMatches(frames[0]?.mist, body) ||
          body.projection.status !== "native" ||
          json(body.attachments) !==
            json(scene.reply.kind === "attachment" ? scene.reply.attachments : []) ||
          json(body.interaction) !==
            json(scene.reply.kind === "interaction" ? scene.reply.interaction : null)
        ) {
          return fail(`迁移的 ${scene.reply.kind} 流式正例结构不对应：${json({ response, wire })}`);
        }
      }

      // —— 从 FE-07 迁入（#218 2026-10-08 拆分）：WebUI 入站 file + 出站 attachment 完整链路 ——
      // 原场景判据不放松：wire 扩展、四 canonical 事件、model/canonical/私有 bytes 互证、
      // 恰好两条私有写入与全部 owner 检查。需要先取得一个经 /webui 安装闸启动的服务。
      const webuiStart = await driver.runWebuiCommand(target.bindingId, {
        confirmed: true,
        environment: { docker: true, python: false },
      });
      if (
        webuiStart.status !== "started" ||
        webuiStart.serviceId === null ||
        webuiStart.endpointId !== target.endpointId
      ) {
        return fail(`迁移的 WebUI 场景无法取得同一 endpoint 的服务：${json(webuiStart)}`);
      }
      const webuiServiceId = webuiStart.serviceId;
      const webuiContext = {
        token: target.token,
        source: "loopback" as const,
        conversationId: webuiServiceId,
      };
      const webuiAttachment = attachment("webui-outbound");
      await driver.queueResidentReply(target.bindingId, {
        kind: "attachment",
        text: "from-webui",
        attachments: [webuiAttachment],
      });
      const webuiBefore = await driver.readCanonicalEvents(target.bindingId);
      const webuiWritesBefore = await driver.readAttachmentWrites();
      const webuiRequest = request("through webui", {
        capabilities: ["attachments", "interactions"],
      });
      webuiRequest.messages[0] = {
        role: "user",
        content: [
          { type: "text", text: "through webui" },
          { type: "file", file: { filename: "webui-in.txt", file_data: "aGVsbG8=" } },
        ],
      };
      const webuiResponse = await driver.sendWebuiCompletion(
        webuiServiceId,
        webuiContext,
        webuiRequest,
      );
      const webuiResponseBody = bodyOf(webuiResponse);
      if (
        webuiResponseBody === null ||
        webuiResponseBody.streamId !== target.streamId ||
        webuiResponseBody.model !== target.serverModel ||
        !sameAttachment(webuiResponseBody.attachments[0], webuiAttachment)
      ) {
        return fail(`迁移的 WebUI 往返没有走同一主流或附件结构不对：${json(webuiResponse)}`);
      }
      const webuiAfter = await driver.readCanonicalEvents(target.bindingId);
      const webuiNewEvents = webuiAfter.slice(webuiBefore.length);
      if (
        webuiNewEvents.length !== 4 ||
        webuiNewEvents[0]?.kind !== "user" ||
        webuiNewEvents[0]?.text !== "through webui" ||
        webuiNewEvents[1]?.kind !== "attachment" ||
        webuiNewEvents[2]?.kind !== "assistant" ||
        webuiNewEvents[2]?.text !== "from-webui" ||
        webuiNewEvents[3]?.kind !== "attachment" ||
        !webuiNewEvents.some(
          (event) => event.kind === "attachment" && event.attachment?.filename === "webui-in.txt",
        ) ||
        !webuiNewEvents.some(
          (event) =>
            event.kind === "attachment" &&
            event.attachment?.attachmentId === webuiAttachment.attachmentId,
        ) ||
        webuiNewEvents.some(
          (event) =>
            event.residentId !== target.residentId ||
            event.scopeId !== target.scopeId ||
            event.streamId !== target.streamId ||
            event.writerId !== target.canonicalWriterId,
        )
      ) {
        return fail(`迁移的 WebUI 往返没有恰好落同源事件（含附件）：${json(webuiNewEvents)}`);
      }
      const webuiWire = (await driver.readRawWire(target.bindingId)).at(-1);
      const webuiEnvelope =
        webuiWire === undefined ? null : parseJsonEnvelope(webuiWire.responseBody);
      if (
        webuiEnvelope === null ||
        webuiEnvelope.object !== "chat.completion" ||
        webuiEnvelope.id !== webuiResponseBody.id ||
        webuiEnvelope.choices.length !== 1 ||
        webuiEnvelope.choices[0]?.index !== 0 ||
        webuiEnvelope.choices[0]?.message?.role !== "assistant" ||
        webuiEnvelope.choices[0]?.message?.content !== "from-webui" ||
        webuiEnvelope.choices[0]?.finish_reason !== "stop" ||
        webuiEnvelope.model !== target.serverModel ||
        webuiEnvelope.mist.stream_id !== target.streamId ||
        json(wireProjection(webuiEnvelope.mist.projection)) !==
          json(webuiResponseBody.projection) ||
        webuiEnvelope.mist.interaction !== null ||
        json(wireAttachments(webuiEnvelope.mist.attachments)) !== json([webuiAttachment])
      ) {
        return fail(`迁移的 WebUI wire 没有回同主流且扩展完整：${json(webuiWire)}`);
      }
      const webuiWritesAfter = await driver.readAttachmentWrites();
      const webuiNewWrites = webuiWritesAfter.records.slice(webuiWritesBefore.count);
      const webuiOwner = {
        bindingId: target.bindingId,
        residentId: target.residentId,
        scopeId: target.scopeId,
        streamId: target.streamId,
        writerId: target.canonicalWriterId,
      };
      const webuiIngressTurnAttachment = (await driver.readModelTurns(target.bindingId)).find(
        (turn) => turn.currentText === "through webui",
      )?.attachments[0];
      const webuiIngressCanonicalAttachment = webuiNewEvents.find(
        (event) => event.kind === "attachment" && event.attachment?.filename === "webui-in.txt",
      )?.attachment;
      const webuiEgressCanonicalAttachment = webuiNewEvents.find(
        (event) =>
          event.kind === "attachment" &&
          event.attachment?.attachmentId === webuiAttachment.attachmentId,
      )?.attachment;
      if (
        webuiWritesAfter.count !== webuiWritesBefore.count + 2 ||
        webuiWritesAfter.records.length !== webuiWritesAfter.count ||
        webuiIngressTurnAttachment === undefined ||
        webuiIngressCanonicalAttachment === undefined ||
        webuiIngressTurnAttachment.kind !== "file" ||
        webuiIngressTurnAttachment.filename !== "webui-in.txt" ||
        webuiIngressTurnAttachment.source !== "inline" ||
        webuiIngressTurnAttachment.sizeBytes !== Buffer.from("aGVsbG8=", "base64").length ||
        !sameAttachment(webuiIngressCanonicalAttachment, webuiIngressTurnAttachment) ||
        !sameAttachment(webuiEgressCanonicalAttachment, webuiAttachment)
      ) {
        return fail(
          `迁移的 WebUI 入出站附件在 model turn / canonical 缺完整结构或真实字节数：${json({
            webuiIngressTurnAttachment,
            webuiIngressCanonicalAttachment,
            webuiEgressCanonicalAttachment,
          })}`,
        );
      }
      const webuiIngressWrite = webuiNewWrites.find((record) =>
        sameAttachmentWrite(record, webuiIngressTurnAttachment, webuiOwner),
      );
      const webuiEgressWrite = webuiNewWrites.find((record) =>
        sameAttachmentWrite(record, webuiAttachment, webuiOwner),
      );
      if (
        webuiIngressWrite === undefined ||
        webuiEgressWrite === undefined ||
        webuiNewWrites.length !== 2 ||
        !sameAttachment(webuiEgressWrite, webuiAttachment)
      ) {
        return fail(
          `迁移的 WebUI 私有附件面写入不是恰好入站/出站两条且占位/归属对不上：${json({
            webuiWritesBefore,
            webuiWritesAfter,
            webuiNewEvents,
          })}`,
        );
      }

      const turns = await driver.readModelTurns(target.bindingId);
      const firstTurn = turns.find((turn) => turn.currentText === "attachment ingress");
      const genericTurns = turns.filter(
        (turn) =>
          turn.currentText === "generic attachment surface" ||
          turn.currentText === "generic interaction surface",
      );
      if (
        firstTurn === undefined ||
        !sameAttachment(firstTurn.attachments[0], inboundAttachment) ||
        !firstTurn.surfaceCapabilities.includes("attachments") ||
        genericTurns.length !== 2 ||
        genericTurns.some((turn) => turn.surfaceCapabilities.length !== 0)
      ) {
        return fail(`住户没有拿到真实 surface capability 或完整附件：${json(turns)}`);
      }

      const events = await driver.readCanonicalEvents(target.bindingId);
      if (json(events).includes("aGVsbG8=")) return fail("附件原始字节进入 canonical stream");
      if (!allOwned(events))
        return fail("canonical 事件归属不属于目标 writer/resident/scope/stream");
      if (
        !events.some(
          (event) => event.kind === "surface-projection" && event.projection?.status === "blocked",
        )
      ) {
        return fail("住户侧没有可读的 blocked surface projection");
      }
      return pass(
        "附件/交互完整结构、wire(json+SSE)、canonical 归属、choice/approval resolved 与五类拒绝零副作用同时成立",
      );
    } finally {
      await driver.reset();
    }
  },
};

const fe06: FrontendAdapterCheck = {
  id: "FE-06",
  title: "Bearer token 默认强制；loopback 不豁免，失败零副作用且不泄密",
  uses: [
    "provisionBinding",
    "queueResidentReply",
    "sendCompletion",
    "readRawWire",
    "readModelTurns",
    "readCanonicalEvents",
    "readInteractions",
    "readAttachmentWrites",
    "readNetworkAttempts",
    "readSecurityAudit",
    "reset",
  ],
  async run(driver) {
    try {
      const target = await binding(driver, "fe06");
      const wrongToken = "wrong-token";
      const secrets = [target.token, wrongToken];
      const attempts = [
        { token: null, source: "remote" as const, expected: "AUTH_REQUIRED" },
        { token: wrongToken, source: "remote" as const, expected: "AUTH_INVALID" },
        { token: null, source: "loopback" as const, expected: "AUTH_REQUIRED" },
        { token: wrongToken, source: "loopback" as const, expected: "AUTH_INVALID" },
      ];
      for (const attempt of attempts) {
        const deniedRequest = request(`denied:${attempt.expected}`);
        deniedRequest.messages[0] = {
          role: "user",
          content: [
            { type: "text", text: `denied:${attempt.expected}` },
            { type: "file", file: { filename: "denied.txt", file_data: "aGVsbG8=" } },
          ],
        };
        const denied = await driver.sendCompletion(
          target.bindingId,
          { token: attempt.token, source: attempt.source, conversationId: null },
          deniedRequest,
        );
        if (denied.status !== 401 || denied.error?.code !== attempt.expected) {
          return fail(redact(`鉴权失败没有稳定 401/code：${json({ attempt, denied })}`, secrets));
        }
        // 完整扫描 denied 响应（含 error.message），token 原文不许出现。
        if (json(denied).includes(target.token) || json(denied).includes(wrongToken)) {
          return fail("鉴权失败响应泄漏 token");
        }
      }
      // 401 也必须留下可扫的原始响应；不能因为「没落模型」就假设没有 wire。
      const deniedWires = await driver.readRawWire(target.bindingId);
      const sawAllDenied = attempts.every((attempt) =>
        deniedWires.some((exchange) => exchange.responseBody.includes(attempt.expected)),
      );
      if (deniedWires.length !== attempts.length || !sawAllDenied) {
        return fail(redact(`鉴权失败没有留下可扫的原始 wire：${json(deniedWires)}`, secrets));
      }
      for (const exchange of deniedWires) {
        if (
          exchange.requestBody.includes(target.token) ||
          exchange.responseBody.includes(target.token) ||
          exchange.responseBody.includes(wrongToken)
        ) {
          return fail(redact("鉴权原始 wire 泄漏 token", secrets));
        }
      }
      const modelTurns = await driver.readModelTurns(target.bindingId);
      const canonical = await driver.readCanonicalEvents(target.bindingId);
      const controls = await driver.readInteractions(target.bindingId);
      const attachments = await driver.readAttachmentWrites();
      if (
        modelTurns.length !== 0 ||
        canonical.length !== 0 ||
        controls.length !== 0 ||
        attachments.count !== 0 ||
        attachments.records.length !== 0
      ) {
        return fail(
          `鉴权失败仍触发模型/账/控制/附件副作用：${redact(
            json({ modelTurns, canonical, controls, attachments }),
            secrets,
          )}`,
        );
      }

      await driver.queueResidentReply(target.bindingId, { kind: "text", text: "authorized" });
      const accepted = await driver.sendCompletion(
        target.bindingId,
        { token: target.token, source: "loopback", conversationId: null },
        request("authorized loopback"),
      );
      if (bodyOf(accepted)?.text !== "authorized") {
        return fail(redact(`带 token 的 loopback 正对照失败：${json(accepted)}`, secrets));
      }
      // 成功流式响应也要能被扫：SSE 原文里不许混进 token。
      await driver.queueResidentReply(target.bindingId, {
        kind: "text",
        text: "authorized stream",
      });
      const streamed = await driver.sendCompletion(
        target.bindingId,
        { token: target.token, source: "loopback", conversationId: null },
        request("authorized loopback stream", { stream: true }),
      );
      if (bodyOf(streamed)?.text !== "authorized stream") {
        return fail(redact(`带 token 的流式正对照失败：${json(streamed)}`, secrets));
      }
      const audit = await driver.readSecurityAudit();
      const expectedAudit = [
        ...attempts.map((attempt) => ({
          source: attempt.source,
          result: "rejected",
          code: attempt.expected,
        })),
        { source: "loopback", result: "accepted", code: "AUTH_ACCEPTED" },
        { source: "loopback", result: "accepted", code: "AUTH_ACCEPTED" },
      ];
      if (
        audit.attempts !== expectedAudit.length ||
        audit.accepted !== 2 ||
        audit.entries.length !== audit.attempts ||
        audit.entries.filter((entry) => entry.result === "accepted").length !== audit.accepted ||
        json(
          audit.entries.map((entry) => ({
            source: entry.source,
            result: entry.result,
            code: entry.code,
          })),
        ) !== json(expectedAudit)
      ) {
        return fail(redact(`鉴权审计计数不对：${json(audit)}`, secrets));
      }

      // 全量扫描：accepted 响应体/raw wire(含 SSE)/canonical/model/control/附件/network/audit 都不许含 token。
      const observable = json({
        accepted,
        streamed,
        wire: await driver.readRawWire(target.bindingId),
        turns: await driver.readModelTurns(target.bindingId),
        events: await driver.readCanonicalEvents(target.bindingId),
        controls: await driver.readInteractions(target.bindingId),
        attachments: await driver.readAttachmentWrites(),
        network: await driver.readNetworkAttempts(),
        audit,
      });
      for (const secret of secrets) {
        if (observable.includes(secret)) {
          return fail(redact("token 泄漏进响应/wire/回执/附件观察/审计", secrets));
        }
      }
      return pass(
        "远端与 loopback 都先验 token；失败零模型/账/控制/附件副作用，全表面回读与审计不含 token",
      );
    } finally {
      await driver.reset();
    }
  },
};

function isLoopbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      (parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "localhost" ||
        parsed.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

const fe07: FrontendAdapterCheck = {
  id: "FE-07",
  title: "/webui 先确认和查环境，经插件安装闸启动，并复用同一 adapter endpoint",
  uses: [
    "provisionBinding",
    "runWebuiCommand",
    "readWebuiAudit",
    "queueResidentReply",
    "sendWebuiCompletion",
    "readRawWire",
    "readModelTurns",
    "readCanonicalEvents",
    "readAttachmentWrites",
    "reset",
  ],
  async run(driver) {
    try {
      await driver.reset();
      let target = await binding(driver, "fe07-preinstall");
      /** 从有序操作日志里取出某个 proposal 的操作序列（按原顺序）。 */
      const operationsFor = (
        audit: Awaited<ReturnType<FrontendAdapterDriver["readWebuiAudit"]>>,
        proposalId: string,
      ) => audit.operations.filter((op) => op.proposalId === proposalId);
      const completeProposal = (
        proposal: WebuiInstallProposal | undefined,
      ): proposal is WebuiInstallProposal =>
        proposal !== undefined &&
        proposal.proposalId.length > 0 &&
        proposal.pluginId.length > 0 &&
        proposal.category === "frontend" &&
        /open\s*webui/i.test(proposal.displayName) &&
        Number.isFinite(proposal.resourceUsage.diskBytes) &&
        proposal.resourceUsage.diskBytes > 0 &&
        Number.isFinite(proposal.resourceUsage.memoryBytes) &&
        proposal.resourceUsage.memoryBytes > 0 &&
        proposal.servicesToStart.length > 0 &&
        proposal.servicesToStart.every((serviceId) => serviceId.length > 0);

      // —— 合法「展示后取消」正例：先展示完整 proposal，再消费取消决定，零安装/服务 ——
      const cancelled = await driver.runWebuiCommand(target.bindingId, {
        confirmed: false,
        environment: { docker: true, python: true },
      });
      if (
        cancelled.status !== "cancelled" ||
        cancelled.proposalId === null ||
        cancelled.confirmation !== "cancelled" ||
        cancelled.installedPlugin !== null ||
        cancelled.runtimeUsed !== null ||
        cancelled.serviceId !== null ||
        cancelled.url !== null
      ) {
        return fail(`展示后取消没有正确停住或没有展示提案：${json(cancelled)}`);
      }
      let audit = await driver.readWebuiAudit();
      const cancelOperations = operationsFor(audit, cancelled.proposalId);
      const cancelProposal = audit.proposals.find(
        (item) => item.proposalId === cancelled.proposalId,
      );
      if (
        audit.installGateCalls !== 0 ||
        audit.systemInstallAttempts !== 0 ||
        audit.startedServiceIds.length !== 0 ||
        !completeProposal(cancelProposal) ||
        cancelOperations.length !== 2 ||
        cancelOperations[0]?.kind !== "proposal" ||
        cancelOperations[0].pluginId !== cancelProposal.pluginId ||
        cancelOperations[0].category !== cancelProposal.category ||
        cancelOperations[1]?.kind !== "confirmation" ||
        cancelOperations[1].confirmed !== false
      ) {
        return fail(`取消仍触发安装/服务，或提案→确认顺序/归属不对：${json(audit)}`);
      }

      const missing = await driver.runWebuiCommand(target.bindingId, {
        confirmed: true,
        environment: { docker: false, python: false },
      });
      if (
        missing.status !== "missing-runtime" ||
        json([...missing.missing].sort()) !== json(["docker", "python"]) ||
        missing.confirmation !== null ||
        missing.installedPlugin !== null ||
        missing.runtimeUsed !== null ||
        missing.serviceId !== null
      ) {
        return fail(`缺运行环境没有明确停住或擅自进入确认安装：${json(missing)}`);
      }
      audit = await driver.readWebuiAudit();
      if (
        audit.installGateCalls !== 0 ||
        audit.systemInstallAttempts !== 0 ||
        audit.startedServiceIds.length !== 0 ||
        audit.operations.some((op) => op.kind === "install")
      ) {
        return fail(`缺环境时自行安装或启动了服务：${json(audit)}`);
      }

      /**
       * 核「本次展示的提案」与「实际经闸安装的插件」对得上：
       * proposal id 归属、frontend 类别、Open WebUI 组件、资源占用与将启动服务。
       * 沿 opaque id 合同，不假设宿主 plugin id 的字面。
       */
      const verifyStart = async (
        result: WebuiCommandReadback,
        expectedRuntime: WebuiRuntime,
      ): Promise<FrontendAdapterCheckResult | null> => {
        const label = `${expectedRuntime}-only`;
        if (
          result.status !== "started" ||
          result.serviceId === null ||
          result.url === null ||
          result.url.includes(target.token) ||
          result.endpointId !== target.endpointId ||
          !isLoopbackUrl(result.url) ||
          result.confirmation !== "confirmed"
        ) {
          return fail(`${label}：确认后没有经同一 endpoint 启本机服务：${json(result)}`);
        }
        if (result.runtimeUsed !== expectedRuntime) {
          return fail(`${label}：实际服务选择了不可用 runtime：${json(result)}`);
        }
        if (
          result.proposalId === null ||
          result.installedPlugin === null ||
          result.installedPlugin.pluginId.length === 0 ||
          result.installedPlugin.category !== "frontend"
        ) {
          return fail(`${label}：没有 frontend 类别的实际插件身份或提案归属：${json(result)}`);
        }
        const current = await driver.readWebuiAudit();
        const proposal = current.proposals.find((item) => item.proposalId === result.proposalId);
        if (
          !completeProposal(proposal) ||
          !proposal.servicesToStart.includes(result.serviceId) ||
          proposal.pluginId !== result.installedPlugin.pluginId
        ) {
          return fail(
            `${label}：展示的提案与实装插件对不上或缺少资源/服务/组件证据：${json({
              proposal,
              result,
            })}`,
          );
        }
        const operations = operationsFor(current, result.proposalId);
        if (
          operations.length !== 3 ||
          operations[0]?.kind !== "proposal" ||
          operations[0].proposalId !== result.proposalId ||
          operations[0].pluginId !== proposal.pluginId ||
          operations[0].category !== proposal.category ||
          operations[1]?.kind !== "confirmation" ||
          operations[1].confirmed !== true ||
          operations[2]?.kind !== "install" ||
          operations[2].pluginId !== result.installedPlugin.pluginId ||
          operations[2].category !== result.installedPlugin.category ||
          operations[2].runtimeUsed !== result.runtimeUsed
        ) {
          return fail(`${label}：提案→确认→安装的顺序或身份不对：${json({ operations, result })}`);
        }
        if (
          current.installGateCalls !== 1 ||
          current.systemInstallAttempts !== 0 ||
          json(current.startedServiceIds) !== json([result.serviceId]) ||
          json(current.endpointIds) !== json([target.endpointId]) ||
          current.operations.filter((op) => op.kind === "install").length !== 1 ||
          current.operations.filter((op) => op.kind === "confirmation").length !== 1
        ) {
          return fail(`${label}：安装闸计数或服务审计不成立：${json(current)}`);
        }
        return null;
      };

      // 每条成功路径都从 reset 后的未安装场景开始，不要求已装服务在同一 binding 重装。
      await driver.reset();
      target = await binding(driver, "fe07-python");
      const pythonStarted = await driver.runWebuiCommand(target.bindingId, {
        confirmed: true,
        environment: { docker: false, python: true },
      });
      const pythonFailure = await verifyStart(pythonStarted, "python");
      if (pythonFailure !== null) return pythonFailure;

      await driver.reset();
      target = await binding(driver, "fe07-docker");
      const started = await driver.runWebuiCommand(target.bindingId, {
        confirmed: true,
        environment: { docker: true, python: false },
      });
      const dockerFailure = await verifyStart(started, "docker");
      if (dockerFailure !== null) return dockerFailure;

      const serviceId = started.serviceId as string;
      const context = {
        token: target.token,
        source: "loopback" as const,
        conversationId: serviceId,
      };
      /** 全量可观察状态快照：拒绝后必须逐字不变。 */
      const snapshot = async () => ({
        turns: await driver.readModelTurns(target.bindingId),
        events: await driver.readCanonicalEvents(target.bindingId),
        attachments: await driver.readAttachmentWrites(),
      });

      // —— WebUI 文字往返：走 FE-02 同一 endpoint/主流/唯一 writer ——
      // 附件结构、私有附件写入的正反例已按主笔裁定（#218 2026-10-08 拆分）迁到 FE-05；
      // 本步 FE-07 只核文字走同一真实宿主 endpoint。
      const webuiText = "from-webui";
      await driver.queueResidentReply(target.bindingId, { kind: "text", text: webuiText });
      const before = await driver.readCanonicalEvents(target.bindingId);
      const response = await driver.sendWebuiCompletion(
        serviceId,
        context,
        request("through webui"),
      );
      const responseBody = bodyOf(response);
      if (
        responseBody === null ||
        responseBody.streamId !== target.streamId ||
        responseBody.model !== target.serverModel ||
        responseBody.text !== webuiText ||
        responseBody.attachments.length !== 0 ||
        responseBody.interaction !== null
      ) {
        return fail(`Open WebUI 文字没有走同一主流：${json(response)}`);
      }
      const after = await driver.readCanonicalEvents(target.bindingId);
      const newEvents = after.slice(before.length);
      if (
        newEvents.length !== 2 ||
        newEvents[0]?.kind !== "user" ||
        newEvents[0]?.text !== "through webui" ||
        newEvents[1]?.kind !== "assistant" ||
        newEvents[1]?.text !== webuiText ||
        newEvents.some(
          (event) =>
            event.residentId !== target.residentId ||
            event.scopeId !== target.scopeId ||
            event.streamId !== target.streamId ||
            event.writerId !== target.canonicalWriterId,
        )
      ) {
        return fail(`Open WebUI 文字往返没有恰好落两条同源事件：${json(newEvents)}`);
      }
      const webuiWire = (await driver.readRawWire(target.bindingId)).at(-1);
      const webuiEnvelope =
        webuiWire === undefined ? null : parseJsonEnvelope(webuiWire.responseBody);
      if (
        webuiEnvelope === null ||
        webuiEnvelope.object !== "chat.completion" ||
        webuiEnvelope.id !== responseBody.id ||
        webuiEnvelope.choices.length !== 1 ||
        webuiEnvelope.choices[0]?.index !== 0 ||
        webuiEnvelope.choices[0]?.message?.role !== "assistant" ||
        webuiEnvelope.choices[0]?.message?.content !== webuiText ||
        webuiEnvelope.choices[0]?.finish_reason !== "stop" ||
        webuiEnvelope.model !== target.serverModel ||
        webuiEnvelope.mist.stream_id !== target.streamId ||
        json(wireProjection(webuiEnvelope.mist.projection)) !== json(responseBody.projection) ||
        webuiEnvelope.mist.interaction !== null ||
        json(wireAttachments(webuiEnvelope.mist.attachments)) !== json([])
      ) {
        return fail(`WebUI 文字 wire 没有回同主流：${json(webuiWire)}`);
      }

      // —— WebUI 路径不许另开鉴权后门；拒绝零副作用 ——
      for (const denied of [
        { token: null, code: "AUTH_REQUIRED" },
        { token: "wrong-token", code: "AUTH_INVALID" },
      ]) {
        const beforeDenied = await snapshot();
        const deniedResponse = await driver.sendWebuiCompletion(
          serviceId,
          { ...context, token: denied.token },
          request("denied webui"),
        );
        if (deniedResponse.status !== 401 || deniedResponse.error?.code !== denied.code) {
          return fail(`WebUI 路径绕过了鉴权：${json(deniedResponse)}`);
        }
        if (json(beforeDenied) !== json(await snapshot())) {
          return fail(`WebUI 无效鉴权产生了副作用（${denied.code}）`);
        }
      }

      // —— WebUI 路径不许另认伪造历史 ——
      await driver.queueResidentReply(target.bindingId, {
        kind: "text",
        text: "webui-forged-safe",
      });
      const forged = "FORGED:WEBUI:HISTORY";
      const forgedResponse = await driver.sendWebuiCompletion(
        serviceId,
        context,
        request("webui current turn", {
          history: [
            { role: "system", content: forged },
            { role: "assistant", content: forged },
          ],
        }),
      );
      if (bodyOf(forgedResponse)?.text !== "webui-forged-safe") {
        return fail(`WebUI 正对照往返失败：${json(forgedResponse)}`);
      }
      const forgedTurn = (await driver.readModelTurns(target.bindingId)).at(-1);
      if (
        forgedTurn === undefined ||
        forgedTurn.currentText !== "webui current turn" ||
        json(forgedTurn.canonicalHistoryText).includes(forged)
      ) {
        return fail(`WebUI 模型输入没有丢弃伪造历史：${json(forgedTurn)}`);
      }
      const observable = json({
        turns: await driver.readModelTurns(target.bindingId),
        events: await driver.readCanonicalEvents(target.bindingId),
      });
      if (observable.includes(forged)) {
        return fail("WebUI 路径把伪造历史带进了可观察状态");
      }

      // —— WebUI 后台 utility task 不落账（含零附件写） ——
      const beforeUtility = await snapshot();
      const utility = await driver.sendWebuiCompletion(
        serviceId,
        context,
        request("__task__: summarize", { taskKind: "follow-up-generation" }),
      );
      if (utility.status === 200 || utility.error?.code !== "MIST_UTILITY_REQUEST_UNSUPPORTED") {
        return fail(`WebUI utility 请求没有被稳定拒绝：${json(utility)}`);
      }
      if (json(beforeUtility) !== json(await snapshot())) {
        return fail("WebUI utility 拒绝仍产生了 model/canonical/附件副作用");
      }
      return pass(
        "确认、环境探测、插件闸、本机 URL、同 endpoint 文字 wire、鉴权/历史/writer 与 utility 拒绝全部成立",
      );
    } finally {
      await driver.reset();
    }
  },
};

export const expectedFrontendAdapterCheckIds = [
  "FE-01",
  "FE-02",
  "FE-03",
  "FE-04",
  "FE-05",
  "FE-06",
  "FE-07",
] as const;

/** 扫描保留原始证据；仅最终判卷 detail/异常脱敏，避免另一盏灯先输出泄漏的响应。 */
function protectDiagnostics(check: FrontendAdapterCheck): FrontendAdapterCheck {
  return {
    ...check,
    async run(driver) {
      const secrets = new Set<string>();
      const observed = new Proxy(driver, {
        get(target, property) {
          if (property === "provisionBinding") {
            return async (input: Parameters<FrontendAdapterDriver["provisionBinding"]>[0]) => {
              const result = await target.provisionBinding(input);
              secrets.add(result.token);
              return result;
            };
          }
          if (property === "sendCompletion" || property === "sendWebuiCompletion") {
            return (id: string, context: FrontendRequestContext, request: FrontendChatRequest) => {
              if (context.token !== null) secrets.add(context.token);
              return target[property](id, context, request);
            };
          }
          const member = Reflect.get(target, property, target);
          return typeof member === "function" ? member.bind(target) : member;
        },
      });
      try {
        const result = await check.run(observed);
        return { ...result, detail: redact(result.detail, [...secrets]) };
      } catch (error) {
        throw new Error(redact(String(error), [...secrets]));
      }
    },
  };
}

export const frontendAdapterChecks: FrontendAdapterCheck[] = [
  fe01,
  fe02,
  fe03,
  fe04,
  fe05,
  fe06,
  fe07,
].map(protectDiagnostics);
