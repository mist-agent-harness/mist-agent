/**
 * 换气流程 —— 把「信」和「换代」接成一条不可分割的路（图纸 §4.1）。
 *
 * 泳道 3 第一刀做的是信这个数据结构本身（`handover-letter.ts`）与手动入口的
 * 解析表（`breath-trigger.ts`）。这一刀把它们接进真实路径：
 *
 *   threshold_reached → writing_letter → sealed（信落时间线）
 *     → 换代（windowId 不变，generation + 1）
 *     → 新代醒来，上下文里信全文已在
 *
 * ## 三条不肯让步的判据
 *
 * 1. **换气是一个动作，不是两个**（MV-D10）。底层换代走的是
 *    `kill(windowId)` → `open(residentId, { windowId })`——注册表只提供这一条
 *    路（`#requireArchivedForReopen` 要求目标已归档）。这中间窗短暂处于归档
 *    态，是实现细节；本模块把两步锁进同一个同步区，中途不交出控制权，
 *    **对外只暴露「换气成功」或「换气失败且窗没动过」两种结果**。
 *    半途而废会留下一扇归档了但没重开的窗——住户的家没了，而账上看不出来。
 *
 * 2. **信先落定，再换代**（图纸 §4.1 的 sealed 在新代之前）。顺序反过来的话，
 *    新代已经醒了而信还没落盘，一旦落盘失败，这一代就是**没有交接的换代**——
 *    而那正是交接信要防的全部内容。所以 `appendLetter` 抛错或拒绝时换代不发生。
 *
 * 3. **失败必须有人看见**（MV-D09）。换气失败时住户是被换的那个，
 *    ta 没有视角看见自己没被换。所以失败走 `notify` 而不是只落日志字段；
 *    并且**失败会清掉本周期的预告记号**，下一次阈值穿越重新发预告——
 *    「本周期已发过」这种去重逻辑正好会把连续失败静默掉。
 *
 * 第三刀给这条路加了一道前置闸（MV-D07b）：封信之前的流水卫生检查分两档——
 * 中断产生的**合法残骸**（如末尾悬着一条没回应的 user 节点）降级为 debris
 * 警告并记档，换气照常完成，同一份残骸不得楔死状态机；会导致下游 API
 * 调用失败的**畸形结构**才硬拦（stage=hygiene），此时窗一根汗毛没动，
 * 宿主隔离残骸后重试即可走完。
 *
 * 本模块不决定何时换气（那是阈值闸 MV-D01/D02 的事），不写信的内容
 * （那是住户的事），不实现时间线（`appendLetter` 是注入口）。
 */

import { type LetterDraft, type SealedLetter, sealLetter } from "./handover-letter.ts";
import type { ActiveWindow, SessionRegistry } from "./session-registry.ts";

export const BREATH_CYCLE_FAILED = "BREATH_CYCLE_FAILED" as const;

export class BreathCycleError extends Error {
  readonly code = BREATH_CYCLE_FAILED;
  /** 失败发生在哪一步。判卷靠它区分「信没落成」与「换代没成」。 */
  readonly stage: BreathFailureStage;
  constructor(stage: BreathFailureStage, reason: string, options?: { cause?: unknown }) {
    super(`${BREATH_CYCLE_FAILED}[${stage}]: ${reason}`, options);
    this.name = "BreathCycleError";
    this.stage = stage;
  }
}

/**
 * 失败分档。`hygiene`、`seal`、`append` 与 `inject` 发生在换代之前——窗一根
 * 汗毛没动；`swap` 是换代本身失败，窗可能停在归档态，本模块会尽力回滚并
 * 在通知里标出 `windowRecovered`，让人知道该不该手动捞。
 */
export type BreathFailureStage = "hygiene" | "seal" | "append" | "inject" | "swap";

/** 对人可见的换气通知（MV-D09）。落日志字段不算数，这个要送到人眼前。 */
export type BreathNotification =
  | {
      kind: "announced";
      windowId: string;
      /** 预告发出时正在跑的那一代。 */
      generation: number;
    }
  | {
      /**
       * 流水卫生检查发现的合法残骸（MV-D07b 的警告档）：换气照常完成，
       * 残骸随旧代归档，但人要能看见这一代是带着残骸换的气——记档即此。
       * 畸形结构不走这档，走 failed/hygiene 硬拦。
       */
      kind: "debris";
      windowId: string;
      /** 发现残骸的那一代。 */
      generation: number;
      /** 人读的残骸描述，一条残骸一行。 */
      remnants: string[];
    }
  | {
      kind: "completed";
      windowId: string;
      /** 写信的那一代。 */
      fromGeneration: number;
      /** 醒来的那一代。 */
      toGeneration: number;
      letterTitle: string;
    }
  | {
      kind: "failed";
      windowId: string;
      generation: number;
      stage: BreathFailureStage;
      reason: string;
      /**
       * 只在 `stage === "swap"` 时有意义：窗最后是不是活的。
       * false 表示归档了但没重开成——这扇窗需要人来捞。
       */
      windowRecovered: boolean;
    };

/**
 * 流水卫生检查的两档结果（MV-D07b）。分档标准只有一条：**这个形状会不会
 * 让下游 API 调用失败**。会（畸形）→ malformed，硬拦；不会、只是中断留下
 * 的不完整（残骸）→ remnants，警告并记档，换气照常。
 */
export interface FlowInspection {
  /** 畸形结构（硬拦档），人读描述，一条一处。 */
  malformed: string[];
  /** 合法残骸（警告档），人读描述，一条一处。 */
  remnants: string[];
}

const FLOW_ROLES: readonly string[] = ["user", "assistant", "system"];

/**
 * 检查一段流水的卫生。输入是**原始形状**的节点序列（unknown[]）——检查
 * 就是为残骸与畸形设的，上游不许先过滤，过滤了这里就没东西可查。
 *
 * 不判 parentId 悬空：流水是本代的切片，切片首节点的父在切片之外（上一代
 * 的末尾），判悬空会误伤每一代的第一条，故悬空不在畸形档。
 */
export function inspectFlowHygiene(flow: unknown[]): FlowInspection {
  const malformed: string[] = [];
  const remnants: string[] = [];
  const seen = new Set<string>();
  /** 形状合法的节点才参与残骸判定——畸形节点已占硬拦档，不重复记。 */
  const valid: { id: string; role: string }[] = [];
  flow.forEach((node, index) => {
    const at = `流水[${index}]`;
    if (typeof node !== "object" || node === null || Array.isArray(node)) {
      malformed.push(`${at} 不是节点对象`);
      return;
    }
    const candidate = node as {
      id?: unknown;
      parentId?: unknown;
      role?: unknown;
      content?: unknown;
      createdAt?: unknown;
    };
    if (typeof candidate.id !== "string" || candidate.id.length === 0) {
      malformed.push(`${at} 缺合法 id`);
      return;
    }
    let bad = false;
    if (seen.has(candidate.id)) {
      malformed.push(`${at} 的 id ${candidate.id} 与前文重复`);
      bad = true;
    }
    seen.add(candidate.id);
    if (candidate.parentId !== null && typeof candidate.parentId !== "string") {
      malformed.push(`${at} 的 parentId 不是 string | null`);
      bad = true;
    }
    if (typeof candidate.role !== "string" || !FLOW_ROLES.includes(candidate.role)) {
      malformed.push(
        `${at} 的 role=${String(candidate.role)} 超出 ${FLOW_ROLES.join(" | ")}：下游 API 会直接拒绝`,
      );
      bad = true;
    }
    if (typeof candidate.content !== "string") {
      malformed.push(`${at} 的 content 不是 string：下游 API 会直接拒绝`);
      bad = true;
    }
    if (typeof candidate.createdAt !== "string") {
      malformed.push(`${at} 缺 createdAt`);
      bad = true;
    }
    if (!bad) {
      valid.push({ id: candidate.id, role: candidate.role as string });
    }
  });
  const last = valid.at(-1);
  if (last !== undefined && last.role === "user") {
    remnants.push(`流水末尾停在一条没有回应的 user 节点（${last.id}）：回合中途猝死的残骸`);
  }
  for (let i = 1; i < valid.length; i += 1) {
    const previous = valid[i - 1];
    const current = valid[i];
    if (previous === undefined || current === undefined || previous.role !== current.role) {
      continue;
    }
    if (current.role === "assistant") {
      // 生产判据（照阿问生产版，旦九 2026-08-27 裁定）：Claude Messages API
      // 要求 user / assistant 严格交替，连续 assistant 会被上游直接拒绝——
      // 会让下游调用失败的形状一律硬拦，不许降档。
      malformed.push(
        `${current.id} 与前一条 ${previous.id} 同为 assistant：下游 Messages API 要求 user/assistant 交替，会直接拒绝`,
      );
    } else if (current.role === "user") {
      remnants.push(`${current.id} 与前一条 ${previous.id} 同为 user：中断重试留下的残骸`);
    }
  }
  return { malformed, remnants };
}

export interface BreathCycleOptions<TContext> {
  registry: SessionRegistry<TContext>;
  /**
   * 信落时间线（图纸 §4.2：「信落时间线，归档当前代际流水」）。
   * 不另建 letter store——第三条持久化路径没有依据（旦九 2026-08-21 裁定）。
   * 抛错或 Promise 拒绝即换代不发生；换代必须等耐久写回执。
   */
  appendLetter: (letter: SealedLetter) => unknown;
  /**
   * 把信塞进新代的启动上下文（MV-D04）。装配器保持住户级纯函数不碰信，
   * 注入责任放在换气流程——它才是唯一知道「这扇窗上一代是谁」的地方
   * （旦九 2026-08-21 裁定，方向 2）。
   */
  injectLetter: (context: TContext, letter: SealedLetter) => TContext;
  /** 对人可见的通知口（MV-D09）。 */
  notify: (event: BreathNotification) => void;
  /**
   * 本代流水的取口（MV-D07b 卫生检查的数据源）。返回本代流水节点的原始
   * 形状序列——允许残骸与畸形混入，检查就是为它俩设的。不给则不检查：
   * 没接流水的嵌入方不该被迫造哑口。
   */
  flowOf?: (window: ActiveWindow<TContext>) => unknown[];
  /** 当刻时间，ISO-8601 UTC。显式注入而不是模块内取——可判卷。 */
  now: () => string;
}

export interface BreathResult<TContext> {
  window: ActiveWindow<TContext>;
  letter: SealedLetter;
}

export class BreathCycle<TContext> {
  readonly #options: BreathCycleOptions<TContext>;
  /**
   * 已经发过预告、但还没换成气的窗。
   * 用途只有一个：让「本周期已预告」的去重**不会跨过失败**（MV-D09 后半）。
   */
  readonly #announced = new Set<string>();

  constructor(options: BreathCycleOptions<TContext>) {
    this.#options = options;
  }

  /**
   * 阈值穿越时发预告。同一周期内重复调用只发一次；
   * **但换气失败会清掉记号**，所以失败后的下一次穿越必然重新发。
   *
   * 返回是否真的发了通知——判卷需要区分「发了」与「被去重吃掉了」。
   */
  announce(windowId: string): boolean {
    const window = this.#options.registry.get(windowId);
    if (window === undefined) {
      throw new BreathCycleError("swap", `window is not live: ${windowId}`);
    }
    if (this.#announced.has(windowId)) {
      return false;
    }
    this.#announced.add(windowId);
    this.#options.notify({
      kind: "announced",
      windowId,
      generation: window.generation,
    });
    return true;
  }

  /**
   * 走完一次换气：封信 → 落时间线 → 换代 → 注入。
   *
   * 成功返回新代的活窗与那封信；任何一步失败都抛 BreathCycleError，
   * 并且**先通知再抛**——调用方可能吞掉异常，但人得看见。
   */
  async breathe(windowId: string, draft: LetterDraft): Promise<BreathResult<TContext>> {
    const { registry, appendLetter, injectLetter, notify, now } = this.#options;

    const current = registry.get(windowId);
    if (current === undefined) {
      const reason = `window is not live: ${windowId}`;
      // 窗都不在，谈不上代际；用 0 占位并在 reason 里说清楚。
      this.#fail(windowId, 0, "swap", reason, true);
      throw new BreathCycleError("swap", reason);
    }

    const fromGeneration = current.generation;

    // ⓪ 流水卫生检查（MV-D07b），在封信之前。畸形结构硬拦：把会导致下游
    // API 调用失败的流水封进归档，下一代继承的是一具必炸的尸体。合法残骸
    // 只警告并记档（debris 通知），换气照常完成——残骸属于被归档的旧代，
    // 不许楔死这扇窗此后所有的换气。
    if (this.#options.flowOf !== undefined) {
      const inspection = inspectFlowHygiene(this.#options.flowOf(current));
      if (inspection.malformed.length > 0) {
        const reason = `流水卫生检查硬拦：${inspection.malformed.join("；")}`;
        this.#fail(windowId, fromGeneration, "hygiene", reason, true);
        throw new BreathCycleError("hygiene", reason);
      }
      if (inspection.remnants.length > 0) {
        notify({
          kind: "debris",
          windowId,
          generation: fromGeneration,
          remnants: inspection.remnants,
        });
      }
    }

    // ① 封信。校验不过就停在这里——窗一根汗毛没动。
    let letter: SealedLetter;
    try {
      letter = sealLetter(draft, {
        residentId: current.residentId,
        windowId: current.windowId,
        generation: fromGeneration,
        now: now(),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.#fail(windowId, fromGeneration, "seal", reason, true);
      throw new BreathCycleError("seal", reason, { cause: error });
    }

    // ② 信先落定。落盘失败则换代不发生——宁可不换代，不可无信换代。
    try {
      await appendLetter(letter);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.#fail(windowId, fromGeneration, "append", reason, true);
      throw new BreathCycleError("append", reason, { cause: error });
    }

    // ③ 换代。kill + open 锁在同一个同步区，中途不 await。
    const archivedHeadId = current.headId;
    const scopeId = current.scopeId;
    const residentId = current.residentId;
    // ④ 注入先算完，再动窗。参数在调用前求值——若把 injectLetter 写在
    // open(...) 的参数位上，它一抛错就落在 kill 之后、open 之前：窗已归档、
    // 新代没开，正好违反模块头的「失败且窗没动过」。（cursor 08-25 抓的）
    let nextContext: TContext;
    try {
      nextContext = injectLetter(current.context, letter);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // 窗一个字没动：kill 还没执行，如实报 recovered=true。
      this.#fail(windowId, fromGeneration, "inject", reason, true);
      throw new BreathCycleError("inject", reason, { cause: error });
    }
    let reopened: ActiveWindow<TContext>;
    try {
      registry.kill(windowId);
      reopened = registry.open(residentId, {
        windowId,
        scopeId,
        headId: archivedHeadId,
        // 新代醒来时信全文已在上下文里，不需要任何工具调用。
        context: nextContext,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // 窗可能停在归档态。据实报告，不粉饰——需要人来捞的时候得说出口。
      const recovered = registry.get(windowId) !== undefined;
      this.#fail(windowId, fromGeneration, "swap", reason, recovered);
      throw new BreathCycleError("swap", reason, { cause: error });
    }

    this.#announced.delete(windowId);
    notify({
      kind: "completed",
      windowId,
      fromGeneration,
      toGeneration: reopened.generation,
      letterTitle: letter.title,
    });
    return { window: reopened, letter };
  }

  /**
   * 失败的收尾动作只有一件是必须的：**清掉预告记号**。
   * 留着它，下一次阈值穿越会被「本周期已发过」吃掉，
   * 于是连续失败对人完全静默——这正是 MV-D09 后半要防的。
   */
  #fail(
    windowId: string,
    generation: number,
    stage: BreathFailureStage,
    reason: string,
    windowRecovered: boolean,
  ): void {
    this.#announced.delete(windowId);
    this.#options.notify({
      kind: "failed",
      windowId,
      generation,
      stage,
      reason,
      windowRecovered,
    });
  }
}
