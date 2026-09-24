/**
 * #120 window-history 生产宿主/组装根目录的公共出口。
 *
 * 本目录持有全 src/ 唯一的 `new CanonicalStreamWriter`（在 window-history-host.ts）
 * 以及全部落盘存储格式管理（迁移/回滚/中断/墓碑/快照），是组装根，不是被 WH-06
 * 审计的只读投影目录。
 */
export { WindowHistoryHost } from "./window-history-host.ts";
export type { WindowHistoryHostOptions } from "./window-history-host.ts";
export {
  WindowStorageFormatAdmin,
  WindowStorageInterrupted,
  INITIAL_FORMAT_VERSION,
} from "./storage-format.ts";
export type { WindowStorageFormatAdminOptions } from "./storage-format.ts";
export {
  WINDOW_EVENT_OCCURRED_AT,
  WINDOW_LIFECYCLE_PAYLOAD_KIND,
} from "./window-history-host.ts";
export type {
  AppendReceipt,
  AppendWindowEventInput,
  DurableRecordSnapshot,
  DurableSnapshot,
  MigrationOutcome,
  MigrationState,
  MigrationStatus,
  Tombstone,
  WindowDescriptor,
  WriterIdentity,
} from "./types.ts";
