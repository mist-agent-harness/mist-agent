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
 * 迁移策略：**逐份原子 rename + 先落「未完成」再动字节**。
 *
 * 单份格式记录的写是原子的（tmp + fchmod + fsync + rename，同目录内 rename 原子），
 * 所以任何一扇窗的那一页永远不会混版本、永远不会半写。但**多份记录的重写不是一次
 * 原子操作**：宿主死在重写循环中间（或某次写失败），盘上就会前几份 v2、后几份 v1。
 * 独立验收席（2026-09-24）钉的缺陷二就是这一段以前既不可识别也不可修复：控制账要等
 * 循环全部跑完才落盘，死在中间时它仍报旧状态 —— 一次既没完成、又看不出没完成的操作。
 *
 * 所以本层的次序纪律是（migrate 与 rollback 同构）：
 *   1. 先把迁移前的每份格式记录字节整份备份到 backup/（这是唯一的回滚素材）；
 *   2. **先把 `status='incomplete'` + `target` + `operation` 落盘**——读闸自此关上，
 *      投影 read/summarize 一律 fail-closed 到 'migration-incomplete'；
 *   3. 才开始逐份原子重写（migrate）或逐份从备份还原（rollback）；
 *   4. 只有终态（`complete` / `rolled-back`）落盘之后，读闸才放开。
 * 于是任何中途猝死都留在第 2 步之后、第 4 步之前：重启后 migrationState() 报
 * incomplete、resumable/rollbackAvailable 为真，绝不把混版本的盘当正常数据呈现。
 *
 * 续跑（resume）两条纪律：
 *   - **不重新备份**：备份里是迁移前的原始字节，中断时盘上已经版本混杂，再备份一次
 *     就把唯一的回滚素材覆盖掉了；
 *   - **未完成的回滚只能继续从备份还原**，绝不走 `#rewriteRecords(1)` —— 那条路会把
 *     `legacyMark` 写成 null，等于把要还原的旧信号点亲手销毁。
 *
 * interruptMigration 是同一条真实路径的**前缀**（备份 + 落 incomplete，然后由调用方
 * 杀宿主），不是另一条旁路实现。重写循环中途的故障由 `onRecordPersisted` 钩子注入
 * （见 WindowStorageFormatAdminOptions），所以「死在重写中间」也走真实 migrate/rollback。
 *
 * 代价（明写）：原子重写要为每扇窗多写一份格式记录 + 一次全量备份拷贝，落盘量约为窗数
 * 的两倍，并且每次 migrate/rollback 多一次控制账落盘（关闸）；换来的是「读端永不见
 * 半写页」「中途猝死可识别、可续跑、可退回」「退回字节可复原」这三条硬保证。相较
 * 「就地增量改写」省内存但费磁盘，本层选磁盘换正确性。
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

/** 未完成操作的方向。续跑必须知道它，否则会把「回滚跑一半」当「迁移跑一半」续错方向。 */
type StorageOperation = "migrate" | "rollback";

interface ControlFileShape {
  status: MigrationStatus;
  formatVersion: number;
  resumable: boolean;
  rollbackAvailable: boolean;
  target: number | null;
  /** 仅在 status='incomplete' 时有意义：这半截操作是迁移还是回滚。 */
  operation: StorageOperation | null;
  tombstones: Tombstone[];
}

export interface WindowStorageFormatAdminOptions {
  /**
   * 重写/还原循环的故障注入钩：每**成功落盘一份**记录后调用一次，抛出即模拟
   * 「盘满 / 写失败」，在钩子里 `process.kill` 即模拟「宿主死在重写中间」。
   *
   * 为什么要这个缝（代价明写）：缺陷二要求故障必须走**真实** migrate/rollback 路径，
   * 而不是只走 interrupt 那个独立入口；而「死在循环第 k 份」在外部是注入不进去的。
   * 代价是生产类型上多一个只有测试/演练会传的可选项；不传时零开销、行为完全不变。
   */
  readonly onRecordPersisted?: (progress: {
    readonly operation: StorageOperation;
    readonly windowKey: string;
    /** 从 1 开始的已落盘份数。 */
    readonly persisted: number;
    readonly total: number;
  }) => void;
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
    operation: null,
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
  readonly #onRecordPersisted: WindowStorageFormatAdminOptions["onRecordPersisted"];
  #control: ControlFileShape;
  /** 内存镜像的窗集合：windowKey -> 该窗当前 legacyMark（用于写格式记录）。 */
  readonly #windows = new Map<string, WindowFormatRecord>();

  constructor(dataDir: string, options: WindowStorageFormatAdminOptions = {}) {
    this.#dataDir = resolve(dataDir);
    mkdirSync(this.#dataDir, { recursive: true });
    this.#controlPath = join(this.#dataDir, CONTROL_FILE);
    this.#backupDir = join(this.#dataDir, BACKUP_DIR);
    this.#onRecordPersisted = options.onRecordPersisted;
    this.#control = this.#restoreControl();
    this.#restoreWindows();
  }

  #restoreControl(): ControlFileShape {
    if (!existsSync(this.#controlPath)) return freshControl();
    const parsed = JSON.parse(readFileSync(this.#controlPath, "utf8")) as ControlFileShape;
    // 兼容本次改造前落下的控制账（没有 operation 字段）：未完成的只可能是迁移。
    const operation =
      parsed.operation === "migrate" || parsed.operation === "rollback"
        ? parsed.operation
        : parsed.status === "incomplete" && parsed.target !== null
          ? "migrate"
          : null;
    return { ...parsed, operation };
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
    const records = [...this.#windows.values()];
    let persisted = 0;
    for (const record of records) {
      const migrated: WindowFormatRecord = {
        formatVersion: targetFormatVersion,
        windowKey: record.windowKey,
        legacyMark: null,
      };
      this.#windows.set(record.windowKey, migrated);
      this.#persistWindow(migrated);
      persisted += 1;
      this.#onRecordPersisted?.({
        operation: "migrate",
        windowKey: record.windowKey,
        persisted,
        total: records.length,
      });
    }
  }

  /**
   * 从 backup/ 里把每份格式记录的字节整份换回落盘文件（逐字节复原）。
   * 这是回滚与「续跑一个未完成的回滚」唯一允许的还原路径：绝不用
   * `#rewriteRecords(1)` 假装回滚——那条路写出的 `legacyMark` 是 null，会把要还原的
   * 旧信号点亲手销毁。
   */
  #restoreFromBackup(): void {
    const records = [...this.#windows.values()];
    let persisted = 0;
    for (const record of records) {
      const fileName = formatFileName(record.windowKey);
      const backup = this.#backupPathFor(fileName);
      if (!existsSync(backup)) continue;
      // 用备份字节整份换回落盘文件（原子 rename），再回读进内存镜像。
      const restoredContents = readFileSync(backup, "utf8");
      atomicWrite(this.#formatPath(record.windowKey), restoredContents);
      this.#windows.set(record.windowKey, JSON.parse(restoredContents) as WindowFormatRecord);
      persisted += 1;
      this.#onRecordPersisted?.({
        operation: "rollback",
        windowKey: record.windowKey,
        persisted,
        total: records.length,
      });
    }
  }

  /**
   * 关闸：先把「未完成 + 方向 + 目标」落盘，之后才允许动记录字节。
   * 控制账一落成 incomplete，投影 read/summarize 就 fail-closed 到 migration-incomplete，
   * 所以整个重写/还原窗口期内读端绝不会看到 v1/v2 混合页。
   */
  #beginOperation(operation: StorageOperation, targetFormatVersion: number): void {
    this.#control = {
      status: "incomplete",
      // 未完成期间不谎报目标版本：声称的仍是操作前的版本。
      formatVersion: this.#control.formatVersion,
      resumable: true,
      rollbackAvailable: existsSync(this.#backupDir),
      target: targetFormatVersion,
      operation,
      tombstones: [],
    };
    this.#persistControl();
  }

  /** 开闸（迁移终态）：记录字节已全部就位，才把 complete + 墓碑落盘。 */
  #completeMigration(targetFormatVersion: number): Tombstone[] {
    const tombstones = this.#tombstonesFor(targetFormatVersion);
    this.#control = {
      status: "complete",
      formatVersion: targetFormatVersion,
      resumable: false,
      rollbackAvailable: true,
      target: null,
      operation: null,
      tombstones,
    };
    this.#persistControl();
    return tombstones;
  }

  /** 开闸（回滚终态）：备份字节已全部换回，才把 rolled-back 落盘。 */
  #completeRollback(targetFormatVersion: number): void {
    this.#control = {
      status: "rolled-back",
      formatVersion: targetFormatVersion,
      resumable: false,
      rollbackAvailable: false,
      target: null,
      operation: null,
      tombstones: [],
    };
    this.#persistControl();
  }

  /**
   * v1->v2 迁移：备份 -> **先落 incomplete（关闸）** -> 逐份原子重写 -> 落墓碑 + complete。
   * 已有未完成操作时拒绝开新的：否则会拿版本混杂的盘再备份一次，把唯一的回滚素材覆盖掉。
   */
  migrate(targetFormatVersion: number): { formatVersion: number; tombstoneIds: string[] } {
    this.#assertTarget(targetFormatVersion);
    this.#assertNoUnfinishedOperation("migration");
    this.#backupFormatRecords();
    this.#beginOperation("migrate", targetFormatVersion);
    this.#rewriteRecords(targetFormatVersion);
    const tombstones = this.#completeMigration(targetFormatVersion);
    return {
      formatVersion: targetFormatVersion,
      tombstoneIds: tombstones.map((t) => t.tombstoneId),
    };
  }

  /**
   * 回滚：**先落 incomplete（关闸）** -> 逐份从备份还原 -> rolled-back。
   * 全程不再备份：backup/ 里的迁移前字节就是唯一的回滚素材，再备份一次就等于销毁它。
   */
  rollback(targetFormatVersion: number): { formatVersion: number; tombstoneIds: string[] } {
    this.#assertTarget(targetFormatVersion);
    if (!existsSync(this.#backupDir)) {
      throw new WindowStorageInterrupted("no pre-migration backup to restore");
    }
    // 墓碑 id 要在关闸（清空控制账墓碑）之前取：回滚回报的是被退掉的那批墓碑。
    const tombstoneIds = this.#control.tombstones.map((t) => t.tombstoneId);
    this.#beginOperation("rollback", targetFormatVersion);
    this.#restoreFromBackup();
    this.#completeRollback(targetFormatVersion);
    return { formatVersion: targetFormatVersion, tombstoneIds };
  }

  /**
   * 中断迁移：真实迁移路径的**前缀**——备份 + 落下可识别的 incomplete（关闸），
   * 然后由调用方杀宿主。不重写任何格式记录，所以盘上此刻全是旧字节。
   */
  interrupt(targetFormatVersion: number): void {
    this.#assertTarget(targetFormatVersion);
    this.#assertNoUnfinishedOperation("migration");
    this.#backupFormatRecords();
    this.#beginOperation("migrate", targetFormatVersion);
  }

  /**
   * 续跑一个未完成的操作。
   *   - 未完成的**迁移**：继续逐份重写到目标版本（**不重新备份**）；
   *   - 未完成的**回滚**：继续从备份还原（**绝不** `#rewriteRecords(1)`）。
   */
  resume(): { formatVersion: number; tombstoneIds: string[] } {
    const target = this.#control.target;
    if (this.#control.status !== "incomplete" || target === null) {
      throw new WindowStorageInterrupted("there is no unfinished migration to resume");
    }
    if (this.#control.operation === "rollback") {
      if (!existsSync(this.#backupDir)) {
        throw new WindowStorageInterrupted("no pre-migration backup to finish the rollback with");
      }
      this.#restoreFromBackup();
      this.#completeRollback(target);
      return { formatVersion: target, tombstoneIds: [] };
    }
    this.#rewriteRecords(target);
    const tombstones = this.#completeMigration(target);
    return { formatVersion: target, tombstoneIds: tombstones.map((t) => t.tombstoneId) };
  }

  #assertNoUnfinishedOperation(what: string): void {
    if (this.#control.status !== "incomplete") return;
    throw new WindowStorageInterrupted(
      `refusing to start a ${what}: a ${this.#control.operation ?? "storage"} operation to v${String(
        this.#control.target,
      )} is unfinished; resume it or roll back first`,
    );
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
