import { createHash } from "node:crypto";
/**
 * #120 window-history 生产宿主的**落盘存储格式管理**（WH-05）。
 *
 * 归属：本文件在 src/window-host/ 下，是允许落盘写的组装/宿主根，不在被 WH-06
 * 审计的 src/window-history/ 投影目录里。投影目录只读、不落盘；一切迁移/回滚/墓碑
 * 的落盘写都收拢在这里。
 *
 * 它管的是「window-history 只读投影的落盘格式版本」这一层，独立于 canonical stream
 * 底座本身：canonical stream 文件（`*.stream.json`）是先决①的唯一底座，不可改写；
 * 本层在其旁边另立一组**格式记录文件**（每扇窗一份 `*.wh-format.json`），承载
 * 「这批事件按哪个 formatVersion 呈现」以及被新格式退役的旧信号点。迁移就是原子重写
 * 这些格式记录文件；回滚就是把迁移前备份的字节整份换回来。canonical stream 文件在
 * 迁移/回滚全程逐字节不变，所以退回后 durableSnapshot() 与迁移前字节等价。
 *
 * 迁移策略：**原子（single atomic rename swap）+ 显式中断态**。
 *   - 正常 migrate/rollback：先把每份格式记录写到 `*.tmp` 再 rename 换上，rename 在
 *     同目录内是原子的——要么全是旧字节要么全是新字节，读端口永远看不到半写文件。
 *   - interruptMigration：故意把控制账落成 `status='incomplete'`、`resumable=true`、
 *     `rollbackAvailable=true`，并把迁移前字节备份留在 backup/ 下，然后宿主进程被杀。
 *     重启后 migrationState() 报 incomplete，投影 read/summarize fail-closed 到
 *     'migration-incomplete'（绝不呈现 v1/v2 混合页）；resumeMigration() 续跑到
 *     complete，或 rollbackStorageFormat() 用备份整体退回。
 *   代价（明写）：原子重写要为每扇窗多写一份格式记录 + 一次全量备份拷贝，落盘量约为
 *   窗数的两倍；换来的是「读端永不见半写页」「退回字节可复原」这两条硬保证。相较
 *   「就地增量改写」省内存但费磁盘，本层选磁盘换正确性。
 */
import {
  closeSync,
  copyFileSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type {
  DurableRecordSnapshot,
  DurableSnapshot,
  MigrationState,
  MigrationStatus,
  Tombstone,
} from "./types.ts";

/** 存储管理落在 dataDir 下的固定文件名。 */
const CONTROL_FILE = "window-history.migration.json";
const BACKUP_DIR = "window-history.backup";
const FORMAT_SUFFIX = ".wh-format.json";
/** 故障注入控制目录（见 window-host-faults.ts）；不进逐条记录字节等价比较面。 */
const FAULT_DIR = "window-history.faults";

/** 支持的落盘格式版本区间：v1 起点，v2 目标。 */
export const INITIAL_FORMAT_VERSION = 1;
const SUPPORTED_TARGETS = new Set<number>([1, 2]);

/**
 * 一扇窗的格式记录：迁移会重写它，是 durableSnapshot 里会随迁移变字节的那部分。
 * `legacyMark` 是 v1 的记录级旧信号点，v2 用 payload.mark 取代它，退役时留墓碑。
 */
interface WindowFormatRecord {
  readonly formatVersion: number;
  readonly windowKey: string;
  /** v1 携带；v2 迁移后必为 null（旧信号点退役）。 */
  readonly legacyMark: string | null;
}

interface ControlFileShape {
  status: MigrationStatus;
  formatVersion: number;
  resumable: boolean;
  rollbackAvailable: boolean;
  target: number | null;
  tombstones: Tombstone[];
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function freshControl(): ControlFileShape {
  return {
    status: "none",
    formatVersion: INITIAL_FORMAT_VERSION,
    resumable: false,
    rollbackAvailable: false,
    target: null,
    tombstones: [],
  };
}

/** 原子落盘：tmp + fchmod(0600) + fsync + rename，镜像底座 store 的写纪律。 */
function atomicWrite(finalPath: string, contents: string): void {
  const temporaryPath = `${finalPath}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporaryPath, "w", 0o600);
    fchmodSync(descriptor, 0o600);
    writeSync(descriptor, contents);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporaryPath, finalPath);
  } catch (error) {
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } catch {
        // 保留原始写错误。
      }
    }
    try {
      rmSync(temporaryPath, { force: true });
    } catch {
      // 写仍然大声失败，哪怕残留 tmp 删不掉。
    }
    throw error;
  }
}

function windowKeyOf(residentId: string, windowId: string): string {
  return `${residentId}/${windowId}`;
}

/** windowKey -> 落盘格式记录文件名（把 `/` 换成安全字符，避免子目录）。 */
function formatFileName(windowKey: string): string {
  return `${windowKey.replace(/[^a-z0-9-]+/gi, "_")}${FORMAT_SUFFIX}`;
}

export class WindowStorageInterrupted extends Error {
  readonly code = "WINDOW_STORAGE_INTERRUPTED";
  constructor(message: string) {
    super(message);
    this.name = "WindowStorageInterrupted";
  }
}

/**
 * 落盘存储格式管理器。持有 dataDir，读写控制账与每窗格式记录。构造时从盘上恢复
 * （跨进程重启后 migrationState 仍是真值），这样中断态在新进程里可识别。
 */
export class WindowStorageFormatAdmin {
  readonly #dataDir: string;
  readonly #controlPath: string;
  readonly #backupDir: string;
  #control: ControlFileShape;
  /** 内存镜像的窗集合：windowKey -> 该窗当前 legacyMark（用于写格式记录）。 */
  readonly #windows = new Map<string, WindowFormatRecord>();

  constructor(dataDir: string) {
    this.#dataDir = resolve(dataDir);
    mkdirSync(this.#dataDir, { recursive: true });
    this.#controlPath = join(this.#dataDir, CONTROL_FILE);
    this.#backupDir = join(this.#dataDir, BACKUP_DIR);
    this.#control = this.#restoreControl();
    this.#restoreWindows();
  }

  #restoreControl(): ControlFileShape {
    if (!existsSync(this.#controlPath)) return freshControl();
    const parsed = JSON.parse(readFileSync(this.#controlPath, "utf8")) as ControlFileShape;
    return parsed;
  }

  #restoreWindows(): void {
    for (const file of readdirSync(this.#dataDir).sort()) {
      if (!file.endsWith(FORMAT_SUFFIX)) continue;
      const record = JSON.parse(
        readFileSync(join(this.#dataDir, file), "utf8"),
      ) as WindowFormatRecord;
      this.#windows.set(record.windowKey, record);
    }
  }

  #formatPath(windowKey: string): string {
    return join(this.#dataDir, formatFileName(windowKey));
  }

  #persistControl(): void {
    atomicWrite(this.#controlPath, JSON.stringify(this.#control));
  }

  #persistWindow(record: WindowFormatRecord): void {
    atomicWrite(this.#formatPath(record.windowKey), JSON.stringify(record));
  }

  /** 首次见到一扇窗时落一份 v1 格式记录（幂等）。带一个记录级 legacyMark 做迁移的旧信号点。 */
  ensureWindow(input: { residentId: string; windowId: string }): void {
    const windowKey = windowKeyOf(input.residentId, input.windowId);
    if (this.#windows.has(windowKey)) return;
    const record: WindowFormatRecord = {
      formatVersion: this.#control.formatVersion,
      windowKey,
      // v1 的记录级旧信号点：仅在 v1 存在，迁移到 v2 时退役成墓碑。
      legacyMark: this.#control.formatVersion === 1 ? `legacy:${windowKey}` : null,
    };
    this.#windows.set(windowKey, record);
    this.#persistWindow(record);
  }

  /**
   * 盘上已知的窗（windowKey = `residentId/windowId`）。宿主重启后用它重建窗账，
   * 使 windowExists()/generation 在冷启动后仅凭落盘事实即可回答。
   */
  knownWindows(): ReadonlyArray<{ residentId: string; windowId: string }> {
    const windows: Array<{ residentId: string; windowId: string }> = [];
    for (const windowKey of this.#windows.keys()) {
      const separator = windowKey.indexOf("/");
      if (separator <= 0) continue;
      windows.push({
        residentId: windowKey.slice(0, separator),
        windowId: windowKey.slice(separator + 1),
      });
    }
    return windows;
  }

  /** 抹掉一扇窗的落盘格式记录（deleteDurableWindowData 用）。 */
  forgetWindow(input: { residentId: string; windowId: string }): void {
    const windowKey = windowKeyOf(input.residentId, input.windowId);
    if (!this.#windows.delete(windowKey)) return;
    rmSync(this.#formatPath(windowKey), { force: true });
  }

  /** 这扇窗当前呈现的落盘格式版本；缺省起点 v1。 */
  formatVersionOf(input: { residentId: string; windowId: string }): number {
    const record = this.#windows.get(windowKeyOf(input.residentId, input.windowId));
    return record?.formatVersion ?? this.#control.formatVersion;
  }

  migrationStatus(): MigrationStatus {
    return this.#control.status;
  }

  migrationState(): MigrationState {
    return {
      status: this.#control.status,
      formatVersion: this.#control.formatVersion,
      resumable: this.#control.resumable,
      rollbackAvailable: this.#control.rollbackAvailable,
    };
  }

  readTombstones(): readonly Tombstone[] {
    return this.#control.tombstones.map((tombstone) => ({ ...tombstone }));
  }

  #assertTarget(targetFormatVersion: number): void {
    if (!SUPPORTED_TARGETS.has(targetFormatVersion)) {
      throw new Error(`unsupported target format version: ${targetFormatVersion}`);
    }
  }

  #backupPathFor(fileName: string): string {
    return join(this.#backupDir, fileName);
  }

  /** 迁移前把每份格式记录字节整份备份，供回滚逐字节复原。 */
  #backupFormatRecords(): void {
    mkdirSync(this.#backupDir, { recursive: true });
    for (const record of this.#windows.values()) {
      const fileName = formatFileName(record.windowKey);
      copyFileSync(this.#formatPath(record.windowKey), this.#backupPathFor(fileName));
    }
  }

  #tombstonesFor(targetFormatVersion: number): Tombstone[] {
    return [
      {
        tombstoneId: "tombstone-legacy-mark",
        retiredField: "legacyMark",
        replacedByFormatVersion: targetFormatVersion,
        reason: "v2 用 payload.mark 取代记录级 legacyMark，旧信号点显式退役",
      },
    ];
  }

  /** 把所有窗的格式记录重写到目标版本（原子逐份 rename），退役 legacyMark。 */
  #rewriteRecords(targetFormatVersion: number): void {
    for (const record of [...this.#windows.values()]) {
      const migrated: WindowFormatRecord = {
        formatVersion: targetFormatVersion,
        windowKey: record.windowKey,
        legacyMark: null,
      };
      this.#windows.set(record.windowKey, migrated);
      this.#persistWindow(migrated);
    }
  }

  /**
   * v1->v2 迁移：先备份 -> 原子重写记录 -> 落墓碑 -> 控制账 complete。
   * 返回目标版本与墓碑 id。
   */
  migrate(targetFormatVersion: number): { formatVersion: number; tombstoneIds: string[] } {
    this.#assertTarget(targetFormatVersion);
    this.#backupFormatRecords();
    this.#rewriteRecords(targetFormatVersion);
    const tombstones = this.#tombstonesFor(targetFormatVersion);
    this.#control = {
      status: "complete",
      formatVersion: targetFormatVersion,
      resumable: false,
      rollbackAvailable: true,
      target: null,
      tombstones,
    };
    this.#persistControl();
    return {
      formatVersion: targetFormatVersion,
      tombstoneIds: tombstones.map((t) => t.tombstoneId),
    };
  }

  /** 回滚：把备份字节整份换回来（逐字节复原），控制账 rolled-back。 */
  rollback(targetFormatVersion: number): { formatVersion: number; tombstoneIds: string[] } {
    if (!existsSync(this.#backupDir)) {
      throw new WindowStorageInterrupted("no pre-migration backup to restore");
    }
    for (const record of [...this.#windows.values()]) {
      const fileName = formatFileName(record.windowKey);
      const backup = this.#backupPathFor(fileName);
      if (!existsSync(backup)) continue;
      // 用备份字节整份换回落盘文件（原子 rename），再回读进内存镜像。
      const restoredContents = readFileSync(backup, "utf8");
      atomicWrite(this.#formatPath(record.windowKey), restoredContents);
      this.#windows.set(record.windowKey, JSON.parse(restoredContents) as WindowFormatRecord);
    }
    const tombstoneIds = this.#control.tombstones.map((t) => t.tombstoneId);
    this.#control = {
      status: "rolled-back",
      formatVersion: targetFormatVersion,
      resumable: false,
      rollbackAvailable: false,
      target: null,
      tombstones: [],
    };
    this.#persistControl();
    return { formatVersion: targetFormatVersion, tombstoneIds };
  }

  /**
   * 中断迁移：留下可识别的 incomplete 状态 + 迁移前备份，然后由调用方杀宿主。
   * 不重写任何格式记录（保持原子——盘上要么全旧字节，要么等 resume 才全新字节）。
   */
  interrupt(targetFormatVersion: number): void {
    this.#assertTarget(targetFormatVersion);
    this.#backupFormatRecords();
    this.#control = {
      status: "incomplete",
      formatVersion: this.#control.formatVersion,
      resumable: true,
      rollbackAvailable: true,
      target: targetFormatVersion,
      tombstones: [],
    };
    this.#persistControl();
  }

  /** 续跑：把中断的迁移做完到目标版本。 */
  resume(): { formatVersion: number; tombstoneIds: string[] } {
    const target = this.#control.target;
    if (this.#control.status !== "incomplete" || target === null) {
      throw new WindowStorageInterrupted("there is no unfinished migration to resume");
    }
    this.#rewriteRecords(target);
    const tombstones = this.#tombstonesFor(target);
    this.#control = {
      status: "complete",
      formatVersion: target,
      resumable: false,
      rollbackAvailable: true,
      target: null,
      tombstones,
    };
    this.#persistControl();
    return { formatVersion: target, tombstoneIds: tombstones.map((t) => t.tombstoneId) };
  }

  /**
   * durableSnapshot：dataDir 下所有落盘文件的逐条 {relativePath, byteHash, byteLength}，
   * **排除**迁移控制账（它不是历史记录，不进「逐条记录字节等价」比较面），也排除
   * backup 目录（那是回滚素材，不是当前记录）。
   */
  durableSnapshot(): DurableSnapshot {
    const records: DurableRecordSnapshot[] = [];
    const walk = (directory: string, prefix: string): void => {
      if (!existsSync(directory)) return;
      for (const entry of readdirSync(directory).sort()) {
        if (prefix === "" && entry === CONTROL_FILE) continue;
        if (prefix === "" && entry === BACKUP_DIR) continue;
        if (prefix === "" && entry === FAULT_DIR) continue;
        const full = join(directory, entry);
        const relativePath = prefix === "" ? entry : `${prefix}/${entry}`;
        let isDir = false;
        try {
          isDir = statSync(full).isDirectory();
        } catch {
          continue;
        }
        if (isDir) {
          walk(full, relativePath);
          continue;
        }
        const bytes = readFileSync(full);
        records.push({
          relativePath,
          byteHash: sha256(bytes),
          byteLength: bytes.byteLength,
        });
      }
    };
    walk(this.#dataDir, "");
    records.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    return { records };
  }
}
