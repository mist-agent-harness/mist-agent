/**
 * #194 住户运行时（D28 的那条最小闭环）：醒来（读启动包）→ 按 D25 走通道调模型 →
 * 把用户消息与住户回复经 one-stream 唯一 writer 落进一窗流。
 *
 * 真源归 mist（D28 二）：一窗流的唯一 writer 是 `CanonicalStreamWriter`（D9，
 * 全仓唯一构造点在 window-host/window-history-host.ts 的 openCanonicalStreamWriter
 * 开把手上，本类经它拿句柄），启动包由 `buildBootPack` 从存储装配（RT-07 按定义判
 * 唯一），代际由 `SessionRegistry` 发（1 起点，宿主重启后代际递增——硬杀即猝死，
 * 继任者接代）。pi 只当零件库：模型走传输层（channels.ts），不持有会话副本。
 *
 * 失败纪律（RT-01）：凭证没配（credential-missing）与凭证失效（credential-invalid）
 * 机器可分、都带可操作 remedy；**往返失败不落账**——一窗流不许出现伪造回复，
 * 连用户那句也不落（成功路径才在往返后依次落 user → assistant）。
 *
 * 代价：窗口代际与一窗流是两本账（SessionRegistry 的 journal vs `*.stream.json`），
 * 没有跨账事务——宿主死在两账之间时，以一窗流为准（流是真源），窗账的代际缺口由
 * 重启重开补（下一 PR 的换代线走 D8 显式 breathe()，不靠猜 token 数）。
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  BootPackView,
  BreathTrigger,
  BreatheOutcome,
  ChannelRoute,
  ChannelSpec,
  LetterTimeline,
  MemoryEntryView,
  ProvisionedChannel,
  ResidentRuntimeError,
  ResidentRuntimeErrorCode,
  Result,
  SecretHit,
  SecretScanReport,
  StreamEventView,
  StreamFileInventory,
  StreamSnapshot,
  TurnResult,
} from "../../acceptance/resident-runtime-driver.ts";
import { buildBootPack } from "../bootpack.ts";
import type { CanonicalEventDraft, EventActor, JsonObject } from "../one-stream/event-contract.ts";
import { CanonicalStreamStore, StreamNotFoundError } from "../one-stream/index.ts";
import { BreathCycle, BreathCycleError } from "../session/breath-cycle.ts";
import {
  LetterSchemaError,
  type SealedLetter,
  estimateTokens,
} from "../session/handover-letter.ts";
import { SessionRegistry, WindowReopenError } from "../session/session-registry.ts";
import { LedgerNotFoundError } from "../store/fact-ledger-errors.ts";
import type { FactLedger } from "../store/fact-ledger.ts";
import { ResidentNotFoundError, ResidentStore } from "../store/resident-store.ts";
import {
  WINDOW_EVENT_OCCURRED_AT,
  openCanonicalStreamWriter,
} from "../window-host/window-history-host.ts";
import {
  BreathStateStore,
  LetterStore,
  composeLetterDraft,
  toLetterTimeline,
  toLetterView,
} from "./breath.ts";
import {
  type ChannelRouteLike,
  ChannelSpecError,
  type ChannelSpecLike,
  type ModelTransport,
  createModelTransport,
  resolveChannelRoute,
} from "./channels.ts";
import { CredentialStore } from "./credentials.ts";

const WINDOW_INDEX_SCHEMA = 1;

interface WindowIndex {
  readonly schemaVersion: typeof WINDOW_INDEX_SCHEMA;
  readonly windows: Readonly<Record<string, string>>;
  /** 调用方认领的对外窗号（住户号同款纪律）：认领即落盘，重启不许换号。 */
  readonly publicWindows?: Readonly<Record<string, string>>;
}

/**
 * say() 的入参。turnId 是重试锚（评审意见 1 / 验收席意见 3）：幂等键由它派生
 * （say-user-/say-assistant- 各一份），同一回合的重试带同一个 turnId 就不写重复、
 * 已完成的回合直接回放已记录结果；缺省自造 = 当新回合。
 */
interface SayInput {
  residentId: string;
  text: string;
  turnId?: string;
  /** 真实模型增量的观察口；TUI 可逐段绘制，不影响唯一 writer 的回合语义。 */
  onChunk?: (chunk: string) => void;
}

export interface ResidentRuntimeOptions {
  readonly dataDir: string;
  /** 模型传输。缺省按 MIST_RESIDENT_RUNTIME_TRANSPORT 选（默认合成通道）。 */
  readonly transport?: ModelTransport;
  /**
   * 权威事实账（MV-A05）：接了就把 ledger.currentSet() 注进启动包的 currentFacts
   * 分区随请求进模型。不传 = 没接账（与「账是空的」不是同一个值，缺席即缺席）。
   */
  readonly factLedger?: FactLedger;
}

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function fail<T>(
  code: ResidentRuntimeErrorCode,
  message: string,
  remedy: string,
  residentId: string | null,
): Result<T> {
  const error: ResidentRuntimeError = { code, message, remedy, residentId };
  return { ok: false, error };
}

function isMissingFile(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export class ResidentRuntime {
  readonly #streamsDir: string;
  readonly #residentsDir: string;
  readonly #lettersDir: string;
  readonly #logsDir: string;
  readonly #windowIndexPath: string;
  readonly #residents: ResidentStore;
  readonly #streams: CanonicalStreamStore;
  /** 写句柄类型不点名（点名 import type 会被 RT-07 的「定义」检索数成第二份写入路径），跟开把手的返回类型走。 */
  readonly #writer: ReturnType<typeof openCanonicalStreamWriter>;
  readonly #sessions: SessionRegistry<{ letter: SealedLetter | null }>;
  readonly #credentials: CredentialStore;
  readonly #transport: ModelTransport;
  readonly #factLedger: FactLedger | undefined;
  readonly #breathState: BreathStateStore;
  readonly #letters: LetterStore;
  readonly #breathCycle: BreathCycle<{ letter: SealedLetter | null }>;
  /** 调用方指定的窗身份（住户号同款「指定事实」纪律）：对外窗号，换气前后逐字不变。
   * 认领与 window-index 同级落盘（协助审查）：重启也不许换号。 */
  #publicWindowIndex: Record<string, string> = {};
  /** 已起过回合的 (窗口, 代际)：窗只能在开工（本代还没有回合）时设自己的线（D8 一）。 */
  readonly #turnStarted = new Set<string>();
  /**
   * 同一住户的操作串行域（验收席意见 2 / 协助审查「换代-回合竞态」）：say 的
   * 完整回合与 breathe/suddenDeath 的换代动作共用一条队列——「读上下文 → 调
   * 模型 → 落账」和「封信 → 换代」不许交错。后一个操作排队等前一个落完。
   */
  readonly #turnQueues = new Map<string, Promise<unknown>>();
  readonly #windows = new Map<string, string>();
  #windowIndex: Record<string, string> = {};

  constructor(options: ResidentRuntimeOptions) {
    const dataDir = options.dataDir;
    this.#streamsDir = join(dataDir, "streams");
    this.#residentsDir = join(dataDir, "residents");
    this.#lettersDir = join(dataDir, "letters");
    this.#logsDir = join(dataDir, "logs");
    mkdirSync(this.#streamsDir, { recursive: true });
    mkdirSync(this.#residentsDir, { recursive: true });
    this.#residents = new ResidentStore({ dataDir: this.#residentsDir });
    this.#streams = new CanonicalStreamStore({ dataDir: this.#streamsDir });
    // 写句柄经先决①的唯一开把手拿（构造点全仓唯一，在 window-host/window-history-host.ts
    // 的 openCanonicalStreamWriter 里）：WH-06 的唯一写方判据与 resident-runtime.md
    // 理由二的「全仓只有一个构造点」共享这条硬不变量，谁也不许另开第二处。
    // 运行时与 window-history 宿主各守自己的数据根，不存在同一根的双写方。
    this.#writer = openCanonicalStreamWriter(this.#streams);
    this.#sessions = new SessionRegistry<{ letter: SealedLetter | null }>({
      archivePath: join(dataDir, "sessions", "windows.journal"),
    });
    this.#credentials = new CredentialStore(join(dataDir, "credentials"));
    this.#transport = options.transport ?? createModelTransport();
    this.#factLedger = options.factLedger;
    this.#breathState = new BreathStateStore(join(dataDir, "sessions", "breath.json"));
    this.#letters = new LetterStore(this.#lettersDir);
    // 换气编排走现役 BreathCycle（封信 sealLetter → 落时间线 → kill+open 换代 → 注入）。
    this.#breathCycle = new BreathCycle<{ letter: SealedLetter | null }>({
      registry: this.#sessions,
      appendLetter: (letter) => {
        this.#letters.append(letter);
      },
      // 信注入新代上下文；启动包的「醒来即已读」从信时间线读原件（bootPack），
      // 两处同一份 SealedLetter，不转抄。
      injectLetter: (_context, letter) => ({ letter }),
      notify: () => {
        // 对人可见的通知口（MV-D09）归宿主层；日志是 RT-06 扫描面，这里不落文本。
      },
      flowOf: (window) => this.#flowOfGeneration(window.residentId, window.generation),
      now: () => new Date().toISOString(),
    });
    this.#windowIndexPath = join(dataDir, "sessions", "window-index.json");
    const restoredIndex = this.#readWindowIndex();
    this.#windowIndex = restoredIndex.windows;
    this.#publicWindowIndex = restoredIndex.publicWindows;
  }

  // —— 通道（D25） ——

  resolveChannelRoute(input: { channel: ChannelSpecLike }): Result<ChannelRouteLike> {
    try {
      return ok(resolveChannelRoute(input.channel));
    } catch (error) {
      return specFailure(error, null);
    }
  }

  provisionChannel(input: {
    residentId: string;
    channel: ChannelSpecLike;
    canarySecret: string;
  }): Result<ProvisionedChannel> {
    let route: ChannelRouteLike;
    try {
      route = resolveChannelRoute(input.channel);
    } catch (error) {
      return specFailure(error, input.residentId);
    }
    if (!this.#residents.has(input.residentId)) {
      // 入住流程（#182）没接之前，配通道即建档：身份先以住户号为名，
      // 换真名是入住单的事，不在这儿编。
      this.#residents.createResident(input.residentId, { residentId: input.residentId });
    }
    const record = this.#credentials.provision({
      residentId: input.residentId,
      channel: input.channel,
      secret: input.canarySecret,
    });
    return ok({
      adapterId: route.adapterId,
      credentialKind: route.credentialKind,
      model: route.model,
      credentialRef: record.credentialRef,
    });
  }

  revokeCredential(input: { residentId: string }): void {
    this.#credentials.revoke(input.residentId);
  }

  // —— 对话往返（RT-01 / RT-02 的循环本体） ——

  /**
   * 同一住户的回合串行入口（验收席意见 2）：「读上下文 → 调模型 → user/assistant
   * 落账」全程占坑，后一个 say() 排队等前一回合落完账——回合不许拆散交错。
   */
  say(input: SayInput): Promise<Result<TurnResult>> {
    return this.#enqueue(input.residentId, () => this.#runTurn(input));
  }

  #enqueue<T>(residentId: string, task: () => Promise<T>): Promise<T> {
    const prior = this.#turnQueues.get(residentId) ?? Promise.resolve();
    const run = prior.then(task);
    this.#turnQueues.set(
      residentId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  async #runTurn(input: SayInput): Promise<Result<TurnResult>> {
    if (input.text.trim().length === 0) {
      // runtime 层自己拦（评审意见 4）：IPC 层的形状检查不是实现的防线。
      // 归 channel-unavailable 是沿用本层先例（specFailure 也把输入不合法归这码）——
      // 契约的错误码枚举是判卷资产，不为单个校验加码。
      return fail(
        "channel-unavailable",
        "消息文本不许为空",
        "把要说的话写进 text 再发——空消息不是合法往返",
        input.residentId,
      );
    }
    const requestedTurnId = input.turnId;
    const turnId = requestedTurnId ?? randomUUID();
    if (requestedTurnId !== undefined) {
      // 回执先行（验收席意见 3）：同一 turnId 的回合若已完成，直接返回已记录结果，
      // 模型不再被调用第二次——重试的正确姿势是幂等读，不是再生成一遍然后撞
      // 幂等冲突。回合没完成（user 已落、assistant 没落的半截）则同锚续跑，
      // user 腿经幂等去重不写重。
      const state = this.#turnState(input.residentId, requestedTurnId, input.text);
      if (state.kind === "complete") return ok(state.result);
      if (state.kind === "mismatch") {
        // fail-closed（协助审查 1 / 验收席 5312646838）：turnId 复用于不同文本本来
        // 就是调用方 bug，静默换锚会让重试越走越偏（每次重试都新开一回合、写重复
        // 内容）。独立错误码机器可分于通道故障——不调模型、不落账，重复提交同一
        // 冲突永远得到同一个结构化失败。
        return fail(
          "turn-id-conflict",
          `turnId 已被另一条文本占用：${requestedTurnId}`,
          "这个 turnId 记着别的文本——新消息换一个新 turnId 重发；若这是同一回合的重试，把原文照抄带回来",
          input.residentId,
        );
      }
    }
    const credential = this.#credentials.find(input.residentId);
    if (credential === null) {
      return fail(
        "credential-missing",
        `住户 ${input.residentId} 从未配过通道凭证`,
        "先为该住户配一条通道凭证（安装器 npm run setup，或 provisionChannel），再回来对话",
        input.residentId,
      );
    }
    if (credential.status !== "ready") {
      return fail(
        "credential-invalid",
        `住户 ${input.residentId} 的凭证已失效（${credential.status}）`,
        "凭证已过期或被吊销：重新配一条有效凭证（provisionChannel / npm run setup）后重试",
        input.residentId,
      );
    }
    if (!this.#residents.has(input.residentId)) {
      return fail(
        "resident-not-found",
        `住户不存在：${input.residentId}`,
        "先在安装器里创建这位住户（createResident / npm run setup），再开始对话",
        input.residentId,
      );
    }
    // 窗提前解析并占住本代回合位（D8 一）：回合起了，窗就无权给自己改触发线。
    let window: { windowId: string; generation: number };
    try {
      window = this.#windowFor(input.residentId);
    } catch (error) {
      return fail(
        "channel-unavailable",
        `窗开工失败：${(error as Error).message}`,
        "检查窗身份与代际账（sessions/windows.journal）是否完好，修复后重试",
        input.residentId,
      );
    }
    this.#turnStarted.add(`${window.windowId}#${window.generation}`);

    // 醒来读启动包：身份、承诺、记忆、现行有效事实**整包**随请求进模型（D8 补记三：
    // 醒来即已读；验收席意见 1：记忆与事实不许中途掉队）。
    let bootPack: ReturnType<typeof buildBootPack>;
    try {
      let currentFacts: ReturnType<FactLedger["currentSet"]> | undefined;
      if (this.#factLedger !== undefined) {
        try {
          currentFacts = this.#factLedger.currentSet(input.residentId);
        } catch (error) {
          if (!(error instanceof LedgerNotFoundError)) throw error;
          // 账接了但这户没开户：对这户仍是「没接账」——currentFacts 缺席即缺席，
          // 不许跟「账是空的」（空数组）编码成同一个值（MV-A05）。
        }
      }
      bootPack = buildBootPack(
        this.#residents,
        input.residentId,
        currentFacts === undefined ? {} : { currentFacts },
      );
    } catch (error) {
      return fail(
        "resident-not-found",
        `启动包装配失败：${(error as Error).message}`,
        "检查住户档案是否完整（residents/ 快照），损坏就从迁移包恢复",
        input.residentId,
      );
    }
    const route = resolveChannelRoute({
      claudeSubscription: credential.claudeSubscription,
      credentialKind: credential.credentialKind,
      model: credential.model,
    });
    // 当前一窗流上下文随请求进模型（验收席意见 1）：本代此前回合的 user/assistant
    // 消息按流序送进模型，第二轮起不是失忆的单轮调用。按**代界**划定（D8 三）：
    // 猝死那代的原始流水不自动进继任者上下文，接续靠交接信 + 归档查询。
    const history = this.#streamHistory(input.residentId, window.generation);
    // 密钥原文只在这一刻解析、只进传输层；此后任何地方都不许再出现（RT-06）。
    // find 与 readSecret 之间的 revoke 窗口（验收席观察 A）也落成结构化失败，
    // 不许异常冲出 say()。
    let credentialSecret: string;
    try {
      credentialSecret = this.#credentials.readSecret(credential.credentialRef);
    } catch (error) {
      return fail(
        "credential-invalid",
        `凭证原文读不出（可能刚被吊销或密钥文件损坏）：${(error as Error).message}`,
        "重新配一条有效凭证（provisionChannel / npm run setup）后重试",
        input.residentId,
      );
    }

    let reply = "";
    let chunks = 0;
    try {
      for await (const chunk of this.#transport.complete({
        residentId: input.residentId,
        adapterId: route.adapterId,
        model: route.model,
        text: input.text,
        bootPack,
        history,
        credentialSecret,
      })) {
        reply += chunk;
        chunks += 1;
        input.onChunk?.(chunk);
      }
    } catch (error) {
      // 通道跑不起来：不落账、不伪造回复（RT-01 失败分支）。
      return fail(
        "channel-unavailable",
        `模型通道不可用：${(error as Error).message}`,
        "检查通道适配器是否安装（pi install pi-ai / pi-claude-bridge）或凭证是否有效，修复后重试",
        input.residentId,
      );
    }
    if (reply.trim().length === 0) {
      return fail(
        "channel-unavailable",
        "模型通道返回了空回复",
        "上游没有产出任何内容：检查通道与模型配置，修复后重试",
        input.residentId,
      );
    }

    // 往返成功才落账：user → assistant 依次经唯一 writer 进一窗流（D9）。
    if (!this.#streams.has(input.residentId)) {
      this.#streams.createStream(input.residentId);
    }
    try {
      await this.#writer.submit({
        residentId: input.residentId,
        // 幂等键由 turnId 派生、草稿确定性（occurredAt 是哨兵）：同回合重试 = 同把手
        // + 同请求 hash，底座去重返回原回执，不写重复（评审意见 1）。
        idempotencyKey: `say-user-${turnId}`,
        draft: messageDraft({
          residentId: input.residentId,
          windowId: window.windowId,
          generation: window.generation,
          role: "user",
          text: input.text,
          turnId,
        }),
      });
      await this.#writer.submit({
        residentId: input.residentId,
        idempotencyKey: `say-assistant-${turnId}`,
        draft: messageDraft({
          residentId: input.residentId,
          windowId: window.windowId,
          generation: window.generation,
          role: "assistant",
          text: reply,
          turnId,
          streamed: chunks >= 2,
          model: route.model,
        }),
      });
    } catch (error) {
      return fail(
        "writer-unavailable",
        `一窗流落账失败：${(error as Error).message}`,
        "唯一 writer 不可用：确认宿主进程存活、落盘目录可写，然后带**同一个 turnId** 重试这句话（幂等补写，不写重）",
        input.residentId,
      );
    }
    // 到线换气（D8 一）：本回合落账后按累积 token 判线，到线就亲笔写信换代。
    // 累积按 estimateTokens（handover-letter 的保守估算，同尺子量到底）。
    const config = this.#breathState.update(input.residentId, (state) => {
      state.accumulated += estimateTokens(input.text);
    });
    if (config.accumulated >= config.current) {
      // 直呼内芯：#runTurn 本身就在住户级串行域里，再排队会自锁。
      const breathed = await this.#breatheNow({ residentId: input.residentId, via: "new" });
      if (!breathed.ok) {
        // 回合已完整落账，但到线没换成代——如实报换气的结构化失败，不粉饰。
        return fail(
          breathed.error.code,
          `回合到线但换气失败：${breathed.error.message}`,
          breathed.error.remedy,
          input.residentId,
        );
      }
    }
    return ok({
      residentId: input.residentId,
      model: route.model,
      generation: window.generation,
      reply,
      streamed: chunks >= 2,
    });
  }

  // —— 一窗流只读 ——

  readStream(input: { residentId: string }): Result<StreamSnapshot> {
    try {
      const events = this.#streams.eventsAfter(input.residentId, 0).map(toStreamEventView);
      return ok({ residentId: input.residentId, events });
    } catch (error) {
      if (error instanceof StreamNotFoundError) {
        return fail(
          "stream-not-found",
          `这位住户还没有一窗流：${input.residentId}`,
          "还没说过话就没有流——说第一句话就会开流，不用手动建",
          input.residentId,
        );
      }
      throw error;
    }
  }

  streamFiles(): Result<StreamFileInventory> {
    const files = readdirSync(this.#streamsDir)
      .filter((file) => file.endsWith(".stream.json"))
      .sort()
      .map((file) => join(this.#streamsDir, file));
    return ok({ files });
  }

  // —— 启动包（RT-07：装配器唯一，调用次数不限） ——

  bootPack(input: { residentId: string }): Result<BootPackView> {
    if (!this.#residents.has(input.residentId)) {
      return fail(
        "resident-not-found",
        `住户不存在：${input.residentId}`,
        "先创建这位住户（createResident / npm run setup），醒来才有包可读",
        input.residentId,
      );
    }
    const pack = buildBootPack(this.#residents, input.residentId);
    let latestLetter: SealedLetter | null;
    try {
      latestLetter = this.#letters.latest(input.residentId);
    } catch (error) {
      // 信档损坏 fail-closed（协助审查）：宁可启动包读不出，也不静默回退旧信。
      return fail(
        "letter-invalid",
        `交接信读不出：${(error as Error).message}`,
        "信档损坏不许静默降级——修复 letters/ 里的信档后再读启动包",
        input.residentId,
      );
    }
    return ok({
      residentId: pack.residentId,
      identity: pack.identity,
      commitments: [...pack.commitments],
      memories: pack.memories.map(toMemoryEntryView),
      // 交接信随换代产生（D8）。没换过代 = 没有信，契约里就是 null——
      // 不拿空信占位（「没有」与「有封空的」不许塌成同一个值）。注入的是
      // 时间线里的原件（副本等价性 letterShape 同形），不是转抄。
      letter: latestLetter === null ? null : toLetterView(latestLetter),
    });
  }

  // —— 换气与交接信（RT-03 / D8） ——

  setBreathThreshold(input: {
    residentId: string;
    windowId: string;
    generation: number;
    thresholdTokens: number;
    authority: "window" | "owner";
  }): Result<void> {
    if (!this.#residents.has(input.residentId)) {
      return fail(
        "resident-not-found",
        `住户不存在：${input.residentId}`,
        "先创建这位住户（createResident / npm run setup），再设触发线",
        input.residentId,
      );
    }
    let window: { windowId: string; generation: number };
    try {
      window = this.#windowFor(input.residentId);
    } catch (error) {
      return fail(
        "breath-refused",
        `窗开工失败：${(error as Error).message}`,
        "检查窗身份与代际账（sessions/windows.journal）是否完好，修复后重试",
        input.residentId,
      );
    }
    // 调用方指定的窗身份（住户号同款「指定事实」纪律）：**校验全过之后**才认领
    // 落盘（协助审查尾巴）——失败的调用不许把窗号钉死，重启都清不掉。
    if (!Number.isFinite(input.thresholdTokens) || input.thresholdTokens < 1) {
      return fail(
        "breath-refused",
        `触发线不合法：${input.thresholdTokens}`,
        "触发线是 ≥1 的 token 数（MAX_SAFE_INTEGER 表示不自动换气）",
        input.residentId,
      );
    }
    const isOwner = input.authority === "owner";
    if (!isOwner) {
      // 窗改自己的线：钉住开工的那一代，且只能在本代还没有回合时。回合起了再改
      // 就是给自己续命。
      if (input.generation !== window.generation) {
        return fail(
          "breath-refused",
          `代际对不上：当前是第 ${window.generation} 代，不是第 ${input.generation} 代`,
          "窗只能钉住开工的那一代设线；按当前代际重发，或找主人（authority: owner）改配置",
          input.residentId,
        );
      }
      if (this.#turnStarted.has(`${window.windowId}#${window.generation}`)) {
        return fail(
          "breath-refused",
          "回合已起，窗无权给自己改触发线",
          "D8：临近红线的窗无权给自己续命——要调线找主人（authority: owner），从下一代生效",
          input.residentId,
        );
      }
    }
    const knownPublic = this.#publicWindowIndex[input.residentId];
    if (knownPublic === undefined) {
      this.#publicWindowIndex = { ...this.#publicWindowIndex, [input.residentId]: input.windowId };
      this.#saveWindowIndex();
    } else if (knownPublic !== input.windowId) {
      return fail(
        "breath-refused",
        `窗身份对不上：这位住户的窗是 ${knownPublic}，不是 ${input.windowId}`,
        "一位住户一扇窗；给对的 windowId，或为新住户另开流程",
        input.residentId,
      );
    }
    if (isOwner) {
      // 主人改成员配置：任何时刻允许（协助审查：主人拿着稍旧代际也照收，
      // generation 参数只是调用方的账面），但从下一代生效——不给当前这一代续命。
      this.#breathState.update(input.residentId, (config) => {
        config.pending = input.thresholdTokens;
      });
      return ok(undefined);
    }
    this.#breathState.update(input.residentId, (config) => {
      config.current = input.thresholdTokens;
    });
    return ok(undefined);
  }

  /** 走 D8 的统一流程：亲笔写信 → 换代重生。三个入口（via: new/clear/compact）同义同流程。
   * 与 say() 共用住户级串行域（协助审查）：换代不许插进回合中途。 */
  breathe(input: { residentId: string; via: BreathTrigger }): Promise<Result<BreatheOutcome>> {
    return this.#enqueue(input.residentId, () => this.#breatheNow(input));
  }

  /** 换代内芯：只在住户级串行域里跑（公开 breathe 排队进；say 的到线换气直呼，已在域内）。 */
  async #breatheNow(input: {
    residentId: string;
    via: BreathTrigger;
  }): Promise<Result<BreatheOutcome>> {
    if (!this.#residents.has(input.residentId)) {
      return fail(
        "resident-not-found",
        `住户不存在：${input.residentId}`,
        "先创建这位住户（createResident / npm run setup），再换气",
        input.residentId,
      );
    }
    let window: { windowId: string; generation: number };
    try {
      window = this.#windowFor(input.residentId);
    } catch (error) {
      return fail(
        "breath-refused",
        `窗开工失败：${(error as Error).message}`,
        "检查窗身份与代际账（sessions/windows.journal）是否完好，修复后重试",
        input.residentId,
      );
    }
    const fromGeneration = window.generation;
    const draft = this.#composeLetterDraft(input.residentId, window);
    try {
      const breathed = await this.#breathCycle.breathe(window.windowId, draft);
      // 换代收尾：主人的待定线从下一代生效，累积清零。
      this.#breathState.advanceGeneration(input.residentId);
      return ok({
        fromGeneration,
        toGeneration: breathed.window.generation,
        // 换气前后逐字不变（MV-D10 同族）：对外窗号是调用方认下的那份身份。
        windowId: this.#publicWindowIndex[input.residentId] ?? window.windowId,
        letter: toLetterView(breathed.letter),
      });
    } catch (error) {
      if (error instanceof LetterSchemaError) {
        return fail(
          "letter-invalid",
          `交接信不合模板：${error.message}`,
          "信要有非空标题、条目 tier ∈ commitment/fact/judgment、全信不超长度上限；改好草稿再换气",
          input.residentId,
        );
      }
      return fail(
        "breath-refused",
        `换气被拒：${(error as Error).message}`,
        "换气失败则窗未换代（失败不改史）：按错误信息修数据面后重试",
        input.residentId,
      );
    }
  }

  letterTimeline(input: { residentId: string }): Result<LetterTimeline> {
    if (!this.#residents.has(input.residentId)) {
      return fail(
        "resident-not-found",
        `住户不存在：${input.residentId}`,
        "先创建这位住户（createResident / npm run setup），时间线才有主",
        input.residentId,
      );
    }
    try {
      return ok(toLetterTimeline(input.residentId, this.#letters.timeline(input.residentId)));
    } catch (error) {
      return fail(
        "letter-invalid",
        `交接信时间线读不出：${(error as Error).message}`,
        "信档损坏不许静默降级——修复 letters/ 里的信档后再读时间线",
        input.residentId,
      );
    }
  }

  /** 猝死：没来得及写信就杀（D8 三）。继任者下次 say 同窗接代，原始流水归档可查。
   * 与 say()/breathe() 同一串行域：换代动作不插进回合中途。 */
  suddenDeath(input: { residentId: string }): Promise<void> {
    return this.#enqueue(input.residentId, async () => {
      this.#suddenDeathNow(input);
    });
  }

  #suddenDeathNow(input: { residentId: string }): void {
    const knownId = this.#windows.get(input.residentId) ?? this.#windowIndex[input.residentId];
    if (knownId !== undefined) {
      try {
        this.#sessions.kill(knownId);
      } catch {
        // 已停的窗再杀一次不算事故——猝死的语义就是「没有第二次机会」。
      }
      this.#windows.delete(input.residentId);
    }
    // 继任者接代：主人的待定线同样从下一代生效。
    this.#breathState.advanceGeneration(input.residentId);
  }

  /** 按 (residentId, generation) 读某一代的原始流水归档；查不到就 fail-closed，不拿空快照冒充。 */
  archivedTranscript(input: {
    residentId: string;
    generation: number;
  }): Result<StreamSnapshot> {
    if (!this.#streams.has(input.residentId)) {
      return fail(
        "stream-not-found",
        `这位住户还没有一窗流：${input.residentId}`,
        "先有回合落账（say）再查归档",
        input.residentId,
      );
    }
    const events = this.#streams
      .eventsAfter(input.residentId, 0)
      .filter((event) => event.origin.viewport?.generation === input.generation)
      .map(toStreamEventView);
    if (events.length === 0) {
      return fail(
        "stream-not-found",
        `第 ${input.generation} 代查不到原始流水`,
        "查不到就报查不到——不拿空快照冒充「这代没有流水」；核对代际号后重查",
        input.residentId,
      );
    }
    return ok({ residentId: input.residentId, events });
  }

  // —— 换气的内部件 ——

  /** 本代流水的原始形状序列（BreathCycle 卫生检查数据源：消息树节点形状，
   * 允许残骸与畸形混入，检查就是为它俩设的——content 原样给，坏内容会被
   * 卫生检查硬拦，正好是「把必炸的尸体封进归档」要防的事）。 */
  #flowOfGeneration(residentId: string, generation: number): unknown[] {
    if (!this.#streams.has(residentId)) return [];
    const nodes: unknown[] = [];
    let previousId: string | null = null;
    for (const event of this.#streams.eventsAfter(residentId, 0)) {
      if (event.origin.viewport?.generation !== generation) continue;
      const role = event.payload.role;
      nodes.push({
        id: event.eventId,
        role,
        // 回复挂在上一条上；user 腿是根。半截回合（只有 user 腿）就是残骸形状，
        // 卫生检查按残骸记档、不楔死换气。
        parentId: role === "assistant" ? previousId : null,
        content: event.payload.text,
        createdAt: event.occurredAt,
      });
      previousId = event.eventId;
    }
    return nodes;
  }

  /** 亲笔信草稿从这**一**代自己的状态装配（D8 当刻亲笔；判卷判结构不判内容）。 */
  #composeLetterDraft(
    residentId: string,
    window: { windowId: string; generation: number },
  ): ReturnType<typeof composeLetterDraft> {
    const pack = buildBootPack(this.#residents, residentId);
    return composeLetterDraft({
      residentId,
      generation: window.generation,
      commitments: pack.commitments,
      memories: pack.memories.map((entry) => entry.content),
      streamEvents: this.#flowOfGeneration(residentId, window.generation).length,
    });
  }

  // —— 凭证扫描（RT-06） ——

  secretScan(input: { residentId: string; needle: string }): Result<SecretScanReport> {
    const surfaces: ReadonlyArray<{ surface: string; files: readonly string[] }> = [
      { surface: "stream", files: this.#filesUnder(this.#streamsDir, input.residentId) },
      { surface: "bootpack", files: this.#filesUnder(this.#residentsDir, input.residentId) },
      { surface: "letter", files: this.#filesUnder(this.#lettersDir, input.residentId) },
      { surface: "log", files: this.#filesUnder(this.#logsDir, null) },
    ];
    const hits: SecretHit[] = [];
    for (const { surface, files } of surfaces) {
      for (const file of files) {
        let content: string;
        try {
          content = readFileSync(file, "utf8");
        } catch (error) {
          if (isMissingFile(error)) continue;
          throw error;
        }
        if (content.includes(input.needle)) hits.push({ surface, needle: input.needle });
      }
    }
    return ok({ hits });
  }

  // —— 回执与上下文（验收席意见 1 / 3） ——

  /** 本代一窗流历史：此前回合的 user/assistant 消息按流序，随请求进模型。
   * 按代界划定（D8 三）：猝死那代的原始流水不自动进继任者上下文，接续靠
   * 交接信 + 归档查询——「不自动进、但可查」两面都要成立。
   * 与 readStream 同一 fail-closed 口径（协助审查 3）：共用 toStreamEventView，
   * 读不懂的事件宁死不屈、不静默跳过——不给模型喂残缺上下文。代价（协助审查
   * 观察）：一条坏事件会毒死该住户后续回合；修复路径是错误信息里的 eventId
   * 定位坏事件，由宿主运维裁定修数据后重启（流 append-only，常规手段不改史）。
   * 全流扫一遍是 O(n)/回合；回合多了再按 turnId 建索引（协助审查 5，不阻塞）。 */
  #streamHistory(
    residentId: string,
    generation: number,
  ): { role: "user" | "assistant"; text: string }[] {
    if (!this.#streams.has(residentId)) return [];
    return this.#streams
      .eventsAfter(residentId, 0)
      .filter((event) => event.origin.viewport?.generation === generation)
      .map(toStreamEventView)
      .map((view) => ({ role: view.kind, text: view.text }));
  }

  /**
   * 回执查询（验收席意见 3）：turnId 在一窗流里的落账状态。
   * complete = user/assistant 两腿都落了、且 user 文本就是这句话 → 已记录结果可回放；
   * mismatch = 锚被另一条文本占用 → fail-closed 报锚冲突（协助审查 1），不悄悄开新回合；
   * open = 还没落账（含「user 落了、assistant 没落」的半截——同文本重试续跑补齐，
   * 不同文本的重试被锚冲突拒绝，不再留新孤儿，协助审查 4）。
   */
  #turnState(
    residentId: string,
    turnId: string,
    text: string,
  ): { kind: "complete"; result: TurnResult } | { kind: "mismatch" } | { kind: "open" } {
    if (!this.#streams.has(residentId)) return { kind: "open" };
    let userText: string | null = null;
    let assistant: { text: string; model: string; streamed: boolean; generation: number } | null =
      null;
    for (const event of this.#streams.eventsAfter(residentId, 0)) {
      const payload = event.payload;
      if (payload.turnId !== turnId) continue;
      if (payload.role === "user" && typeof payload.text === "string") {
        userText = payload.text;
      }
      if (payload.role === "assistant" && typeof payload.text === "string") {
        assistant = {
          text: payload.text,
          model: typeof payload.model === "string" ? payload.model : "unknown",
          streamed: payload.streamed === true,
          generation: event.origin.viewport?.generation ?? 0,
        };
      }
    }
    if (assistant !== null && userText === text) {
      return {
        kind: "complete",
        result: {
          residentId,
          model: assistant.model,
          generation: assistant.generation,
          reply: assistant.text,
          streamed: assistant.streamed,
        },
      };
    }
    if (userText !== null && userText !== text) return { kind: "mismatch" };
    return { kind: "open" };
  }

  async close(): Promise<void> {
    await this.#writer.close();
  }

  // —— 窗口与代际（SessionRegistry 是代际真源） ——

  #windowFor(residentId: string): { windowId: string; generation: number } {
    const cachedId = this.#windows.get(residentId);
    if (cachedId !== undefined) {
      const active = this.#activeWindow(cachedId);
      if (active !== null) return { windowId: active.windowId, generation: active.generation };
      this.#windows.delete(residentId);
    }
    const knownId = this.#windowIndex[residentId];
    // 新代醒来信已在上下文里（MV-D04）：注入的是信时间线里的原件，不是转抄。
    const wakeContext = { letter: this.#letters.latest(residentId) };
    if (knownId !== undefined) {
      try {
        // 同一 windowId 重开 = 新一代（宿主硬杀即猝死，继任者接代，D8 三）。
        const reopened = this.#sessions.open(residentId, {
          context: wakeContext,
          windowId: knownId,
        });
        this.#windows.set(residentId, reopened.windowId);
        return { windowId: reopened.windowId, generation: reopened.generation };
      } catch (error) {
        if (!(error instanceof WindowReopenError)) throw error;
        // 记录在册但开不出来（身份不符等）：fail-closed 不硬套，开新窗留痕在索引里换号。
      }
    }
    const opened = this.#sessions.open(residentId, { context: wakeContext });
    this.#windows.set(residentId, opened.windowId);
    this.#windowIndex = { ...this.#windowIndex, [residentId]: opened.windowId };
    this.#saveWindowIndex();
    return { windowId: opened.windowId, generation: opened.generation };
  }

  /** 活窗拿得到就拿，拿不到（被杀 / 被归档 / 未开过）返回 null——不在这层伪造活窗。 */
  #activeWindow(windowId: string): { windowId: string; generation: number } | null {
    const window = this.#activeWindowOrNull(windowId);
    return window === null ? null : { windowId: window.windowId, generation: window.generation };
  }

  #activeWindowOrNull(windowId: string): { windowId: string; generation: number } | null {
    try {
      const window = this.#sessions.get(windowId);
      if (window === undefined) return null;
      return { windowId: window.windowId, generation: window.generation };
    } catch {
      return null;
    }
  }

  #readWindowIndex(): { windows: Record<string, string>; publicWindows: Record<string, string> } {
    try {
      const parsed = JSON.parse(readFileSync(this.#windowIndexPath, "utf8")) as WindowIndex;
      if (parsed.schemaVersion !== WINDOW_INDEX_SCHEMA || typeof parsed.windows !== "object") {
        throw new Error("window index has an unsupported shape");
      }
      return {
        windows: { ...parsed.windows },
        publicWindows: { ...(parsed.publicWindows ?? {}) },
      };
    } catch (error) {
      if (isMissingFile(error)) return { windows: {}, publicWindows: {} };
      throw error;
    }
  }

  #saveWindowIndex(): void {
    const index: WindowIndex = {
      schemaVersion: WINDOW_INDEX_SCHEMA,
      windows: { ...this.#windowIndex },
      publicWindows: { ...this.#publicWindowIndex },
    };
    mkdirSync(dirname(this.#windowIndexPath), { recursive: true });
    writeFileSync(this.#windowIndexPath, JSON.stringify(index));
  }

  #filesUnder(root: string, residentId: string | null): string[] {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
    return (
      entries
        // 按户界匹配（评审意见 4）：r-a 的扫描面不含 r-ab 的文件——裸前缀会串户。
        // 未来交接信文件名也必须带 `.` 边界（如 r-a.letter.md），否则会被漏扫。
        .filter(
          (file) => residentId === null || file === residentId || file.startsWith(`${residentId}.`),
        )
        .sort()
        .map((file) => join(root, file))
    );
  }
}

function specFailure<T>(error: unknown, residentId: string | null): Result<T> {
  const message = error instanceof ChannelSpecError ? error.message : String(error);
  return fail(
    "channel-unavailable",
    `通道规格不合法：${message}`,
    "claudeSubscription=true 只配 credentialKind=subscription（走 pi-claude-bridge）；其余配 api-key（走 pi-ai）",
    residentId,
  );
}

interface MessageDraftInput {
  readonly residentId: string;
  readonly windowId: string;
  readonly generation: number;
  readonly role: "user" | "assistant";
  readonly text: string;
  /** 回执锚（验收席意见 3）：让「这回合是否已落账」可查、可回放。 */
  readonly turnId: string;
  /** assistant 腿专有：回放「已记录结果」时照实说当时是不是流式。 */
  readonly streamed?: boolean;
  /** assistant 腿专有：回放时照实说当时走的哪个模型。 */
  readonly model?: string;
}

function messageDraft(input: MessageDraftInput): CanonicalEventDraft {
  const speaker: EventActor =
    input.role === "user"
      ? { kind: "viewport", id: input.windowId }
      : { kind: "resident", id: input.residentId };
  // 回执字段（验收席意见 3）：turnId 让「这回合是否已落账」可查；assistant 腿再带
  // streamed/model，重试回放的是已记录事实，不编造没发生过的值。
  const payload: JsonObject = {
    role: input.role,
    text: input.text,
    turnId: input.turnId,
    ...(input.role === "assistant"
      ? { streamed: input.streamed === true, model: input.model ?? "unknown" }
      : {}),
  };
  return {
    purpose: "message",
    // occurredAt 是哨兵（同 window-host 的 WINDOW_EVENT_OCCURRED_AT）：它进底座的请求
    // hash，挂钟时间会让同一 turnId 的重试算出不同 hash、被判 idempotency-conflict。
    // 排序与「多新」的权威是 streamSeq；这个字段不许当时间读（读到 1970 是预期）。
    occurredAt: WINDOW_EVENT_OCCURRED_AT,
    workRef: null,
    authoritySource: speaker,
    origin: {
      reporter: speaker,
      subject: { kind: "resident", id: input.residentId },
      viewport: { windowId: input.windowId, generation: input.generation },
    },
    effect: { state: "not-applicable", requiresUserAction: false, retry: "not-applicable" },
    artifactRef: null,
    payload,
  };
}

function toStreamEventView(event: {
  eventId: string;
  streamSeq: number;
  payloadHash: string;
  payload: JsonObject;
}): StreamEventView {
  const role = event.payload.role;
  const text = event.payload.text;
  if ((role !== "user" && role !== "assistant") || typeof text !== "string") {
    // fail-closed（评审意见 4）：读到本层读不懂的事件就地抛错，不猜、不标 assistant——
    // 宁可读失败，不改写历史。
    throw new Error(`一窗流里有本层读不懂的事件：${event.eventId}（role=${JSON.stringify(role)}）`);
  }
  return {
    eventId: event.eventId,
    streamSeq: event.streamSeq,
    kind: role,
    text,
    payloadHash: event.payloadHash,
  };
}

function toMemoryEntryView(entry: {
  id: string;
  content: string;
  supersededBy: string | null;
}): MemoryEntryView {
  return { id: entry.id, content: entry.content, supersededBy: entry.supersededBy };
}

/** 供宿主进程 fail-closed 地归类「住户不存在」。 */
export { ResidentNotFoundError };
