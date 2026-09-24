/**
 * #120 生产 window-history 只读投影。
 *
 * 先决①（一份底座）：canonical stream event store（src/one-stream/）是唯一底座与
 * 唯一写方，window history 只是它按 `(windowId, generation)` 的只读投影。本类只读，
 * 不持有写句柄、不落盘（WH-06 约束，见 port.ts 顶注）。
 *
 * 读路径镜像 CanonicalStreamProjection 的「验证 + 连续性」纪律：逐条
 * verifyCanonicalEvent，检出 hash 不符 / 无法解码的损坏条目并在 damaged[] 里如实
 * 暴露，绝不静默丢掉健康条目。
 *
 * 代价（明写）：投影要知道「这扇窗是否真的存在」「当前落盘格式版本 / 迁移状态」，
 * 但这些事实的权威在窗身份/生命周期与存储管理侧（SessionRegistry 会做 appendFileSync
 * 落盘，本目录禁止出现落盘写调用）。所以这里定义一个小的只读视图接口
 * `WindowLifecycleView`，由组装根实现并注入——投影本身不 import 任何会带来写句柄或
 * 落盘调用的模块，保住 WH-06 的目录洁净。
 */
import {
  type CanonicalEvent,
  CanonicalEventContractError,
  type CanonicalStreamReadPort,
  verifyCanonicalEvent,
} from "../one-stream/index.ts";
import type {
  DamagedEntryReport,
  MistWindowHistoryPort,
  Result,
  WindowHistoryEntry,
  WindowHistoryError,
  WindowHistoryErrorCode,
  WindowHistoryPage,
  WindowHistoryPageRequest,
  WindowHistoryRef,
  WindowHistorySummary,
} from "./port.ts";

/** 迁移态：与存储管理侧（FEAT-002）口径一致。 */
export type WindowStorageMigrationStatus = "none" | "complete" | "incomplete" | "rolled-back";

/**
 * 一扇窗的只读生命周期/存储事实。组装根（持有 SessionRegistry + 存储管理）实现它，
 * 注入投影。投影只读不写。
 */
export interface WindowLifecycleView {
  /** 这扇窗的落盘记录是否存在（不存在 => window-not-found；存在但空 => 空页）。 */
  windowExists(input: { residentId: string; windowId: string }): boolean;
  /** 当前落盘格式版本；缺省 1。用于映射 WindowHistoryEntry.formatVersion。 */
  formatVersion(input: { residentId: string; windowId: string }): number;
  /** 当前迁移状态；incomplete => fail-closed migration-incomplete。 */
  migrationStatus(input: { residentId: string; windowId: string }): WindowStorageMigrationStatus;
  /** 这扇窗当下是否有活跃住户在跑（summarize.running）。 */
  isRunning(input: { residentId: string; windowId: string }): boolean;
}

/** 判定「读端口抛的是否为存储不可用类错误」的宽口径：任何底层读异常都 fail-closed。 */
function toStorageUnavailable(windowId: string, error: unknown): WindowHistoryError {
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: "storage-unavailable",
    message: message.length > 0 ? message : "canonical stream read failed",
    windowId,
  };
}

function structuredError(
  code: WindowHistoryErrorCode,
  message: string,
  windowId: string | null,
): WindowHistoryError {
  return { code, message, windowId };
}

interface ScannedEvents {
  /** 通过验证且属于本窗（可选按代过滤后）的健康条目，升序。 */
  readonly healthy: CanonicalEvent[];
  /** 属于本窗但损坏的条目，供 damaged[] 暴露。 */
  readonly damaged: DamagedEntryReport[];
  /** 本窗（未按代过滤）是否有任何落盘事件，供 summarize.blank 判定。 */
  readonly windowHasAnyEvent: boolean;
}

export class WindowHistoryProjection implements MistWindowHistoryPort {
  readonly #readPort: CanonicalStreamReadPort;
  readonly #lifecycle: WindowLifecycleView;

  constructor(readPort: CanonicalStreamReadPort, lifecycle: WindowLifecycleView) {
    this.#readPort = readPort;
    this.#lifecycle = lifecycle;
  }

  async read(
    ref: WindowHistoryRef,
    page: WindowHistoryPageRequest,
  ): Promise<Result<WindowHistoryPage>> {
    const guard = this.#guard(ref);
    if (guard !== null) return { ok: false, error: guard };

    let scanned: ScannedEvents;
    try {
      scanned = this.#scan(ref);
    } catch (error) {
      return { ok: false, error: toStorageUnavailable(ref.windowId, error) };
    }

    const formatVersion = this.#lifecycle.formatVersion({
      residentId: ref.residentId,
      windowId: ref.windowId,
    });
    const mapped = scanned.healthy.map((event) => this.#toEntry(event, formatVersion));
    const paged = paginate(mapped, page);

    return {
      ok: true,
      value: {
        windowId: ref.windowId,
        entries: paged.entries,
        damaged: scanned.damaged,
        hasMore: paged.hasMore,
      },
    };
  }

  async summarize(ref: WindowHistoryRef): Promise<Result<WindowHistorySummary>> {
    const guard = this.#guard(ref);
    if (guard !== null) return { ok: false, error: guard };

    let scanned: ScannedEvents;
    try {
      scanned = this.#scan(ref);
    } catch (error) {
      return { ok: false, error: toStorageUnavailable(ref.windowId, error) };
    }

    return {
      ok: true,
      value: {
        windowId: ref.windowId,
        updatedAt: deriveUpdatedAt(scanned.healthy),
        running: this.#lifecycle.isRunning({ residentId: ref.residentId, windowId: ref.windowId }),
        // blank 判整窗有无历史（不受 generation 过滤影响）：确实没写过 => true。
        blank: !scanned.windowHasAnyEvent,
      },
    };
  }

  /**
   * read/summarize 共用的 fail-closed 前置判据：
   *   - 窗不存在（落盘记录缺失/被删）=> window-not-found；
   *   - 存储停在迁移未完成态 => migration-incomplete。
   * 返回 null 表示可继续读。
   */
  #guard(ref: WindowHistoryRef): WindowHistoryError | null {
    const key = { residentId: ref.residentId, windowId: ref.windowId };
    if (!this.#lifecycle.windowExists(key)) {
      return structuredError(
        "window-not-found",
        `no durable window history for ${ref.residentId}/${ref.windowId}`,
        ref.windowId,
      );
    }
    if (this.#lifecycle.migrationStatus(key) === "incomplete") {
      return structuredError(
        "migration-incomplete",
        `storage format migration is incomplete for ${ref.residentId}/${ref.windowId}`,
        ref.windowId,
      );
    }
    return null;
  }

  /**
   * 从读端口拉本住户全部事件，验证 + 连续性检查，按 windowId（及可选 generation）过滤，
   * 检出损坏条目。读端口抛错则向上传播，由调用方转 storage-unavailable。
   */
  #scan(ref: WindowHistoryRef): ScannedEvents {
    const incoming = this.#readPort.eventsAfter(ref.residentId, 0);
    const healthy: CanonicalEvent[] = [];
    const damaged: DamagedEntryReport[] = [];
    let windowHasAnyEvent = false;
    let expected = 1;

    for (const event of incoming) {
      // 连续性：镜像 CanonicalStreamProjection，streamSeq 必须逐一递增。
      if (event.streamSeq !== expected) {
        throw new CanonicalEventContractError(
          `projection sequence gap: expected ${expected}, got ${event.streamSeq}`,
        );
      }
      expected += 1;

      const viewport = event.origin.viewport;
      if (viewport === null || viewport.windowId !== ref.windowId) continue;
      windowHasAnyEvent = true;
      if (ref.generation !== null && viewport.generation !== ref.generation) continue;

      const damage = classifyDamage(event);
      if (damage !== null) {
        damaged.push({ streamSeq: event.streamSeq, reason: damage });
        continue;
      }
      healthy.push(event);
    }

    healthy.sort((left, right) => left.streamSeq - right.streamSeq);
    damaged.sort((left, right) => left.streamSeq - right.streamSeq);
    return { healthy, damaged, windowHasAnyEvent };
  }

  #toEntry(event: CanonicalEvent, formatVersion: number): WindowHistoryEntry {
    // viewport 非空由 #scan 的过滤保证（只有落在本窗的事件进到这里）。
    const generation = event.origin.viewport?.generation ?? 0;
    return {
      eventId: event.eventId,
      streamSeq: event.streamSeq,
      generation,
      payloadHash: event.payloadHash,
      formatVersion,
      payload: event.payload,
    };
  }
}

/** hash 不符 => hash-mismatch；结构/契约无法解码 => undecodable；健康 => null。 */
function classifyDamage(event: CanonicalEvent): DamagedEntryReport["reason"] | null {
  try {
    verifyCanonicalEvent(event);
    return null;
  } catch (error) {
    if (error instanceof CanonicalEventContractError && error.message.includes("payload hash")) {
      return "hash-mismatch";
    }
    return "undecodable";
  }
}

interface PaginationOutcome {
  readonly entries: WindowHistoryEntry[];
  readonly hasMore: boolean;
}

/**
 * 分页语义（契约定义）：先按 beforeSeq 过滤，再取末尾 maxMessages 条；
 * hasMore 为真当且仅当因为 maxMessages 从头部丢掉了条目。
 */
function paginate(
  entries: readonly WindowHistoryEntry[],
  page: WindowHistoryPageRequest,
): PaginationOutcome {
  const filtered =
    page.beforeSeq === null
      ? [...entries]
      : entries.filter((entry) => entry.streamSeq < (page.beforeSeq as number));

  if (page.maxMessages === null || filtered.length <= page.maxMessages) {
    return { entries: filtered, hasMore: false };
  }
  const tail = filtered.slice(filtered.length - page.maxMessages);
  return { entries: tail, hasMore: true };
}

/**
 * updatedAt 从落盘事件事实确定性派生（不用 wall-clock），重启前后一致。
 * 取健康条目里最大的 streamSeq——它随写入单调增长，且完全由持久化事实决定。
 * 无事件时为 0。
 *
 * 语义已钉死为**单调修订号、不是时间戳**（见 port.ts 的 `updatedAt` 注与
 * docs/design/window-history-projection.md §6.2）：本层没有可信挂钟，返回诚实的修订号
 * 胜过返回一个由 1970 哨兵派生的假时间。代价是「最后活动时间」要另找带时间权威的面。
 */
function deriveUpdatedAt(events: readonly CanonicalEvent[]): number {
  let max = 0;
  for (const event of events) {
    if (event.streamSeq > max) max = event.streamSeq;
  }
  return max;
}
