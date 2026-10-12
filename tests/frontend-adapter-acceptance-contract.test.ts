import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  expectedFrontendAdapterCheckIds,
  frontendAdapterChecks,
} from "../acceptance/frontend-adapter-checks.ts";
import {
  type AdapterBinding,
  type AttachmentWriteReadback,
  type AttachmentWriteRecord,
  type CanonicalEventReadback,
  type ClientCapability,
  type FrontendAdapterDriver,
  type FrontendChatRequest,
  type FrontendContentPart,
  type FrontendRequestContext,
  type FrontendResponse,
  type InstallerRunReadback,
  type InteractionReadback,
  type LegacyFrontendReadback,
  type ModelTurnReadback,
  type NetworkAttemptReadback,
  type NetworkAttemptRecord,
  type RawWireExchange,
  type ResidentReply,
  type SecurityAuditReadback,
  type StructuredAttachment,
  type StructuredInteraction,
  type SurfaceProjection,
  type WebuiAuditReadback,
  type WebuiCommandReadback,
  type WebuiInstallProposal,
  cloneFrontendAdapterDriverBoundary,
} from "../acceptance/frontend-adapter-driver.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

type Fault =
  | "fe02-swap-roles"
  | "fe02-all-assistant"
  | "fe02-reverse-text-order"
  | "sse-missing-attachments"
  | "sse-missing-interaction"
  | "trust-developer-history"
  | "trust-tool-history"
  | "developer-audit-history"
  | "fe04-wrong-resident"
  | "fe04-wrong-scope"
  | "fe04-wrong-writer"
  | "fe04-no-second-append"
  | "fe04-wrong-current-text"
  | "projection-old-events"
  | "projection-missing-structure"
  | "projection-empty"
  | "choice-projection-missing-structure"
  | "approval-wrong-resolution-id"
  | "approval-wrong-interaction"
  | "approval-invokes-model"
  | "auth-records-zero-count"
  | "audit-wrong-source"
  | "audit-wrong-code"
  | "audit-wrong-result"
  | "audit-missing-entry"
  | "audit-wrong-order"
  | "projection-three-current"
  | "auxiliary-events"
  // FE-01
  | "legacy-rewrite"
  // FE-02
  | "direct-writer"
  | "wire-bad-envelope"
  | "wire-bad-sse"
  | "wire-bad-framing"
  | "wire-bad-delta"
  | "native-projection-missing"
  | "wire-client-model"
  | "wire-stream-id-mismatch"
  | "wire-normalized-diverges"
  | "wire-camel-projection"
  | "wire-textual-attachment"
  | "wire-interaction-drop-options"
  | "wire-camel-interaction-response"
  | "wire-leak-token-401"
  | "wire-leak-token-sse"
  | "utility-not-refused"
  | "utility-writes-attachment"
  // FE-03
  | "trust-request-history"
  | "forgive-empty-messages"
  | "forgive-non-user-last"
  | "forgive-unparseable-content"
  // FE-04
  | "split-stream"
  // FE-05
  | "flatten-interaction"
  | "drop-interaction-options"
  | "ignore-interaction-response"
  | "plain-text-resolves"
  | "duplicate-resolves"
  | "accept-foreign-interaction"
  | "wrong-option-accepted"
  | "control-invokes-model"
  | "attachment-metadata-drop"
  | "canonical-drop-options"
  | "canonical-resolution-no-option"
  | "fetch-remote-image"
  | "remote-image-writes-attachment"
  | "sse-drop-stream-interaction"
  // FE-06
  | "loopback-bypass"
  | "auth-writes-attachment"
  | "leak-token-error"
  | "leak-token-body-id"
  | "leak-token-canonical"
  | "leak-token-audit-detail"
  // FE-07
  | "bypass-install-gate"
  | "webui-direct-writer"
  | "webui-bypass-auth"
  | "webui-trust-history"
  | "webui-split-stream"
  | "webui-utility-not-refused"
  | "webui-skip-proposal"
  | "webui-wrong-category"
  | "webui-skip-attachment-writes"
  | "webui-cancel-proposal-empty"
  | "webui-proposal-identity-mismatch"
  | "webui-canonical-egress-metadata-drop"
  | "webui-install-before-confirm"
  | "webui-python-only-uses-docker"
  | "webui-docker-only-uses-python"
  | "attachment-write-wrong-owner";

interface StoredInteraction extends InteractionReadback {
  bindingId: string;
  residentId: string;
  scopeId: string;
}

interface StoredBinding {
  binding: AdapterBinding;
  history: string[];
  replies: ResidentReply[];
  turns: ModelTurnReadback[];
  events: CanonicalEventReadback[];
  wire: RawWireExchange[];
  interactions: Map<string, StoredInteraction>;
  attachmentWrites: AttachmentWriteRecord[];
}

function textFromParts(parts: FrontendContentPart[]): string {
  return parts
    .filter((part): part is Extract<FrontendContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function attachmentFromPart(
  part: FrontendContentPart,
  index: number,
  idPrefix: string,
): StructuredAttachment | null {
  if (part.type === "text") return null;
  if (part.type === "file") {
    return {
      attachmentId: `${idPrefix}:file:${index}`,
      kind: "file",
      filename: part.file.filename,
      mediaType: "application/octet-stream",
      sizeBytes:
        part.file.file_data === undefined ? 0 : Buffer.from(part.file.file_data, "base64").length,
      source: part.file.file_id === undefined ? "inline" : "opaque-ref",
    };
  }
  if (part.type !== "image_url") return null;
  return {
    attachmentId: `${idPrefix}:image:${index}`,
    kind: "image",
    filename: `image-${index}`,
    mediaType: "image/unknown",
    sizeBytes: part.image_url.url.length,
    source: part.image_url.url.startsWith("data:") ? "inline" : "opaque-ref",
  };
}

/** 合成 wire 编码器：驱动把归一化对象序列化成标准 Chat Completions 字节。 */
function wireAttachment(value: StructuredAttachment, textual = false): Record<string, unknown> {
  if (textual) {
    return { type: "text", text: `[attachment] ${value.filename}` };
  }
  return {
    attachment_id: value.attachmentId,
    kind: value.kind,
    filename: value.filename,
    media_type: value.mediaType,
    size_bytes: value.sizeBytes,
    source: value.source,
  };
}

function wireInteraction(
  value: StructuredInteraction,
  dropOptions = false,
): Record<string, unknown> {
  return {
    interaction_id: value.interactionId,
    kind: value.kind,
    prompt: value.prompt,
    blocking: value.blocking,
    options: dropOptions
      ? []
      : value.options.map((option) => ({
          option_id: option.optionId,
          label: option.label,
          description: option.description,
        })),
    reason_code: value.reasonCode,
  };
}

function wireProjection(value: SurfaceProjection, camel = false): Record<string, unknown> {
  if (camel) {
    return {
      status: value.status,
      missingCapabilities: value.missingCapabilities,
      canonicalEventIds: value.canonicalEventIds,
    };
  }
  return {
    status: value.status,
    missing_capabilities: value.missingCapabilities,
    canonical_event_ids: value.canonicalEventIds,
  };
}

function encodeCompletionBody(input: {
  id: string;
  model: string;
  text: string;
  streamId: string;
  attachments: StructuredAttachment[];
  interaction: StructuredInteraction | null;
  projection: SurfaceProjection;
  object?: string | undefined;
  dropChoices?: boolean | undefined;
  camelProjection?: boolean | undefined;
  textualAttachment?: boolean | undefined;
  dropInteractionOptions?: boolean | undefined;
}): Record<string, unknown> {
  return {
    id: input.id,
    object: input.object ?? "chat.completion",
    created: 1_700_000_000,
    model: input.model,
    choices: input.dropChoices
      ? []
      : [
          {
            index: 0,
            message: { role: "assistant", content: input.text },
            finish_reason: "stop",
          },
        ],
    mist: {
      stream_id: input.streamId,
      attachments: input.attachments.map((item) =>
        wireAttachment(item, input.textualAttachment ?? false),
      ),
      interaction:
        input.interaction === null
          ? null
          : wireInteraction(input.interaction, input.dropInteractionOptions ?? false),
      projection: wireProjection(input.projection, input.camelProjection ?? false),
    },
  };
}

function encodeChunk(input: {
  id: string;
  model: string;
  delta: { role?: string; content?: string };
  finishReason: string | null;
  mist?: Record<string, unknown>;
}): Record<string, unknown> {
  const frame: Record<string, unknown> = {
    id: input.id,
    object: "chat.completion.chunk",
    created: 1_700_000_000,
    model: input.model,
    choices: [{ index: 0, delta: input.delta, finish_reason: input.finishReason }],
  };
  if (input.mist !== undefined) frame.mist = input.mist;
  return frame;
}

class FixtureDriver implements FrontendAdapterDriver {
  readonly #faults: Set<Fault>;
  readonly #ingressIdPrefix: string;
  readonly #reuseInstalledWebui: boolean;
  readonly #bindings = new Map<string, StoredBinding>();
  readonly #services = new Map<string, string>();
  readonly #webuiServices = new Map<string, WebuiCommandReadback>();
  #sequence = 0;
  #security: SecurityAuditReadback = {
    attempts: 0,
    accepted: 0,
    entries: [],
    logs: [],
    receipts: [],
  };
  #networkAttempts: NetworkAttemptRecord[] = [];
  #webui: WebuiAuditReadback = {
    installGateCalls: 0,
    systemInstallAttempts: 0,
    startedServiceIds: [],
    endpointIds: [],
    proposals: [],
    operations: [],
  };

  constructor(
    faults: readonly Fault[] = [],
    ingressIdPrefix = "ingress",
    reuseInstalledWebui = false,
  ) {
    this.#faults = new Set(faults);
    this.#ingressIdPrefix = ingressIdPrefix;
    this.#reuseInstalledWebui = reuseInstalledWebui;
  }

  async reset(): Promise<void> {
    this.#bindings.clear();
    this.#services.clear();
    this.#webuiServices.clear();
    this.#security = { attempts: 0, accepted: 0, entries: [], logs: [], receipts: [] };
    this.#networkAttempts = [];
    this.#webui = {
      installGateCalls: 0,
      systemInstallAttempts: 0,
      startedServiceIds: [],
      endpointIds: [],
      proposals: [],
      operations: [],
    };
  }

  async runInstaller(input: {
    frontend: "default" | "external";
  }): Promise<InstallerRunReadback> {
    if (input.frontend === "default") {
      return { committed: true, defaulted: true, frontend: { kind: "terminal" } };
    }
    return {
      committed: true,
      defaulted: false,
      frontend: { kind: "external", integration: "openai-compatible" },
    };
  }

  async readLegacyOfficialSkin(rawConfig: string): Promise<LegacyFrontendReadback> {
    if (this.#faults.has("legacy-rewrite")) {
      return {
        ok: true,
        code: "MIGRATED",
        remedy: "",
        rewritten: true,
        bytesAfter: rawConfig.replace("official-skin", "terminal"),
      };
    }
    return {
      ok: false,
      code: "LEGACY_FRONTEND_UNSUPPORTED",
      remedy: "Re-run setup and choose terminal or external frontend explicitly.",
      rewritten: false,
      bytesAfter: rawConfig,
    };
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
      streamId: `stream:${input.label}`,
      token: `token:${input.label}:secret`,
      serverModel: `mist:${input.label}`,
      canonicalWriterId: `writer:${input.label}`,
    };
    this.#bindings.set(binding.bindingId, {
      binding,
      history: [],
      replies: [],
      turns: [],
      events: [],
      wire: [],
      interactions: new Map(),
      attachmentWrites: [],
    });
    // 该住户可以已有历史；投影负例必须有真正的旧记录可引用。
    if (input.label === "fe05") {
      await this.seedCanonicalHistory(binding.bindingId, ["prior:user", "prior:assistant"]);
    }
    return binding;
  }

  async seedCanonicalHistory(bindingId: string, text: string[]): Promise<void> {
    const state = this.#state(bindingId);
    state.history.push(...text);
    for (const [index, value] of text.entries()) {
      state.events.push(
        this.#event(state, index % 2 === 0 ? "user" : "assistant", {
          text: value,
        }),
      );
    }
  }

  async queueResidentReply(bindingId: string, reply: ResidentReply): Promise<void> {
    if (this.#faults.has("drop-interaction-options") && reply.kind === "interaction") {
      this.#state(bindingId).replies.push({
        ...reply,
        interaction: { ...reply.interaction, options: [] },
      });
      return;
    }
    this.#state(bindingId).replies.push(reply);
  }

  async sendCompletion(
    bindingId: string,
    context: FrontendRequestContext,
    request: FrontendChatRequest,
  ): Promise<FrontendResponse> {
    return this.#complete(this.#state(bindingId), context, request, {});
  }

  async sendWebuiCompletion(
    serviceId: string,
    context: FrontendRequestContext,
    request: FrontendChatRequest,
  ): Promise<FrontendResponse> {
    const bindingId = this.#services.get(serviceId);
    if (bindingId === undefined) return this.#error(404, "WEBUI_SERVICE_NOT_FOUND");
    const state = this.#state(bindingId);
    return this.#complete(state, context, request, {
      ...(this.#faults.has("webui-split-stream")
        ? { streamId: `${state.binding.streamId}:${serviceId}` }
        : {}),
      directWriter: this.#faults.has("webui-direct-writer"),
      bypassAuth: this.#faults.has("webui-bypass-auth"),
      trustHistory: this.#faults.has("webui-trust-history"),
      utilityNotRefused: this.#faults.has("webui-utility-not-refused"),
      skipAttachmentWrites: this.#faults.has("webui-skip-attachment-writes"),
    });
  }

  async readRawWire(bindingId: string): Promise<RawWireExchange[]> {
    return structuredClone(this.#state(bindingId).wire);
  }

  async readModelTurns(bindingId: string): Promise<ModelTurnReadback[]> {
    return structuredClone(this.#state(bindingId).turns);
  }

  async readCanonicalEvents(bindingId: string): Promise<CanonicalEventReadback[]> {
    return structuredClone(this.#state(bindingId).events);
  }

  async readInteractions(bindingId: string): Promise<InteractionReadback[]> {
    return structuredClone([...this.#state(bindingId).interactions.values()]);
  }

  async readAttachmentWrites(): Promise<AttachmentWriteReadback> {
    const records: AttachmentWriteRecord[] = [];
    for (const state of this.#bindings.values()) records.push(...state.attachmentWrites);
    return {
      count: this.#faults.has("auth-records-zero-count") ? 0 : records.length,
      records: structuredClone(records),
    };
  }

  async readNetworkAttempts(): Promise<NetworkAttemptReadback> {
    return {
      attempts: this.#networkAttempts.length,
      records: structuredClone(this.#networkAttempts),
    };
  }

  async readSecurityAudit(): Promise<SecurityAuditReadback> {
    return structuredClone(this.#security);
  }

  async runWebuiCommand(
    bindingId: string,
    input: { confirmed: boolean; environment: { docker: boolean; python: boolean } },
  ): Promise<WebuiCommandReadback> {
    const state = this.#state(bindingId);
    const installed = this.#webuiServices.get(bindingId);
    if (this.#reuseInstalledWebui && installed !== undefined) {
      // 正确宿主可以复用已经安装的现役服务，不再次进安装闸或启动服务。
      return structuredClone(installed);
    }
    const serviceId = `webui:${bindingId}`;
    const webuiPluginId = `plugin:webui:${bindingId}`;
    // 图纸 §8：先展示完整提案，再消费合成确认决定。
    const proposal: WebuiInstallProposal = {
      proposalId: `proposal:${bindingId}:${this.#webui.proposals.length + 1}`,
      pluginId: this.#faults.has("webui-skip-proposal") ? "" : webuiPluginId,
      category: this.#faults.has("webui-wrong-category") ? "channel_adapter" : "frontend",
      displayName: "Open WebUI",
      resourceUsage: { diskBytes: 512 * 1024 * 1024, memoryBytes: 256 * 1024 * 1024 },
      servicesToStart: this.#faults.has("webui-skip-proposal") ? [] : [serviceId],
    };
    if (!input.confirmed && this.#faults.has("webui-cancel-proposal-empty")) {
      // 错误行为：取消路径虽展示了 proposal id，却漏掉组件、资源和计划服务。
      proposal.displayName = "";
      proposal.resourceUsage = { diskBytes: 0, memoryBytes: 0 };
      proposal.servicesToStart = [];
    }
    if (!this.#faults.has("webui-skip-proposal")) {
      this.#webui.proposals.push(structuredClone(proposal));
    }
    this.#webui.operations.push({
      kind: "proposal",
      proposalId: proposal.proposalId,
      pluginId: this.#faults.has("webui-proposal-identity-mismatch")
        ? "plugin:unrelated-display"
        : proposal.pluginId,
      category: proposal.category,
    });

    const cancelled = !input.confirmed;
    const envMissing = !input.environment.docker && !input.environment.python;
    if (!cancelled && envMissing) {
      // 缺环境只报告缺项，不进入确认安装（不登记确认操作）。
      return {
        status: "missing-runtime",
        missing: ["docker", "python"],
        serviceId: null,
        url: null,
        endpointId: null,
        runtimeUsed: null,
        proposalId: proposal.proposalId,
        confirmation: null,
        installedPlugin: null,
      };
    }
    const runtimeUsed =
      this.#faults.has("webui-python-only-uses-docker") && !input.environment.docker
        ? "docker"
        : this.#faults.has("webui-docker-only-uses-python") && !input.environment.python
          ? "python"
          : input.environment.docker
            ? "docker"
            : "python";
    if (this.#faults.has("webui-install-before-confirm") && !cancelled) {
      // 错误行为：先经闸安装，再登记确认——顺序颠倒。
      this.#webui.installGateCalls += 1;
      this.#webui.operations.push({
        kind: "install",
        proposalId: proposal.proposalId,
        pluginId: proposal.pluginId,
        category: proposal.category,
        runtimeUsed,
      });
    }
    this.#webui.operations.push({
      kind: "confirmation",
      proposalId: proposal.proposalId,
      confirmed: input.confirmed,
    });

    if (cancelled) {
      return {
        status: "cancelled",
        missing: [],
        serviceId: null,
        url: null,
        endpointId: null,
        runtimeUsed: null,
        proposalId: proposal.proposalId,
        confirmation: "cancelled",
        installedPlugin: null,
      };
    }
    this.#services.set(serviceId, bindingId);
    if (this.#faults.has("bypass-install-gate")) {
      this.#webui.systemInstallAttempts += 1;
    } else if (!this.#faults.has("webui-install-before-confirm")) {
      this.#webui.installGateCalls += 1;
      this.#webui.operations.push({
        kind: "install",
        proposalId: proposal.proposalId,
        pluginId: proposal.pluginId,
        category: proposal.category,
        runtimeUsed,
      });
    }
    this.#webui.startedServiceIds.push(serviceId);
    this.#webui.endpointIds.push(state.binding.endpointId);
    const started: WebuiCommandReadback = {
      status: "started",
      missing: [],
      serviceId,
      url: "http://127.0.0.1:3000",
      endpointId: state.binding.endpointId,
      runtimeUsed,
      proposalId: proposal.proposalId,
      confirmation: "confirmed",
      installedPlugin: { pluginId: proposal.pluginId, category: proposal.category },
    };
    this.#webuiServices.set(bindingId, structuredClone(started));
    return started;
  }

  async readWebuiAudit(): Promise<WebuiAuditReadback> {
    return structuredClone(this.#webui);
  }

  #complete(
    state: StoredBinding,
    context: FrontendRequestContext,
    request: FrontendChatRequest,
    options: {
      streamId?: string;
      directWriter?: boolean;
      bypassAuth?: boolean;
      trustHistory?: boolean;
      utilityNotRefused?: boolean;
      skipAttachmentWrites?: boolean;
    },
  ): FrontendResponse {
    const eventCountBefore = state.events.length;
    const response = this.#completeInner(state, context, request, options);
    if (state.binding.bindingId === "binding:fe02" && response.status === 200) {
      const newTextEvents = state.events
        .slice(eventCountBefore)
        .filter((e) => e.kind === "user" || e.kind === "assistant");
      if (this.#faults.has("fe02-swap-roles")) {
        for (const event of newTextEvents)
          event.kind = event.kind === "user" ? "assistant" : "user";
      }
      if (this.#faults.has("fe02-all-assistant")) {
        for (const event of newTextEvents) event.kind = "assistant";
      }
      if (this.#faults.has("fe02-reverse-text-order")) {
        state.events.splice(
          eventCountBefore,
          state.events.length - eventCountBefore,
          ...state.events.slice(eventCountBefore).reverse(),
        );
      }
    }
    if (state.binding.bindingId === "binding:fe04" && response.status === 200) {
      for (const event of state.events.slice(eventCountBefore)) {
        if (this.#faults.has("fe04-wrong-resident")) event.residentId = "resident:other";
        if (this.#faults.has("fe04-wrong-scope")) event.scopeId = "scope:other";
        if (this.#faults.has("fe04-wrong-writer")) event.writerId = "writer:other";
      }
      if (this.#faults.has("fe04-wrong-current-text")) {
        const turn = state.turns.at(-1);
        if (turn !== undefined) turn.currentText = "unrelated turn";
      }
      if (this.#faults.has("fe04-no-second-append") && state.turns.length === 2) {
        state.events.splice(eventCountBefore);
      }
    }
    if (this.#faults.has("auxiliary-events") && response.status === 200 && response.body !== null) {
      state.events.push(
        this.#event(state, "surface-projection", { projection: response.body.projection }),
      );
    }

    // 任何 4xx 拒绝都要留下原始 wire，判卷才能扫 401/400 的响应原文；
    // 成功响应在 inner 里落自己那份（含 SSE）。请求记录不含 Authorization/token。
    if (response.status !== 200) {
      this.#recordRejectedWire(state, request, response, response.status);
    }
    return response;
  }

  #completeInner(
    state: StoredBinding,
    context: FrontendRequestContext,
    request: FrontendChatRequest,
    options: {
      streamId?: string;
      directWriter?: boolean;
      bypassAuth?: boolean;
      trustHistory?: boolean;
      utilityNotRefused?: boolean;
      skipAttachmentWrites?: boolean;
    },
  ): FrontendResponse {
    this.#security.attempts += 1;
    const loopbackBypass =
      !options.bypassAuth && this.#faults.has("loopback-bypass") && context.source === "loopback";
    // 错误行为：鉴权失败前先落附件字节。
    if (this.#faults.has("auth-writes-attachment") || this.#faults.has("auth-records-zero-count")) {
      this.#writeIngressAttachments(state, request);
    }
    if (!options.bypassAuth && !loopbackBypass && context.token === null) {
      this.#audit(context, "rejected", "AUTH_REQUIRED");
      this.#security.logs.push("auth:required");
      this.#security.receipts.push(
        this.#faults.has("leak-token-audit-detail") ? "AUTH_REQUIRED wrong-token" : "AUTH_REQUIRED",
      );
      return this.#error(401, "AUTH_REQUIRED");
    }
    if (!options.bypassAuth && !loopbackBypass && context.token !== state.binding.token) {
      this.#audit(context, "rejected", "AUTH_INVALID");
      this.#security.logs.push("auth:invalid");
      this.#security.receipts.push(
        this.#faults.has("leak-token-audit-detail") ? "AUTH_INVALID wrong-token" : "AUTH_INVALID",
      );
      return this.#error(401, "AUTH_INVALID");
    }
    this.#audit(context, "accepted", "AUTH_ACCEPTED");
    this.#security.accepted += 1;
    this.#security.logs.push("auth:accepted");
    this.#security.receipts.push(
      this.#faults.has("leak-token-audit-detail") ? `ACCEPTED ${state.binding.token}` : "ACCEPTED",
    );

    // Open WebUI utility task：显式 task hint 只能用来拒绝，不许落户。
    const taskKind = request.mist?.taskKind;
    const utilityNotRefused = options.utilityNotRefused ?? this.#faults.has("utility-not-refused");
    if (taskKind !== undefined && taskKind.length > 0 && !utilityNotRefused) {
      if (this.#faults.has("utility-writes-attachment")) {
        // 错误行为：utility 分类之前先把入站附件字节写进私有附件面。
        this.#writeIngressAttachments(state, request);
      }
      return this.#error(400, "MIST_UTILITY_REQUEST_UNSUPPORTED");
    }

    // 交互响应的逐项核验先于模型、canonical 与附件写入；拒绝响应仍留原始 wire。
    const interactionResponse = request.mist?.interactionResponse;
    const controlOnly = interactionResponse !== undefined && request.messages.length === 0;
    let resolvedInteraction: StoredInteraction | null = null;
    if (interactionResponse !== undefined) {
      const stored = state.interactions.get(interactionResponse.interactionId);
      const foreign =
        stored === undefined ? this.#findInteraction(interactionResponse.interactionId) : null;
      const wrongOption =
        stored !== undefined &&
        !stored.options.some((option) => option.optionId === interactionResponse.optionId);
      const faultAcceptsForeign =
        this.#faults.has("accept-foreign-interaction") && foreign !== null;
      const faultAcceptsDuplicate = this.#faults.has("duplicate-resolves") && stored !== undefined;
      const faultAcceptsWrongOption =
        this.#faults.has("wrong-option-accepted") && stored !== undefined;
      if (stored === undefined || foreign !== null) {
        if (faultAcceptsForeign) resolvedInteraction = foreign;
        else return this.#error(400, "MIST_INTERACTION_RESPONSE_INVALID");
      } else if (stored.status === "resolved" && !faultAcceptsDuplicate) {
        return this.#error(400, "MIST_INTERACTION_RESPONSE_INVALID");
      } else if (wrongOption && !faultAcceptsWrongOption) {
        return this.#error(400, "MIST_INTERACTION_RESPONSE_INVALID");
      } else {
        resolvedInteraction = stored;
      }
    }

    // 控制响应不是一条聊天话语：只落一次可归属的控制结果，不调模型、不落 user/assistant 事件。
    if (controlOnly) {
      if (
        resolvedInteraction === null ||
        interactionResponse === undefined ||
        this.#faults.has("ignore-interaction-response")
      ) {
        return this.#error(400, "MIST_INTERACTION_RESPONSE_INVALID");
      }
      const controlWriter = options.directWriter === true;
      const resolutionEvent = this.#event(state, "interaction", {
        interaction: {
          interactionId: resolvedInteraction.interactionId,
          kind: resolvedInteraction.kind,
          prompt: resolvedInteraction.prompt,
          blocking: true,
          options: resolvedInteraction.options,
          reasonCode: resolvedInteraction.reasonCode,
        },
        context,
        directWriter: controlWriter,
        resolvedOptionId: interactionResponse.optionId,
      });
      state.events.push(resolutionEvent);
      resolvedInteraction.status = "resolved";
      resolvedInteraction.resolvedOptionId = interactionResponse.optionId;
      resolvedInteraction.resolutionEventId = resolutionEvent.eventId;
      if (resolvedInteraction.kind === "approval") {
        if (this.#faults.has("approval-wrong-resolution-id"))
          resolvedInteraction.resolutionEventId = state.events[0]?.eventId ?? "old:event";
        if (this.#faults.has("approval-wrong-interaction")) resolutionEvent.interaction = null;
        if (this.#faults.has("approval-invokes-model"))
          state.turns.push({
            residentId: state.binding.residentId,
            scopeId: state.binding.scopeId,
            canonicalHistoryText: [...state.history],
            currentText: "approval as chat",
            attachments: [],
            surfaceCapabilities: [],
          });
      }
      if (this.#faults.has("control-invokes-model")) {
        // 错误行为：把控制响应当成一条聊天 turn，白调一次模型、多落一对事件。
        state.turns.push({
          residentId: state.binding.residentId,
          scopeId: state.binding.scopeId,
          canonicalHistoryText: [...state.history],
          currentText: "",
          attachments: [],
          surfaceCapabilities: [],
        });
        state.events.push(
          this.#event(state, "user", { text: "", context, directWriter: controlWriter }),
        );
        state.events.push(
          this.#event(state, "assistant", {
            text: "spurious",
            context,
            directWriter: controlWriter,
          }),
        );
      }
      const projection: SurfaceProjection = {
        status: "native",
        missingCapabilities: [],
        canonicalEventIds: [resolutionEvent.eventId],
      };
      const body = {
        id: `chatcmpl_mist_${++this.#sequence}`,
        model: state.binding.serverModel,
        streamId: state.binding.streamId,
        text: "",
        attachments: [],
        interaction: null,
        projection,
      };
      state.wire.push(
        this.#encodeWire(request, {
          id: body.id,
          text: "",
          streamId: body.streamId,
          model: body.model,
          attachments: [],
          interaction: null,
          projection,
        }),
      );
      return { status: 200, error: null, body, chunks: [] };
    }

    const last = request.messages.at(-1);
    const emptyMessagesForgiven = this.#faults.has("forgive-empty-messages");
    const nonUserForgiven = this.#faults.has("forgive-non-user-last");
    const unparseableForgiven = this.#faults.has("forgive-unparseable-content");
    if (last === undefined) {
      if (!emptyMessagesForgiven) return this.#error(400, "MIST_INVALID_TURN_SHAPE");
    } else if (last.role !== "user" && !nonUserForgiven) {
      return this.#error(400, "MIST_INVALID_TURN_SHAPE");
    } else if (
      last.role === "user" &&
      !this.#contentParseable(last.content) &&
      !unparseableForgiven
    ) {
      return this.#error(400, "MIST_INVALID_TURN_SHAPE");
    }
    const current: { role?: string; content: string | FrontendContentPart[] } =
      last === undefined
        ? { role: "user", content: "" }
        : (last as { role?: string; content: string | FrontendContentPart[] });

    const parts = Array.isArray(current.content) ? current.content : [];
    const currentText =
      typeof current.content === "string" ? current.content : textFromParts(current.content);
    // 图纸 §4.1：http(s) image_url 远程抓取禁止（SSRF 边界）。
    const remoteImageUrls = parts
      .filter(
        (part): part is Extract<FrontendContentPart, { type: "image_url" }> =>
          part.type === "image_url",
      )
      .map((part) => part.image_url.url)
      .filter((url) => /^https?:\/\//i.test(url));
    if (remoteImageUrls.length > 0) {
      // 正确行为：按 SSRF 策略直接拒绝，不发起远程抓取（零 network attempt）。
      if (this.#faults.has("fetch-remote-image")) {
        // 错误行为：拒绝前先真的向远程 host 发起抓取尝试并如实登记。
        for (const url of remoteImageUrls) {
          this.#networkAttempts.push(
            this.#networkAttempt(state, url, "MIST_REMOTE_URL_UNSUPPORTED"),
          );
        }
      }
      if (this.#faults.has("remote-image-writes-attachment")) {
        // 错误行为：先落了远程图片附件字节再拒绝。
        for (const [index, part] of parts.entries()) {
          const item = attachmentFromPart(part, index, this.#ingressIdPrefix);
          if (item !== null) this.#writeAttachment(state, item);
        }
      }
      return this.#error(400, "MIST_REMOTE_URL_UNSUPPORTED");
    }
    const ingressAttachments = parts
      .map((part, index) => attachmentFromPart(part, index, this.#ingressIdPrefix))
      .filter((item): item is StructuredAttachment => item !== null);
    for (const item of ingressAttachments) {
      this.#maybeWriteAttachment(state, item, options.skipAttachmentWrites === true);
    }
    const capabilities = [...(request.mist?.client?.capabilities ?? [])];
    const canonicalHistoryText = [...state.history];
    if (this.#faults.has("trust-request-history") || options.trustHistory === true) {
      canonicalHistoryText.push(
        ...request.messages
          .slice(0, -1)
          .flatMap((message) => [
            typeof message.content === "string" ? message.content : textFromParts(message.content),
          ]),
      );
    }
    for (const message of request.messages.slice(0, -1)) {
      if (typeof message.content !== "string") continue;
      if (
        (message.role === "developer" && this.#faults.has("trust-developer-history")) ||
        (message.role === "tool" && this.#faults.has("trust-tool-history"))
      )
        canonicalHistoryText.push(message.content);
      if (message.role === "developer" && this.#faults.has("developer-audit-history"))
        this.#security.receipts.push(message.content);
    }
    state.turns.push({
      residentId: state.binding.residentId,
      scopeId: state.binding.scopeId,
      canonicalHistoryText,
      currentText,
      attachments: ingressAttachments,
      surfaceCapabilities: capabilities,
    });

    const directWriter = options.directWriter === true;
    state.events.push(this.#event(state, "user", { text: currentText, context, directWriter }));
    for (const item of ingressAttachments) {
      state.events.push(
        this.#event(state, "attachment", { attachment: item, context, directWriter }),
      );
    }

    // 合法点击：先落耐久台账，再追加 append-only 的 canonical 记录。
    if (
      resolvedInteraction !== null &&
      interactionResponse !== undefined &&
      !this.#faults.has("ignore-interaction-response")
    ) {
      const resolutionEvent = this.#event(state, "interaction", {
        interaction: {
          interactionId: resolvedInteraction.interactionId,
          kind: resolvedInteraction.kind,
          prompt: resolvedInteraction.prompt,
          blocking: true,
          options: resolvedInteraction.options,
          reasonCode: resolvedInteraction.reasonCode,
        },
        context,
        directWriter,
        resolvedOptionId: interactionResponse.optionId,
      });
      state.events.push(resolutionEvent);
      resolvedInteraction.status = "resolved";
      resolvedInteraction.resolvedOptionId = interactionResponse.optionId;
      resolvedInteraction.resolutionEventId = resolutionEvent.eventId;
    } else if (this.#faults.has("plain-text-resolves")) {
      const pending = [...state.interactions.values()].find((item) => item.status === "pending");
      if (pending !== undefined) {
        pending.status = "resolved";
        pending.resolvedOptionId = pending.options[0]?.optionId ?? "auto";
        pending.resolutionEventId = this.#event(state, "interaction", {
          interaction: null,
          context,
          directWriter,
        }).eventId;
      }
    }

    const reply = state.replies.shift() ?? { kind: "text", text: "fixture-default-reply" };
    const text = reply.text;
    let attachments = reply.kind === "attachment" ? reply.attachments : [];
    if (this.#faults.has("attachment-metadata-drop")) {
      attachments = attachments.map((item) => ({
        attachmentId: item.attachmentId,
        kind: item.kind,
        filename: "",
        mediaType: "",
        sizeBytes: 0,
        source: "opaque-ref" as const,
      }));
    }
    for (const item of attachments) {
      this.#maybeWriteAttachment(state, item, options.skipAttachmentWrites === true);
    }
    let interaction = reply.kind === "interaction" ? reply.interaction : null;
    const missingCapabilities: ClientCapability[] = [];
    let projectionStatus: SurfaceProjection["status"] = "native";
    if (attachments.length > 0 && !capabilities.includes("attachments")) {
      projectionStatus = "degraded";
      missingCapabilities.push("attachments");
    }
    if (interaction !== null && !capabilities.includes("interactions")) {
      projectionStatus = "blocked";
      missingCapabilities.push("interactions");
    }

    let visibleText = text;
    if (this.#faults.has("flatten-interaction") && interaction !== null) {
      visibleText = `[option] ${interaction.options.map((option) => option.label).join(" / ")}`;
      interaction = null;
    }

    state.events.push(
      this.#event(state, "assistant", { text: visibleText, context, directWriter }),
    );
    for (const item of attachments) {
      state.events.push(
        this.#event(state, "attachment", { attachment: item, context, directWriter }),
      );
    }
    if (interaction !== null) {
      state.events.push(this.#event(state, "interaction", { interaction, context, directWriter }));
      state.interactions.set(interaction.interactionId, {
        interactionId: interaction.interactionId,
        kind: interaction.kind,
        prompt: interaction.prompt,
        blocking: true,
        options: structuredClone(interaction.options),
        reasonCode: interaction.reasonCode,
        status: "pending",
        resolvedOptionId: null,
        resolutionEventId: null,
        bindingId: state.binding.bindingId,
        residentId: state.binding.residentId,
        scopeId: state.binding.scopeId,
      });
    }

    const canonicalEventIds = state.events
      .slice(-1 - attachments.length - (interaction === null ? 0 : 1))
      .map((event) => event.eventId);
    if (state.binding.bindingId === "binding:fe05" && currentText === "attachment ingress") {
      if (this.#faults.has("projection-old-events"))
        canonicalEventIds.splice(
          0,
          canonicalEventIds.length,
          ...state.events.slice(0, 2).map((e) => e.eventId),
        );
      if (this.#faults.has("projection-missing-structure"))
        canonicalEventIds.splice(
          0,
          canonicalEventIds.length,
          ...state.events
            .filter((e) => e.kind === "user" || e.kind === "assistant")
            .slice(-2)
            .map((e) => e.eventId),
        );
      if (this.#faults.has("projection-empty")) canonicalEventIds.splice(0);
      if (this.#faults.has("projection-three-current")) {
        const ingressEvent = state.events.find((e) => e.attachment?.filename === "inbound.txt");
        if (ingressEvent !== undefined) canonicalEventIds.unshift(ingressEvent.eventId);
      }
    }
    if (
      this.#faults.has("choice-projection-missing-structure") &&
      interaction?.interactionId === "interaction:native-choice"
    ) {
      canonicalEventIds.splice(
        0,
        canonicalEventIds.length,
        ...state.events
          .filter((e) => e.kind === "assistant")
          .slice(-1)
          .map((e) => e.eventId),
      );
    }
    const projection: SurfaceProjection = {
      status: projectionStatus,
      missingCapabilities,
      canonicalEventIds,
    };
    if (projectionStatus !== "native") {
      state.events.push(
        this.#event(state, "surface-projection", { projection, context, directWriter }),
      );
    } else if (!this.#faults.has("native-projection-missing")) {
      const replyEvent = state.events.find((event) => event.eventId === canonicalEventIds[0]);
      if (replyEvent !== undefined) replyEvent.projection = structuredClone(projection);
    }
    state.history.push(currentText, visibleText);

    const streamId =
      options.streamId ??
      (this.#faults.has("split-stream") && context.conversationId !== null
        ? `${state.binding.streamId}:${context.conversationId}`
        : state.binding.streamId);
    if (
      options.streamId === undefined &&
      this.#faults.has("split-stream") &&
      context.conversationId !== null
    ) {
      for (const event of state.events.slice(-2)) event.streamId = streamId;
    }

    const id = `chatcmpl_mist_${++this.#sequence}${
      this.#faults.has("leak-token-body-id") ? `:${state.binding.token}` : ""
    }`;
    const body = {
      id,
      model: state.binding.serverModel,
      streamId,
      text: visibleText,
      attachments,
      interaction,
      projection,
    };
    const chunks = request.stream
      ? [
          { textDelta: visibleText, attachments, interaction, projection, done: false },
          {
            textDelta: "",
            attachments: [],
            interaction: null,
            projection: null,
            done: true,
          },
        ]
      : [];

    state.wire.push(
      this.#encodeWire(request, {
        id,
        text: visibleText,
        streamId,
        model: state.binding.serverModel,
        attachments,
        interaction,
        projection,
      }),
    );

    return { status: 200, error: null, body, chunks };
  }

  /** 落一次原始拒绝记录；请求体只含兼容字段，不带 Authorization/token。 */
  #recordRejectedWire(
    state: StoredBinding,
    request: FrontendChatRequest,
    response: FrontendResponse,
    status: number,
  ): void {
    const error = response.error ?? {
      code: "UNKNOWN",
      type: "fixture_error",
      message: "",
      param: null,
    };
    const envelope = {
      error: {
        type: error.type,
        code: error.code,
        message: error.message,
        param: error.param,
      },
    };
    let responseBody = JSON.stringify(envelope);
    const leak =
      (this.#faults.has("wire-leak-token-401") && status === 401) ||
      this.#faults.has("leak-token-error");
    if (leak) responseBody = `{"error":{"code":"${error.code}","message":"denied wrong-token"}}`;
    state.wire.push({
      requestBody: this.#requestBody(request),
      responseBody,
      responseKind: "json",
    });
  }

  /** 请求体序列化：`mist.interaction_response` 用 snake_case（`interaction_id`/`option_id`）。 */
  #requestBody(request: FrontendChatRequest): string {
    const interactionResponse = request.mist?.interactionResponse;
    const camelResponse = this.#faults.has("wire-camel-interaction-response");
    return JSON.stringify({
      model: request.model,
      stream: request.stream,
      messages: request.messages,
      mist: {
        client: request.mist?.client ?? null,
        interaction_response:
          interactionResponse === undefined
            ? null
            : camelResponse
              ? {
                  interactionId: interactionResponse.interactionId,
                  optionId: interactionResponse.optionId,
                }
              : {
                  interaction_id: interactionResponse.interactionId,
                  option_id: interactionResponse.optionId,
                },
        task_kind: request.mist?.taskKind ?? null,
      },
    });
  }

  #writeIngressAttachments(state: StoredBinding, request: FrontendChatRequest): void {
    const current = request.messages.at(-1);
    if (current === undefined || !Array.isArray(current.content)) return;
    for (const [index, part] of current.content.entries()) {
      const item = attachmentFromPart(part, index, this.#ingressIdPrefix);
      if (item !== null) this.#writeAttachment(state, item);
    }
  }

  /** 当前 user content 是否可解析：字符串，或至少含一个已知 content-part。 */
  #contentParseable(content: unknown): boolean {
    if (typeof content === "string") return true;
    if (!Array.isArray(content)) return false;
    return content.every(
      (part) =>
        typeof part === "object" &&
        part !== null &&
        (part.type === "text" || part.type === "file" || part.type === "image_url"),
    );
  }

  #networkAttempt(state: StoredBinding, url: string, reasonCode: string): NetworkAttemptRecord {
    const parsed = new URL(url);
    return {
      attemptId: `attempt:${++this.#sequence}`,
      host: parsed.host,
      scheme: parsed.protocol === "https:" ? "https" : "http",
      reasonCode,
      residentId: state.binding.residentId,
      scopeId: state.binding.scopeId,
    };
  }

  #writeAttachment(state: StoredBinding, item: StructuredAttachment): void {
    const wrongOwner = this.#faults.has("attachment-write-wrong-owner");
    state.attachmentWrites.push({
      attachmentId: item.attachmentId,
      kind: item.kind,
      filename: item.filename,
      mediaType: item.mediaType,
      sizeBytes: item.sizeBytes,
      source: item.source,
      bindingId: wrongOwner ? `${state.binding.bindingId}:other` : state.binding.bindingId,
      residentId: state.binding.residentId,
      scopeId: state.binding.scopeId,
      streamId: wrongOwner ? `${state.binding.streamId}:elsewhere` : state.binding.streamId,
      writerId: wrongOwner ? "writer:attachment-rogue" : state.binding.canonicalWriterId,
    });
  }

  /** 错误注入用：命中 skip 时不落私有附件面写入，但调用方仍照常回读/落账。 */
  #maybeWriteAttachment(state: StoredBinding, item: StructuredAttachment, skip: boolean): void {
    if (skip) return;
    this.#writeAttachment(state, item);
  }

  #encodeWire(
    request: FrontendChatRequest,
    input: {
      id: string;
      text: string;
      streamId: string;
      model: string;
      attachments: StructuredAttachment[];
      interaction: StructuredInteraction | null;
      projection: SurfaceProjection;
    },
  ): RawWireExchange {
    const wireModel = this.#faults.has("wire-client-model") ? request.model : input.model;
    const wireStreamId = this.#faults.has("wire-stream-id-mismatch")
      ? `${input.streamId}:mismatch`
      : input.streamId;
    const wireText = this.#faults.has("wire-normalized-diverges")
      ? `${input.text}:diverged`
      : input.text;
    const requestBody = this.#requestBody(request);
    if (request.stream) {
      const mist: Record<string, unknown> = {
        stream_id: wireStreamId,
        attachments: input.attachments.map((item) =>
          wireAttachment(item, this.#faults.has("wire-textual-attachment")),
        ),
        interaction:
          input.interaction === null || this.#faults.has("sse-drop-stream-interaction")
            ? null
            : wireInteraction(input.interaction, this.#faults.has("wire-interaction-drop-options")),
        projection: wireProjection(input.projection, this.#faults.has("wire-camel-projection")),
      };
      if (input.streamId === "stream:fe02") {
        if (this.#faults.has("sse-missing-attachments")) mist.attachments = undefined;
        if (this.#faults.has("sse-missing-interaction")) mist.interaction = undefined;
      }
      const frames = this.#faults.has("wire-bad-sse")
        ? [
            encodeChunk({
              id: input.id,
              model: wireModel,
              delta: { role: "assistant", content: wireText },
              finishReason: "stop",
            }),
          ]
        : [
            encodeChunk({
              id: input.id,
              model: wireModel,
              delta: { role: "assistant", content: wireText },
              finishReason: null,
            }),
            encodeChunk({
              id: input.id,
              model: wireModel,
              delta: {},
              finishReason: "stop",
              mist,
            }),
          ];
      const done = this.#faults.has("wire-bad-sse") ? "" : "data: [DONE]\n\n";
      if (this.#faults.has("wire-bad-delta")) {
        const first = frames[0];
        if (first !== undefined)
          first.choices = [
            { index: 0, delta: { role: "user", content: wireText }, finish_reason: null },
          ];
      }
      let responseBody =
        frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + done;
      if (this.#faults.has("wire-bad-framing")) responseBody = responseBody.replace(/\n\n/g, "\n");
      if (this.#faults.has("wire-leak-token-sse")) {
        responseBody += `data: ${JSON.stringify({ leaked: "wrong-token" })}\n\n`;
      }
      return { requestBody, responseBody, responseKind: "sse" };
    }
    const envelope = encodeCompletionBody({
      id: input.id,
      model: wireModel,
      text: wireText,
      streamId: wireStreamId,
      attachments: input.attachments,
      interaction: input.interaction,
      projection: input.projection,
      object: this.#faults.has("wire-bad-envelope") ? "chat.completion.chunk" : undefined,
      dropChoices: this.#faults.has("wire-bad-envelope"),
      camelProjection: this.#faults.has("wire-camel-projection"),
      textualAttachment: this.#faults.has("wire-textual-attachment"),
      dropInteractionOptions: this.#faults.has("wire-interaction-drop-options"),
    });
    return { requestBody, responseBody: JSON.stringify(envelope), responseKind: "json" };
  }

  #audit(context: FrontendRequestContext, result: "accepted" | "rejected", code: string): void {
    if (this.#faults.has("audit-missing-entry") && this.#security.attempts === 3) return;
    this.#security.entries.push({
      source: this.#faults.has("audit-wrong-source") ? "remote" : context.source,
      result: this.#faults.has("audit-wrong-result") ? "accepted" : result,
      code: this.#faults.has("audit-wrong-code") ? "UNKNOWN" : code,
    });
    if (this.#faults.has("audit-wrong-order") && this.#security.entries.length === 2)
      this.#security.entries.reverse();
  }

  #findInteraction(interactionId: string): StoredInteraction | null {
    for (const state of this.#bindings.values()) {
      const found = state.interactions.get(interactionId);
      if (found !== undefined) return found;
    }
    return null;
  }

  #state(bindingId: string): StoredBinding {
    const state = this.#bindings.get(bindingId);
    if (state === undefined) throw new Error(`unknown binding: ${bindingId}`);
    return state;
  }

  #error(status: number, code: string): FrontendResponse {
    const message = this.#faults.has("leak-token-error") ? `${code}: wrong-token` : code;
    return {
      status,
      error: { code, type: "fixture_error", message, param: null },
      body: null,
      chunks: [],
    };
  }

  #event(
    state: StoredBinding,
    kind: CanonicalEventReadback["kind"],
    input: {
      text?: string;
      attachment?: StructuredAttachment;
      interaction?: CanonicalEventReadback["interaction"];
      projection?: CanonicalEventReadback["projection"];
      context?: FrontendRequestContext;
      directWriter?: boolean;
      resolvedOptionId?: string | null;
    },
  ): CanonicalEventReadback {
    const writerId =
      input.directWriter === true || this.#faults.has("direct-writer")
        ? "writer:adapter-direct"
        : state.binding.canonicalWriterId;
    const leakedText =
      this.#faults.has("leak-token-canonical") && input.text !== undefined
        ? `${input.text} ${state.binding.token}`
        : input.text;
    let interaction = input.interaction ?? null;
    if (interaction !== null && this.#faults.has("canonical-drop-options")) {
      // 错误行为：canonical 事件里把 options 清空，但返回给调用方的 body 仍完整。
      interaction = { ...structuredClone(interaction), options: [] };
    }
    const resolvedOptionId =
      this.#faults.has("canonical-resolution-no-option") &&
      (input.resolvedOptionId ?? null) !== null
        ? null
        : (input.resolvedOptionId ?? null);
    const attachment =
      this.#faults.has("webui-canonical-egress-metadata-drop") &&
      input.attachment?.filename === "webui-outbound.txt"
        ? { ...input.attachment, sizeBytes: input.attachment.sizeBytes + 1 }
        : (input.attachment ?? null);
    return {
      eventId: `event:${++this.#sequence}`,
      residentId: state.binding.residentId,
      scopeId: state.binding.scopeId,
      streamId: state.binding.streamId,
      writerId,
      kind,
      text: leakedText ?? null,
      attachment,
      interaction,
      projection: input.projection ?? null,
      resolvedOptionId,
    };
  }
}

function clone(driver: FrontendAdapterDriver): FrontendAdapterDriver {
  return cloneFrontendAdapterDriverBoundary(driver);
}

describe("#218 frontend adapter acceptance contract", () => {
  it("freezes FE-01～FE-07 in order without duplicates", () => {
    const ids = frontendAdapterChecks.map((check) => check.id);
    expect(ids).toEqual([...expectedFrontendAdapterCheckIds]);
    expect(new Set(ids).size).toBe(7);
  });

  it("pairs every executable check with one unchecked markdown lamp", () => {
    const markdown = readFileSync(join(repoRoot, "acceptance/frontend-adapter.md"), "utf8");
    for (const id of expectedFrontendAdapterCheckIds) {
      expect(markdown, `${id} should own an unchecked lamp`).toContain(`- [ ] **${id} `);
      expect(markdown, `${id} must not be pre-lit`).not.toContain(`- [x] **${id} `);
    }
    expect(markdown).not.toContain("- [x]");
  });

  it("declares only real driver methods and resets after every lamp", () => {
    const methodNames = new Set<keyof FrontendAdapterDriver>([
      "reset",
      "runInstaller",
      "readLegacyOfficialSkin",
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
      "readSecurityAudit",
      "runWebuiCommand",
      "sendWebuiCompletion",
      "readWebuiAudit",
    ]);
    for (const check of frontendAdapterChecks) {
      expect(check.uses).toContain("reset");
      expect(check.uses.length).toBeGreaterThan(1);
      for (const method of check.uses) {
        expect(methodNames.has(method), `${check.id} uses unknown ${method}`).toBe(true);
      }
    }
  });

  it("accepts one complete synthetic positive shape for all seven lamps", async () => {
    const driver = clone(new FixtureDriver());
    for (const check of frontendAdapterChecks) {
      const result = await check.run(driver);
      expect(result.passed, `${check.id}: ${result.detail}`).toBe(true);
    }
  });

  it("accepts three current projection references including the displayed structure", async () => {
    const check = frontendAdapterChecks.find((c) => c.id === "FE-05");
    if (check === undefined) throw new Error("missing FE-05");
    const result = await check.run(clone(new FixtureDriver(["projection-three-current"])));
    expect(result.passed, result.detail).toBe(true);
  });

  it("accepts canonical auxiliary events between text events", async () => {
    for (const id of ["FE-02", "FE-04"]) {
      const check = frontendAdapterChecks.find((c) => c.id === id);
      if (check === undefined) throw new Error(`missing ${id}`);
      const result = await check.run(clone(new FixtureDriver(["auxiliary-events"])));
      expect(result.passed, result.detail).toBe(true);
    }
  });

  it("accepts a host that reuses its installed WebUI service without reinstalling", async () => {
    const driver = clone(new FixtureDriver([], "ingress", true));
    const target = await driver.provisionBinding({
      residentId: "resident:webui-reuse",
      scopeId: "scope:webui-reuse",
      label: "webui-reuse",
    });
    const first = await driver.runWebuiCommand(target.bindingId, {
      confirmed: true,
      environment: { docker: false, python: true },
    });
    expect(first.status).toBe("started");
    expect(first.runtimeUsed).toBe("python");
    const before = await driver.readWebuiAudit();
    const reused = await driver.runWebuiCommand(target.bindingId, {
      confirmed: true,
      environment: { docker: true, python: false },
    });
    expect(reused).toEqual(first);
    expect(await driver.readWebuiAudit()).toEqual(before);
    expect(before.installGateCalls).toBe(1);
    expect(before.startedServiceIds).toEqual([first.serviceId]);
    await driver.reset();
    const check = frontendAdapterChecks.find((candidate) => candidate.id === "FE-07");
    if (check === undefined) throw new Error("missing check FE-07");
    const result = await check.run(driver);
    expect(result.passed, result.detail).toBe(true);
  });

  it.each([
    ["FE-02", "fe02-swap-roles"],
    ["FE-02", "fe02-all-assistant"],
    ["FE-02", "fe02-reverse-text-order"],
    ["FE-02", "sse-missing-attachments"],
    ["FE-02", "sse-missing-interaction"],
    ["FE-03", "trust-developer-history"],
    ["FE-03", "trust-tool-history"],
    ["FE-03", "developer-audit-history"],
    ["FE-04", "fe04-wrong-resident"],
    ["FE-04", "fe04-wrong-scope"],
    ["FE-04", "fe04-wrong-writer"],
    ["FE-04", "fe04-no-second-append"],
    ["FE-04", "fe04-wrong-current-text"],
    ["FE-05", "projection-old-events"],
    ["FE-05", "projection-missing-structure"],
    ["FE-05", "projection-empty"],
    ["FE-05", "choice-projection-missing-structure"],
    ["FE-05", "approval-wrong-resolution-id"],
    ["FE-05", "approval-wrong-interaction"],
    ["FE-05", "approval-invokes-model"],
    ["FE-06", "auth-records-zero-count"],
    ["FE-06", "audit-wrong-source"],
    ["FE-06", "audit-wrong-code"],
    ["FE-06", "audit-wrong-result"],
    ["FE-06", "audit-missing-entry"],
    ["FE-06", "audit-wrong-order"],
    // FE-01
    ["FE-01", "legacy-rewrite"],
    // FE-02：坏 wire / 回显客户端 model / 归一化与 wire 背离 / utility 不拒绝
    ["FE-02", "direct-writer"],
    ["FE-02", "wire-bad-envelope"],
    ["FE-02", "wire-bad-sse"],
    ["FE-02", "wire-bad-framing"],
    ["FE-02", "wire-bad-delta"],
    ["FE-02", "wire-client-model"],
    ["FE-02", "wire-stream-id-mismatch"],
    ["FE-02", "wire-normalized-diverges"],
    ["FE-02", "wire-camel-projection"],
    ["FE-02", "utility-not-refused"],
    ["FE-02", "utility-writes-attachment"],
    // FE-03
    ["FE-03", "trust-request-history"],
    ["FE-03", "forgive-empty-messages"],
    ["FE-03", "forgive-non-user-last"],
    ["FE-03", "forgive-unparseable-content"],
    // FE-04
    ["FE-04", "split-stream"],
    // FE-05：摊平 / 丢 options / 忽略点击 / 文字解决 / 重复解决 / 外来响应 / 错 option
    ["FE-05", "flatten-interaction"],
    ["FE-05", "drop-interaction-options"],
    ["FE-05", "ignore-interaction-response"],
    ["FE-05", "plain-text-resolves"],
    ["FE-05", "duplicate-resolves"],
    ["FE-05", "accept-foreign-interaction"],
    ["FE-05", "wrong-option-accepted"],
    ["FE-05", "control-invokes-model"],
    ["FE-05", "attachment-metadata-drop"],
    ["FE-05", "native-projection-missing"],
    ["FE-05", "canonical-drop-options"],
    ["FE-05", "canonical-resolution-no-option"],
    ["FE-05", "wire-textual-attachment"],
    ["FE-05", "wire-interaction-drop-options"],
    ["FE-05", "wire-camel-interaction-response"],
    ["FE-05", "fetch-remote-image"],
    ["FE-05", "remote-image-writes-attachment"],
    ["FE-05", "sse-drop-stream-interaction"],
    ["FE-05", "attachment-write-wrong-owner"],
    // 从 FE-07 迁入的 WebUI 结构链路专用 mutation，继续在 FE-05 执行。
    ["FE-05", "webui-skip-attachment-writes"],
    ["FE-05", "webui-canonical-egress-metadata-drop"],
    // FE-06：loopback 豁免 / 鉴权先写附件 / token 泄漏进 error.message、body.id、canonical、401 wire、SSE wire、审计 detail
    ["FE-06", "loopback-bypass"],
    ["FE-06", "auth-writes-attachment"],
    ["FE-06", "leak-token-error"],
    ["FE-06", "leak-token-body-id"],
    ["FE-06", "leak-token-canonical"],
    ["FE-06", "wire-leak-token-401"],
    ["FE-06", "wire-leak-token-sse"],
    ["FE-06", "leak-token-audit-detail"],
    // FE-07：绕过安装闸 / WebUI 直写 / 绕过鉴权 / 认伪造历史 / 第二条流 / utility 不拒绝
    ["FE-07", "bypass-install-gate"],
    ["FE-07", "webui-direct-writer"],
    ["FE-07", "webui-bypass-auth"],
    ["FE-07", "webui-trust-history"],
    ["FE-07", "webui-split-stream"],
    ["FE-07", "webui-utility-not-refused"],
    ["FE-07", "webui-skip-proposal"],
    ["FE-07", "webui-wrong-category"],
    ["FE-07", "webui-cancel-proposal-empty"],
    ["FE-07", "webui-proposal-identity-mismatch"],
    ["FE-07", "webui-install-before-confirm"],
    ["FE-07", "webui-python-only-uses-docker"],
    ["FE-07", "webui-docker-only-uses-python"],
  ] as const)(
    "%s rejects its targeted false-green mutation (%s)",
    async (id: (typeof expectedFrontendAdapterCheckIds)[number], fault: Fault) => {
      const check = frontendAdapterChecks.find((candidate) => candidate.id === id);
      if (check === undefined) throw new Error(`missing check ${id}`);
      const result = await check.run(clone(new FixtureDriver([fault])));
      expect(result.passed, result.detail).toBe(false);
    },
  );

  it("copies request objects and readbacks at the driver boundary (D27)", async () => {
    const driver = clone(new FixtureDriver());
    const target = await driver.provisionBinding({
      residentId: "resident:boundary",
      scopeId: "scope:boundary",
      label: "boundary",
    });
    await driver.queueResidentReply(target.bindingId, { kind: "text", text: "boundary-reply" });
    const first = await driver.sendCompletion(
      target.bindingId,
      { token: target.token, source: "remote", conversationId: null },
      { model: "client-model", stream: false, messages: [{ role: "user", content: "turn-1" }] },
    );
    // 改写第一次返回值不改变驱动内部状态（边界深拷贝）。
    (first as unknown as { body: { text: string } }).body.text = "mutated";
    await driver.queueResidentReply(target.bindingId, { kind: "text", text: "boundary-reply-2" });
    const second = await driver.sendCompletion(
      target.bindingId,
      { token: target.token, source: "remote", conversationId: null },
      { model: "client-model", stream: false, messages: [{ role: "user", content: "turn-2" }] },
    );
    expect(second.status).toBe(200);
    const events = await driver.readCanonicalEvents(target.bindingId);
    expect(events.map((event) => event.text)).toContain("boundary-reply");
    expect(events.map((event) => event.text)).not.toContain("mutated");
  });

  it("redacts tokens in another lamp's diagnostic without changing the wire evidence", async () => {
    const check = frontendAdapterChecks.find((candidate) => candidate.id === "FE-02");
    if (check === undefined) throw new Error("missing FE-02");
    const result = await check.run(
      clone(new FixtureDriver(["wire-normalized-diverges", "leak-token-body-id"])),
    );
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("[redacted]");
    expect(result.detail).not.toContain("token:fe02");
  });

  it("accepts host-owned opaque attachment ids without requiring the fixture naming scheme", async () => {
    const check = frontendAdapterChecks.find((candidate) => candidate.id === "FE-05");
    if (check === undefined) throw new Error("missing FE-05");
    const result = await check.run(clone(new FixtureDriver([], "opaque:alternate")));
    expect(result.passed, result.detail).toBe(true);
  });
});

describe("#218 judging runner", () => {
  function runRunner(
    args: readonly string[],
    env: Record<string, string> = {},
  ): { status: number | null; stdout: string } {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", join(repoRoot, "acceptance/frontend-adapter-run.ts"), ...args],
      { cwd: repoRoot, encoding: "utf8", env: { ...process.env, ...env } },
    );
    return { status: result.status, stdout: `${result.stdout}${result.stderr}` };
  }

  it("reports seven explicit red lamps in the isolated missing-driver scenario", () => {
    // 生产驱动已经落地，所以「缺驱动七红」只在隔离场景里核验：把驱动路径指到一个
    // 不存在的 specifier，验证 runner 仍如实打印七盏缺驱动红灯，而不是把坏驱动伪装成起点。
    const missing = {
      MIST_FRONTEND_ADAPTER_DRIVER: "../src/__missing_frontend_adapter_driver__.ts",
    };
    const report = runRunner([], missing);
    expect(report.status).toBe(0);
    for (const id of expectedFrontendAdapterCheckIds) {
      expect(report.stdout).toContain(`🔴 ${id} 缺驱动`);
    }
    expect(report.stdout).toContain("真绿 0 / 7");

    const strict = runRunner(["--strict"], missing);
    expect(strict.status).toBe(1);
    expect(strict.stdout).toContain("真绿 0 / 7");
  });

  it("wires the production driver: D31-1 text lamps green, FE-05 red", () => {
    expect(existsSync(join(repoRoot, "src/frontend-adapter-acceptance-driver.ts"))).toBe(true);
    const report = runRunner([]);
    // D31-1 只交文字聊天 + /webui：FE-01～FE-04、FE-06、FE-07 真绿；FE-05 按裁定保持红。
    for (const id of ["FE-01", "FE-02", "FE-03", "FE-04", "FE-06", "FE-07"]) {
      expect(report.stdout, `${id} should be true-green`).toContain(`🟢 ${id}`);
    }
    expect(report.stdout).toContain("🔴 FE-05");
    expect(report.stdout).toContain("真绿 6 / 7");

    // strict 因 FE-05 非零退出；D31-1 预期如此，不冒充全绿。
    const strict = runRunner(["--strict"]);
    expect(strict.status).toBe(1);
    expect(strict.stdout).toContain("真绿 6 / 7");
  });
});
