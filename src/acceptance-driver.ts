/**
 * 判卷驱动 —— 把 acceptance/driver.ts 那份接口接到真实存储上。
 *
 * 认领范围（issue #13 / P1）：createResident / remember / recall / errata /
 * destroyResident，以及它们依赖的房间隔离。这几个是做实的。
 *
 * 其余方法（say/history/reviseNode 属 P2，buildBootPack 属 P3，
 * killSession/createDriver 装配属 P4，export/importResident 属 P5）在这里
 * 给出**能让判卷跑起来的最小实现**，不是最终形态：
 *
 *   - 判卷六条每一条都跨多个包（C1 就要 say + killSession + buildBootPack），
 *     留空桩会让六盏灯全红、后来人连自己那条过没过都看不见。
 *   - 所以这里的非 P1 部分标了 `TODO(Pn)`，认领对应包的人直接替换即可，
 *     不必先跟我协调；替换时 P1 这几个方法不需要动。
 *
 * 存储实现刻意只用 Node 内置能力，不引 SQLite：判卷要求 `npm test` 能跑，
 * 少一个原生依赖就少一处「在我机器上装不上」。持久化已在 ResidentStore 内
 * 实现（每住户 JSON 快照 + 原子 rename，构造时传 dataDir 启用）；判卷路径
 * 不传 dataDir，保持纯内存零文件 IO——判卷判行为，不该在仓库里留脏文件。
 */

import type { BootPack, HarnessDriver, HistoryNode, MemoryEntry } from "../acceptance/driver.ts";
import { SessionRegistry } from "./session/session-registry.ts";
import { type ResidentSnapshot, ResidentStore } from "./store/resident-store.ts";

class MistDriver implements HarnessDriver {
  readonly #store = new ResidentStore();

  /**
   * 会话态注册表 —— 跟住户存储分开的一张表（#16 问 2 裁定）。
   *
   * 会话是「这次对话进行到哪」，住户是「这个人是谁、记得什么、答应过什么」。
   * 前者随 killSession 归零，后者活过任何一次会话死亡，也跟着迁移走。
   * 分开放，是让「会话死人不死」这件事在数据结构上就成立，而不是靠约定。
   * 合龙时由 P4 的 SessionRegistry 接管这张表。
   */
  readonly #sessions = new SessionRegistry<null>();

  #session(residentId: string) {
    return this.#sessions.get(residentId) ?? this.#sessions.open(residentId, null, null);
  }

  // --- P1：记忆库存储（本 issue 的认领范围）---

  async createResident(name: string): Promise<string> {
    return this.#store.createResident(name);
  }

  async remember(residentId: string, content: string): Promise<string> {
    return this.#store.remember(residentId, content);
  }

  async recall(residentId: string, query: string): Promise<MemoryEntry[]> {
    return this.#store.recall(residentId, query);
  }

  async errata(residentId: string, entryId: string, correction: string): Promise<string> {
    return this.#store.errata(residentId, entryId, correction);
  }

  async commit(residentId: string, commitment: string): Promise<void> {
    this.#store.commit(residentId, commitment);
  }

  async destroyResident(residentId: string): Promise<void> {
    this.#store.destroyResident(residentId);
  }

  // --- P2：消息树（TODO(P2) 认领者替换）---

  async say(residentId: string, message: string): Promise<HistoryNode> {
    // 先确认住户真的在（拿不到会抛）——会话态自己那张表没有隔离语义。
    this.#store.room(residentId);
    const session = this.#session(residentId);
    // 没有活会话时 #session 会开一个新 generation，headId 为 null。
    // #16 问 3 裁定：kill 之后第一次说话的 user 节点必须是新根
    // （parentId === null），会话边界才是可判的——否则「会话死了」
    // 这件事在树上看不出来，killSession 写成空函数也能蒙混过关。
    // 旧枝一个字节不动，人和历史都还在，只是这段对话从头起。
    const userNode = this.#store.appendNode(residentId, session.headId, "user", message);
    // TODO(P2)：M0 阶段回应是固定文本，判卷只看树结构不看措辞。
    const replyNode = this.#store.appendNode(
      residentId,
      userNode.id,
      "assistant",
      `收到：${message}`,
    );
    this.#sessions.setHead(residentId, replyNode.id);
    return replyNode;
  }

  async history(residentId: string): Promise<HistoryNode[]> {
    return this.#store.nodes(residentId);
  }

  async reviseNode(residentId: string, nodeId: string, newContent: string): Promise<HistoryNode> {
    const room = this.#store.room(residentId);
    const target = room.nodes.get(nodeId);
    if (target === undefined) {
      throw new Error(`no such node in ${residentId}: ${nodeId}`);
    }
    // append-only：改口挂在旧节点的**父节点**下成为兄弟枝，旧枝一个字节不动。
    // 挂在旧节点自己下面会把「改口」变成「追加」，语义就错了。
    return this.#store.appendNode(residentId, target.parentId, target.role, newContent);
  }

  // --- P3：启动包（TODO(P3) 认领者替换）---

  async buildBootPack(residentId: string): Promise<BootPack> {
    const room = this.#store.room(residentId);
    const memories = this.#store.memories(residentId);
    // TODO(P3)：identity 目前从存储机械推导，真实形态应由住户的身份锚生成。
    // commitments 不再从记忆里按「答应」二字猜——那是把关键词匹配冒充承诺账本，
    // 说过「答应」的记忆和真立过的承诺是两回事。改由 commit() 写入的原文供货
    // （#16 问 4 裁定：存储归 P1、进包归 P3）。
    return {
      residentId,
      identity: `住户 ${room.name}（建于 ${room.createdAt}）`,
      commitments: this.#store.commitments(residentId),
      memories,
    };
  }

  // --- P4：会话生杀（TODO(P4) 认领者替换）---

  async killSession(residentId: string): Promise<void> {
    this.#store.room(residentId);
    // 只动会话态那张表，一个字节都不碰 nodes / memories / commitments：
    // 会话死，人不能死（C1 验 kill 前后整棵树的 hash 不变）。
    // 删除活会话 —— 下一句 say 会开新 generation、新根；旧 generation 的迟到
    // effect receipt 也不能再被视为当前会话，H1 的 Effect Journal 会接这条线。
    this.#sessions.kill(residentId);
  }

  // --- P5：迁移（TODO(P5) 认领者替换）---

  async exportResident(residentId: string): Promise<Uint8Array> {
    const snapshot = this.#store.exportRoom(residentId);
    return new TextEncoder().encode(JSON.stringify(snapshot));
  }

  async importResident(pack: Uint8Array): Promise<string> {
    const snapshot = JSON.parse(new TextDecoder().decode(pack)) as ResidentSnapshot;
    return this.#store.importRoom(snapshot);
  }
}

export function createDriver(): HarnessDriver {
  return new MistDriver();
}

/**
 * 判卷桩申报（#16 裁定 1 的执行）：以下方法当前是 P1 代写的最小实现，
 * 各认领包交付时从名单里划掉自己那几个。隐瞒申报按伪证论。
 */
export const STUBBED = [
  "say",
  "history",
  "reviseNode",
  "buildBootPack",
  "killSession",
  "exportResident",
  "importResident",
];
