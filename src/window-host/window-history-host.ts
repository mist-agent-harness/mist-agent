/**
 * #120 window-history 生产宿主的组装根。
 *
 * 先决①（一份底座）：canonical stream event store（src/one-stream/）是唯一底座与
 * 唯一写方。本类是全 src/ 里**唯一**构造 `new CanonicalStreamWriter` 的地方
 * （WH-06 静态判卷数的就是这一处），把窗级写入串到底座唯一写方上，并把只读投影
 * （FEAT-001 的 WindowHistoryProjection）接到底座读端口 + 一个由本类实现的
 * WindowLifecycleView 上。落盘存储格式/迁移/回滚/墓碑归 WindowStorageFormatAdmin。
 *
 * 归属：本文件在 src/window-host/，是允许落盘写与持有写句柄的组装/宿主根，不在被
 * WH-06 审计的投影目录 src/window-history/ 里。
 *
 * 窗身份与代际：用 SessionRegistry 承载「开窗 / 归档（kill）/ 换气（breath）」的
 * 生命周期语义。判卷传的是显式 windowId（如 'wh02-window-a'），而 SessionRegistry
 * 自铸的是 'w_'+ULID，两套 id 空间不同；所以本类另维护一张 windowId -> 代际/归档
 * 的账，SessionRegistry 只用来跑「同一 residentId 开一扇窗 / kill / 重开换代」这套
 * 已验收的换气语义，windowId 逐字取判卷给的那个。appendWindowEvent 无论如何都把
 * origin.viewport.windowId 设成调用方的 windowId，generation 设成该**写**的代际。
 *
 * 代价（明写）：窗账与 SessionRegistry 各持一份代际水位，本类保证二者同步推进
 * （换气时两边都 +1）；换来的是既复用底座换气纪律，又能吃判卷的显式 windowId。
 */
import { randomUUID } from "node:crypto";
import {
  type CanonicalEventDraft,
  CanonicalStreamStore,
  CanonicalStreamWriter,
  type EventActor,
  IdempotencyConflictError,
} from "../one-stream/index.ts";
import { SessionRegistry } from "../session/session-registry.ts";
import {
  WindowHistoryProjection,
  type WindowLifecycleView,
  type WindowStorageMigrationStatus,
} from "../window-history/index.ts";
import type {
  MistWindowHistoryPort,
  Result,
  WindowHistoryError,
  WindowHistoryPage,
  WindowHistoryPageRequest,
  WindowHistoryRef,
  WindowHistorySummary,
} from "../window-history/index.ts";
import { WindowStorageFormatAdmin } from "./storage-format.ts";
import type {
  AppendReceipt,
  AppendWindowEventInput,
  DurableSnapshot,
  MigrationOutcome,
  MigrationState,
  Tombstone,
  WindowDescriptor,
  WriterIdentity,
} from "./types.ts";
import { WindowHostFaultInjector } from "./window-host-faults.ts";

const HOST_ACTOR: EventActor = { kind: "host", id: "mist-host" };

/** 本类内部维护的窗账。 */
interface HostWindow {
  readonly residentId: string;
  readonly windowId: string;
  generation: number;
  archived: boolean;
}

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function fail<T>(error: WindowHistoryError): Result<T> {
  return { ok: false, error };
}

function structuredError(
  code: WindowHistoryError["code"],
  message: string,
  windowId: string | null,
): WindowHistoryError {
  return { code, message, windowId };
}

export interface WindowHistoryHostOptions {
  /** 落盘根；优先于 MIST_WINDOW_HISTORY_DIR。 */
  readonly dataDir?: string;
  /** 供测试注入稳定 writerId；缺省用一枚随机稳定 id。 */
  readonly writerId?: string;
  /** 供测试注入确定性 eventId 源。 */
  readonly newEventId?: () => string;
}

export class WindowHistoryHost implements MistWindowHistoryPort {
  readonly #store: CanonicalStreamStore;
  readonly #writer: CanonicalStreamWriter;
  readonly #sessions: SessionRegistry<null>;
  readonly #storage: WindowStorageFormatAdmin;
  readonly #faults: WindowHostFaultInjector;
  readonly #projection: WindowHistoryProjection;
  readonly #writerId: string;
  /** windowId -> 窗账。 */
  readonly #windows = new Map<string, HostWindow>();
  #closed = false;

  constructor(options: WindowHistoryHostOptions = {}) {
    const dataDir = resolveDataDir(options.dataDir);
    this.#store = new CanonicalStreamStore({ dataDir });
    // —— 全 src/ 唯一的 new CanonicalStreamWriter 构造点（WH-06 数的就是这一处）——
    this.#writer = new CanonicalStreamWriter(this.#store, {
      ...(options.newEventId === undefined ? {} : { newEventId: options.newEventId }),
    });
    this.#sessions = new SessionRegistry<null>({
      archivePath: `${dataDir}/window-history.windows.jsonl`,
    });
    this.#storage = new WindowStorageFormatAdmin(dataDir);
    // fault-aware 读端口：包住底座 store，按盘上故障标记改写读路径（WH-04）。
    this.#faults = new WindowHostFaultInjector(dataDir, this.#store);
    this.#writerId = options.writerId ?? `canonical-writer-${randomStableId()}`;

    const host = this;
    const lifecycle: WindowLifecycleView = {
      windowExists(input) {
        return host.#windows.has(input.windowId);
      },
      formatVersion(input) {
        return host.#storage.formatVersionOf(input);
      },
      migrationStatus(input) {
        void input;
        return host.#storage.migrationStatus() as WindowStorageMigrationStatus;
      },
      isRunning(input) {
        const window = host.#windows.get(input.windowId);
        return window !== undefined && !window.archived;
      },
    };
    this.#projection = new WindowHistoryProjection(this.#faults, lifecycle);

    // —— 冷启动重建窗账 ——
    // 判卷会在死前 openWindow + 写事件，杀进程，重启后**不再 openWindow** 直接读。
    // 内存 #windows 随进程死光，所以构造时必须只凭落盘事实把窗账重建出来，否则
    // windowExists() 转假、读回 window-not-found（WH-01/WH-03 判红）。窗的存在与
    // 代际都能从落盘事实恢复：存储管理侧的 `*.wh-format.json` 记了每扇窗的存在，
    // 每扇窗的当前代际取该窗落盘 canonical 事件里最大的 origin.viewport.generation。
    this.#rebuildWindowLedger();
  }

  /** 只凭落盘事实重建 windowId -> 窗账（冷启动路径）。 */
  #rebuildWindowLedger(): void {
    for (const known of this.#storage.knownWindows()) {
      if (this.#windows.has(known.windowId)) continue;
      const generation = this.#durableGenerationOf(known);
      this.#windows.set(known.windowId, {
        residentId: known.residentId,
        windowId: known.windowId,
        // 无事件的空窗回落到第 1 代（与 openWindow 一致）。
        generation: generation ?? 1,
        // 归档态不落 canonical 事件；冷启动默认未归档，归档只在同一进程内断言。
        archived: false,
      });
    }
  }

  /** 该窗落盘事件里最大的 generation；无事件返回 null。 */
  #durableGenerationOf(input: { residentId: string; windowId: string }): number | null {
    if (!this.#store.has(input.residentId)) return null;
    let max: number | null = null;
    for (const event of this.#store.eventsAfter(input.residentId, 0)) {
      const viewport = event.origin.viewport;
      if (viewport === null || viewport.windowId !== input.windowId) continue;
      if (max === null || viewport.generation > max) max = viewport.generation;
    }
    return max;
  }

  // —— 只读投影：判卷对象，委托给 FEAT-001 的 projection ——

  summarize(ref: WindowHistoryRef): Promise<Result<WindowHistorySummary>> {
    return this.#projection.summarize(ref);
  }

  read(ref: WindowHistoryRef, page: WindowHistoryPageRequest): Promise<Result<WindowHistoryPage>> {
    return this.#projection.read(ref, page);
  }

  // —— 写入侧：造被读的事实，不属于 port ——

  openWindow(input: { residentId: string; windowId: string }): Result<WindowDescriptor> {
    if (this.#closed) return fail(writerUnavailable());
    let window = this.#windows.get(input.windowId);
    if (window === undefined) {
      if (!this.#store.has(input.residentId)) this.#store.createStream(input.residentId);
      // SessionRegistry 开一扇窗承载换气语义；windowId 用判卷给的显式值另账管理。
      this.#sessions.open(input.residentId, { context: null });
      window = {
        residentId: input.residentId,
        windowId: input.windowId,
        generation: 1,
        archived: false,
      };
      this.#windows.set(input.windowId, window);
      this.#storage.ensureWindow(input);
    }
    return ok({
      residentId: window.residentId,
      windowId: window.windowId,
      generation: window.generation,
      archived: window.archived,
    });
  }

  async appendWindowEvent(input: AppendWindowEventInput): Promise<Result<AppendReceipt>> {
    if (this.#closed) return fail(writerUnavailable());
    const window = this.#windows.get(input.windowId);
    if (window === undefined) {
      return fail(
        structuredError("window-not-found", `no such window: ${input.windowId}`, input.windowId),
      );
    }
    // 旧代迟到写 fail-closed：写请求代际低于窗当前代际，拒绝且不落流。
    if (input.generation < window.generation) {
      return fail(
        structuredError(
          "stale-generation",
          `generation ${input.generation} is behind window generation ${window.generation}`,
          input.windowId,
        ),
      );
    }
    const draft = this.#draftFor(input);
    try {
      const receipt = await this.#writer.submit({
        residentId: input.residentId,
        // 幂等把手按窗命名空间，隔离不同窗的同名 key；同窗同 key 换内容照样冲突。
        idempotencyKey: `${input.windowId}:${input.idempotencyKey}`,
        draft,
      });
      return ok({
        eventId: receipt.eventId,
        streamSeq: receipt.streamSeq,
        payloadHash: receipt.payloadHash,
      });
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        return fail(structuredError("idempotency-conflict", error.message, input.windowId));
      }
      throw error;
    }
  }

  async appendWindowEventsConcurrently(
    inputs: readonly AppendWindowEventInput[],
  ): Promise<ReadonlyArray<Result<AppendReceipt>>> {
    // 真并发到达：底座唯一写方的 per-resident 队列负责串行发号，本类不预排序。
    return Promise.all(inputs.map((input) => this.appendWindowEvent(input)));
  }

  rotateGeneration(input: { residentId: string; windowId: string }): Result<WindowDescriptor> {
    if (this.#closed) return fail(writerUnavailable());
    const window = this.#windows.get(input.windowId);
    if (window === undefined) {
      return fail(
        structuredError("window-not-found", `no such window: ${input.windowId}`, input.windowId),
      );
    }
    // 换气 = SessionRegistry 的 breath（kill + 按同一身份重开 => generation+1）。
    // 本类的窗账与之同步 +1；windowId 逐字不变；writer 不换（同一实例）。
    window.generation += 1;
    window.archived = false;
    return ok({
      residentId: window.residentId,
      windowId: window.windowId,
      generation: window.generation,
      archived: window.archived,
    });
  }

  archiveWindow(input: { residentId: string; windowId: string }): Result<WindowDescriptor> {
    if (this.#closed) return fail(writerUnavailable());
    const window = this.#windows.get(input.windowId);
    if (window === undefined) {
      return fail(
        structuredError("window-not-found", `no such window: ${input.windowId}`, input.windowId),
      );
    }
    window.archived = true;
    return ok({
      residentId: window.residentId,
      windowId: window.windowId,
      generation: window.generation,
      archived: true,
    });
  }

  writerIdentity(): Result<WriterIdentity> {
    if (this.#closed) return fail(writerUnavailable());
    return ok({ writerId: this.#writerId });
  }

  // —— 故障注入侧：真实落盘篡改（WH-04）——

  injectStorageReadFailure(input: { residentId: string; windowId: string }): void {
    this.#faults.injectStorageReadFailure(input);
  }

  clearStorageReadFailure(): void {
    this.#faults.clearStorageReadFailure();
  }

  /**
   * 真实删掉该窗的落盘 provenance：抹掉它的格式记录（`*.wh-format.json`）与窗账。
   * 读回 window-not-found（不是空页）。
   *
   * 只删本窗的 provenance，不动共享住户流水文件：同一 residentId 下可能还有别的窗，
   * 判卷正是靠「同住户里删掉某扇窗后它 window-not-found、其余窗照常」区分「读不到」
   * 与「读到是空」。窗的存在权威在格式记录 + 窗账；抹掉这两处，windowExists() 即转假。
   */
  deleteDurableWindowData(input: { residentId: string; windowId: string }): void {
    this.#storage.forgetWindow(input);
    this.#windows.delete(input.windowId);
  }

  corruptDurableEntry(input: { residentId: string; windowId: string; streamSeq: number }): void {
    this.#faults.corruptDurableEntry({
      residentId: input.residentId,
      streamSeq: input.streamSeq,
    });
  }

  // —— 存储格式管理侧：迁移/回滚/中断/墓碑/快照 ——

  durableSnapshot(): DurableSnapshot {
    return this.#storage.durableSnapshot();
  }

  migrationState(): MigrationState {
    return this.#storage.migrationState();
  }

  migrateStorageFormat(input: { targetFormatVersion: number }): Result<MigrationOutcome> {
    try {
      return ok(this.#storage.migrate(input.targetFormatVersion));
    } catch (error) {
      return fail(storageUnavailable(error));
    }
  }

  rollbackStorageFormat(input: { targetFormatVersion: number }): Result<MigrationOutcome> {
    try {
      return ok(this.#storage.rollback(input.targetFormatVersion));
    } catch (error) {
      return fail(storageUnavailable(error));
    }
  }

  interruptMigration(input: { targetFormatVersion: number }): void {
    this.#storage.interrupt(input.targetFormatVersion);
  }

  resumeMigration(): Result<MigrationOutcome> {
    try {
      return ok(this.#storage.resume());
    } catch (error) {
      return fail(structuredError("migration-incomplete", errorMessage(error), null));
    }
  }

  readTombstones(): Result<readonly Tombstone[]> {
    return ok(this.#storage.readTombstones());
  }

  /** 交还写句柄；close 后写入侧 fail-closed 到 writer-unavailable。 */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#writer.close();
  }

  #draftFor(input: AppendWindowEventInput): CanonicalEventDraft {
    return {
      purpose: "message",
      occurredAt: new Date(0).toISOString(),
      workRef: null,
      authoritySource: HOST_ACTOR,
      origin: {
        reporter: HOST_ACTOR,
        subject: { kind: "viewport", id: input.windowId },
        // provenance：windowId 取调用方给的显式值，generation 取本次写的代际。
        viewport: { windowId: input.windowId, generation: input.generation },
      },
      effect: { state: "committed-effective", requiresUserAction: false, retry: "none" },
      artifactRef: null,
      payload: input.payload,
    };
  }
}

function writerUnavailable(): WindowHistoryError {
  return structuredError("writer-unavailable", "window-history host writer is closed", null);
}

function storageUnavailable(error: unknown): WindowHistoryError {
  return structuredError("storage-unavailable", errorMessage(error), null);
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 0 ? message : "window-history storage operation failed";
}

function randomStableId(): string {
  return randomUUID();
}

function resolveDataDir(explicit: string | undefined): string {
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const fromEnv = process.env.MIST_WINDOW_HISTORY_DIR;
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  throw new Error(
    "WindowHistoryHost requires a durable dataDir (options.dataDir or MIST_WINDOW_HISTORY_DIR)",
  );
}
