/**
 * 开工闸 —— 权威事实账接进派发链的那道闸（图纸 docs/design/multi-viewport.md §3.2）。
 *
 * 账（FactLedger）只回答「缺口是多少」，这道闸决定「缺口怎么办」：
 *
 * - 无缺口（latestSeq == ackedSeq）：放行，记 gate_clear。
 * - 有缺口：拉取缺口条目、格式化成带来源标注的上下文前缀，随本轮发给模型；
 *   回执 ack 包在 TurnPass.commit 里，由 Service 在落树成功后调用（MV-C05：
 *   回执丢失 = commit 没被调用，下轮原样重拉，账上不存在「失约」这种标记）。
 * - 查账失败（unknown）：裁定级动作 fail-closed——beforeTurn 直接抛
 *   GateUnavailableError，模型调用之前失败，不产生任何副作用（MV-C03）。
 *   「查不到」与「查到是零」在 GapProbe 的类型上就是两个值，这里不可能把
 *   unknown 当零放行。
 *
 * 普通动作（读历史这类不对外生效的事）不走 beforeTurn，走 noteOrdinaryAction：
 * 查账失败只记 gate_unknown 日志然后放行——闸的 fail-closed 周长只圈裁定级
 * 动作，普通动作被误伤是图纸 §3.2 明写的代价，不在这里加码。
 *
 * 换气阈值硬闸（MV-D01/D02）也挂在这道闸上（breath-trigger.ts 模块头指的路）：
 * 判断权在账侧，临线的窗无权自判（D8 补记一）。容差由检查点的位置保证——
 * 闸只在回合边界检查用量，撞线的那一轮（含其工具调用）已经跑完，拦的是
 * 下一轮。阈值只能在窗开工时配置：本代首回合过闸后配置锁定到下一代，
 * 运行中（尤其临近红线）的修改请求一律 CONFIG_INVALID（D8：临近红线的窗
 * 无权给自己续命）。
 */

import type { TurnGate, TurnPass } from "../message-tree/service.ts";
import type { FactLedger, LedgerEntry } from "../store/fact-ledger.ts";
import { type BreathTrigger, thresholdBreath } from "./breath-trigger.ts";

/**
 * 查账失败时闸拒绝开工的错。fail-closed 的形状必须是一种响亮的、可按名
 * 捕获的错误——静默降级（把 unknown 当无缺口放行）会把「账不可用」藏成
 * 「没有新裁定」，那正是 MV-C03 要钉死的事故形状。
 */
export class GateUnavailableError extends Error {
  constructor(residentId: string, windowId: string, cause: string) {
    super(
      `开工闸查账失败，裁定级动作 fail-closed：resident=${residentId} window=${windowId}（${cause}）`,
    );
    this.name = "GateUnavailableError";
  }
}

export const CONFIG_INVALID = "CONFIG_INVALID" as const;
export const BREATH_THRESHOLD_REACHED = "BREATH_THRESHOLD_REACHED" as const;

/** 换气阈值默认值（图纸 §4.1：成员配置的绝对 token 数，默认 300k）。 */
export const DEFAULT_BREATH_THRESHOLD_TOKENS = 300_000;

/**
 * 阈值配置被拒（MV-D02）。两种形状同罪：本代已有回合过闸后还来改阈值
 * （临线的窗无权自调），以及阈值本身形状不合法。响亮的、可按 code 捕获的
 * 错误——配置被拒必须炸在请求方眼前，不许静默忽略让人以为续命成功。
 */
export class ConfigInvalidError extends Error {
  readonly code = CONFIG_INVALID;
  constructor(reason: string) {
    super(`${CONFIG_INVALID}: ${reason}`);
    this.name = "ConfigInvalidError";
  }
}

/**
 * 阈值硬闸拦下新回合（MV-D01）。到线即换气（D8：没有「到线写信继续跑」）。
 * 携带统一触发：接住它的宿主直接进换气状态机入口，不用自己再造一个——
 * 阈值触发与手动触发共用同一个 state，入口统一就统一在这个对象上。
 */
export class BreathThresholdError extends Error {
  readonly code = BREATH_THRESHOLD_REACHED;
  readonly windowId: string;
  readonly usage: number;
  readonly threshold: number;
  readonly trigger: BreathTrigger;
  constructor(windowId: string, usage: number, threshold: number) {
    super(
      `${BREATH_THRESHOLD_REACHED}: 上下文用量 ${usage} ≥ 阈值 ${threshold}（window=${windowId}）：到线即换气，本窗不再开新回合`,
    );
    this.name = "BreathThresholdError";
    this.windowId = windowId;
    this.usage = usage;
    this.threshold = threshold;
    this.trigger = thresholdBreath();
  }
}

/**
 * 闸事件。日志必须带完整三元组 (residentId, windowId, generation)——
 * 多窗之后回执链路多一层维度，缺一个字段排查就是噩梦（图纸 §2 代价行）。
 * generation 经可选的 generationOf 向 SessionRegistry 现查；查不到（闸被
 * 用在 registry 之外的窗上）为 null，不伪报。
 */
export interface TurnGateEvent {
  event:
    | "gate_clear"
    | "gate_gap_pulled"
    | "gate_ack"
    | "ack_failed"
    | "gate_unknown"
    | "threshold_reached";
  residentId: string;
  windowId: string;
  generation: number | null;
  /** 人读摘要，如 "pulled 3 entries (seq 5..7)" / "缺口未知" / "回执未达"。 */
  detail: string;
}

export interface TurnEventLogger {
  log(event: TurnGateEvent): void;
}

/**
 * 换气阈值硬闸的计量口（MV-D01）。与账无关——阈值管的是这扇窗的上下文
 * 用量，不是缺口；所以它是可选挂接，不接则闸的行为与接之前完全一致。
 */
export interface BreathThresholdOptions {
  /**
   * 上下文用量计（token）。口径**不含交接信**（MV-D04 / D8 补记二：阈值
   * 核算与上下文预算都不含交接信——信有自己的长度上限管着，计入核算等于
   * 让信给上下文顶缸）。返回 null = 这扇窗无计量，阈值闸对它不触发。
   */
  usageOf: (windowId: string) => number | null;
  /**
   * 阈值穿越的对人可见预告口（MV-D09）。日志不是通知：硬闸在抛错前必须
   * 同时走这条宿主出口。实现方负责同周期去重，并在换气失败后释放去重位。
   */
  announce: (windowId: string) => void;
}

export interface ViewportTurnGateOptions {
  /** 默认 no-op：不接日志的嵌入方不该被迫造一个哑 logger。 */
  logger?: TurnEventLogger;
  /** 窗代际查询口，一般由宿主的 SessionRegistry 适配；不给则事件里 generation 恒为 null。 */
  generationOf?: (windowId: string) => number | null;
  /** 换气阈值计量口；不给则阈值硬闸整体不启用（既有路径一个字不变）。 */
  breath?: BreathThresholdOptions;
}

const noopLogger: TurnEventLogger = {
  log: () => {},
};

/**
 * 缺口条目的注入格式：来源档位（kind）、序号、作者一字不缺——模型要知道
 * 这段话是「权威事实账的缺口」，不是住户刚说的话；缺了标注，裁定会被当成
 * 闲聊，闸就白拉了。supersede 条目额外带 supersedes=seq 指针：解除的是
 * 哪一条必须机器可读地写进注入，否则模型看得见解除、认不出对象。
 */
function formatGapEntry(entry: LedgerEntry): string {
  const supersedes = entry.supersedesSeq === null ? "" : ` | supersedes=seq ${entry.supersedesSeq}`;
  return `[权威事实账缺口 | kind=${entry.kind} | seq=${entry.seq}${supersedes} | author=${entry.author}] ${entry.body}`;
}

/**
 * 初始对齐注入的格式：与缺口标注刻意不同——同一批条目经「现行有效集
 * （初始对齐）」进来是「你醒来时这些裁定已在生效」，经「缺口」进来是
 * 「你上一轮之后新落的」，模型要分得清这两种时态。supersede 条目不涉及：
 * 它不进现行有效集，初始对齐里根本不会出现。
 */
function formatInitialEntry(entry: LedgerEntry): string {
  return `[权威事实账·现行有效集（初始对齐）| kind=${entry.kind} | seq=${entry.seq} | author=${entry.author}] ${entry.body}`;
}

export class ViewportTurnGate implements TurnGate {
  readonly #ledger: FactLedger;
  readonly #logger: TurnEventLogger;
  readonly #generationOf: ((windowId: string) => number | null) | undefined;
  readonly #breath: BreathThresholdOptions | undefined;
  /** 窗级阈值配置（MV-D02）；没配过的窗用 DEFAULT_BREATH_THRESHOLD_TOKENS。 */
  readonly #thresholds = new Map<string, number>();
  /** 本代已有回合过闸的窗 → 过闸时的代际号。阈值配置自此锁定到下一代开工。 */
  readonly #turnStarted = new Map<string, number>();

  constructor(ledger: FactLedger, options: ViewportTurnGateOptions = {}) {
    this.#ledger = ledger;
    this.#logger = options.logger ?? noopLogger;
    this.#generationOf = options.generationOf;
    this.#breath = options.breath;
  }

  #log(event: TurnGateEvent["event"], residentId: string, windowId: string, detail: string): void {
    this.#logger.log({
      event,
      residentId,
      windowId,
      generation: this.#generationOf?.(windowId) ?? null,
      detail,
    });
  }

  /**
   * 窗开工时配置换气阈值（MV-D02）。「开工时」的判据在闸侧而不在窗侧：
   * 本代还没有回合过闸才可配，首回合过闸后本代锁定，换代后重新可配——
   * 每一次配置生效的时刻都是一代的开工，运行中（尤其临近红线）来改
   * 一律 CONFIG_INVALID。判不了开工状态的窗（不在册）同罪：配置落在一扇
   * 闸看不见的窗上等于没配，静默收下比拒绝更坏。
   */
  configureThreshold(windowId: string, tokens: number): void {
    if (!Number.isInteger(tokens) || tokens < 1) {
      throw new ConfigInvalidError(`阈值必须是 ≥ 1 的整数 token 数，实际 ${String(tokens)}`);
    }
    const generation = this.#generationOf?.(windowId) ?? null;
    if (generation === null) {
      throw new ConfigInvalidError(`窗不在册（${windowId}）：判不了开工状态，阈值配置无处生效`);
    }
    if (this.#turnStarted.get(windowId) === generation) {
      throw new ConfigInvalidError(
        `窗 ${windowId} 的第 ${generation} 代已有回合过闸：阈值只能在开工时配置，临线的窗无权自调`,
      );
    }
    this.#thresholds.set(windowId, tokens);
  }

  /** 回合过闸即本代已开工：阈值配置就此锁定到下一代（MV-D02）。 */
  #markTurnStarted(windowId: string): void {
    const generation = this.#generationOf?.(windowId) ?? null;
    if (generation !== null) {
      this.#turnStarted.set(windowId, generation);
    }
  }

  beforeTurn(residentId: string, windowId: string): TurnPass {
    // 阈值硬闸（MV-D01）在查账之前：到线的窗连缺口都不该再拉——这一轮
    // 根本不许开始。容差由检查点的位置保证：撞线的那轮（含其工具调用）
    // 已经跑完，这里拦的是下一轮。
    const usage = this.#breath?.usageOf(windowId) ?? null;
    if (usage !== null) {
      const threshold = this.#thresholds.get(windowId) ?? DEFAULT_BREATH_THRESHOLD_TOKENS;
      if (usage >= threshold) {
        this.#log(
          "threshold_reached",
          residentId,
          windowId,
          `上下文用量 ${usage} ≥ 阈值 ${threshold}：硬闸拦下新回合`,
        );
        this.#breath?.announce(windowId);
        throw new BreathThresholdError(windowId, usage, threshold);
      }
    }
    const probe = this.#ledger.probeGap(residentId, windowId);
    if (probe.status === "unknown") {
      this.#log("gate_unknown", residentId, windowId, `缺口未知：${probe.cause}`);
      throw new GateUnavailableError(residentId, windowId, probe.cause);
    }
    // 初始对齐未交付的窗（pendingInitial 非 null）：把开窗截面冻结的现行
    // 有效集快照随本轮注入，排在缺口之前。开窗记 baseline 不算交付——
    // 否则 say-first 的窗会把开窗前已生效的裁定永久跳过；快照必须是冻结
    // 的——现取 currentSet 会在「首轮交付前被 supersede」时让原裁定无声
    // 消失（模型只收到一条指向陌生 seq 的解除）。缺口条目永远只含
    // baseline 之后的事件，与快照不重叠。
    const pending = this.#ledger.pendingInitial(residentId, windowId);
    const initialLines = pending === null ? [] : pending.map(formatInitialEntry);
    // 空快照（开窗时现行集为空）与已交付在日志上同形：交付零条不值得占一行摘要。
    const aligning = initialLines.length > 0;
    if (probe.latestSeq === probe.ackedSeq) {
      const detail = aligning
        ? `无缺口（latestSeq=${probe.latestSeq}）；初始对齐交付 ${initialLines.length} 条现行有效集`
        : `无缺口（latestSeq=${probe.latestSeq}）`;
      this.#log("gate_clear", residentId, windowId, detail);
      // ackedSeq 已平 latestSeq，无需 ack；commit 只负责确认交付（幂等）——
      // assistantReply 失败时 commit 不被调用，快照保留，下轮原样重交。
      this.#markTurnStarted(windowId);
      return {
        contextPrefix: initialLines,
        commit: () => {
          this.#ledger.clearPendingInitial(residentId, windowId);
        },
      };
    }
    const entries = this.#ledger.gapEntries(residentId, windowId);
    const first = entries[0];
    const last = entries[entries.length - 1];
    // gapEntries 按定义返回 seq > ackedSeq 的全部条目，缺口存在时不可能为空；
    // 防御分支只为类型系统，不为运行时。
    const seqRange =
      first !== undefined && last !== undefined ? `seq ${first.seq}..${last.seq}` : "seq 空";
    this.#log(
      "gate_gap_pulled",
      residentId,
      windowId,
      pending === null || !aligning
        ? `pulled ${entries.length} entries (${seqRange})`
        : `pulled ${entries.length} entries (${seqRange})；初始对齐交付 ${initialLines.length} 条现行有效集`,
    );
    this.#markTurnStarted(windowId);
    return {
      contextPrefix: [...initialLines, ...entries.map(formatGapEntry)],
      commit: () => {
        // ack 到开工那一刻的 latestSeq：开工期间新落的账不属于这一轮，
        // 下一轮开工时经缺口通道再拉——ack 只追认本轮真正注入过的内容。
        try {
          this.#ledger.ack(residentId, windowId, probe.latestSeq);
        } catch (error) {
          // 回执未达不能否认本轮已交付（MV-C05）：树与 head 都已提交，
          // 向外抛错会让调用方以为这轮没发生而重试——同一句话落树两次。
          // 记 ack_failed，ackedSeq 不前进、快照保留，下轮开工连缺口
          // 带快照一起重交。
          this.#log(
            "ack_failed",
            residentId,
            windowId,
            `回执未达：${error instanceof Error ? error.message : String(error)}`,
          );
          return;
        }
        // 先 ack 再确认交付：回执到了才认「这轮交付完成」。
        this.#ledger.clearPendingInitial(residentId, windowId);
        this.#log("gate_ack", residentId, windowId, `acked seq=${probe.latestSeq}`);
      },
    };
  }

  /**
   * 普通动作的半格（MV-C03 的另一半）：查账失败只记日志、不拦——普通动作
   * 不改变对外可见状态，被账不可用误伤是图纸认下的代价之外的事。
   * 查到账时什么都不做：普通动作本来就不需要缺口数据。
   */
  noteOrdinaryAction(residentId: string, windowId: string): void {
    const probe = this.#ledger.probeGap(residentId, windowId);
    if (probe.status === "unknown") {
      this.#log("gate_unknown", residentId, windowId, `缺口未知：${probe.cause}`);
    }
  }
}
