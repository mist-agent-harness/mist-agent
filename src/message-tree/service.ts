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

export interface MessageTreeServiceOptions {
  assistantReply?: AssistantReply;
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

  constructor(
    store: MessageTreeStore,
    sessionHeads: SessionHeadPort,
    options: MessageTreeServiceOptions = {},
  ) {
    this.#store = store;
    this.#sessionHeads = sessionHeads;
    this.#assistantReply = options.assistantReply ?? echoReply;
  }

  /** 原子落 user + assistant；两节点都存在以后才允许推进会话 head。 */
  async say(residentId: string, message: string, windowId: string): Promise<HistoryNode> {
    // Store 的公开 API 刻意很窄；复用只读历史同时验证房间与会话 head，
    // 避免 stale/cross-room head 在最终落树失败前已经调用 responder，白花模型成本
    // 或触发外部副作用。appendPair 仍会在写入边界重验 parentId，不依赖这层代签。
    const roomHistory = this.#store.history(residentId);
    const parentId = this.#sessionHeads.getHead(windowId);
    if (parentId !== null && !roomHistory.some((node) => node.id === parentId)) {
      throw nodeUnavailable();
    }
    const assistantContent = await this.#assistantReply(residentId, message);
    const pair = this.#store.appendPair(residentId, message, assistantContent, parentId);
    this.#sessionHeads.setHead(windowId, pair.assistant.id);
    return pair.assistant;
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
    const revised = this.#store.appendSibling(residentId, nodeId, newContent);
    // #14 二轮 + 认领人延伸裁定：改口即换枝，assistant/user 一视同仁，
    // active head 都切到新兄弟。若改的是 user 且未重新生成便继续 say，下一棵
    // user 会挂在新 user 下；这是「编辑后直接续话」的有意 M0 形态，不是副作用。
    // durable tree 仍只增一节点；会话态推进失败时不回滚已经存在的新枝。
    this.#sessionHeads.setHead(windowId, revised.id);
    return revised;
  }
}
