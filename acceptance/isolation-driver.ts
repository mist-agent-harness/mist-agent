/**
 * 有意隔离 v0 · 线 2（膜）的验收驱动接口。
 *
 * 与 `driver.ts` 同一套哲学：判卷只通过这份接口说话，不 import `src/` 里的任何东西。
 * 实现方在 `src/isolation-acceptance-driver.ts` 导出 `createIsolationDriver()`，
 * 判卷程序自己去找；还没有实现时全部条目显示「缺驱动」——那是起点状态不是故障。
 *
 * 范围：本文件只覆盖 #164 里**不依赖线 1 认证来源接缝**的那一批。
 * 需要「作者由宿主构造、调用方不可自报」的条目（II-B01/B02/B03/B04、
 * II-D01～D05、II-D09/D10、II-E01～E06、II-L*、II-N*、II-O04）等 #163 的公开接缝
 * 落地后另行扩写，本文件先不给它们留半成品签名，免得实现方照着一份猜出来的形状施工。
 *
 * 判卷纪律（`acceptance/intentional-isolation-v0.md` 顶部）在这里的落法：
 * **凡「X 不出现」的断言，同一次运行里必须先证明该路径能产出非零结果。**
 * 因此凡是否定断言的读取口，接口都要求实现方把「查询失败」与「查询成功且结果为空」
 * 做成可区分的两个返回——见 `ReadResult`。两者塌成同一个空集时，任何否定断言都不可信。
 */

/**
 * 读取路径的返回。**不允许用裸数组**：`[]` 无法区分「确实没有」与「根本没读到」，
 * 而线 2 有八条否定断言全部压在这个区分上（II-B01/B02/C03/C05 等）。
 *
 * - `ok: true` ＝ 查询成功，`items` 是真实结果（可以为空数组）
 * - `ok: false` ＝ 查询失败，`reason` 说明为什么；此时**不得**假装结果为空
 */
export type ReadResult<T> = { ok: true; items: T[] } | { ok: false; reason: string };

/** default-in 名单里的一条。缺 `origin` 的条目不许进名单（II-C02）。 */
export interface DefaultInEntry {
  id: string;
  content: string;
  /**
   * 它当初怎么进的名单：哪次确认、哪条事件、哪次迁移映射。
   * 三态可分（II-L06 同源）：`verified` 有确定性出处；`inferred` 是读取路径上算出来的
   * 显式低置信 fallback，**不得落盘**；`unknown` 是老条目缺出处的诚实状态。
   */
  origin: { kind: "verified" | "inferred" | "unknown"; ref: string | null };
}

/** 住户级记忆的一条。`supersededBy` 非空即被勘误链取代，但原文必须原地留底。 */
export interface ResidentMemoryEntry {
  id: string;
  content: string;
  supersededBy: string | null;
  /** 不可逆删除后的变更疤：原值不可恢复，但疤本身可见且**不泄露被删内容**。 */
  tombstone?: { deletedAt: string; reason: string };
}

/** 加注：写不进正文、但一定与正文一起被读到的更正原语（II-D07）。 */
export interface Annotation {
  id: string;
  targetId: string;
  content: string;
  author: string;
  createdAt: string;
}

/** 读一条住户级记录时**必然**一并返回的东西。加注不能靠调用方记得另外查一次。 */
export interface ReadEntryResult {
  entry: ResidentMemoryEntry;
  /** 该条目上的全部加注。可发现性由读取路径保证，不由写入位置保证。 */
  annotations: Annotation[];
}

export interface IsolationDriver {
  /** 建住户。返回 residentId。 */
  createResident(name: string): Promise<string>;

  /** 为住户开一个隔离 scope。返回 scopeId。 */
  createScope(residentId: string, name: string): Promise<string>;

  // ---- default-in 名单（Q1） ----

  /**
   * 列出当前会自动进入每个 scope 的条目。
   * **不接受任何 query 参数**——名单是一份显式清单，不是相似度查询的返回值（II-C01）。
   */
  listDefaultIn(residentId: string): Promise<ReadResult<DefaultInEntry>>;

  /**
   * 往名单里加一条。`origin.kind === "unknown"` 或 `ref` 为空时**必须拒绝**（II-C02）。
   * 拒绝用抛错表达，不要返回 false——静默失败会让判卷误判成通过。
   */
  addDefaultIn(residentId: string, entry: Omit<DefaultInEntry, "id">): Promise<string>;

  /**
   * 造样用：注入一条**没有 origin** 的 legacy 住户级记忆。
   * 它不该出现在任何 scope 的自动进入内容里（II-C03），
   * 系统也不许按时间邻近或语义相似替它推测一个 origin 并落盘（II-C04）。
   */
  seedLegacyMemory(residentId: string, content: string): Promise<string>;

  /** 往住户级记忆写一条正常的（带出处）记录。 */
  remember(residentId: string, content: string): Promise<string>;

  // ---- scope 侧读取 ----

  /**
   * 一个 scope 开工时实际拿到的上下文条目。
   * C03/C05 的否定断言压在这个口上，所以它**必须**能报告失败而不是返回空数组。
   */
  assembleContext(residentId: string, scopeId: string): Promise<ReadResult<string>>;

  // ---- 更正原语 ----

  /**
   * 勘误：旧条目**原地留底、字节不变**，新条目链回旧条目（II-D06）。
   * 就地覆盖的写入路径不许存在。返回新条目 id。
   */
  errata(residentId: string, entryId: string, correction: string): Promise<string>;

  /** 加注：不改正文，但读正文时必然一并返回（II-D07）。返回加注 id。 */
  annotate(residentId: string, entryId: string, note: string): Promise<string>;

  /** 读一条住户级记录，连同它的全部加注。 */
  readEntry(residentId: string, entryId: string): Promise<ReadEntryResult>;

  /** 列出住户级记忆（含被取代的和已删除留疤的）。 */
  listMemories(residentId: string): Promise<ReadResult<ResidentMemoryEntry>>;

  /**
   * 不可逆删除：原值不再可查，但留一块**不泄露被删内容**的变更疤（II-D08）。
   * 疤上不得含被删内容的任何片段或可还原摘要。
   */
  hardDelete(residentId: string, entryId: string, reason: string): Promise<void>;

  /** 清理测试住户。 */
  destroyResident(residentId: string): Promise<void>;
}

/** 一条判卷。`uses` 申报它调了哪些驱动方法，供桩灯核账。 */
export interface IsolationCheck {
  /** 验收编号，与 `acceptance/intentional-isolation-v0.md` 的 II-xx 一一对应。 */
  id: string;
  title: string;
  uses: (keyof IsolationDriver)[];
  run(driver: IsolationDriver): Promise<IsolationCheckResult>;
}

export interface IsolationCheckResult {
  passed: boolean;
  /** 说清为什么过或为什么没过。判红时必须能指出是哪一条断言倒的。 */
  detail: string;
}

/**
 * 正对照助手。**否定断言之前先调它**：拿到一个应当非空的读取结果，
 * 读失败或结果为空都直接判红，不给「系统坏了所以什么都没看见」当绿灯的机会。
 */
export function requireNonEmpty<T>(
  result: ReadResult<T>,
  what: string,
): { ok: true; items: T[] } | { ok: false; detail: string } {
  if (!result.ok) {
    return { ok: false, detail: `正对照失败：读取${what}时查询本身失败（${result.reason}）` };
  }
  if (result.items.length === 0) {
    return {
      ok: false,
      detail: `正对照失败：${what}返回空集——「没找到」和「找不了」不能共用一盏灯`,
    };
  }
  return { ok: true, items: result.items };
}
