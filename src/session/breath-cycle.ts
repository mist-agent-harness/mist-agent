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
 *    而那正是交接信要防的全部内容。所以 `appendLetter` 抛错时换代不发生。
 *
 * 3. **失败必须有人看见**（MV-D09）。换气失败时住户是被换的那个，
 *    ta 没有视角看见自己没被换。所以失败走 `notify` 而不是只落日志字段；
 *    并且**失败会清掉本周期的预告记号**，下一次阈值穿越重新发预告——
 *    「本周期已发过」这种去重逻辑正好会把连续失败静默掉。
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
 * 失败分档。`seal` 与 `append` 发生在换代之前——窗一根汗毛没动；
 * `swap` 是换代本身失败，窗可能停在归档态，本模块会尽力回滚并在通知里
 * 标出 `windowRecovered`，让人知道该不该手动捞。
 */
export type BreathFailureStage = "seal" | "append" | "swap";

/** 对人可见的换气通知（MV-D09）。落日志字段不算数，这个要送到人眼前。 */
export type BreathNotification =
  | {
      kind: "announced";
      windowId: string;
      /** 预告发出时正在跑的那一代。 */
      generation: number;
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

export interface BreathCycleOptions<TContext> {
  registry: SessionRegistry<TContext>;
  /**
   * 信落时间线（图纸 §4.2：「信落时间线，归档当前代际流水」）。
   * 不另建 letter store——第三条持久化路径没有依据（旦九 2026-08-21 裁定）。
   * 抛错即换代不发生。
   */
  appendLetter: (letter: SealedLetter) => void;
  /**
   * 把信塞进新代的启动上下文（MV-D04）。装配器保持住户级纯函数不碰信，
   * 注入责任放在换气流程——它才是唯一知道「这扇窗上一代是谁」的地方
   * （旦九 2026-08-21 裁定，方向 2）。
   */
  injectLetter: (context: TContext, letter: SealedLetter) => TContext;
  /** 对人可见的通知口（MV-D09）。 */
  notify: (event: BreathNotification) => void;
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
  breathe(windowId: string, draft: LetterDraft): BreathResult<TContext> {
    const { registry, appendLetter, injectLetter, notify, now } = this.#options;

    const current = registry.get(windowId);
    if (current === undefined) {
      const reason = `window is not live: ${windowId}`;
      // 窗都不在，谈不上代际；用 0 占位并在 reason 里说清楚。
      this.#fail(windowId, 0, "swap", reason, true);
      throw new BreathCycleError("swap", reason);
    }

    const fromGeneration = current.generation;

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
      appendLetter(letter);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.#fail(windowId, fromGeneration, "append", reason, true);
      throw new BreathCycleError("append", reason, { cause: error });
    }

    // ③ 换代。kill + open 锁在同一个同步区，中途不 await。
    const archivedHeadId = current.headId;
    const scopeId = current.scopeId;
    const residentId = current.residentId;
    let reopened: ActiveWindow<TContext>;
    try {
      registry.kill(windowId);
      reopened = registry.open(residentId, {
        windowId,
        scopeId,
        headId: archivedHeadId,
        // ④ 注入：新代醒来时信全文已在上下文里，不需要任何工具调用。
        context: injectLetter(current.context, letter),
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
