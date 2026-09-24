/**
 * #120 生产 window-history 只读投影的 port 类型。
 *
 * WH-06 约束（静态判卷，见 acceptance/window-history-write-surface.ts）：承载
 * `*WindowHistoryPort` 声明的那个目录就是「投影目录」。所以本目录（src/window-history/）
 * 里的任何 .ts 文件都：
 *   - 不许出现 `CanonicalStreamWriter` 这个字符串（不许持有底座写句柄）；
 *   - 不许调用任何落盘写系统调用（writeFileSync / openSync / renameSync / … 等）。
 * 唯一的 `new CanonicalStreamWriter` 与全部落盘写落在别的目录（组装/宿主根，后续
 * FEAT-002），不在这里。本 port 只声明只读投影的读面。
 *
 * `MistWindowHistoryPort` 的成员必须恰好是 `summarize` 与 `read` 两个，不多不少
 * ——多一个或少一个 WH-06 都判红。
 *
 * 代价（明写）：这里的读侧数据类型是 acceptance/window-history-driver.ts 的 src 侧
 * 副本。acceptance 树按纪律不 import src/one-stream，src/ 又不许 import acceptance/，
 * 所以两套类型只能各自声明。这份副本必须与 acceptance/window-history-driver.ts 的
 * 冻结判卷契约逐字段对齐（字段名、可空性、错误码并集），任何一侧改动都要同步另一侧，
 * 否则生产 port 与判卷口径会漂移。唯一共享的是 JsonObject（从 src/one-stream 引入，
 * 底座即用此类型），不引 webui / @deepseek-ai/dsh-* 任何类型。
 */
import type { JsonObject } from "../one-stream/index.ts";

/**
 * 结构化故障码。WH-04 要求「读不到」与「读到是空」机器可分，所以失败分支带判据。
 * 与 acceptance/window-history-driver.ts 的 `WindowHistoryErrorCode` 并集对齐。
 */
export type WindowHistoryErrorCode =
  /** 存储读失败（权限、IO、句柄失效）。 */
  | "storage-unavailable"
  /** 数据缺失：这窗的落盘记录不存在或被删。不等于「这窗没有历史」。 */
  | "window-not-found"
  /** 页内个别条目 payload 损坏（hash 不符 / 无法解码）。 */
  | "entry-corrupt"
  /** 存储停在迁移未完成态，未续跑也未整体退回。 */
  | "migration-incomplete"
  /** 旧代迟到写被 fail-closed 拒绝。 */
  | "stale-generation"
  /** 同一幂等把手换内容重试被拒绝。 */
  | "idempotency-conflict"
  /** 唯一写方不可用（宿主未起、写句柄已交还）。 */
  | "writer-unavailable";

export interface WindowHistoryError {
  readonly code: WindowHistoryErrorCode;
  readonly message: string;
  readonly windowId: string | null;
}

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: WindowHistoryError };

/**
 * 只读投影里的一条历史。`payload` 是不可变载荷，`payloadHash` 是底座发的内容 hash。
 */
export interface WindowHistoryEntry {
  readonly eventId: string;
  readonly streamSeq: number;
  /** 事件自带的代际 provenance（WH-03 寻址口径）。 */
  readonly generation: number;
  readonly payloadHash: string;
  /** 落盘格式版本；WH-05 用它判「v1/v2 混合页」。 */
  readonly formatVersion: number;
  readonly payload: JsonObject;
}

/** 损坏条目在返回值层面的可见形式（WH-04 部分损坏单判）。 */
export interface DamagedEntryReport {
  readonly streamSeq: number;
  readonly reason: "hash-mismatch" | "undecodable";
}

/**
 * 一页只读历史。
 *
 * 分页语义（与 acceptance/window-history-driver.ts 共用一套定义）：
 * - `entries` 按 `streamSeq` 升序；
 * - `beforeSeq` 非 null 时只保留 `streamSeq < beforeSeq` 的条目；
 * - `maxMessages` 非 null 时保留过滤后的**末尾** N 条（尾页优先）；
 * - `hasMore` 为真当且仅当因为 `maxMessages` 从头部丢掉了条目。
 */
export interface WindowHistoryPage {
  readonly windowId: string;
  readonly entries: readonly WindowHistoryEntry[];
  readonly damaged: readonly DamagedEntryReport[];
  readonly hasMore: boolean;
}

/** `session.list` 摘要三字段。 */
export interface WindowHistorySummary {
  readonly windowId: string;
  /**
   * **单调修订号，不是时间戳**（2026-09-24 施工裁定，见
   * docs/design/window-history-projection.md §6.2）。
   *
   * 取该窗健康历史条目里最大的 `streamSeq`（无历史为 0）：越大越新、跨重启稳定、完全由
   * 落盘事实派生。本层没有可信挂钟（窗事件的 `occurredAt` 是 1970 定值哨兵，理由见
   * src/window-host/window-history-host.ts 的 `WINDOW_EVENT_OCCURRED_AT`），所以这里返回
   * 一个诚实的修订号，而不是一个由 1970 派生的假时间。
   *
   * 代价（明写）：想显示「最后活动时间」的消费方在本层拿不到，必须另找带时间权威的字段；
   * 这个数也不等于流水长度 —— 窗账生命周期事实占 `streamSeq` 号但不进条目集合。
   * 消费方**不许**把它当日期渲染。
   */
  readonly updatedAt: number;
  /** 这扇窗此刻是否有活跃住户在跑。归档窗为 false，且该事实跨进程重启有效。 */
  readonly running: boolean;
  /** 这扇窗确实没有任何历史（与「读不到」是两种不同的返回值，见 WindowHistoryErrorCode）。 */
  readonly blank: boolean;
}

/**
 * 读句柄。
 *
 * `generation` 为 null 表示按稳定 `windowId` 读整窗只读流水（默认口径）；
 * 为数字表示按 `(windowId, generation)` 取该代切片。
 */
export interface WindowHistoryRef {
  readonly residentId: string;
  readonly windowId: string;
  readonly generation: number | null;
}

export interface WindowHistoryPageRequest {
  readonly beforeSeq: number | null;
  readonly maxMessages: number | null;
}

/**
 * 生产 window-history 只读 port。判卷对象恰好两个方法，不多不少。
 */
export interface MistWindowHistoryPort {
  summarize(ref: WindowHistoryRef): Promise<Result<WindowHistorySummary>>;
  read(ref: WindowHistoryRef, page: WindowHistoryPageRequest): Promise<Result<WindowHistoryPage>>;
}
