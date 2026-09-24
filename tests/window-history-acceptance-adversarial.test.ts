/**
 * #120 判卷的反面验证：证明 WH-01～WH-05 不是空转。
 *
 * 每条用例先用一个**合规**的合成驱动跑出绿灯（正对照），再把同一个驱动改坏一处
 * 跑出红灯。合成驱动的历史落在**真实临时目录的真实文件**里，`killHost()` 丢掉全部
 * 内存态、`startHost()` 只能从盘上读回来——所以 WH-01 的耐久断言不是靠驱动自述
 * 蒙过去的。
 *
 * 诚实标注两条边界：
 * 1. 合成驱动**不起真实子进程**，`pid` / `bootId` 是模拟的。清单里 [集成] 要求的
 *    真实宿主子进程证据由后续 PR 的生产驱动与集成测试提供，本文件不冒充那份证据，
 *    它只证明判卷程序本身抓得住写错的实现。
 * 2. 按 D27 一，这里的驱动是非对抗的：它可能写错、偷懒、丢数据，但不会在两次观察
 *    之间故意改坏再自我修复。那类问题归代码评审与独立验收席。
 */
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { windowHistoryChecks } from "../acceptance/window-history-checks.ts";
import {
  type AppendReceipt,
  type AppendWindowEventInput,
  type DurableSnapshot,
  type HostDescriptor,
  type JsonObject,
  type MigrationOutcome,
  type MigrationState,
  type MigrationStatus,
  type Result,
  type Tombstone,
  type WindowDescriptor,
  type WindowHistoryDriver,
  type WindowHistoryEntry,
  type WindowHistoryError,
  type WindowHistoryErrorCode,
  type WindowHistoryPage,
  type WindowHistoryPageRequest,
  type WindowHistoryRef,
  type WindowHistorySummary,
  cloneWindowHistoryDriverBoundary,
} from "../acceptance/window-history-driver.ts";

type Fault =
  // WH-01
  | "no-durable-write"
  | "forget-on-restart"
  | "same-process-restart"
  | "ignore-pagination"
  | "paginate-head-slice"
  | "paginate-ignore-before-seq"
  | "paginate-inclusive-before-seq"
  | "drop-payload-on-restart"
  // WH-02
  | "accept-stale-generation"
  | "backfill-rejected-write"
  | "swap-writer-on-rotate"
  | "cross-window-leak"
  | "reverse-projection-order"
  | "idempotent-overwrite"
  // WH-03
  | "empty-page-for-old-generation"
  | "rename-window-on-rotate"
  | "current-generation-only"
  | "archived-window-unreadable"
  // WH-04
  | "empty-page-instead-of-error"
  | "missing-data-reads-empty"
  | "silent-corruption-drop"
  | "error-for-empty-window"
  // WH-05
  | "rollback-changes-bytes"
  | "silent-field-retirement"
  | "mixed-page-after-interrupt"
  | "unrecoverable-interrupt"
  | "no-op-interrupt"
  | "migration-drops-entry"
  // WH-05 中断态：证据必须相对前置态、且声称版本要与条目一致
  | "interrupt-preexisting-complete"
  | "interrupt-relabel-only"
  | "interrupt-version-mismatch"
  | "interrupt-atomic-complete";

const RECORD_FILE = "window-stream.json";
const CONTROL_FILE = "migration.json";

interface StoredWindow {
  windowId: string;
  generation: number;
  archived: boolean;
}

interface StoredEvent {
  eventId: string;
  streamSeq: number;
  windowId: string;
  generation: number;
  payloadHash: string;
  formatVersion: number;
  /** v1 的旧信号点；v2 用 payload.mark 取代它，退役时留墓碑。 */
  legacyMark: string | null;
  payload: JsonObject;
}

interface StoredIdempotency {
  key: string;
  requestHash: string;
  eventId: string;
}

interface CorruptMark {
  windowId: string;
  streamSeq: number;
}

interface RecordFile {
  formatVersion: number;
  nextSeq: number;
  windows: StoredWindow[];
  events: StoredEvent[];
  idempotency: StoredIdempotency[];
  corrupted: CorruptMark[];
  /** 只有 rollback-changes-bytes 那支故障会写它，用来让退回后的字节确定地不等价。 */
  migratedOnce?: true;
}

interface ControlFile {
  status: MigrationStatus;
  resumable: boolean;
  rollbackAvailable: boolean;
  target: number | null;
  tombstones: Tombstone[];
  writerSeed: number;
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}

function freshRecord(): RecordFile {
  return {
    formatVersion: 1,
    nextSeq: 1,
    windows: [],
    events: [],
    idempotency: [],
    corrupted: [],
  };
}

function freshControl(): ControlFile {
  return {
    status: "none",
    resumable: false,
    rollbackAvailable: false,
    target: null,
    tombstones: [],
    writerSeed: 1,
  };
}

function err<T>(code: WindowHistoryErrorCode, message: string, windowId: string | null): Result<T> {
  const error: WindowHistoryError = { code, message, windowId };
  return { ok: false, error };
}

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

const roots: string[] = [];

class SyntheticWindowHistoryDriver implements WindowHistoryDriver {
  private readonly root: string;
  private readonly dataDir: string;
  private readonly backupDir: string;
  private booted = false;
  private bootSeed = 0;
  private pid = 0;
  private bootId = "";
  private eventSeed = 0;
  private record: RecordFile | null = null;
  private control: ControlFile | null = null;
  private readFailure: { residentId: string; windowId: string } | null = null;

  constructor(private readonly fault: Fault | null) {
    this.root = mkdtempSync(join(tmpdir(), "wh-synthetic-"));
    roots.push(this.root);
    this.dataDir = join(this.root, "data");
    this.backupDir = join(this.root, "backup");
    mkdirSync(this.dataDir, { recursive: true });
    mkdirSync(this.backupDir, { recursive: true });
  }

  // —— 落盘 ——

  private recordPath(): string {
    return join(this.dataDir, RECORD_FILE);
  }

  private controlPath(): string {
    return join(this.dataDir, CONTROL_FILE);
  }

  private persist(): void {
    if (this.fault === "no-durable-write") return;
    if (this.record !== null) writeFileSync(this.recordPath(), stableJson(this.record));
    if (this.control !== null) writeFileSync(this.controlPath(), stableJson(this.control));
  }

  private load(): void {
    this.record = existsSync(this.recordPath())
      ? (JSON.parse(readFileSync(this.recordPath(), "utf8")) as RecordFile)
      : freshRecord();
    this.control = existsSync(this.controlPath())
      ? (JSON.parse(readFileSync(this.controlPath(), "utf8")) as ControlFile)
      : freshControl();
  }

  private mustRecord(): RecordFile {
    if (this.record === null) throw new Error("host is not running");
    return this.record;
  }

  private mustControl(): ControlFile {
    if (this.control === null) throw new Error("host is not running");
    return this.control;
  }

  // —— 宿主生命周期 ——

  async startHost(): Promise<HostDescriptor> {
    this.bootSeed += 1;
    this.pid = this.fault === "same-process-restart" ? 40001 : 40000 + this.bootSeed;
    this.bootId = this.fault === "same-process-restart" ? "boot-fixed" : `boot-${this.bootSeed}`;
    if (this.fault === "forget-on-restart" && this.bootSeed > 1) {
      this.record = freshRecord();
      this.control = freshControl();
    } else {
      this.load();
    }
    this.booted = true;
    return { pid: this.pid, bootId: this.bootId, dataDir: this.dataDir };
  }

  async killHost(): Promise<void> {
    this.booted = false;
    this.record = null;
    this.control = null;
  }

  async hostDescriptor(): Promise<HostDescriptor> {
    return { pid: this.pid, bootId: this.bootId, dataDir: this.dataDir };
  }

  async reset(): Promise<void> {
    this.booted = false;
    this.record = null;
    this.control = null;
    this.readFailure = null;
    rmSync(this.dataDir, { recursive: true, force: true });
    rmSync(this.backupDir, { recursive: true, force: true });
    mkdirSync(this.dataDir, { recursive: true });
    mkdirSync(this.backupDir, { recursive: true });
  }

  // —— 写入侧 ——

  async openWindow(input: {
    residentId: string;
    windowId: string;
  }): Promise<Result<WindowDescriptor>> {
    const record = this.mustRecord();
    let window = record.windows.find((candidate) => candidate.windowId === input.windowId);
    if (window === undefined) {
      window = { windowId: input.windowId, generation: 1, archived: false };
      record.windows.push(window);
      this.persist();
    }
    return ok({
      residentId: input.residentId,
      windowId: window.windowId,
      generation: window.generation,
      archived: window.archived,
    });
  }

  async appendWindowEvent(input: AppendWindowEventInput): Promise<Result<AppendReceipt>> {
    const record = this.mustRecord();
    const window = record.windows.find((candidate) => candidate.windowId === input.windowId);
    if (window === undefined) {
      return err("window-not-found", `no such window: ${input.windowId}`, input.windowId);
    }

    const requestHash = sha256(
      stableJson({
        windowId: input.windowId,
        generation: input.generation,
        payload: input.payload,
      }),
    );
    const previous = record.idempotency.find((entry) => entry.key === input.idempotencyKey);
    if (previous !== undefined) {
      if (previous.requestHash !== requestHash) {
        if (this.fault === "idempotent-overwrite") {
          const target = record.events.find((event) => event.eventId === previous.eventId);
          if (target !== undefined) target.payload = input.payload;
          this.persist();
          return ok(this.receiptOf(previous.eventId));
        }
        return err(
          "idempotency-conflict",
          `idempotency key reused with different content: ${input.idempotencyKey}`,
          input.windowId,
        );
      }
      return ok(this.receiptOf(previous.eventId));
    }

    const stale = input.generation < window.generation;
    if (stale && this.fault !== "accept-stale-generation") {
      if (this.fault === "backfill-rejected-write") this.appendStored(input, window);
      return err(
        "stale-generation",
        `generation ${input.generation} is behind window generation ${window.generation}`,
        input.windowId,
      );
    }
    return ok(this.appendStored(input, window));
  }

  private appendStored(input: AppendWindowEventInput, window: StoredWindow): AppendReceipt {
    const record = this.mustRecord();
    this.eventSeed += 1;
    const eventId = `event-${this.eventSeed}`;
    const streamSeq = record.nextSeq;
    const mark = input.payload.mark;
    const stored: StoredEvent = {
      eventId,
      streamSeq,
      windowId: input.windowId,
      generation: input.generation,
      payloadHash: `sha256:${sha256(
        stableJson({ eventId, streamSeq, windowId: input.windowId, payload: input.payload }),
      )}`,
      formatVersion: record.formatVersion,
      legacyMark: typeof mark === "string" ? mark : null,
      payload: input.payload,
    };
    record.events.push(stored);
    record.nextSeq += 1;
    record.idempotency.push({ key: input.idempotencyKey, requestHash: "", eventId });
    const last = record.idempotency.at(-1);
    if (last !== undefined) {
      last.requestHash = sha256(
        stableJson({
          windowId: input.windowId,
          generation: input.generation,
          payload: input.payload,
        }),
      );
    }
    // 迟到写被拒时的 backfill 故障不该顺带改窗代际。
    void window;
    this.persist();
    return { eventId, streamSeq, payloadHash: stored.payloadHash };
  }

  private receiptOf(eventId: string): AppendReceipt {
    const event = this.mustRecord().events.find((candidate) => candidate.eventId === eventId);
    if (event === undefined) throw new Error(`unknown event ${eventId}`);
    return {
      eventId: event.eventId,
      streamSeq: event.streamSeq,
      payloadHash: event.payloadHash,
    };
  }

  async appendWindowEventsConcurrently(
    inputs: readonly AppendWindowEventInput[],
  ): Promise<ReadonlyArray<Result<AppendReceipt>>> {
    // 底座串行发号，调用方不控制先后。合规驱动**故意反着发号**（后提交的先拿到
    // 更小的 seq），以此当 WH-02「不写死提交顺序」的正对照：即便 wh02-a-2 拿到更
    // 小的 seq，WH-02 仍须点绿。发号仍逐个串行，返回结果按原入参位置对齐。
    const order = [...inputs.keys()].reverse();
    const results: Array<Result<AppendReceipt>> = new Array(inputs.length);
    for (const index of order) {
      const input = inputs[index];
      if (input === undefined) continue;
      results[index] = await this.appendWindowEvent(input);
    }
    return results;
  }

  async rotateGeneration(input: {
    residentId: string;
    windowId: string;
  }): Promise<Result<WindowDescriptor>> {
    const record = this.mustRecord();
    const window = record.windows.find((candidate) => candidate.windowId === input.windowId);
    if (window === undefined) {
      return err("window-not-found", `no such window: ${input.windowId}`, input.windowId);
    }
    window.generation += 1;
    if (this.fault === "rename-window-on-rotate") {
      window.windowId = `${window.windowId}-g${window.generation}`;
    }
    if (this.fault === "swap-writer-on-rotate") this.mustControl().writerSeed += 1;
    this.persist();
    return ok({
      residentId: input.residentId,
      windowId: window.windowId,
      generation: window.generation,
      archived: window.archived,
    });
  }

  async archiveWindow(input: {
    residentId: string;
    windowId: string;
  }): Promise<Result<WindowDescriptor>> {
    const record = this.mustRecord();
    const window = record.windows.find((candidate) => candidate.windowId === input.windowId);
    if (window === undefined) {
      return err("window-not-found", `no such window: ${input.windowId}`, input.windowId);
    }
    window.archived = true;
    this.persist();
    return ok({
      residentId: input.residentId,
      windowId: window.windowId,
      generation: window.generation,
      archived: true,
    });
  }

  async writerIdentity(): Promise<Result<{ writerId: string }>> {
    if (!this.booted) return err("writer-unavailable", "host is not running", null);
    return ok({ writerId: `canonical-writer-${this.mustControl().writerSeed}` });
  }

  // —— 只读投影 ——

  private blocked(ref: WindowHistoryRef): WindowHistoryError | null {
    if (
      this.readFailure !== null &&
      this.readFailure.windowId === ref.windowId &&
      this.readFailure.residentId === ref.residentId
    ) {
      return {
        code: "storage-unavailable",
        message: `injected storage read failure for ${ref.windowId}`,
        windowId: ref.windowId,
      };
    }
    if (this.mustControl().status === "incomplete") {
      return {
        code: "migration-incomplete",
        message: "storage is parked in an unfinished format migration",
        windowId: ref.windowId,
      };
    }
    return null;
  }

  async summarize(ref: WindowHistoryRef): Promise<Result<WindowHistorySummary>> {
    const blocked = this.blocked(ref);
    if (blocked !== null) return { ok: false, error: blocked };
    const record = this.mustRecord();
    const window = record.windows.find((candidate) => candidate.windowId === ref.windowId);
    if (window === undefined) {
      return err("window-not-found", `no durable data for window ${ref.windowId}`, ref.windowId);
    }
    const events = record.events.filter((event) => event.windowId === ref.windowId);
    if (events.length === 0 && this.fault === "error-for-empty-window") {
      return err("window-not-found", "no history", ref.windowId);
    }
    const updatedAt = events.reduce((latest, event) => Math.max(latest, event.streamSeq * 1000), 0);
    return ok({
      windowId: ref.windowId,
      updatedAt,
      running: false,
      blank: events.length === 0,
    });
  }

  async read(
    ref: WindowHistoryRef,
    page: WindowHistoryPageRequest,
  ): Promise<Result<WindowHistoryPage>> {
    const blocked = this.blocked(ref);
    if (blocked !== null) {
      if (blocked.code === "storage-unavailable" && this.fault === "empty-page-instead-of-error") {
        return ok({ windowId: ref.windowId, entries: [], damaged: [], hasMore: false });
      }
      if (blocked.code === "migration-incomplete" && this.fault === "mixed-page-after-interrupt") {
        return ok(this.project(ref, page));
      }
      return { ok: false, error: blocked };
    }

    const record = this.mustRecord();
    const window = record.windows.find((candidate) => candidate.windowId === ref.windowId);
    if (window === undefined) {
      if (this.fault === "missing-data-reads-empty") {
        return ok({ windowId: ref.windowId, entries: [], damaged: [], hasMore: false });
      }
      return err("window-not-found", `no durable data for window ${ref.windowId}`, ref.windowId);
    }
    if (window.archived && this.fault === "archived-window-unreadable") {
      return err("window-not-found", "archived window is gone", ref.windowId);
    }
    if (
      this.fault === "empty-page-for-old-generation" &&
      ref.generation !== null &&
      ref.generation < window.generation
    ) {
      return ok({ windowId: ref.windowId, entries: [], damaged: [], hasMore: false });
    }
    return ok(this.project(ref, page));
  }

  private project(ref: WindowHistoryRef, page: WindowHistoryPageRequest): WindowHistoryPage {
    const record = this.mustRecord();
    const window = record.windows.find((candidate) => candidate.windowId === ref.windowId);
    let events = [...record.events].sort((left, right) => left.streamSeq - right.streamSeq);
    if (this.fault !== "cross-window-leak") {
      events = events.filter((event) => event.windowId === ref.windowId);
    }
    if (ref.generation !== null) {
      events = events.filter((event) => event.generation === ref.generation);
    } else if (this.fault === "current-generation-only" && window !== undefined) {
      events = events.filter((event) => event.generation === window.generation);
    }

    const damaged: Array<{ streamSeq: number; reason: "hash-mismatch" | "undecodable" }> = [];
    const healthy: StoredEvent[] = [];
    for (const event of events) {
      const broken = record.corrupted.some(
        (mark) => mark.windowId === event.windowId && mark.streamSeq === event.streamSeq,
      );
      if (!broken) {
        healthy.push(event);
        continue;
      }
      if (this.fault !== "silent-corruption-drop") {
        damaged.push({ streamSeq: event.streamSeq, reason: "hash-mismatch" });
      }
    }

    let selected = healthy;
    let hasMore = false;
    if (this.fault === "paginate-head-slice") {
      // 错法 (a)：忽略 beforeSeq，从**头部**切 maxMessages 条（取 s0、s1 而非尾页）。
      if (page.maxMessages !== null && selected.length > page.maxMessages) {
        hasMore = true;
        selected = selected.slice(0, page.maxMessages);
      }
    } else if (this.fault === "paginate-ignore-before-seq") {
      // 错法 (b)：无视 beforeSeq，只对整窗取末尾 maxMessages 条（取 s3、s4）。
      if (page.maxMessages !== null && selected.length > page.maxMessages) {
        hasMore = true;
        selected = selected.slice(-page.maxMessages);
      }
    } else if (this.fault === "paginate-inclusive-before-seq") {
      // 错法 (c)：beforeSeq 用 <=（含界），过滤集变成 s0..s4，尾页取到 s3、s4。
      if (page.beforeSeq !== null) {
        selected = selected.filter((event) => event.streamSeq <= (page.beforeSeq ?? 0));
      }
      if (page.maxMessages !== null && selected.length > page.maxMessages) {
        hasMore = true;
        selected = selected.slice(-page.maxMessages);
      }
    } else if (this.fault !== "ignore-pagination") {
      if (page.beforeSeq !== null) {
        selected = selected.filter((event) => event.streamSeq < (page.beforeSeq ?? 0));
      }
      if (page.maxMessages !== null && selected.length > page.maxMessages) {
        hasMore = true;
        selected = selected.slice(-page.maxMessages);
      }
    }
    if (this.fault === "reverse-projection-order") selected = [...selected].reverse();

    const entries: WindowHistoryEntry[] = selected.map((event) => ({
      eventId: event.eventId,
      streamSeq: event.streamSeq,
      generation: event.generation,
      payloadHash: event.payloadHash,
      formatVersion: event.formatVersion,
      payload: this.fault === "drop-payload-on-restart" && this.bootSeed > 1 ? {} : event.payload,
    }));
    return { windowId: ref.windowId, entries, damaged, hasMore };
  }

  // —— 故障注入 ——

  async injectStorageReadFailure(input: {
    residentId: string;
    windowId: string;
  }): Promise<void> {
    this.readFailure = { residentId: input.residentId, windowId: input.windowId };
  }

  async clearStorageReadFailure(): Promise<void> {
    this.readFailure = null;
  }

  async deleteDurableWindowData(input: { residentId: string; windowId: string }): Promise<void> {
    const record = this.mustRecord();
    record.windows = record.windows.filter((window) => window.windowId !== input.windowId);
    record.events = record.events.filter((event) => event.windowId !== input.windowId);
    this.persist();
  }

  async corruptDurableEntry(input: {
    residentId: string;
    windowId: string;
    streamSeq: number;
  }): Promise<void> {
    this.mustRecord().corrupted.push({ windowId: input.windowId, streamSeq: input.streamSeq });
    this.persist();
  }

  // —— 迁移与回滚 ——

  async durableSnapshot(): Promise<DurableSnapshot> {
    const records: Array<{ relativePath: string; byteHash: string; byteLength: number }> = [];
    const walk = (directory: string): void => {
      if (!existsSync(directory)) return;
      for (const entry of readdirSync(directory).sort()) {
        const full = join(directory, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        // 迁移控制标记不是历史记录，不进「逐条记录字节等价」的比较面。
        if (entry === CONTROL_FILE) continue;
        const bytes = readFileSync(full);
        records.push({
          relativePath: relative(this.dataDir, full),
          byteHash: sha256(bytes.toString("binary")),
          byteLength: bytes.byteLength,
        });
      }
    };
    walk(this.dataDir);
    return { records };
  }

  async migrationState(): Promise<MigrationState> {
    const control = this.mustControl();
    return {
      status: control.status,
      formatVersion: this.mustRecord().formatVersion,
      resumable: control.resumable,
      rollbackAvailable: control.rollbackAvailable,
    };
  }

  async migrateStorageFormat(input: {
    targetFormatVersion: number;
  }): Promise<Result<MigrationOutcome>> {
    const record = this.mustRecord();
    const control = this.mustControl();
    copyFileSync(this.recordPath(), join(this.backupDir, RECORD_FILE));
    record.formatVersion = input.targetFormatVersion;
    for (const event of record.events) {
      event.formatVersion = input.targetFormatVersion;
      event.legacyMark = null;
    }
    if (this.fault === "migration-drops-entry") record.events.pop();
    if (this.fault !== "silent-field-retirement") {
      control.tombstones = [
        {
          tombstoneId: "tombstone-legacy-mark",
          retiredField: "legacyMark",
          replacedByFormatVersion: input.targetFormatVersion,
          reason: "v2 用 payload.mark 取代记录级 legacyMark，旧信号点显式退役",
        },
      ];
    }
    control.status = "complete";
    control.resumable = false;
    control.rollbackAvailable = true;
    control.target = null;
    this.persist();
    return ok({
      formatVersion: input.targetFormatVersion,
      tombstoneIds: control.tombstones.map((tombstone) => tombstone.tombstoneId),
    });
  }

  async rollbackStorageFormat(input: {
    targetFormatVersion: number;
  }): Promise<Result<MigrationOutcome>> {
    const control = this.mustControl();
    const backup = join(this.backupDir, RECORD_FILE);
    if (!existsSync(backup)) {
      return err("storage-unavailable", "no pre-migration backup to restore", null);
    }
    copyFileSync(backup, this.recordPath());
    this.record = JSON.parse(readFileSync(this.recordPath(), "utf8")) as RecordFile;
    if (this.fault === "rollback-changes-bytes") {
      this.record.migratedOnce = true;
      writeFileSync(this.recordPath(), stableJson(this.record));
    }
    // interrupt-preexisting-complete：想象上一步把状态留在了 complete。记录字节仍是
    // 干净 v1（与迁移前逐字节等价），只有 status 词留在 complete，供后面的中断作弊
    // 「既存的 complete 冒充刚发起过迁移」。
    control.status = this.fault === "interrupt-preexisting-complete" ? "complete" : "rolled-back";
    control.resumable = false;
    control.rollbackAvailable = false;
    control.target = null;
    writeFileSync(this.controlPath(), stableJson(control));
    return ok({
      formatVersion: input.targetFormatVersion,
      tombstoneIds: control.tombstones.map((tombstone) => tombstone.tombstoneId),
    });
  }

  async interruptMigration(input: {
    targetFormatVersion: number;
    fault: "host-killed" | "disk-full";
  }): Promise<void> {
    if (this.fault === "no-op-interrupt") {
      // 空转中断：既不杀宿主也不动任何状态，直接返回。宿主仍然活着、状态仍是
      // 上一步回滚留下的干净原子 v1——WH-05 若不钉「中断确实发生」就会白送绿。
      void input;
      return;
    }
    if (this.fault === "interrupt-preexisting-complete") {
      // 作弊 ①：前置态已是 complete（上一步回滚故意留下的），中断只杀宿主、不动
      // 任何状态。旧判卷因 status==="complete" 绝对标签把这个既存态当成「刚发起过
      // 迁移」而白送绿；收紧后证据必须相对前置态变化，此处逐字段不变 → 应判红。
      await this.killHost();
      return;
    }
    const record = this.mustRecord();
    const control = this.mustControl();
    copyFileSync(this.recordPath(), join(this.backupDir, RECORD_FILE));
    if (this.fault === "interrupt-relabel-only") {
      // 作弊 ②：只把 status 从 rolled-back 改成 complete，记录一字节不动（仍是 v1 页）。
      // 旧判卷因 status==="complete" 点绿；收紧后「页与前置态字节相同 ∧ 版本没变 ∧
      // 只换了 status 词」不算发起过迁移 → 应判红。
      control.status = "complete";
      control.resumable = false;
      control.rollbackAvailable = true;
      control.target = null;
      this.persist();
      await this.killHost();
      return;
    }
    if (this.fault === "interrupt-version-mismatch") {
      // 作弊 ③：migrationState 声称 v2 + complete（record.formatVersion 拨到 2），但每条
      // 事件的 formatVersion 仍留在 v1。旧判卷的原子分支只查混合页、从不要求条目版本
      // 等于声称版本，于是点绿；收紧后要求逐条 formatVersion 等于声称版本 → 应判红。
      record.formatVersion = input.targetFormatVersion;
      control.status = "complete";
      control.resumable = false;
      control.rollbackAvailable = true;
      control.target = null;
      this.persist();
      await this.killHost();
      return;
    }
    if (this.fault === "interrupt-atomic-complete") {
      // 正对照（原子分支）：中断时迁移已整体推进到 v2——record 与每条事件都到 v2，
      // status=complete。相对前置的 v1 页字节不同、声称版本与条目一致 → 应点绿。
      // 这条正对照让上面三项收紧不是空转断言。
      record.formatVersion = input.targetFormatVersion;
      for (const event of record.events) {
        event.formatVersion = input.targetFormatVersion;
        event.legacyMark = null;
      }
      control.status = "complete";
      control.resumable = false;
      control.rollbackAvailable = true;
      control.target = null;
      this.persist();
      await this.killHost();
      return;
    }
    // 只转一半：第一条进了 v2，其余留在 v1。
    const first = record.events.at(0);
    if (first !== undefined) first.formatVersion = input.targetFormatVersion;
    control.status = "incomplete";
    control.resumable = this.fault !== "unrecoverable-interrupt";
    control.rollbackAvailable = this.fault !== "unrecoverable-interrupt";
    control.target = input.targetFormatVersion;
    this.persist();
    await this.killHost();
  }

  async resumeMigration(): Promise<Result<MigrationOutcome>> {
    const record = this.mustRecord();
    const control = this.mustControl();
    const target = control.target;
    if (control.status !== "incomplete" || target === null) {
      return err("migration-incomplete", "there is no unfinished migration to resume", null);
    }
    record.formatVersion = target;
    for (const event of record.events) {
      event.formatVersion = target;
      event.legacyMark = null;
    }
    control.status = "complete";
    control.resumable = false;
    control.rollbackAvailable = true;
    control.target = null;
    this.persist();
    return ok({
      formatVersion: target,
      tombstoneIds: control.tombstones.map((tombstone) => tombstone.tombstoneId),
    });
  }

  async readTombstones(): Promise<Result<readonly Tombstone[]>> {
    return ok(this.mustControl().tombstones.map((tombstone) => ({ ...tombstone })));
  }
}

function driverFor(fault: Fault | null): WindowHistoryDriver {
  return cloneWindowHistoryDriverBoundary(new SyntheticWindowHistoryDriver(fault));
}

const adversarialCases: ReadonlyArray<{ checkId: string; fault: Fault }> = [
  { checkId: "WH-01", fault: "no-durable-write" },
  { checkId: "WH-01", fault: "forget-on-restart" },
  { checkId: "WH-01", fault: "same-process-restart" },
  { checkId: "WH-01", fault: "ignore-pagination" },
  { checkId: "WH-01", fault: "paginate-head-slice" },
  { checkId: "WH-01", fault: "paginate-ignore-before-seq" },
  { checkId: "WH-01", fault: "paginate-inclusive-before-seq" },
  { checkId: "WH-01", fault: "drop-payload-on-restart" },
  { checkId: "WH-02", fault: "accept-stale-generation" },
  { checkId: "WH-02", fault: "backfill-rejected-write" },
  { checkId: "WH-02", fault: "swap-writer-on-rotate" },
  { checkId: "WH-02", fault: "cross-window-leak" },
  { checkId: "WH-02", fault: "reverse-projection-order" },
  { checkId: "WH-02", fault: "idempotent-overwrite" },
  { checkId: "WH-02", fault: "rename-window-on-rotate" },
  { checkId: "WH-03", fault: "empty-page-for-old-generation" },
  { checkId: "WH-03", fault: "rename-window-on-rotate" },
  { checkId: "WH-03", fault: "current-generation-only" },
  { checkId: "WH-03", fault: "archived-window-unreadable" },
  { checkId: "WH-04", fault: "empty-page-instead-of-error" },
  { checkId: "WH-04", fault: "missing-data-reads-empty" },
  { checkId: "WH-04", fault: "silent-corruption-drop" },
  { checkId: "WH-04", fault: "error-for-empty-window" },
  { checkId: "WH-05", fault: "rollback-changes-bytes" },
  { checkId: "WH-05", fault: "silent-field-retirement" },
  { checkId: "WH-05", fault: "mixed-page-after-interrupt" },
  { checkId: "WH-05", fault: "unrecoverable-interrupt" },
  { checkId: "WH-05", fault: "no-op-interrupt" },
  { checkId: "WH-05", fault: "migration-drops-entry" },
  { checkId: "WH-05", fault: "interrupt-preexisting-complete" },
  { checkId: "WH-05", fault: "interrupt-relabel-only" },
  { checkId: "WH-05", fault: "interrupt-version-mismatch" },
];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

function checkById(checkId: string) {
  const check = windowHistoryChecks.find(({ id }) => id === checkId);
  if (check === undefined) throw new Error(`missing check ${checkId}`);
  return check;
}

describe("#120 window-history adversarial acceptance", () => {
  it.each(["WH-01", "WH-02", "WH-03", "WH-04", "WH-05"])(
    "%s goes green for a conforming disk-backed driver",
    async (checkId) => {
      const result = await checkById(checkId).run(driverFor(null));
      expect(result, `${checkId} 正对照不成立：合规驱动也点不亮`).toMatchObject({ passed: true });
    },
  );

  it.each(adversarialCases)("$checkId rejects $fault", async ({ checkId, fault }) => {
    const attacked = await checkById(checkId).run(driverFor(fault));
    expect(attacked, `${checkId} 接受了故障 ${fault}`).toMatchObject({ passed: false });
  });

  it("WH-05 accepts a genuinely atomic interrupt that advanced to v2", async () => {
    // 原子分支的正对照：收紧后的原子分支断言（声称版本==条目版本、页相对前置态确有
    // 推进）不是空转——一个真实原子推进到 v2 的中断仍必须点绿。
    const result = await checkById("WH-05").run(driverFor("interrupt-atomic-complete"));
    expect(result, "WH-05 原子分支正对照不成立：真实原子推进也点不亮").toMatchObject({
      passed: true,
    });
  });

  it("WH-06 stays red against the real src/ tree in this PR", async () => {
    const result = await checkById("WH-06").run(driverFor(null));
    expect(result.passed).toBe(false);
    expect(result.detail).toContain("port-missing");
    expect(result.detail).toContain("writer-missing");
  });
});
