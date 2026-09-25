/**
 * #194 住户运行时的通道层（D25 三：**Claude 订阅是唯一特例**）。
 *
 * 路由是判据本身（RT-04）：`claudeSubscription: true` 必须落 `pi-claude-bridge`，
 * 其余一律 `pi-ai`。两条都是用户 `pi install` 装的外部扩展（D25 二），mist 不内置、
 * 不 fork、不 submodule——所以本模块只定适配器身份与模型传输的接口形状，
 * pi-ai / pi-claude-bridge 的真实上游适配器随 RT-04 的通道 PR 接进来。
 *
 * 模型传输（ModelTransport）默认是**合成通道**：AGENTS.md 明文「不许引入需要密钥
 * 才能跑通的代码路径」，清单（resident-runtime.md 判卷边界）也写明「真实往返只在
 * 本机……公开 CI 用合成通道」。合成通道照样走完整条凭证路径——密钥在调用时刻
 * 从凭证面解析出来、交给传输层、校验非空，只是上游是本地确定性实现；不许绕过
 * RT-06 的扫描面。哪条传输生效由 MIST_RESIDENT_RUNTIME_TRANSPORT 决定
 * （synthetic | pi），默认 synthetic。
 *
 * 代价：合成通道证明的是「循环真的接通了」，不是「模型真的会说话」——后者的
 * 证据是本机真实通道的往返记录，归 RT-04 的通道 PR 与验收席，不进合成灯。
 */
import { createHash } from "node:crypto";
import { PiCliTransport } from "./pi-transport.ts";

export type ChannelAdapterId = "pi-claude-bridge" | "pi-ai";
export type ChannelCredentialKind = "subscription" | "api-key";

export interface ChannelSpecLike {
  readonly claudeSubscription: boolean;
  readonly credentialKind: ChannelCredentialKind;
  readonly model: string;
}

export interface ChannelRouteLike {
  readonly adapterId: ChannelAdapterId;
  readonly credentialKind: ChannelCredentialKind;
  readonly model: string;
}

export class ChannelSpecError extends Error {
  readonly code = "CHANNEL_SPEC_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "ChannelSpecError";
  }
}

/** D25 三的映射本体：订阅 → pi-claude-bridge，其余 → pi-ai，接反即错。 */
export function resolveChannelRoute(channel: ChannelSpecLike): ChannelRouteLike {
  if (channel.claudeSubscription && channel.credentialKind !== "subscription") {
    throw new ChannelSpecError("claudeSubscription=true requires credentialKind=subscription");
  }
  if (!channel.claudeSubscription && channel.credentialKind !== "api-key") {
    throw new ChannelSpecError("non-Claude channels must use credentialKind=api-key");
  }
  if (channel.model.trim().length === 0) {
    throw new ChannelSpecError("channel model must not be empty");
  }
  return {
    adapterId: channel.claudeSubscription ? "pi-claude-bridge" : "pi-ai",
    credentialKind: channel.credentialKind,
    model: channel.model,
  };
}

/** 一窗流历史消息（本轮之前的对话上下文，按流序）。 */
export interface HistoryMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
}

export interface ModelCompletionRequest {
  readonly residentId: string;
  /** D25 已解析的真实路由；传输层不得从 model 字符串猜订阅特例。 */
  readonly adapterId: ChannelAdapterId;
  readonly model: string;
  readonly text: string;
  /**
   * 醒来读到的**完整启动包**（P3 BootPack 契约口径）：身份、承诺、记忆、现行
   * 有效事实整包随请求进模型，不发第二次工具调用去读（验收席意见 1）。
   * currentFacts 的在场与缺席是两个值：缺席 = 没接权威事实账，空数组 = 账是空的
   * （MV-A05 口径，不许编码成同一个值）。
   */
  readonly bootPack: {
    readonly residentId: string;
    readonly identity: string;
    readonly commitments: readonly string[];
    readonly memories: readonly {
      readonly id: string;
      readonly content: string;
      readonly supersededBy: string | null;
    }[];
    readonly currentFacts?: readonly {
      readonly seq: number;
      readonly ts: string;
      readonly author: string;
      readonly kind: string;
      readonly body: string;
      readonly supersedesSeq: number | null;
    }[];
  };
  /** 当前一窗流上下文：此前回合的 user/assistant 消息按流序送进模型（验收席意见 1）。 */
  readonly history: readonly HistoryMessage[];
  /** 调用时刻从凭证面解析出的密钥原文。唯一去处是上游适配器，不许落任何盘。 */
  readonly credentialSecret: string;
}

/** 模型传输：流式产出增量（RT-05 要 ≥2 个增量才算流式）。 */
export interface ModelTransport {
  complete(request: ModelCompletionRequest): AsyncIterable<string>;
}

/**
 * 合成通道：本地确定性实现，不碰网络、不要密钥面值。
 * 回复刻意**不复读用户原文**——复读会把用户消息里的敏感内容再落一份进
 * 一窗流，蜜罐扫描（RT-06）就该把这种实现判红。
 */
export class SyntheticModelTransport implements ModelTransport {
  async *complete(request: ModelCompletionRequest): AsyncIterable<string> {
    if (request.credentialSecret.length === 0) {
      // 合成通道也要走完整凭证路径：空密钥 = 上游会拒，fail-closed。
      throw new Error("synthetic channel refused an empty credential");
    }
    const digest = createHash("sha256")
      .update(`${request.residentId}\n${request.model}\n${request.text}`)
      .digest("hex")
      .slice(0, 8);
    // 固定三段吐出：拼接非空、增量 ≥ 2，确定性可复核（不判措辞，判的是形状）。
    yield "合成回声已读来信。";
    yield `（住户 ${request.residentId} · 模型 ${request.model}）`;
    yield `#${digest}`;
  }
}

export type ModelTransportMode = "synthetic" | "pi";

export function createModelTransport(
  mode: string | undefined = process.env.MIST_RESIDENT_RUNTIME_TRANSPORT,
): ModelTransport {
  const resolved: ModelTransportMode =
    mode === undefined || mode === "" ? "synthetic" : (mode as ModelTransportMode);
  switch (resolved) {
    case "synthetic":
      return new SyntheticModelTransport();
    case "pi":
      // 真实上游（通道 PR）：用户 `pi install` 装的模型栈——pi-ai 的 provider 或
      // pi-claude-bridge（订阅特例），经 pi 公共 CLI 进子进程。密钥只走环境变量。
      return new PiCliTransport();
    default:
      throw new Error(`unknown MIST_RESIDENT_RUNTIME_TRANSPORT: ${String(mode)}`);
  }
}
