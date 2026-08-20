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

export const WINDOW_ARCHIVED = "WINDOW_ARCHIVED" as const;
export const WINDOW_REOPEN_INVALID = "WINDOW_REOPEN_INVALID" as const;

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

export class SessionRegistry<TContext> {
  readonly #active = new Map<string, ActiveWindow<TContext>>();
  readonly #archived = new Map<string, ArchivedWindow>();
  /** 代际归窗：windowId -> 上一次用过的代际号。 */
  readonly #lastGeneration = new Map<string, number>();
  #windowSeq = 0;
  #dispatchSeq = 0;

  #mintWindowId(): string {
    let candidate: string;
    do {
      this.#windowSeq += 1;
      candidate = `window-${this.#windowSeq.toString(36).padStart(6, "0")}`;
    } while (this.#active.has(candidate) || this.#archived.has(candidate));
    return candidate;
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
    this.#lastGeneration.set(windowId, generation);
    this.#archived.delete(windowId);
    const window: ActiveWindow<TContext> = {
      residentId,
      windowId,
      scopeId,
      generation,
      headId: options.headId ?? null,
      context: options.context,
    };
    this.#active.set(windowId, window);
    return window;
  }

  get(windowId: string): ActiveWindow<TContext> | undefined {
    return this.#active.get(windowId);
  }

  getArchived(windowId: string): ArchivedWindow | undefined {
    return this.#archived.get(windowId);
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
    if (window === undefined) return this.#archived.get(windowId);
    this.#active.delete(windowId);
    const archived: ArchivedWindow = {
      residentId: window.residentId,
      windowId: window.windowId,
      scopeId: window.scopeId,
      generation: window.generation,
      headId: window.headId,
      archived: true,
    };
    this.#archived.set(windowId, archived);
    return archived;
  }

  /** 杀掉一位住户的全部活窗（MV-A03 后半）。 */
  killResident(residentId: string): ArchivedWindow[] {
    return this.windowsOf(residentId).map((window) => this.kill(window.windowId) as ArchivedWindow);
  }
}
