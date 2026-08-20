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
 */

import type { TurnGate, TurnPass } from "../message-tree/service.ts";
import type { FactLedger, LedgerEntry } from "../store/fact-ledger.ts";

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

/**
 * 闸事件。日志必须带完整三元组 (residentId, windowId, generation)——
 * 多窗之后回执链路多一层维度，缺一个字段排查就是噩梦（图纸 §2 代价行）。
 * generation 经可选的 generationOf 向 SessionRegistry 现查；查不到（闸被
 * 用在 registry 之外的窗上）为 null，不伪报。
 */
export interface TurnGateEvent {
  event: "gate_clear" | "gate_gap_pulled" | "gate_ack" | "gate_unknown";
  residentId: string;
  windowId: string;
  generation: number | null;
  /** 人读摘要，如 "pulled 3 entries (seq 5..7)" / "缺口未知"。 */
  detail: string;
}

export interface TurnEventLogger {
  log(event: TurnGateEvent): void;
}

export interface ViewportTurnGateOptions {
  /** 默认 no-op：不接日志的嵌入方不该被迫造一个哑 logger。 */
  logger?: TurnEventLogger;
  /** 窗代际查询口，一般由宿主的 SessionRegistry 适配；不给则事件里 generation 恒为 null。 */
  generationOf?: (windowId: string) => number | null;
}

const noopLogger: TurnEventLogger = {
  log: () => {},
};

/**
 * 缺口条目的注入格式：来源档位（kind）、序号、作者一字不缺——模型要知道
 * 这段话是「权威事实账的缺口」，不是住户刚说的话；缺了标注，裁定会被当成
 * 闲聊，闸就白拉了。
 */
function formatGapEntry(entry: LedgerEntry): string {
  return `[权威事实账缺口 | kind=${entry.kind} | seq=${entry.seq} | author=${entry.author}] ${entry.body}`;
}

export class ViewportTurnGate implements TurnGate {
  readonly #ledger: FactLedger;
  readonly #logger: TurnEventLogger;
  readonly #generationOf: ((windowId: string) => number | null) | undefined;

  constructor(ledger: FactLedger, options: ViewportTurnGateOptions = {}) {
    this.#ledger = ledger;
    this.#logger = options.logger ?? noopLogger;
    this.#generationOf = options.generationOf;
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

  beforeTurn(residentId: string, windowId: string): TurnPass {
    const probe = this.#ledger.probeGap(residentId, windowId);
    if (probe.status === "unknown") {
      this.#log("gate_unknown", residentId, windowId, `缺口未知：${probe.cause}`);
      throw new GateUnavailableError(residentId, windowId, probe.cause);
    }
    if (probe.latestSeq === probe.ackedSeq) {
      this.#log("gate_clear", residentId, windowId, `无缺口（latestSeq=${probe.latestSeq}）`);
      return { contextPrefix: [], commit: () => {} };
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
      `pulled ${entries.length} entries (${seqRange})`,
    );
    return {
      contextPrefix: entries.map(formatGapEntry),
      commit: () => {
        // ack 到开工那一刻的 latestSeq：开工期间新落的账不属于这一轮，
        // 下一轮开工时经缺口通道再拉——ack 只追认本轮真正注入过的内容。
        this.#ledger.ack(residentId, windowId, probe.latestSeq);
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
