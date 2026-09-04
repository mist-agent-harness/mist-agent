import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * 活窗（viewport）的临时状态。
 *
 * 住户的记忆、消息树与关系记录不属于这里；它们必须由各自的持久存储保管。
 * 删除这张表中的一格，只能让一扇窗结束，不能删除住户留下的任何东西。
 *
 * 多窗语义（MV-A01~A04, MV-B01~B03）：
 * - 同一住户可以同时有多扇活窗，`open` 永远开新窗，不再「原地换代」。
 * - 代际归窗，不归住户；住户级不存在「当前代际」。
 * - `kill(windowId)` 幂等归档，归档后只读；`killResident` 才杀全部活窗。
 * - 派发回执带完整三元组 `(residentId, windowId, generation)`。
 */

/** 缺省 scope 是私聊，任何路径都不得默认「全局」。 */
export const PRIVATE_SCOPE = "private" as const;

/**
 * Crockford base32（ULID 字母表）：去掉 I/L/O/U，目检不歧义。
 * windowId 发号形状 w_ + ULID，图纸 docs/design/multi-viewport.md §1.1。
 */
const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const WINDOW_ARCHIVED = "WINDOW_ARCHIVED" as const;
export const WINDOW_REOPEN_INVALID = "WINDOW_REOPEN_INVALID" as const;
export const WINDOW_ARCHIVE_RECOVERY_INVALID = "WINDOW_ARCHIVE_RECOVERY_INVALID" as const;

export class WindowArchivedError extends Error {
  readonly code = WINDOW_ARCHIVED;
  constructor(windowId: string) {
    super(`${WINDOW_ARCHIVED}: ${windowId}`);
    this.name = "WindowArchivedError";
  }
}

export class WindowReopenError extends Error {
  readonly code = WINDOW_REOPEN_INVALID;
  constructor(windowId: string, reason: string) {
    super(`${WINDOW_REOPEN_INVALID}: ${windowId}: ${reason}`);
    this.name = "WindowReopenError";
  }
}

export class WindowArchiveRecoveryError extends Error {
  readonly code = WINDOW_ARCHIVE_RECOVERY_INVALID;
  constructor(windowId: string, reason: string) {
    super(`${WINDOW_ARCHIVE_RECOVERY_INVALID}: ${windowId}: ${reason}`);
    this.name = "WindowArchiveRecoveryError";
  }
}

export interface ActiveWindow<TContext> {
  residentId: string;
  windowId: string;
  scopeId: string;
  /**
   * 这扇窗的代际号。同窗 kill 后按同一 windowId 重开才换代；
   * 旧代际的迟到结果不能被当成当前窗的一部分。
   */
  generation: number;
  /** 当前窗指向的消息节点；不是消息树本身。 */
  headId: string | null;
  /** 尚未落入持久存储的在途上下文。 */
  context: TContext;
}

export interface ArchivedWindow {
  residentId: string;
  windowId: string;
  scopeId: string;
  generation: number;
  headId: string | null;
  archived: true;
}

function cloneArchivedWindow(window: ArchivedWindow): ArchivedWindow {
  return structuredClone(window);
}

export interface DispatchReceipt {
  residentId: string;
  windowId: string;
  generation: number;
  dispatchId: string;
}

export interface OpenOptions<TContext> {
  scopeId?: string;
  headId?: string | null;
  context: TContext;
  /** 只在按同一身份重开归档窗时给；不给就开一扇全新的窗。 */
  windowId?: string;
}

export interface SessionRegistryOptions {
  /**
   * 窗生命周期的 append-only JSONL。保存已发出的代际水位与归档证据，
   * 不保存或复活活窗。
   * 不给路径时保持纯内存，供无持久化需求的嵌入方与单测使用。
   */
  archivePath?: string;
}

interface ArchivedWindowRecord {
  schemaVersion: 1;
  type: "window_archived";
  window: ArchivedWindow;
}

interface WindowOpenedRecord {
  schemaVersion: 1;
  type: "window_opened";
  window: Pick<ActiveWindow<unknown>, "residentId" | "windowId" | "scopeId" | "generation">;
}

type WindowJournalRecord = ArchivedWindowRecord | WindowOpenedRecord;

function parseWindowJournalRecord(line: string, lineNumber: number): WindowJournalRecord {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error(`invalid window archive JSONL at line ${lineNumber}`);
  }
  if (typeof value !== "object" || value === null) {
    throw new Error(`invalid window archive record at line ${lineNumber}`);
  }
  const record = value as {
    schemaVersion?: unknown;
    type?: unknown;
    window?: Partial<ArchivedWindow>;
  };
  if (
    record.schemaVersion !== 1 ||
    (record.type !== "window_archived" && record.type !== "window_opened")
  ) {
    throw new Error(`unsupported window archive record at line ${lineNumber}`);
  }
  const window = record.window;
  if (
    typeof window !== "object" ||
    window === null ||
    typeof window.residentId !== "string" ||
    window.residentId.length === 0 ||
    typeof window.windowId !== "string" ||
    window.windowId.length === 0 ||
    typeof window.scopeId !== "string" ||
    window.scopeId.length === 0 ||
    typeof window.generation !== "number" ||
    !Number.isInteger(window.generation) ||
    window.generation < 1 ||
    (record.type === "window_archived" &&
      ((window.headId !== null && typeof window.headId !== "string") || window.archived !== true))
  ) {
    throw new Error(`invalid window archive payload at line ${lineNumber}`);
  }
  const common = {
    residentId: window.residentId as string,
    windowId: window.windowId as string,
    scopeId: window.scopeId as string,
    generation: window.generation as number,
  };
  if (record.type === "window_opened") {
    return {
      schemaVersion: 1,
      type: "window_opened",
      window: common,
    };
  }
  return {
    schemaVersion: 1,
    type: "window_archived",
    window: {
      ...common,
      headId: window.headId as string | null,
      archived: true,
    },
  };
}

export class SessionRegistry<TContext> {
  readonly #active = new Map<string, ActiveWindow<TContext>>();
  readonly #archived = new Map<string, ArchivedWindow>();
  readonly #windowIdentity = new Map<string, { residentId: string; scopeId: string }>();
  /** 代际归窗：windowId -> 上一次用过的代际号。 */
  readonly #lastGeneration = new Map<string, number>();
  readonly #archivePath: string | undefined;
  #dispatchSeq = 0;
  /** 上一枚 ULID 的时间戳与随机段——同毫秒连开多窗时自增随机段保单调。 */
  #ulidTimestamp = 0;
  #ulidRandom: number[] = [];

  constructor(options: SessionRegistryOptions = {}) {
    this.#archivePath = options.archivePath;
    if (this.#archivePath === undefined) return;
    mkdirSync(dirname(this.#archivePath), { recursive: true });
    if (!existsSync(this.#archivePath)) return;
    const lines = readFileSync(this.#archivePath, "utf8").split("\n");
    for (const [index, line] of lines.entries()) {
      if (line.trim().length === 0) continue;
      const record = parseWindowJournalRecord(line, index + 1);
      const window = record.window;
      const identity = this.#windowIdentity.get(window.windowId);
      if (
        identity !== undefined &&
        (identity.residentId !== window.residentId || identity.scopeId !== window.scopeId)
      ) {
        throw new Error(`window identity changed at line ${index + 1}: ${window.windowId}`);
      }
      this.#windowIdentity.set(window.windowId, {
        residentId: window.residentId,
        scopeId: window.scopeId,
      });
      const previousGeneration = this.#lastGeneration.get(window.windowId) ?? 0;
      if (record.type === "window_opened" && window.generation <= previousGeneration) {
        throw new Error(
          `window generation is not increasing at line ${index + 1}: ${window.windowId}`,
        );
      }
      if (record.type === "window_archived") {
        const previousArchiveGeneration = this.#archived.get(window.windowId)?.generation ?? 0;
        if (
          window.generation < previousGeneration ||
          window.generation <= previousArchiveGeneration
        ) {
          throw new Error(
            `window archive generation is not increasing at line ${index + 1}: ${window.windowId}`,
          );
        }
        this.#archived.set(window.windowId, record.window);
      }
      this.#lastGeneration.set(window.windowId, Math.max(previousGeneration, window.generation));
    }
  }

  #appendOpened(window: ActiveWindow<TContext>): void {
    if (this.#archivePath === undefined) return;
    const record: WindowOpenedRecord = {
      schemaVersion: 1,
      type: "window_opened",
      window: {
        residentId: window.residentId,
        windowId: window.windowId,
        scopeId: window.scopeId,
        generation: window.generation,
      },
    };
    appendFileSync(this.#archivePath, `${JSON.stringify(record)}\n`, "utf8");
  }

  #appendArchive(archived: ArchivedWindow): void {
    if (this.#archivePath === undefined) return;
    const record: ArchivedWindowRecord = {
      schemaVersion: 1,
      type: "window_archived",
      window: archived,
    };
    appendFileSync(this.#archivePath, `${JSON.stringify(record)}\n`, "utf8");
  }

  #mintWindowId(): string {
    let candidate: string;
    // 碰撞检查留给「显式 windowId 与随机发号撞名」这种理论事故；随机段
    // 80bit，正常路径一轮就出去。
    do {
      candidate = `w_${this.#nextUlid()}`;
    } while (
      this.#active.has(candidate) ||
      this.#archived.has(candidate) ||
      this.#lastGeneration.has(candidate)
    );
    return candidate;
  }

  /**
   * w_ 后面的 ULID：48bit 毫秒时间 + 80bit crypto 随机，Crockford base32
   * 共 26 字符。随机段来自 node:crypto——顺序发号（window-000001）在两个
   * 注册表共用一本账时会撞号（共享 ack 行事故），随机发号进程间不可撞，
   * 也满足图纸「外部不可猜」。同毫秒连开时随机段按 base32 自增
   * （monotonic ULID 变体）：进程内字典序即开窗序，且同毫秒不重号。
   */
  #nextUlid(): string {
    const now = Date.now();
    if (now <= this.#ulidTimestamp) {
      // 同毫秒连开、或时钟回拨：随机段按 base32 自增（monotonic ULID 变体），
      // 时间戳钳在上一枚的值——字典序即开窗序，时钟倒走也撞不出重号。
      // 自增从最低位（末尾）起，向前进位；全程 31（约 32^16 分之一的同毫秒
      // 开窗量）才会溢出成全 0——那个量级到不了，不为其造错误类型。
      for (let i = this.#ulidRandom.length - 1; i >= 0; i -= 1) {
        const digit = this.#ulidRandom[i] ?? 0;
        if (digit < 31) {
          this.#ulidRandom[i] = digit + 1;
          break;
        }
        this.#ulidRandom[i] = 0;
      }
    } else {
      this.#ulidTimestamp = now;
      // 取每个字节的低 5bit：256 = 8 × 32，低 5bit 在 0..31 上均匀，无偏。
      this.#ulidRandom = [...randomBytes(16)].map((byte) => byte & 31);
    }
    let time = "";
    for (let shift = 45; shift >= 0; shift -= 5) {
      time += ULID_ALPHABET.charAt(Math.floor(this.#ulidTimestamp / 2 ** shift) % 32);
    }
    return time + this.#ulidRandom.map((digit) => ULID_ALPHABET.charAt(digit)).join("");
  }

  #requireArchivedForReopen(residentId: string, scopeId: string, windowId: string): ArchivedWindow {
    const archived = this.#archived.get(windowId);
    if (archived === undefined) {
      throw new WindowReopenError(windowId, "target is not an archived window");
    }
    if (archived.residentId !== residentId) {
      throw new WindowReopenError(
        windowId,
        `resident mismatch: archived=${archived.residentId}, requested=${residentId}`,
      );
    }
    if (archived.scopeId !== scopeId) {
      throw new WindowReopenError(
        windowId,
        `scope mismatch: archived=${archived.scopeId}, requested=${scopeId}`,
      );
    }
    return archived;
  }

  /**
   * 开一扇窗。同一 residentId 连开两次得到两扇不同的窗，各自 generation=1，
   * 两窗皆活；旧语义「重复 open 原地换代」不再存在（MV-A01）。
   * 给 windowId 时是按同一身份重开一扇已归档的窗，起新一代（#66 B5）。
   */
  open(residentId: string, options: OpenOptions<TContext>): ActiveWindow<TContext> {
    const scopeId = options.scopeId ?? PRIVATE_SCOPE;
    const windowId = options.windowId ?? this.#mintWindowId();
    if (options.windowId !== undefined) {
      this.#requireArchivedForReopen(residentId, scopeId, windowId);
    }
    const generation = (this.#lastGeneration.get(windowId) ?? 0) + 1;
    const window: ActiveWindow<TContext> = {
      residentId,
      windowId,
      scopeId,
      generation,
      headId: options.headId ?? null,
      context: options.context,
    };
    // 代际一经发出就先落盘；否则活窗在未归档时停机，重启后会重复发出同一代际。
    this.#appendOpened(window);
    this.#lastGeneration.set(windowId, generation);
    this.#windowIdentity.set(windowId, { residentId, scopeId });
    this.#archived.delete(windowId);
    this.#active.set(windowId, window);
    return window;
  }

  get(windowId: string): ActiveWindow<TContext> | undefined {
    return this.#active.get(windowId);
  }

  getArchived(windowId: string): ArchivedWindow | undefined {
    const archived = this.#archived.get(windowId);
    return archived === undefined ? undefined : cloneArchivedWindow(archived);
  }

  getHead(windowId: string): string | null {
    return this.#requireLive(windowId).headId;
  }

  isActive(windowId: string): boolean {
    return this.#active.has(windowId);
  }

  isArchived(windowId: string): boolean {
    return this.#archived.has(windowId);
  }

  /** 一位住户此刻的全部活窗。多开合法，所以这里返回的是列表而不是一格。 */
  windowsOf(residentId: string): ActiveWindow<TContext>[] {
    return [...this.#active.values()].filter((window) => window.residentId === residentId);
  }

  /** 一位住户的全部归档窗。线协议列窗时与 windowsOf 合并，不复活任何窗。 */
  archivedWindowsOf(residentId: string): ArchivedWindow[] {
    return [...this.#archived.values()]
      .filter((window) => window.residentId === residentId)
      .map(cloneArchivedWindow);
  }

  hasLiveWindow(residentId: string): boolean {
    return this.windowsOf(residentId).length > 0;
  }

  #requireLive(windowId: string): ActiveWindow<TContext> {
    const window = this.#active.get(windowId);
    if (window !== undefined) return window;
    if (this.#archived.has(windowId)) throw new WindowArchivedError(windowId);
    throw new Error(`no active window ${windowId}`);
  }

  setHead(windowId: string, headId: string | null): void {
    this.#requireLive(windowId).headId = headId;
  }

  issueDispatch(windowId: string): DispatchReceipt {
    const window = this.#requireLive(windowId);
    this.#dispatchSeq += 1;
    return {
      residentId: window.residentId,
      windowId: window.windowId,
      generation: window.generation,
      dispatchId: `dispatch-${this.#dispatchSeq.toString(36).padStart(6, "0")}`,
    };
  }

  /**
   * 回执归属按完整三元组判定：住户对得上、窗对得上、代际对得上，缺一不认。
   * 两扇窗互相的迟到回执因此不会落到对方身上（MV-B01）。
   */
  belongsToActiveWindow(receipt: DispatchReceipt): boolean {
    const window = this.#active.get(receipt.windowId);
    return (
      window !== undefined &&
      window.residentId === receipt.residentId &&
      window.generation === receipt.generation
    );
  }

  /** 幂等归档一扇窗。归档后只读，写入返 WINDOW_ARCHIVED（MV-A03）。 */
  kill(windowId: string): ArchivedWindow | undefined {
    const window = this.#active.get(windowId);
    if (window === undefined) {
      const archived = this.#archived.get(windowId);
      return archived === undefined ? undefined : cloneArchivedWindow(archived);
    }
    const archived: ArchivedWindow = {
      residentId: window.residentId,
      windowId: window.windowId,
      scopeId: window.scopeId,
      generation: window.generation,
      headId: window.headId,
      archived: true,
    };
    // 先落耐久证据再改内存；追加失败时窗仍保持活态，不伪报已归档。
    this.#appendArchive(archived);
    this.#active.delete(windowId);
    this.#archived.set(windowId, archived);
    return cloneArchivedWindow(archived);
  }

  /**
   * Finish a host-owned close operation after restart. The caller must supply the exact durable
   * snapshot recorded before the active window disappeared; this method cannot invent or resume
   * an active context. It only restores the archived evidence record for the latest issued
   * generation of an already-known window identity.
   */
  recoverArchived(window: ArchivedWindow): ArchivedWindow {
    if (
      window.archived !== true ||
      typeof window.residentId !== "string" ||
      window.residentId.length === 0 ||
      typeof window.windowId !== "string" ||
      window.windowId.length === 0 ||
      typeof window.scopeId !== "string" ||
      window.scopeId.length === 0 ||
      !Number.isSafeInteger(window.generation) ||
      window.generation < 1
    ) {
      throw new WindowArchiveRecoveryError(window.windowId, "archive snapshot is invalid");
    }
    const existing = this.#archived.get(window.windowId);
    if (existing !== undefined) {
      if (
        existing.residentId !== window.residentId ||
        existing.scopeId !== window.scopeId ||
        existing.generation !== window.generation ||
        existing.headId !== window.headId ||
        window.archived !== true
      ) {
        throw new WindowArchiveRecoveryError(window.windowId, "archive snapshot mismatch");
      }
      return cloneArchivedWindow(existing);
    }
    if (this.#active.has(window.windowId)) {
      throw new WindowArchiveRecoveryError(window.windowId, "window is still active");
    }
    const identity = this.#windowIdentity.get(window.windowId);
    if (
      identity === undefined ||
      identity.residentId !== window.residentId ||
      identity.scopeId !== window.scopeId
    ) {
      throw new WindowArchiveRecoveryError(window.windowId, "window identity mismatch");
    }
    if (this.#lastGeneration.get(window.windowId) !== window.generation) {
      throw new WindowArchiveRecoveryError(window.windowId, "generation is not the latest issued");
    }
    if (
      window.headId !== null &&
      (typeof window.headId !== "string" || window.headId.length === 0)
    ) {
      throw new WindowArchiveRecoveryError(window.windowId, "headId is invalid");
    }
    const recovered = cloneArchivedWindow({ ...window, archived: true });
    this.#appendArchive(recovered);
    this.#archived.set(recovered.windowId, recovered);
    return cloneArchivedWindow(recovered);
  }

  /** 杀掉一位住户的全部活窗（MV-A03 后半）。 */
  killResident(residentId: string): ArchivedWindow[] {
    return this.windowsOf(residentId).map((window) => this.kill(window.windowId) as ArchivedWindow);
  }
}
