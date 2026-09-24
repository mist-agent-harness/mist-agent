/**
 * #120 window-history 只读投影目录的公共出口。
 *
 * 只导出 port 类型与投影类。绝不导出任何引用 CanonicalStreamWriter 的东西——
 * 唯一写方与落盘写在组装/宿主根（FEAT-002），不在本目录（WH-06 约束）。
 */
export type {
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
export {
  WindowHistoryProjection,
  type WindowLifecycleView,
  type WindowStorageMigrationStatus,
} from "./projection.ts";
