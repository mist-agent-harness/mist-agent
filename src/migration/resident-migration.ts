/**
 * M0 住户迁移包。
 *
 * 这里只定义第一里程碑需要的、可丢弃的临时格式。H2 会在能力契约成形后
 * 另行决定正式信封、签名和插件义务；M0 不提前替 H2 拍板。
 */

import type { HistoryNode, MemoryEntry } from "../../acceptance/driver.ts";

export const RESIDENT_EXPORT_FORMAT = "mist.resident" as const;
export const RESIDENT_EXPORT_FORMAT_VERSION = 0 as const;
export const MAX_RESIDENT_EXPORT_BYTES = 16 * 1024 * 1024;

export interface ResidentRecordM0 {
  name: string;
  createdAt: string;
}

/** 从存储读取出的住户耐久态；不含活会话指针和在途上下文。 */
export interface DurableResidentSnapshotM0 {
  residentId: string;
  resident: ResidentRecordM0;
  commitments: string[];
  memories: MemoryEntry[];
  history: HistoryNode[];
}

/** 完整校验后的 M0 包；仍保留来源 residentId，尚未绑定目标房间。 */
export interface ResidentImportM0 {
  sourceResidentId: string;
  resident: ResidentRecordM0;
  commitments: string[];
  memories: MemoryEntry[];
  history: HistoryNode[];
}

export interface ResidentExportEnvelopeM0 {
  format: typeof RESIDENT_EXPORT_FORMAT;
  formatVersion: typeof RESIDENT_EXPORT_FORMAT_VERSION;
  sourceResidentId: string;
  resident: ResidentRecordM0;
  raw: {
    commitments: string[];
    memories: MemoryEntry[];
    history: HistoryNode[];
  };
}

export class ResidentMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResidentMigrationError";
  }
}

/**
 * P1/P3 与 P5 的接缝。
 *
 * commitImportedResident 必须在一个原子提交里完成：分配新 residentId、仅结构化
 * 重绑 MemoryEntry.residentId、写入全部耐久记录，并抬高 id/时间戳水位。
 * 失败时不得留下房间或半份记录。P5 会在调用它之前完成全部字节/schema/引用校验。
 */
export interface ResidentMigrationPort {
  snapshotResident(residentId: string): Promise<DurableResidentSnapshotM0>;
  commitImportedResident(snapshot: ResidentImportM0): Promise<string>;
}

export class ResidentMigrationService {
  constructor(private readonly port: ResidentMigrationPort) {}

  async exportResident(residentId: string): Promise<Uint8Array> {
    return encodeResidentExportM0(await this.port.snapshotResident(residentId));
  }

  async importResident(pack: Uint8Array): Promise<string> {
    const snapshot = decodeResidentExportM0(pack);
    return this.port.commitImportedResident(snapshot);
  }
}

/** 固定字段顺序、固定记录顺序的 UTF-8 紧凑 JSON；不会改动传入快照。 */
export function encodeResidentExportM0(snapshot: DurableResidentSnapshotM0): Uint8Array {
  const envelope: ResidentExportEnvelopeM0 = {
    format: RESIDENT_EXPORT_FORMAT,
    formatVersion: RESIDENT_EXPORT_FORMAT_VERSION,
    sourceResidentId: snapshot.residentId,
    resident: {
      name: snapshot.resident.name,
      createdAt: snapshot.resident.createdAt,
    },
    raw: {
      commitments: [...snapshot.commitments],
      memories: snapshot.memories.map((entry) => ({ ...entry })).sort(compareTimedRecords),
      history: snapshot.history.map((node) => ({ ...node })).sort(compareTimedRecords),
    },
  };
  validateEnvelope(envelope);
  const bytes = new TextEncoder().encode(JSON.stringify(envelope));
  if (bytes.byteLength > MAX_RESIDENT_EXPORT_BYTES) {
    throw new ResidentMigrationError(
      `resident export exceeds ${MAX_RESIDENT_EXPORT_BYTES} byte limit`,
    );
  }
  return bytes;
}

/** 严格 UTF-8 + 精确 M0 schema + 房间/引用完整性校验。 */
export function decodeResidentExportM0(pack: Uint8Array): ResidentImportM0 {
  if (pack.byteLength === 0) throw new ResidentMigrationError("resident export is empty");
  if (pack.byteLength > MAX_RESIDENT_EXPORT_BYTES) {
    throw new ResidentMigrationError(
      `resident export exceeds ${MAX_RESIDENT_EXPORT_BYTES} byte limit`,
    );
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(pack);
  } catch {
    throw new ResidentMigrationError("resident export is not valid UTF-8");
  }

  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new ResidentMigrationError("resident export is not valid JSON");
  }

  const envelope = validateEnvelope(value);
  return {
    sourceResidentId: envelope.sourceResidentId,
    resident: { ...envelope.resident },
    commitments: [...envelope.raw.commitments],
    memories: envelope.raw.memories.map((entry) => ({ ...entry })),
    history: envelope.raw.history.map((node) => ({ ...node })),
  };
}

/**
 * 目标 residentId 只落在结构字段上；正文中即使出现来源 id 字面量也原样保留。
 * 存储适配器在原子提交的 detached room 中调用它。
 */
export function rebindResidentId(
  snapshot: ResidentImportM0,
  targetResidentId: string,
): DurableResidentSnapshotM0 {
  assertNonEmptyString(targetResidentId, "targetResidentId");
  return {
    residentId: targetResidentId,
    resident: { ...snapshot.resident },
    commitments: [...snapshot.commitments],
    memories: snapshot.memories.map((entry) => ({ ...entry, residentId: targetResidentId })),
    history: snapshot.history.map((node) => ({ ...node })),
  };
}

function compareTimedRecords(
  left: { id: string; createdAt: string },
  right: { id: string; createdAt: string },
): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function validateEnvelope(value: unknown): ResidentExportEnvelopeM0 {
  assertRecord(value, "export");
  assertExactKeys(
    value,
    ["format", "formatVersion", "sourceResidentId", "resident", "raw"],
    "export",
  );
  if (value.format !== RESIDENT_EXPORT_FORMAT) {
    throw new ResidentMigrationError(`unsupported resident export format: ${String(value.format)}`);
  }
  if (value.formatVersion !== RESIDENT_EXPORT_FORMAT_VERSION) {
    throw new ResidentMigrationError(
      `unsupported resident export version: ${String(value.formatVersion)}`,
    );
  }
  assertNonEmptyString(value.sourceResidentId, "sourceResidentId");
  const sourceResidentId = value.sourceResidentId;

  assertRecord(value.resident, "resident");
  assertExactKeys(value.resident, ["name", "createdAt"], "resident");
  assertNonEmptyString(value.resident.name, "resident.name");
  assertTimestamp(value.resident.createdAt, "resident.createdAt");

  assertRecord(value.raw, "raw");
  assertExactKeys(value.raw, ["commitments", "memories", "history"], "raw");
  if (!Array.isArray(value.raw.commitments)) {
    throw new ResidentMigrationError("raw.commitments must be an array");
  }
  value.raw.commitments.forEach((commitment, index) => {
    if (typeof commitment !== "string") {
      throw new ResidentMigrationError(`raw.commitments[${index}] must be a string`);
    }
  });

  if (!Array.isArray(value.raw.memories)) {
    throw new ResidentMigrationError("raw.memories must be an array");
  }
  const memories = value.raw.memories.map((entry, index) =>
    validateMemory(entry, index, sourceResidentId),
  );

  if (!Array.isArray(value.raw.history)) {
    throw new ResidentMigrationError("raw.history must be an array");
  }
  const history = value.raw.history.map((node, index) => validateHistoryNode(node, index));

  validateReferences(memories, history);
  return {
    format: RESIDENT_EXPORT_FORMAT,
    formatVersion: RESIDENT_EXPORT_FORMAT_VERSION,
    sourceResidentId,
    resident: {
      name: value.resident.name,
      createdAt: value.resident.createdAt,
    },
    raw: {
      commitments: [...value.raw.commitments],
      memories,
      history,
    },
  };
}

function validateMemory(value: unknown, index: number, sourceResidentId: string): MemoryEntry {
  const path = `raw.memories[${index}]`;
  assertRecord(value, path);
  assertExactKeys(value, ["id", "residentId", "content", "supersededBy", "createdAt"], path);
  assertNonEmptyString(value.id, `${path}.id`);
  assertNonEmptyString(value.residentId, `${path}.residentId`);
  if (value.residentId !== sourceResidentId) {
    throw new ResidentMigrationError(`${path}.residentId does not match sourceResidentId`);
  }
  if (typeof value.content !== "string") {
    throw new ResidentMigrationError(`${path}.content must be a string`);
  }
  if (value.supersededBy !== null && typeof value.supersededBy !== "string") {
    throw new ResidentMigrationError(`${path}.supersededBy must be a string or null`);
  }
  if (value.supersededBy === "") {
    throw new ResidentMigrationError(`${path}.supersededBy must not be empty`);
  }
  assertTimestamp(value.createdAt, `${path}.createdAt`);
  return {
    id: value.id,
    residentId: value.residentId,
    content: value.content,
    supersededBy: value.supersededBy,
    createdAt: value.createdAt,
  };
}

function validateHistoryNode(value: unknown, index: number): HistoryNode {
  const path = `raw.history[${index}]`;
  assertRecord(value, path);
  assertExactKeys(value, ["id", "parentId", "role", "content", "createdAt"], path);
  assertNonEmptyString(value.id, `${path}.id`);
  if (value.parentId !== null && typeof value.parentId !== "string") {
    throw new ResidentMigrationError(`${path}.parentId must be a string or null`);
  }
  if (value.parentId === "") {
    throw new ResidentMigrationError(`${path}.parentId must not be empty`);
  }
  if (value.role !== "user" && value.role !== "assistant" && value.role !== "system") {
    throw new ResidentMigrationError(`${path}.role is invalid`);
  }
  if (typeof value.content !== "string") {
    throw new ResidentMigrationError(`${path}.content must be a string`);
  }
  assertTimestamp(value.createdAt, `${path}.createdAt`);
  return {
    id: value.id,
    parentId: value.parentId,
    role: value.role,
    content: value.content,
    createdAt: value.createdAt,
  };
}

function validateReferences(memories: MemoryEntry[], history: HistoryNode[]): void {
  const memoryIds = uniqueIds(memories, "memory");
  const historyIds = uniqueIds(history, "history node");

  const supersedePredecessors = new Map<string, number>();
  for (const entry of memories) {
    if (entry.supersededBy === null) continue;
    if (!memoryIds.has(entry.supersededBy)) {
      throw new ResidentMigrationError(
        `memory ${entry.id} supersededBy references missing entry ${entry.supersededBy}`,
      );
    }
    if (entry.supersededBy === entry.id) {
      throw new ResidentMigrationError(`memory ${entry.id} supersedes itself`);
    }
    const predecessors = (supersedePredecessors.get(entry.supersededBy) ?? 0) + 1;
    if (predecessors > 1) {
      throw new ResidentMigrationError(
        `memory ${entry.supersededBy} has more than one supersede predecessor`,
      );
    }
    supersedePredecessors.set(entry.supersededBy, predecessors);
  }
  assertAcyclic(
    memories,
    (entry) => entry.id,
    (entry) => entry.supersededBy,
    "memory chain",
  );

  for (const node of history) {
    if (node.parentId === null) continue;
    if (!historyIds.has(node.parentId)) {
      throw new ResidentMigrationError(
        `history node ${node.id} references missing parent ${node.parentId}`,
      );
    }
    if (node.parentId === node.id) {
      throw new ResidentMigrationError(`history node ${node.id} is its own parent`);
    }
  }
  assertAcyclic(
    history,
    (node) => node.id,
    (node) => node.parentId,
    "history tree",
  );
}

function uniqueIds<T extends { id: string }>(records: T[], kind: string): Set<string> {
  const ids = new Set<string>();
  for (const record of records) {
    if (ids.has(record.id)) throw new ResidentMigrationError(`duplicate ${kind} id: ${record.id}`);
    ids.add(record.id);
  }
  return ids;
}

function assertAcyclic<T>(
  records: T[],
  idOf: (record: T) => string,
  nextOf: (record: T) => string | null,
  kind: string,
): void {
  const nextById = new Map(records.map((record) => [idOf(record), nextOf(record)]));
  const complete = new Set<string>();
  for (const start of nextById.keys()) {
    const path = new Set<string>();
    let cursor: string | null = start;
    while (cursor !== null && !complete.has(cursor)) {
      if (path.has(cursor))
        throw new ResidentMigrationError(`${kind} contains a cycle at ${cursor}`);
      path.add(cursor);
      cursor = nextById.get(cursor) ?? null;
    }
    for (const id of path) complete.add(id);
  }
}

function assertRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ResidentMigrationError(`${path} must be an object`);
  }
}

function assertExactKeys(value: Record<string, unknown>, expected: string[], path: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new ResidentMigrationError(`${path} has unexpected or missing fields`);
  }
}

function assertNonEmptyString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ResidentMigrationError(`${path} must be a non-empty string`);
  }
}

function assertTimestamp(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string") {
    throw new ResidentMigrationError(`${path} must be an ISO-8601 UTC timestamp`);
  }
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
    throw new ResidentMigrationError(`${path} must be a canonical ISO-8601 UTC timestamp`);
  }
}
