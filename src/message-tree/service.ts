import type { HistoryNode } from "../../acceptance/driver.ts";
import { nodeUnavailable } from "./errors.ts";
import type { MessageTreeStore } from "./store.ts";

/**
 * 会话层给消息树服务的唯一接缝。
 *
 * head 是可杀的会话态，不属于 MessageTreeStore。P4 总装时用自己的
 * SessionRegistry 适配这两个方法；P2 不持久化、迁移或销毁 head。
 *
 * 多窗之后这个接缝按 windowId 索引，不按 residentId：同一住户的两扇窗
 * 各有各的 head，共用一颗 head 会让两窗互相改写对方的续话位置（MV-A02）。
 */
export interface SessionHeadPort {
  getHead(windowId: string): string | null;
  setHead(windowId: string, headId: string): void;
}

/** M0 的哑回应生成口；真实模型适配不属于消息树存储。 */
export type AssistantReply = (residentId: string, message: string) => string | Promise<string>;

/**
 * 一次真实模型派发的窗级凭证。形状与 SessionRegistry.DispatchReceipt 一致，
 * 但消息树只依赖这份窄端口，不反向拥有会话注册表。
 */
export interface WindowDispatchReceipt {
  residentId: string;
  windowId: string;
  generation: number;
  dispatchId: string;
}

/** 派发链三个可观察落点（MV-B03）；每一类都必须带完整窗三元组。 */
export interface DispatchEvent extends WindowDispatchReceipt {
  event: "dispatch" | "receipt" | "dropped";
  detail: string;
}

export interface DispatchEventLogger {
  log(event: DispatchEvent): void;
}

/**
 * 会话层给真实 responder 的回执接缝：开工前签发，结果回来后按窗与代际验归属。
 */
export interface DispatchLifecyclePort {
  issueDispatch(windowId: string): WindowDispatchReceipt;
  belongsToActiveWindow(receipt: WindowDispatchReceipt): boolean;
}

export const DISPATCH_RESULT_DROPPED = "DISPATCH_RESULT_DROPPED" as const;

/** 迟到结果被代际闸丢弃；响亮失败，调用方不得把它当成已落树回应。 */
export class DispatchResultDroppedError extends Error {
  readonly code = DISPATCH_RESULT_DROPPED;
  constructor(receipt: WindowDispatchReceipt) {
    super(
      `${DISPATCH_RESULT_DROPPED}: ${receipt.residentId}/${receipt.windowId} generation=${receipt.generation} dispatch=${receipt.dispatchId}`,
    );
    this.name = "DispatchResultDroppedError";
  }
}

/**
 * 一轮开工的通行凭证（开工闸的回件，图纸 docs/design/multi-viewport.md §3.2）。
 *
 * 闸在模型调用之前发凭证：contextPrefix 是本轮必须先进上下文的缺口条目，
 * commit 是「这轮真的开工成功了」的回执。凭证与落树一一对应——
 * assistantReply 失败时 commit 根本不会被调用，缺口下轮重拉（MV-C05）。
 */
export interface TurnPass {
  /** 注入本轮上下文的缺口条目（已标注来源档位），无缺口为空数组。 */
  readonly contextPrefix: string[];
  /**
   * 落树成功后回执 ack；assistantReply 失败则不调用，下轮重拉。
   * 回执自身失败（如账落盘错误）不向外传播：本轮交付已被树与 head 证明，
   * 反报失败只会诱导调用方重试、同一句话落树两次——实现方应记 ack_failed
   * 事件、ackedSeq 不前进，让下轮开工自然重拉（MV-C05）。
   */
  commit(): void;
}

/**
 * 开工闸端口：say（裁定级动作）开工前的必经闸。
 *
 * 与 SessionHeadPort 同模式：Service 不认识账，只认这个两口子的接缝。
 * 闸的实现（ViewportTurnGate）可以拒绝开工——beforeTurn 抛错时 say 在
 * 模型调用之前失败，不落任何节点（fail-closed，MV-C03 裁定级半）。
 */
export interface TurnGate {
  beforeTurn(residentId: string, windowId: string): TurnPass;
}

export interface MessageTreeServiceOptions {
  assistantReply?: AssistantReply;
  /** 不接闸时行为与接闸前完全一致——既有路径一个字不变。 */
  turnGate?: TurnGate;
  /** 不接派发端口时保留旧的直调 responder 行为，供纯消息树嵌入方使用。 */
  dispatch?: DispatchLifecyclePort;
  /** 派发事件日志口；不提供时只执行回执过滤，不产生日志。 */
  dispatchEventLogger?: DispatchEventLogger;
}

/**
 * Optional final-commit boundary for callers whose authority can change while the responder is
 * running. The boundary is entered after the awaited reply and wraps the synchronous tree append
 * plus head advance, so a caller can revalidate a generation without leaving another await-sized
 * race before the mutation.
 */
export interface MessageCommitBoundary {
  commit<T>(mutation: () => T): T;
}

export interface MessageTreeSayOptions {
  readonly commitBoundary?: MessageCommitBoundary;
  /** Caller-specific window authority; replaces the default port, never issues a second receipt. */
  readonly dispatch?: DispatchLifecyclePort;
  /** Host-owned operation identity for crash-safe retry after tree commit but before outer receipt. */
  readonly idempotencyKey?: string;
}

const echoReply: AssistantReply = (_residentId, message) => message;

/**
 * 把当前会话的 head 与 append-only 消息树接起来。
 *
 * Store 负责节点原子性与隔离；Service 只负责先读会话 head、落树成功后再推进 head。
 */
export class MessageTreeService {
  readonly #store: MessageTreeStore;
  readonly #sessionHeads: SessionHeadPort;
  readonly #assistantReply: AssistantReply;
  readonly #turnGate: TurnGate | undefined;
  readonly #dispatch: DispatchLifecyclePort | undefined;
  readonly #dispatchEventLogger: DispatchEventLogger | undefined;

  constructor(
    store: MessageTreeStore,
    sessionHeads: SessionHeadPort,
    options: MessageTreeServiceOptions = {},
  ) {
    this.#store = store;
    this.#sessionHeads = sessionHeads;
    this.#assistantReply = options.assistantReply ?? echoReply;
    this.#turnGate = options.turnGate;
    this.#dispatch = options.dispatch;
    this.#dispatchEventLogger = options.dispatchEventLogger;
  }

  #logDispatch(
    event: DispatchEvent["event"],
    receipt: WindowDispatchReceipt,
    detail: string,
  ): void {
    this.#dispatchEventLogger?.log({ event, ...receipt, detail });
  }

  /** 原子落 user + assistant；两节点都存在以后才允许推进会话 head。 */
  async say(
    residentId: string,
    message: string,
    windowId: string,
    options: MessageTreeSayOptions = {},
  ): Promise<HistoryNode> {
    // Store 的公开 API 刻意很窄；复用只读历史同时验证房间与会话 head，
    // 避免 stale/cross-room head 在最终落树失败前已经调用 responder，白花模型成本
    // 或触发外部副作用。appendPair 仍会在写入边界重验 parentId，不依赖这层代签。
    const roomHistory = this.#store.history(residentId);
    const parentId = this.#sessionHeads.getHead(windowId);
    if (parentId !== null && !roomHistory.some((node) => node.id === parentId)) {
      throw nodeUnavailable();
    }
    const replay =
      options.idempotencyKey === undefined
        ? null
        : this.#store.idempotentPair(residentId, options.idempotencyKey, message);
    if (replay !== null) {
      const nodesById = new Map(roomHistory.map((node) => [node.id, node]));
      let cursor = parentId;
      let replayPrecedesCurrentHead = false;
      while (cursor !== null) {
        if (cursor === replay.assistant.id) {
          replayPrecedesCurrentHead = true;
          break;
        }
        cursor = nodesById.get(cursor)?.parentId ?? null;
      }
      if (
        parentId !== replay.user.parentId &&
        parentId !== replay.assistant.id &&
        !replayPrecedesCurrentHead
      ) {
        throw nodeUnavailable();
      }
      const commitReplay = (): HistoryNode => {
        // If later turns already descend from this committed pair, the pair itself is the durable
        // receipt. Reuse it without rewinding the live head; only the immediate post-crash shape
        // (head still at the pair's former parent) needs its missing head advance repaired.
        if (parentId === replay.user.parentId) {
          this.#sessionHeads.setHead(windowId, replay.assistant.id);
        }
        return replay.assistant;
      };
      return options.commitBoundary?.commit(commitReplay) ?? commitReplay();
    }
    // 开工闸在校验之后、模型调用之前：闸拒（抛错）时 responder 零调用、零写入。
    const pass = this.#turnGate?.beforeTurn(residentId, windowId);
    // 缺口条目只进发给模型的文本，不进落树的 user 节点——注入是上下文装配，
    // 不是用户发言；树上留的必须是她真正说的那句话。
    const prompt =
      pass !== undefined && pass.contextPrefix.length > 0
        ? [...pass.contextPrefix, message].join("\n\n")
        : message;
    // Only a fresh responder call issues a receipt. Callers may narrow the authority port,
    // but issuance and lifecycle logging stay here; committed replays bypass both.
    const dispatch = options.dispatch ?? this.#dispatch;
    const dispatchReceipt = dispatch?.issueDispatch(windowId);
    if (dispatchReceipt !== undefined) {
      this.#logDispatch("dispatch", dispatchReceipt, "responder 已开始处理本轮");
    }
    const assistantContent = await this.#assistantReply(residentId, prompt);
    const commit = (): HistoryNode => {
      // Check inside the final synchronous mutation, including any caller boundary. A stale
      // result must be logged with its original dispatch ID before touching the tree or head.
      if (
        dispatchReceipt !== undefined &&
        dispatch !== undefined &&
        !dispatch.belongsToActiveWindow(dispatchReceipt)
      ) {
        this.#logDispatch("dropped", dispatchReceipt, "结果返回时原窗代际已不再活跃");
        throw new DispatchResultDroppedError(dispatchReceipt);
      }
      const pair =
        options.idempotencyKey === undefined
          ? this.#store.appendPair(residentId, message, assistantContent, parentId)
          : this.#store.appendPairOnce(
              residentId,
              message,
              assistantContent,
              parentId,
              options.idempotencyKey,
            );
      this.#sessionHeads.setHead(windowId, pair.assistant.id);
      // 回执只在落树 + head 推进都成功之后发出：先 ack 后落树会让「已确认」
      // 覆盖「没送到」，回执丢失归传播机制的前提是先证明这轮真的开工了（MV-C05）。
      pass?.commit();
      if (dispatchReceipt !== undefined) {
        this.#logDispatch("receipt", dispatchReceipt, "回应已落树且窗 head 已推进");
      }
      return pair.assistant;
    };
    return options.commitBoundary?.commit(commit) ?? commit();
  }

  async history(residentId: string): Promise<HistoryNode[]> {
    return this.#store.history(residentId);
  }

  async reviseNode(
    residentId: string,
    nodeId: string,
    newContent: string,
    windowId: string,
  ): Promise<HistoryNode> {
    // 读侧先验证窗仍可写；归档窗不能先落一条 sibling 再在 setHead 时才失败。
    // 改口不过开工闸：闸管的是「开工」（一轮新 turn），改口是对既有枝的修正，
    // 不消费新上下文，也就无所谓先注入缺口。
    this.#sessionHeads.getHead(windowId);
    const revised = this.#store.appendSibling(residentId, nodeId, newContent);
    // #14 二轮 + 认领人延伸裁定：改口即换枝，assistant/user 一视同仁，
    // active head 都切到新兄弟。若改的是 user 且未重新生成便继续 say，下一棵
    // user 会挂在新 user 下；这是「编辑后直接续话」的有意 M0 形态，不是副作用。
    // durable tree 仍只增一节点；会话态推进失败时不回滚已经存在的新枝。
    this.#sessionHeads.setHead(windowId, revised.id);
    return revised;
  }
}
