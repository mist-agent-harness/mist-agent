/**
 * 当前活会话的临时状态。
 *
 * 住户的记忆、消息树与关系记录不属于这里；它们必须由各自的持久存储保管。
 * 删除这张表中的一格，只能让一次会话结束，不能删除住户留下的任何东西。
 */
export interface ActiveSession<TContext> {
  residentId: string;
  /** 当前活会话指向的消息节点；不是消息树本身。 */
  headId: string | null;
  /** 尚未落入持久存储的在途上下文。 */
  context: TContext;
}

export class SessionRegistry<TContext> {
  readonly #active = new Map<string, ActiveSession<TContext>>();

  open(residentId: string, headId: string | null, context: TContext): ActiveSession<TContext> {
    const session = { residentId, headId, context };
    this.#active.set(residentId, session);
    return session;
  }

  get(residentId: string): ActiveSession<TContext> | undefined {
    return this.#active.get(residentId);
  }

  isActive(residentId: string): boolean {
    return this.#active.has(residentId);
  }

  /** 幂等结束当前会话；住户不存在与否由总装侧的持久存储先行校验。 */
  kill(residentId: string): void {
    this.#active.delete(residentId);
  }
}
