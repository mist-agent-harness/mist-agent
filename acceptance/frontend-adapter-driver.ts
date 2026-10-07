/**
 * #218 / D31 的可选网页前端验收驱动契约。
 *
 * 判卷只通过本接口观察安装器、OpenAI-compatible adapter 与 `/webui` 安装闸，
 * 不 import `src/` 实现。实现方在 `src/frontend-adapter-acceptance-driver.ts` 导出
 * `createFrontendAdapterDriver()`；驱动缺失时 FE-01～FE-07 全部保持红色。
 */

export type Result<T> = { ok: true; value: T } | { ok: false; reason: string };

export type ClientCapability = "attachments" | "interactions";
export type RequestSource = "loopback" | "remote";
export type FrontendRole = "system" | "developer" | "user" | "assistant" | "tool";

export type FrontendContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }
  | {
      type: "file";
      file: {
        filename: string;
        file_data?: string;
        file_id?: string;
      };
    };

export interface FrontendMessage {
  role: FrontendRole;
  content: string | FrontendContentPart[];
  name?: string;
  tool_call_id?: string;
}

export interface FrontendChatRequest {
  model: string;
  messages: FrontendMessage[];
  stream: boolean;
  user?: string;
  metadata?: Record<string, string>;
  mist?: {
    client?: {
      surface: string;
      capabilities: ClientCapability[];
    };
    interactionResponse?: {
      interactionId: string;
      optionId: string;
    };
    /**
     * Open WebUI 等前端会把 title / tag / follow-up 之类的后台 utility task 发给当前聊天模型；
     * 这类请求形状与普通单条 `role: "user"` completion 无法区分。前端必须用一个显式 task hint
     * 标出来；契约只把这个 hint 用来 **拒绝**，不许它改变身份、授权，也不许它开第二条模型路由。
     * 线上 snake_case 写 `task_kind`；空串或缺失按「不是 utility 请求」处理。
     */
    taskKind?: string;
  };
}

export interface FrontendRequestContext {
  token: string | null;
  source: RequestSource;
  conversationId: string | null;
}

export interface StructuredAttachment {
  attachmentId: string;
  kind: "image" | "file";
  filename: string;
  mediaType: string;
  sizeBytes: number;
  source: "inline" | "opaque-ref";
}

export interface StructuredInteractionOption {
  optionId: string;
  label: string;
  description: string | null;
}

export interface StructuredInteraction {
  interactionId: string;
  kind: "choice" | "approval" | "blocked";
  prompt: string;
  blocking: true;
  options: StructuredInteractionOption[];
  reasonCode: string | null;
}

/**
 * 服务端根据 client 声明能力作出的投影决策。
 *
 * 它能证明 adapter 发出了 native / degraded / blocked 中哪一种形态，不能证明浏览器或其他
 * client 最终真的渲染成功。真实 UI acknowledgment 若以后需要，必须另立带 request/event id 的
 * 回传契约，不能把本对象升级解释成客户端回执。
 */
export interface SurfaceProjection {
  status: "native" | "degraded" | "blocked";
  missingCapabilities: ClientCapability[];
  canonicalEventIds: string[];
}

export interface FrontendError {
  code: string;
  type: string;
  message: string;
  param: string | null;
}

export interface FrontendCompletionBody {
  id: string;
  model: string;
  streamId: string;
  text: string;
  attachments: StructuredAttachment[];
  interaction: StructuredInteraction | null;
  projection: SurfaceProjection;
}

export interface FrontendStreamChunk {
  textDelta: string;
  attachments: StructuredAttachment[];
  interaction: StructuredInteraction | null;
  projection: SurfaceProjection | null;
  done: boolean;
}

/**
 * 合成 transport 上实际进出的原始字节。不做任何归一化：非流式响应是标准 Chat Completions
 * JSON 文本，流式响应是 `data: ...` 的 SSE 文本。判卷独立解析它，用来核「归一化值与 wire 互相对应」，
 * 而不是拿归一化对象自证。
 */
export interface RawWireExchange {
  /** 请求体原文（线协议字节）。 */
  requestBody: string;
  /** 响应体原文；非流式为 JSON 文本，流式为 SSE 文本。 */
  responseBody: string;
  responseKind: "json" | "sse";
}

/**
 * 交互（choice / approval / blocked）的耐久状态读回口。
 *
 * `status` 是服务端按 interaction id、现行住户/scope、未解决状态与 option id 逐项核验后的
 * 权威状态；`resolutionEventId` 指向这条交互在 canonical stream 里的追加记录（append-only），
 * pending 时为 null。它不是浏览器渲染回执。
 */
export interface InteractionReadback {
  interactionId: string;
  kind: "choice" | "approval" | "blocked";
  prompt: string;
  blocking: true;
  options: StructuredInteractionOption[];
  reasonCode: string | null;
  status: "pending" | "resolved";
  resolvedOptionId: string | null;
  resolutionEventId: string | null;
}

/**
 * 私有附件面的写入读回。只回 opaque 元数据与计数，**不回字节**——
 * 判卷用它证明「鉴权/utility 失败没有先落附件字节再靠 canonical 数为零冒充零副作用」。
 */
export interface AttachmentWriteRecord {
  attachmentId: string;
  kind: "image" | "file";
  filename: string;
  mediaType: string;
  sizeBytes: number;
  source: "inline" | "opaque-ref";
  /** 写入归属：与 canonical 权威一致。 */
  bindingId: string;
  residentId: string;
  scopeId: string;
  streamId: string;
  /**
   * canonical 写入归属（与 `CanonicalEventReadback.writerId` 同一权威），
   * 不是另一个独立的「附件 writer」。
   */
  writerId: string;
}

export interface AttachmentWriteReadback {
  count: number;
  records: AttachmentWriteRecord[];
}

/**
 * 远程 image_url 抓取尝试的审计读回。
 *
 * 图纸 §4.1 禁止 adapter 代抓任意 `http(s)` URL（SSRF 边界）。这个读口只暴露
 * **真实 transport 上发生过的抓取尝试**的 opaque 元数据与归属，不导出 URL 查询串、
 * token、原始响应字节或任何凭证。
 *
 * 合同是**零抓取尝试**：任何真实抓取尝试——即使随后被策略 blocked、没有取回字节——
 * 都必须如实登记，FE-05 据此判红。不存在「尝试了但没写字节就算过」的情形。
 */
export interface NetworkAttemptRecord {
  /** opaque attempt id；同一 binding 内唯一。 */
  attemptId: string;
  /** 只记 host（不含 path/query），不足以重放敏感内容。 */
  host: string;
  scheme: "http" | "https";
  /** 稳定拒绝 code，与响应 error code 一致。 */
  reasonCode: string;
  residentId: string;
  scopeId: string;
}

export interface NetworkAttemptReadback {
  attempts: number;
  records: NetworkAttemptRecord[];
}

/**
 * `/webui` 安装前展示给主人的提案。判卷用它核「展示的组件、资源占用与将启动服务」
 * 与「实际经闸安装的插件」对得上，不用固定字面 host id。
 */
export interface WebuiInstallProposal {
  /** 本次提案身份；确认与安装闸必须引用同一个 id。 */
  proposalId: string;
  /** 宿主签发的 opaque 插件 id；判卷不假设其字面。 */
  pluginId: string;
  /** 插件类别；必须落在已冻结的 `frontend` 类别，不能走别的闸。 */
  category: string;
  /** 人类可读组件名，用于确认展示的是 Open WebUI。 */
  displayName: string;
  /** 展示的资源占用估计。 */
  resourceUsage: { diskBytes: number; memoryBytes: number };
  /** 展示的将启动服务 opaque id；必须与启动读回一致。 */
  servicesToStart: string[];
}

export interface FrontendResponse {
  status: number;
  error: FrontendError | null;
  body: FrontendCompletionBody | null;
  chunks: FrontendStreamChunk[];
}

export interface AdapterBinding {
  bindingId: string;
  endpointId: string;
  residentId: string;
  scopeId: string;
  streamId: string;
  token: string;
  serverModel: string;
  canonicalWriterId: string;
}

export type ResidentReply =
  | { kind: "text"; text: string }
  | { kind: "attachment"; text: string; attachments: StructuredAttachment[] }
  | { kind: "interaction"; text: string; interaction: StructuredInteraction };

export interface ModelTurnReadback {
  residentId: string;
  scopeId: string;
  canonicalHistoryText: string[];
  currentText: string;
  attachments: StructuredAttachment[];
  /** Client 声明的呈现能力，只影响投影，不是鉴权或真实渲染事实。 */
  surfaceCapabilities: ClientCapability[];
}

export interface CanonicalEventReadback {
  eventId: string;
  residentId: string;
  scopeId: string;
  streamId: string;
  writerId: string;
  /** `surface-projection` 只收录 adapter 投影决策，不代表 client 已确认渲染。 */
  kind: "user" | "assistant" | "attachment" | "interaction" | "surface-projection";
  text: string | null;
  attachment: StructuredAttachment | null;
  interaction: StructuredInteraction | null;
  projection: SurfaceProjection | null;
  /**
   * 仅交互 resolution 事件非 null：这次控制实际选了哪个 option。它让「选了什么」可归属到
   * canonical 记录本身，而不是只能靠 readback 自称的 eventId 反查。
   */
  resolvedOptionId: string | null;
}

export interface InstallerRunReadback {
  committed: boolean;
  defaulted: boolean;
  frontend: { kind: "terminal" } | { kind: "external"; integration: "openai-compatible" };
}

export interface LegacyFrontendReadback {
  ok: boolean;
  code: string;
  remedy: string;
  rewritten: boolean;
  bytesAfter: string;
}

/** 按实际鉴权尝试顺序读回；accepted 只表示鉴权通过，不等于 completion 成功。 */
export interface SecurityAuditEntry {
  source: RequestSource;
  result: "accepted" | "rejected";
  /** AUTH_REQUIRED / AUTH_INVALID / AUTH_ACCEPTED；不含 token 或请求正文。 */
  code: string;
}

export interface SecurityAuditReadback {
  attempts: number;
  accepted: number;
  entries: SecurityAuditEntry[];
  logs: string[];
  receipts: string[];
}

export interface WebuiEnvironment {
  docker: boolean;
  python: boolean;
}

export type WebuiRuntime = "docker" | "python";

export interface WebuiCommandReadback {
  status: "cancelled" | "missing-runtime" | "started";
  missing: Array<"docker" | "python">;
  serviceId: string | null;
  url: string | null;
  endpointId: string | null;
  /** 从实际启动的服务配置读回所用 runtime；未启动时为 null，不是根据 environment 推测。 */
  runtimeUsed: WebuiRuntime | null;
  /** 本次展示的提案身份；走安装流程（含展示后取消）时必须非 null。 */
  proposalId: string | null;
  /**
   * 本次被消费的合成确认决定；缺环境只报告、未进入确认安装时为 null。
   * 取消是合法决定（`"cancelled"`），不代表没有展示提案。
   */
  confirmation: "confirmed" | "cancelled" | null;
  /** 实际经闸安装的插件身份；只有 started 时非 null，且必须与提案一致。 */
  installedPlugin: { pluginId: string; category: string } | null;
}

/**
 * `/webui` 安装流程的有序操作记录，用来把「展示 → 确认 → 经闸安装」的顺序做成可检查证据。
 * 它是宿主安装流程的操作日志，不是浏览器 UI 回执。当前只用合成安装替身验证这个合同，
 * 不冒充真实渲染确认。
 */
export type WebuiOperation =
  | { kind: "proposal"; proposalId: string; pluginId: string; category: string }
  | { kind: "confirmation"; proposalId: string; confirmed: boolean }
  | {
      kind: "install";
      proposalId: string;
      pluginId: string;
      category: string;
      runtimeUsed: WebuiRuntime;
    };

export interface WebuiAuditReadback {
  installGateCalls: number;
  systemInstallAttempts: number;
  startedServiceIds: string[];
  endpointIds: string[];
  /** 本次运行实际展示过的提案（展示后取消也算展示过）。 */
  proposals: WebuiInstallProposal[];
  /** 有序操作日志：proposal → confirmation → install，按 proposal id 归属。 */
  operations: WebuiOperation[];
}

export interface FrontendAdapterDriver {
  /** 每盏灯后清掉合成安装、住户、token、流水、服务与审计记录。 */
  reset(): Promise<void>;

  runInstaller(input: { frontend: "default" | "external" }): Promise<InstallerRunReadback>;
  readLegacyOfficialSkin(rawConfig: string): Promise<LegacyFrontendReadback>;

  provisionBinding(input: {
    residentId: string;
    scopeId: string;
    label: string;
  }): Promise<AdapterBinding>;
  seedCanonicalHistory(bindingId: string, text: string[]): Promise<void>;
  queueResidentReply(bindingId: string, reply: ResidentReply): Promise<void>;
  sendCompletion(
    bindingId: string,
    context: FrontendRequestContext,
    request: FrontendChatRequest,
  ): Promise<FrontendResponse>;
  /**
   * 本轮进出的原始 wire（请求体 + 响应体原文），判卷独立解析，不拿归一化对象自证。
   * 成功响应、鉴权失败与 utility 拒绝都必须留下原始记录：401/400 的响应原文也要能被扫，
   * 不能因为「没落模型」就假设没有 wire。请求记录不得携带 `Authorization` 或 token 原文。
   */
  readRawWire(bindingId: string): Promise<RawWireExchange[]>;
  readModelTurns(bindingId: string): Promise<ModelTurnReadback[]>;
  readCanonicalEvents(bindingId: string): Promise<CanonicalEventReadback[]>;
  /** 交互的耐久 pending / resolved 状态；拒绝必须不改变既有状态，也不产生新 effect。 */
  readInteractions(bindingId: string): Promise<InteractionReadback[]>;
  /** 私有附件面写入读回（opaque 元数据 + 计数，无字节），用于证明失败路径零附件副作用。 */
  readAttachmentWrites(): Promise<AttachmentWriteReadback>;
  /**
   * 远程抓取尝试审计读回（SSRF 边界）。只暴露真实 transport 上发生过的尝试的 opaque
   * 元数据与归属，不回 URL 查询串/token/字节。拒绝前的尝试也须如实登记。
   */
  readNetworkAttempts(): Promise<NetworkAttemptReadback>;
  readSecurityAudit(): Promise<SecurityAuditReadback>;

  runWebuiCommand(
    bindingId: string,
    input: { confirmed: boolean; environment: WebuiEnvironment },
  ): Promise<WebuiCommandReadback>;
  sendWebuiCompletion(
    serviceId: string,
    context: FrontendRequestContext,
    request: FrontendChatRequest,
  ): Promise<FrontendResponse>;
  readWebuiAudit(): Promise<WebuiAuditReadback>;
}

export interface FrontendAdapterCheckResult {
  passed: boolean;
  detail: string;
}

export interface FrontendAdapterCheck {
  id: string;
  title: string;
  uses: Array<keyof FrontendAdapterDriver>;
  run(driver: FrontendAdapterDriver): Promise<FrontendAdapterCheckResult>;
}

/**
 * D27 三：判卷在驱动边界统一深拷贝入参与返回值，一次消掉别名类问题，
 * 不在每个调用点逐一冻结。
 *
 * 验收灯面向**非对抗驱动**：假定驱动如实回读自己的状态。这层代理挡的是
 * 「无心写成别名」，不是「存心在两次观察之间作弊」——后者归代码评审与验收席。
 */
export function cloneFrontendAdapterDriverBoundary(
  driver: FrontendAdapterDriver,
): FrontendAdapterDriver {
  return new Proxy(driver, {
    get(target, property) {
      const member = Reflect.get(target, property, target);
      if (typeof member !== "function") return member;
      return async (...args: unknown[]) => {
        const result = await Reflect.apply(member, target, structuredClone(args));
        return structuredClone(result);
      };
    },
  });
}
