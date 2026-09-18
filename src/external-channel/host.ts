import type {
  ActiveWindow,
  DispatchReceipt,
  SessionRegistry,
} from "../session/session-registry.ts";
import type { ExternalChannelAddress, ExternalChannelBindingStore } from "./binding-store.ts";
import type {
  ExternalInboundItem,
  ExternalInboundStore,
  ExternalScopeFact,
} from "./inbound-store.ts";

export type ExternalIngressReceipt =
  | {
      readonly status: "queued";
      readonly delivered: false;
      readonly duplicate: boolean;
      readonly inboundId: string;
      readonly residentId: string;
      readonly scopeId: string;
      readonly queuedAt: string;
      readonly expiresAt: string;
    }
  | {
      readonly status: "dispatched";
      readonly duplicate: boolean;
      readonly inboundId: string;
      readonly residentId: string;
      readonly scopeId: string;
      readonly dispatch: DispatchReceipt;
    }
  | {
      readonly status: "rejected";
      readonly duplicate: boolean;
      readonly reason: "CONNECTION_INACTIVE" | "UNBOUND_CHANNEL" | "QUEUE_FULL" | "EXPIRED";
      readonly inboundId?: string;
      readonly residentId?: string;
      readonly scopeId?: string;
    };

export interface ExternalChannelFailure {
  readonly stage: "window-open-drain" | "activation-drain" | "dispatch-persist";
  readonly residentId: string;
  readonly scopeId: string;
  readonly inboundId?: string;
  readonly error: string;
}

export interface ExternalChannelHostOptions<TContext> {
  readonly sessions: SessionRegistry<TContext>;
  readonly bindings: ExternalChannelBindingStore;
  readonly inbox: ExternalInboundStore;
  readonly listenerId?: string;
}

/** Host-owned ingress assembly: resolve binding now, land one scope fact, issue one response right. */
export class ExternalChannelHost<TContext> {
  readonly #sessions: SessionRegistry<TContext>;
  readonly #bindings: ExternalChannelBindingStore;
  readonly #inbox: ExternalInboundStore;
  readonly #listenerId: string;
  readonly #failures: ExternalChannelFailure[] = [];
  #unsubscribe: (() => void) | undefined;

  constructor(options: ExternalChannelHostOptions<TContext>) {
    this.#sessions = options.sessions;
    this.#bindings = options.bindings;
    this.#inbox = options.inbox;
    this.#listenerId = options.listenerId ?? "external-channel-inbound";
  }

  get active(): boolean {
    return this.#unsubscribe !== undefined;
  }

  activate(): void {
    if (this.active) return;
    this.#unsubscribe = this.#sessions.subscribeWindowOpened(this.#listenerId, (window) => {
      this.#drainSafely(window.residentId, window.scopeId, "window-open-drain");
    });
    const scopes = new Set(
      this.#bindings
        .activeBindings()
        .map((binding) => JSON.stringify([binding.residentId, binding.scopeId])),
    );
    for (const encoded of scopes) {
      const [residentId, scopeId] = JSON.parse(encoded) as [string, string];
      this.#drainSafely(residentId, scopeId, "activation-drain");
    }
  }

  deactivate(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  ingest(
    input: ExternalChannelAddress & {
      readonly externalMessageId: string;
      readonly body: string;
      readonly receivedAt?: string;
    },
  ): ExternalIngressReceipt {
    if (!this.active) {
      return { status: "rejected", duplicate: false, reason: "CONNECTION_INACTIVE" };
    }
    const address = { pluginId: input.pluginId, channelId: input.channelId };
    const binding = this.#bindings.resolve(address);
    if (binding === undefined) {
      return { status: "rejected", duplicate: false, reason: "UNBOUND_CHANNEL" };
    }
    const responder = this.#sessions.mostRecentWindow(binding.residentId, binding.scopeId);
    const received = this.#inbox.receive(
      binding,
      {
        externalMessageId: input.externalMessageId,
        body: input.body,
        ...(input.receivedAt === undefined ? {} : { receivedAt: input.receivedAt }),
      },
      responder === undefined ? "queue" : "dispatch",
    );
    let item = received.item;
    if (responder !== undefined && (item.status === "pending" || item.status === "queued")) {
      item = this.#dispatch(item, responder) ?? this.#inbox.get(item.inboundId) ?? item;
    }
    return this.#receipt(item, received.duplicate);
  }

  inspect(residentId: string, scopeId: string): ExternalInboundItem[] {
    return this.#inbox.inspect(residentId, scopeId);
  }

  factsForScope(residentId: string, scopeId: string): ExternalScopeFact[] {
    return this.#inbox.facts(residentId, scopeId);
  }

  factsForWindow(windowId: string): ExternalScopeFact[] {
    const window = this.#sessions.get(windowId);
    if (window === undefined) throw new Error(`no active window ${windowId}`);
    return this.factsForScope(window.residentId, window.scopeId);
  }

  failures(): ExternalChannelFailure[] {
    return this.#failures.map((failure) => ({ ...failure }));
  }

  #drainSafely(
    residentId: string,
    scopeId: string,
    stage: "window-open-drain" | "activation-drain",
  ): void {
    try {
      this.#drain(residentId, scopeId);
    } catch (error) {
      this.#failures.push({
        stage,
        residentId,
        scopeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  #drain(residentId: string, scopeId: string): void {
    const responder = this.#sessions.mostRecentWindow(residentId, scopeId);
    const waiting = this.#inbox.queued(residentId, scopeId);
    if (responder === undefined) {
      for (const item of waiting) {
        if (item.status === "pending") this.#inbox.markQueued(item.inboundId);
      }
      return;
    }
    for (const item of waiting) this.#dispatch(item, responder);
  }

  #dispatch(
    item: ExternalInboundItem,
    preferred?: ActiveWindow<TContext>,
  ): ExternalInboundItem | undefined {
    const responder = preferred ?? this.#sessions.mostRecentWindow(item.residentId, item.scopeId);
    if (responder === undefined) {
      return item.status === "pending" ? this.#inbox.markQueued(item.inboundId) : item;
    }
    const dispatch = this.#sessions.issueDispatch(responder.windowId);
    try {
      return this.#inbox.markDispatched(item.inboundId, dispatch);
    } catch (error) {
      this.#sessions.revokeDispatch(dispatch);
      let current = this.#inbox.get(item.inboundId);
      if (current?.status === "pending") current = this.#inbox.markQueued(item.inboundId);
      this.#failures.push({
        stage: "dispatch-persist",
        residentId: item.residentId,
        scopeId: item.scopeId,
        inboundId: item.inboundId,
        error: error instanceof Error ? error.message : String(error),
      });
      return current;
    }
  }

  #receipt(item: ExternalInboundItem, duplicate: boolean): ExternalIngressReceipt {
    if (item.status === "dispatched" && item.dispatch !== undefined) {
      return {
        status: "dispatched",
        duplicate,
        inboundId: item.inboundId,
        residentId: item.residentId,
        scopeId: item.scopeId,
        dispatch: { ...item.dispatch },
      };
    }
    if (item.status === "queued" || item.status === "pending") {
      return {
        status: "queued",
        delivered: false,
        duplicate,
        inboundId: item.inboundId,
        residentId: item.residentId,
        scopeId: item.scopeId,
        queuedAt: item.queuedAt,
        expiresAt: item.expiresAt,
      };
    }
    return {
      status: "rejected",
      duplicate,
      reason: item.reason ?? "EXPIRED",
      inboundId: item.inboundId,
      residentId: item.residentId,
      scopeId: item.scopeId,
    };
  }
}
