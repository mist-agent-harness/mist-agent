/**
 * #120（WH-01～WH-06）的验收驱动契约。
 *
 * 判卷只通过本接口观察宿主，不 import `src/` 实现。实现方在
 * `src/window-history-acceptance-driver.ts` 导出 `createWindowHistoryDriver()`；
 * 驱动缺失时六盏灯全部保持红色——那是判卷先行的起点，不是故障。
 *
 * 判卷对象只有两个方法：`summarize` 与 `read`。底座的写入侧
 * （`openWindow` / `appendWindowEvent` / `rotateGeneration` / `archiveWindow`）
 * 在契约里出现只是为了让判卷能造出被读的事实，它们不是 port 的一部分——
 * 先决①（2026-08-29 批「一份底座」）定 canonical stream event store 是唯一底座
 * 与唯一写方，window history 只是它按 `(windowId, generation)` 的只读 projection。
 *
 * 字段拼写按 `acceptance/window-history.md` 的口径：`eventId`、`streamSeq` 是
 * #84 已拍板的语义把手，本文件用同名把手对齐，不另造第二套成功语义。
 */

/** 判卷自带的最小 JSON 视图：acceptance 树不 import `src/one-stream` 的类型。 */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/**
 * 结构化故障码。WH-04 要求「读不到」与「读到是空」机器可分，所以失败分支带
 * 判据而不是一句自由文本。
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
 * 只读投影里的一条历史。
 *
 * `payload` 是不可变载荷，`payloadHash` 是底座发的内容 hash；WH-01 的「逐项等价」
 * 同时比这两样，光比 hash 会让一个丢 payload 的实现点绿。
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
 * 分页语义（本契约的定义，供实现与判卷共用一套）：
 * - `entries` 按 `streamSeq` 升序；
 * - `beforeSeq` 非 null 时只保留 `streamSeq < beforeSeq` 的条目；
 * - `maxMessages` 非 null 时保留过滤后的**末尾** N 条（尾页优先，与既有
 *   `session.history` 的向后翻页方向一致）；
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
  readonly updatedAt: number;
  readonly running: boolean;
  readonly blank: boolean;
}

/**
 * 读句柄。
 *
 * `generation` 为 null 表示按稳定 `windowId` 读整窗只读流水（默认口径）；
 * 为数字表示按 `(windowId, generation)` 这个持久化 provenance 取该代切片。
 * WH-03 明说 `(windowId, generation)` 不是线协议主键，所以它在这里是可选过滤条件，
 * 不是必填寻址键。
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
 * 真实宿主进程的身份。
 *
 * `pid` 与 `bootId` 让判卷能断言「确实换了一个进程」；`dataDir` 让判卷能直接
 * stat 真实落盘目录取存储证据——清单要求真实目录下的落盘文件，不收内存替身。
 */
export interface HostDescriptor {
  readonly pid: number;
  /** 每次启动唯一；重启后必须与上一次不同。 */
  readonly bootId: string;
  /** 真实落盘根目录的绝对路径。 */
  readonly dataDir: string;
}

export interface WindowDescriptor {
  readonly residentId: string;
  readonly windowId: string;
  readonly generation: number;
  readonly archived: boolean;
}

export interface AppendReceipt {
  readonly eventId: string;
  /** 由底座 store 发号，调用方没有传入 seq 的入口。 */
  readonly streamSeq: number;
  readonly payloadHash: string;
}

export interface AppendWindowEventInput {
  readonly residentId: string;
  readonly windowId: string;
  /** 写请求携带代际；旧代迟到写必须 fail-closed 拒绝。 */
  readonly generation: number;
  readonly idempotencyKey: string;
  readonly payload: JsonObject;
}

/** 写方身份；WH-02 要断言「换气不换 writer」。 */
export interface WriterIdentity {
  readonly writerId: string;
}

export type MigrationStatus = "none" | "complete" | "incomplete" | "rolled-back";

export interface MigrationState {
  readonly status: MigrationStatus;
  readonly formatVersion: number;
  /** 未完成态是否可续跑。 */
  readonly resumable: boolean;
  /** 未完成态是否可整体退回。 */
  readonly rollbackAvailable: boolean;
}

export interface MigrationOutcome {
  readonly formatVersion: number;
  readonly tombstoneIds: readonly string[];
}

/** 被新格式取代的旧信号点的显式墓碑（不许只停更）。 */
export interface Tombstone {
  readonly tombstoneId: string;
  readonly retiredField: string;
  readonly replacedByFormatVersion: number;
  readonly reason: string;
}

export interface DurableRecordSnapshot {
  readonly relativePath: string;
  /** 文件字节的内容 hash；WH-05 的「退回后逐条记录与迁移前字节等价」比它。 */
  readonly byteHash: string;
  readonly byteLength: number;
}

export interface DurableSnapshot {
  readonly records: readonly DurableRecordSnapshot[];
}

export interface WindowHistoryDriver {
  /** 每盏灯后清掉合成住户、窗、落盘目录与注入的故障。 */
  reset(): Promise<void>;

  // —— 真实宿主：起得来、杀得死、拉得起 ——
  /** 起一个真实宿主子进程（同一 dataDir 复用），返回新进程身份。 */
  startHost(): Promise<HostDescriptor>;
  /** 硬杀宿主进程，不给优雅 flush 的机会。 */
  killHost(): Promise<void>;
  hostDescriptor(): Promise<HostDescriptor>;

  // —— 底座写入侧：唯一写方，不属于 port ——
  openWindow(input: { residentId: string; windowId: string }): Promise<Result<WindowDescriptor>>;
  appendWindowEvent(input: AppendWindowEventInput): Promise<Result<AppendReceipt>>;
  /** 真并发到达同一窗/不同窗；由底座串行发号，不由调用方排序。 */
  appendWindowEventsConcurrently(
    inputs: readonly AppendWindowEventInput[],
  ): Promise<ReadonlyArray<Result<AppendReceipt>>>;
  /** 换气：generation + 1，`windowId` 逐字不变，writer 不变。 */
  rotateGeneration(input: {
    residentId: string;
    windowId: string;
  }): Promise<Result<WindowDescriptor>>;
  archiveWindow(input: { residentId: string; windowId: string }): Promise<Result<WindowDescriptor>>;
  writerIdentity(): Promise<Result<WriterIdentity>>;

  // —— 判卷对象：只读投影 ——
  summarize(ref: WindowHistoryRef): Promise<Result<WindowHistorySummary>>;
  read(ref: WindowHistoryRef, page: WindowHistoryPageRequest): Promise<Result<WindowHistoryPage>>;

  // —— 故障注入 ——
  injectStorageReadFailure(input: { residentId: string; windowId: string }): Promise<void>;
  clearStorageReadFailure(): Promise<void>;
  deleteDurableWindowData(input: { residentId: string; windowId: string }): Promise<void>;
  corruptDurableEntry(input: {
    residentId: string;
    windowId: string;
    streamSeq: number;
  }): Promise<void>;

  // —— 迁移与回滚 ——
  durableSnapshot(): Promise<DurableSnapshot>;
  migrationState(): Promise<MigrationState>;
  migrateStorageFormat(input: { targetFormatVersion: number }): Promise<Result<MigrationOutcome>>;
  rollbackStorageFormat(input: { targetFormatVersion: number }): Promise<Result<MigrationOutcome>>;
  /** 迁移跑到一半被打断：宿主被杀或盘满。返回时宿主已经死了。 */
  interruptMigration(input: {
    targetFormatVersion: number;
    fault: "host-killed" | "disk-full";
  }): Promise<void>;
  resumeMigration(): Promise<Result<MigrationOutcome>>;
  readTombstones(): Promise<Result<readonly Tombstone[]>>;
}

/**
 * D27 三：判卷在驱动边界统一深拷贝入参与返回值，一次消掉别名类问题，
 * 不在每个调用点逐一冻结。
 *
 * 验收灯面向**非对抗驱动**：假定驱动如实回读自己的状态。这层代理挡的是
 * 「无心写成别名」，不是「存心在两次观察之间作弊」——后者归代码评审与验收席。
 */
export function cloneWindowHistoryDriverBoundary(driver: WindowHistoryDriver): WindowHistoryDriver {
  return new Proxy(driver, {
    get(target, property) {
      const member = Reflect.get(target, property, target);
      if (typeof member !== "function") return member;
      return async (...args: unknown[]) => {
        const result = await Reflect.apply(member, target, structuredClone(args));
        return structuredClone(result);
      };
    },
  });
}

export interface WindowHistoryCheckResult {
  readonly passed: boolean;
  readonly detail: string;
}

export interface WindowHistoryCheck {
  readonly id: string;
  readonly title: string;
  /**
   * 本灯用到的驱动方法，供 runner 对照 `STUBBED` 名单判桩灯。
   * 静态灯（WH-06）不经驱动观察，`uses` 为空数组。
   */
  readonly uses: readonly (keyof WindowHistoryDriver)[];
  run(driver: WindowHistoryDriver): Promise<WindowHistoryCheckResult>;
}
