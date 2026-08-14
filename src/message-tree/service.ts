import type { HistoryNode } from "../../acceptance/driver.ts";
import type { MessageTreeStore } from "./store.ts";

/**
 * 会话层给消息树服务的唯一接缝。
 *
 * head 是可杀的会话态，不属于 MessageTreeStore。P4 总装时用自己的
 * SessionRegistry 适配这两个方法；P2 不持久化、迁移或销毁 head。
 */
export interface SessionHeadPort {
  getHead(residentId: string): string | null;
  setHead(residentId: string, headId: string): void;
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
  async say(residentId: string, message: string): Promise<HistoryNode> {
    // Store 的公开 API 刻意很窄；先走只读口验证房间，避免未知住户也调用 responder。
    this.#store.history(residentId);
    const parentId = this.#sessionHeads.getHead(residentId);
    const assistantContent = await this.#assistantReply(residentId, message);
    const pair = this.#store.appendPair(residentId, message, assistantContent, parentId);
    this.#sessionHeads.setHead(residentId, pair.assistant.id);
    return pair.assistant;
  }

  async history(residentId: string): Promise<HistoryNode[]> {
    return this.#store.history(residentId);
  }

  async reviseNode(residentId: string, nodeId: string, newContent: string): Promise<HistoryNode> {
    const revised = this.#store.appendSibling(residentId, nodeId, newContent);
    // TODO(#14): 等主笔裁定 revise 是否把 active head 切到新兄弟。
    // 该裁定只改变 SessionHeadPort，不得反向修改 durable tree。
    return revised;
  }
}
