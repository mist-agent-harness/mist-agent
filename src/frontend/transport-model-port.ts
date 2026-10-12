import type { ResidentReply } from "../../acceptance/frontend-adapter-driver.ts";
/**
 * 把现役住户运行时的 `ModelTransport`（`src/resident-runtime/channels.ts`，D25 通道层）
 * 桥接成前端适配层的 `FrontendModelPort`。
 *
 * 普通范围里可真实接通的承载：
 *   - 入站**受支持图片**经私有 attachmentPort 读真实字节，作为 Pi 原生 `images` 块
 *     （base64 + mimeType）随 prompt 进子进程；不是把 base64/路径塞进文本。
 *   - 纯文本回合与既有文本调用完全兼容（surface capabilities 只影响声明，不改路由）。
 *   - **不支持的入站结构**（非图片文件、未知图片媒体）在**调用上游之前**具体 fail-closed，
 *     零上游调用/附件登记/主账副作用。
 *   - 出站结构化回复（附件/choice/approval）本桥没有既有安全来源，故**不产出**结构；
 *     本桥只把 transport 的文本回复映射为 `kind:"text"`。若底层 transport 在回合里产出
 *     不支持的结构（toolCall/未知 content/image），由 transport 自己在收到后 fail-closed，
 *     这不是本桥能在调用前拦下的——不把“当前只返回 text”说成“结构输出已有拒绝”。
 *   - 不发明自定义 RPC 字段、不提示模型输出新 JSON 信封、不自动批准 tool-call、
 *     不从任意路径/模型文本铸附件授权。
 */
import type {
  HistoryMessage,
  ModelCompletionRequest,
  ModelImage,
  ModelTransport,
} from "../resident-runtime/channels.ts";
import type { FrontendModelPort, FrontendModelTurn } from "./deferred-structure-engine.ts";

export interface TransportCompletionRequest {
  adapterId: ModelCompletionRequest["adapterId"];
  model: string;
  bootPack: ModelCompletionRequest["bootPack"];
  credentialSecret: string;
}

export interface TransportModelContext {
  resolveCompletion(
    turn: FrontendModelTurn,
  ): Promise<TransportCompletionRequest> | TransportCompletionRequest;
}

const SUPPORTED_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_TOTAL_IMAGE_BYTES = 24 * 1024 * 1024;

/**
 * 文本通道承载不了的结构的稳定失败。带上缺哪个接口，不静默丢字段。
 * 当前文本 `ModelTransport` 只 yield `string` 且请求无出站结构承载；出站附件/choice/
 * approval 需要住户结构来源（见返修报告的核心缺口 GAP03）。
 */
export class FrontendModelPortStructureUnsupportedError extends Error {
  readonly code = "FRONTEND_MODEL_PORT_STRUCTURE_UNSUPPORTED";
  constructor(detail: string) {
    super(detail);
    this.name = "FrontendModelPortStructureUnsupportedError";
  }
}

export function createTransportModelPort(
  transport: ModelTransport,
  context: TransportModelContext,
): FrontendModelPort {
  return {
    async complete(turn: FrontendModelTurn): Promise<ResidentReply> {
      // 先按 kind/media 分类（不读字节）：非图片或不支持媒体在调用上游前拒。
      for (const attachment of turn.attachments) {
        if (attachment.kind !== "image") {
          throw new FrontendModelPortStructureUnsupportedError(
            "inbound file attachments cannot be carried by the text ModelTransport (needs a resident structure source; GAP03)",
          );
        }
        if (!SUPPORTED_IMAGE_MIME.has(attachment.mediaType)) {
          throw new FrontendModelPortStructureUnsupportedError(
            `inbound image media type is not supported by the text transport: ${attachment.mediaType}`,
          );
        }
      }
      // 图片只交给显式声明原生图片承载的 transport；旧/自定义 text-only 实现不受破坏，
      // 带图请求在此**调用之前**明确拒绝（calls0），不靠 JS 忽略额外字段“成功看图”。
      if (turn.attachments.length > 0 && transport.supportsNativeImages !== true) {
        throw new FrontendModelPortStructureUnsupportedError(
          "the configured ModelTransport does not declare native image support; refusing so images are not silently dropped",
        );
      }

      const images: ModelImage[] = [];
      if (turn.attachments.length > 0) {
        const handles = new Map(
          turn.attachmentPort.incoming().map((handle) => [handle.attachment.attachmentId, handle]),
        );
        let total = 0;
        for (const attachment of turn.attachments) {
          const handle = handles.get(attachment.attachmentId);
          if (handle === undefined) {
            throw new FrontendModelPortStructureUnsupportedError(
              "inbound attachment bytes are unavailable for this turn",
            );
          }
          const bytes = await handle.read();
          total += bytes.length;
          if (total > MAX_TOTAL_IMAGE_BYTES) {
            throw new FrontendModelPortStructureUnsupportedError(
              "inbound images exceed the transport byte limit",
            );
          }
          images.push({ mimeType: attachment.mediaType, data: bytes.toString("base64") });
        }
      }

      const resolved = await context.resolveCompletion(turn);
      const history: HistoryMessage[] = turn.history.map((message) => ({
        role: message.role,
        text: message.text,
      }));
      let text = "";
      for await (const delta of transport.complete({
        residentId: turn.residentId,
        adapterId: resolved.adapterId,
        model: resolved.model,
        text: turn.currentText,
        bootPack: resolved.bootPack,
        history,
        credentialSecret: resolved.credentialSecret,
        ...(images.length > 0 ? { images } : {}),
      })) {
        text += delta;
      }
      return { kind: "text", text };
    },
  };
}
