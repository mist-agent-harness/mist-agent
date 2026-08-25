import type {
  HistoryEntry,
  RpcError,
  SessionProjectionsBlock,
  SessionSummary,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import {
  sessionCreateRequestSchema,
  sessionHistoryRequestSchema,
  sessionListRequestSchema,
} from '@deepseek-ai/dsh-host-apiproxy/api/sessions.schema'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { z as zCore } from 'zod'
import type { DownlinkFrame, MistHandler, UnaryResult } from './handler.ts'

type ZodIssue = zCore.core.$ZodIssue

/** Stable read description passed to the window-history owner. */
export interface MistWindowHistoryRef {
  residentId: string
  windowId: string
  headId: string | null
  archived: boolean
}

/** Metadata needed by the existing session.list wire row. */
export interface MistWindowHistorySummary {
  updatedAt: number
  running: boolean
  blank: boolean
}

/** Read-only page returned by the window-history owner. */
export interface MistWindowHistoryPage {
  events: HistoryEntry[]
  hasMore: boolean
  projections?: SessionProjectionsBlock
}

/**
 * The archive/history seam intentionally stays read-only. The multi-viewport
 * registry owns window identity and lifecycle; the message/event store owns
 * the bytes exposed by session.history.
 */
export interface MistWindowHistoryPort {
  summarize(window: MistWindowHistoryRef): Promise<MistWindowHistorySummary>
  read(
    window: MistWindowHistoryRef,
    page: { beforeSeq?: number; maxMessages?: number },
  ): Promise<MistWindowHistoryPage>
}

/** Lifecycle fields needed by the session.* wire, independent of stored context. */
export interface MistViewportSnapshot {
  residentId: string
  windowId: string
  scopeId: string
  generation: number
  headId: string | null
}

/**
 * Narrow structural view of the multi-viewport registry. Keeping this port in
 * the adapter avoids making the vendored webui package depend on Mist's root
 * source tree; production composition can pass SessionRegistry directly.
 */
export interface MistViewportRegistry<TContext> {
  windowsOf(residentId: string): MistViewportSnapshot[]
  archivedWindowsOf(residentId: string): MistViewportSnapshot[]
  open(
    residentId: string,
    options: { scopeId?: string; context: TContext },
  ): MistViewportSnapshot
  get(windowId: string): MistViewportSnapshot | undefined
  getArchived(windowId: string): MistViewportSnapshot | undefined
}

export interface MistSessionWireAdapterOptions<TContext> {
  /** Resident bound to this handler instance; resident identity never enters the webui wire. */
  residentId: string
  sessions: MistViewportRegistry<TContext>
  history: MistWindowHistoryPort
  createContext(): TContext
}

interface ListedWindow {
  window: MistViewportSnapshot
  archived: boolean
}

function success(value: unknown): UnaryResult {
  return { ok: true, value }
}

function failure(error: RpcError): UnaryResult {
  return { ok: false, error }
}

function invalidPayload(method: string, issues: ZodIssue[]): UnaryResult {
  return failure({
    code: 'bad-request',
    message: `invalid payload for ${method}`,
    details: { issues },
  })
}

function notImplemented(method: string): UnaryResult {
  return failure({
    code: 'internal',
    message: `not implemented by Mist webui v0: ${method}`,
    details: {},
  })
}

function sessionMissing(sessionId: SessionId): UnaryResult {
  return failure({
    code: 'session-not-found',
    message: `session not found: ${sessionId}`,
    details: { sessionId },
  })
}

/**
 * Standalone session.* adapter for the multi-viewport model.
 *
 * It is deliberately not installed into the frontend plugin: plugin-to-host
 * handler delivery belongs to the deferred protocol v0.1 follow-up. The
 * current mock remains the default dev/plugin handler.
 */
export class MistSessionWireAdapter<TContext> implements MistHandler {
  readonly #residentId: string
  readonly #sessions: MistViewportRegistry<TContext>
  readonly #history: MistWindowHistoryPort
  readonly #createContext: () => TContext

  constructor(options: MistSessionWireAdapterOptions<TContext>) {
    if (options.residentId.length === 0) throw new TypeError('residentId must not be empty')
    this.#residentId = options.residentId
    this.#sessions = options.sessions
    this.#history = options.history
    this.#createContext = () => options.createContext()
  }

  async unary(method: string, payload: unknown, _rpcId: string): Promise<UnaryResult> {
    try {
      switch (method) {
        case 'session.list':
          return await this.#list(payload)
        case 'session.create':
          return this.#create(payload)
        case 'session.history':
          return await this.#readHistory(payload)
        default:
          return notImplemented(method)
      }
    } catch (error: unknown) {
      return failure({
        code: 'internal',
        message: `${method} failed: ${error instanceof Error ? error.message : String(error)}`,
        details: {},
      })
    }
  }

  respond(): Promise<{ accepted: false; reason: 'not-pending' }> {
    return Promise.resolve({ accepted: false, reason: 'not-pending' })
  }

  subscribe(_stream: 'mux' | 'host', _emit: (frame: DownlinkFrame) => void): () => void {
    return () => undefined
  }

  async #list(payload: unknown): Promise<UnaryResult> {
    const parsed = sessionListRequestSchema.safeParse(payload)
    if (!parsed.success) return invalidPayload('session.list', parsed.error.issues)

    const windows: ListedWindow[] = [
      ...this.#sessions.windowsOf(this.#residentId).map(window => ({ window, archived: false })),
      ...this.#sessions.archivedWindowsOf(this.#residentId).map(window => ({ window, archived: true })),
    ]
    const items = await Promise.all(windows.map(async (listed) => {
      const ref = this.#historyRef(listed.window, listed.archived)
      const history = await this.#history.summarize(ref)
      return {
        sessionId: SessionId(listed.window.windowId),
        scopeId: listed.window.scopeId,
        generation: listed.window.generation,
        archived: listed.archived,
        updatedAt: history.updatedAt,
        running: listed.archived ? false : history.running,
        blank: history.blank,
      } satisfies SessionSummary
    }))
    items.sort((left, right) => {
      if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt
      return left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0
    })
    return success({ items })
  }

  #create(payload: unknown): UnaryResult {
    const parsed = sessionCreateRequestSchema.safeParse(payload)
    if (!parsed.success) return invalidPayload('session.create', parsed.error.issues)
    const unsupported: ZodIssue[] = []
    if (parsed.data.workspaceId !== undefined) {
      unsupported.push({
        code: 'custom',
        input: parsed.data.workspaceId,
        path: ['workspaceId'],
        message: 'Mist session.create does not support workspaceId',
      })
    }
    if (parsed.data.cwd !== undefined) {
      unsupported.push({
        code: 'custom',
        input: parsed.data.cwd,
        path: ['cwd'],
        message: 'Mist session.create does not support cwd',
      })
    }
    if (parsed.data.agentPreset !== undefined) {
      unsupported.push({
        code: 'custom',
        input: parsed.data.agentPreset,
        path: ['agentPreset'],
        message: 'Mist session.create does not support agentPreset',
      })
    }
    if (parsed.data.sessionId !== undefined) {
      unsupported.push({
        code: 'custom',
        input: parsed.data.sessionId,
        path: ['sessionId'],
        message: 'Mist window ids are host-generated and cannot be preallocated',
      })
    }
    if (unsupported.length > 0) return invalidPayload('session.create', unsupported)
    const window = this.#sessions.open(this.#residentId, {
      context: this.#createContext(),
      ...(parsed.data.scopeId === undefined ? {} : { scopeId: parsed.data.scopeId }),
    })
    return success({ sessionId: SessionId(window.windowId), generation: window.generation })
  }

  async #readHistory(payload: unknown): Promise<UnaryResult> {
    const parsed = sessionHistoryRequestSchema.safeParse(payload)
    if (!parsed.success) return invalidPayload('session.history', parsed.error.issues)
    const windowId = parsed.data.sessionId
    const active = this.#sessions.get(windowId)
    const archived = active === undefined ? this.#sessions.getArchived(windowId) : undefined
    const window = active ?? archived
    if (window === undefined || window.residentId !== this.#residentId) {
      return sessionMissing(parsed.data.sessionId)
    }
    const page = await this.#history.read(this.#historyRef(window, archived !== undefined), {
      ...(parsed.data.beforeSeq === undefined ? {} : { beforeSeq: parsed.data.beforeSeq }),
      ...(parsed.data.maxMessages === undefined ? {} : { maxMessages: parsed.data.maxMessages }),
    })
    return success({
      events: page.events,
      hasMore: page.hasMore,
      ...(page.projections === undefined ? {} : { projections: page.projections }),
    })
  }

  #historyRef(
    window: MistViewportSnapshot,
    archived: boolean,
  ): MistWindowHistoryRef {
    return {
      residentId: window.residentId,
      windowId: window.windowId,
      headId: window.headId,
      archived,
    }
  }
}
