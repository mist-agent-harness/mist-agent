/**
 * 当前活会话的临时状态。
 *
 * 住户的记忆、消息树与关系记录不属于这里；它们必须由各自的持久存储保管。
 * 删除这张表中的一格，只能让一次会话结束，不能删除住户留下的任何东西。
 */
export interface ActiveSession<TContext> {
  residentId: string;
  /**
   * 这次活会话的代际号。kill 后再 open 必须换代，旧代际的迟到结果不能
   * 被当成当前会话的一部分。
   */
  generation: number;
  /** 当前活会话指向的消息节点；不是消息树本身。 */
  headId: string | null;
  /** 尚未落入持久存储的在途上下文。 */
  context: TContext;
}

export interface DispatchReceipt {
  residentId: string;
  generation: number;
  dispatchId: string;
}

export class SessionRegistry<TContext> {
  readonly #active = new Map<string, ActiveSession<TContext>>();
  readonly #lastGeneration = new Map<string, number>();
  #dispatchSeq = 0;

  open(residentId: string, headId: string | null, context: TContext): ActiveSession<TContext> {
    const generation = (this.#lastGeneration.get(residentId) ?? 0) + 1;
    this.#lastGeneration.set(residentId, generation);
    const session = { residentId, generation, headId, context };
    this.#active.set(residentId, session);
    return session;
  }

  get(residentId: string): ActiveSession<TContext> | undefined {
    return this.#active.get(residentId);
  }

  isActive(residentId: string): boolean {
    return this.#active.has(residentId);
  }

  setHead(residentId: string, headId: string | null): void {
    const session = this.#active.get(residentId);
    if (session === undefined) {
      throw new Error(`no active session for ${residentId}`);
    }
    session.headId = headId;
  }

  issueDispatch(residentId: string): DispatchReceipt {
    const session = this.#active.get(residentId);
    if (session === undefined) {
      throw new Error(`no active session for ${residentId}`);
    }
    this.#dispatchSeq += 1;
    return {
      residentId,
      generation: session.generation,
      dispatchId: `dispatch-${this.#dispatchSeq.toString(36).padStart(6, "0")}`,
    };
  }

  belongsToActiveSession(receipt: DispatchReceipt): boolean {
    const session = this.#active.get(receipt.residentId);
    return session !== undefined && session.generation === receipt.generation;
  }

  /** 幂等结束当前会话；住户不存在与否由总装侧的持久存储先行校验。 */
  kill(residentId: string): void {
    this.#active.delete(residentId);
  }
}
