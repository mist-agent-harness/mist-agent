/**
 * 消息树存储 —— P2 的地基层。只管三件事：不可变、有序、不串房。
 *
 * 与 P1 记忆库同一条铁律：**房间是物理边界，不是查询条件。**
 * 每个住户一个 Room 对象，节点存在房间自己的 Map 里；拿不到房间就读不到，
 * 不存在「拿全库再过滤」的路径。跨房 nodeId 在目标房间里根本查无此节点，
 * 与真不存在走同一条不透明拒绝（见 errors.ts），且两房零写入。
 *
 * append-only 的落法：节点写入即 Object.freeze，冻结的是**店内原件**；
 * 所有对外返回（appendPair / appendSibling / history）一律给副本。
 * 调用方改副本改不动历史，店内代码想改原件会当场抛 TypeError。
 *
 * 会话语义（active head、谁挂谁下面）不在这层：Store 不知道 head 是什么，
 * 只认显式传入的 parentId。这是会议室 20e54efd 六楼钉的分层——树是住户态，
 * head 是会话态，归 P4 的 SessionRegistry。
 *
 * 排序：房间内维护插入序数组，history 按插入序返回，与 createdAt 无关——
 * 同一毫秒落两个节点也不会乱序（时钟只是记录，不是排序键）。
 * id 与时钟可注入，测试可完全确定性复现。
 */

import type { HistoryNode } from "../../acceptance/driver.ts";
import { MessageTreeError, nodeUnavailable } from "./errors.ts";

/** 一个住户的消息树。房间之间不共享任何可变结构。 */
interface Room {
  /** 全部节点，key 为 node id。value 已 Object.freeze。 */
  nodes: Map<string, HistoryNode>;
  /** 插入序：history 的返回顺序，同时是兄弟先后的推导依据。 */
  order: string[];
}

export interface MessageTreeStoreOptions {
  /** 时间源，默认 ISO-8601 UTC 当前时刻。测试注入固定时钟。 */
  now?: () => string;
  /** id 源，默认 crypto.randomUUID。测试注入递增序号。 */
  newId?: () => string;
}

/** say 一次落下的两个节点（副本）。 */
export interface AppendedPair {
  user: HistoryNode;
  assistant: HistoryNode;
}

export class MessageTreeStore {
  private readonly rooms = new Map<string, Room>();
  private readonly now: () => string;
  private readonly newId: () => string;

  constructor(options?: MessageTreeStoreOptions) {
    this.now = options?.now ?? (() => new Date().toISOString());
    this.newId = options?.newId ?? (() => crypto.randomUUID());
  }

  /** 建房。重复建房抛错——房间生命周期必须显式，防止拼错 id 长出幽灵房。 */
  createRoom(residentId: string): void {
    if (this.rooms.has(residentId)) {
      throw new MessageTreeError(`住户已存在：${residentId}`);
    }
    this.rooms.set(residentId, { nodes: new Map(), order: [] });
  }

  /** 拆房（回滚清理用）。不存在则抛错。 */
  destroyRoom(residentId: string): void {
    if (!this.rooms.delete(residentId)) {
      throw new MessageTreeError(`未知住户：${residentId}`);
    }
  }

  /**
   * 原子落一对节点：user 挂 parentId 下（null 即新根），assistant 挂 user 下。
   * 全部校验先行，两个节点要么都进树、要么都不进——不存在 user-only 的半截写入。
   */
  appendPair(
    residentId: string,
    userContent: string,
    assistantContent: string,
    parentId: string | null,
  ): AppendedPair {
    const room = this.mustRoom(residentId);
    if (parentId !== null && !room.nodes.has(parentId)) {
      throw nodeUnavailable();
    }
    const user = this.build(parentId, "user", userContent);
    const assistant = this.build(user.id, "assistant", assistantContent);
    this.insert(room, user);
    this.insert(room, assistant);
    return { user: { ...user }, assistant: { ...assistant } };
  }

  /**
   * 同父分叉：新节点与 nodeId 所指节点同 parentId、同 role，只换 id/content/createdAt。
   * 旧节点一个字节不动。nodeId 不在**本房**（含跨房与真不存在）→ 不透明拒绝，零写入。
   */
  appendSibling(residentId: string, nodeId: string, newContent: string): HistoryNode {
    const room = this.mustRoom(residentId);
    const origin = room.nodes.get(nodeId);
    if (origin === undefined) {
      throw nodeUnavailable();
    }
    const sibling = this.build(origin.parentId, origin.role, newContent);
    this.insert(room, sibling);
    return { ...sibling };
  }

  /** 整棵树的副本，按插入序，含被分叉的旧枝。不做「哪条算数」的裁决。 */
  history(residentId: string): HistoryNode[] {
    const room = this.mustRoom(residentId);
    const nodes: HistoryNode[] = [];
    for (const id of room.order) {
      const node = room.nodes.get(id);
      if (node !== undefined) {
        nodes.push({ ...node });
      }
    }
    return nodes;
  }

  private mustRoom(residentId: string): Room {
    const room = this.rooms.get(residentId);
    if (room === undefined) {
      throw new MessageTreeError(`未知住户：${residentId}`);
    }
    return room;
  }

  private build(parentId: string | null, role: HistoryNode["role"], content: string): HistoryNode {
    return Object.freeze({
      id: this.newId(),
      parentId,
      role,
      content,
      createdAt: this.now(),
    });
  }

  private insert(room: Room, node: HistoryNode): void {
    room.nodes.set(node.id, node);
    room.order.push(node.id);
  }
}
