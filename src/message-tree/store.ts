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
   * 全部校验先行（含 id 无碰撞），两个节点要么都进树、要么都不进——
   * 不存在 user-only 的半截写入，也不存在 id 撞车时先落一半再炸。
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
    this.assertFreshIds(room, [user, assistant]);
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
    this.assertFreshIds(room, [sibling]);
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

  /** 迁移桥读树：语义同 history()，按插入序返回全树副本。 */
  exportTree(residentId: string): HistoryNode[] {
    return this.history(residentId);
  }

  /**
   * 批量导入。整批先校验，任何一条不过就零写入；全过才按数组顺序逐条插入。
   * 不代建房——房间生命周期仍走 createRoom，防止拼错 id 长出幽灵房。
   */
  importTree(residentId: string, nodes: HistoryNode[]): void {
    const room = this.mustRoom(residentId);
    const prepared: HistoryNode[] = [];
    const batchIds = new Set<string>();

    for (const node of nodes) {
      this.assertContractNode(node);
      if (room.nodes.has(node.id) || batchIds.has(node.id)) {
        throw new MessageTreeError(`节点 id 冲突，拒绝覆盖历史：${node.id}`);
      }
      batchIds.add(node.id);
      prepared.push(
        Object.freeze({
          id: node.id,
          parentId: node.parentId,
          role: node.role,
          content: node.content,
          createdAt: node.createdAt,
        }),
      );
    }

    for (const node of prepared) {
      if (
        node.parentId !== null &&
        !room.nodes.has(node.parentId) &&
        !batchIds.has(node.parentId)
      ) {
        throw nodeUnavailable();
      }
    }
    this.assertAcyclicImport(room, prepared);

    const orderBefore = room.order.length;
    try {
      for (const node of prepared) {
        this.insert(room, node);
      }
    } catch (error) {
      for (const node of prepared) {
        room.nodes.delete(node.id);
      }
      room.order.length = orderBefore;
      throw error;
    }
  }

  private mustRoom(residentId: string): Room {
    const room = this.rooms.get(residentId);
    if (room === undefined) {
      throw new MessageTreeError(`未知住户：${residentId}`);
    }
    return room;
  }

  private static readonly CONTRACT_KEYS = ["content", "createdAt", "id", "parentId", "role"];

  /**
   * 导入节点的契约闸：恰好五字段，role 只能是 user/assistant/system。
   * 多一个键、少一个键、或类型不对，都整批拒绝——不把调用方的附加字段冻进历史。
   */
  private assertContractNode(node: HistoryNode): void {
    if (typeof node !== "object" || node === null || Array.isArray(node)) {
      throw new MessageTreeError("节点不可导入");
    }
    const keys = Object.keys(node).sort();
    if (
      keys.length !== MessageTreeStore.CONTRACT_KEYS.length ||
      keys.some((key, index) => key !== MessageTreeStore.CONTRACT_KEYS[index])
    ) {
      throw new MessageTreeError("节点不可导入");
    }
    if (typeof node.id !== "string" || node.id.length === 0) {
      throw new MessageTreeError("节点不可导入");
    }
    if (
      node.parentId !== null &&
      (typeof node.parentId !== "string" || node.parentId.length === 0)
    ) {
      throw new MessageTreeError("节点不可导入");
    }
    if (node.role !== "user" && node.role !== "assistant" && node.role !== "system") {
      throw new MessageTreeError("节点不可导入");
    }
    if (typeof node.content !== "string") {
      throw new MessageTreeError("节点不可导入");
    }
    if (typeof node.createdAt !== "string") {
      throw new MessageTreeError("节点不可导入");
    }
  }

  /**
   * 迁移包能带来 appendPair/appendSibling 平时长不出的形状。
   * 每个导入节点必须能沿 parentId 在有限步内回到根，或接到房内既有节点。
   */
  private assertAcyclicImport(room: Room, nodes: HistoryNode[]): void {
    const batchParents = new Map(nodes.map((node) => [node.id, node.parentId]));
    for (const node of nodes) {
      const seen = new Set<string>();
      let cursor: string | null = node.id;
      while (cursor !== null && !room.nodes.has(cursor)) {
        if (seen.has(cursor)) {
          throw new MessageTreeError("节点不可导入");
        }
        seen.add(cursor);
        const parentId = batchParents.get(cursor);
        if (parentId === undefined) {
          throw nodeUnavailable();
        }
        cursor = parentId;
      }
    }
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

  /**
   * id 无碰撞校验：撞上房内已有节点、或同批次内部互撞，一律整批拒绝。
   * Map.set 静默覆盖是 append-only 的天敌——历史被吞不会当场炸，
   * 只会在某天读史时少一个节点（交叉挑刺 fd6dd07 抓出的洞）。
   */
  private assertFreshIds(room: Room, nodes: HistoryNode[]): void {
    const batch = new Set<string>();
    for (const node of nodes) {
      if (room.nodes.has(node.id) || batch.has(node.id)) {
        throw new MessageTreeError(`节点 id 冲突，拒绝覆盖历史：${node.id}`);
      }
      batch.add(node.id);
    }
  }

  /** 末道闸：即使上游校验漏了，insert 也绝不允许覆盖已有节点。 */
  private insert(room: Room, node: HistoryNode): void {
    if (room.nodes.has(node.id)) {
      throw new MessageTreeError(`节点 id 冲突，拒绝覆盖历史：${node.id}`);
    }
    room.nodes.set(node.id, node);
    room.order.push(node.id);
  }
}
