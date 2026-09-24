/**
 * #120 window-history 生产宿主的组装根。
 *
 * 先决①（一份底座）：canonical stream event store（src/one-stream/）是唯一底座与
 * 唯一写方。全 src/ 里**唯一**的 `new CanonicalStreamWriter` 构造点在本文件的
 * `openCanonicalStreamWriter` 开把手上（WH-06 静态判卷数的就是这一处）；本类与
 * 住户运行时（#194，src/resident-runtime/runtime.ts）都只能经它拿写句柄，
 * 把窗级写入串到底座唯一写方上，并把只读投影
 * （FEAT-001 的 WindowHistoryProjection）接到底座读端口 + 一个由本类实现的
 * WindowLifecycleView 上。落盘存储格式/迁移/回滚/墓碑归 WindowStorageFormatAdmin。
 *
 * 归属：本文件在 src/window-host/，是允许落盘写与持有写句柄的组装/宿主根，不在被
 * WH-06 审计的投影目录 src/window-history/ 里。
 *
 * ## 窗身份与生命周期：一本账，落在同一条底座上
 *
 * 独立验收席（2026-09-24）钉出的缺陷一是「两本互不相连的窗账」：SessionRegistry 自铸
 * `w_`+ULID 身份、回放自己的 journal，而本类对外暴露判卷给的显式 windowId、另维护一张
 * 只活在内存里的窗账 —— 换气与归档因此都不耐久（重启后旧代迟到写被接受、归档窗报
 * running:true）。本次施工把它并成**一本账**：
 *
 *   - **唯一权威**：窗的「当前代际」与「是否归档」是耐久事实，经先决①的唯一写方写进
 *     canonical stream（下称**窗账事实**，`payload.kind =
 *     'mist.window-history.lifecycle/v1'`，两种 state：`generation-opened` / `archived`）。
 *     不另开第二条写路径、不另立第二份需要裁定权威的落盘账。
 *   - **内存窗账只是缓存**：`#windows` 里的每一格都能由「重放该住户流水里的窗账事实」
 *     重算出来；冷启动就是这么重建的（`#rebuildWindowLedger`）。
 *   - **耐久先行**：openWindow / rotateGeneration / archiveWindow 都先把窗账事实写进
 *     底座，成功了才改内存态。写失败就 fail-closed 返回错误，绝不谎报「已换气/已归档」。
 *     这条纪律与 SessionRegistry.kill（先落 journal 再改内存）、
 *     WorkspaceLifecycleOwner.close（先落 closure-requested，归档成功后才落 result）同源。
 *   - **窗账事实不进历史投影**：这些事实的 `origin.viewport` 为 **null**（它们是**关于**
 *     一扇窗的记录，不是**发生在**这扇窗里的一句话），而投影只收 viewport 命中本窗的
 *     事件，所以：WH-03 逐项比较的旧引用事件集合一条不多；开了没写过的窗仍 blank；
 *     `summarize.updatedAt` 也不被窗账事实抬高。识别窗账事实按 `payload.kind` + 信封
 *     一致性，**不按 `purpose` 一刀切** —— 交接信（handover letter）用的也是
 *     `purpose:'lifecycle'`，按 purpose 过滤会把交接信卷进来。
 *
 * ## 与 SessionRegistry / WorkspaceLifecycleOwner 的关系（明写边界）
 *
 * 本宿主**不再**持有 SessionRegistry。理由：SessionRegistry 的 `open()` 只给**新窗**
 * 自铸 `w_`+ULID，显式 windowId 只在「重开一扇已停止的窗」时才收，所以要复用它就必须
 * 另存一份「判卷给的 windowId ↔ 注册表自铸 id」的映射，而这份映射本身就是一条新的耐久
 * 事实 —— 那会变成第二条落盘写路径，正犯先决①。所以本类改为直接在唯一底座上表达同一套
 * 换气纪律（代际单调、归档只读、重开即 +1），由本目录的测试钉死。
 * SessionRegistry 依旧是运行期**活窗表**的权威（scope 授权、DispatchReceipt 回执、
 * headId、迟到结果过滤），它的 journal 记的是活窗与归档证据，不是 history 的权威；
 * WorkspaceLifecycleOwner 则是宿主侧的关窗协调器，它的 closure/result 事件带**非空**
 * viewport，因此一旦与本宿主共用同一条流水，那两条事件会作为普通历史条目出现在窗的
 * 只读流水里 —— 这是「一份底座」的正常语义（关窗这件事本身属于该窗的历史），与窗账事实
 * （viewport 为空、只进恢复面）分工清楚。组装层的接线口径见
 * `docs/design/window-history-projection.md`。
 *
 * ## 窗的「存在」权威（回答验收席的提问）
 *
 * 一扇窗**存在**当且仅当：底座里有它的事实（窗账事实或带该 windowId 的历史事件）
 * **且**本地还有它的格式记录（`*.wh-format.json`，即「这批事件按哪个 formatVersion
 * 呈现」）。底座是 append-only 的唯一底座，永不删事件；能被删的只有本地格式记录。
 * 所以 WH-04 的 deleteDurableWindowData 删掉格式记录之后，读必须 fail-closed 报
 * window-not-found（而不是拿空页冒充「这窗没有历史」）：投影已经无法说清这批字节该按
 * 哪个格式版本呈现。底座里的事实并未销毁 —— 重新登记这扇窗（openWindow）时，它的代际
 * 与归档态会原样从底座重放回来，绝不倒退回第 1 代把旧代迟到写放行。
 *
 * 代价（明写）：
 *   ① 每次开窗/换气/归档都多一条底座事件（落盘量与写延迟随之增加），换来的是「换气与
 *      归档跨进程可恢复」这条硬保证；
 *   ② 窗账事实与历史条目共用同一条流水的序号空间，所以窗的 `updatedAt`（= 该窗历史条目
 *      的最大 streamSeq）不再等于流水长度 —— 它本来就只是单调修订号，不是时间戳
 *      （见 src/window-history/port.ts 的 `updatedAt` 注）；
 *   ③ 放弃复用 SessionRegistry 的换气实现，这套纪律在本目录重述并自带测试，多一份要
 *      随 MV-A01~A03 同步维护的表述。
 */
import { randomUUID } from "node:crypto";
import {
  type CanonicalEvent,
  type CanonicalEventDraft,
  CanonicalStreamStore,
  CanonicalStreamWriter,
  type CanonicalStreamWriterOptions,
  type EventActor,
  IdempotencyConflictError,
  WriterClosedError,
} from "../one-stream/index.ts";
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

/**
 * 底座唯一写方的开把手（先决①）。
 *
 * 全 src/ 里**唯一**允许出现 `new CanonicalStreamWriter` 的地方就是这个函数
 * （WH-06 静态判卷剥掉注释后数的就是这一处）：WindowHistoryHost 与住户运行时
 * （#194 D28，`src/resident-runtime/runtime.ts`）都只能经它拿写句柄。谁另开一处
 * `new CanonicalStreamWriter`，WH-06 的 writer-duplicated 与 resident-runtime.md
 * 理由二的「全仓只有一个构造点」会同时破功 —— 这是两条线共享的硬不变量。
 * 同一根的双写方另有 WriterOwnershipError 按数据根把关。
 */
export function openCanonicalStreamWriter(
  store: CanonicalStreamStore,
  options: CanonicalStreamWriterOptions = {},
): CanonicalStreamWriter {
  // —— 全 src/ 唯一的 new CanonicalStreamWriter 构造点（WH-06 数的就是这一处）——
  return new CanonicalStreamWriter(store, options);
}

/**
 * 窗事件与窗账事实的 `occurredAt` 哨兵值。
 *
 * 为什么是定值（决定 + 代价，2026-09-24 施工时定）：`occurredAt` 参与底座的请求 hash
 * （`hashSubmission(residentId, draft)`），而幂等靠「同一把手 + 同一请求 hash」判定。
 * 一旦改成读挂钟，同一个逻辑写的重试就会算出不同 hash，被底座判成
 * idempotency-conflict —— 幂等直接失效。在底座把「请求同一性」与「宿主观测时间」解耦
 * （或让调用方把时间随幂等把手一起传进来，属 #84 OS-01/02 与判卷契约的联动改动）之前，
 * 本层不引入任何挂钟时间源：**排序与「多新」的权威是 streamSeq，不是 occurredAt**。
 * 代价：任何把 window-history 事件的 `occurredAt` 当真实时间读的消费方都会读到 1970，
 * 所以这个字段在本层只有「无宿主挂钟权威」一个含义，必须这样记进契约、不许当时间用。
 */
export const WINDOW_EVENT_OCCURRED_AT = new Date(0).toISOString();

/** 窗账事实的 payload 形状标签。识别按它 + 信封一致性，不按 purpose 一刀切。 */
export const WINDOW_LIFECYCLE_PAYLOAD_KIND = "mist.window-history.lifecycle/v1";

/** 窗账事实的两种状态：开出一代（含首次开窗与换气）／归档当代。 */
type WindowLifecycleFactState = "generation-opened" | "archived";

interface WindowLifecycleFact {
  readonly windowId: string;
  readonly generation: number;
  readonly state: WindowLifecycleFactState;
}

/** 从底座重放出来的一扇窗的耐久生命周期状态。 */
interface DurableWindowState {
  generation: number;
  archived: boolean;
}

/** 本类内部维护的窗账（`#windows` 的值）——它只是底座事实的缓存。 */
interface HostWindow {
  readonly residentId: string;
  readonly windowId: string;
  generation: number;
  archived: boolean;
}

/**
 * 窗账的复合主键：`(residentId, windowId)`。windowId 只在住户内唯一，跨住户同名窗
 * 是**两扇不同的窗**（壳共享魂私有：串房是本项目性质上最严重的事故）。落盘存储侧
 * （storage-format.ts）本就按 `residentId/windowId` 复合键管窗；内存窗账必须用同一
 * 口径，否则 windowExists/openWindow/写入/换气/归档/删除会拿别的住户的同名窗当自己
 * 的用 —— 那正是审核意见 P1-① 复现的串房。用与 storage-format 相同的分隔符与转义
 * 无关的原样拼接（判卷/存储侧都不含 `/` 于 residentId），保证两侧键一一对应。
 * 窗账事实落在**该住户自己的流水**里，所以重放天然按住户分隔，复合键在恢复面也成立。
 */
function windowKeyOf(residentId: string, windowId: string): string {
  return `${residentId}/${windowId}`;
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

function describe(window: HostWindow): WindowDescriptor {
  return {
    residentId: window.residentId,
    windowId: window.windowId,
    generation: window.generation,
    archived: window.archived,
  };
}

/**
 * 认一条事件是不是本宿主写的**窗账事实**。
 *
 * 判据是 `payload.kind` + 整个信封的一致性（purpose、权威、viewport 为空、字段形状），
 * 不是 `purpose === 'lifecycle'` —— 交接信用的也是 `purpose:'lifecycle'`（见
 * src/one-stream/handover-letters.ts），按 purpose 一刀切会把交接信当窗账读。
 * 任何一项不符就返回 null（当普通事件看待），不抛错：恢复路径不因一条陌生事件瘫掉。
 */
function readWindowLifecycleFact(event: CanonicalEvent): WindowLifecycleFact | null {
  const payload = event.payload;
  if (payload.kind !== WINDOW_LIFECYCLE_PAYLOAD_KIND) return null;
  if (event.purpose !== "lifecycle") return null;
  // 窗账事实是「关于一扇窗」的记录，不是「发生在窗里」的一句话：viewport 必须为空，
  // 否则它就会作为历史条目进只读投影。
  if (event.origin.viewport !== null) return null;
  if (event.authoritySource.kind !== "host" || event.origin.reporter.kind !== "host") return null;
  const windowId = payload.windowId;
  const generation = payload.generation;
  const state = payload.state;
  if (typeof windowId !== "string" || windowId.length === 0) return null;
  if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 1) {
    return null;
  }
  if (state !== "generation-opened" && state !== "archived") return null;
  return { windowId, generation, state };
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
  readonly #storage: WindowStorageFormatAdmin;
  readonly #faults: WindowHostFaultInjector;
  readonly #projection: WindowHistoryProjection;
  readonly #writerId: string;
  /** `(residentId, windowId)` 复合键 -> 窗账（底座窗账事实的内存缓存）。 */
  readonly #windows = new Map<string, HostWindow>();
  #closed = false;

  constructor(options: WindowHistoryHostOptions = {}) {
    const dataDir = resolveDataDir(options.dataDir);
    this.#store = new CanonicalStreamStore({ dataDir });
    // 写句柄经先决①的唯一开把手拿（构造点在 openCanonicalStreamWriter 里，全仓唯一）。
    this.#writer = openCanonicalStreamWriter(
      this.#store,
      options.newEventId === undefined ? {} : { newEventId: options.newEventId },
    );
    this.#storage = new WindowStorageFormatAdmin(dataDir);
    // fault-aware 读端口：包住底座 store，按盘上故障标记改写读路径（WH-04）。
    this.#faults = new WindowHostFaultInjector(dataDir, this.#store);
    this.#writerId = options.writerId ?? `canonical-writer-${randomStableId()}`;

    const host = this;
    const lifecycle: WindowLifecycleView = {
      windowExists(input) {
        // 按复合键查：住户 A 有 `w` 不代表住户 B 也有 `w`（否则 B 读 A 的 `w`
        // 会拿到 OK 空页而非 window-not-found —— 串房）。
        return host.#windows.has(windowKeyOf(input.residentId, input.windowId));
      },
      formatVersion(input) {
        return host.#storage.formatVersionOf(input);
      },
      migrationStatus(input) {
        void input;
        return host.#storage.migrationStatus() as WindowStorageMigrationStatus;
      },
      isRunning(input) {
        const window = host.#windows.get(windowKeyOf(input.residentId, input.windowId));
        return window !== undefined && !window.archived;
      },
    };
    this.#projection = new WindowHistoryProjection(this.#faults, lifecycle);

    // —— 冷启动重建窗账 ——
    // 判卷会在死前 openWindow + 写事件，杀进程，重启后**不再 openWindow** 直接读。
    // 内存 #windows 随进程死光，所以构造时必须只凭落盘事实把窗账重建出来，否则
    // windowExists() 转假、读回 window-not-found（WH-01/WH-03 判红）。窗的存在看
    // 格式记录（`*.wh-format.json`），代际与归档态一律重放底座里的窗账事实 ——
    // 后者是唯一权威，绝不靠内存或第二份落盘账。
    this.#rebuildWindowLedger();
  }

  /** 只凭落盘事实重建 `(residentId, windowId)` -> 窗账（冷启动路径）。 */
  #rebuildWindowLedger(): void {
    // 每个住户只重放一遍流水：窗多时别把 O(窗 × 事件) 重放成默认代价。
    const replayed = new Map<string, Map<string, DurableWindowState>>();
    for (const known of this.#storage.knownWindows()) {
      const key = windowKeyOf(known.residentId, known.windowId);
      if (this.#windows.has(key)) continue;
      let states = replayed.get(known.residentId);
      if (states === undefined) {
        states = this.#replayDurableWindows(known.residentId);
        replayed.set(known.residentId, states);
      }
      const durable = states.get(known.windowId);
      this.#windows.set(key, {
        residentId: known.residentId,
        windowId: known.windowId,
        // 底座里一条事实都没有的窗（理论上只可能是手工造的格式记录）回落第 1 代活态。
        generation: durable?.generation ?? 1,
        archived: durable?.archived ?? false,
      });
    }
  }

  /**
   * 重放一位住户的流水，算出每扇窗的耐久生命周期状态。
   *
   * 按 streamSeq 升序重放（store 保证连续），所以「开出一代 / 归档当代」的先后就是
   * 真实发生顺序：最后一条窗账事实决定这扇窗此刻是活着还是归档。
   * 另收一条兜底：历史事件自带的 `origin.viewport.generation` 也算水位（取 max）。
   * 兜底只会把水位**抬高**、把更多写判成旧代（fail-closed 方向），用于这些情形：
   * 本次改造前写下的流水、或格式记录丢失后重新登记的窗。
   */
  #replayDurableWindows(residentId: string): Map<string, DurableWindowState> {
    const states = new Map<string, DurableWindowState>();
    if (!this.#store.has(residentId)) return states;
    for (const event of this.#store.eventsAfter(residentId, 0)) {
      const fact = readWindowLifecycleFact(event);
      if (fact !== null) {
        const current = states.get(fact.windowId);
        if (fact.generation >= (current?.generation ?? 0)) {
          // 水位齐平或更新：这条事实就是这扇窗此刻的状态（开出一代 => 活；归档 => 只读）。
          states.set(fact.windowId, {
            generation: fact.generation,
            archived: fact.state === "archived",
          });
        } else if (current !== undefined) {
          // 比水位更旧的窗账事实（正常写路径不会产生）：只当历史看，不改当代活/归档态。
          current.generation = Math.max(current.generation, fact.generation);
        }
        continue;
      }
      const viewport = event.origin.viewport;
      if (viewport === null) continue;
      const current = states.get(viewport.windowId);
      if (current === undefined) {
        states.set(viewport.windowId, { generation: viewport.generation, archived: false });
        continue;
      }
      if (viewport.generation > current.generation) current.generation = viewport.generation;
    }
    return states;
  }

  /**
   * 把一条窗账事实经**唯一写方**写进底座。耐久先行：调用方拿到 ok 才改内存态。
   * 幂等把手按 `(windowId, generation, state)` 命名：同一个生命周期动作重试不会
   * 写出第二条事实，也不会因为重算 hash 而假冲突（occurredAt 是定值，见上注）。
   */
  async #submitLifecycleFact(residentId: string, fact: WindowLifecycleFact): Promise<Result<null>> {
    if (!this.#store.has(residentId)) this.#store.createStream(residentId);
    const draft: CanonicalEventDraft = {
      purpose: "lifecycle",
      occurredAt: WINDOW_EVENT_OCCURRED_AT,
      workRef: null,
      authoritySource: HOST_ACTOR,
      origin: {
        reporter: HOST_ACTOR,
        subject: { kind: "viewport", id: fact.windowId },
        // viewport 必须为空：窗账事实是「关于这扇窗」的记录，不进只读历史投影。
        viewport: null,
      },
      effect: { state: "committed-effective", requiresUserAction: false, retry: "none" },
      artifactRef: null,
      payload: {
        kind: WINDOW_LIFECYCLE_PAYLOAD_KIND,
        windowId: fact.windowId,
        generation: fact.generation,
        state: fact.state,
      },
    };
    try {
      await this.#writer.submit({
        residentId,
        idempotencyKey: `window-lifecycle:${fact.windowId}:${fact.generation}:${fact.state}`,
        draft,
      });
      return ok(null);
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        return fail(structuredError("idempotency-conflict", error.message, fact.windowId));
      }
      if (error instanceof WriterClosedError) return fail(writerUnavailable());
      return fail(storageUnavailable(error));
    }
  }

  // —— 只读投影：判卷对象，委托给 FEAT-001 的 projection ——

  summarize(ref: WindowHistoryRef): Promise<Result<WindowHistorySummary>> {
    return this.#projection.summarize(ref);
  }

  read(ref: WindowHistoryRef, page: WindowHistoryPageRequest): Promise<Result<WindowHistoryPage>> {
    return this.#projection.read(ref, page);
  }

  // —— 写入侧：造被读的事实，不属于 port ——

  /**
   * 登记一扇窗。已在窗账里就原样返回；不在窗账里先重放底座 —— 底座里已有这扇窗的
   * 耐久事实（如格式记录被删后重开）时按耐久代际/归档态恢复，**绝不倒退回第 1 代**；
   * 底座里确实没有才铸第 1 代，并先把窗账事实落进底座再记内存。
   */
  async openWindow(input: {
    residentId: string;
    windowId: string;
  }): Promise<Result<WindowDescriptor>> {
    if (this.#closed) return fail(writerUnavailable());
    // 复合键查：`(B, w)` 与 `(A, w)` 是两扇不同的窗。命中只可能是本住户自己的窗，
    // 绝不会返回别的住户同名窗的 descriptor（那会泄露对方的 residentId 与代际）。
    const key = windowKeyOf(input.residentId, input.windowId);
    const tracked = this.#windows.get(key);
    if (tracked !== undefined) return ok(describe(tracked));

    const durable = this.#replayDurableWindows(input.residentId).get(input.windowId);
    if (durable === undefined) {
      const written = await this.#submitLifecycleFact(input.residentId, {
        windowId: input.windowId,
        generation: 1,
        state: "generation-opened",
      });
      if (!written.ok) return fail(written.error);
    }
    const window: HostWindow = {
      residentId: input.residentId,
      windowId: input.windowId,
      generation: durable?.generation ?? 1,
      archived: durable?.archived ?? false,
    };
    this.#windows.set(key, window);
    this.#storage.ensureWindow(input);
    return ok(describe(window));
  }

  async appendWindowEvent(input: AppendWindowEventInput): Promise<Result<AppendReceipt>> {
    if (this.#closed) return fail(writerUnavailable());
    // 复合键查：只能写本住户自己的窗，写不到别的住户的同名窗（串房）。
    const window = this.#windows.get(windowKeyOf(input.residentId, input.windowId));
    if (window === undefined) {
      return fail(
        structuredError("window-not-found", `no such window: ${input.windowId}`, input.windowId),
      );
    }
    // 归档窗只读（D7，docs/decisions.md:74「关窗归档为只读日志」）。归档过的那一代
    // 已经封存，同代写也是对一条已关闭代际的迟到写 => stale-generation，fail-closed
    // 不落流。要继续写只有一条合法路径：rotateGeneration 按同一身份重开出新一代。
    // 代价（明写）：错误码用的是契约既有的 stale-generation（判卷契约里的错误码并集
    // 已冻结，见 acceptance/window-history-driver.ts），所以「归档」与「旧代」在码上
    // 同值，要分辨得读 message。专设 window-archived 码需要与判卷契约联动改动，已在
    // 交接里列为 #196 后继的待议项。
    if (window.archived) {
      return fail(
        structuredError(
          "stale-generation",
          `window ${input.windowId} is archived at generation ${window.generation}; an archived window is a read-only log (D7) — reopen it with rotateGeneration to write a new generation`,
          input.windowId,
        ),
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
    // 未来/未开代际 fail-closed：写请求代际高于窗当前代际，说明这个
    // `(windowId, generation)` 切片还不存在 —— 推进代际的唯一合法路径是
    // rotateGeneration（换气），绝不能靠一次写就凭空跳代。若放行，#draftFor 会把这个
    // 伪造代际逐字写进 provenance，重启后重放会把这条历史事件的代际当水位，一次未来写
    // 就把窗永久顶到 99、正常当代写反被判成旧代。这个切片不存在，用 window-not-found
    // （(windowId, generation) 目标缺失，语义比 stale-generation 准；stale-generation
    // 契约上专指旧代迟到写），fail-closed 不落流、不抬水位。
    if (input.generation > window.generation) {
      return fail(
        structuredError(
          "window-not-found",
          `generation ${input.generation} is ahead of window generation ${window.generation}; advance via rotateGeneration, not by writing a future generation`,
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

  /**
   * 换气：代际 +1。语义与 MV-A01~A03 的「kill + 按同一身份重开」一致 —— 归档过的窗
   * 换气就是重开，旧代仍是只读日志，新代可写。windowId 逐字不变，writer 不换。
   * 耐久先行：新代的窗账事实先落底座，成功了才推进内存水位；写失败则窗仍停在旧代，
   * 不谎报已换气（这也保证「换气了但没落盘」这种重启后放行旧代写的洞不再存在）。
   */
  async rotateGeneration(input: {
    residentId: string;
    windowId: string;
  }): Promise<Result<WindowDescriptor>> {
    if (this.#closed) return fail(writerUnavailable());
    // 复合键查：只能给本住户自己的窗换气。
    const window = this.#windows.get(windowKeyOf(input.residentId, input.windowId));
    if (window === undefined) {
      return fail(
        structuredError("window-not-found", `no such window: ${input.windowId}`, input.windowId),
      );
    }
    const next = window.generation + 1;
    const written = await this.#submitLifecycleFact(input.residentId, {
      windowId: input.windowId,
      generation: next,
      state: "generation-opened",
    });
    if (!written.ok) return fail(written.error);
    window.generation = next;
    window.archived = false;
    return ok(describe(window));
  }

  /** 归档：当代封存成只读日志（D7）。耐久先行，重启后仍是归档态（running:false）。 */
  async archiveWindow(input: {
    residentId: string;
    windowId: string;
  }): Promise<Result<WindowDescriptor>> {
    if (this.#closed) return fail(writerUnavailable());
    // 复合键查：只能归档本住户自己的窗。
    const window = this.#windows.get(windowKeyOf(input.residentId, input.windowId));
    if (window === undefined) {
      return fail(
        structuredError("window-not-found", `no such window: ${input.windowId}`, input.windowId),
      );
    }
    // 幂等：已归档就原样返回，不写第二条事实。
    if (window.archived) return ok(describe(window));
    const written = await this.#submitLifecycleFact(input.residentId, {
      windowId: input.windowId,
      generation: window.generation,
      state: "archived",
    });
    if (!written.ok) return fail(written.error);
    window.archived = true;
    return ok(describe(window));
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
   * 真实删掉该窗的落盘呈现记录：抹掉它的格式记录（`*.wh-format.json`）与内存窗账。
   * 读回 window-not-found（不是空页）。
   *
   * 只删本窗的呈现记录，不动共享住户流水文件：同一 residentId 下可能还有别的窗，判卷
   * 正是靠「同住户里删掉某扇窗后它 window-not-found、其余窗照常」区分「读不到」与
   * 「读到是空」。存在权威是**底座事实 ∧ 格式记录**（见文件顶注「窗的存在权威」）：
   * 底座是 append-only 的唯一底座，永不删事件；能删的只有格式记录，删掉之后投影说不清
   * 这批字节按哪个 formatVersion 呈现，所以 fail-closed。底座里的事实没被销毁 ——
   * 重新 openWindow 时代际与归档态会原样重放回来。
   */
  deleteDurableWindowData(input: { residentId: string; windowId: string }): void {
    // storage.forgetWindow 本就按复合键删；内存窗账也必须按复合键删，否则会误删
    // 别的住户的同名窗（storage-format 侧安然无恙，内存账却把对方的窗抹了）。
    this.#storage.forgetWindow(input);
    this.#windows.delete(windowKeyOf(input.residentId, input.windowId));
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
      // 定值哨兵；理由与代价见 WINDOW_EVENT_OCCURRED_AT 的注。
      occurredAt: WINDOW_EVENT_OCCURRED_AT,
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
