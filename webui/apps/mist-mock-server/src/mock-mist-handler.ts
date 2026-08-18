import { randomUUID } from 'node:crypto'
import type {
  HostFrame,
  MuxFrame,
  QuestionResponsePayload,
  RpcError,
  RpcId,
  RpcReceipt,
  RequestPayload,
  SessionSummary,
  SettingsNamespaceView,
  SettingsPathOpView,
  WorkspaceId,
  WorkspaceView,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId as toRpcId } from '@deepseek-ai/dsh-host-apiproxy/api'
import { hostDescribeRequestSchema } from '@deepseek-ai/dsh-host-apiproxy/api/host.schema'
import {
  sessionCancelRequestSchema,
  sessionCreateRequestSchema,
  sessionHistoryRequestSchema,
  sessionListRequestSchema,
  sessionPromptRequestSchema,
} from '@deepseek-ai/dsh-host-apiproxy/api/sessions.schema'
import { questionResponsePayloadSchema } from '@deepseek-ai/dsh-host-apiproxy/api/questions.schema'
import {
  settingsDescribeRequestSchema,
  settingsMutateRequestSchema,
} from '@deepseek-ai/dsh-host-apiproxy/api/settings.schema'
import { workspaceListRequestSchema } from '@deepseek-ai/dsh-host-apiproxy/api/workspace.schema'
import { CallId, MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import {
  SessionId,
  type SessionEvent,
  type SessionEventMap,
  type SessionEventType,
} from '@deepseek-ai/dsh-session/types'
import type { DownlinkFrame, MistHandler, UnaryResult } from '../../dev-server/src/handler.ts'
import type { MockMistHandlerOptions, MockQuestionRequest, QueuedQuestion } from './types.ts'
import type { z as zCore } from 'zod'

type ZodIssue = zCore.core.$ZodIssue

const DEFAULT_EVENT_DELAY_MS = 8
const DEFAULT_SERVER_VERSION = '0.1.0-mock'
const DEFAULT_WORKSPACE_PATH = '/mist'
const WELCOME_SETTINGS_NAMESPACE = 'ui-onboarding'

const WELCOME_SETTINGS_SCHEMA = {
  uid: 2,
  refs: {
    1: { type: 'string' },
    2: { type: 'object', dict: { welcomeNoticeVersion: 1 } },
  },
}

interface ActiveTurn {
  rpcId: RpcId
  turn: number
  step: number
  failure: string | null
  cancelled: boolean
  settled: boolean
}

interface MockSession {
  sessionId: SessionId
  cwd: string
  updatedAt: number
  running: boolean
  blank: boolean
  nextSeq: number
  nextTurn: number
  events: SessionEvent[]
  active: ActiveTurn | null
}

interface PendingQuestion {
  rpcId: RpcId
  payload: Extract<MuxFrame, { type: 'question/requested' }>
}

/** Validate one answer batch against the exact pending question request. */
function matchesQuestions(payload: QuestionResponsePayload, pending: PendingQuestion): boolean {
  if (payload.sessionId !== pending.payload.sessionId) return false
  const answers = payload.answer.answers
  const questions = pending.payload.questions
  if (answers.length !== questions.length) return false
  return answers.every((answer, index) => {
    const question = questions[index]
    if (question === undefined || answer.id !== question.id) return false
    if (new Set(answer.selected).size !== answer.selected.length) return false
    const custom = answer.custom?.trim()
    if (custom !== undefined && custom === '') return false
    if (question.multiSelect !== true) {
      if (custom !== undefined && answer.selected.length > 0) return false
      if (answer.selected.length > 1) return false
    }
    const labels = new Set(question.options?.map(option => option.label) ?? [])
    return answer.selected.every(label => labels.has(label))
  })
}

interface MockSettingsNamespace {
  ns: string
  schema: unknown
  applies: 'live' | 'restart'
  user: Record<string, unknown> | undefined
  revision: number
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function success(value: unknown): UnaryResult {
  return { ok: true, value }
}

function failure(error: RpcError): UnaryResult {
  return { ok: false, error }
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

function invalidPayload(method: string, issues: ZodIssue[]): UnaryResult {
  return failure({
    code: 'bad-request',
    message: `invalid payload for ${method}`,
    details: { issues },
  })
}

function workspaceId(value: string): WorkspaceId {
  return value as WorkspaceId
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Apply one settings.mutate op without changing the stored input section. */
function applySettingsPathOp(
  section: Record<string, unknown>,
  op: SettingsPathOpView,
): Record<string, unknown> {
  const [head, ...rest] = op.path
  if (head === undefined) {
    if (op.op === 'unset') return {}
    if (!isPlainObject(op.value)) {
      throw new TypeError('settings mutate: setting the section root requires a plain object')
    }
    return structuredClone(op.value)
  }
  if (rest.length === 0) {
    if (op.op === 'set') return { ...section, [head]: structuredClone(op.value) }
    const { [head]: _removed, ...kept } = section
    return kept
  }
  const child = section[head]
  if (!isPlainObject(child)) {
    if (op.op === 'unset') return section
    return { ...section, [head]: applySettingsPathOp({}, { ...op, path: rest }) }
  }
  return { ...section, [head]: applySettingsPathOp(child, { ...op, path: rest }) }
}

/** Exact frozen MistHandler contract backed by deterministic in-memory Mist state. */
export class MockMistHandler implements MistHandler {
  readonly #eventDelayMs: number
  readonly #serverVersion: string
  readonly #workspace: WorkspaceView
  readonly #sessions = new Map<SessionId, MockSession>()
  readonly #settings = new Map<string, MockSettingsNamespace>()
  readonly #pendingQuestions = new Map<RpcId, PendingQuestion>()
  readonly #muxSubscribers = new Set<(frame: DownlinkFrame) => void>()
  readonly #hostSubscribers = new Set<(frame: DownlinkFrame) => void>()
  #nextTurnFailure: string | null = null
  #disposed = false

  constructor(options: MockMistHandlerOptions = {}) {
    this.#eventDelayMs = options.eventDelayMs ?? DEFAULT_EVENT_DELAY_MS
    if (!Number.isSafeInteger(this.#eventDelayMs) || this.#eventDelayMs < 0) {
      throw new RangeError('eventDelayMs must be a non-negative safe integer')
    }
    this.#serverVersion = options.serverVersion ?? DEFAULT_SERVER_VERSION
    const path = options.workspacePath ?? DEFAULT_WORKSPACE_PATH
    const now = new Date().toISOString()
    this.#workspace = {
      workspaceId: workspaceId('mist-v0'),
      path,
      title: 'Mist',
      sessionIds: [],
      createdAt: now,
      updatedAt: now,
    }
    this.#settings.set(WELCOME_SETTINGS_NAMESPACE, {
      ns: WELCOME_SETTINGS_NAMESPACE,
      schema: WELCOME_SETTINGS_SCHEMA,
      applies: 'live',
      user: undefined,
      revision: 0,
    })
  }

  unary(method: string, payload: unknown, rawRpcId: string): Promise<UnaryResult> {
    return Promise.resolve(this.#unary(method, payload, rawRpcId))
  }

  #unary(method: string, payload: unknown, rawRpcId: string): UnaryResult {
    const rpcId = toRpcId(rawRpcId)
    switch (method) {
      case 'host.describe': {
        const parsed = hostDescribeRequestSchema.safeParse(payload)
        if (!parsed.success) return invalidPayload(method, parsed.error.issues)
        return success({
          version: this.#serverVersion,
          cwd: this.#workspace.path,
          attachedSessions: this.#sessions.size,
          canOpenPath: false,
        })
      }
      case 'session.list': {
        const parsed = sessionListRequestSchema.safeParse(payload)
        if (!parsed.success) return invalidPayload(method, parsed.error.issues)
        return this.#sessionList(parsed.data as RequestPayload<'session.list'>)
      }
      case 'session.create': {
        const parsed = sessionCreateRequestSchema.safeParse(payload)
        if (!parsed.success) return invalidPayload(method, parsed.error.issues)
        return this.#sessionCreate(parsed.data as RequestPayload<'session.create'>)
      }
      case 'session.history': {
        const parsed = sessionHistoryRequestSchema.safeParse(payload)
        if (!parsed.success) return invalidPayload(method, parsed.error.issues)
        return this.#sessionHistory(parsed.data as RequestPayload<'session.history'>)
      }
      case 'session.prompt': {
        const parsed = sessionPromptRequestSchema.safeParse(payload)
        if (!parsed.success) return invalidPayload(method, parsed.error.issues)
        return this.#sessionPrompt(parsed.data, rpcId)
      }
      case 'session.cancel': {
        const parsed = sessionCancelRequestSchema.safeParse(payload)
        if (!parsed.success) return invalidPayload(method, parsed.error.issues)
        return this.#sessionCancel(parsed.data)
      }
      case 'settings.describe': {
        const parsed = settingsDescribeRequestSchema.safeParse(payload)
        if (!parsed.success) return invalidPayload(method, parsed.error.issues)
        return success({
          writable: true,
          hasDocument: false,
          namespaces: [...this.#settings.values()].map(namespace => this.#settingsView(namespace)),
        })
      }
      case 'settings.mutate': {
        const parsed = settingsMutateRequestSchema.safeParse(payload)
        if (!parsed.success) return invalidPayload(method, parsed.error.issues)
        return this.#settingsMutate(parsed.data as RequestPayload<'settings.mutate'>)
      }
      case 'workspace.list': {
        const parsed = workspaceListRequestSchema.safeParse(payload)
        if (!parsed.success) return invalidPayload(method, parsed.error.issues)
        return success({ items: [this.#workspaceView()], archivedSessionIds: [] })
      }
      default:
        return notImplemented(method)
    }
  }

  respond(rawRpcId: string, result: unknown): Promise<RpcReceipt> {
    return Promise.resolve(this.#respond(rawRpcId, result))
  }

  #respond(rawRpcId: string, result: unknown): RpcReceipt {
    const rpcId = toRpcId(rawRpcId)
    const pending = this.#pendingQuestions.get(rpcId)
    if (pending === undefined) return { accepted: false, reason: 'not-pending' }
    if (typeof result !== 'object' || result === null) {
      return { accepted: false, reason: 'bad-response' }
    }
    const response = result as { ok?: unknown; value?: unknown; error?: { code?: unknown } }
    if (response.ok === false) {
      if (response.error?.code !== 'cancelled') return { accepted: false, reason: 'bad-response' }
      this.#settleQuestion(pending, 'cancelled')
      return { accepted: true }
    }
    if (response.ok !== true) return { accepted: false, reason: 'bad-response' }
    const parsed = questionResponsePayloadSchema.safeParse(response.value)
    if (!parsed.success) return { accepted: false, reason: 'bad-response' }
    const payload: QuestionResponsePayload = {
      sessionId: parsed.data.sessionId,
      answer: {
        answers: parsed.data.answer.answers.map(answer => ({
          id: answer.id,
          selected: answer.selected,
          ...(answer.custom === undefined ? {} : { custom: answer.custom }),
        })),
      },
    }
    if (!matchesQuestions(payload, pending)) {
      return { accepted: false, reason: 'bad-response' }
    }
    this.#settleQuestion(pending, 'answered')
    return { accepted: true }
  }

  subscribe(stream: 'mux' | 'host', emit: (frame: DownlinkFrame) => void): () => void {
    if (this.#disposed) return () => undefined
    const subscribers = stream === 'mux' ? this.#muxSubscribers : this.#hostSubscribers
    subscribers.add(emit)
    if (stream === 'mux') {
      for (const session of this.#sessions.values()) {
        emit({
          stream: 'mux',
          payload: {
            type: 'session/subscribed',
            sessionId: session.sessionId,
            lastSeq: session.nextSeq - 1,
          } satisfies MuxFrame,
        })
      }
      for (const pending of this.#pendingQuestions.values()) {
        emit({ stream: 'mux', rpcId: pending.rpcId, payload: pending.payload })
      }
    }
    return () => { subscribers.delete(emit) }
  }

  /** Test hook for the P0 pending-interaction replay guarantee. */
  queueQuestion(request: MockQuestionRequest): QueuedQuestion {
    const sessionId = SessionId(String(request.sessionId))
    if (!this.#sessions.has(sessionId)) throw new Error(`session not found: ${sessionId}`)
    const rpcId = toRpcId(`question-${randomUUID()}`)
    const payload: Extract<MuxFrame, { type: 'question/requested' }> = {
      type: 'question/requested',
      sessionId,
      questions: [{
        id: `question-item-${randomUUID()}`,
        question: request.question,
        ...(request.header === undefined ? {} : { header: request.header }),
        ...(request.options === undefined ? {} : { options: request.options }),
      }],
    }
    this.#pendingQuestions.set(rpcId, { rpcId, payload })
    this.#emitMux(payload, rpcId)
    return { rpcId, sessionId }
  }

  /** Make the next accepted prompt settle through the canonical failed turn shape. */
  failNextTurn(message = 'scripted Mist mock failure'): void {
    this.#nextTurnFailure = message
  }

  /** Stop scripted turns and close every stream subscriber. */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    for (const session of this.#sessions.values()) {
      if (session.active !== null) session.active.cancelled = true
      session.active = null
      session.running = false
    }
    this.#muxSubscribers.clear()
    this.#hostSubscribers.clear()
  }

  #sessionList(_payload: RequestPayload<'session.list'>): UnaryResult {
    const items: SessionSummary[] = [...this.#sessions.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(session => ({
        sessionId: session.sessionId,
        updatedAt: session.updatedAt,
        running: session.running,
        blank: session.blank,
        cwd: session.cwd,
        projections: { asOfSeq: session.nextSeq - 1, values: {} },
      }))
    return success({ items })
  }

  #sessionCreate(payload: RequestPayload<'session.create'>): UnaryResult {
    const { workspaceId: requestedWorkspace, cwd, sessionId: requestedId } = payload
    if (requestedWorkspace !== undefined && requestedWorkspace !== this.#workspace.workspaceId) {
      return failure({
        code: 'workspace-not-found',
        message: `workspace not found: ${requestedWorkspace}`,
        details: { workspaceId: requestedWorkspace },
      })
    }
    const requestedCwd = cwd ?? this.#workspace.path
    const sessionId = requestedId ?? SessionId(`session-${randomUUID()}`)
    const existing = this.#sessions.get(sessionId)
    if (existing !== undefined) {
      if (existing.cwd !== requestedCwd) {
        return failure({
          code: 'session-conflict',
          message: `session ${sessionId} is already bound to another cwd`,
          details: { sessionId, requestedCwd, existingCwd: existing.cwd },
        })
      }
      return success({ sessionId })
    }

    const now = Date.now()
    const session: MockSession = {
      sessionId,
      cwd: requestedCwd,
      updatedAt: now,
      running: false,
      blank: true,
      nextSeq: 0,
      nextTurn: 1,
      events: [],
      active: null,
    }
    this.#sessions.set(sessionId, session)
    this.#workspace.sessionIds.push(sessionId)
    this.#touchWorkspace()
    this.#emitMux({ type: 'session/subscribed', sessionId, lastSeq: -1 })
    this.#emitHost({
      type: 'host/session-added',
      sessionId,
      blank: true,
      cwd: requestedCwd,
    })
    return success({ sessionId })
  }

  #sessionHistory(payload: RequestPayload<'session.history'>): UnaryResult {
    const session = this.#sessions.get(payload.sessionId)
    if (session === undefined) return sessionMissing(payload.sessionId)

    const beforeSeq = payload.beforeSeq ?? session.nextSeq
    const eligible = session.events.filter(event => event.seq < beforeSeq)
    const maxTurns = payload.maxMessages
    let start = 0
    if (maxTurns !== undefined) {
      let turns = 0
      for (let index = eligible.length - 1; index >= 0; index -= 1) {
        if (eligible[index]?.type !== 'turn/start') continue
        turns += 1
        if (turns === maxTurns) {
          start = index
          break
        }
      }
    }
    const events = eligible.slice(start).map(event => ({ event }))
    return success({
      events,
      hasMore: start > 0,
      ...(payload.beforeSeq === undefined
        ? { projections: { asOfSeq: session.nextSeq - 1, values: {} } }
        : {}),
    })
  }

  #sessionPrompt(payload: RequestPayload<'session.prompt'>, rpcId: RpcId): UnaryResult {
    const session = this.#sessions.get(payload.sessionId)
    if (session === undefined) return sessionMissing(payload.sessionId)
    if (payload.content.some(part => part.type !== 'text')) {
      return failure({
        code: 'attachment-error',
        message: 'Mist webui v0 mock accepts text prompts only',
        details: { reason: 'image intake belongs to the deferred attachment contract' },
      })
    }
    if (session.active !== null) {
      return failure({
        code: 'agent-busy',
        message: `session ${session.sessionId} already has an active turn`,
        details: { reason: 'active-turn' },
      })
    }

    const turn = session.nextTurn
    session.nextTurn += 1
    const active: ActiveTurn = {
      rpcId,
      turn,
      step: 1,
      failure: this.#nextTurnFailure,
      cancelled: false,
      settled: false,
    }
    this.#nextTurnFailure = null
    session.active = active
    session.running = true
    session.blank = false
    session.updatedAt = Date.now()

    this.#append(session, 'turn/start', { turn })
    this.#append(session, 'user/message', {
      id: MessageId(`message-${randomUUID()}`),
      role: 'user',
      content: payload.content as ContentBlock[],
      source: {
        kind: 'user',
        rpcId,
        ...(payload.clientTimeZone === undefined
          ? {}
          : { clientTimeZone: payload.clientTimeZone }),
      },
    }, { surfaceOp: 'append' })
    this.#append(session, 'step/start', { turn, step: active.step })
    this.#emitHost({ type: 'host/session-status', sessionId: session.sessionId, running: true })
    void this.#runScript(session, active)
    return success({ accepted: true })
  }

  #sessionCancel(payload: RequestPayload<'session.cancel'>): UnaryResult {
    const session = this.#sessions.get(payload.sessionId)
    if (session === undefined) return sessionMissing(payload.sessionId)
    const active = session.active
    if (active !== null && !active.settled) {
      active.cancelled = true
      this.#append(session, 'step/end', { turn: active.turn, step: active.step })
      this.#append(session, 'turn/end', {
        turn: active.turn,
        reason: { kind: 'aborted', reason: { kind: 'user' } },
      })
      this.#settle(session, active)
    }
    return success({ accepted: true })
  }

  #settingsMutate(payload: RequestPayload<'settings.mutate'>): UnaryResult {
    const namespace = this.#settings.get(payload.ns)
    if (namespace === undefined) {
      return failure({
        code: 'settings-not-exposed',
        message: `settings namespace "${payload.ns}" is not exposed to configuration clients`,
        details: { ns: payload.ns },
      })
    }
    if (payload.expectedRevision !== undefined && payload.expectedRevision !== namespace.revision) {
      return failure({
        code: 'settings-conflict',
        message: `settings namespace "${payload.ns}" changed since it was read`,
        details: {
          ns: payload.ns,
          expected: payload.expectedRevision,
          actual: namespace.revision,
        },
      })
    }

    const before = namespace.user ?? {}
    let next = structuredClone(before)
    try {
      for (const op of payload.ops) next = applySettingsPathOp(next, op)
    } catch (error: unknown) {
      return failure({
        code: 'settings-rejected',
        message: error instanceof Error ? error.message : String(error),
        details: { ns: payload.ns },
      })
    }
    if (JSON.stringify(next) !== JSON.stringify(before)) namespace.revision += 1
    namespace.user = next
    return success(this.#settingsView(namespace))
  }

  #settleQuestion(pending: PendingQuestion, outcome: 'answered' | 'cancelled'): void {
    this.#pendingQuestions.delete(pending.rpcId)
    this.#emitMux({
      type: 'question/resolved',
      sessionId: pending.payload.sessionId,
      questionRpcId: pending.rpcId,
      outcome,
    })
  }

  async #runScript(session: MockSession, active: ActiveTurn): Promise<void> {
    const callId = CallId(`call-${randomUUID()}`)
    const reasoning = 'Checking the Mist contract.'
    const answer = 'Mock Mist turn completed.'
    const firstStepChunks: Array<SessionEvent> = [
      this.#event(session, 'assistant/chunk', {
        turn: active.turn,
        step: active.step,
        chunk: { type: 'block-start', index: 0, blockType: 'reasoning' },
      }),
      this.#event(session, 'assistant/chunk', {
        turn: active.turn,
        step: active.step,
        chunk: { type: 'reasoning-delta', index: 0, text: reasoning },
      }),
      this.#event(session, 'assistant/chunk', {
        turn: active.turn,
        step: active.step,
        chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } },
      }),
      this.#event(session, 'assistant/chunk', {
        turn: active.turn,
        step: active.step,
        chunk: { type: 'block-start', index: 1, blockType: 'tool-call' },
      }),
      this.#event(session, 'assistant/chunk', {
        turn: active.turn,
        step: active.step,
        chunk: {
          type: 'tool-call-delta',
          index: 1,
          id: callId,
          name: 'mist_contract_probe',
          argumentsDelta: '{"phase":"p0"}',
        },
      }),
      this.#event(session, 'assistant/chunk', {
        turn: active.turn,
        step: active.step,
        chunk: {
          type: 'block-end',
          index: 1,
          block: {
            type: 'tool-call',
            id: callId,
            name: 'mist_contract_probe',
            arguments: '{"phase":"p0"}',
          },
        },
      }),
      this.#event(session, 'assistant/chunk', {
        turn: active.turn,
        step: active.step,
        chunk: { type: 'finish', reason: { kind: 'tool-calls' } },
      }),
    ]
    for (const event of firstStepChunks) {
      if (!(await this.#waitForTurn(session, active))) return
      this.#commitEvent(session, event)
    }
    if (!this.#isActive(session, active)) return

    const firstMessage = this.#append(session, 'assistant/message', {
      turn: active.turn,
      step: active.step,
      message: {
        id: MessageId(`message-${randomUUID()}`),
        role: 'assistant',
        content: [
          { type: 'reasoning', text: reasoning },
          {
            type: 'tool-call',
            id: callId,
            name: 'mist_contract_probe',
            arguments: '{"phase":"p0"}',
          },
        ],
        source: { kind: 'model', provider: 'mist', model: 'mock' },
      },
    }, { surfaceOp: 'append' })
    this.#append(session, 'tool/call', {
      turn: active.turn,
      step: active.step,
      callId,
      name: 'mist_contract_probe',
      arguments: '{"phase":"p0"}',
    })
    this.#append(session, 'tool/result', {
      turn: active.turn,
      step: active.step,
      message: {
        id: MessageId(`message-${randomUUID()}`),
        role: 'user',
        content: [{
          type: 'tool-result',
          toolCallId: callId,
          content: [{ type: 'text', text: 'contract-ok' }],
        }],
        source: { kind: 'tool', callId },
      },
    }, { surfaceOp: 'append', sourceEventSeqs: [firstMessage.seq] })
    this.#append(session, 'step/end', { turn: active.turn, step: active.step })

    if (active.failure !== null) {
      this.#append(session, 'turn/end', {
        turn: active.turn,
        reason: { kind: 'error', error: { code: 'MOCK_FAILURE', message: active.failure } },
      })
      this.#settle(session, active)
      return
    }

    active.step += 1
    this.#append(session, 'step/start', { turn: active.turn, step: active.step })
    const finalChunks: Array<SessionEvent> = [
      this.#event(session, 'assistant/chunk', {
        turn: active.turn,
        step: active.step,
        chunk: { type: 'block-start', index: 0, blockType: 'text' },
      }),
      this.#event(session, 'assistant/chunk', {
        turn: active.turn,
        step: active.step,
        chunk: { type: 'text-delta', index: 0, text: answer },
      }),
      this.#event(session, 'assistant/chunk', {
        turn: active.turn,
        step: active.step,
        chunk: { type: 'block-end', index: 0, block: { type: 'text', text: answer } },
      }),
      this.#event(session, 'assistant/chunk', {
        turn: active.turn,
        step: active.step,
        chunk: { type: 'finish', reason: { kind: 'stop' } },
      }),
    ]
    const sourceEventSeqs: number[] = []
    for (const event of finalChunks) {
      if (!(await this.#waitForTurn(session, active))) return
      sourceEventSeqs.push(this.#commitEvent(session, event).seq)
    }
    if (!this.#isActive(session, active)) return

    this.#append(session, 'assistant/message', {
      turn: active.turn,
      step: active.step,
      message: {
        id: MessageId(`message-${randomUUID()}`),
        role: 'assistant',
        content: [{ type: 'text', text: answer }],
        source: { kind: 'model', provider: 'mist', model: 'mock' },
      },
    }, { surfaceOp: 'append', sourceEventSeqs })
    this.#append(session, 'step/end', { turn: active.turn, step: active.step })
    this.#append(session, 'turn/end', { turn: active.turn, reason: { kind: 'completed' } })
    this.#settle(session, active)
  }

  async #waitForTurn(session: MockSession, active: ActiveTurn): Promise<boolean> {
    await sleep(this.#eventDelayMs)
    return this.#isActive(session, active)
  }

  #isActive(session: MockSession, active: ActiveTurn): boolean {
    return !this.#disposed && session.active === active && !active.cancelled && !active.settled
  }

  #settle(session: MockSession, active: ActiveTurn): void {
    if (active.settled) return
    active.settled = true
    session.active = null
    session.running = false
    session.updatedAt = Date.now()
    this.#emitHost({ type: 'host/session-status', sessionId: session.sessionId, running: false })
  }

  #event<T extends SessionEventType>(
    session: MockSession,
    type: T,
    data: SessionEventMap[T],
    surface?: { surfaceOp: 'append'; sourceEventSeqs?: number[] },
  ): SessionEvent<T> {
    return {
      type,
      seq: session.nextSeq,
      time: Date.now(),
      data,
      ...surface,
    } as SessionEvent<T>
  }

  #append<T extends SessionEventType>(
    session: MockSession,
    type: T,
    data: SessionEventMap[T],
    surface?: { surfaceOp: 'append'; sourceEventSeqs?: number[] },
  ): SessionEvent<T> {
    return this.#commitEvent(session, this.#event(session, type, data, surface)) as SessionEvent<T>
  }

  #commitEvent(session: MockSession, event: SessionEvent): SessionEvent {
    if (event.seq !== session.nextSeq) {
      event = { ...event, seq: session.nextSeq }
    }
    session.nextSeq += 1
    session.updatedAt = event.time
    session.events.push(event)
    this.#emitMux({ type: 'session/event', sessionId: session.sessionId, event })
    return event
  }

  #emitMux(payload: MuxFrame, rpcId?: RpcId): void {
    const frame: DownlinkFrame = {
      stream: 'mux',
      payload,
      ...(rpcId === undefined ? {} : { rpcId }),
    }
    for (const subscriber of this.#muxSubscribers) subscriber(frame)
  }

  #emitHost(payload: HostFrame): void {
    const frame: DownlinkFrame = { stream: 'host', payload }
    for (const subscriber of this.#hostSubscribers) subscriber(frame)
  }

  #workspaceView(): WorkspaceView {
    return {
      ...this.#workspace,
      sessionIds: [...this.#workspace.sessionIds],
    }
  }

  #settingsView(namespace: MockSettingsNamespace): SettingsNamespaceView {
    const value = structuredClone(namespace.user ?? {})
    return {
      ns: namespace.ns,
      schema: structuredClone(namespace.schema),
      value,
      ...(namespace.user === undefined ? {} : { user: structuredClone(namespace.user) }),
      applies: namespace.applies,
      secrets: [],
      revision: namespace.revision,
    }
  }

  #touchWorkspace(): void {
    this.#workspace.updatedAt = new Date().toISOString()
  }
}

export function createMockMistHandler(options?: MockMistHandlerOptions): MockMistHandler {
  return new MockMistHandler(options)
}
