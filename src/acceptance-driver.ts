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
import { buildBootPack as assembleBootPack } from "./bootpack.ts";
import {
  type AssistantReply,
  MessageTreeService,
  MessageTreeStore,
  type SessionHeadPort,
  type TurnGate,
} from "./message-tree/index.ts";
import { createResidentMigrationService } from "./migration/resident-store-migration.ts";
import { SessionRegistry } from "./session/session-registry.ts";
import { type TurnEventLogger, ViewportTurnGate } from "./session/turn-gate.ts";
import { type FactLedger, LedgerNotFoundError } from "./store/fact-ledger.ts";
import { ResidentStore } from "./store/resident-store.ts";

export interface CreateDriverOptions {
  dataDir?: string;
  reply?: AssistantReply;
  /**
   * 权威事实账（泳道 2 接线）。给了就装开工闸：say 过闸、开窗记 baseline、
   * 启动包带现行有效集；不给则整台 driver 行为与接账前完全一致。
   */
  factLedger?: FactLedger;
  /** 闸事件日志口；不给则事件落 no-op（ViewportTurnGate 的默认）。 */
  turnEventLogger?: TurnEventLogger;
}

class MistDriver implements HarnessDriver {
  readonly #store: ResidentStore;
  readonly #messageTreeStore: MessageTreeStore;
  readonly #messageTree: MessageTreeService;
  readonly #migration: ReturnType<typeof createResidentMigrationService>;
  // 本集合只缓存本 driver 亲手建过的 P2 room；任何拆房入口必须同步清掉。
  readonly #messageRooms = new Set<string>();

  /**
   * 会话态注册表 —— 跟住户存储分开的一张表（#16 问 2 裁定）。
   *
   * 会话是「这次对话进行到哪」，住户是「这个人是谁、记得什么、答应过什么」。
   * 前者随 killSession 归零，后者活过任何一次会话死亡，也跟着迁移走。
   * 分开放，是让「会话死人不死」这件事在数据结构上就成立，而不是靠约定。
   * 合龙时由 P4 的 SessionRegistry 接管这张表。
   */
  readonly #sessions = new SessionRegistry<null>();
  /**
   * 驱动器自己持有的「本驱动这一扇窗」绑定。
   *
   * 多窗合法之后，注册表不再回答「这个住户的当前会话是哪一个」——那正是
   * MV-A02 要拔掉的隐式单键。所以由调用方显式声明自己用哪一扇窗，
   * 而不是反过来让注册表替调用方猜。
   */
  readonly #driverWindows = new Map<string, string>();
  /** 权威事实账；null = 未接账，整台 driver 保持接账前行为。 */
  readonly #factLedger: FactLedger | null;
  /** 开工闸实例；与 #factLedger 同生同灭（有账才有闸）。 */
  readonly #turnGate: ViewportTurnGate | null;

  constructor(options: CreateDriverOptions = {}) {
    this.#store = new ResidentStore(
      options.dataDir === undefined ? undefined : { dataDir: options.dataDir },
    );
    this.#messageTreeStore = new MessageTreeStore();
    this.#factLedger = options.factLedger ?? null;
    this.#turnGate =
      this.#factLedger === null
        ? null
        : new ViewportTurnGate(this.#factLedger, {
            ...(options.turnEventLogger === undefined ? {} : { logger: options.turnEventLogger }),
            // 事件三元组的 generation 向窗注册表现查；查不到（账上有而注册表
            // 没有的窗）落 null，不伪报代际。
            generationOf: (windowId) => this.#sessions.get(windowId)?.generation ?? null,
          });
    const turnGate: TurnGate | null = this.#turnGate;
    this.#messageTree = new MessageTreeService(
      this.#messageTreeStore,
      {
        getHead: (windowId) => this.#sessions.getHead(windowId),
        setHead: (windowId, headId) => this.#sessions.setHead(windowId, headId),
      } satisfies SessionHeadPort,
      {
        assistantReply: options.reply ?? ((_residentId, message) => `收到：${message}`),
        // exactOptionalPropertyTypes 下不能显式塞 undefined：有闸才带这个键。
        ...(turnGate === null ? {} : { turnGate }),
      },
    );
    this.#migration = createResidentMigrationService(this.#store, this.#messageTreeStore);
    // dataDir 恢复补账：账接线之前落盘的老住户没有 facts.json——为每个缺账
    // 住户补一本空账（baseline=0 的空 book，不开窗；主笔口径：旧消息树与记忆
    // 不迁成事实账）。FactLedger 构造时已从 facts.json 恢复出的真账绝不重置、
    // 绝不重建（has 守卫）。
    if (this.#factLedger !== null) {
      for (const residentId of this.#store.residentIds()) {
        if (!this.#factLedger.has(residentId)) {
          this.#factLedger.createLedger(residentId);
        }
      }
    }
  }

  #session(residentId: string) {
    const bound = this.#driverWindows.get(residentId);
    if (bound !== undefined) {
      const live = this.#sessions.get(bound);
      if (live !== undefined) return live;
    }
    const opened = this.#sessions.open(residentId, { headId: null, context: null });
    // 开窗的唯一汇合点：账侧在这里记 baseline，新窗的 ackedSeq 从开窗那一刻
    // 的 latestSeq 起算，不背全史（MV-A05）。
    try {
      this.#factLedger?.openViewport(residentId, opened.windowId);
    } catch (error) {
      // 记 baseline 失败的窗不能半活着：没有 ack 行的窗过闸必炸 fail-closed，
      // 留着它等于把一次落账错误固化成这扇窗的永久残废。
      this.#sessions.kill(opened.windowId);
      throw error;
    }
    this.#driverWindows.set(residentId, opened.windowId);
    return opened;
  }

  #windowIdOf(residentId: string): string {
    return this.#session(residentId).windowId;
  }

  #createMessageRoom(residentId: string): void {
    this.#messageTreeStore.createRoom(residentId);
    this.#messageRooms.add(residentId);
  }

  #ensureMessageRoom(residentId: string, unknownResident: "resident" | "tree" = "resident"): void {
    if (this.#messageRooms.has(residentId)) return;
    if (!this.#store.has(residentId)) {
      if (unknownResident === "tree") {
        this.#messageTreeStore.history(residentId);
      }
      this.#store.room(residentId);
    }
    // 住户回来了，消息房间补一个空房间；对话树不伪装恢复。
    this.#createMessageRoom(residentId);
  }

  // --- P1：记忆库存储（本 issue 的认领范围）---

  async createResident(name: string): Promise<string> {
    const residentId = this.#store.createResident(name);
    this.#createMessageRoom(residentId);
    // 人户与账本同时开立：有账的 driver 里「这个住户没有账」只许是响亮的错误，
    // 不许在首次 say 时被静默建账吞掉（与 FactLedger 显式开户同一口径）。
    try {
      this.#factLedger?.createLedger(residentId);
    } catch (error) {
      // 开户失败必须回滚：留下「有住户没账」的半成品，以后每次开工都炸在半路。
      this.#messageRooms.delete(residentId);
      this.#messageTreeStore.destroyRoom(residentId);
      this.#store.destroyResident(residentId);
      throw error;
    }
    return residentId;
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

  #killDriverWindows(residentId: string): void {
    this.#sessions.killResident(residentId);
    this.#driverWindows.delete(residentId);
  }

  async destroyResident(residentId: string): Promise<void> {
    if (!this.#store.has(residentId)) {
      this.#killDriverWindows(residentId);
      this.#messageRooms.delete(residentId);
      this.#messageTreeStore.destroyRoom(residentId);
      // 账与档案同步销：留着 facts.json，重启后账会诈尸回来。
      this.#factLedger?.destroyLedger(residentId);
      this.#store.destroyResident(residentId);
      return;
    }
    this.#killDriverWindows(residentId);
    if (this.#messageRooms.delete(residentId)) {
      this.#messageTreeStore.destroyRoom(residentId);
    }
    this.#factLedger?.destroyLedger(residentId);
    this.#store.destroyResident(residentId);
  }

  // --- P2：消息树 ---

  async say(residentId: string, message: string): Promise<HistoryNode> {
    this.#ensureMessageRoom(residentId);
    return this.#messageTree.say(residentId, message, this.#windowIdOf(residentId));
  }

  async history(residentId: string): Promise<HistoryNode[]> {
    this.#ensureMessageRoom(residentId, "tree");
    // 普通动作半格（MV-C03）：读历史不拦，但查账失败要在日志留下「缺口未知」。
    // #windowIdOf 可能懒开窗——只在接了账的路径上引入这个副作用，未接账时
    // history 保持纯读。
    this.#turnGate?.noteOrdinaryAction(residentId, this.#windowIdOf(residentId));
    return this.#messageTree.history(residentId);
  }

  async reviseNode(residentId: string, nodeId: string, newContent: string): Promise<HistoryNode> {
    this.#ensureMessageRoom(residentId);
    return this.#messageTree.reviseNode(
      residentId,
      nodeId,
      newContent,
      this.#windowIdOf(residentId),
    );
  }

  // --- P3：启动包 ---

  async buildBootPack(residentId: string): Promise<BootPack> {
    const ledger = this.#factLedger;
    // 没接账时不带 currentFacts 分区——「没接账」与「账是空的」在包上是两个
    // 形状，不许编码成同一个值（同 MV-C03 口径）。
    if (ledger === null) return assembleBootPack(this.#store, residentId);
    this.#store.room(residentId); // 住户不存在先亮这个错，与未接账路径同语义。
    // 缺账 = 响亮抛，任何路径都不懒建账（拼错 residentId 同罪）。
    if (!ledger.has(residentId)) throw new LedgerNotFoundError(residentId);
    // 包生成与首窗 baseline 必须在同一同步调用栈：「包之前落的裁定」已进
    // currentSet，「包之后落的」走缺口通道——一条裁定在包与缺口里各出现
    // 恰好一次，不永久漏、不两边重复。
    const bound = this.#driverWindows.get(residentId);
    const live = bound === undefined ? undefined : this.#sessions.get(bound);
    if (live === undefined) {
      this.#session(residentId);
    }
    return assembleBootPack(this.#store, residentId, {
      currentFacts: ledger.currentSet(residentId),
    });
  }

  // --- P4：会话生杀（TODO(P4) 认领者替换）---

  async killSession(residentId: string): Promise<void> {
    this.#store.room(residentId);
    // 只动会话态那张表，一个字节都不碰 nodes / memories / commitments：
    // 会话死，人不能死（C1 验 kill 前后整棵树的 hash 不变）。
    // 删除活会话 —— 下一句 say 会开新 generation、新根；旧 generation 的迟到
    // effect receipt 也不能再被视为当前会话，H1 的 Effect Journal 会接这条线。
    this.#killDriverWindows(residentId);
  }

  // --- P5：迁移 ---

  async exportResident(residentId: string): Promise<Uint8Array> {
    this.#ensureMessageRoom(residentId);
    return this.#migration.exportResident(residentId);
  }

  async importResident(pack: Uint8Array): Promise<string> {
    const residentId = await this.#migration.importResident(pack);
    this.#messageRooms.add(residentId);
    try {
      // 迁入住户补一本空账（baseline=0 的空 book，不开窗）：旧消息树与记忆
      // 不迁成事实账（主笔拍定的口径），账从迁入这一刻起记；已有真账绝不重建。
      if (this.#factLedger !== null && !this.#factLedger.has(residentId)) {
        this.#factLedger.createLedger(residentId);
      }
    } catch (error) {
      // 补账失败回滚导入件：同 createResident，不留「有住户没账」的半成品。
      await this.destroyResident(residentId);
      throw error;
    }
    return residentId;
  }
}

export function createDriver(options: CreateDriverOptions = {}): HarnessDriver {
  return new MistDriver(options);
}

/**
 * 判卷桩申报（#16 裁定 1 的执行）：以下方法当前是 P1 代写的最小实现，
 * 各认领包交付时从名单里划掉自己那几个。隐瞒申报按伪证论。
 */
export const STUBBED: string[] = [];
