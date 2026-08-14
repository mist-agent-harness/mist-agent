/**
 * 住户存储 —— P1 的地基。
 *
 * 一条铁律：**房间是物理边界，不是查询条件。**
 *
 * 每个住户一个独立的 ResidentRoom 对象，记忆条目存在房间自己的 Map 里。
 * 想读 A 的记忆就必须先拿到 A 的房间；拿不到房间就读不到，而不是「拿到了
 * 全库、再用 residentId 过滤一遍」。后者只要有一处忘了加过滤条件就串房，
 * 而串房不会当场炸——它只会在某天悄悄把 A 的记忆喂进 B 的启动包。
 *
 * 判卷 C5 只测了 recall 和 bootPack 两个口，但真正危险的是将来新增的第三个口。
 * 物理隔离让「新增的口」默认就是安全的：新代码想串房，得先绕过房间对象，
 * 那是显式的越权动作，review 时看得见。
 */

import type { HistoryNode, MemoryEntry } from "../../acceptance/driver.ts";

/** 一个住户的全部状态。房间之间不共享任何可变结构。 */
export interface ResidentRoom {
  residentId: string;
  name: string;
  createdAt: string;
  /** 记忆条目，插入序即 Map 迭代序。 */
  memories: Map<string, MemoryEntry>;
  /** 消息树全部节点（含被分叉的旧枝）。 */
  nodes: Map<string, HistoryNode>;
  /**
   * 立过的承诺，按立的先后。
   *
   * 裁定（2026-08-14，#16 问 4）：启动包的 commitments 必须真实来自
   * `commit()` 写入的原文——恒返空数组、或从记忆里按关键词猜，都判不过。
   * 存储归 P1（这里），进包归 P3。
   */
  commitments: string[];
}

/**
 * 会话态。刻意**不在** ResidentRoom 里，也不进快照和迁移包。
 *
 * 裁定（2026-08-14，#16 问 2）：`sessionHead`/`sessionAlive` 是会话态，
 * 由 P4 的 SessionRegistry 单独持有；导入住户不复活来源机的活会话。
 * 这里是 P1 侧的最小实现，合龙时由 P4 替换 —— 但边界（会话态与住户态
 * 分家）是真的，不是桩：住户快照里从此没有这两个字段。
 */
export interface SessionState {
  /** 当前活会话的叶节点 id；null = 下一句 say 开新根。 */
  head: string | null;
  alive: boolean;
}

/** 跨房访问时抛这个，不返回空数组——静默的空结果会把 bug 藏起来。 */
export class ResidentNotFoundError extends Error {
  constructor(residentId: string) {
    super(`no such resident: ${residentId}`);
    this.name = "ResidentNotFoundError";
  }
}

export class ResidentStore {
  readonly #rooms = new Map<string, ResidentRoom>();
  #seq = 0;

  /**
   * 单调递增的 id。不用 Date.now() 或随机数：
   * C6 要求导出导入后启动包逐字节等价，id 必须可复现地原样搬运；
   * 同毫秒内连续 remember 两条时随机数还有撞号风险。
   */
  #nextId(prefix: string): string {
    this.#seq += 1;
    return `${prefix}-${this.#seq.toString(36).padStart(6, "0")}`;
  }

  /**
   * 时间戳。同一进程内单调递增，避免同毫秒条目排序不稳定
   * ——C6 的逐字节比对经不起顺序抖动。
   */
  #lastStamp = 0;
  #nextStamp(): string {
    const now = Date.now();
    this.#lastStamp = now > this.#lastStamp ? now : this.#lastStamp + 1;
    return new Date(this.#lastStamp).toISOString();
  }

  createResident(name: string): string {
    const residentId = this.#nextId("resident");
    this.#rooms.set(residentId, {
      residentId,
      name,
      createdAt: this.#nextStamp(),
      memories: new Map(),
      nodes: new Map(),
      commitments: [],
    });
    return residentId;
  }

  /**
   * 立一条承诺。承诺是住户态——进快照、进迁移包、活过 killSession。
   *
   * 不去重：同一句话说两遍是两次承诺，account 该留两条。要合并是上层的事。
   */
  commit(residentId: string, commitment: string): void {
    this.room(residentId).commitments.push(commitment);
  }

  /** 承诺账本的只读视图。 */
  commitments(residentId: string): string[] {
    return [...this.room(residentId).commitments];
  }

  /** 拿房间。拿不到就抛——这是物理隔离的唯一入口。 */
  room(residentId: string): ResidentRoom {
    const room = this.#rooms.get(residentId);
    if (room === undefined) throw new ResidentNotFoundError(residentId);
    return room;
  }

  has(residentId: string): boolean {
    return this.#rooms.has(residentId);
  }

  destroyResident(residentId: string): void {
    this.#rooms.delete(residentId);
  }

  // --- 记忆库 ---

  remember(residentId: string, content: string): string {
    const room = this.room(residentId);
    const id = this.#nextId("mem");
    room.memories.set(id, {
      id,
      residentId,
      content,
      supersededBy: null,
      createdAt: this.#nextStamp(),
    });
    return id;
  }

  /**
   * 勘误：旧条目一个字节不改，只写 supersededBy。
   *
   * 「错的可以被取代，但不能被抹掉」——抹掉旧条目等于篡改历史，
   * 而住户将来可能需要知道「我曾经记错过这件事」。
   */
  errata(residentId: string, entryId: string, correction: string): string {
    const room = this.room(residentId);
    const old = room.memories.get(entryId);
    if (old === undefined) {
      throw new Error(`no such memory entry in ${residentId}: ${entryId}`);
    }
    if (old.supersededBy !== null) {
      throw new Error(`entry ${entryId} is already superseded by ${old.supersededBy}`);
    }
    const newId = this.remember(residentId, correction);
    // 只动 supersededBy 这一个字段；content / createdAt / id 原样不碰。
    room.memories.set(entryId, { ...old, supersededBy: newId });
    return newId;
  }

  /**
   * 检索。死条目和活条目都返回，由调用方自己判哪条算数。
   *
   * 检索层替调用方决定「只给你看最新的」是越权：勘误链的价值正在于
   * 「我记错过，后来改了」这件事本身可被看见。
   */
  recall(residentId: string, query: string): MemoryEntry[] {
    const room = this.room(residentId);
    const q = query.trim();
    const all = [...room.memories.values()];
    if (q === "") return all;
    return all.filter((m) => m.content.includes(q));
  }

  memories(residentId: string): MemoryEntry[] {
    return [...this.room(residentId).memories.values()];
  }

  // --- 消息树（append-only）---

  /** 追加一个节点，挂在指定父节点下。绝不修改任何已有节点。 */
  appendNode(
    residentId: string,
    parentId: string | null,
    role: HistoryNode["role"],
    content: string,
  ): HistoryNode {
    const room = this.room(residentId);
    if (parentId !== null && !room.nodes.has(parentId)) {
      throw new Error(`no such node in ${residentId}: ${parentId}`);
    }
    const node: HistoryNode = {
      id: this.#nextId("node"),
      parentId,
      role,
      content,
      createdAt: this.#nextStamp(),
    };
    room.nodes.set(node.id, node);
    return node;
  }

  nodes(residentId: string): HistoryNode[] {
    return [...this.room(residentId).nodes.values()];
  }

  // --- 迁移 ---

  /**
   * 导出为一份自包含快照。原件一个字节不动——C6 明确要求迁移后原件仍可用。
   */
  exportRoom(residentId: string): ResidentSnapshot {
    const room = this.room(residentId);
    return {
      name: room.name,
      createdAt: room.createdAt,
      memories: [...room.memories.values()],
      nodes: [...room.nodes.values()],
      commitments: [...room.commitments],
    };
  }

  /**
   * 导入成一个新住户。
   *
   * 关键：条目的 id / createdAt 原样保留，只换 residentId。
   * C6 要逐字节等价（把 residentId 归一化后比较），重新生成 id 会直接判死。
   * 这也符合直觉——搬家不该让记忆换一个身份证号。
   */
  importRoom(snapshot: ResidentSnapshot): string {
    const residentId = this.#nextId("resident");
    const memories = new Map<string, MemoryEntry>();
    for (const m of snapshot.memories) {
      memories.set(m.id, { ...m, residentId });
    }
    const nodes = new Map<string, HistoryNode>();
    for (const n of snapshot.nodes) {
      nodes.set(n.id, { ...n });
    }
    this.#rooms.set(residentId, {
      residentId,
      name: snapshot.name,
      createdAt: snapshot.createdAt,
      memories,
      nodes,
      // 承诺跟着人走：搬了家，答应过的事还算数。
      commitments: [...snapshot.commitments],
    });
    return residentId;
  }
}

/** 迁移包的内容。序列化格式由 driver 决定，这里只管结构。 */
/**
 * 自包含的住户快照 —— 迁移信封的载荷，也是将来落盘的形状。
 *
 * 只装住户态。会话态（head/alive）不在这里：#16 问 2 已拍，
 * 导入一个住户不该复活来源机上那条活会话。
 */
export interface ResidentSnapshot {
  name: string;
  createdAt: string;
  memories: MemoryEntry[];
  nodes: HistoryNode[];
  commitments: string[];
}
