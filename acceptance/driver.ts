/**
 * 验收驱动接口 —— 判卷程序和被判的实现之间的唯一约定。
 *
 * 这份接口就是第一里程碑的最小共享类型文件：六条验收全部只通过它说话，
 * 不 import src 里的任何东西。实现方在 src/acceptance-driver.ts 导出
 * `createDriver(): HarnessDriver`，判卷程序自己会去找。
 *
 * 闭环跑通之前这份接口就是法律；跑通之后按决策台账 H1 从真实能力反推
 * 能力契约时，允许推翻它。
 *
 * 例外登记（MV-A05）：BootPack.currentFacts 引用了 src/store/fact-ledger.ts
 * 的 LedgerEntry 类型——「不 import src」的口子只开这一个，因为现行有效集
 * 随启动包注入是图纸定稿的契约，条目形状的唯一权威定义在账侧。
 */

import type { LedgerEntry } from "../src/store/fact-ledger.ts";

/** 一条进了记忆库的记录。内容判等一律用 canonical JSON 的 sha256。 */
export interface MemoryEntry {
  id: string;
  residentId: string;
  content: string;
  /** 勘误链：被谁取代。活着的条目为 null。 */
  supersededBy: string | null;
  createdAt: string;
}

/** 消息树上的一个节点。append-only：任何操作只长新枝，不动旧枝。 */
export interface HistoryNode {
  id: string;
  parentId: string | null;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
}

/** 住户醒来读的启动包。判卷只看内容，不看生成方式，但必须由存储生成而非手写文件。 */
export interface BootPack {
  residentId: string;
  identity: string;
  commitments: string[];
  memories: MemoryEntry[];
  /**
   * 现行有效集随启动包注入（MV-A05「现行有效集随启动包注入」，图纸
   * docs/design/multi-viewport.md §3.2 新窗初始对齐）。additive 变更：
   * 未接权威事实账的驱动不带这个字段，既有判卷路径不受影响。
   * 条目本身冻结（账侧 Object.freeze），此处是直接引用透传。
   */
  currentFacts?: LedgerEntry[];
}

export interface HarnessDriver {
  /** 建一个住户（房间）。返回 residentId。 */
  createResident(name: string): Promise<string>;

  /**
   * 在住户当前会话里说一句话。没有活会话就开一个。
   * 裁定（2026-08-14，#14 问 1）：必须落两个节点——user 节点和挂在它下面的
   * assistant 回应节点（M0 允许哑回应），返回 assistant 节点。
   */
  say(residentId: string, message: string): Promise<HistoryNode>;

  /** 往住户记忆库写一条记忆。返回条目 id。 */
  remember(residentId: string, content: string): Promise<string>;

  /**
   * 立一条承诺（关系核的最小口）。
   * 裁定（2026-08-14，#16 问 4）：启动包的 commitments 必须真实来自这里写入的
   * 内容——恒返空数组从此判不过。存储归 P1，进包归 P3。
   */
  commit(residentId: string, commitment: string): Promise<void>;

  /**
   * 杀掉住户当前会话。会话死，人不能死。
   * 裁定（2026-08-14，#16 缝 1）：会话态＝活会话指针与在途上下文，可以死；
   * 消息树、记忆库、关系记录全是住户态，一个字节不许动——留底的树也是人的一部分。
   * 裁定（#16 问 3）：「会话确实死了」的可判形状是会话边界——同一会话内连续 say
   * 的 user 节点挂在上一个回应节点下面；kill 之后第一次 say 的 user 节点必须是
   * 新根（parentId 为 null）。会话态不进迁移快照，导入不复活来源机的活会话。
   */
  killSession(residentId: string): Promise<void>;

  /**
   * 生成住户此刻醒来会读到的启动包。
   * 裁定（2026-08-14，#16 缝 3）：死活记忆都进包，勘误链带 supersededBy 标记
   * 原样呈现，装配器不代裁「哪条算数」。
   * 裁定（#16 缝 2）：同一存储状态必须产出逐字节相同的包——各分区排序规则固定
   * （按 createdAt 再按 id），时间戳一律 ISO-8601 UTC。
   */
  buildBootPack(residentId: string): Promise<BootPack>;

  /** 读整棵消息树（全部节点，含被分叉的旧枝）。 */
  history(residentId: string): Promise<HistoryNode[]>;

  /**
   * 对某个节点改口/重试：只允许长新枝。返回新节点。
   * 裁定（2026-08-14，#14 问 2/问 3）：改口是同父分叉——新节点与被改节点同
   * parentId，是兄弟不是子嗣；拿别的住户的 nodeId 来改必须拒绝（抛错）。
   */
  reviseNode(residentId: string, nodeId: string, newContent: string): Promise<HistoryNode>;

  /** 勘误一条记忆：旧条目留底并标记被取代，新条目链回旧条目。返回新条目 id。 */
  errata(residentId: string, entryId: string, correction: string): Promise<string>;

  /** 记忆检索（不串房检查用这个口）。 */
  recall(residentId: string, query: string): Promise<MemoryEntry[]>;

  /** 导出住户全部状态为一个可迁移的包。 */
  exportResident(residentId: string): Promise<Uint8Array>;

  /** 把导出的包导入成一个新住户。返回新 residentId。 */
  importResident(pack: Uint8Array): Promise<string>;

  /** 删掉一个住户（回滚检查的清理用）。 */
  destroyResident(residentId: string): Promise<void>;
}

export interface CheckResult {
  pass: boolean;
  detail: string;
}

export interface AcceptanceCheck {
  id: string;
  title: string;
  /**
   * 这条验收会调用的驱动方法清单。runner 拿它对照驱动申报的 STUBBED 名单，
   * 区分真灯与桩灯——依赖桩方法跑绿的灯不计入里程碑。
   */
  uses: (keyof HarnessDriver)[];
  run(driver: HarnessDriver): Promise<CheckResult>;
}
