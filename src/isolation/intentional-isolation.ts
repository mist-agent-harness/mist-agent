import { randomUUID } from "node:crypto";
import type { TurnGate, TurnPass } from "../message-tree/service.ts";
import type { ActiveWindow, SessionRegistry } from "../session/session-registry.ts";

export const ISOLATION_CREATE_INVALID = "ISOLATION_CREATE_INVALID" as const;
export const ISOLATION_CREATE_FAILED = "ISOLATION_CREATE_FAILED" as const;

export class IsolationCreateError extends Error {
  constructor(
    readonly code: typeof ISOLATION_CREATE_INVALID | typeof ISOLATION_CREATE_FAILED,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "IsolationCreateError";
  }
}

/**
 * 隔离 session 在住户共享状态里的公开投影。
 *
 * 这里只能装“它存在”所需的字段；局部上下文、消息、工具状态和产物都不属于
 * 这张投影。将来增加字段时，B3 的内容不过界约束仍在这个类型边界上生效。
 */
export interface IsolationSessionPresence {
  residentId: string;
  scopeId: string;
  name: string;
  status: "ready";
  source: {
    scopeId: string;
    windowId: string;
  };
  /** 当前隔离 session 的首扇 viewport；它不是 scope 的身份。 */
  entryWindowId: string;
  createdAt: string;
}

export interface ScopePresenceEnvelope {
  kind: "scope_presence";
  seq: number;
  residentId: string;
  scope: {
    scopeId: string;
    name: string;
    status: "ready";
    source: {
      scopeId: string;
      windowId: string;
    };
  };
}

/** 住户是否存在的最窄读取口；ResidentStore 直接满足这个接口。 */
export interface ResidentDirectory {
  has(residentId: string): boolean;
}

/**
 * 住户级隔离登记与存在事件的单一写入口。
 *
 * create 必须把共享投影与存在事件一同提交，不能先露出一半。默认实现是内存
 * 单写者；持久实现必须维持同一原子边界。
 */
export interface IsolationPresenceStore {
  create(presence: IsolationSessionPresence): ScopePresenceEnvelope;
  list(residentId: string): IsolationSessionPresence[];
  eventsAfter(residentId: string, seq: number): ScopePresenceEnvelope[];
}

export class InMemoryIsolationPresenceStore implements IsolationPresenceStore {
  readonly #scopes = new Map<string, Map<string, IsolationSessionPresence>>();
  readonly #events = new Map<string, ScopePresenceEnvelope[]>();

  create(presence: IsolationSessionPresence): ScopePresenceEnvelope {
    const scopes = this.#scopes.get(presence.residentId) ?? new Map();
    if (scopes.has(presence.scopeId)) {
      throw new IsolationCreateError(
        ISOLATION_CREATE_FAILED,
        `scope already exists: ${presence.scopeId}`,
      );
    }
    const events = this.#events.get(presence.residentId) ?? [];
    const event: ScopePresenceEnvelope = {
      kind: "scope_presence",
      seq: events.length + 1,
      residentId: presence.residentId,
      scope: {
        scopeId: presence.scopeId,
        name: presence.name,
        status: presence.status,
        source: { ...presence.source },
      },
    };

    // 两张 Map 的写入都不会调用外部代码；先构造完整对象，再连续提交。
    // 持久实现若不能给出同样的原子性，不得冒充这个接口的实现。
    scopes.set(presence.scopeId, clonePresence(presence));
    this.#scopes.set(presence.residentId, scopes);
    this.#events.set(presence.residentId, [...events, cloneEnvelope(event)]);
    return cloneEnvelope(event);
  }

  list(residentId: string): IsolationSessionPresence[] {
    return [...(this.#scopes.get(residentId)?.values() ?? [])].map(clonePresence);
  }

  eventsAfter(residentId: string, seq: number): ScopePresenceEnvelope[] {
    if (!Number.isInteger(seq) || seq < 0) {
      throw new Error(`presence sequence must be a non-negative integer: ${seq}`);
    }
    return (this.#events.get(residentId) ?? [])
      .filter((event) => event.seq > seq)
      .map(cloneEnvelope);
  }
}

export interface CreateIsolationOptions<TContext> {
  name: string;
  context: TContext;
}

export interface IntentionalIsolationOptions {
  presenceStore?: IsolationPresenceStore;
  scopeIdFactory?: () => string;
  now?: () => string;
}

function clonePresence(presence: IsolationSessionPresence): IsolationSessionPresence {
  return {
    ...presence,
    source: { ...presence.source },
  };
}

function cloneEnvelope(envelope: ScopePresenceEnvelope): ScopePresenceEnvelope {
  return {
    ...envelope,
    scope: {
      ...envelope.scope,
      source: { ...envelope.scope.source },
    },
  };
}

function renderEnvelope(envelope: ScopePresenceEnvelope): string {
  return `[scope-presence] ${JSON.stringify(envelope)}`;
}

/**
 * B1 + B3 的生产入口：从一扇现役 viewport 创建隔离 session，并把它的存在
 * 投影给同住户的其他 viewport。
 *
 * scope 与 viewport 刻意分层：本类只签发 scopeId；SessionRegistry 继续只管
 * windowId/generation。B5 的 scopeGeneration 尚待 Q2，不能在这里偷借 window
 * generation 代替。
 */
export class IntentionalIsolation<TContext> implements TurnGate {
  readonly #residents: ResidentDirectory;
  readonly #sessions: SessionRegistry<TContext>;
  readonly #presence: IsolationPresenceStore;
  readonly #scopeIdFactory: () => string;
  readonly #now: () => string;
  /** 每扇 viewport 已确认读到的住户级存在事件序号。 */
  readonly #ackedSeq = new Map<string, number>();

  constructor(
    residents: ResidentDirectory,
    sessions: SessionRegistry<TContext>,
    options: IntentionalIsolationOptions = {},
  ) {
    this.#residents = residents;
    this.#sessions = sessions;
    this.#presence = options.presenceStore ?? new InMemoryIsolationPresenceStore();
    this.#scopeIdFactory = options.scopeIdFactory ?? (() => `scope_${randomUUID()}`);
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  /**
   * 用户公开的“开隔离 session”动作。
   *
   * 返回前同时满足：来源窗仍在、住户存在、新 viewport 已建立、住户共享状态
   * 已登记。登记失败时新 viewport 立即归档，调用方只得到显式失败，不会拿到一扇
   * 看似 ready 的半成品窗。
   */
  create(
    originWindowId: string,
    options: CreateIsolationOptions<TContext>,
  ): IsolationSessionPresence {
    const origin = this.#sessions.get(originWindowId);
    if (origin === undefined) {
      throw new IsolationCreateError(
        ISOLATION_CREATE_INVALID,
        `origin window is not active: ${originWindowId}`,
      );
    }
    if (!this.#residents.has(origin.residentId)) {
      throw new IsolationCreateError(
        ISOLATION_CREATE_INVALID,
        `resident does not exist: ${origin.residentId}`,
      );
    }
    const name = options.name.trim();
    if (name.length === 0) {
      throw new IsolationCreateError(ISOLATION_CREATE_INVALID, "name must not be empty");
    }
    const scopeId = this.#scopeIdFactory();
    if (scopeId.length === 0) {
      throw new IsolationCreateError(ISOLATION_CREATE_FAILED, "scope id factory returned empty id");
    }

    let window: ActiveWindow<TContext> | undefined;
    try {
      window = this.#sessions.open(origin.residentId, {
        scopeId,
        context: options.context,
      });
      const presence: IsolationSessionPresence = {
        residentId: origin.residentId,
        scopeId,
        name,
        status: "ready",
        source: {
          scopeId: origin.scopeId,
          windowId: origin.windowId,
        },
        entryWindowId: window.windowId,
        createdAt: this.#now(),
      };
      this.#presence.create(presence);
      return clonePresence(presence);
    } catch (error) {
      if (window !== undefined) this.#sessions.kill(window.windowId);
      if (error instanceof IsolationCreateError) throw error;
      throw new IsolationCreateError(
        ISOLATION_CREATE_FAILED,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /** 用户界面的同步共享状态投影；返回副本，调用方不能反写权威状态。 */
  sharedState(residentId: string): IsolationSessionPresence[] {
    if (!this.#residents.has(residentId)) {
      throw new IsolationCreateError(
        ISOLATION_CREATE_INVALID,
        `resident does not exist: ${residentId}`,
      );
    }
    return this.#presence.list(residentId);
  }

  /**
   * 模型侧的异步存在信封：只在下一次 dispatch 开始时读取，当前正在生成的回合
   * 不会被中断。commit 只确认本次实际送进模型的最高序号；途中新增事件留给下轮。
   */
  beforeTurn(residentId: string, windowId: string): TurnPass {
    const window = this.#sessions.get(windowId);
    if (window === undefined || window.residentId !== residentId) {
      throw new IsolationCreateError(
        ISOLATION_CREATE_INVALID,
        `window is not active for resident: ${residentId}/${windowId}`,
      );
    }
    const acked = this.#ackedSeq.get(windowId) ?? 0;
    // 创建出来的隔离 session 不需要收到一封“你自己刚被创建”的通知；B3 的
    // 模型信封只发给同住户的其他 session。同 scope 的其他 viewport 也共享
    // 这份存在，不必互相广播自己。
    const pending = this.#presence
      .eventsAfter(residentId, acked)
      .filter((event) => event.scope.scopeId !== window.scopeId);
    const deliveredThrough = pending.at(-1)?.seq ?? acked;
    return {
      contextPrefix: pending.map(renderEnvelope),
      commit: () => {
        const current = this.#ackedSeq.get(windowId) ?? 0;
        if (deliveredThrough > current) this.#ackedSeq.set(windowId, deliveredThrough);
      },
    };
  }
}
