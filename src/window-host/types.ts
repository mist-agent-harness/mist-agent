/**
 * #120 window-host 写入侧 + 存储管理侧的 src 侧数据类型。
 *
 * 这些类型对齐 acceptance/window-history-driver.ts 里**非 port**的部分
 * （WindowDescriptor / AppendReceipt / WriterIdentity / MigrationState /
 * MigrationOutcome / Tombstone / DurableSnapshot / DurableRecordSnapshot）。
 * acceptance 树不 import src，src 也不许 import acceptance，所以按同样的纪律各自
 * 声明一套；两侧字段必须逐字对齐。只读投影侧的类型（Result / WindowHistory* 等）
 * 复用 src/window-history 的 port 类型，不在这里重复。
 *
 * 代价（明写）：与 storage-format.ts / port.ts 的读侧副本同理，这份写侧副本要与
 * 冻结判卷契约手工同步；换来的是 src 与 acceptance 树的依赖隔离。
 */
import type { JsonObject } from "../one-stream/index.ts";

export interface WindowDescriptor {
  readonly residentId: string;
  readonly windowId: string;
  readonly generation: number;
  readonly archived: boolean;
}

export interface AppendReceipt {
  readonly eventId: string;
  readonly streamSeq: number;
  readonly payloadHash: string;
}

export interface AppendWindowEventInput {
  readonly residentId: string;
  readonly windowId: string;
  readonly generation: number;
  readonly idempotencyKey: string;
  readonly payload: JsonObject;
}

export interface WriterIdentity {
  readonly writerId: string;
}

export type MigrationStatus = "none" | "complete" | "incomplete" | "rolled-back";

export interface MigrationState {
  readonly status: MigrationStatus;
  readonly formatVersion: number;
  readonly resumable: boolean;
  readonly rollbackAvailable: boolean;
}

export interface MigrationOutcome {
  readonly formatVersion: number;
  readonly tombstoneIds: readonly string[];
}

export interface Tombstone {
  readonly tombstoneId: string;
  readonly retiredField: string;
  readonly replacedByFormatVersion: number;
  readonly reason: string;
}

export interface DurableRecordSnapshot {
  readonly relativePath: string;
  readonly byteHash: string;
  readonly byteLength: number;
}

export interface DurableSnapshot {
  readonly records: readonly DurableRecordSnapshot[];
}
