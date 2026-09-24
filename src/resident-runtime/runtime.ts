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
  ChannelRoute,
  ChannelSpec,
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
import { SessionRegistry, WindowReopenError } from "../session/session-registry.ts";
import { ResidentNotFoundError, ResidentStore } from "../store/resident-store.ts";
import { openCanonicalStreamWriter } from "../window-host/window-history-host.ts";
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
}

export interface ResidentRuntimeOptions {
  readonly dataDir: string;
  /** 模型传输。缺省按 MIST_RESIDENT_RUNTIME_TRANSPORT 选（默认合成通道）。 */
  readonly transport?: ModelTransport;
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
  readonly #sessions: SessionRegistry<null>;
  readonly #credentials: CredentialStore;
  readonly #transport: ModelTransport;
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
    this.#sessions = new SessionRegistry<null>({
      archivePath: join(dataDir, "sessions", "windows.journal"),
    });
    this.#credentials = new CredentialStore(join(dataDir, "credentials"));
    this.#transport = options.transport ?? createModelTransport();
    this.#windowIndexPath = join(dataDir, "sessions", "window-index.json");
    this.#windowIndex = this.#readWindowIndex();
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

  async say(input: { residentId: string; text: string }): Promise<Result<TurnResult>> {
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

    // 醒来读启动包：身份与记忆随请求进模型（D8 补记三：醒来即已读）。
    let bootPack: ReturnType<typeof buildBootPack>;
    try {
      bootPack = buildBootPack(this.#residents, input.residentId);
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
    // 密钥原文只在这一刻解析、只进传输层；此后任何地方都不许再出现（RT-06）。
    const credentialSecret = this.#credentials.readSecret(credential.credentialRef);

    let reply = "";
    let chunks = 0;
    try {
      for await (const chunk of this.#transport.complete({
        residentId: input.residentId,
        model: route.model,
        text: input.text,
        bootPack: {
          residentId: bootPack.residentId,
          identity: bootPack.identity,
          commitments: bootPack.commitments,
        },
        credentialSecret,
      })) {
        reply += chunk;
        chunks += 1;
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
    const window = this.#windowFor(input.residentId);
    if (!this.#streams.has(input.residentId)) {
      this.#streams.createStream(input.residentId);
    }
    try {
      await this.#writer.submit({
        residentId: input.residentId,
        idempotencyKey: `say-user-${randomUUID()}`,
        draft: messageDraft({
          residentId: input.residentId,
          windowId: window.windowId,
          generation: window.generation,
          role: "user",
          text: input.text,
        }),
      });
      await this.#writer.submit({
        residentId: input.residentId,
        idempotencyKey: `say-assistant-${randomUUID()}`,
        draft: messageDraft({
          residentId: input.residentId,
          windowId: window.windowId,
          generation: window.generation,
          role: "assistant",
          text: reply,
        }),
      });
    } catch (error) {
      return fail(
        "writer-unavailable",
        `一窗流落账失败：${(error as Error).message}`,
        "唯一 writer 不可用：确认宿主进程存活、落盘目录可写，然后重试这句话",
        input.residentId,
      );
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
    return ok({
      residentId: pack.residentId,
      identity: pack.identity,
      commitments: [...pack.commitments],
      memories: pack.memories.map(toMemoryEntryView),
      // 交接信随换代产生（D8）。没换过代 = 没有信，契约里就是 null——
      // 不拿空信占位（「没有」与「有封空的」不许塌成同一个值）。
      letter: null,
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
    if (knownId !== undefined) {
      try {
        // 同一 windowId 重开 = 新一代（宿主硬杀即猝死，继任者接代，D8 三）。
        const reopened = this.#sessions.open(residentId, { context: null, windowId: knownId });
        this.#windows.set(residentId, reopened.windowId);
        return { windowId: reopened.windowId, generation: reopened.generation };
      } catch (error) {
        if (!(error instanceof WindowReopenError)) throw error;
        // 记录在册但开不出来（身份不符等）：fail-closed 不硬套，开新窗留痕在索引里换号。
      }
    }
    const opened = this.#sessions.open(residentId, { context: null });
    this.#windows.set(residentId, opened.windowId);
    this.#windowIndex = { ...this.#windowIndex, [residentId]: opened.windowId };
    const index: WindowIndex = {
      schemaVersion: WINDOW_INDEX_SCHEMA,
      windows: { ...this.#windowIndex },
    };
    mkdirSync(dirname(this.#windowIndexPath), { recursive: true });
    writeFileSync(this.#windowIndexPath, JSON.stringify(index));
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

  #readWindowIndex(): Record<string, string> {
    try {
      const parsed = JSON.parse(readFileSync(this.#windowIndexPath, "utf8")) as WindowIndex;
      if (parsed.schemaVersion !== WINDOW_INDEX_SCHEMA || typeof parsed.windows !== "object") {
        throw new Error("window index has an unsupported shape");
      }
      return { ...parsed.windows };
    } catch (error) {
      if (isMissingFile(error)) return {};
      throw error;
    }
  }

  #filesUnder(root: string, residentId: string | null): string[] {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }
    return entries
      .filter((file) => (residentId === null ? true : file.startsWith(`${residentId}`)))
      .sort()
      .map((file) => join(root, file));
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
}

function messageDraft(input: MessageDraftInput): CanonicalEventDraft {
  const speaker: EventActor =
    input.role === "user"
      ? { kind: "viewport", id: input.windowId }
      : { kind: "resident", id: input.residentId };
  const payload: JsonObject = { role: input.role, text: input.text };
  return {
    purpose: "message",
    occurredAt: new Date().toISOString(),
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
  return {
    eventId: event.eventId,
    streamSeq: event.streamSeq,
    kind: role === "user" ? "user" : "assistant",
    text: typeof text === "string" ? text : "",
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
