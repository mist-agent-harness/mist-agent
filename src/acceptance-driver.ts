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
 * 少一个原生依赖就少一处「在我机器上装不上」。真正的持久化留给后续里程碑，
 * 判卷本来也只判行为不判实现。
 */

import type { BootPack, HarnessDriver, HistoryNode, MemoryEntry } from "../acceptance/driver.ts";
import { type ResidentSnapshot, ResidentStore } from "./store/resident-store.ts";

class MistDriver implements HarnessDriver {
  readonly #store = new ResidentStore();

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

  async destroyResident(residentId: string): Promise<void> {
    this.#store.destroyResident(residentId);
  }

  // --- P2：消息树（TODO(P2) 认领者替换）---

  async say(residentId: string, message: string): Promise<HistoryNode> {
    const room = this.#store.room(residentId);
    if (!room.sessionAlive) {
      // 没有活会话就开一个。新会话从整棵树的末端继续长，不清空历史
      // ——会话死，人不死。
      room.sessionAlive = true;
    }
    const userNode = this.#store.appendNode(residentId, room.sessionHead, "user", message);
    // TODO(P2)：M0 阶段回应是固定文本，判卷只看树结构不看措辞。
    const replyNode = this.#store.appendNode(
      residentId,
      userNode.id,
      "assistant",
      `收到：${message}`,
    );
    room.sessionHead = replyNode.id;
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
    // TODO(P3)：identity / commitments 目前从存储机械推导，真实形态应由
    // 住户的身份锚与承诺账本生成。这里保证的是「由存储生成、不是手写文件」。
    return {
      residentId,
      identity: `住户 ${room.name}（建于 ${room.createdAt}）`,
      commitments: memories
        .filter((m) => m.supersededBy === null && m.content.includes("答应"))
        .map((m) => m.content),
      memories,
    };
  }

  // --- P4：会话生杀（TODO(P4) 认领者替换）---

  async killSession(residentId: string): Promise<void> {
    const room = this.#store.room(residentId);
    // 只关会话，不动 nodes / memories：会话死，人不能死。
    // sessionHead 保留，下次 say 从原处继续长，历史不断。
    room.sessionAlive = false;
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
